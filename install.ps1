[CmdletBinding()]
param(
    [ValidateSet('desktop', 'web')][string]$Profile = 'desktop',
    [string]$DesktopPath
)
$ErrorActionPreference = 'Stop'
$dmxVersion = '0.2.0'
$dmxPackageName = "dsh-dmxapi-$dmxVersion.tgz"
$dmxPackage = Join-Path $PSScriptRoot "artifacts\$dmxPackageName"
if (-not (Test-Path -LiteralPath $dmxPackage -PathType Leaf)) {
    throw "找不到 artifacts\$dmxPackageName。请完整解压本版本的 Windows ZIP；源码用户请先执行 npm ci 和 npm run pack:plugin。"
}

function Find-DmxDesktopCommand {
    param([string]$RequestedPath)
    $dmxCandidates = @()
    if ($RequestedPath) {
        $dmxCandidates = @($RequestedPath)
    } else {
        $dmxUninstallKeys = @(
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $dmxCandidates += @(Get-ItemProperty -Path $dmxUninstallKeys -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match '^DeepSeek Harness(?:\s|$)' -and $_.InstallLocation } |
            Select-Object -ExpandProperty InstallLocation)
        if ($env:LOCALAPPDATA) { $dmxCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness') }
        if ($env:ProgramFiles) { $dmxCandidates += (Join-Path $env:ProgramFiles 'DeepSeek Harness') }
    }
    foreach ($dmxCandidate in ($dmxCandidates | Select-Object -Unique)) {
        $dmxRoot = [IO.Path]::GetFullPath($dmxCandidate)
        $dmxCommand = Join-Path $dmxRoot 'resources\runtime\cli\bin\dsh.cmd'
        if ((Test-Path -LiteralPath $dmxCommand -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $dmxRoot 'DeepSeek Harness.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $dmxRoot 'resources\app.asar') -PathType Leaf)) {
            return $dmxCommand
        }
    }
    throw '找不到 DeepSeek Harness 桌面端内置命令。请先安装官方桌面端 0.2.0-rc.2，或用 -DesktopPath 指定含 DeepSeek Harness.exe 的安装目录。不会回退到 npm CLI。'
}

$dmxHarnessHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
$dmxProfileDir = Join-Path $dmxHarnessHome "profiles\$Profile"
$dmxDesktopCommand = $null
if ($Profile -eq 'desktop') {
    $dmxDesktopCommand = Find-DmxDesktopCommand -RequestedPath $DesktopPath
    $dmxManifestPath = Join-Path $dmxProfileDir 'package.json'
    if (-not (Test-Path -LiteralPath $dmxManifestPath -PathType Leaf)) {
        throw '桌面 profile 尚未初始化。请先启动一次 DeepSeek Harness 桌面端，再从应用菜单或系统托盘完全退出后重新安装。'
    }
    try { $dmxManifest = Get-Content -LiteralPath $dmxManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw '无法读取桌面 profile 的 package.json。请先在桌面端完成初始化或修复，不要用 npm CLI 重建 desktop profile。' }
    if (-not $dmxManifest.dsh.profile -or $null -eq $dmxManifest.dsh.profile.bundles) {
        throw 'desktop profile 不是已初始化的 Harness 配置。请先启动桌面端完成初始化。'
    }
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'DeepSeek Harness 桌面端仍在运行。请从应用菜单或系统托盘选择退出；仅关闭窗口可能仍在后台运行。退出后再执行安装脚本。'
    }
    # 包操作使用 package.json.lock；Desktop 初始化/恢复另有 lock。
    # 即使 PID 看似已退出，也不猜测锁是否可删除。
    foreach ($dmxLockName in @('package.json.lock', 'lock')) {
        if (Test-Path -LiteralPath (Join-Path $dmxProfileDir $dmxLockName)) {
            throw "检测到桌面 profile 锁文件（$dmxLockName）。请等待其他操作结束或通过桌面端排查后重试；安装脚本不会删除锁文件。"
        }
    }
} elseif ($DesktopPath) {
    throw '-DesktopPath 仅用于默认的 desktop 安装；Web 用户请只使用 -Profile web。'
}

# 保留安装包供 pnpm 后续重装。相对 profile 的无空格参数可跨过
# PowerShell -> dsh.cmd/npx.cmd -> dsh -> pnpm 的 Windows 参数转发。
$dmxPackageStore = Join-Path $dmxProfileDir 'local-packages'
New-Item -ItemType Directory -Path $dmxPackageStore -Force | Out-Null
Copy-Item -LiteralPath $dmxPackage -Destination (Join-Path $dmxPackageStore $dmxPackageName) -Force
$dmxPackageSpec = "file:local-packages/$dmxPackageName"
if ($Profile -eq 'desktop') {
    & $dmxDesktopCommand plugin --profile desktop add $dmxPackageSpec
} else {
    & npx.cmd --yes '@deepseek-ai/dsh@0.2.0-rc.2' plugin --profile web add $dmxPackageSpec
}
if ($LASTEXITCODE -ne 0) { throw "插件安装失败，退出码：$LASTEXITCODE" }
Write-Host '安装成功。请重新打开对应的 Harness，在左侧 插件 → DMXAPI-DSH配置工具 中配置模型。'
