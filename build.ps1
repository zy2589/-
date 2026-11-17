$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($PSScriptRoot)
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$PyInstaller = Join-Path $Root '.venv\Scripts\pyinstaller.exe'
$Entry = Join-Path $Root '剪辑助手.pyw'
$Resources = Join-Path $Root 'resources'
$Assets = Join-Path $Root 'assets'
$Downloader = Join-Path $Root 'core\downloader_runtime'
$EditorHostSource = Join-Path $Root 'core\editor_host'
$EditorRuntimeCodeSource = Join-Path $Root 'core\editor_runtime\src'
$EditorPtyPackageSource = Join-Path $Root 'core\editor_runtime\vendor\node-pty'
$EditorRuntimeSource = Join-Path $Resources 'editor-runtime'
$EditorRuntimeAssets = Join-Path $EditorRuntimeSource 'assets'
$EditorWebViewSource = Join-Path $EditorRuntimeSource 'webview2'
$LocalNode = Join-Path $Root 'core\editor_runtime\node.exe'
$Csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Output = Join-Path $Root 'release'
$Build = Join-Path $Root '.build'
$OutputApp = Join-Path $Output '剪辑助手'
$PackageResources = Join-Path $Build 'package-resources'
$PackageDownloader = Join-Path $Build 'package-downloader'
$FfmpegDownloadRoot = Join-Path $Build 'downloads'
$FfmpegArchive = Join-Path $FfmpegDownloadRoot 'ffmpeg-release-essentials-9.0.2.zip'
$FfmpegArchiveSha256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
$FfmpegStage = Join-Path $Build 'ffmpeg-9.0.2'
$FfmpegExecutable = Join-Path $FfmpegStage 'ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe'
$FfprobeExecutable = Join-Path $FfmpegStage 'ffmpeg-9.0.2-essentials_build\bin\ffprobe.exe'

# Keep the very large media executables out of Git history. Fetch the pinned
# Gyan essentials archive during a build and verify its publisher checksum.
New-Item -ItemType Directory -Force -Path $FfmpegDownloadRoot | Out-Null
if (!(Test-Path -LiteralPath $FfmpegArchive -PathType Leaf)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $FfmpegArchive
}
$ActualFfmpegArchiveSha256 = (Get-FileHash -LiteralPath $FfmpegArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualFfmpegArchiveSha256 -ne $FfmpegArchiveSha256) {
    throw "FFmpeg archive SHA-256 mismatch; expected $FfmpegArchiveSha256, received $ActualFfmpegArchiveSha256."
}
if (!(Test-Path -LiteralPath $FfmpegExecutable -PathType Leaf) -or !(Test-Path -LiteralPath $FfprobeExecutable -PathType Leaf)) {
    New-Item -ItemType Directory -Force -Path $FfmpegStage | Out-Null
    Expand-Archive -LiteralPath $FfmpegArchive -DestinationPath $FfmpegStage -Force
}
if (!(Test-Path -LiteralPath $FfmpegExecutable -PathType Leaf) -or !(Test-Path -LiteralPath $FfprobeExecutable -PathType Leaf)) {
    throw '校验后的 FFmpeg 9.0.2 构建包中缺少 ffmpeg.exe 或 ffprobe.exe。'
}

foreach ($RequiredFile in @($Python, $PyInstaller, $Entry,
        (Join-Path $Assets '剪辑助手.ico'),
        (Join-Path $Assets '剪辑助手图标-128.png'),
        (Join-Path $Assets '剪辑助手图标-1024.png'),
        (Join-Path $Downloader 'app.py'),
        (Join-Path $EditorRuntimeCodeSource 'project-store.mjs'),
        (Join-Path $EditorRuntimeCodeSource 'main.mjs'),
        (Join-Path $EditorRuntimeCodeSource 'ui\build.mjs'),
        (Join-Path $Root 'core\preflight_media.py'),
        (Join-Path $EditorHostSource 'DesktopHost.cs'),
        (Join-Path $EditorHostSource 'AssemblyInfo.cs'),
        (Join-Path $EditorHostSource 'app.manifest'),
        (Join-Path $EditorRuntimeCodeSource 'bootstrap.mjs'),
        $LocalNode,
        (Join-Path $EditorRuntimeAssets 'english-chinese.json.gz'),
        (Join-Path $EditorRuntimeAssets 'filter-preview-portrait.jpg'),
        (Join-Path $EditorRuntimeAssets 'models\std.rnnn'),
        (Join-Path $EditorRuntimeAssets 'models\face_landmarker.task'),
        (Join-Path $EditorRuntimeSource 'deep-filter.exe'),
        (Join-Path $EditorWebViewSource 'Microsoft.Web.WebView2.Core.dll'),
        (Join-Path $EditorWebViewSource 'Microsoft.Web.WebView2.WinForms.dll'),
        (Join-Path $EditorWebViewSource 'WebView2Loader.dll'),
        $Csc,
        (Join-Path $Resources 'ffmpeg\LICENSE.txt'),
        (Join-Path $Resources 'matting_models\rvm_mobilenetv3_fp32.onnx'),
        (Join-Path $Resources 'matting_models\human_segmentation_segformer_b0_ps_512.onnx'))) {
    if (!(Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        Write-Host ("MISSING INPUT " + $RequiredFile)
        throw 'A required build input is missing.'
    }
}

$NodeRuntimeInfo = @((& $LocalNode -p "process.versions.node + ' ' + process.versions.undici") -split '\s+')
if ($LASTEXITCODE -ne 0 -or $NodeRuntimeInfo.Count -lt 2) {
    throw '无法读取内置 Node.js/Undici 运行时版本。'
}
$NodeRuntimeVersion = [version]$NodeRuntimeInfo[0]
$UndiciRuntimeVersion = [version]$NodeRuntimeInfo[1]
if ($NodeRuntimeVersion -lt [version]'22.23.5' -or $UndiciRuntimeVersion -lt [version]'6.29.1') {
    throw "内置运行时需要 Node.js >= 22.23.5 且 Undici >= 6.29.1；当前为 Node.js $NodeRuntimeVersion / Undici $UndiciRuntimeVersion。"
}
Write-Host "内置运行时安全基线：Node.js $NodeRuntimeVersion / Undici $UndiciRuntimeVersion"

$PythonRuntimeInfo = & $Python -c "import platform; print(platform.python_version())"
if ($LASTEXITCODE -ne 0) { throw '无法读取打包用 Python 运行时版本。' }
$PythonRuntimeVersion = [version]$PythonRuntimeInfo.Trim()
if ($PythonRuntimeVersion -lt [version]'3.14.10') {
    throw "打包用 Python 需要 >= 3.14.10；当前为 $PythonRuntimeVersion。"
}
$FfmpegInfo = (& $FfmpegExecutable -version | Select-Object -First 1)
$FfprobeInfo = (& $FfprobeExecutable -version | Select-Object -First 1)
$FfmpegMatch = [regex]::Match($FfmpegInfo, '^ffmpeg version (?<version>\d+\.\d+\.\d+)')
$FfprobeMatch = [regex]::Match($FfprobeInfo, '^ffprobe version (?<version>\d+\.\d+\.\d+)')
if (!$FfmpegMatch.Success -or !$FfprobeMatch.Success -or
    [version]$FfmpegMatch.Groups['version'].Value -lt [version]'9.0.2' -or
    [version]$FfprobeMatch.Groups['version'].Value -lt [version]'9.0.2') {
    throw "FFmpeg/FFprobe 需要 >= 9.0.2；当前为 '$FfmpegInfo' / '$FfprobeInfo'。"
}
Write-Host "媒体安全基线：Python $PythonRuntimeVersion / FFmpeg $($FfmpegMatch.Groups['version'].Value) / FFprobe $($FfprobeMatch.Groups['version'].Value)"

# Exercise the media path and every standalone title-image row before staging
# or replacing the release build. This catches silent audio-only outputs and
# misleading "completed" states before an installer can be produced.
& $Python (Join-Path $Root 'core\preflight_media.py')
if ($LASTEXITCODE -ne 0) { throw '媒体与标题图预检失败，已中止打包。' }
& $Python (Join-Path $Root 'tests\test_downloader_template_fallback.py')
if ($LASTEXITCODE -ne 0) { throw '下载器共享模板权限回归失败，已中止打包。' }

New-Item -ItemType Directory -Force -Path $Output, $Build | Out-Null
$ResolvedBuildRoot = [IO.Path]::GetFullPath($Build).TrimEnd('\') + '\'
if (Test-Path -LiteralPath $PackageResources) {
    $ResolvedPackageResources = [IO.Path]::GetFullPath($PackageResources)
    if (!$ResolvedPackageResources.StartsWith($ResolvedBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝清理构建目录之外的资源暂存路径。'
    }
    Remove-Item -LiteralPath $ResolvedPackageResources -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageResources | Out-Null
if (Test-Path -LiteralPath $PackageDownloader) {
    $ResolvedPackageDownloader = [IO.Path]::GetFullPath($PackageDownloader)
    if (!$ResolvedPackageDownloader.StartsWith($ResolvedBuildRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝清理构建目录之外的下载器暂存路径。'
    }
    Remove-Item -LiteralPath $ResolvedPackageDownloader -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PackageDownloader | Out-Null
Copy-Item -Path (Join-Path $Downloader '*') -Destination $PackageDownloader -Recurse -Force
$UnusedCompressor = Join-Path $PackageDownloader 'compress_video.py'
if (Test-Path -LiteralPath $UnusedCompressor -PathType Leaf) {
    Remove-Item -LiteralPath $UnusedCompressor -Force
}
Get-ChildItem -LiteralPath $PackageDownloader -Directory -Filter '__pycache__' -Recurse |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
$BundledColorCache = Join-Path $PackageDownloader 'custom-colors.json'
if (Test-Path -LiteralPath $BundledColorCache -PathType Leaf) {
    Remove-Item -LiteralPath $BundledColorCache -Force
}
foreach ($PrivateSeedPath in @(
    (Join-Path $PackageDownloader 'user-seed'),
    (Join-Path $PackageDownloader 'canva-page-audit.json'),
    (Join-Path $PackageDownloader 'Canva本地页面信息.html'),
    (Join-Path $PackageDownloader 'Canva本地页面信息.md')
)) {
    if (Test-Path -LiteralPath $PrivateSeedPath) {
        Remove-Item -LiteralPath $PrivateSeedPath -Recurse -Force
    }
}
foreach ($Directory in @('ffmpeg','matting_models')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $PackageResources $Directory) | Out-Null
}
foreach ($RelativeFile in @(
    'ffmpeg\LICENSE.txt',
    'matting_models\rvm_mobilenetv3_fp32.onnx','matting_models\human_segmentation_segformer_b0_ps_512.onnx',
    'matting_models\EasyPortrait-ONNX-ATTRIBUTION.txt','matting_models\EasyPortrait-ONNX-LICENSE.txt',
    'matting_models\PPHumanSeg-LICENSE'
)) {
    $From = Join-Path $Resources $RelativeFile
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "缺少运行资源：$RelativeFile" }
    Copy-Item -LiteralPath $From -Destination (Join-Path $PackageResources $RelativeFile) -Force
}
Copy-Item -LiteralPath $FfmpegExecutable -Destination (Join-Path $PackageResources 'ffmpeg\ffmpeg.exe') -Force
Copy-Item -LiteralPath $FfprobeExecutable -Destination (Join-Path $PackageResources 'ffmpeg\ffprobe.exe') -Force
Copy-Item -LiteralPath (Join-Path $EditorRuntimeSource 'deep-filter.exe') -Destination (Join-Path $PackageResources 'deep-filter.exe') -Force
$EditorStage = Join-Path $Build '剪辑助手内核'
if (Test-Path -LiteralPath $EditorStage) {
    $ResolvedStage = [IO.Path]::GetFullPath($EditorStage)
    $ResolvedBuild = [IO.Path]::GetFullPath($Build).TrimEnd('\') + '\'
    if (!$ResolvedStage.StartsWith($ResolvedBuild, [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝清理构建目录之外的路径。'
    }
    Remove-Item -LiteralPath $ResolvedStage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $EditorStage | Out-Null
$NodeRuntimeDir = Join-Path $EditorStage 'runtime\node'
$NodeRuntimeExecutable = Join-Path $NodeRuntimeDir 'node.exe'
New-Item -ItemType Directory -Force -Path $NodeRuntimeDir | Out-Null
Copy-Item -LiteralPath $LocalNode -Destination $NodeRuntimeExecutable -Force
$EngineEditor = Join-Path $EditorStage 'Modules\剪辑助手\剪辑界面'
$EngineMedia = Join-Path $EditorStage 'Modules\剪辑助手\media'
New-Item -ItemType Directory -Force -Path $EngineEditor, $EngineMedia | Out-Null
# The complete editor runtime is staged from this repository. Build and runtime
# do not read another installation or another application's data directory.
$EngineEditorSource = Join-Path $EngineEditor 'src'
$RuntimeAssetStage = Join-Path $EngineEditor 'assets'
$SourceAssetStage = Join-Path $EngineEditorSource 'assets'
New-Item -ItemType Directory -Force -Path $EngineEditorSource, $RuntimeAssetStage | Out-Null
Copy-Item -Path (Join-Path $EditorRuntimeCodeSource '*') -Destination $EngineEditorSource -Recurse -Force
Copy-Item -Path (Join-Path $EditorRuntimeAssets '*') -Destination $RuntimeAssetStage -Recurse -Force
$PtyPackageJson = Join-Path $EditorPtyPackageSource 'package.json'
$PtyLibSource = Join-Path $EditorPtyPackageSource 'lib'
$PtyPrebuildSource = Join-Path $EditorPtyPackageSource 'prebuilds\win32-x64'
foreach ($PtyPackageFile in @(
    $PtyPackageJson,
    (Join-Path $PtyLibSource 'index.js'),
    (Join-Path $PtyPrebuildSource 'conpty.node'),
    (Join-Path $PtyPrebuildSource 'conpty\conpty.dll'),
    (Join-Path $PtyPrebuildSource 'conpty\OpenConsole.exe')
)) {
    if (!(Test-Path -LiteralPath $PtyPackageFile -PathType Leaf)) {
        throw "缺少 Windows 终端桥接依赖，未生成安装包：$PtyPackageFile"
    }
}
$PtyRuntimeStage = Join-Path $EngineEditor 'vendor\node-pty'
$PtyRuntimePrebuildStage = Join-Path $PtyRuntimeStage 'prebuilds\win32-x64'
New-Item -ItemType Directory -Force -Path $PtyRuntimeStage, $PtyRuntimePrebuildStage | Out-Null
Copy-Item -Path $PtyLibSource -Destination $PtyRuntimeStage -Recurse -Force
Copy-Item -LiteralPath $PtyPackageJson -Destination (Join-Path $PtyRuntimeStage 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $EditorPtyPackageSource 'LICENSE') -Destination (Join-Path $PtyRuntimeStage 'LICENSE') -Force
Get-ChildItem -LiteralPath $PtyPrebuildSource -Recurse -File | Where-Object { $_.Extension -ne '.pdb' } | ForEach-Object {
    $RelativePtyPath = $_.FullName.Substring($PtyPrebuildSource.Length).TrimStart('\')
    $PtyTarget = Join-Path $PtyRuntimePrebuildStage $RelativePtyPath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PtyTarget) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $PtyTarget -Force
}
foreach ($PrivateSeedPath in @(
    (Join-Path $SourceAssetStage 'credential-seed'),
    (Join-Path $SourceAssetStage 'user-seed'),
    (Join-Path $RuntimeAssetStage 'credential-seed'),
    (Join-Path $RuntimeAssetStage 'user-seed')
)) {
    if (Test-Path -LiteralPath $PrivateSeedPath) {
        Remove-Item -LiteralPath $PrivateSeedPath -Recurse -Force
    }
}
Copy-Item -LiteralPath (Join-Path $EditorRuntimeSource 'deep-filter.exe') -Destination (Join-Path $EngineMedia 'deep-filter.exe') -Force
Copy-Item -Path (Join-Path $EditorWebViewSource '*.dll') -Destination $EditorStage -Force
Push-Location $EngineEditor
try {
    & $LocalNode (Join-Path $EngineEditorSource 'ui\build.mjs')
    if ($LASTEXITCODE -ne 0) { throw '剪辑界面资源生成失败。' }
    & $LocalNode --test (Join-Path $Root 'tests\security.test.mjs')
    if ($LASTEXITCODE -ne 0) { throw '安全回归检查失败，已中止打包。' }
    $GeneratedUi = Join-Path $EngineEditorSource 'ui.html'
    $GeneratedUiText = [IO.File]::ReadAllText($GeneratedUi)
    foreach ($RequiredUiToken in @(
        'window.__refreshProjectHome = refreshHome',
        'requestAnimationFrame(() => refreshHome())',
        'zoomPreviewScale',
        'function setTimelineZoomAroundPlayhead(nextZoom, pointerClientX = null, preview = false)',
        'syncTimelineChrome();',
        'splicePlaybackMode',
        'spliceFreezeFrame',
        'spliceFreezeUntil',
        'spliceCaptureStill',
        'selectedLibraryAssetId = card.dataset.libraryId',
        '单击只选中素材；拖到预览区域或对应时间轨道才会加入',
        'id="timelineEditMode"',
        'value="overwrite"',
        'value="insert"',
        'value="place-on-top"',
        'function prepareTimelineDrop',
        'pairedAudioTrackForVideo',
        'editMode: normalizedTimelineEditMode()',
        'definition.kind = "video"',
        '[state.images, "video", "图片", "video"]',
        '[state.titles, "video", "文字", "video"]',
        'ignoredItemIds = []',
        'resolveTrackForInsert("video"',
        'resolveTrackForInsert("audio"',
        'function applyOverlayTrackOverwrite(type, obj, { overwriteMain = false } = {})',
        'applyOverlayTrackOverwrite("videolayer", item, { overwriteMain: true })',
        'applyOverlayTrackOverwrite(mover.type, mover.obj, { overwriteMain: true })',
        'pairedTrackForVerticalMove',
        'state.avLinked && (state.selectedItems || []).some((item) => selectionIsLocked(item.type, item.id))',
        'overwriteOverlays = false',
        'event.target.closest?.(".trackhandle")',
        'drop-after',
        'originTrackId: item.obj.trackId',
        'clipHtml(clip,"image")',
        'clipHtml(clip,"text")',
        'asset.spliceCaptureSettings',
        '截取片段首帧并填入前方空档',
        'findTimelineGap(timelineGapItems(trackId)',
        'gap.duration',
        'duration = 3',
        'Number(duration) || 3',
        'loadedSpliceStyle?.clipPath',
        'adjacentMainRollPair',
        'adjacentOverlayRollPair',
        'rollObjects',
        'const hasMainTimeline = mainClips().length > 0',
        'if (hasMainTimeline && !mainSourcePath)',
        'nativeCall("assetAvailability", candidatePaths)',
        'spliceFreezeFrameRange',
        'spliceFreezeUntilRange',
        'region.borderColor = event.target.value',
        'region.borderWidth = 10',
        'Math.max(10, savedBorderWidth)',
        'function selectedVideoGrade',
        'data-splice-quick-mode="normal-audio"',
        'data-splice-quick-mode="normal-muted"',
        'function spliceRegionAtPoint',
        'function spliceRegionOccupied',
        'function spliceVideoTrackOrder',
        'mainVideoTrackMap?.[clip.id]',
        'mainVideoTrackMap?.[target.clip?.id]',
        'trackOrder: state.trackOrder',
        'spliceLayout: state.spliceLayout',
        'trackOrder.indexOf(trackId)',
        'window.spliceSelectionBounds = spliceSelectionBounds',
        'splice-guide-divider-hit',
        'spliceGuideLayer',
        'selectionBox',
        'previewClipLayer',
        'spliceCanvasOverlay',
        'placeSpliceImageOverlayTrack',
        'const appendVisual = (element, item) =>',
        'item.compoundId ? compoundWrappers.get(String(item.compoundId)) : null',
        'function syncCompoundPreviewWrappers()',
        'function syncCompoundPreviewCaptions(caption, wrappers)',
        'for (const decoder of [$("video"), $("videoAlt")])',
        '? getActiveVideo()',
        'ctx.strokeStyle = "#ffffff"',
        'background-color: #478f68',
        'data-handle="n"',
        'data-handle="e"',
        'data-handle="s"',
        'data-handle="w"',
        'pipEditTarget === "frame"',
        'window.setSpliceEditTarget = setPipEditTarget',
        'function timelinePreviewSceneAt(time = state.currentTime)',
        'window.timelinePreviewSceneAt = timelinePreviewSceneAt',
        'preparedVideoLayers',
        'timelineVideoLayers',
        'splicePipScaleRange',
        'splicePipXRange',
        'splicePipYRange',
        'function setTrackLabelDensity',
        '.tracklabel.track-compact',
        'setTrackLabelDensity(trackHeightDrag.label, height)'
    )) {
        if (!$GeneratedUiText.Contains($RequiredUiToken)) {
            throw "生成后的剪辑页面缺少必要功能：$RequiredUiToken"
        }
    }
$RegressionChecklist = Join-Path $Root 'docs\打包前复检清单.md'
if (!(Test-Path -LiteralPath $RegressionChecklist -PathType Leaf)) {
    throw '缺少近期高频回归复检清单，已中止打包。'
}
Write-Host '自动化门禁通过后，仍须按 docs\打包前复检清单.md 完成实际界面回归；未验证项不得交付。'
$UiHostSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\ui.py'))
$EmbeddedEditorSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\embedded_editor.py'))
$DesktopHostSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\editor_host\DesktopHost.cs'))
$CutoutPageLoops = [regex]::Matches($UiHostSourceText, 'range\(CUTOUT_PAGE_COUNT\)').Count
if (!$UiHostSourceText.Contains('CUTOUT_PAGE_COUNT = 2') -or $CutoutPageLoops -ne 2) {
    throw "抠图页数量不是 2，已中止打包（页面循环数：$CutoutPageLoops）。"
}
$PageSwitchStart = $UiHostSourceText.IndexOf('    def _show_page(self, name: str, nav) -> None:')
$PageSwitchEnd = $UiHostSourceText.IndexOf('    def _card(', $PageSwitchStart)
if ($PageSwitchStart -lt 0 -or $PageSwitchEnd -le $PageSwitchStart) {
    throw '区域切换代码段缺失，已中止打包。'
}
$PageSwitchSourceText = $UiHostSourceText.Substring($PageSwitchStart, $PageSwitchEnd - $PageSwitchStart)
foreach ($RequiredPageSwitchToken in @(
    'target.tkraise()',
    'self.page_body = target',
    'set_view_active',
    'def _reveal_startup_window_when_ready',
    'app.rows_ready'
)) {
    if (!$PageSwitchSourceText.Contains($RequiredPageSwitchToken)) {
        throw "区域常驻切换缺少必要逻辑，已中止打包：$RequiredPageSwitchToken"
    }
}
if (!$UiHostSourceText.Contains('self.root.withdraw()')) {
    throw '启动窗口未等待首屏准备，已中止打包。'
}
foreach ($RemovedPageSwitchToken in @('RedrawWindow')) {
    if ($PageSwitchSourceText.Contains($RemovedPageSwitchToken)) {
        throw "区域切换仍会卸载或强制重绘页面，已中止打包：$RemovedPageSwitchToken"
    }
}
if (!$UiHostSourceText.Contains('native_parent=host') -or
    $PageSwitchSourceText.Contains('set_page_active') -or
    $EmbeddedEditorSourceText.Contains('def set_page_active(self, active: bool)') -or
    $DesktopHostSourceText.Contains('SetEmbeddedPageActive(bool active)') -or
    !$EmbeddedEditorSourceText.Contains('self.native_parent = native_parent or frame') -or
    !$DesktopHostSourceText.Contains('ResizeEmbedded(int x, int y, int width, int height)')) {
    throw '区域切换必须由页面宿主统一管理 WebView2 子窗口，不能在切页时额外调整同级 HWND，已中止打包。'
}
if (!$UiHostSourceText.Contains('for frame in self.page_frames.values():') -or
    !$UiHostSourceText.Contains('frame.grid(row=0, column=0, sticky="nsew")') -or
    $PageSwitchSourceText.Contains('grid_remove()') -or
    !$PageSwitchSourceText.Contains('target.tkraise()') -or
    !$UiHostSourceText.Contains('self.page_stage.grid_propagate(False)')) {
    throw '区域页面必须只初始化映射一次并通过堆叠顺序切换，禁止切页卸载页面，已中止打包。'
}
$CutoutSelectionStart = $UiHostSourceText.IndexOf('    def _select_cutout_page(self, index):')
$CutoutSelectionEnd = $UiHostSourceText.IndexOf('    def _create_cutout_editor(', $CutoutSelectionStart)
if ($CutoutSelectionStart -lt 0 -or $CutoutSelectionEnd -le $CutoutSelectionStart) {
    throw '抠图分页切换代码段缺失，已中止打包。'
}
$CutoutSelectionText = $UiHostSourceText.Substring($CutoutSelectionStart, $CutoutSelectionEnd - $CutoutSelectionStart)
if ($CutoutSelectionText.Contains('grid_remove()') -or !$CutoutSelectionText.Contains('page["host"].tkraise()') -or
    !$UiHostSourceText.Contains('            host.grid(row=0, column=0, sticky="nsew")')) {
    throw '抠图分页切换仍会卸载画面，已中止打包。'
}
foreach ($RequiredEditorWarmupToken in @(
    'def _start_editor_when_mapped(self, generation):',
    'self.embedded_editor.is_ready()',
    'self.editor_open_pending',
    'def _finish_editor_open(self, generation):'
)) {
    if (!$UiHostSourceText.Contains($RequiredEditorWarmupToken)) {
        throw "剪辑页必须在宿主准备完成后切换，已中止打包：$RequiredEditorWarmupToken"
    }
}
if ($PageSwitchSourceText.Contains('self.root.update_idletasks()')) {
    throw '页面切换仍同步强制刷新 Tk 绘制队列，已中止打包。'
}
$AlwaysOnTopPatterns = @(
    'attributes\(\s*[''\"]-topmost[''\"]\s*,\s*(?:True|true|1)\b',
    '\.TopMost\s*=\s*\$?true\b',
    'SetWindowPos\(\s*handle\s*,\s*-1\s*,'
)
$TopmostSourceFiles = Get-ChildItem (Join-Path $Root 'core') -Recurse -File -Include '*.py','*.mjs','*.js','*.cs'
foreach ($SourceFile in $TopmostSourceFiles) {
    $SourceText = [IO.File]::ReadAllText($SourceFile.FullName)
    foreach ($Pattern in $AlwaysOnTopPatterns) {
        if ([regex]::IsMatch($SourceText, $Pattern)) {
            throw "软件不得强制窗口置顶；发现置顶调用：$($SourceFile.FullName)（$Pattern）"
        }
    }
}
$SpliceSourceText = [IO.File]::ReadAllText((Join-Path $EditorRuntimeCodeSource 'ui\scripts\38-video-splice.js'))
$SpliceOrderStart = $SpliceSourceText.IndexOf('  function spliceVideoTrackOrder() {')
$SpliceOrderEnd = $SpliceSourceText.IndexOf('  function autoSpliceRegion(target) {', $SpliceOrderStart)
$SpliceAutoStart = $SpliceOrderEnd
$SpliceAutoEnd = $SpliceSourceText.IndexOf('  function splicePreviewStyle(', $SpliceAutoStart)
if ($SpliceOrderStart -lt 0 -or $SpliceOrderEnd -le $SpliceOrderStart -or $SpliceAutoEnd -le $SpliceAutoStart) {
    throw '分区轨道映射代码缺失，已中止打包。'
}
$SpliceTrackOrderCode = $SpliceSourceText.Substring($SpliceOrderStart, $SpliceOrderEnd - $SpliceOrderStart)
$SpliceRegionCode = $SpliceSourceText.Substring($SpliceAutoStart, $SpliceAutoEnd - $SpliceAutoStart)
if (!$SpliceTrackOrderCode.Contains('mainClips()') -or
    !$SpliceTrackOrderCode.Contains('state.mainVideoTrackMap?.[clip.id]') -or
    !$SpliceRegionCode.Contains('state.mainVideoTrackMap?.[target.clip?.id]') -or
    !$SpliceRegionCode.Contains('trackOrder.indexOf(trackId)') -or
    $SpliceRegionCode.Contains('const index = target?.type === "main"')) {
    throw '分区素材必须按同一真实视频轨道映射，禁止主视频固定占据最上分区，已中止打包。'
}
$PreviewStageSourceText = [IO.File]::ReadAllText((Join-Path $EditorRuntimeCodeSource 'ui\scripts\05-stage-objects.js'))
$PreviewSceneStart = $PreviewStageSourceText.IndexOf('      function timelinePreviewSceneAt(time = state.currentTime) {')
$PreviewSceneEnd = $PreviewStageSourceText.IndexOf('      window.timelinePreviewSceneAt = timelinePreviewSceneAt;', $PreviewSceneStart)
if ($PreviewSceneStart -lt 0 -or $PreviewSceneEnd -le $PreviewSceneStart) {
    throw '预览活动素材判定代码缺失，已中止打包。'
}
$PreviewSceneCode = $PreviewStageSourceText.Substring($PreviewSceneStart, $PreviewSceneEnd - $PreviewSceneStart)
if (!$PreviewSceneCode.Contains('t < Number(clip.end || 0)') -or
    !$PreviewSceneCode.Contains('t < Number(item.end || 0)')) {
    throw '预览场景必须严格按素材起止时间判定；禁止在素材结束后保留旧帧，已中止打包。'
}
$PreviewSceneKeyStart = $PreviewStageSourceText.IndexOf('        const sceneKey = JSON.stringify({')
$PreviewSceneKeyEnd = $PreviewStageSourceText.IndexOf('        // `activeVideoLayers`', $PreviewSceneKeyStart)
if ($PreviewSceneKeyStart -lt 0 -or $PreviewSceneKeyEnd -le $PreviewSceneKeyStart) {
    throw '预览场景缓存键缺失，已中止打包。'
}
$PreviewSceneKeyCode = $PreviewStageSourceText.Substring($PreviewSceneKeyStart, $PreviewSceneKeyEnd - $PreviewSceneKeyStart)
foreach ($RequiredSceneStackToken in @('trackOrder: state.trackOrder', 'spliceLayout: state.spliceLayout', 'spliceRatio: state.spliceRatio', 'spliceAngle: state.spliceAngle')) {
    if (!$PreviewSceneKeyCode.Contains($RequiredSceneStackToken)) {
        throw "播放预览缓存未包含叠放/分区状态，可能复用旧画面，已中止打包：$RequiredSceneStackToken"
    }
}
$SpliceGuideStart = $SpliceSourceText.IndexOf('  function renderSpliceGuide() {')
$SpliceGuideEnd = $SpliceSourceText.IndexOf('  function spliceRegionOccupied(region) {', $SpliceGuideStart)
if ($SpliceGuideStart -lt 0 -or $SpliceGuideEnd -le $SpliceGuideStart) {
    throw '分区预览引导层代码缺失，已中止打包。'
}
$SpliceGuideCode = $SpliceSourceText.Substring($SpliceGuideStart, $SpliceGuideEnd - $SpliceGuideStart)
if ($SpliceGuideCode.Contains('<text') -or $SpliceGuideCode.Contains('region.name')) {
    throw '分区预览不应绘制上区/下区等说明文字，已中止打包。'
}
$SliceSourceText = [IO.File]::ReadAllText((Join-Path $EditorRuntimeCodeSource 'ui\scripts\13-pause-cut-split.js'))
$TimelineGestureSourceText = [IO.File]::ReadAllText((Join-Path $EditorRuntimeCodeSource 'ui\scripts\18-timeline-gestures-commands.js'))
if (!$SliceSourceText.Contains('function splitMainClipAt(') -or
    !$TimelineGestureSourceText.Contains('splitClipsAt(')) {
    throw '剪辑区域切片命令入口缺失，已中止打包。'
}
$DownloaderAppSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\downloader_runtime\app.py'))
$TitleDesignSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\downloader_runtime\local_design.py'))
foreach ($RequiredDownloadToken in @(
    'if len(self.rows) < 12:',
    'def folder_name(person, title):',
    'def try_publish_title_png(',
    'saved.stat().st_size < 128',
    'KEYWORD_PATTERN = r"\b(?:GOD|JESUS)\b',
    'Holy\s+Spirit'
)) {
    if (!$DownloaderAppSourceText.Contains($RequiredDownloadToken) -and !$TitleDesignSourceText.Contains($RequiredDownloadToken)) {
        throw "下载行数、归档或标题图关键字规则缺失，已中止打包：$RequiredDownloadToken"
    }
}
$DownloadMethodStart = $DownloaderAppSourceText.IndexOf('    def _download(self, key, url, cancel, settings):')
$DownloadMethodEnd = $DownloaderAppSourceText.IndexOf('    def cancel(self):', $DownloadMethodStart)
$DownloadGroupStart = $DownloaderAppSourceText.IndexOf('    def _download_group(self, batch):')
$DownloadGroupEnd = $DownloaderAppSourceText.IndexOf('    def _download_uncached(', $DownloadGroupStart)
if ($DownloadMethodStart -lt 0 -or $DownloadMethodEnd -le $DownloadMethodStart -or
    $DownloadGroupStart -lt 0 -or $DownloadGroupEnd -le $DownloadGroupStart) {
    throw '下载后处理代码段缺失，已中止打包。'
}
$DownloadMethodSourceText = $DownloaderAppSourceText.Substring($DownloadMethodStart, $DownloadMethodEnd - $DownloadMethodStart)
$DownloadGroupSourceText = $DownloaderAppSourceText.Substring($DownloadGroupStart, $DownloadGroupEnd - $DownloadGroupStart)
if (!$DownloadMethodSourceText.Contains("'format': 'best'") -or
    $DownloadMethodSourceText.Contains("'format': 'bv*+ba/b'") -or
    $DownloadMethodSourceText.Contains('merge_output_format')) {
    throw '下载阶段仍会合并独立音视频流，已中止打包。'
}
$DownloadStageIndex = $DownloadGroupSourceText.IndexOf('self._download(leader_key')
$DenoiseStageIndex = $DownloadGroupSourceText.IndexOf('output = denoise_video(')
if ($DownloadStageIndex -lt 0 -or $DenoiseStageIndex -le $DownloadStageIndex -or
    $DownloadGroupSourceText.Contains('transcode_mp4') -or
    $DownloadGroupSourceText.Contains('compress_video') -or
    $DownloadGroupSourceText.Contains('COMPRESS_SIZE_LIMIT_BYTES')) {
    throw '下载后处理必须直接降噪且不得压缩转码，已中止打包。'
}
$TitleAppSourceText = [IO.File]::ReadAllText((Join-Path $Downloader 'app.py'))
$TitleRendererSourceText = [IO.File]::ReadAllText((Join-Path $Downloader 'local_design.py'))
$PngOutputSourceText = [IO.File]::ReadAllText((Join-Path $Downloader 'png_output.py'))
if (!$TitleAppSourceText.Contains('self.title_preview_manual_text') -or
    !$TitleAppSourceText.Contains('manual_title_lines') -or
    !$TitleRendererSourceText.Contains('def normalize_manual_title_lines') -or
    !$PngOutputSourceText.Contains("f'.clipassistant-{uuid.uuid4().hex}.tmp'")) {
    throw '标题手动分行、导出联动或长标题短临时文件修复缺失，已中止打包。'
}
$LegacyPipelineSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\pipeline.py'))
if (!$LegacyPipelineSourceText.Contains('"format": "best"') -or
    $LegacyPipelineSourceText.Contains('bestvideo*+bestaudio') -or
    $LegacyPipelineSourceText.Contains('merge_output_format') -or
    $LegacyPipelineSourceText.Contains('transcode_mp4') -or
    $LegacyPipelineSourceText.Contains('COMPRESS_SIZE_LIMIT_BYTES')) {
    throw '备用下载流程仍包含合并或压缩转码，已中止打包。'
}
    $RenderSourceText = [IO.File]::ReadAllText((Join-Path $EngineEditorSource 'media\render.mjs'))
    if (!$RenderSourceText.Contains('const hasMainAudio = !config.noMainVideoSource')) {
        throw '视频拼接工程无主视频时，导出器没有使用轨道素材作为视频输入。'
    }
    if (!$RenderSourceText.Contains('overlayImagesOnTrack(key)')) {
        throw '图片未按视频轨顺序进入导出合成，无法保证拼接图片置顶。'
    }
    if (!$RenderSourceText.Contains('Array.isArray(config.trackOrder)') -or
        !$RenderSourceText.Contains('[...config.trackOrder].reverse()')) {
        throw '导出合成必须按与预览一致的视频轨道顺序从底向上叠放，已中止打包。'
    }
    if ($GeneratedUiText.Contains('label: "加入时间线"') -or $GeneratedUiText.Contains('placeLibraryAsset(card.dataset.libraryId')) {
        throw '素材区单击或右键菜单仍可直接插入时间线，必须通过拖放添加。'
    }
    if ($GeneratedUiText.Contains('data-add-track-kind="image"') -or $GeneratedUiText.Contains('data-add-track-kind="text"') -or $GeneratedUiText.Contains('新增图片轨道') -or $GeneratedUiText.Contains('新增文字轨道')) {
        throw '图片和标题必须使用视频轨道，不能提供独立轨道入口。'
    }
    foreach ($RequiredUiAnchor in @('frame', 'spliceGuideLayer', 'selectionBox', 'spliceFreezePreviewCanvas')) {
        $AnchorCount = [regex]::Matches($GeneratedUiText, ('id="' + [regex]::Escape($RequiredUiAnchor) + '"')).Count
        if ($AnchorCount -ne 1) { throw "生成后的剪辑页面预览锚点异常：$RequiredUiAnchor（数量：$AnchorCount）" }
    }
    foreach ($PlaybackMode in @('normal-audio', 'normal-muted', 'freeze-resume', 'freeze-hold')) {
        if (!$GeneratedUiText.Contains(('value="' + $PlaybackMode + '"'))) {
            throw "生成后的拼接页面缺少播放方式：$PlaybackMode"
        }
    }
    $SpliceRender = [IO.File]::ReadAllText((Join-Path $EngineEditorSource 'media\render.mjs'))
    foreach ($SpliceRenderToken in @('const spliceRegion = image.spliceRegion', 'image.spliceRegion.x', 'spliceShapeAlphaFilter(spliceRegion, targetW, targetH)')) {
        if (!$SpliceRender.Contains($SpliceRenderToken)) {
            throw "拼接静帧/图片导出缺少分区支持：$SpliceRenderToken"
        }
    }
    if ($GeneratedUiText.Contains('data-inspect="ai"') -or $GeneratedUiText.Contains('id="inspect-ai"')) {
        throw '生成后的剪辑页面仍包含已移除的 AI 助手属性页。'
    }
    foreach ($UiModule in Get-ChildItem -LiteralPath (Join-Path $EngineEditorSource 'ui\scripts') -Filter '*.js' -File) {
        & $LocalNode --check $UiModule.FullName
        if ($LASTEXITCODE -ne 0) { throw "剪辑页面脚本语法检查失败：$($UiModule.Name)" }
    }
} finally { Pop-Location }
$EmbeddedHost = Join-Path $EditorStage '剪辑助手.WebView.dll'
& $Csc /nologo /target:library /platform:x64 /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll /r:System.Web.Extensions.dll `
    "/r:$(Join-Path $EditorStage 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $EditorStage 'Microsoft.Web.WebView2.WinForms.dll')" `
    "/out:$EmbeddedHost" `
    (Join-Path $EditorHostSource 'DesktopHost.cs') (Join-Path $EditorHostSource 'AssemblyInfo.cs')
if ($LASTEXITCODE -ne 0) { throw '剪辑助手同进程 WebView2 组件编译失败。' }
if (Test-Path -LiteralPath $OutputApp) {
    $ResolvedOutput = [IO.Path]::GetFullPath($OutputApp)
    $ResolvedRelease = [IO.Path]::GetFullPath($Output).TrimEnd('\') + '\'
    if (!$ResolvedOutput.StartsWith($ResolvedRelease, [StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝清理发布目录之外的路径。'
    }
    Remove-Item -LiteralPath $ResolvedOutput -Recurse -Force
}
$Args = @(
    '--noconfirm', '--clean', '--onedir', '--windowed',
    '--name', '剪辑助手',
    '--icon', (Join-Path $Assets '剪辑助手.ico'),
    '--manifest', (Join-Path $EditorHostSource 'app.manifest'),
    '--collect-all', 'tkinterdnd2',
    '--collect-all', 'yt_dlp',
    '--collect-all', 'gdown',
    '--collect-all', 'requests',
    '--collect-all', 'urllib3',
    '--collect-all', 'certifi',
    '--collect-all', 'phonenumbers',
    '--collect-all', 'onnxruntime',
    '--collect-all', 'nvidia',
    '--collect-all', 'pythonnet',
    '--collect-all', 'clr_loader',
    '--hidden-import', 'PIL.ImageGrab',
    '--hidden-import', 'PIL.ImageTk',
    '--hidden-import', 'core.rotoscope',
    '--add-data', "$PackageResources;resources",
    '--add-data', "$Assets;assets",
    '--add-data', "$PackageDownloader;core/downloader_runtime",
    '--distpath', $Output,
    '--workpath', (Join-Path $Build 'work'),
    '--specpath', $Build,
    $Entry
)
& $PyInstaller @Args
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 构建失败，退出码：$LASTEXITCODE" }

Copy-Item -LiteralPath $EditorStage -Destination (Join-Path $OutputApp '剪辑助手内核') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination (Join-Path $OutputApp 'README.md') -Force
$PrivatePackageFiles = @(Get-ChildItem -LiteralPath $OutputApp -Recurse -File | Where-Object {
    $_.FullName -match '[\\/]credential-seed[\\/]' -or
    $_.FullName -match '[\\/]user-seed[\\/]' -or
    $_.Name -in @('canva-page-audit.json','custom-colors.json','Canva本地页面信息.html','Canva本地页面信息.md')
})
if ($PrivatePackageFiles.Count -gt 0) {
    throw ("程序包误包含本机种子或缓存数据：" + ($PrivatePackageFiles.FullName -join '; '))
}
$PayloadBytes = (Get-ChildItem -LiteralPath $OutputApp -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("安装目录组件大小：{0:N1} MB（未压缩）" -f ($PayloadBytes / 1MB))
Write-Host "已生成：$(Join-Path $OutputApp '剪辑助手.exe')"
