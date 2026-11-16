function registerFontFace(font) {
        const key = font?.path || font?.id || font?.family;
        if (!font?.url || !key || registeredFontPaths.has(key)) return;
        registeredFontPaths.add(key);
        const style = document.createElement("style");
        style.textContent = `@font-face{font-family:'${String(font.family || "").replace(/'/g, "\\'")}';src:url('${font.url}')}`;
        document.head.appendChild(style);
      }
      function applyFontToSelection(font) {
        const style = currentStyle();
        if (!style || !font?.family) return;
        style.fontFamily = font.family;
        style.fontFile = font.path || "";
        registerFontFace(font);
        syncFontFamilySelection(style);
        renderAll();
        toast(`${font.family} 已套用到当前文字属性`);
      }
      function renderFontFamilyOptions() {
        const select = $("fontFamilySelect");
        if (!select) return;
        const current = currentStyle()?.fontFamily || state.captionStyle?.fontFamily || "Helvetica";
        const topRecommended = [
          { family: "Impact", fullName: "Impact (短视频爆款粗体)" },
          { family: "Arial Black", fullName: "Arial Black (超粗黑体)" },
          { family: "Arial", fullName: "Arial (经典无衬线)" },
          { family: "Helvetica", fullName: "Helvetica (现代无衬线)" },
          { family: "Montserrat", fullName: "Montserrat (时尚无衬线)" },
          { family: "Microsoft YaHei", fullName: "微软雅黑 (Microsoft YaHei)" },
          { family: "SimHei", fullName: "黑体 (SimHei)" },
          { family: "PingFang SC", fullName: "苹方 (PingFang SC)" },
          { family: "HarmonyOS Sans SC", fullName: "鸿蒙黑体 (HarmonyOS Sans)" },
          { family: "Source Han Sans CN", fullName: "思源黑体 (Source Han Sans)" },
          { family: "YouYuan", fullName: "幼圆 (YouYuan)" },
          { family: "KaiTi", fullName: "楷体 (KaiTi)" },
          { family: "FangSong", fullName: "仿宋 (FangSong)" },
          { family: "SimSun", fullName: "宋体 (SimSun)" },
          { family: "Segoe UI", fullName: "Segoe UI" },
          { family: "Times New Roman", fullName: "Times New Roman" },
        ];

        // Collect all system fonts
        const allSystemFamilies = new Map();
        const usableFontLabel = (value) => {
          const label = String(value || "").trim();
          return !!label && label.length <= 120 &&
            !/[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(label) &&
            !/(?:copyright|all rights reserved|https?:\/\/|version\s+\d)/i.test(label);
        };
        (availableLocalFonts || []).forEach((font) => {
          const fam = (font.family || font.fullName || "").trim();
          const fullName = String(font.fullName || fam).trim();
          if (usableFontLabel(fam) && !allSystemFamilies.has(fam)) {
            allSystemFamilies.set(fam, usableFontLabel(fullName) ? fullName : fam);
          }
        });

        const sortedSystemFamilies = [...allSystemFamilies.entries()]
          .sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));

        select.replaceChildren();

        // Group 1: 🌟 常用推荐
        const groupTop = document.createElement("optgroup");
        groupTop.label = "🌟 常用短视频推荐字体";
        topRecommended.forEach((font) => {
          const option = document.createElement("option");
          option.value = font.family;
          option.textContent = font.fullName;
          option.dataset.family = font.family;
          option.style.fontFamily = `'${font.family}', sans-serif`;
          if (font.family === current) option.selected = true;
          groupTop.appendChild(option);
        });
        select.appendChild(groupTop);

        // Group 2: 💻 全部电脑系统字体
        if (sortedSystemFamilies.length > 0) {
          const groupAll = document.createElement("optgroup");
          groupAll.label = `💻 全部电脑系统字体 (${sortedSystemFamilies.length} 款)`;
          sortedSystemFamilies.forEach(([family, fullName]) => {
            const option = document.createElement("option");
            option.value = family;
            option.textContent = fullName !== family ? `${family} (${fullName})` : family;
            option.dataset.family = family;
            option.style.fontFamily = `'${family}', sans-serif`;
            if (family === current) option.selected = true;
            groupAll.appendChild(option);
          });
          select.appendChild(groupAll);
        }

        // If current font is custom or not in either list
        if (![...select.options].some((opt) => opt.value === current || opt.dataset.family === current)) {
          const customOpt = document.createElement("option");
          customOpt.value = current;
          customOpt.textContent = current;
          customOpt.dataset.family = current;
          customOpt.selected = true;
          select.insertBefore(customOpt, select.firstChild);
        }

        select.onchange = () => {
          const s = currentStyle() || state.captionStyle;
          if (!s) return;
          s.fontFamily = select.value;
          refreshLiveTextStyle(true);
          renderAll();
          toast(`已应用字体：${select.value}`);
        };
      }

      function syncFontFamilySelection(style = currentStyle()) {
        const select = $("fontFamilySelect");
        if (!select || !style) return;
        const option = [...select.options].find(
          (item) => item.value === style.fontFamily || item.dataset.family === style.fontFamily,
        );
        if (option) {
          select.value = option.value;
        }
      }

      function handleAddNewCaption() {
        const curTime = Number(state.currentTime || 0);
        const start = Math.max(0, curTime);
        const end = Math.max(start + 0.1, start + 2.0);
        const newCap = {
          id: `cap_${Date.now()}`,
          start,
          end,
          text: "点击输入字幕内容",
          words: [
            { word: "点击输入字幕内容", start, end, startIndex: 0, endIndex: 8 }
          ],
        };
        state.captions.push(newCap);
        state.captions.sort((a, b) => a.start - b.start);
        state.selected = { type: "caption", id: newCap.id };
        recomputeContentDuration();
        renderTimeline();
        renderPreviewObjects();
        renderCaptionInspector(true);
        updateInspector();
        const objTextInput = $("objectText");
        if (objTextInput) {
          objTextInput.value = newCap.text;
          objTextInput.focus();
          objTextInput.select();
        }
        toast("已在当前播放位置新建字幕片段");
      }
      if ($("addNewCaptionFromStyle")) $("addNewCaptionFromStyle").onclick = handleAddNewCaption;
      if ($("addNewCaptionFromSub")) $("addNewCaptionFromSub").onclick = handleAddNewCaption;
      async function loadLocalFonts() {
        try {
          availableLocalFonts = unwrap(await window.native.localFonts()) || [];
          localFontCatalogLoaded = true;
          renderFontFamilyOptions();
        } catch (e) {
          console.warn(e);
        }
      }
      $("fontFamilySelect").onchange = (event) => {
        const option = event.target.selectedOptions[0];
        if (!option) return;
        applyFontToSelection({
          family: option.dataset.family || option.value || option.textContent,
          path: option.dataset.path || "",
        });
      };
      $("pasteScript").onclick = async () => {
        try {
          const text = unwrap(await window.native.readClipboard());
          const a = $("scriptText"),
            start = a.selectionStart || 0,
            end = a.selectionEnd || 0;
          a.setRangeText(text, start, end, "end");
          a.focus();
        } catch (e) {
          toast(e.message);
        }
      };
      $("clearScript").onclick = () => {
        const input = $("scriptText");
        if (!input.value) return;
        snapshot();
        input.value = "";
        input.focus();
        queueAutosave();
        toast("正确文案已清空");
      };
      $("matchScript").onclick = matchScript;
      $("aiReviewStrict").onclick = () => reviewScriptWithAi("strict");
      $("aiReviewNatural").onclick = () => reviewScriptWithAi("natural");
      if ($("globalPolish")) $("globalPolish").onclick = runGlobalPolish;
      if ($("runGlobalPolishSidebar")) $("runGlobalPolishSidebar").onclick = runGlobalPolish;
      if ($("lastPolishReport")) $("lastPolishReport").onclick = showLastPolishReport;

      if ($("pauseGapThreshold")) {
        $("pauseGapThreshold").oninput = () => {
          // 清除每个 gap 的手动勾选缓存，按新阈值重新计算
          (window.__pauseGapPlan || []).forEach(g => { delete g.userChecked; });
          renderPolishSidebarList();
        };
      }
      if ($("unlockScriptureGaps")) {
        $("unlockScriptureGaps").onchange = () => {
          if ($("unlockScriptureGaps").checked) {
            toast("⚠️ 已开启经文气口勾选权限，请仔细复核经文完整性");
          }
          renderPolishSidebarList();
        };
      }

      document.querySelectorAll(".polish-filter-tabs [data-polish-filter]").forEach((btn) => {
        btn.onclick = () => {
          document.querySelectorAll(".polish-filter-tabs [data-polish-filter]").forEach(b => b.classList.toggle("active", b === btn));
          currentPolishFilter = btn.dataset.polishFilter || "all";
          renderPolishSidebarList();
        };
      });

      if ($("selectAllPolishBtn")) {
        $("selectAllPolishBtn").onclick = () => {
          (window.__pauseGapPlan || []).forEach(g => {
            if (!g.locked) {
              g.checked = true;
              g.userChecked = true;
            }
          });
          renderPolishSidebarList();
          toast("已全选当前建议切除气口");
        };
      }

      if ($("invertSelectPolishBtn")) {
        $("invertSelectPolishBtn").onclick = () => {
          (window.__pauseGapPlan || []).forEach(g => {
            if (!g.locked) {
              g.checked = !g.checked;
              g.userChecked = g.checked;
            }
          });
          renderPolishSidebarList();
          toast("已反选气口");
        };
      }

      if ($("applyPauseGapsSidebarBtn")) $("applyPauseGapsSidebarBtn").onclick = applySelectedPauseGaps;

      if ($("globalPolishListSidebar")) {
        $("globalPolishListSidebar").onclick = (event) => {
          const actionBtn = event.target.closest("[data-polish-action]");
          if (actionBtn) {
            const action = actionBtn.dataset.polishAction;
            if (action === "preview") {
              const start = Number(actionBtn.dataset.start || 0);
              const duration = Number(actionBtn.dataset.duration || 1.5);
              previewTimeRange(start, duration);
              return;
            }
            if (action === "preview-gap") {
              const gapId = actionBtn.dataset.gapId;
              const gap = (window.__pauseGapPlan || []).find(g => g.id === gapId);
              if (gap) previewTimeRange(Math.max(0, Number(gap.start || 0) - 0.4), Number(gap.duration || 0.5) + 0.8);
              return;
            }
            if (action === "cut-gap") {
              const gapId = actionBtn.dataset.gapId;
              cutSinglePauseGap(gapId);
              return;
            }
            if (action === "merge-gap") {
              const gapId = actionBtn.dataset.gapId;
              mergeCaptionsAcrossGap(gapId);
              return;
            }
            if (action === "toggle-gap-keep") {
              const gapId = actionBtn.dataset.gapId;
              const gap = (window.__pauseGapPlan || []).find(g => g.id === gapId);
              if (gap && !gap.locked) {
                gap.checked = !gap.checked;
                gap.userChecked = gap.checked;
                renderPolishSidebarList();
              }
              return;
            }
            if (action === "ignore-gap") {
              const gapId = actionBtn.dataset.gapId;
              ignorePolishItem("gap", gapId);
              return;
            }
            if (action === "ignore-issue") {
              const issueId = actionBtn.dataset.issueId;
              ignorePolishItem("issue", issueId);
              return;
            }
            if (action === "accept-issue") {
              const issueId = actionBtn.dataset.issueId;
              acceptReviewSegment(issueId);
              renderPolishSidebarList();
              return;
            }
            if (action === "replace-spoken") {
              const issueId = actionBtn.dataset.issueId;
              replaceReviewWithSpoken(issueId);
              renderPolishSidebarList();
              return;
            }
            if (action === "keep-solo") {
              const issueId = actionBtn.dataset.issueId;
              keepSoloReviewSegment(issueId);
              renderPolishSidebarList();
              return;
            }
            if (action === "cut-issue") {
              const issueId = actionBtn.dataset.issueId;
              cutReviewSegment(issueId);
              renderPolishSidebarList();
              return;
            }
            if (action === "locate-issue") {
              const issueId = actionBtn.dataset.issueId;
              selectIssue(issueId);
              return;
            }
          }

          const checkbox = event.target.closest("[data-pause-gap]");
          if (checkbox) {
            const gapId = checkbox.dataset.pauseGap;
            const gap = (window.__pauseGapPlan || []).find(g => g.id === gapId);
            if (gap && !gap.locked) {
              gap.checked = checkbox.checked;
              gap.userChecked = gap.checked;
              renderPolishSidebarList();
            }
            return;
          }

          // 点击整张卡片：跳转定位到时间线
          const card = event.target.closest(".polish-card");
          if (card && card.dataset.start !== undefined) {
            const start = Number(card.dataset.start || 0);
            seekTimeline(start);
            document.querySelectorAll(".polish-card").forEach(c => c.classList.toggle("active", c === card));
          }
        };
      }

      if ($("globalPolishClose"))
        $("globalPolishClose").onclick = () => {
          $("globalPolishModal").classList.remove("on");
        };
      if ($("applyPauseGapsBtn")) $("applyPauseGapsBtn").onclick = applySelectedPauseGaps;
      if ($("globalPolishBody"))
        $("globalPolishBody").onclick = (event) => {
          const button = event.target.closest("[data-polish-id]");
          if (button) {
            $("globalPolishModal").classList.remove("on");
            selectIssue(button.dataset.polishId);
            return;
          }
          const timeEl = event.target.closest("[data-polish-time]");
          if (timeEl) seekTimeline(Number(timeEl.dataset.polishTime || 0));
        };
      if ($("openReviewSettings")) $("openReviewSettings").onclick = openReviewSettings;
      $("reviewProvider").onchange = async () => {
        toggleReviewProviderFields();
        await persistReviewSettings();
        await refreshGeminiModels();
      };
      $("refreshGeminiModels").onclick = refreshGeminiModels;
      $("saveGeminiKey").onclick = saveGeminiKey;
      $("clearGeminiKey").onclick = async () => {
        unwrap(await window.native.clearGeminiKey());
        await fillReviewSettings();
        toast("已清除 Gemini Key");
      };
      $("saveVertexKey").onclick = saveVertexSettings;
      $("importVertexSa").onclick = async () => {
        unwrap(await window.native.importVertexServiceAccount());
        await fillReviewSettings();
        toast("服务账号已导入");
      };
      $("clearVertexSecrets").onclick = async () => {
        unwrap(await window.native.clearVertexSecrets());
        await fillReviewSettings();
        toast("已清除 Vertex 凭证");
      };
      if ($("browseAntigravityCli")) $("browseAntigravityCli").onclick = async () => {
        unwrap(await window.native.browseAntigravityCli());
        await fillReviewSettings();
      };
      if ($("checkAntigravity")) $("checkAntigravity").onclick = async () => {
        $("antigravityHint").className = "status";
        $("antigravityHint").textContent = "正在检测 agy 和登录状态…";
        try {
          await persistReviewSettings();
          const status = unwrap(await window.native.checkAntigravityStatus());
          await fillReviewSettings(status);
          toast(
            status.antigravityState === "ready"
              ? "Antigravity 已就绪"
              : status.antigravityState === "need-login"
                ? "已安装，还需要登录"
                : status.antigravityHint || "检测完成",
          );
        } catch (e) {
          $("antigravityHint").className = "status error";
          $("antigravityHint").textContent = e.message;
          toast(e.message);
        }
      };
      if ($("installAntigravity")) $("installAntigravity").onclick = async () => {
        $("antigravityHint").className = "status";
        $("antigravityHint").textContent = "正在运行官方安装脚本，可能需要一两分钟…";
        $("installAntigravity").disabled = true;
        try {
          await persistReviewSettings();
          const status = unwrap(await window.native.installAntigravityCli());
          await fillReviewSettings(status);
          toast(status.antigravityState === "ready" ? "安装完成，已就绪" : "安装完成，请再点登录");
        } catch (e) {
          $("antigravityHint").className = "status error";
          $("antigravityHint").textContent = e.message;
          toast(e.message);
        } finally {
          $("installAntigravity").disabled = false;
        }
      };
      if ($("loginAntigravity")) $("loginAntigravity").onclick = async () => {
        try {
          await persistReviewSettings();
          unwrap(await window.native.openAntigravityLogin());
          $("antigravityHint").className = "status";
          $("antigravityHint").textContent = "已打开登录窗口。浏览器授权完成后回到这里点「检测」。";
          toast("已打开 agy 登录窗口");
        } catch (e) {
          $("antigravityHint").className = "status error";
          $("antigravityHint").textContent = e.message;
          toast(e.message);
        }
      };
      if ($("openAntigravityDocs")) $("openAntigravityDocs").onclick = async () => {
        try {
          unwrap(await window.native.openAntigravityDocs());
        } catch (e) {
          toast(e.message);
        }
      };
      $("resetReviewPrompts").onclick = async () => {
        const defaults = unwrap(await window.native.defaultReviewPrompts());
        $("promptStrict").value = defaults.strict || "";
        $("promptNatural").value = defaults.natural || "";
      };
      $("reviewSettingsSave").onclick = async () => {
        await persistReviewSettings();
        $("reviewSettingsModal").classList.remove("on");
        toast("纠正设置已保存");
      };
      $("reviewSettingsCancel").onclick = () => $("reviewSettingsModal").classList.remove("on");
      $("saveGroqKey").onclick = saveGroqKey;
      $("clearGroqKey").onclick = clearGroqKey;
      $("saveDeepgramKey").onclick = saveDeepgramKey;
      $("clearDeepgramKey").onclick = clearDeepgramKey;
      if ($("downloadLocalModel")) $("downloadLocalModel").onclick = downloadModel;
      $("speechEngine").onchange = async () => {
        unwrap(await window.native.saveSpeechSettings({ engine: $("speechEngine").value }));
        await checkModel();
        const labels = {
          gemini: "Gemini / Vertex",
          deepgram: "Deepgram",
          groq: "Groq",
          local: "本地 Whisper",
        };
        toast(`听写已改为 ${labels[$("speechEngine").value] || "Groq"}`);
      };
      if ($("localWhisperModel"))
        $("localWhisperModel").onchange = async () => {
          unwrap(
            await window.native.saveSpeechSettings({
              localModel: $("localWhisperModel").value,
            }),
          );
          await checkModel();
          toast("已改本地模型，没下载过的要先点下载");
        };
      if ($("speechLanguageButton"))
        $("speechLanguageButton").onclick = (event) => {
          event.preventDefault();
          const combo = $("speechLanguageCombo");
          if (combo?.classList.contains("open")) closeSpeechLanguageCombo();
          else openSpeechLanguageCombo();
        };
      if ($("speechLanguageSearch")) {
        $("speechLanguageSearch").oninput = () => {
          renderSpeechLanguageOptions(
            $("speechLanguage")?.value || "en",
            $("speechLanguageSearch").value,
          );
        };
        $("speechLanguageSearch").onkeydown = (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeSpeechLanguageCombo();
          }
        };
      }
      if ($("speechLanguageList"))
        $("speechLanguageList").onclick = async (event) => {
          const item = event.target.closest("[data-lang]");
          if (!item) return;
          unwrap(
            await window.native.saveSpeechSettings({
              speechLanguage: item.dataset.lang,
            }),
          );
          closeSpeechLanguageCombo();
          await checkModel();
          toast("识别语言已保存");
        };
      document.querySelectorAll("[data-speech-language-quick]").forEach((button) => {
        button.onclick = async () => {
          const speechLanguage = button.dataset.speechLanguageQuick;
          unwrap(await window.native.saveSpeechSettings({ speechLanguage }));
          await checkModel();
          const label = { zh: "中文", en: "英文", fr: "法语", auto: "自动检测" }[speechLanguage] || speechLanguage;
          toast(`已切换${label}识别`);
        };
      });
      document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest?.("#speechLanguageCombo")) closeSpeechLanguageCombo();
      });
      $("groqKeyInput").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          saveGroqKey();
        }
      });
      let denoiseMonitorTimer = null;
      function scheduleDenoiseMonitor() {
        state.denoisedAudio = null;
        $("denoiseApplyState").textContent = "参数已改变；正在刷新播放头附近的监听片段，确认后可应用整轨。";
        clearTimeout(denoiseMonitorTimer);
        denoiseMonitorTimer = setTimeout(() => previewDenoise(), 650);
        syncPreviewAudio();
        queueAutosave();
      }
      $("denoiseMode").onchange = (e) => {
        state.denoise.mode = e.target.value;
        state.denoiseEnabled = Number(state.denoise.strength || 0) > 0.01;
        syncDenoiseProfessionalControls();
        scheduleDenoiseMonitor();
      };
      $("denoiseStrength").oninput = (e) => {
        state.denoise.strength = Number(e.target.value) / 100;
        state.denoiseEnabled = state.denoise.strength > 0.01;
        $("denoiseOut").textContent = `${e.target.value}%`;
        scheduleDenoiseMonitor();
      };
      $("denoisePreset").onchange = (event) => {
        const preset = denoisePresetMap[event.target.value] ? event.target.value : "balanced";
        Object.assign(state.denoise, denoisePresetMap[preset], {
          preset,
          mode: "ai-isolation",
        });
        state.denoiseEnabled = Number(state.denoise.strength || 0) > 0.01;
        syncAudioControls();
        scheduleDenoiseMonitor();
      };
      $("denoiseHumEnabled").onchange = (event) => {
        state.denoise.humEnabled = event.target.checked;
        scheduleDenoiseMonitor();
      };
      $("denoiseHumFrequency").onchange = (event) => {
        state.denoise.humFrequency = event.target.value;
        syncDenoiseProfessionalControls();
        scheduleDenoiseMonitor();
      };
      const denoiseStageControls = {
        denoiseHumDepth: ["humDepth", "denoiseHumDepthOut"],
        denoiseWind: ["wind", "denoiseWindOut"],
        denoiseEnvironment: ["environment", "denoiseEnvironmentOut"],
        denoiseNeural: ["neural", "denoiseNeuralOut"],
        denoiseInsect: ["insect", "denoiseInsectOut"],
        denoiseResidual: ["residual", "denoiseResidualOut"],
        denoiseVoiceRestore: ["voiceRestore", "denoiseVoiceRestoreOut"],
      };
      for (const [id, [key, outputId]] of Object.entries(denoiseStageControls)) {
        $(id).oninput = (event) => {
          state.denoise[key] = Number(event.target.value) / 100;
          $(outputId).textContent = `${event.target.value}%`;
          scheduleDenoiseMonitor();
        };
      }
      document.querySelectorAll("[data-audio-fx-scope]").forEach((button) => {
        button.onclick = () => {
          state.audioFxScope = button.dataset.audioFxScope === "clip" ? "clip" : "track";
          renderAudioFxRack();
        };
      });
      $("addAudioFx").onclick = () => {
        const target = currentAudioFxTarget(true);
        if (!target) return toast("请先选择音频片段");
        if (target.rack.length >= 6) return toast("每个片段或音轨最多 6 个效果插槽");
        snapshot();
        target.rack.push(makeAudioFx($("audioFxAddType").value));
        setCurrentAudioFxRack(target.rack);
        invalidateAudioFxCache();
        renderAudioFxRack();
      };
      $("audioFxBypass").onclick = () => {
        const target = currentAudioFxTarget(true);
        if (!target) return;
        snapshot();
        if (target.scope === "track") state.audioFxBypass = !state.audioFxBypass;
        else target.settings.fxBypass = !target.settings.fxBypass;
        invalidateAudioFxCache();
        renderAudioFxRack();
      };
      $("audioFxAudition").onclick = auditionAudioFx;
      $("applyAudioFxRack").onclick = applyAudioFxTrack;
      $("audioFxRackList").onpointerdown = (event) => {
        const control = event.target.closest?.("[data-fx-param],[data-fx-band-field]");
        if (control && !control.dataset.fxUndoReady) {
          snapshot();
          control.dataset.fxUndoReady = "1";
        }
      };
      $("audioFxRackList").oninput = (event) => {
        const card = event.target.closest?.("[data-fx-id]");
        if (!card) return;
        const { target, effect } = findAudioFx(card.dataset.fxId);
        if (!effect) return;
        if (event.target.dataset.fxParam) {
          const key = event.target.dataset.fxParam;
          const scale = Number(event.target.dataset.fxScale || 1);
          effect.params[key] = event.target.type === "checkbox"
            ? event.target.checked
            : event.target.tagName === "SELECT"
              ? event.target.value
              : Number(event.target.value) / scale;
          const value = card.querySelector(`[data-fx-value="${key}"]`);
          if (value) value.textContent = event.target.value + (value.textContent.match(/\s*dB|\s*ms|%|:1/)?.[0] || "");
        }
        if (event.target.dataset.fxBandField) {
          const band = effect.params.bands?.[Number(event.target.dataset.fxBand)];
          const key = event.target.dataset.fxBandField;
          if (band) band[key] = event.target.type === "checkbox"
            ? event.target.checked
            : event.target.tagName === "SELECT" ? event.target.value : Number(event.target.value);
        }
        setCurrentAudioFxRack(target.rack);
        invalidateAudioFxCache();
      };
      $("audioFxRackList").onchange = (event) => {
        if (event.target.matches("[data-fx-param],[data-fx-band-field]")) {
          delete event.target.dataset.fxUndoReady;
          renderAudioFxRack();
        }
      };
      $("audioFxRackList").onclick = (event) => {
        const learn = event.target.closest?.("[data-fx-learn]");
        if (learn) return learnSelectedNoise(learn.dataset.fxLearn);
        const analyzeHum = event.target.closest?.("[data-fx-analyze-hum]");
        if (analyzeHum) return analyzeSelectedAudioFxHum(analyzeHum.dataset.fxAnalyzeHum);
        const actionButton = event.target.closest?.("[data-fx-action]");
        const card = event.target.closest?.("[data-fx-id]");
        if (!actionButton || !card) return;
        const { target, effect } = findAudioFx(card.dataset.fxId);
        if (!effect) return;
        snapshot();
        const index = target.rack.findIndex((item) => item.id === effect.id);
        const action = actionButton.dataset.fxAction;
        if (action === "toggle") effect.enabled = actionButton.checked;
        if (action === "up" && index > 0) [target.rack[index - 1], target.rack[index]] = [target.rack[index], target.rack[index - 1]];
        if (action === "down" && index < target.rack.length - 1) [target.rack[index + 1], target.rack[index]] = [target.rack[index], target.rack[index + 1]];
        if (action === "copy") {
          if (target.rack.length >= 6) return toast("已达到 6 个效果插槽上限");
          const copy = JSON.parse(JSON.stringify(effect));
          copy.id = crypto.randomUUID();
          copy.name = `${effect.name} 副本`;
          target.rack.splice(index + 1, 0, copy);
        }
        if (action === "remove") target.rack.splice(index, 1);
        if (action === "reset") effect.params = defaultAudioFxParams(effect.type);
        setCurrentAudioFxRack(target.rack);
        invalidateAudioFxCache();
        renderAudioFxRack();
      };
      $("beautyControls").oninput = (event) => {
        const key = event.target.dataset.beauty;
        if (!key) return;
        state.beauty[key] = Number(event.target.value);
        $(`beauty-${key}-out`).textContent = event.target.value;
        applyVideoCss();
        queueAutosave();
      };
      const audioInputMap = {
        audioVolume: ["volume", 0.01],
        audioPan: ["pan", 0.01],
        audioBass: ["bass", 1],
        audioTreble: ["treble", 1],
        audioCompressor: ["compressor", 0.01],
        audioPresence: ["presence", 1],
        audioDeesser: ["deesser", 1],
        audioVoiceEnhance: ["voiceEnhance", 1],
      };
      for (const [id, [key, factor]] of Object.entries(audioInputMap)) {
        $(id).oninput = (event) => {
          state.audio[key] = Number(event.target.value) * factor;
          state.audioProcessingEnabled = true;
          syncAudioControls();
          applyVideoCss();
          if (key === "volume") {
            renderTimeline();
            syncPreviewAudio();
          }
          queueAutosave();
        };
      }
      $("audioSpeed").onpointerdown = () => snapshot();
      $("audioSpeed").oninput = (event) => {
        state.audioProcessingEnabled = true;
        retimeTracksForSpeed(Number(event.target.value) / 100);
        renderAll();
      };
      for (const id of ["audioLowCut", "audioHighCut"]) {
        $(id).oninput = (event) => {
          state.audio[id === "audioLowCut" ? "lowCut" : "highCut"] =
            Number(event.target.value);
          state.audioProcessingEnabled = true;
          queueAutosave();
        };
      }
      function updateSelectedAudioSettings() {
        const settings = audioSettingsFor(
          state.selected.type,
          state.selected.id,
        );
        if (!settings) return;
        settings.volume = Number($("clipVolume").value) / 100;
        settings.pan = Number($("clipPan").value) / 100;
        settings.fadeIn = Math.max(0, Number($("clipFadeIn").value) || 0);
        settings.fadeOut = Math.max(0, Number($("clipFadeOut").value) || 0);
        settings.muted = $("clipMute").checked;
        renderTimeline();
        syncPreviewAudio();
        syncAudioControls();
        queueAutosave();
      }
      for (const id of [
        "clipVolume",
        "clipPan",
        "clipFadeIn",
        "clipFadeOut",
        "clipMute",
      ])
        $(id).oninput = updateSelectedAudioSettings;
      $("audioLimiter").onchange = (event) => {
        state.audio.limiter = event.target.checked;
        state.audioProcessingEnabled = true;
        queueAutosave();
      };
      $("audioNormalize").onchange = (event) => {
        state.audio.normalize = event.target.checked;
        state.audioProcessingEnabled = true;
        queueAutosave();
      };
      $("audioChannelMode").onchange = (event) => {
        state.audio.channelMode = event.target.value;
        state.audioProcessingEnabled = true;
        queueAutosave();
      };
      $("exportModal").onclick = (e) => {
        if (
          e.target === $("exportModal") &&
          $("revealExport").style.display !== "none"
        )
          $("exportModal").classList.remove("on");
      };
      $("cancelExport").onclick = async () => {
        if (state.exportJobId) {
          try {
            await nativeCall("cancelExport", state.exportJobId);
          } catch {}
          state.exportJobId = "";
          $("exportStatus").textContent = "已取消导出";
          $("cancelExport").textContent = "关闭";
          return;
        }
        $("exportModal").classList.remove("on");
      };
      $("colorControls").oninput = (e) => {
        const grade = selectedVideoGrade?.(true);
        if (!grade) return;
        if (e.target.dataset.color) {
          grade[e.target.dataset.color] = Number(e.target.value);
          $(`${e.target.dataset.color}Out`).textContent = e.target.value;
          applyVideoCss();
          syncSelectedClipColor?.();
          queueAutosave();
          return;
        }
        if (e.target.dataset.colorSlice && e.target.dataset.sliceProperty) {
          const key = e.target.dataset.colorSlice;
          const property = e.target.dataset.sliceProperty;
          grade.slices = normalizeColorSlices(grade.slices);
          grade.slices[key][property] = Number(e.target.value);
          $(`slice-${key}-${property}-out`).textContent = e.target.value;
          applyVideoCss();
          syncSelectedClipColor?.();
          queueAutosave();
        }
      };
      function removeSurplusBoundaryQuotes(input) {
        let text = String(input || "").trim();
        // Leading quote marks are stray copied punctuation in this script field,
        // not part of the spoken text. Remove the whole contiguous prefix run;
        // quote marks elsewhere in the manuscript continue through normal pairing.
        text = text.replace(/^["'“”„‟＂＇]+\s*/, "");
        // Whole-document wrappers can contain same-style quotations. Odd quote
        // counts in both boundary paragraphs identify a pair spanning the text,
        // unlike two independently quoted paragraphs (even counts in each).
        let blocks = text.split(/\n\s*\n/);
        while (blocks.length > 1 && /^[“”„‟＂"]/.test(text) && /[“”„‟＂"]$/.test(text)
          && (blocks[0].match(/[“”„‟＂"]/g) || []).length % 2 === 1
          && (blocks.at(-1).match(/[“”„‟＂"]/g) || []).length % 2 === 1) {
          text = text.slice(1, -1).trim();
          blocks = text.split(/\n\s*\n/);
        }
        function pairs(value) {
          const stack = [], matches = new Map();
          for (let i = 0; i < value.length; i++) {
            const c = value[i];
            if (c === "„" || c === "‟") stack.push(i);
            else if (c === "“") {
              if (stack.length && value[stack.at(-1)] === "„") matches.set(stack.pop(), i);
              else stack.push(i);
            }
            else if (c === "”") { if (stack.length) matches.set(stack.pop(), i); }
            else if (c === '"' || c === '＂') {
              const previous = value[i - 1] || "";
              const next = value[i + 1] || "";
              const nextStartsText = /[\p{L}\p{N}]/u.test(next)
                || (/\s/.test(next) && /^\s+[\p{L}\p{N}]/u.test(value.slice(i + 1)));
              const nestedOpening = stack.length && nextStartsText
                && (/[\s:([{]/.test(previous) || /[\p{L}\p{N}]/u.test(previous));
              if (stack.length && /["＂]/.test(value[stack.at(-1)]) && !nestedOpening) matches.set(stack.pop(), i);
              else stack.push(i);
            }
          }
          return matches;
        }
        // Remove only boundary quote characters or pairs enclosing whitespace.
        // Never slice away non-quote content when an unmatched mark is found.
        let previous;
        do {
          previous = text;
          if (/^[“”„‟＂"]/.test(text)) {
            const end = pairs(text).get(0);
            if (end === text.length - 1) text = text.slice(1, -1).trim();
            else if (end !== undefined && !text.slice(1, end).trim()) text = text.slice(end + 1).trimStart();
            else if (end === undefined) text = text.slice(1).trimStart();
          }
          if (/[“”„‟＂"]$/.test(text)) {
            const finalBlockStart = Math.max(0, text.lastIndexOf("\n\n") + 2);
            const finalBlock = text.slice(finalBlockStart);
            const localMatch = [...pairs(finalBlock)].find(([, end]) => end === finalBlock.length - 1);
            const globalMatch = [...pairs(text)].find(([, end]) => end === text.length - 1);
            const matchStart = localMatch ? finalBlockStart + localMatch[0] : globalMatch?.[0];
            if (matchStart === undefined) text = text.slice(0, -1).trimEnd();
            else if (!(localMatch ? finalBlock.slice(localMatch[0] + 1, -1) : text.slice(matchStart + 1, -1)).trim()) text = text.slice(0, matchStart).trimEnd();
          }
        } while (text !== previous);
        return text;
      }
      function cleanScriptCopy(input, options = {}) {
        const useMarkupCleanup = options.cleanMarkup !== false;
        const usePunctuationNormalization = options.normalizePunctuation !== false;
        const useSymbolCollapse = options.collapseSymbols !== false;
        const punctuation = {
          "，": ",", "。": ".", "：": ":", "；": ";", "？": "?", "！": "!",
          "（": "(", "）": ")", "【": "[", "】": "]", "《": "<", "》": ">",
          "、": "、", "…": "...", "—": "-", "–": "-",
          "‘": "'", "’": "'", "‚": "'", "‛": "'",
          "“": '"', "”": '"', "„": '"', "‟": '"', "＇": "'", "＂": '"',
        };
        let text = String(input ?? "").replace(/\r\n?/g, "\n");
        text = text.replace(/[\u00A0\u202F]/g, " ");
        text = text.replace(/[\uFEFF\u200B\u200C\u200D]/g, "");
        if (useMarkupCleanup) text = text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u20E3]/gu, "");
        // Keep the readable label while removing common Markdown wrappers.
        if (useMarkupCleanup) {
          text = text.replace(/!\[([^\]]*)\]\([^\n)]+\)/g, "$1");
          text = text.replace(/\[([^\]]+)\]\([^\n)]+\)/g, "$1");
          text = text.replace(/^\s*```[^\n]*$/gm, "");
          text = text.replace(/`([^`\n]+)`/g, "$1").replace(/`+/g, "");
          // Keep ordered-list markers: they are part of the user's script, not decoration.
          text = text.replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "");
          text = text.replace(/~~([^~\n]+)~~/g, "$1");
          text = text.replace(/(?:\*\*|__)([^\n]+?)(?:\*\*|__)/g, "$1");
          text = text.replace(/(?:\*|_)([^\n]+?)(?:\*|_)/g, "$1");
          text = text.replace(/[\*#]+/g, "");
        }
        text = removeSurplusBoundaryQuotes(text);
        // Attach closing quotes before sentence splitting. Once curly quotes are
        // normalized to straight quotes their opening/closing role is lost.
        let doubleQuoteOpen = false;
        let doubleQuoteOpening = "";
        let singleQuoteOpen = false;
        let attached = "";
        for (let index = 0; index < text.length; index += 1) {
          const character = text[index];
          const apostrophe = /['’]/.test(character)
            && /[\p{L}\p{N}]/u.test(text[index - 1] || "")
            && (/[\p{L}\p{N}]/u.test(text[index + 1] || "") || !singleQuoteOpen);
          let closing = /[”’」』]/.test(character) && !apostrophe;
          if (!apostrophe) {
            if (character === '"' || character === '＂') {
              closing = doubleQuoteOpen;
              doubleQuoteOpen = !doubleQuoteOpen;
            } else if (character === "„" || character === "‟") {
              doubleQuoteOpen = true;
              doubleQuoteOpening = character;
            } else if (character === "“") {
              closing = doubleQuoteOpen && doubleQuoteOpening === "„";
              doubleQuoteOpen = !closing;
              doubleQuoteOpening = closing ? "" : character;
            }
            else if (character === "”") doubleQuoteOpen = false;
            else if (character === "'" || character === "＇") {
              closing = singleQuoteOpen;
              singleQuoteOpen = !singleQuoteOpen;
            } else if (character === "‘") singleQuoteOpen = true;
            else if (character === "’") singleQuoteOpen = false;
          }
          const previous = text[index - 1] || "";
          const next = text[index + 1] || "";
          const word = /[\p{L}\p{N}]/u;
          if (!closing && /["＂“„‟]/.test(character) && word.test(next)
            && (word.test(previous) || /[:：]/.test(previous))) attached = attached.trimEnd() + " ";
          if (closing) attached = attached.trimEnd();
          attached += character;
          if (closing && word.test(next)) attached += " ";
        }
        text = removeSurplusBoundaryQuotes(attached);
        if (usePunctuationNormalization) text = [...text].map((character) => punctuation[character] ?? character).join("");
        if (useSymbolCollapse) text = text
          .replace(/"{2,}/g, '"')
          .replace(/'{2,}/g, "'")
          .replace(/\.{4,}/g, "...")
          .replace(/([,;:])(?:\s*\1)+/g, "$1")
          .replace(/[!?](?:\s*[!?])+/g, (run) => run.replace(/\s/g, "").at(-1));
        // A damaged saved manuscript may retain the opening quote after its
        // final `Send:` call to action but lose only the closing quote. Restore
        // that unambiguous final quote after the sentence punctuation.
        text = text.replace(/(\bSend\s*:\s*)(["“„])\s*([^"“”„‟\n]+[.!?])\s*$/u,
          (match, prefix, opening, body) => `${prefix.replace(/:\s*$/u, ": ")}"${body.trim()}"`);
        text = text.replace(/\bSend\s*:\s*"\s+([^"\n]+)"\s*$/u,
          (match, body) => `Send: "${body.trim()}"`);
        text = text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n");
        text = text.replace(/\s+([,.;:!?])/g, "$1");
        text = text.replace(/([\[(])\s+/g, "$1").replace(/\s+([\])])/g, "$1");
        text = text.replace(/\n{3,}/g, "\n\n");
        return segmentScriptParagraphs(normalizeLanguagePunctuation(text.trim()));
      }
      function scriptSentences(block) {
        const value = String(block || "").replace(/\s*\n\s*/g, " ").trim();
        if (!value) return [];
        const sentences = [];
        // Dots inside addresses and abbreviations are not sentence boundaries.
        const protectedSpans = [...value.matchAll(/(?:https?:\/\/|www\.)[^\s<>"“”]+[^\s<>"“”.,!?;:)]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:[A-Za-z]\.){2,}|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:\/[^\s]*)?/g)]
          .map(match => [match.index, match.index + match[0].length]);
        let start = 0;
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index];
          if (!".!?".includes(character)) continue;
          if (protectedSpans.some(([from, to]) => index >= from && index < to)) continue;
          if (character === ".") {
            const previous = value[index - 1] || "";
            const next = value[index + 1] || "";
            if (/\d/.test(previous) && /\d/.test(next)) continue;
            if (value.slice(index, index + 3) === "...") {
              index += 2;
            } else {
              const word = (value.slice(start, index).match(/[A-Za-z]+$/) || [""])[0];
              if (/^(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Rev|Jr|Sr)$/i.test(word)) continue;
            }
          }
          while (/["'”’」』）)\]]/.test(value[index + 1] || "")) index += 1;
          const sentence = value.slice(start, index + 1).trim();
          if (sentence) sentences.push(sentence);
          start = index + 1;
        }
        const tail = value.slice(start).trim();
        if (tail) sentences.push(tail);
        return sentences;
      }
      function segmentScriptParagraphs(input, maxSentences = 3, maxLength = 240) {
        const sourceBlocks = String(input || "").split(/\n\s*\n/).filter((block) => block.trim());
        const paragraphs = [];
        for (const sourceBlock of sourceBlocks) {
          const sentences = scriptSentences(sourceBlock);
          let current = [];
          let currentLength = 0;
          for (const sentence of sentences) {
            const nextLength = currentLength + (current.length ? 1 : 0) + sentence.length;
            if (current.length && (current.length >= maxSentences || nextLength > maxLength)) {
              paragraphs.push(current.join(" "));
              current = [];
              currentLength = 0;
            }
            current.push(sentence);
            currentLength += (current.length > 1 ? 1 : 0) + sentence.length;
          }
          if (current.length) paragraphs.push(current.join(" "));
        }
        return paragraphs.join("\n\n");
      }
      $("cleanScriptText").onclick = () => {
        const input = $("scriptText");
        const cleaned = cleanScriptCopy(input.value);
        const reference = $("autoCaptionScript");
        if (cleaned === input.value && (!reference || reference.value === cleaned)) {
          toast("文案格式已经符合规则");
          return;
        }
        snapshot();
        input.value = cleaned;
        if (reference) {
          reference.value = cleaned;
          reference.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        queueAutosave();
        toast("文案已校对，可用于 CC 语音识别和字幕匹配");
      };
      $("colorControls").onclick = (event) => {
        const reset = event.target.closest("[data-reset-color-slice]");
        if (!reset) return;
        const grade = selectedVideoGrade?.(true);
        if (!grade) return;
        snapshot();
        grade.slices = normalizeColorSlices(grade.slices);
        grade.slices[reset.dataset.resetColorSlice] = { hue: 0, saturation: 0, intensity: 0 };
        colorControls();
        applyVideoCss();
        queueAutosave();
      };
      let windowResizeTimer = 0;
      window.onresize = () => {
        applyLayout();
        updateFrameSize(false);
        scheduleTimelineRender();
        clearTimeout(windowResizeTimer);
        windowResizeTimer = setTimeout(() => updateFrameSize(true), 140);
      };
      function isTypingField(el) {
        if (!el || el === document.body) return false;
        if (el.isContentEditable) return true;
        const tag = String(el.tagName || "");
        if (tag === "TEXTAREA") return true;
        if (tag !== "INPUT") return false;
        return ["text", "search", "password", "email", "url", "tel", "number"].includes(
          String(el.type || "text").toLowerCase(),
        );
      }
      function blurActiveTextField() {
        const active = document.activeElement;
        if (isTypingField(active)) active.blur();
      }
      function handleEditorShortcut(e) {
        if (globalThis.mediaOperationBusy) { e.preventDefault(); return; }
        if (!state.editorActive) return;
        const target = e.target || document.activeElement;
        const textEditing = isTypingField(target);
        const command = e.metaKey || e.ctrlKey;
        const code = e.code || "";
        if (!e.isComposing && e.shiftKey && !command && !e.altKey && (code === "KeyF" || String(e.key).toLowerCase() === "f") && !textEditing) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (!e.repeat) openSubtitleSearch();
          return;
        }
        if ($("subtitleSearchDialog")?.open) return;
        if (code === "F11" && !textEditing) {
          e.preventDefault();
          togglePreviewFullscreen();
          return;
        }
        if (code === "Escape" && $("stage")?.classList.contains("preview-fullscreen")) {
          e.preventDefault();
          $("stage").classList.remove("preview-fullscreen");
          syncPreviewFullscreen();
          return;
        }
        if (command && code === "KeyA" && target?.id === "scriptText") {
          e.preventDefault();
          e.stopImmediatePropagation();
          target.select();
          return;
        }
        if ((code === "KeyZ" || e.key === "Z" || e.key === "z") && e.shiftKey && !command && !textEditing) {
          e.preventDefault();
          e.stopImmediatePropagation();
          zoomToFitTimeline();
          return;
        }
        if (command && code === "KeyZ" && !textEditing) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (e.shiftKey) redoSnapshot();
          else restoreSnapshot();
          return;
        }
        if (command && code === "KeyS") {
          e.preventDefault();
          e.stopImmediatePropagation();
          saveProject();
          return;
        }
        if (
          command &&
          (code === "Equal" ||
            code === "Minus" ||
            code === "Digit0" ||
            code === "NumpadAdd" ||
            code === "NumpadSubtract" ||
            code === "Numpad0" ||
            e.key === "+" ||
            e.key === "-" ||
            e.key === "=" ||
            e.key === "_")
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (!textEditing) {
            if (code === "Digit0" || code === "Numpad0") zoomToFitTimeline();
            else if (code === "Minus" || code === "NumpadSubtract" || e.key === "-" || e.key === "_")
              setTimelineZoomAroundPlayhead(state.zoom * 0.88);
            else setTimelineZoomAroundPlayhead(state.zoom * 1.14);
          }
          return;
        }
        if (code === "KeyA" && e.altKey && !command && !textEditing) {
          e.preventDefault();
          selectAfterPlayhead();
          return;
        }
        if (code === "KeyA" && !e.altKey && !command && !textEditing) {
          e.preventDefault();
          if (editTool !== "select") {
            setEditTool("select");
            toast("选择模式 (A)");
          }
          return;
        }
        if (code === "KeyZ" && e.shiftKey && !command && !textEditing) {
          e.preventDefault();
          zoomToFitTimeline();
          toast("缩放以适应时间线 (Shift+Z)");
          return;
        }
        if (code === "KeyI" && !command && !textEditing) {
          e.preventDefault();
          const end = state.timelineRange?.end && state.timelineRange.end > state.currentTime
            ? state.timelineRange.end
            : state.duration;
          state.timelineRange = { start: state.currentTime, end, types: [] };
          syncTimelineRangeOverlay();
          toast(`标记入点 In (${formatTime(state.currentTime)})`);
          return;
        }
        if (code === "KeyO" && !command && !textEditing) {
          e.preventDefault();
          const start = state.timelineRange?.start && state.timelineRange.start < state.currentTime
            ? state.timelineRange.start
            : 0;
          state.timelineRange = { start, end: state.currentTime, types: [] };
          syncTimelineRangeOverlay();
          toast(`标记出点 Out (${formatTime(state.currentTime)})`);
          return;
        }
        if (code === "KeyX" && e.altKey && !textEditing) {
          e.preventDefault();
          state.timelineRange = null;
          syncTimelineRangeOverlay();
          toast("已清除入点/出点选区 (Alt+X)");
          return;
        }
        if (command && code === "KeyA" && !textEditing) {
          e.preventDefault();
          e.stopImmediatePropagation();
          state.selectedItems = [...
            new Map(
              [...$("timelineContent").querySelectorAll(".clip[data-type][data-id]")].map(
                (clip) => [
                  selectionKey(clip.dataset.type, clip.dataset.id),
                  { type: clip.dataset.type, id: clip.dataset.id },
                ],
              ),
            ).values(),
          ];
          state.selected = state.selectedItems.at(-1) || { type: "video", id: "main" };
          renderTimeline();
          renderPreviewObjects();
          updateInspector();
          return;
        }
        if (command && !textEditing && ["KeyC", "KeyV", "KeyD"].includes(code)) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (code === "KeyC") copyTimelineClips();
          else if (code === "KeyV") pasteTimelineClips();
          else duplicateTimelineClips();
          return;
        }
        if (command && (code === "KeyB" || code === "Backslash") && !textEditing) {
          e.preventDefault();
          splitSelected();
          return;
        }
        if (code === "KeyA" && !e.altKey && !command && !textEditing) {
          e.preventDefault();
          setEditTool("select");
          toast("选择模式 (A)：修剪当前片段，前后锁定不动");
          return;
        }
        if (code === "KeyT" && !command && !textEditing) {
          e.preventDefault();
          setEditTool(editTool === "trim" ? "select" : "trim");
          toast(editTool === "trim" ? "波纹修剪模式 (T)：拖动边缘全轨推移" : "选择模式 (A)");
          return;
        }
        if (code === "KeyB" && !command && !textEditing) {
          e.preventDefault();
          setEditTool(editTool === "blade" ? "select" : "blade");
          toast(editTool === "blade" ? "剃刀模式 (B)：点击片段切割" : "选择模式 (A)");
          return;
        }
        if (code === "KeyN" && !command && !textEditing) {
          e.preventDefault();
          toggleSnapping();
          return;
        }
        if (code === "KeyV" && !command && !textEditing) {
          e.preventDefault();
          selectNearestEditPoint();
          return;
        }
        if (code === "KeyM" && !command && !textEditing) {
          e.preventDefault();
          if (e.altKey) deleteTimelineMarkerAtPlayhead();
          else if (e.shiftKey) jumpTimelineMarker("next");
          else addTimelineMarker();
          return;
        }
        if (textEditing) return;
        if (code === "Comma" && !e.shiftKey && !command) {
          e.preventDefault();
          nudgeSelectedClips(-frameDuration());
          return;
        }
        if (code === "Period" && !e.shiftKey && !command) {
          e.preventDefault();
          nudgeSelectedClips(frameDuration());
          return;
        }
        if (code === "Space") {
          e.preventDefault();
          e.stopImmediatePropagation();
          // Space is exclusively the transport play/pause command. Ignore OS
          // key-repeat so one physical press cannot start, pause and start an
          // async media request again before the first play() has settled.
          if (e.repeat) return;
          void togglePlay();
        } else if (code === "Delete") {
          e.preventDefault();
          // 达芬奇标准：Delete 键为波纹删除（Ripple Delete，后方片段自动靠拢）
          deleteSelected(!e.shiftKey);
        } else if (code === "Backspace") {
          e.preventDefault();
          // 达芬奇标准：Backspace 键为普通删除（Lift 原地留空），Shift+Backspace 为波纹删除
          deleteSelected(!!e.shiftKey);
        } else if (code === "ArrowLeft") {
          e.preventDefault();
          seekTimeline(state.currentTime - (e.shiftKey ? 1 : frameDuration()));
        } else if (code === "ArrowRight") {
          e.preventDefault();
          seekTimeline(state.currentTime + (e.shiftKey ? 1 : frameDuration()));
        } else if (code === "ArrowUp") {
          e.preventDefault();
          jumpToCutPoint("prev");
        } else if (code === "ArrowDown") {
          e.preventDefault();
          jumpToCutPoint("next");
        } else if (code === "Home") {
          e.preventDefault();
          seekTimeline(0);
          toast("时间线开头 (Home)");
        } else if (code === "End") {
          e.preventDefault();
          seekTimeline(state.duration);
          toast("时间线结尾 (End)");
        } else if (code === "KeyQ") trimAtPlayhead("left");
        else if (code === "KeyW") trimAtPlayhead("right");
        else if (code === "KeyJ") {
          e.preventDefault();
          handleShuttleKey("KeyJ");
        } else if (code === "KeyK") {
          e.preventDefault();
          handleShuttleKey("KeyK");
        } else if (code === "KeyL") {
          e.preventDefault();
          handleShuttleKey("KeyL");
        } else if (e.shiftKey && (code === "BracketRight" || code === "Period")) {
          e.preventDefault();
          stepPlaybackSpeed(1);
        } else if (e.shiftKey && (code === "BracketLeft" || code === "Comma")) {
          e.preventDefault();
          stepPlaybackSpeed(-1);
        } else if (e.shiftKey && code === "KeyR") {
          e.preventDefault();
          setPlaybackSpeed(1.0, true);
        } else if (code === "Escape") {
          if (editTool === "blade") {
            setEditTool("select");
            toast("选择模式 (A)");
          }
          hideSnapGuide();
          state.selectedItems = [];
          state.selected = { type: "video", id: "main" };
          renderAll();
        }
      }
      window.addEventListener("keydown", handleEditorShortcut, true);
      window.__clipAssistantHandleShortcut = handleEditorShortcut;
      document.addEventListener(
        "pointerdown",
        (event) => {
          if (event.target.closest?.("textarea, select, [contenteditable='true']")) return;
          if (event.target.closest?.("input") && isTypingField(event.target.closest("input")))
            return;
          blurActiveTextField();
        },
        true,
      );
      let dragDepth = 0;
      let latestExternalDropIntent = {
        target: "media",
        time: 0,
        trackId: "",
        spliceRegionId: "",
        updatedAt: 0,
      };
      const recentBrowserDrops = new Map();
      function hasDragType(event, type) {
        return [...(event.dataTransfer?.types || [])].includes(type);
      }
      function isImageDrop(event) {
        if (hasDragType(event, "application/x-clipassistant-image-asset")) return true;
        const imageExtension = /\.(png|jpe?g|webp|gif|heic|bmp|tiff?)$/i;
        const items = [...(event.dataTransfer?.items || [])];
        if (items.some((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))) return true;
        return [...(event.dataTransfer?.files || [])].some((file) =>
          String(file.type || "").startsWith("image/") || imageExtension.test(file.name || file.path || ""),
        );
      }
      function clearDropUi() {
        dragDepth = 0;
        hideSnapGuide();
        $("dropVeil").classList.remove("on");
        document
          .querySelectorAll("[data-drop-zone]")
          .forEach((zone) => zone.classList.remove("drag"));
        document.querySelectorAll("#spliceGuideLayer .drop-target")
          .forEach((region) => region.classList.remove("drop-target"));
      }
      function dropLocation(event) {
        const zone = event.target?.closest?.("[data-drop-zone]");
        const target = zone?.dataset.dropZone || "media";
        const trackId = event.target?.closest?.(".trackrow[data-track-key]")
          ?.dataset.trackKey || "";
        const spliceRegionId = target === "preview" && !isImageDrop(event)
          ? window.spliceRegionAtPoint?.(event.clientX, event.clientY) || ""
          : "";
        let time = state.currentTime;
        if (target === "timeline") {
          const rect = $("timelineScroll").getBoundingClientRect();
          time = snapTime(
            clamp(
              ($("timelineScroll").scrollLeft + event.clientX - rect.left) /
                state.zoom,
              0,
              visibleTimelineDuration(),
            ),
          );
        }
        return { target, time, trackId, spliceRegionId, editMode: normalizedTimelineEditMode() };
      }
      function sendDropIntent(intent) {
        latestExternalDropIntent = { ...intent, updatedAt: Date.now() };
        if (window.native?.setDropIntent)
          window.native.setDropIntent(intent).catch?.(() => {});
      }
      function showDropUi(intent) {
        $("dropVeilText").textContent =
          intent.target === "media"
            ? "加入素材区"
            : intent.target === "preview"
              ? intent.spliceRegionId
                ? `放入${window.spliceRegionName?.(intent.spliceRegionId) || "分区"}`
                : "放到当前画面"
              : `${intent.editMode === "insert" ? "插入" : intent.editMode === "place-on-top" ? "置于顶层" : "覆盖"}到时间线${intent.trackId ? ` · ${trackBadgeText(intent.trackId, trackInfo(intent.trackId))}` : " · V1/A1"}`;
        $("dropVeil").classList.add("on");
        document
          .querySelectorAll("[data-drop-zone]")
          .forEach((zone) =>
            zone.classList.toggle(
              "drag",
              zone.dataset.dropZone === intent.target,
            ),
          );
        document.querySelectorAll("#spliceGuideLayer [data-region-id]").forEach((region) =>
          region.classList.toggle("drop-target", region.dataset.regionId === intent.spliceRegionId),
        );
      }
      async function processDroppedItems(items) {
        if (!state.editorActive || !state.projectId) {
          if (items.length) toast("请先新建或打开一个工程");
          return;
        }
        for (const raw of items) {
          const supplied =
              typeof raw === "string"
                ? { path: raw, target: "media", time: state.currentTime }
                : raw || {},
            item =
              supplied.source === "native" &&
              Date.now() - latestExternalDropIntent.updatedAt < 5000
                ? { ...supplied, ...latestExternalDropIntent }
                : supplied,
            file = item.path || "",
            target = ["media", "preview", "timeline"].includes(item.target)
              ? item.target
              : "media",
            time = Number.isFinite(Number(item.time))
              ? Number(item.time)
              : state.currentTime,
            trackId = String(item.trackId || ""),
            spliceRegionId = String(item.spliceRegionId || ""),
            editMode = normalizedTimelineEditMode(item.editMode);
          if (!file) continue;
          const dropName = String(
            item.originalName || file.split("/").pop() || "",
          ).toLowerCase();
          if (
            item.source === "native" &&
            Date.now() - Number(recentBrowserDrops.get(dropName) || 0) < 2500
          )
            continue;
          try {
            toast(`正在导入：${file.split("/").pop() || "素材"}`);
            if (/\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file)) {
              const info = await nativeCall("addVideoPath", {
                projectId: state.projectId,
                path: file,
              });
              await importVideo(info, target, time, trackId, spliceRegionId, editMode);
            } else if (/\.(png|jpe?g|webp|gif|heic|bmp|tiff?)$/i.test(file)) {
              const info = await nativeCall("addImagePath", {
                projectId: state.projectId,
                path: file,
              });
              await importImage(info, target, time, trackId, spliceRegionId, editMode);
            } else if (/\.(mp3|m4a|wav|aac|flac|aiff?)$/i.test(file)) {
              const info = await nativeCall("addAudioPath", {
                projectId: state.projectId,
                path: file,
              });
              await importAudio(info, target, time, trackId, editMode);
            } else if (/\.(srt|vtt|ass)$/i.test(file)) {
              const info = await nativeCall("addSubtitlePath", {
                projectId: state.projectId,
                path: file,
              });
              await importSubtitle(info, target, time, trackId, editMode);
            } else toast(`暂不支持这个文件：${file.split("/").pop()}`);
          } catch (error) {
            toast(error.message);
          }
        }
      }
      async function uploadBrowserFiles(files, intent) {
        if (!files.length) return;
        const endpoint = await nativeCall("uploadEndpoint");
        const uploaded = [];
        for (const file of files) {
          const name = file.name || "asset";
          recentBrowserDrops.set(name.toLowerCase(), Date.now());
          const response = await fetch(
            `${endpoint}?name=${encodeURIComponent(name)}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": file.type || "application/octet-stream",
              },
              body: file,
            },
          );
          if (!response.ok) throw new Error(`无法读取拖入的素材：${name}`);
          const result = await response.json();
          uploaded.push({
            ...intent,
            path: result.path,
            originalName: name,
            source: "browser",
          });
        }
        await processDroppedItems(uploaded);
      }
      window.addEventListener(
        "dragenter",
        (event) => {
          if (hasDragType(event, "application/x-clipassistant-track")) return;
          event.preventDefault();
          if (!state.editorActive) return;
          dragDepth += 1;
          const intent = dropLocation(event);
          sendDropIntent(intent);
          showDropUi(intent);
        },
        true,
      );
      window.addEventListener(
        "dragover",
        (event) => {
          if (hasDragType(event, "application/x-clipassistant-track")) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          if (!state.editorActive) return;
          const intent = dropLocation(event);
          sendDropIntent(intent);
          showDropUi(intent);
        },
        true,
      );
      window.addEventListener(
        "dragleave",
        (event) => {
          if (hasDragType(event, "application/x-clipassistant-track")) return;
          event.preventDefault();
          dragDepth = Math.max(0, dragDepth - 1);
          if (!event.relatedTarget || dragDepth === 0) clearDropUi();
        },
        true,
      );
      window.addEventListener(
        "drop",
        (event) => {
          if (hasDragType(event, "application/x-clipassistant-track")) return;
          event.preventDefault();
          event.stopPropagation();
          if (!state.editorActive) {
            toast("请先新建或打开一个工程");
            return;
          }
          const intent = dropLocation(event);
          sendDropIntent(intent, true);
          clearDropUi();
          const internalId = event.dataTransfer?.getData?.(
            "application/x-clipassistant-asset",
          );
          if (internalId) {
            placeLibraryAsset(
              internalId,
              intent.target,
              intent.time,
              intent.trackId,
              intent.spliceRegionId,
              intent.editMode,
            );
            return;
          }
          const direct = [...(event.dataTransfer?.files || [])]
            .map((file) => file.path || "")
            .filter((path) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path));
          if (direct.length)
            processDroppedItems(
              direct.map((path) => {
                const originalName = path.split("/").pop() || "";
                recentBrowserDrops.set(originalName.toLowerCase(), Date.now());
                return { ...intent, path, originalName, source: "browser" };
              }),
            );
              else {
                const files = [...(event.dataTransfer?.files || [])];
                if (files.length) {
                  window.__clipAssistantExternalDropFiles = files;
                  window.setTimeout(async () => {
                try {
                  const nativeFiles = window.native?.takeDroppedFiles
                    ? unwrap(await window.native.takeDroppedFiles())
                    : [];
                      if (nativeFiles?.length) {
                    await processDroppedItems(nativeFiles.map((item) =>
                      typeof item === "string"
                        ? { ...intent, path: item, source: "native" }
                        : { ...intent, ...item, source: "native" },
                    ));
                        return;
                      }
                      const resolved = await nativeCall("resolveDroppedFilePaths");
                      if (resolved?.length) {
                        await processDroppedItems(resolved.map((path) => ({
                          ...intent,
                          path,
                          source: "native",
                        })));
                        return;
                      }
                      window.__clipAssistantExternalDropFiles = null;
                      if (state.editorActive) { await uploadBrowserFiles(files, intent); return; }
                      toast("无法取得拖入素材的原路径，请点击“导入素材”选择；不会复制素材副本");
                } catch (error) {
                  toast(error.message);
                }
              }, 450);
            }
          }
        },
        true,
      );
      async function pollDrops() {
        try {
          if (window.native?.takeDroppedFiles) {
            const files = unwrap(await window.native.takeDroppedFiles());
            if (files?.length)
              await processDroppedItems(
                files.map((item) =>
                  typeof item === "string"
                    ? { path: item, source: "native" }
                    : { ...item, source: "native" },
                ),
              );
          }
        } catch (error) {
          console.warn(error);
        }
        setTimeout(pollDrops, 250);
      }
      window.__clipAssistantProcessDrops = processDroppedItems;
      window.__clipAssistantUploadFiles = uploadBrowserFiles;
      window.addEventListener("focus", () => {
        refreshSourceAvailability().catch((error) => console.warn(error));
      });
      $("scriptText").addEventListener("input", queueAutosave);
      renderPresets();
      colorControls();
      beautyControls();
      installRangeSteppers();
      renderProjectHome([]);
      pollDrops();
      renderFontFamilyOptions();
      async function ensureResolvePlugin() {
        return;
        try {
          const result = await nativeCall("installResolveLink");
          if (result?.changed)
            toast("达芬奇插件已装好：工作区 → 脚本 → 剪辑助手");
        } catch (error) {
          console.warn(error);
        }
      }
      waitNative()
        .then(async () => {
          await Promise.all([
            refreshHome(),
            loadCustomPresets(),
            loadLocalFonts(),
          ]);
        })
        .catch((error) => showFatal(error.message));
    
