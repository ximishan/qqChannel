const fs = require('fs');
const { TencentChannelCli } = require('./tencent-channel-cli');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function nonRetryable(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

module.exports = function installCliPublishingSupport(DB, BrowserManager) {
  const originalInit = DB.prototype.init;
  DB.prototype.init = function initCliPublishing() {
    originalInit.call(this);
    this.ensureColumn('channels', 'guild_id', 'TEXT');
    this.ensureColumn('channels', 'guild_number', 'TEXT');
    this.ensureColumn('channels', 'post_channel_id', 'TEXT');
    this.ensureColumn('channels', 'post_channel_name', 'TEXT');
    this.ensureColumn('task_targets', 'feed_id', 'TEXT');
    this.ensureColumn('task_targets', 'feed_create_time', 'TEXT');
    this.ensureColumn('task_targets', 'comment_id', 'TEXT');
  };

  DB.prototype.saveChannelBinding = function saveChannelBinding(id, binding) {
    this.db.prepare(`
      UPDATE channels
      SET guild_id=?, guild_number=?, post_channel_id=?, post_channel_name=?
      WHERE id=?
    `).run(
      String(binding.guildId || ''),
      String(binding.guildNumber || ''),
      String(binding.channelId || ''),
      String(binding.channelName || ''),
      Number(id)
    );
  };

  DB.prototype.saveTargetFeed = function saveTargetFeed(id, result) {
    this.db.prepare(`
      UPDATE task_targets
      SET post_published=1,
          published_at=COALESCE(published_at, CURRENT_TIMESTAMP),
          post_url=COALESCE(NULLIF(?, ''), post_url),
          feed_id=COALESCE(NULLIF(?, ''), feed_id),
          feed_create_time=COALESCE(NULLIF(?, ''), feed_create_time)
      WHERE id=?
    `).run(
      String(result.share_url || ''),
      String(result.feed_id || ''),
      String(result.create_time_raw || result.feed_create_time || ''),
      Number(id)
    );
  };

  DB.prototype.markTargetCommentPublished = function markTargetCommentPublished(id, result = {}) {
    this.db.prepare(`
      UPDATE task_targets
      SET comment_status='success', comment_id=COALESCE(NULLIF(?, ''), comment_id)
      WHERE id=?
    `).run(String(result.comment_id || ''), Number(id));
  };

  BrowserManager.prototype.getChannelCli = function getChannelCli() {
    if (!this.channelCli) {
      this.channelCli = new TencentChannelCli({ userDataPath: this.userDataPath });
    }
    return this.channelCli;
  };

  BrowserManager.prototype.getPublishingLoginStatus = function getPublishingLoginStatus() {
    return this.getChannelCli().loginStatus();
  };

  BrowserManager.prototype.beginPublishingLogin = function beginPublishingLogin() {
    return this.getChannelCli().beginLogin();
  };

  BrowserManager.prototype.pollPublishingLogin = function pollPublishingLogin() {
    return this.getChannelCli().pollLogin();
  };

  BrowserManager.prototype.resolveCliTarget = async function resolveCliTarget(target) {
    const localName = String(target.channel_name || target.name || '').trim();
    const localUrl = String(target.channel_url || target.url || '').trim();
    if (target.guild_id && target.post_channel_id) {
      const cached = {
        guildId: String(target.guild_id),
        guildNumber: String(target.guild_number || ''),
        channelId: String(target.post_channel_id),
        channelName: String(target.post_channel_name || '全部')
      };
      this.db.log('info', `频道映射使用缓存：${localName || '未知频道'} -> ${cached.guildNumber || cached.guildId} / ${cached.channelName}`);
      return cached;
    }

    this.db.log('info', `正在解析频道映射：名称=${localName || '未知'}；URL=${localUrl || '未提供'}；已保存频道号=${target.guild_number || '无'}`);
    try {
      const binding = await this.getChannelCli().resolveChannel(target);
      this.db.saveChannelBinding(target.channel_id, binding);
      target.guild_id = binding.guildId;
      target.guild_number = binding.guildNumber;
      target.post_channel_id = binding.channelId;
      target.post_channel_name = binding.channelName;
      this.db.log('info', `频道映射成功：${localName || '未知频道'} -> ${binding.guildNumber || binding.guildId} / ${binding.channelName}(${binding.channelId})`);
      return binding;
    } catch (error) {
      this.db.log('error', `频道映射失败：名称=${localName || '未知'}；URL=${localUrl || '未提供'}；原因=${String(error?.message || error)}`);
      throw error;
    }
  };

  BrowserManager.prototype.publishOneTargetViaCli = async function publishOneTargetViaCli(task, target, attempt) {
    const cli = this.getChannelCli();
    const comment = String(task.comment || '').trim();
    const postAlreadyPublished = Number(target.post_published || 0) === 1;
    this.db.setTargetStatus(target.id, 'running');
    this.notifyPublishUpdate({
      type: 'target-started',
      instanceId: task.instance_id,
      taskId: task.id,
      channelName: target.channel_name,
      attempt
    });

    try {
      const binding = await this.resolveCliTarget(target);
      if (!postAlreadyPublished) {
        if (task.media_type !== 'text' && (!task.media_path || !fs.existsSync(task.media_path))) {
          throw nonRetryable(`素材文件不存在：${task.media_path || '未选择文件'}`);
        }
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 通过内置频道组件发布（第${attempt}次）`);
        const result = await cli.publish({
          guildId: binding.guildId,
          channelId: binding.channelId,
          content: task.media_type === 'text' ? String(task.body || task.title || '') : '',
          mediaType: task.media_type,
          mediaPath: task.media_path
        });

        this.db.saveTargetFeed(target.id, result);
        target.post_published = 1;
        target.post_url = String(result.share_url || target.post_url || '');
        target.feed_id = String(result.feed_id || '');
        target.feed_create_time = String(result.create_time_raw || '');
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 帖子发布成功，feed_id=${target.feed_id || '未返回'}，已保存评论所需标识`);
      } else {
        this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 帖子已发布，本次仅补发评论`);
      }

      if (!comment) {
        this.db.setTargetCommentStatus(target.id, 'skipped');
        this.db.setTargetStatus(target.id, 'success');
        this.notifyPublishUpdate({
          type: 'target-finished', instanceId: task.instance_id, taskId: task.id,
          channelName: target.channel_name, status: 'success'
        });
        return true;
      }

      if (!target.feed_id || !target.feed_create_time) {
        throw nonRetryable('该帖子由旧版网页流程发布，缺少安全补发评论所需的帖子标识；请删除旧任务后重新创建');
      }

      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 正在发送评论`);
      const commentResult = await cli.comment({
        feedId: target.feed_id,
        feedCreateTime: target.feed_create_time,
        guildId: binding.guildId,
        channelId: binding.channelId,
        content: comment
      });
      this.db.markTargetCommentPublished(target.id, commentResult);
      this.db.setTargetStatus(target.id, 'success');
      this.db.log('info', `任务 #${task.id} -> ${target.channel_name} 发布和评论均成功`);
      this.notifyPublishUpdate({
        type: 'target-finished', instanceId: task.instance_id, taskId: task.id,
        channelName: target.channel_name, status: 'success'
      });
      return true;
    } catch (error) {
      const postWasPublished = Number(target.post_published || 0) === 1;
      const message = postWasPublished && comment
        ? `帖子已发表，但评论发送失败：${String(error?.message || error)}`
        : String(error?.message || error);
      if (postWasPublished && comment) this.db.setTargetCommentStatus(target.id, 'failed');
      this.db.setTargetStatus(target.id, 'failed', message);
      this.db.log('error', `任务 #${task.id} -> ${target.channel_name} 失败：${message}`);
      this.notifyPublishUpdate({
        type: 'target-finished', instanceId: task.instance_id, taskId: task.id,
        channelName: target.channel_name, status: 'failed'
      });
      if (error?.retryable === false) throw error;
      if (!postWasPublished) {
        throw nonRetryable(`${message}；发布结果不确定，为避免重复帖子已停止自动重试`);
      }
      const wrapped = new Error(message);
      wrapped.retryable = true;
      throw wrapped;
    }
  };

  BrowserManager.prototype.publishTask = async function publishTaskViaCli(task) {
    const maxRetries = Math.max(0, Number(this.db.getSetting('max_retries', '2')) || 0);
    let allSuccess = true;
    this.db.setTaskStatus(task.id, 'running');
    this.db.log('info', `开始任务 #${task.id}`);
    const executableTargets = task.targets.filter(target => target.status !== 'success');
    this.notifyPublishUpdate({
      type: 'task-started', instanceId: task.instance_id, taskId: task.id,
      channels: executableTargets.map(target => target.channel_name)
    });

    const login = await this.getPublishingLoginStatus();
    if (!login.loggedIn) {
      this.db.setTaskStatus(task.id, 'failed');
      this.db.log('error', `任务 #${task.id} 未执行：腾讯频道发布授权未登录或已失效`);
      this.notifyPublishUpdate({
        type: 'task-finished', instanceId: task.instance_id, taskId: task.id,
        success: false, successCount: 0, failedCount: executableTargets.length
      });
      throw new Error('腾讯频道发布授权未登录或已失效，请先点击“登录QQ”扫码授权');
    }

    this.db.log('info', `任务 #${task.id} 发布授权有效，开始处理 ${executableTargets.length} 个目标频道`);
    for (let targetIndex = 0; targetIndex < executableTargets.length; targetIndex += 1) {
      const target = executableTargets[targetIndex];
      let success = false;
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        try {
          if (attempt > 1) {
            this.db.incrementTargetRetry(target.id);
            this.db.log('warn', `任务 #${task.id} -> ${target.channel_name} 开始重试 ${attempt - 1}/${maxRetries}`);
            await sleep(3000);
          }
          await this.publishOneTargetViaCli(task, target, attempt);
          success = true;
          break;
        } catch (error) {
          lastError = error;
          if (error?.retryable === false) {
            this.db.log('warn', `任务 #${task.id} -> ${target.channel_name} 遇到不可自动重试的问题，已停止重试`);
            break;
          }
        }
      }
      if (!success) {
        allSuccess = false;
        const suffix = lastError?.retryable === false ? '已停止重试' : '已达到最大重试次数';
        this.db.log('error', `任务 #${task.id} -> ${target.channel_name} ${suffix}：${String(lastError?.message || lastError || '')}`);
      }

      if (targetIndex < executableTargets.length - 1) {
        const waitMs = this.targetIntervalMs();
        if (waitMs > 0) {
          const nextChannelName = executableTargets[targetIndex + 1].channel_name;
          this.db.log('info', `任务 #${task.id} 多频道发布间隔 ${Math.round(waitMs / 1000)} 秒，下一个：${nextChannelName}`);
          this.notifyPublishUpdate({
            type: 'target-waiting', instanceId: task.instance_id, taskId: task.id,
            seconds: Math.round(waitMs / 1000), nextChannelName
          });
          await sleep(waitMs);
        }
      }
    }

    this.db.setTaskStatus(task.id, allSuccess ? 'success' : 'failed');
    this.db.log('info', `任务 #${task.id} 结束，状态：${allSuccess ? 'success' : 'failed'}`);
    const finishedTask = this.db.getTask(task.id);
    const targetResults = finishedTask.targets.map(target => ({
      channelName: target.channel_name,
      status: target.status
    }));
    const successCount = targetResults.filter(target => target.status === 'success').length;
    const failedCount = targetResults.filter(target => target.status === 'failed').length;
    const result = { success: allSuccess, taskId: task.id, successCount, failedCount, targets: targetResults };
    this.notifyPublishUpdate({ type: 'task-finished', instanceId: task.instance_id, ...result });
    return result;
  };
};
