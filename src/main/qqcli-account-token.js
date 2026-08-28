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
    // login status 必须使用当前账号自己的 token；其它 login 子命令属于全局扫码流程，
    // 不能带任何已有账号的 QQ_AI_CONNECT_DOTENV。
    const isLoginCommand = args?.[0] === 'login';
    const isLoginStatus = isLoginCommand && args?.[1] === 'status';
    const credentialFile = accountCredentialFile(this);
    const previousDotenv = process.env.QQ_AI_CONNECT_DOTENV;

    if (isLoginCommand && !isLoginStatus) {
      delete process.env.QQ_AI_CONNECT_DOTENV;
    } else if (credentialFile && fs.existsSync(credentialFile)) {
      process.env.QQ_AI_CONNECT_DOTENV = credentialFile;
    } else {
      delete process.env.QQ_AI_CONNECT_DOTENV;
    }

    try {
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

  TencentChannelCli.prototype.accountCredentialFile = function getAccountCredentialFile() {
    return accountCredentialFile(this);
  };

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
