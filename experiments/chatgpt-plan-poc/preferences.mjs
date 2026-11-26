import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_PRESENTATION_MODE = 'companion';
const PRESENTATION_MODES = new Set(['companion', 'near-source']);

export function isPresentationMode(value) {
  return PRESENTATION_MODES.has(value);
}

export async function loadPresentationMode(filename) {
  try {
    const preferences = JSON.parse(await readFile(filename, 'utf8'));
    return isPresentationMode(preferences.presentationMode) ? preferences.presentationMode : DEFAULT_PRESENTATION_MODE;
  } catch {
    return DEFAULT_PRESENTATION_MODE;
  }
}

export async function savePresentationMode(filename, presentationMode) {
  if (!isPresentationMode(presentationMode)) throw new Error('Choose a supported answer display mode.');
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify({ presentationMode }, null, 2)}\n`, { mode: 0o600 });
}
