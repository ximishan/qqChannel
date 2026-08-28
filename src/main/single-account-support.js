module.exports = function installSingleAccountSupport(DB) {
  const originalInit = DB.prototype.init;

  DB.prototype.init = function initSingleAccountMode() {
    originalInit.call(this);

    const mode = this.db.prepare("SELECT value FROM settings WHERE key='single_account_mode_v1'").get()?.value;
    if (mode === '1') return;

    const reset = this.db.transaction(() => {
      // 之前多账号模式下的数据不再继续沿用，避免三个 QQ 账号的频道分组混到一起。
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
};
