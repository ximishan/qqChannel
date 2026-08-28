const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { app, ipcMain } = require('electron');
const { TencentChannelCli } = require('./tencent-channel-cli');

let dbRef = null;
let activeAccountId = null;
const cliCache = new Map();
const accountScope = new AsyncLocalStorage();

function normalizeAccountId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function accountHome(userDataPath, accountId) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error('QQ账号不存在');
  const dir = path.join(userDataPath, 'qq-accounts', String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function accountLoginMarker(userDataPath, accountId) {
  return path.join(accountHome(userDataPath, accountId), '.publisher-login-ok');
}

function hasAccountLoginMarker(userDataPath, accountId) {
  try {
    return fs.existsSync(accountLoginMarker(userDataPath, accountId));
  } catch (_) {
    return false;
  }
}

function setAccountLoginMarker(userDataPath, accountId) {
  fs.writeFileSync(accountLoginMarker(userDataPath, accountId), String(Date.now()), 'utf8');
}

function clearAccountLoginMarker(userDataPath, accountId) {
  try {
    fs.rmSync(accountLoginMarker(userDataPath, accountId), { force: true });
  } catch (_) {}
}

function clearAccountCredentials(userDataPath, accountId) {
  const home = accountHome(userDataPath, accountId);
  for (const item of ['.qqcli', 'credentials.env', 'qq-channel-login.png', '.publisher-login-ok']) {
    try {
      fs.rmSync(path.join(home, item), { recursive: true, force: true });
    } catch (_) {}
  }
  const key = `${userDataPath}::${Number(accountId)}`;
  cliCache.delete(key);
}

function getAccountCli(userDataPath, accountId) {
  const id = normalizeAccountId(accountId);
  if (!id) throw new Error('请先选择QQ账号');
  const key = `${userDataPath}::${id}`;
  if (!cliCache.has(key)) {
    cliCache.set(key, new TencentChannelCli({ userDataPath: accountHome(userDataPath, id) }));
  }
  return cliCache.get(key);
}

function getActiveAccountId() {
  return normalizeAccountId(accountScope.getStore()) || normalizeAccountId(activeAccountId);
}

function setActiveAccountId(id) {
  const normalized = normalizeAccountId(id);
  if (!normalized) throw new Error('QQ账号不存在');
  activeAccountId = normalized;
  return activeAccountId;
}

async function getAccountLoginStatus(accountId, options = {}) {
  const id = normalizeAccountId(accountId);
  if (!id) return { loggedIn: false, valid: false, message: 'QQ账号不存在' };
  const userDataPath = app.getPath('userData');

  if (!hasAccountLoginMarker(userDataPath, id) && !options.ignoreMarker) {
    return { loggedIn: false, valid: false, message: '该QQ账号尚未登录' };
  }

  const status = await getAccountCli(userDataPath, id).loginStatus();
  if (!status?.loggedIn || !status?.valid) {
    clearAccountLoginMarker(userDataPath, id);
    return { ...status, loggedIn: false, valid: false };
  }
  return status;
}

async function listAccountLoginStatuses() {
  if (!dbRef) return [];
  const accounts = dbRef.listAccounts();
  const results = [];

  for (const account of accounts) {
    const accountId = Number(account.id);
    try {
      const status = await getAccountLoginStatus(accountId);
      results.push({
        id: accountId,
        name: account.name,
        loggedIn: Boolean(status?.loggedIn),
        valid: Boolean(status?.valid),
        message: String(status?.message || ''),
        nickname: String(status?.nickname || status?.user_name || status?.name || '')
      });
    } catch (error) {
      results.push({
        id: accountId,
        name: account.name,
        loggedIn: false,
        valid: false,
        message: String(error?.message || error || ''),
        nickname: ''
      });
    }
  }
  return results;
}

function installMultiAccountSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;
  DB.prototype.init = function initMultiAccount() {
    originalInit.call(this);
    dbRef = this;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.ensureColumn('instances', 'account_id', 'INTEGER');

    const schemaVersion = this.db.prepare("SELECT value FROM settings WHERE key='multi_account_schema_v1'").get()?.value;
    if (schemaVersion !== '1') {
      const reset = this.db.transaction(() => {
        this.db.prepare('DELETE FROM task_targets').run();
        this.db.prepare('DELETE FROM tasks').run();
        this.db.prepare('DELETE FROM channels').run();
        this.db.prepare('DELETE FROM instances').run();
        this.db.prepare('DELETE FROM accounts').run();

        const addAccount = this.db.prepare('INSERT INTO accounts(name) VALUES (?)');
        const addGroup = this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)');
        for (let index = 1; index <= 3; index += 1) {
          const account = addAccount.run(`QQ账号${index}`);
          addGroup.run('默认频道分组', Number(account.lastInsertRowid));
        }
        this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('multi_account_schema_v1','1')").run();
      });
      reset();
    }

    let accounts = this.db.prepare('SELECT * FROM accounts ORDER BY id ASC').all();
    if (!accounts.length) {
      const account = this.db.prepare('INSERT INTO accounts(name) VALUES (?)').run('QQ账号1');
      this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run('默认频道分组', Number(account.lastInsertRowid));
      accounts = this.db.prepare('SELECT * FROM accounts ORDER BY id ASC').all();
    }

    const credentialVersion = this.db.prepare("SELECT value FROM settings WHERE key='account_credential_isolation_v2'").get()?.value;
    if (credentialVersion !== '1') {
      const accountsRoot = path.join(app.getPath('userData'), 'qq-accounts');
      try { fs.rmSync(accountsRoot, { recursive: true, force: true }); } catch (_) {}
      cliCache.clear();
      this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('account_credential_isolation_v2','1')").run();
    }

    const saved = normalizeAccountId(this.db.prepare("SELECT value FROM settings WHERE key='active_account_id'").get()?.value);
    activeAccountId = accounts.some(item => Number(item.id) === saved) ? saved : Number(accounts[0].id);
    this.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('active_account_id',?)").run(String(activeAccountId));
  };

  DB.prototype.listAccounts = function listAccounts() {
    return this.db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM instances i WHERE i.account_id=a.id) AS group_count,
        (SELECT COUNT(*) FROM channels c JOIN instances i ON i.id=c.instance_id WHERE i.account_id=a.id) AS channel_count
      FROM accounts a
      ORDER BY a.id ASC
    `).all();
  };

  DB.prototype.createAccount = function createAccount(name) {
    const normalizedName = String(name || '').trim() || `QQ账号${this.listAccounts().length + 1}`;
    const tx = this.db.transaction(() => {
      const result = this.db.prepare('INSERT INTO accounts(name) VALUES (?)').run(normalizedName);
      const id = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run('默认频道分组', id);
      return { id, name: normalizedName };
    });
    return tx();
  };

  DB.prototype.renameAccount = function renameAccount(id, name) {
    const accountId = normalizeAccountId(id);
    const normalizedName = String(name || '').trim();
    if (!accountId || !normalizedName) throw new Error('QQ账号名称不能为空');
    const result = this.db.prepare('UPDATE accounts SET name=? WHERE id=?').run(normalizedName, accountId);
    if (!result.changes) throw new Error('QQ账号不存在');
    return { id: accountId, name: normalizedName };
  };

  DB.prototype.getAccountIdForInstance = function getAccountIdForInstance(instanceId) {
    const row = this.db.prepare('SELECT account_id FROM instances WHERE id=?').get(Number(instanceId));
    const id = normalizeAccountId(row?.account_id);
    if (!id) throw new Error('频道分组没有绑定QQ账号');
    return id;
  };

  DB.prototype.listInstances = function listChannelGroups() {
    const accountId = getActiveAccountId();
    if (!accountId) return [];
    return this.db.prepare('SELECT * FROM instances WHERE account_id=? ORDER BY id ASC').all(accountId);
  };

  DB.prototype.createInstance = function createChannelGroup(name) {
    const accountId = getActiveAccountId();
    if (!accountId) throw new Error('请先选择QQ账号');
    return this.db.prepare('INSERT INTO instances(name,account_id) VALUES (?,?)').run(name, accountId);
  };

  const originalPublishTask = BrowserManager.prototype.publishTask;
  const originalPollPublishingLogin = BrowserManager.prototype.pollPublishingLogin;

  BrowserManager.prototype.publishTask = function publishTaskForAccount(task) {
    const accountId = this.db.getAccountIdForInstance(task.instance_id);
    return accountScope.run(accountId, () => originalPublishTask.call(this, task));
  };

  BrowserManager.prototype.getChannelCli = function getScopedChannelCli() {
    const accountId = getActiveAccountId();
    return getAccountCli(this.userDataPath, accountId);
  };

  BrowserManager.prototype.getPublishingLoginStatus = async function getScopedPublishingLoginStatus() {
    const accountId = getActiveAccountId();
    return getAccountLoginStatus(accountId);
  };

  BrowserManager.prototype.beginPublishingLogin = async function beginScopedPublishingLogin() {
    const accountId = getActiveAccountId();
    if (!accountId) throw new Error('请先选择QQ账号');

    const userDataPath = this.userDataPath;
    clearAccountCredentials(userDataPath, accountId);
    const cli = getAccountCli(userDataPath, accountId);

    // 统一走 TencentChannelCli.beginLogin()。qqcli-account-token.js 已经为多账号登录
    // 强制加入 --yes，并在登录完成后保存每个账号独立的 credentials.env。
    return cli.beginLogin();
  };

  BrowserManager.prototype.pollPublishingLogin = async function pollScopedPublishingLogin() {
    const accountId = getActiveAccountId();
    if (!accountId) throw new Error('请先选择QQ账号');
    const result = await originalPollPublishingLogin.call(this);
    if (result?.loggedIn || result?.valid) {
      setAccountLoginMarker(this.userDataPath, accountId);
    } else {
      clearAccountLoginMarker(this.userDataPath, accountId);
    }
    return result;
  };

  ipcMain.handle('accounts:list', () => dbRef?.listAccounts() || []);
  ipcMain.handle('accounts:statuses', () => listAccountLoginStatuses());
  ipcMain.handle('accounts:active', () => getActiveAccountId());
  ipcMain.handle('accounts:setActive', (_, id) => {
    if (!dbRef) throw new Error('数据库尚未初始化');
    const accountId = normalizeAccountId(id);
    const account = dbRef.db.prepare('SELECT id,name FROM accounts WHERE id=?').get(accountId);
    if (!account) throw new Error('QQ账号不存在');
    setActiveAccountId(accountId);
    dbRef.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('active_account_id',?)").run(String(accountId));
    return account;
  });
  ipcMain.handle('accounts:create', (_, name) => {
    if (!dbRef) throw new Error('数据库尚未初始化');
    const account = dbRef.createAccount(name);
    setActiveAccountId(account.id);
    dbRef.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('active_account_id',?)").run(String(account.id));
    return account;
  });
  ipcMain.handle('accounts:rename', (_, data) => dbRef.renameAccount(data?.id, data?.name));
}

module.exports = {
  installMultiAccountSupport,
  getActiveAccountId,
  setActiveAccountId,
  getAccountCli,
  accountHome,
  getAccountLoginStatus,
  hasAccountLoginMarker,
  listAccountLoginStatuses
};
