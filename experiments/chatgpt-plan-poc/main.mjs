import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, safeStorage, screen, shell, systemPreferences, Tray } from 'electron';
import { createChatGPT, ChatGPTError, CHATGPT_USAGE_URL } from '@siwc/local';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConversationSession } from './conversation-session.mjs';
import { createHistoryStore } from './history-store.mjs';
import { DEFAULT_PRESENTATION_MODE, isPresentationMode, loadPresentationMode, savePresentationMode } from './preferences.mjs';
import { bringToFront, frontmostBundleId, composeAttachmentText, composeDeliveryText, deliver, loadDeliveryTargets, pressKey, resolveTargetBundleId } from './delivery.mjs';
import { computeSplitLayout, modifiersDown, ocrImage, readSelectedText, dumpWindow, ensureAxHelper, extractReply, secondsSinceLastInput, getWindowFrame, questionAnchor, readWindowTexts, setWindowFrame, waitForReply, waitForSubmitReady } from './ax-reader.mjs';
import { askClaudeCli, findClaudeCli } from './claude-cli.mjs';
import { askCodex, askGemini, findCli } from './cli-agents.mjs';
import { checkCliLogin, CLI_LOGIN, looksLikeLoginError, openLoginTerminal, waitForLogin } from './cli-login.mjs';
import { listLocalSessions, loadLocalSession, TOOL_INFO } from './local-sessions.mjs';
import { createProjectStore, isDirectory, listProjects } from './projects.mjs';
import { createSpiritStore, defaultSpirit } from './spirits-store.mjs';
import { createSkinService } from './skin-service.mjs';
import { detectStorageLocations, listDirectory, listMemoryTitles, prepareSpiritFolder, readPreview, resolveInside, writeMemoryNote } from './knowledge-base.mjs';
import { curateConversation } from './memory-curator.mjs';
import { buildLimitsPrompt, DEPTHS, parseLimitsReply } from './limits-writer.mjs';
import { buildRolePrompt, parseRoleReply, ROLE_DEPTHS } from './role-writer.mjs';
import { buildSopPrompt, parseSopReply, SOP_DEPTHS } from './sop-writer.mjs';
import { prepareSpiritRun, withPastedInstructions } from './spirit-runtime.mjs';
import { setupWorkflow } from './workflow-main.mjs';
import { probeOllama, streamOllamaChat } from './ollama.mjs';
import { availability, CATALOG, detectIntegrations, loadConsent, saveConsent } from './integrations.mjs';
import { buildUserMessage, extractImagePrompt, generateMixRouteImage, listMixRouteModelEntries, pickDefaultModel, streamMixRouteChat } from './mixroute.mjs';
import { imageSupport, MODEL_KIND_LABEL, modelKind } from './model-capabilities.mjs';
import { captureWindowSnapshot, computeSelectionContext, frontmostApplication, lastSnapshotError } from './window-context.mjs';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createClipboardIO } from './clipboard-io.mjs';
import { createDrawer, DRAWER_BAR_HEIGHT } from './drawer.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const htmlUrl = pathToFileURL(join(directory, 'index.html')).href;
const selectionHtmlUrl = pathToFileURL(join(directory, 'selection.html')).href;
const companionHtmlUrl = pathToFileURL(join(directory, 'companion.html')).href;
const selectionAccelerator = process.platform === 'darwin' ? 'Command+Shift+1' : 'Control+Shift+1';
const clipboardAccelerator = process.platform === 'darwin' ? 'Command+Shift+2' : 'Control+Shift+2';
// 打開／收起 AI 抽屜。避開 ⌘⇧3／4／5（macOS 截圖）。
const drawerAccelerator = process.platform === 'darwin' ? 'Command+Shift+9' : 'Control+Shift+9';
const appId = 'screen-spirit-chatgpt-plan-poc';
app.setName('Screen Spirit ChatGPT Plan PoC');
app.setPath('userData', join(app.getPath('appData'), 'Screen Spirit ChatGPT Plan PoC'));
const preferencesPath = join(app.getPath('userData'), 'preferences.json');
const clipboardFingerprintPath = join(app.getPath('userData'), 'last-clipboard-fingerprint');
const deliveryTargetsPath = join(app.getPath('userData'), 'delivery-targets.json');
// 診斷紀錄：開發版寫在專案的 logs/，方便直接查看；只記步驟、耗時、錯誤與程式名稱，不記問題內容。
const diagnosticsLogPath = app.isPackaged
  ? join(app.getPath('userData'), 'logs', 'delivery.log')
  : join(directory, '..', '..', 'logs', 'delivery.log');
let diagnosticsQueue = Promise.resolve();
function diagnostics(line) {
  const stamped = `[${new Date().toLocaleString('zh-TW', { hour12: false })}] ${line}\n`;
  diagnosticsQueue = diagnosticsQueue
    .then(() => mkdir(dirname(diagnosticsLogPath), { recursive: true }))
    .then(() => appendFile(diagnosticsLogPath, stamped, { mode: 0o600 }))
    .catch(() => {});
}

let window;
let companionWindow;
let companionCollapseTimer;
let companionCollapsed = false;
let companionOutsideSince;
let selectionWindow;
let selectionCapture;
let selectionWindows = [];
let deliveryTargets = {};
const clipboardIO = createClipboardIO({ clipboard, ClipboardItem, nativeImage });
let delivering = false;
let selectionStarting = false;
let restoreWindowAfterCancel = false;
let restoreCompanionAfterSelection = false;
let activeRequest;
let quitting = false;
let tray; // 保留參照，避免選單列圖示被回收
let pendingClipboardFingerprint;
let historyStore;
let historySaveTimer;
let historyWriteQueue = Promise.resolve();
let conversation = createConversationSession({}, DEFAULT_PRESENTATION_MODE);
let state = {
  session: { status: 'disconnected', sharing: false },
  models: [],
  model: '',
  presentationMode: DEFAULT_PRESENTATION_MODE,
  selectionHotkeyRegistered: false,
  clipboardHotkeyRegistered: false,
  screenPermissionStatus: 'unknown',
  busy: false,
  error: '',
  builtinError: '', // 內建 ChatGPT 的錯誤，只顯示在它自己的區塊
  cliLogin: {}, // 指令列 AI 的登入狀態：targetId → { status: 'needed'｜'waiting'｜'done'｜'failed'｜'timeout', name }
};

const chatgpt = createChatGPT({
  appName: 'Screen Spirit',
  appId,
  redirectPort: 0,
  storageDir: join(app.getPath('userData'), 'chatgpt'),
  credentialEncryption: {
    id: 'electron-safe-storage-v1',
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptStringAsync(value),
    decrypt: async (value) => {
      // 只解密一次：shouldReEncrypt 代表「下次寫入時建議重新加密」，重複解密同一份資料結果不會變，原本的 while 會卡死。
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(value));
      return decrypted.result;
    },
  },
  openBrowser: async (url) => {
    const target = new URL(url);
    if (target.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in destination.');
    await shell.openExternal(target.href);
  },
});

function snapshot() {
  return {
    ...state,
    conversation: {
      id: conversation.id,
      createdAt: conversation.createdAt,
      source: conversation.source,
      presentationMode: conversation.presentationMode,
      phase: conversation.phase,
      delivery: conversation.delivery,
      spiritId: conversation.delivery?.spiritId || conversation.spiritId || '',
    },
    // Keep this top-level alias while the current renderer consumes it.
    messages: conversation.messages,
    deliveryTargets: allTargets().map((target) => ({
      id: target.id,
      label: target.label,
      readsBack: target.kind === 'cli' || target.kind === 'api' || target.readBack === 'ax',
      kind: target.kind || 'app',
      image: target.kind === 'api' || target.kind === 'ollama' ? undefined : imageSupportFor(target),
      projectBased: Boolean(target.projectBased),
      manualSubmit: Boolean(target.manualSubmit),
      noDock: Boolean(target.noDock),
      ...targetAvailability(target.id),
    })),
    integrations: {
      decided: consent.decided,
      detecting,
      platform: process.platform,
      defaultTarget: consent.defaultTarget || '',
      defaultKbRoot: defaultKbRoot(), // 精靈沒選資料庫時的預設位置（文件／Screen Spirit／精靈資料庫）
      builtin: availability('builtin', detection, consent),
      items: CATALOG.map((item) => ({
        id: item.id,
        label: item.id === 'builtin' ? '小精靈內建（ChatGPT 方案）' : (findTarget(item.id)?.label || item.id),
        group: item.group,
        note: item.note,
        installed: Boolean(detection[item.id]?.installed),
        detail: detection[item.id]?.detail || (detecting ? '偵測中…' : ''),
        enabled: consent.enabled?.[item.id] === true,
        loggedIn: detection[item.id]?.loggedIn ?? null,
        isNew: consent.decided && consent.enabled?.[item.id] === undefined, // 上次設定之後才新增的 AI
        unsupported: Boolean(detection[item.id]?.unsupported),
        install: item.install || null,
      })),
    },
    ollama: {
      running: ollamaStatus.running,
      models: ollamaStatus.models,
      blocked: {},
      imageSupport: Object.fromEntries(ollamaStatus.models.map((name) => [name, ollamaImageSupport(name)])),
      defaultModel: ollamaStatus.models.find((name) => ollamaImageSupport(name) === 'yes') || ollamaStatus.models[0] || '',
    },
    layoutMode,
    drawer: { active: drawer.isActive(), hidden: drawer.isHidden(), pinned: drawer.isPinned(), appName: drawer.appName() || '' },
    mixroute: {
      hasKey: mixrouteStatus.hasKey,
      keyHint: mixrouteStatus.keyHint,
      models: mixrouteStatus.models,
      blocked: mixrouteBlocked,
      imageSupport: Object.fromEntries(mixrouteStatus.models.map((id) => [id, mixrouteImageSupport(id)])),
      defaultModel: pickDefaultModel(mixrouteChatModels()),
      // 不能對話的模型：生圖、影片、語音、向量（選單裡會反灰）
      kinds: Object.fromEntries(mixrouteStatus.models.map((id) => [id, mixrouteModelKind(id)]).filter(([, kind]) => kind !== 'chat')),
      error: mixrouteStatus.error,
    },
    delivering,
  };
}

function publish(channel = 'poc:state', payload = snapshot()) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  if (conversation.messages.length) scheduleHistorySave();
  syncCompanion();
}

function scheduleHistorySave() {
  if (!historyStore || !conversation.messages.length) return;
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    const session = structuredClone(conversation);
    historyWriteQueue = historyWriteQueue.then(() => historyStore.save(session)).catch((error) => {
      console.error('Could not save encrypted conversation history:', error instanceof Error ? error.message : 'unknown error');
    });
  }, 400);
  historySaveTimer.unref?.();
}

// 內建 ChatGPT 的錯誤訊息改成中文（原本是英文，而且看不出是哪一條連線出問題）
const BUILTIN_ERROR_TEXT = {
  network_error: '連不上 ChatGPT（內建方案）。可能是網路還沒準備好或暫時不穩，稍後按「重試」。',
  connection_error: '連不上 ChatGPT（內建方案）。請確認網路後按「重試」。',
  stream_interrupted: '回覆傳到一半中斷了，可以再試一次。',
  invalid_stream: 'ChatGPT 回傳的資料格式不正確，請再試一次。',
  cancelled: '已取消。',
  sign_in_required: '內建 ChatGPT 需要重新登入：按「連接 ChatGPT」。',
  invalid_grant: '內建 ChatGPT 的登入已過期：按「連接 ChatGPT」重新登入。',
  sharing_not_enabled: '還沒授權小精靈使用你的 ChatGPT 方案：按「連接 ChatGPT」完成授權。',
  invalid_model_catalog: '讀不到內建 ChatGPT 的模型清單，稍後按「重試」。',
  response_too_large: '回覆太長，超過上限。',
  browser_unavailable: '打不開瀏覽器來登入 ChatGPT。',
};
// 內建 ChatGPT 連到 OpenAI 時改走 Electron 的 Chromium 網路（和 Chrome 同一套）：
// 會用 Mac 的代理（Proxy／VPN）設定與系統憑證。Node 內建的 fetch 不會，所以 Chrome 打得開、小精靈卻連不上。
const OPENAI_HOSTS = /^https:\/\/(?:[a-z0-9-]+\.)*(?:openai\.com|chatgpt\.com)(?::\d+)?\//i;
let lastNetFailureLog = 0;
function installChromiumFetchForOpenAI() {
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (!app.isReady() || typeof url !== 'string' || !OPENAI_HOSTS.test(url)) return nodeFetch(input, init);
    try {
      return await net.fetch(input, init);
    } catch (error) {
      // 只記主機與錯誤代碼（例如 net::ERR_PROXY_CONNECTION_FAILED），不記內容
      if (!init?.signal?.aborted && Date.now() - lastNetFailureLog > 5000) {
        lastNetFailureLog = Date.now();
        diagnostics(`內建 ChatGPT 連線失敗：${new URL(url).host}（${error instanceof Error ? error.message : String(error)}）`);
      }
      throw error;
    }
  };
}

function safeError(error) {
  if (error instanceof ChatGPTError) {
    const { code, message } = error.toJSON();
    return BUILTIN_ERROR_TEXT[code] || `內建 ChatGPT 發生錯誤：${message}`;
  }
  return '發生錯誤，請再試一次。';
}

// 內建 ChatGPT 有沒有被使用者勾選連接（還沒做過連線設定時視為可用，維持舊行為）
function builtinEnabled() {
  return !consent?.decided || consent.enabled?.builtin === true;
}

let builtinRetryTimer;
let builtinRetryCount = 0;

async function refreshSession({ manual = false } = {}) {
  state.session = await chatgpt.getSession();
  clearTimeout(builtinRetryTimer);
  if (!builtinEnabled()) {
    // 使用者沒有勾選內建 ChatGPT：不去連線，也不顯示它的錯誤
    state.models = [];
    state.builtinError = '';
  } else if (state.session.status === 'connected' && state.session.sharing) {
    try {
      state.models = await chatgpt.listModels();
      if (!state.models.some((item) => item.slug === state.model)) state.model = state.models[0]?.slug ?? '';
      state.builtinError = '';
      builtinRetryCount = 0;
    } catch (error) {
      state.models = [];
      // 錯誤只顯示在「內建 ChatGPT」區塊，不再蓋住整個主視窗
      state.builtinError = safeError(error);
      diagnostics(`內建 ChatGPT：載入模型失敗（${error instanceof ChatGPTError ? error.code : 'unknown'}）`);
      if (manual) builtinRetryCount = 0;
      // 剛開機時網路常常還沒好：自動再試兩次（10 秒、30 秒後）
      if (error instanceof ChatGPTError && error.retryable && builtinRetryCount < 2) {
        const delay = builtinRetryCount === 0 ? 10_000 : 30_000;
        builtinRetryCount += 1;
        builtinRetryTimer = setTimeout(() => { void refreshSession(); }, delay);
        builtinRetryTimer.unref?.();
      }
    }
  } else {
    state.models = [];
    state.model = '';
    state.builtinError = '';
  }
  publish();
}

function assertTrustedSender(event) {
  const frameUrl = event.senderFrame?.url;
  if (!window || event.sender !== window.webContents || !frameUrl || frameUrl !== htmlUrl) {
    throw new Error('This action is only available in the Screen Spirit prototype.');
  }
}

function assertTrustedCompanionSender(event) {
  const frameUrl = event.senderFrame?.url;
  if (!companionWindow || event.sender !== companionWindow.webContents || !frameUrl || frameUrl !== companionHtmlUrl) {
    throw new Error('This action is only available from the Screen Spirit companion.');
  }
}

function handle(channel, action) {
  ipcMain.handle(`poc:${channel}`, (event, ...args) => {
    assertTrustedSender(event);
    return action(...args);
  });
}

function validateQuestion(question, imageDataUrl, sourceText) {
  if (typeof question !== 'string' || !question.trim() || question.length > 20_000) {
    throw new Error('Enter a question of up to 20,000 characters.');
  }
  if (imageDataUrl !== undefined) {
    if (typeof imageDataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
      throw new Error('Choose a PNG, JPEG, or WebP image.');
    }
    if (Buffer.byteLength(imageDataUrl, 'utf8') > 12 * 1024 * 1024) {
      throw new Error('The test image is too large. Choose an image under 9 MB.');
    }
  }
  if (sourceText !== undefined && (typeof sourceText !== 'string' || sourceText.length > 100_000)) {
    throw new Error('剪貼簿文字過長，請先縮短來源內容。');
  }
}

function assertTrustedSelectionSender(event) {
  const frameUrl = event.senderFrame?.url;
  if (!selectionWindow || event.sender !== selectionWindow.webContents || frameUrl !== selectionHtmlUrl) {
    throw new Error('This action is only available in the Screen Spirit selection overlay.');
  }
}

function handleSelection(channel, action) {
  ipcMain.handle(`selection:${channel}`, (event, ...args) => {
    assertTrustedSelectionSender(event);
    return action(...args);
  });
}

function screenCapturePermissionError() {
  const status = systemPreferences.getMediaAccessStatus('screen');
  state.screenPermissionStatus = status;
  const appLabel = app.isPackaged ? 'Screen Spirit' : 'Electron（目前執行的是未封裝原型）';
  const notListedHint = app.isPackaged
    ? ''
    : '若清單沒有 Electron，請按「＋」並選取專案中的 node_modules/electron/dist/Electron.app。';
  if (status === 'denied' || status === 'restricted') {
    return `需要螢幕錄製權限。請到 macOS「系統設定 → 隱私權與安全性 → 螢幕與系統音訊錄製」允許 ${appLabel}，然後重新啟動程式。${notListedHint}`;
  }
  return `無法擷取螢幕。請確認 ${appLabel} 已取得 macOS 螢幕錄製權限，再重新嘗試。${notListedHint}`;
}

async function captureScreenSources() {
  state.screenPermissionStatus = systemPreferences.getMediaAccessStatus('screen');
  const displays = screen.getAllDisplays();
  if (!displays.length) throw new Error('找不到可擷取的螢幕。');
  const maxWidth = Math.max(...displays.map((display) => Math.ceil(display.bounds.width * display.scaleFactor)));
  const maxHeight = Math.max(...displays.map((display) => Math.ceil(display.bounds.height * display.scaleFactor)));
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.min(maxWidth, 4096), height: Math.min(maxHeight, 4096) },
      fetchWindowIcons: false,
    });
  } catch {
    throw new Error(screenCapturePermissionError());
  }

  const capturedScreens = displays.map((display) => {
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source || source.thumbnail.isEmpty()) throw new Error(screenCapturePermissionError());
    return {
      bounds: { ...display.bounds },
      scaleFactor: display.scaleFactor,
      dataUrl: source.thumbnail.toDataURL(),
    };
  });
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
  return {
    geometry: { x: left, y: top, width: right - left, height: bottom - top },
    screens: capturedScreens,
  };
}

function closeSelectionWindow() {
  const active = selectionWindow;
  selectionWindow = undefined;
  if (active && !active.isDestroyed()) active.close();
}

function restoreCompanionWindow() {
  if (restoreCompanionAfterSelection && companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.show();
    companionWindow.moveTop();
  }
  restoreCompanionAfterSelection = false;
}

async function beginScreenSelection() {
  if (!window || window.isDestroyed()) return { ok: false };
  if (selectionWindow && !selectionWindow.isDestroyed()) {
    selectionWindow.show();
    selectionWindow.focus();
    return { ok: true };
  }
  if (selectionStarting) return { ok: true };
  if (conversation.messages.length) {
    const archived = await finishCurrentConversation();
    if (!archived.ok) return archived;
  }

  selectionStarting = true;
  state.error = '';
  restoreWindowAfterCancel = window.isVisible();
  window.hide();
  restoreCompanionAfterSelection = Boolean(companionWindow && companionWindow.isVisible());
  if (restoreCompanionAfterSelection) companionWindow.hide();
  await new Promise((resolve) => setTimeout(resolve, 140));

  try {
    // 擷取畫面的同時記下可見視窗清單（在圈選層出現前，避免小精靈自己混入，R-CAP-02）。
    const captureStarted = Date.now();
    const [capture, windows] = await Promise.all([captureScreenSources(), captureWindowSnapshot()]);
    diagnostics(`擷取畫面＋視窗清單：${Date.now() - captureStarted} ms`);
    selectionCapture = capture;
    selectionWindows = windows;
    const { geometry } = selectionCapture;
    selectionWindow = new BrowserWindow({
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: true,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true, // 可蓋住選單列，凍結畫面才能和實際螢幕完全對齊
      show: false,
      webPreferences: {
        preload: join(directory, 'selection-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const activeOverlay = selectionWindow;
    activeOverlay.setAlwaysOnTop(true, 'screen-saver'); // 疊在選單列與 Dock 之上，凍結畫面不會被擋住
    activeOverlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    activeOverlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    activeOverlay.webContents.on('will-navigate', (event, url) => {
      if (url !== selectionHtmlUrl) event.preventDefault();
    });
    activeOverlay.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        void cancelScreenSelection();
      }
    });
    activeOverlay.on('closed', () => {
      if (selectionWindow === activeOverlay) {
        selectionWindow = undefined;
        selectionCapture = undefined;
        restoreCompanionWindow();
        if (restoreWindowAfterCancel && window && !window.isDestroyed()) window.showInactive();
      }
    });
    await activeOverlay.loadURL(selectionHtmlUrl);
    activeOverlay.show();
    activeOverlay.moveTop();
    activeOverlay.focus();
    app.focus({ steal: true });
    return { ok: true };
  } catch (error) {
    console.error('Screen selection could not start:', error instanceof Error ? error.message : 'unknown error');
    console.info('Screen capture permission at failure:', systemPreferences.getMediaAccessStatus('screen'));
    closeSelectionWindow();
    restoreCompanionWindow();
    selectionCapture = undefined;
    const permission = systemPreferences.getMediaAccessStatus('screen');
    if (permission === 'denied' || permission === 'restricted') {
      const fallback = await beginClipboardQuestion({ permissionFallback: true });
      if (fallback.ok) return fallback;
      state.error = `${screenCapturePermissionError()} ${fallback.error || ''}`.trim();
      window.show();
      window.moveTop();
      window.focus();
      publish();
      return { ok: false, error: state.error };
    }
    state.error = error instanceof Error ? error.message : screenCapturePermissionError();
    window.show();
    window.moveTop();
    window.focus();
    app.focus({ steal: true });
    publish();
    return { ok: false, error: state.error };
  } finally {
    selectionStarting = false;
  }
}

async function finishScreenSelection({ rect, dataUrl }) {
  if (!selectionCapture || !selectionWindow) throw new Error('The screen selection session has expired.');
  const geometry = selectionCapture.geometry;
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key])) ||
      rect.width < 18 || rect.height < 18 || rect.x < geometry.x || rect.y < geometry.y ||
      rect.x + rect.width > geometry.x + geometry.width || rect.y + rect.height > geometry.y + geometry.height) {
    throw new Error('Choose a valid screen region and try again.');
  }
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ||
      Buffer.byteLength(dataUrl, 'utf8') > 12 * 1024 * 1024) {
    throw new Error('圈選圖片太大或格式無法讀取，請縮小範圍後重試。');
  }

  const context = computeSelectionContext(selectionWindows, rect, { pids: ownProcessIds() });
  const primarySource = context[0];
  diagnostics(`圈選完成：範圍 ${Math.round(rect.width)}x${Math.round(rect.height)}；可見視窗 ${selectionWindows.length} 個${lastSnapshotError ? `（視窗清單失敗：${lastSnapshotError}）` : ''}；脈絡＝${context.map((c) => `${c.app}${c.title ? '+標題' : ''} ${Math.round(c.share * 100)}%`).join('、') || '無'}`);
  selectionWindows = [];
  conversation = createConversationSession({
    kind: 'screen',
    context,
    selection: rect,
    hasImage: true,
  }, state.presentationMode);
  // 並排時要一起移動的「原本的程式」（只在小精靈內部使用，不會送給 AI）
  conversation.source.primaryPid = primarySource?.pid;
  conversation.source.primaryApp = primarySource?.app;
  state.error = '';
  state.busy = false;
  selectionCapture = undefined;
  closeSelectionWindow();
  restoreCompanionWindow();
  if (await attachToActiveConversation({ imageDataUrl: dataUrl, context, sourceKind: 'screen' })) return { ok: true };
  window.show();
  applyWindowPresentation();
  window.moveTop();
  window.focus();
  app.focus({ steal: true });
  window.webContents.send('poc:selection-result', { name: '螢幕圈選.png', dataUrl, context });
  publish();
  return { ok: true };
}

async function cancelScreenSelection() {
  if (!selectionWindow) return { ok: true };
  selectionCapture = undefined;
  closeSelectionWindow();
  restoreCompanionWindow();
  if (restoreWindowAfterCancel && window && !window.isDestroyed()) window.showInactive();
  return { ok: true };
}

/**
 * 抓「目前反白的文字」（⌘⇧2）：
 *   1. 先用輔助使用介面直接讀，不碰剪貼簿；
 *   2. 讀不到就等使用者放開修飾鍵後模擬 ⌘C，抓到後把原本的剪貼簿放回去。
 * @returns {Promise<{ text: string, via: string } | undefined>}
 */
async function captureSelectedText(front) {
  let helper;
  try { helper = await getAxHelper(); } catch { return undefined; }
  const viaAx = (await readSelectedText(helper, front.pid)).trim();
  if (viaAx) return { text: viaAx, via: '輔助使用介面' };
  if (!systemPreferences.isTrustedAccessibilityClient(false)) return undefined;

  for (let i = 0; i < 20 && await modifiersDown(helper); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const now = await frontmostApplication();
  if (!now || now.pid !== front.pid) return undefined; // 焦點已經換掉，不亂按 ⌘C
  const saved = await clipboardIO.snapshot();
  let copied = '';
  try {
    clipboard.clear(); // 先清空，才分得出 ⌘C 有沒有真的複製到東西
    await pressKey({ key: 'c', mods: ['command'] });
    for (let i = 0; i < 12 && !copied; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      copied = (await clipboardIO.read()).text.trim();
    }
  } catch (error) {
    diagnostics(`模擬 ⌘C 失敗：${error.message}`);
  } finally {
    await clipboardIO.restore(saved).catch(() => {});
  }
  return copied ? { text: copied, via: '模擬 ⌘C（已還原剪貼簿）' } : undefined;
}

async function beginClipboardQuestion({ permissionFallback = false } = {}) {
  if (!window || window.isDestroyed()) return { ok: false, error: 'Screen Spirit 對話視窗目前無法使用。' };
  if (conversation.messages.length) {
    state.error = '目前對話仍保留中。請先完成或清除這段測試對話，再開始新的提問。';
    window.show();
    window.focus();
    publish();
    return { ok: false, error: state.error };
  }

  // 在小精靈視窗出現前記下前景程式，作為剪貼簿內容的來源（R-CLIP-04：只附程式名稱）。
  const front = await frontmostApplication();
  const clipboardContext = front && !ownProcessIds().has(front.pid) ? [{ app: front.name, title: '', share: null }] : [];
  diagnostics(`剪貼簿模式：前景程式＝${front ? front.name : '取得失敗'}${front && ownProcessIds().has(front.pid) ? '（是小精靈自己，不附帶）' : ''}`);
  // 反白文字優先；抓不到才用剪貼簿裡原本的內容
  const selected = front && !ownProcessIds().has(front.pid) ? await captureSelectedText(front) : undefined;
  let text;
  let imageDataUrl;
  if (selected) {
    text = selected.text.slice(0, 20000);
    diagnostics(`反白文字：${text.length} 字（${selected.via}）`);
  } else {
    const content = await clipboardIO.read();
    text = content.text.trim();
    imageDataUrl = content.image ? content.image.toDataURL() : undefined;
    diagnostics(`沒有抓到反白文字，改用剪貼簿：文字 ${text.length} 字、圖片 ${content.image ? '有' : '無'}`);
  }
  if (!text && !imageDataUrl) {
    state.error = '沒有抓到反白的文字，剪貼簿也是空的。請先在來源程式反白一段文字，再按 ⌘⇧2。';
    window.show();
    window.focus();
    publish();
    return { ok: false, error: state.error };
  }

  const fingerprint = createHash('sha256').update(text).update('\0').update(imageDataUrl ?? '').digest('hex');
  let lastFingerprint = '';
  try { lastFingerprint = (await readFile(clipboardFingerprintPath, 'utf8')).trim(); } catch {}
  // 只有「沿用剪貼簿舊內容」時才擋重複；剛反白抓到的文字，就算和上次一樣也是使用者這次的選擇
  if (!selected && fingerprint === lastFingerprint) {
    state.error = '沒有抓到反白的文字，而剪貼簿內容與上次已送出的相同。請先反白新的文字，再按 ⌘⇧2。';
    window.show();
    window.focus();
    publish();
    return { ok: false, error: state.error };
  }

  pendingClipboardFingerprint = fingerprint;
  conversation = createConversationSession({ kind: 'clipboard', context: clipboardContext, hasImage: Boolean(imageDataUrl) }, state.presentationMode);
  if (clipboardContext.length) {
    conversation.source.primaryPid = front.pid;
    conversation.source.primaryApp = front.name;
  }
  if (await attachToActiveConversation({ imageDataUrl, sourceText: text, context: clipboardContext, sourceKind: 'clipboard' })) {
    try { await writeFile(clipboardFingerprintPath, fingerprint, { mode: 0o600 }); } catch {}
    pendingClipboardFingerprint = undefined;
    return { ok: true };
  }
  state.error = '';
  state.busy = false;
  selectionCapture = undefined;
  window.show();
  applyWindowPresentation();
  window.moveTop();
  window.focus();
  app.focus({ steal: true });
  window.webContents.send('poc:clipboard-result', {
    text,
    imageDataUrl,
    context: clipboardContext,
    warning: permissionFallback
      ? '螢幕錄製未授權，已改用剪貼簿內容。未複製的畫面與周邊文字無法分析，結果可能有誤差。'
      : (selected ? '反白文字模式：只會附上你反白的文字與來源程式。' : '剪貼簿模式只會分析已複製的內容；周邊畫面與未複製文字可能造成分析誤差。'),
  });
  publish();
  return { ok: true };
}

async function finishCurrentConversation({ reveal = true } = {}) {
  clearTimeout(historySaveTimer);
  historySaveTimer = undefined;
  const archived = structuredClone(conversation);
  for (const message of archived.messages) {
    if (message.status === 'streaming') message.status = 'cancelled';
  }
  if (archived.messages.length) {
    try {
      if (!historyStore) throw new Error('History storage is not ready.');
      await historyWriteQueue;
      await historyStore.save(archived);
    } catch (error) {
      state.error = `無法保存這段對話，所以還沒有退出：${error instanceof Error ? error.message : '未知錯誤'}`;
      publish();
      return { ok: false, error: state.error };
    }
    void curateAfterConversation(archived);
  }

  activeRequest?.abort();
  activeRequest = undefined;
  state.busy = false;
  state.error = '';
  pendingClipboardFingerprint = undefined;
  selectionCapture = undefined;
  conversation = createConversationSession({}, state.presentationMode);
  applyWindowPresentation();
  if (window && !window.isDestroyed()) {
    window.webContents.send('poc:conversation-finished');
    if (reveal) {
      window.show();
      window.moveTop();
      window.focus();
    }
  }
  publish();
  return { ok: true };
}

function ownProcessIds() {
  return new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]);
}

function sanitizeContext(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 3).flatMap((item) => (item && typeof item.app === 'string' && item.app.trim()
    ? [{
        app: item.app.trim().slice(0, 80),
        title: typeof item.title === 'string' ? item.title.slice(0, 160) : '',
        share: Number.isFinite(item.share) ? Math.min(1, Math.max(0, item.share)) : null,
      }]
    : []));
}

// 這些 AI 的對話只存在這台 Mac（不會出現在 claude.ai、ChatGPT 等網頁或 App 的歷史清單）
const LOCAL_ONLY_KINDS = new Set(['cli', 'api', 'ollama', 'builtin']);
function cliWorkspaces() {
  const base = app.getPath('userData');
  return { claude: join(base, 'claude-cli-workspace'), codex: join(base, 'codex-workspace'), gemini: join(base, 'gemini-workspace') };
}
let localSessionIndex = new Map(); // 清單裡的 id → 檔案位置（打開時用）

async function listHistorySummaries() {
  const records = historyStore ? await historyStore.list() : [];
  let localSessions = [];
  try {
    localSessions = await listLocalSessions({ workspaces: cliWorkspaces() });
  } catch (error) {
    diagnostics(`讀取本機 AI 紀錄失敗：${error.message}`);
  }
  localSessionIndex = new Map(localSessions.map((entry) => [entry.id, entry]));
  const localIds = new Set(localSessions.map((entry) => entry.sessionId));

  const spirit = records
    // 同一段 Claude Code／Codex／Gemini 對話，工具自己的紀錄保留比較久：只列那一筆
    .filter((record) => !(record.delivery?.sessionId && localIds.has(record.delivery.sessionId)))
    .map((record) => {
      const firstQuestion = record.messages.find((message) => message.role === 'user');
      const target = record.delivery?.targetId ? findTarget(record.delivery.targetId) : undefined;
      const kind = record.delivery?.targetId ? (target?.kind || 'app') : 'builtin';
      return {
        id: record.id,
        origin: 'spirit',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt || record.createdAt,
        expiresAt: record.expiresAt,
        retention: '小精靈會在建立的 24 小時後自動刪除（加密保存）',
        sourceKind: record.source?.kind || 'test',
        targetId: record.delivery?.targetId || 'builtin',
        targetLabel: (target?.label || record.delivery?.targetLabel || '小精靈內建（ChatGPT 方案）').replace(/（.*）/, ''),
        spiritName: record.delivery?.spiritName || record.spiritName || '',
        localOnly: LOCAL_ONLY_KINDS.has(kind),
        title: firstQuestion?.text || '（沒有文字問題）',
        searchText: record.messages.map((message) => message.text || '').join('\n').slice(0, 6000),
        messageCount: record.messages.length,
      };
    });
  const tools = localSessions.map(({ path, ...entry }) => ({ ...entry, localOnly: true, sourceKind: 'cli' }));
  return [...spirit, ...tools].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** 打開 Claude Code／Codex／Gemini 自己保存的對話：載入訊息，並接上原本的 session，追問會接著問 */
async function openLocalSession(id) {
  const entry = localSessionIndex.get(id);
  if (!entry) return { ok: false, error: '找不到這段對話，可能已經被刪除。請重新打開歷史紀錄。' };
  const messages = await loadLocalSession(entry);
  if (!messages.length) return { ok: false, error: '這段對話裡沒有可以顯示的內容。' };
  const target = findTarget(entry.targetId);
  const name = TOOL_INFO[entry.origin]?.name || entry.targetLabel;
  activeRequest?.abort();
  activeRequest = undefined;
  conversation = createConversationSession({}, state.presentationMode);
  conversation.createdAt = entry.createdAt || conversation.createdAt;
  conversation.messages = messages.map((message) => (message.role === 'user'
    ? { role: 'user', text: message.text, ...(message.imageDataUrl ? { imageDataUrl: message.imageDataUrl } : {}) }
    : { role: 'assistant', label: name, status: 'complete', text: message.text }));
  conversation.delivery = { targetId: entry.targetId, targetLabel: target?.label || name, live: true, sessionId: entry.sessionId, at: entry.updatedAt };
  conversation.phase = 'follow-up';
  state.busy = false;
  state.error = '';
  applyWindowPresentation();
  publish();
  diagnostics(`打開本機紀錄：${name}（${messages.length} 則訊息）`);
  if (window && !window.isDestroyed()) {
    window.show();
    window.moveTop();
    window.focus();
    const firstUser = conversation.messages.find((message) => message.role === 'user');
    window.webContents.send('poc:history-opened', { sourceKind: 'test', sourceText: '', imageDataUrl: firstUser?.imageDataUrl || '', continues: name });
  }
  return { ok: true };
}

function historySourcePreview(record) {
  const firstUser = record.messages.find((message) => message.role === 'user');
  return {
    sourceKind: record.source?.kind || 'test',
    sourceText: firstUser?.sourceText || '',
    imageDataUrl: firstUser?.imageDataUrl || '',
  };
}

handle('get-state', () => snapshot());
handle('finish-conversation', () => finishCurrentConversation());
handle('list-history', () => listHistorySummaries());
handle('delete-history', async (id) => {
  if (!historyStore) throw new Error('History storage is not ready.');
  await historyStore.delete(id);
  return listHistorySummaries();
});
handle('clear-history', async () => {
  if (!historyStore) throw new Error('History storage is not ready.');
  await historyStore.clear();
  return listHistorySummaries(); // Claude Code／Codex／Gemini 自己的紀錄不受影響，照樣列出
});
handle('open-history', async (id) => {
  if (typeof id === 'string' && id.includes(':')) return openLocalSession(id);
  if (!historyStore) throw new Error('History storage is not ready.');
  const record = await historyStore.load(id);
  if (!record) return { ok: false, error: '這筆歷史紀錄已到期或不存在。' };
  activeRequest?.abort();
  activeRequest = undefined;
  for (const message of record.messages) {
    if (message.status === 'streaming') message.status = 'cancelled';
  }
  conversation = record;
  // 指令列 AI 的對話：工具那邊的 session 還在的話，接著問會接續同一段（--resume）
  const continues = record.delivery?.sessionId && findTarget(record.delivery.targetId)?.kind === 'cli';
  if (continues) record.delivery.live = true;
  if (!isPresentationMode(conversation.presentationMode)) conversation.presentationMode = state.presentationMode;
  state.busy = false;
  state.error = '';
  state.presentationMode = conversation.presentationMode;
  applyWindowPresentation();
  publish();
  if (window && !window.isDestroyed()) {
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.send('poc:history-opened', { ...historySourcePreview(record), ...(continues ? { continues: (findTarget(record.delivery.targetId)?.label || '').replace(/（.*）/, '') } : {}) });
  }
  return { ok: true };
});
handle('begin-selection', () => beginScreenSelection());
handle('begin-clipboard', () => beginClipboardQuestion());
handle('set-layout-mode', async (mode) => {
  await setLayoutMode(mode);
  publish();
  return { ok: true, layoutMode };
});
handle('drawer-action', async (action) => {
  if (action === 'toggle') await drawer.toggle();
  else if (action === 'pin') await drawer.setPinned(!drawer.isPinned());
  else if (action === 'restore') await restoreDockedWindows();
  publish();
  return { ok: true };
});
ipcMain.handle('companion:begin-selection', (event) => {
  assertTrustedCompanionSender(event);
  return beginScreenSelection();
});
ipcMain.handle('companion:begin-clipboard', (event) => {
  assertTrustedCompanionSender(event);
  return beginClipboardQuestion();
});
ipcMain.handle('companion:get-bounds', (event) => {
  assertTrustedCompanionSender(event);
  return companionWindow.getBounds();
});
ipcMain.handle('companion:move', (event, position) => {
  assertTrustedCompanionSender(event);
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return { ok: false };
  const current = companionWindow.getBounds();
  const target = screen.getDisplayNearestPoint({ x: position.x + current.width / 2, y: position.y + current.height / 2 });
  const area = target.workArea;
  const x = clamp(position.x, area.x, area.x + area.width - current.width);
  const y = clamp(position.y, area.y, area.y + area.height - current.height);
  companionWindow.setPosition(Math.round(x), Math.round(y), false);
  return { ok: true };
});
function openChatWindow() {
  if (!window || window.isDestroyed()) return { ok: false };
  window.show();
  window.moveTop();
  window.focus();
  app.focus({ steal: true });
  window.webContents.send('poc:open-chat');
  return { ok: true };
}

ipcMain.handle('companion:open-chat', (event) => {
  assertTrustedCompanionSender(event);
  return openChatWindow();
});

// 小精靈選單（SPEC R-MENU-01）：選單列圖示與小精靈右鍵共用同一份。
function buildSpiritMenu() {
  return Menu.buildFromTemplate([
    { label: '圈選畫面', accelerator: 'CommandOrControl+Shift+1', registerAccelerator: false, click: () => void beginScreenSelection() },
    { label: '用反白文字提問（也可直接按 ⌘⇧2）', accelerator: 'CommandOrControl+Shift+2', registerAccelerator: false, click: () => void beginClipboardQuestion() },
    { label: '開啟對話視窗', click: () => openChatWindow() },
    { label: drawer.isHidden() ? '打開 AI 抽屜（⌘⇧9）' : '收起 AI 抽屜（⌘⇧9）', enabled: drawer.isActive(), click: () => void drawer.toggle() },
    { label: '固定 AI 抽屜（不自動收起、左邊讓出位置）', type: 'checkbox', checked: drawer.isPinned(), enabled: drawer.isActive(), click: (item) => void drawer.setPinned(item.checked) },
    { label: '還原並排的視窗', enabled: dockedWindows.size > 0, click: () => void restoreDockedWindows() },
    {
      label: '並排方式',
      submenu: [
        { label: '抽屜：點其他程式時 AI 自動收進右邊', type: 'radio', checked: layoutMode === 'drawer', click: () => void setLayoutMode('drawer') },
        { label: '固定並排：左 2/3、右 1/3', type: 'radio', checked: layoutMode === 'split', click: () => void setLayoutMode('split') },
      ],
    },
    { type: 'separator' },
    { label: '結束 Screen Spirit', accelerator: 'CommandOrControl+Q', registerAccelerator: false, click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('✦');
  tray.setToolTip('Screen Spirit');
  tray.setContextMenu(buildSpiritMenu());
}

ipcMain.handle('companion:show-menu', (event) => {
  assertTrustedCompanionSender(event);
  buildSpiritMenu().popup({ window: companionWindow });
  return { ok: true };
});
ipcMain.handle('companion:hide-chat', (event) => {
  assertTrustedCompanionSender(event);
  if (window && !window.isDestroyed()) window.hide();
  return { ok: true };
});
handle('hide-chat', () => {
  if (window && !window.isDestroyed()) window.hide();
  return { ok: true };
});
handle('sign-in', async () => {
  state.error = '';
  publish();
  try {
    await chatgpt.signIn(state.session.status === 'connected' ? { reconsent: true } : {});
    await refreshSession();
  } catch (error) {
    state.error = safeError(error);
    await refreshSession();
  }
  return snapshot();
});
handleSelection('get-init', () => {
  if (!selectionCapture) throw new Error('The screen selection session has expired.');
  return { ...selectionCapture, cursor: screen.getCursorScreenPoint() };
});
handleSelection('complete', (payload) => finishScreenSelection(payload));
handleSelection('cancel', () => cancelScreenSelection());
handle('set-model', (model) => {
  if (typeof model !== 'string' || !state.models.some((item) => item.slug === model)) throw new Error('Choose an available model.');
  state.model = model;
  publish();
  return snapshot();
});
handle('set-presentation-mode', async (presentationMode) => {
  if (!isPresentationMode(presentationMode)) throw new Error('Choose a supported answer display mode.');
  await savePresentationMode(preferencesPath, presentationMode);
  state.presentationMode = presentationMode;
  if (!conversation.messages.length && !state.busy && conversation.source.kind === 'test' && !conversation.source.selection) {
    conversation.presentationMode = presentationMode;
    applyWindowPresentation();
  }
  publish();
  return snapshot();
});
handle('send', async ({ question, imageDataUrl, sourceText, spiritId }) => {
  validateQuestion(question, imageDataUrl, sourceText);
  if (state.session.status !== 'connected' || !state.session.sharing) {
    return { ok: false, error: '內建 ChatGPT 還沒連接：請到主視窗「內建 ChatGPT 方案與顯示設定」按「連接 ChatGPT」，或在「送到」改選其他 AI。' };
  }
  if (!state.model) await refreshSession({ manual: true }); // 模型清單沒載入（例如剛開機網路還沒好）：送出前再試一次
  if (!state.model) {
    return { ok: false, error: `內建 ChatGPT 讀不到模型清單，所以還不能送出。${state.builtinError || ''} 可以先在「送到」改選其他 AI。`.trim() };
  }
  if (activeRequest) return { ok: false, error: '上一個回答還在進行中。' };
  const requestConversation = conversation;
  const controller = new AbortController();
  // 精靈：第一次送出時記在這段對話上，追問沿用同一隻
  if (!requestConversation.messages.length && typeof spiritId === 'string' && spiritId) {
    const spirit = (await spiritStore.list()).find((item) => item.id === spiritId);
    if (spirit) Object.assign(requestConversation, { spiritId: spirit.id, spiritName: spirit.name });
  }
  const builtinSpirit = requestConversation.spiritId ? (await spiritStore.list()).find((item) => item.id === requestConversation.spiritId) : undefined;
  const builtinImageModel = spiritImageModel(builtinSpirit);
  const builtinInstructions = builtinSpirit
    ? `${(await prepareSpiritRun(await withDefaultHome(builtinSpirit), { canReadFiles: false })).instructions}${builtinImageModel ? `\n\n${imageInstructions(builtinImageModel)}` : ''}`
    : undefined;

  if (requestConversation.messages.length === 0) {
    requestConversation.source = { ...requestConversation.source, hasImage: Boolean(imageDataUrl) };
    if (requestConversation.source.kind === 'clipboard' && pendingClipboardFingerprint) {
      try { await writeFile(clipboardFingerprintPath, pendingClipboardFingerprint, { mode: 0o600 }); }
      catch (error) { console.error('Could not save clipboard freshness marker:', error instanceof Error ? error.message : 'unknown error'); }
      pendingClipboardFingerprint = undefined;
    }
  }
  const userMessage = {
    role: 'user',
    text: question.trim(),
    ...(sourceText ? { sourceText } : {}),
    ...(imageDataUrl ? { imageDataUrl } : {}),
  };
  requestConversation.messages.push(userMessage);
  const answer = { role: 'assistant', text: '', status: 'streaming', ...(requestConversation.spiritName ? { label: requestConversation.spiritName } : {}) };
  requestConversation.messages.push(answer);
  state.busy = true;
  state.error = '';
  requestConversation.phase = 'sending';
  activeRequest = controller;
  publish();

  const input = requestConversation.messages.slice(0, -1).map((message) => {
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    const promptText = message.sourceText
      ? `使用者複製的來源內容：\n${message.sourceText}\n\n使用者問題：\n${message.text}`
      : message.text;
    const content = [{ type: 'input_text', text: promptText }];
    if (message.imageDataUrl) content.push({ type: 'input_image', image_url: message.imageDataUrl, detail: 'auto' });
    return { role: 'user', content };
  });

  try {
    const result = await chatgpt.streamResponse({
      model: state.model,
      input,
      ...(builtinInstructions ? { instructions: builtinInstructions } : {}),
      onDelta: (delta) => {
        requestConversation.phase = 'answering';
        answer.text += delta;
        if (conversation === requestConversation) publish('poc:delta', { delta });
      },
      signal: controller.signal,
    });
    answer.text = result.text;
    answer.status = 'complete';
    requestConversation.phase = 'follow-up';
    if (builtinImageModel) {
      activeRequest = undefined;
      await drawSpiritImage({ conversationRef: requestConversation, answer, imageModel: builtinImageModel, imageSize: builtinSpirit.ai.imageSize, referenceDataUrl: imageDataUrl });
    }
    return { ok: true };
  } catch (error) {
    answer.status = controller.signal.aborted ? 'cancelled' : 'failed';
    requestConversation.phase = 'recoverable';
    if (conversation === requestConversation) state.error = safeError(error);
    return { ok: false, error: conversation === requestConversation ? state.error : 'Conversation closed.' };
  } finally {
    if (conversation === requestConversation) {
      state.busy = false;
      activeRequest = undefined;
      publish();
    }
  }
});
// 投遞到使用者選的 AI（DESIGN §4）。每次新圈選＝一段新對話；同一段對話內可以從小精靈對話框追問。
// 三種情況：
//   1. Claude Code 背景模式（kind: 'cli'）：直接在背景提問，回覆串流進對話框。
//   2. 有 readBack 的 App（Claude 桌面版）：貼上並送出後，從 App 畫面讀回回覆。
//   3. 其他 App：貼上並送出後就結束，回覆在該 App 查看。
const CLAUDE_CLI_TARGET = { id: 'claude-cli', label: 'Claude Code（背景，回覆顯示在小精靈）', kind: 'cli', cli: 'claude', acceptsImage: true };
const CODEX_CLI_TARGET = { id: 'codex-cli', label: 'Codex（背景，回覆顯示在小精靈）', kind: 'cli', cli: 'codex', acceptsImage: true };
const GEMINI_CLI_TARGET = { id: 'gemini-cli', label: 'Gemini CLI（背景，回覆顯示在小精靈）', kind: 'cli', cli: 'gemini', acceptsImage: true };
const OLLAMA_TARGET = { id: 'ollama', label: 'Ollama（本機模型）', kind: 'ollama', acceptsImage: true };
const MIXROUTE_TARGET = { id: 'mixroute', label: 'MixRoute（API）', kind: 'api', acceptsImage: true };
const SPECIAL_TARGETS = Object.fromEntries([CLAUDE_CLI_TARGET, CODEX_CLI_TARGET, GEMINI_CLI_TARGET, OLLAMA_TARGET, MIXROUTE_TARGET].map((t) => [t.id, t]));

/** 所有目標，依連線設定的清單順序；使用者自己在 delivery-targets.json 加的 App 排在後面 */
function allTargets() {
  const ordered = CATALOG.map(({ id }) => SPECIAL_TARGETS[id] || deliveryTargets[id]).filter(Boolean);
  const extras = Object.values(deliveryTargets).filter((target) => !CATALOG.some(({ id }) => id === target.id));
  return [...ordered, ...extras];
}

function findTarget(id) {
  return SPECIAL_TARGETS[id] || deliveryTargets[id];
}

// ── 連線設定：偵測這台電腦上有哪些 AI、使用者同意連接哪些 ──
const consentPath = join(app.getPath('userData'), 'integrations.json');
let consent = { decided: false, enabled: {} };
let detection = {};
let detecting = false;
let ollamaStatus = { running: false, models: [], vision: {} };

async function runDetection() {
  if (detecting) return;
  detecting = true;
  publish();
  try {
    const started = Date.now();
    detection = await detectIntegrations({
      findCli: (name) => (name === 'claude' ? findClaudeCli().catch(() => '') : findCli(name)),
      probeOllama: async () => (ollamaStatus = await probeOllama()),
    });
    await Promise.all(['claude-cli', 'codex-cli'].map(async (id) => {
      const item = detection[id];
      if (!item?.installed || !item.path) return;
      item.loggedIn = await checkCliLogin(item.path, CLI_TARGETS_BY_ID[id]);
      if (item.loggedIn === false) item.detail = '已安裝，但還沒登入';
      else if (item.loggedIn === true) item.detail = '已安裝・已登入';
    }));
    diagnostics(`偵測可連接的 AI（${Date.now() - started} ms）：${CATALOG.map(({ id }) => `${id}=${detection[id]?.installed ? (detection[id].loggedIn === false ? '有（未登入）' : '有') : '無'}`).join('、')}`);
  } finally {
    detecting = false;
    publish();
  }
}

/** 使用者自己加的 App（不在清單裡）：照舊可用，不需要同意流程 */
function targetAvailability(id) {
  if (!CATALOG.some((item) => item.id === id)) return { available: true, reason: '' };
  return availability(id, detection, consent);
}

handle('integrations-detect', async () => {
  await runDetection();
  return { ok: true };
});
handle('integrations-save', async (payload) => {
  // 新版畫面送 { enabled, defaultTarget }；舊版只送 enabled
  const enabled = payload && typeof payload.enabled === 'object' ? payload.enabled : payload;
  const defaultTarget = typeof payload?.defaultTarget === 'string' ? payload.defaultTarget : consent.defaultTarget;
  consent = await saveConsent(consentPath, enabled, defaultTarget);
  diagnostics(`連線設定已儲存：${CATALOG.filter(({ id }) => consent.enabled[id]).map(({ id }) => id).join('、') || '（全部不啟用）'}`);
  await refreshSession(); // 內建 ChatGPT 有沒有勾選會影響要不要去連線
  return { ok: true };
});
// 主視窗改了「預設送到」：記下來（精靈選「跟著預設」時、工作流、記憶整理都用它）
handle('default-target-set', async (targetId) => {
  if (typeof targetId !== 'string' || !consent.decided) return { ok: false };
  consent = await saveConsent(consentPath, consent.enabled, targetId);
  publish();
  return { ok: true };
});
/**
 * 第一次安裝（還沒有任何精靈）：放進內建的範例精靈（seed-spirits/*.json）。
 * 範例精靈的 AI 一律「跟著預設」、資料庫用預設位置；已經在用的電腦（有 spirits.json）完全不動。
 */
/** 範例精靈裡所有「指定 AI / 模型」都清空 → 一律跟著使用者在第一次設定選的預設 AI */
function scrubSeedAi(value) {
  if (Array.isArray(value)) return value.map(scrubSeedAi);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['targetId', 'model', 'fallbackTargetId', 'imageModel'].includes(key) ? '' : scrubSeedAi(item)]));
}
async function seedSpiritsIfFresh() {
  try { await stat(join(app.getPath('userData'), 'spirits.json')); return; } catch {}
  let files = [];
  try { files = (await readdir(join(directory, 'seed-spirits'))).filter((name) => name.endsWith('.json')).sort(); } catch { return; }
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(directory, 'seed-spirits', file), 'utf8'));
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = scrubSeedAi(raw);
      await spiritStore.save(defaultSpirit({ ...rest, memory: { ...(rest.memory || {}), home: null, notes: '', sources: [], knowledge: '' } }));
      diagnostics(`第一次安裝：放進範例精靈 ${file}`);
    } catch (error) {
      diagnostics(`範例精靈 ${file} 讀取失敗（${error.message}）`);
    }
  }
}

/** 預設 AI：使用者設定的預設；不能用時挑第一個能用的 */
function defaultAiTarget() {
  if (consent.defaultTarget && targetAvailability(consent.defaultTarget).available) return consent.defaultTarget;
  return allTargets().map((target) => target.id).find((id) => targetAvailability(id).available) || '';
}
/** 精靈用哪個 AI：精靈有指定就用指定的；沒指定（跟著預設）就用預設 AI */
const spiritTargetId = (spirit) => spirit?.ai?.targetId || defaultAiTarget();

// ── 第一次使用設定：系統權限（macOS 的輔助使用、螢幕錄製；其他系統不用） ──
function permissionsStatus() {
  if (process.platform !== 'darwin') return { platform: process.platform, accessibility: 'not-needed', screen: 'not-needed' };
  return {
    platform: 'darwin',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied',
    screen: systemPreferences.getMediaAccessStatus('screen'),
  };
}
handle('permissions-status', () => permissionsStatus());
handle('permissions-open', async (kind) => {
  if (process.platform !== 'darwin') return permissionsStatus();
  if (kind === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true); // 讓 macOS 把小精靈放進清單並跳出提示
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  } else if (kind === 'screen') {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {}); // 讓 macOS 把小精靈放進清單
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return permissionsStatus();
});
// 第一次設定：沒安裝的 AI 給下載／安裝連結（只開清單裡寫好的 https 網址）
handle('open-install-link', async (id) => {
  const url = CATALOG.find((item) => item.id === id)?.install?.url;
  if (!url || !/^https:\/\//.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});
// 螢幕錄製權限要重開才生效
handle('app-relaunch', () => { app.relaunch(); setTimeout(() => app.exit(0), 200); return { ok: true }; });

// ── 指令列 AI 登入：打開終端機執行登入指令，等它完成 ──
const CLI_TARGETS_BY_ID = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'gemini-cli': 'gemini' };
const loginControllers = new Map();
function markCliLogin(targetId, status) {
  const cli = CLI_TARGETS_BY_ID[targetId];
  state.cliLogin = { ...state.cliLogin, [targetId]: { status, name: CLI_LOGIN[cli]?.name || targetId, at: Date.now() } };
  publish();
}
async function cliBinary(targetId) {
  const cli = CLI_TARGETS_BY_ID[targetId];
  if (detection[targetId]?.path) return detection[targetId].path;
  return cli === 'claude' ? findClaudeCli().catch(() => '') : findCli(cli);
}
handle('cli-login', async (targetId) => {
  const cli = CLI_TARGETS_BY_ID[targetId];
  if (!cli) return { ok: false, error: '這個 AI 不需要在這裡登入。' };
  const binary = await cliBinary(targetId);
  if (!binary) return { ok: false, error: `找不到 ${CLI_LOGIN[cli].name} 的指令，請先安裝。` };
  loginControllers.get(targetId)?.abort();
  const controller = new AbortController();
  loginControllers.set(targetId, controller);
  const wasLoggedIn = detection[targetId]?.loggedIn ?? null;
  let markerPath;
  try {
    ({ markerPath } = await openLoginTerminal({ binary, cli, workDir: join(app.getPath('userData'), 'cli-login') }));
  } catch (error) {
    diagnostics(`${CLI_LOGIN[cli].name}：打不開終端機登入（${error.message}）`);
    return { ok: false, error: `打不開終端機。請自己打開「終端機」執行：${cli === 'claude' ? 'claude auth login' : cli === 'codex' ? 'codex login' : 'gemini'}` };
  }
  diagnostics(`${CLI_LOGIN[cli].name}：已打開終端機登入，等待完成`);
  markCliLogin(targetId, 'waiting');
  void waitForLogin({ binary, cli, markerPath, signal: controller.signal, wasLoggedIn }).then((result) => {
    if (result === 'cancelled') return;
    loginControllers.delete(targetId);
    diagnostics(`${CLI_LOGIN[cli].name}：登入${{ done: '完成', failed: '沒有完成', timeout: '等太久，已停止等待' }[result]}`);
    if (result === 'done' && detection[targetId]) {
      detection[targetId].loggedIn = cli === 'gemini' ? null : true;
      detection[targetId].detail = cli === 'gemini' ? '已安裝' : '已安裝・已登入';
    }
    markCliLogin(targetId, result);
    if (result === 'done' && Notification.isSupported()) {
      new Notification({ title: 'Screen Spirit', body: `${CLI_LOGIN[cli].name} 已登入，可以使用了。`, silent: true }).show();
    }
    if (result === 'done') openChatWindowIfDialog();
  });
  return { ok: true };
});
// 登入完成後把小精靈對話框叫回前面（使用者剛剛在終端機與瀏覽器裡）
function openChatWindowIfDialog() {
  if (window && !window.isDestroyed() && window.isVisible()) window.show();
}

// ── 以專案為單位的編輯器（Kiro）：列出最近的專案、選資料夾或開新專案 ──
const projectStore = createProjectStore(join(app.getPath('userData'), 'projects.json'));
handle('projects-list', async (targetId) => {
  const target = findTarget(targetId);
  if (!target?.projectBased) return [];
  return listProjects({ appDataName: target.appDataName, store: projectStore, appKey: target.id });
});
handle('projects-pick', async ({ targetId, mode }) => {
  const target = findTarget(targetId);
  if (!target?.projectBased) return { ok: false };
  const creating = mode === 'new';
  const options = {
    title: creating ? `開新專案（${target.app}）` : `選擇專案資料夾（${target.app}）`,
    message: creating ? '按左下角「新增檔案夾」建立一個新資料夾，選好後按「用這個資料夾」。' : `選一個資料夾，${target.app} 會用它當專案打開。`,
    buttonLabel: '用這個資料夾',
    defaultPath: creating ? app.getPath('documents') : app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
  };
  const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined;
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  const path = picked.filePaths[0];
  await projectStore.remember(target.id, path);
  diagnostics(`${target.app}：選了專案資料夾（${creating ? '新專案' : '既有'}）`);
  return { ok: true, path };
});

// ── 精靈博士：管理專項小精靈 ──
const spiritStore = createSpiritStore(join(app.getPath('userData'), 'spirits.json'));
handle('spirits-list', () => spiritStore.list());
handle('spirits-create', async () => {
  const spirit = await spiritStore.save(defaultSpirit());
  diagnostics('精靈博士：新增一隻精靈');
  return spirit;
});
handle('spirits-save', (spirit) => spiritStore.save(spirit));
handle('spirits-delete', async (id) => {
  const list = await spiritStore.remove(id);
  await skins().remove(id).catch(() => {});
  if (desktopSpiritId === id) await setDesktopSpirit('');
  diagnostics('精靈博士：刪除一隻精靈');
  return list;
});
// ── 精靈造型：匯入設定圖 → 分層造型包（SKIN-SPEC.md）；桌面小精靈依目前的精靈換造型、依狀態換表情 ──
let skinService;
function skins() {
  skinService ??= createSkinService({
    userData: app.getPath('userData'),
    directory,
    nativeImage,
    getApiKey: loadMixRouteKey,
    getModelEntries: () => (mixrouteStatus.models || []).map((id) => ({ id, entry: mixrouteEntries[id] })),
    ensureHelper: ensureAxHelper,
    onProgress: (event) => { if (window && !window.isDestroyed()) window.webContents.send('poc:skin-progress', event); },
    log: (message) => diagnostics(message),
  });
  return skinService;
}
async function refreshCompanionSkin(spiritId) {
  if (companionSkinId === spiritId) { companionSkinId = undefined; syncCompanion(); }
}
handle('skin-models', () => skins().models());
handle('skin-draft', (spiritId) => skins().draft(spiritId));
handle('skin-get', (spiritId) => skins().get(spiritId));
handle('skin-busy', (spiritId) => skins().busy(spiritId));
handle('skin-start', async (options) => {
  await findSpirit(options?.spiritId);
  return skins().start(options);
});
handle('skin-build', async ({ spiritId, parts, only, placements, masks } = {}) => {
  await findSpirit(spiritId);
  // placements：組裝台調好的配件擺位（{ 配件: { ref, flip, angle, scale, cx, cy } }），數字由 skin-builder 檢查
  const places = placements && typeof placements === 'object' && !Array.isArray(placements) ? placements : undefined;
  const result = await skins().build({ spiritId, parts, only: Array.isArray(only) ? only.map(String).slice(0, 8) : undefined, placements: places, masks: masks && typeof masks === 'object' && !Array.isArray(masks) ? masks : undefined });
  await refreshCompanionSkin(spiritId);
  return result;
});
handle('skin-card', (spiritId) => skins().card(spiritId));
handle('skin-remove', async (spiritId) => {
  await skins().remove(spiritId);
  await refreshCompanionSkin(spiritId);
  if (desktopSpiritId === spiritId) await setDesktopSpirit('');
});
handle('skin-suggest-hero', (options) => skins().suggestHero(options || {}));
handle('skin-sam-status', () => skins().sam());
handle('skin-sam-install', () => skins().installSam());
handle('skin-desktop-get', () => desktopSpiritId);
// 對話框裡選了精靈（還沒送出）：桌面小精靈先換成牠；只對目前這段對話有效，對話結束就失效
let previewSpirit = { conversationId: '', spiritId: '' };
handle('preview-spirit', (spiritId) => {
  previewSpirit = { conversationId: conversation.id, spiritId: typeof spiritId === 'string' && /^[\w-]{1,64}$/.test(spiritId) ? spiritId : '' };
  syncCompanion();
});
handle('skin-desktop-set', async (spiritId) => {
  if (spiritId) await findSpirit(spiritId);
  await setDesktopSpirit(spiritId || '');
  return desktopSpiritId;
});

// 桌面小精靈：用哪隻精靈的造型（對話中的精靈 → 設為桌面的精靈 → 原本的小精靈）、現在的表情
const desktopSpiritPath = join(app.getPath('userData'), 'desktop-spirit.json');
let desktopSpiritId = '';
let companionSkinId; // 已送給桌面小精靈的精靈 id（undefined＝還沒送）
let companionMood = 'idle';
let companionMoodTimer;
let companionWasBusy = false;
async function loadDesktopSpirit() {
  try { desktopSpiritId = String(JSON.parse(await readFile(desktopSpiritPath, 'utf8'))?.spiritId || ''); } catch { desktopSpiritId = ''; }
}
async function setDesktopSpirit(spiritId) {
  desktopSpiritId = spiritId;
  try { await writeFile(desktopSpiritPath, JSON.stringify({ spiritId }), { mode: 0o600 }); } catch {}
  syncCompanion();
}
function sendCompanion(channel, payload) {
  if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send(channel, payload);
}
function setCompanionMood(mood) {
  clearTimeout(companionMoodTimer);
  companionMood = mood;
  sendCompanion('poc:companion-mood', mood);
  if (mood === 'done' || mood === 'error') {
    companionMoodTimer = setTimeout(() => setCompanionMood('idle'), mood === 'done' ? 2500 : 3000);
    companionMoodTimer.unref?.();
  }
}
function syncCompanion() {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  // 用哪隻精靈的造型：這段對話用的精靈 → 對話框裡剛選的精靈 → 設為桌面小精靈的那隻 → 原本的小精靈
  const previewed = previewSpirit.conversationId === conversation.id ? previewSpirit.spiritId : '';
  const spiritId = conversation.delivery?.spiritId || conversation.spiritId || previewed || desktopSpiritId || '';
  if (spiritId !== companionSkinId) {
    companionSkinId = spiritId;
    void (spiritId ? skins().get(spiritId) : Promise.resolve(null)).catch(() => null).then((skin) => {
      if (companionSkinId === spiritId) sendCompanion('poc:companion-skin', skin);
    });
  }
  const busy = Boolean(state.busy);
  if (busy && !companionWasBusy) setCompanionMood('work');
  if (!busy && companionWasBusy) {
    const last = [...conversation.messages].reverse().find((message) => message.role === 'assistant' && !message.generated);
    setCompanionMood(last?.status === 'failed' ? 'error' : last?.status === 'complete' ? 'done' : 'idle');
  }
  companionWasBusy = busy;
}

// ── 精靈的資料庫（資料夾／Obsidian／雲端硬碟）與長期記憶 ──
// 沒有選資料庫位置的精靈：用預設位置「文件／Screen Spirit／精靈資料庫／精靈名稱」（只在用的時候套用，不改精靈的設定）
const defaultKbRoot = () => join(app.getPath('documents'), 'Screen Spirit', '精靈資料庫');
const safeFolderName = (name) => String(name || '小精靈').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '小精靈';
async function withDefaultHome(spirit) {
  if (!spirit || spirit.memory.home?.path) return spirit;
  const path = join(defaultKbRoot(), safeFolderName(spirit.name));
  await mkdir(path, { recursive: true }).catch(() => {});
  return { ...spirit, memory: { ...spirit.memory, home: { kind: 'local', path, label: `文件／Screen Spirit／精靈資料庫／${safeFolderName(spirit.name)}`, provider: '', isDefault: true } } };
}
async function findSpirit(spiritId) {
  const spirit = (await spiritStore.list()).find((item) => item.id === spiritId);
  if (!spirit) throw new Error('找不到這隻精靈。');
  return withDefaultHome(spirit);
}
/** 畫面只能指定「這隻精靈的資料庫」或「第幾個參考資料夾」，不能傳任意路徑進來 */
async function spiritRoot(spiritId, rootKey) {
  const spirit = await findSpirit(spiritId);
  if (rootKey === 'home') {
    if (!spirit.memory.home?.path) throw new Error('還沒有設定資料庫位置。');
    return { spirit, root: spirit.memory.home.path };
  }
  const source = spirit.memory.sources[Number(String(rootKey).replace(/^source:/, ''))];
  if (!source || source.kind !== 'folder') throw new Error('找不到這個參考資料夾。');
  return { spirit, root: source.path };
}
handle('kb-locations', () => detectStorageLocations());
handle('kb-choose-home', async ({ spiritId, location }) => {
  const spirit = await findSpirit(spiritId);
  let base;
  let kind = 'local';
  let label;
  let provider = '';
  let ownFolder = true;
  if (location?.kind === 'pick') {
    const options = {
      title: `選擇「${spirit.name}」的資料庫資料夾`,
      message: '精靈會讀這個資料夾裡的資料，長期記憶也會存在裡面的「記憶」資料夾。',
      buttonLabel: '用這個資料夾',
      properties: ['openDirectory', 'createDirectory'],
    };
    const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined;
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
    base = picked.filePaths[0];
    label = base.split('/').pop();
    ownFolder = false; // 使用者自己挑的資料夾就直接用
  } else {
    // 從偵測到的清單選：重新偵測一次，確認真的是那些位置之一
    const known = (await detectStorageLocations()).find((item) => item.path === location?.path);
    if (!known) throw new Error('找不到這個位置，請重新偵測。');
    ({ kind, provider } = known);
    base = known.path;
    label = `${known.label} / 小精靈 / ${spirit.name}`;
  }
  const folder = await prepareSpiritFolder(base, spirit.name, { ownFolder });
  spirit.memory.home = { kind, path: folder, label, provider };
  const saved = await spiritStore.save(spirit);
  diagnostics(`精靈博士：設定資料庫位置（${provider || kind}）`);
  return { ok: true, spirit: saved };
});
handle('kb-clear-home', async (spiritId) => {
  const spirit = await findSpirit(spiritId);
  spirit.memory.home = null;
  return { ok: true, spirit: await spiritStore.save(spirit) };
});
handle('kb-list', async ({ spiritId, rootKey, rel }) => {
  const { root } = await spiritRoot(spiritId, rootKey);
  return listDirectory(root, rel || '');
});
handle('kb-read', async ({ spiritId, rootKey, rel }) => {
  const { root } = await spiritRoot(spiritId, rootKey);
  return readPreview(root, rel);
});
handle('kb-reveal', async ({ spiritId, rootKey, rel }) => {
  const { root } = await spiritRoot(spiritId, rootKey);
  const { targetReal } = await resolveInside(root, rel || '');
  shell.showItemInFolder(targetReal);
  return { ok: true };
});
handle('kb-open', async ({ spiritId, rootKey, rel }) => {
  const { spirit, root } = await spiritRoot(spiritId, rootKey);
  const { targetReal } = await resolveInside(root, rel || '');
  // Obsidian 筆記庫裡的 Markdown：直接用 Obsidian 打開
  if (rootKey === 'home' && spirit.memory.home?.kind === 'obsidian' && targetReal.endsWith('.md')) {
    await shell.openExternal(`obsidian://open?path=${encodeURIComponent(targetReal)}`);
  } else {
    const error = await shell.openPath(targetReal);
    if (error) throw new Error(error);
  }
  return { ok: true };
});

/** 只拿回文字的 AI 呼叫（整理記憶用；不顯示在對話框、不留在 Claude Code／Codex 的對話紀錄清單） */
const TEXT_KINDS = new Set(['cli', 'api', 'ollama', 'builtin']);
async function askText({ targetId, model, prompt, signal }) {
  const target = targetId === 'builtin' ? { id: 'builtin', kind: 'builtin', label: '內建 ChatGPT' } : findTarget(targetId);
  if (!target) throw new Error('找不到指定的 AI。');
  if (!TEXT_KINDS.has(target.kind || 'app')) throw new Error(`${target.label} 是操作 App／網頁的方式，拿不回整理結果。請改選 Claude Code、Codex、Gemini CLI、MixRoute、Ollama 或內建 ChatGPT。`);
  const usable = targetId === 'builtin' ? { available: builtinEnabled(), reason: '未啟用' } : targetAvailability(target.id);
  if (!usable.available) throw new Error(`${target.label} 目前不能用（${usable.reason}）。`);
  const cwd = join(app.getPath('userData'), 'memory-workspace');
  if (target.kind === 'cli') {
    if (target.cli === 'claude') return (await askClaudeCli({ prompt, cwd, signal, log: diagnostics })).text;
    const binary = detection[target.id]?.path || await findCli(target.cli);
    if (!binary) throw new Error(`找不到 ${target.cli} 指令。`);
    return (await (target.cli === 'codex' ? askCodex : askGemini)({ binary, prompt, cwd, signal, log: diagnostics })).text;
  }
  if (target.kind === 'api') {
    const apiKey = await loadMixRouteKey();
    if (!apiKey) throw new Error('還沒有設定 MixRoute API 金鑰。');
    const chosen = model || pickDefaultModel(mixrouteChatModels());
    if (!chosen) throw new Error('MixRoute 沒有可用的模型。');
    assertChatModel(chosen);
    return streamMixRouteChat({ apiKey, model: chosen, messages: [{ role: 'user', content: prompt }], signal });
  }
  if (target.kind === 'ollama') {
    ollamaStatus = await probeOllama();
    if (!ollamaStatus.running) throw new Error('Ollama 沒有在執行，請先打開 Ollama App。');
    const chosen = model || ollamaStatus.models[0];
    if (!chosen) throw new Error('Ollama 還沒有下載任何模型。');
    return streamOllamaChat({ model: chosen, messages: [{ role: 'user', content: prompt }], signal });
  }
  if (!state.model) await refreshSession({ manual: true });
  if (!state.model) throw new Error(state.builtinError || '內建 ChatGPT 讀不到模型清單。');
  return (await chatgpt.streamResponse({ model: state.model, input: prompt, onDelta: () => {}, signal })).text;
}

// ── 工作流連接器：每張卡片怎麼呼叫 AI ──
const SHORT_LABEL = { builtin: '內建 ChatGPT', 'claude-cli': 'Claude Code（背景）', 'claude-app': 'Claude 桌面 App', 'chatgpt-app': 'ChatGPT 桌面 App', 'chatgpt-web': 'ChatGPT 網頁', 'codex-cli': 'Codex（背景）', 'gemini-cli': 'Gemini CLI（背景）', ollama: 'Ollama', mixroute: 'MixRoute' };
// 每個 AI 能做什麼（卡片庫、卡片上顯示，避免選錯）
function accessNote(target) {
  const kind = target.kind || 'app';
  if (target.id === 'claude-app') return '你電腦上的 Claude：用它自己的本機檔案權限、連接器，可以讀你的檔案；送出時會切到前景幾秒';
  if (kind === 'cli') return '背景執行、不搶畫面；只讀得到你附上的檔案和資料夾，不能操作你的 App';
  if (kind === 'api' || kind === 'builtin') return '雲端模型：讀不到你的電腦；附上的檔案會把文字內容一起送過去';
  if (kind === 'ollama') return '本機模型：讀不到你的電腦；附上的檔案會把文字內容一起送過去';
  return '操作 App／網頁：讀不到你的電腦；附上的檔案會把文字內容一起貼過去';
}
// 操作 App／網頁的 AI，結果怎麼帶回來：
//   ax   在背景讀 App 畫面（輔助使用，不需要 App 在最前面）：Claude 桌面版已驗證；Chrome 網頁也能讀
//   copy 讀不到畫面時的備案：ChatGPT 桌面版與網頁版的「複製最後回覆」快捷鍵（⌘⇧C）
//   file 請 AI 用本機檔案工具把成品存成檔案交回（Claude 桌面版有本機檔案權限時可選）
const APP_RETURN = { 'claude-app': { mode: 'ax', label: '在背景讀取 Claude 畫面', file: true }, 'chatgpt-app': { mode: 'ax', label: '在背景讀取畫面（讀不到才用 ⌘⇧C）', copy: true }, 'chatgpt-web': { mode: 'ax', label: '在背景讀取網頁（讀不到才用 ⌘⇧C）', copy: true }, 'google-ai-mode': { mode: 'ax', label: '在背景讀取網頁' } };
const HANDOFF_START = '<<<交件開始>>>';
const HANDOFF_END = '<<<交件結束>>>';
const handoffFolder = () => join(app.getPath('documents'), 'Screen Spirit 交件');

function workflowTarget(id) {
  return id === 'builtin' ? { id: 'builtin', kind: 'builtin', label: '小精靈內建（ChatGPT 方案）' } : findTarget(id);
}
function workflowAvailability(target) {
  if (!target) return { available: false, reason: '找不到這個 AI' };
  if (target.id === 'builtin') return builtinEnabled() ? { available: true, reason: '' } : { available: false, reason: '未啟用' };
  return targetAvailability(target.id);
}
const canReturnText = (target) => Boolean(target) && (TEXT_KINDS.has(target.kind || 'app') || Boolean(APP_RETURN[target.id]));

/** 工作流的卡片庫：所有已串接的 AI，以及每隻精靈用的 AI */
async function workflowCatalog() {
  const targets = [workflowTarget('builtin'), ...allTargets()];
  const tools = targets.map((target) => {
    const kind = target.kind || 'app';
    return {
      id: target.id, label: target.label, short: SHORT_LABEL[target.id] || target.app || target.label.replace(/（.*）/, ''), kind, access: accessNote(target),
      canReturn: canReturnText(target),
      ...(APP_RETURN[target.id] ? { returnVia: APP_RETURN[target.id].label, fileReturn: Boolean(APP_RETURN[target.id].file) } : {}),
      ...(BACKGROUND_ALT[target.id] ? { backgroundAlt: backgroundAlternative(target.id)?.id || '' } : {}),
      ...workflowAvailability(target),
      ...(kind === 'api' ? { models: mixrouteChatModels(), defaultModel: pickDefaultModel(mixrouteChatModels()) } : {}),
      ...(kind === 'ollama' ? { models: ollamaStatus.models, defaultModel: ollamaStatus.models[0] || '' } : {}),
    };
  });
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const spirits = (await spiritStore.list()).map((spirit) => {
    const tool = byId.get(spiritTargetId(spirit));
    return {
      id: spirit.id, name: spirit.name, color: spirit.color, summary: spirit.summary || '',
      targetId: spiritTargetId(spirit), model: spirit.ai.targetId ? spirit.ai.model : '',
      aiLabel: tool ? `${tool.short}${spirit.ai.targetId && spirit.ai.model ? ` · ${spirit.ai.model}` : ''}${spirit.ai.targetId ? '' : '（跟著預設）'}` : '還沒有可用的 AI',
      canReturn: tool ? tool.canReturn : true,
      available: Boolean(tool?.available),
      reason: tool ? tool.reason : '還沒指定 AI，請到精靈博士的「指定 AI」設定',
    };
  });
  return { tools, spirits, handoffFolder: handoffFolder() };
}

/** 拿回文字（可串流、可帶工作指示）：給工作流的精靈／AI 工具卡片用 */
async function askWorkflowText({ targetId, model, system, dirs = [], prompt, signal, onDelta = () => {} }) {
  const target = workflowTarget(targetId);
  const usable = workflowAvailability(target);
  if (!usable.available) throw new Error(`${target?.label || targetId} 目前不能用（${usable.reason}）。`);
  const cwd = join(app.getPath('userData'), 'workflow-workspace');
  await mkdir(cwd, { recursive: true });
  if (target.kind === 'cli') {
    if (target.cli === 'claude') return (await askClaudeCli({ prompt, cwd, signal, log: diagnostics, onDelta, instructions: system, addDirs: dirs, timeoutMs: 0 })).text;
    const binary = detection[target.id]?.path || await findCli(target.cli);
    if (!binary) throw new Error(`找不到 ${target.cli} 指令。`);
    return (await (target.cli === 'codex' ? askCodex : askGemini)({ binary, prompt, cwd, signal, log: diagnostics, onDelta, instructions: system, addDirs: dirs, timeoutMs: 0 })).text;
  }
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  if (target.kind === 'api') {
    const apiKey = await loadMixRouteKey();
    if (!apiKey) throw new Error('還沒有設定 MixRoute API 金鑰。');
    const chosen = model || pickDefaultModel(mixrouteChatModels());
    if (!chosen) throw new Error('MixRoute 沒有可用的模型。');
    assertChatModel(chosen);
    return streamMixRouteChat({ apiKey, model: chosen, messages, signal, onDelta });
  }
  if (target.kind === 'ollama') {
    ollamaStatus = await probeOllama();
    if (!ollamaStatus.running) throw new Error('Ollama 沒有在執行，請先打開 Ollama App。');
    const chosen = model || ollamaStatus.models[0];
    if (!chosen) throw new Error('Ollama 還沒有下載任何模型。');
    return streamOllamaChat({ model: chosen, messages, signal, onDelta });
  }
  if (target.kind === 'builtin') {
    if (!state.model) await refreshSession({ manual: true });
    if (!state.model) throw new Error(state.builtinError || '內建 ChatGPT 讀不到模型清單。');
    return (await chatgpt.streamResponse({ model: state.model, input: prompt, ...(system ? { instructions: system } : {}), onDelta, signal })).text;
  }
  throw new Error(`${target.label} 拿不回結果。`);
}

/** 從回覆裡取出交件標記之間的成品；有結束標記才算交完。標記要「單獨一行」才算（問題裡的說明文字也有標記，不能誤判） */
function extractHandoff(text) {
  const value = String(text || '');
  const lines = value.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].trim() === HANDOFF_START) { start = i; break; }
  if (start < 0) return { found: false, done: false, text: value.trim() };
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) if (lines[i].trim() === HANDOFF_END) { end = i; break; }
  return { found: true, done: end >= 0, text: lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim() };
}
const workflowSleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * 操作 App／網頁的 AI：貼上送出，再把結果帶回來。
 * 為了不干擾使用者：
 *   1. 等使用者停手（鍵盤、滑鼠 1.5 秒沒動）才切過去，貼上送出只花幾秒，送出後馬上把畫面還給使用者原本的程式
 *   2. 回覆用「讀畫面」在背景讀（輔助使用不需要 App 在最前面）
 *   3. 讀不到畫面時（ChatGPT）才改用 ⌘⇧C，每次也是等停手、切過去按一下就切回來
 * 拿不回結果的 App（實驗中的 Kiro、Hermes）只貼上送出，只能放最後一步。
 */
async function waitForUserIdle(helper, { idleSeconds = 1.5, maxMs = 20000, signal } = {}) {
  const until = Date.now() + maxMs;
  while (!signal?.aborted && Date.now() < until) {
    if ((await secondsSinceLastInput(helper)) >= idleSeconds) return true;
    await workflowSleep(400, signal);
  }
  return false;
}
/** 記住現在使用者在哪個程式；之後切回去 */
async function rememberFocus() {
  const ownFocused = Boolean(window && !window.isDestroyed() && window.isFocused());
  return { ownFocused, bundleId: ownFocused ? '' : await frontmostBundleId().catch(() => '') };
}
async function restoreFocus(saved, targetBundleId) {
  if (!saved) return;
  if (saved.ownFocused) {
    if (window && !window.isDestroyed()) { app.focus({ steal: true }); window.show(); }
  } else if (saved.bundleId && saved.bundleId !== targetBundleId) {
    await bringToFront(saved.bundleId).catch(() => {});
  }
}

let workflowDeliverQueue = Promise.resolve();
let workflowFinishRequested = false; // 使用者按「用目前讀到的內容完成這一步」（只對按下時正在跑的那一步有效）
let workflowCurrentNode = '';
function askWorkflowApp(target, text, { returnMode = '', signal, onText = () => {} } = {}) {
  const job = workflowDeliverQueue.then(async () => {
    const usable = workflowAvailability(target);
    if (!usable.available) throw new Error(`${target.label} 目前不能用（${usable.reason}）。`);
    if (delivering || state.busy) throw new Error('小精靈正在處理別的請求，請稍後再試。');
    const plan = APP_RETURN[target.id];
    const mode = !plan ? 'none' : returnMode === 'file' && plan.file ? 'file' : plan.mode;
    workflowFinishRequested = false;
    const stamp = `工作流步驟 ${Date.now().toString(36)}`;
    let filePath = '';
    let body = text;
    if (mode === 'file') {
      await mkdir(handoffFolder(), { recursive: true });
      filePath = join(handoffFolder(), `${stamp.replace(/\s/g, '-')}.md`);
      body += `\n\n（交件規則）完成後，請用你的本機檔案工具，把要交給下一步的完整成品寫入這個檔案（UTF-8、Markdown）：\n${filePath}\n寫好後只要回覆「已存檔」。`;
    } else if (mode !== 'none') {
      body += `\n\n（交件規則）請把要交給下一步的完整成品放在兩行標記之間：第一行單獨寫 ${HANDOFF_START}，最後一行單獨寫 ${HANDOFF_END}。`;
    }
    // 最後一行獨一無二：讀畫面時用它找到這次的問題。
    // 很長的內容會被 App 收成附件、畫面上看不到 → 記號放在另外貼的一小段結尾裡
    const LONG = 2500;
    const trailer = body.length > LONG ? `（請閱讀上面貼上的完整內容，照裡面的指示作答，並依交件規則交件。）\n${stamp}` : '';
    if (!trailer) body += `\n${stamp}`;
    delivering = true;
    let helper;
    try {
      helper = await getAxHelper().catch((error) => { diagnostics(`工作流：讀取工具無法使用（${error.message}）`); return undefined; });
      const bundleId = helper ? await resolveTargetBundleId(target) : undefined;
      // ── 等使用者停手，短暫切過去貼上送出，再切回來 ──
      if (helper) {
        onText(`（等你停下鍵盤滑鼠，再切到 ${target.app || target.label} 送出，只要幾秒）`);
        await waitForUserIdle(helper, { signal });
      }
      if (signal?.aborted) throw new Error('已停止。');
      let baseline = [];
      let result;
      // 送出的那幾秒你剛好點了別的視窗（焦點被切走）：不算失敗，等你停手再重送（最多 3 次）
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const focus = await rememberFocus();
        try {
          result = await deliver({
            target, text: body, trailer, autoSubmit: !target.manualSubmit, newChat: true,
            onBeforeSubmit: helper && bundleId ? async () => { baseline = (await readWindowTexts(helper, bundleId).catch(() => ({ texts: [] }))).texts; return `${baseline.length} 段文字`; } : undefined,
          }, { clipboardIO, systemPreferences, log: diagnostics });
        } finally {
          await workflowSleep(300);
          await restoreFocus(focus, bundleId);
        }
        if (result.ok || result.code !== 'focus' || attempt === 3 || signal?.aborted) break;
        onText(`（送出時畫面被切到別的視窗，等你停下鍵盤滑鼠再送一次…第 ${attempt + 1} 次）`);
        if (helper) await waitForUserIdle(helper, { idleSeconds: 2.5, maxMs: 60000, signal });
      }
      if (!result.ok) throw new Error(result.error || `貼到 ${target.label} 失敗。`);
      if (mode === 'none') return `（已貼到 ${target.label}，這個 App 拿不回結果，請到那裡看回覆）`;
      if (!helper || !bundleId) throw new Error('需要輔助使用權限和讀取工具，才能把結果帶回來。');
      diagnostics(`工作流：${target.label} 已送出，畫面已還給使用者；用「${mode}」在背景帶回結果`);
      onText(`（已送到 ${target.app || target.label}，在背景等回覆）`);
      const anchor = questionAnchor(stamp);
      let generating = false; // 看過「停止」鈕（AI 正在回覆）
      const readScreen = async () => {
        const { texts, stop } = await readWindowTexts(helper, bundleId);
        if (stop) generating = true;
        return { ...extractReply(texts, { anchor, baseline }), stop };
      };
      // 不限時間：AI 可能要跑很久（讀檔、用工具、思考）。只有這三種情況才算這一步結束：
      //   1. AI 交件（存出檔案，或寫出交件結束標記）
      //   2. 你在工作流按「⏭ 用目前讀到的內容完成這一步」
      //   3. 你按「停止」
      let shown = '';
      const show = (value) => { if (value && value !== shown) { shown = value; onText(value); } };
      const manualDone = () => workflowFinishRequested;
      const WAIT_HINT = '\n\n（還在等回覆：不限時間。要提早結束這一步，按「⏭ 用目前讀到的內容完成這一步」）';

      // ── 請 AI 存成檔案 ──
      if (mode === 'file') {
        let lastSize = -1; let lastReply = ''; let fileStable = 0;
        while (!signal?.aborted) {
          await workflowSleep(2000, signal);
          const info = await stat(filePath).catch(() => undefined);
          if (info?.size > 0) {
            if (info.size === lastSize) {
              const saved = await readFile(filePath, 'utf8');
              await rm(filePath, { force: true }).catch(() => {});
              return saved.trim();
            }
            lastSize = info.size;
            continue;
          }
          const reply = await readScreen().catch(() => ({ found: false, text: '' }));
          if (reply.found && reply.text) {
            const handoff = extractHandoff(reply.text);
            if (handoff.done) return handoff.text; // 沒存檔、但在回覆裡交件了
            fileStable = reply.text === lastReply && !reply.stop ? fileStable + 1 : 0;
            if (reply.text !== lastReply) { lastReply = reply.text; show(`（${target.label} 回覆中，等它存檔…）\n\n${reply.text}`); }
            // AI 回完了（「停止」鈕出現過、現在不見了，內容幾次沒變）：再給它 10 秒把檔案寫完，沒有檔案就用回覆的內容
            if (generating && !reply.stop && fileStable >= 3) {
              for (let wait = 0; wait < 5 && !signal?.aborted; wait += 1) {
                await workflowSleep(2000, signal);
                const late = await stat(filePath).catch(() => undefined);
                if (late?.size > 0) { await workflowSleep(1500, signal); const saved = await readFile(filePath, 'utf8'); await rm(filePath, { force: true }).catch(() => {}); return saved.trim(); }
              }
              diagnostics(`工作流：${target.label} 回完了但沒有存出檔案，改用畫面上的回覆`);
              return handoff.text;
            }
          }
          if (manualDone()) return extractHandoff(lastReply).text || '（沒有讀到回覆）';
        }
        throw new Error('已停止。');
      }

      // ── 在背景讀畫面 ──
      let last = ''; let found = false; let missingNoted = false; let stable = 0;
      const startedAt = Date.now();
      while (!signal?.aborted) {
        await workflowSleep(1200, signal);
        const reply = await readScreen().catch(() => ({ found: false, text: '' }));
        if (!reply.found) {
          if (manualDone()) return extractHandoff(last).text || '（沒有讀到回覆）';
          // 讀不到畫面：ChatGPT 改用 ⌘⇧C；其他的繼續等（App 可能還在開新對話、或畫面還沒更新）
          if (Date.now() - startedAt > 30000) {
            if (APP_RETURN[target.id]?.copy && !found) break;
            if (!missingNoted) { missingNoted = true; onText(`（在 ${target.label} 的畫面上還找不到剛送出的問題，繼續等…）${WAIT_HINT}`); }
          }
          continue;
        }
        found = true;
        const handoff = extractHandoff(reply.text);
        if (handoff.done) return handoff.text;
        stable = reply.text === last && !reply.stop ? stable + 1 : 0;
        last = reply.text;
        show(handoff.text);
        if (manualDone()) return handoff.text;
        // AI 回完了（「停止」鈕出現過、現在不見了，內容連續幾次沒變）：沒照格式交件也用回覆的內容
        if (generating && !reply.stop && stable >= 3 && last) return handoff.text;
      }
      if (signal?.aborted) throw new Error('已停止。');

      // ── 讀不到畫面：⌘⇧C 複製最後回覆（每次等停手、切過去按一下就切回來） ──
      diagnostics(`工作流：${target.label} 讀不到畫面，改用 ⌘⇧C`);
      const saved = await clipboardIO.snapshot();
      const sentinel = `__screen_spirit_${Date.now()}__`;
      last = '';
      try {
        clipboard.writeText(sentinel);
        while (!signal?.aborted) {
          await workflowSleep(4000, signal);
          if (manualDone()) return extractHandoff(last).text || '（沒有讀到回覆）';
          if (!(await waitForUserIdle(helper, { idleSeconds: 1.2, maxMs: 8000, signal }))) continue;
          const before = await rememberFocus();
          let copied = '';
          try {
            if (!(await bringToFront(bundleId))) continue;
            await pressKey({ key: 'c', mods: ['command', 'shift'] });
            await workflowSleep(400, signal);
            copied = clipboard.readText();
          } finally {
            await restoreFocus(before, bundleId);
          }
          if (!copied || copied === sentinel) continue;
          const handoff = extractHandoff(copied);
          if (handoff.done) return handoff.text;
          last = copied;
          show(handoff.text);
        }
      } finally {
        await clipboardIO.restore(saved).catch(() => {});
      }
      throw new Error('已停止。');
    } finally {
      delivering = false;
    }
  });
  workflowDeliverQueue = job.catch(() => {});
  return job;
}

/** 背景替身：同一個帳號／訂閱、但在背景執行、不用操作畫面的 AI */
const BACKGROUND_ALT = { 'claude-app': ['claude-cli'], 'chatgpt-app': ['builtin', 'codex-cli'], 'chatgpt-web': ['builtin', 'codex-cli'], 'google-ai-mode': ['gemini-cli'] };
function backgroundAlternative(targetId) {
  for (const id of BACKGROUND_ALT[targetId] || []) {
    const target = workflowTarget(id);
    if (target && workflowAvailability(target).available) return target;
  }
  return undefined;
}

/** 工作流成品存成 PDF：在看不見的視窗打開 HTML（不執行腳本），印成 A4 PDF */
async function workflowHtmlToPdf(html) {
  const file = join(app.getPath('temp'), `screen-spirit-output-${Date.now()}.html`);
  await writeFile(file, html, 'utf8');
  const printer = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, javascript: false, contextIsolation: true } });
  try {
    await printer.loadFile(file);
    return await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
  } finally {
    printer.destroy();
    await rm(file, { force: true }).catch(() => {});
  }
}

// ── 附件：讀不到電腦的 AI（雲端、本機模型、網頁），把附上的文字檔內容一起送過去 ──
const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|sql|log|tex|rst|env\.example|gitignore)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);
async function inlineAttachments(files, { perFile = 150_000, total = 400_000 } = {}) {
  let budget = total;
  const parts = [];
  const addFile = async (path, label = path) => {
    if (!TEXT_EXT.test(path)) { parts.push(`── ${label} ──\n（不是文字檔，沒有附上內容）`); return; }
    if (budget <= 0) { parts.push(`── ${label} ──\n（附件太多，這個檔案沒有附上內容）`); return; }
    try {
      const info = await stat(path);
      let content = await readFile(path, 'utf8');
      const cut = Math.min(perFile, budget);
      if (content.length > cut) content = `${content.slice(0, cut)}\n…（檔案太長，後面 ${content.length - cut} 字省略）`;
      budget -= content.length;
      parts.push(`── ${label}（${Math.round(info.size / 1024)} KB）──\n${content}`);
    } catch (error) { parts.push(`── ${label} ──\n（讀不到：${error.message}）`); }
  };
  for (const file of files) {
    if (file.kind === 'file') { await addFile(file.path); continue; }
    // 資料夾：列出檔案（最多 300 個、3 層），文字檔附上內容
    const listed = [];
    const walk = async (dir, depth) => {
      if (listed.length >= 300 || depth > 3) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
        if (listed.length >= 300) return;
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(full, depth + 1); }
        else if (entry.isFile()) listed.push(full);
      }
    };
    await walk(file.path, 1);
    parts.push(`── 資料夾 ${file.path}（${listed.length} 個檔案${listed.length >= 300 ? '，只列前 300 個' : ''}）──\n${listed.map((path) => `- ${path.slice(file.path.length + 1)}`).join('\n')}`);
    for (const path of listed) if (TEXT_EXT.test(path) && budget > 0) await addFile(path, path);
  }
  return parts.length ? `\n\n附件的內容（你讀不到使用者的電腦，所以直接附在這裡）：\n\n${parts.join('\n\n')}` : '';
}
/** 背景執行的 AI（CLI）要開放讀取的資料夾：附上的資料夾，和附上檔案所在的資料夾 */
const attachmentDirs = (files = []) => [...new Set(files.map((file) => (file.kind === 'dir' ? file.path : dirname(file.path))))];
/** 這個 AI 能不能自己讀附件的路徑 */
const readsPaths = (target) => (target.kind || 'app') === 'cli' || target.id === 'claude-app';

async function runWorkflowNode(node, { prompt, signal, onDelta, onText, attachments = [] }) {
  workflowCurrentNode = node.id;
  // 執行方式由卡片決定：app＝用選的那個 AI；background＝改用同一個帳號的背景版本（不搶畫面）
  const pick = (target) => {
    if (node.runMode !== 'background' || TEXT_KINDS.has(target.kind || 'app')) return target;
    const alt = backgroundAlternative(target.id);
    if (alt) diagnostics(`工作流：${target.label} 改用背景版本 ${alt.label}`);
    return alt || target;
  };
  const withFiles = async (target, text) => (attachments.length && !readsPaths(target) ? text + await inlineAttachments(attachments) : text);
  if (node.kind === 'spirit') {
    const spirit = (await spiritStore.list()).find((item) => item.id === node.spiritId);
    if (!spirit) throw new Error('找不到這隻精靈（可能已經刪除）。');
    const chosen = workflowTarget(spiritTargetId(spirit));
    if (!chosen) throw new Error(`「${spirit.name}」沒有可用的 AI：請到精靈博士的「指定 AI」設定，或在主視窗選一個預設 AI。`);
    const target = pick(chosen);
    const run = await prepareSpiritRun(await withDefaultHome(spirit), { canReadFiles: target.kind === 'cli' });
    const text = await withFiles(target, prompt);
    if (!TEXT_KINDS.has(target.kind || 'app')) return askWorkflowApp(target, withPastedInstructions(run.instructions, text), { signal, onText });
    return askWorkflowText({ targetId: target.id, model: target.id === chosen.id ? spirit.ai.model : '', system: run.instructions, dirs: [...(run.dirs || []), ...attachmentDirs(attachments)], prompt: text, signal, onDelta });
  }
  const chosen = workflowTarget(node.targetId);
  if (!chosen) throw new Error('找不到這個 AI。');
  // 選了「存成檔案交回」：一定用桌面 App
  const target = node.returnMode === 'file' ? chosen : pick(chosen);
  const text = await withFiles(target, prompt);
  if (!TEXT_KINDS.has(target.kind || 'app')) return askWorkflowApp(target, text, { returnMode: node.returnMode, signal, onText });
  return askWorkflowText({ targetId: target.id, model: target.id === chosen.id ? node.model : '', dirs: attachmentDirs(attachments), prompt: text, signal, onDelta });
}

setupWorkflow({
  app, dialog, shell, diagnostics, catalog: workflowCatalog, runNode: runWorkflowNode, htmlToPdf: workflowHtmlToPdf,
  finishStep: (nodeId) => { if (nodeId && nodeId === workflowCurrentNode) workflowFinishRequested = true; return nodeId === workflowCurrentNode; },
  handle: (channel, action) => handle(channel, action),
  send: (payload) => { if (window && !window.isDestroyed()) window.webContents.send('poc:workflow-event', payload); },
  getWindow: () => window,
  onRunEnd: () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } },
});

/** 這隻精靈的長期記憶要交給哪個 AI 整理：自己設定的 → 精靈的主要 AI（能拿回文字的話） */
function curatorFor(spirit) {
  const pickTarget = (id) => {
    if (!id) return undefined;
    const target = id === 'builtin' ? { kind: 'builtin' } : findTarget(id);
    return target && TEXT_KINDS.has(target.kind || 'app') ? id : undefined;
  };
  const targetId = pickTarget(spirit.memory.curator?.targetId) || pickTarget(spiritTargetId(spirit));
  return targetId ? { targetId, model: targetId === spirit.memory.curator?.targetId ? spirit.memory.curator.model : spirit.ai.model } : undefined;
}

/** 對話結束後整理記憶（之後精靈實際工作時呼叫；現在先給「試整理」按鈕用） */
async function curateSpiritMemory(spirit, messages) {
  if (spirit.memory.mode !== 'persistent') return { saved: false, reason: '這隻精靈沒有開啟長期記憶。' };
  if (!spirit.memory.home?.path) return { saved: false, reason: '還沒有設定資料庫位置，記憶沒有地方存。' };
  const curator = curatorFor(spirit);
  if (!curator) return { saved: false, reason: '請先選一個整理記憶用的 AI。' };
  const started = Date.now();
  const result = await curateConversation({
    spirit,
    messages,
    ask: (prompt) => askText({ ...curator, prompt }),
    listTitles: () => listMemoryTitles(spirit.memory.home.path),
    write: (note) => writeMemoryNote(spirit.memory.home.path, note),
  });
  diagnostics(`精靈記憶整理（${curator.targetId}，${Date.now() - started} ms）：${result.saved ? '存了一篇' : '沒有存'}`);
  return result;
}

// ── 精靈博士「✨ 讓 AI 幫我寫」：限制、角色身份與定位、工作 SOP 共用同一套流程 ──
let generateController;
const hasRoleInfo = (spirit) => Boolean(`${spirit.summary}${spirit.role.identity}${spirit.role.positioning}${/^(新的小精靈|未命名的小精靈)$/.test(spirit.name) ? '' : spirit.name}`.trim());
const GENERATORS = {
  limits: {
    label: '限制', depths: DEPTHS, build: buildLimitsPrompt, parse: parseLimitsReply,
    missing: (spirit, brief) => (brief.trim() || hasRoleInfo(spirit) ? '' : '請先寫下你的想法，或到「角色身份與定位」填寫名稱和身份，AI 才知道要分析什麼角色。'),
  },
  role: {
    label: '角色', depths: ROLE_DEPTHS, build: buildRolePrompt, parse: parseRoleReply,
    missing: (spirit, brief) => (brief.trim() || hasRoleInfo(spirit) ? '' : '請先在「你的想法」寫下想要什麼樣的精靈，例如：幫我把日文技術文件翻成中文。'),
  },
  sop: {
    label: 'SOP', depths: SOP_DEPTHS, build: buildSopPrompt, parse: parseSopReply,
    missing: (spirit, brief) => (brief.trim() || hasRoleInfo(spirit) ? '' : '請先寫下這份 SOP 要完成的工作，或到「角色身份與定位」填寫身份與專長。'),
  },
};
async function runGenerator(kind, { spiritId, brief = '', depth, targetId, model } = {}) {
  const generator = GENERATORS[kind];
  const spirit = await findSpirit(spiritId);
  const chosen = targetId ? { targetId, model } : curatorFor(spirit);
  if (!chosen) return { ok: false, error: '請先選一個用來分析的 AI。' };
  const missing = generator.missing(spirit, typeof brief === 'string' ? brief : '');
  if (missing) return { ok: false, error: missing };
  generateController?.abort(); // 同一時間只跑一個，避免重複花額度
  const controller = new AbortController();
  generateController = controller;
  const level = generator.depths[depth] ? depth : 'standard';
  const started = Date.now();
  try {
    const reply = await askText({ ...chosen, prompt: generator.build({ spirit, brief, depth: level }), signal: controller.signal });
    const result = generator.parse(reply);
    diagnostics(`精靈博士：AI 產生${generator.label}（${chosen.targetId}，${generator.depths[level].label}，${Date.now() - started} ms）`);
    return { ok: true, ...result };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    diagnostics(`精靈博士：AI 產生${generator.label}失敗（${error instanceof Error ? error.message : error}）`);
    return { ok: false, error: error instanceof Error ? error.message : '產生失敗。' };
  } finally {
    if (generateController === controller) generateController = undefined;
  }
}
handle('spirit-generate-limits', (options) => runGenerator('limits', options));
handle('spirit-generate-role', (options) => runGenerator('role', options));
handle('spirit-generate-sop', (options) => runGenerator('sop', options));
handle('spirit-generate-cancel', () => {
  generateController?.abort();
  return { ok: true };
});

// ── 精靈生圖：精靈先照角色與 SOP 想好設計，回答最後附上提示詞，再交給 MixRoute 的生圖模型畫出來 ──
function spiritImageModel(spirit) {
  if (!spirit) return '';
  if (spirit.ai.imageModel) return spirit.ai.imageModel;
  // 以前把生圖模型選在「主要 AI 的模型」：當成生圖模型使用
  return spirit.ai.model && mixrouteModelKind(spirit.ai.model) === 'image' ? spirit.ai.model : '';
}
function imageInstructions(model) {
  return [
    '# 產生圖片',
    `這隻精靈可以產生圖片（生圖模型：${model}）。當使用者要的成果是圖片（例如造型、角色、插圖、海報、示意圖）時：`,
    '1. 先照你的角色、限制與工作步驟想好設計，用文字簡短說明設計重點。',
    '2. 在回答的最後，附上一個要交給生圖模型的提示詞，格式如下（每次最多一個）：',
    '```image-prompt',
    '（用英文寫：主體、外觀細節、姿勢與表情、風格與畫法、構圖與視角、光線、色彩、背景；不要放說明文字）',
    '```',
    '小精靈會自動用這段提示詞畫出圖片。使用者附了圖片時，會把那張圖當參考圖一起交給生圖模型。',
    '不需要圖片的時候就不要附提示詞。',
  ].join('\n');
}
/** 回答完成後：有生圖提示詞就畫圖，畫好的圖放在對話裡（可以存檔、設成精靈卡面） */
async function drawSpiritImage({ conversationRef, answer, imageModel, imageSize, referenceDataUrl }) {
  if (!imageModel || !answer?.text) return;
  const { prompt, text } = extractImagePrompt(answer.text);
  if (!prompt) return;
  answer.text = text || '設計好了，下面是畫出來的圖。';
  const message = { role: 'assistant', label: `🎨 ${imageModel}`, status: 'streaming', text: '正在畫圖…（通常要 10 秒到 1 分鐘）', generated: true, prompt };
  conversationRef.messages.push(message);
  const controller = new AbortController();
  activeRequest = controller;
  state.busy = true;
  publish();
  const started = Date.now();
  try {
    const apiKey = await loadMixRouteKey();
    if (!apiKey) throw new Error('畫圖需要 MixRoute 金鑰：請在主視窗「預設送到」選 MixRoute，按「金鑰」輸入。');
    const referencePng = referenceDataUrl ? nativeImage.createFromDataURL(referenceDataUrl).toPNG() : undefined;
    const result = await generateMixRouteImage({ apiKey, model: imageModel, prompt, size: imageSize, referencePng, signal: controller.signal });
    message.imageDataUrl = result.dataUrl;
    message.text = result.usedReference ? '（依照你附的圖修改）' : '';
    message.status = 'complete';
    diagnostics(`  ✓ 精靈生圖完成（${imageModel}${result.usedReference ? '，用了參考圖' : ''}，${Date.now() - started} ms）`);
  } catch (error) {
    message.status = controller.signal.aborted ? 'cancelled' : 'failed';
    message.text = controller.signal.aborted ? '已停止畫圖。' : `畫圖失敗：${error instanceof Error ? error.message : error}`;
    diagnostics(`  ✗ 精靈生圖失敗：${error instanceof Error ? error.message : error}`);
  } finally {
    if (activeRequest === controller) activeRequest = undefined;
    state.busy = false;
    publish();
  }
}

// 把產生的圖片存成檔案
handle('save-image', async ({ dataUrl, name }) => {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('這張圖片無法存檔。');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const safe = String(name || '小精靈的圖').replace(/[\\/:*?"<>|\n]/g, ' ').trim().slice(0, 60) || '小精靈的圖';
  const options = { title: '存成圖片檔', defaultPath: join(app.getPath('pictures'), `${safe}.${ext}`), filters: [{ name: '圖片', extensions: [ext] }] };
  const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined;
  const picked = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  await writeFile(picked.filePath, Buffer.from(match[2], 'base64'));
  return { ok: true, path: picked.filePath };
});

/** 對話結束後：用了精靈、開了長期記憶、而且有真正的 AI 回答，才整理（在背景進行，不擋使用者） */
const curatedConversations = new Set(); // 同一段對話、同樣的內容只整理一次（例如從歷史紀錄打開又關掉）
async function curateAfterConversation(record) {
  const spiritId = record.delivery?.spiritId || record.spiritId;
  if (!spiritId) return;
  const key = `${record.id}:${record.messages.length}`;
  if (curatedConversations.has(key)) return;
  curatedConversations.add(key);
  const answered = record.messages.some((message) => message.role === 'assistant' && message.status === 'complete' && !message.notice && message.text?.trim());
  if (!answered) return;
  try {
    const spirit = await withDefaultHome((await spiritStore.list()).find((item) => item.id === spiritId));
    if (!spirit || spirit.memory.mode !== 'persistent' || !spirit.memory.home?.path) return;
    const result = await curateSpiritMemory(spirit, record.messages);
    if (result.saved && Notification.isSupported()) {
      new Notification({ title: `${spirit.name} 記住了一件事`, body: result.title || '已整理到資料庫的「記憶」資料夾。', silent: true }).show();
    }
  } catch (error) {
    diagnostics(`精靈記憶整理失敗：${error instanceof Error ? error.message : error}`);
  }
}

// 派精靈工作：結束目前的對話（存進歷史紀錄），開一段新的、沒有附件的對話
handle('begin-spirit-task', async () => {
  if (conversation.messages.length) {
    const result = await finishCurrentConversation({ reveal: false });
    if (result && result.ok === false) return result;
  }
  conversation = createConversationSession({}, state.presentationMode);
  state.error = '';
  publish();
  openChatWindow();
  return { ok: true };
});

handle('memory-curate-test', async (spiritId) => {
  const spirit = await findSpirit(spiritId);
  // 用目前這段對話；沒有的話用歷史紀錄裡最新的一段
  let messages = conversation.messages;
  let used = '目前的對話';
  if (!messages.length && historyStore) {
    const latest = (await historyStore.list())[0];
    messages = latest?.messages || [];
    used = latest ? `最近一段對話（${(latest.messages.find((message) => message.role === 'user')?.text || '').slice(0, 20)}…）` : '';
  }
  if (!messages.length) return { ok: false, error: '還沒有任何對話可以拿來試。先用小精靈問一個問題再回來試。' };
  try {
    return { ok: true, used, ...(await curateSpiritMemory(spirit, messages)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '整理失敗。' };
  }
});

// 資料庫：選資料夾或檔案（只記路徑，不複製內容）
handle('spirits-pick-source', async (kind) => {
  const folder = kind === 'folder';
  const options = {
    title: folder ? '選擇精靈要參考的資料夾' : '選擇精靈要參考的檔案',
    buttonLabel: '加入',
    properties: folder ? ['openDirectory'] : ['openFile', 'multiSelections'],
  };
  const parent = window && !window.isDestroyed() && window.isVisible() ? window : undefined;
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return picked.canceled ? [] : picked.filePaths;
});
// 進入精靈博士時把主視窗放大（卡片盒需要空間），離開時還原
let boundsBeforeLab;
handle('lab-window', (mode) => {
  if (!window || window.isDestroyed()) return { ok: false };
  if (mode === 'open' || mode === 'open-wide') {
    if (!boundsBeforeLab) boundsBeforeLab = window.getBounds();
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const width = Math.min(area.width - 40, mode === 'open-wide' ? 1360 : 1040);
    const height = Math.min(area.height - 40, mode === 'open-wide' ? 880 : 780);
    const current = window.getBounds();
    if (current.width < width || current.height < height) {
      window.setBounds({
        x: Math.round(Math.min(Math.max(area.x + 20, current.x - (width - current.width) / 2), area.x + area.width - width - 20)),
        y: Math.round(Math.min(Math.max(area.y + 20, current.y - (height - current.height) / 2), area.y + area.height - height - 20)),
        width, height,
      }, true);
    }
  } else if (mode === 'close' && boundsBeforeLab) {
    window.setBounds(boundsBeforeLab, true);
    boundsBeforeLab = undefined;
  }
  return { ok: true };
});

handle('builtin-retry', async () => {
  await refreshSession({ manual: true });
  return { ok: !state.builtinError, error: state.builtinError };
});

// ── MixRoute API 金鑰：用 safeStorage（macOS 鑰匙圈）加密存在使用者資料夾，只在主程式解密，不傳給畫面 ──
const mixrouteKeyPath = join(app.getPath('userData'), 'mixroute-key.enc');
let mixrouteStatus = { hasKey: false, keyHint: '', models: [], error: '' };
let mixrouteEntries = {}; // 模型 id → /models 回傳的原始資料（看圖能力等欄位）

// 看圖能力：用過才知道的結果存起來（'yes'／'no'），比名稱判斷優先
const visionLearnedPath = join(app.getPath('userData'), 'model-vision.json');
let visionLearned = {};
async function loadVisionLearned() {
  try { visionLearned = JSON.parse(await readFile(visionLearnedPath, 'utf8')) || {}; } catch { visionLearned = {}; }
}
async function learnVision(modelId, value) {
  if (!modelId || visionLearned[modelId] === value) return;
  visionLearned[modelId] = value;
  diagnostics(`記下模型看圖能力：${modelId} → ${value === 'yes' ? '可以看圖' : '不能看圖'}`);
  try {
    await mkdir(dirname(visionLearnedPath), { recursive: true, mode: 0o700 });
    await writeFile(visionLearnedPath, JSON.stringify(visionLearned, null, 2), { mode: 0o600 });
  } catch {}
}
/** MixRoute 模型的用途；不是 'chat' 的（生圖、影片、語音…）不能拿來對話 */
function mixrouteModelKind(modelId) {
  return modelKind(modelId, mixrouteEntries[modelId]);
}
/** 可以拿來對話、而且沒被標記不可用的模型 */
function mixrouteChatModels() {
  return mixrouteStatus.models.filter((id) => !mixrouteBlocked[id] && mixrouteModelKind(id) === 'chat');
}
function assertChatModel(modelId) {
  const kind = mixrouteModelKind(modelId);
  if (kind === 'chat') return;
  const error = new Error(`「${modelId}」是${MODEL_KIND_LABEL[kind] || '專用模型'}，不能用來對話。請換成一般的對話模型（例如 GPT、Gemini、DeepSeek）；如果是精靈指定的，請到精靈博士的「指定 AI」修改。`);
  error.modelNotChat = true;
  throw error;
}

function mixrouteImageSupport(modelId) {
  return imageSupport(modelId, { apiEntry: mixrouteEntries[modelId], learned: visionLearned[modelId] });
}
/** 這次送出的目標看不看得到圖：'yes'｜'no'｜'unknown' */
function ollamaImageSupport(name) {
  const known = ollamaStatus.vision?.[name];
  return imageSupport(name, { apiEntry: known === 'yes' ? { supports_vision: true } : known === 'no' ? { supports_vision: false } : undefined, learned: visionLearned[`ollama:${name}`] });
}
function imageSupportFor(target, modelId) {
  if (target.kind === 'cli') return 'yes';
  if (target.kind === 'api') return mixrouteImageSupport(modelId);
  if (target.kind === 'ollama') return ollamaImageSupport(modelId);
  return target.imageSupport || (target.acceptsImage === false ? 'no' : 'yes');
}
async function runOcr(image) {
  const started = Date.now();
  const { text, lines } = await ocrImage(await getAxHelper(), image.toPNG());
  diagnostics(`  本機 OCR：${lines} 行、${text.length} 字（${Date.now() - started} ms）`);
  return text;
}

async function loadMixRouteKey() {
  try {
    const decrypted = await safeStorage.decryptStringAsync(await readFile(mixrouteKeyPath));
    return decrypted.result || '';
  } catch {
    return '';
  }
}

const keyHint = (key) => (key.length > 8 ? `••••${key.slice(-4)}` : '••••');

// 用過才知道不能用的模型：MixRoute 的模型清單不會標示帳號權限，所以從失敗中學習並記下來（不是機密，存一般 JSON）
const mixrouteBlockedPath = join(app.getPath('userData'), 'mixroute-blocked-models.json');
let mixrouteBlocked = {}; // 模型 id → 原因

async function loadMixRouteBlocked() {
  try { mixrouteBlocked = JSON.parse(await readFile(mixrouteBlockedPath, 'utf8')) || {}; } catch { mixrouteBlocked = {}; }
}

async function saveMixRouteBlocked() {
  try {
    await mkdir(dirname(mixrouteBlockedPath), { recursive: true, mode: 0o700 });
    await writeFile(mixrouteBlockedPath, JSON.stringify(mixrouteBlocked, null, 2), { mode: 0o600 });
  } catch {}
}

/** 某個模型因權限失敗：Anthropic 整系列被擋時，把清單裡所有 Claude 模型一起標記 */
async function markMixRouteModelBlocked(modelId, error) {
  const wholeFamily = /Anthropic|Claude/.test(error.message) && /claude/i.test(modelId);
  const affected = wholeFamily ? mixrouteStatus.models.filter((id) => /claude|anthropic/i.test(id)) : [modelId];
  const reason = wholeFamily ? '帳號不能用 Claude（Anthropic）模型' : '這個帳號不能用此模型';
  for (const id of new Set([...affected, modelId])) mixrouteBlocked[id] = reason;
  diagnostics(`MixRoute 標記不可用模型：${affected.length} 個（${reason}）`);
  await saveMixRouteBlocked();
}

async function refreshMixRouteStatus() {
  const key = await loadMixRouteKey();
  mixrouteStatus = { ...mixrouteStatus, hasKey: Boolean(key), keyHint: key ? keyHint(key) : '', error: '' };
  if (key) {
    try {
      const entries = await listMixRouteModelEntries({ apiKey: key });
      mixrouteEntries = Object.fromEntries(entries.map(({ id, entry }) => [id, entry]));
      mixrouteStatus.models = entries.map(({ id }) => id);
    } catch (error) {
      mixrouteStatus.error = error.message;
      diagnostics(`MixRoute 模型清單讀取失敗：${error.message}`);
    }
  } else {
    mixrouteStatus.models = [];
  }
  publish();
}

handle('mixroute-set-key', async (rawKey) => {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (key.length < 8 || key.length > 512 || /\s/.test(key)) return { ok: false, error: '金鑰格式看起來不對，請確認有完整貼上。' };
  let models;
  try {
    const entries = await listMixRouteModelEntries({ apiKey: key }); // 先驗證金鑰有效才存
    mixrouteEntries = Object.fromEntries(entries.map(({ id, entry }) => [id, entry]));
    models = entries.map(({ id }) => id);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '這台電腦目前無法加密保存金鑰（系統鑰匙圈不可用）。' };
  await mkdir(dirname(mixrouteKeyPath), { recursive: true, mode: 0o700 });
  await writeFile(mixrouteKeyPath, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
  mixrouteStatus = { hasKey: true, keyHint: keyHint(key), models, error: '' };
  mixrouteBlocked = {}; // 換了金鑰（可能是不同帳號），之前的不可用標記作廢
  await saveMixRouteBlocked();
  diagnostics(`MixRoute 金鑰已驗證並加密保存（${models.length} 個模型）`);
  publish();
  return { ok: true, models, defaultModel: pickDefaultModel(models) };
});

handle('mixroute-clear-key', async () => {
  await unlink(mixrouteKeyPath).catch(() => {});
  mixrouteStatus = { hasKey: false, keyHint: '', models: [], error: '' };
  mixrouteBlocked = {};
  await saveMixRouteBlocked();
  diagnostics('MixRoute 金鑰已刪除');
  publish();
  return { ok: true };
});

handle('mixroute-refresh-models', () => refreshMixRouteStatus().then(() => ({ ok: !mixrouteStatus.error, error: mixrouteStatus.error })));

// 清除不可用標記（例如請 MixRoute 開通後想重試）
handle('mixroute-clear-blocked', async () => {
  mixrouteBlocked = {};
  await saveMixRouteBlocked();
  publish();
  return { ok: true };
});

// 被並排過的視窗：AI App 用 bundleId、原本的程式用 pid 當代號 → 原本的位置與大小（第一次移動時記下，還原時用）
const dockedWindows = new Map();
// 目前並排中的 AI 對話：{ targetId, bundleId, frame }。AI 視窗還停在並排位置時，再圈選就直接貼進這段對話。
let activeDock;

// 並排方式：'drawer'（抽屜，預設）或 'split'（固定並排）；存在使用者資料夾
const layoutModePath = join(app.getPath('userData'), 'layout-mode.json');
let layoutMode = 'drawer';
async function loadLayoutMode() {
  try { layoutMode = JSON.parse(await readFile(layoutModePath, 'utf8')).mode === 'split' ? 'split' : 'drawer'; } catch { layoutMode = 'drawer'; }
}
async function setLayoutMode(mode) {
  layoutMode = mode === 'split' ? 'split' : 'drawer';
  try {
    await mkdir(dirname(layoutModePath), { recursive: true, mode: 0o700 });
    await writeFile(layoutModePath, JSON.stringify({ mode: layoutMode }), { mode: 0o600 });
  } catch {}
  diagnostics(`並排方式改為：${layoutMode === 'drawer' ? '抽屜' : '固定並排'}（下一次並排時套用）`);
  tray?.setContextMenu(buildSpiritMenu());
}

const drawer = createDrawer({
  directory,
  getHelper: () => getAxHelper(),
  isOwnPid: (pid) => ownProcessIds().has(pid),
  log: diagnostics,
  onChange: () => {
    tray?.setContextMenu(buildSpiritMenu());
    publish(); // 主視窗的「正在並排」區塊跟著更新
  },
  onOpenHome: () => openChatWindow(),
  onRestore: () => restoreDockedWindows(),
});


async function restoreDockedWindows() {
  await drawer.stop(); // 先結束抽屜（收著的 AI 會先放回可見的位置）
  if (!dockedWindows.size) return;
  let helper;
  try { helper = await getAxHelper(); } catch { return; }
  for (const [key, { frame, label }] of dockedWindows) {
    try {
      await setWindowFrame(helper, key, frame);
      diagnostics(`還原 ${label} 視窗位置：${JSON.stringify(frame)}`);
    } catch (error) {
      diagnostics(`還原 ${label} 視窗位置失敗：${error.message}`);
    }
  }
  dockedWindows.clear();
  activeDock = undefined;
  tray?.setContextMenu(buildSpiritMenu());
}

/** 並排中的 AI 視窗是否還在原位（使用者沒有還原、沒有移走、App 還開著）；是的話回傳該目標 */
async function activeDockTarget() {
  if (!activeDock || !dockedWindows.has(activeDock.bundleId)) return undefined;
  // 抽屜模式：AI 收起時位置本來就不同，只要抽屜還在就算同一段對話
  if (drawer.isActive() && drawer.bundleId() === activeDock.bundleId) return findTarget(activeDock.targetId);
  try {
    const helper = await getAxHelper();
    const frame = await getWindowFrame(helper, activeDock.bundleId);
    const unmoved = ['x', 'y', 'width', 'height'].every((key) => Math.abs(frame[key] - activeDock.frame[key]) <= 40);
    if (!unmoved) {
      diagnostics(`並排的 ${activeDock.bundleId} 已被移動，下次圈選改回一般提問`);
      activeDock = undefined;
      return undefined;
    }
    return findTarget(activeDock.targetId);
  } catch {
    activeDock = undefined;
    return undefined;
  }
}

/**
 * 接續模式：把新的圈選圖片／複製內容與來源程式直接貼進並排中的 AI 對話輸入框，不送出，讓使用者接著輸入需求。
 * @returns {Promise<boolean>} 成功時 true；失敗就回到一般的提問對話框
 */
async function attachToActiveConversation({ imageDataUrl, sourceText, context, sourceKind }) {
  const target = await activeDockTarget();
  if (!target) return false;
  if (drawer.isActive() && drawer.isHidden()) await drawer.show({ activate: false }); // 先把抽屜拉出來，使用者才看得到貼進去的內容
  const image = imageDataUrl ? nativeImage.createFromDataURL(imageDataUrl) : undefined;
  const vision = imageSupportFor(target);
  let ocrText;
  if (image && !image.isEmpty() && vision === 'no') {
    try { ocrText = await runOcr(image); } catch { ocrText = ''; }
  }
  const hasImage = Boolean(image && !image.isEmpty() && vision !== 'no');
  const keptContext = sanitizeContext(context);
  const text = composeAttachmentText({ sourceText, context: keptContext, sourceKind, hasImage, ocrText });
  diagnostics(`接續並排中的 ${target.app} 對話：貼上${hasImage ? '圖片＋' : ''}脈絡（${keptContext.map((c) => c.app).join('、') || '無'}），不送出`);
  let result;
  try {
    result = await deliver({ target, image: hasImage ? image : undefined, text, autoSubmit: false, newChat: false, clearInput: false },
      { clipboardIO, systemPreferences, log: diagnostics });
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    diagnostics(`接續失敗，改開提問對話框：${result.error}`);
    return false;
  }
  // 記一筆歷史紀錄（問題由使用者在 AI App 裡輸入）
  conversation.source = { ...conversation.source, context: keptContext };
  conversation.delivery = { targetId: target.id, targetLabel: target.label, live: false, at: new Date().toISOString(), continued: true };
  conversation.messages.push({ role: 'user', text: `（已貼到 ${target.app} 目前的對話，問題在 ${target.app} 裡輸入）`, ...(sourceText ? { sourceText } : {}), ...(imageDataUrl ? { imageDataUrl } : {}) });
  await finishCurrentConversation({ reveal: false });
  return true;
}

let axHelperBinary;
async function getAxHelper() {
  axHelperBinary ??= await ensureAxHelper({
    sourcePath: join(directory, 'ax-helper.swift'),
    binDirectory: join(app.getPath('userData'), 'bin'),
    log: diagnostics,
  });
  return axHelperBinary;
}

function showDialogBesideTarget() {
  if (!window || window.isDestroyed()) return;
  applyWindowPresentation();
  window.showInactive(); // 不搶走 Claude 的焦點
  window.moveTop();
}

handle('deliver', async ({ targetId, question, imageDataUrl, sourceText, context, autoSubmit, dock, model, projectPath, spiritId, imageAttached }) => {
  validateQuestion(question, imageDataUrl, sourceText);
  const target = findTarget(targetId);
  if (!target) throw new Error('請選擇要送到哪個 AI。');
  const usable = targetAvailability(target.id);
  if (!usable.available) throw new Error(`${target.label} 目前不能用（${usable.reason}）。可以在主視窗「管理 AI 連線」重新偵測或啟用。`);
  if (delivering || state.busy) throw new Error('上一個請求還在處理中。');
  // 以專案為單位的編輯器（Kiro）：確認選的專案資料夾還在
  let openPath;
  if (target.projectBased && typeof projectPath === 'string' && projectPath) {
    if (!(await isDirectory(projectPath))) throw new Error(`找不到專案資料夾：${projectPath}。請重新選擇專案。`);
    openPath = projectPath;
  }

  const live = Boolean(conversation.delivery?.live && conversation.delivery.targetId === target.id && conversation.messages.length);
  // 從歷史紀錄再問一次，或第一次送出失敗後重試：沿用原本的圈選內容，但開一段新對話（R-DLG-03、R-DLG-05）。
  let inheritedContext;
  if (conversation.messages.length && !live) {
    const firstUser = conversation.messages.find((message) => message.role === 'user');
    imageDataUrl ??= firstUser?.imageDataUrl;
    sourceText ??= firstUser?.sourceText;
    inheritedContext = conversation.source.context;
    conversation = createConversationSession(structuredClone(conversation.source), state.presentationMode);
  }
  const isFollowUp = live;
  const requestConversation = conversation;

  // 精靈：第一次送出時記在這段對話上，追問沿用同一隻
  const activeSpiritId = isFollowUp ? requestConversation.delivery?.spiritId : (typeof spiritId === 'string' ? spiritId : '');
  let spiritRun;
  let spiritName = '';
  if (activeSpiritId) {
    const spirit = (await spiritStore.list()).find((item) => item.id === activeSpiritId);
    if (spirit) {
      spiritName = spirit.name;
      spiritRun = await prepareSpiritRun(await withDefaultHome(spirit), { canReadFiles: target.kind === 'cli' });
      if (['cli', 'api', 'ollama'].includes(target.kind) && spiritImageModel(spirit)) {
        spiritRun.imageModel = spiritImageModel(spirit);
        spiritRun.imageSize = spirit.ai.imageSize;
        spiritRun.instructions += `\n\n${imageInstructions(spiritRun.imageModel)}`;
      }
      diagnostics(`  精靈：${spirit.name}（SOP ${spiritRun.summary.steps} 步、開放讀取資料夾 ${spiritRun.summary.dirs} 個、記憶 ${spiritRun.summary.memories ? '有' : '無'}、指示 ${spiritRun.instructions.length} 字）`);
    }
  }

  const keptContext = sanitizeContext(inheritedContext && !context?.length ? inheritedContext : context);
  const sourceKind = requestConversation.source.kind;
  // 追問也可以附上新的圖片或檔案（使用者用 📎、拖曳或貼上附加的）
  const image = imageDataUrl ? nativeImage.createFromDataURL(imageDataUrl) : undefined;
  const apiModel = target.kind === 'api' || target.kind === 'ollama' ? (typeof model === 'string' && model.trim() ? model.trim() : requestConversation.delivery?.model) : undefined;
  const vision = imageSupportFor(target, apiModel);
  // 目標看不到圖：在本機辨識圖片文字，改送文字（不默默丟掉圖片）
  let ocrText;
  if (image && !image.isEmpty() && vision === 'no') {
    try { ocrText = await runOcr(image); } catch (error) { diagnostics(`  ✗ OCR 失敗：${error.message}`); ocrText = ''; }
  }
  let hasImage = Boolean(image && !image.isEmpty() && vision !== 'no');
  const attachedText = typeof sourceText === 'string' ? sourceText : '';
  const composeText = (withImage, ocr) => (isFollowUp && !withImage && ocr === undefined && !attachedText
    ? question.trim()
    : composeDeliveryText({
      question: question.trim(), sourceText: attachedText, context: isFollowUp ? [] : keptContext,
      sourceKind: isFollowUp ? 'attachment' : sourceKind, hasImage: withImage, ocrText: ocr, imageAttached: imageAttached === true || isFollowUp,
    }));
  let text = composeText(hasImage, ocrText);
  const visionNote = ocrText !== undefined ? `${target.kind === 'api' ? apiModel : target.label} 不能看圖片，已改送圖片中辨識出的文字（本機 OCR）。` : '';

  if (!isFollowUp) {
    if (sourceKind === 'clipboard' && pendingClipboardFingerprint) {
      try { await writeFile(clipboardFingerprintPath, pendingClipboardFingerprint, { mode: 0o600 }); } catch {}
      pendingClipboardFingerprint = undefined;
    }
    requestConversation.source = { ...requestConversation.source, context: keptContext };
    requestConversation.delivery = { targetId: target.id, targetLabel: target.label, live: false, at: new Date().toISOString(), ...(spiritRun ? { spiritId: activeSpiritId, spiritName } : {}) };
  }
  const userRecord = {
    role: 'user',
    text: question.trim(),
    ...(sourceText ? { sourceText } : {}),
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(visionNote ? { note: visionNote } : {}),
  };
  requestConversation.messages.push(userRecord);
  const answer = { role: 'assistant', label: target.kind === 'cli' ? target.label.replace(/（.*）/, '') : target.app, text: '', status: 'streaming' };
  if (spiritName) answer.label = `${spiritName}（${answer.label}）`;
  // 停靠模式：把 App 的真實視窗移到圈選處旁邊，直接在 App 裡看回覆與對話，不需要讀回覆
  const docking = dock === true && (!target.kind || target.kind === 'app') && !target.noDock;
  const readsBack = ['cli', 'api', 'ollama'].includes(target.kind) || (target.readBack === 'ax' && !docking);
  if (readsBack) requestConversation.messages.push(answer);

  const controller = new AbortController();
  activeRequest = controller;
  delivering = true;
  state.busy = readsBack;
  state.error = '';
  requestConversation.phase = 'sending';
  publish();
  diagnostics(`${isFollowUp ? '追問' : '新提問'} → ${target.id}；保留的脈絡＝${keptContext.map((c) => c.app).join('、') || '無'}`);

  const finishTurn = (status, errorMessage) => {
    answer.status = status;
    if (errorMessage) state.error = errorMessage;
    requestConversation.delivery.live = status === 'complete' || Boolean(requestConversation.delivery.live);
    requestConversation.phase = 'follow-up';
    if (activeRequest === controller) activeRequest = undefined;
    delivering = false;
    state.busy = false;
    publish();
  };

  // ── 0. MixRoute API：串流回覆到對話框，追問帶上完整對話歷史 ──
  if (target.kind === 'api') {
    showDialogBesideTarget();
    try {
      const apiKey = await loadMixRouteKey();
      if (!apiKey) throw new Error('還沒有設定 MixRoute API 金鑰。');
      const chosenModel = typeof model === 'string' && model.trim() ? model.trim() : requestConversation.delivery.model;
      if (!chosenModel) throw new Error('請先選擇要用的 MixRoute 模型。');
      assertChatModel(chosenModel);
      requestConversation.delivery.model = chosenModel;
      answer.label = `MixRoute · ${chosenModel}`;
      const history = (requestConversation.delivery.apiHistory ||= []);
      if (spiritRun && !history.length) history.push({ role: 'system', content: spiritRun.instructions });
      let userMessage = buildUserMessage(text, hasImage ? imageDataUrl : undefined);
      diagnostics(`  MixRoute：模型 ${chosenModel}、歷史 ${history.length} 則、圖片 ${hasImage ? '有' : ocrText !== undefined ? '改送 OCR 文字' : '無'}（看圖能力：${vision}）`);
      const ask = (message) => streamMixRouteChat({
        apiKey,
        model: chosenModel,
        messages: [...history, message],
        signal: controller.signal,
        onDelta: (delta) => {
          answer.text += delta;
          requestConversation.phase = 'answering';
          if (conversation === requestConversation) publish();
        },
      });
      let reply;
      try {
        reply = await ask(userMessage);
        if (hasImage) await learnVision(chosenModel, 'yes');
      } catch (error) {
        if (!error.imageUnsupported || !hasImage) throw error;
        // 名稱判斷錯了：這個模型其實不能看圖 → 記下來，改送 OCR 文字重試一次
        await learnVision(chosenModel, 'no');
        let ocr = '';
        try { ocr = await runOcr(image); } catch {}
        hasImage = false;
        text = composeText(false, ocr);
        userMessage = buildUserMessage(text);
        userRecord.note = `${chosenModel} 不能看圖片，已改送圖片中辨識出的文字（本機 OCR）重試。`;
        answer.text = '';
        publish();
        reply = await ask(userMessage);
      }
      answer.text = reply || answer.text;
      history.push(userMessage, { role: 'assistant', content: answer.text });
      if (mixrouteBlocked[chosenModel]) { // 之前標記不可用、現在可以了（例如帳號已開通）
        delete mixrouteBlocked[chosenModel];
        await saveMixRouteBlocked();
      }
      diagnostics(`  ✓ MixRoute 回覆完成（${answer.text.length} 字）`);
      finishTurn('complete');
      await drawSpiritImage({ conversationRef: requestConversation, answer, imageModel: spiritRun?.imageModel, imageSize: spiritRun?.imageSize, referenceDataUrl: hasImage ? imageDataUrl : undefined });
      return { ok: true };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (!cancelled) diagnostics(`  ✗ MixRoute 失敗：${error.message}`);
      if (error.modelNotAllowed) await markMixRouteModelBlocked(requestConversation.delivery.model, error);
      finishTurn(cancelled ? 'cancelled' : 'failed', cancelled ? '' : error.message);
      return { ok: cancelled, error: cancelled ? undefined : error.message, needsKey: error.status === 401 };
    }
  }

  // ── 0b. Ollama 本機模型：串流回覆到對話框 ──
  if (target.kind === 'ollama') {
    showDialogBesideTarget();
    try {
      ollamaStatus = await probeOllama();
      if (!ollamaStatus.running) throw new Error('Ollama 沒有在執行。請先打開 Ollama App（或在終端機執行 ollama serve）。');
      const chosen = apiModel || ollamaStatus.models.find((name) => ollamaImageSupport(name) === 'yes') || ollamaStatus.models[0];
      if (!chosen) throw new Error('Ollama 還沒有下載任何模型。可以在終端機執行例如 ollama pull gemma3 下載一個。');
      requestConversation.delivery.model = chosen;
      answer.label = `Ollama · ${chosen}`;
      const history = (requestConversation.delivery.apiHistory ||= []);
      if (spiritRun && !history.length) history.push({ role: 'system', content: spiritRun.instructions });
      const userMessage = { role: 'user', content: text, ...(hasImage ? { images: [image.toPNG().toString('base64')] } : {}) };
      diagnostics(`  Ollama：模型 ${chosen}、歷史 ${history.length} 則、圖片 ${hasImage ? '有' : ocrText !== undefined ? '改送 OCR 文字' : '無'}`);
      const reply = await streamOllamaChat({
        model: chosen,
        messages: [...history, userMessage],
        signal: controller.signal,
        onDelta: (delta) => {
          answer.text += delta;
          requestConversation.phase = 'answering';
          if (conversation === requestConversation) publish();
        },
      });
      answer.text = reply || answer.text;
      history.push(userMessage, { role: 'assistant', content: answer.text });
      diagnostics(`  ✓ Ollama 回覆完成（${answer.text.length} 字）`);
      finishTurn('complete');
      await drawSpiritImage({ conversationRef: requestConversation, answer, imageModel: spiritRun?.imageModel, imageSize: spiritRun?.imageSize, referenceDataUrl: hasImage ? imageDataUrl : undefined });
      return { ok: true };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (!cancelled) diagnostics(`  ✗ Ollama 失敗：${error.message}`);
      if (error.imageUnsupported) await learnVision(`ollama:${requestConversation.delivery.model}`, 'no');
      finishTurn(cancelled ? 'cancelled' : 'failed', cancelled ? '' : error.message);
      return { ok: cancelled, error: cancelled ? undefined : error.message };
    }
  }

  // ── 1. 背景執行的指令列工具：Claude Code／Codex／Gemini CLI ──
  if (target.kind === 'cli') {
    showDialogBesideTarget();
    try {
      const common = {
        prompt: text,
        sessionId: requestConversation.delivery.sessionId,
        cwd: join(app.getPath('userData'), `${target.cli}-workspace`),
        signal: controller.signal,
        log: diagnostics,
        onDelta: (delta) => {
          answer.text += delta;
          requestConversation.phase = 'answering';
          if (conversation === requestConversation) publish();
        },
      };
      let result;
      if (target.cli === 'codex' || target.cli === 'gemini') {
        const binary = detection[target.id]?.path || await findCli(target.cli);
        if (!binary) throw new Error(`找不到 ${target.cli} 指令，請確認已安裝並登入。`);
        const ask = target.cli === 'codex' ? askCodex : askGemini;
        result = await ask({ ...common, binary, imagePng: hasImage ? image.toPNG() : undefined, instructions: spiritRun?.instructions, addDirs: spiritRun?.dirs || [] });
      } else {
        result = await askClaudeCli({
          ...common,
          cwd: join(app.getPath('userData'), 'claude-cli-workspace'),
          imagePngBase64: hasImage ? image.toPNG().toString('base64') : undefined,
          instructions: spiritRun?.instructions,
          addDirs: spiritRun?.dirs || [],
        });
      }
      answer.text = result.text || answer.text;
      if (result.sessionId) requestConversation.delivery.sessionId = result.sessionId;
      finishTurn(result.cancelled ? 'cancelled' : 'complete');
      if (!result.cancelled) await drawSpiritImage({ conversationRef: requestConversation, answer, imageModel: spiritRun?.imageModel, imageSize: spiritRun?.imageSize, referenceDataUrl: hasImage ? imageDataUrl : undefined });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Claude Code 回覆失敗。';
      if (looksLikeLoginError(message)) {
        const name = CLI_LOGIN[target.cli]?.name || target.label;
        markCliLogin(target.id, 'needed');
        if (detection[target.id]) detection[target.id].loggedIn = false;
        finishTurn('failed', `${name} 還沒登入，或登入已經過期。`);
        return { ok: false, error: state.error, needsLogin: target.id };
      }
      finishTurn('failed', message);
      return { ok: false, error: state.error };
    }
  }

  // ── 2／3. 操作 App ──
  let baseline = [];
  let helper;
  const waitsForUpload = Boolean(hasImage && target.waitForSend);
  if (readsBack || docking || waitsForUpload) {
    try {
      helper = await getAxHelper();
    } catch (error) {
      diagnostics(`讀取工具無法使用：${error.message}；這次只投遞${docking ? '，不移動視窗' : '，不讀回覆'}`);
      helper = undefined;
    }
  }
  // 並排要放在哪個螢幕：圈選範圍所在的螢幕；剪貼簿模式沒有範圍，就用小精靈對話框所在的螢幕
  const selection = requestConversation.source.selection;
  const dockAnchor = selection && Number.isFinite(selection.x)
    ? selection
    : (window && !window.isDestroyed() ? window.getBounds() : screen.getPrimaryDisplay().workArea);
  if (window && !window.isDestroyed()) window.hide(); // 讓出焦點給目標程式
  let result;
  try {
    const bundleId = helper ? await resolveTargetBundleId(target) : undefined;
    result = await deliver({
      target,
      image: hasImage ? image : undefined,
      text: spiritRun && !isFollowUp ? withPastedInstructions(spiritRun.instructions, text) : text,
      autoSubmit: target.manualSubmit ? false : readsBack || docking ? true : autoSubmit !== false, // 讀回覆與並排模式一定送出；Kiro 只貼上
      newChat: !isFollowUp,
      openPath,
      waitBeforeSubmit: helper && waitsForUpload ? () => waitForSubmitReady(helper, bundleId) : undefined,
      onBeforeSubmit: helper && readsBack ? async () => {
        baseline = (await readWindowTexts(helper, bundleId)).texts;
        return `${baseline.length} 段文字`;
      } : undefined,
    }, { clipboardIO, systemPreferences, log: diagnostics });
    result.bundleId = bundleId;
    if (result.ok && openPath) await projectStore.remember(target.id, openPath).catch(() => {}); // 下次預設選它
  } catch (error) {
    diagnostics(`投遞例外：${error instanceof Error ? error.message : String(error)}`);
    result = { ok: false, error: error instanceof Error ? error.message : '自動投遞失敗。' };
  }

  if (!result.ok) {
    answer.text = '';
    if (readsBack) requestConversation.messages.pop();
    requestConversation.messages.push({ role: 'assistant', label: target.app, status: 'complete', notice: true, text: `未能自動送出：${result.error}` });
    finishTurn('failed', result.error);
    if (Notification.isSupported()) new Notification({ title: 'Screen Spirit', body: result.error, silent: true }).show();
    showDialogBesideTarget();
    return { ok: false, error: result.error };
  }

  let docked = false;
  if (docking && helper && result.bundleId) {
    const area = screen.getDisplayMatching(dockAnchor).workArea;
    const layout = computeSplitLayout(area);
    const remember = async (key, label) => {
      if (!dockedWindows.has(key)) dockedWindows.set(key, { frame: await getWindowFrame(helper, key), label });
    };
    // AI 視窗往下讓出夾層工具列的高度（工具列放「回小精靈／固定／收起／結束並排」）
    const aiTarget = { ...layout.ai, y: layout.ai.y + DRAWER_BAR_HEIGHT, height: layout.ai.height - DRAWER_BAR_HEIGHT };
    let aiFrame = aiTarget;
    try {
      // 右側 1/3：AI App
      await remember(result.bundleId, target.app);
      aiFrame = await setWindowFrame(helper, result.bundleId, aiTarget);
      // App 有最小寬度時（例如 Claude 至少 600），實際會比要求寬：改成貼齊右緣，左欄讓出剩下的空間
      if (aiFrame?.width && Math.round(aiFrame.width) > aiTarget.width + 2) {
        aiFrame = await setWindowFrame(helper, result.bundleId, { ...aiTarget, x: area.x + area.width - aiFrame.width, width: aiFrame.width });
      }
      docked = true;
      activeDock = { targetId: target.id, bundleId: result.bundleId, frame: aiFrame };
      diagnostics(`  ✓ ${target.app} 放到右側：目標 ${JSON.stringify(layout.ai)}，實際 ${JSON.stringify(aiFrame)}`);
    } catch (error) {
      diagnostics(`  ✗ 移動 ${target.app} 視窗失敗：${error.message}`);
      if (Notification.isSupported()) new Notification({ title: 'Screen Spirit', body: `已送出，但${error.message}`, silent: true }).show();
    }
    // 左側 2/3：圈選來源的程式（圈的就是 AI App 本身時不動）
    const { primaryPid, primaryApp } = requestConversation.source;
    if (docked && primaryPid && primaryApp && primaryApp !== target.app && !ownProcessIds().has(primaryPid)) {
      const key = String(primaryPid);
      try {
        await remember(key, primaryApp);
        const aiLeft = Number.isFinite(aiFrame?.x) ? aiFrame.x : layout.ai.x;
        // 抽屜：左邊直接全寬（AI 疊在上面、之後不再縮放）；固定並排：左邊讓出 AI 的寬度
        const sourceFrame = layoutMode === 'drawer'
          ? { x: area.x, y: area.y, width: area.width, height: area.height }
          : { x: area.x, y: area.y, width: Math.max(300, Math.round(aiLeft - area.x)), height: area.height };
        const applied = await setWindowFrame(helper, key, sourceFrame);
        diagnostics(`  ✓ ${primaryApp} 放到左側：目標 ${JSON.stringify(sourceFrame)}，實際 ${JSON.stringify(applied)}`);
      } catch (error) {
        diagnostics(`  ✗ 移動 ${primaryApp} 視窗失敗：${error.message}`);
      }
    } else if (docked) {
      diagnostics(`  左側不動：${!primaryPid ? '沒有偵測到來源程式' : primaryApp === target.app ? '圈選的就是 AI App 本身' : '來源是小精靈自己'}`);
    }
    if (docked) {
      // 抽屜與固定並排都用同一個控制器：固定並排＝一開始就「固定」（不自動收起、左邊 2/3）
      try {
        const sourceKey = primaryPid && primaryApp && primaryApp !== target.app && dockedWindows.has(String(primaryPid)) ? String(primaryPid) : undefined;
        await drawer.start({ bundleId: result.bundleId, appName: target.app, shown: aiFrame, area, sourceKey, pinned: layoutMode === 'split' });
      } catch (error) {
        diagnostics(`  ✗ 抽屜／工具列啟動失敗：${error.message}`);
      }
    }
    tray?.setContextMenu(buildSpiritMenu());
  }

  if (!readsBack || !helper) {
    // 只投遞（或停靠）：記一筆紀錄後結束這段對話，之後直接在 App 裡繼續
    if (readsBack) requestConversation.messages.pop();
    requestConversation.messages.push({
      role: 'assistant',
      label: target.app,
      status: 'complete',
      notice: true,
      text: docked
        ? `已送到 ${target.label}，並排顯示在右側。請直接在 ${target.app} 裡看回覆、繼續對話；要放回原位，從小精靈選單選「還原並排的視窗」。`
        : target.manualSubmit
          ? `已在 ${target.app}${openPath ? ` 的「${openPath.split('/').pop()}」專案` : ''}貼上圖片與問題，還沒送出：請在 ${target.app} 裡確認後自己按送出。`
          : `已送到 ${target.label}${autoSubmit === false ? '（已貼上，等你按送出）' : ''}。回覆請在該程式查看。`,
    });
    delivering = false;
    state.busy = false;
    activeRequest = undefined;
    await finishCurrentConversation({ reveal: false });
    return { ok: true };
  }

  // ── 2. 從 App 畫面讀回回覆 ──
  showDialogBesideTarget();
  requestConversation.phase = 'answering';
  publish();
  try {
    const reply = await waitForReply({
      binary: helper,
      bundleId: result.bundleId,
      anchor: questionAnchor(text),
      baseline,
      signal: controller.signal,
      log: diagnostics,
      onUpdate: (value) => {
        answer.text = value;
        if (conversation === requestConversation) publish();
      },
    });
    answer.text = reply;
    finishTurn(controller.signal.aborted ? 'cancelled' : 'complete');
    return { ok: true };
  } catch (error) {
    if (error?.code === 'anchor-not-found') {
      const dumpPath = join(diagnosticsLogPath, '..', 'claude-ax-dump.json');
      const saved = await dumpWindow(helper, result.bundleId, dumpPath);
      diagnostics(`找不到剛送出的問題；${saved ? `已輸出畫面結構到 ${dumpPath}` : '畫面結構輸出失敗'}`);
    }
    finishTurn('failed', `已送到 ${target.label}，但讀不到回覆：${error instanceof Error ? error.message : '未知錯誤'} 回覆仍可在 ${target.app} 查看。`);
    return { ok: false, error: state.error };
  }
});
handle('cancel', () => {
  activeRequest?.abort();
});
handle('clear', () => {
  if (state.busy) throw new Error('Wait for or cancel the current response before clearing this test conversation.');
  conversation = createConversationSession({}, state.presentationMode);
  state.error = '';
  applyWindowPresentation();
  publish();
  return snapshot();
});
handle('manage-usage', () => shell.openExternal(CHATGPT_USAGE_URL));
handle('disconnect', async () => {
  if (state.busy) activeRequest?.abort();
  await chatgpt.disconnect();
  conversation = createConversationSession({}, state.presentationMode);
  applyWindowPresentation();
  await refreshSession();
  return snapshot();
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function applyWindowPresentation() {
  if (!window || window.isDestroyed()) return;
  const companionMode = conversation.presentationMode === 'companion';
  const [currentWidth, currentHeight] = window.getSize();
  const selection = conversation.source.selection;
  const hasSelection = selection &&
    Number.isFinite(selection.x) && Number.isFinite(selection.y) &&
    Number.isFinite(selection.width) && Number.isFinite(selection.height);
  const anchor = hasSelection
    ? { x: selection.x + selection.width / 2, y: selection.y + selection.height / 2 }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(anchor);
  const { x, y, width: areaWidth, height: areaHeight } = display.workArea;
  const width = Math.min(currentWidth, areaWidth);
  const height = Math.min(currentHeight, areaHeight);

  let left;
  let top;
  if (companionMode) {
    left = x + areaWidth - width - 20;
    top = y + 36;
  } else if (!hasSelection) {
    left = x + (areaWidth - width) / 2;
    top = y + (areaHeight - height) / 2;
  } else {
    left = selection.x + selection.width + 18;
    top = selection.y + selection.height + 18;
    if (left + width > x + areaWidth) left = selection.x - width - 18;
    if (top + height > y + areaHeight) top = selection.y - height - 18;
  }
  left = clamp(left, x, x + areaWidth - width);
  top = clamp(top, y, y + areaHeight - height);

  window.setBounds({ x: Math.round(left), y: Math.round(top), width, height });
  window.webContents.send('poc:presentation', conversation.presentationMode);
}

async function createWindow() {
  window = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 460,
    minHeight: 520,
    resizable: true,
    frame: true,
    title: 'Screen Spirit',
    backgroundColor: '#f6f5f1',
    show: false,
    webPreferences: {
      preload: join(directory, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 觸控板雙指捏合要送到網頁（工作流畫布自己縮放）；網頁會攔下來，整個視窗不會被放大
  Promise.resolve().then(() => window.webContents.setVisualZoomLevelLimits(1, 3)).catch(() => {});
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key?.toLowerCase();
    const closeShortcut = (input.meta || input.control) && key === 'w';
    if (input.type === 'keyDown' && (input.key === 'Escape' || closeShortcut)) {
      event.preventDefault();
      void finishCurrentConversation();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== htmlUrl) event.preventDefault();
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) console.error('Prototype window failed to load:', errorCode, errorDescription, validatedURL);
  });
  await window.loadURL(htmlUrl);
  applyWindowPresentation();
  app.dock?.show();
}

async function createCompanionWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  companionWindow = new BrowserWindow({
    x: x + width - 166,
    y: y + height - 184,
    width: 166,
    height: 184,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(directory, 'companion-preload.cjs'),
      // 小精靈視窗幾乎不會取得焦點；關閉節流避免 macOS 把透明浮動視窗判成被遮住而降低動畫幀率。
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  companionWindow.setAlwaysOnTop(true, 'floating');
  companionWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await companionWindow.loadURL(companionHtmlUrl);
  companionSkinId = undefined;
  syncCompanion();
  sendCompanion('poc:companion-mood', companionMood);
  setCompanionCollapsed(true);
  companionWindow.show();
  companionWindow.moveTop();
  scheduleCompanionProximity(COMPANION_POLL_NEAR_MS);
}

function setCompanionCollapsed(collapsed) {
  if (!companionWindow || companionWindow.isDestroyed() || companionCollapsed === collapsed) return;
  companionCollapsed = collapsed;
  companionOutsideSince = undefined;
  companionWindow.setIgnoreMouseEvents(collapsed, collapsed ? { forward: true } : {});
  companionWindow.webContents.send('poc:companion-collapse', collapsed);
}

// 滑鼠偵測頻率依距離調整：遠的時候少檢查，靠近時才密集檢查，反應速度不變、平常更省。
const COMPANION_POLL_NEAR_MS = 33;   // 靠近或已展開：最多延遲約 33 ms 就開始展開
const COMPANION_POLL_FAR_MS = 150;   // 遠離：只有滑鼠從遠處快速甩過來時，展開才可能多慢約 0.15 秒
const COMPANION_NEAR_DISTANCE = 220; // 與小精靈視窗邊緣的距離（px）在這以內就算「靠近」

function scheduleCompanionProximity(delay) {
  clearTimeout(companionCollapseTimer);
  companionCollapseTimer = setTimeout(() => {
    let next = COMPANION_POLL_NEAR_MS;
    try {
      next = updateCompanionProximity();
    } finally {
      if (companionWindow && !companionWindow.isDestroyed()) scheduleCompanionProximity(next);
    }
  }, delay);
  companionCollapseTimer.unref?.();
}

function distanceToBounds(point, bounds) {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.hypot(dx, dy);
}

// 回傳下一次檢查要等幾毫秒。
function updateCompanionProximity() {
  if (!companionWindow || companionWindow.isDestroyed() || !companionWindow.isVisible()) return COMPANION_POLL_FAR_MS;
  const bounds = companionWindow.getBounds();
  const pointer = screen.getCursorScreenPoint();
  if (companionCollapsed) {
    const peekX = bounds.x + bounds.width - 21;
    const peekY = bounds.y + bounds.height - 42;
    if (Math.hypot(pointer.x - peekX, pointer.y - peekY) <= 58) {
      setCompanionCollapsed(false);
      return COMPANION_POLL_NEAR_MS;
    }
    return distanceToBounds(pointer, bounds) <= COMPANION_NEAR_DISTANCE ? COMPANION_POLL_NEAR_MS : COMPANION_POLL_FAR_MS;
  }

  const inside = pointer.x >= bounds.x && pointer.x <= bounds.x + bounds.width &&
    pointer.y >= bounds.y && pointer.y <= bounds.y + bounds.height;
  if (inside) {
    companionOutsideSince = undefined;
    return COMPANION_POLL_NEAR_MS;
  }
  if (!companionOutsideSince) companionOutsideSince = Date.now();
  if (Date.now() - companionOutsideSince >= 1700) setCompanionCollapsed(true);
  return COMPANION_POLL_NEAR_MS;
}

// npm run poc:skin-test：造型可行性測試（用 App 存的 MixRoute 金鑰跑一次，產生報告後結束；不會開啟任何視窗，也不影響正在執行的小精靈）
const skinTestIndex = process.argv.indexOf('--skin-test');
if (skinTestIndex >= 0) {
  app.whenReady().then(async () => {
    const { runSkinTestFromCli } = await import('./skin-test.mjs');
    const code = await runSkinTestFromCli({
      argv: process.argv.slice(skinTestIndex + 1),
      apiKey: await loadMixRouteKey(),
      userData: app.getPath('userData'),
      directory,
      openPath: (path) => shell.openPath(path),
      ensureHelper: ensureAxHelper,
    });
    app.exit(code);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    installChromiumFetchForOpenAI();
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('OS-backed credential encryption is unavailable on this computer.');
    historyStore = createHistoryStore({
      directory: join(app.getPath('userData'), 'history'),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: async (value) => {
        // 只解密一次（同上）；紀錄 24 小時內就會到期，不另外重新加密。
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(value));
        return decrypted.result;
      },
    });
    await historyStore.removeExpired();
    const historyCleanupTimer = setInterval(() => void historyStore.removeExpired(), 60 * 60 * 1000);
    historyCleanupTimer.unref?.();
    deliveryTargets = await loadDeliveryTargets(deliveryTargetsPath);
    await loadMixRouteBlocked();
    await loadVisionLearned();
    await loadLayoutMode();
    await loadDesktopSpirit();
    void refreshMixRouteStatus(); // 有存金鑰就在背景載入模型清單
    consent = await loadConsent(consentPath);
    await seedSpiritsIfFresh();
    void runDetection(); // 偵測這台電腦上有哪些 AI（在背景進行，完成後更新畫面）
    state.presentationMode = await loadPresentationMode(preferencesPath);
    conversation = createConversationSession({}, state.presentationMode);
    await refreshSession();
    chatgpt.subscribe((session) => {
      state.session = session;
      publish();
    });
    await createWindow();
    await createCompanionWindow();
    createTray();
    if (!consent.decided) {
      // 第一次使用：打開主視窗，請使用者確認要連接哪些 AI
      openChatWindow();
      window.webContents.send('poc:open-integrations');
    }
    state.selectionHotkeyRegistered = globalShortcut.register(selectionAccelerator, () => {
      console.info(`Screen selection shortcut activated: ${selectionAccelerator}`);
      void beginScreenSelection();
    });
    const drawerHotkey = globalShortcut.register(drawerAccelerator, () => { void drawer.toggle(); });
    console.info('Drawer hotkey registered:', drawerHotkey, drawerAccelerator);
    state.clipboardHotkeyRegistered = globalShortcut.register(clipboardAccelerator, () => {
      console.info(`Clipboard question shortcut activated: ${clipboardAccelerator}`);
      void beginClipboardQuestion();
    });
    console.info('Screen selection hotkey registered:', state.selectionHotkeyRegistered, selectionAccelerator);
    console.info('Clipboard question hotkey registered:', state.clipboardHotkeyRegistered, clipboardAccelerator);
    console.info('Screen capture permission status:', systemPreferences.getMediaAccessStatus('screen'));
    if (!state.selectionHotkeyRegistered) state.error = '全域快捷鍵 ⌘⇧1 無法註冊；仍可使用小精靈上的圈選按鈕。';
    publish();
  }).catch((error) => {
    console.error('Screen Spirit feasibility prototype could not start:', safeError(error));
    app.quit();
  });
}

app.on('activate', () => {
  if (window && !window.isDestroyed() && conversation.messages.length) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.send('poc:open-chat');
  } else if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.show();
    companionWindow.moveTop();
  }
  app.focus({ steal: true });
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearTimeout(historySaveTimer);
  const pendingSave = conversation.messages.length && historyStore
    ? historyWriteQueue.then(() => historyStore.save(structuredClone(conversation)))
    : historyWriteQueue;
  void pendingSave.catch((error) => {
    console.error('Could not save conversation before quitting:', error instanceof Error ? error.message : 'unknown error');
  }).then(() => restoreDockedWindows()).catch(() => {}).finally(() => app.quit()); // 結束前把停靠過的視窗放回原位
});

app.on('before-quit', () => {
  quitting = true;
  activeRequest?.abort();
  globalShortcut.unregisterAll();
  selectionCapture = undefined;
  closeSelectionWindow();
  chatgpt.cancelSignIn();
});
