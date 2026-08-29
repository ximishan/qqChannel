module.exports = function installPublishOpenFallbackSupport(DB, BrowserManager) {
  const originalEnsureComposerOpen = BrowserManager.prototype.ensureComposerOpen;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  BrowserManager.prototype.ensureComposerOpen = async function ensureComposerOpenWithFallback(webContents, selectors) {
    try {
      // 保留 Codex 原来的主发布流程。正常情况下完全不改变任何行为。
      return await originalEnsureComposerOpen.call(this, webContents, selectors);
    } catch (error) {
      const message = String(error?.message || error || '');
      if (!message.includes('已点击发帖入口') || !message.includes('没有展开')) throw error;

      this.db.log('warn', '原发帖入口点击后正文编辑器未展开，启用真实 DOM 兜底点击');

      const deadline = Date.now() + 15000;
      let clickCount = 0;
      let lastState = null;

      while (Date.now() < deadline) {
        lastState = await webContents.executeJavaScript(`(() => {
          const visible = el => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
          };
          const container = document.querySelector('.publish-editor-container');
          const area = container?.querySelector('.editor-area') || null;
          const header = container?.querySelector('.editor-header.pointer') || container?.querySelector('.editor-header') || null;
          const body = container?.querySelector('.editor-root-container .ProseMirror[contenteditable="true"]') || null;
          const button = container?.querySelector('.publish-button button') || null;
          const fileInput = container?.querySelector('input[type="file"]') || null;
          const rect = header?.getBoundingClientRect() || null;
          return {
            container: Boolean(container),
            areaClass: String(area?.className || ''),
            areaHeight: area ? Math.round(area.getBoundingClientRect().height) : 0,
            header: Boolean(header),
            headerVisible: Boolean(header && visible(header)),
            headerText: String(header?.innerText || header?.textContent || '').trim(),
            x: rect ? Math.round(rect.left + rect.width / 2) : null,
            y: rect ? Math.round(rect.top + rect.height / 2) : null,
            body: Boolean(body),
            bodyVisible: Boolean(body && visible(body)),
            publishButton: Boolean(button),
            publishButtonDisabled: button ? Boolean(button.disabled) : null,
            fileInput: Boolean(fileInput)
          };
        })()`, true).catch(() => null);

        // 兜底不依赖 SQLite 中可能残留的旧 body_input，直接按当前真实 DOM 确认。
        if (lastState?.body && lastState?.bodyVisible) {
          const body = await this.elementAction(webContents, [
            '.publish-editor-container .editor-root-container .ProseMirror[contenteditable="true"]',
            '.publish-editor-container .ProseMirror[contenteditable="true"]'
          ], 'inspect').catch(() => null);
          if (body?.found) {
            this.db.log('info', `发帖编辑器兜底展开成功（点击 ${clickCount} 次）`);
            return body;
          }
        }

        if (lastState?.headerVisible && Number.isFinite(lastState.x) && Number.isFinite(lastState.y)) {
          try {
            // 使用 Electron 的真实输入事件点击 header 中心，避免 Vue 对脚本 click 的偶发忽略。
            webContents.sendInputEvent({ type: 'mouseMove', x: lastState.x, y: lastState.y });
            webContents.sendInputEvent({ type: 'mouseDown', x: lastState.x, y: lastState.y, button: 'left', clickCount: 1 });
            webContents.sendInputEvent({ type: 'mouseUp', x: lastState.x, y: lastState.y, button: 'left', clickCount: 1 });
            clickCount += 1;
          } catch (_) {
            await webContents.executeJavaScript(`(() => {
              const header = document.querySelector('.publish-editor-container .editor-header.pointer') ||
                document.querySelector('.publish-editor-container .editor-header');
              if (!header) return false;
              header.scrollIntoView({ block: 'center', inline: 'nearest' });
              header.click();
              return true;
            })()`, true).catch(() => false);
            clickCount += 1;
          }
        }

        await sleep(750);
      }

      const stateText = lastState
        ? `container=${lastState.container ? '有' : '无'}, header=${lastState.headerVisible ? '可见' : (lastState.header ? '不可见' : '无')}, headerText=${lastState.headerText || '空'}, area=${lastState.areaHeight || 0}px/${lastState.areaClass || '无class'}, ProseMirror=${lastState.body ? (lastState.bodyVisible ? '可见' : '不可见') : '无'}, 上传input=${lastState.fileInput ? '有' : '无'}, 发表按钮=${lastState.publishButton ? (lastState.publishButtonDisabled ? '禁用' : '可用') : '无'}, fallbackClicks=${clickCount}`
        : '未读取到发布组件 DOM';

      const fallbackError = new Error(`发帖正文编辑器仍未展开（${stateText}）`);
      fallbackError.name = 'NonRetryableError';
      fallbackError.retryable = false;
      throw fallbackError;
    }
  };
};
