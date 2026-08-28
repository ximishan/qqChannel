const fs = require('fs');
const path = require('path');

function sanitize(value, depth = 0) {
  if (depth > 5) return '[max-depth]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|cookie|credential|secret|authorization|password|passwd|keychain/i.test(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = sanitize(child, depth + 1);
  }
  return out;
}

module.exports = function installLoginDiagnosticSupport(DB, BrowserManager) {
  if (BrowserManager.prototype.__loginDiagnosticInstalled) return;
  BrowserManager.prototype.__loginDiagnosticInstalled = true;

  const originalPollPublishingLogin = BrowserManager.prototype.pollPublishingLogin;
  BrowserManager.prototype.pollPublishingLogin = async function pollPublishingLoginWithDiagnostics() {
    const result = await originalPollPublishingLogin.call(this);
    const safe = sanitize(result);
    const record = {
      capturedAt: new Date().toISOString(),
      source: 'publisher:pollLogin',
      result: safe
    };

    try {
      const file = path.join(this.userDataPath, 'qq-login-diagnostic.json');
      fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    } catch (_) {}

    try {
      this.db.log('info', `[QQ身份诊断] poll-token返回=${JSON.stringify(safe)}`);
    } catch (_) {}

    return result;
  };
};
