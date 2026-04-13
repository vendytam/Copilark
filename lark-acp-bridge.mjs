/**
 * lark-acp-bridge.mjs
 *
 * 飞书消息 → Copilot ACP 转发桥接器
 *
 * 工作流程：
 *   1. 连接本地 Copilot ACP Server（TCP localhost:3000）
 *   2. 初始化 ACP 会话
 *   3. 订阅飞书 IM 消息事件（im.message.receive_v1）
 *   4. 将原始事件 JSON 转发给 Copilot ACP
 *   5. Copilot（大波龙 Agent）自行用 lark-im skill 回复飞书
 *
 * 启动前请确保 Copilot ACP Server 已运行：
 *   ./start-copilot-acp.sh
 */

import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = {
  acpHost: "127.0.0.1",
  acpPort:  Number(process.env.ACP_PORT  || 3000),
  maxRetries: 3,
  cwd: process.env.BRIDGE_CWD || process.cwd(),
  bridgeHttpPort: Number(process.env.BRIDGE_HTTP_PORT || 3001),
  defaultChatId: process.env.LARK_CHAT_ID || "",
  // SysBuilder 后端集成（报告分析功能）
  backendUrl:      process.env.SYSBUILDER_BACKEND_URL || "http://47.79.4.19",
  backendToken:    process.env.SYSBUILDER_TOKEN       || "",
  pollIntervalMs:  Number(process.env.POLL_INTERVAL_MS || 20000),
};

const SESSION_FILE    = join(import.meta.dirname, ".acp-session-id");
const BRIDGE_AUTH_FILE = join(homedir(), ".copilark", "bridge-auth.txt");
const LAST_CHAT_ID_FILE = join(homedir(), ".copilark", "last-chat-id.txt");
const CHAT_ROUTE_FILE = join(homedir(), ".copilark", "chat-routing.json");
const COPILOT_MCP_CONFIG_FILE = join(homedir(), ".copilot", "mcp-config.json");

function readEnvPath(name) {
  const value = typeof process.env[name] === "string" ? process.env[name].trim() : "";
  return value && existsSync(value) ? value : null;
}

function findFirstExisting(paths) {
  return paths.find((filePath) => filePath && existsSync(filePath)) || null;
}

function findCommandPath(command) {
  const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function readGlobalNpmRoots() {
  const roots = [];
  for (const args of [["root", "-g"], ["prefix", "-g"]]) {
    const result = spawnSync("npm", args, { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) continue;
    const value = (result.stdout || "").trim();
    if (!value) continue;
    roots.push(
      args[0] === "prefix"
        ? join(value, "node_modules")
        : value
    );
  }
  return [...new Set(roots)];
}

function parseCliShimJsPath(shimPath) {
  if (!/\.(cmd|bat)$/i.test(shimPath)) return null;
  try {
    const raw = readFileSync(shimPath, "utf8");
    const normalized = raw.replace(/\r/g, "");
    const quotedMatch = normalized.match(/"([^"\r\n]*lark-cli\.js)"/i);
    const looseMatch = quotedMatch || normalized.match(/([^\s"\r\n]*lark-cli\.js)/i);
    if (!looseMatch?.[1]) return null;
    let candidate = looseMatch[1].replace(/%~dp0/gi, "").replace(/\//g, "\\");
    if (!/^[A-Za-z]:\\/.test(candidate) && !candidate.startsWith("\\\\")) {
      candidate = join(dirname(shimPath), candidate);
    }
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function findDescendantFile(startDir, segments, maxDepth = 5) {
  if (!startDir || !existsSync(startDir) || maxDepth < 0) return null;
  const expectedLeaf = segments[segments.length - 1]?.toLowerCase();
  try {
    const entries = readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(startDir, entry.name);
      if (entry.isDirectory()) {
        const nested = findDescendantFile(entryPath, segments, maxDepth - 1);
        if (nested) return nested;
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== expectedLeaf) continue;
      const normalized = entryPath.toLowerCase().replace(/\//g, "\\");
      const expectedSuffix = segments.join("\\").toLowerCase();
      if (normalized.endsWith(expectedSuffix)) return entryPath;
    }
  } catch {
    return null;
  }
  return null;
}

function resolvePortableNodePath(candidates) {
  const directCandidates = [findCommandPath("node")];
  for (const line of candidates) {
    const lineDir = dirname(line);
    directCandidates.push(
      join(lineDir, "node.exe"),
      join(lineDir, "..", "node.exe")
    );
  }
  return findFirstExisting([...new Set(directCandidates)]);
}

function resolveLarkCliExePath(candidates) {
  const directCandidates = [];
  for (const line of candidates) {
    if (/lark-cli\.exe$/i.test(line)) {
      directCandidates.push(line);
      continue;
    }
    if (/\.(cmd|bat)$/i.test(line) || /lark-cli$/i.test(line)) {
      const lineDir = dirname(line);
      directCandidates.push(
        join(lineDir, "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
        join(lineDir, "lib", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
        join(lineDir, "..", "lib", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe")
      );
      const recursiveExePath = findDescendantFile(lineDir, ["@larksuite", "cli", "bin", "lark-cli.exe"], 6);
      if (recursiveExePath) directCandidates.push(recursiveExePath);
    }
  }

  for (const npmRoot of readGlobalNpmRoots()) {
    directCandidates.push(join(npmRoot, "@larksuite", "cli", "bin", "lark-cli.exe"));
  }

  directCandidates.push(
    join(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe")
  );

  return findFirstExisting([...new Set(directCandidates)]);
}

function resolveLarkCliJsPath(candidates) {
  const directCandidates = [];
  for (const line of candidates) {
    if (/lark-cli\.js$/i.test(line)) {
      directCandidates.push(line);
      continue;
    }
    if (/\.(cmd|bat)$/i.test(line) || /lark-cli$/i.test(line)) {
      const lineDir = dirname(line);
      directCandidates.push(
        join(lineDir, "node_modules", "@larksuite", "cli", "bin", "lark-cli.js"),
        join(lineDir, "lib", "node_modules", "@larksuite", "cli", "bin", "lark-cli.js"),
        join(lineDir, "..", "lib", "node_modules", "@larksuite", "cli", "bin", "lark-cli.js")
      );
      const shimJsPath = parseCliShimJsPath(line);
      if (shimJsPath) directCandidates.push(shimJsPath);
      const recursiveJsPath = findDescendantFile(lineDir, ["@larksuite", "cli", "bin", "lark-cli.js"], 6);
      if (recursiveJsPath) directCandidates.push(recursiveJsPath);
    }
  }

  for (const npmRoot of readGlobalNpmRoots()) {
    directCandidates.push(join(npmRoot, "@larksuite", "cli", "bin", "lark-cli.js"));
  }

  directCandidates.push(
    join(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.js")
  );

  return findFirstExisting([...new Set(directCandidates)]);
}

function resolveCommandSpec(command) {
  if (command === "lark-cli" && process.platform === "win32") {
    const forcedCliPath = readEnvPath("LARK_CLI_PATH");
    const forcedCliJsPath = readEnvPath("LARK_CLI_JS_PATH");
    const forcedNodePath = readEnvPath("LARK_NODE_PATH") || findCommandPath("node");
    if (forcedCliJsPath && forcedNodePath) {
      return {
        path: forcedNodePath,
        argsPrefix: [forcedCliJsPath],
        useShell: false,
        resolutionSource: "forced-js",
      };
    }
    if (forcedCliPath) {
      return {
        path: forcedCliPath,
        argsPrefix: [],
        useShell: /\.(cmd|bat)$/i.test(forcedCliPath),
        resolutionSource: "forced-cli",
      };
    }
  }

  const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`无法定位命令：${command}`);
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const extraCandidates = command === "lark-cli" && process.platform === "win32"
    ? [
        join(process.env.APPDATA || "", "npm", "lark-cli.cmd"),
        join(process.env.APPDATA || "", "npm", "lark-cli"),
        join(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.js"),
        join(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
      ]
    : [];
  const candidates = [...matches, ...extraCandidates].filter((line) => line && existsSync(line));
  if (command === "lark-cli" && process.platform === "win32") {
    const cliExePath = resolveLarkCliExePath(candidates);
    const nodePath = resolvePortableNodePath(candidates);
    const cliJsPath = resolveLarkCliJsPath(candidates);
    const diagnostics = {
      matches: matches.slice(0, 8),
      candidateCount: candidates.length,
      cliExePath,
      cliJsPath,
      nodePath,
    };
    if (cliExePath) {
      return {
        path: cliExePath,
        argsPrefix: [],
        useShell: false,
        resolutionSource: "auto-exe",
        diagnostics,
      };
    }
    if (nodePath && cliJsPath) {
      return {
        path: nodePath,
        argsPrefix: [cliJsPath],
        useShell: false,
        resolutionSource: "auto-js",
        diagnostics,
      };
    }
    const fallbackResolved = candidates.find((line) => line.toLowerCase().endsWith(".exe"))
      ?? candidates.find((line) => /\.(cmd|bat)$/i.test(line))
      ?? candidates.find((line) => !/\.(cmd|bat)$/i.test(line))
      ?? candidates[0];
    if (!fallbackResolved) throw new Error(`无法定位命令：${command}`);
    return {
      path: fallbackResolved,
      argsPrefix: [],
      useShell: /\.(cmd|bat)$/i.test(fallbackResolved),
      resolutionSource: "fallback",
      diagnostics: {
        ...diagnostics,
        fallbackResolved,
      },
    };
  }
  const resolved = candidates.find((line) => line.toLowerCase().endsWith(".exe"))
    ?? candidates.find((line) => /\.(cmd|bat)$/i.test(line))
    ?? candidates.find((line) => !/\.(cmd|bat)$/i.test(line))
    ?? candidates[0];
  if (!resolved) throw new Error(`无法定位命令：${command}`);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const nodePath = resolvePortableNodePath([resolved]);
    const cliJsPath = resolveLarkCliJsPath([resolved]);
    if (nodePath && cliJsPath) {
      return {
        path: nodePath,
        argsPrefix: [cliJsPath],
        useShell: false,
        resolutionSource: "shim-js",
      };
    }
  }
  return {
    path: resolved,
    argsPrefix: [],
    useShell: /\.(cmd|bat)$/i.test(resolved),
    resolutionSource: "resolved",
  };
}

const LARK_CLI = process.platform === "win32"
  ? resolveCommandSpec("lark-cli")
  : { path: "lark-cli", useShell: false };
let _loggedLarkCliSpec = false;

function withLarkCliIdentity(args) {
  const normalizedArgs = args.map((arg) => String(arg));
  if (normalizedArgs.includes("--as")) return normalizedArgs;
  return ["--as", "bot", ...normalizedArgs];
}

function execLarkCli(args) {
  const normalizedArgs = [...(LARK_CLI.argsPrefix || []), ...withLarkCliIdentity(args)];
  if (!_loggedLarkCliSpec) {
    _loggedLarkCliSpec = true;
    log.info(`Lark CLI 执行入口：path=${LARK_CLI.path} argsPrefix=${JSON.stringify(LARK_CLI.argsPrefix || [])} shell=${Boolean(LARK_CLI.useShell)} source=${LARK_CLI.resolutionSource || "unknown"}`);
    if (LARK_CLI.diagnostics) {
      log.info(`Lark CLI 解析诊断：${JSON.stringify(LARK_CLI.diagnostics)}`);
    }
  }
  if (LARK_CLI.useShell) {
    const result = spawnSync(LARK_CLI.path, normalizedArgs, {
      encoding: "utf8",
      windowsHide: true,
      shell: true,
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "").toString().trim() || `lark-cli 执行失败，退出码=${result.status}`);
    }
    return (result.stdout || "").toString();
  }
  return execFileSync(LARK_CLI.path, normalizedArgs, {
    encoding: "utf8",
    windowsHide: true,
  });
}

function normalizeControlCommand(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\u3000/g, " ")
    .replace(/[！]/g, "!")
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseControlCommand(text) {
  const normalized = normalizeControlCommand(text);
  if (/(^|\s)!status(?::.*)?$/.test(normalized)) return "!status";
  if (/(^|\s)!stop(?::.*)?$/.test(normalized)) return "!stop";
  return null;
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [key, entry]) => {
    if (typeof entry === "string" && key.trim()) acc[key.trim()] = entry;
    return acc;
  }, {});
}

function normalizeHttpHeaders(value) {
  if (Array.isArray(value)) {
    return value.reduce((acc, item) => {
      if (item && typeof item === "object" && typeof item.name === "string" && typeof item.value === "string" && item.name.trim()) {
        acc[item.name.trim()] = item.value;
      }
      return acc;
    }, {});
  }
  if (!value || typeof value !== "object") return {};
  return Object.entries(value).reduce((acc, [key, entry]) => {
    if (typeof entry === "string" && key.trim()) acc[key.trim()] = entry;
    return acc;
  }, {});
}

function parseJsonObject(raw, fallback = {}) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseRemoteMcpFromEnv() {
  const url = typeof process.env.SYSBUILDER_MCP_URL === "string" ? process.env.SYSBUILDER_MCP_URL.trim() : "";
  if (!url) return null;
  const rawTransport = typeof process.env.SYSBUILDER_MCP_TRANSPORT === "string"
    ? process.env.SYSBUILDER_MCP_TRANSPORT.trim().toLowerCase()
    : "http";
  const transport = rawTransport === "sse" ? "sse" : "http";
  const headers = normalizeHttpHeaders(readJsonFile(process.env.SYSBUILDER_MCP_HEADERS_FILE || "", {}));
  const inlineHeaders = normalizeHttpHeaders(parseJsonObject(process.env.SYSBUILDER_MCP_HEADERS_JSON, {}));
  return {
    type: transport,
    name: "sysbuilder",
    url,
    headers: { ...headers, ...inlineHeaders },
  };
}

function parseStdioMcpFromEnv() {
  const command = typeof process.env.SYSBUILDER_MCP_COMMAND === "string" ? process.env.SYSBUILDER_MCP_COMMAND.trim() : "";
  if (!command) return null;
  const args = normalizeStringArray(parseJsonObject(process.env.SYSBUILDER_MCP_ARGS_JSON || "[]", []));
  const env = normalizeStringRecord(parseJsonObject(process.env.SYSBUILDER_MCP_ENV_JSON || "{}"));
  if (!env.SYSBUILDER_URL) env.SYSBUILDER_URL = CONFIG.backendUrl;
  if (!env.SYSBUILDER_TOKEN && CONFIG.backendToken) env.SYSBUILDER_TOKEN = CONFIG.backendToken;
  return {
    type: "stdio",
    name: "sysbuilder",
    command,
    args,
    env,
  };
}

function loadConfiguredSysbuilderMcpServer() {
  const fromEnv = parseRemoteMcpFromEnv();
  if (fromEnv) return fromEnv;
  const stdioFromEnv = parseStdioMcpFromEnv();
  if (stdioFromEnv) return stdioFromEnv;

  const parsed = readJsonFile(COPILOT_MCP_CONFIG_FILE, {});
  const rawServers = parsed?.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers
    : parsed;
  const entry = rawServers?.sysbuilder;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "sysbuilder";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  const transport = typeof entry.type === "string" && entry.type.trim().toLowerCase() === "sse" ? "sse" : "http";
  if (url) {
    return {
      type: transport,
      name,
      url,
      headers: normalizeHttpHeaders(entry.headers),
    };
  }

  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!command) return null;
  const env = normalizeStringRecord(entry.env);
  if (!env.SYSBUILDER_URL) env.SYSBUILDER_URL = CONFIG.backendUrl;
  if (!env.SYSBUILDER_TOKEN && CONFIG.backendToken) env.SYSBUILDER_TOKEN = CONFIG.backendToken;
  return {
    type: "stdio",
    name,
    command,
    args: normalizeStringArray(entry.args),
    env,
  };
}

function requireConfiguredSysbuilderMcpServer() {
  const server = loadConfiguredSysbuilderMcpServer();
  if (!server) {
    throw new Error("未配置可用的 sysbuilder MCP。请先在全局 MCP 配置中配置 sysbuilder（stdio 或 HTTP/SSE），再启动 Story Map 同步。");
  }
  return server;
}

function buildAcpMcpServer(server) {
  if (server.type === "http" || server.type === "sse") {
    return {
      type: server.type,
      name: server.name,
      url: server.url,
      headers: Object.entries(server.headers || {}).map(([name, value]) => ({ name, value })),
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  };
}

function getDefaultBridgeMcpServers() {
  try {
    const configured = loadConfiguredSysbuilderMcpServer();
    if (!configured) return [];
    return [buildAcpMcpServer(configured)];
  } catch {
    return [];
  }
}

// ─── ACP Client ───────────────────────────────────────────────────────────────

let _streaming = false; // 是否正在流式输出 Copilot 回复

// ─── 日志环形缓冲 & 控制指令 ──────────────────────────────────────────────────

const _logBuffer = [];       // 最近 N 行日志
const LOG_BUFFER_SIZE = 20;
let _ignoredAcpAbortLogged = false;

function isExpectedAcpAbortError(error) {
  if (!error) return false;
  const queue = [error];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const code = typeof current.code === "string" ? current.code : "";
    const message = typeof current.message === "string" ? current.message : "";
    if (code === "ABORT_ERR" || code === "ERR_STREAM_PREMATURE_CLOSE") return true;
    if (/AbortError|Premature close/i.test(message)) return true;
    if (current.cause && typeof current.cause === "object") queue.push(current.cause);
  }
  return false;
}

function bufferLog(line) {
  _logBuffer.push(line);
  if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
}

function stringifyLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLogLine(level, args) {
  const text = args.map(stringifyLogArg).join(" ").replace(/^\[Bridge\]\s*/i, "");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  return `[${time}][Bridge][${level}] ${text}`;
}

// 在打印 log 前确保换行（避免与流式输出混排）
const log = {
  info:  (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = formatLogLine("INFO", a); bufferLog(l); console.log(l); },
  warn:  (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = formatLogLine("WARN", a); bufferLog(l); console.warn(l); },
  error: (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = formatLogLine("ERROR", a); bufferLog(l); console.error(l); },
  event: (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = formatLogLine("EVENT", a); bufferLog(l); console.log(l); },
};

const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  if (args[0] === "ACP write error:" && isExpectedAcpAbortError(args[1])) {
    if (!_ignoredAcpAbortLogged) {
      _ignoredAcpAbortLogged = true;
      log.warn("ACP 写流在连接关闭后中止，已忽略预期的 AbortError");
    }
    return;
  }
  originalConsoleError(...args);
};

// ─── lastChatId（报告完成通知目标群）─────────────────────────────────────────

let lastChatId = CONFIG.defaultChatId || null; // 每次收到飞书事件时更新，用于主动推送 Lark 通知
let lastChatIdSource = CONFIG.defaultChatId ? "env" : null;
let chatRouteMap = readJsonFile(CHAT_ROUTE_FILE, {});
const analysisJobs = new Map();
const waitingTickets = new Map();
let questionSeq = 0;
let bridgeHttpServer = null;

try {
  if (!lastChatId && existsSync(LAST_CHAT_ID_FILE)) {
    const savedChatId = readFileSync(LAST_CHAT_ID_FILE, "utf8").trim();
    if (savedChatId) {
      lastChatId = savedChatId;
      lastChatIdSource = "persisted";
    }
  }
} catch {}

function persistLastChatId(chatId) {
  if (!chatId) return;
  try {
    writeFileSync(LAST_CHAT_ID_FILE, chatId, "utf8");
  } catch (err) {
    log.warn(`persistLastChatId 失败：${err?.message || String(err)}`);
  }
}

function buildChatRouteKey(userId, projectId) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId) return null;
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  return `${normalizedUserId}::${normalizedProjectId || "__global__"}`;
}

function normalizeChatRouteMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [key, entry]) => {
    if (typeof entry === "string" && key.trim() && entry.trim()) acc[key.trim()] = entry.trim();
    return acc;
  }, {});
}

function persistChatRoute(routeKey, chatId) {
  if (!routeKey || !chatId) return;
  chatRouteMap = {
    ...normalizeChatRouteMap(chatRouteMap),
    [routeKey]: chatId,
  };
  try {
    writeFileSync(CHAT_ROUTE_FILE, JSON.stringify(chatRouteMap, null, 2), "utf8");
  } catch (err) {
    log.warn(`persistChatRoute 失败：${err?.message || String(err)}`);
  }
}

function resolveTaskChat(routeKey) {
  const currentChatId = getCurrentTaskChatId();
  if (currentChatId) {
    if (routeKey) persistChatRoute(routeKey, currentChatId);
    return currentChatId;
  }

  const normalizedMap = normalizeChatRouteMap(chatRouteMap);
  if (routeKey && normalizedMap[routeKey]) {
    return normalizedMap[routeKey];
  }

  if (routeKey && routeKey.includes("::")) {
    const globalRouteKey = routeKey.replace(/::.*$/, "::__global__");
    if (normalizedMap[globalRouteKey]) {
      return normalizedMap[globalRouteKey];
    }
  }

  const persistedChatId = getCurrentTaskChatId({ allowPersisted: true });
  if (routeKey && persistedChatId) {
    persistChatRoute(routeKey, persistedChatId);
    log.info(`使用已持久化 chat_id 作为任务通知路由：${routeKey} -> ${persistedChatId}`);
    return persistedChatId;
  }

  return null;
}

// ─── 后端 HTTP 工具 ───────────────────────────────────────────────────────────

function backendRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const full = new URL(CONFIG.backendUrl + urlPath);
    const mod  = full.protocol === "https:" ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;

    // 桌面端优先使用当前 Electron 会话 cookie，避免被旧的 SYSBUILDER_TOKEN 绑定到错误账号。
    let authHeader = {};
    try {
      if (existsSync(BRIDGE_AUTH_FILE)) {
        const cookie = readFileSync(BRIDGE_AUTH_FILE, "utf8").trim();
        if (cookie) authHeader = { Cookie: cookie };
      }
    } catch {}
    if (!("Cookie" in authHeader) && CONFIG.backendToken) {
      authHeader = { Authorization: `Bearer ${CONFIG.backendToken}` };
    }

    const headers = {
      "Content-Type": "application/json",
      ...authHeader,
      ...(data ? { "Content-Length": data.length } : {}),
    };
    const req = mod.request(
      { hostname: full.hostname, port: full.port || (full.protocol === "https:" ? 443 : 80),
        path: full.pathname + full.search, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── 飞书群主动通知 ───────────────────────────────────────────────────────────

function getCurrentTaskChatId(options = {}) {
  const allowPersisted = options.allowPersisted === true;
  if (!lastChatId) return null;
  if (!allowPersisted && lastChatIdSource === "persisted") return null;
  return lastChatId;
}

function splitLarkText(text, maxChars = 8000) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [""];
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt <= 0) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function notifyLark(text, chatId = lastChatId) {
  if (!chatId) { log.warn("notifyLark: 尚无 chat_id，跳过通知"); return; }
  const plainText = String(text || "").replace(/\r\n/g, "\n").trim();
  try {
    log.info(`notifyLark 调用：chatId=${chatId} textLength=${plainText.length} preview=${JSON.stringify(plainText.slice(0, 40))}`);
    const chunks = splitLarkText(plainText || String(text || ""));
    chunks.forEach((chunk, index) => {
      const chunkText = chunks.length > 1 ? `（第 ${index + 1}/${chunks.length} 段）\n${chunk}` : chunk;
      execLarkCli(["im", "+messages-send", "--chat-id", chatId, "--text", chunkText]);
    });
    log.info(`Lark 通知已发送到 ${chatId}：${text.slice(0, 80)}`);
  } catch (e) {
    log.error(`Lark 通知失败：${e.message}`);
  }
}

// ─── ACP 连接 & 会话 ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let acpSessionId = null;

async function connectToACP() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: CONFIG.acpHost, port: CONFIG.acpPort }, async () => {
      log.info(`已连接到 ACP Server ${CONFIG.acpHost}:${CONFIG.acpPort}`);
      const stream = acp.ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket));
      const client = new BridgeAcpClient();
      const connection = new acp.ClientSideConnection((_agent) => client, stream);
      try {
        const init = await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        log.info(`ACP 握手成功，协议版本：${init.protocolVersion}`);
        resolve({ connection, client, socket });
      } catch (err) { reject(err); }
    });
    socket.on("error", reject);
  });
}

function destroyJobTransport(job) {
  const socket = job?.socket;
  if (!socket || socket.destroyed || job?._transportClosing) return;
  if (job && typeof job === "object") job._transportClosing = true;
  try { socket.end(); } catch {}
  setTimeout(() => {
    if (!socket.destroyed) {
      try { socket.destroy(); } catch {}
    }
  }, 250).unref?.();
}

async function ensureSession(connection) {
  const defaultMcpServers = getDefaultBridgeMcpServers();
  if (acpSessionId) {
    log.info(`恢复已有 ACP 会话：${acpSessionId}`);
    return acpSessionId;
  }

  // 尝试从文件恢复上次的 session ID
  if (existsSync(SESSION_FILE)) {
      const savedId = readFileSync(SESSION_FILE, "utf8").trim();
      if (savedId) {
        try {
          await connection.loadSession({ sessionId: savedId, cwd: CONFIG.cwd, mcpServers: defaultMcpServers });
          acpSessionId = savedId;
          log.info(`✅ 已恢复上次会话：${acpSessionId}`);
          return acpSessionId;
      } catch (err) {
        log.warn(`上次会话 ${savedId} 无法恢复（${err?.message}），将重连后创建新会话...`);
        writeFileSync(SESSION_FILE, "", "utf8"); // 先清空，重连后直接走 newSession
        throw Object.assign(new Error("SESSION_STALE"), { stale: true });
      }
    }
  }

  // 创建新会话并持久化
  const result = await connection.newSession({ cwd: CONFIG.cwd, mcpServers: defaultMcpServers });
  acpSessionId = result.sessionId;
  writeFileSync(SESSION_FILE, acpSessionId, "utf8");
  log.info(`创建新 ACP 会话：${acpSessionId}  (cwd: ${CONFIG.cwd}, mcpServers: ${defaultMcpServers.length})`);
  return acpSessionId;
}

async function sendToACP(connection, client, sessionId, text, onChunk) {
  let cancelRequestedForUserInput = false;
  const collector = new MessageCollector({
    onChunk,
    onNeedUserInput: async () => {
      if (cancelRequestedForUserInput) return;
      cancelRequestedForUserInput = true;
      log.info("检测到 NEED_USER_INPUT，暂停当前 Session B 轮次，等待用户答复...");
      try { await connection.cancel({ sessionId }); } catch {}
    },
  });
  client._activeCollector = collector;
  try {
    await connection.prompt({ sessionId, prompt: [{ type: "text", text }] });
  } catch (err) {
    if (!cancelRequestedForUserInput) throw err;
  } finally {
    if (client._activeCollector === collector) client._activeCollector = null;
  }
  return collector.getText();
}

// ─── ACP Client ───────────────────────────────────────────────────────────────

class BridgeAcpClient {
  constructor() { this._activeCollector = null; this._toolTitles = new Map(); }

  async requestPermission(params) {
    const first = params.options[0];
    log.info(`自动允许：${params.toolCall.title} → ${first.name}`);
    return { outcome: { outcome: "selected", optionId: first.optionId } };
  }

  async sessionUpdate(params) {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          if (!_streaming) { process.stdout.write("\x1b[36m"); _streaming = true; } // 青色开始
          process.stdout.write(u.content.text);
          if (this._activeCollector) this._activeCollector.push(u.content.text);
        }
        break;
      case "agent_message":
        if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } // 重置颜色换行
        break;
      case "tool_call":
        log.info(`  🔧 [${u.status}] ${u.title}`);
        if (u.input) log.info(`      输入: ${JSON.stringify(u.input).slice(0, 200)}`);
        if (u.toolCallId && u.title) this._toolTitles.set(u.toolCallId, u.title);
        if (this._activeCollector) this._activeCollector.pushLive(`\n[工具] ${u.title}\n`);
        break;
      case "tool_call_update":
        log.info(`  ✅ [${u.status}] ${this._toolTitles.get(u.toolCallId) || u.toolCallId}`);
        if (u.output) log.info(`      输出: ${String(u.output).slice(0, 200)}`);
        if (this._activeCollector) {
          const output = u.output ? `：${String(u.output).slice(0, 120)}` : "";
          const title = this._toolTitles.get(u.toolCallId) || u.toolCallId;
          this._activeCollector.pushLive(`\n[完成] ${title}${output}\n`);
        }
        if (u.toolCallId && u.status !== "pending" && u.status !== "in_progress") this._toolTitles.delete(u.toolCallId);
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") {
          if (!_streaming) { process.stdout.write("\x1b[2m"); _streaming = true; } // 暗色开始
          process.stdout.write(u.content.text);
        }
        break;
      case "plan":
        log.info(`  📋 计划: ${JSON.stringify(u).slice(0, 200)}`);
        if (this._activeCollector) this._activeCollector.pushLive("\n[计划] 已更新执行计划\n");
        break;
      default:
        break;
    }
  }

  async writeTextFile(params) { log.warn(`writeTextFile: ${params.path}`); return {}; }
  async readTextFile(params)  { log.warn(`readTextFile: ${params.path}`);  return { content: "" }; }
}

class MessageCollector {
  constructor(options = {}) {
    this._parts = [];
    this._onChunk = options.onChunk || null;
    this._onNeedUserInput = options.onNeedUserInput || null;
    this._needUserInputTriggered = false;
  }
  push(text) {
    this._parts.push(text);
    if (this._onChunk) this._onChunk(text);
    if (!this._needUserInputTriggered && this._onNeedUserInput && parseNeedUserInput(this.getText())) {
      this._needUserInputTriggered = true;
      void this._onNeedUserInput();
    }
  }
  pushLive(text) {
    if (this._onChunk) this._onChunk(text);
  }
  getText() { return this._parts.join("").trim(); }
}

function parseNeedUserInput(text) {
  const match = text.match(/<<<NEED_USER_INPUT>>>([\s\S]*?)<<<END_NEED_USER_INPUT>>>/);
  if (!match) return null;

  const block = match[1].trim();
  const lines = block.split(/\r?\n/);
  const parsed = { question: "", context: "", kind: "", options: [] };
  let currentField = null;

  const flushField = (field, buffer) => {
    const value = buffer.join("\n").trim();
    if (!field || !value) return;
    if (field === "options") {
      parsed.options.push(...value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("-"))
        .map((line) => line.slice(1).trim())
        .filter(Boolean));
      return;
    }
    parsed[field] = value;
  };

  let buffer = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("question:")) {
      flushField(currentField, buffer);
      currentField = "question";
      buffer = [trimmed.slice("question:".length).trim()];
    } else if (trimmed.startsWith("context:")) {
      flushField(currentField, buffer);
      currentField = "context";
      buffer = [trimmed.slice("context:".length).trim()];
    } else if (trimmed.startsWith("kind:")) {
      flushField(currentField, buffer);
      currentField = "kind";
      buffer = [trimmed.slice("kind:".length).trim()];
    } else if (trimmed.startsWith("suggested_options:")) {
      flushField(currentField, buffer);
      currentField = "options";
      buffer = [];
    } else if (currentField) {
      buffer.push(currentField === "options" ? trimmed : line);
    }
  }

  flushField(currentField, buffer);

  return parsed.question ? parsed : null;
}

function nextTicketId() {
  questionSeq += 1;
  return `Q-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${String(questionSeq).padStart(3, "0")}`;
}

function sendQuestionToLark(ticket) {
  if (!ticket.chatId) {
    throw new Error("当前任务没有可用的飞书 chat_id，请先在目标群里和 Bot 说一句话，或配置 LARK_CHAT_ID");
  }

  const lines = [
    `[${ticket.ticketId}] 任务执行过程中需要你确认：`,
    ticket.questionText,
    ticket.context ? "" : null,
    ticket.context ? `背景：${ticket.context}` : null,
    "",
    `请直接回复并带上 [${ticket.ticketId}]，或直接回复本条消息。`,
    "注意：此时你的回复内容会被当作该问题的答案继续送回分析流程，请尽量直接回答，不要闲聊。",
    ...(ticket.options.length ? ["可选：", ...ticket.options.map((opt, i) => `${i + 1}. ${opt}`)] : []),
  ].filter(Boolean);
  notifyLark(lines.join("\n"), ticket.chatId);
}

function updateJob(jobId, patch) {
  const prev = analysisJobs.get(jobId);
  if (!prev) return;
  analysisJobs.set(jobId, { ...prev, ...patch, updatedAt: new Date().toISOString() });
}

function appendJobLiveLog(jobId, chunk) {
  const prev = analysisJobs.get(jobId);
  if (!prev || !chunk) return;
  const nextLog = ((prev.liveLog || "") + chunk).slice(-16000);
  analysisJobs.set(jobId, { ...prev, liveLog: nextLog, updatedAt: new Date().toISOString() });
}

function normalizePromptOverride(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function renderPromptTemplate(template, vars = {}) {
  return String(template || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = vars[key];
    return value == null ? "" : String(value);
  });
}

function buildDefaultRefactorPrompt(projectPath, docsFiles) {
  return [
    "请调用 refactor-planner 技能，对当前项目进行重构分析与迭代规划。",
    "要求：",
    "1. 当前工作目录就是项目根目录，请同时分析整个项目代码。",
    "2. 只分析 sysbuilder/ 目录根下的需求文档与规格文档，不要读取 sysbuilder 的子目录。",
    `3. 当前可见的 sysbuilder 根目录 Markdown 文件有：${docsFiles.length ? docsFiles.join("、") : "（无）"}`,
    "4. 如果你不确定这些文件里哪些才属于需求/规格文档，先按 NEED_USER_INPUT 协议通过飞书向用户确认，不要自行扩大范围。",
    "5. 结合已确认的需求/规格文档和现有项目实现，生成迭代计划与重构报告。",
    "6. 输出结果保存到 sysbuilder/refactor/ 目录下，至少包含：",
    "   - sysbuilder/refactor/00-总览.md",
    "   - sysbuilder/refactor/01-*.md",
    "7. 全程使用中文。",
    "8. 如果在分析过程中遇到任何无法确认的问题，不要自行假设，请按 NEED_USER_INPUT 协议输出问题。",
    "",
    "NEED_USER_INPUT 协议格式如下：",
    "<<<NEED_USER_INPUT>>>",
    "question: [要问用户的问题]",
    "context: [为什么需要确认]",
    "kind: [问题类型]",
    "suggested_options:",
    "- [选项1]",
    "- [选项2]",
    "<<<END_NEED_USER_INPUT>>>",
    "",
    "在收到用户回答后，请继续分析；如果还需要新的确认，可再次按上述格式提问。",
  ].join("\n");
}

function buildRefactorPrompt(projectPath, docsFiles, promptOverride) {
  const override = normalizePromptOverride(promptOverride);
  if (!override) return buildDefaultRefactorPrompt(projectPath, docsFiles);
  return renderPromptTemplate(override, {
    projectPath,
    docsFiles: docsFiles.length ? docsFiles.join("、") : "（无）",
  });
}

function buildDefaultStoryMapPrompt(projectPath, projectId, refactorFiles) {
  return [
    "你现在要执行“需求分析结果同步到 Story Map”的任务。",
    "目标：读取 sysbuilder/refactor/ 下的迭代文档，对比 sysbuilder 中当前项目的 Story Map，把明确全新的项新增进去；对完全重复的项跳过；对相近但不完全重复或归属不明确的项，必须先提问确认。",
    "",
    "当前上下文：",
    `- 项目根目录：${projectPath}`,
    `- 项目 ID：${projectId}`,
    `- sysbuilder/refactor/ 下当前可见的 Markdown 文件：${refactorFiles.length ? refactorFiles.join("、") : "（无）"}`,
    "",
    "你必须使用当前已注入的 sysbuilder MCP，并按下面顺序执行：",
    `1. 先调用 sysbuilder MCP 工具 get_project_context，参数 projectId='${projectId}'，读取项目上下文与 Sprint 列表。`,
    `2. 再调用 sysbuilder MCP 工具 load_story_map，参数 projectId='${projectId}'，读取当前 Story Map。`,
    "3. 再读取本地 sysbuilder/refactor/00-总览.md，并按需继续读取 sysbuilder/refactor/ 下其他迭代文档，提取候选的 Activity / Epic / Story。",
    "4. 对每个候选 Story，先整理出：brief、完整 description、所属 Activity/Epic、建议 Sprint、来源文档依据。",
    "5. 先在候选项内部去重，再与现有 Story Map 对比，把候选项严格分成三类：完全重复、相近待确认、明确全新。",
    "6. 只对“明确全新且父级归属明确”的项执行新增，不要改写、合并、删除已有项。",
    "",
    "sysbuilder MCP 工具使用要求：",
    `- 新增 Activity 时，调用 create_activity，参数至少包含 projectId='${projectId}'、activityName、description（可选）、createdBy='mcp'。`,
    `- 新增 Epic 时，调用 create_epic，参数至少包含 activityId、epicName、createdBy='mcp'，并附 projectId='${projectId}'。`,
    "- 新增 Story 时，调用 create_story 必须直接传入非空的完整 description，至少包含：用户目标、核心流程/范围、关键约束或补充说明、来源依据；不要只写标题或一句空泛描述。",
    "- 如果项目当前一个 Sprint 都没有，必须先调用 create_sprint 为该项目创建 Sprint，再创建 Story；不要因为“没有 Sprint”就把 Story 全部放进 backlog。",
    "- create_sprint 时优先根据 sysbuilder/refactor 的迭代章节、阶段目标、里程碑来决定 Sprint 数量与命名；如果文档只体现单一阶段，就创建一个默认 Sprint。",
    "- create_sprint 后，create_story 必须填写新建 Sprint 或匹配 Sprint 的 sprintId；不要默认留空放入 backlog。",
    "- 只有在 sysbuilder/refactor 与现有 Sprint 信息都不足以判断归属、且确实不适合立即建 Sprint 时，才允许暂不填写 sprintId；如果多个 Sprint 都可能匹配，必须先提问确认。",
    "- 新增 Story 时，workType 固定使用 TICKET，不要使用 USER_STORY / TECH_STORY / BUG。",
    "- 不要调用 edit_story 去修改已有 Story，也不要把它当作新建 Story 的默认补救步骤。",
    "- 不要调用 update_story_status 去修改已有项状态。",
    "",
    "判定规则：",
    "- 完全重复：标题、意图、范围都已被现有 Story Map 覆盖，直接跳过。",
    "- 相近待确认：语义接近但不完全等同，或可能是现有项的拆分/扩展/重命名，必须提问。",
    "- 明确全新：现有 Story Map 中没有覆盖，且父级归属明确，可以直接新增。",
    "- Sprint 归类：优先依据 sysbuilder/refactor 中的迭代边界、阶段目标、依赖前后关系，以及 get_project_context 返回的 sprintName/goal/已有 stories 做匹配；若现有 Sprint 为空，则先创建再归类。",
    "",
    "禁止事项：",
    "- 不要尝试安装任何本地依赖。",
    "- 不要尝试从本地源码目录手工启动新的 sysbuilder MCP。",
    "- 不要绕过当前已注入的 sysbuilder MCP 去构造临时 client。",
    "- 不要创建“只有 brief 没有 description”的 Story。",
    "",
    "如果你有任何无法确认的问题，必须按下面协议只输出一个问题块，不要混入其他总结：",
    "<<<NEED_USER_INPUT>>>",
    "question: [要问用户的问题]",
    "context: [为什么需要确认，以及你已经识别到的候选项/相近项背景]",
    "kind: [storymap-sync]",
    "suggested_options:",
    "- [选项1]",
    "- [选项2]",
    "<<<END_NEED_USER_INPUT>>>",
    "",
    "在收到用户回答后，请继续同步。",
    "最终完成时请用中文给出简短结果总结，至少说明：新增了多少个 Sprint、多少个 Activity、多少个 Epic、多少个 Story，哪些 Story 已归入 Sprint、哪些仍在 backlog，跳过了多少个重复项，是否还有待确认项。",
  ].join("\n");
}

function buildStoryMapPrompt(projectPath, projectId, refactorFiles, promptOverride) {
  const override = normalizePromptOverride(promptOverride);
  if (!override) return buildDefaultStoryMapPrompt(projectPath, projectId, refactorFiles);
  return renderPromptTemplate(override, {
    projectPath,
    projectId,
    refactorFiles: refactorFiles.length ? refactorFiles.join("、") : "（无）",
  });
}

function getAnalysisOutputPaths(localPath) {
  const outputDir = join(localPath, "sysbuilder", "project-analysis");
  return {
    outputDir,
    reportPath: join(outputDir, "analysis-report.md"),
    baselinePath: join(outputDir, "analysis-baseline.json"),
  };
}

function buildDefaultAnalysisPrompt() {
  const paths = getAnalysisOutputPaths(".");
  return [
    "请调用 project-analysis 对当前项目进行完整项目分析。",
    "这是必选项，不要改用其他分析方式，也不要因为缺少替代 skill 而变更流程。",
    "",
    "输出要求：",
    `1. 将 Markdown 报告保存到 ${paths.reportPath.replace(/\\/g, "/")}。`,
    `2. 将 JSON 基线保存到 ${paths.baselinePath.replace(/\\/g, "/")}。`,
    "3. 全程使用中文。",
    "4. 全部完成后再回复：项目分析完成。",
  ].join("\n");
}

function buildAnalysisPrompt(localPath, reportId, promptOverride) {
  const override = normalizePromptOverride(promptOverride);
  const paths = getAnalysisOutputPaths(localPath);
  if (!override) return buildDefaultAnalysisPrompt();
  return renderPromptTemplate(override, {
    projectPath: localPath,
    reportId: typeof reportId === "string" ? reportId.trim() : "",
    analysisOutputDir: paths.outputDir.replace(/\\/g, "/"),
    analysisReportPath: paths.reportPath.replace(/\\/g, "/"),
    analysisBaselinePath: paths.baselinePath.replace(/\\/g, "/"),
    capmOutputDir: paths.outputDir.replace(/\\/g, "/"),
    capmReportPath: paths.reportPath.replace(/\\/g, "/"),
    capmBaselinePath: paths.baselinePath.replace(/\\/g, "/"),
  });
}

function isJobStopRequested(jobId) {
  return Boolean(analysisJobs.get(jobId)?.stopRequested);
}

function detectUnresolvedConfirmations(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matched = lines.filter((line) => (
    /仍待确认|待确认事项|剩余\d+个问题|未确认|需与.+确认|需要与.+确认|后续确认/.test(line)
  ));
  if (!matched.length) return null;
  return matched.slice(0, 3).join("；");
}

function detectFatalExecutionError(text) {
  if (!text) return null;
  const match = text.match(/Error:\s*Execution failed:[\s\S]*?(?=Error:\s*Execution failed:|$)/);
  return match ? match[0].trim() : null;
}

function ensureRefactorOutputs(projectPath) {
  const refactorDir = join(projectPath, "sysbuilder", "refactor");
  const overviewPath = join(refactorDir, "00-总览.md");
  return {
    refactorDir,
    overviewPath,
    hasOverview: existsSync(overviewPath),
  };
}

function listTopLevelDocsMarkdown(projectPath) {
  const docsDir = join(projectPath, "sysbuilder");
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => entry.name);
}

function buildRefactorCompletionSummary(projectPath) {
  const refactorDir = join(projectPath, "sysbuilder", "refactor");
  const files = existsSync(refactorDir)
    ? readdirSync(refactorDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
    : [];
  const preview = files.slice(0, 5).join("、");
  return [
    "✅ 需求文档分析已完成",
    `项目：${projectPath}`,
    `输出文档：${files.length} 份`,
    preview ? `文件：${preview}${files.length > 5 ? " 等" : ""}` : null,
    "可先查看 00-总览.md",
  ].filter(Boolean).join("\n");
}

function listRefactorMarkdown(projectPath) {
  const refactorDir = join(projectPath, "sysbuilder", "refactor");
  if (!existsSync(refactorDir)) return [];
  return readdirSync(refactorDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function buildStoryMapSyncCompletionSummary(job, replyText) {
  const fullReply = String(replyText || "").replace(/\r\n/g, "\n").trim();

  return [
    "✅ Story Map 同步已完成",
    `项目目录：${job.projectPath}`,
    job.projectId ? `项目 ID：${job.projectId}` : null,
    fullReply ? "模型回复：" : null,
    fullReply || "（模型未返回正文）",
  ].filter(Boolean).join("\n");
}

function abortReportRun(reportRun, reason) {
  if (!reportRun) return false;
  reportRun.stopRequested = true;
  reportRun.updatedAt = new Date().toISOString();
  if (reason) {
    reportRun.error = reason;
    reportRun.liveLog = ((reportRun.liveLog || "") + `\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${reason}\n`).slice(-16000);
  }
  if (typeof reportRun.abort === "function") {
    reportRun.abort(new Error(reason || "报告分析已取消"));
  }
  return true;
}

function appendReportLiveLog(reportRun, chunk) {
  if (!reportRun || !chunk) return;
  reportRun.liveLog = ((reportRun.liveLog || "") + chunk).slice(-16000);
  reportRun.updatedAt = new Date().toISOString();
}

function updateReportRun(reportRun, patch) {
  if (!reportRun) return;
  Object.assign(reportRun, patch, { updatedAt: new Date().toISOString() });
}

function getPublicReportRun(reportRun) {
  if (!reportRun) return null;
  return {
    reportId: reportRun.reportId,
    projectId: reportRun.projectId,
    localPath: reportRun.localPath,
    sessionId: reportRun.sessionId,
    status: reportRun.status || "idle",
    liveLog: reportRun.liveLog || "",
    error: reportRun.error || null,
    updatedAt: reportRun.updatedAt || null,
    stopRequested: Boolean(reportRun.stopRequested),
  };
}

async function stopAllAnalysisJobs(reason) {
  const jobs = Array.from(analysisJobs.values());
  const waitingIds = Array.from(waitingTickets.keys());
  let stoppedReportRuns = 0;

  for (const ticketId of waitingIds) {
    waitingTickets.delete(ticketId);
  }

  for (const job of jobs) {
    if (job.connection && job.sessionId) {
      try { await job.connection.cancel({ sessionId: job.sessionId }); } catch {}
      try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    }
    destroyJobTransport(job);

    updateJob(job.jobId, {
      status: "failed",
      stopRequested: true,
      waitingTicketId: null,
      latestQuestion: null,
      latestQuestionContext: null,
      error: reason,
      connection: null,
      client: null,
      socket: null,
    });
  }

  const reportRun = activeReportRun;
  if (reportRun?.connection && reportRun?.sessionId) {
    abortReportRun(reportRun, reason);
    try { await reportRun.connection.cancel({ sessionId: reportRun.sessionId }); } catch {}
    try { await reportRun.connection.closeSession({ sessionId: reportRun.sessionId }); } catch {}
    destroyJobTransport(reportRun);
    stoppedReportRuns = 1;
  }

  return { stoppedJobs: jobs.length, clearedTickets: waitingIds.length, stoppedReportRuns };
}

async function processSessionBReply(job, replyText) {
  if (isJobStopRequested(job.jobId)) {
    log.info(`分析任务 ${job.jobId} 已被 stop，请忽略本轮 Session B 回复`);
    return;
  }
  const followUp = parseNeedUserInput(replyText);
  if (followUp) {
    const ticketId = nextTicketId();
    const ticket = {
      ticketId,
      jobId: job.jobId,
      jobKind: job.kind,
      chatId: job.notifyChatId,
      sessionId: job.sessionId,
      questionText: followUp.question,
      context: followUp.context,
      kind: followUp.kind,
      options: followUp.options,
      status: "waiting",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    waitingTickets.set(ticketId, ticket);
    updateJob(job.jobId, {
      status: "waiting_user",
      waitingTicketId: ticketId,
      latestQuestion: ticket.questionText,
      latestQuestionContext: ticket.context,
      latestReplyPreview: replyText.slice(0, 500),
    });
    sendQuestionToLark(ticket);
    return;
  }

  const fatalExecutionError = detectFatalExecutionError(replyText);
  if (fatalExecutionError) {
    updateJob(job.jobId, {
      status: "failed",
      error: fatalExecutionError,
      latestReplyPreview: replyText.slice(0, 500),
    });
    notifyLark(`❌ 需求文档分析失败：${fatalExecutionError}`, job.notifyChatId);
    try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    return;
  }

  const outputs = ensureRefactorOutputs(job.projectPath);
  if (!outputs.hasOverview) {
    const nextRetryCount = (job.outputRetryCount || 0) + 1;
    updateJob(job.jobId, {
      status: "running",
      outputRetryCount: nextRetryCount,
      latestReplyPreview: replyText.slice(0, 500),
      error: null,
    });

    if (nextRetryCount <= 3) {
      const retryPrompt = [
        "你刚才的回复还没有对应落盘结果。",
        `当前仍未检测到输出文件：${outputs.overviewPath}`,
        "",
        "请不要只给口头总结，而是立即把重构分析结果真正写入项目文件：",
        "1. 创建 sysbuilder/refactor/ 目录（如果还不存在）",
        "2. 写入 sysbuilder/refactor/00-总览.md",
        "3. 再写入至少一个 sysbuilder/refactor/01-*.md 迭代报告",
        "4. 写完后再回复我“已写入 sysbuilder/refactor/00-总览.md”",
        "",
        "如果你缺少信息，请按 NEED_USER_INPUT 协议继续提问。",
      ].join("\n");
      await continueRefactorAnalysis(analysisJobs.get(job.jobId), retryPrompt);
      return;
    }

    updateJob(job.jobId, {
      status: "failed",
      error: `未找到输出文件：${outputs.overviewPath}`,
      latestReplyPreview: replyText.slice(0, 500),
    });
    notifyLark(`❌ 需求文档分析失败：未找到输出文件 ${outputs.overviewPath}`, job.notifyChatId);
    try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    return;
  }

  const unresolvedConfirmations = detectUnresolvedConfirmations(replyText);
  if (unresolvedConfirmations) {
    const nextRetryCount = (job.unresolvedRetryCount || 0) + 1;
    updateJob(job.jobId, {
      status: "running",
      unresolvedRetryCount: nextRetryCount,
      latestReplyPreview: replyText.slice(0, 500),
      error: null,
    });

    if (nextRetryCount <= 2) {
      const retryPrompt = [
        "你刚才的回复里仍然包含未确认事项，但没有按 NEED_USER_INPUT 协议正式发起确认，因此现在不能直接结束分析。",
        `检测到的未确认内容：${unresolvedConfirmations}`,
        "",
        "请按以下规则继续：",
        "1. 如果这些事项需要用户确认，请立即只输出一个 NEED_USER_INPUT 块，先询问当前最关键的一项。",
        "2. 不要在同一轮里一边提问、一边继续宣布完成。",
        "3. 只有在确实无需进一步确认时，才明确说明“无需用户确认，可继续完成”，并去掉“仍待确认/剩余问题/待确认事项”等表述。",
      ].join("\n");
      await continueRefactorAnalysis(analysisJobs.get(job.jobId), retryPrompt);
      return;
    }

    updateJob(job.jobId, {
      status: "failed",
      error: "分析输出仍包含未确认事项，但未按 NEED_USER_INPUT 协议发起提问",
      latestReplyPreview: replyText.slice(0, 500),
    });
    notifyLark("❌ 需求文档分析未能正确处理待确认事项：仍有未确认内容，但没有按 NEED_USER_INPUT 协议提问。", job.notifyChatId);
    try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    return;
  }

  updateJob(job.jobId, {
    status: "completed",
    latestReplyPreview: replyText.slice(0, 500),
    outputDir: outputs.refactorDir,
    overviewPath: outputs.overviewPath,
  });
  notifyLark(buildRefactorCompletionSummary(job.projectPath), job.notifyChatId);
  try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
}

async function continueRefactorAnalysis(job, prompt) {
  if (!job || isJobStopRequested(job.jobId)) return;
  updateJob(job.jobId, {
    status: "running",
    liveLog: `${job.liveLog || ""}\n\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 开始新一轮分析...\n`.slice(-16000),
  });
  let replyText = "";
  try {
    replyText = await sendToACP(
      job.connection,
      job.client,
      job.sessionId,
      prompt,
      (chunk) => appendJobLiveLog(job.jobId, chunk),
    );
  } catch (err) {
    if (isJobStopRequested(job.jobId)) {
      log.info(`分析任务 ${job.jobId} 在 sendToACP 期间已被 stop，终止后续处理`);
      return;
    }
    throw err;
  }
  if (isJobStopRequested(job.jobId)) {
    log.info(`分析任务 ${job.jobId} 在收到回复后已被 stop，终止后续处理`);
    return;
  }
  await processSessionBReply(job, replyText);
}

async function processStoryMapSyncReply(job, replyText) {
  if (isJobStopRequested(job.jobId)) {
    log.info(`同步任务 ${job.jobId} 已被 stop，请忽略本轮 Session B 回复`);
    return;
  }

  const followUp = parseNeedUserInput(replyText);
  if (followUp) {
    const ticketId = nextTicketId();
    const ticket = {
      ticketId,
      jobId: job.jobId,
      jobKind: job.kind,
      chatId: job.notifyChatId,
      sessionId: job.sessionId,
      questionText: followUp.question,
      context: followUp.context,
      kind: followUp.kind,
      options: followUp.options,
      status: "waiting",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    waitingTickets.set(ticketId, ticket);
    updateJob(job.jobId, {
      status: "waiting_user",
      waitingTicketId: ticketId,
      latestQuestion: ticket.questionText,
      latestQuestionContext: ticket.context,
      latestReplyPreview: replyText.slice(0, 500),
    });
    sendQuestionToLark(ticket);
    return;
  }

  const fatalExecutionError = detectFatalExecutionError(replyText);
  if (fatalExecutionError) {
    updateJob(job.jobId, {
      status: "failed",
      error: fatalExecutionError,
      latestReplyPreview: replyText.slice(0, 500),
    });
    notifyLark(`❌ Story Map 同步失败：${fatalExecutionError}`, job.notifyChatId);
    try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    return;
  }

  const unresolvedConfirmations = detectUnresolvedConfirmations(replyText);
  if (unresolvedConfirmations) {
    const nextRetryCount = (job.unresolvedRetryCount || 0) + 1;
    updateJob(job.jobId, {
      status: "running",
      unresolvedRetryCount: nextRetryCount,
      latestReplyPreview: replyText.slice(0, 500),
      error: null,
    });

    if (nextRetryCount <= 2) {
      const retryPrompt = [
        "你刚才的 Story Map 同步回复里仍然包含未确认事项，但没有按 NEED_USER_INPUT 协议正式发起确认，因此现在不能直接结束同步。",
        `检测到的未确认内容：${unresolvedConfirmations}`,
        "",
        "请按以下规则继续：",
        "1. 如果这些事项需要用户确认，请立即只输出一个 NEED_USER_INPUT 块，先询问当前最关键的一项。",
        "2. 不要在同一轮里一边提问、一边继续宣布同步完成。",
        "3. 只有在确实无需进一步确认时，才明确说明“无需用户确认，可继续完成”，并去掉“仍待确认/剩余问题/待确认事项”等表述。",
      ].join("\n");
      await continueStoryMapSync(analysisJobs.get(job.jobId), retryPrompt);
      return;
    }

    updateJob(job.jobId, {
      status: "failed",
      error: "Story Map 同步输出仍包含未确认事项，但未按 NEED_USER_INPUT 协议发起提问",
      latestReplyPreview: replyText.slice(0, 500),
    });
    notifyLark("❌ Story Map 同步未能正确处理待确认事项：仍有未确认内容，但没有按 NEED_USER_INPUT 协议提问。", job.notifyChatId);
    try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
    return;
  }

  updateJob(job.jobId, {
    status: "completed",
    latestReplyPreview: replyText.slice(0, 500),
    error: null,
  });
  notifyLark(buildStoryMapSyncCompletionSummary(job, replyText), job.notifyChatId);
  try { await job.connection.closeSession({ sessionId: job.sessionId }); } catch {}
}

async function continueStoryMapSync(job, prompt) {
  if (!job || isJobStopRequested(job.jobId)) return;
  updateJob(job.jobId, {
    status: "running",
    liveLog: `${job.liveLog || ""}\n\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 开始新一轮 Story Map 同步...\n`.slice(-16000),
  });
  let replyText = "";
  try {
    replyText = await sendToACP(
      job.connection,
      job.client,
      job.sessionId,
      prompt,
      (chunk) => appendJobLiveLog(job.jobId, chunk),
    );
  } catch (err) {
    if (isJobStopRequested(job.jobId)) {
      log.info(`同步任务 ${job.jobId} 在 sendToACP 期间已被 stop，终止后续处理`);
      return;
    }
    throw err;
  }
  if (isJobStopRequested(job.jobId)) {
    log.info(`同步任务 ${job.jobId} 在收到回复后已被 stop，终止后续处理`);
    return;
  }
  await processStoryMapSyncReply(job, replyText);
}

async function startRefactorAnalysis(projectPath, options = {}) {
  const jobId = `refactor-${Date.now()}`;
  const routeKey = buildChatRouteKey(options.userId, options.projectId);
  const notifyChatId = resolveTaskChat(routeKey);
  if (!notifyChatId) {
    throw new Error("当前没有可用的飞书 chat 路由，请先在目标群里和 Bot 说一句话建立绑定，或显式配置 LARK_CHAT_ID");
  }
  const docsFiles = listTopLevelDocsMarkdown(projectPath);
  const job = {
    kind: "refactor-analysis",
    jobId,
    projectPath,
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    waitingTicketId: null,
    latestQuestion: null,
    latestQuestionContext: null,
    latestReplyPreview: null,
    liveLog: "",
    outputDir: null,
    overviewPath: null,
    outputRetryCount: 0,
    unresolvedRetryCount: 0,
    notifyChatId,
    routeKey,
    stopRequested: false,
    error: null,
    connection: null,
    client: null,
    socket: null,
    sessionId: null,
  };
  analysisJobs.set(jobId, job);

  try {
    let conn2, client2, socket2;
    for (let i = 1; i <= CONFIG.maxRetries; i++) {
      try { ({ connection: conn2, client: client2, socket: socket2 } = await connectToACP()); break; }
      catch (err) {
        if (i === CONFIG.maxRetries) throw new Error(`Session B 连接失败：${err.message}`);
        await sleep(2000);
      }
    }

    const { sessionId } = await conn2.newSession({ cwd: projectPath, mcpServers: [] });
    updateJob(jobId, {
      status: "running",
      connection: conn2,
      client: client2,
      socket: socket2,
      sessionId,
    });
    if (isJobStopRequested(jobId)) {
      try { await conn2.cancel({ sessionId }); } catch {}
      try { await conn2.closeSession({ sessionId }); } catch {}
      destroyJobTransport({ socket: socket2 });
      return jobId;
    }

    notifyLark([
      "📝 已开始需求文档分析。",
      `项目目录：${projectPath}`,
      "接下来将调用 refactor-planner 分析 sysbuilder/ 下的需求/规格文档，并结合整个项目生成 sysbuilder/refactor/ 迭代计划。",
      "如果过程中有疑问，我会继续在群里提问；届时请把你的回复内容直接当作该问题的答案。",
    ].join("\n"), notifyChatId);

    const prompt = buildRefactorPrompt(projectPath, docsFiles, options.promptOverride);

    continueRefactorAnalysis(analysisJobs.get(jobId), prompt).catch((err) => {
      updateJob(jobId, { status: "failed", error: err?.message || String(err) });
      notifyLark(`❌ 需求文档分析失败：${err?.message || String(err)}`, notifyChatId);
    });
  } catch (err) {
    updateJob(jobId, { status: "failed", error: err?.message || String(err) });
    notifyLark(`❌ 需求文档分析启动失败：${err?.message || String(err)}`, notifyChatId);
  }

  return jobId;
}

async function startStoryMapSync(projectPath, projectId, options = {}) {
  const jobId = `storymap-sync-${Date.now()}`;
  const routeKey = buildChatRouteKey(options.userId, projectId);
  const notifyChatId = resolveTaskChat(routeKey);
  if (!notifyChatId) {
    throw new Error("当前没有可用的飞书 chat 路由，请先在目标群里和 Bot 说一句话建立绑定，或显式配置 LARK_CHAT_ID");
  }
  const refactorFiles = listRefactorMarkdown(projectPath);
  const job = {
    kind: "storymap-sync",
    jobId,
    projectId,
    projectPath,
    status: "starting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    waitingTicketId: null,
    latestQuestion: null,
    latestQuestionContext: null,
    latestReplyPreview: null,
    liveLog: "",
    notifyChatId,
    routeKey,
    unresolvedRetryCount: 0,
    stopRequested: false,
    error: null,
    connection: null,
    client: null,
    sessionId: null,
  };
  analysisJobs.set(jobId, job);

  try {
    let conn2, client2, socket2;
    for (let i = 1; i <= CONFIG.maxRetries; i++) {
      try { ({ connection: conn2, client: client2, socket: socket2 } = await connectToACP()); break; }
      catch (err) {
        if (i === CONFIG.maxRetries) throw new Error(`Story Map 同步会话连接失败：${err.message}`);
        await sleep(2000);
      }
    }

    const configuredSysbuilderServer = requireConfiguredSysbuilderMcpServer();
    log.info(`Story Map 同步注入 sysbuilder MCP：${JSON.stringify(
      configuredSysbuilderServer.type === "stdio"
        ? {
            type: configuredSysbuilderServer.type,
            name: configuredSysbuilderServer.name,
            command: configuredSysbuilderServer.command,
            args: configuredSysbuilderServer.args,
            envKeys: Object.keys(configuredSysbuilderServer.env || {}),
          }
        : {
            type: configuredSysbuilderServer.type,
            name: configuredSysbuilderServer.name,
            url: configuredSysbuilderServer.url,
            headerKeys: Object.keys(configuredSysbuilderServer.headers || {}),
          }
    )}`);
    const sysbuilderServer = buildAcpMcpServer(configuredSysbuilderServer);
    const { sessionId } = await conn2.newSession({ cwd: projectPath, mcpServers: [sysbuilderServer] });
    log.info(`Story Map 同步 Session B 已创建：${sessionId}（mcpServers: 1）`);
    updateJob(jobId, {
      status: "running",
      connection: conn2,
      client: client2,
      socket: socket2,
      sessionId,
    });
    if (isJobStopRequested(jobId)) {
      try { await conn2.cancel({ sessionId }); } catch {}
      try { await conn2.closeSession({ sessionId }); } catch {}
      destroyJobTransport({ socket: socket2 });
      return jobId;
    }

    notifyLark([
      "🗺️ 已开始 Story Map 同步。",
      `项目目录：${projectPath}`,
      projectId ? `项目 ID：${projectId}` : null,
      "接下来将读取 sysbuilder/refactor/ 迭代文档、调用 sysbuilder MCP 读取现有 Story Map，并把明确全新的项补入 Story Map。",
      "如果过程中存在相近但无法自动判定的项，我会继续在群里提问确认。",
    ].filter(Boolean).join("\n"), notifyChatId);

    const prompt = buildStoryMapPrompt(projectPath, projectId, refactorFiles, options.promptOverride);

    continueStoryMapSync(analysisJobs.get(jobId), prompt).catch((err) => {
      updateJob(jobId, { status: "failed", error: err?.message || String(err) });
      notifyLark(`❌ Story Map 同步失败：${err?.message || String(err)}`, notifyChatId);
    });
  } catch (err) {
    updateJob(jobId, { status: "failed", error: err?.message || String(err) });
    notifyLark(`❌ Story Map 同步启动失败：${err?.message || String(err)}`, notifyChatId);
  }

  return jobId;
}

function findTicketForAnswer(msgText) {
  if (!msgText || msgText.startsWith("!")) return null;
  const explicitId = msgText.match(/\[(Q-\d{8}-\d{3})\]/)?.[1];
  if (explicitId && waitingTickets.has(explicitId)) {
    return waitingTickets.get(explicitId);
  }

  const waiting = Array.from(waitingTickets.values()).filter((ticket) => ticket.status === "waiting");
  if (waiting.length === 1) {
    return waiting[0];
  }
  return null;
}

async function resumeRefactorAnalysis(ticket, answerText) {
  const job = analysisJobs.get(ticket.jobId);
  if (!job || !job.connection || !job.sessionId) {
    throw new Error("找不到对应的分析会话，无法继续");
  }

  waitingTickets.set(ticket.ticketId, { ...ticket, status: "answered", answerText });
  updateJob(job.jobId, {
    status: "running",
    stopRequested: false,
    waitingTicketId: null,
    latestQuestion: null,
    latestQuestionContext: null,
  });

  const resumePrompt = [
    "继续刚才的 refactor-planner 分析任务。",
    "",
    "你之前提出的问题是：",
    ticket.questionText,
    "",
    "用户的回答是：",
    answerText,
    "",
    "请基于该回答继续分析，并继续输出到 sysbuilder/refactor/。",
    "如果还有疑问，请继续按 NEED_USER_INPUT 协议输出。",
  ].join("\n");

  await continueRefactorAnalysis(job, resumePrompt);
}

async function resumeStoryMapSync(ticket, answerText) {
  const job = analysisJobs.get(ticket.jobId);
  if (!job || !job.connection || !job.sessionId) {
    throw new Error("找不到对应的 Story Map 同步会话，无法继续");
  }

  waitingTickets.set(ticket.ticketId, { ...ticket, status: "answered", answerText });
  updateJob(job.jobId, {
    status: "running",
    stopRequested: false,
    waitingTicketId: null,
    latestQuestion: null,
    latestQuestionContext: null,
  });

  const resumePrompt = [
    "继续刚才的 Story Map 同步任务。",
    "",
    "你之前提出的问题是：",
    ticket.questionText,
    "",
    "用户的回答是：",
    answerText,
    "",
    "请基于该回答继续同步 Story Map。",
    "如果还有疑问，请继续按 NEED_USER_INPUT 协议输出。",
  ].join("\n");

  await continueStoryMapSync(job, resumePrompt);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function createHttpServer() {
  if (bridgeHttpServer) {
    return bridgeHttpServer;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${CONFIG.bridgeHttpPort}`);

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, lastChatId, runningJobs: analysisJobs.size });
      }

      if (req.method === "POST" && url.pathname === "/refactor-analysis/start") {
        const body = await readJsonBody(req);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
        const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
        const userId = typeof body.userId === "string" ? body.userId.trim() : "";
        const promptOverride = normalizePromptOverride(body.promptOverride);
        if (!projectPath) return sendJson(res, 400, { error: "projectPath is required" });
        if (!resolveTaskChat(buildChatRouteKey(userId, projectId))) {
          return sendJson(res, 400, { error: "尚无可用的飞书 chat 路由，请先在目标群里和 Bot 说一句话建立绑定，或显式配置 LARK_CHAT_ID" });
        }
        const jobId = await startRefactorAnalysis(projectPath, { userId, projectId, promptOverride });
        return sendJson(res, 200, { jobId });
      }

      if (req.method === "POST" && url.pathname === "/storymap-sync/start") {
        const body = await readJsonBody(req);
        const projectPath = typeof body.projectPath === "string" ? body.projectPath.trim() : "";
        const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
        const userId = typeof body.userId === "string" ? body.userId.trim() : "";
        const promptOverride = normalizePromptOverride(body.promptOverride);
        if (!projectPath) return sendJson(res, 400, { error: "projectPath is required" });
        if (!projectId) return sendJson(res, 400, { error: "projectId is required" });
        if (!resolveTaskChat(buildChatRouteKey(userId, projectId))) {
          return sendJson(res, 400, { error: "尚无可用的飞书 chat 路由，请先在目标群里和 Bot 说一句话建立绑定，或显式配置 LARK_CHAT_ID" });
        }
        const jobId = await startStoryMapSync(projectPath, projectId, { userId, promptOverride });
        return sendJson(res, 200, { jobId });
      }

      if (req.method === "GET" && url.pathname === "/refactor-analysis/find") {
        const projectPath = url.searchParams.get("projectPath")?.trim();
        if (!projectPath) return sendJson(res, 400, { error: "projectPath is required" });
        const matches = Array.from(analysisJobs.values())
          .filter((job) => job.kind === "refactor-analysis" && job.projectPath === projectPath)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const activeJob = matches.find((job) => job.status !== "completed" && job.status !== "failed") || matches[0];
        if (!activeJob) return sendJson(res, 404, { error: "job not found" });
        return sendJson(res, 200, { jobId: activeJob.jobId, status: activeJob.status });
      }

      if (req.method === "GET" && url.pathname === "/storymap-sync/find") {
        const projectPath = url.searchParams.get("projectPath")?.trim();
        if (!projectPath) return sendJson(res, 400, { error: "projectPath is required" });
        const matches = Array.from(analysisJobs.values())
          .filter((job) => job.kind === "storymap-sync" && job.projectPath === projectPath)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const activeJob = matches.find((job) => job.status !== "completed" && job.status !== "failed") || matches[0];
        if (!activeJob) return sendJson(res, 404, { error: "job not found" });
        return sendJson(res, 200, { jobId: activeJob.jobId, status: activeJob.status });
      }

      if (req.method === "GET" && url.pathname === "/refactor-analysis/status") {
        const jobId = url.searchParams.get("jobId");
        if (!jobId || !analysisJobs.has(jobId)) return sendJson(res, 404, { error: "job not found" });
        const job = analysisJobs.get(jobId);
        const publicJob = { ...job };
        delete publicJob.connection;
        delete publicJob.client;
        return sendJson(res, 200, publicJob);
      }

      if (req.method === "GET" && url.pathname === "/storymap-sync/status") {
        const jobId = url.searchParams.get("jobId");
        if (!jobId || !analysisJobs.has(jobId)) return sendJson(res, 404, { error: "job not found" });
        const job = analysisJobs.get(jobId);
        const publicJob = { ...job };
        delete publicJob.connection;
        delete publicJob.client;
        return sendJson(res, 200, publicJob);
      }

      if (req.method === "POST" && url.pathname === "/report-analysis/cancel") {
        const body = await readJsonBody(req);
        const reportId = typeof body.reportId === "string" ? body.reportId.trim() : "";
        if (!reportId) return sendJson(res, 400, { error: "reportId is required" });
        const reportRun = activeReportRun;
        if (!reportRun || reportRun.reportId !== reportId) {
          return sendJson(res, 200, { stopped: false });
        }
        abortReportRun(reportRun, "已通过删除报告取消当前分析");
        try { await reportRun.connection?.cancel({ sessionId: reportRun.sessionId }); } catch {}
        try { await reportRun.connection?.closeSession({ sessionId: reportRun.sessionId }); } catch {}
        destroyJobTransport(reportRun);
        return sendJson(res, 200, { stopped: true });
      }

      if (req.method === "GET" && url.pathname === "/report-analysis/status") {
        const reportId = (url.searchParams.get("reportId") || "").trim();
        if (!reportId) return sendJson(res, 400, { error: "reportId is required" });
        const reportRun = activeReportRun;
        if (!reportRun || reportRun.reportId !== reportId) {
          return sendJson(res, 200, {
            reportId,
            status: "idle",
            liveLog: "",
            error: null,
            updatedAt: null,
            stopRequested: false,
          });
        }
        return sendJson(res, 200, getPublicReportRun(reportRun));
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err?.message || String(err) });
    }
  });

  server.on("error", (err) => {
    bridgeHttpServer = null;
    if (err?.code === "EADDRINUSE") {
      log.error(`[Bridge] HTTP 端口 ${CONFIG.bridgeHttpPort} 已被占用，无法启动本地接口`);
      return;
    }
    log.error(`[Bridge] HTTP 接口异常：${err?.message || String(err)}`);
  });

  server.listen(CONFIG.bridgeHttpPort, "127.0.0.1", () => {
    bridgeHttpServer = server;
    log.info(`[Bridge] HTTP 接口已启动：http://127.0.0.1:${CONFIG.bridgeHttpPort}`);
  });

  return server;
}

// ─── 分析任务：临时 ACP Session B ────────────────────────────────────────────

async function runAnalysisSession(localPath, options = {}) {
  log.info(`创建分析 Session B（cwd: ${localPath}）...`);
  let conn2, client2, socket2;
  for (let i = 1; i <= CONFIG.maxRetries; i++) {
    try { ({ connection: conn2, client: client2, socket: socket2 } = await connectToACP()); break; }
    catch (err) {
      if (i === CONFIG.maxRetries) throw new Error(`Session B 连接失败：${err.message}`);
      await sleep(2000);
    }
  }

  const { sessionId: sid2 } = await conn2.newSession({ cwd: localPath, mcpServers: [] });
  log.info(`分析 Session B 已创建：${sid2}`);

  const reportRun = {
    reportId: typeof options.reportId === "string" ? options.reportId.trim() : "",
    projectId: typeof options.projectId === "string" ? options.projectId.trim() : "",
    localPath,
    status: "starting",
    liveLog: "",
    error: null,
    updatedAt: new Date().toISOString(),
    connection: conn2,
    client: client2,
    socket: socket2,
    sessionId: sid2,
    stopRequested: false,
    abort: null,
  };
  reportRun.abortPromise = new Promise((_, reject) => {
    reportRun.abort = (error) => reject(error || new Error("报告分析已取消"));
  });
  activeReportRun = reportRun;

  const prompt = buildAnalysisPrompt(localPath, reportRun.reportId, options.promptOverride);

  try {
    updateReportRun(reportRun, { status: "running" });
    appendReportLiveLog(reportRun, `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 已启动项目分析会话\n`);
    await Promise.race([
      sendToACP(conn2, client2, sid2, prompt, (chunk) => appendReportLiveLog(reportRun, chunk)),
      reportRun.abortPromise,
    ]);
    updateReportRun(reportRun, { status: "completed" });
  } finally {
    try { await conn2.closeSession({ sessionId: sid2 }); } catch {}
    destroyJobTransport(reportRun);
    log.info(`分析 Session B 已关闭：${sid2}`);
  }

  if (reportRun.stopRequested) {
    throw new Error("已取消当前报告分析");
  }

  // 读取分析输出文件（Agent 已写入项目目录）
  const { reportPath, baselinePath } = getAnalysisOutputPaths(localPath);

  const markdown    = existsSync(reportPath)   ? readFileSync(reportPath,   "utf8") : null;
  const baselineJson = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : null;

  if (!markdown) throw new Error(`报告文件未生成：${reportPath}`);
  log.info(`报告文件已读取（${Math.round(markdown.length / 1024)}KB）`);
  appendReportLiveLog(reportRun, `\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 已生成报告文件并读取完成\n`);

  return { markdown, baselineJson };
}

// ─── 报告轮询 & 处理 ──────────────────────────────────────────────────────────

let _analysisRunning = false;
let activeReportRun = null;
let lastReportPollNotice = "";
let lastReportPollIdentity = null;
let lastReportPollIdentityAt = 0;

function logReportPollNotice(level, message) {
  if (!message || lastReportPollNotice === message) return;
  lastReportPollNotice = message;
  const logger = typeof log[level] === "function" ? log[level] : log.info;
  logger(message);
}

function clearReportPollNotice() {
  lastReportPollNotice = "";
}

async function fetchReportPollIdentity() {
  const now = Date.now();
  if (lastReportPollIdentity && now - lastReportPollIdentityAt < 60_000) {
    return lastReportPollIdentity;
  }

  try {
    const res = await backendRequest("GET", "/api/auth/me");
    if (res.status !== 200) {
      lastReportPollIdentity = null;
      lastReportPollIdentityAt = now;
      return null;
    }
    const profile = res.body?.data || res.body;
    const identity = profile?.userId || profile?.username || profile?.email || null;
    lastReportPollIdentity = typeof identity === "string" && identity.trim() ? identity.trim() : null;
    lastReportPollIdentityAt = now;
    return lastReportPollIdentity;
  } catch {
    lastReportPollIdentity = null;
    lastReportPollIdentityAt = now;
    return null;
  }
}

async function pollAndProcessReports() {
  if (_analysisRunning) return;
  if (!CONFIG.backendToken && !existsSync(BRIDGE_AUTH_FILE)) {
    logReportPollNotice("warn", "报告轮询跳过：Bridge 尚未拿到后端认证，请确认 Electron 已登录并同步 bridge-auth.txt，或显式配置 SYSBUILDER_TOKEN");
    return;
  }

  let pending;
  try {
    const res = await backendRequest("GET", "/api/reports/pending");
    if (res.status !== 200) {
      logReportPollNotice("warn", `报告轮询跳过：读取 /api/reports/pending 失败（HTTP ${res.status}）`);
      return;
    }
    pending = Array.isArray(res.body?.data)
      ? res.body.data
      : Array.isArray(res.body)
        ? res.body
        : [];
  } catch (err) {
    logReportPollNotice("warn", `报告轮询跳过：后端不可达（${err?.message || String(err)}）`);
    return;
  }

  clearReportPollNotice();

  if (!pending.length) {
    const identity = await fetchReportPollIdentity();
    logReportPollNotice(
      "info",
      identity
        ? `报告轮询在线：当前 Bridge 认证用户为 ${identity}，暂未发现该用户的待处理报告`
        : "报告轮询在线：已连接后端，但暂未发现待处理报告",
    );
    return;
  }

  clearReportPollNotice();

  const { reportId, projectId, title, requestContext } = pending[0];
  let ctx = {};
  try { ctx = JSON.parse(requestContext || "{}"); } catch {}
  const promptOverride = normalizePromptOverride(ctx.promptOverride);
  const reportRouteKey = buildChatRouteKey(ctx.userId, projectId);
  const reportNotifyChatId = reportRouteKey ? resolveTaskChat(reportRouteKey) : null;
  const localPath = ctx.localPath
    || (typeof ctx.repoUrl === "string" && /^[A-Za-z]:[\\/]/.test(ctx.repoUrl) ? ctx.repoUrl : "");

  if (!localPath) {
    const failMessage = "缺少可用的本地项目路径（localPath）。请在桌面端为项目选择本地路径后重新创建分析任务。";
    log.warn(`报告 ${reportId} 无 localPath，已标记失败`);
    try {
      await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`, {
        status: "FAILED",
        reportMarkdown: `## 分析未启动\n\n${failMessage}`,
      });
    } catch (updateErr) {
      log.error(`报告 ${reportId} 标记失败时出错：${updateErr?.message || String(updateErr)}`);
    }
    notifyLark(`❌ 项目 ${title || projectId} 分析未启动：${failMessage}`, reportNotifyChatId);
    return;
  }

  _analysisRunning = true;
  const projectName = localPath.split(/[\\/]/).pop();
  log.info(`🔍 开始处理报告：${title || reportId}（${projectName}）`);
  notifyLark(`🔍 开始分析项目：${projectName}，请稍候...`, reportNotifyChatId);
  appendReportLiveLog(activeReportRun, `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] Bridge 已接管报告分析：${title || reportId}\n`);

  try {
    // 标记为 RUNNING
    await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`,
      { status: "RUNNING" });

    let markdown = "", baselineJson = null;
    let status = "COMPLETED";
    try {
      ({ markdown, baselineJson } = await runAnalysisSession(localPath, { reportId, projectId, promptOverride }));
    } catch (err) {
      log.error(`分析失败：${err.message}`);
      status = "FAILED";
      markdown = `## 分析失败\n\n${err.message}`;
      updateReportRun(activeReportRun, { status: "failed", error: err.message });
      appendReportLiveLog(activeReportRun, `\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 分析失败：${err.message}\n`);
    }

    const submitBody = { reportMarkdown: markdown, status };
    if (baselineJson) submitBody.baselineJson = baselineJson;
    await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`, submitBody);

    const ok = status === "COMPLETED";
    log.info(`报告 ${reportId} 处理完成，状态：${status}`);
    if (ok) appendReportLiveLog(activeReportRun, `\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 报告已提交到 SysBuilder\n`);
    notifyLark(ok
      ? `✅ 项目 ${projectName} 分析完成，报告已上传，请前往 SysBuilder 查看`
      : `❌ 项目 ${projectName} 分析失败，请检查日志`, reportNotifyChatId);
  } catch (err) {
    log.error(`报告处理出错：${err.message}`);
    updateReportRun(activeReportRun, { status: "failed", error: err.message });
    appendReportLiveLog(activeReportRun, `\n[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 报告处理出错：${err.message}\n`);
    try {
      await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`,
        { status: "FAILED", reportMarkdown: `## 处理出错\n\n${err.message}` });
    } catch {}
  } finally {
    if (activeReportRun?.reportId === reportId) activeReportRun = null;
    _analysisRunning = false;
  }
}

// ─── 飞书事件订阅 ──────────────────────────────────────────────────────────────

function subscribeLarkEvents(onEvent) {
  log.info("启动飞书事件订阅...");
  const proc = spawn(
    LARK_CLI.path,
    [...(LARK_CLI.argsPrefix || []), ...withLarkCliIdentity(["event", "+subscribe", "--event-types", "im.message.receive_v1", "--compact", "--quiet"])],
    { stdio: ["ignore", "pipe", "pipe"], shell: LARK_CLI.useShell, windowsHide: true }
  );

  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { onEvent(JSON.parse(trimmed)); }
      catch { log.warn(`无法解析事件：${trimmed}`); }
    }
  });

  proc.stderr.on("data", (c) => { const m = c.toString().trim(); if (m) log.warn(`lark-cli stderr: ${m}`); });
  proc.on("error", (err) => { log.error(`lark-cli 启动失败：${err.message}`); process.exit(1); });
  proc.on("close", (code) => {
    log.error(`lark-cli 退出 code=${code}，3 秒后重启...`);
    setTimeout(() => subscribeLarkEvents(onEvent), 3000);
  });
}

// ─── 消息处理队列 ──────────────────────────────────────────────────────────────

class MessageQueue {
  constructor() { this._queue = []; this._processing = false; }
  enqueue(fn) { this._queue.push(fn); if (!this._processing) this._drain(); }
  clear() { this._queue.length = 0; log.info("消息队列已清空"); }
  async _drain() {
    this._processing = true;
    while (this._queue.length > 0) {
      try { await this._queue.shift()(); }
      catch (err) { log.error(`处理消息出错：${err?.message || err?.stack || JSON.stringify(err)}`); }
    }
    this._processing = false;
  }
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  log.info("=== Lark → Copilot ACP Bridge 启动 ===");
  log.info(`工作目录：${CONFIG.cwd}`);

  let connection, client;
  for (let i = 1; i <= CONFIG.maxRetries; i++) {
    try { ({ connection, client } = await connectToACP()); break; }
    catch (err) {
      log.error(`ACP 连接失败（${i}/${CONFIG.maxRetries}）：${err?.message || JSON.stringify(err)}`);
      if (i === CONFIG.maxRetries) { log.error("请先运行 ./start-copilot-acp.sh"); process.exit(1); }
      await sleep(2000);
    }
  }

  let sessionId;
  try {
    sessionId = await ensureSession(connection);
  } catch (err) {
    if (err.stale) {
      log.info("重新连接 ACP 以创建新会话...");
      for (let i = 1; i <= CONFIG.maxRetries; i++) {
        try { ({ connection, client } = await connectToACP()); break; }
        catch (e) {
          if (i === CONFIG.maxRetries) { log.error(`重连失败：${e.message}`); process.exit(1); }
          await sleep(2000);
        }
      }
      sessionId = await ensureSession(connection);
    } else {
      log.error(`致命错误：${err?.message}`); process.exit(1);
    }
  }
  const queue = new MessageQueue();

  subscribeLarkEvents(async (event) => {
    if (event.type !== "im.message.receive_v1") return;
    if (!event.message_id) return;

    // 解析消息内容
    let msgText = "";
    try {
      const content = JSON.parse(event.content || "{}");
      msgText = content.text || content.title || JSON.stringify(content);
    } catch { msgText = event.content || ""; }
    // 去掉 @提及 标签（如 <at user_id="...">大波龙</at>）
    msgText = msgText.replace(/<at[^>]*>.*?<\/at>/g, "").replace(/@\S+/g, "").trim();
    const preview = msgText.length > 60 ? msgText.slice(0, 60) + "…" : msgText;
    const sender = event.sender_id ? `ou:${event.sender_id.slice(-6)}` : "unknown";
    const controlCommand = parseControlCommand(msgText);

    log.event(`收到消息 [${event.chat_type}] ${sender} → "${preview}"`);

    // 追踪最近活跃的群聊 ID，用于主动推送通知
    if (event.chat_id) {
      lastChatId = event.chat_id;
      lastChatIdSource = "event";
      persistLastChatId(lastChatId);
      const senderRouteKey = buildChatRouteKey(event.sender_id, "");
      if (senderRouteKey) persistChatRoute(senderRouteKey, lastChatId);
    }

    const matchedTicket = findTicketForAnswer(msgText);
    if (matchedTicket) {
      queue.enqueue(async () => {
        log.info(`收到问题 ${matchedTicket.ticketId} 的用户答复，准备恢复分析...`);
        try {
          notifyLark(`✅ 已收到 [${matchedTicket.ticketId}] 的答复，继续处理中...`, matchedTicket.chatId);
          if (matchedTicket.jobKind === "storymap-sync") {
            await resumeStoryMapSync(matchedTicket, msgText);
          } else {
            await resumeRefactorAnalysis(matchedTicket, msgText);
          }
        } catch (err) {
          log.error(`恢复分析失败：${err.message}`);
          notifyLark(`❌ 恢复分析失败：${err.message}`, matchedTicket.chatId);
        }
      });
      return;
    }

    // ── 特殊控制指令（不转发给 ACP）──────────────────────────────────────────
    if (controlCommand === "!status") {
      const lines = _logBuffer.slice(-10);
      const statusText = ["📋 Bridge 最近日志：", ...lines].join("\n");
      try {
        execLarkCli(["im", "+messages-reply", "--message-id", event.message_id, "--text", statusText]);
        log.info(`!status 已回复`);
      } catch (e) {
        log.error(`!status 回复失败：${e.message}`);
      }
      return;
    }

    if (controlCommand === "!stop") {
      queue.clear();
      const reason = "已被用户通过 !stop 中止";
      const { stoppedJobs, clearedTickets, stoppedReportRuns } = await stopAllAnalysisJobs(reason);
      try {
        await connection.cancel({ sessionId });
        log.info(`!stop：已发送 cancel 信令到主 ACP 会话`);
      } catch (e) { log.warn(`!stop cancel 失败（可能无进行中操作）：${e.message}`); }
      try {
        execLarkCli([
          "im",
          "+messages-reply",
          "--message-id",
          event.message_id,
          "--text",
          `🛑 已中止所有会话：主会话已取消，任务会话 ${stoppedJobs} 个，报告会话 ${stoppedReportRuns} 个，清理待答复问题 ${clearedTickets} 个`,
        ]);
      } catch (e) { log.error(`!stop 回复失败：${e.message}`); }
      return;
    }

    // 将原始事件 JSON 转发给 Copilot，由 Agent 自行处理并用 lark-im 回复
    queue.enqueue(async () => {
      log.info("转发原始事件给 Copilot...");
      const rawJson = JSON.stringify(event, null, 2);
      const reply = await sendToACP(connection, client, sessionId, rawJson);
      // reply 是 Copilot 的日志性文字（已通过 lark-im 回复飞书），仅记录不转发
      if (reply) log.info(`Copilot 处理完成：${reply.slice(0, 300)}`);
    });
  });

  log.info("[Bridge] Ready. 正在监听飞书消息...");
  createHttpServer();

  // 启动报告轮询（每隔 pollIntervalMs 检查一次待处理分析任务）
  if (CONFIG.backendUrl) {
    log.info(`[Bridge] 报告轮询已启动（间隔 ${CONFIG.pollIntervalMs / 1000}s，后端：${CONFIG.backendUrl}）`);
    setInterval(pollAndProcessReports, CONFIG.pollIntervalMs);
    // 启动后稍等再首次轮询（等 ACP session 稳定）
    setTimeout(pollAndProcessReports, 5000);
  }
}

main().catch((err) => { log.error("致命错误：", err?.message || err?.stack || JSON.stringify(err)); process.exit(1); });
