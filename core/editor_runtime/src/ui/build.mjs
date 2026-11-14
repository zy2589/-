import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';

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
  const spliceScript = fs.readFileSync(path.join(uiDir, 'scripts/38-video-splice.js'), 'utf8');
  const gradingScript = fs.readFileSync(path.join(uiDir, 'scripts/11-video-grading-beauty.js'), 'utf8');
  const gradingEventsScript = fs.readFileSync(path.join(uiDir, 'scripts/19-fonts-shortcuts-dragdrop.js'), 'utf8');
  const spliceStyle = fs.readFileSync(path.join(uiDir, 'styles/37-video-splice.css'), 'utf8');
  const renderScript = fs.readFileSync(path.join(uiDir, '../media/render.mjs'), 'utf8');
  const mediaScript = fs.readFileSync(path.join(uiDir, 'scripts/05-stage-objects.js'), 'utf8');
  const coreStateScript = fs.readFileSync(path.join(uiDir, 'scripts/01-core-state.js'), 'utf8');
  const assetScript = fs.readFileSync(path.join(uiDir, 'scripts/04-asset-library.js'), 'utf8');
  const stageScript = fs.readFileSync(path.join(uiDir, 'scripts/05-stage-objects.js'), 'utf8');
  const timelineScript = fs.readFileSync(path.join(uiDir, 'scripts/07-timeline-ruler-tracks.js'), 'utf8');
  const gestureScript = fs.readFileSync(path.join(uiDir, 'scripts/18-timeline-gestures-commands.js'), 'utf8');
  const dragDropScript = fs.readFileSync(path.join(uiDir, 'scripts/19-fonts-shortcuts-dragdrop.js'), 'utf8');
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
    assetScript.includes('spliceCanvasOverlay') &&
      assetScript.includes('function placeSpliceImageOverlayTrack') &&
      spliceScript.includes('target?.settings?.spliceCanvasOverlay') &&
      exportUiScript.includes('x.spliceCanvasOverlay ? ""') &&
      renderScript.includes('overlayImagesOnTrack(key)'),
    '拼接图片必须独立于分区、置于视频轨上层，并在导出时保持同一层级。',
  );
  requireBuildCheck(
    baseStyle.includes('background:#123b2d') &&
      timelineStyle.includes('background: #123b2d') &&
      timelineStyle.includes('background: linear-gradient(180deg, #174b38, #123b2d)') &&
      waveformScript.includes('ctx.strokeStyle = "#ffffff"'),
    '所有音频轨片段需统一暗绿色底色与白色波形。',
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
    combinedJs.includes('function spliceVideoTrackOrder') && combinedJs.includes('trackOrder.indexOf(String(target?.clip?.trackId'),
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
  const meaningContext=fs.readFileSync(path.join(uiDir,'../caption-meaning-review.mjs'),'utf8').split('export function captionMeaningContext')[1].split('export function parseCaptionMeanings')[0];
  const phraseKernel=fs.readFileSync(path.join(uiDir,'../caption-phrase-reviews.mjs'),'utf8').replaceAll('export function ','function ');
  const mildKernel=fs.readFileSync(path.join(uiDir,'../harmless-caption-correction.mjs'),'utf8').replaceAll('export function ','function ');
  const combinedJs = mildKernel + phraseKernel + editKernel + comparisonKernel + nestedKernel + numericKernel + 'function captionMeaningContext'+meaningContext + scriptFiles
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
