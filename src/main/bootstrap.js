const DB = require('./db');
const BrowserManager = require('./browser');

// 多账号 DOM 模式：instances 表中的每条记录都对应一个独立的 Chromium
// persistent partition。不要加载单账号/CLI 覆盖层，否则多个实例会再次共享登录态。

// 只保留发布所需的数据层能力：正文/评论分离、帖子已发布标记、评论状态、防重复发帖。
require('./publishing-data-support')(DB);

// 唯一发布/评论主链：用户已在 Tampermonkey 中实测通过的 QQ 频道 DOM 流程。
require('./userscript-dom-publishing-support')(DB, BrowserManager);

// Electron 适配层：本地文件注入、油猴脚本同款媒体事件、实时阶段提示。
// 不提供第二套发布算法，也不回退旧 selector 发布器。
require('./publish-runtime-feedback-support')(BrowserManager);

// 每个账号实例对应一个独立桌面窗口，内置浏览器视图也绑定到该实例窗口。
require('./instance-window-support')(BrowserManager);
// 登录状态必须按实例隔离，并且只有明确看到登录页时才允许把已登录状态降级。
require('./login-state-fix-support')(DB, BrowserManager);
// 点击“登录QQ”后自动触发 QQ 登录入口，并等待二维码登录框出现。
require('./login-qr-support')(BrowserManager);
// QQ 当前激活频道可能不再使用 .my-guild-item；同步时额外合并当前 /g/... 页面频道。
require('./channel-current-page-sync-support')(BrowserManager);
// 每条发布任务使用一个全新的临时 QQ 页面：共享实例登录 session，任务完成后立即销毁页面。
// 不修改油猴发布算法，只管理页面的创建、导航与关闭生命周期。
require('./task-page-lifecycle-support')(BrowserManager);
require('./main');
