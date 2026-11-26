// 讀取「只存在這台 Mac」的 AI 對話紀錄：Claude Code、Codex、Gemini CLI 自己保存在本機的 session 檔。
// 只列出小精靈開的對話（工作資料夾是小精靈自己的那幾個），不會碰你在其他專案裡的 session。
// 只讀不寫：刪除與保留期限都交給各工具自己管理，這裡只標出「多久後會被刪掉」。
import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 40 * 1024 * 1024; // 太大的檔案不讀（避免卡住）

export const TOOL_INFO = {
  claude: { targetId: 'claude-cli', name: 'Claude Code' },
  codex: { targetId: 'codex-cli', name: 'Codex' },
  gemini: { targetId: 'gemini-cli', name: 'Gemini CLI' },
};

/** 從小精靈組出來的提問文字裡取出「我的問題」；其他格式就取前面一段 */
export function extractQuestion(text = '') {
  const marker = text.lastIndexOf('【我的問題】');
  const question = marker >= 0 ? text.slice(marker + '【我的問題】'.length) : text;
  return question.replace(/\n*附圖：@\S+\s*$/, '').trim(); // Gemini 會在最後加上附圖檔名
}

/** "30d"、"7d"、"24h"、"1w" → 毫秒 */
export function parseDuration(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([hdwm])$/i.exec(String(value || '').trim());
  if (!match) return undefined;
  const unit = { h: 3600_000, d: DAY, w: 7 * DAY, m: 30 * DAY }[match[2].toLowerCase()];
  return Number(match[1]) * unit;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
}

async function readHead(path, bytes = 64 * 1024) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listFiles(dir, test) {
  try { return (await readdir(dir)).filter(test).map((name) => join(dir, name)); } catch { return []; }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.type === 'text' || part?.text ? part.text || '' : '')).join('');
}

function summarize(tool, { sessionId, path, messages, createdAt, updatedAt, expiresAt, retention }) {
  const firstUser = messages.find((message) => message.role === 'user');
  return {
    id: `${tool}:${sessionId}`,
    origin: tool,
    targetId: TOOL_INFO[tool].targetId,
    targetLabel: TOOL_INFO[tool].name,
    sessionId,
    path,
    title: firstUser?.text?.slice(0, 200) || '（沒有文字問題）',
    searchText: messages.map((message) => message.text).join('\n').slice(0, 6000),
    messageCount: messages.length,
    createdAt,
    updatedAt,
    expiresAt,
    retention,
  };
}

// ── Claude Code：~/.claude/projects/<工作資料夾，非英數字換成 -> /<session>.jsonl；預設 30 天（cleanupPeriodDays）後刪除 ──
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function parseClaudeTranscript(raw) {
  const messages = [];
  let createdAt;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!createdAt && entry.timestamp) createdAt = entry.timestamp;
    if (entry.isMeta || entry.isSidechain) continue;
    const content = entry.message?.content;
    if (entry.type === 'user') {
      if (Array.isArray(content) && content.some((part) => part?.type === 'tool_result')) continue;
      const text = extractQuestion(textOf(content));
      const image = Array.isArray(content) ? content.find((part) => part?.type === 'image' && part.source?.type === 'base64') : undefined;
      if (!text && !image) continue;
      messages.push({
        role: 'user',
        text,
        ...(image && image.source.data.length < 12_000_000 ? { imageDataUrl: `data:${image.source.media_type || 'image/png'};base64,${image.source.data}` } : {}),
      });
    } else if (entry.type === 'assistant') {
      const text = textOf(content);
      if (!text) continue;
      const id = entry.message?.id;
      const last = messages[messages.length - 1];
      // 同一則回覆可能分成好幾行存：用 message.id 合併
      if (last?.role === 'assistant' && id && last.messageId === id) last.text += text;
      else if (last?.role === 'assistant' && !id) last.text += `\n${text}`;
      else messages.push({ role: 'assistant', text, messageId: id });
    }
  }
  return { messages: messages.map(({ messageId, ...rest }) => rest), createdAt };
}

async function claudeRetentionDays(configDir) {
  const settings = await readJson(join(configDir, 'settings.json'));
  const days = Number(settings?.cleanupPeriodDays);
  return Number.isFinite(days) && days >= 1 ? days : 30;
}

async function listClaude({ cwd, configDir }) {
  const projects = join(configDir, 'projects');
  const wanted = claudeProjectDirName(cwd);
  let dirs = [join(projects, wanted)];
  try {
    const all = await readdir(projects);
    const tail = claudeProjectDirName(basename(cwd));
    dirs = [...new Set([...dirs, ...all.filter((name) => name.endsWith(`-${tail}`)).map((name) => join(projects, name))])];
  } catch { return []; }
  const days = await claudeRetentionDays(configDir);
  const results = [];
  for (const dir of dirs) {
    for (const path of await listFiles(dir, (name) => /^[0-9a-f-]{36}\.jsonl$/i.test(name))) {
      try {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) continue;
        const { messages, createdAt } = parseClaudeTranscript(await readFile(path, 'utf8'));
        if (!messages.length) continue;
        results.push(summarize('claude', {
          sessionId: basename(path, '.jsonl'),
          path,
          messages,
          createdAt: createdAt || info.birthtime.toISOString(),
          updatedAt: info.mtime.toISOString(),
          expiresAt: new Date(info.mtimeMs + days * DAY).toISOString(),
          retention: `Claude Code 會在最後一次對話的 ${days} 天後自動刪除`,
        }));
      } catch {}
    }
  }
  return results;
}

// ── Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl；第一行 session_meta 記錄工作資料夾；不會自動刪除 ──
export function parseCodexRollout(raw) {
  const fromEvents = [];
  const fromItems = [];
  let meta;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') meta = payload;
    else if (entry.type === 'event_msg' && payload.type === 'user_message' && payload.message) fromEvents.push({ role: 'user', text: extractQuestion(payload.message) });
    else if (entry.type === 'event_msg' && payload.type === 'agent_message' && payload.message) fromEvents.push({ role: 'assistant', text: payload.message });
    else if (entry.type === 'response_item' && payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
      const text = (payload.content || []).map((part) => part?.text || '').join('');
      if (!text || text.trimStart().startsWith('<')) continue; // 系統自動加的環境說明
      fromItems.push({ role: payload.role, text: payload.role === 'user' ? extractQuestion(text) : text });
    }
  }
  return { meta, messages: fromEvents.length ? fromEvents : fromItems };
}

async function walkCodex(dir, depth = 0, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) await walkCodex(path, depth + 1, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(path);
  }
  return out;
}

async function listCodex({ cwd, codexHome }) {
  const results = [];
  for (const path of await walkCodex(join(codexHome, 'sessions'))) {
    try {
      // 先只讀開頭判斷是不是小精靈的對話（其他專案的 session 可能很大，不整個讀）
      const firstLine = (await readHead(path)).split('\n')[0];
      const meta = JSON.parse(firstLine)?.payload;
      if (!meta || meta.cwd !== cwd) continue;
      const info = await stat(path);
      if (info.size > MAX_FILE_BYTES) continue;
      const { messages } = parseCodexRollout(await readFile(path, 'utf8'));
      if (!messages.length) continue;
      results.push(summarize('codex', {
        sessionId: meta.id || meta.session_id || basename(path, '.jsonl'),
        path,
        messages,
        createdAt: meta.timestamp || info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
        expiresAt: null,
        retention: 'Codex 不會自動刪除（存在 ~/.codex/sessions）',
      }));
    } catch {}
  }
  return results;
}

// ── Gemini CLI：~/.gemini/tmp/<專案代碼>/chats/session-*.json；預設 30 天後刪除（general.sessionRetention） ──
export function parseGeminiChat(raw) {
  let data;
  const messages = [];
  try { data = JSON.parse(raw); } catch {
    // 新版可能一行一筆
    data = { messages: raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean) };
  }
  for (const item of data?.messages || []) {
    const text = textOf(item.content ?? item.parts);
    if (!text) continue;
    if (item.type === 'user') messages.push({ role: 'user', text: extractQuestion(text) });
    else if (item.type === 'gemini' || item.type === 'model') messages.push({ role: 'assistant', text });
  }
  return { sessionId: data?.sessionId, startTime: data?.startTime, lastUpdated: data?.lastUpdated, messages };
}

async function geminiRetentionMs(geminiHome) {
  const settings = await readJson(join(geminiHome, 'settings.json'));
  const retention = settings?.general?.sessionRetention;
  if (retention?.enabled === false) return null;
  return parseDuration(retention?.maxAge) ?? 30 * DAY;
}

async function listGemini({ cwd, geminiHome }) {
  const tmp = join(geminiHome, 'tmp');
  const dirs = new Set([join(tmp, createHash('sha256').update(cwd).digest('hex'))]);
  try {
    for (const name of await readdir(tmp)) {
      const root = await readFile(join(tmp, name, '.project_root'), 'utf8').catch(() => '');
      if (root.trim() === cwd) dirs.add(join(tmp, name));
    }
  } catch { return []; }
  const retentionMs = await geminiRetentionMs(geminiHome);
  const results = [];
  for (const dir of dirs) {
    for (const path of await listFiles(join(dir, 'chats'), (name) => /^session-.*\.jsonl?$/.test(name))) {
      try {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) continue;
        const chat = parseGeminiChat(await readFile(path, 'utf8'));
        if (!chat.messages.length) continue;
        const updated = Date.parse(chat.lastUpdated) || info.mtimeMs;
        results.push(summarize('gemini', {
          sessionId: chat.sessionId || basename(path).replace(/\.jsonl?$/, ''),
          path,
          messages: chat.messages,
          createdAt: chat.startTime || info.birthtime.toISOString(),
          updatedAt: new Date(updated).toISOString(),
          expiresAt: retentionMs ? new Date(updated + retentionMs).toISOString() : null,
          retention: retentionMs ? `Gemini CLI 會在最後一次對話的 ${Math.round(retentionMs / DAY)} 天後自動刪除` : 'Gemini CLI 已關閉自動清除',
        }));
      } catch {}
    }
  }
  return results;
}

/**
 * 列出小精靈在各 CLI 裡開過的對話。
 * @param {{ workspaces: { claude?: string, codex?: string, gemini?: string }, home?: string, env?: object }} options
 */
export async function listLocalSessions({ workspaces, home = homedir(), env = process.env }) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const geminiHome = join(home, '.gemini');
  const lists = await Promise.all([
    workspaces.claude ? listClaude({ cwd: workspaces.claude, configDir: claudeDir }) : [],
    workspaces.codex ? listCodex({ cwd: workspaces.codex, codexHome }) : [],
    workspaces.gemini ? listGemini({ cwd: workspaces.gemini, geminiHome }) : [],
  ]);
  return lists.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** 讀一段對話的全部訊息（打開或接著問時用） */
export async function loadLocalSession(entry) {
  const raw = await readFile(entry.path, 'utf8');
  if (entry.origin === 'claude') return parseClaudeTranscript(raw).messages;
  if (entry.origin === 'codex') return parseCodexRollout(raw).messages;
  return parseGeminiChat(raw).messages;
}
