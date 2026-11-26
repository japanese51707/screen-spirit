// 匯入設定圖 → 精靈造型包（規格見專案根目錄 SKIN-SPEC.md）
// 只負責「算」：生圖、看圖、解圖、去背都由呼叫端傳進來（deps），所以可以用假資料完整測試。
//
// 分兩段：
//   startSkin：設定圖 → 正面主圖（透明背景）→ AI 標出零件框，並在設定圖上找出每個配件「單獨畫的完整圖」（之後給使用者確認）
//   buildSkin：本體＋一件一件完整的配件疊上去（v0.7）——
//     本體：請模型把主圖上的配件全部拿掉，畫在純綠背景上（色鍵去背），和主圖對齊；檢查有沒有殘留配件，有就重畫一次
//     表情：在這個本體上改眼睛和嘴巴
//     配件：從設定圖上「單獨畫的完整配件」切下來（不是從主圖剪碎片），自動擺到主圖上它的位置（翻轉／角度／大小）；
//           被身體擋住的部分不剪掉，而是分到身體後面的圖層（前後順序參考多視角圖）。
//           每個配件都和設計稿比對，相同程度 95% 以上才算合格。
//           設定圖上沒有單獨圖的配件，才退回「從主圖切」（本機 SAM 2.1 / 主圖 − 身體）。
import * as ops from './image-ops.mjs';
import { extractJsonObject } from './json-reply.mjs';
import { MASTER_PROMPT, parseParts } from './skin-test.mjs';

export const SKIN_SPEC = 'skin/0.1';
export const WORK_SIZE = 1024;
export const SKIN_SIZE = 512;
export const FACE_STATES = ['idle', 'blink', 'work', 'done', 'error'];
export const FACE_LABELS = { idle: '待機', blink: '眨眼', work: '思考中', done: '完成', error: '出錯' };
export const FACE_PARTS = ['left_eye', 'right_eye', 'mouth'];
export const ACCESSORY_PARTS = ['hat', 'face_accessory', 'prop_left', 'prop_right', 'extra_a', 'extra_b'];
export const PART_LABELS = {
  left_eye: '左眼', right_eye: '右眼', mouth: '嘴巴', hat: '帽子', face_accessory: '臉上配件', prop_left: '左側道具', prop_right: '右側道具', extra_a: '其他配件 A', extra_b: '其他配件 B',
};
const LAYER_FILE = { hat: 'hat.png', face_accessory: 'face-accessory.png', prop_left: 'prop-left.png', prop_right: 'prop-right.png', extra_a: 'extra-a.png', extra_b: 'extra-b.png' };
const FX_FILE = 'fx.png'; // 特效（星星、閃光、光圈）：從主角圖取出，最上層、一閃一閃
for (const [name, file] of Object.entries({ ...LAYER_FILE })) LAYER_FILE[`${name}_back`] = file.replace('.png', '-back.png'); // 繞到身體後面的那一半
export const PASS_SCORE = 0.95; // 配件和設計稿相同 95% 以上才算合格
// 配件分兩類（v0.9）：
//   front／behind：獨立的物件（鍵盤、單眼鏡、程式碼視窗），單獨一層、從設定圖上的原稿做、和設計稿比對 95%；behind＝整個在身體後面（例如翅膀）
//   fused：和角色融為一體（帽子、掛在脖子上的耳機），畫「特製主體」時直接和角色一起畫，照物理邏輯戴好，不分層、不比對
export const LAYER_ORDERS = ['front', 'behind', 'fused'];
// 畫布：小精靈方框的 1.5 倍、方框在正中間（漂浮的配件可以超出方框）。
// 特製主體的大小、位置對齊預設小精靈（companion.html 的 SVG），輪廓照設計稿。
export const CANVAS_FRAME = 1.5;
export const CANVAS_ID = 'proto-1.5-fit'; // 擺法改了就換名稱：舊的擺位、本體不能沿用
export const PROTOTYPE_BODY = [0.1896, 0.2291, 0.7739, 0.8627]; // 預設小精靈的身體在畫布上的範圍（0～1）：SVG viewBox (3.4, 9.4)～(91.1, 104.4)
const LAYER_MOTION = { hat: 'wobble', face_accessory: 'none', prop_left: 'bob', prop_right: 'bob', extra_a: 'bob', extra_b: 'bob' };
const LAYER_Z = { fx: 90, base: 20, face: 30, face_accessory: 40, prop_left: 45, hat: 50, extra_a: 55, extra_b: 58, prop_right: 60 }; // 配件都從主圖取，主圖上它們都在身體前面
const KEY_HEX = { green: '#00FF00', magenta: '#FF00FF' };

const FACE_PROMPTS = {
  blink: 'The character is blinking: both eyes are closed, each drawn as a soft curved closed-eye line in the same dark colour and line weight as the original eyes. Keep the mouth as it is.',
  work: 'The character is thinking hard: both eyes look up and to the side (pupils shifted up), and the mouth is a small flat or slightly wavy line. Same colours and line weight.',
  done: 'The character is delighted: both eyes are closed in happy upward arcs (like ^ ^), and the mouth is a wide open smile. Same colours and line weight.',
  error: 'The character is surprised: both eyes are wide open and round, and the mouth is a small round open "o". Same colours and line weight.',
};
const KEEP_REST = 'Edit only the face area shown as transparent in the mask. Do not change anything else: same face shape, blush, colours, lighting, outline and position.';

const ACCESSORY_NAMES = {
  hat: 'the hat',
  face_accessory: 'the glasses or monocle (with its frame, lens and any chain)',
  prop_left: 'the item on the left side of the character (including any white or light-coloured surface of it)',
  prop_right: 'the item on the right side of the character (including any white or light-coloured surface of it)',
  extra_a: 'the other separate item (such as headphones or a floating screen)',
  extra_b: 'any remaining separate item',
};

/** 從設定圖找出「主角」：最大、最完整的那張角色圖（連同身上、手上的配件和旁邊漂浮的道具） */
export const HERO_PROMPT = [
  'This is a character design sheet.',
  'Find the single main illustration of the character: the largest and most detailed one, together with everything it wears or holds and the props floating right next to it.',
  'Exclude titles, text labels, colour swatches, smaller turnaround views, expression rows and separate accessory detail panels.',
  'Return ONLY a JSON object, no other text: {"box":[x0,y0,x1,y1]} with integer coordinates on a 0–1000 scale of the image width and height (x to the right, y downward).',
].join('\n');

export function parseHeroBox(text) {
  const json = extractJsonObject(text, '找主角的 AI 沒有回傳 JSON。');
  const box = Array.isArray(json?.box) ? json.box.map(Number) : [];
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) throw new Error('找主角的 AI 回傳的範圍不正確。');
  const [x0, y0, x1, y1] = box.map((n) => Math.max(0, Math.min(1000, Math.round(n))));
  if (x1 - x0 < 50 || y1 - y0 < 50) throw new Error('找主角的 AI 回傳的範圍太小。');
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** 在設定圖上找每個配件「單獨畫的完整圖」（配件說明區、細節圖），以及它和身體的前後關係（看多視角圖判斷） */
export function refsPrompt(accessories, heroBox) {
  const list = accessories.map((name) => `- ${name}: ${ACCESSORY_NAMES[name]}`).join('\n');
  return [
    'This is a character design sheet. The main illustration of the character wears or holds these items:',
    list,
    heroBox ? `The main illustration is inside the box [${heroBox.join(',')}] — do not return boxes inside it.` : 'Do not return boxes inside the main (largest) illustration.',
    'For each item:',
    '1. "label": a short English name of what the item really is (2–5 words, e.g. "backward snapback cap", "AR monocle", "mechanical keyboard", "noise-cancelling headphones", "floating code window"), and "label_zh": the same name in Traditional Chinese.',
    '2. "kind": look at the main illustration and the turnaround views. "floating" = a separate object drawn on top of the character that could be lifted away as its own piece (a held or floating keyboard, a monocle over one eye, a floating screen or window). "fused" = something worn on or around the body that is partly covered by the body or wraps around it, so it must be drawn together with the character (a hat or cap on the head, headphones resting around the neck, a scarf, backpack straps). "behind" = a separate object entirely behind the body (e.g. wings).',
    '3. "boxes": every separate drawing of that item ALONE on the sheet (accessory callouts, "accessories (detailed)" panels). Do not use the item as worn in the main illustration, the turnaround views or the expression row. Each box must tightly enclose only the drawing of the item: exclude its text label, the panel border and the panel background.',
    'Return ONLY a JSON object, no other text: {"items":[{"name":"hat","label":"backward snapback cap","label_zh":"反戴棒球帽","kind":"fused","boxes":[[x0,y0,x1,y1]]}]} with integer coordinates on a 0–1000 scale of the image width and height. Use an empty "boxes" list if the sheet has no separate drawing of that item.',
  ].join('\n');
}

const KIND_TO_LAYER = { floating: 'front', front: 'front', fused: 'fused', wraps: 'fused', behind: 'behind' };
const cleanLabel = (value) => String(value || '').replace(/[\u0000-\u001f<>{}]/g, '').trim().slice(0, 40);

export function parseRefs(text, accessories, heroBox) {
  const json = extractJsonObject(text, '找配件原稿的 AI 沒有回傳 JSON。');
  const items = Array.isArray(json?.items) ? json.items : [];
  const result = {};
  const overlapHero = (box) => {
    if (!heroBox) return 0;
    const w = Math.max(0, Math.min(box[2], heroBox[2]) - Math.max(box[0], heroBox[0])); const h = Math.max(0, Math.min(box[3], heroBox[3]) - Math.max(box[1], heroBox[1]));
    return (w * h) / Math.max(1, (box[2] - box[0]) * (box[3] - box[1]));
  };
  for (const item of items) {
    const name = String(item?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!accessories.includes(name) || result[name]) continue;
    const boxes = (Array.isArray(item.boxes) ? item.boxes : []).filter((box) => Array.isArray(box) && box.length === 4)
      .map((box) => box.map((n) => Math.max(0, Math.min(1000, Math.round(Number(n))))))
      .filter((box) => box.every(Number.isFinite))
      .map(([x0, y0, x1, y1]) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)])
      .filter((box) => box[2] - box[0] >= 12 && box[3] - box[1] >= 12 && overlapHero(box) < 0.5)
      .slice(0, 3);
    result[name] = { refs: boxes, layer: KIND_TO_LAYER[item.kind] || KIND_TO_LAYER[item.layer] || 'front', label: cleanLabel(item.label), labelZh: cleanLabel(item.label_zh) };
  }
  return result;
}

/** 找零件：眼睛、嘴巴、配件，還有「身體」（只有角色本身，用來對齊預設小精靈的大小、位置） */
export const PARTS_PROMPT = [
  'This is an illustration of one character (with what it wears and holds) on a plain background.',
  'Return ONLY a JSON object, no other text: {"parts":[{"name":"...","box":[x0,y0,x1,y1]}]}',
  'Coordinates are integers on a 0–1000 scale of the image width and height (x to the right, y downward). Boxes must tightly enclose each part.',
  'Use these names: left_eye and right_eye (left = the viewer\'s left), mouth, hat, face_accessory (glasses or monocle, if any), prop_left and prop_right (items held or floating at the sides, if any), extra_a and extra_b (any other separate items such as headphones around the neck or a floating screen, if any).',
  'Also return "body": the character\'s own body/head shape only — exclude the hat, headphones, glasses, held or floating items and effects; where the body is hidden behind an item, estimate its outline.',
  'Omit parts that do not exist.',
].join('\n');

/** 特製主體：拿掉獨立的配件和特效，融為一體的配件照物理邏輯戴好，畫在純色背景上 */
// keep：要和角色畫在一起的配件，每個是一段描述（名稱＋在圖上的位置）
const KEEP_NATURAL = (keep) => `Keep ${keep.join(' and ')} on the character, drawn together with it as part of the character, worn naturally and physically plausibly: complete any part that is cut off or hidden, follow the body contour (for example headphones resting around the neck with both ear cups visible and the band passing behind the neck, a cap sitting firmly on the head), and keep its design, colours and logo.`;

/** remove／keep：配件描述（名稱＋位置） */
export function bodyPrompt(remove, key = 'green', strict = false, keep = []) {
  return [
    'Redraw this character as the plain base body of an animated desktop mascot.',
    ...(remove.length ? [`Remove these separate items completely: ${remove.join('; ')}.`] : []),
    'Also remove every visual effect around the character: sparkles, stars, glow rings, swirls, light trails, particles and shadows.',
    ...(keep.length ? [KEEP_NATURAL(keep)] : []),
    ...(strict ? ['The previous attempt still showed parts of the removed items. Every one of them must be completely gone: no frames, lenses, keys, cables, screens or glow left anywhere on or around the body.'] : []),
    'Draw the complete body outline wherever a removed item covered it.',
    'Keep the face exactly as drawn (eyes, eyebrows, mouth, blush), and keep the character\'s size, position, pose, body shape, colours and outline. Do not add anything new.',
    `Replace the whole background with one flat, solid, pure ${key} colour (${KEY_HEX[key]}), with no shadow or floor.`,
  ].join(' ');
}

export function normalizeParts(parts = []) {
  const known = new Set([...FACE_PARTS, ...ACCESSORY_PARTS, 'body']);
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const name = String(part?.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!known.has(name) || seen.has(name) || !Array.isArray(part.box) || part.box.length !== 4) continue;
    const box = part.box.map((n) => Math.max(0, Math.min(1000, Math.round(Number(n)))));
    if (box.some((n) => !Number.isFinite(n))) continue;
    const [x0, y0, x1, y1] = box;
    if (Math.abs(x1 - x0) < 4 || Math.abs(y1 - y0) < 4) continue;
    seen.add(name);
    const entry = { name, box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] };
    if (ACCESSORY_PARTS.includes(name)) {
      entry.refs = (Array.isArray(part.refs) ? part.refs : []).filter((ref) => Array.isArray(ref) && ref.length === 4)
        .map((ref) => ref.map((n) => Math.max(0, Math.min(1000, Math.round(Number(n))))))
        .filter((ref) => ref.every(Number.isFinite) && ref[2] - ref[0] >= 4 && ref[3] - ref[1] >= 4).slice(0, 3);
      entry.layer = KIND_TO_LAYER[part.layer] || 'front'; // 舊版的「一部分繞到身體後面」改成和本體融為一體
      if (cleanLabel(part.label)) entry.label = cleanLabel(part.label);
      if (cleanLabel(part.labelZh)) entry.labelZh = cleanLabel(part.labelZh);
      // 使用者在組裝台調過的擺位（ref：用第幾張原稿）
      if (Number.isInteger(part.maskRef) && part.maskRef >= 0 && part.maskRef < entry.refs.length) entry.maskRef = part.maskRef;
      const place = part.place;
      if (place && Number.isInteger(place.ref) && place.ref >= 0 && place.ref < entry.refs.length
        && [place.angle, place.scale, place.cx, place.cy].every((n) => Number.isFinite(Number(n))) && Number(place.scale) > 0.02 && Number(place.scale) < 20) {
        entry.place = { ref: place.ref, flip: Boolean(place.flip), angle: Number(place.angle), scale: Number(place.scale), cx: Number(place.cx), cy: Number(place.cy) };
      }
    }
    result.push(entry);
  }
  return result;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

/**
 * 第一段：主圖＋零件框。
 *   mode 'crop'（預設）：heroImage＝從設定圖裁下的主角（呼叫端已裁好、補成正方形、1024），只要去背 → 像素就是設計稿本身
 *   mode 'redraw'：請生圖模型照設定圖重畫一張正面圖（純綠背景 → 色鍵去背；不要求透明背景，模型會把淺色的地方也挖透明）
 */
export async function startSkin({ sheetPng, heroImage, heroRect, heroBox, mode = heroImage ? 'crop' : 'redraw', deps, onProgress = () => {} }) {
  let master;
  if (mode === 'crop') {
    onProgress({ stage: 'master', label: '從設定圖取出主角、去背' });
    const flat = ops.flattenOnWhite(heroImage);
    // 設定圖背景是單色：用「從四邊灌背景色」去背，漂浮的道具（程式碼視窗、星星）都會留著；
    // 背景有花紋才用 macOS 主體擷取（它只留主體，會丟掉漂浮的東西）
    if (borderUniformity(flat) >= 0.85) master = ops.alphaFromBorder(flat);
    else {
      const cut = await deps.cutout(flat);
      master = cut && ops.opaqueShare(cut) > 0.03 ? cut : ops.alphaFromBorder(flat);
    }
    // 裁框切到的鄰居（標題字、旁邊的小圖）會黏在邊緣，刪掉；heroRect＝設定圖內容在主圖裡的範圍
    master = ops.dropEdgeFragments(master, heroRect || [0, 0, master.width, master.height]).image;
  } else {
    onProgress({ stage: 'master', label: '畫正面主圖（約 1 分鐘）' });
    const result = await deps.edit({ prompt: MASTER_PROMPT, image: sheetPng, extras: { input_fidelity: 'high' } });
    master = ops.chromaKey(result.image, 'green');
    if (ops.opaqueShare(master) > 0.9 || ops.opaqueShare(master) < 0.03) {
      onProgress({ stage: 'cutout', label: '去背' });
      const flat = ops.flattenOnWhite(result.image);
      master = (await deps.cutout(flat)) || ops.alphaFromBorder(flat);
    }
  }
  const masterFlat = ops.flattenOnWhite(master);
  onProgress({ stage: 'parts', label: '找出眼睛、嘴巴、配件的位置' });
  let parts = [];
  try {
    parts = normalizeParts(parseParts(await deps.chat({ prompt: PARTS_PROMPT, imagePng: ops.encodePng(masterFlat) })));
  } catch (error) {
    onProgress({ stage: 'parts', label: `AI 沒標出零件（${error.message.slice(0, 60)}），請自己框` });
  }
  // 設定圖上每個配件單獨畫的完整圖（配件要從這裡取，才是完整、沒被擋住的樣子）
  const accessories = parts.filter((part) => ACCESSORY_PARTS.includes(part.name)).map((part) => part.name);
  if (accessories.length && sheetPng) {
    onProgress({ stage: 'refs', label: '在設定圖上找每個配件的完整原稿' });
    try {
      const found = parseRefs(await deps.chat({ prompt: refsPrompt(accessories, heroBox), imagePng: sheetPng }), accessories, heroBox);
      parts = parts.map((part) => (found[part.name] ? { ...part, ...found[part.name] } : part));
    } catch (error) {
      onProgress({ stage: 'refs', label: `AI 沒找到配件原稿（${error.message.slice(0, 60)}），請自己框` });
    }
  }
  return { master, masterFlat, parts: normalizeParts(parts), mode };
}

/** 圖四邊的像素有多少比例接近同一個顏色（1＝單色背景） */
function borderUniformity(image) {
  const { width, height, data } = image;
  const points = [];
  for (let x = 0; x < width; x += 4) points.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 4) points.push(y * width, y * width + width - 1);
  const median = [0, 1, 2].map((c) => { const v = points.map((p) => data[p * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
  return points.filter((p) => Math.abs(data[p * 4] - median[0]) + Math.abs(data[p * 4 + 1] - median[1]) + Math.abs(data[p * 4 + 2] - median[2]) <= 30).length / points.length;
}

/**
 * 從設定圖切下一個配件的完整原稿。box：設定圖上 0～1000 的框。
 * 回傳 { image（透明背景）, flat（原稿像素）, ink（原稿上有畫東西的地方：比對的標準答案）, tight（框在 image 裡的位置） }
 */
export function cutReference(sheet, box, { tolerance = 14, gap = 3 } = {}) {
  const W = sheet.width; const H = sheet.height;
  const bx0 = (box[0] / 1000) * W; const by0 = (box[1] / 1000) * H; const bx1 = (box[2] / 1000) * W; const by1 = (box[3] / 1000) * H;
  const pad = Math.max(4, Math.round(0.06 * Math.max(bx1 - bx0, by1 - by0)));
  const x0 = Math.max(0, Math.floor(bx0 - pad)); const y0 = Math.max(0, Math.floor(by0 - pad));
  const x1 = Math.min(W, Math.ceil(bx1 + pad)); const y1 = Math.min(H, Math.ceil(by1 + pad));
  if (x1 - x0 < 8 || y1 - y0 < 8) throw new Error('配件原稿的框太小了。');
  let flat = ops.flattenOnWhite(ops.crop(sheet, x0, y0, x1 - x0, y1 - y0));
  // 原稿通常很小：先放大到約 420px 再去背，邊緣比較細
  const scale = Math.min(4, Math.max(1, 420 / Math.max(flat.width, flat.height)));
  if (scale > 1) flat = ops.flattenOnWhite(ops.resize(flat, Math.round(flat.width * scale), Math.round(flat.height * scale)));
  const tight = [(bx0 - x0) * scale, (by0 - y0) * scale, (bx1 - x0) * scale, (by1 - y0) * scale].map(Math.round);
  // 背景可能有兩種顏色（頁面白底、配件卡片的淡紫底）；卡片底色被卡片框線圍住，要從框的外圈另外灌
  const background = ops.backgroundPalette(flat, [tight]);
  const seeds = [];
  const [tx0, ty0, tx1, ty1] = tight;
  for (let x = Math.max(0, tx0); x < Math.min(flat.width, tx1); x += 3) for (const y of [ty0, ty1 - 1]) if (y >= 0 && y < flat.height) seeds.push(y * flat.width + x);
  for (let y = Math.max(0, ty0); y < Math.min(flat.height, ty1); y += 3) for (const x of [tx0, tx1 - 1]) if (x >= 0 && x < flat.width) seeds.push(y * flat.width + x);
  const isBg = (p) => background.some((c) => Math.abs(flat.data[p * 4] - c[0]) <= tolerance && Math.abs(flat.data[p * 4 + 1] - c[1]) <= tolerance && Math.abs(flat.data[p * 4 + 2] - c[2]) <= tolerance);
  let image = ops.alphaFromBorder(flat, { tolerance, gap, holes: true, background, seeds: seeds.filter(isBg) });
  image = ops.keepComponentsInside(image, tight, { share: 0.5, alphaMin: 120 });
  const ink = ops.dropFrames(ops.inkMask(flat, tight, { background }), flat.width, flat.height, tight);
  return { image, flat, ink, background, tight, scale };
}

/**
 * 和設計稿比對：把原稿用同樣的擺位投影到畫布上，看配件圖層（前＋後）有沒有
 *   完整（原稿畫到的地方都在）、像素一樣、沒有多出原稿以外的東西、沒有被畫布切掉。
 * 回傳 { score, pass, coverage, fidelity, stray, lost }（0～1）
 */
export function compareWithDesign(ref, placement, layers, size = WORK_SIZE) {
  const { inverse } = ops.placementMatrix(placement, ref.flat.width, ref.flat.height);
  const refWarped = ops.warpAffine(ref.flat, inverse, size, size);
  const inkImage = { width: ref.flat.width, height: ref.flat.height, data: new Uint8Array(ref.flat.width * ref.flat.height * 4) };
  let inkCount = 0;
  for (let p = 0; p < ref.ink.length; p += 1) if (ref.ink[p]) { inkImage.data[p * 4 + 3] = 255; inkCount += 1; }
  const inkWarped = ops.warpAffine(inkImage, inverse, size, size);
  const [tx0, ty0, tx1, ty1] = ref.tight;
  const zoneImage = { width: ref.flat.width, height: ref.flat.height, data: new Uint8Array(ref.flat.width * ref.flat.height * 4) };
  for (let y = Math.max(0, ty0 - 4); y < Math.min(ref.flat.height, ty1 + 4); y += 1) for (let x = Math.max(0, tx0 - 4); x < Math.min(ref.flat.width, tx1 + 4); x += 1) zoneImage.data[(y * ref.flat.width + x) * 4 + 3] = 255;
  const zone = ops.dilate(ops.opaqueArea(ops.warpAffine(zoneImage, inverse, size, size), 8), size, size, 4);
  const palette = ref.background || [[255, 255, 255]];
  const isBg = (i) => palette.some((c) => Math.abs(refWarped.data[i] - c[0]) + Math.abs(refWarped.data[i + 1] - c[1]) + Math.abs(refWarped.data[i + 2] - c[2]) <= 30);
  let inkHere = 0; let covered = 0; let same = 0; let layerCount = 0; let stray = 0;
  for (let p = 0; p < size * size; p += 1) {
    const i = p * 4;
    const alpha = Math.max(...layers.map((layer) => layer.data[i + 3]));
    // 多出來的：原稿框外的東西，或是把原稿的背景（白底、卡片底色）也留下來了
    if (alpha > 64) { layerCount += 1; if (!zone[p] || (inkWarped.data[i + 3] <= 20 && refWarped.data[i + 3] > 200 && isBg(i))) stray += 1; }
    if (inkWarped.data[i + 3] <= 127) continue;
    inkHere += 1;
    if (alpha <= 64) continue;
    covered += 1;
    const layer = layers.find((candidate) => candidate.data[i + 3] > 64) || layers[0];
    const diff = Math.abs(layer.data[i] - refWarped.data[i]) + Math.abs(layer.data[i + 1] - refWarped.data[i + 1]) + Math.abs(layer.data[i + 2] - refWarped.data[i + 2]);
    if (diff < 60) same += 1;
  }
  const expected = inkCount * placement.scale * placement.scale;
  const coverage = inkHere ? covered / inkHere : 0;
  const fidelity = covered ? same / covered : 0;
  const strayShare = layerCount ? stray / layerCount : 1;
  const lost = expected ? Math.max(0, 1 - inkHere / expected) : 1;
  const score = coverage * fidelity * (1 - strayShare) * (1 - Math.min(1, lost));
  const round = (n) => Math.round(n * 1000) / 1000;
  return { score: round(score), pass: score >= PASS_SCORE, coverage: round(coverage), fidelity: round(fidelity), stray: round(strayShare), lost: round(lost) };
}

/**
 * 本體圖上還留著配件的比例：配件範圍裡，本體的顏色明顯不是身體的顏色（和身體一般的顏色差很多），
 * 卻和主圖上的配件接近 → 本體上還畫著配件。
 */
export function remnantShare(body, master, area) {
  const size = area.length;
  const channels = [[], [], []];
  for (let p = 0; p < size; p += 7) if (body.data[p * 4 + 3] > 200 && !area[p]) for (let c = 0; c < 3; c += 1) channels[c].push(body.data[p * 4 + c]);
  if (!channels[0].length) return 0;
  const typical = channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
  let total = 0; let left = 0;
  for (let p = 0; p < size; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    if (body.data[i + 3] < 128 || master.data[i + 3] < 128) continue;
    total += 1;
    const fromBody = Math.abs(body.data[i] - typical[0]) + Math.abs(body.data[i + 1] - typical[1]) + Math.abs(body.data[i + 2] - typical[2]);
    const fromMaster = Math.abs(body.data[i] - master.data[i]) + Math.abs(body.data[i + 1] - master.data[i + 1]) + Math.abs(body.data[i + 2] - master.data[i + 2]);
    if (fromBody > 150 && fromMaster < 120) left += 1;
  }
  return total < 1500 ? 0 : left / total;
}

const toPixels = (part) => ops.boxToPixels(part.box, WORK_SIZE, WORK_SIZE);
const yieldToApp = () => new Promise((resolve) => setImmediate(resolve)); // 計算量大的步驟之間讓 App 喘口氣

/**
 * 第二段：確認過的零件框 → 造型包（RGBA 1024 的各圖層＋manifest）。
 * only：只重做這些項目（'body'＝重畫身體與表情、'accessories'＝重新分出配件、'face:done'…）；previous：上一次的圖層，沒重做的沿用。
 */
export async function buildSkin({ master, masterFlat, parts, sheet, masks = {}, deps, onProgress = () => {}, only, previous = {}, previousStatic = [], previousLayout = {}, concurrency = 3 }) {
  const W = WORK_SIZE;
  // ⓪ 放到畫布上：主角的身體對齊預設小精靈的大小、位置（畫布是小精靈方框的 1.5 倍）
  // 舊版造型的擺位是舊畫布的座標：不能沿用
  const sameCanvas = previousLayout.canvas === CANVAS_ID;
  const onCanvas = placeOnCanvas(master, normalizeParts(parts).map((part) => (sameCanvas ? part : { ...part, place: undefined, maskRef: undefined })));
  master = onCanvas.master;
  masterFlat = ops.flattenOnWhite(master);
  const byName = Object.fromEntries(onCanvas.parts.map((part) => [part.name, part]));
  const faceParts = FACE_PARTS.filter((name) => byName[name]);
  if (!faceParts.some((name) => name.endsWith('eye'))) throw new Error('至少要框出一隻眼睛，才能做表情。');
  const allAccessories = ACCESSORY_PARTS.filter((name) => byName[name]);
  // 和角色融為一體的配件：畫在特製主體上；獨立的配件才分層
  const fused = allAccessories.filter((name) => byName[name].layer === 'fused');
  const accessories = allAccessories.filter((name) => !fused.includes(name));
  const fusedChanged = fused.join(',') !== (previousLayout.fused || []).join(',');
  // 給模型的描述：真正的名稱（盤點時看圖模型給的）＋在圖上的大概位置
  const describe = (name) => {
    const b = byName[name].box;
    const what = byName[name].label ? `the ${byName[name].label}` : ACCESSORY_NAMES[name].replace(/ \(.*\)$/, '');
    return `${what} (around ${Math.round((b[0] + b[2]) / 20)}% from the left and ${Math.round((b[1] + b[3]) / 20)}% from the top of the image)`;
  };
  // 舊版造型（畫布不同）或融為一體的配件換了：特製主體要重畫
  const redoBody = !only || only.includes('body') || !previous.base || !previous._body || fusedChanged || previousLayout.canvas !== CANVAS_ID;
  const redoAccessories = accessories.length > 0 && (!only || only.includes('accessories') || redoBody);
  const wantsFace = (state) => redoBody || only.includes(`face:${state}`) || !(previous[`_face-${state}`] || previous[`face-${state}`]);
  const key = ops.keyShare(masterFlat, new Uint8Array(W * W).fill(1), 'green') < 0.002 ? 'green' : 'magenta';
  const masterFlatPng = ops.encodePng(masterFlat);
  const faceArea = ops.ellipseArea(W, W, faceParts.map((name) => toPixels(byName[name])));
  const outsideAccessories = ops.rectArea(W, W, allAccessories.map((name) => toPixels(byName[name])), 24).map((value) => (value ? 0 : 1));

  const layers = { ...previous };
  const report = {};
  const debug = {};
  const checks = { ...(previousLayout.checks || {}) };
  const placements = { ...(previousLayout.placements || {}) };
  const refImages = {};
  const layout = { z: previousLayout.z || {}, fused };
  report.canvas = onCanvas.report;
  const faceJobs = FACE_STATES.filter((state) => state !== 'idle' && wantsFace(state));
  const total = (redoBody ? 1 : 0) + faceJobs.length + (redoAccessories && deps.segment ? 1 : 0) + (redoAccessories ? accessories.length : 0);
  let done = 0;
  const step = (label) => { done += 1; onProgress({ stage: 'layers', label, done, total }); };
  if (total) onProgress({ stage: 'layers', label: `產生圖層（共 ${total} 張，約 ${Math.ceil(total / concurrency) + 1}～${Math.ceil(total / 2) + 2} 分鐘）`, done, total });

  // ① 配件範圍：本機 SAM 2.1 依零件框切割（和身體同時進行；不用生圖）
  const faceCenter = (() => {
    const boxes = faceParts.map((name) => toPixels(byName[name]));
    return [boxes.reduce((sum, b) => sum + (b.x0 + b.x1) / 2, 0) / boxes.length, boxes.reduce((sum, b) => sum + (b.y0 + b.y1) / 2, 0) / boxes.length];
  })();
  const samWork = redoAccessories && deps.segment ? (async () => {
    try {
      const masks = await deps.segment({
        imagePng: masterFlatPng,
        boxes: Object.fromEntries(accessories.map((name) => { const b = toPixels(byName[name]); return [name, [b.x0, b.y0, b.x1, b.y1]]; })),
        negative: [faceCenter.map(Math.round)], // 臉的中央「不是配件」，避免把整個身體切進去
      });
      step('切出配件（本機 SAM）');
      return masks;
    } catch (error) {
      report.segment = { error: error.message };
      step('切出配件（本機 SAM 失敗，改用比對）');
      return null;
    }
  })() : Promise.resolve(null);

  // ② 沒有配件的身體 → 整張就是身體圖層
  // 沿用的本體也清一次背景殘影（舊版沒有這一步）
  let body = previous._body || previous.base ? trimHaze(previous._body || previous.base) : undefined;
  const drawBody = async (strict) => {
      const result = await deps.edit({ prompt: bodyPrompt(accessories.map(describe), key, strict, fused.map(describe)), image: masterFlatPng, extras: { input_fidelity: 'high' } });
      debug[strict ? 'raw-body-retry' : 'raw-body'] = result.image;
      let keyed = ops.chromaKey(result.image, key);
      if (ops.opaqueShare(keyed) > 0.9 || ops.opaqueShare(keyed) < 0.05) {
        // 模型沒畫純色背景：改用本機去背，再不行就把接近純白的地方當透明
        const flat = ops.flattenOnWhite(result.image);
        keyed = (await deps.cutout(flat)) || ops.alphaFromWhite(flat, new Uint8Array(W * W).fill(1));
        report.body = { cutout: 'fallback' };
      }
      await yieldToApp();
      keyed = trimHaze(clearBorder(keyed, result.image));
      const { transform, warp } = ops.alignTo(masterFlat, ops.flattenOnWhite(keyed), outsideAccessories);
      report.body = { ...(report.body || {}), align: transform };
      return warp(keyed, [0, 0, 0, 0]);
  };
  let samMasks = null;
  if (redoBody) {
    // ② 特製主體：拿掉獨立的配件和特效，融為一體的配件照物理邏輯戴好（一次生圖）
    [body, samMasks] = await Promise.all([drawBody(false), samWork]);
    step(fused.length ? `特製主體（戴著${fused.map(labelOf).join('、')}）` : '特製主體');
    // 檢查本體上有沒有殘留獨立配件（例如鍵盤還在）：有就加強指示重畫一次
    const remnant = remnantCheck(body);
    if (remnant && remnant.share > 0.2) {
      onProgress({ stage: 'layers', label: `本體上還留著${labelOf(remnant.name)}，重畫一次`, done, total });
      const retry = await drawBody(true);
      const again = remnantCheck(retry);
      report.body.remnant = { first: remnant, retry: again };
      if (!again || again.share < remnant.share) body = retry;
    } else if (remnant) report.body.remnant = { first: remnant };
    const last = report.body.remnant ? (report.body.remnant.retry && report.body.remnant.retry.share < report.body.remnant.first.share ? report.body.remnant.retry : report.body.remnant.first) : null;
    const canvasNote = onCanvas.report.bodySize < 0.995
      ? `配件比較寬，為了整隻放得進畫布，身體是預設小精靈的 ${Math.round(onCanvas.report.bodySize * 100)}% 大`
      : '大小、位置已對齊預設小精靈';
    checks.body = last
      ? { source: 'body', pass: last.share <= 0.2, remnant: last.share, name: last.name, note: last.share <= 0.2 ? `本體上沒有殘留獨立配件；${canvasNote}` : `本體上還看得到${labelOf(last.name)}的一部分（約 ${Math.round(last.share * 100)}%），可以按「重畫本體與表情」再試一次` }
      : { source: 'body', pass: null, note: accessories.length ? `沒有本機切割工具，無法檢查本體上有沒有殘留配件；${canvasNote}` : canvasNote };
    layers._body = body; // 含五官的本體（改表情時用）；base（不含五官）在拆五官時產生
  }
  layers._body = body;
  function labelOf(name) { return byName[name]?.labelZh || PART_LABELS[name]; }
  function remnantCheck(candidate) {
    if (!samMasks) return null;
    let worst = null;
    for (const name of accessories) {
      if (name === 'face_accessory' || !samMasks[name]) continue; // 眼鏡是半透明的，蓋在臉上，比不準
      const area = samMasks[name].area.map((value, p) => (value && !faceArea[p] ? 1 : 0));
      const share = Math.round(remnantShare(candidate, master, area) * 1000) / 1000;
      if (!worst || share > worst.share) worst = { name, share };
    }
    return worst;
  }
  const bodyFlat = ops.flattenOnWhite(body);

  // ③ 表情：請模型在本體上改眼睛和嘴巴（每個表情一張），再把五官「一個一個」拆出來：
  //    本體不含五官（用周圍的皮膚顏色補起來），左眼、右眼、嘴巴各自一層，每個表情各一張。
  const faceZone = ops.dilate(faceArea, W, W, 64);
  for (let p = 0; p < faceZone.length; p += 1) if (body.data[p * 4 + 3] < 8) faceZone[p] = 0;
  const outsideFace = faceZone.map((value) => (value ? 0 : 1));
  const bodyFlatPng = ops.encodePng(bodyFlat);
  const faceMaskPng = ops.encodePng(ops.maskImage(bodyFlat, faceArea));
  const faceWork = mapLimit(faceJobs, Math.max(1, concurrency - 1), async (state) => {
    const result = await deps.edit({ prompt: `${FACE_PROMPTS[state]} ${KEEP_REST}`, image: bodyFlatPng, mask: faceMaskPng, extras: { input_fidelity: 'high' } });
    debug[`raw-face-${state}`] = result.image;
    await yieldToApp();
    const { transform, warp } = ops.alignTo(bodyFlat, ops.flattenOnWhite(result.image), outsideFace);
    const aligned = ops.flattenOnWhite(warp(result.image));
    // 只留臉附近改過的地方，其他和本體一樣（存起來，之後只重做某一個表情、或重新拆五官時用）
    const { region, stats } = ops.analyzeEdit(bodyFlat, aligned, faceArea);
    layers[`_face-${state}`] = ops.compositeInArea(bodyFlat, aligned, region, 4);
    report[`face-${state}`] = { ...stats, align: transform };
    step(`${FACE_LABELS[state]}的臉`);
  });

  await faceWork;
  if (!samMasks) samMasks = await samWork;

  // 拆五官：本體上的眼睛、嘴巴拿掉 → 不含五官的本體；每個表情和它比，不一樣的地方就是五官
  {
    const features = faceParts.map((name) => ({ name, key: FEATURE_KEY[name], box: toPixels(byName[name]) }));
    const { faceless, removed } = removeFeatures(bodyFlat, body, features.map((feature) => feature.box));
    layers.base = faceless;
    debug['face-removed'] = ops.overlayArea(bodyFlat, removed);
    const facelessFlat = ops.flattenOnWhite(faceless);
    const zone = ops.dilate(faceArea, W, W, 40);
    for (let p = 0; p < zone.length; p += 1) if (body.data[p * 4 + 3] < 128) zone[p] = 0;
    for (const old of Object.keys(layers)) if (/^face-/.test(old)) delete layers[old]; // 舊版「整塊臉」圖層
    for (const state of FACE_STATES) {
      let source = state === 'idle' ? bodyFlat : layers[`_face-${state}`];
      if (!source && previous[`face-${state}`]) source = ops.flattenOnWhite(compositeOver(bodyFlat, previous[`face-${state}`])); // 舊版存的表情
      if (!source) continue;
      if (state !== 'idle' && !layers[`_face-${state}`]) layers[`_face-${state}`] = source;
      const parts = extractFeatures(source, facelessFlat, body, zone, features);
      for (const feature of features) layers[`${feature.key}-${state}`] = parts[feature.key];
      report[`features-${state}`] = Object.fromEntries(features.map((feature) => [feature.key, ops.opaqueArea(parts[feature.key], 64).reduce((sum, value) => sum + value, 0)]));
    }
  }

  // ④ 配件圖層：塗色範圍裡的主圖像素（不含眼睛、嘴巴）；塗色失敗的配件退回「主圖 − 身體」
  // 被臉上配件（眼鏡）框住的眼睛：先留在配件裡，之後換成半透明的鏡片
  const lensEyes = byName.face_accessory ? ['left_eye', 'right_eye'].filter((name) => {
    if (!byName[name]) return false;
    const eye = toPixels(byName[name]); const acc = toPixels(byName.face_accessory);
    const cx = (eye.x0 + eye.x1) / 2; const cy = (eye.y0 + eye.y1) / 2;
    return cx > acc.x0 && cx < acc.x1 && cy > acc.y0 && cy < acc.y1;
  }) : [];
  const otherFace = ops.ellipseArea(W, W, faceParts.filter((name) => !lensEyes.includes(name)).map((name) => toPixels(byName[name])));
  let segments = {};
  if (redoAccessories) {
    for (const name of ACCESSORY_PARTS) { delete layers[name]; delete layers[`${name}_back`]; delete checks[name]; delete placements[name]; }
    segments = {};
    const masterArea = ops.opaqueArea(master, 8);
    if (samMasks) {
      for (const name of accessories) {
        const mask = samMasks[name];
        if (!mask) continue;
        // 限制在零件框附近 96px、主圖不透明的地方，去掉零星碎塊
        const zone = ops.rectArea(W, W, [toPixels(byName[name])], 96);
        segments[name] = ops.withoutColors(mask.area.map((value, p) => (value && zone[p] && masterArea[p] ? 1 : 0)), masterFlat, [], { minSize: 150 });
        report[name] = { method: '本機 SAM', score: mask.score };
      }
    }
    const missing = accessories.filter((name) => !segments[name] || ops.areaSize(segments[name]) < 100);
    if (missing.length) {
      const fallback = ops.accessoriesFromBody({
        master, masterFlat, body, bodyFlat,
        boxes: Object.fromEntries(accessories.map((name) => [name, toPixels(byName[name])])), exclude: otherFace,
      });
      for (const name of missing) { segments[name] = fallback[name]; report[name] = { ...(report[name] || {}), method: '主圖 − 身體（比對）' }; }
    }
    // 兩個配件的範圍重疊時，重疊的像素只歸一個（框中心比較近的那個）
    const centers = Object.fromEntries(accessories.map((name) => { const b = toPixels(byName[name]); return [name, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]]; }));
    for (let p = 0; p < W * W; p += 1) {
      let count = 0;
      for (const name of accessories) if (segments[name]?.[p]) count += 1;
      if (count < 2) continue;
      const x = p % W; const y = (p - x) / W;
      const holders = accessories.filter((name) => segments[name]?.[p]);
      const keep = holders.reduce((best, name) => ((x - centers[name][0]) ** 2 + (y - centers[name][1]) ** 2 < (x - centers[best][0]) ** 2 + (y - centers[best][1]) ** 2 ? name : best));
      for (const name of holders) if (name !== keep) segments[name][p] = 0;
    }
    for (const name of accessories) {
      const segment = segments[name];
      const keepOut = name === 'face_accessory' ? otherFace : faceArea;
      for (let p = 0; p < segment.length; p += 1) if (keepOut[p]) segment[p] = 0;
      const pixels = ops.areaSize(segment);
      report[name] = { ...(report[name] || {}), pixels };
      if (pixels < 100) { report[name].skipped = '找不到這個配件'; continue; }
      debug[`segment-${name}`] = ops.overlayArea(masterFlat, segment);
      const part = byName[name];
      const placed = sheet && part.refs?.length ? await placeFromReference({ name, part, sheet, master, segment, segments, accessories, mask: masks[name] }) : null;
      if (placed) {
        Object.assign(layers, placed.layers);
        checks[name] = placed.check;
        placements[name] = placed.placement;
        refImages[name] = placed.refImage;
        report[name] = { ...report[name], method: '設定圖上的完整原稿', check: placed.check, tried: placed.tried };
        step(`${labelOf(name)}：和設計稿 ${Math.round(placed.check.score * 1000) / 10}% 相同`);
      } else {
        // 設定圖上沒有單獨的配件圖：只能從主圖切（被擋住的部分沒有），無法和原稿比對
        layers[name] = ops.keepArea(master, segment, master);
        checks[name] = { source: 'hero', score: null, pass: false, note: '設定圖上沒有找到這個配件單獨畫的圖，只能從主角圖切出看得到的部分' };
        step(`${labelOf(name)}：從主角圖切出`);
      }
    }
    layout.z = stackOrder(accessories, layers, segments);
    // 眼鏡對準身體上的眼睛：身體是模型畫的，眼睛位置和主圖差一點；鏡片中間換成半透明，眼睛（含眨眼）從底下透出來
    if (layers.face_accessory && lensEyes.length) {
      const eye = toPixels(byName[lensEyes[0]]);
      const inMaster = ops.darkCentroid(masterFlat, eye);
      const inBody = ops.darkCentroid(bodyFlat, eye, 40);
      let dx = 0; let dy = 0;
      if (inMaster && inBody && Math.hypot(inBody.x - inMaster.x, inBody.y - inMaster.y) < 80) {
        dx = Math.round(inBody.x - inMaster.x); dy = Math.round(inBody.y - inMaster.y);
        if (dx || dy) layers.face_accessory = ops.warpSimilarity(layers.face_accessory, { s: 1, tx: -dx, ty: -dy }, [0, 0, 0, 0]);
      }
      const lens = ops.ellipseArea(W, W, lensEyes.map((name) => { const b = toPixels(byName[name]); return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }; }), 0.35);
      layers.face_accessory = ops.tintLens(layers.face_accessory, lens);
      report.face_accessory = { ...report.face_accessory, lens: { eye: lensEyes[0], shift: [dx, dy] } };
    }
  }
  // 和角色融為一體的配件：畫在特製主體上，沒有自己的圖層；不和設計稿比對
  for (const name of fused) {
    delete layers[name]; delete layers[`${name}_back`]; delete placements[name];
    checks[name] = { source: 'fused', pass: true, score: null, note: '和角色融為一體：畫在特製主體上、跟著本體動，照物理邏輯戴好為主，不和設計稿比對' };
  }
  // ⑤ 特效最後補：主角圖上「不是本體、也不是獨立配件」的星星、閃光、光圈
  if (redoBody || redoAccessories) {
    const fx = extractEffects({ master, body, layers: accessories.flatMap((name) => [layers[name], layers[`${name}_back`]]).filter(Boolean), segments });
    if (fx.count) { layers.fx = fx.layer; checks.fx = { source: 'fx', pass: true, score: null, count: fx.count, note: `從設計稿取出 ${fx.count} 個特效（星星、閃光、光圈），放在最上層一閃一閃` }; }
    else { delete layers.fx; delete checks.fx; }
    report.fx = { count: fx.count };
  }
  for (const name of Object.keys(checks)) if (ACCESSORY_PARTS.includes(name) && !allAccessories.includes(name)) delete checks[name];
  if (Object.keys(checks).length) report.checks = checks;
  const finalLayout = { z: layout.z, checks, placements, fused, canvas: CANVAS_ID };
  return { layers, report, debug, refImages, layout: finalLayout, staticParts: [], manifest: manifestFor({ parts: Object.values(byName), layers, z: layout.z }) };
}

const REF_VARIANTS = [{ tolerance: 14, gap: 3 }, { tolerance: 22, gap: 3 }, { tolerance: 32, gap: 2 }];

/**
 * 一個配件：試設定圖上每一張單獨的原稿 → 切下來（試幾種去背的鬆緊，取和原稿最像的）→ 擺到主圖上的位置 →
 * 依前後關係分成前層／後層 → 和設計稿比對。part.place（使用者在組裝台調過的擺位）優先。
 */
async function placeFromReference({ name, part, sheet, master, segment, segments, accessories, mask }) {
  const W = WORK_SIZE;
  let best = null;
  const tried = [];
  for (const [index, box] of part.refs.entries()) {
    const manual = part.place && part.place.ref === index ? part.place : null;
    let fit = manual ? { ...manual, fit: { score: 1, manual: true } } : null;
    let pick = null;
    for (const variant of REF_VARIANTS) {
      let ref;
      try { ref = cutReference(sheet, box, variant); } catch { continue; }
      if (ops.opaqueShare(ref.image) < 0.01) continue;
      await yieldToApp();
      if (!fit) { try { fit = ops.fitPlacement(ref.image, master, segment, { order: part.layer || 'front' }); } catch { break; } }
      const { inverse } = ops.placementMatrix(fit, ref.image.width, ref.image.height);
      const layer = ops.warpAffine(ref.image, inverse, W, W);
      // 使用者畫的遮罩（畫在這張原稿上、這個擺位）優先；沒有才照前後關係自動算
      const useMask = mask && mask.ref === index && manual;
      const split = useMask
        ? splitByMask(layer, ops.warpAffine(mask.image.width === ref.image.width && mask.image.height === ref.image.height ? mask.image : ops.resize(mask.image, ref.image.width, ref.image.height), inverse, W, W))
        : splitBehind(layer, { order: part.layer, master, segment, segments, name, accessories });
      const check = compareWithDesign(ref, fit, [split.front, split.back].filter(Boolean));
      if (!pick || check.score > pick.check.score) pick = { ref, fit, split, check };
    }
    if (!pick) continue;
    tried.push({ ref: index, fit: Math.round(pick.fit.fit.score * 1000) / 1000, check: pick.check.score });
    // 先求合格，再求姿勢和主角圖最像；使用者調過的擺位最優先
    const rank = (manual ? 10 : 0) + (pick.check.pass ? 2 : 0) + pick.fit.fit.score + pick.check.score * 0.1;
    if (!best || rank > best.rank) best = { ...pick, index, rank };
  }
  if (!best) return null;
  const placement = { ref: best.index, flip: best.fit.flip, angle: Math.round(best.fit.angle * 10) / 10, scale: Math.round(best.fit.scale * 10000) / 10000, cx: Math.round(best.fit.cx * 10) / 10, cy: Math.round(best.fit.cy * 10) / 10, manual: Boolean(best.fit.fit.manual) };
  const out = {};
  if (best.split.front) out[name] = best.split.front;
  if (best.split.back) out[`${name}_back`] = best.split.back;
  return {
    layers: out,
    placement,
    refImage: best.ref.image,
    check: { ...best.check, source: 'sheet', ref: best.index, fit: Math.round(best.fit.fit.score * 1000) / 1000, order: part.layer || 'front', mask: Boolean(mask && mask.ref === best.index && part.place) },
    tried,
  };
}

/**
 * 前後關係：'front' 全部在身體前面；'behind' 全部在身體後面；
 * 'wraps' 擺好的配件落在「主圖上是身體」的地方（不是這個配件、也不是別的配件）＝被身體擋住 → 分到後層。
 */
export function splitBehind(layer, { order = 'front', master, segment, segments = {}, name, accessories = [] }) {
  const W = layer.width;
  if (order === 'behind') return { front: null, back: layer };
  if (order !== 'wraps') return { front: layer, back: null };
  const near = ops.dilate(segment, W, W, 12);
  const others = new Uint8Array(W * W);
  for (const other of accessories) if (other !== name && segments[other]) for (let p = 0; p < others.length; p += 1) if (segments[other][p]) others[p] = 1;
  let hidden = new Uint8Array(W * W);
  let count = 0;
  for (let p = 0; p < hidden.length; p += 1) {
    if (layer.data[p * 4 + 3] > 76) count += 1;
    if (layer.data[p * 4 + 3] > 76 && master.data[p * 4 + 3] > 128 && !near[p] && !others[p]) hidden[p] = 1;
  }
  // 只留大塊、邊緣平順的被擋住範圍（擺位和主圖差一點時，零碎的小塊不算被擋住，不然配件會被挖得坑坑洞洞）
  hidden = ops.dilate(ops.erode(hidden, W, W, 6), W, W, 6);
  hidden = ops.withoutColors(hidden, master, [], { minSize: Math.max(400, Math.round(count * 0.04)) });
  if (ops.areaSize(hidden) < count * 0.05) return { front: layer, back: null };
  const soft = ops.boxBlur(Float32Array.from(hidden), W, W, 3);
  const front = { ...layer, data: new Uint8Array(layer.data) };
  const back = { ...layer, data: new Uint8Array(layer.data) };
  for (let p = 0; p < soft.length; p += 1) {
    const a = layer.data[p * 4 + 3] / 255;
    const af = a * (1 - soft[p]);
    // 前層疊在後層上面要剛好還原成原本的透明度（不然交界會出現一條淡淡的縫）
    const ab = af >= 1 ? 0 : (a - af) / (1 - af);
    front.data[p * 4 + 3] = Math.round(af * 255);
    back.data[p * 4 + 3] = Math.round(Math.max(0, Math.min(1, ab)) * 255);
  }
  return { front, back };
}

/** 依遮罩分前後：遮罩不透明的地方放到身體後面（前層＋後層疊起來剛好還原，不會有縫） */
export function splitByMask(layer, maskLayer) {
  const size = layer.width * layer.height;
  let any = 0;
  for (let p = 0; p < size; p += 1) if (maskLayer.data[p * 4 + 3] > 20 && layer.data[p * 4 + 3] > 20) { any += 1; if (any > 30) break; }
  if (any <= 30) return { front: layer, back: null };
  const front = { ...layer, data: new Uint8Array(layer.data) };
  const back = { ...layer, data: new Uint8Array(layer.data) };
  let frontCount = 0;
  for (let p = 0; p < size; p += 1) {
    const a = layer.data[p * 4 + 3] / 255;
    const m = maskLayer.data[p * 4 + 3] / 255;
    const af = a * (1 - m);
    const ab = af >= 1 ? 0 : (a - af) / (1 - af);
    front.data[p * 4 + 3] = Math.round(af * 255);
    back.data[p * 4 + 3] = Math.round(Math.max(0, Math.min(1, ab)) * 255);
    if (front.data[p * 4 + 3] > 20) frontCount += 1;
  }
  return { front: frontCount > 30 ? front : null, back };
}

/** 配件之間的前後：A 擺好後落在主圖上 B 的位置（被 B 擋住）→ A 在 B 下面 */
export function stackOrder(accessories, layers, segments) {
  const names = accessories.filter((name) => layers[name]);
  const z = Object.fromEntries(names.map((name) => [name, LAYER_Z[name]]));
  const below = [];
  for (const a of names) for (const b of names) {
    if (a === b || !segments[b]) continue;
    let total = 0; let under = 0;
    for (let p = 0; p < segments[b].length; p += 4) {
      if (layers[a].data[p * 4 + 3] <= 76) continue;
      total += 1;
      if (segments[b][p]) under += 1;
    }
    if (total && under / total > 0.03) below.push([a, b, under / total]);
  }
  for (let pass = 0; pass < names.length * 2; pass += 1) {
    let changed = false;
    for (const [a, b, share] of below) {
      const reverse = below.find(([x, y]) => x === b && y === a);
      if (reverse && reverse[2] >= share) continue; // 互相擋：以擋得多的那邊為準
      if (z[a] >= z[b]) { [z[a], z[b]] = [z[b], z[a]]; changed = true; }
    }
    if (!changed) break;
  }
  return z;
}

/**
 * 模型沒照指示畫純色鍵（例如畫成粉紅、灰色的底）：去背後四邊還是不透明 → 改從四邊灌「接近背景色」的地方變透明。
 */
export function clearBorder(keyed, raw) {
  const W = keyed.width; const H = keyed.height;
  const border = [];
  for (let x = 0; x < W; x += 8) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y += 8) border.push(y * W, y * W + W - 1);
  const solid = border.filter((p) => keyed.data[p * 4 + 3] > 20).length / border.length;
  if (solid < 0.2) return keyed;
  const cut = ops.alphaFromBorder(ops.flattenOnWhite(raw), { tolerance: 36, gap: 3 });
  const data = new Uint8Array(keyed.data);
  for (let p = 0; p < W * H; p += 1) data[p * 4 + 3] = Math.min(data[p * 4 + 3], cut.data[p * 4 + 3]);
  return { ...keyed, data };
}

/**
 * 清掉本體圖上的「背景殘影」：模型畫的背景不一定是純色鍵（例如偏紅的洋紅），去背後會留下一整片半透明的底色。
 * 本體本身是實心的（不透明），只保留實心範圍和它邊緣 4px 的柔邊，其他半透明的地方都清掉。
 */
export function trimHaze(image, { solid = 200, edge = 4 } = {}) {
  const W = image.width; const H = image.height;
  const keep = ops.dilate(ops.opaqueArea(image, solid), W, H, edge);
  const data = new Uint8Array(image.data);
  let cleared = 0;
  const hazeAlpha = new Uint32Array(256);
  for (let p = 0; p < keep.length; p += 1) if (!keep[p] && data[p * 4 + 3]) { hazeAlpha[data[p * 4 + 3]] += 1; data[p * 4 + 3] = 0; cleared += 1; }
  // 有一整片殘影時，實心邊緣那一圈也混著同樣淡的底色：和殘影一樣淡（或更淡）的也清掉
  if (cleared > keep.length * 0.01) {
    let seen = 0; let level = 0;
    while (level < 255 && seen + hazeAlpha[level] < cleared / 2) { seen += hazeAlpha[level]; level += 1; }
    for (let p = 0; p < keep.length; p += 1) if (keep[p] && data[p * 4 + 3] && data[p * 4 + 3] <= Math.min(solid - 1, level + 20)) data[p * 4 + 3] = 0;
  }
  return { ...image, data, cleared };
}

/**
 * 把主角放到畫布上：身體框（parts 的 body）的大小、中心對齊預設小精靈的身體（PROTOTYPE_BODY），等比例縮放。
 * 沒有身體框時用整張主角的範圍估。回傳 { master, parts（框換成畫布上的座標）, report }
 */
export function placeOnCanvas(master, parts) {
  const W = master.width;
  const bodyPart = parts.find((part) => part.name === 'body');
  let box = bodyPart?.box.map((n) => (n / 1000) * W);
  if (!box) {
    const b = ops.alphaBounds(master, 32) || { x0: 0, y0: 0, x1: W, y1: W };
    // 整張主角含配件：身體大約是中間 70%
    const cx = (b.x0 + b.x1) / 2; const cy = (b.y0 + b.y1) / 2; const w = (b.x1 - b.x0) * 0.35; const h = (b.y1 - b.y0) * 0.35;
    box = [cx - w, cy - h, cx + w, cy + h];
  }
  const target = PROTOTYPE_BODY.map((n) => n * W);
  const protoScale = Math.sqrt(((target[2] - target[0]) * (target[3] - target[1])) / Math.max(1, (box[2] - box[0]) * (box[3] - box[1])));
  // 整隻（含漂浮的配件、特效）都要放得進畫布、四邊留 3%：身體中心固定對齊預設小精靈，放不下就整隻縮小（本體會比預設小精靈小一點）
  const all = ops.alphaBounds(master, 32) || { x0: box[0], y0: box[1], x1: box[2], y1: box[3] };
  const margin = W * 0.03;
  const from = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]; const to = [(target[0] + target[2]) / 2, (target[1] + target[3]) / 2];
  const limits = [
    from[0] - all.x0 > 0 ? (to[0] - margin) / (from[0] - all.x0) : Infinity, all.x1 - from[0] > 0 ? (W - margin - to[0]) / (all.x1 - from[0]) : Infinity,
    from[1] - all.y0 > 0 ? (to[1] - margin) / (from[1] - all.y0) : Infinity, all.y1 - from[1] > 0 ? (W - margin - to[1]) / (all.y1 - from[1]) : Infinity,
  ];
  const scale = Math.max(0.2, Math.min(protoScale, ...limits));
  // 畫布點 (x, y) ← 主角圖點 ((x − to) / scale + from)
  const placed = ops.warpAffine(master, [1 / scale, 0, from[0] - to[0] / scale, 0, 1 / scale, from[1] - to[1] / scale], W, W);
  const move = (n, axis) => Math.max(0, Math.min(1000, Math.round((((n / 1000) * W - from[axis]) * scale + to[axis]) / W * 1000)));
  const moved = parts.map((part) => ({ ...part, box: [move(part.box[0], 0), move(part.box[1], 1), move(part.box[2], 0), move(part.box[3], 1)] }));
  // 主角有沒有被畫布切掉（漂浮的配件太遠）
  const before = ops.opaqueShare(master) * W * W * scale * scale; const after = ops.opaqueShare(placed) * W * W;
  return { master: placed, parts: moved, report: { scale: Math.round(scale * 1000) / 1000, bodySize: Math.round((scale / protoScale) * 1000) / 1000, shift: [Math.round(to[0] - from[0] * scale), Math.round(to[1] - from[1] * scale)], cropped: Math.max(0, Math.round((1 - after / Math.max(1, before)) * 1000) / 1000), estimated: !bodyPart } };
}

/**
 * 特效：主角圖上「不是特製主體、也不是獨立配件」的小東西（星星、閃光、光圈、光軌）。
 * 本體邊緣的差異（AI 重畫的輪廓和主角圖差一點）不算：大部分貼著本體的塊、暗色的塊、太大的塊都不要。
 * 回傳 { layer（RGBA）, count }
 */
export function extractEffects({ master, body, layers = [], segments = {} }) {
  const W = master.width; const size = W * W;
  const covered = new Uint8Array(size);
  const bodyArea = ops.opaqueArea(body, 32);
  const near = ops.dilate(bodyArea, W, W, 24);
  for (const [area, grow] of [[bodyArea, 8], ...layers.map((layer) => [ops.opaqueArea(layer, 32), 8]), ...Object.values(segments).filter(Boolean).map((area) => [area, 10])]) {
    const grown = ops.dilate(area, W, W, grow);
    for (let p = 0; p < size; p += 1) if (grown[p]) covered[p] = 1;
  }
  const left = new Uint8Array(size);
  for (let p = 0; p < size; p += 1) if (!covered[p] && master.data[p * 4 + 3] > 40) left[p] = 1;
  const keep = new Uint8Array(size);
  let count = 0;
  for (const part of components(left, W)) {
    const n = part.pixels.length;
    if (n < 16 || n > size * 0.02) continue;
    let luma = 0; let sat = 0; let touching = 0;
    for (const p of part.pixels) {
      const i = p * 4; const r = master.data[i]; const g = master.data[i + 1]; const b = master.data[i + 2];
      luma += 0.299 * r + 0.587 * g + 0.114 * b; sat += Math.max(r, g, b) - Math.min(r, g, b);
      if (near[p]) touching += 1;
    }
    luma /= n; sat /= n;
    if (touching / n > 0.5) continue; // 貼著本體：多半是輪廓差異
    if (luma < 120 && sat < 90) continue; // 暗、不鮮豔：多半是配件的碎片
    count += 1;
    for (const p of part.pixels) keep[p] = 1;
  }
  const area = ops.dilate(keep, W, W, 1);
  const data = new Uint8Array(size * 4);
  for (let p = 0; p < size; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    data[i] = master.data[i]; data[i + 1] = master.data[i + 1]; data[i + 2] = master.data[i + 2]; data[i + 3] = master.data[i + 3];
  }
  return { layer: { width: W, height: W, data }, count };
}

const FEATURE_KEY = { left_eye: 'eye_left', right_eye: 'eye_right', mouth: 'mouth' };
const FEATURE_LAYER = [['eye_left', 'eye-left', 30], ['eye_right', 'eye-right', 31], ['mouth', 'mouth', 32]];

/** 圖層疊圖層（top 疊在 base 上） */
function compositeOver(base, top) {
  const data = new Uint8Array(base.data);
  for (let i = 0; i < data.length; i += 4) {
    const a = top.data[i + 3] / 255;
    if (!a) continue;
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.round(top.data[i + c] * a + data[i + c] * (1 - a));
    data[i + 3] = Math.max(data[i + 3], top.data[i + 3]);
  }
  return { ...base, data };
}

/** 一塊區域裡被圍起來的洞補滿（眼睛裡的反光點不會變成洞） */
function fillEnclosed(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0; let tail = 0;
  const push = (p) => { if (!outside[p] && !mask[p]) { outside[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++]; const x = p % width; const y = (p - x) / width;
    if (x > 0) push(p - 1); if (x < width - 1) push(p + 1); if (y > 0) push(p - width); if (y < height - 1) push(p + width);
  }
  return mask.map((value, p) => (value || !outside[p] ? 1 : 0));
}

/** 相連的一塊一塊：回傳 [{ pixels: [p…], cx, cy, strong }]（strong：塊裡和本體差最多的程度） */
function components(mask, width, diff) {
  const label = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  const result = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = result.length; let head = 0; let tail = 0; let sx = 0; let sy = 0; let strong = 0;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++]; const x = p % width; const y = (p - x) / width;
      sx += x; sy += y; if (diff) strong = Math.max(strong, diff[p]);
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < mask.length && mask[q] && label[q] < 0) { label[q] = id; queue[tail++] = q; }
      }
    }
    result.push({ pixels: Array.from(queue.subarray(0, tail)), cx: sx / tail, cy: sy / tail, strong });
  }
  return result;
}

/**
 * 從含五官的本體拿掉眼睛、嘴巴：框附近和周圍皮膚顏色差很多的地方＝五官，用周圍的顏色補起來。
 * 回傳 { faceless（不含五官的本體，RGBA）, removed（拿掉的範圍） }
 */
export function removeFeatures(bodyFlat, body, boxes) {
  const W = bodyFlat.width;
  const removed = new Uint8Array(W * W);
  for (const box of boxes) {
    const pad = Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * 0.15) + 4;
    const rx0 = Math.max(0, Math.floor(box.x0 - pad)); const ry0 = Math.max(0, Math.floor(box.y0 - pad));
    const rx1 = Math.min(W, Math.ceil(box.x1 + pad)); const ry1 = Math.min(W, Math.ceil(box.y1 + pad));
    // 周圍皮膚的顏色：框外一圈的中位數
    const ring = [[], [], []];
    for (let y = Math.max(0, ry0 - 12); y < Math.min(W, ry1 + 12); y += 1) for (let x = Math.max(0, rx0 - 12); x < Math.min(W, rx1 + 12); x += 1) {
      if (x >= rx0 && x < rx1 && y >= ry0 && y < ry1) continue;
      const p = y * W + x; if (body.data[p * 4 + 3] < 200) continue;
      for (let c = 0; c < 3; c += 1) ring[c].push(bodyFlat.data[p * 4 + c]);
    }
    if (!ring[0].length) continue;
    const skin = ring.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
    const skinLuma = 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2];
    const local = new Uint8Array(W * W);
    const diff = new Uint16Array(W * W);
    for (let y = ry0; y < ry1; y += 1) for (let x = rx0; x < rx1; x += 1) {
      const p = y * W + x; const i = p * 4;
      const d = Math.abs(bodyFlat.data[i] - skin[0]) + Math.abs(bodyFlat.data[i + 1] - skin[1]) + Math.abs(bodyFlat.data[i + 2] - skin[2]);
      diff[p] = d;
      // 只拿掉「比皮膚暗很多」的線條（眼睛、眉毛、嘴巴）；腮紅、反光比皮膚亮或差不多，留在本體上
      const luma = 0.299 * bodyFlat.data[i] + 0.587 * bodyFlat.data[i + 1] + 0.114 * bodyFlat.data[i + 2];
      if (d > 70 && luma < skinLuma - 45 && body.data[i + 3] > 128) local[p] = 1;
    }
    // 只留中心落在框裡的塊（臉頰的腮紅、身體輪廓線不算五官）
    for (const part of components(local, W, diff)) {
      if (part.cx < box.x0 - 4 || part.cx > box.x1 + 4 || part.cy < box.y0 - 4 || part.cy > box.y1 + 4 || part.pixels.length < 12) continue;
      for (const p of part.pixels) removed[p] = 1;
    }
  }
  // 往外多擴一圈：五官旁邊常有一圈淡淡的亮邊／陰影，要一起蓋掉，補色才會和周圍皮膚一樣
  const filled = ops.dilate(fillEnclosed(removed, W, W), W, W, 9);
  const faceless = ops.inpaint(body, filled);
  return { faceless, removed: filled };
}

/**
 * 從一個表情的圖拆出五官：和不含五官的本體不一樣的地方，一塊一塊分給最近的眼睛／嘴巴（眉毛、汗滴跟著最近的五官）。
 * 回傳 { eye_left, eye_right, mouth }（RGBA 圖層，透明背景）
 */
export function extractFeatures(source, facelessFlat, body, zone, features) {
  const W = source.width;
  const mask = new Uint8Array(W * W);
  const diff = new Uint16Array(W * W);
  for (let p = 0; p < mask.length; p += 1) {
    if (!zone[p]) continue;
    const i = p * 4;
    const d = Math.abs(source.data[i] - facelessFlat.data[i]) + Math.abs(source.data[i + 1] - facelessFlat.data[i + 1]) + Math.abs(source.data[i + 2] - facelessFlat.data[i + 2]);
    diff[p] = d;
    if (d > 60) mask[p] = 1;
  }
  const clean = ops.dilate(ops.erode(mask, W, W, 1), W, W, 1);
  const centers = features.map((feature) => [(feature.box.x0 + feature.box.x1) / 2, (feature.box.y0 + feature.box.y1) / 2]);
  const own = Object.fromEntries(features.map((feature) => [feature.key, new Uint8Array(W * W)]));
  for (const part of components(clean, W, diff)) {
    if (part.pixels.length < 25 || part.strong < 110) continue; // 小雜點、淡淡的陰影差異不算
    let best = 0;
    for (let k = 1; k < centers.length; k += 1) if (Math.hypot(part.cx - centers[k][0], part.cy - centers[k][1]) < Math.hypot(part.cx - centers[best][0], part.cy - centers[best][1])) best = k;
    for (const p of part.pixels) own[features[best].key][p] = 1;
  }
  const out = {};
  for (const feature of features) {
    const area = ops.dilate(fillEnclosed(own[feature.key], W, W), W, W, 1);
    const soft = ops.boxBlur(Float32Array.from(area), W, W, 1);
    const data = new Uint8Array(W * W * 4);
    for (let p = 0; p < area.length; p += 1) {
      if (soft[p] <= 0.01) continue;
      const i = p * 4;
      data[i] = source.data[i]; data[i + 1] = source.data[i + 1]; data[i + 2] = source.data[i + 2];
      data[i + 3] = Math.round(Math.min(1, soft[p]) * body.data[i + 3]);
    }
    out[feature.key] = { width: W, height: W, data };
  }
  return out;
}

export function manifestFor({ parts, layers, name = '', staticParts = [], z = {} }) {
  const byName = Object.fromEntries(parts.map((part) => [part.name, part]));
  const pivot = (part, mode) => {
    const [x0, y0, x1, y1] = part.box.map((n) => n / 1000);
    const round = (n) => Math.round(n * 1000) / 1000;
    return mode === 'brim' ? [round((x0 + x1) / 2), round(y1 - (y1 - y0) * 0.2)] : [round((x0 + x1) / 2), round((y0 + y1) / 2)];
  };
  const zOf = (part) => Math.max(40, Math.min(89, Number(z[part]) || LAYER_Z[part])); // 獨立配件在五官（30～32）上面、特效（90）下面
  const list = [
    ...ACCESSORY_PARTS.filter((part) => layers[part] && byName[part]).map((part) => ({
      id: part.replace('_', '-'), file: LAYER_FILE[part], z: zOf(part), motion: staticParts.includes(part) ? 'none' : LAYER_MOTION[part], pivot: pivot(byName[part], part === 'hat' ? 'brim' : 'center'),
    })),
    // 繞到身體後面的那一半：在身體下面，動作、支點和前半一樣（一起動）
    ...ACCESSORY_PARTS.filter((part) => layers[`${part}_back`] && byName[part]).map((part, index) => ({
      id: `${part.replace('_', '-')}-back`, file: LAYER_FILE[`${part}_back`], z: 5 + index * 2, motion: staticParts.includes(part) ? 'none' : LAYER_MOTION[part], pivot: pivot(byName[part], part === 'hat' ? 'brim' : 'center'),
    })),
    { id: 'base', file: 'base.png', z: LAYER_Z.base, motion: 'none' },
    // 五官：左眼、右眼、嘴巴各一層，每個表情各一張（舊版是整塊臉一層）
    ...(FEATURE_LAYER.some(([key]) => layers[`${key}-idle`])
      ? FEATURE_LAYER.filter(([key]) => layers[`${key}-idle`]).map(([, id, zIndex]) => ({ id, file: `${id}-{state}.png`, z: zIndex, motion: 'none' }))
      : [{ id: 'face', file: 'face-{state}.png', z: LAYER_Z.face, motion: 'none' }]),
    ...(layers.fx ? [{ id: 'fx', file: FX_FILE, z: LAYER_Z.fx, motion: 'twinkle' }] : []),
  ].sort((a, b) => a.z - b.z);
  const hasState = (state) => FEATURE_LAYER.some(([key]) => layers[`${key}-${state}`]) || layers[`face-${state}`];
  return { spec: SKIN_SPEC, name, canvas: SKIN_SIZE, frame: CANVAS_FRAME, layers: list, faces: FACE_STATES.filter(hasState), motionPreset: 'gentle' };
}

/** 造型包的檔案：檔名 → PNG（512×512） */
export function packageFiles(layers) {
  const files = {};
  const name = (key) => {
    if (key.startsWith('face-') || key === 'base') return `${key}.png`;
    if (key === 'fx') return FX_FILE;
    const feature = /^(eye_left|eye_right|mouth)-([a-z]+)$/.exec(key);
    if (feature && FACE_STATES.includes(feature[2])) return `${feature[1].replace('_', '-')}-${feature[2]}.png`;
    return LAYER_FILE[key];
  };
  for (const [key, image] of Object.entries(layers)) if (image && name(key)) files[name(key)] = ops.encodePng(ops.downscale2x(image));
  return files;
}

/** 檢查 manifest（讀檔時用：只接受規格內的欄位與檔名） */
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || raw.spec !== SKIN_SPEC) return undefined;
  const allowedFiles = new Set(['base.png', 'face-{state}.png', 'eye-left-{state}.png', 'eye-right-{state}.png', 'mouth-{state}.png', FX_FILE, ...Object.values(LAYER_FILE)]);
  const motions = new Set(['none', 'bob', 'wobble', 'twinkle']);
  const layers = (Array.isArray(raw.layers) ? raw.layers : []).filter((layer) => layer && allowedFiles.has(layer.file)).map((layer) => ({
    id: String(layer.id || '').slice(0, 24),
    file: layer.file,
    z: Math.max(0, Math.min(100, Math.round(Number(layer.z) || 0))),
    motion: motions.has(layer.motion) ? layer.motion : 'none',
    ...(Array.isArray(layer.pivot) && layer.pivot.length === 2 ? { pivot: layer.pivot.map((n) => Math.max(0, Math.min(1, Number(n) || 0))) } : {}),
  }));
  const faces = (Array.isArray(raw.faces) ? raw.faces : []).filter((state) => FACE_STATES.includes(state));
  if (!layers.some((layer) => layer.id === 'base') || !faces.includes('idle')) return undefined;
  return { spec: SKIN_SPEC, name: String(raw.name || '').slice(0, 40), canvas: SKIN_SIZE, frame: raw.frame === CANVAS_FRAME ? CANVAS_FRAME : 1, layers, faces, motionPreset: ['calm', 'gentle', 'lively'].includes(raw.motionPreset) ? raw.motionPreset : 'gentle' };
}
