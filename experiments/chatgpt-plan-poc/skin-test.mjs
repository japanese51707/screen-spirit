// 造型可行性測試（npm run poc:skin-test）：
// 設定圖 → ① 正面主圖 → ② 本機去背 → ③ AI 標出零件位置 → ④ 只重畫眼睛（閉眼）→ ⑤ 量測有沒有對齊 → 產生報告
// 目的：確認 MixRoute 的生圖模型能不能「只改一小塊、其他不動」，這決定整套造型流程能不能自動化。
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractJsonObject } from './json-reply.mjs';
import { listMixRouteModelEntries, MIXROUTE_BASE_URL, pickDefaultModel, streamMixRouteChat, buildUserMessage } from './mixroute.mjs';
import { imageSupport, modelKind } from './model-capabilities.mjs';
import * as ops from './image-ops.mjs';

const SIZE = 1024;

export const MASTER_PROMPT = [
  'Using the attached character design sheet as the only reference, draw the SAME character exactly once:',
  'front view facing the viewer, gentle closed-mouth smile, both eyes open, wearing all of its accessories and holding its props as designed.',
  'Center the character on a square canvas. The character including its props spans about 80% of the canvas width, and its lowest point sits about 4% above the bottom edge.',
  'Plain, flat, solid pure green background (#00FF00). No floor, no cast shadow, no text, no labels, no colour swatches, no extra poses, no sparkles that float apart from the character.',
  'Keep the design sheet\'s exact colours, outline weight, soft shading and glow style.',
].join(' ');

export const BOXES_PROMPT = [
  'This is an illustration of one character (with what it wears and holds) on a plain background.',
  'Return ONLY a JSON object, no other text: {"parts":[{"name":"...","box":[x0,y0,x1,y1]}]}',
  'Coordinates are integers on a 0–1000 scale of the image width and height (x to the right, y downward). Boxes must tightly enclose each part.',
  'Use these names: left_eye and right_eye (left = the viewer\'s left), mouth, hat, face_accessory (glasses or monocle, if any), prop_left and prop_right (items held or floating at the sides, if any), extra_a and extra_b (any other separate items such as headphones around the neck or a floating screen, if any), body (the whole character body without props).',
  'Omit parts that do not exist.',
].join('\n');

export const BLINK_PROMPT = [
  'Edit only the transparent (masked) area of the image.',
  'The character is blinking: both eyes are now closed, each drawn as a soft curved closed-eye line in the same dark colour and line weight as the original eyes.',
  'Do not change anything else: same face shape, blush, accessories (including any monocle or glasses), colours, lighting, outline and position.',
].join(' ');

const now = () => Date.now();
const seconds = (start) => Math.round((Date.now() - start) / 100) / 10;

async function imageBufferFromResult(json, fetchImpl) {
  const item = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const response = await fetchImpl(item.url);
    if (!response.ok) throw new Error(`下載產生的圖片失敗（${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error(`生圖模型沒有回傳圖片：${JSON.stringify(json).slice(0, 200)}`);
}

/**
 * 呼叫 /images/edits。extras 是「可能不被支援」的參數（透明背景、高保真）：被拒絕就拿掉重試一次，並記下結果。
 */
export async function imageEdit({ apiKey, model, prompt, image, mask, extras = {}, fetchImpl = fetch, log = () => {} }) {
  const attempt = async (params) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', `${SIZE}x${SIZE}`);
    form.append('image', new Blob([image], { type: 'image/png' }), 'image.png');
    if (mask) form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
    for (const [key, value] of Object.entries(params)) form.append(key, value);
    const response = await fetchImpl(`${MIXROUTE_BASE_URL}/images/edits`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}：${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return JSON.parse(text);
  };
  const started = now();
  try {
    const json = await attempt(extras);
    return { buffer: await imageBufferFromResult(json, fetchImpl), acceptedExtras: Object.keys(extras), rejected: '', seconds: seconds(started) };
  } catch (error) {
    if (!Object.keys(extras).length || ![400, 422].includes(error.status)) throw error;
    log(`  · 參數 ${Object.keys(extras).join('、')} 被拒絕，拿掉後重試（${error.message.slice(0, 120)}）`);
    const json = await attempt({});
    return { buffer: await imageBufferFromResult(json, fetchImpl), acceptedExtras: [], rejected: error.message, seconds: seconds(started) };
  }
}

export function chooseModels(entries, { imageModel, visionModel } = {}) {
  const kinds = entries.map(({ id, entry }) => ({ id, entry, kind: modelKind(id, entry) }));
  const imageModels = kinds.filter((item) => item.kind === 'image').map((item) => item.id);
  const chatModels = kinds.filter((item) => item.kind === 'chat' && imageSupport(item.id, { apiEntry: item.entry }) !== 'no').map((item) => item.id);
  const image = imageModel || imageModels.find((id) => /^gpt-image-1$/i.test(id)) || imageModels.find((id) => /gpt-image/i.test(id)) || imageModels[0] || '';
  // 找零件位置要新一點的看圖模型（舊模型標的框常偏掉）：依序找 GPT-5、Gemini 2.5／3、GPT-4.1／4o
  const preferred = [/^gpt-5(?!.*(nano|mini))/i, /gemini-(3|2\.5)-pro/i, /gemini-(3|2\.5)/i, /^gpt-4\.1(?!.*nano)/i, /^gpt-4o(?!.*mini)/i];
  const ranked = (pattern) => chatModels.filter((id) => pattern.test(id)).sort().reverse()[0];
  const vision = visionModel || preferred.map(ranked).find(Boolean) || pickDefaultModel(chatModels);
  return { image, vision, imageModels, chatModels };
}

export function parseParts(text) {
  const json = extractJsonObject(text, '找零件的 AI 沒有回傳 JSON。');
  const parts = Array.isArray(json?.parts) ? json.parts : [];
  return parts
    .filter((part) => part && typeof part.name === 'string' && Array.isArray(part.box) && part.box.length === 4 && part.box.every((n) => Number.isFinite(Number(n))))
    .map((part) => ({ name: part.name.trim().toLowerCase(), box: part.box.map((n) => Math.round(Number(n))) }));
}

export function verdictFor(stats) {
  if (!stats) return { level: 'fail', text: '閉眼這一步沒有完成，看下面的錯誤訊息。' };
  if (stats.changedPixels < 300) return { level: 'fail', text: '模型幾乎沒有改眼睛：可能不支援遮罩，或沒照指示閉眼。' };
  if (stats.nearCoverage < 0.85) {
    return { level: 'warn', text: `模型動到了眼睛以外、離得比較遠的地方（只有 ${Math.round(stats.nearCoverage * 100)}% 的改變在眼睛附近）。貼回時只取眼睛附近，但請目視確認閉眼的樣子是否完整。` };
  }
  if (stats.outsideMeanDiff > 8) {
    return { level: 'warn', text: '模型把整張圖輕微重畫了（顏色有偏移）。只取眼睛附近貼回仍然對齊，請看動態預覽確認邊緣自然。' };
  }
  const note = stats.maskCoverage < 0.5
    ? `AI 標的零件位置有偏差（只有 ${Math.round(stats.maskCoverage * 100)}% 的改變落在框內），已改用「實際改變的區域」貼回，不受影響；正式流程會讓你確認零件框。`
    : '';
  return { level: 'pass', text: `可行：模型照指示閉眼，其他地方幾乎沒動，貼回後圖層對齊。${note}` };
}

const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function reportHtml(report) {
  const figure = (file, caption, checker = false) => (file ? `<figure><img src="${file}" class="${checker ? 'checker' : ''}"><figcaption>${caption}</figcaption></figure>` : '');
  const boxes = (report.parts || []).map((part) => {
    const [x0, y0, x1, y1] = part.box;
    return `<div class="box" style="left:${x0 / 10}%;top:${y0 / 10}%;width:${(x1 - x0) / 10}%;height:${(y1 - y0) / 10}%"><span>${escapeHtml(part.name)}</span></div>`;
  }).join('');
  const steps = report.steps.map((step) => `<li class="${step.ok ? 'ok' : 'bad'}"><b>${step.ok ? '✓' : '✗'} ${escapeHtml(step.name)}</b>${step.seconds !== undefined ? `（${step.seconds} 秒）` : ''}<br>${escapeHtml(step.detail || '')}</li>`).join('');
  const s = report.blinkStats;
  const preview = report.files.cutout && report.files.blinkLayer
    ? `<div class="stage"><img src="${report.files.cutout}"><img class="blink" src="${report.files.blinkLayer}"></div>
       <div class="stage small"><img src="${report.files.cutout}"><img class="blink" src="${report.files.blinkLayer}"></div>`
    : '<p>（缺去背或閉眼圖層，無法預覽）</p>';
  return `<!doctype html><meta charset="utf-8"><title>造型可行性測試</title>
<style>
body{font:14px/1.6 -apple-system,sans-serif;margin:32px;color:#2d2a45;background:#f7f6fb}h1{font-size:22px}h2{font-size:17px;margin-top:32px}
.verdict{padding:14px 18px;border-radius:12px;font-size:15px}.pass{background:#e3f4e6;color:#1d5a2a}.warn{background:#fff3d6;color:#6b4a06}.fail{background:#fde4e4;color:#7a1f1f}
ul.steps{padding-left:18px}ul.steps li{margin:6px 0}li.bad{color:#7a1f1f}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}figure{margin:0;background:#fff;border-radius:12px;padding:10px}figure img{width:100%;border-radius:8px;display:block}
figcaption{font-size:12px;color:#6d6a86;margin-top:6px}.checker{background:repeating-conic-gradient(#e6e4ef 0 25%,#fff 0 50%) 0 0/20px 20px}
.boxes{position:relative;max-width:420px}.boxes img{width:100%;display:block;border-radius:8px}.box{position:absolute;border:2px solid #e0457b;border-radius:4px}.box span{position:absolute;top:-18px;left:-2px;background:#e0457b;color:#fff;font-size:10px;padding:0 4px;border-radius:3px;white-space:nowrap}
.stages{display:flex;gap:32px;align-items:flex-end;flex-wrap:wrap}.stage{position:relative;width:340px;height:340px;animation:float 3.4s ease-in-out infinite}.stage.small{width:96px;height:96px}.stage img{position:absolute;inset:0;width:100%;height:100%}
.stage .blink{opacity:0;animation:blink 3.2s infinite}@keyframes blink{0%,86%,100%{opacity:0}88%,94%{opacity:1}}@keyframes float{50%{translate:0 -4px}}
</style>
<h1>造型可行性測試</h1>
<p>${escapeHtml(report.time)}　生圖模型：<b>${escapeHtml(report.models.image)}</b>　找零件：<b>${escapeHtml(report.models.vision)}</b></p>
<div class="verdict ${report.verdict.level}">${escapeHtml(report.verdict.text)}</div>
<h2>動態預覽（漂浮＋眨眼；右邊是桌面實際大小 96px）</h2><div class="stages">${preview}</div>
<h2>量測結果</h2>
<table><tr><th>項目</th><th>結果</th></tr>
<tr><td>眼睛附近以外的平均色差（0–255，越小越好）</td><td>${s ? s.outsideMeanDiff : '—'}</td></tr>
<tr><td>眼睛附近以外明顯改變的像素</td><td>${s ? `${s.outsideChangedPct}%` : '—'}</td></tr>
<tr><td>模型改變的像素</td><td>${s ? s.changedPixels.toLocaleString() : '—'}</td></tr>
<tr><td>改變落在 AI 標的框內（越高代表零件位置越準）</td><td>${s ? `${Math.round(s.maskCoverage * 100)}%` : '—'}</td></tr>
<tr><td>改變落在框的附近 64px 內（越高代表模型越守規矩）</td><td>${s ? `${Math.round(s.nearCoverage * 100)}%` : '—'}</td></tr>
<tr><td>透明背景參數（background=transparent）</td><td>${report.capabilities.transparentBackground}</td></tr>
<tr><td>高保真參數（input_fidelity=high）</td><td>${report.capabilities.inputFidelity}</td></tr>
<tr><td>主圖本身有透明背景</td><td>${report.capabilities.masterHasAlpha ? '有' : '沒有（靠本機去背）'}</td></tr>
<tr><td>本機去背（macOS 主體擷取）</td><td>${report.capabilities.localCutout}</td></tr></table>
<h2>步驟</h2><ul class="steps">${steps}</ul>
<h2>AI 標出的零件位置</h2>${report.files.masterFlat ? `<div class="boxes"><img src="${report.files.masterFlat}">${boxes}</div>` : '<p>—</p>'}
<h2>各階段圖片</h2><div class="grid">
${figure(report.files.sheet, '① 你的設定圖')}${figure(report.files.masterFlat, '② 正面主圖（白底）')}${figure(report.files.cutout, '③ 去背後', true)}
${figure(report.files.mask, '④ 遮罩（透明處＝要重畫）', true)}${figure(report.files.blinkRaw, '⑤ 模型回傳的閉眼圖（原樣）')}${figure(report.files.heatmap, '⑥ 差異熱度圖（紅＝有改動）')}
${figure(report.files.blinkComposite, '⑦ 只取實際改變的區域貼回主圖')}${figure(report.files.blinkLayer, '⑧ 閉眼圖層（去背）', true)}
</div>`;
}

/**
 * 跑一次測試。decode(buffer) → 1024×1024 的直通 RGBA；cutout(inPath, outPath) → { ok, error }
 */
export async function runSkinTest({ apiKey, imagePath, outDir, imageModel, visionModel, decode, cutout, log = () => {}, fetchImpl = fetch, listEntries = listMixRouteModelEntries, chat = streamMixRouteChat }) {
  if (!apiKey) throw new Error('還沒有 MixRoute 金鑰：請先在 App 主視窗選 MixRoute，按「金鑰」輸入。');
  await mkdir(outDir, { recursive: true });
  const report = {
    time: new Date().toLocaleString('zh-TW', { hour12: false }), models: {}, steps: [], files: {}, parts: [],
    capabilities: { transparentBackground: '未測', inputFidelity: '未測', masterHasAlpha: false, localCutout: '未測' },
    blinkStats: undefined, verdict: undefined,
  };
  const save = async (name, data) => { await writeFile(join(outDir, name), data); report.files[name.replace(/\.png$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = name; return name; };
  const step = (name, ok, detail, extra = {}) => { report.steps.push({ name, ok, detail, ...extra }); log(`${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`); };
  const finish = async () => {
    report.verdict = verdictFor(report.blinkStats);
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(outDir, 'report.html'), reportHtml(report));
    return report;
  };

  // 0. 模型
  const entries = await listEntries({ apiKey, fetchImpl });
  const models = chooseModels(entries, { imageModel, visionModel });
  report.models = { image: models.image, vision: models.vision, availableImageModels: models.imageModels };
  log(`可用的生圖模型：${models.imageModels.join('、') || '（無）'}`);
  if (!models.image) { step('選擇生圖模型', false, 'MixRoute 模型清單裡沒有生圖模型。'); return finish(); }
  step('選擇模型', true, `生圖 ${models.image}；找零件 ${models.vision}`);

  const sheetBuffer = await readFile(imagePath);
  await save('sheet.png', sheetBuffer);

  // ① 正面主圖：先試透明背景＋高保真，不支援就拿掉
  let master;
  try {
    const result = await imageEdit({ apiKey, model: models.image, prompt: MASTER_PROMPT, image: sheetBuffer, extras: { background: 'transparent', input_fidelity: 'high', output_format: 'png' }, fetchImpl, log });
    report.capabilities.transparentBackground = result.acceptedExtras.includes('background') ? '接受' : '不接受';
    report.capabilities.inputFidelity = result.acceptedExtras.includes('input_fidelity') ? '接受' : '不接受';
    master = decode(result.buffer);
    report.capabilities.masterHasAlpha = ops.hasTransparency(master);
    step('① 產生正面主圖', true, `${master.width}×${master.height}${report.capabilities.masterHasAlpha ? '，已是透明背景' : ''}`, { seconds: result.seconds });
  } catch (error) {
    step('① 產生正面主圖', false, error.message);
    return finish();
  }
  const masterFlat = report.capabilities.masterHasAlpha ? ops.flattenOnWhite(master) : master;
  const masterFlatPng = ops.encodePng(masterFlat);
  await save('master-flat.png', masterFlatPng);

  // ② 去背：模型給了透明背景就直接用；仍然測一次本機去背（之後換模型時的備案）
  let cutoutImage = report.capabilities.masterHasAlpha ? master : undefined;
  try {
    const started = now();
    const result = await cutout(join(outDir, 'master-flat.png'), join(outDir, 'cutout-local.png'));
    if (result?.ok) {
      report.capabilities.localCutout = `可用（${seconds(started)} 秒）`;
      const local = decode(await readFile(join(outDir, 'cutout-local.png')));
      report.files.cutoutLocal = 'cutout-local.png';
      if (!cutoutImage) cutoutImage = local;
      step('② 本機去背', true, `找到 ${result.instances || 1} 個主體`, { seconds: seconds(started) });
    } else {
      report.capabilities.localCutout = `不可用（${result?.error || '未知原因'}）`;
      step('② 本機去背', false, result?.error === 'needs-macos-14' ? '需要 macOS 14 以上' : (result?.error || '未知原因'));
    }
  } catch (error) {
    report.capabilities.localCutout = `不可用（${error.message.slice(0, 80)}）`;
    step('② 本機去背', false, error.message);
  }
  if (cutoutImage) await save('cutout.png', ops.encodePng(cutoutImage));

  // ③ 找零件位置
  let eyes = [];
  try {
    const started = now();
    const dataUrl = `data:image/png;base64,${masterFlatPng.toString('base64')}`;
    const text = await chat({ apiKey, model: models.vision, messages: [buildUserMessage(BOXES_PROMPT, dataUrl)], fetchImpl });
    report.parts = parseParts(text);
    eyes = report.parts.filter((part) => /eye/.test(part.name));
    step('③ AI 標出零件位置', eyes.length > 0, `${report.parts.map((part) => part.name).join('、') || '沒有找到零件'}`, { seconds: seconds(started) });
  } catch (error) {
    step('③ AI 標出零件位置', false, error.message);
  }
  if (!eyes.length) return finish();

  // ④ 只重畫眼睛
  const area = ops.ellipseArea(SIZE, SIZE, eyes.map((part) => ops.boxToPixels(part.box, SIZE, SIZE)));
  const maskPng = ops.encodePng(ops.maskImage(masterFlat, area));
  await save('mask.png', maskPng);
  try {
    const result = await imageEdit({ apiKey, model: models.image, prompt: BLINK_PROMPT, image: masterFlatPng, mask: maskPng, extras: { input_fidelity: 'high' }, fetchImpl, log });
    const raw = decode(result.buffer);
    await save('blink-raw.png', result.buffer);
    const { region, stats } = ops.analyzeEdit(masterFlat, raw, area);
    report.blinkStats = stats;
    await save('heatmap.png', ops.encodePng(ops.diffHeatmap(masterFlat, raw)));
    const composite = ops.compositeInArea(masterFlat, raw, region, 4);
    await save('blink-composite.png', ops.encodePng(composite));
    if (cutoutImage) await save('blink-layer.png', ops.encodePng(ops.withAlphaFrom(composite, cutoutImage)));
    step('④ 只重畫眼睛（閉眼）', true, `眼睛附近以外的平均色差 ${stats.outsideMeanDiff}；改變落在框內 ${Math.round(stats.maskCoverage * 100)}%、在附近 ${Math.round(stats.nearCoverage * 100)}%`, { seconds: result.seconds });
  } catch (error) {
    step('④ 只重畫眼睛（閉眼）', false, error.message);
  }
  return finish();
}

/** 從 main.mjs 的 --skin-test 模式呼叫：用 Electron 解圖、編譯 Swift 去背工具，跑完打開報告 */
export async function runSkinTestFromCli({ argv, apiKey, userData, directory, openPath, ensureHelper }) {
  const { nativeImage } = await import('electron');
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const positional = argv.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && argv[index - 1].startsWith('--')));
  const imagePath = positional[0] || join(directory, 'assets', 'skin-test', '設定圖.png');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const outDir = join(directory, 'skin-test-output', stamp);
  const log = (message) => console.log(message);
  const decode = (buffer) => {
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('讀不懂模型回傳的圖片格式。');
    const { width, height } = image.getSize();
    if (width !== SIZE || height !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
    return ops.fromBgraPremultiplied(image.toBitmap(), SIZE, SIZE);
  };
  let helper;
  const cutout = async (input, output) => {
    helper ||= await ensureHelper({ sourcePath: join(directory, 'subject-cutout.swift'), binDirectory: join(userData, 'helpers'), log });
    return new Promise((resolve) => {
      execFile(helper, [input, output], { timeout: 60000 }, (error, stdout) => {
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ ok: false, error: error?.message || 'no-output' }); }
      });
    });
  };
  log(`\n🧪 造型可行性測試\n設定圖：${imagePath}\n輸出：${outDir}\n（大約 1～3 分鐘，會呼叫 2 次生圖、1 次對話）\n`);
  try {
    const report = await runSkinTest({ apiKey, imagePath, outDir, imageModel: option('--image-model'), visionModel: option('--vision-model'), decode, cutout, log });
    log(`\n結論：${report.verdict.text}\n報告：${join(outDir, 'report.html')}`);
    await openPath(join(outDir, 'report.html'));
    return 0;
  } catch (error) {
    log(`\n✗ 測試中止：${error.message}`);
    return 1;
  }
}
