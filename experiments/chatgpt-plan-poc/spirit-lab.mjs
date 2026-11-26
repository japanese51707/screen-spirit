// 精靈博士：管理執行專項工作的精靈。
// 卡片盒（像抽卡的收藏冊）→ 點卡片進入詳細頁 → 6 個浮動按鍵，點哪個就切到那組設定。
// 設定一改就自動儲存（存在這台電腦）。
import { createSkinView } from './skin-view.mjs';

const SECTIONS = [
  { id: 'memory', icon: '📚', label: '資料庫與記憶', hint: '精靈要參考哪些資料、要不要記得之前聊過的事' },
  { id: 'limits', icon: '🚧', label: '限制', hint: '可以做什麼、不可以做什麼、回覆多長' },
  { id: 'role', icon: '🎭', label: '角色身份與定位', hint: '名字、身份、專長、說話的語氣' },
  { id: 'ai', icon: '🤖', label: '指定 AI', hint: '這隻精靈用哪個 AI 來回答' },
  { id: 'sop', icon: '🧭', label: '工作拆解 SOP', hint: '接到工作後依序要做哪些步驟' },
  { id: 'look', icon: '🎨', label: '造型設定', hint: '卡面圖片、代表符號、顏色與稀有度' },
];
const COLORS = [
  { id: 'violet', label: '紫' }, { id: 'sky', label: '藍' }, { id: 'mint', label: '綠' },
  { id: 'amber', label: '橘' }, { id: 'rose', label: '粉' }, { id: 'slate', label: '灰' },
];
const RARITIES = ['N', 'R', 'SR', 'SSR'];

/** 小工具：建立元素。props 裡 on* 是事件，dataset 是 data-*，其餘設成屬性 */
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'className') element.className = value;
    else if (key in element && typeof value !== 'string') element[key] = value;
    else if (key === 'value' && 'value' in element) element.value = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

/** 把使用者選的圖片縮成卡面大小（3:4，寬 480），存成 JPEG data URL */
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('無法讀取這張圖片。'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('這個檔案不是可以使用的圖片。'));
      image.onload = () => {
        const width = 480;
        const height = 640;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        // 置中裁切成 3:4
        const scale = Math.max(width / image.width, height / image.height);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function createSpiritLab({ bridge, getState, root, onClose = () => {}, onWork = () => {}, onSwitchWorkflow }) {
  let spirits = [];
  let current; // 正在編輯的精靈
  let section = ''; // 目前打開的設定（'' = 6 個按鍵環繞卡片）
  let saveTimer;
  let saving = Promise.resolve();
  let deleteArmedUntil = 0;

  const body = h('div', { className: 'lab-body' });
  const countLabel = h('span', { className: 'lab-count' });
  const saveLabel = h('span', { className: 'lab-save', 'aria-live': 'polite' });
  const backButton = h('button', { className: 'lab-back', type: 'button', onClick: () => void goBack() }, '← 回小精靈');
  const header = h('header', { className: 'lab-header' },
    backButton,
    h('div', { className: 'lab-title' },
      h('p', { className: 'lab-eyebrow' }, 'SPIRIT LAB'),
      h('h2', {}, '精靈博士'),
    ),
    h('div', { className: 'lab-header-side' }, saveLabel, countLabel,
      // 直接切到工作流（同一個視窗）
      onSwitchWorkflow ? h('button', { className: 'lab-back lab-switch', type: 'button', onClick: async () => {
        await flushSave();
        root.hidden = true;
        onSwitchWorkflow();
      } }, '⛓ 工作流') : null),
  );
  root.replaceChildren(header, body);
  // Esc 一層一層退回：設定頁 → 環繞 → 卡片盒 → 回小精靈（焦點不在卡片盒裡也有效）
  document.addEventListener('keydown', (event) => {
    if (root.hidden || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      void goBack();
    }
  });

  // ── 儲存：改完 0.5 秒後自動存 ──
  function scheduleSave() {
    if (!current) return;
    saveLabel.textContent = '儲存中…';
    saveLabel.dataset.state = 'saving';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), 500);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!current || saveLabel.dataset.state !== 'saving') return saving;
    const snapshot = structuredClone(current);
    saving = saving.then(async () => {
      try {
        const saved = await bridge.spiritsSave(snapshot);
        const index = spirits.findIndex((item) => item.id === saved.id);
        if (index >= 0) spirits[index] = saved;
        saveLabel.textContent = '已儲存 ✓';
        saveLabel.dataset.state = 'saved';
      } catch (error) {
        saveLabel.textContent = `儲存失敗：${error.message}`;
        saveLabel.dataset.state = 'error';
      }
    });
    return saving;
  }
  /** 改一個欄位：path 例如 'role.identity' */
  function update(path, value, { rerenderCard = true } = {}) {
    const keys = path.split('.');
    let target = current;
    for (const key of keys.slice(0, -1)) target = target[key];
    target[keys.at(-1)] = value;
    if (rerenderCard) refreshPreview();
    scheduleSave();
  }

  // ── 卡片 ──
  function targetName(id) {
    if (!id) return '';
    if (id === 'builtin') return '內建 ChatGPT';
    const target = (getState()?.deliveryTargets || []).find((item) => item.id === id);
    return (target?.label || id).replace(/（.*）/, '');
  }
  // 卡片上的動態造型：每隻精靈讀一次造型包，之後都用快取（造型重做或移除時更新）
  const skinCache = new Map(); // 精靈 id → 造型包｜null｜Promise
  function loadSkin(spiritId) {
    if (!skinCache.has(spiritId)) {
      skinCache.set(spiritId, Promise.resolve(bridge.skinGet?.(spiritId)).catch(() => null).then((skin) => {
        skinCache.set(spiritId, skin || null);
        return skin || null;
      }));
    }
    return skinCache.get(spiritId);
  }
  function showSkinOnCard(art, skin) {
    const view = createSkinView();
    view.setSkin(skin);
    art.replaceChildren(h('div', { className: 'spirit-skin' }, view.element));
    art.classList.add('has-skin');
  }

  function card(spirit, { large = false, index = 0, onClick } = {}) {
    const art = h('div', { className: 'spirit-art' },
      spirit.look.image
        ? h('img', { src: spirit.look.image, alt: '' })
        : h('span', { className: 'spirit-emoji', 'aria-hidden': 'true' }, spirit.look.emoji || '✦'),
    );
    // 有動態造型、而且沒有選「卡片上顯示靜態圖片」：卡片上的精靈會動
    if (spirit.look.cardMode !== 'image') {
      const cached = skinCache.get(spirit.id);
      if (cached && !(cached instanceof Promise)) showSkinOnCard(art, cached);
      else if (cached !== null) void loadSkin(spirit.id).then((skin) => { if (skin) showSkinOnCard(art, skin); });
    }
    const element = h(onClick ? 'button' : 'div', {
      className: `spirit-card${large ? ' spirit-card-large' : ''}`,
      type: onClick ? 'button' : undefined,
      dataset: { color: spirit.look.color, rarity: spirit.look.rarity },
      onClick,
      'aria-label': onClick ? `打開「${spirit.name}」` : undefined,
    },
      h('span', { className: 'spirit-rarity' }, spirit.look.rarity),
      art,
      h('div', { className: 'spirit-info' },
        h('strong', { className: 'spirit-name' }, spirit.name),
        h('p', { className: 'spirit-summary' }, spirit.summary || '還沒有簡述'),
        spirit.ai.targetId ? h('span', { className: 'spirit-ai' }, `🤖 ${targetName(spirit.ai.targetId)}`) : null,
      ),
    );
    element.style.setProperty('--i', String(index));
    return element;
  }

  // ── 卡片盒 ──
  function renderBox() {
    current = undefined;
    section = '';
    root.dataset.view = 'box';
    backButton.textContent = '← 回小精靈';
    saveLabel.textContent = '';
    countLabel.textContent = spirits.length ? `已收藏 ${spirits.length} 隻精靈` : '';
    const summon = h('button', { className: 'spirit-card spirit-summon', type: 'button', onClick: () => void createSpirit() },
      h('span', { className: 'summon-plus', 'aria-hidden': 'true' }, '＋'),
      h('strong', {}, '召喚新精靈'),
      h('small', {}, '建立一隻執行專項工作的精靈'),
    );
    summon.style.setProperty('--i', String(spirits.length));
    const grid = h('div', { className: 'spirit-grid' },
      ...spirits.map((spirit, index) => card(spirit, { index, onClick: () => openSpirit(spirit.id) })),
      summon,
    );
    body.replaceChildren(
      h('p', { className: 'lab-intro' }, spirits.length
        ? '每張卡片是一隻專門處理某種工作的精靈。點卡片可以調整牠的記憶、限制、角色、使用的 AI、工作步驟和造型。'
        : '這裡還沒有精靈。按「召喚新精靈」建立第一隻，例如「翻譯精靈」「報表精靈」「程式除錯精靈」。'),
      grid,
    );
  }

  async function createSpirit() {
    try {
      const spirit = await bridge.spiritsCreate();
      spirits.push(spirit);
      openSpirit(spirit.id, 'role'); // 新精靈先從名字與身份開始填
    } catch (error) {
      saveLabel.textContent = `建立失敗：${error.message}`;
      saveLabel.dataset.state = 'error';
    }
  }

  // ── 精靈詳細頁：卡片＋6 個浮動按鍵 ──
  let previewSlot;
  let panelSlot;
  function openSpirit(id, startSection = '') {
    const found = spirits.find((item) => item.id === id);
    if (!found) { renderBox(); return; }
    current = structuredClone(found);
    section = startSection;
    deleteArmedUntil = 0;
    root.dataset.view = 'detail';
    backButton.textContent = '← 卡片盒';
    saveLabel.textContent = '';
    renderDetail();
  }

  function refreshPreview() {
    if (!previewSlot || !current) return;
    previewSlot.replaceChildren(card(current, { large: true }));
  }

  function renderDetail() {
    previewSlot = h('div', { className: 'lab-preview' });
    refreshPreview();
    const orbs = SECTIONS.map((item, index) => {
      const button = h('button', {
        className: 'lab-orb',
        type: 'button',
        dataset: { section: item.id },
        'aria-pressed': String(section === item.id),
        title: item.hint,
        onClick: () => { section = item.id; renderDetail(); },
      }, h('span', { className: 'lab-orb-icon', 'aria-hidden': 'true' }, item.icon), h('span', { className: 'lab-orb-label' }, item.label));
      // 環繞卡片的位置（六角形）：從左上開始順時針，避開卡片正上下方
      const angle = (-150 + index * 60) * (Math.PI / 180);
      button.style.setProperty('--x', `${Math.round(Math.cos(angle) * 255)}px`);
      button.style.setProperty('--y', `${Math.round(Math.sin(angle) * 222)}px`);
      button.style.setProperty('--i', String(index));
      return button;
    });
    const remove = h('button', { className: 'lab-delete', type: 'button', onClick: () => void deleteCurrent() }, '刪除這隻精靈');
    // 叫牠工作：存好設定、離開精靈博士，打開提問框並選好這隻精靈
    const work = h('button', { className: 'lab-work', type: 'button', onClick: async () => {
      const spiritId = current.id;
      await close();
      onWork(spiritId);
    } }, '▶ 叫牠工作');
    if (!section) {
      // 剛點進來：卡片在中間，6 個按鍵浮在四周
      body.replaceChildren(
        h('div', { className: 'lab-stage', dataset: { mode: 'orbit' } },
          h('div', { className: 'lab-orbit' }, previewSlot, ...orbs),
          h('p', { className: 'lab-orbit-hint' }, '點選周圍的按鍵，設定這隻精靈'),
          h('div', { className: 'lab-row lab-detail-actions' }, work, remove),
        ),
      );
      return;
    }
    panelSlot = h('section', { className: 'lab-panel', 'aria-label': SECTIONS.find((item) => item.id === section)?.label });
    renderPanel();
    body.replaceChildren(
      h('div', { className: 'lab-stage', dataset: { mode: 'edit' } },
        h('aside', { className: 'lab-side' }, previewSlot, work, h('nav', { className: 'lab-rail', 'aria-label': '精靈設定' }, ...orbs), remove),
        panelSlot,
      ),
    );
  }

  async function deleteCurrent() {
    if (!current) return;
    const button = body.querySelector('.lab-delete');
    if (Date.now() > deleteArmedUntil) {
      deleteArmedUntil = Date.now() + 4000;
      button.textContent = `再按一次，確定刪除「${current.name}」`;
      button.dataset.armed = 'true';
      setTimeout(() => {
        if (button.isConnected && Date.now() > deleteArmedUntil) { button.textContent = '刪除這隻精靈'; delete button.dataset.armed; }
      }, 4100);
      return;
    }
    clearTimeout(saveTimer);
    saveLabel.dataset.state = '';
    await saving;
    spirits = await bridge.spiritsDelete(current.id);
    renderBox();
  }

  // ── 筆記本：背景知識、手動補充的記憶，點開來寫，按存檔才儲存 ──
  const notebook = h('dialog', { className: 'notebook', 'aria-labelledby': 'notebook-title' });
  root.append(notebook);
  function openNotebook({ icon, title, subtitle, value, placeholder, onSave }) {
    const original = value || '';
    let armed = false;
    const area = h('textarea', { className: 'notebook-paper', placeholder, spellcheck: false }, original);
    const count = h('span', { className: 'notebook-count' });
    const status = h('span', { className: 'notebook-status', 'aria-live': 'polite' });
    const paintCount = () => { count.textContent = `${area.value.length.toLocaleString()} 字`; };
    const dirty = () => area.value !== original;
    const save = () => { onSave(area.value); armed = false; notebook.close(); };
    const cancel = () => {
      if (dirty() && !armed) {
        armed = true;
        status.textContent = '還沒存檔：再按一次「取消」會放棄這次的修改';
        status.dataset.state = 'warn';
        return;
      }
      notebook.close();
    };
    area.addEventListener('input', () => { paintCount(); if (armed) { armed = false; status.textContent = ''; } });
    // ⌘S 存檔：焦點在筆記本裡任何地方都有效
    notebook.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    };
    notebook.oncancel = (event) => { event.preventDefault(); cancel(); }; // Esc
    notebook.replaceChildren(
      h('header', { className: 'notebook-head' },
        h('span', { className: 'notebook-icon', 'aria-hidden': 'true' }, icon),
        h('div', {}, h('h3', { id: 'notebook-title' }, title), h('p', {}, subtitle)),
      ),
      area,
      h('footer', { className: 'notebook-foot' },
        count, status,
        h('span', { className: 'notebook-spacer' }),
        h('button', { type: 'button', className: 'lab-mini', onClick: cancel }, '取消'),
        h('button', { type: 'button', className: 'notebook-save', onClick: save }, '存檔 ⌘S'),
      ),
    );
    paintCount();
    notebook.showModal();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
  /** 設定頁上的一列：顯示筆記本的開頭，點一下打開 */
  function notebookRow({ path, icon, title, subtitle, placeholder, hint }) {
    const value = path.split('.').reduce((object, key) => object?.[key], current) || '';
    const firstLine = value.split('\n').map((line) => line.trim().replace(/^(?:#{1,6}|[-*•]|\d+[.)])\s+/, '')).find(Boolean) || '';
    return h('div', { className: 'lab-field' },
      h('span', { className: 'lab-field-label' }, title),
      h('button', { type: 'button', className: 'notebook-row', onClick: () => openNotebook({
        icon, title, subtitle, value, placeholder,
        onSave: (text) => { update(path, text, { rerenderCard: false }); void flushSave(); renderPanel(); },
      }) },
        h('span', { className: 'notebook-row-icon', 'aria-hidden': 'true' }, icon),
        h('span', { className: 'notebook-row-text' },
          h('strong', {}, firstLine || '還沒有內容，點一下開始寫'),
          h('small', {}, value ? `${value.length.toLocaleString()} 字 · 點開編輯` : placeholder),
        ),
        h('span', { className: 'notebook-row-open', 'aria-hidden': 'true' }, '開啟 ›'),
      ),
      hint ? h('small', {}, hint) : null,
    );
  }

  // ── 各組設定的表單 ──
  const field = (label, control, hint) => h('label', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, label), control, hint ? h('small', {}, hint) : null);
  const textInput = (path, value, props = {}) => h('input', { type: 'text', value, onInput: (event) => update(path, event.target.value), ...props });
  const textArea = (path, value, props = {}) => h('textarea', { rows: 4, onInput: (event) => update(path, event.target.value, { rerenderCard: false }), ...props }, value);
  function segmented(path, value, options, onPick) {
    const group = h('div', { className: 'lab-segmented', role: 'radiogroup' });
    const paint = (selected) => group.querySelectorAll('button').forEach((button) => button.setAttribute('aria-checked', String(button.dataset.value === selected)));
    group.append(...options.map(([optionValue, label]) => h('button', {
      type: 'button', role: 'radio', dataset: { value: optionValue },
      onClick: () => { update(path, optionValue); paint(optionValue); onPick?.(optionValue); },
    }, label)));
    paint(value);
    return group;
  }
  const toggle = (path, value, label) => h('label', { className: 'lab-toggle' },
    h('input', { type: 'checkbox', checked: value, onChange: (event) => update(path, event.target.checked, { rerenderCard: false }) }), h('span', {}, label));
  const panelHeader = (item) => h('header', { className: 'lab-panel-header' },
    h('span', { className: 'lab-panel-icon', 'aria-hidden': 'true' }, item.icon),
    h('div', {}, h('h3', {}, item.label), h('p', {}, item.hint)));

  function renderPanel() {
    const item = SECTIONS.find((entry) => entry.id === section);
    const builders = { memory: memoryPanel, limits: limitsPanel, role: rolePanel, ai: aiPanel, sop: sopPanel, look: lookPanel };
    panelSlot.replaceChildren(panelHeader(item), h('div', { className: 'lab-panel-body' }, builders[section]()));
  }

  // ── 1. 資料庫與記憶 ──
  const KIND_ICON = { obsidian: '🟣', cloud: '☁️', local: '📁' };
  const FILE_ICON = (ext) => (['.md', '.markdown', '.txt'].includes(ext) ? '📝' : ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext) ? '🖼️'
    : ext === '.pdf' ? '📕' : ['.csv', '.xlsx', '.xls', '.numbers'].includes(ext) ? '📊' : ['.docx', '.doc', '.pages'].includes(ext) ? '📘' : '📄');
  const TEXT_KIND_LIST = new Set(['cli', 'api', 'ollama', 'builtin']);
  let kbLocations; // 偵測到的 Obsidian／雲端硬碟（只偵測一次）
  const finderName = () => (getState()?.integrations?.platform === 'win32' ? '檔案總管' : 'Finder');
  /** 沒選資料庫位置時，主程式會用「文件／Screen Spirit／精靈資料庫／精靈名稱」（只顯示，不寫進精靈設定） */
  function defaultHomeFor(spirit) {
    const root = getState()?.integrations?.defaultKbRoot || '';
    const name = String(spirit.name || '小精靈').replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '小精靈';
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    return { kind: 'local', path: root ? `${root}${sep}${name}` : '', label: `文件／Screen Spirit／精靈資料庫／${name}`, isDefault: true };
  }

  async function applyServerSpirit(saved) {
    // 主程式那邊改了這隻精靈（例如設定了資料庫位置）：同步回畫面，避免下次自動儲存把它蓋掉
    current.memory.home = saved.memory.home;
    const index = spirits.findIndex((item) => item.id === saved.id);
    if (index >= 0) spirits[index] = { ...spirits[index], memory: { ...spirits[index].memory, home: saved.memory.home } };
  }

  function memoryPanel() {
    const memory = current.memory;
    const spiritId = current.id;
    memoryBrowserRefresh = undefined;

    // A. 資料庫位置：下拉選單。沒有接上的（沒裝電腦版、沒找到筆記庫）也列出來但反灰
    const homeBox = h('div', { className: 'kb-home' });
    const homeError = h('small', { className: 'lab-error' });
    const ALL_PROVIDERS = [
      { provider: 'Obsidian', icon: '🟣', missing: '沒有找到筆記庫' },
      { provider: 'Google Drive', icon: '☁️', missing: '沒有安裝電腦版' },
      { provider: 'iCloud', icon: '☁️', missing: '沒有開啟 iCloud 雲碟' },
      { provider: 'Dropbox', icon: '☁️', missing: '沒有安裝電腦版' },
      { provider: 'OneDrive', icon: '☁️', missing: '沒有安裝電腦版' },
    ];
    async function chooseHome(location) {
      homeError.textContent = '';
      try {
        await flushSave();
        const result = await bridge.kbChooseHome({ spiritId, location });
        if (!result?.ok) { void paintHome(); return; } // 取消選資料夾：選單回到原本的位置
        await applyServerSpirit(result.spirit);
        renderPanel();
      } catch (error) {
        homeError.textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        void paintHome();
      }
    }
    async function paintHome() {
      if (!kbLocations) {
        homeBox.replaceChildren(h('p', { className: 'lab-note' }, '正在找這台電腦上的 Obsidian 筆記庫和雲端硬碟…'));
        try { kbLocations = await bridge.kbLocations(); } catch { kbLocations = []; }
      }
      const home = memory.home;
      const fallback = home ? null : defaultHomeFor(current);
      // 目前的資料庫是哪一個位置底下的「小精靈／名稱」資料夾
      const currentIndex = home ? kbLocations.findIndex((location) => home.path === location.path || home.path.startsWith(`${location.path}/`)) : -1;
      const select = h('select', { className: 'kb-select', 'aria-label': '資料庫位置' });
      select.append(h('option', { value: '', disabled: true, selected: !home }, `📁 預設：${fallback?.label || '文件／Screen Spirit／精靈資料庫'}`));
      const connected = h('optgroup', { label: '已接上' });
      kbLocations.forEach((location, index) => connected.append(h('option', { value: `loc:${index}`, selected: index === currentIndex },
        `${location.kind === 'obsidian' ? '🟣 Obsidian：' : '☁️ '}${location.label}`)));
      if (home && currentIndex < 0) connected.append(h('option', { value: 'current', selected: true }, `📁 ${home.label || home.path}`));
      if (connected.children.length) select.append(connected);
      const missing = ALL_PROVIDERS.filter((item) => !kbLocations.some((location) => location.provider === item.provider));
      if (missing.length) {
        select.append(h('optgroup', { label: '還沒接上' }, ...missing.map((item) => h('option', { value: '', disabled: true }, `${item.icon} ${item.provider}（${item.missing}）`))));
      }
      select.append(h('optgroup', { label: '其他' }, h('option', { value: 'pick' }, '📁 選擇電腦裡的資料夾…')));
      select.addEventListener('change', () => {
        const value = select.value;
        if (value === 'pick') void chooseHome({ kind: 'pick' });
        else if (value.startsWith('loc:')) void chooseHome(kbLocations[Number(value.slice(4))]);
      });
      homeBox.replaceChildren(
        h('div', { className: 'kb-home-row' },
          select,
          h('button', { type: 'button', className: 'lab-mini', onClick: () => void bridge.kbReveal({ spiritId, rootKey: 'home', rel: '' }) }, `在 ${finderName()} 顯示`),
        ),
        home
          ? h('small', { className: 'kb-home-path', title: home.path }, `存放位置：${home.path}`)
          : h('small', { className: 'lab-note', title: fallback.path }, `目前用預設位置${fallback.path ? `（${fallback.path}）` : ''}，第一次用到時自動建立。也可以換到 Obsidian 或雲端硬碟：會在裡面建立「小精靈／精靈名稱」資料夾，不會動到原本的內容；雲端硬碟要先安裝電腦版才會接上。`),
        homeError,
      );
    }
    void paintHome();

    // B. 資料夾內容：可以展開的樹＋檔案預覽
    const roots = [
      { key: 'home', label: memory.home ? '資料庫' : '資料庫（預設位置）' },
      ...memory.sources.map((source, index) => (source.kind === 'folder' ? { key: `source:${index}`, label: `📁 ${source.label || source.path.split(/[\\/]/).pop()}` } : null)).filter(Boolean),
    ];
    let browser = null;
    if (roots.length) {
      let rootKey = roots[0].key;
      const expanded = new Set();
      const children = new Map(); // rel → 內容
      const tree = h('ul', { className: 'kb-tree', role: 'tree' });
      const preview = h('div', { className: 'kb-preview' }, h('p', { className: 'kb-preview-empty' }, '點左邊的檔案可以在這裡預覽'));
      const tabs = h('div', { className: 'kb-tabs', role: 'tablist' });
      const loadChildren = async (rel) => {
        if (!children.has(rel)) {
          try { children.set(rel, await bridge.kbList({ spiritId, rootKey, rel })); } catch (error) { children.set(rel, { items: [], error: error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
        }
        return children.get(rel);
      };
      const showFile = async (item) => {
        tree.querySelectorAll('[aria-selected="true"]').forEach((row) => row.setAttribute('aria-selected', 'false'));
        tree.querySelector(`[data-rel="${CSS.escape(item.rel)}"]`)?.setAttribute('aria-selected', 'true');
        preview.replaceChildren(h('p', { className: 'kb-preview-empty' }, '讀取中…'));
        let file;
        try { file = await bridge.kbRead({ spiritId, rootKey, rel: item.rel }); } catch (error) {
          preview.replaceChildren(h('p', { className: 'lab-error' }, error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
          return;
        }
        const size = file.size < 1024 ? `${file.size} B` : file.size < 1048576 ? `${Math.round(file.size / 1024)} KB` : `${(file.size / 1048576).toFixed(1)} MB`;
        preview.replaceChildren(
          h('header', { className: 'kb-preview-head' },
            h('strong', { title: item.rel }, file.name),
            h('small', {}, `${size} · ${new Date(file.modified).toLocaleString()}`),
            h('div', { className: 'lab-row' },
              h('button', { type: 'button', className: 'lab-mini', onClick: () => void bridge.kbOpen({ spiritId, rootKey, rel: item.rel }) }, rootKey === 'home' && memory.home?.kind === 'obsidian' && file.ext === '.md' ? '在 Obsidian 打開' : '打開'),
              h('button', { type: 'button', className: 'lab-mini', onClick: () => void bridge.kbReveal({ spiritId, rootKey, rel: item.rel }) }, `在 ${finderName()} 顯示`),
            ),
          ),
          file.kind === 'text'
            ? h('pre', { className: 'kb-preview-text' }, file.text + (file.truncated ? '\n\n…（檔案太長，只顯示前面一部分）' : ''))
            : h('p', { className: 'kb-preview-empty' }, '這種檔案（PDF、圖片、Office 文件等）不能在這裡預覽，按「打開」用其他程式看。'),
        );
      };
      const paintTree = async () => {
        const rows = [];
        const walk = async (rel, depth) => {
          const listing = await loadChildren(rel);
          if (listing.error) { rows.push(h('li', { className: 'kb-row kb-row-error' }, listing.error)); return; }
          if (!listing.items.length && depth === 0) rows.push(h('li', { className: 'kb-row kb-row-empty' }, '這個資料夾是空的'));
          for (const item of listing.items) {
            const open = expanded.has(item.rel);
            const row = h('li', {
              className: 'kb-row', role: 'treeitem', tabIndex: 0, dataset: { rel: item.rel, type: item.type },
              'aria-expanded': item.type === 'dir' ? String(open) : undefined, 'aria-selected': 'false',
              onClick: () => {
                if (item.type === 'dir') { if (open) expanded.delete(item.rel); else expanded.add(item.rel); void paintTree(); } else void showFile(item);
              },
              onKeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); } },
            },
              h('span', { className: 'kb-caret', 'aria-hidden': 'true' }, item.type === 'dir' ? (open ? '▾' : '▸') : ''),
              h('span', { 'aria-hidden': 'true' }, item.type === 'dir' ? (open ? '📂' : '📁') : FILE_ICON(item.ext)),
              h('span', { className: 'kb-name' }, item.name),
              rootKey === 'home' && depth === 0 && item.name === '記憶' && item.type === 'dir' ? h('span', { className: 'kb-badge' }, '長期記憶') : null,
            );
            row.style.setProperty('--depth', String(depth));
            rows.push(row);
            if (item.type === 'dir' && open) await walk(item.rel, depth + 1);
          }
          if (listing.truncated) rows.push(h('li', { className: 'kb-row kb-row-empty' }, '…還有更多檔案沒有列出'));
        };
        await walk('', 0);
        tree.replaceChildren(...rows);
      };
      const paintTabs = () => tabs.replaceChildren(...roots.map((root) => h('button', {
        type: 'button', role: 'tab', className: 'kb-tab', 'aria-selected': String(root.key === rootKey),
        onClick: () => { rootKey = root.key; expanded.clear(); children.clear(); paintTabs(); preview.replaceChildren(h('p', { className: 'kb-preview-empty' }, '點左邊的檔案可以在這裡預覽')); void paintTree(); },
      }, root.label)));
      paintTabs();
      void paintTree();
      // 有「記憶」資料夾就先展開
      if (rootKey === 'home') { expanded.add('記憶'); }
      browser = h('div', { className: 'lab-field' },
        h('div', { className: 'kb-browser-head' },
          h('span', { className: 'lab-field-label' }, '資料夾內容'),
          tabs,
          h('button', { type: 'button', className: 'lab-icon kb-refresh', title: '重新整理', 'aria-label': '重新整理', onClick: () => { children.clear(); void paintTree(); } }, '⟳'),
        ),
        h('div', { className: 'kb-browser' }, tree, preview),
      );
      memoryBrowserRefresh = () => { children.clear(); expanded.add('記憶'); void paintTree(); };
    }

    // D. 其他參考資料（資料夾、單一檔案、網址）
    const sourceList = h('ul', { className: 'lab-sources' });
    const paintSources = () => {
      sourceList.replaceChildren(...(memory.sources.length ? memory.sources.map((source, index) => h('li', {},
        h('span', { className: 'lab-source-kind', 'aria-hidden': 'true' }, { folder: '📁', file: '📄', url: '🔗' }[source.kind]),
        h('span', { className: 'lab-source-path', title: source.path }, source.label || source.path),
        h('button', { type: 'button', className: 'lab-mini', onClick: () => { memory.sources.splice(index, 1); scheduleSave(); void flushSave().then(renderPanel); } }, '移除'),
      )) : [h('li', { className: 'lab-empty' }, '還沒有其他參考資料')]));
    };
    paintSources();
    const addPaths = async (kind) => {
      const paths = await bridge.spiritsPickSource(kind);
      for (const path of paths) {
        if (!memory.sources.some((source) => source.path === path)) memory.sources.push({ kind, path, label: path.split(/[\\/]/).pop() });
      }
      if (!paths.length) return;
      scheduleSave();
      await flushSave(); // 參考資料夾要先存好，資料夾內容那邊才讀得到
      renderPanel();
    };
    const urlInput = h('input', { type: 'url', placeholder: 'https://…', className: 'lab-url' });
    const addUrl = () => {
      const value = urlInput.value.trim();
      if (!/^https?:\/\/\S+$/.test(value)) { urlInput.setCustomValidity('請輸入 http:// 或 https:// 開頭的網址'); urlInput.reportValidity(); return; }
      urlInput.setCustomValidity('');
      memory.sources.push({ kind: 'url', path: value, label: value.replace(/^https?:\/\//, '').slice(0, 60) });
      urlInput.value = '';
      paintSources();
      scheduleSave();
    };
    urlInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addUrl(); } });

    // E. 長期記憶
    const state = getState() || {};
    const textTargets = [
      ...(state.deliveryTargets || []).filter((target) => TEXT_KIND_LIST.has(target.kind)),
      { id: 'builtin', label: '小精靈內建（ChatGPT 方案）', kind: 'builtin', ...(state.integrations?.builtin || { available: true }) },
    ];
    const mainTarget = textTargets.find((target) => target.id === current.ai.targetId);
    const curatorSelect = h('select', { onChange: (event) => { memory.curator.targetId = event.target.value; memory.curator.model = ''; scheduleSave(); paintCuratorModel(); } },
      h('option', { value: '', selected: !memory.curator.targetId }, mainTarget ? `跟主要 AI 一樣（${mainTarget.label.replace(/（.*）/, '')}）` : '請選擇（主要 AI 沒辦法整理記憶）'),
      ...textTargets.map((target) => h('option', { value: target.id, selected: memory.curator.targetId === target.id, disabled: target.available === false && memory.curator.targetId !== target.id },
        `${target.label}${target.available === false ? `（${target.reason || '不能用'}）` : ''}`)),
    );
    const curatorModel = h('div');
    function paintCuratorModel() {
      const target = textTargets.find((item) => item.id === memory.curator.targetId);
      const models = target?.kind === 'api' ? (state.mixroute?.models || []).filter((id) => !state.mixroute?.kinds?.[id]) : target?.kind === 'ollama' ? (state.ollama?.models || []).map((item) => (typeof item === 'string' ? item : item.name)) : [];
      curatorModel.replaceChildren(...(models.length ? [field('整理用的模型', h('select', { onChange: (event) => { memory.curator.model = event.target.value; scheduleSave(); } },
        h('option', { value: '', selected: !memory.curator.model }, '用預設模型（建議選便宜、快的）'),
        ...models.map((model) => h('option', { value: model, selected: memory.curator.model === model }, model)),
      ))] : []));
    }
    paintCuratorModel();
    const testResult = h('p', { className: 'kb-test-result', 'aria-live': 'polite' });
    const testButton = h('button', { type: 'button', className: 'lab-mini', onClick: async () => {
      testButton.disabled = true;
      testResult.dataset.state = '';
      testResult.textContent = '整理中…（會把對話內容送給整理用的 AI）';
      try {
        await flushSave();
        const result = await bridge.memoryCurateTest(spiritId);
        if (!result?.ok) { testResult.dataset.state = 'error'; testResult.textContent = result?.error || '整理失敗。'; }
        else if (result.saved) {
          testResult.dataset.state = 'saved';
          testResult.textContent = `用${result.used}試整理：存了一篇「${result.title}」。${result.reason || ''}`;
          memoryBrowserRefresh?.();
        } else {
          testResult.dataset.state = 'skipped';
          testResult.textContent = `用${result.used || '對話'}試整理：沒有存。${result.reason || ''}`;
        }
      } catch (error) {
        testResult.dataset.state = 'error';
        testResult.textContent = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
      testButton.disabled = false;
    } }, '用最近一段對話試整理一次');
    const persistentBox = h('div', { className: 'kb-persistent' },
      memory.home ? null : h('p', { className: 'lab-note' }, '還沒選資料庫位置：長期記憶會存在預設位置（文件／Screen Spirit／精靈資料庫）。'),
      h('p', { className: 'lab-note' }, '每次對話結束後，下面選的 AI 會讀過這段對話，只把「之後還用得到、跟這隻精靈工作有關」的重點整理成一篇筆記，存進資料庫的「記憶」資料夾。閒聊、一次性的問題、無關的內容和密碼等敏感資料都不會存。'),
      field('整理記憶用的 AI', curatorSelect, '只能選會把文字回傳給小精靈的 AI（Claude Code、Codex、Gemini CLI、MixRoute、Ollama、內建 ChatGPT）。'),
      curatorModel,
      h('div', { className: 'lab-row' }, testButton),
      testResult,
      notebookRow({ path: 'memory.notes', icon: '🗒️', title: '手動補充的記憶', subtitle: `${current.name}：自己寫給精靈的記憶，會和「記憶」資料夾裡的筆記一起帶給 AI`, placeholder: '例如：使用者的公司用 SAP；報表一律用千分位、單位萬元' }),
    );
    persistentBox.hidden = memory.mode !== 'persistent';
    const modeControl = segmented('memory.mode', memory.mode, [['none', '不記憶'], ['session', '只記這段對話'], ['persistent', '長期記憶']],
      (mode) => { persistentBox.hidden = mode !== 'persistent'; });

    return [
      h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '資料庫位置'), homeBox),
      browser,
      notebookRow({ path: 'memory.knowledge', icon: '📒', title: '背景知識', subtitle: `${current.name}：每次工作都會帶給 AI 的背景知識`, placeholder: '例如：公司產品清單、常用術語、固定的格式規定…', hint: '每次都會帶給 AI。' }),
      h('div', { className: 'lab-field' },
        h('span', { className: 'lab-field-label' }, '其他參考資料'),
        sourceList,
        h('div', { className: 'lab-row' },
          h('button', { type: 'button', className: 'lab-mini', onClick: () => void addPaths('folder') }, '＋ 資料夾'),
          h('button', { type: 'button', className: 'lab-mini', onClick: () => void addPaths('file') }, '＋ 檔案'),
          urlInput,
          h('button', { type: 'button', className: 'lab-mini', onClick: addUrl }, '＋ 網址'),
        ),
        h('small', {}, '只記下位置，不會複製檔案；加入的資料夾也可以在上面的「資料夾內容」瀏覽。'),
      ),
      h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '記憶方式'), modeControl,
        h('small', {}, '只記這段對話：同一段對話裡記得前面說過的話，結束就忘。長期記憶：重點會整理存進資料庫，之後的對話都能用。')),
      persistentBox,
    ];
  }
  let memoryBrowserRefresh;

  // ── 「✨ 讓 AI 幫我寫」共用元件（限制、角色身份與定位都用這個）──
  const DEPTH_NOTES = {
    limits: {
      quick: '列出 3～5 項主要職責，寫成精簡條列。大約 10～20 秒。',
      standard: '列出 5～8 項職責，依職責分組寫出可以做的事。大約 30 秒～1 分鐘。',
      deep: '列出 8～12 項職責，涵蓋邊界情況與各種越權面向，寫得最細。大約 1～3 分鐘，會花比較多額度。',
    },
    sop: {
      quick: '3～5 步，每步寫做法和檢查點。大約 10～20 秒。',
      standard: '5～8 步，每步寫做法、檢查點與注意事項。大約 30 秒～1 分鐘。',
      deep: '8～15 步，每步寫目的、需要的輸入、做法、檢查點、常見錯誤與何時先問你。大約 1～3 分鐘，會花比較多額度。',
    },
    role: {
      quick: '身份寫 2～3 句、專長 3～5 點。大約 10～20 秒。',
      standard: '身份寫一段、專長 6～10 點並依能力分組。大約 30 秒～1 分鐘。',
      deep: '身份寫出資歷、知識範圍與工作原則，專長 12 點以上並附產出物與品質標準。大約 1～3 分鐘，會花比較多額度。',
    },
  };
  let generateJobs = {}; // kind → { spiritId, running, result, error }；切到別組設定再回來也還在

  function textTargetList() {
    const state = getState() || {};
    return [
      ...(state.deliveryTargets || []).filter((target) => ['cli', 'api', 'ollama'].includes(target.kind)),
      { id: 'builtin', label: '小精靈內建（ChatGPT 方案）', kind: 'builtin', ...(state.integrations?.builtin || { available: true }) },
    ];
  }
  function modelsFor(target) {
    const state = getState() || {};
    if (target?.kind === 'api') return (state.mixroute?.models || []).filter((id) => !state.mixroute?.kinds?.[id]);
    if (target?.kind === 'ollama') return (state.ollama?.models || []).map((item) => (typeof item === 'string' ? item : item.name));
    return [];
  }
  const cleanError = (message) => String(message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  /**
   * @param {{ kind: 'limits'|'role', intro: string, briefLabel: string, briefPlaceholder: string, briefHint?: string,
   *           runningText: string, invoke: (payload) => Promise<object>, preview: (result, discard) => Node }} config
   */
  function generatorBox(config) {
    const { kind } = config;
    const generator = current[kind].generator;
    const spiritId = current.id;
    const job = generateJobs[kind]?.spiritId === spiritId ? generateJobs[kind] : { running: false, result: null, error: '' };
    const setJob = (next) => { generateJobs = { ...generateJobs, [kind]: { spiritId, running: false, result: null, error: '', ...next } }; };

    const targets = textTargetList();
    const mainTarget = targets.find((target) => target.id === current.ai.targetId);
    const aiSelect = h('select', { onChange: (event) => { generator.targetId = event.target.value; generator.model = ''; scheduleSave(); paintModel(); } },
      h('option', { value: '', selected: !generator.targetId }, mainTarget ? `跟主要 AI 一樣（${mainTarget.label.replace(/（.*）/, '')}）` : '請選擇'),
      ...targets.map((target) => h('option', { value: target.id, selected: generator.targetId === target.id, disabled: target.available === false && generator.targetId !== target.id },
        `${target.label}${target.available === false ? `（${target.reason || '不能用'}）` : ''}`)),
    );
    const modelSlot = h('div');
    function paintModel() {
      const models = modelsFor(targets.find((target) => target.id === generator.targetId));
      modelSlot.replaceChildren(...(models.length ? [field('模型', h('select', { onChange: (event) => { generator.model = event.target.value; scheduleSave(); } },
        h('option', { value: '', selected: !generator.model }, '用預設模型（深入分析建議選能力較強的）'),
        ...models.map((model) => h('option', { value: model, selected: generator.model === model }, model)),
      ))] : []));
    }
    paintModel();
    const depthNote = h('small', {}, DEPTH_NOTES[kind][generator.depth]);
    const status = h('p', { className: 'gen-status', 'aria-live': 'polite' });
    const runButton = h('button', { type: 'button', className: 'gen-run' }, '✨ 讓 AI 幫我寫');
    const cancelButton = h('button', { type: 'button', className: 'lab-mini', hidden: true, onClick: () => void bridge.spiritGenerateCancel() }, '停止');
    const paintRunning = () => {
      runButton.disabled = true;
      runButton.textContent = '分析中…';
      cancelButton.hidden = false;
      status.dataset.state = 'running';
      status.textContent = `${config.runningText}${generator.depth === 'deep' ? '深入分析大約要 1～3 分鐘。' : ''}`;
    };
    runButton.addEventListener('click', async () => {
      setJob({ running: true });
      paintRunning();
      await flushSave();
      let response;
      try {
        response = await config.invoke({ spiritId, brief: generator.brief, depth: generator.depth, targetId: generator.targetId, model: generator.model });
      } catch (error) {
        response = { ok: false, error: cleanError(error.message) };
      }
      setJob({ result: response.ok ? response : null, error: response.ok || response.cancelled ? '' : response.error });
      // 使用者還停在這一頁才重畫（切走了就等回來再看）
      if (current?.id === spiritId && section === kind) renderPanel();
    });
    if (job.running) paintRunning();
    else if (job.error) { status.dataset.state = 'error'; status.textContent = job.error; runButton.textContent = '✨ 再試一次'; }
    else if (job.result) runButton.textContent = '✨ 重新產生';

    return h('section', { className: 'gen-box' },
      h('header', { className: 'gen-head' }, h('strong', {}, '✨ 讓 AI 幫我寫'), h('small', {}, config.intro)),
      field(config.briefLabel, h('textarea', { rows: 3, placeholder: config.briefPlaceholder, onInput: (event) => update(`${kind}.generator.brief`, event.target.value, { rerenderCard: false }) }, generator.brief), config.briefHint),
      h('div', { className: 'lab-grid-2' },
        h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '分析深度'),
          segmented(`${kind}.generator.depth`, generator.depth, [['quick', '簡要'], ['standard', '標準'], ['deep', '深入']], (depth) => { depthNote.textContent = DEPTH_NOTES[kind][depth]; }),
          depthNote),
        h('div', {}, field('用哪個 AI 分析', aiSelect), modelSlot),
      ),
      h('div', { className: 'lab-row' }, runButton, cancelButton),
      status,
      job.result ? config.preview(job.result, () => { setJob({}); renderPanel(); }) : null,
    );
  }

  // ── 2. 限制 ──
  function limitsPanel() {
    const limits = current.limits;
    return [
      generatorBox({
        kind: 'limits',
        intro: 'AI 會先判斷這個角色對應現實中的哪種職業、列出主要職責，再寫出可以做的事；職責以外的事一律列為不可以做（不越權）。',
        briefLabel: '你的想法（隨意寫，AI 會幫你整理）',
        briefPlaceholder: '例如：幫我回客訴信，只寫草稿不要直接寄出；不要碰報價和退款',
        briefHint: `也會參考「角色身份與定位」裡的名稱、簡述、身份與專長${current.role.identity || current.role.positioning ? '' : '（目前還沒填，建議先填一下）'}。`,
        runningText: 'AI 正在判斷角色、列出現實職責並寫出限制…',
        invoke: (payload) => bridge.spiritGenerateLimits(payload),
        preview: limitsPreview,
      }),
      notebookRow({ path: 'limits.allowed', icon: '✅', title: '可以做的事', subtitle: `${current.name}：職責範圍內可以做的工作`, placeholder: '例如：翻譯、潤稿、整理成表格' }),
      notebookRow({ path: 'limits.forbidden', icon: '⛔', title: '不可以做的事', subtitle: `${current.name}：職責以外、不能越權去做的事`, placeholder: '例如：不要修改原始檔案；不要回答與工作無關的問題' }),
      notebookRow({ path: 'limits.askFirst', icon: '❓', title: '需要先問我的事', subtitle: `${current.name}：範圍內，但做之前要先取得同意的動作`, placeholder: '例如：寄出信件、覆蓋檔案、對外發布之前先問我' }),
      h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '回覆長度'),
        segmented('limits.replyLength', limits.replyLength, [['short', '簡短'], ['medium', '適中'], ['long', '詳細']])),
      h('div', { className: 'lab-field' },
        h('span', { className: 'lab-field-label' }, '安全'),
        toggle('limits.confirmBeforeAction', limits.confirmBeforeAction, '要執行動作（寄信、改檔案、建立行程）前，先問我'),
        toggle('limits.citeSources', limits.citeSources, '回答要附上資料來源'),
      ),
    ];
  }

  const roleOf = (result) => h('div', { className: 'gen-role' },
    h('span', { className: 'lab-field-label' }, 'AI 判斷的角色'),
    h('p', {}, result.role || '（沒有寫）'),
    result.responsibilities?.length ? h('div', { className: 'gen-chips' }, ...result.responsibilities.map((item) => h('span', {}, item))) : null,
  );
  const genBlock = (icon, title, text) => h('div', { className: 'gen-block' },
    h('strong', {}, `${icon} ${title}`),
    text ? h('pre', {}, text) : h('p', { className: 'lab-note' }, '（AI 沒有寫這一項）'));

  /** 限制的結果：先預覽，使用者決定取代、加到後面或捨棄 */
  function limitsPreview(result, discard) {
    const limits = current.limits;
    const hasExisting = Boolean(limits.allowed.trim() || limits.forbidden.trim() || limits.askFirst.trim());
    const apply = (mode) => {
      const merge = (old, next) => (mode === 'append' && old.trim() && next ? `${old.trim()}\n\n${next}` : next || old);
      update('limits.allowed', merge(limits.allowed, result.allowed), { rerenderCard: false });
      update('limits.forbidden', merge(limits.forbidden, result.forbidden), { rerenderCard: false });
      update('limits.askFirst', merge(limits.askFirst, result.askFirst), { rerenderCard: false });
      void flushSave();
      discard();
    };
    return h('div', { className: 'gen-preview' },
      roleOf(result),
      genBlock('✅', '可以做的事', result.allowed),
      genBlock('⛔', '不可以做的事', result.forbidden),
      genBlock('❓', '需要先問我的事', result.askFirst),
      h('div', { className: 'lab-row gen-actions' },
        h('button', { type: 'button', className: 'gen-apply', onClick: () => apply('replace') }, hasExisting ? '套用（取代目前內容）' : '套用'),
        hasExisting ? h('button', { type: 'button', className: 'lab-mini', onClick: () => apply('append') }, '加到目前內容後面') : null,
        h('button', { type: 'button', className: 'lab-mini', onClick: discard }, '捨棄'),
      ),
      h('small', { className: 'lab-note' }, '套用後還可以點下面的筆記本自己修改。'),
    );
  }

  // ── 3. 角色身份與定位 ──
  const TONE_OPTIONS = [['friendly', '親切'], ['professional', '專業'], ['concise', '簡潔直接'], ['teacher', '像老師一樣解釋'], ['playful', '活潑']];
  const LANGUAGE_OPTIONS = [['zh-Hant', '繁體中文'], ['zh-Hans', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['auto', '跟著提問的語言']];
  const labelOf = (options, value) => options.find(([key]) => key === value)?.[1] || value;

  function rolePanel() {
    const role = current.role;
    const select = (path, value, options) => h('select', { onChange: (event) => update(path, event.target.value, { rerenderCard: false }) },
      ...options.map(([optionValue, label]) => h('option', { value: optionValue, selected: value === optionValue }, label)));
    return [
      generatorBox({
        kind: 'role',
        intro: 'AI 會先判斷你想要的精靈對應現實中的哪種職業，再幫你寫好名稱、卡片簡述、服務對象、身份、定位與專長，並建議說話的語氣。',
        briefLabel: '你想要什麼樣的精靈？（隨意寫）',
        briefPlaceholder: '例如：幫我把日文技術文件翻成中文，客戶是鋼鐵業，專有名詞要保留原文',
        briefHint: '下面已經填好的內容也會一起參考，AI 會保留原意再補強。',
        runningText: 'AI 正在判斷職業、寫出身份與專長…',
        invoke: (payload) => bridge.spiritGenerateRole(payload),
        preview: rolePreview,
      }),
      h('div', { className: 'lab-grid-2' },
        field('名稱', textInput('name', current.name, { maxLength: 40, placeholder: '例如：翻譯精靈' })),
        field('服務對象', textInput('role.audience', role.audience, { placeholder: '例如：業務部同事、客戶' })),
      ),
      field('卡片簡述', textInput('summary', current.summary, { maxLength: 120, placeholder: '一句話說明這隻精靈做什麼' })),
      notebookRow({ path: 'role.identity', icon: '🪪', title: '身份', subtitle: `${current.name}：寫給 AI 看的角色設定（你是……）`, placeholder: '例如：你是一位有 10 年經驗的日中翻譯，熟悉鋼鐵業術語。' }),
      notebookRow({ path: 'role.positioning', icon: '🎯', title: '定位與專長', subtitle: `${current.name}：最擅長的任務、工作方法與產出物`, placeholder: '例如：專門把技術文件翻成客戶看得懂的中文；遇到專有名詞保留原文。' }),
      h('div', { className: 'lab-grid-2' },
        field('語氣', select('role.tone', role.tone, TONE_OPTIONS)),
        field('回覆語言', select('role.language', role.language, LANGUAGE_OPTIONS)),
      ),
    ];
  }

  /** 角色的結果：每一項都可以勾選要不要套用 */
  function rolePreview(result, discard) {
    const isDefaultName = /^(新的小精靈|未命名的小精靈)$/.test(current.name);
    const items = [
      { key: 'name', path: 'name', icon: '🏷️', title: '名稱', value: result.name, now: current.name, checked: isDefaultName },
      { key: 'summary', path: 'summary', icon: '💬', title: '卡片簡述', value: result.summary, now: current.summary },
      { key: 'audience', path: 'role.audience', icon: '👥', title: '服務對象', value: result.audience, now: current.role.audience },
      { key: 'identity', path: 'role.identity', icon: '🪪', title: '身份', value: result.identity, now: current.role.identity, long: true },
      { key: 'positioning', path: 'role.positioning', icon: '🎯', title: '定位與專長', value: result.positioning, now: current.role.positioning, long: true },
      { key: 'tone', path: 'role.tone', icon: '🗣️', title: '語氣', value: result.tone, shown: labelOf(TONE_OPTIONS, result.tone), now: current.role.tone },
      { key: 'language', path: 'role.language', icon: '🌐', title: '回覆語言', value: result.language, shown: labelOf(LANGUAGE_OPTIONS, result.language), now: current.role.language },
    ].filter((item) => item.value && item.value !== item.now);
    const chosen = new Set(items.filter((item) => item.checked !== false).map((item) => item.key));
    const applyButton = h('button', { type: 'button', className: 'gen-apply' });
    const paintApply = () => { applyButton.textContent = `套用勾選的 ${chosen.size} 項`; applyButton.disabled = !chosen.size; };
    applyButton.addEventListener('click', () => {
      for (const item of items) if (chosen.has(item.key)) update(item.path, item.value, { rerenderCard: false });
      refreshPreview();
      void flushSave();
      discard();
    });
    paintApply();
    const rows = items.map((item) => {
      const box = h('input', { type: 'checkbox', checked: chosen.has(item.key), onChange: (event) => { if (event.target.checked) chosen.add(item.key); else chosen.delete(item.key); paintApply(); } });
      return h('div', { className: 'gen-pick' },
        h('label', { className: 'gen-pick-head' }, box, h('strong', {}, `${item.icon} ${item.title}`),
          item.now && item.key !== 'tone' && item.key !== 'language' && !(item.key === 'name' && isDefaultName) ? h('small', {}, '會取代目前的內容') : null),
        item.long ? h('pre', {}, item.value) : h('p', { className: 'gen-pick-value' }, item.shown || item.value),
      );
    });
    return h('div', { className: 'gen-preview' },
      roleOf(result),
      rows.length ? h('div', { className: 'gen-picks' }, ...rows) : h('p', { className: 'lab-note' }, 'AI 寫出來的內容跟目前的一樣，沒有需要更新的地方。'),
      h('div', { className: 'lab-row gen-actions' },
        rows.length ? applyButton : null,
        h('button', { type: 'button', className: 'lab-mini', onClick: discard }, rows.length ? '捨棄' : '關閉'),
      ),
      h('small', { className: 'lab-note' }, isDefaultName ? '套用後還可以在下面自己修改。' : '名稱預設不勾選，避免改掉你取好的名字；想用 AI 建議的名字就勾起來。'),
    );
  }

  function aiPanel() {
    const ai = current.ai;
    const state = getState() || {};
    const kinds = state.mixroute?.kinds || {};
    // 以前把生圖模型選在「主要 AI 的模型」：自動搬到「生圖模型」
    let movedNote = '';
    if (ai.model && kinds[ai.model] === 'image' && !ai.imageModel) {
      ai.imageModel = ai.model;
      ai.model = '';
      movedNote = `「${ai.imageModel}」是生圖模型，已經幫你移到下面的「生圖模型」；主要 AI 改用一般的對話模型。`;
      scheduleSave();
    }
    const targets = [
      ...(state.deliveryTargets || []),
      { id: 'builtin', label: '小精靈內建（ChatGPT 方案）', kind: 'builtin', ...(state.integrations?.builtin || { available: true }) },
    ];
    const describe = (target) => ({
      cli: '在背景執行，回覆顯示在小精靈對話框，可以接著問。',
      api: '用 API 回答，回覆顯示在小精靈對話框；會扣點數。',
      ollama: '用這台 Mac 上的模型回答，不用網路、不花錢。',
      builtin: '用小精靈內建的 ChatGPT 方案回答。',
      app: target.projectBased ? '打開 App 與專案，把內容貼進對話框，由你按送出。' : '打開 App 或網頁貼上並送出，在那邊看回覆。',
    }[target.kind] || '');
    const options = (selected, emptyLabel) => [
      h('option', { value: '', selected: !selected }, emptyLabel),
      ...targets.map((target) => h('option', {
        value: target.id, selected: selected === target.id, disabled: target.available === false && selected !== target.id,
      }, `${target.label}${target.available === false ? `（${target.reason || '不能用'}）` : ''}`)),
    ];
    const note = h('p', { className: 'lab-note' });
    const modelField = h('div');
    const paint = () => {
      const target = targets.find((item) => item.id === current.ai.targetId);
      note.textContent = target ? describe(target) : '還沒指定：這隻精靈會用主視窗的「預設送到」。';
      const models = target?.kind === 'api'
        ? (state.mixroute?.models || []).filter((id) => !state.mixroute?.kinds?.[id])
        : target?.kind === 'ollama' ? (state.ollama?.models || []).map((item) => (typeof item === 'string' ? item : item.name)) : [];
      modelField.replaceChildren(...(target && ['api', 'ollama'].includes(target.kind) ? [field('模型', h('select', { onChange: (event) => update('ai.model', event.target.value, { rerenderCard: false }) },
        h('option', { value: '', selected: !current.ai.model }, '用預設模型'),
        ...models.map((model) => h('option', { value: model, selected: current.ai.model === model }, model)),
        current.ai.model && !models.includes(current.ai.model) ? h('option', { value: current.ai.model, selected: true }, `${current.ai.model}（${{ image: '生圖模型，不能對話', video: '影片模型，不能對話', audio: '語音模型，不能對話', embedding: '向量模型，不能對話' }[state.mixroute?.kinds?.[current.ai.model]] || '目前不可用'}）`) : null,
      ))] : []));
    };
    paint();
    return [
      field('主要 AI', h('select', { onChange: (event) => { current.ai.model = ''; update('ai.targetId', event.target.value); paint(); } }, ...options(ai.targetId, '跟著主視窗的預設'))),
      note,
      modelField,
      field('備用 AI', h('select', { onChange: (event) => update('ai.fallbackTargetId', event.target.value, { rerenderCard: false }) }, ...options(ai.fallbackTargetId, '不使用')),
        '主要 AI 連不上、沒登入或額度用完時改用這個。'),
      imageSection(movedNote),
    ];
  }

  /** 生圖：精靈回答需要圖片時，把提示詞交給 MixRoute 的生圖模型畫出來 */
  function imageSection(movedNote) {
    const ai = current.ai;
    const state = getState() || {};
    const kinds = state.mixroute?.kinds || {};
    const imageModels = (state.mixroute?.models || []).filter((id) => kinds[id] === 'image');
    const mainTarget = (state.deliveryTargets || []).find((target) => target.id === ai.targetId);
    const readsBack = !ai.targetId || ['cli', 'api', 'ollama'].includes(mainTarget?.kind) || ai.targetId === 'builtin';
    const warning = h('p', { className: 'kb-warning' });
    const paintWarning = () => {
      const message = !ai.imageModel ? ''
        : !state.mixroute?.hasKey ? '畫圖要用 MixRoute：請先在主視窗選 MixRoute，按「金鑰」輸入 API 金鑰。'
          : !readsBack ? `主要 AI（${mainTarget?.label.replace(/（.*）/, '') || ''}）是操作 App 的方式，拿不回回答，所以沒辦法接著畫圖。請改選 Claude Code、MixRoute、Ollama 或內建 ChatGPT。` : '';
      warning.textContent = message;
      warning.hidden = !message;
    };
    paintWarning();
    const select = h('select', { onChange: (event) => { update('ai.imageModel', event.target.value, { rerenderCard: false }); paintWarning(); } },
      h('option', { value: '', selected: !ai.imageModel }, '不畫圖'),
      ...imageModels.map((model) => h('option', { value: model, selected: ai.imageModel === model }, model)),
      ai.imageModel && !imageModels.includes(ai.imageModel) ? h('option', { value: ai.imageModel, selected: true }, `${ai.imageModel}（目前讀不到）`) : null,
    );
    const sizes = [['1024x1024', '正方形 1:1'], ['1536x1024', '橫式 3:2'], ['1024x1536', '直式 2:3'], ['auto', '讓模型決定']];
    return h('section', { className: 'gen-box' },
      h('header', { className: 'gen-head' },
        h('strong', {}, '🎨 生圖'),
        h('small', {}, '設定之後，精靈會先照角色與 SOP 想好設計，回答最後附上生圖提示詞，小精靈再交給這個模型畫出來。你附了圖片的話，會當成參考圖一起送去修改。'),
      ),
      movedNote ? h('p', { className: 'lab-note' }, movedNote) : null,
      h('div', { className: 'lab-grid-2' },
        field('生圖模型（MixRoute）', select, imageModels.length ? '' : (state.mixroute?.hasKey ? 'MixRoute 的模型清單裡沒有生圖模型。' : '還沒設定 MixRoute 金鑰，讀不到生圖模型。')),
        field('圖片比例', h('select', { onChange: (event) => update('ai.imageSize', event.target.value, { rerenderCard: false }) },
          ...sizes.map(([value, label]) => h('option', { value, selected: (ai.imageSize || '1024x1024') === value }, label)))),
      ),
      warning,
    );
  }

  function sopPanel() {
    const sop = current.sop;
    const list = h('ol', { className: 'lab-steps' });
    const move = (from, to) => { [sop.steps[from], sop.steps[to]] = [sop.steps[to], sop.steps[from]]; paint(); scheduleSave(); };
    // 內容多的步驟，輸入框跟著長高（最多 10 行，再多就捲動）
    const rowsFor = (text) => Math.min(10, Math.max(2, String(text || '').split('\n').length));
    function paint() {
      list.replaceChildren(...sop.steps.map((step, index) => h('li', { className: 'lab-step' },
        h('span', { className: 'lab-step-no' }, String(index + 1)),
        h('div', { className: 'lab-step-body' },
          h('input', { type: 'text', value: step.title, placeholder: '步驟名稱，例如：確認需求', maxLength: 80, onInput: (event) => { step.title = event.target.value; scheduleSave(); } }),
          h('textarea', { rows: rowsFor(step.detail), placeholder: '這一步要做什麼、怎樣算完成、要注意什麼', onInput: (event) => { step.detail = event.target.value; event.target.rows = rowsFor(event.target.value); scheduleSave(); } }, step.detail),
        ),
        h('div', { className: 'lab-step-tools' },
          h('button', { type: 'button', className: 'lab-icon', title: '往上', 'aria-label': '往上移', disabled: index === 0, onClick: () => move(index, index - 1) }, '↑'),
          h('button', { type: 'button', className: 'lab-icon', title: '往下', 'aria-label': '往下移', disabled: index === sop.steps.length - 1, onClick: () => move(index, index + 1) }, '↓'),
          h('button', { type: 'button', className: 'lab-icon', title: '刪除這一步', 'aria-label': '刪除這一步', onClick: () => { sop.steps.splice(index, 1); paint(); scheduleSave(); } }, '×'),
        ),
      )));
      if (!sop.steps.length) list.append(h('li', { className: 'lab-empty' }, '還沒有步驟。精靈會直接回答；加上步驟後，牠會照順序完成工作。'));
      addButton.disabled = sop.steps.length >= 20;
    }
    const addButton = h('button', { type: 'button', className: 'lab-mini lab-add-step', onClick: () => {
      sop.steps.push({ title: '', detail: '' });
      paint();
      scheduleSave();
      list.querySelector('li:last-child input')?.focus();
    } }, '＋ 新增步驟');
    paint();
    return [
      generatorBox({
        kind: 'sop',
        intro: 'AI 會用流程設計專家的角度，依照這個職業在現實中的做法排出步驟：每一步寫清楚做法、怎樣算完成、容易出錯的地方，以及什麼時候要先問你。步驟越具體，精靈實際工作時越不容易出錯。',
        briefLabel: '這份 SOP 要完成什麼工作？',
        briefPlaceholder: '例如：收到客訴信後，整理出問題重點，寫一封回覆草稿給我確認',
        briefHint: '也會參考角色身份、專長與限制：不能做的事不會出現在步驟裡，需要先問你的動作前會加上確認。目前已有的步驟也會保留合理的部分再補強。',
        runningText: 'AI 正在依照專業做法拆解步驟…',
        invoke: (payload) => bridge.spiritGenerateSop(payload),
        preview: sopPreview,
      }),
      h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '工作步驟'), list, addButton),
      field('輸出格式', textArea('sop.outputFormat', sop.outputFormat, { placeholder: '例如：先給一句結論，再用表格列出細節；最後列出待確認事項' })),
    ];
  }

  /** SOP 的結果：可以逐步勾選，再決定取代或接在後面 */
  function sopPreview(result, discard) {
    const sop = current.sop;
    const chosen = new Set(result.steps.map((_, index) => index));
    let useFormat = Boolean(result.outputFormat);
    const hasExisting = sop.steps.some((step) => step.title || step.detail);
    const buttons = [];
    const paintButtons = () => buttons.forEach((button) => { button.disabled = !chosen.size && !useFormat; });
    const apply = (mode) => {
      const picked = result.steps.filter((_, index) => chosen.has(index)).map((step) => ({ ...step }));
      const kept = mode === 'append' ? sop.steps.filter((step) => step.title || step.detail) : [];
      sop.steps = [...kept, ...picked].slice(0, 20);
      if (useFormat) sop.outputFormat = result.outputFormat;
      scheduleSave();
      void flushSave();
      discard();
    };
    const steps = result.steps.map((step, index) => h('li', { className: 'gen-step' },
      h('label', { className: 'gen-pick-head' },
        h('input', { type: 'checkbox', checked: true, onChange: (event) => { if (event.target.checked) chosen.add(index); else chosen.delete(index); paintButtons(); } }),
        h('span', { className: 'lab-step-no' }, String(index + 1)),
        h('strong', {}, step.title),
      ),
      step.detail ? h('pre', {}, step.detail) : null,
    ));
    const replaceButton = h('button', { type: 'button', className: 'gen-apply', onClick: () => apply('replace') }, hasExisting ? '套用（取代目前步驟）' : '套用勾選的步驟');
    buttons.push(replaceButton);
    let appendButton = null;
    if (hasExisting) {
      appendButton = h('button', { type: 'button', className: 'lab-mini', onClick: () => apply('append') }, '接在目前步驟後面');
      buttons.push(appendButton);
    }
    const overflow = hasExisting && sop.steps.length + result.steps.length > 20;
    return h('div', { className: 'gen-preview' },
      h('div', { className: 'gen-role' }, h('span', { className: 'lab-field-label' }, 'AI 理解的工作'), h('p', {}, result.task || '（沒有寫）')),
      h('div', { className: 'gen-block' }, h('strong', {}, `🧭 步驟（${result.steps.length} 步，可以取消勾選不要的）`), h('ol', { className: 'gen-steps' }, ...steps)),
      result.outputFormat ? h('div', { className: 'gen-pick' },
        h('label', { className: 'gen-pick-head' },
          h('input', { type: 'checkbox', checked: true, onChange: (event) => { useFormat = event.target.checked; paintButtons(); } }),
          h('strong', {}, '📄 輸出格式'),
          sop.outputFormat ? h('small', {}, '會取代目前的內容') : null),
        h('pre', {}, result.outputFormat)) : null,
      h('div', { className: 'lab-row gen-actions' }, replaceButton, appendButton, h('button', { type: 'button', className: 'lab-mini', onClick: discard }, '捨棄')),
      h('small', { className: 'lab-note' }, overflow ? '最多 20 步：接在後面時超過的步驟不會加入。' : '套用後還可以在下面自己修改、調整順序。'),
    );
  }

  // ── 動態造型：匯入設定圖 → 確認零件位置 → 產生分層造型（SKIN-SPEC.md）──
  const SKIN_PARTS = [
    ['left_eye', '左眼', 'face'], ['right_eye', '右眼', 'face'], ['mouth', '嘴巴', 'face'],
    ['hat', '帽子', 'acc'], ['face_accessory', '臉上配件', 'acc'], ['prop_left', '左側道具', 'acc'], ['prop_right', '右側道具', 'acc'],
    ['extra_a', '其他配件 A', 'acc'], ['extra_b', '其他配件 B', 'acc'],
    ['body', '身體（對齊預設小精靈的大小）', 'body'],
  ];
  /** 讓一個框可以拖動（移動）和拉右下角（調整大小）；box 是 0～1000 的比例座標，會直接被改動 */
  function attachBoxDrag(stage, element, handle, box, place) {
    const toUnits = (event, rect) => [((event.clientX - rect.left) / rect.width) * 1000, ((event.clientY - rect.top) / rect.height) * 1000];
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const resizing = event.target === handle;
      const [sx, sy] = toUnits(event, rect);
      const original = [...box];
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      const move = (moveEvent) => {
        const [x, y] = toUnits(moveEvent, rect);
        const dx = x - sx; const dy = y - sy;
        let [x0, y0, x1, y1] = original;
        if (resizing) { x1 = Math.max(x0 + 20, Math.min(1000, x1 + dx)); y1 = Math.max(y0 + 20, Math.min(1000, y1 + dy)); }
        else {
          const w = x1 - x0; const hgt = y1 - y0;
          x0 = Math.max(0, Math.min(1000 - w, x0 + dx)); y0 = Math.max(0, Math.min(1000 - hgt, y0 + dy));
          x1 = x0 + w; y1 = y0 + hgt;
        }
        box.splice(0, 4, ...[x0, y0, x1, y1].map(Math.round));
        place(element, box);
      };
      const end = () => { element.removeEventListener('pointermove', move); element.classList.remove('dragging'); };
      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', end, { once: true });
      element.addEventListener('pointercancel', end, { once: true });
    });
  }
  const placeBox = (element, [x0, y0, x1, y1]) => {
    element.style.left = `${x0 / 10}%`; element.style.top = `${y0 / 10}%`;
    element.style.width = `${(x1 - x0) / 10}%`; element.style.height = `${(y1 - y0) / 10}%`;
  };
  const SKIN_PART_LABEL = Object.fromEntries(SKIN_PARTS.map(([name, label]) => [name, label]));
  const SKIN_ACCESSORIES = new Set(SKIN_PARTS.filter(([, , kind]) => kind === 'acc').map(([name]) => name));
  // 配件分兩類：獨立的（單獨一層、和設計稿比對）、和角色融為一體的（畫在特製主體上）
  const SKIN_ORDERS = [['front', '獨立配件（在身體前面）'], ['behind', '獨立配件（在身體後面）'], ['fused', '和角色融為一體']];
  const orderOf = (part) => (part?.layer === 'wraps' ? 'fused' : part?.layer || 'front');
  // 配件的名稱：盤點時看圖模型給的真正名稱（例如「反戴棒球帽」），沒有才用位置名稱
  const nameOf = (name, list) => (list || []).find((part) => part.name === name)?.labelZh || SKIN_PART_LABEL[name];
  const layerIdOf = (name) => name.replace('_', '-');
  const SKIN_MOODS = [['idle', '待機'], ['work', '思考中'], ['done', '完成'], ['error', '出錯']];
  const SKIN_REDO = [['all', '全部'], ['body', '身體＋表情'], ['face:blink', '眨眼'], ['face:work', '思考中'], ['face:done', '完成'], ['face:error', '出錯'], ['accessories', '配件']];
  const skinProgress = new Map(); // 精靈 id → 進度紀錄
  let skinRefresh; // 目前畫面上的造型區塊：收到進度時重畫
  let samRefresh; // 本機切割工具狀態列：安裝完成時更新
  bridge.onSkinProgress?.((event) => {
    if (event?.stage === 'sam') { samRefresh?.(); return; }
    if (!event?.spiritId) return;
    const log = skinProgress.get(event.spiritId) || [];
    if (event.stage === 'master' || (event.stage === 'layers' && !event.done && event.total)) log.length = 0;
    const last = log.at(-1);
    if (last && last.stage === event.stage && event.stage === 'layers' && last.label === event.label) log.pop();
    log.push(event);
    skinProgress.set(event.spiritId, log);
    if (current?.id === event.spiritId) skinRefresh?.(event);
  });
  function skinSection() {
    const spiritId = current.id;
    const box = h('section', { className: 'gen-box skin-box-section' });
    const head = h('header', { className: 'gen-head' },
      h('strong', {}, '🎬 動態造型'),
      h('small', {}, '上傳精靈的設定圖，系統會把設定圖上的主角裁下來當主圖（也可以改請 AI 重畫）、找出眼睛、嘴巴和配件，再做出眨眼、思考、開心、驚訝的臉與會動的配件。完成後桌面小精靈會換成牠。'),
    );
    let view = 'loading';
    let draft = null;
    let skin = null;
    let busy = '';
    let parts = [];
    let error = '';
    let sheet = null; // { dataUrl, name }
    let masterMode = 'crop'; // 'crop'：直接用設定圖的主角；'redraw'：請 AI 重畫正面圖
    let heroBox = [0, 0, 1000, 1000];
    let heroNote = '';
    let imageChoice = '';
    let visionChoice = '';
    let models = null;
    let mood = 'idle';
    let exploded = false;
    let removeArmed = 0;
    let desktop = '';

    // 本機切割工具（SAM 2.1）：裝了就用它切配件（最準）；沒裝就用比對，品質差一些
    const samRow = h('div', { className: 'skin-sam' });
    async function paintSam(installing = false) {
      let info = { status: installing ? 'installing' : 'missing', log: '' };
      try { info = await bridge.skinSamStatus(); } catch {}
      const label = { ready: '✓ 已安裝：配件會用它精準切出來', installing: '安裝中…（請看終端機視窗，裝好會自動更新）', missing: '還沒安裝：配件會用比對的方式切，邊緣可能不準' }[info.status];
      samRow.dataset.status = info.status;
      samRow.replaceChildren(...[
        h('div', { className: 'skin-sam-text' },
          h('strong', {}, '本機切割工具（SAM 2.1）'),
          h('small', {}, label),
          info.status === 'missing' && info.log ? h('pre', { className: 'skin-sam-log' }, info.log) : null,
        ),
        info.status === 'missing' ? h('button', { type: 'button', className: 'lab-mini', onClick: async () => {
          try { await bridge.skinSamInstall(); } catch (installError) { error = cleanError(installError?.message); paint(); return; }
          void paintSam(true);
        } }, info.log ? '重新安裝' : '一鍵安裝（免費，約 1～2 GB）') : null,
      ].filter(Boolean));
    }
    samRefresh = () => { if (box.isConnected) void paintSam(); };
    void paintSam();

    async function load() {
      try {
        [busy, draft, skin, desktop] = await Promise.all([bridge.skinBusy(spiritId), bridge.skinDraft(spiritId), bridge.skinGet(spiritId), bridge.skinDesktopGet()]);
      } catch (loadError) { error = cleanError(loadError?.message); }
      view = busy ? 'running' : skin ? 'ready' : draft ? 'confirm' : 'import';
      if (view === 'confirm') parts = structuredClone(draft.parts || []);
      paint();
    }
    let localRun = false; // 這個畫面自己發起的工作：結果由 run() 處理；不是的話（離開後再回來）收到結束訊號就重新讀取
    skinRefresh = (event) => {
      if (!box.isConnected) { skinRefresh = undefined; return; }
      if (event.stage === 'confirm' || event.stage === 'done' || event.stage === 'error') {
        if (!localRun) void load();
        return;
      }
      if (view === 'running') paint();
    };

    async function ensureModels() {
      if (models) return models;
      try { models = await bridge.skinModels(); } catch { models = { imageModels: [], visionModels: [], defaults: {} }; }
      return models;
    }

    function progressList() {
      const log = skinProgress.get(spiritId) || [];
      return h('ol', { className: 'skin-progress' }, ...log.filter((event) => event.stage !== 'error').map((event, index, list) => h('li', {
        className: index === list.length - 1 ? 'active' : 'done',
      }, `${event.label}${event.total ? `（${event.done}/${event.total}）` : ''}`)));
    }

    async function run(work) {
      error = '';
      view = 'running';
      localRun = true;
      paint();
      try {
        await work();
      } catch (runError) {
        error = cleanError(runError?.message);
        [draft, skin] = await Promise.all([bridge.skinDraft(spiritId).catch(() => null), bridge.skinGet(spiritId).catch(() => null)]);
        view = skin ? 'ready' : draft ? 'confirm' : 'import';
        if (view === 'confirm') parts = structuredClone(draft.parts || []);
      }
      localRun = false;
      paint();
    }

    function importView() {
      const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      const pick = async (file) => {
        if (!file) return;
        if (file.size > 20 * 1024 * 1024) { error = '設定圖太大了（上限 20 MB）。'; paint(); return; }
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('無法讀取這張圖片。'));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        sheet = { dataUrl, name: file.name };
        error = '';
        heroBox = [0, 0, 1000, 1000];
        heroNote = 'AI 正在找主角…';
        paint();
        // 請 AI 先框出主角當預設，使用者再拖動調整
        const asked = sheet;
        try {
          const found = await bridge.skinSuggestHero({ sheetDataUrl: dataUrl, visionModel: visionChoice || undefined });
          if (sheet !== asked) return;
          heroBox = found;
          heroNote = 'AI 框好了主角；不對的話可以拖動框框、拉右下角調整大小。';
        } catch (suggestError) {
          if (sheet !== asked) return;
          heroNote = `AI 沒找到主角（${cleanError(suggestError?.message).slice(0, 60)}），請自己拖動框框，框住主角和它的配件。`;
        }
        if (view === 'import') paint();
      };
      fileInput.addEventListener('change', () => { void pick(fileInput.files?.[0]); fileInput.value = ''; });
      const drop = h('button', { type: 'button', className: `skin-drop${sheet ? ' has-image' : ''}${sheet && masterMode === 'crop' ? ' compact' : ''}`, onClick: () => fileInput.click() },
        sheet && masterMode === 'redraw' ? h('img', { src: sheet.dataUrl, alt: '設定圖' }) : null,
        h('span', {}, sheet ? `${sheet.name}（點一下更換）` : '選擇設定圖，或把圖片拖進來'),
      );
      // 直接用設定圖的主角：在設定圖上框出主角（連同配件）
      const heroEditor = () => {
        const handle = h('i', { className: 'skin-box-handle', title: '拖動調整大小' });
        const frame = h('div', { className: 'skin-part kind-hero', title: '主角：拖動移動位置' }, h('span', {}, '主角'), handle);
        const stage = h('div', { className: 'skin-hero' }, h('img', { src: sheet.dataUrl, alt: '設定圖', draggable: false }), frame);
        placeBox(frame, heroBox);
        attachBoxDrag(stage, frame, handle, heroBox, placeBox);
        return stage;
      };
      const modeGroup = h('div', { className: 'lab-segmented', role: 'radiogroup' }, ...[['crop', '直接用設定圖的主角（最像設計稿）'], ['redraw', '請 AI 重畫一張正面圖']].map(([value, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(masterMode === value), onClick: () => { masterMode = value; paint(); },
      }, label)));
      drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('over'); void pick(event.dataTransfer?.files?.[0]); });
      const imageSelect = h('select', { onChange: (event) => { imageChoice = event.target.value; } }, h('option', { value: '' }, '讀取中…'));
      const visionSelect = h('select', { onChange: (event) => { visionChoice = event.target.value; } }, h('option', { value: '' }, '讀取中…'));
      void ensureModels().then(({ imageModels, visionModels, defaults }) => {
        imageSelect.replaceChildren(...(imageModels.length ? imageModels : ['']).map((id) => h('option', { value: id, selected: id === (imageChoice || defaults.image) }, id || '（沒有生圖模型）')));
        visionSelect.replaceChildren(...(visionModels.length ? visionModels : ['']).map((id) => h('option', { value: id, selected: id === (visionChoice || defaults.vision) }, id || '（沒有可看圖的模型）')));
      });
      const start = h('button', { type: 'button', className: 'gen-run', disabled: !sheet, onClick: () => void run(async () => {
        draft = await bridge.skinStart({ spiritId, sheetDataUrl: sheet.dataUrl, imageModel: imageSelect.value, visionModel: visionSelect.value, mode: masterMode, heroBox: [...heroBox] });
        parts = structuredClone(draft.parts || []);
        sheet = null;
        view = 'confirm';
      }) }, '開始製作');
      return [
        drop, fileInput,
        sheet ? h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '主圖從哪裡來'), modeGroup) : null,
        sheet && masterMode === 'crop' ? heroEditor() : null,
        sheet && masterMode === 'crop' && heroNote ? h('p', { className: 'lab-note' }, heroNote) : null,
        h('div', { className: 'lab-grid-2' },
          field('生圖模型（MixRoute）', imageSelect, '用來畫沒有配件的身體和表情；建議 gpt-image-1。'),
          field('找零件的模型', visionSelect, '要能看圖；找錯了下一步可以自己拖動修正。'),
        ),
        h('p', { className: 'lab-note' }, '「直接用設定圖的主角」會把你框的那塊裁下來、去背當主圖，配件和設計稿一模一樣；請框住主角和它身上、手上、旁邊漂浮的配件，不要框到標題文字。設定圖沒有清楚的主角圖時，再改用「請 AI 重畫」。整個製作約 3～5 分鐘，會呼叫 5 次生圖模型（沒有配件的身體 1 次、表情 4 次；AI 重畫主圖時再加 1 次）。配件由本機切割工具切出來，不花點數。'),
        h('div', { className: 'lab-row' }, start, draft ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = skin ? 'ready' : 'confirm'; parts = structuredClone(draft.parts || []); paint(); } }, '取消') : null),
      ];
    }

    function boxEditor() {
      const stage = h('div', { className: 'skin-boxes' }, h('img', { src: draft.masterDataUrl, alt: '正面主圖', draggable: false }));
      const toUnits = (event, rect) => [((event.clientX - rect.left) / rect.width) * 1000, ((event.clientY - rect.top) / rect.height) * 1000];
      const place = (element, [x0, y0, x1, y1]) => {
        element.style.left = `${x0 / 10}%`; element.style.top = `${y0 / 10}%`;
        element.style.width = `${(x1 - x0) / 10}%`; element.style.height = `${(y1 - y0) / 10}%`;
      };
      for (const part of parts) {
        const kind = SKIN_PARTS.find(([name]) => name === part.name)?.[2] || 'face';
        const handle = h('i', { className: 'skin-box-handle', title: '拖動調整大小' });
        const element = h('div', { className: `skin-part kind-${kind}`, title: `${nameOf(part.name, parts)}：拖動移動位置` }, h('span', {}, nameOf(part.name, parts)), handle);
        place(element, part.box);
        element.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          const rect = stage.getBoundingClientRect();
          const resizing = event.target === handle;
          const [sx, sy] = toUnits(event, rect);
          const original = [...part.box];
          element.setPointerCapture(event.pointerId);
          element.classList.add('dragging');
          const move = (moveEvent) => {
            const [x, y] = toUnits(moveEvent, rect);
            const dx = x - sx; const dy = y - sy;
            let [x0, y0, x1, y1] = original;
            if (resizing) { x1 = Math.max(x0 + 10, Math.min(1000, x1 + dx)); y1 = Math.max(y0 + 10, Math.min(1000, y1 + dy)); }
            else {
              const w = x1 - x0; const hgt = y1 - y0;
              x0 = Math.max(0, Math.min(1000 - w, x0 + dx)); y0 = Math.max(0, Math.min(1000 - hgt, y0 + dy));
              x1 = x0 + w; y1 = y0 + hgt;
            }
            part.box = [x0, y0, x1, y1].map(Math.round);
            place(element, part.box);
          };
          const end = () => { element.removeEventListener('pointermove', move); element.classList.remove('dragging'); };
          element.addEventListener('pointermove', move);
          element.addEventListener('pointerup', end, { once: true });
          element.addEventListener('pointercancel', end, { once: true });
        });
        stage.append(element);
      }
      return stage;
    }

    // 設定圖上「單獨畫的完整配件」：配件從這裡取（完整、沒被擋住），不是從主角圖剪
    function refEditor() {
      const accessories = parts.filter((part) => SKIN_ACCESSORIES.has(part.name));
      if (!accessories.length || !draft.sheetDataUrl) return null;
      const stage = h('div', { className: 'skin-hero skin-refs' }, h('img', { src: draft.sheetDataUrl, alt: '設定圖', draggable: false }));
      for (const part of accessories) {
        for (const [index, ref] of (part.refs || []).entries()) {
          const handle = h('i', { className: 'skin-box-handle', title: '拖動調整大小' });
          const remove = h('button', { type: 'button', className: 'skin-ref-remove', title: '刪掉這個框', 'aria-label': `刪掉${SKIN_PART_LABEL[part.name]}的原稿框` }, '×');
          remove.addEventListener('pointerdown', (event) => { event.stopPropagation(); event.preventDefault(); part.refs.splice(index, 1); delete part.place; delete part.maskRef; paint(); });
          const element = h('div', { className: 'skin-part kind-ref', title: `${SKIN_PART_LABEL[part.name]}的原稿：拖動移動位置` },
            h('span', {}, `${nameOf(part.name, parts)}${part.refs.length > 1 ? ` ${index + 1}` : ''}`), remove, handle);
          placeBox(element, ref);
          attachBoxDrag(stage, element, handle, ref, (target, box) => { placeBox(target, box); delete part.place; delete part.maskRef; });
          stage.append(element);
        }
      }
      const rows = accessories.map((part) => h('div', { className: 'skin-ref-row' },
        h('strong', {}, nameOf(part.name, parts)),
        h('small', {}, orderOf(part) === 'fused' ? '畫特製主體時一起畫，不用原稿' : part.refs?.length ? `${part.refs.length} 張原稿` : '沒有原稿：只能從主角圖切出看得到的部分，無法和設計稿比對'),
        h('select', { 'aria-label': `${nameOf(part.name, parts)}是獨立配件還是和角色融為一體`, onChange: (event) => { part.layer = event.target.value; delete part.place; paint(); } },
          ...SKIN_ORDERS.map(([value, label]) => h('option', { value, selected: orderOf(part) === value }, label))),
        (part.refs?.length || 0) < 3 ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { (part.refs ||= []).push([420, 420, 580, 580]); delete part.place; paint(); } }, '＋ 框一張原稿') : null,
      ));
      return h('div', { className: 'lab-field skin-ref-field' },
        h('span', { className: 'lab-field-label' }, '設定圖上的完整配件（配件從這裡取）'),
        h('small', {}, '先分類：在角色最上層、可以單獨拿開的（漂浮的鍵盤、單眼鏡、程式碼視窗）選「獨立配件」，會單獨一層、從設定圖上單獨畫的那一張做、和設計稿比對 95%；戴在身上、被身體擋住或繞著身體的（帽子、掛在脖子上的耳機、圍巾）選「和角色融為一體」，會和角色一起畫成「特製主體」，照物理邏輯戴好。獨立配件請框住設定圖上單獨畫的那一張（配件說明區、配件細節圖），框剛好包住配件、不要包到文字和卡片框線。'),
        stage,
        h('div', { className: 'skin-ref-rows' }, ...rows),
      );
    }

    function confirmView() {
      const has = new Set(parts.map((part) => part.name));
      const toggles = h('div', { className: 'skin-part-toggles' }, ...SKIN_PARTS.map(([name, label, kind]) => h('label', { className: `skin-toggle kind-${kind}` },
        h('input', { type: 'checkbox', checked: has.has(name), onChange: (event) => {
          if (event.target.checked) parts.push({ name, box: name.includes('eye') ? [name === 'left_eye' ? 330 : 530, 400, name === 'left_eye' ? 400 : 600, 480] : name === 'body' ? [250, 250, 750, 850] : [420, 420, 580, 580] });
          else parts = parts.filter((part) => part.name !== name);
          paint();
        } }),
        label)));
      const eyes = parts.filter((part) => part.name.endsWith('eye')).length;
      const build = h('button', { type: 'button', className: 'gen-run', disabled: !eyes, onClick: () => void run(async () => {
        skin = await bridge.skinBuild({ spiritId, parts });
        skinCache.set(spiritId, skin);
        refreshPreview();
        draft = (await bridge.skinDraft(spiritId).catch(() => null)) || { ...draft, parts: structuredClone(parts), built: true };
        if (!current.look.image) {
          try { update('look.image', await bridge.skinCard(spiritId)); } catch {}
        }
        view = 'ready';
      }) }, draft.built ? '用新的位置重新產生圖層' : '確認位置，開始產生圖層');
      return [
        h('p', { className: 'lab-note' }, 'AI 標的位置不一定準：請把每個框拖到對應的零件上（右下角可以調整大小）。框要剛好包住零件；沒有的配件取消勾選。'),
        h('div', { className: 'skin-confirm' }, boxEditor(), toggles),
        refEditor(),
        !eyes ? h('p', { className: 'kb-warning' }, '至少要框出一隻眼睛，才能做表情。') : null,
        h('div', { className: 'lab-row' }, build,
          h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = 'import'; paint(); } }, '重新匯入設定圖'),
          skin ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = 'ready'; paint(); } }, '取消') : null),
      ];
    }

    /** 和設計稿比對的結果：每個配件 95% 以上才算合格 */
    function checksList() {
      const checks = draft?.checks || {};
      const names = Object.keys(checks).filter((name) => SKIN_ACCESSORIES.has(name));
      if (!names.length && !checks.body) return null;
      const designThumb = (part, check) => {
        const ref = part?.refs?.[check?.ref ?? 0];
        if (!ref || !draft.sheetDataUrl) return h('div', { className: 'skin-thumb empty' }, '—');
        const [x0, y0, x1, y1] = ref;
        const image = h('img', { src: draft.sheetDataUrl, alt: '' });
        const frame = h('div', { className: 'skin-thumb', title: '設計稿' }, image);
        image.addEventListener('load', () => {
          const ratio = ((x1 - x0) * image.naturalWidth) / Math.max(1, (y1 - y0) * image.naturalHeight);
          frame.style.aspectRatio = String(ratio);
          image.style.width = `${100000 / (x1 - x0)}%`;
          image.style.left = `${(-x0 / (x1 - x0)) * 100}%`;
          image.style.top = `${(-y0 / (y1 - y0)) * 100}%`;
        });
        return frame;
      };
      const rows = names.map((name) => {
        const check = checks[name];
        const part = (draft.parts || []).find((item) => item.name === name);
        if (check.source === 'fused') {
          return h('div', { className: 'skin-check pass fused' },
            h('span', { className: 'skin-check-mark' }, '⛓'),
            h('strong', {}, nameOf(name, draft.parts)),
            designThumb(part, check), h('span', { className: 'skin-check-arrow' }, '→'),
            h('div', { className: 'skin-thumb empty' }, '主體'),
            h('span', { className: 'skin-check-score' }, '合進本體'),
            h('small', {}, check.note));
        }
        const status = check.score == null ? 'none' : check.pass ? 'pass' : 'fail';
        const ours = draft.refDataUrls?.[name] && check.source === 'sheet'
          ? h('div', { className: 'skin-thumb ours', title: '做出來的配件' }, h('img', { src: draft.refDataUrls[name], alt: '' }))
          : h('div', { className: 'skin-thumb empty' }, '—');
        return h('div', { className: `skin-check ${status}` },
          h('span', { className: 'skin-check-mark' }, status === 'pass' ? '✓' : status === 'fail' ? '✗' : '？'),
          h('strong', {}, nameOf(name, draft.parts)),
          designThumb(part, check), h('span', { className: 'skin-check-arrow' }, '→'), ours,
          h('span', { className: 'skin-check-score' }, check.score == null ? '無法比對' : `${(check.score * 100).toFixed(1)}%`),
          h('small', {}, check.score == null ? check.note
            : check.pass ? `完整 ${Math.round(check.coverage * 100)}%・多出來的 ${Math.round(check.stray * 100)}%`
              : `未達 95%：完整 ${Math.round(check.coverage * 100)}%、多出來的 ${Math.round(check.stray * 100)}%。請到「調整零件位置」把原稿框好再重做配件`),
        );
      });
      const body = checks.body;
      return h('div', { className: 'skin-checks' },
        h('span', { className: 'lab-field-label' }, '和設計稿比對（95% 以上才算合格）'),
        ...rows,
        body ? h('div', { className: `skin-check ${body.pass === true ? 'pass' : body.pass === false ? 'fail' : 'none'}` },
          h('span', { className: 'skin-check-mark' }, body.pass === true ? '✓' : body.pass === false ? '✗' : '？'),
          h('strong', {}, '特製主體'), h('small', {}, body.note)) : null,
        checks.fx ? h('div', { className: 'skin-check pass' }, h('span', { className: 'skin-check-mark' }, '✦'), h('strong', {}, '特效'), h('small', {}, checks.fx.note)) : null,
      );
    }

    const canAssemble = () => Object.keys(draft?.placements || {}).some((name) => draft.refDataUrls?.[name]);

    /**
     * 組裝台：本體上一件一件放配件，拖動移動、調角度和大小、左右翻轉、前後關係；
     * 遮罩筆刷：塗到的地方放到身體後面（例如耳機一邊耳罩在前、一邊繞到後面）。遮罩畫在配件自己身上，配件移動／旋轉時會跟著走。
     * 套用時只重新組配件（不用生圖）。
     */
    function assembleView() {
      const names = Object.keys(draft.placements || {}).filter((name) => draft.refDataUrls?.[name]);
      const places = structuredClone(draft.placements);
      const partOf = (name) => (draft.parts || []).find((part) => part.name === name);
      const orders = Object.fromEntries((draft.parts || []).filter((part) => SKIN_ACCESSORIES.has(part.name)).map((part) => [part.name, orderOf(part)]));
      let selected = names[0];
      let tool = 'move';
      let brush = 40; // 畫布單位（1024）
      const size = draft.workSize || 1024;
      const stage = h('div', { className: 'skin-assemble' });
      // 編輯中的配件：後半（在本體下面）、前半（最上面）、遮罩（紅色半透明，只在筆刷模式顯示）
      const back = h('img', { className: 'skin-assemble-part back', alt: '', draggable: false });
      const front = h('img', { className: 'skin-assemble-part', alt: '', draggable: false });
      const sizes = {};
      const masks = {}; // 配件 → canvas（白色不透明＝放到身體後面）
      const touched = new Set();
      const maskCanvas = (name) => {
        if (masks[name]) return masks[name];
        const natural = sizes[name];
        if (!natural) return null;
        const canvas = h('canvas', { className: 'skin-assemble-mask' });
        canvas.width = natural.width; canvas.height = natural.height;
        masks[name] = canvas;
        const saved = draft.refMasks?.[name];
        if (saved && partOf(name)?.maskRef === places[name]?.ref) {
          const image = new Image();
          image.addEventListener('load', () => { canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); applyMask(); });
          image.src = saved;
        }
        return canvas;
      };
      const transformOf = (t) => `translate(-50%, -50%) rotate(${t.angle}deg) scaleX(${t.flip ? -1 : 1})`;
      const placeEditing = () => {
        const t = places[selected];
        const natural = sizes[selected];
        if (!t || !natural) return;
        for (const element of [back, front, masks[selected]].filter(Boolean)) {
          element.style.left = `${(t.cx / size) * 100}%`;
          element.style.top = `${(t.cy / size) * 100}%`;
          element.style.width = `${((natural.width * t.scale) / size) * 100}%`;
          element.style.transform = transformOf(t);
        }
      };
      const hasMask = (name) => {
        const canvas = masks[name];
        if (!canvas) return false;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 16) if (data[i] > 0) return true;
        return false;
      };
      // 用遮罩切前後：前半＝沒塗到的地方、後半＝塗到的地方（CSS mask，配件怎麼轉都對得上）
      const applyMask = () => {
        const canvas = masks[selected];
        const painted = canvas && hasMask(selected);
        if (!painted) {
          back.hidden = true;
          for (const key of ['maskImage', 'webkitMaskImage', 'maskComposite', 'webkitMaskComposite']) front.style[key] = '';
          return;
        }
        const url = `url(${canvas.toDataURL('image/png')})`;
        back.hidden = false;
        back.style.maskImage = url; back.style.webkitMaskImage = url;
        back.style.maskSize = '100% 100%'; back.style.webkitMaskSize = '100% 100%';
        front.style.maskImage = `linear-gradient(#000, #000), ${url}`; front.style.webkitMaskImage = `linear-gradient(#000, #000), ${url}`;
        front.style.maskSize = '100% 100%'; front.style.webkitMaskSize = '100% 100%';
        front.style.maskComposite = 'exclude'; front.style.webkitMaskComposite = 'xor';
      };
      front.addEventListener('load', () => {
        sizes[selected] = { width: front.naturalWidth, height: front.naturalHeight };
        maskCanvas(selected);
        paintStage(false);
      });
      const paintStage = (reload = true) => {
        const layers = [...(skin?.manifest?.layers || [])].sort((a, b) => a.z - b.z);
        const hidden = new Set([layerIdOf(selected), `${layerIdOf(selected)}-back`]);
        const images = layers.filter((layer) => !hidden.has(layer.id)).map((layer) => h('img', {
          className: 'skin-assemble-layer', alt: '', draggable: false,
          src: layer.file === 'face-{state}.png' ? skin.faces?.idle : layer.file.includes('{state}') ? skin.stateLayers?.[layer.id]?.idle : skin.layers?.[layer.id],
        }));
        const mask = masks[selected];
        if (mask) mask.hidden = tool === 'move';
        stage.replaceChildren(back, ...images, front, ...(mask ? [mask] : []));
        stage.dataset.tool = tool;
        if (reload) { back.src = draft.refDataUrls[selected]; front.src = draft.refDataUrls[selected]; }
        placeEditing();
        applyMask();
      };
      // 畫面上的點 → 配件圖上的點（擺位的反算）
      const toPart = (event, rect) => {
        const t = places[selected]; const natural = sizes[selected];
        const px = ((event.clientX - rect.left) / rect.width) * size - t.cx;
        const py = ((event.clientY - rect.top) / rect.height) * size - t.cy;
        const rad = (t.angle * Math.PI) / 180;
        const u = (Math.cos(rad) * px + Math.sin(rad) * py) / t.scale;
        const v = (-Math.sin(rad) * px + Math.cos(rad) * py) / t.scale;
        return [natural.width / 2 + (t.flip ? -u : u), natural.height / 2 + v];
      };
      stage.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const rect = stage.getBoundingClientRect();
        const t = places[selected];
        stage.setPointerCapture(event.pointerId);
        let move;
        if (tool === 'move') {
          const start = [event.clientX, event.clientY, t.cx, t.cy];
          move = (moveEvent) => {
            t.cx = Math.round(start[2] + ((moveEvent.clientX - start[0]) / rect.width) * size);
            t.cy = Math.round(start[3] + ((moveEvent.clientY - start[1]) / rect.height) * size);
            t.manual = true;
            placeEditing();
          };
        } else {
          const canvas = maskCanvas(selected);
          if (!canvas) return;
          const context = canvas.getContext('2d');
          context.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
          context.strokeStyle = '#ff3b30'; context.fillStyle = '#ff3b30';
          context.lineCap = 'round'; context.lineJoin = 'round';
          context.lineWidth = brush / t.scale;
          let last = toPart(event, rect);
          context.beginPath(); context.arc(last[0], last[1], brush / t.scale / 2, 0, Math.PI * 2); context.fill();
          touched.add(selected);
          move = (moveEvent) => {
            const point = toPart(moveEvent, rect);
            context.beginPath(); context.moveTo(last[0], last[1]); context.lineTo(point[0], point[1]); context.stroke();
            last = point;
          };
        }
        const end = () => { stage.removeEventListener('pointermove', move); if (tool !== 'move') applyMask(); };
        stage.addEventListener('pointermove', move);
        stage.addEventListener('pointerup', end, { once: true });
        stage.addEventListener('pointercancel', end, { once: true });
      });
      // 快速：把畫面上左半／右半的部分放到身體後面（例如一邊耳罩在後面）
      const fillHalf = (side) => {
        const canvas = maskCanvas(selected);
        if (!canvas) return;
        const t = places[selected]; const natural = sizes[selected];
        const context = canvas.getContext('2d');
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const rad = (t.angle * Math.PI) / 180; const f = t.flip ? -1 : 1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const u = (x - natural.width / 2) * f * t.scale; const v = (y - natural.height / 2) * t.scale;
            const screenX = Math.cos(rad) * u - Math.sin(rad) * v; // 相對配件中心，在畫面上的左右
            if ((side === 'left' && screenX < 0) || (side === 'right' && screenX >= 0)) {
              const i = (y * canvas.width + x) * 4;
              image.data[i] = 255; image.data[i + 1] = 59; image.data[i + 2] = 48; image.data[i + 3] = 255;
            }
          }
        }
        context.putImageData(image, 0, 0);
        touched.add(selected);
        applyMask();
      };
      const clearMask = () => {
        const canvas = maskCanvas(selected);
        if (!canvas) return;
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        touched.add(selected);
        applyMask();
      };
      const controls = h('div', { className: 'skin-assemble-controls' });
      const paintControls = () => {
        const t = places[selected];
        const base = draft.placements[selected].scale;
        const angle = h('input', { type: 'range', min: -180, max: 180, step: 1, value: Math.round(t.angle), 'aria-label': '角度' });
        const angleLabel = h('small', {}, `${Math.round(t.angle)}°`);
        angle.addEventListener('input', () => { t.angle = Number(angle.value); t.manual = true; angleLabel.textContent = `${t.angle}°`; placeEditing(); });
        const scale = h('input', { type: 'range', min: -150, max: 150, step: 1, value: Math.round(Math.log2(t.scale / base) * 100), 'aria-label': '大小' });
        const scaleLabel = h('small', {}, `${Math.round((t.scale / base) * 100)}%`);
        scale.addEventListener('input', () => { t.scale = base * 2 ** (Number(scale.value) / 100); t.manual = true; scaleLabel.textContent = `${Math.round((t.scale / base) * 100)}%`; placeEditing(); });
        controls.replaceChildren(
          h('div', { className: 'lab-segmented', role: 'radiogroup' }, ...names.map((name) => h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(name === selected), onClick: () => { selected = name; paintStage(); paintControls(); },
          }, nameOf(name, draft.parts)))),
          h('label', { className: 'skin-assemble-row' }, h('span', {}, '角度'), angle, angleLabel),
          h('label', { className: 'skin-assemble-row' }, h('span', {}, '大小'), scale, scaleLabel),
          h('div', { className: 'lab-row' },
            h('button', { type: 'button', className: 'lab-mini', onClick: () => { t.flip = !t.flip; t.manual = true; placeEditing(); } }, '↔ 左右翻轉'),
            h('button', { type: 'button', className: 'lab-mini', onClick: () => { places[selected] = structuredClone(draft.placements[selected]); paintControls(); placeEditing(); } }, '還原'),
          ),
          h('label', { className: 'skin-assemble-row' }, h('span', {}, '前後'),
            h('select', { onChange: (event) => { orders[selected] = event.target.value; updateApply(); } }, ...SKIN_ORDERS.map(([value, label]) => h('option', { value, selected: orders[selected] === value }, label)))),
          fusedRows(),
          h('small', { className: 'lab-note' }, '在圖上拖動可以移動配件。戴在身上、怎麼擺都不自然的配件，「前後」改選「和角色融為一體」，會和角色一起畫進特製主體。'),
        );
      };
      // 和本體畫在一起的配件不在組裝台上擺（它畫在本體裡）；可以在這裡改回單獨的圖層
      function fusedRows() {
        const fusedNames = Object.keys(orders).filter((name) => orderOf(partOf(name)) === 'fused');
        if (!fusedNames.length) return null;
        return h('div', { className: 'skin-assemble-fused' },
          h('span', { className: 'lab-field-label' }, '和角色融為一體的配件（畫在特製主體上）'),
          ...fusedNames.map((name) => h('label', { className: 'skin-assemble-row' }, h('span', {}, nameOf(name, draft.parts)),
            h('select', { onChange: (event) => { orders[name] = event.target.value; updateApply(); } }, ...SKIN_ORDERS.map(([value, label]) => h('option', { value, selected: orders[name] === value }, label))))));
      }
      // 有配件要「合進本體」或「從本體拆出來」→ 要重畫本體與表情（需要生圖）
      const fusedChange = () => Object.keys(orders).some((name) => (orders[name] === 'fused') !== (orderOf(partOf(name)) === 'fused'));
      function updateApply() {
        apply.textContent = fusedChange() ? '套用（要重畫本體與表情，需要生圖，約 2～4 分鐘）' : '套用（重新組裝配件，不用生圖）';
      }
      paintStage();
      paintControls();
      const apply = h('button', { type: 'button', className: 'gen-run', onClick: () => void run(async () => {
        const nextParts = (draft.parts || []).map((part) => (orders[part.name] ? { ...part, layer: orders[part.name] } : part));
        const maskPayload = {};
        for (const name of touched) maskPayload[name] = hasMask(name) ? { ref: places[name].ref, dataUrl: masks[name].toDataURL('image/png') } : null;
        // 有遮罩的配件一定要固定擺位（遮罩畫在這個擺位的配件上）
        const manual = Object.fromEntries(Object.entries(places).filter(([name, t]) => t.manual || maskPayload[name] || (partOf(name)?.maskRef != null && !touched.has(name)) || orders[name] !== orderOf(partOf(name))));
        // 合進本體的配件不用擺位，也沒有遮罩
        for (const name of Object.keys(manual)) if (orders[name] === 'fused') delete manual[name];
        skin = await bridge.skinBuild({ spiritId, parts: nextParts, only: ['accessories'], placements: manual, masks: maskPayload });
        skinCache.set(spiritId, skin);
        draft = (await bridge.skinDraft(spiritId).catch(() => null)) || draft;
        refreshPreview();
        view = 'ready';
      }) }, '套用（重新組裝配件，不用生圖）');
      updateApply();
      return [
        h('p', { className: 'lab-note' }, '組裝台：特製主體上一件一件放上獨立的配件。選一個配件，拖動移動、調角度和大小，調好按「套用」。'),
        h('div', { className: 'skin-assemble-wrap' }, stage, controls),
        h('div', { className: 'lab-row' }, apply, h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = 'ready'; paint(); } }, '取消')),
      ];
    }

    function readyView() {
      const large = createSkinView();
      const small = createSkinView();
      for (const item of [large, small]) { item.setSkin(skin); item.setMood(mood); item.setExploded(exploded && item === large); }
      const moodButtons = h('div', { className: 'lab-segmented', role: 'radiogroup' }, ...SKIN_MOODS.map(([value, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(mood === value),
        onClick: () => { mood = value; large.setMood(value); small.setMood(value); for (const b of moodButtons.children) b.setAttribute('aria-checked', String(b.textContent === label)); },
      }, label)));
      const explodeButton = h('button', { type: 'button', className: 'lab-mini', onClick: () => {
        exploded = !exploded; large.setExploded(exploded); explodeButton.textContent = exploded ? '合起來' : '拆開圖層';
      } }, exploded ? '合起來' : '拆開圖層');
      const isDesktop = desktop === spiritId;
      return [
        h('div', { className: 'skin-preview' },
          h('div', { className: 'skin-stage large' }, large.element),
          h('div', { className: 'skin-preview-side' },
            h('div', { className: 'skin-stage small' }, small.element),
            h('small', {}, '桌面實際大小'),
          ),
        ),
        h('div', { className: 'lab-row skin-controls' }, moodButtons, explodeButton,
          canAssemble() ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = 'assemble'; paint(); } }, '🧩 組裝台：調整配件擺位') : null),
        checksList(),
        h('div', { className: 'skin-redo' },
          h('span', { className: 'lab-field-label' }, '不滿意可以單獨重做'),
          h('div', { className: 'lab-row' }, ...SKIN_REDO.filter(([key]) => key !== 'accessories' || (draft?.parts || []).some((part) => !['left_eye', 'right_eye', 'mouth'].includes(part.name))).map(([key, label]) => h('button', {
            type: 'button', className: 'lab-mini', onClick: () => void run(async () => { skin = await bridge.skinBuild({ spiritId, only: key === 'all' ? undefined : [key] }); skinCache.set(spiritId, skin); draft = (await bridge.skinDraft(spiritId).catch(() => null)) || draft; refreshPreview(); view = 'ready'; }),
          }, `↻ ${label}`))),
        ),
        h('div', { className: 'lab-field' },
          h('span', { className: 'lab-field-label' }, '卡片上顯示'),
          segmented('look.cardMode', current.look.cardMode === 'image' ? 'image' : 'skin', [['skin', '動態造型'], ['image', '靜態圖片']]),
          h('small', {}, '靜態圖片可以用下面的「用主圖當卡面」，或自己上傳。'),
        ),
        h('label', { className: 'skin-desktop' },
          h('input', { type: 'checkbox', checked: isDesktop, onChange: async (event) => {
            try { desktop = await bridge.skinDesktopSet(event.target.checked ? spiritId : ''); } catch (setError) { error = cleanError(setError?.message); }
            paint();
          } }),
          '平常也用牠當桌面小精靈（派其他精靈工作時，會換成那隻精靈）'),
        h('div', { className: 'lab-row' },
          h('button', { type: 'button', className: 'lab-mini', onClick: async () => { try { update('look.image', await bridge.skinCard(spiritId)); update('look.cardMode', 'image'); renderPanel(); } catch (cardError) { error = cleanError(cardError?.message); paint(); } } }, '用主圖當卡面'),
          draft ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { parts = structuredClone(draft.parts || []); view = 'confirm'; paint(); } }, '調整零件位置') : null,
          h('button', { type: 'button', className: 'lab-mini', onClick: () => { view = 'import'; paint(); } }, '重新匯入設定圖'),
          h('button', { type: 'button', className: 'lab-mini danger', onClick: async () => {
            if (Date.now() > removeArmed) { removeArmed = Date.now() + 4000; paint(); return; }
            try { await bridge.skinRemove(spiritId); skin = null; draft = null; view = 'import'; skinCache.set(spiritId, null); refreshPreview(); } catch (removeError) { error = cleanError(removeError?.message); }
            paint();
          } }, Date.now() < removeArmed ? '再按一次確認移除' : '移除造型'),
        ),
      ];
    }

    function paint() {
      const content = view === 'loading' ? [h('p', { className: 'lab-note' }, '讀取中…')]
        : view === 'running' ? [progressList(), h('p', { className: 'lab-note' }, '製作中，可以先離開這個畫面，做好會自動存起來。')]
          : view === 'confirm' && draft ? confirmView()
            : view === 'ready' && skin ? readyView()
              : view === 'assemble' && skin && draft && canAssemble() ? assembleView()
              : importView();
      box.replaceChildren(head, samRow, ...(error ? [h('p', { className: 'kb-warning' }, error)] : []), ...content.filter(Boolean));
    }
    paint();
    void load();
    return box;
  }

  function lookPanel() {
    const look = current.look;
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    const imageError = h('small', { className: 'lab-error' });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { imageError.textContent = '圖片太大了（上限 20 MB）。'; return; }
      try {
        update('look.image', await resizeImage(file));
        renderPanel();
      } catch (error) {
        imageError.textContent = error.message;
      }
    });
    const swatches = h('div', { className: 'lab-swatches', role: 'radiogroup' }, ...COLORS.map((color) => h('button', {
      type: 'button', role: 'radio', className: 'lab-swatch', dataset: { color: color.id }, title: color.label,
      'aria-checked': String(look.color === color.id), 'aria-label': color.label,
      onClick: () => { update('look.color', color.id); renderPanel(); },
    })));
    return [
      skinSection(),
      h('div', { className: 'lab-field' },
        h('span', { className: 'lab-field-label' }, '卡面圖片'),
        h('div', { className: 'lab-row' },
          h('button', { type: 'button', className: 'lab-mini', onClick: () => fileInput.click() }, look.image ? '更換圖片' : '上傳圖片'),
          look.image ? h('button', { type: 'button', className: 'lab-mini', onClick: () => { update('look.image', ''); renderPanel(); } }, '移除圖片') : null,
          fileInput,
        ),
        h('small', {}, '會自動裁成 3:4 的卡面；沒有圖片時顯示代表符號。'),
        imageError,
      ),
      h('div', { className: 'lab-grid-2' },
        field('代表符號', textInput('look.emoji', look.emoji, { maxLength: 4, className: 'lab-emoji-input' }), '可以用 emoji，例如 🈯 📊 🛠️'),
        h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '稀有度'),
          segmented('look.rarity', look.rarity, RARITIES.map((value) => [value, value])), h('small', {}, '只影響卡框的樣子')),
      ),
      h('div', { className: 'lab-field' }, h('span', { className: 'lab-field-label' }, '顏色'), swatches),
    ];
  }

  // ── 進出 ──
  async function goBack() {
    if (current) {
      await flushSave();
      if (section) { section = ''; renderDetail(); return; }
      renderBox();
      return;
    }
    await close();
  }

  async function open() {
    root.hidden = false;
    try { await bridge.labWindow('open'); } catch {}
    try { spirits = await bridge.spiritsList(); } catch { spirits = []; }
    renderBox();
    backButton.focus({ preventScroll: true });
  }

  async function close() {
    await flushSave();
    root.hidden = true;
    try { await bridge.labWindow('close'); } catch {}
    onClose();
  }

  return { open, close, isOpen: () => !root.hidden };
}
