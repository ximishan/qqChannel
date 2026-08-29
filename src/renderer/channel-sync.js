(() => {
  let remoteGuilds = [];
  let syncLoading = false;
  let autoLoadedForLogin = false;

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
      .qq-remote-row{display:grid;grid-template-columns:32px minmax(180px,1fr) 150px 100px minmax(150px,auto);gap:12px;align-items:center;padding:11px 12px;border-bottom:1px solid #edf1f6}
      .qq-remote-row:last-child{border-bottom:0}
      .qq-remote-row input{width:16px!important;height:16px;margin:0;padding:0}
      .qq-remote-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qq-remote-number{color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .qq-role{display:inline-flex;width:max-content;padding:3px 8px;border-radius:999px;font-size:12px;background:#edf9f2;color:#17a663}
      .qq-role.joined{background:#f1f5f9;color:#7d8b9b}
      .qq-remote-row.disabled{opacity:.68;background:#fafbfc}
      #qqChannelSyncResult{margin-top:10px;white-space:pre-wrap}
      #qqChannelSyncCard .sync-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}
      #qqChannelSyncCard .sync-footer .hint{margin:0}
      @media(max-width:1050px){.qq-remote-row{grid-template-columns:30px minmax(150px,1fr) 100px minmax(130px,auto)}.qq-remote-number{display:none}}
    `;
    document.head.appendChild(style);
  }

  function renderRemoteGuilds() {
    const host = document.querySelector('#qqChannelRemoteList');
    if (!host) return;
    if (!remoteGuilds.length) {
      host.innerHTML = '<div class="hint" style="padding:16px">当前授权账号没有获取到频道。</div>';
      return;
    }
    host.innerHTML = remoteGuilds.map(item => `
      <label class="qq-remote-row ${item.selectable ? '' : 'disabled'}">
        <input class="qq-remote-check" type="checkbox" value="${escapeHtml(item.guildId)}" ${item.selectable ? 'checked' : 'disabled'}>
        <span class="qq-remote-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="qq-remote-number">${escapeHtml(item.guildNumber || '无频道号')}</span>
        <span class="qq-role ${item.source === 'joined' ? 'joined' : ''}">${escapeHtml(item.sourceLabel)}</span>
      </label>
    `).join('');
  }

  function selectedGuilds() {
    const ids = new Set([...document.querySelectorAll('.qq-remote-check:checked')].map(input => input.value));
    return remoteGuilds.filter(item => ids.has(item.guildId));
  }

  async function syncRemoteGuilds({ silent = false } = {}) {
    if (syncLoading) return;
    syncLoading = true;
    const button = document.querySelector('#btnSyncQQChannels');
    const result = document.querySelector('#qqChannelSyncResult');
    if (button) {
      button.disabled = true;
      button.textContent = '正在同步...';
    }
    if (result && !silent) result.textContent = '正在从当前 QQ 授权账号拉取频道...';
    try {
      const instanceId = Number(document.querySelector('#channelInstanceSelect')?.value || 0);
      if (!instanceId) throw new Error('请先选择账号实例');
      remoteGuilds = await window.api.listRemoteChannels(instanceId);
      renderRemoteGuilds();
      const publishable = remoteGuilds.filter(item => item.selectable).length;
      if (result) {
        result.style.color = '#17a663';
        result.textContent = `同步完成：当前实例检测到 ${publishable} 个频道。`;
      }
    } catch (error) {
      if (result) {
        result.style.color = '#e55252';
        result.textContent = `同步失败：${String(error?.message || error)}`;
      }
      if (!silent) console.error(error);
    } finally {
      syncLoading = false;
      if (button) {
        button.disabled = false;
        button.textContent = '同步我的频道';
      }
    }
  }

  async function importSelectedGuilds() {
    const selected = selectedGuilds();
    if (!selected.length) return alert('请至少选择一个可发布频道');
    const groupSelect = document.querySelector('#channelInstanceSelect');
    const instanceId = Number(groupSelect?.value || 0);
    if (!instanceId) return alert('请先选择目标频道分组');
    const groupName = groupSelect?.selectedOptions?.[0]?.textContent || '当前实例';
    if (!confirm(`将 ${selected.length} 个频道绑定到账号实例“${groupName}”。\n\n当前实例中已存在的频道只更新信息，不会重复创建。是否继续？`)) return;

    const button = document.querySelector('#btnImportQQChannels');
    const result = document.querySelector('#qqChannelSyncResult');
    if (button) {
      button.disabled = true;
      button.textContent = '正在导入...';
    }
    try {
      const response = await window.api.importRemoteChannels({
        instanceId,
        channels: selected.map(item => ({ guildId: item.guildId, guildNumber: item.guildNumber, name: item.name, url: item.url, source: item.source }))
      });
      if (result) {
        result.style.color = '#17a663';
        result.textContent = `导入完成：新增 ${response.created} 个，更新 ${response.updated} 个，跳过 ${response.skipped} 个。`;
      }
      document.querySelector('#btnRefreshChannels')?.click();
    } catch (error) {
      if (result) {
        result.style.color = '#e55252';
        result.textContent = `导入失败：${String(error?.message || error)}`;
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '导入选中频道';
      }
    }
  }

  function mountSyncUi() {
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
          <h3>从 QQ 自动同步频道</h3>
          <div class="sync-note">先选择实例并完成该实例的 QQ 登录，再从内置浏览器页面识别频道。</div>
        </div>
        <div class="sync-actions">
          <button type="button" id="btnToggleManualChannel">手动添加（备用）</button>
          <button type="button" class="primary" id="btnSyncQQChannels">同步我的频道</button>
        </div>
      </div>
      <div id="qqChannelRemoteList"><div class="hint" style="padding:16px">登录 QQ 后会自动尝试拉取频道，也可以点击“同步我的频道”。</div></div>
      <div class="sync-footer">
        <span class="hint">识别结果只属于当前账号实例；勾选后导入到当前实例。</span>
        <div class="sync-actions">
          <button type="button" id="btnSelectPublishableChannels">全选可发布频道</button>
          <button type="button" class="primary" id="btnImportQQChannels">导入选中频道</button>
        </div>
      </div>
      <div id="qqChannelSyncResult" class="result"></div>
    `;
    panel.insertBefore(card, split);

    const manualCard = split.querySelector('.card:first-child');
    if (manualCard) manualCard.style.display = 'none';

    document.querySelector('#btnSyncQQChannels')?.addEventListener('click', () => syncRemoteGuilds());
    document.querySelector('#btnImportQQChannels')?.addEventListener('click', () => importSelectedGuilds());
    document.querySelector('#btnSelectPublishableChannels')?.addEventListener('click', () => {
      document.querySelectorAll('.qq-remote-check:not(:disabled)').forEach(input => { input.checked = true; });
    });
    document.querySelector('#btnToggleManualChannel')?.addEventListener('click', event => {
      if (!manualCard) return;
      const hidden = manualCard.style.display === 'none';
      manualCard.style.display = hidden ? '' : 'none';
      event.currentTarget.textContent = hidden ? '收起手动添加' : '手动添加（备用）';
    });

    const loginStatus = document.querySelector('#loginStatus');
    if (loginStatus) {
      const tryAutoLoad = () => {
        const loggedIn = /^已登录/.test(loginStatus.textContent || '');
        if (loggedIn && !autoLoadedForLogin) {
          autoLoadedForLogin = true;
          syncRemoteGuilds({ silent: true });
        }
        if (!loggedIn) autoLoadedForLogin = false;
      };
      new MutationObserver(tryAutoLoad).observe(loginStatus, { childList: true, characterData: true, subtree: true });
      setTimeout(tryAutoLoad, 500);
    }
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => setTimeout(mountSyncUi, 0), { once: true });
  else setTimeout(mountSyncUi, 0);
})();
