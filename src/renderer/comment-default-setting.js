(() => {
  const FALLBACK_DEFAULT_COMMENT = '迅雷搜《孟德精选》';
  const $ = selector => document.querySelector(selector);
  let savedDefaultComment = FALLBACK_DEFAULT_COMMENT;

  function mountSettingField() {
    const card = $('#settings > .card:first-child');
    const saveButton = $('#btnSaveRuntimeSettings');
    if (!card || !saveButton || $('#setting_default_comment')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'defaultCommentSettingRow';
    wrapper.style.marginTop = '18px';

    const label = document.createElement('label');
    label.htmlFor = 'setting_default_comment';
    label.textContent = '评论区默认值';

    const textarea = document.createElement('textarea');
    textarea.id = 'setting_default_comment';
    textarea.rows = 3;
    textarea.placeholder = '例如：迅雷搜《孟德精选》';
    textarea.style.resize = 'vertical';
    textarea.style.minHeight = '74px';

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = '保存后，新建发布任务和批量视频任务时会自动填入评论区，可在单个任务中临时修改。';

    wrapper.append(label, textarea, hint);
    card.insertBefore(wrapper, saveButton);
  }

  async function loadDefaultComment() {
    mountSettingField();
    const input = $('#setting_default_comment');
    if (!input) return;

    try {
      const rows = await window.api.listSettings();
      const item = (rows || []).find(row => row.key === 'default_comment');
      savedDefaultComment = item ? String(item.value ?? '') : FALLBACK_DEFAULT_COMMENT;
      input.value = savedDefaultComment;
    } catch (error) {
      console.error('读取评论区默认值失败', error);
      savedDefaultComment = FALLBACK_DEFAULT_COMMENT;
      input.value = savedDefaultComment;
    }
  }

  mountSettingField();
  loadDefaultComment();

  $('#btnSaveRuntimeSettings')?.addEventListener('click', async () => {
    const input = $('#setting_default_comment');
    if (!input) return;
    savedDefaultComment = String(input.value ?? '');
    try {
      await window.api.setSetting({ key: 'default_comment', value: savedDefaultComment });
    } catch (error) {
      console.error('保存评论区默认值失败', error);
    }
  });

  $('#btnCreateTask')?.addEventListener('click', () => {
    const body = $('#taskBodyText');
    if (body) body.value = savedDefaultComment;
  });

  $('#btnBatchVideo')?.addEventListener('click', () => {
    const body = $('#batchBody');
    if (body) body.value = savedDefaultComment;
  });

  document.querySelector('.tab[data-tab="settings"]')?.addEventListener('click', () => {
    loadDefaultComment();
  });
})();
