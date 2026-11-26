// 工作流連接器（主視窗裡的一個畫面，和對話、精靈博士直接切換）：拖卡片、拉線、寫「收到資料時要做什麼」、執行並看每一步的結果。
import { activeFlow, ENGINE_VERSION, autoNote, canConnect, downstreamOf, executionOrder, moveInOrder, newId, setEnd, stepNumbers, upstreamOf, validateWorkflow } from './workflow-engine.mjs';

const TEMPLATE = `
  <header class="wf-top">
    <button class="wf-back" type="button" data-action="back">← 回小精靈</button>
    <div class="wf-brand"><span aria-hidden="true">⛓</span> 工作流</div>
    <label class="wf-pick"><span class="wf-sr-only">選擇工作流</span><select id="wf-select"></select></label>
    <input id="wf-name" class="wf-name" type="text" maxlength="60" aria-label="工作流名稱" />
    <button id="wf-new" class="wf-button" type="button">＋ 新的工作流</button>
    <button id="wf-delete" class="wf-button quiet" type="button">刪除</button>
    <span id="wf-saved" class="wf-saved" aria-live="polite"></span>
    <button class="wf-button switch" type="button" data-action="lab">✦ 精靈博士</button>
  </header>
  <div class="wf-main">
    <aside class="wf-library" aria-label="卡片庫">
      <p class="wf-hint">把卡片拖到中間（或點一下加入），再從卡片右邊的圓點拉線到下一張卡片。灰色的是目前不能用的 AI。</p>
      <section><h2>開始</h2><div id="lib-basic" class="wf-lib-list"></div>
        <p class="wf-hint wf-end-hint">結尾：在最後的精靈或 AI 卡片上按「★ 設為成品」，可以設好幾張（好幾份成品）。多接一時，就由那張卡片的 AI 把前面幾份結果整合成一個成品。</p></section>
      <section><h2>精靈</h2><div id="lib-spirits" class="wf-lib-list"></div></section>
      <section><h2>AI 工具</h2><div id="lib-tools" class="wf-lib-list"></div></section>
    </aside>
    <div class="wf-stage">
      <section class="wf-canvas" id="wf-canvas" aria-label="工作流畫布（雙指捏合縮放、雙指滑動移動）">
        <div class="wf-sizer" id="wf-sizer"><div class="wf-board" id="wf-board"><svg class="wf-edges" id="wf-edges" aria-hidden="true"></svg></div></div>
      </section>
      <div class="wf-zoom" role="group" aria-label="縮放">
        <button type="button" data-zoom="out" title="縮小" aria-label="縮小">−</button>
        <button type="button" data-zoom="reset" id="wf-zoom-level" title="回到 100%">100%</button>
        <button type="button" data-zoom="in" title="放大" aria-label="放大">＋</button>
        <button type="button" data-zoom="fit" title="顯示全部卡片">⤢</button>
      </div>
    </div>
    <aside class="wf-run" aria-label="執行">
      <h2>執行</h2>
      <label class="wf-field">
        <span>你的問題（交給「使用者輸入」卡片）</span>
        <textarea id="wf-request" rows="5" maxlength="20000" placeholder="例如：幫我比較這三款相機，整理成一份給主管看的報告"></textarea>
      </label>
      <div class="wf-field">
        <span>附件（整條工作流都會帶著：要分析的檔案或資料夾）</span>
        <div id="wf-request-files" class="wf-files"></div>
      </div>
      <div class="wf-row">
        <button id="wf-run" class="wf-button primary" type="button">▶ 執行</button>
        <button id="wf-finish" class="wf-button" type="button" hidden title="操作 App 的步驟不限時間等回覆；AI 已經回完、但沒有照格式交件時，按這個用目前讀到的內容繼續">⏭ 用目前讀到的內容完成這一步</button>
        <button id="wf-stop" class="wf-button quiet" type="button" hidden>■ 停止</button>
      </div>
      <div id="wf-check" class="wf-check" aria-live="polite"></div>
      <ul id="wf-problems" class="wf-problems" aria-live="polite"></ul>
      <div id="wf-results" class="wf-results"></div>
    </aside>
  <section class="wf-console" id="wf-console" aria-label="執行紀錄">
    <div class="wf-console-grip" id="wf-console-grip" title="拖動調整高度" aria-hidden="true"></div>
    <header class="wf-console-head">
      <strong>執行紀錄</strong>
      <span id="wf-console-state" class="wf-console-state"></span>
      <span class="wf-console-tools">
        <label><input id="wf-console-follow" type="checkbox" checked /> 自動捲到最新</label>
        <button type="button" id="wf-console-copy">複製全部</button>
        <button type="button" id="wf-console-clear">清除</button>
        <button type="button" id="wf-console-toggle" aria-expanded="true">收起 ▾</button>
      </span>
    </header>
    <div class="wf-console-body" id="wf-console-body" role="log" aria-live="off"><div class="wf-console-empty">按「▶ 執行」後，每一步 AI 回覆的全文會即時出現在這裡。</div></div>
  </section>
  </div>`;

export function createWorkflowView({ bridge, root, onClose = () => {}, onSwitchLab = () => {} }) {
root.innerHTML = TEMPLATE;
const $ = (selector) => root.querySelector(selector);
const api = {
  catalog: () => bridge.wfCatalog(),
  list: () => bridge.wfList(),
  get: (id) => bridge.wfGet(id),
  save: (workflow) => bridge.wfSave(workflow),
  remove: (id) => bridge.wfDelete(id),
  validate: (workflow) => bridge.wfValidate(workflow),
  run: (options) => bridge.wfRun(options),
  cancel: () => bridge.wfCancel(),
  saveOutput: (options) => bridge.wfSaveOutput(options),
  onEvent: (listener) => bridge.onWorkflowEvent(listener),
};

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') element.className = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'value') element.value = value;
    else if (key in element && typeof value !== 'string') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}

const KIND_INFO = {
  input: { icon: '✎', name: '使用者輸入' },
  spirit: { icon: '✦', name: '精靈' },
  tool: { icon: '◆', name: 'AI 工具' },
};
const STATUS_TEXT = { waiting: '等待中', running: '執行中…', done: '完成', failed: '失敗', skipped: '跳過（前一步沒有結果）' };
const NODE_WIDTH = 240;
const PORT_Y = 24;

let catalog = { tools: [], spirits: [] };
let workflows = [];
let wf;
let selected = null; // { type: 'node' | 'edge', id }
const run = { running: false, status: {}, text: {}, error: {}, order: [] };
let lastOutputs = [];

const canvas = $('#wf-canvas');
const board = $('#wf-board');
const edgesLayer = $('#wf-edges');
const sizer = $('#wf-sizer');
const zoomLevel = $('#wf-zoom-level');
// 縮放：畫布（卡片、線）整個用 transform 縮放；外面的 sizer 撐出縮放後的大小，讓捲動（雙指移動）範圍正確
const ZOOM_MIN = 0.3; const ZOOM_MAX = 2;
let zoom = 1;
const nodeElements = new Map();

// ── 名稱 ──
const toolOf = (id) => catalog.tools.find((tool) => tool.id === id);
const spiritOf = (id) => catalog.spirits.find((spirit) => spirit.id === id);
function nodeLabel(node) {
  if (node.kind === 'input') return '使用者輸入';
  if (node.kind === 'spirit') return spiritOf(node.spiritId)?.name || '精靈（未選）';
  const tool = toolOf(node.targetId);
  return tool ? `${tool.short}${node.model ? ` · ${node.model}` : ''}` : 'AI 工具（未選）';
}
const labelled = () => ({ ...wf, nodes: wf.nodes.map((node) => ({ ...node, _label: nodeLabel(node) })) });
/** 這張卡片拿不拿得回結果、能不能用（接線規則和流程檢查用） */
function toolInfo(node) {
  if (node.kind === 'spirit') {
    const spirit = spiritOf(node.spiritId);
    return spirit ? { label: spirit.name, available: spirit.available, reason: spirit.reason, canReturn: spirit.canReturn } : { label: '精靈', available: !node.spiritId, reason: '找不到這隻精靈', canReturn: true };
  }
  if (node.kind === 'tool') {
    const tool = toolOf(node.targetId);
    return tool ? { label: nodeLabel(node), available: tool.available, reason: tool.reason, canReturn: tool.canReturn } : { label: 'AI 工具', available: !node.targetId, reason: '找不到這個 AI', canReturn: true };
  }
  return { label: nodeLabel(node), available: true, canReturn: true };
}
const connectRules = { canReturn: (node) => toolInfo(node).canReturn };

// ── 存檔 ──
let saveTimer;
function scheduleSave() {
  scheduleCheck();
  clearTimeout(saveTimer);
  $('#wf-saved').textContent = '編輯中…';
  saveTimer = setTimeout(() => void saveNow(), 500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!wf) return;
  try {
    const saved = await api.save(wf);
    wf.updatedAt = saved.updatedAt;
    $('#wf-saved').textContent = '已儲存';
    const item = workflows.find((entry) => entry.id === wf.id);
    if (item) item.name = wf.name; else workflows.unshift({ id: wf.id, name: wf.name });
    renderSelect();
  } catch (error) {
    $('#wf-saved').textContent = `儲存失敗：${error.message || error}`;
  }
}

function starter(name = '新的工作流') {
  return {
    id: newId('wf'), name,
    nodes: [{ id: newId('n'), kind: 'input', x: 60, y: 160, seq: 10 }],
    edges: [],
  };
}

// ── 卡片庫 ──
function libraryItem({ kind, id = '', title, meta, warn, color, disabled = false }) {
  const item = h('div', {
    className: `wf-lib-item kind-${kind}${warn ? ' warn' : ''}${disabled ? ' disabled' : ''}`, draggable: disabled ? 'false' : 'true', tabIndex: disabled ? -1 : 0, role: 'button',
    'aria-disabled': disabled ? 'true' : undefined,
    title: `${title}${meta ? `｜${meta}` : ''}${warn ? `｜${warn}` : ''}`,
    dataset: { kind, id, ...(color ? { color } : {}) },
    onClick: () => { if (!disabled) addNode(kind, id); },
    onKeydown: (event) => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); addNode(kind, id); } },
  },
  h('span', { className: 'wf-lib-icon', 'aria-hidden': 'true' }, KIND_INFO[kind].icon),
  h('span', { className: 'wf-lib-text' }, h('strong', {}, title), meta ? h('small', {}, meta) : null, warn ? h('small', { className: 'wf-warn' }, warn) : null));
  item.addEventListener('dragstart', (event) => {
    if (disabled || run.running) { event.preventDefault(); if (run.running) locked(); return; }
    event.dataTransfer.setData('application/x-wf-card', JSON.stringify({ kind, id }));
    event.dataTransfer.effectAllowed = 'copy';
  });
  return item;
}
function renderLibrary() {
  const hasInput = wf?.nodes.some((node) => node.kind === 'input');
  $('#lib-basic').replaceChildren(
    libraryItem({ kind: 'input', title: '使用者輸入', meta: hasInput ? '已經放了（只能一張）' : '問題從這裡出發' }),
  );
  const sorted = (items) => [...items].sort((a, b) => Number(b.available) - Number(a.available));
  $('#lib-spirits').replaceChildren(...(catalog.spirits.length ? sorted(catalog.spirits).map((spirit) => libraryItem({
    kind: 'spirit', id: spirit.id, title: spirit.name, meta: `用 ${spirit.aiLabel}`, color: spirit.color,
    disabled: !spirit.available,
    warn: !spirit.available ? (spirit.reason || '目前不能用') : !spirit.canReturn ? '只能放最後一步（貼到 App）' : '',
  })) : [h('p', { className: 'wf-empty' }, '還沒有精靈，可以按右上角「✦ 精靈博士」建立。')]));
  $('#lib-tools').replaceChildren(...sorted(catalog.tools).map((tool) => libraryItem({
    kind: 'tool', id: tool.id, title: tool.short,
    meta: !tool.available ? '' : tool.canReturn ? tool.access || (tool.models ? `${tool.models.length} 個模型可選` : '拿得回結果') : '只貼上送出（拿不回結果）',
    disabled: !tool.available,
    warn: !tool.available ? `目前不能用（${tool.reason || '未啟用'}）` : !tool.canReturn ? '拿不回結果，只能放最後一步' : '',
  })));
}

// ── 卡片 ──
/** 執行中不能改任何東西（卡片、接線、附件、設定）；可以看、可以縮放移動畫布 */
let lockToastAt = 0;
function locked() {
  if (!run.running) return false;
  if (Date.now() - lockToastAt > 2500) { lockToastAt = Date.now(); toast('執行中不能修改工作流：請等這次執行完，或按「■ 停止」。'); }
  return true;
}

function addNode(kind, id = '', at) {
  if (!wf || locked()) return;
  if (kind === 'input' && wf.nodes.some((node) => node.kind === 'input')) { toast('「使用者輸入」只能放一張。'); return; }
  if (kind === 'tool' && toolOf(id) && !toolOf(id).available) { toast(`${toolOf(id).short} 目前不能用（${toolOf(id).reason || '未啟用'}）。`); return; }
  if (kind === 'spirit' && spiritOf(id) && !spiritOf(id).available) { toast(`${spiritOf(id).name} 目前不能用（${spiritOf(id).reason || '指定的 AI 未啟用'}）。`); return; }
  const offset = (wf.nodes.length % 6) * 24;
  const position = at || { x: canvas.scrollLeft / zoom + 320 + offset, y: canvas.scrollTop / zoom + 60 + offset };
  const node = { id: newId('n'), kind, x: Math.max(0, Math.round(position.x)), y: Math.max(0, Math.round(position.y)), seq: Math.max(0, ...wf.nodes.map((item) => item.seq || 0)) + 10 };
  if (kind === 'spirit') Object.assign(node, { spiritId: id, note: '' });
  if (kind === 'tool') {
    const tool = toolOf(id);
    Object.assign(node, { targetId: id, model: tool?.defaultModel || '', note: '' });
  }
  wf.nodes.push(node);
  selected = { type: 'node', id: node.id };
  renderBoard();
  renderLibrary();
  scheduleSave();
}

function removeNode(id) {
  if (locked()) return;
  wf.nodes = wf.nodes.filter((node) => node.id !== id);
  wf.edges = wf.edges.filter((edge) => edge.from !== id && edge.to !== id);
  selected = null;
  renderBoard();
  renderLibrary();
  scheduleSave();
}

function noteField(node) {
  const placeholder = () => `沒填就自動：${autoNote(labelled(), { ...node, _label: nodeLabel(node) })}`;
  const area = h('textarea', {
    className: 'wf-note', rows: 3, maxLength: 2000, value: node.note || '', placeholder: placeholder(),
    'aria-label': '收到資料時要做什麼',
    onInput: (event) => { node.note = event.target.value; scheduleSave(); },
  });
  area.dataset.auto = node.id;
  return h('label', { className: 'wf-node-field' },
    h('span', {}, '收到資料時要做什麼', h('em', {}, node.note ? '' : '（可不填）')),
    area);
}

function statusLine(node) {
  const status = run.status[node.id];
  if (!status) return h('div', { className: 'wf-node-status', hidden: true });
  const text = run.text[node.id] || '';
  return h('div', { className: `wf-node-status s-${status}` },
    h('span', { className: 'wf-dot', 'aria-hidden': 'true' }),
    h('span', {}, status === 'failed' ? `失敗：${run.error[node.id] || ''}` : STATUS_TEXT[status]),
    text && node.kind !== 'input' ? h('p', { className: 'wf-preview' }, text.length > 160 ? `${text.slice(0, 160)}…` : text) : null,
    text && node.kind !== 'input' ? h('button', { type: 'button', className: 'wf-link', onClick: () => showResult(node.id) }, '看全文') : null);
}

/** 成品（結尾）標記：可以有好幾張；後面還有接線的卡片不能標 */
const OUTPUT_CHOICES = [['md', 'Markdown 筆記（.md）'], ['docx', 'Word 文件（.docx）'], ['pdf', 'PDF（.pdf）'], ['pptx', 'PowerPoint 簡報（.pptx）'], ['xlsx', 'Excel 試算表（.xlsx）'], ['html', '網頁（.html）']];
function endControl(node) {
  if (node.end) {
    return h('div', { className: 'wf-end on' },
      h('div', { className: 'wf-end-row' },
        h('strong', {}, '★ 這張是成品（結尾）'),
        h('button', { type: 'button', className: 'wf-link', onClick: () => markEnd(node.id, false) }, '取消')),
      h('label', { className: 'wf-node-field' }, h('span', {}, '成品名稱（可不填）'),
        h('input', { type: 'text', maxLength: 60, value: node.endTitle || '', placeholder: '例如：給主管的報告', onInput: (event) => { node.endTitle = event.target.value; scheduleSave(); } })),
      h('label', { className: 'wf-node-field' }, h('span', {}, '做成哪種檔案'),
        h('select', { 'aria-label': '成品要做成哪種檔案', onChange: (event) => { node.outputFormat = event.target.value; scheduleSave(); } },
          ...OUTPUT_CHOICES.map(([value, label]) => h('option', { value, selected: (node.outputFormat || 'md') === value }, label)))),
      h('small', { className: 'wf-node-meta' }, '這張卡片交件後，會自動做成這種檔案、存到「文件／Screen Spirit 成品」，這次的任務就完成了。'),
      upstreamOf(wf, node.id).filter((item) => item.kind !== 'input').length > 1 ? h('small', { className: 'wf-node-meta' }, '前面接了好幾份結果：這張卡片的 AI 會把它們整合成一個成品。') : null);
  }
  const blocked = wf.edges.some((edge) => edge.from === node.id);
  return h('button', {
    type: 'button', className: `wf-end${blocked ? ' blocked' : ''}`, title: blocked ? '這張卡片後面還有接線；成品是結尾，請先把它後面的線拿掉。' : '把這張卡片的結果當作最後的成品',
    onClick: () => markEnd(node.id),
  }, blocked ? '★ 設為成品（後面還有線）' : '★ 設為成品（結尾）');
}
function markEnd(id, on = true) {
  if (locked()) return;
  const result = setEnd(wf, id, on);
  if (!result.ok) { toast(result.reason, 'bad'); return; }
  wf.nodes = result.workflow.nodes;
  renderBoard();
  scheduleSave();
}

function nodeBody(node) {
  if (node.kind === 'input') return [h('p', { className: 'wf-node-text' }, '執行時，右邊輸入的問題會從這裡出發。'), filesField(node, '附件（整條工作流都會帶著）')];
  return [endControl(node), ...workBody(node), filesField(node, '這一步另外要看的檔案／資料夾'), lastResultField(node)];
}

function workBody(node) {
  if (node.kind === 'spirit') {
    const spirit = spiritOf(node.spiritId);
    const select = h('select', {
      'aria-label': '選擇精靈',
      onChange: (event) => { node.spiritId = event.target.value; scheduleSave(); renderBoard(); },
    }, h('option', { value: '' }, '請選擇精靈'), ...catalog.spirits.map((item) => h('option', { value: item.id, selected: item.id === node.spiritId, disabled: !item.available && item.id !== node.spiritId }, `${item.name}${item.available ? '' : '（不能用）'}`)));
    return [
      select,
      spirit ? h('p', { className: 'wf-node-meta' }, `用 ${spirit.aiLabel}，帶著牠的角色、限制、SOP 和記憶回答`) : null,
      spirit ? runModeField(node, toolOf(spirit.targetId)) : null,
      spirit && !spirit.available ? h('p', { className: 'wf-warn' }, spirit.reason || '目前不能用') : null,
      spirit && spirit.available && !spirit.canReturn ? h('p', { className: 'wf-warn' }, '這隻精靈用的 AI 只能貼到 App，拿不回結果：只能放最後一步。') : null,
      noteField(node),
    ];
  }
  const tool = toolOf(node.targetId);
  const select = h('select', {
    'aria-label': '選擇 AI',
    onChange: (event) => { node.targetId = event.target.value; node.model = toolOf(node.targetId)?.defaultModel || ''; scheduleSave(); renderBoard(); },
  }, h('option', { value: '' }, '請選擇 AI'), ...catalog.tools.map((item) => h('option', { value: item.id, selected: item.id === node.targetId, disabled: !item.available && item.id !== node.targetId }, `${item.short}${item.available ? '' : '（不能用）'}`)));
  const models = tool?.models || [];
  const background = node.runMode === 'background' && tool?.backgroundAlt;
  const returnField = tool?.returnVia && !background ? (tool.fileReturn
    ? h('label', { className: 'wf-node-field' }, h('span', {}, '結果怎麼帶回來'),
      h('select', { 'aria-label': '結果怎麼帶回來', onChange: (event) => { node.returnMode = event.target.value; scheduleSave(); renderBoard(); } },
        h('option', { value: '', selected: node.returnMode !== 'file' }, `${tool.returnVia}（預設）`),
        h('option', { value: 'file', selected: node.returnMode === 'file' }, `請 ${tool.short} 存成檔案交回`)),
      node.returnMode === 'file' ? h('small', { className: 'wf-node-meta' }, `需要 ${tool.short} 有本機檔案權限，並允許寫入「${catalog.handoffFolder || '文件／Screen Spirit 交件'}」；沒存出檔案時會改用畫面上的回覆。`) : null)
    : null) : null;
  return [
    select,
    models.length ? h('select', {
      'aria-label': '選擇模型',
      onChange: (event) => { node.model = event.target.value; scheduleSave(); refreshHeads(); refreshAutoNotes(); },
    }, ...models.map((model) => h('option', { value: model, selected: model === node.model }, model))) : null,
    tool && !tool.available ? h('p', { className: 'wf-warn' }, `目前不能用（${tool.reason || '未啟用'}）`) : null,
    tool && tool.available && !tool.canReturn ? h('p', { className: 'wf-warn' }, '這個 AI 只會把內容貼到 App／網頁送出，拿不回結果：只能放最後一步。') : null,
    tool ? runModeField(node, tool) : null,
    returnField,
    noteField(node),
  ];
}

/** 上一次的結果：可以看、可以改（或自己貼上），也可以「從這一步開始」接著跑（前面的步驟沿用上次的結果） */
function lastResultField(node) {
  wf.lastRun ||= { request: '', results: {}, at: '' };
  const value = wf.lastRun.results[node.id] || '';
  const area = h('textarea', {
    className: 'wf-note wf-last-result', rows: 4, maxLength: 200000, value, placeholder: '還沒有結果。可以自己貼上這一步的結果，之後就能從下一步接著跑。',
    'aria-label': `「${nodeLabel(node)}」上一次的結果`,
    onInput: (event) => { const text = event.target.value; if (text.trim()) wf.lastRun.results[node.id] = text; else delete wf.lastRun.results[node.id]; summary.textContent = summaryText(); scheduleSave(); },
  });
  const summaryText = () => (wf.lastRun.results[node.id] ? `上一次的結果（${wf.lastRun.results[node.id].length} 字，可以修改）` : '上一次的結果（還沒有，可以自己貼上）');
  const summary = h('summary', {}, summaryText());
  const start = node.ignored ? null : h('button', {
    type: 'button', className: 'wf-button small wf-from-here', disabled: run.running || undefined,
    title: '前面的步驟不重跑，直接用它們上一次的結果；從這一張卡片開始往後執行',
    onClick: (event) => { event.stopPropagation(); void startRun(node.id); },
  }, '▶ 從這一步開始執行');
  return h('div', { className: 'wf-node-field wf-last' },
    h('details', {}, summary, area),
    start);
}

/** 執行方式：用選的那個 AI（例如 Claude 桌面 App），或改用同一個帳號的背景版本（例如 Claude Code） */
function runModeField(node, tool) {
  if (!tool) return null;
  const alt = tool.backgroundAlt ? toolOf(tool.backgroundAlt) : undefined;
  const effective = node.runMode === 'background' && alt ? alt : tool;
  const note = h('p', { className: `wf-node-meta wf-runs-as${effective === tool ? '' : ' background'}` },
    h('strong', {}, `實際執行：${effective.short}`), ` — ${effective.access || ''}`);
  if (!alt) return note;
  return h('div', { className: 'wf-node-field' },
    h('label', { className: 'wf-node-field' }, h('span', {}, '執行方式'),
      h('select', { 'aria-label': '執行方式', onChange: (event) => { node.runMode = event.target.value; if (node.runMode === 'background') node.returnMode = ''; scheduleSave(); renderBoard(); } },
        h('option', { value: 'app', selected: node.runMode !== 'background' }, `用 ${tool.short}（可以用它的權限，會切到前景幾秒）`),
        h('option', { value: 'background', selected: node.runMode === 'background' }, `改用背景的 ${alt.short}（不搶畫面，只讀得到附件）`))),
    note);
}

/** 附件：檔案或資料夾的路徑（AI 讀得到電腦的直接給路徑，讀不到的把文字內容一起送過去） */
function filesField(node, title) {
  node.files ||= [];
  const chips = node.files.map((file, index) => h('span', { className: `wf-file kind-${file.kind}`, title: file.path },
    h('span', { 'aria-hidden': 'true' }, file.kind === 'dir' ? '📁' : '📄'),
    h('span', { className: 'wf-file-name' }, file.path.split('/').filter(Boolean).pop() || file.path),
    h('button', { type: 'button', 'aria-label': `移除 ${file.path}`, onClick: (event) => { event.stopPropagation(); node.files.splice(index, 1); scheduleSave(); renderBoard(); renderRequestFiles(); } }, '×')));
  return h('div', { className: 'wf-node-field wf-files-field' },
    h('span', {}, title),
    h('div', { className: 'wf-files' }, ...chips,
      h('button', { type: 'button', className: 'wf-file-add', onClick: (event) => { event.stopPropagation(); void pickFiles(node); } }, '＋ 檔案／資料夾')));
}
async function pickFiles(node) {
  if (locked()) return;
  if (!bridge.wfPick) { toast('這個版本還不能附加檔案，請重新啟動小精靈。', 'bad'); return; }
  const picked = await bridge.wfPick().catch(() => []);
  if (!picked?.length) return;
  node.files ||= [];
  for (const file of picked) if (!node.files.some((item) => item.path === file.path) && node.files.length < 20) node.files.push(file);
  scheduleSave();
  renderBoard();
  renderRequestFiles();
}
/** 執行區的附件＝「使用者輸入」卡片的附件 */
function renderRequestFiles() {
  const holder = $('#wf-request-files');
  const input = wf?.nodes.find((node) => node.kind === 'input');
  if (!input) { holder.replaceChildren(h('small', { className: 'wf-empty' }, '先放一張「使用者輸入」卡片。')); return; }
  holder.replaceChildren(...filesField(input, '').querySelector('.wf-files').childNodes);
}

function toggleIgnore(node) {
  if (run.running) { toast('執行中不能改，請等這次執行完。'); return; }
  if (node.ignored) delete node.ignored; else node.ignored = true;
  toast(node.ignored ? `已忽略「${nodeLabel(node)}」：執行時會跳過它，前後要接起來才跑得動。` : `已恢復「${nodeLabel(node)}」。`);
  renderBoard();
  scheduleSave();
}

function nodeElement(node) {
  const info = KIND_INFO[node.kind];
  const spirit = node.kind === 'spirit' ? spiritOf(node.spiritId) : undefined;
  const head = h('div', { className: 'wf-node-head' },
    h('span', { className: 'wf-node-icon', 'aria-hidden': 'true' }, info.icon),
    h('span', { className: 'wf-node-title' }, h('small', {}, info.name), h('strong', {}, nodeLabel(node))),
    h('span', { className: 'wf-step', dataset: { step: node.id } }, stepText(node)),
    node.kind !== 'input' ? h('button', {
      type: 'button', className: `wf-node-ignore${node.ignored ? ' on' : ''}`, 'aria-pressed': String(Boolean(node.ignored)),
      title: node.ignored ? '取消忽略：執行時恢復這張卡片' : '忽略：卡片和接線都留著，但執行時先跳過它（暫時不用）',
      onClick: (event) => { event.stopPropagation(); toggleIgnore(node); },
    }, node.ignored ? '恢復' : '忽略') : null,
    h('button', { type: 'button', className: 'wf-node-remove', 'aria-label': `刪除「${nodeLabel(node)}」`, onClick: (event) => { event.stopPropagation(); removeNode(node.id); } }, '×'));
  const element = h('div', {
    className: `wf-node kind-${node.kind}${node.end ? ' is-end' : ''}${node.ignored ? ' ignored' : ''}${selected?.type === 'node' && selected.id === node.id ? ' selected' : ''}${run.status[node.id] ? ` s-${run.status[node.id]}` : ''}`,
    dataset: { id: node.id, ...(spirit?.color ? { color: spirit.color } : {}) },
  },
  head,
  h('div', { className: 'wf-node-body' }, ...nodeBody(node), orderControls(node)),
  statusLine(node),
  node.kind !== 'input' ? h('span', { className: 'wf-port in', title: '輸入：從前一步拉線到這裡', dataset: { port: 'in', id: node.id } }) : null,
  !node.end ? h('span', { className: 'wf-port out', title: '輸出：從這裡拉線到下一步', dataset: { port: 'out', id: node.id } }) : h('span', { className: 'wf-end-flag', title: '成品（結尾）' }, '★'));
  element.style.left = `${node.x}px`;
  element.style.top = `${node.y}px`;
  element.style.width = `${NODE_WIDTH}px`;
  element.addEventListener('pointerdown', () => { if (selected?.id !== node.id) { selected = { type: 'node', id: node.id }; markSelected(); } });
  attachNodeDrag(head, node, element);
  return element;
}

/** 卡片右上角：開頭／第 N 步／結尾 */
let steps = {};
function stepText(node) {
  if (node.kind === 'input') return '開頭';
  if (node.ignored) return '已忽略';
  if (!steps[node.id]) return node.end ? '成品・未接上' : '未接上';
  return node.end ? `第 ${steps[node.id]} 步・成品` : `第 ${steps[node.id]} 步`;
}

/** 一接多、多接一：調整執行順序（同一組卡片上下移動） */
function orderControls(node) {
  const flow = labelled();
  const next = downstreamOf(flow, node.id);
  const prev = upstreamOf(flow, node.id).filter((item) => item.kind !== 'input');
  const list = (title, hint, siblings) => h('div', { className: 'wf-order' },
    h('span', { className: 'wf-order-title' }, title, h('em', {}, hint)),
    ...siblings.map((item, index) => h('div', { className: 'wf-order-row' },
      h('span', { className: 'wf-order-num' }, String(index + 1)),
      h('span', { className: 'wf-order-name' }, item._label),
      h('button', { type: 'button', className: 'wf-order-move', 'aria-label': `把「${item._label}」往前`, disabled: index === 0, onClick: () => reorder(siblings, item.id, -1) }, '↑'),
      h('button', { type: 'button', className: 'wf-order-move', 'aria-label': `把「${item._label}」往後`, disabled: index === siblings.length - 1, onClick: () => reorder(siblings, item.id, 1) }, '↓'))));
  return [
    next.length > 1 ? list('接下來的執行順序', '（一個一個做，1 先做）', next) : null,
    prev.length > 1 ? list(node.end ? '整合的順序' : '合併的順序', '（前面誰先做，結果也照這個順序交進來）', prev) : null,
  ];
}
function reorder(siblings, id, direction) {
  if (locked()) return;
  const result = moveInOrder(wf, siblings, id, direction);
  if (!result.ok) { toast(result.reason); return; }
  wf.nodes = result.workflow.nodes;
  renderBoard();
  scheduleSave();
}

function renderBoard() {
  steps = wf ? stepNumbers(wf) : {};
  for (const element of nodeElements.values()) element.remove();
  nodeElements.clear();
  if (!wf) return;
  for (const node of wf.nodes) {
    const element = nodeElement(node);
    nodeElements.set(node.id, element);
    board.append(element);
  }
  sizeBoard();
  renderEdges();
  scheduleCheck();
  renderRequestFiles();
}

function markSelected() {
  for (const [id, element] of nodeElements) element.classList.toggle('selected', selected?.type === 'node' && selected.id === id);
  renderEdges();
}
function refreshHeads() {
  for (const node of wf.nodes) {
    const strong = nodeElements.get(node.id)?.querySelector('.wf-node-title strong');
    if (strong) strong.textContent = nodeLabel(node);
  }
}
/** 連線改變後，「沒填就自動」的說明要跟著變 */
function refreshAutoNotes() {
  const flow = labelled();
  for (const area of board.querySelectorAll('textarea[data-auto]')) {
    const node = flow.nodes.find((item) => item.id === area.dataset.auto);
    if (node) area.placeholder = `沒填就自動：${autoNote(flow, node)}`;
  }
}

function sizeBoard() {
  if (!wf) return;
  // 畫布至少和可見範圍一樣大（縮小時也鋪滿），右邊、下面多留空間可以往外拉卡片
  const maxX = Math.max(1600, canvas.clientWidth / zoom, ...wf.nodes.map((node) => node.x + NODE_WIDTH + 400));
  const maxY = Math.max(1000, canvas.clientHeight / zoom, ...wf.nodes.map((node) => node.y + 600));
  board.style.width = `${maxX}px`;
  board.style.height = `${maxY}px`;
  sizer.style.width = `${Math.ceil(maxX * zoom)}px`;
  sizer.style.height = `${Math.ceil(maxY * zoom)}px`;
  edgesLayer.setAttribute('width', String(maxX));
  edgesLayer.setAttribute('height', String(maxY));
}

// ── 連線 ──
const portPoint = (id, side) => {
  const node = wf.nodes.find((item) => item.id === id);
  const element = nodeElements.get(id);
  const width = element?.offsetWidth || NODE_WIDTH;
  return side === 'out' ? [node.x + width, node.y + PORT_Y] : [node.x, node.y + PORT_Y];
};
const curve = ([x1, y1], [x2, y2]) => {
  const bend = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
};
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const element = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value); return element; };

function renderEdges(temp) {
  const children = [];
  for (const edge of wf?.edges || []) {
    const from = portPoint(edge.from, 'out'); const to = portPoint(edge.to, 'in');
    const d = curve(from, to);
    const active = selected?.type === 'edge' && selected.id === edge.id;
    const flowing = run.status[edge.from] === 'done' && run.status[edge.to] === 'running';
    const skipped = wf.nodes.some((item) => item.ignored && (item.id === edge.from || item.id === edge.to));
    const group = svg('g', { class: `wf-edge${skipped ? ' ignored' : ''}${active ? ' selected' : ''}${flowing ? ' flowing' : ''}${run.status[edge.from] === 'done' && ['done', 'running'].includes(run.status[edge.to]) ? ' passed' : ''}` });
    const hit = svg('path', { d, class: 'wf-edge-hit' });
    hit.addEventListener('pointerdown', (event) => { event.stopPropagation(); selected = { type: 'edge', id: edge.id }; markSelected(); });
    group.append(hit, svg('path', { d, class: 'wf-edge-line' }));
    // 一接多／多接一：線上標順序（出口端＝接下來第幾個做；入口端＝合併時第幾份）
    const outs = downstreamOf(wf, edge.from); const ins = upstreamOf(wf, edge.to).filter((item) => item.kind !== 'input');
    const badge = (x, y, value, kind) => {
      const g = svg('g', { class: `wf-edge-badge ${kind}` });
      g.append(svg('circle', { cx: x, cy: y, r: 9 }));
      const label = svg('text', { x, y: y + 4, 'text-anchor': 'middle' }); label.textContent = value;
      g.append(label);
      group.append(g);
    };
    if (outs.length > 1) badge(from[0] + 22, from[1] + (to[1] > from[1] ? 10 : to[1] < from[1] ? -10 : 0), String(outs.findIndex((item) => item.id === edge.to) + 1), 'out');
    const source = wf.nodes.find((item) => item.id === edge.from);
    if (ins.length > 1 && source.kind !== 'input') badge(to[0] - 22, to[1] + (from[1] > to[1] ? 10 : from[1] < to[1] ? -10 : 0), String(ins.findIndex((item) => item.id === edge.from) + 1), 'in');
    if (active) {
      const mx = (from[0] + to[0]) / 2; const my = (from[1] + to[1]) / 2;
      const remove = svg('g', { class: 'wf-edge-remove', role: 'button', 'aria-label': '刪除這條線', tabindex: '0' });
      remove.append(svg('circle', { cx: mx, cy: my, r: 11 }));
      const label = svg('text', { x: mx, y: my + 4, 'text-anchor': 'middle' }); label.textContent = '×';
      remove.append(label);
      remove.addEventListener('pointerdown', (event) => { event.stopPropagation(); removeEdge(edge.id); });
      group.append(remove);
    }
    children.push(group);
  }
  if (temp) children.push(svg('path', { d: curve(temp.from, temp.to), class: `wf-edge-temp${temp.bad ? ' bad' : temp.good ? ' good' : ''}` }));
  edgesLayer.replaceChildren(...children);
}

function removeEdge(id) {
  if (locked()) return;
  wf.edges = wf.edges.filter((edge) => edge.id !== id);
  selected = null;
  renderBoard();
  scheduleSave();
}

function connect(from, to) {
  if (locked()) return;
  const check = canConnect(wf, from, to, connectRules);
  if (!check.ok) {
    toast(`接線失敗：${check.reason}`, 'bad');
    const element = nodeElements.get(to);
    element?.classList.add('flash-bad');
    setTimeout(() => element?.classList.remove('flash-bad'), 900);
    return;
  }
  wf.edges.push({ id: newId('e'), from, to });
  renderBoard(); // 步驟編號、順序控制、自動備註都會跟著變
  scheduleSave();
}

/** 拉線時：每張卡片標成可以接（綠）／不能接（紅），游標旁邊說明原因 */
const dragTip = h('div', { className: 'wf-drag-tip', hidden: true });
root.append(dragTip);
function markTargets(from) {
  for (const [id, element] of nodeElements) {
    if (id === from) { element.classList.add('drag-source'); continue; }
    const check = canConnect(wf, from, id, connectRules);
    element.classList.add(check.ok ? 'drop-ok' : 'drop-bad');
    element.dataset.reason = check.reason;
  }
}
function clearTargets() {
  for (const element of nodeElements.values()) {
    element.classList.remove('drop-ok', 'drop-bad', 'drag-source', 'drop-hover');
    delete element.dataset.reason;
  }
  dragTip.hidden = true;
}

const boardPoint = (event) => {
  const rect = board.getBoundingClientRect();
  return [(event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom];
};

/** 縮放到 next；anchor＝螢幕上要固定不動的點（雙指捏合的位置），沒給就用畫面中間 */
function setZoom(next, anchor) {
  const value = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  const rect = canvas.getBoundingClientRect();
  const [ax, ay] = anchor || [rect.left + canvas.clientWidth / 2, rect.top + canvas.clientHeight / 2];
  // 錨點在畫布上的座標（縮放前）
  const bx = (canvas.scrollLeft + ax - rect.left) / zoom; const by = (canvas.scrollTop + ay - rect.top) / zoom;
  zoom = value;
  applyZoom();
  sizeBoard();
  canvas.scrollLeft = bx * zoom - (ax - rect.left);
  canvas.scrollTop = by * zoom - (ay - rect.top);
}

function applyZoom() {
  board.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
  canvas.style.backgroundSize = `${22 * zoom}px ${22 * zoom}px`; // 點點格線跟著縮放
  zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
}

function fitAll() {
  if (!wf?.nodes.length) { setZoom(1); canvas.scrollTo(0, 0); return; }
  const x0 = Math.min(...wf.nodes.map((node) => node.x)) - 40; const y0 = Math.min(...wf.nodes.map((node) => node.y)) - 40;
  const x1 = Math.max(...wf.nodes.map((node) => node.x + (nodeElements.get(node.id)?.offsetWidth || NODE_WIDTH))) + 40;
  const y1 = Math.max(...wf.nodes.map((node) => node.y + (nodeElements.get(node.id)?.offsetHeight || 200))) + 40;
  const value = Math.max(ZOOM_MIN, Math.min(1, canvas.clientWidth / (x1 - x0), canvas.clientHeight / (y1 - y0)));
  zoom = value;
  applyZoom();
  sizeBoard();
  canvas.scrollLeft = Math.max(0, x0 * zoom - (canvas.clientWidth - (x1 - x0) * zoom) / 2);
  canvas.scrollTop = Math.max(0, y0 * zoom - (canvas.clientHeight - (y1 - y0) * zoom) / 2);
}

// 雙指捏合在其他地方（卡片庫、執行區、其他畫面）不要把整個視窗放大
document.addEventListener('wheel', (event) => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });

// 視窗大小改變：畫布要重新鋪滿可見範圍
new ResizeObserver(() => { if (wf) sizeBoard(); }).observe(canvas);

// 觸控板：雙指捏合＝縮放（瀏覽器送 ctrlKey＋wheel）；雙指滑動＝上下左右移動（一般捲動，交給瀏覽器）
canvas.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setZoom(zoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01)), [event.clientX, event.clientY]);
}, { passive: false });
root.querySelector('.wf-zoom').addEventListener('click', (event) => {
  const action = event.target.closest('[data-zoom]')?.dataset.zoom;
  if (action === 'in') setZoom(zoom * 1.2);
  if (action === 'out') setZoom(zoom / 1.2);
  if (action === 'reset') setZoom(1);
  if (action === 'fit') fitAll();
});

board.addEventListener('pointerdown', (event) => {
  const port = event.target.closest?.('.wf-port.out');
  if (port && locked()) { event.preventDefault(); return; }
  if (port) {
    event.preventDefault();
    event.stopPropagation();
    const from = port.dataset.id;
    board.setPointerCapture(event.pointerId);
    const start = portPoint(from, 'out');
    markTargets(from);
    let hover;
    const move = (moveEvent) => {
      const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.('.wf-node');
      if (hover && hover !== hit) hover.classList.remove('drop-hover');
      hover = hit && hit.dataset.id !== from ? hit : undefined;
      hover?.classList.add('drop-hover');
      const bad = hover?.classList.contains('drop-bad');
      renderEdges({ from: start, to: boardPoint(moveEvent), bad, good: hover && !bad });
      if (hover) {
        dragTip.hidden = false;
        dragTip.className = `wf-drag-tip ${bad ? 'bad' : 'good'}`;
        dragTip.textContent = bad ? `不能接：${hover.dataset.reason}` : '放開就接上';
        const rect = root.getBoundingClientRect();
        dragTip.style.left = `${moveEvent.clientX - rect.left + 14}px`;
        dragTip.style.top = `${moveEvent.clientY - rect.top + 14}px`;
      } else {
        dragTip.hidden = true;
      }
    };
    const end = (upEvent) => {
      board.removeEventListener('pointermove', move);
      board.releasePointerCapture?.(upEvent.pointerId);
      const hit = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
      const targetNode = hit?.closest?.('.wf-node');
      clearTargets();
      renderEdges();
      if (targetNode && targetNode.dataset.id !== from) connect(from, targetNode.dataset.id);
    };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', end, { once: true });
    return;
  }
  if (event.target === board || event.target === edgesLayer || event.target === sizer) {
    selected = null;
    markSelected();
  }
});

function attachNodeDrag(head, node, element) {
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (locked()) return;
    event.preventDefault();
    head.setPointerCapture(event.pointerId);
    const start = [event.clientX, event.clientY, node.x, node.y];
    element.classList.add('dragging');
    const move = (moveEvent) => {
      node.x = Math.max(0, Math.round(start[2] + (moveEvent.clientX - start[0]) / zoom));
      node.y = Math.max(0, Math.round(start[3] + (moveEvent.clientY - start[1]) / zoom));
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
      renderEdges();
    };
    const end = () => {
      head.removeEventListener('pointermove', move);
      element.classList.remove('dragging');
      sizeBoard();
      scheduleSave();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', end, { once: true });
    head.addEventListener('pointercancel', end, { once: true });
  });
}

board.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('application/x-wf-card')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
board.addEventListener('drop', (event) => {
  if (run.running) { event.preventDefault(); locked(); return; }
  const raw = event.dataTransfer.getData('application/x-wf-card');
  if (!raw) return;
  event.preventDefault();
  try {
    const { kind, id } = JSON.parse(raw);
    const [x, y] = boardPoint(event);
    addNode(kind, id, { x: x - NODE_WIDTH / 2, y: y - 20 });
  } catch {}
});

document.addEventListener('keydown', (event) => {
  if (root.hidden) return;
  if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); void close(); return; }
  if (!selected || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (locked()) { event.preventDefault(); return; }
  event.preventDefault();
  if (selected.type === 'edge') removeEdge(selected.id);
  else removeNode(selected.id);
});

// ── 執行 ──
function setRunning(running) {
  run.running = running;
  $('#wf-run').hidden = running;
  if (!running) runCheck();
  $('#wf-stop').hidden = !running;
  $('#wf-finish').hidden = !running;
  if (running) updateFinishButton();
  $('#wf-request').disabled = running;
  root.classList.toggle('wf-running', running);
  for (const id of ['#wf-select', '#wf-name', '#wf-new', '#wf-delete']) $(id).disabled = running;
  for (const button of root.querySelectorAll('.wf-from-here')) button.disabled = running;
  document.body.classList.toggle('is-running', running);
}

/** 流程檢查（每次修改後）：有開頭、有結尾、每張卡片都接在路上，才能執行 */
let checkTimer;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(runCheck, 150);
}
function runCheck() {
  if (!wf) return;
  const result = validateWorkflow(labelled(), { toolInfo });
  // 畫面是新版、主程式是舊版（只按了 ⌘R）：舊的主程式不懂新功能（例如「忽略」），不能執行
  if (catalog.engineVersion !== ENGINE_VERSION) {
    result.ok = false;
    result.errors = [{ nodeId: '', message: '主程式還是舊版（只重新整理了畫面）：請按 Ctrl+C 停掉，再執行 npm run poc:chatgpt-plan 完整重開，新功能才會生效。' }, ...result.errors];
  }
  const bad = new Set(result.errors.map((error) => error.nodeId).filter(Boolean));
  for (const [id, element] of nodeElements) element.classList.toggle('has-problem', bad.has(id));
  const box = $('#wf-check');
  box.className = `wf-check ${result.ok ? 'ok' : 'bad'}`;
  box.replaceChildren(
    h('strong', {}, result.ok ? '✓ 流程完整，可以執行' : `✗ 還不能執行（${result.errors.length} 個問題）`),
    ...(result.ok ? [h('small', {}, `會照這個順序一個一個做：${result.order.map((id) => wf.nodes.find((node) => node.id === id)).filter((node) => node && node.kind !== 'input').map((node) => nodeLabel(node)).join(' → ')}`)] : []),
    ...(!result.ok ? [h('ul', {}, ...result.errors.map((error) => h('li', {},
      error.nodeId ? h('button', { type: 'button', className: 'wf-link', onClick: () => focusNode(error.nodeId) }, '看卡片') : null, error.message)))] : []),
  );
  if (!run.running) $('#wf-run').disabled = !result.ok;
  return result;
}

function showProblems(problems) {
  $('#wf-problems').replaceChildren(...problems.map((problem) => h('li', {},
    problem.nodeId ? h('button', { type: 'button', className: 'wf-link', onClick: () => focusNode(problem.nodeId) }, `「${nodeLabel(wf.nodes.find((node) => node.id === problem.nodeId) || {})}」`) : null,
    problem.message)));
}

function focusNode(id) {
  const element = nodeElements.get(id);
  if (!element) return;
  selected = { type: 'node', id };
  markSelected();
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
}

function updateNodeStatus(id) {
  const element = nodeElements.get(id);
  const node = wf.nodes.find((item) => item.id === id);
  if (!element || !node) return;
  for (const status of Object.keys(STATUS_TEXT)) element.classList.toggle(`s-${status}`, run.status[id] === status);
  element.querySelector('.wf-node-status')?.replaceWith(statusLine(node));
}

// ── 執行紀錄（像終端機）：每一步送出的內容、AI 回覆的全文即時顯示 ──
const consoleRoot = $('#wf-console');
const consoleBody = $('#wf-console-body');
const consoleBlocks = new Map(); // 卡片 id → { block, head, body, started }
let consoleCount = 0; // 這次執行到第幾個
/** 這張卡片實際用哪個 AI（顯示在執行紀錄，分得出是哪一張） */
function runsWith(node) {
  const tool = node.kind === 'spirit' ? toolOf(spiritOf(node.spiritId)?.targetId) : toolOf(node.targetId);
  if (!tool) return node.kind === 'spirit' ? '精靈' : 'AI';
  const alt = node.runMode === 'background' && tool.backgroundAlt ? toolOf(tool.backgroundAlt) : undefined;
  return `用 ${(alt || tool).short}`;
}
const atBottom = () => consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 40;
let followFrame;
function follow(wasAtBottom) {
  if (!$('#wf-console-follow').checked || !wasAtBottom) return;
  cancelAnimationFrame(followFrame);
  followFrame = requestAnimationFrame(() => { consoleBody.scrollTop = consoleBody.scrollHeight; });
}
const clock = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });
function consoleLine(text, kind = '') {
  const bottom = atBottom();
  consoleBody.querySelector('.wf-console-empty')?.remove();
  consoleBody.append(h('div', { className: `wf-log-line ${kind}` }, text));
  follow(bottom);
}
function consoleBlock(id) {
  if (consoleBlocks.has(id)) return consoleBlocks.get(id);
  const node = wf.nodes.find((item) => item.id === id);
  const head = h('div', { className: 'wf-log-head' });
  const body = h('pre', { className: 'wf-log-body' });
  const block = h('div', { className: 'wf-log-step running' }, head, body);
  consoleCount += 1;
  const entry = { block, head, body, started: Date.now(), label: node ? nodeLabel(node) : id, step: consoleCount };
  head.textContent = `[${clock()}] ▶ 第 ${entry.step} 個執行・${entry.label}${node ? `（${runsWith(node)}）` : ''}`;
  const bottom = atBottom();
  consoleBody.querySelector('.wf-console-empty')?.remove();
  consoleBody.append(block);
  consoleBlocks.set(id, entry);
  follow(bottom);
  return entry;
}
function consoleEvent(event) {
  const node = wf.nodes.find((item) => item.id === event.id);
  if (event.type === 'node' && node?.kind === 'input') {
    if (event.status === 'done') {
      const files = node.files || [];
      consoleLine(`[${clock()}] ✎ 使用者輸入：${(event.text || '').slice(0, 300)}${(event.text || '').length > 300 ? '…' : ''}${files.length ? `\n   附件：${files.map((file) => file.path).join('、')}` : ''}`, 'muted');
    }
    return;
  }
  if (event.type === 'node') {
    if (event.status === 'waiting') return;
    if (event.status === 'done' && event.reused) { consoleLine(`[${clock()}] ↺ 沿用上一次的結果：${node ? nodeLabel(node) : event.id}（${(event.text || '').length} 字）`, 'muted'); return; }
    if (event.status === 'skipped') { consoleLine(`[${clock()}] ⤼ 跳過「${node ? nodeLabel(node) : event.id}」（前面的步驟沒有完成）`, 'muted'); return; }
    const entry = consoleBlock(event.id);
    if (event.status === 'running') return;
    const seconds = Math.round((Date.now() - entry.started) / 100) / 10;
    entry.block.classList.remove('running');
    const bottom = atBottom();
    if (event.status === 'done') {
      if (event.text && !entry.body.textContent.trim()) entry.body.textContent = event.text;
      entry.block.classList.add('done');
      entry.block.append(h('div', { className: 'wf-log-line ok' }, `✓ 完成（${seconds} 秒，${(event.text || '').length} 字）`));
    } else if (event.status === 'failed') {
      entry.block.classList.add('failed');
      entry.block.append(h('div', { className: 'wf-log-line bad' }, `✗ 失敗（${seconds} 秒）：${event.error || ''}`));
    }
    follow(bottom);
  } else if (event.type === 'prompt') {
    const entry = consoleBlock(event.id);
    entry.body.before(h('details', { className: 'wf-log-prompt' }, h('summary', {}, `送出的內容（${event.text.length} 字）`), h('pre', {}, event.text)));
  } else if (event.type === 'delta') {
    const entry = consoleBlock(event.id);
    const bottom = atBottom();
    entry.body.append(document.createTextNode(event.delta));
    follow(bottom);
  } else if (event.type === 'text') {
    const entry = consoleBlock(event.id);
    const bottom = atBottom();
    entry.body.textContent = event.text;
    follow(bottom);
  }
}
function setConsoleOpen(open) {
  consoleRoot.classList.toggle('collapsed', !open);
  $('#wf-console-toggle').textContent = open ? '收起 ▾' : '展開 ▴';
  try { localStorage.setItem('wf-console-open', open ? '1' : '0'); } catch {}
  $('#wf-console-toggle').setAttribute('aria-expanded', String(open));
}
$('#wf-console-toggle').addEventListener('click', () => setConsoleOpen(consoleRoot.classList.contains('collapsed')));
$('#wf-console-clear').addEventListener('click', () => { consoleBlocks.clear(); consoleBody.replaceChildren(h('div', { className: 'wf-console-empty' }, '已清除。')); });
$('#wf-console-copy').addEventListener('click', async (event) => {
  try { await navigator.clipboard.writeText(consoleBody.innerText); event.target.textContent = '已複製'; } catch { event.target.textContent = '複製失敗'; }
  setTimeout(() => { event.target.textContent = '複製全部'; }, 1500);
});
// 拖動上緣調整高度
$('#wf-console-grip').addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const grip = event.currentTarget;
  grip.setPointerCapture(event.pointerId);
  const startY = event.clientY; const startHeight = consoleRoot.getBoundingClientRect().height;
  setConsoleOpen(true);
  const move = (moveEvent) => {
    const height = Math.max(120, Math.min(window.innerHeight * 0.75, startHeight - (moveEvent.clientY - startY)));
    consoleRoot.style.height = `${Math.round(height)}px`;
  };
  const end = () => { grip.removeEventListener('pointermove', move); try { localStorage.setItem('wf-console-height', consoleRoot.style.height); } catch {} };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end, { once: true });
  grip.addEventListener('pointercancel', end, { once: true });
});
try { const saved = localStorage.getItem('wf-console-height'); if (saved) consoleRoot.style.height = saved; } catch {}
try { if (localStorage.getItem('wf-console-open') === '0') setConsoleOpen(false); } catch {}

let deltaFrame;
api.onEvent((event) => {
  if (!wf || !run.running) return;
  consoleEvent(event);
  if (event.type === 'node') {
    run.status[event.id] = event.status;
    queueMicrotask(updateFinishButton);
    if (event.text !== undefined) run.text[event.id] = event.text;
    if (event.status === 'running') run.text[event.id] = '';
    if (event.error) run.error[event.id] = event.error;
    if (event.status === 'done' && !run.order.includes(event.id)) run.order.push(event.id);
    // 每一步做完就存起來：下次可以從後面的步驟接著跑
    const doneNode = wf.nodes.find((item) => item.id === event.id);
    if (event.status === 'done' && doneNode && doneNode.kind !== 'input' && typeof event.text === 'string') { wf.lastRun.results[event.id] = event.text; scheduleSave(); }
    updateNodeStatus(event.id);
    renderEdges();
    renderResults();
  } else if (event.type === 'text') {
    run.text[event.id] = event.text;
    if (!/^（(等你停下|送出時畫面被切)/.test(event.text || '')) { run.sent ||= {}; run.sent[event.id] = true; }
    updateFinishButton();
    cancelAnimationFrame(deltaFrame);
    deltaFrame = requestAnimationFrame(() => updateNodeStatus(event.id));
  } else if (event.type === 'delta') {
    run.text[event.id] = (run.text[event.id] || '') + event.delta;
    cancelAnimationFrame(deltaFrame);
    deltaFrame = requestAnimationFrame(() => updateNodeStatus(event.id));
  }
});

async function startRun(fromId) {
  if (!wf || run.running) return;
  wf.lastRun ||= { request: '', results: {}, at: '' };
  // 從中間開始：問題沒填就用上一次的問題
  if (fromId && !$('#wf-request').value.trim() && wf.lastRun.request) $('#wf-request').value = wf.lastRun.request;
  const request = $('#wf-request').value.trim();
  if (!request) { showProblems([{ message: '請先輸入你的問題。' }]); $('#wf-request').focus(); return; }
  // 從某一步開始：執行順序在它前面、而且有上一次結果的步驟都沿用
  const reuse = {};
  const missing = [];
  if (fromId) {
    for (const id of executionOrder(activeFlow(wf))) {
      if (id === fromId) break;
      const node = wf.nodes.find((item) => item.id === id);
      if (!node || node.kind === 'input') continue;
      if (wf.lastRun.results[id]?.trim()) reuse[id] = wf.lastRun.results[id];
      else missing.push(nodeLabel(node));
    }
  }
  await saveNow();
  if (!runCheck().ok) return;
  const check = await api.validate(wf);
  if (!check.ok) { showProblems(check.errors); return; }
  showProblems([]);
  Object.assign(run, { status: {}, text: {}, error: {}, order: [] });
  lastOutputs = [];
  consoleBlocks.clear();
  consoleCount = 0;
  run.sent = {};
  setConsoleOpen(true);
  consoleLine(fromId ? `── ${clock()} 從「${nodeLabel(wf.nodes.find((node) => node.id === fromId))}」開始執行「${wf.name}」（前面 ${Object.keys(reuse).length} 步沿用上一次的結果）──` : `── ${clock()} 開始執行「${wf.name}」──`, 'rule');
  if (missing.length) consoleLine(`   注意：${missing.join('、')} 沒有上一次的結果，會重新執行`, 'muted');
  // 這次會重跑的步驟，上一次的結果先清掉；沿用的留著
  wf.lastRun = { request, results: Object.fromEntries(Object.entries(wf.lastRun.results).filter(([id]) => reuse[id])), at: new Date().toISOString() };
  $('#wf-console-state').textContent = '執行中…';
  setRunning(true);
  renderResults();
  const started = Date.now();
  try {
    const result = await api.run({ workflow: wf, request, reuse, engineVersion: ENGINE_VERSION });
    consoleLine(`── ${clock()} ${result.cancelled ? '已停止' : result.ok ? '全部完成' : '有步驟失敗'}（共 ${Math.round((Date.now() - started) / 1000)} 秒）──`, result.ok ? 'rule ok' : 'rule bad');
    $('#wf-console-state').textContent = result.cancelled ? '已停止' : result.ok ? '完成' : '有步驟失敗';
    lastOutputs = result.outputs || [];
    for (const output of lastOutputs) consoleLine(output.path ? `★ 成品「${output.title}」已做成檔案：${output.path}${output.warning ? `（${output.warning}）` : ''}` : `★ 成品「${output.title}」完成（自動存檔失敗，可以在右邊按「另存新檔」）`, 'ok');
    if (result.errors?.length) showProblems(result.errors);
    else if (result.error) showProblems([{ message: result.error }]);
    else if (result.cancelled) showProblems([{ message: '已停止。' }]);
  } catch (error) {
    showProblems([{ message: error.message || String(error) }]);
    consoleLine(`── ${clock()} 執行失敗：${error.message || error} ──`, 'rule bad');
    $('#wf-console-state').textContent = '失敗';
  } finally {
    setRunning(false);
    renderBoard(); // 卡片上「上一次的結果」換成這次的
    renderResults();
  }
}

function resultCard({ title, text, final, path, warning }) {
  const copy = h('button', { type: 'button', className: 'wf-button small', onClick: async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = '已複製'; } catch { copy.textContent = '複製失敗'; }
    setTimeout(() => { copy.textContent = '複製'; }, 1500);
  } }, '複製');
  return h('details', { className: `wf-result${final ? ' final' : ''}`, open: final || undefined },
    h('summary', {}, final ? `★ ${title}` : title),
    h('pre', {}, text),
    path ? h('p', { className: 'wf-saved-path', title: path }, `已自動存成：${path.split('/').slice(-2).join('/')}`) : null,
    warning ? h('p', { className: 'wf-warn wf-saved-warn' }, warning) : null,
    h('div', { className: 'wf-row' }, copy,
      path && bridge.wfOpenOutput ? h('button', { type: 'button', className: 'wf-button small', onClick: () => void bridge.wfOpenOutput({ path }) }, '打開') : null,
      path && bridge.wfOpenOutput ? h('button', { type: 'button', className: 'wf-button small', onClick: () => void bridge.wfOpenOutput({ path, reveal: true }) }, '在 Finder 顯示') : null,
      final ? h('button', { type: 'button', className: 'wf-button small', onClick: () => void api.saveOutput({ name: title, text }) }, '另存新檔') : null));
}

function renderResults() {
  const finals = lastOutputs.map((output) => resultCard({ title: output.title, text: output.text, final: true, path: output.path, warning: output.warning }));
  const steps = run.order
    .map((id) => wf.nodes.find((node) => node.id === id))
    .filter((node) => node && node.kind !== 'input' && !(node.end && lastOutputs.some((output) => output.id === node.id)))
    .map((node) => resultCard({ title: nodeLabel(node), text: run.text[node.id] || '' }));
  $('#wf-results').replaceChildren(
    ...(finals.length ? [h('h3', {}, '成品'), ...finals] : []),
    ...(steps.length ? [h('h3', {}, '每一步的結果'), ...steps] : []),
  );
}

function showResult(id) {
  const node = wf.nodes.find((item) => item.id === id);
  if (!node) return;
  const entry = consoleBlocks.get(id);
  if (entry) { setConsoleOpen(true); entry.block.scrollIntoView({ block: 'start', behavior: 'smooth' }); entry.block.classList.add('flash'); setTimeout(() => entry.block.classList.remove('flash'), 1200); return; }
  const index = run.order.indexOf(id);
  const cards = [...$('#wf-results').querySelectorAll('details')];
  const match = cards.find((card) => card.querySelector('summary')?.textContent.replace(/^★ /, '') === nodeLabel(node));
  if (match) { match.open = true; match.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  else if (index < 0) toast('這一步還沒有結果。');
}

$('#wf-run').addEventListener('click', () => void startRun());
$('#wf-stop').addEventListener('click', () => void api.cancel());
// 「用目前讀到的內容完成這一步」：只對「正在跑、已經送出去在等回覆」的那一步有效（按晚了不會跳過下一步）
const runningId = () => Object.keys(run.status).find((id) => run.status[id] === 'running');
function updateFinishButton() {
  const button = $('#wf-finish');
  const id = runningId();
  const node = id && wf?.nodes.find((item) => item.id === id);
  button.disabled = !node || !run.sent?.[id];
  button.textContent = node ? `⏭ 用目前讀到的內容完成「${nodeLabel(node)}」` : '⏭ 用目前讀到的內容完成這一步';
  button.title = !node ? '' : run.sent?.[id] ? '操作 App 的步驟不限時間等回覆；AI 已經回完、但沒有照格式交件時，按這個用目前讀到的內容繼續' : '這一步還在送出中（或是背景執行的 AI，會自己結束），送出後才能按';
}
$('#wf-finish').addEventListener('click', async () => {
  if (!bridge.wfFinishStep) { toast('請重新啟動小精靈才能用這個按鈕。', 'bad'); return; }
  const id = runningId();
  if (!id) return;
  const result = await bridge.wfFinishStep(id).catch(() => ({ ok: false }));
  const node = wf.nodes.find((item) => item.id === id);
  consoleLine(result?.ok ? `[${clock()}] ⏭ 你按了：用目前讀到的內容完成「${node ? nodeLabel(node) : id}」` : `[${clock()}] ⏭ 這一步已經結束了，沒有作用`, 'muted');
});

// ── 工作流清單 ──
function renderSelect() {
  const select = $('#wf-select');
  select.replaceChildren(...workflows.map((item) => h('option', { value: item.id, selected: item.id === wf?.id }, item.name)));
}

async function openWorkflow(id) {
  if (run.running) return;
  await saveNow();
  wf = await api.get(id);
  Object.assign(run, { status: {}, text: {}, error: {}, order: [] });
  lastOutputs = [];
  selected = null;
  $('#wf-name').value = wf.name;
  showProblems([]);
  renderSelect();
  renderLibrary();
  renderBoard();
  renderResults();
}

$('#wf-select').addEventListener('change', (event) => void openWorkflow(event.target.value));
$('#wf-name').addEventListener('input', (event) => { if (!wf) return; wf.name = event.target.value.slice(0, 60) || '未命名的工作流'; scheduleSave(); });
$('#wf-new').addEventListener('click', async () => {
  if (run.running) return;
  await saveNow();
  wf = starter(`新的工作流 ${workflows.length + 1}`);
  workflows.unshift({ id: wf.id, name: wf.name });
  await saveNow();
  await openWorkflow(wf.id);
  $('#wf-name').select();
});
$('#wf-delete').addEventListener('click', async () => {
  if (!wf || run.running) return;
  if (!window.confirm(`要刪除「${wf.name}」嗎？刪除後無法復原。`)) return;
  clearTimeout(saveTimer);
  await api.remove(wf.id);
  workflows = workflows.filter((item) => item.id !== wf.id);
  wf = undefined;
  if (!workflows.length) { wf = starter('我的第一條工作流'); await saveNow(); workflows = await api.list(); }
  await openWorkflow(wf?.id || workflows[0].id);
});

let toastTimer;
function toast(message, kind = '') {
  let element = root.querySelector('.wf-toast');
  if (!element) { element = h('div', { className: 'wf-toast', role: 'status' }); root.append(element); }
  element.textContent = message;
  element.classList.toggle('bad', kind === 'bad');
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
}

window.addEventListener('focus', async () => {
  // 回到視窗時更新精靈和 AI 清單（可能剛連接 AI）
  if (root.hidden || run.running) return;
  try { catalog = await api.catalog(); renderLibrary(); if (wf) renderBoard(); } catch {}
});

let started = false;
async function open() {
  root.hidden = false;
  try { await bridge.labWindow('open-wide'); } catch {}
  try {
    catalog = await api.catalog();
    if (!started) {
      started = true;
      workflows = await api.list();
      if (!workflows.length) {
        wf = starter('我的第一條工作流');
        await saveNow();
        workflows = await api.list();
      }
      await openWorkflow(wf?.id || workflows[0].id);
    } else {
      renderLibrary();
      renderBoard();
    }
  } catch (error) {
    showProblems([{ message: `工作流載入失敗：${error.message || error}` }]);
  }
  $('[data-action="back"]').focus({ preventScroll: true });
}

async function close({ keepWindow = false } = {}) {
  await saveNow();
  root.hidden = true;
  if (!keepWindow) { try { await bridge.labWindow('close'); } catch {} }
  onClose();
}

$('[data-action="back"]').addEventListener('click', () => void close());
$('[data-action="lab"]').addEventListener('click', async () => { await close({ keepWindow: true }); onSwitchLab(); });

return { open, close, isOpen: () => !root.hidden };
}
