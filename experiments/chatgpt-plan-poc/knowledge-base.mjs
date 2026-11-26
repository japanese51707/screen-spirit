// 精靈的資料庫：使用者電腦上的資料夾（一般資料夾、Obsidian 筆記庫、Google Drive／Dropbox／OneDrive／iCloud 的同步資料夾）。
// 這裡負責：偵測可用的位置、列出資料夾內容、預覽檔案、把整理好的長期記憶寫成 Markdown 筆記。
// 安全：所有讀取都限制在指定的根目錄底下（擋掉 ../ 與捷徑跳出去）。
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

export const MEMORY_FOLDER = '記憶';
const HIDDEN = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.DS_Store', '.Trash', 'Icon\r']);
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.swift', '.kt', '.c', '.h', '.cpp', '.css', '.sql', '.sh', '.ini', '.toml', '.env.example']);
const PREVIEW_LIMIT = 200 * 1024;

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/** 偵測這台 Mac 上可以當資料庫的位置：Obsidian 筆記庫、雲端硬碟的同步資料夾 */
export async function detectStorageLocations({ home = homedir(), platform = process.platform } = {}) {
  if (platform === 'win32') return detectWindowsLocations(home);
  const found = [];
  // Obsidian：~/Library/Application Support/obsidian/obsidian.json 記著所有筆記庫
  try {
    const config = JSON.parse(await readFile(join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), 'utf8'));
    const vaults = Object.values(config?.vaults || {}).filter((vault) => typeof vault?.path === 'string');
    vaults.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const vault of vaults) {
      if (await exists(vault.path)) found.push({ kind: 'obsidian', provider: 'Obsidian', label: basename(vault.path), path: vault.path });
    }
  } catch {}
  // 雲端硬碟電腦版：~/Library/CloudStorage/<服務>-<帳號>
  const cloudRoot = join(home, 'Library', 'CloudStorage');
  try {
    for (const name of (await readdir(cloudRoot)).sort()) {
      const base = join(cloudRoot, name);
      let provider = '';
      if (name.startsWith('GoogleDrive-')) provider = 'Google Drive';
      else if (name.startsWith('Dropbox')) provider = 'Dropbox';
      else if (name.startsWith('OneDrive')) provider = 'OneDrive';
      else if (name.startsWith('Box')) provider = 'Box';
      if (!provider) continue;
      let path = base;
      if (provider === 'Google Drive') {
        // Google Drive 的「我的雲端硬碟」資料夾名稱會跟著系統語言
        for (const candidate of ['My Drive', '我的雲端硬碟', '我的云端硬盘', 'マイドライブ']) {
          if (await exists(join(base, candidate))) { path = join(base, candidate); break; }
        }
      }
      const account = name.replace(/^[^-]+-?/, '');
      found.push({ kind: 'cloud', provider, label: account ? `${provider}（${account}）` : provider, path });
    }
  } catch {}
  // iCloud 雲碟
  const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  if (await exists(icloud)) found.push({ kind: 'cloud', provider: 'iCloud', label: 'iCloud 雲碟', path: icloud });
  return found;
}

/** Windows：Obsidian 設定在 %APPDATA%\obsidian\obsidian.json；雲端硬碟看使用者資料夾底下常見的同步資料夾 */
async function detectWindowsLocations(home) {
  const found = [];
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  try {
    const config = JSON.parse(await readFile(join(appData, 'obsidian', 'obsidian.json'), 'utf8'));
    const vaults = Object.values(config?.vaults || {}).filter((vault) => typeof vault?.path === 'string');
    vaults.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    for (const vault of vaults) {
      if (await exists(vault.path)) found.push({ kind: 'obsidian', provider: 'Obsidian', label: basename(vault.path), path: vault.path });
    }
  } catch {}
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  if (oneDrive && await exists(oneDrive)) found.push({ kind: 'cloud', provider: 'OneDrive', label: 'OneDrive', path: oneDrive });
  for (const [provider, folder] of [['Dropbox', 'Dropbox'], ['iCloud', 'iCloudDrive']]) {
    const path = join(home, folder);
    if (await exists(path)) found.push({ kind: 'cloud', provider, label: provider === 'iCloud' ? 'iCloud 雲碟' : provider, path });
  }
  // Google Drive 電腦版在 Windows 會掛成一個磁碟機（通常是 G:）
  for (const drive of ['G', 'H', 'I']) {
    for (const name of ['My Drive', '我的雲端硬碟']) {
      const path = `${drive}:\\${name}`;
      if (await exists(path)) { found.push({ kind: 'cloud', provider: 'Google Drive', label: 'Google Drive', path }); break; }
    }
  }
  return found;
}

/** 把根目錄底下的相對路徑轉成絕對路徑；跳出根目錄（../、捷徑）就拒絕 */
export async function resolveInside(root, rel = '') {
  if (typeof root !== 'string' || !root) throw new Error('沒有設定資料夾。');
  const rootReal = await realpath(root);
  const target = resolve(rootReal, typeof rel === 'string' ? rel : '');
  const targetReal = await realpath(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) throw new Error('不能讀取資料夾以外的位置。');
  return { rootReal, targetReal };
}

/** 列出資料夾內容（一層）。資料夾排前面，隱藏檔與 .obsidian、.git 等不列 */
export async function listDirectory(root, rel = '', { limit = 400 } = {}) {
  const { rootReal, targetReal } = await resolveInside(root, rel);
  const entries = await readdir(targetReal, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || HIDDEN.has(entry.name)) continue;
    const absolute = join(targetReal, entry.name);
    let type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : '';
    if (entry.isSymbolicLink()) {
      try { type = (await stat(absolute)).isDirectory() ? 'dir' : 'file'; } catch { continue; }
    }
    if (!type) continue;
    items.push({ name: entry.name, rel: relative(rootReal, absolute), type, ext: type === 'file' ? extname(entry.name).toLowerCase() : '' });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-Hant') : a.type === 'dir' ? -1 : 1));
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

/** 預覽檔案：文字檔回傳內容（太長截斷），其他檔案只回傳大小 */
export async function readPreview(root, rel) {
  const { targetReal } = await resolveInside(root, rel);
  const info = await stat(targetReal);
  if (info.isDirectory()) throw new Error('這是資料夾。');
  const ext = extname(targetReal).toLowerCase();
  const base = { name: basename(targetReal), size: info.size, modified: info.mtime.toISOString(), ext };
  if (!TEXT_EXT.has(ext)) return { ...base, kind: 'binary' };
  const buffer = await readFile(targetReal);
  const truncated = buffer.length > PREVIEW_LIMIT;
  return { ...base, kind: 'text', text: buffer.subarray(0, PREVIEW_LIMIT).toString('utf8'), truncated };
}

// ── 長期記憶：存在資料庫裡的「記憶」資料夾，一篇一個 Markdown ──

const safeName = (value) => String(value || '').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';

/** 讀出已有的記憶標題（給整理的 AI 參考，避免重複記同一件事） */
export async function listMemoryTitles(home, { limit = 60 } = {}) {
  const dir = join(home, MEMORY_FOLDER);
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.md') && !name.startsWith('_')); } catch { return []; }
  return names.sort().reverse().slice(0, limit).map((name) => name.replace(/\.md$/, ''));
}

/** 讀出最近的記憶內容（之後精靈工作時帶給 AI 用） */
export async function readRecentMemories(home, { limit = 20, maxChars = 12000 } = {}) {
  const dir = join(home, MEMORY_FOLDER);
  let names = [];
  try { names = (await readdir(dir)).filter((name) => name.endsWith('.md') && !name.startsWith('_')).sort().reverse().slice(0, limit); } catch { return ''; }
  let total = '';
  for (const name of names) {
    const text = (await readFile(join(dir, name), 'utf8').catch(() => '')).replace(/^---[\s\S]*?---\s*/, '');
    if (total.length + text.length > maxChars) break;
    total += `\n\n${text.trim()}`;
  }
  return total.trim();
}

/** 寫一篇記憶筆記（Obsidian 也能直接讀的格式：前面是屬性，後面是內容） */
export async function writeMemoryNote(home, { spiritName, title, tags = [], content, now = new Date() }) {
  const dir = join(home, MEMORY_FOLDER);
  await mkdir(dir, { recursive: true });
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const filename = `${date} ${time} ${safeName(title)}.md`;
  const cleanTags = tags.map((tag) => String(tag).replace(/[\s#,[\]]/g, '')).filter(Boolean).slice(0, 8);
  const note = [
    '---',
    `精靈: ${JSON.stringify(spiritName)}`,
    `日期: ${date}`,
    `標籤: [${cleanTags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    '來源: 小精靈對話整理',
    '---',
    '',
    `# ${title}`,
    '',
    String(content || '').trim(),
    '',
  ].join('\n');
  await writeFile(join(dir, filename), note, { flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    await writeFile(join(dir, filename.replace(/\.md$/, ` ${Date.now() % 1000}.md`)), note, { flag: 'wx' });
  });
  return join(MEMORY_FOLDER, filename);
}

/** 選了 Obsidian 筆記庫或雲端硬碟（整個根目錄）時，替這隻精靈開一個自己的資料夾，避免弄亂原本的內容 */
export async function prepareSpiritFolder(base, spiritName, { ownFolder = true } = {}) {
  const folder = ownFolder ? join(base, '小精靈', safeName(spiritName)) : base;
  await mkdir(join(folder, MEMORY_FOLDER), { recursive: true });
  return folder;
}
