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
    -ExpectedVersion 0.17.2
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
  [switch]$KeepInstalled
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
          InstallLocation = $props.InstallLocation
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
$beforeState = Get-LibraryState $DataDir
Write-Host "   数据目录：$DataDir（库存在：$($beforeState.Exists)）"

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
}

Write-Step "数据存活检查（升级后）"
$afterState = Get-LibraryState $DataDir
if ($beforeState.Exists) {
  Assert-True $afterState.Exists "升级后 library.db 仍然存在"
  Assert-True ($afterState.Size -ge $beforeState.Size) "升级后 library.db 未被截断（大小 $beforeState.Size → $afterState.Size）"
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

Write-Step "结果"
if ($script:Failures.Count -gt 0) {
  Write-Host "失败项 $($script:Failures.Count)：" -ForegroundColor Red
  foreach ($failure in $script:Failures) { Write-Host "  - $failure" -ForegroundColor Red }
  exit 1
}
Write-Host "全部检查通过" -ForegroundColor Green
exit 0
