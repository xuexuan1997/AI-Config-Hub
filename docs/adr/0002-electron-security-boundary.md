# ADR-0002：Electron 特权能力仅存在于主进程

## 状态

已接受，适用于 MVP 技术基线。

## 背景

桌面端需要扫描用户目录、读取和部署配置、访问 SQLite、调用 Git，并在必要时打开外部链接。这些能力一旦直接暴露给渲染进程，任何 XSS、依赖漏洞或导航劫持都可能升级为本地文件读写或命令执行。

## 决策

- 文件系统、SQLite、Git 和受控子进程能力只存在于 Electron 主进程及其调用的基础设施包。
- 渲染进程启用 `contextIsolation: true`，关闭 `nodeIntegration`，并在兼容条件下启用 sandbox。
- preload 只暴露版本化的业务级 API，不暴露通用文件、Shell、进程或任意 IPC 调用能力。
- IPC 请求与响应在边界两端使用 Zod 校验。
- 导航、新窗口和外部协议默认拒绝，仅对白名单行为开放。
- CLI 不复用 preload 或 IPC；它直接调用相同核心用例，并承担独立的参数与输出边界校验。

详细控制见[系统架构](../architecture/overview.md)、[API、IPC 与 CLI](../architecture/api-and-ipc.md)和[安全架构](../architecture/security.md)。

## 备选方案

### 渲染进程启用 Node.js

实现简单，但浏览器内容与本地权限处于同一信任域，无法接受。

### preload 暴露通用文件 API

比直接启用 Node.js 更窄，但仍把路径判断、权限和操作组合交给不可信渲染层，难以审计。

### 本地 HTTP 服务

可以复用 Web UI，但会增加监听地址、身份认证、跨站请求和服务生命周期威胁。MVP 不需要远程访问，因此不采用。

## 后果

正面影响：

- renderer compromise 不会自动获得任意本地权限。
- API 可按业务意图进行路径、状态和权限校验。
- Electron 界面与 CLI 可以共享核心用例而保持不同边界。

负面影响：

- 新增桌面能力需要同步定义 Schema、preload 客户端和主进程处理器。
- IPC 契约和事件顺序需要专门的契约测试。
- 界面不能直接使用仅在 Node.js 可用的库。

## 复审条件

- Electron 安全模型发生破坏性变化。
- 产品需要独立浏览器入口或远程访问。
- sandbox 与关键桌面能力出现不可调和的兼容问题。
