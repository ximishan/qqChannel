(() => {
  // 旧的独立“批量视频目录”入口已经合并进“新建发布任务”。
  // 保留这个文件仅作为兼容加载器，避免旧实例窗口仍引用它时报错。
  if (document.querySelector('script[data-qqchannel-task-video-folder="1"]')) return;
  const script = document.createElement('script');
  script.src = 'task-video-folder-integration.js';
  script.dataset.qqchannelTaskVideoFolder = '1';
  document.head.appendChild(script);
})();
