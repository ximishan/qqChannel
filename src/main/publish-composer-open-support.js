module.exports = function installPublishComposerOpenSupport(DB, BrowserManager) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  BrowserManager.prototype.clickPublishComposerEntry = async function clickPublishComposerEntry(webContents) {
    const point = await webContents.executeJavaScript(`(() => {
      const visible = el => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const container = document.querySelector('.publish-editor-container');
      if (!container) return { found: false, reason: 'container_missing' };
      const area = container.querySelector('.editor-area');
      const target = [
        container.querySelector('.editor-header.pointer'),
        container.querySelector('.editor-header'),
        area
      ].find(visible);
      if (!target) return { found: false, reason: 'entry_not_visible' };
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      return {
        found: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        className: String(target.className || ''),
        areaHeight: area ? Math.round(area.getBoundingClientRect().height) : 0
      };
    })()`, true).catch(() => ({ found: false, reason: 'point_read_failed' }));

    if (!point?.found) return { clicked: false, ...point };

    // 腾讯频道收起态只有 editor-header 可交互。普通 JS click() 在部分 Vue/Chromium
    // 状态下不会触发真正的展开事务，因此这里优先走 DevTools Protocol 的原生鼠标输入。
    try {
      if (!webContents.debugger.isAttached()) webContents.debugger.attach('1.3');
      await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'none'
      });
      await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });
      return { clicked: true, method: 'cdp', ...point };
    } catch (error) {
      // CDP 不可用时保留 DOM 事件兜底，避免个别 Electron 环境完全无法展开。
      const fallback = await webContents.executeJavaScript(`(() => {
        const container = document.querySelector('.publish-editor-container');
        const target = container?.querySelector('.editor-header.pointer') || container?.querySelector('.editor-header');
        if (!target) return false;
        target.focus?.();
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        target.click();
        return true;
      })()`, true).catch(() => false);
      return {
        clicked: Boolean(fallback),
        method: fallback ? 'dom-fallback' : 'failed',
        cdpError: String(error?.message || error),
        ...point
      };
    }
  };

  BrowserManager.prototype.ensureComposerOpen = async function ensureComposerOpenWithExpandedState(webContents, selectors) {
    const effective = this.publishDomSelectors ? this.publishDomSelectors(selectors || {}) : selectors;
    const timeout = Math.max(20000, Number(effective?.composer_entry?.timeout || 15000));
    const deadline = Date.now() + timeout;
    let clickedAt = 0;
    let clickAttempts = 0;
    let lastClick = null;
    let lastSnapshot = null;

    while (Date.now() < deadline) {
      lastSnapshot = this.readPublishComposerSnapshot
        ? await this.readPublishComposerSnapshot(webContents).catch(() => null)
        : null;

      // 当前用户提供的真实收起态 HTML：editor-root-container 已存在，但内部为空；
      // 展开后才会动态挂载 contenteditable ProseMirror，并且 editor-area 高度明显大于 44px。
      const expanded = Boolean(
        lastSnapshot?.containerPresent &&
        lastSnapshot?.bodyPresent &&
        (Number(lastSnapshot?.areaHeight || 0) > 60 || String(lastSnapshot?.areaClass || '').split(/\s+/).includes('expend'))
      );

      if (expanded) {
        const body = await this.elementAction(webContents, effective.body_input, 'inspect').catch(() => null);
        if (body?.found) return body;
      }

      if (lastSnapshot?.containerPresent && Date.now() - clickedAt > 1000) {
        lastClick = await this.clickPublishComposerEntry(webContents);
        clickAttempts += 1;
        clickedAt = Date.now();
        if (lastClick?.clicked) {
          await sleep(450);
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
      `editorArea类=${snapshot.areaClass || '无'}`,
      `header=${snapshot.headerPresent ? '存在' : '不存在'}`,
      `ProseMirror=${snapshot.bodyPresent ? (snapshot.bodyVisible ? '存在' : '存在但不可见') : '不存在'}`,
      `发表按钮=${snapshot.publishButtonPresent ? (snapshot.publishButtonDisabled ? '存在/禁用' : '存在/可用') : '不存在'}`,
      `上传input=${snapshot.fileInputPresent ? '存在' : '不存在'}`,
      `展开点击=${clickAttempts}次/${lastClick?.method || lastClick?.reason || '未执行'}`
    ].join('，');

    throw new Error(`发帖编辑器未能真正展开（${state}）；本次尚未上传或发表任何内容，可安全重试`);
  };
};