<#
.SYNOPSIS
  MangaReader Windows 安装 / 覆盖升级 / 回滚验证脚本（需要干净的 Windows VM）。

.DESCRIPTION
  本脚本用于在**一次性干净 Windows 虚拟机**上验证发行链路中最容易出问题、
  且普通单元测试无法覆盖的一段：NSIS 安装、覆盖升级（数据不丢）与回滚。

  干净环境可以是：
  - 本机/自建的一次性 Windows VM（必须提供 -Hypervisor/-VmId/-VmImageSha256）；
  - GitHub-hosted `windows-2022` 一次性 runner（自动采集 ImageOS/ImageVersion/
    RUNNER_NAME/GITHUB_RUN_ID，并把 run URL 写入证据）。

  共享宿主上的运行**不得**加 `-CleanEnvironment`：回执里的
  `machine.cleanEnvironment=false` 会被发布门禁拒绝，这是刻意的失败方向。

  重要约束（与 AGENTS.md 一致）：
  - 只在一次性 VM / hosted runner 上运行；脚本不读取也不上传任何用户数据；
  - 不修改签名私钥、不接触 GitHub Release、不推送 Tag；
  - 只做安装/启动/数据存活检查，不做静默自动更新；
  - 所有数据目录必须显式隔离（MR_DATA_DIR / render_cache / online_cache / WebView2 profile）。
  - 提供 -PdfCheckScript 时额外验证 PDF 导入/渲染/翻页/缩放/封面、跨重启进度、
    .mrbackup 导出/恢复（含旧版备份迁移）与 v2 数据库快照回滚；四项结果写入
    证据的 checks.pdfReading / progressRestart / backupRestore / databaseRollback。

.EXAMPLE
  pwsh -File scripts/release-smoke/windows-install-upgrade.ps1 `
    -PreviousInstaller D:\artifacts\MangaReader_0.17.1_x64-setup.exe `
    -Installer D:\artifacts\MangaReader_0.17.2_x64-setup.exe `
    -ExpectedVersion 0.17.2 `
    -ExpectedSha256 b6d704... `
    -PreviousExpectedVersion 0.17.1 `
    -PreviousExpectedSha256 3e90ec... `
    -Commit f331782... `
    -DataDirForApp $env:TEMP\mr-clean-vm\data `
    -LibrarySeedScript scripts/release-smoke/library-fixture.mjs `
    -LibraryVerifyScript scripts/release-smoke/library-fixture.mjs `
    -LibraryUiCheckScript scripts/release-smoke/library-ui-check.mjs `
    -PdfCheckScript scripts/release-smoke/pdf-release-check.mjs `
    -LibraryFixture $env:TEMP\mr-clean-vm\fixture.json `
    -CleanEnvironment -Hypervisor hyperv -VmId MR-RC-0172 `
    -VmImageSha256 <64-hex> -VmStartedAt 2026-10-26T00:00:00Z `
    -EmitEvidence install-verification.json

.NOTES
  干净环境声明：只有在**一次性干净 Windows 虚拟机 / GitHub-hosted runner** 上执行时
  才加 `-CleanEnvironment`。脚本会记录可核实的 provenance；只有声明没有 provenance
  的回执会被发布门禁拒绝。
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
  [string]$ExpectedSha256,

  [Parameter(Mandatory = $false)]
  [string]$PreviousExpectedVersion,

  [Parameter(Mandatory = $false)]
  [string]$PreviousExpectedSha256,

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
  [string]$ImageName = "",

  [Parameter(Mandatory = $false)]
  [string]$LibrarySeedScript = "",

  [Parameter(Mandatory = $false)]
  [string]$LibraryVerifyScript = "",

  [Parameter(Mandatory = $false)]
  [string]$LibraryUiCheckScript = "",

  [Parameter(Mandatory = $false)]
  [string]$LibraryFixture = "",

  # PDF 阅读 / 跨重启进度 / 备份恢复 / 数据库回滚（发布门禁四项新检查）。
  [Parameter(Mandatory = $false)]
  [string]$PdfCheckScript = "",

  [Parameter(Mandatory = $false)]
  [string]$PdfDataDir = "",

  [Parameter(Mandatory = $false)]
  [string]$PdfWorkDir = "",

  [Parameter(Mandatory = $false)]
  [string]$PdfEvidenceDir = "",

  [Parameter(Mandatory = $false)]
  [string]$PdfRestoreDataDir = "",

  [Parameter(Mandatory = $false)]
  [string]$PdfLegacyDataDir = "",

  [Parameter(Mandatory = $false)]
  [int]$UiCheckPort = 9333,

  [Parameter(Mandatory = $false)]
  [string]$Hypervisor = "",

  [Parameter(Mandatory = $false)]
  [string]$VmId = "",

  [Parameter(Mandatory = $false)]
  [string]$VmImageSha256 = "",

  [Parameter(Mandatory = $false)]
  [string]$VmImagePath = "",

  [Parameter(Mandatory = $false)]
  [string]$VmStartedAt = ""
)

$ErrorActionPreference = "Stop"
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:StartedAt = (Get-Date).ToUniversalTime().ToString("o")
$script:IsGitHubActions = ($env:GITHUB_ACTIONS -eq "true")

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

function Require-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw $Message
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

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLower()
}

function Invoke-Installer([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "找不到安装包：$Path"
  }
  Write-Host "   SHA256: $(Get-Sha256 $Path)"
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

function Get-SqliteHeaderOk([string]$DbPath) {
  if (-not (Test-Path $DbPath)) { return $false }
  $bytes = [System.IO.File]::ReadAllBytes($DbPath)
  if ($bytes.Length -lt 16) { return $false }
  $header = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 16)
  return $header.StartsWith("SQLite format 3")
}

function Test-AppLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$InstallLocation,
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [Parameter(Mandatory = $false)][string]$UiCheckScript = "",
    [Parameter(Mandatory = $false)][string]$FixturePath = "",
    [Parameter(Mandatory = $false)][string]$UiCheckOut = "",
    [Parameter(Mandatory = $false)][int]$Port = 9333,
    # 通用发布校验步骤：每个元素 = @{ Script=…; Args=@(…); Out=<json> }。
    # 与 UiCheckScript 一样在应用启动后执行，结果随 .Steps 返回给调用方判定。
    [Parameter(Mandatory = $false)][object[]]$Steps = @()
  )

  $exe = Join-Path $InstallLocation "MangaReader.exe"
  if (-not (Test-Path $exe)) {
    $exe = Join-Path $InstallLocation "manga-reader-tauri.exe"
  }
  if (-not (Test-Path $exe)) {
    Assert-True $false "安装目录里找不到主程序：$InstallLocation"
    return [pscustomobject]@{ Running = $false; UiCheck = $null; Steps = @(); ClosedGracefully = $false }
  }

  # 隔离数据目录：绝不碰真实用户的书库与 WebView2 profile。
  $env:MR_DATA_DIR = $DataDirectory
  $env:MR_RENDER_CACHE_DIR = Join-Path $DataDirectory "render_cache"
  $env:MR_ONLINE_CACHE_DIR = Join-Path $DataDirectory "online_cache"
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $DataDirectory "webview"
  $hasSteps = ($null -ne $Steps -and @($Steps).Count -gt 0)
  if ($UiCheckScript -or $hasSteps) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
      "--remote-debugging-port=$Port" +
      " --disable-background-timer-throttling" +
      " --disable-renderer-backgrounding" +
      " --disable-backgrounding-occluded-windows"
  } else {
    # 不跑 IPC 校验的启动（旧版本建库 / fresh 启动）不要占 CDP 端口，
    # 避免旧 WebView2 子进程残留时与新版本抢 9333。
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }

  $proc = Start-Process -FilePath $exe -PassThru
  $dbPath = Join-Path $DataDirectory "library.db"
  # 冷启动 runner 上 WebView2 + SQLite 初始化可能较慢；等待 DB 出现（最多 60s）。
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $proc.HasExited -and -not (Test-Path $dbPath)) {
    Start-Sleep -Milliseconds 500
  }
  $running = -not $proc.HasExited
  Assert-True $running "主程序启动后仍在运行（PID $($proc.Id)）"
  if ($running -and (Test-Path $dbPath)) {
    # 给应用 schema/迁移一个短暂的完成窗口，再让 IPC 校验回读。
    Start-Sleep -Seconds 2
  }

  $ui = $null
  if ($running -and $UiCheckScript) {
    if (-not $FixturePath -or -not (Test-Path $FixturePath)) {
      Assert-True $false "IPC 校验缺少 fixture：$FixturePath"
    } else {
      if (-not $UiCheckOut) {
        $UiCheckOut = Join-Path $DataDirectory "ipc-check.json"
      }
      Write-Host "   运行 list_books IPC 校验（port=$Port）"
      & node $UiCheckScript --port $Port --fixture $FixturePath --out $UiCheckOut | Out-Host
      $uiExit = $LASTEXITCODE
      if (Test-Path $UiCheckOut) {
        try { $ui = Get-Content $UiCheckOut -Raw | ConvertFrom-Json } catch { $ui = $null }
      }
      if ($uiExit -ne 0 -or -not $ui -or $ui.ok -ne $true) {
        Assert-True $false "list_books IPC 校验失败（exit $uiExit）"
      } else {
        Write-Host "   IPC OK: $($ui.title) page=$($ui.currentPage) scroll=$($ui.scrollPct)"
      }
    }
  }

  # 通用发布校验步骤：只运行、不在这里断言；由调用方把结果折算成
  # checks.pdfReading / progressRestart / backupRestore / databaseRollback。
  $stepResults = @()
  foreach ($step in @($Steps)) {
    if ($null -eq $step) { continue }
    if (-not $running) { break }
    $stepScript = [string]$step.Script
    if (-not $stepScript) { continue }
    $stepArgs = @()
    if ($null -ne $step.Args) {
      $stepArgs = @($step.Args | ForEach-Object { [string]$_ })
    }
    $stepOut = [string]$step.Out
    Write-Host "   运行发布校验步骤（$(Split-Path -Leaf $stepScript)）"
    & node $stepScript @stepArgs | Out-Host
    $stepExit = $LASTEXITCODE
    $stepResult = $null
    if ($stepOut -and (Test-Path $stepOut)) {
      try { $stepResult = Get-Content $stepOut -Raw | ConvertFrom-Json } catch { $stepResult = $null }
    }
    $stepOk = ($stepExit -eq 0 -and $null -ne $stepResult -and $stepResult.ok -eq $true)
    if (-not $stepOk) {
      Write-Host "   步骤失败（exit $stepExit）" -ForegroundColor Red
    }
    $stepResults += [pscustomobject]@{
      Script = $stepScript
      Exit   = $stepExit
      Ok     = [bool]$stepOk
      Result = $stepResult
    }
  }

  # 一次性 VM：优雅关闭优先；超时才强制结束（测试清理，不是产品的静默重启）。
  $closedGracefully = $false
  if (-not $proc.HasExited) {
    $closedGracefully = $proc.CloseMainWindow()
    if ($closedGracefully) {
      $closedGracefully = $proc.WaitForExit(10000)
    }
    if (-not $proc.HasExited) {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  return [pscustomobject]@{
    Running         = $running
    UiCheck         = $ui
    Steps           = $stepResults
    ClosedGracefully = $closedGracefully
  }
}

# 每个 PDF 步骤使用独立 CDP 端口：应用关闭后 WebView2 子进程可能短暂残留，
# 复用同一端口会让新实例连接到上一个实例的旧 target，断言就失去意义。
$script:PdfPortOffset = 0
function Get-PdfPort([int]$Base) {
  $script:PdfPortOffset += 1
  return $Base + 10 + $script:PdfPortOffset
}

function New-AppStep {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
    [Parameter(Mandatory = $false)][string]$OutPath = ""
  )
  return @{ Script = $Script; Args = $Arguments; Out = $OutPath }
}

function Get-StepOutcome([object]$Launch, [int]$Index = 0) {
  if ($null -eq $Launch) { return $null }
  $items = @($Launch.Steps)
  if ($items.Count -le $Index) { return $null }
  return $items[$Index]
}

# 应用关闭时的节点校验（SQLite 只读 / 快照 / 回滚 / 旧备份生成）。
function Invoke-NodeCheck {
  param(
    [Parameter(Mandatory = $true)][string]$Script,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $false)][string[]]$Arguments = @(),
    [Parameter(Mandatory = $false)][string]$OutPath = ""
  )
  Write-Host "   $Label"
  & node $Script @Arguments | Out-Host
  $exit = $LASTEXITCODE
  $result = $null
  if ($OutPath -and (Test-Path $OutPath)) {
    try { $result = Get-Content $OutPath -Raw | ConvertFrom-Json } catch { $result = $null }
  }
  $ok = ($exit -eq 0 -and $null -ne $result -and $result.ok -eq $true)
  if (-not $ok) {
    Write-Host "   FAIL $Label（exit $exit）" -ForegroundColor Red
  }
  return [pscustomobject]@{ Ok = [bool]$ok; Exit = $exit; Result = $result }
}

function Invoke-LibrarySeed {
  param(
    [string]$Script,
    [string]$DataDirectory,
    [string]$FixturePath,
    [string]$OutPath
  )
  Write-Host "   写入合成书库与阅读进度"
  & node $Script seed --data-dir $DataDirectory --fixture $FixturePath --out $OutPath | Out-Host
  $exit = $LASTEXITCODE
  if ($exit -ne 0) {
    Assert-True $false "合成书库写入失败（exit $exit）"
    return $null
  }
  if (-not (Test-Path $OutPath)) {
    Assert-True $false "合成书库写入后缺少结果文件：$OutPath"
    return $null
  }
  return Get-Content $OutPath -Raw | ConvertFrom-Json
}

function Invoke-LibraryVerify {
  param(
    [string]$Script,
    [string]$DataDirectory,
    [string]$FixturePath,
    [string]$OutPath,
    [int]$SchemaVersionBefore = 0
  )
  Write-Host "   校验书库完整性与阅读进度"
  & node $Script verify --data-dir $DataDirectory --fixture $FixturePath --out $OutPath `
    --schema-version-before $SchemaVersionBefore | Out-Host
  $exit = $LASTEXITCODE
  $result = $null
  if (Test-Path $OutPath) {
    try { $result = Get-Content $OutPath -Raw | ConvertFrom-Json } catch { $result = $null }
  }
  if ($exit -ne 0 -or -not $result -or $result.ok -ne $true) {
    Assert-True $false "书库完整性校验失败（exit $exit）"
    return $null
  }
  Write-Host "   书库 OK: books=$($result.bookCount) log=$($result.readingLogPages) schema=$($result.schemaVersionAfter)"
  return $result
}

function Get-Provenance {
  if ($script:IsGitHubActions) {
    foreach ($name in @(
      "ImageOS", "ImageVersion", "RUNNER_NAME", "GITHUB_RUN_ID",
      "GITHUB_REPOSITORY", "GITHUB_SERVER_URL", "GITHUB_WORKFLOW_REF", "GITHUB_ACTOR"
    )) {
      Require-True ([bool](Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value) `
        "GitHub Actions 上缺少 provenance 环境变量：$name"
    }
    $runUrl = "$($env:GITHUB_SERVER_URL)/$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)"
    return [ordered]@{
      kind        = "github-actions"
      repository  = $env:GITHUB_REPOSITORY
      runId       = $env:GITHUB_RUN_ID
      runUrl      = $runUrl
      runnerName  = $env:RUNNER_NAME
      imageOs     = $env:ImageOS
      imageVersion = $env:ImageVersion
      workflow    = $env:GITHUB_WORKFLOW_REF
      actor       = $env:GITHUB_ACTOR
      runAttempt  = if ($env:GITHUB_RUN_ATTEMPT) { $env:GITHUB_RUN_ATTEMPT } else { "1" }
      startedAt   = $script:StartedAt
    }
  }

  Require-True ([bool]$Hypervisor) "本地 VM 必须提供 -Hypervisor（例如 hyperv / vmware / virtualbox）"
  Require-True ([bool]$VmId) "本地 VM 必须提供 -VmId"
  Require-True ([bool]($VmImageSha256 -match '^[0-9a-fA-F]{64}$')) `
    "本地 VM 必须提供 64 位十六进制的 -VmImageSha256"
  $parsed = [DateTime]::MinValue
  Require-True ([DateTime]::TryParse($VmStartedAt, [ref]$parsed)) `
    "本地 VM 必须提供合法的 -VmStartedAt（ISO8601）"
  return [ordered]@{
    kind        = "local-vm"
    hypervisor  = $Hypervisor
    vmId        = $VmId
    imageSha256 = $VmImageSha256.ToLower()
    imagePath   = $VmImagePath
    startedAt   = $VmStartedAt
  }
}

# ---------------------------------------------------------------------------
# 预检：精确候选绑定 + 隔离目录 + 可核实 provenance
# ---------------------------------------------------------------------------
Write-Step "预检"
Require-True (Test-Path $Installer) "安装包存在：$Installer"

$dataDirProvided = $PSBoundParameters.ContainsKey("DataDir")
$appDirProvided = $PSBoundParameters.ContainsKey("DataDirForApp")
if ($appDirProvided -and -not $dataDirProvided) { $DataDir = $DataDirForApp }
if ($dataDirProvided -and -not $appDirProvided) { $DataDirForApp = $DataDir }
if (-not $DataDirForApp) { $DataDirForApp = $DataDir }
$DataDir = [IO.Path]::GetFullPath($DataDir)
$DataDirForApp = [IO.Path]::GetFullPath($DataDirForApp)
Require-True ($DataDir -ieq $DataDirForApp) `
  "DataDir 与 DataDirForApp 必须指向同一隔离目录（当前 $DataDir vs $DataDirForApp）"
if ($EmitEvidence -and -not $appDirProvided) {
  throw "产出证据时必须显式提供隔离数据目录 -DataDirForApp（不得使用默认用户书库）"
}
$defaultAppData = [IO.Path]::GetFullPath((Join-Path $env:APPDATA "com.local.manga-reader")).TrimEnd('\')
if ($EmitEvidence -and ($DataDirForApp.TrimEnd('\') -ieq $defaultAppData)) {
  throw "产出证据时不得使用默认用户数据目录 $defaultAppData；请提供隔离 -DataDirForApp"
}
New-Item -ItemType Directory -Force -Path $DataDirForApp | Out-Null
foreach ($sub in @("render_cache", "online_cache", "webview")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDirForApp $sub) | Out-Null
}

$installerSha = Get-Sha256 $Installer
$installerName = if ($ArtifactName) { $ArtifactName } else { Split-Path -Leaf $Installer }
$resolvedImage = if ($ImageName) { $ImageName } else { $env:IMAGE_NAME }
if ($script:IsGitHubActions -and -not $resolvedImage) {
  $resolvedImage = "GitHub Actions $env:ImageOS $env:ImageVersion"
}
if ($CleanEnvironment) {
  # 声明了干净环境就必须能说明这是哪套镜像/哪次运行：无法溯源的声明一律无效。
  Require-True ([bool]$resolvedImage) "声明干净环境时必须提供镜像标识（-ImageName 或 IMAGE_NAME）"
}
Write-Host "   干净环境声明：$([bool]$CleanEnvironment)（镜像：$resolvedImage）"

if ($EmitEvidence) {
  Require-True ([bool]$ExpectedVersion -and $ExpectedVersion -match '^\d+\.\d+\.\d+$') `
    "产出证据时必须提供合法的 -ExpectedVersion（X.Y.Z）"
  Require-True ([bool]($ExpectedSha256 -match '^[0-9a-fA-F]{64}$')) `
    "产出证据时必须提供 64 位十六进制的 -ExpectedSha256"
  Require-True ([bool]($Commit -match '^[0-9a-fA-F]{40}$')) `
    "产出证据时必须提供 40 位十六进制的 -Commit"
}
if ($ExpectedSha256) {
  Require-True ($installerSha -eq $ExpectedSha256.ToLower()) `
    "安装包 SHA-256 与候选记录不一致（期望 $($ExpectedSha256.ToLower())，实际 $installerSha）"
}
if ($PreviousInstaller) {
  Require-True (Test-Path $PreviousInstaller) "旧版本安装包存在：$PreviousInstaller"
  if ($EmitEvidence) {
    Require-True ([bool]$PreviousExpectedVersion) "产出证据时必须提供 -PreviousExpectedVersion"
    Require-True ([bool]($PreviousExpectedSha256 -match '^[0-9a-fA-F]{64}$')) `
      "产出证据时必须提供 64 位十六进制的 -PreviousExpectedSha256"
  }
}
$previousSha = if ($PreviousInstaller) { Get-Sha256 $PreviousInstaller } else { "" }
if ($PreviousInstaller -and $PreviousExpectedSha256) {
  Require-True ($previousSha -eq $PreviousExpectedSha256.ToLower()) `
    "旧版本安装包 SHA-256 与候选基线不一致（期望 $($PreviousExpectedSha256.ToLower())，实际 $previousSha）"
}

$provenance = $null
if ($CleanEnvironment) {
  $provenance = Get-Provenance
}

$libraryScriptsRequested = [bool]($LibrarySeedScript -or $LibraryVerifyScript -or $LibraryUiCheckScript)
if ($libraryScriptsRequested) {
  Require-True ([bool](Get-Command node -ErrorAction SilentlyContinue)) `
    "书库/IPC 校验需要 Node.js 22+（找不到 node）"
  foreach ($scriptPath in @($LibrarySeedScript, $LibraryVerifyScript, $LibraryUiCheckScript)) {
    if ($scriptPath) {
      Require-True (Test-Path $scriptPath) "找不到校验脚本：$scriptPath"
    }
  }
  if ($EmitEvidence -and $PreviousInstaller) {
    Require-True ([bool]$LibrarySeedScript -and [bool]$LibraryVerifyScript -and [bool]$LibraryUiCheckScript) `
      "产出升级证据时必须同时提供 -LibrarySeedScript / -LibraryVerifyScript / -LibraryUiCheckScript"
  }
  if (-not $LibraryFixture) {
    $LibraryFixture = Join-Path $DataDirForApp "release-smoke-fixture.json"
  }
}

# ---------------------------------------------------------------------------
# PDF / 备份 / 数据库回滚：四项新发布门禁的前置条件与隔离目录
# ---------------------------------------------------------------------------
$pdfChecksRequested = [bool]$PdfCheckScript
if ($pdfChecksRequested) {
  Require-True ([bool](Get-Command node -ErrorAction SilentlyContinue)) `
    "PDF/备份/数据库回滚校验需要 Node.js 22+（找不到 node）"
  Require-True (Test-Path $PdfCheckScript) "找不到 PDF 发布校验脚本：$PdfCheckScript"
  # 数据库回滚检查必须先有旧版本可用于“回滚后再装回”，否则无法形成闭环。
  Require-True ([bool]$PreviousInstaller) `
    "PDF 发布校验包含数据库回滚，必须同时提供 -PreviousInstaller"
  if (-not $LibraryVerifyScript) {
    Assert-True $false "PDF 发布校验依赖书库完整性校验（-LibraryVerifyScript 为空）"
  }

  # 默认全部放在应用数据目录的**同级**：夹具书源必须位于 MR_DATA_DIR 之外，
  # 否则产品的本地书源安全策略会拒绝读取 PDF（pdf-source-not-allowed）。
  $siblingRoot = Split-Path -Parent $DataDirForApp
  if (-not $PdfDataDir) { $PdfDataDir = Join-Path $siblingRoot "pdf-data" }
  if (-not $PdfWorkDir) { $PdfWorkDir = Join-Path $siblingRoot "pdf-work" }
  if (-not $PdfEvidenceDir) { $PdfEvidenceDir = Join-Path $siblingRoot "pdf-evidence" }
  if (-not $PdfRestoreDataDir) { $PdfRestoreDataDir = Join-Path $siblingRoot "pdf-restore-data" }
  if (-not $PdfLegacyDataDir) { $PdfLegacyDataDir = Join-Path $siblingRoot "pdf-legacy-data" }
  $PdfDataDir = [IO.Path]::GetFullPath($PdfDataDir)
  $PdfWorkDir = [IO.Path]::GetFullPath($PdfWorkDir)
  $PdfEvidenceDir = [IO.Path]::GetFullPath($PdfEvidenceDir)
  $PdfRestoreDataDir = [IO.Path]::GetFullPath($PdfRestoreDataDir)
  $PdfLegacyDataDir = [IO.Path]::GetFullPath($PdfLegacyDataDir)

  $dataRootPrefix = $DataDirForApp.TrimEnd('\') + '\'
  Require-True (-not $PdfWorkDir.StartsWith($dataRootPrefix, [StringComparison]::OrdinalIgnoreCase)) `
    "PDF 夹具工作目录不得位于应用数据目录内（-PdfWorkDir）"
  Require-True (-not $PdfDataDir.StartsWith($dataRootPrefix, [StringComparison]::OrdinalIgnoreCase)) `
    "PDF 验证数据目录不得位于主数据目录内（-PdfDataDir）"
  Require-True ($PdfRestoreDataDir -ine $PdfDataDir -and $PdfLegacyDataDir -ine $PdfDataDir) `
    "备份恢复/旧版恢复必须使用各自独立的隔离数据目录"

  foreach ($dir in @($PdfDataDir, $PdfWorkDir, $PdfEvidenceDir, $PdfRestoreDataDir, $PdfLegacyDataDir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  foreach ($dir in @($PdfDataDir, $PdfRestoreDataDir, $PdfLegacyDataDir)) {
    foreach ($sub in @("render_cache", "online_cache", "webview")) {
      New-Item -ItemType Directory -Force -Path (Join-Path $dir $sub) | Out-Null
    }
  }
}

$beforeState = Get-LibraryState $DataDir
Write-Host "   数据目录：$DataDir（库存在：$($beforeState.Exists)）"

$freshInstallOk = $false
$upgradeOk = $false
$recoveryOk = $false
$dataIntegrity = "fail"
$libraryResult = $null
$seedResult = $null
# 四项新门禁：只有断言真实执行且通过时才允许 pass（默认 fail）。
$pdfReadingOk = $false
$progressRestartOk = $false
$backupRestoreOk = $false
$databaseRollbackOk = $false
$pdfBookId = ""
$pdfSnapshotPath = ""
$pdfSnapshotOk = $false

if ($PreviousInstaller) {
  Write-Step "安装旧版本（建立升级起点）"
  Invoke-Installer $PreviousInstaller
  $oldInstall = Get-InstalledMangaReader
  Assert-True ($null -ne $oldInstall) "旧版本已注册到卸载列表"
  if ($oldInstall) {
    Write-Host "   旧版本：$($oldInstall.DisplayVersion) @ $($oldInstall.InstallLocation)"
    if ($PreviousExpectedVersion) {
      Assert-True ($oldInstall.DisplayVersion -eq $PreviousExpectedVersion) `
        "旧版本安装版本 = $PreviousExpectedVersion（实际 $($oldInstall.DisplayVersion)）"
    }
  }
  $oldLaunch = Test-AppLaunch -InstallLocation $oldInstall.InstallLocation -DataDirectory $DataDirForApp
  Assert-True ($oldLaunch.Running) "旧版本启动成功（用于创建用户书库）"

  if ($LibrarySeedScript) {
    $seedOut = Join-Path $DataDirForApp "seed-result.json"
    $seedResult = Invoke-LibrarySeed -Script $LibrarySeedScript -DataDirectory $DataDirForApp `
      -FixturePath $LibraryFixture -OutPath $seedOut
    if (-not $seedResult) {
      Assert-True $false "无法建立升级前的用户书库基线"
    }
  }
}

Write-Step "安装新版本（覆盖升级）"
Invoke-Installer $Installer
$newInstall = Get-InstalledMangaReader
Assert-True ($null -ne $newInstall) "新版本已注册到卸载列表"
$versionOk = $true
if ($newInstall) {
  Write-Host "   新版本：$($newInstall.DisplayVersion) @ $($newInstall.InstallLocation)"
  if ($ExpectedVersion) {
    $versionOk = ($newInstall.DisplayVersion -eq $ExpectedVersion)
    Assert-True $versionOk "安装版本 = $ExpectedVersion（实际 $($newInstall.DisplayVersion)）"
  }
  $newLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation -DataDirectory $DataDirForApp `
    -UiCheckScript $LibraryUiCheckScript -FixturePath $LibraryFixture `
    -UiCheckOut (Join-Path $DataDirForApp "ipc-upgrade.json") -Port $UiCheckPort

  if ($LibraryVerifyScript -and $seedResult) {
    $upgradeVerifyOut = Join-Path $DataDirForApp "verify-upgrade.json"
    $libraryResult = Invoke-LibraryVerify -Script $LibraryVerifyScript -DataDirectory $DataDirForApp `
      -FixturePath $LibraryFixture -OutPath $upgradeVerifyOut `
      -SchemaVersionBefore ([int]$seedResult.schemaVersion)
    if ($libraryResult) {
      $libraryResult | Add-Member -NotePropertyName ipc -NotePropertyValue $newLaunch.UiCheck -Force
    }
  }

  $dbHeaderOk = Get-SqliteHeaderOk (Join-Path $DataDirForApp "library.db")
  $dataOk = if ($LibraryVerifyScript) {
    [bool]($libraryResult -and $libraryResult.ok -eq $true -and
      $newLaunch.UiCheck -and $newLaunch.UiCheck.ok -eq $true -and $dbHeaderOk)
  } else {
    [bool]$dbHeaderOk
  }
  $dataIntegrity = if ($dataOk) { "pass" } else { "fail" }
  $upgradeOk = [bool]($newLaunch.Running -and $versionOk -and $dataOk)
  if (-not $PreviousInstaller) {
    $freshInstallOk = [bool]($newLaunch.Running -and $versionOk -and (Get-SqliteHeaderOk (Join-Path $DataDirForApp "library.db")))
  }
}

Write-Step "数据存活检查（升级后）"
if ($libraryResult) {
  Assert-True ($libraryResult.ok -eq $true) "升级后合成书库与阅读进度完整"
  # 直接使用本次启动的 IPC 结果；不要对 ConvertFrom-Json 的属性做二次布尔断言，
  # 否则 UI check 失败时属性可能是数组/嵌套对象，触发参数转换异常而丢失证据。
  $ipcOk = [bool]($newLaunch -and $newLaunch.UiCheck -and $newLaunch.UiCheck.ok -eq $true)
  Assert-True $ipcOk "升级后 list_books IPC 回读一致"
} else {
  $afterState = Get-LibraryState $DataDir
  if ($beforeState.Exists) {
    Assert-True $afterState.Exists "升级后 library.db 仍然存在"
    Assert-True ($afterState.Size -ge $beforeState.Size) "升级后 library.db 未被截断（大小 $($beforeState.Size) → $($afterState.Size)）"
  } else {
    Write-Host "   升级前无既有书库，跳过体积对比（首次安装场景）"
    Assert-True $afterState.Exists "首次安装后自动创建 library.db"
  }
}

if ($pdfChecksRequested -and $newInstall) {
  # PDF 使用**独立的隔离数据目录**：既有的合成书库夹具断言 bookCount=1，
  # 把 PDF 书塞进主数据目录会让回滚/升级的既有断言变红（那是削弱既有断言，
  # 不是增强）。独立目录同样跑真实安装的 0.18.0 二进制与真实 IPC。
  Write-Step "PDF 阅读（导入 / 渲染 / 翻页 / 缩放 / 封面）"
  $pdfUiOut = Join-Path $PdfEvidenceDir "pdf-ui.json"
  $pdfUiPort = Get-PdfPort $UiCheckPort
  $pdfUiLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation `
    -DataDirectory $PdfDataDir -Port $pdfUiPort `
    -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $pdfUiOut -Arguments @(
      "ui", "--port", "$pdfUiPort", "--data-dir", $PdfWorkDir,
      "--render-cache", (Join-Path $PdfDataDir "render_cache"), "--out", $pdfUiOut))
  $pdfUi = Get-StepOutcome $pdfUiLaunch
  $pdfUiOk = [bool]($pdfUi -and $pdfUi.Ok)
  if ($pdfUi -and $pdfUi.Result -and $pdfUi.Result.bookId) {
    $pdfBookId = [string]$pdfUi.Result.bookId
  }
  Assert-True $pdfUiOk "PDF 以 format=pdf 入库并完成渲染/翻页/缩放/封面断言"

  if (-not $pdfBookId) {
    Assert-True $false "PDF 未入库，跳过数据库/重启/备份/回滚断言"
  } else {
    Write-Step "PDF 数据库与封面缓存（应用关闭后只读校验）"
    $pdfDbOut = Join-Path $PdfEvidenceDir "pdf-db.json"
    $pdfDbStep = Invoke-NodeCheck -Script $PdfCheckScript `
      -Label "library.db：format=pdf / page_count=4 / current_page=2 / user_version=2 / 封面 JPEG" `
      -OutPath $pdfDbOut -Arguments @("db", "--data-dir", $PdfDataDir, "--book-id", $pdfBookId,
        "--expect-page", "3", "--expect-count", "4", "--out", $pdfDbOut)
    Assert-True $pdfDbStep.Ok "PDF 数据库与封面缓存检查通过"
    $pdfReadingOk = [bool]($pdfUiOk -and $pdfDbStep.Ok)

    Write-Step "PDF 进度：真实进程重启后恢复"
    $pdfRestartOut = Join-Path $PdfEvidenceDir "pdf-restart.json"
    $pdfRestartPort = Get-PdfPort $UiCheckPort
    $pdfRestartLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation `
      -DataDirectory $PdfDataDir -Port $pdfRestartPort `
      -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $pdfRestartOut -Arguments @(
        "restart", "--port", "$pdfRestartPort", "--book-id", $pdfBookId,
        "--expect-page", "3", "--out", $pdfRestartOut))
    $pdfRestart = Get-StepOutcome $pdfRestartLaunch
    $progressRestartOk = [bool]($pdfRestart -and $pdfRestart.Ok)
    Assert-True $progressRestartOk "PDF 重启后恢复到第 3 页且画布已解码"

    Write-Step "备份导出 / 恢复 / 旧版备份迁移"
    $pdfBackupPath = Join-Path $PdfEvidenceDir "release.mrbackup"
    $pdfBackupOut = Join-Path $PdfEvidenceDir "pdf-backup-export.json"
    $pdfBackupPort = Get-PdfPort $UiCheckPort
    $pdfBackupLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation `
      -DataDirectory $PdfDataDir -Port $pdfBackupPort `
      -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $pdfBackupOut -Arguments @(
        "backup-export", "--port", "$pdfBackupPort", "--dest", $pdfBackupPath,
        "--book-id", $pdfBookId, "--expect-page", "3", "--out", $pdfBackupOut))
    $pdfBackup = Get-StepOutcome $pdfBackupLaunch
    $pdfBackupOk = [bool]($pdfBackup -and $pdfBackup.Ok)
    Assert-True $pdfBackupOk ".mrbackup 含 manifest+library.db、保留 PDF 与进度且无凭据残留"

    $pdfRestoreOut = Join-Path $PdfEvidenceDir "pdf-backup-restore.json"
    $pdfRestorePort = Get-PdfPort $UiCheckPort
    $pdfRestoreLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation `
      -DataDirectory $PdfRestoreDataDir -Port $pdfRestorePort `
      -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $pdfRestoreOut -Arguments @(
        "backup-restore", "--port", "$pdfRestorePort", "--data-dir", $PdfRestoreDataDir,
        "--source", $pdfBackupPath, "--expect-book-id", $pdfBookId,
        "--expect-current-page", "2", "--out", $pdfRestoreOut))
    $pdfRestore = Get-StepOutcome $pdfRestoreLaunch
    $pdfRestoreOk = [bool]($pdfRestore -and $pdfRestore.Ok)
    Assert-True $pdfRestoreOk "在独立 profile 恢复 .mrbackup 后 PDF 与进度仍在（quick_check 通过）"

    # 旧版（PDF-1 之前）备份：真实 zip、books 无 format 列、user_version=1。
    $legacyBackupPath = Join-Path $PdfEvidenceDir "legacy.mrbackup"
    $legacyBackupEvidence = Join-Path $PdfEvidenceDir "pdf-legacy-backup.json"
    $legacyStep = Invoke-NodeCheck -Script $PdfCheckScript `
      -Label "生成旧版 .mrbackup（无 format 列 / user_version=1）" `
      -OutPath $legacyBackupEvidence -Arguments @("legacy-backup", "--out", $legacyBackupPath,
        "--work-dir", (Join-Path $PdfWorkDir "legacy"), "--evidence", $legacyBackupEvidence)
    $legacyBookId = ""
    if ($legacyStep.Result -and $legacyStep.Result.bookId) {
      $legacyBookId = [string]$legacyStep.Result.bookId
    }
    $legacyRestoreOut = Join-Path $PdfEvidenceDir "pdf-verify-legacy.json"
    $legacyRestoreOk = $false
    if ($legacyStep.Ok -and $legacyBookId) {
      $legacyPort = Get-PdfPort $UiCheckPort
      $legacyLaunch = Test-AppLaunch -InstallLocation $newInstall.InstallLocation `
        -DataDirectory $PdfLegacyDataDir -Port $legacyPort `
        -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $legacyRestoreOut -Arguments @(
          "verify-legacy", "--port", "$legacyPort", "--data-dir", $PdfLegacyDataDir,
          "--source", $legacyBackupPath, "--book-id", $legacyBookId, "--out", $legacyRestoreOut))
      $legacyRestore = Get-StepOutcome $legacyLaunch
      $legacyRestoreOk = [bool]($legacyRestore -and $legacyRestore.Ok)
    }
    Assert-True ($legacyStep.Ok -and $legacyRestoreOk) `
      "旧版备份可恢复：图片书与进度保留、quick_check 通过、user_version 升到 2"

    $backupRestoreOk = [bool]($pdfBackupOk -and $pdfRestoreOk -and $legacyStep.Ok -and $legacyRestoreOk)

    Write-Step "回滚前快照 v2 数据库"
    $pdfSnapshotPath = Join-Path $PdfEvidenceDir "v2-snapshot.db"
    $pdfSnapshotEvidence = Join-Path $PdfEvidenceDir "pdf-db-snapshot.json"
    $pdfSnapshotStep = Invoke-NodeCheck -Script $PdfCheckScript `
      -Label "VACUUM INTO 快照（应用已关闭）" -OutPath $pdfSnapshotEvidence `
      -Arguments @("db-snapshot", "--data-dir", $PdfDataDir, "--out", $pdfSnapshotPath,
        "--evidence", $pdfSnapshotEvidence)
    $pdfSnapshotOk = [bool]$pdfSnapshotStep.Ok
    Assert-True $pdfSnapshotOk "v2 数据库快照通过自检"
  }
}

if ($PreviousInstaller) {
  Write-Step "回滚：重新安装旧版本"
  Invoke-Installer $PreviousInstaller
  $rollbackInstall = Get-InstalledMangaReader
  Assert-True ($null -ne $rollbackInstall) "回滚后旧版本已注册"
  if ($rollbackInstall) {
    $rollbackLaunch = Test-AppLaunch -InstallLocation $rollbackInstall.InstallLocation -DataDirectory $DataDirForApp `
      -UiCheckScript $LibraryUiCheckScript -FixturePath $LibraryFixture `
      -UiCheckOut (Join-Path $DataDirForApp "ipc-rollback.json") -Port $UiCheckPort
    $rollbackVerify = $null
    if ($LibraryVerifyScript -and $seedResult) {
      $rollbackVerifyOut = Join-Path $DataDirForApp "verify-rollback.json"
      $rollbackVerify = Invoke-LibraryVerify -Script $LibraryVerifyScript -DataDirectory $DataDirForApp `
        -FixturePath $LibraryFixture -OutPath $rollbackVerifyOut `
        -SchemaVersionBefore ([int]$seedResult.schemaVersion)
      if ($rollbackVerify) {
        $rollbackVerify | Add-Member -NotePropertyName ipc -NotePropertyValue $rollbackLaunch.UiCheck -Force
      }
    }
    $recoveryOk = [bool]($rollbackLaunch.Running -and $rollbackVerify -and $rollbackVerify.ok -eq $true -and
      $rollbackLaunch.UiCheck -and $rollbackLaunch.UiCheck.ok -eq $true)
    Assert-True $recoveryOk "回滚后旧版本可启动且用户数据完整"
    $afterRollback = Get-LibraryState $DataDir
    Assert-True $afterRollback.Exists "回滚后 library.db 仍然存在"
  }
}

if ($PreviousInstaller -and $pdfChecksRequested -and [bool]$pdfBookId) {
  Write-Step "数据库回滚：旧版本打开 v2 库 → 快照回滚 → 装回候选版本"
  $rollbackCompatOut = Join-Path $PdfEvidenceDir "pdf-rollback-compat.json"
  $rollbackCompatOk = $false
  $rollbackInstallState = Get-InstalledMangaReader
  if ($rollbackInstallState) {
    $rollbackCompatPort = Get-PdfPort $UiCheckPort
    $rollbackCompatLaunch = Test-AppLaunch -InstallLocation $rollbackInstallState.InstallLocation `
      -DataDirectory $PdfDataDir -Port $rollbackCompatPort `
      -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $rollbackCompatOut -Arguments @(
        "rollback-compat", "--port", "$rollbackCompatPort", "--data-dir", $PdfDataDir,
        "--out", $rollbackCompatOut))
    $rollbackCompat = Get-StepOutcome $rollbackCompatLaunch
    $rollbackCompatOk = [bool]($rollbackCompat -and $rollbackCompat.Ok)
  }
  Assert-True $rollbackCompatOk `
    "回滚到旧版本后 list_books 不崩溃且 v2 库未被降级（schema=2 / quick_check ok）"

  $dbRestoreOk = $false
  if ($pdfSnapshotOk -and $pdfSnapshotPath -and (Test-Path $pdfSnapshotPath)) {
    $dbRestoreEvidence = Join-Path $PdfEvidenceDir "pdf-db-restore.json"
    $dbRestoreStep = Invoke-NodeCheck -Script $PdfCheckScript `
      -Label "从 v2 快照回滚数据库（处理 -wal/-shm 并逐字节校验）" `
      -OutPath $dbRestoreEvidence -Arguments @("db-restore", "--data-dir", $PdfDataDir,
        "--snapshot", $pdfSnapshotPath, "--book-id", $pdfBookId,
        "--expect-current-page", "2", "--evidence", $dbRestoreEvidence)
    $dbRestoreOk = [bool]$dbRestoreStep.Ok
  }
  Assert-True $dbRestoreOk "数据库快照回滚逐字节一致且保留 PDF 与第 3 页进度"

  # 装回候选版本：证明回滚后的数据库仍能被新版本按原进度打开。
  Invoke-Installer $Installer
  $restoredInstall = Get-InstalledMangaReader
  Assert-True ($null -ne $restoredInstall) "数据库回滚后重新安装候选版本成功"
  $postRestoreOk = $false
  $postRestoreDbOk = $false
  if ($restoredInstall) {
    $postRestoreOut = Join-Path $PdfEvidenceDir "pdf-restore-after-restart.json"
    $postRestorePort = Get-PdfPort $UiCheckPort
    $postRestoreLaunch = Test-AppLaunch -InstallLocation $restoredInstall.InstallLocation `
      -DataDirectory $PdfDataDir -Port $postRestorePort `
      -Steps @(New-AppStep -Script $PdfCheckScript -OutPath $postRestoreOut -Arguments @(
        "restart", "--port", "$postRestorePort", "--book-id", $pdfBookId,
        "--expect-page", "3", "--out", $postRestoreOut))
    $postRestore = Get-StepOutcome $postRestoreLaunch
    $postRestoreOk = [bool]($postRestore -and $postRestore.Ok)

    $postRestoreDbOut = Join-Path $PdfEvidenceDir "pdf-db-after-restore.json"
    $postRestoreDbStep = Invoke-NodeCheck -Script $PdfCheckScript `
      -Label "回滚恢复后的数据库复核（format/page_count/progress/封面）" `
      -OutPath $postRestoreDbOut -Arguments @("db", "--data-dir", $PdfDataDir,
        "--book-id", $pdfBookId, "--expect-page", "3", "--expect-count", "4",
        "--out", $postRestoreDbOut)
    $postRestoreDbOk = [bool]$postRestoreDbStep.Ok
  }
  Assert-True $postRestoreOk "恢复后的数据库被候选版本正确打开并停在第 3 页"
  Assert-True $postRestoreDbOk "恢复后的数据库仍为 v2，页码/页数/封面完整"
  $databaseRollbackOk = [bool]($pdfSnapshotOk -and $rollbackCompatOk -and $dbRestoreOk -and
    $postRestoreOk -and $postRestoreDbOk)
}

if (-not $KeepInstalled) {
  Write-Step "清理（卸载）"
  $current = Get-InstalledMangaReader
  if ($current -and $current.UninstallString) {
    # NSIS 写入的卸载命令是**带引号且可能含空格**的路径
    # （例如 "C:\Program Files\MangaReader\uninstall.exe"）。
    # 直接按空格切分只会得到 "C:\Program"，卸载器永远不会执行，
    # 表现为「卸载后卸载列表仍包含 MangaReader」的假失败。
    $uninstaller = $current.UninstallString.Trim()
    if ($uninstaller.StartsWith('"')) {
      $closing = $uninstaller.IndexOf('"', 1)
      if ($closing -gt 0) { $uninstaller = $uninstaller.Substring(1, $closing - 1) }
    } else {
      $uninstaller = ($uninstaller -split '\s+')[0]
    }
    Assert-True (Test-Path $uninstaller) "卸载器可执行文件存在：$uninstaller"
    if (Test-Path $uninstaller) {
      $proc = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru
      $proc.WaitForExit(120000) | Out-Null
      if (-not $proc.HasExited) {
        $proc.Kill()
        Assert-True $false "卸载程序超时未退出"
      } else {
        Assert-True ($proc.ExitCode -eq 0) "卸载程序退出码为 0（实际 $($proc.ExitCode)）"
        # NSIS 卸载器会派生辅助进程后立刻返回，注册表项与安装目录的清理稍后才落地：
        # 有界轮询等待清理完成（最多 30s），既不误判也不无限等待。
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
          if ($null -eq (Get-InstalledMangaReader)) { break }
          Start-Sleep -Milliseconds 500
        }
      }
    }
  }
  Assert-True ($null -eq (Get-InstalledMangaReader)) "卸载后卸载列表不再包含 MangaReader"
}

# ---------------------------------------------------------------------------
# 产出安装验证证据（供发布门禁消费）：
#   kind/version/commit/platform/artifactSha256 + 八项检查 + 环境/provenance +
#   library（数据库自检 + 合成书库 + 阅读进度 + 真实 list_books IPC）
# 缺任何一项都不算通过；脚本失败时 verdict=FAIL。
# PDF / 进度重启 / 备份恢复 / 数据库回滚只以**本次运行**为准，不从 MergeFrom 借
# （fresh-only 证据没有这些断言，必须如实记为 fail）。
# ---------------------------------------------------------------------------
if ($EmitEvidence) {
  $merged = $null
  if ($MergeFrom) {
    if (-not (Test-Path $MergeFrom)) {
      throw "MergeFrom 证据不存在：$MergeFrom"
    }
    try { $merged = Get-Content $MergeFrom -Raw | ConvertFrom-Json } catch {
      throw "MergeFrom 证据不是合法 JSON：$MergeFrom"
    }
    $expectedFields = [ordered]@{
      version               = $ExpectedVersion
      commit                = $Commit
      platform              = "windows-x86_64"
      artifactSha256        = $installerSha
      expectedArtifactSha256 = $ExpectedSha256.ToLower()
    }
    foreach ($key in $expectedFields.Keys) {
      if (-not $merged.$key) {
        throw "MergeFrom 证据缺少 $key（旧结构不可合并）"
      }
      if ([string]$merged.$key -ne [string]$expectedFields[$key]) {
        throw "MergeFrom 的 $key 与本次不一致：$($merged.$key) vs $($expectedFields[$key])"
      }
    }
  }

  $checkFresh = if ($merged -and $merged.checks -and $merged.checks.freshInstall -eq "pass") { "pass" } else { if ($freshInstallOk) { "pass" } else { "fail" } }
  $checkUpgrade = if ($PreviousInstaller) { if ($upgradeOk) { "pass" } else { "fail" } } elseif ($merged -and $merged.checks -and $merged.checks.upgrade -eq "pass") { "pass" } else { "fail" }
  # 本次运行请求了书库校验时，dataIntegrity 必须以本次为准，绝不能让 fresh-only 的 pass 掩盖失败。
  $checkData = if ($LibraryVerifyScript) { $dataIntegrity } elseif ($merged -and $merged.checks -and $merged.checks.dataIntegrity -eq "pass") { "pass" } else { $dataIntegrity }
  $checkRecovery = if ($PreviousInstaller) { if ($recoveryOk) { "pass" } else { "fail" } } elseif ($merged -and $merged.checks -and $merged.checks.recovery -eq "pass") { "pass" } else { "fail" }
  $checkPdfReading = if ($pdfReadingOk) { "pass" } else { "fail" }
  $checkProgressRestart = if ($progressRestartOk) { "pass" } else { "fail" }
  $checkBackupRestore = if ($backupRestoreOk) { "pass" } else { "fail" }
  $checkDatabaseRollback = if ($databaseRollbackOk) { "pass" } else { "fail" }

  $finalLibrary = if ($libraryResult) { $libraryResult } elseif ($merged) { $merged.library } else { $null }
  # fresh-only 运行没有 PDF/备份/回滚断言，四项新检查如实为 fail，但不得因此
  # 把“全新安装验证”判死；升级运行（PdfCheckScript）则必须四项全 pass。
  $pdfAllPass = [bool]($checkPdfReading -eq "pass" -and $checkProgressRestart -eq "pass" -and
    $checkBackupRestore -eq "pass" -and $checkDatabaseRollback -eq "pass")
  $verdict = if ($script:Failures.Count -eq 0 -and $dataIntegrity -eq "pass" -and
    ($checkFresh -eq "pass" -or $checkUpgrade -eq "pass") -and
    (-not $pdfChecksRequested -or $pdfAllPass)) { "PASS" } else { "FAIL" }

  $evidence = [ordered]@{
    kind = "manga-reader.install-verification"
    verdict = $verdict
    version = $ExpectedVersion
    commit = $Commit
    platform = "windows-x86_64"
    artifactName = $installerName
    artifactSha256 = $installerSha
    expectedArtifactSha256 = $ExpectedSha256.ToLower()
    previousVersion = if ($PreviousInstaller) { $PreviousExpectedVersion } else { "" }
    previousArtifactName = if ($PreviousInstaller) { Split-Path -Leaf $PreviousInstaller } else { "" }
    previousArtifactSha256 = $previousSha
    previousExpectedArtifactSha256 = if ($PreviousExpectedSha256) { $PreviousExpectedSha256.ToLower() } else { "" }
    checks = [ordered]@{
      freshInstall = $checkFresh
      upgrade = $checkUpgrade
      dataIntegrity = $checkData
      recovery = $checkRecovery
      pdfReading = $checkPdfReading
      progressRestart = $checkProgressRestart
      backupRestore = $checkBackupRestore
      databaseRollback = $checkDatabaseRollback
    }
    library = $finalLibrary
    machine = [ordered]@{
      os = (Get-CimInstance Win32_OperatingSystem).Caption
      cleanEnvironment = [bool]$CleanEnvironment
      image = $resolvedImage
      host = $env:COMPUTERNAME
      provenance = $provenance
    }
    verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
  }
  $json = $evidence | ConvertTo-Json -Depth 10
  $evidenceDir = Split-Path -Parent $EmitEvidence
  if ($evidenceDir -and -not (Test-Path $evidenceDir)) {
    New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
  }
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
