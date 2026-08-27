# 腾讯频道批量发布工具 Demo v0.1

技术栈：

- Electron
- Playwright
- SQLite (better-sqlite3)

## 项目文档

- [技术栈与架构说明](docs/TECH_STACK.md)
- [项目状态与功能清单](docs/PROJECT_STATUS.md)

`PROJECT_STATUS.md` 会持续记录：

- 已经实现的功能
- 尚未实现的功能
- 当前开发重点
- 后续版本规划

## 这个 Demo 已经包含

- 实例管理：创建、切换实例
- 每个实例独立浏览器 Profile
- Chromium 持久化登录状态
- QQ/腾讯频道登录入口
- 频道管理：名称 + URL
- 发布任务列表
- 创建视频任务
- 选择本地 MP4
- 目标频道选择
- 标题 / 正文输入
- Playwright 自动打开频道
- 元素选择器配置
- 选择器测试
- SQLite 数据保存
- 日志输出

## 当前 v0.1 的定位

这是一版“真实架构 Demo”，不是纯静态界面。

当前正在进入 v0.2：基于真实 `pd.qq.com` 页面结构适配发布流程，包括 ProseMirror 正文编辑器、媒体上传、发表按钮、发布结果检测、登录状态检测和失败恢复。

腾讯频道页面可能随时调整 DOM，因此关键元素定位继续采用可配置方案，而不是依赖固定坐标。

## 安装

```bash
npm install
npx playwright install chromium
npm start
```

## 推荐测试流程

1. 新建一个实例
2. 点“登录QQ”
3. 在弹出的 Chromium 中扫码登录
4. 关闭浏览器
5. 再点“登录QQ”，确认登录态仍然存在
6. 添加一个频道 URL
7. 在“设置 -> 元素定位”中配置当前页面元素
8. 创建一个视频任务
9. 选择 MP4
10. 点击“执行选中任务”

## 数据目录

默认在 Electron userData 下建立：

- `publisher.db`
- `profiles/<instanceId>/`

浏览器 Cookie / LocalStorage / IndexedDB 都保存在独立实例目录里。

## 注意

腾讯频道页面可能随时调整 DOM。
本项目把关键元素定位保存到 SQLite，并提供 UI 配置/测试能力，页面调整后优先修改元素配置，不必每次都重写发布代码。
