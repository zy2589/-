$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($PSScriptRoot)
$Source = [IO.Path]::GetFullPath((Join-Path $Root 'release\剪辑助手'))
$ProgramsInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs')).TrimEnd('\') + '\'
$Destination = [IO.Path]::GetFullPath((Join-Path $ProgramsInstallRoot '剪辑助手'))
$ResolvedDestination = [IO.Path]::GetFullPath($Destination)
if (!$ResolvedDestination.StartsWith($ProgramsInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw '拒绝清理安装目录之外的程序文件。'
}
$Executable = Join-Path $Source '剪辑助手.exe'
if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) {
    throw '未找到安装文件。请先运行 build.ps1。'
}
$EditorHost = Join-Path $Source '剪辑助手内核\剪辑助手.WebView.dll'
if (!(Test-Path -LiteralPath $EditorHost -PathType Leaf)) {
    throw '安装包缺少主程序内置剪辑组件，未更改当前安装。'
}
$EditorRuntime = Join-Path $Source '剪辑助手内核\Modules\剪辑助手\剪辑界面'
$UiHtmlPath = Join-Path $EditorRuntime 'src\ui.html'
$NodeRuntime = Join-Path $Source '剪辑助手内核\runtime\node\node.exe'
$PtyRuntime = Join-Path $Source '剪辑助手内核\Modules\剪辑助手\剪辑界面\vendor\node-pty'
foreach ($PackageFile in @(
    $UiHtmlPath,
    $NodeRuntime,
    (Join-Path $PtyRuntime 'lib\index.js'),
    (Join-Path $PtyRuntime 'prebuilds\win32-x64\conpty.node'),
    (Join-Path $PtyRuntime 'prebuilds\win32-x64\conpty\conpty.dll'),
    (Join-Path $PtyRuntime 'prebuilds\win32-x64\conpty\OpenConsole.exe')
)) {
    if (!(Test-Path -LiteralPath $PackageFile -PathType Leaf)) {
        throw "安装包缺少必要文件，未更改当前安装：$PackageFile"
    }
}
$UiHtml = [IO.File]::ReadAllText($UiHtmlPath)
foreach ($Anchor in @('frame', 'spliceGuideLayer', 'selectionBox', 'spliceFreezePreviewCanvas')) {
    $AnchorCount = [regex]::Matches($UiHtml, ('id="' + [regex]::Escape($Anchor) + '"')).Count
    if ($AnchorCount -ne 1) { throw "安装包预览锚点异常，未更改当前安装：$Anchor（数量：$AnchorCount）" }
}
foreach ($PlaybackMode in @('normal-audio', 'normal-muted', 'freeze-resume', 'freeze-hold')) {
    if (!$UiHtml.Contains(('value="' + $PlaybackMode + '"'))) {
        throw "安装包缺少拼接播放模式，未更改当前安装：$PlaybackMode"
    }
}
foreach ($AntigravityAuthFeature in @(
    'id="antigravityAuthCode"',
    'id="submitAntigravityCode"',
    'submitAntigravityAuthorizationCode'
)) {
    if (!$UiHtml.Contains($AntigravityAuthFeature)) {
        throw "安装包缺少 Antigravity 授权码输入功能，未更改当前安装：$AntigravityAuthFeature"
    }
}
$AiSettingsPath = Join-Path $EditorRuntime 'src\ai-settings.mjs'
$AiSettingsText = [IO.File]::ReadAllText($AiSettingsPath)
foreach ($AntigravityRuntimeFeature in @('node-pty', 'Select login method:', 'terminal.write(`${code}\r`)')) {
    if (!$AiSettingsText.Contains($AntigravityRuntimeFeature)) {
        throw "安装包缺少 Antigravity 终端登录功能，未更改当前安装：$AntigravityRuntimeFeature"
    }
}
foreach ($TrackLabelFeature in @(
    'function setTrackLabelDensity',
    '.tracklabel.track-compact',
    '.tracklabel.track-roomy',
    'setTrackLabelDensity(trackHeightDrag.label, height)'
)) {
    if (!$UiHtml.Contains($TrackLabelFeature)) {
        throw "安装包缺少轨道自适应文案，未更改当前安装：$TrackLabelFeature"
    }
}
foreach ($SpliceFeature in @(
    '截取片段首帧并填入前方空档',
    'findTimelineGap(timelineGapItems(trackId)',
    'Number(duration) || 3',
    'loadedSpliceStyle?.clipPath',
    'const hasMainTimeline = mainClips().length > 0',
    'if (hasMainTimeline && !mainSourcePath)',
    'spliceFreezeFrameRange',
    'spliceFreezeUntilRange',
    'region.borderColor = event.target.value',
    'region.borderWidth = 10',
    'Math.max(10, savedBorderWidth)',
    'function selectedVideoGrade',
    'pipEditTarget === "frame"',
    'window.setSpliceEditTarget = setPipEditTarget',
    'function timelinePreviewSceneAt(time = state.currentTime)',
    'window.timelinePreviewSceneAt = timelinePreviewSceneAt',
    'preparedVideoLayers',
    'timelineVideoLayers',
    'visibleVideoLayers',
    'splicePipScaleRange',
    'splicePipXRange',
    'splicePipYRange'
)) {
    if (!$UiHtml.Contains($SpliceFeature)) {
        throw "安装包拼接功能预检失败，未更改当前安装：$SpliceFeature"
    }
}
if ($UiHtml.Contains('data-inspect="ai"') -or $UiHtml.Contains('id="inspect-ai"')) {
    throw '安装包仍包含已移除的 AI 助手属性页，未更改当前安装。'
}
$ProcessPath = [IO.Path]::GetFullPath((Join-Path $Destination '剪辑助手.exe'))
$RunningInstance = Get-Process -Name '剪辑助手' -ErrorAction SilentlyContinue |
    Where-Object {
        try {
            $_.Path -and [IO.Path]::GetFullPath($_.Path).Equals($ProcessPath, [StringComparison]::OrdinalIgnoreCase)
        } catch {
            # If the executable path cannot be read, treat the matching process name as running.
            $true
        }
    } |
    Select-Object -First 1
if ($RunningInstance) {
    throw '剪辑助手仍在运行。请先正常关闭窗口，再重新安装；当前安装未更改。'
}

$InstallId = [guid]::NewGuid().ToString('N')
$InstallStaging = [IO.Path]::GetFullPath((Join-Path $ProgramsInstallRoot ('.剪辑助手-installing-' + $InstallId)))
$InstallRollback = [IO.Path]::GetFullPath((Join-Path $ProgramsInstallRoot ('.剪辑助手-rollback-' + $InstallId)))
foreach ($InstallPath in @($InstallStaging, $InstallRollback)) {
    if (!$InstallPath.StartsWith($ProgramsInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝使用安装目录之外的暂存路径。'
    }
}
$StagedExe = Join-Path $InstallStaging '剪辑助手.exe'
$StagedHost = Join-Path $InstallStaging '剪辑助手内核\剪辑助手.WebView.dll'
$StagedUi = Join-Path $InstallStaging '剪辑助手内核\Modules\剪辑助手\剪辑界面\src\ui.html'
$MovedPrevious = $false
try {
    New-Item -ItemType Directory -Force -Path $InstallStaging | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $InstallStaging -Recurse -Force
    foreach ($StagedFile in @($StagedExe, $StagedHost, $StagedUi)) {
        if (!(Test-Path -LiteralPath $StagedFile -PathType Leaf)) {
            throw "安装包暂存校验失败，现有版本未更改：$StagedFile"
        }
    }
    if (Test-Path -LiteralPath $Destination) {
        Move-Item -LiteralPath $Destination -Destination $InstallRollback
        $MovedPrevious = $true
    }
    try {
        Move-Item -LiteralPath $InstallStaging -Destination $Destination
    } catch {
        if ((Test-Path -LiteralPath $Destination) -and $MovedPrevious) {
            Remove-Item -LiteralPath $Destination -Recurse -Force
        }
        if ($MovedPrevious -and (Test-Path -LiteralPath $InstallRollback)) {
            Move-Item -LiteralPath $InstallRollback -Destination $Destination
        }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $InstallStaging) {
        Remove-Item -LiteralPath $InstallStaging -Recurse -Force
    }
}
$InstalledExe = Join-Path $Destination '剪辑助手.exe'
if (!(Test-Path -LiteralPath $InstalledExe -PathType Leaf)) { throw '复制后的程序文件不存在。' }

# Keep this application's user data under Documents\ChatGPT\剪辑助手\用户数据.
# Never import projects, credentials, caches, or settings from other products.
$Programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $Programs | Out-Null
$Desktop = [Environment]::GetFolderPath('Desktop')
New-Item -ItemType Directory -Force -Path $Desktop | Out-Null
$ShortcutPaths = @(
    (Join-Path $Programs '剪辑助手.lnk'),
    (Join-Path $Desktop '剪辑助手.lnk')
)
$Shell = New-Object -ComObject WScript.Shell
foreach ($ShortcutPath in $ShortcutPaths) {
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $InstalledExe
    $Shortcut.WorkingDirectory = $Destination
    $Shortcut.IconLocation = $InstalledExe
    $Shortcut.Save()
}
if ($MovedPrevious -and (Test-Path -LiteralPath $InstallRollback)) {
    try { Remove-Item -LiteralPath $InstallRollback -Recurse -Force }
    catch { Write-Warning "新版本已安装，旧版本临时目录清理失败：$InstallRollback" }
}
Write-Host "已安装到：$Destination"
Write-Host "开始菜单快捷方式：$($ShortcutPaths[0])"
Write-Host "桌面快捷方式：$($ShortcutPaths[1])"
