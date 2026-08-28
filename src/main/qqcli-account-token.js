const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TencentChannelCli } = require('./tencent-channel-cli');

function accountCredentialFile(cli) {
  if (!cli?.userDataPath) return '';
  return path.join(cli.userDataPath, 'credentials.env');
}

function globalCredentialFile() {
  return path.join(os.homedir(), '.qqcli', '.env');
}

function normalizeToken(value) {
  const match = String(value || '').match(/bot:v1_[A-Za-z0-9_-]+/);
  return match ? match[0] : '';
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
    return normalizeToken(token);
  } catch (_) {
    return '';
  }
}

function readTokenFromWindowsCredentialManager() {
  if (process.platform !== 'win32') return '';

  const ps = String.raw`
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class QqCredReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredEnumerate(string Filter, UInt32 Flags, out UInt32 Count, out IntPtr Credentials);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr Buffer);
}
"@
Add-Type -TypeDefinition $src
$count = 0
$ptr = [IntPtr]::Zero
if (-not [QqCredReader]::CredEnumerate($null, 0, [ref]$count, [ref]$ptr)) { exit 0 }
$bestToken = $null
$bestTime = [Int64]::MinValue
try {
  for ($i = 0; $i -lt $count; $i++) {
    $p = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][QqCredReader+CREDENTIAL])
    if ($cred.CredentialBlobSize -le 0 -or $cred.CredentialBlob -eq [IntPtr]::Zero) { continue }
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
    $texts = @([Text.Encoding]::UTF8.GetString($bytes), [Text.Encoding]::Unicode.GetString($bytes))
    foreach ($text in $texts) {
      $m = [regex]::Match($text, 'bot:v1_[A-Za-z0-9_-]+')
      if ($m.Success) {
        $stamp = ([Int64]$cred.LastWritten.dwHighDateTime -shl 32) -bor ([UInt32]$cred.LastWritten.dwLowDateTime)
        if ($stamp -ge $bestTime) {
          $bestTime = $stamp
          $bestToken = $m.Value
        }
      }
    }
  }
} finally {
  [QqCredReader]::CredFree($ptr)
}
if ($bestToken) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bestToken)) }
`;

  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    if (result.error || result.status !== 0) return '';
    const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (!line) return '';
    return normalizeToken(Buffer.from(line, 'base64').toString('utf8'));
  } catch (_) {
    return '';
  }
}

function readFreshLoginToken() {
  return readTokenFromEnv(globalCredentialFile()) || readTokenFromWindowsCredentialManager();
}

function writeAccountToken(cli, token) {
  const normalized = normalizeToken(token);
  const file = accountCredentialFile(cli);
  if (!file || !normalized) throw new Error('没有读取到 QQ 登录凭证，请重新扫码登录');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# QQ Channel account credential\nQQ_AI_CONNECT_TOKEN="${normalized}"\n`, 'utf8');
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
    const token = readFreshLoginToken();
    if (!token) {
      clearAccountToken(this);
      throw new Error('扫码成功，但未能从本机凭证存储中提取登录凭证，请把日志发给我继续定位');
    }
    writeAccountToken(this, token);

    const status = await originalLoginStatus.call(this);
    if (!status?.loggedIn || !status?.valid) {
      clearAccountToken(this);
      throw new Error('QQ账号独立凭证已保存，但校验失败，请重新登录');
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
  readTokenFromWindowsCredentialManager,
  readFreshLoginToken,
  writeAccountToken,
  clearAccountToken
};
