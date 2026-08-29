(() => {
  const $ = selector => document.querySelector(selector);

  function hasWorkspace() {
    return Boolean($('#instanceSelect')?.options?.length);
  }

  function keepLoginAvailable() {
    if (hasWorkspace()) return;
    const login = $('#btnLogin');
    const check = $('#btnCheckLogin');
    if (login) login.disabled = false;
    if (check) check.disabled = false;
  }

  function setStatus(text, type = '') {
    const status = $('#loginStatus');
    if (!status) return;
    status.textContent = text;
    if (type === 'good') {
      status.style.background = '#edf9f2';
      status.style.color = '#17a663';
    } else if (type === 'warn') {
      status.style.background = '#fff7e6';
      status.style.color = '#c47b00';
    } else if (type === 'bad') {
      status.style.background = '#fff1f1';
      status.style.color = '#e55252';
    }
  }

  function normalizeLoginStatusText() {
    const status = $('#loginStatus');
    if (!status) return;
    const current = String(status.textContent || '').trim();
    if (/^(?:登录状态：)?已登录(?:[：·\s].*)?$/.test(current) && current !== '登录状态：已登录') {
      status.textContent = '登录状态：已登录';
    }
  }

  function showQr(result = {}) {
    const qr = $('#publisherLoginQr');
    if (qr) {
      qr.src = result.qrDataUrl || '';
      qr.classList.toggle('hidden', !result.qrDataUrl);
    }
    const link = $('#publisherLoginLink');
    if (link) {
      link.href = result.verificationUri || '#';
      link.classList.toggle('hidden', !result.verificationUri);
    }
    const message = $('#publisherLoginMessage');
    if (message) {
      message.textContent = result.qrDataUrl
        ? '请使用手机 QQ 扫码，完成后点击“我已完成扫码”。'
        : '二维码未能显示，请打开授权链接完成登录。';
    }
    $('#publisherLoginDialog')?.showModal();
  }

  async function reloadForBoundAccount() {
    setStatus('登录状态：已登录', 'good');
    // 登录成功时 account_id 已在主进程绑定；刷新页面，让频道分组/频道/任务全部切到该账号工作区。
    window.location.reload();
  }

  $('#btnLogin')?.addEventListener('click', async event => {
    if (hasWorkspace()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const button = $('#btnLogin');
    if (button) button.disabled = true;
    setStatus('登录状态：正在准备二维码...', 'warn');
    try {
      const result = await window.api.openLogin(null);
      if (result?.alreadyLoggedIn || result?.loggedIn || result?.valid) {
        await reloadForBoundAccount();
        return;
      }
      showQr(result);
      setStatus('登录状态：等待扫码授权', 'warn');
    } catch (error) {
      setStatus('登录状态：二维码获取失败', 'bad');
      alert(String(error?.message || error));
    } finally {
      if (button) button.disabled = false;
    }
  }, true);

  $('#btnCheckLogin')?.addEventListener('click', async event => {
    if (hasWorkspace()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setStatus('登录状态：检测中...', 'warn');
    try {
      const result = await window.api.getLoginStatus(null);
      if (result?.loggedIn) {
        await reloadForBoundAccount();
      } else {
        setStatus('登录状态：未登录/已失效', 'bad');
        alert('未检测到登录状态，请点击“登录QQ”扫码登录');
      }
    } catch (error) {
      setStatus('登录状态：检测失败', 'warn');
      alert(String(error?.message || error));
    }
  }, true);

  $('#btnPollPublisherLogin')?.addEventListener('click', async event => {
    if (hasWorkspace()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const button = $('#btnPollPublisherLogin');
    if (button) button.disabled = true;
    const message = $('#publisherLoginMessage');
    if (message) message.textContent = '正在确认授权并绑定本地账号ID...';
    try {
      const result = await window.api.pollPublisherLogin();
      if (!result?.loggedIn) throw new Error(result?.message || '尚未完成扫码授权');
      $('#publisherLoginDialog')?.close();
      await reloadForBoundAccount();
    } catch (error) {
      if (message) message.textContent = `授权未完成：${String(error?.message || error)}`;
    } finally {
      if (button) button.disabled = false;
    }
  }, true);

  const select = $('#instanceSelect');
  if (select) new MutationObserver(() => {
    keepLoginAvailable();
    normalizeLoginStatusText();
  }).observe(select, { childList: true, subtree: true });

  const status = $('#loginStatus');
  if (status) new MutationObserver(() => normalizeLoginStatusText()).observe(status, { childList: true, characterData: true, subtree: true });

  keepLoginAvailable();
  normalizeLoginStatusText();
  setTimeout(keepLoginAvailable, 100);
  setTimeout(keepLoginAvailable, 500);
  setTimeout(normalizeLoginStatusText, 500);
})();
