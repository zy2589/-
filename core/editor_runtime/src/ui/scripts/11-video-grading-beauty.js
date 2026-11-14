function selectedVideoGrade(create = false) {
        const selected = state.selected || { type: "video", id: "main" };
        let target = null;
        if (selected.type === "video") {
          const clip = selected.id === "main"
            ? activeMainVideoClip?.()
            : mainClips().find((item) => item.id === selected.id);
          if (clip) {
            const settings = mainVideoSettings(clip);
            if (settings) target = { type: "video", id: clip.id, settings };
          }
        } else if (selected.type === "videolayer") {
          const clip = state.videoLayers.find((item) => item.id === selected.id);
          if (clip) target = { type: "videolayer", id: clip.id, settings: clip };
        }
        if (!target) return null;
        if (!target.settings.color) {
          target.settings.color = JSON.parse(JSON.stringify(state.color || {}));
        }
        return target.settings.color || null;
      }
      function colorPreviewFilter(color = {}) {
        const c = color || {};
        const sliceValues = Object.values(c.slices || {});
        const sliceHue = sliceValues.reduce((sum, item) => sum + Number(item?.hue || 0), 0) / 7;
        const sliceSaturation = sliceValues.reduce((sum, item) => sum + Number(item?.saturation || 0), 0) / 7;
        const sliceIntensity = sliceValues.reduce((sum, item) => sum + Number(item?.intensity || 0), 0) / 7;
        const
          brightness = Math.max(
            0.1,
            1 +
              ((c.exposure || 0) +
                (c.lift || 0) * 0.24 +
                (c.gain || 0) * 0.3 +
                (c.gamma || 0) * 0.35 +
                (c.shadows || 0) * 0.13 +
                (c.highlights || 0) * 0.11 +
                (c.blacks || 0) * 0.08 +
                (c.whites || 0) * 0.1 +
                (c.pivot || 0) * -0.08 +
                sliceIntensity * 0.35) /
                78,
          ),
          contrast = Math.max(
            0.1,
            1 +
              ((c.contrast || 0) +
                (c.midtoneDetail || 0) * 0.42 +
                (c.sharpness || 0) * 0.08 -
                (c.fade || 0) * 0.48 +
                (c.gain || 0) * 0.12 -
                (c.lift || 0) * 0.12) /
                72,
          ),
          saturation = Math.max(
            0,
            1 + ((c.saturation || 0) + (c.vibrance || 0) * 0.7 + sliceSaturation * 0.5) / 70,
          ),
          sepia = Math.abs(c.temperature || 0) / 360,
          rotate =
            (c.hue || 0) * 1.8 +
            (c.tint || 0) * 0.35 -
            (c.temperature || 0) * 0.2 +
            sliceHue * 0.6;
        return `brightness(${Math.max(0.1, brightness)}) contrast(${Math.max(0.1, contrast)}) saturate(${Math.max(0, saturation)}) sepia(${Math.min(1, sepia)}) hue-rotate(${rotate}deg)`;
      }
      function syncSelectedClipColor() {
        const grade = selectedVideoGrade(false);
        const available = !!grade;
        const name = state.selected?.type === "videolayer"
          ? state.videoLayers.find((item) => item.id === state.selected.id)?.name
          : (state.selected?.id === "main" ? state.video?.name : mainClips().find((item) => item.id === state.selected?.id)?.name) || state.video?.name;
        const hint = $("colorSelectionHint");
        if (hint) hint.textContent = available
          ? `当前调色对象：${String(name || "所选视频").split(/[\\/]/).at(-1)} · 只影响此片段`
          : "请先在时间轨上选中一个视频片段，再进行单独调色。";
        const values = grade || state.color || {};
        document.querySelectorAll("#colorControls [data-color]").forEach((input) => {
          input.value = Number(values[input.dataset.color] || 0);
          input.disabled = !available;
          const output = $(`${input.dataset.color}Out`);
          if (output) output.textContent = input.value;
        });
        document.querySelectorAll("#colorControls [data-color-slice]").forEach((input) => {
          input.value = Number(values.slices?.[input.dataset.colorSlice]?.[input.dataset.sliceProperty] || 0);
          input.disabled = !available;
          const output = $(`slice-${input.dataset.colorSlice}-${input.dataset.sliceProperty}-out`);
          if (output) output.textContent = input.value;
        });
        document.querySelectorAll("[data-grade-preset]").forEach((button) => { button.disabled = !available; });
        if ($("resetColor")) $("resetColor").disabled = !available;
      }
      function applyVideoCss() {
        const activeMain = activeMainVideoClip?.();
        const mainGrade = activeMain ? mainVideoSettings(activeMain)?.color : null;
        const selectedTarget = state.selected || {};
        const mainColor = state.colorBypass && selectedTarget.type === "video" && (!selectedTarget.id || selectedTarget.id === "main" || selectedTarget.id === activeMain?.id)
          ? {}
          : mainGrade || state.color || {};
        const beauty = state.beautyBypass ? {} : state.beauty;
        const smooth = Math.max(0, Number(beauty.smoothing || 0)) / 100;
        const blemish = Math.max(0, Number(beauty.blemish || 0)) / 100;
        const detail = Math.max(0, Number(beauty.texture || 0)) / 100;
        const whitening = Math.max(0, Number(beauty.whitening || 0)) / 100;
        const warmth = Number(beauty.warmth || 0) / 50;
        const brighten = Number(beauty.brighten || 0) / 100;
        const rosy = Number(beauty.rosy || 0) / 100;
        const beautyFilter = `brightness(${Math.max(0.1, 1 + brighten * 0.08)}) sepia(${Math.min(1, Math.max(0, warmth) * 0.03)})`;
        // A lightweight CSS pass is deliberately kept underneath the GPU
        // canvas.  WebKit can reject video-to-WebGL uploads for a local media
        // URL; in that case beauty controls must still change the picture.
        // 美颜失败时宁可显示原片，也不再用全画面 blur/brightness 伪造美颜，避免天空和背景一起变亮变糊。
        const beautyFallback = "";
        const v1 = $("video");
        const v2 = $("videoAlt");
        if (v1) {
          v1.style.filter = `${colorPreviewFilter(mainColor)} ${beautyFilter}${beautyFallback}`;
          v1.muted = state.trackVisibility.audio === false;
          applyMediaPlaybackRate(v1);
        }
        if (v2) {
          v2.style.filter = `${colorPreviewFilter(mainColor)} ${beautyFilter}${beautyFallback}`;
          v2.muted = state.trackVisibility.audio === false;
          applyMediaPlaybackRate(v2);
        }
        $("beautyPreviewCanvas").style.filter = `${colorPreviewFilter(mainColor)} ${beautyFilter}`;
        if ($("beautyPreviewFallbackCanvas")) $("beautyPreviewFallbackCanvas").style.filter = `${colorPreviewFilter(mainColor)} ${beautyFilter}`;
        document
          .querySelectorAll(".layer-video-decoder")
          .forEach((element) => {
            const item = state.videoLayers.find((clip) => clip.id === element.dataset.id);
            const bypass = state.colorBypass && selectedTarget.type === "videolayer" && selectedTarget.id === item?.id;
            element.style.filter = `${colorPreviewFilter(bypass ? {} : item?.color || state.color || {})} ${beautyFilter}${beautyFallback}`;
          });
        $("frame").style.setProperty(
          "--vignette-opacity",
          String(Math.min(0.9, Number(mainColor.vignette || 0) / 105)),
        );
        updateBeautyPreviewState();
      }
      window.selectedVideoGrade = selectedVideoGrade;
      window.syncSelectedClipColor = syncSelectedClipColor;
      let beautyGL = null, beautyGLUnavailable = false,
        beautyFrameRequest = 0, beautyLastDraw = 0, beauty2DCanvas = null,
        faceLandmarker = null, faceLandmarkerPromise = null, faceLandmarkerUnavailable = false,
        faceLandmarkerLastRun = 0, faceLandmarkerTimestamp = 0, faceMaskCanvas = null,
        faceMaskShapeCanvas = null, faceMaskData = null, faceMaskFrameTime = -1,
        faceMaskSourceId = "";
      const faceOvalIndices = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
      const faceFeatureHoles = [
        [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
        [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398],
        [46,53,52,65,55,70,63,105,66,107],
        [276,283,282,295,285,300,293,334,296,336],
        [61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95,78],
      ];
      async function ensureFaceLandmarker() {
        if (faceLandmarker || faceLandmarkerUnavailable) return faceLandmarker;
        if (!faceLandmarkerPromise) faceLandmarkerPromise = (async () => {
          if (!window.Vision?.FilesetResolver || !window.Vision?.FaceLandmarker) throw new Error("MediaPipe runtime is unavailable");
          const appRoot = new URL("/", window.location.href);
          const visionFiles = await Vision.FilesetResolver.forVisionTasks(new URL("ui/vendor/mediapipe/wasm/", appRoot).href);
          faceLandmarker = await Vision.FaceLandmarker.createFromOptions(visionFiles, {
            baseOptions: { modelAssetPath: new URL("assets/models/face_landmarker.task", appRoot).href, delegate: "CPU" },
            runningMode: "VIDEO", numFaces: 1, minFaceDetectionConfidence: 0.5,
            minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.55,
          });
          const status = $("blemishStatus");
          if (status) status.textContent = "AI 人脸定位已就绪 · 正在皮肤区域修图";
          return faceLandmarker;
        })().catch((error) => {
          faceLandmarkerUnavailable = true;
          const status = $("blemishStatus");
          if (status) status.textContent = "AI 人脸模型加载失败 · 使用兼容修图";
          console.warn("Face Landmarker unavailable:", error);
          return null;
        });
        return faceLandmarkerPromise;
      }
      function buildFaceSkinMask(video, width, height, now) {
        const frameTime = Number(video.currentTime || 0);
        const sourceId = String(video.currentSrc || video.src || "");
        if (faceMaskCanvas && faceMaskCanvas.width === width && faceMaskCanvas.height === height &&
            faceMaskSourceId === sourceId && Math.abs(frameTime - faceMaskFrameTime) < 0.035) return faceMaskData;
        if (!faceLandmarker || now - faceLandmarkerLastRun < 85) return faceMaskData;
        faceLandmarkerLastRun = now;
        faceMaskSourceId = sourceId;
        faceMaskFrameTime = frameTime;
        if (faceMaskCanvas?.width !== width || faceMaskCanvas?.height !== height) {
          faceMaskCanvas = document.createElement("canvas"); faceMaskCanvas.width = width; faceMaskCanvas.height = height;
          faceMaskShapeCanvas = document.createElement("canvas"); faceMaskShapeCanvas.width = width; faceMaskShapeCanvas.height = height;
          faceMaskData = null;
        }
        const shapeCtx = faceMaskShapeCanvas.getContext("2d");
        const maskCtx = faceMaskCanvas.getContext("2d", { willReadFrequently: true });
        shapeCtx.clearRect(0, 0, width, height);
        let result;
        try {
          faceLandmarkerTimestamp = Math.max(Math.round(now), faceLandmarkerTimestamp + 1);
          result = faceLandmarker.detectForVideo(video, faceLandmarkerTimestamp);
        } catch (error) {
          console.warn("Face Landmarker frame failed:", error);
          faceMaskData = null;
          return null;
        }
        const landmarks = result?.faceLandmarks?.[0];
        if (!landmarks || landmarks.length < 400) {
          faceMaskData = null;
          return null;
        }
        const trace = (indices) => {
          shapeCtx.beginPath();
          indices.forEach((index, offset) => {
            const point = landmarks[index]; if (!point) return;
            const x = point.x * width, y = point.y * height;
            if (!offset) shapeCtx.moveTo(x, y); else shapeCtx.lineTo(x, y);
          });
          shapeCtx.closePath();
        };
        shapeCtx.fillStyle = "#fff"; trace(faceOvalIndices); shapeCtx.fill();
        shapeCtx.globalCompositeOperation = "destination-out";
        for (const hole of faceFeatureHoles) { trace(hole); shapeCtx.fill(); }
        shapeCtx.globalCompositeOperation = "source-over";
        maskCtx.clearRect(0, 0, width, height);
        maskCtx.filter = `blur(${Math.max(1.5, width / 240).toFixed(1)}px)`;
        maskCtx.drawImage(faceMaskShapeCanvas, 0, 0);
        maskCtx.filter = "none";
        faceMaskData = maskCtx.getImageData(0, 0, width, height).data;
        return faceMaskData;
      }
      // Reuse the face model for one-click spot selection. This keeps
      // candidates on the detected face and avoids selecting background.
      window.__portraitFaceTools = {
        async skinMask(video, width, height) {
          await ensureFaceLandmarker();
          if (!faceLandmarker || !video || video.readyState < 2) return null;
          faceLandmarkerLastRun = -Infinity;
          return buildFaceSkinMask(video, width, height, performance.now());
        },
      };
      function beautyIsActive() {
        if (state.beautyBypass) return false;
        const beauty = state.beauty || {};
        return ["smoothing", "blemish", "texture", "whitening", "brighten", "warmth", "rosy"]
          .some((key) => Math.abs(Number(beauty[key] || 0)) > .01);
      }
      function compileBeautyShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || "Beauty shader compile failed");
        return shader;
      }
      function ensureBeautyGL() {
        if (beautyGL) return beautyGL;
        if (beautyGLUnavailable) return null;
        const canvas = $("beautyPreviewCanvas"), gl = canvas.getContext("webgl", {
          alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        });
        if (!gl) { beautyGLUnavailable = true; return null; }
        try {
        const vertex = compileBeautyShader(gl, gl.VERTEX_SHADER,
          `attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}`),
          fragment = compileBeautyShader(gl, gl.FRAGMENT_SHADER, `
            precision mediump float;varying vec2 uv;uniform sampler2D image;uniform vec2 texel;
            uniform float smoothness,blemish,detail,whitening,brighten,warmth,rosy;
            float skinMask(vec3 c){
              float mx=max(c.r,max(c.g,c.b)),mn=min(c.r,min(c.g,c.b));
              float warm=smoothstep(.015,.10,c.r-c.g)*smoothstep(-.02,.10,c.g-c.b);
              float chroma=smoothstep(.035,.14,mx-mn);
              float lum=smoothstep(.10,.28,dot(c,vec3(.299,.587,.114)))*(1.-smoothstep(.88,1.,dot(c,vec3(.299,.587,.114))));
              return clamp(warm*chroma*lum,0.,1.);
            }
            void main(){vec3 c=texture2D(image,uv).rgb;float mask=skinMask(c);float r=1.+smoothness*2.0+blemish*2.8;
            vec2 x=vec2(texel.x*r,0.),y=vec2(0.,texel.y*r);vec3 s=c*2.;float w=2.;
            vec3 a=texture2D(image,uv+x).rgb,b=texture2D(image,uv-x).rgb,d=texture2D(image,uv+y).rgb,e=texture2D(image,uv-y).rgb;
            float edge=20.+28.*(1.-blemish),wa=exp(-dot(a-c,a-c)*edge),wb=exp(-dot(b-c,b-c)*edge),wd=exp(-dot(d-c,d-c)*edge),we=exp(-dot(e-c,e-c)*edge);
            s+=a*wa+b*wb+d*wd+e*we;w+=wa+wb+wd+we;vec3 soft=s/w;
            vec3 skin=mix(c,soft,clamp((smoothness*.62+blemish*.44)*mask,0.,.82));skin+=(c-soft)*detail*.55*mask;
            skin=mix(skin,pow(max(skin,vec3(0.)),vec3(.78)),whitening*.58*mask);skin*=1.+brighten*.13*mask;
            skin.r+=(warmth*.030+rosy*.024)*mask;skin.b-=warmth*.020*mask;skin.g-=rosy*.009*mask;
            gl_FragColor=vec4(clamp(skin,0.,1.),1.);}`), program = gl.createProgram();
        gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Beauty shader link failed");
        gl.useProgram(program);
        const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "p");
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
        const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const names = ["texel", "smoothness", "blemish", "detail", "whitening", "brighten", "warmth", "rosy"];
        beautyGL = { gl, texture, uniforms: Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)])) };
        return beautyGL;
        } catch {
          beautyGLUnavailable = true;
          canvas.classList.remove("ready");
          return null;
        }
      }
      function drawBeautyPreview(now = performance.now()) {
        beautyFrameRequest = 0;
        const canvas = $("beautyPreviewCanvas");
        const fallbackCanvas = $("beautyPreviewFallbackCanvas");
        const video = (typeof getActiveVideo === "function") ? getActiveVideo() : $("video");
        if (!beautyIsActive() || !state.video || !video || video.readyState < 2) return;
        if (now - beautyLastDraw < 32) { beautyFrameRequest = requestAnimationFrame(drawBeautyPreview); return; }
        beautyLastDraw = now;
        if (faceLandmarker || faceLandmarkerPromise) {
          canvas.classList.remove("ready");
          drawBeautyPreview2D(fallbackCanvas, video);
          if (state.playing) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
          return;
        }
        const engine = ensureBeautyGL();
        if (!engine) {
          // WebKit/CEF can reject direct video->WebGL uploads for local media.
          // Fall back to a small 2D compositor with a skin-color mask instead of
          // making the beauty controls appear dead or applying a global blur.
          drawBeautyPreview2D(fallbackCanvas, video);
          if (state.playing) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
          return;
        }
        const maxSide = 720, vw = video.videoWidth || state.width, vh = video.videoHeight || state.height,
          scale = Math.min(1, maxSide / Math.max(vw, vh)), width = Math.max(2, Math.round(vw * scale)), height = Math.max(2, Math.round(vh * scale));
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; engine.gl.viewport(0, 0, width, height); }
        const { gl, texture, uniforms } = engine, beauty = state.beauty || {};
        gl.bindTexture(gl.TEXTURE_2D, texture);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); }
        catch {
          beautyGLUnavailable = true;
          canvas.classList.remove("ready");
          drawBeautyPreview2D(fallbackCanvas, video);
          if (state.playing) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
          return;
        }
        gl.uniform2f(uniforms.texel, 1 / width, 1 / height);
        gl.uniform1f(uniforms.smoothness, clamp(Number(beauty.smoothing || 0) / 100, 0, 1));
        gl.uniform1f(uniforms.blemish, clamp(Number(beauty.blemish || 0) / 100, 0, 1));
        gl.uniform1f(uniforms.detail, clamp(Number(beauty.texture || 0) / 100, 0, 1));
        gl.uniform1f(uniforms.whitening, clamp(Number(beauty.whitening || 0) / 100, 0, 1));
        gl.uniform1f(uniforms.brighten, clamp(Number(beauty.brighten || 0) / 100, 0, 1));
        gl.uniform1f(uniforms.warmth, clamp(Number(beauty.warmth || 0) / 100, -1, 1));
        gl.uniform1f(uniforms.rosy, clamp(Number(beauty.rosy || 0) / 100, 0, 1));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (gl.getError() === gl.NO_ERROR) { canvas.classList.add("ready"); fallbackCanvas.classList.remove("ready"); }
        else {
          beautyGLUnavailable = true;
          canvas.classList.remove("ready");
          drawBeautyPreview2D(fallbackCanvas, video);
        }
        if (state.playing) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
      }
      function skinProbability(r, g, b) {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const warm = clamp((r - g - 3) / 28, 0, 1) * clamp((g - b + 10) / 30, 0, 1);
        const chroma = clamp((mx - mn - 10) / 34, 0, 1);
        const luminance = clamp((lum - 0.10) / 0.16, 0, 1) * clamp((0.96 - lum) / 0.14, 0, 1);
        return clamp(warm * chroma * luminance, 0, 1);
      }
      function drawBeautyPreview2D(canvas, video) {
        try {
          const beauty = state.beauty || {};
          const maxSide = 460, vw = video.videoWidth || state.width, vh = video.videoHeight || state.height;
          const scale = Math.min(1, maxSide / Math.max(vw, vh));
          const width = Math.max(2, Math.round(vw * scale)), height = Math.max(2, Math.round(vh * scale));
          if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
          const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
          if (!ctx) return;
          ctx.drawImage(video, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height), data = image.data;
          if (!beauty2DCanvas) beauty2DCanvas = document.createElement("canvas");
          if (beauty2DCanvas.width !== width || beauty2DCanvas.height !== height) { beauty2DCanvas.width = width; beauty2DCanvas.height = height; }
          const softCtx = beauty2DCanvas.getContext("2d", { willReadFrequently: true, alpha: false });
          const smoothing = clamp(Number(beauty.smoothing || 0) / 100, 0, 1);
          const blemish = clamp(Number(beauty.blemish || 0) / 100, 0, 1);
          const texture = clamp(Number(beauty.texture || 0) / 100, 0, 1);
          const blur = 0.5 + Math.max(smoothing, blemish) * 2.6;
          softCtx.clearRect(0, 0, width, height);
          softCtx.filter = `blur(${blur.toFixed(2)}px)`;
          softCtx.drawImage(video, 0, 0, width, height);
          softCtx.filter = "none";
          const softened = softCtx.getImageData(0, 0, width, height).data;
          const whitening = clamp(Number(beauty.whitening || 0) / 100, 0, 1);
          const brighten = clamp(Number(beauty.brighten || 0) / 100, -1, 1);
          const warmth = clamp(Number(beauty.warmth || 0) / 100, -1, 1);
          const rosy = clamp(Number(beauty.rosy || 0) / 100, -1, 1);
          const faceMask = faceLandmarker ? buildFaceSkinMask(video, width, height, performance.now()) : null;
          // Blend a lightly blurred pass only into skin pixels. High-contrast
          // edges are protected, and a small amount of source detail is mixed
          // back so eyes, glasses, lips, and pores do not turn waxy.
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const mask = faceLandmarker ? (faceMask ? faceMask[i + 3] / 255 : 0) : skinProbability(r, g, b);
            if (mask < 0.025) continue;
            const lum = r * .299 + g * .587 + b * .114;
            const sr = softened[i], sg = softened[i + 1], sb = softened[i + 2];
            const softLum = sr * .299 + sg * .587 + sb * .114;
            const edgeProtection = clamp(1 - Math.abs(lum - softLum) / 64, .28, 1);
            const spotContrast = Math.max(
              Math.abs(lum - softLum),
              Math.abs((r - g) - (sr - sg)) * 1.15,
            );
            // Keep the broad smoothing restrained, then add more correction
            // only to local brightness/redness outliers such as spots and acne.
            const spotConfidence = clamp((spotContrast - (7 + texture * 9)) / (24 + texture * 10), 0, 1);
            const blend = clamp(
              (smoothing * .46 + blemish * (.28 + spotConfidence * .52)) * mask * edgeProtection,
              0, .78,
            );
            const detail = texture * .24 * mask;
            let nr = r + (sr - r) * blend + (r - sr) * detail;
            let ng = g + (sg - g) * blend + (g - sg) * detail;
            let nb = b + (sb - b) * blend + (b - sb) * detail;
            const strength = mask;
            const lift = brighten * 18 * strength;
            nr += lift + warmth * 8 * strength + rosy * 7 * strength;
            ng += lift * 0.86 - rosy * 2.0 * strength;
            nb += lift * 0.72 - warmth * 6 * strength;
            const whiten = whitening * .58 * mask;
            nr += (Math.pow(Math.max(0, nr / 255), .78) * 255 - nr) * whiten;
            ng += (Math.pow(Math.max(0, ng / 255), .78) * 255 - ng) * whiten;
            nb += (Math.pow(Math.max(0, nb / 255), .78) * 255 - nb) * whiten;
            data[i] = clamp(Math.round(nr), 0, 255);
            data[i + 1] = clamp(Math.round(ng), 0, 255);
            data[i + 2] = clamp(Math.round(nb), 0, 255);
          }
          ctx.putImageData(image, 0, 0);
          canvas.classList.add("ready");
        } catch {
          canvas.classList.remove("ready");
        }
      }

      function updateBeautyPreviewState() {
        const canvas = $("beautyPreviewCanvas");
        const fallbackCanvas = $("beautyPreviewFallbackCanvas");
        const video = (typeof getActiveVideo === "function") ? getActiveVideo() : $("video");
        const active = beautyIsActive();
        canvas.style.display = active ? "block" : "none";
        if (fallbackCanvas) fallbackCanvas.style.display = active ? "block" : "none";
        if (!active || !video) { canvas.classList.remove("ready"); fallbackCanvas?.classList.remove("ready"); if (beautyFrameRequest) cancelAnimationFrame(beautyFrameRequest); beautyFrameRequest = 0; return; }
        canvas.style.transform = video.style.transform; canvas.style.opacity = video.style.opacity || "1";
        canvas.style.mixBlendMode = video.style.mixBlendMode || "normal";
        if (fallbackCanvas) {
          fallbackCanvas.style.transform = canvas.style.transform;
          fallbackCanvas.style.opacity = canvas.style.opacity;
          fallbackCanvas.style.mixBlendMode = canvas.style.mixBlendMode;
        }
        if (!beautyFrameRequest) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
        if (!faceLandmarkerUnavailable) ensureFaceLandmarker().then(() => {
          if (beautyIsActive() && !beautyFrameRequest) beautyFrameRequest = requestAnimationFrame(drawBeautyPreview);
        });
      }
      
