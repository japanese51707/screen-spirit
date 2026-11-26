const bridge = window.screenSpiritDrawer;
const pin = document.querySelector('#pin');
function render(on) {
  pin.setAttribute('aria-pressed', String(on));
  pin.title = on ? '已固定：點一下取消固定（左邊恢復全寬、自動收起）' : '固定：不自動收起，左邊的程式讓出位置';
}
pin.addEventListener('click', async () => render(Boolean(await bridge.togglePin())));
bridge.onPinState((on) => render(Boolean(on)));
