// 工作流連接器：資料格式、接線規則、檢查、組提示詞、照順序一步一步執行。
// 只負責「算」：實際呼叫 AI／精靈、貼到 App 由呼叫端傳進來（deps），所以可以用假資料完整測試。
//
// 卡片（node）三種：
//   input  使用者輸入：起點，整條工作流只能有一張，不能被接
//   spirit 精靈：用這隻精靈的設定（角色、限制、SOP、記憶）和牠指定的 AI 回答
//   tool   AI 工具：直接用某個已串接的 AI，可以寫「收到資料時要做什麼」
// 結尾（成品）：不是另一張卡片，而是把某一張精靈／AI 工具卡片標成「成品」（end: true）。
//   可以有好幾張成品卡片（好幾個結尾、好幾份成品）；成品卡片後面不能再接；多接一時，由它（那個 AI 或精靈）把前面幾份結果整合成一個成品。
// 連線（edge）：from → to，代表 from 的結果交給 to。可以一接多（分岔）、多接一（合併）。
// 執行是一個一個來：每張卡片有 seq（排序值），分岔／合併時，使用者調整的就是這幾張卡片的 seq；
// 真正的執行順序＝「前面都做完了」的卡片裡，seq 最小的先做（executionOrder）。

// 執行在主程式（main），畫面在視窗：只按 ⌘R 重新整理畫面時，主程式還是舊版。兩邊版本不同就不讓執行，請使用者完整重開
export const ENGINE_VERSION = '2026-11-26.4';
export const NODE_KINDS = ['input', 'spirit', 'tool'];
// 成品要存成的檔案類型（成品卡片上選）：AI 一律寫 Markdown，交件後由小精靈轉成這個格式
export const OUTPUT_FORMATS = ['md', 'docx', 'pdf', 'pptx', 'xlsx', 'html'];
const FORMAT_HINT = {
  md: '成品會存成 Markdown（.md）：請用 Markdown 寫（# 標題、## 小節、條列、表格）。',
  docx: '成品會做成 Word 文件：請用 Markdown 寫（# 文件標題、## 小節、條列、表格），不要用 HTML。',
  pdf: '成品會做成 PDF：請用 Markdown 寫（# 標題、## 小節、條列、表格），不要用 HTML。',
  html: '成品會做成網頁（HTML）：請用 Markdown 寫（# 標題、## 小節、條列、表格），小精靈會自動排版成網頁。',
  pptx: '成品會做成 PowerPoint 簡報：請用 Markdown 寫，第一行「# 簡報標題」；每一張投影片用「## 投影片標題」開頭，下面放 3～6 個簡短的條列重點（每點一行）；需要比較時用 Markdown 表格。',
  xlsx: '成品會做成 Excel 試算表：請把資料整理成 Markdown 表格（第一列是欄位名稱），每個表格前面用「## 工作表名稱」；數字欄不要夾文字（單位寫在欄位名稱裡）。',
};
export const MAX_NODES = 40;
export const MAX_NOTE = 2000;
const WORK = new Set(['spirit', 'tool']);

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
const idOf = (value) => (typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : '');
export const MAX_FILES = 20;
/** 附件：[{ path（絕對路徑）, kind: 'file'|'dir' }] */
export function cleanFiles(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((item) => ({ path: text(item?.path, 1000), kind: item?.kind === 'dir' ? 'dir' : 'file' }))
    .filter((item) => item.path.startsWith('/') && !item.path.includes('\0') && !seen.has(item.path) && seen.add(item.path))
    .slice(0, MAX_FILES);
}

export function newId(prefix = 'n') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const MAX_RESULT = 200_000;
/** 每一步的結果：只留現在還在的工作卡片、每份最多 20 萬字 */
export function cleanResults(raw, nodes) {
  const ids = new Set(nodes.filter((node) => WORK.has(node.kind)).map((node) => node.id));
  const result = {};
  if (raw && typeof raw === 'object') for (const [id, value] of Object.entries(raw)) if (ids.has(id) && typeof value === 'string') result[id] = value.slice(0, MAX_RESULT);
  return result;
}

/** 清理存檔內容（從檔案或畫面來的都不信任）；不合規則的線直接丟掉 */
export function sanitizeWorkflow(raw = {}) {
  const nodes = [];
  const seen = new Set();
  let hasInput = false;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, MAX_NODES) : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges.slice(0, MAX_NODES * 4) : [];
  // 舊版存檔的「成品」卡片：只接了一張卡片的，改成把那張標成成品；接了好幾張的，請使用者自己選一張整合
  const legacyEnds = new Set();
  for (const legacy of rawNodes.filter((node) => node?.kind === 'output')) {
    const sources = rawEdges.filter((edge) => edge?.to === legacy.id).map((edge) => edge.from);
    const onlyEndsHere = sources.length === 1 && !rawEdges.some((edge) => edge?.from === sources[0] && edge.to !== legacy.id);
    if (onlyEndsHere) legacyEnds.add(sources[0]);
  }
  for (const [index, node] of rawNodes.entries()) {
    const id = idOf(node?.id);
    const kind = NODE_KINDS.includes(node?.kind) ? node.kind : '';
    if (!id || !kind || seen.has(id)) continue;
    if (kind === 'input') { if (hasInput) continue; hasInput = true; }
    seen.add(id);
    const end = WORK.has(kind) && (node.end === true || legacyEnds.has(id));
    nodes.push({
      id, kind,
      x: Math.max(0, Math.min(6000, number(node.x, 40))),
      y: Math.max(0, Math.min(4000, number(node.y, 40))),
      seq: number(node.seq, (index + 1) * 10),
      ...(kind === 'spirit' ? { spiritId: text(node.spiritId, 80) } : {}),
      ...(kind === 'tool' ? { targetId: text(node.targetId, 60), model: text(node.model, 120), returnMode: node.returnMode === 'file' ? 'file' : '' } : {}),
      // 執行方式：app＝用你選的那個 AI（例如 Claude 桌面 App）；background＝改用同一個帳號的背景版本（例如 Claude Code），不搶畫面
      ...(WORK.has(kind) ? { note: text(node.note, MAX_NOTE), end, endTitle: end ? text(node.endTitle, 60) : '', runMode: node.runMode === 'background' ? 'background' : 'app' } : {}),
      ...(end ? { outputFormat: OUTPUT_FORMATS.includes(node.outputFormat) ? node.outputFormat : 'md' } : {}),
      files: cleanFiles(node.files),
      // 忽略：卡片和接線都留著，但檢查、執行時當作不存在（暫時不用的卡片）
      ...(WORK.has(kind) && node.ignored === true ? { ignored: true } : {}),
    });
  }
  const flow = { nodes, edges: [] };
  for (const edge of rawEdges) {
    const from = idOf(edge?.from); const to = idOf(edge?.to);
    if (!canConnect(flow, from, to).ok) continue;
    flow.edges.push({ id: idOf(edge.id) || newId('e'), from, to });
  }
  // 上一次執行每一步的結果（可以從中間某一步接著跑、也可以手動改）
  const lastRun = { request: text(raw.lastRun?.request, 20_000), results: cleanResults(raw.lastRun?.results, nodes), at: text(raw.lastRun?.at, 40) };
  return {
    id: idOf(raw.id) || newId('wf'),
    name: text(raw.name, 60).trim() || '未命名的工作流',
    lastRun,
    nodes: flow.nodes, edges: flow.edges,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : new Date().toISOString(),
  };
}

/** 去掉「忽略」的卡片和接到它們的線（檢查、執行只看這些） */
export function activeFlow(workflow) {
  const nodes = workflow.nodes.filter((node) => !node.ignored);
  const ids = new Set(nodes.map((node) => node.id));
  return { ...workflow, nodes, edges: workflow.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
}

/** 加上 from → to 會不會繞成一圈（to 已經走得到 from） */
export function createsCycle(edges, from, to) {
  const next = new Map();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) || []), edge.to]);
  const stack = [to]; const visited = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === from) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(next.get(id) || []));
  }
  return false;
}

/**
 * 接線規則：能不能從 from 接到 to。畫面拖線時用來把卡片標成可以接（綠）／不能接（紅）並說明原因。
 * canReturn(node) → false 代表這張卡片拿不回結果（只會貼到 App），後面只能接成品。
 */
export function canConnect(workflow, from, to, { canReturn = () => true } = {}) {
  const source = workflow.nodes.find((node) => node.id === from);
  const target = workflow.nodes.find((node) => node.id === to);
  if (!source || !target) return { ok: false, reason: '找不到卡片。' };
  if (from === to) return { ok: false, reason: '不能接到自己。' };
  if (source.end) return { ok: false, reason: '這張卡片是「成品」（結尾），後面不能再接。要接下去，先取消它的成品標記。' };
  if (target.kind === 'input') return { ok: false, reason: '「使用者輸入」一定是第一步，不能接到它。' };
  if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) return { ok: false, reason: '這兩張卡片已經接過了。' };
  if (workflow.edges.some((edge) => edge.from === to && edge.to === from)) return { ok: false, reason: '已經有反方向的線，兩張卡片不能互相接。' };
  if (createsCycle(workflow.edges, from, to)) return { ok: false, reason: '這條線會讓流程繞回前面（變成無限循環）。' };
  if (WORK.has(source.kind) && canReturn(source) === false) {
    return { ok: false, reason: '這張卡片的 AI 拿不回結果（只會貼到 App），後面不能再接；它只能當最後的成品。' };
  }
  return { ok: true, reason: '' };
}

const bySeq = (a, b) => (a.seq - b.seq) || a.id.localeCompare(b.id);
export const upstreamOf = (workflow, id) => workflow.edges.filter((edge) => edge.to === id).map((edge) => workflow.nodes.find((node) => node.id === edge.from)).filter(Boolean).sort(bySeq);
export const downstreamOf = (workflow, id) => workflow.edges.filter((edge) => edge.from === id).map((edge) => workflow.nodes.find((node) => node.id === edge.to)).filter(Boolean).sort(bySeq);

/** a 是不是 b 的上游（b 要等 a 的結果） */
export function isAncestor(workflow, a, b) {
  const stack = [a]; const visited = new Set();
  while (stack.length) {
    const id = stack.pop();
    for (const next of downstreamOf(workflow, id)) {
      if (next.id === b) return true;
      if (!visited.has(next.id)) { visited.add(next.id); stack.push(next.id); }
    }
  }
  return false;
}

/**
 * 把一張精靈／AI 工具卡片標成成品（結尾），或取消（on=false）。可以有好幾張成品。
 * 後面還有接線的卡片不能標（成品後面不能再接）。回傳 { ok, reason, workflow }
 */
export function setEnd(workflow, id, on = true) {
  const node = workflow.nodes.find((item) => item.id === id);
  if (!node || !WORK.has(node.kind)) return { ok: false, reason: '只有精靈或 AI 工具卡片可以當成品。' };
  if (on && workflow.edges.some((edge) => edge.from === id)) return { ok: false, reason: '這張卡片後面還有接線；成品是結尾，請先把它後面的線拿掉。' };
  return { ok: true, reason: '', workflow: { ...workflow, nodes: workflow.nodes.map((item) => (item.id === id ? { ...item, end: Boolean(on) } : item)) } };
}

/**
 * 一個一個執行的順序：前面的卡片都做完了才輪到它；同時輪得到好幾張時，seq 小的先做。
 * 回傳卡片 id 陣列（含使用者輸入與成品）。
 */
export function executionOrder(workflow) {
  const indegree = new Map(workflow.nodes.map((node) => [node.id, 0]));
  for (const edge of workflow.edges) indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  const ready = workflow.nodes.filter((node) => !indegree.get(node.id));
  const order = [];
  while (ready.length) {
    ready.sort(bySeq);
    const node = ready.shift();
    order.push(node.id);
    for (const next of downstreamOf(workflow, node.id)) {
      indegree.set(next.id, indegree.get(next.id) - 1);
      if (indegree.get(next.id) === 0) ready.push(next);
    }
  }
  return order;
}

/** 每張精靈／AI 工具卡片是第幾步（畫面上的「第 N 步」）；沒接上流程的不編號 */
export function stepNumbers(allCards) {
  const workflow = activeFlow(allCards); // 忽略的卡片沒有步驟編號
  const steps = {};
  let count = 0;
  for (const id of executionOrder(workflow)) {
    const node = workflow.nodes.find((item) => item.id === id);
    if (WORK.has(node.kind) && upstreamOf(workflow, id).length) steps[id] = ++count;
  }
  return steps;
}

/**
 * 調整分岔／合併的順序：把 id 在同一組（siblings）裡往前（-1）或往後（+1）移一格。
 * 兩張卡片有先後依賴（一張要等另一張的結果）時不能對調。回傳 { ok, reason, workflow }
 */
export function moveInOrder(workflow, siblings, id, direction) {
  const list = [...siblings].sort(bySeq);
  const index = list.findIndex((node) => node.id === id);
  const other = list[index + direction];
  if (index < 0 || !other) return { ok: false, reason: '已經是第一個或最後一個了。' };
  const node = list[index];
  if (isAncestor(workflow, node.id, other.id) || isAncestor(workflow, other.id, node.id)) {
    return { ok: false, reason: '這兩張卡片有先後關係（其中一張要等另一張的結果），順序不能對調。' };
  }
  // 依目前的順序重新編號，再對調這兩張
  const nodes = workflow.nodes.map((item) => ({ ...item }));
  [...nodes].sort(bySeq).forEach((item, position) => { item.seq = (position + 1) * 10; });
  const a = nodes.find((item) => item.id === node.id); const b = nodes.find((item) => item.id === other.id);
  [a.seq, b.seq] = [b.seq, a.seq];
  return { ok: true, reason: '', workflow: { ...workflow, nodes } };
}

/**
 * 沒寫「收到資料時要做什麼」時的預設做法：
 *   只接使用者輸入 → 直接執行使用者的命令
 *   接了精靈／AI 工具的結果 → 拿著這些結果和使用者的要求做分析
 */
export function autoNote(workflow, node) {
  const sources = upstreamOf(workflow, node.id);
  const fromWork = sources.filter((source) => WORK.has(source.kind));
  if (node.end) {
    // 成品卡片：多接一時把前面幾份結果整合成一個成品
    if (!fromWork.length) return '直接執行使用者的命令，產出最後的成品。';
    if (fromWork.length === 1) return `拿著「${labelHint(fromWork[0])}」交過來的結果，配合使用者的要求，完成最後的成品。`;
    return `把 ${fromWork.map((source) => `「${labelHint(source)}」`).join('、')} 交過來的 ${fromWork.length} 份結果整合成一份完整的成品，配合使用者的要求；內容重複的合併、互相矛盾的指出來。`;
  }
  if (!fromWork.length) return '直接執行使用者的命令。';
  if (fromWork.length === 1) return `拿著「${labelHint(fromWork[0])}」交過來的結果，配合使用者的要求進行分析，完成使用者要的東西。`;
  return `依序把 ${fromWork.map((source) => `「${labelHint(source)}」`).join('、')} 交過來的結果整合起來，配合使用者的要求進行分析，完成使用者要的東西。`;
}

/** 卡片在提示詞裡的稱呼（真正的名字由呼叫端放在 node._label） */
function labelHint(node) {
  return node._label || (node.kind === 'spirit' ? '精靈' : node.kind === 'tool' ? 'AI 工具' : '上一步');
}

/** 組這張卡片要送出的提示詞（多接一時，前面的結果照使用者設定的順序排） */
/** 這張卡片要帶的附件：使用者在問題附上的（整條工作流共用）＋這張卡片自己的 */
export function attachmentsFor(workflow, node) {
  const input = workflow.nodes.find((item) => item.kind === 'input');
  return cleanFiles([...(input?.files || []), ...(node.kind === 'input' ? [] : node.files || [])]);
}

export function attachmentText(files) {
  if (!files.length) return '';
  return `附上的檔案和資料夾（請直接讀取這些路徑的內容來回答）：\n${files.map((file) => `- ${file.path}${file.kind === 'dir' ? '（資料夾）' : ''}`).join('\n')}`;
}

export function composePrompt({ workflow, node, request, results }) {
  const sources = upstreamOf(workflow, node.id);
  const fromWork = sources.filter((source) => source.kind !== 'input' && results[source.id] !== undefined);
  const task = (node.note || '').trim() || autoNote(workflow, node);
  const files = attachmentText(attachmentsFor(workflow, node));
  const blocks = fromWork.map((source, index) => `── 第 ${index + 1} 份：來自「${labelHint(source)}」的結果 ──\n${results[source.id]}`);
  return [
    `使用者的要求：\n${request}`,
    files,
    blocks.length ? `前面步驟交過來的結果：\n\n${blocks.join('\n\n')}` : '',
    `你這一步要做的事：\n${task}`,
    node.end ? FORMAT_HINT[node.outputFormat] || FORMAT_HINT.md : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * 檢查能不能執行。toolInfo(node) → { label, canReturn, available, reason }（呼叫端提供）
 * 規則：一定要有開頭（使用者輸入）和結尾（標成成品的那張卡片）；每張卡片都要接在「使用者輸入 → … → 成品」的路上。
 * 回傳 { ok, errors: [{ nodeId, message }], order: [id…]（一個一個執行的順序） }
 */
export function validateWorkflow(allCards, { toolInfo = () => ({ canReturn: true, available: true }) } = {}) {
  const workflow = activeFlow(allCards);
  const errors = [];
  const add = (nodeId, message) => errors.push({ nodeId, message });
  const nameOf = (node) => toolInfo(node)?.label || labelHint(node);
  const input = workflow.nodes.find((node) => node.kind === 'input');
  const work = workflow.nodes.filter((node) => WORK.has(node.kind));
  const ends = work.filter((node) => node.end);
  if (!input) add('', '沒有開頭：請放一張「使用者輸入」卡片，它一定是第一步。');
  if (!work.length) add('', '中間至少要有一個精靈或 AI 工具。');
  if (work.length && !ends.length) add('', '沒有結尾：請在最後一張精靈或 AI 卡片上按「★ 設為成品」，它的結果就是最後的成品。');
  if (input && !downstreamOf(workflow, input.id).length) add(input.id, '「使用者輸入」還沒有接到任何卡片。');

  // 從開頭走得到的卡片、走得到成品的卡片
  const reach = new Set();
  if (input) {
    const stack = [input.id]; reach.add(input.id);
    while (stack.length) for (const next of downstreamOf(workflow, stack.pop())) if (!reach.has(next.id)) { reach.add(next.id); stack.push(next.id); }
  }
  const toEnd = new Set(ends.map((node) => node.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of workflow.edges) if (toEnd.has(edge.to) && !toEnd.has(edge.from)) { toEnd.add(edge.from); grew = true; }
  }
  for (const node of work) {
    const info = toolInfo(node) || {};
    if (node.kind === 'spirit' && !node.spiritId) add(node.id, '這張精靈卡片還沒選精靈。');
    if (node.kind === 'tool' && !node.targetId) add(node.id, '這張 AI 工具卡片還沒選 AI。');
    if (info.available === false) add(node.id, `「${nameOf(node)}」目前不能用（${info.reason || '未啟用'}）。`);
    const connected = upstreamOf(workflow, node.id).length || downstreamOf(workflow, node.id).length;
    if (!connected) { add(node.id, `「${nameOf(node)}」沒有接上流程：請接在使用者輸入和成品之間，或刪掉它。`); continue; }
    if (input && !reach.has(node.id)) add(node.id, `「${nameOf(node)}」從「使用者輸入」走不到：前面要接上。`);
    if (ends.length && !toEnd.has(node.id)) add(node.id, `「${nameOf(node)}」的結果沒有走到任何一張成品卡片：後面要接上，或把它設為成品。`);
    if (node.end && downstreamOf(workflow, node.id).length) add(node.id, '成品是結尾，後面不能再接。');
    if (info.canReturn === false && !node.end) add(node.id, `「${nameOf(node)}」拿不回結果（只會貼到 App），只能當最後的成品。`);
  }
  return { ok: !errors.length, errors, order: executionOrder(workflow) };
}

/**
 * 執行（一個一個來，照 executionOrder）。deps：
 *   label(node) → 顯示名稱（放進提示詞的「來自誰」）
 *   run(node, { prompt, signal, onDelta, onText }) → Promise<string>
 * onEvent({ type: 'node', id, status: 'waiting'|'running'|'done'|'failed'|'skipped', text?, error? }) ／ { type: 'delta', id, delta } ／ { type: 'text', id, text }
 * 回傳 { ok, results, outputs: [{ id, title, text }], errors, cancelled }
 */
/** reuse：{ 卡片 id: 結果 }，這些卡片不重跑、直接用這份結果（從中間某一步接著跑） */
export async function runWorkflow({ workflow: allCards, request, deps, onEvent = () => {}, signal, reuse = {} }) {
  const workflow = activeFlow(allCards); // 忽略的卡片不執行
  if (typeof request !== 'string' || !request.trim()) throw new Error('請先輸入問題。');
  const nodes = new Map(workflow.nodes.map((node) => [node.id, { ...node, _label: deps.label ? deps.label(node) : '' }]));
  const flow = { ...workflow, nodes: [...nodes.values()] };
  const results = {};
  const failed = new Set();
  const errors = [];
  const outputs = [];
  for (const node of flow.nodes) onEvent({ type: 'node', id: node.id, status: 'waiting' });

  for (const id of executionOrder(flow)) {
    if (signal?.aborted) break;
    const node = nodes.get(id);
    const sources = upstreamOf(flow, id);
    if (node.kind === 'input') {
      results[id] = request;
      onEvent({ type: 'node', id, status: 'done', text: request });
      continue;
    }
    // 前面有失敗或沒跑到 → 這張跳過
    if (!sources.length || sources.some((source) => failed.has(source.id) || results[source.id] === undefined)) {
      failed.add(id);
      onEvent({ type: 'node', id, status: 'skipped' });
      continue;
    }
    if (typeof reuse[id] === 'string' && reuse[id].trim()) {
      results[id] = reuse[id].trim();
      if (node.end) outputs.push({ id, title: node.endTitle || `成品：${node._label || '未命名'}`, text: results[id], format: node.outputFormat || 'md' });
      onEvent({ type: 'node', id, status: 'done', text: results[id], reused: true });
      continue;
    }
    onEvent({ type: 'node', id, status: 'running' });
    try {
      const prompt = composePrompt({ workflow: flow, node, request, results });
      onEvent({ type: 'prompt', id, text: prompt });
      const reply = await deps.run(node, {
        prompt, signal, attachments: attachmentsFor(flow, node),
        onDelta: (delta) => onEvent({ type: 'delta', id, delta }),
        onText: (value) => onEvent({ type: 'text', id, text: value }), // 讀 App 畫面時，整段換掉（不是一段段接上）
      });
      if (signal?.aborted) throw new Error('已停止。');
      results[id] = String(reply ?? '').trim();
      if (node.end) outputs.push({ id, title: node.endTitle || `成品：${node._label || '未命名'}`, text: results[id], format: node.outputFormat || 'md' });
      onEvent({ type: 'node', id, status: 'done', text: results[id] });
    } catch (error) {
      failed.add(id);
      const message = signal?.aborted ? '已停止。' : (error instanceof Error ? error.message : String(error));
      errors.push({ nodeId: id, message });
      onEvent({ type: 'node', id, status: 'failed', error: message });
    }
  }
  return { ok: !errors.length && !signal?.aborted, results, outputs, errors, cancelled: Boolean(signal?.aborted) };
}
