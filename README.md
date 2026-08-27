# 腾讯频道批量发布工具 Demo v0.3

技术栈：

- Electron
- Playwright
- SQLite (`better-sqlite3`)

## 项目文档

- [技术栈与架构说明](docs/TECH_STACK.md)
- [项目状态与功能清单](docs/PROJECT_STATUS.md)

`PROJECT_STATUS.md` 会持续记录：

- 已经实现的功能
- 尚未实现的功能
- 当前开发重点
- 后续版本规划

## 当前已经实现

### 桌面与数据层

- Electron 主进程 / Renderer / Preload / IPC。
- SQLite 本地数据库。
- 实例创建与切换。
- 每个实例独立 Chromium Profile。
- QQ 登录态持久化。
- 登录状态检测。
- 频道手工添加 / 删除。
- 多频道任务模型。
- 日志。

### 真实腾讯频道页面适配

已根据真实 `pd.qq.com` 页面 HTML 调整：

- ProseMirror 正文编辑器。
- `input[type=file]` 图片 / 视频上传。
- 等待素材上传完成。
- 等待“发表”按钮从 disabled 变为 enabled。
- 点击“发表”。
- 成功提示 / 编辑器清空双重 DOM 检测。
- 页面错误提示检测。
- 登录失效检测。
- 失败自动截图。
- 单频道失败自动重试。
- 只重新执行失败目标，不重复已成功频道。

### 发布队列 v0.3

- 每实例独立发布 worker。
- 启动发布。
- 暂停。
- 继续。
- 停止。
- 顺序执行 pending 任务。
- 全局随机任务间隔。
- GUI 下一条倒计时。
- 软件异常退出后将遗留 `running` 恢复为 `pending`。
- 登录失效时自动暂停队列，并保留未完成任务。

## 运行参数

设置页当前支持：

- 失败重试次数。
- 上传等待超时。
- 发布结果确认超时。
- 随机最小间隔。
- 随机最大间隔。
- 失败截图开关。
- 所有关键 DOM 选择器。

选择器支持**一项多行候选值**，会按顺序自动降级。

## 安装

```bash
npm install
npx playwright install chromium
npm start
```

也可以在 Windows 下运行：

```text
start-demo.bat
```

## 推荐测试流程

1. 启动软件。
2. 创建或选择实例。
3. 点击“登录QQ”，在 Chromium 中完成扫码。
4. 点击“检测登录”，确认顶部显示已登录账号。
5. 添加一个 `https://pd.qq.com/g/...` 频道。
6. 创建一条单视频、单频道测试任务。
7. 先使用“执行选中任务”验证真实发帖链路。
8. 查看日志以及失败截图。
9. 单条链路稳定后，再创建多条任务。
10. 设置随机间隔，点击“启动发布”测试队列。

## 数据目录

默认在 Electron `userData` 下建立：

```text
publisher.db
profiles/<instanceId>/
screenshots/YYYYMMDD/
```

浏览器 Cookie / LocalStorage / IndexedDB 均保存在实例独立 Profile 中。

## 当前下一步

优先继续：

1. 在真实账号环境验证一次完整发布。
2. 根据实际请求增加网络层成功检测，记录真实帖子 ID / URL。
3. 批量读取视频文件夹。
4. 图片 / 多图任务。
5. CSV / Excel 导入。

## 注意

腾讯频道页面 DOM 可能更新。本项目不使用固定屏幕坐标，关键页面元素全部保存在 SQLite 并支持在 UI 中修改和测试。
