const bridge = window.screenSpiritDrawer;
const pin = document.querySelector('#pin');
const pinLabel = document.querySelector('#pin-label');
const appName = document.querySelector('#app-name');

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => void bridge.barAction(button.dataset.action));
});

bridge.onBarState(({ pinned, appName: name }) => {
  pin.setAttribute('aria-pressed', String(Boolean(pinned)));
  pinLabel.textContent = pinned ? '已固定' : '固定';
  pin.title = pinned ? '已固定：點一下取消（左邊恢復全寬、滑鼠離開會自動收起）' : '固定：不自動收起，左邊的程式讓出位置';
  appName.textContent = name || '';
});
void bridge.barReady();
