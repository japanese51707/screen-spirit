import { extractJsonObject } from './json-reply.mjs';

// 角色身份與定位產生器：使用者用自己的話描述想要的精靈，AI 先判斷對應的現實職業，
// 再寫出名稱、卡片簡述、服務對象、身份（給 AI 的角色設定）、定位與專長、建議語氣。

export const ROLE_DEPTHS = {
  quick: {
    label: '簡要',
    spec: [
      '- 身份：2～3 句話。',
      '- 定位與專長：3～5 點，每點一句話。',
    ],
  },
  standard: {
    label: '標準',
    spec: [
      '- 身份：一段 4～6 句話，寫出職業、資歷、專長領域與做事原則。',
      '- 定位與專長：6～10 點，依能力分組（每組用「### 能力名稱」當標題），寫出擅長的任務與產出物。',
    ],
  },
  deep: {
    label: '深入',
    spec: [
      '- 身份：兩段以上，寫出職業與資歷、專業知識範圍、價值觀與工作原則、面對使用者的態度，以及這個職業在現實中常遇到的情境。',
      '- 定位與專長：12 點以上，依能力分組（每組用「### 能力名稱」當標題），每點寫出具體做法、產出物範例與品質標準。',
      '- 先仔細思考這個職業的專家在現實中怎麼工作、怎麼判斷品質，再下筆。',
    ],
  },
};

export const TONES = ['friendly', 'professional', 'concise', 'teacher', 'playful'];
export const LANGUAGES = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'auto'];

export function buildRolePrompt({ spirit, brief = '', depth = 'standard' }) {
  const level = ROLE_DEPTHS[depth] || ROLE_DEPTHS.standard;
  const role = spirit.role || {};
  const defaultName = /^(新的小精靈|未命名的小精靈)$/.test(spirit.name || '');
  const facts = [
    ['使用者的想法', brief],
    ['目前的名稱', defaultName ? '' : spirit.name],
    ['目前的卡片簡述', spirit.summary],
    ['目前的服務對象', role.audience],
    ['目前的身份', role.identity],
    ['目前的定位與專長', role.positioning],
  ].filter(([, value]) => typeof value === 'string' && value.trim()).map(([key, value]) => `- ${key}：${value.trim()}`);
  return [
    '你是「AI 角色設計顧問」。使用者要建立一隻專門做某種工作的 AI 小精靈，請幫他寫出這隻精靈的角色身份與定位。',
    '使用者的描述可能很簡短或不夠精確，請你補足成專業、具體的角色設定；如果已經有填寫的內容，請保留原意再加以補強。',
    '',
    '## 使用者提供的資料',
    ...(facts.length ? facts : ['- （沒有提供）']),
    '',
    '## 請依照這個順序思考',
    '1. 判斷這個角色對應到現實社會中的哪一種職業或職務（例如：日中技術翻譯、財務分析師、客服專員、插畫造型師）。',
    '2. 名稱：取一個好記的精靈名字，10 個字以內，以「精靈」結尾（例如：日文翻譯精靈）。',
    '3. 卡片簡述：一句話說明這隻精靈做什麼，30 個字以內。',
    '4. 服務對象：這隻精靈主要幫誰工作（例如：業務部同事、客戶、自己）。',
    '5. 身份：寫給 AI 看的角色設定，用「你是……」開頭，以第二人稱描述這個職業的專家。',
    '6. 定位與專長：這隻精靈最擅長的任務、工作方法與產出物。只寫專長，不用寫不能做的事（那是「限制」負責的）。',
    '7. 語氣：從 friendly（親切）、professional（專業）、concise（簡潔直接）、teacher（像老師一樣解釋）、playful（活潑）選最適合這個職業的一個。',
    '8. 回覆語言：從 zh-Hant、zh-Hans、en、ja、auto 選一個；使用者沒特別說就用 zh-Hant。',
    '',
    `## 分析深度：${level.label}`,
    ...level.spec,
    '',
    '## 寫作規則',
    '- 使用繁體中文；要具體，不要寫「提供優質服務」這種空泛的話。',
    '- 條列的每一點都用「- 」開頭。',
    '',
    '## 回答格式',
    '只輸出一個 JSON，不要加任何其他文字或 ``` 標記：',
    '{"role": "一句話：判斷出的現實職業與定位", "name": "名稱", "summary": "卡片簡述", "audience": "服務對象", "identity": "身份（你是……）", "positioning": "定位與專長（Markdown 條列，可用 ### 分組）", "tone": "語氣代號", "language": "語言代號"}',
  ].join('\n');
}

const asText = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((line) => `- ${String(line).replace(/^-\s*/, '')}`).join('\n');
  return '';
};

export function parseRoleReply(text = '') {
  const data = extractJsonObject(text, 'AI 沒有照格式回答，請再試一次。');
  const result = {
    role: asText(data.role).slice(0, 200),
    name: asText(data.name).replace(/\s+/g, ' ').slice(0, 40),
    summary: asText(data.summary).slice(0, 120),
    audience: asText(data.audience).slice(0, 1000),
    identity: asText(data.identity).slice(0, 4000),
    positioning: asText(data.positioning).slice(0, 4000),
    tone: TONES.includes(data.tone) ? data.tone : '',
    language: LANGUAGES.includes(data.language) ? data.language : '',
  };
  if (!result.identity && !result.positioning) throw new Error('AI 沒有寫出身份與定位，請再試一次。');
  return result;
}
