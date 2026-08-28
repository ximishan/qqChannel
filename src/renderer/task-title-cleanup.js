(() => {
  const $ = selector => document.querySelector(selector);

  function installStyles() {
    if ($('#taskTitleCleanupStyle')) return;
    const style = document.createElement('style');
    style.id = 'taskTitleCleanupStyle';
    style.textContent = `
      /* 任务列表不再展示“任务标题”列；底层字段仅保留兼容旧数据。 */
      #tasks .table-wrap table th:nth-child(5),
      #tasks .table-wrap table td:nth-child(5){display:none}
    `;
    document.head.appendChild(style);
  }

  function getTitleLabel() {
    const input = $('#taskTitle');
    if (!input) return null;
    const previous = input.previousElementSibling;
    return previous && previous.tagName === 'LABEL' ? previous : null;
  }

  function syncTextContentField() {
    const type = $('#taskMediaType')?.value || 'text';
    const input = $('#taskTitle');
    const label = getTitleLabel();
    if (!input || !label) return;

    if (type === 'text') {
      label.style.display = '';
      input.style.display = '';
      label.textContent = '发布内容';
      input.placeholder = '请输入要发布的文本内容';
    } else {
      // 图片/视频任务没有帖子标题概念，完全隐藏，避免用户误解。
      label.style.display = 'none';
      input.style.display = 'none';
      input.value = '';
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    installStyles();
    const mediaType = $('#taskMediaType');
    mediaType?.addEventListener('change', syncTextContentField);

    // 新建任务脚本会把类型恢复为“纯文本”，这里同步一次显示状态。
    $('#btnCreateTask')?.addEventListener('click', () => setTimeout(syncTextContentField, 0));
    syncTextContentField();
  });
})();
