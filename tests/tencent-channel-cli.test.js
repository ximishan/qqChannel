const test = require('node:test');
const assert = require('node:assert/strict');
const { TencentChannelCli, parseLastJson } = require('../src/main/tencent-channel-cli');

test('parseLastJson ignores non-JSON progress output', () => {
  const parsed = parseLastJson('uploading\n{"success":true,"data":{"feed_id":"feed-1"}}\n');
  assert.equal(parsed.data.feed_id, 'feed-1');
});

test('resolveChannel maps the pd guild number and prefers the 全部 board', async () => {
  const cli = new TencentChannelCli();
  cli.listGuilds = async () => [
    { guildId: 'guild-1', guildNumber: 'pd12345678', name: '频道一' }
  ];
  cli.listChannels = async () => [
    { channelId: 'board-other', name: '闲聊' },
    { channelId: 'board-all', name: '全部' }
  ];
  const resolved = await cli.resolveChannel({ name: '本地名称', url: 'https://pd.qq.com/g/pd12345678' });
  assert.deepEqual(resolved, {
    guildId: 'guild-1', guildNumber: 'pd12345678', channelId: 'board-all', channelName: '全部'
  });
});

test('video publishing and comments use the CLI JSON contract', async () => {
  const calls = [];
  const cli = new TencentChannelCli({
    executor: async (args, payload) => {
      calls.push({ args, payload });
      if (args.includes('publish-feed')) {
        return {
          code: 0,
          stdout: '{"success":true,"data":{"feed_id":"feed-1","create_time_raw":"123","share_url":"https://pd.qq.com/s/test"}}',
          stderr: ''
        };
      }
      return { code: 0, stdout: '{"success":true,"data":{"comment_id":"comment-1"}}', stderr: '' };
    }
  });

  const feed = await cli.publish({
    guildId: 'guild-1', channelId: 'board-1', content: '',
    mediaType: 'video', mediaPath: 'D:\\media\\one.mp4'
  });
  const comment = await cli.comment({
    feedId: feed.feed_id, feedCreateTime: feed.create_time_raw,
    guildId: 'guild-1', channelId: 'board-1', content: '首评'
  });

  assert.deepEqual(calls[0].payload.video_paths, [{ file_path: 'D:\\media\\one.mp4' }]);
  assert.equal(calls[0].payload.content, '');
  assert.equal(calls[1].payload.feed_id, 'feed-1');
  assert.equal(calls[1].payload.feed_create_time, '123');
  assert.equal(calls[1].payload.content, '首评');
  assert.equal(comment.comment_id, 'comment-1');
});
