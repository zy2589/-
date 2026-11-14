function addLibraryAsset(media, kind) {
        state.hiddenLibraryPaths = (state.hiddenLibraryPaths || []).filter(
          (item) => item !== media?.path,
        );
        const existing = state.libraryAssets.find(
          (item) => item.path === media.path,
        );
        if (existing) {
          Object.assign(existing, media, {
            kind: kind || media.kind || existing.kind,
          });
          return existing;
        }
        const asset = {
          id: uid(),
          kind: kind || media.kind || "file",
          ...media,
        };
        state.libraryAssets.push(asset);
        return asset;
      }
      function removeLibraryAsset(id) {
        snapshot();
        const removed = state.libraryAssets.find((asset) => asset.id === id);
        if (removed?.path && !(state.hiddenLibraryPaths || []).includes(removed.path))
          state.hiddenLibraryPaths.push(removed.path);
        state.libraryAssets = state.libraryAssets.filter((asset) => asset.id !== id);
        libraryMediaRenderKey = "";
        mediaList();
        queueAutosave();
      }
      function replaceAssetReferences(oldPath, replacement) {
        if (!oldPath || !replacement?.path) return;
        const pathKey = (value) => String(value || "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
        const oldKey = pathKey(oldPath);
        const oldAsset = [state.video, ...state.libraryAssets].find((item) => item?.path && pathKey(item.path) === oldKey);
        const oldAssetId = oldAsset?.id || "";
        const replacingMain = !!state.video && (pathKey(state.video.path) === oldKey || (oldAssetId && state.video.libraryId === oldAssetId));
        pauseForSourceReplacement(oldAsset?.url || "");
        const collections = [
          state.libraryAssets,
          state.videoLayers,
          state.audioAssets,
          state.images,
        ];
        const merge = (item) => {
          if (!item || !(pathKey(item.path) === oldKey || (oldAssetId && [item.libraryId, item.sourceMediaId, item.id].includes(oldAssetId)))) return;
          const identity = { id: item.id, trackId: item.trackId, kind: item.kind || replacement.kind };
          const timeline = Object.fromEntries(["start", "end", "sourceStart", "sourceEnd", "sourceDuration", "x", "y", "scale", "rotation", "opacity", "volume", "spliceRegionId", "spliceCanvasOverlay", "splicePlaybackMode", "spliceFreezeFrame", "spliceFreezeUntil", "color", "fxRack", "libraryId", "sourceMediaId", "linkGroupId"].filter((key) => key in item).map((key) => [key, item[key]]));
          Object.assign(item, replacement, identity, {
            ...timeline,
            missing: false,
            preserveTimelineOnAnalysis: true,
          });
          if ("sourceDuration" in item && Number(replacement.duration) > 0)
            item.sourceDuration = Number(replacement.duration);
        };
        if (state.video?.path === oldPath) merge(state.video);
        for (const collection of collections)
          for (const item of collection || []) merge(item);
        if (replacingMain) {
          state.waveform = replacement.waveform || [];
          state.denoisedAudio = null;
          state.projectCoverPath = "";
          if (Number(replacement.duration) > 0) state.sourceDuration = Number(replacement.duration);
          recomputeContentDuration();
        }
        libraryMediaRenderKey = "";
        renderAll();
        queueAutosave();
      }
      async function refreshSourceAvailability() {
        if (!state.editorActive) return;
        const collections = [
          state.video ? [state.video] : [],
          state.libraryAssets,
          state.videoLayers,
          state.audioAssets,
          state.images,
        ];
        const items = collections.flat().filter((item) => item?.path);
        if (!items.length) return;
        const candidates = items.flatMap((item) => [item.originalPath, item.path]).filter(Boolean);
        const status = await nativeCall("assetAvailability", candidates);
        const availability = new Map(status.map((item) => [item.path, item.exists]));
        let changed = false;
        let recoveredCount = 0;
        for (const item of items) {
          const availableSource = [item.originalPath, item.path]
            .filter(Boolean)
            .find((source) => availability.get(source) === true);
          if (availableSource) {
            if (!item.missing && item.url && item.path === availableSource) continue;
            const extension = String(availableSource).split(".").at(-1).toLowerCase();
            const kind = item.kind || (state.images.includes(item) || ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic"].includes(extension)
              ? "image"
              : state.audioAssets.includes(item) || ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma", "aif", "aiff"].includes(extension)
                ? "audio"
                : state.libraryAssets.includes(item) && ["srt", "vtt", "ass", "ssa", "txt"].includes(extension) ? "subtitle" : "video");
            const action = kind === "image" ? "addImagePath" : kind === "audio" ? "addAudioPath" : kind === "subtitle" ? "addSubtitlePath" : "addVideoPath";
            try {
              const refreshed = await nativeCall(action, { projectId: state.projectId, path: availableSource });
              if (refreshed) {
                const identity = { id: item.id, libraryId: item.libraryId, sourceMediaId: item.sourceMediaId, trackId: item.trackId };
                const timeline = Object.fromEntries(["start", "end", "sourceStart", "sourceEnd", "sourceDuration", "x", "y", "scale", "rotation", "opacity", "volume", "spliceRegionId", "spliceCanvasOverlay", "splicePlaybackMode", "spliceFreezeFrame", "spliceFreezeUntil", "color", "fxRack", "linkGroupId"].filter((key) => key in item).map((key) => [key, item[key]]));
                Object.assign(item, refreshed, identity, timeline, { missing: false });
                changed = true;
                recoveredCount += 1;
              }
            } catch (error) {
              console.warn("素材路径可用，但媒体预览恢复失败", item.path, error);
            }
            if (item.missing) { item.missing = false; changed = true; recoveredCount += 1; }
            continue;
          }
          if (item.missing) continue;
          item.missing = true;
          item.url = "";
          item.previewUrl = "";
          item.previewPath = "";
          changed = true;
        }
        if (!changed) return;
        if (state.video?.missing) {
          $("video").removeAttribute("src");
          $("video").load?.();
          $("stage").classList.add("empty");
          state.projectCoverPath = "";
        }
        libraryMediaRenderKey = "";
        renderAll();
        queueAutosave();
        const missingCount = items.filter((item) => item.missing).length;
        if (missingCount) toast(`检测到 ${missingCount} 个素材文件缺失，可在素材区右键重新关联。`);
        else if (recoveredCount) toast(`已恢复 ${recoveredCount} 条素材关联。`);
      }
      let relinkInProgress = false;
      async function relinkLibraryAssetDirect(asset) {
        if (!asset?.path || relinkInProgress) return false;
        const projectId = state.projectId, oldPath = asset.path, assetId = asset.id;
        const sessionRevision = currentProjectSessionRevision();
        relinkInProgress = true;
        try {
          const replacement = await nativeCall("relinkAsset", { projectId, kind: asset.kind || "video" });
          if (!replacement) return false;
          if (state.projectId !== projectId || currentProjectSessionRevision() !== sessionRevision || !state.editorActive || asset.path !== oldPath || asset.id !== assetId) return false;
          snapshot();
          replaceAssetReferences(oldPath, replacement);
          watchMediaAnalysis(replacement);
          toast(`已重新关联：${replacement.name || replacement.path.split(/[\\/]/).at(-1)}`);
          return true;
        } catch (error) {
          toast(`重新关联失败：${error.message}`);
          return false;
        } finally {
          relinkInProgress = false;
        }
      }
      async function relinkLibraryAsset(asset) {
        if (!asset?.path || relinkInProgress) return false;
        const projectId = state.projectId, oldPath = asset.path;
        const sessionRevision = currentProjectSessionRevision();
        relinkInProgress = true;
        try {
          const candidates = [asset, state.video, ...state.libraryAssets, ...state.videoLayers, ...state.audioAssets, ...state.images].filter(item => item?.path && (item === asset || item.missing));
          const assets = [...new Map([...candidates].reverse().map(item => [item.path, {path:item.path, originalPath:item.originalPath,kind:item.kind || 'video',sourceIdentity:item.sourceIdentity}])).values()];
          toast("选择文件夹后将自动搜索子文件夹，匹配所有丢失素材");
          const result = await nativeCall("relinkAssetsInFolder", {projectId, assets});
          if (!result) return false;
          if (state.projectId !== projectId || currentProjectSessionRevision() !== sessionRevision || !state.editorActive || asset.path !== oldPath) {
            toast("工程或素材已切换，本次重新关联未应用");
            return false;
          }
          const matched = result.results.filter(row => row.replacement);
          if (matched.length) snapshot();
          for (const row of matched) {
            replaceAssetReferences(row.oldPath, row.replacement);
            watchMediaAnalysis(row.replacement);
          }
          const unresolved=result.results.filter(row => !row.replacement);
          const summary=`已关联 ${matched.length} 个素材，未匹配 ${unresolved.length} 个。`;
          toast(summary);
          if(unresolved.length) alert(summary+'\n'+unresolved.map(row => `${row.name}：${row.status === 'ambiguous' ? '多个同名候选，请选择更具体的文件夹' : row.status === 'invalid' ? row.error : '未找到名称及大小匹配的文件'}`).join('\n'));
          return matched.length > 0;
        } catch (error) {
          toast(`重新关联失败：${error.message}`);
          return false;
        } finally {
          relinkInProgress = false;
        }
      }
      const mediaAnalysisWatchers = new Set();
      function applyMediaAnalysisResult(filePath, result, jobId = "") {
        if (!filePath || !result) return;
        const matches = (item) => item?.path === filePath &&
          (!jobId || !item.analysisJobId || item.analysisJobId === jobId);
        const collections = [
          state.libraryAssets,
          state.videoLayers,
          state.audioAssets,
        ];
        for (const collection of collections)
          for (const item of collection || [])
            if (matches(item)) {
              const waiting = !!item.analysisPending;
              Object.assign(item, result, { analysisPending: false });
              if (waiting && !item.preserveTimelineOnAnalysis && Number(result.duration || 0) > 0 && "start" in item) {
                item.sourceDuration = Number(result.duration);
                item.end = Number(item.start || 0) +
                  Number(result.duration) / Math.max(0.5, Number(state.audio.speed || 1));
              }
            }
        // A video is placed immediately; when background probing confirms it
        // has audio, create the linked audio layer without making the user wait.
        for (const item of state.videoLayers || []) {
          if (
            !matches(item) ||
            !result.audioCodec ||
            item.linkedAudioId ||
            state.audioAssets.some((audio) => audio.linkedVideoId === item.id)
          )
            continue;
          const trackId = createDynamicTrack(
            "audio",
            `${item.name || "视频"} · 音频`,
            "audio",
          );
          const audioItem = {
            id: uid(),
            trackId,
            libraryId: item.libraryId,
            path: item.path,
            url: item.url,
            name: `${item.name || "视频"} · 音频`,
            start: item.start,
            end: item.end,
            sourceStart: item.sourceStart || 0,
            sourceDuration: item.sourceDuration || result.duration,
            volume: 1,
            pan: 0,
            muted: false,
            linkedVideoId: item.id,
            linkGroupId: item.linkGroupId,
            waveform: result.waveform || [],
            previewPath: result.previewPath || "",
            previewUrl: result.previewUrl || "",
          };
          item.linkedAudioId = audioItem.id;
          state.audioAssets.push(audioItem);
        }
        if (matches(state.video)) {
          Object.assign(state.video, result, { analysisPending: false });
          state.waveform = result.waveform || state.waveform || [];
          state.sourceDuration = Number(result.duration || state.sourceDuration || 0);
          recomputeContentDuration();
        }
        if (matches(state.denoisedAudio))
          Object.assign(state.denoisedAudio, result);
        libraryMediaRenderKey = "";
        mediaList();
        scheduleTimelineRender();
        schedulePreviewRender();
        queueAutosave();
      }
      async function watchMediaAnalysis(asset) {
        const jobId = asset?.analysisJobId;
        if (!jobId || mediaAnalysisWatchers.has(jobId)) return;
        mediaAnalysisWatchers.add(jobId);
        const filePath = asset.path;
        let previewApplied = !!asset.previewUrl;
        let metadataApplied = false;
        try {
          while (true) {
            await new Promise((resolve) => setTimeout(resolve, 520));
            const job = await nativeCall("mediaAnalysisStatus", jobId);
            if (!metadataApplied && Number(job.result?.frameRate) > 0) {
              metadataApplied = true;
              applyMediaAnalysisResult(filePath, job.result, jobId);
            }
            if (!previewApplied && job.result?.previewUrl) {
              previewApplied = true;
              applyMediaAnalysisResult(filePath, job.result, jobId);
            }
            if (job.state === "completed") {
              applyMediaAnalysisResult(filePath, job.result || {}, jobId);
              break;
            }
            if (job.state === "failed") break;
          }
        } catch (error) {
          console.warn("media analysis", error);
        } finally {
          mediaAnalysisWatchers.delete(jobId);
        }
      }
      function watchProjectMediaAnalysis() {
        const assets = [
          state.video,
          state.denoisedAudio,
          ...(state.videoLayers || []),
          ...(state.audioAssets || []),
        ];
        for (const asset of assets) watchMediaAnalysis(asset);
      }
      function parseSubtitleTime(value) {
        const match = String(value || "")
          .trim()
          .match(/(\d+):([0-5]\d):([0-5]\d)[,.](\d{1,3})/);
        if (!match) return 0;
        return (
          Number(match[1]) * 3600 +
          Number(match[2]) * 60 +
          Number(match[3]) +
          Number(match[4].padEnd(3, "0")) / 1000
        );
      }
      function parseSubtitleContent(content) {
        const normalized = String(content || "")
          .replace(/^WEBVTT[^\n]*\n+/i, "")
          .replace(/\r/g, "");
        const blocks = normalized.split(/\n{2,}/);
        const items = [];
        for (const block of blocks) {
          const lines = block.split("\n").filter(Boolean);
          const timeIndex = lines.findIndex((line) => line.includes("-->"));
          if (timeIndex < 0) continue;
          const [startText, endText] = lines[timeIndex].split("-->");
          const text = lines
            .slice(timeIndex + 1)
            .join(" ")
            .replace(/<[^>]+>/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (!text) continue;
          const start = parseSubtitleTime(startText),
            end = parseSubtitleTime(endText);
          if (end > start) items.push({ id: uid(), start, end, text });
        }
        return items;
      }
      function resetMainMediaModifiers() {
        state.mainTimelineOffset = 0;
        state.mainAudioTimelineOffset = 0;
        state.mainVideoClipOffsets = {};
        state.mainAudioClipOffsets = {};
        state.mainAudioRemovals = [];
        state.mainAudioManualCuts = [];
        state.audioCuts = [];
        state.projectCoverPath = "";
        state.videoTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" };
        state.mainVideoClipSettings = {};
        state.color = {
          exposure: 0,
          contrast: 0,
          pivot: 0,
          lift: 0,
          gamma: 0,
          gain: 0,
          shadows: 0,
          highlights: 0,
          blacks: 0,
          whites: 0,
          saturation: 0,
          temperature: 0,
          tint: 0,
          vibrance: 0,
          hue: 0,
          midtoneDetail: 0,
          sharpness: 0,
          fade: 0,
          vignette: 0,
          slices: defaultColorSlices(),
        };
        state.beauty = {
          smoothing: 0,
          blemish: 0,
          texture: 0,
          whitening: 0,
          brighten: 0,
          warmth: 0,
          rosy: 0,
        };
        state.denoise = defaultDenoiseSettings();
        state.denoiseEnabled = false;
        state.denoisedAudio = null;
        state.audio = {
          speed: 1,
          volume: 1,
          pan: 0,
          bass: 0,
          treble: 0,
          compressor: 0.35,
          limiter: true,
          offset: 0,
          channelMode: "original",
          presence: 0,
          deesser: 0,
          voiceEnhance: 0,
          normalize: false,
          lowCut: 60,
          highCut: 16500,
        };
        state.mainAudioClipSettings = {};
        state.audioProcessingEnabled = false;
        state.mainVideoTrackMap = {};
        state.mainAudioTrackMap = {};
        state.colorBypass = false;
        state.beautyBypass = false;
      }
      function normalizedTimelineEditMode(value = state.timelineEditMode) {
        return ["overwrite", "insert", "place-on-top"].includes(value)
          ? value
          : "overwrite";
      }
      function timelineDropMessage(mode, trackId, kind = "素材") {
        const action = mode === "insert" ? "已插入" : mode === "place-on-top" ? "已置于顶层" : "已覆盖";
        return `${action}${kind}到 ${trackBadgeText(trackId, trackInfo(trackId))}`;
      }
      function pairedAudioTrackForVideo(videoTrackId, label = "视频音频") {
        const videoTracks = (state.trackOrder || []).filter((id) => trackInfo(id).kind === "video");
        const videoIndex = videoTracks.indexOf(videoTrackId);
        const number = videoIndex >= 0 ? videoTracks.length - videoIndex : 1;
        let audioTracks = (state.trackOrder || []).filter((id) => trackInfo(id).kind === "audio");
        while (audioTracks.length < number) {
          createDynamicTrack("audio", label, "audio");
          audioTracks = (state.trackOrder || []).filter((id) => trackInfo(id).kind === "audio");
        }
        return audioTracks[audioTracks.length - number] || "audio";
      }
      function timelineTrackIsFree(trackId, start, end) {
        const placement = { start: Number(start) || 0, end: Math.max(Number(start) || 0, Number(end) || 0) };
        return !trackItems(trackId).some((item) => clipsOverlapOnTrack(item, placement));
      }
      function placeOnTopVideoTrack(anchorTrackId, start, end, label) {
        const family = (state.trackOrder || []).filter((id) => trackInfo(id).kind === "video");
        const anchor = family.includes(anchorTrackId) ? anchorTrackId : "video";
        const anchorIndex = family.indexOf(anchor);
        const tracksAbove = family.slice(0, Math.max(0, anchorIndex)).reverse();
        for (const trackId of tracksAbove) {
          if (!isTrackLocked(trackId) && timelineTrackIsFree(trackId, start, end)) return trackId;
        }
        return createDynamicTrack("video", label, "video");
      }
      function placeSpliceImageOverlayTrack(start, end, label = "图片覆盖层") {
        const family = (state.trackOrder || []).filter((id) => trackInfo(id).kind === "video");
        const topVideoTrack = family[0] || "video";
        return !isTrackLocked(topVideoTrack) && timelineTrackIsFree(topVideoTrack, start, end)
          ? topVideoTrack
          : createDynamicTrack("video", label, topVideoTrack);
      }
      function prepareTimelineDrop(kind, start, end, preferredTrackId = "", mode = state.timelineEditMode, label = "", linkedAudio = false) {
        const normalizedMode = normalizedTimelineEditMode(mode);
        const effectiveMode = kind !== "video" && normalizedMode === "place-on-top"
          ? "overwrite"
          : normalizedMode;
        const requestedTrack = preferredTrackId || (
          ["video", "audio"].includes(kind) && effectiveMode !== "place-on-top"
            ? createDynamicTrack(kind, label || (kind === "audio" ? "音频" : "视频"), kind)
            : kind
        );
        const resolvedRequestedTrack = trackInfo(requestedTrack).kind === kind
          ? requestedTrack
          : kind === "caption" ? "caption" : createDynamicTrack(kind, label || (kind === "audio" ? "音频" : "视频"), kind);
        if (isTrackLocked(resolvedRequestedTrack)) {
          toast("目标轨道已锁定，请先解锁后再编辑。");
          return null;
        }
        const trackId = effectiveMode === "place-on-top"
          ? placeOnTopVideoTrack(resolvedRequestedTrack, start, end, label || "置顶视频")
          : resolvedRequestedTrack;
        if (!trackId || isTrackLocked(trackId)) {
          toast("没有可编辑的目标轨道，请先解锁或新增轨道。");
          return null;
        }
        const pairedAudioTrackId = kind === "video" && linkedAudio
          ? pairedAudioTrackForVideo(trackId, `${label || "视频"} · 音频`)
          : "";
        if (effectiveMode === "insert") {
          const rippleTargets = [trackId];
          if (pairedAudioTrackId && !isTrackLocked(pairedAudioTrackId)) rippleTargets.push(pairedAudioTrackId);
          applyEditRipple(start, Math.max(0.04, end - start), [], rippleTargets);
        } else if (effectiveMode === "overwrite" && ["video", "audio"].includes(kind)) {
          // Convert the special main source timeline into independently editable
          // clips before overwriting a chosen V/A row.
          materializeTimelineMedia();
        }
        return { trackId, mode: effectiveMode, pairedAudioTrackId };
      }
      async function importVideo(
        info = null,
        placement = "timeline",
        at = state.currentTime,
        preferredTrackId = "",
        spliceRegionId = "",
        editMode = state.timelineEditMode,
        duration = 3,
      ) {
        try {
          const media =
            info ||
            (await nativeCall("pickVideo", { projectId: state.projectId }));
          if (!media) return;
          if (placement !== "media" && preferredTrackId && trackInfo(preferredTrackId).kind !== "video") preferredTrackId = "";
          const asset = addLibraryAsset(media, "video");
          watchMediaAnalysis(asset);
          if (placement === "media") {
            renderAll();
            toast("视频已加入素材区，可拖到预览窗口或时间线");
            return asset;
          }
          snapshot();
          if (state.video || placement === "timeline") {
            const start = clamp(Number(at) || 0, 0, visibleTimelineDuration());
            const sourceDuration = Math.max(0.04, Number(asset.duration || 3));
            const end = start + sourceDuration / Math.max(0.5, Number(state.audio.speed || 1));
            const timelineDrop = placement === "timeline" && !spliceRegionId
              ? prepareTimelineDrop("video", start, end, preferredTrackId, editMode, asset.name || "视频轨道", !!asset.audioCodec)
              : null;
            const trackId = timelineDrop?.trackId || (placement === "timeline" && !spliceRegionId
              ? ""
              : resolveTrackForInsert("video", start, end, preferredTrackId, asset.name || "视频轨道"));
            if (!trackId) return;
            const pairedAudioTrackId = asset.audioCodec
              ? (timelineDrop
                  ? timelineDrop.pairedAudioTrackId
                  : resolveTrackForInsert("audio", start, end, "", `${asset.name || "视频"} · 音频`))
              : "";
            const linkGroupId = uid();
            const item = {
              id: uid(),
              trackId,
              libraryId: asset.id,
              path: asset.path,
              url: asset.url,
              playbackAudioPath: asset.playbackAudioPath || "",
              playbackAudioUrl: asset.playbackAudioUrl || "",
              name: asset.name,
              start,
              end,
              sourceStart: 0,
              sourceDuration,
              linkGroupId,
              x: 0,
              y: 0,
              scale: 1,
              opacity: 1,
              rotation: 0,
              blendMode: "normal",
              volume: 1,
              previewPath: asset.previewPath || "",
              previewUrl: asset.previewUrl || "",
              waveform: asset.waveform || [],
              width: Number(asset.width || 0),
              height: Number(asset.height || 0),
              videoCodec: asset.videoCodec || "",
              audioCodec: asset.audioCodec || "",
              analysisPending: !!asset.analysisPending,
              ...(spliceRegionId ? { spliceRegionId } : {}),
            };
            state.videoLayers.push(item);
            if (spliceRegionId) state.spliceSelectedRegionId = spliceRegionId;
            if (asset.audioCodec && pairedAudioTrackId && !isTrackLocked(pairedAudioTrackId)) {
              const audioTrackId = pairedAudioTrackId;
              if (!audioTrackId) return;
              const audioItem = {
                id: uid(),
                trackId: audioTrackId,
                libraryId: asset.id,
                path: asset.path,
                url: asset.url,
              playbackAudioPath: asset.playbackAudioPath || "",
              playbackAudioUrl: asset.playbackAudioUrl || "",
                name: `${asset.name || "视频"} · 音频`,
                start,
                end: item.end,
                sourceStart: 0,
                sourceDuration,
                volume: 1,
                pan: 0,
                fadeIn: 0,
                fadeOut: 0,
                muted: false,
                linkedVideoId: item.id,
                linkGroupId,
                waveform: asset.waveform || [],
                previewPath: asset.previewPath || "",
                previewUrl: asset.previewUrl || "",
              };
              item.linkedAudioId = audioItem.id;
              state.audioAssets.push(audioItem);
              if (timelineDrop?.mode === "overwrite") applyOverlayTrackOverwrite("audioasset", audioItem, { overwriteMain: true });
            } else if (asset.audioCodec && pairedAudioTrackId && isTrackLocked(pairedAudioTrackId)) {
              toast("视频已加入；对应音频轨已锁定，因此没有添加音频。");
            }
            if (timelineDrop?.mode === "overwrite") applyOverlayTrackOverwrite("videolayer", item, { overwriteMain: true });
            recomputeContentDuration();
            state.selected = { type: "videolayer", id: item.id };
            state.selectedItems = [{ type: "videolayer", id: item.id }];
            seekTimeline(start);
            renderAll();
            toast(timelineDrop ? timelineDropMessage(timelineDrop.mode, trackId, "视频") : "视频已加入时间线");
            return asset;
          }
          resetMainMediaModifiers();
          state.video = { ...asset };
          if(!state.timelineFrameRate)state.timelineFrameRate=Number(asset.frameRate||30);
          state.sourceDuration = Number(asset.duration || 0);
          state.duration =
            state.sourceDuration /
            Math.max(0.5, Number(state.audio.speed || 1));
          state.timelineDuration = Math.max(60, state.duration + 10);
          state.removals = [];
          state.manualCuts = [];
          state.mainAudioRemovals = [];
          state.mainAudioManualCuts = [];
          state.audioMutes = [];
          state.waveform = asset.waveform || [];
          state.captions = [];
          state.autoTranscript = null;
          state.recognizedText = ""; state.recognizedTextCleared = false;
          state.reviewCaptions = [];
          state.issues = [];
          state.currentTime = 0;
          if (preferredTrackId && preferredTrackId !== "video") {
            const firstClip = activeMainVideoClip();
            if (firstClip) state.mainVideoTrackMap[firstClip.id] = preferredTrackId;
          }
          if (spliceRegionId) {
            const firstClip = activeMainVideoClip();
            if (firstClip) mainVideoSettings(firstClip).spliceRegionId = spliceRegionId;
            state.spliceSelectedRegionId = spliceRegionId;
          }
          state.selected = { type: "video", id: "main" };
          state.selectedItems = [{ type: "video", id: "main" }];
          $("video").src = asset.url;
          $("stage").classList.remove("empty");
          renderAll();
          toast("视频已加入时间线；需要时点击“自动剪停顿”");
          return asset;
        } catch (e) {
          toast(e.message);
        }
      }
      async function importImage(
        info = null,
        placement = "timeline",
        at = state.currentTime,
        preferredTrackId = "",
        spliceRegionId = "",
        editMode = state.timelineEditMode,
        duration = 3,
      ) {
        try {
          const media =
            info ||
            (await nativeCall("pickImage", { projectId: state.projectId }));
          if (!media) return;
          if (placement !== "media" && preferredTrackId && trackInfo(preferredTrackId).kind !== "video") preferredTrackId = "";
          const asset = info?.id && info.kind === "image"
            ? info
            : addLibraryAsset(media, "image");
          if (placement === "media") {
            renderAll();
            toast("图片已加入素材区，可继续拖到画面或时间线");
            return asset;
          }
          snapshot();
          const captureSettings = asset.spliceCaptureSettings || {};
          const spliceCanvasOverlay = window.__clipAssistantWorkspaceMode === "splice" && placement !== "gap";
          const targetRegionId = spliceCanvasOverlay
            ? ""
            : placement === "preview" ? "" : spliceRegionId || captureSettings.spliceRegionId || "";
          const start = clamp(Number(at) || 0, 0, visibleTimelineDuration());
          const clipDuration = Math.max(frameDuration(), Number(duration) || 3);
          const fullCanvasOverlay = spliceCanvasOverlay && placement === "preview";
          const timelineDrop = placement === "timeline"
            ? spliceCanvasOverlay
              ? { trackId: placeSpliceImageOverlayTrack(start, start + clipDuration), mode: "place-on-top" }
              : prepareTimelineDrop("video", start, start + clipDuration, preferredTrackId, editMode, asset.name || "图片")
            : null;
          let trackId = timelineDrop?.trackId || (placement === "timeline" || fullCanvasOverlay
            ? ""
            : resolveTrackForInsert("video", start, start + clipDuration, preferredTrackId, asset.name || "视频轨道"));
          if (fullCanvasOverlay) {
            trackId = placeSpliceImageOverlayTrack(start, start + clipDuration, asset.name || "图片覆盖层");
          }
          if (!trackId) return;
          const item = {
            id: uid(),
            trackId,
            libraryId: asset.id,
            path: asset.path,
            url: asset.url,
              playbackAudioPath: asset.playbackAudioPath || "",
              playbackAudioUrl: asset.playbackAudioUrl || "",
            name: asset.name,
            start,
            end: start + clipDuration,
            x: Number(captureSettings.x || 0),
            y: Number(captureSettings.y || 0),
            scale: Number(captureSettings.scale || 1),
            opacity: Number(captureSettings.opacity ?? 1),
            rotation: Number(captureSettings.rotation || 0),
            blendMode: captureSettings.blendMode || "normal",
            cropTop: Number(captureSettings.cropTop || 0),
            cropBottom: Number(captureSettings.cropBottom || 0),
            cropLeft: Number(captureSettings.cropLeft || 0),
            cropRight: Number(captureSettings.cropRight || 0),
            enterAnimation: "",
            exitAnimation: "",
            enterDuration: 0.45,
            exitDuration: 0.45,
            ...(spliceCanvasOverlay ? { spliceCanvasOverlay: true } : {}),
            ...(targetRegionId ? { spliceRegionId: targetRegionId } : {}),
          };
          const imgTester = new Image();
          imgTester.src = asset.url;
          imgTester.onload = () => {
            item.sourceWidth = imgTester.naturalWidth;
            item.sourceHeight = imgTester.naturalHeight;
            renderPreviewObjects();
          };
          state.images.push(item);
          if (timelineDrop?.mode === "overwrite") applyOverlayTrackOverwrite("image", item, { overwriteMain: true });
          if (targetRegionId) state.spliceSelectedRegionId = targetRegionId;
          recomputeContentDuration();
          state.selected = { type: "image", id: item.id };
          state.selectedItems = [{ type: "image", id: item.id }];
          seekTimeline(item.start);
          renderAll();
          if (timelineDrop) toast(timelineDropMessage(timelineDrop.mode, trackId, "图片"));
          return asset;
        } catch (e) {
          toast(e.message);
        }
      }
      async function importAudio(
        info = null,
        placement = "timeline",
        at = state.currentTime,
        preferredTrackId = "",
        editMode = state.timelineEditMode,
      ) {
        try {
          const media =
            info ||
            (await nativeCall("pickAudio", { projectId: state.projectId }));
          if (!media) return;
          if (placement !== "media" && preferredTrackId && trackInfo(preferredTrackId).kind !== "audio") preferredTrackId = "";
          const asset = addLibraryAsset(media, "audio");
          watchMediaAnalysis(asset);
          if (placement === "media") {
            renderAll();
            toast("音频已加入素材区，可继续拖到时间线");
            return asset;
          }
          snapshot();
          const start = clamp(Number(at) || 0, 0, visibleTimelineDuration()),
            end = start + Number(asset.duration || 3) / Math.max(0.5, Number(state.audio.speed || 1));
          const timelineDrop = placement === "timeline"
            ? prepareTimelineDrop("audio", start, end, preferredTrackId, editMode, asset.name || "音频轨道")
            : null;
          const trackId = timelineDrop?.trackId || (placement === "timeline"
            ? ""
            : resolveTrackForInsert("audio", start, end, preferredTrackId, asset.name || "音频轨道"));
          if (!trackId) return;
          const
            item = {
              id: uid(),
              trackId,
              libraryId: asset.id,
              path: asset.path,
              url: asset.url,
              playbackAudioPath: asset.playbackAudioPath || "",
              playbackAudioUrl: asset.playbackAudioUrl || "",
              name: asset.name,
              start,
            end,
              sourceStart: 0,
              sourceDuration: Number(asset.duration || 3),
              volume: 1,
              pan: 0,
              fadeIn: 0,
              fadeOut: 0,
              muted: false,
              waveform: asset.waveform || [],
              previewPath: asset.previewPath || "",
              previewUrl: asset.previewUrl || "",
              analysisPending: !!asset.analysisJobId || !!asset.analysisPending,
            };
          state.audioAssets.push(item);
          if (timelineDrop?.mode === "overwrite") applyOverlayTrackOverwrite("audioasset", item, { overwriteMain: true });
          recomputeContentDuration();
          state.selected = { type: "audioasset", id: item.id };
          state.selectedItems = [{ type: "audioasset", id: item.id }];
          seekTimeline(start);
          renderAll();
          if (timelineDrop) toast(timelineDropMessage(timelineDrop.mode, trackId, "音频"));
          return asset;
        } catch (e) {
          toast(e.message);
        }
      }
      async function importSubtitle(
        info = null,
        placement = "timeline",
        at = state.currentTime,
        preferredTrackId = "",
        editMode = state.timelineEditMode,
      ) {
        try {
          const media =
            info ||
            (await nativeCall("pickSubtitle", { projectId: state.projectId }));
          if (!media) return;
          if (placement !== "media" && preferredTrackId && trackInfo(preferredTrackId).kind !== "caption") {
            toast("字幕素材请拖到字幕轨道。");
            return;
          }
          const asset = addLibraryAsset(media, "subtitle");
          if (placement === "media") {
            renderAll();
            toast("字幕文件已加入素材区，可继续拖到时间线");
            return asset;
          }
          const parsed = parseSubtitleContent(asset.content);
          if (!parsed.length) {
            toast("没有识别到有效的 SRT 或 VTT 字幕");
            return asset;
          }
          snapshot();
          const offset = (Number(at) || 0) - parsed[0].start;
          const targetStart = parsed[0].start + offset;
          const targetEnd = parsed.at(-1).end + offset;
          const timelineDrop = placement === "timeline"
            ? prepareTimelineDrop("caption", targetStart, targetEnd, preferredTrackId, editMode, asset.name || "字幕轨道")
            : null;
          const trackId = timelineDrop?.trackId || (placement === "timeline"
            ? ""
            : resolveTrackForInsert("caption", targetStart, targetEnd, preferredTrackId, asset.name || "字幕轨道"));
          if (!trackId) return;
          if (timelineDrop?.mode === "overwrite") {
            const sameTrack = state.captions.filter((item) => (item.trackId || "caption") === trackId);
            const otherTracks = state.captions.filter((item) => (item.trackId || "caption") !== trackId);
            state.captions = [...otherTracks, ...overwriteEditableClips(sameTrack, targetStart, targetEnd)];
          }
          for (const caption of parsed) {
            const start = Math.max(0, caption.start + offset),
              end = caption.end + offset;
            if (end > start)
              state.captions.push({
                ...caption,
                id: uid(),
                trackId,
                start,
                end,
                text: caption.text.replace(/\s+/g, " "),
              });
          }
          state.captions.sort((a, b) => a.start - b.start);
          recomputeContentDuration();
          const first = state.captions.find((item) => item.trackId === trackId);
          state.selected = { type: "caption", id: first?.id || "" };
          state.selectedItems = first ? [{ type: "caption", id: first.id }] : [];
          renderAll();
          toast(`已加入 ${parsed.length} 条字幕`);
          return asset;
        } catch (e) {
          toast(e.message);
        }
      }
      async function importMedia(placement = "media", at = state.currentTime, preferredTrackId = "", editMode = state.timelineEditMode) {
        try {
          const items = await nativeCall("pickMedia", { projectId: state.projectId });
          if (!Array.isArray(items) || !items.length) return;
          let imported = 0;
          for (const item of items) {
            if (!item) continue;
            if (item.kind === "video") await importVideo(item, placement, at, preferredTrackId, "", editMode);
            else if (item.kind === "audio") await importAudio(item, placement, at, preferredTrackId, editMode);
            else if (item.kind === "image") await importImage(item, placement, at, preferredTrackId, "", editMode);
            else if (item.kind === "subtitle") await importSubtitle(item, placement, at, preferredTrackId, editMode);
            else continue;
            imported += 1;
          }
          if (placement === "media" && imported)
            toast(`已导入 ${imported} 个素材，均保持原文件关联`);
        } catch (error) {
          toast(error.message);
        }
      }
      if ($("importMediaButton")) $("importMediaButton").onclick = () => importMedia("media");
      if ($("dropzone")) $("dropzone").onclick = (event) => {
        if (event.target.closest("button")) return;
        void importMedia("media");
      };
