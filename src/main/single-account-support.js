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

    // 兼容从旧单账号版本升级：如果旧频道/任务还没有 account_id，
    // 先利用当前仍有效的 QQ 登录态识别账号并完成一次归属迁移，再执行真正退出。
    let account = this.db.getActiveQQAccount?.() || null;
    if (!account && typeof this.getPublishingLoginStatus === 'function') {
      try {
        const status = await this.getPublishingLoginStatus();
        if (status?.loggedIn) account = this.db.getActiveQQAccount?.() || null;
      } catch (_) {}
    }

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

    // 只解除“当前账号”，绝不删除该账号的频道分组、频道、任务和历史数据。
    // 下次登录同一个 QQ 时，会通过 account_id 自动恢复原工作区；登录其他 QQ 则显示其他工作区。
    this.db.deactivateQQAccount?.();
    this.db.log('info', `已退出当前 QQ 授权${account ? `（本地账号 #${account.id}）` : ''}；账号工作区数据已保留`);
    return { ...result, loggedIn: false, accountId: account?.id || null, workspacePreserved: true };
  };
};
