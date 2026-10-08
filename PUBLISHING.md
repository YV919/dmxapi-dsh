# 发布与市场投稿

源码仓库：[YV919/dmxapi-dsh](https://github.com/YV919/dmxapi-dsh)。插件 `0.2.0` 面向 DeepSeek Harness Desktop / Web `0.2.0-rc.2`，通过 GitHub Release 提供预构建包，尚未发布 npm。旧 Harness Web `0.1.5-rc.2` 使用插件 `0.1.9`。

GitHub Release 发布、市场投稿和市场收录是三个阶段。只有目录维护者合并投稿、市场完成同步后，才能称“已在市场上架”。当前状态以[投稿 PR](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pulls?q=dmxapi-dsh)和[社区目录](https://awesome-dsh-plugin.com/)为准。

## 1. 构建并验证

在源码目录执行：

```powershell
npm ci
npm run typecheck
npm test
npm run pack:plugin
npm pack --dry-run --json
```

检查包中包含 `lib/index.js`、`lib/client.js`、`lib/LICENSE.js-yaml`、`cordis.patch.yml`、`package.json`、README、LICENSE 和示例。确认源码、包和 ZIP 不含 `.research/`、`.qa/`、`.test-home/`、`.dsh/`、日志、个人配置、真实 API Key、凭据文件或 `.env`。检查实际打包名单，不能只依赖 `.gitignore`。

使用独立 `DSH_HOME` / profile 验证预构建 `.tgz`：

- 新工作台左侧 **插件 → DMXAPI-DSH配置工具** 能打开配置页；启停及重开页面没有重复注册。
- 三个预设和自定义入口正常；在已有服务商新增、修改、删除模型时，服务商 ID 数量不增加，原地址、协议、密钥引用及其他路由保留。
- 显式新建独立配置、历史副本选择、YAML 导入导出、同名拒绝、并发写保护与隐藏字段保护正常。
- 用虚构凭据验证默认隐藏、显示切换、保存清空与新建凭据隔离；模型修改不读回或重写密钥。
- 用本地 HTTP/SSE 服务验证 Chat、Responses、Anthropic 的地址、认证、图片、工具调用及思考字段，覆盖普通调用和 prepareCall；不将模拟验收写成真实 DMXAPI 模型验收。
- Desktop 使用已安装桌面端自带的运行时验收；其 `desktop` profile 必须已经初始化，命令行安装前需完全退出桌面。npm CLI 只用于 Web，不写 Desktop profile。

所有兼容声明以实际通过的版本为准，不因 SDK 类型检查通过就宣称所有桌面版本可用。`engines.dsh` 和 peer 范围如含预发布版本，必须明确允许对应的版本元组。

## 2. 发布 GitHub Release

提交检查后的源码并建立 `v0.2.0` 标签，将同一版本的以下资产上传到 Release：

- `dsh-dmxapi-0.2.0.tgz`：预构建插件，供工作台和社区市场安装。
- `dsh-dmxapi-0.2.0-windows.zip`：包含安装脚本和说明的 Windows 分发包。

ZIP 保留以下结构：

```text
dsh-dmxapi/
├── install.ps1
├── README.md
├── QUICKSTART.md
├── PUBLISHING.md
├── LICENSE
└── artifacts/
    └── dsh-dmxapi-0.2.0.tgz
```

可同时附带 `examples/`。GitHub 自动生成的 Source code ZIP 不含被忽略的构建产物，不能替代上述安装 ZIP。发布后以公开下载链接重新获取 `.tgz`，核对内容并在独立 profile 安装。

安装地址：

```text
https://github.com/YV919/dmxapi-dsh/releases/download/v0.2.0/dsh-dmxapi-0.2.0.tgz
```

用户在工作台 **插件 → 添加插件** 粘贴地址，安装后选择 **立即启用**。Windows 脚本默认 `desktop`；`-Profile web` 才走 npm Harness。具体操作见 [QUICKSTART.md](QUICKSTART.md)。

## 3. 向社区插件市场投稿

按 [awesome-dsh-plugin 投稿指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，从其最新 `main` 创建分支，只添加或更新 `data/plugins/YV919__dmxapi-dsh.yml`：

```yaml
url: https://github.com/YV919/dmxapi-dsh
name: YV919/dmxapi-dsh
category: model
description:
  en: Configure DMXAPI Chat Completions, Responses, Anthropic Messages, and custom providers; edit models on existing preset routes.
  zh: 配置 DMXAPI Chat、Responses、Anthropic 和自定义服务商，并直接编辑已有预设服务商的模型。
tarball: https://github.com/YV919/dmxapi-dsh/releases/download/v0.2.0/dsh-dmxapi-0.2.0.tgz
```

PR 目标为 **awesome-dsh-plugin/awesome-dsh-plugin:main**，不是 DeepSeek Harness 或 dsh-market 的源码仓库。先搜索本插件是否已有条目或未合并 PR，避免重复投稿；升级时更新自己的原条目。不要手改自动生成的 README，也不要修改其他插件条目。

仓库需包含真实可运行代码和 `dsh.bundle` manifest，带 `dsh-plugin` topic，且创建满一天。描述应只说实际功能，不写营销承诺。CI 检查条目格式、仓库门槛和站点构建，维护者另行审核代码及声明；有问题时修复同一 PR。通过 CI 不等于已经收录。合并后目录自动重建，社区 dsh-market 从该目录获取插件。

市场条目只使用指南支持的字段；不要添加 `npm`、`engines`。预构建地址须为 GitHub Release 托管的 HTTPS `.tgz`。本项目采用固定标签加版本化文件名，后续更新条目时一并更新；不要将 `releases/latest/download/` 与带版本的资产名组合。

截图可在本项目根目录放 `screenshots.json`，列出 1–8 个仓库内相对图片路径。截图需使用虚构凭据，不包含用户服务商密钥；无需把截图配置提交到目录仓库。

## 安装与分发边界

- 官方 Desktop 独占 `$DSH_HOME/profiles/desktop`。桌面内置 CLI 在应用完全退出后可管理插件，npm 安装的 dsh 不能代替它；脚本不修改 PATH。依据：[官方桌面说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/desktop/README.zh.md)。
- 保留 `dsh.bundle` 和 `dsh.client` 元数据及预构建 `lib/`。官方依赖由宿主提供，不把另一套 Harness 核心运行时装入用户 profile。依据：[插件打包指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/user/develop/basic/publish.md)。
- npm 是可选渠道，当前不要指导用户按 `dsh-dmxapi@0.2.0` 从 npm 安装。若以后发布，先核验包名、repository 和公开版本，再提供对应安装命令。
- GitHub 源码直装还需要受支持的 `prepare` 构建及 pnpm 构建授权；当前普通用户使用 Release 预构建包。
- 安装、升级不迁移原模型或会话，不修改用户原有 Qwen 等级映射。用户账号能调用哪些 DMXAPI 模型、是否支持图片和各思考参数，仍以其账号权限与真实接口测试为准。
