import fs from 'node:fs';
import path from 'node:path';
import {createProject,saveProjectSnapshot,projectStoragePath} from './project-store.mjs';
import {editSourceClips} from './edit-decisions.mjs';

export function saveEditableBatchProject(input,info,removals,audioPath=''){
 const project=createProject({name:input.outputName||path.parse(input.inputPath).name,ratio:(info.displayWidth||info.width)>(info.displayHeight||info.height)?'16:9':'9:16'});
 const clips=editSourceClips(info.duration,removals);
 const duration=clips.at(-1)?.end||0;
 let denoisedAudio=null;
 if(audioPath){const folder=path.join(projectStoragePath(project.id),'media');fs.mkdirSync(folder,{recursive:true});const target=path.join(folder,'denoised.m4a');fs.copyFileSync(audioPath,target);denoisedAudio={path:target,sourcePath:input.inputPath,kind:'audio',mode:'deepfilter',strength:Number(input.strength)/100};}
 const [width,height]=input.resolution&&input.resolution!=='source'?input.resolution.split('x').map(Number):[info.displayWidth||info.width,info.displayHeight||info.height];
 saveProjectSnapshot({projectId:project.id,data:{...project.data,width,height,fps:info.frameRate||30,timelineFrameRate:info.frameRate||30,
  video:{...info,path:input.inputPath,name:path.basename(input.inputPath),kind:'video'},
  sourceDuration:info.duration,duration,timelineDuration:duration,removals,manualCuts:[],
  denoisedAudio,denoiseEnabled:!!denoisedAudio,audio:{speed:1,volume:1},
  exportSpeed:Number(input.exportSpeed)||1,batchExportSettings:{...input},
  editModelVersion:2,sourceRecoveryAvailable:true}});
 return project.id;
}
