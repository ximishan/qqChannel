const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

class BrowserManager {
  constructor(userDataPath, db) {
    this.userDataPath = userDataPath;
    this.db = db;
    this.contexts = new Map();
  }

  profilePath(instanceId) {
    const p = path.join(this.userDataPath, 'profiles', String(instanceId));
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  screenshotDir() {
    const d = new Date();
    const date = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
    const p = path.join(this.userDataPath, 'screenshots', date);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  async launch(instanceId, headless = false) {
    if (this.contexts.has(instanceId)) {
      const ctx = this.contexts.get(instanceId);
      const pages = ctx.pages();
      if (pages[0]) await pages[0].bringToFront();
      return ctx;
    }

    const ctx = await chromium.launchPersistentContext(this.profilePath(instanceId), {
      headless,
      viewport: null,
      args: ['--start-maximized']
    });

    ctx.on('close', () => this.contexts.delete(instanceId));
    this.contexts.set(instanceId, ctx);
    return ctx;
  }

  selectorCandidates(config) {
    if (!config?.value) return [];
    return String(config.value)
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  async firstMatchingLocator(page, config, options = {}) {
    const { visible = false, timeout = config?.timeout || 30000 } = options;
    const candidates = this.selectorCandidates(config);
    let lastError = null;

    for (const selector of candidates) {
      try {
        const loc = page.locator(selector).first();
        if (visible) {
          await loc.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
        } else if (await loc.count() < 1) {
          continue;
        }
        return { locator: loc, selector };
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    throw new Error(`找不到元素：${config?.name || config?.key || 'unknown selector'}`);
  }

  async openLogin(instanceId) {
    const ctx = await this.launch(instanceId, false);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://pd.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    return this.getLoginStatus(instanceId, page);
  }

  async getLoginStatus(instanceId, existingPage = null) {
    const ctx = await this.launch(instanceId, false);
    const page = existingPage || ctx.pages()[0] || await ctx.newPage();
    const selectors = this.db.getSelectorMap();

    if (!page.url().startsWith('https://pd.qq.com/')) {
      await page.goto('https://pd.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    try {
      const found = await this.firstMatchingLocator(page, selectors.logged_in_user, { visible: true, timeout: 10000 });
      const name = (await found.locator.innerText().catch(() => '')).trim();
      return { loggedIn: true, name: name || '已登录', url: page.url() };
    } catch (_) {
      return { loggedIn: false, name: '', url: page.url() };
    }
  }

  async testSelector(instanceId, selector, url) {
    const ctx = await this.launch(instanceId, false);
    const page = ctx.pages()[0] || await ctx.newPage();
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const loc = page.locator(selector);
    const count = await loc.count();
    if (count > 0) await loc.first().highlight().catch(() => {});
    return { count, url: page.url() };
  }

  async fillProseMirror(page, config, text) {
    if (!text) return;
    const { locator } = await this.firstMatchingLocator(page, config, { visible: true });
    await locator.click();
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await locator.fill(text).catch(async () => {
      await locator.evaluate((el) => {
        el.focus();
        document.execCommand('selectAll', false, null);
      });
      await page.keyboard.insertText(text);
    });
  }

  async setMediaFile(page, config, mediaPath) {
    if (!fs.existsSync(mediaPath)) throw new Error(`素材文件不存在：${mediaPath}`);
    const { locator } = await this.firstMatchingLocator(page, config);
    await locator.setInputFiles(mediaPath, { timeout: config.timeout || 30000 });
  }

  async waitPublishReady(page, selectors) {
    const timeout = Number(this.db.getSetting('upload_timeout_ms', '120000'));
    const { locator: button } = await this.firstMatchingLocator(page, selectors.publish_button, { visible: true });

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const disabled = await button.isDisabled().catch(() => true);
      if (!disabled) return true;

      const errorText = await this.readPageError(page, selectors).catch(() => '');
      if (errorText) throw new Error(`页面提示：${errorText}`);

      await page.waitForTimeout(1000);
    }
    throw new Error(`等待素材上传完成/发表按钮可用超时（${Math.round(timeout/1000)}秒）`);
  }

  async readPageError(page, selectors) {
    const config = selectors.error_hint;
    for (const selector of this.selectorCandidates(config)) {
      const loc = page.locator(selector).first();
      if (await loc.count()) {
        if (await loc.isVisible().catch(() => false)) {
          const text = (await loc.innerText().catch(() => '')).trim();
          if (text) return text;
        }
      }
    }
    return '';
  }

  async verifyPublishSuccess(page, selectors) {
    const timeout = Number(this.db.getSetting('publish_verify_timeout_ms', '20000'));

    // 优先等待页面明确成功提示。
    const successConfig = selectors.success_hint;
    for (const selector of this.selectorCandidates(successConfig)) {
      const loc = page.locator(selector).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 2500 });
        return { verified: true, reason: `success_hint:${selector}` };
      } catch (_) {}
    }

    // 腾讯频道发布成功后编辑器通常会清空并重新出现“期待你的分享...”占位。
    const bodyConfig = selectors.body_input;
    const body = await this.firstMatchingLocator(page, bodyConfig, { visible: true }).catch(() => null);
    if (body) {
      try {
        await page.waitForFunction(
          (selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const text = (el.innerText || '').replace(/\s+/g, '').trim();
            return text === '' || text === '期待你的分享...';
          },
          body.selector,
          { timeout }
        );

        const { locator: button } = await this.firstMatchingLocator(page, selectors.publish_button, { visible: true });
        const disabled = await button.isDisabled().catch(() => false);
        if (disabled) return { verified: true, reason: 'editor_reset' };
      } catch (_) {}
    }

    const errorText = await this.readPageError(page, selectors).catch(() => '');
    if (errorText) throw new Error(`发布失败，页面提示：${errorText}`);

    throw new Error('点击发表后未检测到明确的发布成功状态');
  }

  async saveFailureScreenshot(page, taskId, targetId, attempt) {
    if (this.db.getSetting('screenshot_on_error', '1') !== '1') return null;
    const p = path.join(this.screenshotDir(), `task-${taskId}-target-${targetId}-attempt-${attempt}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
    return p;
  }

  async publishOneTarget(ctx, task, target, selectors, attempt) {
    let page;
    try {
      this.db.setTargetStatus(target.id, 'running');
      this.db.log('info', `任务 #${task.id} 打开频道：${target.channel_name}（第${attempt}次）`);

      page = await ctx.newPage();
      await page.goto(target.channel_url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      const login = await this.getLoginStatus(task.instance_id, page);
      if (!login.loggedIn) throw new Error('QQ 登录状态已失效，请重新登录后继续');

      await this.firstMatchingLocator(page, selectors.body_input, { visible: true });

      if (task.body) {
        await this.fillProseMirror(page, selectors.body_input, task.body);
      }

      await this.setMediaFile(page, selectors.file_input, task.media_path);
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 素材已选择，等待上传完成`);

      await this.waitPublishReady(page, selectors);

      const { locator: publishButton } = await this.firstMatchingLocator(page, selectors.publish_button, { visible: true });
      if (await publishButton.isDisabled()) throw new Error('发表按钮仍处于 disabled 状态');

      await publishButton.click();
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 已点击发表，等待结果确认`);

      const verify = await this.verifyPublishSuccess(page, selectors);
      this.db.setTargetStatus(target.id, 'success');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 发布成功（${verify.reason}）`);
      return true;
    } catch (err) {
      const msg = String(err?.message || err);
      const screenshot = page ? await this.saveFailureScreenshot(page, task.id, target.id, attempt) : null;
      this.db.setTargetStatus(target.id, 'failed', screenshot ? `${msg}\n截图：${screenshot}` : msg);
      this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 失败：${msg}${screenshot ? `；截图：${screenshot}` : ''}`);
      throw err;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async publishTask(task) {
    const ctx = await this.launch(task.instance_id, false);
    const selectors = this.db.getSelectorMap();
    const maxRetries = Math.max(0, Number(this.db.getSetting('max_retries', '2')) || 0);
    let allSuccess = true;

    this.db.setTaskStatus(task.id, 'running');
    this.db.log('info', `开始任务 #${task.id}`);

    const login = await this.getLoginStatus(task.instance_id).catch(() => ({ loggedIn: false }));
    if (!login.loggedIn) {
      this.db.setTaskStatus(task.id, 'failed');
      this.db.log('error', `任务 #${task.id} 未执行：QQ 未登录或登录已失效`);
      throw new Error('QQ 未登录或登录已失效，请先点击“登录QQ”');
    }

    for (const target of task.targets) {
      if (target.status === 'success') continue;

      let success = false;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
          if (attempt > 1) {
            this.db.incrementTargetRetry(target.id);
            this.db.log('warn', `任务 #${task.id} -> ${target.channel_name} 开始重试 ${attempt - 1}/${maxRetries}`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          await this.publishOneTarget(ctx, task, target, selectors, attempt);
          success = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!success) {
        allSuccess = false;
        this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 已达到最大重试次数：${String(lastErr?.message || lastErr || '')}`);
      }
    }

    this.db.setTaskStatus(task.id, allSuccess ? 'success' : 'failed');
    this.db.log('info', `任务 #${task.id} 结束，状态：${allSuccess ? 'success' : 'failed'}`);
    return { success: allSuccess };
  }
}

module.exports = BrowserManager;
