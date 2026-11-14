
      function timelineSceneConfig() {
        const fps = timelineFrameRate();
        const video = normalizeExportFrameBoundaries(mainClips(), fps).clips.map(clip => ({...clip, trackId:state.mainVideoTrackMap?.[clip.id] || 'video', settings:{...mainVideoSettings(clip)}}));
        const audio = normalizeExportFrameBoundaries(mainAudioClips(), fps).clips.map(clip => ({...clip,...mainAudioSettings(clip),trackId:state.mainAudioTrackMap?.[clip.id] || 'audio',muted:!isTrackAudible(state.mainAudioTrackMap?.[clip.id] || 'audio') || !!mainAudioSettings(clip)?.muted}));
        return {
          inputPath:state.video.path, mainAudioPath:state.denoiseEnabled ? state.denoisedAudio?.path || '' : '',
          width:state.width,height:state.height,fps,outputDuration:state.duration,
          removals:state.removals,mainVideoClips:video,mainAudioClips:audio,
          mainTimelineOffset:state.mainTimelineOffset,audio:{...state.audio},audioMutes:state.audioMutes,
          audioProcessingEnabled:state.audioProcessingEnabled,audioFxRack:state.audioFxRack,audioFxBypass:state.audioFxBypass,
          color:state.colorBypass ? {} : state.color,
          denoise:{...state.denoise,strength:state.denoiseEnabled ? state.denoise.strength : 0},
          trackOrder:state.trackOrder,trackDefinitions:state.trackDefinitions,trackVisibility:effectiveTrackVisibility(),
          videoTransform:{x:0,y:0,scale:1,rotation:0,opacity:1,blendMode:'normal'},
          includeVideo:true,includeAudio:true,
          images:state.images.map(item=>({...item})),videoLayers:state.videoLayers.map(item=>({...item})),audioAssets:state.audioAssets.map(item=>({...item})),
          titles:state.titles.filter(item=>state.trackVisibility[item.trackId]!==false),
          captions:state.captions.filter(item=>state.trackVisibility[item.trackId || 'caption']!==false).map(item=>({...item,...state.captionTransform,style:{...state.captionStyle,captionLines:state.captionLines}})),
        };
      }
      async function withMediaOperation(label, action) {
        if (window.mediaOperationBusy) throw Error('正在处理素材，请稍候');
        window.mediaOperationBusy = true;
        if (state.playing) togglePlay();
        const dialog = document.createElement('dialog');
        dialog.style.cssText='background:#202020;color:white;border:1px solid #555;border-radius:10px;padding:28px;max-width:480px';
        dialog.textContent=label; dialog.id='mediaOperationProgress'; document.body.append(dialog);
        dialog.addEventListener('cancel',event=>event.preventDefault());
        const blockKeys=event=>{event.stopImmediatePropagation();event.preventDefault();};
        window.addEventListener('keydown',blockKeys,true);
        dialog.showModal();
        try {return await action();}
        finally {window.removeEventListener('keydown',blockKeys,true);dialog.close();dialog.remove();window.mediaOperationBusy=false;}
      }
      function ripplePauseOverlays(previousClips, removals) {
        const ranges=[];
        for(const clip of previousClips) for(const cut of removals) {
          const a=Math.max(clip.sourceStart,cut.start), b=Math.min(clip.sourceEnd,cut.end);
          if(b<=a)continue;
          const rate=(clip.end-clip.start)/(clip.sourceEnd-clip.sourceStart);
          ranges.push({start:clip.start+(a-clip.sourceStart)*rate,end:clip.start+(b-clip.sourceStart)*rate});
        }
        const cuts=normalizeRemovalsList(ranges);
        const map=time=>time-cuts.reduce((sum,cut)=>sum+Math.max(0,Math.min(time,cut.end)-cut.start),0);
        for(const cut of [...cuts].reverse()){
          for(const [key,track] of [['images','image'],['titles','text'],['videoLayers','video'],['audioAssets','audio'],['reviewCaptions','review'],['issues','review'],['matchIssues','review']]){
            state[key]=editRipple(state[key]||[],cut.end,cut.start-cut.end,{id:uid,rate:Number(state.audio.speed||1),enabled:item=>editTrackEnabled(item.trackId||track,state.trackLocks,state.trackSyncLocks,true)});
          }
        }
        reconcileEditLinks();
        for(const marker of state.timelineMarkers || [])marker.time=map(marker.time);
      }

