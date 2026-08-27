let currentInstanceId = null;
let selectedTaskId = null;
let schedulerTimer = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function loadInstances() {
  const rows = await window.api.listInstances();
  const sel = $('#instanceSelect');
  sel.innerHTML = rows.map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join('');
  if (!currentInstanceId && rows.length) currentInstanceId = rows[0].id;
  sel.value = currentInstanceId;
  currentInstanceId = Number(sel.value);
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
  const rows = await window.api.listChannels(currentInstanceId);
  $('#channelList').innerHTML = rows.length ? rows.map(c => `
    <div class="channel-item">
      <strong>${escapeHtml(c.name)}</strong>
      <div class="channel-url">${escapeHtml(c.url)}</div>
      <button onclick="deleteChannel(${c.id})">删除</button>
    </div>`).join('') : '<div class="hint">当前实例还没有频道。</div>';

  $('#taskChannelList').innerHTML = rows.length ? rows.map(c => `
    <label class="target-check">
      <input type="checkbox" value="${c.id}">
      <span>${escapeHtml(c.name)}</span>
    </label>`).join('') : '<div class="hint">请先添加频道。</div>';
}

async function loadTasks() {
  if (!currentInstanceId) return;
  const rows = await window.api.listTasks(currentInstanceId);
  $('#taskBody').innerHTML = rows.length ? rows.map(t => `
    <tr>
      <td><input type="radio" name="taskSel" value="${t.id}" ${selectedTaskId === t.id ? 'checked' : ''}></td>
      <td>${t.id}</td>
      <td>${escapeHtml(t.title || '(无标题)')}</td>
      <td title="${escapeHtml(t.media_path)}">${escapeHtml(fileName(t.media_path))}</td>
      <td title="${escapeAttr(t.targets.map(x => `${x.channel_name}:${x.status}${x.retry_count ? `(重试${x.retry_count})` : ''}`).join('\n'))}">${escapeHtml(t.targets.map(x => x.channel_name).join('、'))}</td>
      <td>视频</td>
      <td class="status-${t.status}">${escapeHtml(t.status)}</td>
      <td>${escapeHtml(t.created_at)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="hint">暂无任务。点击“多频道发布”创建第一条任务。</td></tr>';

  $$('input[name="taskSel"]').forEach(r => r.addEventListener('change', () => selectedTaskId = Number(r.value)));
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
  if ($('#setting_max_retries')) $('#setting_max_retries').value = map.max_retries ?? '2';
  if ($('#setting_upload_timeout_ms')) $('#setting_upload_timeout_ms').value = map.upload_timeout_ms ?? '120000';
  if ($('#setting_publish_verify_timeout_ms')) $('#setting_publish_verify_timeout_ms').value = map.publish_verify_timeout_ms ?? '20000';
  if ($('#setting_interval_min_seconds')) $('#setting_interval_min_seconds').value = map.interval_min_seconds ?? '180';
  if ($('#setting_interval_max_seconds')) $('#setting_interval_max_seconds').value = map.interval_max_seconds ?? '480';
  if ($('#setting_screenshot_on_error')) $('#setting_screenshot_on_error').value = map.screenshot_on_error ?? '1';
}

async function loadLogs() {
  const rows = await window.api.listLogs();
  $('#logBox').textContent = rows.map(r => `[${r.created_at}] [${r.level.toUpperCase()}] ${r.message}`).join('\n');
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

  if (['idle', 'stopped', 'error'].includes(s.status)) {
    await loadTasks().catch(() => {});
  }
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

$('#instanceSelect').addEventListener('change', async (e) => {
  currentInstanceId = Number(e.target.value);
  selectedTaskId = null;
  await refreshAll();
  await checkLoginStatus(false);
  await refreshSchedulerState();
});

$('#btnNewInstance').addEventListener('click', async () => {
  const name = prompt('实例名称：', `实例 ${Date.now().toString().slice(-4)}`);
  if (!name) return;
  await window.api.createInstance(name);
  currentInstanceId = null;
  await loadInstances();
});

$('#btnLogin').addEventListener('click', async () => {
  if (!currentInstanceId) return;
  try {
    const r = await window.api.openLogin(currentInstanceId);
    if (r?.loggedIn) await checkLoginStatus(false);
  } catch (e) {
    alert(String(e?.message || e));
  }
});

$('#btnCheckLogin').addEventListener('click', () => checkLoginStatus(true));

$('#btnQueueStart').addEventListener('click', async () => {
  const status = await window.api.getLoginStatus(currentInstanceId).catch(() => ({loggedIn:false}));
  if (!status.loggedIn) return alert('请先登录 QQ，再启动发布队列');
  await window.api.schedulerStart(currentInstanceId);
  await refreshSchedulerState();
});

$('#btnQueuePause').addEventListener('click', async () => {
  await window.api.schedulerPause(currentInstanceId);
  await refreshSchedulerState();
});

$('#btnQueueResume').addEventListener('click', async () => {
  const status = await window.api.getLoginStatus(currentInstanceId).catch(() => ({loggedIn:false}));
  if (!status.loggedIn) return alert('当前 QQ 未登录，重新登录后再继续');
  await window.api.schedulerResume(currentInstanceId);
  await refreshSchedulerState();
});

$('#btnQueueStop').addEventListener('click', async () => {
  await window.api.schedulerStop(currentInstanceId);
  await refreshSchedulerState();
});

$('#btnAddChannel').addEventListener('click', async () => {
  const name = $('#channelName').value.trim();
  const url = $('#channelUrl').value.trim();
  if (!name || !url) return alert('频道名称和URL不能为空');
  if (!/^https:\/\/pd\.qq\.com\/g\//i.test(url)) return alert('请输入有效的腾讯频道 URL，例如 https://pd.qq.com/g/xxxx');
  await window.api.addChannel({ instanceId: currentInstanceId, name, url });
  $('#channelName').value = '';
  $('#channelUrl').value = '';
  await loadChannels();
});

$('#btnRefreshChannels').onclick = loadChannels;
$('#btnRefreshTasks').onclick = loadTasks;
$('#btnRefreshLogs').onclick = loadLogs;
$('#btnCreateTask').addEventListener('click', () => $('#taskDialog').showModal());

$('#btnPickVideo').addEventListener('click', async () => {
  const p = await window.api.pickVideo();
  if (p) $('#mediaPath').value = p;
});

$('#btnSelectAll').addEventListener('click', () => {
  $$('#taskChannelList input[type="checkbox"]').forEach(x => x.checked = true);
});

$('#btnSaveTask').addEventListener('click', async () => {
  const mediaPath = $('#mediaPath').value.trim();
  const title = $('#taskTitle').value.trim();
  const body = $('#taskBodyText').value.trim();
  const channelIds = $$('#taskChannelList input[type="checkbox"]:checked').map(x => Number(x.value));
  if (!mediaPath) return alert('请选择视频');
  if (!channelIds.length) return alert('至少选择一个频道');
  if (!body && !title) {
    if (!confirm('当前任务没有填写正文/标题，只发布视频，是否继续？')) return;
  }
  await window.api.createTask({ instanceId: currentInstanceId, title, body: body || title, mediaPath, channelIds });
  $('#taskDialog').close();
  $('#mediaPath').value = '';
  $('#taskTitle').value = '';
  $('#taskBodyText').value = '';
  await loadTasks();
  await refreshSchedulerState();
});

$('#btnRunTask').addEventListener('click', async () => {
  if (!selectedTaskId) return alert('请先选择一条任务');
  if (!confirm(`执行任务 #${selectedTaskId}？\n\n这会绕过队列间隔，立即真实尝试发表。`)) return;
  try {
    await window.api.runTask(selectedTaskId);
  } catch (e) {
    alert(String(e?.message || e));
  }
  await loadTasks();
  await loadLogs();
  await checkLoginStatus(false);
});

$('#btnRetryTask').addEventListener('click', async () => {
  if (!selectedTaskId) return alert('请先选择一条任务');
  if (!confirm(`只重新执行任务 #${selectedTaskId} 中失败的目标频道？`)) return;
  try {
    await window.api.retryFailedTask(selectedTaskId);
  } catch (e) {
    alert(String(e?.message || e));
  }
  await loadTasks();
  await loadLogs();
});

$('#btnSaveRuntimeSettings').addEventListener('click', async () => {
  let minSec = Number($('#setting_interval_min_seconds').value || 0);
  let maxSec = Number($('#setting_interval_max_seconds').value || 0);
  if (minSec < 0 || maxSec < 0) return alert('随机间隔不能小于 0 秒');
  if (maxSec < minSec) [minSec, maxSec] = [maxSec, minSec];
  $('#setting_interval_min_seconds').value = minSec;
  $('#setting_interval_max_seconds').value = maxSec;

  const items = [
    ['max_retries', $('#setting_max_retries').value],
    ['upload_timeout_ms', $('#setting_upload_timeout_ms').value],
    ['publish_verify_timeout_ms', $('#setting_publish_verify_timeout_ms').value],
    ['interval_min_seconds', String(minSec)],
    ['interval_max_seconds', String(maxSec)],
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

$$('.tab').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.remove('active'));
  $$('.panel').forEach(x => x.classList.remove('active'));
  btn.classList.add('active');
  $('#' + btn.dataset.tab).classList.add('active');
}));

function fileName(p) { return String(p || '').split(/[\\/]/).pop(); }
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s='') { return escapeHtml(s); }

loadInstances();
