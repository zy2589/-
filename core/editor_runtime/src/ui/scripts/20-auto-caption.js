      function renderRecognizedCopy() {
        const value = String(state.recognizedTextCleared ? '' : (state.recognizedText || state.autoTranscript?.text || ''));
        for (const id of ['transcriptRecognizedText','subtitleRecognizedText']) {
          const field=$(id);
          if (field && field.value !== value) field.value=value;
        }
      }
      let autoCaptionJobId = "";
      function denoiseCacheValidForCurrentSource() {
        const cached = state.denoisedAudio;
        return !!(cached?.path && !cached.missing && cached.sourcePath === state.video?.path);
      }
      function manuscriptSourceVideo() {
        if (state.video?.path) return state.video;
        const selected = state.selected?.type === "videolayer"
          ? (state.videoLayers || []).find(item => item.id === state.selected.id && item.path)
          : null;
        if (selected) return selected;
        const candidates = (state.videoLayers || []).filter(item => item?.path && !item.missing)
          .sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
        return candidates.find(item => (state.audioAssets || []).some(audio =>
          audio.path === item.path || audio.sourceMediaId === item.path)) || candidates[0] || null;
      }
      function manuscriptSourceDuration(media = manuscriptSourceVideo()) {
        return Math.max(0, Number(media?.sourceDuration || media?.duration ||
          (Number(media?.sourceEnd || 0) - Number(media?.sourceStart || 0)) ||
          (Number(media?.end || 0) - Number(media?.start || 0)) || 0));
      }
      function autoCaptionSourcePath() {
        // Match the manuscript entry point: denoising may erase quiet syllables.
        return manuscriptSourceVideo()?.path || "";
      }
      function autoCaptionTimelineSignature() {
        return [...mainClips(),...mainAudioClips(),...state.videoLayers,...state.audioAssets].map((clip) => [clip.id,clip.path||'',clip.trackId||'',Number(clip.start||0).toFixed(7), Number(clip.end||0).toFixed(7), Number(clip.sourceStart||0).toFixed(7), Number(clip.sourceEnd||0).toFixed(7)]).join("|");
      }
      function autoCaptionMediaSignature() {
        const v = manuscriptSourceVideo() || {};
        return [v.path || "", v.url || "", v.id || "", v.name || "", manuscriptSourceDuration(v).toFixed(4)].join("|");
      }
      function manuscriptSourceClips() {
        const path=autoCaptionSourcePath();
        const audio=[...mainAudioClips().map(c=>({...c,ownerClipType:"audio"})),...(state.audioAssets||[]).filter(c=>c.path===path||c.sourceMediaId===path).map(c=>({...c,ownerClipType:"audioasset"}))];
        return audio.map(c=>({...c,sourceStart:Number(c.sourceStart||0),sourceEnd:Number(c.sourceEnd??(Number(c.sourceStart||0)+(c.end-c.start)*Number(state.audio.speed||1)))}));
      }
      function bindMatchedCaptionSources(captions, clips) {
        const sourcePath=autoCaptionSourcePath();
        return (captions||[]).flatMap(caption=>clips.flatMap(clip=>{
          const rate=(clip.sourceEnd-clip.sourceStart)/(clip.end-clip.start);
          const words=(caption.words||[]).filter(w=>(w.start+w.end)/2>=clip.start&&(w.start+w.end)/2<clip.end).map(w=>({...w,sourceStart:clip.sourceStart+(Math.max(w.start,clip.start)-clip.start)*rate,sourceEnd:clip.sourceStart+(Math.min(w.end,clip.end)-clip.start)*rate,start:Math.max(w.start,clip.start),end:Math.min(w.end,clip.end)}));
          return words.length?[{...caption,id:uid(),ownerClipId:clip.id,ownerClipType:clip.ownerClipType,sourceMediaId:sourcePath,start:words[0].start,end:words.at(-1).end,sourceStart:words[0].sourceStart,sourceEnd:words.at(-1).sourceEnd,text:joinCaptionWords(words.map(w=>w.display)),words}]:[];
        }));
      }
      function createAutoCaptionContext() {
        return {
          projectId: state.projectId,
          sessionRevision: typeof currentProjectSessionRevision === "function" ? currentProjectSessionRevision() : 0,
          videoPath: autoCaptionSourcePath(),
          mediaSignature: autoCaptionMediaSignature(),
          timelineSignature: autoCaptionTimelineSignature(),
          transcriptSourcePath: autoCaptionSourcePath(),
          scriptText:$("scriptText")?.value || "",
          manuscriptLanguage:$("manuscriptLanguage")?.value || "",
        };
      }
      function bindMatchedReviewSources(reviews, clips = manuscriptSourceClips()) {
        const sourcePath=autoCaptionSourcePath();
        return (reviews || []).flatMap(review => {
          const words=review.words?.length ? review.words.map(w=>({...w,display:w.display || w.text})) : [];
          return clips.flatMap(clip=>{
            const start=Math.max(review.start,clip.start),end=Math.min(review.end,clip.end);
            if(end<=start)return [];
            const rate=(clip.sourceEnd-clip.sourceStart)/(clip.end-clip.start);
            const bound=words.filter(w=>w.start<end&&w.end>start).map(w=>({...w,start:Math.max(w.start,start),end:Math.min(w.end,end),sourceStart:clip.sourceStart+(Math.max(w.start,start)-clip.start)*rate,sourceEnd:clip.sourceStart+(Math.min(w.end,end)-clip.start)*rate}));
            return [{...review,id:uid(),issueId:review.issueId||review.id,ownerClipId:clip.id,ownerClipType:clip.ownerClipType,sourceMediaId:sourcePath,start,end,sourceStart:clip.sourceStart+(start-clip.start)*rate,sourceEnd:clip.sourceStart+(end-clip.start)*rate,words:bound,text:bound.length?joinCaptionWords(bound.map(w=>w.display)):review.text}];
          });
        });
      }
      function syncReviewIssueTimes() {
        for(const issue of [...(state.issues||[]),...(state.matchIssues||[])]){
          const reviews=(state.reviewCaptions||[]).filter(r=>(r.issueId||r.id)===issue.id);
          if(!reviews.length)continue;
          issue.start=Math.min(...reviews.map(r=>r.start));issue.end=Math.max(...reviews.map(r=>r.end));
          issue.words=reviews.flatMap(r=>r.words||[]);
        }
      }
      function captionWordPlacements(captions) {
        return (captions || []).flatMap(c => (c.words || []).map(w => ({...w,
          ownerClipId:c.ownerClipId || '',sourceMediaId:c.sourceMediaId || '',trackId:c.trackId || 'caption'})));
      }
      function sameCaptionWordPlacement(a,b) {
        if (a.ownerClipId && b.ownerClipId && a.ownerClipId !== b.ownerClipId &&
            !(/^[av]-/.test(a.ownerClipId) && /^[av]-/.test(b.ownerClipId))) return false;
        if (a.sourceMediaId && b.sourceMediaId && a.sourceMediaId !== b.sourceMediaId) return false;
        if ([a.sourceStart,a.sourceEnd,b.sourceStart,b.sourceEnd].every(Number.isFinite)) {
          const overlap=Math.min(a.sourceEnd,b.sourceEnd)-Math.max(a.sourceStart,b.sourceStart);
          return overlap>Math.max(.005,Math.min(a.sourceEnd-a.sourceStart,b.sourceEnd-b.sourceStart)*.5);
        }
        const overlap = Math.min(a.end,b.end)-Math.max(a.start,b.start);
        const span = Math.min(a.end-a.start,b.end-b.start);
        if (!(overlap > Math.max(.005,span*.5))) return false;
        if ([a.sourceStart,a.sourceEnd,b.sourceStart,b.sourceEnd].every(Number.isFinite) &&
            Math.min(a.sourceEnd,b.sourceEnd)-Math.max(a.sourceStart,b.sourceStart)<=.005) return false;
        return true;
      }
      function reconcileCaptionAdditions(generated, existing, previousBaseline = [], previousEditBaseline = [], deletedSources = []) {
        const current = captionWordPlacements(existing), seen = [], resolvedIssueIds = new Set();
        const baseline = existing.length ? previousBaseline.map(w=>({...w})) : [];
        const editBaseline=existing.length ? previousEditBaseline.map(w=>({...w})) : [];
        const decisions=[];
        const captions = generated.flatMap(c => {
          const words = (c.words || []).filter(w => {
            if(deletedSources.some(old=>old.sourceMediaId===c.sourceMediaId && (!old.ownerClipId || old.ownerClipId===c.ownerClipId || old.mainSource && /^[av]-/.test(c.ownerClipId || '')) && Number(w.sourceStart)<old.sourceEnd && Number(w.sourceEnd)>old.sourceStart))return false;
            const candidate={...w,ownerClipId:c.ownerClipId||'',sourceMediaId:c.sourceMediaId||''};
            const priorWord=editBaseline.find(old=>sameCaptionWordPlacement(old,candidate));
            const edited=current.find(old=>sameCaptionWordPlacement(old,candidate)&&(old.userKept||old.matchType==='edited'||old.issueType==='edited-timing'));
            const liveWord=current.find(old=>sameCaptionWordPlacement(old,candidate));
            if(!priorWord)editBaseline.push(candidate);
            if(priorWord&&!liveWord){decisions.push({start:w.start,end:w.end,issueId:w.issueId});return false;}
            if(edited){
              decisions.push({start:w.start,end:w.end,issueId:w.issueId});
              const rate=(c.sourceEnd-c.sourceStart)/(c.end-c.start);
              const start=Number.isFinite(edited.sourceStart)&&Number.isFinite(rate)&&rate>0?c.start+(edited.sourceStart-c.sourceStart)/rate:w.start;
              const end=Number.isFinite(edited.sourceEnd)&&Number.isFinite(rate)&&rate>0?c.start+(edited.sourceEnd-c.sourceStart)/rate:w.end;
              Object.assign(w,{...edited,start,end,issueType:'',issueId:'',action:'',userKept:true});
              return true;
            }
            if (w.issueType !== 'addition') return true;
            const placed = {...w,ownerClipId:c.ownerClipId || '',sourceMediaId:c.sourceMediaId || ''};
            if (seen.some(old=>sameCaptionWordPlacement(old,placed) && !captionTextDiffers(old.display,w.display))) return false;
            seen.push(placed);
            const prior = baseline.find(old=>sameCaptionWordPlacement(old,placed) && !captionTextDiffers(old.display,w.display));
            const live = current.find(old=>sameCaptionWordPlacement(old,placed) &&
              (!captionTextDiffers(old.display,w.display) || old.matchType==='edited' || old.issueType==='edited-timing' ||
                (old.userKept && !captionTextDiffers(old.originalDisplay || old.display,w.display))));
            if (!prior) baseline.push(placed);
            if (prior && !live) {resolvedIssueIds.add(w.issueId);return false;}
            if (live && (live.userKept || live.matchType==='edited' || live.issueType==='edited-timing' || (prior && !live.issueType))) {
              resolvedIssueIds.add(w.issueId);
              w.originalDisplay ||= w.display;
              w.display=live.display;w.matchType=live.matchType || 'match';w.userKept=true;w.issueType='';w.issueId='';w.action='';
            }
            return true;
          });
          for(const edited of current.filter(old=>(old.userKept||old.matchType==='edited'||old.issueType==='edited-timing')&&
            (old.ownerClipId===c.ownerClipId || /^[av]-/.test(old.ownerClipId||'') && /^[av]-/.test(c.ownerClipId||''))&&old.sourceMediaId===c.sourceMediaId)){
            if(!Number.isFinite(edited.sourceStart)||!Number.isFinite(edited.sourceEnd)||edited.sourceStart<c.sourceStart-.001||edited.sourceEnd>c.sourceEnd+.001)continue;
            if(words.some(w=>w.userKept&&Math.abs(w.sourceStart-edited.sourceStart)<.001&&Math.abs(w.sourceEnd-edited.sourceEnd)<.001&&w.display===edited.display))continue;
            const rate=(c.sourceEnd-c.sourceStart)/(c.end-c.start);
            const overlaps=(c.words||[]).filter(w=>w.sourceStart<edited.sourceEnd&&w.sourceEnd>edited.sourceStart);
            for(const w of overlaps)decisions.push({issueId:w.issueId});
            words.push({...edited,start:c.start+(edited.sourceStart-c.sourceStart)/rate,end:c.start+(edited.sourceEnd-c.sourceStart)/rate,issueType:'',issueId:'',action:'',userKept:true});
          }
          if (!words.length) return [];
          words.sort((a,b)=>a.start-b.start||a.end-b.end);
          const text=joinCaptionWords(words.map(w=>w.display));
          const history=existing.filter(old=>old.ownerClipId===c.ownerClipId && old.sourceMediaId===c.sourceMediaId &&
            Math.min(old.end,c.end)-Math.max(old.start,c.start)>.005).flatMap(old=>old.textChanges || []);
          return [{...c,start:words[0].start,end:words.at(-1).end,words,text,
            ...(history.length?{textChanges:history.map(change=>({...change})),textAuditBaseline:text}:{})}];
        });
        for(const issueId of decisions.map(d=>d.issueId).filter(Boolean)){
          if(!captions.some(c=>(c.words||[]).some(w=>w.issueId===issueId)))resolvedIssueIds.add(issueId);
        }
        return {captions,baseline,editBaseline,resolvedIssueIds};
      }
      function assertAutoCaptionContext(context) {
        const currentSession = typeof currentProjectSessionRevision === "function" ? currentProjectSessionRevision() : 0;
        if (state.projectId !== context.projectId || currentSession !== context.sessionRevision ||
            autoCaptionMediaSignature() !== context.mediaSignature ||
            autoCaptionTimelineSignature() !== context.timelineSignature ||
            autoCaptionSourcePath() !== context.transcriptSourcePath ||
            ($("scriptText")?.value || "") !== context.scriptText ||
            ($("manuscriptLanguage")?.value || "") !== context.manuscriptLanguage)
          throw new Error("工程、源素材或时间线已经变化，旧转录结果已安全丢弃");
      }
      function locallyRetimeEditedCaptionWords(existing, tokens, caption) {
        const sourceFields = (a,b) => {
          const owner=[...(state.audioAssets || []),...(state.videoLayers || [])].find(item=>item.id===caption.ownerClipId);
          if (owner) {
            const rate=(Number(owner.sourceEnd)-Number(owner.sourceStart))/(Number(owner.end)-Number(owner.start));
            if (Number.isFinite(rate) && rate>0 && a>=owner.start-1e-7 && b<=owner.end+1e-7)
              return {sourceStart:Number(owner.sourceStart)+(a-owner.start)*rate,sourceEnd:Number(owner.sourceStart)+(b-owner.start)*rate};
            return {};
          }
          const sourceStart=timelineToSource(a),sourceEnd=timelineToSource(b);
          return Number.isFinite(sourceStart)&&sourceEnd>sourceStart?{sourceStart,sourceEnd}:{};
        };
        const old = Array.isArray(existing) ? existing : [];
        if (!tokens.length) return [];
        const start = Number(caption.start || 0), end = Math.max(start + .04, Number(caption.end || start));
        if (!old.length) return tokens.map((display, index) => {
          const a = start + (end-start)*index/tokens.length, b = start + (end-start)*(index+1)/tokens.length;
          return { display, start:a, end:b, ...sourceFields(a,b), matchType:"edited", issueType:"edited-timing" };
        });
        let prefix=0;
        while (prefix < old.length && prefix < tokens.length && String(old[prefix].display||"").trim() === String(tokens[prefix]||"").trim()) prefix++;
        let suffix=0;
        while (suffix < old.length-prefix && suffix < tokens.length-prefix &&
          String(old[old.length-1-suffix].display||"").trim() === String(tokens[tokens.length-1-suffix]||"").trim()) suffix++;
        const result=[];
        for (let i=0;i<prefix;i++) result.push({ ...old[i], display:tokens[i] });
        const midTokens=tokens.slice(prefix, tokens.length-suffix);
        const leftBoundary = prefix ? Number(old[prefix-1].end) : start;
        const rightBoundary = suffix ? Number(old[old.length-suffix].start) : end;
        const span=Math.max(.01,rightBoundary-leftBoundary);
        for (let i=0;i<midTokens.length;i++) {
          const a=leftBoundary+span*i/Math.max(1,midTokens.length), b=leftBoundary+span*(i+1)/Math.max(1,midTokens.length);
          result.push({ display:midTokens[i], start:a, end:b, ...sourceFields(a,b), matchType:"edited", issueType:"edited-timing" });
        }
        for (let i=old.length-suffix;i<old.length;i++) {
          const tokenIndex=tokens.length-(old.length-i);
          result.push({ ...old[i], display:tokens[tokenIndex] });
        }
        return result;
      }
      function mapTranscribedCaptionsToTimeline(captions = []) {
        const sourcePath=autoCaptionSourcePath();
        const audioClips=[...mainAudioClips(),...(state.audioAssets||[]).filter(c=>c.path===sourcePath||c.sourceMediaId===sourcePath)];
        const ownerClipType=audioClips.length?'audio':'video';
        const clips=(audioClips.length?audioClips:[...mainClips(),...(state.videoLayers||[]).filter(c=>c.path===sourcePath||c.sourceMediaId===sourcePath)]).map(c=>({...c,sourceEnd:Number(c.sourceEnd??(Number(c.sourceStart||0)+(c.end-c.start)*Number(state.audio.speed||1)))}));
        const mapped=[],droppedWords=[];
        for(const caption of captions){
          const used=new Set();
          for(const clip of clips){
            const rate=(clip.sourceEnd-clip.sourceStart)/(clip.end-clip.start);if(!(rate>0))continue;
            const sourceToClipTimeline=t=>clip.start+(t-clip.sourceStart)/rate;
            const words=(caption.words||[]).flatMap((word,index)=>{
              const from=Math.max(Number(word.start||0),clip.sourceStart),to=Math.min(Number(word.end||0),clip.sourceEnd);
              if(to<=from+.001)return [];used.add(index);
              return [{...word,start:sourceToClipTimeline(from),end:sourceToClipTimeline(to),sourceStart:from,sourceEnd:to}];
            });
            if(words.length)mapped.push({...caption,id:uid(),ownerClipId:clip.id,ownerClipType,sourceMediaId:sourcePath,start:words[0].start,end:words.at(-1).end,sourceStart:words[0].sourceStart,sourceEnd:words.at(-1).sourceEnd,text:joinCaptionWords(words.map(w=>w.display)),words,timingReliable:caption.timingReliable!==false});
          }
          (caption.words||[]).forEach((word,i)=>{if(!used.has(i))droppedWords.push({...word,reason:'source-cut'});});
        }
        mapped.sort((a,b)=>a.start-b.start);mapped.droppedWords=droppedWords;return mapped;
      }
      function renderAutoTranscript() {
        renderRecognizedCopy();
        const panel = $("autoTranscript"), list = $("autoTranscriptList");
        if (!panel || !list) return;
        const transcript = state.autoTranscript || {};
        const captionIds = new Set(Array.isArray(transcript.captionIds) ? transcript.captionIds : []);
        let captions = transcript.id
          ? state.captions.filter((caption) => caption.transcriptId === transcript.id)
          : [];
        if (!captions.length && captionIds.size)
          captions = state.captions.filter((caption) => captionIds.has(caption.id));
        // Compatibility for projects saved before transcript/caption IDs were
        // persisted. Track lookup is only a fallback because dynamic track IDs
        // can be rebuilt during load or regrouping.
        if (!captions.length && transcript.trackId)
          captions = state.captions.filter((caption) => (caption.trackId || "caption") === transcript.trackId);
        // Upgrade a legacy track-only transcript in memory so every textarea
        // immediately has a stable editable target after an older project is
        // opened. The upgraded identity is persisted by the normal autosave.
        if (captions.length && !captionIds.size && !transcript.id) {
          const binding = bindGeneratedTranscript(captions, transcript.trackId || captions[0]?.trackId || "caption");
          state.autoTranscript = { ...transcript, ...binding };
        }
        if (captions.length && state.autoTranscript) {
          for (const caption of captions) caption.transcriptId ||= state.autoTranscript.id;
          state.autoTranscript.captionIds = captions.map(caption => caption.id);
        }
        captions.sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
        panel.hidden = !captions.length;
        if (!captions.length) return;
        $("autoTranscriptCount").textContent = `${captions.length} 段 CC`;
        list.innerHTML = captions.map((caption, index) =>
          `<div class="auto-transcript-row ${state.selected.type === "caption" && state.selected.id === caption.id ? "active" : ""}" data-auto-caption-row="${escapeHtml(caption.id)}">
          <button class="auto-transcript-time" type="button" data-auto-caption-seek="${Number(caption.start) || 0}" title="跳到这句">${formatTime(caption.start, false)}</button>
            <textarea class="auto-transcript-edit" data-auto-caption-edit="${escapeHtml(caption.id)}" aria-label="转录第 ${index + 1} 段">${escapeHtml(caption.text || "")}</textarea>
            ${renderCaptionReferenceChanges(caption)}
            ${captionMismatchReviewGroups(caption).map(group => `<div class="auto-transcript-mismatch small status"><span>${escapeHtml(group.spokenText)}（识别文案） → ${escapeHtml(group.expectedText)}（正确文案）</span></div>`).join("")}
          </div>`).join("");
        requestAnimationFrame(() => list.querySelectorAll("textarea").forEach(fitCaptionTextarea));
      }
      function replaceAutoCaptionMismatch(captionId, wordIndex) {
        const caption = state.captions.find(item => item.id === captionId);
        const word = caption?.words?.[wordIndex];
        if (!Number.isInteger(wordIndex) || !word || word.issueType !== "mismatch" || !word.expectedDisplay) return false;
        const tokens = editableCaptionTokens(String(word.expectedDisplay));
        if (!tokens.length) return false;
        snapshot();
        const replacements = tokens.map((display, index) => {
          const replacement = { ...word, display, matchType: "edited" };
          replacement.referenceExpected = word.expectedDisplay;
          replacement.recognizedDisplay = word.originalDisplay || word.display;
          delete replacement.issueType;
          delete replacement.expectedDisplay;
          replacement.issueId = '';
          replacement.action = '';
          replacement.autoCorrected = false;
          replacement.userKept = true;
          if (tokens.length > 1) {
            for (const [startKey, endKey] of [["start", "end"], ["sourceStart", "sourceEnd"]]) {
              if (!Number.isFinite(Number(word[startKey])) || !Number.isFinite(Number(word[endKey]))) continue;
              const start = Number(word[startKey]), span = Number(word[endKey]) - start;
              replacement[startKey] = start + span * index / tokens.length;
              replacement[endKey] = start + span * (index + 1) / tokens.length;
            }
            replacement.issueType = "edited-timing";
          }
          return replacement;
        });
        caption.words.splice(wordIndex, 1, ...replacements);
        // Confirming an already displayed correction must also resolve its mark.
        const issueId = word.issueId;
        if (issueId && !state.captions.some(c => c.words?.some(w => w.issueId === issueId && w.issueType === 'mismatch'))) {
          state.reviewCaptions = state.reviewCaptions.filter(r => (r.issueId || r.id) !== issueId);
          state.issues = state.issues.filter(r => r.id !== issueId);
          state.matchIssues = (state.matchIssues || []).filter(r => r.id !== issueId);
        }
        caption.text = joinCaptionWords(caption.words.map(item => item.display));
        if (tokens.length > 1) caption.timingReliable = "partial";
        state.captionRecoveryArchive = (state.captionRecoveryArchive || []).filter(record => record?.caption?.id !== caption.id);
        captionInspectorKey = "";
        renderCaptionInspector(true);
        renderTimeline();
        renderPreviewObjects();
        renderAutoTranscript();
        queueAutosave();
        return true;
      }
      function bindGeneratedTranscript(captions, trackId) {
        const transcriptId = `transcript-${uid()}`;
        for (const caption of captions || []) {
          caption.id ||= uid();
          caption.trackId = trackId;
          caption.transcriptId = transcriptId;
        }
        return {
          id: transcriptId,
          captionIds: (captions || []).map((caption) => caption.id),
        };
      }
      function focusAutoTranscript(id, scroll = true) {
        const list = $("autoTranscriptList");
        if (!list) return;
        list.querySelectorAll("[data-auto-caption-row]").forEach((row) =>
          row.classList.toggle("active", !!id && row.dataset.autoCaptionRow === id));
        if (!id || !scroll) return;
        const row = [...list.querySelectorAll("[data-auto-caption-row]")]
          .find((item) => item.dataset.autoCaptionRow === id);
        if (row) requestAnimationFrame(() => row.scrollIntoView({ block: "nearest", behavior: "auto" }));
      }
      function addGeneratedCaptionReviews(result, trackId, transcriptId, resolvedIssueIds = new Set()) {
            for (const review of result.reviewCaptions || []) {
              if (resolvedIssueIds.has(review.issueId || review.id)) continue;
              const reviewWords=review.words?.length?review.words:[{display:review.expectedText||review.text||"需补录",start:review.start,end:review.end}];
              const mapped = result.timelinePlaced ? bindMatchedReviewSources([{...review,words:reviewWords}],manuscriptSourceClips()) : mapTranscribedCaptionsToTimeline([{...review,words:reviewWords}]);
              for (const part of mapped) {
                const alreadyKept=review.type==='unverifiedAddition'&&(part.words||[]).length&&(part.words||[]).every(candidate=>(state.captions||[]).some(caption=>
                  caption.transcriptId===transcriptId&&(!part.ownerClipId||caption.ownerClipId===part.ownerClipId)&&
                  (caption.words||[]).some(word=>word.userKept&&(word.matchType==='spoken_addition'||word.matchType==='edited'||word.issueType==='edited-timing'||word.issueType==='addition')&&
                    Math.max(0,Math.min(Number(word.end),Number(candidate.end))-Math.max(Number(word.start),Number(candidate.start)))/
                    Math.max(.01,Math.min(Number(word.end)-Number(word.start),Number(candidate.end)-Number(candidate.start)))>=.5)));
                if(alreadyKept)continue;
                const id = uid();
                const pending = {...review,...part,id,issueId:id,captionTrackId:trackId,transcriptId:transcriptId || ""};
                for (const caption of state.captions.filter(c=>c.transcriptId===transcriptId && c.ownerClipId===part.ownerClipId)) {
                  for (const word of caption.words || []) if (word.issueId === (review.issueId || review.id) &&
                    word.start < part.end && word.end > part.start) word.issueId=id;
                }
                state.reviewCaptions.push(pending);
                state.issues.push({...pending,trackId:"review"});
              }
            }
      }
      async function generateAutoCaptions({forceRecognition = false} = {}) {
        if (!autoCaptionSourcePath()) return toast("请先导入视频或音频");
        if (state.autoTranscript?.trackId && isTrackLocked(state.autoTranscript.trackId))
          return toast("CC 字幕轨道已锁定，请先解锁再重新识别");
        const proofread=$("ccProofread").checked;
        const correctScript=String($("scriptText")?.value||"").trim();
        if(proofread&&!correctScript)return toast("请填写正确文案，或取消勾选以直接识别音频");
        const button = $("generateAutoCaptions"), progress = $("autoCaptionProgress"), status = $("autoCaptionStatus");
        button.disabled = true;
        button.textContent = "正在提取语音…";
        progress.hidden = false;
        progress.firstElementChild.style.width = "2%";
        try {
          const context = createAutoCaptionContext();
          const model = unwrap(await window.native.modelStatus());
          assertAutoCaptionContext(context);
          if (!model.ready && !model.installed) {
            status.textContent='请先配置当前选择的听写引擎，与匹配文案使用相同设置';
            toast(status.textContent);return;
          }
          const started = unwrap(await window.native.startAutoCaptionAnalysis({
            inputPath: autoCaptionSourcePath(),
            duration: manuscriptSourceDuration() || state.sourceDuration || state.duration,
            captionLines: state.captionLines,
            script: correctScript,
            scriptLanguage: $("manuscriptLanguage")?.value || "",
            proofread,
            forceRecognition,
            sourceClips:manuscriptSourceClips(),
          }));
          autoCaptionJobId = started.jobId;
          while (autoCaptionJobId) {
            await new Promise((resolve) => setTimeout(resolve, 550));
            const current = unwrap(await window.native.autoCaptionAnalysisStatus(autoCaptionJobId));
            assertAutoCaptionContext(context);
            const percent = Math.max(2, Math.round(Number(current.progress || 0) * 100));
            progress.firstElementChild.style.width = `${percent}%`;
            status.textContent = current.state === "extracting" ? "正在提取音频…" : current.state === "transcribing" ? `${model.name || '所选听写引擎'} 正在转录… ${percent}%` : "正在生成 CC 字幕轨道…";
            if (current.state === "failed") throw new Error(current.error || "自动字幕生成失败");
            if (current.state === "cancelled") throw new Error("自动字幕已取消");
            if (current.state !== "completed") continue;
            snapshot();
            const timelineCaptions = current.result.timelinePlaced ? bindMatchedCaptionSources(current.result.captions || [],manuscriptSourceClips()) : mapTranscribedCaptionsToTimeline(current.result.captions || []);
            let generated = await applyCaptionGrouping(timelineCaptions, state.captionLines);
            const previous = state.autoTranscript;
            const replacePrevious = previous?.id && previous.sourcePath === context.transcriptSourcePath;
            const oldCaptions = replacePrevious ? state.captions.filter(caption => caption.transcriptId === previous.id ||
              (previous.captionIds || []).includes(caption.id)) : [];
            const deletedSources=oldCaptions.length ? previous?.deletedSources || [] : [];
            const reconciliation = reconcileCaptionAdditions(generated,oldCaptions,previous?.additionBaseline || [],previous?.editBaseline || [],deletedSources);
            generated = reconciliation.captions;
            if (replacePrevious) {
              const oldIds=new Set(oldCaptions.map(c=>c.id));
              state.captions = state.captions.filter(caption => !oldIds.has(caption.id));
              const oldWordIssues=new Set(oldCaptions.flatMap(c=>(c.words || []).map(w=>w.issueId).filter(Boolean)));
              const oldReviews = new Set(state.reviewCaptions.filter(review => review.transcriptId === previous.id ||
                oldWordIssues.has(review.issueId || review.id)).map(review => review.issueId || review.id));
              state.reviewCaptions = state.reviewCaptions.filter(review => !oldReviews.has(review.issueId || review.id));
              state.issues = state.issues.filter(issue => !oldReviews.has(issue.id));
              state.matchIssues = (state.matchIssues || []).filter(issue => !oldReviews.has(issue.id));
            }
            const defaultTrackOccupied = state.captions.some((caption) => !caption.trackId || caption.trackId === "caption");
            const trackId = replacePrevious ? previous.trackId || "caption" : defaultTrackOccupied
              ? createDynamicTrack("caption", "转录 CC 字幕", "caption")
              : "caption";
            const transcriptBinding = bindGeneratedTranscript(generated, trackId);
            state.captions.push(...generated);
            addGeneratedCaptionReviews(current.result, trackId, transcriptBinding.id,reconciliation.resolvedIssueIds);
            state.recognizedText = current.result.recognizedTranscript || current.result.transcript || ""; state.recognizedTextCleared = false;
            state.autoTranscript = {
              ...transcriptBinding,
              deletedSources,
              additionBaseline:reconciliation.baseline,
              editBaseline:reconciliation.editBaseline,
              text: current.result.transcript || "",
              engine: current.result.engine || "deepgram",
              model: current.result.model || "nova-3",
              trackId,
              scriptAssisted: Boolean(current.result.scriptAssisted),
              panelOpen: true,
              sourceSegments:current.result.sourceSegments || [],
              sourcePath: context.transcriptSourcePath,
              mediaSignature: context.mediaSignature,
              timelineSignature: context.timelineSignature,
              sourceWasDenoised: context.transcriptSourcePath !== context.videoPath,
            };
            clampTracksToDuration();
            captionInspectorKey = "";
            renderAll();
            renderAutoTranscript();
            const pendingCount = (current.result.reviewCaptions || []).length;
            status.textContent = pendingCount
              ? `已按正确文案生成 ${generated.length} 段字幕；${pendingCount} 处需要试听确认，文案外词未自动加入字幕。`
              : defaultTrackOccupied
              ? `正确文案字幕轨道已有内容；已新建字幕轨道并生成 ${generated.length} 段。`
              : `已在“正确文案字幕”轨道生成 ${generated.length} 段。`;
            toast(pendingCount ? status.textContent : defaultTrackOccupied
              ? `已在新轨道生成 ${generated.length} 段 CC 字幕`
              : `已在正确文案字幕轨道生成 ${generated.length} 段 CC 字幕`);
            autoCaptionJobId = "";
            queueAutosave();
          }
        } catch (error) {
          if (autoCaptionJobId) window.native.cancelAutoCaptionAnalysis(autoCaptionJobId).catch(() => {});
          status.textContent = error.message;
          toast(error.message);
          autoCaptionJobId = "";
        } finally {
          button.disabled = false;
          button.textContent = "CC 语音字幕识别";
          progress.hidden = true;
        }
      }
      async function forceAlignScriptCaptions() {
        if (!autoCaptionSourcePath()) return toast("请先导入视频或音频");
        const script = String($("scriptText")?.value || "").trim();
        if (!script) return toast("请先粘贴正确文案");
        const model = unwrap(await window.native.modelStatus());
        if (!model.ready && !model.installed) {
          toast("请先配置当前选择的听写引擎，与匹配文案使用相同设置");
          return;
        }
        const button = $("forceAlignScript");
        const progress = $("modelProgress");
        button.disabled = true;
        button.textContent = "对齐中…";
        progress.style.display = "block";
        progress.firstElementChild.style.width = "2%";
        let jobId = "";
        try {
          const context = createAutoCaptionContext();
          const started = unwrap(await window.native.startAutoCaptionAnalysis({
            inputPath: autoCaptionSourcePath(),
            duration: manuscriptSourceDuration() || state.sourceDuration || state.duration,
            captionLines: state.captionLines,
            script,
            scriptLanguage: $("manuscriptLanguage")?.value || "en",
            forcedAlignment: true,
          }));
          jobId = started.jobId;
          while (jobId) {
            await new Promise((resolve) => setTimeout(resolve, 550));
            const current = unwrap(await window.native.autoCaptionAnalysisStatus(jobId));
            assertAutoCaptionContext(context);
            progress.firstElementChild.style.width = `${Math.max(2, Math.round(Number(current.progress || 0) * 100))}%`;
            if (current.state === "failed") throw new Error(current.error || "强制对齐失败");
            if (current.state === "cancelled") throw new Error("强制对齐已取消");
            if (current.state !== "completed") continue;
            snapshot();
            const timelineCaptions = mapTranscribedCaptionsToTimeline(current.result.captions || []);
            const generated = await applyCaptionGrouping(timelineCaptions, state.captionLines);
            const trackId = createDynamicTrack("caption", "强制对齐字幕", "caption");
            const transcriptBinding = bindGeneratedTranscript(generated, trackId);
            state.captions.push(...generated);
            addGeneratedCaptionReviews(current.result, trackId, transcriptBinding.id);
            state.recognizedText = current.result.transcript || ""; state.recognizedTextCleared = false;
            state.autoTranscript = {
              ...transcriptBinding,
              text: current.result.transcript || script,
              engine: current.result.engine || "deepgram",
              model: current.result.model || "nova-3",
              trackId,
              scriptAssisted: true,
              forcedAlignment: true,
              panelOpen: true,
              sourcePath: context.transcriptSourcePath,
              mediaSignature: context.mediaSignature,
              timelineSignature: context.timelineSignature,
              sourceWasDenoised: context.transcriptSourcePath !== context.videoPath,
            };
            clampTracksToDuration();
            captionInspectorKey = "";
            renderAll();
            renderAutoTranscript();
            const cutWords = timelineCaptions.droppedWords || [];
            if (cutWords.length) {
              const preview = cutWords.slice(0, 8).map((word) => word.display).join(" ");
              toast(`已生成 ${generated.length} 段；${cutWords.length} 个词对应的音频已被裁掉：${preview}${cutWords.length > 8 ? "…" : ""}`);
            } else {
              toast(`音素级对齐完成，已新建“强制对齐字幕”轨道，共 ${generated.length} 段`);
            }
            jobId = "";
          }
        } catch (error) {
          if (jobId) window.native.cancelAutoCaptionAnalysis(jobId).catch(() => {});
          toast(error.message);
        } finally {
          button.disabled = false;
          button.textContent = "强制对齐";
          progress.style.display = "none";
        }
      }
      if ($("generateAutoCaptions")) $("generateAutoCaptions").onclick = event=>generateAutoCaptions({forceRecognition:event.shiftKey});
      if ($("forceAlignScript")) $("forceAlignScript").onclick = forceAlignScriptCaptions;
      if ($("pasteAutoCaptionScript")) $("pasteAutoCaptionScript").onclick = async () => {
        try { $("autoCaptionScript").value = await navigator.clipboard.readText(); queueAutosave(); }
        catch { toast("无法读取剪贴板，请手动粘贴"); }
      };
      if ($("clearAutoCaptionScript")) $("clearAutoCaptionScript").onclick = () => { $("autoCaptionScript").value = ""; queueAutosave(); };
      $("autoCaptionScript")?.addEventListener("input", queueAutosave);
      if ($("autoTranscriptList")) {
        $("autoTranscriptList").onclick = (event) => {
          if (event.target.closest?.('[data-reference-choice]')) return;
          if (event.target.closest?.("textarea")) return;
          const row = event.target.closest?.("[data-auto-caption-row]");
          if (!row) return;
          const replace = event.target.closest?.("[data-auto-caption-replace]");
          if (replace) {
            replaceAutoCaptionMismatch(row.dataset.autoCaptionRow, Number(replace.dataset.autoCaptionReplace));
            return;
          }
          const target = row.querySelector("[data-auto-caption-seek]");
          const id = row?.dataset.autoCaptionRow || "";
          if (id) selectItem("caption", id);
          seekTimeline(Number(target.dataset.autoCaptionSeek || 0));
          keepPlayheadInView("center");
          renderAll();
          renderAutoTranscript();
        };
        $("autoTranscriptList").oninput = (event) => {
          const target = event.target.closest?.("[data-auto-caption-edit]");
          if (!target) return;
          const caption = state.captions.find((item) => item.id === target.dataset.autoCaptionEdit);
          if (!caption) return;
          state.captionRecoveryArchive = (state.captionRecoveryArchive || []).filter((record) => record?.caption?.id !== caption.id);
          fitCaptionTextarea(target);
          const tokens = editableCaptionTokens(target.value);
          const existing = caption.words || [];
          recordCaptionTextChange(caption, caption.text || '', target.value);
          caption.text = target.value;
          if (tokens.length === existing.length) {
            caption.words = existing.map((word, index) => ({ ...word, display: tokens[index],
              ...(word.display!==tokens[index]?{originalDisplay:word.originalDisplay || word.display,userKept:true,matchType:'edited',issueType:'',issueId:'',action:''}:{}) }));
          } else {
            caption.words = locallyRetimeEditedCaptionWords(existing, tokens, caption);
            // Unchanged prefix/suffix keep their original timing. Only the edited span is interpolated.
            caption.timingReliable = caption.words.some((word) => word.issueType === "edited-timing") ? "partial" : caption.timingReliable;
          }
          if (caption.words.length) {
            caption.start = Number(caption.words[0].start);
            caption.end = Number(caption.words.at(-1).end);
            caption.sourceStart = Number(caption.words[0].sourceStart);
            caption.sourceEnd = Number(caption.words.at(-1).sourceEnd);
          }
          captionInspectorKey = "";
          renderCaptionInspector(true);
          renderTimeline();
          renderPreviewObjects();
          const row = target.closest('[data-auto-caption-row]');
          row?.querySelectorAll('.caption-mismatch-suggestion').forEach(node => node.remove());
          if (row) row.insertAdjacentHTML('beforeend', renderCaptionReferenceChanges(caption));
          queueAutosave();
        };
      }
      if (typeof document !== 'undefined') document.addEventListener('click', handleCaptionReferenceChoice);
      renderAutoTranscript();
