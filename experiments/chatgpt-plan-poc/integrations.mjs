// 第一次使用時偵測「這台電腦上有哪些 AI 可以接」，並記下使用者同意連接哪些（integrations.json）。
// 只有「偵測到」而且「使用者同意」的才可以選；其他在選單裡反灰並註明原因。
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 小精靈支援的所有 AI（順序就是選單順序） */
export const CATALOG = [
  { id: 'claude-app', group: '桌面 App', detect: { app: 'Claude' }, note: '開啟 Claude 桌面版、貼上並送出；用你的 Claude 訂閱。需要「輔助使用」權限。', macOnly: true, install: { label: '下載 Claude 桌面版', url: 'https://claude.ai/download' } },
  { id: 'chatgpt-app', group: '桌面 App', detect: { app: 'ChatGPT' }, note: '開啟 ChatGPT 桌面版、貼上並送出；用你的 ChatGPT 方案。需要「輔助使用」權限。', macOnly: true, install: { label: '下載 ChatGPT 桌面版', url: 'https://openai.com/chatgpt/download/' } },
  { id: 'claude-cli', group: '背景執行（指令列）', detect: { cli: 'claude' }, note: '在背景執行 Claude Code，回覆顯示在小精靈；用你的 Claude 訂閱額度。', install: { label: '安裝 Claude Code', url: 'https://docs.claude.com/en/docs/claude-code/setup' } },
  { id: 'codex-cli', group: '背景執行（指令列）', detect: { cli: 'codex' }, note: '在背景執行 Codex（唯讀），回覆顯示在小精靈；用你的 ChatGPT 方案額度。', install: { label: '安裝 Codex CLI', url: 'https://github.com/openai/codex' } },
  { id: 'gemini-cli', group: '背景執行（指令列）', detect: { cli: 'gemini' }, note: '在背景執行 Gemini CLI，回覆顯示在小精靈；用你的 Google 帳號額度（免費方案可能已改成 Antigravity CLI）。', install: { label: '安裝 Gemini CLI', url: 'https://github.com/google-gemini/gemini-cli' } },
  { id: 'ollama', group: '本機模型', detect: { ollama: true }, note: '模型跑在這台電腦上，不用網路、不花錢，資料不離開電腦。', install: { label: '下載 Ollama', url: 'https://ollama.com/download' } },
  { id: 'mixroute', group: '雲端 API', detect: { always: true }, note: '一把金鑰可以用多家模型；按用量扣 MixRoute 點數。之後會請你輸入金鑰。', install: { label: '申請 MixRoute 金鑰', url: 'https://mixroute.ai' } },
  { id: 'chatgpt-web', group: '網頁', detect: { app: 'Google Chrome' }, note: '用 Chrome 開 chatgpt.com 新對話、貼上並送出。需要「輔助使用」權限。', macOnly: true, install: { label: '下載 Chrome', url: 'https://www.google.com/chrome/' } },
  { id: 'google-ai-mode', group: '網頁', detect: { app: 'Google Chrome' }, note: '用 Chrome 開 Google 搜尋的 AI 模式；只有文字時直接帶進網址開始回答，有圖片時貼上圖片與問題再送出。用你的 Google 帳號，免費。', macOnly: true, install: { label: '下載 Chrome', url: 'https://www.google.com/chrome/' } },
  { id: 'kiro', group: '實驗中', detect: { app: 'Kiro' }, note: '開啟 Kiro 的聊天面板貼上；快捷鍵還在調整。', macOnly: true },
  { id: 'hermes-app', group: '實驗中', detect: { app: 'Hermes' }, note: '開啟 Hermes App 貼上；快捷鍵還在調整。', macOnly: true },
  { id: 'builtin', group: '其他', detect: { always: true }, note: '最早的原型：登入 ChatGPT 帳號、授權方案用量後直接呼叫。' },
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

export async function findApp(name, roots = ['/Applications', join(homedir(), 'Applications')]) {
  if (process.platform !== 'darwin') return ''; // .app 只有 macOS 有
  for (const root of roots) {
    const path = join(root, `${name}.app`);
    if (await exists(path)) return path;
  }
  return '';
}

/**
 * 偵測每個 AI 的狀態。
 * @param deps.findCli (name) => Promise<string> 指令列工具路徑（找不到回傳 ''）
 * @param deps.probeOllama () => Promise<{ running, models }>
 * @returns {Promise<Record<string, { installed: boolean, detail: string, path?: string }>>}
 */
export async function detectIntegrations({ findCli, probeOllama, appRoots, platform = process.platform } = {}) {
  const results = {};
  await Promise.all(CATALOG.map(async (item) => {
    const { detect } = item;
    try {
      if (item.macOnly && platform !== 'darwin') {
        // 操作 App／網頁（貼上送出、讀畫面）目前只做了 macOS 版
        results[item.id] = { installed: false, unsupported: true, detail: '目前只支援 macOS' };
      } else if (detect.always) {
        results[item.id] = { installed: true, detail: '不用安裝' };
      } else if (detect.app) {
        const path = await findApp(detect.app, appRoots);
        results[item.id] = path ? { installed: true, detail: '已安裝', path } : { installed: false, detail: `沒有找到 ${detect.app}.app` };
      } else if (detect.cli) {
        const path = await findCli(detect.cli);
        results[item.id] = path ? { installed: true, detail: '已安裝', path } : { installed: false, detail: `沒有找到 ${detect.cli} 指令` };
      } else if (detect.ollama) {
        const probe = await probeOllama();
        if (probe.running) {
          results[item.id] = { installed: true, detail: probe.models.length ? `執行中，${probe.models.length} 個模型` : '執行中，但還沒有下載模型' };
        } else {
          const app = await findApp('Ollama', appRoots);
          const cli = app ? '' : await findCli('ollama');
          results[item.id] = app || cli
            ? { installed: true, detail: '已安裝但沒有啟動（使用前請先打開 Ollama）' }
            : { installed: false, detail: '沒有找到 Ollama' };
        }
      }
    } catch (error) {
      results[item.id] = { installed: false, detail: `偵測失敗：${error.message}` };
    }
  }));
  return results;
}

// ── 使用者同意的連接項目 ──

export async function loadConsent(path) {
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    return { decided: Boolean(json.decidedAt), enabled: json.enabled && typeof json.enabled === 'object' ? json.enabled : {}, decidedAt: json.decidedAt, defaultTarget: typeof json.defaultTarget === 'string' ? json.defaultTarget : '' };
  } catch {
    return { decided: false, enabled: {} };
  }
}

/** defaultTarget：預設 AI（主視窗的「預設送到」，也是精靈「跟著預設」時用的 AI） */
export async function saveConsent(path, enabled, defaultTarget = '') {
  const clean = Object.fromEntries(CATALOG.map(({ id }) => [id, enabled?.[id] === true]));
  const record = { version: 1, decidedAt: new Date().toISOString(), enabled: clean, defaultTarget: typeof defaultTarget === 'string' ? defaultTarget.slice(0, 60) : '' };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return { decided: true, enabled: clean, decidedAt: record.decidedAt, defaultTarget: record.defaultTarget };
}

/** 某個 AI 現在能不能選；不能選時附上原因（顯示在反灰的選項上） */
export function availability(id, detection, consent) {
  const found = detection?.[id];
  if (!found) return { available: false, reason: '偵測中' };
  if (found.unsupported) return { available: false, reason: '目前只支援 macOS' };
  if (!found.installed) return { available: false, reason: '未安裝' };
  if (!consent?.decided || consent.enabled?.[id] !== true) return { available: false, reason: '未啟用' };
  return { available: true, reason: '' };
}
