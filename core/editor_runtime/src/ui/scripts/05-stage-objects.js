async function placeLibraryAsset(
        id,
        target = "timeline",
        at = state.currentTime,
        trackId = "",
        spliceRegionId = "",
        editMode = state.timelineEditMode,
      ) {
        let asset = state.libraryAssets.find((item) => item.id === id);
        if (!asset) return;
        if (asset.missing) {
          await relinkLibraryAsset(asset);
          asset = state.libraryAssets.find((item) => item.id === id);
          if (!asset || asset.missing) return;
        }
        if (
          ["video", "audio"].includes(asset.kind) &&
          !asset.analysisJobId &&
          (!Array.isArray(asset.waveform) || !asset.waveform.length)
        ) {
          const refreshed = await nativeCall(
            asset.kind === "video" ? "addVideoPath" : "addAudioPath",
            { projectId: state.projectId, path: asset.path },
          );
          Object.assign(asset, refreshed || {});
          watchMediaAnalysis(asset);
        }
        if (asset.kind === "video")
          return importVideo(
            asset,
            target,
            at,
            trackId,
            spliceRegionId,
            editMode,
          );
        if (asset.kind === "image") return importImage(asset, target, at, trackId, spliceRegionId, editMode);
        if (asset.kind === "audio") return importAudio(asset, target, at, trackId, editMode);
        if (asset.kind === "subtitle")
          return importSubtitle(asset, target, at, trackId, editMode);
      }
      function addText() {
        snapshot();
        const item = {
          id: uid(),
          trackId: resolveTrackForInsert("video", state.currentTime, state.currentTime + 3, "", "标题"),
          text: "输入标题文字",
          start: state.currentTime,
          end: state.currentTime + 3,
          x: 0,
          y: -120,
          width: Math.round(Number(state.width || 1080) * 0.72),
          scale: 1,
          rotation: 0,
          opacity: 1,
          blendMode: "normal",
          enterAnimation: "",
          exitAnimation: "",
          enterDuration: 0.45,
          exitDuration: 0.45,
          style: {
            ...state.captionStyle,
            backgroundEnabled: true,
            backgroundOpacity: 0.55,
            fontSize: 64,
          },
        };
        state.titles.push(item);
        recomputeContentDuration();
        state.selected = { type: "text", id: item.id };
        state.selectedItems = [{ type: "text", id: item.id }];
        renderAll();
      }
      function ensureLibraryAssets() {
        const add = (item, kind) => {
          if (
            item?.path &&
            !(state.hiddenLibraryPaths || []).includes(item.path) &&
            !state.libraryAssets.some((asset) => asset.path === item.path)
          )
            state.libraryAssets.push({ id: uid(), kind, ...item });
        };
        add(state.video, "video");
        state.images.forEach((item) => add(item, "image"));
        state.audioAssets.forEach((item) => add(item, "audio"));
      }
      function mediaPreviewMarkup(asset) {
        const previewUrl =
            asset.previewUrl || (asset.kind === "image" ? asset.url : ""),
          icon =
            asset.kind === "video"
              ? "▶"
              : asset.kind === "audio"
                ? "♪"
                : asset.kind === "image"
                  ? "◆"
                  : "CC";
        return `<div class="thumb media-preview"><span class="thumb-fallback">${icon}</span>${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(asset.name || "素材预览")}" onerror="this.remove()">` : ""}</div>`;
      }
      let libraryMediaRenderKey = "";
      function mediaList() {
        ensureLibraryAssets();
        const renderKey = JSON.stringify(
          state.libraryAssets.map((asset) => [
            asset.id,
            asset.name,
            asset.kind,
            asset.previewUrl,
            asset.duration,
            asset.width,
            asset.height,
            asset.missing,
          ]),
        );
        if (renderKey === libraryMediaRenderKey) return;
        libraryMediaRenderKey = renderKey;
        const label = {
            video: "视频",
            image: "图片",
            audio: "音频",
            subtitle: "字幕",
          },
          list = state.libraryAssets.map((asset) => {
            const preview = mediaPreviewMarkup(asset);
            const detail =
              asset.kind === "video"
                ? `${asset.width || 0}×${asset.height || 0} · ${formatTime(asset.duration, false)}`
                : asset.kind === "audio"
                  ? formatTime(asset.duration, false)
                  : `${label[asset.kind] || "素材"}文件`;
            return `<div class="mediaitem ${asset.missing ? "missing" : ""} ${state.selectedLibraryAssetId === asset.id ? "selected" : ""}" draggable="${asset.missing ? "false" : "true"}" data-library-id="${escapeHtml(asset.id)}" title="${escapeHtml(asset.name)}">${preview}<div><b class="ellipsis">${escapeHtml(asset.name)}</b><div class="small ellipsis ${asset.missing ? "missing-label" : ""}">${asset.missing ? "素材已移动或删除 · 右键重新关联" : escapeHtml(detail)}</div><div class="media-kind">${escapeHtml(label[asset.kind] || asset.kind)}</div></div><button class="media-delete" data-delete-library="${escapeHtml(asset.id)}" title="从素材库移除">×</button></div>`;
          });
        $("mediaList").innerHTML =
          list.join("") ||
          '<div class="small" style="margin-top:10px">还没有素材。可以拖入文件，或使用顶部导入按钮。</div>';
        $("mediaList")
          .querySelectorAll("[data-library-id]")
          .forEach((card) => {
            card.ondragstart = (event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                "application/x-clipassistant-asset",
                card.dataset.libraryId,
              );
              const asset = state.libraryAssets.find((item) => item.id === card.dataset.libraryId);
              if (asset?.kind === "image")
                event.dataTransfer.setData("application/x-clipassistant-image-asset", "image");
            };
            card.onclick = (event) => {
              if (event.target.closest("[data-delete-library]")) return;
              state.selectedLibraryAssetId = card.dataset.libraryId;
              $("mediaList").querySelectorAll("[data-library-id]").forEach((item) =>
                item.classList.toggle("selected", item === card),
              );
            };
            card.oncontextmenu = (event) => {
              const asset = state.libraryAssets.find((item) => item.id === card.dataset.libraryId);
              if (!asset) return;
              showContextMenu(event, [
                asset.missing && { label: "选择对应文件重新关联…", action: () => relinkLibraryAssetDirect(asset) },
                asset.missing && { label: "搜索文件夹关联素材…", action: () => relinkLibraryAsset(asset) },
                !asset.missing && { label: "在资源管理器中显示", action: () => nativeCall("revealFile", asset.path) },
                { label: "从素材库移除", danger: true, action: () => removeLibraryAsset(asset.id) },
              ].filter(Boolean));
            };
          });
        $("mediaList").querySelectorAll("[data-delete-library]").forEach((button) => {
          button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeLibraryAsset(button.dataset.deleteLibrary);
          };
          button.onpointerdown = (event) => event.stopPropagation();
        });
      }
      let previewSceneKey = "";
      function normalizedTransform(value, fallback) {
        return {
          x: Number(value?.x ?? fallback.x) || 0,
          y: Number(value?.y ?? fallback.y) || 0,
          scale: clamp(Number(value?.scale ?? fallback.scale) || 1, 0.05, 8),
          ...(value?.width != null || fallback.width != null
            ? { width: clamp(Number(value?.width ?? fallback.width) || 860, 160, 4000) }
            : {}),
        };
      }
      function ensureIndependentTransforms() {
        if (state.videoTransform === state.captionTransform)
          state.captionTransform = { ...(state.captionTransform || {}) };
        const video = normalizedTransform(state.videoTransform, {
          x: 0,
          y: 0,
          scale: 1,
        });
        const caption = normalizedTransform(state.captionTransform, {
          x: 0,
          y: Math.round(Number(state.height || 1920) * 0.28),
          scale: 1,
          width: Math.round(Number(state.width || 1080) * 0.8),
        });
        Object.assign(state.videoTransform || (state.videoTransform = {}), video);
        Object.assign(
          state.captionTransform || (state.captionTransform = {}),
          caption,
        );
      }
      let layerSeekHold = null;
      window.clearLayerSeekHold = () => { if (layerSeekHold) layerSeekHold.hidden = true; };
      function captureLayerSeekFrame(time) {
        const target = state.videoLayers.find(item => state.trackVisibility[item.trackId] !== false && time >= item.start && time < item.end);
        if (!target) { if (layerSeekHold) layerSeekHold.hidden = true; return; }
        const visible = [...$("visualLayer").querySelectorAll('.layer-video-decoder')].reverse().find(element =>
          element.style.visibility === 'visible' && element.readyState >= 2 && !element.seeking);
        if (!visible) return;
        layerSeekHold ||= document.createElement('canvas');
        layerSeekHold.className = 'visualobject videoobject seek-frame-hold';
        const scale = Math.min(1, 960 / Math.max(visible.videoWidth, visible.videoHeight, 1));
        layerSeekHold.width = Math.max(1, Math.round(visible.videoWidth * scale));
        layerSeekHold.height = Math.max(1, Math.round(visible.videoHeight * scale));
        try { layerSeekHold.getContext('2d').drawImage(visible, 0, 0, layerSeekHold.width, layerSeekHold.height); }
        catch { layerSeekHold.hidden = true; return; }
        layerSeekHold.style.cssText = visible.style.cssText;
        layerSeekHold.style.pointerEvents = 'none';
        layerSeekHold.style.zIndex = String(Number(visible.style.zIndex || 1) + 1);
        layerSeekHold.hidden = false;
        $("visualLayer").appendChild(layerSeekHold);
      }
      function syncLayerVideoVisibility(element, onTimeline) {
        if (element.readyState >= 2 && !element.seeking) {
          element.dataset.decodedFrame = 'true';
        }
        // Seeking temporarily drops readyState; keep the last presented frame.
        element.style.visibility = onTimeline && (element.readyState >= 2 || element.dataset.decodedFrame === 'true') ? "visible" : "hidden";
      }
      function syncLayerVideoElement(element, item) {
        if (!element) return;
        const rate = editRate(item, Number(state.audio.speed || 1));
        const untilStart = item.start-state.currentTime;
        const preroll = Math.min(0.2,Number(item.sourceStart || 0)/rate);
        const warming = state.playing && untilStart>0 && untilStart<=preroll;
        const frozen = typeof window.spliceShouldFreeze === "function" && window.spliceShouldFreeze(item, state.currentTime);
        const linearLocal = Math.max(
          0,
          Number(item.sourceStart || 0) +
            (untilStart>0 ? -Math.min(untilStart,preroll) : state.currentTime-item.start) * rate,
        );
        const local = frozen
          ? Math.max(0, Number(item.spliceFreezeFrame ?? item.sourceStart ?? 0))
          : (typeof window.spliceLayerSourceTime === "function" && state.currentTime >= item.start
            ? window.spliceLayerSourceTime(item, state.currentTime)
            : linearLocal);
        const onTimeline = state.currentTime >= item.start && state.currentTime < item.end;
        const clockMaster = typeof gapPlayback !== "undefined" && !!gapPlayback &&
          state.videoLayers.find(clip => state.trackVisibility?.[clip.trackId] !== false && state.currentTime >= clip.start && state.currentTime < clip.end)?.id === item.id;
        if (element.readyState >= 2 && !element.seeking) element.dataset.decodedFrame = "true";
        syncOneAudio(element, local, true, {
          speed: rate * (warming && local-Number(element.currentTime)>0.015 ? 1.5 : 1), volume: 0, silent: true, preload: frozen || (!onTimeline && !warming) || !state.playing,
          forceSeek: frozen,
          clockMaster: !frozen && clockMaster && !(typeof continuousPreviewIsCurrent === "function" && continuousPreviewIsCurrent()),
          minSource: Number(item.sourceStart || 0),
          mappingKey: `${item.url}|${rate}|${Number(item.sourceStart || 0) - item.start * rate}|${item.splicePlaybackMode || "normal-audio"}|${Number(item.spliceFreezeFrame || 0)}|${Number(item.spliceFreezeUntil || 0)}|${frozen ? "hold" : "move"}`,
        });
        // Readiness can change without a new scene/clip ID. Refresh visibility
        // on the cached-scene path too, including paused seeks into a clip.
        syncLayerVideoVisibility(element, onTimeline);
        if (onTimeline && !element.seeking && element.readyState >= 2 && layerSeekHold) layerSeekHold.hidden = true;
      }
      function updateCaptionWordStates(element) {
        if (!element) return;
        if (element.querySelector("canvas.caption-paint")) {
          paintCaptionPreview(element, captionPaintState.caption || captionAtTime(state.currentTime), {
            relayout: false,
          });
          return;
        }
        for (const word of element.querySelectorAll(".word[data-start]")) {
          const start = Number(word.dataset.start || 0),
            end = Number(word.dataset.end || start);
          word.classList.toggle("past", state.currentTime >= end);
          word.classList.toggle(
            "active",
            state.currentTime >= start && state.currentTime < end,
          );
        }
        if (element.dataset.animation === "line-pulse") {
          const lines = [...element.querySelectorAll(".caption-line")];
          let activeLine = lines.find((line) => line.querySelector(".word.active"));
          if (!activeLine)
            activeLine = lines.find((line) => {
              const words = [...line.querySelectorAll(".word[data-start]")];
              return words.length && state.currentTime <= Number(words.at(-1).dataset.end || 0);
            }) || lines.at(-1);
          lines.forEach((line) => line.classList.toggle("active-line", line === activeLine));
        }
      }
      function reviewTransform(px, py) {
        const gap = Math.max(86, Number(state.captionStyle.fontSize || 54) * 1.55);
        return `translate(calc(-50% + ${state.captionTransform.x * px}px),calc(-50% + ${(state.captionTransform.y - gap) * py}px)) scale(${state.captionTransform.scale || 1})`;
      }
      function mainVideoSuppressedByDuplicateLayer(clip, track = clip ? state.mainVideoTrackMap?.[clip.id] || "video" : "video") {
        if (!clip) return false;
        const sameMedia = (layer) => {
          const mainPaths = [state.video?.path, state.video?.sourcePath].map(value => String(value || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean);
          const layerPaths = [layer.path, layer.sourcePath, layer.mediaPath].map(value => String(value || "").replace(/\\/g, "/").toLowerCase()).filter(Boolean);
          if (mainPaths.some(value => layerPaths.includes(value))) return true;
          const mainIds = [state.video?.sourceMediaId, state.video?.libraryId, state.video?.id, state.video?.url].map(value => String(value || "").toLowerCase()).filter(Boolean);
          const layerIds = [layer.sourceMediaId, layer.libraryId, layer.mediaId, layer.id, layer.url].map(value => String(value || "").toLowerCase()).filter(Boolean);
          return mainIds.some(value => layerIds.includes(value));
        };
        const time = Number(state.currentTime || 0), mainSettings = mainVideoSettings(clip);
        const mainSourceTime = typeof window.spliceShouldFreeze === "function" && window.spliceShouldFreeze(mainSettings, time)
          ? Number(mainSettings?.spliceFreezeFrame ?? clip.sourceStart ?? 0)
          : Number(clip.sourceStart || 0) + Math.max(0, time - Number(clip.start || 0)) * editRate(clip, Number(state.audio.speed || 1));
        const tolerance = Math.max(0.025, 1.25 / Math.max(1, Number(state.video?.frameRate || 30)));
        return (state.videoLayers || []).some(layer => {
          if (state.trackVisibility?.[layer.trackId] === false || !sameMedia(layer) || time < Number(layer.start || 0) || time >= Number(layer.end || 0)) return false;
          if (visualZ(layer.trackId) <= visualZ(track)) return false;
          const layerSourceTime = typeof window.spliceLayerSourceTime === "function"
            ? window.spliceLayerSourceTime(layer, time)
            : Number(layer.sourceStart || 0) + Math.max(0, time - Number(layer.start || 0)) * editRate(layer, Number(state.audio.speed || 1));
          return Math.abs(layerSourceTime - mainSourceTime) <= tolerance;
        });
      }
      function syncMainDecoderAppearance(clip, transform) {
        const active = getActiveVideo();
        const track = clip ? state.mainVideoTrackMap?.[clip.id] || "video" : "video";
        const visible = !!clip && !!(state.video?.url || state.video?.path) && !state.video?.missing && state.trackVisibility[track] !== false && !mainVideoSuppressedByDuplicateLayer(clip, track);
        for (const decoder of [$("video"), $("videoAlt")]) {
          if (!decoder) continue;
          decoder.dataset.previewOpacity = String(transform.opacity ?? 1);
          decoder.style.opacity = decoder === active ? String(transform.opacity ?? 1) : "0";
          decoder.style.visibility = visible ? "visible" : "hidden";
          decoder.style.zIndex = String(visualZ(track));
          decoder.style.mixBlendMode = transform.blendMode || "normal";
        }
      }
      function updatePreviewTransformOnly(updateBox = true) {
        ensureIndependentTransforms();
        const frame = $("frame"),
          fw = frame.clientWidth || 1,
          fh = frame.clientHeight || 1,
          px = fw / state.width,
          py = fh / state.height;
        // The transform overlay belongs to mouse editing, not transport state.
        // Space may start/pause playback but must not hide, recreate or change
        // the selected preview box and its anchors.
        const spliceCanvasEditing = state.spliceLayout !== "free" || (state.spliceRegions || []).some((region) => region.kind === "pip");
        const editableSelection =
          !spliceCanvasEditing && ["video", "image", "text", "caption", "review"].includes(state.selected?.type);
        frame.classList.toggle("editing-overflow", editableSelection);
        $("stage")?.classList.toggle("editing-overflow", editableSelection);
        $("stage")?.closest(".previewarea")?.classList.toggle("editing-overflow", editableSelection);
        const activeMain = activeMainVideoClip(),
          videoTransform = activeMain ? mainVideoSettings(activeMain) : defaultVisualTransform(state.videoTransform);
        const mainSpliceTarget = activeMain ? { type: "main", clip: activeMain, settings: videoTransform, media: state.video } : null;
        const mainSpliceStyle = mainSpliceTarget && typeof window.splicePreviewStyle === "function"
          ? window.splicePreviewStyle(mainSpliceTarget, getActiveVideo()?.videoWidth, getActiveVideo()?.videoHeight)
          : null;
        const mainTransformCss = mainSpliceStyle?.transform || `translate(${videoTransform.x * px}px,${videoTransform.y * py}px) rotate(${videoTransform.rotation || 0}deg) scale(${videoTransform.scale})`;
        $("video").style.transform = mainTransformCss;
        $("videoAlt").style.transform = mainTransformCss;
        if (typeof window.updateSpliceMainFreezePreview === "function") window.updateSpliceMainFreezePreview(mainSpliceTarget, videoTransform);
        syncMainDecoderAppearance(activeMain, videoTransform);
        $("video").style.mixBlendMode = videoTransform.blendMode || "normal";
        const beautyCanvas = $("beautyPreviewCanvas");
        beautyCanvas.style.transform = $("video").style.transform;
        beautyCanvas.style.opacity = String(videoTransform.opacity ?? 1);
        beautyCanvas.style.mixBlendMode = $("video").style.mixBlendMode;
        const beautyFallbackCanvas = $("beautyPreviewFallbackCanvas");
        if (beautyFallbackCanvas) {
          beautyFallbackCanvas.style.transform = beautyCanvas.style.transform;
          beautyFallbackCanvas.style.opacity = beautyCanvas.style.opacity;
          beautyFallbackCanvas.style.mixBlendMode = beautyCanvas.style.mixBlendMode;
          beautyFallbackCanvas.style.clipPath = beautyCanvas.style.clipPath;
        }
        const cropTop = Number(videoTransform.cropTop || 0),
          cropBottom = Number(videoTransform.cropBottom || 0),
          cropLeft = Number(videoTransform.cropLeft || 0),
          cropRight = Number(videoTransform.cropRight || 0);
        const cropMask = mainSpliceStyle?.clipPath || ((cropTop || cropBottom || cropLeft || cropRight)
          ? previewCropMask(videoTransform, getActiveVideo())
          : "none");
        $("video").style.clipPath = cropMask;
        $("videoAlt").style.clipPath = cropMask;
        beautyCanvas.style.clipPath = cropMask;
        const blemishCanvas = $("blemishPreviewCanvas");
        if (blemishCanvas) {
          blemishCanvas.style.transform = mainTransformCss;
          blemishCanvas.style.opacity = String(videoTransform.opacity ?? 1);
          blemishCanvas.style.mixBlendMode = $("video").style.mixBlendMode;
          blemishCanvas.style.clipPath = cropMask;
          blemishCanvas.style.clipPath = cropMask;
        }
        const lutPreview = $("lutPreviewFrame");
        lutPreview.style.transform = mainTransformCss;
        lutPreview.style.clipPath = cropMask;
        lutPreview.style.opacity = String(videoTransform.opacity ?? 1);
        lutPreview.style.mixBlendMode = $("video").style.mixBlendMode;
        $("captionPreview").style.transform = `translate(calc(-50% + ${state.captionTransform.x * px}px),calc(-50% + ${state.captionTransform.y * py}px)) scale(${state.captionTransform.scale || 1})`;
        renderAuxCaptionPreview(captionAtTime(state.currentTime), px, py);
        $("reviewPreview").style.transform = reviewTransform(px, py);
        const object = currentObject();
        if (object && !["video", "caption", "review", "audio"].includes(state.selected.type)) {
          const element = frame.querySelector(
            `[data-type="${state.selected.type}"][data-id="${state.selected.id}"]`,
          );
          if (element && state.selected.type === "videolayer" && typeof window.splicePreviewStyle === "function") {
            const style = window.splicePreviewStyle({ type: "layer", clip: object, settings: object, media: object }, element.videoWidth || object.sourceWidth, element.videoHeight || object.sourceHeight);
            element.style.transform = style.transform;
            element.style.clipPath = style.clipPath;
          } else if (element && state.selected.type === "image" && typeof window.splicePreviewStyle === "function") {
            const style = window.splicePreviewStyle({ type: "layer", clip: object, settings: object, media: object }, object.sourceWidth || element.naturalWidth, object.sourceHeight || element.naturalHeight);
            applyAnimatedObjectStyle(element, object, style.transform);
            element.style.clipPath = style.clipPath;
          } else if (element)
            applyAnimatedObjectStyle(
              element,
              object,
              `translate(calc(-50% + ${Number(object.x || 0) * px}px),calc(-50% + ${Number(object.y || 0) * py}px)) rotate(${Number(object.rotation || 0)}deg) scale(${object.scale || 1})`,
            );
        }
        if (updateBox) updateSelectionBox();
      }
      function animationDefinition(item, type, mode) {
        const id = item?.[`${mode}Animation`] || "";
        const list = type === "text" ? textAnimations : imageAnimations;
        return list.find((entry) => entry.id === id) || null;
      }
      function animationVisualState(item, type) {
        const start = Number(item?.start || 0),
          end = Math.max(start + 0.04, Number(item?.end || start + 0.04)),
          enterDuration = Math.min(
            end - start,
            Math.max(0.15, Number(item?.enterDuration || 0.45)),
          ),
          exitDuration = Math.min(
            end - start,
            Math.max(0.15, Number(item?.exitDuration || 0.45)),
          );
        let definition = null,
          intensity = 0,
          mode = "enter";
        if (state.currentTime < start + enterDuration) {
          definition = animationDefinition(item, type, "enter");
          const progress = clamp((state.currentTime - start) / enterDuration, 0, 1);
          intensity = 1 - (1 - Math.pow(1 - progress, 3));
          intensity = 1 - progress * progress * (3 - 2 * progress);
        } else if (state.currentTime > end - exitDuration) {
          mode = "exit";
          definition = animationDefinition(item, type, "exit");
          const progress = clamp((state.currentTime - (end - exitDuration)) / exitDuration, 0, 1);
          intensity = progress * progress * (3 - 2 * progress);
        }
        if (!definition) return { suffix: "", opacity: Number(item?.opacity ?? 1), filter: "", clipPath: "" };
        const sign = mode === "exit" ? 1 : 1,
          distance = type === "image" ? 210 : 105,
          motion = definition.motion,
          id = definition.id;
        let x = 0,
          y = 0,
          scale = 1,
          rotate = 0,
          clipPath = "",
          filter = "";
        if (motion === "left") x = -distance * intensity * sign;
        if (motion === "right") x = distance * intensity * sign;
        if (motion === "up") y = distance * 0.62 * intensity * sign;
        if (motion === "down") y = -distance * 0.62 * intensity * sign;
        if (motion === "zoom") scale = 1 - 0.45 * intensity;
        if (motion === "zoomout") scale = 1 + 0.5 * intensity;
        if (motion === "rotate") {
          rotate = (id.includes("right") ? 14 : -14) * intensity;
          scale = 1 - 0.14 * intensity;
        }
        if (motion === "flip") {
          scale = Math.max(0.08, 1 - 0.9 * intensity);
          rotate = (id.endsWith("y") ? 8 : -8) * intensity;
        }
        if (motion === "blur") filter = `blur(${(8 * intensity).toFixed(2)}px)`;
        if (/light|flare|halo|sparkle|electric|rays|star|particle|comet|dust/.test(id))
          filter = `brightness(${(1 + .9 * (1 - intensity)).toFixed(2)}) drop-shadow(0 0 ${(4 + 15 * (1 - intensity)).toFixed(1)}px rgba(120,210,255,.9))`;
        if (id.includes("wipe") || id === "typewriter" || id.includes("reveal")) {
          const amount = Math.round(intensity * 100);
          clipPath = id.includes("right")
            ? `inset(0 ${amount}% 0 0)`
            : id.includes("up")
              ? `inset(0 0 ${amount}% 0)`
              : id.includes("down")
                ? `inset(${amount}% 0 0 0)`
                : `inset(0 0 0 ${amount}%)`;
        }
        return {
          suffix: ` translate(${x.toFixed(2)}px,${y.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg) scale(${scale.toFixed(4)})`,
          opacity: Number(item?.opacity ?? 1) * (1 - intensity),
          filter,
          clipPath,
        };
      }
      function applyAnimatedObjectStyle(element, item, baseTransform) {
        const type = state.titles.includes(item) ? "text" : "image",
          visual = animationVisualState(item, type);
        element.style.transform = `${baseTransform}${visual.suffix}`;
        element.style.opacity = visual.opacity;
        element.style.filter = visual.filter;
        const cropTop = Number(item.cropTop || 0),
          cropBottom = Number(item.cropBottom || 0),
          cropLeft = Number(item.cropLeft || 0),
          cropRight = Number(item.cropRight || 0);
        if (cropTop || cropBottom || cropLeft || cropRight) {
          element.style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;
        } else {
          element.style.clipPath = visual.clipPath;
        }
        element.style.mixBlendMode = item.blendMode || "normal";
      }
      function captionAtTime(time = state.currentTime) {
        const t = Number(time || 0);
        const covering = (state.captions || []).filter(
          (item) =>
            state.trackVisibility[item.trackId || "caption"] !== false &&
            t >= Number(item.start) &&
            t < Number(item.end),
        );
        if (!covering.length) return null;
        return covering.sort((left, right) => Number(right.start) - Number(left.start))[0];
      }
      function timelinePreviewSceneAt(time = state.currentTime) {
        const t = Number(time || 0);
        const activeMainClip = mainClips().find((clip) => t >= Number(clip.start || 0) && t < Number(clip.end || 0)) || null;
        const activeMainTrack = activeMainClip ? state.mainVideoTrackMap?.[activeMainClip.id] || "video" : "video";
        const preparedVideoLayers = previewVideoClips(state.videoLayers, t, {
          visible: (track) => state.trackVisibility[track] !== false,
          rate: Number(state.audio.speed || 1),
          lead: 2 * Math.max(1, Number(state.playbackSpeed || 1)),
        }).filter((item) => !item.missing && !!(item.url || item.path));
        const timelineVideoLayers = preparedVideoLayers.filter(
          (item) => t >= Number(item.start || 0) && t < Number(item.end || 0),
        );
        const activeImages = state.images.filter(
          (item) => t >= Number(item.start || 0) && t < Number(item.end || 0) &&
            state.trackVisibility[item.trackId] !== false && !item.missing && !!(item.url || item.path),
        );
        const activeTitles = state.titles.filter(
          (item) => t >= Number(item.start || 0) && t < Number(item.end || 0) &&
            state.trackVisibility[item.trackId] !== false,
        );
        const caption = captionAtTime(t);
        const review = state.reviewCaptions.find(
          (item) => t >= Number(item.start || 0) && t < Number(item.end || 0),
        ) || null;
        return {
          time: t,
          activeMainClip,
          activeMainTrack,
          duplicateMainHidden: activeMainClip && mainVideoSuppressedByDuplicateLayer(activeMainClip, activeMainTrack),
          preparedVideoLayers,
          timelineVideoLayers,
          activeImages,
          activeTitles,
          caption,
          review,
          visibleVideoLayers: timelineVideoLayers.filter((item) => state.trackVisibility[item.trackId] !== false),
        };
      }
      window.timelinePreviewSceneAt = timelinePreviewSceneAt;
      function auxiliaryCaptionOffset(caption) {
        if (!caption) return 0;
        const style = state.captionStyle || {};
        const boxWidth = Number(state.captionTransform.width || state.width * 0.8);
        let mainHeight = Number(style.fontSize || 58) * Number(style.lineHeight || 1.15);
        try {
          mainHeight = Number(layoutCaptionForCanvas(caption, style, boxWidth, 1)?.boxHeight || mainHeight);
        } catch {
          // The estimate is sufficient while fonts are still loading.
        }
        const auxSize = Number(style.fontSize || 58) * Number(state.auxSubtitles?.fontScale || 0.62);
        return mainHeight / 2 + auxSize / 2 + Number(state.auxSubtitles?.gap || 18);
      }
      function renderAuxCaptionPreview(caption, px, py) {
        const preview = $("auxCaptionPreview");
        if (!preview) return;
        const text = String(caption?.auxText || "").trim();
        const visible = !!caption && !!text && state.auxSubtitles?.editorVisible !== false;
        preview.style.display = visible ? "block" : "none";
        if (!visible) {
          preview.textContent = "";
          return;
        }
        const style = state.captionStyle || {};
        const size = Number(style.fontSize || 58) * Number(state.auxSubtitles?.fontScale || 0.62);
        preview.textContent = text;
        preview.style.left = "50%";
        preview.style.top = "50%";
        preview.style.width = `${Number(state.captionTransform.width || state.width * 0.8) * px}px`;
        preview.style.fontFamily = `${style.fontFamily || "Helvetica"}, "PingFang SC", "Microsoft YaHei", sans-serif`;
        preview.style.fontSize = `${size * px}px`;
        preview.style.color = state.auxSubtitles?.color || "#e9edf2";
        preview.style.zIndex = String(Math.max(1, visualZ(caption.trackId || "caption") - 1));
        preview.style.transform = `translate(calc(-50% + ${state.captionTransform.x * px}px),calc(-50% + ${(state.captionTransform.y + auxiliaryCaptionOffset(caption)) * py}px)) scale(${state.captionTransform.scale || 1})`;
      }
      function renderPreviewObjects(force = true) {
        const liveTime = typeof continuousPreviewTime === "function" ? continuousPreviewTime() : null;
        if (liveTime != null) state.currentTime = liveTime;
        ensureIndependentTransforms();
        const layer = $("visualLayer");
        const previewScene = timelinePreviewSceneAt(state.currentTime);
        const {
          activeMainClip,
          activeMainTrack,
          duplicateMainHidden,
          preparedVideoLayers: activeVideoLayers,
          timelineVideoLayers,
          activeImages,
          activeTitles,
          caption,
          review,
        } = previewScene;
        const sceneKey = JSON.stringify({
            main: [activeMainClip?.id || "", state.video?.url || state.video?.path || "", !!state.video?.missing, activeMainTrack, state.trackVisibility[activeMainTrack] !== false],
            // Readiness and `seeking` change while a frame is decoding. They
            // are transport state, not scene structure: including them here
            // recreated every visual object during playback and caused visible
            // stutter. Keep preloaded standby decoders out of the composition
            // key; the cached path still syncs them for frame-accurate entry.
            videos: previewScene.visibleVideoLayers.map((item) => [item.id, item.url || item.path || "", item.trackId]),
            images: activeImages.map((item) => item.id),
            titles: activeTitles.map((item) => item.id),
            caption: caption?.id || "",
            review: review?.id || "",
            selected: selectionKey(state.selected.type, state.selected.id),
          });
        // `activeVideoLayers` also contains silent preloaded standby clips.
        // They must never keep an outgoing frame visible in the gap before
        // their own timeline start.
        if (!timelineVideoLayers.length && layerSeekHold) layerSeekHold.hidden = true;
        if (!force && sceneKey === previewSceneKey) {
          for (const item of activeVideoLayers)
            syncLayerVideoElement(
              layer.querySelector(`.layer-video-decoder[data-id="${item.id}"]`),
              item,
            );
          const cachedMainClip = activeMainVideoClip();
          if (typeof window.updateSpliceMainFreezePreview === "function") window.updateSpliceMainFreezePreview(
            cachedMainClip ? { type: "main", clip: cachedMainClip, settings: mainVideoSettings(cachedMainClip), media: state.video } : null,
            cachedMainClip ? mainVideoSettings(cachedMainClip) : state.videoTransform,
          );
          updateCaptionWordStates($("captionPreview"));
          for (const item of [...activeImages, ...activeTitles]) {
            const element = layer.querySelector(
              `[data-type="${state.titles.includes(item) ? "text" : "image"}"][data-id="${item.id}"]`,
            );
            if (!element) continue;
            if (element.tagName === "IMG" && item.sourceWidth && item.sourceHeight) {
              element.style.width = `${item.sourceWidth * ($("frame").clientWidth / state.width)}px`;
              element.style.height = `${item.sourceHeight * ($("frame").clientHeight / state.height)}px`;
            }
            const spliceStyle = typeof window.splicePreviewStyle === "function"
              ? window.splicePreviewStyle({ type: "layer", clip: item, settings: item, media: item }, item.sourceWidth || element.naturalWidth, item.sourceHeight || element.naturalHeight)
              : null;
            const base = spliceStyle?.transform || `translate(calc(-50% + ${Number(item.x || 0) * ($("frame").clientWidth / state.width)}px),calc(-50% + ${Number(item.y || 0) * ($("frame").clientHeight / state.height)}px)) rotate(${Number(item.rotation || 0)}deg) scale(${item.scale || 1})`;
            applyAnimatedObjectStyle(element, item, base);
            if (spliceStyle?.clipPath) element.style.clipPath = spliceStyle.clipPath;
          }
          updatePreviewTransformOnly(false);
          return;
        }
        const retainedVideos = new Map(
          [...layer.querySelectorAll(".layer-video-decoder[data-id]")].map((element) => [
            element.dataset.id,
            element,
          ]),
        );
        // Preserve attached decoders across manual slice boundaries.
        for (const child of [...layer.children])
          if (!child.classList.contains("layer-video-decoder") && !child.classList.contains("seek-frame-hold")) child.remove();
        const fw = $("frame").clientWidth || 1,
          fh = $("frame").clientHeight || 1,
          px = fw / state.width,
          py = fh / state.height;
        const video = getActiveVideo();
        const hasPreviewVisual =
          (!!activeMainClip && state.trackVisibility[activeMainTrack] !== false && !state.video?.missing && !!(state.video?.url || state.video?.path)) ||
          timelineVideoLayers.some((item) => !item.missing && !!(item.url || item.path)) ||
          activeImages.some((item) => !item.missing && !!(item.url || item.path)) ||
          activeTitles.length > 0 || !!caption || !!review;
        $("stage").classList.toggle("empty", !hasPreviewVisual);
        if (!hasPreviewVisual) {
          if (layerSeekHold) layerSeekHold.hidden = true;
          $("spliceFreezePreviewCanvas").style.visibility = "hidden";
          $("beautyPreviewCanvas").classList.remove("ready");
          $("beautyPreviewFallbackCanvas").classList.remove("ready");
          $("blemishPreviewCanvas").classList.remove("active");
          $("lutPreviewFrame").style.display = "none";
        }
        if (duplicateMainHidden) {
          $("beautyPreviewCanvas").classList.remove("ready");
          $("beautyPreviewFallbackCanvas").classList.remove("ready");
          $("blemishPreviewCanvas").classList.remove("active");
          $("lutPreviewFrame").style.display = "none";
        }
        video.style.visibility =
          activeMainClip && !!(state.video?.url || state.video?.path) && !state.video?.missing && state.trackVisibility[activeMainTrack] !== false && !duplicateMainHidden
            ? "visible"
            : "hidden";
        video.style.zIndex = String(visualZ(activeMainTrack));
        const activeTransform = activeMainClip
          ? mainVideoSettings(activeMainClip)
          : defaultVisualTransform(state.videoTransform);
        const mainSpliceTarget = activeMainClip ? { type: "main", clip: activeMainClip, settings: activeTransform, media: state.video } : null;
        const mainSpliceStyle = mainSpliceTarget && typeof window.splicePreviewStyle === "function"
          ? window.splicePreviewStyle(mainSpliceTarget, video.videoWidth, video.videoHeight)
          : null;
        const activeTransformCss = mainSpliceStyle?.transform || `translate(${activeTransform.x * px}px,${activeTransform.y * py}px) rotate(${activeTransform.rotation || 0}deg) scale(${activeTransform.scale})`;
        video.style.transform = activeTransformCss;
        getStandbyVideo().style.transform = activeTransformCss;
        if (typeof window.updateSpliceMainFreezePreview === "function") window.updateSpliceMainFreezePreview(mainSpliceTarget, activeTransform);
        syncMainDecoderAppearance(activeMainClip, activeTransform);
        video.style.mixBlendMode = activeTransform.blendMode || "normal";
        const mainCropTop = Number(activeTransform.cropTop || 0),
          mainCropBottom = Number(activeTransform.cropBottom || 0),
          mainCropLeft = Number(activeTransform.cropLeft || 0),
          mainCropRight = Number(activeTransform.cropRight || 0);
        video.style.clipPath = mainSpliceStyle?.clipPath || ((mainCropTop || mainCropBottom || mainCropLeft || mainCropRight)
          ? previewCropMask(activeTransform, video)
          : "none");
        const mainCropMask = video.style.clipPath;
        getStandbyVideo().style.clipPath = mainCropMask;
        $("beautyPreviewCanvas").style.clipPath = mainCropMask;
        const lutPreview = $("lutPreviewFrame");
        lutPreview.style.transform = activeTransformCss;
        lutPreview.style.clipPath = mainCropMask;
        lutPreview.style.opacity = video.style.opacity;
        lutPreview.style.mixBlendMode = video.style.mixBlendMode;
        for (const item of activeVideoLayers) {
          const rate = editRate(item, Number(state.audio.speed || 1));
          const decoderKey = JSON.stringify([item.url, item.trackId, rate.toFixed(8),
            (Number(item.sourceStart || 0) - Number(item.start) * rate).toFixed(8)]);
          const el = retainedVideos.get(item.id) || [...retainedVideos.values()].find(
            candidate => candidate.dataset.decoderKey === decoderKey) || document.createElement("video");
          for (const [id, candidate] of retainedVideos) if (candidate === el) retainedVideos.delete(id);
          el.dataset.decoderKey = decoderKey;
          if (el.dataset.sourceUrl !== item.url) { delete el.dataset.decodedFrame; el.dataset.sourceUrl = item.url; el.src = item.url; }
          el.muted = true;
          el.preload = "auto";
          const onTimeline = state.currentTime >= item.start && state.currentTime < item.end;
          syncLayerVideoVisibility(el, onTimeline);
          el.className = `visualobject videoobject layer-video-decoder ${onTimeline ? "layer-video" : "layer-video-standby"} ${isSelected("videolayer", item.id) ? "selected" : ""}`;
          const spliceStyle = typeof window.splicePreviewStyle === "function"
            ? window.splicePreviewStyle({ type: "layer", clip: item, settings: item, media: item }, el.videoWidth || item.sourceWidth, el.videoHeight || item.sourceHeight)
            : null;
          el.style.transform = spliceStyle?.transform || `translate(calc(-50% + ${item.x * px}px),calc(-50% + ${item.y * py}px)) rotate(${Number(item.rotation || 0)}deg) scale(${item.scale || 1})`;
          el.style.opacity = item.opacity ?? 1;
          el.style.mixBlendMode = item.blendMode || "normal";
          const layerCropTop = Number(item.cropTop || 0),
            layerCropBottom = Number(item.cropBottom || 0),
            layerCropLeft = Number(item.cropLeft || 0),
            layerCropRight = Number(item.cropRight || 0);
          el.style.clipPath = spliceStyle?.clipPath || ((layerCropTop || layerCropBottom || layerCropLeft || layerCropRight)
            ? previewCropMask(item, el)
            : "none");
          el.dataset.type = "videolayer";
          el.dataset.previewTrack = item.trackId;
          el.dataset.id = item.id;
          // A paused replacement also needs its source offset restored after
          // metadata arrives; there may be no animation loop to do it later.
          el.onloadedmetadata = el.onloadeddata = el.onseeked = el.oncanplay = () => {
            if (el.isConnected) {
              syncLayerVideoElement(el, item);
              const loadedSpliceStyle = typeof window.splicePreviewStyle === "function"
                ? window.splicePreviewStyle({ type: "layer", clip: item, settings: item, media: item }, el.videoWidth || item.sourceWidth, el.videoHeight || item.sourceHeight)
                : null;
              if (loadedSpliceStyle?.transform) el.style.transform = loadedSpliceStyle.transform;
              const cropTop = Number(item.cropTop || 0),
                cropBottom = Number(item.cropBottom || 0),
                cropLeft = Number(item.cropLeft || 0),
                cropRight = Number(item.cropRight || 0);
              el.style.clipPath = loadedSpliceStyle?.clipPath || ((cropTop || cropBottom || cropLeft || cropRight)
                ? previewCropMask(item, el)
                : "none");
              updateSelectionBox();
              schedulePreviewRender(false);
            }
          };
          el.style.zIndex = String(visualZ(item.trackId));
          syncLayerVideoElement(el, item);
          syncLayerVideoVisibility(el, onTimeline);
          if (el.parentNode !== layer) layer.appendChild(el);
        }
        for (const unused of retainedVideos.values()) {
          const incoming = activeVideoLayers.find(item => item.trackId === unused.dataset.previewTrack && state.currentTime >= item.start && state.currentTime < item.end);
          const replacement = incoming && layer.querySelector(`.layer-video-decoder[data-id="${incoming.id}"]`);
          syncOneAudio(unused, Number(unused.currentTime || 0), false);
          // Hold the last decoded frame only while its replacement is being
          // decoded. Intentional timeline gaps still show the background.
          if (replacement && (replacement.seeking || replacement.readyState < 2)) {
            unused.style.visibility = "visible";
            continue;
          }
          unused.remove();
        }
        for (const image of activeImages) {
          const el = document.createElement("img");
          el.src = image.url;
          el.className = `visualobject imageobject ${isSelected("image", image.id) ? "selected" : ""}`;
          if (image.sourceWidth && image.sourceHeight) {
            el.style.width = `${image.sourceWidth * px}px`;
            el.style.height = `${image.sourceHeight * py}px`;
          } else {
            const onMeasure = () => {
              if (el.naturalWidth && el.naturalHeight) {
                image.sourceWidth = el.naturalWidth;
                image.sourceHeight = el.naturalHeight;
                const fw = $("frame").clientWidth || 1;
                const fh = $("frame").clientHeight || 1;
                const currentPx = fw / Math.max(1, state.width);
                const currentPy = fh / Math.max(1, state.height);
                el.style.width = `${el.naturalWidth * currentPx}px`;
                el.style.height = `${el.naturalHeight * currentPy}px`;
                updateSelectionBox();
              }
            };
            if (el.complete && el.naturalWidth) {
              onMeasure();
            } else {
              el.onload = onMeasure;
            }
          }
          const imageSpliceStyle = typeof window.splicePreviewStyle === "function"
            ? window.splicePreviewStyle({ type: "layer", clip: image, settings: image, media: image }, image.sourceWidth || el.naturalWidth, image.sourceHeight || el.naturalHeight)
            : null;
          applyAnimatedObjectStyle(
            el,
            image,
            imageSpliceStyle?.transform || `translate(calc(-50% + ${image.x * px}px),calc(-50% + ${image.y * py}px)) rotate(${Number(image.rotation || 0)}deg) scale(${image.scale || 1})`,
          );
          if (imageSpliceStyle?.clipPath) el.style.clipPath = imageSpliceStyle.clipPath;
          el.dataset.type = "image";
          el.dataset.id = image.id;
          // Preview composition follows the timeline track order for every
          // image, including captured stills and canvas-dropped overlays.
          el.style.zIndex = String(visualZ(image.trackId));
          layer.appendChild(el);
        }
        for (const title of activeTitles) {
          const el = document.createElement("div");
          const s = title.style || state.captionStyle;
          const titleSpliceStyle = typeof window.splicePreviewStyle === "function"
            ? window.splicePreviewStyle({ type: "layer", clip: title, settings: title, media: title }, 0, 0)
            : null;
          el.className = `visualobject textobject ${isSelected("text", title.id) ? "selected" : ""}`;
          el.innerHTML = `<span class="textstyle-content">${escapeHtml(title.text).replace(/\n/g, "<br>")}</span>`;
          applyAnimatedObjectStyle(
            el,
            title,
            titleSpliceStyle?.transform || `translate(calc(-50% + ${title.x * px}px),calc(-50% + ${title.y * py}px)) rotate(${Number(title.rotation || 0)}deg) scale(${title.scale || 1})`,
          );
          if (titleSpliceStyle?.clipPath) el.style.clipPath = titleSpliceStyle.clipPath;
          applyTextStyle(el, s, px);
          applyTextBoxWidth(el, title.width, px);
          el.dataset.type = "text";
          el.dataset.id = title.id;
          el.style.zIndex = String(visualZ(title.trackId));
          layer.appendChild(el);
        }
        const preview = $("captionPreview");
        renderCaptionWords(preview, caption);
        preview.style.display =
          caption ? "block" : "none";
        preview.style.left = "50%";
        preview.style.top = "50%";
        preview.style.zIndex = String(visualZ(caption?.trackId || "caption"));
        preview.dataset.id = caption?.id || "track";
        preview.dataset.animation = state.captionStyle.animation || "fade";
        if (caption && preview.dataset.captionKey !== caption.id) {
          preview.dataset.captionKey = caption.id;
          preview.classList.remove("anim-enter");
          void preview.offsetWidth;
          preview.classList.add("anim-enter");
        }
        preview.style.setProperty(
          "--active",
          state.captionStyle.highlight || "#ffd21f",
        );
        preview.classList.toggle("no-highlight", state.captionStyle.highlightEnabled === false);
        const captionTransform = `translate(calc(-50% + ${state.captionTransform.x * px}px),calc(-50% + ${state.captionTransform.y * py}px)) scale(${state.captionTransform.scale || 1})`;
        preview.style.transform = captionTransform;
        preview.style.setProperty("--caption-transform", captionTransform);
        applyCaptionCanvasHost(preview, px);
        renderAuxCaptionPreview(caption, px, py);
        const reviewPreview = $("reviewPreview");
        reviewPreview.textContent = String(
          review?.expectedText && !/^\s*[—-]\s*$/.test(review.expectedText)
            ? review.expectedText
            : review?.text || "",
        ).replace(/^\s*(?:应为|建议删除)[:：]\s*/, "");
        reviewPreview.className = `visualobject reviewobject ${review?.type || ""}`;
        reviewPreview.dataset.id = review?.id || "";
        // 待处理标记只是剪辑控件，不是要导出的画面文字。
        reviewPreview.style.display = "none";
        reviewPreview.style.zIndex = String(visualZ("review"));
        reviewPreview.style.transform = reviewTransform(px, py);
        previewSceneKey = sceneKey;
        updateSelectionBox();
      }
      let captionPaintState = { key: "", layout: null, style: null, pad: 0, caption: null };
      
