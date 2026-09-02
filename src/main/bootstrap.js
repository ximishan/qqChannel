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
// 修正图片上传等待：不再依赖容易变化的预览 class，并向界面发送实时发布阶段。
require('./publish-runtime-feedback-support')(BrowserManager);
// 每个账号实例对应一个独立桌面窗口，内置浏览器视图也绑定到该实例窗口。
require('./instance-window-support')(BrowserManager);
// 登录状态必须按实例隔离，并且只有明确看到登录页时才允许把已登录状态降级。
require('./login-state-fix-support')(DB, BrowserManager);
// 点击“登录QQ”后自动触发 QQ 登录入口，并等待二维码登录框出现。
require('./login-qr-support')(BrowserManager);
// QQ 当前激活频道可能不再使用 .my-guild-item；同步时额外合并当前 /g/... 页面频道。
require('./channel-current-page-sync-support')(BrowserManager);
require('./main');