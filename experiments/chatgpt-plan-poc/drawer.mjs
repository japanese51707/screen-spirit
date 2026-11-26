// 抽屜模式（v3）：AI App 放在右側 1/3、疊在原本程式上面（左邊全寬、不會一直縮放）。
//   收起：滑鼠離開 AI 超過 1 秒（打字中不收），或點了旁邊的程式。
//         點旁邊時 AI 會立刻被那個程式蓋住，所以改播「替身動畫」：用預先截好的 AI 畫面在最上層滑進右邊緣。
//   滑出：點右邊緣把手、按 ⌘⇧9、或切回 AI；先把 AI 叫到最前面再滑，動畫才看得到。
//   固定（📌）：不自動收起，左邊的程式讓出位置（變左 2/3），點左邊時 AI 也不會被蓋住。
//   夾層工具列：AI 視窗上方 32px 的一條，放「回小精靈／固定／收起／結束並排」，跟著 AI 一起滑動。
// 動畫一律用指數曲線：滑出 expo-out（快出、柔和停下），收起 expo-in-out（柔和起步、中段加速、收進邊緣）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { hiddenPlacement, readWindowTexts, secondsSinceLastKey, setAppHidden, setWindowFrame, slideWindow, snapWindow } from './ax-reader.mjs';

const LEAVE_DELAY_MS = 1000; // 滑鼠離開 AI 視窗多久才收起
const TYPING_GRACE_S = 1.5;  // 這段時間內有按鍵盤，就當作還在打字，先不收
const SHOW_MS = 380;
const HIDE_MS = 320;
const MOUSE_POLL_MS = 100;
const SNAP_FRESH_MS = 5000;  // 替身截圖多新才拿來用
const HANDLE = { width: 26, height: 92 };
export const DRAWER_BAR_HEIGHT = 32; // 夾層工具列高度；AI 視窗要往下讓出這個高度
// CSS 版的 expo-in-out（替身動畫用，和真視窗收起的曲線一致）
const EXPO_IN_OUT_CSS = 'cubic-bezier(0.87, 0, 0.13, 1)';
const expoOut = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const expoInOut = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2);

export function createDrawer({ directory, getHelper, isOwnPid, log = () => {}, onChange = () => {}, onOpenHome = () => {}, onRestore = () => {} }) {
  let session;

  // ── 三個小視窗：右邊緣把手、圖釘、替身動畫 ──
  async function createUiWindow(file, bounds, { ignoreMouse = false } = {}) {
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false, // 點了也不會搶走使用者正在用的程式的焦點
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: join(directory, 'drawer-ui-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (ignoreMouse) win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(join(directory, file));
    return win;
  }

  const alive = (win) => win && !win.isDestroyed();

  function handleBounds(area) {
    return { x: Math.round(area.x + area.width - HANDLE.width), y: Math.round(area.y + area.height / 2 - HANDLE.height / 2), ...HANDLE };
  }
  function barBounds(shown, x = shown.x) {
    return { x: Math.round(x), y: Math.round(shown.y - DRAWER_BAR_HEIGHT), width: Math.round(shown.width), height: DRAWER_BAR_HEIGHT };
  }

  /** 工具列跟著 AI 視窗一起移動（同一條曲線、同樣的時間） */
  function animateBar(fromX, toX, ms, ease) {
    const current = session;
    return new Promise((resolve) => {
      if (!current || !alive(current.bar)) return resolve();
      const start = Date.now();
      const step = () => {
        if (!alive(current.bar)) return resolve();
        const t = Math.min(1, (Date.now() - start) / ms);
        current.bar.setBounds(barBounds(current.shown, fromX + (toX - fromX) * ease(t)));
        if (t < 1) setTimeout(step, 8);
        else resolve();
      };
      step();
    });
  }

  function sendBarState() {
    if (session && alive(session.bar)) session.bar.webContents.send('drawer:bar-state', { pinned: Boolean(session.pinned), appName: session.appName });
  }
  function ghostBounds(shown, area) {
    return { x: Math.round(shown.x), y: Math.round(shown.y), width: Math.round(area.x + area.width - shown.x), height: Math.round(shown.height) };
  }

  function ownsSender(sender) {
    return Boolean(session && [session.handle, session.bar, session.ghost].some((win) => alive(win) && win.webContents === sender));
  }

  ipcMain.handle('drawer:toggle', (event) => { if (ownsSender(event.sender)) return api.toggle(); return false; });
  ipcMain.handle('drawer:bar-action', async (event, action) => {
    if (!ownsSender(event.sender)) return false;
    if (action === 'home') onOpenHome();
    else if (action === 'pin') await setPinned(!session.pinned);
    else if (action === 'hide') await hide({ reason: '工具列' });
    else if (action === 'restore') await onRestore();
    return true;
  });
  ipcMain.handle('drawer:bar-ready', (event) => { if (ownsSender(event.sender)) sendBarState(); return true; });
  ipcMain.handle('drawer:ghost-ready', (event) => { if (ownsSender(event.sender)) session.onGhostReady?.(); return true; });
  ipcMain.handle('drawer:ghost-done', (event) => { if (ownsSender(event.sender)) session.onGhostDone?.(); return true; });

  function setBadge(on) {
    if (!session) return;
    session.badge = on;
    if (alive(session.handle)) session.handle.webContents.send('drawer:badge', on);
  }

  function showChrome(shown) {
    // 展開時：顯示工具列、隱藏把手；收起時相反
    if (!session) return;
    if (alive(session.bar)) {
      if (shown) { session.bar.setBounds(barBounds(session.shown)); session.bar.showInactive(); } else session.bar.hide();
    }
    if (alive(session.handle)) {
      if (shown) session.handle.hide(); else session.handle.showInactive();
    }
  }

  // ── 替身截圖：滑鼠一離開 AI 就先截好，等到「點旁邊」時直接拿來播動畫 ──
  async function captureSnap() {
    const current = session;
    if (!current || current.snapping) return current?.snapping;
    current.snapping = (async () => {
      try {
        const png = await snapWindow(await getHelper(), current.bundleId);
        if (session === current) current.snap = { png, at: Date.now() };
      } catch (error) {
        log(`抽屜：替身截圖失敗（${error.message}），點旁邊時會直接收起、沒有動畫`);
      } finally {
        current.snapping = undefined;
      }
    })();
    return current.snapping;
  }

  /** 在最上層播放替身動畫；onReady 會在替身蓋上去的那一刻被呼叫（這時才動真正的視窗） */
  function playGhost(png, onReady) {
    const current = session;
    return new Promise((resolve) => {
      if (!current || !alive(current.ghost)) return resolve(false);
      const bounds = ghostBounds(current.shown, current.area);
      current.ghost.setBounds(bounds);
      const finish = (ok) => {
        clearTimeout(timer);
        current.onGhostReady = undefined;
        current.onGhostDone = undefined;
        if (alive(current.ghost)) current.ghost.hide();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), HIDE_MS + 2500);
      current.onGhostReady = () => {
        current.ghost.showInactive();
        current.ghost.moveTop();
        onReady();
      };
      current.onGhostDone = () => finish(true);
      current.ghost.webContents.send('drawer:ghost-play', {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width: Math.round(current.shown.width),
        height: Math.round(current.shown.height),
        travel: bounds.width,
        ms: HIDE_MS,
        easing: EXPO_IN_OUT_CSS,
      });
    });
  }

  // ── 收起時偵測「AI 寫完新回覆」：每 2.5 秒讀一次視窗文字量，有增加且連續兩次不變就亮提示 ──
  function startBadgeWatch() {
    stopBadgeWatch();
    const current = session;
    let baseline;
    let last;
    let stable = 0;
    current.badgeTimer = setInterval(async () => {
      if (session !== current || current.state !== 'hidden' || current.badge) return;
      try {
        const { texts } = await readWindowTexts(await getHelper(), current.bundleId);
        const size = texts.reduce((sum, item) => sum + String(item.t || '').length, 0);
        if (baseline === undefined) { baseline = size; last = size; return; }
        stable = size === last ? stable + 1 : 0;
        last = size;
        if (size > baseline && stable >= 2) {
          setBadge(true);
          log('抽屜：收起期間 AI 有新內容，把手亮起提示');
        }
      } catch {}
    }, 2500);
  }
  function stopBadgeWatch() {
    if (session?.badgeTimer) clearInterval(session.badgeTimer);
    if (session) session.badgeTimer = undefined;
  }

  // ── 前景程式監聽（事件驅動的常駐小程式）──
  async function startWatcher() {
    const child = spawn(await getHelper(), ['watch-front'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { onFrontmost(JSON.parse(line)); } catch {}
      }
    });
    return child;
  }

  function onFrontmost({ pid, bundleId }) {
    if (!session) return;
    session.frontBundleId = bundleId;
    if (bundleId === session.bundleId) {
      if (session.state === 'hidden') void show({ activate: false }); // 切回 AI → 滑出
      return;
    }
    if (isOwnPid(pid)) return; // 小精靈自己的視窗不算離開
    // 點了旁邊的程式：AI 已經被蓋住，立刻用替身動畫收起（固定時不收）
    if (session.state === 'shown' && !session.pinned) void hide({ reason: '點了其他程式' });
  }

  // ── 滑鼠離開 AI 超過 1 秒就收起；滑鼠要先進來過才開始算；打字中不收 ──
  function mouseInsideDrawer(point) {
    const margin = 6;
    const zones = [session.shown, barBounds(session.shown)];
    return zones.some((r) => point.x >= r.x - margin && point.x <= r.x + r.width + margin && point.y >= r.y - margin && point.y <= r.y + r.height + margin);
  }

  function startMouseWatch() {
    stopMouseWatch();
    const current = session;
    current.armed = false;
    current.outsideSince = undefined;
    current.mouseTimer = setInterval(async () => {
      if (session !== current || current.state !== 'shown' || current.pinned || current.busy || current.checking) return;
      if (mouseInsideDrawer(screen.getCursorScreenPoint())) {
        current.armed = true;
        current.outsideSince = undefined;
        return;
      }
      if (!current.armed) return;
      if (current.outsideSince === undefined) {
        current.outsideSince = Date.now();
        if (!current.snap || Date.now() - current.snap.at > 1500) void captureSnap(); // 先備好替身
      }
      if (Date.now() - current.outsideSince < LEAVE_DELAY_MS) return;
      if (current.frontBundleId === current.bundleId) {
        current.checking = true;
        try {
          if (await secondsSinceLastKey(await getHelper()) < TYPING_GRACE_S) {
            current.outsideSince = Date.now();
            return;
          }
        } finally {
          current.checking = false;
        }
      }
      if (session === current && current.state === 'shown') void hide({ reason: '滑鼠離開' });
    }, MOUSE_POLL_MS);
  }
  function stopMouseWatch() {
    if (session?.mouseTimer) clearInterval(session.mouseTimer);
    if (session) session.mouseTimer = undefined;
  }

  async function activateAi() {
    await new Promise((resolve) => {
      const child = spawn('open', ['-b', session.bundleId], { stdio: 'ignore' });
      child.on('exit', resolve);
      child.on('error', resolve);
    });
  }

  async function moveRealWindowAway(helper) {
    if (session.placement.mode === 'slide') await setWindowFrame(helper, session.bundleId, { ...session.shown, x: session.placement.x });
    else await setAppHidden(helper, session.bundleId, true);
  }

  async function hide({ reason = '手動' } = {}) {
    if (!session || session.state !== 'shown' || session.busy) return;
    if (session.pinned) await setPinned(false); // 固定時手動收起：先取消固定，左邊恢復全寬
    session.busy = true;
    stopMouseWatch();
    const current = session;
    try {
      const helper = await getHelper();
      const aiOnTop = current.frontBundleId === current.bundleId;
      const barX = current.placement.mode === 'slide' ? current.placement.x : current.area.x + current.area.width;
      if (aiOnTop && current.placement.mode === 'slide') {
        // AI 在最上面：直接滑真正的視窗，工具列同步滑走
        await Promise.all([
          slideWindow(helper, current.bundleId, { fromX: current.shown.x, toX: current.placement.x, y: current.shown.y, ms: HIDE_MS, curve: 'expo-in-out' }),
          animateBar(current.shown.x, barX, HIDE_MS, expoInOut),
        ]);
      } else {
        // AI 可能已經被蓋住：用替身在最上層播同樣的收起動畫
        if (!current.snap || Date.now() - current.snap.at > SNAP_FRESH_MS) await captureSnap();
        let moving;
        let barMoving;
        const played = current.snap
          ? await playGhost(current.snap.png, () => {
            moving = moveRealWindowAway(helper);
            barMoving = animateBar(current.shown.x, barX, HIDE_MS, expoInOut);
          })
          : false;
        if (barMoving) await barMoving;
        if (moving) await moving;
        else await moveRealWindowAway(helper);
        if (!played) log('抽屜：沒有替身截圖，直接收起');
      }
      current.state = 'hidden';
      current.snap = undefined; // 收起後內容會變，舊截圖作廢
      setBadge(false);
      showChrome(false);
      startBadgeWatch();
      log(`抽屜：收起（${reason}；${aiOnTop ? '滑動真正視窗' : '替身動畫'}）`);
    } catch (error) {
      log(`抽屜：收起失敗：${error.message}`);
    } finally {
      current.busy = false;
      if (session === current && current.state === 'shown' && !current.pinned) startMouseWatch();
      onChange();
    }
  }

  async function show({ activate = true } = {}) {
    if (!session || session.state !== 'hidden' || session.busy) return;
    session.busy = true;
    const current = session;
    stopBadgeWatch();
    if (alive(current.handle)) current.handle.hide();
    try {
      const helper = await getHelper();
      if (current.placement.mode === 'slide') {
        // 先叫到最前面，滑出的動畫才不會被其他視窗擋住
        if (activate) await activateAi();
        if (alive(current.bar)) { current.bar.setBounds(barBounds(current.shown, current.placement.x)); current.bar.showInactive(); }
        await Promise.all([
          slideWindow(helper, current.bundleId, { fromX: current.placement.x, toX: current.shown.x, y: current.shown.y, ms: SHOW_MS, curve: 'expo-out' }),
          animateBar(current.placement.x, current.shown.x, SHOW_MS, expoOut),
        ]);
      } else {
        await setAppHidden(helper, current.bundleId, false);
        if (activate) await activateAi();
      }
      current.state = 'shown';
      setBadge(false);
      showChrome(true);
      startMouseWatch();
      log('抽屜：滑出');
    } catch (error) {
      log(`抽屜：滑出失敗：${error.message}`);
      if (alive(current.handle)) current.handle.showInactive();
    } finally {
      current.busy = false;
      onChange();
    }
  }

  // ── 固定：左邊讓出位置（左 2/3），不自動收起 ──
  async function setPinned(on) {
    if (!session || Boolean(session.pinned) === Boolean(on)) return Boolean(session?.pinned);
    const current = session;
    current.pinned = Boolean(on);
    sendBarState();
    if (current.sourceKey) {
      const area = current.area;
      const frame = current.pinned
        ? { x: area.x, y: area.y, width: Math.max(300, Math.round(current.shown.x - area.x)), height: area.height }
        : { x: area.x, y: area.y, width: area.width, height: area.height };
      try {
        await setWindowFrame(await getHelper(), current.sourceKey, frame);
      } catch (error) {
        log(`抽屜：調整左邊視窗失敗：${error.message}`);
      }
    }
    if (current.pinned) stopMouseWatch();
    else if (current.state === 'shown') startMouseWatch();
    log(`抽屜：${current.pinned ? '固定（左邊讓出位置、不自動收起）' : '取消固定（左邊恢復全寬、自動收起）'}`);
    onChange();
    return current.pinned;
  }

  const api = {
    /** 進入抽屜模式：AI 視窗已在 shown 的位置、左邊程式已放大到全寬；sourceKey 是左邊程式的 pid（可省略） */
    /** pinned=true 用於「固定並排」：一開始就固定（左邊已經是 2/3），不自動收起 */
    async start({ bundleId, appName, shown, area, sourceKey, pinned = false }) {
      await api.stop({ restoreVisibility: false });
      const displays = screen.getAllDisplays().map((display) => display.bounds);
      session = { bundleId, appName, shown, area, sourceKey, placement: hiddenPlacement(shown, area, displays), state: 'shown', busy: false, pinned: Boolean(pinned) };
      const current = session;
      const [handle, bar, ghost] = await Promise.all([
        createUiWindow('drawer-handle.html', handleBounds(area)),
        createUiWindow('drawer-bar.html', barBounds(shown)),
        createUiWindow('drawer-ghost.html', ghostBounds(shown, area), { ignoreMouse: true }),
      ]);
      if (session !== current) { [handle, bar, ghost].forEach((win) => win.destroy()); return; }
      Object.assign(current, { handle, bar, ghost });
      sendBarState();
      current.watcher = await startWatcher();
      showChrome(true);
      startMouseWatch();
      log(`抽屜：開始（${appName}，收起方式：${current.placement.mode === 'slide' ? '滑進右邊緣' : '右邊還有螢幕，改成隱藏 App'}）`);
      onChange();
    },

    async stop({ restoreVisibility = true } = {}) {
      if (!session) return;
      const ending = session;
      session = undefined;
      if (ending.mouseTimer) clearInterval(ending.mouseTimer);
      if (ending.badgeTimer) clearInterval(ending.badgeTimer);
      ending.watcher?.kill();
      for (const win of [ending.handle, ending.bar, ending.ghost]) if (alive(win)) win.destroy();
      if (restoreVisibility && ending.state === 'hidden') {
        try {
          const helper = await getHelper();
          if (ending.placement.mode === 'slide') await setWindowFrame(helper, ending.bundleId, ending.shown);
          else await setAppHidden(helper, ending.bundleId, false);
        } catch {}
      }
      log('抽屜：結束');
      onChange();
    },

    show,
    hide,
    setPinned,
    async toggle() {
      if (!session) return false;
      if (session.state === 'hidden') await show();
      else await hide({ reason: '手動' });
      return true;
    },
    isActive: () => Boolean(session),
    isHidden: () => session?.state === 'hidden',
    isPinned: () => Boolean(session?.pinned),
    appName: () => session?.appName,
    bundleId: () => session?.bundleId,
  };
  return api;
}
