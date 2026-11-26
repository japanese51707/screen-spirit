// 精靈造型（主程序端）：存放位置、呼叫 MixRoute、Electron 解圖、本機去背，把 skin-builder 的計算接起來。
// 存放：<userData>/skins/<精靈 id>/
//   manifest.json、*.png（512）       → 造型包（桌面小精靈用）
//   work/sheet.png、master.png、parts.json、layers/*.png（1024） → 製作中的資料（重做單一圖層用）
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from './image-ops.mjs';
import { buildUserMessage, streamMixRouteChat } from './mixroute.mjs';
import { buildSkin, FACE_STATES, HERO_PROMPT, normalizeParts, packageFiles, parseHeroBox, startSkin, validateManifest, WORK_SIZE } from './skin-builder.mjs';
import { chooseModels, imageEdit } from './skin-test.mjs';
import { installLogTail, openInstallTerminal, runSam, samStatus, waitForInstall } from './sam-local.mjs';

const ID_PATTERN = /^[\w-]{1,64}$/;
const dataUrl = (png, type = 'image/png') => `data:${type};base64,${Buffer.from(png).toString('base64')}`;

export function createSkinService({ userData, directory, nativeImage, getApiKey, getModelEntries, ensureHelper, onProgress = () => {}, log = () => {} }) {
  const root = join(userData, 'skins');
  const jobs = new Map(); // 精靈 id → 進行中的工作說明
  const cache = new Map(); // 精靈 id → 造型包（data URL）
  let helper;

  const folder = (spiritId) => {
    if (!ID_PATTERN.test(String(spiritId || ''))) throw new Error('精靈 id 不正確。');
    return join(root, spiritId);
  };

  function decode(buffer) {
    let image = nativeImage.createFromBuffer(Buffer.from(buffer));
    if (image.isEmpty()) throw new Error('讀不懂這張圖片的格式。');
    const { width, height } = image.getSize();
    if (width !== WORK_SIZE || height !== WORK_SIZE) image = image.resize({ width: WORK_SIZE, height: WORK_SIZE, quality: 'best' });
    return ops.fromBgraPremultiplied(image.toBitmap(), WORK_SIZE, WORK_SIZE);
  }

  /** 本機去背（macOS 14 以上）；失敗回傳 undefined */
  async function cutout(image) {
    try {
      helper ||= await ensureHelper({ sourcePath: join(directory, 'subject-cutout.swift'), binDirectory: join(userData, 'helpers'), log });
      const work = join(root, '.tmp');
      await mkdir(work, { recursive: true });
      const input = join(work, `in-${Date.now()}.png`);
      const output = join(work, `out-${Date.now()}.png`);
      await writeFile(input, ops.encodePng(image));
      const result = await new Promise((resolve) => {
        execFile(helper, [input, output], { timeout: 60000 }, (error, stdout) => {
          try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { resolve({ ok: false, error: error?.message }); }
        });
      });
      const cut = result?.ok ? decode(await readFile(output)) : undefined;
      await rm(input, { force: true });
      await rm(output, { force: true });
      if (!result?.ok) log(`本機去背失敗：${result?.error || '未知原因'}`);
      return cut;
    } catch (error) {
      log(`本機去背失敗：${error.message}`);
      return undefined;
    }
  }

  // ── 本機切割工具（SAM 2.1）──
  const samHelper = join(directory, 'sam-helper.py');
  let samInstalling = false;
  async function sam() {
    return { status: await samStatus(userData, { installing: samInstalling }), log: samInstalling ? '' : await installLogTail(userData, 4) };
  }
  async function installSam() {
    if (samInstalling) return sam();
    await openInstallTerminal({ userData, helperPath: samHelper });
    samInstalling = true;
    log('本機切割工具：開始安裝（終端機）');
    void waitForInstall(userData).then((ok) => {
      samInstalling = false;
      log(`本機切割工具：${ok ? '安裝完成' : '安裝沒有完成'}`);
      onProgress({ spiritId: '', stage: 'sam', label: ok ? 'ready' : 'missing' });
    });
    return sam();
  }
  /** 切割：回傳 { 名稱: { area: Uint8Array（1024×1024）, score } } */
  async function segment({ imagePng, boxes, negative }) {
    const result = await runSam({ userData, helperPath: samHelper, imagePng, boxes, negative });
    log(`本機切割工具：${Object.keys(result.masks).length} 個配件（${result.device}）`);
    const masks = {};
    for (const [name, { png, score }] of Object.entries(result.masks)) {
      const image = decode(png);
      const area = new Uint8Array(WORK_SIZE * WORK_SIZE);
      for (let p = 0; p < area.length; p += 1) if (image.data[p * 4] > 127) area[p] = 1;
      masks[name] = { area, score };
    }
    return masks;
  }

  async function depsFor({ imageModel, visionModel }) {
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('匯入設定圖要用 MixRoute 生圖：請先在主視窗選 MixRoute，按「金鑰」輸入 API 金鑰。');
    const samReady = (await samStatus(userData)) === 'ready';
    return {
      ...(samReady ? { segment } : {}),
      edit: async ({ prompt, image, mask, extras }) => {
        const result = await imageEdit({ apiKey, model: imageModel, prompt, image, mask, extras, log });
        return { image: decode(result.buffer), acceptedExtras: result.acceptedExtras };
      },
      chat: async ({ prompt, imagePng }) => streamMixRouteChat({ apiKey, model: visionModel, messages: [buildUserMessage(prompt, dataUrl(imagePng))] }),
      cutout,
    };
  }

  function models() {
    const entries = getModelEntries();
    const picked = chooseModels(entries);
    return { imageModels: picked.imageModels, visionModels: picked.chatModels, defaults: { image: picked.image, vision: picked.vision } };
  }

  async function guard(spiritId, label, work) {
    if (jobs.has(spiritId)) throw new Error(`這隻精靈正在${jobs.get(spiritId)}，請等它完成。`);
    jobs.set(spiritId, label);
    const progress = (event) => onProgress({ spiritId, ...event });
    try {
      return await work(progress);
    } catch (error) {
      progress({ stage: 'error', label: error.message });
      throw error;
    } finally {
      jobs.delete(spiritId);
    }
  }

  async function readWork(spiritId) {
    const dir = join(folder(spiritId), 'work');
    const master = decode(await readFile(join(dir, 'master.png')));
    const meta = JSON.parse(await readFile(join(dir, 'parts.json'), 'utf8'));
    return { dir, master, masterFlat: ops.flattenOnWhite(master), meta };
  }

  function sheetFromDataUrl(sheetDataUrl) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(sheetDataUrl || ''));
    if (!match) throw new Error('請選一張 PNG、JPEG 或 WebP 的設定圖。');
    const sheet = Buffer.from(match[2], 'base64');
    if (sheet.length > 20 * 1024 * 1024) throw new Error('設定圖太大了（上限 20 MB）。');
    return sheet;
  }

  /** 請看圖的 AI 在設定圖上框出主角（0～1000 比例座標）；給使用者當預設，再自己拖動調整 */
  async function suggestHero({ sheetDataUrl, visionModel }) {
    const sheet = sheetFromDataUrl(sheetDataUrl);
    const apiKey = await getApiKey();
    if (!apiKey) throw new Error('需要 MixRoute 金鑰才能自動找主角；也可以直接拖動框框。');
    let image = nativeImage.createFromBuffer(sheet);
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 1536) image = image.resize(width >= height ? { width: 1536 } : { height: 1536 });
    const text = await streamMixRouteChat({ apiKey, model: visionModel || models().defaults.vision, messages: [buildUserMessage(HERO_PROMPT, dataUrl(image.toPNG()))] });
    return parseHeroBox(text);
  }

  /** 從設定圖裁下主角（box：0～1000 比例座標）→ 補成正方形（白底）→ 1024×1024 */
  function heroFromSheet(sheet, box) {
    const image = nativeImage.createFromBuffer(sheet);
    if (image.isEmpty()) throw new Error('讀不懂這張設定圖。');
    const { width, height } = image.getSize();
    const [bx0, by0, bx1, by1] = (Array.isArray(box) && box.length === 4 ? box : [0, 0, 1000, 1000]).map(Number);
    const pad = 0.02 * Math.max(width, height);
    const x0 = Math.max(0, Math.floor((bx0 / 1000) * width - pad)); const y0 = Math.max(0, Math.floor((by0 / 1000) * height - pad));
    const x1 = Math.min(width, Math.ceil((bx1 / 1000) * width + pad)); const y1 = Math.min(height, Math.ceil((by1 / 1000) * height + pad));
    const w = x1 - x0; const h = y1 - y0;
    if (w < 32 || h < 32) throw new Error('主角的範圍太小了。');
    const cropped = image.crop({ x: x0, y: y0, width: w, height: h });
    const size = cropped.getSize();
    const piece = ops.fromBgraPremultiplied(cropped.toBitmap(), size.width, size.height);
    const side = Math.round(Math.max(size.width, size.height) * 1.04);
    const canvas = { width: side, height: side, data: new Uint8Array(side * side * 4).fill(255) };
    const left = Math.round((side - size.width) / 2); const top = Math.round((side - size.height) / 2);
    ops.paste(canvas, ops.flattenOnWhite(piece), left, top);
    const hero = decode(ops.encodePng(canvas)); // decode 會縮放成 1024×1024
    const scale = hero.width / side;
    // rect：設定圖內容在 1024 主圖裡的範圍（用來找出被裁框切到的鄰居碎片）
    return { image: hero, rect: [left * scale, top * scale, (left + size.width) * scale, (top + size.height) * scale].map(Math.round) };
  }

  /** 第一段：設定圖 → 主圖＋零件框（存進 work/，等使用者確認）。mode：'crop' 直接用設定圖的主角（heroBox）、'redraw' 請 AI 重畫 */
  async function start({ spiritId, sheetDataUrl, imageModel, visionModel, mode = 'crop', heroBox }) {
    const sheet = sheetFromDataUrl(sheetDataUrl);
    const chosen = { ...models().defaults, ...(imageModel ? { image: imageModel } : {}), ...(visionModel ? { vision: visionModel } : {}) };
    if (!chosen.image) throw new Error('MixRoute 的模型清單裡沒有生圖模型。');
    return guard(spiritId, '畫主圖', async (progress) => {
      const deps = await depsFor({ imageModel: chosen.image, visionModel: chosen.vision });
      // 統一成 PNG 再送（有些閘道只收 PNG）
      const sheetPng = nativeImage.createFromBuffer(sheet).toPNG();
      const hero = mode === 'redraw' ? undefined : heroFromSheet(sheet, heroBox);
      const heroImage = hero?.image;
      const result = await startSkin({ sheetPng, heroImage, heroRect: hero?.rect, heroBox: heroImage ? heroBox : undefined, mode: heroImage ? 'crop' : 'redraw', deps, onProgress: progress });
      const dir = join(folder(spiritId), 'work');
      await rm(dir, { recursive: true, force: true });
      await mkdir(join(dir, 'layers'), { recursive: true });
      await writeFile(join(dir, 'sheet.png'), sheetPng);
      await writeFile(join(dir, 'master.png'), ops.encodePng(result.master));
      await writeFile(join(dir, 'parts.json'), JSON.stringify({ parts: result.parts, models: chosen, mode: result.mode, heroBox: heroImage ? heroBox : undefined, createdAt: new Date().toISOString() }, null, 2));
      progress({ stage: 'confirm', label: '請確認零件位置' });
      log(`精靈造型：主圖完成（${result.mode === 'crop' ? '直接用設定圖的主角' : chosen.image}），找到零件 ${result.parts.map((part) => part.name).join('、') || '無'}`);
      return draft(spiritId);
    });
  }

  /** 製作中的資料（主圖、零件框、設定圖、配件原稿、和設計稿的比對結果），給確認畫面和組裝台用 */
  async function draft(spiritId) {
    try {
      const dir = join(folder(spiritId), 'work');
      const meta = JSON.parse(await readFile(join(dir, 'parts.json'), 'utf8'));
      const master = await readFile(join(dir, 'master.png'));
      const small = nativeImage.createFromBuffer(master).resize({ width: 512, height: 512, quality: 'best' }).toPNG();
      let sheetDataUrl = '';
      try {
        let sheet = nativeImage.createFromBuffer(await readFile(join(dir, 'sheet.png')));
        const { width, height } = sheet.getSize();
        if (Math.max(width, height) > 1200) sheet = sheet.resize(width >= height ? { width: 1200, quality: 'best' } : { height: 1200, quality: 'best' });
        sheetDataUrl = `data:image/jpeg;base64,${sheet.toJPEG(88).toString('base64')}`;
      } catch {}
      const refDataUrls = {};
      for (const name of await readdir(join(dir, 'refs')).catch(() => [])) if (name.endsWith('.png')) refDataUrls[name.replace(/\.png$/, '')] = dataUrl(await readFile(join(dir, 'refs', name)));
      const refMasks = {};
      for (const name of await readdir(join(dir, 'masks')).catch(() => [])) if (name.endsWith('.png')) refMasks[name.replace(/\.png$/, '')] = dataUrl(await readFile(join(dir, 'masks', name)));
      return {
        masterDataUrl: dataUrl(small), sheetDataUrl, parts: meta.parts || [], models: meta.models || {}, built: Boolean(meta.builtAt),
        checks: meta.layout?.checks || {}, placements: meta.layout?.placements || {}, refDataUrls, refMasks, workSize: WORK_SIZE,
      };
    } catch {
      return null;
    }
  }

  /** 設定圖（原尺寸，最大 2048）→ RGBA，切配件原稿用 */
  async function readSheet(dir) {
    try {
      let image = nativeImage.createFromBuffer(await readFile(join(dir, 'sheet.png')));
      if (image.isEmpty()) return undefined;
      let { width, height } = image.getSize();
      if (Math.max(width, height) > 2048) {
        image = image.resize(width >= height ? { width: 2048, quality: 'best' } : { height: 2048, quality: 'best' });
        ({ width, height } = image.getSize());
      }
      return ops.fromBgraPremultiplied(image.toBitmap(), width, height);
    } catch {
      return undefined;
    }
  }

  async function writePackage(spiritId, layers, manifest) {
    const dir = folder(spiritId);
    const files = packageFiles(layers);
    for (const name of await readdir(dir).catch(() => [])) if (name.endsWith('.png')) await rm(join(dir, name), { force: true });
    for (const [name, png] of Object.entries(files)) await writeFile(join(dir, name), png);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const workLayers = join(dir, 'work', 'layers');
    await rm(workLayers, { recursive: true, force: true });
    await mkdir(workLayers, { recursive: true });
    for (const [key, image] of Object.entries(layers)) await writeFile(join(workLayers, `${key}.png`), ops.encodePng(image));
    cache.delete(spiritId);
  }

  /**
   * 除錯用：每次產生圖層時，把中間結果（512 縮圖）和量測數字存到專案的 skin-test-output/skin-debug/，
   * 圖片有問題時可以直接看是哪一步出錯（App 的資料夾在 ~/Library，不方便打開）。只保留每隻精靈最近 3 次。
   */
  async function writeDebug(spiritId, { masterFlat, layers, debug, report, parts }) {
    try {
      const base = join(directory, 'skin-test-output', 'skin-debug');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const dir = join(base, `${spiritId.slice(0, 8)}-${stamp}`);
      await mkdir(dir, { recursive: true });
      const small = (image) => ops.encodePng(ops.downscale2x(image));
      await writeFile(join(dir, 'master.png'), small(masterFlat));
      for (const [name, image] of Object.entries(debug || {})) await writeFile(join(dir, `${name}.png`), small(image));
      for (const [name, image] of Object.entries(layers || {})) await writeFile(join(dir, `layer-${name}.png`), small(image));
      await writeFile(join(dir, 'report.json'), JSON.stringify({ parts, report }, null, 2));
      const runs = (await readdir(base)).filter((name) => name.startsWith(spiritId.slice(0, 8))).sort();
      for (const old of runs.slice(0, -3)) await rm(join(base, old), { recursive: true, force: true });
      log(`精靈造型：除錯資料存在 ${dir}`);
    } catch (error) {
      log(`精靈造型：除錯資料存檔失敗：${error.message}`);
    }
  }

  /** 第二段：確認過的零件框 → 造型包。only：只重做某些項目（'face:done'、'accessories'） */
  async function build({ spiritId, parts, only, placements, masks }) {
    return guard(spiritId, only ? '重做圖層' : '產生圖層', async (progress) => {
      const { dir, master, masterFlat, meta } = await readWork(spiritId);
      // 組裝台調好的擺位：寫進零件資料，只重新組配件（不用生圖）
      let source = (parts || meta.parts || []).map((part) => (placements && placements[part.name] ? { ...part, place: placements[part.name] } : part));
      // 組裝台畫的遮罩（塗到的地方放到身體後面）：存成 work/masks/<配件>.png，零件資料記下是畫在第幾張原稿上
      if (masks && typeof masks === 'object') {
        await mkdir(join(dir, 'masks'), { recursive: true });
        for (const [name, value] of Object.entries(masks)) {
          if (!/^[a-z_]+$/.test(name)) continue;
          const file = join(dir, 'masks', `${name}.png`);
          if (!value) {
            await rm(file, { force: true });
            source = source.map((part) => (part.name === name ? { ...part, maskRef: undefined } : part));
            continue;
          }
          const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(value.dataUrl || ''));
          if (!match || match[1].length > 8_000_000 || !Number.isInteger(value.ref)) continue;
          await writeFile(file, Buffer.from(match[1], 'base64'));
          source = source.map((part) => (part.name === name ? { ...part, maskRef: value.ref } : part));
        }
      }
      const confirmed = normalizeParts(source);
      const sheet = await readSheet(dir);
      const maskImages = {};
      for (const part of confirmed) {
        if (part.maskRef == null) continue;
        try {
          const image = nativeImage.createFromBuffer(await readFile(join(dir, 'masks', `${part.name}.png`)));
          if (image.isEmpty()) continue;
          const { width, height } = image.getSize();
          maskImages[part.name] = { ref: part.maskRef, image: ops.fromBgraPremultiplied(image.toBitmap(), width, height) };
        } catch {}
      }
      const deps = await depsFor({ imageModel: meta.models?.image, visionModel: meta.models?.vision });
      const previous = {};
      if (only) {
        for (const name of await readdir(join(dir, 'layers')).catch(() => [])) {
          previous[name.replace(/\.png$/, '')] = decode(await readFile(join(dir, 'layers', name)));
        }
      }
      const result = await buildSkin({ master, masterFlat, parts: confirmed, sheet, masks: maskImages, deps, onProgress: progress, only, previous, previousStatic: meta.staticParts || [], previousLayout: meta.layout || {} });
      await writePackage(spiritId, result.layers, result.manifest);
      if (Object.keys(result.refImages || {}).length) {
        await mkdir(join(dir, 'refs'), { recursive: true });
        for (const [name, image] of Object.entries(result.refImages)) await writeFile(join(dir, 'refs', `${name}.png`), ops.encodePng(image));
      }
      await writeDebug(spiritId, { masterFlat, layers: result.layers, debug: result.debug, report: result.report, parts: confirmed });
      await writeFile(join(dir, 'parts.json'), JSON.stringify({ ...meta, parts: confirmed, builtAt: new Date().toISOString(), staticParts: result.staticParts, report: result.report, layout: result.layout }, null, 2));
      progress({ stage: 'done', label: '造型完成' });
      log(`精靈造型：${only ? `重做 ${only.join('、')}` : '圖層完成'}`);
      return get(spiritId);
    });
  }

  /** 造型包（data URL），桌面小精靈和預覽用；沒有就回傳 null */
  async function get(spiritId) {
    if (cache.has(spiritId)) return cache.get(spiritId);
    let result = null;
    try {
      const dir = folder(spiritId);
      const manifest = validateManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
      if (manifest) {
        const layers = {};
        const faces = {};
        const stateLayers = {}; // 五官：{ 'eye-left': { idle, blink, … } }
        for (const layer of manifest.layers) {
          if (layer.file === 'face-{state}.png') {
            for (const state of manifest.faces) faces[state] = dataUrl(await readFile(join(dir, `face-${state}.png`)));
          } else if (layer.file.includes('{state}')) {
            stateLayers[layer.id] = {};
            for (const state of manifest.faces) {
              const file = join(dir, layer.file.replace('{state}', state));
              try { stateLayers[layer.id][state] = dataUrl(await readFile(file)); } catch {}
            }
          } else {
            layers[layer.id] = dataUrl(await readFile(join(dir, layer.file)));
          }
        }
        result = { manifest, layers, faces, stateLayers };
      }
    } catch {}
    cache.set(spiritId, result);
    return result;
  }

  /**
   * 主圖做成卡面：整隻角色都放進去（不裁掉兩邊），背景透明（PNG），卡片的顏色會從後面透出來。
   * 480×640；角色放在中間的正方形裡，卡片圖區不論比例多少，裁掉的都只有上下的透明邊。
   */
  async function card(spiritId) {
    const master = decode(await readFile(join(folder(spiritId), 'work', 'master.png')));
    const bounds = ops.alphaBounds(master) || { x0: 0, y0: 0, x1: WORK_SIZE, y1: WORK_SIZE };
    const side = Math.round(Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0) * 1.06);
    const cx = Math.round((bounds.x0 + bounds.x1) / 2);
    const cy = Math.round((bounds.y0 + bounds.y1) / 2);
    const square = ops.crop(master, cx - Math.round(side / 2), cy - Math.round(side / 2), side, side);
    const fit = 452;
    const resized = nativeImage.createFromBuffer(ops.encodePng(square)).resize({ width: fit, height: fit, quality: 'best' });
    const small = ops.fromBgraPremultiplied(resized.toBitmap(), fit, fit);
    const canvas = { width: 480, height: 640, data: new Uint8Array(480 * 640 * 4) };
    ops.paste(canvas, small, Math.round((480 - fit) / 2), Math.round((640 - fit) / 2));
    return dataUrl(ops.encodePng(canvas));
  }

  async function remove(spiritId) {
    if (jobs.has(spiritId)) throw new Error('這隻精靈的造型正在製作中，請等它完成。');
    await rm(folder(spiritId), { recursive: true, force: true });
    cache.delete(spiritId);
  }

  return { models, start, suggestHero, draft, build, get, card, remove, sam, installSam, busy: (spiritId) => jobs.get(spiritId) || '', FACE_STATES };
}
