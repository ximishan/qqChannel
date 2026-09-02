const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const DB = require('../src/main/db');
const BrowserManager = require('../src/main/browser');

require('../src/main/publishing-data-support')(DB);
require('../src/main/userscript-dom-publishing-support')(DB, BrowserManager);
require('../src/main/publish-runtime-feedback-support')(BrowserManager);

app.whenReady().then(() => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-publisher-smoke-'));
  const db = new DB(temporary);
  const fakeWindow = {
    on() {},
    isDestroyed: () => false,
    webContents: { send() {} }
  };
  const manager = new BrowserManager(temporary, db, fakeWindow);

  try {
    const first = db.listInstances()[0];
    const secondId = Number(db.createInstance('账号实例 2').lastInsertRowid);

    assert.notEqual(manager.partitionName(first.id), manager.partitionName(secondId));
    assert.notEqual(manager.authStatePath(first.id), manager.authStatePath(secondId));
    assert.equal(typeof manager.qqcOpenEditor, 'function');
    assert.equal(typeof manager.qqcSetFile, 'function');
    assert.equal(typeof manager.qqcWaitReady, 'function');
    assert.equal(typeof manager.qqcPublish, 'function');
    assert.equal(typeof manager.qqcComment, 'function');

    db.importRemoteChannels(first.id, [{
      name: '测试频道',
      url: 'https://pd.qq.com/g/pd12345678',
      guildNumber: 'pd12345678'
    }]);
    const channel = db.listChannels(first.id)[0];
    const taskId = db.createTask(
      first.id,
      '图片任务',
      { content: '正文', comment: '首评' },
      'D:\\media\\one.jpg',
      [channel.id],
      'image'
    );
    const task = db.getTask(taskId);
    assert.equal(task.body, '正文');
    assert.equal(task.comment, '首评');
    assert.equal(task.targets.length, 1);
    assert.equal(task.targets[0].post_published, 0);

    console.log('electron userscript publishing smoke: ok');
  } finally {
    db.db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
