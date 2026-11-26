// 背景執行的 AI 指令列工具：Codex（OpenAI）、Gemini CLI（Google）。
// 共同做法：在小精靈自己的工作資料夾執行、只讀不寫，回覆邊產生邊顯示在小精靈對話框；追問用各自的 resume 接續同一個 session。
// 圖片：寫成暫存 PNG 放在工作資料夾（Codex 用 -i、Gemini 用 @檔名 引用），回覆完成後立即刪除。
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findWindowsCli, IS_WINDOWS, spawnCli } from './cli-path.mjs';

export const AGENT_INSTRUCTIONS = [
  '你是「螢幕小精靈」的回答助理。使用者會附上螢幕圈選的圖片或反白的文字，以及畫面脈絡（來源程式）。',
  '請直接回答使用者的問題，使用繁體中文，除非使用者用其他語言提問。',
  '不要讀寫或修改任何檔案，也不要執行指令；只根據提供的內容回答。',
].join('\n');

const found = new Map();

/** 找指令列工具的完整路徑：常見安裝位置 → 使用者的互動登入 shell（nvm、Homebrew 等設定在 .zshrc 裡） */
export async function findCli(name, extraCandidates = []) {
  if (found.has(name)) return found.get(name);
  if (IS_WINDOWS) {
    const path = await findWindowsCli(name, extraCandidates);
    if (path) found.set(name, path);
    return path;
  }
  const home = homedir();
  const candidates = [
    ...extraCandidates,
    join(home, '.local', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(home, '.npm-global', 'bin', name),
    join(home, '.bun', 'bin', name),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      found.set(name, candidate);
      return candidate;
    } catch {}
  }
  const fromShell = await new Promise((resolve) => {
    execFile('/bin/zsh', ['-ilc', `command -v ${name}`], { timeout: 8000 }, (error, stdout) => {
      const line = String(stdout || '').split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('/'));
      resolve(error && !line ? '' : line || '');
    });
  });
  if (fromShell) {
    found.set(name, fromShell);
    return fromShell;
  }
  return '';
}

function runJsonLines({ binary, args, cwd, onEvent, signal, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(binary, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : undefined; // 0＝不限時間
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (buffer.trim()) { try { onEvent(JSON.parse(buffer.trim())); } catch {} }
      resolve({ code, stderr, aborted: Boolean(signal?.aborted) });
    });
  });
}

async function withTempImage(cwd, imagePng, action) {
  if (!imagePng) return action(undefined);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const name = `screen-spirit-${randomUUID()}.png`;
  const file = join(cwd, name);
  await writeFile(file, imagePng, { mode: 0o600 });
  try {
    return await action({ file, name });
  } finally {
    await unlink(file).catch(() => {});
  }
}

// ── Codex（OpenAI）：codex exec --json；追問 codex exec resume <id> ──

/** 解析 codex exec --json 的事件（可獨立測試） */
export function createCodexParser({ onDelta = () => {} } = {}) {
  const state = { sessionId: '', text: '', error: '' };
  return {
    state,
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'thread.started' && event.thread_id) state.sessionId = event.thread_id;
      if (event.session_id && !state.sessionId) state.sessionId = event.session_id;
      if (event.type === 'item.completed' || event.type === 'item.updated') {
        const item = event.item || {};
        const type = item.type || item.item_type;
        if (type === 'agent_message' || type === 'assistant_message') {
          const text = String(item.text ?? item.content ?? '');
          if (event.type === 'item.completed' && text) {
            const addition = state.text ? `\n\n${text}` : text;
            state.text += addition;
            onDelta(addition);
          }
        }
      }
      if (event.type === 'turn.failed') state.error = event.error?.message || 'Codex 回覆失敗';
      if (event.type === 'error' && event.message) state.error = event.message;
    },
  };
}

export async function askCodex({ binary, prompt, imagePng, sessionId, cwd, onDelta, signal, log = () => {}, instructions, timeoutMs }) {
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return withTempImage(cwd, imagePng, async (image) => {
    const common = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...(image ? ['-i', image.file] : [])];
    const fullPrompt = sessionId ? prompt : `${instructions || AGENT_INSTRUCTIONS}\n\n${prompt}`; // Codex 唯讀模式本來就能讀檔案
    const args = sessionId ? ['exec', 'resume', sessionId, ...common, fullPrompt] : ['exec', ...common, '-C', cwd, fullPrompt];
    log(`  啟動 Codex：${binary}${sessionId ? '（追問）' : ''}${image ? '，附圖片' : ''}`);
    const parser = createCodexParser({ onDelta });
    const { code, stderr, aborted } = await runJsonLines({ binary, args, cwd, onEvent: parser.event, signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    if (aborted) return { text: parser.state.text, sessionId: parser.state.sessionId || sessionId, cancelled: true };
    if (parser.state.error || (code !== 0 && !parser.state.text)) {
      const detail = (parser.state.error || stderr || `結束代碼 ${code}`).trim().slice(0, 400);
      log(`  ✗ Codex 失敗：${detail}`);
      const hint = /login|auth|unauthori|not logged|sign in/i.test(detail) ? '請先在終端機執行 codex 並登入。' : '';
      throw new Error(`Codex 回覆失敗：${detail} ${hint}`.trim());
    }
    log(`  ✓ Codex 回覆完成（${parser.state.text.length} 字）`);
    return { text: parser.state.text, sessionId: parser.state.sessionId || sessionId };
  });
}

// ── Gemini CLI（Google）：gemini -p --output-format stream-json；追問 --resume <id> ──

export function createGeminiParser({ onDelta = () => {} } = {}) {
  const state = { sessionId: '', text: '', error: '' };
  return {
    state,
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.session_id) state.sessionId = event.session_id;
      if (event.type === 'message' && (event.role === 'assistant' || event.role === 'model')) {
        const content = typeof event.content === 'string' ? event.content : '';
        if (!content) return;
        const addition = event.delta || !state.text ? content : `\n\n${content}`;
        state.text += addition;
        onDelta(addition);
      }
      if (event.type === 'error' && (event.severity === 'error' || event.fatal)) state.error = event.message || 'Gemini 回覆失敗';
      if (event.type === 'result' && (event.status === 'error' || event.error)) state.error = event.error?.message || event.error || 'Gemini 回覆失敗';
    },
  };
}

export async function askGemini({ binary, prompt, imagePng, sessionId, cwd, onDelta, signal, log = () => {}, instructions, addDirs = [], timeoutMs }) {
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return withTempImage(cwd, imagePng, async (image) => {
    const body = sessionId ? prompt : `${instructions || AGENT_INSTRUCTIONS}\n\n${prompt}`;
    const fullPrompt = image ? `${body}\n\n附圖：@${image.name}` : body;
    const args = ['--output-format', 'stream-json', ...(sessionId ? ['--resume', sessionId] : []), ...(addDirs.length ? ['--include-directories', addDirs.join(',')] : []), '-p', fullPrompt];
    log(`  啟動 Gemini CLI：${binary}${sessionId ? '（追問）' : ''}${image ? '，附圖片' : ''}`);
    const parser = createGeminiParser({ onDelta });
    const { code, stderr, aborted } = await runJsonLines({ binary, args, cwd, onEvent: parser.event, signal, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    if (aborted) return { text: parser.state.text, sessionId: parser.state.sessionId || sessionId, cancelled: true };
    if (parser.state.error || (code !== 0 && !parser.state.text)) {
      const detail = (parser.state.error || stderr || `結束代碼 ${code}`).trim().slice(0, 400);
      log(`  ✗ Gemini CLI 失敗：${detail}`);
      const hint = /auth|login|credential|sign in/i.test(detail) ? '請先在終端機執行 gemini 並登入。' : '';
      throw new Error(`Gemini CLI 回覆失敗：${detail} ${hint}`.trim());
    }
    log(`  ✓ Gemini CLI 回覆完成（${parser.state.text.length} 字）`);
    return { text: parser.state.text, sessionId: parser.state.sessionId || sessionId };
  });
}
