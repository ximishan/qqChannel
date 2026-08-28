(() => {
  let debounceTimer = null;

  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  async function loadSavedFilters() {
    const [groups, settings] = await Promise.all([
      window.api.listInstances(),
      window.api.listSettings()
    ]);
    const map = Object.fromEntries((settings || []).map(item => [item.key, item.value]));
    return {
      groups: groups || [],
      groupId: Number(map.task_list_group_filter || 0),
      channelSearch: String(map.task_list_channel_search || '')
    };
  }

  function triggerRefresh() {
    document.querySelector('#btnRefreshTasks')?.click();
  }

  async function saveGroupFilter(value) {
    await window.api.setSetting({ key: 'task_list_group_filter', value: String(Number(value) || 0) });
    triggerRefresh();
  }

  async function saveChannelSearch(value) {
    await window.api.setSetting({ key: 'task_list_channel_search', value: String(value || '').trim() });
    triggerRefresh();
  }

  async function mount() {
    const panel = document.querySelector('#tasks');
    const table = panel?.querySelector('.table-wrap');
    if (!panel || !table || document.querySelector('#taskListFilterBar')) return;

    const saved = await loadSavedFilters();
    const bar = document.createElement('div');
    bar.id = 'taskListFilterBar';
    bar.className = 'actionbar task-list-filter-bar';
    bar.innerHTML = `
      <span class="task-filter-label">任务筛选</span>
      <select id="taskGroupFilter" aria-label="按频道分组筛选">
        <option value="0">全部频道分组</option>
        ${saved.groups.map(group => `<option value="${group.id}" ${Number(group.id) === saved.groupId ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}
      </select>
      <input id="taskChannelSearch" type="search" value="${escapeHtml(saved.channelSearch)}" placeholder="搜索 QQ 频道名称 / 频道号" autocomplete="off">
      <button type="button" id="btnClearTaskFilters">清除筛选</button>
      <span class="hint">默认显示所有频道分组的任务</span>
    `;

    table.parentNode.insertBefore(bar, table);

    const style = document.createElement('style');
    style.textContent = `
      .task-list-filter-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 12px}
      .task-list-filter-bar .task-filter-label{font-weight:600;color:#475569}
      .task-list-filter-bar select{min-width:180px}
      .task-list-filter-bar input[type="search"]{min-width:260px;max-width:420px;flex:1}
      .task-list-filter-bar .hint{margin-left:auto;white-space:nowrap}
    `;
    document.head.appendChild(style);

    document.querySelector('#taskGroupFilter')?.addEventListener('change', event => {
      saveGroupFilter(event.target.value).catch(error => alert(String(error?.message || error)));
    });

    document.querySelector('#taskChannelSearch')?.addEventListener('input', event => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        saveChannelSearch(event.target.value).catch(error => alert(String(error?.message || error)));
      }, 300);
    });

    document.querySelector('#btnClearTaskFilters')?.addEventListener('click', async () => {
      const group = document.querySelector('#taskGroupFilter');
      const search = document.querySelector('#taskChannelSearch');
      if (group) group.value = '0';
      if (search) search.value = '';
      await window.api.setSetting({ key: 'task_list_group_filter', value: '0' });
      await window.api.setSetting({ key: 'task_list_channel_search', value: '' });
      triggerRefresh();
    });

    // 后续新建/改名频道分组后，重新进入程序会读取最新列表；当前窗口也在管理分组操作后尽量即时补齐。
    const reloadGroupOptions = async () => {
      const select = document.querySelector('#taskGroupFilter');
      if (!select) return;
      const current = select.value;
      const groups = await window.api.listInstances();
      select.innerHTML = `<option value="0">全部频道分组</option>${(groups || []).map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join('')}`;
      select.value = (groups || []).some(group => String(group.id) === current) ? current : '0';
      if (select.value !== current) await saveGroupFilter(select.value);
    };

    document.querySelector('#btnManageInstance')?.addEventListener('click', () => setTimeout(() => reloadGroupOptions().catch(() => {}), 500));
    document.querySelector('#btnNewInstance')?.addEventListener('click', () => setTimeout(() => reloadGroupOptions().catch(() => {}), 500));

    triggerRefresh();
  }

  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', () => mount().catch(console.error), { once: true });
  else mount().catch(console.error);
})();
