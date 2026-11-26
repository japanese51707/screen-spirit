// 剪貼簿讀寫（Electron 45 起的非同步 ClipboardItem 介面）。
// Electron 45 拿掉了 readHTML / readImage / writeImage 等舊的同步方法，改成類似瀏覽器 navigator.clipboard 的寫法：
//   clipboard.read() → ClipboardItem[]，每個項目用 getType(mime) 取得 Blob；clipboard.write([new ClipboardItem({...})])。
// 以工廠函式注入 electron 物件，讓投遞邏輯能在一般 Node 環境做單元測試。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMAGE_PREFERENCE = ['image/png', 'image/jpeg', 'image/tiff', 'image/webp'];

/** 用 AppleScript 把 PNG 放進剪貼簿（系統原生格式，各 App 都認得）；暫存檔放完立即刪除。 */
async function writePngWithAppleScript(png) {
  const file = join(tmpdir(), `screen-spirit-${randomUUID()}.png`);
  await writeFile(file, png, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      execFile('osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', '-e', 'end run', file],
        { timeout: 8000 }, (error) => (error ? reject(error) : resolve()));
    });
  } finally {
    await unlink(file).catch(() => {});
  }
}

export function createClipboardIO({ clipboard, ClipboardItem, nativeImage }) {
  async function blobToImage(blob) {
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    return image.isEmpty() ? undefined : image;
  }

  return {
    /** 讀出目前剪貼簿的文字與圖片（剪貼簿模式用）。 */
    async read() {
      let text = '';
      let image;
      let items = [];
      try { items = await clipboard.read(); } catch { items = []; }
      for (const item of items) {
        if (!text && item.types.includes('text/plain')) {
          try { text = await (await item.getType('text/plain')).text(); } catch {}
        }
        if (!image) {
          const type = IMAGE_PREFERENCE.find((mime) => item.types.includes(mime)) || item.types.find((mime) => mime.startsWith('image/'));
          if (type) {
            try { image = await blobToImage(await item.getType(type)); } catch {}
          }
        }
      }
      if (!text) {
        try { text = await clipboard.readText(); } catch {}
      }
      return { text: text || '', image };
    },

    /** 完整保存剪貼簿的所有項目與格式，投遞完要原封不動放回去。 */
    async snapshot() {
      const saved = [];
      let items = [];
      try { items = await clipboard.read(); } catch { return saved; }
      for (const item of items) {
        const entry = {};
        for (const type of item.types) {
          try { entry[type] = await item.getType(type); } catch {}
        }
        if (Object.keys(entry).length) saved.push(entry);
      }
      return saved;
    },

    async restore(saved) {
      if (!saved?.length) {
        clipboard.clear();
        return;
      }
      try {
        await clipboard.write(saved.map((entry) => new ClipboardItem(entry)));
      } catch {
        // 有些特殊格式可能寫不回去；至少保住文字
        const textEntry = saved.find((entry) => entry['text/plain']);
        if (textEntry) {
          const value = textEntry['text/plain'];
          await clipboard.writeText(typeof value === 'string' ? value : await value.text());
        }
      }
    },

    /**
     * 只放一張圖片，並讀回確認真的在剪貼簿裡；Electron 的寫法沒成功就改用 AppleScript。
     * @returns 實際採用的方式與讀回的大小，寫進診斷紀錄
     */
    async writeImageVerified(image) {
      const check = async () => {
        let items = [];
        try { items = await clipboard.read(); } catch {}
        const types = items.flatMap((item) => item.types);
        const back = (await this.read()).image;
        return { types, size: back ? back.getSize() : undefined };
      };
      await this.write({ image });
      let verified = await check();
      if (verified.size) return `Electron 寫入；剪貼簿格式 ${verified.types.join(',')}；讀回 ${verified.size.width}x${verified.size.height}`;
      const electronTypes = verified.types.join(',') || '（空）';
      await writePngWithAppleScript(image.toPNG());
      verified = await check();
      if (verified.size) return `Electron 寫入讀不到（格式 ${electronTypes}），改用 AppleScript；讀回 ${verified.size.width}x${verified.size.height}`;
      throw new Error(`圖片放不進剪貼簿（Electron 格式 ${electronTypes}；AppleScript 後格式 ${verified.types.join(',') || '（空）'}）`);
    },

    /** 寫入文字及／或圖片（同一個項目，兩種格式）。 */
    async write({ text, image }) {
      const entry = {};
      if (text) entry['text/plain'] = text;
      if (image && !image.isEmpty()) entry['image/png'] = new Blob([image.toPNG()], { type: 'image/png' });
      if (!Object.keys(entry).length) return;
      clipboard.clear();
      await clipboard.write([new ClipboardItem(entry)]);
    },
  };
}
