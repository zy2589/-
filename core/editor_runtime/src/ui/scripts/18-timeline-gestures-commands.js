function scaleTimelineClipGeometry(ratio) {
        const content = $("timelineContent");
        if (!content || !Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-6) return;
        content.querySelectorAll(".clip, .timeline-gap-selection, .trackend, .audiomute").forEach((el) => {
          const left = parseFloat(el.style.left);
          if (Number.isFinite(left)) el.style.left = `${left * ratio}px`;
          const width = parseFloat(el.style.width);
          if (Number.isFinite(width)) el.style.width = `${width * ratio}px`;
        });
      }
      function setTimelineZoomAroundPlayhead(nextZoom, pointerClientX = null, preview = false) {
        const scroll = $("timelineScroll");
        const oldZoom = Math.max(0.1, Number(state.zoom || 60));
        const ruler = $("ruler");
        const previewBaseZoom = ruler && preview
          ? Number(ruler.dataset.zoomPreviewBase || oldZoom)
          : oldZoom;
        const playheadTime = clamp(Number(state.currentTime || 0), 0, visibleTimelineDuration());
        state.zoom = clamp(Number(nextZoom) || oldZoom, 0.1, 6000);
        if ($("timelineZoom")) $("timelineZoom").value = state.zoom;
        if (!scroll) return;
        const content = $("timelineContent");
        const nextWidth = Math.max(scroll.clientWidth, visibleTimelineDuration() * state.zoom);
        if (content) content.style.width = `${nextWidth}px`;
        const pointerAnchor = state.timelineZoomAnchor !== "playhead" && Number.isFinite(pointerClientX);
        const pointerX = pointerAnchor ? clamp(pointerClientX - scroll.getBoundingClientRect().left, 0, scroll.clientWidth) : 0;
        const pointerTime = (scroll.scrollLeft + pointerX) / oldZoom;
        scroll.scrollLeft = pointerAnchor ? Math.max(0, pointerTime * state.zoom - pointerX) : playheadAnchoredScrollLeft({
          oldZoom,
          newZoom: state.zoom,
          playheadTime,
          scrollLeft: scroll.scrollLeft,
          viewWidth: scroll.clientWidth,
        });
        scaleTimelineClipGeometry(state.zoom / oldZoom);
        if (preview && ruler) {
          ruler.dataset.zoomPreviewBase = String(previewBaseZoom);
          ruler.dataset.zoomPreviewScale = String(state.zoom / Math.max(0.1, previewBaseZoom));
          ruler.style.width = `${Math.max(scroll.clientWidth, visibleTimelineDuration() * previewBaseZoom)}px`;
        } else {
          if (ruler) delete ruler.dataset.zoomPreviewBase;
          renderRuler();
        }
        syncTimelineChrome();
        scheduleTimelineZoomCommit();
      }
      let timelineZoomCommitTimer = 0;
      function scheduleTimelineZoomCommit() {
        clearTimeout(timelineZoomCommitTimer);
        timelineZoomCommitTimer = setTimeout(() => {
          timelineZoomCommitTimer = 0;
          renderTimeline();
          scheduleWaveformRender();
        }, 120);
      }
      $("timelineZoom").oninput = (e) =>
        setTimelineZoomAroundPlayhead(Number(e.target.value), null, true);
      function fitTimelineToContent() {
        const scroll = $("timelineScroll");
        if (!scroll || scroll.clientWidth <= 0) return false;
        let contentEnd = Math.max(mainContentEnd(), dynamicContentEnd());
        for (const list of [state.captions, state.reviewCaptions, state.issues])
          for (const item of list || []) contentEnd = Math.max(contentEnd, Number(item.end || item.start || 0));
        const totalDuration = Math.max(1, contentEnd || state.duration || 60);
        const availableWidth = Math.max(1, scroll.clientWidth - 48);
        const fitZoom = clamp(availableWidth / totalDuration, 0.1, 6000);
        state.zoom = fitZoom;
        if ($("timelineZoom")) $("timelineZoom").value = fitZoom;
        const content = $("timelineContent");
        if (content) {
          const nextWidth = Math.max(scroll.clientWidth, visibleTimelineDuration() * state.zoom);
          content.style.width = `${nextWidth}px`;
        }
        scroll.scrollLeft = 0;
        return true;
      }
      function zoomToFitTimeline() {
        if (!fitTimelineToContent()) return;
        syncTimelineChrome();
        renderTimeline();
        scheduleWaveformRender();
      }
      if ($("zoomToFitTimeline")) $("zoomToFitTimeline").onclick = zoomToFitTimeline;
      $("followPlayhead").onclick = () => {
        state.followPlayhead = state.followPlayhead === false;
        syncFollowPlayheadButton();
        if (state.followPlayhead !== false) keepPlayheadInView("center");
      };
      syncFollowPlayheadButton();
      let timelineDrag = null,
        objectDrag = null;
      function pairedTrackAtFamilyIndex(kind, index) {
        let family = (state.trackOrder || []).filter((id) => trackInfo(id).kind === kind);
        while (family.length <= index) {
          createDynamicTrack(kind, kind === "audio" ? "联动音频" : "联动视频", kind);
          family = (state.trackOrder || []).filter((id) => trackInfo(id).kind === kind);
        }
        return family[index] || kind;
      }
      function pairedTrackForVerticalMove(targetTrackId, targetKind) {
        const family = (state.trackOrder || []).filter((id) => trackInfo(id).kind === targetKind);
        const rank = family.indexOf(targetTrackId);
        if (rank < 0) return "";
        return pairedTrackAtFamilyIndex(targetKind === "video" ? "audio" : "video", rank);
      }
      function adjacentMainRollPair(type, id, edge, trackId) {
        if (type === "audio" && state.avLinked) return null;
        const audioOnly = type === "audio";
        const clips = audioOnly ? baseMainAudioClips() : mainClips();
        const map = audioOnly ? state.mainAudioTrackMap : state.mainVideoTrackMap;
        const index = clips.findIndex((item) => item.id === id || item.parentId === id);
        if (index < 0) return null;
        const left = edge === "end" ? clips[index] : clips[index - 1];
        const right = edge === "end" ? clips[index + 1] : clips[index];
        if (!left || !right) return null;
        const lane = (item) => map?.[item.id] || (audioOnly ? "audio" : "video");
        const tolerance = Math.max(0.02, frameDuration() * 1.5);
        if (lane(left) !== String(trackId || (audioOnly ? "audio" : "video")) || lane(right) !== lane(left) || Math.abs(Number(left.end) - Number(right.start)) > tolerance) return null;
        return { left, right, audioOnly };
      }
      function adjacentOverlayRollPair(type, id, edge, trackId) {
        const current = timelineObjectFor(type, id);
        if (!current || !["videolayer", "audioasset", "image", "text"].includes(type)) return null;
        const items = trackItems(trackId).slice().sort((a, b) => Number(a.start) - Number(b.start));
        const index = items.findIndex((item) => item === current || item.id === id);
        if (index < 0) return null;
        const left = edge === "end" ? items[index] : items[index - 1];
        const right = edge === "end" ? items[index + 1] : items[index];
        if (!left || !right) return null;
        const typeOf = (item) => state.videoLayers.includes(item) ? "videolayer"
          : state.audioAssets.includes(item) ? "audioasset"
          : state.images.includes(item) ? "image"
          : state.titles.includes(item) ? "text"
          : "";
        const leftType = typeOf(left), rightType = typeOf(right);
        const tolerance = Math.max(0.02, frameDuration() * 1.5);
        if (!leftType || !rightType || Math.abs(Number(left.end) - Number(right.start)) > tolerance) return null;
        const makeEntry = (item, itemType) => {
          const linked = state.avLinked && item.linkGroupId
            ? [...state.videoLayers, ...state.audioAssets].find((candidate) => candidate !== item && candidate.linkGroupId === item.linkGroupId)
            : null;
          const linkedType = linked ? (state.videoLayers.includes(linked) ? "videolayer" : "audioasset") : "";
          return [
            { obj: item, type: itemType, origin: { ...item } },
            ...(linked ? [{ obj: linked, type: linkedType, origin: { ...linked } }] : []),
          ];
        };
        const leftEntries = makeEntry(left, leftType), rightEntries = makeEntry(right, rightType);
        if ([...leftEntries, ...rightEntries].some((entry) => selectionIsLocked(entry.type, entry.obj.id))) return null;
        return { leftEntries, rightEntries, cutTime: Number(left.end), leftType, rightType };
      }
      function rollSourceRate(item) {
        return Math.max(0.05, editRate(item, Number(state.audio.speed || 1)));
      }
      function rollSourceEnd(item) {
        return Number(item.sourceEnd ?? (Number(item.sourceStart || 0) + (Number(item.end) - Number(item.start)) * rollSourceRate(item)));
      }
      function rollPositiveHandle(entry) {
        const origin = entry.origin, rate = rollSourceRate(origin);
        if (origin.sourceEnd == null) return Infinity;
        const sourceDuration = Number(origin.sourceDuration || origin.duration || 0);
        return sourceDuration > 0 ? Math.max(0, sourceDuration - rollSourceEnd(origin)) / rate : 0;
      }
      function rollNegativeHandle(entry) {
        const origin = entry.origin, rate = rollSourceRate(origin);
        return origin.sourceStart == null ? Infinity : Math.max(0, Number(origin.sourceStart || 0) / rate);
      }
      function rollDurationRoom(entry) {
        return Math.max(0, Number(entry.origin.end) - Number(entry.origin.start) - frameDuration());
      }
      function applyOverlayRollEntries(entries, edge, cutTime) {
        for (const entry of entries) {
          const { obj, origin, type } = entry;
          const rate = rollSourceRate(origin);
          if (edge === "end") {
            obj.end = cutTime;
            if (origin.sourceEnd != null) obj.sourceEnd = Math.max(Number(origin.sourceStart || 0) + 0.001, rollSourceEnd(origin) + (cutTime - Number(origin.end)) * rate);
          } else {
            obj.start = cutTime;
            if (origin.sourceStart != null) obj.sourceStart = Math.max(0, Number(origin.sourceStart || 0) + (cutTime - Number(origin.start)) * rate);
          }
          updateTimelineClipGeometry(type, obj.id, obj);
        }
      }
      function applyObjectDragMove(clientX, clientY) {
        if (!objectDrag) return;
        window.clearLayerSeekHold?.();
        const frame = $("frame"),
          fw = objectDrag.frameWidth || (objectDrag.frameWidth = frame.clientWidth || 1),
          fh = objectDrag.frameHeight || (objectDrag.frameHeight = frame.clientHeight || 1);
        if (objectDrag.rotate) {
          const angle = (Math.atan2(clientY - objectDrag.centerY, clientX - objectDrag.centerX) * 180) / Math.PI;
          objectDrag.obj.rotation = objectDrag.rotation + angle - objectDrag.startAngle;
        } else if (objectDrag.widthResize) {
          const canvasZoom = Math.max(0.25, Number(state.canvasZoom || 1)),
            delta = ((clientX - objectDrag.startX) * state.width) / (fw * canvasZoom),
            signed = objectDrag.widthSide === "w" ? -delta : delta,
            textElement = state.selected.type === "caption"
              ? $("captionPreview")
              : frame.querySelector(`[data-type="text"][data-id="${state.selected.id}"]`),
            nextWidth = clamp(
              objectDrag.width + signed,
              objectDrag.minimumWidth || 160,
              state.width * 1.5,
            ),
            applied = nextWidth - objectDrag.width;
          objectDrag.obj.width = nextWidth;
          objectDrag.obj.x = objectDrag.x + (objectDrag.widthSide === "w" ? -applied / 2 : applied / 2);
          applyTextBoxWidth(textElement, nextWidth, fw / state.width);
          objectDrag.needsCaptionReflow = state.selected.type === "caption";
        } else if (objectDrag.resize) {
          const screenDx = clientX - objectDrag.startX,
            screenDy = clientY - objectDrag.startY,
            angle = Number(objectDrag.rotation || 0) * Math.PI / 180,
            localDx = Math.cos(angle) * screenDx + Math.sin(angle) * screenDy,
            localDy = -Math.sin(angle) * screenDx + Math.cos(angle) * screenDy,
            direction = objectDrag.handleDirection || "se",
            horizontal = direction.includes("e") ? localDx : direction.includes("w") ? -localDx : null,
            vertical = direction.includes("s") ? localDy : direction.includes("n") ? -localDy : null,
            delta = horizontal == null ? vertical : vertical == null ? horizontal : (horizontal + vertical) / 2;
          const sensitivity = state.selected.type === "video" ? 5.8 : 4.6;
          const factor = Math.exp(Number(delta || 0) / Math.max(260, objectDrag.size * sensitivity));
          objectDrag.obj.scale = clamp(objectDrag.scale * factor, 0.05, 8);
        } else {
          const canvasZoom = Math.max(0.25, Number(state.canvasZoom || 1));
          objectDrag.obj.x = objectDrag.x + ((clientX - objectDrag.startX) * state.width) / (fw * canvasZoom);
          objectDrag.obj.y = objectDrag.y + ((clientY - objectDrag.startY) * state.height) / (fh * canvasZoom);
          const snapThreshold = (9 * state.width) / Math.max(1, fw * canvasZoom);
          const centered = Math.abs(Number(objectDrag.obj.x || 0)) <= snapThreshold;
          if (centered) objectDrag.obj.x = 0;
          $("centerGuide").classList.toggle("on", centered);
        }
        const selectedElement = state.selected.type === "caption"
          ? $("captionPreview")
          : state.selected.type === "video"
            ? $("video")
            : frame.querySelector(`[data-type="${state.selected.type}"][data-id="${state.selected.id}"]`);
        if (selectedElement) {
          const px = fw / state.width, py = fh / state.height;
          let spliceStyle = null;
          if (typeof window.splicePreviewStyle === "function") {
            if (state.selected.type === "video") {
              const clip = activeMainVideoClip();
              if (clip) spliceStyle = window.splicePreviewStyle({ type: "main", clip, settings: objectDrag.obj, media: state.video }, selectedElement.videoWidth, selectedElement.videoHeight);
            } else if (state.selected.type === "videolayer") {
              spliceStyle = window.splicePreviewStyle({ type: "layer", clip: objectDrag.obj, settings: objectDrag.obj, media: objectDrag.obj }, selectedElement.videoWidth || objectDrag.obj.sourceWidth, selectedElement.videoHeight || objectDrag.obj.sourceHeight);
            } else if (state.selected.type === "image" && objectDrag.obj.spliceRegionId) {
              spliceStyle = window.splicePreviewStyle({ type: "layer", clip: objectDrag.obj, settings: objectDrag.obj, media: objectDrag.obj }, objectDrag.obj.sourceWidth || selectedElement.naturalWidth, objectDrag.obj.sourceHeight || selectedElement.naturalHeight);
            }
          }
          let transform = "none";
          if (spliceStyle) transform = spliceStyle.transform;
          else if (state.selected.type === "video")
            transform = `translate(${Number(objectDrag.obj.x || 0) * px}px,${Number(objectDrag.obj.y || 0) * py}px) rotate(${Number(objectDrag.obj.rotation || 0)}deg) scale(${Number(objectDrag.obj.scale || 1)})`;
          else
            transform = `translate(calc(-50% + ${Number(objectDrag.obj.x || 0) * px}px),calc(-50% + ${Number(objectDrag.obj.y || 0) * py}px)) rotate(${Number(objectDrag.obj.rotation || 0)}deg) scale(${Number(objectDrag.obj.scale || 1)})`;
          selectedElement.style.transform = transform;
          if (spliceStyle?.clipPath) selectedElement.style.clipPath = spliceStyle.clipPath;
          if (state.selected.type === "video") {
            $("beautyPreviewCanvas").style.transform = transform;
            if (spliceStyle?.clipPath) $("beautyPreviewCanvas").style.clipPath = spliceStyle.clipPath;
          }
          $("selectionBox").style.transform = spliceStyle?.region ? "none" : transform;
          if (objectDrag.widthResize)
            $("selectionBox").style.width = `${objectDrag.obj.width * (fw / state.width)}px`;
        }
        if (["video", "videolayer", "image", "text"].includes(state.selected.type)) {
          window.syncPositionControlValue?.("X", objectDrag.obj.x);
          window.syncPositionControlValue?.("Y", objectDrag.obj.y);
        }
        // Inspector fields and caption word DOM are committed on pointerup.
        // During a drag only compositor-friendly transform/width properties
        // are changed.
      }
      function scheduleObjectDragMove(clientX, clientY) {
        if (!objectDrag) return;
        objectDrag.pendingX = clientX;
        objectDrag.pendingY = clientY;
        if (objectDrag.framePending) return;
        objectDrag.framePending = requestAnimationFrame(() => {
          if (!objectDrag) return;
          objectDrag.framePending = 0;
          applyObjectDragMove(objectDrag.pendingX, objectDrag.pendingY);
        });
      }
      function captureObjectPointer(event) {
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
      }
      function cancelObjectDrag() {
        if (!objectDrag) return;
        const drag = objectDrag;
        if (drag.framePending) cancelAnimationFrame(drag.framePending);
        if (drag.rotate) drag.obj.rotation = drag.rotation;
        else if (drag.widthResize) drag.obj.width = drag.width;
        else if (drag.resize) drag.obj.scale = drag.scale;
        drag.obj.x = drag.x;
        drag.obj.y = drag.y;
        objectDrag = null;
        $("centerGuide").classList.remove("on");
        $("frame").classList.remove("object-dragging");
        renderPreviewObjects();
        updateInspector();
      }
      document.addEventListener("pointercancel", (event) => {
        if (objectDrag?.pointer === event.pointerId) cancelObjectDrag();
      }, true);
      document.addEventListener("lostpointercapture", (event) => {
        if (objectDrag?.pointer === event.pointerId) cancelObjectDrag();
      }, true);
      window.addEventListener("blur", cancelObjectDrag);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) cancelObjectDrag();
      });
      let rulerScrub = null,
        rulerScrubFrame = 0,
        rulerScrubTimer = 0,
        rulerScrubTime = 0,
        rulerScrubLastSeek = -Infinity;
      function rulerScrubTimeAt(clientX) {
        const rect = ($("ruler") || $("timelineContent")).getBoundingClientRect();
        return clamp(
          (clientX - rect.left) / state.zoom,
          0,
          visibleTimelineDuration(),
        );
      }
      function cancelRulerScrubSeek() {
        if (rulerScrubFrame) cancelAnimationFrame(rulerScrubFrame);
        if (rulerScrubTimer) clearTimeout(rulerScrubTimer);
        rulerScrubFrame = rulerScrubTimer = 0;
      }
      function scheduleRulerScrub(clientX) {
        state.cutPreviewRange = null;
        rulerScrubTime = rulerScrubTimeAt(clientX);
        if (rulerScrubFrame || rulerScrubTimer) return;
        const seek = () => {
          rulerScrubFrame = rulerScrubTimer = 0;
          if (!rulerScrub) return;
          rulerScrubLastSeek = performance.now();
          seekTimeline(rulerScrubTime);
        };
        const wait = Math.max(0, 50 - (performance.now() - rulerScrubLastSeek));
        if (wait > 0) rulerScrubTimer = setTimeout(seek, wait);
        else rulerScrubFrame = requestAnimationFrame(seek);
      }
      $("ruler").onpointerdown = (event) => {
        const timelineMarker = event.target.closest("[data-timeline-marker]");
          if (timelineMarker) {
            const m = (state.timelineMarkers || []).find((item) => item.id === timelineMarker.dataset.timelineMarker);
            if (m) {
              if (state.playing) void togglePlay();
              seekTimeline(Number(m.time || 0));
            }
            return;
          }
          const marker = event.target.closest("[data-issue]");
        if (marker) {
          if (state.playing) void togglePlay();
          selectIssue(marker.dataset.issue);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // A moving playback clock must not compete with repeated decoder seeks.
        // Stop it before the first scrub seek so the preview settles on the
        // selected frame instead of waiting for a later space-bar refresh.
        if (state.playing) void togglePlay();
        rulerScrub = { pointer: event.pointerId };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        scheduleRulerScrub(event.clientX);
        event.preventDefault();
        event.stopPropagation();
      };
      window.addEventListener("pointermove", (event) => {
        if (!rulerScrub || rulerScrub.pointer !== event.pointerId) return;
        scheduleRulerScrub(event.clientX);
      });
      window.addEventListener("pointerup", (event) => {
        if (!rulerScrub || rulerScrub.pointer !== event.pointerId) return;
        rulerScrubTime = rulerScrubTimeAt(event.clientX);
        cancelRulerScrubSeek();
        seekTimeline(rulerScrubTime);
        rulerScrub = null;
        syncPreviewAudio();
      });
      window.addEventListener("pointercancel", (event) => {
        if (!rulerScrub || rulerScrub.pointer !== event.pointerId) return;
        rulerScrubTime = rulerScrubTimeAt(event.clientX);
        cancelRulerScrubSeek();
        seekTimeline(rulerScrubTime);
        rulerScrub = null;
        syncPreviewAudio();
      });
      $("timelineContent").onpointerdown = (e) => {
        if (e.button === 2) return; // 右键不启动拖拽/框选，由 contextmenu 处理
        const manualReview = e.target.closest('[data-edit-review]');
        if (manualReview) {
          manuallyEditReviewCaption(manualReview.dataset.editReview);
          e.preventDefault(); e.stopPropagation(); return;
        }
        const reviewApply = e.target.closest(
          "[data-apply-review],[data-replace-review]",
        );
        if (reviewApply) {
          replaceReviewCaption(
            reviewApply.dataset.applyReview || reviewApply.dataset.replaceReview,
          );
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const insertReview = e.target.closest("[data-insert-review]");
        if (insertReview) {
          if (isTrackLocked("review")) {
            toast("待处理片段轨道已锁定");
            return;
          }
          insertReviewSegment(insertReview.dataset.insertReview);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const cutReview = e.target.closest("[data-cut-review]");
        if (cutReview) {
          if (!applyRedReviewGesture(e, cutReview.dataset.cutReview)) {
            previewReviewSegment(cutReview.dataset.cutReview);
            showReviewDetails(cutReview.dataset.cutReview);
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const focusIssue = e.target.closest("[data-focus-issue]");
        if (focusIssue) {
          focusScriptDifference(focusIssue.dataset.focusIssue);
          showReviewDetails(focusIssue.dataset.focusIssue);
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const scriptAction = e.target.closest("[data-script-action]");
        if (scriptAction && !scriptAction.closest('.clip[data-type="caption"]')) {
          const issueId = scriptAction.dataset.scriptIssue;
          if (scriptAction.dataset.scriptAction === "cut") {
            if (!applyRedReviewGesture(e, issueId)) {
              focusScriptDifference(issueId);
              showReviewDetails(issueId);
            }
          } else { focusScriptDifference(issueId); showReviewDetails(issueId); }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const clip = e.target.closest(".clip");
        if (clip) {
          timelineGapSelection = null;
          if (clip.dataset.type === 'review' && editTool !== 'blade' && !e.target.closest('[data-trim]') &&
              !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
            showReviewDetails(clip.dataset.id);
            e.preventDefault();
            return;
          }
          if (editTool === "blade") {
            // Use the current pointer position. bladeGuide.dataset.time can be
            // left over from the previous hover when the tool is re-enabled.
            const time = previewBladeTime(e.clientX);
            seekTimeline(time);
            setBladeGuide(time, true);
            if (!splitClipsAt(time, [{ type: clip.dataset.type, id: clip.dataset.id }]))
              toast("切割位置不在片段的有效范围内");
            e.preventDefault();
            return;
          }
          const additive = e.shiftKey || e.metaKey || e.ctrlKey ||
            (state.selectedItems || []).some(item=>item.type===clip.dataset.type&&item.id===clip.dataset.id);
          selectItem(
            clip.dataset.type,
            clip.dataset.id,
            additive,
            e.metaKey || e.ctrlKey,
          );
          if (isTrackLocked(clip.dataset.trackId || selectionTrackId(clip.dataset.type, clip.dataset.id))) {
            renderTimeline();
            renderPreviewObjects();
            updateInspector();
            toast("这个轨道已锁定，请先解锁后再编辑");
            e.preventDefault();
            return;
          }
          const selectedTimelineObject = timelineObjectFor(
            clip.dataset.type,
            clip.dataset.id,
          );
          const selectedMainClip = clip.dataset.type === "video"
            ? mainClips().find((item) => item.id === clip.dataset.id)
            : clip.dataset.type === "audio"
              ? mainAudioClips().find((item) => item.id === clip.dataset.id)
              : null;
          if (selectedTimelineObject)
            includeLinkedSelection(clip.dataset.type, clip.dataset.id);
          else if (selectedMainClip)
            includeLinkedSelection(clip.dataset.type, clip.dataset.id);
          if (state.avLinked && ["videolayer", "audioasset"].includes(clip.dataset.type)) {
            const selectedObject = timelineObjectFor(clip.dataset.type, clip.dataset.id);
            const linked = selectedObject?.linkGroupId
              ? [...state.videoLayers, ...state.audioAssets].find(
                  (item) => item !== selectedObject && item.linkGroupId === selectedObject.linkGroupId,
                )
              : null;
            if (linked) {
              const linkedType = state.videoLayers.includes(linked) ? "videolayer" : "audioasset";
              if (!state.selectedItems.some((item) => item.type === linkedType && item.id === linked.id))
                state.selectedItems.push({ type: linkedType, id: linked.id });
            }
          }
          if (clip.dataset.type === "review") {
            renderTimeline();
            e.preventDefault();
            return;
          }
          const volumeLine = e.target.closest("[data-volume-line]");
          if (volumeLine && ["audio", "audioasset"].includes(clip.dataset.type)) {
            const settings = audioSettingsFor(clip.dataset.type, clip.dataset.id);
            if (settings) {
              snapshot();
              timelineDrag = {
                pointer: e.pointerId,
                volumeSettings: settings,
                volumeRow: clip,
                element: clip,
              };
            }
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (state.avLinked && (state.selectedItems || []).some((item) => selectionIsLocked(item.type, item.id))) {
            toast("联动片段中有轨道已锁定，无法移动或修剪；请先解锁对应轨道。");
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          const trimHandle = e.target.closest("[data-trim]");
          if (trimHandle) {
            const trimEdge = trimHandle.dataset.trim;
            const rowTrackId = clip.dataset.trackId || selectionTrackId(clip.dataset.type, clip.dataset.id);
            const mainRollPair = ["video", "audio"].includes(clip.dataset.type)
              ? adjacentMainRollPair(clip.dataset.type, clip.dataset.id, trimEdge, rowTrackId)
              : null;
            const overlayRollPair = !["video", "audio"].includes(clip.dataset.type)
              ? adjacentOverlayRollPair(clip.dataset.type, clip.dataset.id, trimEdge, rowTrackId)
              : null;
            // A shared, contiguous boundary rolls both clips in the same lane.
            // An isolated edge keeps the regular trim behavior.
            if (["video", "audio"].includes(clip.dataset.type) && !mainRollPair && !(editTool === "trim" && e.shiftKey)) {
              snapshot();
              const replacement = materializeMainSegment(clip.dataset.type, clip.dataset.id);
              if (replacement) {
                const object = timelineObjectFor(replacement.type,replacement.id);
                clip.dataset.type = replacement.type; clip.dataset.id = replacement.id;
                timelineDrag = {pointer:e.pointerId,element:clip,trim:true,trimEdge:trimHandle.dataset.trim,
                  trimType:replacement.type,trimObject:object,isRipple:editTool === "trim",startX:e.clientX,
                  originStart:object.start,originEnd:object.end,originSourceStart:object.sourceStart};
                e.preventDefault(); e.stopPropagation(); return;
              }
            }
            const object = timelineObjectFor(clip.dataset.type, clip.dataset.id);
            const mainClip = clip.dataset.type === "video"
              ? mainClips().find((item) => item.id === clip.dataset.id)
              : clip.dataset.type === "audio"
                ? mainAudioClips().find((item) => item.id === clip.dataset.id)
                : null;
            const mainTrimClip = mainClip && clip.dataset.type === "audio" && !state.avLinked
              ? baseMainAudioClips().find((item) => item.id === mainClip.parentId) || mainClip
              : mainClip;
            if (object || mainTrimClip) {
              snapshot();
              const trimSnapshot = clip.dataset.type === "audio" && !state.avLinked
                ? baseMainAudioClips()
                : mainClips();
              const mainIndex = mainTrimClip
                ? trimSnapshot.findIndex((item) => item.id === mainTrimClip.id || item.id === mainTrimClip.parentId)
                : -1;
              const rollEdit = mainRollPair
                ? { left: { ...mainRollPair.left }, right: { ...mainRollPair.right }, cutSource: Number(mainRollPair.left.sourceEnd || 0) }
                : null;
              const recoveryRemovals = clip.dataset.type === "audio" && !state.avLinked
                ? state.mainAudioRemovals
                : state.removals;
              const hasRecoverableHandle = !!(mainTrimClip && adjacentRemoval(recoveryRemovals, mainTrimClip, trimEdge));
              timelineDrag = {
                pointer: e.pointerId,
                element: clip,
                trim: true,
                trimEdge,
                trimType: clip.dataset.type,
                trimObject: object,
                mainTrimClip,
                rollEdit,
                rollObjects: overlayRollPair,
                isRipple: !overlayRollPair && (editTool === "trim" || hasRecoverableHandle),
                recoveringDeletedMedia: hasRecoverableHandle,
                mainClipsSnapshot: trimSnapshot.map((c) => ({
                  id: c.id,
                  start: Number(c.start),
                  end: Number(c.end),
                  sourceStart: Number(c.sourceStart),
                  sourceEnd: Number(c.sourceEnd),
                })),
                startX: e.clientX,
                originStart: Number((object || mainTrimClip).start),
                originEnd: Number((object || mainTrimClip).end),
                originSourceStart: Number(object?.sourceStart || 0),
              };
            }
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          const movable = expandLinkedSelection(state.selectedItems || [])
            .map((item) => ({
              ...item,
              obj: timelineObjectFor(item.type, item.id),
            }))
            .filter((item) => item.obj)
            .map((item) => ({
              ...item,
              originStart: item.obj.start,
              originEnd: item.obj.end,
              originTrackId: item.obj.trackId || selectionTrackId(item.type, item.id),
            }));
          const obj = timelineObjectFor(clip.dataset.type, clip.dataset.id);
          if (
            obj &&
            ["videolayer", "audioasset", "image", "text", "caption", "review"].includes(
              clip.dataset.type,
            )
          ) {
            snapshot();
            timelineDrag = {
              pointer: e.pointerId,
              element: clip,
              startX: e.clientX,
              startY: e.clientY,
              moving: movable,
              slip: editTool === "trim" && e.altKey && ["videolayer", "audioasset"].includes(clip.dataset.type),
              slipOriginSourceStart: Number(obj.sourceStart || 0),
              slipSourceDuration: Number(obj.sourceDuration || obj.duration || 0),
            };
          } else if (["video", "audio"].includes(clip.dataset.type)) {
            const sourceClip = (clip.dataset.type === "video"
              ? mainClips()
              : mainAudioClips()
            ).find((item) => item.id === clip.dataset.id);
            if (sourceClip) {
              snapshot();
              const moveIds = collectMainMoveIds(clip.dataset.type, sourceClip.id);
              const movingMains = [];
              for (const id of moveIds) {
                const video = mainClips().find((item) => item.id === id);
                if (video) {
                  movingMains.push({
                    id: video.id,
                    type: "video",
                    originStart: Number(video.start || 0),
                    originOffset: Number(state.mainVideoClipOffsets?.[video.id] || 0),
                  });
                }
                if (!state.avLinked) {
                  const audio = mainAudioClips().find(
                    (item) => item.id === id || item.parentId === id,
                  );
                  if (audio)
                    movingMains.push({
                      id: audio.parentId || audio.id,
                      type: "audio",
                      originStart: Number(audio.start || 0),
                      originOffset: Number(
                        state.mainAudioClipOffsets?.[audio.parentId || audio.id] || 0,
                      ),
                    });
                }
              }
              if (state.avLinked && !movingMains.some((item) => item.id === sourceClip.id))
                movingMains.push({
                  id: sourceClip.id,
                  type: "video",
                  originStart: Number(sourceClip.start || 0),
                  originOffset: Number(state.mainVideoClipOffsets?.[sourceClip.id] || 0),
                });
              timelineDrag = {
                pointer: e.pointerId,
                element: clip,
                startX: e.clientX,
                startY: e.clientY,
                mainTrackMove: true,
                mainTrackType: clip.dataset.type,
                mainTrackClip: sourceClip,
                originClipStart: Number(sourceClip.start || 0),
                originClipOffset: Number(
                  (clip.dataset.type === "audio"
                    ? state.mainAudioClipOffsets
                    : state.mainVideoClipOffsets)?.[sourceClip.parentId || sourceClip.id] || 0,
                ),
                movingMains,
                linkedMoving: expandLinkedSelection(state.selectedItems || [])
                  .map((item) => ({
                    ...item,
                    obj: timelineObjectFor(item.type, item.id),
                  }))
                  .filter((item) => item.obj)
                  .map((item) => ({
                    ...item,
                    originStart: Number(item.obj.start || 0),
                    originEnd: Number(item.obj.end || 0),
                  })),
              };
            }
          }
          updateInspector();
          renderTimeline();
          renderPreviewObjects();
          e.preventDefault();
          return;
        }
        if (editTool === "blade") {
          const time = previewBladeTime(e.clientX);
          seekTimeline(time);
          setBladeGuide(time, true);
          e.preventDefault();
          return;
        }
        const rect = $("timelineContent").getBoundingClientRect();
        const row = e.target.closest(".trackrow[data-track-key]");
        const gapTime = (e.clientX - rect.left) / Math.max(1e-6, state.zoom);
        const gapCandidate = row
          ? findTimelineGap(timelineGapItems(row.dataset.trackKey), gapTime)
          : null;
        if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
          state.selectedItems = [];
          state.selected = { type: "video", id: "main" };
        }
        timelineDrag = {
          pointer: e.pointerId,
          marquee: true,
          additive: e.shiftKey || e.metaKey || e.ctrlKey,
          startX: e.clientX,
          startY: e.clientY,
          contentX: e.clientX - rect.left,
          contentY: e.clientY - rect.top,
          gapCandidate: gapCandidate
            ? { trackId: row.dataset.trackKey, ...gapCandidate }
            : null,
          moved: false,
        };
        e.preventDefault();
      };
      function autoScrollTimelineDuringDrag(clientX) {
        if (!timelineDrag || timelineDrag.marquee) return;
        const scroll = $("timelineScroll"); if (!scroll) return;
        if (!Number.isFinite(timelineDrag.originScrollLeft)) timelineDrag.originScrollLeft = scroll.scrollLeft;
        const rect = scroll.getBoundingClientRect(), edge = Math.min(88, Math.max(48, rect.width * 0.075));
        let velocity = 0;
        if (clientX < rect.left + edge) velocity = -Math.pow((rect.left + edge - clientX) / edge, 1.35) * 22;
        else if (clientX > rect.right - edge) velocity = Math.pow((clientX - (rect.right - edge)) / edge, 1.35) * 22;
        if (velocity) scroll.scrollLeft = Math.max(0, scroll.scrollLeft + velocity);
      }
      function beginTimelineGesture() {
        if (!timelineGestureBefore) timelineGestureBefore = JSON.stringify(projectData(true));
      }
      function commitTimelineGesture() {
        if (!timelineGestureBefore) return false;
        const before = timelineGestureBefore; timelineGestureBefore = null;
        if (JSON.stringify(projectData(true)) === before) return false;
        state.undo.push(before); state.redo = [];
        if (state.undo.length > 100) state.undo.shift();
        queueAutosave(); return true;
      }
      function rollbackTimelineGesture() {
        if (!timelineGestureBefore) return;
        const before = timelineGestureBefore; timelineGestureBefore = null;
        applyHistoryState(JSON.parse(before));
      }
      function handleTimelinePointerMove(e) {
        if (editTool === "blade" && !timelineDrag && e.target.closest?.("#timelineMain"))
          setBladeGuide(previewBladeTime(e.clientX), true);
        if (timelineDrag?.pointer === e.pointerId) {
          autoScrollTimelineDuringDrag(e.clientX);
          if (timelineDrag.marquee) {
            const rect = $("timelineContent").getBoundingClientRect();
            const x = e.clientX - rect.left,
              y = e.clientY - rect.top,
              left = Math.min(timelineDrag.contentX, x),
              top = Math.min(timelineDrag.contentY, y),
              width = Math.abs(x - timelineDrag.contentX),
              height = Math.abs(y - timelineDrag.contentY),
              marquee = $("timelineMarquee");
            timelineDrag.moved = width > 4 || height > 4;
            marquee.style.left = `${left}px`;
            marquee.style.top = `${top}px`;
            marquee.style.width = `${width}px`;
            marquee.style.height = `${height}px`;
            marquee.classList.toggle("on", timelineDrag.moved);
          } else if (timelineDrag.volumeSettings) {
            const rect = timelineDrag.volumeRow.getBoundingClientRect();
            const ratio = clamp((e.clientY - rect.top) / rect.height, 0, 1);
            timelineDrag.volumeSettings.volume = Math.round((1 - ratio) * 200) / 100;
            timelineDrag.volumeSettings.muted = false;
            updateVolumeGeometry(
              timelineDrag.element,
              timelineDrag.volumeSettings,
            );
            scheduleWaveformRender();
            syncAudioControls();
          } else if (timelineDrag.slip && timelineDrag.moving?.[0]?.obj) {
            const moving = timelineDrag.moving[0];
            const object = moving.obj;
            const delta=(e.clientX-timelineDrag.startX+$("timelineScroll").scrollLeft-Number(timelineDrag.originScrollLeft??$("timelineScroll").scrollLeft))/state.zoom;
            timelineDrag.slipOrigins ||= timelineDrag.moving.map(item=>({obj:item.obj,origin:{...item.obj}}));
            const next=editLinkedSlip(timelineDrag.slipOrigins.map(x=>x.origin),delta,{fps:timelineFrameRate()});
            timelineDrag.slipOrigins.forEach((item,i)=>Object.assign(item.obj,next[i]));
            const deltaSource=object.sourceStart-timelineDrag.slipOriginSourceStart;
            const duration=object.sourceEnd-object.sourceStart;
            timelineDrag.moved = Math.abs(deltaSource) > .001;
            if (moving.type === "audioasset" && object.waveform?.length)
              showTrimAudioDetail({
                waveform: object.waveform,
                sourceDuration: object.sourceDuration || object.duration,
                sourceTime: object.sourceStart + duration / 2,
                delta: object.sourceStart - timelineDrag.slipOriginSourceStart,
                mode: "Slip 滑移片段内容",
              });
            drawAssetWaveforms();
          } else if (timelineDrag.trim) {
            const delta = (e.clientX - timelineDrag.startX + $("timelineScroll").scrollLeft - Number(timelineDrag.originScrollLeft ?? $("timelineScroll").scrollLeft)) / state.zoom;
            const edge = timelineDrag.trimEdge;
            if (timelineDrag.rollObjects) {
              const roll = timelineDrag.rollObjects;
              const leftDurationRoom = Math.min(...roll.leftEntries.map(rollDurationRoom));
              const rightDurationRoom = Math.min(...roll.rightEntries.map(rollDurationRoom));
              const minDelta = -Math.min(leftDurationRoom, ...roll.rightEntries.map(rollNegativeHandle));
              const maxDelta = Math.min(rightDurationRoom, ...roll.leftEntries.map(rollPositiveHandle));
              const target = frameBoundedTime(
                roll.cutTime + delta,
                roll.cutTime + minDelta,
                roll.cutTime + maxDelta,
                timelineDrag.trimType === "audioasset",
              );
              roll.targetTime = target;
              roll.appliedDelta = target - roll.cutTime;
              applyOverlayRollEntries(roll.leftEntries, "end", target);
              applyOverlayRollEntries(roll.rightEntries, "start", target);
            } else if (timelineDrag.trimObject) {
              const object = timelineDrag.trimObject;
              const isMedia = ["videolayer", "audioasset"].includes(
                timelineDrag.trimType,
              );
              if(isMedia){
                timelineDrag.trimOrigins ||= [object,...(state.avLinked&&object.linkGroupId?[...state.videoLayers,...state.audioAssets].filter(x=>x!==object&&x.linkGroupId===object.linkGroupId&&!selectionIsLocked(state.videoLayers.includes(x)?'videolayer':'audioasset',x.id)):[])].map(obj=>({obj,origin:{...obj},type:state.videoLayers.includes(obj)?'videolayer':'audioasset'}));
                const origins=timelineDrag.trimOrigins,origin=origins[0].origin;
                const target=snapTime(Number(origin[edge])+delta,object);
                const next=editLinkedTrim(origins.map(x=>x.origin),edge,target-origin[edge],{fps:timelineFrameRate(),ripple:timelineDrag.isRipple,bounds:origins.map(x=>timelineDrag.isRipple?{}:editNeighborBounds(x.origin,x.type))});
                origins.forEach((item,index)=>{Object.assign(item.obj,next[index]);updateTimelineClipGeometry(item.type,item.obj.id,item.obj);});
              }else{
              if (edge === "start") {
                const minStart = isMedia
                  ? Math.max(
                      0,
                      timelineDrag.originStart -
                        timelineDrag.originSourceStart /
                          Math.max(0.05, Number(state.audio.speed || 1)),
                    )
                  : 0;
                object.start = clamp(snapTime(
                  clamp(
                    timelineDrag.originStart + delta,
                    minStart,
                    timelineDrag.originEnd - frameDuration(),
                  ),
                  object, {min:minStart,max:timelineDrag.originEnd-frameDuration()},
                ),minStart,timelineDrag.originEnd-frameDuration());
                if (isMedia)
                  object.sourceStart = Math.max(
                    0,
                    timelineDrag.originSourceStart +
                      (object.start - timelineDrag.originStart) *
                        Math.max(0.05, Number(state.audio.speed || 1)),
                  );
              } else {
                const maxEnd = isMedia
                  ? timelineDrag.originStart +
                    (Math.max(
                      timelineDrag.originSourceStart + frameDuration(),
                      Number(object.sourceDuration ||
                        timelineDrag.originSourceStart +
                          timelineDrag.originEnd - timelineDrag.originStart),
                    ) - timelineDrag.originSourceStart) /
                      Math.max(0.05, Number(state.audio.speed || 1))
                  : visibleTimelineDuration() + 3600;
                object.end = clamp(snapTime(
                  clamp(
                    timelineDrag.originEnd + delta,
                    object.start + frameDuration(),
                    maxEnd,
                  ),
                  object, {min:object.start+frameDuration(),max:maxEnd},
                ),object.start+frameDuration(),maxEnd);
                state.timelineDuration = Math.max(
                  state.timelineDuration,
                  object.end + 10,
                );
              }
              }

              updateTimelineClipGeometry(
                timelineDrag.trimType,
                object.id,
                object,
              );
              if (timelineDrag.trimType === "audioasset" && object.waveform?.length) {
                const edgeTime = edge === "start" ? object.sourceStart :
                  Number(object.sourceStart || 0) + (object.end - object.start) * Math.max(.05, Number(state.audio.speed || 1));
                showTrimAudioDetail({
                  waveform: object.waveform,
                  sourceDuration: object.sourceDuration || object.duration,
                  sourceTime: edgeTime,
                  delta: (edge === "start" ? object.start - timelineDrag.originStart : object.end - timelineDrag.originEnd),
                  mode: timelineDrag.isRipple ? "波纹修剪 · 音频" : "修剪 · 音频",
                });
              }
            } else if (timelineDrag.rollEdit) {
              const speed = Math.max(.05, Number(state.audio.speed || 1));
              const roll = timelineDrag.rollEdit;
              const deltaTimeline = (e.clientX - timelineDrag.startX + $("timelineScroll").scrollLeft - Number(timelineDrag.originScrollLeft ?? $("timelineScroll").scrollLeft)) / state.zoom;
              const minCut = Number(roll.left.sourceStart || 0) + frameDuration() * speed;
              const maxCut = Number(roll.right.sourceEnd || 0) - frameDuration() * speed;
              const rollTime = frameBoundedTime(Number(roll.left.end) + deltaTimeline,
                Number(roll.left.end) + (minCut - roll.cutSource) / speed,
                Number(roll.left.end) + (maxCut - roll.cutSource) / speed,
                timelineDrag.trimType === "audio" && !state.avLinked);
              roll.targetSource = roll.cutSource + (rollTime - Number(roll.left.end)) * speed;
              const applied = (roll.targetSource - roll.cutSource) / speed;
              const cutTime = Number(roll.left.end || 0) + applied;
              const leftElement = $("timelineContent").querySelector(`.clip[data-type="${timelineDrag.trimType}"][data-id="${roll.left.id}"]`);
              const rightElement = $("timelineContent").querySelector(`.clip[data-type="${timelineDrag.trimType}"][data-id="${roll.right.id}"]`);
              if (leftElement) leftElement.style.width = `${Math.max(3, (cutTime - Number(roll.left.start || 0)) * state.zoom)}px`;
              if (leftElement) updateTimelineClipDurationLabel(leftElement, {start: roll.left.start, end: cutTime});
              if (rightElement) {
                const rightEnd = Number(roll.right.end || cutTime);
                rightElement.style.left = `${cutTime * state.zoom}px`;
                rightElement.style.width = `${Math.max(3, (rightEnd - cutTime) * state.zoom)}px`;
                updateTimelineClipDurationLabel(rightElement, {start: cutTime, end: rightEnd});
              }
              showTrimAudioDetail({
                waveform: state.waveform,
                sourceDuration: state.sourceDuration,
                sourceTime: roll.targetSource,
                delta: applied,
                mode: "Roll 滾動編輯（總時長不變）",
              });
            } else if (timelineDrag.mainTrimClip) {
              const clip = timelineDrag.mainTrimClip;
              const speed = Math.max(0.05, Number(state.audio.speed || 1));
              const sourceBounds = mainTrimSourceBounds({
                removals: timelineDrag.trimType === "audio" && !state.avLinked
                  ? state.mainAudioRemovals
                  : state.removals,
                clip,
                edge,
                snapshot: timelineDrag.mainClipsSnapshot || [],
                mode: timelineDrag.isRipple ? "ripple" : "trim",
                speed,
              });
              const originTimeline = edge === "start"
                ? timelineDrag.originStart
                : timelineDrag.originEnd;
              const originSource = edge === "start"
                ? Number(clip.sourceStart || 0)
                : Number(clip.sourceEnd || 0);
              const minTimeline = originTimeline + (sourceBounds.min - originSource) / speed;
              const maxTimeline = originTimeline + (sourceBounds.max - originSource) / speed;
              const rawTime = clamp(
                originTimeline + delta,
                minTimeline,
                maxTimeline,
              );
              timelineDrag.mainTrimTime = clamp(
                snapTime(rawTime, clip, {
                  min: minTimeline,
                  max: maxTimeline,
                  excludeTimes: [originTimeline],
                }),
                minTimeline,
                maxTimeline,
              );
              showTrimAudioDetail({
                waveform: state.waveform,
                sourceDuration: state.sourceDuration,
                sourceTime: originSource + (timelineDrag.mainTrimTime - originTimeline) * speed,
                delta: timelineDrag.mainTrimTime - originTimeline,
                mode: timelineDrag.isRipple ? "波纹修剪" : "选择修剪",
              });
              const appliedDelta = timelineDrag.mainTrimTime - originTimeline;
              let start, end;
              if (timelineDrag.isRipple && edge === "start") {
                start = timelineDrag.originStart;
                end = Math.max(start + frameDuration(), timelineDrag.originEnd - appliedDelta);
              } else {
                start = edge === "start"
                  ? timelineDrag.mainTrimTime
                  : timelineDrag.originStart;
                end = edge === "end"
                  ? timelineDrag.mainTrimTime
                  : timelineDrag.originEnd;
              }
              if (timelineDrag.element) {
                timelineDrag.element.style.left = `${start * state.zoom}px`;
                timelineDrag.element.style.width = `${Math.max(3, (end - start) * state.zoom)}px`;
                updateTimelineClipDurationLabel(timelineDrag.element, {start, end});
              }
            }
            // Preview media seeking is deferred to pointerup; clip geometry
            // remains immediate and smooth while trimming.
          } else {
            if (timelineDrag.mainTrackMove) {
              const delta = (e.clientX - timelineDrag.startX + $("timelineScroll").scrollLeft - Number(timelineDrag.originScrollLeft ?? $("timelineScroll").scrollLeft)) / state.zoom;
              const length =
                timelineDrag.mainTrackClip.end - timelineDrag.mainTrackClip.start;
              const nextStart = snapClipStart(
                Math.max(0, timelineDrag.originClipStart + delta),
                length,
                timelineDrag.mainTrackClip,
              );
              const appliedDelta = nextStart - timelineDrag.originClipStart;
              const movers = timelineDrag.movingMains?.length
                ? timelineDrag.movingMains
                : [{
                    id: timelineDrag.mainTrackClip.parentId || timelineDrag.mainTrackClip.id,
                    type: timelineDrag.mainTrackType,
                    originOffset: timelineDrag.originClipOffset,
                  }];
              for (const mover of movers) {
                const nextOffset = Number(mover.originOffset || 0) + appliedDelta;
                if (mover.type === "video") {
                  state.mainVideoClipOffsets[mover.id] = nextOffset;
                  if (state.avLinked) state.mainAudioClipOffsets[mover.id] = nextOffset;
                } else if (mover.type === "audio") {
                  state.mainAudioClipOffsets[mover.id] = nextOffset;
                  if (state.avLinked) state.mainVideoClipOffsets[mover.id] = nextOffset;
                }
              }
              for (const item of timelineDrag.linkedMoving || []) {
                item.obj.start = Math.max(0, item.originStart + appliedDelta);
                item.obj.end = Math.max(
                  item.obj.start + 0.002,
                  item.originEnd + appliedDelta,
                );
                moveBoundCaptions(item.obj,item);
              updateTimelineClipGeometry(item.type, item.id, item.obj);
              }
              timelineDrag.horizontalMoved =
                Math.abs(appliedDelta) > 0.002;
              updateMainTimelineGeometry();
              return;
            }
            const delta = (e.clientX - timelineDrag.startX + $("timelineScroll").scrollLeft - Number(timelineDrag.originScrollLeft ?? $("timelineScroll").scrollLeft)) / state.zoom;
            const moving = timelineDrag.moving || [];
            const anchor = moving[0];
            const requestedDelta = (() => {
              if (!anchor) return delta;
              const rawStart = clamp(
                anchor.originStart + delta,
                0,
                Math.max(
                  0,
                  visibleTimelineDuration() -
                    (anchor.originEnd - anchor.originStart),
                ),
              );
              const rawDelta = rawStart - anchor.originStart;
              if (!state.snapping || state.snapTemporarilyDisabled) {
                hideSnapGuide();
                return frameAlignedTime(anchor.originStart+rawDelta)-anchor.originStart;
              }
              const group = snapGroupDelta(
                moving,
                rawDelta,
                (timelineDrag.snapPoints ||= currentSnapPoints(moving)),
                snapThresholdSeconds(),
              );
              showSnapGuide(group.target, group.snapped);
              const minStart = Math.min(...moving.map((item) => Number(item.originStart || 0)));
              return frameAlignedTime(anchor.originStart+(minStart + group.delta < 0 ? -minStart : group.delta))-anchor.originStart;
            })();
            const appliedDelta = editMoveDelta(moving.map(item=>({start:item.originStart,end:item.originEnd})),requestedDelta,{fps:timelineFrameRate(),max:visibleTimelineDuration()});
            for (const item of moving) {
              const length = item.originEnd - item.originStart;
              item.obj.start = item.originStart + appliedDelta;
              item.obj.end = item.obj.start + length;
              updateTimelineClipGeometry(item.type, item.id, item.obj);
            }
          }
        }
        if (objectDrag?.pointer === e.pointerId) {
          if (e.pointerType === "mouse" && !(e.buttons & 1)) {
            cancelObjectDrag();
            return;
          }
          scheduleObjectDragMove(e.clientX, e.clientY);
        }
      }
      let timelineMoveFrame=0,timelineMoveEvent=null;
      function flushTimelinePointerMove(repeat=true){
        if(timelineMoveFrame)cancelAnimationFrame(timelineMoveFrame);timelineMoveFrame=0;
        if(timelineMoveEvent){const event=timelineMoveEvent;timelineMoveEvent=null;const scroll=$('timelineScroll'),before=scroll.scrollLeft;handleTimelinePointerMove(event);
          if(repeat&&timelineDrag&&scroll.scrollLeft!==before){timelineMoveEvent=event;timelineMoveFrame=requestAnimationFrame(()=>flushTimelinePointerMove());}
        }
      }
      document.addEventListener('pointermove',event=>{timelineMoveEvent=event;if(!timelineMoveFrame)timelineMoveFrame=requestAnimationFrame(flushTimelinePointerMove);});
      document.addEventListener('pointerup',()=>flushTimelinePointerMove(false),true);
      document.addEventListener("pointerup", (e) => {
        if (timelineDrag?.pointer === e.pointerId) {
          hideTrimAudioDetail();
          hideSnapGuide();
          if (timelineDrag.marquee) {
            $("timelineMarquee").classList.remove("on");
            if (timelineDrag.moved) {
              const left = Math.min(timelineDrag.startX, e.clientX),
                right = Math.max(timelineDrag.startX, e.clientX),
                top = Math.min(timelineDrag.startY, e.clientY),
                bottom = Math.max(timelineDrag.startY, e.clientY),
                contentRect = $("timelineContent").getBoundingClientRect(),
                range = {
                  start: (left - contentRect.left) / Math.max(1e-6, state.zoom),
                  end: (right - contentRect.left) / Math.max(1e-6, state.zoom),
                },
                hits = [...$("timelineContent").querySelectorAll(".clip[data-type][data-id]")]
                  .filter((clip) => {
                    const rect = clip.getBoundingClientRect();
                    return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
                  })
                  .map((clip) => ({ type: clip.dataset.type, id: clip.dataset.id }));
              const merged = timelineDrag.additive
                ? [...(state.selectedItems || []), ...hits]
                : hits;
              state.selectedItems = expandLinkedSelection(
                [...new Map(merged.map((item) => [selectionKey(item.type, item.id), item])).values()],
              );
              state.selected = state.selectedItems.at(-1) || { type: "video", id: "main" };
              renderTimeline();
              renderPreviewObjects();
              updateInspector();
            } else {
              const rect = $("timelineContent").getBoundingClientRect();
              if (state.playing) void togglePlay();
              seekTimeline((e.clientX - rect.left) / state.zoom);
              timelineGapSelection = timelineDrag.gapCandidate
                ? { ...timelineDrag.gapCandidate }
                : null;
              renderTimeline();
            }
          }
          if (timelineDrag.rollEdit && Number.isFinite(timelineDrag.rollEdit.targetSource)) {
            const roll = timelineDrag.rollEdit;
            const audioOnly = timelineDrag.trimType === "audio" && !state.avLinked;
            const previous = audioOnly ? mainAudioClips() : mainClips();
            const committed = rollingEditMainClips(
              audioOnly ? state.mainAudioRemovals : state.removals,
              audioOnly ? state.mainAudioManualCuts : state.manualCuts,
              roll.left,
              roll.right,
              roll.targetSource,
            );
            if (audioOnly) {
              state.mainAudioRemovals = committed.removals;
              state.mainAudioManualCuts = committed.manualCuts;
              adoptMainAudioMaps(previous);
            } else {
              state.removals = committed.removals;
              state.manualCuts = committed.manualCuts;
              normalizeRemovals();
              adoptClipMaps(previous, mainClips());
            }
            recomputeContentDuration();
            renderAll();
          }
          if (timelineDrag.trim && timelineDrag.trimObject && timelineDrag.trimType === "caption")
            clampCaptionWordsToBounds(timelineDrag.trimObject);
          if (timelineDrag.trim && !timelineDrag.rollObjects && timelineDrag.trimObject && ['videolayer','audioasset'].includes(timelineDrag.trimType)) {
            const object = timelineDrag.trimObject;
            const owners = new Set([object.id, ...[...state.videoLayers, ...state.audioAssets]
              .filter(x => state.avLinked && x.linkGroupId && x.linkGroupId === object.linkGroupId).map(x => x.id)]);
            // Ripple trims can keep the placed start fixed while changing its
            // source handle. Derive the removed window from the original source.
            for (const item of timelineDrag.trimOrigins || []) {
              const before = item.origin, after = item.obj;
              const rate = editRate(before, Number(state.audio.speed || 1));
              const head = (Number(after.sourceStart) - Number(before.sourceStart)) / rate;
              const tail = (Number(before.sourceEnd) - Number(after.sourceEnd)) / rate;
              if (head > .001) dismissTrimmedIssues(before.start, before.start + head, owners);
              if (tail > .001) dismissTrimmedIssues(before.end - tail, before.end, owners);
            }
          }
          if (timelineDrag.trim && !timelineDrag.rollObjects && timelineDrag.trimObject && timelineDrag.isRipple) {
            const object=timelineDrag.trimObject;
            const linked=state.avLinked?[...state.videoLayers,...state.audioAssets].filter(x=>x.linkGroupId&&x.linkGroupId===object.linkGroupId):[];
            const delta=(object.end-object.start)-(timelineDrag.originEnd-timelineDrag.originStart);
            applyEditRipple(timelineDrag.originEnd,delta,[object,...linked]);
          }
          if (timelineDrag.trim && timelineDrag.mainTrimClip && !timelineDrag.rollEdit &&
              Number.isFinite(timelineDrag.mainTrimTime)) {
            const clip = timelineDrag.mainTrimClip;
            const audioOnly = timelineDrag.trimType === "audio" && !state.avLinked;
            const speed = Math.max(0.05, Number(state.audio.speed || 1));
            const originStart = Number(timelineDrag.originStart);
            const originEnd = Number(timelineDrag.originEnd);
            const edgeTime = Number(timelineDrag.mainTrimTime);
            const delta = timelineDrag.trimEdge === "start"
              ? (edgeTime - originStart)
              : (edgeTime - originEnd);
            const targetSource = timelineDrag.trimEdge === "start"
              ? Math.max(0, Number(clip.sourceStart || 0) + delta * speed)
              : Math.max(0, Number(clip.sourceEnd || 0) + delta * speed);
            const snapshot = timelineDrag.mainClipsSnapshot ||
              (audioOnly ? baseMainAudioClips() : mainClips());
            const previousAudioClips = audioOnly ? mainAudioClips() : [];
            const committed = commitMainEdgeTrim({
              removals: audioOnly ? state.mainAudioRemovals : state.removals,
              manualCuts: audioOnly ? state.mainAudioManualCuts : state.manualCuts,
              clip,
              edge: timelineDrag.trimEdge,
              targetSource,
              mode: timelineDrag.isRipple ? "ripple" : "trim",
              snapshot,
              globalOffset: audioOnly
                ? Math.max(0, Number(state.mainAudioTimelineOffset || 0))
                : Math.max(0, Number(state.mainTimelineOffset || 0)),
              speed,
            });
            const reviewDelta = (Number(committed.targetSource) -
              Number(timelineDrag.trimEdge === "start" ? clip.sourceStart : clip.sourceEnd)) / speed;
            if (timelineDrag.trimEdge === "end" && reviewDelta < -.001)
              dismissTrimmedIssues(originEnd + reviewDelta, originEnd);
            else if (timelineDrag.trimEdge === "start" && reviewDelta > .001)
              dismissTrimmedIssues(originStart, originStart + reviewDelta);
            if (audioOnly) {
              state.mainAudioRemovals = committed.removals;
              state.mainAudioManualCuts = committed.manualCuts;
              state.mainAudioClipOffsets = committed.audioOffsets;
              adoptMainAudioMaps(previousAudioClips);
              const appliedDelta = (Number(committed.targetSource) -
                Number(timelineDrag.trimEdge === "start" ? clip.sourceStart : clip.sourceEnd)) / speed;
              if (timelineDrag.trimEdge === "end" && appliedDelta < -0.001) {
                if (timelineDrag.isRipple)
                  rippleSubtitleTimeline(originEnd + appliedDelta, originEnd);
                else trimSubtitleTimeline(originEnd + appliedDelta, originEnd);
              } else if (timelineDrag.trimEdge === "start" && appliedDelta > 0.001) {
                if (timelineDrag.isRipple)
                  rippleSubtitleTimeline(originStart, originStart + appliedDelta);
                else trimSubtitleTimeline(originStart, originStart + appliedDelta);
              }
              recomputeContentDuration();
            } else {
              state.removals = committed.removals;
              state.manualCuts = committed.manualCuts;
              normalizeRemovals();
              state.mainVideoClipOffsets = committed.videoOffsets;
              state.mainAudioClipOffsets = committed.audioOffsets;
              adoptClipMaps(snapshot, committed.packed);
              if (timelineDrag.isRipple) {
                applyOverlayRipple(committed.overlayFrom, committed.overlayDelta);
              } else {
                const appliedDelta = (Number(committed.targetSource) -
                  Number(timelineDrag.trimEdge === "start" ? clip.sourceStart : clip.sourceEnd)) / speed;
                if (timelineDrag.trimEdge === "end" && appliedDelta < -0.001)
                  trimSubtitleTimeline(originEnd + appliedDelta, originEnd);
                else if (timelineDrag.trimEdge === "start" && appliedDelta > 0.001)
                  trimSubtitleTimeline(originStart, originStart + appliedDelta);
              }
              recomputeContentDuration();
            }
            renderAll();
          }
          if (timelineDrag.moving?.length &&
              Math.abs(e.clientY - Number(timelineDrag.startY || e.clientY)) > 16) {
            const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".trackrow");
            if (row) {
              const targetId = row.dataset.trackKey;
              const targetKind = trackInfo(targetId).kind;
              let moved = 0;
              let familyMatched = false;
              const familyOf = (type) => type === "audioasset" ? "audio"
                : ["videolayer", "image", "text"].includes(type) ? "video" : type;
              const primaryMoves = timelineDrag.moving.filter((item) => familyOf(item.type) === targetKind);
              const assignments = primaryMoves.map((item) => ({ item, trackId: targetId }));
              if (state.avLinked && ["video", "audio"].includes(targetKind)) {
                const partnerKind = targetKind === "video" ? "audio" : "video";
                const groups = new Set(primaryMoves.map((item) => item.obj?.linkGroupId).filter(Boolean));
                const partnerMoves = timelineDrag.moving.filter((item) =>
                  familyOf(item.type) === partnerKind && groups.has(item.obj?.linkGroupId),
                );
                if (partnerMoves.length) {
                  const pairedTrackId = pairedTrackForVerticalMove(targetId, targetKind);
                  for (const item of partnerMoves) {
                  assignments.push({ item, trackId: pairedTrackId });
                  }
                }
              }
              for (const { item } of assignments) familyMatched ||= familyOf(item.type) === targetKind;
              if (assignments.some(({ trackId }) => isTrackLocked(trackId))) {
                toast("目标轨道或联动轨道已锁定，所选片段没有换轨。");
              } else {
                for (const { item, trackId: assignedTrack } of assignments) {
                  if (item.obj.trackId !== assignedTrack) {
                    item.obj.trackId = assignedTrack;
                    moved += 1;
                  }
                }
              }
              if (moved) {
                cleanupEmptyDynamicTracks();
                renderAll();
              } else if (!familyMatched && timelineDrag.moving.some((moving) =>
                ["videolayer", "audioasset", "image", "text", "caption"].includes(moving.type),
              )) {
                toast("请把视频、图片或标题放到视频轨，把音频放到音频轨；字幕放到字幕轨。");
              }
            }
          }
          if (timelineDrag.moving?.length) {
            for (const mover of timelineDrag.moving) {
              if (
                Math.abs(Number(mover.obj?.start || 0) - Number(mover.originStart || 0)) > 0.002 ||
                String(mover.obj?.trackId || selectionTrackId(mover.type, mover.id)) !== String(mover.originTrackId || "")
              )
                applyOverlayTrackOverwrite(mover.type, mover.obj, { overwriteMain: true });
            }
          }
          if (timelineDrag.mainTrackMove &&
              Math.abs(e.clientY - Number(timelineDrag.startY || e.clientY)) > 16) {
            const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".trackrow");
            if (row) {
              const targetId = row.dataset.trackKey;
              const kind = timelineDrag.mainTrackType;
              if (trackInfo(targetId).kind === kind) {
                const clipId = timelineDrag.mainTrackClip.parentId || timelineDrag.mainTrackClip.id;
                const pairedTrack = state.avLinked ? pairedTrackForVerticalMove(targetId, kind) : "";
                if (isTrackLocked(targetId) || (pairedTrack && isTrackLocked(pairedTrack))) {
                  toast("目标轨道或联动轨道已锁定，主素材没有换轨。");
                } else {
                  const map = kind === "video" ? state.mainVideoTrackMap : state.mainAudioTrackMap;
                  if (targetId === kind) delete map[clipId];
                  else map[clipId] = targetId;
                  if (pairedTrack) {
                    const partnerMap = kind === "video" ? state.mainAudioTrackMap : state.mainVideoTrackMap;
                    const partnerKind = kind === "video" ? "audio" : "video";
                    if (pairedTrack === partnerKind) delete partnerMap[clipId];
                    else partnerMap[clipId] = pairedTrack;
                  }
                  timelineDrag.trackChanged = true;
                  cleanupEmptyDynamicTracks();
                  renderAll();
                }
              } else {
                toast("请把片段拖到相同类型的轨道上；视频和音频轨道分别移动。");
              }
            }
          }
          if (timelineDrag.mainTrackMove && (timelineDrag.horizontalMoved || timelineDrag.trackChanged)) {
            applyMainTrackOverwrite(
              timelineDrag.mainTrackClip.parentId || timelineDrag.mainTrackClip.id,
              timelineDrag.mainTrackType,
              { overwriteOverlays: true },
            );
          }
          recomputeContentDuration();
          renderTimeline();
          renderPreviewObjects();
          updateInspector();
          timelineDrag = null;
          queueAutosave();
        }
        if (objectDrag?.pointer === e.pointerId) {
          if (objectDrag.framePending) cancelAnimationFrame(objectDrag.framePending);
          applyObjectDragMove(e.clientX, e.clientY);
          if (objectDrag.needsCaptionReflow) {
            void applyCaptionGrouping(state.captions, state.captionLines).then((captions) => {
              state.captions = captions;
              keepCaptionSelection();
              renderAll();
              queueAutosave();
            });
          }
          updateTransformInspector(objectDrag.obj);
          $("centerGuide").classList.remove("on");
          $("frame").classList.remove("object-dragging");
          objectDrag = null;
          renderPreviewObjects();
          updateInspector();
          queueAutosave();
        }
      });
      $("issueList").onclick = (e) => {
        const i = e.target.closest("[data-issue]");
        if (i) selectIssue(i.dataset.issue);
      };
      $("replaceCaptionsFromScript").onclick = replaceCaptionsFromManuscript;
      function syncTrailingPunctuationSetting(enabled) {
        if (!state.captionStyle) state.captionStyle = {};
        state.captionStyle.stripTrailingPunctuation = enabled;
        if ($("cleanTrailingPunctuation")) $("cleanTrailingPunctuation").checked = enabled;
        if ($("cleanTrailingPunctuationInspector")) $("cleanTrailingPunctuationInspector").checked = enabled;
        for (const caption of state.captions) {
          if (Array.isArray(caption.words) && caption.words.length) {
            caption.text = joinCaptionWords(caption.words);
          }
        }
        captionInspectorKey = "";
        renderAll();
        renderCaptionInspector(true);
        queueAutosave();
      }
      if ($("cleanTrailingPunctuation")) {
        $("cleanTrailingPunctuation").onchange = () => {
          syncTrailingPunctuationSetting($("cleanTrailingPunctuation").checked);
        };
      }
      if ($("cleanTrailingPunctuationInspector")) {
        $("cleanTrailingPunctuationInspector").onchange = () => {
          syncTrailingPunctuationSetting($("cleanTrailingPunctuationInspector").checked);
        };
      }
      $("captionInspectorList").oninput = (event) => {
        const auxEditor = event.target.closest("[data-caption-aux-edit]");
        if (auxEditor) {
          const caption = state.captions.find((item) => item.id === auxEditor.dataset.captionAuxEdit);
          if (!caption) return;
          caption.auxText = auxEditor.value;
          caption.auxSourceText = caption.text;
          caption.auxLanguage = state.auxSubtitles.language;
          caption.auxLocked = true;
          renderPreviewObjects(true);
          syncAuxSubtitleControls();
          queueAutosave();
          return;
        }
        const editor = event.target.closest("[data-caption-edit]");
        if (!editor) return;
        const caption = state.captions.find((item) => item.id === editor.dataset.captionEdit);
        if (!caption) return;
        fitCaptionTextarea(editor);
        const tokens = editableCaptionTokens(editor.value);
        const existingWords = Array.isArray(caption.words) ? caption.words : [];
        recordCaptionTextChange(caption,caption.text || '',editor.value);
        caption.text = editor.value;
        caption.words = tokens.length && tokens.length === existingWords.length
          ? existingWords.map((word, index) => ({ ...word, display: tokens[index],
            ...(word.display!==tokens[index]?{originalDisplay:word.originalDisplay || word.display,userKept:true,matchType:'edited',issueType:'',issueId:'',action:''}:{}) }))
          : locallyRetimeEditedCaptionWords(existingWords,tokens,caption);
        const auxStatus = auxiliaryCaptionState(caption);
        const auxLabel = editor.closest("[data-caption-row]")?.querySelector(".caption-aux-state");
        if (auxLabel) {
          auxLabel.className = `caption-aux-state ${auxStatus.key}`;
          auxLabel.textContent = auxStatus.label;
        }
        captionInspectorKey = "";
        renderTimeline();
        renderPreviewObjects();
        syncAuxSubtitleControls();
        const copy = editor.closest('.caption-inspector-copy');
        copy?.querySelectorAll('.caption-mismatch-suggestion').forEach(node => node.remove());
        copy?.insertAdjacentHTML('beforeend',renderCaptionMismatchSuggestions(caption));
        queueAutosave();
      };
      $("captionInspectorList").onclick = (event) => {
        if (event.target.closest('[data-reference-choice]')) return;
        const emphasisButton = event.target.closest("[data-caption-emphasis]");
        if (emphasisButton) {
          event.preventDefault();
          event.stopPropagation();
          const caption = state.captions.find((item) => item.id === emphasisButton.dataset.captionEmphasis);
          const index = Number(emphasisButton.dataset.wordIndex);
          if (!caption || !Number.isInteger(index) || isTrackLocked(caption.trackId || "caption")) return;
          const tokens = editableCaptionTokens(caption.text);
          if (!Array.isArray(caption.words) || caption.words.length !== tokens.length)
            caption.words = timedCaptionWords(caption.text, caption);
          const word = caption.words[index];
          if (!word) return;
          snapshot();
          word.emphasis = !word.emphasis;
          captionInspectorKey = "";
          renderCaptionInspector(true);
          renderTimeline();
          renderPreviewObjects(true);
          queueAutosave();
          return;
        }
        const replacement = event.target.closest("[data-caption-mismatch-replace]");
        if (replacement) {
          event.preventDefault();
          const row = replacement.closest("[data-caption-row]");
          if (row) replaceAutoCaptionMismatch(row.dataset.captionRow, Number(replacement.dataset.captionMismatchReplace));
          return;
        }
        const button = event.target.closest("[data-caption-aux-retranslate]");
        if (button) {
          event.preventDefault();
          generateAuxiliarySubtitles([button.dataset.captionAuxRetranslate]);
          return;
        }
        if (event.target.closest("textarea")) return;
        const row = event.target.closest("[data-caption-row]");
        if (row) revealCaptionOnTimeline(row.dataset.captionRow);
      };
      if ($("generateAuxSubtitles"))
        $("generateAuxSubtitles").onclick = () => generateAuxiliarySubtitles();
      if ($("auxSubtitleLanguage"))
        $("auxSubtitleLanguage").onchange = () => {
          state.auxSubtitles.language = $("auxSubtitleLanguage").value || "zh-Hans";
          captionInspectorKey = "";
          renderCaptionInspector(true);
          syncAuxSubtitleControls();
          queueAutosave();
        };
      if ($("auxSubtitleEditorVisible"))
        $("auxSubtitleEditorVisible").onchange = () => {
          state.auxSubtitles.editorVisible = $("auxSubtitleEditorVisible").checked;
          renderPreviewObjects(true);
          queueAutosave();
        };
      $("visualLayer").onpointerdown = (e) => {
        const o = e.target.closest("[data-type]");
        if (!o) return;
        selectItem(
          o.dataset.type,
          o.dataset.id,
          e.shiftKey || e.metaKey || e.ctrlKey,
          e.metaKey || e.ctrlKey,
        );
        window.syncPreviewTimelineSelection?.(o.dataset.type, o.dataset.id, false);
        if (o.dataset.type === "videolayer") {
          const clip = currentObject();
          const region = clip && window.spliceRegionForExport?.({ type: "layer", clip, settings: clip, media: clip });
          if (region) { state.spliceSelectedRegionId = region.id; window.syncSplicePanel?.(); }
        }
        if (!guardUnlocked(o.dataset.type, o.dataset.id)) return;
        const obj = currentObject();
        snapshot();
        objectDrag = {
          pointer: e.pointerId,
          obj,
          startX: e.clientX,
          startY: e.clientY,
          x: obj.x || 0,
          y: obj.y || 0,
        };
        captureObjectPointer(e);
        $("frame").classList.add("object-dragging");
        updateSelectionBox();
        e.preventDefault();
      };
      $("captionPreview").onpointerdown = (e) => {
        const caption = captionAtTime(state.currentTime);
        if (!caption) return;
        selectItem("caption", caption.id, false, false);
        if (!guardUnlocked("caption", caption.id)) return;
        snapshot();
        objectDrag = {
          pointer: e.pointerId,
          obj: state.captionTransform,
          startX: e.clientX,
          startY: e.clientY,
          x: state.captionTransform.x || 0,
          y: state.captionTransform.y || 0,
        };
        captureObjectPointer(e);
        $("frame").classList.add("object-dragging");
        updateSelectionBox();
        e.preventDefault();
        e.stopPropagation();
      };
      $("reviewPreview").onpointerdown = (e) => {
        const id = e.currentTarget.dataset.id;
        if (id) selectIssue(id);
        e.preventDefault();
      };
      $("selectionBox").onpointerdown = (e) => {
        const handle = e.target.closest("[data-handle]"),
          widthHandle = e.target.closest("[data-width-handle]"),
          rotateHandle = e.target.closest("[data-rotate-handle]");
        if (!handle && !widthHandle && !rotateHandle) return;
        if (!guardUnlocked()) return;
        const object = currentObject();
        if (!object) return;
        const rect = $("selectionBox").getBoundingClientRect();
        const centerX = rect.left + rect.width / 2,
          centerY = rect.top + rect.height / 2,
          textElement = state.selected.type === "caption"
            ? $("captionPreview")
            : $("frame").querySelector(`[data-type="text"][data-id="${state.selected.id}"]`),
          minimumWidth = widthHandle
            ? minimumTwoLineTextWidth(
                textElement,
                ($("frame").clientWidth || 1) / Number(state.width || 1080),
              )
            : 160;
        objectDrag = {
          pointer: e.pointerId,
          obj: object,
          resize: !!handle,
          widthResize: !!widthHandle,
          widthSide: widthHandle?.dataset.widthHandle || "",
          rotate: !!rotateHandle,
          startX: e.clientX,
          startY: e.clientY,
          scale: object.scale || 1,
          handleDirection: handle?.dataset.handle || "",
          width: Number(object.width) || Number(state.width || 1080) * 0.8,
          minimumWidth,
          x: Number(object.x || 0),
          size: Math.max(rect.width, rect.height),
          centerX,
          centerY,
          rotation: Number(object.rotation || 0),
          startAngle: (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI,
        };
        captureObjectPointer(e);
        $("frame").classList.add("object-dragging");
        e.preventDefault();
        e.stopPropagation();
      };
      $("video").onpointerdown = (e) => {
        const clip = activeMainVideoClip();
        if (!clip) return;
        selectItem("video", clip.id, false, false);
        window.syncPreviewTimelineSelection?.("video", clip.id, false);
        const settings = mainVideoSettings(clip);
        const region = window.spliceRegionForExport?.({ type: "main", clip, settings, media: state.video });
        if (region) { state.spliceSelectedRegionId = region.id; window.syncSplicePanel?.(); }
        if (!guardUnlocked("video", clip.id)) return;
        snapshot();
        const transform = settings;
        objectDrag = {
          pointer: e.pointerId,
          obj: transform,
          startX: e.clientX,
          startY: e.clientY,
          x: transform.x || 0,
          y: transform.y || 0,
        };
        captureObjectPointer(e);
        $("frame").classList.add("object-dragging");
        updateSelectionBox();
        e.preventDefault();
      };
      window.syncPreviewTimelineSelection = (type, id, select = true) => {
        if (select) selectItem(type, id, false, false);
        renderTimeline();
        updateInspector();
        updateSelectionBox();
        window.revealTimelineClip?.(type, id);
      };
      function eventInTimelineZoomArea(target) {
        return Boolean(
          target?.closest?.(
            "#timeline, #timelineScroll, #timelineMain, #trackLabels, #rulerBar, #rulerTimecode, #timelineZoom",
          ),
        );
      }
      function preventBrowserPageZoom(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      let wheelZoomTarget = 60;
      let wheelZoomFrame = 0;
      let wheelZoomAnchorX = 0;
      function scheduleFluidTimelineZoom(deltaPixels, clientX) {
        wheelZoomTarget = clamp(wheelZoomTarget * Math.exp(-clamp(deltaPixels, -120, 120) * 0.0024), 0.1, 6000);
        wheelZoomAnchorX = clientX;
        if (wheelZoomFrame) return;
        wheelZoomFrame = requestAnimationFrame(() => {
          wheelZoomFrame = 0;
          const distance = wheelZoomTarget - Number(state.zoom || 60);
          const next = Math.abs(distance) < 0.08 ? wheelZoomTarget : Number(state.zoom || 60) + distance * 0.72;
          setTimelineZoomAroundPlayhead(next, wheelZoomAnchorX, true);
          if (Math.abs(wheelZoomTarget - next) >= 0.08) scheduleFluidTimelineZoom(0, wheelZoomAnchorX);
        });
      }
      window.addEventListener(
        "wheel",
        (e) => {
          const inTimeline = eventInTimelineZoomArea(e.target);
          if (!inTimeline) return;
          const deltaPixels = e.deltaMode === 1 ? Number(e.deltaY || 0) * 16 : e.deltaMode === 2 ? Number(e.deltaY || 0) * 120 : Number(e.deltaY || 0);
          if ((e.ctrlKey || e.metaKey) && inTimeline) {
            preventBrowserPageZoom(e);
            if (!wheelZoomFrame && Math.abs(wheelZoomTarget - Number(state.zoom || 60)) > 0.2) wheelZoomTarget = Number(state.zoom || 60);
            wheelZoomTarget = Number.isFinite(wheelZoomTarget) ? wheelZoomTarget : Number(state.zoom || 60);
            scheduleFluidTimelineZoom(deltaPixels, e.clientX);
            return;
          }
          if (e.altKey && inTimeline) {
            preventBrowserPageZoom(e);
            if (!wheelZoomFrame && Math.abs(wheelZoomTarget - Number(state.zoom || 60)) > 0.2) wheelZoomTarget = Number(state.zoom || 60);
            wheelZoomTarget = Number.isFinite(wheelZoomTarget) ? wheelZoomTarget : Number(state.zoom || 60);
            scheduleFluidTimelineZoom(deltaPixels, e.clientX);
            return;
          }
          if (e.shiftKey && $("timelineScroll")) {
            e.preventDefault();
            $("timelineScroll").scrollLeft += Number(e.deltaY || e.deltaX || 0);
          }
        },
        { passive: false, capture: true },
      );
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
        window.addEventListener(type, preventBrowserPageZoom, { passive: false, capture: true });
      }
      $("timelineScroll").addEventListener("scroll", () => {
        $("trackLabels").scrollTop = $("timelineScroll").scrollTop;
        syncTimelineChrome();
        scheduleTimelineViewportRender();
      });
      if ($("timelineMain")) {
        $("timelineMain").addEventListener("pointerleave", () => {
          if (!timelineDrag) setBladeGuide(0, false);
        });
      }
      let canvasZoomFrame = 0;
      $("stage").addEventListener(
        "wheel",
        (event) => {
          event.preventDefault();
          const rawDelta = Number(event.deltaY || 0);
          const deltaPixels = event.deltaMode === 1 ? rawDelta * 16 : (event.deltaMode === 2 ? rawDelta * 120 : rawDelta);
          const delta = clamp(deltaPixels, -12, 12);
          const factor = Math.exp(-delta * 0.00045);
          state.canvasZoom = clamp(Number(state.canvasZoom || 1) * factor, 0.25, 4);
          if (canvasZoomFrame) return;
          canvasZoomFrame = requestAnimationFrame(() => {
            canvasZoomFrame = 0;
            const frame = $("frame");
            if (frame) frame.style.transform = `scale(${state.canvasZoom})`;
            const label = $("canvasZoomLabel");
            if (label) label.textContent = `${Math.round(state.canvasZoom * 100)}%`;
            // Selection handles are descendants of the transformed frame and
            // scale with it; recalculating their geometry on every wheel event
            // caused avoidable layout work and visible stutter.
          });
        },
        { passive: false },
      );
      $("objectScale").oninput = (e) => {
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.scale = Number(e.target.value) / 100; },
        );
        if (!targets.length) return;
        $("scaleOut").textContent = `${e.target.value}%`;
        updatePreviewTransformOnly();
        queueAutosave();
        // Caption grouping depends on the rendered scale. Reflow while the
        // scale slider moves so a word that no longer fits becomes the start
        // of the following caption instead of wrapping inside this one.
        if (state.selected?.type === "caption") scheduleCaptionReflow();
      };
      $("objectX").oninput = (e) => {
        window.syncPositionControlValue?.("X", e.target.value);
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.x = Number(e.target.value); },
        );
        if (targets.length) {
          updatePreviewTransformOnly();
          queueAutosave();
        }
      };
      $("objectY").oninput = (e) => {
        window.syncPositionControlValue?.("Y", e.target.value);
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.y = Number(e.target.value); },
        );
        if (targets.length) {
          updatePreviewTransformOnly();
          queueAutosave();
        }
      };
      $("objectXRange").oninput = (e) => {
        window.syncPositionControlValue?.("X", e.target.value);
        const targets = mutateSelectedVisualTransforms((object) => { object.x = Number(e.target.value); });
        if (targets.length) { updatePreviewTransformOnly(); queueAutosave(); }
      };
      $("objectYRange").oninput = (e) => {
        window.syncPositionControlValue?.("Y", e.target.value);
        const targets = mutateSelectedVisualTransforms((object) => { object.y = Number(e.target.value); });
        if (targets.length) { updatePreviewTransformOnly(); queueAutosave(); }
      };
      $("objectRotation").oninput = (e) => {
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.rotation = Number(e.target.value); },
        );
        if (!targets.length) return;
        $("rotationOut").textContent = `${e.target.value}°`;
        updatePreviewTransformOnly();
      };
      $("objectOpacity").oninput = (e) => {
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.opacity = Number(e.target.value) / 100; },
        );
        if (!targets.length) return;
        $("opacityOut").textContent = `${e.target.value}%`;
        updatePreviewTransformOnly();
      };
      $("objectBlendMode").onchange = (e) => {
        const targets = mutateSelectedVisualTransforms(
          (object) => { object.blendMode = e.target.value; },
        );
        if (!targets.length) return;
        renderPreviewObjects();
        queueAutosave();
      };
      for (const [id, key] of [
        ["cropTop", "cropTop"],
        ["cropBottom", "cropBottom"],
        ["cropLeft", "cropLeft"],
        ["cropRight", "cropRight"],
      ]) {
        if ($(id)) {
          $(id).oninput = (e) => {
            const opposite = { cropTop: "cropBottom", cropBottom: "cropTop", cropLeft: "cropRight", cropRight: "cropLeft" }[key];
            const selectedObject = currentObject();
            const oppositeValue = Math.max(0, Number(selectedObject?.[opposite] || 0));
            const value = Math.max(0, Math.min(95 - oppositeValue, Number(e.target.value) || 0));
            e.target.value = String(value);
            const targets = mutateSelectedVisualTransforms(
              (object) => { object[key] = value; },
            );
            if (!targets.length) return;
            $(`${id}Out`).textContent = `${value}%`;
            renderPreviewObjects();
            queueAutosave();
          };
        }
      }
      if ($("resetCropBtn")) {
        $("resetCropBtn").onclick = () => {
          if (!guardUnlocked()) return;
          snapshot();
          const targets = mutateSelectedVisualTransforms((object) => {
            object.cropTop = 0;
            object.cropBottom = 0;
            object.cropLeft = 0;
            object.cropRight = 0;
          });
          if (!targets.length) return;
          if ($("cropTop")) {
            $("cropTop").value = 0;
            $("cropTopOut").textContent = "0%";
            $("cropBottom").value = 0;
            $("cropBottomOut").textContent = "0%";
            $("cropLeft").value = 0;
            $("cropLeftOut").textContent = "0%";
            $("cropRight").value = 0;
            $("cropRightOut").textContent = "0%";
          }
          renderPreviewObjects();
          queueAutosave();
        };
      }
      $("centerObject").onclick = () => {
        if (guardUnlocked()) {
          snapshot();
          const targets = mutateSelectedVisualTransforms((object) => {
            object.x = 0;
            object.y = 0;
          });
          if (!targets.length) return;
          renderAll();
        }
      };
      $("fitObject").onclick = () => {
        if (guardUnlocked()) {
          snapshot();
          const targets = mutateSelectedVisualTransforms((object) => {
            object.scale = 1;
            object.x = 0;
            object.y = 0;
          });
          if (!targets.length) return;
          renderAll();
        }
      };
      for (const id of [
        "objectScale", "objectX", "objectY", "objectXRange", "objectYRange", "objectRotation", "objectOpacity",
        "objectBlendMode", "cropTop", "cropBottom", "cropLeft", "cropRight",
      ]) {
        const control = $(id);
        if (!control) continue;
        control.addEventListener("pointerdown", () => {
          if (guardUnlocked()) snapshot();
        });
        control.addEventListener("keydown", (event) => {
          if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && guardUnlocked())
            snapshot();
        });
      }
      function refreshLiveTextStyle(reflow = true) {
        const style = currentStyle() || state.captionStyle;
        if (!style) return;
        if (state.selected.type === "caption" || state.captions.length) {
          const caption = captionAtTime(state.currentTime) ||
            state.captions.find((item) => item.id === state.selected.id) ||
            state.captions[0];
          const preview = $("captionPreview");
          if (preview) {
            if (caption && reflow) renderCaptionWords(preview, caption);
            if (caption) updateCaptionWordStates(preview);
            preview.style.setProperty("--active", state.captionStyle.highlight || "#ffd21f");
            preview.classList.toggle("no-highlight", state.captionStyle.highlightEnabled === false);
            const px = ($("frame").clientWidth || 1) / Math.max(1, state.width);
            applyCaptionCanvasHost(preview, px);
          }
        }
        if (state.selected.type === "text") {
          const obj = currentObject();
          const el = $("frame").querySelector(`[data-type="text"][data-id="${state.selected.id}"]`);
          if (el && obj) {
            const px = ($("frame").clientWidth || 1) / Math.max(1, state.width);
            applyTextStyle(el, obj.style || state.captionStyle, px);
            applyTextBoxWidth(el, obj.width, px);
          }
        }
        updateSelectionBox();
        queueAutosave();
      }

      for (const id of [
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "wordSpacing",
        "lineHeight",
        "fontColor",
        "highlightColor",
        "highlightEnabled",
        "strokeColor",
        "stroke",
        "shadowColor",
        "shadowStrength",
        "shadowOpacity",
        "shadowBlur",
        "shadowDistance",
        "shadowAngle",
        "glowColor",
        "glow",
        "backgroundEnabled",
        "backgroundFitText",
        "backgroundColor",
        "backgroundOpacity",
        "backgroundWidth",
        "backgroundHeight",
        "backgroundX",
        "backgroundY",
        "backgroundRadius",
      ]) {
        const syncAndRefresh = () => {
          const s = currentStyle() || state.captionStyle;
          if (!s) return;
          s.fontSize = Number($("fontSize").value);
          s.fontWeight = Number($("fontWeight").value);
          s.letterSpacing = Number($("letterSpacing").value);
          s.wordSpacing = Number($("wordSpacing").value);
          s.lineHeight = Number($("lineHeight").value) / 100;
          $("letterSpacingOut").textContent = `${s.letterSpacing}px`;
          $("wordSpacingOut").textContent = `${s.wordSpacing}px`;
          $("lineHeightOut").textContent = `${Math.round(s.lineHeight * 100)}%`;
          s.color = $("fontColor").value;
          s.highlight = $("highlightColor").value;
          s.highlightColor = $("highlightColor").value;
          s.highlightEnabled = $("highlightEnabled").checked;
          s.strokeColor = $("strokeColor").value;
          s.stroke = Number($("stroke").value);
          s.shadowColor = $("shadowColor").value;
          s.shadow = Number($("shadowStrength").value);
          s.shadowOpacity = Number($("shadowOpacity").value) / 100;
          s.shadowBlur = Number($("shadowBlur").value);
          s.shadowDistance = Number($("shadowDistance").value);
          s.shadowAngle = ((Number($("shadowAngle").value) % 360) + 360) % 360;
          $("shadowStrengthOut").textContent = s.shadow.toFixed(1);
          $("shadowOpacityOut").textContent = `${Math.round(s.shadowOpacity * 100)}%`;
          $("shadowBlurOut").textContent = s.shadowBlur;
          $("shadowDistanceOut").textContent = s.shadowDistance;
          $("shadowAngleOut").textContent = `${s.shadowAngle}°`;
          s.glowColor = $("glowColor").value;
          s.glow = Number($("glow").value);
          $("glowOut").textContent = s.glow;
          s.backgroundEnabled = $("backgroundEnabled").checked;
          if ($("backgroundFitText")) s.backgroundFitText = $("backgroundFitText").checked;
          s.background = $("backgroundColor").value;
          s.backgroundColor = $("backgroundColor").value;
          s.backgroundOpacity = Number($("backgroundOpacity").value) / 100;
          $("backgroundOpacityOut").textContent = `${Math.round(s.backgroundOpacity * 100)}%`;
          s.backgroundWidth = Number($("backgroundWidth").value);
          s.backgroundHeight = Number($("backgroundHeight").value);
          s.backgroundX = Number($("backgroundX").value);
          s.backgroundY = Number($("backgroundY").value);
          s.padding = Math.max(s.backgroundWidth, s.backgroundHeight);
          s.radius = Number($("backgroundRadius").value);
          s.backgroundRadius = Number($("backgroundRadius").value);
          $("backgroundWidthOut").textContent = s.backgroundWidth;
          $("backgroundHeightOut").textContent = s.backgroundHeight;
          $("backgroundXOut").textContent = s.backgroundX;
          $("backgroundYOut").textContent = s.backgroundY;
          $("backgroundRadiusOut").textContent = s.radius;
          refreshLiveTextStyle(true);
        };
        const el = $(id);
        if (el) {
          el.oninput = () => {
            syncAndRefresh();
            if (["fontSize", "fontWeight", "letterSpacing", "wordSpacing", "stroke", "backgroundWidth", "backgroundEnabled", "backgroundFitText"].includes(id))
              scheduleCaptionReflow();
          };
          el.onchange = () => {
            syncAndRefresh();
            if (["fontSize", "fontWeight", "letterSpacing", "wordSpacing", "stroke", "backgroundWidth", "backgroundEnabled", "backgroundFitText"].includes(id))
              scheduleCaptionReflow();
          };
        }
      }
      function syncCaptionMotionControls(style = state.captionStyle || {}) {
        const mode = $("captionMotion");
        const range = $("captionScrollRange");
        if (mode) mode.value = style.captionMotion === "vertical-scroll" ? "vertical-scroll" : "none";
        if (range) range.style.display = mode?.value === "vertical-scroll" ? "grid" : "none";
        if ($("captionScrollAbove")) $("captionScrollAbove").value = String(clamp(Number(style.captionScrollAbove ?? 1), 0, 4));
        if ($("captionScrollBelow")) $("captionScrollBelow").value = String(clamp(Number(style.captionScrollBelow ?? 1), 0, 4));
        if ($("scrollHighlightBackground")) $("scrollHighlightBackground").value = style.scrollHighlightBackground || "#111111";
        if ($("scrollHighlightText")) $("scrollHighlightText").value = style.scrollHighlightText || "#ffffff";
      }
      function applyCaptionMotionControls() {
        const style = state.captionStyle || (state.captionStyle = {});
        snapshot();
        const wasScrolling = style.captionMotion === "vertical-scroll";
        style.captionMotion = $("captionMotion")?.value === "vertical-scroll" ? "vertical-scroll" : "none";
        style.captionScrollAbove = clamp(Number($("captionScrollAbove")?.value ?? 1), 0, 4);
        style.captionScrollBelow = clamp(Number($("captionScrollBelow")?.value ?? 1), 0, 4);
        style.scrollHighlightBackground = $("scrollHighlightBackground")?.value || "#111111";
        style.scrollHighlightText = $("scrollHighlightText")?.value || "#ffffff";
        if (style.captionMotion === "vertical-scroll" && !wasScrolling && state.captions?.length) {
          state.captions = state.captions.map((caption) => ({ ...caption, scrollBoundary: true }));
          void applyCaptionGrouping(state.captions, state.captionLines).then((captions) => {
            state.captions = captions;
            renderAll();
            queueAutosave();
          });
        }
        syncCaptionMotionControls(style);
        renderAll();
        queueAutosave();
      }
      ["captionMotion", "captionScrollAbove", "captionScrollBelow", "scrollHighlightBackground", "scrollHighlightText"].forEach((id) => {
        const control = $(id);
        if (!control) return;
        control.onchange = applyCaptionMotionControls;
      });
      syncCaptionMotionControls();
      document.querySelectorAll("[data-text-align]").forEach((button) => {
        button.onclick = () => {
          const style = currentStyle();
          if (!style) return;
          style.textAlign = button.dataset.textAlign;
          renderAll();
        };
      });
      function syncCaptionLineButtons() {
        const mode = normalizeCaptionLineMode(state.captionLines);
        document.querySelectorAll("[data-caption-lines]").forEach((button) =>
          button.classList.toggle("active", normalizeCaptionLineMode(button.dataset.captionLines) === mode),
        );
      }
      let captionReflowTimer = 0;
      function scheduleCaptionReflow() {
        window.clearTimeout(captionReflowTimer);
        captionReflowTimer = window.setTimeout(() => {
          if (!(state.captions || []).length) return;
          void applyCaptionGrouping(state.captions, state.captionLines).then((captions) => {
            state.captions = captions;
            keepCaptionSelection();
            renderAll();
            queueAutosave();
          });
        }, 80);
      }
      function captionLayoutPayload(mode) {
        return {
          captionLines: normalizeCaptionLineMode(mode ?? state.captionLines),
          naturalPunctuation: !!state.naturalCaptionPunctuation || state.captionStyle?.captionMotion === "vertical-scroll",
          boxWidth: state.captionTransform?.width,
          canvasWidth: state.width,
          scale: state.captionTransform?.scale || 1,
          style: state.captionStyle,
        };
      }
      function keepCaptionSelection() {
        if (state.selected?.type !== "caption") return;
        if (!state.captions.length) return;
        if (state.captions.some((item) => item.id === state.selected.id)) return;
        const current = captionAtTime(state.currentTime) || state.captions[0];
        state.selected = { type: "caption", id: current.id };
        state.selectedItems = [{ type: "caption", id: current.id }];
      }
      async function applyCaptionGrouping(captions, mode) {
        if (!(captions || []).length) return captions || [];
        try {
          return await nativeCall("regroupCaptions", {
            captions,
            ...captionLayoutPayload(mode),
          });
        } catch {
          return captions;
        }
      }
      async function setCaptionLineMode(mode) {
        const next = normalizeCaptionLineMode(mode);
        if (next === normalizeCaptionLineMode(state.captionLines) && document.querySelector("[data-caption-lines].active")) {
          syncCaptionLineButtons();
          return;
        }
        snapshot();
        state.captionLines = next;
        if ((state.captions || []).length) {
          state.captions = await applyCaptionGrouping(state.captions, next);
          keepCaptionSelection();
        }
        syncCaptionLineButtons();
        renderAll();
        queueAutosave();
      }
      document.querySelectorAll("[data-caption-lines]").forEach((button) => {
        button.onclick = () => {
          void setCaptionLineMode(button.dataset.captionLines);
        };
      });
      const naturalCaptionPunctuation = $("naturalCaptionPunctuation");
      if (naturalCaptionPunctuation) {
        const syncNaturalCaptionPunctuation = () => {
          if (naturalCaptionPunctuation.checked === !!state.naturalCaptionPunctuation) return;
          snapshot();
          state.naturalCaptionPunctuation = naturalCaptionPunctuation.checked;
          if ((state.captions || []).length) {
            void applyCaptionGrouping(state.captions, state.captionLines).then((captions) => {
              state.captions = captions;
              keepCaptionSelection();
              renderAll();
              queueAutosave();
            });
          }
        };
        naturalCaptionPunctuation.checked = !!state.naturalCaptionPunctuation;
        naturalCaptionPunctuation.onchange = syncNaturalCaptionPunctuation;
      }
      $("fontBoldToggle").onclick = () => {
        const style = currentStyle();
        if (!style) return;
        style.fontWeight = Number(style.fontWeight || 700) >= 700 ? 500 : 800;
        renderAll();
      };
      $("fontItalicToggle").onclick = () => {
        const style = currentStyle();
        if (!style) return;
        style.fontItalic = !style.fontItalic;
        renderAll();
      };
      $("fontUnderlineToggle").onclick = () => {
        const style = currentStyle();
        if (!style) return;
        style.fontUnderline = !style.fontUnderline;
        renderAll();
      };
      document.querySelectorAll("[data-text-case]").forEach((button) => {
        button.onclick = () => {
          const style = currentStyle();
          if (!style) return;
          style.textCase = style.textCase === button.dataset.textCase
            ? "none"
            : button.dataset.textCase;
          renderAll();
        };
      });
      document.querySelectorAll("[data-vertical-align]").forEach((button) => {
        button.onclick = () => {
          const style = currentStyle();
          if (!style) return;
          style.verticalAlign = button.dataset.verticalAlign;
          renderAll();
        };
      });
      document.querySelectorAll("[data-background-mode]").forEach((button) => {
        button.onclick = () => {
          const style = currentStyle();
          if (!style) return;
          style.backgroundMode = button.dataset.backgroundMode;
          style.backgroundEnabled = true;
          renderAll();
        };
      });
      document.querySelectorAll("[data-animation-mode]").forEach((button) => {
        button.onclick = () => {
          animationMode = button.dataset.animationMode;
          renderAnimationPanel();
        };
      });
      $("animationGrid").onclick = (event) => {
        const card = event.target.closest("[data-animation-id]"),
          object = selectedAnimationObject();
        if (!card) return;
        if (!object) {
          toast("请先点击“添加文本”，或选中时间线上的文字/图片");
          return;
        }
        snapshot();
        object[`${animationMode}Animation`] = card.dataset.animationId;
        object[`${animationMode}Duration`] ||= 0.45;
        renderPreviewObjects(false);
        renderAnimationPanel();
        queueAutosave();
        toast(`已套用${animationMode === "enter" ? "入场" : "出场"}动画`);
      };
      $("animationGrid").onpointerover = (event) => {
        const card = event.target.closest("[data-animation-id]");
        if (!card || card.contains(event.relatedTarget)) return;
        card.classList.remove("previewing");
        void card.offsetWidth;
        card.classList.add("previewing");
      };
      $("animationDuration").oninput = (event) => {
        const object = selectedAnimationObject();
        if (!object) return;
        object[`${animationMode}Duration`] = Number(event.target.value) / 100;
        $("animationDurationOut").textContent = `${object[`${animationMode}Duration`].toFixed(2)}秒`;
        renderPreviewObjects(false);
      };
      $("animationDuration").onchange = () => queueAutosave();
      $("inspect-animation").querySelector("[data-animation-clear]").onclick = () => {
        const object = selectedAnimationObject();
        if (!object) return;
        snapshot();
        object[`${animationMode}Animation`] = "";
        renderAll();
      };
      $("objectText").oninput = (e) => {
        const o =
          state.selected.type === "caption"
            ? currentTimelineObject()
            : currentObject();
        if (o && "text" in o) {
          o.text = e.target.value;
          renderPreviewObjects();
          renderTimeline();
        }
      };
      $("presetList").onclick = (e) => {
        const editBtn = e.target.closest("[data-edit-preset]");
        if (editBtn) {
          e.stopPropagation();
          const customIdx = Number(editBtn.dataset.editPreset);
          const target = customPresets[customIdx];
          if (!target) return;
          snapshot();
          state.captionStyle = normalizedCaptionStyle(target.style || {});
          editingCaptionPresetId = target.id;
          $("captionPresetName").value = target.name || "我的字幕样式";
          $("captionPresetModal").classList.add("on");
          renderAll();
          updateInspector();
          $("captionPresetName").focus();
          return;
        }
        const delBtn = e.target.closest("[data-del-preset]");
        if (delBtn) {
          e.stopPropagation();
          const customIdx = Number(delBtn.dataset.delPreset);
          const target = customPresets[customIdx];
          if (target && confirm(`确定要永久删除自定义模板「${target.name}」吗？`)) {
            nativeCall("deleteCaptionPreset", { id: target.id })
              .then(() => {
                customPresets.splice(customIdx, 1);
                try {
                  localStorage.setItem("clipassistant_custom_caption_presets", JSON.stringify(customPresets));
                } catch (err) {}
                renderPresets();
                toast("自定义模板已永久删除");
              })
              .catch((error) => toast(`删除失败：${error.message}`));
          }
          return;
        }
        const b = e.target.closest("[data-preset]");
        if (!b) return;
        const preset = allCaptionPresets()[Number(b.dataset.preset)];
        if (!preset) return;
        snapshot();
        // Each preset is a complete state replacement, never a delta layered on the previous style.
        state.captionStyle = normalizedCaptionStyle(preset.style);
        state.captionStyle.backgroundWidth = Number(preset.style?.backgroundWidth ?? state.captionStyle.padding ?? 14);
        state.captionStyle.backgroundHeight = Number(preset.style?.backgroundHeight ?? state.captionStyle.padding ?? 14);
        state.captionStyle.radius = Number(preset.style?.radius ?? 20);
        if (Number.isFinite(Number(preset.style?.captionYRatio)))
          state.captionTransform.y = Math.round((Number(preset.style.captionYRatio) - 0.5) * Number(state.height || 1920));
        if (preset.style?.captionLines != null)
          state.captionLines = normalizeCaptionLineMode(preset.style.captionLines);
        if (preset.style?.keywordMode === true) {
          const stopWords = new Set("a an and are as at be been but by can could did do does for from had has have he her hers him his how i if in into is it its just me my of on or our ours she so than that the their them then there these they this those to too up us was we were what when where which who will with would you your".split(" "));
          for (const caption of state.captions || []) {
            const tokens = editableCaptionTokens(caption.text);
            if (!tokens.length) continue;
            if (!Array.isArray(caption.words) || caption.words.length !== tokens.length)
              caption.words = timedCaptionWords(caption.text, caption);
            if (caption.words.some((word) => word.emphasis === true)) continue;
            const candidates = caption.words.map((word, index) => ({
              index,
              normalized: String(word.display || "").toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""),
            })).filter((item) => item.normalized.length >= 4 && !stopWords.has(item.normalized));
            const fallback = caption.words.map((word, index) => ({
              index,
              normalized: String(word.display || "").toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""),
            })).filter((item) => item.normalized.length > 0);
            const best = (candidates.length ? candidates : fallback)
              .sort((left, right) => right.normalized.length - left.normalized.length || left.index - right.index)
              .slice(0, caption.words.length >= 10 ? 2 : 1);
            for (const item of best) caption.words[item.index].emphasis = true;
          }
        }
        previewSceneKey = "";
        renderAll();
        updateInspector();
        toast(`已套用「${preset.name}」样式`);
      };
      $("presetList").onpointerover = (event) => {
        const card = event.target.closest("[data-preset]");
        if (!card || card.contains(event.relatedTarget)) return;
        const preview = card.querySelector(".captionobject");
        if (!preview) return;
        if (card.dataset.preset != null && allCaptionPresets()[Number(card.dataset.preset)]?.style?.keywordMode === true) return;
        preview.classList.remove("anim-enter");
        preview.querySelectorAll(".word").forEach((word) =>
          word.classList.remove("past", "active"),
        );
        void preview.offsetWidth;
        preview.classList.add("anim-enter");
        const words = preview.querySelectorAll(".word");
        words[0]?.classList.add("past");
        words[1]?.classList.add("active");
      };
      let editingCaptionPresetId = "";
      $("saveCaptionPreset").onclick = () => {
        editingCaptionPresetId = "";
        $("captionPresetName").value = `我的样式 ${customPresets.length + 1}`;
        $("captionPresetModal").classList.add("on");
        $("captionPresetName").focus();
        $("captionPresetName").select();
      };
      $("captionPresetCancel").onclick = () =>
        $("captionPresetModal").classList.remove("on");
      $("captionPresetConfirm").onclick = async () => {
        const name = $("captionPresetName").value.trim();
        if (!name) return;
        const currentCapStyle = state.captionStyle || currentStyle() || {};
        try {
          const savedPreset = await nativeCall("saveCaptionPreset", {
            id: editingCaptionPresetId,
            name,
            style: JSON.parse(JSON.stringify(currentCapStyle)),
          });
          const existingIndex = customPresets.findIndex((item) => item.id === savedPreset.id);
          if (existingIndex >= 0) customPresets.splice(existingIndex, 1);
          customPresets.unshift({ ...savedPreset, isCustom: true });
          localStorage.setItem("clipassistant_custom_caption_presets", JSON.stringify(customPresets));
          renderPresets();
          $("captionPresetModal").classList.remove("on");
          toast(`自定义模板「${name}」已${editingCaptionPresetId ? "修改" : "保存"}`);
          editingCaptionPresetId = "";
        } catch (error) {
          toast(`保存失败：${error.message}`);
        }
      };
      const registeredFontPaths = new Set();
      let availableLocalFonts = [];
      let localFontCatalogLoaded = false;
      
