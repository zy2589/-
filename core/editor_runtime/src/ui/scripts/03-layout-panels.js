function updateFrameSize(force = false) {
        if (!$("stage") || !$("frame") || $("stage").clientHeight <= 0 || $("stage").clientWidth <= 0) return;
        const stage = $("stage"),
          maxH = Math.max(1, stage.clientHeight - 45),
          maxW = Math.max(1, stage.clientWidth - 90),
          ratio = state.width / state.height;
        let h = maxH,
          w = h * ratio;
        if (w > maxW) {
          w = maxW;
          h = w / ratio;
        }
        const frame = $("frame");
        if (frame.style.width !== `${w}px`) frame.style.width = `${w}px`;
        if (frame.style.height !== `${h}px`) frame.style.height = `${h}px`;
        frame.style.transform = `scale(${state.canvasZoom || 1})`;
        frame.style.transformOrigin = "center center";
        if (force) renderPreviewObjects(true);
        else updatePreviewTransformOnly();
      }
      function setRatio(ratio) {
        state.ratio = ratio;
        if (ratio === "9:16") {
          state.width = 1080;
          state.height = 1920;
          $("resolution").innerHTML =
            '<option value="1080x1920">1080×1920</option><option value="1440x2560">1440×2560</option><option value="2160x3840">2160×3840</option>';
        } else {
          state.width = 1920;
          state.height = 1080;
          $("resolution").innerHTML =
            '<option value="1920x1080">1920×1080</option><option value="2560x1440">2560×1440</option><option value="3840x2160">3840×2160</option>';
        }
        const quickMenu = $("previewQuickMenu");
        if (quickMenu) quickMenu.value = `ratio:${ratio}`;
        if (!state.initializing) {
          updateFrameSize(false);
          renderAll();
        }
      }
      function previewIsFullscreen() {
        const stage = $("stage");
        return document.fullscreenElement === stage || document.webkitFullscreenElement === stage ||
          stage?.classList.contains("preview-fullscreen");
      }
      function syncPreviewFullscreen() {
        const active = previewIsFullscreen();
        $("stage")?.classList.toggle(
          "preview-fullscreen",
          active && !document.fullscreenElement && !document.webkitFullscreenElement,
        );
        if ($("previewFullscreen"))
          $("previewFullscreen").textContent = active ? "退出全屏" : "全屏预览";
        requestAnimationFrame(() => updateFrameSize(true));
      }
      async function togglePreviewFullscreen() {
        const stage = $("stage");
        if (!stage) return;
        try {
          if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) await document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          } else if (stage.classList.contains("preview-fullscreen")) {
            stage.classList.remove("preview-fullscreen");
          } else if (stage.requestFullscreen) {
            await stage.requestFullscreen();
          } else if (stage.webkitRequestFullscreen) {
            stage.webkitRequestFullscreen();
          } else {
            stage.classList.add("preview-fullscreen");
          }
        } catch {
          stage.classList.toggle("preview-fullscreen");
        }
        syncPreviewFullscreen();
      }
      let previewResizeFrame = 0;
      function schedulePreviewResize() {
        if (previewResizeFrame) return;
        previewResizeFrame = requestAnimationFrame(() => {
          previewResizeFrame = 0;
          updateFrameSize(true);
        });
      }
      if (typeof ResizeObserver !== "undefined") {
        // Observe the viewport, never the frame we resize (avoids feedback).
        const previewResizeObserver = new ResizeObserver(schedulePreviewResize);
        if ($("stage")) previewResizeObserver.observe($("stage"));
      }
      const previewQuickMenu = $("previewQuickMenu");
      if (previewQuickMenu) {
        previewQuickMenu.onchange = async (event) => {
          const value = String(event.target.value || "");
          if (value === "fullscreen") await togglePreviewFullscreen();
          else if (value.startsWith("ratio:")) setRatio(value.slice(6));
          else if (value.startsWith("resolution:")) {
            const resolution = value.slice(11);
            const dimensions = resolution.split("x").map(Number);
            if (dimensions.length === 2 && dimensions.every(Number.isFinite)) {
              [state.width, state.height] = dimensions;
              state.ratio = state.width > state.height ? "16:9" : "9:16";
              if ($("resolution")) $("resolution").value = resolution;
              updateFrameSize(true);
              queueAutosave();
            }
          }
          event.target.value = `ratio:${state.ratio}`;
        };
      }
      document.addEventListener("fullscreenchange", syncPreviewFullscreen);
      document.addEventListener("webkitfullscreenchange", syncPreviewFullscreen);
      function applyLayout() {
        const layout = state.layout || (state.layout = defaultStartupLayout());
        Object.assign(layout, resolveWorkspaceLayout(innerWidth, innerHeight, layout));
        document.documentElement.style.setProperty(
          "--side",
          `${layout.side}px`,
        );
        document.documentElement.style.setProperty(
          "--inspector",
          `${layout.inspector}px`,
        );
        document.documentElement.style.setProperty(
          "--timeline",
          `${layout.timeline}px`,
        );
        document.documentElement.style.setProperty(
          "--track-label-width",
          `${layout.trackLabel}px`,
        );
      }
      function revealTimelineTrack(trackId) {
        applyLayout();
        requestAnimationFrame(() => {
          const row = $("timelineContent")?.querySelector(`[data-track-key="${CSS.escape(trackId)}"]`);
          if (!row) return;
          const scroll = $("timelineScroll");
          const top = row.offsetTop;
          const bottom = top + row.offsetHeight;
          if (top < scroll.scrollTop) scroll.scrollTop = top;
          else if (bottom > scroll.scrollTop + scroll.clientHeight)
            scroll.scrollTop = Math.max(0, bottom - scroll.clientHeight);
          $("trackLabels").scrollTop = scroll.scrollTop;
        });
      }
      let layoutDrag = null;
      function beginLayoutResize(event, kind) {
        applyLayout();
        const layout = state.layout;
        layout.resized ||= {};
        layout.resized[kind] = true;
        layoutDrag = {
          pointer: event.pointerId,
          kind,
          x: event.clientX,
          y: event.clientY,
          value: Number(layout[kind]),
        };
        event.currentTarget.classList.add("dragging");
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      }
      $("leftPanelResizer").onpointerdown = (event) =>
        beginLayoutResize(event, "side");
      $("rightPanelResizer").onpointerdown = (event) =>
        beginLayoutResize(event, "inspector");
      $("timelineResizer").onpointerdown = (event) =>
        beginLayoutResize(event, "timeline");
      $("trackLabelResizer").onpointerdown = (event) =>
        beginLayoutResize(event, "trackLabel");
      window.addEventListener("pointermove", (event) => {
        if (!layoutDrag || layoutDrag.pointer !== event.pointerId) return;
        const deltaX = event.clientX - layoutDrag.x,
          deltaY = event.clientY - layoutDrag.y;
        if (layoutDrag.kind === "side")
          state.layout.side = layoutDrag.value + deltaX;
        if (layoutDrag.kind === "inspector")
          state.layout.inspector = layoutDrag.value - deltaX;
        if (layoutDrag.kind === "timeline")
          state.layout.timeline = layoutDrag.value - deltaY;
        if (layoutDrag.kind === "trackLabel")
          state.layout.trackLabel = layoutDrag.value + deltaX;
        if (!layoutDrag.framePending)
          layoutDrag.framePending = requestAnimationFrame(() => {
            if (!layoutDrag) return;
            layoutDrag.framePending = 0;
            applyLayout();
            updateFrameSize(false);
          });
      });
      window.addEventListener("pointerup", (event) => {
        if (!layoutDrag || layoutDrag.pointer !== event.pointerId) return;
        if (layoutDrag.framePending) cancelAnimationFrame(layoutDrag.framePending);
        applyLayout();
        document.querySelectorAll(".dragging").forEach((item) => item.classList.remove("dragging"));
        layoutDrag = null;
        updateFrameSize(true);
        queueAutosave();
      });
      
