// 指令列 AI 的登入：檢查有沒有登入，沒有的話打開「終端機」執行各家的登入指令（瀏覽器會自動開登入頁）。
// 為什麼用終端機：登入過程可能要按 Enter、選帳號或貼代碼，使用者看得到才不會卡住；不需要額外的「自動化」權限。
import { spawn } from 'node:child_process';
import { execCli, IS_WINDOWS } from './cli-path.mjs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CLI_LOGIN = {
  claude: {
    name: 'Claude Code',
    login: ['auth', 'login'],
    status: ['auth', 'status'],
    intro: '正在幫你登入 Claude Code，瀏覽器會自動打開登入頁。用你的 Claude 帳號登入即可。',
  },
  codex: {
    name: 'Codex',
    login: ['login'],
    status: ['login', 'status'],
    intro: '正在幫你登入 Codex，瀏覽器會自動打開登入頁。請選「Sign in with ChatGPT」。',
  },
  gemini: {
    name: 'Gemini CLI',
    login: [],
    status: null, // Gemini CLI 沒有查詢登入狀態的指令
    intro: '正在打開 Gemini CLI。第一次使用請選「Login with Google」並在瀏覽器完成登入，看到輸入框後輸入 /quit 離開。',
  },
};

/** 錯誤訊息看起來是「沒登入／登入過期」 */
export function looksLikeLoginError(message = '') {
  return /authenticat|oauth|not logged|log ?in|sign ?in|credential|unauthori[sz]ed|\b401\b|token (?:has )?expired|session expired/i.test(message);
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // 跟實際使用時一樣：走登入帳號，不走 API 金鑰
  return env;
}

/** true＝已登入、false＝沒登入、null＝無法判斷（沒有查詢指令或指令失敗） */
export function checkCliLogin(binary, cli, { timeoutMs = 10_000 } = {}) {
  const spec = CLI_LOGIN[cli];
  if (!binary || !spec?.status) return Promise.resolve(null);
  return new Promise((resolve) => {
    execCli(binary, spec.status, { timeout: timeoutMs, env: cleanEnv() }, (error) => {
      if (!error) return resolve(true);
      if (typeof error.code === 'number') return resolve(error.code === 1 ? false : null);
      resolve(null); // 逾時或執行不了
    });
  });
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * 打開終端機執行登入指令；指令結束時把結束代碼寫進 marker 檔，小精靈靠它知道「登入流程結束了」。
 * 回傳 { markerPath }。
 */
export async function openLoginTerminal({ binary, cli, workDir, openCommand = 'open' }) {
  const spec = CLI_LOGIN[cli];
  if (!spec) throw new Error(`不支援 ${cli} 的登入。`);
  await mkdir(workDir, { recursive: true });
  const scriptPath = join(workDir, `login-${cli}.command`);
  const markerPath = join(workDir, `login-${cli}.done`);
  await rm(markerPath, { force: true });
  if (IS_WINDOWS) return openWindowsLoginConsole({ binary, spec, workDir, cli, markerPath });
  const script = [
    '#!/bin/zsh -l',
    'clear',
    'unset ANTHROPIC_API_KEY',
    `echo ${shellQuote(`✦ 小精靈：${spec.intro}`)}`,
    'echo',
    [shellQuote(binary), ...spec.login.map(shellQuote)].join(' '),
    'rc=$?',
    `echo "$rc" > ${shellQuote(markerPath)}`,
    'echo',
    `if [ "$rc" = 0 ]; then echo ${shellQuote('✓ 完成。可以關閉這個視窗，回到小精靈。')}; else echo ${shellQuote('✗ 登入沒有完成。可以關閉這個視窗，回到小精靈再按一次「登入」。')}; fi`,
    '',
  ].join('\n');
  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
  await new Promise((resolve, reject) => {
    const child = spawn(openCommand, ['-a', 'Terminal', scriptPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`打不開終端機（代碼 ${code}）。`))));
  });
  return { markerPath, scriptPath };
}

/**
 * 等登入流程結束：marker 出現（終端機裡的指令結束）或查詢指令回報已登入。
 * 回傳 'done'｜'failed'｜'timeout'｜'cancelled'
 */
export async function waitForLogin({ binary, cli, markerPath, signal, intervalMs = 2000, timeoutMs = 10 * 60_000, wasLoggedIn = null }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return 'cancelled';
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let marker = '';
    try { marker = (await readFile(markerPath, 'utf8')).trim(); } catch {}
    if (marker) {
      if (marker !== '0') return 'failed';
      const ok = await checkCliLogin(binary, cli);
      return ok === false ? 'failed' : 'done';
    }
    // 原本是「沒登入」的情況，查詢指令轉成已登入就可以提早結束（不用等使用者關終端機）
    if (wasLoggedIn === false && await checkCliLogin(binary, cli) === true) return 'done';
  }
  return 'timeout';
}

/** Windows：開一個命令提示字元視窗執行登入指令，結束時寫 marker 檔 */
async function openWindowsLoginConsole({ binary, spec, workDir, cli, markerPath }) {
  const scriptPath = join(workDir, `login-${cli}.cmd`);
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const echo = (text) => `echo ${String(text).replace(/[&|<>^%]/g, '^$&')}`;
  const script = [
    '@echo off',
    'chcp 65001 >nul',
    'cls',
    'set ANTHROPIC_API_KEY=',
    echo(`✦ 小精靈：${spec.intro}`),
    'echo.',
    `call ${[quote(binary), ...spec.login.map(quote)].join(' ')}`,
    'set rc=%ERRORLEVEL%',
    `>${quote(markerPath)} echo %rc%`,
    'echo.',
    `if "%rc%"=="0" (${echo('✓ 完成。可以關閉這個視窗，回到小精靈。')}) else (${echo('✗ 登入沒有完成。可以關閉這個視窗，回到小精靈再按一次「登入」。')})`,
    'pause',
    '',
  ].join('\r\n');
  await writeFile(scriptPath, script, 'utf8');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', scriptPath], { stdio: 'ignore', detached: true, windowsHide: false });
  child.unref();
  return { markerPath, scriptPath };
}
