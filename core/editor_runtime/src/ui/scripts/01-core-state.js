
      const $ = (id) => document.getElementById(id);
      const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
      document.addEventListener("error", (event) => {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        if (image.hasAttribute("data-remove-on-error")) image.remove();
        else if (image.hasAttribute("data-hide-on-error")) image.style.display = "none";
      }, true);
      window.__clipAssistantWorkspaceMode = "edit";
      function rangeButtonStep(input) {
        const explicit = Number(input.dataset.buttonStep);
        if (Number.isFinite(explicit) && explicit > 0) return explicit;
        const nativeStep = Number(input.step);
        if (Number.isFinite(nativeStep) && nativeStep > 0) return nativeStep;
        const span = Number(input.max) - Number(input.min);
        return span <= 10 ? 0.1 : 1;
      }
      function installRangeSteppers(root = document) {
        root
          .querySelectorAll('input[type="range"]:not([data-stepper-ready])')
          .forEach((input) => {
            input.dataset.stepperReady = "true";
            input.dataset.resetValue ??= input.getAttribute("value") ?? "0";
            const wrapper = document.createElement("div");
            wrapper.className = "range-stepper";
            input.parentNode.insertBefore(wrapper, input);
            const makeButton = (direction) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "range-step-button";
              button.textContent = direction < 0 ? "−" : "+";
              button.title = direction < 0 ? "减少" : "增加";
              button.onclick = () => {
                if (input.disabled) return;
                const step = rangeButtonStep(input),
                  min = Number.isFinite(Number(input.min))
                    ? Number(input.min)
                    : -Infinity,
                  max = Number.isFinite(Number(input.max))
                    ? Number(input.max)
                    : Infinity,
                  decimals = Math.max(
                    0,
                    (String(step).split(".")[1] || "").length,
                  ),
                  next = clamp(
                    Number(input.value || 0) + direction * step,
                    min,
                    max,
                  );
                input.value = Number(next.toFixed(decimals));
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              };
              return button;
            };
            const reset = document.createElement("button");
            reset.type = "button";
            reset.className = "range-step-button range-reset-button";
            reset.textContent = "↺";
            reset.title = "重置这一项";
            reset.onclick = () => {
              if (input.disabled) return;
              input.value = input.dataset.resetValue ?? "0";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            };
            wrapper.append(makeButton(-1), input, makeButton(1), reset);
          });
      }
      function defaultAuxSubtitleSettings() {
        return {
          language: "zh-Hans",
          editorVisible: true,
          fontScale: 0.62,
          color: "#e9edf2",
          gap: 18,
        };
      }
      const colorSliceKeys = ["red", "skin", "yellow", "green", "cyan", "blue", "magenta"];
      function defaultColorSlices() {
        return Object.fromEntries(
          colorSliceKeys.map((key) => [key, { hue: 0, saturation: 0, intensity: 0 }]),
        );
      }
      function normalizeColorSlices(source = {}) {
        const result = defaultColorSlices();
        for (const key of colorSliceKeys) {
          const value = source?.[key] || {};
          result[key] = {
            hue: clamp(Number(value.hue || 0), -100, 100),
            saturation: clamp(Number(value.saturation || 0), -100, 100),
            intensity: clamp(Number(value.intensity || 0), -100, 100),
          };
        }
        return result;
      }
      const denoisePresetMap = Object.freeze({
        balanced: { humEnabled: true, humDepth: 0.62, humHarmonics: 4, wind: 0.45, environment: 0.58, neural: 0.62, insect: 0.18, residual: 0.34, voiceRestore: 0.5 },
        wind: { humEnabled: false, humDepth: 0.35, humHarmonics: 3, wind: 0.9, environment: 0.62, neural: 0.7, insect: 0.08, residual: 0.42, voiceRestore: 0.58 },
        electrical: { humEnabled: true, humDepth: 0.92, humHarmonics: 6, wind: 0.28, environment: 0.54, neural: 0.55, insect: 0.12, residual: 0.34, voiceRestore: 0.52 },
        aircraft: { humEnabled: true, humDepth: 0.68, humHarmonics: 4, wind: 0.66, environment: 0.86, neural: 0.76, insect: 0.1, residual: 0.48, voiceRestore: 0.62 },
        insects: { humEnabled: false, humDepth: 0.35, humHarmonics: 3, wind: 0.32, environment: 0.66, neural: 0.68, insect: 0.82, residual: 0.56, voiceRestore: 0.64 },
        "mixed-heavy": { humEnabled: true, humDepth: 0.82, humHarmonics: 5, wind: 0.72, environment: 0.82, neural: 0.8, insect: 0.52, residual: 0.58, voiceRestore: 0.68 },
      });
      function defaultDenoiseSettings() {
        return {
            mode: "deepfilter",
          strength: 0.85,
          preset: "balanced",
          humFrequency: "auto",
          detectedHumFrequency: 0,
          ...denoisePresetMap.balanced,
        };
      }
      function normalizeDenoiseSettings(source = {}) {
        const preset = denoisePresetMap[source?.preset] ? source.preset : "balanced";
          const sourceMode = String(source?.mode || "deepfilter").toLowerCase();
          // Keep old professional aliases functional.  Previous versions
          // silently rewrote them to ai-isolation every time the inspector was
          // refreshed, so the professional controls could never take effect.
          const mode = ["professional", "pro"].includes(sourceMode)
            ? "studio-chain"
            : sourceMode;
        return {
          ...defaultDenoiseSettings(),
          ...denoisePresetMap[preset],
          ...(source || {}),
          preset,
          mode,
        };
      }
      function migrateDenoisedAudio(source) {
          if (!source || source.missing || !source.path) return null;
          return source;
        }
      const audioFxLabels = Object.freeze({
        "voice-isolation": "人声隔离",
        "noise-reduction": "噪声降低",
        "de-hummer": "电流嗡声消除",
        "dialogue-separator": "对话分离",
        "de-esser": "去齿音",
        "expander-gate": "扩展器 / 噪声门",
        "parametric-eq": "六段参数均衡器",
        "compressor-limiter": "压缩器 / 限幅器",
      });
      const defaultAudioFxEqBands = Object.freeze([
        { type: "lowshelf", frequency: 90, gain: 0, q: .7, enabled: true },
        { type: "bell", frequency: 180, gain: 0, q: 1, enabled: true },
        { type: "bell", frequency: 500, gain: 0, q: 1.1, enabled: true },
        { type: "bell", frequency: 2500, gain: 0, q: 1, enabled: true },
        { type: "bell", frequency: 6500, gain: 0, q: 1.2, enabled: true },
        { type: "highshelf", frequency: 12000, gain: 0, q: .7, enabled: true },
      ]);
      function defaultAudioFxParams(type) {
        const values = {
          "voice-isolation": { amount: .82, voiceProtect: .68, artifactControl: .5 },
          "noise-reduction": { mode: "auto", reductionDb: 12, noiseFloorDb: -48, sensitivity: .55, smoothing: 12, attackMs: 20, releaseMs: 180, learnedBands: [], learnedAt: 0, learnedDuration: 0 },
          "de-hummer": { frequency: "auto", detectedFrequency: 0, reductionDb: 18, harmonics: 4, q: 28 },
          "dialogue-separator": { voiceDb: 1.5, backgroundDb: -10, ambienceDb: -6, focus: .7 },
          "de-esser": { frequency: .58, threshold: .38, reduction: .55, listen: false },
          "expander-gate": { thresholdDb: -42, ratio: 2.2, rangeDb: -18, attackMs: 12, holdMs: 70, releaseMs: 220 },
          "parametric-eq": { bands: defaultAudioFxEqBands.map((band) => ({ ...band })) },
          "compressor-limiter": { thresholdDb: -18, ratio: 3, attackMs: 12, releaseMs: 180, makeupDb: 1.5, mix: 1, limiter: true, ceilingDb: -.8 },
        };
        return JSON.parse(JSON.stringify(values[type] || values["noise-reduction"]));
      }
      function makeAudioFx(type) {
        const resolved = audioFxLabels[type] ? type : "noise-reduction";
        return {
          id: crypto.randomUUID(), type: resolved, name: audioFxLabels[resolved],
          enabled: true, expanded: true, params: defaultAudioFxParams(resolved),
        };
      }
      function normalizeAudioFxRack(rack = []) {
        return (Array.isArray(rack) ? rack : []).slice(0, 6).map((effect) => {
          const type = audioFxLabels[effect?.type] ? effect.type : "noise-reduction";
          const params = { ...defaultAudioFxParams(type), ...(effect?.params || {}) };
          if (type === "parametric-eq")
            params.bands = defaultAudioFxEqBands.map((band, index) => ({ ...band, ...(effect?.params?.bands?.[index] || {}) }));
          return {
            id: String(effect?.id || crypto.randomUUID()), type,
            name: String(effect?.name || audioFxLabels[type]),
            enabled: effect?.enabled !== false, expanded: effect?.expanded !== false, params,
          };
        });
      }
      function audioFxSignature() {
        return JSON.stringify({
          track: normalizeAudioFxRack(state.audioFxRack),
          bypass: !!state.audioFxBypass,
        });
      }
      function denoiseSettingsSignature(source = state.denoise) {
        const value = normalizeDenoiseSettings(source);
        return JSON.stringify({
          mode: value.mode,
          strength: Number(value.strength || 0).toFixed(4),
          preset: value.preset,
          humEnabled: value.humEnabled !== false,
          humFrequency: value.humFrequency,
          detectedHumFrequency: Number(value.detectedHumFrequency || 0),
          humDepth: Number(value.humDepth || 0).toFixed(4),
          humHarmonics: Number(value.humHarmonics || 0),
          wind: Number(value.wind || 0).toFixed(4),
          environment: Number(value.environment || 0).toFixed(4),
          neural: Number(value.neural || 0).toFixed(4),
          insect: Number(value.insect || 0).toFixed(4),
          residual: Number(value.residual || 0).toFixed(4),
          voiceRestore: Number(value.voiceRestore || 0).toFixed(4),
        });
      }
      const state = {
        projectId: "",
        projectName: "未命名工程",
        editorActive: false,
        initializing: false,
        video: null,
        videoLayers: [],
        libraryAssets: [],
        hiddenLibraryPaths: [],
        audioAssets: [],
        images: [],
        titles: [],
        captions: [],
        autoTranscript: null,
        recognizedText: "", recognizedTextCleared: false,
        manuscriptLanguage: "en",
        captionRecoveryArchive: [],
        auxSubtitles: defaultAuxSubtitleSettings(),
        reviewCaptions: [],
        issues: [],
        matchIssues: [],
        alignmentOperations: [],
        alignmentDuration: 0,
        removals: [],
        manualCuts: [],
        audioMutes: [],
        audioCuts: [],
        mainAudioRemovals: [],
        mainAudioManualCuts: [],
        waveform: [],
        duration: 0,
        timelineDuration: 60,
        sourceDuration: 0,
        mainTimelineOffset: 0,
        mainAudioTimelineOffset: 0,
        mainVideoClipOffsets: {},
        mainAudioClipOffsets: {},
        currentTime: 0,
        playbackSpeed: 1.0,
        followPlayhead: true,
        timelineEditMode: "overwrite",
        // Keep timeline zoom centred on the cut being edited unless the user
        // deliberately switches to mouse-centred zoom for this session.
        timelineZoomAnchor: "playhead",
        zoom: 60,
        canvasZoom: 1,
        ratio: "9:16",
        width: 1080,
        height: 1920,
        selected: { type: "video", id: "main" },
        selectedItems: [],
        compoundClips: [],
        timelineRange: null,
        videoTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
        mainVideoClipSettings: {},
        captionTransform: { x: 0, y: 538, scale: 1, width: 860 },
        trackOrder: ["review", "caption", "video", "audio"],
        trackDefinitions: {},
        spliceLayout: "free",
        spliceRegions: [],
        spliceRatio: 0.5,
        spliceAngle: 0,
        spliceSelectedRegionId: "",
        spliceMainRegionId: "",
        mainVideoTrackMap: {},
        mainAudioTrackMap: {},
        trackVisibility: {
          review: true,
          caption: true,
          text: true,
          image: true,
          video: true,
          audio: true,
        },
        trackLocks: {},
        trackHeights: {},
        trackSolo: {},
        trackMute: {},
        trackAutoSelect: {},
        trackSyncLocks: {},
        avLinked: true,
        snapping: true,
        selectionFollowsPlayhead: false,
        timelineMarkers: [],
        captionLines: 1,
        naturalCaptionPunctuation: false,
        captionStyle: {
          fontFamily: "Helvetica",
          fontSize: 58,
          fontWeight: 900,
          fontItalic: false,
          fontUnderline: false,
          textCase: "none",
          letterSpacing: 0,
          wordSpacing: 0,
          lineHeight: 1.15,
          textAlign: "center",
          verticalAlign: "middle",
          color: "#ffffff",
          highlight: "#fff275",
          highlightEnabled: true,
          stroke: 5,
          strokeColor: "#111111",
          shadow: 0,
          shadowColor: "#000000",
          shadowOpacity: 0.8,
          shadowBlur: 4,
          shadowDistance: 3,
          shadowAngle: 45,
          glow: 0,
          glowColor: "#ffffff",
          backgroundEnabled: false,
          background: "#131922",
          backgroundOpacity: 0.94,
          padding: 18,
          backgroundMode: "block",
          backgroundFitText: true,
          backgroundWidth: 26,
          backgroundHeight: 14,
          backgroundX: 0,
          backgroundY: 0,
          radius: 26,
          animation: "karaoke",
          captionMotion: "none",
        },
        color: {
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
        },
        denoise: defaultDenoiseSettings(),
        denoiseEnabled: false,
        denoisedAudio: null,
        audioFxRack: [],
        audioFxBypass: false,
        audioFxScope: "track",
        beauty: {
          smoothing: 0,
          blemish: 0,
          texture: 0,
          whitening: 0,
          brighten: 0,
          warmth: 0,
          rosy: 0,
        },
        blemishMarks: [],
        blemishFaceRegion: null,
        audio: {
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
        },
        audioProcessingEnabled: false,
        mainAudioClipSettings: {},
        undo: [],
        redo: [],
        projectPath: "",
        projectCoverPath: "",
        playing: false,
        colorBypass: false,
        beautyBypass: false,
        filterLook: { id: "none", intensity: 1, baseColor: null },
        lut: null,
        exportJobId: "",
        exportBackend: "",
        exportProjectId: "",
        layout: defaultStartupLayout(),
      };
      const captionStyleDefaults = Object.freeze({ ...state.captionStyle });
      function normalizeCaptionLineMode(value) {
        const raw = String(value ?? "1").trim().toLowerCase();
        if (raw === "1" || raw === "one" || raw === "single") return 1;
        if (raw === "3" || raw === "three") return 3;
        if (raw === "0" || raw === "multi" || raw === "many" || raw === "auto") return "multi";
        const numeric = Number(raw);
        if (numeric === 1) return 1;
        if (numeric === 3) return 3;
        if (numeric === 0 || numeric >= 4) return "multi";
        return 2;
      }
      function captionWrapLineLimit(value) {
        const mode = normalizeCaptionLineMode(value);
        if (mode === 1) return 1;
        if (mode === 3) return 3;
        if (mode === "multi") return 8;
        return 2;
      }
      function normalizedCaptionStyle(style = {}) {
        return {
          ...captionStyleDefaults,
          ...(style || {}),
          fontSize: Number(style?.fontSize ?? captionStyleDefaults.fontSize),
          fontWeight: Number(style?.fontWeight ?? captionStyleDefaults.fontWeight),
          letterSpacing: Number(style?.letterSpacing ?? captionStyleDefaults.letterSpacing),
          wordSpacing: Number(style?.wordSpacing ?? captionStyleDefaults.wordSpacing),
          lineHeight: Number(style?.lineHeight ?? captionStyleDefaults.lineHeight),
          stroke: Number(style?.stroke ?? captionStyleDefaults.stroke),
          shadow: Number(style?.shadow ?? captionStyleDefaults.shadow),
          shadowOpacity: Number(style?.shadowOpacity ?? captionStyleDefaults.shadowOpacity),
          shadowBlur: Number(style?.shadowBlur ?? captionStyleDefaults.shadowBlur),
          shadowDistance: Number(style?.shadowDistance ?? captionStyleDefaults.shadowDistance),
          shadowAngle: ((Number(style?.shadowAngle ?? captionStyleDefaults.shadowAngle) % 360) + 360) % 360,
          glow: Number(style?.glow ?? captionStyleDefaults.glow),
          glowColor: style?.glowColor || style?.color || captionStyleDefaults.glowColor,
          backgroundEnabled: !!style?.backgroundEnabled,
          highlightEnabled: style?.highlightEnabled !== false,
          fontItalic: !!style?.fontItalic,
          fontUnderline: !!style?.fontUnderline,
          animation: style?.animation || "fade",
          captionMotion: style?.captionMotion === "vertical-scroll" ? "vertical-scroll" : "none",
        };
      }

      const defaultTrackOrder = [
        "review",
        "caption",
        "video",
        "audio",
      ];
      const textAnimations = [
        ["fade", "淡入", "soft"], ["rise", "轻柔上浮", "up"],
        ["drop", "上方落入", "down"], ["left", "左侧滑入", "left"],
        ["right", "右侧滑入", "right"], ["zoom", "柔和缩放", "zoom"],
        ["zoom-out", "镜头收缩", "zoomout"], ["pop", "干净弹入", "zoom"],
        ["focus", "焦点清晰", "blur"], ["tracking", "字距收合", "soft"],
        ["wipe-left", "左向揭示", "left"], ["wipe-right", "右向揭示", "right"],
        ["line-reveal", "线性显现", "soft"], ["rotate", "轻微旋入", "rotate"],
        ["flip-x", "水平翻入", "flip"], ["flip-y", "垂直翻入", "flip"],
        ["stretch-x", "横向展开", "zoom"], ["stretch-y", "纵向展开", "zoom"],
        ["typewriter", "打字机", "left"], ["word-rise", "逐词上浮", "up"],
        ["word-fade", "逐词显现", "soft"], ["soft-bounce", "轻弹", "up"],
        ["elastic", "柔性展开", "zoom"], ["swing", "轻摆入场", "rotate"],
        ["roll-left", "左向滚入", "rotate"], ["roll-right", "右向滚入", "rotate"],
        ["drift-up", "慢速上浮", "up"], ["drift-down", "慢速下落", "down"],
        ["scale-x", "中心横展", "zoom"], ["scale-y", "中心竖展", "zoom"],
        ["light-orbit", "环绕光弧", "rotate"], ["particle-reveal", "粒子显现", "soft"],
        ["flare-sweep", "柔光扫入", "left"], ["halo-pulse", "光环呼吸", "zoom"],
        ["comet-in", "流星划入", "right"], ["sparkle-ring", "星点环绕", "rotate"],
        ["dust-rise", "微尘上浮", "up"], ["electric-edge", "电光描边", "soft"],
        ["soft-rays", "柔光展开", "zoom"], ["star-burst", "星芒绽放", "zoomout"],
      ].map(([id, name, motion]) => ({ id, name, motion }));
      const imageAnimations = [
        ["fade", "淡入", "soft"], ["rise", "平稳上浮", "up"],
        ["drop", "平稳下落", "down"], ["slide-left", "左侧滑入", "left"],
        ["slide-right", "右侧滑入", "right"], ["zoom-in", "缩放进场", "zoom"],
        ["zoom-out", "收缩进场", "zoomout"], ["push-left", "左向推入", "left"],
        ["push-right", "右向推入", "right"], ["push-up", "向上推入", "up"],
        ["push-down", "向下推入", "down"], ["wipe-left", "左向擦入", "left"],
        ["wipe-right", "右向擦入", "right"], ["wipe-up", "向上擦入", "up"],
        ["wipe-down", "向下擦入", "down"], ["rotate-soft", "轻微旋转", "rotate"],
        ["rotate-left", "左旋进场", "rotate"], ["rotate-right", "右旋进场", "rotate"],
        ["flip-x", "水平翻转", "flip"], ["flip-y", "垂直翻转", "flip"],
        ["unfold-x", "横向展开", "zoom"], ["unfold-y", "纵向展开", "zoom"],
        ["focus", "焦点清晰", "blur"], ["soft-bounce", "轻弹进场", "up"],
        ["float-left", "左向漂入", "left"], ["float-right", "右向漂入", "right"],
        ["float-up", "向上漂入", "up"], ["tilt", "倾斜展开", "rotate"],
        ["shutter", "快门显现", "soft"], ["scale-center", "中心展开", "zoom"],
        ["light-orbit", "环绕光弧", "rotate"], ["particle-reveal", "粒子显现", "soft"],
        ["flare-sweep", "柔光扫入", "left"], ["halo-pulse", "光环呼吸", "zoom"],
        ["comet-in", "流星划入", "right"], ["sparkle-ring", "星点环绕", "rotate"],
        ["dust-rise", "微尘上浮", "up"], ["electric-edge", "电光描边", "soft"],
        ["soft-rays", "柔光展开", "zoom"], ["star-burst", "星芒绽放", "zoomout"],
      ].map(([id, name, motion]) => ({ id, name, motion }));
      const filterLooks = [
        ["clean", "清透人像", 5, 8, 5, 2, 0, 2, 10, 12, 0],
        ["soft", "柔光奶油", 8, -7, -5, 7, 2, 8, -4, -8, 0],
        ["gold", "黄金时刻", 4, 10, 12, 22, 3, 1, 10, 8, 8],
        ["day", "自然日光", 3, 7, 4, -2, 0, 1, 8, 15, 0],
        ["portrait", "高级肖像", 4, 12, -3, 6, 4, 4, 4, 5, 7],
        ["teal", "青橙电影", -2, 18, 7, -12, 8, -2, 12, 20, 15],
        ["neutral", "胶片中性", -1, 8, -8, 3, -2, 5, -3, -5, 8],
        ["nordic", "北欧冷调", 3, 5, -14, -18, -3, 4, -6, 4, 5],
        ["vintage", "复古暖片", -3, -2, -16, 18, 5, 8, -8, -12, 18],
        ["matte", "哑光黑金", -5, 16, -8, 10, 0, 13, -5, 18, 20],
        ["pastel", "柔和粉彩", 9, -13, -18, 5, 6, 7, -10, -18, 0],
        ["highkey", "明亮高调", 14, -8, -4, 4, 1, 8, 0, -10, 0],
        ["lowkey", "深邃低调", -13, 22, -8, -4, 2, -5, 4, 22, 24],
        ["amber", "琥珀微光", 3, 9, 8, 16, 2, 3, 6, 6, 7],
        ["rosy", "自然红润", 5, 5, 5, 4, 12, 4, 10, 4, 0],
        ["desert", "沙漠暖棕", -1, 13, -4, 19, -2, 2, 3, 12, 12],
        ["forest", "森林深绿", -4, 15, 2, -6, -10, -2, 9, 17, 15],
        ["ocean", "海盐蓝调", 2, 10, 4, -20, 2, 2, 8, 12, 8],
        ["night", "夜景蓝影", -8, 22, -10, -25, 3, -5, 4, 25, 24],
        ["steel", "都市钢灰", -2, 18, -24, -12, 0, 0, -5, 20, 12],
        ["cocoa", "可可肤调", 1, 10, -5, 11, 4, 4, 2, 8, 9],
        ["champagne", "香槟亮泽", 7, 5, -3, 13, 1, 5, 2, 2, 4],
        ["white", "洁净白皙", 10, 3, -8, -3, 2, 7, -2, 5, 0],
        ["contrast", "柔和对比", 2, 14, -2, 1, 0, 3, 4, 10, 6],
        ["black", "浓郁黑位", -5, 25, 2, 0, 0, -6, 8, 30, 18],
        ["fade", "褪色胶片", 4, -18, -15, 7, 1, 15, -12, -25, 8],
        ["sunset", "日落橘光", 1, 13, 15, 25, 5, 0, 12, 10, 12],
        ["fresh", "清新绿意", 6, 2, 9, -4, -8, 6, 12, 3, 0],
        ["silver", "银幕黑白", 1, 20, -100, 0, 0, 0, 0, 22, 18],
        ["crisp", "清晰质感", 2, 12, 3, 0, 0, 0, 8, 35, 5],
      ].map(([id, name, exposure, contrast, saturation, temperature, tint, gamma, vibrance, midtoneDetail, vignette]) => ({
        id, name, color: { exposure, contrast, saturation, temperature, tint, gamma, vibrance, midtoneDetail, vignette },
      }));
      const filterColorKeys = ["exposure", "contrast", "saturation", "temperature", "tint", "gamma", "vibrance", "midtoneDetail", "vignette"];
      function renderFilterPanel() {
        const selected = state.filterLook?.id || "none";
        $("filterGrid").innerHTML = filterLooks.map((look) =>
          `<button class="filter-card ${look.id === selected ? "active" : ""}" data-filter-look="${escapeHtml(look.id)}"><span class="filter-thumb" style="${filterPreviewCss(look)}"></span><span class="filter-name">${escapeHtml(look.name)}</span></button>`
        ).join("");
        const intensity = Math.round(Number(state.filterLook?.intensity ?? state.lut?.intensity ?? 1) * 100);
        $("filterIntensity").value = intensity;
        $("filterIntensityOut").textContent = `${intensity}%`;
        $("lutStatus").textContent = state.lut?.name ? `已载入：${state.lut.name}` : "支持 .cube、.3dl、.dat、.m3d、.csp。";
      }
      function filterPreviewCss(look) {
        const c = look.color || {};
        const brightness = clamp(1 + Number(c.exposure || 0) / 65 + Number(c.gamma || 0) / 160, .45, 1.65);
        const contrast = clamp(1 + Number(c.contrast || 0) / 70, .45, 1.75);
        const saturation = clamp(1 + Number(c.saturation || 0) / 65 + Number(c.vibrance || 0) / 110, 0, 2.1);
        const hue = Number(c.temperature || 0) * -.55 + Number(c.tint || 0) * .5;
        const sepia = clamp(Math.max(0, Number(c.temperature || 0)) / 65, 0, .38);
        return `filter:brightness(${brightness.toFixed(2)}) contrast(${contrast.toFixed(2)}) saturate(${saturation.toFixed(2)}) hue-rotate(${hue.toFixed(1)}deg) sepia(${sepia.toFixed(2)})`;
      }
      function applyFilterLook(id, intensity = Number(state.filterLook?.intensity ?? 1)) {
        const look = filterLooks.find((item) => item.id === id);
        if (!look) return;
        if (!state.filterLook?.baseColor || state.filterLook.id === "none")
          state.filterLook = { ...(state.filterLook || {}), baseColor: { ...state.color } };
        const base = state.filterLook.baseColor || {};
        state.filterLook = { id, intensity: clamp(intensity, 0, 1), baseColor: base };
        state.lut = null;
        for (const key of filterColorKeys)
          state.color[key] = Number(base[key] || 0) + Number(look.color[key] || 0) * state.filterLook.intensity;
        applyVideoCss();
        renderFilterPanel();
        queueAutosave();
      }
      let animationMode = "enter";
      const trackMeta = {
        review: { label: "待处理片段", className: "review", color: "#77797e" },
        caption: { label: "正确文案字幕", className: "caption", color: "#96989d" },
        text: { label: "标题文字", className: "text", color: "#85878c" },
        image: { label: "图片", className: "image", color: "#8d8f94" },
        video: { label: "视频", className: "video", color: "#74767b" },
        audio: { label: "音频", className: "audio", color: "#66686d" },
      };
      function trackInfo(id) {
        // 内建轨道（video/audio/caption 等）始终使用 trackMeta，
        // 防止 trackDefinitions 中缺少 kind 属性的条目覆盖
        if (trackMeta[id]) return { id, kind: id, ...trackMeta[id] };
        if (state.trackDefinitions?.[id]) {
          const def = state.trackDefinitions[id];
          return def.kind ? def : { ...def, kind: def.type || String(id || "").split("-")[0] };
        }
        const kind = String(id || "").split("-")[0];
        return {
          id,
          kind,
          label: trackMeta[kind]?.label || "轨道",
          className: trackMeta[kind]?.className || kind,
          color: trackMeta[kind]?.color || "#78818d",
          deletable: true,
        };
      }
      function renumberTrackLabels() {
        for (const kind of ["video", "audio"]) {
          const tracks = (state.trackOrder || []).filter((id) => trackInfo(id).kind === kind);
          tracks.forEach((id, index) => {
            if (id === kind || !state.trackDefinitions?.[id]) return;
            state.trackDefinitions[id].label = `${kind === "video" ? "视频" : "音频"} ${tracks.length - index}`;
          });
        }
      }
      function nextTrackNumber(kind) {
        const isVideoLike = (k) => ["video", "image", "text"].includes(k);
        if (isVideoLike(kind)) {
          let count = 1;
          for (const tid of state.trackOrder || []) {
            if (tid === "video") continue;
            const info = state.trackDefinitions?.[tid];
            if (info && isVideoLike(info.kind)) count++;
          }
          return count + 1;
        }
        if (kind === "audio") {
          let count = 1;
          for (const tid of state.trackOrder || []) {
            if (tid === "audio") continue;
            const info = state.trackDefinitions?.[tid];
            if (info && info.kind === "audio") count++;
          }
          return count + 1;
        }
        if (kind === "caption") {
          let count = 1;
          for (const tid of state.trackOrder || []) {
            if (tid === "caption") continue;
            const info = state.trackDefinitions?.[tid];
            if (info && info.kind === "caption") count++;
          }
          return count + 1;
        }
        return 2;
      }
      function createDynamicTrack(kind, label = "", before = "video") {
        const id = `${kind}-${uid()}`;
        const num = nextTrackNumber(kind);
        const standardLabel = kind === "audio" ? `音频 ${num}` : kind === "caption" ? `字幕 ${num}` : `视频 ${num}`;
        state.trackDefinitions[id] = {
          id,
          kind,
          label: standardLabel,
          className: trackMeta[kind]?.className || (kind === "image" || kind === "text" ? "video" : kind),
          color: trackMeta[kind]?.color || "#78818d",
          deletable: true,
        };
        const familyFirst = ["video", "audio"].includes(kind)
          ? state.trackOrder.find((id) => trackInfo(id).kind === kind)
          : "";
        const target = state.trackOrder.indexOf(familyFirst || before);
        state.trackOrder.splice(target >= 0 ? target : 0, 0, id);
        state.trackVisibility[id] = true;
        renumberTrackLabels();
        return id;
      }
      function ensureDynamicTracks() {
        state.trackDefinitions ||= {};
        state.trackVisibility ||= {};
        state.videoLayers ||= [];
        state.selectedItems ||= [];
        state.mainAudioClipSettings ||= {};
        // Resolve-style visual tracks contain video, still images and titles.
        // Migrate older image/text-only rows into the shared video-track family.
        for (const definition of Object.values(state.trackDefinitions)) {
          if (!definition || !["image", "text"].includes(definition.kind)) continue;
          definition.kind = "video";
          definition.className = trackMeta.video.className;
          definition.color = trackMeta.video.color;
          if (/^(图片|文字)(\s|$)/.test(String(definition.label || "")))
            definition.label = String(definition.label).replace(/^(图片|文字)/, "视频");
        }
        state.trackOrder = (state.trackOrder || []).filter(
          (id) => !["text", "image"].includes(id),
        );
        for (const [items, kind, label, before] of [
          [state.videoLayers, "video", "叠加视频", "video"],
          [state.images, "video", "图片", "video"],
          [state.titles, "video", "文字", "video"],
          [state.audioAssets, "audio", "音频", "audio"],
        ]) {
          for (const item of items || []) {
            if (!item.trackId || (!state.trackDefinitions[item.trackId] && !(item.trackId === kind && ["video", "audio"].includes(kind)))) {
              item.trackId = createDynamicTrack(
                kind,
                item.name || item.text || label,
                before,
              );
              state.trackVisibility[item.trackId] =
                state.trackVisibility[kind] !== false;
            }
          }
        }
        const importedCaptionTracks = new Map();
        for (const caption of state.captions || []) {
          if (!caption.trackId || caption.trackId === "caption") continue;
          if (!state.trackDefinitions[caption.trackId]) {
            const importedTrackId = caption.trackId;
            if (!importedCaptionTracks.has(importedTrackId))
              importedCaptionTracks.set(
                importedTrackId,
                createDynamicTrack("caption", "字幕文件", "caption"),
              );
            caption.trackId = importedCaptionTracks.get(importedTrackId);
            if (state.autoTranscript?.trackId === importedTrackId)
              state.autoTranscript.trackId = caption.trackId;
          }
        }
        state.trackOrder = [
          ...new Set([...(state.trackOrder || []), ...defaultTrackOrder]),
        ].filter((id) => trackMeta[id] || state.trackDefinitions[id]);
        const trackGroups = { other: [], video: [], audio: [] };
        for (const id of state.trackOrder) {
          const kind = trackInfo(id).kind;
          trackGroups[kind === "video" ? "video" : kind === "audio" ? "audio" : "other"].push(id);
        }
        state.trackOrder = [...trackGroups.other, ...trackGroups.video, ...trackGroups.audio];
        renumberTrackLabels();
        for (const id of state.trackOrder)
          if (!(id in state.trackVisibility)) state.trackVisibility[id] = true;
      }
      function trackItems(trackId) {
        const kind = trackInfo(trackId).kind;
        if (trackId === "review") return state.reviewCaptions;
        if (trackId === "caption")
          return state.captions.filter(
            (item) => !item.trackId || item.trackId === "caption",
          );
        if (trackId === "video")
          return [
            ...mainClips().filter((item) => !state.mainVideoTrackMap?.[item.id] || state.mainVideoTrackMap[item.id] === "video"),
            ...state.videoLayers.filter((item) => item.trackId === trackId),
            ...state.images.filter((item) => item.trackId === trackId),
            ...state.titles.filter((item) => item.trackId === trackId),
          ];
        if (trackId === "audio")
          return [
            ...mainAudioClips().filter((item) => !state.mainAudioTrackMap?.[item.id] || state.mainAudioTrackMap[item.id] === "audio"),
            ...state.audioAssets.filter((item) => item.trackId === trackId),
          ];
        const mappedMain = kind === "video"
          ? mainClips().filter((item) => state.mainVideoTrackMap?.[item.id] === trackId)
          : kind === "audio"
            ? mainAudioClips().filter((item) => state.mainAudioTrackMap?.[item.id] === trackId)
            : [];
        const source =
          kind === "video"
            ? [...state.videoLayers, ...state.images, ...state.titles]
            : kind === "audio"
              ? state.audioAssets
              : kind === "caption"
                ? state.captions
                : [];
        return [...mappedMain, ...source.filter((item) => item.trackId === trackId)];
      }
      function resolveTrackForInsert(
        kind,
        start,
        end,
        preferredTrackId = "",
        label = "",
        ignoredItemIds = [],
      ) {
        const ignored = new Set((ignoredItemIds || []).map(String));
        if (preferredTrackId && trackInfo(preferredTrackId).kind !== kind) preferredTrackId = "";
        if (preferredTrackId && isTrackLocked(preferredTrackId)) {
          toast("目标轨道已锁定，请先解锁后再放置素材。");
          return "";
        }
        const candidates = (state.trackOrder || []).filter(
          (id) => trackInfo(id).kind === kind && !isTrackLocked(id),
        );
        if (!candidates.includes(kind)) candidates.push(kind);
        const placement = { start: Number(start) || 0, end: Math.max(Number(start) || 0, Number(end) || 0) };
        const isFree = (trackId) => !trackItems(trackId).some(
          (item) => !ignored.has(String(item?.id || "")) && clipsOverlapOnTrack(item, placement),
        );
        if (preferredTrackId && isFree(preferredTrackId)) return preferredTrackId;
        // A requested row is a preference, not permission to stack two clips
        // invisibly on the same lane. Keep the edit non-destructive by finding
        // a free row of the same family before creating another one.
        const ordered = preferredTrackId
          ? [...candidates.filter((id) => id !== preferredTrackId), preferredTrackId]
          : [kind, ...candidates.filter((id) => id !== kind).reverse()];
        for (const trackId of ordered) {
          if (isTrackLocked(trackId)) continue;
          if (isFree(trackId)) {
            if (preferredTrackId && trackId !== preferredTrackId)
              toast(`目标轨道该时段已占用，素材已放到 ${trackBadgeText(trackId, trackInfo(trackId))}。`);
            return trackId;
          }
        }
        const created = createDynamicTrack(kind, label, kind === "audio" ? "audio" : kind);
        if (preferredTrackId)
          toast(`目标轨道该时段已占用，已新建 ${trackBadgeText(created, trackInfo(created))} 放置素材。`);
        return created;
      }
      function removeDynamicTrack(trackId) {
        const info = trackInfo(trackId);
        if (!info.deletable) return;
        snapshot();
        const keep = (item) => item.trackId !== trackId;
        if (info.kind === "video") {
          const removed = state.videoLayers.filter((item) => item.trackId === trackId);
          const linkedAudioIds = new Set(removed.map((item) => item.linkedAudioId).filter(Boolean));
          state.videoLayers = state.videoLayers.filter(keep);
          state.images = state.images.filter(keep);
          state.titles = state.titles.filter(keep);
          state.audioAssets = state.audioAssets.filter((item) => !linkedAudioIds.has(item.id));
        }
        if (info.kind === "audio") state.audioAssets = state.audioAssets.filter(keep);
        if (info.kind === "caption") {
          const removedCaptionIds = new Set(state.captions.filter((item) => item.trackId === trackId).map((item) => item.id));
          state.captions = state.captions.filter(keep);
          state.captionRecoveryArchive = (state.captionRecoveryArchive || []).filter((record) => !removedCaptionIds.has(record?.caption?.id));
          if (state.autoTranscript?.trackId === trackId) state.autoTranscript = null;
        }
        for (const [id, value] of Object.entries(state.mainVideoTrackMap || {}))
          if (value === trackId) delete state.mainVideoTrackMap[id];
        for (const [id, value] of Object.entries(state.mainAudioTrackMap || {}))
          if (value === trackId) delete state.mainAudioTrackMap[id];
        state.trackOrder = state.trackOrder.filter((id) => id !== trackId);
        renumberTrackLabels();
        delete state.trackDefinitions[trackId];
        delete state.trackVisibility[trackId];
        delete state.trackHeights?.[trackId];
        delete state.trackSolo?.[trackId];
        state.selectedItems = [];
        state.selected = { type: "video", id: "main" };
        cleanupEmptyDynamicTracks();
        recomputeContentDuration();
        renderAll();
      }
      const presets = [
        { name: "Kapwing · 逐词黄标", category: "Kapwing 动态", style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, color: "#ffffff", highlight: "#ffe34d", highlightEnabled: true, stroke: 5, strokeColor: "#111111", shadow: 3, shadowColor: "#000000", shadowOpacity: .82, shadowBlur: 3, shadowDistance: 3, backgroundEnabled: false, animation: "word-pop", animationDuration: .28 } },
        { name: "Kapwing · 弹跳白字", category: "Kapwing 动态", style: { fontFamily: "Arial Black", fontSize: 62, fontWeight: 900, color: "#ffffff", highlight: "#7de7ff", highlightEnabled: true, stroke: 6, strokeColor: "#151515", shadow: 3, shadowColor: "#000000", shadowOpacity: .85, shadowBlur: 3, shadowDistance: 4, backgroundEnabled: false, animation: "word-bounce", animationDuration: .32 } },
        { name: "Kapwing · 蓝色词卡", category: "Kapwing 动态", style: { fontFamily: "Segoe UI", fontSize: 54, fontWeight: 800, color: "#ffffff", highlight: "#5264f5", activeTextColor: "#ffffff", highlightEnabled: true, stroke: 0, shadow: 2, shadowColor: "#000000", shadowOpacity: .65, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: false, animation: "word-pill", animationDuration: .25 } },
        { name: "Kapwing · 逐词显现", category: "Kapwing 动态", style: { fontFamily: "Microsoft YaHei", fontSize: 56, fontWeight: 800, color: "#ffffff", highlightEnabled: false, stroke: 4, strokeColor: "#111111", shadow: 2, shadowColor: "#000000", shadowOpacity: .75, shadowBlur: 4, shadowDistance: 3, backgroundEnabled: false, animation: "typewriter", animationDuration: .24 } },
        { name: "Kapwing · 紫粉聚焦", category: "Kapwing 动态", style: { fontFamily: "Impact", fontSize: 66, fontWeight: 900, color: "#ee7ddb", highlight: "#ff8de6", highlightEnabled: true, stroke: 3, strokeColor: "#241127", shadow: 4, shadowColor: "#6e2867", shadowOpacity: .72, shadowBlur: 7, shadowDistance: 2, backgroundEnabled: false, animation: "word-focus", animationDuration: .3 } },
        { name: "Kapwing · 极简淡入", category: "Kapwing 动态", style: { fontFamily: "Helvetica", fontSize: 52, fontWeight: 700, color: "#ffffff", highlightEnabled: false, stroke: 0, shadow: 4, shadowColor: "#000000", shadowOpacity: .78, shadowBlur: 7, shadowDistance: 3, backgroundEnabled: true, background: "#101318", backgroundOpacity: .62, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 8, radius: 7, animation: "fade", animationDuration: .32 } },
        {
          name: "粗体黑边高亮",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 58,
            fontWeight: 900,
            color: "#ffffff",
            highlight: "#fff275",
            highlightEnabled: true,
            stroke: 5,
            strokeColor: "#111111",
            shadow: 0,
            backgroundEnabled: false,
            animation: "karaoke",
          },
        },
        {
          name: "圆角黑底胶囊",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 56,
            fontWeight: 800,
            color: "#ffffff",
            highlight: "#ffba19",
            highlightEnabled: true,
            stroke: 0,
            strokeColor: "#000000",
            shadow: 0,
            backgroundEnabled: true,
            background: "#131922",
            backgroundOpacity: 0.94,
            padding: 18,
            backgroundMode: "block",
            backgroundWidth: 26,
            backgroundHeight: 14,
            radius: 20,
            animation: "karaoke",
          },
        },
        {
          name: "综艺双层撞色",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 58,
            fontWeight: 900,
            color: "#ffe600",
            highlight: "#35f1ff",
            highlightEnabled: true,
            stroke: 5,
            strokeColor: "#1a1200",
            shadow: 3,
            shadowColor: "#000000",
            shadowOpacity: 0.9,
            shadowBlur: 2,
            shadowDistance: 3,
            shadowAngle: 45,
            backgroundEnabled: false,
            animation: "karaoke",
          },
        },
        {
          name: "极简白字投影",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 54,
            fontWeight: 800,
            color: "#ffffff",
            highlight: "#7eeaff",
            highlightEnabled: true,
            stroke: 0,
            strokeColor: "#000000",
            shadow: 4,
            shadowColor: "#000000",
            shadowOpacity: 0.85,
            shadowBlur: 6,
            shadowDistance: 4,
            shadowAngle: 45,
            backgroundEnabled: false,
            animation: "karaoke",
          },
        },
        {
          name: "小红书黑金质感",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 54,
            fontWeight: 800,
            color: "#1c1c1e",
            highlight: "#ffffff",
            highlightEnabled: true,
            stroke: 0,
            strokeColor: "#000000",
            shadow: 0,
            backgroundEnabled: true,
            background: "#f6d365",
            backgroundOpacity: 0.96,
            padding: 18,
            backgroundMode: "block",
            backgroundWidth: 24,
            backgroundHeight: 14,
            radius: 20,
            animation: "karaoke",
          },
        },
        {
          name: "荧光赛博霓虹",
          category: "主流爆款",
          style: {
            fontFamily: "Helvetica",
            fontSize: 56,
            fontWeight: 900,
            color: "#4df0ff",
            highlight: "#39ff88",
            highlightEnabled: true,
            stroke: 2,
            strokeColor: "#091724",
            shadow: 3,
            shadowColor: "#00f0ff",
            shadowOpacity: 0.6,
            shadowBlur: 8,
            shadowDistance: 2,
            backgroundEnabled: true,
            background: "#161026",
            backgroundOpacity: 0.90,
            padding: 18,
            backgroundMode: "block",
            backgroundWidth: 24,
            backgroundHeight: 14,
            radius: 18,
            animation: "karaoke",
          },
        },
        {
          name: "爆款黄黑冲击",
          category: "爆款字体",
          style: { fontFamily: "Impact", fontSize: 64, fontWeight: 900, color: "#ffd83d", highlight: "#ffffff", highlightEnabled: true, stroke: 6, strokeColor: "#111318", shadow: 3, shadowColor: "#000000", shadowOpacity: 0.82, shadowBlur: 2, shadowDistance: 4, backgroundEnabled: false, animation: "karaoke" },
        },
        {
          name: "知识口播蓝白",
          category: "爆款字体",
          style: { fontFamily: "Microsoft YaHei", fontSize: 56, fontWeight: 800, color: "#ffffff", highlight: "#5de2dc", highlightEnabled: true, stroke: 4, strokeColor: "#10242b", shadow: 2, shadowColor: "#000000", shadowOpacity: 0.7, shadowBlur: 4, shadowDistance: 3, backgroundEnabled: true, background: "#123743", backgroundOpacity: 0.86, backgroundMode: "line", backgroundWidth: 20, backgroundHeight: 10, radius: 12, animation: "karaoke" },
        },
        {
          name: "情绪重点红白",
          category: "爆款字体",
          style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, color: "#ffffff", highlight: "#ff756b", highlightEnabled: true, stroke: 5, strokeColor: "#251012", shadow: 3, shadowColor: "#000000", shadowOpacity: 0.82, shadowBlur: 3, shadowDistance: 4, backgroundEnabled: false, animation: "line-pulse" },
        },
        {
          name: "奶油卡片标题",
          category: "爆款字体",
          style: { fontFamily: "Microsoft YaHei", fontSize: 54, fontWeight: 800, color: "#3b2d28", highlight: "#d9514e", highlightEnabled: true, stroke: 0, strokeColor: "#000000", shadow: 1, shadowColor: "#8a5b4b", shadowOpacity: 0.32, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: true, background: "#fff0d6", backgroundOpacity: 0.96, backgroundMode: "block", backgroundWidth: 24, backgroundHeight: 14, radius: 18, animation: "fade" },
        },
        {
          name: "科技青光标题",
          category: "爆款字体",
          style: { fontFamily: "Segoe UI", fontSize: 58, fontWeight: 800, color: "#dffefa", highlight: "#48d8cf", highlightEnabled: true, stroke: 2, strokeColor: "#061f26", shadow: 5, shadowColor: "#1ac7c0", shadowOpacity: 0.7, shadowBlur: 10, shadowDistance: 1, glow: 8, glowColor: "#25c9c2", backgroundEnabled: true, background: "#071a20", backgroundOpacity: 0.88, backgroundMode: "block", backgroundWidth: 22, backgroundHeight: 12, radius: 8, animation: "karaoke" },
        },
        {
          name: "访谈极简白字",
          category: "爆款字体",
          style: { fontFamily: "Helvetica", fontSize: 52, fontWeight: 700, color: "#ffffff", highlight: "#ffffff", highlightEnabled: false, stroke: 2, strokeColor: "#111111", shadow: 3, shadowColor: "#000000", shadowOpacity: 0.78, shadowBlur: 5, shadowDistance: 3, backgroundEnabled: false, animation: "fade" },
        },
        {
          name: "国风楷体金边",
          category: "爆款字体",
          style: { fontFamily: "KaiTi", fontSize: 62, fontWeight: 700, color: "#fff4d2", highlight: "#f2bf63", highlightEnabled: true, stroke: 3, strokeColor: "#421f18", shadow: 4, shadowColor: "#120705", shadowOpacity: 0.86, shadowBlur: 5, shadowDistance: 4, backgroundEnabled: false, animation: "fade" },
        },
        {
          name: "电影感衬线字幕",
          category: "爆款字体",
          style: { fontFamily: "Times New Roman", fontSize: 54, fontWeight: 700, color: "#f7f1e7", highlight: "#e3c78d", highlightEnabled: false, stroke: 2, strokeColor: "#17191c", shadow: 4, shadowColor: "#000000", shadowOpacity: 0.84, shadowBlur: 6, shadowDistance: 4, backgroundEnabled: true, background: "#101215", backgroundOpacity: 0.56, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 8, radius: 4, animation: "fade" },
        },
        { name: "巨兽漫画粗描边", category: "热门创作者", style: { fontFamily: "Impact", fontSize: 68, fontWeight: 900, color: "#ffffff", highlight: "#ffe339", highlightEnabled: true, stroke: 7, strokeColor: "#080808", shadow: 3, shadowColor: "#000000", shadowOpacity: .9, shadowBlur: 2, shadowDistance: 4, backgroundEnabled: false, animation: "line-pulse" } },
        { name: "逐字卡拉OK", category: "热门创作者", style: { fontFamily: "Arial Black", fontSize: 58, fontWeight: 900, color: "#ffffff", highlight: "#37ef75", highlightEnabled: true, stroke: 5, strokeColor: "#111111", shadow: 2, shadowColor: "#000000", shadowOpacity: .8, shadowBlur: 3, shadowDistance: 3, backgroundEnabled: false, animation: "karaoke" } },
        { name: "深潜蓝绿", category: "热门创作者", style: { fontFamily: "Montserrat", fontSize: 56, fontWeight: 800, color: "#e9ffff", highlight: "#41e6cf", highlightEnabled: true, stroke: 4, strokeColor: "#072a35", shadow: 4, shadowColor: "#001319", shadowOpacity: .85, shadowBlur: 7, shadowDistance: 3, backgroundEnabled: true, background: "#073745", backgroundOpacity: .78, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 9, radius: 10, animation: "karaoke" } },
        { name: "创作者黄标", category: "热门创作者", style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, color: "#ffffff", highlight: "#ffd528", highlightEnabled: true, stroke: 5, strokeColor: "#161616", shadow: 3, shadowColor: "#000000", shadowOpacity: .8, shadowBlur: 4, shadowDistance: 4, backgroundEnabled: false, animation: "line-pulse" } },
        { name: "播客白黑块", category: "播客访谈", style: { fontFamily: "Helvetica", fontSize: 54, fontWeight: 800, color: "#111111", highlight: "#ffffff", highlightEnabled: true, stroke: 0, strokeColor: "#000000", shadow: 0, backgroundEnabled: true, background: "#ffffff", backgroundOpacity: .94, backgroundMode: "line", backgroundWidth: 20, backgroundHeight: 10, radius: 6, animation: "fade" } },
        { name: "播客暖橙重点", category: "播客访谈", style: { fontFamily: "Microsoft YaHei", fontSize: 54, fontWeight: 800, color: "#ffffff", highlight: "#ff8a3d", highlightEnabled: true, stroke: 4, strokeColor: "#24160d", shadow: 3, shadowColor: "#000000", shadowOpacity: .8, shadowBlur: 4, shadowDistance: 3, backgroundEnabled: false, animation: "karaoke" } },
        { name: "绿色关键词", category: "热门创作者", style: { fontFamily: "Montserrat", fontSize: 58, fontWeight: 900, color: "#ffffff", highlight: "#53ed83", highlightEnabled: true, stroke: 5, strokeColor: "#101814", shadow: 2, shadowColor: "#000000", shadowOpacity: .75, shadowBlur: 4, shadowDistance: 3, backgroundEnabled: false, animation: "karaoke" } },
        { name: "弹跳粉紫重点", category: "娱乐综艺", style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, color: "#ffffff", highlight: "#ff72d0", highlightEnabled: true, stroke: 5, strokeColor: "#24132b", shadow: 4, shadowColor: "#7a2e86", shadowOpacity: .7, shadowBlur: 8, shadowDistance: 2, backgroundEnabled: false, animation: "line-pulse" } },
        { name: "综艺蓝黄撞色", category: "娱乐综艺", style: { fontFamily: "Microsoft YaHei", fontSize: 62, fontWeight: 900, color: "#48c8ff", highlight: "#ffe45a", highlightEnabled: true, stroke: 6, strokeColor: "#101a29", shadow: 3, shadowColor: "#000000", shadowOpacity: .85, shadowBlur: 3, shadowDistance: 4, backgroundEnabled: false, animation: "line-pulse" } },
        { name: "极简无描边", category: "简洁专业", style: { fontFamily: "Segoe UI", fontSize: 50, fontWeight: 600, color: "#ffffff", highlight: "#ffffff", highlightEnabled: false, stroke: 0, strokeColor: "#000000", shadow: 4, shadowColor: "#000000", shadowOpacity: .72, shadowBlur: 7, shadowDistance: 3, backgroundEnabled: false, animation: "fade" } },
        { name: "极简半透明底", category: "简洁专业", style: { fontFamily: "Helvetica", fontSize: 50, fontWeight: 700, color: "#ffffff", highlight: "#ffffff", highlightEnabled: false, stroke: 0, strokeColor: "#000000", shadow: 0, backgroundEnabled: true, background: "#000000", backgroundOpacity: .58, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 8, radius: 5, animation: "fade" } },
        { name: "知识媒体蓝", category: "知识教育", style: { fontFamily: "Microsoft YaHei", fontSize: 55, fontWeight: 800, color: "#ffffff", highlight: "#5ab6ff", highlightEnabled: true, stroke: 4, strokeColor: "#102235", shadow: 2, shadowColor: "#000000", shadowOpacity: .72, shadowBlur: 4, shadowDistance: 3, backgroundEnabled: false, animation: "karaoke" } },
        { name: "知识重点红框", category: "知识教育", style: { fontFamily: "Arial Black", fontSize: 56, fontWeight: 900, color: "#ffffff", highlight: "#ff5a5a", highlightEnabled: true, stroke: 5, strokeColor: "#201010", shadow: 2, shadowColor: "#000000", shadowOpacity: .75, shadowBlur: 3, shadowDistance: 3, backgroundEnabled: true, background: "#281313", backgroundOpacity: .72, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 9, radius: 8, animation: "line-pulse" } },
        { name: "新闻下三分之一", category: "简洁专业", style: { fontFamily: "Microsoft YaHei", fontSize: 48, fontWeight: 700, color: "#ffffff", highlight: "#f0f0f0", highlightEnabled: false, stroke: 0, strokeColor: "#000000", shadow: 0, backgroundEnabled: true, background: "#161b22", backgroundOpacity: .92, backgroundMode: "block", backgroundWidth: 28, backgroundHeight: 10, radius: 0, animation: "fade" } },
        { name: "动感青黄逐字", category: "娱乐综艺", style: { fontFamily: "Impact", fontSize: 62, fontWeight: 900, color: "#46e6ed", highlight: "#fff34c", highlightEnabled: true, stroke: 5, strokeColor: "#102124", shadow: 4, shadowColor: "#00838a", shadowOpacity: .68, shadowBlur: 7, shadowDistance: 2, backgroundEnabled: false, animation: "karaoke" } },
        { name: "电影白字黑带", category: "影视叙事", style: { fontFamily: "Arial", fontSize: 48, fontWeight: 700, color: "#f8f8f8", highlight: "#f8f8f8", highlightEnabled: false, stroke: 1, strokeColor: "#000000", shadow: 2, shadowColor: "#000000", shadowOpacity: .8, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: true, background: "#000000", backgroundOpacity: .7, backgroundMode: "block", backgroundWidth: 26, backgroundHeight: 8, radius: 0, animation: "fade" } },
        { name: "标题爆炸黄字", category: "强冲击标题", style: { fontFamily: "Impact", fontSize: 76, fontWeight: 900, color: "#ffe928", highlight: "#ffffff", highlightEnabled: true, stroke: 8, strokeColor: "#0b0b0b", shadow: 5, shadowColor: "#e43b26", shadowOpacity: .9, shadowBlur: 2, shadowDistance: 6, backgroundEnabled: false, animation: "line-pulse" } },
        { name: "白字红底标签", category: "强冲击标题", style: { fontFamily: "Arial Black", fontSize: 58, fontWeight: 900, color: "#ffffff", highlight: "#ffe868", highlightEnabled: true, stroke: 0, strokeColor: "#000000", shadow: 0, backgroundEnabled: true, background: "#e1282d", backgroundOpacity: .96, backgroundMode: "block", backgroundWidth: 24, backgroundHeight: 12, radius: 5, animation: "line-pulse" } },
        { name: "双层描边漫画", category: "强冲击标题", style: { fontFamily: "Arial Black", fontSize: 66, fontWeight: 900, color: "#ffffff", highlight: "#66e3ff", highlightEnabled: true, stroke: 8, strokeColor: "#151515", shadow: 5, shadowColor: "#ffffff", shadowOpacity: .75, shadowBlur: 0, shadowDistance: 2, backgroundEnabled: false, animation: "karaoke" } },
        { name: "生活方式奶白", category: "生活方式", style: { fontFamily: "Microsoft YaHei", fontSize: 50, fontWeight: 700, color: "#fffaf1", highlight: "#e9b5a7", highlightEnabled: true, stroke: 2, strokeColor: "#6e5550", shadow: 3, shadowColor: "#2a1f1c", shadowOpacity: .48, shadowBlur: 6, shadowDistance: 3, backgroundEnabled: false, animation: "fade" } },
        { name: "清新薄荷卡片", category: "生活方式", style: { fontFamily: "Segoe UI", fontSize: 50, fontWeight: 750, color: "#173a35", highlight: "#ffffff", highlightEnabled: true, stroke: 0, strokeColor: "#000000", shadow: 1, shadowColor: "#18483f", shadowOpacity: .24, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: true, background: "#bff3df", backgroundOpacity: .94, backgroundMode: "line", backgroundWidth: 20, backgroundHeight: 10, radius: 16, animation: "fade" } },
        { name: "财经金黑标题", category: "商业财经", style: { fontFamily: "Times New Roman", fontSize: 60, fontWeight: 900, color: "#f4cf67", highlight: "#ffffff", highlightEnabled: true, stroke: 4, strokeColor: "#17130a", shadow: 4, shadowColor: "#000000", shadowOpacity: .85, shadowBlur: 6, shadowDistance: 4, backgroundEnabled: true, background: "#111111", backgroundOpacity: .82, backgroundMode: "block", backgroundWidth: 24, backgroundHeight: 10, radius: 3, animation: "fade" } },
        { name: "商业蓝白数据", category: "商业财经", style: { fontFamily: "Arial", fontSize: 54, fontWeight: 800, color: "#ffffff", highlight: "#55b8ff", highlightEnabled: true, stroke: 3, strokeColor: "#0b2440", shadow: 2, shadowColor: "#000000", shadowOpacity: .65, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: true, background: "#102a46", backgroundOpacity: .86, backgroundMode: "line", backgroundWidth: 18, backgroundHeight: 8, radius: 5, animation: "karaoke" } },
        { name: "游戏紫蓝霓虹", category: "游戏科技", style: { fontFamily: "Arial Black", fontSize: 62, fontWeight: 900, color: "#8ff7ff", highlight: "#ff77ee", highlightEnabled: true, stroke: 4, strokeColor: "#170b2e", shadow: 6, shadowColor: "#8a43ff", shadowOpacity: .85, shadowBlur: 10, shadowDistance: 1, glow: 9, glowColor: "#5e35ff", backgroundEnabled: false, animation: "line-pulse" } },
        { name: "电竞红黑警报", category: "游戏科技", style: { fontFamily: "Impact", fontSize: 68, fontWeight: 900, color: "#ffffff", highlight: "#ff3d47", highlightEnabled: true, stroke: 7, strokeColor: "#120506", shadow: 4, shadowColor: "#ff1d2d", shadowOpacity: .72, shadowBlur: 8, shadowDistance: 2, backgroundEnabled: false, animation: "karaoke" } },
        { name: "纪录片细白字", category: "影视叙事", style: { fontFamily: "Times New Roman", fontSize: 46, fontWeight: 500, color: "#f4f2ed", highlight: "#f4f2ed", highlightEnabled: false, stroke: 1, strokeColor: "#161616", shadow: 4, shadowColor: "#000000", shadowOpacity: .78, shadowBlur: 7, shadowDistance: 3, backgroundEnabled: false, animation: "fade" } },
        { name: "悬疑红色关键词", category: "影视叙事", style: { fontFamily: "Microsoft YaHei", fontSize: 54, fontWeight: 800, color: "#e8e8e8", highlight: "#d8323d", highlightEnabled: true, stroke: 4, strokeColor: "#101010", shadow: 5, shadowColor: "#000000", shadowOpacity: .9, shadowBlur: 8, shadowDistance: 3, backgroundEnabled: false, animation: "karaoke" } },
        { name: "儿童彩糖卡片", category: "娱乐综艺", style: { fontFamily: "Microsoft YaHei", fontSize: 60, fontWeight: 900, color: "#ffffff", highlight: "#ffe35a", highlightEnabled: true, stroke: 5, strokeColor: "#5a3180", shadow: 4, shadowColor: "#2d1740", shadowOpacity: .7, shadowBlur: 4, shadowDistance: 4, backgroundEnabled: true, background: "#ed6eb2", backgroundOpacity: .88, backgroundMode: "block", backgroundWidth: 24, backgroundHeight: 12, radius: 22, animation: "line-pulse" } },
        { name: "参考字幕 · 夫妻口播白字黑边", category: "参考视频效果", style: { fontFamily: "Arial Black", fontSize: 70, fontWeight: 900, textCase: "upper", color: "#ffffff", highlight: "#ffffff", highlightEnabled: false, highlightScale: 1, stroke: 4, strokeColor: "#080808", shadow: 0, backgroundEnabled: false, animation: "fade", captionYRatio: 0.60, captionLines: 2 } },
        { name: "参考字幕 · 赛事荧光绿重点", category: "参考视频效果", style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, textCase: "upper", color: "#ffffff", highlight: "#39f21d", highlightEnabled: true, highlightScale: 1.14, keywordMode: true, stroke: 4, strokeColor: "#080808", shadow: 0, backgroundEnabled: false, animation: "fade", captionYRatio: 0.29, captionLines: 2 } },
        { name: "参考字幕 · 活动亮黄重点", category: "参考视频效果", style: { fontFamily: "Arial Black", fontSize: 60, fontWeight: 900, textCase: "upper", color: "#ffffff", highlight: "#ffe52b", highlightEnabled: true, highlightScale: 1.14, keywordMode: true, stroke: 4, strokeColor: "#080808", shadow: 0, backgroundEnabled: false, animation: "fade", captionYRatio: 0.29, captionLines: 2 } },
        { name: "参考字幕 · 祷告白字轻影", category: "参考视频效果", style: { fontFamily: "Arial", fontSize: 52, fontWeight: 600, textCase: "none", color: "#ffffff", highlight: "#ffffff", highlightEnabled: false, highlightScale: 1, stroke: 0, strokeColor: "#000000", shadow: 2, shadowColor: "#000000", shadowOpacity: .64, shadowBlur: 4, shadowDistance: 2, backgroundEnabled: false, animation: "fade", captionYRatio: 0.82, captionLines: 2 } },
      ];
      presets.sort((left, right) => Number(right.category === "参考视频效果") - Number(left.category === "参考视频效果"));
      const captionAnimations = [
        ["卡拉OK高亮", "karaoke"],
        ["逐词显现", "typewriter"],
        ["单词聚焦", "word-focus"],
        ["跟读词卡", "word-pill"],
        ["逐词弹出", "word-pop"],
        ["逐词弹跳", "word-bounce"],
        ["逐词上浮", "word-lift"],
        ["淡入变色", "fade"],
        ["逐行跳动", "line-pulse"],
        ["整句上移", "rise"],
        ["左侧滑入", "slide-left"],
        ["右侧滑入", "slide-right"],
        ["整句放大", "zoom"],
      ];
      let customPresets = [];
      function unwrap(result) {
        if (!result?.ok) throw new Error(result?.error?.message || "操作失败");
        return result.value;
      }
      function toast(text) {
        $("toast").textContent = text;
        $("toast").classList.add("on");
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => $("toast").classList.remove("on"), 2200);
      }
      function formatTime(seconds) {
        const total = Math.round(Math.max(0, Number(seconds) || 0));
        return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      }
      function uid() {
        return globalThis.crypto &&
          typeof globalThis.crypto.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
      }
      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }
      function hideContextMenu() {
        const menu = $("contextMenu");
        menu.classList.remove("on");
        menu.replaceChildren();
      }
      function showContextMenu(event, items) {
        event.preventDefault();
        event.stopPropagation();
        const menu = $("contextMenu");
        menu.replaceChildren();
        for (const item of items.filter(Boolean)) {
          const button = document.createElement("button");
          button.textContent = item.label;
          button.classList.toggle("danger", !!item.danger);
          button.onclick = async () => {
            hideContextMenu();
            try { await item.action(); } catch (error) { toast(error.message); }
          };
          menu.append(button);
        }
        menu.classList.add("on");
        const width = menu.offsetWidth,
          height = menu.offsetHeight;
        menu.style.left = `${clamp(event.clientX, 8, innerWidth - width - 8)}px`;
        menu.style.top = `${clamp(event.clientY, 8, innerHeight - height - 8)}px`;
      }
      let bridgePromise = null,
        autosaveTimer = null,
        autosaveRunning = null,
        confirmAction = null,
        renameProjectResolve = null;
      function showFatal(message) {
        const box = $("fatal");
        box.textContent = `剪辑助手启动异常：${message}\n请重新打开软件；如果仍然出现，请把这条提示截图发给我。`;
        box.classList.add("on");
      }
      function askConfirm(message, action, title = "请确认") {
        $('confirmAccept').textContent = '确认';
        $("confirmTitle").textContent = title;
        $("confirmMessage").textContent = message;
        confirmAction = action;
        $("confirmModal").classList.add("on");
        $("confirmAccept").focus();
      }
      function closeConfirm() {
        confirmAction = null;
        $("confirmModal").classList.remove("on");
      }
      function openRenameProjectDialog(currentName = "未命名工程", options = {}) {
        const modal = $("renameProjectModal");
        const input = $("renameProjectName");
        if (!modal || !input) return Promise.resolve(null);
        if (renameProjectResolve) {
          const previous = renameProjectResolve;
          renameProjectResolve = null;
          previous(null);
        }
        const title = $("renameProjectTitle");
        const label = $("renameProjectLabel");
        const maxLength = Number.isFinite(Number(options.maxLength))
          ? Math.max(1, Math.min(2000, Number(options.maxLength)))
          : 80;
        if (title) title.textContent = options.title || "修改工程名称";
        if (label) label.textContent = options.label || "工程名称";
        input.maxLength = maxLength;
        input.value = String(currentName ?? (maxLength > 80 ? "" : "未命名工程")).slice(0, maxLength);
        modal.classList.add("on");
        requestAnimationFrame(() => {
          input.focus({ preventScroll: true });
          input.select();
        });
        return new Promise((resolve) => { renameProjectResolve = resolve; });
      }
      function closeRenameProjectDialog(value = null) {
        $("renameProjectModal")?.classList.remove("on");
        const input = $("renameProjectName");
        if (input) input.maxLength = 80;
        const resolve = renameProjectResolve;
        renameProjectResolve = null;
        resolve?.(value);
      }
      window.addEventListener("error", (event) =>
        showFatal(event.message || "界面脚本运行失败"),
      );
      window.addEventListener("unhandledrejection", (event) =>
        showFatal(event.reason?.message || String(event.reason || "未知错误")),
      );
      async function waitNative(timeout = 6000) {
        if (bridgePromise) return bridgePromise;
        bridgePromise = (async () => {
          const started = Date.now();
          while (!window.native || typeof window.native.ping !== "function") {
            if (Date.now() - started > timeout)
              throw new Error("本机功能连接超时");
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          unwrap(await window.native.ping());
          return window.native;
        })();
        return bridgePromise;
      }
      async function nativeCall(name, ...args) {
        const bridge = await waitNative();
        if (typeof bridge[name] !== "function")
          throw new Error(`本机功能 ${name} 未加载`);
        return unwrap(await bridge[name](...args));
      }
      function openNewProjectModal() {
        const modal = $("newProjectModal");
        $("newProjectRatio").value = "9:16";
        modal.classList.add("on");
        requestAnimationFrame(() => {
          const name = $("newProjectName");
          name.focus({ preventScroll: true });
          name.select();
        });
      }
      function closeNewProjectModal() {
        $("newProjectModal").classList.remove("on");
      }
      function projectDate(value) {
        try {
          return new Intl.DateTimeFormat("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(value));
        } catch {
          return "刚刚";
        }
      }
      function projectDayKey(value) {
        const date = new Date(value || Date.now());
        if (!Number.isFinite(date.getTime())) return "未知日期";
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        const todayKey = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
        const yesterdayKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
        if (key === todayKey) return "今天";
        if (key === yesterdayKey) return "昨天";
        return new Intl.DateTimeFormat("zh-CN", {
          year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
          month: "long",
          day: "numeric",
          weekday: "short",
        }).format(date);
      }
      let homeSelectionMode = false, homeBusy = false, homeCacheBusy = false, homeOffset = 0, homeTotal = 0, homeRequest = 0, homeRenderRequest = 0, homeIndexTimer;
      const homeSelected = new Map();
      function homeQuery() {
        return { period: $('homePeriod').value, before: $('homeBefore').value,
          search: $('homeSearch').value, selection: homeSelectionMode, offset: homeOffset, limit: 40,
          workspaceMode: "all" };
      }
      function updateHomeSelection() {
        $('homeSelection').hidden = !homeSelectionMode;
        $('homeSelectedCount').textContent = `已选择 ${homeSelected.size} 个工程`;
        $('homeDeleteSelected').disabled = homeBusy || !homeSelected.size;
        for (const id of ['homePeriod','homeBefore','homeSearch','homeSelectAll','homeSelectNone','homeCancelSelection','homeBatchDelete','homeCleanCache','homeNewProject','homePrevious','homeNext']) $(id).disabled = homeBusy;
        $('homeNewProject').disabled = homeBusy || homeSelectionMode;
        $('homeEmptyNew').disabled = homeBusy || homeSelectionMode;
        $('homeCleanCache').disabled = homeBusy || homeCacheBusy;
        document.querySelectorAll('[data-select-project]').forEach(box => { box.checked = homeSelected.has(box.dataset.selectProject); box.disabled = homeBusy; });
      }
      function renderProjectHome(items = []) {
        const renderRequest = ++homeRenderRequest;
        const query = $("homeSearch").value.trim().toLowerCase();
        const filtered = items.filter(
          (item) =>
            !query ||
            String(item.name || "")
              .toLowerCase()
              .includes(query),
        );
        const groups = new Map();
        for (const item of filtered) {
          const day = projectDayKey(item.updatedAt || item.createdAt);
          if (!groups.has(day)) groups.set(day, []);
          groups.get(day).push(item);
        }
        const grid = $("homeProjectGrid");
        const fragment = document.createDocumentFragment();
        const template = document.createElement("template");
        for (const [day, projects] of groups.entries()) {
          template.innerHTML = `<section class="projectday"><div class="projectdayhead"><span>📁 ${escapeHtml(day)}</span><span class="small">${projects.length} 个工程</span></div><div class="projectdaygrid">${projects.map(
            (item) =>
            `<div class="projectcard" data-project-id="${item.id}" tabindex="0">${homeSelectionMode ? `<input type="checkbox" data-select-project="${item.id}" aria-label="选择 ${escapeHtml(item.name)}" style="position:absolute;top:10px;left:10px;z-index:3;width:18px;height:18px;accent-color:#df6666">` : `<button type="button" class="projectrename" data-rename-project="${item.id}" title="重命名工程" aria-label="重命名工程">✎</button><button type="button" class="projectdelete" data-delete-project="${item.id}" title="删除工程" aria-label="删除工程">×</button>`}<div class="projectthumb">${item.thumbnailUrl ? `<img loading="lazy" decoding="async" src="${escapeHtml(item.thumbnailUrl)}" alt="工程预览" data-hide-on-error>` : escapeHtml(item.ratio || "9:16")}</div><b class="ellipsis" title="${escapeHtml(item.name || "未命名工程")}">${escapeHtml(item.name || "未命名工程")}</b><div class="projectmeta ellipsis">${escapeHtml(item.videoName || "尚未导入视频")}</div><div class="projectmeta">更新于 ${projectDate(item.updatedAt)}</div></div>`,
          ).join("")}</div></section>`;
          fragment.appendChild(template.content.firstElementChild);
        }
        if (renderRequest !== homeRenderRequest) return;
        grid.replaceChildren(fragment);
        grid.style.display = filtered.length ? "grid" : "none";
        $("homeEmpty").classList.toggle("on", !filtered.length);
        updateHomeSelection();
      }
      async function refreshHome() {
        clearTimeout(homeIndexTimer);
        const request = ++homeRequest;
        $('homeCount').textContent = '正在加载工程…';
        try {
          const result = await nativeCall("queryProjects", homeQuery());
          if (request !== homeRequest) return;
          homeTotal = result.total;
          if (homeOffset >= homeTotal && homeOffset > 0) { homeOffset = Math.max(0,Math.ceil(homeTotal / 40)-1)*40; return refreshHome(); }
          window.__projectItems = result.items || [];
          renderProjectHome(window.__projectItems);
          $('homeCount').textContent = `共 ${homeTotal} 个工程 · 按最后修改时间`;
          if (result.indexing) {
            $('homeCount').textContent += ' · 正在后台建立旧工程索引';
            $('homeSelectAll').disabled = true;
            homeIndexTimer = setTimeout(() => { if (!homeBusy && !state.editorActive) refreshHome(); },1500);
          }
          $('homePages').style.display = homeTotal > 40 ? 'flex' : 'none';
          $('homePageLabel').textContent = `${Math.floor(homeOffset/40)+1} / ${Math.max(1,Math.ceil(homeTotal/40))}`;
          $('homePrevious').disabled = homeBusy || homeOffset === 0;
          $('homeNext').disabled = homeBusy || homeOffset+40 >= homeTotal;
        } catch (error) {
          $('homeCount').textContent = '加载失败，请切换日期重试';
          toast(error.message);
        }
      }
      let projectSessionRevision = 0;
      function resetEditorState() {
        projectSessionRevision += 1;
        Object.assign(state, {
          video: null,
          videoLayers: [],
          libraryAssets: [],
          hiddenLibraryPaths: [],
          audioAssets: [],
          images: [],
          titles: [],
          captions: [],
          autoTranscript: null,
        recognizedText: "", recognizedTextCleared: false,
          captionRecoveryArchive: [],
          auxSubtitles: defaultAuxSubtitleSettings(),
          reviewCaptions: [],
          issues: [],
          matchIssues: [],
          alignmentOperations: [],
          alignmentDuration: 0,
          removals: [],
          manualCuts: [],
          audioMutes: [],
          audioCuts: [],
          mainAudioRemovals: [],
          mainAudioManualCuts: [],
          waveform: [],
          duration: 0,
          timelineDuration: 60,
          sourceDuration: 0,
          mainTimelineOffset: 0,
          mainAudioTimelineOffset: 0,
          mainVideoClipOffsets: {},
          mainAudioClipOffsets: {},
          currentTime: 0,
          playbackSpeed: 1.0,
          followPlayhead: true,
          timelineEditMode: "overwrite",
          timelineZoomAnchor: "playhead",
          zoom: 60,
          canvasZoom: 1,
          selected: { type: "video", id: "main" },
          selectedItems: [],
          compoundClips: [],
          videoTransform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blendMode: "normal" },
          mainVideoClipSettings: {},
          captionTransform: { x: 0, y: 538, scale: 1, width: 860 },
          trackOrder: [...defaultTrackOrder],
          trackDefinitions: {},
          spliceLayout: "free",
          spliceRegions: [],
          spliceRatio: 0.5,
          spliceAngle: 0,
          spliceSelectedRegionId: "",
          spliceMainRegionId: "",
          mainVideoTrackMap: {},
          mainAudioTrackMap: {},
          trackVisibility: Object.fromEntries(
            defaultTrackOrder.map((key) => [key, true]),
          ),
          trackLocks: {},
          trackHeights: {},
          trackSolo: {},
          trackMute: {},
          trackAutoSelect: {},
          trackSyncLocks: {},
          avLinked: true,
          snapping: true,
          selectionFollowsPlayhead: false,
          timelineMarkers: [],
          captionLines: 1,
          captionStyle: {
            fontFamily: "Helvetica",
            fontSize: 58,
            fontWeight: 800,
            fontItalic: false,
            fontUnderline: false,
            textCase: "none",
          letterSpacing: 0,
          wordSpacing: 0,
          lineHeight: 1.15,
          textAlign: "center",
          verticalAlign: "middle",
            color: "#ffffff",
            stroke: 3,
            strokeColor: "#000000",
            shadow: 3,
            shadowColor: "#000000",
            shadowOpacity: 0.8,
            shadowBlur: 4,
            shadowDistance: 3,
            shadowAngle: 45,
            glow: 0,
            backgroundEnabled: false,
            background: "#000000",
            backgroundOpacity: 0.7,
            padding: 14,
            backgroundMode: "block",
            backgroundWidth: 14,
            backgroundHeight: 14,
            backgroundX: 0,
            backgroundY: 0,
            radius: 12,
          },
          color: {
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
          },
          denoise: defaultDenoiseSettings(),
          denoiseEnabled: false,
          denoisedAudio: null,
          audioFxRack: [],
          audioFxBypass: false,
          audioFxScope: "track",
          beauty: {
            smoothing: 0,
            blemish: 0,
            texture: 0,
            whitening: 0,
            brighten: 0,
            warmth: 0,
            rosy: 0,
          },
          blemishMarks: [],
          blemishFaceRegion: null,
          audio: {
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
          },
          audioProcessingEnabled: false,
          mainAudioClipSettings: {},
          undo: [],
          redo: [],
          projectCoverPath: "",
          playing: false,
          colorBypass: false,
          beautyBypass: true,
          filterLook: { id: "none", intensity: 1, baseColor: null },
          lut: null,
          exportJobId: state.exportJobId || "",
          exportBackend: state.exportBackend || "",
          exportProjectId: state.exportProjectId || "",
          layout: defaultStartupLayout(),
        });
        $("video").removeAttribute("src");
        $("video").load?.();
        $("stage").classList.add("empty");
        $("scriptText").value = "";
        state.legacyAutoCaptionScript = "";
        if ($("playbackSpeedBtn")) {
          $("playbackSpeedBtn").textContent = "1.0×";
          $("playbackSpeedBtn").classList.remove("speed-boosted");
        }
        if ($("playbackSpeedSelect")) {
          $("playbackSpeedSelect").value = "1";
        }
      }
      function currentProjectSessionRevision() { return projectSessionRevision; }
      function promoteSoloTimelineVideoToMainSource() {
        if (state.video?.path) return false;
        const clips = (state.videoLayers || []).filter(item => item?.path && !item.missing);
        if (clips.length !== 1) return false;
        const clip = clips[0];
        const sourceDuration = Number(clip.sourceDuration || clip.duration || 0);
        const speed = Math.max(0.05, Number(state.audio?.speed || 1));
        const tolerance = Math.max(0.08, 2 / Math.max(1, Number(state.timelineFrameRate || state.fps || 30)));
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 ||
            Math.abs(Number(clip.start || 0)) > tolerance ||
            Math.abs(Number(clip.sourceStart || 0)) > tolerance ||
            Math.abs(Number(clip.sourceEnd ?? sourceDuration) - sourceDuration) > tolerance ||
            Math.abs(Number(clip.end || 0) - sourceDuration / speed) > tolerance / speed ||
            clip.spliceRegionId || (state.removals || []).length || (state.manualCuts || []).length ||
            (state.mainAudioRemovals || []).length || (state.mainAudioManualCuts || []).length ||
            (state.audioCuts || []).length) return false;

        const pairedAudioAssets = (state.audioAssets || []).filter(item =>
          item.path === clip.path && (item.id === clip.linkedAudioId || item.linkedVideoId === clip.id ||
            (clip.linkGroupId && item.linkGroupId === clip.linkGroupId)));
        if (pairedAudioAssets.length > 1) return false;
        const pairedAudio = pairedAudioAssets[0] || null;
        if (pairedAudio && (
            Math.abs(Number(pairedAudio.start || 0) - Number(clip.start || 0)) > tolerance ||
            Math.abs(Number(pairedAudio.end || 0) - Number(clip.end || 0)) > tolerance ||
            Math.abs(Number(pairedAudio.sourceStart || 0) - Number(clip.sourceStart || 0)) > tolerance ||
            Math.abs(Number(pairedAudio.sourceEnd ?? sourceDuration) - sourceDuration) > tolerance ||
            pairedAudio.missing)) return false;

        const previousVideoTrack = clip.trackId || "video";
        const previousAudioTrack = pairedAudio?.trackId || "audio";
        state.video = { ...clip, kind: "video" };
        state.sourceDuration = sourceDuration;
        state.duration = sourceDuration / speed;
        state.timelineDuration = Math.max(Number(state.timelineDuration || 0), state.duration + 10);
        state.waveform = pairedAudio?.waveform?.length ? pairedAudio.waveform : (clip.waveform || state.waveform || []);
        state.videoTransform = {
          ...(state.videoTransform || {}),
          x: Number(clip.x || 0), y: Number(clip.y || 0),
          scale: Number(clip.scale || 1), rotation: Number(clip.rotation || 0),
          opacity: Number(clip.opacity ?? 1), blendMode: clip.blendMode || "normal",
        };
        state.videoLayers = (state.videoLayers || []).filter(item => item.id !== clip.id);
        if (pairedAudio) state.audioAssets = (state.audioAssets || []).filter(item => item.id !== pairedAudio.id);

        const mainVideoClip = (mainClips() || []).find(item =>
          Number(item.sourceStart || 0) <= Number(clip.sourceStart || 0) + tolerance &&
          Number(item.sourceEnd || 0) >= Number(clip.sourceEnd ?? sourceDuration) - tolerance) || mainClips()[0];
        if (!mainVideoClip) return false;
        state.mainVideoTrackMap = { ...(state.mainVideoTrackMap || {}), [mainVideoClip.id]: previousVideoTrack };
        if (pairedAudio) {
          const mainAudioClip = (mainAudioClips() || []).find(item =>
            Number(item.sourceStart || 0) <= Number(pairedAudio.sourceStart || 0) + tolerance &&
            Number(item.sourceEnd || 0) >= Number(pairedAudio.sourceEnd ?? sourceDuration) - tolerance) || mainAudioClips()[0];
          if (mainAudioClip) {
            state.mainAudioTrackMap = { ...(state.mainAudioTrackMap || {}), [mainAudioClip.id]: previousAudioTrack };
            state.mainAudioClipSettings = {
              ...(state.mainAudioClipSettings || {}),
              [mainAudioClip.id]: {
                volume: Number(pairedAudio.volume ?? 1), pan: Number(pairedAudio.pan || 0),
                fadeIn: Number(pairedAudio.fadeIn || 0), fadeOut: Number(pairedAudio.fadeOut || 0),
                muted: !!pairedAudio.muted,
                ...(pairedAudio.fxRack ? { fxRack: pairedAudio.fxRack } : {}),
                ...(pairedAudio.fxBypass != null ? { fxBypass: !!pairedAudio.fxBypass } : {}),
              },
            };
          }
        }

        const ownerMappings = new Map([[clip.id, { id: mainVideoClip.id, type: "video" }]]);
        if (pairedAudio) {
          const mainAudioClip = (mainAudioClips() || []).find(item =>
            Number(item.sourceStart || 0) <= Number(pairedAudio.sourceStart || 0) + tolerance &&
            Number(item.sourceEnd || 0) >= Number(pairedAudio.sourceEnd ?? sourceDuration) - tolerance) || mainAudioClips()[0];
          if (mainAudioClip) ownerMappings.set(pairedAudio.id, { id: mainAudioClip.id, type: "audio" });
        }
        for (const items of [state.captions, state.reviewCaptions, state.issues, state.matchIssues]) {
          for (const item of items || []) {
            const mapping = ownerMappings.get(item.ownerClipId);
            if (mapping) { item.ownerClipId = mapping.id; item.ownerClipType = mapping.type; }
          }
        }
        return true;
      }
      async function enterProject(record) {
        state.initializing = true;
        resetEditorState();
        const data = record.data || record,
          savedWidth = Number(data.width) || 0,
          savedHeight = Number(data.height) || 0;
        Object.assign(state, data, {
          projectId: record.id || data.projectId,
          projectName: record.name || data.projectName || "未命名工程",
          timelineEditMode: ["overwrite", "insert", "place-on-top"].includes(data.timelineEditMode)
            ? data.timelineEditMode
            : "overwrite",
          timelineFrameRate:Number(data.timelineFrameRate||data.fps||data.video?.frameRate||0),
          videoLayers: data.videoLayers || [],
          libraryAssets: data.libraryAssets || [],
          hiddenLibraryPaths: data.hiddenLibraryPaths || [],
          audioAssets: data.audioAssets || [],
          images: data.images || [],
          titles: data.titles || [],
          captions: data.captions || [],
          autoTranscript: data.autoTranscript || null,
          recognizedText: data.recognizedText || "", recognizedTextCleared: !!data.recognizedTextCleared,
          captionRecoveryArchive: Array.isArray(data.captionRecoveryArchive) ? data.captionRecoveryArchive : [],
          compoundClips: data.compoundClips || [],
          auxSubtitles: {
            ...defaultAuxSubtitleSettings(),
            ...(data.auxSubtitles || {}),
          },
          captionLines: normalizeCaptionLineMode(data.captionLines ?? data.captionStyle?.captionLines ?? 1),
          naturalCaptionPunctuation: !!data.naturalCaptionPunctuation,
          reviewCaptions: data.reviewCaptions || [],
          issues: data.issues || [],
          matchIssues: data.matchIssues || data.issues || [],
          alignmentOperations: data.alignmentOperations || [],
          alignmentDuration: Number(data.alignmentDuration || 0),
          removals: data.removals || [],
          manualCuts: data.manualCuts || [],
          audioMutes: data.audioMutes || [],
          audioCuts: data.audioCuts || [],
          mainAudioRemovals: Array.isArray(data.mainAudioRemovals)
            ? data.mainAudioRemovals
            : (data.removals || []).map((item) => ({ ...item })),
          mainAudioManualCuts: Array.isArray(data.mainAudioManualCuts)
            ? data.mainAudioManualCuts
            : [...(data.manualCuts || [])],
          trackOrder:
            Array.isArray(data.trackOrder) && data.trackOrder.length
              ? [...data.trackOrder]
              : [...defaultTrackOrder],
          trackDefinitions: data.trackDefinitions || {},
          mainVideoTrackMap: data.mainVideoTrackMap || {},
          mainAudioTrackMap: data.mainAudioTrackMap || {},
          mainAudioTimelineOffset:
            data.mainAudioTimelineOffset ??
            (Number(data.mainTimelineOffset || 0) + Number(data.audio?.offset || 0)),
          mainVideoClipOffsets: data.mainVideoClipOffsets || {},
          mainAudioClipOffsets: data.mainAudioClipOffsets || {},
          mainVideoClipSettings: data.mainVideoClipSettings || {},
          trackVisibility: {
            ...Object.fromEntries(defaultTrackOrder.map((key) => [key, true])),
            ...(data.trackVisibility || {}),
          },
          trackLocks: data.trackLocks || {},
          trackHeights: data.trackHeights || {},
          trackSolo: data.trackSolo || {},
          trackMute: data.trackMute || {},
          trackAutoSelect: data.trackAutoSelect || {},
          trackSyncLocks: data.trackSyncLocks || {},
          captionTransform: data.captionTransform || {
            x: 0,
            y: Math.round((Number(data.height) || 1920) * 0.28),
            scale: 1,
            width: Math.round((Number(data.width) || 1080) * 0.8),
          },
          color: {
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
            ...(data.color || {}),
            slices: normalizeColorSlices(data.color?.slices),
          },
          beauty: { smoothing: 0, blemish: 0, texture: 0, whitening: 0, brighten: 0, warmth: 0, rosy: 0 },
          denoise: normalizeDenoiseSettings(data.denoise),
          audioFxRack: normalizeAudioFxRack(data.audioFxRack),
          audioFxBypass: !!data.audioFxBypass,
          audioFxScope: "track",
          audio: {
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
            ...(data.audio || {}),
          },
          audioProcessingEnabled: !!data.audioProcessingEnabled,
          mainAudioClipSettings: data.mainAudioClipSettings || {},
          denoiseEnabled: !!data.denoiseEnabled,
          denoisedAudio: migrateDenoisedAudio(data.denoisedAudio),
          // LUT/beauty were removed from the product. Never resurrect legacy project data.
          lut: null,
          filterLook: { id: "none", intensity: 1, baseColor: null },
          beautyBypass: true,
          beauty: { smoothing: 0, blemish: 0, texture: 0, whitening: 0, brighten: 0, warmth: 0, rosy: 0 },
          blemishMarks: [],
          blemishFaceRegion: null,
          selected: { type: "video", id: "main" },
          selectedItems: [],
          selectionFollowsPlayhead: data.selectionFollowsPlayhead === true,
          timelineMarkers: Array.isArray(data.timelineMarkers) ? data.timelineMarkers : [],
          timelineDuration: Math.max(60, Number(data.timelineDuration || data.duration || 0) + 10),
          layout: defaultStartupLayout(),
          canvasZoom: 1,
          undo: [],
          editorActive: true,
          initializing: true,
        });
        const promotedTimelineVideo = promoteSoloTimelineVideoToMainSource();
        if ($("timelineEditMode")) $("timelineEditMode").value = state.timelineEditMode || "overwrite";
        // Waveforms are persisted once per source path. Reuse the same array
        // across timeline slices in memory instead of inflating project files.
        const waveformByPath = new Map();
        for (const item of [state.video, ...(state.videoLayers || []), ...(state.audioAssets || []), ...(state.libraryAssets || [])]) {
          if (item?.path && item.waveform?.length && !waveformByPath.has(item.path)) waveformByPath.set(item.path, item.waveform);
        }
        if (state.video?.path && state.waveform?.length) waveformByPath.set(state.video.path, state.waveform);
        for (const item of [...(state.videoLayers || []), ...(state.audioAssets || []), ...(state.libraryAssets || [])]) {
          if (item?.path && !item.waveform?.length && waveformByPath.has(item.path)) item.waveform = waveformByPath.get(item.path);
        }
        state.lastPolishPlan = data.lastPolishPlan || null;
        state.pauseGapPlan = data.pauseGapPlan || null;
        state.ignoredPolishIds = Array.isArray(data.ignoredPolishIds) ? data.ignoredPolishIds : [];
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
        repairScriptDifferenceLinks();
        const staleMismatchHintsCleared = reconcileStaleAlignedMismatchHints();
        ensureDynamicTracks();
        recomputeContentDuration();
        applyLayout();
        $("projectName").textContent = state.projectName;
        $("scriptText").value = data.script || data.autoCaptionScript || "";
        state.manuscriptLanguage = String(data.manuscriptLanguage || "en");
        if ($("manuscriptLanguage")) $("manuscriptLanguage").value = state.manuscriptLanguage;
        state.legacyAutoCaptionScript = data.autoCaptionScript || "";
        if (state.video?.url) {
          $("video").src = state.video.url;
          $("stage").classList.remove("empty");
        }
        setRatio(state.ratio || "9:16");
        beautyControls();
        if (savedWidth && savedHeight) {
          state.width = savedWidth;
          state.height = savedHeight;
          const resolution = $("resolution");
          const savedResolution = `${savedWidth}x${savedHeight}`;
          if (![...resolution.options].some((option) => option.value === savedResolution))
            resolution.add(new Option(`${savedWidth}×${savedHeight}`, savedResolution));
          resolution.value = savedResolution;
        }
        $("home").classList.add("hidden");
        $("app").classList.add("active");
        state.initializing = false;
        if (staleMismatchHintsCleared) queueAutosave();
        if (promotedTimelineVideo) queueAutosave();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        updateFrameSize(false);
        renderAll();
        window.syncOpenProjectTab?.(state.projectId, state.projectName);
        setTimeout(() => {
          refreshSourceAvailability().catch((error) => console.warn(error));
          watchProjectMediaAnalysis();
          checkModel();
          updateAiReviewButton();
          ensureResolvePlugin();
        }, 120);
      }
      function reviewClipText(item = {}) {
        return reviewClipTitle(item).split('\n')[0].replace(/^疑似/, '');
      }
      function reviewClipTitle(item = {}) {
        const short = value => {
          const text = String(value || '').replace(/\s+/g, ' ').trim();
          return text.length > 80 ? text.slice(0, 79) + '…' : text;
        };
        const spoken = short(item.spokenText || item.spoken || item.text);
        const expected = short(item.expectedText);
        const kind = item.type === 'unverifiedAddition' ? '文案外口语待确认' : item.type === 'repeat' ? '疑似重复' : item.type === 'missing' || item.action === 'missing'
          ? item.confirmedMissing ? '文案缺读（已确认）' : '文案词待核实' : ['addition','extra'].includes(item.type) ? '疑似多读' : '疑似读错';
        if (item.type !== 'mismatch') return `${kind}\n${item.type === 'missing' || item.action === 'missing' ? expected || '需试听核对' : spoken || '需试听核对'}`;
        const left = String(item.spokenText || item.spoken || '').trim().split(/\s+/).filter(Boolean);
        const right = String(item.expectedText || '').trim().split(/\s+/).filter(Boolean);
        while (left.length > 1 && right.length > 1 && left[0] === right[0]) { left.shift(); right.shift(); }
        while (left.length > 1 && right.length > 1 && left.at(-1) === right.at(-1)) { left.pop(); right.pop(); }
        return `${kind}\n${short(left.join(' ')) || '未识别'} → ${short(right.join(' ')) || '需核对'}`;
      }
      function reviewClipDetails(item = {}) {
        const spoken = String(item.spokenText || item.spoken || '').replace(/^\s*[—-]\s*$/, '').trim();
        const expected = String(item.expectedText || "").replace(/^\s*[—-]\s*$/, "").trim();
        if (item.type === 'mismatch') {
          const meaningLabel = item.meaningMode === 'dictionary' ? '词义参考' : '中文';
          const meaning = value => item.meaningVersion === 2 && value
            ? value : ['failed','unavailable','dictionary'].includes(item.meaningReviewStatus) ? '中文暂不可用，请点击重试中文' : '正在查询…';
          return `识别：${item.spokenPhrase || spoken || '未识别到'}\n${meaningLabel}：${meaning(item.spokenZh)}\n正确：${item.expectedPhrase || expected || '无对应内容'}\n${meaningLabel}：${meaning(item.expectedZh)}`;
        }
        if(item.type==='repeat') return `疑似重复\n识别：${spoken || '未识别到'}\n请试听核对是否仍有两次相邻口播。`;
        const kind = item.type === 'unverifiedAddition'
          ? '文案外口语待确认'
          : item.scripture
            ? "📖 经文差异，请自行核对（不影响导出）"
            : item.type === "repeat"
              ? "重复阅读"
              : item.type === "missing" || item.action === "missing"
                ? item.confirmedMissing ? "已确认录音未读出" : "未识别到，待试听确认是否漏读"
                : ['addition','extra'].includes(item.type)
                  ? "识别多出，文案无对应内容"
                  : "用词不一致，需试听核对";
        const reason = item.type === 'unverifiedAddition'
          ? '识别到文案外口语；试听后可选择剪掉，或保留声音并加字幕。'
          : item.type === 'missing' || item.action === 'missing'
          ? item.confirmedMissing ? '已确认录音没有读出这段文案；紫色表示确实缺读。' : '文案有这段内容，但识别结果没有找到对应口播；黄色表示需要试听确认是识别遗漏还是真正缺读。'
          : item.type === 'mismatch'
            ? '识别内容与此位置的文案不一致，可能读法、识别或对齐有误；核对后再修改。'
            : ['addition','extra'].includes(item.type)
              ? '识别结果多出这段内容；可能实际多读或识别误添，需试听确认。'
              : item.reason || '请试听确认。';
        return `${kind}\n识别文案：${spoken || '未识别到'}\n正确文案：${expected || '无对应内容'}\n原因：${reason}${item.scripture || item.strict ? '\n经文仅提示，不影响导出。' : ''}`;
      }
      function repairScriptDifferenceLinks() {
        state.reviewCaptions = (state.reviewCaptions || [])
          .filter((item) => ["missing","repeat","mismatch","addition","extra","unverifiedAddition"].includes(item.type))
          .filter((item) =>
            item.action === "cut" ||
            item.type === "missing" ||
            String(item.expectedText || item.spokenText || "").replace(/^\s*[—-⌫]\s*$/, "").trim(),
          )
          .map((item) => ({
            ...item,
            text: reviewClipText(item),
            action: item.type === "missing" ? "missing" : item.type === "repeat" ? "review" : item.type === "unverifiedAddition" || item.unverifiedAddition ? "insert" : "replace",
          }));
        for (const caption of state.captions || [])
          for (const word of caption.words || []) {
            if (word.reviewDismissed || word.userKept || word.matchType === "edited") {word.issueId="";word.issueType="";word.action="";continue;}
            if (word.issueId || word.matchType === "match") continue;
            const issue = (state.issues || [])
              .map((item) => ({
                item,
                overlap:
                  Math.min(Number(word.end || 0), Number(item.end || 0)) -
                  Math.max(Number(word.start || 0), Number(item.start || 0)),
              }))
              .filter((entry) => entry.overlap > 0.005 &&
                (!entry.item.ownerClipId || entry.item.ownerClipId === caption.ownerClipId) &&
                (!entry.item.sourceMediaId || !caption.sourceMediaId || entry.item.sourceMediaId === caption.sourceMediaId) &&
                (!entry.item.captionTrackId || entry.item.captionTrackId === (caption.trackId || 'caption')))
              .sort((left, right) => right.overlap - left.overlap)[0]?.item;
            if (!issue) continue;
            word.issueId = issue.id;
            word.issueType = issue.type;
            word.action = issue.type === "repeat"
              ? "review"
              : issue.type === "missing"
                ? "missing"
                : "replace";
          }
      }
      function reconcileStaleAlignedMismatchHints() {
        const groups=new Map();
        for (const caption of state.captions||[]) for (const word of caption.words||[]) {
          if (!word.issueId || word.issueType!=='mismatch') continue;
          const id=String(word.issueId);
          if (!groups.has(id)) groups.set(id,[]);
          groups.get(id).push(word);
        }
        const resolved=new Set();
        for (const [id,words] of groups) {
          const safe=words.length>0&&words.every(word=>
            ['match','near'].includes(word.matchType)&&!!(word.referenceExpected||word.expectedDisplay)&&
            !word.userKept&&!word.reviewDismissed&&word.matchType!=='edited'&&word.issueType!=='edited-timing'
          );
          if (!safe) continue;
          resolved.add(id);
          for (const word of words) { word.issueId=''; word.issueType=''; word.action=''; }
        }
        if (!resolved.size) return 0;
        const before=(state.reviewCaptions||[]).length;
        state.reviewCaptions=(state.reviewCaptions||[]).filter(review=>
          !resolved.has(String(review.issueId||review.id))
        );
        for (const field of ['issues','matchIssues'])
          state[field]=(state[field]||[]).filter(issue=>!resolved.has(String(issue.id||'')));
        return before-state.reviewCaptions.length;
      }
      async function openProjectById(id) {
        try {
          await enterProject(await nativeCall("loadProject", id));
          return true;
        } catch (error) {
          showFatal(error.message);
          return false;
        }
      }
      async function createNewProject() {
        const button = $("newProjectConfirm");
        button.disabled = true;
        try {
          await nativeCall("createProject", {
            name: $("newProjectName").value,
            ratio: $("newProjectRatio").value,
            workspaceMode: "edit",
          });
          closeNewProjectModal();
          $('homePeriod').value = 'today'; homeOffset = 0;
          await refreshHome();
        } catch (error) {
          showFatal(error.message);
        } finally {
          button.disabled = false;
        }
      }
      let autosaveRevision = 0;
      let autosaveSavedRevision = 0;
      function queueAutosave() {
        if (!state.editorActive || state.initializing || !state.projectId) return;
        let captionChanges = false;
        for (const caption of state.captions || []) {
          if (typeof caption.textAuditBaseline === 'string' && caption.textAuditBaseline !== caption.text &&
              typeof recordCaptionTextChange === 'function') {
            recordCaptionTextChange(caption,caption.textAuditBaseline,caption.text || '');captionChanges = true;
          }
        }
        if (captionChanges && typeof renderAutoTranscript === 'function') renderAutoTranscript();
        autosaveRevision++;
        $("autosaveState").textContent = "保存中…";
        clearTimeout(autosaveTimer);
        const saveWhenIdle = () => {
          if (state.playing) { autosaveTimer = setTimeout(saveWhenIdle, 500); return; }
          flushAutoSave().catch(() => {});
        };
        autosaveTimer = setTimeout(saveWhenIdle, 1500);
      }
      async function flushAutoSave() {
        if (!state.editorActive || !state.projectId) return;
        autosaveRevision++;
        clearTimeout(autosaveTimer);
        if (autosaveRunning) return autosaveRunning;
        autosaveRunning = (async () => {
          const sessionRevision = projectSessionRevision;
          const projectId = state.projectId;
          try {
            while (autosaveSavedRevision < autosaveRevision &&
                   sessionRevision === projectSessionRevision &&
                   projectId === state.projectId && state.editorActive) {
              const revision = autosaveRevision;
              await nativeCall("saveProjectSnapshot", {projectId, projectName:state.projectName, data:typeof compoundProjectForSave==='function'?compoundProjectForSave():projectData()});
              if (sessionRevision !== projectSessionRevision || projectId !== state.projectId || !state.editorActive) return;
              autosaveSavedRevision = revision;
            }
            if (sessionRevision === projectSessionRevision && projectId === state.projectId)
              $("autosaveState").textContent = "已自动保存";
          } catch(error) {
            if (sessionRevision !== projectSessionRevision || projectId !== state.projectId || !state.editorActive) return;
            $("autosaveState").textContent = "保存失败";
            showFatal(error.message);
            throw error;
          } finally { autosaveRunning = null; }
        })();
        return autosaveRunning;
      }
      window.prepareDesktopClose = async () => {
        if (window.mediaOperationBusy) return {ok:false,error:"素材正在生成，请完成后再退出。"};
        if ($("exportModal")?.classList.contains("on") && $("cancelExport")?.textContent !== "关闭") return {ok:false,error:"请先完成或取消导出，再退出剪辑助手。"};
        if (state.exportJobId) {
          const job = state.exportBackend === "mlt"
            ? await nativeCall("mltExportStatus", { jobId: state.exportJobId })
            : await nativeCall("exportStatus", state.exportJobId);
          if (!["done","completed","cancelled","error","failed"].includes(job.state))
            return {ok:false,error:"导出仍在运行，请先完成或取消导出。"};
        }
        try { await flushAutoSave(); return {ok:true}; }
        catch(error) { return {ok:false,error:"保存失败，已保留窗口："+error.message}; }
      };
      async function refreshProjectCover() {
        if (!state.video?.path || !state.projectId) return;
        const clips = mainClips();
        const active = clips.find(
          (clip) => state.currentTime >= clip.start && state.currentTime < clip.end,
        );
        const timelineTime = active ? state.currentTime : clips[0]?.start ?? 0;
        const result = await nativeCall("refreshProjectCover", {
          projectId: state.projectId,
          inputPath: state.video.path,
          time: timelineToSource(timelineTime),
          projectWidth: state.width,
          projectHeight: state.height,
          videoTransform: active ? mainVideoSettings(active) : state.videoTransform,
        });
        state.projectCoverPath = result.path;
      }
      function unloadEditorMedia() {
        if (typeof releaseEditorRuntime === "function") {
          releaseEditorRuntime();
          return;
        }
        const video = $("video");
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
      }
      async function backToHome() {
        const coverRequest = state.video?.path && state.projectId
          ? {
              projectId: state.projectId,
              inputPath: state.video.path,
              time: (() => {
                const clips = mainClips();
                const active = clips.find((clip) => state.currentTime >= clip.start && state.currentTime < clip.end);
                return timelineToSource(active ? state.currentTime : clips[0]?.start ?? 0);
              })(),
              projectWidth: state.width,
              projectHeight: state.height,
              videoTransform: state.videoTransform,
            }
          : null;
        // Persist the project before touching media or releasing editor state.
        // If save fails, keep the editor open so the user can retry.
        await flushAutoSave();
        unloadEditorMedia();
        state.editorActive = false;
        state.initializing = false;
        state.projectId = "";
        clearTimeout(homeIndexTimer);
        resetEditorState();
        state.projectId = "";
        state.editorActive = false;
        state.initializing = false;
        $("app").classList.remove("active");
        $("home").classList.remove("hidden");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await refreshHome();
        if (coverRequest) {
          nativeCall("refreshProjectCover", coverRequest)
            .then(() => refreshHome())
            .catch((error) => console.warn("工程封面更新失败", error));
        }
      }
      function syncWorkspaceModeHomeLabels() {
        if ($("homeWorkspaceHeading")) $("homeWorkspaceHeading").textContent = "我的剪辑工程";
        if ($("homeWorkspaceDescription")) $("homeWorkspaceDescription").textContent = "工程自动保存到本机；分屏与画中画可在剪辑器中随时添加";
      }
      syncWorkspaceModeHomeLabels();
      let workspaceSwitchQueue = Promise.resolve();
      window.setClipAssistantWorkspaceMode = (mode) => {
        const next = "edit";
        workspaceSwitchQueue = workspaceSwitchQueue.catch(() => {}).then(async () => {
          const previous = "edit";
          syncWorkspaceModeHomeLabels();
          window.__clipAssistantWorkspaceMode = next;
          if (previous !== next) await refreshHome();
        });
        return workspaceSwitchQueue.catch((error) => {
          toast(`切换工作区失败：${error.message || error}`);
          throw error;
        });
      };
      window.__flushBeforeClose = () => {
        try {
          flushAutoSave().catch(() => {});
        } catch {}
      };
      var timelineHistoryTransaction = false;
      function snapshot() {
        if(timelineHistoryTransaction)return;
        state.undo.push(JSON.stringify(projectData(true)));
        state.redo = [];
        if (state.undo.length > 100) state.undo.shift();
      }
      function restoreSnapshot() {
        const item = state.undo.pop();
        if (!item) return;
        const record=JSON.parse(item);
        state.redo.push(record.__historyDelta ? item : JSON.stringify(projectData(true)));
        applyHistoryState(record.__historyDelta ? record.before : record);
        toast("已撤销");
      }
      function redoSnapshot() {
        const item = state.redo.pop();
        if (!item) return;
        const record=JSON.parse(item);
        state.undo.push(record.__historyDelta ? item : JSON.stringify(projectData(true)));
        applyHistoryState(record.__historyDelta ? record.after : record);
        toast("已重做");
      }
      function applyHistoryState(data) {
        const viewZoom = Number(state.zoom || 60);
        const viewCanvasZoom = Number(state.canvasZoom || 1);
        const followPlayhead = state.followPlayhead;
        const stayTime = Number(state.currentTime || 0);
        const waves=new Map([...(state.libraryAssets||[]),...(state.videoLayers||[]),...(state.audioAssets||[])].filter(x=>x.waveform?.length).map(x=>[x.path,x.waveform]));
        if(state.video?.path&&state.waveform?.length)waves.set(state.video.path,state.waveform);
        for(const key of ['videoLayers','audioAssets','libraryAssets'])for(const item of data[key]||[])if(!item.waveform&&waves.has(item.path))item.waveform=waves.get(item.path);
        if(data.video?.path && !data.waveform){
          if(waves.has(data.video.path))data.waveform=waves.get(data.video.path);
          else if(data.video.path!==state.video?.path)data.waveform=[];
        }
        Object.assign(state, data);
        state.blemishMarks = Array.isArray(data.blemishMarks) ? data.blemishMarks : [];
        state.blemishFaceRegion = data.blemishFaceRegion || null;
        state.zoom = viewZoom;
        state.canvasZoom = viewCanvasZoom;
        state.followPlayhead = followPlayhead;
        if ($("timelineZoom")) $("timelineZoom").value = state.zoom;
        renderAll();
        seekTimeline(Number.isFinite(stayTime) ? stayTime : Number(state.currentTime || 0));
      }
      function defaultVisualTransform(source = {}) {
        return {
          x: Number(source.x || 0),
          y: Number(source.y || 0),
          scale: Math.max(0.05, Number(source.scale || 1)),
          rotation: Number(source.rotation || 0),
          opacity: clamp(Number(source.opacity ?? 1), 0, 1),
          blendMode: source.blendMode || "normal",
          cropTop: Math.max(0, Math.min(95, Number(source.cropTop || 0))),
          cropBottom: Math.max(0, Math.min(95, Number(source.cropBottom || 0))),
          cropLeft: Math.max(0, Math.min(95, Number(source.cropLeft || 0))),
          cropRight: Math.max(0, Math.min(95, Number(source.cropRight || 0))),
        };
      }
      function activeMainVideoClip() {
        return mainClips().find(
          (clip) => state.currentTime >= clip.start && state.currentTime < clip.end,
        ) || null;
      }
      function mainVideoSettings(clipOrId, create = true) {
        const clip = typeof clipOrId === "string"
          ? mainClips().find((item) => item.id === clipOrId)
          : clipOrId;
        if (!clip) return null;
        state.mainVideoClipSettings ||= {};
        let settings = state.mainVideoClipSettings[clip.id];
        if (!settings && create) {
          const midpoint = (Number(clip.sourceStart || 0) + Number(clip.sourceEnd || 0)) / 2;
          const inherited = Object.values(state.mainVideoClipSettings).find(
            (item) => midpoint >= Number(item.sourceStart ?? Infinity) && midpoint <= Number(item.sourceEnd ?? -Infinity),
          );
          settings = {
            ...defaultVisualTransform(inherited || state.videoTransform),
            sourceStart: Number(clip.sourceStart || 0),
            sourceEnd: Number(clip.sourceEnd || 0),
          };
          state.mainVideoClipSettings[clip.id] = settings;
        }
        return settings || null;
      }
      function compoundTransformFor(group) {
        if (!group) return null;
        return group.transform ||= { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0 };
      }
      function currentObject() {
        if (state.selected.type === "compound")
          return compoundTransformFor((state.compoundClips || []).find((group) => group.id === state.selected.id));
        if (state.selected.type === "video") {
          if (!state.video) return null;
          const clip = state.selected.id === "main"
            ? activeMainVideoClip()
            : mainClips().find((item) => item.id === state.selected.id);
          return clip ? mainVideoSettings(clip) : state.videoTransform;
        }
        if (state.selected.type === "videolayer")
          return state.videoLayers.find((x) => x.id === state.selected.id);
        if (state.selected.type === "audio")
          return state.video ? state.audio : null;
        if (state.selected.type === "audioasset")
          return state.audioAssets.find((x) => x.id === state.selected.id);
        if (state.selected.type === "image")
          return state.images.find((x) => x.id === state.selected.id);
        if (state.selected.type === "text")
          return state.titles.find((x) => x.id === state.selected.id);
        if (state.selected.type === "caption")
          return state.captions.length ? state.captionTransform : null;
        if (state.selected.type === "review")
          return state.reviewCaptions.find((x) => x.id === state.selected.id);
        return null;
      }
      function selectedVisualTransformTargets() {
        const selected = (state.selectedItems || []).length
          ? state.selectedItems
          : [state.selected];
        const targets = [];
        const seen = new Set();
        for (const item of selected) {
          if (!item || !["video", "videolayer", "image", "compound"].includes(item.type)) continue;
          if (selectionIsLocked(item.type, item.id)) continue;
          let object = null;
          if (item.type === "compound") {
            object = compoundTransformFor((state.compoundClips || []).find((group) => group.id === item.id));
          } else if (item.type === "video") {
            const clip = item.id === "main"
              ? activeMainVideoClip()
              : mainClips().find((entry) => entry.id === item.id);
            object = clip ? mainVideoSettings(clip) : state.videoTransform;
          } else {
            object = timelineObjectFor(item.type, item.id);
          }
          if (!object || seen.has(object)) continue;
          seen.add(object);
          targets.push(object);
        }
        if (!targets.length) {
          const current = currentObject();
          if (current) targets.push(current);
        }
        return targets;
      }
      function mutateSelectedVisualTransforms(mutator) {
        const targets = selectedVisualTransformTargets();
        if (!targets.length || !guardUnlocked()) return [];
        for (const target of targets) mutator(target);
        if ((state.selectedItems || []).some((item) => item.type === "compound") || state.selected.type === "compound")
          window.syncCompoundPreviewWrappers?.();
        queueAutosave();
        return targets;
      }
      function selectionTrackId(type = state.selected.type, id = state.selected.id) {
        if (type === "compound") return (state.compoundClips || []).find((group) => group.id === id)?.videoTrackId || "video";
        if (type === "video") return state.mainVideoTrackMap?.[id] || "video";
        if (type === "audio") return state.mainAudioTrackMap?.[id] || "audio";
        if (type === "caption") return timelineObjectFor(type, id)?.trackId || "caption";
        if (type === "review") return "review";
        return timelineObjectFor(type, id)?.trackId || type;
      }
      function isTrackLocked(trackId) {
        return !!state.trackLocks?.[trackId];
      }
      let timelineCommandRunning = false;
      let timelineGestureBefore = null;
      function isTrackAutoSelected(trackId) {
        return state.trackAutoSelect?.[trackId] !== false;
      }
      function isTrackSyncLocked(trackId) {
        return state.trackSyncLocks?.[trackId] !== false;
      }
      function timelineCommandContext({ items = null, requireAutoSelect = false, includeLocked = false } = {}) {
        const requested = items || ((state.selectedItems || []).length ? state.selectedItems : [state.selected]);
        const resolved = expandLinkedSelection(resolveWorkingSelection(requested));
        const targets = resolved.filter((item) => {
          const trackId = selectionTrackId(item.type, item.id);
          if (!includeLocked && isTrackLocked(trackId)) return false;
          if (requireAutoSelect && !isTrackAutoSelected(trackId)) return false;
          return true;
        });
        return { time: Number(state.currentTime || 0), tool: editTool, linked: state.avLinked, snapping: state.snapping, requested, targets, targetTracks: [...new Set(targets.map((item) => selectionTrackId(item.type, item.id)))] };
      }
      function runTimelineCommand(name, options = {}, mutate) {
        if (timelineCommandRunning || typeof mutate !== "function") return false;
        timelineCommandRunning = true;
        const before = JSON.stringify(projectData(true)), context = timelineCommandContext(options);
        try {
          const result = mutate(context);
          const changed = result !== false && JSON.stringify(projectData(true)) !== before;
          if (!changed) return false;
          state.undo.push(before); state.redo = [];
          if (state.undo.length > 100) state.undo.shift();
          if (options.recompute !== false) recomputeContentDuration();
          if (options.render === "timeline") { renderTimeline(); renderPreviewObjects(); updateInspector(); }
          else if (options.render === "ruler") renderRuler();
          else renderAll();
          if (options.autosave !== false) queueAutosave();
          return true;
        } catch (error) {
          applyHistoryState(JSON.parse(before));
          console.error(`时间线命令失败：${name}`, error);
          toast(`${name}失败，操作已自动回滚`);
          return false;
        } finally { timelineCommandRunning = false; }
      }

      function activeSoloTracks() {
        return new Set(
          Object.entries(state.trackSolo || {})
            .filter(([, enabled]) => enabled)
            .map(([trackId]) => trackId),
        );
      }
      function isTrackAudible(trackId) {
        if (state.trackVisibility?.[trackId] === false) return false;
        if (state.trackMute?.[trackId] === true) return false;
        const solo = activeSoloTracks();
        return !solo.size || solo.has(trackId);
      }
      function effectiveTrackVisibility() {
        return Object.fromEntries(
          (state.trackOrder || []).map((trackId) => [trackId, isTrackAudible(trackId)]),
        );
      }
      function sourceFrameRate() {
        const rate = clamp(Number(state.video?.frameRate || state.fps || 30), 1, 240);
        for (const numerator of [24000, 30000, 60000])
          if (Math.abs(rate - numerator / 1001) < 0.02) return numerator / 1001;
        return Math.round(rate);
      }
      function timelineFrameRate() { const rate=Math.max(1,Math.min(240,Number(state.timelineFrameRate||state.video?.frameRate||30)));for(const num of [24000,30000,60000,120000])if(Math.abs(rate-num/1001)<.02)return num/1001;return rate; }
      function frameDuration() {
        return 1 / timelineFrameRate();
      }
      function frameAlignedTime(time) {
        const fps = timelineFrameRate();
        return Math.max(0, Math.round(Number(time || 0) * fps) / fps);
      }
      function previewSourceSeekTime(sourceTime, duration = state.sourceDuration) {
        const fps = sourceFrameRate();
        // HTML media timestamps may be rounded to microseconds. Seek inside
        // the requested source frame, retaining the exact edit boundary in state.
        const frame = Math.floor(Math.max(0, sourceTime) * fps + 1e-7);
        const target = (frame + 0.25) / fps;
        return Number(duration) > 0 ? Math.min(target, Math.max(0, duration - 1 / fps / 4)) : target;
      }
      function frameBoundedTime(time, min = 0, max = Infinity, subframe = false) {
        if (subframe) return clamp(time, min, max);
        const fps = timelineFrameRate();
        const first = Math.ceil(min * fps - 1e-7), last = Math.floor(max * fps + 1e-7);
        return first <= last ? clamp(Math.round(time * fps), first, last) / fps : clamp(time, min, max);
      }
      function formatTimecode(time) {
        const fps = timelineFrameRate();
        const totalFrames = Math.max(0, Math.round(Number(time || 0) * fps));
        const roundedFps = Math.max(1, Math.round(fps));
        const frames = totalFrames % roundedFps;
        const totalSeconds = Math.floor(totalFrames / roundedFps);
        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);
        return [hours, minutes, seconds, frames]
          .map((value) => String(value).padStart(2, "0"))
          .join(":");
      }
      function selectionIsLocked(type = state.selected.type, id = state.selected.id) {
        if (type === "compound") {
          const group = (state.compoundClips || []).find((item) => item.id === id);
          if (group && (group.members || []).some((member) => selectionIsLocked(member.type, member.id))) return true;
        }
        return isTrackLocked(selectionTrackId(type, id));
      }
      function guardUnlocked(type = state.selected.type, id = state.selected.id) {
        if (!selectionIsLocked(type, id)) return true;
        toast("这个轨道已锁定，请先点击轨道前方的锁");
        return false;
      }
      function normalizeSelection() {
        if (!state.selected?.type) {
          state.selectedItems = [];
          state.selected = state.video ? { type: "video", id: "main" } : { type: "", id: "" };
          return;
        }
        if (state.selected.type === "caption") {
          if (!state.captions.length) {
            state.selectedItems = [];
            state.selected = state.video ? { type: "video", id: "main" } : { type: "", id: "" };
            return;
          }
          if (!state.captions.some((item) => item.id === state.selected.id)) {
            const current = captionAtTime(state.currentTime) || state.captions[0];
            state.selected = { type: "caption", id: current.id };
            state.selectedItems = [{ type: "caption", id: current.id }];
          }
          return;
        }
        if (currentObject()) return;
        state.selectedItems = [];
        state.selected = state.video
          ? { type: "video", id: "main" }
          : { type: "", id: "" };
      }
      function currentTimelineObject() {
        if (state.selected.type === "caption")
          return state.captions.find((x) => x.id === state.selected.id);
        if (state.selected.type === "review")
          return state.reviewCaptions.find((x) => x.id === state.selected.id);
        return currentObject();
      }
      function timelineObjectFor(type, id) {
        const collections = {
          compound: state.compoundClips,
          videolayer: state.videoLayers,
          audioasset: state.audioAssets,
          image: state.images,
          text: state.titles,
          caption: state.captions,
          review: state.reviewCaptions,
        };
        return collections[type]?.find((item) => item.id === id) || null;
      }
      function selectionKey(type, id) {
        return `${type}:${id}`;
      }
      function isSelected(type, id) {
        return (state.selectedItems || []).some(
          (item) => item.type === type && item.id === id,
        );
      }
      function selectItem(type, id, additive = false, toggle = false) {
        if (!additive) state.timelineRange = null;
        const key = selectionKey(type, id);
        const current = state.selectedItems || [];
        if (!additive) state.selectedItems = [{ type, id }];
        else if (toggle && current.some((item) => selectionKey(item.type, item.id) === key))
          state.selectedItems = current.filter(
            (item) => selectionKey(item.type, item.id) !== key,
          );
        else if (!current.some((item) => selectionKey(item.type, item.id) === key))
          state.selectedItems = [...current, { type, id }];
        state.selectedItems = expandCompoundSelection(state.selectedItems);
        const selectedCompound = (state.compoundClips || []).find((group) =>
          group.nestedTimeline && state.selectedItems.length > 0 && state.selectedItems.every((item) =>
            (group.members || []).some((member) => member.type === item.type && member.id === item.id),
          ),
        );
        if (selectedCompound) {
          state.selectedItems = [{ type: "compound", id: selectedCompound.id }];
          state.selected = state.selectedItems[0];
        } else state.selected = state.selectedItems.at(-1) || { type: "video", id: "main" };
        if (state.selected.type === "caption") activateCaptionListFor(state.selected.id);
        window.syncSelectedClipColor?.();
        window.applyVideoCss?.();
        window.syncSplicePanel?.();
      }
      function overlayTrackId(type, item) {
        if (!item) return type;
        if (type === "review") return item.trackId || "review";
        if (type === "caption") return item.trackId || "caption";
        return item.trackId || type;
      }
      function linkedTimelineObjects(anchorType, anchorId) {
        if (!state.avLinked) return [];
        const obj = timelineObjectFor(anchorType, anchorId);
        if (!obj?.linkGroupId) return [];
        const result = [];
        for (const [type, items] of [
          ["videolayer", state.videoLayers],
          ["audioasset", state.audioAssets],
        ])
          for (const item of items || []) {
            if (type === anchorType && item.id === anchorId) continue;
            if (item.linkGroupId === obj.linkGroupId)
              result.push({
                type,
                id: item.id,
                obj: item,
                originStart: Number(item.start || 0),
                originEnd: Number(item.end || 0),
              });
          }
        return result;
      }
      function includeLinkedSelection(anchorType, anchorId) {
        if (!state.avLinked) return;
        for (const item of linkedTimelineObjects(anchorType, anchorId))
          if (
            !state.selectedItems.some(
              (selected) =>
                selected.type === item.type && selected.id === item.id,
            )
          )
            state.selectedItems.push({ type: item.type, id: item.id });
        if (anchorType === "video" && anchorId && anchorId !== "main") {
          const pair = mainAudioClips().find((clip) => clip.id === anchorId);
          if (
            pair &&
            !state.selectedItems.some((item) => item.type === "audio" && item.id === pair.id)
          )
            state.selectedItems.push({ type: "audio", id: pair.id });
        }
        if (anchorType === "audio" && anchorId && anchorId !== "main") {
          const pair = mainClips().find((clip) => clip.id === anchorId);
          if (
            pair &&
            !state.selectedItems.some((item) => item.type === "video" && item.id === pair.id)
          )
            state.selectedItems.push({ type: "video", id: pair.id });
        }
      }
      function expandLinkedSelection(items) {
        let expanded = expandCompoundSelection(items);
        if (!state.avLinked) return expanded;
        const has = (type, id) =>
          expanded.some((item) => item.type === type && item.id === id);
        const push = (type, id) => {
          if (id && !has(type, id)) expanded.push({ type, id });
        };
        for (const item of items || []) {
          const obj = timelineObjectFor(item.type, item.id);
          if (obj?.linkedAudioId) push("audioasset", obj.linkedAudioId);
          if (obj?.linkedVideoId) push("videolayer", obj.linkedVideoId);
          for (const partner of linkedTimelineObjects(item.type, item.id))
            push(partner.type, partner.id);
          if (item.type === "video" && item.id && item.id !== "main") push("audio", item.id);
          if (item.type === "audio" && item.id && item.id !== "main") push("video", item.id);
        }
        return expandCompoundSelection(expanded);
      }
      function expandCompoundSelection(items = []) {
        const expanded = [...items];
        const has = (type, id) => expanded.some((item) => item.type === type && item.id === id);
        let changed = true;
        while (changed) {
          changed = false;
          for (const group of state.compoundClips || []) {
            if (!(group.members || []).some((member) => has(member.type, member.id))) continue;
            for (const member of group.members || []) {
              if (has(member.type, member.id)) continue;
              expanded.push({ type: member.type, id: member.id });
              changed = true;
            }
          }
        }
        return expanded;
      }
      function compoundSpanFor(item) {
        if (item.type === "video") return mainClips().find((clip) => clip.id === item.id) || null;
        if (item.type === "audio") return mainAudioClips().find((clip) => clip.id === item.id) || null;
        return timelineObjectFor(item.type, item.id);
      }
      function createCompoundFromSelection() {
        if(typeof createNestedCompoundFromSelection==='function')return createNestedCompoundFromSelection();
        const members = [...new Map((state.selectedItems || []).map((item) => [selectionKey(item.type, item.id), { type: item.type, id: item.id }])).values()];
        const visualMembers = members.filter((item) => item.type !== "audio" || !members.some((other) => other.type === "video" && other.id === item.id));
        const spans = visualMembers.map((item) => ({ item, span: compoundSpanFor(item) })).filter((entry) => entry.span).sort((a, b) => Number(a.span.start) - Number(b.span.start));
        if (spans.length < 2) { toast("请先选择两个或更多连续片段"); return false; }
        for (let index = 1; index < spans.length; index += 1) {
          if (Number(spans[index].span.start) > Number(spans[index - 1].span.end) + 0.08) {
            toast("复合片段要求所选内容在时间上连续");
            return false;
          }
        }
        snapshot();
        const id = `compound-${uid()}`;
        state.compoundClips ||= [];
        state.compoundClips.push({
          id,
          name: `复合片段 ${state.compoundClips.length + 1}`,
          members,
          start: Math.min(...spans.map((entry) => Number(entry.span.start || 0))),
          end: Math.max(...spans.map((entry) => Number(entry.span.end || 0))),
        });
        state.selectedItems = expandCompoundSelection([members[0]]);
        state.selected = state.selectedItems.at(-1) || members[0];
        renderTimeline();
        queueAutosave();
        toast(`已新建复合片段，包含 ${visualMembers.length} 个片段`);
        return true;
      }
      function decomposeSelectedCompound() {
        const keys = new Set((state.selectedItems || []).map((item) => selectionKey(item.type, item.id)));
        const groupIds = new Set((state.selectedItems || []).filter((item) => item.type === "compound").map((item) => item.id));
        const before = (state.compoundClips || []).length;
        if (!before) return false;
        snapshot();
        for (const group of state.compoundClips || []) {
          const selected = groupIds.has(group.id) || (group.members || []).some((member) => keys.has(selectionKey(member.type, member.id)));
          if (selected) window.bakeCompoundForDecompose?.(group);
        }
        state.compoundClips = state.compoundClips.filter((group) =>
          !groupIds.has(group.id) && !(group.members || []).some((member) => keys.has(selectionKey(member.type, member.id))));
        if (state.compoundClips.length === before) { state.undo.pop(); toast("所选内容不属于复合片段"); return false; }
        renderTimeline();
        queueAutosave();
        toast("已解除复合片段");
        return true;
      }
      function shiftTimedOverlay(item, length) {
        const start = Number(item.start || 0);
        const end = Number(item.end || start + 0.04);
        item.start = Math.max(0, start - length);
        item.end = Math.max(item.start + 0.04, end - length);
        if (!Array.isArray(item.words)) return item;
        for (const word of item.words) {
          const wordStart = Number(word.start || 0);
          const wordEnd = Number(word.end || wordStart + 0.01);
          word.start = Math.max(0, wordStart - length);
          word.end = Math.max(word.start + 0.01, wordEnd - length);
        }
        return item;
      }
      function rippleOverlayTrack(list, trackId, type, cutStart, cutEnd) {
        const length = Math.max(0, Number(cutEnd) - Number(cutStart));
        if (length <= 0.001) return list;
        for (const item of list || []) {
          if (overlayTrackId(type, item) !== trackId) continue;
          if (Number(item.start || 0) + 0.002 >= Number(cutEnd))
            shiftTimedOverlay(item, length);
        }
        return list;
      }
      function placedMainClips(packed = [], offsets = {}, globalOffset = 0) {
        const extra = Number(globalOffset || 0);
        return (packed || [])
          .map((clip) => {
            const offset = Number(offsets?.[clip.id] || 0) + extra;
            return {
              ...clip,
              start: Math.max(0, Number(clip.start || 0) + offset),
              end: Math.max(0, Number(clip.end || 0) + offset),
            };
          })
          .sort((left, right) => left.start - right.start || left.end - right.end);
      }
      function closeTimelineGap(placed = [], gap = null) {
        const length = Number(gap?.duration || 0);
        if (length <= 0.001) return (placed || []).map((clip) => ({ ...clip }));
        const holeEnd = Number(gap.end);
        return (placed || []).map((clip) => {
          if (Number(clip.start || 0) < holeEnd - 0.002) return { ...clip };
          const shifted = {
            ...clip,
            start: Math.max(0, Number(clip.start || 0) - length),
            end: Math.max(0.04, Number(clip.end || 0) - length),
          };
          if (!Array.isArray(clip.words)) return shifted;
          shifted.words = clip.words.map((word) => ({
            ...word,
            start: Math.max(0, Number(word.start || 0) - length),
            end: Math.max(0.01, Number(word.end || 0) - length),
          }));
          return shifted;
        });
      }
      function offsetsFromPlaced(packed = [], placed = [], globalOffset = 0) {
        const offsets = {};
        const extra = Number(globalOffset || 0);
        for (const next of packed || []) {
          const match =
            (placed || []).find((item) => item.id === next.id) || matchClipBySource(next, placed);
          if (!match) continue;
          const offset = Number(match.start || 0) - Number(next.start || 0) - extra;
          if (Math.abs(offset) > 0.001) offsets[next.id] = offset;
        }
        return offsets;
      }
      function clipsOverlapOnTrack(left, right, epsilon = 0.002) {
        const a0 = Number(left?.start || 0);
        const a1 = Math.max(a0, Number(left?.end || 0));
        const b0 = Number(right?.start || 0);
        const b1 = Math.max(b0, Number(right?.end || 0));
        return a0 < b1 - epsilon && b0 < a1 - epsilon;
      }
      function sourceAtTimeline(clip, timeline) {
        const start = Number(clip.start || 0);
        const end = Math.max(start, Number(clip.end || start));
        const srcStart = Number(clip.sourceStart ?? start);
        const srcEnd = Number(clip.sourceEnd ?? end);
        const duration = end - start;
        if (duration <= 1e-9) return srcStart;
        return srcStart + ((Number(timeline) - start) / duration) * (srcEnd - srcStart);
      }
      function overwriteOverlappingClips(clips = [], movingId = "") {
        const moving = (clips || []).find((clip) => clip.id === movingId);
        if (!moving) return (clips || []).map((clip) => ({ ...clip }));
        const mStart = Number(moving.start || 0);
        const mEnd = Math.max(mStart, Number(moving.end || 0));
        const result = [];
        for (const clip of clips || []) {
          if (clip.id === movingId) {
            result.push({ ...clip });
            continue;
          }
          const start = Number(clip.start || 0);
          const end = Math.max(start, Number(clip.end || 0));
          if (end <= mStart + 0.002 || start >= mEnd - 0.002) {
            result.push({ ...clip });
            continue;
          }
          const hasSourceRange = clip.sourceStart != null || clip.sourceEnd != null;
          if (start >= mStart - 0.002 && end <= mEnd + 0.002) continue;
          if (start < mStart - 0.002) {
            const left = { ...clip, end: mStart };
            if (hasSourceRange) left.sourceEnd = sourceAtTimeline(clip, mStart);
            result.push(left);
          }
          if (end > mEnd + 0.002) {
            const tail = {
              ...clip,
              id: start < mStart - 0.002 ? `${clip.id}__tail` : clip.id,
              start: mEnd,
            };
            if (hasSourceRange) tail.sourceStart = sourceAtTimeline(clip, mEnd);
            result.push(tail);
          }
        }
        return result.sort((left, right) => left.start - right.start || left.end - right.end);
      }
      function rebuildTimelineFromPlaced(placed = [], sourceDuration = 0, speed = 1) {
        const clips = (placed || [])
          .filter((clip) => Number(clip.end || 0) > Number(clip.start || 0) + 0.002)
          .map((clip) => ({
            ...clip,
            sourceStart: Number(clip.sourceStart ?? clip.start ?? 0),
            sourceEnd: Number(clip.sourceEnd ?? clip.end ?? 0),
          }))
          .sort((left, right) => left.sourceStart - right.sourceStart || left.start - right.start);
        const duration = Math.max(0, Number(sourceDuration || 0));
        const occupied = clips
          .map((clip) => ({
            start: Math.max(0, Number(clip.sourceStart || 0)),
            end: Math.max(0, Number(clip.sourceEnd || 0)),
          }))
          .filter((span) => span.end > span.start + 0.002)
          .sort((left, right) => left.start - right.start);
        const removals = [];
        let cursor = 0;
        for (const span of occupied) {
          if (span.start > cursor + 0.002)
            removals.push({ start: cursor, end: span.start, source: "overwrite" });
          cursor = Math.max(cursor, span.end);
        }
        if (duration > 0 && cursor < duration - 0.002)
          removals.push({ start: cursor, end: duration, source: "overwrite" });
        const manualCuts = [
          ...new Set(
            clips.flatMap((clip) => [Number(clip.sourceStart || 0), Number(clip.sourceEnd || 0)]),
          ),
        ]
          .filter((cut) => cut > 0.002 && (duration <= 0 || cut < duration - 0.002))
          .sort((left, right) => left - right);
        const packed = buildPackedMainClips(removals, manualCuts, duration || cursor, speed);
        return {
          removals: normalizeRemovalsList(removals),
          manualCuts,
          packed,
          offsets: offsetsFromPlaced(packed, clips),
        };
      }
      function playheadOverlayX(time, zoom, scrollLeft = 0) {
        return Number(time || 0) * Number(zoom || 0) - Number(scrollLeft || 0);
      }
      function playheadAnchoredScrollLeft({
        oldZoom,
        newZoom,
        playheadTime,
        scrollLeft,
        viewWidth,
      } = {}) {
        const oldZ = Math.max(1e-6, Number(oldZoom) || 1);
        const newZ = Math.max(1e-6, Number(newZoom) || oldZ);
        const time = Number(playheadTime || 0);
        const view = Math.max(1, Number(viewWidth) || 1);
        const oldScreenX = playheadOverlayX(time, oldZ, scrollLeft);
        const anchorX = oldScreenX >= 0 && oldScreenX <= view ? oldScreenX : view / 2;
        return Math.max(0, playheadOverlayX(time, newZ, 0) - anchorX);
      }
      function playheadInside(item, time, margin = frameDuration() - 1e-7) {
        const start = Number(item?.start || 0);
        const end = Number(item?.end || start);
        return Number(time) > start + margin && Number(time) < end - margin;
      }
      function normalizeLanguagePunctuation(text) {
        let str = String(text || "");
        const protectedText = [];
        str = str.replace(/(?:https?:\/\/|www\.)[^\s<>"“”]+[^\s<>"“”.,!?;:)]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:[A-Za-z]\.){2,}|\b[\w-]+\.(?:com|org|net|edu|gov|io|co\.nz)\b(?:\/[^\s,]*)?|\b\d+(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/gi, value => {
          const key = `\uE000${protectedText.length}\uE001`;
          protectedText.push(value);
          return key;
        });
        // Keep digit:digit (scripture e.g. 24:36, clock time e.g. 10:30) compact
        str = str.replace(/(\d)\s*:\s*(\d)/g, "$1:$2");
      
        // 1. English context: convert full-width Chinese punctuation adjacent to Latin letters/numbers to half-width
        str = str.replace(/([a-zA-Z0-9])([，,])(?:\s*)([a-zA-Z0-9])/gu, (match, before, comma, after, offset, source) => {
          // Keep contiguous thousands groups, but preserve spaced numeric lists.
          if (comma === ',' && /^\d,\d$/.test(match)
            && /^\d{3}(?=,\d{3}|\.|\b)/.test(source.slice(offset + 2))) return match;
          return `${before}, ${after}`;
        });
        str = str.replace(/([a-zA-Z])([：:])(?:\s*)([a-zA-Z0-9])/gu, "$1: $3");
        str = str.replace(/(\d)([：:])(?:\s*)([a-zA-Z])/gu, "$1: $3");
        str = str.replace(/([a-zA-Z0-9])([；;])(?:\s*)([a-zA-Z0-9])/gu, "$1; $3");
        str = str.replace(/([a-zA-Z0-9])，/gu, "$1, ");
        str = str.replace(/([a-zA-Z0-9])。/gu, "$1. ");
        str = str.replace(/([a-zA-Z0-9])！/gu, "$1! ");
        str = str.replace(/([a-zA-Z0-9])？/gu, "$1? ");
        str = str.replace(/([a-zA-Z])：/gu, "$1: ");
        str = str.replace(/([a-zA-Z0-9])；/gu, "$1; ");
      
        // 2. Chinese context: convert half-width punctuation between/after CJK characters to full-width Chinese punctuation
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1，$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]):([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1：$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]);([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1；$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),(?!\s*[a-zA-Z0-9])/gu, "$1，");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])!(?!\s*[a-zA-Z0-9])/gu, "$1！");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])\?(?!\s*[a-zA-Z0-9])/gu, "$1？");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]);(?!\s*[a-zA-Z0-9])/gu, "$1；");
      
        // Clean redundant spaces before English punctuation
        str = str.replace(/\s+([.,!?;:])/g, "$1");
        // Clean redundant spaces around Chinese punctuation
        str = str.replace(/\s*([，。、！？；：])\s*/gu, "$1");
        str = str.replace(/\s+([”’」』》〉）】〕〗])/gu, "$1");
        str = str.replace(/([“‘「『《〈（【〔〖])\s+/gu, "$1");
        str = str.replace(/([\u3400-\u9FFF])\s+([“‘「『《〈（【〔〖])/gu, "$1$2");
        str = str.replace(/([”’」』》〉）】〕〗])\s+([\u3400-\u9FFF])/gu, "$1$2");
      
        // A manuscript newline after English punctuation is a word separator too.
        // Lookahead keeps consecutive short items (a,b,c) from skipping a comma.
        str = str.replace(/([A-Za-z0-9\uE001][,.]["'”’)]*)\s*(?=[A-Za-z0-9“‘(\uE000])/g,
          (match, before) => (match.match(/\n/g) || []).length > 1 ? match : `${before} `);
        return str.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedText[Number(index)]);
      }
      function formatPanguSpacing(text) {
        let str = String(text || "");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])([a-zA-Z0-9])/gu, "$1 $2");
        str = str.replace(/([a-zA-Z0-9])([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1 $2");
        str = str.replace(/ {2,}/g, " ");
        return str;
      }
      function stripTrailingCaptionPunctuation(text) {
        return String(text || "")
          .replace(/[，,。.]$/u, "")
          .trim();
      }
      function joinCaptionWords(words, options = {}) {
        let text = (words || [])
          .map((word) => (typeof word === "string" ? word : word.display || word.text || ""))
          .filter(Boolean)
          .join(" ")
          .replace(/\s+([.,!?;:，。、！？；：”’」』》〉）】〕〗\)\}])/gu, "$1")
          .replace(/([“‘「『《〈（【〔〖(\[{])\s+/gu, "$1")
          .replace(/:\s+(?=\d)/g, ":")
          .replace(/([\-–—])\s+(?=\d)/g, "$1")
          .trim();

        text = normalizeLanguagePunctuation(text);
        text = formatPanguSpacing(text);
        const shouldStrip = options?.stripTrailingPunctuation !== false && ($("cleanTrailingPunctuation")?.checked !== false);
        if (shouldStrip) {
          text = stripTrailingCaptionPunctuation(text);
        }
        return text;
      }
      function splitTimedItem(item, time, nextId) {
        if (!item || !playheadInside(item, time)) return null;
        const left = item;
        const right = { ...item, id: nextId };
        if (Array.isArray(item.words) && item.words.length) {
          const leftWords = [];
          const rightWords = [];
          for (const word of item.words) {
            const wordStart = Number(word.start || 0);
            const wordEnd = Number(word.end || wordStart + 0.01);
            if ((wordStart + wordEnd) / 2 < time) leftWords.push({ ...word });
            else rightWords.push({ ...word });
          }
          if (!leftWords.length || !rightWords.length) return null;
          left.words = leftWords;
          left.start = Number(leftWords[0].start || item.start);
          left.end = Math.max(left.start + 0.04, Math.min(time, Number(leftWords.at(-1).end)));
          left.text = joinCaptionWords(leftWords);
          right.words = rightWords;
          right.start = Math.max(time, Number(rightWords[0].start || time));
          right.end = Number(rightWords.at(-1).end || item.end);
          right.text = joinCaptionWords(rightWords);
          return { left, right };
        }
        left.end = time;
        right.start = time;
        return { left, right };
      }
      function normalizeRemovalsList(removals = []) {
        const clean = (removals || [])
          .filter((r) => Number(r?.end) > Number(r?.start) + 0.002)
          .sort((a, b) => Number(a.start) - Number(b.start));
        if (!clean.length) return [];
        const merged = [{ ...clean[0] }];
        for (let i = 1; i < clean.length; i++) {
          const prev = merged[merged.length - 1];
          const curr = clean[i];
          if (Number(curr.start) <= Number(prev.end) + 0.002) {
            prev.end = Math.max(Number(prev.end), Number(curr.end));
          } else {
            merged.push({ ...curr });
          }
        }
        return merged.filter((r) => r.end > r.start + 0.002);
      }
      function applyMainTrimEdge(removals = [], manualCuts = [], clip = {}, edge = "end", targetSource = 0, sourceDuration = 0) {
        const minSource = frameDuration() * Math.max(0.05, (Number(clip.sourceEnd) - Number(clip.sourceStart)) / (Number(clip.end) - Number(clip.start)) || 1);
        const cleanRemovals = (removals || []).map((r) => ({ ...r }));
        let cleanCuts = [...(manualCuts || [])];
        const srcStart = Number(clip.sourceStart || 0);
        const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
        const maxDur = Math.max(srcEnd, Number(sourceDuration || 0));
        const clampedTarget = Math.max(0, Math.min(maxDur, Number(targetSource || 0)));
        let deltaSource = 0;

        if (
          (edge === "start" && clampedTarget < srcStart - 0.002) ||
          (edge === "end" && clampedTarget > srcEnd + 0.002)
        )
          return rippleRecoverAdjacentRemoval(
            removals,
            manualCuts,
            clip,
            edge,
            clampedTarget,
            sourceDuration,
          );

        if (edge === "start") {
          if (clampedTarget > srcStart + 0.002) {
            cleanRemovals.push({ start: srcStart, end: Math.min(srcEnd - minSource, clampedTarget), source: "edge-trim" });
            deltaSource = -(Math.min(srcEnd - minSource, clampedTarget) - srcStart);
          }
        } else if (edge === "end") {
          if (clampedTarget < srcEnd - 0.002) {
            cleanRemovals.push({ start: Math.max(srcStart + minSource, clampedTarget), end: srcEnd, source: "edge-trim" });
            deltaSource = -(srcEnd - Math.max(srcStart + minSource, clampedTarget));
          }
        }
        return {
          removals: normalizeRemovalsList(cleanRemovals),
          manualCuts: cleanCuts.sort((a, b) => a - b),
          deltaSource,
          targetSource: clampedTarget,
        };
      }
      function sourceOverlap(left = {}, right = {}) {
        return Math.max(
          0,
          Math.min(Number(left.sourceEnd || 0), Number(right.sourceEnd || 0)) -
            Math.max(Number(left.sourceStart || 0), Number(right.sourceStart || 0)),
        );
      }
      function matchClipBySource(clip, list = []) {
        let best = null;
        let bestOverlap = 0;
        for (const item of list || []) {
          const overlap = sourceOverlap(clip, item);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = item;
          }
        }
        return bestOverlap > 0.000001 ? best : null;
      }
      function buildPackedMainClips(removals, manualCuts, sourceDuration, speed = 1) {
        return editSourceClips(sourceDuration,removals,manualCuts,speed);
      }
      function rebuildClipOffsets({
        snapshot = [],
        packed = [],
        globalOffset = 0,
        mode = "ripple",
        editedClip = null,
        edge = "end",
        targetSource = 0,
        speed = 1,
        rippleFrom = 0,
        rippleDelta = 0,
      } = {}) {
        const offsets = {};
        const rate = Math.max(0.05, Number(speed || 1));
        for (const next of packed || []) {
          const previous = matchClipBySource(next, snapshot);
          let desired = next.start + Number(globalOffset || 0);
          if (mode === "ripple") {
            if (previous && editedClip && previous.id === editedClip.id)
              desired = Number(editedClip.start);
            else if (previous && Number(previous.start) < Number(rippleFrom) - 0.01)
              desired = Number(previous.start);
            else if (previous && rippleDelta > 0.001)
              desired = Number(previous.start) - rippleDelta;
            else desired = next.start + Number(globalOffset || 0);
          } else if (previous && editedClip && previous.id === editedClip.id) {
            if (edge === "end") desired = Number(editedClip.start);
            else
              desired =
                Number(editedClip.start) +
                (Number(targetSource) - Number(editedClip.sourceStart || 0)) / rate;
          } else if (previous) desired = Number(previous.start);
          const offset = desired - next.start - Number(globalOffset || 0);
          if (Math.abs(offset) > 0.001) offsets[next.id] = offset;
        }
        return offsets;
      }
      function overlayRippleWindow(clip = {}, edge = "end", deltaTimeline = 0) {
        const start = Number(clip.start || 0);
        const end = Number(clip.end || start);
        if (Math.abs(deltaTimeline) <= 0.001) return { from: end, delta: 0 };
        if (edge === "start") return { from: start, delta: deltaTimeline };
        return {
          from: deltaTimeline < 0 ? end + deltaTimeline : end,
          delta: deltaTimeline,
        };
      }
      function neighborClips(clip = {}, snapshot = []) {
        const start = Number(clip.start || 0);
        const end = Number(clip.end || start);
        const others = (snapshot || []).filter((item) => item && item.id !== clip.id);
        const previous = others
          .filter((item) => Number(item.end || 0) <= start + 0.05)
          .sort((left, right) => Number(right.end || 0) - Number(left.end || 0))[0] || null;
        const next = others
          .filter((item) => Number(item.start || 0) >= end - 0.05)
          .sort((left, right) => Number(left.start || 0) - Number(right.start || 0))[0] || null;
        return { previous, next };
      }
      function adjacentRemoval(removals = [], clip = {}, edge = "end") {
        const srcStart = Number(clip.sourceStart || 0);
        const srcEnd = Number(clip.sourceEnd || srcStart);
        const tolerance = 0.01;
        const candidates = (removals || [])
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => {
            const start = Number(item?.start);
            const end = Number(item?.end);
            if (!(end > start + 0.002)) return false;
            return edge === "start"
              ? end >= srcStart - tolerance && start < srcStart - 0.002
              : start <= srcEnd + tolerance && end > srcEnd + 0.002;
          })
          .sort((left, right) => {
            const leftDistance = edge === "start"
              ? Math.abs(Number(left.item.end) - srcStart)
              : Math.abs(Number(left.item.start) - srcEnd);
            const rightDistance = edge === "start"
              ? Math.abs(Number(right.item.end) - srcStart)
              : Math.abs(Number(right.item.start) - srcEnd);
            return leftDistance - rightDistance;
          });
        return candidates[0] || null;
      }
      function mainTrimSourceBounds({
        removals = state.removals,
        clip = {},
        edge = "end",
        sourceDuration = state.sourceDuration,
        snapshot = [],
        mode = "ripple",
        speed = Math.max(0.05, Number(state.audio.speed || 1)),
        minTimelineDuration = frameDuration(),
      } = {}) {
        const rate = Math.max(0.05, Number(speed || 1));
        const srcStart = Math.max(0, Number(clip.sourceStart || 0));
        const srcEnd = Math.max(srcStart, Number(clip.sourceEnd || srcStart));
        const sourceLimit = Math.max(srcEnd, Number(sourceDuration || 0));
        const minSourceDuration = Math.max(0.002, Number(minTimelineDuration || 0.04) * rate);
        const handle = adjacentRemoval(removals, clip, edge);
        let min = edge === "start"
          ? Math.max(0, Number(handle?.item?.start ?? srcStart))
          : Math.min(srcEnd, srcStart + minSourceDuration);
        let max = edge === "start"
          ? Math.max(srcStart, srcEnd - minSourceDuration)
          : Math.min(sourceLimit, Number(handle?.item?.end ?? srcEnd));
        if (mode !== "ripple") {
          const { previous, next } = neighborClips(clip, snapshot);
          if (edge === "start" && previous) {
            const gap = Math.max(0, Number(clip.start || 0) - Number(previous.end || 0));
            min = Math.max(min, srcStart - gap * rate);
          }
          if (edge === "end" && next) {
            const gap = Math.max(0, Number(next.start || 0) - Number(clip.end || 0));
            max = Math.min(max, srcEnd + gap * rate);
          }
        }
        min = Math.max(0, Math.min(min, srcEnd - minSourceDuration));
        max = Math.min(sourceLimit, Math.max(max, srcStart + minSourceDuration));
        return {
          min,
          max,
          handleStart: handle ? Number(handle.item.start) : srcStart,
          handleEnd: handle ? Number(handle.item.end) : srcEnd,
          hasHandle: !!handle,
        };
      }
      function dropSubframeClips(packed = [], removals = [], manualCuts = [], sourceDuration = 0, speed = 1) {
        const tiny = (packed || []).filter((clip) => Number(clip.end) - Number(clip.start) < frameDuration() - 1e-7);
        if (!tiny.length) return { packed, removals, manualCuts };
        const nextRemovals = normalizeRemovalsList([
          ...removals,
          ...tiny.map((clip) => ({
            start: Number(clip.sourceStart),
            end: Number(clip.sourceEnd),
            source: "edge-trim",
          })),
        ]);
        const nextCuts = (manualCuts || []).filter((cut) =>
          tiny.every(
            (clip) => Number(cut) <= Number(clip.sourceStart) + 0.002 || Number(cut) >= Number(clip.sourceEnd) - 0.002,
          ),
        );
        return {
          packed: buildPackedMainClips(nextRemovals, nextCuts, sourceDuration, speed),
          removals: nextRemovals,
          manualCuts: nextCuts,
        };
      }
      function collectMainMoveIds(anchorType, anchorId) {
        const ids = new Set();
        if (anchorId) ids.add(anchorId);
        for (const item of expandLinkedSelection(state.selectedItems || [])) {
          if (item?.type === "video" || item?.type === "audio") ids.add(item.id);
        }
        if (state.avLinked && anchorId) ids.add(anchorId);
        return [...ids].filter(Boolean);
      }
      // ── Ripple-safe outward recovery ──────────────────────────────────
      // Extending a clip only consumes the deleted handle directly touching
      // the selected edge. Recovered frames join the existing clip and the
      // far edit point survives so the downstream clip remains independent.
      function rippleRecoverAdjacentRemoval(removals = [], manualCuts = [], clip = {}, edge = "end", targetSource = 0, sourceDuration = 0) {
        const cleanRemovals = (removals || []).map((r) => ({ ...r }));
        let cleanCuts = [...(manualCuts || [])];
        const srcStart = Number(clip.sourceStart || 0);
        const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
        const maxDur = Math.max(srcEnd, Number(sourceDuration || 0));
        const target = Math.max(0, Math.min(maxDur, Number(targetSource || 0)));
        let deltaSource = 0;

        if (edge === "end" && target > srcEnd + 0.002) {
          const idx = adjacentRemoval(cleanRemovals, clip, "end")?.index ?? -1;
          if (idx >= 0) {
            const adj = cleanRemovals[idx];
            const farBoundary = Number(adj.end);
            const actualTarget = Math.min(target, farBoundary);
            deltaSource = actualTarget - srcEnd;
            if (actualTarget >= farBoundary - 0.002) {
              cleanRemovals.splice(idx, 1);
              if (farBoundary > 0.002 && farBoundary < maxDur - 0.002)
                cleanCuts.push(farBoundary);
            } else {
              adj.start = actualTarget;
            }
            // Remove manual cuts at the old boundary and inside the recovered range
            // [srcEnd, actualTarget) — but preserve the cut at actualTarget (next clip boundary)
            cleanCuts = cleanCuts.filter((c) => {
              const cv = Number(c);
              return cv < srcEnd - 0.002 || cv >= actualTarget - 0.002;
            });
          }
          // If no adjacent removal → source is already visible, no delta
        } else if (edge === "start" && target < srcStart - 0.002) {
          const idx = adjacentRemoval(cleanRemovals, clip, "start")?.index ?? -1;
          if (idx >= 0) {
            const adj = cleanRemovals[idx];
            const farBoundary = Number(adj.start);
            const actualTarget = Math.max(target, farBoundary);
            deltaSource = srcStart - actualTarget;
            if (actualTarget <= farBoundary + 0.002) {
              cleanRemovals.splice(idx, 1);
              if (farBoundary > 0.002 && farBoundary < maxDur - 0.002)
                cleanCuts.push(farBoundary);
            } else {
              adj.end = actualTarget;
            }
            // Remove manual cuts at the old boundary and inside (actualTarget, srcStart]
            cleanCuts = cleanCuts.filter((c) => {
              const cv = Number(c);
              return cv <= actualTarget + 0.002 || cv > srcStart + 0.002;
            });
          }
        }

        return {
          removals: normalizeRemovalsList(cleanRemovals),
          manualCuts: cleanCuts
            .map(Number)
            .filter(Number.isFinite)
            .sort((a, b) => a - b)
            .filter((cut, index, list) => index === 0 || cut - list[index - 1] > 0.002),
          deltaSource,
          targetSource: edge === "start" ? srcStart - deltaSource : srcEnd + deltaSource,
        };
      }
      function commitMainEdgeTrim({
        removals = state.removals,
        manualCuts = state.manualCuts,
        clip,
        edge,
        targetSource,
        sourceDuration = state.sourceDuration,
        mode = "ripple",
        snapshot = [],
        globalOffset = Math.max(0, Number(state.mainTimelineOffset || 0)),
        speed = Math.max(0.05, Number(state.audio.speed || 1)),
      } = {}) {
        const srcStart = Number(clip.sourceStart || 0);
        const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
        const bounds = mainTrimSourceBounds({
          removals,
          clip,
          edge,
          sourceDuration,
          snapshot,
          mode,
          speed,
        });
        const clampedTarget = Math.max(
          bounds.min,
          Math.min(bounds.max, Number(targetSource || 0)),
        );
        const isOutwardExtend =
          (edge === "end" && clampedTarget > srcEnd + 0.002) ||
          (edge === "start" && clampedTarget < srcStart - 0.002);

        // Every outward trim uses the adjacent-handle path. The old greedy
        // path crossed edit points and rebuilt the dragged frames as a sliver.
        const trim = isOutwardExtend
          ? rippleRecoverAdjacentRemoval(
              removals,
              manualCuts,
              clip,
              edge,
              clampedTarget,
              sourceDuration,
            )
          : applyMainTrimEdge(
              removals,
              manualCuts,
              clip,
              edge,
              clampedTarget,
              sourceDuration,
            );
        let nextRemovals = trim.removals;
        let nextCuts = trim.manualCuts;
        let packed = buildPackedMainClips(
          nextRemovals,
          nextCuts,
          sourceDuration,
          speed,
        );
        const pruned = dropSubframeClips(packed, nextRemovals, nextCuts, sourceDuration, speed);
        packed = pruned.packed;
        nextRemovals = pruned.removals;
        nextCuts = pruned.manualCuts;
        const deltaTimeline = Number(trim.deltaSource || 0) / speed;
        const effectiveTargetSource = Number(trim.targetSource ?? clampedTarget);
        const offsets = rebuildClipOffsets({
          snapshot,
          packed,
          globalOffset,
          mode,
          editedClip: clip,
          edge,
          targetSource: effectiveTargetSource,
          speed,
          rippleFrom: Number(clip.start || 0),
        });
        const window = mode === "ripple"
          ? overlayRippleWindow(clip, edge, deltaTimeline)
          : { from: Number(clip.end || 0), delta: 0 };
        return {
          ...trim,
          removals: nextRemovals,
          manualCuts: nextCuts,
          packed,
          videoOffsets: offsets,
          audioOffsets: { ...offsets },
          overlayFrom: window.from,
          overlayDelta: window.delta,
          targetSource: effectiveTargetSource,
          sourceBounds: bounds,
        };
      }
      function adoptClipMaps(snapshot, packed) {
        for (const next of packed || []) {
          const previous = matchClipBySource(next, snapshot);
          if (!previous || previous.id === next.id) continue;
          if (state.mainVideoClipSettings?.[previous.id])
            state.mainVideoClipSettings[next.id] = { ...state.mainVideoClipSettings[previous.id] };
          if (state.mainVideoTrackMap?.[previous.id])
            state.mainVideoTrackMap[next.id] = state.mainVideoTrackMap[previous.id];
          if (state.mainAudioTrackMap?.[previous.id])
            state.mainAudioTrackMap[next.id] = state.mainAudioTrackMap[previous.id];
          delete state.mainVideoClipSettings[previous.id];
          delete state.mainVideoTrackMap[previous.id];
          delete state.mainAudioTrackMap[previous.id];
        }
      }
      function applyOverlayRipple(from, delta) {
        if (delta < -0.001) shiftTracks(from, -delta);
        else if (delta > 0.001) rippleShiftAllTracks(state, from, delta);
      }
      function rollingEditMainClips(removals = [], manualCuts = [], leftClip = {}, rightClip = {}, targetSource = 0) {
        const cleanRemovals = (removals || []).map((r) => ({ ...r }));
        const cleanCuts = (manualCuts || []).filter(
          (c) => c < Number(leftClip.sourceStart || 0) + 0.002 || c > Number(rightClip.sourceEnd || 0) - 0.002,
        );
        const rate = (Number(leftClip.sourceEnd) - Number(leftClip.sourceStart)) / (Number(leftClip.end) - Number(leftClip.start)) || 1;
        const minimum = frameDuration() * rate;
        const minBound = Number(leftClip.sourceStart || 0) + minimum;
        const maxBound = Number(rightClip.sourceEnd || minBound + minimum) - minimum;
        const cutPoint = Math.max(minBound, Math.min(maxBound, Number(targetSource || 0)));
        for (let i = cleanRemovals.length - 1; i >= 0; i--) {
          const r = cleanRemovals[i];
          if (r.start >= Number(leftClip.sourceStart || 0) && r.end <= Number(rightClip.sourceEnd || 0)) {
            cleanRemovals.splice(i, 1);
          }
        }
        cleanCuts.push(cutPoint);
        return {
          removals: normalizeRemovalsList(cleanRemovals),
          manualCuts: cleanCuts.sort((a, b) => a - b),
          cutPoint,
        };
      }
      function slipClipSource(clip = {}, deltaSource = 0, minSource = 0, maxSource = Infinity) {
        const srcStart = Number(clip.sourceStart || 0);
        const srcEnd = Number(clip.sourceEnd || srcStart + 0.04);
        const duration = srcEnd - srcStart;
        const targetStart = Math.max(minSource, Math.min(maxSource - duration, srcStart + deltaSource));
        return {
          sourceStart: targetStart,
          sourceEnd: targetStart + duration,
        };
      }
      function rippleShiftAllTracks(collections = {}, fromTimelineTime = 0, deltaTimeline = 0) {
        const shiftedLists=new Set();
        for(const [key,track] of [['videoLayers','video'],['audioAssets','audio'],['images','image'],['titles','text'],['captions','caption'],['reviewCaptions','review'],['audioMutes','audio'],['issues','review'],['matchIssues','review']]){
          const list=collections[key];if(!list||shiftedLists.has(list))continue;shiftedLists.add(list);
          const result=editRipple(list,fromTimelineTime,deltaTimeline,{id:uid,rate:Number(collections.audio?.speed||1),enabled:item=>editTrackEnabled(item.trackId||track,collections.trackLocks,collections.trackSyncLocks,true)});
          list.splice(0,list.length,...result);
        }
        return collections;
      }
      function clipUnderPlayhead(type = "video", time = state.currentTime) {
        if (type === "audio")
          return mainAudioClips().find((clip) => playheadInside(clip, time)) || null;
        return mainClips().find((clip) => playheadInside(clip, time)) || null;
      }
      function clipsUnderPlayhead(time = state.currentTime, { includeReview = false } = {}) {
        const hits = [];
        for (const clip of mainClips())
          if (playheadInside(clip, time)) hits.push({ type: "video", id: clip.id });
        if (!state.avLinked)
          for (const clip of mainAudioClips())
            if (playheadInside(clip, time)) hits.push({ type: "audio", id: clip.id });
        for (const [type, list] of [
          ["videolayer", state.videoLayers],
          ["audioasset", state.audioAssets],
          ["image", state.images],
          ["text", state.titles],
          ["caption", state.captions],
        ])
          for (const item of list || [])
            if (playheadInside(item, time)) hits.push({ type, id: item.id });
        if (includeReview)
          for (const item of state.reviewCaptions || [])
            if (playheadInside(item, time)) hits.push({ type: "review", id: item.id });
        return hits;
      }
      function clipOverlapsRange(clip, start, end) {
        return Number(clip?.start || 0) < Number(end) - 0.001 && Number(clip?.end || 0) > Number(start) + 0.001;
      }
      function clipInsideRange(clip, start, end, slop = 0.03) {
        const clipStart = Number(clip?.start || 0);
        const clipEnd = Number(clip?.end || clipStart);
        return (
          clipStart >= Number(start) - slop &&
          clipEnd <= Number(end) + slop &&
          clipEnd - clipStart > 0.02
        );
      }
      function selectionMainCutRange(selected, resolveSpan) {
        const overlays = [];
        const mains = [];
        for (const item of selected || []) {
          const span = typeof resolveSpan === "function" ? resolveSpan(item) : item;
          if (!span) continue;
          const start = Number(span.start || 0);
          const end = Number(span.end || start);
          if (end <= start + 0.001) continue;
          if (item.type === "video" || item.type === "audio") mains.push({ start, end });
          else overlays.push({ start, end });
        }
        if (!mains.length || !overlays.length) return null;
        const start = Math.max(
          Math.min(...mains.map((item) => item.start)),
          Math.min(...overlays.map((item) => item.start)),
        );
        const end = Math.min(
          Math.max(...mains.map((item) => item.end)),
          Math.max(...overlays.map((item) => item.end)),
        );
        if (end <= start + 0.04) return null;
        const mainLength =
          Math.max(...mains.map((item) => item.end)) -
          Math.min(...mains.map((item) => item.start));
        if (end - start >= mainLength - 0.08) return null;
        return { start, end };
      }
      function collectRangeHits(types, start, end) {
        const picked = [];
        const typeSet = types instanceof Set ? types : new Set(types || []);
        if (typeSet.has("video") || (state.avLinked && typeSet.has("audio"))) {
          for (const clip of mainClips())
            if (clipInsideRange(clip, start, end)) picked.push({ type: "video", id: clip.id });
        }
        if (!state.avLinked && typeSet.has("audio")) {
          for (const clip of mainAudioClips())
            if (clipInsideRange(clip, start, end)) picked.push({ type: "audio", id: clip.id });
        }
        if (state.avLinked && typeSet.has("audio") && !typeSet.has("video")) {
          for (const clip of mainAudioClips())
            if (clipInsideRange(clip, start, end)) picked.push({ type: "audio", id: clip.id });
        }
        for (const [type, list] of [
          ["videolayer", state.videoLayers],
          ["audioasset", state.audioAssets],
          ["image", state.images],
          ["text", state.titles],
          ["caption", state.captions],
          ["review", state.reviewCaptions],
        ]) {
          if (!typeSet.has(type)) continue;
          for (const item of list || [])
            if (clipInsideRange(item, start, end)) picked.push({ type, id: item.id });
        }
        return picked;
      }
      function rangeTargetsAt(types, time) {
        const typeSet = types instanceof Set ? types : new Set(types || []);
        const targets = [];
        if (typeSet.has("video") || (state.avLinked && typeSet.has("audio"))) {
          for (const clip of mainClips())
            if (playheadInside(clip, time, 0.000001)) targets.push({ type: "video", id: clip.id });
        }
        if (!state.avLinked && typeSet.has("audio")) {
          for (const clip of mainAudioClips())
            if (playheadInside(clip, time, 0.000001)) targets.push({ type: "audio", id: clip.id });
        }
        if (state.avLinked && typeSet.has("audio") && !typeSet.has("video")) {
          for (const clip of mainAudioClips())
            if (playheadInside(clip, time, 0.000001)) targets.push({ type: "audio", id: clip.id });
        }
        for (const [type, list] of [
          ["videolayer", state.videoLayers],
          ["audioasset", state.audioAssets],
          ["image", state.images],
          ["text", state.titles],
          ["caption", state.captions],
          ["review", state.reviewCaptions],
        ]) {
          if (!typeSet.has(type)) continue;
          for (const item of list || [])
            if (playheadInside(item, time, 0.000001)) targets.push({ type, id: item.id });
        }
        return targets;
      }
      function applyTimelineRangeSelection(range, hits, additive = false) {
        const start = Number(range?.start || 0);
        const end = Number(range?.end || 0);
        if (end <= start + 0.08) return false;
        const types = new Set((hits || []).map((item) => item.type).filter(Boolean));
        if (!types.size) return false;
        const picked = collectRangeHits(types, start, end);
        const merged = additive ? [...(state.selectedItems || []), ...picked] : picked;
        state.timelineRange = { start, end, types: [...types] };
        state.selectedItems = expandLinkedSelection(
          [...new Map(merged.map((item) => [selectionKey(item.type, item.id), item])).values()],
        );
        state.selected = state.selectedItems.at(-1) || { type: "video", id: "main" };
        return true;
      }
      function materializeTimelineRangeSelection() {
        const range = state.timelineRange;
        const start = Number(range?.start || 0);
        const end = Number(range?.end || 0);
        if (end <= start + 0.08) return false;
        const types = new Set(range.types || []);
        if (!types.size) return false;
        splitClipsAt(start, rangeTargetsAt(types, start), { record: false, quiet: true });
        splitClipsAt(end, rangeTargetsAt(types, end), { record: false, quiet: true });
        const picked = collectRangeHits(types, start, end);
        state.selectedItems = expandLinkedSelection(
          [...new Map(picked.map((item) => [selectionKey(item.type, item.id), item])).values()],
        );
        state.selected = state.selectedItems.at(-1) || { type: "video", id: "main" };
        return state.selectedItems.length > 0;
      }
      function selectAfterPlayhead() {
        const start = Math.max(0, Number(state.currentTime || 0));
        const end = Math.max(start + 0.1, visibleTimelineDuration(), Number(state.duration || 0)) + 1;
        const types = new Set([
          "video", "audio", "videolayer", "audioasset", "image", "text", "caption", "review",
        ]);
        const crossing = rangeTargetsAt(types, start).filter((item) => {
          const object = item.type === "video"
            ? mainClips().find((entry) => entry.id === item.id)
            : item.type === "audio"
              ? mainAudioClips().find((entry) => entry.id === item.id)
              : timelineObjectFor(item.type, item.id);
          return object && Number(object.start || 0) < start - 0.02 &&
            Number(object.end || 0) > start + 0.02;
        });
        if (crossing.length) {
          snapshot();
          if (!splitClipsAt(start, crossing, { record: false, quiet: true })) state.undo.pop();
        }
        const picked = expandLinkedSelection(collectRangeHits(types, start, end));
        state.timelineRange = { start, end: Math.max(start, end - 1), types: [...types] };
        state.selectedItems = [
          ...new Map(picked.map((item) => [selectionKey(item.type, item.id), item])).values(),
        ];
        state.selected = state.selectedItems.find((item) => item.type === "video") ||
          state.selectedItems.find((item) => ["videolayer", "image"].includes(item.type)) ||
          state.selectedItems.at(-1) || { type: "video", id: "main" };
        renderTimeline();
        renderPreviewObjects();
        updateInspector();
        syncTimelineRangeOverlay();
        if (crossing.length) queueAutosave();
        toast(state.selectedItems.length
          ? `${crossing.length ? "已在播放头分割；" : ""}已选后方 ${state.selectedItems.length} 个素材，拖动任一已选片段可整体移动`
          : "播放头后没有可选择的素材");
        return state.selectedItems.length > 0;
      }
      function syncTimelineRangeOverlay() {
        const el = $("timelineRange");
        if (!el) return;
        const range = state.timelineRange;
        const start = Number(range?.start || 0);
        const end = Number(range?.end || 0);
        if (!range || end <= start + 0.08) {
          el.classList.remove("on");
          return;
        }
        el.style.left = `${start * state.zoom}px`;
        el.style.width = `${Math.max(2, (end - start) * state.zoom)}px`;
        el.classList.add("on");
      }
      function resolveWorkingSelection(items) {
        const result = [];
        let bare = false;
        for (const item of items || []) {
          if ((item.type === "video" || item.type === "audio") && item.id === "main") {
            bare = true;
            continue;
          }
          result.push(item);
        }
        if (bare) {
          const clip = clipUnderPlayhead("video") || clipUnderPlayhead("audio");
          if (clip)
            result.push({
              type: mainClips().some((item) => item.id === clip.id) ? "video" : "audio",
              id: clip.id,
            });
        }
        return result;
      }
      let editTool = "select";
      function setEditTool(tool) {
        editTool = ["blade", "trim"].includes(tool) ? tool : "select";
        $("timeline")?.classList.toggle("blade-mode", editTool === "blade");
        $("timeline")?.classList.toggle("trim-mode", editTool === "trim");
        $("timelineMain")?.classList.toggle("blade-mode", editTool === "blade");
        $("timelineMain")?.classList.toggle("trim-mode", editTool === "trim");
        $("selectTool")?.classList.toggle("active", editTool === "select");
        $("trimTool")?.classList.toggle("active", editTool === "trim");
        $("bladeTool")?.classList.toggle("active", editTool === "blade");
        $("bladeTool")?.classList.toggle("primary", editTool === "blade");
        if (editTool !== "blade") setBladeGuide(0, false);
      }
      function collectAllCutPoints() {
        const points = new Set([0, Number((state.duration || 0).toFixed(3))]);
        for (const clip of mainClips()) {
          points.add(Number(Number(clip.start || 0).toFixed(3)));
          points.add(Number(Number(clip.end || 0).toFixed(3)));
        }
        for (const list of [state.videoLayers, state.audioAssets, state.images, state.titles, state.captions]) {
          for (const item of list || []) {
            points.add(Number(Number(item.start || 0).toFixed(3)));
            points.add(Number(Number(item.end || 0).toFixed(3)));
          }
        }
        return [...points].sort((a, b) => a - b);
      }
      function selectedJoinCuts(clips = [], selectedIds = [], tolerance = 0.012) {
        const ids = new Set(selectedIds);
        const relevant = clips.filter((clip) => ids.has(clip.id));
        const cuts = [];
        for (const clip of relevant) {
          const neighbor = relevant.find((other) => other !== clip && Math.abs(Number(other.sourceStart) - Number(clip.sourceEnd)) < tolerance);
          if (neighbor) cuts.push(Number(clip.sourceEnd));
        }
        return [...new Set(cuts)];
      }
      function nudgeSelectedClips(deltaSeconds) {
        const selected = expandLinkedSelection(resolveWorkingSelection((state.selectedItems || []).length ? state.selectedItems : [state.selected])).filter((item) => !isTrackLocked(selectionTrackId(item.type, item.id)));
        if (!selected.length) { toast("请先选择要微移的切片"); return false; }
        const starts = selected.map((item) => {
          if (item.type === "video") return mainClips().find((clip) => clip.id === item.id)?.start;
          if (item.type === "audio") return mainAudioClips().find((clip) => clip.id === item.id || clip.parentId === item.id)?.start;
          return timelineObjectFor(item.type, item.id)?.start;
        }).filter(Number.isFinite);
        if (!starts.length) return false;
        const applied = Math.max(Number(deltaSeconds || 0), -Math.min(...starts));
        if (Math.abs(applied) < 1e-8) return false;
        const movesMainMedia = selected.some((item) => item.type === "video" || item.type === "audio");
        const audioOnlyMainMove = !state.avLinked && selected.some((item) => item.type === "audio") && !selected.some((item) => item.type === "video");
        const captionSourceClips = movesMainMedia ? (audioOnlyMainMove ? mainAudioClips() : mainClips()) : [];
        if (movesMainMedia) anchorCaptionsToSource(captionSourceClips);
        const changed = runTimelineCommand("逐帧微移", { items: selected, render: "timeline" }, (context) => {
          const processedMain = new Set(), processedObjects = new Set();
          state.mainVideoClipOffsets ||= {}; state.mainAudioClipOffsets ||= {};
          for (const item of context.targets) {
            if (item.type === "video") {
              const clip = mainClips().find((entry) => entry.id === item.id);
              if (!clip || processedMain.has(`v:${clip.id}`)) continue;
              state.mainVideoClipOffsets[clip.id] = Number(state.mainVideoClipOffsets[clip.id] || 0) + applied;
              processedMain.add(`v:${clip.id}`);
              if (state.avLinked) { state.mainAudioClipOffsets[clip.id] = Number(state.mainAudioClipOffsets[clip.id] || 0) + applied; processedMain.add(`a:${clip.id}`); }
              continue;
            }
            if (item.type === "audio") {
              const clip = mainAudioClips().find((entry) => entry.id === item.id || entry.parentId === item.id), id = clip?.parentId || clip?.id;
              if (!id || processedMain.has(`a:${id}`)) continue;
              state.mainAudioClipOffsets[id] = Number(state.mainAudioClipOffsets[id] || 0) + applied;
              processedMain.add(`a:${id}`);
              if (state.avLinked) { state.mainVideoClipOffsets[id] = Number(state.mainVideoClipOffsets[id] || 0) + applied; processedMain.add(`v:${id}`); }
              continue;
            }
            const object = timelineObjectFor(item.type, item.id), key = `${item.type}:${item.id}`;
            if (!object || processedObjects.has(key)) continue;
            object.start = Math.max(0, Number(object.start || 0) + applied);
            object.end = Math.max(object.start + 0.002, Number(object.end || 0) + applied);
            if (Array.isArray(object.words)) { for (const word of object.words) { word.start = Math.max(0, Number(word.start || 0) + applied); word.end = Math.max(word.start, Number(word.end || 0) + applied); } }
            processedObjects.add(key);
          }
          return true;
        });
        if (changed) toast(`切片已${applied < 0 ? "左移" : "右移"} ${Math.round(Math.abs(applied) / frameDuration())} 帧`);
        return changed;
      }
      function addTimelineMarker() {
        const time = Number(state.currentTime || 0), existing = (state.timelineMarkers || []).find((marker) => Math.abs(Number(marker.time || 0) - time) <= frameDuration() / 2);
        const changed = runTimelineCommand("添加时间线标记", { recompute: false, render: "ruler" }, () => {
          if (existing) existing.label = `标记 ${formatTimecode(time)}`;
          else { state.timelineMarkers ||= []; state.timelineMarkers.push({ id: crypto.randomUUID(), time, label: `标记 ${state.timelineMarkers.length + 1}` }); state.timelineMarkers.sort((a, b) => Number(a.time) - Number(b.time)); }
          return true;
        });
        if (changed) toast(`${existing ? "已更新" : "已添加"}标记 ${formatTimecode(time)}`);
      }
      function jumpTimelineMarker(direction = "next") {
        const markers = [...(state.timelineMarkers || [])].sort((a, b) => Number(a.time) - Number(b.time));
        if (!markers.length) { toast("时间线上还没有标记"); return; }
        const current = Number(state.currentTime || 0);
        const marker = direction === "prev" ? [...markers].reverse().find((item) => Number(item.time) < current - frameDuration() / 2) : markers.find((item) => Number(item.time) > current + frameDuration() / 2);
        const target = marker || (direction === "prev" ? markers.at(-1) : markers[0]);
        seekTimeline(Number(target.time || 0));
        toast(`${direction === "prev" ? "上一个" : "下一个"}标记：${target.label}`);
      }
      function deleteTimelineMarkerAtPlayhead() {
        const markers = state.timelineMarkers || [];
        if (!markers.length) return;
        let index = -1, distance = Infinity;
        markers.forEach((marker, i) => { const d = Math.abs(Number(marker.time || 0) - Number(state.currentTime || 0)); if (d < distance) { distance = d; index = i; } });
        if (index < 0 || distance > Math.max(frameDuration(), snapThresholdSeconds())) { toast("把播放头停在标记上再删除"); return; }
        let removed = null;
        const changed = runTimelineCommand("删除时间线标记", { recompute: false, render: "ruler" }, () => { [removed] = markers.splice(index, 1); return !!removed; });
        if (changed) toast(`已删除${removed.label || "标记"}`);
      }
      function mergeSelectedClips() {
        if (!timelineCommandRunning) return runTimelineCommand("合并切片", { render: "timeline" }, () => mergeSelectedClips());
        const selected = expandLinkedSelection(state.selectedItems || []);
        const videoIds = selected.filter((item) => item.type === "video").map((item) => item.id);
        const audioIds = selected.filter((item) => item.type === "audio").map((item) => item.id);
        const audioOnly = !state.avLinked && !videoIds.length && audioIds.length > 1;
        const previous = audioOnly ? mainAudioClips() : mainClips();
        const ids = audioOnly ? audioIds : videoIds;
        const cuts = selectedJoinCuts(previous, ids).filter((cut) => {
          const left = previous.find((clip) => Math.abs(Number(clip.sourceEnd) - cut) < 0.012);
          const right = previous.find((clip) => Math.abs(Number(clip.sourceStart) - cut) < 0.012);
          if (!left || !right) return false;
          const trackMap = audioOnly ? state.mainAudioTrackMap : state.mainVideoTrackMap;
          return (trackMap?.[left.id] || (audioOnly ? "audio" : "video")) === (trackMap?.[right.id] || (audioOnly ? "audio" : "video"));
        });
        if (!cuts.length) { toast("请选择两个或更多同轨、相邻且同源的音视频切片"); return false; }
        snapshot();
        const cutList = audioOnly ? (state.mainAudioManualCuts ||= [...(state.manualCuts || [])]) : state.manualCuts;
        const oldSettings = { ...(audioOnly ? state.mainAudioClipSettings : state.mainVideoClipSettings) };
        const oldTracks = { ...(audioOnly ? state.mainAudioTrackMap : state.mainVideoTrackMap) };
        const oldOffsets = { ...(audioOnly ? state.mainAudioClipOffsets : state.mainVideoClipOffsets) };
        const kept = cutList.filter((cut) => !cuts.some((merged) => Math.abs(Number(cut) - merged) < 0.012));
        if (audioOnly) state.mainAudioManualCuts = kept; else state.manualCuts = kept;
        const next = audioOnly ? mainAudioClips() : mainClips();
        const settings = {}, tracks = {}, offsets = {};
        for (const clip of next) { const prior = matchClipBySource(clip, previous); if (!prior) continue; if (oldSettings[prior.id]) settings[clip.id] = { ...oldSettings[prior.id] }; if (oldTracks[prior.id]) tracks[clip.id] = oldTracks[prior.id]; if (Math.abs(Number(oldOffsets[prior.id] || 0)) > 0.001) offsets[clip.id] = Number(oldOffsets[prior.id]); }
        if (audioOnly) { state.mainAudioClipSettings = settings; state.mainAudioTrackMap = tracks; state.mainAudioClipOffsets = offsets; }
        else { state.mainVideoClipSettings = settings; state.mainVideoTrackMap = tracks; state.mainVideoClipOffsets = offsets; }
        const merged = (audioOnly ? mainAudioClips() : mainClips()).filter((clip) => previous.some((old) => ids.includes(old.id) && Number(clip.sourceStart) <= Number(old.sourceStart) + 0.012 && Number(clip.sourceEnd) >= Number(old.sourceEnd) - 0.012));
        state.selectedItems = merged.flatMap((clip) => state.avLinked ? [{ type: "video", id: clip.id }, { type: "audio", id: clip.id }] : [{ type: audioOnly ? "audio" : "video", id: clip.id }]);
        state.selected = state.selectedItems[0] || { type: "video", id: "main" };
        renderAll(); queueAutosave();
        toast(`已合并 ${cuts.length + 1} 个相邻音视频切片`);
        return true;
      }

      function jumpToCutPoint(direction) {
        const cuts = collectAllCutPoints();
        const current = Number(Number(state.currentTime || 0).toFixed(3));
        if (direction === "prev") {
          const prevs = cuts.filter((p) => p < current - 0.03);
          if (prevs.length) {
            const target = prevs[prevs.length - 1];
            seekTimeline(target);
            toast(`跳到上一个切点 (${formatTime(target)})`);
          } else {
            seekTimeline(0);
          }
        } else if (direction === "next") {
          const nexts = cuts.filter((p) => p > current + 0.03);
          if (nexts.length) {
            const target = nexts[0];
            seekTimeline(target);
            toast(`跳到下一个切点 (${formatTime(target)})`);
          } else {
            seekTimeline(state.duration);
          }
        }
      }
      function timelineTimeFromClientX(clientX) {
        const scroll = $("timelineScroll");
        if (!scroll) return state.currentTime;
        const bounds = scroll.getBoundingClientRect();
        return clamp(
          (scroll.scrollLeft + clientX - bounds.left) / state.zoom,
          0,
          visibleTimelineDuration(),
        );
      }
      function snapThresholdSeconds(zoom = state.zoom) {
        const secondsForPixels = 8 / Math.max(1, Number(zoom) || 1);
        return Math.min(0.15, secondsForPixels);
      }
      function collectSnapPoints({ clips = [], extra = [], ignoreIds = new Set() } = {}) {
        const points = [];
        for (const value of extra)
          if (Number.isFinite(Number(value))) points.push(Number(value));
        for (const item of clips || []) {
          if (item?.id && ignoreIds.has(item.id)) continue;
          const start = Number(item.start);
          const end = Number(item.end);
          if (Number.isFinite(start)) points.push(start);
          if (Number.isFinite(end)) points.push(end);
        }
        return points;
      }
      function snapValue(value, points, threshold) {
        const time = Number(value);
        const window = Math.max(0, Number(threshold) || 0);
        let best = time;
        let bestDist = Infinity;
        for (const point of points || []) {
          const dist = Math.abs(Number(point) - time);
          if (dist < bestDist && dist <= window) {
            best = Number(point);
            bestDist = dist;
          }
        }
        const snapped = bestDist <= window && bestDist < Infinity;
        return {
          time: snapped ? best : time,
          snapped,
          target: snapped ? best : null,
          distance: snapped ? bestDist : Infinity,
        };
      }
      function snapClipEdges(start, duration, points, threshold) {
        const length = Math.max(0.04, Number(duration) || 0);
        const startSnap = snapValue(start, points, threshold);
        const endSnap = snapValue(Number(start) + length, points, threshold);
        if (endSnap.distance < startSnap.distance)
          return {
            start: endSnap.time - length,
            snapped: endSnap.snapped,
            target: endSnap.target,
            edge: endSnap.snapped ? "end" : "",
          };
        return {
          start: startSnap.time,
          snapped: startSnap.snapped,
          target: startSnap.target,
          edge: startSnap.snapped ? "start" : "",
        };
      }
      function snapGroupDelta(moving, delta, points, threshold) {
        let bestAdj = 0;
        let bestDist = Infinity;
        let target = null;
        for (const item of moving || []) {
          const start = Number(item.originStart) + Number(delta);
          const end = Number(item.originEnd) + Number(delta);
          for (const edge of [start, end]) {
            const snap = snapValue(edge, points, threshold);
            if (!snap.snapped) continue;
            const adj = snap.time - edge;
            if (Math.abs(adj) < bestDist) {
              bestDist = Math.abs(adj);
              bestAdj = adj;
              target = snap.target;
            }
          }
        }
        return {
          delta: Number(delta) + bestAdj,
          snapped: bestDist < Infinity,
          target,
        };
      }
      function allSnapClips() {
        return [
          ...mainClips(),
          ...(!state.avLinked ? mainAudioClips() : []),
          ...state.videoLayers,
          ...state.audioAssets,
          ...state.images,
          ...state.titles,
          ...state.captions,
          ...state.reviewCaptions,
        ];
      }
      function selectNearestEditPoint() {
        const candidates = [];
        const compoundMemberKeys = new Set();
        for (const group of state.compoundClips || []) {
          for (const member of group.members || []) compoundMemberKeys.add(selectionKey(member.type, member.id));
          candidates.push({ time: Number(group.start || 0), group, edge: "start" });
          candidates.push({ time: Number(group.end || 0), group, edge: "end" });
        }
        const addClipEdges = (type, clips) => {
          for (const clip of clips || []) {
            if (compoundMemberKeys.has(selectionKey(type, clip.id))) continue;
            candidates.push({ time: Number(clip.start || 0), type, id: clip.id, edge: "start" });
            candidates.push({ time: Number(clip.end || 0), type, id: clip.id, edge: "end" });
          }
        };
        addClipEdges("video", mainClips());
        if (!state.avLinked) addClipEdges("audio", mainAudioClips());
        addClipEdges("videolayer", state.videoLayers);
        addClipEdges("audioasset", state.audioAssets);
        addClipEdges("image", state.images);
        addClipEdges("text", state.titles);
        if (!candidates.length) return false;
        const now = Number(state.currentTime || 0);
        candidates.sort((a, b) => Math.abs(a.time - now) - Math.abs(b.time - now));
        const nearest = candidates[0];
        seekTimeline(clamp(nearest.time, 0, state.duration));
        if (nearest.group) {
          const first = nearest.group.members?.[0];
          if (first) {
            state.selectedItems = expandCompoundSelection([first]);
            state.selected = state.selectedItems.at(-1) || first;
          }
        } else if (nearest.id) {
          state.selectedItems = expandLinkedSelection([{ type: nearest.type, id: nearest.id }]);
          state.selected = state.selectedItems.at(-1) || { type: nearest.type, id: nearest.id };
        }
        renderTimeline();
        renderPreviewObjects();
        updateInspector();
        showSnapGuide(nearest.time, true);
        toast(`V：已贴合最近片段${nearest.edge === "start" ? "起点" : "终点"} ${formatTime(nearest.time)}`);
        return true;
      }
      function snapIgnoreIds(moving) {
        const ids = new Set();
        const add = (item) => {
          if (!item) return;
          if (item.id) ids.add(item.id);
          if (item.obj?.id) ids.add(item.obj.id);
          const groupId = item.linkGroupId || item.obj?.linkGroupId;
          if (!groupId) return;
          for (const partner of [...state.videoLayers, ...state.audioAssets])
            if (partner.linkGroupId === groupId) ids.add(partner.id);
        };
        if (Array.isArray(moving)) moving.forEach(add);
        else add(moving);
        return ids;
      }
      function currentSnapPoints(moving = null, options = {}) {
        const min = Number.isFinite(Number(options.min)) ? Number(options.min) : -Infinity;
        const max = Number.isFinite(Number(options.max)) ? Number(options.max) : Infinity;
        const excludeTimes = (options.excludeTimes || []).map(Number).filter(Number.isFinite);
        return collectSnapPoints({
          clips: allSnapClips(),
          extra: [0, state.duration, state.currentTime, ...(state.timelineMarkers || []).map(marker => marker.time)],
          ignoreIds: snapIgnoreIds(moving),
        }).filter(
          (point) =>
            point >= min - 0.002 &&
            point <= max + 0.002 &&
            excludeTimes.every((excluded) => Math.abs(point - excluded) > 0.002),
        );
      }
      function overlayX(time) {
        return Number(time) * state.zoom - ($("timelineScroll")?.scrollLeft || 0);
      }
      function syncRulerScroll() {
        const ruler = $("ruler");
        const scroll = $("timelineScroll");
        if (ruler && scroll) {
          const previewScale = Number(ruler.dataset.zoomPreviewScale || 1);
          ruler.style.transformOrigin = "left top";
          ruler.style.transform = `translateX(${-scroll.scrollLeft}px) scaleX(${previewScale})`;
        }
      }
      function syncPlayheadPosition() {
        const el = $("playhead");
        if (el) el.style.left = `${overlayX(state.currentTime)}px`;
        if ($("rulerTimecode"))
          $("rulerTimecode").textContent = formatTime(state.currentTime, false);
        if ($("timelineBarTimecode"))
          $("timelineBarTimecode").textContent = formatTime(state.currentTime, false);
      }
      function syncTimelineChrome() {
        syncRulerScroll();
        syncPlayheadPosition();
        const snap = $("snapGuide");
        if (snap?.classList.contains("on")) {
          const time = Number(snap.dataset.time);
          if (Number.isFinite(time)) snap.style.left = `${overlayX(time)}px`;
        }
        const blade = $("bladeGuide");
        if (blade?.classList.contains("on")) {
          const time = Number(blade.dataset.time);
          if (Number.isFinite(time)) blade.style.left = `${overlayX(time)}px`;
        }
      }
      function showSnapGuide(time, on) {
        const el = $("snapGuide");
        if (!el) return;
        el.classList.toggle("on", !!on && Number.isFinite(time));
        if (on && Number.isFinite(time)) {
          el.dataset.time = String(time);
          el.style.left = `${overlayX(time)}px`;
        }
      }
      function setBladeGuide(time, on) {
        const el = $("bladeGuide");
        if (!el) return;
        if (!on || !Number.isFinite(time)) {
          el.classList.remove("on");
          return;
        }
        el.classList.add("on");
        el.dataset.time = String(time);
        el.style.left = `${overlayX(time)}px`;
        if ($("bladeTime")) $("bladeTime").textContent = formatTime(time);
      }
      function previewBladeTime(clientX) {
        const raw = timelineTimeFromClientX(clientX);
        const time = !state.snapping || state.snapTemporarilyDisabled ? raw : snapValue(raw, currentSnapPoints(), snapThresholdSeconds()).time;
        return frameAlignedTime(time);
      }
      function hideSnapGuide() {
        $("snapGuide")?.classList.remove("on");
      }
      function snapTime(value, moving = null, options = {}) {
        const subframe = options.subframe || (typeof timelineDrag !== "undefined" && !state.avLinked && ["audio", "audioasset"].includes(timelineDrag?.trimType));
        const align = time => frameBoundedTime(time, options.min ?? 0, options.max ?? Infinity, subframe);
        if (!state.snapping || state.snapTemporarilyDisabled) {
          hideSnapGuide();
          return align(value);
        }
        const result = snapValue(
          value,
          currentSnapPoints(moving, options),
          snapThresholdSeconds(),
        );
        showSnapGuide(result.target, result.snapped);
        return align(result.time);
      }
      function snapClipStart(value, duration, moving = null) {
        const subframe = !state.avLinked && typeof timelineDrag !== "undefined" && ["audio", "audioasset"].includes(timelineDrag?.mainTrackType || timelineDrag?.type);
        const align = time => subframe ? time : frameAlignedTime(time);
        if (!state.snapping || state.snapTemporarilyDisabled) {
          hideSnapGuide();
          return align(value);
        }
        const result = snapClipEdges(
          value,
          duration,
          currentSnapPoints(moving),
          snapThresholdSeconds(),
        );
        showSnapGuide(result.target, result.snapped);
        return align(result.start);
      }
      function toggleSnapping() {
        state.snapping = !state.snapping;
        if (!state.snapping) hideSnapGuide();
        $("snapToggle")?.classList.toggle("active", state.snapping);
        $("snapToggle")?.classList.toggle("primary", state.snapping);
        $("snapToggle").title = state.snapping
          ? "时间线吸附（N）"
          : "吸附已关闭（N）";
        toast(state.snapping ? "时间线吸附已开启：靠近片段边缘和播放头会对齐" : "时间线吸附已关闭");
      }
      function currentStyle() {
        const obj = currentObject();
        const style = state.selected.type === "caption"
          ? state.captionStyle
          : obj?.style || state.captionStyle;
        Object.assign(style, {
          wordSpacing: Number(style.wordSpacing || 0),
          textAlign: style.textAlign || "center",
          verticalAlign: style.verticalAlign || "middle",
          shadowColor: style.shadowColor || "#000000",
          shadowOpacity: Number(style.shadowOpacity ?? 0.8),
          shadowBlur: Number(style.shadowBlur ?? style.shadow ?? 3),
          shadowDistance: Number(style.shadowDistance ?? style.shadow ?? 3),
          shadowAngle: Number(style.shadowAngle ?? 45),
          backgroundMode: style.backgroundMode || "block",
          backgroundFitText: style.backgroundFitText !== false,
          backgroundWidth: Number(style.backgroundWidth ?? style.padding ?? 14),
          backgroundHeight: Number(style.backgroundHeight ?? style.padding ?? 14),
          backgroundX: Number(style.backgroundX || 0),
          backgroundY: Number(style.backgroundY || 0),
        });
        return style;
      }
      function removedDuration() {
        return state.removals.reduce((sum, r) => sum + (r.end - r.start), 0);
      }
      function normalizeRemovals() {
        state.removals.sort((a, b) => a.start - b.start);
        const out = [];
        for (const r of state.removals) {
          const p = out[out.length - 1];
          if (p && r.start <= p.end + 0.008) p.end = Math.max(p.end, r.end);
          else out.push({ ...r });
        }
        state.removals = out;
        const mainDuration = mainContentEnd();
        state.duration = Math.max(mainDuration, dynamicContentEnd());
        state.timelineDuration = Math.max(60, state.duration + 10);
        clampTracksToDuration();
      }
      function dynamicContentEnd() {
        let end = 0;
        for (const list of [
          state.videoLayers,
          state.audioAssets,
          state.images,
          state.titles,
        ])
          for (const item of list || []) end = Math.max(end, Number(item.end || 0));
        return end;
      }
      function trackIsVisible(trackId, fallback) {
        return state.trackVisibility[trackId || fallback] !== false;
      }
      function exportContentEnd(audioOnly = false) {
        let end = 0;
        const include = (item, fallback) => {
          if (trackIsVisible(item.trackId, fallback))
            end = Math.max(end, Number(item.end || 0));
        };
        if (!audioOnly)
          for (const clip of mainClips())
            include(
              { ...clip, trackId: state.mainVideoTrackMap?.[clip.id] || "video" },
              "video",
            );
        for (const clip of mainAudioClips())
          include(
            { ...clip, trackId: state.mainAudioTrackMap?.[clip.id] || "audio" },
            "audio",
          );
        if (!audioOnly)
          for (const item of state.videoLayers || []) include(item, "video");
        for (const item of state.audioAssets || []) include(item, "audio");
        if (!audioOnly) {
          for (const item of state.images || []) include(item, "image");
          for (const item of state.titles || []) include(item, "text");
        }
        return end;
      }
      function visibleTimelineDuration() {
        return Math.max(60, Number(state.timelineDuration || 0), state.duration + 10);
      }
      function recomputeContentDuration() {
        const mainDuration = mainContentEnd();
        state.duration = Math.max(mainDuration, dynamicContentEnd());
        state.timelineDuration = Math.max(60, state.duration + 10);
        state.currentTime = clamp(state.currentTime, 0, visibleTimelineDuration());
      }
      function clampTrackItem(item) {
        if (!item) return false;
        item.start = Math.max(0, Number(item.start) || 0);
        item.end = Math.max(item.start, Number(item.end) || item.start);
        return item.end > item.start + 0.001;
      }
      function clampTracksToDuration() {
        for (const key of [
          "audioAssets",
          "videoLayers",
          "images",
          "titles",
          "captions",
          "reviewCaptions",
          "issues",
          "audioMutes",
        ]) {
          state[key] = (state[key] || []).filter(clampTrackItem);
        }
        const materialEnd = Math.max(mainContentEnd(), dynamicContentEnd());
        for (const key of ["captions", "reviewCaptions", "issues"])
          state[key] = (state[key] || [])
            .filter((item) => Number(item.start || 0) < materialEnd)
            .map((item) => ({
              ...item,
              end: Math.min(materialEnd, Math.max(Number(item.start || 0) + 0.04, Number(item.end || 0))),
            }))
            .filter((item) => item.end > item.start + 0.001);
        state.audioCuts = (state.audioCuts || []).filter(
          (time) => time > 0 && time < state.duration,
        );
        recomputeContentDuration();
      }
      function skipDeadSource(source) {
        let time = Number(source || 0);
        for (let step = 0; step <= (state.removals || []).length; step += 1) {
          const inside = (state.removals || []).find(
            (range) => time >= range.start && time < range.end - 1e-7,
          );
          if (inside) {
            time = inside.end;
            continue;
          }
          break;
        }
        const duration = Number($("video")?.duration || state.sourceDuration || 0);
        if (duration > 0) time = Math.min(time, duration);
        return time;
      }
      function mapSourceTime(time) {
        const clips = mainClips();
        const clip = clips.find(
          (item) => time >= item.sourceStart && time <= item.sourceEnd,
        );
        if (clip) {
          const sourceSpan = Math.max(0.001, Number(clip.sourceEnd) - Number(clip.sourceStart));
          const timelineSpan = Math.max(0.001, Number(clip.end) - Number(clip.start));
          return Number(clip.start) + Math.max(0, time - Number(clip.sourceStart)) * timelineSpan / sourceSpan;
        }
        const next = clips.find((item) => item.sourceStart > time);
        return next?.start ?? clips.at(-1)?.end ?? 0;
      }
      function timelineToSource(time) {
        const value = Math.max(0, Number(time || 0));
        const clips = [...mainClips()].sort((a, b) => a.start - b.start);
        const clip = clips.find(
          (item) => value >= item.start && value < item.end,
        );
        if (clip) {
          const sourceSpan = Math.max(0.001, Number(clip.sourceEnd) - Number(clip.sourceStart));
          const timelineSpan = Math.max(0.001, Number(clip.end) - Number(clip.start));
          return Math.min(
            clip.sourceEnd,
            Number(clip.sourceStart) + Math.max(0, value - Number(clip.start)) * sourceSpan / timelineSpan,
          );
        }
        const next = clips.find((item) => item.start > value);
        return next?.sourceStart ?? clips.at(-1)?.sourceEnd ?? 0;
      }
      
