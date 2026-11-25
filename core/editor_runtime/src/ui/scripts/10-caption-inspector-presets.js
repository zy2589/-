function renderIssues() {
  const box=$('issueList');if(!box)return;
  const pending=Array.from(new Map((state.reviewCaptions||[]).filter(r=>['mismatch','repeat','missing','unverifiedAddition'].includes(r.type)).map(r=>[r.id,r])).values()).sort((a,b)=>a.start-b.start);
  const count=$('reviewPendingCount');if(count)count.textContent=pending.length+' 处待确认';
  const all=typeof captionReviewShowAll!=='undefined' && captionReviewShowAll;
  $('reviewPendingOnly')?.classList.toggle('active',!all);$('reviewAll')?.classList.toggle('active',all);
  box.replaceChildren();
  for(const review of pending){
    const row=document.createElement('div');row.className='caption-review-entry';
    const pendingAudioCheck=(review.type==='missing'||review.action==='missing')&&!review.confirmedMissing&&review.needsAudioReview!==false;
    const button=document.createElement('button');button.className='btn caption-review-row '+review.type+(pendingAudioCheck?' audio-unverified':'');button.textContent=formatTime(review.start,false)+' · '+reviewClipTitle(review);button.onclick=()=>{seekTimeline(review.start);showReviewDetails(review.id);};
    const audition=document.createElement('button');audition.className='btn caption-review-audition';audition.textContent='试听';audition.title='试听这处问题对应的原始音频';audition.onclick=()=>auditionReviewSegment(review.id);
    row.append(button,audition);box.append(row);
  }
  if(all){for(const caption of state.captions||[]){const changed=(caption.words||[]).filter(w=>w.autoMildCorrected || w.issueType==='addition');if(!changed.length)continue;const button=document.createElement('button');button.className='btn caption-review-row caption-mild-note';button.textContent=formatTime(caption.start,false)+' · 已自动处理：'+changed.map(w=>w.display).join(' ');button.onclick=()=>{seekTimeline(caption.start);showCaptionDetails(caption);};box.append(button);}}
  if(!box.children.length){const text=document.createElement('p');text.className='small';text.textContent='没有待确认的问题。';box.append(text);}
}
      let captionInspectorKey = "";
      function editableCaptionTokens(text) {
        const raw = String(text || "").match(/\d+:\d+(?:-\d+)?|[\$¥€£]\d+(?:\.\d+)?|\d+(?:\.\d+)?%|\d+(?:\.\d+)?(?:kg|km|m|cm|mm|px|ms|s)|[A-Za-z]\.(?:[A-Za-z]\.)+|[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
        const words = [];
        let prefix = "";
        let inDoubleQuote = false;
        let inSingleQuote = false;
        const CLOSING_OR_PAUSE_PUNCT = /^["”’」』》〉）】〕〗)\]}。，、；：！？…—～.,!?:;-]$/u;
        for (const token of raw) {
          if (/^[\p{L}\p{N}\$¥€£]/u.test(token)) {
            words.push(`${prefix}${token}`);
            prefix = "";
          } else if (token === '"') {
            if (inDoubleQuote) {
              if (words.length) words[words.length - 1] += token;
              else prefix += token;
              inDoubleQuote = false;
            } else {
              prefix += token;
              inDoubleQuote = true;
            }
          } else if (token === "'") {
            if (inSingleQuote) {
              if (words.length) words[words.length - 1] += token;
              else prefix += token;
              inSingleQuote = false;
            } else {
              prefix += token;
              inSingleQuote = true;
            }
          } else if (/^[“‘「『《〈（【〔〖(\[{]$/u.test(token)) {
            prefix += token;
            if (token === "“") inDoubleQuote = true;
            if (token === "‘") inSingleQuote = true;
          } else if (CLOSING_OR_PAUSE_PUNCT.test(token)) {
            if (token === "”") inDoubleQuote = false;
            if (token === "’") inSingleQuote = false;
            if (words.length) words[words.length - 1] += token;
            else prefix += token;
          } else if (words.length) {
            words[words.length - 1] += token;
          } else {
            prefix += token;
          }
        }
        if (prefix && words.length) {
          words[words.length - 1] += prefix;
        }
        return words;
      }
      function timedCaptionWords(text, caption) {
        const tokens = editableCaptionTokens(text),
          start = Number(caption.start || 0),
          end = Math.max(start + .04, Number(caption.end || start + .04));
        return tokens.map((display, index) => ({
          display,
          start: start + (end - start) * index / Math.max(1, tokens.length),
          end: start + (end - start) * (index + 1) / Math.max(1, tokens.length),
          matchType: "match",
        }));
      }
      function auxiliaryCaptionState(caption) {
        const text = String(caption?.auxText || "").trim();
        if (!text) return { key: "missing", label: "待翻译" };
        const stale =
          String(caption.auxSourceText || "") !== String(caption.text || "") ||
          String(caption.auxLanguage || "zh-Hans") !== String(state.auxSubtitles.language || "zh-Hans");
        if (caption.auxLocked && stale) return { key: "locked", label: "人工已锁定 · 英文有变化" };
        if (caption.auxLocked) return { key: "locked", label: "人工已锁定" };
        if (stale) return { key: "stale", label: "英文有变化 · 待更新" };
        return { key: "current", label: "已同步" };
      }
      function syncAuxSubtitleControls() {
        state.auxSubtitles = { ...defaultAuxSubtitleSettings(), ...(state.auxSubtitles || {}) };
        if ($("auxSubtitleLanguage")) $("auxSubtitleLanguage").value = state.auxSubtitles.language;
        if ($("auxSubtitleEditorVisible")) $("auxSubtitleEditorVisible").checked = state.auxSubtitles.editorVisible !== false;
        const counts = { missing: 0, stale: 0, locked: 0, current: 0 };
        for (const caption of state.captions || []) counts[auxiliaryCaptionState(caption).key] += 1;
        if ($("auxSubtitleStatus")) {
          $("auxSubtitleStatus").textContent = state.captions.length
            ? `已同步 ${counts.current} · 待生成/更新 ${counts.missing + counts.stale} · 人工锁定 ${counts.locked}`
            : "匹配英文文案后可生成；人工修改的中文会锁定保留。";
        }
      }
      async function generateAuxiliarySubtitles(ids = null) {
        if (!state.captions.length) return toast("请先匹配英文文案");
        const requested = ids ? new Set(ids.map(String)) : null;
        const targets = state.captions.filter((caption) => {
          if (requested) return requested.has(String(caption.id));
          const status = auxiliaryCaptionState(caption).key;
          return !caption.auxLocked && (status === "missing" || status === "stale");
        });
        if (!targets.length) return toast(requested ? "没有可重译的字幕" : "中文辅助字幕已经是最新；人工锁定内容不会被覆盖");
        const button = $("generateAuxSubtitles");
        if (button) {
          button.disabled = true;
          button.textContent = `正在翻译 ${targets.length} 句…`;
        }
        try {
          const result = await nativeCall("translateAuxiliaryCaptions", {
            targetLanguage: state.auxSubtitles.language,
            captions: targets.map((caption) => ({ id: caption.id, text: caption.text })),
          });
          snapshot();
          const translated = new Map((result.translations || []).map((item) => [String(item.id), item.text]));
          let applied = 0;
          for (const caption of targets) {
            const text = String(translated.get(String(caption.id)) || "").trim();
            if (!text) continue;
            caption.auxText = text;
            caption.auxSourceText = caption.text;
            caption.auxLanguage = state.auxSubtitles.language;
            caption.auxLocked = false;
            applied += 1;
          }
          captionInspectorKey = "";
          renderCaptionInspector(true);
          syncAuxSubtitleControls();
          renderPreviewObjects(true);
          queueAutosave();
          toast(applied === targets.length ? `已生成 ${applied} 句中文辅助字幕` : `已生成 ${applied}/${targets.length} 句，未返回的句子可再次更新`);
        } catch (error) {
          toast(error.message);
          if (/纠正设置/.test(error.message)) openReviewSettings();
        } finally {
          if (button) {
            button.disabled = false;
            button.textContent = "生成／更新中文辅助字幕";
          }
        }
      }
      function captionCorrectionKey(text) {
        return (typeof captionContractionKey === 'function' ? captionContractionKey(text) : String(text || '')).normalize('NFKC').toLowerCase()
          .replace(/[\p{P}\p{S}]/gu, (symbol, index, value) => {
            const before = /\d/.test(value[index - 1] || ''), after = /\d/.test(value[index + symbol.length] || '');
            return before && after || /[+\-−$¥€£]/u.test(symbol) && after || symbol === '%' && before ? symbol : '';
          })
          .replace(/\s+/gu, ' ').trim();
      }
      function captionCorrectionDiffers(before, after) {
        if (typeof captionReviewDiffers === 'function' && !captionReviewDiffers(before, after)) return false;
        return !!captionCorrectionKey(before) && !!captionCorrectionKey(after) && captionCorrectionKey(before) !== captionCorrectionKey(after);
      }
      function captionMismatchReviewGroups(caption) {
        const groups = new Map();
        for (const [index, word] of (caption?.words || []).entries()) {
          const recognized = word.recognizedDisplay || word.originalDisplay || word.display || '';
          const expected = word.expectedDisplay || word.referenceExpected || '';
          if (word.issueType !== 'mismatch' || !expected || !captionCorrectionDiffers(recognized, expected)) continue;
          const key = word.issueId ? `issue:${word.issueId}` : `word:${index}`;
          if (!groups.has(key)) groups.set(key, { issueId: word.issueId || '', words: [] });
          groups.get(key).words.push(word);
        }
        const seenLabels = new Map();
        return [...groups.values()].map(group => {
          const review = group.issueId && (state.reviewCaptions || []).find(item =>
            (item.issueId || item.id) === group.issueId && item.type === 'mismatch' &&
            (!item.ownerClipId || item.ownerClipId === (caption.ownerClipId || '')) &&
            (!item.captionTrackId || item.captionTrackId === (caption.trackId || 'caption')));
          const unique = values => [...new Map(values.filter(value => String(value || '').trim()).map(value =>
            [captionCorrectionKey(value), String(value).trim()])).values()];
          const spoken = review?.spokenText || unique(group.words.map(word => word.recognizedDisplay || word.originalDisplay || word.display)).join(' ');
          const expected = review?.expectedText || unique(group.words.map(word => word.expectedDisplay || word.referenceExpected)).join(' ');
          const times = group.words.map(word => [Number(word.start), Number(word.end)])
            .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
          return {
            issueId: group.issueId, spokenText: spoken, expectedText: expected,
            start: times.length ? Math.min(...times.map(([start]) => start)) : NaN,
            end: times.length ? Math.max(...times.map(([, end]) => end)) : NaN,
          };
        }).filter(group => {
          const spoken = captionCorrectionKey(group.spokenText);
          const expected = captionCorrectionKey(group.expectedText);
          if (!spoken || !expected) return false;
          const key = `${spoken}\u2192${expected}`;
          const previous = seenLabels.get(key) || [];
          if (previous.some(item => {
            if (![group.start, group.end, item.start, item.end].every(Number.isFinite)) return false;
            const overlap = Math.min(group.end, item.end) - Math.max(group.start, item.start);
            const shorter = Math.min(group.end - group.start, item.end - item.start);
            return (overlap > 0.005 && shorter > 0 && overlap / shorter >= 0.75) ||
              (Math.abs(group.start - item.start) <= 0.035 && Math.abs(group.end - item.end) <= 0.06);
          })) return false;
          previous.push({ start: group.start, end: group.end });
          seenLabels.set(key, previous);
          return true;
        });
      }
      function renderCaptionReferenceChanges(caption) {
        caption.textAuditBaseline ??= caption.text || '';
        const differs = captionCorrectionDiffers;
        const seen = new Set();
        const changes = (caption.textChanges || []).filter(change => {
          if (change.kind === 'manual' || !differs(change.before,change.after)) return false;
          const before=captionCorrectionKey(change.before),after=captionCorrectionKey(change.after),key=`${before}→${after}`;
          if (seen.has(key) || captionMismatchReviewGroups(caption).some(group =>
            captionCorrectionKey(group.spokenText)===before && captionCorrectionKey(group.expectedText)===after)) return false;
          seen.add(key);return true;
        }).map(change =>
          `<div class="caption-mismatch-suggestion small status"><span>${escapeHtml(change.before)}（识别文案） → ${escapeHtml(change.after)}（正确文案）</span></div>`).join('');
        return changes + (caption.words || []).map((word,index) => {
          if(word.autoMildCorrected)return `<div class="caption-mild-note small">已自动处理：${escapeHtml(word.display)}</div>`;
          if (word.meaningReview?.meaningImpact === 'same' || word.autoNumericCorrected) return '';
          if ((word.ccReferenceReview || word.expectedDisplay || word.referenceExpected) &&
              (word.originalDisplay && word.originalDisplay !== word.display || word.referenceExpected)) {
            const recognized = word.recognizedDisplay || word.originalDisplay || word.display;
            const expected = word.referenceExpected || word.expectedDisplay || word.display;
            if (!differs(recognized, expected) || word.issueType === 'mismatch') return '';
            const action = '';
            return `<div class="caption-mismatch-suggestion small status"><span>${escapeHtml(recognized)}（识别文案） → ${escapeHtml(expected)}（正确文案）</span>${action}</div>`;
          }
          return '';
        }).join('');
      }
      function recordCaptionTextChange(caption, before, after, kind = 'manual') {
        if (before === after) return;
        caption.textChanges ||= [];
        const last = caption.textChanges.at(-1);
        if (last?.kind === kind && last.after === before) last.after = after;
        else caption.textChanges.push({kind,before,after});
        caption.textAuditBaseline = after;
      }
      function handleCaptionReferenceChoice(event) {
        const button = event.target.closest?.('[data-reference-choice]');
        if (!button) return;
        event.preventDefault();event.stopPropagation();
        const caption = state.captions.find(c => c.id === button.dataset.referenceCaption);
        const index = Number(button.dataset.referenceWord), word = caption?.words?.[index];
        if (!word || isTrackLocked(caption.trackId || 'caption')) return;
        const recognized = word.recognizedDisplay || word.originalDisplay || word.display;
        const expected = word.referenceExpected || word.expectedDisplay || word.display;
        const text = button.dataset.referenceChoice === 'recognized' ? recognized : expected;
        const tokens = editableCaptionTokens(text);if (!tokens.length) return;
        snapshot();const before = caption.text;
        const replacements = tokens.map((display,i) => ({...word,display,recognizedDisplay:recognized,originalDisplay:recognized,referenceExpected:expected,userKept:true,matchType:'edited',issueType:'',issueId:'',action:'',
          start:word.start+(word.end-word.start)*i/tokens.length,end:word.start+(word.end-word.start)*(i+1)/tokens.length,
          ...(Number.isFinite(word.sourceStart)&&Number.isFinite(word.sourceEnd)?{sourceStart:word.sourceStart+(word.sourceEnd-word.sourceStart)*i/tokens.length,sourceEnd:word.sourceStart+(word.sourceEnd-word.sourceStart)*(i+1)/tokens.length}:{})}));
        caption.words.splice(index,1,...replacements);caption.text=joinCaptionWords(caption.words);
        recordCaptionTextChange(caption,before,caption.text);
        renderAll();queueAutosave();
      }
      function renderCaptionMismatchSuggestions(caption) {
        return renderCaptionReferenceChanges(caption) + captionMismatchReviewGroups(caption).map(group =>
          `<div class="caption-mismatch-suggestion"><span>${escapeHtml(group.spokenText)}（识别文案） → ${escapeHtml(group.expectedText)}（正确文案）</span></div>`
        ).join("");
      }
      function renderCaptionEmphasisPicker(caption) {
        if (state.captionStyle?.keywordMode !== true) return "";
        const words = Array.isArray(caption.words) && caption.words.length
          ? caption.words
          : editableCaptionTokens(caption.text).map((display) => ({ display, emphasis: false }));
        return `<div class="caption-emphasis-picker"><span class="small">点选要着色、放大的关键词</span><div class="caption-emphasis-words">${words.map((word, index) => `<button type="button" class="caption-emphasis-word ${word.emphasis ? "active" : ""}" data-caption-emphasis="${escapeHtml(caption.id || "")}" data-word-index="${index}" aria-pressed="${word.emphasis ? "true" : "false"}">${escapeHtml(word.display || "")}</button>`).join("")}</div></div>`;
      }
      function renderCaptionInspector(force = false) {
        const key = JSON.stringify(state.captions.map((caption) => [
          caption.id, caption.start, caption.end, caption.text, caption.auxText,
          caption.textChanges,
          caption.auxSourceText, caption.auxLanguage, caption.auxLocked,
          (caption.words || []).map(word => [word.display, word.originalDisplay, word.emphasis, word.autoCorrected, word.ccReferenceReview, word.matchType, word.issueType, word.expectedDisplay]),
        ]).concat([state.captionStyle?.keywordMode === true]));
        if (!force && key === captionInspectorKey) {
          focusCaptionInspector(state.selected.type === "caption" ? state.selected.id : "", false);
          return;
        }
        captionInspectorKey = key;
        $("captionInspectorList").innerHTML = state.captions.length
          ? state.captions.map((caption, index) => {
              const auxState = auxiliaryCaptionState(caption);
              return `<div class="caption-inspector-row ${state.selected.type === "caption" && state.selected.id === caption.id ? "selected" : ""}" data-caption-row="${escapeHtml(caption.id || "")}"><button class="caption-inspector-time" type="button" data-caption-seek="${escapeHtml(caption.id || "")}">${formatTime(caption.start, false)}</button><div class="caption-inspector-copy"><textarea data-caption-edit="${escapeHtml(caption.id || "")}" aria-label="第 ${index + 1} 段字幕">${escapeHtml(caption.text)}</textarea>${renderCaptionEmphasisPicker(caption)}${renderCaptionMismatchSuggestions(caption)}</div></div>`;
            }).join("")
          : '<div class="small">语音识别、导入或匹配文案后，所有字幕都在这里查看和编辑。</div>';
        requestAnimationFrame(() => $("captionInspectorList").querySelectorAll("textarea").forEach(fitCaptionTextarea));
      }
      function fitCaptionTextarea(editor) {
        if (!editor) return;
        editor.style.height = "auto";
        editor.style.height = `${Math.max(42, editor.scrollHeight + 2)}px`;
      }
      function focusCaptionInspector(id, scroll = true) {
        const list = $("captionInspectorList");
        if (!list) return;
        list.querySelectorAll("[data-caption-row]").forEach((row) =>
          row.classList.toggle("selected", !!id && row.dataset.captionRow === id),
        );
        if (!id || !scroll) return;
        const row = [...list.querySelectorAll("[data-caption-row]")].find((item) => item.dataset.captionRow === id);
        if (row) requestAnimationFrame(() => row.scrollIntoView({ block: "nearest", behavior: "auto" }));
      }
      function activateCaptionListFor(id) {
        const caption = state.captions.find((item) => item.id === id);
        if (!caption) return;
        const side = "subtitle";
        const tab = document.querySelector(`.tab[data-side="${side}"]`);
        if (tab && !tab.classList.contains("active")) tab.click();
        focusCaptionInspector(id, true);
        focusAutoTranscript(id, true);
      }
      function revealCaptionOnTimeline(id) {
        const caption = state.captions.find((item) => item.id === id);
        if (!caption) return;
        selectItem("caption", id);
        seekTimeline(Number(caption.start || 0));
        keepPlayheadInView("center");
        renderTimeline();
        renderPreviewObjects();
        updateInspector();
      }
      function replacementBoundary(tokens, ideal, minimum) {
        let best = clamp(Math.round(ideal), minimum + 1, tokens.length - 1),
          score = Infinity;
        for (let index = Math.max(minimum + 1, best - 3); index <= Math.min(tokens.length - 1, best + 3); index += 1) {
          const punctuation = /[.!?…\u3002\uff01\uff1f]["'”’」』》〉）】〕〗)]*$/u.test(tokens[index - 1] || "") ? -8
            : /[,;:—–-，、；：]["'”’」』》〉）】〕〗)]*$/u.test(tokens[index - 1] || "") ? -3 : 0;
          const orphan = /^(?:and|but|or|so|because|for|yet)$/i.test((tokens[index] || "").replace(/[^\p{L}]/gu, "")) ? 2 : 0;
          const candidate = Math.abs(index - ideal) + punctuation + orphan;
          if (candidate < score) { score = candidate; best = index; }
        }
        return best;
      }
      function replaceCaptionsFromManuscript() {
        if (!state.captions.length) return toast("请先匹配生成字幕");
        const tokens = editableCaptionTokens($("scriptText").value);
        if (!tokens.length) return toast("请先粘贴正确文案");
        const selectedIds = new Set(state.captions.map((caption) => caption.id));
        snapshot();
        const hasAlignedManuscriptWords = state.captions.some((caption) =>
          (caption.words || []).some((word) => String(word.expectedDisplay || "").trim()),
        );
        if (hasAlignedManuscriptWords) {
          for (const caption of state.captions) {
            if (!selectedIds.has(caption.id) || !caption.words?.length) continue;
            caption.words = caption.words.map((word) => ({
              ...word,
              display: String(word.expectedDisplay || word.display || "").trim(),
              matchType: "match",
              issueType: "",
            })).filter((word) => word.display);
            caption.text = joinCaptionWords(caption.words);
            if (caption.words.length) {
              caption.start = Number(caption.words[0].start || caption.start);
              caption.end = Math.max(caption.start + .04, Number(caption.words.at(-1).end || caption.end));
            }
          }
          captionInspectorKey = "";
          renderAll();
          renderCaptionInspector(true);
          toast("已按当前剪辑后的断行替换为正确文案，删除的词句不会恢复");
          return;
        }
        const existingTotal = state.captions.reduce((sum, caption) =>
          sum + Math.max(1, caption.words?.length || editableCaptionTokens(caption.text).length), 0);
        let cursor = 0, usedWeight = 0;
        state.captions.forEach((caption, index) => {
          const weight = Math.max(1, caption.words?.length || editableCaptionTokens(caption.text).length);
          usedWeight += weight;
          const endIndex = index === state.captions.length - 1
            ? tokens.length
            : replacementBoundary(tokens, tokens.length * usedWeight / existingTotal, cursor);
          const text = joinCaptionWords(tokens.slice(cursor, Math.max(cursor + 1, endIndex)));
          if (selectedIds.has(caption.id)) {
            caption.text = text;
            caption.words = timedCaptionWords(text, caption);
          }
          cursor = endIndex;
        });
        captionInspectorKey = "";
        renderAll();
        renderCaptionInspector(true);
        toast("已按当前断行替换为正确文案，全部时间戳保持不变");
      }
      function allCaptionPresets() {
        return [...customPresets, ...presets];
      }
      function presetPreviewColor(style, index) {
        const value = String(style?.color || "#ffffff").trim();
        if (/^(?:black|#0{3}|#0{6}|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value))
          return ["#ffd21f", "#58e391", "#ff963d", "#50a8ff", "#35dce0"][
            index % 5
          ];
        const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return value;
        const hex = match[1].length === 3
          ? match[1].split("").map((part) => part + part).join("")
          : match[1];
        const channels = [0, 2, 4].map((offset) =>
          parseInt(hex.slice(offset, offset + 2), 16) / 255,
        );
        const luminance = channels
          .map((channel) =>
            channel <= 0.03928
              ? channel / 12.92
              : Math.pow((channel + 0.055) / 1.055, 2.4),
          )
          .reduce(
            (total, channel, channelIndex) =>
              total + channel * [0.2126, 0.7152, 0.0722][channelIndex],
            0,
          );
        const panelLuminance = 0.021;
        const contrast =
          (Math.max(luminance, panelLuminance) + 0.05) /
          (Math.min(luminance, panelLuminance) + 0.05);
        return contrast >= 3
          ? value
          : ["#ffd21f", "#58e391", "#ff963d", "#50a8ff", "#35dce0"][
              index % 5
            ];
      }
      function presetPreviewStroke(style, index) {
        if (Number(style?.stroke || 0) <= 0) return "transparent";
        const value = String(style?.strokeColor || "").trim();
        if (
          !value ||
          /^(?:black|#0{3}|#0{6}|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)
        )
          return ["#ffffff", "#ffe15a", "#7eeaff", "#b8ffcf"][index % 4];
        const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return value;
        const hex = match[1].length === 3
          ? match[1].split("").map((part) => part + part).join("")
          : match[1];
        const brightness =
          parseInt(hex.slice(0, 2), 16) * 0.2126 +
          parseInt(hex.slice(2, 4), 16) * 0.7152 +
          parseInt(hex.slice(4, 6), 16) * 0.0722;
        return brightness < 82
          ? ["#ffffff", "#ffe15a", "#7eeaff", "#b8ffcf"][index % 4]
          : value;
      }
      function renderPresetCard(p, i, isCustom = false) {
        p = {...p, style:window.ClipAssistantPresetSafety.sanitizePresetStyle(p.style)};
        const bg = p.style.backgroundEnabled ? (p.style.background || "#131922") : "transparent";
        const strokePx = Math.min(3, Math.max(0, Number(p.style.stroke || 0)));
        const strokeCss = strokePx > 0 ? `-webkit-text-stroke:${strokePx}px ${p.style.strokeColor || "#000"};paint-order:stroke fill;` : "";
        const shadowCss = Number(p.style.shadow || 0) > 0 ? `filter:drop-shadow(0 2px 4px rgba(0,0,0,0.85));` : "";
        const previewText = p.style.keywordMode === true
          ? `<span class="word">AND</span><span class="word active">EVEN</span><span class="word">FROM</span>`
          : p.style.textCase === "none"
            ? `<span class="word">Dear God,</span><span class="word">thank You</span>`
            : `<span class="word">Amazing</span><span class="word active">Story</span>`;
        const customActions = isCustom
          ? `<span class="preset-actions"><button type="button" class="preset-edit-btn" data-edit-preset="${i}" title="修改自定义模板">修改</button><button type="button" class="preset-del-btn" data-del-preset="${i}" title="删除自定义模板">删除</button></span>`
          : "";
        return `<button class="preset" data-preset="${i}" title="${escapeHtml(p.name)}">
          ${customActions}
          <span class="captionobject anim-enter" data-animation="${escapeHtml(p.style.animation || "fade")}" data-highlight-style="${p.style.highlightStyle === "block" ? "block" : "text"}" style="--active:${p.style.highlight || "#ffd21f"};--stroke-color:${p.style.strokeColor || "#000000"};font-family:'${p.style.fontFamily || "Helvetica"}',sans-serif;font-weight:${p.style.fontWeight || 700};color:${presetPreviewColor(p.style, i)};-webkit-text-stroke:${Math.min(3, Math.max(0, Number(p.style.stroke || 0)) * 2)}px ${presetPreviewStroke(p.style, i)};paint-order:stroke fill;${shadowCss}background:${bg};padding:3px 6px;border-radius:${Math.min(16, p.style.radius || 0)}px">
            ${previewText}
          </span>
          <span class="small ellipsis">${escapeHtml(p.name)}</span>
        </button>`;
      }
      function renderPresets() {
        const customHtml = customPresets.map((p, i) => renderPresetCard(p, i, true)).join("");
        const systemHtml = presets.map((p, i) => renderPresetCard(p, customPresets.length + i, false)).join("");
        $("presetList").innerHTML = `
          <div class="preset-group-title">🎨 我的自定义模板 (${customPresets.length})</div>
          <div class="preset-grid">${customHtml || '<div class="small" style="grid-column:1/-1;color:var(--muted);padding:8px 4px">暂无自定义模板，可在右侧调整属性后点击下方按钮保存。</div>'}</div>
          <div class="preset-group-title" style="margin-top:12px">🌟 精选预设</div>
          <div class="preset-grid">${systemHtml}</div>
        `;
      }
      async function loadCustomPresets() {
        try {
          customPresets = (await nativeCall("customCaptionPresets")) || [];
          localStorage.setItem(
            "clipassistant_custom_caption_presets",
            JSON.stringify(customPresets),
          );
        } catch (error) {
          console.warn(error);
        }
        renderPresets();
      }
      function selectedAnimationObject() {
        return ["text", "image"].includes(state.selected.type)
          ? currentObject()
          : null;
      }
      function renderAnimationPanel() {
        const object = selectedAnimationObject(),
          type = state.selected.type === "image" ? "image" : "text",
          list = type === "text" ? textAnimations : imageAnimations,
          selectedId = object?.[`${animationMode}Animation`] || "";
        $("animationHint").textContent = object
          ? `${type === "text" ? "文字" : "图片"}·${animationMode === "enter" ? "入场" : "出场"}动画；移入卡片预览，点击套用。`
          : "请先在时间线或预览窗口选中一段文字或图片。";
        $("animationDuration").disabled = !object;
        const duration = object
          ? Number(object[`${animationMode}Duration`] || 0.45)
          : 0.45;
        $("animationDuration").value = Math.round(duration * 100);
        $("animationDurationOut").textContent = `${duration.toFixed(2)}秒`;
        $("animationGrid").innerHTML = list
          .map(
            (entry) =>
              `<button class="animation-card ${entry.id === selectedId ? "active" : ""}" data-animation-id="${escapeHtml(entry.id)}" data-motion="${escapeHtml(entry.motion)}" title="${escapeHtml(entry.name)}"><span class="animation-demo">${type === "text" ? "Amazing Story" : "图片"}</span><span class="small ellipsis">${escapeHtml(entry.name)}</span></button>`,
          )
          .join("");
        document.querySelectorAll("[data-animation-mode]").forEach((button) =>
          button.classList.toggle("active", button.dataset.animationMode === animationMode),
        );
      }
      function updateInspector() {
        const obj = currentObject() || state.videoTransform,
          s = currentStyle(),
          labels = {
            video: "视频属性",
            videolayer: "叠加视频属性",
            audio: "主音频属性",
            audioasset: "音频素材属性",
            image: "图片属性",
            compound: "复合片段属性",
            text: "标题文字",
            caption: "字幕属性",
            review: "差异复核",
          };
        const selectedVisualCount = (state.selectedItems || []).filter((item) =>
          ["video", "videolayer", "image", "compound"].includes(item.type),
        ).length;
        let selectedSpliceTarget = null;
        if (state.selected.type === "video") {
          const clip = activeMainVideoClip?.();
          if (clip) selectedSpliceTarget = { type: "main", clip, settings: obj, media: state.video };
        } else if (["videolayer", "image"].includes(state.selected.type)) {
          selectedSpliceTarget = { type: "layer", clip: obj, settings: obj, media: obj };
        }
        const pipContentSelected = selectedVisualCount <= 1 &&
          window.spliceRegionForExport?.(selectedSpliceTarget)?.kind === "pip";
        $("selectionTitle").textContent = selectedVisualCount > 1
          ? `已选 ${selectedVisualCount} 个画面片段`
          : pipContentSelected ? "画中画框内素材属性"
          : labels[state.selected.type] || "素材属性";
        const pipHint = $("pipContentPropertyHint");
        if (pipHint) pipHint.hidden = !pipContentSelected;
        if ($("multiTransformHint"))
          $("multiTransformHint").style.display = selectedVisualCount > 1 ? "block" : "none";
        $("objectScale").value = Math.round((obj.scale || 1) * 100);
        $("scaleOut").textContent = `${$("objectScale").value}%`;
        window.syncPositionControlValue?.("X", obj.x);
        window.syncPositionControlValue?.("Y", obj.y);
        const visual = ["video", "videolayer", "image", "text", "compound"].includes(state.selected.type);
        $("visualProperties").style.display = visual ? "block" : "none";
        $("objectRotation").value = Math.round(Number(obj.rotation || 0));
        $("rotationOut").textContent = `${$("objectRotation").value}°`;
        $("objectOpacity").value = Math.round(Number(obj.opacity ?? 1) * 100);
        $("opacityOut").textContent = `${$("objectOpacity").value}%`;
        $("objectBlendMode").value = obj.blendMode || "normal";
        if ($("cropTop")) {
          $("cropTop").value = Number(Number(obj.cropTop || 0).toFixed(2));
          $("cropTopOut").textContent = `${$("cropTop").value}%`;
          $("cropBottom").value = Number(Number(obj.cropBottom || 0).toFixed(2));
          $("cropBottomOut").textContent = `${$("cropBottom").value}%`;
          $("cropLeft").value = Number(Number(obj.cropLeft || 0).toFixed(2));
          $("cropLeftOut").textContent = `${$("cropLeft").value}%`;
          $("cropRight").value = Number(Number(obj.cropRight || 0).toFixed(2));
          $("cropRightOut").textContent = `${$("cropRight").value}%`;
          for (const key of ["cropTop", "cropBottom", "cropLeft", "cropRight"])
            if ($(`${key}Exact`)) $(`${key}Exact`).value = $(key).value;
        }
        $("textProperties").style.display = ["text", "caption"].includes(
          state.selected.type,
        )
          ? "block"
          : "none";
        if (["text", "caption"].includes(state.selected.type)) {
          $("objectText").value =
            state.selected.type === "text"
              ? obj.text
              : currentTimelineObject()?.text || "";
          $("fontSize").value = s.fontSize || 54;
          $("fontWeight").value = s.fontWeight || 700;
          $("fontBoldToggle").classList.toggle("active", Number(s.fontWeight || 700) >= 700);
          $("fontItalicToggle").classList.toggle("active", !!s.fontItalic);
          $("fontUnderlineToggle").classList.toggle("active", !!s.fontUnderline);
          document.querySelectorAll("[data-text-case]").forEach((button) =>
            button.classList.toggle("active", button.dataset.textCase === (s.textCase || "none")),
          );
          syncFontFamilySelection(s);
          $("letterSpacing").value = Number(s.letterSpacing || 0);
          $("letterSpacingOut").textContent = `${Number(s.letterSpacing || 0)}px`;
          $("wordSpacing").value = Number(s.wordSpacing || 0);
          $("wordSpacingOut").textContent = `${Number(s.wordSpacing || 0)}px`;
          $("lineHeight").value = Math.round(Number(s.lineHeight || 1.15) * 100);
          $("lineHeightOut").textContent = `${$("lineHeight").value}%`;
          $("fontColor").value = s.color || "#ffffff";
          $("highlightColor").value = s.highlight || "#ffd21f";
          $("highlightStyle").value = s.highlightStyle === "block" ? "block" : "text";
          $("highlightEnabled").checked = s.highlightEnabled !== false;
          $("highlightBlockWidth").value = Number(s.highlightBlockWidth ?? 5);
          $("highlightBlockWidthOut").textContent = $("highlightBlockWidth").value;
          $("highlightBlockHeight").value = Number(s.highlightBlockHeight ?? 3);
          $("highlightBlockHeightOut").textContent = $("highlightBlockHeight").value;
          $("highlightBlockScale").value = Math.round(Number(s.highlightBlockScale ?? 1) * 100);
          $("highlightBlockScaleOut").textContent = `${$("highlightBlockScale").value}%`;
          $("highlightBlockX").value = Number(s.highlightBlockX ?? 0);
          $("highlightBlockXOut").textContent = $("highlightBlockX").value;
          $("highlightBlockY").value = Number(s.highlightBlockY ?? 0);
          $("highlightBlockYOut").textContent = $("highlightBlockY").value;
          $("highlightBlockRadius").value = Number(s.highlightBlockRadius ?? 4);
          $("highlightBlockRadiusOut").textContent = $("highlightBlockRadius").value;
          const blockControls = $("highlightBlockControls");
          if (blockControls) blockControls.style.display = s.highlightStyle === "block" && s.highlightEnabled !== false ? "" : "none";
          syncCaptionMotionControls(s);
          $("strokeColor").value = s.strokeColor || "#000000";
          $("stroke").value = s.stroke || 0;
          $("strokeOut").textContent = s.stroke || 0;
          $("shadowColor").value = s.shadowColor || "#000000";
          $("shadowStrength").value = Number(s.shadow ?? 0);
          $("shadowStrengthOut").textContent = Number(s.shadow ?? 0).toFixed(1);
          $("shadowOpacity").value = Math.round(Number(s.shadowOpacity ?? 0.8) * 100);
          $("shadowOpacityOut").textContent = `${$("shadowOpacity").value}%`;
          $("shadowBlur").value = Number(s.shadowBlur ?? s.shadow ?? 0);
          $("shadowBlurOut").textContent = $("shadowBlur").value;
          $("shadowDistance").value = Number(s.shadowDistance ?? s.shadow ?? 0);
          $("shadowDistanceOut").textContent = $("shadowDistance").value;
          $("shadowAngle").value = Number(s.shadowAngle ?? 45);
          $("shadowAngleOut").textContent = `${$("shadowAngle").value}°`;
          $("glowColor").value = s.glowColor || s.color || "#ffffff";
          $("glow").value = s.glow || 0;
          $("glowOut").textContent = s.glow || 0;
          $("backgroundEnabled").checked = !!s.backgroundEnabled;
          if ($("backgroundFitText")) $("backgroundFitText").checked = s.backgroundFitText !== false;
          $("backgroundColor").value = s.background || "#000000";
          $("backgroundOpacity").value = Math.round(
            (s.backgroundOpacity ?? 0.7) * 100,
          );
          $("backgroundOpacityOut").textContent = `${$("backgroundOpacity").value}%`;
          $("backgroundWidth").value = Number(s.backgroundWidth ?? s.padding ?? 14);
          $("backgroundWidthOut").textContent = $("backgroundWidth").value;
          $("backgroundHeight").value = Number(s.backgroundHeight ?? s.padding ?? 14);
          $("backgroundHeightOut").textContent = $("backgroundHeight").value;
          $("backgroundX").value = Number(s.backgroundX || 0);
          $("backgroundXOut").textContent = $("backgroundX").value;
          $("backgroundY").value = Number(s.backgroundY || 0);
          $("backgroundYOut").textContent = $("backgroundY").value;
          $("backgroundRadius").value = s.radius || 0;
          $("backgroundRadiusOut").textContent = $("backgroundRadius").value;
          document.querySelectorAll("[data-text-align]").forEach((button) =>
            button.classList.toggle("active", button.dataset.textAlign === s.textAlign),
          );
          document.querySelectorAll("[data-vertical-align]").forEach((button) =>
            button.classList.toggle("active", button.dataset.verticalAlign === s.verticalAlign),
          );
          document.querySelectorAll("[data-background-mode]").forEach((button) =>
            button.classList.toggle("active", button.dataset.backgroundMode === s.backgroundMode),
          );
        }
        renderAnimationPanel();
      }
      
