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
import { execSync, spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const CONFIG = {
  acpHost: "127.0.0.1",
  acpPort:  Number(process.env.ACP_PORT  || 3000),
  maxRetries: 3,
  cwd: process.env.BRIDGE_CWD || process.cwd(),
  // SysBuilder 后端集成（报告分析功能）
  backendUrl:      process.env.SYSBUILDER_BACKEND_URL || "http://47.79.4.19",
  backendToken:    process.env.SYSBUILDER_TOKEN       || "",
  backendCookie:   process.env.SYSBUILDER_COOKIE      || "",
  pollIntervalMs:  Number(process.env.POLL_INTERVAL_MS || 20000),
};

const SESSION_FILE    = join(import.meta.dirname, ".acp-session-id");
const BRIDGE_AUTH_FILE = join(homedir(), ".copilark", "bridge-auth.txt");

// ─── ACP Client ───────────────────────────────────────────────────────────────

let _streaming = false; // 是否正在流式输出 Copilot 回复

// ─── 日志环形缓冲 & 控制指令 ──────────────────────────────────────────────────

const _logBuffer = [];       // 最近 N 行日志
const LOG_BUFFER_SIZE = 20;

function bufferLog(line) {
  _logBuffer.push(line);
  if (_logBuffer.length > LOG_BUFFER_SIZE) _logBuffer.shift();
}

// 在打印 log 前确保换行（避免与流式输出混排）
const log = {
  info:  (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = `[Bridge][INFO]  ${a.join(" ")}`; bufferLog(l); console.log(l); },
  warn:  (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = `[Bridge][WARN]  ${a.join(" ")}`; bufferLog(l); console.warn(l); },
  error: (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = `[Bridge][ERROR] ${a.join(" ")}`; bufferLog(l); console.error(l); },
  event: (...a) => { if (_streaming) { process.stdout.write("\x1b[0m\n"); _streaming = false; } const l = `[Bridge][EVENT] ${a.join(" ")}`; bufferLog(l); console.log(l); },
};

// ─── lastChatId（报告完成通知目标群）─────────────────────────────────────────

let lastChatId = null; // 每次收到飞书事件时更新，用于主动推送 Lark 通知

// ─── 后端 HTTP 工具 ───────────────────────────────────────────────────────────

function backendRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const full = new URL(CONFIG.backendUrl + urlPath);
    const mod  = full.protocol === "https:" ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;

    // 认证优先级：Bearer token > Cookie（均可从 .env.local 配置）
    let authHeader = {};
    if (CONFIG.backendToken) {
      authHeader = { Authorization: `Bearer ${CONFIG.backendToken}` };
    } else if (CONFIG.backendCookie) {
      authHeader = { Cookie: CONFIG.backendCookie };
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

function notifyLark(text) {
  if (!lastChatId) { log.warn("notifyLark: 尚无 chat_id，跳过通知"); return; }
  const safeText = text.replace(/"/g, '\\"').replace(/\n/g, " ");
  try {
    execSync(
      `lark-cli im +messages-send --chat-id ${lastChatId} --text "${safeText}"`,
      { shell: process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : true }
    );
    log.info(`Lark 通知已发送到 ${lastChatId}：${text.slice(0, 80)}`);
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
        resolve({ connection, client });
      } catch (err) { reject(err); }
    });
    socket.on("error", reject);
  });
}

async function ensureSession(connection) {
  if (acpSessionId) {
    log.info(`恢复已有 ACP 会话：${acpSessionId}`);
    return acpSessionId;
  }

  // 尝试从文件恢复上次的 session ID
  if (existsSync(SESSION_FILE)) {
    const savedId = readFileSync(SESSION_FILE, "utf8").trim();
    if (savedId) {
      try {
        await connection.loadSession({ sessionId: savedId, cwd: CONFIG.cwd, mcpServers: [] });
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
  const result = await connection.newSession({ cwd: CONFIG.cwd, mcpServers: [] });
  acpSessionId = result.sessionId;
  writeFileSync(SESSION_FILE, acpSessionId, "utf8");
  log.info(`创建新 ACP 会话：${acpSessionId}  (cwd: ${CONFIG.cwd})`);
  return acpSessionId;
}

async function sendToACP(connection, client, sessionId, text) {
  const collector = new MessageCollector();
  client._activeCollector = collector;
  await connection.prompt({ sessionId, prompt: [{ type: "text", text }] });
  return collector.getText();
}

// ─── ACP Client ───────────────────────────────────────────────────────────────

class BridgeAcpClient {
  constructor() { this._activeCollector = null; }

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
        break;
      case "tool_call_update":
        log.info(`  ✅ [${u.status}] ${u.toolCallId}`);
        if (u.output) log.info(`      输出: ${String(u.output).slice(0, 200)}`);
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") {
          if (!_streaming) { process.stdout.write("\x1b[2m"); _streaming = true; } // 暗色开始
          process.stdout.write(u.content.text);
        }
        break;
      case "plan":
        log.info(`  📋 计划: ${JSON.stringify(u).slice(0, 200)}`);
        break;
      default:
        break;
    }
  }

  async writeTextFile(params) { log.warn(`writeTextFile: ${params.path}`); return {}; }
  async readTextFile(params)  { log.warn(`readTextFile: ${params.path}`);  return { content: "" }; }
}

class MessageCollector {
  constructor() { this._parts = []; }
  push(text) { this._parts.push(text); }
  getText() { return this._parts.join("").trim(); }
}

// ─── 分析任务：临时 ACP Session B ────────────────────────────────────────────

async function runAnalysisSession(localPath) {
  log.info(`创建分析 Session B（cwd: ${localPath}）...`);
  let conn2, client2;
  for (let i = 1; i <= CONFIG.maxRetries; i++) {
    try { ({ connection: conn2, client: client2 } = await connectToACP()); break; }
    catch (err) {
      if (i === CONFIG.maxRetries) throw new Error(`Session B 连接失败：${err.message}`);
      await sleep(2000);
    }
  }

  const { sessionId: sid2 } = await conn2.newSession({ cwd: localPath, mcpServers: [] });
  log.info(`分析 Session B 已创建：${sid2}`);

  // 构造 CARPM 分析提示词（Copilot 已知 carpm-analyzer skill，无需传路径）
  const prompt =
    `请调用 carpm-analyzer 对当前项目进行分析，` +
    `将报告保存至 docs/carpm-output/carpm-report.md，` +
    `将 JSON 基线保存至 docs/carpm-output/carpm-baseline.json，` +
    `全部完成后回复"CARPM 分析完成"。`;

  try {
    await sendToACP(conn2, client2, sid2, prompt);
  } finally {
    try { await conn2.closeSession({ sessionId: sid2 }); } catch {}
    log.info(`分析 Session B 已关闭：${sid2}`);
  }

  // 读取分析输出文件（Agent 已写入项目目录）
  const reportPath   = join(localPath, "docs", "carpm-output", "carpm-report.md");
  const baselinePath = join(localPath, "docs", "carpm-output", "carpm-baseline.json");

  const markdown    = existsSync(reportPath)   ? readFileSync(reportPath,   "utf8") : null;
  const baselineJson = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8") : null;

  if (!markdown) throw new Error(`报告文件未生成：${reportPath}`);
  log.info(`报告文件已读取（${Math.round(markdown.length / 1024)}KB）`);

  return { markdown, baselineJson };
}

// ─── 报告轮询 & 处理 ──────────────────────────────────────────────────────────

let _analysisRunning = false;

async function pollAndProcessReports() {
  if (_analysisRunning) return;
  if (!CONFIG.backendToken && !CONFIG.backendCookie) {
    // 未配置任何认证凭据，静默跳过
    return;
  }

  let pending;
  try {
    const res = await backendRequest("GET", "/api/reports/pending");
    if (res.status !== 200) return; // 未登录或服务不可达，静默跳过
    pending = Array.isArray(res.body) ? res.body : [];
  } catch { return; } // 后端不可达，静默跳过

  if (!pending.length) return;

  const { reportId, projectId, title, requestContext } = pending[0];
  let ctx = {};
  try { ctx = JSON.parse(requestContext || "{}"); } catch {}
  const localPath = ctx.localPath;

  if (!localPath) {
    log.warn(`报告 ${reportId} 无 localPath，跳过`);
    return;
  }

  _analysisRunning = true;
  const projectName = localPath.split(/[\\/]/).pop();
  log.info(`🔍 开始处理报告：${title || reportId}（${projectName}）`);
  notifyLark(`🔍 开始分析项目：${projectName}，请稍候...`);

  try {
    // 标记为 RUNNING
    await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`,
      { status: "RUNNING" });

    let markdown = "", baselineJson = null;
    let status = "COMPLETED";
    try {
      ({ markdown, baselineJson } = await runAnalysisSession(localPath));
    } catch (err) {
      log.error(`分析失败：${err.message}`);
      status = "FAILED";
      markdown = `## 分析失败\n\n${err.message}`;
    }

    const submitBody = { reportMarkdown: markdown, status };
    if (baselineJson) submitBody.baselineJson = baselineJson;
    await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`, submitBody);

    const ok = status === "COMPLETED";
    log.info(`报告 ${reportId} 处理完成，状态：${status}`);
    notifyLark(ok
      ? `✅ 项目 ${projectName} 分析完成，报告已上传，请前往 SysBuilder 查看`
      : `❌ 项目 ${projectName} 分析失败，请检查日志`);
  } catch (err) {
    log.error(`报告处理出错：${err.message}`);
    try {
      await backendRequest("PUT", `/api/project/${projectId}/reports/${reportId}`,
        { status: "FAILED", reportMarkdown: `## 处理出错\n\n${err.message}` });
    } catch {}
  } finally {
    _analysisRunning = false;
  }
}

// ─── 飞书事件订阅 ──────────────────────────────────────────────────────────────

function subscribeLarkEvents(onEvent) {
  log.info("启动飞书事件订阅...");
  const proc = spawn(
    "lark-cli",
    ["event", "+subscribe", "--event-types", "im.message.receive_v1", "--compact", "--quiet"],
    { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" }
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

    log.event(`收到消息 [${event.chat_type}] ${sender} → "${preview}"`);

    // 追踪最近活跃的群聊 ID，用于主动推送通知
    if (event.chat_id) lastChatId = event.chat_id;

    // ── 特殊控制指令（不转发给 ACP）──────────────────────────────────────────
    const CMD_STATUS = "!status";
    const CMD_STOP   = "!stop";

    if (msgText === CMD_STATUS) {
      const lines = _logBuffer.slice(-10);
      // 构造 post 格式 JSON，每行独立段落，避免 md tag 把 \n 渲染成字面量 <br>
      const contentLines = [
        [{ tag: "text", text: "📋 Bridge 最近日志：" }],
        ...lines.map(l => [{ tag: "text", text: l }]),
      ];
      const postJson = JSON.stringify({ zh_cn: { content: contentLines } });
      const tmpFile = join(tmpdir(), `bridge-status-${Date.now()}.json`);
      try {
        writeFileSync(tmpFile, postJson, "utf8");
        const tmpUnix = tmpFile.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
        execSync(`lark-cli im +messages-reply --message-id ${event.message_id} --msg-type post --content "$(cat '${tmpUnix}')"`, { shell: "C:\\Program Files\\Git\\bin\\bash.exe" });
        log.info(`!status 已回复`);
      } catch (e) {
        log.error(`!status 回复失败：${e.message}`);
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }
      return;
    }

    if (msgText === CMD_STOP) {
      queue.clear();
      try {
        // session_cancel 是 ACP 协议的取消信令，通知 Copilot 停止当前 prompt，不关闭 session
        await connection.cancel({ sessionId });
        log.info(`!stop：已发送 cancel 信令到 ACP（session 保持）`);
      } catch (e) { log.warn(`!stop cancel 失败（可能无进行中操作）：${e.message}`); }
      try {
        execSync(`lark-cli im +messages-reply --message-id ${event.message_id} --text "🛑 已中止当前操作"`, { shell: true });
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

  // 启动报告轮询（每隔 pollIntervalMs 检查一次待处理分析任务）
  if (CONFIG.backendUrl) {
    log.info(`[Bridge] 报告轮询已启动（间隔 ${CONFIG.pollIntervalMs / 1000}s，后端：${CONFIG.backendUrl}）`);
    setInterval(pollAndProcessReports, CONFIG.pollIntervalMs);
    // 启动后稍等再首次轮询（等 ACP session 稳定）
    setTimeout(pollAndProcessReports, 5000);
  }
}

main().catch((err) => { log.error("致命错误：", err?.message || err?.stack || JSON.stringify(err)); process.exit(1); });
