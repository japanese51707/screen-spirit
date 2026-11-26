const bridge = window.screenSpiritDrawer;
const badge = document.querySelector('#badge');
document.querySelector('#handle').addEventListener('click', () => void bridge.toggle());
bridge.onBadge((on) => { badge.hidden = !on; });
