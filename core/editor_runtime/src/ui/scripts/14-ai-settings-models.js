function filterSpeechLanguageList(query, languages) {
        const q = String(query || "").trim().toLowerCase();
        const list = Array.isArray(languages) ? languages : [];
        if (!q) return list;
        return list.filter((item) =>
          [item.id, item.label, item.english, ...(item.aliases || [])]
            .join(" ")
            .toLowerCase()
            .includes(q),
        );
      }
      function speechLanguageLabel(id) {
        const item = speechLanguageCatalog.find((entry) => entry.id === id);
        return item ? item.label : "英语（默认）";
      }
      function closeSpeechLanguageCombo() {
        $("speechLanguageCombo")?.classList.remove("open");
        if ($("speechLanguageSearch")) $("speechLanguageSearch").value = "";
      }
      function openSpeechLanguageCombo() {
        const combo = $("speechLanguageCombo");
        if (!combo) return;
        combo.classList.add("open");
        const search = $("speechLanguageSearch");
        if (search) {
          search.value = "";
          renderSpeechLanguageOptions($("speechLanguage")?.value || "en", "");
          requestAnimationFrame(() => search.focus());
        }
      }
      function renderSpeechLanguageOptions(selected, query = "") {
        const listEl = $("speechLanguageList");
        const hidden = $("speechLanguage");
        if (hidden && selected) hidden.value = selected;
        if ($("speechLanguageLabel"))
          $("speechLanguageLabel").textContent = speechLanguageLabel(selected || "en");
        if (!listEl) return;
        const list = filterSpeechLanguageList(query, speechLanguageCatalog);
        listEl.innerHTML = list.length
          ? list
              .map(
                (item) =>
                  `<button type="button" class="lang-combo-item${item.id === selected ? " active" : ""}" data-lang="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(item.id)}</button>`,
              )
              .join("")
          : `<div class="small" style="padding:8px">没有匹配的语种</div>`;
      }
      function renderManuscriptLanguageOptions(selected = state.manuscriptLanguage || "en") {
        const select = $("manuscriptLanguage");
        if (!select) return;
        const options = [
          new Option("英语（默认）", "en"),
          new Option("自动检测口播语种", "auto"),
          ...speechLanguageCatalog
            .filter((item) => item.id !== "auto" && item.id !== "en")
            .map((item) => new Option(`${item.label} · ${item.english || item.id}`, item.id)),
        ];
        select.replaceChildren(...options);
        select.value = selected === "en" || selected === "auto" || speechLanguageCatalog.some((item) => item.id === selected) ? selected : "en";
      }
      async function checkModel() {
        try {
          const s = unwrap(await window.native.modelStatus());
          const engine = s.preferredEngine || s.engine || "deepgram";
          if ($("speechEngine")) $("speechEngine").value = engine;
          speechLanguageCatalog = Array.isArray(s.speechLanguages) ? s.speechLanguages : [];
          renderManuscriptLanguageOptions(state.manuscriptLanguage || "en");
          const selectedLanguage = s.speechLanguage || "en";
          renderSpeechLanguageOptions(
            selectedLanguage,
            $("speechLanguageSearch")?.value || "",
          );
          const geminiOn = engine === "gemini";
          const deepgramOn = engine === "deepgram";
          const localOn = engine === "local";
          if ($("groqSpeechSettings")) $("groqSpeechSettings").style.display = engine === "groq" ? "block" : "none";
          if ($("deepgramSpeechSettings")) $("deepgramSpeechSettings").style.display = deepgramOn ? "block" : "none";
          if ($("localSpeechSettings")) $("localSpeechSettings").style.display = localOn ? "block" : "none";
          const localModels = Array.isArray(s.localModels) ? s.localModels : [];
          const selectedLocal = s.localModel || "turbo-q5";
          const localSpec = localModels.find((item) => item.id === selectedLocal) || localModels[0];
          if ($("localWhisperModel")) {
            $("localWhisperModel").innerHTML = localModels
              .map((item) => {
                const mark = item.installed ? " · 已下载" : "";
                const rec = item.recommended ? "（推荐）" : "";
                return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}${rec}${mark}</option>`;
              })
              .join("");
            $("localWhisperModel").value = selectedLocal;
          }
          if ($("localModelHint") && localSpec) {
            const englishOnly = localSpec.englishOnly && selectedLanguage !== "en";
            $("localModelHint").textContent = englishOnly
              ? `${localSpec.label} 只适合英语。识别其他语言请改用 Turbo 或 Large v3。`
              : localSpec.hint || "";
          }
          if ($("downloadLocalModel"))
            $("downloadLocalModel").textContent = s.localInstalled
              ? `重新下载（${localSpec?.sizeLabel || ""}）`
              : `下载这个模型（${localSpec?.sizeLabel || ""}）`;
          if ($("speechEngineHint")) {
            $("speechEngineHint").textContent = geminiOn
              ? "Gemini 听写使用 Gemini API Key 或 Vertex 凭证，独立于文稿纠正提供方；服务繁忙时会自动重试并切换备用 Flash 模型。只上传音频，时间戳由模型估算。专有名词会按常用写法大写。"
              : deepgramOn
                ? "Deepgram Nova-3 词级时间戳，适合口播对齐。只上传音频。"
                : localOn
                  ? "本机 Whisper，不上传音频。有独显会更快。默认用 Turbo Q5。"
                  : "Groq 用 Whisper 听写。纠正可用 Gemini API、Vertex 或 Antigravity CLI。";
          }
          const groqHint = s.groq?.hint ? `（${s.groq.hint}）` : "";
          const deepgramHint = s.deepgram?.hint ? `（${s.deepgram.hint}）` : "";
          if (s.engine === "gemini") {
            $("modelBox").className = "status good";
            $("modelBox").textContent = `听写：Gemini（${s.gemini?.model || "gemini-3.7-flash"}）。凭证独立于当前纠正提供方。`;
          } else if (s.engine === "deepgram") {
            $("modelBox").className = "status good";
            $("modelBox").textContent = `听写：Deepgram Nova-3。纠正：Gemini / Vertex。${deepgramHint}`;
          } else if (s.engine === "groq") {
            $("modelBox").className = "status good";
            $("modelBox").textContent = `听写：Groq。纠正：Gemini / Vertex / Antigravity CLI。经文差异仅提示，不影响导出。${groqHint}`;
          } else if (s.engine === "local" && s.localInstalled) {
            $("modelBox").className = "status good";
            $("modelBox").textContent = `听写：本地 ${localSpec?.label || "Whisper"}。可离线匹配。`;
          } else if (geminiOn) {
            $("modelBox").className = "status warn";
            $("modelBox").textContent = "听写选了 Gemini，请保存 Gemini API Key，或配置 Vertex Key / 服务账号。";
          } else if (deepgramOn) {
            $("modelBox").className = "status warn";
            $("modelBox").textContent = "听写选了 Deepgram，请先保存 Deepgram API Key。";
          } else if (localOn) {
            $("modelBox").className = "status warn";
            $("modelBox").textContent = `听写选了本地 Whisper，请先下载 ${localSpec?.label || "当前模型"}（${localSpec?.sizeLabel || "模型文件"}）。`;
          } else {
            $("modelBox").className = "status warn";
            $("modelBox").textContent = "还没有 Key。保存 Groq / Deepgram Key，或改用 Gemini / 本地 Whisper。";
          }
        } catch (e) {
          $("modelBox").className = "status error";
          $("modelBox").textContent = e.message;
        }
      }
      function toggleReviewProviderFields() {
        const provider = $("reviewProvider")?.value;
        if ($("geminiSettings")) $("geminiSettings").style.display = provider === "gemini" ? "block" : "none";
        if ($("vertexSettings")) $("vertexSettings").style.display = provider === "vertex" ? "block" : "none";
        if ($("antigravitySettings")) $("antigravitySettings").style.display = provider === "antigravity" ? "block" : "none";
      }
      function applyReviewModelList(settings) {
        $("reviewModel").innerHTML = (settings.models || [])
          .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`)
          .join("");
        const selected = settings.model || "gemini-3.7-flash";
        $("reviewModel").value = selected;
        if ($("reviewModel").value !== selected && selected) {
          const option = document.createElement("option");
          option.value = selected;
          option.textContent = selected;
          $("reviewModel").appendChild(option);
          $("reviewModel").value = selected;
        }
        const source = settings.modelSource || "fallback";
        const provider = $("reviewProvider").value;
        if (provider === "antigravity") {
          if (source === "live") {
            $("geminiModelHint").textContent = "已从本机 agy models 拉取 Gemini 套餐可用模型。";
          } else if (source === "cache") {
            $("geminiModelHint").textContent = "使用最近一次 agy models 缓存。找不到 agy 时先指定路径再拉取。";
          } else {
            $("geminiModelHint").textContent = "当前是 Antigravity 内置 Gemini 清单。安装并登录 agy 后可拉取你套餐里的模型。";
          }
        } else if (source === "live") {
          $("geminiModelHint").textContent = "已从 Google 拉取当前账号可用的文本模型。";
        } else if (source === "cache") {
          $("geminiModelHint").textContent = "使用最近拉取的模型缓存。保存 Key 后可再点「拉取最新」。";
        } else {
          $("geminiModelHint").textContent = "当前是 2026-08 官方内置清单。保存 Key 后可拉取你账号里的最新模型。";
        }
      }
      function applyAntigravityHint(settings) {
        if ($("antigravityPath")) {
          $("antigravityPath").value = settings.antigravityPath || settings.antigravityCli || "";
        }
        if ($("antigravityHint")) {
          $("antigravityHint").textContent = settings.antigravityHint || "";
          const state = settings.antigravityState || (settings.antigravityReady ? "installed" : "missing");
          $("antigravityHint").className =
            state === "ready" ? "status good" : state === "error" ? "status error" : "status warn";
        }
      }
      async function fillReviewSettings(preset) {
        const settings = preset || unwrap(await window.native.reviewSettings());
        const defaults = unwrap(await window.native.defaultReviewPrompts());
        $("reviewProvider").value = settings.provider || "gemini";
        applyReviewModelList(settings);
        $("vertexProject").value = settings.vertexProject || "";
        $("vertexLocation").value = settings.vertexLocation || "us-central1";
        $("promptStrict").value = settings.promptStrict || defaults.strict || "";
        $("promptNatural").value = settings.promptNatural || defaults.natural || "";
        $("geminiKeyHint").textContent = settings.geminiHint
          ? `已保存 ${settings.geminiHint}`
          : "还没有 Gemini API Key";
        $("vertexKeyHint").textContent = settings.vertexServiceAccount
          ? "已导入服务账号，将用 OAuth 访问项目接口。"
          : settings.vertexHint
            ? `已保存 ${settings.vertexHint}。只用 Key 时走 Express，不会打项目接口。`
            : "还没有 Vertex Key / 服务账号。项目接口不接受 API Key。";
        applyAntigravityHint(settings);
        toggleReviewProviderFields();
      }
      async function refreshGeminiModels() {
        if ($("geminiModelHint")) {
          $("geminiModelHint").textContent =
            $("reviewProvider")?.value === "antigravity"
              ? "正在从本机 agy 拉取模型…"
              : "正在从 Google 拉取最新模型…";
        }
        const settings = unwrap(await window.native.refreshGeminiModels());
        applyReviewModelList(settings);
        toast(
          settings.modelSource === "live"
            ? settings.provider === "antigravity"
              ? "已拉取 Antigravity 可用模型"
              : "已拉取最新 Gemini 模型"
            : "拉取失败，仍用内置清单",
        );
      }
      async function openReviewSettings() {
        const modal = $("reviewSettingsModal");
        if (modal) modal.classList.add("on");
        try {
          await fillReviewSettings();
        } catch (e) {
          toast(e.message || "纠正设置打开失败");
        }
      }
      async function persistReviewSettings() {
        unwrap(
          await window.native.saveReviewSettings({
            provider: $("reviewProvider").value,
            model: $("reviewModel").value,
            vertexProject: $("vertexProject").value,
            vertexLocation: $("vertexLocation").value,
            antigravityPath: $("antigravityPath")?.value || "",
            promptStrict: $("promptStrict").value,
            promptNatural: $("promptNatural").value,
          }),
        );
      }
      async function saveGeminiKey() {
        unwrap(
          await window.native.saveReviewSettings({
            provider: "gemini",
            geminiKey: $("geminiKeyInput").value,
          }),
        );
        $("geminiKeyInput").value = "";
        await fillReviewSettings();
        toast("Gemini API Key 已保存");
      }
      async function saveVertexSettings() {
        unwrap(
          await window.native.saveReviewSettings({
            provider: "vertex",
            vertexProject: $("vertexProject").value,
            vertexLocation: $("vertexLocation").value,
            vertexKey: $("vertexKeyInput").value,
          }),
        );
        $("vertexKeyInput").value = "";
        await fillReviewSettings();
        toast("Vertex 设置已保存");
      }
      async function saveDeepgramKey() {
        try {
          unwrap(await window.native.saveDeepgramApiKey($("deepgramKeyInput").value));
          $("deepgramKeyInput").value = "";
          await checkModel();
          toast("Deepgram API Key 已保存");
        } catch (e) {
          toast(e.message);
        }
      }
      async function clearDeepgramKey() {
        try {
          unwrap(await window.native.clearDeepgramApiKey());
          $("deepgramKeyInput").value = "";
          await checkModel();
          toast("已清除 Deepgram Key");
        } catch (e) {
          toast(e.message);
        }
      }
      async function saveGroqKey() {
        try {
          unwrap(await window.native.saveGroqApiKey($("groqKeyInput").value));
          $("groqKeyInput").value = "";
          await checkModel();
          toast("Groq API Key 已保存");
        } catch (e) {
          toast(e.message);
        }
      }
      async function clearGroqKey() {
        try {
          unwrap(await window.native.clearGroqApiKey());
          $("groqKeyInput").value = "";
          await checkModel();
          toast("已清除本机保存的 Groq Key");
        } catch (e) {
          toast(e.message);
        }
      }
      async function downloadModel() {
        try {
          const { jobId } = unwrap(
            await window.native.startModelDownload({
              model: $("localWhisperModel")?.value || "",
            }),
          );
          $("modelProgress").style.display = "block";
          $("modelBox").textContent = "正在下载本地模型……";
          while (true) {
            await new Promise((r) => setTimeout(r, 700));
            const s = unwrap(await window.native.modelDownloadStatus(jobId));
            $("modelProgress").firstElementChild.style.width =
              `${s.progress * 100}%`;
            if (s.state === "completed") {
              $("modelProgress").style.display = "none";
              toast("模型下载完成");
              await checkModel();
              return true;
            }
            if (s.state === "failed") throw new Error(s.error);
            if (s.state === "cancelled") throw new Error('模型下载已取消');
            if (s.state === "cancelled") throw new Error("模型下载已取消");
          }
        } catch (e) {
          $("modelProgress").style.display = "none";
          $("modelBox").textContent = e.message;
          toast(e.message);
          return false;
        }
      }
      async function matchScript({alignmentOnly = false, forceRecognition = false} = {}) {
        if (!state.video) {
          toast("请先导入视频");
          return false;
        }
        if (!$("scriptText").value.trim()) {
          toast("请先粘贴正确文案");
          return false;
        }
        let matchJobId='';
        try {
          const matchContext = createAutoCaptionContext();
          const model = unwrap(await window.native.modelStatus());
          assertAutoCaptionContext(matchContext);
          if (!model.ready && !model.installed) {
            const preferred = model.preferredEngine || model.engine;
            if (preferred === "gemini") {
              toast("请保存 Gemini API Key，或配置 Vertex Key / 服务账号");
              openReviewSettings();
            } else if (preferred === "deepgram") {
              toast("请先保存 Deepgram API Key");
              $("deepgramKeyInput")?.focus();
            } else if (preferred === "local") {
              toast("请先下载当前选的本地 Whisper 模型");
              $("downloadLocalModel")?.focus();
            } else {
              toast("请先保存 Groq API Key，或把听写改成本地 / Deepgram / Gemini");
              $("groqKeyInput")?.focus();
            }
            return false;
          }
          if(state.autoTranscript?.trackId && isTrackLocked(state.autoTranscript.trackId))return toast("请先解锁字幕轨道");
          const btn = $("matchScript");
          btn.disabled = true;
          btn.textContent = "匹配中…";
          const sourceClips = manuscriptSourceClips();
          if (!sourceClips.length) throw new Error("时间线没有保留的源音频片段，无法匹配文案");
          const { jobId } = unwrap(
            await window.native.startScriptAnalysis({
              inputPath: state.video.path,
              duration: state.sourceDuration,
              script: $("scriptText").value,
              scriptLanguage: $("manuscriptLanguage")?.value || "",
              removals: [],
              sourceClips,
              alignmentOnly,
              forceRecognition,
              captionLines: state.captionLines,
              naturalPunctuation: !!state.naturalCaptionPunctuation,
            }),
          );
          matchJobId=jobId;
          $("modelProgress").style.display = "block";
          while (true) {
            await new Promise((r) => setTimeout(r, 600));
            const s = unwrap(await window.native.scriptAnalysisStatus(jobId));
            assertAutoCaptionContext(matchContext);
            $("modelProgress").firstElementChild.style.width =
              `${s.progress * 100}%`;
            if (s.state === "completed") {
              assertAutoCaptionContext(matchContext);
              snapshot();
              state.recognizedText = s.result.transcript || ""; state.recognizedTextCleared = false;
              const targetTrack=state.autoTranscript?.trackId || "caption";
              const targetCaptions=state.captions.filter(c=>(c.trackId || "caption")===targetTrack);
              const deletedSources=alignmentOnly || !targetCaptions.length ? [] : state.autoTranscript?.deletedSources || [];
              const otherCaptions=state.captions.filter(c=>(c.trackId || "caption")!==targetTrack);
              const otherReviews=state.reviewCaptions.filter(r=>r.captionTrackId && r.captionTrackId!==targetTrack);
              const otherIssueIds=new Set(otherReviews.map(r=>r.issueId||r.id));
              const otherIssues=(state.issues||[]).filter(i=>otherIssueIds.has(i.id));
              state.issues = [...otherIssues,...(s.result.issues || [])];
              state.matchIssues = (s.result.issues || []).map((issue) => ({ ...issue }));
              state.alignmentOperations = s.result.operations || [];
              state.alignmentDuration = Number(s.result.outputDuration || state.sourceDuration || 0);
              const reconciliation = reconcileCaptionAdditions(
                bindMatchedCaptionSources(await applyCaptionGrouping(s.result.captions, state.captionLines), sourceClips),
                targetCaptions,alignmentOnly?[]:state.autoTranscript?.additionBaseline || [],alignmentOnly?[]:state.autoTranscript?.editBaseline || [],deletedSources);
              const binding = bindGeneratedTranscript(reconciliation.captions,targetTrack);
              state.captions = [...otherCaptions,...reconciliation.captions];
              state.autoTranscript = {...binding,deletedSources,additionBaseline:reconciliation.baseline,editBaseline:reconciliation.editBaseline,trackId:state.autoTranscript?.trackId || "caption",text:state.recognizedText,sourcePath:state.video.path,sourceSegments:s.result.sourceSegments || [],scriptAssisted:true,panelOpen:true};
              state.reviewCaptions = (s.result.reviewCaptions || []).filter((item) =>
                ["missing","mismatch","repeat"].includes(item.type)
              );
              state.reviewCaptions = state.reviewCaptions.filter(r=>!reconciliation.resolvedIssueIds.has(r.issueId || r.id));
              state.reviewCaptions = [...otherReviews,...bindMatchedReviewSources(state.reviewCaptions,sourceClips).map(r=>({...r,transcriptId:binding.id,captionTrackId:state.autoTranscript.trackId}))];
              state.issues = state.issues.filter(r=>!reconciliation.resolvedIssueIds.has(r.id));
              state.matchIssues = state.matchIssues.filter(r=>!reconciliation.resolvedIssueIds.has(r.id));
              clampTracksToDuration();
              const hasDifference = selectNextScriptDifference(-1);
              updateAiReviewButton();
              renderAll();
              if(alignmentOnly)toast(`字幕对齐完成：${reconciliation.captions.length} 条字幕，${state.reviewCaptions.length} 处待确认`);
              if(!alignmentOnly)toast(
                hasDifference
                  ? `匹配完成：重复、错误标红，需补录内容标紫；加添内容已融入字幕并标绿。`
                  : "匹配完成：口播与正确文案一致",
              );
              btn.disabled = false;
              btn.textContent = "匹配文案";
              $("modelProgress").style.display = "none";
              return true;
            }
            if (s.state === "failed") throw new Error(s.error);
            if (s.state === "cancelled") throw new Error('文案匹配已取消');
          }
          btn.disabled = false;
          btn.textContent = "匹配文案";
        } catch (e) {
          if(matchJobId)window.native.cancelScriptAnalysis?.(matchJobId)?.catch(()=>{});
          $("matchScript").disabled = false;
          $("matchScript").textContent = "匹配文案";
          toast(e.message);
          return false;
        } finally {
          $("matchScript").disabled=false;
          $("matchScript").textContent='匹配文案';
          $("modelProgress").style.display='none';
        }
      }
      function updateAiReviewButton() {
        const ready = (state.matchIssues || state.issues || []).length > 0;
        for (const id of ["aiReviewStrict", "aiReviewNatural", "globalPolish"]) {
          const button = $(id);
          if (button) button.disabled = !ready && id !== "globalPolish";
        }
        if ($("globalPolish")) $("globalPolish").disabled = false;
      }
      
