import fs from 'fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'url';
import {
  planIssueCaptionRemoval,
  planMediaCaptionDeletion,
  planTimelineCaptionDeletion,
  planReviewCaptionDeletion,
  reviewCaptionBlockIsCovered,
  reviewCaptionWordMatches,
} from '../review-caption-deletion.mjs';
import { buildCaptions, regroupCaptions } from '../alignment/regroup.mjs';

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
  requireBuildCheck(
    !/\bon(?:error|load|click|pointerdown|change|input|contextmenu|dragstart|drop|keydown|ended|timeupdate)\s*=\s*["']/i.test(`${combinedBody}\n${combinedJs}`),
    '页面使用 nonce CSP；禁止在静态 HTML/模板中添加内联事件处理器。',
  );

  const inspectorPath = path.join(uiDir, 'html/06-inspector.html');
  const inspector = fs.readFileSync(inspectorPath, 'utf8');
  const stagePreview = fs.readFileSync(path.join(uiDir, 'html/05-stage-preview.html'), 'utf8');
  const timelineStyle = fs.readFileSync(path.join(uiDir, 'styles/06-timeline-davinci.css'), 'utf8');
  const topbarStyle = fs.readFileSync(path.join(uiDir, 'styles/02-topbar-nav.css'), 'utf8');
  const stageStyle = fs.readFileSync(path.join(uiDir, 'styles/04-stage-preview.css'), 'utf8');
  const baseStyle = fs.readFileSync(path.join(uiDir, 'html/01-body-prefix.html'), 'utf8');
  const waveformScript = fs.readFileSync(path.join(uiDir, 'scripts/09-timeline-clips-waveform.js'), 'utf8');
  const playbackEngineScript = fs.readFileSync(path.join(uiDir, 'scripts/12-playback-engine.js'), 'utf8');
  const denoiseWorkstationScript = fs.readFileSync(path.join(uiDir, 'scripts/16-audio-denoise-workstation.js'), 'utf8');
  const exportUiScript = fs.readFileSync(path.join(uiDir, 'scripts/17-project-export-resolve.js'), 'utf8');
  const editorHostScript = fs.readFileSync(path.join(uiDir, '../main.mjs'), 'utf8');
  const projectStoreScript = fs.readFileSync(path.join(uiDir, '../project-store.mjs'), 'utf8');
  const projectTrashCleaner = fs.readFileSync(path.join(uiDir, '../project-trash-cleaner.mjs'), 'utf8');
  const timelineMarkup = fs.readFileSync(path.join(uiDir, 'html/07-timeline.html'), 'utf8');
  const previewLayoutStyle = fs.readFileSync(path.join(uiDir, 'styles/03-sidebar-panels.css'), 'utf8');
  const spliceScript = fs.readFileSync(path.join(uiDir, 'scripts/38-video-splice.js'), 'utf8');
  const gradingScript = fs.readFileSync(path.join(uiDir, 'scripts/11-video-grading-beauty.js'), 'utf8');
  const gradingEventsScript = fs.readFileSync(path.join(uiDir, 'scripts/19-fonts-shortcuts-dragdrop.js'), 'utf8');
  const spliceStyle = fs.readFileSync(path.join(uiDir, 'styles/37-video-splice.css'), 'utf8');
  const blemishRetouchScript = fs.readFileSync(path.join(uiDir, 'scripts/35-blemish-retouch.js'), 'utf8');
  requireBuildCheck(
    playbackEngineScript.includes('state.denoiseEnabled && state.denoisedAudio?.url') &&
      playbackEngineScript.includes('denoisedAudio?.url || state.video?.url') &&
      playbackEngineScript.includes('!!denoisedAudio') &&
      denoiseWorkstationScript.includes('state.denoiseEnabled = true;') &&
      denoiseWorkstationScript.includes('syncPreviewAudio();') &&
      denoiseWorkstationScript.includes('queueAutosave();') &&
      editorHostScript.includes('path.join(projectStoragePath(input.projectId), "media")') &&
      editorHostScript.includes('if (data.denoisedAudio?.path)') &&
      exportUiScript.includes('mainAudioPath = state.denoisedAudio.path'),
    '整轨降噪必须保存到工程媒体目录，并同时用于主界面播放、重开恢复与导出。',
  );
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
  requireBuildCheck(
    countMatches(downloaderScript, /title_entry\.bind\('<ButtonRelease-1>'.*self\.schedule_title_preview\(/g) === 1 &&
      downloaderScript.includes('if index is not None and self.title_preview_index==index:') &&
      downloaderScript.includes('self.schedule_title_preview(index,180)') &&
      !downloaderScript.includes("title_entry.bind('<Enter>'") &&
      !downloaderScript.includes("title_entry.bind('<Motion>'") &&
      !downloaderScript.includes("title_entry.bind('<FocusIn>',lambda _,i=index:self.schedule_title_preview"),
    '视频名称标题预览只能由点击触发，鼠标悬停不能弹出预览。',
  );
  requireBuildCheck(
    baseStyle.includes('.app { grid-template-rows: auto minmax(0, 1fr) var(--footer); }') &&
      topbarStyle.includes('flex-wrap: wrap;') &&
      topbarStyle.includes('grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), min(260px, 100%)))') &&
      topbarStyle.includes('overflow: visible;'),
    '多工程标签必须自动换行显示，顶部栏高度随标签行数展开。',
  );
  const spokenAdditionCases = [
    [
      { display: 'says,', start: 79.44, end: 79.568, matchType: 'spoken_addition', issueType: 'addition' },
      { display: ':5', start: 79.58, end: 79.62, matchType: 'match', issueType: 'mismatch' },
      { display: 'While', start: 80.24, end: 80.468, matchType: 'match' },
      { display: 'the', start: 80.48, end: 80.628, matchType: 'match' },
    ],
    [
      { display: 'survival', start: 118.55, end: 118.59, matchType: 'spoken_addition', issueType: 'addition' },
      { display: 'He', start: 119.12, end: 119.348, matchType: 'match' },
      { display: 'gave', start: 119.36, end: 119.588, matchType: 'match' },
      { display: 'it', start: 119.6, end: 119.748, matchType: 'match' },
    ],
  ];
  const hasEarlyGreenMerge = captions =>
    captions.some(caption => caption.words.some(word => word.matchType === 'spoken_addition') &&
      caption.words.some(word => word.matchType !== 'spoken_addition'));
  for (const naturalPunctuation of [false, true]) {
    const rebuiltCaptions = spokenAdditionCases.map(words =>
      buildCaptions(words, { maxWords: 10, maxChars: 34, maxLines: 2, naturalPunctuation }));
    const firstWhile = rebuiltCaptions[0].find(caption => caption.words.some(word => word.display === 'While'));
    const secondHe = rebuiltCaptions[1].find(caption => caption.words.some(word => word.display === 'He'));
    requireBuildCheck(
      !rebuiltCaptions.some(hasEarlyGreenMerge) &&
        firstWhile?.start >= 80.24 - 0.001 &&
        secondHe?.start >= 119.12 - 0.001 &&
        rebuiltCaptions[0].some(caption => caption.words.length === 1 && caption.words[0].display === 'says,') &&
        rebuiltCaptions[1].some(caption => caption.words.length === 1 && caption.words[0].display === 'survival'),
      '绿色口语词必须保留独立声学时间；后续正文不得提前并入口语词字幕。',
    );
    const regroupedCaptions = spokenAdditionCases.map(words => regroupCaptions(words, { naturalPunctuation, maxChars: 34 }));
    requireBuildCheck(
      !regroupedCaptions.some(hasEarlyGreenMerge) &&
        regroupedCaptions[0].find(caption => caption.words.some(word => word.display === 'While'))?.start >= 80.24 - 0.001 &&
        regroupedCaptions[1].find(caption => caption.words.some(word => word.display === 'He'))?.start >= 119.12 - 0.001,
      '重新分组时也必须保留绿色口语与正文之间的时间边界。',
    );
  }
  requireBuildCheck(
    downloaderScript.includes('self.script_vars.append(script);self.create_project_vars.append(create_project)') &&
      downloaderScript.includes('if not self.create_project_vars[row_index].get():') &&
      downloaderScript.includes("project_name = ' - '.join(value.strip() for value in (person, title) if value.strip())") &&
      downloaderScript.includes('script_text = self.script_vars[row_index].get()') &&
      downloaderScript.includes('if not script_text.strip():') &&
      downloaderScript.includes('self.root.after_idle(lambda rid=request_id, row=row_index, pname=project_name, script=script_text:') &&
      editorHostScript.includes('const script = cleanScriptCopy(String(input.script || ""));') &&
      editorHostScript.includes('data: {\n        script,\n        manuscriptLanguage: "en",\n      }') &&
      editorHostScript.includes('if (!script.trim()) throw new Error("正确文案为空，已取消创建工程。视频下载不会受影响。");'),
    '下载行勾选建工程必须使用该行手填的人名、视频名称和正确文案，并在后台创建；未勾选或空文案不得创建。',
  );
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
  const desktopHostCandidates = [
    path.resolve(uiDir, '../../../editor_host/DesktopHost.cs'),
    path.resolve(uiDir, '../../../../../../../core/editor_host/DesktopHost.cs'),
  ];
  const desktopHostPath = desktopHostCandidates.find(candidate => fs.existsSync(candidate));
  requireBuildCheck(!!desktopHostPath, '无法定位剪辑宿主源码以检查后台建工程后首页刷新。');
  const desktopHost = fs.readFileSync(desktopHostPath, 'utf8');
  const projectHomeScript = fs.readFileSync(path.join(uiDir, 'scripts/18-home-management.js'), 'utf8');
  requireBuildCheck(
    uiHost.includes('editor.show(activate=False)') &&
      desktopHost.includes('public void ShowEmbedded()') &&
      desktopHost.includes('RefreshProjectHome();') &&
      projectHomeScript.includes('window.__refreshProjectHome = refreshHome;'),
    '后台建工程不得切换下载界面；用户进入剪辑区时必须刷新首页工程列表。',
  );
  const compressSourceCandidates = [
    path.resolve(uiDir, '../../../downloader_runtime/compress_video.py'),
    path.resolve(uiDir, '../../../../../../../core/downloader_runtime/compress_video.py'),
  ];
  const compressSourcePath = compressSourceCandidates.find((candidate) => fs.existsSync(candidate));
  requireBuildCheck(!!compressSourcePath, '无法定位压缩源码以执行横竖屏比例回归检查。');
  const compressScript = fs.readFileSync(compressSourcePath, 'utf8');
  const reviewScript = fs.readFileSync(path.join(uiDir, 'scripts/15-ai-review-polish.js'), 'utf8');
  const captionReviewScript = fs.readFileSync(path.join(uiDir, 'scripts/10a-caption-review.js'), 'utf8');
  const deleteScript = fs.readFileSync(path.join(uiDir, 'scripts/13-pause-cut-split.js'), 'utf8');
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
      dragDropScript.includes('if (!state.editorActive) {\n            const card = projectCardDropTarget(event);') &&
      dragDropScript.includes('if (card && files.length) {\n              void importVideosIntoProjectCard(card.dataset.projectId, files, card);') &&
      dragDropScript.includes('toast("请先新建或打开一个工程");'),
    '工程首页只能接收拖到具体工程卡片的视频，其他区域仍不得在工程外处理素材。',
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
  requireBuildCheck(
    gestureScript.includes('collapseSelectedCaptionOnClick: clip.dataset.type === "caption"') &&
      gestureScript.includes('state.selectedItems.length > 1') &&
      gestureScript.includes('Math.hypot(e.clientX - timelineDrag.startX, e.clientY - timelineDrag.startY) > 3') &&
      gestureScript.includes('collapseCaptionSelectionAfterClick(timelineDrag, selectItem, e)'),
    '多选字幕后单击其中一条必须收窄为单选；拖动超过阈值时仍保留整组选区。',
  );
  const captionSelectionStart = gestureScript.indexOf('      function shouldCollapseSelectedCaptionOnClick(drag, event) {');
  const captionSelectionEnd = gestureScript.indexOf('\n      function handleTimelinePointerMove(e) {', captionSelectionStart);
  requireBuildCheck(captionSelectionStart >= 0 && captionSelectionEnd > captionSelectionStart,
    '时间轴单条字幕选择保护缺失，无法运行删除回归。');
  const captionSelection = vm.runInNewContext(
    `${gestureScript.slice(captionSelectionStart, captionSelectionEnd)}\n`+
      '({shouldCollapseSelectedCaptionOnClick,collapseCaptionSelectionAfterClick});',
  );
  const collapsedSelection = [];
  requireBuildCheck(captionSelection.collapseCaptionSelectionAfterClick(
    { collapseSelectedCaptionOnClick: true, startX: 10, startY: 20,
      element: { dataset: { id: 'caption-one' } } },
    (...args) => collapsedSelection.push(args),
    { clientX: 12, clientY: 21 },
  ) && captionSelection.shouldCollapseSelectedCaptionOnClick(
    { collapseSelectedCaptionOnClick: true, startX: 10, startY: 20 }, { clientX: 12, clientY: 21 },
  ) && collapsedSelection.length === 1 &&
    JSON.stringify(collapsedSelection[0]) === JSON.stringify(['caption', 'caption-one', false, false]),
    '普通点击多选中的单条字幕后，Delete 前必须只保留该字幕为选中状态。');
  const draggedSelection = [];
  requireBuildCheck(!captionSelection.collapseCaptionSelectionAfterClick(
    { collapseSelectedCaptionOnClick: true, selectionPointerMoved: true, startX: 10, startY: 20,
      element: { dataset: { id: 'caption-one' } } },
    (...args) => draggedSelection.push(args),
    { clientX: 15, clientY: 20 },
  ) && !captionSelection.shouldCollapseSelectedCaptionOnClick(
    { collapseSelectedCaptionOnClick: true, startX: 10, startY: 20 }, { clientX: 15, clientY: 20 },
  ) && draggedSelection.length === 0,
    '拖动多选字幕时必须保留整组选择，不能收窄成单条。');

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
  const broadReview = {
    id: 'review-broad', issueId: 'shared-issue', captionTrackId: 'caption-a', ownerClipId: 'clip-a',
    start: 1, end: 4, words: [{ issueId: 'shared-issue', display: 'remove', start: 1.2, end: 1.5 }],
  };
  const repeatedIssueWords = [{ id: 'all-shared-id', trackId: 'caption-a', ownerClipId: 'clip-a',
    text: 'before remove after', words: [
      { display: 'before', issueId: 'shared-issue', start: .4, end: .8 },
      { display: 'remove', issueId: 'shared-issue', start: 1.2, end: 1.5 },
      { display: 'after', issueId: 'shared-issue', start: 3.2, end: 3.6 },
    ] }];
  const narrowDeletion = planReviewCaptionDeletion(repeatedIssueWords, [broadReview], {
    joinWords: words => words.map(word => word.display).join(' '),
  });
  requireBuildCheck(narrowDeletion.removedWords.length === 1 &&
      narrowDeletion.captions[0]?.words.map(word => word.display).join(' ') === 'before after',
    '同一错误 ID 的宽时间范围删除回归失败：必须只删 review.words 精确标出的词。');
  const missingTrackScope = planReviewCaptionDeletion([
    { id: 'track-a', trackId: 'caption-a', ownerClipId: 'clip-a', words: [
      { display: 'one', issueId: 'shared-issue', start: 1.2, end: 1.5 }], text: 'one' },
    { id: 'track-b', trackId: 'caption-b', ownerClipId: 'clip-a', words: [
      { display: 'two', issueId: 'shared-issue', start: 1.2, end: 1.5 }], text: 'two' },
  ], [{ id: 'review-no-track', issueId: 'shared-issue', ownerClipId: 'clip-a', start: 1, end: 2 }]);
  requireBuildCheck(missingTrackScope.ambiguousCaptionIds.size === 2 &&
      missingTrackScope.captions.length === 2 && missingTrackScope.removedWords.length === 0,
    '缺少字幕轨范围且命中多个轨道时必须阻止删除，不能跨轨清除整组文案。');
  const allTextBlocked = planIssueCaptionRemoval([
    { id: 'all-text', trackId: 'caption-a', ownerClipId: 'clip-a', text: 'wrong', words: [
      { display: 'wrong', issueId: 'shared-issue', start: 1.2, end: 1.5 }],
  }], { id: 'review-a', issueId: 'shared-issue', captionTrackId: 'caption-a', ownerClipId: 'clip-a', start: 1, end: 2 });
  requireBuildCheck(allTextBlocked.blocked && allTextBlocked.reason === 'would-remove-all-text',
    '切除错误文案如果会清空工程全部字幕，必须在任何时间线编辑前拒绝。');
  const mediaScopedCaptions = [
    { id: 'owned-caption', trackId: 'caption-a', ownerClipId: 'audio-clip-a', sourceMediaId: 'source-a', text: 'remove keep', words: [
      { display: 'remove', start: 11.1, end: 11.4, sourceStart: 1.1, sourceEnd: 1.4 },
      { display: 'keep', start: 12.1, end: 12.4, sourceStart: 2.1, sourceEnd: 2.4 },
    ] },
    { id: 'other-owner', trackId: 'caption-a', ownerClipId: 'audio-clip-b', sourceMediaId: 'source-a', text: 'other owner', words: [
      { display: 'other', start: 11.1, end: 11.4, sourceStart: 1.1, sourceEnd: 1.4 },
    ] },
    { id: 'ownerless-same-source', trackId: 'caption-a', ownerClipId: '', sourceMediaId: 'source-a', text: 'source match', words: [
      { display: 'match', start: 11.2, end: 11.5, sourceStart: 1.2, sourceEnd: 1.5 },
    ] },
    { id: 'other-source', trackId: 'caption-a', ownerClipId: '', sourceMediaId: 'source-b', text: 'different source', words: [
      { display: 'different', start: 11.2, end: 11.5, sourceStart: 1.2, sourceEnd: 1.5 },
    ] },
    { id: 'same-source-other-placement', trackId: 'caption-a', ownerClipId: '', sourceMediaId: 'source-a', text: 'repeated elsewhere', words: [
      { display: 'repeat', start: 31.2, end: 31.5, sourceStart: 1.2, sourceEnd: 1.5 },
    ] },
  ];
  const localCaptionDeletion = planTimelineCaptionDeletion([
    { id: 'caption-one', trackId: 'caption-a', text: 'one', words: [{ display: 'one', start: 1, end: 2 }] },
    { id: 'caption-two', trackId: 'caption-a', text: 'two', words: [{ display: 'two', start: 3, end: 4 }] },
    { id: 'caption-locked', trackId: 'caption-locked', text: 'locked', words: [{ display: 'locked', start: 5, end: 6 }] },
  ], { selectedCaptionIds: ['caption-one', 'caption-locked'] }, {
    lockedTracks: { 'caption-locked': true },
  });
  requireBuildCheck(localCaptionDeletion.captions.length === 2 &&
      localCaptionDeletion.captions.some(caption => caption.id === 'caption-two') &&
      localCaptionDeletion.captions.some(caption => caption.id === 'caption-locked') &&
      localCaptionDeletion.removedCaptionIds.has('caption-one') &&
      !localCaptionDeletion.removedCaptionIds.has('caption-locked'),
    '删除一条字幕只能删除所选字幕，其他字幕和锁定轨道内容必须保留。');
  const mediaDeletion = planTimelineCaptionDeletion(mediaScopedCaptions, {
    ownerClipIds: ['audio-clip-a'],
    ranges: [{ ownerClipId: 'audio-clip-a', sourceMediaId: 'source-a', sourceStart: 1, sourceEnd: 2, start: 10, end: 20 }],
  }, { joinWords: words => words.map(word => word.display).join(' ') });
  const keptOwnedCaption = mediaDeletion.captions.find(caption => caption.id === 'owned-caption');
  requireBuildCheck(mediaDeletion.removedWords.length === 2 &&
      keptOwnedCaption?.words.map(word => word.display).join(' ') === 'keep' &&
      mediaDeletion.captions.some(caption => caption.id === 'other-owner') &&
      mediaDeletion.captions.some(caption => caption.id === 'other-source') &&
      mediaDeletion.captions.some(caption => caption.id === 'same-source-other-placement') &&
      !mediaDeletion.captions.some(caption => caption.id === 'ownerless-same-source'),
    '删除一段音频时，只能删除同时匹配音源区间和时间线区间的字幕词，必须保留重复素材在其他位置的文案。');
  const incompleteScopeDeletion = planTimelineCaptionDeletion(mediaScopedCaptions, {
    ownerClipIds: [],
    ranges: [{ ownerClipId: 'audio-clip-a', sourceMediaId: 'source-a', sourceStart: null, sourceEnd: 2 }],
  });
  requireBuildCheck(incompleteScopeDeletion.removedWords.length === 0 &&
      incompleteScopeDeletion.captions.length === mediaScopedCaptions.length,
    '音频源区间不完整时必须保留字幕，不能把缺失时间误当作零后扩大删除范围。');
  const deleteSelectedStart=deleteScript.indexOf('      function deleteSelected(ripple = false, { record = true } = {}) {');
  const deleteSelectedEnd=deleteScript.indexOf('      function shiftTracks(',deleteSelectedStart);
  requireBuildCheck(deleteSelectedStart>=0&&deleteSelectedEnd>deleteSelectedStart,
    '时间线删除入口缺失，无法运行字幕删除范围回归。');
  const deleteSelectedSource=deleteScript.slice(deleteSelectedStart,deleteSelectedEnd);
  requireBuildCheck(deleteSelectedSource.includes('planTimelineCaptionDeletion(state.captions||[]')&&
      deleteSelectedSource.includes('selectedCaptionIds:[...selectedCaptionIds]')&&
      deleteSelectedSource.includes('state.captions=mediaCaptionDeletion.captions;')&&
      deleteSelectedSource.includes('state.captions = state.captions.filter(keep("caption"));')&&
      deleteSelectedSource.includes('const explicitlySelectedAllCaptions = selectedCaptionIds.size > 0')&&
      deleteSelectedSource.includes('if(hasCaptionText&&!keepsCaptionText&&!explicitlySelectedAllCaptions)')&&
      deleteSelectedSource.includes('applyHistoryState(JSON.parse(beforeDelete));')&&
      !deleteSelectedSource.includes('remapCaptionsFromSource(')&&
      !deleteSelectedSource.includes('detachCaptionOwner('),
    '局部删除只能删选中字幕；显式选中全部字幕时允许删除，删除媒体时则保护未选文案。');
  function runDeleteSelectedScenario({ captions, selectedItems, audioAssets = [] }) {
    const scenarioState = {
      selectedItems: [...selectedItems], selected: selectedItems[0] || { type: '', id: '' },
      captions: JSON.parse(JSON.stringify(captions)), reviewCaptions: [], issues: [],
      captionRecoveryArchive: [], trackLocks: {}, undo: [], redo: [],
      videoLayers: [], audioAssets: JSON.parse(JSON.stringify(audioAssets)), images: [], titles: [],
      removals: [], audioMutes: [], autoTranscript: null, timelineRange: null,
      currentTime: 0, duration: 60, video: null, avLinked: false,
    };
    const context = {
      state: scenarioState,
      console: { log() {}, warn() {} },
      timelineGapSelection: null,
      resolveWorkingSelection: items => items,
      expandLinkedSelection: items => items,
      selectionIsLocked: () => false,
      planMediaCaptionDeletion,
      planTimelineCaptionDeletion,
      joinCaptionWords: words => words.map(word => word.display || word.text || '').filter(Boolean).join(' '),
      isTime: value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)),
      projectData: () => JSON.parse(JSON.stringify(scenarioState)),
      snapshot: () => scenarioState.undo.push('snapshot'),
      applyHistoryState: value => Object.assign(scenarioState, value),
      mainClips: () => [], mainAudioClips: () => [],
      timelineObjectFor: (type, id) => ({
        audioasset: scenarioState.audioAssets,
        videolayer: scenarioState.videoLayers,
        caption: scenarioState.captions,
      }[type] || []).find(object => object.id === id),
      overlayTrackId: (type, object) => object.trackId || type,
      dismissReviewHints() {}, dismissTrimmedIssues() {},
      toast() {}, cleanupEmptyDynamicTracks() {},
      recomputeContentDuration() {}, seekTimeline() {}, renderAll() {},
      shiftTracks() {}, rippleSubtitleTimeline() {},
      normalizeRemovals() {}, clearOrPromoteMainVideo() {},
      findTimelineGap() {}, timelineGapItems() {}, rippleDeleteTimelineGap() {},
    };
    vm.runInNewContext(`${deleteSelectedSource}\ndeleteSelected(false);`, context);
    return scenarioState;
  }
  const selectedCaptionId = mediaScopedCaptions[0].id;
  const localDeleteState = runDeleteSelectedScenario({
    captions: [
      { id: selectedCaptionId, trackId: 'caption-a', text: 'selected', words: [{ display: 'selected', start: 1, end: 2 }] },
      { id: 'unselected-caption', trackId: 'caption-a', text: 'keep me', words: [{ display: 'keep', start: 3, end: 4 }] },
    ],
    selectedItems: [{ type: 'caption', id: selectedCaptionId }],
  });
  requireBuildCheck(localDeleteState.captions.length === 1 &&
      localDeleteState.captions[0].id === 'unselected-caption' &&
      localDeleteState.captions[0].text === 'keep me',
    '执行真实 Delete 所选字幕路径后，未选中的字幕必须仍在工程状态中。');
  const audioDeleteCaptions = mediaScopedCaptions.map(caption => caption.id === 'owned-caption'
    ? { ...caption, text: 'remove', words: [caption.words[0]] }
    : caption);
  const audioDeleteState = runDeleteSelectedScenario({
    captions: audioDeleteCaptions,
    selectedItems: [{ type: 'audioasset', id: 'audio-clip-a' }],
    audioAssets: [{ id: 'audio-clip-a', trackId: 'audio-a', sourceMediaId: 'source-a', sourceStart: 1, sourceEnd: 2, start: 10, end: 20 }],
  });
  const audioDeleteCaptionIds = audioDeleteState.captions.map(caption => caption.id);
  requireBuildCheck(audioDeleteState.audioAssets.length === 0 &&
      audioDeleteState.captions.some(caption => caption.id === 'other-owner') &&
      audioDeleteState.captions.some(caption => caption.id === 'other-source') &&
      audioDeleteState.captions.some(caption => caption.id === 'same-source-other-placement') &&
      !audioDeleteState.captions.some(caption => caption.id === 'owned-caption' || caption.id === 'ownerless-same-source'),
    `执行真实 Delete 音频路径后，只能移除对应字幕，其他所有者、音源或重复放置位置的文案必须保留。实际字幕：${audioDeleteCaptionIds.join(',')}；素材剩余：${audioDeleteState.audioAssets.length}`);
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

  const cutRouteStart = reviewScript.indexOf('      function cutReviewSegment(id) {');
  const cutRouteEnd = reviewScript.indexOf('      function clearIssueWordFlags(', cutRouteStart);
  requireBuildCheck(cutRouteStart >= 0 && cutRouteEnd > cutRouteStart,
    '单条错误文案切除入口缺失，无法运行 P0 删除回归。');
  const cutRouteState = {
    reviewCaptions: [{ id: 'review-selected', issueId: 'shared-issue', start: 1, end: 4, type: 'mismatch' }],
    issues: [{ id: 'shared-issue', start: 0, end: 8, type: 'mismatch' }],
  };
  const cutRouteCalls = [];
  const cutReviewEntry = vm.runInNewContext(
    `${reviewScript.slice(cutRouteStart, cutRouteEnd)}\ncutReviewSegment;`,
    { state: cutRouteState, cutScriptIssue: (...args) => cutRouteCalls.push(args), deleteRepeatedReview: () => {} },
  );
  cutReviewEntry('review-selected');
  requireBuildCheck(cutRouteCalls.length === 1 && cutRouteCalls[0][0] === 'shared-issue' &&
      cutRouteCalls[0][1]?.scope?.id === 'review-selected' &&
      cutRouteCalls[0][1]?.scope?.start === 1 && cutRouteCalls[0][1]?.scope?.end === 4,
    '单条卡片切除必须把所选 review 的时间和素材范围传到删除执行器，不能扩大成聚合 issue 范围。');
  const repeatReview = { id: 'review-repeat', issueId: 'repeat-issue', type: 'repeat', start: 1, end: 2 };
  const repeatRouteCalls = [];
  const repeatRoute = vm.runInNewContext(
    `${reviewScript.slice(cutRouteStart, cutRouteEnd)}\ncutReviewSegment;`,
    { state: { reviewCaptions: [repeatReview], issues: [] },
      cutScriptIssue: () => {}, deleteRepeatedReview: id => repeatRouteCalls.push(id) },
  );
  repeatRoute('review-repeat');
  requireBuildCheck(repeatRouteCalls.length === 1 && repeatRouteCalls[0] === 'review-repeat',
    '重复片段卡片必须进入专用精确切除与保留字幕检查，不能绕过删除保护。');

  const repeatGuardStart = reviewScript.indexOf('      function repeatCutPreservesCaptionText(');
  const repeatGuardEnd = reviewScript.indexOf('      function captionTextKey(', repeatGuardStart);
  requireBuildCheck(repeatGuardStart >= 0 && repeatGuardEnd > repeatGuardStart,
    '重复片段字幕保护缺失，无法运行 P0 删除回归。');
  const repeatGuard = vm.runInNewContext(
    `${reviewScript.slice(repeatGuardStart, repeatGuardEnd)}\nrepeatCutPreservesCaptionText;`,
    { state: { captions: [{ text: 'only copy', words: [
        { display: 'only', start: 1.2, end: 1.5 },
      ] }] } },
  );
  requireBuildCheck(!repeatGuard(1, 2),
    '重复片段切除如果会删除工程唯一文案，必须由重复专用保护器拒绝。');
  const repeatDeleteStart = reviewScript.indexOf('      function deleteRepeatedReview(');
  const repeatDeleteEnd = reviewScript.indexOf('\n      function ', repeatDeleteStart + 12);
  requireBuildCheck(repeatDeleteStart >= 0 && repeatDeleteEnd > repeatDeleteStart,
    '重复片段删除执行器缺失，无法运行 P0 删除回归。');
  const repeatState = { reviewCaptions: [repeatReview], duration: 10,
    captions: [{ id: 'only-text', text: 'only copy', words: [
      { display: 'only', start: 1.2, end: 1.5 },
    ] }] };
  const repeatEffects = { snapshots: 0, toast: '' };
  const repeatDelete = vm.runInNewContext(
    `${reviewScript.slice(repeatGuardStart, repeatGuardEnd)}\n`+
      `${reviewScript.slice(repeatDeleteStart, repeatDeleteEnd)}\ndeleteRepeatedReview;`,
    { state: repeatState, frameDuration: () => .04,
      snapshot: () => { repeatEffects.snapshots += 1; },
      toast: message => { repeatEffects.toast = message; } },
  );
  repeatDelete('review-repeat');
  requireBuildCheck(repeatEffects.snapshots === 0 && repeatState.captions[0]?.text === 'only copy' &&
      repeatEffects.toast.includes('全部文案'),
    '重复片段实际删除执行器必须在快照前拒绝清空全部文案。');

  const sameMismatchStart = captionReviewScript.indexOf('function sameCaptionMismatchOccurrence(');
  const sameMismatchEnd = captionReviewScript.indexOf('\nfunction ', sameMismatchStart + 10);
  const dedupeMismatchStart = captionReviewScript.indexOf('function dedupeCaptionMismatchReviews(');
  const dedupeMismatchEnd = captionReviewScript.indexOf('\nfunction ', dedupeMismatchStart + 10);
  requireBuildCheck(sameMismatchStart >= 0 && sameMismatchEnd > sameMismatchStart &&
      dedupeMismatchStart > sameMismatchEnd && dedupeMismatchEnd > dedupeMismatchStart,
    '字幕差异去重器缺失，无法检查关联音视频重复提示。');
  const audioMismatchReview = {
    id: 'audio-review', issueId: 'shared-mismatch', type: 'mismatch',
    spokenText: 'and', expectedText: 'in', start: 153.633, end: 153.941,
    captionTrackId: 'caption', transcriptId: 'transcript-1', sourceMediaId: 'same-source',
    ownerClipId: 'linked-audio', ownerClipType: 'audioasset', action: 'replace',
  };
  const videoMismatchReview = {
    ...audioMismatchReview, id: 'video-review', ownerClipId: 'linked-video',
    ownerClipType: 'videolayer', trackId: 'review', captionCorrectionReview: true,
    needsAudioReview: true, action: 'review',
  };
  const separateMismatchReview = {
    ...videoMismatchReview, id: 'separate-review', issueId: 'separate-mismatch',
    ownerClipId: 'separate-video', captionCorrectionReview: false,
  };
  const duplicateMismatchState = { reviewCaptions: [audioMismatchReview, videoMismatchReview, separateMismatchReview],
    captions: [], issues: [], matchIssues: [] };
  const dedupeMismatch = vm.runInNewContext(
    `${captionReviewScript.slice(sameMismatchStart, sameMismatchEnd)}\n`+
      `${captionReviewScript.slice(dedupeMismatchStart, dedupeMismatchEnd)}\ndedupeCaptionMismatchReviews;`,
    { state: duplicateMismatchState,
      captionCorrectionKey: value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() },
  );
  dedupeMismatch();
  const keptLinkedMismatch = duplicateMismatchState.reviewCaptions.find(item => item.issueId === 'shared-mismatch');
  requireBuildCheck(duplicateMismatchState.reviewCaptions.length === 2 &&
      keptLinkedMismatch?.ownerClipId === 'linked-video' && keptLinkedMismatch?.captionCorrectionReview === true &&
      duplicateMismatchState.reviewCaptions.some(item => item.issueId === 'separate-mismatch'),
    '同一个 issueId 的关联音视频只应保留一条待处理提示，并保留字幕所属记录；其他问题不得被合并。');
  const repeatDeleteBody = reviewScript.slice(repeatDeleteStart, repeatDeleteEnd);
  const deferredRenderAt = repeatDeleteBody.indexOf('deleteSelected.deferRender = true');
  const restoredCaptionsAt = repeatDeleteBody.indexOf('state.captions=captionsAfterRepeatCut');
  const finalRepeatRenderAt = repeatDeleteBody.indexOf('renderAll();', deferredRenderAt);
  requireBuildCheck(deferredRenderAt >= 0 &&
      repeatDeleteBody.includes('deleteSelected.onDismissIssues = collectDismissedIssues') &&
      repeatDeleteBody.includes('deleteSelected.deferRender = false') &&
      repeatDeleteBody.includes('deleteSelected.onDismissIssues = null') &&
      restoredCaptionsAt > deferredRenderAt && finalRepeatRenderAt > restoredCaptionsAt,
    '删除重复片段时必须先恢复字幕时间映射、收集并清除已处理的问题标记，再运行字幕复核。');

  const issueHelpersStart = reviewScript.indexOf('      function planIssueWordsRemoval(');
  const issueHelpersEnd = reviewScript.indexOf('      function dismissTrimmedIssues(', issueHelpersStart);
  const cutIssueStart = reviewScript.indexOf('      function cutScriptIssue(id,', issueHelpersEnd);
  // cutScriptIssue is the final function in this source module. Its closing
  // brace is followed only by whitespace, so the rest of the module is its
  // complete standalone body for this VM harness.
  const cutIssueEnd = reviewScript.length;
  requireBuildCheck(issueHelpersStart >= 0 && issueHelpersEnd > issueHelpersStart &&
      cutIssueStart > issueHelpersEnd && cutIssueEnd > cutIssueStart,
    '脚本差异切除执行器缺失，无法运行实际 P0 删除回归。');
  const cutHarnessSource = `${reviewScript.slice(issueHelpersStart, issueHelpersEnd)}\n`+
    `${reviewScript.slice(cutIssueStart, cutIssueEnd)}\ncutScriptIssue;`;
  const makeCutHarness = ({ captions, review, issue }) => {
    const state = { captions: JSON.parse(JSON.stringify(captions)), captionRecoveryArchive: [],
      trackLocks: {}, issues: [structuredClone(issue)], matchIssues: [],
      reviewCaptions: [structuredClone(review), { id: 'review-later', issueId: issue.id,
        start: 5, end: 6, type: issue.type }], audioAssets: [], removals: [], duration: 10 };
    const effects = { snapshots: 0, toasts: [] };
    const context = {
      state, planIssueCaptionRemoval, reviewCaptionWordMatches, reviewCaptionBlockIsCovered,
      joinCaptionWords: words => words.map(word => word.display || word.text || '').filter(Boolean).join(' '),
      mainAudioClips: () => [], timelineToSource: value => value,
      snapshot: () => { effects.snapshots += 1; }, shiftTracks: () => {},
      normalizeRemovals: () => {}, recomputeContentDuration: () => {}, clampTracksToDuration: () => {},
      seekTimeline: () => {}, renderAll: () => {}, queueAutosave: () => {},
      toast: message => effects.toasts.push(message),
    };
    context.removeIssueWords = vm.runInNewContext(
      `${reviewScript.slice(issueHelpersStart, issueHelpersEnd)}\nremoveIssueWords;`, context,
    );
    return { state, effects,
      run: vm.runInNewContext(cutHarnessSource, context) };
  };
  const selectedCutReview = { id: 'review-selected', issueId: 'shared-issue',
    captionTrackId: 'caption-a', ownerClipId: 'clip-a', sourceMediaId: 'source-a',
    start: 1, end: 4, type: 'mismatch', words: [
      { display: 'remove', issueId: 'shared-issue', start: 1.2, end: 1.5 },
    ] };
  const selectedCutIssue = { id: 'shared-issue', issueId: 'shared-issue', type: 'mismatch', start: 0, end: 8 };
  const cutHarness = makeCutHarness({ issue: selectedCutIssue, review: selectedCutReview, captions: [
    { id: 'same-group', trackId: 'caption-a', ownerClipId: 'clip-a', sourceMediaId: 'source-a',
      text: 'before remove after', words: [
        { display: 'before', issueId: 'shared-issue', start: .4, end: .8 },
        { display: 'remove', issueId: 'shared-issue', start: 1.2, end: 1.5 },
        { display: 'after', issueId: 'shared-issue', start: 3.2, end: 3.6 },
      ] },
  ] });
  cutHarness.run('shared-issue', { scope: selectedCutReview });
  requireBuildCheck(cutHarness.state.captions[0]?.words.map(word => word.display).join(' ') === 'before after' &&
      cutHarness.state.removals.length === 1 && cutHarness.state.removals[0].start === 1 &&
      cutHarness.state.removals[0].end === 4 && cutHarness.state.reviewCaptions[0]?.id === 'review-later',
    '实际单条切除回归失败：宽 issue ID/时间不得删除同组未选中的词或其他 review 区间。');

  const wipeHarness = makeCutHarness({ issue: selectedCutIssue,
    review: { ...selectedCutReview, words: [{ display: 'only', issueId: 'shared-issue', start: 1.2, end: 1.5 }] },
    captions: [{ id: 'only-text', trackId: 'caption-a', ownerClipId: 'clip-a', sourceMediaId: 'source-a',
      text: 'only', words: [{ display: 'only', issueId: 'shared-issue', start: 1.2, end: 1.5 }] }],
  });
  wipeHarness.run('shared-issue', { scope: selectedCutReview });
  requireBuildCheck(wipeHarness.effects.snapshots === 0 && wipeHarness.state.removals.length === 0 &&
      wipeHarness.state.captions[0]?.text === 'only' &&
      wipeHarness.effects.toasts.some(message => message.includes('删除全部文案')),
    '单条切除如果会清空全部文案，必须在 snapshot、字幕写回和时间线剪切前取消。');

  const replacementPlanStart = reviewScript.indexOf('      function planReviewCaptionReplacement(');
  const replacementPlanEnd = reviewScript.indexOf('      function replaceReviewCaption(', replacementPlanStart);
  requireBuildCheck(replacementPlanStart >= 0 && replacementPlanEnd > replacementPlanStart,
    '手动修改字幕的精确范围计划器缺失，无法运行 P0 删除回归。');
  const replacementPlan = vm.runInNewContext(
    `${reviewScript.slice(replacementPlanStart, replacementPlanEnd)}\nplanReviewCaptionReplacement;`,
    { editableCaptionTokens: value => String(value || '').split(/\s+/).filter(Boolean),
      matchRecognizedCapitalization: value => value },
  );
  const narrowReplacement = replacementPlan([
    { id: 'same-group', trackId: 'caption-a', ownerClipId: 'clip-a', sourceMediaId: 'source-a',
      words: [
        { display: 'before', issueId: 'shared-issue', start: .4, end: .8 },
        { display: 'wrong', issueId: 'shared-issue', start: 1.2, end: 1.5 },
        { display: 'after', issueId: 'shared-issue', start: 3.2, end: 3.6 },
      ] },
  ], { id: 'review-selected', issueId: 'shared-issue', captionTrackId: 'caption-a',
    ownerClipId: 'clip-a', sourceMediaId: 'source-a', start: 1, end: 4,
    words: [{ display: 'wrong', issueId: 'shared-issue', start: 1.2, end: 1.5 }] }, '', null);
  requireBuildCheck(narrowReplacement?.length === 1 &&
      narrowReplacement[0].words.map(word => word.display).join(' ') === 'before after',
    '手动清除错误文案必须只作用于 review.words 指定的词，不能按重复 issue ID 扩大到其他字幕。');

  const replaceStart = reviewScript.indexOf('      function replaceReviewCaption(');
  const replaceEnd = reviewScript.indexOf('      function batchReviewAction(', replaceStart);
  requireBuildCheck(replaceStart >= 0 && replaceEnd > replaceStart,
    '手动替换字幕执行器缺失，无法运行 P0 删除回归。');
  const lastCaptionState = { captions: [{ id: 'only-text', text: 'only', words: [
    { display: 'only', start: 1.2, end: 1.5 },
  ] }], reviewCaptions: [{ id: 'review-only', start: 1, end: 2 }],
    issues: [], matchIssues: [], trackLocks: {} };
  const lastCaptionEffects = { snapshots: 0, toast: '' };
  const replaceCaption = vm.runInNewContext(
    `${reviewScript.slice(replaceStart, replaceEnd)}\nreplaceReviewCaption;`,
    { state: lastCaptionState, planReviewCaptionReplacement: () => [
        { caption: lastCaptionState.captions[0], words: [] },
      ],
      isTrackLocked: () => false, joinCaptionWords: words => words.map(word => word.display).join(' '),
      snapshot: () => { lastCaptionEffects.snapshots += 1; }, renderAll: () => {}, queueAutosave: () => {},
      toast: message => { lastCaptionEffects.toast = message; } },
  );
  replaceCaption('review-only', 'manual', '');
  requireBuildCheck(lastCaptionEffects.snapshots === 0 && lastCaptionState.captions[0]?.text === 'only' &&
      lastCaptionEffects.toast.includes('删除全部文案'),
    '手动清空最后一条字幕必须在撤销记录和工程写回前取消。');
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
  const scriptCopyKernel=fs.readFileSync(path.join(uiDir,'../script-copy.mjs'),'utf8').replaceAll('export function ','function ');
  const meaningContext=fs.readFileSync(path.join(uiDir,'../caption-meaning-review.mjs'),'utf8').split('export function captionMeaningContext')[1].split('export function parseCaptionMeanings')[0];
  const phraseKernel=fs.readFileSync(path.join(uiDir,'../caption-phrase-reviews.mjs'),'utf8').replaceAll('export function ','function ');
  const mildKernel=fs.readFileSync(path.join(uiDir,'../harmless-caption-correction.mjs'),'utf8').replaceAll('export function ','function ');
  const combinedJs = scriptCopyKernel + reviewDeletionKernel + mildKernel + phraseKernel + editKernel + comparisonKernel + nestedKernel + numericKernel + 'function captionMeaningContext'+meaningContext + scriptFiles
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
