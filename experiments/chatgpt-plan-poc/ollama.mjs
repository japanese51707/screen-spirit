// Ollama：模型跑在使用者自己的 Mac 上（http://127.0.0.1:11434），不用網路、不花錢，資料不離開電腦。
// 看圖能力：/api/show 回傳的 capabilities 有 'vision' 才能看圖；不能看圖的模型會改送本機 OCR 文字。
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

const SYSTEM_PROMPT = '你是「螢幕小精靈」的回答助理。請直接回答使用者的問題，使用繁體中文，除非使用者用其他語言提問。';

async function call(path, { method = 'GET', body, signal, baseUrl = OLLAMA_BASE_URL, timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Ollama 有沒有在執行；有的話回傳已下載的模型與各自能不能看圖 */
export async function probeOllama({ baseUrl } = {}) {
  let response;
  try {
    response = await call('/api/tags', { baseUrl, timeoutMs: 1500 });
  } catch {
    return { running: false, models: [], vision: {} };
  }
  if (!response.ok) return { running: false, models: [], vision: {} };
  const json = await response.json();
  const models = (json.models || []).map((model) => String(model.name || model.model || '')).filter(Boolean).sort();
  const vision = {};
  await Promise.all(models.map(async (name) => {
    try {
      const show = await call('/api/show', { method: 'POST', body: { model: name }, baseUrl, timeoutMs: 4000 });
      const info = await show.json();
      vision[name] = Array.isArray(info.capabilities) ? (info.capabilities.includes('vision') ? 'yes' : 'no') : 'unknown';
    } catch {
      vision[name] = 'unknown';
    }
  }));
  return { running: true, models, vision };
}

/** 串流問答；messages 是 Ollama 格式（{ role, content, images?: [base64] }） */
export async function streamOllamaChat({ model, messages, onDelta = () => {}, signal, baseUrl }) {
  let response;
  try {
    response = await call('/api/chat', {
      method: 'POST', baseUrl, signal, timeoutMs: 0,
      body: { model, stream: true, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages] },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('連不到 Ollama。請先打開 Ollama App（或在終端機執行 ollama serve）。');
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Ollama 回應錯誤（${response.status}）：${detail.slice(0, 200)}`);
    if (/image|vision|multimodal/i.test(detail)) error.imageUnsupported = true;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const handle = (line) => {
    if (!line.trim()) return false;
    let event;
    try { event = JSON.parse(line); } catch { return false; }
    if (event.error) throw new Error(`Ollama：${event.error}`);
    const delta = event.message?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      onDelta(delta);
    }
    return Boolean(event.done);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (handle(line)) return text;
    }
  }
  if (buffer) handle(buffer);
  return text;
}
