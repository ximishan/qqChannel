(() => {
  let remoteGuilds = [];
  let syncLoading = false;
  let autoLoadedForLogin = false;
  let lastSyncAt = 0;
  let deferredSyncTimer = null;

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function injectStyles() {
    if (document.querySelector('#qqChannelSyncStyles')) return;
    const style = document.createElement('style');
    style.id = 'qqChannelSyncStyles';
    style.textContent = `
      #qqChannelSyncCard{margin-bottom:16px}
      #qqChannelSyncCard .sync-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
      #qqChannelSyncCard .sync-head h3{margin:0}
      #qqChannelSyncCard .sync-actions{display:flex;gap:8px;align-items:center}
      #qqChannelSyncCard .sync-note{margin:8px 0 12px;color:#7d8b9b;font-size:13px}
      #qqChannelRemoteList{border:1px solid #e7edf4;border-radius:9px;overflow:auto;max-height:420px;background:#fff}
      .qq-remote-row{display:grid;grid-template-columns:minmax(200px,1fr) 160px 110px;gap:12px;align-items:center;padding:11px 12px;border-bottom:1px solid #edf1f6}
      .qq-remote-row:last-child{border-bottom:0}
      .qq-remote-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qq-remote-number{color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qq-role{display:inline-flex;width:max-content;padding:3px 8px;border-radius:999px;font-size:12px;background:#edf9f2;color:#17a663}
      .qq-role.joined{background:#f1f5f9;color:#7d8b9b}
      .qq-remote-row.disabled{opacity:.68;background:#fafbfc}
      #qqChannelSyncResult{margin-top:10px;white-space:pre-wrap}
      @media(max-width:1050px){.qq-remote-row{grid-template-columns:minmax(160px,1fr) 100px}.qq-remote-number{display:none}}
    `;
    document.head.appendChild(style);
  }

  function renderRemoteGuilds() {
    const host = document.querySelector('#qqChannelRemoteList');
    if (!host) return;
    if (!remoteGuilds.length) {
      host.innerHTML = '<div class="hint" style="padding:16px">当前登录账号没有读取到频道。</div>';
      return;
    }
    host.innerHTML = remoteGuilds.map(item => `
      <div class="qq-remote-row ${item.selectable ? '' : 'disabled'}">
        <span class="qq-remote-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="qq-remote-number">${escapeHtml(item.guildNumber || '无频道号')}</span>
        <span class="qq-role ${item.source === 'joined' ? 'joined' : ''}">${escapeHtml(item.sourceLabel || '当前实例')}</span>
      </div>
    `).join('');
  }

  async function refreshLocalChannelList() {
    const button = document.querySelector('#btnRefreshChannels');
    if (button) {
      button.click();
      return;
    }
    if (typeof window.loadChannels === 'function') await window.loadChannels();
  }

  async function publishingBusy(instanceId) {
    try {
      const state = await window.api.schedulerState(instanceId);
      return Boolean(state?.currentTaskId) || ['running', 'waiting', 'paused'].includes(String(state?.status || ''));
    } catch (_) {
      return false;
    }
  }

  function deferSync(delay = 5000) {
    if (deferredSyncTimer) return;
    deferredSyncTimer = setTimeout(() => {
      deferredSyncTimer = null;
      syncRemoteGuilds({ silent: true, force: true }).catch(error => console.error(error));
    }, delay);
  }

  async function syncRemoteGuilds({ silent = false, force = false } = {}) {
    if (syncLoading) return null;
    const now = Date.now();
    if (!force && now - lastSyncAt < 5000) return null;

    const instanceId = Number(window.QQCHANNEL_FIXED_INSTANCE_ID || 0);
    if (!instanceId) return null;

    if (await publishingBusy(instanceId)) {
      const result = document.querySelector('#qqChannelSyncResult');
      if (result && !silent) {
        result.style.color = '#c47b00';
        result.textContent = '当前实例正在发布任务，频道同步已延后，避免干扰发帖页面。';
      }
      deferSync(5000);
      return { instanceId, deferred: true };
    }

    syncLoading = true;
    const button = document.querySelector('#btnSyncQQChannels');
    const result = document.querySelector('#qqChannelSyncResult');
    if (button) {
      button.disabled = true;
      button.textContent = '正在同步...';
    }
    if (result && !silent) {
      result.style.color = '#64748b';
      result.textContent = '正在从当前 QQ 账号读取频道并自动更新本地频道管理...';
    }

    try {
      remoteGuilds = await window.api.listRemoteChannels(instanceId);
      renderRemoteGuilds();

      const publishable = remoteGuilds.filter(item => item.selectable);
      let imported = { created: 0, updated: 0, skipped: 0 };
      if (publishable.length) {
        imported = await window.api.importRemoteChannels({
          instanceId,
          channels: publishable.map(item => ({
            guildId: item.guildId,
            guildNumber: item.guildNumber,
            name: item.name,
            url: item.url,
            source: item.source,
            ownershipStatus: item.ownershipStatus,
            ownerTinyId: item.ownerTinyId
          }))
        });
        await refreshLocalChannelList();
      }

      lastSyncAt = Date.now();
      if (result) {
        result.style.color = '#17a663';
        const excluded = remoteGuilds.filter(item => item.ownershipStatus === 'not_owned').length;
        result.textContent = publishable.length
          ? `自动同步完成：可发布 ${publishable.length} 个频道${excluded ? `，已识别并排除 ${excluded} 个非频道主频道` : ''}；新增 ${Number(imported.created || 0)} 个，更新 ${Number(imported.updated || 0)} 个，跳过 ${Number(imported.skipped || 0)} 个。`
          : (excluded ? `自动同步完成：已识别 ${excluded} 个非频道主频道，当前没有自己的可发布频道。` : '自动同步完成：当前账号没有检测到可发布频道。');
      }
      return { instanceId, detected: publishable.length, ...imported };
    } catch (error) {
      if (result) {
        result.style.color = '#e55252';
        result.textContent = `自动同步失败：${String(error?.message || error)}`;
      }
      if (!silent) console.error(error);
      return null;
    } finally {
      syncLoading = false;
      if (button) {
        button.disabled = false;
        button.textContent = '重新同步';
      }
    }
  }

  function mountSyncUi() {
    if (!Number(window.QQCHANNEL_FIXED_INSTANCE_ID || 0)) return;

    const panel = document.querySelector('#channels');
    const split = panel?.querySelector('.split');
    if (!panel || !split || document.querySelector('#qqChannelSyncCard')) return;

    injectStyles();
    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'qqChannelSyncCard';
    card.innerHTML = `
      <div class="sync-head">
        <div>
          <h3>QQ 频道自动同步</h3>
          <div class="sync-note">当前实例登录成功后会自动读取该 QQ 账号的频道，并直接新增或更新到本地频道管理，无需手动勾选或导入。</div>
        </div>
        <div class="sync-actions">
          <button type="button" id="btnSyncQQChannels">重新同步</button>
        </div>
      </div>
      <div id="qqChannelRemoteList"><div class="hint" style="padding:16px">等待当前实例完成 QQ 登录后自动同步...</div></div>
      <div id="qqChannelSyncResult" class="result"></div>
    `;
    panel.insertBefore(card, split);

    document.querySelector('#btnSyncQQChannels')?.addEventListener('click', () => {
      syncRemoteGuilds({ force: true }).catch(error => console.error(error));
    });

    const loginStatus = document.querySelector('#loginStatus');
    if (loginStatus) {
      const tryAutoLoad = () => {
        const loggedIn = /^已登录/.test(loginStatus.textContent || '');
        if (loggedIn && !autoLoadedForLogin) {
          autoLoadedForLogin = true;
          syncRemoteGuilds({ silent: true, force: true }).catch(error => console.error(error));
        }
        if (!loggedIn) autoLoadedForLogin = false;
      };
      new MutationObserver(tryAutoLoad).observe(loginStatus, { childList: true, characterData: true, subtree: true });
      setTimeout(tryAutoLoad, 500);
    }

    document.querySelector('.tab[data-tab="channels"]')?.addEventListener('click', () => {
      const loggedIn = /^已登录/.test(document.querySelector('#loginStatus')?.textContent || '');
      if (loggedIn) syncRemoteGuilds({ silent: true }).catch(error => console.error(error));
    });

    window.api.onPublishUpdate?.(data => {
      if (Number(data?.instanceId || 0) !== Number(window.QQCHANNEL_FIXED_INSTANCE_ID || 0)) return;
      if (data?.type === 'task-finished') deferSync(1200);
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(mountSyncUi, 0), { once: true });
  } else {
    setTimeout(mountSyncUi, 0);
  }
})();