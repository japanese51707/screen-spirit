// MixRoute（https://mixroute.ai）：OpenAI 相容的 AI API 閘道，一把金鑰可以用多家模型。
// 走標準 OpenAI 格式：Authorization: Bearer <金鑰>、GET /models、POST /chat/completions（stream）。
// 金鑰只在主程式使用，由呼叫端負責加密保存；這個模組不碰檔案。

export const MIXROUTE_BASE_URL = 'https://api.mixroute.ai/v1';

export const MIXROUTE_SYSTEM_PROMPT = [
  '你是「螢幕小精靈」的回答助理。使用者會附上螢幕圈選的圖片或反白的文字，以及畫面脈絡（來源程式）。',
  '請直接回答使用者的問題，使用繁體中文，除非使用者用其他語言提問。',
].join('\n');

function friendlyError(status, body) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(body || '').slice(0, 200);
  }
  // 帳號層級的模型限制（例如 MixRoute 後端的 Bedrock 不允許這個帳號用 Anthropic 模型）：直接告訴使用者換模型
  if (/Access to Anthropic models is not allowed/i.test(detail)) {
    const error = new Error('你的 MixRoute 帳號目前不能使用 Claude（Anthropic）模型。請在「模型」選單換成 GPT、Gemini、DeepSeek 等其他模型；若需要 Claude，請向 MixRoute 客服確認帳號是否要另外開通。');
    error.status = status;
    error.modelNotAllowed = true;
    return error;
  }
  // 模型不支援圖片：和「帳號不能用這個模型」分開處理——這種情況可以改送 OCR 文字重試
  if (/image|vision|image_url|multimodal|multi-modal/i.test(detail) && /not support|unsupported|does not support|not allowed|invalid|cannot/i.test(detail)) {
    const error = new Error(`這個模型不能看圖片。（${detail.slice(0, 160)}）`);
    error.status = status;
    error.imageUnsupported = true;
    return error;
  }
  // 用對話的方式呼叫了生圖／影片／語音這類專用模型
  if (/requested operation is unsupported|operation.*not supported|not a chat model|does not support chat|invalid.*endpoint/i.test(detail)) {
    const error = new Error(`這個模型不能用來對話（可能是生圖、影片或語音專用的模型），請換一個對話模型。（${detail.slice(0, 160)}）`);
    error.status = status;
    error.modelNotChat = true;
    return error;
  }
  if (/not allowed|not available|not supported|does not support|unsupported/i.test(detail) && /model/i.test(detail)) {
    const error = new Error(`這個模型目前不能處理這次的請求（例如帳號沒開通或不支援圖片），請換一個模型再試。（${detail.slice(0, 160)}）`);
    error.status = status;
    error.modelNotAllowed = true;
    return error;
  }
  const reasons = {
    400: 'MixRoute 拒絕了這次請求。',
    401: 'API 金鑰無效或已失效，請重新輸入。',
    402: 'MixRoute 帳戶額度不足，請先儲值。',
    403: '這把金鑰沒有使用此模型的權限。',
    404: '找不到這個模型，請換一個模型。',
    429: '請求太頻繁或達到用量上限，請稍後再試。',
  };
  const reason = reasons[status] || (status >= 500 ? 'MixRoute 服務暫時有問題，請稍後再試。' : `MixRoute 回應錯誤（${status}）。`);
  const error = new Error(detail ? `${reason}（${detail}）` : reason);
  error.status = status;
  return error;
}

async function request(path, { apiKey, baseUrl = MIXROUTE_BASE_URL, method = 'GET', body, signal, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: method === 'GET' ? 'application/json' : 'text/event-stream' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`連不到 MixRoute（${error.message}）。請確認網路連線。`);
  }
  if (!response.ok) throw friendlyError(response.status, await response.text().catch(() => ''));
  return response;
}

/** 列出這把金鑰可以用的模型（原始資料，含看圖能力等欄位）；也用來驗證金鑰是否有效。 */
export async function listMixRouteModelEntries({ apiKey, baseUrl, fetchImpl }) {
  const response = await request('/models', { apiKey, baseUrl, fetchImpl });
  const json = await response.json();
  const entries = new Map();
  for (const model of Array.isArray(json?.data) ? json.data : []) {
    const id = String(model?.id || '');
    if (id && !entries.has(id)) entries.set(id, model);
  }
  return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => ({ id, entry }));
}

/** 只要模型 id（排序後） */
export async function listMixRouteModels(options) {
  return (await listMixRouteModelEntries(options)).map(({ id }) => id);
}

/** 從模型清單挑一個預設值：優先 GPT、其次 Gemini、Claude Sonnet，否則第一個（有些帳號不能用 Anthropic 模型）。 */
export function pickDefaultModel(models) {
  for (const pattern of [/^gpt-/i, /gemini/i, /claude-sonnet/i]) {
    const found = models.find((id) => pattern.test(id));
    if (found) return found;
  }
  return models[0] || '';
}

/** 把一次提問轉成 OpenAI 格式的 user 訊息（有圖片就附上 data URL）。 */
export function buildUserMessage(text, imageDataUrl) {
  if (!imageDataUrl) return { role: 'user', content: text };
  return { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageDataUrl } }] };
}

/**
 * 串流問答。
 * @param messages OpenAI 格式的對話歷史（不含 system，這裡會自動加上）
 * @returns {Promise<string>} 完整回覆
 */
export async function streamMixRouteChat({ apiKey, model, messages, onDelta = () => {}, signal, baseUrl, fetchImpl }) {
  const response = await request('/chat/completions', {
    apiKey, baseUrl, fetchImpl, signal, method: 'POST',
    body: { model, stream: true, messages: [{ role: 'system', content: MIXROUTE_SYSTEM_PROMPT }, ...messages] },
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('event-stream')) {
    // 有些模型或閘道設定不支援串流，會直接回傳整段 JSON
    const json = await response.json();
    const text = json?.choices?.[0]?.message?.content || '';
    if (text) onDelta(text);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return true;
    let event;
    try { event = JSON.parse(payload); } catch { return false; }
    if (event?.error) throw new Error(`MixRoute 回覆中斷：${event.error.message || '未知錯誤'}`);
    const delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      onDelta(delta);
    }
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (handleLine(line)) return text;
    }
  }
  if (buffer) handleLine(buffer);
  return text;
}

// ── 生圖：OpenAI 相容的 Image API（/images/generations；有參考圖時用 /images/edits）──
const IMAGE_TIMEOUT_MS = 4 * 60 * 1000;

async function imageResultToDataUrl(json, fetchImpl, signal) {
  const item = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (item?.b64_json) {
    const format = /^(png|jpeg|webp)$/.test(json?.output_format || '') ? json.output_format : 'png';
    return { dataUrl: `data:image/${format};base64,${item.b64_json}`, revisedPrompt: item.revised_prompt || '' };
  }
  if (item?.url) {
    // 有些閘道回傳圖片網址：下載下來轉成 data URL（之後存檔、設成卡面都不用再連網）
    const response = await fetchImpl(item.url, { signal });
    if (!response.ok) throw new Error(`下載產生的圖片失敗（${response.status}）。`);
    const type = (response.headers.get('content-type') || 'image/png').split(';')[0];
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64');
    return { dataUrl: `data:${type};base64,${base64}`, revisedPrompt: item.revised_prompt || '' };
  }
  throw new Error('生圖模型沒有回傳圖片。');
}

/**
 * 產生一張圖片。referencePng（Buffer）有給的話，用它當參考圖修改（edits）；閘道不支援 edits 就改成直接產生。
 * @returns {Promise<{ dataUrl: string, revisedPrompt: string, usedReference: boolean }>}
 */
export async function generateMixRouteImage({ apiKey, model, prompt, size = '1024x1024', referencePng, signal, baseUrl = MIXROUTE_BASE_URL, fetchImpl = fetch }) {
  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const call = async (path, init) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) }, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) throw new Error('畫圖超過 4 分鐘還沒完成，已停止等待。');
      throw new Error(`連不到 MixRoute（${error.message}）。請確認網路連線。`);
    }
    if (!response.ok) throw friendlyError(response.status, await response.text().catch(() => ''));
    return response.json();
  };
  if (referencePng) {
    try {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', '1');
      if (size && size !== 'auto') form.append('size', size);
      form.append('image', new Blob([referencePng], { type: 'image/png' }), 'reference.png');
      return { ...(await imageResultToDataUrl(await call('/images/edits', { body: form }), fetchImpl, combined)), usedReference: true };
    } catch (error) {
      if (signal?.aborted || /額度|金鑰|頻繁|4 分鐘/.test(error.message)) throw error;
      // 閘道或模型不支援用參考圖修改：改成只用文字產生
    }
  }
  const body = { model, prompt, n: 1, ...(size && size !== 'auto' ? { size } : {}) };
  const json = await call('/images/generations', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...(await imageResultToDataUrl(json, fetchImpl, combined)), usedReference: false };
}

/** 從精靈的回答裡取出要交給生圖模型的提示詞（```image-prompt 區塊），並回傳去掉區塊後的文字 */
export function extractImagePrompt(text = '') {
  const match = /```image-prompt[^\n]*\n([\s\S]*?)```/i.exec(text);
  if (!match || !match[1].trim()) return { prompt: '', text };
  return { prompt: match[1].trim().slice(0, 4000), text: text.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim() };
}
