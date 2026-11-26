import { extractJsonObject } from './json-reply.mjs';

// 限制產生器：使用者描述得不精確也沒關係，請 AI 依照「角色 → 現實職責 → 可以做 → 不可以做（不越權）→ 需要先問」的順序寫出框架。

export const DEPTHS = {
  quick: {
    label: '簡要',
    spec: [
      '- 主要職責：3～5 項。',
      '- 可以做的事：5～8 點，每點一句話。',
      '- 不可以做的事：5～6 點。',
      '- 需要先問我的事：2～3 點。',
    ],
  },
  standard: {
    label: '標準',
    spec: [
      '- 主要職責：5～8 項。',
      '- 可以做的事：依職責分組（每組用「### 職責名稱」當標題），每組 2～4 點，合計約 15 點。',
      '- 不可以做的事：8～10 點，涵蓋資料、系統、對外溝通、金錢等面向。',
      '- 需要先問我的事：3～5 點。',
    ],
  },
  deep: {
    label: '深入',
    spec: [
      '- 主要職責：8～12 項，包含次要與支援性的職責。',
      '- 可以做的事：依職責分組（每組用「### 職責名稱」當標題），每點寫出具體情境或產出物，合計 25 點以上。',
      '- 不可以做的事：12～15 點，涵蓋資料、系統與程式、對外溝通、金錢與交易、法律與合約、隱私與個資、專業判斷（醫療、法律、投資）等面向，並寫出這個角色特別容易越權的情境。',
      '- 需要先問我的事：5～8 點，每點後面用括號說明為什麼要先問。',
      '- 先仔細思考這個角色在現實工作中會遇到的邊界情況，再下筆。',
    ],
  },
};

export function buildLimitsPrompt({ spirit, brief = '', depth = 'standard' }) {
  const level = DEPTHS[depth] || DEPTHS.standard;
  const role = spirit.role || {};
  const facts = [
    ['名稱', spirit.name],
    ['卡片簡述', spirit.summary],
    ['身份', role.identity],
    ['定位與專長', role.positioning],
    ['服務對象', role.audience],
    ['使用者自己的想法', brief],
  ].filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => `- ${key}：${value.trim()}`);
  return [
    '你是「AI 角色設計顧問」。使用者要建立一隻專門做某種工作的 AI 小精靈，請幫他寫出這隻精靈的工作範圍與限制。',
    '使用者的描述可能不夠精確，請你補足成專業、完整的框架。',
    '',
    '## 使用者提供的資料',
    ...facts,
    '',
    '## 請依照這個順序思考',
    '1. 判斷這個角色是什麼：對應到現實社會中的哪一種職業或職務（例如：造型師、日中技術翻譯、財務分析師、客服專員）。',
    '2. 列出這個職務在現實工作中的主要職責。',
    '3.「可以做的事」：依照上面的職責，條列寫出這隻精靈可以做的具體工作。',
    '4.「不可以做的事」：原則是「不越權」——只做使用者指定的角色範圍內的工作，範圍以外的事一律不做。',
    '   請列出這個角色最容易越權的具體例子（例如：造型精靈只做造型，不能修改系統數字、不能改程式碼、不能替使用者寄信或付款）。',
    '   最後一點固定寫：「以上職責以外的任何要求，都先說明這不在我的工作範圍內，並建議使用者改用合適的精靈。」',
    '5.「需要先問我的事」：在職責範圍內、但會產生實際影響或無法復原的動作（例如寄出、刪除、覆蓋檔案、對外發布、花錢），做之前要先取得使用者同意。',
    '',
    `## 分析深度：${level.label}`,
    ...level.spec,
    '',
    '## 寫作規則',
    '- 使用繁體中文；每一點都用「- 」開頭，以動詞開頭、具體可判斷（不要寫「做好工作」這種模糊的話）。',
    '- 「可以做的事」與「不可以做的事」不能互相矛盾。',
    '',
    '## 回答格式',
    '只輸出一個 JSON，不要加任何其他文字或 ``` 標記：',
    '{"role": "一句話：判斷出的現實職業與定位", "responsibilities": ["職責 1", "職責 2"], "allowed": "可以做的事（Markdown 條列，可用 ### 分組）", "forbidden": "不可以做的事（Markdown 條列）", "askFirst": "需要先問我的事（Markdown 條列）"}',
  ].join('\n');
}

const asText = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((line) => `- ${String(line).replace(/^-\s*/, '')}`).join('\n');
  return '';
};

/** 從 AI 的回覆取出 JSON（AI 有時會多講幾句或包在 ``` 裡） */
export function parseLimitsReply(text = '') {
  const data = extractJsonObject(text, 'AI 沒有照格式回答，請再試一次。');
  const result = {
    role: typeof data.role === 'string' ? data.role.trim().slice(0, 200) : '',
    responsibilities: Array.isArray(data.responsibilities) ? data.responsibilities.map((item) => String(item).trim()).filter(Boolean).slice(0, 15) : [],
    allowed: asText(data.allowed).slice(0, 12000),
    forbidden: asText(data.forbidden).slice(0, 12000),
    askFirst: asText(data.askFirst ?? data.ask_first).slice(0, 6000),
  };
  if (!result.allowed && !result.forbidden) throw new Error('AI 沒有寫出可以做與不可以做的事，請再試一次。');
  return result;
}
