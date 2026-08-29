module.exports = function installCommentDomFixSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalizeText = value => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const mergeSelectorConfig = (config, fallbacks, defaultTimeout = 20000) => {
    const existing = config?.value
      ? String(config.value).split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : [];
    const candidates = [...new Set([...fallbacks, ...existing])];
    return {
      ...(config || {}),
      value: candidates.join('\n'),
      timeout: Number(config?.timeout || defaultTimeout)
    };
  };

  const originalInit = DB.prototype.init;
  DB.prototype.init = function patchedCommentDomInit() {
    originalInit.call(this);

    const currentInput = this.db.prepare("SELECT value FROM selector_configs WHERE key='comment_input'").get()?.value || '';
    const currentSubmit = this.db.prepare("SELECT value FROM selector_configs WHERE key='comment_submit'").get()?.value || '';

    const knownInput = '.comment-editor-container .ProseMirror[contenteditable="true"]\n.comment-editor-container [contenteditable="true"]';
    const knownSubmit = '.comment-editor-container button:has-text("发送")';

    if (!currentInput || currentInput === knownInput) {
      this.db.prepare("UPDATE selector_configs SET value=?, timeout=25000 WHERE key='comment_input'").run(
        '.comment-editor-container .editorRoot .ProseMirror[contenteditable="true"]\n.comment-editor-container .ProseMirror[contenteditable="true"]'
      );
    }

    if (!currentSubmit || currentSubmit === knownSubmit) {
      this.db.prepare("UPDATE selector_configs SET value=?, timeout=20000 WHERE key='comment_submit'").run(
        '.comment-editor-container .publish-button button.g-button\n.comment-editor-container .publish-button button\n.comment-editor-container button:has-text("发送")'
      );
    }
  };

  BrowserManager.prototype.readCommentDomSnapshot = async function readCommentDomSnapshot(webContents) {
    return webContents.executeJavaScript(`(() => {
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const normalize = value => String(value || '')
        .replace(/[\\u200B-\\u200D\\uFEFF]/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
      const parseCount = value => {
        const match = normalize(value).match(/(\\d+)/);
        return match ? Number(match[1]) : null;
      };
      const detailCandidates = [...document.querySelectorAll('.game-guild-detail.long-feed-detail, .game-guild-detail')];
      const scope = detailCandidates.find(visible) || detailCandidates[detailCandidates.length - 1] || document;
      const items = [...scope.querySelectorAll('.comment-list .comment-list-item')].map((item, index) => ({
        id: String(item.id || ''),
        index,
        text: normalize(
          item.querySelector('.comment-richcontent .feed-detail-text')?.innerText ||
          item.querySelector('.comment-richcontent')?.innerText ||
          ''
        )
      }));
      const countText = scope.querySelector('.comment-bar__comment-count')?.innerText || '';
      const bottomCountText = scope.querySelector('.bottom-comment-input .comment-container[dt-params*="sgrp_click_region=2"] .comment-text')?.innerText || '';
      const editor = scope.querySelector('.comment-editor-container');
      const input = scope.querySelector('.comment-editor-container .ProseMirror[contenteditable="true"]');
      const submit = scope.querySelector('.comment-editor-container .publish-button button');
      return {
        count: parseCount(countText),
        countText: normalize(countText),
        bottomCount: parseCount(bottomCountText),
        bottomCountText: normalize(bottomCountText),
        items,
        editorPresent: Boolean(editor),
        editorVisible: Boolean(editor && visible(editor)),
        inputPresent: Boolean(input),
        inputText: normalize(input?.innerText || input?.textContent || ''),
        submitPresent: Boolean(submit),
        submitDisabled: submit ? Boolean(submit.disabled) || submit.getAttribute('aria-disabled') === 'true' || submit.classList.contains('disabled') : null
      };
    })()`, true);
  };

  BrowserManager.prototype.waitCommentSubmitEnabled = async function waitCommentSubmitEnabled(webContents, config) {
    const timeout = Number(config?.timeout || 20000);
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      last = await this.elementAction(webContents, config, 'inspect').catch(() => null);
      if (last?.found && last.visible && !last.disabled) return last;
      await sleep(150);
    }
    if (last?.found && last.visible && last.disabled) {
      throw new Error(`评论内容已写入，但“发送”按钮在 ${Math.round(timeout / 1000)} 秒内一直处于禁用状态`);
    }
    throw new Error(`等待评论“发送”按钮超时（${Math.round(timeout / 1000)}秒）`);
  };

  BrowserManager.prototype.verifyCommentDomSuccess = async function verifyCommentDomSuccess(webContents, expectedText, baseline) {
    const expected = normalizeText(expectedText);
    const timeout = Math.max(8000, Number(this.db.getSetting('publish_verify_timeout_ms', '20000')) || 20000);
    const baselineIds = new Set((baseline?.items || []).map(item => String(item.id || '')).filter(Boolean));
    const baselineItemCount = Array.isArray(baseline?.items) ? baseline.items.length : 0;
    const baselineCount = Number.isFinite(baseline?.count) ? Number(baseline.count) : null;
    const baselineBottomCount = Number.isFinite(baseline?.bottomCount) ? Number(baseline.bottomCount) : null;
    const deadline = Date.now() + timeout;
    let last = null;

    while (Date.now() < deadline) {
      last = await this.readCommentDomSnapshot(webContents).catch(() => null);
      if (last) {
        const matchingItems = (last.items || []).filter(item => normalizeText(item.text) === expected);
        const freshMatchingItem = matchingItems.find(item => {
          const id = String(item.id || '');
          if (id) return !baselineIds.has(id);
          return (last.items || []).length > baselineItemCount;
        });
        const countIncreased = baselineCount != null && last.count != null && last.count > baselineCount;
        const bottomCountIncreased = baselineBottomCount != null && last.bottomCount != null && last.bottomCount > baselineBottomCount;
        const editorClosed = baseline?.editorPresent && !last.editorPresent;

        if (freshMatchingItem) {
          return { verified: true, reason: `new_comment_item:${freshMatchingItem.id || freshMatchingItem.index}`, snapshot: last };
        }
        if (countIncreased && matchingItems.length) {
          return { verified: true, reason: 'comment_count_increased_and_text_found', snapshot: last };
        }
        if (countIncreased && editorClosed) {
          return { verified: true, reason: 'comment_count_increased_and_editor_closed', snapshot: last };
        }
        if (bottomCountIncreased && editorClosed) {
          return { verified: true, reason: 'bottom_comment_count_increased_and_editor_closed', snapshot: last };
        }
      }
      await sleep(250);
    }

    const details = last
      ? `最后状态：评论数=${last.countText || (last.count ?? '未知')}，底部评论数=${last.bottomCountText || (last.bottomCount ?? '未知')}，评论项=${(last.items || []).length}，编辑器=${last.editorPresent ? '仍存在' : '已关闭'}`
      : '未读取到评论区状态';
    throw new Error(`点击发送后未确认评论真正发布成功（${Math.round(timeout / 1000)}秒）。${details}`);
  };

  BrowserManager.prototype.postTaskComment = async function postTaskCommentWithDomVerification(webContents, selectors, comment) {
    const text = normalizeText(comment);
    if (!text) return { skipped: true };

    await sleep(1200);

    const inputConfig = mergeSelectorConfig(selectors.comment_input, [
      '.comment-editor-container .editorRoot .ProseMirror[contenteditable="true"]',
      '.comment-editor-container .ProseMirror[contenteditable="true"]'
    ], 25000);
    const submitConfig = mergeSelectorConfig(selectors.comment_submit, [
      '.comment-editor-container .publish-button button.g-button',
      '.comment-editor-container .publish-button button',
      '.comment-editor-container button:has-text("发送")'
    ], 20000);
    const effectiveSelectors = {
      ...selectors,
      comment_input: inputConfig,
      comment_submit: submitConfig
    };

    try {
      await this.openCommentComposer(webContents, effectiveSelectors);
    } catch (error) {
      error.postUrl = webContents.getURL();
      throw error;
    }

    const baseline = await this.readCommentDomSnapshot(webContents).catch(() => ({ items: [] }));
    const filled = await this.fillCommentControl(webContents, inputConfig, text);
    if (!filled?.found) throw new Error('评论内容写入失败');

    const actualText = normalizeText(filled.value);
    if (!actualText.includes(text)) {
      throw new Error(`评论输入后校验失败：期望“${text.slice(0, 40)}”，实际“${actualText.slice(0, 40)}”`);
    }

    await this.waitCommentSubmitEnabled(webContents, submitConfig);
    const clicked = await this.elementAction(webContents, submitConfig, 'click');
    if (!clicked?.found) throw new Error('评论发送按钮点击失败');

    const verified = await this.verifyCommentDomSuccess(webContents, text, baseline);
    this.db.log('info', `评论发送成功并已通过 DOM 校验：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}（${verified.reason}）`);
    return { skipped: false, postUrl: webContents.getURL(), verified: true, reason: verified.reason };
  };
};
