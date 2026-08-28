(() => {
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  let assignments = [];
  let groups = [];

  async function loadData() {
    [assignments, groups] = await Promise.all([
      window.api.listChannelAssignments(),
      window.api.listInstances()
    ]);
  }

  function groupOptions(currentId) {
    return groups.map(group => `<option value="${group.id}" ${Number(group.id) === Number(currentId) ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('');
  }

  function renderOverview() {
    const host = document.querySelector('#channelGroupOverview');
    if (!host) return;
    if (!groups.length) {
      host.innerHTML = '<div class="hint">暂无频道分组。</div>';
      return;
    }

    host.innerHTML = groups.map(group => {
      const rows = assignments.filter(channel => Number(channel.instance_id) === Number(group.id));
      return `
        <section class="channel-group-block">
          <div class="channel-group-title"><strong>${escapeHtml(group.name)}</strong><span>${rows.length} 个频道</span></div>
          ${rows.length ? rows.map(channel => `
            <div class="channel-group-row" data-channel-id="${channel.id}">
              <div class="channel-group-main">
                <strong>${escapeHtml(channel.name)}</strong>
                <span class="channel-group-number">${escapeHtml(channel.guild_number || channel.url || '')}</span>
              </div>
              <div class="channel-group-move">
                <span>移动到</span>
                <select class="channel-move-select" data-channel-id="${channel.id}" data-current-group="${channel.instance_id}">
                  ${groupOptions(channel.instance_id)}
                </select>
              </div>
            </div>`).join('') : '<div class="hint channel-group-empty">这个频道分组还没有频道。</div>'}
        </section>`;
    }).join('');

    host.querySelectorAll('.channel-move-select').forEach(select => {
      select.addEventListener('change', async () => {
        const channelId = Number(select.dataset.channelId);
        const oldGroupId = Number(select.dataset.currentGroup);
        const nextGroupId = Number(select.value);
        if (!channelId || !nextGroupId || oldGroupId === nextGroupId) return;
        select.disabled = true;
        try {
          await window.api.moveChannel({ id: channelId, instanceId: nextGroupId });
          await refreshOverview();
          document.querySelector('#btnRefreshChannels')?.click();
        } catch (error) {
          select.value = String(oldGroupId);
          alert(String(error?.message || error));
        } finally {
          select.disabled = false;
        }
      });
    });
  }

  function annotateSyncedChannels() {
    const byGuild = new Map(assignments.filter(item => item.guild_id).map(item => [String(item.guild_id), item]));
    document.querySelectorAll('.qq-remote-row').forEach(row => {
      const checkbox = row.querySelector('.qq-remote-check');
      if (!checkbox) return;
      row.querySelector('.qq-current-group')?.remove();
      const local = byGuild.get(String(checkbox.value));
      const badge = document.createElement('span');
      badge.className = 'qq-current-group';
      badge.textContent = local ? `当前分组：${local.instance_name}` : '当前分组：未导入';
      row.appendChild(badge);
    });
  }

  async function refreshOverview() {
    await loadData();
    renderOverview();
    annotateSyncedChannels();
  }

  function mountOverview() {
    const panel = document.querySelector('#channels');
    if (!panel || document.querySelector('#channelGroupOverviewCard')) return;

    const style = document.createElement('style');
    style.textContent = `
      #channelGroupOverviewCard{margin-bottom:16px}
      .channel-group-block{border:1px solid #e7edf4;border-radius:10px;margin:10px 0;overflow:hidden;background:#fff}
      .channel-group-title{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#f8fafc;border-bottom:1px solid #edf1f6}
      .channel-group-title span{color:#64748b;font-size:13px}
      .channel-group-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 14px;border-bottom:1px solid #edf1f6}
      .channel-group-row:last-child{border-bottom:0}
      .channel-group-main{min-width:0;display:flex;flex-direction:column;gap:3px}
      .channel-group-number{color:#7d8b9b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:560px}
      .channel-group-move{display:flex;align-items:center;gap:8px;white-space:nowrap}
      .channel-group-move select{min-width:150px}
      .channel-group-empty{padding:12px 14px}
      .qq-current-group{display:inline-flex;padding:3px 8px;border-radius:999px;background:#eef2ff;color:#4f46e5;font-size:12px;white-space:nowrap}
    `;
    document.head.appendChild(style);

    const card = document.createElement('div');
    card.className = 'card';
    card.id = 'channelGroupOverviewCard';
    card.innerHTML = `
      <div class="card-title-row">
        <div><h3>频道分组总览</h3><div class="hint">QQ 频道只需导入一次。以后直接在这里查看归属或移动到其他频道分组。</div></div>
        <button type="button" id="btnRefreshChannelOverview">↻ 刷新</button>
      </div>
      <div id="channelGroupOverview"><div class="hint">正在加载...</div></div>`;

    const syncCard = panel.querySelector('#qqChannelSyncCard');
    if (syncCard) panel.insertBefore(card, syncCard.nextSibling);
    else panel.prepend(card);

    document.querySelector('#btnRefreshChannelOverview')?.addEventListener('click', () => refreshOverview().catch(error => alert(String(error?.message || error))));
    document.querySelector('#btnRefreshChannels')?.addEventListener('click', () => setTimeout(() => refreshOverview().catch(() => {}), 100));

    const remoteHost = document.querySelector('#qqChannelRemoteList');
    if (remoteHost) new MutationObserver(() => annotateSyncedChannels()).observe(remoteHost, { childList: true, subtree: true });

    refreshOverview().catch(() => {});
  }

  function mountLogout() {
    const button = document.querySelector('#btnLogoutQQ');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (!confirm('确定退出当前 QQ 账号？\n\n当前账号的频道分组、频道、任务和历史记录都会保留，并绑定到该账号ID。以后重新登录同一个 QQ 会自动恢复。')) return;
      button.disabled = true;
      const status = document.querySelector('#loginStatus');
      if (status) status.textContent = '登录状态：正在退出...';
      try {
        const result = await window.api.logoutQQ();
        const suffix = result?.accountId ? `（本地账号 #${result.accountId}）` : '';
        alert(`已退出当前 QQ${suffix}。本地频道和任务已保留。`);
        window.location.reload();
      } catch (error) {
        alert(`退出失败：${String(error?.message || error)}`);
        document.querySelector('#btnCheckLogin')?.click();
      } finally {
        button.disabled = false;
      }
    });
  }

  function start() {
    mountLogout();
    const waitForSync = () => {
      mountOverview();
      if (!document.querySelector('#channelGroupOverviewCard')) setTimeout(waitForSync, 100);
    };
    waitForSync();
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
