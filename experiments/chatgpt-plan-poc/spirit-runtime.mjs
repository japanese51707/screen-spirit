// 精靈上工：把精靈的 6 組設定組成給 AI 的工作指示。
// 能讀檔案的 AI（Claude Code、Gemini CLI、Codex）直接開放讀取資料庫資料夾；
// 不能讀檔案的（MixRoute、Ollama、內建 ChatGPT、操作 App）就把背景知識、記憶和參考檔的內容直接附上。
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { readRecentMemories } from './knowledge-base.mjs';

const TONES = { friendly: '親切、好懂', professional: '專業、精準', concise: '簡潔直接，先講結論', teacher: '像老師一樣，一步一步解釋', playful: '活潑、輕鬆' };
const LANGUAGES = { 'zh-Hant': '繁體中文', 'zh-Hans': '簡體中文', en: '英文', ja: '日文', auto: '跟使用者提問的語言一樣' };
const LENGTHS = { short: '簡短：重點 3～5 句或 5 點以內', medium: '適中：完整但不囉嗦', long: '詳細：完整說明理由、步驟與例子' };
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.tsv', '.html', '.xml']);
const INLINE_FILE_LIMIT = 8000; // 不能讀檔的 AI：每個參考檔最多附上的字數
const INLINE_TOTAL_LIMIT = 24000;

async function isDir(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

const block = (title, body) => (typeof body === 'string' && body.trim() ? `## ${title}\n${body.trim()}` : '');

/**
 * @param {object} spirit 精靈設定
 * @param {{ canReadFiles: boolean }} options 這次用的 AI 能不能自己讀資料夾
 * @returns {Promise<{ instructions: string, dirs: string[], summary: { steps: number, memories: boolean, dirs: number } }>}
 */
export async function prepareSpiritRun(spirit, { canReadFiles }) {
  const { role, limits, memory, sop } = spirit;
  const usesMemory = memory.mode === 'persistent';

  // 資料庫與參考資料夾
  const dirs = [];
  if (memory.home?.path && await isDir(memory.home.path)) dirs.push(memory.home.path);
  for (const source of memory.sources) {
    if (source.kind === 'folder' && await isDir(source.path) && !dirs.includes(source.path)) dirs.push(source.path);
  }
  const files = memory.sources.filter((source) => source.kind === 'file');
  const urls = memory.sources.filter((source) => source.kind === 'url');

  // 可以讀檔的 AI：開放讀取資料夾
  const dirsText = canReadFiles && dirs.length ? [
    '你可以讀取下面這些資料夾來參考（只能讀，不能新增、修改或刪除）。回答前先找相關的資料：',
    ...dirs.map((dir) => `- ${memory.home?.path === dir ? '資料庫（長期記憶在裡面的「記憶」資料夾）' : '參考資料夾'}：${dir}`),
  ].join('\n') : '';
  // 單一參考檔：不在開放的資料夾裡，所以文字檔的內容一律直接附上；其他格式只列名稱
  const parts = [];
  const unreadable = [];
  let total = 0;
  for (const file of files) {
    if (!TEXT_EXT.has(extname(file.path).toLowerCase()) || total >= INLINE_TOTAL_LIMIT) { unreadable.push(file); continue; }
    const text = (await readFile(file.path, 'utf8').catch(() => '')).slice(0, Math.min(INLINE_FILE_LIMIT, INLINE_TOTAL_LIMIT - total));
    if (!text.trim()) { unreadable.push(file); continue; }
    total += text.length;
    parts.push(`### ${file.label || file.path}\n${text.trim()}`);
  }
  if (unreadable.length) parts.push(`（下列檔案的內容沒有附上，只供參考名稱：${unreadable.map((file) => file.label || file.path).join('、')}）`);
  const library = parts.join('\n\n');
  const urlList = urls.length ? urls.map((url) => `- ${url.label || url.path}：${url.path}`).join('\n') : '';

  // 長期記憶：可以讀檔的 AI 自己去「記憶」資料夾找；其他的直接附上最近的記憶
  let memories = '';
  if (usesMemory && memory.home?.path && !(canReadFiles && dirs.includes(memory.home.path))) {
    memories = await readRecentMemories(memory.home.path).catch(() => '');
  }

  const steps = sop.steps.filter((step) => step.title.trim());
  const sopText = steps.length ? [
    '請依照下面的步驟完成工作，不要跳過任何一步：',
    ...steps.map((step, index) => `${index + 1}. ${step.title.trim()}${step.detail.trim() ? `\n${step.detail.trim().split('\n').map((line) => `   ${line}`).join('\n')}` : ''}`),
    '如果在前面的步驟發現資訊不足，先停下來列出要問使用者的問題，得到回答後再繼續；不要自己猜。',
  ].join('\n') : '';

  const rules = [
    `- 語氣：${TONES[role.tone] || TONES.friendly}。`,
    `- 回覆語言：${LANGUAGES[role.language] || LANGUAGES['zh-Hant']}。`,
    `- 回覆長度：${LENGTHS[limits.replyLength] || LENGTHS.medium}。`,
    '- 使用者的要求超出你的工作範圍時，說明這不在你的範圍內，並建議改用合適的精靈；不要勉強去做。',
    limits.confirmBeforeAction ? '- 任何會產生實際影響的動作（寄信、新增／修改／刪除檔案、建立行程、付款、對外發布）都只能提出建議，等使用者確認，不能自己執行。' : '',
    limits.citeSources ? '- 回答要註明根據的資料來源（檔名、筆記標題或網址）。' : '',
  ].filter(Boolean).join('\n');

  const instructions = [
    `# 你的角色：${spirit.name}`,
    spirit.summary ? `（${spirit.summary}）` : '',
    role.identity.trim(),
    role.audience.trim() ? `服務對象：${role.audience.trim()}` : '',
    block('定位與專長', role.positioning),
    '',
    '# 工作範圍',
    block('可以做的事', limits.allowed),
    block('不可以做的事', limits.forbidden),
    block('需要先問使用者的事（先停下來問，得到同意才做）', limits.askFirst),
    block('規則', rules),
    memory.knowledge.trim() || dirsText || library || urlList || memories || memory.notes.trim() ? '\n# 參考資料' : '',
    block('背景知識', memory.knowledge),
    block('資料庫', dirsText),
    block('參考檔案的內容', library),
    block('參考網址', urlList),
    usesMemory ? block('使用者補充的記憶', memory.notes) : '',
    block('之前整理的記憶（最近的在前）', memories),
    sopText ? `\n# 工作步驟（SOP）\n${sopText}` : '',
    block('最後交付的格式', sop.outputFormat),
    '',
    '使用者可能會附上螢幕圈選的圖片、複製的文字，以及畫面脈絡（來源程式）。',
  ].filter((line) => line !== '').join('\n\n').replace(/\n{3,}/g, '\n\n');

  return {
    instructions,
    dirs: canReadFiles ? dirs : [],
    summary: { steps: steps.length, memories: Boolean(memories) || (canReadFiles && usesMemory && dirs.length > 0), dirs: canReadFiles ? dirs.length : 0 },
  };
}

/** 操作 App／網頁的目標只能貼文字：把工作指示放在問題前面 */
export function withPastedInstructions(instructions, text) {
  return `【請先閱讀以下工作設定，並依照設定處理最下面的需求】\n\n${instructions}\n\n━━━━━━━━━━\n\n${text}`;
}
