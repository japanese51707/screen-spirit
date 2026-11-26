// 工作流（主視窗裡的一個畫面）：IPC、執行時把每張卡片的進度送回畫面。
// 實際呼叫 AI 的部分由 main.mjs 傳進來（catalog、runNode），這裡不碰金鑰或登入。
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanResults, ENGINE_VERSION, runWorkflow, sanitizeWorkflow, validateWorkflow } from './workflow-engine.mjs';
import { createWorkflowStore } from './workflow-store.mjs';

/**
 * @param handle  main.mjs 的 handle(channel, action)：只接受主視窗送來的請求
 * @param send    把執行進度送到主視窗
 */
export function setupWorkflow({ app, dialog, shell, htmlToPdf, diagnostics = () => {}, catalog, runNode, handle, send = () => {}, getWindow = () => undefined, onRunEnd = () => {}, finishStep = () => {} }) {
  const store = createWorkflowStore(join(app.getPath('userData'), 'workflows'));
  let controller;

  /** 卡片在提示詞和畫面上的名字、能不能拿回結果、能不能用 */
  async function describe() {
    const info = await catalog();
    const tools = new Map(info.tools.map((tool) => [tool.id, tool]));
    const spirits = new Map(info.spirits.map((spirit) => [spirit.id, spirit]));
    const label = (node) => {
      if (node.kind === 'input') return '使用者輸入';
      if (node.kind === 'output') return node.title || '成品';
      if (node.kind === 'spirit') return spirits.get(node.spiritId)?.name || '精靈';
      const tool = tools.get(node.targetId);
      return tool ? `${tool.short || tool.label}${node.model ? ` · ${node.model}` : ''}` : 'AI 工具';
    };
    const toolInfo = (node) => {
      if (node.kind === 'spirit') {
        const spirit = spirits.get(node.spiritId);
        if (!spirit) return { label: '精靈', available: !node.spiritId, reason: '找不到這隻精靈', canReturn: true };
        return { label: spirit.name, available: spirit.available, reason: spirit.reason, canReturn: spirit.canReturn };
      }
      const tool = tools.get(node.targetId);
      if (!tool) return { label: 'AI 工具', available: !node.targetId, reason: '找不到這個 AI', canReturn: true };
      return { label: label(node), available: tool.available, reason: tool.reason, canReturn: tool.canReturn };
    };
    return { info, label, toolInfo };
  }

  const outputRoot = () => join(app.getPath('documents'), 'Screen Spirit 成品');
  const safe = (value, fallback) => String(value || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || fallback;
  /** 成品轉成使用者選的檔案類型（AI 寫的是 Markdown）；轉檔失敗就存 .md，不讓成品不見 */
  async function saveOutputFile(workflowName, output) {
    const folder = join(outputRoot(), safe(workflowName, '工作流'));
    await mkdir(folder, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const title = output.title.replace(/^成品：/, '');
    const base = join(folder, `${stamp}-${safe(title, '成品')}`);
    const text = `${output.text.trim()}\n`;
    const format = output.format || 'md';
    if (format !== 'md') {
      try {
        const office = await import('./office-export.mjs'); // 很大（含 Word／Excel／PowerPoint 的程式庫），用到才載入
        let data;
        if (format === 'docx') data = await office.toDocx(text, { title });
        else if (format === 'xlsx') data = await office.toXlsx(text);
        else if (format === 'pptx') data = await office.toPptx(text, { title });
        else if (format === 'html') data = office.toHtml(text, { title });
        else if (format === 'pdf') {
          if (!htmlToPdf) throw new Error('這個版本不能存 PDF');
          data = await htmlToPdf(office.toHtml(text, { title }));
        }
        if (data) { await writeFile(`${base}.${format}`, data); return { path: `${base}.${format}` }; }
      } catch (error) {
        diagnostics(`工作流：成品轉成 ${format} 失敗（${error.message}），改存 Markdown`);
        await writeFile(`${base}.md`, text, 'utf8');
        return { path: `${base}.md`, warning: `轉成 ${format.toUpperCase()} 失敗（${error.message}），先存成 Markdown` };
      }
    }
    await writeFile(`${base}.md`, text, 'utf8');
    return { path: `${base}.md` };
  }

  handle('wf-catalog', async () => ({ ...(await catalog()), engineVersion: ENGINE_VERSION }));
  handle('wf-list', () => store.list());
  handle('wf-get', (id) => store.get(id));
  handle('wf-save', (workflow) => store.save(workflow));
  handle('wf-delete', (id) => store.remove(id));
  handle('wf-validate', async (workflow) => {
    const { toolInfo } = await describe();
    return validateWorkflow(sanitizeWorkflow(workflow), { toolInfo });
  });
  handle('wf-run', async ({ workflow, request, reuse, engineVersion } = {}) => {
    if (controller) return { ok: false, error: '上一次執行還沒結束。' };
    if (engineVersion !== ENGINE_VERSION) return { ok: false, error: '小精靈的主程式還是舊版（只重新整理了畫面）：請按 Ctrl+C 停掉，再執行 npm run poc:chatgpt-plan 完整重開。' };
    if (typeof request !== 'string' || !request.trim() || request.length > 20_000) return { ok: false, error: '請輸入問題（最多 20,000 字）。' };
    const clean = sanitizeWorkflow(workflow);
    const { label, toolInfo } = await describe();
    const check = validateWorkflow(clean, { toolInfo });
    if (!check.ok) return { ok: false, errors: check.errors, error: check.errors[0].message };
    controller = new AbortController();
    const started = Date.now();
    diagnostics(`工作流「${clean.name}」開始執行（${clean.nodes.length} 張卡片）`);
    try {
      const result = await runWorkflow({
        workflow: clean, request: request.trim(), signal: controller.signal, reuse: cleanResults(reuse, clean.nodes),
        deps: { label, run: (node, options) => runNode(node, options) },
        onEvent: (event) => send(event),
      });
      diagnostics(`工作流「${clean.name}」${result.cancelled ? '已停止' : result.ok ? '完成' : '有步驟失敗'}（${Date.now() - started} ms）`);
      // 成品自動存成 Markdown：文件／Screen Spirit 成品／工作流名稱／日期時間-成品名稱.md
      const outputs = [];
      for (const output of result.outputs || []) {
        let saved = { path: '' };
        try { saved = await saveOutputFile(clean.name, output); } catch (error) { diagnostics(`工作流：成品存檔失敗（${error.message}）`); saved = { path: '', warning: error.message }; }
        outputs.push({ ...output, ...saved });
      }
      return { ok: result.ok, cancelled: result.cancelled, outputs, errors: result.errors };
    } finally {
      controller = undefined;
      onRunEnd();
    }
  });
  handle('wf-cancel', () => { controller?.abort(); return { ok: true }; });
  // 打開存好的成品檔／在 Finder 顯示（只接受成品資料夾裡的檔案）
  handle('wf-open-output', async ({ path, reveal } = {}) => {
    const root = outputRoot();
    if (typeof path !== 'string' || !path.startsWith(`${root}/`) || path.includes('..')) return { ok: false };
    if (reveal) shell?.showItemInFolder(path); else await shell?.openPath(path);
    return { ok: true };
  });
  // 不限時間等 AI 回覆；使用者可以按「用目前讀到的內容完成這一步」提早結束操作 App 的那一步
  handle('wf-finish-step', (nodeId) => ({ ok: Boolean(controller) && Boolean(finishStep(typeof nodeId === 'string' ? nodeId : '')) }));
  // 附加檔案或資料夾（給使用者的問題，或某一張卡片）
  handle('wf-pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: '附加檔案或資料夾', buttonLabel: '附加',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (canceled || !filePaths?.length) return [];
    const picked = [];
    for (const path of filePaths.slice(0, 20)) {
      const info = await stat(path).catch(() => undefined);
      if (info) picked.push({ path, kind: info.isDirectory() ? 'dir' : 'file' });
    }
    return picked;
  });
  handle('wf-save-output', async ({ name, text } = {}) => {
    if (typeof text !== 'string' || !text) return { ok: false };
    const safeName = String(name || '成品').replace(/[\\/:*?"<>|\n]/g, '').slice(0, 60) || '成品';
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      defaultPath: join(app.getPath('documents'), `${safeName}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '純文字', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    await writeFile(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  });
}
