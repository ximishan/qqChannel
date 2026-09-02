(() => {
  const $ = selector => document.querySelector(selector);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let pollToken = 0;

  function setStatus(text, tone = 'pending') {
    const el = $('#loginStatus');
    if (!el) return;
    el.textContent = text;
    if (tone === 'ok') {
      el.style.background = '#edf9f2';
      el.style.color = '#17a663';
    } else if (tone === 'error') {
      el.style.background = '#fff1f1';
      el.style.color = '#e55252';
    } else {
      el.style.background = '#fff7e6';
      el.style.color = '#c47b00';
    }
  }

  function currentInstanceId() {
    const fixed = Number(window.api.fixedInstanceId?.() || 0);
    if (fixed > 0) return fixed;
    return Number($('#instanceSelect')?.value || 0);
  }

  async function showBrowser(instanceId) {
    const browserTab = $('.tab[data-tab="browser"]');
    if (browserTab && !browserTab.classList.contains('active')) browserTab.click();
    await sleep(80);
    const host = $('#embeddedBrowserHost');
    if (!host || !window.api.setBrowserView) return;
    const rect = host.getBoundingClientRect();
    await window.api.setBrowserView({
      instanceId,
      visible: true,
      bounds: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      }
    });
  }

  async function pollLogin(instanceId, token) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && token === pollToken) {
      await sleep(1500);
      if (token !== pollToken) return;
      try {
        const status = await window.api.pollPublisherLogin(instanceId);
        if (status?.loggedIn) {
          setStatus(`已登录：${status.name || 'QQ账号'}`, 'ok');
          return;
        }
      } catch (_) {}
    }
    if (token === pollToken) setStatus('登录状态：二维码等待扫码或已过期，请重新点击登录', 'pending');
  }

  async function startQrLogin(button) {
    const instanceId = currentInstanceId();
    if (!instanceId) return setStatus('登录状态：请先选择实例', 'error');

    pollToken += 1;
    const token = pollToken;
    button.disabled = true;
    button.textContent = '正在打开二维码...';
    setStatus('登录状态：正在打开 QQ 二维码...', 'pending');

    try {
      await showBrowser(instanceId);
      const result = await window.api.openLogin(instanceId);
      await showBrowser(instanceId);

      if (result?.loggedIn) {
        setStatus(`已登录：${result.name || 'QQ账号'}`, 'ok');
        return;
      }

      if (result?.qrConfirmed) {
        setStatus('登录状态：请使用手机 QQ 扫描二维码', 'pending');
      } else if (result?.qrTriggered) {
        setStatus('登录状态：QQ 登录框已打开，二维码正在加载...', 'pending');
      } else {
        setStatus('登录状态：未能自动弹出二维码，请再次点击登录', 'error');
        return;
      }

      pollLogin(instanceId, token).catch(() => {});
    } catch (error) {
      setStatus(`登录状态：打开二维码失败 - ${String(error?.message || error)}`, 'error');
    } finally {
      button.disabled = false;
      button.textContent = '🔑 登录QQ';
    }
  }

  function install() {
    const oldButton = $('#btnLogin');
    if (!oldButton || oldButton.dataset.qrLoginInstalled === '1') return;
    const button = oldButton.cloneNode(true);
    button.dataset.qrLoginInstalled = '1';
    oldButton.replaceWith(button);
    button.addEventListener('click', () => startQrLogin(button));
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
