# 剪辑助手安全审核报告

- 审核日期：2026-11-29（Pacific/Auckland）
- 审核对象：当前工作区源码、依赖清单/锁文件、构建和打包脚本、现有 Windows 发布压缩包及本次 Windows 构建输出
- 状态：代码审查、Windows 测试与构建已完成；macOS Apple Silicon 构建与运行验证尚待 GitHub Actions 实际执行；本报告不是发布就绪证明

## 1. 项目概况与范围

项目是以 Python 3.14/Tkinter、Node.js 22、原生 HTML/CSS/JavaScript 和少量 C#/.NET Framework 构成的桌面剪辑/下载应用。Windows 使用 WinForms/WebView2 宿主、FFmpeg、MLT、ONNX Runtime GPU、DeepFilterNet 和 sherpa-onnx。源码约 298 个项目文件；本次阅读了源码、测试、文档、PowerShell 打包脚本、Python requirements、Node package/lock、MLT staging 与安装包生成脚本，并扫描两份 Windows ZIP 的文件名和文本内容。

代码审查重点覆盖本地 HTTP/RPC 服务、WebView 消息桥、上传与素材路径、项目数据读写、压缩包解压、子进程调用、凭据持久化、依赖和发布脚本。本次新增的 macOS 工作流只构建并保留 CI 工件，权限为 `contents: read`，第三方 Actions 固定到完整提交 SHA；尚未取得实际运行结果。二进制模型、媒体运行库及第三方打包组件只检查了来源/打包路径与完整性检查，未对每个二进制做反汇编或模糊测试。

### 直接依赖及本地版本

| 生态 | 直接依赖 | 清单约束 / 本地 Windows 环境版本 |
|---|---|---|
| Python | yt-dlp | `2026.7.4` / `2026.7.4` |
| Python | gdown | `6.4.1` / `6.4.1` |
| Python | Pillow | `13.0.0` / `13.0.0` |
| Python | NumPy | `2.5.4` / `2.5.4` |
| Python | onnxruntime-gpu（Windows） | `1.31.1` / `1.31.1` |
| Python | onnxruntime（macOS） | `1.31.1` / 未安装于 Windows venv |
| Python | tkinterdnd2 | `0.6.3` / `0.6.3` |
| Python | PyInstaller | `6.22.3` / `6.22.3` |
| Python | pythonnet（Windows） | `3.1.0` / `3.1.0` |
| Python | pyobjc-framework-Cocoa（macOS） | `13.0` / 未安装于 Windows venv |
| Python | pyobjc-framework-WebKit（macOS） | `13.0` / 未安装于 Windows venv |
| Python | requests | `>=2.32.2` / `2.34.2` |
| Python | urllib3 | `>=2.8.0` / `2.8.0` |
| Python | certifi | `>=2026.10.19` / `2026.10.23` |
| Python | pycryptodomex | 未固定 / `3.24.2` |
| Python | phonenumbers | `>=9.0.40` / `9.0.43` |
| Node | node-pty | `1.1.0` / `1.1.0` |

Python venv 含 41 个已安装发行包；关键间接 Python 包包括 pythonnet/clr_loader、ONNX/CUDA 运行组件、cudnn、cublas、cufft、curand。Node 锁文件共 2 个包，间接依赖 `node-addon-api@7.1.1`。内置 Windows Node 为 `v22.23.5`，Undici 为 `6.29.1`。`requirements.txt` 不是锁文件，requests、urllib3、certifi、phonenumbers、pycryptodomex 等未完全固定。

PyPI 发布文件列表确认 `onnxruntime@1.31.1` 有 CPython 3.14 / macOS ARM64 wheel，`pyobjc-framework-WebKit@13.0` 有 CPython 3.14 universal2 wheel；这只确认依赖工件可获取，不代表本地 Mac 安装或应用运行已验证（[ONNX Runtime wheel](https://pypi.org/project/onnxruntime/1.31.1/)，[PyObjC WebKit wheel](https://pypi.org/project/pyobjc-framework-WebKit/13.0/)）。

## 2. 问题汇总

| 编号 | 类别 | 严重级别 | 位置 | 状态 |
|---|---|---|---|---|
| SEC-01 | 代码 / XSS | Medium | `core/editor_runtime/src/ui/scripts/01-core-state.js:1304` | 已修复 |
| SEC-02 | 发布配置 / 密钥保护 | Low | `.gitignore:1` | 已修复 |
| SEC-03 | 依赖可复现性 | Low | `requirements.txt:1` | 建议关注 |
| SEC-04 | macOS 凭据保护 | Medium | `core/editor_runtime/src/secret-store.mjs:91`、`macos/KeychainHelper.swift:1` | 待 Apple Silicon 验证 |
| SEC-05 | macOS 桌面宿主 | Medium | `core/embedded_editor_macos.py:264`、`core/embedded_editor_macos.py:446` | 待 Apple Silicon 验证 |

本次未确认 Critical 或 High 的可利用漏洞。SEC-04/05 是新建 macOS 路径的发布前验证项，并非已确认的 Windows 缺陷。

## 3. 已修复问题

### SEC-01：工程目录 ID 未转义即可进入 HTML

- **风险 / 利用条件：** 若本地项目目录元数据含恶意 `id`，界面将其拼接进 `innerHTML` 属性，打开该目录后可能形成存储型 HTML/脚本注入。攻击者需要先影响本机项目目录数据。
- **级别：** Medium。
- **修复：** 将所有属性上下文中的 `item.id` 通过 HTML 转义函数输出，避免 `& < > " '` 作为标签/属性语法执行。

### SEC-02：未来误提交 `.env` 文件

- **风险 / 利用条件：** 仓库此前未统一忽略 `.env` 文件；开发者若加入含凭据的本地文件，可能误提交。
- **级别：** Low。
- **修复：** `.gitignore` 忽略 `.env` 和 `.env.*`，同时允许提交 `.env.example`。扫描没有发现仓库中的 `.env`，因此没有创建空的示例配置文件。

### SEC-04：macOS 不再以明文回写服务凭据

- **改动：** macOS 凭据改由 Keychain Helper 写入 Apple 钥匙串；凭据文件只保留不可逆路径索引。旧版 macOS 明文凭据首次读取时迁入钥匙串；Windows DPAPI 凭据不能跨设备解密时会提示重新输入，避免退回明文保存。
- **验证限制：** 当前工作站为 Windows，Swift Helper、Keychain 权限提示、应用签名后的访问控制和迁移流程尚未在 macOS 上运行。

### SEC-05：macOS WebKit 桌面桥接与路径处理

- **改动：** 新增 macOS WKWebView 宿主，后端子进程使用随机会话令牌。WebKit 首次请求通过仅限原生启动请求的自定义头取得 `HttpOnly; SameSite=Strict` 会话 Cookie；Node 本地服务仍校验回环 Host、Origin、路径和会话令牌。界面消息限于本地来源；系统外链只允许用户主动点击后交给系统浏览器。
- **验证限制：** 当前无 macOS 构建机可直接验证 WKWebView 消息、Cookie、拖放、导出、退出保存握手、权限和窗口生命周期。完成 CI 构建/测试之前不得把该路径视为可发布。
- **补充：** Tk 与 AppKit 共用主线程；宿主通过 Tk 定时器泵送 AppKit/WebKit 事件。该集成方式只有静态/语法检查，尚未在 Apple Silicon 桌面运行验证。

## 4. 依赖漏洞核对

- 上一轮本地审计记录：`pip-audit --path .venv/Lib/site-packages` 检查 41 个发行包，未发现已知漏洞；`npm audit` 检查锁文件 2 个包，0 个已知漏洞。本轮复核时当前 Python 环境没有安装 `pip-audit`，npm audit 访问 registry 时 DNS 解析失败，因此无法在本轮独立刷新数据库；不得把本轮视作新的在线扫描结果。
- `urllib3@2.8.0` 已达到 GHSA-8988-9cw3-xx77 修复版本要求；应用当前不低于 2.8.0。
- `certifi@2026.10.23` 高于 GHSA-6q48-6c7w-9gw2 指出的修复版本。
- `yt-dlp@2026.7.4` 达到 GHSA-6v4j-43gg-vj32 修复版本；代码没有使用该公告涉及的 `--write-link` 功能。
- `gdown@6.4.1` 高于 GHSA-76hw-p97h-883f 的修复边界。
- `Pillow@13.0.0` 已包含 GHSA-78g4-xqwv-q3g8、GHSA-c6hw-5grf-ff96、GHSA-wqgw-9xfh-qf2g 对应修复。项目的转描预处理主要接收 FFmpeg 生成的 PNG；未找到依赖 `getexif` 或 Arrow API 的业务路径。
- `pycryptodomex@3.24.2` 没有在本轮工具结果中发现已知漏洞。上游未来迁移到 `pycryptodome` 时会影响导入命名，建议等上游稳定迁移说明后单独处理，不在本次擅自换包。
- 未发现停止维护或名称明显疑似仿冒的直接依赖。未完全固定的 Python 依赖降低构建复现性；目前不是已确认漏洞。

参考公告：

- [GHSA-8988-9cw3-xx77（urllib3）](https://github.com/advisories/GHSA-8988-9cw3-xx77)
- [GHSA-6q48-6c7w-9gw2（certifi）](https://github.com/certifi/python-certifi/security/advisories/GHSA-6q48-6c7w-9gw2)
- [GHSA-6v4j-43gg-vj32（yt-dlp）](https://github.com/advisories/GHSA-6v4j-43gg-vj32)
- [GHSA-76hw-p97h-883f（gdown）](https://github.com/wkentaro/gdown/security/advisories/GHSA-76hw-p97h-883f)
- [GHSA-78g4-xqwv-q3g8（Pillow）](https://github.com/advisories/GHSA-78g4-xqwv-q3g8)
- [GHSA-c6hw-5grf-ff96（Pillow）](https://github.com/advisories/GHSA-c6hw-5grf-ff96)
- [GHSA-wqgw-9xfh-qf2g（Pillow）](https://github.com/advisories/GHSA-wqgw-9xfh-qf2g)

## 5. 代码与发布安全检查

- Node 本地服务绑定回环地址，授权请求校验精确 Host、Origin、会话令牌；RPC POST 校验 JSON 类型；响应启用 CSP、nonce、`nosniff` 与 `no-referrer`。
- 上传名会清理路径分隔符和控制字符；项目资源路径与解压路径会做包含关系校验；归档解压拒绝符号链接/特殊文件。
- WebView2 只访问本地编辑器来源；外部窗口仅由用户点击的 HTTP(S) 链接打开；消息来源固定为编辑器 origin。
- Windows 凭据用当前用户 DPAPI 保护，保护失败时不保存明文。
- MLT 下载资源按 SHA-256 核验，包脚本会重新读取 ZIP 成员、校验文件数/哈希，并拒绝打入用户数据、凭据种子和私有缓存。
- 新增 `.github/workflows/build-macos.yml`：仅响应指定分支 push 或手动启动，使用 Apple Silicon `macos-15` runner，权限为 `contents: read`，Actions 固定到 SHA，不创建 Release 或标签；CI 尚未运行。
- Mac 构建脚本将 DeepFilterNet 固定到上游提交 `978576aa8400552a4ce9730838c635aa30db5e61` 并使用 `cargo --locked`；Shotcut DMG 使用 SHA-256 校验。以上构建逻辑尚未在 Apple Silicon runner 执行。
- 文本密钥扫描覆盖源码、配置、文档和两个 ZIP，共扫描每包 2,491 个文本文件。仅发现 yt-dlp 上游 extractor 中 5 个类似密钥格式的服务端常量；它们不是本项目账号凭据，未输出明文或误删。未发现仓库自有 API key、访问令牌、私钥、数据库凭据、Webhook 或已跟踪 `.env`。

## 6. 构建与测试

- Windows `build.ps1` 及其打包前检查已运行成功：媒体预检通过、Python 单测 4 项通过、Node 安全测试 7 项通过，PyInstaller 与 .NET WebView2 宿主构建成功。首轮预检发现 `core/preflight_media.py` 使用 `os.name` 但缺少 `import os`，已修复后重跑通过。
- 本次成功构建生成的是 Windows 应用目录，不是最终 Release 安装包/便携包；配套 ZIP/DMG、SHA-256 和最终制品扫描要等 Mac 版构建验证后再制作。
- 打包日志出现可选 ONNX quantization/TensorRT DLL 缺失提示；代码没有调用 `onnxruntime.quantization` 或 TensorRT API。这些不是当前已确认的运行时漏洞。
- **macOS 构建/运行未完成。** 报告中的 WKWebView、Keychain Helper、Apple Silicon 依赖和媒体处理功能均须在 macOS runner 上验证。

## 7. 剩余风险与后续建议

1. 发布前让 `requirements.txt` 采用可复现锁定策略，避免宽范围依赖在重建时静默漂移；应与项目现有构建流程一起设计，不在本次随意逐项改成猜测版本。
2. 所有曾提交或泄露过的凭据应在对应服务端作废并重新生成；删除文件或改为钥匙串存储不能撤销已泄露的凭据。本轮未发现本项目自有凭据，因此没有要求轮换某个具体密钥。
3. 先完成 macOS Apple Silicon CI 与用户界面/导出/降噪实机验证，再制作同一版本号的 Apple 与 Windows 安装包并一起发布。
4. macOS 公共分发需要确认 Developer ID 签名和 notarization 的证书/账号条件；本报告不把未签名或仅 ad-hoc 签名包认定为已验证的公开发行件。
