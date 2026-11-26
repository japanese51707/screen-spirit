const bridge = window.screenSpiritSelection;
const surface = document.querySelector('#selection-surface');
const screenLayer = document.querySelector('#screens');
const selectionBox = document.querySelector('#selection-box');
const cursorSpirit = document.querySelector('#cursor-spirit');
const errorBanner = document.querySelector('#selection-error');
const cancelButton = document.querySelector('#cancel-selection');

let geometry;
let screens = [];
let dragStart;
let isDragging = false;
let cursorFrame;
let cursorPosition;

function setError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = !message;
}

function drawSelection(point) {
  const left = Math.min(dragStart.x, point.x);
  const top = Math.min(dragStart.y, point.y);
  const width = Math.abs(point.x - dragStart.x);
  const height = Math.abs(point.y - dragStart.y);
  selectionBox.hidden = false;
  Object.assign(selectionBox.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  });
}

function installScreens(payload) {
  geometry = payload.geometry;
  screens = payload.screens;
  surface.style.width = `${geometry.width}px`;
  surface.style.height = `${geometry.height}px`;
  // 凍結畫面：把按下快捷鍵當下截到的畫面鋪滿各螢幕，圈選時看到的就是實際會裁切的內容（所見即所得）
  screenLayer.replaceChildren(...screens.map((screen) => {
    const image = document.createElement('img');
    image.className = 'frozen-screen';
    image.alt = '';
    image.draggable = false;
    image.src = screen.dataUrl;
    Object.assign(image.style, {
      left: `${screen.bounds.x - geometry.x}px`,
      top: `${screen.bounds.y - geometry.y}px`,
      width: `${screen.bounds.width}px`,
      height: `${screen.bounds.height}px`,
    });
    return image;
  }));
  if (payload.cursor) {
    cursorSpirit.style.left = `${payload.cursor.x - geometry.x + 15}px`;
    cursorSpirit.style.top = `${payload.cursor.y - geometry.y + 11}px`;
    cursorSpirit.hidden = false;
  }
  surface.focus();
}

function pointFromEvent(event) {
  return { x: event.clientX, y: event.clientY };
}

function moveCursorSpirit(event) {
  cursorPosition = { x: event.clientX + 15, y: event.clientY + 11 };
  cursorSpirit.hidden = false;
  if (cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    cursorFrame = undefined;
    if (!cursorPosition) return;
    cursorSpirit.style.left = `${cursorPosition.x}px`;
    cursorSpirit.style.top = `${cursorPosition.y}px`;
  });
}

function normalizeSelection(start, end) {
  return {
    x: Math.min(start.x, end.x) + geometry.x,
    y: Math.min(start.y, end.y) + geometry.y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

async function cropSelection(rect) {
  const intersecting = screens
    .map((screen) => ({ screen, overlap: intersection(rect, screen.bounds) }))
    .filter((item) => item.overlap);
  if (!intersecting.length) throw new Error('選取範圍沒有落在任何螢幕上，請重新圈選。');

  const scale = Math.max(...intersecting.map(({ screen }) => screen.scaleFactor || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(rect.width * scale));
  canvas.height = Math.max(1, Math.ceil(rect.height * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (const { screen, overlap } of intersecting) {
    const image = new Image();
    image.src = screen.dataUrl;
    await image.decode();
    const sourceScaleX = image.naturalWidth / screen.bounds.width;
    const sourceScaleY = image.naturalHeight / screen.bounds.height;
    const sourceX = (overlap.x - screen.bounds.x) * sourceScaleX;
    const sourceY = (overlap.y - screen.bounds.y) * sourceScaleY;
    const sourceWidth = overlap.width * sourceScaleX;
    const sourceHeight = overlap.height * sourceScaleY;
    const targetX = (overlap.x - rect.x) * scale;
    const targetY = (overlap.y - rect.y) * scale;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      targetX,
      targetY,
      overlap.width * scale,
      overlap.height * scale,
    );
  }
  return canvas.toDataURL('image/png');
}

surface.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return;
  if (event.button !== 0 || !geometry) return;
  setError('');
  isDragging = true;
  dragStart = pointFromEvent(event);
  surface.setPointerCapture(event.pointerId);
  drawSelection(dragStart);
});

surface.addEventListener('pointermove', (event) => {
  moveCursorSpirit(event);
  if (isDragging) drawSelection(pointFromEvent(event));
});

surface.addEventListener('pointerup', async (event) => {
  if (!isDragging) return;
  isDragging = false;
  const rect = normalizeSelection(dragStart, pointFromEvent(event));
  if (rect.width < 18 || rect.height < 18) {
    setError('圈選範圍太小，請拖曳一個更大的範圍。');
    selectionBox.hidden = true;
    return;
  }

  setError('正在準備圈選內容…');
  try {
    const dataUrl = await cropSelection(rect);
    const result = await bridge.complete({ rect, dataUrl });
    if (!result?.ok) setError(result?.error || '無法完成這次圈選，請再試一次。');
  } catch (error) {
    setError(error.message || '無法處理圈選圖片，請縮小範圍後重試。');
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    void bridge.cancel().catch(() => {});
  }
});

cancelButton.addEventListener('click', () => void bridge.cancel().catch(() => {}));

bridge.getInit().then(installScreens).catch((error) => setError(error.message || '無法載入螢幕畫面。'));
