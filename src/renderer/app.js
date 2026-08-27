let currentInstanceId = null;
let selectedTaskId = null;

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
}

async function refreshAll() {
  await Promise.all([loadTasks(), loadChannels(), loadSelectors(), loadLogs()]);
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
      <td>${escapeHtml(t.targets.map(x => x.channel_name).join('、'))}</td>
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
      <input id="sel_${r.key}" value="${escapeAttr(r.value)}">
      <input id="timeout_${r.key}" type="number" value="${r.timeout}">
      <button onclick="saveSelector('${r.key}')">保存</button>
    </div>`).join('');
}

async function loadLogs() {
  const rows = await window.api.listLogs();
  $('#logBox').textContent = rows.map(r => `[${r.created_at}] [${r.level.toUpperCase()}] ${r.message}`).join('\n');
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
  await window.api.openLogin(currentInstanceId);
});

$('#btnAddChannel').addEventListener('click', async () => {
  const name = $('#channelName').value.trim();
  const url = $('#channelUrl').value.trim();
  if (!name || !url) return alert('频道名称和URL不能为空');
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
  await window.api.createTask({ instanceId: currentInstanceId, title, body, mediaPath, channelIds });
  $('#taskDialog').close();
  $('#mediaPath').value = '';
  $('#taskTitle').value = '';
  $('#taskBodyText').value = '';
  await loadTasks();
});

$('#btnRunTask').addEventListener('click', async () => {
  if (!selectedTaskId) return alert('请先选择一条任务');
  if (!confirm(`执行任务 #${selectedTaskId}？\n\n请确认元素选择器已经按当前腾讯频道页面配置。`)) return;
  try { await window.api.runTask(selectedTaskId); } catch (e) { alert(String(e?.message || e)); }
  await loadTasks();
  await loadLogs();
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
