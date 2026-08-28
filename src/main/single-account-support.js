const fs = require('fs');
const { TencentChannelCli } = require('./tencent-channel-cli');

module.exports = function installSingleAccountSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;

  DB.prototype.init = function initSingleAccountMode() {
    originalInit.call(this);

    const mode = this.db.prepare("SELECT value FROM settings WHERE key='single_account_mode_v1'").get()?.value;
    if (mode === '1') return;

    const reset = this.db.transaction(() => {
      this.db.prepare('DELETE FROM task_targets').run();
      this.db.prepare('DELETE FROM tasks').run();
      this.db.prepare('DELETE FROM channels').run();
      this.db.prepare('DELETE FROM instances').run();

      const hasAccounts = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts'").get();
      if (hasAccounts) this.db.prepare('DELETE FROM accounts').run();

      this.db.prepare('INSERT INTO instances(name) VALUES (?)').run('默认频道分组');
      this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('single_account_mode_v1','1')").run();
      this.db.prepare("DELETE FROM settings WHERE key IN ('active_account_id','multi_account_schema_v1','account_credential_isolation_v2')").run();
    });

    reset();
  };

  TencentChannelCli.prototype.logout = async function logoutCurrentQQ() {
    const attempts = [
      ['login', 'logout', '--json'],
      ['logout', '--json']
    ];
    let lastError = null;
    for (const args of attempts) {
      try {
        const result = await this.run(args, null, { timeoutMs: 30000 });
        this.guildCache = null;
        this.channelCache.clear();
        const status = await this.loginStatus();
        if (!status.loggedIn) return { success: true, loggedIn: false, ...result };
      } catch (error) {
        lastError = error;
      }
    }

    const status = await this.loginStatus();
    if (!status.loggedIn) return { success: true, loggedIn: false };
    throw lastError || new Error('退出 QQ 授权失败');
  };

  BrowserManager.prototype.logoutPublishing = async function logoutPublishing() {
    const cli = this.getChannelCli();
    const result = await cli.logout();

    for (const record of this.views.values()) {
      try {
        await record.session.clearStorageData({ storages: ['cookies', 'localstorage', 'sessionstorage'] });
        record.webStorage = null;
        record.storageApplied = false;
        record.restored = true;
      } catch (_) {}
    }
    try { fs.rmSync(this.authStatePath(), { force: true }); } catch (_) {}

    this.db.log('info', '已退出当前 QQ 授权；频道分组、频道和任务记录均保留');
    return { ...result, loggedIn: false };
  };
};
