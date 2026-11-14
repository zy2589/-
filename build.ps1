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

foreach ($RequiredFile in @($Python, $PyInstaller, $Entry,
        (Join-Path $Assets '剪辑助手.ico'),
        (Join-Path $Assets '剪辑助手图标-128.png'),
        (Join-Path $Assets '剪辑助手图标-1024.png'),
        (Join-Path $Downloader 'app.py'),
        (Join-Path $Downloader 'compress_video.py'),
        (Join-Path $Downloader 'canva-page-audit.json'),
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
        (Join-Path $Resources 'ffmpeg\ffmpeg.exe'),
        (Join-Path $Resources 'ffmpeg\ffprobe.exe'),
        (Join-Path $Resources 'denoise-dpdfnet\sherpa-onnx-offline-denoiser.exe'),
        (Join-Path $Resources 'denoise-dpdfnet\dpdfnet2_48khz_hr.onnx'),
        (Join-Path $Resources 'matting_models\rvm_mobilenetv3_fp32.onnx'),
        (Join-Path $Resources 'matting_models\human_segmentation_segformer_b0_ps_512.onnx'))) {
    if (!(Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        Write-Host ("MISSING INPUT " + $RequiredFile)
        throw 'A required build input is missing.'
    }
}

# Exercise the media path and every standalone title-image row before staging
# or replacing the release build. This catches silent audio-only outputs and
# misleading "completed" states before an installer can be produced.
& $Python (Join-Path $Root 'core\preflight_media.py')
if ($LASTEXITCODE -ne 0) { throw '媒体与标题图预检失败，已中止打包。' }

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
Get-ChildItem -LiteralPath $PackageDownloader -Directory -Filter '__pycache__' -Recurse |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
$BundledColorCache = Join-Path $PackageDownloader 'custom-colors.json'
if (Test-Path -LiteralPath $BundledColorCache -PathType Leaf) {
    Remove-Item -LiteralPath $BundledColorCache -Force
}
foreach ($Directory in @('ffmpeg','denoise-dpdfnet','matting_models')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $PackageResources $Directory) | Out-Null
}
foreach ($RelativeFile in @(
    'ffmpeg\ffmpeg.exe','ffmpeg\ffprobe.exe','ffmpeg\LICENSE.txt',
    'denoise-dpdfnet\dpdfnet2_48khz_hr.onnx','denoise-dpdfnet\sherpa-onnx-offline-denoiser.exe',
    'denoise-dpdfnet\onnxruntime.dll','denoise-dpdfnet\onnxruntime_providers_shared.dll',
    'denoise-dpdfnet\DPDFNet-LICENSE.txt','denoise-dpdfnet\onnxruntime-LICENSE.txt',
    'denoise-dpdfnet\sherpa-LICENSE.txt','denoise-dpdfnet\sources.json',
    'matting_models\rvm_mobilenetv3_fp32.onnx','matting_models\human_segmentation_segformer_b0_ps_512.onnx',
    'matting_models\EasyPortrait-ONNX-ATTRIBUTION.txt','matting_models\EasyPortrait-ONNX-LICENSE.txt',
    'matting_models\PPHumanSeg-LICENSE'
)) {
    $From = Join-Path $Resources $RelativeFile
    if (!(Test-Path -LiteralPath $From -PathType Leaf)) { throw "缺少运行资源：$RelativeFile" }
    Copy-Item -LiteralPath $From -Destination (Join-Path $PackageResources $RelativeFile) -Force
}
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
New-Item -ItemType Directory -Force -Path $EngineEditorSource, $RuntimeAssetStage | Out-Null
Copy-Item -Path (Join-Path $EditorRuntimeCodeSource '*') -Destination $EngineEditorSource -Recurse -Force
Copy-Item -Path (Join-Path $EditorRuntimeAssets '*') -Destination $RuntimeAssetStage -Recurse -Force
Copy-Item -LiteralPath (Join-Path $EditorRuntimeSource 'deep-filter.exe') -Destination (Join-Path $EngineMedia 'deep-filter.exe') -Force
Copy-Item -Path (Join-Path $EditorWebViewSource '*.dll') -Destination $EditorStage -Force
Push-Location $EngineEditor
try {
    & $LocalNode (Join-Path $EngineEditorSource 'ui\build.mjs')
    if ($LASTEXITCODE -ne 0) { throw '剪辑界面资源生成失败。' }
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
        'trackOrder.indexOf(String(target?.clip?.trackId',
        'window.spliceSelectionBounds = spliceSelectionBounds',
        'splice-guide-divider-hit',
        'spliceGuideLayer',
        'selectionBox',
        'previewClipLayer',
        'spliceCanvasOverlay',
        'placeSpliceImageOverlayTrack',
        'el.style.zIndex = String(visualZ(image.trackId))',
        'ctx.strokeStyle = "#ffffff"',
        'background-color: #123b2d',
        'data-handle="n"',
        'data-handle="e"',
        'data-handle="s"',
        'data-handle="w"',
        'pipFrameMoveHitDistance',
        'splicePipScaleRange',
        'splicePipXRange',
        'splicePipYRange'
    )) {
        if (!$GeneratedUiText.Contains($RequiredUiToken)) {
            throw "生成后的剪辑页面缺少必要功能：$RequiredUiToken"
        }
    }
$UiHostSourceText = [IO.File]::ReadAllText((Join-Path $Root 'core\ui.py'))
foreach ($RequiredPagePaintToken in @('_redraw_page_now', 'RDW_ALLCHILDREN', 'RDW_UPDATENOW')) {
    if (!$UiHostSourceText.Contains($RequiredPagePaintToken)) {
        throw "区域切换重绘修复缺失，已中止打包：$RequiredPagePaintToken"
    }
}
    $RenderSourceText = [IO.File]::ReadAllText((Join-Path $EngineEditorSource 'media\render.mjs'))
    if (!$RenderSourceText.Contains('const hasMainAudio = !config.noMainVideoSource')) {
        throw '视频拼接工程无主视频时，导出器没有使用轨道素材作为视频输入。'
    }
    if (!$RenderSourceText.Contains('overlayImagesOnTrack(key)')) {
        throw '图片未按视频轨顺序进入导出合成，无法保证拼接图片置顶。'
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
    foreach ($SpliceRenderToken in @('const spliceRegion = image.spliceRegion', 'image.spliceRegion.x', 'spliceShapeAlphaFilter(spliceRegion)')) {
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
$PayloadBytes = (Get-ChildItem -LiteralPath $OutputApp -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("安装目录组件大小：{0:N1} MB（未压缩）" -f ($PayloadBytes / 1MB))
Write-Host "已生成：$(Join-Path $OutputApp '剪辑助手.exe')"
