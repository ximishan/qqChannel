(() => {
  const STYLE_ID = 'qqchannelUiFeedbackStyle';
  const HOST_ID = 'qqchannelToastHost';
  const MAX_TOASTS = 4;

  function ensureUi() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        #${HOST_ID}{
          position:fixed;
          top:86px;
          right:22px;
          z-index:2147483000;
          display:flex;
          flex-direction:column;
          gap:10px;
          width:min(420px,calc(100vw - 32px));
          pointer-events:none;
        }
        .qqchannel-toast{
          display:grid;
          grid-template-columns:28px minmax(0,1fr) 26px;
          gap:10px;
          align-items:start;
          padding:13px 14px;
          border:1px solid #dce5ef;
          border-radius:12px;
          background:rgba(255,255,255,.97);
          box-shadow:0 10px 30px rgba(15,23,42,.13);
          color:#1f2d3d;
          font-size:14px;
          line-height:1.55;
          pointer-events:auto;
          opacity:0;
          transform:translateY(-8px);
          transition:opacity .18s ease,transform .18s ease;
        }
        .qqchannel-toast.show{opacity:1;transform:translateY(0)}
        .qqchannel-toast.hide{opacity:0;transform:translateY(-8px)}
        .qqchannel-toast-icon{
          width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
          font-size:14px;font-weight:700;background:#eef6ff;color:#1686ff;
        }
        .qqchannel-toast.success .qqchannel-toast-icon{background:#eaf9f1;color:#13a463}
        .qqchannel-toast.error .qqchannel-toast-icon{background:#fff0f0;color:#e24a4a}
        .qqchannel-toast.warning .qqchannel-toast-icon{background:#fff7e8;color:#d48900}
        .qqchannel-toast-message{min-width:0;white-space:pre-wrap;word-break:break-word;padding-top:2px}
        .qqchannel-toast-close{
          width:26px;height:26px;border:0!important;background:transparent!important;
          padding:0!important;color:#94a3b8!important;font-size:19px;line-height:26px;
          cursor:pointer;border-radius:6px!important;box-shadow:none!important;
        }
        .qqchannel-toast-close:hover{background:#f1f5f9!important;color:#475569!important}
        @media(max-width:720px){#${HOST_ID}{top:72px;right:16px;left:16px;width:auto}}
      `;
      document.head.appendChild(style);
    }

    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function classify(message, explicitType) {
    if (explicitType) return explicitType;
    const text = String(message || '');
    if (/失败|错误|异常|无效|不存在|不能|无法|请先|必须|至少|请选择|超时/i.test(text)) return 'error';
    if (/警告|注意|跳过|未检测|未登录/i.test(text)) return 'warning';
    if (/成功|完成|已保存|已删除|已创建|已更新|已同步|登录成功/i.test(text)) return 'success';
    return 'info';
  }

  function iconFor(type) {
    if (type === 'success') return '✓';
    if (type === 'error') return '!';
    if (type === 'warning') return '!';
    return 'i';
  }

  function removeToast(toast) {
    if (!toast || toast.dataset.removing === '1') return;
    toast.dataset.removing = '1';
    toast.classList.add('hide');
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 190);
  }

  function showToast(message, options = {}) {
    const text = String(message ?? '').trim();
    if (!text) return;
    const host = ensureUi();
    const type = classify(text, options.type);

    while (host.children.length >= MAX_TOASTS) {
      host.firstElementChild?.remove();
    }

    const toast = document.createElement('div');
    toast.className = `qqchannel-toast ${type}`;

    const icon = document.createElement('div');
    icon.className = 'qqchannel-toast-icon';
    icon.textContent = iconFor(type);

    const body = document.createElement('div');
    body.className = 'qqchannel-toast-message';
    body.textContent = text;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'qqchannel-toast-close';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.addEventListener('click', () => removeToast(toast));

    toast.append(icon, body, close);
    host.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const duration = Number(options.duration) || (type === 'error' ? 5200 : 3200);
    if (duration > 0) setTimeout(() => removeToast(toast), duration);
  }

  window.qqToast = (message, options) => showToast(message, options || {});

  // 统一接管旧代码中的 alert：保留原来的业务逻辑，但不再弹系统模态框。
  // confirm 仍只出现一次用于真正需要用户确认的危险/批量操作。
  window.alert = (message) => {
    showToast(message);
  };

  ensureUi();
})();
