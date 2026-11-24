function assignOverlapLanes(items = []) {
        const sorted = items
          .map((item, index) => ({ item, index }))
          .sort((a, b) => Number(a.item.start || 0) - Number(b.item.start || 0));
        const laneEnds = [];
        const lanes = new Map();
        for (const { item, index } of sorted) {
          const start = Number(item.start || 0);
          const end = Math.max(start + 0.01, Number(item.end || start));
          let lane = 0;
          while (lane < laneEnds.length && start < laneEnds[lane] - 0.02) lane += 1;
          if (lane === laneEnds.length) {
            if (laneEnds.length >= 2) {
              lane = laneEnds.length - 1;
              laneEnds[lane] = Math.max(laneEnds[lane], end);
            } else {
              laneEnds.push(end);
            }
          } else laneEnds[lane] = end;
          lanes.set(item.id || `i${index}`, lane);
        }
        return { lanes, laneCount: Math.max(1, laneEnds.length) };
      }
      function clipGeometryStyle(clip, lane = 0, laneCount = 1) {
        const start = Number(clip.start || 0);
        const end = Math.max(start, Number(clip.end || start));
        const layered = laneCount > 1 ? `top:${3 + lane * 27}px;height:24px;` : "";
        return `left:${start * state.zoom}px;width:${Math.max(4, (end - start) * state.zoom)}px;${layered}`;
      }
      function playheadPinX(scroll) {
        const width = Math.max(1, scroll.clientWidth);
        return Math.max(72, Math.min(width * 0.3, width - 72));
      }
      function keepPlayheadInView(mode = "edge") {
        if (state.followPlayhead === false) return;
        const scroll = $("timelineScroll");
        if (!scroll || timelineDrag) return;
        const x = Number(state.currentTime || 0) * Number(state.zoom || 60);
        const viewWidth = Math.max(1, scroll.clientWidth);
        const viewLeft = scroll.scrollLeft;
        const viewRight = viewLeft + viewWidth;
        if (mode === "play") {
          const next = Math.max(0, x - playheadPinX(scroll));
          if (Math.abs(scroll.scrollLeft - next) > 0.4) scroll.scrollLeft = next;
          return;
        }
        if (mode === "center") {
          scroll.scrollLeft = Math.max(0, x - viewWidth / 2);
          return;
        }
        if (x < viewLeft + 8 || x > viewRight - 36)
          scroll.scrollLeft = Math.max(0, x - playheadPinX(scroll));
      }
      function clipDurationMarkup(clip) {
        const duration = Math.max(0, Number(clip?.end || 0) - Number(clip?.start || 0));
        const label = formatTime(duration, false);
        return `<span class="clip-duration" data-clip-duration title="片段时长 ${label}">${label}</span>`;
      }
      function updateTimelineClipDurationLabel(element, clip) {
        const label = element?.querySelector?.("[data-clip-duration]");
        if (!label || !clip) return;
        const duration = Math.max(0, Number(clip.end || 0) - Number(clip.start || 0));
        label.textContent = formatTime(duration, false);
        label.title = `片段时长 ${formatTime(duration, false)}`;
      }
      function syncFollowPlayheadButton() {
        const button = $("followPlayhead");
        if (!button) return;
        button.classList.toggle("primary", state.followPlayhead !== false);
      }
      function audioClipHtml(clip, type, trackId, lane = 0, laneCount = 1) {
        const settings =
            type === "audio" ? mainAudioSettings(clip) : clip,
          volume = settings?.muted ? 0 : clamp(Number(settings?.volume ?? 1), 0, 2),
          previewScale = Math.round(Math.max(0.03, volume / 2) * 100),
          preview = clip.previewUrl
            ? `background-image:url('${escapeHtml(clip.previewUrl)}');background-size:100% ${previewScale}%;background-position:center;`
            : "";
        const waveformCanvas =
          type === "audioasset" && Array.isArray(clip.waveform) && clip.waveform.length
            ? `<canvas class="assetwavecanvas" data-asset-waveform="${escapeHtml(clip.id)}"></canvas>`
            : "";
        const volumeTop = clamp((1 - volume / 2) * 100, 0, 100);
        return `<div class="clip audio ${clip.previewUrl ? "has-wave-preview" : ""} ${isSelected(type, clip.id) ? "selected" : ""}" data-type="${escapeHtml(type)}" data-id="${escapeHtml(clip.id)}" data-track-id="${escapeHtml(trackId)}" style="${clipGeometryStyle(clip, lane, laneCount)}${preview}--wave-scale:${Math.max(0.03, volume / 2)}"><i class="trim-handle start" data-trim="start"></i>${waveformCanvas}<i class="clip-volume-line" data-volume-line style="top:${volumeTop}%" title="拖动调整片段音量"></i><span class="clipname clip-sticky ellipsis">${escapeHtml(clip.name || "音频")}</span>${clipDurationMarkup(clip)}<i class="trim-handle end" data-trim="end"></i></div>`;
      }
      function clipHtml(c, type, lane = 0, laneCount = 1) {
        const visualType = type === "audioasset" ? "audio" : type;
        const pendingAudioCheck = (c.type === "missing" || c.action === "missing") && !c.confirmedMissing && c.needsAudioReview !== false;
        const issueClass = type === "review"
          ? ` ${escapeHtml(c.type || "mismatch")}${pendingAudioCheck ? " audio-unverified" : ""}${c.scripture ? " scripture" : ""}`
          : "";
        const displayText = type === "review"
          ? reviewClipText(c)
          : String(c.text || c.name || type).replace(/^\s*(?:应为|建议删除)[:：]\s*/, "");
        const reviewAction = c.action === "missing"
          ? "missing"
          : ["accept", "insert"].includes(c.action)
            ? "insert"
            : "cut";
        const replace = "";
        const pixelWidth = Math.max(4, (Number(c.end || 0) - Number(c.start || 0)) * state.zoom);
        const narrow = pixelWidth < 72 ? " narrow" : "";
        const captionWords = type === "caption"
          ? (Array.isArray(c.words) && c.words.length
              ? c.words
              : displayText.split(/\s+/).filter(Boolean).map((display) => ({ display })))
              .map((word, wordIndex) => {
                const status = ['repeat','mismatch'].includes(word.issueType) ? 'error' : word.issueType === 'addition' || word.matchType === 'spoken_addition' ? 'addition' : word.matchType === 'near' ? 'near' : 'match';
                const expected = String(word.expectedDisplay || "").trim();
                const issueId = String(word.issueId || ""),
                  action = issueId && word.action === "cut"
                    ? "cut"
                    : issueId && ["replace","review"].includes(word.action)
                      ? "review"
                      : "",
                  actionClass = action ? ` action-${action}` : "",
                  actionAttribute = action
                    ? ` data-script-action="${action}" data-script-issue="${escapeHtml(issueId)}"`
                    : "",
                  tokenTitle = ['repeat','mismatch','addition','extra'].includes(word.issueType)
                    ? reviewClipTitle({type:word.issueType,spokenText:word.originalDisplay || word.display,expectedText:expected})
                    : "";
                return `<span class="caption-token ${status}${actionClass}"${word.meaningReview ? ` data-meaning-word="${wordIndex}"` : ''}${actionAttribute}${tokenTitle ? ` title="${escapeHtml(tokenTitle)}"` : ""}>${escapeHtml(word.display)}</span>`;
              })
              .join("")
          : `<span class="clipname ellipsis"${type === "review" ? reviewAction === "missing" ? ` data-focus-issue="${escapeHtml(c.issueId || c.id)}"` : reviewAction === "insert" ? ` data-insert-review="${escapeHtml(c.id)}" title="点击查看并确认这段文案外口播"` : ` data-cut-review="${escapeHtml(c.id)}"` : ""}>${escapeHtml(displayText)}</span>`;
        const actionClass = type === "review" ? ` ${reviewAction}` : "";
        const reviewHit = type==='caption' ? ' data-caption-details="'+escapeHtml(c.id)+'"' : '';
        const inner = type === "caption" || type === "review"
          ? `<span class="clip-sticky">${captionWords}</span>`
          : `<span class="clip-sticky">${captionWords}</span>`;
        const soloMark = type === "caption" && Array.isArray(c.words) && c.words.some(w => w.userKeptSolo)
          ? `<span class="solo-kept-mark" style="position:absolute;left:0;top:0;bottom:0;width:2px;background:#4ade80;border-radius:1px;z-index:2"></span>`
          : "";
        const durationMark = ["videolayer", "image"].includes(type) ? clipDurationMarkup(c) : "";
        return `<div class="clip ${escapeHtml(visualType)}${issueClass}${actionClass}${narrow} ${isSelected(type, c.id) ? "selected" : ""}" data-type="${escapeHtml(type)}" data-id="${escapeHtml(c.id)}" data-track-id="${escapeHtml(c.trackId || (type === "review" ? "review" : type))}"${reviewHit}${type === "review" ? "" : ` title="${escapeHtml(displayText)}"`} style="${clipGeometryStyle(c, lane, laneCount)}"><i class="trim-handle start" data-trim="start"></i>${soloMark}${inner}${durationMark}${replace}<i class="trim-handle end" data-trim="end"></i></div>`;
      }
      const waveformViewportCache = new WeakMap();
      function waveformViewportCovered(canvas, left, right, height, scrollOnly) {
        const range = waveformViewportCache.get(canvas);
        return scrollOnly && range && range.zoom === state.zoom && range.height === height &&
          range.dpr === (devicePixelRatio || 1) && left >= range.left && right <= range.right;
      }
      function drawWaveform(scrollOnly = false) {
        const scroll = $("timelineScroll"),
          viewLeft = Math.max(0, scroll.scrollLeft - scroll.clientWidth * 0.5),
          viewWidth = Math.max(1, scroll.clientWidth),
          waveform = state.waveform || [],
          sourceDuration = Math.max(0.001, Number(state.sourceDuration || 0));
        for (const canvas of document.querySelectorAll("[data-main-wave-track]")) {
          const trackId = canvas.dataset.mainWaveTrack || "audio";
          const row = canvas.closest(".trackrow");
          if (!row) continue;
          const dpr = devicePixelRatio || 1,
            width = viewWidth * 2,
            height = Math.max(1, row.clientHeight);
          if (waveformViewportCovered(canvas, scroll.scrollLeft, scroll.scrollLeft + viewWidth, height, scrollOnly)) continue;
          waveformViewportCache.set(canvas, { left: viewLeft, right: viewLeft + width, height, zoom: state.zoom, dpr });
          canvas.style.left = `${viewLeft}px`;
          canvas.style.width = `${width}px`;
          canvas.style.right = "auto";
          canvas.width = Math.max(1, Math.round(width * dpr));
          canvas.height = Math.max(1, Math.round(height * dpr));
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, width, height);
          if (!waveform.length || !sourceDuration) continue;
          const clips = mainAudioClips().filter(
            (item) => (state.mainAudioTrackMap?.[item.id] || "audio") === trackId,
          );
          drawWaveformWindow(ctx, {
            width,
            height,
            waveform,
            sourceDuration,
            timelineStart: viewLeft / state.zoom,
            secondsPerPixel: 1 / state.zoom,
            clips,
            volumeForClip: (clip, displayTime) => {
              const settings = mainAudioSettings(clip, false);
              const muted = settings?.muted || state.audioMutes.some(
                (range) => displayTime >= range.start && displayTime <= range.end,
              );
              return muted || !isTrackAudible(trackId)
                ? 0
                : clamp(Number(state.audio.volume ?? 1) * Number(settings?.volume ?? 1), 0, 2.5);
            },
          });
        }
        if (!scrollOnly) drawCompoundWaveforms();
      }
      function drawCompoundWaveforms() {
        const waveform = state.waveform || [];
        const sourceDuration = Math.max(0.001, Number(state.sourceDuration || 0));
        for (const canvas of document.querySelectorAll("[data-compound-waveform]")) {
          const group = (state.compoundClips || []).find((item) => item.id === canvas.dataset.compoundWaveform);
          if (!group) continue;
          const audioIds = new Set((group.members || []).filter((member) => ['audio','audioasset'].includes(member.type)).map((member) => member.id));
          const clips = [...mainAudioClips(),...state.audioAssets].filter((clip) => audioIds.has(clip.id));
          if (!clips.length) continue;
          const width = Math.max(1, canvas.clientWidth);
          const height = Math.max(1, canvas.clientHeight);
          const dpr = devicePixelRatio || 1;
          canvas.width = Math.max(1, Math.round(width * dpr));
          canvas.height = Math.max(1, Math.round(height * dpr));
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, width, height);
          const start = group.start,end=group.end;
          for(const part of clips)drawWaveformWindow(ctx, {
            width, height, waveform:part.waveform?.length?part.waveform:waveform, sourceDuration:part.sourceDuration||sourceDuration, timelineStart: start,
            secondsPerPixel: Math.max(0.00001, (end - start) / width), clips:[part],
            volumeForClip: (clip, displayTime) => {
              const settings = clip.path?clip:mainAudioSettings(clip, false);
              const trackId = clip.trackId||state.mainAudioTrackMap?.[clip.id] || "audio";
              const muted = settings?.muted || state.audioMutes.some((range) => displayTime >= range.start && displayTime <= range.end);
              return muted || !isTrackAudible(trackId) ? 0 : clamp(Number(state.audio.volume ?? 1) * Number(settings?.volume ?? 1), 0, 2.5);
            },
          });
        }
      }
      function waveformPeakRange(waveform, from, to, channelOffset = 0) {
        const start = clamp(Math.floor(from), 0, Math.max(0, waveform.length - 1));
        const end = clamp(Math.max(start + 1, Math.ceil(to)), 1, waveform.length);
        let low = 0, high = 0;
        for (let index = start; index < end; index += 1) {
          const point = waveform[index] || [];
          low = Math.min(low, Number(point[channelOffset] || 0));
          high = Math.max(high, Number(point[channelOffset + 1] || 0));
        }
        return [low, high];
      }
      function drawWaveformWindow(ctx, options) {
        const { width, height, waveform, sourceDuration, timelineStart, secondsPerPixel, clips } = options;
        const stereo = (waveform[0]?.length || 0) >= 4;
        const channels = stereo ? 2 : 1;
        const speed = Math.max(0.05, Number(state.audio.speed || 1));
        const orderedClips = [...clips].sort((a,b) => a.start - b.start);
        ctx.lineWidth = 1;
        ctx.lineCap = "butt";
        ctx.strokeStyle = "#ffffff";
        for (let channel = 0; channel < channels; channel += 1) {
          let clipIndex = 0;
          const bandHeight = height / channels,
            center = bandHeight * channel + bandHeight / 2,
            half = Math.max(2, bandHeight / 2 - 4);
          ctx.globalAlpha = 0.18;
          ctx.beginPath(); ctx.moveTo(0, center + .5); ctx.lineTo(width, center + .5); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          for (let x = .5; x < width; x += 1) {
            const displayTime = timelineStart + x * secondsPerPixel;
            while (clipIndex < orderedClips.length && displayTime >= orderedClips[clipIndex].end) clipIndex++;
            const clip = orderedClips[clipIndex];
            if (!clip || displayTime < clip.start) continue;
            const clipSpeed = Number.isFinite(Number(clip.sourceEnd)) && clip.end > clip.start ? (clip.sourceEnd - clip.sourceStart) / (clip.end - clip.start) : speed;
            const sourceStart = Number(clip.sourceStart || 0) + (displayTime - clip.start) * clipSpeed;
            const sourceEnd = sourceStart + secondsPerPixel * clipSpeed;
            const from = sourceStart / sourceDuration * waveform.length;
            const to = sourceEnd / sourceDuration * waveform.length;
            const detail = typeof detailedWaveformAt === "function" && waveform === state.waveform ? detailedWaveformAt(sourceStart, sourceEnd) : null;
            const [low, high] = detail ? waveformPeakRange(detail.waveform,
              (sourceStart - detail.start) / detail.duration * detail.waveform.length,
              (sourceEnd - detail.start) / detail.duration * detail.waveform.length, channel * 2) : waveformPeakRange(waveform, from, to, channel * 2);
            const gain = Number(options.volumeForClip?.(clip, displayTime) ?? 1);
            const shapedLow = Math.sign(low) * Math.pow(Math.abs(low), .72) * half * gain;
            const shapedHigh = Math.sign(high) * Math.pow(Math.abs(high), .72) * half * gain;
            ctx.moveTo(x, center - shapedHigh);
            ctx.lineTo(x, center - shapedLow);
          }
          ctx.stroke();
        }
      }
      function showTrimAudioDetail() {
        return; // 已按需求取消音频放大遮挡效果
      }
      function hideTrimAudioDetail() {
        $("trimAudioDetail")?.classList.remove("on");
      }
      function drawAssetWaveforms(scrollOnly = false) {
        for (const canvas of document.querySelectorAll("[data-asset-waveform]")) {
          const asset = state.audioAssets.find(
            (item) => item.id === canvas.dataset.assetWaveform,
          );
          if (!asset?.waveform?.length) continue;
          const scroll=$("timelineScroll");
          const zoom=Math.max(.001,Number(state.zoom||60));
          const clipLeft=Number(asset.start||0)*zoom, clipWidth=Math.max(1,(asset.end-asset.start)*zoom);
          const viewportWidth = Number(scroll?.clientWidth || 1200);
          const visibleLeft = Math.max(clipLeft, Number(scroll?.scrollLeft || 0));
          const visibleRight = Math.min(clipLeft + clipWidth, Number(scroll?.scrollLeft || 0) + viewportWidth);
          if (visibleRight <= visibleLeft) continue;
          const localLeft=Math.max(0,Number(scroll?.scrollLeft||0)-clipLeft-viewportWidth * 0.5);
          const width=Math.max(1,Math.min(clipWidth-localLeft,viewportWidth * 2));
          const height=Math.max(1,canvas.parentElement.clientHeight);
          if (waveformViewportCovered(canvas, visibleLeft, visibleRight, height, scrollOnly)) continue;
          waveformViewportCache.set(canvas, { left: clipLeft + localLeft, right: clipLeft + localLeft + width, height, zoom: state.zoom, dpr: devicePixelRatio || 1 });
          canvas.style.left=localLeft+"px";canvas.style.right="auto";canvas.style.width=width+"px";
          const timelineStart=asset.start+localLeft/zoom;
          const dpr = devicePixelRatio || 1;
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
          const ctx = canvas.getContext("2d");
          ctx.scale(dpr, dpr);
          ctx.clearRect(0, 0, width, height);
          const sourceDuration = Math.max(
            0.04,
            Number(asset.sourceDuration || asset.duration || asset.end - asset.start),
          );
          const clipDuration = Math.max(0.04, asset.end - asset.start);
          drawWaveformWindow(ctx, {
            width,
            height,
            waveform: asset.waveform,
            sourceDuration,
            timelineStart,
            secondsPerPixel: 1 / zoom,
            clips: [asset],
            volumeForClip: () => asset.muted || !isTrackAudible(asset.trackId)
              ? 0
              : clamp(Number(asset.volume ?? 1), 0, 2.5),
          });
        }
      }
      
