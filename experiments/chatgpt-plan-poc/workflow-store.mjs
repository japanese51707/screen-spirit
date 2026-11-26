// 工作流存檔：<userData>/workflows/<id>.json（一條工作流一個檔案）
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeWorkflow } from './workflow-engine.mjs';

const validId = (id) => typeof id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(id);

export function createWorkflowStore(directory) {
  const file = (id) => join(directory, `${id}.json`);
  async function get(id) {
    if (!validId(id)) throw new Error('工作流編號不正確。');
    return sanitizeWorkflow(JSON.parse(await readFile(file(id), 'utf8')));
  }
  return {
    async list() {
      const names = await readdir(directory).catch(() => []);
      const items = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const workflow = await get(name.slice(0, -5));
          items.push({ id: workflow.id, name: workflow.name, updatedAt: workflow.updatedAt, cards: workflow.nodes.length });
        } catch {}
      }
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    get,
    async save(raw) {
      const workflow = sanitizeWorkflow({ ...raw, updatedAt: new Date().toISOString() });
      await mkdir(directory, { recursive: true });
      const temp = `${file(workflow.id)}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(workflow, null, 2), { mode: 0o600 });
      await rename(temp, file(workflow.id));
      return workflow;
    },
    async remove(id) {
      if (!validId(id)) throw new Error('工作流編號不正確。');
      await rm(file(id), { force: true });
      return { ok: true };
    },
  };
}
