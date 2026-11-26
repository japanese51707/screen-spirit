// 模式一：從 AI App 的視窗讀回回覆（透過輔助使用介面）。
// 做法：送出前記下畫面上的文字（baseline）→ 送出後每隔一段時間再讀一次 →
// 找到「剛送出的問題」最後出現的位置，它後面新出現的文字就是回覆；文字連續幾次不再變化就當作回覆完成。
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
      } else resolve(String(stdout));
    });
  });
}

/** 第一次使用時編譯 Swift 小工具（約 10～60 秒），之後重複使用；原始碼有改才重新編譯。 */
export async function ensureAxHelper({ sourcePath, binDirectory, log = () => {} }) {
  const source = await readFile(sourcePath);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binary = join(binDirectory, `ax-helper-${hash}`);
  try {
    await access(binary);
    return binary;
  } catch {}
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  log(`  編譯讀取工具 ax-helper（第一次使用）…`);
  const started = Date.now();
  try {
    await run('xcrun', ['swiftc', '-O', sourcePath, '-o', binary], 180000);
  } catch (error) {
    log(`  ✗ 編譯失敗：${error.message} ${error.stderr.slice(0, 600)}`);
    throw new Error('無法準備讀取回覆的工具：需要 Xcode 命令列工具（終端機執行 xcode-select --install）。');
  }
  log(`  ✓ 編譯完成（${Math.round((Date.now() - started) / 1000)} 秒）`);
  return binary;
}

export async function readWindowTexts(binary, bundleId) {
  let output;
  try {
    output = await run(binary, ['texts', bundleId], 15000);
  } catch (error) {
    output = error.stdout || '';
    if (!output) throw new Error(`讀取視窗失敗：${error.message}`);
  }
  const result = JSON.parse(output);
  if (!result.ok) {
    const reasons = {
      'not-trusted': '讀取回覆需要輔助使用權限。',
      'not-running': '目標 App 沒有在執行。',
      'no-window': '找不到目標 App 的視窗。',
    };
    throw new Error(reasons[result.error] || `讀取視窗失敗：${result.error}`);
  }
  return { texts: result.texts || [], stop: Boolean(result.stop), nodes: result.nodes || 0, attempts: result.attempts || 1, switches: result.switches || {} };
}

export async function dumpWindow(binary, bundleId, destination) {
  try {
    const output = await run(binary, ['dump', bundleId], 20000);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, output, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// 回覆下方常見的介面文字（免責聲明等），不算回覆內容
// App 介面上的字（不是回覆內容）：讀畫面時略過
const CHROME_PATTERNS = [/can make mistakes/i, /double-check/i, /可能會出錯/, /請再次確認/, /^Claude$/, /finished the response/i, /^(\d+|a|an|one) (second|minute|hour|day)s? ago$/i, /^(just now|剛剛)$/i, /^\d+ ?(秒|分鐘|小時|天)前$/, /Has buttons that/i, /press Tab until focus/i, /Escape to return/i];

/** 送出內容的最後一行，用來在畫面上找到「剛送出的問題」 */
export function questionAnchor(text) {
  const lines = String(text || '').split('\n').map(normalize).filter(Boolean);
  const last = lines.at(-1) || '';
  return last.length > 40 ? last.slice(-40) : last;
}

/**
 * 從畫面文字中取出回覆。
 * @param texts  送出後的畫面文字 [{t, p}]（依畫面順序；p 相同代表同一段落）
 * @param anchor questionAnchor() 的結果
 * @param baseline 送出前的畫面文字，用來排除原本就在畫面上的介面文字與舊對話
 */
export function extractReply(texts, { anchor, baseline = [] }) {
  if (!anchor) return { found: false, text: '' };
  const matches = (raw) => {
    const value = normalize(raw);
    return Boolean(value) && (value.includes(anchor) || (value.length >= Math.min(8, anchor.length) && anchor.endsWith(value)));
  };
  // 送出前畫面上已經出現過幾次（例如舊對話問過同樣的話），新的問題就是下一次出現；
  // 從前面數而不是從最後找，避免回覆裡引用了問題時被誤判。
  const before = baseline.filter((item) => matches(item.t)).length;
  let seen = 0;
  let index = -1;
  for (let i = 0; i < texts.length; i += 1) {
    if (!matches(texts[i].t)) continue;
    seen += 1;
    if (seen === before + 1) {
      index = i;
      break;
    }
  }
  if (index < 0) return { found: false, text: '' };
  const known = new Set(baseline.map((item) => normalize(item.t)));
  let output = '';
  let lastParent;
  for (const item of texts.slice(index + 1)) {
    const value = String(item.t || '');
    const key = normalize(value);
    if (!key || known.has(key) || CHROME_PATTERNS.some((pattern) => pattern.test(key))) continue;
    if (lastParent !== undefined) output += item.p === lastParent ? '' : '\n';
    output += value;
    lastParent = item.p;
  }
  return { found: true, text: output.replace(/\n{3,}/g, '\n\n').trim() };
}

/**
 * 持續讀取直到回覆完成。onUpdate(text) 會在內容變化時呼叫。
 * 完成條件：有內容、沒有「停止」鈕、連續 3 次沒變化；或沒有停止鈕資訊時連續 5 次沒變化。
 */
export async function waitForReply({ binary, bundleId, anchor, baseline, onUpdate, signal, log = () => {}, intervalMs = 900, timeoutMs = 240000, anchorTimeoutMs = 25000 }) {
  const started = Date.now();
  let last = '';
  let stable = 0;
  let anchorSeen = false;
  let firstRead = true;
  while (!signal?.aborted) {
    if (Date.now() - started > timeoutMs) throw new Error('等待回覆逾時（4 分鐘）。');
    const { texts, stop, nodes, attempts, switches } = await readWindowTexts(binary, bundleId);
    if (firstRead) {
      firstRead = false;
      log(`  第一次讀取：${nodes} 個節點、${texts.length} 段文字（嘗試 ${attempts} 次；開關結果 manual=${switches.manual} enhanced=${switches.enhanced}，0 代表成功）`);
    }
    const reply = extractReply(texts, { anchor, baseline });
    if (reply.found && !anchorSeen) {
      anchorSeen = true;
      log(`  ✓ 在畫面上找到剛送出的問題（${Math.round((Date.now() - started) / 1000)} 秒）`);
    }
    if (!reply.found && Date.now() - started > anchorTimeoutMs) {
      const error = new Error('在 App 畫面上找不到剛送出的問題，可能還沒送出，或畫面結構和預期不同。');
      error.code = 'anchor-not-found';
      throw error;
    }
    if (reply.text !== last) {
      last = reply.text;
      stable = 0;
      onUpdate?.(last);
    } else if (last) {
      stable += 1;
    }
    if (last && ((!stop && stable >= 3) || stable >= 5)) {
      log(`  ✓ 回覆完成（${last.length} 字，${Math.round((Date.now() - started) / 1000)} 秒）`);
      return last;
    }
    await sleep(intervalMs);
  }
  return last;
}

// ── 視窗停靠（DESIGN：把 AI App 的真實視窗移到圈選處旁邊）──

async function runHelperJson(binary, args, timeout = 10000) {
  let output;
  try {
    output = await run(binary, args, timeout);
  } catch (error) {
    output = error.stdout || '';
    if (!output) throw new Error(`視窗操作失敗：${error.message}`);
  }
  return JSON.parse(output);
}

/**
 * 等送出按鈕可以按（圖片上傳完成）。網頁版 ChatGPT 在上傳完成前按 Enter，圖片會沒跟上。
 * 找不到送出按鈕（介面語言不同、改版）就改用固定等待 fallbackMs。回傳一句說明給診斷紀錄。
 */
export async function waitForSubmitReady(binary, bundleId, { timeoutMs = 45000, minMs = 1000, fallbackMs = 5000, intervalMs = 500 } = {}) {
  const started = Date.now();
  let missing = 0;
  let last = {};
  while (Date.now() - started < timeoutMs) {
    try { last = await runHelperJson(binary, ['send-state', bundleId], 8000); } catch (error) { last = { ok: false, error: error.message }; }
    const elapsed = Date.now() - started;
    if (last.ok && last.found) {
      missing = 0;
      // 送出按鈕亮了、而且沒有轉圈圈（轉圈圈一直不消失就最多等 10 秒）
      if (last.enabled && (!last.busy || elapsed > 10000) && elapsed >= minMs) return `送出按鈕可以按了（${last.label}，等了 ${elapsed} ms）`;
    } else {
      missing += 1;
      if (missing >= 3 && elapsed >= fallbackMs) return `找不到送出按鈕，已改用固定等待 ${elapsed} ms`;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return `等了 ${Math.round(timeoutMs / 1000)} 秒送出按鈕還是灰的（${last.label || '未知'}），照樣送出`;
}

export async function getWindowFrame(binary, bundleId) {
  const result = await runHelperJson(binary, ['frame', bundleId]);
  if (!result.ok) throw new Error(`取得視窗位置失敗：${result.error}`);
  return result.frame;
}

export async function setWindowFrame(binary, bundleId, frame) {
  const args = ['move', bundleId, ...[frame.x, frame.y, frame.width, frame.height].map((value) => String(Math.round(value)))];
  const result = await runHelperJson(binary, args);
  if (!result.ok) throw new Error(`移動視窗失敗（代碼 ${result.result ?? result.error}）。如果 App 是全螢幕，請先離開全螢幕。`);
  return result.frame;
}

/**
 * 並排版面：AI App 放在螢幕右側 1/3，原本的程式放左側 2/3，高度都撐滿工作區（不含選單列與 Dock）。
 * AI 欄寬至少 minAiWidth（例如 Claude 視窗最窄 600）；左欄至少留 minSourceWidth。
 * @param workArea 圈選範圍所在螢幕的工作區
 */
export function computeSplitLayout(workArea, { aiRatio = 1 / 3, minAiWidth = 600, minSourceWidth = 400 } = {}) {
  const maxAi = Math.max(0, workArea.width - minSourceWidth);
  const aiWidth = Math.round(Math.min(Math.max(workArea.width * aiRatio, minAiWidth), maxAi || workArea.width));
  const aiX = workArea.x + workArea.width - aiWidth;
  return {
    ai: { x: Math.round(aiX), y: Math.round(workArea.y), width: aiWidth, height: Math.round(workArea.height) },
    source: { x: Math.round(workArea.x), y: Math.round(workArea.y), width: Math.round(aiX - workArea.x), height: Math.round(workArea.height) },
  };
}

// ── 反白文字 ──

/** 透過輔助使用介面讀出某個程式目前反白的文字；讀不到回傳空字串（不碰剪貼簿）。 */
export async function readSelectedText(binary, pid) {
  try {
    const result = await runHelperJson(binary, ['selected-text', String(pid)], 5000);
    return result.ok ? String(result.text || '') : '';
  } catch {
    return '';
  }
}

/** 使用者是否還按著修飾鍵（⌘⇧⌥⌃）。模擬 ⌘C 前要等放開，否則會變成 ⌘⇧C 之類的其他快捷鍵。 */
export async function modifiersDown(binary) {
  try {
    return Boolean((await runHelperJson(binary, ['mods'], 3000)).down);
  } catch {
    return false;
  }
}

// ── 抽屜模式 ──

/** 平滑移動視窗的 x（在讀取工具的同一個行程內逐格移動，比每格啟動一次程式順很多） */
export async function slideWindow(binary, id, { fromX, toX, y, ms = 360, curve = 'expo-out' }) {
  const result = await runHelperJson(binary, ['slide', String(id), ...[fromX, toX, y, ms].map((v) => String(Math.round(v))), curve], ms + 5000);
  if (!result.ok) throw new Error(`滑動視窗失敗：${result.error || ''}`);
  return result.frame;
}

export async function setAppHidden(binary, id, hidden) {
  const result = await runHelperJson(binary, [hidden ? 'hide-app' : 'show-app', String(id)], 5000);
  return Boolean(result.ok);
}

/**
 * 收起時要放在哪裡：預設滑到螢幕右緣外，只留 1px（macOS 不允許視窗完全離開所有螢幕）。
 * 如果右邊還接著另一個螢幕，滑出去會跑到那個螢幕上，就改成整個 App 隱藏。
 */
export function hiddenPlacement(shownFrame, workArea, displayBounds = []) {
  const right = workArea.x + workArea.width;
  const neighbor = displayBounds.some((b) => b.x >= right - 1 && b.x <= right + 1 &&
    b.y < shownFrame.y + shownFrame.height && b.y + b.height > shownFrame.y);
  return neighbor ? { mode: 'app-hide' } : { mode: 'slide', x: right - 1 };
}

/** 距離上次按鍵盤幾秒；讀不到時回傳很大的數字（當作沒在打字） */
/** 距離使用者上次按鍵盤或動滑鼠幾秒（讀不到時回傳 999） */
export async function secondsSinceLastInput(binary) {
  try {
    const result = await runHelperJson(binary, ['idle'], 3000);
    const values = [result.keySeconds, result.mouseSeconds].filter(Number.isFinite);
    return values.length ? Math.min(...values) : 999;
  } catch {
    return 999;
  }
}

export async function secondsSinceLastKey(binary) {
  try {
    const result = await runHelperJson(binary, ['idle'], 3000);
    return Number.isFinite(result.keySeconds) ? result.keySeconds : 999;
  } catch {
    return 999;
  }
}

/**
 * 擷取 AI App 的視窗畫面（被遮住也截得到），回傳 PNG Buffer；暫存檔讀完立即刪除。
 * 抽屜在「使用者點了旁邊的程式、AI 被蓋住」時，用這張圖在最上層播放收起動畫。
 */
export async function snapWindow(binary, id) {
  const file = join(tmpdir(), `screen-spirit-snap-${randomUUID()}.png`);
  try {
    const result = await runHelperJson(binary, ['snap', String(id), file], 6000);
    if (!result.ok) throw new Error(`截圖失敗：${result.error}`);
    return await readFile(file);
  } finally {
    await unlink(file).catch(() => {});
  }
}

/** 本機 OCR（macOS Vision）：辨識 PNG 圖片裡的文字；暫存檔讀完立即刪除。 */
export async function ocrImage(binary, png) {
  const file = join(tmpdir(), `screen-spirit-ocr-${randomUUID()}.png`);
  await writeFile(file, png, { mode: 0o600 });
  try {
    const result = await runHelperJson(binary, ['ocr', file], 20000);
    if (!result.ok) throw new Error(`文字辨識失敗：${result.error}`);
    return { text: String(result.text || '').trim(), lines: result.lines || 0 };
  } finally {
    await unlink(file).catch(() => {});
  }
}
