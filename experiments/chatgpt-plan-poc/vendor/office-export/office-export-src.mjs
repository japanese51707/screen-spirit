// 工作流成品 → 使用者要的檔案類型（Markdown 轉 Word／Excel／PowerPoint／HTML；PDF 由主程式把 HTML 印成 PDF）。
// 這個檔案用 esbuild 打包成 ../../office-export.mjs（含 marked、docx、pptxgenjs、exceljs），主程式不用另外安裝套件。
// 重新打包：npm i marked docx pptxgenjs exceljs esbuild，然後
//   npx esbuild office-export-src.mjs --bundle --platform=node --format=esm --target=node20 --minify --legal-comments=eof \
//     --outfile=office-export.mjs --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
import { marked } from 'marked';
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, BorderStyle } from 'docx';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';

export const OUTPUT_FORMATS = ['md', 'html', 'pdf', 'docx', 'xlsx', 'pptx'];

const FONT = 'PingFang TC';

/** 行內 token → 純文字 */
function plain(tokens = []) {
  return tokens.map((token) => (token.tokens ? plain(token.tokens) : token.type === 'br' ? '\n' : (token.text ?? token.raw ?? ''))).join('');
}

/** 行內 token → docx TextRun（粗體、斜體、程式碼） */
function runs(tokens = [], style = {}) {
  const out = [];
  for (const token of tokens) {
    if (token.type === 'strong') out.push(...runs(token.tokens, { ...style, bold: true }));
    else if (token.type === 'em') out.push(...runs(token.tokens, { ...style, italics: true }));
    else if (token.type === 'del') out.push(...runs(token.tokens, { ...style, strike: true }));
    else if (token.type === 'codespan') out.push(new TextRun({ text: token.text, font: 'Menlo', ...style }));
    else if (token.type === 'link') out.push(...runs(token.tokens, { ...style, underline: {}, color: '2F5BD3' }));
    else if (token.type === 'br') out.push(new TextRun({ text: '', break: 1 }));
    else if (token.tokens) out.push(...runs(token.tokens, style));
    else out.push(new TextRun({ text: decode(token.text ?? token.raw ?? ''), font: FONT, ...style }));
  }
  return out;
}
const decode = (text) => String(text).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ── Word ──
export async function toDocx(markdown, { title = '' } = {}) {
  const tokens = marked.lexer(markdown);
  const children = [];
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
  const list = (token, level = 0) => {
    for (const [index, item] of token.items.entries()) {
      const inline = item.tokens.filter((child) => child.type === 'text' || child.type === 'paragraph');
      const number = token.ordered ? [new TextRun({ text: `${(Number(token.start) || 1) + index}. `, font: FONT })] : [];
      children.push(new Paragraph({
        children: [...number, ...runs(inline.flatMap((child) => child.tokens || [child]))],
        ...(token.ordered ? { numbering: undefined, bullet: undefined } : { bullet: { level } }),
        ...(token.ordered ? { indent: { left: 360 * (level + 1) } } : {}),
      }));
      for (const child of item.tokens) if (child.type === 'list') list(child, level + 1);
    }
  };
  for (const token of tokens) {
    if (token.type === 'heading') children.push(new Paragraph({ heading: HEADINGS[token.depth - 1], children: runs(token.tokens) }));
    else if (token.type === 'paragraph') children.push(new Paragraph({ children: runs(token.tokens), spacing: { after: 120 } }));
    else if (token.type === 'list') list(token);
    else if (token.type === 'code') for (const line of token.text.split('\n')) children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Menlo', size: 18 })], shading: { fill: 'F3F3F3' } }));
    else if (token.type === 'blockquote') children.push(new Paragraph({ children: runs(token.tokens.flatMap((child) => child.tokens || [])), indent: { left: 360 }, border: { left: { ...border, size: 12 } } }));
    else if (token.type === 'hr') children.push(new Paragraph({ border: { bottom: border }, children: [] }));
    else if (token.type === 'table') {
      const row = (cells, header) => new TableRow({ tableHeader: header, children: cells.map((cell) => new TableCell({ children: [new Paragraph({ children: runs(cell.tokens, header ? { bold: true } : {}) })], shading: header ? { fill: 'EDEDF7' } : undefined })) });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(token.header, true), ...token.rows.map((cells) => row(cells, false))] }));
      children.push(new Paragraph({ children: [] }));
    }
  }
  const doc = new Document({
    creator: 'Screen Spirit', title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [new TextRun(markdown)] })] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

// ── Excel：每個表格一個工作表（表格前最近的標題當工作表名稱）；沒有表格就把每一行放進「內容」工作表 ──
export async function toXlsx(markdown) {
  const tokens = marked.lexer(markdown);
  const book = new ExcelJS.Workbook();
  book.creator = 'Screen Spirit';
  const used = new Set();
  const sheetName = (raw) => {
    let base = String(raw || '表格').replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 28) || '表格';
    let name = base; let n = 2;
    while (used.has(name)) name = `${base.slice(0, 25)} ${n++}`;
    used.add(name);
    return name;
  };
  let heading = '';
  const number = (text) => (/^-?[\d,]+(\.\d+)?%?$/.test(text.trim()) ? (text.trim().endsWith('%') ? Number(text.replace(/[,%]/g, '')) / 100 : Number(text.replace(/,/g, ''))) : text);
  for (const token of tokens) {
    if (token.type === 'heading') heading = plain(token.tokens);
    if (token.type !== 'table') continue;
    const sheet = book.addWorksheet(sheetName(heading));
    sheet.addRow(token.header.map((cell) => decode(plain(cell.tokens))));
    for (const cells of token.rows) sheet.addRow(cells.map((cell) => number(decode(plain(cell.tokens)))));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDF7' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.columns.forEach((column, index) => {
      const width = Math.max(...[token.header[index], ...token.rows.map((cells) => cells[index])].map((cell) => [...decode(plain(cell?.tokens || []))].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
      column.width = Math.min(60, Math.max(8, width + 2));
    });
  }
  // 全部的文字也放一份（表格以外的說明不會不見）
  const text = book.addWorksheet(sheetName(used.size ? '完整內容' : '內容'));
  text.getColumn(1).width = 120;
  for (const line of markdown.split('\n')) text.addRow([line]).alignment = { wrapText: true, vertical: 'top' };
  if (used.size > 1) book.worksheets.push(book.worksheets.splice(book.worksheets.indexOf(text), 1)[0]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ── PowerPoint：# 是封面標題，每個 ## 是一張投影片，下面的條列、段落、表格放在投影片上 ──
export async function toPptx(markdown, { title = '' } = {}) {
  const tokens = marked.lexer(markdown);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  const ACCENT = '5B4FD6';
  const slides = [];
  let cover = title;
  let current;
  const intro = []; // 第一個 ## 之前的段落：放在封面當副標
  for (const token of tokens) {
    if (token.type === 'space' || token.type === 'html') continue;
    if (token.type === 'heading' && token.depth === 1 && !slides.length && !current) { cover = plain(token.tokens); continue; }
    if (token.type === 'heading' && token.depth <= 2) { current = { title: plain(token.tokens), items: [] }; slides.push(current); continue; }
    if (!current && token.type === 'paragraph' && intro.join('').length < 160) { intro.push(decode(plain(token.tokens))); continue; }
    if (!current) { current = { title: cover || '內容', items: [] }; slides.push(current); }
    current.items.push(token);
  }
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: 'F6F5F1' };
  titleSlide.addText(cover || title || '成品', { x: 0.8, y: 2.4, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: '2C2A4A', fontFace: FONT });
  titleSlide.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.9, w: 2.2, h: 0.08, fill: { color: ACCENT }, line: { color: ACCENT } });
  if (intro.length) titleSlide.addText(intro.join('\n'), { x: 0.8, y: 4.2, w: 11.7, h: 1.2, fontSize: 18, color: '5C5A78', fontFace: FONT, valign: 'top' });
  for (const page of slides) {
    const slide = pptx.addSlide();
    slide.addText(page.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.8, fontSize: 28, bold: true, color: '2C2A4A', fontFace: FONT });
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.15, w: 1.4, h: 0.06, fill: { color: ACCENT }, line: { color: ACCENT } });
    const bullets = [];
    let table;
    for (const token of page.items) {
      if (token.type === 'list') {
        const walk = (list, level) => {
          for (const item of list.items) {
            bullets.push({ text: decode(plain(item.tokens.filter((child) => child.type !== 'list').flatMap((child) => child.tokens || [child]))), options: { bullet: list.ordered ? { type: 'number' } : true, indentLevel: level } });
            for (const child of item.tokens) if (child.type === 'list') walk(child, level + 1);
          }
        };
        walk(token, 0);
      } else if (token.type === 'paragraph' || token.type === 'heading' || token.type === 'blockquote') {
        bullets.push({ text: decode(plain(token.tokens || [])), options: { bullet: false, bold: token.type === 'heading' } });
      } else if (token.type === 'code') {
        bullets.push({ text: token.text, options: { bullet: false, fontFace: 'Menlo', fontSize: 12 } });
      } else if (token.type === 'table' && !table) {
        table = [token.header.map((cell) => ({ text: decode(plain(cell.tokens)), options: { bold: true, fill: { color: 'EDEDF7' } } })), ...token.rows.map((cells) => cells.map((cell) => ({ text: decode(plain(cell.tokens)) })))];
      }
    }
    const top = 1.45;
    if (bullets.length) slide.addText(bullets.map((item) => ({ text: item.text, options: { ...item.options, breakLine: true } })), { x: 0.6, y: top, w: table ? 5.8 : 12.1, h: 5.6, fontSize: bullets.length > 10 ? 14 : 18, color: '3A3858', fontFace: FONT, valign: 'top', paraSpaceAfter: 6, fit: 'shrink' });
    if (table) slide.addTable(table, { x: bullets.length ? 6.6 : 0.6, y: top, w: bullets.length ? 6.1 : 12.1, fontSize: 12, fontFace: FONT, border: { type: 'solid', color: 'BFBFBF', pt: 0.5 }, autoPage: true });
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

// ── HTML（也拿來印 PDF） ──
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
export function toHtml(markdown, { title = '' } = {}) {
  // 不讓成品裡的 HTML 原樣執行（AI 的回覆可能夾帶 <script>）：原始 HTML 一律當文字顯示
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  const body = marked.parse(markdown, { renderer, gfm: true, breaks: false });
  return `<!DOCTYPE html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || '成品')}</title>
<style>
  body { max-width: 860px; margin: 40px auto; padding: 0 24px; font: 16px/1.75 -apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif; color: #2c2a4a; }
  h1, h2, h3 { line-height: 1.35; } h1 { font-size: 30px; } h2 { margin-top: 2em; padding-bottom: .3em; border-bottom: 1px solid #e3e1ee; font-size: 23px; } h3 { font-size: 19px; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 14px; } th, td { padding: 7px 10px; border: 1px solid #d9d6e6; text-align: left; vertical-align: top; } th { background: #f1f0f8; }
  code { padding: 1px 5px; border-radius: 4px; background: #f3f2f8; font: 13px Menlo, monospace; } pre { overflow: auto; padding: 12px 14px; border-radius: 8px; background: #f6f5fa; } pre code { padding: 0; background: none; }
  blockquote { margin: 1em 0; padding: 4px 16px; border-left: 4px solid #8b7cf6; color: #5c5a78; background: #faf9ff; }
  a { color: #4b3fb3; } img { max-width: 100%; }
  @media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } table, pre { break-inside: avoid; } }
</style></head><body>
${body}
</body></html>
`;
}
