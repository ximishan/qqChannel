let currentInstanceId = null;
let selectedTaskId = null;
const selectedTaskIds = new Set();
let schedulerTimer = null;
let batchVideoFiles = [];
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

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function syncBrowserView() {
  if (!currentInstanceId || !window.api.setBrowserView) return;
  const host = $('#embeddedBrowserHost');
  const visible = activeTab === 'browser' && Boolean(host);
  const rect = visible ? host.getBoundingClientRect() : null;
  await window.api.setBrowserView({
    instanceId: currentInstanceId,
    visible,
    bounds: rect ? {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    } : undefined
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
  instanceRows = rows;
  const sel = $('#instanceSelect');
  sel.innerHTML = rows.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  if (!rows.some(row => Number(row.id) === Number(currentInstanceId))) {
    currentInstanceId = rows.length ? Number(rows[0].id) : null;
  }
  if (currentInstanceId) sel.value = String(currentInstanceId);

  const channelInstanceSelect = $('#channelInstanceSelect');
  channelInstanceSelect.innerHTML = rows.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  if (currentInstanceId) channelInstanceSelect.value = String(currentInstanceId);

  const hasInstance = Boolean(currentInstanceId);
  $('#btnManageInstance').disabled = !hasInstance;
  $('#btnLogin').disabled = !hasInstance;
  $('#btnCheckLogin').disabled = !hasInstance;
  $('#btnAddChannel').disabled = !hasInstance;
  channelInstanceSelect.disabled = !hasInstance;
  if (!hasInstance) {
    channelRows = [];
    taskRows = [];
    selectedTaskIds.clear();
    $('#channelList').innerHTML = '<div class="hint">请先新建实例，再向实例分配频道。</div>';
    $('#taskChannelList').innerHTML = '<div class="hint">请先新建实例并添加频道。</div>';
    $('#batchChannelList').innerHTML = '<div class="hint">请先新建实例并添加频道。</div>';
    $('#taskBody').innerHTML = '<tr><td colspan="11" class="hint">请先新建实例。</td></tr>';
    $('#taskPageInfo').textContent = '第 1 / 1 页，共 0 条';
    $('#loginStatus').textContent = '登录状态：请先新建实例';
    $('#queueStatus').textContent = '队列：idle';
    $('#currentChannelInstanceTitle').textContent = '当前实例频道';
    $('#channelSaveResult').textContent = '';
    await Promise.all([loadSelectors(), loadSettings(), loadLogs()]);
    return;
  }

  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
  startSchedulerPolling();
}

async function refreshAll() {
  await Promise.all([loadTasks(), loadChannels(), loadSelectors(), loadSettings(), loadLogs()]);
}

async function loadChannels() {
  if (!currentInstanceId) return;
  const instance = instanceRows.find(item => Number(item.id) === Number(currentInstanceId));
  $('#currentChannelInstanceTitle').textContent = instance ? `实例“${instance.name}”的频道` : '当前实例频道';
  const rows = await window.api.listChannels(currentInstanceId);
  channelRows = rows;
  $('#channelList').innerHTML = rows.length ? rows.map(c => `
    <div class="channel-item">
      <strong>${escapeHtml(c.name)}</strong>
      <div class="channel-url">${escapeHtml(c.url)}</div>
      <div class="channel-actions"><button onclick="editChannelName(${c.id})">改名</button><button onclick="deleteChannel(${c.id})">删除</button></div>
    </div>`).join('') : '<div class="hint">当前实例还没有频道。</div>';

  const options = rows.length ? rows.map(c => `
    <label class="target-check">
      <input type="checkbox" value="${c.id}">
      <span>${escapeHtml(c.name)}</span>
    </label>`).join('') : '<div class="hint">请先添加频道。</div>';

  $('#taskChannelList').innerHTML = options;
  $('#batchChannelList').innerHTML = options;
  $$('#taskChannelList input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', updateTaskTargetSummary);
  });
  updateTaskTargetSummary();
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
  const snapshot = JSON.stringify(rows.map(t => [
    t.id,
    t.instance_id,
    t.status,
    t.finished_at,
    t.scheduled_at,
    t.interval_min_seconds,
    t.interval_max_seconds,
    ...(t.targets || []).map(x => `${x.id}:${x.status}:${x.retry_count || 0}:${x.last_error || ''}`)
  ]));
  const pageSnapshot = `${taskPage}:${taskPageSize}:${result.total}:${snapshot}`;
  if (!force && pageSnapshot === lastRenderedTaskSnapshot) return;
  lastRenderedTaskSnapshot = pageSnapshot;

  $('#taskBody').innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td><input type="checkbox" class="task-row-select" value="${t.id}" ${selectedTaskIds.has(t.id) ? 'checked' : ''}></td>
      <td>${t.id}</td>
      <td class="instance-cell" title="${escapeAttr(instanceRows.find(item => Number(item.id) === Number(t.instance_id))?.name || `实例 #${t.instance_id}`)}">${escapeHtml(instanceRows.find(item => Number(item.id) === Number(t.instance_id))?.name || `实例 #${t.instance_id}`)}</td>
      <td title="${escapeAttr(t.targets.map(x => `${x.channel_name}:${x.status}${x.retry_count ? `(重试${x.retry_count})` : ''}${x.last_error ? ` - ${x.last_error}` : ''}`).join('\n'))}"><div class="target-status-list">${renderTargetChips(t.targets)}</div></td>
      <td>${escapeHtml(t.title || '(无标题)')}</td>
      <td class="comment-cell" title="${escapeAttr(t.body || '')}">${escapeHtml(shortText(t.body || '—', 36))}</td>
      <td class="material-cell" title="${escapeAttr(t.media_path)}"><span class="material-name">${t.media_type === 'text' ? '—' : escapeHtml(compactFileName(t.media_path))}</span></td>
      <td>${t.media_type === 'text' ? '文本' : (t.media_type === 'image' ? '图片' : '视频')}</td>
      <td class="status-${t.status}">${escapeHtml(t.status)}</td>
      <td>${t.scheduled_at ? escapeHtml(formatBeijingDateTime(t.scheduled_at)) : '立即'}</td>
      <td>${escapeHtml(formatBeijingDateTime(t.created_at, true))}</td>
    </tr>`).join('') : '<tr><td colspan="11" class="hint">暂无任务。点击“新建发布任务”创建纯文本、图片或视频任务。</td></tr>';

  $$('.task-row-select').forEach(input => input.addEventListener('change', () => {
    const id = Number(input.value);
    if (input.checked) selectedTaskIds.add(id);
    else selectedTaskIds.delete(id);
    updateTaskSelectionUi();
  }));
  updateTaskSelectionUi();
}

async function loadSelectors() {
  const rows = await window.api.listSelectors();
  $('#selectorList').innerHTML = rows.map(r => `
    <div class="selector-row">
      <div class="selector-name">${escapeHtml(r.name)}</div>
      <textarea id="sel_${r.key}" rows="2">${escapeHtml(r.value)}</textarea>
      <input id="timeout_${r.key}" type="number" value="${r.timeout}">
      <button onclick="saveSelector('${r.key}')">保存</button>
    </div>`).join('');
}

async function loadSettings() {
  const rows = await window.api.listSettings();
  const map = Object.fromEntries(rows.map(x => [x.key, x.value]));
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
  $('#logBox').textContent = rows.map(r => `[${formatBeijingDateTime(r.created_at, true)}] [${r.level.toUpperCase()}] ${r.message}`).join('\n');
}

async function checkLoginStatus(showAlert = false) {
  if (!currentInstanceId) return;
  const el = $('#loginStatus');
  el.textContent = '登录状态：检测中...';
  try {
    const r = await window.api.getLoginStatus(currentInstanceId);
    if (r.loggedIn) {
      el.textContent = `已登录：${r.name || 'QQ账号'}`;
      el.style.background = '#edf9f2';
      el.style.color = '#17a663';
      if (showAlert) alert(`登录正常：${r.name || 'QQ账号'}`);
    } else {
      el.textContent = '登录状态：未登录/已失效';
      el.style.background = '#fff1f1';
      el.style.color = '#e55252';
      if (showAlert) alert('未检测到登录状态，请点击“登录QQ”扫码登录');
    }
  } catch (e) {
    el.textContent = '登录状态：检测失败';
    el.style.background = '#fff7e6';
    el.style.color = '#c47b00';
    if (showAlert) alert(String(e?.message || e));
  }
}

function startSchedulerPolling() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    await refreshSchedulerState().catch(() => {});
  }, 1000);
}

async function refreshSchedulerState() {
  if (!currentInstanceId || !window.api.schedulerState) return;
  const s = await window.api.schedulerState(currentInstanceId);
  const el = $('#queueStatus');
  if (!el) return;

  let text = `队列：${s.status}`;
  if (s.currentTaskId) text += ` · 任务 #${s.currentTaskId}`;
  if (s.pendingCount != null) text += ` · 待发 ${s.pendingCount}`;
  if (s.nextRunAt) {
    const left = Math.max(0, Math.ceil((s.nextRunAt - Date.now()) / 1000));
    text += ` · ${left}s 后下一条`;
  }
  if (s.lastError) text += ` · ${s.lastError}`;
  el.textContent = text;

  const good = ['running', 'waiting'].includes(s.status);
  const warn = s.status === 'paused';
  el.style.background = good ? '#edf9f2' : warn ? '#fff7e6' : '#f1f5f9';
  el.style.color = good ? '#17a663' : warn ? '#c47b00' : '#64748b';

  await loadTasks().catch(() => {});
}

window.saveSelector = async (key) => {
  const value = $(`#sel_${key}`).value.trim();
  const timeout = Number($(`#timeout_${key}`).value || 30000);
  await window.api.saveSelector({ key, value, timeout });
  alert('已保存');
};

window.deleteChannel = async (id) => {
  if (!confirm('确定删除这个频道？')) return;
  await window.api.deleteChannel(id);
  await loadChannels();
};

window.editChannelName = (id) => {
  const channel = channelRows.find(item => item.id === Number(id));
  if (!channel) return alert('频道不存在，请刷新后重试');
  $('#channelEditId').value = channel.id;
  $('#channelEditName').value = channel.name;
  $('#channelEditDialog').showModal();
  setTimeout(() => $('#channelEditName').select(), 0);
};

$('#btnCloseChannelEdit').addEventListener('click', () => $('#channelEditDialog').close());
$('#btnCancelChannelEdit').addEventListener('click', () => $('#channelEditDialog').close());
$('#channelEditForm').addEventListener('submit', async (event) => {
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

$('#instanceSelect').addEventListener('change', async (e) => {
  currentInstanceId = Number(e.target.value);
  $('#channelInstanceSelect').value = String(currentInstanceId);
  $('#channelSaveResult').textContent = '';
  selectedTaskIds.clear();
  selectedTaskId = null;
  taskPage = 1;
  lastRenderedTaskSnapshot = '';
  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
  await syncBrowserView();
});

$('#btnNewInstance').addEventListener('click', async () => {
  $('#instanceForm').dataset.mode = 'create';
  $('#instanceDialogTitle').textContent = '新建实例';
  $('#instanceDialogDescription').textContent = '实例用于分组管理频道；QQ 登录状态由所有实例共用。';
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
$('#instanceForm').addEventListener('submit', async (event) => {
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
      $('#instanceDialog').close();
      await loadInstances();
    } else {
      await window.api.updateInstanceName({ id: currentInstanceId, name });
      $('#instanceDialog').close();
      await loadInstances();
    }
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
  const ok = confirm(`确定删除实例“${instance.name}”？\n\n将同时删除：\n- ${summary.channel_count || 0} 个本地频道配置\n- ${summary.task_count || 0} 条本地任务记录\n\n不会删除腾讯频道中的实际内容，也不会退出共享的 QQ 登录。此操作不可撤销。`);
  if (!ok) return;
  const button = $('#btnDeleteInstance');
  button.disabled = true;
  try {
    const result = await window.api.deleteInstance(currentInstanceId);
    $('#instanceDialog').close();
    currentInstanceId = null;
    await loadInstances();
    alert(`实例“${result.name}”已删除`);
  } catch (error) {
    alert(String(error?.message || error));
  } finally {
    button.disabled = false;
  }
});

$('#btnLogin').addEventListener('click', async () => {
  if (!currentInstanceId) return;
  const status = $('#loginStatus');
  status.textContent = '登录状态：正在准备二维码...';
  status.style.background = '#fff7e6';
  status.style.color = '#c47b00';
  try {
    const result = await window.api.openLogin(currentInstanceId);
    if (result?.alreadyLoggedIn || result?.loggedIn) {
      await checkLoginStatus(false);
      alert('QQ 频道发布授权已经登录，无需重复扫码。');
      return;
    }
    const qr = $('#publisherLoginQr');
    qr.src = result?.qrDataUrl || '';
    qr.classList.toggle('hidden', !result?.qrDataUrl);
    const link = $('#publisherLoginLink');
    link.href = result?.verificationUri || '#';
    link.classList.toggle('hidden', !result?.verificationUri);
    $('#publisherLoginMessage').textContent = result?.qrDataUrl
      ? '请使用手机 QQ 扫码，完成后点击“我已完成扫码”。'
      : '二维码未能显示，请打开授权链接完成登录。';
    $('#publisherLoginDialog').showModal();
    status.textContent = '登录状态：等待扫码授权';
  } catch (error) {
    status.textContent = '登录状态：二维码获取失败';
    alert(String(error?.message || error));
  }
});

$('#btnPollPublisherLogin').addEventListener('click', async () => {
  const button = $('#btnPollPublisherLogin');
  button.disabled = true;
  $('#publisherLoginMessage').textContent = '正在确认授权...';
  try {
    const result = await window.api.pollPublisherLogin();
    if (!result?.loggedIn) throw new Error(result?.message || '尚未完成扫码授权');
    $('#publisherLoginDialog').close();
    await checkLoginStatus(false);
    alert('QQ 频道发布授权登录成功。');
  } catch (error) {
    $('#publisherLoginMessage').textContent = `授权未完成：${String(error?.message || error)}`;
  } finally {
    button.disabled = false;
  }
});

$('#btnCheckLogin').addEventListener('click', () => checkLoginStatus(true));
$('#btnBrowserHome').addEventListener('click', async () => { await window.api.browserHome(currentInstanceId); await syncBrowserView(); });
$('#btnBrowserBack').addEventListener('click', async () => { await window.api.browserBack(currentInstanceId); });
$('#btnBrowserReload').addEventListener('click', async () => { await window.api.browserReload(currentInstanceId); });

$('#channelInstanceSelect').addEventListener('change', async (event) => {
  const nextInstanceId = Number(event.target.value);
  if (!nextInstanceId || nextInstanceId === currentInstanceId) return;
  currentInstanceId = nextInstanceId;
  $('#instanceSelect').value = String(nextInstanceId);
  $('#channelSaveResult').textContent = '';
  selectedTaskIds.clear();
  selectedTaskId = null;
  taskPage = 1;
  lastRenderedTaskSnapshot = '';
  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
  await syncBrowserView();
});

$('#btnAddChannel').addEventListener('click', async () => {
  const instanceId = Number($('#channelInstanceSelect').value || currentInstanceId);
  const name = $('#channelName').value.trim();
  const url = $('#channelUrl').value.trim();
  const result = $('#channelSaveResult');
  if (!instanceId) return alert('请先选择频道所属实例');
  if (!name || !url) return alert('频道名称和URL不能为空');
  try {
    await window.api.addChannel({ instanceId, name, url });
    $('#channelName').value = '';
    $('#channelUrl').value = '';
    const instance = instanceRows.find(item => Number(item.id) === instanceId);
    result.textContent = `已保存到实例“${instance?.name || instanceId}”`;
    if (instanceId === currentInstanceId) await loadChannels();
  } catch (error) {
    result.textContent = `保存失败：${String(error?.message || error)}`;
  }
});

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

$('#btnCreateTask').addEventListener('click', async () => {
  $('#taskMediaType').value = 'text';
  $('#taskMediaRow').classList.add('hidden');
  $('#mediaPath').value = '';
  $('#taskStartTime').value = '';
  $('#taskIntervalMin').value = runtimeSettings.interval_min_seconds ?? '180';
  $('#taskIntervalMax').value = runtimeSettings.interval_max_seconds ?? '480';
  await loadChannels();
  $('#taskDialog').showModal();
});

$('#btnPickMedia').addEventListener('click', async () => {
  const type = $('#taskMediaType').value;
  const p = type === 'image' ? await window.api.pickImage() : await window.api.pickVideo();
  if (p) $('#mediaPath').value = p;
});

$('#btnSelectAll').addEventListener('click', () => {
  $$('#taskChannelList input[type="checkbox"]').forEach(x => x.checked = true);
  updateTaskTargetSummary();
});

$('#btnSaveTask').addEventListener('click', async () => {
  const mediaType = $('#taskMediaType').value;
  const mediaPath = $('#mediaPath').value.trim();
  const title = $('#taskTitle').value.trim();
  const body = $('#taskBodyText').value.trim();
  const startTimeValue = $('#taskStartTime').value;
  let intervalMinSeconds = Number($('#taskIntervalMin').value || 0);
  let intervalMaxSeconds = Number($('#taskIntervalMax').value || 0);
  const channelIds = $$('#taskChannelList input[type="checkbox"]:checked').map(x => Number(x.value));
  if (mediaType === 'image' && !mediaPath) return alert('请选择图片');
  if (mediaType === 'video' && !mediaPath) return alert('请选择视频');
  if (!channelIds.length) return alert('至少选择一个频道');
  if (!Number.isFinite(intervalMinSeconds) || !Number.isFinite(intervalMaxSeconds) || intervalMinSeconds < 0 || intervalMaxSeconds < 0) return alert('随机间隔必须是大于或等于 0 的秒数');
  if (intervalMaxSeconds < intervalMinSeconds) [intervalMinSeconds, intervalMaxSeconds] = [intervalMaxSeconds, intervalMinSeconds];
  const scheduledAt = startTimeValue ? new Date(startTimeValue).toISOString() : null;
  if (!body && !title) {
    if (mediaType === 'text') return alert('纯文本任务必须填写评论或标题');
    if (!confirm(`当前任务没有填写评论/标题，只发布${mediaType === 'image' ? '图片' : '视频'}，是否继续？`)) return;
  }
  await window.api.createTask({
    instanceId: currentInstanceId,
    title,
    body: body || title,
    mediaPath,
    mediaType,
    channelIds,
    scheduledAt,
    intervalMinSeconds,
    intervalMaxSeconds
  });
  $('#taskDialog').close();
  $('#mediaPath').value = '';
  $('#taskTitle').value = '';
  $('#taskBodyText').value = '';
  await loadTasks(true);
  await refreshSchedulerState();
});

$('#btnBatchVideo').addEventListener('click', async () => {
  batchVideoFiles = [];
  $('#batchFolder').value = '';
  $('#batchBody').value = '';
  $('#batchVideoSummary').textContent = '尚未选择目录';
  $('#batchVideoFiles').innerHTML = '';
  const channels = await window.api.listChannels(currentInstanceId);
  $('#batchChannelList').innerHTML = channels.length ? channels.map(c => `
    <label class="target-check"><input type="checkbox" value="${c.id}"><span>${escapeHtml(c.name)}</span></label>`).join('') : '<div class="hint">请先添加频道。</div>';
  $('#batchVideoDialog').showModal();
});

$('#btnPickVideoFolder').addEventListener('click', async () => {
  const result = await window.api.pickVideoFolder();
  if (!result) return;
  batchVideoFiles = result.files || [];
  $('#batchFolder').value = result.folder || '';
  $('#batchVideoSummary').textContent = `识别到 ${batchVideoFiles.length} 个视频文件`;
  $('#batchVideoFiles').innerHTML = batchVideoFiles.map((p, i) => `<div class="channel-item"><strong>${i + 1}</strong><div class="channel-url" title="${escapeHtml(p)}">${escapeHtml(fileName(p))}</div><span>待创建</span></div>`).join('');
});

$('#btnBatchSelectAll').addEventListener('click', () => {
  $$('#batchChannelList input[type="checkbox"]').forEach(x => x.checked = true);
});

$('#btnCreateBatchTasks').addEventListener('click', async () => {
  const channelIds = $$('#batchChannelList input[type="checkbox"]:checked').map(x => Number(x.value));
  const bodyTemplate = $('#batchBody').value;
  if (!batchVideoFiles.length) return alert('请先选择包含视频的目录');
  if (!channelIds.length) return alert('至少选择一个频道');
  if (!confirm(`将创建 ${batchVideoFiles.length} 个视频任务，发布到 ${channelIds.length} 个频道。是否继续？`)) return;
  for (const p of batchVideoFiles) {
    const stem = fileStem(p);
    const body = bodyTemplate.replaceAll('{filename}', stem);
    await window.api.createTask({
      instanceId: currentInstanceId,
      title: stem,
      body,
      mediaPath: p,
      mediaType: 'video',
      channelIds,
      scheduledAt: null,
      intervalMinSeconds: Number(runtimeSettings.interval_min_seconds ?? 180),
      intervalMaxSeconds: Number(runtimeSettings.interval_max_seconds ?? 480)
    });
  }
  $('#batchVideoDialog').close();
  await loadTasks(true);
  await refreshSchedulerState();
  alert(`已创建 ${batchVideoFiles.length} 个视频任务`);
});

$('#btnQueueStart').addEventListener('click', async () => {
  try {
    await activateTab('tasks');
    const r = await window.api.schedulerStart(currentInstanceId);
    if (r?.reason === 'login_required') {
      alert('QQ 未登录或登录已失效，请先点击“登录QQ”');
      await checkLoginStatus(false);
    } else if (r?.reason === 'empty') {
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

$('#btnRunTask').addEventListener('click', async () => {
  if (selectedTaskIds.size !== 1) return alert('执行任务时请只选择一条任务');
  selectedTaskId = [...selectedTaskIds][0];
  const task = taskRows.find(row => row.id === selectedTaskId);
  if (!task) return alert('要执行的任务不在当前页，请回到该任务所在页后操作');
  const targets = task?.targets?.filter(target => target.status !== 'success') || [];
  if (!targets.length) return alert('该任务没有需要发布的目标频道');
  if (!confirm(`任务 #${selectedTaskId} 将在工具后台发布到以下频道：\n\n${formatChannelList(targets.map(target => target.channel_name))}\n\n多频道会按顺序逐个发布，是否继续？`)) return;
  try {
    await activateTab('tasks');
    const result = await window.api.runTask(selectedTaskId);
    renderPublishResult(result);
  } catch (e) {
    alert(String(e?.message || e));
  }
  await loadTasks(true);
  await loadLogs();
  await checkLoginStatus(false);
});

$('#btnRetryTask').addEventListener('click', async () => {
  if (selectedTaskIds.size !== 1) return alert('重试任务时请只选择一条任务');
  selectedTaskId = [...selectedTaskIds][0];
  const task = taskRows.find(row => row.id === selectedTaskId);
  if (!task) return alert('要重试的任务不在当前页，请回到该任务所在页后操作');
  const failedTargets = task?.targets?.filter(target => target.status === 'failed') || [];
  if (!failedTargets.length) return alert('该任务没有失败的目标频道');
  if (!confirm(`只重新发布到以下失败频道：\n\n${formatChannelList(failedTargets.map(target => target.channel_name))}\n\n是否继续？`)) return;
  try {
    await activateTab('tasks');
    const result = await window.api.retryFailedTask(selectedTaskId);
    renderPublishResult(result);
  } catch (e) {
    alert(String(e?.message || e));
  }
  await loadTasks(true);
  await loadLogs();
});

$('#btnDeleteTask').addEventListener('click', async () => {
  const ids = [...selectedTaskIds];
  if (!ids.length) return alert('请先选择要删除的任务');
  if (!confirm(`确定删除选中的 ${ids.length} 条任务？\n\n成功、失败和待发布任务都会从工具中删除；正在发布的任务会自动跳过。不会删除腾讯频道中已经发布的内容。`)) return;
  const result = await window.api.deleteTasks(ids);
  selectedTaskIds.clear();
  selectedTaskId = null;
  await loadTasks(true);
  await refreshSchedulerState();
  alert(`已删除 ${result.deletedCount || 0} 条任务${result.skippedRunningCount ? `，跳过 ${result.skippedRunningCount} 条正在发布的任务` : ''}`);
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

$('#taskPageSize').addEventListener('change', async (event) => {
  taskPageSize = Number(event.target.value) || 10;
  taskPage = 1;
  lastRenderedTaskSnapshot = '';
  await loadTasks(true);
});

$('#taskSelectAll').addEventListener('change', (event) => {
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

$('#btnTestSelector').addEventListener('click', async () => {
  const selector = $('#testSelector').value.trim();
  const url = $('#testUrl').value.trim();
  if (!selector) return alert('请输入选择器');
  $('#testResult').textContent = '正在测试...';
  try {
    const r = await window.api.testSelector({ instanceId: currentInstanceId, selector, url });
    $('#testResult').textContent = `匹配数量：${r.count}，当前页面：${r.url}`;
  } catch (e) {
    $('#testResult').textContent = `失败：${e.message || e}`;
  }
});

$$('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));

window.addEventListener('resize', () => {
  clearTimeout(browserResizeTimer);
  browserResizeTimer = setTimeout(() => syncBrowserView().catch(() => {}), 80);
});

function fileName(p) { return String(p || '').split(/[\\/]/).pop(); }
function compactFileName(p, maxLength = 28) {
  const name = fileName(p);
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
  // SQLite CURRENT_TIMESTAMP 保存的是 UTC，格式通常为 YYYY-MM-DD HH:mm:ss，
  // JS 直接 new Date(raw) 会按本地时间解释，导致东八区显示少 8 小时。
  if (assumeSqliteUtc && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw.replace(' ', 'T') + 'Z');
  }
  return new Date(raw);
}
function formatBeijingDateTime(value, assumeSqliteUtc = false) {
  const date = normalizeStoredDateTime(value, assumeSqliteUtc);
  if (!date || Number.isNaN(date.getTime())) return String(value || '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}
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
function fileStem(p) {
  const name = fileName(p);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c])); }
function escapeAttr(s='') { return escapeHtml(s); }

function targetStatusLabel(status) {
  return ({ pending: '待发', running: '发布中', success: '成功', failed: '失败' })[status] || status || '未知';
}

function renderTargetChips(targets = []) {
  return targets.map(target => `
    <span class="target-status-chip ${escapeAttr(target.status)}">
      ${escapeHtml(target.channel_name)} · ${escapeHtml(targetStatusLabel(target.status))}
    </span>`).join('');
}

function formatChannelList(names = []) {
  const unique = [...new Set(names.filter(Boolean))];
  const shown = unique.slice(0, 20).map((name, index) => `${index + 1}. ${name}`).join('\n');
  if (!shown) return '（无）';
  return unique.length > 20 ? `${shown}\n……另有 ${unique.length - 20} 个频道` : shown;
}

function updateTaskTargetSummary() {
  const summary = $('#taskTargetSummary');
  if (!summary) return;
  const count = $$('#taskChannelList input[type="checkbox"]:checked').length;
  summary.textContent = `已选 ${count} 个`;
}

function showPublishProgress(content, state = '') {
  const progress = $('#publishProgress');
  if (!progress) return;
  progress.className = `publish-progress${state ? ` ${state}` : ''}`;
  progress.innerHTML = content;
}

function renderPublishResult(result = {}) {
  const targets = result.targets || [];
  const success = Boolean(result.success);
  const summary = success
    ? `任务 #${result.taskId} 发布完成：成功 ${result.successCount || 0} 个频道`
    : `任务 #${result.taskId} 发布结束：成功 ${result.successCount || 0} 个，失败 ${result.failedCount || 0} 个频道`;
  const chips = targets.length
    ? `<div class="target-status-list publish-result-targets">${renderTargetChips(targets.map(target => ({
        channel_name: target.channelName,
        status: target.status
      })))}</div>`
    : '';
  showPublishProgress(`<strong>${escapeHtml(summary)}</strong>${chips}`, success ? 'success' : 'failed');
}

async function handlePublishUpdate(data = {}) {
  if (Number(data.instanceId) !== currentInstanceId) return;
  if (data.type === 'task-started') {
    await activateTab('tasks');
    showPublishProgress(`<strong>任务 #${data.taskId} 正在发布</strong><br>目标频道：${escapeHtml((data.channels || []).join('、'))}`);
  } else if (data.type === 'target-started') {
    showPublishProgress(`<strong>任务 #${data.taskId} 正在发布到：${escapeHtml(data.channelName)}</strong><br>第 ${Number(data.attempt) || 1} 次尝试`);
  } else if (data.type === 'target-waiting') {
    showPublishProgress(`<strong>当前频道处理完成</strong><br>${Number(data.seconds) || 0} 秒后发布到：${escapeHtml(data.nextChannelName)}`);
  } else if (data.type === 'target-finished') {
    const success = data.status === 'success';
    showPublishProgress(`<strong>${escapeHtml(data.channelName)}：${success ? '发布成功' : '发布失败'}</strong>`, success ? 'success' : 'failed');
  } else if (data.type === 'task-finished') {
    await activateTab('tasks');
    renderPublishResult(data);
    await Promise.all([loadTasks(true), loadLogs(), refreshSchedulerState()]);
  }
}

if (window.api.onPublishUpdate) {
  window.api.onPublishUpdate(data => handlePublishUpdate(data).catch(() => {}));
}

loadInstances();
