const DB = require('./db');
const BrowserManager = require('./browser');

// 先加载通用 token 支持；Windows 下再覆盖为“系统凭据快照”方案。
require('./qqcli-account-token');
require('./windows-keychain-account-sandbox');

require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./multi-account-support').installMultiAccountSupport(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
