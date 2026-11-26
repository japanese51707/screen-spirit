// 投遞 Provider（DESIGN §4）：開啟使用者選的 AI 軟體 → 開新對話 → 貼上圈選圖片 → 貼上問題與脈絡 → 送出。
// 只用系統剪貼簿＋模擬按鍵，不讀回覆（R-PRV-07）；每一步貼上前都確認前景程式沒被換掉，避免貼錯地方。
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runJxa } from './window-context.mjs';

/**
 * 目標設定檔。快捷鍵與等待時間是依各軟體慣例的「起始值」，需要實測調整：
 * 不必改程式，可在使用者資料夾放 delivery-targets.json 覆寫（見 loadDeliveryTargets）。
 *   app            用 `open -a` 開啟的 App 名稱
 *   url            有值時改用 app（瀏覽器）開這個網址，網址本身就是新對話
 *   newChat        開新對話要按的快捷鍵（依序執行）
 *   afterNewChatMs 開新對話後等輸入框就緒的時間
 *   acceptsImage   能否貼上圖片；否則只送文字
 *   imageSettleMs  貼上圖片後等上傳的時間
 *   projectBased   以專案資料夾為單位的編輯器（Kiro）：投遞前先用 open -a 打開使用者選的資料夾
 *   appDataName    編輯器在 ~/Library/Application Support 底下的資料夾名稱（讀最近開過的專案）
 *   afterOpenPathMs 打開專案資料夾後等視窗準備好的時間
 *   manualSubmit   只貼上、不自動送出（讓使用者自己確認後送）
 *   noDock         不做並排／抽屜
 *   queryUrl       沒有圖片時直接把問題接在這個網址後面打開（例如 Google AI 模式），不貼上、不按送出
 *   waitForSend    有附圖時，送出前等「送出」按鈕可以按（圖片上傳完成）；讀不到按鈕就多等幾秒
 *   submit         送出按鍵
 */
export const DEFAULT_TARGETS = {
  'claude-app': {
    label: 'Claude（桌面 App）', app: 'Claude', newChat: [{ key: 'n', mods: ['command'] }],
    afterNewChatMs: 900, acceptsImage: true, imageSettleMs: 1500, submit: { key: 'return' }, readBack: 'ax',
  },
  'chatgpt-app': {
    label: 'ChatGPT（桌面 App）', app: 'ChatGPT', newChat: [{ key: 'n', mods: ['command'] }],
    afterNewChatMs: 900, acceptsImage: true, imageSettleMs: 1500, submit: { key: 'return' },
    waitForSend: true, // 圖片要上傳：等送出按鈕亮了再送
  },
  'chatgpt-web': {
    label: 'ChatGPT（Chrome 網頁）', app: 'Google Chrome', url: 'https://chatgpt.com/', newChat: [],
    afterNewChatMs: 3500, acceptsImage: true, imageSettleMs: 2000, submit: { key: 'return' },
    waitForSend: true, // 網頁版貼上圖片後要先上傳，上傳完成前送出圖片會沒跟上
  },
  'google-ai-mode': {
    label: 'Google AI 模式（Chrome 網頁）', app: 'Google Chrome', url: 'https://www.google.com/search?udm=50',
    // 只有文字：直接把問題帶進網址（udm=50 就是 AI 模式），不用貼上、也不用輔助使用權限
    queryUrl: 'https://www.google.com/search?udm=50&q=',
    newChat: [], afterNewChatMs: 3500, acceptsImage: true, imageSettleMs: 2000, submit: { key: 'return' },
    waitForSend: true, // 有圖片時要先上傳
  },
  kiro: {
    label: 'Kiro（實驗）', app: 'Kiro', newChat: [{ key: 'l', mods: ['command'] }],
    afterNewChatMs: 900, acceptsImage: true, imageSettleMs: 1500, submit: { key: 'return' },
    clearInput: false, // 還不確定焦點一定在聊天框；萬一停在程式碼編輯器，⌘A＋刪除會刪掉程式碼
    imageSupport: 'unknown',
    // Kiro 以專案為單位工作：先打開使用者選的專案資料夾；只貼上不送出、不並排，讓使用者在 Kiro 裡確認後自己送
    projectBased: true, appDataName: 'Kiro', afterOpenPathMs: 2500, manualSubmit: true, noDock: true,
  },
  'hermes-app': {
    label: 'Hermes（實驗）', app: 'Hermes', newChat: [{ key: 'n', mods: ['command'] }],
    afterNewChatMs: 900, acceptsImage: true, imageSettleMs: 1500, submit: { key: 'return' },
    clearInput: false, // 介面尚未確認，先不做全選刪除
    imageSupport: 'unknown',
  },
};

// macOS 實體按鍵代碼（ANSI 配置）。用代碼而非字元，避免中文輸入法攔截。
const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  return: 36, enter: 76, tab: 48, escape: 53, delete: 51,
};
const MODIFIERS = { command: 'command down', shift: 'shift down', option: 'option down', control: 'control down' };

export class DeliveryError extends Error {
  constructor(message, step) {
    super(message);
    this.step = step;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        reject(error);
      } else resolve(String(stdout).trim());
    });
  });
}

function validKey(step) {
  return step && typeof step.key === 'string' && step.key.toLowerCase() in KEY_CODES &&
    (step.mods === undefined || (Array.isArray(step.mods) && step.mods.every((m) => m in MODIFIERS)));
}

function sanitizeTarget(id, value) {
  if (!value || typeof value !== 'object' || typeof value.app !== 'string' || !value.app.trim()) return undefined;
  const ms = (v, fallback) => (Number.isFinite(v) && v >= 0 && v <= 20000 ? v : fallback);
  const newChat = Array.isArray(value.newChat) ? value.newChat.filter(validKey) : [];
  return {
    id,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : id,
    app: value.app.trim(),
    url: typeof value.url === 'string' && /^https:\/\//.test(value.url) ? value.url : undefined,
    queryUrl: typeof value.queryUrl === 'string' && /^https:\/\//.test(value.queryUrl) ? value.queryUrl : undefined,
    newChat,
    afterNewChatMs: ms(value.afterNewChatMs, 900),
    acceptsImage: value.acceptsImage !== false,
    imageSettleMs: ms(value.imageSettleMs, 1500),
    submit: validKey(value.submit) ? value.submit : { key: 'return' },
    readBack: value.readBack === 'ax' ? 'ax' : undefined,
    waitForSend: value.waitForSend === true,
    projectBased: value.projectBased === true,
    appDataName: typeof value.appDataName === 'string' && /^[\w .-]{1,60}$/.test(value.appDataName) ? value.appDataName : undefined,
    afterOpenPathMs: ms(value.afterOpenPathMs, 2500),
    manualSubmit: value.manualSubmit === true,
    noDock: value.noDock === true,
    clearInput: value.clearInput !== false,
    // 看圖能力：acceptsImage=false 一定是 'no'；其餘預設 'yes'，實驗中的目標標 'unknown'
    imageSupport: value.acceptsImage === false ? 'no' : (['yes', 'no', 'unknown'].includes(value.imageSupport) ? value.imageSupport : 'yes'),
  };
}

/** 預設設定檔＋使用者資料夾裡 delivery-targets.json 的覆寫（同 id 合併、新 id 新增）。 */
export async function loadDeliveryTargets(overridePath) {
  let overrides = {};
  if (overridePath) {
    try { overrides = JSON.parse(await readFile(overridePath, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') console.warn('delivery-targets.json ignored:', error.message); }
  }
  const targets = {};
  for (const id of new Set([...Object.keys(DEFAULT_TARGETS), ...Object.keys(overrides || {})])) {
    if (!/^[a-z0-9-]{1,40}$/.test(id)) continue;
    const merged = sanitizeTarget(id, { ...DEFAULT_TARGETS[id], ...(overrides?.[id] || {}) });
    if (merged) targets[id] = merged;
  }
  return targets;
}

const bundleCache = new Map();
async function resolveBundleId(appName) {
  if (bundleCache.has(appName)) return bundleCache.get(appName);
  try {
    const id = await run('osascript', ['-e', 'on run argv', '-e', 'return id of application (item 1 of argv)', '-e', 'end run', appName]);
    bundleCache.set(appName, id);
    return id;
  } catch {
    throw new DeliveryError(`找不到「${appName}」。請確認已安裝在「應用程式」資料夾。`, 'resolve');
  }
}

export function resolveTargetBundleId(target) {
  return resolveBundleId(target.app);
}

export async function frontmostBundleId() {
  return runJxa("ObjC.import('AppKit'); function run(){ const a=$.NSWorkspace.sharedWorkspace.frontmostApplication; return a ? ObjC.unwrap(a.bundleIdentifier) || '' : ''; }");
}

/** 把某個 App 叫到最前面（工作流讀回覆時用），回傳是否成功 */
export async function bringToFront(bundleId, timeoutMs = 3000) {
  if ((await frontmostBundleId()) === bundleId) return true;
  try { await run('open', ['-b', bundleId]); } catch { return false; }
  try { await waitForFrontmost(bundleId, timeoutMs); return true; } catch { return false; }
}

async function waitForFrontmost(bundleId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await frontmostBundleId()) === bundleId) return;
    await sleep(150);
  }
  throw new DeliveryError('目標程式沒有切到最前面（可能還在啟動或需要登入）。', 'activate');
}

async function ensureFrontmost(bundleId, label) {
  if ((await frontmostBundleId()) !== bundleId) {
    throw new DeliveryError(`焦點被切到別的程式，為了避免貼到錯的地方，已停止投遞到 ${label}。`, 'focus');
  }
}

function friendlyOsaError(error) {
  const text = `${error?.stderr || ''} ${error?.message || ''}`;
  if (/-1743|not authori[sz]ed|不允許.*傳送|Not authorized to send Apple events/i.test(text)) {
    return '需要允許小精靈控制「System Events」：系統設定 → 隱私權與安全性 → 自動化。';
  }
  if (/-1719|-25211|assistive|輔助使用|not allowed to send keystrokes/i.test(text)) {
    return '需要輔助使用權限才能自動貼上：系統設定 → 隱私權與安全性 → 輔助使用。';
  }
  return '模擬按鍵失敗。';
}

export async function pressKey(step) {
  const code = KEY_CODES[step.key.toLowerCase()];
  const mods = (step.mods || []).map((m) => MODIFIERS[m]);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  try {
    await run('osascript', ['-e', `tell application "System Events" to key code ${code}${using}`]);
  } catch (error) {
    throw new DeliveryError(friendlyOsaError(error), 'keys');
  }
}

async function openTarget(target, openPath) {
  try {
    // 專案資料夾：open -a Kiro <資料夾> 會打開（或切換到）那個專案的視窗
    await run('open', openPath ? ['-a', target.app, openPath] : target.url ? ['-a', target.app, target.url] : ['-a', target.app]);
  } catch {
    throw new DeliveryError(openPath ? `無法用「${target.app}」打開專案資料夾。` : `無法開啟「${target.app}」。`, 'open');
  }
}

/**
 * 組成要貼進對話框的文字（R-CTX-05：context 是使用者送出前保留下來的項目）。
 */
export function composeDeliveryText({ question, sourceText, context = [], sourceKind, hasImage, ocrText, imageAttached = false }) {
  const lines = [];
  const describe = (c) => {
    const title = c.title ? `（視窗：${c.title}）` : '';
    const share = Number.isFinite(c.share) && sourceKind === 'screen' ? `，約占 ${Math.round(c.share * 100)}%` : '';
    return `${c.app}${title}${share}`;
  };
  if (context.length) {
    const [main, ...rest] = context;
    const where = sourceKind === 'clipboard' ? '我複製的內容來自' : '我圈選的範圍主要來自';
    lines.push(`【畫面脈絡】${where} ${describe(main)}${rest.length ? `；也包含 ${rest.map(describe).join('、')}` : ''}。`);
  }
  // 圖片從哪裡來：自己附上的檔案、複製的圖片，或螢幕圈選
  if (hasImage) lines.push(imageAttached ? '【附圖】我附上的圖片。' : sourceKind === 'clipboard' ? '【附圖】我複製的圖片。' : sourceKind === 'screen' ? '【附圖】我在螢幕上圈選的畫面。' : '【附圖】我附上的圖片。');
  if (ocrText !== undefined) lines.push(`【圖片中的文字（本機 OCR 辨識；這個 AI 看不到原圖）】\n${ocrText || '（圖片裡沒有辨識到文字）'}`);
  if (sourceText) lines.push(`${sourceKind === 'clipboard' ? '【我複製的內容】' : '【我附上的內容】'}\n${sourceText}`);
  lines.push(`【我的問題】\n${question}`);
  return lines.join('\n\n');
}

/**
 * 接續模式要貼進輸入框的文字：只有畫面脈絡與附圖說明，最後留一行「【我的問題】」讓使用者接著打。
 */
export function composeAttachmentText({ sourceText, context = [], sourceKind, hasImage, ocrText }) {
  return composeDeliveryText({ question: '', sourceText, context, sourceKind, hasImage, ocrText }); // 結尾已有換行，游標會停在「【我的問題】」下一行
}

/**
 * 執行投遞。成功時還原使用者原本的剪貼簿；失敗時把內容留在剪貼簿並保持目標開啟，讓使用者手動貼上（R-PRV-05）。
 * @returns {{ ok: true } | { ok: false, manual: true, error: string }}
 */
export async function deliver({ target, image, text, trailer = '', autoSubmit = true, newChat = true, clearInput = target.clearInput, onBeforeSubmit, waitBeforeSubmit, openPath }, { clipboardIO, systemPreferences, log = () => {} }) {
  if (process.platform !== 'darwin') throw new DeliveryError('目前只支援 macOS。', 'platform');
  const started = Date.now();
  const step = async (name, action) => {
    const t = Date.now();
    try {
      const value = await action();
      log(`  ✓ ${name}（${Date.now() - t} ms）${value !== undefined ? ` → ${value}` : ''}`);
      return value;
    } catch (error) {
      log(`  ✗ ${name}（${Date.now() - t} ms）${error?.message || error}${error?.stderr ? ` | stderr: ${String(error.stderr).trim().slice(0, 300)}` : ''}`);
      throw error;
    }
  };
  log(`投遞開始：${target.id}（${target.app}）圖片=${image && !image.isEmpty() ? `${image.getSize().width}x${image.getSize().height}` : '無'} 文字長度=${text.length} 自動送出=${autoSubmit}`);
  const imageToPaste = image && !image.isEmpty() && target.acceptsImage ? image : undefined;
  const leaveForManualPaste = () => clipboardIO.write({ text, image: imageToPaste }).catch(() => {});

  // 只有文字、而且目標可以用網址直接提問（Google AI 模式）：直接打開網址，最穩定
  const queryLink = target.queryUrl && !imageToPaste && newChat ? `${target.queryUrl}${encodeURIComponent(text)}` : '';
  if (queryLink && queryLink.length <= 8000) {
    try {
      const bundleId = await step('找到 App', () => resolveBundleId(target.app));
      await step('用網址帶入問題開啟', () => run('open', ['-a', target.app, queryLink]));
      await step('等 App 到最前面', async () => { await waitForFrontmost(bundleId, 8000); return frontmostBundleId(); });
      log(`投遞完成（共 ${Date.now() - started} ms，網址帶入，不用貼上）`);
      return { ok: true };
    } catch (error) {
      log('  網址帶入失敗，改用貼上');
    }
  }

  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  log(`  輔助使用權限：${trusted ? '已授權' : '未授權'}（父行程：${process.env.TERM_PROGRAM || '非終端機啟動'}）`);
  if (!trusted) {
    systemPreferences.isTrustedAccessibilityClient(true); // 跳出系統授權提示
    await leaveForManualPaste();
    await openTarget(target).catch(() => {});
    return {
      ok: false,
      manual: true,
      error: `還沒有輔助使用權限，無法自動貼上。已開啟 ${target.label} 並把內容複製好，請按 ⌘V 貼上。授權後（開發版在清單中可能叫 Electron）重新啟動小精靈即可自動送出。`,
    };
  }

  const saved = await clipboardIO.snapshot();
  log(`  已保存原本的剪貼簿（${saved.length} 個項目）`);
  try {
    const bundleId = await step('找到 App', () => resolveBundleId(target.app));
    await step(openPath ? `開啟專案 ${openPath}` : '開啟 App', () => openTarget(target, openPath));
    await step('等 App 到最前面', async () => { await waitForFrontmost(bundleId, 8000); return frontmostBundleId(); });
    if (openPath) await sleep(target.afterOpenPathMs); // 專案視窗打開、載入完成
    if (newChat) {
      for (const key of target.newChat) await step(`按開新對話 ${[...(key.mods || []), key.key].join('+')}`, () => pressKey(key));
      await sleep(target.afterNewChatMs);
    } else {
      log('  追問：沿用目前的對話，不開新對話');
      await sleep(250);
    }

    if (clearInput) {
      // 輸入框可能還留著之前沒送出的草稿：先全選再刪除（附件縮圖無法用鍵盤移除）
      await step('確認焦點（清空輸入框前）', () => ensureFrontmost(bundleId, target.label));
      await step('清空輸入框 ⌘A＋刪除', async () => {
        await pressKey({ key: 'a', mods: ['command'] });
        await pressKey({ key: 'delete' });
      });
      await sleep(150);
    }
    if (imageToPaste) {
      await step('把圖片放進剪貼簿並確認', () => clipboardIO.writeImageVerified(imageToPaste));
      await step('確認焦點（貼圖片前）', () => ensureFrontmost(bundleId, target.label));
      await step('貼上圖片 ⌘V', () => pressKey({ key: 'v', mods: ['command'] }));
      await sleep(target.imageSettleMs);
    }
    await step('把文字放進剪貼簿', () => clipboardIO.write({ text }));
    await step('確認焦點（貼文字前）', () => ensureFrontmost(bundleId, target.label));
    await step('貼上文字 ⌘V', () => pressKey({ key: 'v', mods: ['command'] }));
    await sleep(350);
    // 很長的文字會被 App 收成「附件」（例如 Claude 會把長貼上變成檔案卡），畫面上看不到內容；
    // 再貼一小段短文字（含這次的記號），讓它留在對話裡，之後才找得到這一次的問題
    if (trailer) {
      await sleep(900);
      await step('把短的結尾放進剪貼簿', () => clipboardIO.write({ text: trailer }));
      await step('確認焦點（貼結尾前）', () => ensureFrontmost(bundleId, target.label));
      await step('貼上結尾 ⌘V', () => pressKey({ key: 'v', mods: ['command'] }));
      await sleep(350);
    }
    if (autoSubmit && imageToPaste && target.waitForSend) {
      // 圖片還在上傳就送出，圖片會被丟掉：等送出按鈕亮起來（沒有讀取工具時多等 4 秒）
      await step('等圖片上傳完成', async () => {
        if (waitBeforeSubmit) return waitBeforeSubmit();
        await sleep(4000);
        return '沒有讀取工具，固定多等 4 秒';
      });
    }
    if (onBeforeSubmit) await step('記下送出前的畫面', onBeforeSubmit);
    if (autoSubmit) {
      await step('確認焦點（送出前）', () => ensureFrontmost(bundleId, target.label));
      await step(`送出 ${target.submit.key}`, () => pressKey(target.submit));
    }
    await sleep(500); // 讓目標讀完剪貼簿再還原
    await step('還原原本的剪貼簿', () => clipboardIO.restore(saved));
    log(`投遞完成（共 ${Date.now() - started} ms）`);
    return { ok: true, imageSkipped: Boolean(image && !image.isEmpty() && !target.acceptsImage) };
  } catch (error) {
    await leaveForManualPaste();
    log(`投遞失敗（共 ${Date.now() - started} ms），內容已留在剪貼簿`);
    const reason = error instanceof DeliveryError ? error.message : '自動投遞失敗。';
    return { ok: false, manual: true, code: error instanceof DeliveryError ? error.code : '', error: `${reason} 內容已複製，可以在 ${target.label} 按 ⌘V 手動貼上。` };
  }
}
