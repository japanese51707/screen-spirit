import { randomUUID } from 'node:crypto';

/** A single, local Q&A session shared by every presentation of the companion UI. */
export function createConversationSession(source = {}, presentationMode = 'companion') {
  const allowedKinds = new Set(['test', 'screen', 'clipboard']);
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: {
      kind: allowedKinds.has(source.kind) ? source.kind : 'test',
      context: Array.isArray(source.context) ? structuredClone(source.context) : [],
      selection: source.selection ? structuredClone(source.selection) : null,
      hasImage: Boolean(source.hasImage),
    },
    presentationMode: ['companion', 'near-source'].includes(presentationMode) ? presentationMode : 'companion',
    phase: 'input',
    messages: [],
  };
}
