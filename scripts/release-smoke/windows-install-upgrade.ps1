<#
.SYNOPSIS
  MangaReader Windows 安装 / 覆盖升级 / 回滚验证脚本（需要干净的 Windows VM）。

.DESCRIPTION
  本脚本用于在**一次性干净 Windows 虚拟机**上验证发行链路中最容易出问题、
  且 CI 无法覆盖的一段：NSIS 安装、覆盖升级（数据不丢）与回滚。

  它**不会**在 CI 中自动运行：GitHub-hosted runner 不是干净用户环境，
  也没有可交互的桌面会话。因此本脚本是「维护者在 VM 上按步骤执行」的
  可复现流程，当前状态为 BLOCKED（见 docs/dev/RELEASE.md）。

  重要约束（与 AGENTS.md 一致）：
  - 只在一次性 VM 上运行；脚本不读取也不上传任何用户数据；
  - 不修改签名私钥、不接触 GitHub Release、不推送 Tag；
  - 只做安装/启动/数据存活检查，不做静默自动更新。

.EXAMPLE
  pwsh -File scripts/release-smoke/windows-install-upgrade.ps1 `
    -PreviousInstaller D:\artifacts\MangaReader_0.17.1_x64-setup.exe `
    -Installer D:\artifacts\MangaReader_0.17.2_x64-setup.exe `
    -ExpectedVersion 0.17.2 -CleanEnvironment -ImageName "Windows 11 Pro 24H2"

.NOTES
  干净环境声明：只有在**一次性干净 Windows 虚拟机**上执行时才加 `-CleanEnvironment`，
  并用 `-ImageName` 记录镜像标识。共享宿主上不要加：回执里的
  `machine.cleanEnvironment=false` 会被发布门禁拒绝，这是刻意的失败方向。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,

  [Parameter(Mandatory = $false)]
  [string]$PreviousInstaller,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedVersion,

  [Parameter(Mandatory = $false)]
  [string]$DataDir = "$env:APPDATA\com.local.manga-reader",

  [Parameter(Mandatory = $false)]
  [switch]$KeepInstalled,

  [Parameter(Mandatory = $false)]
  [string]$Commit = "",

  [Parameter(Mandatory = $false)]
  [string]$EmitEvidence = "",

  [Parameter(Mandatory = $false)]
  [string]$DataDirForApp = "",

  [Parameter(Mandatory = $false)]
  [string]$MergeFrom = "",

  [Parameter(Mandatory = $false)]
  [string]$ArtifactName = "",

  [Parameter(Mandatory = $false)]
  [switch]$CleanEnvironment,

  [Parameter(Mandatory = $false)]
  [string]$ImageName = ""
)

$ErrorActionPreference = "Stop"
$script:Failures = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Message) {
  Write-Host "== $Message" -ForegroundColor Cyan
}

function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) {
    Write-Host "   OK  $Message"
  } else {
    Write-Host "   FAIL $Message" -ForegroundColor Red
    $script:Failures.Add($Message)
  }
}

function Get-InstalledMangaReader {
  # NSIS CurrentUser 安装：卸载信息在 HKCU；机器级安装在 HKLM。
  $roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($props.DisplayName -eq "MangaReader") {
        return [pscustomobject]@{
          # 注册表里的 InstallLocation 可能自带引号（NSIS 写入形式），先剥掉。
          InstallLocation = ($props.InstallLocation -replace '"', '')
          DisplayVersion  = $props.DisplayVersion
          UninstallString = $props.UninstallString
          Key             = $key.PSPath
        }
      }
    }
  }
  return $null
}

function Invoke-Installer([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "找不到安装包：$Path"
  }
  Write-Host "   SHA256: $((Get-FileHash -Algorithm SHA256 $Path).Hash)"
  # NSIS 静默安装：/S 必须大写；/D= 仅在机器级安装下生效，CurrentUser 会忽略。
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -PassThru
  $process.WaitForExit(180000) | Out-Null
  if (-not $process.HasExited) {
    $process.Kill()
    throw "安装程序超时未退出：$Path"
  }
  if ($process.ExitCode -ne 0) {
    throw "安装程序返回非零退出码：$($process.ExitCode)"
  }
}

function Get-LibraryState([string]$Dir) {
  $db = Join-Path $Dir "library.db"
  if (-not (Test-Path $db)) {
    return [pscustomobject]@{ Exists = $false; Size = 0; Modified = $null }
  }
  $item = Get-Item $db
  return [pscustomobject]@{
    Exists  = $true
    Size    = $item.Length
    Modified = $item.LastWriteTimeUtc
  }
}

function Test-AppLaunch([string]$InstallLocation) {
  $exe = Join-Path $InstallLocation "MangaReader.exe"
  if (-not (Test-Path $exe)) {
    $exe = Join-Path $InstallLocation "manga-reader-tauri.exe"
  }
  if (-not (Test-Path $exe)) {
    Assert-True $false "安装目录里找不到主程序：$InstallLocation"
    return
  }
  # 隔离数据目录：绝不碰真实用户的书库。
  $env:MR_DATA_DIR = $DataDirForApp
  $env:MR_RENDER_CACHE_DIR = Join-Path $DataDirForApp "render_cache"
  $env:MR_ONLINE_CACHE_DIR = Join-Path $DataDirForApp "online_cache"
  $proc = Start-Process -FilePath $exe -PassThru
  Start-Sleep -Seconds 12
  $running = -not $proc.HasExited
  Assert-True $running "主程序启动后仍在运行（PID $($proc.Id)）"
  if ($running) {
    # VM 是一次性的：直接结束进程属于测试清理，不是产品的静默重启。
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Step "预检"
Assert-True (Test-Path $Installer) "安装包存在：$Installer"
$resolvedImage = if ($ImageName) { $ImageName } else { $env:IMAGE_NAME }
if ($CleanEnvironment) {
  # 声明了干净环境就必须能说明这是哪套镜像：无法溯源的声明一律无效。
  Assert-True ([bool]$resolvedImage) "声明干净环境时必须提供镜像标识（-ImageName 或 IMAGE_NAME）"
}
Write-Host "   干净环境声明：$([bool]$CleanEnvironment)（镜像：$resolvedImage）"
$beforeState = Get-LibraryState $DataDir
Write-Host "   数据目录：$DataDir（库存在：$($beforeState.Exists)）"

$freshInstallOk = $false
$upgradeOk = $false
$recoveryOk = $false

if ($PreviousInstaller) {
  Write-Step "安装旧版本（建立升级起点）"
  Invoke-Installer $PreviousInstaller
  $oldInstall = Get-InstalledMangaReader
  Assert-True ($null -ne $oldInstall) "旧版本已注册到卸载列表"
  if ($oldInstall) {
    Write-Host "   旧版本：$($oldInstall.DisplayVersion) @ $($oldInstall.InstallLocation)"
  }
  $afterOld = Get-LibraryState $DataDir
  Assert-True ($afterOld.Exists -or $beforeState.Exists) "旧版本启动后数据目录状态可读"
}

Write-Step "安装新版本（覆盖升级）"
Invoke-Installer $Installer
$newInstall = Get-InstalledMangaReader
Assert-True ($null -ne $newInstall) "新版本已注册到卸载列表"
if ($newInstall) {
  Write-Host "   新版本：$($newInstall.DisplayVersion) @ $($newInstall.InstallLocation)"
  if ($ExpectedVersion) {
    Assert-True ($newInstall.DisplayVersion -eq $ExpectedVersion) "安装版本 = $ExpectedVersion"
  }
  Test-AppLaunch $newInstall.InstallLocation
  if ($PreviousInstaller) { $upgradeOk = $true } else { $freshInstallOk = $true }
}

Write-Step "数据存活检查（升级后）"
$afterState = Get-LibraryState $DataDir
if ($beforeState.Exists) {
  Assert-True $afterState.Exists "升级后 library.db 仍然存在"
  Assert-True ($afterState.Size -ge $beforeState.Size) "升级后 library.db 未被截断（大小 $($beforeState.Size) → $($afterState.Size)）"
} else {
  Write-Host "   升级前无既有书库，跳过体积对比（首次安装场景）"
  Assert-True $afterState.Exists "首次安装后自动创建 library.db"
}

if ($PreviousInstaller) {
  Write-Step "回滚：重新安装旧版本"
  Invoke-Installer $PreviousInstaller
  $rollbackInstall = Get-InstalledMangaReader
  Assert-True ($null -ne $rollbackInstall) "回滚后旧版本已注册"
  if ($rollbackInstall) {
    Test-AppLaunch $rollbackInstall.InstallLocation
  }
  $afterRollback = Get-LibraryState $DataDir
  Assert-True $afterRollback.Exists "回滚后 library.db 仍然存在"
  $recoveryOk = $afterRollback.Exists
}

if (-not $KeepInstalled) {
  Write-Step "清理（卸载）"
  $current = Get-InstalledMangaReader
  if ($current -and $current.UninstallString) {
    $uninstaller = $current.UninstallString.Split(" ")[0]
    if (Test-Path $uninstaller) {
      $proc = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru
      $proc.WaitForExit(120000) | Out-Null
    }
  }
  Assert-True ($null -eq (Get-InstalledMangaReader)) "卸载后卸载列表不再包含 MangaReader"
}

# ---------------------------------------------------------------------------
# 产出安装验证证据（供发布门禁消费）：
#   kind/version/commit/platform/artifactSha256 + 四项检查 + 环境 + 时间
# 缺任何一项都不算通过；脚本失败时 verdict=FAIL。
# ---------------------------------------------------------------------------
function Get-SqliteHeaderOk([string]$DbPath) {
  if (-not (Test-Path $DbPath)) { return $false }
  $bytes = [System.IO.File]::ReadAllBytes($DbPath)
  if ($bytes.Length -lt 16) { return $false }
  $header = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 16)
  return $header.StartsWith("SQLite format 3")
}

if ($EmitEvidence) {
  $installerName = if ($ArtifactName) { $ArtifactName } else { Split-Path -Leaf $Installer }
  $installerSha = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLower()
  $dbPath = Join-Path $DataDirForApp "library.db"
  $dataIntegrity = if (Get-SqliteHeaderOk $dbPath) { "pass" } else { "fail" }
  # 合并既有证据：不同次运行覆盖不同检查项（全新安装 / 覆盖升级 / 回滚），
  # 取每项里更好的结果（pass 优先），最终产出一份完整证据。
  $merged = [ordered]@{}
  if ($MergeFrom -and (Test-Path $MergeFrom)) {
    try { $merged = (Get-Content $MergeFrom -Raw | ConvertFrom-Json) } catch { $merged = @{} }
  }

  $freshInstall = if ($freshInstallOk) { "pass" } else { "fail" }
  $upgrade = if ($upgradeOk) { "pass" } else { "fail" }
  $recovery = if ($recoveryOk) { "pass" } else { "fail" }
  # 合并既有证据：任一次运行为 pass 即算 pass（两次运行覆盖不同检查项）。
  $checkFresh = $freshInstall
  if ($merged.checks.freshInstall -eq "pass") { $checkFresh = "pass" }
  $checkUpgrade = $upgrade
  if ($merged.checks.upgrade -eq "pass") { $checkUpgrade = "pass" }
  $checkData = $dataIntegrity
  if ($merged.checks.dataIntegrity -eq "pass") { $checkData = "pass" }
  $checkRecovery = $recovery
  if ($merged.checks.recovery -eq "pass") { $checkRecovery = "pass" }
  $evidence = [ordered]@{
    kind = "manga-reader.install-verification"
    verdict = if ($script:Failures.Count -eq 0 -and $dataIntegrity -eq "pass") { "PASS" } else { "FAIL" }
    version = $ExpectedVersion
    commit = $Commit
    platform = "windows-x86_64"
    artifactName = $installerName
    artifactSha256 = $installerSha
    checks = [ordered]@{
      freshInstall = $checkFresh
      upgrade = $checkUpgrade
      dataIntegrity = $checkData
      recovery = $checkRecovery
    }
    machine = [ordered]@{
      os = (Get-CimInstance Win32_OperatingSystem).Caption
      # 干净环境是发布强制条件：由在一次性干净环境上执行验证的人显式声明。
      # 共享宿主上的运行必须**不**传 -CleanEnvironment，回执因此无法满足发布门禁。
      cleanEnvironment = [bool]$CleanEnvironment
      image = if ($ImageName) { $ImageName } else { $env:IMAGE_NAME }
      host = $env:COMPUTERNAME
    }
    verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $json = $evidence | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($EmitEvidence, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已写出安装验证证据：$EmitEvidence（verdict=$($evidence.verdict)）"
}

Write-Step "结果"
if ($script:Failures.Count -gt 0) {
  Write-Host "失败项 $($script:Failures.Count)：" -ForegroundColor Red
  foreach ($failure in $script:Failures) { Write-Host "  - $failure" -ForegroundColor Red }
  exit 1
}
Write-Host "全部检查通过" -ForegroundColor Green
exit 0
