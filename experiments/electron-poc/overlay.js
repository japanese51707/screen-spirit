const box = document.querySelector('#box');
const prompt = document.querySelector('#prompt');
let start;

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !prompt.hidden) return;
  start = { x: event.clientX, y: event.clientY };
  box.style.display = 'block';
});

window.addEventListener('mousemove', (event) => {
  if (!start) return;
  const left = Math.min(start.x, event.clientX);
  const top = Math.min(start.y, event.clientY);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${Math.abs(event.clientX - start.x)}px`;
  box.style.height = `${Math.abs(event.clientY - start.y)}px`;
});

window.addEventListener('mouseup', (event) => {
  if (!start) return;
  start = undefined;
  prompt.hidden = false;
  prompt.style.left = `${Math.min(event.clientX + 12, innerWidth - 340)}px`;
  prompt.style.top = `${Math.min(event.clientY + 12, innerHeight - 160)}px`;
  prompt.querySelector('textarea').focus();
});

document.querySelector('#close').addEventListener('click', () => window.poc.closeOverlay());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.poc.closeOverlay();
});
