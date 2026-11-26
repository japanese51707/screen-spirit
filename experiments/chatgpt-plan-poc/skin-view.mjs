// 顯示精靈造型包（SKIN-SPEC.md 第 3 節的動畫）：桌面小精靈和精靈博士的預覽共用，所以預覽看到的就是桌面上的樣子。
// skin：{ manifest, layers: { 圖層 id: dataURL }, stateLayers: { 五官圖層 id: { 狀態: dataURL } }, faces（舊版整塊臉）: { 狀態: dataURL } }
// 每個圖層是一個 .skin-layer（拆開圖層時移動它）裡面放 <img>（動畫放在 img 上，兩者不互相覆蓋）。
const FACE_FOR_MOOD = { idle: 'idle', work: 'work', done: 'done', error: 'error' };

export function createSkinView({ blink = true } = {}) {
  const element = document.createElement('div');
  element.className = 'skin-view';
  element.dataset.mood = 'idle';
  const thought = document.createElement('div');
  thought.className = 'skin-thought';
  thought.append(...[1, 2, 3].map(() => document.createElement('i')));
  let skin = null;
  let mood = 'idle';
  let stateImages = []; // 跟著表情換圖的圖層（五官或舊版整塊臉）：[{ layer, image }]
  let blinkTimer;
  let blinkEnd;
  let paused = false;

  // 某個圖層在某個表情時的圖：五官各自一張（眨眼時嘴巴沒有另外畫，就用待機的）；舊版是整塊臉
  const stateSrc = (layer, state) => {
    if (layer.file === 'face-{state}.png') return skin?.faces?.[state] || skin?.faces?.idle || '';
    const set = skin?.stateLayers?.[layer.id] || {};
    return set[state] || set.idle || '';
  };
  const hasState = (state) => Boolean(skin?.manifest?.faces?.includes(state));
  function showFace(state) {
    for (const { layer, image } of stateImages) {
      const src = stateSrc(layer, state);
      if (src && image.src !== src) image.src = src;
    }
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (!blink || !hasState('blink')) return;
    blinkTimer = setTimeout(() => {
      if (!element.isConnected) return; // 已經從畫面拿掉（例如精靈博士換頁）：停止眨眼計時
      if (!paused && mood === 'idle') {
        showFace('blink');
        clearTimeout(blinkEnd);
        blinkEnd = setTimeout(() => { if (mood === 'idle') showFace('idle'); }, 150);
      }
      scheduleBlink();
    }, 3000 + Math.random() * 3000);
  }

  function setSkin(next) {
    skin = next && next.manifest ? next : null;
    element.replaceChildren();
    stateImages = [];
    if (!skin) { clearTimeout(blinkTimer); return; }
    element.dataset.preset = skin.manifest.motionPreset || 'gentle';
    // 畫布比小精靈方框大（1.5 倍）：方框對齊預設小精靈，漂浮的配件可以超出方框
    element.dataset.frame = String(skin.manifest.frame || 1);
    // 會上下漂的配件交錯擺動；同一個配件的前半、後半（-back）要一起動
    const bobAlt = new Map();
    for (const layer of skin.manifest.layers) {
      const owner = layer.id.replace(/-back$/, '');
      if (layer.motion === 'bob' && !bobAlt.has(owner)) bobAlt.set(owner, bobAlt.size % 2 === 1);
    }
    for (const layer of [...skin.manifest.layers].sort((a, b) => a.z - b.z)) {
      const isFace = layer.file.includes('{state}');
      const src = isFace ? stateSrc(layer, FACE_FOR_MOOD[mood]) : skin.layers?.[layer.id];
      if (!src) continue;
      const wrapper = document.createElement('div');
      wrapper.className = `skin-layer m-${layer.motion || 'none'}`;
      wrapper.dataset.id = layer.id;
      wrapper.dataset.owner = layer.id.replace(/-back$/, '');
      if (layer.motion === 'bob' && bobAlt.get(wrapper.dataset.owner)) wrapper.classList.add('alt');
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.src = src;
      if (layer.pivot) image.style.transformOrigin = `${layer.pivot[0] * 100}% ${layer.pivot[1] * 100}%`;
      wrapper.append(image);
      element.append(wrapper);
      if (isFace) stateImages.push({ layer, image });
    }
    element.append(thought);
    // 先載入所有表情，切換時不會閃
    for (const src of [...Object.values(skin.faces || {}), ...Object.values(skin.stateLayers || {}).flatMap((set) => Object.values(set))]) { const image = new Image(); image.src = src; }
    scheduleBlink();
  }

  function setMood(next) {
    mood = FACE_FOR_MOOD[next] ? next : 'idle';
    element.dataset.mood = mood;
    showFace(FACE_FOR_MOOD[mood]);
    element.classList.remove('react-done', 'react-error');
    if (mood === 'done' || mood === 'error') {
      void element.offsetWidth; // 重新開始一次反應動畫
      element.classList.add(`react-${mood}`);
    }
  }

  return {
    element,
    setSkin,
    setMood,
    setPaused(value) { paused = Boolean(value); element.classList.toggle('paused', paused); },
    setExploded(value) { element.classList.toggle('exploded', Boolean(value)); },
    get hasSkin() { return Boolean(skin); },
    destroy() { clearTimeout(blinkTimer); clearTimeout(blinkEnd); element.remove(); },
  };
}
