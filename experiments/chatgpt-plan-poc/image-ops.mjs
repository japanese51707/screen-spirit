// 造型用的像素處理：全部在「直通 RGBA」的緩衝區上運算（{ width, height, data: Uint8Array }），不依賴 Electron，方便測試。
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA → PNG（保留透明度） */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** macOS 的 nativeImage.toBitmap() 是 BGRA、預乘透明度：轉成直通 RGBA */
export function fromBgraPremultiplied(buffer, width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = buffer[i + 3];
    const scale = a && a < 255 ? 255 / a : 1;
    data[i] = Math.min(255, Math.round(buffer[i + 2] * scale));
    data[i + 1] = Math.min(255, Math.round(buffer[i + 1] * scale));
    data[i + 2] = Math.min(255, Math.round(buffer[i] * scale));
    data[i + 3] = a;
  }
  return { width, height, data };
}

/** 透明的部分超過 1% 才算有去背 */
export function hasTransparency(image) {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 250) count += 1;
  return count / (image.width * image.height) > 0.01;
}

/** 把透明圖鋪在白底上（局部重畫要用不透明的原圖） */
export function flattenOnWhite(image) {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = image.data[i + 3] / 255;
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.round(image.data[i + c] * a + 255 * (1 - a));
    data[i + 3] = 255;
  }
  return { ...image, data };
}

/** 0–1000 的比例座標框 → 像素框 */
export function boxToPixels(box, width, height) {
  const [x0, y0, x1, y1] = box.map(Number);
  return {
    x0: Math.max(0, Math.round((Math.min(x0, x1) / 1000) * width)),
    y0: Math.max(0, Math.round((Math.min(y0, y1) / 1000) * height)),
    x1: Math.min(width, Math.round((Math.max(x0, x1) / 1000) * width)),
    y1: Math.min(height, Math.round((Math.max(y0, y1) / 1000) * height)),
  };
}

/** 要重畫的區域：每個框各畫一個橢圓，往外放大 expand 倍（眼睛很小，留空間給閉眼的線條） */
export function ellipseArea(width, height, boxes, expand = 0.6, minRadius = 18) {
  const area = new Uint8Array(width * height);
  for (const box of boxes) {
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const rx = Math.max(minRadius, ((box.x1 - box.x0) / 2) * (1 + expand));
    const ry = Math.max(minRadius, ((box.y1 - box.y0) / 2) * (1 + expand));
    for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(height, Math.ceil(cy + ry)); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(width, Math.ceil(cx + rx)); x += 1) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) area[y * width + x] = 1;
      }
    }
  }
  return area;
}

/** 可分離的方框模糊（羽化遮罩邊緣、算「附近」範圍用） */
export function boxBlur(values, width, height, radius) {
  const temp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += values[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      temp[y * width + x] = sum / size;
      sum += values[y * width + Math.min(width - 1, x + radius + 1)] - values[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += temp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / size;
      sum += temp[Math.min(height - 1, y + radius + 1) * width + x] - temp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

/** OpenAI 格式的遮罩：要重畫的地方完全透明，其他地方不透明 */
export function maskImage(base, area) {
  const data = new Uint8Array(base.data);
  for (let p = 0; p < area.length; p += 1) if (area[p]) data[p * 4 + 3] = 0;
  return { ...base, data };
}

/**
 * 比較兩張圖：遮罩外（再往外留 margin 當緩衝）有沒有被改動、遮罩內改了多少。
 * 數值：平均色差（0–255）、明顯改變（色差 > 30）的像素比例。
 */
export function diffStats(a, b, area, margin = 12) {
  const near = boxBlur(Float32Array.from(area), a.width, a.height, margin);
  let outSum = 0; let outCount = 0; let outChanged = 0; let inCount = 0; let inChanged = 0;
  for (let p = 0; p < area.length; p += 1) {
    const i = p * 4;
    const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    if (area[p]) {
      inCount += 1;
      if (d > 30) inChanged += 1;
    } else if (near[p] === 0) {
      outCount += 1;
      outSum += d;
      if (d > 30) outChanged += 1;
    }
  }
  const pct = (n, total) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    outsideMeanDiff: outCount ? Math.round((outSum / outCount) * 10) / 10 : 0,
    outsideChangedPct: pct(outChanged, outCount),
    insideChangedPct: pct(inChanged, inCount),
  };
}

const colorDiff = (a, b, i) => (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;

/**
 * 分析一次局部重畫。模型常把遮罩當成「提示」：它會照語意改整個零件（例如整顆眼睛），範圍不一定剛好在遮罩裡。
 * 所以不靠遮罩，而是找出「遮罩附近 nearRadius px 內、實際改變（色差 > regionThreshold）的像素」，往外擴 grow px，當成要貼回的區域；
 * 量測數字則用較高的 threshold，只算明顯的改變。
 * 回傳 region（要貼回的區域）與量測數字：
 *   changedPixels  明顯改變的像素數
 *   maskCoverage   改變的像素有多少比例落在遮罩內（低＝零件位置標得不準，但只要 nearCoverage 高就沒關係）
 *   nearCoverage   改變的像素有多少比例落在遮罩附近（低＝模型動到了不該動的遠處）
 *   outsideMeanDiff／outsideChangedPct  附近範圍以外的平均色差／明顯改變比例（應該接近 0）
 */
export function analyzeEdit(a, b, area, { nearRadius = 64, threshold = 40, regionThreshold = 12, grow = 6 } = {}) {
  const { width, height } = a;
  const near = boxBlur(Float32Array.from(area), width, height, nearRadius);
  const changedNear = new Float32Array(area.length);
  let changed = 0; let inMask = 0; let inNear = 0; let outSum = 0; let outCount = 0; let outChanged = 0;
  for (let p = 0; p < area.length; p += 1) {
    const d = colorDiff(a, b, p * 4);
    const isChanged = d > threshold;
    if (isChanged) {
      changed += 1;
      if (area[p]) inMask += 1;
      if (near[p] > 0) inNear += 1;
    }
    // 貼回的區域用較低的門檻：淡色的變化（例如原本眼睛的白色反光）也要一起換掉，才不會留下殘影
    if (d > regionThreshold && near[p] > 0) changedNear[p] = 1;
    if (near[p] === 0) {
      outCount += 1;
      outSum += d;
      if (d > 30) outChanged += 1;
    }
  }
  const grown = boxBlur(changedNear, width, height, grow);
  const region = new Uint8Array(area.length);
  for (let p = 0; p < area.length; p += 1) if (grown[p] > 0) region[p] = 1;
  const ratio = (n, total) => (total ? Math.round((n / total) * 100) / 100 : 0);
  return {
    region,
    stats: {
      changedPixels: changed,
      maskCoverage: ratio(inMask, changed),
      nearCoverage: ratio(inNear, changed),
      outsideMeanDiff: outCount ? Math.round((outSum / outCount) * 10) / 10 : 0,
      outsideChangedPct: outCount ? Math.round((outChanged / outCount) * 1000) / 10 : 0,
    },
  };
}

/** 只把指定區域（羽化 feather px）的新內容貼回原圖：就算模型整張重畫，貼回來的圖層仍然和原圖對齊 */
export function compositeInArea(base, over, area, feather = 8) {
  const weight = boxBlur(Float32Array.from(area), base.width, base.height, feather);
  const data = new Uint8Array(base.data);
  for (let p = 0; p < area.length; p += 1) {
    const w = Math.min(1, weight[p] * 1.6);
    if (!w) continue;
    const i = p * 4;
    for (let c = 0; c < 4; c += 1) data[i + c] = Math.round(base.data[i + c] * (1 - w) + over.data[i + c] * w);
  }
  return { ...base, data };
}

/** 套用另一張圖的透明度（去背結果） */
export function withAlphaFrom(image, alphaSource) {
  const data = new Uint8Array(image.data);
  for (let i = 3; i < data.length; i += 4) data[i] = alphaSource.data[i];
  return { ...image, data };
}

/** 差異熱度圖：灰階原圖上，改變越多越紅 */
export function diffHeatmap(a, b) {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3 * 0.35 + 160);
    const d = Math.min(1, ((Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3) / 60);
    data[i] = Math.round(gray * (1 - d) + 230 * d);
    data[i + 1] = Math.round(gray * (1 - d) + 30 * d);
    data[i + 2] = Math.round(gray * (1 - d) + 40 * d);
    data[i + 3] = 255;
  }
  return { ...a, data };
}

/** 長方形區域（零件框往外擴 pad px） */
export function rectArea(width, height, boxes, pad = 0) {
  const area = new Uint8Array(width * height);
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x0 - pad)); const x1 = Math.min(width, Math.ceil(box.x1 + pad));
    const y0 = Math.max(0, Math.floor(box.y0 - pad)); const y1 = Math.min(height, Math.ceil(box.y1 + pad));
    for (let y = y0; y < y1; y += 1) area.fill(1, y * width + x0, y * width + x1);
  }
  return area;
}

/** 區域往外擴 radius px */
export function dilate(area, width, height, radius) {
  const blurred = boxBlur(Float32Array.from(area), width, height, radius);
  const out = new Uint8Array(area.length);
  for (let p = 0; p < area.length; p += 1) if (blurred[p] > 0) out[p] = 1;
  return out;
}

/** 只留下 area 內的像素（其他地方完全透明），透明度再乘上 alphaSource 的透明度 */
export function keepArea(image, area, alphaSource = image) {
  const data = new Uint8Array(image.data.length);
  for (let p = 0; p < area.length; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    data[i] = image.data[i]; data[i + 1] = image.data[i + 1]; data[i + 2] = image.data[i + 2];
    data[i + 3] = Math.round((image.data[i + 3] * alphaSource.data[i + 3]) / 255);
  }
  return { ...image, data };
}

/** 縮成一半（2×2 平均；依透明度加權，邊緣不會發黑） */
export function downscale2x(image) {
  const width = image.width >> 1; const height = image.height >> 1;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((y * 2 + dy) * image.width + (x * 2 + dx)) * 4;
        const alpha = image.data[i + 3];
        r += image.data[i] * alpha; g += image.data[i + 1] * alpha; b += image.data[i + 2] * alpha; a += alpha;
      }
      const o = (y * width + x) * 4;
      if (a) { data[o] = Math.round(r / a); data[o + 1] = Math.round(g / a); data[o + 2] = Math.round(b / a); }
      data[o + 3] = Math.round(a / 4);
    }
  }
  return { width, height, data };
}

/** 區域內有沒有任何像素 */
export const areaSize = (area) => area.reduce((sum, value) => sum + value, 0);

// ── 對齊：模型做大幅修改時常把整張圖稍微放大縮小、移動。先找出縮放與位移，把結果對回主圖 ──
const luminance = (image, size) => {
  const factor = image.width / size;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0; let count = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * image.width + (x * factor + dx)) * 4;
          sum += image.data[i] * 0.3 + image.data[i + 1] * 0.59 + image.data[i + 2] * 0.11; count += 1;
        }
      }
      out[y * size + x] = sum / count;
    }
  }
  return out;
};
const shrinkArea = (area, width, size) => {
  const factor = width / size;
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) out[y * size + x] = area[(y * factor + (factor >> 1)) * width + x * factor + (factor >> 1)];
  return out;
};

/**
 * 找出把 moving 對到 reference 的縮放 s 與位移 (tx, ty)（以 1024 畫布、中心為基準）：
 * 對齊後的 (x, y) 取 moving 的 (c + s(x − c) + tx, c + s(y − c) + ty)。
 * weight：只比較這些像素（例如零件框以外的地方）。由粗到細搜尋，回傳 { s, tx, ty, error }（error：平均亮度差 0–255）。
 */
export function registerSimilarity(reference, moving, weight) {
  const W = reference.width;
  const c = W / 2;
  const evaluate = (ref, mov, mask, size, s, tx, ty) => {
    const k = size / W;
    const cc = c * k;
    let sum = 0; let count = 0;
    for (let y = 0; y < size; y += 1) {
      const sy = Math.round(cc + s * (y - cc) + ty * k);
      for (let x = 0; x < size; x += 1) {
        const p = y * size + x;
        if (!mask[p]) continue;
        const sx = Math.round(cc + s * (x - cc) + tx * k);
        const value = sx >= 0 && sy >= 0 && sx < size && sy < size ? mov[sy * size + sx] : 255;
        sum += Math.abs(ref[p] - value); count += 1;
      }
    }
    return count ? sum / count : Infinity;
  };
  let best = { s: 1, tx: 0, ty: 0, error: Infinity };
  const levels = [
    { size: 128, scales: [-0.14, 0.14, 0.02], shifts: [-64, 64, 8] },
    { size: 256, scales: [-0.02, 0.02, 0.005], shifts: [-8, 8, 2] },
    { size: 512, scales: [-0.004, 0.004, 0.002], shifts: [-2, 2, 1] },
  ];
  for (const [index, level] of levels.entries()) {
    const ref = luminance(reference, level.size);
    const mov = luminance(moving, level.size);
    const mask = shrinkArea(weight, W, level.size);
    const center = index === 0 ? { s: 1, tx: 0, ty: 0 } : best;
    let levelBest = { ...center, error: Infinity };
    for (let ds = level.scales[0]; ds <= level.scales[1] + 1e-9; ds += level.scales[2]) {
      for (let dx = level.shifts[0]; dx <= level.shifts[1]; dx += level.shifts[2]) {
        for (let dy = level.shifts[0]; dy <= level.shifts[1]; dy += level.shifts[2]) {
          const candidate = { s: center.s + ds, tx: center.tx + dx, ty: center.ty + dy };
          const error = evaluate(ref, mov, mask, level.size, candidate.s, candidate.tx, candidate.ty);
          if (error < levelBest.error) levelBest = { ...candidate, error };
        }
      }
    }
    best = levelBest;
  }
  return { s: Math.round(best.s * 1000) / 1000, tx: best.tx, ty: best.ty, error: Math.round(best.error * 10) / 10 };
}

/** 依 registerSimilarity 的結果把 moving 對回主圖（雙線性取樣；超出範圍補 fill） */
export function warpSimilarity(image, { s, tx, ty }, fill = [255, 255, 255, 255]) {
  const { width, height } = image;
  const c = width / 2;
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < height; y += 1) {
    const fy = c + s * (y - c) + ty;
    const y0 = Math.floor(fy); const wy = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = c + s * (x - c) + tx;
      const x0 = Math.floor(fx); const wx = fx - x0;
      const o = (y * width + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) { data.set(fill, o); continue; }
      const i00 = (y0 * width + x0) * 4; const i10 = i00 + 4; const i01 = i00 + width * 4; const i11 = i01 + 4;
      for (let ch = 0; ch < 4; ch += 1) {
        data[o + ch] = Math.round((image.data[i00 + ch] * (1 - wx) + image.data[i10 + ch] * wx) * (1 - wy) + (image.data[i01 + ch] * (1 - wx) + image.data[i11 + ch] * wx) * wy);
      }
    }
  }
  return { width, height, data };
}

/** 兩張圖在 zone 內明顯不同（色差 > threshold）的像素；去掉零星雜點（先縮 1px 再擴回來） */
export function differenceArea(a, b, zone, threshold = 40) {
  const { width, height } = a;
  const raw = new Uint8Array(zone.length);
  for (let p = 0; p < zone.length; p += 1) if (zone[p] && colorDiff(a, b, p * 4) > threshold) raw[p] = 1;
  const eroded = boxBlur(Float32Array.from(raw), width, height, 1);
  const core = new Uint8Array(zone.length);
  for (let p = 0; p < zone.length; p += 1) if (eroded[p] > 0.99) core[p] = 1;
  const grown = dilate(core, width, height, 1);
  for (let p = 0; p < zone.length; p += 1) grown[p] = grown[p] && raw[p] ? 1 : 0;
  return grown;
}

/** 區域外圍一圈（寬 ring px）的平均色差：用來判斷貼回去之後接縫明不明顯 */
export function ringDiff(a, b, area, ring = 10) {
  const outer = dilate(area, a.width, a.height, ring);
  let sum = 0; let count = 0;
  for (let p = 0; p < area.length; p += 1) {
    if (!outer[p] || area[p]) continue;
    sum += colorDiff(a, b, p * 4); count += 1;
  }
  return count ? Math.round((sum / count) * 10) / 10 : 0;
}

/** 只在 area 內換成 alphaSource 的透明度 */
export function alphaInArea(image, alphaSource, area) {
  const data = new Uint8Array(image.data);
  for (let p = 0; p < area.length; p += 1) if (area[p]) data[p * 4 + 3] = alphaSource.data[p * 4 + 3];
  return { ...image, data };
}

/** 除錯用：在圖上把區域塗成半透明的顏色 */
export function overlayArea(image, area, [r, g, b] = [230, 40, 120]) {
  const data = new Uint8Array(image.data);
  for (let p = 0; p < area.length; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    data[i] = (data[i] + r) >> 1; data[i + 1] = (data[i + 1] + g) >> 1; data[i + 2] = (data[i + 2] + b) >> 1; data[i + 3] = 255;
  }
  return { ...image, data };
}

/** 對齊（找不到比原樣更好的就不動） */
export function alignTo(reference, moving, weight) {
  const found = registerSimilarity(reference, moving, weight);
  const identity = registerSimilarityError(reference, moving, weight);
  const transform = identity <= found.error + 0.3 ? { s: 1, tx: 0, ty: 0, error: identity } : found;
  const isIdentity = transform.s === 1 && !transform.tx && !transform.ty;
  return { transform, warp: (image, fill) => (isIdentity ? image : warpSimilarity(image, transform, fill)) };
}

function registerSimilarityError(reference, moving, weight) {
  let sum = 0; let count = 0;
  for (let p = 0; p < weight.length; p += 4) { // 每 4 個像素取 1 個，夠準也夠快
    if (!weight[p]) continue;
    const i = p * 4;
    const a = reference.data[i] * 0.3 + reference.data[i + 1] * 0.59 + reference.data[i + 2] * 0.11;
    const b = moving.data[i] * 0.3 + moving.data[i + 1] * 0.59 + moving.data[i + 2] * 0.11;
    sum += Math.abs(a - b); count += 1;
  }
  return count ? Math.round((sum / count) * 10) / 10 : Infinity;
}

/** 把區域裡被包住的洞補起來（例如調色盤白色的內部）：從 zone 外面往裡灌，灌不到的空白就是洞 */
export function fillHoles(area, zone, width, height) {
  const reached = new Uint8Array(area.length);
  const queue = new Int32Array(area.length);
  let head = 0; let tail = 0;
  for (let p = 0; p < area.length; p += 1) {
    if (!zone[p] && !area[p]) { reached[p] = 1; queue[tail++] = p; }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width; const y = (p - x) / width;
    for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
      if (q >= 0 && !reached[q] && !area[q]) { reached[q] = 1; queue[tail++] = q; }
    }
  }
  const out = new Uint8Array(area.length);
  for (let p = 0; p < area.length; p += 1) out[p] = area[p] || (zone[p] && !reached[p]) ? 1 : 0;
  return out;
}

/** 區域往內縮 radius px */
export function erode(area, width, height, radius) {
  const blurred = boxBlur(Float32Array.from(area), width, height, radius);
  const out = new Uint8Array(area.length);
  for (let p = 0; p < area.length; p += 1) if (blurred[p] > 0.999) out[p] = 1;
  return out;
}

/**
 * 找出「配件本身」的範圍：主圖和拿掉配件後的圖不一樣的地方（限 zone 內），
 * 補洞（淺色的內部，例如調色盤）、再去掉細條（模型重畫身體外框時的錯位，通常只有幾 px 寬）。
 */
export function accessorySegment(masterFlat, alignedFlat, zone, { threshold = 40, thin = 5 } = {}) {
  const { width, height } = masterFlat;
  const raw = differenceArea(masterFlat, alignedFlat, zone, threshold);
  const filled = fillHoles(raw, zone, width, height);
  const core = erode(filled, width, height, thin);
  const kept = dilate(core, width, height, thin + 2);
  for (let p = 0; p < kept.length; p += 1) kept[p] = kept[p] && filled[p] ? 1 : 0;
  return kept;
}

/** 沒有本機去背時的備案：接近純白的地方當成透明 */
export function alphaFromWhite(image, area) {
  const data = new Uint8Array(image.data);
  for (let p = 0; p < area.length; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    const sum = data[i] + data[i + 1] + data[i + 2];
    data[i + 3] = sum >= 762 ? 0 : sum <= 735 ? data[i + 3] : Math.round(data[i + 3] * (762 - sum) / 27);
  }
  return { ...image, data };
}

/** 色鍵：找出模型塗成純色（綠 #00FF00 或洋紅 #FF00FF）的範圍 */
export function keyArea(image, zone, key = 'green') {
  const out = new Uint8Array(zone.length);
  for (let p = 0; p < zone.length; p += 1) {
    if (!zone[p]) continue;
    const i = p * 4; const r = image.data[i]; const g = image.data[i + 1]; const b = image.data[i + 2];
    const hit = key === 'green' ? g > 150 && g - Math.max(r, b) > 70 : r > 150 && b > 150 && Math.min(r, b) - g > 70;
    if (hit) out[p] = 1;
  }
  return out;
}

/** 這個顏色在原圖的範圍裡占多少（選色鍵時避開原圖本來就有的顏色） */
export function keyShare(image, zone, key) {
  const hits = areaSize(keyArea(image, zone, key));
  return hits / Math.max(1, areaSize(zone));
}

/** 不透明像素的範圍（alpha > threshold）；整張透明時回傳 undefined */
export function alphaBounds(image, threshold = 16) {
  let x0 = image.width; let y0 = image.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] <= threshold) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? undefined : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** 從 (x, y) 裁一塊 width×height（超出原圖的地方是透明） */
export function crop(image, x, y, width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    for (let col = 0; col < width; col += 1) {
      const sx = x + col;
      if (sx < 0 || sx >= image.width) continue;
      const i = (sy * image.width + sx) * 4;
      data.set(image.data.subarray(i, i + 4), (row * width + col) * 4);
    }
  }
  return { width, height, data };
}

/** 把 source 貼到 target 的 (x, y)（直接覆蓋，target 會被改動） */
export function paste(target, source, x, y) {
  for (let row = 0; row < source.height; row += 1) {
    const ty = y + row;
    if (ty < 0 || ty >= target.height) continue;
    for (let col = 0; col < source.width; col += 1) {
      const tx = x + col;
      if (tx < 0 || tx >= target.width) continue;
      const i = (row * source.width + col) * 4;
      target.data.set(source.data.subarray(i, i + 4), (ty * target.width + tx) * 4);
    }
  }
  return target;
}

/**
 * 色鍵去背：模型畫在純色背景（綠 #00FF00 或洋紅 #FF00FF）上的圖 → 透明背景。
 * 邊緣半透明、並去掉邊緣滲進來的背景色（去溢色）。
 */
export function chromaKey(image, key = 'green') {
  const data = new Uint8Array(image.data);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const d = key === 'green' ? g - Math.max(r, b) : Math.min(r, b) - g;
    const alpha = d <= 30 ? 1 : d >= 110 ? 0 : 1 - (d - 30) / 80;
    if (d > 0) {
      if (key === 'green') data[i + 1] = Math.max(r, b);
      else { const m = Math.max(g, Math.min(r, b) - d); data[i] = Math.min(r, m + (r - Math.min(r, b))); data[i + 2] = Math.min(b, m + (b - Math.min(r, b))); }
    }
    data[i + 3] = Math.round(data[i + 3] * alpha);
  }
  return { ...image, data };
}

/** 不透明（alpha > 128）的像素占整張圖的比例 */
export function opaqueShare(image) {
  let count = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 128) count += 1;
  return count / (image.width * image.height);
}

/** 不透明的範圍（alpha > 128） */
export function opaqueArea(image, threshold = 128) {
  const area = new Uint8Array(image.width * image.height);
  for (let p = 0; p < area.length; p += 1) if (image.data[p * 4 + 3] > threshold) area[p] = 1;
  return area;
}

/** 兩張圖在 area 內的平均色差 */
export function meanDiffIn(a, b, area) {
  let sum = 0; let count = 0;
  for (let p = 0; p < area.length; p += 1) if (area[p]) { sum += colorDiff(a, b, p * 4); count += 1; }
  return count ? Math.round((sum / count) * 10) / 10 : 0;
}

/** 區域的邊緣往內外各 band px 的一圈 */
export function edgeBand(area, width, height, band) {
  const inner = erode(area, width, height, 1);
  const edge = area.map((value, p) => (value && !inner[p] ? 1 : 0));
  return dilate(edge, width, height, band);
}

/**
 * 從主圖減掉「沒有配件的身體」，找出每個配件的像素：
 *   身體外面、主圖卻有東西的地方 → 一定是配件（淺色的部分也算，例如調色盤的白色表面）
 *   身體裡面、主圖和身體明顯不同的地方 → 配件蓋在身體上的部分
 * 身體外框附近的細條（模型畫的身體外框和主圖差幾 px）會被去掉；其他地方的細部（例如鏈子）保留。
 * boxes：{ 配件名: 像素框 }；重疊的框依「連在一起的範圍」分給離它最近、只屬於一個框的像素。
 * 回傳 { 配件名: 範圍 }。
 */
export function accessoriesFromBody({ master, masterFlat, body, bodyFlat, boxes, exclude, threshold = 40, thin = 4, reach = 160 }) {
  const { width, height } = master;
  const size = width * height;
  const inMaster = opaqueArea(master);
  const inBody = opaqueArea(body);
  const names = Object.keys(boxes);
  const boxAreas = names.map((name) => rectArea(width, height, [boxes[name]], 0));
  const nearBoxes = rectArea(width, height, names.map((name) => boxes[name]), reach);
  let candidate = new Uint8Array(size);
  for (let p = 0; p < size; p += 1) {
    if (!inMaster[p] || !nearBoxes[p]) continue;
    if (!inBody[p] || colorDiff(masterFlat, bodyFlat, p * 4) > threshold) candidate[p] = 1;
  }
  // 身體外框附近：只留粗的部分（細條是外框錯位）
  const band = edgeBand(inBody, width, height, thin * 2);
  const opened = dilate(erode(candidate, width, height, thin), width, height, thin + 1);
  for (let p = 0; p < size; p += 1) if (candidate[p] && band[p] && !opened[p]) candidate[p] = 0;
  // 拿掉身體顏色（主圖的身體外框、填色，和模型畫的身體位置不同時會被誤當成配件），
  // 再把「被配件包住」的身體色補回來（例如鍵盤裡的白色按鍵、鏡片的反光），以及配件邊緣 3px 的抗鋸齒
  const bodyColors = dominantColors(body, inBody.map((value, p) => (value && !(exclude && exclude[p]) ? 1 : 0)));
  const accessoryOnly = fillHoles(withoutColors(candidate, masterFlat, bodyColors, { minSize: 150 }), nearBoxes, width, height);
  const edge = dilate(accessoryOnly, width, height, 3);
  for (let p = 0; p < size; p += 1) candidate[p] = accessoryOnly[p] || (edge[p] && candidate[p]) ? 1 : 0;
  if (exclude) for (let p = 0; p < size; p += 1) if (exclude[p]) candidate[p] = 0;
  // 分給各配件：從每個框的中央（框縮成一半）開始，同時沿著相連的像素往外擴；
  // 每個像素歸給先擴到它的配件（例如眼鏡的光暈連著眼鏡，就歸眼鏡，不會被帽子的框搶走）
  const label = new Int8Array(size).fill(-1);
  const seedOwner = new Int8Array(size).fill(-1);
  const queue = new Int32Array(size);
  let tail = 0;
  const cores = names.map((name) => {
    const box = boxes[name];
    const dx = (box.x1 - box.x0) / 4; const dy = (box.y1 - box.y0) / 4;
    return rectArea(width, height, [{ x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 - dx, y1: box.y1 - dy }], 0);
  });
  const seed = (areas) => {
    for (let p = 0; p < size; p += 1) {
      if (!candidate[p] || label[p] >= 0) continue;
      let owner = -1; let count = 0;
      for (let i = 0; i < names.length; i += 1) if (areas[i][p]) { owner = i; count += 1; }
      if (count === 1) { label[p] = owner; seedOwner[p] = owner; queue[tail++] = p; }
    }
  };
  seed(cores);
  // 框中央完全沒有像素的配件（例如中間是空的環）：改用整個框當起點
  const seeded = new Set(); for (let k = 0; k < tail; k += 1) seeded.add(label[queue[k]]);
  seed(names.map((name, i) => (seeded.has(i) ? new Uint8Array(size) : boxAreas[i])));
  // 依「距離＋顏色變化」往外擴（Dial 演算法）：顏色接近的相連像素比較「近」，
  // 所以深藍色的耳機頭帶會跟著深藍色的耳罩，不會被旁邊藍光的眼鏡搶走
  const INF = 0x7fffffff;
  const cost = new Int32Array(size).fill(INF);
  const buckets = Array.from({ length: 256 }, () => []);
  let pending = 0;
  for (let k = 0; k < tail; k += 1) { cost[queue[k]] = 0; buckets[0].push(queue[k]); pending += 1; }
  label.fill(-1);
  for (let k = 0; k < tail; k += 1) label[queue[k]] = seedOwner[queue[k]];
  for (let current = 0; pending > 0; current += 1) {
    const bucket = buckets[current & 255];
    while (bucket.length) {
      const p = bucket.pop();
      pending -= 1;
      if (cost[p] !== current) continue; // 已經有更近的路
      const x = p % width; const y = (p - x) / width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q < 0 || !candidate[q]) continue;
        const next = current + 1 + ((Math.abs(masterFlat.data[p * 4] - masterFlat.data[q * 4]) + Math.abs(masterFlat.data[p * 4 + 1] - masterFlat.data[q * 4 + 1]) + Math.abs(masterFlat.data[p * 4 + 2] - masterFlat.data[q * 4 + 2])) / 5 | 0);
        if (next < cost[q]) { cost[q] = next; label[q] = label[p]; buckets[next & 255].push(q); pending += 1; }
      }
    }
  }
  const result = {};
  names.forEach((name, index) => { result[name] = label.map((value) => (value === index ? 1 : 0)); });
  for (const name of names) result[name] = Uint8Array.from(result[name]);
  return result;
}

/** 範圍裡有多少比例落在 other 裡 */
export function overlapShare(area, other) {
  let count = 0; let inside = 0;
  for (let p = 0; p < area.length; p += 1) if (area[p]) { count += 1; if (other[p]) inside += 1; }
  return count ? inside / count : 0;
}

/** 身體的主要顏色（外框、填色、腮紅…）：量化後占身體 0.5% 以上的顏色 */
export function dominantColors(image, area, { minShare = 0.005, step = 24 } = {}) {
  const bins = new Map();
  let total = 0;
  for (let p = 0; p < area.length; p += 1) {
    const i = p * 4;
    if (!area[p] || image.data[i + 3] < 200) continue;
    const key = `${Math.round(image.data[i] / step)},${Math.round(image.data[i + 1] / step)},${Math.round(image.data[i + 2] / step)}`;
    const bin = bins.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bin.count += 1; bin.r += image.data[i]; bin.g += image.data[i + 1]; bin.b += image.data[i + 2];
    bins.set(key, bin);
    total += 1;
  }
  return [...bins.values()].filter((bin) => bin.count >= total * minShare).map((bin) => [bin.r / bin.count, bin.g / bin.count, bin.b / bin.count]);
}

/** 拿掉範圍裡「身體顏色」的像素，再去掉小於 minSize 的碎塊 */
export function withoutColors(area, image, colors, { distance = 42, minSize = 150 } = {}) {
  const { width, height } = image;
  const kept = new Uint8Array(area.length);
  for (let p = 0; p < area.length; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    const r = image.data[i]; const g = image.data[i + 1]; const b = image.data[i + 2];
    let bodyLike = false;
    for (const [cr, cg, cb] of colors) if ((r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2 < distance * distance) { bodyLike = true; break; }
    if (!bodyLike) kept[p] = 1;
  }
  // 去掉小碎塊（連通區域）
  const seen = new Uint8Array(area.length);
  const queue = new Int32Array(area.length);
  for (let start = 0; start < area.length; start += 1) {
    if (!kept[start] || seen[start]) continue;
    let head = 0; let tail = 0;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width; const y = (p - x) / width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && kept[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
      }
    }
    if (tail < minSize) for (let k = 0; k < tail; k += 1) kept[queue[k]] = 0;
  }
  return kept;
}

/** 框裡（往外 pad px）深色像素（亮度 < 100）的中心：用來找眼睛實際的位置 */
export function darkCentroid(image, box, pad = 20, threshold = 100) {
  let sx = 0; let sy = 0; let n = 0;
  for (let y = Math.max(0, box.y0 - pad); y < Math.min(image.height, box.y1 + pad); y += 1) {
    for (let x = Math.max(0, box.x0 - pad); x < Math.min(image.width, box.x1 + pad); x += 1) {
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] < 128) continue;
      if (image.data[i] * 0.3 + image.data[i + 1] * 0.59 + image.data[i + 2] * 0.11 < threshold) { sx += x; sy += y; n += 1; }
    }
  }
  return n >= 30 ? { x: sx / n, y: sy / n, n } : undefined;
}

/** 鏡片：把 area 內換成鏡片外圈的平均顏色、半透明（底下的眼睛看得到，眨眼也看得到） */
export function tintLens(image, area, opacity = 0.32) {
  const ring = dilate(area, image.width, image.height, 14);
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let p = 0; p < area.length; p += 1) {
    if (!ring[p] || area[p]) continue;
    const i = p * 4;
    if (image.data[i + 3] < 200) continue;
    r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; n += 1;
  }
  if (!n) return image;
  const data = new Uint8Array(image.data);
  for (let p = 0; p < area.length; p += 1) {
    if (!area[p]) continue;
    const i = p * 4;
    data[i] = Math.round(r / n); data[i + 1] = Math.round(g / n); data[i + 2] = Math.round(b / n);
    data[i + 3] = Math.round(255 * opacity);
  }
  return { ...image, data };
}

/**
 * 備用去背（沒有 macOS 主體擷取時用）：從圖的四邊往內灌「接近背景色」的像素，變成透明。
 * 角色的白色身體常和背景一樣白、外框又有小缺口，直接灌會漏進身體；所以先把所有「不是背景」的線條加粗 gap px
 * 封住缺口再灌，最後把邊緣縮回來。角色內部的白色不會被挖掉。
 */
export function alphaFromBorder(image, { tolerance = 10, gap = 4, holes = false, holeShare = 0.003, background, seeds } = {}) {
  const { width, height } = image;
  const size = width * height;
  // 背景色：四邊像素的中位數
  const border = [];
  for (let x = 0; x < width; x += 4) border.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 4) border.push(y * width, y * width + width - 1);
  const median = [0, 1, 2].map((c) => { const values = border.map((p) => image.data[p * 4 + c]).sort((a, b) => a - b); return values[values.length >> 1]; });
  const palette = background || [median];
  const isBackground = (p) => {
    const i = p * 4;
    return palette.some((color) => Math.abs(image.data[i] - color[0]) <= tolerance && Math.abs(image.data[i + 1] - color[1]) <= tolerance && Math.abs(image.data[i + 2] - color[2]) <= tolerance);
  };
  const ink = new Uint8Array(size);
  for (let p = 0; p < size; p += 1) if (!isBackground(p)) ink[p] = 1;
  const sealed = dilate(ink, width, height, gap);
  const outside = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0; let tail = 0;
  const push = (p) => { if (!outside[p] && !sealed[p]) { outside[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }
  for (const p of seeds || []) push(p); // 額外的起點（例如配件細節圖的卡片底色，被卡片框線圍住、從四邊灌不進去）
  while (head < tail) {
    const p = queue[head++];
    const x = p % width; const y = (p - x) / width;
    if (x > 0) push(p - 1); if (x < width - 1) push(p + 1); if (y > 0) push(p - width); if (y < height - 1) push(p + width);
  }
  // 封口時加粗的部分縮回來：外面的範圍往內擴 gap px，但不吃掉真正的線條
  const grown = dilate(outside, width, height, gap);
  const data = new Uint8Array(image.data);
  for (let p = 0; p < size; p += 1) if (grown[p] && !ink[p]) data[p * 4 + 3] = 0;
  // holes：被圍起來、但其實是背景的空洞（例如耳機頭帶圍住的地方）也挖透明；只用在單獨的配件圖（角色白色的身體不能這樣挖）
  if (holes) {
    const minHole = Math.max(30, Math.round(size * holeShare));
    const seen = new Uint8Array(size);
    for (let start = 0; start < size; start += 1) {
      if (seen[start] || ink[start] || grown[start]) continue;
      const members = [];
      head = 0; tail = 0; queue[tail++] = start; seen[start] = 1;
      while (head < tail) {
        const p = queue[head++]; members.push(p);
        const x = p % width; const y = (p - x) / width;
        for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
          if (q >= 0 && !seen[q] && !ink[q] && !grown[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
      if (members.length >= minHole) for (const p of members) data[p * 4 + 3] = 0;
    }
  }
  const soft = boxBlur(Float32Array.from(data.filter((_, i) => i % 4 === 3).map((a) => a / 255)), width, height, 1);
  for (let p = 0; p < size; p += 1) data[p * 4 + 3] = Math.round(Math.min(data[p * 4 + 3], soft[p] * 255 + 40));
  return { ...image, data };
}

/**
 * 去掉「被裁框切到的鄰居碎片」：設定圖上主角旁邊的標題字、其他小圖，被裁框切到一角時會留在主圖邊緣。
 * 做法：把不透明像素分成一塊一塊（相連的算同一塊），碰到裁框邊緣（rect，像素座標 [x0,y0,x1,y1]）的塊都刪掉，
 * 只保留最大的那一塊（主角本身就算碰到邊也不會被刪）。回傳 { image, removed }。
 */
export function dropEdgeFragments(image, rect, { alphaMin = 24, margin = 3 } = {}) {
  const { width, height } = image;
  const size = width * height;
  const [rx0, ry0, rx1, ry1] = rect || [0, 0, width, height];
  const label = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  const areas = []; const touches = [];
  for (let start = 0; start < size; start += 1) {
    if (label[start] !== -1 || image.data[start * 4 + 3] < alphaMin) continue;
    const id = areas.length; let area = 0; let touch = false;
    let head = 0; let tail = 0;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++]; area += 1;
      const x = p % width; const y = (p - x) / width;
      if (x <= rx0 + margin || x >= rx1 - 1 - margin || y <= ry0 + margin || y >= ry1 - 1 - margin) touch = true;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (label[q] === -1 && image.data[q * 4 + 3] >= alphaMin) { label[q] = id; queue[tail++] = q; }
      }
    }
    areas.push(area); touches.push(touch);
  }
  if (!areas.length) return { image, removed: 0 };
  const largest = areas.indexOf(Math.max(...areas));
  const drop = new Uint8Array(size); const keep = new Uint8Array(size);
  let removed = 0;
  for (let p = 0; p < size; p += 1) {
    const id = label[p];
    if (id < 0) continue;
    if (touches[id] && id !== largest) drop[p] = 1; else keep[p] = 1;
  }
  for (let id = 0; id < areas.length; id += 1) if (touches[id] && id !== largest) removed += 1;
  if (!removed) return { image, removed: 0 };
  // 碎片周圍的半透明邊（低於 alphaMin、沒算進塊裡）一起清掉，但不碰保留的塊
  const halo = dilate(drop, width, height, 3);
  const nearKeep = dilate(keep, width, height, 2);
  const data = new Uint8Array(image.data);
  for (let p = 0; p < size; p += 1) if (drop[p] || (halo[p] && !nearKeep[p])) data[p * 4 + 3] = 0;
  return { image: { ...image, data }, removed };
}

/** 縮放（縮小時取平均、放大時雙線性；處理過預乘透明度，邊緣不會出現黑邊） */
export function resize(image, width, height) {
  const sx = image.width / width; const sy = image.height / height;
  if (sx <= 1 && sy <= 1) return warpAffine(image, [sx, 0, (sx - 1) / 2, 0, sy, (sy - 1) / 2], width, height);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const ya = y * sy; const yb = Math.min(image.height, (y + 1) * sy);
    for (let x = 0; x < width; x += 1) {
      const xa = x * sx; const xb = Math.min(image.width, (x + 1) * sx);
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0;
      for (let yy = Math.floor(ya); yy < Math.ceil(yb); yy += 1) {
        const wy = Math.min(yb, yy + 1) - Math.max(ya, yy);
        for (let xx = Math.floor(xa); xx < Math.ceil(xb); xx += 1) {
          const w = wy * (Math.min(xb, xx + 1) - Math.max(xa, xx));
          const i = (yy * image.width + xx) * 4; const alpha = image.data[i + 3] / 255;
          r += image.data[i] * alpha * w; g += image.data[i + 1] * alpha * w; b += image.data[i + 2] * alpha * w; a += alpha * w; weight += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) { data[o] = Math.round(r / a); data[o + 1] = Math.round(g / a); data[o + 2] = Math.round(b / a); }
      data[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return { width, height, data };
}

/**
 * 仿射變換：inverse＝[a,b,c,d,e,f]，輸出的 (x,y) 取原圖的 (a·x+b·y+c, d·x+e·y+f)（雙線性，預乘透明度）。
 * 原圖外面是透明。
 */
export function warpAffine(image, inverse, width, height) {
  const [a, b, c, d, e, f] = inverse;
  const W = image.width; const H = image.height; const src = image.data;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fx = a * x + b * y + c; const fy = d * x + e * y + f;
      if (fx < -1 || fy < -1 || fx > W || fy > H) continue;
      const x0 = Math.floor(fx); const y0 = Math.floor(fy); const wx = fx - x0; const wy = fy - y0;
      let r = 0; let g = 0; let bl = 0; let al = 0;
      for (let k = 0; k < 4; k += 1) {
        const xx = x0 + (k & 1); const yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const w = ((k & 1) ? wx : 1 - wx) * ((k >> 1) ? wy : 1 - wy);
        const i = (yy * W + xx) * 4; const alpha = (src[i + 3] / 255) * w;
        r += src[i] * alpha; g += src[i + 1] * alpha; bl += src[i + 2] * alpha; al += alpha;
      }
      if (al <= 0) continue;
      const o = (y * width + x) * 4;
      data[o] = Math.round(r / al); data[o + 1] = Math.round(g / al); data[o + 2] = Math.round(bl / al); data[o + 3] = Math.round(Math.min(1, al) * 255);
    }
  }
  return { width, height, data };
}

/** 擺位參數 → 仿射矩陣。t：{ flip, angle（度）, scale, cx, cy }；配件圖的中心放到 (cx,cy)。回傳 { forward(x,y), inverse:[6] } */
export function placementMatrix(t, refWidth, refHeight) {
  const rad = (t.angle * Math.PI) / 180; const cos = Math.cos(rad); const sin = Math.sin(rad);
  const f = t.flip ? -1 : 1; const s = t.scale; const rcx = refWidth / 2; const rcy = refHeight / 2;
  const forward = (x, y) => { const u = (x - rcx) * f * s; const v = (y - rcy) * s; return [t.cx + cos * u - sin * v, t.cy + sin * u + cos * v]; };
  // 反算：p = rc + F·(1/s)·R(−θ)·(p' − c)
  const a = (f * cos) / s; const b = (f * sin) / s; const d = -sin / s; const e = cos / s;
  return { forward, inverse: [a, b, rcx - a * t.cx - b * t.cy, d, e, rcy - d * t.cx - e * t.cy] };
}

/** 保留「大部分落在 rect 裡」的那幾塊（相連的算一塊）；用來去掉配件圖下面的文字標籤、旁邊的色票 */
export function keepComponentsInside(image, rect, { share = 0.5, alphaMin = 24 } = {}) {
  const { width, height } = image; const size = width * height;
  const [rx0, ry0, rx1, ry1] = rect;
  const label = new Int32Array(size).fill(-1); const queue = new Int32Array(size);
  const keep = [];
  for (let start = 0; start < size; start += 1) {
    if (label[start] !== -1 || image.data[start * 4 + 3] < alphaMin) continue;
    const id = keep.length; let inside = 0; let count = 0; let head = 0; let tail = 0;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++]; count += 1;
      const x = p % width; const y = (p - x) / width;
      if (x >= rx0 && x < rx1 && y >= ry0 && y < ry1) inside += 1;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (label[q] === -1 && image.data[q * 4 + 3] >= alphaMin) { label[q] = id; queue[tail++] = q; }
      }
    }
    keep.push(inside / count >= share && !frameLike(label, id, count, width, height, rect));
  }
  const keepArea = new Uint8Array(size);
  for (let p = 0; p < size; p += 1) if (label[p] >= 0 && keep[label[p]]) keepArea[p] = 1;
  const near = dilate(keepArea, width, height, 2);
  const data = new Uint8Array(image.data);
  for (let p = 0; p < size; p += 1) if (!near[p]) data[p * 4 + 3] = 0;
  return { ...image, data };
}

/** 設計稿上「有畫東西」的像素（和背景色差超過 threshold），限制在 rect 裡；比對用的標準答案 */
export function inkMask(image, rect, { threshold = 30, background } = {}) {
  const { width, height } = image;
  const palette = background || backgroundPalette(image, [rect]);
  const [rx0, ry0, rx1, ry1] = rect;
  const area = new Uint8Array(width * height);
  for (let y = Math.max(0, ry0); y < Math.min(height, ry1); y += 1) {
    for (let x = Math.max(0, rx0); x < Math.min(width, rx1); x += 1) {
      const i = (y * width + x) * 4;
      if (palette.every((bg) => Math.abs(image.data[i] - bg[0]) + Math.abs(image.data[i + 1] - bg[1]) + Math.abs(image.data[i + 2] - bg[2]) > threshold)) area[y * width + x] = 1;
    }
  }
  return area;
}

/**
 * 背景的顏色（可能不只一種：頁面白底＋配件卡片的淡紫底）：取圖四邊和 rings（框的外圈）的像素，
 * 出現比例超過 share 的顏色都算背景。
 */
export function backgroundPalette(image, rings = [], { share = 0.12 } = {}) {
  const { width, height, data } = image;
  const samples = [];
  for (let x = 0; x < width; x += 2) samples.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 2) samples.push(y * width, y * width + width - 1);
  for (const [x0, y0, x1, y1] of rings) {
    for (const inset of [-3, 2]) {
      const a = Math.round(x0 + inset); const b = Math.round(y0 + inset); const c = Math.round(x1 - inset); const d = Math.round(y1 - inset);
      for (let x = Math.max(0, a); x < Math.min(width, c); x += 2) for (const y of [b, d]) if (y >= 0 && y < height) samples.push(y * width + x);
      for (let y = Math.max(0, b); y < Math.min(height, d); y += 2) for (const x of [a, c]) if (x >= 0 && x < width) samples.push(y * width + x);
    }
  }
  const buckets = new Map();
  for (const p of samples) {
    const i = p * 4;
    const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
    const entry = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    entry.count += 1; entry.r += data[i]; entry.g += data[i + 1]; entry.b += data[i + 2];
    buckets.set(key, entry);
  }
  // 相鄰的格子合併（漸層、雜訊）
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const groups = [];
  for (const entry of sorted) {
    const color = [entry.r / entry.count, entry.g / entry.count, entry.b / entry.count];
    const group = groups.find((g) => Math.abs(g.color[0] - color[0]) + Math.abs(g.color[1] - color[1]) + Math.abs(g.color[2] - color[2]) <= 18);
    if (group) group.count += entry.count; else groups.push({ color, count: entry.count });
  }
  const picked = groups.filter((g) => g.count >= samples.length * share).map((g) => g.color.map(Math.round));
  // 背景只會是淺色（深色的通常是配件本身碰到框）
  const light = picked.filter((c) => c[0] + c[1] + c[2] > 450);
  return light.length ? light : [groups[0].color.map(Math.round)];
}

/**
 * 把完整的配件圖（ref，RGBA，有透明度）擺到主圖上它出現的位置：
 * 找翻轉／角度／大小／位置，讓配件蓋住主圖上看得到的那塊（target），顏色也對得上；
 * 被身體擋住的部分落在主圖的身體上不扣分，落在主圖的空白處才扣分。
 * 回傳 { flip, angle, scale, cx, cy, fit: { score, recall, onTarget, empty, color } }
 */
export function fitPlacement(ref, master, target, { angles = 45, order = 'front' } = {}) {
  const W = master.width; const G = 256; const k = G / W;
  const masterSmall = resize(master, G, G);
  const targetSmall = new Uint8Array(G * G); const opaque = new Uint8Array(G * G);
  for (let y = 0; y < G; y += 1) for (let x = 0; x < G; x += 1) {
    let hits = 0;
    for (let yy = 0; yy < W / G; yy += 1) for (let xx = 0; xx < W / G; xx += 1) hits += target[(y * W / G + yy) * W + x * W / G + xx];
    if (hits * 2 >= (W / G) ** 2) targetSmall[y * G + x] = 1;
    if (masterSmall.data[(y * G + x) * 4 + 3] > 76) opaque[y * G + x] = 1;
  }
  let targetArea = 0; let tx = 0; let ty = 0;
  for (let p = 0; p < G * G; p += 1) if (targetSmall[p]) { targetArea += 1; tx += p % G; ty += Math.floor(p / G); }
  if (!targetArea) throw new Error('主圖上找不到這個配件，無法擺位。');
  tx /= targetArea; ty /= targetArea;
  // 配件的取樣點（最多約 2500 點）
  let refArea = 0;
  for (let p = 0; p < ref.width * ref.height; p += 1) if (ref.data[p * 4 + 3] > 127) refArea += 1;
  if (!refArea) throw new Error('配件圖是空的。');
  const stride = Math.max(1, Math.round(Math.sqrt(refArea / 2500)));
  const pts = [];
  for (let y = 0; y < ref.height; y += stride) for (let x = 0; x < ref.width; x += stride) {
    const i = (y * ref.width + x) * 4;
    if (ref.data[i + 3] > 127) pts.push(x - ref.width / 2, y - ref.height / 2, ref.data[i], ref.data[i + 1], ref.data[i + 2]);
  }
  const n = pts.length / 5;
  const evaluate = (t) => {
    const rad = (t.angle * Math.PI) / 180; const cos = Math.cos(rad); const sin = Math.sin(rad); const f = t.flip ? -1 : 1;
    let onTarget = 0; let empty = 0; let colorSum = 0; let onOther = 0;
    for (let j = 0; j < pts.length; j += 5) {
      const u = pts[j] * f * t.scale; const v = pts[j + 1] * t.scale;
      const x = Math.round((t.cx + cos * u - sin * v) * k); const y = Math.round((t.cy + sin * u + cos * v) * k);
      if (x < 0 || y < 0 || x >= G || y >= G) { empty += 1; continue; }
      const p = y * G + x;
      if (targetSmall[p]) {
        onTarget += 1;
        const i = p * 4;
        colorSum += 1 - (Math.abs(masterSmall.data[i] - pts[j + 2]) + Math.abs(masterSmall.data[i + 1] - pts[j + 3]) + Math.abs(masterSmall.data[i + 2] - pts[j + 4])) / 765;
      } else if (!opaque[p]) empty += 1;
      else onOther += 1;
    }
    const cell = (stride * t.scale * k) ** 2; // 一個取樣點在小圖上佔的面積
    const hit = onTarget * cell;
    const recall = Math.min(1, hit / targetArea);
    const color = onTarget ? colorSum / onTarget : 0;
    // 在身體前面的配件：不該有東西被擋住 → 要和主圖上的配件範圍「重疊得剛好」（IoU）；
    // 會繞到身體後面的：落在身體上的部分算正常（被擋住），只看有沒有蓋滿看得到的部分、有沒有跑到空白處
    const placed = n * cell;
    const iou = hit / Math.max(1, placed + targetArea - Math.min(hit, targetArea));
    const score = order === 'front'
      ? 0.6 * iou + 0.15 * recall + 0.25 * color
      : 0.45 * recall + 0.15 * ((onTarget + 0.5 * onOther) / n) + 0.25 * (1 - empty / n) + 0.15 * color;
    return { score, recall, iou, onTarget: onTarget / n, empty: empty / n, color };
  };
  const s0 = Math.sqrt((targetArea / k / k) / refArea);
  let best = null;
  const consider = (t) => { const fit = evaluate(t); if (!best || fit.score > best.fit.score) best = { ...t, fit }; };
  const span = Math.sqrt(targetArea) / k * 0.3;
  for (const flip of [false, true]) {
    for (let angle = -angles; angle <= angles; angle += 5) {
      for (const m of [0.8, 0.9, 1, 1.1, 1.22, 1.36, 1.52]) {
        for (let gy = -4; gy <= 4; gy += 1) for (let gx = -4; gx <= 4; gx += 1) {
          consider({ flip, angle, scale: s0 * m, cx: tx / k + (gx * span) / 4, cy: ty / k + (gy * span) / 4 });
        }
      }
    }
  }
  // 細調
  for (let round = 0; round < 3; round += 1) {
    const base = { ...best };
    const step = [8, 4, 2][round];
    for (let da = -2; da <= 2; da += 1) for (const ds of [0.96, 0.98, 1, 1.02, 1.04]) for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      consider({ flip: base.flip, angle: base.angle + da * (step / 4), scale: base.scale * ds, cx: base.cx + dx * step, cy: base.cy + dy * step });
    }
  }
  return best;
}

/**
 * 像外框的一塊（配件卡片的框線，可能斷成好幾段）：細細的，而且幾乎都貼著框的四邊。
 */
function frameLike(label, id, count, width, height, rect) {
  const [rx0, ry0, rx1, ry1] = rect;
  const margin = Math.max(4, Math.round(0.05 * Math.max(rx1 - rx0, ry1 - ry0)));
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1; let nearEdge = 0;
  for (let p = 0; p < label.length; p += 1) {
    if (label[p] !== id) continue;
    const x = p % width; const y = (p - x) / width;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (Math.min(Math.abs(x - rx0), Math.abs(x - rx1), Math.abs(y - ry0), Math.abs(y - ry1)) <= margin || x < rx0 || x > rx1 || y < ry0 || y > ry1) nearEdge += 1;
  }
  const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
  const thin = count / (bw * bh) < 0.15 || Math.min(bw, bh) <= margin * 1.5;
  const long = Math.max(bw, bh) >= 0.25 * Math.max(rx1 - rx0, ry1 - ry0);
  return thin && long && nearEdge / count > 0.85;
}

/** 從遮罩裡去掉像外框的細長塊（比對的標準答案不能把卡片框線算進去） */
export function dropFrames(area, width, height, rect) {
  const label = new Int32Array(area.length).fill(-1); const queue = new Int32Array(area.length);
  const out = new Uint8Array(area);
  let id = 0;
  for (let start = 0; start < area.length; start += 1) {
    if (!area[start] || label[start] !== -1) continue;
    let head = 0; let tail = 0; label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++];
      const x = p % width; const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (area[q] && label[q] === -1) { label[q] = id; queue[tail++] = q; }
      }
    }
    if (frameLike(label, id, tail, width, height, rect)) for (let k = 0; k < tail; k += 1) out[queue[k]] = 0;
    id += 1;
  }
  return out;
}

/**
 * 把 mask 範圍「補成周圍的顏色」（擴散補圖）：拿掉本體上的眼睛、嘴巴後，留下的洞用周圍的皮膚顏色自然補起來。
 * 只動 RGB，透明度不變。
 */
export function inpaint(image, mask, { iterations = 400 } = {}) {
  const { width, height } = image;
  let x0 = width; let y0 = height; let x1 = -1; let y1 = -1;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const x = p % width; const y = (p - x) / width;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const data = new Uint8Array(image.data);
  if (x1 < 0) return { ...image, data };
  const bx0 = Math.max(0, x0 - 2); const by0 = Math.max(0, y0 - 2); const bx1 = Math.min(width - 1, x1 + 2); const by1 = Math.min(height - 1, y1 + 2);
  const bw = bx1 - bx0 + 1; const bh = by1 - by0 + 1;
  const values = [0, 1, 2].map((c) => {
    const plane = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) plane[y * bw + x] = data[((by0 + y) * width + bx0 + x) * 4 + c];
    return plane;
  });
  const holes = [];
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) if (mask[(by0 + y) * width + bx0 + x]) holes.push(y * bw + x);
  // 起始值：每一點用同一列左右、同一欄上下最近的邊緣顏色做線性內插再平均，接近最後結果，收斂快、不會留下方塊痕
  const hole = new Uint8Array(bw * bh);
  for (const i of holes) hole[i] = 1;
  for (const plane of values) {
    const init = new Float32Array(plane.length);
    const weight = new Float32Array(plane.length);
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        if (!hole[y * bw + x] || (x > 0 && hole[y * bw + x - 1])) continue;
        let end = x; while (end < bw && hole[y * bw + end]) end += 1;
        const a = x > 0 ? plane[y * bw + x - 1] : (end < bw ? plane[y * bw + end] : 255);
        const b = end < bw ? plane[y * bw + end] : a;
        for (let k = x; k < end; k += 1) { const t = (k - x + 1) / (end - x + 1); init[y * bw + k] += a + (b - a) * t; weight[y * bw + k] += 1; }
      }
    }
    for (let x = 0; x < bw; x += 1) {
      for (let y = 0; y < bh; y += 1) {
        if (!hole[y * bw + x] || (y > 0 && hole[(y - 1) * bw + x])) continue;
        let end = y; while (end < bh && hole[end * bw + x]) end += 1;
        const a = y > 0 ? plane[(y - 1) * bw + x] : (end < bh ? plane[end * bw + x] : 255);
        const b = end < bh ? plane[end * bw + x] : a;
        for (let k = y; k < end; k += 1) { const t = (k - y + 1) / (end - y + 1); init[k * bw + x] += a + (b - a) * t; weight[k * bw + x] += 1; }
      }
    }
    for (const i of holes) plane[i] = weight[i] ? init[i] / weight[i] : 255;
  }
  for (let round = 0; round < iterations; round += 1) {
    for (const plane of values) {
      for (const i of holes) {
        const x = i % bw; const y = (i - x) / bw;
        let sum = 0; let count = 0;
        if (x > 0) { sum += plane[i - 1]; count += 1; }
        if (x < bw - 1) { sum += plane[i + 1]; count += 1; }
        if (y > 0) { sum += plane[i - bw]; count += 1; }
        if (y < bh - 1) { sum += plane[i + bw]; count += 1; }
        plane[i] = sum / count;
      }
    }
  }
  for (const i of holes) {
    const x = i % bw; const y = (i - x) / bw;
    const o = ((by0 + y) * width + bx0 + x) * 4;
    for (let c = 0; c < 3; c += 1) data[o + c] = Math.round(values[c][i]);
  }
  return { ...image, data };
}
