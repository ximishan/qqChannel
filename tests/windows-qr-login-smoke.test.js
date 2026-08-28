const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32' });

const { TencentChannelCli } = require('../src/main/tencent-channel-cli');
require('../src/main/windows-keychain-account-sandbox');

test('Windows QQ login returns QR data URL even when PowerShell keychain enumeration is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqchannel-qr-test-'));
  const qrPath = path.join(dir, 'qq-channel-login.png');
  fs.writeFileSync(qrPath, Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));

  const cli = new TencentChannelCli({
    userDataPath: dir,
    executor: async (args) => {
      if (args[0] === 'login' && args[1] === '--json') {
        return {
          code: 0,
          stdout: JSON.stringify({ success: true, data: { qrcode_path: qrPath, verification_uri: 'https://example.invalid/qq-login' } }) + '\n',
          stderr: ''
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected command' };
    }
  });

  const result = await cli.beginLogin();
  assert.equal(result.qrcodePath, qrPath);
  assert.match(result.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(result.verificationUri, 'https://example.invalid/qq-login');
  assert.equal(result.alreadyLoggedIn, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

Object.defineProperty(process, 'platform', { value: originalPlatform });
