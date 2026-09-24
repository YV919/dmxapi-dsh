param([ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Profile = 'web')
$ErrorActionPreference = 'Stop'
$dmxPackage = Join-Path $PSScriptRoot 'artifacts\dsh-dmxapi-0.1.8.tgz'
if (-not (Test-Path -LiteralPath $dmxPackage -PathType Leaf)) {
    throw '找不到安装包，请先执行 npm ci 和 npm run pack:plugin。'
}
# 保留安装包供 pnpm 后续重装。相对于 profile 的无空格路径可跨过
# PowerShell -> npx.cmd -> dsh -> pnpm 的多层 Windows 参数转发。
$dmxHarnessHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$dmxPackageStore = Join-Path $dmxHarnessHome "profiles\$Profile\local-packages"
New-Item -ItemType Directory -Path $dmxPackageStore -Force | Out-Null
Copy-Item -LiteralPath $dmxPackage -Destination (Join-Path $dmxPackageStore 'dsh-dmxapi-0.1.8.tgz') -Force
& npx.cmd --yes '@deepseek-ai/dsh@0.1.5-rc.2' plugin --profile $Profile add 'file:local-packages/dsh-dmxapi-0.1.8.tgz'
if ($LASTEXITCODE -ne 0) { throw "插件安装失败，退出码：$LASTEXITCODE" }
Write-Host '安装成功。请重新启动 Harness 并刷新浏览器，然后进入 设置 → 插件 → 配置。'
