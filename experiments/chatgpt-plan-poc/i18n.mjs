// 介面語言：繁體中文（原文）與英文。
// 程式裡的文字都用中文寫；英文版靠 i18n-en.mjs 的對照表（完全相同的句子），
// 帶變數的句子在程式裡用 L(中文, 英文) 直接寫兩種版本。
import { EN, EN_PATTERNS } from './i18n-en.mjs';

export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'zh-TW', label: '繁體中文' },
];
export const isLanguage = (value) => LANGUAGES.some((item) => item.id === value);

/** 台灣地區（系統地區或偏好語言帶 TW）預設繁體中文，其他地區預設英文 */
export function suggestLanguage(locales = []) {
  return locales.filter(Boolean).some((locale) => /(^|[-_])TW($|[-_.@])/i.test(String(locale))) ? 'zh-TW' : 'en';
}

let current = 'zh-TW';
export function setLanguage(lang) { current = isLanguage(lang) ? lang : 'zh-TW'; }
export function getLanguage() { return current; }

/** 帶變數的句子：L(`中文 ${x}`, `English ${x}`) */
export const L = (zh, en) => (current === 'en' ? en : zh);

/** 固定的句子：查對照表；查不到就維持原文 */
export function tr(text, lang = current) {
  if (lang !== 'en' || typeof text !== 'string' || !text) return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  let out = EN[trimmed];
  if (out === undefined) {
    for (const [pattern, replacement] of EN_PATTERNS) {
      if (pattern.test(trimmed)) { out = trimmed.replace(pattern, replacement); break; }
    }
  }
  if (out === undefined) return text;
  const start = text.indexOf(trimmed);
  return text.slice(0, start) + out + text.slice(start + trimmed.length);
}
