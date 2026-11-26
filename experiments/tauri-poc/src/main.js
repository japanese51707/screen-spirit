import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut';
import './style.css';

const selection = document.querySelector('#selection');
const box = document.querySelector('#box');
const prompt = document.querySelector('#prompt');
const currentWindow = getCurrentWindow();

await listen('poc-overlay', async () => {
  selection.hidden = false;
  prompt.hidden = true;
  await currentWindow.show();
  await currentWindow.setFocus();
});

let start;
selection.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  start = { x: event.clientX, y: event.clientY };
  box.style.display = 'block';
});
window.addEventListener('mousemove', (event) => {
  if (!start) return;
  box.style.left = `${Math.min(start.x, event.clientX)}px`;
  box.style.top = `${Math.min(start.y, event.clientY)}px`;
  box.style.width = `${Math.abs(event.clientX - start.x)}px`;
  box.style.height = `${Math.abs(event.clientY - start.y)}px`;
});
window.addEventListener('mouseup', (event) => {
  if (!start) return;
  start = undefined;
  prompt.hidden = false;
  prompt.style.left = `${Math.min(event.clientX + 12, innerWidth - 300)}px`;
  prompt.style.top = `${Math.min(event.clientY + 12, innerHeight - 90)}px`;
});

document.querySelector('#close').addEventListener('click', async () => {
  selection.hidden = true;
  prompt.hidden = true;
  await currentWindow.hide();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void currentWindow.hide();
});

await register('CommandOrControl+D', async (event) => {
  if (event.state === 'Pressed') {
    await currentWindow.emit('poc-overlay');
  }
});

window.addEventListener('beforeunload', () => void unregisterAll());
