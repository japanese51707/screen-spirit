// 畫面脈絡：圈選當下，範圍內實際看得到哪些程式（SPEC R-CTX-01～05）。
// macOS 透過 osascript 執行 JXA 呼叫 CGWindowListCopyWindowInfo，不需要另外編譯原生 helper。
// 取得視窗標題需要螢幕錄製權限；沒有時標題會是空字串，只保留程式名稱。
import { execFile } from 'node:child_process';

const WINDOW_LIST_JXA = `
ObjC.import('CoreGraphics');
function run() {
  // 1 = kCGWindowListOptionOnScreenOnly、16 = kCGWindowListExcludeDesktopElements；回傳順序為由前到後
  const ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  return JSON.stringify(list.map((w) => ({
    owner: w.kCGWindowOwnerName || '',
    pid: w.kCGWindowOwnerPID || 0,
    title: w.kCGWindowName || '',
    layer: w.kCGWindowLayer || 0,
    alpha: w.kCGWindowAlpha === undefined ? 1 : w.kCGWindowAlpha,
    bounds: w.kCGWindowBounds || {},
  })));
}`;

const FRONTMOST_JXA = `
ObjC.import('AppKit');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app) return '{}';
  return JSON.stringify({
    name: ObjC.unwrap(app.localizedName) || '',
    bundleId: ObjC.unwrap(app.bundleIdentifier) || '',
    pid: app.processIdentifier,
  });
}`;

export function runJxa(script, args = [], timeout = 2000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '');
        reject(error);
      }
      else resolve(stdout.trim());
    });
  });
}

export let lastSnapshotError = '';

/** 由前到後的可見視窗清單；失敗時回傳空陣列（脈絡是加分項，不能擋住圈選）。 */
export async function captureWindowSnapshot() {
  lastSnapshotError = '';
  if (process.platform !== 'darwin') return [];
  try {
    const raw = JSON.parse(await runJxa(WINDOW_LIST_JXA));
    return raw
      .map((w) => ({
        owner: String(w.owner || ''),
        pid: Number(w.pid) || 0,
        title: String(w.title || ''),
        layer: Number(w.layer) || 0,
        alpha: Number.isFinite(Number(w.alpha)) ? Number(w.alpha) : 1,
        bounds: {
          x: Number(w.bounds.X) || 0,
          y: Number(w.bounds.Y) || 0,
          width: Number(w.bounds.Width) || 0,
          height: Number(w.bounds.Height) || 0,
        },
      }))
      .filter((w) => w.owner && w.bounds.width > 1 && w.bounds.height > 1);
  } catch (error) {
    lastSnapshotError = `${error?.message || 'unknown error'} ${error?.stderr || ''}`.trim().slice(0, 400);
    console.warn('Window snapshot unavailable:', lastSnapshotError);
    return [];
  }
}

/** 目前的前景程式（剪貼簿模式用，不需要額外權限）。 */
export async function frontmostApplication() {
  if (process.platform !== 'darwin') return undefined;
  try {
    const app = JSON.parse(await runJxa(FRONTMOST_JXA));
    return app && app.name ? { name: String(app.name), bundleId: String(app.bundleId || ''), pid: Number(app.pid) || 0 } : undefined;
  } catch {
    return undefined;
  }
}

function area(r) { return Math.max(0, r.width) * Math.max(0, r.height); }

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

function subtract(rect, cover) {
  const o = intersect(rect, cover);
  if (!o) return [rect];
  const pieces = [];
  if (o.y > rect.y) pieces.push({ x: rect.x, y: rect.y, width: rect.width, height: o.y - rect.y });
  if (o.y + o.height < rect.y + rect.height) pieces.push({ x: rect.x, y: o.y + o.height, width: rect.width, height: rect.y + rect.height - o.y - o.height });
  if (o.x > rect.x) pieces.push({ x: rect.x, y: o.y, width: o.x - rect.x, height: o.height });
  if (o.x + o.width < rect.x + rect.width) pieces.push({ x: o.x + o.width, y: o.y, width: rect.x + rect.width - o.x - o.width, height: o.height });
  return pieces;
}

const MAX_TITLE = 160;

/**
 * 依可見面積判斷圈選範圍來自哪些程式（沿用 visibility-poc 的演算法）。
 * 規則（R-CTX-03）：最大者 ≥ 60% → 只附它；否則附前兩名與比例。
 * @param windows 由前到後的視窗清單
 * @param selection 圈選矩形（與視窗座標同為全域邏輯座標）
 * @param exclude { pids:Set<number> } 小精靈自己的行程
 */
export function computeSelectionContext(windows, selection, { pids = new Set() } = {}) {
  if (!windows?.length || !selection || area(selection) <= 0) return [];
  const covers = [];
  const byApp = new Map();
  for (const w of windows) {
    if (w.layer !== 0 || w.alpha <= 0 || pids.has(w.pid)) continue; // 只看一般視窗；排除選單列、Dock、通知與自己
    const clipped = intersect(w.bounds, selection);
    if (!clipped) continue;
    let visible = [clipped];
    for (const cover of covers) visible = visible.flatMap((piece) => subtract(piece, cover));
    const visibleArea = visible.reduce((sum, piece) => sum + area(piece), 0);
    if (w.alpha >= 0.99) covers.push(clipped);
    if (visibleArea <= 0) continue;
    const entry = byApp.get(w.owner) || { app: w.owner, area: 0, title: '', titleArea: 0, pid: w.pid, pidArea: 0 };
    entry.area += visibleArea;
    if (w.title && visibleArea > entry.titleArea) { entry.title = w.title; entry.titleArea = visibleArea; }
    if (visibleArea > entry.pidArea) { entry.pid = w.pid; entry.pidArea = visibleArea; }
    byApp.set(w.owner, entry);
  }
  const total = area(selection);
  const ranked = [...byApp.values()]
    .map((e) => ({ app: e.app, title: e.title.slice(0, MAX_TITLE), share: Math.round((e.area / total) * 100) / 100, pid: e.pid }))
    .filter((e) => e.share >= 0.03)
    .sort((a, b) => b.share - a.share);
  if (!ranked.length) return [];
  return ranked[0].share >= 0.6 ? ranked.slice(0, 1) : ranked.slice(0, 2);
}
