(() => {
  const $ = selector => document.querySelector(selector);

  function installStyles() {
    if ($('#taskTitleCleanupStyle')) return;
    const style = document.createElement('style');
    style.id = 'taskTitleCleanupStyle';
    style.textContent = `
      #tasks .table-wrap table th:nth-child(5),
      #tasks .table-wrap table td:nth-child(5){display:none}
      #taskContent{min-height:96px;resize:vertical}
    `;
    document.head.appendChild(style);
  }

  function getTitleLabel() {
    const input = $('#taskTitle');
    if (!input) return null;
    const previous = input.previousElementSibling;
    return previous && previous.tagName === 'LABEL' ? previous : null;
  }

  function ensureContentField() {
    if ($('#taskContent')) return $('#taskContent');
    const comment = $('#taskBodyText');
    if (!comment) return null;
    const commentLabel = comment.previousElementSibling;

    const label = document.createElement('label');
    label.htmlFor = 'taskContent';
    label.textContent = '内容';

    const textarea = document.createElement('textarea');
    textarea.id = 'taskContent';
    textarea.rows = 5;
    textarea.placeholder = '请输入要发布到 QQ 频道的正文内容；图片、视频任务也可以填写';

    if (commentLabel?.parentNode) {
      commentLabel.parentNode.insertBefore(label, commentLabel);
      commentLabel.parentNode.insertBefore(textarea, commentLabel);
    } else {
      comment.parentNode?.insertBefore(label, comment);
      comment.parentNode?.insertBefore(textarea, comment);
    }
    return textarea;
  }

  function normalizeTitleField() {
    const input = $('#taskTitle');
    const label = getTitleLabel();
    if (!input || !label) return;
    label.textContent = '任务名称（可选）';
    input.placeholder = '仅用于本地识别；留空会自动生成，不会发布到 QQ 频道';
  }

  function install() {
    installStyles();
    ensureContentField();
    normalizeTitleField();

    $('#taskMediaType')?.addEventListener('change', normalizeTitleField);
    $('#btnCreateTask')?.addEventListener('click', () => {
      setTimeout(() => {
        ensureContentField();
        normalizeTitleField();
        if ($('#taskContent')) $('#taskContent').value = '';
        if ($('#taskTitle')) $('#taskTitle').value = '';
      }, 0);
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
