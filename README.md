# 腾讯频道批量发布工具 Demo v0.1

技术栈：

- Electron
- Playwright
- SQLite (better-sqlite3)

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

为了避免把腾讯频道当前页面结构写死，默认选择器只是占位值。
第一次运行后请在“设置 -> 元素定位”里根据当前 pd.qq.com 页面调整选择器。

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
本 Demo 把关键元素定位全部做成配置项，避免每次改版都必须修改源码。
