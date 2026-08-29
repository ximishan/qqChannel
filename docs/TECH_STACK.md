# 技术栈与架构说明

## 1. 项目定位

`qqChannel` 是一个面向 Windows 桌面的腾讯频道批量发布工具。

核心目标：

- 使用桌面 GUI 管理多个独立账号/实例。
- 使用 Electron 内置 Chromium DOM 操作 `pd.qq.com`。
- 扫码登录一次后尽量长期复用登录状态。
- 使用 SQLite 保存实例、频道、任务、发布状态、选择器配置和日志。
- 腾讯频道页面 DOM 改动时，优先通过修改选择器配置适配，而不是重新修改并打包整个程序。

---

## 2. 核心技术栈

### Electron

用途：桌面程序外壳和 GUI。

负责：

- 主窗口和弹窗。
- Renderer 页面。
- Main Process。
- IPC 通信。
- 本地文件选择。
- 后续 Windows EXE 打包。

### Electron 内置 Chromium

用途：腾讯频道网页自动化。

负责：

- 使用 `WebContentsView` 嵌入 Chromium，不依赖客户电脑安装 Chrome。
- 每个实例使用独立的 `persist:qq-channel-instance-<id>` partition。
- 每个实例单独持久化并加密备份登录态。
- 打开腾讯频道。
- 定位发帖区域。
- 上传图片/视频。
- 填写正文。
- 点击发表。
- 检测执行结果。
- 后续失败截图、页面调试、登录失效判断。

### SQLite / better-sqlite3

用途：本地持久化数据。

当前主要数据：

- `instances`：实例。
- `channels`：频道。
- `tasks`：发布任务。
- `task_targets`：任务对应的目标频道以及每个频道的独立状态。
- `selector_configs`：腾讯频道页面元素选择器。
- `logs`：运行日志。

后续会继续扩展：

- `settings`：全局及实例级设置。
- `materials`：素材记录及去重信息。
- `publish_records`：完整发布历史。
- `templates`：标题、正文、评论模板。

---

## 3. 进程架构

```text
Electron Renderer
├─ 发布任务
├─ 频道管理
├─ 实例管理
├─ 设置
├─ 元素定位
└─ 日志
        │
        │ IPC
        ▼
Electron Main Process
├─ IPC Handlers
├─ DB Service
├─ BrowserManager
├─ Task Scheduler（后续完善）
└─ Publisher（后续拆分）
        │
        ├──────────► SQLite
        │
        ▼
Electron WebContentsView
        │
        ▼
每实例独立 Persistent Session
        │
        ▼
https://pd.qq.com/
```

---

## 4. 实例与登录态设计

一个实例代表一个独立登录的 QQ 账号。一个实例可以分配多个频道；实例之间的 Cookie、Web Storage、浏览器视图和发布 worker 相互隔离。

建议目录结构：

```text
Electron userData/
├─ publisher.db
├─ profiles/
│  ├─ 1/       # 实例 1 的加密登录备份
│  └─ 2/       # 实例 2 的加密登录备份
├─ logs/
└─ screenshots/
```

Electron Session 使用：

```js
session.fromPartition(`persist:qq-channel-instance-${instanceId}`)
```

不同实例之间隔离：

- Cookie 与 Web Storage
- Chromium 页面和登录状态
- 频道配置
- 发布任务
- 任务目标及执行状态

Cookie、LocalStorage、IndexedDB、登录状态和腾讯频道网页缓存全局共用。目标效果是扫码登录一次后可操作所有实例；关闭软件重新打开仍可继续使用，如果腾讯侧主动让登录失效，则重新扫码一次即可。

---

## 5. 腾讯频道页面适配策略

腾讯频道是动态 Web 应用，不适合大量依赖固定屏幕坐标。

项目采用：

```text
DOM / Locator 优先
    ↓
多候选选择器
    ↓
超时与状态检测
    ↓
截图及日志兜底
```

关键页面元素全部进入 `selector_configs`，例如：

- 发帖编辑区域。
- ProseMirror 正文编辑器。
- 图片/视频上传 input。
- 上传预览区域。
- 发表按钮。
- 发布结果或错误提示。

从目前拿到的腾讯频道页面 HTML 可以确认页面使用 ProseMirror 编辑器，DOM 中存在 `.ProseMirror` 相关结构，因此正文输入不应继续按照普通 `textarea` 处理。

原则：

1. 不使用固定坐标作为主要方案。
2. 不把腾讯页面 class 全部硬编码在业务逻辑里。
3. 选择器可以在 UI 中测试和修改。
4. 页面改版后优先更新配置。

---

## 6. 发布引擎目标结构

发布逻辑后续从 `BrowserManager` 继续拆分：

```text
Publisher
├─ openChannel()
├─ checkLogin()
├─ locateComposer()
├─ fillContent()
├─ uploadVideo()
├─ uploadImages()
├─ waitUploadReady()
├─ submit()
├─ verifyPublishResult()
├─ publishComment()
└─ captureFailure()
```

任务状态：

```text
pending
running
success
failed
paused
cancelled
```

目标频道状态独立记录：

```text
pending
running
success
failed
```

这样一个任务发布到 10 个频道时，即使第 7 个频道失败，前 6 个成功结果也不会丢失。

---

## 7. 桌面打包

当前使用 Electron Builder 打包 Windows 版本。

目标输出：

```text
qqChannel.exe
```

打包阶段还需要处理：

- Electron 内置 Chromium 运行时。
- better-sqlite3 原生模块重编译。
- userData 数据目录。
- 自动更新（后期）。
- 应用日志和崩溃日志。
