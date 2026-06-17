# iCourse Batch Video Downloader

![License](https://img.shields.io/badge/license-MIT-green.svg)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-f7df1e?logo=javascript&logoColor=000)
![Userscript](https://img.shields.io/badge/type-userscript-blue)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-supported-00485b)
[![Greasy Fork](https://img.shields.io/badge/Greasy%20Fork-install-red)](https://greasyfork.org/zh-CN/scripts/583017-icourse-batch-video-downloader/)
![GitHub stars](https://img.shields.io/github/stars/TimoZhou1024/icourse_download?style=flat)
![GitHub last commit](https://img.shields.io/github/last-commit/TimoZhou1024/icourse_download)

中文 | [English](README.en.md)

iCourse 课程回放视频链接收集、导出和下载辅助脚本。脚本运行在已登录的 `https://icourse.fudan.edu.cn/` 页面中，只处理当前账号已经可以正常访问的课程资源。

## 功能

- 获取当前账号可见课程列表，并按学期分组显示。
- 支持选择单节课、一门课全部小节，或全部课程中的可回放小节。
- 支持多路视频流选择：默认主视频流，也可以切换为全部视频流。
- 自动进入播放页并收集播放器生成的 signed MP4 URL。
- 支持导出 JSON、CSV、TXT、PowerShell、并行 PowerShell、aria2c 清单、IDM PowerShell。
- 支持通过本机 aria2 JSON-RPC 一键发送任务到 Motrix/aria2。
- 可选自动确认播放页中的平台资源使用规范提示。

## 安装

1. 安装浏览器 userscript 管理器：
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Violentmonkey](https://violentmonkey.github.io/)
2. 使用以下任一方式安装脚本：
   - GitHub Raw: `https://raw.githubusercontent.com/TimoZhou1024/icourse_download/main/icourse-batch-downloader.user.js`
   - Greasy Fork: `https://greasyfork.org/zh-CN/scripts/583017-icourse-batch-video-downloader/`
3. 打开 `https://icourse.fudan.edu.cn/` 并正常登录。
4. 页面右下角出现 `iCourse 视频` 按钮后即可使用。

## 使用方法

1. 登录 iCourse，并进入可访问课程页面。
2. 点击右下角 `iCourse 视频` 按钮打开面板。
3. 首次使用时确认合规提示：仅处理自己有权限访问且允许保存的课程资源。
4. 选择课程、小节或具体视频流。
5. 点击 `收集所选链接`，等待脚本打开播放页并捕获 signed URL。
6. 根据需要选择：
   - `浏览器下载`
   - `发送到 Motrix/aria2`
   - `导出下载 PowerShell`
   - `导出并行 PowerShell`
   - `导出 aria2c 清单`
   - `导出 IDM PowerShell`

## 下载方式

### 浏览器下载

适合少量 MP4 文件。HLS/m3u8 不会在浏览器内合并分片，建议使用外部工具。

### Motrix / aria2

脚本提供 `发送到 Motrix/aria2`。默认 RPC 地址为：

```text
http://127.0.0.1:16800/jsonrpc
```

独立 aria2 常见 RPC 地址为：

```text
http://127.0.0.1:6800/jsonrpc
```

iCourse 的 signed MP4 对外部多连接 Range 分片不稳定。脚本默认使用单文件单连接，并通过多文件并发提高整体速度：

```text
split=1
max-connection-per-server=1
continue=false
async-dns=false
no-proxy=*
```

如果 Motrix 无法接收任务，请确认 aria2 RPC 已开启，并检查 RPC 地址和 Token 是否正确。

### IDM

使用 `导出 IDM PowerShell` 生成脚本后运行。脚本会查找 `IDMan.exe`，将 signed MP4 加入 IDM 队列并启动下载。

IDM 命令行模式不会为每个任务附加自定义 `Referer` 或 `User-Agent`，因此请先在脚本中完成 signed MP4 URL 捕获。

### PowerShell

- `导出下载 PowerShell`：使用 `curl.exe` 下载，速度较慢但相对稳妥。
- `导出并行 PowerShell`：需要 PowerShell 7 才能真正并行，可调整脚本中的 `$ThrottleLimit` 控制并发。

## 已知限制

- 不绕过登录、权限、验证码、DRM 或平台限制。
- 裸 MP4 URL 通常不能直接下载，需要先捕获带 `clientUUID` 和 `t` 参数的 signed URL。
- signed URL 可能有时效限制，失效后需要点击 `刷新 signed URL`。
- HLS/m3u8 不在浏览器内合并分片。
- iCourse signed MP4 虽然可能声明 `Accept-Ranges: bytes`，但外部 Range 请求可能返回 `403`，因此不建议对单个文件使用多连接分片下载。

## 开发与验证

本仓库是单文件 userscript 项目，核心脚本为：

```text
icourse-batch-downloader.user.js
```

提交前可运行语法检查：

```powershell
node --check icourse-batch-downloader.user.js
```

Greasy Fork 发布说明可参考：

```text
greasyfork-additional-info.md
```

## 合规说明

请只处理自己账号有权访问，且课程、教师、学校或平台规则允许下载或保存的资源。本脚本不提供也不尝试提供任何权限绕过、DRM 绕过、验证码绕过或登录绕过能力。

## 许可证

MIT License。脚本元数据包含：

```js
// @license      MIT
```
