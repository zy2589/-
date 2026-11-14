      (() => {
        const migrations = [
          ["quickcut_export_device", "clipassistant_export_device"],
          ["quickcut_custom_caption_presets", "clipassistant_custom_caption_presets"],
        ];
        for (const [oldKey, newKey] of migrations) {
          try {
            if (localStorage.getItem(newKey) === null) {
              const previousValue = localStorage.getItem(oldKey);
              if (previousValue !== null) localStorage.setItem(newKey, previousValue);
            }
            localStorage.removeItem(oldKey);
          } catch {}
        }
      })();
      // Reference screenshot: ~15.6% library / 69% preview / 15.1% inspector.
      // Saved project media geometry is independent of this workspace-only layout.
      function defaultStartupLayout() {
        return { preset: "reference-2769", resized: {} };
      }
      function resolveWorkspaceLayout(width, height, layout = {}) {
        const w = Math.max(320, Number(width) || 1600);
        const h = Math.max(240, Number(height) || 980);
        const bound = (value, min, max) => Math.max(min, Math.min(max, value));
        const manual = layout.resized || {};
        const desired = (key, fallback) =>
          manual[key] && Number.isFinite(Number(layout[key])) ? Number(layout[key]) : fallback;
        const sideMin = Math.min(240, w * 0.25);
        const inspectorMin = Math.min(245, w * 0.25);
        const previewMin = Math.min(330, w * 0.35);
        const side = Math.round(bound(desired("side", w * 310 / 1982),
          sideMin, Math.max(sideMin, w - inspectorMin - previewMin - 10)));
        const inspector = Math.round(bound(desired("inspector", w * 300 / 1982),
          inspectorMin, Math.max(inspectorMin, w - side - previewMin - 10)));
        const availableHeight = Math.max(240, h - 50 - 24);
        const previewHeightMin = Math.min(300, availableHeight * 0.38);
        const timelineMin = Math.min(180, availableHeight * 0.3);
        const timelineMax = Math.max(timelineMin, availableHeight - previewHeightMin);
        return {
          side, inspector,
          timeline: Math.round(bound(desired("timeline", availableHeight * 367 / 1082), timelineMin, timelineMax)),
          trackLabel: Math.round(bound(desired("trackLabel", w * 275 / 1982), 275, Math.max(275, Math.min(400, w * 0.32)))),
        };
      }
