module.exports = function installTaskContentSupport(DB) {
  const previousCreateTask = DB.prototype.createTask;

  DB.prototype.createTask = function createTaskWithPostContent(
    instanceId,
    title,
    commentPayload,
    mediaPath,
    channelIds,
    mediaType = 'video',
    scheduledAt = null,
    intervalMinSeconds = null,
    intervalMaxSeconds = null
  ) {
    let comment = commentPayload;
    let content = null;

    // Renderer 新版通过 body 传递 { comment, content }，从而不改 IPC 协议。
    // 旧版/批量任务仍然传字符串，继续按原来的“评论”参数处理。
    if (commentPayload && typeof commentPayload === 'object' && !Array.isArray(commentPayload)) {
      comment = String(commentPayload.comment || '').trim();
      content = String(commentPayload.content || '').trim();
    }

    let normalizedTitle = String(title || '').trim();
    if (!normalizedTitle && content) normalizedTitle = content.slice(0, 80);

    const taskId = previousCreateTask.call(
      this,
      instanceId,
      normalizedTitle,
      String(comment || '').trim(),
      mediaPath,
      channelIds,
      mediaType,
      scheduledAt,
      intervalMinSeconds,
      intervalMaxSeconds
    );

    if (content !== null) {
      this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(content, Number(taskId));
    }

    return taskId;
  };
};
