// 指令列工具在 Windows 的找法與啟動方式（macOS 照舊用原本的做法）。
// Windows 用 npm 裝的 codex／gemini 是 .cmd 檔，要經過 cmd.exe 才能執行；cross-spawn 會幫忙處理參數的跳脫。
import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';

export const IS_WINDOWS = process.platform === 'win32';

/** Windows：常見安裝位置 → where 指令。找不到回傳 '' */
export async function findWindowsCli(name, extraCandidates = []) {
  const home = homedir();
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [
    ...extraCandidates,
    join(home, '.local', 'bin', `${name}.exe`),
    join(appData, 'npm', `${name}.cmd`),
    join(localAppData, 'Programs', name, `${name}.exe`),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {}
  }
  const lines = await new Promise((resolve) => {
    execFile('where.exe', [name], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
  return lines.find((line) => /\.exe$/i.test(line)) || lines.find((line) => /\.(cmd|bat)$/i.test(line)) || '';
}

/** 啟動指令列工具：Windows 交給 cross-spawn（.cmd 也能正確帶參數），其他系統用 node 內建的 spawn */
export function spawnCli(binary, args, options = {}) {
  return IS_WINDOWS ? crossSpawn(binary, args, { ...options, windowsHide: true }) : spawn(binary, args, options);
}

/** 執行一次並等結束（例如查登入狀態）；callback 格式和 execFile 一樣 */
export function execCli(binary, args, { timeout = 10_000, env } = {}, callback) {
  if (!IS_WINDOWS) return execFile(binary, args, { timeout, env }, callback);
  const child = crossSpawn(binary, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (error) => { if (!done) { done = true; clearTimeout(timer); callback(error, stdout, stderr); } };
  const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('timeout'), { killed: true })); }, timeout);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => finish(error));
  child.on('close', (code) => finish(code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code })));
  return child;
}
