// 判斷模型能不能「看圖片」。結果：'yes'｜'no'｜'unknown'。
// 判斷順序：1. 實際用過的結果（最準，會記下來） 2. API 模型清單回傳的欄位 3. 模型名稱所屬的家族。
// 這裡的家族清單是起始值，不保證完整；判斷錯了，用過一次就會被實際結果更正。

/** 從 OpenAI 相容 /models 回傳的單一模型資料，找看圖能力的欄位（不同閘道的格式不同） */
export function imageSupportFromApi(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';
  const lists = [
    entry.architecture?.input_modalities,
    entry.input_modalities,
    entry.modalities?.input,
    Array.isArray(entry.modalities) ? entry.modalities : undefined,
    entry.capabilities?.input_modalities,
  ].filter(Array.isArray);
  for (const list of lists) {
    const lower = list.map((item) => String(item).toLowerCase());
    if (lower.some((item) => item.includes('image') || item.includes('vision'))) return 'yes';
    if (lower.length) return 'no'; // 有列出輸入類型、卻沒有圖片
  }
  const flags = [entry.capabilities?.vision, entry.supports_vision, entry.vision, entry.capabilities?.image_input, entry.supports_image_input];
  if (flags.some((flag) => flag === true)) return 'yes';
  if (flags.some((flag) => flag === false)) return 'no';
  return 'unknown';
}

// 名稱判斷：先比對「不能看圖」的例外，再比對「能看圖」的家族
const TEXT_ONLY = [
  /deepseek(?!.*(vl|janus|ocr))/i, // DeepSeek V3／V4／R1 等文字模型（VL 系列除外）
  /gpt-3\.5/i,
  /^o1-mini|^o3-mini/i,
  /kimi-k2|moonshot-v1-(8k|32k|128k)$/i,
  /^qwen(?!.*(vl|omni|qvq))/i, // Qwen 文字模型（VL／Omni 除外）
  /^(mistral|mixtral|codestral|ministral)(?!.*(pixtral|medium-3|small-3))/i,
  /llama-?3(?!.*vision)/i,
  /embedding|whisper|tts|rerank/i,
];
const VISION = [
  /^gpt-4o|^gpt-4\.1|^gpt-4-turbo|^gpt-5/i,
  /^o1(?!-mini)|^o3(?!-mini)|^o4/i,
  /^claude-(3|opus|sonnet|haiku|fable)/i,
  /gemini/i,
  /grok-(2-vision|4|vision)/i,
  /llama-?4/i,
  /llama-?3\.2.*vision/i,
  /(qwen.*(vl|omni))|qvq/i,
  /pixtral|mistral-(medium|small)-3/i,
  /glm-4(\.\d)?v|glm-4\.5v|glm-5v/i,
  /deepseek.*(vl|janus)/i,
];

export function imageSupportFromName(id) {
  const name = String(id || '').split('/').pop(); // 「provider/model」只看後半
  if (TEXT_ONLY.some((pattern) => pattern.test(name))) return 'no';
  if (VISION.some((pattern) => pattern.test(name))) return 'yes';
  return 'unknown';
}

/** 綜合判斷：learned（用過的結果）> API 欄位 > 名稱 */
export function imageSupport(id, { apiEntry, learned } = {}) {
  if (learned === 'yes' || learned === 'no') return learned;
  const fromApi = imageSupportFromApi(apiEntry);
  if (fromApi !== 'unknown') return fromApi;
  return imageSupportFromName(id);
}

// ── 模型用途：能不能拿來「對話」。生圖、影片、語音、向量模型只能用各自的專用介面，用對話的方式呼叫會被拒絕 ──
export const MODEL_KIND_LABEL = { image: '生圖模型', video: '影片模型', audio: '語音模型', embedding: '向量模型' };
const NON_CHAT_NAMES = [
  [/gpt-image|dall-?e|imagen|flux|midjourney|^mj[-_]|stable-?diffusion|sdxl|^sd-?3|seedream|seededit|recraft|ideogram|kolors|cogview|wanx|qwen-image|hunyuan-?image|jimeng|playground-v/i, 'image'],
  [/sora|veo-?\d|kling|runway|hailuo|seedance|vidu|^wan-?2|pika|luma-|ray-?2/i, 'video'],
  [/tts|whisper|speech|audio-preview|realtime|suno|udio/i, 'audio'],
  [/embedding|embed-|rerank|moderation/i, 'embedding'],
];

/** 從 /models 回傳的欄位判斷用途（new-api／one-api 類的閘道會給 supported_endpoint_types） */
export function modelKindFromApi(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const lists = [entry.supported_endpoint_types, entry.endpoint_types, entry.endpoints, entry.output_modalities, entry.architecture?.output_modalities]
    .filter(Array.isArray).map((list) => list.map((item) => String(item).toLowerCase()));
  for (const list of lists) {
    if (!list.length) continue;
    if (list.some((item) => /chat|openai|anthropic|gemini|text|completion|responses/.test(item))) return 'chat';
    if (list.some((item) => /image/.test(item))) return 'image';
    if (list.some((item) => /video/.test(item))) return 'video';
    if (list.some((item) => /audio|speech|tts/.test(item))) return 'audio';
    if (list.some((item) => /embed|rerank/.test(item))) return 'embedding';
  }
  return '';
}

/** 'chat'｜'image'｜'video'｜'audio'｜'embedding'：API 欄位優先，其次看名稱；判斷不出來就當成可以對話 */
export function modelKind(id, entry) {
  const fromApi = modelKindFromApi(entry);
  if (fromApi) return fromApi;
  const name = String(id || '').split('/').pop();
  return NON_CHAT_NAMES.find(([pattern]) => pattern.test(name))?.[1] || 'chat';
}
