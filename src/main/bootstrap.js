const DB = require('./db');
const BrowserManager = require('./browser');

// 单账号模式：直接使用 tencent-channel-cli 在当前 Windows 用户下的登录态。
// 不再加载多账号 token/keychain 隔离补丁。
require('./single-account-support')(DB, BrowserManager);
require('./task-list-filter-support')(DB);
require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
