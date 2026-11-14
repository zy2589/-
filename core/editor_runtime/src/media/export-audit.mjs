import {spawn} from 'node:child_process';
import {mediaBinary} from './core.mjs';

// Decode every frame. A black interval is a review signal, not proof of corruption.
export async function auditExportFrames(inputPath) {
  return new Promise((resolve,reject) => {
    const child=spawn(mediaBinary('ffmpeg'),['-hide_banner','-nostdin','-v','info','-xerror','-i',inputPath,
      '-map','0:v:0','-an','-vf','blackdetect=d=0:pix_th=0.02:pic_th=0.98','-f','null','-'],{windowsHide:true});
    let log=''; const black=[];
    const consume=line=>{
      const m=line.match(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/);
      if(m && black.length<1000)black.push({start:Number(m[1]),end:Number(m[2]),type:'black-frame',expectedText:'连续有效画面',spokenText:'检测到黑画面，请核对原片和切点'});
    };
    child.stderr.on('data',chunk=>{log+=chunk.toString();const lines=log.split(/[\r\n]/);log=lines.pop();lines.forEach(consume);});
    child.stdout.resume();
    child.on('error',reject);
    child.on('close',code=>{consume(log);if(code!==0)reject(Error('成片完整解码检查未通过'));else resolve(black);});
  });
}
