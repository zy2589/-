      let activeVideo = null;
      let standbyVideo = null;
      let playbackAnimationFrame = 0;
      let gapPlayback = null;
      let sourceSeekGeneration = 0;
      let playRequestGeneration = 0;
      let pendingPlayRequest = 0;
      let primaryFrameLoad = null;
      let cutPrefetch = null;
      // Preview reads source media directly. Export alone renders the full
      // timeline; pressing play never waits for a full-length audio render.
      function continuousPreviewIsCurrent() { return false; }
      function continuousPreviewTime() { return null; }
      function previewFrameDuration() {
        return frameDuration();
      }
      function previewAtTimelineEnd(time = state.currentTime) {
        const tolerance = Math.max(0.01, previewFrameDuration() * 0.5);
        return Number(time) >= Number(state.duration || 0) - tolerance;
      }
      function resetCutPrefetch() {
        if (cutPrefetch?.timer) clearTimeout(cutPrefetch.timer);
        cutPrefetch = null;
      }
      function expireCutPrefetch(pending) {
        if (!pending || cutPrefetch !== pending) return;
        const active = getActiveVideo();
        pending.video?.pause();
        if (pending.video) {
          pending.video.muted = true;
          pending.video.volume = 0;
          pending.video.style.opacity = "0";
        }
        resetCutPrefetch();
        if (state.playing && !gapPlayback && active?.paused)
          active.play().catch(() => {});
        syncPreviewAudio();
      }
      function syncPreviewLayerAfterSwap(video) {
        const beauty = $("beautyPreviewCanvas");
        if (beauty) beauty.classList.remove("ready");
        // A cached LUT still represents the old decoder frame. Hide it until
        // the normal preview refresh produces the new frame.
        const lut = $("lutPreviewFrame");
        if (lut) lut.style.display = "none";
        renderPreviewObjects(false);
        updateBeautyPreviewState();
        if (beautyIsActive() && !beautyFrameRequest)
          beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
      }
      function commitCutPrefetch(video) {
        const pending = cutPrefetch;
        if (!pending || pending.video !== video || video.seeking || video.readyState < 2) return false;
        // Decoder readiness only primes the buffer. Never skip the tail of
        // the outgoing clip while the next frame is being prepared.
        if (!pending.reached || !state.playing || gapPlayback) return false;
        if (Math.abs(Number(video.currentTime || 0) - pending.target) > 0.03) return false;
        if (pending.url !== state.video?.url) { resetCutPrefetch(); return false; }
        const old = getActiveVideo();
        old.pause();
        old.muted = true;
        old.volume = 0;
        old.style.opacity = "0";
        video.style.opacity = String(old.dataset.previewOpacity || "1");
        activeVideo = video;
        standbyVideo = old;
        resetCutPrefetch();
        state.currentTime = mapSourceTime(Number(video.currentTime || pending.target));
        applyMediaPlaybackRate(video);
        syncPreviewLayerAfterSwap(video);
        syncPreviewAudio();
        if (state.playing && !gapPlayback) video.play().catch((error) => {
          if (video !== getActiveVideo() || !state.playing) return;
          state.playing = false;
          gapPlayback = null;
          $("play").textContent = "▶";
          toast(`切口画面无法继续播放：${error?.message || "解码器启动失败"}`);
        });
        return true;
      }
      function prepareCutPrefetch(target, boundary = null) {
        const active = getActiveVideo(), standby = getStandbyVideo();
        const url = state.video?.url;
        if (!active || !standby || !url || standby === active) return;
        target = Math.max(0, Number(target || 0));
        if (cutPrefetch && cutPrefetch.video === standby && Math.abs(cutPrefetch.target - target) < 0.01) return;
        resetCutPrefetch();
        const pending = { video: standby, target, boundary, reached: false, url, timer: 0 };
        cutPrefetch = pending;
        pending.timer = setTimeout(() => expireCutPrefetch(pending), 1200);
        standby.pause();
        standby.muted = true; standby.volume = 0;
        standby.style.pointerEvents = "none";
        standby.style.opacity = "0";
        if (standby.dataset.sourceUrl !== url) {
          standby.dataset.sourceUrl = url; standby.src = url; standby.load();
          return;
        }
        if (standby.readyState > 0 && Math.abs(Number(standby.currentTime || 0) - target) > 0.008)
          standby.currentTime = target;
        else commitCutPrefetch(standby);
      }
      function maybePrefetchUpcomingCut(source) {
        if (!state.playing || cutPrefetch) return;
        // Allow local decoders time to seek back to a keyframe and decode,
        // including at accelerated playback speeds.
        const lead = Math.max(0.5, effectivePlaybackRate() * 0.75);
        const next = (state.removals || []).find((range) =>
          Number(range.start) >= source && Number(range.start) - source <= lead && Number(range.end) > Number(range.start));
        if (next) prepareCutPrefetch(skipDeadSource(Number(next.end)), Number(next.start));
      }

      function pauseForSourceReplacement(oldUrl) {

        playRequestGeneration += 1;
        pendingPlayRequest = 0;
        if (primaryFrameLoad?.url === oldUrl) finishPrimaryFrameLoad(false);
        state.playing = false;
        gapPlayback = null;
        sourceSeekGeneration += 1;
        resetCutPrefetch();
        previewAudioSyncGeneration += 1;
        cancelAnimationFrame(playbackAnimationFrame);
        playbackAnimationFrame = 0;
        cancelAnimationFrame(beautyFrameRequest);
        beautyFrameRequest = 0;
        $("beautyPreviewCanvas")?.classList.remove("ready");
        stopComparisonPreview();
        if (typeof shuttleTimer !== "undefined" && shuttleTimer) {
          clearInterval(shuttleTimer);
          shuttleTimer = null;
        }
        if (typeof shuttleSpeed !== "undefined") shuttleSpeed = 0;
        const players = new Set([
          $("video"), $("videoAlt"), ...previewAudioPlayers.values(),
          ...document.querySelectorAll(".layer-video"),
        ]);
        for (const player of players) {
          if (!player) continue;
          player.pause();
          if (oldUrl && (player.getAttribute("src") === oldUrl || player.dataset.sourceUrl === oldUrl)) {
            player.removeAttribute("src");
            player.dataset.sourceUrl = "";
            player.load?.();
          }
        }
      }

      function releaseEditorRuntime() {
        playRequestGeneration += 1;
        pendingPlayRequest = 0;
        sourceSeekGeneration += 1;
        previewAudioSyncGeneration += 1;
        state.playing = false;
        gapPlayback = null;
        resetCutPrefetch();
        finishPrimaryFrameLoad(false);
        if (playbackAnimationFrame) cancelAnimationFrame(playbackAnimationFrame);
        playbackAnimationFrame = 0;
        if (selectionFollowFrame) cancelAnimationFrame(selectionFollowFrame);
        selectionFollowFrame = 0;
        if (typeof timelineRenderFrame !== "undefined" && timelineRenderFrame) {
          cancelAnimationFrame(timelineRenderFrame);
          timelineRenderFrame = 0;
        }
        if (typeof timelineViewportFrame !== "undefined" && timelineViewportFrame) {
          cancelAnimationFrame(timelineViewportFrame);
          timelineViewportFrame = 0;
        }
        if (typeof waveformRenderFrame !== "undefined" && waveformRenderFrame) {
          cancelAnimationFrame(waveformRenderFrame);
          waveformRenderFrame = 0;
        }
        if (typeof previewRenderFrame !== "undefined" && previewRenderFrame) {
          cancelAnimationFrame(previewRenderFrame);
          previewRenderFrame = 0;
        }
        if (typeof beautyFrameRequest !== "undefined" && beautyFrameRequest) {
          cancelAnimationFrame(beautyFrameRequest);
          beautyFrameRequest = 0;
        }
        $("beautyPreviewCanvas")?.classList.remove("ready");
        if (typeof shuttleTimer !== "undefined" && shuttleTimer) {
          clearInterval(shuttleTimer);
          shuttleTimer = null;
        }
        if (typeof shuttleSpeed !== "undefined") shuttleSpeed = 0;
        stopComparisonPreview();
        const players = new Set([
          $("video"),
          $("videoAlt"),
          ...previewAudioPlayers.values(),
          ...document.querySelectorAll(".layer-video-decoder"),
        ]);
        for (const player of players) {
          if (!player) continue;
          try { syncOneAudio.states?.get(player)?.stop?.(); } catch {}
          player.pause?.();
          player.removeAttribute?.("src");
          if (player.dataset) {
            player.dataset.sourceUrl = "";
            player.dataset.decoderKey = "";
            player.dataset.decodedFrame = "";
          }
          player.load?.();
          if (player.classList?.contains("layer-video-decoder")) player.remove();
        }
        for (const player of previewAudioPlayers.values()) {
          player.pause();
          player.removeAttribute("src");
          player.load?.();
        }
        previewAudioPlayers.clear();
        activeVideo = $("video");
        standbyVideo = $("videoAlt");
      }

      function finishPrimaryFrameLoad(ready) {
        const pending = primaryFrameLoad;
        if (!pending) return;
        primaryFrameLoad = null;
        clearTimeout(pending.timer);
        pending.resolve(ready);
      }
      function beginPrimaryFrameLoad(video, url) {
        finishPrimaryFrameLoad(false);
        const pending = { video, url, projectId: state.projectId };
        pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
        primaryFrameLoad = pending;
        pending.timer = setTimeout(() => {
          if (primaryFrameLoad !== pending) return;
          finishPrimaryFrameLoad(false);
          toast("素材预览加载超时，请检查文件是否可读取，或重新关联素材。");
        }, 15000);
      }
      function restorePrimaryFrame(video) {
        const pending = primaryFrameLoad;
          if (!pending || pending.video !== video || pending.url !== state.video?.url ||
            pending.projectId !== state.projectId || video.readyState < 1) return;
        // Honor seeks made while loading, even when old/new durations match.
        const sourceFrame = 1 / Math.max(1, Number(state.video?.frameRate) || 30);
        const target = clamp(timelineToSource(state.currentTime), 0,
          Math.max(0, Number(video.duration || 0) - sourceFrame / 4));
        if (Math.abs(video.currentTime - target) > sourceFrame / 4) {
          video.currentTime = target;
          return;
        }
        if (video.seeking || video.readyState < 2) return;
        finishPrimaryFrameLoad(true);
        renderPreviewObjects();
        updateBeautyPreviewState();
      }

      function getActiveVideo() {
        if (!activeVideo) activeVideo = $("video");
        return activeVideo || $("video");
      }
      function getStandbyVideo() {
        if (!standbyVideo) standbyVideo = $("videoAlt");
        return standbyVideo || $("videoAlt");
      }
      function syncDualVideoSources(url) {
        const v1 = $("video");
        const v2 = $("videoAlt");
        if (!v1) return;
        const preserveDecoderRoles = !!(
          url && activeVideo && standbyVideo && activeVideo !== standbyVideo &&
          activeVideo.dataset.sourceUrl === url
        );
        if (!preserveDecoderRoles) {
          activeVideo = v1;
          standbyVideo = v2;
          if (v2) {
            v2.pause();
            v2.muted = true;
            v2.volume = 0;
            v2.style.opacity = "0";
            v2.style.pointerEvents = "none";
          }
        }
        if (url) {
          if (v1.dataset.sourceUrl !== url) {
            playRequestGeneration += 1;
            sourceSeekGeneration += 1;
            beginPrimaryFrameLoad(v1, url);
            v1.dataset.sourceUrl = url;
            v1.src = url;
            v1.load();
          }
          // The second decoder is a cut-only standby buffer. It never plays in
          // lockstep with the primary decoder; it is loaded/seeked only shortly
          // before a discontinuous source jump and becomes visible only after
          // its target frame is decoded. This avoids both black flashes and the
          // old dual-playing decoder freeze.
          if (v2) {
            v1.dataset.previewOpacity = v1.dataset.previewOpacity || (v1.style.opacity || "1");
            v2.dataset.previewOpacity = v1.dataset.previewOpacity;
            if (v2.dataset.sourceUrl !== url) {
              v2.dataset.sourceUrl = url;
              v2.src = url;
              v2.load();
            }
          }
          $("stage")?.classList.remove("empty");
        } else {
          playRequestGeneration += 1;
          finishPrimaryFrameLoad(false);
          v1.pause(); v1.removeAttribute("src"); v1.dataset.sourceUrl = ""; v1.load?.();
          if (v2) { v2.pause(); v2.removeAttribute("src"); v2.dataset.sourceUrl = ""; v2.load?.(); }
        }
      }

      function renderAll() {

        applyLayout();
        if (typeof window.syncSplicePanel === "function") window.syncSplicePanel();
        syncCaptionLineButtons();
        syncAuxSubtitleControls();
        normalizeSelection();
        ensureIndependentTransforms();
        syncDualVideoSources(state.video?.url || "");
        mediaList();
        renderPreviewObjects();
        renderTimeline();
        renderIssues();
        renderCaptionInspector();
        if (typeof renderAutoTranscript === "function") renderAutoTranscript();
        updateInspector();
        if (typeof window.syncSelectedClipColor === "function") window.syncSelectedClipColor();
        applyVideoCss();
        syncAudioControls();
        syncPreviewAudio();
        $("linkAV").classList.toggle("primary", state.avLinked);
        $("snapToggle").classList.toggle("primary", state.snapping);
        if ($("selectionFollowsPlayhead")) $("selectionFollowsPlayhead").classList.toggle("active", state.selectionFollowsPlayhead);
        $("timecode").textContent =
          `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
        $("play").textContent = state.playing ? "❚❚" : "▶";
        syncFollowPlayheadButton();
        queueAutosave();
      }

      function seekTimeline(time) {
        if (!state.playing) {
          getActiveVideo()?.pause();
          getStandbyVideo()?.pause();
          document.querySelectorAll('.layer-video-decoder').forEach(video => video.pause());
        }
        resetCutPrefetch();
        if (typeof captureLayerSeekFrame === "function") captureLayerSeekFrame(time);
        state.currentTime = frameBoundedTime(time, 0, visibleTimelineDuration());
        gapPlayback = null;
        // A seek replaces the running clock, including a clock for blank space.
        if (state.playing) {
          const clips = mainClips();
          if (!clips.some(clip => state.currentTime >= clip.start && state.currentTime < clip.end)) {
            const next = clips.find(clip => clip.start > state.currentTime);
            gapPlayback = { startTimeline: state.currentTime, startWall: performance.now(), gapEnd: next?.start ?? state.duration };
            getActiveVideo()?.pause();
          }
        }
        for (const player of [...previewAudioPlayers.values(), ...document.querySelectorAll('.layer-video-decoder')]) {
          const control = syncOneAudio.states?.get(player);
          if (control) { control.stop(); control.needsPosition = true; }
        }
        const primary = getActiveVideo();
        if (state.video && primary) {
          const boundary = timelineToSource(state.currentTime);
          const source = !state.playing ? previewSourceSeekTime(boundary, primary.duration) : boundary;
          if (primary.readyState > 0 && Math.abs(primary.currentTime - source) > 0.000001) {
            if (!state.playing) {
              state.previewSeekTarget = source;
              if ($("frameSeekStatus")) $("frameSeekStatus").textContent = "定位中…";
            }
            primary.currentTime = source;
          }
          restorePrimaryFrame(primary);
          if (state.playing && !gapPlayback && primary.paused && !primary.seeking && primary.readyState >= 2)
            primary.play().catch(() => {});
        }
        renderPreviewObjects(false);
        syncPreviewAudio();
        syncTimelineChrome();
        $("timecode").textContent =
          `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
        keepPlayheadInView(state.playing ? "play" : "edge");
        if (state.selectionFollowsPlayhead && !state.playing) scheduleSelectionFollowsPlayhead();
      }

      let selectionFollowFrame = 0;
      function scheduleSelectionFollowsPlayhead() {
        if (selectionFollowFrame) return;
        selectionFollowFrame = requestAnimationFrame(() => {
          selectionFollowFrame = 0;
          if (!state.selectionFollowsPlayhead || state.playing) return;
          const candidates = clipsUnderPlayhead(state.currentTime).filter((item) => {
            const trackId = selectionTrackId(item.type, item.id);
            return isTrackAutoSelected(trackId) && state.trackVisibility?.[trackId] !== false;
          }).sort((a, b) => state.trackOrder.indexOf(selectionTrackId(a.type, a.id)) - state.trackOrder.indexOf(selectionTrackId(b.type, b.id)));
          if (!candidates.length) return;
          const next = expandLinkedSelection([candidates[0]]).filter((item) => isTrackAutoSelected(selectionTrackId(item.type, item.id)));
          const before = (state.selectedItems || []).map((item) => `${item.type}:${item.id}`).sort().join("|");
          const after = next.map((item) => `${item.type}:${item.id}`).sort().join("|");
          if (before === after) return;
          state.selectedItems = next; state.selected = next[0] || state.selected;
          renderTimeline(); renderPreviewObjects(); updateInspector();
        });
      }

      function jumpPlaybackSource(fromSource) {
        const video = getActiveVideo();
        const target = skipDeadSource(fromSource);
        if (target <= fromSource + 0.012) return fromSource;
        if (cutPrefetch && Math.abs(cutPrefetch.target - target) < 0.03) {
          cutPrefetch.reached = true;
          if (commitCutPrefetch(cutPrefetch.video)) return target;
          // Hold the old decoded frame instead of seeking the visible decoder.
          // Playback resumes as soon as the standby frame fires seeked/canplay.
          video.pause();
          for (const player of previewAudioPlayers.values()) player.pause();
          return fromSource;
        }
        if (video.seeking) return target;
        const token = ++sourceSeekGeneration;
        const resume = () => {
          if (token !== sourceSeekGeneration) return;
          if (gapPlayback) return;
          if (state.playing && video.paused) video.play().catch(() => {});
        };
        video.addEventListener("seeked", resume, { once: true });
        video.currentTime = target;
        return target;
      }

      function startPlaybackAnimationLoop() {
        if (playbackAnimationFrame) return;
        const tick = () => {
          if (!state.playing) {
            playbackAnimationFrame = 0;
            gapPlayback = null;
            return;
          }
          // ── 间隙播放：video 已暂停，用墙钟推进时间线 ──
          if (gapPlayback) {
            const speed = Math.max(0.05, Number(state.playbackSpeed || 1));
            const elapsed = (performance.now() - gapPlayback.startWall) / 1000 * speed;
            let now = gapPlayback.startTimeline + elapsed;

            // Materialized clips are still the primary video track. Use its
            // decoded media clock instead of a second independent wall clock.
            const clockClip = (state.videoLayers || []).find(item =>
              state.trackVisibility?.[item.trackId] !== false &&
              state.currentTime >= item.start && state.currentTime < item.end);
            if (clockClip) {
              const decoder = $("visualLayer")?.querySelector(`.layer-video-decoder[data-id="${clockClip.id}"]`);
              now = state.currentTime;
              if (decoder && decoder.readyState >= 2 && !decoder.seeking && (!decoder.paused || decoder.ended)) {
                const rate = editRate(clockClip, Number(state.audio.speed || 1));
                const adjacent = (state.videoLayers || []).find(item => item.id !== clockClip.id &&
                  item.trackId === clockClip.trackId && Math.abs(item.start-clockClip.end)<1e-7);
                // Preserve the elapsed fraction of the boundary frame. Clamping
                // every cut to its start loses time on each decoder handoff.
                now = clamp(clockClip.start + (Number(decoder.currentTime || 0) - Number(clockClip.sourceStart || 0)) / rate,
                  Math.max(clockClip.start,state.currentTime), adjacent ? Math.min(adjacent.end,clockClip.end+frameDuration()) : clockClip.end);
              }
              gapPlayback.startTimeline = now;
              gapPlayback.startWall = performance.now();
            }
            if (state.cutPreviewRange && now >= state.cutPreviewRange.end) {
              const start = state.cutPreviewRange.start;
              const next = mainClips().find(clip => clip.start > start);
              seekTimeline(start);
              gapPlayback = { startTimeline: start, startWall: performance.now(), gapEnd: next?.start ?? state.duration };
              playbackAnimationFrame = requestAnimationFrame(tick); return;
            }
            if (now >= gapPlayback.gapEnd - 1e-7) {
              // 间隙结束，恢复视频播放
              state.currentTime = gapPlayback.gapEnd;
              gapPlayback = null;
              const clips = mainClips();
              const clip = clips.find(
                (c) => state.currentTime >= c.start && state.currentTime < c.end + 0.01,
              );
              if (clip) {
                const video = getActiveVideo();
                video.currentTime = clip.sourceStart;
                if (video.paused) video.play().catch(() => {});
              }
            } else {
              state.currentTime = now;
            }
            if (previewAtTimelineEnd()) {
              state.playing = false;
              getActiveVideo().pause();
              syncPreviewAudio();
              renderPreviewObjects(false);
              $("play").textContent = "▶";
              playbackAnimationFrame = 0;
              gapPlayback = null;
              return;
            }
            // Promote the preloaded decoder in this tick, before audio sync;
            // deferring the switch to another RAF adds a frozen frame per cut.
            if (clockClip && state.currentTime >= clockClip.end) renderPreviewObjects(false);
            else schedulePreviewRender(false);
            syncPreviewAudio();
            syncPlayheadPosition();
            $("timecode").textContent =
              `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
            keepPlayheadInView("play");
            playbackAnimationFrame = requestAnimationFrame(tick);
            return;
          }

          const video = getActiveVideo();
          if (primaryFrameLoad || video.readyState < 2 || video.seeking) {
            playbackAnimationFrame = requestAnimationFrame(tick);
            return;
          }
          const source = Number(video.currentTime || 0);
          maybePrefetchUpcomingCut(source);
          const live = video.seeking ? skipDeadSource(source) : jumpPlaybackSource(source);
          // A decoder swap invalidates the local video reference. Resume the
          // next tick with the new player before handling gaps/end-of-media.
          if (getActiveVideo() !== video || cutPrefetch?.reached || video.seeking) {
            playbackAnimationFrame = requestAnimationFrame(tick);
            return;
          }
          state.currentTime = mapSourceTime(live);
          if (typeof serviceCutPreviewLoop === "function" && serviceCutPreviewLoop()) {
            playbackAnimationFrame = requestAnimationFrame(tick); return;
          }

          const clips = mainClips();
          const curIndex = clips.findIndex(
            (c) => state.currentTime >= c.start && state.currentTime < c.end,
          );
          const curClip = curIndex >= 0 ? clips[curIndex] : null;

          // ── 检测是否进入了间隙 ──
          const inClip = !!curClip;
          if (!inClip && state.currentTime < state.duration - 0.05) {
            const nextUpcoming = clips.find((c) => c.start > state.currentTime + 0.001);
            if (nextUpcoming) {
              video.pause();
              gapPlayback = {
                gapEnd: nextUpcoming.start,
                startWall: performance.now(),
                startTimeline: state.currentTime,
              };
            }
          }
          if (previewAtTimelineEnd()) {
            state.playing = false;
            video.pause();
            getStandbyVideo()?.pause();
            syncPreviewAudio();
            renderPreviewObjects(false);
            $("play").textContent = "▶";
            playbackAnimationFrame = 0;
            gapPlayback = null;
            return;
          }
          schedulePreviewRender(false);
          syncPreviewAudio();
          syncPlayheadPosition();
          $("timecode").textContent =
            `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
          keepPlayheadInView("play");
          playbackAnimationFrame = requestAnimationFrame(tick);
        };
        playbackAnimationFrame = requestAnimationFrame(tick);
      }
      let shuttleSpeed = 0;
      let shuttleTimer = null;
      function effectivePlaybackRate(baseSpeed = null) {
        const previewRate = Number(state.playbackSpeed || 1);
        const clipRate = Number(baseSpeed == null ? (state.audio?.speed || 1) : baseSpeed);
        const shuttle = shuttleSpeed ? Math.abs(shuttleSpeed) : 1;
        return clamp(previewRate * clipRate * shuttle, 0.25, 16);
      }
      function applyMediaPlaybackRate(mediaEl, baseSpeed = null) {
        if (!mediaEl) return;
        const rate = effectivePlaybackRate(baseSpeed);
        mediaEl.playbackRate = rate;
        if (mediaEl.preservesPitch !== undefined) mediaEl.preservesPitch = true;
        if (mediaEl.webkitPreservesPitch !== undefined) mediaEl.webkitPreservesPitch = true;
        if (mediaEl.mozPreservesPitch !== undefined) mediaEl.mozPreservesPitch = true;
      }
      const PLAYBACK_SPEED_TIERS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
      function setPlaybackSpeed(speed, notify = true) {
        const val = clamp(Number(speed) || 1.0, 0.25, 8.0);
        state.playbackSpeed = val;
        const btn = $("playbackSpeedBtn");
        if (btn) {
          const text = val % 1 === 0 ? `${val.toFixed(1)}×` : `${val}×`;
          btn.textContent = text;
          btn.classList.toggle("speed-boosted", val !== 1.0);
        }
        const select = $("playbackSpeedSelect");
        if (select) {
          select.value = String(val);
        }
        applyMediaPlaybackRate($("video"));
        applyMediaPlaybackRate($("videoAlt"));
        for (const player of previewAudioPlayers.values()) {
          applyMediaPlaybackRate(player);
        }
        if (notify) toast(`⚡ 播放倍速：${val}×`);
      }
      function stepPlaybackSpeed(direction = 1) {
        const current = Number(state.playbackSpeed || 1.0);
        let idx = PLAYBACK_SPEED_TIERS.findIndex(s => Math.abs(s - current) < 0.05);
        if (idx === -1) {
          idx = PLAYBACK_SPEED_TIERS.findIndex(s => s >= current);
          if (idx === -1) idx = PLAYBACK_SPEED_TIERS.length - 1;
        }
        const nextIdx = clamp(idx + direction, 0, PLAYBACK_SPEED_TIERS.length - 1);
        setPlaybackSpeed(PLAYBACK_SPEED_TIERS[nextIdx], true);
      }
      function stopShuttle(pauseVideo = true) {
        if (shuttleTimer) {
          clearInterval(shuttleTimer);
          shuttleTimer = null;
        }
        shuttleSpeed = 0;
        if (pauseVideo && state.playing) {
          getActiveVideo().pause();
          getStandbyVideo()?.pause();
          state.playing = false;
          gapPlayback = null;
          $("play").textContent = "▶";
          syncPreviewAudio();
          renderPreviewObjects(false);
        }
        applyMediaPlaybackRate($("video"));
        applyMediaPlaybackRate($("videoAlt"));
      }
      function handleShuttleKey(key) {
        if (!state.video) return;
        if (key === "KeyK") {
          stopShuttle(true);
          toast("暂停 (K)");
          return;
        }
        if (key === "KeyL") {
          if (shuttleTimer) {
            clearInterval(shuttleTimer);
            shuttleTimer = null;
          }
          if (shuttleSpeed <= 0) {
            shuttleSpeed = 1;
          } else if (shuttleSpeed < 16) {
            shuttleSpeed *= 2;
          }
          if (!state.playing) {
            state.playing = true;
            getActiveVideo().play().catch(() => {});
            startPlaybackAnimationLoop();
            $("play").textContent = "❚❚";
          }
          applyMediaPlaybackRate($("video"));
          applyMediaPlaybackRate($("videoAlt"));
          toast(`⚡ 快进穿梭播放：${shuttleSpeed}x (L)`);
          return;
        }
        if (key === "KeyJ") {
          if (shuttleSpeed > 1) {
            shuttleSpeed = Math.floor(shuttleSpeed / 2);
            applyMediaPlaybackRate($("video"));
            applyMediaPlaybackRate($("videoAlt"));
            toast(`⚡ 快进穿梭播放：${shuttleSpeed}x (L)`);
            return;
          }
          if (state.playing) {
            getActiveVideo().pause();
            getStandbyVideo()?.pause();
            state.playing = false;
            $("play").textContent = "▶";
          }
          if (shuttleSpeed >= 0) {
            shuttleSpeed = -1;
          } else if (shuttleSpeed > -16) {
            shuttleSpeed *= 2;
          }
          if (shuttleTimer) clearInterval(shuttleTimer);
          const absSpeed = Math.abs(shuttleSpeed);
          const stepInterval = 40;
          const stepDuration = (stepInterval / 1000) * absSpeed;
          shuttleTimer = setInterval(() => {
            const next = state.currentTime - stepDuration;
            if (next <= 0) {
              seekTimeline(0);
              stopShuttle(true);
            } else {
              seekTimeline(next);
            }
          }, stepInterval);
          toast(`⏪ 倒放穿梭：${absSpeed}x (J)`);
        }
      }
      async function togglePlay() {
        state.previewSeekTarget = null;
        if ($("frameSeekStatus")) $("frameSeekStatus").textContent = "";
        if (!state.video) return;
        const request = ++playRequestGeneration;
        if (shuttleTimer) {
          clearInterval(shuttleTimer);
          shuttleTimer = null;
        }
        shuttleSpeed = 0;
        applyMediaPlaybackRate($("video"));
        applyMediaPlaybackRate($("videoAlt"));
        if (state.playing) {
          resetCutPrefetch();
          getActiveVideo().pause();
          getStandbyVideo()?.pause();
          state.playing = false;
          gapPlayback = null;
          syncPreviewAudio();
          renderPreviewObjects(false);
          $("play").textContent = "▶";
          return;
        }
        stopComparisonPreview();
        const playable = mainClips();
        if (previewAtTimelineEnd()) seekTimeline(0);
        const inClipAtPlay = playable.some(
          (clip) => state.currentTime >= clip.start && state.currentTime < clip.end,
        );
        if (!inClipAtPlay) {
          // 播放头在间隙中 — 初始化间隙播放，不跳到下一个 clip
          const next = playable.find((clip) => clip.start > state.currentTime + 0.001);
          gapPlayback = {
            gapEnd: next ? next.start : state.duration,
            startWall: performance.now(),
            startTimeline: state.currentTime,
          };
        }
        state.playing = true;
        applyMediaPlaybackRate($("video"));
        applyMediaPlaybackRate($("videoAlt"));
        pendingPlayRequest = request;
        const video = getActiveVideo(), sourceUrl = state.video.url;
        const isCurrent = () => request === playRequestGeneration &&
          state.playing && video === getActiveVideo() && state.video?.url === sourceUrl;
        const stopFailedPlay = (message) => {
          if (!isCurrent()) return;
          state.playing = false;
          gapPlayback = null;
          video.pause();
          syncPreviewAudio();
          $("play").textContent = "▶";
          if (message) toast(message);
        };
        try {
          // Pending autosaves run when paused. Transport must not serialize
          // a large project or wait for disk writes before starting media.
          if (!isCurrent()) return;
          if (primaryFrameLoad) {
            const ready = await primaryFrameLoad.promise;
            if (!isCurrent()) return;
            if (!ready) { stopFailedPlay(); return; }
          }

          if (!isCurrent()) return;

          if (!isCurrent()) return;
          await Promise.all([...document.querySelectorAll(".layer-video-decoder")].filter(decoder => {
            const clip = state.videoLayers?.find(item => item.id === decoder.dataset.id);
            return clip && state.trackVisibility?.[clip.trackId] !== false && state.currentTime >= clip.start && state.currentTime < clip.end;
          }).map(decoder => {
            if (decoder.readyState >= 2 && !decoder.seeking) return;
            return new Promise((resolve, reject) => {
              const events = ["loadeddata", "canplay", "seeked", "error"];
              const done = error => { clearTimeout(timer); for (const event of events) decoder.removeEventListener(event, check); error ? reject(error) : resolve(); };
              const check = () => { if (decoder.error) done(new Error("切口视频解码失败")); else if (decoder.readyState >= 2 && !decoder.seeking) done(); };
              const timer = setTimeout(() => done(new Error("切口画面加载超时")), 12000);
              for (const event of events) decoder.addEventListener(event, check);
              check();
            });
          }));
          if (!isCurrent()) return;
          if (gapPlayback) gapPlayback.startWall = performance.now();
          if (inClipAtPlay) {
            // Start the denoised audio player from the transport gesture,
            // alongside the video decoder, so the browser doesn't reject it
            // as a second autoplay request after video.play() resolves.
            pendingPlayRequest = 0;
            syncPreviewAudio();
            await video.play();
          }
        } catch (error) {
          // pause()/load() legitimately cancel play(). A stale request must not
          // restart the UI loop or change the replacement source's state.
          stopFailedPlay(error?.name === "AbortError" ? "" :
            `无法播放素材：${error?.message || "请检查素材格式或重新关联"}`);
          return;
        } finally {
          if (pendingPlayRequest === request) pendingPlayRequest = 0;
        }
        if (!isCurrent()) return;
        keepPlayheadInView("play");
        updateBeautyPreviewState();
        startPlaybackAnimationLoop();
        syncPreviewAudio();
        renderPreviewObjects(false);
        $("play").textContent = "❚❚";
      }

      function wireVideoEvents(v) {
        if (!v) return;
        v.onloadedmetadata = () => {
          if (cutPrefetch?.video === v && v.dataset.sourceUrl === cutPrefetch.url) {
            if (Math.abs(Number(v.currentTime || 0) - cutPrefetch.target) > 0.008) v.currentTime = cutPrefetch.target;
            else commitCutPrefetch(v);
            return;
          }
          if (!state.video || v !== getActiveVideo() ||
              v.dataset.sourceUrl !== state.video.url || !Number.isFinite(v.duration)) return;
          const duration = Number(v.duration || 0);
          if (duration <= 0) return;
          if (Math.abs(duration - state.sourceDuration) >= 0.01) {
            state.sourceDuration = duration;
            state.video.duration = duration;
            state.video.analysisPending = !!state.video.analysisJobId;
            recomputeContentDuration();
            state.timelineDuration = Math.max(60, state.duration + 10);
            renderAll();
          }
          restorePrimaryFrame(v);
        };
        v.onseeked = () => {
          if (cutPrefetch?.video === v) { commitCutPrefetch(v); return; }
          if (!state.playing && v === getActiveVideo() && Number.isFinite(state.previewSeekTarget)) {
            if (Math.abs(v.currentTime - state.previewSeekTarget) > 0.000001) { v.currentTime = state.previewSeekTarget; return; }
            state.previewSeekTarget = null;
            if ($("frameSeekStatus")) $("frameSeekStatus").textContent = "";
            renderPreviewObjects(false);
          }
          const restoring = !!primaryFrameLoad;
          restorePrimaryFrame(v);
          if (!restoring && !pendingPlayRequest && state.playing && !gapPlayback && v === getActiveVideo() && v.paused) {
            v.play().catch(() => {});
          }
          if (beautyIsActive() && !beautyFrameRequest)
            beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
        };
        v.onloadeddata = () => {
          if (cutPrefetch?.video === v) {
            if (Math.abs(Number(v.currentTime || 0) - cutPrefetch.target) > 0.008) v.currentTime = cutPrefetch.target;
            else commitCutPrefetch(v);
            return;
          }
          restorePrimaryFrame(v);
          if (beautyIsActive() && !beautyFrameRequest)
            beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
        };
        v.oncanplay = () => {
          if (cutPrefetch?.video === v) { commitCutPrefetch(v); return; }
          restorePrimaryFrame(v);
        };
        v.onerror = () => {
          if (v !== getActiveVideo() || !v.getAttribute("src") ||
              v.dataset.sourceUrl !== state.video?.url) return;
          finishPrimaryFrameLoad(false);
          playRequestGeneration += 1;
          state.playing = false;
          gapPlayback = null;
          syncPreviewAudio();
          $("play").textContent = "▶";
          toast("无法读取视频画面，请检查原素材或重新关联支持的本地视频。");
        };
        v.ontimeupdate = () => {
          if (!state.playing || primaryFrameLoad || v !== getActiveVideo() || v.seeking || gapPlayback) return;
          const source = Number(v.currentTime || 0);
          if ((state.removals || []).some((range) => source >= range.start && source < range.end))
            return;
          state.currentTime = mapSourceTime(source);
          if (typeof serviceCutPreviewLoop === "function" && serviceCutPreviewLoop()) return;
          if (previewAtTimelineEnd()) {
            if (state.loopPlayback) {
              seekTimeline(0);
            } else {
              state.playing = false;
              v.pause();
              getStandbyVideo()?.pause();
              $("play").textContent = "▶";
            }
          }
          syncPreviewAudio();
        };
        v.onended = () => {
          if (primaryFrameLoad || v !== getActiveVideo()) return;
          if (state.loopPlayback) {
            seekTimeline(0);
            v.play().catch(() => {});
          } else {
            state.playing = false;
            syncPreviewAudio();
            renderPreviewObjects(false);
            $("play").textContent = "▶";
          }
        };
      }
      wireVideoEvents($("video"));
      wireVideoEvents($("videoAlt"));
      const previewAudioPlayers = new Map();
      let previewAudioSyncGeneration = 0;
      function stopComparisonPreview() {
        const compare = $("denoiseCompare");
        if (!compare) return;
        compare.pause();
        compare.dataset.previewActive = "false";
        compare.style.display = "none";
        const audition = $("audioFxAudition");
        if (audition?.dataset.listening === "processed") {
          audition.dataset.listening = "original";
          audition.textContent = "试听处理后";
        }
      }
      function previewAudioPlayer(key, url) {
        let player = previewAudioPlayers.get(key);
        if (!player) {
          player = document.createElement("audio");
          player.preload = "auto";
          $("audioPreviewLayer").appendChild(player);
          previewAudioPlayers.set(key, player);
        }
        if (url && player.dataset.sourceUrl !== url) {
          player.pause();
          player.dataset.sourceUrl = url;
          player.src = url;
        }
        return player;
      }
      function syncOneAudio(player, sourceTime, active, options = {}, generation = previewAudioSyncGeneration) {
        // Each decoder has one current intent. Metadata/seek/play callbacks
        // read that intent rather than reviving an obsolete clip request.
        const states = syncOneAudio.states ||= new WeakMap();
        let control = states.get(player);
        if (!control) {
          control = { identity: null, needsPosition: true, playPending: false, playToken: 0, desired: null };
          states.set(player, control);
          control.stop = () => { player.pause(); control.playToken++; control.playPending = false; };
          control.apply = () => {
            const desired = control.desired;
            if (!desired) return;
            if (!desired.active) { control.stop(); return; }
            player.volume = clamp(Number(desired.options.volume ?? 1), 0, 1);
            player.muted = !!desired.options.silent;
            applyMediaPlaybackRate(player, Number(desired.options.speed ?? 1));
            if (player.readyState != null && player.readyState < 1) return;
            if (player.seeking) return;
            const drift = Math.abs(Number(player.currentTime || 0) - desired.time);
            const shouldPlay = !desired.options.preload && (state.playing || rulerScrub) &&
              (typeof pendingPlayRequest === "undefined" || !pendingPlayRequest);
            // Discontinuous source mappings and explicit paused seeks are
            // exact; drift tolerance applies only within a running clip.
            const tolerance = control.needsPosition || !shouldPlay ? 0.002 : 0.14;
            const clockInRange = Number(player.currentTime || 0) >= Number(desired.options.minSource || 0) - 0.002;
            if (drift > tolerance && !(desired.options.clockMaster && shouldPlay && !control.needsPosition && clockInRange)) {
              control.stop();
              player.currentTime = desired.time;
              control.needsPosition = false;
              if (player.seeking) return;
            }
            control.needsPosition = false;
            if (!shouldPlay) { control.stop(); return; }
            if (!player.paused || control.playPending) return;
            if (player.readyState != null && player.readyState < 2) return;
            control.playPending = true;
            const token = ++control.playToken;
            control.playPromise = player.play().then(() => {
              if (token !== control.playToken) return;
              control.playPending = false;
              if (!control.desired?.active || control.desired.options.preload || (!state.playing && !rulerScrub)) player.pause();
              else if (player.paused) control.apply();
            }).catch(() => { if (token === control.playToken) control.playPending = false; });
          };
          for (const event of ["loadedmetadata", "loadeddata", "canplay", "seeked"])
            player.addEventListener?.(event, control.apply);
        }
        player.dataset.syncGeneration = String(generation);
        player.dataset.syncActive = String(active);
        const identity = `${player.dataset.sourceUrl || player.src || ""}|${options.mappingKey || ""}`;
        if (active && identity !== control.identity) {
          control.stop();
          control.identity = identity;
          control.needsPosition = true;
        }
        if (options.forceSeek) control.needsPosition = true;
        control.desired = { active, time: Math.max(0, Number(sourceTime || 0)), options };
        control.apply();
      }
      const previewAudioLanes = new Map();
      function audioClipMapping(clip) {
        const rate = editRate(clip, Number(state.audio.speed || 1));
        return `${clip.playbackAudioUrl || clip.url}|${rate.toFixed(8)}|${(Number(clip.sourceStart || 0) - Number(clip.start) * rate).toFixed(8)}`;
      }
      function syncAudioLane(key, clips, generation, usedPlayers) {
        let lane = previewAudioLanes.get(key);
        if (!lane) { lane = { side: 0, mapping: "" }; previewAudioLanes.set(key, lane); }
        const time = state.currentTime;
        const clip = clips.find(item => time >= item.start && time < item.end);
        const next = clips.find(item => item.start > time && item.start - time <= 2 * Math.max(1, Number(state.playbackSpeed || 1)) && (!clip || audioClipMapping(item) !== audioClipMapping(clip)));
        if (clip && lane.mapping !== audioClipMapping(clip)) {
          // One audible decoder per track lane. The other is only a silent
          // buffer; no clip-specific players continue beyond their end.
          lane.side = 1 - lane.side;
          lane.mapping = audioClipMapping(clip);
        }
        for (const side of [lane.side, 1 - lane.side]) {
          const playerKey = `${key}:${side}`;
          usedPlayers.add(playerKey);
          const item = side === lane.side ? clip : next;
          const player = previewAudioPlayer(playerKey, item?.playbackAudioUrl || item?.url || "");
          if (!item) { syncOneAudio(player, 0, false, {}, generation); continue; }
          const rate = editRate(item, Number(state.audio.speed || 1));
          const preload = side !== lane.side;
          const preroll = Math.min(0.2,Number(item.sourceStart || 0)/rate);
          const warming = preload && state.playing && item.start-time<=preroll;
          const sourceTime = Number(item.sourceStart || 0) + (preload ? -Math.min(item.start-time,preroll)*rate : Math.max(0, time - item.start) * rate);
          syncOneAudio(player, sourceTime, true, {
            mappingKey: audioClipMapping(item), preload:preload && !warming,
            silent:preload,
            volume: preload || item.muted || (typeof window.spliceMutedForVideoLayer === "function" && window.spliceMutedForVideoLayer(item.linkedVideoId, item.linkGroupId, time)) ? 0 : Number(state.audio.volume ?? 1) * Number(item.volume ?? 1) * clipFadeGain(item, item, time),
            speed: rate * (warming && sourceTime-Number(player.currentTime)>0.015 ? 1.5 : 1),
          }, generation);
        }
      }
      function clipFadeGain(settings, clip, time) {
        if (!settings || !clip) return 1;
        const fadeIn = Math.min(
            Math.max(0, Number(settings.fadeIn || 0)),
            Math.max(0, clip.end - clip.start),
          ),
          fadeOut = Math.min(
            Math.max(0, Number(settings.fadeOut || 0)),
            Math.max(0, clip.end - clip.start),
          );
        let gain = 1;
        if (fadeIn > 0) gain = Math.min(gain, (time - clip.start) / fadeIn);
        if (fadeOut > 0) gain = Math.min(gain, (clip.end - time) / fadeOut);
        return clamp(gain, 0, 1);
      }
      function denoisedMainAudioAsset(asset, sourcePath) {
        if (!sourcePath || !asset) return false;
        if (asset.path === sourcePath || asset.sourceMediaId === sourcePath) return true;
        const linkedVideo = (state.videoLayers || []).find(video =>
          (asset.linkedVideoId && video.id === asset.linkedVideoId) ||
          (asset.linkGroupId && video.linkGroupId === asset.linkGroupId));
        return linkedVideo?.path === sourcePath;
      }
      function syncPreviewAudio() {
        if (cutPrefetch?.reached) {
          for (const player of previewAudioPlayers.values()) player.pause();
          return;
        }
        const generation = ++previewAudioSyncGeneration;
        // A persisted cache can disappear after a cleanup or migration.  Do
        // not mute the video's audio unless a playable denoised asset exists.
        const denoisedAudio = state.denoiseEnabled && state.denoisedAudio?.url && !state.denoisedAudio?.missing &&
          (!state.denoisedAudio.sourcePath || state.denoisedAudio.sourcePath === state.video?.path)
          ? state.denoisedAudio
          : state.video?.playbackAudioUrl ? {url:state.video.playbackAudioUrl} : null;
        const mainClip = mainAudioClips().find(
            (clip) =>
              state.currentTime >= clip.start && state.currentTime < clip.end,
          ),
          mainSettings = mainClip ? mainAudioSettings(mainClip) : null,
          mainTrackVisible = mainClip
            ? isTrackAudible(state.mainAudioTrackMap?.[mainClip.id] || "audio")
            : isTrackAudible("audio"),
          mainVideoClip = activeMainVideoClip(),
          mainVideoSettingsForAudio = mainVideoClip ? mainVideoSettings(mainVideoClip) : null,
          spliceMainMuted = !!mainVideoSettingsForAudio && typeof window.spliceShouldMute === "function" && window.spliceShouldMute(mainVideoSettingsForAudio, state.currentTime),
          mainMuted =
            mainSettings?.muted ||
            spliceMainMuted ||
            state.audioMutes.some(
              (range) =>
                state.currentTime >= range.start && state.currentTime <= range.end,
            ),
          mainGain =
            Number(state.audio.volume ?? 1) *
            Number(mainSettings?.volume ?? 1) *
            clipFadeGain(mainSettings, mainClip, state.currentTime);
        const vMuted = !mainClip || !mainTrackVisible || !state.avLinked || !!mainMuted || !!denoisedAudio || !!rulerScrub;
        const vVol = clamp(mainGain, 0, 1);
        const active = getActiveVideo();
        const standby = getStandbyVideo();
        if (active) { active.muted = vMuted; active.volume = vVol; }
        // Decoder roles swap at every prefetched pause cut. Only the current
        // standby may be silenced/paused; videoAlt is sometimes the active one.
        if (standby && standby !== active) {
          standby.pause(); standby.muted = true; standby.volume = 0;
        }
        const main = previewAudioPlayer(
          "main",
          denoisedAudio?.url || state.video?.url || "",
        );
        if (state.video && (!state.avLinked || denoisedAudio || rulerScrub)) {
          const active = !!mainClip && mainTrackVisible;
          const sourceTime = mainClip
            ? Number(mainClip.sourceStart || 0) +
              Math.max(0, state.currentTime - mainClip.start) *
                Math.max(0.05, Number(state.audio.speed || 1))
            : 0;
          syncOneAudio(main, sourceTime, active, {
            mappingKey: mainClip ? `${Number(mainClip.sourceStart || 0) - mainClip.start * Number(state.audio.speed || 1)}` : "",
            volume: mainMuted ? 0 : Math.min(1, mainGain),
            speed: state.audio.speed,
          }, generation);
        } else {
          main.dataset.syncGeneration = String(generation);
          main.pause();
        }
        const activeIds = new Set(), lanes = new Map();
        const denoisedSourcePath = denoisedAudio?.sourcePath || (denoisedAudio ? state.video?.path : "") || "";
        const timelineAudioAssets = (state.audioAssets || []).map(asset => {
          if (!denoisedAudio || !denoisedMainAudioAsset(asset, denoisedSourcePath)) return asset;
          // Materialized main-video clips play through audioAssets rather than
          // mainAudioClips. Route those linked clips to the full-track cache so
          // the original source audio cannot mask the denoised playback.
          if (mainClip && mainTrackVisible && state.currentTime >= asset.start && state.currentTime < asset.end)
            return { ...asset, muted: true };
          return { ...asset, url: denoisedAudio.url, playbackAudioUrl: "" };
        });
        for (const asset of [...timelineAudioAssets].sort((a, b) => a.start - b.start)) {
          if (!isTrackAudible(asset.trackId)) continue;
          const track = asset.trackId || "audio";
          let trackLanes = lanes.get(track);
          if (!trackLanes) { trackLanes = []; lanes.set(track, trackLanes); }
          let items = trackLanes.find(items => items.at(-1).end <= asset.start + 0.000001);
          if (!items) { items = []; trackLanes.push(items); }
          items.push(asset);
        }
        for (const [track, trackLanes] of lanes)
          trackLanes.forEach((items, index) => syncAudioLane(`track:${track}:${index}`, items, generation, activeIds));
        for (const [key, player] of previewAudioPlayers)
          if (key !== "main" && !activeIds.has(key)) {
            syncOneAudio(player, 0, false, {}, generation);
            player.remove();
            previewAudioPlayers.delete(key);
          }
      }
      
