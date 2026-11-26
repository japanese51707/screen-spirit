// 以「專案資料夾」為單位運作的 AI 編輯器（Kiro，VS Code 系）：列出最近的專案、記住小精靈用過的專案。
// Kiro 自己的最近清單在 ~/Library/Application Support/<App>/User/globalStorage/storage.json（只讀）。
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined;
  try { return fileURLToPath(uri); } catch { return undefined; }
}

/** 從 VS Code 系編輯器的 storage.json 找出開過的資料夾（最近開的排前面） */
export function foldersFromStorage(storage) {
  const ordered = [];
  const add = (uri) => {
    const path = uriToPath(uri);
    if (path && !ordered.includes(path)) ordered.push(path);
  };
  const windows = storage?.windowsState;
  add(windows?.lastActiveWindow?.folder);
  for (const item of windows?.openedWindows || []) add(item?.folder);
  for (const item of storage?.backupWorkspaces?.folders || []) add(item?.folderUri);
  for (const uri of Object.keys(storage?.profileAssociations?.workspaces || {})) add(uri);
  return ordered;
}

export function createProjectStore(path) {
  async function load() {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }
  return {
    /** 小精靈用過的專案（每個 App 各自一份，最近用的排前面） */
    async remembered(appKey) {
      const list = (await load())[appKey];
      return Array.isArray(list) ? list.filter((item) => typeof item?.path === 'string') : [];
    },
    async remember(appKey, projectPath) {
      const all = await load();
      const list = (Array.isArray(all[appKey]) ? all[appKey] : []).filter((item) => item?.path !== projectPath);
      all[appKey] = [{ path: projectPath, at: new Date().toISOString() }, ...list].slice(0, 30);
      await writeFile(path, JSON.stringify(all, null, 2), { mode: 0o600 });
    },
  };
}

/**
 * 列出可以選的專案：小精靈用過的（最近的在前）→ 編輯器自己記得的。只列出現在還存在的資料夾。
 * @returns {Promise<Array<{ path: string, name: string, source: 'spirit'|'app' }>>}
 */
export async function listProjects({ appDataName, store, appKey, home = homedir(), limit = 20 }) {
  const result = [];
  const seen = new Set();
  const push = async (path, source) => {
    if (!path || seen.has(path) || result.length >= limit) return;
    seen.add(path);
    if (await isDirectory(path)) result.push({ path, name: basename(path) || path, source });
  };
  for (const item of await store.remembered(appKey)) await push(item.path, 'spirit');
  if (appDataName) {
    let storage;
    try {
      storage = JSON.parse(await readFile(join(home, 'Library', 'Application Support', appDataName, 'User', 'globalStorage', 'storage.json'), 'utf8'));
    } catch {}
    for (const path of foldersFromStorage(storage)) await push(path, 'app');
  }
  return result;
}

export { isDirectory };
