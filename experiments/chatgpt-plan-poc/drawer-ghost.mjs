// 替身動畫：AI 被其他程式蓋住時，用它的截圖在最上層播放收起動畫（和真視窗同一條指數曲線）
const bridge = window.screenSpiritDrawer;
const ghost = document.querySelector('#ghost');
bridge.onGhostPlay(async ({ dataUrl, width, height, travel, ms, easing }) => {
  ghost.getAnimations().forEach((animation) => animation.cancel());
  ghost.style.transform = 'translateX(0)';
  ghost.style.width = `${width}px`;
  ghost.style.height = `${height}px`;
  ghost.src = dataUrl;
  try { await ghost.decode(); } catch {}
  await bridge.ghostReady(); // 主程式這時把替身顯示出來、並把真正的視窗移走
  const animation = ghost.animate(
    [{ transform: 'translateX(0)' }, { transform: `translateX(${travel}px)` }],
    { duration: ms, easing, fill: 'forwards' },
  );
  try { await animation.finished; } catch {}
  ghost.removeAttribute('src');
  await bridge.ghostDone();
});
