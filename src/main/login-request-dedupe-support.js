module.exports = function installLoginRequestDedupeSupport(DB, BrowserManager) {
  if (BrowserManager.prototype.__loginRequestDedupeSupportInstalled) return;
  BrowserManager.prototype.__loginRequestDedupeSupportInstalled = true;

  const originalBeginPublishingLogin = BrowserManager.prototype.beginPublishingLogin;

  BrowserManager.prototype.beginPublishingLogin = function beginPublishingLoginDeduped() {
    if (this.__publishingLoginPromise) {
      try { this.db?.log?.('info', '登录二维码正在生成，复用当前登录请求'); } catch (_) {}
      return this.__publishingLoginPromise;
    }

    const promise = Promise.resolve().then(() => originalBeginPublishingLogin.call(this));
    this.__publishingLoginPromise = promise;

    promise.finally(() => {
      if (this.__publishingLoginPromise === promise) this.__publishingLoginPromise = null;
    }).catch(() => {});

    return promise;
  };
};
