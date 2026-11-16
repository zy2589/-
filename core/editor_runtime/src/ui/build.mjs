import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import {
  planReviewCaptionDeletion,
  reviewCaptionBlockIsCovered,
  reviewCaptionWordMatches,
} from '../review-caption-deletion.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = __dirname;
const targetHtml = path.join(uiDir, '..', 'ui.html');

function countMatches(value, pattern) {
  return Array.from(value.matchAll(pattern)).length;
}

function requireBuildCheck(condition, message) {
  if (!condition) throw new Error(`[UI preflight] ${message}`);
}

function validateUiArtifacts({ combinedBody, combinedJs, fullHtml }) {
  // Parse the exact JavaScript that will be inlined into ui.html, including
  // kernels and the individual UI modules, before writing a package artifact.
  new vm.Script(combinedJs, { filename: 'generated-ui-inline.js' });

  const inspectorPath = path.join(uiDir, 'html/06-inspector.html');
  const inspector = fs.readFileSync(inspectorPath, 'utf8');
  const stagePreview = fs.readFileSync(path.join(uiDir, 'html/05-stage-preview.html'), 'utf8');
  const timelineStyle = fs.readFileSync(path.join(uiDir, 'styles/06-timeline-davinci.css'), 'utf8');
  const stageStyle = fs.readFileSync(path.join(uiDir, 'styles/04-stage-preview.css'), 'utf8');
  const baseStyle = fs.readFileSync(path.join(uiDir, 'html/01-body-prefix.html'), 'utf8');
  const waveformScript = fs.readFileSync(path.join(uiDir, 'scripts/09-timeline-clips-waveform.js'), 'utf8');
  const exportUiScript = fs.readFileSync(path.join(uiDir, 'scripts/17-project-export-resolve.js'), 'utf8');
  const projectStoreScript = fs.readFileSync(path.join(uiDir, '../project-store.mjs'), 'utf8');
  const projectTrashCleaner = fs.readFileSync(path.join(uiDir, '../project-trash-cleaner.mjs'), 'utf8');
  const timelineMarkup = fs.readFileSync(path.join(uiDir, 'html/07-timeline.html'), 'utf8');
  const previewLayoutStyle = fs.readFileSync(path.join(uiDir, 'styles/03-sidebar-panels.css'), 'utf8');
  const spliceScript = fs.readFileSync(path.join(uiDir, 'scripts/38-video-splice.js'), 'utf8');
  const gradingScript = fs.readFileSync(path.join(uiDir, 'scripts/11-video-grading-beauty.js'), 'utf8');
  const gradingEventsScript = fs.readFileSync(path.join(uiDir, 'scripts/19-fonts-shortcuts-dragdrop.js'), 'utf8');
  const spliceStyle = fs.readFileSync(path.join(uiDir, 'styles/37-video-splice.css'), 'utf8');
  const blemishRetouchScript = fs.readFileSync(path.join(uiDir, 'scripts/35-blemish-retouch.js'), 'utf8');
  // The editor UI is also built from a staged copy under .build. Resolve the
  // download regression guard against both the source tree and that staging
  // tree so a package build validates the same downloader code as local UI
  // generation instead of depending on one fixed directory layout.
  const downloaderSourceCandidates = [
    path.resolve(uiDir, '../../../downloader_runtime/app.py'),
    path.resolve(uiDir, '../../../../../../../core/downloader_runtime/app.py'),
  ];
  const downloaderSourcePath = downloaderSourceCandidates.find((candidate) => fs.existsSync(candidate));
  requireBuildCheck(!!downloaderSourcePath, '无法定位下载器源码以执行下载完成布局回归检查。');
  const downloaderScript = fs.readFileSync(downloaderSourcePath, 'utf8');
  const downloaderDesktopCandidates = [
    path.resolve(uiDir, '../../../downloader_runtime/desktop_ui.py'),
    path.resolve(uiDir, '../../../../../../../core/downloader_runtime/desktop_ui.py'),
  ];
  const downloaderDesktopPath = downloaderDesktopCandidates.find(candidate => fs.existsSync(candidate));
  requireBuildCheck(!!downloaderDesktopPath, '无法定位下载器弹层源码以执行弹层布局回归检查。');
  const downloaderDesktop = fs.readFileSync(downloaderDesktopPath, 'utf8');
  const uiHostCandidates = [
    path.resolve(uiDir, '../../../ui.py'),
    path.resolve(uiDir, '../../../../../../../core/ui.py'),
  ];
  const uiHostPath = uiHostCandidates.find(candidate => fs.existsSync(candidate));
  requireBuildCheck(!!uiHostPath, '无法定位主窗口源码以执行抠图入口回归检查。');
  const uiHost = fs.readFileSync(uiHostPath, 'utf8');
  const compressSourceCandidates = [
    path.resolve(uiDir, '../../../downloader_runtime/compress_video.py'),
    path.resolve(uiDir, '../../../../../../../core/downloader_runtime/compress_video.py'),
  ];
  const compressSourcePath = compressSourceCandidates.find((candidate) => fs.existsSync(candidate));
  requireBuildCheck(!!compressSourcePath, '无法定位压缩源码以执行横竖屏比例回归检查。');
  const compressScript = fs.readFileSync(compressSourcePath, 'utf8');
  const reviewScript = fs.readFileSync(path.join(uiDir, 'scripts/15-ai-review-polish.js'), 'utf8');
  const renderScript = fs.readFileSync(path.join(uiDir, '../media/render.mjs'), 'utf8');
  const nestedTimelineScript = fs.readFileSync(path.join(uiDir, '../nested-timeline.mjs'), 'utf8');
  const compoundTimelineUi = fs.readFileSync(path.join(uiDir, 'scripts/33-nested-timeline.js'), 'utf8');
  const clipEditingScript = fs.readFileSync(path.join(uiDir, 'scripts/26-clip-editing.js'), 'utf8');
  const mediaScript = fs.readFileSync(path.join(uiDir, 'scripts/05-stage-objects.js'), 'utf8');
  const coreStateScript = fs.readFileSync(path.join(uiDir, 'scripts/01-core-state.js'), 'utf8');
  const assetScript = fs.readFileSync(path.join(uiDir, 'scripts/04-asset-library.js'), 'utf8');
  const stageScript = fs.readFileSync(path.join(uiDir, 'scripts/05-stage-objects.js'), 'utf8');
  const timelineScript = fs.readFileSync(path.join(uiDir, 'scripts/07-timeline-ruler-tracks.js'), 'utf8');
  const gestureScript = fs.readFileSync(path.join(uiDir, 'scripts/18-timeline-gestures-commands.js'), 'utf8');
  const captionPaintScript = fs.readFileSync(path.join(uiDir, 'scripts/06-caption-canvas-paint.js'), 'utf8');
  const dragDropScript = fs.readFileSync(path.join(uiDir, 'scripts/19-fonts-shortcuts-dragdrop.js'), 'utf8');
  requireBuildCheck(
    !dragDropScript.includes('activeBatchDropModal') &&
      countMatches(dragDropScript, /if \(!state\.editorActive\) return;/g) >= 2 &&
      dragDropScript.includes('if (!state.editorActive) {\n            toast("请先新建或打开一个工程");\n            return;'),
    '工程首页的拖放监听不得调用未定义的弹窗判断函数，也不得在工程外处理素材。',
  );
  const mediaClickStart = mediaScript.indexOf('card.onclick = (event) => {');
  const mediaClickEnd = mediaScript.indexOf('card.oncontextmenu', mediaClickStart);
  const mediaClickHandler = mediaClickStart >= 0 && mediaClickEnd > mediaClickStart
    ? mediaScript.slice(mediaClickStart, mediaClickEnd)
    : '';
  requireBuildCheck(
    !!mediaClickHandler &&
      mediaClickHandler.includes('state.selectedLibraryAssetId = card.dataset.libraryId') &&
      !mediaClickHandler.includes('placeLibraryAsset') &&
      !mediaScript.includes('label: "加入时间线"'),
    '素材区单击不得自动插入时间线，加入素材必须由拖放完成。',
  );
  requireBuildCheck(combinedBody.includes('单击只选中素材；拖到预览区域或对应时间轨道才会加入'), '素材区缺少单击选择、拖放添加的操作提示。');
  requireBuildCheck(
    coreStateScript.includes('definition.kind = "video"') &&
      coreStateScript.includes('[state.images, "video", "图片", "video"]') &&
      coreStateScript.includes('[state.titles, "video", "文字", "video"]') &&
      coreStateScript.includes('...state.images.filter((item) => item.trackId === trackId)') &&
      coreStateScript.includes('...state.titles.filter((item) => item.trackId === trackId)'),
    '旧图片/文字轨没有迁移到达芬奇式统一视频轨。',
  );
  requireBuildCheck(
    assetScript.includes('resolveTrackForInsert("video"') &&
      assetScript.includes('resolveTrackForInsert("audio"') &&
      assetScript.includes('createDynamicTrack(kind') &&
      !assetScript.includes('createDynamicTrack("image"'),
    '素材插入没有按 V/A 轨道模型分配或仍创建了独立图片轨。',
  );
  requireBuildCheck(
    coreStateScript.includes('ignoredItemIds = []') &&
      coreStateScript.includes('clipsOverlapOnTrack(item, placement)') &&
      coreStateScript.includes('isTrackLocked(trackId)'),
    '轨道插入必须检测时间重叠，并跳过锁定轨道。',
  );
  requireBuildCheck(
    timelineScript.includes('["image", state.images, "images"]') &&
      timelineScript.includes('["text", state.titles, "titles"]') &&
      timelineScript.includes('mainCollision') &&
      timelineScript.includes('overwriteOverlappingClips(onTrack, obj.id)') &&
      timelineScript.includes('Object.assign(original, values)'),
    '视频、图片和标题需要共享同轨覆盖规则，且不能与主素材无提示叠放。',
  );
  requireBuildCheck(
    gestureScript.includes('originTrackId: item.obj.trackId') &&
      gestureScript.includes('pairedTrackForVerticalMove') &&
      gestureScript.includes('state.avLinked && (state.selectedItems || []).some((item) => selectionIsLocked(item.type, item.id))') &&
      gestureScript.includes('applyOverlayTrackOverwrite(mover.type, mover.obj, { overwriteMain: true })') &&
      timelineScript.includes('event.target.closest?.(".trackhandle")') &&
      timelineScript.includes('drop-after'),
    '片段换轨要覆盖目标轨道并移动联动 A/V；轨道重排只应从拖动手柄启动。',
  );
  requireBuildCheck(
    countMatches(combinedBody, /id="timelineEditMode"/g) === 1 &&
      ['overwrite', 'insert', 'place-on-top'].every(mode => combinedBody.includes(`value="${mode}"`)) &&
      !/data-add-track-kind="(?:image|text)"/.test(combinedBody),
    '时间线必须提供覆盖、插入、置顶模式，图片和标题不能有独立轨道。',
  );
  requireBuildCheck(
    assetScript.includes('function prepareTimelineDrop') &&
      assetScript.includes('applyEditRipple(start') &&
      assetScript.includes('materializeTimelineMedia()') &&
      assetScript.includes('applyOverlayTrackOverwrite("videolayer", item, { overwriteMain: true })') &&
      assetScript.includes('pairedAudioTrackForVideo'),
    '拖放编辑模式必须按指定轨道执行插入/覆盖/置顶，并将视频源音频映射到对应 A 轨。',
  );
  requireBuildCheck(
    stageScript.includes('editMode = state.timelineEditMode') &&
      dragDropScript.includes('editMode: normalizedTimelineEditMode()') &&
      dragDropScript.includes('intent.editMode') &&
      stageScript.includes('importSubtitle(asset, target, at, trackId, editMode)'),
    '素材区、预览区和时间线拖放必须传递当前编辑模式。',
  );
  requireBuildCheck(
    timelineScript.includes('clipHtml(clip,"image")') && timelineScript.includes('clipHtml(clip,"text")'),
    '图片或标题片段没有绘制在视频轨上。',
  );
  const tabNav = inspector.match(/<nav\s+class="tabs">([\s\S]*?)<\/nav>/)?.[1] || '';
  const tabs = Array.from(tabNav.matchAll(/data-inspect="([^"]+)"/g), match => match[1]);
  requireBuildCheck(
    tabs.join(',') === 'basic,splice,color,filter,audio',
    `属性栏标签顺序或数量异常：${tabs.join(',') || '未找到标签'}`,
  );
  requireBuildCheck(
    countMatches(tabNav, /<button\b/g) === countMatches(tabNav, /<\/button\s*>/g),
    '属性栏按钮标签未正确闭合。',
  );
  requireBuildCheck(!/data-inspect="ai"|id="inspect-ai"/.test(inspector), '属性栏仍包含已移除的 AI 助手页面。');

  for (const pane of ['basic', 'splice', 'color', 'audio']) {
    requireBuildCheck(
      countMatches(inspector, new RegExp(`id="inspect-${pane}"`, 'g')) === 1,
      `属性栏缺少或重复 inspect-${pane} 页面。`,
    );
  }
  for (const control of ['splicePlaybackMode', 'spliceFreezeFrame', 'spliceFreezeUntil', 'spliceCaptureFreezeFrame', 'spliceCaptureStill']) {
    requireBuildCheck(
      countMatches(inspector, new RegExp(`id="${control}"`, 'g')) === 1,
      `拼接面板缺少或重复 ${control} 控件。`,
    );
  }
  requireBuildCheck(
    ['normal-audio', 'normal-muted', 'freeze-resume', 'freeze-hold'].every(mode => inspector.includes(`value="${mode}"`)),
    '拼接面板的播放、静音或定格模式不完整。',
  );
  requireBuildCheck(
    ['normal-audio', 'normal-muted'].every(mode => inspector.includes(`data-splice-quick-mode="${mode}"`)),
    '拼接面板缺少所选视频的快速带声/静音控制。',
  );
  requireBuildCheck(
    inspector.includes('截取片段首帧并填入前方空档') &&
      combinedJs.includes('target.clip?.sourceStart') &&
      combinedJs.includes('findTimelineGap(timelineGapItems(trackId)') &&
      combinedJs.includes('gap.duration') &&
      combinedJs.includes('duration = 3') &&
      combinedJs.includes('Number(duration) || 3'),
    '拼接截帧必须按当前选择取片段首帧，并自动填入同轨实际空档。',
  );
  requireBuildCheck(
    combinedJs.includes('loadedSpliceStyle?.clipPath') &&
      combinedJs.includes('window.syncSplicePanel?.()') &&
      combinedJs.includes('adjacentMainRollPair') &&
      combinedJs.includes('adjacentOverlayRollPair') &&
      combinedJs.includes('rollObjects'),
    '分区预览解码后必须继续裁切；选中视频后要同步面板，并支持同轨滚动修剪。',
  );
  requireBuildCheck(
    timelineStyle.includes('.clip-sticky {') &&
      timelineStyle.includes('position: absolute;') &&
      timelineStyle.includes('.clip.narrow:hover { overflow: hidden; }'),
    '时间线素材名称必须裁切在自己的片段内。',
  );
  requireBuildCheck(
    exportUiScript.includes('const hasMainTimeline = mainClips().length > 0') &&
      exportUiScript.includes('if (hasMainTimeline && !mainSourcePath)') &&
      exportUiScript.includes('nativeCall("assetAvailability", candidatePaths)') &&
      renderScript.includes('if (config?.noMainVideoSource') &&
      renderScript.includes('const hasMainAudio = !config.noMainVideoSource'),
    '导出前必须核验真实源路径；无主视频时间线时才允许使用轨道视频素材。',
  );
  requireBuildCheck(
    spliceScript.includes('region.borderColor = event.target.value') &&
      spliceScript.includes('region.borderWidth = 10') &&
      spliceScript.includes('Math.max(10, savedBorderWidth)') &&
      spliceScript.includes('spliceBorderWidthRange') &&
      spliceScript.includes('state.spliceSelectedRegionId = region.id') &&
      spliceStyle.includes('.splice-guide-region.selected') &&
      !spliceStyle.includes('.splice-guide-selection'),
    '画中画必须能选中、分别移动框与内容、设置描边颜色和宽度，且选中提示不能覆盖实际描边。',
  );
  requireBuildCheck(
    stageScript.includes('function timelinePreviewSceneAt(time = state.currentTime)') &&
      stageScript.includes('window.timelinePreviewSceneAt = timelinePreviewSceneAt') &&
      stageScript.includes('const previewScene = timelinePreviewSceneAt(state.currentTime)') &&
      spliceScript.includes('window.timelinePreviewSceneAt?.(state.currentTime)') &&
      stageScript.includes('t < Number(item.end || 0)') &&
      stageScript.includes('if (!timelineVideoLayers.length && layerSeekHold) layerSeekHold.hidden = true') &&
      stageScript.includes('timelineVideoLayers.some((item) => !item.missing') &&
      stageScript.includes('const onTimeline = state.currentTime >= item.start && state.currentTime < item.end') &&
      spliceScript.includes('pipEditTarget === "frame"') &&
      spliceScript.includes('window.setSpliceEditTarget = setPipEditTarget'),
    '预览与画中画命中测试必须共用当前时间场景；空档不能残留上一帧，框和内容必须各自使用明确的编辑目标。',
  );
  requireBuildCheck(
    stagePreview.includes('id="previewClipLayer"') &&
      stagePreview.indexOf('id="previewClipLayer"') < stagePreview.indexOf('id="selectionBox"') &&
      countMatches(stagePreview, /data-handle="/g) === 8 &&
      stageStyle.includes('.preview-clipping-layer') &&
      stageStyle.includes('overflow: hidden') &&
      baseStyle.includes('.resizehandle.n {') &&
      baseStyle.includes('.resizehandle.e {'),
    '预览越界画面必须裁切在画布内，八个细致锚点和选框需独立留在裁切层外。',
  );
  requireBuildCheck(
    stageScript.includes('function syncCompoundPreviewWrappers()') &&
      stageScript.includes('function syncCompoundPreviewCaptions(caption, wrappers)') &&
      stageScript.includes('item.compoundStackOrder') &&
      fs.readFileSync(path.join(uiDir, 'scripts/10-caption-inspector-presets.js'), 'utf8').includes('"text", "compound"') &&
      clipEditingScript.includes('selected.type === "compound"') &&
      clipEditingScript.includes('"image", "compound"].includes(state.selected?.type)') &&
      clipEditingScript.includes('state.selected?.type === "compound"') &&
      captionPaintScript.includes('compoundId: caption.compoundId || ""') &&
      nestedTimelineScript.includes('clip.compoundTrackId=') &&
      nestedTimelineScript.includes('clip.compoundStackOrder=') &&
      timelineScript.includes('proxy.dataset.type = "compound"') &&
      compoundTimelineUi.includes('originTrackId:proxy.dataset.trackId') &&
      compoundTimelineUi.includes('const acceptsTrack=(trackId,kind)=>') &&
      compoundTimelineUi.includes("['video','image','text'].includes(targetKind)") &&
      compoundTimelineUi.includes('!isTrackLocked(targetTrackId)') &&
      renderScript.includes('const overlayCompoundGroupsOnTrack =') &&
      renderScript.includes('const finalGroupLabel = `[compoundout${index}]`') &&
      renderScript.includes('item.image?._clipAssistantCaptionRaster && !item.image?.compoundId') &&
      exportUiScript.includes('compoundClips: (state.compoundClips || []).map'),
    '复合片段必须以单一外层对象预览、按层级拖放，并让外层变换和裁切进入导出合成。',
  );
  requireBuildCheck(
    assetScript.includes('spliceCanvasOverlay') &&
      assetScript.includes('function placeSpliceImageOverlayTrack') &&
      spliceScript.includes('target?.settings?.spliceCanvasOverlay') &&
      exportUiScript.includes('x.spliceCanvasOverlay ? ""') &&
      renderScript.includes('overlayImagesOnTrack(key)'),
    '拼接图片必须独立于分区、置于视频轨上层，并在导出时保持同一层级。',
  );
  requireBuildCheck(
    baseStyle.includes('background:#478f68') &&
      timelineStyle.includes('background: #478f68') &&
      timelineStyle.includes('background: linear-gradient(180deg, #4d986f, #438561)') &&
      waveformScript.includes('ctx.strokeStyle = "#ffffff"'),
    '所有音频轨片段需统一绿色底色与白色波形。',
  );
  requireBuildCheck(
    inspector.includes('id="spliceAngleRange"') &&
      inspector.includes('id="spliceBorderWidthRange"') &&
      inspector.includes('id="spliceFreezeFrameRange"') &&
      inspector.includes('id="spliceFreezeUntilRange"'),
    '拼接页数值项缺少对应的滑块控件。',
  );
  requireBuildCheck(
    gradingScript.includes('function selectedVideoGrade') &&
      gradingScript.includes('function colorPreviewFilter') &&
      gradingEventsScript.includes('grade[e.target.dataset.color]') &&
      renderScript.includes('colorRecipeFilters(clip.settings?.color || {})') &&
      renderScript.includes('colorRecipeFilters(video.color || {})'),
    '调色必须按所选视频片段预览和导出，不能作用于所有视频。',
  );
  requireBuildCheck(combinedJs.includes('function spliceRegionAtPoint'), '预览拖放没有按鼠标位置命中分区。');
  requireBuildCheck(combinedJs.includes('function spliceRegionOccupied'), '有素材的分区没有隐藏占位名称处理。');
  requireBuildCheck(
    combinedJs.includes('function spliceVideoTrackOrder') &&
      combinedJs.includes('mainClips().map((clip) => String(state.mainVideoTrackMap?.[clip.id] || "video"))') &&
      combinedJs.includes('const trackIndex = trackOrder.indexOf(trackId)'),
    '多轨自动分区必须按轨道映射，不能因同轨新增剪辑片段而漂移。',
  );
  requireBuildCheck(combinedJs.includes('window.spliceSelectionBounds = spliceSelectionBounds'), '分区视频选择框锚点没有独立对齐到分区。');
  requireBuildCheck(combinedJs.includes('spliceStyle?.transform'), '视频拖动未使用分区取景变换实时预览。');

  for (const anchor of ['frame', 'previewClipLayer', 'spliceGuideLayer', 'selectionBox', 'spliceFreezePreviewCanvas']) {
    requireBuildCheck(
      countMatches(combinedBody, new RegExp(`id="${anchor}"`, 'g')) === 1,
      `预览区锚点 ${anchor} 缺少或重复。`,
    );
    requireBuildCheck(
      countMatches(fullHtml, new RegExp(`id="${anchor}"`, 'g')) === 1,
      `生成页面中的预览区锚点 ${anchor} 缺少或重复。`,
    );
  }
  requireBuildCheck(combinedJs.includes('function applySpliceLayout'), '拼接布局处理逻辑没有进入生成页面。');
  requireBuildCheck(combinedJs.includes('function renderSpliceGuide'), '拼接预览引导层逻辑没有进入生成页面。');
  const blemishPaintStart = blemishRetouchScript.indexOf('function paint(');
  const blemishPaintEnd = blemishRetouchScript.indexOf('function insertKey(', blemishPaintStart);
  const blemishPaint = blemishPaintStart >= 0 && blemishPaintEnd > blemishPaintStart
    ? blemishRetouchScript.slice(blemishPaintStart, blemishPaintEnd)
    : '';
  requireBuildCheck(
    stageScript.includes('blemishCanvas.dataset.previewTargetVisible = visible ? "true" : "false"') &&
      stageScript.includes('blemishCanvas.style.zIndex = String(visualZ(track) + 1)') &&
      blemishPaint.includes('canvas.dataset.previewTargetVisible !== "true"') &&
      !blemishPaint.includes('canvas.classList.add("active")'),
    '瑕疵预览画布必须跟随有效主片段的可见范围和轨道层级，不能显示结束片段的残留帧。',
  );
  requireBuildCheck(
    downloaderScript.includes('self.completion_actions = ttk.Frame(row') &&
      !downloaderScript.includes('self.clear_on_finish') &&
      !downloaderScript.includes('if hasattr(self, \'clear_on_finish\')'),
    '下载完成后不能自动清空表单或增加第二行页脚造成整页重排。',
  );
  requireBuildCheck(
    downloaderScript.includes("text='引流模板'") &&
      downloaderScript.includes("text='抠图区域'") &&
      downloaderScript.indexOf("text='引流模板'") < downloaderScript.indexOf("text='抠图区域'") &&
      !downloaderScript.includes('打开抠图功能') &&
      uiHost.includes('MAX_CUTOUT_WINDOWS = 2') &&
      uiHost.includes('len(alive) + self.pending_cutout_windows >= MAX_CUTOUT_WINDOWS') &&
      uiHost.includes('self.rotoscope_module.RotoscopeWindow(self)') &&
      !uiHost.includes('self.nav_cutout.pack('),
    '抠图只能从引流模板后的入口打开，最多两个独立窗口，侧栏不得保留重复入口。',
  );
  requireBuildCheck(
    stagePreview.indexOf('id="previewTools"') >= 0 &&
      stagePreview.indexOf('id="previewTools"') < stagePreview.indexOf('id="stage"') &&
      stagePreview.includes('素材缩放') &&
      stagePreview.includes('id="previewQuickMenu"') &&
      previewLayoutStyle.includes('grid-template-rows: minmax(36px, auto) minmax(0, 1fr) 43px'),
    '预览工具必须显示在画布上方，并清楚区分素材缩放与画布设置。',
  );
  const clipDurationStart = timelineStyle.indexOf('.clip-duration {');
  const clipDurationEnd = timelineStyle.indexOf('\n      }', clipDurationStart);
  const clipDurationRule = clipDurationStart >= 0 && clipDurationEnd > clipDurationStart
    ? timelineStyle.slice(clipDurationStart, clipDurationEnd)
    : '';
  requireBuildCheck(
    coreStateScript.includes('function formatTime(seconds)') &&
      !coreStateScript.includes('remainder.toFixed(3)') &&
      !stagePreview.includes('00:00.000') &&
      waveformScript.includes('formatTime(duration, false)') &&
      timelineMarkup.includes('时间线缩放') &&
      clipDurationRule.includes('background: transparent;') &&
      !clipDurationRule.includes('background: rgba('),
    '播放时间和片段时长不得显示小数或黑底，并需区分时间线缩放控件。',
  );
  requireBuildCheck(
    downloaderDesktop.includes('row.winfo_rooty() + row.winfo_height()') &&
      downloaderDesktop.includes('popup.lift()') &&
      downloaderDesktop.includes('popup.transient(self.root_widget)'),
    '下载区选项弹层必须锚定在按钮下方并显示在所属窗口前面。',
  );
  requireBuildCheck(
    projectStoreScript.includes('await fs.promises.rename(source, trashDirectory)') &&
      projectStoreScript.includes('new Worker(new URL("./project-trash-cleaner.mjs"') &&
      !projectStoreScript.includes('const checkTree = async directory') &&
      projectTrashCleaner.includes('otherProjectReferences()') &&
      projectTrashCleaner.includes('cacheFileIsSafe(cachePath, cacheRoot)') &&
      projectTrashCleaner.includes('await fs.promises.rm'),
    '删除工程必须先快速移出列表，再在后台安全清理工程文件和未共享缓存。',
  );
  requireBuildCheck(
    compressScript.includes('def _even_display_dimensions') &&
      compressScript.includes('def _display_dimensions') &&
      compressScript.includes('_video_filter(source_video, expected_width, expected_height)') &&
      !compressScript.includes('force_original_aspect_ratio') &&
      !compressScript.includes('pad='),
    '下载压缩必须保留输入素材的横竖方向与画面比例，不得强制画布或补边。',
  );
  requireBuildCheck(
    compressScript.includes('CRF = 18') &&
      compressScript.includes('source_video_mbps * 0.75') &&
      compressScript.includes('_video_filter(source_video, expected_width, expected_height, fps=None)') &&
      compressScript.includes('"-fps_mode", "passthrough"') &&
      !compressScript.includes('source_video_mbps * 0.24'),
    '下载压缩要使用较高画质档、宽松来源码率上限，并保留源帧率。',
  );
  requireBuildCheck(
    reviewScript.includes('planReviewCaptionDeletion(state.captions,selected') &&
      reviewScript.includes('state.captions=deletion.captions') &&
      reviewScript.includes('ambiguousCaptionIds.size') &&
      !reviewScript.includes('state.captions=state.captions.filter(c=>!removed.has(c))') &&
      reviewScript.includes('if (!captionWordsRemain(preservedCaptionWords))') &&
      reviewScript.includes('无法准确切出重复范围，已取消删除以保护其他文案'),
    '删除文案必须按 issue、时间、轨道和素材限定到对应词句，禁止整组删字幕，并防止重复片段误删。',
  );

  const selectedReview = { id: 'review-a', issueId: 'shared-issue', captionTrackId: 'caption-a', ownerClipId: 'clip-a', start: 1, end: 2 };
  const reviewDeleteCaptions = [
    { id: 'grouped', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'before remove after', words: [
      { display: 'before', issueId: 'other', start: 0.2, end: 0.6 },
      { display: 'remove', issueId: 'shared-issue', start: 1.2, end: 1.5 },
      { display: 'after', issueId: 'other', start: 2.3, end: 2.7 },
    ] },
    { id: 'later-repeat', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'later', words: [
      { display: 'later', issueId: 'shared-issue', start: 5.2, end: 5.5 },
    ] },
    { id: 'other-track', trackId: 'caption-b', ownerClipId: 'clip-a', text: 'other track', words: [
      { display: 'other', issueId: 'shared-issue', start: 1.2, end: 1.5 },
    ] },
    { id: 'other-clip', trackId: 'caption-a', ownerClipId: 'clip-b', text: 'other clip', words: [
      { display: 'other', issueId: 'shared-issue', start: 1.2, end: 1.5 },
    ] },
  ];
  const deletion = planReviewCaptionDeletion(reviewDeleteCaptions, [selectedReview], {
    joinWords: words => words.map(word => word.display).join(' '),
  });
  const grouped = deletion.captions.find(caption => caption.id === 'grouped');
  requireBuildCheck(
    deletion.removedWords.length === 1 && deletion.removedReviewIds.has('review-a') &&
      grouped?.words.map(word => word.display).join(' ') === 'before after' &&
      deletion.captions.some(caption => caption.id === 'later-repeat') &&
      deletion.captions.some(caption => caption.id === 'other-track') &&
      deletion.captions.some(caption => caption.id === 'other-clip'),
    '重复 issue ID 的删除回归失败：必须保留同一字幕组内的其他词、其他时间段、字幕轨和素材。',
  );
  const fullyCovered = planReviewCaptionDeletion([
    { id: 'whole-block', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'repeat', start: 1.1, end: 1.8 },
  ], [selectedReview]);
  requireBuildCheck(fullyCovered.removedCaptionIds.has('whole-block') && !fullyCovered.captions.length,
    '精确覆盖的整句字幕应可删除。');
  const ambiguous = planReviewCaptionDeletion([
    { id: 'partial-block', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'keep this', start: 0.5, end: 1.5 },
  ], [selectedReview]);
  requireBuildCheck(ambiguous.ambiguousCaptionIds.has('partial-block') && ambiguous.captions.length === 1,
    '缺少逐词时间信息且只部分重叠的字幕必须保留并阻止删除。');
  const batchStart = reviewScript.indexOf('      function batchReviewAction(ids, mode) {');
  const batchEnd = reviewScript.indexOf('      async function manuallyEditReviewCaption(', batchStart);
  requireBuildCheck(batchStart >= 0 && batchEnd > batchStart,
    '批量删除字幕入口缺失，无法运行 P0 删除回归。');
  const batchSource = reviewScript.slice(batchStart, batchEnd);
  const batchReview = { ...selectedReview };
  const laterReview = { id: 'review-b', issueId: 'shared-issue', captionTrackId: 'caption-a', ownerClipId: 'clip-a', start: 5, end: 6 };
  const batchState = {
    trackLocks: {}, reviewCaptions: [batchReview, laterReview],
    captions: JSON.parse(JSON.stringify(reviewDeleteCaptions)), captionRecoveryArchive: [],
    issues: [{ id: 'shared-issue' }], matchIssues: [{ id: 'shared-issue' }],
  };
  const effects = { snapshots: 0, renders: 0, saves: 0, toast: '' };
  const batchAction = vm.runInNewContext(`${batchSource}\nbatchReviewAction;`, {
    state: batchState,
    planReviewCaptionDeletion,
    reviewCaptionWordMatches,
    reviewCaptionBlockIsCovered,
    isTrackLocked: () => false,
    joinCaptionWords: words => words.map(word => word.display || word.text || '').filter(Boolean).join(' '),
    snapshot: () => { effects.snapshots += 1; },
    renderAll: () => { effects.renders += 1; },
    queueAutosave: () => { effects.saves += 1; },
    toast: message => { effects.toast = message; },
  });
  batchAction(['review-a'], 'deleteCaptions');
  const batchGrouped = batchState.captions.find(caption => caption.id === 'grouped');
  requireBuildCheck(
    effects.snapshots === 1 && effects.renders === 1 && effects.saves === 1 &&
      batchGrouped?.words.map(word => word.display).join(' ') === 'before after' &&
      batchState.reviewCaptions.length === 1 && batchState.reviewCaptions[0].id === 'review-b' &&
      batchState.issues.length === 1 && batchState.matchIssues.length === 1 &&
      batchState.captions.length === reviewDeleteCaptions.length,
    '批量删除入口集成回归失败：删除一个提示不能清空字幕组或同 issue ID 的其他时段。',
  );
  const blockedState = {
    trackLocks: {}, reviewCaptions: [batchReview],
    captions: [{ id: 'partial-block', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'keep this', start: 0.5, end: 1.5 }],
    captionRecoveryArchive: [], issues: [], matchIssues: [],
  };
  const blockedEffects = { snapshots: 0, toast: '' };
  const blockedAction = vm.runInNewContext(`${batchSource}\nbatchReviewAction;`, {
    state: blockedState,
    planReviewCaptionDeletion,
    reviewCaptionWordMatches,
    reviewCaptionBlockIsCovered,
    isTrackLocked: () => false,
    joinCaptionWords: words => words.map(word => word.display || word.text || '').join(' '),
    snapshot: () => { blockedEffects.snapshots += 1; },
    renderAll: () => {}, queueAutosave: () => {},
    toast: message => { blockedEffects.toast = message; },
  });
  blockedAction(['review-a'], 'deleteCaptions');
  requireBuildCheck(blockedEffects.snapshots === 0 && blockedState.captions.length === 1 &&
      blockedState.captions[0].text === 'keep this' && blockedEffects.toast.includes('整次操作已取消'),
    '逐词范围不明时必须在写入撤销记录前取消整个删除操作。');
}

export function buildUiHtml() {
  const head = fs.readFileSync(path.join(uiDir, 'html/00-head.html'), 'utf8');
  const tail = fs.readFileSync(path.join(uiDir, 'html/99-tail.html'), 'utf8');

  // Combine CSS files in alphabetical order
  const styleFiles = fs.readdirSync(path.join(uiDir, 'styles'))
    .filter(f => f.endsWith('.css'))
    .sort();
  const combinedCss = styleFiles
    .map(f => fs.readFileSync(path.join(uiDir, 'styles', f), 'utf8'))
    .join('');

  // Combine HTML body files in alphabetical order
  const htmlFiles = fs.readdirSync(path.join(uiDir, 'html'))
    .filter(f => f.endsWith('.html') && f !== '00-head.html' && f !== '99-tail.html')
    .sort();
  const combinedBody = htmlFiles
    .map(f => fs.readFileSync(path.join(uiDir, 'html', f), 'utf8'))
    .join('');

  // Combine JS scripts in alphabetical order
  const scriptFiles = fs.readdirSync(path.join(uiDir, 'scripts'))
    .filter(f => f.endsWith('.js'))
    .sort();
  const editKernel=fs.readFileSync(path.join(uiDir,'../edit-decisions.mjs'),'utf8').replaceAll('export function ','function ');
  const comparisonKernel=fs.readFileSync(path.join(uiDir,'../caption-comparison.mjs'),'utf8').replaceAll('export function ','function ');
  const nestedKernel=fs.readFileSync(path.join(uiDir,'../nested-timeline.mjs'),'utf8').replaceAll('export function ','function ');
  const numericKernel=fs.readFileSync(path.join(uiDir,'../numeric-caption-correction.mjs'),'utf8').replaceAll('export function ','function ');
  const reviewDeletionKernel=fs.readFileSync(path.join(uiDir,'../review-caption-deletion.mjs'),'utf8').replaceAll('export function ','function ');
  const meaningContext=fs.readFileSync(path.join(uiDir,'../caption-meaning-review.mjs'),'utf8').split('export function captionMeaningContext')[1].split('export function parseCaptionMeanings')[0];
  const phraseKernel=fs.readFileSync(path.join(uiDir,'../caption-phrase-reviews.mjs'),'utf8').replaceAll('export function ','function ');
  const mildKernel=fs.readFileSync(path.join(uiDir,'../harmless-caption-correction.mjs'),'utf8').replaceAll('export function ','function ');
  const combinedJs = reviewDeletionKernel + mildKernel + phraseKernel + editKernel + comparisonKernel + nestedKernel + numericKernel + 'function captionMeaningContext'+meaningContext + scriptFiles
    .map(f => fs.readFileSync(path.join(uiDir, 'scripts', f), 'utf8'))
    .join('');

  const fullHtml = `${head}${combinedCss}${combinedBody}${combinedJs}${tail}`;

  validateUiArtifacts({ combinedBody, combinedJs, fullHtml });
  fs.writeFileSync(targetHtml, fullHtml, 'utf8');
  console.log(`[UI Builder] Successfully generated ui.html (${fullHtml.length} bytes)`);
  return fullHtml;
}

if (process.argv[1] === __filename) {
  buildUiHtml();
}
