// 從 AI 的回覆裡取出 JSON。AI 常見的問題：前後多講幾句、包在 ``` 裡、字串裡直接換行（JSON 不允許）。

/** 把字串值裡面「直接換行／Tab」改成 \n、\t，其他不動 */
export function repairJsonStrings(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) { escaped = false; output += char; continue; }
      if (char === '\\') { escaped = true; output += char; continue; }
      if (char === '"') { inString = false; output += char; continue; }
      if (char === '\n') { output += '\\n'; continue; }
      if (char === '\r') continue;
      if (char === '\t') { output += '\\t'; continue; }
      output += char;
    } else {
      if (char === '"') inString = true;
      output += char;
    }
  }
  return output;
}

/** 取出回覆裡的第一個 JSON 物件；失敗時丟出 errorMessage */
export function extractJsonObject(text = '', errorMessage = 'AI 回答的格式不正確。') {
  const cleaned = String(text).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(errorMessage);
  const body = cleaned.slice(start, end + 1);
  try { return JSON.parse(body); } catch {}
  try { return JSON.parse(repairJsonStrings(body)); } catch {}
  throw new Error(errorMessage);
}
