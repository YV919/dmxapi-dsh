# DMXAPI-DSH配置工具安装指南

插件 `0.2.0` 适用于 DeepSeek Harness Desktop / Web `0.2.0-rc.2`。每位用户需要自己的 DMXAPI API Key。旧 Harness Web `0.1.5-rc.2` 请使用插件 [v0.1.9](https://github.com/YV919/dmxapi-dsh/releases/tag/v0.1.9)。

## 推荐：在工作台安装

1. 打开 Harness，在左侧选择 **插件 → 添加插件**。
2. 粘贴以下地址并点击 **安装**：

   ```text
   https://github.com/YV919/dmxapi-dsh/releases/download/v0.2.0/dsh-dmxapi-0.2.0.tgz
   ```

3. 安装成功后点击 **立即启用**；如果界面要求重启，按提示完成。
4. 在 **插件** 中打开 **DMXAPI-DSH配置工具**。

这一方式适用于桌面端和 Web，不需要执行安装脚本。桌面端使用其内置运行时和包管理器。压缩包下载和依赖安装需要联网；GitHub 不可达时可先下载 `.tgz`，在 **添加插件** 中填写该文件的完整绝对路径。

## Windows ZIP 与安装脚本

下载 [dsh-dmxapi-0.2.0-windows.zip](https://github.com/YV919/dmxapi-dsh/releases/download/v0.2.0/dsh-dmxapi-0.2.0-windows.zip)，完整解压，保留 `install.ps1` 与 `artifacts/` 的相对位置。不要在 ZIP 预览窗口中直接运行。

**桌面端：** 先启动一次官方 DeepSeek Harness Desktop `0.2.0-rc.2`，再从应用菜单或系统托盘选择 **退出**。仅关闭窗口可能仍在后台运行。在解压目录打开 PowerShell：

```powershell
.\install.ps1
```

脚本默认安装到 `desktop` profile，自动寻找桌面安装目录，只使用其中的 `resources/runtime/cli/bin/dsh.cmd`。找不到目录时明确指定：

```powershell
.\install.ps1 -DesktopPath 'C:\Users\你的用户名\AppData\Local\Programs\DeepSeek Harness'
```

`-DesktopPath` 填包含 `DeepSeek Harness.exe` 的安装目录。脚本不修改 PATH，不另装 Node.js，也不会使用 npm CLI 创建或修改 Desktop profile。安装成功后重新打开桌面端。

**Web：** 安装 Node.js `^22.19.0` 或 `>=24.0.0`，关闭已有 Web 服务后执行：

```powershell
.\install.ps1 -Profile web
npx --yes @deepseek-ai/dsh@0.2.0-rc.2 web
```

Web 安装会从 npm 获取指定版本的 Harness。两个模式都遵循当前终端的 `DSH_HOME`；未设置时使用用户目录下的 `.dsh`。安装和启动必须使用相同的 `DSH_HOME`。脚本将压缩包保留在对应 profile 的 `local-packages/`，用于后续重装，并避免中文或空格路径在多层命令转发中被拆开。

如果 PowerShell 阻止脚本执行，直接使用上面的工作台安装方式，无需更改系统执行策略。

## 从旧版本升级

在同一个 Desktop 或 Web profile 中升级；两种客户端的插件安装状态相互独立，Web 已安装不代表 Desktop 也已安装。新版 Harness 工作台没有独立的版本选择器：如果 **添加插件** 提示包已存在，可在插件页卸载旧版，再从新版本 `.tgz` 安装并启用，或退出相应客户端后运行本版本安装脚本。插件卸载、安装不删除已保存的服务商及密钥；不要手工删除 `.dsh` 或整个 profile。

升级完成后打开左侧 **插件**。旧版“设置 → 插件 → 插件配置”入口已由工作台插件页替代。

## 配置服务商与模型

1. 打开工作台左侧 **插件 → DMXAPI-DSH配置工具**。
2. 选择 **DMXAPI · Chat**、**DMXAPI · Responses**、**DMXAPI · Anthropic** 或 **新建自定义服务商**。前三项每份配置只对应一种协议；若同 ID、同协议的预设服务商已存在，插件优先打开它。存在历史副本时，可选择要编辑的路由；只有明确选择 **新建独立配置** 才会另外创建一份服务商。
3. 展开需要调整的模型卡，新增或修改模型，并核对图片输入、思考选项和容量。卡片只显示该模型已有的选项，可按需求添加或移除；传输方式与 YAML 在折叠的高级配置中。
4. 首次新建服务商时，在 **API Key** 输入框填写自己的密钥并点击 **新增配置**。输入默认隐藏，点击 **显示** 可查看正在填写的内容，也可切回 **隐藏**；无需设置环境变量。编辑已有服务商时直接点击 **保存模型修改**，无需重新填写密钥；这一步只更新模型列表和在表单中调整的默认思考等级，不改动原 API Key、地址或协议。
5. 新建会话，从 Harness 原生模型菜单选择刚保存的模型及其支持的思考等级；点击附件按钮添加图片。

| 格式 | 预设模型 ID（从上到下） |
| --- | --- |
| Chat | `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`qwen3.8-max`、`qwen3.8-max-0902`、`mimo-v2.6-pro` |
| Responses | `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` |
| Anthropic | `claude-fable-5-1-cc`、`claude-opus-5-5-cc`、`claude-sonnet-5-cc` |

Chat 使用 **跟随模型默认**：Qwen 默认 `medium`，其他已知预设默认 `high`，MiMo 默认在界面上显示 **开启**。Responses 与 Anthropic 预设仍默认 `high`。两款 Qwen 直接选择 `off / medium / xhigh`；MiMo 直接选择 **关闭 / 开启**，没有独立的强度等级。GLM、GPT-6 Astra、Claude Fable/Opus 不显示 `off`。这 12 个 DMXAPI 路由 ID 是否对你的账号可用仍需实测，Anthropic 模型的 `-cc` 必须原样保留。

上下文可快捷选择 **256K / 512K / 1M**，最大输出可快捷选择 **64K / 128K / 256K**，也可以手工输入。按钮分别填入 262144 / 524288 / 1000000 与 65536 / 131072 / 262144；不要把快捷选项视为每个模型都支持的上限。

升级不会迁移旧模型配置。如果已新建或手工采用 Qwen 原生等级配置，而会话仍保存 `high` 或 `max`，请展开 **思考等级** 菜单重选 `medium` 或 `xhigh`；只重新选择同一个模型不会清除旧等级。

已有同 ID、同协议的预设路由会在原位置保存模型改动，不会自动复制出 `dmxapi-chat-2`。只有显式选择 **新建独立配置** 或导入同名 YAML，才会使用下一个可用标识；手动填写已存在的标识作为新服务商时会被拒绝。**新建自定义服务商**和 YAML 导入仍是独立新增。其他配置和原密钥继续保留，可在 Harness 的 **设置 → 模型** 中管理；安装或升级不会自动迁移已有配置。

新建服务商时填写密钥会创建独立凭据引用，不替换旧密钥；留空只保留草稿自己导入的引用。编辑已有服务商不会读取或重写它的密钥。新建保存成功后输入框清空并恢复隐藏，切换预设或取消修改也会清空当前输入。若新建配置已保存但密钥失败，可点击 **重试密钥**，不会重复写模型配置。不要把密钥填写到“完整 YAML”中。

## 选择正确的接口和思考方式

| 预设 | 适合的模型格式 | DMXAPI 地址 |
| --- | --- | --- |
| DMXAPI · Chat | Chat Completions | `https://www.dmxapi.cn/v1` |
| DMXAPI · Responses | OpenAI Responses | `https://www.dmxapi.cn/v1` |
| DMXAPI · Anthropic | Anthropic Messages | `https://www.dmxapi.cn` |

一个模型只能放到它实际支持的接口下。若不知道模型格式，可查模型说明或 [DMXAPI 模型列表](https://doc.dmxapi.cn/omp.html)的 `supported_endpoint_types`。`-cc` 结尾的模型通常走 Anthropic 格式。

预设会自动使用对应请求参数：Qwen 开启时发送 `enable_thinking: true` 与同名 `reasoning_effort: medium / xhigh`，关闭时发送 `enable_thinking: false`；MiMo 只发送思考开关，不发送 effort。DeepSeek、GLM、GPT-6 与 Claude 按各自协议发送参数。通常无需展开高级配置；Anthropic 仅显示与所选模型适用的传输方式，导入的自定义草稿也可编辑。

**思考选项以每个模型实际支持的内容为准。** 可以添加或移除选项；多个模型没有共同默认等级时，服务商选择 **跟随模型默认**。配置保存及本地模拟测试通过，不等于 DMXAPI 所有模型已完成线上验收；请求字段与资料依据见 README。

新草稿切换协议时，会提示移除当前协议不兼容的 `compat` 参数；DMXAPI 的两种 OpenAI 协议使用 `/v1` 地址，Anthropic 使用域名根地址。其他自定义地址不会被自动修改。

这个安装包不包含作者的密钥和账号。API 请求由你自己的 DMXAPI 账号计费。完整选项与兼容范围见 `README.md`。
