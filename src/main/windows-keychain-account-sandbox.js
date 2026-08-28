const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TencentChannelCli } = require('./tencent-channel-cli');

const loginBaselines = new Map();
let globalQueue = Promise.resolve();

function snapshotFile(cli) {
  return cli?.userDataPath ? path.join(cli.userDataPath, 'windows-keychain.json') : '';
}

function runPowerShell(script, input = '') {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], {
    input,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(detail || 'Windows 凭据管理器操作失败');
  }
  return String(result.stdout || '').trim();
}

const CRED_ENUM_PS = String.raw`
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class QQCredNative {
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
$items = @()
if ([QQCredNative]::CredEnumerate($null, 0, [ref]$count, [ref]$ptr)) {
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $p = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
      $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][QQCredNative+CREDENTIAL])
      $target = if ($c.TargetName -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::PtrToStringUni($c.TargetName) } else { '' }
      $user = if ($c.UserName -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::PtrToStringUni($c.UserName) } else { '' }
      $comment = if ($c.Comment -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::PtrToStringUni($c.Comment) } else { '' }
      $alias = if ($c.TargetAlias -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::PtrToStringUni($c.TargetAlias) } else { '' }
      $blob = ''
      if ($c.CredentialBlobSize -gt 0 -and $c.CredentialBlob -ne [IntPtr]::Zero) {
        $bytes = New-Object byte[] $c.CredentialBlobSize
        [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $bytes.Length)
        $blob = [Convert]::ToBase64String($bytes)
      }
      $stamp = ([Int64]$c.LastWritten.dwHighDateTime -shl 32) -bor ([UInt32]$c.LastWritten.dwLowDateTime)
      $items += [pscustomobject]@{ target=$target; user=$user; comment=$comment; alias=$alias; type=[int]$c.Type; persist=[int]$c.Persist; blob=$blob; stamp=$stamp }
    }
  } finally {
    if ($ptr -ne [IntPtr]::Zero) { [QQCredNative]::CredFree($ptr) }
  }
}
$json = $items | ConvertTo-Json -Compress -Depth 4
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;

const CRED_WRITE_PS = String.raw`
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class QQCredWriter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL Credential, UInt32 Flags);
}
"@
Add-Type -TypeDefinition $src
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw.Trim()))
$items = @($json | ConvertFrom-Json)
foreach ($item in $items) {
  $bytes = if ($item.blob) { [Convert]::FromBase64String([string]$item.blob) } else { New-Object byte[] 0 }
  $blobPtr = [IntPtr]::Zero
  try {
    if ($bytes.Length -gt 0) {
      $blobPtr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)
    }
    $c = New-Object QQCredWriter+CREDENTIAL
    $c.Flags = 0
    $c.Type = [UInt32]$item.type
    $c.TargetName = [string]$item.target
    $c.Comment = [string]$item.comment
    $c.CredentialBlobSize = [UInt32]$bytes.Length
    $c.CredentialBlob = $blobPtr
    $c.Persist = [UInt32]$item.persist
    $c.AttributeCount = 0
    $c.Attributes = [IntPtr]::Zero
    $c.TargetAlias = [string]$item.alias
    $c.UserName = [string]$item.user
    if (-not [QQCredWriter]::CredWrite([ref]$c, 0)) {
      throw "CredWrite failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error()) target=$($item.target)"
    }
  } finally {
    if ($blobPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr) }
  }
}
`;

function enumerateCredentials() {
  if (process.platform !== 'win32') return [];
  const out = runPowerShell(CRED_ENUM_PS);
  if (!out) return [];
  const json = Buffer.from(out.split(/\r?\n/).filter(Boolean).pop(), 'base64').toString('utf8');
  const parsed = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

function keyOf(item) {
  return `${Number(item?.type || 0)}|${String(item?.target || '')}`;
}

function changedCredentials(before, after) {
  const previous = new Map((before || []).map(item => [keyOf(item), item]));
  return (after || []).filter(item => {
    const old = previous.get(keyOf(item));
    return !old || old.blob !== item.blob || old.user !== item.user || old.persist !== item.persist;
  });
}

function saveSnapshot(cli, items) {
  const file = snapshotFile(cli);
  if (!file) throw new Error('QQ账号凭据目录无效');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items || []), 'utf8');
}

function loadSnapshot(cli) {
  const file = snapshotFile(cli);
  try {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
  }
}

function clearSnapshot(cli) {
  const file = snapshotFile(cli);
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch (_) {}
}

function restoreSnapshot(cli) {
  if (process.platform !== 'win32') return false;
  const items = loadSnapshot(cli);
  if (!items.length) return false;
  const payload = Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
  runPowerShell(CRED_WRITE_PS, payload);
  return true;
}

function installWindowsKeychainAccountSandbox() {
  if (process.platform !== 'win32') return;
  if (TencentChannelCli.prototype.__windowsKeychainAccountSandboxInstalled) return;
  TencentChannelCli.prototype.__windowsKeychainAccountSandboxInstalled = true;

  const previousExecute = TencentChannelCli.prototype.execute;

  TencentChannelCli.prototype.execute = function executeWithWindowsAccountKeychain(args, payload = null, timeoutMs = 180000) {
    const isLoginStart = args?.[0] === 'login' && args?.[1] !== 'status' && args?.[1] !== 'poll-token';
    const isPoll = args?.[0] === 'login' && args?.[1] === 'poll-token';
    const work = async () => {
      if (!isLoginStart && !isPoll) restoreSnapshot(this);
      return previousExecute.call(this, args, payload, timeoutMs);
    };
    const queued = globalQueue.then(work, work);
    globalQueue = queued.catch(() => {});
    return queued;
  };

  TencentChannelCli.prototype.beginLogin = async function beginWindowsAccountLogin() {
    clearSnapshot(this);
    loginBaselines.set(this.userDataPath, enumerateCredentials());
    const qrcodePath = path.join(this.userDataPath, 'qq-channel-login.png');
    const data = await this.run(['login', '--json', '--yes', '--qrcode-path', qrcodePath], null, { timeoutMs: 30000 });
    const returnedPath = String(data.qrcode_path || qrcodePath);
    let qrDataUrl = '';
    if (fs.existsSync(returnedPath)) qrDataUrl = `data:image/png;base64,${fs.readFileSync(returnedPath).toString('base64')}`;
    return { ...data, alreadyLoggedIn: false, qrcodePath: returnedPath, qrDataUrl, verificationUri: String(data.verification_uri || data.verification_url || '') };
  };

  TencentChannelCli.prototype.pollLogin = async function pollWindowsAccountLogin() {
    const data = await this.run(['login', 'poll-token', '--json'], null, { timeoutMs: 600000 });
    const status = String(data?.status || '').toLowerCase();
    if (status && status !== 'authorized') throw new Error(String(data?.message || `QQ扫码状态：${status}`));

    const before = loginBaselines.get(this.userDataPath) || [];
    loginBaselines.delete(this.userDataPath);
    const after = enumerateCredentials();
    const changed = changedCredentials(before, after);
    if (!changed.length) {
      const storage = typeof data?.storage === 'string' ? data.storage : JSON.stringify(data?.storage || null);
      throw new Error(`扫码已授权，但没有捕获到本次登录写入的 Windows 凭据（storage=${storage}）。`);
    }
    saveSnapshot(this, changed);
    restoreSnapshot(this);

    const checked = await this.run(['login', 'status', '--json'], null, { timeoutMs: 30000 })
      .then(info => ({ loggedIn: Boolean(info?.valid), valid: Boolean(info?.valid), ...info }))
      .catch(error => ({ loggedIn: false, valid: false, message: String(error?.message || error) }));
    if (!checked.loggedIn || !checked.valid) {
      clearSnapshot(this);
      throw new Error('已保存当前QQ的 Windows 独立凭据，但校验失败。');
    }
    return { ...data, ...checked };
  };

  TencentChannelCli.prototype.loginStatus = async function windowsAccountLoginStatus() {
    if (!loadSnapshot(this).length) return { loggedIn: false, valid: false, message: '该QQ账号尚未登录' };
    try {
      restoreSnapshot(this);
      const info = await this.run(['login', 'status', '--json'], null, { timeoutMs: 30000 });
      return { loggedIn: Boolean(info?.valid), valid: Boolean(info?.valid), ...info };
    } catch (error) {
      return { loggedIn: false, valid: false, message: String(error?.message || error) };
    }
  };
}

installWindowsKeychainAccountSandbox();

module.exports = { installWindowsKeychainAccountSandbox, enumerateCredentials, changedCredentials, restoreSnapshot, snapshotFile };
