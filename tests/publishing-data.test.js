const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DB = require('../src/main/db');

require('../src/main/publishing-data-support')(DB);

function withDb(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qqchannel-data-'));
  const db = new DB(directory);
  try {
    return run(db);
  } finally {
    db.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('task content and comment are stored separately', () => withDb(db => {
  const instance = db.listInstances()[0];
  db.importRemoteChannels(instance.id, [{
    name: '测试频道',
    url: 'https://pd.qq.com/g/pd10000001',
    guildNumber: 'pd10000001'
  }]);
  const channel = db.listChannels(instance.id)[0];

  const taskId = db.createTask(
    instance.id,
    '',
    { content: '真正发布的正文', comment: '发布后的评论' },
    'D:\\media\\one.jpg',
    [channel.id],
    'image'
  );

  const raw = db.getTask(taskId);
  assert.equal(raw.body, '真正发布的正文');
  assert.equal(raw.comment, '发布后的评论');
  assert.equal(raw.title, '真正发布的正文');

  const listed = db.listTasks(instance.id, 1, 10).items[0];
  assert.equal(listed.content, '真正发布的正文');
  assert.equal(listed.body, '发布后的评论');
}));

test('task cannot use a channel owned by another instance', () => withDb(db => {
  const first = db.listInstances()[0];
  const secondId = Number(db.createInstance('实例二').lastInsertRowid);
  db.importRemoteChannels(secondId, [{
    name: '实例二频道',
    url: 'https://pd.qq.com/g/pd20000002',
    guildNumber: 'pd20000002'
  }]);
  const foreignChannel = db.listChannels(secondId)[0];

  assert.throws(() => db.createTask(
    first.id,
    '测试',
    { content: '正文', comment: '' },
    '',
    [foreignChannel.id],
    'text'
  ), /不属于该账号实例/);
}));

test('published target state preserves post URL for comment retry', () => withDb(db => {
  const instance = db.listInstances()[0];
  db.importRemoteChannels(instance.id, [{
    name: '测试频道',
    url: 'https://pd.qq.com/g/pd30000003',
    guildNumber: 'pd30000003'
  }]);
  const channel = db.listChannels(instance.id)[0];
  const taskId = db.createTask(instance.id, '正文', { content: '正文', comment: '评论' }, '', [channel.id], 'text');
  const target = db.getTask(taskId).targets[0];

  db.markTargetPostPublished(target.id, 'https://pd.qq.com/post/B_TEST123');
  db.setTargetCommentStatus(target.id, 'failed');

  const stored = db.getTask(taskId).targets[0];
  assert.equal(stored.post_published, 1);
  assert.equal(stored.post_url, 'https://pd.qq.com/post/B_TEST123');
  assert.equal(stored.comment_status, 'failed');
}));
