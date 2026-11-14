      function currentPauseCutOptions() {
        const mode = $("pauseCutMode")?.value || "professional";
        const fps = sourceFrameRate();
        const minPause = Number($("pauseMinDuration")?.value || 80) / 100;
        const buffer = Number($("pauseBuffer")?.value || 15) / 100;
        const sensitivity = Number($("pauseSensitivity")?.value || 65) / 100;
        const thresholdDb = Number($("pauseThresholdDb")?.value || -25.0);
        const headFrames = Math.max(0, Number($("pauseHeadFrames")?.value || 0));
        const tailFrames = Math.max(0, Number($("pauseTailFrames")?.value || 0));
        const minFrames = Math.max(1, Number($("pauseMinFrames")?.value || 2));
        return {
          keepSeconds: Math.max(0.1, buffer * 2),
          minPauseSeconds: Math.max(0.2, minPause),
          edgeKeepSeconds: Math.max(0.05, buffer),
          wordAttackProtection: Math.max(0.16, buffer + 0.08),
          sensitivity,
          trimCaptionGaps: $("pauseTrimCaptionGaps")?.checked !== false,
          thresholdDb,
          preRollSeconds: headFrames > 0 ? headFrames / fps : undefined,
          postRollSeconds: tailFrames > 0 ? tailFrames / fps : undefined,
          minDurationSeconds: minFrames / fps,
          headFrames,
          tailFrames,
          minFrames,
          mode,
          crossfade: $("pauseCrossfade")?.checked !== false,
        };
      }
      function syncPauseCutSettingsUI(source = "range") {
        if ($("pauseMinDurationOut"))
          $("pauseMinDurationOut").textContent = `${(Number($("pauseMinDuration").value) / 100).toFixed(2)} 秒`;
        if ($("pauseBufferOut"))
          $("pauseBufferOut").textContent = `${(Number($("pauseBuffer").value) / 100).toFixed(2)} 秒`;
        if ($("pauseSensitivityOut"))
          $("pauseSensitivityOut").textContent = `${$("pauseSensitivity").value}%`;
        if (source === "range") {
          if ($("pauseThresholdDbInput")) $("pauseThresholdDbInput").value = Number($("pauseThresholdDb").value).toFixed(1);
          if ($("pauseHeadFramesInput")) $("pauseHeadFramesInput").value = $("pauseHeadFrames").value;
          if ($("pauseTailFramesInput")) $("pauseTailFramesInput").value = $("pauseTailFrames").value;
          if ($("pauseMinFramesInput")) $("pauseMinFramesInput").value = $("pauseMinFrames").value;
        } else if (source === "input") {
          if ($("pauseThresholdDb")) $("pauseThresholdDb").value = $("pauseThresholdDbInput").value;
          if ($("pauseHeadFrames")) $("pauseHeadFrames").value = $("pauseHeadFramesInput").value;
          if ($("pauseTailFrames")) $("pauseTailFrames").value = $("pauseTailFramesInput").value;
          if ($("pauseMinFrames")) $("pauseMinFrames").value = $("pauseMinFramesInput").value;
        }
      }
      function applyPauseCutModePreset() {
        const mode = $("pauseCutMode")?.value || "professional";
        const presets = {
          standard: { min: 50, buffer: 15, sensitivity: 65, hint: "原有保守检测，优先保留呼吸与自然停顿。" },
          professional: { min: 28, buffer: 8, sensitivity: 72, hint: "自适应学习环境底噪，用双门限区分人声与风扇、电流等稳定噪声。" },
          aggressive: { min: 20, buffer: 5, sensitivity: 82, hint: "删除更短气口并减少前后留白，适合节奏紧凑的短视频。" },
        };
        const preset = presets[mode];
        if ($("pauseMinDuration")) $("pauseMinDuration").value = preset.min;
        if ($("pauseBuffer")) $("pauseBuffer").value = preset.buffer;
        if ($("pauseSensitivity")) $("pauseSensitivity").value = preset.sensitivity;
        if ($("pauseCutModeHint")) $("pauseCutModeHint").textContent = preset.hint;
        syncPauseCutSettingsUI("range");
      }
      if ($("pauseCutMode")) {
        $("pauseCutMode").onchange = applyPauseCutModePreset;
        applyPauseCutModePreset();
      }
      for (const id of ["pauseMinDuration", "pauseBuffer", "pauseSensitivity"]) {
        const el = $(id);
        if (el) el.oninput = () => syncPauseCutSettingsUI("range");
      }
      for (const id of ["pauseThresholdDb", "pauseHeadFrames", "pauseTailFrames", "pauseMinFrames"]) {
        const rangeEl = $(id);
        if (rangeEl) rangeEl.oninput = () => syncPauseCutSettingsUI("range");
        const inputEl = $(`${id}Input`);
        if (inputEl) {
          inputEl.oninput = () => syncPauseCutSettingsUI("input");
          inputEl.onchange = () => syncPauseCutSettingsUI("input");
        }
      }
      function openPauseCutSettingsModal() {
        syncPauseCutSettingsUI("range");
        if ($("pauseAnalysisSummary")) $("pauseAnalysisSummary").style.display = "none";
        $("pauseCutModal").classList.add("on");
      }
      function closePauseCutSettingsModal() {
        $("pauseCutModal").classList.remove("on");
      }
      if ($("openPauseCutSettings")) $("openPauseCutSettings").onclick = openPauseCutSettingsModal;
      if ($("pauseCutCancel")) $("pauseCutCancel").onclick = closePauseCutSettingsModal;
      if ($("pauseCutModal")) {
        $("pauseCutModal").onclick = (e) => {
          if (e.target === $("pauseCutModal")) closePauseCutSettingsModal();
        };
      }
      if ($("analyzePauseBtn"))
        $("analyzePauseBtn").onclick = async () => {
          if (!state.video) {
            toast("请先导入视频");
            return;
          }
          const btn = $("analyzePauseBtn");
          btn.disabled = true;
          btn.textContent = "分析中…";
          try {
            const opts = currentPauseCutOptions();
            const result = unwrap(
              await window.native.analyzePauses({
                path: state.denoisedAudio?.path || state.video.path,
                options: opts,
              }),
            );
            const summaryEl = $("pauseAnalysisSummary");
            if (summaryEl) {
              summaryEl.style.display = "block";
              summaryEl.textContent = `分析结果：找到 ${result.pauses.length} 处停顿气口，剪除后预计缩短 ${formatTime((result.removals || []).reduce((acc, r) => acc + (r.duration || 0), 0))}`;
            }
          } catch (e) {
            toast(e.message);
          } finally {
            btn.disabled = false;
            btn.textContent = "重新分析";
          }
        };
      if ($("applyPauseCutBtn"))
        $("applyPauseCutBtn").onclick = async () => {
          closePauseCutSettingsModal();
          await runPauseCut(currentPauseCutOptions());
        };

      async function runPauseCut(customOptions = null, options = {}) {
        return withMediaOperation('正在分析并剪除气口，保留原素材裁切范围…', () => performPauseCut(customOptions, options));
      }
      async function performPauseCut(customOptions = null, { record = true, rethrow = false } = {}) {
        if (!state.video) {
          toast("请先导入视频");
          return;
        }
        const beforePause = JSON.stringify(projectData(true));
        const btn = $("pauseCut");
        btn.disabled = true;
        btn.textContent = "剪停顿中…";
        try {
          if (record) snapshot();
          const opts = customOptions || currentPauseCutOptions();
          const result = unwrap(
            await window.native.analyzePauses({
              path: state.denoisedAudio?.path || state.video.path,
              options: opts,
            }),
          );
          if(state.videoLayers.some(x=>x.path===state.video.path||x.sourceMediaId===state.video.path)){
            const removed=cutSourceMediaPauses(result.removals||[]);state.waveform=result.waveform;
            toast(`已剪除气口，共缩短 ${formatTime(removed)}，可拖动片段边缘恢复`);return;
          }
          const captionSourceClips = mainClips();
          anchorCaptionsToSource(captionSourceClips);
          // Re-analysis replaces prior automatic suggestions but must never
          // resurrect a user's manual deletion or edge trim.
          const preservedManualRemovals = (state.removals || []).filter((range) =>
            !["pause", "edge", "caption-gap"].includes(String(range?.source || "")));
          let allRemovals = [...preservedManualRemovals, ...(result.removals || [])];
          // If trimCaptionGaps is enabled and we have captions, check for long gaps between adjacent captions
          if (opts.trimCaptionGaps && Array.isArray(state.captions) && state.captions.length > 1) {
            const sortedCaptions = [...state.captions].sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
            const minGap = opts.mode === "aggressive"
              ? Math.max(0.20, opts.minPauseSeconds || 0.20)
              : opts.mode === "professional"
                ? Math.max(0.28, opts.minPauseSeconds || 0.28)
                : Math.max(1.0, opts.minPauseSeconds || 0.8);
            for (let i = 0; i < sortedCaptions.length - 1; i++) {
              const capEnd = Number(sortedCaptions[i].end || 0);
              const nextStart = Number(sortedCaptions[i + 1].start || 0);
              const gapDuration = nextStart - capEnd;
              if (gapDuration > minGap + 0.3) {
                const gapStart = capEnd + (opts.edgeKeepSeconds || 0.15);
                const gapCutEnd = nextStart - (opts.edgeKeepSeconds || 0.15);
                if (gapCutEnd > gapStart + 0.1) {
                  const sourceStart = timelineToSource(gapStart);
                  const sourceEnd = timelineToSource(gapCutEnd);
                  if (sourceEnd > sourceStart + 0.1) {
                    allRemovals.push({
                      start: sourceStart,
                      end: sourceEnd,
                      duration: sourceEnd - sourceStart,
                      source: "caption-gap",
                    });
                  }
                }
              }
            }
          }
          state.removals = allRemovals;
          state.waveform = result.waveform;
          normalizeRemovals();
          const droppedCaptionWords = remapCaptionsFromSource(mainClips());
          const cutDuration = removedDuration();
          ripplePauseOverlays(captionSourceClips, state.removals);
          recomputeContentDuration();
          seekTimeline(0);
          renderAll();
          toast(
            `已剪除 ${result.pauses.length} 处气口，共缩短 ${formatTime(cutDuration)}，保留原素材，可拖动片段边缘恢复${droppedCaptionWords ? `；移除 ${droppedCaptionWords} 个已被裁掉音频对应的字幕词` : ""}`,
          );
        } catch (e) {
          if (record) { if (state.undo.at(-1)===beforePause) state.undo.pop(); applyHistoryState(JSON.parse(beforePause)); queueAutosave(); }
          toast('剪气口未完成，原工程已保留：'+e.message);
          if (rethrow) throw e;
        } finally {
          btn.disabled = false;
          btn.textContent = "自动剪停顿";
        }
      }
      function splitMainClipAt(clip, time, audioOnly = false) {
        if (!audioOnly || state.avLinked) time = frameAlignedTime(time);
        if (!clip || !playheadInside(clip, time)) return false;
        if (audioOnly && !state.avLinked) {
          const trackId = state.mainAudioTrackMap?.[clip.id];
          const sourceCut = Number(clip.sourceStart || 0) +
            (Number(time) - Number(clip.start || 0)) *
              Math.max(0.05, Number(state.audio.speed || 1));
          state.mainAudioManualCuts ||= [...(state.manualCuts || [])];
          state.mainAudioManualCuts.push(sourceCut);
          state.mainAudioManualCuts.sort((left, right) => left - right);
          if (trackId) {
            delete state.mainAudioTrackMap[clip.id];
            for (const next of mainAudioClips().filter(
              (item) => item.start >= clip.start - 0.01 && item.end <= clip.end + 0.01,
            ))
              state.mainAudioTrackMap[next.id] = trackId;
          }
          return true;
        }
        const videoTrack = state.mainVideoTrackMap?.[clip.id];
        const audioTrack = state.mainAudioTrackMap?.[clip.id];
        const videoOffset = Number(state.mainVideoClipOffsets?.[clip.id] || 0);
        const audioOffset = Number(state.mainAudioClipOffsets?.[clip.id] || 0);
        const clipRate = (Number(clip.sourceEnd) - Number(clip.sourceStart)) / (Number(clip.end) - Number(clip.start));
        state.manualCuts.push(Number(clip.sourceStart) + (time - Number(clip.start)) * clipRate);
        delete state.mainVideoTrackMap[clip.id];
        delete state.mainAudioTrackMap[clip.id];
        delete state.mainVideoClipOffsets[clip.id];
        delete state.mainAudioClipOffsets[clip.id];
        for (const next of mainClips().filter(
          (item) =>
            item.sourceStart >= clip.sourceStart - 0.01 &&
            item.sourceEnd <= clip.sourceEnd + 0.01,
        )) {
          state.mainVideoClipOffsets[next.id] = videoOffset;
          state.mainAudioClipOffsets[next.id] = audioOffset;
          if (videoTrack) state.mainVideoTrackMap[next.id] = videoTrack;
          if (audioTrack) state.mainAudioTrackMap[next.id] = audioTrack;
        }
        return true;
      }
      function splitOverlayObject(type, id, time) {
        const obj = timelineObjectFor(type, id);
        if (!obj || selectionIsLocked(type, id) || !playheadInside(obj, time))
          return false;
        const originalStart = Number(obj.start || 0);
        const originalSourceStart = Number(obj.sourceStart || 0);
        const sourceRate=editRate(obj,Number(state.audio.speed||1));
        const sourceEnd=Number(obj.sourceStart||0)+(obj.end-obj.start)*sourceRate;
        const split = splitTimedItem(obj, time, uid());
        if (!split) return false;
        const clone = split.right;
        if (["videolayer", "audioasset"].includes(type)) {
          // A split tail must not claim the original instance's A/V partner.
          delete clone.linkedAudioId;
          delete clone.linkedVideoId;
          delete clone.linkGroupId;
          clone.sourceStart =
            originalSourceStart +
            (time - originalStart) * sourceRate;
          obj.sourceEnd=clone.sourceStart;clone.sourceEnd=sourceEnd;
          splitBoundCaptions(obj,clone);
          if (obj.linkGroupId && state.avLinked) {
            const linked = [...state.videoLayers, ...state.audioAssets].find(
              (item) => item !== obj && item.linkGroupId === obj.linkGroupId,
            );
            if (linked && !selectionIsLocked(state.videoLayers.includes(linked) ? "videolayer" : "audioasset", linked.id) && playheadInside(linked, time)) {
              const secondGroup = uid();
              const linkedStart = Number(linked.start || 0);
              const linkedSource = Number(linked.sourceStart || 0);
              const linkedRate=editRate(linked,Number(state.audio.speed||1)),linkedEnd=linkedSource+(linked.end-linkedStart)*linkedRate;
              const linkedSplit = splitTimedItem(linked, time, uid());
              if (linkedSplit) {
                const linkedClone = linkedSplit.right;
                linkedClone.sourceStart =
                  linkedSource +
                  (time - linkedStart) * linkedRate;
                linked.sourceEnd=linkedClone.sourceStart;linkedClone.sourceEnd=linkedEnd;
                splitBoundCaptions(linked,linkedClone);
                linkedClone.linkGroupId = secondGroup;
                clone.linkGroupId = secondGroup;
                if (type === "videolayer") {
                  clone.linkedAudioId = linkedClone.id;
                  linkedClone.linkedVideoId = clone.id;
                  state.audioAssets.push(linkedClone);
                } else {
                  clone.linkedVideoId = linkedClone.id;
                  linkedClone.linkedAudioId = clone.id;
                  state.videoLayers.push(linkedClone);
                }
              }
            }
          }
        }
        if (type === "videolayer") state.videoLayers.push(clone);
        if (type === "audioasset") state.audioAssets.push(clone);
        if (type === "image") state.images.push(clone);
        if (type === "text") state.titles.push(clone);
        if (type === "caption") state.captions.push(clone);
        if (type === "review") state.reviewCaptions.push(clone);
        return true;
      }
      function splitClipsAt(time, targets, { record = true, quiet = false, materializeMain = true } = {}) {
        if (state.video?.analysisPending && !Number(state.video?.frameRate)) { toast("正在读取素材帧率，请稍后切片"); return false; }
        if (state.avLinked || (targets || []).some(item => !["audio", "audioasset"].includes(item.type))) time = frameAlignedTime(time);
        let hits = (targets || []).filter(
          (item) => item?.id && item.id !== "main" && !selectionIsLocked(item.type, item.id),
        );
        if (!hits.length) return false;
        if (record) snapshot();
        if (materializeMain) {
          const savedSelection=state.selectedItems;
          state.selectedItems=hits;
          for(const hit of [...hits])if(['video','audio'].includes(hit.type))materializeMainSegment(hit.type,hit.id);
          hits=state.selectedItems;state.selectedItems=savedSelection.map(item=>hits.find(x=>x.id===item.id)||item);
        }
        let cut = 0;
        const seen = new Set();
        const mark = (type, id) => {
          const key = `${type}:${id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        };
        for (const hit of hits) {
          if (hit.type === "video") {
            const clip = mainClips().find((item) => item.id === hit.id);
            if (mark("video", hit.id) && splitMainClipAt(clip, time, false)) cut += 1;
            continue;
          }
          if (hit.type === "audio") {
            const clip = mainAudioClips().find((item) => item.id === hit.id);
            if (mark("audio", hit.id) && splitMainClipAt(clip, time, true)) cut += 1;
            continue;
          }
          if (!mark(hit.type, hit.id)) continue;
          if (splitOverlayObject(hit.type, hit.id, time)) {
            cut += 1;
            if (state.avLinked) {
              for (const partner of linkedTimelineObjects(hit.type, hit.id))
                seen.add(`${partner.type}:${partner.id}`);
            }
          }
        }
        if (!cut) {
          if (record) state.undo.pop();
          return false;
        }
        if (!quiet) {
          renderAll();
          toast(`已在 ${formatTime(time)} 切割 ${cut} 个片段`);
        }
        return true;
      }
      function splitSelected() {
        const time = state.currentTime;
        const selectedCaption = state.selected?.type === "caption"
          ? timelineObjectFor("caption", state.selected.id)
          : null;
        const under = selectedCaption && playheadInside(selectedCaption, time)
          ? [{ type: "caption", id: selectedCaption.id }]
          : clipsUnderPlayhead(time);
        if (!under.length) {
          toast("把播放头放到要切的片段上，再按切割");
          return;
        }
        splitClipsAt(time, under);
      }
      function trimAtPlayhead(side) {
        const time = frameAlignedTime(state.currentTime);
        let chosen=resolveWorkingSelection(state.selectedItems?.length?state.selectedItems:[state.selected]).find(x=>['video','audio','videolayer','audioasset'].includes(x.type)&&!selectionIsLocked(x.type,x.id));
        if(chosen){
          const original=timelineObjectFor(chosen.type,chosen.id)|| (chosen.type==='video'?mainClips():mainAudioClips()).find(x=>x.id===chosen.id);
          if(original&&playheadInside(original,time)){
            snapshot();if(['video','audio'].includes(chosen.type))chosen=materializeMainSegment(chosen.type,chosen.id)||chosen;
            const object=timelineObjectFor(chosen.type,chosen.id),edge=side==='left'?'start':'end';
            const linked=[object,...linkedTimelineObjects(chosen.type,chosen.id).filter(x=>!selectionIsLocked(x.type,x.id)).map(x=>x.obj)];
            const oldEnd=object.end,oldDuration=object.end-object.start;
            const next=editLinkedTrim(linked,edge,time-object[edge],{fps:timelineFrameRate(),ripple:editTool==='trim',bounds:linked.map(x=>editTool==='trim'?{}:editNeighborBounds(x,state.videoLayers.includes(x)?'videolayer':'audioasset'))});
            linked.forEach((x,i)=>Object.assign(x,next[i]));
            if(editTool==='trim')applyEditRipple(oldEnd,object.end-object.start-oldDuration,linked);
            remapCaptionsFromSource(mainClips());recomputeContentDuration();renderAll();return;
          }
        }
        const working = resolveWorkingSelection(
          (state.selectedItems || []).length
            ? state.selectedItems
            : state.selected?.id
              ? [state.selected]
              : [],
        );
        const selectedOverlay = working
          .map((item) => ({ ...item, obj: timelineObjectFor(item.type, item.id) }))
          .find((item) => item.obj && playheadInside(item.obj, time, 0.02));
        if (state.selected.type === "audio" && !state.avLinked) {
          const clip =
            mainAudioClips().find((item) => item.id === state.selected.id) ||
            clipUnderPlayhead("audio", time);
          if (!clip || !playheadInside(clip, time, 0.02)) {
            toast("把播放头放到要剪的音频片段上");
            return;
          }
          snapshot();
          state.audioMutes.push(
            side === "left"
              ? { start: clip.start, end: time }
              : { start: time, end: clip.end },
          );
          trimSubtitleTimeline(
            side === "left" ? clip.start : time,
            side === "left" ? time : clip.end,
          );
          renderAll();
          return;
        }
        const mainClip =
          (["video", "audio"].includes(state.selected.type) &&
            mainClips().find((item) => item.id === state.selected.id)) ||
          clipUnderPlayhead("video", time);
        if (mainClip && playheadInside(mainClip, time, 0.02) && !selectedOverlay) {
          if (isTrackLocked(selectionTrackId("video", mainClip.id))) {
            toast("这个轨道已锁定，请先点击轨道前方的锁");
            return;
          }
          snapshot();
          const sourceAt = timelineToSource(time);
          const snapshotClips = mainClips();
          const committed = commitMainEdgeTrim({
            clip: mainClip,
            edge: side === "left" ? "start" : "end",
            targetSource: sourceAt,
            mode: "ripple",
            snapshot: snapshotClips,
          });
          state.removals = committed.removals;
          state.manualCuts = committed.manualCuts;
          normalizeRemovals();
          state.mainVideoClipOffsets = committed.videoOffsets;
          state.mainAudioClipOffsets = committed.audioOffsets;
          adoptClipMaps(snapshotClips, committed.packed);
          applyOverlayRipple(committed.overlayFrom, committed.overlayDelta);
          recomputeContentDuration();
          seekTimeline(Math.min(side === "left" ? mainClip.start : time, state.duration));
          renderAll();
          return;
        }
        const object = selectedOverlay?.obj || currentTimelineObject();
        if (!object || !playheadInside(object, time, 0.02)) {
          toast("把播放头放到要剪的片段上");
          return;
        }
        if (!guardUnlocked(selectedOverlay?.type || state.selected.type, object.id))
          return;
        snapshot();
        const originStart = Number(object.start || 0);
        const originEnd = Number(object.end || originStart);
        if (side === "left")
          object.start = clamp(time, object.start, object.end - 0.04);
        else object.end = clamp(time, object.start + 0.04, object.end);
        if ((selectedOverlay?.type || state.selected.type) === "caption")
          clampCaptionWordsToBounds(object);
        if (editTool === "trim") {
          const delta = (Number(object.end) - Number(object.start)) - (originEnd - originStart);
          const type = selectedOverlay?.type || state.selected.type;
          const list =
            type === "videolayer"
              ? state.videoLayers
              : type === "audioasset"
                ? state.audioAssets
                : type === "image"
                  ? state.images
                  : type === "text"
                    ? state.titles
                    : type === "caption"
                      ? state.captions
                      : type === "review"
                        ? state.reviewCaptions
                        : null;
          const from = side === "left" ? originStart : Math.min(originEnd, Number(object.end));
          if (delta < -0.001 && list)
            rippleOverlayTrack(list, overlayTrackId(type, object), type, from, from - delta);
          else if (delta > 0.001 && list) {
            for (const item of list) {
              if (item === object || overlayTrackId(type, item) !== overlayTrackId(type, object)) continue;
              if (Number(item.start || 0) < from - 0.002) continue;
              item.start = Number(item.start || 0) + delta;
              item.end = Number(item.end || 0) + delta;
            }
          }
        }
        if (state.avLinked && object.linkGroupId) {
          const linked = [...state.videoLayers, ...state.audioAssets].find(
            (item) => item !== object && item.linkGroupId === object.linkGroupId,
          );
          if (linked) {
            linked.start = object.start;
            linked.end = object.end;
          }
        }
        renderAll();
      }
      async function createFreezeFrame() {
        if (!state.video) {
          toast("请先导入视频");
          return;
        }
        try {
          const still = await withMediaOperation('正在截取当前画面并加入素材区…', async () => {
            const config = timelineSceneConfig(); config.time=Math.floor(state.currentTime*config.fps+1e-6)/config.fps;
            const rasters=await rasterizeCaptionsForExport(config.time);
            config.images.push(...rasters.images);config.captionRasterized=rasters.images.length>0;
            config.captionRasterDirectory=rasters.directory;
            return nativeCall('captureTimelineStill',{projectId:state.projectId,config});
          });
          if (!still) return;
          await importImage(still, "media", state.currentTime);
          queueAutosave();
          toast("静帧已截取并加入素材区");
        } catch (error) {
          toast(error.message);
        }
      }
      function cleanupEmptyDynamicTracks() {
        for (const trackId of [...state.trackOrder]) {
          const info = trackInfo(trackId);
          if (info.deletable && !trackItems(trackId).length) {
            state.trackOrder = state.trackOrder.filter((id) => id !== trackId);
            delete state.trackDefinitions[trackId];
            delete state.trackVisibility[trackId];
          }
        }
        renumberTrackLabels();
      }
      function clearOrPromoteMainVideo() {
        const candidate = [...state.videoLayers].sort((a, b) => a.start - b.start)[0];
        $("video").pause();
        if (candidate) {
          const inheritedSpeed = Math.max(
            0.5,
            Number(state.audio.speed || 1),
          );
          const duration = Math.max(
            0.04,
            Number(candidate.sourceDuration || candidate.end - candidate.start),
          );
          resetMainMediaModifiers();
          state.video = {
            id: candidate.libraryId || candidate.id,
            kind: "video",
            path: candidate.path,
            url: candidate.url,
            name: candidate.name,
            duration,
            width: candidate.width,
            height: candidate.height,
            videoCodec: candidate.videoCodec,
            audioCodec:
              candidate.audioCodec ||
              (candidate.linkedAudioId ? "linked" : undefined),
            previewPath: candidate.previewPath || "",
            previewUrl: candidate.previewUrl || "",
            waveform: candidate.waveform || [],
          };
          state.sourceDuration = duration;
          state.waveform = candidate.waveform || [];
          state.denoisedAudio = null;
          state.videoTransform = {
            x: Number(candidate.x || 0),
            y: Number(candidate.y || 0),
            scale: Number(candidate.scale || 1),
          };
          const sourceStart = Math.max(0, Number(candidate.sourceStart || 0));
          const sourceEnd = Math.min(
            duration,
            sourceStart + (candidate.end - candidate.start) *
              inheritedSpeed,
          );
          state.removals = [];
          if (sourceStart > 0.002)
            state.removals.push({ start: 0, end: sourceStart, source: "promote-trim" });
          if (sourceEnd < duration - 0.002)
            state.removals.push({ start: sourceEnd, end: duration, source: "promote-trim" });
          state.manualCuts = [];
          state.mainAudioRemovals = state.removals.map((item) => ({ ...item }));
          state.mainAudioManualCuts = [];
          state.audioMutes = [];
          state.videoLayers = state.videoLayers.filter((item) => item.id !== candidate.id);
          if (candidate.linkedAudioId)
            state.audioAssets = state.audioAssets.filter(
              (item) => item.id !== candidate.linkedAudioId,
            );
          $("video").src = candidate.url;
          $("stage").classList.remove("empty");
          normalizeRemovals();
          toast("已把下一条视频设为当前主视频");
        } else {
          state.video = null;
          resetMainMediaModifiers();
          state.sourceDuration = 0;
          state.removals = [];
          state.manualCuts = [];
          state.mainAudioRemovals = [];
          state.mainAudioManualCuts = [];
          state.audioMutes = [];
          state.audioCuts = [];
          state.waveform = [];
          state.captions = [];
          state.reviewCaptions = [];
          state.issues = [];
          $("video").removeAttribute("src");
          $("video").load?.();
          $("stage").classList.toggle(
            "empty",
            !state.videoLayers.length && !state.images.length && !state.titles.length,
          );
          recomputeContentDuration();
        }
        cleanupEmptyDynamicTracks();
      }
      function deleteSelected(ripple = false, { record = true } = {}) {
        console.log("[deleteSelected] ripple=", ripple, "selected=", state.selected, "selectedItems=", JSON.stringify(state.selectedItems));
        if (ripple && timelineGapSelection) {
          const selectedGap = selectedTimelineGapAt(
            timelineGapSelection.trackId,
            (timelineGapSelection.start + timelineGapSelection.end) / 2,
          );
          if (selectedGap)
            return rippleDeleteTimelineGap(timelineGapSelection.trackId, selectedGap);
          timelineGapSelection = null;
        }
        if (state.timelineRange) materializeTimelineRangeSelection();
        const requested = resolveWorkingSelection(
          (state.selectedItems || []).length
            ? [...state.selectedItems]
            : state.selected?.id
              ? [{ ...state.selected }]
              : [],
        );
        if (requested.length && requested.every(item => item.type === 'review')) {
          dismissReviewHints(requested.map(item => item.id));
          return;
        }
        let selected = expandLinkedSelection(
          requested.filter((item) => !selectionIsLocked(item.type, item.id)),
        ).filter((item) => !selectionIsLocked(item.type, item.id));
        if (!selected.length) {
          const gap = findTimelineGap(timelineGapItems("video"), state.currentTime);
          if (ripple && gap) return rippleDeleteTimelineGap("video", gap);
          toast(requested.length ? "所选轨道已锁定" : "请先选择一个或多个片段");
          return;
        }
        if (record) snapshot();
        // Convert selected main instances before deletion; never remove the backing source.
        state.selectedItems=selected;
        for(const item of [...selected])if(['video','audio'].includes(item.type))materializeMainSegment(item.type,item.id);
        selected=expandLinkedSelection(state.selectedItems).filter(item=>!selectionIsLocked(item.type,item.id));
        const ids = (type) =>
          new Set(selected.filter((item) => item.type === type).map((item) => item.id));
        const videoIds = ids("video");
        videoIds.delete("main");
        const audioIds = ids("audio");
        audioIds.delete("main");
        const removeWholeMain = false;
        const captionOnly = selected.every(item => item.type === 'caption');
        const shouldRippleAudio = state.avLinked;
        const sourceClips = mainClips();
        anchorCaptionsToSource(sourceClips);
        const selectedMainClips = sourceClips
          .filter(
            (clip) => videoIds.has(clip.id) || (shouldRippleAudio && audioIds.has(clip.id)),
          )
          .sort((a, b) => b.start - a.start);
        console.log("[deleteSelected] selectedMainClips=", selectedMainClips.length, selectedMainClips.map(c => `${c.id}[${c.sourceStart?.toFixed(2)}-${c.sourceEnd?.toFixed(2)}]`));
        console.log("[deleteSelected] videoIds=", [...videoIds], "audioIds=", [...audioIds], "avLinked=", state.avLinked);
        const rippleClips = selectedMainClips;
        const overlayHoles = selected
          .filter((item) => !["video", "audio"].includes(item.type))
          .map((item) => {
            const obj = timelineObjectFor(item.type, item.id);
            if (!obj) return null;
            return {
              type: item.type,
              trackId: overlayTrackId(item.type, obj),
              start: Number(obj.start || 0),
              end: Number(obj.end || obj.start || 0),
            };
          })
          .filter((hole) => hole && hole.end > hole.start + 0.001)
          .sort((a, b) => b.start - a.start);
        for (const clip of selectedMainClips) {
          dismissTrimmedIssues(clip.start, clip.end);
          state.removals.push({
            start: clip.sourceStart,
            end: clip.sourceEnd,
            source: "manual",
          });
          if (ripple) shiftTracks(clip.start, clip.end - clip.start);
          else trimSubtitleTimeline(clip.start, clip.end);
        }
        const audioOnly = mainAudioClips().filter(
          (clip) => audioIds.has(clip.id) && !shouldRippleAudio,
        );
        for (const clip of audioOnly) {
          state.audioMutes.push({ start: clip.start, end: clip.end });
          if (ripple) rippleSubtitleTimeline(clip.start, clip.end);
          else trimSubtitleTimeline(clip.start, clip.end);
        }
        const layerIds = ids("videolayer");
        const audioAssetIds = ids("audioasset");
        if (state.avLinked) {
          for (const layer of state.videoLayers)
            if (layerIds.has(layer.id) && layer.linkedAudioId && !selectionIsLocked("audioasset", layer.linkedAudioId))
              audioAssetIds.add(layer.linkedAudioId);
          for (const audio of state.audioAssets)
            if (audioAssetIds.has(audio.id) && audio.linkedVideoId && !selectionIsLocked("videolayer", audio.linkedVideoId))
              layerIds.add(audio.linkedVideoId);
        }
        // Placed main segments use the same review policy as source-backed clips.
        // Clear before remapping or rippling so the range is still the old timeline.
        const removedMedia = [...state.videoLayers.filter(x => layerIds.has(x.id)),
          ...state.audioAssets.filter(x => audioAssetIds.has(x.id))];
        const removedOwners = new Set(removedMedia.map(x => x.id));
        for (const clip of removedMedia) dismissTrimmedIssues(clip.start, clip.end, removedOwners);
        const keep = (type) => (item) => !ids(type).has(item.id);
        state.videoLayers = state.videoLayers.filter((item) => !layerIds.has(item.id));
        state.audioAssets = state.audioAssets.filter((item) => !audioAssetIds.has(item.id));
        state.images = state.images.filter(keep("image"));
        state.titles = state.titles.filter(keep("text"));
        if(state.autoTranscript){
          state.autoTranscript.deletedSources ||= [];
          for(const caption of state.captions.filter(c=>requested.some(item=>item.type==='caption' && item.id===c.id)))for(const word of caption.words||[]){
            if(Number.isFinite(word.sourceStart)&&Number.isFinite(word.sourceEnd))state.autoTranscript.deletedSources.push({sourceMediaId:caption.sourceMediaId||state.video?.path,ownerClipId:caption.ownerClipId,mainSource:/^[av]-/.test(caption.ownerClipId||''),sourceStart:word.sourceStart,sourceEnd:word.sourceEnd});
          }
        }
        state.captions = state.captions.filter(keep("caption"));
        state.captionRecoveryArchive = (state.captionRecoveryArchive || []).filter((record) => !ids("caption").has(record?.caption?.id));
        state.reviewCaptions = state.reviewCaptions.filter(keep("review"));
        state.issues = state.issues.filter(keep("review"));
        if(ripple&&!rippleClips.length){
          const ranges=[];
          for(const hole of [...overlayHoles].sort((a,b)=>a.start-b.start)){
            const last=ranges.at(-1);if(last&&hole.start<=last.end+1e-7)last.end=Math.max(last.end,hole.end);else ranges.push({start:hole.start,end:hole.end});
          }
          for(const hole of ranges.reverse())applyEditRipple(hole.end,hole.start-hole.end,[],overlayHoles.filter(x=>x.start<hole.end&&x.end>hole.start).map(x=>x.trackId),{onlyTargetTracks:captionOnly});
        }
        if (!captionOnly) remapCaptionsFromSource(mainClips());
        if (removeWholeMain) clearOrPromoteMainVideo();
        if (selectedMainClips.length) {
          normalizeRemovals();
          remapCaptionsFromSource(mainClips());
          const packed = baseMainClips();
          const rippleFrom = selectedMainClips.reduce(
            (min, clip) => Math.min(min, Number(clip.start || 0)),
            Infinity,
          );
          const rippleDelta = ripple ? selectedMainClips.reduce(
            (sum, clip) => sum + (Number(clip.end) - Number(clip.start)),
            0,
          ) : 0;
          const offsets = rebuildClipOffsets({
            snapshot: sourceClips,
            packed,
            globalOffset: Math.max(0, Number(state.mainTimelineOffset || 0)),
            mode: ripple ? "ripple" : "trim",
            rippleFrom,
            rippleDelta,
          });
          state.mainVideoClipOffsets = offsets;
          state.mainAudioClipOffsets = { ...offsets };
          adoptClipMaps(sourceClips, packed);
          console.log("[deleteSelected] after rebuild: packed=", packed.length, "mainClips=", mainClips().length, "offsets=", JSON.stringify(offsets));
          if (!mainClips().length) {
            console.warn("[deleteSelected] ⚠️ mainClips().length === 0 → clearOrPromoteMainVideo triggered! removals=", JSON.stringify(state.removals), "sourceDuration=", state.sourceDuration);
            clearOrPromoteMainVideo();
          }
        }
        cleanupEmptyDynamicTracks();
        recomputeContentDuration();
        state.timelineRange = null;
        state.selectedItems = [];
        state.selected = state.video
          ? { type: "video", id: "main" }
          : { type: "", id: "" };
        seekTimeline(Math.min(state.currentTime, state.duration));
        renderAll();
        toast(`已删除 ${selected.length} 个所选片段${selected.length < requested.length ? "；锁定轨道已跳过" : ""}${ripple ? "，并前移启用联动的轨道" : ""}`);
      }
      function shiftTracks(at, len) {
        rippleShiftAllTracks(state,at+len,-len);
      }
      let speechLanguageCatalog = [];
      
