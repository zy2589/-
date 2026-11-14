function persistedMediaItem(item, preserveWaveform = false) {
        if (!item) return item;
        const copy = { ...item };
        if (preserveWaveform) copy.waveform = compactWaveform(copy.waveform);
        else delete copy.waveform;
        delete copy.analysisJobId;
        return copy;
      }
      function projectData(forHistory = false) {
        const preservedWaveforms = new Set();
        const mediaWithWaveform = (item) => {
          if (!item) return item;
          const hasWaveform = Array.isArray(item.waveform) && item.waveform.length > 0;
          const key = String(item.path || item.id || "");
          const preserve = hasWaveform && (!key || !preservedWaveforms.has(key));
          if (preserve && key) preservedWaveforms.add(key);
          return persistedMediaItem(item, preserve);
        };
        const video = forHistory
          ? persistedMediaItem(state.video)
          : mediaWithWaveform(state.video);
        const videoLayers = state.videoLayers.map((item) => mediaWithWaveform(item));
        const audioAssets = state.audioAssets.map((item) => mediaWithWaveform(item));
        const libraryAssets = state.libraryAssets.map((item) => persistedMediaItem(item));
        // Main source waveform is already stored at the project root. Avoid
        // serializing another full copy on the root video item.
        if (video && !forHistory) delete video.waveform;
        return {
          projectId: state.projectId,
          projectName: state.projectName,
          timelineFrameRate:timelineFrameRate(),
          projectPath: state.projectPath,
          video,
          videoLayers,
          libraryAssets,
          hiddenLibraryPaths: state.hiddenLibraryPaths,
          audioAssets,
          images: state.images,
          titles: state.titles,
          captions: state.captions,
          autoTranscript: state.autoTranscript || null,
          recognizedText: state.recognizedText || "", recognizedTextCleared: !!state.recognizedTextCleared,
          captionRecoveryArchive: state.captionRecoveryArchive || [],
          compoundClips: state.compoundClips || [],
          auxSubtitles: state.auxSubtitles,
          reviewCaptions: state.reviewCaptions,
          issues: state.issues,
          matchIssues: state.matchIssues,
          alignmentOperations: state.alignmentOperations,
          alignmentDuration: state.alignmentDuration,
          removals: state.removals,
          manualCuts: state.manualCuts,
          audioMutes: state.audioMutes,
          audioCuts: state.audioCuts,
          mainAudioRemovals: state.mainAudioRemovals,
          mainAudioManualCuts: state.mainAudioManualCuts,
          ...(forHistory ? {} : {waveform: compactWaveform(state.waveform)}),
          sourceDuration: state.sourceDuration,
          duration: state.duration,
          timelineDuration: state.timelineDuration,
          mainTimelineOffset: state.mainTimelineOffset,
          mainAudioTimelineOffset: state.mainAudioTimelineOffset,
          mainVideoClipOffsets: state.mainVideoClipOffsets,
          mainAudioClipOffsets: state.mainAudioClipOffsets,
          mainVideoClipSettings: state.mainVideoClipSettings,
          currentTime: state.currentTime,
          zoom: state.zoom,
          ratio: state.ratio,
          width: state.width,
          height: state.height,
          videoTransform: state.videoTransform,
          captionTransform: state.captionTransform,
          trackOrder: state.trackOrder,
          trackDefinitions: state.trackDefinitions,
          spliceLayout: state.spliceLayout || "free",
          spliceRegions: Array.isArray(state.spliceRegions) ? state.spliceRegions : [],
          spliceRatio: Number(state.spliceRatio || 0.5),
          spliceAngle: Number(state.spliceAngle || 0),
          spliceSelectedRegionId: state.spliceSelectedRegionId || "",
          spliceMainRegionId: state.spliceMainRegionId || "",
          mainVideoTrackMap: state.mainVideoTrackMap,
          mainAudioTrackMap: state.mainAudioTrackMap,
          trackVisibility: state.trackVisibility,
          trackLocks: state.trackLocks,
          trackHeights: state.trackHeights,
          trackSolo: state.trackSolo,
          trackMute: state.trackMute,
          trackAutoSelect: state.trackAutoSelect,
          trackSyncLocks: state.trackSyncLocks,
          avLinked: state.avLinked,
          snapping: state.snapping,
          selectionFollowsPlayhead: state.selectionFollowsPlayhead,
          timelineEditMode: state.timelineEditMode || "overwrite",
          timelineMarkers: state.timelineMarkers,
          captionLines: state.captionLines,
          naturalCaptionPunctuation: !!state.naturalCaptionPunctuation,
          captionStyle: state.captionStyle,
          color: state.color,
          beauty: { ...(state.beauty || {}) },
          beautyBypass: !!state.beautyBypass,
          blemishMarks: Array.isArray(state.blemishMarks) ? state.blemishMarks : [],
          blemishFaceRegion: state.blemishFaceRegion || null,
          // LUT was removed; do not persist legacy LUT/filter-look payloads.
          denoise: state.denoise,
          denoiseEnabled: state.denoiseEnabled,
          denoisedAudio: persistedMediaItem(state.denoisedAudio),
          audioFxRack: normalizeAudioFxRack(state.audioFxRack),
          audioFxBypass: !!state.audioFxBypass,
          audio: state.audio,
          audioProcessingEnabled: state.audioProcessingEnabled,
          mainAudioClipSettings: state.mainAudioClipSettings,
          projectCoverPath: state.projectCoverPath,
          lastPolishPlan: state.lastPolishPlan || window.__lastPolishPlan || null,
          pauseGapPlan: state.pauseGapPlan || window.__pauseGapPlan || null,
          ignoredPolishIds: Array.from(window.__ignoredPolishIds || state.ignoredPolishIds || []),
          layout: state.layout,
          script: $("scriptText").value,
          autoCaptionScript: state.legacyAutoCaptionScript || "",
        };
      }
      async function saveProject() {
        await flushAutoSave();
        toast("工程已保存");
      }
      async function openProject() {
        try {
          const opened = unwrap(await window.native.openProject());
          if (!opened) return;
          const d = opened.data;
          resetEditorState();
          Object.assign(state, d, {
            videoLayers: d.videoLayers || [],
            images: d.images || [],
            titles: d.titles || [],
            captions: d.captions || [],
            autoTranscript: d.autoTranscript || null,
            captionRecoveryArchive: Array.isArray(d.captionRecoveryArchive) ? d.captionRecoveryArchive : [],
            captionLines: normalizeCaptionLineMode(d.captionLines ?? d.captionStyle?.captionLines ?? 1),
            reviewCaptions: d.reviewCaptions || [],
            issues: d.issues || [],
            removals: d.removals || [],
            manualCuts: d.manualCuts || [],
            audioMutes: d.audioMutes || [],
            audioCuts: d.audioCuts || [],
            trackOrder: d.trackOrder || [...defaultTrackOrder],
            trackDefinitions: d.trackDefinitions || {},
            spliceLayout: d.spliceLayout || "free",
            spliceRegions: Array.isArray(d.spliceRegions) ? d.spliceRegions : [],
            spliceRatio: Number(d.spliceRatio || 0.5),
            spliceAngle: Number(d.spliceAngle || 0),
            spliceSelectedRegionId: d.spliceSelectedRegionId || "",
            spliceMainRegionId: d.spliceMainRegionId || "",
            trackVisibility: {
              ...Object.fromEntries(
                defaultTrackOrder.map((key) => [key, true]),
              ),
              ...(d.trackVisibility || {}),
            },
            trackLocks: d.trackLocks || {},
            trackHeights: d.trackHeights || {},
            trackSolo: d.trackSolo || {},
            trackMute: d.trackMute || {},
            trackAutoSelect: d.trackAutoSelect || {},
            trackSyncLocks: d.trackSyncLocks || {},
            captionTransform: d.captionTransform || {
              x: 0,
              y: Math.round((d.height || 1920) * 0.28),
              scale: 1,
              width: Math.round((d.width || 1080) * 0.8),
            },
            color: {
              exposure: 0, contrast: 0, pivot: 0, lift: 0, gamma: 0, gain: 0,
              shadows: 0, highlights: 0, blacks: 0, whites: 0,
              saturation: 0, temperature: 0, tint: 0, vibrance: 0, hue: 0,
              midtoneDetail: 0, sharpness: 0, fade: 0, vignette: 0,
              ...(d.color || {}),
            },
            filterLook: { id: "none", intensity: 1, baseColor: null },
            lut: null,
            beauty: {
              smoothing: 0, blemish: 0, texture: 0, whitening: 0, brighten: 0, warmth: 0, rosy: 0,
              ...(d.beauty || {}),
            },
            beautyBypass: d.beautyBypass ?? true,
            denoise: normalizeDenoiseSettings(d.denoise),
            audioFxRack: normalizeAudioFxRack(d.audioFxRack),
            audioFxBypass: !!d.audioFxBypass,
            audioFxScope: "track",
            projectPath: opened.projectPath,
            selected: { type: "video", id: "main" },
            selectedItems: [],
            mainAudioClipSettings: d.mainAudioClipSettings || {},
            mainVideoClipSettings: d.mainVideoClipSettings || {},
            lastPolishPlan: d.lastPolishPlan || null,
            pauseGapPlan: d.pauseGapPlan || null,
            ignoredPolishIds: Array.isArray(d.ignoredPolishIds) ? d.ignoredPolishIds : [],
            undo: [],
          });
          window.__lastPolishPlan = state.lastPolishPlan;
          window.__pauseGapPlan = state.pauseGapPlan
            ? (state.pauseGapPlan || []).map(g => ({ ...g }))
            : (state.lastPolishPlan?.pauseGaps || []).map(g => ({ ...g }));
          window.__ignoredPolishIds = new Set(state.ignoredPolishIds);
          if (state.lastPolishPlan && $("lastPolishReport")) {
            $("lastPolishReport").disabled = false;
          }
          if (state.lastPolishPlan) {
            const summary =
              `自动切 ${state.lastPolishPlan.autoApplied || 0} 处重录/废读，口语并进 ${(state.lastPolishPlan.mergedSpoken || []).length} 条，清掉 ${(state.lastPolishPlan.strippedNotes || []).length} 处备注，${(state.lastPolishPlan.scriptureLock || []).length} 处经文锁定，${(state.lastPolishPlan.missing || []).length} 处缺读待补${(state.lastPolishPlan.leftover || []).length ? `，${state.lastPolishPlan.leftover.length} 处待确认` : ""}。气口建议切 ${state.lastPolishPlan.pauseSuggestCut || 0} 处。`;
            if ($("globalPolishSummarySidebar")) $("globalPolishSummarySidebar").textContent = summary;
            if ($("globalPolishSummary")) $("globalPolishSummary").textContent = summary;
            renderPolishSidebarList();
          }
          ensureDynamicTracks();
          if (d.video?.path) {
            const v = unwrap(await window.native.addVideoPath(d.video.path));
            state.video = { ...d.video, ...v };
            $("video").src = state.video.url;
            $("stage").classList.remove("empty");
          }
          for (const image of state.images) {
            const a = unwrap(await window.native.addImagePath(image.path));
            image.url = a.url;
            const imgTester = new Image();
            imgTester.src = a.url;
            imgTester.onload = () => {
              image.sourceWidth = imgTester.naturalWidth;
              image.sourceHeight = imgTester.naturalHeight;
              renderPreviewObjects();
            };
          }
          $("scriptText").value = d.script || d.autoCaptionScript || "";
          state.legacyAutoCaptionScript = d.autoCaptionScript || "";
          setRatio(d.ratio || "9:16");
          if (state.captions.length) {
            state.captions = await applyCaptionGrouping(state.captions, state.captionLines);
          }
          renderAll();
          toast("工程已打开");
        } catch (e) {
          toast(e.message);
        }
      }
      let cachedExportHardware = null;
      function hardwareExportLabel() {
        if (selectedExportDevice() === "cpu") return "⚙️ CPU 软件编码导出";
        const vendor = cachedExportHardware?.vendor;
        if (vendor === "nvidia") return "🚀 NVIDIA 显卡加速导出 (NVENC)";
        if (vendor === "intel") return "🚀 Intel 显卡加速导出 (QSV)";
        if (vendor === "amd") return "🚀 AMD 显卡加速导出 (AMF)";
        if (vendor === "apple") return "🚀 Apple 硬件加速 (VideoToolbox)";
        if (vendor === "software") return "⚙️ 软件编码 (未检测到兼容显卡)";
        return cachedExportHardware?.label
          ? `🚀 ${cachedExportHardware.label}`
          : "自动检测硬件加速";
      }
      function selectedExportDevice() {
        return $("exportUseCpu")?.checked && !$("exportUseGpu")?.checked ? "cpu" : "gpu";
      }
      function applyExportDevice(device) {
        const gpu = String(device || "gpu").toLowerCase() !== "cpu";
        if ($("exportUseGpu")) $("exportUseGpu").checked = gpu;
        if ($("exportUseCpu")) $("exportUseCpu").checked = !gpu;
      }
      function persistExportDevice() {
        try {
          localStorage.setItem("clipassistant_export_device", selectedExportDevice());
        } catch {}
      }
      function restoreExportDevice() {
        let stored = "gpu";
        try {
          stored = localStorage.getItem("clipassistant_export_device") || "gpu";
        } catch {}
        applyExportDevice(stored);
      }
      function renderExportHardwareStatus() {
        const status = $("exportHardwareStatus");
        if (!status) return;
        if (!cachedExportHardware) {
          status.textContent = "正在检测可用硬件编码器…";
          return;
        }
        const hardware = cachedExportHardware;
        status.textContent = hardware.vendor === "software"
          ? "未通过显卡编码实测，将安全使用 CPU。可更新显卡驱动后点“重新检测显卡”。"
          : `已通过实际编码测试：${hardware.label || hardware.vendor} · ${hardware.h264 || "自动编码器"}`;
      }
      async function loadExportHardware(force = false) {
        if (cachedExportHardware && !force) return cachedExportHardware;
        if (force) cachedExportHardware = null;
        renderExportHardwareStatus();
        try {
          cachedExportHardware = await nativeCall(force ? "refreshExportHardware" : "exportHardware");
        } catch {
          cachedExportHardware = { vendor: "unknown", label: "自动选择编码器" };
        }
        renderExportHardwareStatus();
        return cachedExportHardware;
      }
      async function openExportSettings() {
        if (!state.video) {
          toast("请先导入视频");
          return;
        }
        $("exportName").value =
          `${state.video.name.replace(/\.[^.]+$/, "")}-Edited`;
        restoreExportDevice();
        await restoreAllExportPreferences();
        updateExportSummary();
        showExportSettingsFeedback("");
        $("exportSettingsModal").classList.add("on");
        loadExportHardware().then(() => updateExportSummary());
      }
      function exportSettingsDimensions() {
        if ($("exportQuality").value === "rf") return [1080, 1920];
        const resolution = $("exportResolution").value;
        return resolution === "current"
          ? [state.width, state.height]
          : resolution.split("x").map(Number);
      }
      function visualTransformIsDefault(value = {}) {
        return Math.abs(Number(value.x || 0)) < 0.001 &&
          Math.abs(Number(value.y || 0)) < 0.001 &&
          Math.abs(Number(value.scale || 1) - 1) < 0.001 &&
          Math.abs(Number(value.rotation || 0)) < 0.001 &&
          Math.abs(Number(value.opacity ?? 1) - 1) < 0.001 &&
          (value.blendMode || "normal") === "normal";
      }
      async function openAutosaveHistory() {
        const modal = $("autosaveHistoryModal");
        const list = $("autosaveHistoryList");
        modal.classList.add("on");
        list.innerHTML = "";
        $("autosaveHistoryState").textContent = "正在读取历史版本…";
        const versions = await nativeCall("listProjectHistory", state.projectId).catch((error) => {
          $("autosaveHistoryState").textContent = error.message;
          return [];
        });
        for (const version of versions) {
          const option = document.createElement("option");
          option.value = version.id;
          option.textContent = `${new Date(version.savedAt).toLocaleString()} · ${formatTime(version.duration || 0, false)}`;
          list.appendChild(option);
        }
        if (list.options.length) list.selectedIndex = 0;
        $("autosaveHistoryState").textContent = versions.length
          ? `共有 ${versions.length} 个可恢复版本。`
          : "尚无历史版本；编辑超过一分钟后会开始轮换保存。";
      }
      $("openAutosaveHistory").onclick = openAutosaveHistory;
      $("closeAutosaveHistory").onclick = () => $("autosaveHistoryModal").classList.remove("on");
      $("restoreAutosaveHistory").onclick = async () => {
        const historyId = $("autosaveHistoryList").value;
        if (!historyId) return toast("请选择需要恢复的版本");
        const button = $("restoreAutosaveHistory");
        button.disabled = true;
        $("autosaveHistoryState").textContent = "正在恢复；当前状态会先进入历史记录…";
        try {
          await flushAutoSave();
          const restored = await nativeCall("restoreProjectHistory", {
            projectId: state.projectId,
            historyId,
          });
          $("autosaveHistoryModal").classList.remove("on");
          await enterProject(restored);
          toast("已恢复自动保存版本");
        } catch (error) {
          $("autosaveHistoryState").textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
      function colorAdjustmentsAreDefault(color = {}) {
        return Object.entries(color || {}).every(([key, value]) => {
          if (key !== "slices") return Math.abs(Number(value || 0)) < 0.001;
          return Object.values(value || {}).every((slice) =>
            ["hue", "saturation", "intensity"].every(
              (property) => Math.abs(Number(slice?.[property] || 0)) < 0.001,
            ),
          );
        });
      }
      function projectCanSmartRemux() {
        // The export dialog always offers bitrate and quality controls; remuxing
        // would silently skip them, so UI exports always go through encoding.
        return false;
      }
      function updateExportSummary() {
        if (!state.video) return;
        const rfMode = $("exportQuality").value === "rf";
        $("exportRfControl").style.display = rfMode ? "block" : "none";
        $("exportRfOut").textContent = `${Number($("exportRf").value || 24)} RF`;
        if (rfMode) {
          $("exportResolution").value = "1080x1920";
          $("exportResolution").disabled = true;
        } else {
          $("exportResolution").disabled = false;
        }
        const rate = selectedExportSpeed();
        const duration = exportContentEnd($("exportFormat").value === "mp3") / (Number.isFinite(rate) && rate >= 1 ? rate : 1);
        $("exportDurationText").textContent = formatTime(duration, false);
        const smartCopy = projectCanSmartRemux();
        const rfHevc = $("exportCodec").value === "hevc" ||
          ($("exportCodec").value === "source" && /hevc|h265/.test(String(state.video?.videoCodec || "").toLowerCase())) ||
          ["hlg", "pq"].includes($("exportColorSpace").value);
        const rfEncoder = rfHevc ? cachedExportHardware?.hevc : cachedExportHardware?.h264;
        $("exportModeText").textContent = rfMode
          ? selectedExportDevice() === "gpu" && /nvenc$/.test(rfEncoder || "")
            ? "NVIDIA NVENC 恒定画质压缩（CQ；GPU 加速）"
            : "CPU x264/x265 固定画质压缩（CRF）"
          : smartCopy
          ? "极速原码流直出（零损失）"
          : `${hardwareExportLabel()} · ${$("exportQuality").value === "lossless" ? "无损编码" : "视频压缩编码"}`;
        if (smartCopy) {
          const sourceDuration = Math.max(0.04, Number(state.video?.duration || state.sourceDuration || duration)),
            bytes = Number(state.video?.size || 0) * Math.min(1, duration / sourceDuration);
          $("exportSizeText").textContent = formatFileSize(bytes);
        } else if (rfMode) {
          const [width, height] = exportSettingsDimensions(),
            bitrateValue = $("exportBitrate").value,
            bitrate = bitrateValue === "recommended"
              ? recommendedExportBitrate(width, height, selectedExportFps())
              : bitrateValue,
            maxVideoMbps = Math.max(0, Number.parseFloat(String(bitrate)) || 0) * 1.2,
            bytes = duration * (maxVideoMbps + 0.192) * 1_000_000 / 8;
          $("exportSizeText").textContent = `峰值码率估算上限约 ${formatFileSize(bytes)} · 实际大小随画面变化`;
        } else {
          const [width, height] = exportSettingsDimensions(),
            bitrateValue = $("exportBitrate").value,
            bitrate = bitrateValue === "recommended"
              ? recommendedExportBitrate(width, height, selectedExportFps())
              : bitrateValue,
            videoMbps = $("exportFormat").value === "mp3"
              ? 0
              : Number.parseFloat(String(bitrate)) || 0,
            audioMbps = $("exportFormat").value === "mp3" ? 0.192 : 0.192,
            bytes = duration * (videoMbps + audioMbps) * 1_000_000 / 8;
          $("exportSizeText").textContent = `约 ${formatFileSize(bytes)}`;
        }
      }
      function formatFileSize(bytes) {
        const value = Math.max(0, Number(bytes || 0));
        if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
        return `${Math.round(value)} B`;
      }
      function selectedExportFps() {
        const selected = $("exportFps").value;
        if (selected !== "source") return Number(selected) || 30;
        return sourceFrameRate();
      }
      function selectedExportSpeed() {
        return $("exportSpeedMode").value === "custom" ? Number($("exportSpeedValue").value) : 1;
      }
      function resetExportSpeed() {
        $("exportSpeedMode").value = "original";
        $("exportSpeedValue").disabled = true;
        updateExportSummary();
      }
      function recommendedExportBitrate(width, height, fps) {
        const pixels = Number(width || 0) * Number(height || 0),
          highFrameRate = Number(fps || 30) > 30;
        const pixelBudget = pixels >= 7_000_000
          ? (highFrameRate ? 50 : 38)
          : pixels >= 3_000_000
            ? (highFrameRate ? 32 : 24)
            : pixels >= 1_500_000
              ? (highFrameRate ? 18 : 14)
              : (highFrameRate ? 10 : 8);
        const sourceSize = Number(state.video?.size || 0),
          sourceDuration = Number(state.video?.duration || state.sourceDuration || 0),
          sourceTotalMbps = sourceSize > 0 && sourceDuration > 0
            ? sourceSize * 8 / sourceDuration / 1_000_000
            : 0;
        if (!sourceTotalMbps) return $("exportQuality")?.value === "rf" ? "2.30M" : `${pixelBudget.toFixed(1)}M`;
        const sourceAudioMbps = Number(state.video?.audioBitrate || 0) / 1_000_000,
          audioMbps = state.video?.audioCodec
            ? (sourceAudioMbps > 0 ? sourceAudioMbps : 0.192)
            : 0,
          sourceVideoMbps = Math.max(0.01, sourceTotalMbps - audioMbps),
          quality = $("exportQuality")?.value || "balanced",
          qualityFactor = quality === "maximum" ? 0.9 : quality === "fast" ? 0.66 : quality === "rf" ? 0.24 : 0.78;
        const chosenCodec = $("exportCodec").value === "source"
          ? (/hevc|h265/.test(String(state.video?.videoCodec || "").toLowerCase()) ? "hevc" : "h264")
          : $("exportCodec").value;
        const codecFactor = chosenCodec === "hevc" ? 0.9 : 1,
          targetMbps = Math.min(pixelBudget, sourceVideoMbps * qualityFactor * codecFactor);
        return `${Math.max(0.01, targetMbps).toFixed(2)}M`;
      }
      function blockingScriptureOnTimeline() {
        return (state.issues || []).filter((issue) => {
          if (!(issue.scripture || issue.strict)) return false;
          if (issue.suppressReview) return false;
          return (
            issue.confirmedError === true ||
            issue.type === "missing" ||
            issue.type === "mismatch"
          );
        });
      }
      function resolveCaptionPayload() {
        return {
          projectName: state.projectName || "剪辑助手导出",
          width: state.width,
          height: state.height,
          fps: state.video?.frameRate || 30,
          captions: (state.captions || []).map((caption) => ({
            text: caption.text,
            start: caption.start,
            end: caption.end,
            words: Array.isArray(caption.words) ? caption.words : [],
            width: caption.width || state.captionTransform?.width,
            scale: caption.scale || state.captionTransform?.scale,
            x: state.captionTransform?.x,
            y: state.captionTransform?.y,
            style: caption.style,
          })),
          captionStyle: { ...state.captionStyle, captionLines: state.captionLines },
          captionTransform: state.captionTransform,
        };
      }
      function setSendResolveProgress(percent, summary, status, waiting = false, logTail = "") {
        $("sendResolveBar").style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
        if (summary) $("sendResolveSummary").textContent = summary;
        if (status) $("sendResolveStatus").textContent = status;
        $("sendResolveProgressWrap").classList.toggle("waiting", !!waiting);
        const logBox = $("sendResolveLog");
        if (logTail) {
          logBox.style.display = "block";
          logBox.textContent = logTail;
          logBox.scrollTop = logBox.scrollHeight;
        }
      }
      async function sendCaptionsToResolve() {
        if (!(state.captions || []).some((caption) => String(caption.text || "").trim())) {
          toast("请先做好字幕再发送到达芬奇");
          return;
        }
        const button = $("sendResolve");
        const closeButton = $("closeSendResolve");
        const original = button.textContent;
        const total = (state.captions || []).filter((caption) => String(caption.text || "").trim()).length;
        let pollTimer = 0;
        button.disabled = true;
        closeButton.disabled = true;
        button.textContent = "正在发送…";
        $("sendResolveModal").classList.add("on");
        setSendResolveProgress(8, `准备发送 ${total} 条字幕`, "正在写入任务…", true);
        try {
          await nativeCall("installResolveLink");
          const refreshProgress = async () => {
            try {
              const progress = await nativeCall("resolveSendProgress");
              if (!progress) return;
              if (!progress.listening && progress.phase !== "writing" && progress.phase !== "done") {
                setSendResolveProgress(
                  Math.max(8, Number(progress.percent) || 8),
                  "达芬奇还没开始接收",
                  "请打开工程和时间线，点「工作区 → 脚本 → 剪辑助手」。点过一次后进度会继续走。",
                  true,
                );
                return;
              }
              if (progress.phase === "writing") {
                setSendResolveProgress(
                  Math.max(12, Number(progress.percent) || 12),
                  progress.total
                    ? `已成功 ${progress.done || 0} / ${progress.total}`
                    : "达芬奇正在写入字幕",
                  progress.message || "正在把 Text+ 铺到时间线…",
                  false,
                  progress.logTail,
                );
                return;
              }
              if (progress.phase === "done") {
                setSendResolveProgress(
                  100,
                  `已发送 ${progress.done || total} 条`,
                  progress.message || "达芬奇写入完成",
                  false,
                  progress.logTail,
                );
                return;
              }
              if (progress.phase === "error") {
                setSendResolveProgress(
                  100,
                  "发送失败",
                  progress.message || progress.error || "达芬奇写入失败",
                  false,
                  progress.logTail,
                );
                return;
              }
              setSendResolveProgress(
                Math.max(16, Number(progress.percent) || 16),
                progress.listening ? "达芬奇已连接" : "等待达芬奇",
                progress.message || "等待写入…",
                progress.phase === "waiting" || progress.phase === "idle",
              );
            } catch {
              /* keep last status */
            }
          };
          await refreshProgress();
          pollTimer = window.setInterval(refreshProgress, 250);
          const result = await nativeCall("sendToResolve", resolveCaptionPayload());
          window.clearInterval(pollTimer);
          pollTimer = 0;
          await refreshProgress();
          const extra = result.warning ? `，${result.warning}` : "";
          setSendResolveProgress(100, `已发送 ${result.count} 条字幕`, `已铺到达芬奇当前时间线${extra}`);
          toast(`已发送 ${result.count} 条字幕到达芬奇`);
        } catch (error) {
          if (pollTimer) window.clearInterval(pollTimer);
          let tail = "";
          try {
            tail = (await nativeCall("resolveSendProgress"))?.logTail || "";
          } catch {}
          setSendResolveProgress(100, "发送失败", error.message, false, tail);
          toast(error.message);
        } finally {
          if (pollTimer) window.clearInterval(pollTimer);
          button.disabled = false;
          closeButton.disabled = false;
          button.textContent = original;
        }
      }
      async function exportResolveTimeline() {
        if (!state.video?.path) {
          toast("请先导入视频");
          return;
        }
        try {
          const output = await nativeCall(
            "chooseResolveExport",
            `${state.projectName || "剪辑助手"}-达芬奇.fcpxml`,
          );
          if (!output) {
            toast("已取消导出达芬奇时间线");
            return;
          }
          const result = unwrap(
            await window.native.exportResolveTimeline({
              outputPath: output,
              projectName: state.projectName || "剪辑助手导出",
              inputPath: state.video.path,
              sourceDuration: state.sourceDuration || state.duration,
              width: state.width,
              height: state.height,
              fps: state.video.frameRate || 30,
              audioRate: state.video.audioSampleRate || state.video.sampleRate || 48000,
              audioChannels: state.video.audioChannels || 2,
              clips: mainClips(),
              captions: (state.captions || []).map((caption) => ({
                text: caption.text,
                start: caption.start,
                end: caption.end,
                words: caption.words,
                width: caption.width || state.captionTransform?.width,
                scale: caption.scale || state.captionTransform?.scale,
                x: state.captionTransform?.x,
                y: state.captionTransform?.y,
              })),
              captionStyle: { ...state.captionStyle, captionLines: state.captionLines },
              captionTransform: state.captionTransform,
              removals: state.removals,
              videoLayers: (state.videoLayers || []).map((item) => ({
                path: item.path,
                name: item.name,
                start: item.start,
                end: item.end,
                sourceStart: item.sourceStart || 0,
                x: item.x || 0,
                y: item.y || 0,
                scale: item.scale || 1,
                rotation: item.rotation || 0,
                opacity: item.opacity ?? 1,
              })),
              images: (state.images || []).map((item) => ({
                path: item.path,
                name: item.name,
                start: item.start,
                end: item.end,
                x: item.x || 0,
                y: item.y || 0,
                scale: item.scale || 1,
                rotation: item.rotation || 0,
                opacity: item.opacity ?? 1,
              })),
              titles: (state.titles || []).map((item) => ({
                text: item.text,
                start: item.start,
                end: item.end,
                x: item.x || 0,
                y: item.y || 0,
                width: item.width,
                scale: item.scale || 1,
                style: item.style,
              })),
              audioAssets: (state.audioAssets || []).map((item) => ({
                path: item.path,
                name: item.name,
                start: item.start,
                end: item.end,
                sourceStart: item.sourceStart || 0,
                volume: item.volume ?? 1,
              })),
            }),
          );
          toast(
            `已导出达芬奇时间线 ${result.clipCount} 段。用「文件 → 导入时间线」打开 fcpxml。片头剪掉后会从 00:00:00 起铺，不要从素材时间码起。`,
          );
        } catch (error) {
          toast(error.message);
        }
      }
      function normalizeExportFrameBoundaries(clips, fps) {
        const frame = 1 / Math.max(1, Number(fps || 30));
        const list = (clips || []).map((clip) => ({ ...clip }));
        list.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
        let repairs = 0;
        for (const clip of list) {
          const startFrame = Math.round(Number(clip.start || 0) / frame);
          const endFrame = Math.max(startFrame + 1, Math.round(Number(clip.end || clip.start || 0) / frame));
          clip.start = startFrame * frame;
          clip.end = endFrame * frame;
        }
        for (let i = 1; i < list.length; i += 1) {
          const prev = list[i - 1], cur = list[i];
          const gap = Number(cur.start) - Number(prev.end);
          if (Math.abs(gap) < frame * 0.25) {
            const boundary = Math.round(((Number(cur.start) + Number(prev.end)) * .5) / frame) * frame;
            prev.end = Math.max(Number(prev.start) + frame, boundary);
            cur.start = boundary;
            if (Number(cur.end) <= Number(cur.start)) cur.end = Number(cur.start) + frame;
            if (Math.abs(gap) > .000001) repairs += 1;
          }
        }
        return { clips: list, repairs };
      }
      function showExportSettingsFeedback(message, issue = null) {
        $("exportSettingsFeedback").textContent = message;
        const locate = $("locateExportIssue");
        locate.hidden = !issue;
        locate.onclick = issue ? () => {
          $("exportSettingsModal").classList.remove("on");
          focusScriptDifference(issue.id);
          keepPlayheadInView("center");
        } : null;
      }
      async function exportVideo() {
        const chooseButton = $("exportSettingsConfirm"),
          originalChooseText = chooseButton.textContent;
        if (chooseButton.disabled) return;
        try {
        showExportSettingsFeedback("");
        const exportSpeed = selectedExportSpeed();
        if (!Number.isFinite(exportSpeed) || (exportSpeed !== 1 && (exportSpeed < 1.1 || exportSpeed > 2)) ||
            ($("exportSpeedMode").value === "custom" && exportSpeed < 1.1))
          return showExportSettingsFeedback("请输入 1.1～2.0 之间的导出倍速");
        const blocked = blockingScriptureOnTimeline();
        if (blocked.length) {
          const issue = blocked[0];
          toast(`有 ${blocked.length} 处经文差异，请自行核对；不影响导出。`);
        }
          const format = $("exportFormat").value,
            resolution = $("exportQuality").value === "rf" ? "1080x1920" : $("exportResolution").value;
          let width = state.width,
            height = state.height;
          if (resolution !== "current")
            [width, height] = resolution.split("x").map(Number);
          const exportDuration = exportContentEnd(format === "mp3");
          if (exportDuration <= 0.04) {
            showExportSettingsFeedback("没有可见素材可以导出；请检查轨道眼睛开关");
            return;
          }
          const candidateItems = [state.video, ...state.libraryAssets, ...state.videoLayers, ...state.images, ...state.audioAssets].filter(Boolean);
          const candidatePaths = [...new Set(candidateItems.flatMap((item) => [item.path, item.originalPath]).filter(Boolean))];
          const availability = await nativeCall("assetAvailability", candidatePaths);
          const availablePaths = new Set((availability || []).filter((item) => item.exists).map((item) => item.path));
          const linkedLibraryAsset = (item) => state.libraryAssets.find((asset) => asset.id && [item?.libraryId, item?.sourceMediaId, item?.id].includes(asset.id));
          const resolvedPath = (item) => [item?.path, item?.originalPath, linkedLibraryAsset(item)?.path, linkedLibraryAsset(item)?.originalPath].filter(Boolean).find((candidate) => availablePaths.has(candidate)) || "";
          const hasMainTimeline = mainClips().length > 0;
          const mainLibraryAsset = state.libraryAssets.find((asset) => asset.id && [state.video?.libraryId, state.video?.id].includes(asset.id));
          const mainSourcePath = resolvedPath(state.video) || resolvedPath(mainLibraryAsset);
          if (hasMainTimeline && !mainSourcePath) {
            showExportSettingsFeedback("主视频时间线的源文件找不到。请在素材区右键该视频，选择对应文件重新关联后再导出。");
            return;
          }
          const noMainVideoSource = !hasMainTimeline;
          const exportSourcePath = mainSourcePath || state.videoLayers.map(resolvedPath).find(Boolean) || "";
          if (!exportSourcePath) {
            showExportSettingsFeedback("工程里没有可读取的视频源。请重新关联时间线里的视频素材后再导出。");
            return;
          }
          const fps = selectedExportFps(),
            bitrateSelection = $("exportBitrate").value,
            bitrate =
              bitrateSelection === "recommended"
                ? recommendedExportBitrate(width, height, fps)
                : bitrateSelection;
          chooseButton.disabled = true;
          chooseButton.textContent = "正在打开保存位置…";
          showExportSettingsFeedback("正在打开系统保存位置窗口…");
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const picked = await nativeCall(
            "chooseExport",
            `${$("exportName").value || "剪辑助手导出"}.${format}`,
            exportSourcePath,
          );
          chooseButton.disabled = false;
          chooseButton.textContent = originalChooseText;
          const output = typeof picked === "string" ? picked : picked?.path;
          if (!output) {
            showExportSettingsFeedback("已取消选择保存位置，可再次点击导出。");
            return;
          }
          if (picked?.autoSaved) {
            showExportSettingsFeedback('未能打开保存位置窗口，请重试选择位置。');
            return;
          }
          $("exportSettingsModal").classList.remove("on");
          $("exportModal").classList.add("on");
          $("cancelExport").textContent = "取消导出";
          $("exportBar").style.width = "0";
          $("exportStatus").textContent = "正在检查音频修复参数…";
          await ensureAudioFxHumAnalysis(true);
          $("exportStatus").textContent = "正在按预览渲染字幕…";
          let captionRasters = [];
          let captionRasterDirectory = "";
          try {
            const rendered = await rasterizeCaptionsForExport();
            captionRasters = rendered.images || [];
            captionRasterDirectory = rendered.directory || "";
          } catch (error) {
            console.warn("字幕预览渲染失败，回退 ASS", error);
          }
          $("revealExport").style.display = "none";
          let mainAudioPath = "";
          let mainAudioFxPreRendered = false;
          const isDenoiseActive = !!(state.denoiseEnabled && Number(state.denoise?.strength || 0) > 0.01);
          const advancedCacheValid = !!(
            state.denoisedAudio?.includesAudioFx && state.denoisedAudio.path &&
            state.denoisedAudio.sourcePath === state.video?.path &&
            state.denoisedAudio.fxSignature === audioFxSignature() &&
            state.denoisedAudio.configSignature === denoiseSettingsSignature()
          );
          if (advancedCacheValid) {
            mainAudioPath = state.denoisedAudio.path;
            mainAudioFxPreRendered = true;
          } else if (isDenoiseActive && state.video?.path) {
            const currentMode = "deepfilter";
            state.denoise.mode = "deepfilter";
            const currentStrength = state.denoise?.strength ?? 0.85;
            const currentConfigSignature = denoiseSettingsSignature();
            const isCacheValid = state.denoisedAudio &&
              state.denoisedAudio.path &&
              state.denoisedAudio.sourcePath === state.video.path &&
              state.denoisedAudio.mode === currentMode &&
              Math.abs(Number(state.denoisedAudio.strength ?? 0.85) - Number(currentStrength)) < 0.01 &&
              state.denoisedAudio.configSignature === currentConfigSignature;

            if (isCacheValid) {
              mainAudioPath = state.denoisedAudio.path;
            } else {
              $("exportStatus").textContent = "正在生成整轨 AI 高清降噪音频…";
              try {
                const media = await nativeCall("applyDenoiseTrack", {
                  projectId: state.projectId,
                  path: state.video.path,
                  mode: currentMode,
                  strength: currentStrength,
                  config: { ...state.denoise },
                });
                state.denoisedAudio = {
                  ...media,
                  sourcePath: state.video.path,
                  mode: currentMode,
                  strength: currentStrength,
                  configSignature: currentConfigSignature,
                };
                state.denoiseEnabled = true;
                mainAudioPath = state.denoisedAudio.path;
                syncAudioControls();
                syncPreviewAudio();
                queueAutosave();
              } catch (err) {
                console.warn("导出前生成降噪缓存失败，回退常规滤镜降噪", err);
              }
            }
          }
          const normalizedVideo = normalizeExportFrameBoundaries(mainClips(), fps);
          const normalizedAudio = normalizeExportFrameBoundaries(mainAudioClips(), fps);
          if (normalizedVideo.repairs || normalizedAudio.repairs) {
            $("exportStatus").textContent = `导出前已修复 ${normalizedVideo.repairs + normalizedAudio.repairs} 个亚帧边界，防止切口黑帧…`;
          }
          const exportMainVideoClips = normalizedVideo.clips.map((clip) => {
            const settings = { ...mainVideoSettings(clip) };
            settings.color ||= JSON.parse(JSON.stringify(state.color || {}));
            if (state.colorBypass && state.selected?.type === "video" && [clip.id, "main"].includes(state.selected.id)) settings.color = {};
            settings.spliceRegion = typeof window.spliceRegionForExport === "function"
              ? window.spliceRegionForExport({ type: "main", clip, settings, media: state.video })
              : null;
            return { ...clip, trackId: state.mainVideoTrackMap?.[clip.id] || "video", settings };
          });
          const normalizedAudioMap = new Map(normalizedAudio.clips.map((clip) => [clip.id, clip]));
          const exportMainAudioClips = mainAudioClips().map((sourceClip) => {
            const clip = normalizedAudioMap.get(sourceClip.id) || sourceClip;
            const settings = mainAudioSettings(clip) || {};
            const trackId = state.mainAudioTrackMap?.[clip.id] || "audio";
            const videoOwner = exportMainVideoClips.find((videoClip) =>
              Number(videoClip.start || 0) < Number(clip.end || 0) && Number(videoClip.end || 0) > Number(clip.start || 0));
            const playbackMode = videoOwner?.settings?.splicePlaybackMode || "normal-audio";
            const spliceMuteUntil = playbackMode === "freeze-resume"
              ? clamp(Number(videoOwner.settings.spliceFreezeUntil || videoOwner.start), Number(clip.start || 0), Number(clip.end || 0))
              : 0;
            return {
              ...clip,
              ...settings,
              trackId,
              muted: !!settings.muted || !isTrackAudible(trackId) || playbackMode === "normal-muted" || playbackMode === "freeze-hold",
              spliceMuteStart: playbackMode === "freeze-resume" ? Math.max(Number(clip.start || 0), Number(videoOwner.start || 0)) : 0,
              spliceMuteUntil,
            };
          });
          const config = {
            inputPath: exportSourcePath,
            noMainVideoSource,
            mainAudioPath: mainAudioPath || "",
            outputPath: output,
            format,
            width,
            height,
            fps,
            codec: $("exportCodec").value,
            bitrate,
            colorSpace: $("exportColorSpace").value,
            qualityMode: $("exportQuality").value,
            rf: Math.max(0, Math.min(51, Math.round(Number($("exportRf").value || 24)))),
            forceReencode: true,
            encoderDevice: selectedExportDevice(),
            removals: state.removals,
            audioMutes: state.audioMutes,
            audioAssets: state.audioAssets.map((x) => {
              const videoOwner = state.videoLayers.find((video) =>
                (x.linkedVideoId && video.id === x.linkedVideoId) || (x.linkGroupId && video.linkGroupId === x.linkGroupId));
              const playbackMode = videoOwner?.splicePlaybackMode || "normal-audio";
              return ({
              path: resolvedPath(x) || x.path,
              start: x.start,
              end: x.end,
              sourceStart: x.sourceStart || 0,
              sourceEnd: x.sourceEnd,
              sourceMediaId: x.sourceMediaId,
              linkGroupId: x.linkGroupId,
              volume: x.volume ?? 1,
              pan: x.pan || 0,
              fadeIn: x.fadeIn || 0,
              fadeOut: x.fadeOut || 0,
              muted: !!x.muted || playbackMode === "normal-muted" || playbackMode === "freeze-hold",
              spliceMuteStart: playbackMode === "freeze-resume" ? Math.max(Number(x.start || 0), Number(videoOwner.start || 0)) : 0,
              spliceMuteUntil: playbackMode === "freeze-resume" ? Number(videoOwner.spliceFreezeUntil || videoOwner.start || 0) : 0,
              linkedVideoId: x.linkedVideoId || "",
              fxRack: normalizeAudioFxRack(x.fxRack),
              fxBypass: !!x.fxBypass,
              trackId: x.trackId,
            });
            }),
            videoLayers: state.videoLayers.map((x) => ({
              path: resolvedPath(x) || x.path,
              start: x.start,
              end: x.end,
              sourceStart: x.sourceStart || 0,
              sourceEnd: x.sourceEnd,
              sourceMediaId: x.sourceMediaId,
              linkGroupId: x.linkGroupId,
              x: x.x || 0,
              y: x.y || 0,
              scale: x.scale || 1,
              opacity: x.opacity ?? 1,
              rotation: x.rotation || 0,
              blendMode: x.blendMode || "normal",
              cropTop: Number(x.cropTop || 0),
              cropBottom: Number(x.cropBottom || 0),
              cropLeft: Number(x.cropLeft || 0),
              cropRight: Number(x.cropRight || 0),
              volume: x.volume ?? 1,
              splicePlaybackMode: x.splicePlaybackMode || "normal-audio",
              spliceFreezeFrame: Number(x.spliceFreezeFrame ?? x.sourceStart ?? 0),
              spliceFreezeUntil: Number(x.spliceFreezeUntil ?? x.start ?? 0),
              spliceRegionId: x.spliceRegionId || "auto",
              spliceRegion: typeof window.spliceRegionForExport === "function"
                ? window.spliceRegionForExport({ type: "layer", clip: x, settings: x, media: x })
                : null,
              color: state.colorBypass && state.selected?.type === "videolayer" && state.selected.id === x.id ? {} : (x.color || state.color || {}),
              trackId: x.trackId,
              compoundId: x.compoundId || "",
              compoundStackOrder: Number(x.compoundStackOrder || 0),
            })),
            compoundClips: (state.compoundClips || []).map((group) => ({
              id: group.id,
              start: Number(group.start || 0),
              end: Number(group.end || 0),
              videoTrackId: group.videoTrackId || "video",
              audioTrackId: group.audioTrackId || "",
              transform: { ...(group.transform || {}) },
            })),
            spliceLayout: state.spliceLayout || "free",
            spliceRegions: Array.isArray(state.spliceRegions) ? state.spliceRegions.map((region) => ({ ...region })) : [],
            spliceRatio: Number(state.spliceRatio || .5),
            spliceAngle: Number(state.spliceAngle || 0),
            outputDuration: exportDuration,
            exportSpeed,
            mainTimelineOffset: state.mainTimelineOffset,
            videoTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
            color: {},
            beauty: state.beautyBypass ? {} : { ...(state.beauty || {}) },
            blemishMarks: Array.isArray(state.blemishMarks) ? state.blemishMarks : [],
            denoise: {
              ...state.denoise,
              strength: state.denoiseEnabled ? state.denoise.strength : 0,
            },
            audioFxRack: normalizeAudioFxRack(state.audioFxRack),
            audioFxBypass: !!state.audioFxBypass,
            mainAudioFxPreRendered,
              audio: state.audio,
            audioProcessingEnabled: state.audioProcessingEnabled,
            trackOrder: state.trackOrder,
            trackDefinitions: state.trackDefinitions,
            trackVisibility: effectiveTrackVisibility(),
            mainAudioClipSettings: state.mainAudioClipSettings,
            mainVideoClips: exportMainVideoClips,
            mainAudioClips: exportMainAudioClips,
            includeVideo: exportMainVideoClips.some(
              (clip) => state.trackVisibility[clip.trackId] !== false,
            ),
            includeAudio: true,
            captionRasterized: captionRasters.length > 0,
            captionRasterDirectory,
            images: [
              ...state.images
              .filter((x) => state.trackVisibility[x.trackId] !== false)
              .map(
              (x) => ({
                path: resolvedPath(x) || x.path,
                start: x.start,
                end: x.end,
                x: x.x,
                y: x.y,
                scale: x.scale,
                sourceWidth: x.sourceWidth,
                sourceHeight: x.sourceHeight,
                opacity: x.opacity,
                rotation: x.rotation || 0,
                blendMode: x.blendMode || "normal",
                cropTop: Number(x.cropTop || 0),
                cropBottom: Number(x.cropBottom || 0),
                cropLeft: Number(x.cropLeft || 0),
                cropRight: Number(x.cropRight || 0),
                spliceRegionId: x.spliceCanvasOverlay ? "" : x.spliceRegionId || "auto",
                spliceRegion: !x.spliceCanvasOverlay && x.spliceRegionId && typeof window.spliceRegionForExport === "function"
                  ? window.spliceRegionForExport({ type: "layer", clip: x, settings: x, media: x })
                  : null,
                spliceCanvasOverlay: !!x.spliceCanvasOverlay,
                trackId: x.trackId,
                compoundId: x.compoundId || "",
                compoundStackOrder: Number(x.compoundStackOrder || 0),
                enterAnimation: x.enterAnimation || "",
                exitAnimation: x.exitAnimation || "",
                enterDuration: x.enterDuration || 0.45,
                exitDuration: x.exitDuration || 0.45,
              }),
            ),
              ...captionRasters,
            ],
            titles: state.titles.filter(
              (x) => state.trackVisibility[x.trackId] !== false,
            ),
            captions: state.captions
              .filter(
                (x) => state.trackVisibility[x.trackId || "caption"] !== false,
              )
              .map(
              (x) => ({
                ...x,
                x: state.captionTransform.x,
                y: state.captionTransform.y,
                scale: state.captionTransform.scale,
                width: state.captionTransform.width,
                style: { ...state.captionStyle, captionLines: state.captionLines },
              }),
            ),
            quality: "high",
          };
          const { jobId } = await nativeCall("startExport", config);
          state.exportJobId = jobId;
          $("exportSummary").textContent =
            format === "mp3"
              ? `MP3 · ${formatTime(exportDuration / exportSpeed, false)} · ${exportSpeed} 倍速`
              : `${width}×${height} · ${fps} fps · ${$("exportCodec").selectedOptions[0].textContent} · ${bitrate} · ${$("exportColorSpace").selectedOptions[0].textContent} · ${formatTime(exportDuration / exportSpeed, false)} · ${exportSpeed} 倍速`;
          $("exportBar").parentElement?.classList.add("waiting");
          while (true) {
            await new Promise((r) => setTimeout(r, 200));
            const s = await nativeCall("exportStatus", jobId);
            const elapsed = Math.max(0, Number(s.elapsed || 0));
            const clock = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
            $("exportBar").style.width = `${Math.max(2, (s.progress || 0) * 100)}%`;
            $("exportBar").parentElement?.classList.toggle(
              "waiting",
              (s.state === "queued" || s.state === "exporting" || s.state === "preparing") && (s.progress || 0) < 0.18,
            );
            if (s.state === "queued" || s.state === "exporting" || s.state === "preparing") {
              let text =
                s.message ||
                `正在导出 ${Math.round((s.progress || 0) * 100)}%${s.encoderLabel ? ` · ${s.encoderLabel}` : ""}`;
              text = /已用 \d+:\d+/.test(text)
                ? text.replace(/已用 \d+:\d+/, `已用 ${clock}`)
                : `${text} · 已用 ${clock}`;
              $("exportStatus").textContent = text;
            } else {
              $("exportStatus").textContent = s.state;
            }
            if (s.state === "completed") {
              $("exportStatus").textContent = s.message || (s.encoderLabel
                ? `导出完成 · ${s.encoderLabel}`
                : "导出完成");
              $("revealExport").style.display = "inline-block";
              $("cancelExport").textContent = "关闭";
              $("revealExport").onclick = () =>
                window.native.revealFile(s.outputPath);
              state.exportJobId = "";
              resetExportSpeed();
              break;
            }
            if (s.state === "cancelled") {
              $("exportStatus").textContent = "已取消导出";
              $("cancelExport").textContent = "关闭";
              state.exportJobId = "";
              resetExportSpeed();
              break;
            }
            if (s.state === "failed") throw new Error(s.error);
          }
        } catch (e) {
          chooseButton.disabled = false;
          chooseButton.textContent = originalChooseText;
          state.exportJobId = "";
          resetExportSpeed();
          $("cancelExport").textContent = "关闭";
          $("exportStatus").textContent = e.message;
          showExportSettingsFeedback(e.message || "导出失败，请重试");
          toast(e.message);
        }
      }
      document.querySelectorAll(".tab[data-side]").forEach(
        (b) =>
          (b.onclick = () => {
            document
              .querySelectorAll(".tab[data-side]")
              .forEach((x) => x.classList.toggle("active", x === b));
            document
              .querySelectorAll(".sidebody>.sidepage")
              .forEach((x) =>
                x.classList.toggle("active", x.id === `side-${b.dataset.side}`),
              );
            document.querySelector(".sidebody")?.classList.toggle("polish-active", b.dataset.side === "polish");
            if (b.dataset.side === "style" || b.dataset.side === "subtitle") {
              if (state.selected.type !== "caption" && state.selected.type !== "text") {
                state.selected = { type: "caption", id: state.captions[0]?.id || "caption-track" };
              }
              document.querySelectorAll(".tab[data-inspect]").forEach((x) => x.classList.toggle("active", x.dataset.inspect === "basic"));
              document.querySelectorAll(".inspectbody>.sidepage").forEach((x) => x.classList.toggle("active", x.id === "inspect-basic"));
              updateInspector();
            }
          }),
      );
      document.querySelectorAll(".tab[data-inspect]").forEach(
        (b) =>
          (b.onclick = () => {
            document
              .querySelectorAll(".tab[data-inspect]")
              .forEach((x) => x.classList.toggle("active", x === b));
            document
              .querySelectorAll(".inspectbody>.sidepage")
              .forEach((x) =>
                x.classList.toggle(
                  "active",
                  x.id === `inspect-${b.dataset.inspect}`,
                ),
              );
          }),
      );
      $("filterGrid").onclick = (event) => {
        const card = event.target.closest("[data-filter-look]");
        if (!card) return;
        snapshot();
        applyFilterLook(card.dataset.filterLook);
      };
      $("filterIntensity").oninput = (event) => {
        const intensity = Number(event.target.value) / 100;
        $("filterIntensityOut").textContent = `${event.target.value}%`;
        if (state.lut) {
          state.lut.intensity = intensity;
          queueAutosave();
          return;
        }
        if (state.filterLook?.id && state.filterLook.id !== "none")
          applyFilterLook(state.filterLook.id, intensity);
      };
      $("importLut").onclick = async () => {
        try {
          const lut = await nativeCall("importLut", { projectId: state.projectId });
          if (!lut) return;
          snapshot();
          state.lut = { ...lut, intensity: Number($("filterIntensity").value) / 100 };
          state.filterLook = { id: "none", intensity: 1, baseColor: null };
          renderFilterPanel();
          if (state.video?.path) {
            const preview = await nativeCall("lutPreview", {
              path: state.video.path,
              time: timelineToSource(state.currentTime),
              lutPath: state.lut.path,
            });
            $("lutPreviewFrame").src = preview.url;
            $("lutPreviewFrame").style.display = "block";
          }
          queueAutosave();
          toast("LUT 已载入；当前帧已预览，导出使用四面体插值");
        } catch (error) { toast(error.message); }
      };
      $("clearFilter").onclick = () => {
        snapshot();
        if (state.filterLook?.baseColor) state.color = { ...state.filterLook.baseColor };
        state.filterLook = { id: "none", intensity: 1, baseColor: null };
        state.lut = null;
        $("lutPreviewFrame").style.display = "none";
        renderFilterPanel();
        applyVideoCss();
        queueAutosave();
      };
      renderFilterPanel();
      $("homeNewProject").onclick = openNewProjectModal;
      $("homeEmptyNew").onclick = openNewProjectModal;
      $("newProjectCancel").onclick = closeNewProjectModal;
      $("newProjectConfirm").onclick = createNewProject;
      $("newProjectModal").onclick = (event) => {
        if (event.target === $("newProjectModal")) closeNewProjectModal();
      };
      $("newProjectName").onkeydown = (event) => {
        if (event.key === "Enter") createNewProject();
      };
      $("renameProjectCancel").onclick = () => closeRenameProjectDialog();
      $("renameProjectConfirm").onclick = () => closeRenameProjectDialog($("renameProjectName").value);
      $("renameProjectName").onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          closeRenameProjectDialog($("renameProjectName").value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeRenameProjectDialog();
        }
      };
      $("renameProjectModal").onclick = (event) => {
        if (event.target === $("renameProjectModal")) closeRenameProjectDialog();
      };
      $("confirmCancel").onclick = closeConfirm;
      $("confirmAccept").onclick = async () => {
        const action = confirmAction;
        closeConfirm();
        if (!action) return;
        try {
          await action();
        } catch (error) {
          toast(error.message);
        }
      };
      $("confirmModal").onclick = (event) => {
        if (event.target === $("confirmModal")) closeConfirm();
      };
      $("homeSearch").oninput = () =>
        renderProjectHome(window.__projectItems || []);
      function askDeleteProject(projectId, event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const item = (window.__projectItems || []).find((project) => project.id === projectId);
        askConfirm(
          `确定永久删除工程“${item?.name || "未命名工程"}”？工程文件、媒体副本、自动保存历史和工程专属缓存都会删除，无法恢复。`,
          async () => {
            if (homeBusy) return;
            homeBusy = true;
            updateHomeSelection();
            try {
            if (state.projectId === projectId) {
              clearTimeout(autosaveTimer);
              autosaveTimer = null;
              state.editorActive = false;
              if (autosaveRunning) { try { await autosaveRunning; } catch {} }
              unloadEditorMedia();
            }
            const cardImg = document.querySelector(
              `[data-project-id="${projectId}"] img`,
            );
            if (cardImg) {
              cardImg.removeAttribute("src");
              cardImg.src = "";
            }
            try {
              await nativeCall("releaseProjectAssets", projectId);
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 80));
            const result = await nativeCall("deleteProject", projectId, {permanent:true});
            if (!result) throw new Error("工程不存在或已删除");
            if (state.projectId === projectId) {
              resetEditorState();
              state.projectId = "";
            }
            toast(result.cacheCleanupFailures
              ? `工程已永久删除；${result.cacheCleanupFailures} 个被占用的缓存文件暂未清理`
              : "工程、工程内文件和未被其他工程共用的缓存已永久删除");
            } finally {
              homeBusy = false;
              updateHomeSelection();
              await refreshHome();
            }
          },
          "永久删除工程",
        );
      }
      $("homeProjectGrid").onclick = (event) => {
        const rename = event.target.closest("[data-rename-project]");
        if (rename) {
          const projectId = rename.dataset.renameProject;
          const item = (window.__projectItems || []).find((project) => project.id === projectId);
          openRenameProjectDialog(item?.name || "未命名工程").then((nextName) => {
            if (nextName === null) return;
            const name = nextName.trim().slice(0, 80);
            if (!name) { toast("工程名称不能为空"); return; }
            nativeCall("renameProject", { projectId, name })
              .then(async () => {
                if (state.projectId === projectId) {
                  state.projectName = name;
                  if ($("projectName")) $("projectName").textContent = state.projectName;
                }
                await refreshHome();
                toast("工程名称已修改");
              })
              .catch((error) => toast(error.message));
          });
          return;
        }
        const remove = event.target.closest("[data-delete-project]");
        if (remove) {
          askDeleteProject(remove.dataset.deleteProject, event);
          return;
        }
        const card = event.target.closest("[data-project-id]");
        if (card) openProjectById(card.dataset.projectId);
      };
      $("homeProjectGrid").onpointerdown = (event) => {
        const remove = event.target.closest("[data-delete-project], [data-rename-project]");
        if (!remove) return;
        event.stopPropagation();
      };
      $("backHome").onclick = backToHome;
      if ($("play"))
        $("play").onclick = () => {
          blurActiveTextField();
          togglePlay();
        };
      if ($("toStart")) $("toStart").onclick = () => seekTimeline(0);
      if ($("toEnd")) $("toEnd").onclick = () => seekTimeline(state.duration);
      if ($("playbackSpeedSelect")) {
        $("playbackSpeedSelect").onchange = (e) => {
          setPlaybackSpeed(Number(e.target.value) || 1.0, true);
        };
      }
      if ($("playbackSpeedBtn")) {
        $("playbackSpeedBtn").onclick = () => {
          stepPlaybackSpeed(1);
        };
      }
      if ($("loopPlayback"))
        $("loopPlayback").onclick = () => {
          state.loopPlayback = !state.loopPlayback;
          $("loopPlayback").classList.toggle("active", state.loopPlayback);
          $("loopPlayback").classList.toggle("primary", state.loopPlayback);
          toast(state.loopPlayback ? "循环播放已开启" : "循环播放已关闭");
        };
      if ($("pauseCut")) $("pauseCut").onclick = () => runPauseCut();
      $("addTrack").onclick = () => {
        addText();
          document.querySelector('[data-inspect="basic"]')?.click();
          requestAnimationFrame(() => {
            $("objectText")?.focus();
            $("objectText")?.select();
          });
        };
      $("trackMenu").onclick = (event) => {
        if (event.target.closest("[data-add-text]")) {
          $("trackMenu").classList.remove("on");
          addText();
          document.querySelector('[data-inspect="basic"]')?.click();
          requestAnimationFrame(() => {
            $("objectText").focus();
            $("objectText").select();
          });
          return;
        }
        const importer = event.target.closest("[data-import-kind]");
        if (importer) {
          $("trackMenu").classList.remove("on");
          const kind = importer.dataset.importKind;
          if (kind === "video") importVideo();
          if (kind === "audio") importAudio();
          if (kind === "image") importImage();
          if (kind === "subtitle") importSubtitle();
          return;
        }
        const button = event.target.closest("[data-add-track-kind]");
        if (button) {
          snapshot();
          let kind = button.dataset.addTrackKind;
          if (["image", "text"].includes(kind)) kind = "video";
          const trackId = createDynamicTrack(
            kind,
            `${trackMeta[kind]?.label || "素材"}轨道`,
            kind === "audio" ? "audio" : kind === "caption" ? "caption" : "video",
          );
          $("trackMenu").classList.remove("on");
          renderAll();
          revealTimelineTrack(trackId);
          return;
        }
      };
      document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest("#contextMenu")) hideContextMenu();
        if (!event.target.closest("#trackMenu,#addTrack"))
          $("trackMenu").classList.remove("on");
      });
      function addEmptyTrack(kind) {
        snapshot();
        if (["image", "text"].includes(kind)) kind = "video";
        const trackId = createDynamicTrack(
          kind,
          `${trackMeta[kind]?.label || "素材"}轨道`,
          kind === "audio" ? "audio" : kind === "caption" ? "caption" : "video",
        );
        renderAll();
        revealTimelineTrack(trackId);
      }
      $("timelineScroll").addEventListener("contextmenu", (event) => {
        const clip = event.target.closest(".clip[data-type][data-id]");
        if (clip) {
          if (!isSelected(clip.dataset.type, clip.dataset.id))
            selectItem(clip.dataset.type, clip.dataset.id, false, false);
          const bounds = $("timelineScroll").getBoundingClientRect();
          seekTimeline(
            clamp(
              ($("timelineScroll").scrollLeft + event.clientX - bounds.left) /
                state.zoom,
              0,
              visibleTimelineDuration(),
            ),
          );
          if (clip.dataset.type === "review") {
            const reviewId = clip.dataset.id;
            const reviewIds=(state.selectedItems||[]).filter(item=>item.type==='review').map(item=>item.id);
            if(!reviewIds.includes(reviewId))reviewIds.push(reviewId);
            showContextMenu(event, [
              ...(reviewIds.length>1 ? [
                {label:'批量采用识别文案（'+reviewIds.length+' 个）',action:()=>batchReviewAction(reviewIds,'spoken')},
                {label:'批量采用正确文案（'+reviewIds.length+' 个）',action:()=>batchReviewAction(reviewIds,'expected')},
                {label:'批量删除对应紫色字幕（保留音视频）',danger:true,action:()=>batchReviewAction(reviewIds,'deleteCaptions')},
              ] : []),
              ...(state.reviewCaptions.find(r => r.id === reviewId)?.type === 'repeat'
                ? [{label:'删除重复片段（含字幕和音视频）',danger:true,action:()=>deleteRepeatedReview(reviewId)}] : []),
              { label: "试听这段", action: () => auditionReviewSegment(reviewId) },
              { label: "用识别文案替换", action: () => replaceReviewWithSpoken(reviewId) },
              ...(state.reviewCaptions.find(r => r.id === reviewId)?.type === 'mismatch'
                ? [{ label: "用正确文案替换", action: () => replaceReviewCaption(reviewId) }] : []),
              { label: "编辑字幕", action: () => manuallyEditReviewCaption(reviewId) },
              { label: "删除提示（保留字幕和音视频）", action: () => {snapshot();dismissReviewHints([reviewId]);} },
            ]);
            return;
          }
          showContextMenu(event, [
            { label: "在播放头切割经过的片段", action: () => splitSelected() },
            { label: "复制素材（Ctrl+C）", action: () => copyTimelineClips() },
            { label: "覆盖粘贴（Ctrl+V）", action: () => pasteTimelineClips() },
            { label: "插入粘贴", action: () => pasteTimelineClips(state.currentTime,"insert") },
            { label: "在末尾生成副本（Ctrl+D）", action: () => duplicateTimelineClips() },
            { label: "删除所选片段", danger: true, action: () => deleteSelected(false) },
            { label: "删除并前移", danger: true, action: () => deleteSelected(true) },
            { label: "合并所选相邻切片", action: () => mergeSelectedClips() },
            { label: "新建复合片段", action: () => createCompoundFromSelection() },
            { label: "解除复合片段", action: () => decomposeSelectedCompound() },
          ]);
          return;
        }
        const row = event.target.closest(".trackrow[data-track-key]");
        const bounds = $("timelineScroll").getBoundingClientRect();
        const clickTime = clamp(
          ($("timelineScroll").scrollLeft + event.clientX - bounds.left) / state.zoom,
          0,
          visibleTimelineDuration(),
        );
        const trackId = row?.dataset.trackKey || "";
        const gap = trackId
          ? (selectedTimelineGapAt(trackId, clickTime) || findTimelineGap(timelineGapItems(trackId), clickTime))
          : null;
        seekTimeline(clickTime);
        if (gap) {
          showContextMenu(event, [
            { label: "覆盖粘贴（Ctrl+V）", action: () => pasteTimelineClips() },
            { label: "插入粘贴", action: () => pasteTimelineClips(state.currentTime,"insert") },
            {
              label: "波纹删除",
              danger: true,
              action: () => rippleDeleteTimelineGap(trackId, gap),
            },
          ]);
          return;
        }
        showContextMenu(event, [
          { label: "添加文字", action: () => addText() },
          { label: "覆盖粘贴（Ctrl+V）", action: () => pasteTimelineClips() },
            { label: "插入粘贴", action: () => pasteTimelineClips(state.currentTime,"insert") },
          { label: "新增视频轨道", action: () => addEmptyTrack("video") },
          { label: "新增音频轨道", action: () => addEmptyTrack("audio") },
          { label: "新增字幕轨道", action: () => addEmptyTrack("caption") },
        ]);
      });
      $("stage").addEventListener("contextmenu", (event) => {
        const object = currentObject();
        showContextMenu(event, [
          object && { label: "居中", action: () => { object.x = 0; object.y = 0; renderAll(); } },
          object && { label: "适应画布", action: () => { object.x = 0; object.y = 0; object.scale = 1; object.rotation = 0; renderAll(); } },
          state.video?.path && state.selected.type === "video" && { label: "在访达中显示素材", action: () => nativeCall("revealFile", state.video.path) },
          object && { label: "删除所选素材", danger: true, action: () => deleteSelected(false) },
        ]);
      });
      document.addEventListener("contextmenu", (event) => {
        if (event.defaultPrevented) return;
        const editable = event.target.closest("textarea,input[type='text'],input:not([type])");
        if (editable) {
          showContextMenu(event, [
            { label: "全选", action: () => editable.select() },
            { label: "复制", action: () => document.execCommand("copy") },
            { label: "剪切", action: () => document.execCommand("cut") },
            { label: "粘贴", action: async () => {
              const text = await nativeCall("readClipboard");
              editable.setRangeText(text, editable.selectionStart, editable.selectionEnd, "end");
              editable.dispatchEvent(new Event("input", { bubbles: true }));
            } },
            { label: "清空", danger: true, action: () => { editable.value = ""; editable.dispatchEvent(new Event("input", { bubbles: true })); } },
          ]);
          return;
        }
        event.preventDefault();
      });
      let trackHeightDrag = null;
      function startTrackHeightDrag(event, key, label, row, grip) {
        if (event.button !== 0) return;
        const current = Math.max(56, Number(state.trackHeights?.[key] || row?.offsetHeight || label?.offsetHeight || 68));
        beginTimelineGesture();
        trackHeightDrag = {
          pointer: event.pointerId,
          key,
          label,
          row,
          grip,
          startY: event.clientY,
          startHeight: current,
        };
        label?.classList.add("resizing");
        row?.classList.add("resizing-track");
        grip?.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }
      $("trackLabels").addEventListener("pointerdown", (event) => {
        const grip = event.target.closest("[data-resize-track]");
        if (!grip) return;
        const key = grip.dataset.resizeTrack;
        startTrackHeightDrag(event, key, grip.closest(".tracklabel"), $("timelineContent")?.querySelector(`.trackrow[data-track-key="${CSS.escape(key)}"]`), grip);
      });
      $("timelineContent").addEventListener("pointerdown", (event) => {
        const row = event.target.closest(".trackrow[data-track-key]");
        if (!row || event.target.closest(".clip")) return;
        const rect = row.getBoundingClientRect();
        if (event.clientY < rect.bottom - 7) return;
        const key = row.dataset.trackKey;
        startTrackHeightDrag(
          event,
          key,
          $("trackLabels")?.querySelector(`.tracklabel[data-track-key="${CSS.escape(key)}"]`),
          row,
          row,
        );
      });
      document.addEventListener("pointermove", (event) => {
        if (!trackHeightDrag || trackHeightDrag.pointer !== event.pointerId) return;
        const height = Math.round(clamp(
          trackHeightDrag.startHeight + event.clientY - trackHeightDrag.startY,
          56,
          220,
        ));
        state.trackHeights ||= {};
        state.trackHeights[trackHeightDrag.key] = height;
        if (trackHeightDrag.label) trackHeightDrag.label.style.height = `${height}px`;
        const row = trackHeightDrag.row || $("timelineContent").querySelector(
          `.trackrow[data-track-key="${trackHeightDrag.key}"]`,
        );
        if (row) {
          row.style.height = `${height}px`;
          row.querySelectorAll(".clip").forEach((clip) => {
            clip.style.top = "3px";
            clip.style.height = `${Math.max(33, height - 7)}px`;
          });
        }
        event.preventDefault();
      });
      document.addEventListener("pointerup", (event) => {
        if (!trackHeightDrag || trackHeightDrag.pointer !== event.pointerId) return;
        trackHeightDrag.label?.classList.remove("resizing");
        trackHeightDrag.row?.classList.remove("resizing-track");
        trackHeightDrag = null;
        applyLayout();
        renderTimeline();
        commitTimelineGesture();
      });
      $("trackLabels").addEventListener("dblclick", (event) => {
        const grip = event.target.closest("[data-resize-track]");
        if (!grip) return;
        runTimelineCommand("恢复轨道默认高度", {
          recompute: false,
          render: "timeline",
        }, () => {
          state.trackHeights ||= {};
          state.trackHeights[grip.dataset.resizeTrack] = 68;
          return true;
        });
        event.preventDefault();
      });
      $("trackLabels").onclick = (event) => {
        const syncButton = event.target.closest('[data-sync-track]');
        if(syncButton){
          const key=syncButton.dataset.syncTrack;
          runTimelineCommand('切换轨道同步锁',{recompute:false,render:'timeline'},()=>{
            state.trackSyncLocks ||= {};state.trackSyncLocks[key]=!isTrackSyncLocked(key);return true;
          });
          toast(`${trackInfo(key).label}同步锁已${state.trackSyncLocks[key]?'开启':'关闭'}`);return;
        }
        const autoButton = event.target.closest("[data-auto-track]");
        if (autoButton) {
          const key = autoButton.dataset.autoTrack;
          runTimelineCommand("切换自动轨道选择", { recompute: false, render: "timeline" }, () => {
            state.trackAutoSelect ||= {};
            state.trackAutoSelect[key] = !isTrackAutoSelected(key);
            return true;
          });
          toast(`${trackInfo(key).label}自动选择已${state.trackAutoSelect[key] ? "开启" : "关闭"}`);
          return;
        }
        const muteButton = event.target.closest("[data-mute-track]");
        if (muteButton) {
          const key = muteButton.dataset.muteTrack;
          runTimelineCommand("切换轨道静音", { recompute: false }, () => {
            state.trackMute ||= {};
            state.trackMute[key] = !state.trackMute[key];
            return true;
          });
          toast(`${trackInfo(key).label}已${state.trackMute[key] ? "静音" : "取消静音"}`);
          return;
        }
        const soloButton = event.target.closest("[data-solo-track]");
        if (soloButton) {
          const key = soloButton.dataset.soloTrack;
          runTimelineCommand("切换轨道独听", { recompute: false }, () => {
            state.trackSolo ||= {};
            state.trackSolo[key] = !state.trackSolo[key];
            return true;
          });
          return;
        }
        const heightButton = event.target.closest("[data-height-track]");
        if (heightButton) {
          const key = heightButton.dataset.heightTrack;
          const delta = Number(heightButton.dataset.heightDelta || 12);
          const current = Number(state.trackHeights?.[key] || 68);
          runTimelineCommand("调整轨道高度", { recompute: false, render: "timeline" }, () => {
            state.trackHeights ||= {};
            state.trackHeights[key] = clamp(current + delta, 68, 220);
            return true;
          });
          return;
        }
        const button = event.target.closest("[data-toggle-track]");
        if (!button) return;
        const key = button.dataset.toggleTrack;
        runTimelineCommand("切换轨道显示", { recompute: false }, () => {
          state.trackVisibility[key] = state.trackVisibility[key] === false;
          return true;
        });
      };
      $("linkAV").onclick = () => {
        const previousAudioClips = mainAudioClips();
        state.avLinked = !state.avLinked;
        if (!state.avLinked) {
          state.mainAudioTimelineOffset = Number(state.mainTimelineOffset || 0);
          state.mainAudioClipOffsets = {
            ...(state.mainVideoClipOffsets || {}),
          };
          prepareIndependentMainAudio();
          adoptMainAudioMaps(previousAudioClips);
        }
        state.audio.offset = 0;
        $("linkAV")?.classList.toggle("active", state.avLinked);
        $("linkAV")?.classList.toggle("primary", state.avLinked);
        $("linkAV").title = state.avLinked
          ? "联动选择：成组音画一起移动和删除"
          : "联动选择已关闭，音画可独立调整";
        toast(state.avLinked ? "联动选择已开启：成组音画一起选、移、剪、删" : "联动选择已关闭：各片段独立调整");
        renderTimeline();
        queueAutosave();
      };
      $("snapToggle").onclick = toggleSnapping;
      if ($("selectionFollowsPlayhead")) {
        $("selectionFollowsPlayhead").onclick = () => {
          state.selectionFollowsPlayhead = !state.selectionFollowsPlayhead;
          $("selectionFollowsPlayhead").classList.toggle("active", state.selectionFollowsPlayhead);
          if (state.selectionFollowsPlayhead) scheduleSelectionFollowsPlayhead();
          queueAutosave();
          toast(`播放头跟随选择已${state.selectionFollowsPlayhead ? "开启" : "关闭"}`);
        };
      }
      if ($("mergeClips")) $("mergeClips").onclick = mergeSelectedClips;
      if ($("createCompoundClip")) $("createCompoundClip").onclick = createCompoundFromSelection;
      $("stepBack").onclick = () => seekTimeline(state.currentTime - 1 / 30);
      $("stepForward").onclick = () => seekTimeline(state.currentTime + 1 / 30);
      if ($("jumpPrevCut")) $("jumpPrevCut").onclick = () => jumpToCutPoint("prev");
      if ($("jumpNextCut")) $("jumpNextCut").onclick = () => jumpToCutPoint("next");
      if ($("trimLeft")) $("trimLeft").onclick = () => trimAtPlayhead("left");
      if ($("trimRight")) $("trimRight").onclick = () => trimAtPlayhead("right");
      if ($("freezeFrame")) $("freezeFrame").onclick = createFreezeFrame;
      if ($("zoomOutBtn")) $("zoomOutBtn").onclick = () => setTimelineZoomAroundPlayhead(state.zoom * 0.85);
      if ($("zoomInBtn")) $("zoomInBtn").onclick = () => setTimelineZoomAroundPlayhead(state.zoom * 1.18);
      $("splitClip").onclick = splitSelected;
      if ($("selectAfterPlayhead")) $("selectAfterPlayhead").onclick = selectAfterPlayhead;
      if ($("timelineEditMode")) {
        $("timelineEditMode").value = state.timelineEditMode || "overwrite";
        $("timelineEditMode").onchange = () => {
          const value = $("timelineEditMode").value;
          if (!["overwrite", "insert", "place-on-top"].includes(value)) return;
          state.timelineEditMode = value;
          queueAutosave();
          toast(`时间线拖放模式：${value === "insert" ? "插入" : value === "place-on-top" ? "置于顶层" : "覆盖"}`);
        };
      }
      if ($("selectTool"))
        $("selectTool").onclick = () => {
          setEditTool("select");
          toast("选择模式 (A)：修剪当前片段，前后锁定不动");
        };
      if ($("trimTool"))
        $("trimTool").onclick = () => {
          setEditTool(editTool === "trim" ? "select" : "trim");
          toast(editTool === "trim" ? "波纹修剪模式 (T)：拖动边缘全轨推移" : "选择模式 (A)");
        };
      if ($("bladeTool"))
        $("bladeTool").onclick = () => {
          setEditTool(editTool === "blade" ? "select" : "blade");
          toast(editTool === "blade" ? "剃刀模式 (B)：点击片段切割" : "选择模式 (A)");
        };
      $("deleteClip").onclick = () => deleteSelected(true);
      $("rippleDelete").onclick = () => deleteSelected(false);
      $("undo").onclick = restoreSnapshot;
      $("redo").onclick = redoSnapshot;
      $("openProject").onclick = openProject;
      $("resetProject").onclick = () => {
        askConfirm(
          "确定重置整个工程？所有轨道、素材和参数都会清空，原素材会移入工程的重置历史目录。",
          async () => {
            const reset = await nativeCall("resetProject", state.projectId);
            await enterProject(reset);
            toast("工程已恢复到初始状态");
          },
          "重置工程",
        );
      };
      $("clearProjectCache").onclick = () => {
        askConfirm(
          "只清理当前工程生成的缩略图、预览图和旧版复制素材。原始本地文件不会被删除；旧版缓存素材如果没有原文件，需要之后重新导入或关联。",
          async () => {
            const result = await nativeCall("clearProjectCache", state.projectId);
            await enterProject(result.project);
            toast(`当前工程缓存已清理（${result.removed || 0} 项）`);
          },
          "清理当前工程缓存",
        );
      };
      $("exportVideo").onclick = openExportSettings;
      $("sendResolve").onclick = sendCaptionsToResolve;
      $("openResolveLog").onclick = () => nativeCall("revealResolveLog").catch((error) => toast(error.message));
      $("closeSendResolve").onclick = () => $("sendResolveModal").classList.remove("on");
      $("sendResolveModal").onclick = (event) => {
        if (event.target === $("sendResolveModal") && !$("closeSendResolve").disabled)
          $("sendResolveModal").classList.remove("on");
      };
      $("exportResolve").onclick = exportResolveTimeline;
      $("exportSettingsCancel").onclick = () =>
        $("exportSettingsModal").classList.remove("on");
      $("exportSettingsConfirm").onclick = exportVideo;
      $("exportSpeedMode").onchange = () => {
        $("exportSpeedValue").disabled = $("exportSpeedMode").value !== "custom";
        updateExportSummary();
      };
      $("exportSpeedValue").oninput = updateExportSummary;
      for (const id of [
        "exportFormat", "exportResolution", "exportFps", "exportCodec", "exportRf",
        "exportBitrate", "exportQuality", "exportColorSpace",
      ]) $(id).addEventListener("change", updateExportSummary);
      $("exportQuality").addEventListener("change", updateExportSummary);
      $("exportRf").addEventListener("input", updateExportSummary);
      if ($("exportUseGpu"))
        $("exportUseGpu").onchange = () => {
          if ($("exportUseGpu").checked) applyExportDevice("gpu");
          else applyExportDevice("cpu");
          persistExportDevice();
          updateExportSummary();
        };
      if ($("exportUseCpu"))
        $("exportUseCpu").onchange = () => {
          if ($("exportUseCpu").checked) applyExportDevice("cpu");
          else applyExportDevice("gpu");
          persistExportDevice();
          updateExportSummary();
        };
      if ($("refreshExportHardware"))
        $("refreshExportHardware").onclick = async () => {
          const button = $("refreshExportHardware");
          button.disabled = true;
          button.textContent = "检测中…";
          try {
            const hardware = await loadExportHardware(true);
            updateExportSummary();
            toast(hardware.vendor === "software"
              ? "未检测到可实际编码的独显；请确认驱动完整安装"
              : `已识别 ${hardware.label || hardware.vendor}`);
          } catch (error) {
            toast(error.message);
          } finally {
            button.disabled = false;
            button.textContent = "重新检测显卡";
          }
        };
      $("exportColorSpace").onchange = (event) => {
        if (["hlg", "pq"].includes(event.target.value)) {
          $("exportCodec").value = "hevc";
          toast("HDR 色彩空间已自动选用 H.265 / HEVC 10-bit 导出");
        }
        updateExportSummary();
      };
      $("previewDenoise").onclick = previewDenoise;
      $("applyDenoiseTrack").onclick = applyDenoiseToTrack;
      $("analyzeDenoiseNoise").onclick = analyzeDenoiseNoise;
      if ($("revertDenoisedTrack")) $("revertDenoisedTrack").onclick = revertDenoisedTrack;
      $("trimLeft").onclick = () => trimAtPlayhead("left");
      $("trimRight").onclick = () => trimAtPlayhead("right");
      if ($("freezeFrame")) $("freezeFrame").onclick = createFreezeFrame;
      $("resetColor").onclick = () => {
        const grade = selectedVideoGrade?.(true);
        if (!grade) { toast("请先在时间轨上选中一个视频片段。"); return; }
        snapshot();
        Object.keys(grade).forEach((k) => {
          if (k !== "slices") grade[k] = 0;
        });
        grade.slices = defaultColorSlices();
        colorControls();
        applyVideoCss();
        renderFilterPanel();
        queueAutosave();
      };
      const gradePresets = {
        auto: { exposure: 4, contrast: 10, pivot: 3, shadows: 7, highlights: -9, blacks: -3, whites: 4, saturation: 5, vibrance: 8, sharpness: 8 },
        flat: { exposure: 5, contrast: -7, shadows: 12, highlights: -16, blacks: 4, whites: -3, saturation: -4, vibrance: 8, temperature: 3, midtoneDetail: -6, sharpness: 4 },
        cinema: { exposure: -2, contrast: 22, pivot: -4, shadows: -9, highlights: -12, blacks: -10, whites: 7, saturation: -8, vibrance: 12, temperature: 4, midtoneDetail: 9, sharpness: 12, vignette: 14 },
      };
      document.querySelectorAll("[data-grade-preset]").forEach((button) => {
        button.onclick = () => {
          const grade = selectedVideoGrade?.(true);
          if (!grade) { toast("请先在时间轨上选中一个视频片段。"); return; }
          snapshot();
          Object.keys(grade).forEach((key) => {
            if (key !== "slices") grade[key] = 0;
          });
          grade.slices = defaultColorSlices();
          Object.assign(grade, gradePresets[button.dataset.gradePreset] || {});
          colorControls();
          applyVideoCss();
          renderFilterPanel();
          queueAutosave();
          toast(`已应用${button.textContent.trim()}校色`);
        };
      });
      $("toggleColor").onclick = () => {
        state.colorBypass = !state.colorBypass;
        applyVideoCss();
        $("toggleColor").textContent = state.colorBypass
          ? "显示调色后"
          : "对比原片";
      };
      $("resetBeauty").onclick = () => {
        snapshot();
        Object.keys(state.beauty).forEach((key) => (state.beauty[key] = 0));
        beautyControls();
        applyVideoCss();
        queueAutosave();
      };
      $("toggleBeauty").onclick = () => {
        state.beautyBypass = !state.beautyBypass;
        applyVideoCss();
        $("toggleBeauty").textContent = state.beautyBypass
          ? "显示美颜后"
          : "对比原片";
      };
      document
        .querySelectorAll("[data-ratio]")
        .forEach((b) => (b.onclick = () => setRatio(b.dataset.ratio)));
      if ($("previewFullscreen")) $("previewFullscreen").onclick = togglePreviewFullscreen;
      $("resolution").onchange = (e) => {
        [state.width, state.height] = e.target.value.split("x").map(Number);
        updateFrameSize();
      };
      
