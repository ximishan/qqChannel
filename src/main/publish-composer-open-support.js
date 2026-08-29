module.exports = function installPublishComposerOpenSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  BrowserManager.prototype.ensureComposerOpen = async function ensureComposerOpenWithExpandedState(webContents, selectors) {
    const effective = this.publishDomSelectors ? this.publishDomSelectors(selectors || {}) : selectors;
    const timeout = Math.max(15000, Number(effective?.composer_entry?.timeout || 15000));
    const deadline = Date.now() + timeout;
    let clickedAt = 0;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      lastSnapshot = this.readPublishComposerSnapshot
        ? await this.readPublishComposerSnapshot(webContents).catch(() => null)
        : null;

      // QQ 频道收起状态的 editor-area 固定约 44px。ProseMirror 节点可能已经在 DOM 中，
      // 但被 overflow:hidden 裁掉，所以必须同时确认发布区域已经真正展开。
      const expanded = Boolean(
        lastSnapshot?.containerPresent &&
        lastSnapshot?.bodyPresent &&
        Number(lastSnapshot?.areaHeight || 0) > 60
      );

      if (expanded) {
        const body = await this.elementAction(webContents, effective.body_input, 'inspect').catch(() => null);
        if (body?.found) return body;
      }

      if (lastSnapshot?.containerPresent && Date.now() - clickedAt > 1200) {
        const clickResult = await webContents.executeJavaScript(`(() => {
          const visible = el => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
          };
          const container = document.querySelector('.publish-editor-container');
          if (!container) return { clicked: false, reason: 'container_missing' };
          const area = container.querySelector('.editor-area');
          const beforeHeight = area ? Math.round(area.getBoundingClientRect().height) : 0;
          const target = [
            container.querySelector('.editor-header.pointer'),
            container.querySelector('.editor-header'),
            area,
            container
          ].find(visible);
          if (!target) return { clicked: false, reason: 'entry_not_visible', beforeHeight };
          target.scrollIntoView({ block: 'center', inline: 'nearest' });
          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          target.click();
          return { clicked: true, beforeHeight, className: String(target.className || '') };
        })()`, true).catch(() => ({ clicked: false, reason: 'execute_failed' }));

        if (clickResult?.clicked) {
          clickedAt = Date.now();
          await sleep(350);
          continue;
        }
      }

      await sleep(250);
    }

    const snapshot = lastSnapshot || (this.readPublishComposerSnapshot
      ? await this.readPublishComposerSnapshot(webContents).catch(() => null)
      : null);

    if (!snapshot?.containerPresent) {
      throw new Error('频道页面已打开，但没有找到发帖组件 .publish-editor-container；本次尚未上传或发表任何内容，可安全重试');
    }

    const state = [
      `editorArea高度=${Number(snapshot.areaHeight || 0)}px`,
      `header=${snapshot.headerPresent ? '存在' : '不存在'}`,
      `ProseMirror=${snapshot.bodyPresent ? (snapshot.bodyVisible ? '存在' : '存在但不可见') : '不存在'}`,
      `发表按钮=${snapshot.publishButtonPresent ? (snapshot.publishButtonDisabled ? '存在/禁用' : '存在/可用') : '不存在'}`,
      `上传input=${snapshot.fileInputPresent ? '存在' : '不存在'}`
    ].join('，');

    throw new Error(`发帖编辑器未能真正展开（${state}）；本次尚未上传或发表任何内容，可安全重试`);
  };
};
