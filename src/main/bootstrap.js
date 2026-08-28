const DB = require('./db');
const BrowserManager = require('./browser');

// Windows 版 CLI 默认登录态来自系统 keychain，不能靠 HOME/USERPROFILE 做账号隔离。
// 改为扫码后保存每个账号自己的 token，并通过 QQ_AI_CONNECT_DOTENV 明确选择账号凭证。
require('./qqcli-account-token');

require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./multi-account-support').installMultiAccountSupport(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
