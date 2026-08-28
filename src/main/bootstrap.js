const DB = require('./db');
const BrowserManager = require('./browser');

// 单账号模式：直接使用 tencent-channel-cli 在当前 Windows 用户下的登录态。
// 本地数据按 QQ account_id 隔离；多账号分支后续只需要增加凭据切换能力。
require('./single-account-support')(DB, BrowserManager);
require('./task-list-filter-support')(DB);
require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./account-workspace-support')(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
