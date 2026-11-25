function baseMainClips() {
        return editSourceClips(state.sourceDuration,state.removals,state.manualCuts,state.audio.speed);
      }
      function mainClips() {
        const globalOffset = Math.max(0, Number(state.mainTimelineOffset || 0));
        return baseMainClips().map((clip) => {
          const offset = Number(state.mainVideoClipOffsets?.[clip.id] || 0);
          return {
            ...clip,
            start: Math.max(0, clip.start + globalOffset + offset),
            end: Math.max(0, clip.end + globalOffset + offset),
          };
        }).sort((a, b) => a.start - b.start);
      }
      function bestClipOverlap(clips, start, end, axis = "timeline") {
        const fromKey = axis === "source" ? "sourceStart" : "start";
        const toKey = axis === "source" ? "sourceEnd" : "end";
        let best = null, bestOverlap = 0;
        for (const clip of clips || []) {
          const overlap = Math.max(0, Math.min(end, Number(clip[toKey])) - Math.max(start, Number(clip[fromKey])));
          if (overlap > bestOverlap) { best = clip; bestOverlap = overlap; }
        }
        return best ? { clip: best, overlap: bestOverlap } : null;
      }
      function timelineRangeToSource(start, end, clips = mainClips()) {
        const hit = bestClipOverlap(clips, start, end, "timeline");
        if (!hit?.clip || hit.overlap <= 0.0005) return null;
        const clip = hit.clip;
        const timelineSpan = Math.max(0.001, Number(clip.end) - Number(clip.start));
        const sourceSpan = Math.max(0.001, Number(clip.sourceEnd) - Number(clip.sourceStart));
        const convert = (time) => Number(clip.sourceStart) +
          ((Math.max(Number(clip.start), Math.min(Number(clip.end), time)) - Number(clip.start)) / timelineSpan) * sourceSpan;
        return { start: convert(Math.max(start, Number(clip.start))), end: convert(Math.min(end, Number(clip.end))) };
      }
      function sourceRangeToTimeline(start, end, clips = mainClips()) {
        const hit = bestClipOverlap(clips, start, end, "source");
        if (!hit?.clip || hit.overlap <= 0.0005) return null;
        const clip = hit.clip;
        const sourceSpan = Math.max(0.001, Number(clip.sourceEnd) - Number(clip.sourceStart));
        const timelineSpan = Math.max(0.001, Number(clip.end) - Number(clip.start));
        const convert = (time) => Number(clip.start) +
          ((Math.max(Number(clip.sourceStart), Math.min(Number(clip.sourceEnd), time)) - Number(clip.sourceStart)) / sourceSpan) * timelineSpan;
        return { start: convert(Math.max(start, Number(clip.sourceStart))), end: convert(Math.min(end, Number(clip.sourceEnd))) };
      }
      function anchorCaptionsToSource(previousClips = mainClips()) {
        for (const caption of state.captions || []) {
          if(!caption.ownerClipId){const hit=bestClipOverlap(previousClips,caption.start,caption.end);if(hit)caption.ownerClipId=hit.clip.id;}
          if (Array.isArray(caption.words) && caption.words.length) {
            for (const word of caption.words) {
              if (Number.isFinite(Number(word.sourceStart)) && Number.isFinite(Number(word.sourceEnd))) continue;
              const source = timelineRangeToSource(Number(word.start || 0), Number(word.end || word.start || 0) + 0.001, previousClips);
              if (source) { word.sourceStart = source.start; word.sourceEnd = source.end; }
            }
          } else if (!Number.isFinite(Number(caption.sourceStart)) || !Number.isFinite(Number(caption.sourceEnd))) {
            const source = timelineRangeToSource(Number(caption.start || 0), Number(caption.end || caption.start || 0) + 0.001, previousClips);
            if (source) { caption.sourceStart = source.start; caption.sourceEnd = source.end; }
          }
        }
      }
      function remapCaptionsFromSource(nextClips = mainClips()) {
        let dropped = 0;
        const mapFor=(caption,start,end)=>{
          const audioOwner=['audio','audioasset'].includes(caption.ownerClipType);
          const main=audioOwner?mainAudioClips():nextClips;
          const mediaClips=[...main,...(audioOwner?state.audioAssets:state.videoLayers)];
          const owner=caption.ownerClipId&&mediaClips.find(c=>c.id===caption.ownerClipId);
          const legacyMainOwner=/^(?:main|[va]-)/.test(String(caption.ownerClipId||''));
          if(caption.ownerClipId&&!owner&&!legacyMainOwner)return null;
          const sourceMediaId=String(caption.sourceMediaId||'').trim();
          const available=mediaClips.filter(clip=>{
            const clipSource=String(clip.sourceMediaId||clip.path||state.video?.path||'').trim();
            return !sourceMediaId||!clipSource||clipSource===sourceMediaId;
          });
          const candidates=owner?[owner]:available;
          return sourceRangeToTimeline(start,end,candidates.map(clip=>({...clip,sourceEnd:Number(clip.sourceEnd??(Number(clip.sourceStart||0)+(clip.end-clip.start)*Number(state.audio.speed||1)))})));
        };
        const archived = Array.isArray(state.captionRecoveryArchive) ? state.captionRecoveryArchive : [];
        const working = new Map((state.captions || []).map((caption) => [caption.id, { ...caption, words: Array.isArray(caption.words) ? [...caption.words] : caption.words }]));
        for (const record of archived) {
          if (!record?.caption?.id) continue;
          const caption = working.get(record.caption.id) || { ...record.caption, words: [] };
          if (record.word) {
            caption.words ||= [];
            const key = `${Number(record.word.sourceStart).toFixed(5)}:${Number(record.word.sourceEnd).toFixed(5)}:${record.word.display || ""}`;
            if (!caption.words.some((word) => `${Number(word.sourceStart).toFixed(5)}:${Number(word.sourceEnd).toFixed(5)}:${word.display || ""}` === key)) caption.words.push({ ...record.word });
          }
          working.set(caption.id, caption);
        }
        const nextArchive = [];
        state.captions = [...working.values()].flatMap((caption) => {
          if(state.trackLocks?.[caption.trackId||"caption"]||state.trackSyncLocks?.[caption.trackId||"caption"]===false)return [caption];
          if (Array.isArray(caption.words) && caption.words.length) {
            const words = caption.words.flatMap((word) => {
              const sourceStart = Number(word.sourceStart), sourceEnd = Number(word.sourceEnd);
              if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd) || sourceEnd <= sourceStart) return [word];
              const mapped = mapFor(caption,sourceStart, Math.max(sourceStart + 0.001, sourceEnd));
              if (!mapped) {
                dropped += 1;
                nextArchive.push({ caption: { ...caption, words: [] }, word: { ...word } });
                return [];
              }
              return [{ ...word, start: mapped.start, end: Math.max(mapped.start + 0.001, mapped.end) }];
            }).sort((a, b) => Number(a.start) - Number(b.start));
            if (!words.length) return [];
            caption.words = words;
            caption.start = Number(words[0].start);
            caption.end = Math.max(caption.start + 0.04, Number(words.at(-1).end));
            caption.text = joinCaptionWords(words);
            return [caption];
          }
          const sourceStart = Number(caption.sourceStart), sourceEnd = Number(caption.sourceEnd);
          if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) return [caption];
          const mapped = mapFor(caption,sourceStart, Math.max(sourceStart + 0.001, sourceEnd));
          if (!mapped) {
            dropped += 1;
            nextArchive.push({ caption: { ...caption }, word: null });
            return [];
          }
          caption.start = mapped.start;
          caption.end = Math.max(mapped.start + 0.04, mapped.end);
          return [caption];
        });
        state.captionRecoveryArchive = nextArchive;
        // Loading an older edited project may still contain a review whose
        // source take no longer exists. Dismiss all linked copies before mapping.
        for (const review of [...(state.reviewCaptions || [])]) {
          if (!Number.isFinite(review.sourceStart) || !Number.isFinite(review.sourceEnd)) continue;
          if (mapFor(review, review.sourceStart, review.sourceEnd)) continue;
          if (typeof dismissTrimmedIssues === 'function')
            dismissTrimmedIssues(review.start, review.end, review.ownerClipId ? new Set([review.ownerClipId]) : null);
        }
        state.reviewCaptions = (state.reviewCaptions || []).flatMap(review=>{
          if(state.trackLocks?.[review.trackId||"caption"]||state.trackSyncLocks?.[review.trackId||"caption"]===false)return [review];
          if(!Number.isFinite(review.sourceStart)||!Number.isFinite(review.sourceEnd))return [review];
          const mapped=mapFor(review,review.sourceStart,review.sourceEnd);
          if(!mapped)return [];
          const words=(review.words||[]).flatMap(word=>{
            if(!Number.isFinite(word.sourceStart)||!Number.isFinite(word.sourceEnd))return [word];
            const range=mapFor(review,word.sourceStart,word.sourceEnd);
            return range?[{...word,start:range.start,end:range.end}]:[];
          });
          return [{...review,start:mapped.start,end:mapped.end,words,text:words.length?joinCaptionWords(words):review.text}];
        });
        if(typeof syncReviewIssueTimes==='function')syncReviewIssueTimes();
        captionInspectorKey = "";
        return dropped;
      }
      function captionSourceOwner(caption) {
        const ownerId = String(caption?.ownerClipId || "");
        const clips = [
          ...mainClips(),
          ...(state.avLinked ? [] : mainAudioClips()),
          ...(state.videoLayers || []),
          ...(state.audioAssets || []),
        ];
        return clips.find((clip) => String(clip.id || "") === ownerId) || null;
      }
      function captionSourceRate(caption) {
        const owner = captionSourceOwner(caption);
        const timelineSpan = Number(owner?.end) - Number(owner?.start);
        const sourceSpan = Number(owner?.sourceEnd) - Number(owner?.sourceStart);
        return timelineSpan > 0 && sourceSpan > 0 ? sourceSpan / timelineSpan : 1;
      }
      function shiftCaptionWordTimes(caption, delta) {
        if (!caption || !Array.isArray(caption.words) || !Number.isFinite(Number(delta))) return;
        const amount = Number(delta);
        const owner = captionSourceOwner(caption);
        const rate = captionSourceRate(caption);
        const sourceDelta = owner ? amount * rate : 0;
        const timelineSpan = Number(owner?.end) - Number(owner?.start);
        const sourceSpan = Number(owner?.sourceEnd) - Number(owner?.sourceStart);
        const sourceAt = (time) => timelineSpan > 0 && sourceSpan > 0
          ? Number(owner.sourceStart) + ((Number(time) - Number(owner.start)) / timelineSpan) * sourceSpan
          : Number.NaN;
        for (const word of caption.words) {
          let sourceStart = word.sourceStart != null ? Number(word.sourceStart) : sourceAt(word.start);
          let sourceEnd = word.sourceEnd != null ? Number(word.sourceEnd) : sourceAt(word.end);
          if (Number.isFinite(Number(word.start))) word.start = Number(word.start) + amount;
          if (Number.isFinite(Number(word.end))) word.end = Number(word.end) + amount;
          if (Number.isFinite(sourceStart)) word.sourceStart = sourceStart + sourceDelta;
          if (Number.isFinite(sourceEnd)) word.sourceEnd = sourceEnd + sourceDelta;
        }
        if (Number.isFinite(Number(caption.sourceStart))) caption.sourceStart = Number(caption.sourceStart) + sourceDelta;
        if (Number.isFinite(Number(caption.sourceEnd))) caption.sourceEnd = Number(caption.sourceEnd) + sourceDelta;
      }
      function clampCaptionWordsToBounds(caption) {
        if (!caption || !Array.isArray(caption.words) || !caption.words.length) return;
        const requestedStart = Number(caption.start || 0);
        const requestedEnd = Math.max(requestedStart + 0.001, Number(caption.end || requestedStart));
        const oldWords = caption.words;
        const retainedIndexes = [];
        const retained = oldWords.filter((word, index) => {
          const keep = Number(word.end) > requestedStart && Number(word.start) < requestedEnd;
          if (keep) retainedIndexes.push(index);
          return keep;
        });
        if (!retained.length) {
          caption.words = [];
          caption.text = "";
          caption.lineBreaks = [];
          caption.lineCount = 1;
          delete caption.sourceStart;
          delete caption.sourceEnd;
          return;
        }
        const owner = captionSourceOwner(caption);
        const timelineSpan = Number(owner?.end) - Number(owner?.start);
        const sourceSpan = Number(owner?.sourceEnd) - Number(owner?.sourceStart);
        if (timelineSpan > 0 && sourceSpan > 0) {
          const sourceAt = (time) => Number(owner.sourceStart) +
            ((Number(time) - Number(owner.start)) / timelineSpan) * sourceSpan;
          for (const word of retained) {
            if (word.sourceStart == null || !Number.isFinite(Number(word.sourceStart))) word.sourceStart = sourceAt(word.start);
            if (word.sourceEnd == null || !Number.isFinite(Number(word.sourceEnd))) word.sourceEnd = sourceAt(word.end);
          }
        }
        const oldBreaks = Array.isArray(caption.lineBreaks) ? caption.lineBreaks.map(Number) : [];
        caption.words = retained;
        caption.start = Number(retained[0].start);
        caption.end = Math.max(caption.start + 0.04, Number(retained.at(-1).end));
        caption.text = joinCaptionWords(retained);
        caption.lineBreaks = oldBreaks
          .map((breakIndex) => retainedIndexes.filter((index) => index < breakIndex).length)
          .filter((breakIndex, index, all) => breakIndex > 0 && breakIndex < caption.words.length && all.indexOf(breakIndex) === index);
        caption.lineCount = Math.max(1, caption.lineBreaks.length + 1);
        const first = retained[0], last = retained.at(-1);
        if (first.sourceStart != null && Number.isFinite(Number(first.sourceStart))) caption.sourceStart = Number(first.sourceStart);
        else delete caption.sourceStart;
        if (last.sourceEnd != null && Number.isFinite(Number(last.sourceEnd))) caption.sourceEnd = Number(last.sourceEnd);
        else delete caption.sourceEnd;
      }
      function mainContentEnd() {
        if (!state.video) return 0;
        const videoEnd = mainClips().reduce(
          (end, clip) => Math.max(end, clip.end),
          0,
        );
        if (state.avLinked) return videoEnd;
        return mainAudioClips().reduce(
          (end, clip) => Math.max(end, clip.end),
          videoEnd,
        );
      }
      function retimeTracksForSpeed(nextSpeed) {
        const previous = Math.max(0.05, Number(state.audio.speed || 1));
        const next = clamp(Number(nextSpeed || 1), 0.5, 2);
        if (Math.abs(previous - next) < 0.0001) return;
        const factor = previous / next;
        const captionSourceClips = mainClips();
        anchorCaptionsToSource(captionSourceClips);
        // Imported/manual captions placed in a deliberate timeline gap have no
        // source-media anchor. Keep their former proportional behaviour while
        // source-backed speech captions are remapped exactly below.
        for (const caption of state.captions || []) {
          if (Array.isArray(caption.words) && caption.words.length) {
            for (const word of caption.words) {
              if (Number.isFinite(Number(word.sourceStart)) && Number.isFinite(Number(word.sourceEnd))) continue;
              word.start = Number(word.start || 0) * factor;
              word.end = Number(word.end || 0) * factor;
            }
          } else if (!Number.isFinite(Number(caption.sourceStart)) || !Number.isFinite(Number(caption.sourceEnd))) {
            caption.start = Number(caption.start || 0) * factor;
            caption.end = Number(caption.end || 0) * factor;
          }
        }
        for (const list of [
          state.videoLayers,
          state.audioAssets,
          state.images,
          state.titles,
          state.reviewCaptions,
          state.issues,
          state.matchIssues,
          state.audioMutes,
        ])
          for (const item of list || []) {
            item.start *= factor;
            item.end *= factor;
            if (Array.isArray(item.words)) {
              for (const word of item.words) {
                word.start = Number(word.start || 0) * factor;
                word.end = Number(word.end || 0) * factor;
              }
            }
          }
        for (const operation of state.alignmentOperations || []) {
          for (const word of [operation.spoken, operation.expected]) {
            if (!word) continue;
            word.start = Number(word.start || 0) * factor;
            word.end = Number(word.end || 0) * factor;
          }
        }
        state.alignmentDuration = Number(state.alignmentDuration || 0) * factor;
        for (const group of state.compoundClips || []) {
          group.start = Number(group.start || 0) * factor;
          group.end = Number(group.end || 0) * factor;
        }
        for (const marker of state.timelineMarkers || [])
          marker.time = Number(marker.time || 0) * factor;
        if (state.timelineRange) {
          state.timelineRange.start = Number(state.timelineRange.start || 0) * factor;
          state.timelineRange.end = Number(state.timelineRange.end || 0) * factor;
        }
        for (const gap of state.pauseGapPlan || []) {
          gap.start = Number(gap.start || 0) * factor;
          gap.end = Number(gap.end || 0) * factor;
        }
        state.audioCuts = (state.audioCuts || []).map((time) => time * factor);
        state.currentTime *= factor;
        state.mainTimelineOffset = Number(state.mainTimelineOffset || 0) * factor;
        state.mainAudioTimelineOffset =
          Number(state.mainAudioTimelineOffset || 0) * factor;
        for (const map of [state.mainVideoClipOffsets, state.mainAudioClipOffsets])
          for (const key of Object.keys(map || {})) map[key] *= factor;
        state.audio.speed = next;
        state.duration = mainContentEnd();
        state.timelineDuration = Math.max(60, state.duration + 10);
        remapCaptionsFromSource(mainClips());
        clampTracksToDuration();
        applyMediaPlaybackRate($("video"));
        applyMediaPlaybackRate($("videoAlt"));
        syncPreviewAudio();
      }
      function baseMainAudioClips() {
        if (state.avLinked) return mainClips();
        const globalOffset = Math.max(
          0,
          Number(state.mainAudioTimelineOffset || 0),
        );
        const packed = buildPackedMainClips(
          Array.isArray(state.mainAudioRemovals) ? state.mainAudioRemovals : state.removals,
          Array.isArray(state.mainAudioManualCuts) ? state.mainAudioManualCuts : state.manualCuts,
          state.sourceDuration,
          state.audio.speed,
        );
        return packed.map((sourceClip) => {
          const offset = Number(state.mainAudioClipOffsets?.[sourceClip.id] || 0);
          return {
            ...sourceClip,
            start: Math.max(0, sourceClip.start + globalOffset + offset),
            end: Math.max(0, sourceClip.end + globalOffset + offset),
          };
        }).sort((left, right) => left.start - right.start);
      }
      function mainAudioClips() {
        if (state.avLinked) return mainClips();
        const result = [];
        for (const sourceClip of baseMainAudioClips()) {
          const start = Number(sourceClip.start || 0);
          const end = Math.max(start, Number(sourceClip.end || start));
          if (end <= start + 0.002) continue;
          const cuts = (state.audioCuts || [])
            .filter((time) => time > start + 0.002 && time < end - 0.002)
            .sort((a, b) => a - b);
          const points = [start, ...cuts, end];
          for (let index = 0; index < points.length - 1; index += 1)
            result.push({
              id: `a-${sourceClip.id}-${points[index].toFixed(4)}-${points[index + 1].toFixed(4)}`,
              start: points[index],
              end: points[index + 1],
              sourceStart:
                sourceClip.sourceStart +
                (points[index] - start) *
                  Math.max(0.05, Number(state.audio.speed || 1)),
              sourceEnd:
                sourceClip.sourceStart +
                (points[index + 1] - start) *
                  Math.max(0.05, Number(state.audio.speed || 1)),
              parentId: sourceClip.id,
            });
        }
        return result;
      }
      function adoptMainAudioMaps(previousClips = []) {
        const previousSettings = { ...(state.mainAudioClipSettings || {}) };
        const previousTracks = { ...(state.mainAudioTrackMap || {}) };
        const nextSettings = {};
        const nextTracks = {};
        for (const next of mainAudioClips()) {
          const previous = previousClips.find((item) => item.id === next.id) ||
            matchClipBySource(next, previousClips);
          if (!previous) continue;
          if (previousSettings[previous.id])
            nextSettings[next.id] = { ...previousSettings[previous.id] };
          if (previousTracks[previous.id]) nextTracks[next.id] = previousTracks[previous.id];
        }
        state.mainAudioClipSettings = nextSettings;
        state.mainAudioTrackMap = nextTracks;
      }
      function prepareIndependentMainAudio() {
        state.mainAudioRemovals = (state.removals || []).map((item) => ({ ...item }));
        state.mainAudioManualCuts = [...(state.manualCuts || [])];
        const rate = Math.max(0.05, Number(state.audio.speed || 1));
        const base = baseMainAudioClips();
        for (const timelineCut of state.audioCuts || []) {
          const clip = base.find(
            (item) => timelineCut > item.start + 0.002 && timelineCut < item.end - 0.002,
          );
          if (!clip) continue;
          state.mainAudioManualCuts.push(
            Number(clip.sourceStart || 0) + (Number(timelineCut) - Number(clip.start)) * rate,
          );
        }
        state.mainAudioManualCuts = state.mainAudioManualCuts
          .map(Number)
          .filter(Number.isFinite)
          .sort((left, right) => left - right)
          .filter((cut, index, list) => index === 0 || cut - list[index - 1] > 0.002);
        state.audioCuts = [];
      }
      
