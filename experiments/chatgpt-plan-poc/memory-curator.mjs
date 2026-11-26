import { extractJsonObject } from './json-reply.mjs';

// 長期記憶整理：對話結束後，請指定的 AI 判斷這段對話有沒有「之後還用得到、而且跟這隻精靈的工作有關」的資訊。
// 有的話整理成一篇筆記存進資料庫；閒聊、一次性的問題、跟精靈無關的內容就不存。

const MAX_TRANSCRIPT = 24000;

/** 把對話整理成純文字給 AI 讀（圖片只標註，不送出） */
export function transcriptFromMessages(messages = []) {
  const lines = [];
  for (const message of messages) {
    if (!message?.text && !message?.imageDataUrl) continue;
    if (message.role === 'user') {
      const extra = [message.sourceText ? `（附上的文字）\n${message.sourceText}` : '', message.imageDataUrl ? '（附了一張圖片）' : ''].filter(Boolean).join('\n');
      lines.push(`【使用者】\n${message.text || ''}${extra ? `\n${extra}` : ''}`);
    } else if (message.role === 'assistant' && message.status !== 'failed') {
      lines.push(`【${message.label || 'AI'}】\n${message.text || ''}`);
    }
  }
  let text = lines.join('\n\n');
  if (text.length > MAX_TRANSCRIPT) text = `（前面省略）\n${text.slice(-MAX_TRANSCRIPT)}`;
  return text;
}

export function buildCuratorPrompt({ spirit, transcript, existingTitles = [] }) {
  const role = [spirit.role?.identity, spirit.role?.positioning].filter(Boolean).join('\n') || '（沒有填寫）';
  return [
    `你是「${spirit.name}」這隻 AI 小精靈的記憶整理員。`,
    '',
    '## 這隻精靈負責的工作',
    spirit.summary ? `簡述：${spirit.summary}` : '',
    role,
    '',
    '## 你的任務',
    '閱讀下面這段對話，判斷裡面有沒有「之後這隻精靈做同類工作時還用得到」的資訊，例如：',
    '- 使用者的偏好、習慣、固定的格式要求',
    '- 做出的決定、確認過的事實、專有名詞與術語的對照',
    '- 使用者糾正過的錯誤（之後不要再犯）',
    '- 反覆出現的需求或工作流程',
    '',
    '不要存的內容：閒聊、一次性的問題、跟這隻精靈的工作無關的事、AI 自己的推測、',
    '以及任何密碼、金鑰、身分證號、卡號、帳號等敏感資料。',
    '如果沒有值得記的，就回答不存。寧可少存，不要把整段對話照抄。',
    '',
    existingTitles.length ? `## 已經記過的主題（不要重複記同一件事）\n${existingTitles.map((title) => `- ${title}`).join('\n')}` : '',
    '',
    '## 要整理的對話',
    transcript,
    '',
    '## 回答格式',
    '只輸出一個 JSON，不要加任何其他文字或 ``` 標記：',
    '{"save": true 或 false, "reason": "一句話說明為什麼存或不存", "title": "簡短的主題（15 字內）", "tags": ["標籤"], "content": "要存的重點，用 Markdown 條列，每點一句話"}',
    '不存的時候，title、tags、content 可以留空。',
  ].filter((line) => line !== '').join('\n').replace(/\n## /g, '\n\n## ');
}

/** 從 AI 的回覆裡取出 JSON（AI 有時會多講幾句或包在 ``` 裡） */
export function parseCuratorReply(text = '') {
  const data = extractJsonObject(text, '整理記憶的 AI 沒有照格式回答。');
  const save = data.save === true || data.save === 'true';
  const content = typeof data.content === 'string' ? data.content.trim()
    : Array.isArray(data.content) ? data.content.map((line) => `- ${String(line).replace(/^-\s*/, '')}`).join('\n') : '';
  return {
    save: save && Boolean(content),
    reason: typeof data.reason === 'string' ? data.reason.slice(0, 200) : '',
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 40) : '記憶',
    tags: Array.isArray(data.tags) ? data.tags.map(String).slice(0, 8) : [],
    content: content.slice(0, 6000),
  };
}

/**
 * 整理一段對話並視情況存檔。
 * @param {{ spirit, messages, ask: (prompt) => Promise<string>, listTitles: () => Promise<string[]>, write: (note) => Promise<string> }} options
 * @returns {Promise<{ saved: boolean, reason: string, file?: string, title?: string }>}
 */
export async function curateConversation({ spirit, messages, ask, listTitles, write }) {
  const transcript = transcriptFromMessages(messages);
  if (transcript.replace(/\s/g, '').length < 20) return { saved: false, reason: '對話太短，沒有可以整理的內容。' };
  const prompt = buildCuratorPrompt({ spirit, transcript, existingTitles: await listTitles() });
  const result = parseCuratorReply(await ask(prompt));
  if (!result.save) return { saved: false, reason: result.reason || 'AI 判斷這段對話沒有需要長期記住的內容。' };
  const file = await write({ spiritName: spirit.name, title: result.title, tags: result.tags, content: result.content });
  return { saved: true, reason: result.reason, file, title: result.title };
}
