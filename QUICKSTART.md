# DMXAPI-DSH配置工具安装说明（Windows）

适用：DeepSeek Harness 官方 Web `0.1.5-rc.2`。需要先安装 Node.js 22 或更新版本，并能访问 npm 和 DMXAPI。

## 安装

1. 完整解压 ZIP；保留 `install.ps1` 和 `artifacts` 文件夹的相对位置。
2. 在解压后的文件夹打开 PowerShell，执行：

   ```powershell
   .\install.ps1
   ```

3. 安装成功后关闭已有 Harness 服务，再启动：

   ```powershell
   npx --yes @deepseek-ai/dsh@0.1.5-rc.2 web
   ```

安装过程需要联网下载官方 Harness 及依赖。默认安装到当前用户 `.dsh` 的 `web` profile；使用自定义 `DSH_HOME` 的用户，应在设置了相同变量的终端中运行安装和启动命令。

若系统提示脚本未签名或禁止执行，请按你所在设备的 PowerShell 脚本策略处理，或使用下面的手动安装方式，无需修改系统执行策略：

```powershell
$dmxHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$dmxStore = Join-Path $dmxHome 'profiles\web\local-packages'
New-Item -ItemType Directory -Path $dmxStore -Force | Out-Null
Copy-Item -LiteralPath '.\artifacts\dsh-dmxapi-0.1.8.tgz' -Destination $dmxStore -Force
npx.cmd --yes @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add file:local-packages/dsh-dmxapi-0.1.8.tgz
```

## 填写自己的密钥

1. 打开 **设置 → 插件 → 插件配置 → DMXAPI-DSH配置工具**。
2. 在 **新增服务商** 中选择 **DMXAPI · Chat**、**DMXAPI · Responses**、**DMXAPI · Anthropic** 或 **新建自定义服务商**。前三项的模型已按下面的顺序填好，每份配置只对应一种协议。
3. 展开需要调整的模型卡，核对图片输入、思考选项和容量。卡片只显示该模型已有的选项，可按需求添加或移除；传输方式与 YAML 在折叠的高级配置中。
4. 在同一张配置卡的 **API Key** 输入框填写自己的密钥，点击 **新增配置**。输入默认隐藏，点击 **显示** 可查看正在填写的内容，也可随时切回 **隐藏**；无需设置环境变量。
5. 新建会话，从 Harness 原生模型菜单选择刚保存的模型及其支持的思考等级；点击附件按钮添加图片。

| 格式 | 预设模型 ID（从上到下） |
| --- | --- |
| Chat | `deepseek-v4.1-flash`、`glm-5.3`、`glm-5.3-flash`、`qwen3.8-max`、`qwen3.8-max-0902`、`mimo-v2.6-pro` |
| Responses | `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna` |
| Anthropic | `claude-fable-5-1-cc`、`claude-opus-5-5-cc`、`claude-sonnet-5-cc` |

Chat 使用 **跟随模型默认**：Qwen 默认 `medium`，其他已知预设默认 `high`，MiMo 默认在界面上显示 **开启**。Responses 与 Anthropic 预设仍默认 `high`。两款 Qwen 直接选择 `off / medium / xhigh`；MiMo 直接选择 **关闭 / 开启**，没有独立的强度等级。GLM、GPT-6 Astra、Claude Fable/Opus 不显示 `off`。这 12 个 DMXAPI 路由 ID 是否对你的账号可用仍需实测，Anthropic 模型的 `-cc` 必须原样保留。

上下文可快捷选择 **256K / 512K / 1M**，最大输出可快捷选择 **64K / 128K / 256K**，也可以手工输入。按钮分别填入 262144 / 524288 / 1000000 与 65536 / 131072 / 262144；不要把快捷选项视为每个模型都支持的上限。

升级不会迁移旧模型配置。如果已新建或手工采用 Qwen 原生等级配置，而会话仍保存 `high` 或 `max`，请展开 **思考等级** 菜单重选 `medium` 或 `xhigh`；只重新选择同一个模型不会清除旧等级。

这里**只新增，不同步或覆盖旧配置**。选择同名预设或导入同名 YAML，会自动使用 `dmxapi-chat-2` 等新标识；手动填写已存在的标识会被拒绝。旧配置和旧密钥继续保留，可在 Harness 的 **设置 → 模型** 中管理。

填写密钥会创建独立凭据引用，不替换旧密钥；留空只保留草稿自己导入的引用。保存成功后输入框清空并恢复隐藏，切换预设或取消修改也会清空当前输入。若配置已新增但密钥失败，可点击 **重试密钥**，不会重复写模型配置。不要把密钥填写到“完整 YAML”中。

## 选择正确的接口和思考方式

| 预设 | 适合的模型格式 | DMXAPI 地址 |
| --- | --- | --- |
| DMXAPI · Chat | Chat Completions | `https://www.dmxapi.cn/v1` |
| DMXAPI · Responses | OpenAI Responses | `https://www.dmxapi.cn/v1` |
| DMXAPI · Anthropic | Anthropic Messages | `https://www.dmxapi.cn` |

一个模型只能放到它实际支持的接口下。DMXAPI 的 [ZCode 配置教程](https://doc.dmxapi.cn/zcode.html)也将三种格式建为独立供应商。若不知道模型格式，可查模型说明或 [DMXAPI 模型列表](https://doc.dmxapi.cn/omp.html)的 `supported_endpoint_types`。`-cc` 结尾的模型通常走 Anthropic 格式。

预设会自动使用对应请求参数：Qwen 开启时发送 `enable_thinking: true` 与同名 `reasoning_effort: medium / xhigh`，关闭时发送 `enable_thinking: false`；MiMo 只发送思考开关，不发送 effort。DeepSeek、GLM、GPT-6 与 Claude 按各自协议发送参数。通常无需展开高级配置；Anthropic 仅显示与所选模型适用的传输方式，导入的自定义草稿也可编辑。

**思考选项以每个模型实际支持的内容为准。** 可以添加或移除选项；多个模型没有共同默认等级时，服务商选择 **跟随模型默认**。配置保存及本地模拟测试通过，不等于 DMXAPI 所有模型已完成线上验收；请求字段与官方依据见 README。

新草稿切换协议时，会提示移除当前协议不兼容的 `compat` 参数；DMXAPI 的两种 OpenAI 协议使用 `/v1` 地址，Anthropic 使用域名根地址。其他自定义地址不会被自动修改。

这个安装包不包含作者的密钥和账号。API 请求由你自己的 DMXAPI 账号计费。完整选项与兼容范围见 `README.md`。
