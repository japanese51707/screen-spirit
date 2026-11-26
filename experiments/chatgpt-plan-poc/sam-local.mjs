// 本機切割工具（SAM 2.1）：一鍵安裝、檢查狀態、執行切割。
// 全部裝在 App 自己的資料夾（<userData>/sam/），不改動系統 Python、不寫入 shell 設定：
//   sam/bin/uv          套件管理工具（https://astral.sh/uv）
//   sam/python/         uv 下載的 Python 3.12
//   sam/env/            虛擬環境（torch、transformers）
//   sam/hf/             模型快取（facebook/sam2.1-hiera-large，約 900 MB）
//   sam/env/.ready      安裝完成的標記
import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const READY = '.ready';

export function samPaths(userData) {
  const root = join(userData, 'sam');
  return {
    root,
    uv: join(root, 'bin', 'uv'),
    env: join(root, 'env'),
    python: join(root, 'env', 'bin', 'python'),
    hf: join(root, 'hf'),
    ready: join(root, 'env', READY),
    log: join(root, 'install.log'),
    work: join(root, 'work'),
  };
}

const exists = (path) => access(path).then(() => true, () => false);

/** 'ready'｜'installing'｜'missing' */
export async function samStatus(userData, { installing = false } = {}) {
  const paths = samPaths(userData);
  if (await exists(paths.ready)) return 'ready';
  return installing ? 'installing' : 'missing';
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** 安裝腳本（在終端機執行，看得到進度；失敗時留著視窗讓使用者看錯誤） */
export function installScript({ userData, helperPath }) {
  const p = samPaths(userData);
  return `#!/bin/zsh
# Screen Spirit：安裝本機切割工具（SAM 2.1）
export UV_INSTALL_DIR=${quote(join(p.root, 'bin'))}
export UV_NO_MODIFY_PATH=1
export UV_PYTHON_INSTALL_DIR=${quote(join(p.root, 'python'))}
export UV_CACHE_DIR=${quote(join(p.root, 'cache'))}
export HF_HOME=${quote(p.hf)}
ROOT=${quote(p.root)}
mkdir -p "$ROOT"
exec > >(tee ${quote(p.log)}) 2>&1
echo "== 安裝本機切割工具（SAM 2.1）=="
echo "全部會裝在：$ROOT"
echo "（約 1～2 GB，需要幾分鐘；裝好這個視窗可以關掉）"
echo
rm -f ${quote(p.ready)}
if [ ! -x ${quote(p.uv)} ]; then
  echo "① 下載套件管理工具 uv…"
  curl -LsSf https://astral.sh/uv/install.sh | sh || { echo "✗ 下載 uv 失敗，請確認網路連線"; exit 1; }
fi
echo "② 準備 Python 3.12 與虛擬環境…"
${quote(p.uv)} venv ${quote(p.env)} --python 3.12 --allow-existing || { echo "✗ 建立 Python 環境失敗"; exit 1; }
echo "③ 安裝 PyTorch、transformers（最久的一步）…"
${quote(p.uv)} pip install --python ${quote(p.python)} torch torchvision "transformers>=4.56" pillow numpy || { echo "✗ 安裝套件失敗"; exit 1; }
echo "④ 下載 SAM 2.1 模型並測試…"
${quote(p.python)} ${quote(helperPath)} --check || { echo "✗ 模型下載或測試失敗"; exit 1; }
touch ${quote(p.ready)}
echo
echo "✓ 安裝完成！可以關掉這個視窗，回到精靈博士重新產生圖層。"
`;
}

/** 開終端機執行安裝腳本 */
export async function openInstallTerminal({ userData, helperPath }) {
  const p = samPaths(userData);
  await mkdir(p.root, { recursive: true });
  const script = join(p.root, 'install-sam.command');
  await writeFile(script, installScript({ userData, helperPath }), { mode: 0o700 });
  await chmod(script, 0o700);
  await new Promise((resolve, reject) => execFile('open', ['-a', 'Terminal', script], (error) => (error ? reject(error) : resolve())));
}

/** 等安裝完成（每 3 秒看一次標記；最多 30 分鐘） */
export async function waitForInstall(userData, { timeoutMs = 30 * 60 * 1000, signal } = {}) {
  const p = samPaths(userData);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (await exists(p.ready)) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

/** 安裝紀錄最後幾行（失敗時給使用者看） */
export async function installLogTail(userData, lines = 6) {
  try {
    const text = await readFile(samPaths(userData).log, 'utf8');
    return text.trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 執行切割：imagePng（Buffer）、boxes（{ 名稱: [x0, y0, x1, y1] }）、negative（[[x, y]]）
 * 回傳 { device, masks: { 名稱: { png: Buffer, score } } }
 */
export async function runSam({ userData, helperPath, imagePng, boxes, negative = [], timeoutMs = 5 * 60 * 1000 }) {
  const p = samPaths(userData);
  if (!(await exists(p.ready))) throw new Error('本機切割工具還沒安裝。');
  const job = join(p.work, `job-${Date.now()}`);
  await mkdir(job, { recursive: true });
  try {
    const image = join(job, 'image.png');
    const prompts = join(job, 'prompts.json');
    await writeFile(image, imagePng);
    await writeFile(prompts, JSON.stringify({ boxes, negative }));
    const stdout = await new Promise((resolve, reject) => {
      execFile(p.python, [helperPath, image, prompts, join(job, 'out')], {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, HF_HOME: p.hf, PYTORCH_ENABLE_MPS_FALLBACK: '1', HF_HUB_OFFLINE: '1' },
      }, (error, out, err) => {
        if (error && !String(out).trim()) reject(new Error(`切割工具執行失敗：${(err || error.message).toString().slice(-300)}`));
        else resolve(String(out));
      });
    });
    const result = JSON.parse(stdout.trim().split('\n').pop());
    if (!result.ok) throw new Error(`切割工具：${result.error}`);
    const masks = {};
    for (const [name, info] of Object.entries(result.masks || {})) masks[name] = { png: await readFile(info.file), score: info.score };
    return { device: result.device, masks };
  } finally {
    await rm(job, { recursive: true, force: true });
  }
}
