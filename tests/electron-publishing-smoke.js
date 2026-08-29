const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const DB = require('../src/main/db');
const BrowserManager = require('../src/main/browser');

require('../src/main/comment-support')(DB, BrowserManager);
require('../src/main/cli-publishing-support')(DB, BrowserManager);

app.whenReady().then(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-publisher-smoke-'));
  const db = new DB(temporary);
  const sent = [];
  const fakeWindow = {
    on() {},
    isDestroyed: () => false,
    webContents: { send() {} }
  };
  const manager = new BrowserManager(temporary, db, fakeWindow);
  manager.channelCli = {
    loginStatus: async () => ({ loggedIn: true }),
    resolveChannel: async () => ({
      guildId: 'guild-1', guildNumber: 'pd12345678', channelId: 'board-1', channelName: '全部'
    }),
    publish: async payload => {
      sent.push({ type: 'post', payload });
      return { feed_id: 'feed-1', create_time_raw: '123', share_url: 'https://pd.qq.com/s/test' };
    },
    comment: async payload => {
      sent.push({ type: 'comment', payload });
      return { comment_id: 'comment-1' };
    }
  };

  try {
    db.setSetting('max_retries', '0');
    db.setSetting('target_interval_seconds', '0');
    const instance = db.listInstances()[0];
    const secondInstanceId = Number(db.createInstance('账号实例 2').lastInsertRowid);
    assert.notEqual(manager.partitionName(instance.id), manager.partitionName(secondInstanceId));
    assert.notEqual(manager.authStatePath(instance.id), manager.authStatePath(secondInstanceId));
    db.setInstanceLoginState(instance.id, true, '账号A');
    db.setInstanceLoginState(secondInstanceId, false, '');
    const instanceStates = db.listInstances();
    assert.equal(instanceStates.find(item => item.id === instance.id).login_status, 'logged_in');
    assert.equal(instanceStates.find(item => item.id === secondInstanceId).login_status, 'logged_out');

    const imported = db.importRemoteChannels(secondInstanceId, [{
      name: '实例二频道',
      url: 'https://pd.qq.com/g/pd20000002',
      guildNumber: 'pd20000002'
    }]);
    assert.deepEqual(imported, { created: 1, updated: 0, skipped: 0 });
    assert.equal(db.listChannels(secondInstanceId).length, 1);

    const channelId = Number(db.addChannel(instance.id, '测试频道', 'https://pd.qq.com/g/pd12345678').lastInsertRowid);
    const taskId = db.createTask(instance.id, '纯文本内容', '首评内容', '', [channelId], 'text');
    const result = await manager.publishTask(db.getTask(taskId));
    const stored = db.getTask(taskId);

    assert.equal(result.success, true);
    assert.deepEqual(sent.map(item => item.type), ['post', 'comment']);
    assert.equal(stored.targets[0].post_published, 1);
    assert.equal(stored.targets[0].feed_id, 'feed-1');
    assert.equal(stored.targets[0].feed_create_time, '123');
    assert.equal(stored.targets[0].comment_id, 'comment-1');
    assert.equal(stored.targets[0].status, 'success');

    const retryTaskId = db.createTask(instance.id, '第二条内容', '需要重试的首评', '', [channelId], 'text');
    const retryTask = db.getTask(retryTaskId);
    let firstComment = true;
    manager.channelCli.comment = async payload => {
      sent.push({ type: 'comment-retry', payload });
      if (firstComment) {
        firstComment = false;
        throw new Error('模拟评论超时');
      }
      return { comment_id: 'comment-2' };
    };
    const postCountBeforeRetry = sent.filter(item => item.type === 'post').length;
    await assert.rejects(manager.publishOneTargetViaCli(retryTask, retryTask.targets[0], 1), /评论发送失败/);
    await manager.publishOneTargetViaCli(retryTask, retryTask.targets[0], 2);
    const postCountAfterRetry = sent.filter(item => item.type === 'post').length;
    assert.equal(postCountAfterRetry - postCountBeforeRetry, 1, 'comment retry must not publish the post again');
    assert.equal(sent.filter(item => item.type === 'comment-retry').length, 2);
    assert.equal(db.getTask(retryTaskId).targets[0].status, 'success');
    console.log('electron publishing smoke: ok');
  } finally {
    db.db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
