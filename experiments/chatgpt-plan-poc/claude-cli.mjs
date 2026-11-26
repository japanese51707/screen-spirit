// 模式二：用 Claude Code 指令（claude -p）在背景提問，回覆邊產生邊顯示在小精靈對話框。
// 使用你登入 Claude Code 的帳號（Pro 額度）；啟動時會移除 ANTHROPIC_API_KEY，避免改走另外計費的 API。
// 圖片以 stream-json 格式從標準輸入直接送入，不寫成檔案；追問用 --resume 接續同一個 session。
import { execFile, spawn } from 'node:child_process';
import { access, constants, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findWindowsCli, IS_WINDOWS, spawnCli } from './cli-path.mjs';

const SYSTEM_PROMPT = [
  '你是「螢幕小精靈」的回答助理。使用者會附上螢幕圈選的圖片或複製的文字，以及畫面脈絡（來源程式）。',
  '請直接回答使用者的問題，使用繁體中文，除非使用者用其他語言提問。',
  '不要讀寫或修改任何檔案，也不要執行指令；只根據提供的內容回答。',
].join('\n');

let cachedBinary;

export async function findClaudeCli() {
  if (cachedBinary) return cachedBinary;
  if (IS_WINDOWS) {
    const path = await findWindowsCli('claude');
    if (!path) throw new Error('找不到 Claude Code（claude 指令）。請先安裝並登入：https://docs.claude.com/en/docs/claude-code/setup');
    cachedBinary = path;
    return path;
  }
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      cachedBinary = candidate;
      return candidate;
    } catch {}
  }
  // 從 App 啟動時 PATH 很短，改問使用者的登入 shell
  const fromShell = await new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 8000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
  });
  if (fromShell && fromShell.startsWith('/')) {
    cachedBinary = fromShell;
    return fromShell;
  }
  throw new Error('找不到 Claude Code（claude 指令）。請先安裝並登入：https://claude.com/claude-code');
}

/** 解析 stream-json 的每一行；把文字增量交給 onDelta。可獨立測試。 */
export function createStreamParser({ onDelta = () => {} } = {}) {
  const state = { sessionId: '', text: '', streamed: false, result: undefined, error: '' };
  return {
    state,
    line(raw) {
      if (!raw.trim()) return;
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      if (event.session_id) state.sessionId = event.session_id;
      if (event.type === 'stream_event') {
        const inner = event.event;
        if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
          state.streamed = true;
          state.text += inner.delta.text;
          onDelta(inner.delta.text);
        }
      } else if (event.type === 'assistant' && !state.streamed) {
        // 沒有逐字串流時，整段訊息一次到
        const text = (event.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
        if (text) {
          const addition = state.text ? `\n\n${text}` : text;
          state.text += addition;
          onDelta(addition);
        }
      } else if (event.type === 'result') {
        state.result = event;
        if (event.is_error) state.error = typeof event.result === 'string' ? event.result : (event.subtype || 'error');
      }
    },
  };
}

/**
 * 問一次（第一次或追問）。
 * @returns {Promise<{ text: string, sessionId: string }>}
 */
export async function askClaudeCli({ prompt, imagePngBase64, sessionId, cwd, onDelta, signal, log = () => {}, partialMessages = true, binary: binaryOverride, instructions, addDirs = [], timeoutMs = 5 * 60 * 1000 }) {
  const binary = binaryOverride || await findClaudeCli();
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', instructions || SYSTEM_PROMPT];
  // 精靈的資料庫：開放讀取（只有讀取類工具不需要同意；寫入在 -p 模式會被拒絕）
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (partialMessages) args.push('--include-partial-messages');
  if (sessionId) args.push('--resume', sessionId);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // 走登入帳號（Pro）額度
  log(`  啟動 Claude Code：${binary}${sessionId ? '（追問）' : ''}`);

  const content = [];
  if (imagePngBase64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imagePngBase64 } });
  content.push({ type: 'text', text: prompt });
  const message = JSON.stringify({ type: 'user', message: { role: 'user', content } });

  return new Promise((resolve, reject) => {
    const child = spawnCli(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const parser = createStreamParser({ onDelta });
    let buffer = '';
    let stderr = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : undefined; // 0＝不限時間（工作流：等到做完或按停止）

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        parser.line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`無法啟動 Claude Code：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (buffer) parser.line(buffer);
      const { state } = parser;
      if (signal?.aborted) return resolve({ text: state.text, sessionId: state.sessionId, cancelled: true });
      if (partialMessages && code !== 0 && /unknown option.*include-partial-messages/i.test(stderr)) {
        log('  這個版本不支援逐字串流，改用整段回覆');
        return resolve(askClaudeCli({ prompt, imagePngBase64, sessionId, cwd, onDelta, signal, log, partialMessages: false, binary, instructions, addDirs }));
      }
      if (state.error || (code !== 0 && !state.text)) {
        const detail = (state.error || stderr || `結束代碼 ${code}`).trim().slice(0, 400);
        log(`  ✗ Claude Code 失敗：${detail}`);
        const hint = /login|log in|auth|credential|not logged/i.test(detail) ? '請先在終端機執行 claude 並登入。' : '';
        return reject(new Error(`Claude Code 回覆失敗：${detail} ${hint}`.trim()));
      }
      const finalText = typeof state.result?.result === 'string' && state.result.result.trim() ? state.result.result : state.text;
      log(`  ✓ Claude Code 回覆完成（${finalText.length} 字）`);
      resolve({ text: finalText, sessionId: state.sessionId });
    });

    child.stdin.end(`${message}\n`);
  });
}
