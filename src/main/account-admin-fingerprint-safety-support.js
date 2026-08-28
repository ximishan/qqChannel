module.exports = function installAccountAdminFingerprintSafetySupport(DB, BrowserManager) {
  if (DB.prototype.__accountAdminFingerprintSafetyInstalled) return;
  DB.prototype.__accountAdminFingerprintSafetyInstalled = true;

  const originalActivateQQAccount = DB.prototype.activateQQAccount;
  DB.prototype.activateQQAccount = function activateQQAccountWithFingerprintMigration(identity, displayName = '') {
    const identityType = String(identity?.identityType || '');

    // 旧版本已经存在一个本地账号、但管理员指纹表还是空的时：
    // 第一次成功读取管理员信息应给旧账号补指纹，不能新建重复账号。
    if (identityType === 'guild_admin_fingerprint') {
      const fingerprintCount = Number(this.db.prepare('SELECT COUNT(*) AS c FROM qq_account_admin_fingerprints').get()?.c || 0);
      const accountCount = Number(this.db.prepare('SELECT COUNT(*) AS c FROM qq_accounts').get()?.c || 0);
      if (fingerprintCount === 0 && accountCount === 1 && typeof this.activateExistingQQAccount === 'function') {
        const existing = this.db.prepare('SELECT * FROM qq_accounts ORDER BY id ASC LIMIT 1').get();
        if (existing) {
          this.log('info', `QQ账号识别：首次启用管理员指纹，复用已有本地账号 #${existing.id}，不创建重复账号`);
          return this.activateExistingQQAccount(existing.id, displayName);
        }
      }
    }

    // 管理员识别失败时，旧逻辑会为 fresh login 生成 session:UUID，导致每扫一次码就新增账号。
    // 管理员指纹方案启用后禁止再创建这种临时账号。
    if (identityType === 'login_session') {
      const error = new Error('管理员指纹未能识别当前 QQ，已阻止创建临时重复账号');
      error.code = 'QQ_ACCOUNT_FINGERPRINT_UNRESOLVED';
      throw error;
    }

    return originalActivateQQAccount.call(this, identity, displayName);
  };

  const originalBindLoggedInQQAccount = BrowserManager.prototype.bindLoggedInQQAccount;
  BrowserManager.prototype.bindLoggedInQQAccount = async function bindLoggedInQQAccountSafely(status = {}, options = {}) {
    try {
      return await originalBindLoggedInQQAccount.call(this, status, options);
    } catch (error) {
      if (error?.code !== 'QQ_ACCOUNT_FINGERPRINT_UNRESOLVED') throw error;

      // 新扫码登录但没有拿到可用管理员指纹时，不保留上一个账号为“当前账号”，
      // 否则可能把新 QQ 的操作写进旧 QQ 工作区。
      if (options?.freshLogin && typeof this.db.deactivateQQAccount === 'function') {
        this.db.deactivateQQAccount();
      }
      this.db.log('warn', `QQ账号识别：${String(error.message || error)}`);
      return {
        ...status,
        loggedIn: true,
        accountId: null,
        accountIdentityType: 'unresolved',
        accountBindingRequired: true,
        name: String(status.nickname || status.display_name || status.name || 'QQ账号').trim() || 'QQ账号',
        message: '已登录，但未能通过频道管理员信息识别账号；已停止自动创建新账号。'
      };
    }
  };
};
