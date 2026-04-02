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
};

const SESSION_FILE = join(import.meta.dirname, ".acp-session-id");

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
}

main().catch((err) => { log.error("致命错误：", err?.message || err?.stack || JSON.stringify(err)); process.exit(1); });
