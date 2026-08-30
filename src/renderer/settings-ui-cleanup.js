(() => {
  function hideAdvancedSettings() {
    const settings = document.querySelector('#settings');
    if (!settings) return;

    for (const card of settings.querySelectorAll('.card')) {
      const title = String(card.querySelector('h3')?.textContent || '').trim();
      if (title === '发帖元素定位' || title === '选择器测试') {
        card.style.display = 'none';
        card.setAttribute('aria-hidden', 'true');
      }
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', hideAdvancedSettings, { once: true });
  } else {
    hideAdvancedSettings();
  }
})();
