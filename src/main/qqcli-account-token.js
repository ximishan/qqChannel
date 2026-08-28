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

function findTokenDeep(value, seen = new Set()) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const direct = normalizeToken(value);
    if (direct) return direct;
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const fromBase64 = normalizeToken(decoded);
      if (fromBase64) return fromBase64;
    } catch (_) {}
    return '';
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findTokenDeep(item, seen);
      if (token) return token;
    }
    return '';
  }
  const preferredKeys = ['token', 'access_token', 'accessToken', 'qq_ai_connect_token', 'QQ_AI_CONNECT_TOKEN', 'credential', 'credentials'];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const token = findTokenDeep(value[key], seen);
      if (token) return token;
    }
  }
  for (const item of Object.values(value)) {
    const token = findTokenDeep(item, seen);
    if (token) return token;
  }
  return '';
}

function readTokenFromEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^QQ_AI_CONNECT_TOKEN=(.+)$/m);
    if (match) {
      let token = String(match[1] || '').trim();
      if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
        token = token.slice(1, -1);
      }
      const normalized = normalizeToken(token);
      if (normalized) return normalized;
    }
    return normalizeToken(text);
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
    public IntPtr TargetName;
    public IntPtr Comment;
    public FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
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
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($field in @($cred.TargetName, $cred.Comment, $cred.TargetAlias, $cred.UserName)) {
      if ($field -ne [IntPtr]::Zero) {
        try { $parts.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($field)) } catch {}
      }
    }
    if ($cred.CredentialBlobSize -gt 0 -and $cred.CredentialBlob -ne [IntPtr]::Zero) {
      $bytes = New-Object byte[] $cred.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $bytes.Length)
      $parts.Add([Text.Encoding]::UTF8.GetString($bytes))
      $parts.Add([Text.Encoding]::Unicode.GetString($bytes))
      $parts.Add([Text.Encoding]::ASCII.GetString($bytes))
      try { $parts.Add([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Text.Encoding]::UTF8.GetString($bytes)))) } catch {}
    }
    foreach ($text in $parts) {
      $m = [regex]::Match([string]$text, 'bot:v1_[A-Za-z0-9_-]+')
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
  if ($ptr -ne [IntPtr]::Zero) { [QqCredReader]::CredFree($ptr) }
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

function readFreshLoginToken(cli, pollData) {
  return findTokenDeep(pollData) ||
    readTokenFromEnv(accountCredentialFile(cli)) ||
    readTokenFromEnv(globalCredentialFile()) ||
    readTokenFromWindowsCredentialManager();
}

function ensureAccountCredentialFile(cli) {
  const file = accountCredentialFile(cli);
  if (!file) throw new Error('QQ账号凭证目录无效');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '# QQ Channel account credential\n', 'utf8');
  }
  return file;
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
    const credentialFile = ensureAccountCredentialFile(this);
    const previousDotenv = process.env.QQ_AI_CONNECT_DOTENV;

    // 关键：包括 login / poll-token 在内的每一次 CLI 调用都明确指定当前账号自己的 dotenv。
    // 这样支持 QQ_AI_CONNECT_DOTENV 的 CLI 版本会直接把登录凭证落到账号文件，而不是共享 Windows 登录态。
    process.env.QQ_AI_CONNECT_DOTENV = credentialFile;

    try {
      return originalExecute.call(this, args, payload, timeoutMs);
    } finally {
      if (previousDotenv == null) delete process.env.QQ_AI_CONNECT_DOTENV;
      else process.env.QQ_AI_CONNECT_DOTENV = previousDotenv;
    }
  };

  TencentChannelCli.prototype.loginStatus = async function accountLoginStatus() {
    const credentialFile = accountCredentialFile(this);
    const token = readTokenFromEnv(credentialFile);
    if (!token) {
      return { loggedIn: false, valid: false, message: '该QQ账号尚未登录' };
    }
    const status = await originalLoginStatus.call(this);
    if (!status?.loggedIn || !status?.valid) clearAccountToken(this);
    return status;
  };

  TencentChannelCli.prototype.beginLogin = async function forceAccountLogin() {
    clearAccountToken(this);
    ensureAccountCredentialFile(this);
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
    const token = readFreshLoginToken(this, data);
    if (!token) {
      clearAccountToken(this);
      const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
      throw new Error(`扫码成功，但当前CLI没有返回或写出可保存的独立凭证（poll字段:${keys || '无'}）`);
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
  normalizeToken,
  findTokenDeep,
  readTokenFromEnv,
  readTokenFromWindowsCredentialManager,
  readFreshLoginToken,
  writeAccountToken,
  clearAccountToken
};
