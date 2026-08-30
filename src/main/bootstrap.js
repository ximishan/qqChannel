const DB = require('./db');
const BrowserManager = require('./browser');

// 多账号 DOM 模式：instances 表中的每条记录都对应一个独立的 Chromium
// persistent partition。不要加载单账号/CLI 覆盖层，否则多个实例会再次共享登录态。
require('./comment-support')(DB, BrowserManager);
require('./comment-dom-fix-support')(DB, BrowserManager);
require('./task-content-support')(DB, BrowserManager);
require('./publish-open-fallback-support')(DB, BrowserManager);
// 最后加载用户已在 Tampermonkey 中实测通过的 QQ 频道 DOM 发布/评论链路。
// 该兼容层覆盖发布目标执行，但继续复用多账号、SQLite、队列、截图和重试状态机。
require('./userscript-dom-publishing-support')(DB, BrowserManager);
// 每个账号实例对应一个独立桌面窗口，内置浏览器视图也绑定到该实例窗口。
require('./instance-window-support')(BrowserManager);
require('./main');