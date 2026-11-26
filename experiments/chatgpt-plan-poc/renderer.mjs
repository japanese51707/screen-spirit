import { createSpiritLab } from './spirit-lab.mjs';
import { getLanguage, L, LANGUAGES, setLanguage, tr } from './i18n.mjs';
import { installTranslator } from './i18n-dom.mjs';
import { createWorkflowView } from './workflow.mjs';

const bridge = window.screenSpirit;
const statusDot = document.querySelector('#status-dot');
const statusLabel = document.querySelector('#status-label');
const connectButton = document.querySelector('#connect-button');
const modelSelect = document.querySelector('#model-select');
const presentationModeSelect = document.querySelector('#presentation-mode');
const selectScreenButton = document.querySelector('#select-screen-button');
const selectionStatus = document.querySelector('#selection-status');
const transcript = document.querySelector('#transcript');
const emptyState = document.querySelector('#empty-state');
const composer = document.querySelector('#composer');
const question = document.querySelector('#question');
const imageFile = document.querySelector('#image-file');
const imagePreview = document.querySelector('#image-preview');
const previewImage = document.querySelector('#preview-image');
const previewName = document.querySelector('#preview-name');
const errorBanner = document.querySelector('#error-banner');
const errorText = document.querySelector('#error-text');
const builtinErrorRow = document.querySelector('#builtin-error-row');
const builtinErrorText = document.querySelector('#builtin-error');
let dismissedError = '';
const cliLoginBar = document.querySelector('#cli-login-bar');
const cliLoginText = document.querySelector('#cli-login-text');
const cliLoginButton = document.querySelector('#cli-login-button');
const CLI_NAMES = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini CLI' };
let pendingLoginRetry; // 因為沒登入而失敗的那一題：登入完成後自動重新送出 // 使用者按 × 關掉的訊息；同一則不再顯示，換新訊息才會再出現
const composerHint = document.querySelector('#composer-hint');
const selectionQuestionDialog = document.querySelector('#selection-question-dialog');
const selectionQuestionForm = document.querySelector('#selection-question-form');
const selectionQuestionInput = document.querySelector('#selection-question');
const selectionQuestionImage = document.querySelector('#selection-question-image');
const selectionQuestionDescription = document.querySelector('#selection-question-description');
const selectionQuestionSource = document.querySelector('#selection-question-source');
const selectionQuestionSourceText = document.querySelector('#selection-question-source-text');
const selectionQuestionTranscript = document.querySelector('#selection-question-transcript');
const selectionQuestionHint = document.querySelector('#selection-question-hint');
const selectionQuestionSendButton = document.querySelector('#selection-question-send');
const selectionQuestionConnectButton = document.querySelector('#selection-question-connect');
const selectionContext = document.querySelector('#selection-context');
const selectionTarget = document.querySelector('#selection-target');
const selectionAutoSubmit = document.querySelector('#selection-auto-submit');
const selectionDock = document.querySelector('#selection-dock');
const selectionModel = document.querySelector('#selection-model');
const selectionProject = document.querySelector('#selection-project');
const selectionSpirit = document.querySelector('#selection-spirit');
let spiritList = []; // 精靈博士裡設定好的精靈
let spiritNote = '';
const projectLists = {}; // targetId → 最近的專案清單（Kiro 等以專案為單位的編輯器）
const projectLoading = new Set();
const selectionApiKeyButton = document.querySelector('#selection-api-key');
const apiKeyDialog = document.querySelector('#api-key-dialog');
const apiKeyForm = document.querySelector('#api-key-form');
const apiKeyInput = document.querySelector('#api-key-input');
const apiKeyError = document.querySelector('#api-key-error');
const apiKeyCurrent = document.querySelector('#api-key-current');
const apiKeyClear = document.querySelector('#api-key-clear');
const apiKeySave = document.querySelector('#api-key-save');
const apiKeyBlocked = document.querySelector('#api-key-blocked');
const apiKeyBlockedText = document.querySelector('#api-key-blocked-text');
// 主視窗（一頁式控制台）
const homeTarget = document.querySelector('#home-target');
const homeModel = document.querySelector('#home-model');
const homeModelRow = document.querySelector('#home-model-row');
const homeLayoutRow = document.querySelector('#home-layout-row');
const homeTargetHint = document.querySelector('#home-target-hint');
const homeLayoutButtons = [...document.querySelectorAll('#home-layout-row [data-layout]')];
const drawerCard = document.querySelector('#drawer-card');
const drawerApp = document.querySelector('#drawer-app');
const drawerStatePill = document.querySelector('#drawer-state');
const drawerToggleButton = document.querySelector('#drawer-toggle');
const drawerPinButton = document.querySelector('#drawer-pin');
// 連線設定（第一次使用時偵測、同意）
const integrationsDialog = document.querySelector('#integrations-dialog');
const integrationsForm = document.querySelector('#integrations-form');
const integrationsList = document.querySelector('#integrations-list');
const integrationsBanner = document.querySelector('#integrations-banner');
const integrationsBannerText = document.querySelector('#integrations-banner-text');
let integrationsDraft; // 使用者在視窗裡勾選、還沒儲存的狀態
let integrationsDefault = ''; // 視窗裡選的「預設」，還沒儲存
let defaultTargetSynced = false;
const BUILTIN_TARGET = 'builtin';
const sendButton = document.querySelector('#send-button');
const cancelButton = document.querySelector('#cancel-button');
const usageButton = document.querySelector('#usage-button');
const clearButton = document.querySelector('#clear-button');
const disconnectButton = document.querySelector('#disconnect-button');
const hideChatButton = document.querySelector('#hide-chat-button');
const historyButton = document.querySelector('#history-button');
const historyDialog = document.querySelector('#history-dialog');
const historyList = document.querySelector('#history-list');
const historyClearButton = document.querySelector('#history-clear');

let state;
let selectedImage;
let selectedSourceText = '';
let sourceWarning = '';
let transcriptFitQueued = false;
let selectedContext = [];

function readPreference(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
// 「預設 AI」：每次新的圈選／反白都先選它；提問框裡臨時換的不會改掉預設
const DEFAULT_TARGET_KEY = 'screenSpirit.target';
function defaultTargetId() {
  return readPreference(DEFAULT_TARGET_KEY, '') || state?.integrations?.defaultTarget || '';
}
function setDefaultTarget(id) {
  if (!id) return;
  writePreference(DEFAULT_TARGET_KEY, id);
  // 主程式也要知道（精靈「跟著預設」、工作流、記憶整理都用它）
  if (state?.integrations?.decided && state.integrations.defaultTarget !== id) void bridge.defaultTargetSet?.(id);
}
function resetTargetToDefault() {
  if (lockedTargetId()) return;
  const wanted = defaultTargetId();
  const option = [...selectionTarget.options].find((item) => item.value === wanted && !item.disabled);
  if (option) selectionTarget.value = wanted;
}
selectionAutoSubmit.checked = readPreference('screenSpirit.autoSubmit', 'true') !== 'false';
selectionDock.checked = readPreference('screenSpirit.dock', 'true') !== 'false';

// 停靠：只適用操作 App 的目標；勾選時不讀回覆，直接在 App 裡看
// ── 精靈：提問框可以選一隻精靈來處理，AI 改用精靈指定的 ──
async function loadSpirits() {
  try { spiritList = await bridge.spiritsList(); } catch { spiritList = []; }
  if (state) render();
}
// 已經送出過的對話：鎖定在同一隻精靈，追問才會照同一套設定
function lockedSpiritId() {
  return state?.messages?.length ? state?.conversation?.spiritId || '' : '';
}
function currentSpirit() {
  return spiritList.find((spirit) => spirit.id === selectionSpirit.value);
}
function renderSpiritOptions() {
  const locked = lockedSpiritId();
  const signature = JSON.stringify(spiritList.map((spirit) => [spirit.id, spirit.name, spirit.look?.emoji]));
  if (selectionSpirit.dataset.signature !== signature) {
    const wanted = selectionSpirit.value;
    selectionSpirit.replaceChildren(new Option('不使用精靈', ''), ...spiritList.map((spirit) => new Option(`${spirit.look?.emoji || '✦'} ${spirit.name}`, spirit.id)));
    selectionSpirit.value = spiritList.some((spirit) => spirit.id === wanted) ? wanted : '';
    selectionSpirit.dataset.signature = signature;
  }
  if (locked) selectionSpirit.value = locked;
  selectionSpirit.disabled = Boolean(locked) || Boolean(state?.busy);
  selectionSpirit.parentElement.hidden = !spiritList.length && !locked;
}
/** 選了精靈：「送到」改成精靈指定的 AI（不能用時改用備用 AI），並鎖住不讓改 */
function applySpiritTarget() {
  spiritNote = '';
  const spirit = currentSpirit();
  if (!spirit || lockedTargetId()) return;
  const usable = (id) => Boolean(id) && [...selectionTarget.options].some((option) => option.value === id && !option.disabled);
  const chosen = usable(spirit.ai.targetId) ? spirit.ai.targetId : usable(spirit.ai.fallbackTargetId) ? spirit.ai.fallbackTargetId : '';
  if (chosen) {
    selectionTarget.value = chosen;
    selectionTarget.disabled = true;
    if (chosen !== spirit.ai.targetId) spiritNote = '主要 AI 目前不能用，改用備用 AI。';
  } else if (spirit.ai.targetId) {
    spiritNote = '精靈指定的 AI 目前不能用，改用「送到」選的 AI。';
  }
}
function applySpiritModel(target) {
  const spirit = currentSpirit();
  if (!spirit?.ai.model || lockedTargetId() || target?.id !== spirit.ai.targetId) return;
  if ([...selectionModel.options].some((option) => option.value === spirit.ai.model && !option.disabled)) selectionModel.value = spirit.ai.model;
}
function spiritHint() {
  const spirit = currentSpirit();
  if (!spirit) return '';
  const steps = spirit.sop.steps.filter((step) => step.title.trim()).length;
  const draws = spirit.ai.imageModel || (state?.mixroute?.kinds?.[spirit.ai.model] === 'image');
  const parts = [L('角色與限制', 'role & limits'), steps ? L(`${steps} 步 SOP`, `${steps}-step SOP`) : '', spirit.memory.home ? L('資料庫', 'knowledge base') : '', draws ? L('會畫圖', 'draws images') : ''].filter(Boolean).join(L('、', ', '));
  return L(`🧙 由「${spirit.name}」處理（${parts}${spirit.memory.mode === 'persistent' ? '，結束後整理記憶' : ''}）。${spiritNote}`,
    `🧙 Handled by "${spirit.name}" (${parts}${spirit.memory.mode === 'persistent' ? ', saves memories afterwards' : ''}). ${spiritNote}`);
}

/** 派精靈工作：開一段新的對話（不用先圈選），選好精靈直接輸入要求 */
async function openSpiritTask(spiritId = '') {
  try {
    const result = await bridge.beginSpiritTask();
    if (result?.ok === false) { state.error = result.error; render(); return; }
    state = await bridge.getState();
  } catch (error) {
    state.error = error.message;
    render();
    return;
  }
  pendingLoginRetry = undefined;
  resetSourcePreview();
  await loadSpirits();
  resetTargetToDefault();
  selectionSpirit.value = spiritId || spiritList[0]?.id || '';
  selectionQuestionDescription.textContent = '直接輸入要交給精靈的工作。需要附上畫面時，也可以先圈選（⌘⇧1）或反白文字（⌘⇧2），再在這裡選精靈。';
  render();
  if (!selectionQuestionDialog.open) selectionQuestionDialog.showModal(); syncSpiritPreview();
  fitQuestionTranscript();
  selectionQuestionInput.focus();
}
selectionSpirit.addEventListener('change', () => syncSpiritPreview());
selectionSpirit.addEventListener('change', () => {
  if (!selectionSpirit.value) { selectionTarget.disabled = false; resetTargetToDefault(); }
  render();
});

function isDocking(target = currentTarget()) {
  return target?.kind === 'app' && !target.noDock && selectionDock.checked;
}

// ── 以專案為單位的編輯器（Kiro）：選要在哪個專案裡問 ──
const PROJECT_CURRENT = '';
const PROJECT_BROWSE = '__browse__';
const PROJECT_NEW = '__new__';
const projectPrefKey = (target) => `screenSpirit.project.${target.id}`;

async function refreshProjects(targetId) {
  if (projectLoading.has(targetId)) return;
  projectLoading.add(targetId);
  try { projectLists[targetId] = await bridge.listProjects(targetId); } catch { projectLists[targetId] = []; }
  projectLoading.delete(targetId);
  render();
}

function selectedProject(target = currentTarget()) {
  if (!target?.projectBased) return undefined;
  const value = selectionProject.value;
  return value && value !== PROJECT_BROWSE && value !== PROJECT_NEW ? value : undefined;
}

function renderProjectOptions(target) {
  const list = projectLists[target.id];
  if (!list) { void refreshProjects(target.id); }
  const items = list || [];
  const signature = JSON.stringify([target.id, items.map((item) => item.path)]);
  if (selectionProject.dataset.signature !== signature) {
    const current = new Option(L(`${target.label.replace(/\s*[（(].*[）)]/, '')} 目前的視窗（不切換專案）`, `${target.label.replace(/\s*[（(].*[）)]/, '')}'s current window (don't switch project)`), PROJECT_CURRENT);
    const recent = document.createElement('optgroup');
    recent.label = items.length ? '最近的專案' : '（還沒有最近的專案）';
    recent.append(...items.map((item) => {
      const option = new Option(item.name, item.path);
      option.title = item.path;
      return option;
    }));
    selectionProject.replaceChildren(current, recent, new Option('選擇其他資料夾…', PROJECT_BROWSE), new Option('開新專案…', PROJECT_NEW));
    selectionProject.dataset.signature = signature;
  }
  const wanted = readPreference(projectPrefKey(target), items[0]?.path || PROJECT_CURRENT);
  const valid = wanted === PROJECT_CURRENT || items.some((item) => item.path === wanted);
  if (selectionProject.value !== wanted || !valid) selectionProject.value = valid ? wanted : PROJECT_CURRENT;
  selectionProject.title = selectedProject(target) || '不切換專案，用 Kiro 目前開著的視窗';
}

selectionProject.addEventListener('change', async () => {
  const target = currentTarget();
  if (!target?.projectBased) return;
  const value = selectionProject.value;
  if (value === PROJECT_BROWSE || value === PROJECT_NEW) {
    try {
      const result = await bridge.pickProject({ targetId: target.id, mode: value === PROJECT_NEW ? 'new' : 'browse' });
      if (result?.ok && result.path) {
        writePreference(projectPrefKey(target), result.path);
        delete projectLists[target.id];
        selectionProject.dataset.signature = '';
        await refreshProjects(target.id);
      }
    } catch (error) {
      state.error = error.message;
    }
    render(); // 取消的話回到原本選的專案
    return;
  }
  writePreference(projectPrefKey(target), value);
  render();
});
// 這次送出後，回覆會不會顯示在小精靈對話框
function targetReadsBack(target = currentTarget()) {
  if (!target) return false;
  return ['cli', 'api', 'ollama'].includes(target.kind) || (Boolean(target.readsBack) && !isDocking(target));
}

// 有「模型」選單的目標：MixRoute（雲端 API）、Ollama（本機）
const MODEL_KINDS = new Set(['api', 'ollama']);
function modelStateFor(target = currentTarget()) {
  return target?.kind === 'ollama' ? (state?.ollama || {}) : (state?.mixroute || {});
}
function modelPrefKey(target = currentTarget()) {
  return target?.kind === 'ollama' ? 'screenSpirit.ollamaModel' : 'screenSpirit.mixrouteModel';
}
function targetById(id) {
  return (state?.deliveryTargets || []).find((item) => item.id === id);
}

// ── 看圖能力：附了圖片、但這次的 AI 不能看圖或不確定時，先講清楚會怎麼處理 ──
function imageSupportOf(target = currentTarget()) {
  if (!target) return 'yes';
  if (MODEL_KINDS.has(target.kind)) return modelStateFor(target).imageSupport?.[selectionModel.value] || 'unknown';
  return target.image || 'yes';
}

// 提示文字裡「附上什麼」：不能看圖的目標會改送圖片中的文字
function imagePart(target = currentTarget()) {
  if (!selectedImage) return '';
  return imageSupportOf(target) === 'no' ? L('圖片中的文字（OCR）、', 'the text in the image (OCR), ') : L('圈選圖片、', 'the selected image, ');
}

function suggestVisionModel() {
  const mixroute = modelStateFor();
  return (mixroute.models || []).find((id) => mixroute.imageSupport?.[id] === 'yes' && !mixroute.blocked?.[id]) || '';
}

function visionHint(target = currentTarget()) {
  if (!selectedImage || !target || target.id === BUILTIN_TARGET) return '';
  const support = imageSupportOf(target);
  const who = MODEL_KINDS.has(target.kind) ? L(`模型 ${selectionModel.value}`, `Model ${selectionModel.value}`) : target.label.replace(/\s*[（(].*[）)]/, '');
  if (support === 'no') {
    const alternative = MODEL_KINDS.has(target.kind) ? suggestVisionModel() : '';
    return L(`⚠︎ ${who} 不能看圖片：會改送圖片中辨識出的文字（本機 OCR）${alternative ? `；想讓 AI 直接看圖，可以換成 ${alternative}` : ''}。`,
      `⚠︎ ${who} can't read images: the text recognized in the image (local OCR) will be sent instead${alternative ? `. To let the AI see the image, switch to ${alternative}` : ''}.`);
  }
  if (support === 'unknown') {
    return target.kind === 'api'
      ? L(`不確定 ${who} 能不能看圖片：會先送圖片，不行的話自動改送圖片中的文字。`, `Not sure whether ${who} can read images: the image is sent first, and the recognized text is sent instead if that fails.`)
      : L(`不確定 ${who} 能不能看圖片：圖片會照常貼上。`, `Not sure whether ${who} can read images: the image will be pasted as usual.`);
  }
  return '';
}

// ── MixRoute：金鑰視窗與模型選單 ──
function openApiKeyDialog() {
  const mixroute = state?.mixroute || {};
  apiKeyInput.value = '';
  apiKeyError.textContent = mixroute.error || '';
  apiKeyCurrent.hidden = !mixroute.hasKey;
  apiKeyCurrent.textContent = mixroute.hasKey ? L(`目前已存的金鑰：${mixroute.keyHint}。輸入新的金鑰會取代它。`, `Saved key: ${mixroute.keyHint}. Entering a new key replaces it.`) : '';
  apiKeyClear.hidden = !mixroute.hasKey;
  const blockedCount = Object.keys(mixroute.blocked || {}).length;
  apiKeyBlocked.hidden = !blockedCount;
  apiKeyBlockedText.textContent = blockedCount ? L(`已標記 ${blockedCount} 個模型為「此帳號不可用」。`, `${blockedCount} model(s) marked as "not available for this account".`) : '';
  apiKeySave.disabled = false;
  apiKeySave.textContent = '驗證並儲存';
  if (!apiKeyDialog.open) apiKeyDialog.showModal();
  apiKeyInput.focus();
}

// 模型選單分兩組：可以用的在上面；用過失敗、被標記「此帳號不可用」的放在下面（仍可選，帳號開通後可以再試）
function renderModelOptions(target = currentTarget()) {
  const mixroute = modelStateFor(target);
  const models = mixroute.models || [];
  const blocked = mixroute.blocked || {};
  const visionSignature = (target?.kind || '') + Object.entries(mixroute.imageSupport || {}).filter(([, v]) => v === 'no').map(([k]) => k).sort().join('|');
  const kinds = mixroute.kinds || {}; // 生圖、影片、語音等不能對話的模型
  const signature = `${models.join('|')}#${Object.keys(blocked).sort().join('|')}#${visionSignature}#${Object.keys(kinds).sort().join('|')}`;
  if (selectionModel.dataset.signature !== signature) {
    if (!models.length) {
      const empty = target?.kind === 'ollama'
        ? (mixroute.running ? '還沒有下載模型' : 'Ollama 沒有在執行')
        : (mixroute.hasKey ? '讀取中…' : '先設定金鑰');
      selectionModel.replaceChildren(new Option(empty, ''));
    } else {
      const KIND_LABEL = { image: '生圖模型', video: '影片模型', audio: '語音模型', embedding: '向量模型' };
      const usable = models.filter((id) => !blocked[id] && !kinds[id]);
      const unusable = models.filter((id) => blocked[id] && !kinds[id]);
      const notChat = models.filter((id) => kinds[id]);
      const groups = [];
      const usableGroup = document.createElement('optgroup');
      usableGroup.label = unusable.length ? '可以用' : '模型';
      const support = mixroute.imageSupport || {};
      usableGroup.append(...usable.map((id) => new Option(support[id] === 'no' ? L(`${id}（不支援圖片）`, `${id} (no images)`) : id, id)));
      groups.push(usableGroup);
      if (unusable.length) {
        const unusableGroup = document.createElement('optgroup');
        unusableGroup.label = '此帳號不可用（用過失敗）';
        unusableGroup.append(...unusable.map((id) => new Option(`⚠︎ ${id}`, id)));
        groups.push(unusableGroup);
      }
      if (notChat.length) {
        const notChatGroup = document.createElement('optgroup');
        notChatGroup.label = '不能對話（生圖、影片、語音等專用模型）';
        notChatGroup.append(...notChat.map((id) => {
          const option = new Option(L(`${id}（${KIND_LABEL[kinds[id]] || '專用模型'}）`, `${id} (${tr(KIND_LABEL[kinds[id]] || '專用模型')})`), id);
          option.disabled = true;
          return option;
        }));
        groups.push(notChatGroup);
      }
      selectionModel.replaceChildren(...groups);
    }
    selectionModel.dataset.signature = signature;
  }
  const lockedModel = target && lockedTargetId() === target.id ? state.conversation?.delivery?.model : '';
  let wanted = lockedModel || readPreference(modelPrefKey(target), mixroute.defaultModel || '');
  // 記住的模型被標記不可用時，自動換成可以用的預設模型（追問中的對話不換）
  if (!lockedModel && (blocked[wanted] || kinds[wanted]) && mixroute.defaultModel) wanted = mixroute.defaultModel;
  selectionModel.value = models.includes(wanted) ? wanted : (mixroute.defaultModel || models[0] || '');
  selectionModel.title = blocked[selectionModel.value] ? L(`之前失敗：${blocked[selectionModel.value]}`, `Failed before: ${blocked[selectionModel.value]}`) : '';
}

apiKeyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiKeyError.textContent = '請貼上 API 金鑰。';
    return;
  }
  apiKeySave.disabled = true;
  apiKeySave.textContent = '驗證中…';
  apiKeyError.textContent = '';
  try {
    const result = await bridge.mixrouteSetKey(key);
    if (!result?.ok) {
      apiKeyError.textContent = result?.error || '金鑰驗證失敗。';
      return;
    }
    if (!readPreference('screenSpirit.mixrouteModel', '')) writePreference('screenSpirit.mixrouteModel', result.defaultModel || '');
    apiKeyInput.value = '';
    apiKeyDialog.close();
  } catch (error) {
    apiKeyError.textContent = error.message;
  } finally {
    apiKeySave.disabled = false;
    apiKeySave.textContent = '驗證並儲存';
  }
});
document.querySelector('#api-key-cancel').addEventListener('click', () => apiKeyDialog.close());
apiKeyClear.addEventListener('click', async () => {
  try { await bridge.mixrouteClearKey(); } catch {}
  apiKeyDialog.close();
});
selectionApiKeyButton.addEventListener('click', () => openApiKeyDialog());
document.querySelector('#api-key-clear-blocked').addEventListener('click', async () => {
  try { await bridge.mixrouteClearBlocked(); } catch {}
  apiKeyBlocked.hidden = true;
});
selectionModel.addEventListener('change', () => {
  writePreference(modelPrefKey(), selectionModel.value);
  render();
});

function isExternalTarget() {
  return selectionTarget.value && selectionTarget.value !== BUILTIN_TARGET;
}

function currentTarget() {
  return (state?.deliveryTargets || []).find((target) => target.id === selectionTarget.value);
}

// 已經送出過、還在進行中的對話：鎖定在同一個 AI，追問才會進到同一段對話
function lockedTargetId() {
  const delivery = state?.conversation?.delivery;
  return delivery?.live && state.messages.length ? delivery.targetId : '';
}

function renderTargetOptions() {
  const targets = state?.deliveryTargets || [];
  const builtin = state?.integrations?.builtin || { available: true, reason: '' };
  const wanted = selectionTarget.value || readPreference(DEFAULT_TARGET_KEY, targets[0]?.id || BUILTIN_TARGET);
  const defaultId = defaultTargetId();
  const signature = JSON.stringify([targets, builtin, defaultId]);
  if (selectionTarget.dataset.signature !== signature) {
    const option = (label, value, available, reason) => {
      const shown = available && value === defaultId ? L(`${label}・預設`, `${label} · default`) : label;
      const element = new Option(available ? shown : `${label}（${reason}）`, value);
      element.disabled = !available;
      return element;
    };
    selectionTarget.replaceChildren(
      ...targets.map(({ id, label, available = true, reason }) => option(label, id, available, reason)),
      option('小精靈內建（ChatGPT 方案）', BUILTIN_TARGET, builtin.available, builtin.reason),
    );
    selectionTarget.dataset.signature = signature;
  }
  const locked = lockedTargetId();
  const usable = (value) => [...selectionTarget.options].some((item) => item.value === value && !item.disabled);
  const firstUsable = [...selectionTarget.options].find((item) => !item.disabled)?.value || '';
  selectionTarget.value = locked || (usable(wanted) ? wanted : firstUsable);
  selectionTarget.disabled = Boolean(locked) || Boolean(state?.busy);
}

function describeContext(item) {
  const title = item.title ? ` — ${item.title}` : '';
  const share = Number.isFinite(item.share) ? ` · ${Math.round(item.share * 100)}%` : '';
  return `${item.app}${title}${share}`;
}

function renderContext() {
  selectionContext.replaceChildren(...selectedContext.map((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'context-chip';
    const label = document.createElement('span');
    label.dataset.i18nSkip = ''; // 視窗標題不翻譯
    label.textContent = describeContext(item);
    label.title = describeContext(item);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', L(`不要附帶 ${item.app}`, `Don't include ${item.app}`));
    remove.addEventListener('click', () => {
      selectedContext = selectedContext.filter((_, i) => i !== index);
      renderContext();
      fitQuestionTranscript();
    });
    chip.append(label, remove);
    return chip;
  }));
  selectionContext.hidden = !selectedContext.length;
}

function canSendSelectionQuestion() {
  if (!state || state.busy || state.delivering || !selectionQuestionInput.value.trim()) return false;
  return isExternalTarget() || Boolean(state.session.sharing);
}

function appendMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
  if (message.generated) article.classList.add('generated');

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = message.role === 'user' ? '你' : tr(message.label || 'ChatGPT');
  article.append(label);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (message.imageDataUrl) {
    const image = document.createElement('img');
    image.src = message.imageDataUrl;
    image.alt = message.generated ? '精靈畫的圖' : '附加圖片';
    bubble.append(image);
  }
  if (message.sourceText) {
    const source = document.createElement('div');
    source.className = 'source-text-message';
    const label = document.createElement('strong');
    label.textContent = '反白／複製的文字';
    const content = document.createElement('div');
    content.dataset.i18nSkip = ''; // 使用者的內容不翻譯
    content.textContent = message.sourceText;
    source.append(label, content);
    bubble.append(source);
  }
  if (message.text) {
    const text = document.createElement('span');
    text.dataset.i18nSkip = ''; // 問答內容不翻譯
    text.textContent = message.text;
    bubble.append(text);
  }
  if (!message.text && message.status === 'streaming') bubble.textContent = '正在整理回答…';
  article.append(bubble);

  // 精靈畫出來的圖：可以存檔、設成精靈卡面，也可以看當時的提示詞
  if (message.generated && message.imageDataUrl) article.append(generatedImageActions(message));
  if (message.note) {
    const note = document.createElement('div');
    note.className = 'message-status message-note';
    note.textContent = message.note;
    article.append(note);
  }
  if (message.status === 'failed') {
    const status = document.createElement('div');
    status.className = 'message-status';
    status.textContent = '回答未完成；已保留收到的部分。';
    article.append(status);
  } else if (message.status === 'cancelled') {
    const status = document.createElement('div');
    status.className = 'message-status';
    status.textContent = '已停止；已保留收到的部分。';
    article.append(status);
  }
  return article;
}

/** 把圖片裁成 3:4、縮到 480×640（精靈卡面的尺寸） */
async function toCardImage(dataUrl) {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 640;
  const scale = Math.max(480 / image.width, 640 / image.height);
  canvas.getContext('2d').drawImage(image, (480 - image.width * scale) / 2, (640 - image.height * scale) / 2, image.width * scale, image.height * scale);
  return canvas.toDataURL('image/jpeg', 0.86);
}

function generatedImageActions(message) {
  const bar = document.createElement('div');
  bar.className = 'generated-actions';
  const status = document.createElement('small');
  const button = (label, onClick) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', async () => {
      element.disabled = true;
      try { status.textContent = await onClick(); } catch (error) { status.textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      element.disabled = false;
    });
    return element;
  };
  const spiritId = state?.conversation?.spiritId;
  const spirit = spiritList.find((item) => item.id === spiritId);
  bar.append(button('💾 存成檔案', async () => {
    const result = await bridge.saveImage({ dataUrl: message.imageDataUrl, name: L(`${spirit?.name || '小精靈'}的圖`, `${spirit?.name || 'Screen Spirit'} image`) });
    return result?.ok ? L(`已存到 ${result.path.split(/[\\/]/).slice(-2).join('/')}`, `Saved to ${result.path.split(/[\\/]/).slice(-2).join('/')}`) : '';
  }));
  if (spirit) {
    bar.append(button('🃏 設為精靈卡面', async () => {
      const image = await toCardImage(message.imageDataUrl);
      const saved = await bridge.spiritsSave({ ...spirit, look: { ...spirit.look, image } });
      spiritList = spiritList.map((item) => (item.id === saved.id ? saved : item));
      return L(`已設為「${spirit.name}」的卡面 ✓`, `Set as "${spirit.name}"'s card image ✓`);
    }));
  }
  if (message.prompt) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '生圖提示詞';
    const pre = document.createElement('pre');
    pre.textContent = message.prompt;
    details.append(summary, pre);
    bar.append(details);
  }
  bar.append(status);
  return bar;
}

function renderMessages() {
  transcript.replaceChildren();
  if (!state.messages.length) {
    transcript.append(emptyState);
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    for (const message of state.messages) transcript.append(appendMessage(message));
    transcript.scrollTop = transcript.scrollHeight;
  }
  selectionQuestionTranscript.replaceChildren();
  for (const message of state.messages) selectionQuestionTranscript.append(appendMessage(message));
  fitQuestionTranscript();
}

function fitQuestionTranscript() {
  if (transcriptFitQueued) return;
  transcriptFitQueued = true;
  requestAnimationFrame(() => {
    transcriptFitQueued = false;
    if (!selectionQuestionDialog.open || !selectionQuestionTranscript.clientHeight) return;
    // 送到外部 AI 的對話：回覆可能很長，固定字級、改成可捲動並停在最新內容
    if (state?.conversation?.delivery) {
      selectionQuestionImage.style.maxHeight = state.messages.length ? '40px' : '88px';
      selectionQuestionTranscript.style.setProperty('--dialog-font-size', '12px');
      selectionQuestionTranscript.classList.add('scrollable');
      selectionQuestionTranscript.scrollTop = selectionQuestionTranscript.scrollHeight;
      return;
    }
    selectionQuestionTranscript.classList.remove('scrollable');

    for (const imageHeight of [88, 64, 40, 24]) {
      selectionQuestionImage.style.maxHeight = `${imageHeight}px`;
      let low = 5;
      let high = 12;
      let best = low;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const size = (low + high) / 2;
        selectionQuestionTranscript.style.setProperty('--dialog-font-size', `${size}px`);
        if (selectionQuestionTranscript.scrollHeight <= selectionQuestionTranscript.clientHeight + 1) {
          best = size;
          low = size;
        } else {
          high = size;
        }
      }
      selectionQuestionTranscript.style.setProperty('--dialog-font-size', `${best}px`);
      if (selectionQuestionTranscript.scrollHeight <= selectionQuestionTranscript.clientHeight + 1) break;
    }
  });
}

new ResizeObserver(fitQuestionTranscript).observe(selectionQuestionTranscript);

function renderModelSelect() {
  const current = state.model;
  modelSelect.replaceChildren();
  if (!state.models.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '尚無可用模型';
    modelSelect.append(option);
    modelSelect.disabled = true;
    return;
  }
  for (const model of state.models) {
    const option = document.createElement('option');
    option.value = model.slug;
    option.textContent = model.displayName || model.slug;
    option.selected = model.slug === current;
    modelSelect.append(option);
  }
  modelSelect.disabled = state.busy;
}

function render() {
  if (!state) return;
  presentationModeSelect.value = state.presentationMode || 'companion';
  document.body.dataset.presentationMode = state.conversation?.presentationMode || 'companion';
  const permissionLabels = {
    granted: '螢幕錄製已授權',
    denied: '螢幕錄製未授權',
    restricted: '螢幕錄製受系統限制',
    'not-determined': '首次圈選時詢問螢幕錄製權限',
    unknown: '螢幕錄製權限狀態未知',
  };
  const on = (flag) => (flag ? L('已註冊', 'on') : L('未註冊', 'off'));
  const hotkeyStatus = L(`圈選 ⌘⇧1 ${on(state.selectionHotkeyRegistered)} · 反白文字 ⌘⇧2 ${on(state.clipboardHotkeyRegistered)}`, `Select ⌘⇧1 ${on(state.selectionHotkeyRegistered)} · Text ⌘⇧2 ${on(state.clipboardHotkeyRegistered)}`);
  selectionStatus.textContent = `${hotkeyStatus} · ${tr(permissionLabels[state.screenPermissionStatus] || permissionLabels.unknown)}${L('（開發原型在系統清單可能顯示為 Electron）', ' (in development mode it may be listed as Electron)')}`;
  const connected = state.session.status === 'connected';
  const ready = connected && state.session.sharing;
  statusDot.className = `status-dot ${ready ? 'connected' : state.session.status === 'connecting' ? 'pending' : ''}`;
  if (ready) {
    statusLabel.textContent = state.session.identity?.email
      ? L(`已連接 ${state.session.identity.email} · 方案用量已授權`, `Connected as ${state.session.identity.email} · plan usage authorized`)
      : '已連接 · 方案用量已授權';
    connectButton.hidden = true;
  } else if (connected) {
    statusLabel.textContent = '已登入，但尚未授權方案用量';
    connectButton.textContent = '授權方案用量';
    connectButton.hidden = false;
  } else if (state.session.status === 'connecting') {
    statusLabel.textContent = '等待瀏覽器完成授權…';
    connectButton.textContent = '等待授權';
    connectButton.disabled = true;
    connectButton.hidden = false;
  } else {
    statusLabel.textContent = state.session.status === 'reauth_required' ? '需要重新連接' : '尚未連接';
    connectButton.textContent = state.session.status === 'reauth_required' ? '重新連接 ChatGPT' : '連接 ChatGPT';
    connectButton.disabled = false;
    connectButton.hidden = false;
  }
  if (state.session.status !== 'connecting') connectButton.disabled = false;

  renderModelSelect();
  question.disabled = !ready || state.busy;
  selectionQuestionInput.disabled = state.busy;
  renderTargetOptions();
  renderSpiritOptions();
  applySpiritTarget();
  const external = isExternalTarget();
  const target = currentTarget();
  // 會讀回覆的模式一定要送出；只有「只投遞」的 App 才能選擇不自動送出
  selectionDock.parentElement.hidden = !external || target?.kind !== 'app' || Boolean(target?.noDock) || Boolean(lockedTargetId());
  selectionProject.parentElement.hidden = !external || !target?.projectBased;
  if (target?.projectBased) renderProjectOptions(target);
  selectionProject.disabled = Boolean(state.busy);
  const usingModels = MODEL_KINDS.has(target?.kind);
  selectionModel.parentElement.hidden = !usingModels;
  selectionApiKeyButton.hidden = target?.kind !== 'api';
  if (usingModels) { renderModelOptions(target); applySpiritModel(target); }
  selectionModel.disabled = Boolean(state.busy);
  // 讀回覆與並排模式一定送出；只有「只投遞」的 App 才能選擇不自動送出
  selectionAutoSubmit.parentElement.hidden = !external || target?.kind !== 'app' || targetReadsBack(target) || isDocking(target) || Boolean(target?.manualSubmit);
  selectionQuestionSendButton.disabled = !canSendSelectionQuestion();
  // 只貼上不送出的目標（Kiro）：按鈕寫清楚是「貼到」
  selectionQuestionSendButton.textContent = external && target?.manualSubmit ? L(`貼到 ${target.label.replace(/\s*[（(].*[）)]/, '')}`, `Paste into ${target.label.replace(/\s*[（(].*[）)]/, '')}`) : L('送出', 'Send');
  selectionQuestionConnectButton.hidden = ready || external;
  selectionQuestionConnectButton.disabled = state.session.status === 'connecting' || state.busy;
  selectionQuestionConnectButton.textContent = state.session.status === 'connecting'
    ? '等待瀏覽器授權…'
    : state.session.status === 'reauth_required'
      ? '重新連接 ChatGPT'
      : connected ? '授權方案用量' : '連接 ChatGPT';
  selectionQuestionHint.dataset.error = String(Boolean(state.error));
  const targetLabel = (selectionTarget.selectedOptions[0]?.textContent || '').replace(/(・預設| · default)$/, '');
  const following = Boolean(lockedTargetId());
  let deliveryHint;
  if (state.busy && targetReadsBack(target)) {
    deliveryHint = L(`正在等 ${targetLabel} 回覆…（按 Esc 可停止並收起對話）`, `Waiting for ${targetLabel} to reply… (press Esc to stop and close)`);
  } else if (state.delivering) {
    deliveryHint = L(`正在送到 ${targetLabel}…請先不要操作滑鼠與鍵盤。`, `Sending to ${targetLabel}… please don't use the mouse or keyboard for a moment.`);
  } else if (following) {
    const followModel = state.conversation?.delivery?.model || selectionModel.value;
    const followName = target?.kind === 'api' ? `MixRoute（${followModel}）` : target?.kind === 'ollama' ? `Ollama（${followModel}）` : targetLabel.replace(/\s*[（(].*[）)]/, '');
    deliveryHint = ['cli', 'api', 'ollama'].includes(target?.kind)
      ? L(`追問會接續同一段 ${followName} 對話。`, `Follow-ups continue the same ${followName} conversation.`)
      : L(`追問會送進 ${targetLabel} 目前開著的那段對話（請不要在 Claude 裡切換到別的對話）。`, `Follow-ups go to the conversation currently open in ${targetLabel} (don't switch to another conversation there).`);
  } else if (target?.projectBased) {
    const project = selectedProject(target);
    const app = targetLabel.replace(/\s*[（(].*[）)]/, '');
    deliveryHint = L(`會打開 ${app}${project ? ` 的「${project.split(/[\\/]/).pop()}」專案` : '（不切換專案）'}，把${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題貼到對話框。${target.manualSubmit ? `不會自動送出，請在 ${app} 裡確認後自己按送出。` : ''}`,
      `Opens ${app}${project ? ` in the "${project.split(/[\\/]/).pop()}" project` : ' (without switching project)'} and pastes ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question into the chat box.${target.manualSubmit ? ` It won't send automatically — check it in ${app} and press send yourself.` : ''}`);
  } else if (isDocking(target)) {
    deliveryHint = L(`會開啟 ${targetLabel}的新對話，貼上${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題並送出，再把 ${target.label.replace(/\s*[（(].*[）)]/, '')} ${state.layoutMode === 'split'
      ? '放在右側 1/3、原本的程式放左側 2/3 並排'
      : '放在右側 1/3（抽屜：點其他程式時自動收進右邊，點右邊緣把手或按 ⌘⇧9 再拉出來）'}，直接在裡面看回覆、繼續對話。`,
      `Opens a new chat in ${targetLabel}, pastes ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question, sends it, then puts ${target.label.replace(/\s*[（(].*[）)]/, '')} ${state.layoutMode === 'split'
      ? 'on the right third with your original app on the left two-thirds'
      : 'on the right third (drawer: it slides away when you click another app; click the handle on the right edge or press ⌘⇧9 to bring it back)'} so you can read the reply and keep chatting there.`);
  } else if (target?.kind === 'api') {
    deliveryHint = !state.mixroute?.hasKey
      ? '請先按「金鑰」輸入 MixRoute API 金鑰。'
      : L(`會用 MixRoute 的 ${selectionModel.value || '（請選模型）'} 回答，附上${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題，回覆顯示在這裡。`,
        `MixRoute's ${selectionModel.value || '(choose a model)'} will answer, with ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question attached. The reply shows here.`);
  } else if (target?.kind === 'ollama') {
    deliveryHint = !state.ollama?.running
      ? 'Ollama 沒有在執行：請先打開 Ollama App。'
      : L(`會用這台 Mac 上的 ${selectionModel.value || '（請選模型）'} 回答（不用網路），附上${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題，回覆顯示在這裡。`,
        `${selectionModel.value || '(choose a model)'} on this computer will answer (no internet needed), with ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question attached. The reply shows here.`);
  } else if (target?.kind === 'cli') {
    deliveryHint = L(`會在背景用 ${targetLabel.replace(/\s*[（(].*[）)]/, '')} 回答，附上${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題，回覆顯示在這裡。`,
      `${targetLabel.replace(/\s*[（(].*[）)]/, '')} will answer in the background, with ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question attached. The reply shows here.`);
  } else {
    deliveryHint = L(`會開啟 ${targetLabel}的新對話，貼上${imagePart(target)}${selectedContext.length ? '畫面脈絡、' : ''}問題${targetReadsBack(target) || selectionAutoSubmit.checked ? '並送出' : '（不自動送出）'}${targetReadsBack(target) ? '，回覆會帶回這裡' : ''}。`,
      `Opens a new chat in ${targetLabel} and pastes ${imagePart(target)}${selectedContext.length ? 'the screen context, ' : ''}and your question${targetReadsBack(target) || selectionAutoSubmit.checked ? ', then sends it' : ' (without sending)'}${targetReadsBack(target) ? '. The reply comes back here' : ''}.`);
  }
  const vision = visionHint(target);
  selectionQuestionHint.dataset.warn = String(Boolean(vision) && imageSupportOf(target) === 'no' && !state.error);
  if (vision && !following) deliveryHint = `${vision} ${deliveryHint}`;
  const spiritLine = spiritHint();
  if (spiritLine) deliveryHint = `${spiritLine} ${deliveryHint}`;
  selectionQuestionHint.textContent = state.error || (external ? (sourceWarning ? `${sourceWarning} ${deliveryHint}` : deliveryHint) : null) || sourceWarning || (ready
    ? '圈選圖片會隨問題一起送出。'
    : state.session.status === 'connecting'
      ? '請在瀏覽器中完成登入與授權。'
      : '請先連接 ChatGPT，連接完成後即可送出。');
  imageFile.disabled = !ready || state.busy;
  sendButton.disabled = !ready || state.busy || !question.value.trim();
  selectScreenButton.disabled = state.busy;
  cancelButton.hidden = !state.busy;
  usageButton.disabled = !ready;
  clearButton.disabled = state.busy || !state.messages.length;
  disconnectButton.hidden = !connected;
  composerHint.textContent = state.busy
    ? '回答正在串流；文字與圖片由 OpenAI 處理'
    : ready ? '方案用量依帳號授權與限制' : '連接帳號後即可開始';
  if (!state.error) dismissedError = '';
  errorBanner.hidden = !state.error || state.error === dismissedError;
  errorText.textContent = state.error || '';
  builtinErrorRow.hidden = !state.builtinError;
  builtinErrorText.textContent = state.builtinError || '';
  renderLoginBar();
  renderMessages();
  renderHome();
  syncSpiritPreview();
}

// 對話框裡選的精靈 → 桌面小精靈換成牠的造型（對話框關掉、或選「不使用精靈」就換回來）
let previewedSpiritId;
function syncSpiritPreview() {
  const spiritId = selectionQuestionDialog.open && !selectionSpirit.parentElement.hidden ? selectionSpirit.value : '';
  if (spiritId === previewedSpiritId) return;
  previewedSpiritId = spiritId;
  void bridge.previewSpirit?.(spiritId)?.catch?.(() => {});
}
selectionQuestionDialog.addEventListener('close', () => syncSpiritPreview());

// ── 第一次使用設定（一步一步）／管理 AI 連線 ──
// 第一次（還沒決定過）：歡迎 → 系統權限（只有 macOS）→ 連接 AI → 完成
// 之後從「管理 AI 連線」打開：只顯示「連接 AI」這一頁
const SETUP_STEP_KEY = 'screenSpirit.setupStep'; // 螢幕錄製要重開小精靈；重開後從這一步接著做
const setupSteps = document.querySelector('#setup-steps');
const setupBack = document.querySelector('#setup-back');
const setupNext = document.querySelector('#setup-next');
const setupSave = document.querySelector('#integrations-save');
const setupCancel = document.querySelector('#integrations-cancel');
const setupRedetect = document.querySelector('#integrations-redetect');
const SETUP_TITLES = { language: 'Language／語言', welcome: '歡迎使用', permissions: '開啟系統權限', ai: '連接 AI', done: '完成' };
const SETUP_HEADINGS = { language: 'Language／語言', welcome: '第一次使用設定', permissions: '開啟系統權限', ai: '要連接哪些 AI？', done: '完成設定' };
let setupLanguage = ''; // 語言頁選的語言（按「下一步」才套用）
let setupMode = 'manage'; // 'wizard' | 'manage'
let setupPage = 'ai';
let permissionInfo = null;

const isMac = () => (state?.integrations?.platform || 'darwin') === 'darwin';
const setupPages = () => (setupMode === 'wizard' ? (isMac() ? ['language', 'welcome', 'permissions', 'ai', 'done'] : ['language', 'welcome', 'ai', 'done']) : ['ai']);
const platformName = () => ({ darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[state?.integrations?.platform] || L('這台電腦', 'computer'));

function openIntegrations() {
  const items = state?.integrations?.items || [];
  // 第一次（還沒決定過）：偵測到的預設勾選；之後打開：沿用目前的設定
  integrationsDraft = Object.fromEntries(items.map((item) => [item.id, state.integrations.decided && !item.isNew ? item.enabled : item.installed && !item.unsupported]));
  integrationsDefault = defaultTargetId();
  setupMode = state?.integrations?.decided ? 'manage' : 'wizard';
  const resume = readPreference(SETUP_STEP_KEY, '');
  setupPage = setupMode === 'wizard' ? (setupPages().includes(resume) ? resume : 'language') : 'ai';
  setupLanguage = getLanguage();
  showSetupPage();
  if (!integrationsDialog.open) integrationsDialog.showModal();
}

function showSetupPage() {
  const pages = setupPages();
  if (!pages.includes(setupPage)) setupPage = pages[0];
  const index = pages.indexOf(setupPage);
  const wizard = setupMode === 'wizard';
  for (const page of integrationsDialog.querySelectorAll('.setup-page')) page.hidden = page.dataset.page !== setupPage;
  document.querySelector('#setup-eyebrow').textContent = wizard ? L(`SCREEN SPIRIT・第一次使用設定 ${index + 1}/${pages.length}`, `SCREEN SPIRIT · FIRST-RUN SETUP ${index + 1}/${pages.length}`) : 'SCREEN SPIRIT';
  document.querySelector('#integrations-title').textContent = SETUP_HEADINGS[setupPage];
  setupSteps.hidden = !wizard;
  setupSteps.replaceChildren(...pages.map((page, i) => {
    const step = document.createElement('li');
    step.textContent = SETUP_TITLES[page];
    step.dataset.state = i < index ? 'done' : i === index ? 'current' : 'todo';
    return step;
  }));
  setupRedetect.hidden = setupPage !== 'ai';
  setupBack.hidden = !wizard || index === 0;
  setupNext.hidden = !wizard || setupPage === 'done';
  setupSave.hidden = wizard && setupPage !== 'done';
  setupSave.textContent = wizard ? '開始使用' : '連接勾選的項目';
  setupCancel.textContent = wizard ? '稍後再設定' : '取消';
  if (setupPage === 'language') renderSetupLanguages();
  if (setupPage === 'welcome') renderSetupWelcome();
  if (setupPage === 'permissions') void refreshPermissions();
  if (setupPage === 'ai') renderIntegrations();
  if (setupPage === 'done') renderSetupSummary();
  if (wizard) writePreference(SETUP_STEP_KEY, setupPage);
  requestAnimationFrame(() => (setupNext.hidden ? setupSave : setupNext).focus()); // 預設按鈕是「下一步／開始使用」
}

function goSetup(delta) {
  const pages = setupPages();
  setupPage = pages[Math.min(pages.length - 1, Math.max(0, pages.indexOf(setupPage) + delta))];
  showSetupPage();
}
setupBack.addEventListener('click', () => goSetup(-1));
setupNext.addEventListener('click', () => void setupForward());
async function setupForward() {
  if (setupPage === 'language') {
    const changed = setupLanguage !== getLanguage();
    if (changed || !state?.language?.decided) await bridge.languageSet(setupLanguage);
    if (changed) { writePreference(SETUP_STEP_KEY, 'welcome'); location.reload(); return; } // 換語言：重新載入畫面，從下一步接著設定
  }
  goSetup(1);
}

function renderSetupLanguages() {
  const suggested = state?.language?.suggested || 'en';
  document.querySelector('#setup-languages').replaceChildren(...LANGUAGES.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'setup-language';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(setupLanguage === item.id));
    const name = document.createElement('strong');
    name.textContent = item.label;
    const note = document.createElement('small');
    note.textContent = item.id === suggested ? (item.id === 'en' ? 'Recommended for your region' : '依你的地區建議') : '';
    button.append(name, note);
    button.addEventListener('click', () => { setupLanguage = item.id; renderSetupLanguages(); });
    return button;
  }));
}

function renderSetupWelcome() {
  const card = document.querySelector('#setup-platform');
  const title = document.createElement('strong');
  const body = document.createElement('p');
  if (isMac()) {
    title.textContent = L(`這台是 ${platformName()}：所有功能都可以使用`, `This is a ${platformName()}: every feature is available`);
    body.textContent = '圈選螢幕、精靈博士、工作流，以及操作 Claude／ChatGPT 桌面版、Chrome 網頁、指令列 AI、雲端 API、本機模型都支援。';
  } else {
    title.textContent = L(`這台是 ${platformName()}：部分功能目前只支援 macOS`, `This is a ${platformName()} PC: some features are macOS-only for now`);
    body.textContent = '可以使用：背景執行（Claude Code、Codex、Gemini CLI）、雲端 API（MixRoute）、本機模型（Ollama），以及精靈博士與工作流。操作桌面 App 與 Chrome 網頁的連線目前只支援 macOS，清單裡會反灰並註明。';
  }
  card.replaceChildren(title, body);
  const plan = isMac()
    ? ['開啟兩個系統權限（輔助使用、螢幕錄製）', '選擇要連接的 AI；沒安裝的可以直接點連結下載', '選一個「預設 AI」——精靈、工作流沒有特別指定時都用它']
    : ['選擇要連接的 AI；沒安裝的可以直接點連結下載', '選一個「預設 AI」——精靈、工作流沒有特別指定時都用它'];
  document.querySelector('#setup-plan').replaceChildren(...plan.map((text, i) => {
    const item = document.createElement('li');
    item.textContent = `${i + 1}. ${tr(text)}`;
    return item;
  }));
}

const PERMISSION_ROWS = [
  { kind: 'accessibility', label: '輔助使用', why: '把問題貼進 Claude／ChatGPT 桌面版、Chrome，並讀回答案。' },
  { kind: 'screen', label: '螢幕錄製', why: '圈選螢幕畫面、截圖給 AI 看。開啟後要重新開啟小精靈才會生效。' },
];
async function refreshPermissions() {
  try { permissionInfo = await bridge.permissionsStatus(); } catch { permissionInfo = null; }
  renderPermissions();
}
function renderPermissions() {
  if (setupPage !== 'permissions') return;
  const box = document.querySelector('#setup-permissions');
  box.replaceChildren(...PERMISSION_ROWS.map((row) => {
    const granted = permissionInfo?.[row.kind] === 'granted';
    const item = document.createElement('div');
    item.className = 'setup-permission';
    item.dataset.granted = String(granted);
    const text = document.createElement('span');
    text.className = 'integration-text';
    const name = document.createElement('strong');
    name.textContent = row.label;
    const status = document.createElement('span');
    status.className = 'integration-status';
    status.textContent = granted ? '✓ 已開啟' : '尚未開啟';
    const note = document.createElement('small');
    note.textContent = row.why;
    text.append(name, status, note);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'integration-login';
    open.textContent = granted ? '再看一次' : '打開設定';
    open.addEventListener('click', async () => {
      try { permissionInfo = await bridge.permissionsOpen(row.kind); } catch {}
      renderPermissions();
    });
    item.append(text, open);
    return item;
  }));
  const hint = document.querySelector('#setup-permissions-hint');
  const relaunch = document.createElement('button');
  relaunch.type = 'button';
  relaunch.className = 'integration-login';
  relaunch.textContent = '重新開啟小精靈';
  relaunch.addEventListener('click', () => { writePreference(SETUP_STEP_KEY, 'permissions'); void bridge.appRelaunch(); });
  const recheck = document.createElement('button');
  recheck.type = 'button';
  recheck.className = 'integration-login';
  recheck.textContent = '重新檢查';
  recheck.addEventListener('click', () => void refreshPermissions());
  hint.replaceChildren(
    document.createTextNode('開好之後回到這裡按「重新檢查」。如果開關已經打開卻還顯示「尚未開啟」，請按「重新開啟小精靈」（會從這一步接著設定）。也可以先按「下一步」，之後再開。 '),
    recheck, document.createTextNode(' '), relaunch,
  );
}
// 使用者從系統設定切回來時自動重新檢查
window.addEventListener('focus', () => { if (integrationsDialog.open && setupPage === 'permissions') void refreshPermissions(); });

function renderSetupSummary() {
  const info = state?.integrations || { items: [] };
  const checked = info.items.filter((item) => item.installed && !item.unsupported && integrationsDraft?.[item.id] === true);
  const fallback = checked[0]?.id || '';
  const chosen = checked.some((item) => item.id === integrationsDefault) ? integrationsDefault : fallback;
  const label = (id) => info.items.find((item) => item.id === id)?.label || id;
  const rows = [
    ['預設 AI', chosen ? label(chosen) : '還沒有選（回上一步勾選至少一個 AI）'],
    ['已連接', checked.length ? checked.map((item) => item.label).join(L('、', ', ')) : '無'],
    ['精靈資料庫', L(`${info.defaultKbRoot || '文件／Screen Spirit／精靈資料庫'}（每隻精靈一個資料夾；之後可以在精靈博士裡換到 Obsidian 或其他位置）`, `${info.defaultKbRoot || 'Documents/Screen Spirit/精靈資料庫'} (one folder per spirit; you can move it to Obsidian or elsewhere in the Spirit Lab later)`)],
    ['範例精靈', '精靈博士裡附了「造型博士」：AI 跟著你的預設，可以直接拿來試、也可以改成你自己的精靈。'],
  ];
  if (isMac()) rows.splice(2, 0, ['系統權限', PERMISSION_ROWS.map((row) => `${tr(row.label)}${permissionInfo?.[row.kind] === 'granted' ? ' ✓' : L('（尚未開啟）', ' (not on yet)')}`).join(L('、', ', '))]);
  document.querySelector('#setup-summary').replaceChildren(...rows.flatMap(([term, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    return [dt, dd];
  }));
}

function installButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'integration-login';
  button.textContent = item.install.label;
  button.title = '在瀏覽器打開下載／安裝頁；裝好後按右上角「重新偵測」';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void bridge.openInstallLink(item.id);
  });
  return button;
}

function renderIntegrations() {
  if (!integrationsDialog.open && integrationsDraft === undefined) return;
  const info = state?.integrations || { items: [] };
  const usableItem = (item) => item.installed && !item.unsupported;
  // 預設必須是有勾選的項目；沒有的話自動挑第一個勾選的
  const checked = info.items.filter((item) => usableItem(item) && integrationsDraft[item.id] === true).map((item) => item.id);
  if (!checked.includes(integrationsDefault)) integrationsDefault = checked[0] || '';
  document.querySelector('#integrations-intro').textContent = isMac()
    ? '小精靈偵測到這台電腦上有下列 AI。請勾選你同意連接的項目，並在右邊選一個「預設」——每次圈選後會先送到它，精靈和工作流沒有特別指定 AI 時也用它。沒安裝的可以按旁邊的按鈕下載，裝好後按「重新偵測」。'
    : L(`這台是 ${platformName()}：可以連接背景執行（指令列）、雲端 API 與本機模型；標示「目前只支援 macOS」的項目會反灰。請勾選要連接的項目，並選一個「預設」。沒安裝的可以按旁邊的按鈕下載，裝好後按「重新偵測」。`,
      `This is a ${platformName()} PC: you can connect background CLI agents, cloud APIs and local models; items marked "macOS only" are greyed out. Tick the ones to connect and pick a "Default". For anything not installed, use the button next to it to download it, then press "Detect again".`);
  const groups = new Map();
  for (const item of info.items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  integrationsList.replaceChildren(...[...groups.entries()].map(([group, items]) => {
    const section = document.createElement('section');
    section.className = 'integrations-group';
    const title = document.createElement('h3');
    title.textContent = group;
    section.append(title, ...items.map((item) => {
      if (integrationsDraft[item.id] === undefined) integrationsDraft[item.id] = state.integrations.decided && !item.isNew ? item.enabled : usableItem(item);
      const row = document.createElement('label');
      row.className = 'integration-row';
      row.dataset.installed = String(usableItem(item));
      row.dataset.unsupported = String(Boolean(item.unsupported));
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = usableItem(item) && integrationsDraft[item.id] === true;
      box.disabled = !usableItem(item);
      box.addEventListener('change', () => { integrationsDraft[item.id] = box.checked; renderIntegrations(); });
      const text = document.createElement('span');
      text.className = 'integration-text';
      const name = document.createElement('strong');
      name.textContent = item.isNew && usableItem(item) ? L(`${item.label}　新`, `${item.label} · new`) : item.label;
      const status = document.createElement('span');
      status.className = 'integration-status';
      status.textContent = item.unsupported ? '目前只支援 macOS' : (item.detail || (info.detecting ? '偵測中…' : ''));
      const note = document.createElement('small');
      note.textContent = item.note;
      text.append(name, status, note);
      // 右邊的「預設」：只有勾選的項目能選
      const usable = usableItem(item) && integrationsDraft[item.id] === true;
      const isDefault = usable && integrationsDefault === item.id;
      const pick = document.createElement('span');
      pick.className = 'integration-default';
      pick.dataset.on = String(isDefault);
      pick.dataset.disabled = String(!usable);
      pick.title = '每次圈選後先送到這個 AI；精靈、工作流沒指定時也用它';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'integration-default';
      radio.checked = isDefault;
      radio.disabled = !usable;
      radio.tabIndex = usable ? 0 : -1;
      radio.setAttribute('aria-label', L(`把 ${item.label} 設為預設`, `Make ${item.label} the default`));
      pick.append(radio, document.createTextNode('預設'));
      pick.addEventListener('click', (event) => {
        event.preventDefault(); // 不要連帶切換左邊的勾選
        event.stopPropagation();
        if (!usable) return;
        integrationsDefault = item.id;
        renderIntegrations();
      });
      row.append(box, text);
      if (!item.installed && !item.unsupported && item.install) row.append(installButton(item));
      if (item.id === 'mixroute' && usable && !state.mixroute?.hasKey) {
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'integration-login';
        key.textContent = '輸入金鑰';
        key.title = '金鑰只存在這台電腦（加密）';
        key.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openApiKeyDialog();
        });
        row.append(key);
      }
      if (usableItem(item) && CLI_NAMES[item.id] && (item.loggedIn === false || ['failed', 'timeout', 'waiting'].includes(state.cliLogin?.[item.id]?.status))) {
        const waiting = state.cliLogin?.[item.id]?.status === 'waiting';
        const login = document.createElement('button');
        login.type = 'button';
        login.className = 'integration-login';
        login.textContent = waiting ? '登入中…' : '登入';
        login.title = waiting ? '請在終端機和瀏覽器完成登入' : L(`打開終端機登入 ${CLI_NAMES[item.id]}`, `Open Terminal to sign in to ${CLI_NAMES[item.id]}`);
        login.addEventListener('click', (event) => {
          event.preventDefault(); // 不要連帶切換勾選
          event.stopPropagation();
          void startCliLogin(item.id);
        });
        row.append(login);
      }
      row.append(pick);
      return row;
    }));
    return section;
  }));
  setupRedetect.disabled = Boolean(info.detecting);
  setupRedetect.textContent = info.detecting ? '偵測中…' : '重新偵測';
}

integrationsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (setupMode === 'wizard' && setupPage !== 'done') { void setupForward(); return; } // 在中間頁按 Enter：只往下一步
  const items = state?.integrations?.items || [];
  const enabled = Object.fromEntries(Object.entries(integrationsDraft || {}).filter(([id]) => items.some((item) => item.id === id && item.installed && !item.unsupported)));
  const checked = Object.keys(enabled).filter((id) => enabled[id]);
  const chosen = checked.includes(integrationsDefault) ? integrationsDefault : (checked[0] || '');
  try { await bridge.integrationsSave({ enabled, defaultTarget: chosen }); } catch (error) { state.error = error.message; }
  setDefaultTarget(chosen);
  resetTargetToDefault();
  integrationsDraft = undefined;
  writePreference(SETUP_STEP_KEY, '');
  integrationsDialog.close();
  render();
});
setupCancel.addEventListener('click', () => {
  integrationsDraft = undefined;
  integrationsDialog.close();
});
setupRedetect.addEventListener('click', () => void bridge.integrationsDetect());
document.querySelector('#integrations-button').addEventListener('click', () => openIntegrations());
document.querySelector('#integrations-banner-button').addEventListener('click', () => openIntegrations());
bridge.onOpenIntegrations(() => openIntegrations());

// ── 精靈博士 ──
const spiritLab = createSpiritLab({
  bridge,
  getState: () => state,
  root: document.querySelector('#spirit-lab'),
  onClose: () => {
    delete document.body.dataset.view;
    document.querySelector('#spirit-lab-button').focus({ preventScroll: true });
    void loadSpirits(); // 精靈可能改過設定
  },
  onWork: (spiritId) => void openSpiritTask(spiritId),
  onSwitchWorkflow: () => openWorkflowView(),
});
// 工作流：和對話、精靈博士在同一個視窗裡直接切換
const workflowView = createWorkflowView({
  bridge,
  root: document.querySelector('#workflow'),
  onClose: () => {
    delete document.body.dataset.view;
    document.querySelector('#workflow-button').focus({ preventScroll: true });
  },
  onSwitchLab: () => openLabView(),
});
function openLabView() {
  document.body.dataset.view = 'lab';
  void spiritLab.open();
}
function openWorkflowView() {
  document.body.dataset.view = 'workflow';
  void workflowView.open();
}
document.querySelector('#spirit-lab-button').addEventListener('click', openLabView);
document.querySelector('#workflow-button').addEventListener('click', openWorkflowView);
document.querySelector('#error-dismiss').addEventListener('click', () => {
  dismissedError = state?.error || '';
  errorBanner.hidden = true;
});
document.querySelector('#builtin-retry').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '重試中…';
  try { await bridge.builtinRetry(); } catch {}
  button.disabled = false;
  button.textContent = '重試';
});

// ── 主視窗：預設送到、畫面安排、正在並排 ──
function renderHome() {
  if (!state) return;
  // 還沒設定過，或有新加入的 AI（例如 Google AI 模式）：顯示提醒
  const newItems = (state.integrations?.items || []).filter((item) => item.isNew && item.installed);
  integrationsBanner.hidden = !state.integrations || (Boolean(state.integrations.decided) && !newItems.length);
  integrationsBannerText.textContent = state.integrations?.decided && newItems.length
    ? L(`有新的 AI 可以連接：${newItems.map((item) => item.label.replace(/\s*[（(].*[）)]/, '')).join('、')}。`, `New AI available to connect: ${newItems.map((item) => item.label.replace(/\s*[（(].*[）)]/, '')).join(', ')}.`)
    : '還沒設定要連接哪些 AI，目前所有選項都不能用。';
  if (integrationsDialog.open && setupPage === 'ai') renderIntegrations();
  if (integrationsDialog.open && setupPage === 'done') renderSetupSummary();
  // 舊版只把「預設 AI」記在畫面這邊：同步一次給主程式（精靈「跟著預設」要用）
  if (state.integrations?.decided && !state.integrations.defaultTarget && !defaultTargetSynced) {
    defaultTargetSynced = true;
    const saved = readPreference(DEFAULT_TARGET_KEY, '');
    if (saved) void bridge.defaultTargetSet?.(saved);
  }
  // 「預設送到」和提問框的「送到」共用同一個偏好設定
  const signature = selectionTarget.dataset.signature || '';
  if (homeTarget.dataset.signature !== signature) {
    homeTarget.replaceChildren(...[...selectionTarget.options].map((option) => {
      const copy = new Option(option.textContent, option.value);
      copy.disabled = option.disabled;
      return copy;
    }));
    homeTarget.dataset.signature = signature;
  }
  const preferred = readPreference(DEFAULT_TARGET_KEY, selectionTarget.value);
  homeTarget.value = [...homeTarget.options].some((option) => option.value === preferred && !option.disabled) ? preferred : selectionTarget.value;
  const target = (state.deliveryTargets || []).find((item) => item.id === homeTarget.value);
  const kind = target?.kind || 'builtin';

  homeModelRow.hidden = !MODEL_KINDS.has(kind);
  document.querySelector('#home-api-key').hidden = kind !== 'api';
  if (MODEL_KINDS.has(kind)) {
    renderModelOptions(target);
    const modelSignature = selectionModel.dataset.signature || '';
    if (homeModel.dataset.signature !== modelSignature) {
      homeModel.replaceChildren(...[...selectionModel.cloneNode(true).children]);
      homeModel.dataset.signature = modelSignature;
    }
    homeModel.value = selectionModel.value;
  }

  homeLayoutRow.hidden = kind !== 'app' || Boolean(target?.noDock);
  const layout = !selectionDock.checked ? 'none' : state.layoutMode === 'split' ? 'split' : 'drawer';
  homeLayoutButtons.forEach((button) => button.setAttribute('aria-checked', String(button.dataset.layout === layout)));

  const hints = {
    app: {
      drawer: '送出後 AI 放在右側 1/3，滑鼠離開 1 秒自動收進右邊；上方工具列可以固定、收起或回到小精靈。',
      split: '送出後左 2/3 放原本的程式、右 1/3 放 AI，固定並排不自動收起。',
      none: '只把內容貼進 AI 並送出，不移動任何視窗。',
    }[layout],
    cli: L(`在背景用 ${(target?.label || '').replace(/\s*[（(].*[）)]/, '')} 回答，回覆顯示在小精靈對話框。`, `${(target?.label || '').replace(/\s*[（(].*[）)]/, '')} answers in the background; replies show in the Screen Spirit window.`),
    ollama: !state.ollama?.running
      ? 'Ollama 沒有在執行：請先打開 Ollama App。'
      : L(`用這台 Mac 上的 ${selectionModel.value || '（請選模型）'} 回答，不用網路、不花錢；回覆顯示在小精靈對話框。`, `${selectionModel.value || '(choose a model)'} on this computer answers — no internet, no cost; replies show in the Screen Spirit window.`),
    api: !state.mixroute?.hasKey
      ? '還沒設定 MixRoute 金鑰，按「金鑰」輸入。'
      : L(`用 MixRoute 的 ${selectionModel.value || '（請選模型）'} 回答，會扣 MixRoute 點數；回覆顯示在小精靈對話框。${
        state.mixroute?.imageSupport?.[selectionModel.value] === 'no' ? '⚠︎ 這個模型不能看圖片，圈選的畫面會改送 OCR 辨識出的文字。' : ''}`,
        `MixRoute's ${selectionModel.value || '(choose a model)'} answers and uses MixRoute credits; replies show in the Screen Spirit window.${
        state.mixroute?.imageSupport?.[selectionModel.value] === 'no' ? ' ⚠︎ This model can\'t read images; the selection will be sent as OCR text.' : ''}`),
    builtin: state.builtinError
      ? L(`內建 ChatGPT 目前連不上：${state.builtinError}（在下方「內建 ChatGPT 方案」可以重試）`, `Built-in ChatGPT can't connect right now: ${tr(state.builtinError)} (retry under "Built-in ChatGPT plan" below)`)
      : '用小精靈內建的 ChatGPT 方案回答；需要先在下方「內建 ChatGPT 方案」連線。',
  };
  homeTargetHint.textContent = target?.projectBased
    ? L(`送出時先選要在哪個專案裡問（最近的專案、其他資料夾或開新專案），小精靈會打開 ${target.label.replace(/\s*[（(].*[）)]/, '')} 和那個專案，把圖片與問題貼到對話框，不會自動送出。`,
      `When you send, first pick the project to ask in (a recent project, another folder or a new one). Screen Spirit opens ${target.label.replace(/\s*[（(].*[）)]/, '')} with that project and pastes the image and question into the chat box without sending.`)
    : hints[kind] || '';

  const drawerState = state.drawer || {};
  drawerCard.hidden = !drawerState.active;
  if (drawerState.active) {
    drawerApp.textContent = drawerState.appName;
    drawerStatePill.textContent = drawerState.hidden ? '已收起' : drawerState.pinned ? '已固定' : '展開中';
    drawerToggleButton.textContent = drawerState.hidden ? '打開抽屜 ⌘⇧9' : '收起 ⌘⇧9';
    drawerPinButton.textContent = drawerState.pinned ? '取消固定' : '固定（不自動收起）';
  }
}

homeTarget.addEventListener('change', () => {
  setDefaultTarget(homeTarget.value);
  if (!lockedTargetId()) selectionTarget.value = homeTarget.value;
  render();
  if (currentTarget()?.kind === 'api' && !state.mixroute?.hasKey) openApiKeyDialog();
});
homeModel.addEventListener('change', () => {
  writePreference(modelPrefKey(targetById(homeTarget.value)), homeModel.value);
  selectionModel.value = homeModel.value;
  render();
});
homeLayoutButtons.forEach((button) => button.addEventListener('click', async () => {
  const layout = button.dataset.layout;
  selectionDock.checked = layout !== 'none';
  writePreference('screenSpirit.dock', String(selectionDock.checked));
  if (layout !== 'none') {
    try { await bridge.setLayoutMode(layout); } catch {}
  }
  render();
}));
document.querySelector('#home-text-button').addEventListener('click', () => void bridge.beginClipboard());
document.querySelector('#home-spirit-button').addEventListener('click', () => void openSpiritTask());
document.querySelector('#home-api-key').addEventListener('click', () => openApiKeyDialog());
drawerToggleButton.addEventListener('click', () => void bridge.drawerAction('toggle'));
drawerPinButton.addEventListener('click', () => void bridge.drawerAction('pin'));
document.querySelector('#drawer-restore').addEventListener('click', () => void bridge.drawerAction('restore'));

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('無法讀取這張圖片。'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('圖片格式無法讀取。'));
    reader.readAsDataURL(file);
  });
}

// ── 附件：📎 選檔、拖曳進提問框、或在輸入框貼上圖片 ──
// 圖片（一次一張）會一起送給 AI 分析；文字檔的內容會附在問題後面。
const attachButton = document.querySelector('#selection-attach');
const attachInput = document.querySelector('#selection-attach-input');
const attachRow = document.querySelector('#selection-attachments');
let attachedFiles = []; // 使用者附的文字檔 { name, text }
let imageAttached = false; // 目前的圖片是使用者自己附的（不是圈選的畫面）
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|js|mjs|cjs|ts|tsx|jsx|py|rb|go|java|swift|sql|css|ini|toml|sh)$/i;
const MAX_TEXT_FILE = 300 * 1024;
const MAX_SOURCE_TEXT = 95_000;
const MAX_IMAGE_SIDE = 2560;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('decode'));
    image.src = dataUrl;
  });
}

/** 圖片：太大或格式不支援（GIF、BMP）就重新壓成 JPEG／PNG，最長邊 2560 */
async function prepareImage(file) {
  const dataUrl = await readAsDataUrl(file);
  let image;
  try { image = await loadImage(dataUrl); } catch {
    throw new Error(L(`無法讀取「${file.name}」。HEIC 等格式請先在「預覽程式」轉存成 JPEG 或 PNG。`, `Can't read "${file.name}". Convert HEIC and similar formats to JPEG or PNG first.`));
  }
  const supported = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
  if (supported && file.size <= 8 * 1024 * 1024 && Math.max(image.width, image.height) <= MAX_IMAGE_SIDE) return dataUrl;
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const keepPng = ['image/png', 'image/gif', 'image/bmp'].includes(file.type) && canvas.width * canvas.height <= 1600 * 1600; // 小圖保留透明背景
  if (keepPng) return canvas.toDataURL('image/png');
  // 轉 JPEG：透明的地方用白底
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const flatContext = flat.getContext('2d');
  flatContext.fillStyle = '#fff';
  flatContext.fillRect(0, 0, flat.width, flat.height);
  flatContext.drawImage(canvas, 0, 0);
  return flat.toDataURL('image/jpeg', 0.9);
}

let attachNote = '';
async function addAttachments(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const problems = [];
  attachNote = '';
  for (const file of files) {
    if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) {
      try {
        const dataUrl = await prepareImage(file);
        if (selectedImage && !imageAttached) attachNote = '一次只能附一張圖片，已用你附的圖片取代圈選的畫面。';
        else if (selectedImage && imageAttached) attachNote = '一次只能附一張圖片，已換成新的這張。';
        selectedImage = { name: file.name || '貼上的圖片', dataUrl };
        imageAttached = true;
        selectionQuestionImage.src = dataUrl;
        selectionQuestionImage.hidden = false;
      } catch (error) {
        problems.push(error.message);
      }
    } else if (TEXT_FILE.test(file.name) || file.type.startsWith('text/')) {
      if (file.size > MAX_TEXT_FILE) { problems.push(L(`「${file.name}」太大（文字檔上限 300 KB）。`, `"${file.name}" is too large (text files up to 300 KB).`)); continue; }
      const text = await file.text();
      attachedFiles = [...attachedFiles.filter((item) => item.name !== file.name), { name: file.name, text }];
    } else {
      problems.push(L(`「${file.name}」目前不支援。可以附圖片（PNG、JPEG、WebP、GIF）或文字檔（txt、md、csv、json…）；PDF、Word 請先複製裡面的文字貼上。`, `"${file.name}" isn't supported. Attach images (PNG, JPEG, WebP, GIF) or text files (txt, md, csv, json…); for PDF or Word, copy the text and paste it in.`));
    }
  }
  if (combinedSourceText().endsWith('（內容太長，後面省略）')) attachNote = `${attachNote}${L('附件的文字太多，超過的部分不會送出。', ' The attached text is too long; the extra part won\'t be sent.')}`.trim();
  state.error = problems.join(' ');
  renderAttachments();
  render();
  selectionQuestionInput.focus();
}

function renderAttachments() {
  const chip = (icon, label, detail, onRemove) => {
    const element = document.createElement('span');
    element.className = 'attach-chip';
    const text = document.createElement('span');
    text.textContent = `${icon} ${label}`;
    text.title = label;
    const meta = document.createElement('small');
    meta.textContent = detail;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', L(`移除 ${label}`, `Remove ${label}`));
    remove.addEventListener('click', () => { onRemove(); renderAttachments(); render(); });
    element.append(text, meta, remove);
    return element;
  };
  const chips = [];
  if (selectedImage && imageAttached) {
    chips.push(chip('🖼️', selectedImage.name, '圖片', () => {
      selectedImage = undefined;
      imageAttached = false;
      selectionQuestionImage.removeAttribute('src');
      selectionQuestionImage.hidden = true;
    }));
  }
  for (const file of attachedFiles) {
    chips.push(chip('📄', file.name, L(`${file.text.length.toLocaleString()} 字`, `${file.text.length.toLocaleString()} chars`), () => { attachedFiles = attachedFiles.filter((item) => item !== file); }));
  }
  if (attachNote) {
    const note = document.createElement('small');
    note.className = 'attach-note';
    note.textContent = attachNote;
    chips.push(note);
  }
  attachRow.replaceChildren(...chips);
  attachRow.hidden = !chips.length;
}

function clearAttachments() {
  attachedFiles = [];
  imageAttached = false;
  attachNote = '';
  renderAttachments();
}

/** 送出的文字附件：反白／複製的內容＋使用者附的文字檔 */
function combinedSourceText() {
  const parts = [selectedSourceText, ...attachedFiles.map((file) => `【附件：${file.name}】\n${file.text}`)].filter((part) => part && part.trim());
  const text = parts.join('\n\n');
  return text.length > MAX_SOURCE_TEXT ? `${text.slice(0, MAX_SOURCE_TEXT)}\n…（內容太長，後面省略）` : text;
}

attachButton.addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  const files = [...(attachInput.files || [])];
  attachInput.value = '';
  void addAttachments(files);
});
// 拖曳：只有拖到提問框才收；拖到視窗其他地方也不要讓 Electron 把檔案當網頁打開
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (hasFiles(event)) event.preventDefault(); });
selectionQuestionDialog.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  selectionQuestionDialog.dataset.dragging = 'true';
});
selectionQuestionDialog.addEventListener('dragleave', (event) => {
  if (event.target === selectionQuestionDialog || !selectionQuestionDialog.contains(event.relatedTarget)) delete selectionQuestionDialog.dataset.dragging;
});
selectionQuestionDialog.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  delete selectionQuestionDialog.dataset.dragging;
  void addAttachments(event.dataTransfer.files);
});
// 在輸入框貼上圖片（例如截圖後 ⌘V）；同時有文字的話文字照常貼上
selectionQuestionInput.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
  void addAttachments(files);
});

async function connectChatGPT() {
  if (state) state.error = '';
  connectButton.disabled = true;
  render();
  try {
    state = await bridge.signIn();
  } catch (error) {
    if (state) state.error = error.message;
  }
  render();
}

connectButton.addEventListener('click', () => void connectChatGPT());

modelSelect.addEventListener('change', async () => {
  try {
    state = await bridge.setModel(modelSelect.value);
  } catch (error) {
    state.error = error.message;
  }
  render();
});

selectScreenButton.addEventListener('click', async () => {
  selectScreenButton.disabled = true;
  try {
    const result = await bridge.beginSelection();
    if (!result?.ok) state.error = result?.error || '無法開始螢幕圈選。';
  } catch (error) {
    state.error = error.message;
  }
  render();
});

presentationModeSelect.addEventListener('change', async () => {
  presentationModeSelect.disabled = true;
  try {
    state = await bridge.setPresentationMode(presentationModeSelect.value);
  } catch (error) {
    state.error = error.message;
  } finally {
    presentationModeSelect.disabled = false;
  }
  render();
});

imageFile.addEventListener('change', async () => {
  const file = imageFile.files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 9 * 1024 * 1024) {
    state.error = '請選擇 9 MB 以下的 PNG、JPEG 或 WebP 圖片。';
    imageFile.value = '';
    render();
    return;
  }
  try {
    selectedImage = { name: file.name, dataUrl: await readAsDataUrl(file) };
    previewImage.src = selectedImage.dataUrl;
    previewName.textContent = selectedImage.name;
    imagePreview.hidden = false;
    state.error = '';
  } catch (error) {
    state.error = error.message;
  }
  render();
});

document.querySelector('#remove-image').addEventListener('click', () => {
  selectedImage = undefined;
  imageFile.value = '';
  imagePreview.hidden = true;
  previewImage.removeAttribute('src');
});

question.addEventListener('input', () => {
  sendButton.disabled = !state?.session.sharing || state.busy || !question.value.trim();
});

selectionQuestionInput.addEventListener('input', () => {
  selectionQuestionInput.style.height = 'auto';
  selectionQuestionInput.style.height = `${Math.min(108, Math.max(54, selectionQuestionInput.scrollHeight))}px`;
  selectionQuestionSendButton.disabled = !canSendSelectionQuestion();
  fitQuestionTranscript();
});

// Enter 直接送出、Shift+Enter 換行。
// 注意輸入法：注音／拼音選字時按的 Enter 是「確認選字」，isComposing 為 true（或 keyCode 229），這時不能送出。
function submitOnEnter(textarea, form) {
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  });
}
submitOnEnter(selectionQuestionInput, selectionQuestionForm);
submitOnEnter(question, composer);

selectionQuestionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!canSendSelectionQuestion()) return;
  const text = selectionQuestionInput.value.trim();
  const imageDataUrl = selectedImage?.dataUrl;
  if (isExternalTarget()) {
    if (currentTarget()?.kind === 'api' && !state.mixroute?.hasKey) {
      openApiKeyDialog();
      return;
    }
    void deliverQuestion(text, imageDataUrl);
    return;
  }
  selectionQuestionInput.value = '';
  void sendQuestion(text, imageDataUrl);
});

selectionTarget.addEventListener('change', () => {
  // 只換這一次的提問；預設 AI 在主視窗或「管理 AI 連線」裡改
  render();
  // 第一次選 MixRoute、還沒有金鑰：直接跳出輸入視窗
  if (currentTarget()?.kind === 'api' && !state.mixroute?.hasKey) openApiKeyDialog();
});
selectionDock.addEventListener('change', () => {
  writePreference('screenSpirit.dock', String(selectionDock.checked));
  render();
});
selectionAutoSubmit.addEventListener('change', () => {
  writePreference('screenSpirit.autoSubmit', String(selectionAutoSubmit.checked));
  render();
});

// ── 指令列 AI 沒登入：提問框下方的登入列 ──
function cliLoginStatus(targetId) {
  const login = state?.cliLogin?.[targetId];
  if (login?.status) return login.status;
  const item = (state?.integrations?.items || []).find((entry) => entry.id === targetId);
  return item?.loggedIn === false ? 'needed' : '';
}

function renderLoginBar() {
  const target = currentTarget();
  const id = target?.kind === 'cli' && CLI_NAMES[target.id] ? target.id : '';
  let status = id ? cliLoginStatus(id) : '';
  const login = state?.cliLogin?.[id];
  // 「已登入」的提示只顯示一下子
  if (status === 'done' && !pendingLoginRetry && Date.now() - (login?.at || 0) > 20_000) status = '';
  cliLoginBar.hidden = !status;
  if (!status) return;
  const name = CLI_NAMES[id];
  cliLoginBar.dataset.status = status;
  const texts = {
    needed: [L(`${name} 還沒登入（或登入已過期）。按右邊的按鈕，小精靈會打開終端機和瀏覽器登入頁。`, `${name} isn't signed in (or the sign-in expired). Press the button on the right and Screen Spirit will open Terminal and the browser sign-in page.`), L(`登入 ${name}`, `Sign in to ${name}`)],
    waiting: [L('已打開終端機：請在瀏覽器完成登入。完成後小精靈會自動接著用' + (pendingLoginRetry ? '，並重新送出剛才的問題。' : '。'), 'Terminal is open: finish signing in in the browser. Screen Spirit will continue automatically' + (pendingLoginRetry ? ' and resend your question.' : '.')), '重新打開'],
    done: [L(`${name} 已登入 ✓` + (pendingLoginRetry ? '，正在重新送出剛才的問題…' : ''), `${name} signed in ✓` + (pendingLoginRetry ? ' — resending your question…' : '')), ''],
    failed: ['登入沒有完成（終端機裡的登入被中斷或失敗）。', '再試一次'],
    timeout: ['等了 10 分鐘還沒完成登入，已停止等待。', '再試一次'],
  }[status] || ['', ''];
  cliLoginText.textContent = texts[0];
  cliLoginButton.textContent = texts[1];
  cliLoginButton.hidden = !texts[1];
  cliLoginButton.dataset.target = id;

  // 登入完成：自動重新送出剛才失敗的問題
  if (status === 'done' && pendingLoginRetry?.targetId === id && !state.busy) {
    const payload = pendingLoginRetry;
    pendingLoginRetry = undefined;
    setTimeout(() => { void submitDelivery(payload); }, 0);
  }
}

async function startCliLogin(targetId) {
  try {
    const result = await bridge.cliLogin(targetId);
    if (!result?.ok) state.error = result?.error || '無法開始登入。';
  } catch (error) {
    state.error = error.message;
  }
  render();
}
cliLoginButton.addEventListener('click', () => {
  if (cliLoginButton.dataset.target) void startCliLogin(cliLoginButton.dataset.target);
});

async function deliverQuestion(text, imageDataUrl) {
  const payload = {
    targetId: selectionTarget.value,
    question: text,
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(combinedSourceText() ? { sourceText: combinedSourceText() } : {}),
    ...(imageDataUrl && imageAttached ? { imageAttached: true } : {}),
    context: selectedContext,
    autoSubmit: selectionAutoSubmit.checked,
    dock: isDocking(),
    ...(MODEL_KINDS.has(currentTarget()?.kind) ? { model: selectionModel.value } : {}),
    ...(currentTarget()?.projectBased ? { projectPath: selectedProject() || '' } : {}),
    ...(selectionSpirit.value ? { spiritId: selectionSpirit.value } : {}),
  };
  state.error = '';
  render();
  const readsBack = targetReadsBack();
  if (readsBack) {
    // 對話框會留著顯示回覆：先清掉輸入框，圖片與脈絡只在第一次送出時附上
    selectionQuestionInput.value = '';
    selectedImage = undefined;
    selectedSourceText = '';
    selectedContext = [];
    renderContext();
    clearAttachments(); // 附件已經送出；追問要再附就重新加
    selectionQuestionImage.hidden = true;
  }
  await submitDelivery(payload);
}

async function submitDelivery(payload) {
  try {
    const result = await bridge.deliver(payload);
    if (!result?.ok) state.error = result?.error || '自動投遞失敗。';
    if (result?.needsKey) openApiKeyDialog(); // 金鑰失效：直接請使用者重新輸入
    if (result?.needsLogin) pendingLoginRetry = payload; // 沒登入：登入完成後自動重送
  } catch (error) {
    state.error = error.message;
  }
  render();
  if (selectionQuestionDialog.open && !state.busy && !apiKeyDialog.open) selectionQuestionInput.focus();
}

async function finishConversation() {
  try {
    const result = await bridge.finishConversation();
    if (!result?.ok) {
      state.error = result?.error || '無法保存並退出這段對話。';
      render();
      return;
    }
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function resetSourcePreview() {
  clearAttachments();
  selectedImage = undefined;
  selectedSourceText = '';
  sourceWarning = '';
  imageFile.value = '';
  imagePreview.hidden = true;
  previewImage.removeAttribute('src');
  selectionQuestionImage.removeAttribute('src');
  selectionQuestionImage.hidden = true;
  selectionQuestionSource.hidden = true;
  selectionQuestionSourceText.textContent = '';
  selectionQuestionInput.value = '';
  question.value = '';
  selectedContext = [];
  renderContext();
}

function formatHistoryDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── 歷史紀錄：小精靈自己的（24 小時）＋ Claude Code／Codex／Gemini 自己保存在本機的 ──
let historyRecords = [];
let historyFilter = 'local';
const historySearch = document.querySelector('#history-search');
const HOUR = 3600_000;

/** 到期標示：「還有 23 小時」「還有 29 天」「不會自動刪除」 */
function describeExpiry(record) {
  if (!record.expiresAt) return { text: '不會自動刪除', level: 'never' };
  const left = Date.parse(record.expiresAt) - Date.now();
  if (!Number.isFinite(left)) return { text: '', level: '' };
  if (left <= 0) return { text: '即將刪除', level: 'urgent' };
  const text = left < HOUR ? L(`還有 ${Math.max(1, Math.round(left / 60_000))} 分鐘`, `${Math.max(1, Math.round(left / 60_000))} min left`)
    : left < 48 * HOUR ? L(`還有 ${Math.round(left / HOUR)} 小時`, `${Math.round(left / HOUR)} h left`)
      : L(`還有 ${Math.round(left / (24 * HOUR))} 天`, `${Math.round(left / (24 * HOUR))} days left`);
  return { text, level: left < 3 * HOUR ? 'urgent' : left < 2 * 24 * HOUR ? 'soon' : '' };
}

function filteredHistory() {
  const query = historySearch.value.trim().toLowerCase();
  return historyRecords.filter((record) => {
    if (historyFilter === 'local' && !record.localOnly) return false;
    if (historyFilter === 'apps' && record.localOnly) return false;
    if (!query) return true;
    return `${record.title}\n${record.searchText || ''}\n${record.targetLabel || ''}`.toLowerCase().includes(query);
  });
}

function renderHistory(records) {
  if (records) historyRecords = records;
  historyList.replaceChildren();
  historyClearButton.disabled = !historyRecords.some((record) => record.origin === 'spirit');
  document.querySelectorAll('.history-filter').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.filter === historyFilter)));
  const shown = filteredHistory();
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = historySearch.value.trim()
      ? '沒有符合搜尋的紀錄。'
      : historyRecords.length
        ? '這個分類目前沒有紀錄，可以切到「全部」看看。'
        : '目前沒有歷史紀錄。退出對話後，問答會保存在這裡。';
    historyList.append(empty);
    return;
  }
  for (const record of shown) {
    const row = document.createElement('article');
    row.className = 'history-item';
    const open = document.createElement('button');
    open.className = 'history-open';
    open.type = 'button';
    const title = document.createElement('strong');
    title.dataset.i18nSkip = ''; // 使用者的問題不翻譯
    title.textContent = record.title;
    const meta = document.createElement('span');
    meta.className = 'history-meta';
    const ai = document.createElement('span');
    ai.className = 'history-ai';
    ai.textContent = record.targetLabel || 'AI';
    const where = document.createElement('span');
    where.className = 'history-local';
    where.textContent = record.localOnly ? L('只存在這台 Mac', 'Only on this computer') : '原對話在 App／網頁裡';
    const details = document.createElement('small');
    const questions = Math.ceil(record.messageCount / 2);
    details.textContent = L(`${formatHistoryDate(record.updatedAt || record.createdAt)} · ${questions} 則提問${record.origin === 'spirit' ? '' : ' · 可以接著問'}`, `${formatHistoryDate(record.updatedAt || record.createdAt)} · ${questions} question(s)${record.origin === 'spirit' ? '' : ' · can continue'}`);
    meta.append(ai, ...(record.spiritName ? [Object.assign(document.createElement('span'), { className: 'history-spirit', textContent: `🧙 ${record.spiritName}` })] : []), where, details);
    open.append(title, meta);
    open.title = record.origin === 'spirit' ? '打開這段對話' : L(`打開這段 ${record.targetLabel} 對話，直接輸入就會接著問`, `Open this ${tr(record.targetLabel)} conversation and keep asking`);
    open.addEventListener('click', async () => {
      try {
        const result = await bridge.openHistory(record.id);
        if (!result?.ok) {
          state.error = result?.error || '無法開啟這筆紀錄。';
          render();
        }
      } catch (error) {
        state.error = error.message;
        render();
      }
    });
    const expiry = describeExpiry(record);
    const badge = document.createElement('span');
    badge.className = 'history-expiry';
    badge.dataset.level = expiry.level;
    badge.textContent = expiry.text;
    const by = document.createElement('small');
    by.textContent = record.expiresAt ? L(`${formatHistoryDate(record.expiresAt)} 刪除`, `Deleted ${formatHistoryDate(record.expiresAt)}`) : tr(record.targetLabel || '');
    badge.append(by);
    badge.title = record.retention || '';
    row.append(open, badge);
    if (record.origin === 'spirit') {
      const remove = document.createElement('button');
      remove.className = 'history-delete';
      remove.type = 'button';
      remove.textContent = '刪除';
      remove.addEventListener('click', async () => {
        try { renderHistory(await bridge.deleteHistory(record.id)); }
        catch (error) { state.error = error.message; render(); }
      });
      row.append(remove);
    } else {
      // Claude Code／Codex／Gemini 自己的檔案：小精靈只讀不刪
      const keeper = document.createElement('span');
      keeper.className = 'history-keeper';
      keeper.textContent = L(`由 ${record.targetLabel} 保管`, `Kept by ${tr(record.targetLabel)}`);
      keeper.title = record.retention || '';
      row.append(keeper);
    }
    historyList.append(row);
  }
}
document.querySelectorAll('.history-filter').forEach((button) => button.addEventListener('click', () => {
  historyFilter = button.dataset.filter;
  renderHistory();
}));
historySearch.addEventListener('input', () => renderHistory());

async function showHistory() {
  try {
    renderHistory(await bridge.listHistory());
    if (!historyDialog.open) historyDialog.showModal();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

document.querySelector('#selection-question-cancel').addEventListener('click', () => void finishConversation());
selectionQuestionDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void finishConversation();
});
selectionQuestionConnectButton.addEventListener('click', () => void connectChatGPT());

async function sendQuestion(text, imageDataUrl) {
  if (!text || state.busy) return;
  const sourceText = combinedSourceText();
  const payload = {
    question: text,
    ...(imageDataUrl ? { imageDataUrl } : {}),
    ...(sourceText ? { sourceText } : {}),
    ...(selectionSpirit.value ? { spiritId: selectionSpirit.value } : {}),
  };
  selectedImage = undefined;
  selectedSourceText = '';
  selectionQuestionSource.hidden = true;
  clearAttachments();
  selectionQuestionImage.hidden = true;
  imageFile.value = '';
  imagePreview.hidden = true;
  previewImage.removeAttribute('src');
  state.error = '';
  render();
  try {
    const result = await bridge.send(payload);
    if (!result.ok) state.error = result.error;
  } catch (error) {
    state.error = error.message;
  }
  render();
  if (selectionQuestionDialog.open && !state.busy) selectionQuestionInput.focus();
}

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!question.value.trim() || state.busy) return;
  const text = question.value.trim();
  question.value = '';
  sendButton.disabled = true;
  await sendQuestion(text, selectedImage?.dataUrl);
  question.focus();
});

cancelButton.addEventListener('click', () => void bridge.cancel());
hideChatButton.addEventListener('click', () => void bridge.hideChat());
historyButton.addEventListener('click', () => void showHistory());
document.querySelector('#history-close').addEventListener('click', () => historyDialog.close());
historyClearButton.addEventListener('click', async () => {
  try { renderHistory(await bridge.clearHistory()); }
  catch (error) { state.error = error.message; render(); }
});
clearButton.addEventListener('click', async () => {
  try { state = await bridge.clear(); }
  catch (error) { state.error = error.message; }
  render();
});
usageButton.addEventListener('click', () => void bridge.manageUsage());
disconnectButton.addEventListener('click', async () => {
  try { state = await bridge.disconnect(); }
  catch (error) { state.error = error.message; }
  render();
});

bridge.onState((nextState) => {
  state = nextState;
  render();
});
bridge.onDelta(({ delta }) => {
  for (const target of [transcript, selectionQuestionTranscript]) {
    const bubble = target.querySelector('.message.assistant:last-child .bubble');
    if (!bubble) continue;
    const current = bubble.querySelector('span')?.textContent ?? '';
    let span = bubble.querySelector('span');
    if (!span) {
      span = document.createElement('span');
      bubble.replaceChildren(span);
    }
    span.textContent = current + delta;
  }
  fitQuestionTranscript();
});
bridge.onOpenChat(() => {
  if (state && (state.messages.length || ['screen', 'clipboard'].includes(state.conversation?.source?.kind))) {
    if (!selectionQuestionDialog.open) selectionQuestionDialog.showModal(); syncSpiritPreview();
    fitQuestionTranscript();
    selectionQuestionInput.focus();
  }
});
bridge.onFinishConversation(() => {
  if (selectionQuestionDialog.open) selectionQuestionDialog.close();
  resetSourcePreview();
});
bridge.onHistoryOpened(({ sourceKind, imageDataUrl, sourceText, continues }) => {
  if (historyDialog.open) historyDialog.close();
  resetSourcePreview();
  selectedSourceText = sourceText || '';
  selectedImage = imageDataUrl ? { name: sourceKind === 'screen' ? '圈選畫面' : '歷史圖片', dataUrl: imageDataUrl } : undefined;
  if (selectedImage) {
    previewImage.src = selectedImage.dataUrl;
    previewName.textContent = selectedImage.name;
    imagePreview.hidden = false;
    selectionQuestionImage.src = selectedImage.dataUrl;
    selectionQuestionImage.hidden = false;
  }
  if (selectedSourceText) {
    selectionQuestionSourceText.textContent = selectedSourceText;
    selectionQuestionSource.hidden = false;
  }
  selectedContext = Array.isArray(state?.conversation?.source?.context) ? state.conversation.source.context : [];
  renderContext();
  selectionQuestionDescription.textContent = continues
    ? L(`已打開 ${continues} 的對話紀錄。直接輸入問題，就會接著這段對話問（不會重新開始）。`, `Opened the ${continues} conversation. Type a question to continue it (it won't start over).`)
    : '已從歷史紀錄開啟。送到外部 AI 軟體時，會用原本的內容開一段新對話。';
  if (!selectionQuestionDialog.open) selectionQuestionDialog.showModal(); syncSpiritPreview();
  fitQuestionTranscript();
  selectionQuestionInput.focus();
});
bridge.onPresentation((mode) => {
  document.body.dataset.presentationMode = mode;
});
bridge.onSelectionResult(({ name, dataUrl, context }) => {
  clearAttachments();
  selectionSpirit.value = '';
  void loadSpirits();
  pendingLoginRetry = undefined;
  for (const id of Object.keys(projectLists)) delete projectLists[id];
  resetTargetToDefault();
  selectedImage = { name, dataUrl };
  selectedContext = Array.isArray(context) ? context : [];
  renderContext();
  selectedSourceText = '';
  sourceWarning = '';
  previewImage.src = dataUrl;
  previewName.textContent = name;
  imagePreview.hidden = false;
  selectionQuestionImage.src = dataUrl;
  selectionQuestionImage.hidden = false;
  selectionQuestionSource.hidden = true;
  selectionQuestionDescription.textContent = '已附上圈選內容。你可以在這個對話框提問與追問。';
  selectionQuestionImage.style.maxHeight = '88px';
  selectionQuestionTranscript.style.setProperty('--dialog-font-size', '12px');
  selectionQuestionInput.value = '';
  state.error = '';
  render();
  if (!selectionQuestionDialog.open) selectionQuestionDialog.showModal(); syncSpiritPreview();
  fitQuestionTranscript();
  selectionQuestionInput.focus();
});
bridge.onClipboardResult(({ text, imageDataUrl, warning, context }) => {
  clearAttachments();
  selectionSpirit.value = '';
  void loadSpirits();
  pendingLoginRetry = undefined;
  for (const id of Object.keys(projectLists)) delete projectLists[id];
  resetTargetToDefault();
  selectedContext = Array.isArray(context) ? context : [];
  renderContext();
  selectedImage = imageDataUrl ? { name: '剪貼簿圖片', dataUrl: imageDataUrl } : undefined;
  selectedSourceText = text || '';
  sourceWarning = warning || '';
  imagePreview.hidden = !selectedImage;
  if (selectedImage) {
    previewImage.src = selectedImage.dataUrl;
    previewName.textContent = selectedImage.name;
    selectionQuestionImage.src = selectedImage.dataUrl;
  } else {
    previewImage.removeAttribute('src');
    selectionQuestionImage.removeAttribute('src');
  }
  selectionQuestionImage.hidden = !selectedImage;
  selectionQuestionSourceText.textContent = selectedSourceText;
  selectionQuestionSource.hidden = !selectedSourceText;
  selectionQuestionDescription.textContent = '文字模式：只會附上你反白（或複製）的內容與來源程式，周邊畫面不會擷取。';
  selectionQuestionInput.value = '';
  state.error = '';
  render();
  if (!selectionQuestionDialog.open) selectionQuestionDialog.showModal(); syncSpiritPreview();
  fitQuestionTranscript();
  selectionQuestionInput.focus();
});

state = await bridge.getState();
setLanguage(state.language?.current);
installTranslator();
render();
// 第一次設定做到一半（例如剛換了語言而重新載入）：接著打開
if (state.integrations && !state.integrations.decided && readPreference(SETUP_STEP_KEY, '')) openIntegrations();

// 主視窗上方的語言選單
const languageSelect = document.querySelector('#language-select');
languageSelect.value = getLanguage();
languageSelect.addEventListener('change', async () => {
  await bridge.languageSet(languageSelect.value);
  location.reload();
});
