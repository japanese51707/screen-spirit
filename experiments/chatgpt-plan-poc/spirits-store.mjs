// 精靈博士：專項小精靈的設定，存在這台電腦（userData/spirits.json）。
// 每隻精靈有 6 組設定：資料庫與記憶、限制、角色身份與定位、指定 AI、工作拆解 SOP、造型。
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const text = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '');
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const MAX_IMAGE = 1_500_000; // 卡面圖片（data URL）上限，畫面那邊會先縮小

export const RARITIES = ['N', 'R', 'SR', 'SSR'];
export const COLORS = ['violet', 'sky', 'mint', 'amber', 'rose', 'slate'];

export function defaultSpirit(overrides = {}) {
  const now = new Date().toISOString();
  return sanitizeSpirit({
    id: randomUUID(),
    name: '新的小精靈',
    summary: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

/** 只留下認得的欄位、限制長度；畫面送來的資料一律經過這裡 */
export function sanitizeSpirit(raw = {}) {
  const memory = raw.memory || {};
  const limits = raw.limits || {};
  const role = raw.role || {};
  const ai = raw.ai || {};
  const sop = raw.sop || {};
  const look = raw.look || {};
  const image = typeof look.image === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(look.image) && look.image.length <= MAX_IMAGE ? look.image : '';
  return {
    id: typeof raw.id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : randomUUID(),
    name: text(raw.name, 40).trim() || '未命名的小精靈',
    summary: text(raw.summary, 120),
    createdAt: text(raw.createdAt, 40) || new Date().toISOString(),
    updatedAt: text(raw.updatedAt, 40) || new Date().toISOString(),
    // 1. 資料庫與記憶
    memory: {
      knowledge: text(memory.knowledge, 20000), // 每次都要帶給 AI 的背景知識
      sources: (Array.isArray(memory.sources) ? memory.sources : []).slice(0, 30).map((item) => ({
        kind: pick(item?.kind, ['folder', 'file', 'url'], 'file'),
        path: text(item?.path, 1000),
        label: text(item?.label, 80),
      })).filter((item) => item.path),
      mode: pick(memory.mode, ['none', 'session', 'persistent'], 'session'), // 不記憶／只記這段對話／長期記憶
      // 資料庫位置：電腦裡的資料夾、Obsidian 筆記庫、雲端硬碟的同步資料夾；長期記憶也存在這裡的「記憶」資料夾
      home: memory.home && typeof memory.home.path === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(memory.home.path) ? { // 絕對路徑（macOS／Windows）
        kind: pick(memory.home.kind, ['local', 'obsidian', 'cloud'], 'local'),
        path: text(memory.home.path, 1000),
        label: text(memory.home.label, 160),
        provider: text(memory.home.provider, 40),
      } : null,
      // 對話結束後負責整理長期記憶的 AI（要能把文字拿回來的：Claude Code、Codex、Gemini、MixRoute、Ollama、內建）
      curator: { targetId: text(memory.curator?.targetId, 60), model: text(memory.curator?.model, 120) },
      notes: text(memory.notes, 8000), // 長期記憶的內容（之後由精靈自動累積）
    },
    // 2. 限制
    limits: {
      allowed: text(limits.allowed, 12000),
      forbidden: text(limits.forbidden, 12000),
      askFirst: text(limits.askFirst, 6000), // 範圍內但會產生實際影響、要先問使用者的事
      // 「讓 AI 幫我寫」的設定：使用者的想法、分析深度、用哪個 AI
      generator: {
        brief: text(limits.generator?.brief, 2000),
        depth: pick(limits.generator?.depth, ['quick', 'standard', 'deep'], 'standard'),
        targetId: text(limits.generator?.targetId, 60),
        model: text(limits.generator?.model, 120),
      },
      replyLength: pick(limits.replyLength, ['short', 'medium', 'long'], 'medium'),
      confirmBeforeAction: limits.confirmBeforeAction !== false,
      citeSources: limits.citeSources === true,
    },
    // 3. 角色身份與定位
    role: {
      identity: text(role.identity, 8000),
      positioning: text(role.positioning, 8000),
      audience: text(role.audience, 1000),
      tone: pick(role.tone, ['friendly', 'professional', 'concise', 'teacher', 'playful'], 'friendly'),
      language: pick(role.language, ['zh-Hant', 'zh-Hans', 'en', 'ja', 'auto'], 'zh-Hant'),
      // 「讓 AI 幫我寫」的設定
      generator: {
        brief: text(role.generator?.brief, 2000),
        depth: pick(role.generator?.depth, ['quick', 'standard', 'deep'], 'standard'),
        targetId: text(role.generator?.targetId, 60),
        model: text(role.generator?.model, 120),
      },
    },
    // 4. 指定 AI
    ai: {
      targetId: text(ai.targetId, 60),
      model: text(ai.model, 120),
      fallbackTargetId: text(ai.fallbackTargetId, 60),
      // 生圖：回答需要圖片時，把提示詞交給這個 MixRoute 生圖模型畫出來
      imageModel: text(ai.imageModel, 120),
      imageSize: pick(ai.imageSize, ['1024x1024', '1536x1024', '1024x1536', 'auto'], '1024x1024'),
    },
    // 5. 工作拆解 SOP
    sop: {
      steps: (Array.isArray(sop.steps) ? sop.steps : []).slice(0, 20).map((step) => ({
        title: text(step?.title, 80),
        detail: text(step?.detail, 3000),
      })),
      outputFormat: text(sop.outputFormat, 4000),
      // 「讓 AI 幫我寫」的設定
      generator: {
        brief: text(sop.generator?.brief, 2000),
        depth: pick(sop.generator?.depth, ['quick', 'standard', 'deep'], 'standard'),
        targetId: text(sop.generator?.targetId, 60),
        model: text(sop.generator?.model, 120),
      },
    },
    // 6. 造型
    look: {
      emoji: text(look.emoji, 8) || '✦',
      color: pick(look.color, COLORS, 'violet'),
      rarity: pick(look.rarity, RARITIES, 'R'),
      image,
      cardMode: look.cardMode === 'image' ? 'image' : 'skin', // 有動態造型時，卡片上顯示動態造型或靜態圖片
    },
  };
}

export function createSpiritStore(path) {
  let cache;
  let queue = Promise.resolve();
  async function load() {
    if (cache) return cache;
    try {
      const json = JSON.parse(await readFile(path, 'utf8'));
      cache = (Array.isArray(json?.spirits) ? json.spirits : []).map(sanitizeSpirit);
    } catch {
      cache = [];
    }
    return cache;
  }
  async function persist() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, spirits: cache }, null, 2), { mode: 0o600 });
    await rename(temporary, path);
  }
  // 寫入排隊進行，避免快速連續儲存時互相覆蓋
  const serial = (task) => (queue = queue.then(task, task));
  return {
    list: () => load().then((items) => structuredClone(items)),
    save: (raw) => serial(async () => {
      await load();
      const spirit = sanitizeSpirit({ ...raw, updatedAt: new Date().toISOString() });
      const index = cache.findIndex((item) => item.id === spirit.id);
      if (index >= 0) cache[index] = { ...spirit, createdAt: cache[index].createdAt };
      else cache.push(spirit);
      await persist();
      return structuredClone(index >= 0 ? cache[index] : spirit);
    }),
    remove: (id) => serial(async () => {
      await load();
      cache = cache.filter((item) => item.id !== id);
      await persist();
      return structuredClone(cache);
    }),
  };
}
