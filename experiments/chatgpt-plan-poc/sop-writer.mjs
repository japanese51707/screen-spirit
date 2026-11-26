import { extractJsonObject } from './json-reply.mjs';

// 工作拆解 SOP 產生器：用流程設計專家的角度，把使用者的需求拆成精靈可以照著執行的步驟。
// 步驟越具體（做法、檢查點、常見錯誤、何時先問使用者），AI 實際執行時越不容易出錯。

export const SOP_DEPTHS = {
  quick: {
    label: '簡要',
    spec: [
      '- 3～5 個步驟。',
      '- 每一步的 detail 寫兩行：「做法：」一到兩句，「檢查：」一句完成條件。',
    ],
  },
  standard: {
    label: '標準',
    spec: [
      '- 5～8 個步驟。',
      '- 每一步的 detail 依序寫：',
      '  「做法：」後面換行，用「- 」條列 2～4 個具體動作；',
      '  「檢查：」可以驗證的完成條件；',
      '  「注意：」這一步最常出錯的地方與預防方式。',
    ],
  },
  deep: {
    label: '深入',
    spec: [
      '- 8～15 個步驟，涵蓋準備、執行、驗證、交付，以及資料不足或遇到範圍外要求時的處理方式。',
      '- 每一步的 detail 依序寫：',
      '  「目的：」這一步為什麼存在；',
      '  「需要的輸入：」要先有哪些資料；',
      '  「做法：」後面換行，用「- 」條列具體動作，必要時寫出判斷規則（如果……就……）；',
      '  「檢查：」可以驗證的完成條件（數量、格式、一致性等）；',
      '  「常見錯誤：」與預防方式；',
      '  「先問使用者：」什麼情況要停下來確認（沒有就寫「無」）。',
      '- 先仔細思考這個職業的專家在現實中怎麼執行這件工作、哪裡最容易出錯，再下筆。',
    ],
  },
};

export function buildSopPrompt({ spirit, brief = '', depth = 'standard' }) {
  const level = SOP_DEPTHS[depth] || SOP_DEPTHS.standard;
  const role = spirit.role || {};
  const limits = spirit.limits || {};
  const existing = (spirit.sop?.steps || []).filter((step) => step.title || step.detail)
    .map((step, index) => `${index + 1}. ${step.title}${step.detail ? `：${step.detail.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
  const section = (title, value) => (typeof value === 'string' && value.trim() ? [`### ${title}`, value.trim(), ''] : []);
  return [
    '你是「工作流程設計專家」，擅長把專業工作拆成清楚、可以照做、不容易出錯的標準作業程序（SOP）。',
    '使用者要讓一隻 AI 小精靈照著這份 SOP 工作。步驟寫得越具體，AI 執行時越不容易出錯，所以請用這個職業的專業角度仔細考量。',
    '',
    '## 這隻精靈',
    `- 名稱：${spirit.name}`,
    spirit.summary ? `- 簡述：${spirit.summary}` : '',
    '',
    ...section('身份', role.identity),
    ...section('定位與專長', role.positioning),
    ...section('可以做的事', limits.allowed),
    ...section('不可以做的事', limits.forbidden),
    ...section('需要先問使用者的事', limits.askFirst),
    '## 使用者的需求（這份 SOP 要完成的工作）',
    brief.trim() || '（沒有另外說明，請依這隻精靈的定位，寫出它最主要那件工作的 SOP）',
    '',
    existing.length ? `## 目前已經有的步驟（請保留合理的部分，再補強、調整順序）\n${existing.join('\n')}\n` : '',
    '## 設計原則',
    '1. 先想清楚這件工作在現實中由專家怎麼完成，依照真正的先後順序排列。',
    '2. 第一步一定是「確認需求與輸入」：確認使用者要什麼、資料夠不夠；不夠時列出要問使用者的問題，不要自己猜。',
    '3. 每一步只做一件事，標題用「動詞＋對象」（例如：比對術語表、整理異常批號）。',
    '4. 做法要具體到別人照著做就能完成；避免「仔細檢查」「適當處理」這種模糊的話，要寫出檢查什麼、怎麼判斷。',
    '5. 遵守「不可以做的事」：步驟裡不能出現越權的動作。遇到「需要先問使用者的事」，在那一步之前加上確認。',
    '6. 最後兩步固定是「自我檢查」（逐項對照需求、限制與檢查點）和「交付」（依輸出格式整理，並列出待確認事項）。',
    '',
    `## 分析深度：${level.label}`,
    ...level.spec,
    '',
    '## 輸出格式（outputFormat）',
    '另外寫出最後交給使用者的成果長什麼樣子：包含哪些段落、用什麼格式（條列、表格）、放在最前面的是什麼。',
    '',
    '## 回答格式',
    '使用繁體中文。只輸出一個 JSON，不要加任何其他文字或 ``` 標記：',
    '{"task": "一句話：這份 SOP 要完成的工作", "steps": [{"title": "步驟名稱", "detail": "這一步的內容"}], "outputFormat": "成果的格式說明"}',
  ].filter((line) => line !== '').join('\n').replace(/\n## /g, '\n\n## ').replace(/\n### /g, '\n\n### ');
}

const asText = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((line) => `- ${String(line).replace(/^-\s*/, '')}`).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}：${asText(item)}`).join('\n');
  return '';
};

export function parseSopReply(text = '') {
  const data = extractJsonObject(text, 'AI 沒有照格式回答，請再試一次。');
  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .map((step) => (typeof step === 'string'
      ? { title: step.trim().slice(0, 80), detail: '' }
      : { title: asText(step?.title ?? step?.name).replace(/^\d+[.)、]\s*/, '').slice(0, 80), detail: asText(step?.detail ?? step?.description).slice(0, 3000) }))
    .filter((step) => step.title)
    .slice(0, 20);
  if (!steps.length) throw new Error('AI 沒有寫出步驟，請再試一次。');
  return {
    task: asText(data.task).slice(0, 200),
    steps,
    outputFormat: asText(data.outputFormat ?? data.output_format).slice(0, 4000),
  };
}
