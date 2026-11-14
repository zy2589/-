import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {startExport,exportStatus} from './media/render.mjs';
import {probeMediaAsync,run,mediaBinary} from './media/core.mjs';

// Both manual and batch editing render their main A/V through the production graph.
// Captions and overlays stay independently editable. No source file is overwritten.
export async function consolidateMainMedia(config, directory, onProgress = () => {}) {
  fs.mkdirSync(directory,{recursive:true});
  const outputPath=path.join(directory,'剪气口完整素材-'+crypto.randomUUID()+'.mp4');
  const source=await probeMediaAsync(config.inputPath);
  const input={...config,outputPath,format:'mp4',codec:'h264',colorSpace:'bt709',qualityMode:'lossless',encoderDevice:config.encoderDevice || 'gpu',captions:[],titles:[],images:[],videoLayers:config.videoLayers||[],audioAssets:config.audioAssets||[],includeVideo:true,includeAudio:true,captionRasterized:false,captionAssPath:'',captionRastersViaMovie:false};
  const started=startExport(input);
  for (;;) {
    const status=exportStatus(started.jobId);
    onProgress(status);
    if(status.state==='completed') break;
    if(['failed','cancelled'].includes(status.state)) throw Error(status.error || '完整素材生成已取消；原素材未改动');
    await sleep(250);
  }
  const info=await probeMediaAsync(outputPath);
  const fps=Number(config.fps || source.frameRate || 30);
  if(!info.videoCodec || (source.audioCodec && !info.audioCodec) || Math.abs(info.duration-Number(config.outputDuration || source.duration)) > Math.max(.1,2/fps)) throw Error('完整素材音视频或时长校验失败，未替换原素材');
  let playbackAudioPath='';
  if(info.audioCodec) {
    playbackAudioPath=outputPath+'.audio.flac';
    onProgress({state:'preparing',progress:.99,message:'准备无损试听音轨'});
    await run(mediaBinary('ffmpeg'),['-y','-v','error','-i',outputPath,'-vn','-c:a','flac',playbackAudioPath]);
  }
  return {...info,path:outputPath,name:path.basename(outputPath),kind:'video',consolidated:true,playbackAudioPath};
}

export function reanchorConsolidatedCaptions(captions, speed=1) {
  return (captions || []).map(caption=>({...caption,sourceStart:Number(caption.start || 0)*speed,sourceEnd:Number(caption.end || 0)*speed,words:caption.words?.map(word=>({...word,sourceStart:Number(word.start || 0)*speed,sourceEnd:Number(word.end || 0)*speed}))}));
}
