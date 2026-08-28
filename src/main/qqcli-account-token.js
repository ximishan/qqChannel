const fs = require('fs');
const os = require('os');
const path = require('path');
const { TencentChannelCli } = require('./tencent-channel-cli');

function accountCredentialFile(cli) {
  if (!cli?.userDataPath) return '';
  return path.join(cli.userDataPath, 'credentials.env');
}

function globalCredentialFile() {
  return path.join(os.homedir(), '.qqcli', '.env');
}

function readTokenFromEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^QQ_AI_CONNECT_TOKEN=(.+)$/m);
    if (!match) return '';
    let token = String(match[1] || '').trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1);
    }
    return token.trim();
  } catch (_) {
    return '';
  }
}

function writeAccountToken(cli, token) {
  const file = accountCredentialFile(cli);
  if (!file || !token) throw new Error('没有读取到 QQ 登录凭证，请重新扫码登录');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# QQ Channel account credential\nQQ_AI_CONNECT_TOKEN="${token.replace(/"/g, '\\"')}"\n`, 'utf8');
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return file;
}

function clearAccountToken(cli) {
  const file = accountCredentialFile(cli);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch (_) {}
}

function installAccountTokenSupport() {
  if (TencentChannelCli.prototype.__accountTokenSupportInstalled) return;
  TencentChannelCli.prototype.__accountTokenSupportInstalled = true;

  // Windows 版 CLI 的默认登录态来自系统 keychain，改 HOME/USERPROFILE 并不能隔离账号。
  // 正确做法是：扫码后提取 token，每个账号各自保存 credentials.env；后续所有状态检查、
  // 频道读取和发布都通过官方支持的 QQ_AI_CONNECT_DOTENV 指向该账号的 token 文件。
  const originalExecute = TencentChannelCli.prototype.execute;
  const originalBeginLogin = TencentChannelCli.prototype.beginLogin;
  const originalPollLogin = TencentChannelCli.prototype.pollLogin;
  const originalLoginStatus = TencentChannelCli.prototype.loginStatus;

  TencentChannelCli.prototype.isolatedEnvironment = function accountTokenEnvironment() {
    const env = { ...process.env };
    delete env.QQ_AI_CONNECT_TOKEN;
    delete env.QQCLI_TOKEN;
    delete env.QQ_CHANNEL_TOKEN;
    delete env.TENCENT_CHANNEL_TOKEN;
    return env;
  };

  TencentChannelCli.prototype.execute = function executeWithAccountToken(args, payload = null, timeoutMs = 180000) {
    const isLoginFlow = args?.[0] === 'login' && (args.length === 1 || args?.[1] === 'poll-token');
    const credentialFile = accountCredentialFile(this);
    const previousDotenv = process.env.QQ_AI_CONNECT_DOTENV;

    if (isLoginFlow) {
      delete process.env.QQ_AI_CONNECT_DOTENV;
    } else if (credentialFile && fs.existsSync(credentialFile)) {
      process.env.QQ_AI_CONNECT_DOTENV = credentialFile;
    } else {
      delete process.env.QQ_AI_CONNECT_DOTENV;
    }

    try {
      // originalExecute 会在本调用栈内同步读取 process.env 并 spawn 子进程，
      // 因此这里可以在返回 Promise 后立即恢复宿主环境变量，不会影响子进程。
      return originalExecute.call(this, args, payload, timeoutMs);
    } finally {
      if (previousDotenv == null) delete process.env.QQ_AI_CONNECT_DOTENV;
      else process.env.QQ_AI_CONNECT_DOTENV = previousDotenv;
    }
  };

  TencentChannelCli.prototype.loginStatus = async function accountLoginStatus() {
    const credentialFile = accountCredentialFile(this);
    if (!credentialFile || !fs.existsSync(credentialFile)) {
      return { loggedIn: false, valid: false, message: '该QQ账号尚未登录' };
    }
    const status = await originalLoginStatus.call(this);
    if (!status?.loggedIn || !status?.valid) clearAccountToken(this);
    return status;
  };

  TencentChannelCli.prototype.beginLogin = async function forceAccountLogin() {
    clearAccountToken(this);
    const qrcodePath = path.join(this.userDataPath || os.homedir(), 'qq-channel-login.png');
    const data = await this.run(['login', '--json', '--yes', '--qrcode-path', qrcodePath], null, { timeoutMs: 30000 });
    const returnedPath = String(data.qrcode_path || qrcodePath);
    let qrDataUrl = '';
    if (fs.existsSync(returnedPath)) {
      qrDataUrl = `data:image/png;base64,${fs.readFileSync(returnedPath).toString('base64')}`;
    }
    return {
      ...data,
      alreadyLoggedIn: false,
      qrcodePath: returnedPath,
      qrDataUrl,
      verificationUri: String(data.verification_uri || data.verification_url || '')
    };
  };

  TencentChannelCli.prototype.pollLogin = async function saveAccountTokenAfterLogin() {
    const data = await this.run(['login', 'poll-token', '--json'], null, { timeoutMs: 600000 });

    // tencent-channel-cli 登录完成后会把当前 token 写入 ~/.qqcli/.env。
    // 这里立即复制成当前账号自己的凭证文件，之后不再依赖 Windows 全局 keychain 登录态。
    const token = readTokenFromEnv(globalCredentialFile());
    if (!token) {
      clearAccountToken(this);
      throw new Error('扫码成功，但没有读取到独立账号凭证，请重新登录');
    }
    writeAccountToken(this, token);

    const status = await originalLoginStatus.call(this);
    if (!status?.loggedIn || !status?.valid) {
      clearAccountToken(this);
      throw new Error('QQ账号凭证保存后校验失败，请重新登录');
    }
    return { ...data, ...status };
  };

  // 仅用于测试/诊断。
  TencentChannelCli.prototype.accountCredentialFile = function getAccountCredentialFile() {
    return accountCredentialFile(this);
  };

  // 保留引用，方便将来排查 CLI 版本变化。
  TencentChannelCli.prototype.__originalBeginLogin = originalBeginLogin;
  TencentChannelCli.prototype.__originalPollLogin = originalPollLogin;
}

installAccountTokenSupport();

module.exports = {
  installAccountTokenSupport,
  accountCredentialFile,
  globalCredentialFile,
  readTokenFromEnv,
  writeAccountToken,
  clearAccountToken
};
