module.exports = function installPublishDomFixSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const mergeSelectorConfig = (config, fallbacks, defaultTimeout = 30000) => {
    const existing = config?.value
      ? String(config.value).split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : [];
    return {
      ...(config || {}),
      value: [...new Set([...fallbacks, ...existing])].join('\n'),
      timeout: Number(config?.timeout || defaultTimeout)
    };
  };

  const PUBLISH_SELECTORS = {
    composer_entry: [
      '.publish-editor-container .editor-header.pointer',
      '.publish-editor-container .editor-header',
      '.publish-editor-container .editor-area',
      '.publish-editor-container'
    ],
    body_input: [
      '.publish-editor-container .editor-root-container .ProseMirror[contenteditable="true"]',
      '.publish-editor-container .ProseMirror[contenteditable="true"]',
      '.editor-root-container .ProseMirror[contenteditable="true"]'
    ],
    publish_button: [
      '.publish-editor-container .publish-button button.g-button--primary',
      '.publish-editor-container .publish-button button',
      '.publish-button button.g-button--primary'
    ],
    file_input: [
      '.publish-editor-container .image-video-container input[type="file"][accept*="video"]',
      '.publish-editor-container .image-video-container input[type="file"]',
      'input[type="file"][accept*="video"]'
    ],
    image_input: [
      '.publish-editor-container .image-video-container input[type="file"][accept*="image"]',
      '.publish-editor-container .image-video-container input[type="file"]',
      'input[type="file"][accept*="image"]'
    ]
  };

  // 老版本 selector_configs 使用 INSERT OR IGNORE，升级程序后 SQLite 中仍可能保留旧选择器。
  // 这里把已验证的真实 QQ 频道发布页 DOM 选择器前置，同时保留用户自定义候选值。
  const originalInit = DB.prototype.init;
  DB.prototype.init = function patchedPublishDomInit() {
    originalInit.call(this);

    const rows = this.db.prepare(`
      SELECT key,value,timeout FROM selector_configs
      WHERE key IN ('composer_entry','body_input','publish_button','file_input','image_input')
    `).all();
    const byKey = new Map(rows.map(row => [row.key, row]));
    const update = this.db.prepare('UPDATE selector_configs SET value=?,timeout=?,name=? WHERE key=?');

    const definitions = [
      ['composer_entry', '发帖入口', PUBLISH_SELECTORS.composer_entry, 15000],
      ['body_input', '帖子正文编辑器 ProseMirror', PUBLISH_SELECTORS.body_input, 30000],
      ['publish_button', '发表按钮', PUBLISH_SELECTORS.publish_button, 30000],
      ['file_input', '视频上传 input', PUBLISH_SELECTORS.file_input, 30000],
      ['image_input', '图片上传 input', PUBLISH_SELECTORS.image_input, 30000]
    ];

    for (const [key, name, fallbacks, defaultTimeout] of definitions) {
      const current = byKey.get(key);
      if (!current) continue;
      const merged = mergeSelectorConfig(current, fallbacks, defaultTimeout);
      update.run(merged.value, merged.timeout, name, key);
    }
  };

  BrowserManager.prototype.publishDomSelectors = function publishDomSelectors(selectors) {
    return {
      ...selectors,
      composer_entry: mergeSelectorConfig(selectors?.composer_entry, PUBLISH_SELECTORS.composer_entry, 15000),
      body_input: mergeSelectorConfig(selectors?.body_input, PUBLISH_SELECTORS.body_input, 30000),
      publish_button: mergeSelectorConfig(selectors?.publish_button, PUBLISH_SELECTORS.publish_button, 30000),
      file_input: mergeSelectorConfig(selectors?.file_input, PUBLISH_SELECTORS.file_input, 30000),
      image_input: mergeSelectorConfig(selectors?.image_input, PUBLISH_SELECTORS.image_input, 30000)
    };
  };

  BrowserManager.prototype.readPublishComposerSnapshot = async function readPublishComposerSnapshot(webContents) {
    return webContents.executeJavaScript(`(() => {
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const container = document.querySelector('.publish-editor-container');
      const area = container?.querySelector('.editor-area') || null;
      const header = container?.querySelector('.editor-header') || null;
      const body = container?.querySelector('.editor-root-container .ProseMirror[contenteditable="true"]') || null;
      const button = container?.querySelector('.publish-button button') || null;
      const fileInput = container?.querySelector('.image-video-container input[type="file"]') || null;
      return {
        url: location.href,
        containerPresent: Boolean(container),
        containerVisible: Boolean(container && visible(container)),
        areaPresent: Boolean(area),
        areaVisible: Boolean(area && visible(area)),
        areaClass: String(area?.className || ''),
        areaHeight: area ? Math.round(area.getBoundingClientRect().height) : 0,
        headerPresent: Boolean(header),
        headerVisible: Boolean(header && visible(header)),
        bodyPresent: Boolean(body),
        bodyVisible: Boolean(body && visible(body)),
        bodyText: String(body?.innerText || body?.textContent || '').trim(),
        publishButtonPresent: Boolean(button),
        publishButtonDisabled: button ? Boolean(button.disabled) : null,
        fileInputPresent: Boolean(fileInput),
        accept: String(fileInput?.getAttribute('accept') || '')
      };
    })()`, true).catch(() => null);
  };

  // 覆盖旧逻辑：不再把“期待你的分享”文字本身当作发帖入口。
  // 真实结构中应点击 publish-editor-container 的 header/area，之后等待正文 ProseMirror 出现。
  BrowserManager.prototype.ensureComposerOpen = async function ensureComposerOpenByRealDom(webContents, selectors) {
    const effective = this.publishDomSelectors(selectors || {});
    const timeout = Math.max(15000, Number(effective.composer_entry?.timeout || 15000));

    let body = await this.elementAction(webContents, effective.body_input, 'inspect').catch(() => null);
    if (body?.found && body.visible) return body;

    const deadline = Date.now() + timeout;
    let clicked = false;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      body = await this.elementAction(webContents, effective.body_input, 'inspect').catch(() => null);
      if (body?.found && body.visible) return body;

      lastSnapshot = await this.readPublishComposerSnapshot(webContents);

      if (!clicked && lastSnapshot?.containerPresent) {
        const clickResult = await webContents.executeJavaScript(`(() => {
          const visible = el => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const container = document.querySelector('.publish-editor-container');
          if (!container) return { clicked: false, reason: 'container_missing' };
          const target = [
            container.querySelector('.editor-header.pointer'),
            container.querySelector('.editor-header'),
            container.querySelector('.editor-area'),
            container
          ].find(visible);
          if (!target) return { clicked: false, reason: 'entry_not_visible' };
          target.scrollIntoView({ block: 'center', inline: 'nearest' });
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          target.click();
          return { clicked: true, className: String(target.className || '') };
        })()`, true).catch(() => ({ clicked: false, reason: 'execute_failed' }));
        clicked = Boolean(clickResult?.clicked);
        if (clicked) await sleep(300);
        continue;
      }

      // 页面刚导航完成时发布组件可能稍后才挂载；允许在同一次任务内继续等待。
      await sleep(250);
    }

    const snapshot = lastSnapshot || await this.readPublishComposerSnapshot(webContents);
    if (!snapshot?.containerPresent) {
      throw new Error('频道页面已打开，但未找到发帖组件 .publish-editor-container；可能页面尚未加载完成或腾讯频道 DOM 已更新');
    }

    throw new Error(
      `发帖组件已找到，但正文编辑器未展开：` +
      `area=${snapshot.areaPresent ? '存在' : '不存在'}/高度${snapshot.areaHeight || 0}px，` +
      `header=${snapshot.headerPresent ? '存在' : '不存在'}，` +
      `ProseMirror=${snapshot.bodyPresent ? '存在但不可见' : '不存在'}，` +
      `fileInput=${snapshot.fileInputPresent ? '存在' : '不存在'}`
    );
  };

  // comment-support 已经包装了 publishOneTarget。这里再包一层，把正确的发布 DOM
  // 选择器传进去；comment-support 内部调用它捕获的基础发布函数时也会收到这份 effectiveSelectors。
  const originalPublishOneTarget = BrowserManager.prototype.publishOneTarget;
  BrowserManager.prototype.publishOneTarget = async function publishOneTargetWithPublishDom(record, task, target, selectors, attempt) {
    const effectiveSelectors = this.publishDomSelectors(selectors || {});
    return originalPublishOneTarget.call(this, record, task, target, effectiveSelectors, attempt);
  };
};
