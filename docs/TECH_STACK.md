# 技术栈与架构说明

## 1. 项目定位

`qqChannel` 是一个 Windows Electron 腾讯频道多账号批量发布工具。

当前核心约束：

- 一个实例 = 一个独立窗口 = 一个独立 QQ 登录会话。
- 一个实例可以管理多个频道和自己的发布任务。
- QQ 页面由 Electron `WebContentsView` 驱动。
- SQLite 保存实例、频道、任务、发布目标状态、设置和日志。
- 发布和评论以用户已经在 Tampermonkey 中实测通过的 DOM 流程为唯一标准。
- 不再运行旧 CLI 发布器、旧 selector 发布器或单账号兼容发布器。

## 2. 技术栈

### Electron

负责：

- 主进程
- Renderer
- Preload / IPC
- 多实例窗口
- 本地文件/目录选择
- Windows 打包

### WebContentsView + Chromium Session

负责：

- 内嵌 `pd.qq.com`
- 每实例独立浏览器视图
- 每实例独立 persistent partition
- QQ 登录态持久化
- DOM 发帖 / 评论

实例 partition：

```js
session.fromPartition(`persist:qq-channel-instance-${instanceId}`)
```

### SQLite / better-sqlite3

主要数据：

- `instances`
- `channels`
- `tasks`
- `task_targets`
- `settings`
- `logs`

历史安装中可能还存在 `selector_configs` 等旧结构。它们保留主要是为了兼容旧数据库，不代表当前发布流程仍读取可配置 selector。

## 3. 当前进程结构

```text
Renderer（每实例独立窗口）
├─ 发布任务
├─ 内置浏览器
├─ 频道管理
├─ 设置
└─ 日志
        │
        │ IPC
        ▼
Main Process
├─ DB
├─ BrowserManager
├─ TaskScheduler
├─ InstanceWindowSupport
├─ Login Support
├─ Channel Sync Support
└─ Userscript DOM Publisher
        │
        ▼
WebContentsView
        │
        ▼
persist:qq-channel-instance-<id>
        │
        ▼
https://pd.qq.com/
```

启动入口：`src/main/bootstrap.js`。

当前发布相关加载顺序：

```text
publishing-data-support
→ userscript-dom-publishing-support
→ publish-runtime-feedback-support
```

含义：

- `publishing-data-support`：只处理正文/评论数据模型、已发布标记和评论状态。
- `userscript-dom-publishing-support`：唯一发布/评论执行主链。
- `publish-runtime-feedback-support`：仅做 Electron 本地文件适配和实时步骤反馈，不提供第二套发布算法。

## 4. 多实例设计

每个实例隔离：

- Cookie
- LocalStorage / IndexedDB
- Chromium session
- WebContentsView
- 登录备份
- 频道
- 任务
- 发布队列

实例窗口顶部的下拉框是“窗口导航器”，不是账号切换器。选择另一个实例只会打开或聚焦它自己的窗口。

## 5. 登录设计

点击“登录QQ”：

```text
打开当前实例内置浏览器
→ 自动打开 QQ 登录入口
→ 自动尝试弹出二维码
→ 用户扫码
→ 自动轮询登录状态
→ 保存实例登录信息
→ 自动同步频道
```

只有看到明确的登录页/登录按钮证据时才允许把已确认登录的实例降级为未登录，避免普通频道页面 DOM 暂时变化导致误判掉线。

## 6. 频道同步

频道同步以自动化为主：

```text
已登录
→ 读取当前页面频道
→ 遍历侧边栏其他频道
→ 确认真实 URL 切换
→ 去重
→ 新增/更新 SQLite
```

发布队列工作期间，同实例频道同步必须延后，不能同时点击左侧频道，否则会与发帖操作争抢同一个页面。

## 7. 发布引擎

当前核心 DOM 来源于已验证的油猴脚本，例如：

```text
.publish-editor-container
.publish-editor-container .ProseMirror
.publish-editor-container input[type=file]
.publish-editor-container .publish-button button
.publish-editor-container .image-draggable-preview
.publish-editor-container .image-mask
.msgBox[data-index]
.bottom-comment-input .bottom-input
.comment-editor-container .ProseMirror
.comment-editor-container .publish-button button
```

发帖顺序：

```text
openEditor
→ typeInto
→ 本地文件通过 CDP 注入 input[type=file]
→ 保持油猴脚本同款文件选择事件语义
→ 等 pubPreview
→ 等 image-mask 消失
→ 等发表按钮可用
→ publish
→ waitForNewPost
```

评论顺序：

```text
进入 /post/B_xxx
→ 打开评论入口
→ 写入评论 ProseMirror
→ 等发送按钮可用
→ 点击发送
→ 通过评论数量 / 编辑器状态确认结果
```

原则：不要在这条链路外再叠加另一套“更聪明”的发布判断。

## 8. 任务与防重复

帖子正文：`tasks.body`

发布后评论：`tasks.comment`

每个目标频道独立保存：

- `status`
- `retry_count`
- `last_error`
- `post_published`
- `post_url`
- `comment_status`

当帖子已经确认发布但评论失败时，重试只补评论，不重新发帖。

## 9. Renderer 结构

当前只保留一套任务入口：“新建发布任务”。

视频任务内部可选择：

- 单个视频
- 视频目录批量

已经移除：

- 独立“批量视频目录”按钮和弹窗
- 发帖元素定位 UI
- 选择器测试 UI
- 单账号 UI
- 旧工作区 UI
- 旧术语/任务筛选兼容脚本

## 10. 打包

Electron Builder：

```bash
npm run build:win
```

`better-sqlite3` 通过 `electron-builder install-app-deps` 重建 Electron 对应原生模块。

## 11. 维护原则

1. 发布算法只认已验证油猴流程。
2. Electron 适配只解决本地文件、窗口、Session、IPC、日志和状态存储问题。
3. 同一个实例只允许一条页面自动化链路操作 QQ 页面。
4. 页面改动优先对照真实 DOM 和油猴脚本，不恢复旧发布器。
5. 清理代码时优先删除真正没有入口的兼容层，而不是继续隐藏。 
