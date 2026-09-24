# 面向公众分享与发布

源码仓库：[YV919/dmxapi-dsh](https://github.com/YV919/dmxapi-dsh)。当前发布路线是 GitHub 源码和 Release 预构建安装包；**尚未发布到 npm**。本文中的 npm 安装命令只有在维护者另外完成 npm 发布后才能使用。

当前明确适配并验证的版本是 **DeepSeek Harness 官方 Web `0.1.5-rc.2`**。不要把说明改成“支持全部版本”，也不要在未验证前将示例命令替换为最新版。每位使用者都需要自己的 DMXAPI API Key。

## 立即分享给其他人

可以先把预构建安装包、安装脚本和说明放进 ZIP。解压后的目录必须保留以下结构：

```text
dsh-dmxapi/
├── install.ps1
├── QUICKSTART.md
├── README.md
├── PUBLISHING.md
├── LICENSE
├── examples/
│   └── dmxapi.yaml
└── artifacts/
    └── dsh-dmxapi-0.1.8.tgz
```

`install.ps1` 按自身目录寻找 `artifacts/dsh-dmxapi-0.1.8.tgz`，因此不要把 tgz 单独移到脚本旁，也不要让接收者直接在 ZIP 预览窗口内执行脚本。

接收者需要先安装 Node.js 22 或更高版本，并准备自己的 DMXAPI API Key。在解压目录打开 PowerShell，执行：

```powershell
.\install.ps1
```

安装依赖需要联网；该 ZIP 是便携分发包，不是完整离线版 Harness。若设备禁止执行 PowerShell 脚本，`QUICKSTART.md` 提供了不修改执行策略的手动安装命令。

安装后关闭原来的 Harness 服务，再启动已验证的版本：

```powershell
npx --yes @deepseek-ai/dsh@0.1.5-rc.2 web
```

在“设置 → 插件 → 插件配置”的“DMXAPI-DSH配置工具”卡中，入口只有 **DMXAPI · Chat**、**DMXAPI · Responses**、**DMXAPI · Anthropic** 和 **新建自定义服务商**。插件只新增配置，不显示同步或编辑已有服务商；旧配置在原生模型页保留。同名预设或导入 YAML 自动分配新标识，手工重名会拒绝保存。接收者填写自己的 API Key 后点击 **新增配置**；新密钥使用独立随机引用，不覆盖旧密钥，无需设置环境变量。输入默认隐藏，保存成功后清空，已保存的明文不会读回。留空只保留草稿显式导入的引用。每模型的思考选项、图片输入和高级配置见 README。不要把自己的 Key 或整个 `.dsh` 目录分享给别人。

预设清单按顺序为：Chat 的 `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`qwen3.8-max`、`qwen3.8-max-0902`、`mimo-v2.6-pro`；Responses 的 `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`；Anthropic 的 `claude-fable-5-1-cc`、`claude-opus-5-5-cc`、`claude-sonnet-5-cc`。三个 `-cc` 后缀是 DMXAPI 路由 ID 的一部分，发布包和说明均须原样保留。厂商模型能力和接口映射经过文档核对，但 DMXAPI 是否对任一接收者的 Key 开通全部 12 个 ID 尚未验证。

## 推荐的正式发布方式

目前采用 GitHub 公开仓库和 Releases；npm 是可选的补充分发方式：

| 渠道 | 用途 |
| --- | --- |
| GitHub 公开仓库 | 开放源码、使用说明、问题反馈和版本记录 |
| GitHub Releases | 附上同版本 ZIP 和 tgz，方便下载及留存 |
| npm 公开包（可选，尚未发布） | 以后可提供按包名安装的方式 |

DeepSeek Harness 官方支持按 npm 包名或预构建 tgz 安装 bundle。现有 `package.json` 已声明 `dsh.bundle` 和客户端入口，tgz 包含构建后的 `lib/`。[官方插件打包与安装指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

### 1. 准备账号和项目信息

维护者需要：

- GitHub 仓库 `YV919/dmxapi-dsh` 已由作者提供。`package.json` 中的 `repository`、`homepage`、`bugs` 地址应指向该仓库。
- 只有选择额外发布 npm 时才需要 npm 账号和发布认证。[npm 官方发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

2026-09-24 查询 npm 官方 registry 时，`dsh-dmxapi` 返回 E404，当前未发现公开同名包；这不等于已预留名称，也不保证后续发布一定可用。若以后需要改包名，必须同步修改 bundle 中引用的包名、安装脚本、构建产物和文档，重新验证后再发布。

### 2. 先完成本地检查

在完整项目源码目录依次运行：

```powershell
npm ci
npm run typecheck
npm test
npm run pack:plugin
npm pack --dry-run --json
```

最后一条命令用于检查实际会进入 npm 包的文件名单；它不是发布命令。现有 `prepack` 会执行构建，因此请在已安装开发依赖的源码目录运行。

确认 `lib/index.js`、`lib/client.js`、`lib/LICENSE.js-yaml`、`cordis.patch.yml`、`package.json`、README、LICENSE 和示例都在包中。检查 GitHub 源码和 ZIP 的实际文件清单，排除 `node_modules/`、`.research/`、`.test-home/`、`.qa/`、`.dsh/`、日志、个人设置、凭据文件、`.env` 及真实 API Key；仅依赖 `.gitignore` 不足以证明发布内容正确。

使用预构建 tgz 在独立测试 profile 中安装，确认只有四个新建入口，三种预设的模型顺序准确。检查重名自动编号、手动重名拒绝、继承配置与并发写保护；旧配置和凭据不应变化。密钥失败重试必须只写本次创建的独立凭据，不再次写 provider。用真实 Harness 和本地模拟 HTTP/SSE 服务检查三种协议的路径、认证、图片、思考字段，以及带规范数字后缀的新路由。特别检查 DeepSeek off 显式 disabled、GLM 无 off、Qwen medium/xhigh 同名透传、MiMo 开/关且不发 effort、GPT-6 Astra 与 Claude Fable/Opus 无 off、Sol/Luna off=none、Sonnet off=disabled，以及默认输出上限。容量快捷值为 262144/524288/1000000 和 65536/131072/262144，保留手工输入。使用虚构凭据验证默认隐藏、显示切换、随机引用隔离、留空不写凭据、保存清空，以及 YAML 和发布包不含密钥。升级前后对真实 settings/credentials 做哈希核对，不自动迁移用户配置。上线前另用维护者自己的测试凭据做真实接口验收，不要把模拟测试写成线上测试已通过。

发布 `0.1.8` 时，还需检查从旧 DeepSeek 预设切换到 Responses 与 Anthropic 后的保存及 YAML 导出：已知不兼容字段应被清理，合法字段保持原值，未知字段应保留供 Harness 校验，模型自定义配置和密钥应保留。DMXAPI 地址按 OpenAI `/v1`、Anthropic 根地址归一化，任意自定义地址不得被自动修改。高级配置需按模型显示适用传输方式，并保留已有自定义配置。模型默认值适配需覆盖普通请求与 prepareCall，尊重显式默认值和关闭思考选择，并在卸载时清理。只有另行完成对应真实模型请求后，才能宣称其线上能力已验证，不能据此宣称 DMXAPI 全部模型均支持所有协议及所有思考等级。

升级不改写旧 Qwen 映射。只有已新建或手工采用原生等级配置、会话却仍保留 `high/max` 时，才需展开 **思考等级** 菜单重选 `medium/xhigh`；仅重选同一模型不会清除旧等级。不要直接修改用户会话数据库。

当前 `files` 没有包含 `scripts/`，这不会阻止安装 npm/tgz 预构建包：消费者使用 `lib/`，registry 安装不会执行 `prepack`。编译和重新打包则需要完整源码，不能让用户在解压后的 npm 包里执行源码构建步骤。[npm 脚本生命周期](https://docs.npmjs.com/misc/scripts/)

### 3. 公开源码与 Release；npm 可选

向用户指定的公开仓库上传经检查的源码、锁文件、构建脚本、测试、MIT LICENSE 和文档。添加 `dsh-plugin` topic，便于别人发现插件；这是官方 README 推荐的方式。[DeepSeek Harness 官方 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)

以下仅是以后选择 npm 分发时的命令，**本次 GitHub Release 与市场收录不依赖 npm**：

```powershell
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
```

`dsh-dmxapi` 是不带 scope 的包名，npm 中此类包是公开包。发布后先验证 registry 中版本存在，再在独立 profile 安装公开包，确认别人能正常获取。后续更改需要递增版本号，并同步更新版本相关的脚本和文档。[npm 官方发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

### 4. 提供给用户的安装方式

目前请下载 GitHub Release 中的 Windows ZIP，完整解压后执行 `install.ps1`；其他平台可下载同一 Release 的 `.tgz`，按照 Harness 官方文档用 `dsh plugin --profile <name> add ./dsh-dmxapi-0.1.8.tgz` 安装。以下按包名安装命令仅在额外发布 npm 后可用：

```powershell
npx --yes @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add dsh-dmxapi@0.1.8
```

已运行的 Harness 需要重启后加载新插件。用户随后在设置页选择预设并填写自己的 Key。仅安装公开插件不需要用户登录 npm。

### 5. 添加 GitHub Release 下载

为同一份源码建立版本标签和 Release `v0.1.8`，上传经过检查的 `dsh-dmxapi-0.1.8-windows.zip` 与 `dsh-dmxapi-0.1.8.tgz`。GitHub 自动提供的源码 ZIP 不能代替含 `artifacts/` 的用户安装 ZIP；目前源码中的 `lib/` 和 `artifacts/` 被忽略，下载源码后仍需自行构建。[GitHub Releases 官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

## 申请社区 dsh-market 收录

按 [awesome-dsh-plugin 投稿指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)向其目录仓库提交 PR，只新增 `data/plugins/YV919__dmxapi-dsh.yml`，不要手改生成的 README。条目使用 `category: model`，描述如实写明支持 DMXAPI 三种协议和自定义服务商，`tarball:` 指向固定的 `v0.1.8` Release `.tgz`。该目录要求源码仓库具有 `dsh.bundle`、`dsh-plugin` topic、真实代码，且创建满 24 小时；PR 合并后，社区 dsh-market 才会同步收录。这与 DeepSeek Harness 官方仓库的发布方式不同。

## 暂不提供 GitHub 源码直装命令

目前不要对外提供 `dsh plugin ... add github:用户名/仓库`。官方 dsh 文档说明，源码直装需要 `prepare` 构建，并且 pnpm 10 及以上会要求接收者允许构建脚本；本项目当前没有为这一安装路径提供已验证的 `prepare` 流程。发布到 npm 的预构建包和 Release 中的 tgz 更适合作为普通用户入口。[官方 GitHub 安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md#installing-from-github-the-build-script-catch)

后续需要自动化发布时，可以配置 GitHub Actions 与 npm Trusted Publishing。它使用 OIDC，不需要在工作流中长期保存 npm 发布令牌；首版可以先手动发布，后续再增加此流程。[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
