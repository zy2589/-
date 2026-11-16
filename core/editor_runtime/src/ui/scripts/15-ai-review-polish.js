function polishSectionHtml(title, rows, emptyText) {
        const items = (rows || [])
          .map(
            (row) =>
              `<button type="button" class="btn wide" data-polish-id="${escapeHtml(row.id)}" style="margin:4px 0; text-align:left; white-space:normal">
                <strong>${escapeHtml(row.type || "")}</strong>
                ${escapeHtml(row.spoken || row.text || row.expected || "（无文字）")}
              </button>`,
          )
          .join("");
        return `<div style="margin-top:10px"><div class="small" style="font-weight:600">${escapeHtml(title)}（${(rows || []).length}）</div>${items || `<div class="small">${escapeHtml(emptyText)}</div>`}</div>`;
      }
      let currentPolishFilter = "all";
      function persistPauseGapChecks() {
        const planned = window.__pauseGapPlan || [];
        const boxes = [...document.querySelectorAll("[data-pause-gap]")];
        if (!boxes.length) return planned;
        const chosen = new Set(boxes.filter((item) => item.checked).map((item) => item.dataset.pauseGap));
        for (const gap of planned) {
          if (gap.locked) {
            gap.checked = false;
            continue;
          }
          gap.checked = chosen.has(gap.id);
        }
        return planned;
      }
      function rememberPolishPlan(plan, autoApplied = 0) {
        const next = { ...(plan || {}), autoApplied: Number(autoApplied) || 0 };
        state.lastPolishPlan = next;
        window.__lastPolishPlan = next;
        state.pauseGapPlan = (next.pauseGaps || []).map(g => ({ ...g }));
        window.__pauseGapPlan = state.pauseGapPlan;
        state.ignoredPolishIds = Array.from(window.__ignoredPolishIds || []);
        if ($("lastPolishReport")) $("lastPolishReport").disabled = false;
        queueAutosave();
      }
      function showLastPolishReport() {
        const plan = window.__lastPolishPlan;
        if (!plan) {
          toast("还没有整理结果。请先点全局整理。");
          return;
        }
        showGlobalPolishReport(plan, plan.autoApplied || 0);
      }
      function showGlobalPolishReport(plan, autoApplied) {
        rememberPolishPlan(plan, autoApplied);
        const summary =
          `自动切 ${autoApplied} 处重录/废读，口语并进 ${(plan.mergedSpoken || []).length} 条，清掉 ${(plan.strippedNotes || []).length} 处备注，${(plan.scriptureLock || []).length} 处经文锁定，${(plan.missing || []).length} 处缺读待补${(plan.leftover || []).length ? `，${plan.leftover.length} 处待确认` : ""}。气口建议切 ${plan.pauseSuggestCut || 0} 处。`;
        if ($("globalPolishSummarySidebar")) $("globalPolishSummarySidebar").textContent = summary;
        if ($("globalPolishSummary")) $("globalPolishSummary").textContent = summary;
        if ($("globalPolishBody")) {
          $("globalPolishBody").innerHTML = [
            polishSectionHtml("经文 / 神的话语（只锁定，请你点）", plan.scriptureLock, "没有经文待复核"),
            polishSectionHtml("气口体检", plan.pauseGaps, "没有需要切除的气口"),
            polishSectionHtml("缺读待补", plan.missing, "没有缺读"),
            polishSectionHtml("已自动切除", plan.autoCut, "没有自动切除"),
            polishSectionHtml("已并进绿字幕", plan.mergedSpoken, "没有口语需要并进"),
            polishSectionHtml("已清字幕备注", plan.strippedNotes, "没有备注"),
            polishSectionHtml("已保留口语", plan.keepSpoken, "没有额外口语"),
            polishSectionHtml("仍待确认", plan.leftover, "没有其余项"),
          ].join("");
        }

        renderPolishSidebarList();

        // 自动激活左侧全局体检 Tab
        document.querySelector('[data-side="polish"]')?.click();
      }

      function computeTextDiffHtml(spoken = "", expected = "", isScripture = false, issueType = "") {
        const s = String(spoken || "").replace(/^\s*[—-⌫]\s*$/, "").trim();
        const e = String(expected || "").replace(/^\s*[—-]\s*$/, "").trim();

        if (issueType === "repeat") {
          return {
            spokenHtml: `<span class="diff-del">${escapeHtml(s || "卡壳废读片段")}</span>`,
            expectedHtml: e ? escapeHtml(e) : `<span class="diff-muted">（后面已重新录制）</span>`,
            diagnosis: `🔁 卡壳重读：第 1 遍读错卡壳废话，建议立即波纹切除`,
          };
        }

        if (issueType === "missing" || (!s && e)) {
          return {
            spokenHtml: `<span class="diff-muted">（未口播任何语音）</span>`,
            expectedHtml: `<span class="diff-add">${escapeHtml(e)}</span>`,
            diagnosis: isScripture ? `✝ 经文漏读：文案有此经文，但录音未口播` : `⚠️ 文案漏读：文案有此内容，但录音未口播`,
          };
        }

        if (issueType === "extra" || issueType === "addition" || (s && !e)) {
          if (!e) {
            return {
              spokenHtml: `<span class="diff-add">${escapeHtml(s)}</span>`,
              expectedHtml: `<span class="diff-muted">（文案无此句）</span>`,
              diagnosis: `➕ 口播多读/语气拓展：口播了文案之外的内容`,
            };
          }
        }

        if (!s && !e) {
          return {
            spokenHtml: `（无语音）`,
            expectedHtml: `（无文案）`,
            diagnosis: `（无文字）`,
          };
        }

        const tokenize = (str) => {
          return str.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]|\s+/gu) || [str];
        };

        const tokensS = tokenize(s);
        const tokensE = tokenize(e);
        const m = tokensS.length;
        const n = tokensE.length;
        const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
        const norm = (t) => t.trim().toLowerCase();

        for (let i = 0; i < m; i++) {
          for (let j = 0; j < n; j++) {
            if (norm(tokensS[i]) === norm(tokensE[j])) {
              dp[i + 1][j + 1] = dp[i][j] + 1;
            } else {
              dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
          }
        }

        let i = m, j = n;
        const diffS = [];
        const diffE = [];

        while (i > 0 || j > 0) {
          if (i > 0 && j > 0 && norm(tokensS[i - 1]) === norm(tokensE[j - 1])) {
            diffS.unshift({ text: tokensS[i - 1], type: "same" });
            diffE.unshift({ text: tokensE[j - 1], type: "same" });
            i--; j--;
          } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diffE.unshift({ text: tokensE[j - 1], type: "added" });
            j--;
          } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            diffS.unshift({ text: tokensS[i - 1], type: "removed" });
            i--;
          }
        }

        const removedWords = diffS.filter(d => d.type === "removed" && d.text.trim()).map(d => d.text.trim());
        const addedWords = diffE.filter(d => d.type === "added" && d.text.trim()).map(d => d.text.trim());

        const spokenHtml = diffS.map(d => {
          if (d.type === "removed") {
            return `<span class="${isScripture ? "diff-scripture-mismatch" : "diff-del"}">${escapeHtml(d.text)}</span>`;
          }
          return escapeHtml(d.text);
        }).join("");

        const expectedHtml = diffE.map(d => {
          if (d.type === "added") {
            return `<span class="${isScripture ? "diff-scripture-mismatch" : "diff-add"}">${escapeHtml(d.text)}</span>`;
          }
          return escapeHtml(d.text);
        }).join("");

        let diagnosis = "";
        if (isScripture) {
          if (removedWords.length && addedWords.length) {
            diagnosis = `✝ 经文用词差异：把「${addedWords.slice(0, 3).join(" ")}」口播成了「${removedWords.slice(0, 3).join(" ")}」`;
          } else if (removedWords.length) {
            diagnosis = `✝ 经文多读词句：口播多出了「${removedWords.slice(0, 3).join(" ")}」`;
          } else if (addedWords.length) {
            diagnosis = `✝ 经文漏读词句：口播遗漏了「${addedWords.slice(0, 3).join(" ")}」`;
          } else {
            diagnosis = `✝ 经文保护复核：与标准经文对照`;
          }
        } else {
          if (removedWords.length && addedWords.length) {
            diagnosis = `🔀 字词读错/替换：文案「${addedWords.slice(0, 3).join(" ")}」口播为「${removedWords.slice(0, 3).join(" ")}」`;
          } else if (removedWords.length) {
            diagnosis = `➕ 口播多读：口播多出了「${removedWords.slice(0, 3).join(" ")}」`;
          } else if (addedWords.length) {
            diagnosis = `⚠️ 文案漏读：口播未读「${addedWords.slice(0, 3).join(" ")}」`;
          } else {
            diagnosis = `🔀 读法差异对照`;
          }
        }

        return { spokenHtml, expectedHtml, diagnosis };
      }

      function renderPolishSidebarList() {
        const plan = window.__lastPolishPlan;
        if (!plan) return;
        const threshold = Number($("pauseGapThreshold")?.value || 0.50);
        const unlockScripture = Boolean($("unlockScriptureGaps")?.checked);
        if ($("pauseThresholdValue")) $("pauseThresholdValue").textContent = `≥ ${threshold.toFixed(2)} 秒`;

        window.__ignoredPolishIds = window.__ignoredPolishIds || new Set();

        // 1. 气口列表
        const gaps = (window.__pauseGapPlan || plan.pauseGaps || [])
          .filter(g => !window.__ignoredPolishIds.has(g.id) && !g.ignored)
          .map((gap) => {
            const isScripture = gap.verdict === "scripture-keep" || gap.isScripture === true;
            const locked = isScripture && !unlockScripture;
            if (gap.userChecked === undefined) {
              gap.checked = !locked && (Number(gap.duration || 0) >= threshold || gap.verdict === "cut");
            } else if (locked) {
              gap.checked = false;
            }
            return {
              ...gap,
              isScripture,
              locked,
            };
          });
        window.__pauseGapPlan = gaps;

        // 2. 经文审校项
        const scriptures = (plan.scriptureLock || [])
          .filter(i => !window.__ignoredPolishIds.has(i.id) && !window.__ignoredPolishIds.has(i.issueId));

        // 3. 读法差异 / 口播补充项
        const allIssues = [...(state.issues || []), ...(state.matchIssues || []), ...(state.reviewCaptions || [])];
        const spokenDiffs = allIssues.filter(i => {
          if (window.__ignoredPolishIds.has(i.id) || window.__ignoredPolishIds.has(i.issueId)) return false;
          if (i.isScripture || i.scripture) return false;
          return i.type === "addition" || i.type === "extra" || i.type === "spokenDiff" || i.action === "insert" || i.action === "accept" || i.type === "mismatch";
        });
        const uniqueSpokenDiffs = Array.from(new Map(spokenDiffs.map(i => [i.issueId || i.id, i])).values())
          .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

        // 4. 重读 / 卡壳项
        const repeats = allIssues.filter(i => {
          if (window.__ignoredPolishIds.has(i.id) || window.__ignoredPolishIds.has(i.issueId)) return false;
          return i.type === "repeat" || i.action === "cut" || i.confirmedCut === true;
        });
        const uniqueRepeats = Array.from(new Map(repeats.map(i => [i.issueId || i.id, i])).values())
          .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

        // 5. 缺读待补项
        const missings = (plan.missing || []).concat(allIssues.filter(i => i.type === "missing" || i.action === "missing"))
          .filter(i => !window.__ignoredPolishIds.has(i.id) && !window.__ignoredPolishIds.has(i.issueId));
        const uniqueMissings = Array.from(new Map(missings.map(i => [i.issueId || i.id, i])).values())
          .sort((a, b) => Number(a.start || 0) - Number(b.start || 0));

        // 6. 备注清理项
        const notes = (plan.strippedNotes || []).filter(i => !window.__ignoredPolishIds.has(i.id));

        // 计算各 Tab 数量
        const pauseCount = gaps.length;
        const scriptureCount = scriptures.length + gaps.filter(g => g.isScripture).length;
        const spokenDiffCount = uniqueSpokenDiffs.length;
        const repeatCount = uniqueRepeats.length;
        const missingCount = uniqueMissings.length;
        const notesCount = notes.length;
        const allCount = pauseCount + scriptures.length + spokenDiffCount + repeatCount + missingCount + notesCount;
        const checkedCutCount = gaps.filter(g => g.checked && !g.locked).length;

        if ($("filterPolishAll")) $("filterPolishAll").textContent = `全部 (${allCount})`;
        if ($("filterPolishPause")) $("filterPolishPause").textContent = `气口 (${pauseCount})`;
        if ($("filterPolishScripture")) $("filterPolishScripture").textContent = `✝ 经文 (${scriptureCount})`;
        if ($("filterPolishSpokenDiff")) $("filterPolishSpokenDiff").textContent = `读法差异 (${spokenDiffCount})`;
        if ($("filterPolishRepeat")) $("filterPolishRepeat").textContent = `重读卡壳 (${repeatCount})`;
        if ($("filterPolishMissing")) $("filterPolishMissing").textContent = `缺读待补 (${missingCount})`;
        if ($("filterPolishNotes")) $("filterPolishNotes").textContent = `已清备注 (${notesCount})`;
        if ($("checkedGapsCount")) $("checkedGapsCount").textContent = checkedCutCount;

        const listEl = $("globalPolishListSidebar");
        if (!listEl) return;

        let cardsHtml = [];

        // --- 渲染经文项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "scripture") {
          for (const item of scriptures) {
            const spoken = item.spoken || item.spokenText || item.text || "";
            const expected = item.expected || item.expectedText || item.scripture || "";
            const { spokenHtml, expectedHtml, diagnosis } = computeTextDiffHtml(spoken, expected, true, item.type);

            cardsHtml.push(`
              <div class="polish-card scripture-card" data-polish-card-type="scripture-issue" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" data-start="${Number(item.start || 0)}">
                <div class="polish-card-header">
                  <div class="polish-card-title"><span class="polish-badge scripture">✝ 经文保护</span></div>
                  <span class="small" style="font-family:monospace; color:#facc15;">${formatTime(Number(item.start || 0))}</span>
                </div>
                <div class="diff-diagnosis scripture">${escapeHtml(diagnosis)}</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label scripture">🎙️ 口播</span>
                    <span class="polish-diff-content">${spokenHtml}</span>
                  </div>
                  <div class="polish-diff-line">
                    <span class="polish-diff-label scripture">📄 经文</span>
                    <span class="polish-diff-content">${expectedHtml}</span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview" data-start="${Number(item.start || 0)}" data-duration="${Number(item.duration || 2)}" title="跳点试听此段">▶ 试听</button>
                  <button class="btn small primary" data-polish-action="locate-issue" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" title="定位并复核">定位</button>
                  <button class="btn small" data-polish-action="replace-spoken" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" title="用实际识别到的口播替换文稿字幕（Alt+点击红段）">🎙 替换为口播</button>
                  <button class="btn small" data-polish-action="accept-issue" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" title="确认保留（并入相邻字幕）">✓ 保留</button>
                  <button class="btn small" data-polish-action="keep-solo" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" title="保留为独立字幕条，不与前后合并">✓ 独立字幕</button>
                  <button class="btn small" data-polish-action="ignore-issue" data-issue-id="${escapeHtml(item.id || item.issueId || "")}" title="忽略此项（不做任何改动）">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 渲染读法差异项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "spokenDiff") {
          for (const item of uniqueSpokenDiffs) {
            const spoken = item.spoken || item.spokenText || item.text || "";
            const expected = item.expected || item.expectedText || "";
            const { spokenHtml, expectedHtml, diagnosis } = computeTextDiffHtml(spoken, expected, false, item.type);

            const isAiHandled = item.suppressReview === true || item.action === "keep";
            const aiLabel = isAiHandled ? `<span class="polish-badge ai-handled" style="background:#555;color:#ccc;margin-left:6px;font-size:10px">🤖 AI 已保留</span>` : "";

            cardsHtml.push(`
              <div class="polish-card spoken-diff${isAiHandled ? " ai-handled" : ""}" data-polish-card-type="spoken-diff" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" data-start="${Number(item.start || 0)}" data-ai-handled="${isAiHandled ? "1" : ""}" style="${isAiHandled ? "opacity:0.6;" : ""}">
                <div class="polish-card-header">
                  <div class="polish-card-title"><span class="polish-badge spoken-diff">读法差异</span>${aiLabel}</div>
                  <span class="small" style="font-family:monospace; color:var(--muted);">${formatTime(Number(item.start || 0))}</span>
                </div>
                <div class="diff-diagnosis spoken-diff">${escapeHtml(diagnosis)}</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label spoken">🎙️ 口播</span>
                    <span class="polish-diff-content">${spokenHtml}</span>
                  </div>
                  <div class="polish-diff-line">
                    <span class="polish-diff-label expected">📄 文案</span>
                    <span class="polish-diff-content">${expectedHtml}</span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview" data-start="${Number(item.start || 0)}" data-duration="${Number(item.duration || 1.8)}">▶ 试听</button>
                  <button class="btn small primary" data-polish-action="locate-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}">定位</button>
                  <button class="btn small" data-polish-action="replace-spoken" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="用实际识别到的口播替换错误文稿字幕（Alt+点击红段）">🎙 替换为口播</button>
                  <button class="btn small" data-polish-action="accept-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="把口播内容并入相邻字幕">✓ 并入字幕</button>
                  <button class="btn small" data-polish-action="keep-solo" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="保留为独立字幕条，不与前后合并">✓ 独立字幕</button>
                  <button class="btn small danger" data-polish-action="cut-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="波纹切除此段">✂ 切除</button>
                  <button class="btn small" data-polish-action="ignore-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="忽略此项（音画与文稿保持原样）">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 渲染重读/卡壳项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "repeat") {
          for (const item of uniqueRepeats) {
            const spoken = item.spoken || item.spokenText || item.text || "";
            const expected = item.expected || item.expectedText || "";
            const { spokenHtml, expectedHtml, diagnosis } = computeTextDiffHtml(spoken, expected, false, "repeat");

            const isAiHandled = item.suppressReview === true || item.action === "keep" || item.confirmedCut === true;
            const aiLabel = isAiHandled
              ? item.confirmedCut ? `<span class="polish-badge ai-handled" style="background:#555;color:#ccc;margin-left:6px;font-size:10px">🤖 AI 已切除</span>`
              : `<span class="polish-badge ai-handled" style="background:#555;color:#ccc;margin-left:6px;font-size:10px">🤖 AI 已保留</span>`
              : "";

            cardsHtml.push(`
              <div class="polish-card repeat-suggest${isAiHandled ? " ai-handled" : ""}" data-polish-card-type="repeat-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" data-start="${Number(item.start || 0)}" data-ai-handled="${isAiHandled ? "1" : ""}" style="${isAiHandled ? "opacity:0.6;" : ""}">
                <div class="polish-card-header">
                  <div class="polish-card-title"><span class="polish-badge repeat">重读卡壳</span>${aiLabel}</div>
                  <span class="small" style="font-family:monospace; color:var(--muted);">${formatTime(Number(item.start || 0))}</span>
                </div>
                <div class="diff-diagnosis repeat">${escapeHtml(diagnosis)}</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label spoken">🎙️ 废读</span>
                    <span class="polish-diff-content">${spokenHtml}</span>
                  </div>
                  <div class="polish-diff-line">
                    <span class="polish-diff-label expected">📄 正读</span>
                    <span class="polish-diff-content">${expectedHtml}</span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview" data-start="${Number(item.start || 0)}" data-duration="${Number(item.duration || 1.5)}">▶ 试听</button>
                  <button class="btn small primary" data-polish-action="locate-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}">定位</button>
                  <button class="btn small" data-polish-action="replace-spoken" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="确认这遍口播正确时，用识别文字替换文稿字幕">🎙 替换为口播</button>
                  <button class="btn small" data-polish-action="accept-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="保留并合并到相邻字幕">✓ 并入字幕</button>
                  <button class="btn small" data-polish-action="keep-solo" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="保留为独立字幕条，不与前后合并">✓ 独立字幕</button>
                  <button class="btn small danger" data-polish-action="cut-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="波纹切除此废话">✂ 立即切除</button>
                  <button class="btn small" data-polish-action="ignore-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" title="忽略此项（保持原样）">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 渲染缺读待补项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "missing") {
          for (const item of uniqueMissings) {
            const spoken = item.spoken || item.spokenText || item.text || "";
            const expected = item.expected || item.expectedText || "";
            const { spokenHtml, expectedHtml, diagnosis } = computeTextDiffHtml(spoken, expected, item.isScripture || item.scripture, "missing");

            cardsHtml.push(`
              <div class="polish-card missing-suggest" data-polish-card-type="missing-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}" data-start="${Number(item.start || 0)}">
                <div class="polish-card-header">
                  <div class="polish-card-title"><span class="polish-badge missing">缺读待补</span></div>
                  <span class="small" style="font-family:monospace; color:var(--muted);">${formatTime(Number(item.start || 0))}</span>
                </div>
                <div class="diff-diagnosis missing">${escapeHtml(diagnosis)}</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label spoken">🎙️ 口播</span>
                    <span class="polish-diff-content">${spokenHtml}</span>
                  </div>
                  <div class="polish-diff-line">
                    <span class="polish-diff-label expected">📄 文案</span>
                    <span class="polish-diff-content">${expectedHtml}</span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview" data-start="${Number(item.start || 0)}" data-duration="2">▶ 试听</button>
                  <button class="btn small primary" data-polish-action="locate-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}">定位</button>
                  <button class="btn small" data-polish-action="ignore-issue" data-issue-id="${escapeHtml(item.issueId || item.id || "")}">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 渲染气口停顿项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "pause" || currentPolishFilter === "scripture") {
          for (const gap of gaps) {
            if (currentPolishFilter === "scripture" && !gap.isScripture) continue;

            const isScripture = gap.isScripture;
            const isCut = gap.checked && !gap.locked;
            const cardClass = isScripture ? "polish-card scripture-card" : isCut ? "polish-card cut-suggest" : "polish-card keep-suggest";
            const badgeClass = isScripture ? "polish-badge scripture" : isCut ? "polish-badge cut" : "polish-badge keep";
            const badgeLabel = isScripture ? "✝ 经文附近" : isCut ? "过长建议切" : "合理建议留";
            const diagnosis = isScripture
              ? `✝ 经文停顿：经文附近停顿 ${Number(gap.duration || 0).toFixed(2)} 秒（默认受保护锁定）`
              : isCut
              ? `⏱️ 气口过长：句子间停顿 ${Number(gap.duration || 0).toFixed(2)} 秒（建议安全切除）`
              : `⏱️ 自然停顿：停顿 ${Number(gap.duration || 0).toFixed(2)} 秒（节奏自然建议保留）`;

            cardsHtml.push(`
              <div class="${cardClass}" data-polish-card-type="gap" data-gap-id="${escapeHtml(gap.id || "")}" data-start="${Number(gap.start || 0)}">
                <div class="polish-card-header">
                  <label style="display:flex; align-items:center; gap:6px; cursor:pointer; margin:0;">
                    <input type="checkbox" data-pause-gap="${escapeHtml(gap.id)}" ${gap.checked ? "checked" : ""} ${gap.locked ? "disabled title='经文保护默认锁定，可勾选上方解锁开关'" : ""} />
                    <span class="polish-card-title">${Number(gap.duration || 0).toFixed(2)}s</span>
                    <span class="${badgeClass}">${badgeLabel}</span>
                  </label>
                  <span class="small" style="font-family:monospace; color:var(--muted);">${formatTime(Number(gap.start || 0))}</span>
                </div>
                <div class="diff-diagnosis ${isScripture ? "scripture" : "pause"}">${escapeHtml(diagnosis)}</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label spoken">🎙️ 上下文</span>
                    <span class="polish-diff-content">
                      <span style="color:#d1d5db;">${escapeHtml(gap.leftText || "…")}</span>
                      <span style="color:var(--blue); margin:0 4px; font-weight:700;">⏸️ ${Number(gap.duration || 0).toFixed(2)}s →</span>
                      <span style="color:#d1d5db;">${escapeHtml(gap.rightText || "…")}</span>
                    </span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview-gap" data-gap-id="${escapeHtml(gap.id)}">▶ 试听</button>
                  <button class="btn small danger" data-polish-action="cut-gap" data-gap-id="${escapeHtml(gap.id)}" ${gap.locked ? "disabled title='受经文保护锁定'" : ""}>✂ 切除</button>
                  <button class="btn small" data-polish-action="merge-gap" data-gap-id="${escapeHtml(gap.id)}">╎ 合并</button>
                  <button class="btn small" data-polish-action="toggle-gap-keep" data-gap-id="${escapeHtml(gap.id)}">${gap.checked ? "留" : "切"}</button>
                  <button class="btn small" data-polish-action="ignore-gap" data-gap-id="${escapeHtml(gap.id)}" title="忽略此气口">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 渲染文案备注项 ---
        if (currentPolishFilter === "all" || currentPolishFilter === "notes") {
          for (const item of notes) {
            cardsHtml.push(`
              <div class="polish-card" data-polish-card-type="note-issue" data-issue-id="${escapeHtml(item.id || "")}" data-start="${Number(item.start || 0)}">
                <div class="polish-card-header">
                  <span class="polish-badge notes">已清备注</span>
                  <span class="small" style="font-family:monospace; color:var(--muted);">${formatTime(Number(item.start || 0))}</span>
                </div>
                <div class="diff-diagnosis">🧹 导演/动作提示词清理：已自动过滤无需做字幕</div>
                <div class="polish-diff-box">
                  <div class="polish-diff-line">
                    <span class="polish-diff-label expected">📄 清除备注</span>
                    <span class="polish-diff-content" style="color:var(--muted); text-decoration:line-through;">${escapeHtml(item.text || item.spoken || "备注文本")}</span>
                  </div>
                </div>
                <div class="polish-card-actions">
                  <button class="btn small" data-polish-action="preview" data-start="${Number(item.start || 0)}" data-duration="1.5">▶ 试听</button>
                  <button class="btn small" data-polish-action="ignore-issue" data-issue-id="${escapeHtml(item.id || "")}">✕ 忽略</button>
                </div>
              </div>
            `);
          }
        }

        // --- 分组：待人工在上，AI 已处理在下 ---
        const manualCards = cardsHtml.filter(html => !html.includes('data-ai-handled="1"'));
        const aiCards = cardsHtml.filter(html => html.includes('data-ai-handled="1"'));
        let finalHtml = manualCards.join("");
        if (aiCards.length) {
          finalHtml += `<div class="ai-handled-separator" style="padding:8px 12px;margin:8px 0 4px;background:rgba(80,80,80,0.25);border-radius:6px;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)"><span>🤖</span><span>AI 已处理 (${aiCards.length} 项) — 可点击覆盖 AI 决定</span></div>`;
          finalHtml += aiCards.join("");
        }

        if (!finalHtml) {
          listEl.innerHTML = `<div class="small" style="text-align:center; padding:32px 0; color:var(--muted);">🎉 当前分类下没有待处理项目</div>`;
        } else {
          listEl.innerHTML = finalHtml;
        }
      }

      function ignoreReviewIssue(issueId) {
        snapshot();
        window.__ignoredPolishIds = window.__ignoredPolishIds || new Set();
        window.__ignoredPolishIds.add(issueId);
        state.ignoredPolishIds = Array.from(window.__ignoredPolishIds);

        const review = (state.reviewCaptions || []).find((item) => item.id === issueId || item.issueId === issueId);
        const realIssueId = review?.issueId || review?.id || issueId;

        clearIssueWordFlags(realIssueId);
        if (review) dismissReviewMark(review);
        else {
          state.issues = (state.issues || []).filter((item) => item.id !== realIssueId);
          state.matchIssues = (state.matchIssues || []).filter((item) => item.id !== realIssueId);
          state.reviewCaptions = (state.reviewCaptions || []).filter((item) => (item.issueId || item.id) !== realIssueId);
        }

        renderAll();
        renderPolishSidebarList();
        queueAutosave();
        toast("已忽略此项（音画与文稿保持原样）");
      }

      function ignorePolishItem(type, id) {
        window.__ignoredPolishIds = window.__ignoredPolishIds || new Set();
        window.__ignoredPolishIds.add(id);
        state.ignoredPolishIds = Array.from(window.__ignoredPolishIds);

        if (type === "gap") {
          const gap = (window.__pauseGapPlan || []).find(g => g.id === id);
          if (gap) {
            gap.ignored = true;
            gap.checked = false;
          }
          state.pauseGapPlan = window.__pauseGapPlan;
          renderPolishSidebarList();
          queueAutosave();
          toast("已忽略该气口");
        } else {
          ignoreReviewIssue(id);
        }
      }

      function previewTimeRange(start, duration = 1.5) {
        seekTimeline(Math.max(0, start));
        if (!state.playing) {
          void togglePlay();
          const previewRequest = playRequestGeneration;
          setTimeout(() => {
            // A manual Space press creates a newer playback request. The old
            // timed preview must never pause that new user-controlled session.
            if (previewRequest !== playRequestGeneration) return;
            if (state.playing) void togglePlay();
          }, Math.max(800, (duration + 0.5) * 1000));
        }
      }

      function cutSinglePauseGap(gapId) {
        const gap = (window.__pauseGapPlan || []).find(g => g.id === gapId);
        if (!gap) return;
        if (gap.locked) {
          toast("该气口处于经文保护中，如需切除请先勾选上方解锁开关");
          return;
        }
        snapshot();
        const start = Math.max(0, Number(gap.cutStart || gap.start || 0));
        let end = Math.max(start + 0.04, Number(gap.cutEnd || gap.end || 0));
        end = Math.min(end, Math.max(start + 0.04, Number(gap.end || end) - 0.05));
        if (end <= start + 0.04) {
          toast("该气口过短，无法安全切除");
          return;
        }
        const sourceStart = timelineToSource(start);
        let sourceEnd = timelineToSource(end);
        if (sourceEnd <= sourceStart + 0.04) return;
        const nextCaption = (state.captions || [])
          .map((item) => Number(item.start || 0))
          .filter((time) => time >= Number(gap.end || end) - 0.02)
          .sort((left, right) => left - right)[0];
        if (Number.isFinite(nextCaption)) {
          const nextSource = timelineToSource(nextCaption);
          sourceEnd = Math.min(sourceEnd, Math.max(sourceStart + 0.04, nextSource - 0.05));
        }
        if (sourceEnd <= sourceStart + 0.04) return;
        state.removals.push({
          start: sourceStart,
          end: sourceEnd,
          source: "pause-gap",
        });
        shiftTracks(start, end - start);
        normalizeRemovals();
        recomputeContentDuration();
        clampTracksToDuration();
        seekTimeline(start);
        renderAll();

        window.__pauseGapPlan = (window.__pauseGapPlan || []).filter(g => g.id !== gapId);
        state.pauseGapPlan = window.__pauseGapPlan;
        renderPolishSidebarList();
        queueAutosave();
        toast(`已切除 ${Number(gap.duration || 0).toFixed(2)} 秒气口`);
      }

      function mergeCaptionsAcrossGap(gapId) {
        const gap = (window.__pauseGapPlan || []).find(g => g.id === gapId);
        if (!gap) return;
        const leftCap = (state.captions || []).find(c => Math.abs(Number(c.end || 0) - Number(gap.start || 0)) < 0.25 || (Number(c.start || 0) <= gap.start && Number(c.end || 0) <= gap.end));
        const rightCap = (state.captions || []).find(c => Math.abs(Number(c.start || 0) - Number(gap.end || 0)) < 0.25 || (Number(c.start || 0) >= gap.start && Number(c.end || 0) >= gap.end));
        if (leftCap && rightCap && leftCap.id !== rightCap.id) {
          snapshot();
          leftCap.text = `${(leftCap.text || "").trim()} ${(rightCap.text || "").trim()}`.trim();
          leftCap.end = rightCap.end;
          state.captions = state.captions.filter(c => c.id !== rightCap.id);
          renderAll();
          window.__pauseGapPlan = (window.__pauseGapPlan || []).filter(g => g.id !== gapId);
          state.pauseGapPlan = window.__pauseGapPlan;
          renderPolishSidebarList();
          queueAutosave();
          toast("已合并前后两句字幕");
        } else {
          toast("未找到紧邻该气口的前后字幕");
        }
      }
      async function runGlobalPolish() {
        const button = $("globalPolish");
        try {
          if (button) {
            button.disabled = true;
            button.textContent = "整理中…";
          }
          const hasCaptions = (state.captions || []).some((item) => String(item.text || "").trim());
          const hasMatch = (state.matchIssues || state.issues || []).length > 0;
          if (!hasCaptions || !hasMatch) {
            const matched = await matchScript();
            if (matched === false && !hasCaptions) return;
          }
          let plan = {
            autoCut: [],
            keepSpoken: [],
            scriptureLock: [],
            missing: [],
            leftover: [],
          };
          let autoCut = 0;
          if ((state.matchIssues || state.issues || []).length) {
            const reviewed = await reviewScriptWithAi("natural", { quiet: true });
            if (!reviewed) return;
            plan = reviewed.plan || plan;
            autoCut = reviewed.autoCut || 0;
          }
          try {
            const polished = unwrap(
              await window.native.polishCaptions({
                captions: state.captions || [],
                keepSpoken: plan.keepSpoken || [],
                issues: [...(state.issues || []), ...(state.matchIssues || [])],
              }),
            );
            if (Array.isArray(polished.captions)) state.captions = polished.captions;
            plan.mergedSpoken = polished.mergedSpoken || [];
            plan.strippedNotes = polished.strippedNotes || [];
          } catch {
            plan.mergedSpoken = [];
            plan.strippedNotes = [];
          }
          try {
            const pause = unwrap(
              await window.native.pauseGapPlan({
                captions: state.captions || [],
                issues: state.issues || [],
                options: currentPauseCutOptions(),
              }),
            );
            plan.pauseGaps = pause.gaps || [];
            plan.pauseSuggestCut = pause.suggestCut || 0;
            plan.pauseLocked = pause.locked || 0;
          } catch {
            plan.pauseGaps = [];
          }
          clampTracksToDuration();
          renderAll();
          if (!(state.captions || []).some((item) => String(item.text || "").trim()))
            toast("整理有结果，但时间线上还没有绿字幕。请确认已粘贴文案并完成匹配。");
          showGlobalPolishReport(plan, autoCut);
          toast(
            (state.matchIssues || state.issues || []).length
              ? `全局整理完成：${autoCut} 处已自动切，口语并进 ${(plan.mergedSpoken || []).length} 条，清掉 ${(plan.strippedNotes || []).length} 处备注，${(plan.scriptureLock || []).length} 处经文请你点，气口建议切 ${plan.pauseSuggestCut || 0} 处`
              : `口播与文案一致。清掉 ${(plan.strippedNotes || []).length} 处备注，气口建议切 ${plan.pauseSuggestCut || 0} 处，经文附近默认不切`,
          );
        } catch (error) {
          toast(error.message);
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = "全局整理";
          }
          updateAiReviewButton();
        }
      }
      function applySelectedPauseGaps() {
        persistPauseGapChecks();
        const planned = window.__pauseGapPlan || [];
        const cuts = planned
          .filter((gap) => gap.checked && gap.verdict !== "scripture-keep")
          .sort((left, right) => Number(right.start || 0) - Number(left.start || 0));
        if (!cuts.length) {
          toast("没有勾选可切的气口。经文附近默认不能切。");
          return 0;
        }
        snapshot();
        let applied = 0;
        const appliedIds = new Set();
        for (const gap of cuts) {
          const start = Math.max(0, Number(gap.cutStart || gap.start || 0));
          let end = Math.max(start + 0.04, Number(gap.cutEnd || gap.end || 0));
          end = Math.min(end, Math.max(start + 0.04, Number(gap.end || end) - 0.05));
          if (end <= start + 0.04) continue;
          const sourceStart = timelineToSource(start);
          let sourceEnd = timelineToSource(end);
          if (sourceEnd <= sourceStart + 0.04) continue;
          const nextCaption = (state.captions || [])
            .map((item) => Number(item.start || 0))
            .filter((time) => time >= Number(gap.end || end) - 0.02)
            .sort((left, right) => left - right)[0];
          if (Number.isFinite(nextCaption)) {
            const nextSource = timelineToSource(nextCaption);
            sourceEnd = Math.min(sourceEnd, Math.max(sourceStart + 0.04, nextSource - 0.05));
          }
          if (sourceEnd <= sourceStart + 0.04) continue;
          state.removals.push({
            start: sourceStart,
            end: sourceEnd,
            source: "pause-gap",
          });
          shiftTracks(start, end - start);
          appliedIds.add(gap.id);
          applied += 1;
        }
        normalizeRemovals();
        recomputeContentDuration();
        clampTracksToDuration();
        seekTimeline(0);
        renderAll();
        if ($("globalPolishModal")) $("globalPolishModal").classList.remove("on");
        state.pauseGapPlan = planned.filter(g => !appliedIds.has(g.id));
        window.__pauseGapPlan = state.pauseGapPlan;
        renderPolishSidebarList();
        queueAutosave();
        toast(applied ? `已切 ${applied} 处勾选气口，后面字幕只前移不删` : "这些气口没法安全切除");
        return applied;
      }
      async function reviewScriptWithAi(mode, { quiet = false } = {}) {
        const sourceIssues = state.matchIssues?.length ? state.matchIssues : state.issues;
        if (!sourceIssues.length) {
          toast("请先匹配文案");
          return;
        }
        const strict = mode === "strict";
        const button = $(strict ? "aiReviewStrict" : "aiReviewNatural");
        const label = strict ? "严格对照" : "自然流畅";
        try {
          updateAiReviewButton();
          if (button) {
            button.disabled = true;
            button.textContent = "纠正中…";
          }
          $("modelProgress").style.display = "block";
          $("modelProgress").firstElementChild.style.width = "55%";
          const result = unwrap(
            await window.native.reviewScriptIssues({
              mode: strict ? "strict" : "natural",
              script: $("scriptText").value,
              issues: sourceIssues.map((issue) => ({ ...issue })),
              operations: state.alignmentOperations || [],
              outputDuration: state.alignmentDuration || state.sourceDuration || state.duration,
            }),
          );
          snapshot();
          const captionsBefore = state.captions;
          state.issues = result.issues || [];
          state.reviewCaptions = (result.reviewCaptions || []).filter((item) =>
            ["missing", "repeat", "mismatch"].includes(item.type)
          );
          state.reviewCaptions = bindMatchedReviewSources(state.reviewCaptions);
          state.captions = captionsBefore;
          const autoCut = 0;
          state.lastAutoCutCount = autoCut;
          renderAll();
          const judged = result.judgeSummary || {};
          const leftover = (state.issues || []).filter((item) =>
            item.action === "cut" || item.confirmedCut === true,
          ).length;
          if (!quiet) {
            toast(
              judged.error
                ? `${label}失败：${judged.error}`
                : strict
                  ? `严格对照完成：自动剪掉 ${autoCut} 处重复阅读，${judged.keep || 0} 处识别误差已忽略，${leftover} 处仍待确认。对比日志在启动控制台`
                  : `自然流畅完成：保留 ${judged.keep || 0} 处近义/口语，自动剪掉 ${autoCut} 处重复阅读${leftover ? `，${leftover} 处仍待确认` : ""}。对比日志在启动控制台`,
            );
          }
          return { result, autoCut, plan: result.polishPlan };
        } catch (error) {
          toast(error.message);
          return null;
        } finally {
          if (button) button.textContent = label;
          updateAiReviewButton();
          $("modelProgress").style.display = "none";
        }
      }
      function selectIssue(id) {
        const issue = state.issues.find((x) => x.id === id);
        if (!issue) return;
        seekTimeline(Math.max(0, issue.start - 0.8));
        if (!state.playing) void togglePlay();
        const previewRequest = playRequestGeneration;
        setTimeout(
          () => {
            if (previewRequest !== playRequestGeneration) return;
            playRequestGeneration += 1;
            $("video").pause();
            state.playing = false;
            renderAll();
          },
          Math.max(1200, (issue.end - issue.start + 1.6) * 1000),
        );
      }
      function focusScriptDifference(id) {
        const issue = state.issues.find((item) => item.id === id);
        if (!issue) return;
        const review = state.reviewCaptions.find(
          (item) => (item.issueId || item.id) === id,
        );
        if (review) {
          state.selected = { type: "review", id: review.id };
          state.selectedItems = [{ type: "review", id: review.id }];
        }
        seekTimeline(Math.max(0, Number(review?.start ?? issue.start ?? 0) - 0.15));
        renderAll();
        toast(review ? "上方差异轨道只显示这一处正确文案，点击即可替换" : "已定位到这处差异");
      }
      function selectNextScriptDifference(afterTime = -1) {
        const sorted = [...state.issues].sort(
          (left, right) => Number(left.start || 0) - Number(right.start || 0),
        );
        if (!sorted.length) return false;
        const issue =
          sorted.find((item) => Number(item.start || 0) > afterTime + 0.01) ||
          sorted[0];
        const review = state.reviewCaptions.find(
          (item) => (item.issueId || item.id) === issue.id,
        );
        state.selected = review
          ? { type: "review", id: review.id }
          : { type: "caption", id: "" };
        state.selectedItems = review
          ? [{ type: "review", id: review.id }]
          : [];
        seekTimeline(Math.max(0, Number(issue.start || 0) - 0.15));
        return true;
      }
      function dismissReviewHints(ids) {
        const reviews = state.reviewCaptions.filter(r => ids.includes(r.id));
        if (!reviews.length || isTrackLocked('review')) return;
        snapshot();
        const issues = new Set(reviews.map(r => r.issueId || r.id));
        for (const caption of state.captions || []) for (const word of caption.words || []) {
          if (issues.has(word.issueId)) {
            word.reviewDismissed = true;
            word.issueId = ''; word.issueType = ''; word.action = '';
          }
        }
        state.reviewCaptions = state.reviewCaptions.filter(r => !ids.includes(r.id));
        const remaining = new Set(state.reviewCaptions.map(r => r.issueId || r.id));
        state.issues = state.issues.filter(r => !issues.has(r.id) || remaining.has(r.id));
        state.matchIssues = (state.matchIssues || []).filter(r => !issues.has(r.id) || remaining.has(r.id));
        state.selected = null; state.selectedItems = [];
        renderAll(); queueAutosave(); toast('已删除提示，字幕和音视频保留');
      }
      function matchRecognizedCapitalization(text, reference) {
        const letters = String(reference || '').match(/\p{L}/gu) || [];
        if (!letters.length) return text;
        // A lowercase replacement such as "he" does not establish that an
        // recognized proper name such as "Noah" should lose its capital.
        if (letters.every(c => c === c.toLowerCase())) return text;
        if (letters.length > 1 && letters.every(c => c === c.toUpperCase())) return text.toUpperCase();
        if (letters[0] === letters[0].toUpperCase()) {
          let first = true;
          return text.toLowerCase().replace(/\p{L}/gu, c => { if (!first) return c; first = false; return c.toUpperCase(); });
        }
        return text;
      }
      function planReviewCaptionReplacement(captions, review, text, useExpected = true) {
        const issueId = review.issueId || review.id;
        const entries = captions.filter(c => (!review.captionTrackId || (c.trackId || 'caption') === review.captionTrackId) &&
          (!review.ownerClipId || c.ownerClipId === review.ownerClipId) &&
          (!review.sourceMediaId || c.sourceMediaId === review.sourceMediaId)).flatMap(caption =>
          (caption.words || []).map((word, index) => ({caption, word, index})))
          .filter(e => Math.min(e.word.end, review.end) - Math.max(e.word.start, review.start) > .005);
        const hasWordScope = Array.isArray(review.words);
        const targets = hasWordScope ? review.words.filter(word =>
          Number.isFinite(Number(word?.start)) && Number.isFinite(Number(word?.end)) &&
          Number(word.end) > Number(word.start)) : [];
        if (hasWordScope && !targets.length) return null;
        const inExactWordScope = entry => !hasWordScope || targets.some(target =>
          (!target.issueId || target.issueId === issueId) &&
          Math.min(Number(target.end), Number(entry.word.end)) -
            Math.max(Number(target.start), Number(entry.word.start)) > .005);
        const scopedEntries = entries.filter(inExactWordScope);
        const linked = scopedEntries.filter(e => e.word.issueId === issueId);
        const selected = (linked.length ? linked : scopedEntries).filter(e => !e.word.userKept && e.word.matchType !== 'edited')
          .sort((a,b) => a.word.start-b.word.start);
        if (!selected.length) return null;
        // A split review retains the original issue's whole expectedText. Its
        // word references identify the manuscript belonging to this part.
        const partial = selected.length < entries.length || captions.some(c => (c.words || []).some(w => w.issueId === issueId &&
          (w.end <= review.start || w.start >= review.end)));
        const reference = selected.map(e => e.word.expectedDisplay || '').filter(Boolean);
        if (partial && useExpected && reference.length !== selected.length) return null;
        const tokens = editableCaptionTokens(partial && useExpected !== null ? (useExpected ? reference.join(' ') : selected.map(e => e.word.originalDisplay || e.word.display).join(' ')) : text);
        if (!tokens.length && useExpected !== null) return null;
        const first = selected[0].word, last = selected.at(-1).word;
        const start = Number(first.start), end = Number(last.end);
        const replacements = tokens.map((display,i) => {
          const anchor = selected[Math.min(selected.length-1, Math.floor(i*selected.length/tokens.length))];
          if (useExpected === false) display = matchRecognizedCapitalization(display,
            anchor.word.referenceExpected || anchor.word.expectedDisplay || editableCaptionTokens(review.expectedText || '')[i]);
          const timing = tokens.length === selected.length ? anchor.word : {
            start:start+(end-start)*i/tokens.length, end:start+(end-start)*(i+1)/tokens.length,
            ...(Number.isFinite(first.sourceStart) && Number.isFinite(last.sourceEnd) ? {
              sourceStart:first.sourceStart+(last.sourceEnd-first.sourceStart)*i/tokens.length,
              sourceEnd:first.sourceStart+(last.sourceEnd-first.sourceStart)*(i+1)/tokens.length,
            } : {}),
          };
          return {caption:anchor.caption,word:{...timing,display,expectedDisplay:display,
            referenceExpected:useExpected ? display : anchor.word.expectedDisplay || '',
            recognizedDisplay:anchor.word.originalDisplay || anchor.word.display,
            originalDisplay:anchor.word.originalDisplay || anchor.word.display,
            matchType:'edited',userKept:true,issueType:'',issueId:'',action:''}};
        });
        const removed = new Set(selected.map(e => e.word));
        return [...new Set(selected.map(e => e.caption))].map(caption => ({caption,
          words:[...caption.words.filter(w => !removed.has(w)),...replacements.filter(e => e.caption === caption).map(e => e.word)]
            .sort((a,b) => a.start-b.start)}));
      }
      function replaceReviewCaption(id, sourceMode = "expected", manualText = "", {record=true,quiet=false} = {}) {
        const linkedReview = state.reviewCaptions.find(r => r.id === id) ||
          state.reviewCaptions.find(r => r.issueId === id);
        const issueId = linkedReview?.issueId || id;
        const review = linkedReview || state.issues.find(r => r.id === issueId) || state.matchIssues?.find(r => r.id === issueId);
        if (!review) return;
        if (review.action === 'missing' || review.type === 'missing') {
          focusScriptDifference(issueId);
          toast('这段正确文案在音频中没有读出，需要补录或重新剪辑');return;
        }
        if (isTrackLocked(review.captionTrackId || 'caption') || isTrackLocked('review')) return toast('字幕或待处理轨道已锁定');
        const text = String(sourceMode === 'manual' ? manualText : sourceMode === 'spoken' ? review.spokenText || review.spoken || '' : review.expectedText || review.expected || '').trim();
        if (sourceMode !== 'manual' && (!text || /^[—-]$/.test(text))) return toast('没有可靠的对应文案，请核对后手动修改');
        const changes = planReviewCaptionReplacement(state.captions, review, text, sourceMode === 'manual' ? null : sourceMode !== 'spoken');
        if (!changes) return toast('对应字幕已修改或位置发生变化，请重新核对；已保留提示');
        const hasExistingText = state.captions.some(c => (c.words || []).length || String(c.text || '').trim());
        const changedByCaption = new Map(changes.map(change => [change.caption, change.words]));
        const hasRemainingText = state.captions.some(caption => {
          const words = changedByCaption.has(caption) ? changedByCaption.get(caption) : caption.words || [];
          const text = changedByCaption.has(caption) ? joinCaptionWords(words) : caption.text || '';
          return words.length > 0 || String(text).trim().length > 0;
        });
        if (hasExistingText && !hasRemainingText)
          return toast('此次修改会删除全部文案，已取消操作以保护字幕');
        if(record) snapshot();
        for (const {caption,words} of changes) {
          caption.words=words;caption.text=joinCaptionWords(words);
          if(words.length){caption.start=Math.min(...words.map(w=>Number(w.start)));caption.end=Math.max(...words.map(w=>Number(w.end)));
            if(words.every(w=>Number.isFinite(w.sourceStart)&&Number.isFinite(w.sourceEnd))){caption.sourceStart=Math.min(...words.map(w=>w.sourceStart));caption.sourceEnd=Math.max(...words.map(w=>w.sourceEnd));}}
        }
        const empty = new Set(changes.filter(c => !c.words.length).map(c => c.caption));
        state.captions = state.captions.filter(c => !empty.has(c));
        state.reviewCaptions = state.reviewCaptions.filter(r => r.id !== review.id);
        const unresolved = state.captions.some(c => c.words?.some(w => w.issueId === issueId && w.issueType));
        if (!unresolved) {
          state.issues = state.issues.filter(r => r.id !== issueId);
          state.matchIssues = (state.matchIssues || []).filter(r => r.id !== issueId);
        }
        const caption = changes.find(c => c.words.length)?.caption;
        if (caption) {state.selected={type:'caption',id:caption.id};state.selectedItems=[state.selected];}
        if(!quiet){renderAll();queueAutosave();}
        if(!quiet) toast(sourceMode === 'manual' ? '已同步修改字幕' : sourceMode === 'spoken' ? '已用识别文字替换' : '已替换为对应的正确文案');
        return true;
      }
      function batchReviewAction(ids, mode) {
        const selected=[...new Set(ids)].map(id=>state.reviewCaptions.find(r=>r.id===id)).filter(Boolean);
        if(!selected.length)return;
        if(isTrackLocked('review'))return toast('待处理轨道已锁定');
        if(mode==='deleteCaptions'){
          const deletion=planReviewCaptionDeletion(state.captions,selected,{
            lockedTracks:state.trackLocks||{},joinWords:words=>joinCaptionWords(words),
          });
          if(deletion.ambiguousCaptionIds.size)return toast('有字幕缺少逐词时间信息，无法只删对应文案；为避免误删，整次操作已取消');
          if(!deletion.removedWords.length&&!deletion.removedCaptionIds.size)return toast('没有可删除的对应字幕，或字幕轨道已锁定');
          const hasCaptions=state.captions.some(c=>(c.words||[]).length||String(c.text||'').trim());
          const hasRemainingCaptions=deletion.captions.some(c=>(c.words||[]).length||String(c.text||'').trim());
          if(hasCaptions&&!hasRemainingCaptions)return toast('此次删除会清空全部文案，已取消操作以保护字幕');
          snapshot();
          state.captions=deletion.captions;
          state.captionRecoveryArchive=(state.captionRecoveryArchive||[]).filter(record=>{
            const caption=record?.caption;
            if(deletion.removedCaptionIds.has(caption?.id))return false;
            if(record?.word)return !selected.some(review=>reviewCaptionWordMatches(review,caption,record.word));
            return !selected.some(review=>reviewCaptionBlockIsCovered(review,caption));
          });
          state.reviewCaptions=state.reviewCaptions.filter(r=>!deletion.removedReviewIds.has(r.id));
          const remainingIssueIds=new Set([
            ...state.reviewCaptions.map(r=>String(r.issueId||r.id||'')),
            ...state.captions.flatMap(c=>(c.words||[]).map(w=>String(w.issueId||''))),
          ]);
          for(const field of ['issues','matchIssues'])state[field]=(state[field]||[]).filter(r=>{
            const issueId=String(r.issueId||r.id||'');
            return !deletion.removedIssueIds.has(issueId)||remainingIssueIds.has(issueId);
          });
          const deletedCount=deletion.removedWords.length+
            [...deletion.removedCaptionIds].filter(id=>!deletion.removedWords.some(item=>item.captionId===id)).length;
          renderAll();queueAutosave();toast('已删除 '+deletedCount+' 个对应字幕词句；其他文案和音视频保留');return;
        }
        const eligible=selected.filter(r=>r.type!=='missing' && r.action!=='missing' && (mode!=='expected' || r.type==='mismatch') &&
          !isTrackLocked(r.captionTrackId||'caption') && String(mode==='spoken'?r.spokenText:r.expectedText||'').trim());
        if(!eligible.length)return toast('所选提示没有可采用的文案，或字幕轨道已锁定');
        let done=0;
        for(const review of eligible){
          const text=String(mode==='spoken'?review.spokenText:review.expectedText||'').trim();
          if(!planReviewCaptionReplacement(state.captions,review,text,mode!=='spoken'))continue;
          if(!done)snapshot();
          if(replaceReviewCaption(review.id,mode,'',{record:false,quiet:true}))done++;
        }
        if(done){renderAll();queueAutosave();}
        toast('已处理 '+done+' 个提示'+(done<selected.length?'，跳过 '+(selected.length-done)+' 个无对应文案、已修改或锁定的提示':''));
      }
      async function manuallyEditReviewCaption(id) {
        const review = state.reviewCaptions.find(item => item.id === id);
        if (!review) return;
        const text = await openRenameProjectDialog(review.spokenText || review.text || '', {
          title: '修改字幕',
          label: '字幕内容（清空可移除多出的字幕字符，不删除音频）',
          maxLength: 2000,
        });
        if (text !== null) replaceReviewCaption(id, 'manual', text);
      }
      function replaceReviewWithSpoken(id) {
        replaceReviewCaption(id, "spoken");
      }
      function cutReviewSegment(id) {
        const review = state.reviewCaptions.find(
          (item) => item.id === id || item.issueId === id,
        );
        if (!review) {
          if (state.issues.some((item) => item.id === id)) cutScriptIssue(id);
          return;
        }
        if (review.type === 'repeat') return deleteRepeatedReview(review.id);
        const issueId = review.issueId || review.id;
        if (state.issues.some((item) => item.id === issueId)) {
          // Aggregate issues can span several split review markers. Keep this
          // operation scoped to the marker the user actually clicked.
          cutScriptIssue(issueId, { scope: review });
          return;
        }
        const start = Math.max(0, Number(review.start || 0));
        let end = Math.min(
          state.duration,
          Math.max(start + 0.04, Number(review.end || 0)),
        );
        const nextKept = (state.captions || [])
          .map((item) => Number(item.start || 0))
          .filter((time) => time > start + 0.02)
          .sort((left, right) => left - right)[0];
        if (Number.isFinite(nextKept)) {
          end = Math.min(end, Math.max(start + 0.04, nextKept - 0.05));
        }
        const sourceStart = timelineToSource(start);
        const sourceEnd = timelineToSource(end);
        if (sourceEnd <= sourceStart + 0.002) {
          toast("这一处没有可剪掉的音频范围");
          return;
        }
        const captionRemoval = planIssueWordsRemoval(issueId, start, end, review);
        if (captionRemoval.blocked) {
          toast(issueCaptionRemovalMessage(captionRemoval.reason));
          return;
        }
        snapshot();
        removeIssueWords(issueId, start, end, review, captionRemoval);
        state.removals.push({
          start: sourceStart,
          end: sourceEnd,
          source: `script-${review.type || "difference"}`,
        });
        shiftTracks(start, end - start);
        state.reviewCaptions = state.reviewCaptions.filter((item) => item.id !== id);
        state.issues = state.issues.filter((item) => item.id !== issueId);
        state.matchIssues = (state.matchIssues || []).filter((item) => item.id !== issueId);
        normalizeRemovals();
        recomputeContentDuration();
        clampTracksToDuration();
        state.selected = { type: "video", id: "main" };
        state.selectedItems = [];
        seekTimeline(Math.max(0, start));
        renderAll();
        toast("已同步剪掉红色词句、视频和音频");
        queueAutosave();
      }
      function clearIssueWordFlags(issueId) {
        let cleared = 0;
        for (const caption of state.captions || []) {
          for (const word of caption.words || []) {
            if (word.issueId !== issueId) continue;
            word.action = "";
            word.issueType = "";
            word.issueId = "";
            if (word.matchType === "error") word.matchType = "match";
            word.userKept = true;
            cleared += 1;
          }
        }
        return cleared;
      }
      function dismissReviewMark(review) {
        const issueId = review.issueId || review.id;
        state.reviewCaptions = state.reviewCaptions.filter((item) => item.id !== review.id);
        state.issues = state.issues.filter((item) => item.id !== issueId);
        state.matchIssues = (state.matchIssues || []).filter((item) => item.id !== issueId);
      }
      function keepSpokenReviewInCaptions(review) {
        const start = Number(review.start || 0),
          end = Math.max(start + 0.04, Number(review.end || start + 0.04));
        if (review.alreadyDisplayed) {
          const tokens=editableCaptionTokens(String(review.spokenText || review.text || ''));
          const existing=(state.captions || []).flatMap(c=>(c.words || []).filter(w=>
            (!review.captionTrackId || c.trackId===review.captionTrackId) && w.start<end && w.end>start));
          if (tokens.length && tokens.every(token=>existing.some(w=>!captionTextDiffers(w.display,token)))) {
            for (const word of existing) if (tokens.some(token=>!captionTextDiffers(word.display,token))) {
              word.userKept=true;word.issueType='';word.issueId='';word.action='';
            }
            return end;
          }
        }
        if (review.pendingCaption || (review.type === "addition" && review.words?.length)) {
          const tokens = editableCaptionTokens(String(review.spokenText || review.text || ""));
          const words = (review.words?.length ? review.words : tokens.map((display,index)=>({
            display,start:start+(end-start)*index/tokens.length,end:start+(end-start)*(index+1)/tokens.length,
          }))).map(word=>({...word,matchType:"match",issueType:"",issueId:"",action:"",userKept:true}));
          if (!words.length) return end;
          words[0].reviewGapBefore=true;
          words.at(-1).reviewGapAfter=true;
          state.captions.push({id:uid(),start,end,text:joinCaptionWords(words),words,
            ownerClipId:review.ownerClipId,ownerClipType:review.ownerClipType,sourceMediaId:review.sourceMediaId,sourceStart:review.sourceStart,sourceEnd:review.sourceEnd,
            trackId:review.captionTrackId || "caption",transcriptId:review.transcriptId || ""});
          state.captions.sort((a,b)=>a.start-b.start);
          return end;
        }
        const captions = [...state.captions].sort((a, b) => a.start - b.start),
          overlapping = captions.filter(
            (caption) => Math.min(Number(caption.end), end) - Math.max(Number(caption.start), start) > -0.08,
          ),
          previous = [...captions].reverse().find((caption) => Number(caption.end) <= start + 0.08),
          next = captions.find((caption) => Number(caption.start) >= end - 0.08),
          target = overlapping[0] ||
            (previous && next
              ? start - Number(previous.end) <= Number(next.start) - end
                ? previous
                : next
              : previous || next);
        const tokens = editableCaptionTokens(String(review.spokenText || review.text || ""));
        const inserted = tokens.map((display, index) => ({
          display,
          start: start + ((end - start) * index) / Math.max(1, tokens.length),
          end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
          matchType: "match",
          issueType: "",
          expectedDisplay: display,
          userInserted: true,
        }));
        if (!inserted.length) return end;
        if (target) {
          target.start = Math.min(Number(target.start), start);
          target.end = Math.max(Number(target.end), end);
          target.words ||= [];
          const insertAt = target.words.findIndex(
            (word) => Number(word.start || 0) >= end - 0.01,
          );
          target.words.splice(insertAt < 0 ? target.words.length : insertAt, 0, ...inserted);
          target.words.sort((left, right) => Number(left.start) - Number(right.start));
          target.text = joinCaptionWords(target.words);
        } else {
          state.captions.push({
            id: uid(), start, end, text: joinCaptionWords(inserted),
            words: inserted, trackId: "caption",
          });
          state.captions.sort((left, right) => left.start - right.start);
        }
        return end;
      }
      function acceptReviewSegment(id) {
        const review = state.reviewCaptions.find(
          (item) => item.id === id || item.issueId === id,
        );
        const issue = state.issues.find((item) => item.id === id || item.id === review?.issueId);
        if (!review && !issue) return;
        if (isTrackLocked(review?.captionTrackId || "caption") || isTrackLocked("review")) return toast("字幕或待处理轨道已锁定");
        if (review && (review.type === "missing" || review.action === "missing")) {
          focusScriptDifference(review.issueId || review.id);
          toast("漏读不能直接接收，需要补录或自行决定是否保留");
          return;
        }
        snapshot();
        const stayTime = Number(state.currentTime || (review || issue).start || 0);
        const issueId = review?.issueId || review?.id || id;
        const cleared = clearIssueWordFlags(issueId);
        if (review && (review.pendingCaption || !cleared)) keepSpokenReviewInCaptions(review);
        if (review) dismissReviewMark(review);
        else {
          state.issues = state.issues.filter((item) => item.id !== issueId);
          state.reviewCaptions = state.reviewCaptions.filter(
            (item) => (item.issueId || item.id) !== issueId,
          );
        }
        state.selected = { type: "video", id: "main" };
        state.selectedItems = [];
        seekTimeline(Math.max(0, stayTime));
        renderAll();
        queueAutosave();
        toast("已接收这段内容，视频和音频都保留");
      }
      function keepSoloReviewSegment(id) {
        const review = state.reviewCaptions.find(
          (item) => item.id === id || item.issueId === id,
        );
        const issue = state.issues.find((item) => item.id === id || item.id === review?.issueId);
        if (!review && !issue) return;
        if (review && (review.type === "missing" || review.action === "missing")) {
          focusScriptDifference(review.issueId || review.id);
          toast("漏读不能直接接收，需要补录或自行决定是否保留");
          return;
        }
        snapshot();
        const stayTime = Number(state.currentTime || (review || issue).start || 0);
        const issueId = review?.issueId || review?.id || id;
        const source = review || issue;
        const start = Number(source.start || 0);
        const end = Math.max(start + 0.04, Number(source.end || start + 0.04));
        // Prefer manuscript expectedText when available, fall back to spoken ASR text
        const expectedText = String(source.expectedText || source.expected || "").trim();
        const spokenText = String(source.spokenText || source.spoken || source.text || "").trim();
        const displayText = expectedText || spokenText;
        if (!displayText) {
          toast("无可保留的文本内容");
          return;
        }
        const tokens = editableCaptionTokens(displayText);
        if (!tokens.length) {
          toast("无可保留的文本内容");
          return;
        }
        // Build word objects with evenly distributed timestamps
        const allWords = tokens.map((display, index) => ({
          display,
          start: start + ((end - start) * index) / Math.max(1, tokens.length),
          end: start + ((end - start) * (index + 1)) / Math.max(1, tokens.length),
          matchType: "match",
          issueType: "",
          expectedDisplay: display,
          userInserted: true,
          userKeptSolo: true,
        }));
        // Split into multiple captions using buildCaptions-like logic
        const maxWords = 7;
        const maxChars = 28 * captionWrapLineLimit(state.captionLines);
        const SENTENCE_END = /[.!?。！？]["'\u201d\u2019)]*$/u;
        const CLAUSE_END = /[,;:—–\-，、；：]["'\u201d\u2019)]*$/u;
        const captions = [];
        let group = [];
        const flushGroup = () => {
          if (!group.length) return;
          captions.push({
            id: uid(), start: group[0].start, end: group.at(-1).end,
            text: joinCaptionWords(group), words: [...group], trackId: "caption",
          });
          group = [];
        };
        for (const word of allWords) {
          const priorWord = group.at(-1);
          const timingGap = priorWord ? Number(word.start) - Number(priorWord.end) : 0;
          const priorEnds = priorWord && SENTENCE_END.test(priorWord.display);
          const priorClauseEnds = priorWord && CLAUSE_END.test(priorWord.display);
          const candidate = [...group, word].map(w => w.display).join(" ");
          if (
            group.length &&
            (timingGap > 0.3 ||
              group.length >= maxWords ||
              candidate.length > maxChars ||
              priorEnds ||
              (priorClauseEnds && group.length >= 3 && timingGap >= 0.25))
          ) flushGroup();
          group.push(word);
        }
        flushGroup();
        // Clear issue word flags + dismiss
        clearIssueWordFlags(issueId);
        if (review) dismissReviewMark(review);
        else {
          state.issues = state.issues.filter((item) => item.id !== issueId);
          state.reviewCaptions = state.reviewCaptions.filter(
            (item) => (item.issueId || item.id) !== issueId,
          );
        }
        // Push solo captions into state
        state.captions.push(...captions);
        state.captions.sort((a, b) => Number(a.start) - Number(b.start));
        state.selected = { type: "video", id: "main" };
        state.selectedItems = [];
        seekTimeline(Math.max(0, stayTime));
        renderAll();
        toast(`已保留为 ${captions.length} 条独立字幕`);
      }
      function applyRedReviewGesture(e, id) {
        if (e.altKey && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
          if (isTrackLocked("review")) {
            toast("待处理片段轨道已锁定");
            return true;
          }
          replaceReviewWithSpoken(id);
          return true;
        }
        if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
          if (isTrackLocked("review")) {
            toast("待处理片段轨道已锁定");
            return true;
          }
          cutReviewSegment(id);
          return true;
        }
        if (e.ctrlKey || e.metaKey) {
          if (isTrackLocked("review")) {
            toast("待处理片段轨道已锁定");
            return true;
          }
          acceptReviewSegment(id);
          return true;
        }
        return false;
      }
      function previewReviewSegment(id) {
        const review = state.reviewCaptions.find(
          (item) => item.id === id || item.issueId === id,
        );
        selectIssue(review?.issueId || id);
        renderTimeline();
      }
      var reviewAuditionGeneration = 0;
      async function auditionReviewSegment(id) {
        const review = state.reviewCaptions.find(r => r.id === id || r.issueId === id);
        if (!review) return;
        const audition = ++reviewAuditionGeneration;
        const start = Math.max(0, Number(review.start || 0));
        const end = Math.min(state.duration, Number(review.end || start));
        if (!(end > start)) return toast('这处提示没有可试听的音频');
        if (state.playing) await togglePlay();
        if (audition !== reviewAuditionGeneration) return;
        state.cutPreviewRange = null;
        seekTimeline(start);
        const expectedRequest = playRequestGeneration + 1;
        await togglePlay();
        if (audition !== reviewAuditionGeneration || expectedRequest !== playRequestGeneration || !state.playing) return;
        const finish = () => {
          if (audition !== reviewAuditionGeneration || expectedRequest !== playRequestGeneration || !state.playing) return;
          if (state.currentTime >= end) { void togglePlay(); return; }
          requestAnimationFrame(finish);
        };
        requestAnimationFrame(finish);
      }
      function repeatCutPreservesCaptionText(start,end) {
        const captions = state.captions || [];
        const hasText = captions.some(caption =>
          (caption.words || []).length || String(caption.text || '').trim());
        if (!hasText) return true;
        const margin = .005;
        return captions.some(caption => {
          const words = caption.words || [];
          if (words.length) return words.some(word => {
            const wordStart = Number(word.start), wordEnd = Number(word.end);
            return Number.isFinite(wordStart) && Number.isFinite(wordEnd) &&
              (wordEnd <= start + margin || wordStart >= end - margin);
          });
          const captionStart = Number(caption.start), captionEnd = Number(caption.end);
          return Number.isFinite(captionStart) && Number.isFinite(captionEnd) &&
            (captionEnd <= start + margin || captionStart >= end - margin);
        });
      }
      function captionTextKey(caption,text,start,end,word=null) {
        const track = caption.trackId || 'caption';
        const sourceMediaId = caption.sourceMediaId || '';
        const sourceStart = Number(word ? word.sourceStart : caption.sourceStart);
        const sourceEnd = Number(word ? word.sourceEnd : caption.sourceEnd);
        const hasSourceRange = Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart;
        const position = hasSourceRange
          ? `source:${sourceStart.toFixed(5)}:${sourceEnd.toFixed(5)}`
          : `timeline:${Number(start).toFixed(5)}:${Number(end).toFixed(5)}`;
        return `${track}|${sourceMediaId}|${String(text || '').trim()}|${position}`;
      }
      function addCaptionWordCount(counts,key) {
        if (!key) return;
        counts.set(key,(counts.get(key)||0)+1);
      }
      function preservedCaptionWordCounts(start,end) {
        const counts = new Map(), length = end - start, margin = .005;
        for (const caption of state.captions || []) {
          const track = caption.trackId || 'caption';
          const shouldShift = !state.trackLocks?.[track] && state.trackSyncLocks?.[track] !== false;
          const words = caption.words || [];
          if (words.length) {
            for (const word of words) {
              const wordStart = Number(word.start), wordEnd = Number(word.end);
              if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd)) continue;
              const before = wordEnd <= start + margin, after = wordStart >= end - margin;
              if (!before && !after) continue;
              const shift = after && shouldShift ? length : 0;
              addCaptionWordCount(counts,captionTextKey(caption,word.display || word.text,
                wordStart-shift,wordEnd-shift,word));
            }
          } else {
            const captionStart = Number(caption.start), captionEnd = Number(caption.end);
            if (!Number.isFinite(captionStart) || !Number.isFinite(captionEnd)) continue;
            const before = captionEnd <= start + margin, after = captionStart >= end - margin;
            if (!before && !after) continue;
            const shift = after && shouldShift ? length : 0;
            addCaptionWordCount(counts,captionTextKey(caption,caption.text,
              captionStart-shift,captionEnd-shift));
          }
        }
        return counts;
      }
      function captionWordsRemain(required) {
        const counts = new Map();
        for (const caption of state.captions || []) {
          const words = caption.words || [];
          if (words.length) {
            for (const word of words) addCaptionWordCount(counts,captionTextKey(caption,
              word.display || word.text,word.start,word.end,word));
          } else if (String(caption.text || '').trim()) {
            addCaptionWordCount(counts,captionTextKey(caption,caption.text,caption.start,caption.end));
          }
        }
        return [...required].every(([key,count]) => (counts.get(key)||0) >= count);
      }
      function captionsAfterRepeatCut(captions,start,end) {
        const length=end-start, margin=.005;
        const shiftTrack=track=>!state.trackLocks?.[track] && state.trackSyncLocks?.[track]!==false;
        const shiftItem=(item,track)=>{
          if(!shiftTrack(track))return item;
          const itemStart=Number(item.start),itemEnd=Number(item.end);
          if(!Number.isFinite(itemStart)||!Number.isFinite(itemEnd))return item;
          if(itemEnd<=start+margin)return item;
          if(itemStart>=end-margin){item.start=Math.max(0,itemStart-length);item.end=Math.max(item.start+.04,itemEnd-length);return item;}
          if(itemStart>=start-margin&&itemEnd<=end+margin)return null;
          if(itemStart<start&&itemEnd>end){item.end=Math.max(itemStart+.04,itemEnd-length);return item;}
          if(itemStart<start){item.end=Math.max(itemStart+.04,start);return item;}
          item.start=start;item.end=Math.max(start+.04,itemEnd-length);return item;
        };
        return (captions||[]).filter(Boolean).flatMap(original=>{
          const caption=JSON.parse(JSON.stringify(original));
          const track=caption.trackId||'caption';
          if(!shiftTrack(track))return [caption];
          if(!Array.isArray(caption.words)||!caption.words.length){
            const shifted=shiftItem(caption,track);return shifted?[shifted]:[];
          }
          const words=[];
          for(const originalWord of caption.words){
            const word={...originalWord},wordStart=Number(word.start),wordEnd=Number(word.end);
            if(!Number.isFinite(wordStart)||!Number.isFinite(wordEnd)){words.push(word);continue;}
            const center=(wordStart+wordEnd)/2;
            if(center>=start&&center<end)continue;
            if(wordEnd<=start+margin)words.push(word);
            else if(wordStart>=end-margin){word.start=Math.max(0,wordStart-length);word.end=Math.max(word.start+.01,wordEnd-length);words.push(word);}
            else if(wordStart<start&&wordEnd>end){word.end=Math.max(wordStart+.01,wordEnd-length);words.push(word);}
            else if(wordStart<start){word.end=Math.max(wordStart+.01,start);words.push(word);}
            else{word.start=start;word.end=Math.max(start+.01,wordEnd-length);words.push(word);}
          }
          if(!words.length)return [];
          words.sort((a,b)=>Number(a.start)-Number(b.start));
          caption.words=words;caption.start=Number(words[0].start);
          caption.end=Math.max(caption.start+.04,Number(words.at(-1).end));
          caption.text=joinCaptionWords(words);
          return [caption];
        });
      }
      function captionArchiveAfterRepeatCut(records,start,end) {
        const length=end-start, margin=.005;
        const shiftTrack=track=>!state.trackLocks?.[track] && state.trackSyncLocks?.[track]!==false;
        return (records||[]).filter(Boolean).flatMap(original=>{
          const record=JSON.parse(JSON.stringify(original));
          const caption=record.caption||{},track=caption.trackId||'caption';
          if(!shiftTrack(track))return [record];
          const item=record.word||caption;
          const itemStart=Number(item.start),itemEnd=Number(item.end);
          if(!Number.isFinite(itemStart)||!Number.isFinite(itemEnd))return [record];
          if(itemEnd<=start+margin)return [record];
          if(itemStart>=end-margin){item.start=Math.max(0,itemStart-length);item.end=Math.max(item.start+.01,itemEnd-length);return [record];}
          if(itemStart>=start-margin&&itemEnd<=end+margin)return [];
          if(itemStart<start&&itemEnd>end){item.end=Math.max(itemStart+.01,itemEnd-length);return [record];}
          if(itemStart<start){item.end=Math.max(itemStart+.01,start);return [record];}
          item.start=start;item.end=Math.max(start+.01,itemEnd-length);return [record];
        });
      }
      function deleteRepeatedReview(id) {
        const review = state.reviewCaptions.find(r => r.id === id || r.issueId === id);
        if (!review || review.type !== 'repeat') return;
        const frame = frameDuration();
        const start = Math.floor((Math.max(0, Number(review.start)) + 1e-7) / frame) * frame;
        const end = Math.min(state.duration, Math.ceil((Number(review.end) - 1e-7) / frame) * frame);
        if (end <= start + .001) return;
        if (!repeatCutPreservesCaptionText(start,end)) return toast('疑似重复范围覆盖了全部文案，已取消删除以保护工程');
        const originalCaptions=JSON.parse(JSON.stringify(state.captions||[]));
        const originalCaptionArchive=JSON.parse(JSON.stringify(state.captionRecoveryArchive||[]));
        const preservedCaptionWords=preservedCaptionWordCounts(start,end);
        const media = editMediaItems().filter(entry => entry.obj.start <= start + .002 && entry.obj.end >= end - .002);
        let owners = review.ownerClipId ? media.filter(entry => entry.obj.id === review.ownerClipId && (review.ownerClipType ? entry.type === review.ownerClipType : ['video','videolayer'].includes(entry.type))) : [];
        if (!owners.length && !review.ownerClipId) {
          owners = media.filter(entry => (!review.sourceMediaId || (entry.obj.sourceMediaId || entry.obj.path) === review.sourceMediaId) &&
            ['video','videolayer'].includes(entry.type));
          if (!owners.length) owners = media.filter(entry => ['audio','audioasset'].includes(entry.type) &&
            (!review.sourceMediaId || (entry.obj.sourceMediaId || entry.obj.path) === review.sourceMediaId));
        }
        if (owners.length !== 1) return toast('无法唯一定位重复片段，请先核对所属素材');
        let anchor = {type:owners[0].type,id:owners[0].obj.id};
        const partners = linkedTimelineObjects(anchor.type, anchor.id);
        if ([anchor,...partners].some(item => selectionIsLocked(item.type,item.id)) ||
            isTrackLocked('review') || isTrackLocked(review.captionTrackId || 'caption') ||
            state.avLinked && ['video','audio'].includes(anchor.type) && (isTrackLocked('video') || isTrackLocked('audio'))) return toast('相关轨道已锁定，请先解锁');
        const historyBefore = JSON.stringify(projectData(true));
        snapshot();
        state.timelineRange = null;
        state.selected = anchor; state.selectedItems = [anchor];
        if (['video','audio'].includes(anchor.type)) {
          const materialized = materializeMainSegment(anchor.type,anchor.id);
          if (!materialized) {
            if (state.undo.at(-1) === historyBefore) state.undo.pop();
            applyHistoryState(JSON.parse(historyBefore));
            renderAll();
            return toast('无法安全定位重复片段，已取消删除');
          }
          anchor = materialized;
        }
        review.ownerClipId = anchor.id;
        const targets = () => [{...anchor},...linkedTimelineObjects(anchor.type,anchor.id)];
        const rollback = message => {
          if (state.undo.at(-1) === historyBefore) state.undo.pop();
          applyHistoryState(JSON.parse(historyBefore));
          renderAll();
          toast(message);
        };
        const tolerance = Math.max(.002,frame*.51);
        splitClipsAt(start, targets(), {record:false,quiet:true});
        // Bound reviews follow the right-hand piece when the first split moves it.
        anchor = {type:anchor.type,id:review.ownerClipId};
        const startPiece = timelineObjectFor(anchor.type,anchor.id);
        if (!startPiece || Number(startPiece.start) > start + tolerance || Number(startPiece.end) < end - tolerance) {
          rollback('无法准确切出重复范围，已取消删除以保护其他文案');
          return;
        }
        splitClipsAt(end, targets(), {record:false,quiet:true});
        const exactPiece = timelineObjectFor(anchor.type,anchor.id);
        if (!exactPiece || Math.abs(Number(exactPiece.start) - start) > tolerance ||
            Math.abs(Number(exactPiece.end) - end) > tolerance) {
          rollback('重复范围没有被准确切开，已取消删除以保护其他文案');
          return;
        }
        state.selected = anchor; state.selectedItems = targets();
        deleteSelected(true, {record:false});
        // Rebuild visible captions from the pre-edit snapshot. Generic ripple
        // deletion can remap a whole source-backed caption group through an
        // owner clip that was just removed, dropping unrelated words as well.
        state.captions=captionsAfterRepeatCut(originalCaptions,start,end);
        state.captionRecoveryArchive=captionArchiveAfterRepeatCut(originalCaptionArchive,start,end);
        if (!captionWordsRemain(preservedCaptionWords)) {
          rollback('检测到非重复文案可能受影响，删除已撤销');
          return;
        }
        const liveMedia=editMediaItems();
        for(const caption of state.captions){
          if(!caption.ownerClipId)continue;
          const captionStart=Number(caption.start),captionEnd=Number(caption.end);
          const sourceId=caption.sourceMediaId||'';
          const matches=liveMedia.filter(entry=>{
            const item=entry.obj,itemSource=item.sourceMediaId||item.path||'';
            return Number(item.start)<=captionStart+.02&&Number(item.end)>=captionEnd-.02&&
              (!sourceId||!itemSource||sourceId===itemSource);
          });
          const owner=matches.find(entry=>entry.obj.id===caption.ownerClipId)||matches[0];
          if(owner){caption.ownerClipId=owner.obj.id;caption.ownerClipType=owner.type;continue;}
          caption.ownerClipId='';caption.ownerClipType='';
          delete caption.sourceStart;delete caption.sourceEnd;
          for(const word of caption.words||[]){delete word.sourceStart;delete word.sourceEnd;}
        }
        recomputeContentDuration();
        renderAll();
        queueAutosave();
        toast('已删除重复片段及对应字幕、音视频');
      }
      function insertReviewSegment(id) {
        const existingReview=state.reviewCaptions.find(x=>x.id===id);
        if(existingReview?.alreadyDisplayed){acceptReviewSegment(existingReview.id);return;}
        const review = state.reviewCaptions.find((item) => item.id === id);
        if (!review || !["accept", "insert"].includes(review.action)) return;
        snapshot();
        const stayTime = Number(state.currentTime || review.start || 0);
        keepSpokenReviewInCaptions(review);
        dismissReviewMark(review);
        seekTimeline(Math.max(0, stayTime));
        renderAll();
        toast("已把这段口语补充插入正确字幕");
      }
      function planIssueWordsRemoval(issueId, start, end, scope = {}) {
        const issue = { ...scope, id: scope.id || issueId,
          issueId: scope.issueId || issueId, start, end };
        return planIssueCaptionRemoval(state.captions || [], issue, {
          lockedTracks: state.trackLocks || {},
          joinWords: words => joinCaptionWords(words),
        });
      }
      function issueCaptionRemovalMessage(reason) {
        if (reason === 'would-remove-all-text') return '此次切除会删除全部文案，已取消操作以保护字幕';
        if (reason === 'ambiguous-scope') return '错误文案跨多个轨道或素材，无法唯一定位；已取消切除以保护字幕';
        return '找不到精确对应的错误字幕，已取消切除以保护字幕';
      }
      function removeIssueWords(issueId, start, end, scope = {}, prepared = null) {
        const plan = prepared || planIssueWordsRemoval(issueId, start, end, scope);
        if (plan.blocked) return false;
        const deletion = plan.deletion;
        state.captions = deletion.captions;
        state.captionRecoveryArchive = (state.captionRecoveryArchive || []).filter(record => {
          const caption = record?.caption;
          if (deletion.removedCaptionIds.has(caption?.id)) return false;
          if (record?.word) return !caption || !reviewCaptionWordMatches(plan.review, caption, record.word);
          return !caption || !reviewCaptionBlockIsCovered(plan.review, caption);
        });
        return true;
      }
      function dismissTrimmedIssues(start, end, ownerIds = null) {
        const cutStart = Number(start || 0), cutEnd = Number(end || 0);
        if (cutEnd <= cutStart + 0.001) return [];
        const overlapsCut = (item) => {
          if (ownerIds && item?.ownerClipId && !ownerIds.has(item.ownerClipId)) return false;
          if (ownerIds && !item?.ownerClipId) {
            const linked = (state.reviewCaptions || []).filter(r => (r.issueId || r.id) === (item.issueId || item.id));
            if (linked.length && !linked.some(r => !r.ownerClipId || ownerIds.has(r.ownerClipId))) return false;
          }
          const itemStart = Number(item?.start || 0);
          const itemEnd = Number(item?.end || itemStart + 0.04);
          return Math.min(itemEnd, cutEnd) - Math.max(itemStart, cutStart) > 0.005;
        };
        const removedIds = new Set();
        const clean=value=>String(value||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
        // Cutting either immediately adjacent copy resolves the repeat relation.
        for(const review of state.reviewCaptions || []) {
          if(review.type!=='repeat' || overlapsCut(review))continue;
          // Whole-take warnings are independent ranges. Removing one of three
          // copies must not dismiss the neighboring copy's review decision.
          if(review.segmentedRepeat || Number.isFinite(review.retainedStart))continue;
          const phrase=clean(review.spokenText);if(!phrase)continue;
          const matches=(state.captions||[]).filter(c=>!review.sourceMediaId || !c.sourceMediaId || c.sourceMediaId===review.sourceMediaId).flatMap(c=>(c.words||[]).map(word=>({word,caption:c}))).filter(e=>e.word.start<cutEnd && e.word.end>cutStart && (!ownerIds || !e.caption.ownerClipId || ownerIds.has(e.caption.ownerClipId)));
          const deleted=matches.sort((a,b)=>a.word.start-b.word.start).map(e=>clean(e.word.display)).join(' ');
          if((deleted===phrase || deleted.endsWith(' '+phrase) || deleted.startsWith(phrase+' ')) && (Math.abs(review.start-cutEnd)<.4 || Math.abs(cutStart-review.end)<.4))removedIds.add(review.issueId||review.id);
        }
        for (const item of [...(state.issues || []), ...(state.matchIssues || []), ...(state.reviewCaptions || [])]) {
          if (!overlapsCut(item)) continue;
          if (item.issueId || item.id) removedIds.add(item.issueId || item.id);
          if (item.id) removedIds.add(item.id);
        }
        if (!removedIds.size) return [];
        const keep = (item) => !removedIds.has(item.id) && !removedIds.has(item.issueId);
        state.issues = (state.issues || []).filter(keep);
        state.matchIssues = (state.matchIssues || []).filter(keep);
        state.reviewCaptions = (state.reviewCaptions || []).filter(keep);
        const archived = (state.captionRecoveryArchive || []).flatMap(record =>
          [record.caption, record.word && { words: [record.word] }]).filter(Boolean);
        for (const caption of [...(state.captions || []), ...archived]) {
          for (const word of caption.words || []) {
            if (!removedIds.has(word.issueId)) continue;
            word.issueId = "";
            word.issueType = "";
            word.action = "";
            word.reviewDismissed = true;
            if (word.matchType === "error") word.matchType = "match";
          }
        }
        return [...removedIds];
      }
      function rippleSubtitleTimeline(start, end) {
        const length = Math.max(0, end - start);
        if (length <= 0.001) return;
        // A manual cut is the user's final decision. Drop every linked review
        // marker before shifting the surviving timeline so stale errors cannot
        // be reported again after an erroneous/repeated take was removed.
        dismissTrimmedIssues(start, end);
        const shiftTimedItem = (item) => {
          if(state.trackLocks[item.trackId||"caption"] || state.trackSyncLocks[item.trackId||"caption"]===false)return item;
          const itemStart = Number(item.start || 0), itemEnd = Number(item.end || itemStart + .04);
          if (itemEnd <= start) return item;
          if (itemStart >= end) {
            item.start = Math.max(0, itemStart - length);
            item.end = Math.max(item.start + .04, itemEnd - length);
            return item;
          }
          if (itemStart >= start && itemEnd <= end) return null;
          if (itemStart < start && itemEnd > end) {
            item.end = Math.max(itemStart + .04, itemEnd - length);
            return item;
          }
          if (itemStart < start) {
            item.end = Math.max(itemStart + .04, start);
            return item;
          }
          item.start = start;
          item.end = Math.max(start + .04, itemEnd - length);
          return item;
        };
        state.captions = state.captions.map((caption) => {
          if (state.trackLocks?.[caption.trackId || "caption"] ||
              state.trackSyncLocks?.[caption.trackId || "caption"] === false)
            return caption;
          if (!Array.isArray(caption.words) || !caption.words.length)
            return shiftTimedItem(caption);
          const words = [];
          for (const original of caption.words) {
            const word = { ...original }, wordStart = Number(word.start || 0),
              wordEnd = Number(word.end || wordStart + .01), center = (wordStart + wordEnd) / 2;
            if (center >= start && center < end) continue;
            if (wordEnd <= start) words.push(word);
            else if (wordStart >= end) {
              word.start = Math.max(0, wordStart - length);
              word.end = Math.max(word.start + .01, wordEnd - length);
              words.push(word);
            } else if (wordStart < start && wordEnd > end) {
              word.end = Math.max(wordStart + .01, wordEnd - length);
              words.push(word);
            } else if (wordStart < start) {
              word.end = Math.max(wordStart + .01, start);
              words.push(word);
            } else {
              word.start = start;
              word.end = Math.max(start + .01, wordEnd - length);
              words.push(word);
            }
          }
          if (!words.length) return null;
          caption.words = words;
          caption.start = Number(words[0].start || 0);
          caption.end = Math.max(caption.start + .04, Number(words.at(-1).end || caption.start + .04));
          caption.text = words.map((word) => word.display).join(" ")
            .replace(/\s+([.,!?;:])/g, "$1");
          return caption;
        }).filter(Boolean);
        state.reviewCaptions = state.reviewCaptions.map(shiftTimedItem).filter(Boolean);
        state.issues = state.issues.map(shiftTimedItem).filter(Boolean);
        captionInspectorKey = "";
      }
      function trimSubtitleTimeline(start, end) {
        const cutStart = Number(start || 0), cutEnd = Number(end || 0);
        if (cutEnd <= cutStart + 0.001) return;
        dismissTrimmedIssues(cutStart, cutEnd);
        state.captions = (state.captions || []).flatMap((caption) => {
          if (state.trackLocks?.[caption.trackId || "caption"] ||
              state.trackSyncLocks?.[caption.trackId || "caption"] === false)
            return [caption];
          const captionStart = Number(caption.start || 0);
          const captionEnd = Number(caption.end || captionStart + 0.04);
          if (captionEnd <= cutStart + 0.001 || captionStart >= cutEnd - 0.001)
            return [caption];
          if (Array.isArray(caption.words) && caption.words.length) {
            const leftWords = caption.words.filter((word) => {
              const wordStart = Number(word.start || 0), wordEnd = Number(word.end || wordStart + 0.01);
              return (wordStart + wordEnd) / 2 < cutStart;
            });
            const rightWords = caption.words.filter((word) => {
              const wordStart = Number(word.start || 0), wordEnd = Number(word.end || wordStart + 0.01);
              return (wordStart + wordEnd) / 2 >= cutEnd;
            });
            return [leftWords, rightWords].filter((words) => words.length).map((words, index) => ({
              ...caption,
              id: index && leftWords.length ? uid() : caption.id,
              words,
              start: Number(words[0].start || captionStart),
              end: Math.max(Number(words[0].start || captionStart) + 0.04, Number(words.at(-1).end || captionEnd)),
              text: words.map((word) => word.display || word.text || "").join(" ")
                .replace(/\s+([.,!?;:])/g, "$1").trim(),
            }));
          }
          if (captionStart >= cutStart - 0.001 && captionEnd <= cutEnd + 0.001) return [];
          if (captionStart < cutStart) caption.end = cutStart;
          else caption.start = cutEnd;
          return caption.end > caption.start + 0.01 ? [caption] : [];
        });
        captionInspectorKey = "";
      }
      function applyConfirmedRepeatCuts() {
        const ids = (state.issues || [])
          .filter(
            (issue) =>
              (issue.type === "repeat" || issue.confirmedCut === true || issue.action === "cut") &&
              issue.confirmedCut === true &&
              issue.suppressReview !== true &&
              issue.action !== "keep" &&
              !issue.scripture &&
              !issue.confirmedError,
          )
          .sort((left, right) => Number(right.start || 0) - Number(left.start || 0))
          .map((issue) => issue.id);
        if (!ids.length) return 0;
        const stayTime = Number(state.currentTime || 0);
        let applied = 0;
        for (const id of ids) {
          if (!state.issues.some((item) => item.id === id)) continue;
          cutScriptIssue(id, { record: false, quiet: true });
          applied += 1;
        }
        seekTimeline(Math.max(0, stayTime));
        return applied;
      }
      function cutScriptIssue(id, { record = true, quiet = false, scope = null } = {}) {
        const issue = state.issues.find((item) => item.id === id);
        if (!issue) return;
        const target = scope ? { ...issue, ...scope, id: scope.id || issue.id,
          issueId: scope.issueId || issue.issueId || issue.id } : issue;
        const start = Math.max(0, Number(target.start ?? 0));
        let end = Math.min(
          state.duration,
          Math.max(start + 0.04, Number(target.end ?? 0)),
        );
        if (target.type === 'repeat' && !repeatCutPreservesCaptionText(start,end)) {
          if (!quiet) toast('疑似重复范围覆盖了全部文案，已取消删除以保护工程');
          return;
        }
        const captionRemoval = planIssueWordsRemoval(id, start, end, target);
        if (captionRemoval.blocked) {
          if (!quiet) toast(issueCaptionRemovalMessage(captionRemoval.reason));
          return;
        }
        if (!mainAudioClips().some(c=>c.start<end&&c.end>start) &&
            state.audioAssets.some(c=>c.start<end&&c.end>start)) {
          if (record) snapshot();
          if (!removeIssueWords(id,start,end,target,captionRemoval)) return;
          dismissTrimmedIssues(start,end);
          // Independent clips already own their source ranges. Cut the placed
          // timeline directly; mapping through removed main media is invalid.
          shiftTracks(start,end-start);
          recomputeContentDuration();clampTracksToDuration();
          if (!quiet) {seekTimeline(start);renderAll();queueAutosave();toast('已同步删除所选词句及对应音视频');}
          return;
        }
        const sourceStart = timelineToSource(start),
          sourceEnd = timelineToSource(end);
        if (sourceEnd <= sourceStart + 0.002) {
          if (!quiet) toast("这一处没有可剪掉的音频范围");
          return;
        }
        if (record) snapshot();
        if (!removeIssueWords(id, start, end, target, captionRemoval)) return;
        state.removals.push({
          start: sourceStart,
          end: sourceEnd,
          source: `script-${target.type || "difference"}`,
        });
        shiftTracks(start, end - start);
        state.reviewCaptions = state.reviewCaptions.filter(item => scope
          ? item.id !== scope.id : (item.issueId || item.id) !== id);
        const remainingIssue = state.reviewCaptions.some(item => (item.issueId || item.id) === id) ||
          state.captions.some(caption => (caption.words || []).some(word => word.issueId === id));
        state.issues = state.issues.filter(item => item.id !== id || remainingIssue);
        state.matchIssues = (state.matchIssues || []).filter(item =>
          (item.issueId || item.id) !== id || remainingIssue);
        normalizeRemovals();
        recomputeContentDuration();
        clampTracksToDuration();
        state.selected = { type: "video", id: "main" };
        state.selectedItems = [];
        if (!quiet) {
          seekTimeline(Math.max(0, start));
          renderAll();
          toast("已同步剪掉红色词句、视频和音频");
          queueAutosave();
        }
      }
      
