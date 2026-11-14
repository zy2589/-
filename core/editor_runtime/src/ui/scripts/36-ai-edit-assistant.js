      const aiEditActionLabels = {
        transcribe_captions: "转录并生成字幕",
        align_script: "按正确文案对齐字幕",
        check_differences: "核对错词和重读",
        remove_confirmed_repeats: "剪除 AI 已确认的重复重读",
      };
      let aiEditMessages = [];
      let aiEditBusy = false;
      let aiEditProjectId = "";

      function aiEditMediaCount() {
        const items = [state.video, ...(state.videoLayers || []), ...(state.audioAssets || []), ...(state.images || []), ...(state.libraryAssets || [])].filter(Boolean);
        return new Set(items.map((item) => item.path || item.id || item.name).filter(Boolean)).size;
      }

      function aiEditContext() {
        const script = String($("scriptText")?.value || "").trim();
        const transcript = String(state.recognizedText || state.autoTranscript?.text || "").trim();
        return {
          projectName: state.projectName,
          hasVideo: !!state.video?.path,
          mediaCount: aiEditMediaCount(),
          duration: state.sourceDuration || state.duration || 0,
          hasScript: !!script,
          script,
          hasTranscript: !!transcript,
          transcript,
          captionCount: (state.captions || []).filter((item) => String(item.text || "").trim()).length,
          issues: (state.matchIssues?.length ? state.matchIssues : state.issues || []).map((issue) => ({
            id: issue.id,
            type: issue.type,
            start: issue.start,
            end: issue.end,
            spoken: issue.spokenText || issue.spoken,
            expected: issue.expectedText || issue.expected,
            scripture: issue.scripture,
            confirmedCut: issue.confirmedCut,
            action: issue.action,
          })),
        };
      }

      function renderAiEditMessages() {
        const container = $("aiEditMessages");
        if (!container) return;
        const welcome = $("aiEditWelcome");
        if (welcome) welcome.hidden = aiEditMessages.length > 0;
        container.querySelectorAll(".ai-edit-message").forEach((node) => node.remove());
        for (const item of aiEditMessages) {
          const bubble = document.createElement("div");
          bubble.className = `ai-edit-message ${item.role}${item.error ? " error" : ""}`;
          bubble.textContent = item.content;
          container.appendChild(bubble);
          if (item.actions?.length) {
            const list = document.createElement("div");
            list.className = "ai-edit-action-list";
            for (const action of item.actions) {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "btn";
              button.dataset.aiEditRun = action;
              button.textContent = item.actionState?.[action] || `执行：${aiEditActionLabels[action] || action}`;
              button.disabled = aiEditBusy || !!item.actionState?.[action];
              list.appendChild(button);
            }
            bubble.appendChild(list);
          }
          if (item.openSettings) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn ai-edit-open-settings";
            button.dataset.aiEditSettings = "true";
            button.textContent = "打开 AI 纠正设置";
            bubble.appendChild(button);
          }
        }
        container.scrollTop = container.scrollHeight;
      }

      function updateAiEditContextBadge() {
        if ($("aiEditMediaCount")) $("aiEditMediaCount").textContent = aiEditMediaCount();
        if ($("aiEditProjectName")) $("aiEditProjectName").textContent = state.projectName || "当前工程";
      }

      function appendAiEditMessage(role, content, extra = {}) {
        const item = { role, content: String(content || ""), ...extra };
        aiEditMessages.push(item);
        if (aiEditMessages.length > 30) aiEditMessages = aiEditMessages.slice(-30);
        renderAiEditMessages();
        return item;
      }

      async function sendAiEditMessage(text = $("aiEditInput")?.value || "") {
        const message = String(text || "").trim();
        if (!message || aiEditBusy) return;
        if (!state.projectId) return toast("请先打开一个工程");
        if (aiEditProjectId && aiEditProjectId !== state.projectId) aiEditMessages = [];
        aiEditProjectId = state.projectId;
        if ($("aiEditInput")) $("aiEditInput").value = "";
        appendAiEditMessage("user", message);
        aiEditBusy = true;
        if ($("aiEditSend")) { $("aiEditSend").disabled = true; $("aiEditSend").textContent = "…"; }
        const context = aiEditContext();
        const history = aiEditMessages.slice(-8).map(({ role, content }) => ({ role, content }));
        const pending = appendAiEditMessage("assistant", "Gemini 正在处理…如 60 秒内没有返回，会显示超时提示。请先确认工程中的媒体文件已加载。", { pending: true });
        try {
          const result = unwrap(await window.native.planEditAssistant({ message, context, history }));
          appendAiEditMessage("assistant", result.reply || "我已整理好建议步骤。", { actions: result.actions || [], actionState: {} });
        } catch (error) {
          const needsSettings = /纠正设置|API Key|Vertex|登录|未登录/i.test(String(error.message || ""));
          appendAiEditMessage("assistant", error.message || "AI 暂时无法处理，请重试。", { error: true, openSettings: needsSettings });
        } finally {
          const pendingIndex = aiEditMessages.indexOf(pending);
          if (pendingIndex >= 0) aiEditMessages.splice(pendingIndex, 1);
          aiEditBusy = false;
          if ($("aiEditSend")) { $("aiEditSend").disabled = false; $("aiEditSend").textContent = "↑"; }
          renderAiEditMessages();
        }
      }

      async function aiEditEnsureAlignment() {
        if (!state.video?.path) throw new Error("请先在当前工程导入视频或音频");
        if (!String($("scriptText")?.value || "").trim()) throw new Error("请先在「正确文案」里粘贴对应文稿");
        const result = await matchScript();
        if (result === false) throw new Error("文稿匹配未完成，请检查听写引擎和工程素材");
      }

      async function aiEditCheckDifferences() {
        await aiEditEnsureAlignment();
        const reviewed = await reviewScriptWithAi("natural", { quiet: true });
        if (!reviewed) throw new Error("AI 核对没有完成");
        const issues = state.issues || [];
        const repeats = issues.filter((item) => item.type === "repeat").length;
        const mismatches = issues.filter((item) => item.type === "mismatch" || item.type === "extra").length;
        const missing = issues.filter((item) => item.type === "missing").length;
        const safeCuts = issues.filter((item) => item.type === "repeat" && item.confirmedCut === true && item.scripture !== true && item.confirmedError !== true).length;
        return { repeats, mismatches, missing, safeCuts };
      }

      function aiEditCutConfirmedRepeats() {
        const selected = (state.issues || []).filter((item) =>
          item.type === "repeat" && item.confirmedCut === true && item.suppressReview !== true &&
          item.action !== "keep" && item.scripture !== true && item.confirmedError !== true,
        ).sort((a, b) => Number(b.start || 0) - Number(a.start || 0));
        if (!selected.length) return 0;
        snapshot();
        const currentTime = Number(state.currentTime || 0);
        let count = 0;
        for (const issue of selected) {
          if (!state.issues.some((item) => item.id === issue.id)) continue;
          cutScriptIssue(issue.id, { record: false, quiet: true });
          count += 1;
        }
        seekTimeline(Math.max(0, currentTime));
        renderAll();
        queueAutosave();
        return count;
      }

      async function runAiEditAction(action, button) {
        const message = [...aiEditMessages].reverse().find((item) => item.role === "assistant" && item.actions?.includes(action));
        if (!message || aiEditBusy) return;
        aiEditBusy = true;
        message.actionState = message.actionState || {};
        message.actionState[action] = "正在处理…";
        renderAiEditMessages();
        try {
          let answer = "";
          if (action === "transcribe_captions") {
            if (!state.video?.path) throw new Error("请先导入视频或音频");
            if (String($("scriptText")?.value || "").trim()) {
              const result = await matchScript();
              if (result === false) throw new Error("转录和文稿对齐未完成");
              answer = `已完成语音转录、字幕生成和文稿对齐。当前有 ${(state.reviewCaptions || []).length} 处差异标记，可继续核对。`;
            } else {
              const proofread = $("ccProofread");
              const previous = !!proofread?.checked;
              if (proofread) proofread.checked = false;
              try { await generateAutoCaptions({ forceRecognition: true }); }
              finally { if (proofread) proofread.checked = previous; }
              if (!(state.captions || []).length) throw new Error("没有生成字幕。请检查听写引擎设置和素材音轨。");
              answer = `已完成语音转录并生成 ${(state.captions || []).length} 条字幕。当前没有正确文案；粘贴文稿后可继续对齐并核对错词。`;
            }
          } else if (action === "align_script") {
            await aiEditEnsureAlignment();
            answer = `已按正确文案完成字幕对齐，标记了 ${(state.reviewCaptions || []).length} 处需核对的差异。`;
          } else if (action === "check_differences") {
            const result = await aiEditCheckDifferences();
            answer = `核对完成：${result.repeats} 处重复/重读，${result.mismatches} 处错词或多读，${result.missing} 处漏读；其中 ${result.safeCuts} 处被确认为可剪除的重复重读。错词和不确定内容保留标记，未自动删除。`;
          } else if (action === "remove_confirmed_repeats") {
            const result = await aiEditCheckDifferences();
            const removed = aiEditCutConfirmedRepeats();
            answer = removed
              ? `已剪除 ${removed} 处 AI 确认的重复重读。${result.mismatches + result.missing ? `另有 ${result.mismatches + result.missing} 处错词/漏读保留标记，供你复核。` : ""}`
              : "没有可安全自动剪除的重复重读。错词、经文差异和不确定片段都保留在时间线上供你复核。";
          } else {
            throw new Error("不支持这个剪辑步骤");
          }
          message.actionState[action] = "已完成 ✓";
          appendAiEditMessage("assistant", answer);
        } catch (error) {
          delete message.actionState[action];
          appendAiEditMessage("assistant", error.message || "该步骤没有完成。", { error: true });
        } finally {
          aiEditBusy = false;
          renderAiEditMessages();
          updateAiEditContextBadge();
        }
      }

      $("aiEditSend")?.addEventListener("click", () => sendAiEditMessage());
      $("aiEditInput")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          sendAiEditMessage();
        }
      });
      $("aiEditMessages")?.addEventListener("click", (event) => {
        const prompt = event.target.closest?.("[data-ai-edit-prompt]");
        if (prompt) { sendAiEditMessage(prompt.dataset.aiEditPrompt); return; }
        const run = event.target.closest?.("[data-ai-edit-run]");
        if (run) { runAiEditAction(run.dataset.aiEditRun, run); return; }
        if (event.target.closest?.("[data-ai-edit-settings]")) openReviewSettings();
      });
      $("aiEditRefreshContext")?.addEventListener("click", updateAiEditContextBadge);
      updateAiEditContextBadge();
