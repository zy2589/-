function rulerTickPlan(zoom) {
        const z = Number(zoom) || 60;
        if (z < 2) return { major: 300, minor: 60, micro: 12 };
        if (z < 4) return { major: 120, minor: 30, micro: 6 };
        if (z < 8) return { major: 60, minor: 10, micro: 2 };
        if (z < 16) return { major: 30, minor: 5, micro: 1 };
        if (z < 28) return { major: 10, minor: 2, micro: 0.5 };
        if (z < 48) return { major: 5, minor: 1, micro: 0.2 };
        if (z < 80) return { major: 2, minor: 0.5, micro: 0.1 };
        const frame = frameDuration();
        const labelFrames = Math.max(1, Math.ceil(90 / (z * frame)));
        return { major: labelFrames * frame, minor: Math.max(1, Math.round(labelFrames / 5)) * frame, micro: frame };
      }
      function findTimelineGap(items = [], time = 0, minimum = 0.04) {
        const point = Math.max(0, Number(time) || 0);
        const clips = (items || [])
          .map((item) => ({
            ...item,
            start: Math.max(0, Number(item?.start) || 0),
            end: Math.max(0, Number(item?.end) || 0),
          }))
          .filter((item) => item.end > item.start + 0.001)
          .sort((left, right) => left.start - right.start || left.end - right.end);
        if (!clips.length) return null;
        if (clips.some((item) => point >= item.start - 0.002 && point <= item.end + 0.002))
          return null;
        let start = 0,
          end = Infinity;
        for (const item of clips) {
          if (item.end <= point + 0.002) start = Math.max(start, item.end);
          if (item.start >= point - 0.002) end = Math.min(end, item.start);
        }
        if (!Number.isFinite(end) || end - start < Math.max(0.002, Number(minimum) || 0.04))
          return null;
        return { start, end, duration: end - start };
      }
      function timelineGapItems(trackId) {
        if (trackId === "video") return trackItems(trackId);
        if (trackId === "audio")
          return [...mainAudioClips().filter((clip) => !state.mainAudioTrackMap?.[clip.id]), ...state.audioAssets.filter(clip => clip.trackId === trackId)];
        return trackItems(trackId);
      }
      let timelineGapSelection = null;
      function selectedTimelineGapAt(trackId, time) {
        const selected = timelineGapSelection;
        if (!selected || selected.trackId !== trackId) return null;
        if (Number(time) < selected.start - 0.002 || Number(time) > selected.end + 0.002)
          return null;
        const current = findTimelineGap(
          timelineGapItems(trackId),
          (Number(selected.start) + Number(selected.end)) / 2,
        );
        if (!current) return null;
        if (Math.abs(current.start - selected.start) > 0.01 || Math.abs(current.end - selected.end) > 0.01)
          return null;
        return current;
      }
      function rippleDeleteTimelineGap(trackId, gap) {
        console.log("[rippleDeleteGap] trackId=", trackId, "gap=", gap ? `${gap.start.toFixed(3)}-${gap.end.toFixed(3)} dur=${gap.duration.toFixed(3)}` : "null", "locked=", isTrackLocked(trackId));
        if (!gap || gap.duration <= 0.002) return;
        if (isTrackLocked(trackId)) {
          toast("这个轨道已锁定，请先点击轨道前方的锁");
          return;
        }
        const length = Number(gap.duration);
        snapshot();
        applyEditRipple(gap.end,-length,[],[trackId]);
        remapCaptionsFromSource(mainClips());
        recomputeContentDuration();
        timelineGapSelection = null;
        state.selectedItems = [];
        seekTimeline(gap.start);
        renderAll();
        toast(`已波纹删除空白 ${length.toFixed(2)} 秒`);
      }
      let timelineRulerViewport = null;
      let timelineClipViewport = null;
      function viewportCovered(range, scroll, margin = 0) {
        return range && range.zoom === state.zoom && range.width === scroll.clientWidth &&
          scroll.scrollLeft >= range.left + (range.left > 0 ? margin : 0) &&
          scroll.scrollLeft + scroll.clientWidth <= range.right - margin;
      }
      function renderRuler() {
        const visibleDuration = visibleTimelineDuration();
        const width = Math.max(
            $("timelineScroll").clientWidth,
            visibleDuration * state.zoom,
          ),
          ruler = $("ruler");
        if (ruler) {
          delete ruler.dataset.zoomPreviewScale;
          delete ruler.dataset.zoomPreviewBase;
        }
        $("timelineContent").style.width = `${width}px`;
        if (ruler) ruler.style.width = `${width}px`;
        const plan = rulerTickPlan(state.zoom);
        let html = "";
        const rulerStep = Math.max(plan.micro, frameDuration());
        const scroll = $("timelineScroll");
        const fromTick = Math.max(0, Math.floor((scroll.scrollLeft - scroll.clientWidth) / state.zoom / rulerStep));
        const lastTick = Math.min(Math.ceil(visibleDuration / rulerStep), Math.ceil((scroll.scrollLeft + scroll.clientWidth * 2) / state.zoom / rulerStep));
        for (let index = fromTick; index <= lastTick; index++) {
          const t = index * rulerStep;
          const major = Math.abs(t / plan.major - Math.round(t / plan.major)) < 0.001;
          const minor = !major && Math.abs(t / plan.minor - Math.round(t / plan.minor)) < 0.001;
          const label = major
            ? plan.major >= 1
              ? formatTime(t, false)
              : formatTimecode(t).slice(3)
            : "";
          html += `<span class="tick${major ? "" : minor ? " minor" : " micro"}" style="left:${t * state.zoom}px">${label}</span>`;
        }
        for (const issue of (state.issues || []).filter(issue => Number(issue?.start) >= fromTick * rulerStep && Number(issue?.start) <= lastTick * rulerStep)) {
          const issueStart = Number(issue.start);
          if (!Number.isFinite(issueStart) || issueStart < 0) continue;
          html += `<span class="marker ${escapeHtml(issue.type)}" data-issue="${escapeHtml(issue.id)}" title="${escapeHtml(issue.label)}" style="left:${issueStart * state.zoom}px"></span>`;
        }
        for (const marker of state.timelineMarkers || [])
          html += `<span class="marker timeline-marker" data-timeline-marker="${escapeHtml(marker.id)}" title="${escapeHtml(marker.label || '时间线标记')} ${formatTimecode(Number(marker.time || 0))}" style="left:${Number(marker.time) * state.zoom}px"></span>`;
        timelineRulerViewport = { zoom: state.zoom, width: scroll.clientWidth, left: fromTick * rulerStep * state.zoom, right: scroll.scrollLeft + scroll.clientWidth * 2 };
        ruler.innerHTML = html;
        syncTimelineChrome();
      }
      function trackBadgeText(key, meta) {
        if (key === "review") return "待处理";
        if (["video", "audio"].includes(meta?.kind)) {
          const family = state.trackOrder.filter((id) => trackInfo(id).kind === meta.kind);
          const number = Math.max(1, family.length - family.indexOf(key));
          return `${meta.kind === "video" ? "V" : "A"}${number}`;
        }
        if (key === "caption") return "字幕";
        if (meta?.label) return meta.label;
        const isVideoLike = ["video", "image", "text"].includes(meta?.kind || String(key).split("-")[0]);
        if (isVideoLike) {
          const videoTracks = (state.trackOrder || []).filter((id) => id === "video" || ["video", "image", "text"].includes(state.trackDefinitions?.[id]?.kind));
          const idx = videoTracks.indexOf(key);
          return idx >= 0 ? `视频 ${idx + 1}` : "视频";
        }
        if (meta?.kind === "audio" || String(key).startsWith("audio-")) {
          const audioTracks = (state.trackOrder || []).filter((id) => id === "audio" || state.trackDefinitions?.[id]?.kind === "audio");
          const idx = audioTracks.indexOf(key);
          return idx >= 0 ? `音频 ${idx + 1}` : "音频";
        }
        return meta?.label || "轨道";
      }
      function trackClipCountText(key) {
        let count = 0;
        if (key === "review") count = (state.reviewCaptions || []).length;
        else if (key === "caption") count = (state.captions || []).filter((item) => !item.trackId || item.trackId === "caption").length;
        else if (key === "video") count = mainClips().filter(clip => !state.mainVideoTrackMap?.[clip.id]).length + state.videoLayers.filter(clip => clip.trackId === key).length + state.images.filter(clip => clip.trackId === key).length + state.titles.filter(clip => clip.trackId === key).length;
        else if (key === "audio") count = mainAudioClips().filter(clip => !state.mainAudioTrackMap?.[clip.id]).length + state.audioAssets.filter(clip => clip.trackId === key).length;
        else count = (trackItems(key) || []).length;
        return `${count} 个片段`;
      }
      function renderTrackOrder() {
        const labels = $("trackLabels"),
          content = $("timelineContent"),
          tail = content.querySelector("#timelineMarquee");
        let draggingTrackKey = "";
        labels.innerHTML = state.trackOrder
          .map((key) => {
            const meta = trackInfo(key),
              visible = state.trackVisibility[key] !== false,
              locked = isTrackLocked(key),
              soloed = !!state.trackSolo?.[key],
              autoSelected = isTrackAutoSelected(key),
              muted = !!state.trackMute?.[key],
              audioTrack = meta.kind === "audio";
            const symbol = meta.kind === "audio" ? (visible ? "A" : "—") : (visible ? "●" : "○");
            const remove = meta.deletable
              ? `<button class="trackdelete" data-delete-track="${escapeHtml(key)}" title="删除轨道">×</button>`
              : "";
            const badge = trackBadgeText(key, meta);
            const clipCount = trackClipCountText(key);
            const trackName = ["video", "audio"].includes(meta.kind)
              ? `${meta.kind === "video" ? "视频" : "音频"} ${badge.slice(1)}`
              : meta.label;
            const labelTitle = key === "review"
              ? "待处理片段：点击试听，Alt+点击替换为识别口播，Ctrl+点击保留，Shift+点击删除"
              : trackName;
            return `<div class="tracklabel ${escapeHtml(meta.className)}" draggable="true" data-track-key="${escapeHtml(key)}"><div class="track-header-bar"><span class="trackhandle" title="拖动调整轨道顺序">⠿</span><span class="track-badge" title="${escapeHtml(labelTitle)}">${escapeHtml(badge)}</span><div class="track-controls"><button class="tracklock ${locked ? "on" : ""}" data-lock-track="${escapeHtml(key)}" title="${locked ? "解锁轨道" : "锁定轨道"}">${locked ? "■" : "□"}</button><button class="tracksync ${isTrackSyncLocked(key) ? "on" : ""}" data-sync-track="${escapeHtml(key)}" aria-pressed="${isTrackSyncLocked(key)}" title="同步锁：决定其他轨道波纹剪辑时此轨是否同步调整">↔</button><button class="trackauto ${autoSelected ? "on" : ""}" data-auto-track="${escapeHtml(key)}" title="自动轨道选择器：决定选择后方、全选等命令是否作用于此轨">⇥</button>${audioTrack ? `<button class="tracksolo ${soloed ? "on" : ""}" data-solo-track="${escapeHtml(key)}" title="独听此轨">S</button><button class="trackmute ${muted ? "on" : ""}" data-mute-track="${escapeHtml(key)}" title="静音此轨">M</button><span class="audio-channel-tag">2.0</span>` : ""}<button class="visibility ${visible ? "" : "off"}" data-toggle-track="${escapeHtml(key)}" title="${visible ? "关闭轨道" : "显示轨道"}">${symbol}</button>${remove}</div></div><div class="track-info-body"><span class="track-title" title="${escapeHtml(labelTitle)}">${escapeHtml(trackName)}</span><span class="track-clip-count">${clipCount}</span></div><span class="track-resize-grip" data-resize-track="${escapeHtml(key)}" title="按住拖动自由调节轨道高度；双击恢复默认高度"></span></div>`;
          })
          .join("");
        content.querySelectorAll(".trackrow[data-track-key]").forEach((row) => {
          if (!state.trackOrder.includes(row.dataset.trackKey)) row.remove();
        });
        for (const key of state.trackOrder) {
          let row = content.querySelector(
            `.trackrow[data-track-key="${key}"]`,
          );
          if (!row) {
            row = document.createElement("div");
            row.className = "trackrow";
            row.dataset.trackKey = key;
            row.id = `track-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          }
          row.classList.toggle(
            "hidden-track",
            state.trackVisibility[key] === false,
          );
          row.classList.toggle("locked-track", isTrackLocked(key));
          row.classList.toggle("solo-muted", trackInfo(key).kind === "audio" && !isTrackAudible(key));
          const rowHeight = Math.max(68, Number(state.trackHeights?.[key] || 68));
          row.style.height = `${rowHeight}px`;
          if (tail) content.insertBefore(row, tail);
          else content.appendChild(row);
        }
        labels.querySelectorAll("[data-track-key]").forEach((label) => {
          const rowHeight = Math.max(68, Number(state.trackHeights?.[label.dataset.trackKey] || 68));
          label.style.height = `${rowHeight}px`;
          label.ondragstart = (event) => {
            if (!event.target.closest?.(".trackhandle")) {
              event.preventDefault();
              return;
            }
            draggingTrackKey = label.dataset.trackKey;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
              "application/x-clipassistant-track",
              label.dataset.trackKey,
            );
            label.classList.add("trackdrag");
          };
          label.ondragend = () => { label.classList.remove("trackdrag"); draggingTrackKey = ""; };
          label.ondragover = (event) => {
            if (draggingTrackKey && trackInfo(draggingTrackKey).kind !== trackInfo(label.dataset.trackKey).kind) {
              event.dataTransfer.dropEffect = "none";
              return;
            }
            event.preventDefault();
            const after = event.clientY >= label.getBoundingClientRect().top + label.clientHeight / 2;
            label.classList.toggle("drop-before", !after);
            label.classList.toggle("drop-after", after);
          };
          label.ondragleave = () => label.classList.remove("drop-before", "drop-after");
          label.ondrop = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const from = event.dataTransfer.getData(
                "application/x-clipassistant-track",
              ),
              to = label.dataset.trackKey;
            if (!from || from === to) return;
            if (trackInfo(from).kind !== trackInfo(to).kind) {
              toast("视频轨道和音频轨道分组独立排序。");
              return;
            }
            snapshot();
            const after = event.clientY >= label.getBoundingClientRect().top + label.clientHeight / 2;
            state.trackOrder = state.trackOrder.filter((key) => key !== from);
            const targetIndex = state.trackOrder.indexOf(to);
            state.trackOrder.splice(targetIndex + (after ? 1 : 0), 0, from);
            renumberTrackLabels();
            renderAll();
          };
        });
        labels.querySelectorAll("[data-delete-track]").forEach((button) => {
          button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeDynamicTrack(button.dataset.deleteTrack);
          };
        });
        labels.querySelectorAll("[data-lock-track]").forEach((button) => {
          button.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            const key = button.dataset.lockTrack;
            state.trackLocks ||= {};
            state.trackLocks[key] = !state.trackLocks[key];
            renderTrackOrder();
            updateSelectionBox();
            queueAutosave();
          };
        });
      }
      function renderTimeline() {
        if (typeof syncCaptionCorrectionReviews === 'function') syncCaptionCorrectionReviews();
        const viewport = $("timelineScroll");
        const left = Math.max(0, (viewport.scrollLeft - viewport.clientWidth) / state.zoom);
        const right = (viewport.scrollLeft + viewport.clientWidth * 2) / state.zoom;
        timelineClipViewport = { zoom: state.zoom, width: viewport.clientWidth, left: left * state.zoom, right: right * state.zoom };
        const pinned = new Set([...(state.selectedItems || []), state.selected, ...(state.compoundClips || []).flatMap(group => group.members || [])].filter(Boolean).map(item => item.id));
        const visible = clip => pinned.has(clip.id) || (Number(clip.end) >= left && Number(clip.start) <= right);
        renderTrackOrder();
        renderRuler();
        for (const key of state.trackOrder) {
          const row = $("timelineContent").querySelector(
              `.trackrow[data-track-key="${key}"]`,
            ),
            info = trackInfo(key);
          let html = "";
          let laneCount = 1;
          const videoClipMarkup = (clip, trackId) =>
            `<div class="clip video ${isSelected("video", clip.id) ? "selected" : ""}" data-type="video" data-id="${escapeHtml(clip.id)}" data-track-id="${escapeHtml(trackId)}" style="${clipGeometryStyle(clip)}"><i class="trim-handle start" data-trim="start"></i><span class="clip-sticky">${escapeHtml(state.video?.name || "视频")}</span>${clipDurationMarkup(clip)}<i class="trim-handle end" data-trim="end"></i></div>`;
          if (key === "video")
            html = mainClips()
              .filter((clip) => visible(clip) && !state.mainVideoTrackMap?.[clip.id])
              .map((clip) => videoClipMarkup(clip, "video"))
              .join("") + state.videoLayers.filter(clip => visible(clip) && clip.trackId === key).map(clip => clipHtml(clip,"videolayer")).join("") +
              state.images.filter(clip => visible(clip) && clip.trackId === key).map(clip => clipHtml(clip,"image")).join("") +
              state.titles.filter(clip => visible(clip) && clip.trackId === key).map(clip => clipHtml(clip,"text")).join("");
          else if (key === "audio")
            html =
              mainAudioClips()
                .filter((clip) => visible(clip) && !state.mainAudioTrackMap?.[clip.id])
                .map((clip) => audioClipHtml(clip, "audio", "audio"))
                .join("") + state.audioAssets.filter(clip => visible(clip) && clip.trackId === key).map(clip => audioClipHtml(clip,"audioasset",key)).join("") +
              state.audioMutes
                .map(
                  (range) =>
                    `<div class="clip audiomute" title="静音区域" style="${clipGeometryStyle(range)}"></div>`,
                )
                .join("") +
              `<canvas class="wavecanvas" data-main-wave-track="audio" style="position:absolute;inset:0;z-index:25;pointer-events:none"></canvas>`;
          else if (info.kind === "video") {
            const mapped = mainClips()
              .filter((clip) => visible(clip) && state.mainVideoTrackMap?.[clip.id] === key)
              .map((clip) => videoClipMarkup(clip, key))
              .join("");
            html = mapped + state.videoLayers
              .filter((clip) => visible(clip) && clip.trackId === key)
              .map((clip) => clipHtml(clip, "videolayer"))
              .join("") + state.images
              .filter((clip) => visible(clip) && clip.trackId === key)
              .map((clip) => clipHtml(clip, "image"))
              .join("") + state.titles
              .filter((clip) => visible(clip) && clip.trackId === key)
              .map((clip) => clipHtml(clip, "text"))
              .join("");
          } else if (info.kind === "audio") {
            const mapped = mainAudioClips()
              .filter((clip) => visible(clip) && state.mainAudioTrackMap?.[clip.id] === key)
              .map((clip) => audioClipHtml(clip, "audio", key))
              .join("");
            html = mapped + state.audioAssets
              .filter((clip) => visible(clip) && clip.trackId === key)
              .map((clip) => audioClipHtml(clip, "audioasset", key))
              .join("") + `<canvas class="wavecanvas" data-main-wave-track="${escapeHtml(key)}" style="position:absolute;inset:0;z-index:25;pointer-events:none"></canvas>`;
          } else {
            const type = info.kind;
            const items = trackItems(key);
            const stacked = assignOverlapLanes(items);
            laneCount = stacked.laneCount;
            html = items.filter(visible)
              .map((clip) => {
                const lane = stacked.lanes.get(clip.id) || 0;
                return type === "audioasset"
                  ? audioClipHtml(clip, type, key, lane, laneCount)
                  : clipHtml(clip, type, lane, laneCount);
              })
              .join("");
          }
          const configuredHeight = Math.max(68, Number(state.trackHeights?.[key] || 68));
          const laneHeight = `${Math.max(configuredHeight, laneCount > 1 ? 6 + laneCount * 27 : 40)}px`;
          const gapSelection = timelineGapSelection?.trackId === key
            ? `<span class="timeline-gap-selection" data-selected-gap style="left:${timelineGapSelection.start * state.zoom}px;width:${Math.max(2, timelineGapSelection.duration * state.zoom)}px"></span>`
            : "";
          const issueMarkers = info.kind === "caption" ? blockingScriptureOnTimeline()
            .filter(issue => {
              const target = issue.captionTrackId || state.autoTranscript?.trackId || "caption";
              return target === key && Number(issue.start) >= left && Number(issue.start) <= right;
            }).map(issue => {
              const label = `${formatTime(issue.start, false)} · ${issue.label || "经文待核对"} · 识别：${issue.spokenText || "未读出"} · 原文：${issue.expectedText || "待核对"}`;
              return `<button type="button" class="caption-issue-marker" data-caption-issue="${escapeHtml(issue.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" style="left:${Number(issue.start) * state.zoom}px;width:${Math.max(12, (Number(issue.end || issue.start) - Number(issue.start)) * state.zoom)}px">!</button>`;
            }).join("") : "";
          row.innerHTML = `${gapSelection}${html}${issueMarkers}`;
          row.querySelectorAll("[data-caption-issue]").forEach(marker => {
            marker.onpointerdown = event => event.stopPropagation();
            marker.onclick = event => {
              event.preventDefault(); event.stopPropagation();
              focusScriptDifference(marker.dataset.captionIssue);
            };
          });
          row.style.width = $("timelineContent").style.width;
          row.style.height = laneHeight;
          if (laneCount === 1 && configuredHeight > 34)
            row.querySelectorAll(".clip").forEach((clip) => {
              clip.style.height = `${configuredHeight - 7}px`;
              clip.style.top = "3px";
            });
          const label = $("trackLabels").querySelector(`[data-track-key="${key}"]`);
          if (label) label.style.height = laneHeight;
        }
        for (const group of state.compoundClips || []) {
          const liveSpans = (group.members || []).map((member) => compoundSpanFor(member)).filter(Boolean);
          if (liveSpans.length && !group.nestedTimeline) {
            group.start = Math.min(...liveSpans.map((span) => Number(span.start || 0)));
            group.end = Math.max(...liveSpans.map((span) => Number(span.end || span.start || 0)));
          }
          const rowMembers = new Map();
          for (const member of group.members || []) {
            const clip = [...$("timelineContent").querySelectorAll(".clip[data-type][data-id]")]
              .find((element) => element.dataset.type === member.type && element.dataset.id === member.id);
            if (!clip) continue;
            clip.classList.add("compound-member");
            clip.dataset.compoundId = group.id;
            clip.title = `${group.name || "复合片段"} · 内部包含原始切口`;
            const row = clip.closest(".trackrow");
            if (!row) continue;
            clip.style.display = "none";
            if (!rowMembers.has(row)) rowMembers.set(row, { member, clip });
          }
          for (const [row, entry] of rowMembers) {
            const proxy = document.createElement("div");
            const audioProxy = entry.clip.classList.contains("audio");
            proxy.className = `clip compound-proxy${audioProxy ? " audio" : ""}${(group.members || []).some((member) => isSelected(member.type, member.id)) ? " selected" : ""}`;
            // Reuse a real member id/type so all existing selection/move commands expand to the whole compound group.
            proxy.dataset.type = entry.member.type;
            proxy.dataset.id = entry.member.id;
            proxy.dataset.compoundId = group.id;
            proxy.dataset.compoundProxy = "true";
            proxy.title = `${group.name || "复合片段"} · 双击编辑内部时间线；拖动边缘裁切或恢复`;
            proxy.style.left = `${Number(group.start || 0) * state.zoom}px`;
            proxy.style.width = `${Math.max(4, (Number(group.end || group.start || 0) - Number(group.start || 0)) * state.zoom)}px`;
            const configuredHeight = Math.max(68, Number(state.trackHeights?.[entry.clip.dataset.trackId || entry.member.type] || row.clientHeight || 68));
            proxy.style.top = "3px";
            proxy.style.height = `${Math.max(24, configuredHeight - 7)}px`;
            proxy.innerHTML = `${group.nestedTimeline?'<i class="trim-handle start" data-trim="start"></i>':''}${audioProxy ? `<canvas class="compound-wavecanvas" data-compound-waveform="${escapeHtml(group.id)}"></canvas>` : ""}<span class="compound-name">${escapeHtml(group.name || "复合片段")}</span>${group.nestedTimeline?'<i class="trim-handle end" data-trim="end"></i>':''}`;
            row.appendChild(proxy);
          }
        }
        syncTimelineChrome();
        syncTimelineRangeOverlay();
        drawWaveform();
        drawAssetWaveforms();
        $("durationLabel").textContent = formatTime(state.duration, false);
      }
      window.revealTimelineClip = (type, id) => {
        const viewport = $("timelineScroll");
        const clip = $("timelineContent")?.querySelector(
          `.clip[data-type="${CSS.escape(String(type))}"][data-id="${CSS.escape(String(id))}"]`,
        );
        if (!viewport || !clip) return;
        const view = viewport.getBoundingClientRect(), bounds = clip.getBoundingClientRect(), margin = 24;
        if (bounds.left < view.left + margin) viewport.scrollLeft -= view.left + margin - bounds.left;
        else if (bounds.right > view.right - margin) viewport.scrollLeft += bounds.right - (view.right - margin);
        if (bounds.top < view.top + margin) viewport.scrollTop -= view.top + margin - bounds.top;
        else if (bounds.bottom > view.bottom - margin) viewport.scrollTop += bounds.bottom - (view.bottom - margin);
      };
      let timelineRenderFrame = 0,
        waveformRenderFrame = 0,
        previewRenderFrame = 0;
      let timelineViewportFrame = 0;
      function scheduleTimelineViewportRender() {
        if (timelineViewportFrame) return;
        timelineViewportFrame = requestAnimationFrame(() => {
          timelineViewportFrame = 0;
          // Keep pointer capture and the dragged DOM node alive until release.
          if ((typeof timelineDrag !== "undefined" && timelineDrag)) { renderRuler(); return; }
          if (typeof timelineZoomCommitTimer !== "undefined" && timelineZoomCommitTimer) {
            syncTimelineChrome();
            return;
          }
          const scroll = $("timelineScroll");
          if (!viewportCovered(timelineClipViewport, scroll, scroll.clientWidth * 0.25)) {
            renderTimeline();
          } else {
            if (!viewportCovered(timelineRulerViewport, scroll, scroll.clientWidth * 0.25)) renderRuler();
            scheduleWaveformRender(true);
          }
        });
      }
      function scheduleTimelineRender() {
        if (timelineRenderFrame) return;
        timelineRenderFrame = requestAnimationFrame(() => {
          timelineRenderFrame = 0;
          renderTimeline();
        });
      }
      let waveformScrollOnly = true;
      function scheduleWaveformRender(scrollOnly = false) {
        waveformScrollOnly = waveformScrollOnly && scrollOnly;
        if (waveformRenderFrame) return;
        waveformRenderFrame = requestAnimationFrame(() => {
          waveformRenderFrame = 0;
          const scrollOnly = waveformScrollOnly;
          waveformScrollOnly = true;
          drawWaveform(scrollOnly);
          drawAssetWaveforms(scrollOnly);
          if (typeof requestDetailedWaveform === "function") requestDetailedWaveform();
        });
      }
      function schedulePreviewRender(force = false) {
        if (previewRenderFrame) return;
        previewRenderFrame = requestAnimationFrame(() => {
          previewRenderFrame = 0;
          renderPreviewObjects(force);
        });
      }
      const timelineGeometryElements=new Map();
      function updateTimelineClipGeometry(type, id, item) {
        const key=type+':'+id;let element=timelineGeometryElements.get(key);
        if(!element?.isConnected){element=$('timelineContent').querySelector('.clip[data-type="'+CSS.escape(type)+'"][data-id="'+CSS.escape(id)+'"]');if(timelineGeometryElements.size>2048)timelineGeometryElements.clear();if(element)timelineGeometryElements.set(key,element);}
        if (!element || !item) return;
        element.style.left = `${Number(item.start || 0) * state.zoom}px`;
        element.style.width = `${Math.max(3, (Number(item.end || 0) - Number(item.start || 0)) * state.zoom)}px`;
        updateTimelineClipDurationLabel(element, item);
      }
      function updateMainTimelineGeometry() {
        const clips = mainClips();
        for (const clip of clips) {
          updateTimelineClipGeometry("video", clip.id, clip);
        }
        for (const clip of mainAudioClips())
          updateTimelineClipGeometry("audio", clip.id, clip);
      }
      function applyMainTrackOverwrite(movingId, kind = "video", { overwriteOverlays = false } = {}) {
        if (!movingId) return;
        const audioOnly = kind === "audio" && !state.avLinked;
        const all = audioOnly ? mainAudioClips() : mainClips();
        const map = kind === "audio" ? state.mainAudioTrackMap : state.mainVideoTrackMap;
        const trackOf = (clip) =>
          map?.[clip.parentId || clip.id] || kind;
        const moving = all.find((clip) => clip.id === movingId || clip.parentId === movingId);
        if (!moving) return;
        let trackId = trackOf(moving);
        const overlays = kind === "audio"
          ? state.audioAssets
          : [...state.videoLayers, ...state.images, ...state.titles];
        const overlayCollision = overlays.some((item) =>
          overlayTrackId(kind === "audio" ? "audioasset" : "videolayer", item) === trackId &&
          clipsOverlapOnTrack(item, moving),
        );
        if (overlayCollision && overwriteOverlays) {
          const replacement = materializeMainSegment(kind, moving.id);
          const incoming = replacement && timelineObjectFor(replacement.type, replacement.id);
          if (!incoming) return;
          incoming.trackId = trackId;
          const partnerType = replacement.type === "videolayer" ? "audioasset" : "videolayer";
          const partnerList = partnerType === "audioasset" ? state.audioAssets : state.videoLayers;
          const partner = state.avLinked && incoming.linkGroupId
            ? partnerList.find((item) => item.linkGroupId === incoming.linkGroupId)
            : null;
          if (partner) {
            const partnerTrack = pairedTrackForVerticalMove(trackId, kind);
            if (partnerTrack && !isTrackLocked(partnerTrack)) partner.trackId = partnerTrack;
          }
          applyOverlayTrackOverwrite(replacement.type, incoming, { overwriteMain: true });
          if (partner) applyOverlayTrackOverwrite(partnerType, partner, { overwriteMain: true });
          cleanupEmptyDynamicTracks();
          return;
        }
        if (overlayCollision) {
          const destination = resolveTrackForInsert(
            kind,
            moving.start,
            moving.end,
            "",
            moving.name || (kind === "audio" ? "音频轨道" : "视频轨道"),
            [moving.id, moving.parentId].filter(Boolean),
          );
          if (destination && destination !== trackId) {
            map[moving.id] = destination;
            if (moving.parentId) map[moving.parentId] = destination;
            cleanupEmptyDynamicTracks();
            trackId = destination;
            toast(`为避免同轨素材重叠，片段已移到 ${trackBadgeText(destination, trackInfo(destination))}。`);
          }
        }
        const onTrack = all.filter((clip) => trackOf(clip) === trackId);
        if (!onTrack.some((clip) => clip.id !== moving.id && clipsOverlapOnTrack(clip, moving)))
          return;
        const others = all.filter((clip) => trackOf(clip) !== trackId);
        const overwritten = [...overwriteOverlappingClips(onTrack, moving.id), ...others];
        const rebuilt = rebuildTimelineFromPlaced(
          overwritten,
          state.sourceDuration,
          state.audio.speed,
        );
        if (audioOnly) {
          state.mainAudioRemovals = rebuilt.removals;
          state.mainAudioManualCuts = rebuilt.manualCuts;
          state.mainAudioClipOffsets = rebuilt.offsets;
        } else {
          state.removals = rebuilt.removals;
          state.manualCuts = rebuilt.manualCuts;
          state.mainVideoClipOffsets = rebuilt.offsets;
          if (state.avLinked) state.mainAudioClipOffsets = { ...rebuilt.offsets };
          adoptClipMaps(all, rebuilt.packed);
        }
      }
      function applyOverlayTrackOverwrite(type, obj, { overwriteMain = false } = {}) {
        if (!obj || !["videolayer", "audioasset", "image", "text"].includes(type)) return;
        const kind = type === "audioasset" ? "audio" : "video";
        const trackId = overlayTrackId(type, obj);
        let main = kind === "audio" ? mainAudioClips() : mainClips();
        let mainMap = kind === "audio" ? state.mainAudioTrackMap : state.mainVideoTrackMap;
        let collisions = main.filter((item) =>
          (mainMap?.[item.id] || kind) === trackId && clipsOverlapOnTrack(item, obj),
        );
        if (overwriteMain && collisions.length) {
          // Resolve's overwrite edit cuts the target lane, including a packed
          // source clip. Convert only the colliding source segments so the
          // existing independent-clip overwrite logic can preserve both tails.
          for (const clip of collisions) materializeMainSegment(kind, clip.id);
          main = kind === "audio" ? mainAudioClips() : mainClips();
          mainMap = kind === "audio" ? state.mainAudioTrackMap : state.mainVideoTrackMap;
          collisions = main.filter((item) =>
            (mainMap?.[item.id] || kind) === trackId && clipsOverlapOnTrack(item, obj),
          );
        }
        const mainCollision = collisions.length > 0;
        if (mainCollision) {
          const destination = resolveTrackForInsert(
            kind,
            obj.start,
            obj.end,
            "",
            obj.name || obj.text || (kind === "audio" ? "音频轨道" : "视频轨道"),
            [obj.id],
          );
          if (destination && destination !== trackId) {
            obj.trackId = destination;
            cleanupEmptyDynamicTracks();
            toast(`为避免同轨素材重叠，片段已移到 ${trackBadgeText(destination, trackInfo(destination))}。`);
            return;
          }
        }
        const groups = kind === "audio"
          ? [["audioasset", state.audioAssets, "audioAssets"]]
          : [
              ["videolayer", state.videoLayers, "videoLayers"],
              ["image", state.images, "images"],
              ["text", state.titles, "titles"],
            ];
        const originals = new Map(groups.flatMap(([itemType, items]) =>
          items.map((item) => [`${itemType}:${item.id}`, item]),
        ));
        const onTrack = groups.flatMap(([itemType, items]) =>
          items
            .filter((item) => overlayTrackId(itemType, item) === trackId)
            .map((item) => ({ ...item, __overwriteType: itemType })),
        );
        if (!onTrack.some((clip) => clip.id !== obj.id && clipsOverlapOnTrack(clip, obj))) return;
        for (const [itemType, items, stateKey] of groups)
          state[stateKey] = items.filter((item) => overlayTrackId(itemType, item) !== trackId);
        for (const clip of overwriteOverlappingClips(onTrack, obj.id)) {
          const itemType = clip.__overwriteType || type;
          const original = originals.get(`${itemType}:${clip.id}`);
          const next = original || { ...clip };
          const values = { ...clip };
          delete values.__overwriteType;
          if (original) Object.assign(original, values);
          else Object.assign(next, values);
          if (String(next.id).includes("__tail")) next.id = uid();
          const stateKey = groups.find((group) => group[0] === itemType)?.[2];
          if (stateKey) state[stateKey].push(next);
        }
      }
      function updateVolumeGeometry(element, settings) {
        if (!element || !settings) return;
        const volume = settings.muted
          ? 0
          : clamp(Number(settings.volume ?? 1), 0, 2);
        element.style.setProperty("--wave-scale", Math.max(0.03, volume / 2));
        const line = element.querySelector("[data-volume-line]");
        if (line) line.style.top = `${clamp((1 - volume / 2) * 100, 0, 100)}%`;
      }
      function updateTransformInspector(object) {
        if (!object) return;
        $("objectScale").value = Math.round(Number(object.scale || 1) * 100);
        $("scaleOut").textContent = `${$("objectScale").value}%`;
        window.syncPositionControlValue?.("X", object.x);
        window.syncPositionControlValue?.("Y", object.y);
        if ($("objectRotation")) {
          $("objectRotation").value = Math.round(Number(object.rotation || 0));
          $("rotationOut").textContent = `${$("objectRotation").value}°`;
          $("objectOpacity").value = Math.round(Number(object.opacity ?? 1) * 100);
          $("opacityOut").textContent = `${$("objectOpacity").value}%`;
          $("objectBlendMode").value = object.blendMode || "normal";
        }
      }
      window.syncPositionControlValue = (axis, rawValue) => {
        const upper = String(axis || "X").toUpperCase(), key = upper === "Y" ? "y" : "x";
        const value = Number(rawValue || 0), extent = Number(key === "x" ? state.width || 1080 : state.height || 1920);
        const input = $(`object${upper}`), range = $(`object${upper}Range`);
        if (input) input.value = String(Math.round(value));
        if (!range) return;
        const limit = Math.max(extent * 1.5, Math.abs(value));
        range.min = String(-limit);
        range.max = String(limit);
        range.value = String(Math.round(value));
      };
      
