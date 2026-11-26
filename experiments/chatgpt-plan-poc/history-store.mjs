import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE_PATTERN = /^[0-9a-f-]{36}\.enc$/i;

function recordPath(directory, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid history record id.');
  return join(directory, `${id}.enc`);
}

export function createHistoryStore({ directory, encrypt, decrypt, retentionMs = 24 * 60 * 60 * 1000 }) {
  async function readRecord(filename) {
    const bytes = await readFile(join(directory, filename));
    const value = JSON.parse(await decrypt(bytes));
    if (!value || typeof value.id !== 'string' || !Array.isArray(value.messages) || !value.createdAt) {
      throw new Error('Invalid encrypted history record.');
    }
    return value;
  }

  async function removeExpired(now = Date.now()) {
    let removed = 0;
    let files = [];
    try { files = await readdir(directory); } catch { return removed; }
    for (const filename of files) {
      if (!FILE_PATTERN.test(filename)) continue;
      try {
        const record = await readRecord(filename);
        if (Date.parse(record.expiresAt) <= now) {
          await unlink(join(directory, filename));
          removed += 1;
        }
      } catch {
        // Keep unreadable records so credential-store issues never destroy user data.
      }
    }
    return removed;
  }

  return {
    async save(session, now = Date.now()) {
      if (!session || !Array.isArray(session.messages) || !session.messages.length) return undefined;
      const createdAt = session.createdAt || new Date(now).toISOString();
      const record = {
        ...structuredClone(session),
        createdAt,
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(Date.parse(createdAt) + retentionMs).toISOString(),
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = recordPath(directory, record.id);
      const temporary = `${destination}.${process.pid}.tmp`;
      const encrypted = await encrypt(JSON.stringify(record));
      try {
        await writeFile(temporary, encrypted, { mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        try { await unlink(temporary); } catch {}
        throw error;
      }
      return record;
    },

    async list(now = Date.now()) {
      await removeExpired(now);
      let files = [];
      try { files = await readdir(directory); } catch { return []; }
      const records = [];
      for (const filename of files) {
        if (!FILE_PATTERN.test(filename)) continue;
        try { records.push(await readRecord(filename)); } catch {}
      }
      return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },

    async load(id, now = Date.now()) {
      const filename = `${id}.enc`;
      const filepath = recordPath(directory, id);
      const record = await readRecord(filename);
      if (Date.parse(record.expiresAt) <= now) {
        await unlink(filepath);
        return undefined;
      }
      return record;
    },

    async delete(id) {
      try { await unlink(recordPath(directory, id)); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },

    async clear() {
      let files = [];
      try { files = await readdir(directory); } catch { return; }
      for (const filename of files) {
        if (FILE_PATTERN.test(filename)) {
          try { await unlink(join(directory, filename)); } catch {}
        }
      }
    },

    removeExpired,
  };
}
