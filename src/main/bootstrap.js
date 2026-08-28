const DB = require('./db');
const BrowserManager = require('./browser');

require('./comment-support')(DB, BrowserManager);
require('./cli-publishing-support')(DB, BrowserManager);
require('./channel-sync-support');
require('./main');
