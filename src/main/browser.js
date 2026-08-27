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

  async launch(instanceId, headless = false) {
    if (this.contexts.has(instanceId)) {
      const ctx = this.contexts.get(instanceId);
      const pages = ctx.pages();
      if (pages[0]) await pages[0].bringToFront();
      return ctx;
    }

    const ctx = await chromium.launchPersistentContext(this.profilePath(instanceId), {
      headless,
      viewport: { width: 1280, height: 900 },
      args: ['--start-maximized']
    });

    ctx.on('close', () => this.contexts.delete(instanceId));
    this.contexts.set(instanceId, ctx);
    return ctx;
  }

  async openLogin(instanceId) {
    const ctx = await this.launch(instanceId, false);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://pd.qq.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    return true;
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

  async publishTask(task) {
    const ctx = await this.launch(task.instance_id, false);
    const selectors = this.db.getSelectorMap();
    let allSuccess = true;

    this.db.setTaskStatus(task.id, 'running');
    this.db.log('info', `开始任务 #${task.id}`);

    for (const target of task.targets) {
      if (target.status === 'success') continue;
      let page;
      try {
        this.db.setTargetStatus(target.id, 'running');
        this.db.log('info', `任务 #${task.id} 打开频道：${target.channel_name}`);
        page = await ctx.newPage();
        await page.goto(target.channel_url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const entry = selectors.composer_entry;
        if (entry?.value) await page.locator(entry.value).first().click({ timeout: entry.timeout });

        const fileInput = selectors.file_input;
        await page.locator(fileInput.value).first().setInputFiles(task.media_path, { timeout: fileInput.timeout });

        if (task.title && selectors.title_input?.value) {
          const loc = page.locator(selectors.title_input.value).first();
          if (await loc.count()) await loc.fill(task.title, { timeout: selectors.title_input.timeout });
        }

        if (task.body && selectors.body_input?.value) {
          const loc = page.locator(selectors.body_input.value).first();
          if (await loc.count()) await loc.fill(task.body, { timeout: selectors.body_input.timeout });
        }

        const btn = selectors.publish_button;
        await page.locator(btn.value).first().click({ timeout: btn.timeout });

        const success = selectors.success_hint;
        if (success?.value) {
          await page.locator(success.value).first().waitFor({ state: 'visible', timeout: success.timeout }).catch(() => {});
        }

        this.db.setTargetStatus(target.id, 'success');
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 发布流程完成`);
      } catch (err) {
        allSuccess = false;
        const msg = String(err?.message || err);
        this.db.setTargetStatus(target.id, 'failed', msg.slice(0, 1000));
        this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 失败：${msg}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }

    this.db.setTaskStatus(task.id, allSuccess ? 'success' : 'failed');
    this.db.log('info', `任务 #${task.id} 结束，状态：${allSuccess ? 'success' : 'failed'}`);
    return { success: allSuccess };
  }
}

module.exports = BrowserManager;
