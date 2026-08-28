const DB = require('./db');
const BrowserManager = require('./browser');

// 必须最先安装：Windows 版 tencent-channel-cli 可能直接读取真实 ~/.qqcli，
// 这里对每个 QQ 账号做凭证目录硬隔离，避免切换账号后串登录状态。
require('./qqcli-credential-sandbox');

require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./multi-account-support').installMultiAccountSupport(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
