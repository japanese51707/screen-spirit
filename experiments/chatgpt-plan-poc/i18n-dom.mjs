// 畫面翻譯：把畫面上（包含之後才加進來的）中文介面文字換成目前語言。
// 不翻譯：對話內容、使用者輸入的文字、精靈自己的設定內容（標 data-i18n-skip 的區塊）、輸入框、可編輯區。
import { getLanguage, tr } from './i18n.mjs';

const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'label', 'data-tooltip'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
const CJK = /[　-〿一-鿿＀-￯]/;

function skipped(element) {
  if (!element) return false;
  return Boolean(element.closest('[data-i18n-skip], [contenteditable="true"], textarea'));
}

function translateText(node) {
  const value = node.nodeValue;
  if (!value || !CJK.test(value)) return;
  if (SKIP_TAGS.has(node.parentElement?.tagName) || skipped(node.parentElement)) return;
  const next = tr(value);
  if (next !== value) node.nodeValue = next;
}

function translateAttributes(element) {
  if (skipped(element)) return;
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value && CJK.test(value)) {
      const next = tr(value);
      if (next !== value) element.setAttribute(name, next);
    }
  }
  if (element.tagName === 'INPUT' && ['button', 'submit'].includes(element.type) && CJK.test(element.value)) element.value = tr(element.value);
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root)) return;
    translateAttributes(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeType === Node.ELEMENT_NODE && (node.hasAttribute('data-i18n-skip') || SKIP_TAGS.has(node.tagName) || node.isContentEditable)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateText(node);
    else translateAttributes(node);
  }
}

/** 中文介面不需要做任何事；其他語言：翻譯一次，之後監看畫面變化 */
export function installTranslator(root = document.body) {
  document.documentElement.lang = getLanguage() === 'en' ? 'en' : 'zh-Hant';
  if (getLanguage() === 'zh-TW') return;
  document.title = tr(document.title);
  translateTree(root);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateText(record.target);
      else if (record.type === 'attributes') translateAttributes(record.target);
      else for (const node of record.addedNodes) translateTree(node);
    }
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
}
