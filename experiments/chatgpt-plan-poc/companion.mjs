import { createSkinView } from './skin-view.mjs';

const bridge = window.screenSpiritCompanion;
const status = document.querySelector('#status');
const mascot = document.querySelector('#mascot');
// 精靈造型：對話中的精靈或「設為桌面小精靈」的那隻有造型時，取代原本的小精靈圖
const skinView = createSkinView();
document.querySelector('.mascot-body').append(skinView.element);
// 換造型時「啵」一下（縮小再彈回來）；第一次載入不播
const mascotBody = document.querySelector('.mascot-body');
let firstSkin = true;
mascotBody.addEventListener('animationend', (event) => { if (event.animationName === 'spirit-swap') mascotBody.classList.remove('swap'); });
bridge.onSkin((skin) => {
  const changed = !firstSkin && (Boolean(skin) || skinView.hasSkin);
  firstSkin = false;
  skinView.setSkin(skin);
  document.body.classList.toggle('has-skin', skinView.hasSkin);
  if (changed) {
    mascotBody.classList.remove('swap');
    void mascotBody.offsetWidth; // 重新開始動畫
    mascotBody.classList.add('swap');
  }
});
bridge.onMood((mood) => skinView.setMood(mood));
bridge.onCollapseChange((collapsed) => {
  document.body.classList.toggle('collapsed', collapsed);
  skinView.setPaused(collapsed);
});
skinView.setPaused(document.body.classList.contains('collapsed'));
bridge.onStatus((message) => { status.textContent = message; });
let dragStart;
let suppressClick = false;

async function beginSelection() {
  status.textContent = '';
  try {
    const result = await bridge.beginSelection();
    if (!result?.ok) status.textContent = result?.error || '無法開始圈選畫面。';
  } catch (error) {
    status.textContent = error.message || '無法開始圈選畫面。';
  }
}

mascot.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const drag = {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    bounds: undefined,
    moved: false,
  };
  dragStart = drag;
  mascot.setPointerCapture(event.pointerId);
  void bridge.getCompanionBounds().then((bounds) => {
    if (dragStart === drag) drag.bounds = bounds;
  });
});

mascot.addEventListener('pointermove', (event) => {
  if (!dragStart || dragStart.pointerId !== event.pointerId || !(event.buttons & 1)) return;
  const dx = event.screenX - dragStart.screenX;
  const dy = event.screenY - dragStart.screenY;
  if (Math.hypot(dx, dy) < 5) return;
  dragStart.moved = true;
  mascot.classList.add('dragging');
  if (dragStart.bounds) {
    void bridge.moveCompanion({ x: dragStart.bounds.x + dx, y: dragStart.bounds.y + dy });
  }
});

function finishDrag(event) {
  if (!dragStart || dragStart.pointerId !== event.pointerId) return;
  if (dragStart.moved) {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  dragStart = undefined;
  mascot.classList.remove('dragging');
}

mascot.addEventListener('pointerup', finishDrag);
mascot.addEventListener('pointercancel', finishDrag);
mascot.addEventListener('click', (event) => {
  if (suppressClick) {
    event.preventDefault();
    return;
  }
  void beginSelection();
});
document.querySelector('#select-screen').addEventListener('click', beginSelection);
document.querySelector('#clipboard-question').addEventListener('click', async () => {
  status.textContent = '';
  try {
    const result = await bridge.beginClipboard();
    if (!result?.ok) status.textContent = result?.error || '無法讀取剪貼簿內容。';
  } catch (error) {
    status.textContent = error.message || '無法讀取剪貼簿內容。';
  }
});
document.querySelector('#open-chat').addEventListener('click', () => void bridge.openChat());
// 右鍵叫出選單（含「結束」）
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  void bridge.showMenu();
});
