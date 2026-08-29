const DB = require('./db');
const BrowserManager = require('./browser');

// 多账号 DOM 模式：instances 表中的每条记录都对应一个独立的 Chromium
// persistent partition。不要加载单账号/CLI 覆盖层，否则多个实例会再次共享登录态。
require('./comment-support')(DB, BrowserManager);
require('./comment-dom-fix-support')(DB, BrowserManager);
require('./publish-open-fallback-support')(DB, BrowserManager);
require('./main');