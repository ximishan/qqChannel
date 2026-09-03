let currentInstanceId = null;
let selectedTaskId = null;
const selectedTaskIds = new Set();
let schedulerTimer = null;
let activeTab = 'tasks';
let browserResizeTimer = null;
let lastRenderedTaskSnapshot = '';
let taskRows = [];
let taskPage = 1;
let taskPageSize = 10;
let taskTotalPages = 1;
let runtimeSettings = {};
let channelRows = [];
let instanceRows = [];

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const startupFixedInstanceId = (() => {
  try { return Math.max(0, Number(new URLSearchParams(location.search).get('instanceId')) || 0); }
  catch (_) { return 0; }
})();

async function syncBrowserView() {
  if (!currentInstanceId || !window.api.setBrowserView) return;
  const host = $('#embeddedBrowserHost');
  const visible = activeTab === 'browser' && Boolean(host);
  const rect = visible ? host.getBoundingClientRect() : null;
  await window.api.setBrowserView({
    instanceId: currentInstanceId,
    visible,
    bounds: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : undefined
  });
}

async function activateTab(tabName) {
  activeTab = tabName;
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tabName));
  $$('.panel').forEach(x => x.classList.toggle('active', x.id === tabName));
  await syncBrowserView();
}

async function loadInstances() {
  const rows = await window.api.listInstances();
  instanceRows = rows || [];
  const select = $('#instanceSelect');
  select.innerHTML = instanceRows.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');

  if (!instanceRows.some(row => Number(row.id) === Number(currentInstanceId))) {
    currentInstanceId = startupFixedInstanceId && instanceRows.some(row => Number(row.id) === startupFixedInstanceId)
      ? startupFixedInstanceId
      : (instanceRows.length ? Number(instanceRows[0].id) : null);
  }
  if (currentInstanceId) select.value = String(currentInstanceId);

  const hasInstance = Boolean(currentInstanceId);
  $('#btnManageInstance').disabled = !hasInstance;
  $('#btnLogin').disabled = !hasInstance;
  $('#btnCheckLogin').disabled = !hasInstance;
  $('#btnLogoutQQ').disabled = !hasInstance;

  if (!hasInstance) {
    channelRows = [];
    taskRows = [];
    selectedTaskIds.clear();
    $('#channelList').innerHTML = '<div class="hint">请先新建实例并登录 QQ。</div>';
    $('#taskChannelList').innerHTML = '<div class="hint">请先新建实例并登录 QQ。</div>';
    $('#taskBody').innerHTML = '<tr><td colspan="11" class="hint">请先新建实例。</td></tr>';
    $('#taskPageInfo').textContent = '第 1 / 1 页，共 0 条';
    $('#loginStatus').textContent = '登录状态：请先新建实例';
    $('#queueStatus').textContent = '队列：idle';
    $('#currentChannelInstanceTitle').textContent = '当前实例频道';
    await Promise.all([loadSettings(), loadLogs()]);
    return;
  }

  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
  startSchedulerPolling();
}

async function refreshAll() {
  await Promise.all([loadTasks(), loadChannels(), loadSettings(), loadLogs()]);
}

async function loadChannels() {
  if (!currentInstanceId) return;
  const instance = instanceRows.find(item => Number(item.id) === Number(currentInstanceId));
  $('#currentChannelInstanceTitle').textContent = instance ? `实例“${instance.name}”的频道` : '当前实例频道';
  const rows = await window.api.listChannels(currentInstanceId);
  channelRows = rows || [];
  $('#channelList').innerHTML = channelRows.length ? channelRows.map(channel => `
    <div class="channel-item">
      <strong>${escapeHtml(channel.name)}</strong>
      <div class="channel-url">${escapeHtml(channel.url)}</div>
      <div class="channel-actions">
        <button onclick="editChannelName(${channel.id})">改名</button>
        <button onclick="deleteChannel(${channel.id})">删除</button>
      </div>
    </div>`).join('') : '<div class="hint">当前实例还没有同步到频道。</div>';
}

async function loadTasks(force = false) {
  if (!currentInstanceId) return;
  const result = await window.api.listTasks({ instanceId: currentInstanceId, page: taskPage, pageSize: taskPageSize });
  const rows = result.items || [];
  taskPage = result.page || 1;
  taskTotalPages = result.totalPages || 1;
  taskRows = rows;

  $('#taskPageInfo').textContent = `第 ${taskPage} / ${taskTotalPages} 页，共 ${result.total || 0} 条`;
  $('#btnTaskPrev').disabled = taskPage <= 1;
  $('#btnTaskNext').disabled = taskPage >= taskTotalPages;

  const snapshot = JSON.stringify(rows.map(task => [
    task.id,
    task.instance_id,
    task.status,
    task.finished_at,
    task.scheduled_at,
    task.interval_min_seconds,
    task.interval_max_seconds,
    ...(task.targets || []).map(target => `${target.id}:${target.status}:${target.retry_count || 0}:${target.last_error || ''}`)
  ]));
  const pageSnapshot = `${taskPage}:${taskPageSize}:${result.total}:${snapshot}`;
  if (!force && pageSnapshot === lastRenderedTaskSnapshot) return;
  lastRenderedTaskSnapshot = pageSnapshot;

  $('#taskBody').innerHTML = rows.length ? rows.map(task => `
    <tr>
      <td><input type="checkbox" class="task-row-select" value="${task.id}" ${selectedTaskIds.has(task.id) ? 'checked' : ''}></td>
      <td>${task.id}</td>
      <td class="instance-cell" title="${escapeAttr(instanceRows.find(item => Number(item.id) === Number(task.instance_id))?.name || `实例 #${task.instance_id}`)}">${escapeHtml(instanceRows.find(item => Number(item.id) === Number(task.instance_id))?.name || `实例 #${task.instance_id}`)}</td>
      <td title="${escapeAttr((task.targets || []).map(x => `${x.channel_name}:${x.status}${x.retry_count ? `(重试${x.retry_count})` : ''}${x.last_error ? ` - ${x.last_error}` : ''}`).join('\n'))}"><div class="target-status-list">${renderTargetChips(task.targets || [])}</div></td>
      <td>${escapeHtml(task.title || '(无标题)')}</td>
      <td class="comment-cell" title="${escapeAttr(task.body || '')}">${escapeHtml(shortText(task.body || '—', 36))}</td>
      <td class="material-cell" title="${escapeAttr(task.media_path)}"><span class="material-name">${task.media_type === 'text' ? '—' : escapeHtml(compactFileName(task.media_path))}</span></td>
      <td>${task.media_type === 'text' ? '文本' : (task.media_type === 'image' ? '图片' : '视频')}</td>
      <td class="status-${task.status}">${escapeHtml(task.status)}</td>
      <td>${task.scheduled_at ? escapeHtml(formatBeijingDateTime(task.scheduled_at)) : '立即'}</td>
      <td>${escapeHtml(formatBeijingDateTime(task.created_at, true))}</td>
    </tr>`).join('') : '<tr><td colspan="11" class="hint">暂无任务。点击“新建发布任务”创建任务。</td></tr>';

  $$('.task-row-select').forEach(input => input.addEventListener('change', () => {
    const id = Number(input.value);
    if (input.checked) selectedTaskIds.add(id);
    else selectedTaskIds.delete(id);
    updateTaskSelectionUi();
  }));
  updateTaskSelectionUi();
}

async function loadSettings() {
  const rows = await window.api.listSettings();
  const map = Object.fromEntries((rows || []).map(x => [x.key, x.value]));
  runtimeSettings = map;
  if ($('#setting_max_retries')) $('#setting_max_retries').value = map.max_retries ?? '2';
  if ($('#setting_upload_timeout_ms')) $('#setting_upload_timeout_ms').value = map.upload_timeout_ms ?? '120000';
  if ($('#setting_publish_verify_timeout_ms')) $('#setting_publish_verify_timeout_ms').value = map.publish_verify_timeout_ms ?? '20000';
  if ($('#setting_interval_min_seconds')) $('#setting_interval_min_seconds').value = map.interval_min_seconds ?? '180';
  if ($('#setting_interval_max_seconds')) $('#setting_interval_max_seconds').value = map.interval_max_seconds ?? '480';
  if ($('#setting_target_interval_seconds')) $('#setting_target_interval_seconds').value = map.target_interval_seconds ?? '70';
  if ($('#setting_screenshot_on_error')) $('#setting_screenshot_on_error').value = map.screenshot_on_error ?? '1';
}

async function loadLogs() {
  const rows = await window.api.listLogs();
  $('#logBox').textContent = (rows || []).map(row => `[${formatBeijingDateTime(row.created_at, true)}] [${row.level.toUpperCase()}] ${row.message}`).join('\n');
}

async function checkLoginStatus(showAlert = false) {
  if (!currentInstanceId) return;
  const element = $('#loginStatus');
  element.textContent = '登录状态：检测中...';
  try {
    const result = await window.api.getLoginStatus(currentInstanceId);
    if (result.loggedIn) {
      element.textContent = `已登录：${result.name || 'QQ账号'}`;
      element.style.background = '#edf9f2';
      element.style.color = '#17a663';
      if (showAlert) alert(`登录正常：${result.name || 'QQ账号'}`);
    } else {
      element.textContent = '登录状态：未登录/已失效';
      element.style.background = '#fff1f1';
      element.style.color = '#e55252';
      if (showAlert) alert('未检测到登录状态，请点击“登录QQ”扫码登录');
    }
  } catch (error) {
    element.textContent = '登录状态：检测失败';
    element.style.background = '#fff7e6';
    element.style.color = '#c47b00';
    if (showAlert) alert(String(error?.message || error));
  }
}

function startSchedulerPolling() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => refreshSchedulerState().catch(() => {}), 1000);
}

async function refreshSchedulerState() {
  if (!currentInstanceId || !window.api.schedulerState) return;
  const state = await window.api.schedulerState(currentInstanceId);
  const element = $('#queueStatus');
  if (!element) return;

  let text = `队列：${state.status}`;
  if (state.currentTaskId) text += ` · 任务 #${state.currentTaskId}`;
  if (state.pendingCount != null) text += ` · 待发 ${state.pendingCount}`;
  if (state.nextRunAt) text += ` · ${Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 1000))}s 后下一条`;
  if (state.lastError) text += ` · ${state.lastError}`;
  element.textContent = text;

  const good = ['running', 'waiting'].includes(state.status);
  const warn = state.status === 'paused';
  element.style.background = good ? '#edf9f2' : warn ? '#fff7e6' : '#f1f5f9';
  element.style.color = good ? '#17a663' : warn ? '#c47b00' : '#64748b';
  await loadTasks().catch(() => {});
}

window.deleteChannel = async id => {
  if (!confirm('确定删除这个频道？')) return;
  await window.api.deleteChannel(id);
  await loadChannels();
};

window.editChannelName = id => {
  const channel = channelRows.find(item => item.id === Number(id));
  if (!channel) return alert('频道不存在，请刷新后重试');
  $('#channelEditId').value = channel.id;
  $('#channelEditName').value = channel.name;
  $('#channelEditDialog').showModal();
  setTimeout(() => $('#channelEditName').select(), 0);
};

$('#btnCloseChannelEdit').addEventListener('click', () => $('#channelEditDialog').close());
$('#btnCancelChannelEdit').addEventListener('click', () => $('#channelEditDialog').close());
$('#channelEditForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = Number($('#channelEditId').value);
  const name = $('#channelEditName').value.trim();
  if (!id || !name) return alert('频道名称不能为空');
  const button = $('#btnSaveChannelEdit');
  button.disabled = true;
  try {
    await window.api.updateChannelName({ id, name });
    $('#channelEditDialog').close();
    await Promise.all([loadChannels(), loadTasks(true)]);
  } catch (error) {
    alert(String(error?.message || error));
  } finally {
    button.disabled = false;
  }
});

$('#instanceSelect').addEventListener('change', async event => {
  currentInstanceId = Number(event.target.value);
  selectedTaskIds.clear();
  selectedTaskId = null;
  taskPage = 1;
  lastRenderedTaskSnapshot = '';
  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
  await syncBrowserView();
});

$('#btnNewInstance').addEventListener('click', () => {
  $('#instanceForm').dataset.mode = 'create';
  $('#instanceDialogTitle').textContent = '新建实例';
  $('#instanceDialogDescription').textContent = '每个实例对应一个独立登录的 QQ 账号，并自动同步该账号的频道。';
  $('#instanceName').value = `实例 ${Date.now().toString().slice(-4)}`;
  $('#btnSaveInstance').textContent = '创建实例';
  $('#btnDeleteInstance').classList.add('hidden');
  $('#instanceDialog').showModal();
  setTimeout(() => $('#instanceName').select(), 0);
});

$('#btnManageInstance').addEventListener('click', () => {
  const instance = instanceRows.find(item => Number(item.id) === Number(currentInstanceId));
  if (!instance) return alert('请先选择实例');
  $('#instanceForm').dataset.mode = 'edit';
  $('#instanceDialogTitle').textContent = '管理实例';
  $('#instanceDialogDescription').textContent = `当前实例：${instance.name}。可修改名称，也可删除该实例及其本地频道和任务数据。`;
  $('#instanceName').value = instance.name;
  $('#btnSaveInstance').textContent = '保存名称';
  $('#btnDeleteInstance').classList.remove('hidden');
  $('#instanceDialog').showModal();
  setTimeout(() => $('#instanceName').select(), 0);
});

$('#btnCloseInstance').addEventListener('click', () => $('#instanceDialog').close());
$('#btnCancelInstance').addEventListener('click', () => $('#instanceDialog').close());
$('#instanceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const mode = $('#instanceForm').dataset.mode || 'create';
  const name = $('#instanceName').value.trim();
  if (!name) return alert('实例名称不能为空');
  const button = $('#btnSaveInstance');
  button.disabled = true;
  try {
    if (mode === 'create') {
      const created = await window.api.createInstance(name);
      currentInstanceId = Number(created.id);
    } else {
      await window.api.updateInstanceName({ id: currentInstanceId, name });
    }
    $('#instanceDialog').close();
    await loadInstances();
  } catch (error) {
    alert(String(error?.message || error));
  } finally {
    button.disabled = false;
  }
});

$('#btnDeleteInstance').addEventListener('click', async () => {
  const instance = instanceRows.find(item => Number(item.id) === Number(currentInstanceId));
  if (!instance) return alert('实例不存在，请刷新后重试');
  let summary;
  try {
    summary = await window.api.getInstanceSummary(currentInstanceId);
  } catch (error) {
    return alert(String(error?.message || error));
  }
  if (Number(summary.running_task_count) > 0) return alert('该实例仍有正在发布的任务，请等待任务完成后再删除');
  if (!confirm(`确定删除实例“${instance.name}”？\n\n将同时删除：\n- ${summary.channel_count || 0} 个本地频道配置\n- ${summary.task_count || 0} 条本地任务记录\n- 该实例的本地 QQ 登录会话\n\n不会删除腾讯频道中的实际内容。此操作不可撤销。`)) return;

  const button = $('#btnDeleteInstance');
  button.disabled = true;
  try {
    await window.api.deleteInstance(currentInstanceId);
    $('#instanceDialog').close();
    currentInstanceId = null;
    await loadInstances();
  } catch (error) {
    alert(String(error?.message || error));
  } finally {
    button.disabled = false;
  }
});

$('#btnLogin').addEventListener('click', async () => {
  if (!currentInstanceId) return;
  const status = $('#loginStatus');
  status.textContent = '登录状态：正在打开内置浏览器...';
  status.style.background = '#fff7e6';
  status.style.color = '#c47b00';
  try {
    await activateTab('browser');
    const result = await window.api.openLogin(currentInstanceId);
    await syncBrowserView();
    if (result?.loggedIn) await checkLoginStatus(false);
  } catch (error) {
    status.textContent = '登录状态：打开失败';
    alert(String(error?.message || error));
  }
});

$('#btnCheckLogin').addEventListener('click', () => checkLoginStatus(true));
$('#btnLogoutQQ').addEventListener('click', async () => {
  if (!currentInstanceId) return;
  const instance = instanceRows.find(item => Number(item.id) === Number(currentInstanceId));
  if (!confirm(`确定退出实例“${instance?.name || currentInstanceId}”的 QQ 登录？\n\n只会清除这个实例的登录会话，不影响其他实例。`)) return;
  try {
    await window.api.logoutQQ(currentInstanceId);
    await checkLoginStatus(false);
    if (activeTab === 'browser') await window.api.browserHome(currentInstanceId);
  } catch (error) {
    alert(String(error?.message || error));
  }
});

$('#btnBrowserHome').addEventListener('click', async () => { await window.api.browserHome(currentInstanceId); await syncBrowserView(); });
$('#btnBrowserBack').addEventListener('click', () => window.api.browserBack(currentInstanceId));
$('#btnBrowserReload').addEventListener('click', () => window.api.browserReload(currentInstanceId));

$('#btnRefreshChannels').onclick = loadChannels;
$('#btnRefreshTasks').onclick = () => loadTasks(true);
$('#btnRefreshLogs').onclick = loadLogs;

$('#taskMediaType').addEventListener('change', () => {
  const type = $('#taskMediaType').value;
  const hasMedia = type !== 'text';
  $('#taskMediaRow').classList.toggle('hidden', !hasMedia);
  $('#taskMediaLabel').textContent = type === 'image' ? '图片文件' : '视频文件';
  $('#mediaPath').placeholder = type === 'image' ? '请选择图片文件' : '请选择视频文件';
  $('#mediaPath').value = '';
});

$('#btnPickMedia').addEventListener('click', async () => {
  const type = $('#taskMediaType').value;
  const path = type === 'image' ? await window.api.pickImage() : await window.api.pickVideo();
  if (path) $('#mediaPath').value = path;
});

$('#btnQueueStart').addEventListener('click', async () => {
  try {
    await activateTab('tasks');
    const result = await window.api.schedulerStart(currentInstanceId);
    if (result?.reason === 'login_required') {
      alert('QQ 未登录或登录已失效，请先点击“登录QQ”');
      await checkLoginStatus(false);
    } else if (result?.reason === 'empty') {
      alert('当前没有待发布任务');
    }
  } catch (error) {
    alert(String(error?.message || error));
  }
  await refreshSchedulerState();
});

$('#btnQueuePause').addEventListener('click', async () => { await window.api.schedulerPause(currentInstanceId); await refreshSchedulerState(); });
$('#btnQueueResume').addEventListener('click', async () => { await window.api.schedulerResume(currentInstanceId); await refreshSchedulerState(); });
$('#btnQueueStop').addEventListener('click', async () => { await window.api.schedulerStop(currentInstanceId); await refreshSchedulerState(); });
$('#btnQueueStartAll').addEventListener('click', async () => {
  try {
    const result = await window.api.schedulerStartAll();
    alert(result.count ? `已启动 ${result.count} 个有待发布任务的实例。` : '所有实例都没有待发布任务。');
  } catch (error) {
    alert(String(error?.message || error));
  }
  await refreshSchedulerState();
});
$('#btnQueueStopAll').addEventListener('click', async () => { await window.api.schedulerStopAll(); await refreshSchedulerState(); });

$('#btnRunTask').addEventListener('click', async () => {
  if (selectedTaskIds.size !== 1) return alert('执行任务时请只选择一条任务');
  selectedTaskId = [...selectedTaskIds][0];
  const task = taskRows.find(row => row.id === selectedTaskId);
  if (!task) return alert('要执行的任务不在当前页，请回到该任务所在页后操作');
  const targets = task?.targets?.filter(target => target.status !== 'success') || [];
  if (!targets.length) return alert('该任务没有需要发布的目标频道');
  if (!confirm(`任务 #${selectedTaskId} 将发布到以下频道：\n\n${formatChannelList(targets.map(target => target.channel_name))}\n\n是否继续？`)) return;
  try {
    await activateTab('tasks');
    renderPublishResult(await window.api.runTask(selectedTaskId));
  } catch (error) {
    alert(String(error?.message || error));
  }
  await Promise.all([loadTasks(true), loadLogs(), checkLoginStatus(false)]);
});

$('#btnRetryTask').addEventListener('click', async () => {
  if (selectedTaskIds.size !== 1) return alert('重试任务时请只选择一条任务');
  selectedTaskId = [...selectedTaskIds][0];
  const task = taskRows.find(row => row.id === selectedTaskId);
  if (!task) return alert('要重试的任务不在当前页，请回到该任务所在页后操作');
  const failedTargets = task?.targets?.filter(target => target.status === 'failed') || [];
  if (!failedTargets.length) return alert('该任务没有失败的目标频道');
  if (!confirm(`只重新处理以下失败频道：\n\n${formatChannelList(failedTargets.map(target => target.channel_name))}\n\n是否继续？`)) return;
  try {
    await activateTab('tasks');
    renderPublishResult(await window.api.retryFailedTask(selectedTaskId));
  } catch (error) {
    alert(String(error?.message || error));
  }
  await Promise.all([loadTasks(true), loadLogs()]);
});

$('#btnDeleteTask').addEventListener('click', async () => {
  const ids = [...selectedTaskIds];
  if (!ids.length) return alert('请先选择要删除的任务');
  if (!confirm(`确定删除选中的 ${ids.length} 条任务？\n\n不会删除腾讯频道中已经发布的内容。`)) return;
  const result = await window.api.deleteTasks(ids);
  selectedTaskIds.clear();
  selectedTaskId = null;
  await loadTasks(true);
  await refreshSchedulerState();
  if (result.skippedRunningCount) alert(`有 ${result.skippedRunningCount} 条正在发布的任务未删除`);
});

$('#btnTaskPrev').addEventListener('click', async () => {
  if (taskPage <= 1) return;
  taskPage -= 1;
  lastRenderedTaskSnapshot = '';
  await loadTasks(true);
});
$('#btnTaskNext').addEventListener('click', async () => {
  if (taskPage >= taskTotalPages) return;
  taskPage += 1;
  lastRenderedTaskSnapshot = '';
  await loadTasks(true);
});
$('#taskPageSize').addEventListener('change', async event => {
  taskPageSize = Number(event.target.value) || 10;
  taskPage = 1;
  lastRenderedTaskSnapshot = '';
  await loadTasks(true);
});
$('#taskSelectAll').addEventListener('change', event => {
  for (const task of taskRows) {
    if (event.target.checked) selectedTaskIds.add(task.id);
    else selectedTaskIds.delete(task.id);
  }
  $$('.task-row-select').forEach(input => { input.checked = event.target.checked; });
  updateTaskSelectionUi();
});

$('#btnSaveRuntimeSettings').addEventListener('click', async () => {
  let minSec = Number($('#setting_interval_min_seconds').value || 0);
  let maxSec = Number($('#setting_interval_max_seconds').value || 0);
  let targetSec = Number($('#setting_target_interval_seconds').value || 0);
  if (minSec < 0 || maxSec < 0) return alert('随机间隔不能小于 0 秒');
  if (!Number.isFinite(targetSec) || targetSec < 0) return alert('同一任务的频道间隔不能小于 0 秒');
  if (maxSec < minSec) [minSec, maxSec] = [maxSec, minSec];
  targetSec = Math.floor(targetSec);

  $('#setting_interval_min_seconds').value = minSec;
  $('#setting_interval_max_seconds').value = maxSec;
  $('#setting_target_interval_seconds').value = targetSec;

  const items = [
    ['max_retries', $('#setting_max_retries').value],
    ['upload_timeout_ms', $('#setting_upload_timeout_ms').value],
    ['publish_verify_timeout_ms', $('#setting_publish_verify_timeout_ms').value],
    ['interval_min_seconds', String(minSec)],
    ['interval_max_seconds', String(maxSec)],
    ['target_interval_seconds', String(targetSec)],
    ['screenshot_on_error', $('#setting_screenshot_on_error').value]
  ];
  for (const [key, value] of items) await window.api.setSetting({ key, value });
  alert('运行参数已保存');
});

$$('.tab').forEach(button => button.addEventListener('click', () => activateTab(button.dataset.tab)));
window.addEventListener('resize', () => {
  clearTimeout(browserResizeTimer);
  browserResizeTimer = setTimeout(() => syncBrowserView().catch(() => {}), 80);
});

function fileName(path) { return String(path || '').split(/[\\/]/).pop(); }
function compactFileName(path, maxLength = 28) {
  const name = fileName(path);
  if (name.length <= maxLength) return name;
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
  const tailLength = Math.min(10 + extension.length, Math.floor(maxLength / 2));
  const headLength = Math.max(8, maxLength - tailLength - 1);
  return `${name.slice(0, headLength)}…${name.slice(-tailLength)}`;
}
function shortText(value, maxLength) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}
function normalizeStoredDateTime(value, assumeSqliteUtc = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (assumeSqliteUtc && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return new Date(raw.replace(' ', 'T') + 'Z');
  return new Date(raw);
}
function formatBeijingDateTime(value, assumeSqliteUtc = false) {
  const date = normalizeStoredDateTime(value, assumeSqliteUtc);
  if (!date || Number.isNaN(date.getTime())) return String(value || '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function escapeAttr(value = '') { return escapeHtml(value); }

function updateTaskSelectionUi() {
  const visibleIds = taskRows.map(task => task.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedTaskIds.has(id)).length;
  const selectAll = $('#taskSelectAll');
  if (selectAll) {
    selectAll.checked = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
  }
  selectedTaskId = selectedTaskIds.size === 1 ? [...selectedTaskIds][0] : null;
  const info = $('#taskSelectionInfo');
  if (info) info.textContent = `已选 ${selectedTaskIds.size} 条`;
}

function renderTargetChips(targets) {
  if (!targets?.length) return '<span class="target-status-chip empty">无目标</span>';
  return targets.map(target => `<span class="target-status-chip ${escapeHtml(target.status)}" title="${escapeAttr(target.last_error || '')}">${escapeHtml(target.channel_name)} · ${escapeHtml(target.status)}</span>`).join('');
}

function formatChannelList(names) {
  return (names || []).map((name, index) => `${index + 1}. ${name}`).join('\n');
}

function renderPublishResult(result) {
  const box = $('#publishResult');
  if (!box) return;
  if (!result) {
    box.textContent = '没有返回结果。';
    return;
  }
  if (result.success) {
    box.textContent = result.postUrl ? `发布成功：${result.postUrl}` : '发布成功。';
    return;
  }
  box.textContent = String(result.message || result.error || '发布失败');
}

async function handlePublishUpdate(data) {
  if (!data) return;
  if (data.instanceId && currentInstanceId && Number(data.instanceId) !== Number(currentInstanceId)) return;
  if (data.type === 'task-started') {
    await activateTab('browser');
  } else if (data.type === 'task-finished') {
    await loadTasks(true).catch(() => {});
    await loadLogs().catch(() => {});
    await refreshSchedulerState().catch(() => {});
    await activateTab('tasks');
  } else if (data.type === 'target-finished') {
    await loadTasks(true).catch(() => {});
  }
}

if (window.api.onPublishUpdate) window.api.onPublishUpdate(data => handlePublishUpdate(data).catch(() => {}));
// 顶层协调窗口现在只是“实例启动器”。不要在这里调用 loadInstances()，
// 否则它会自动选择第一个实例、触发登录检测，并提前创建该实例的 QQ WebContentsView。
// 只有带 ?instanceId=... 的真实实例窗口才初始化完整业务界面。
if (startupFixedInstanceId) loadInstances();