import {surplusTakeIssues} from './repeated-takes.mjs';
import crypto from 'node:crypto';
import {captionTextDiffers,captionReviewDiffers,captionComparisonKey,correctContractionCaptionWords} from '../caption-comparison.mjs';
import {correctNumericCaptionWords} from '../numeric-caption-correction.mjs';
import {correctHarmlessCaptionWords} from '../harmless-caption-correction.mjs';

// One policy for CC, manuscript matching and batch editing. Manuscript-aligned
// speech stays on the caption track; unverified extras wait on the review track.
export function pendingCaptionPlan(aligned = {}, {reviewUnmatched = true} = {}) {
  const operations=aligned.operations || [];
  const sentences=[];let sentence=[];
  for(const op of operations.filter(op=>op.spoken&&!op.spoken.recoveredFromManuscript)){
    if(op.type!=='filler'||sentence.length)sentence.push(op.spoken);
    if(/[.!?。！？]["'”’)]*$/.test(op.spoken.display||'')){if(sentence.length)sentences.push(sentence);sentence=[];}
  }
  if(sentence.length)sentences.push(sentence);
  const key=words=>words.map(w=>String(w.norm||w.display).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')).join(' ');
  const normalizeRepeat=issue=>{
    if(issue.type!=='repeat')return issue;
    const copies=sentences.filter(words=>words.length>=3&&sentences.some(other=>other!==words&&key(other)===key(words)));
    const candidate=copies.map(words=>({words,overlap:Math.max(0,Math.min(issue.end,words.at(-1).end)-Math.max(issue.start,words[0].start))})).sort((a,b)=>b.overlap-a.overlap)[0];
    if(!candidate||candidate.overlap<(issue.end-issue.start)*.6)return issue;
    return {...issue,start:candidate.words[0].start,end:candidate.words.at(-1).end,spokenText:candidate.words.map(w=>w.display).join(' ')};
  };
  const detected=surplusTakeIssues(operations);
  // Whole-take detection replaces fragmented local repeat warnings, including
  // fragments on the final take that local word alignment selected incorrectly.
  const candidates=[...(aligned.issues||[]).map(normalizeRepeat).filter(issue=>issue.type!=='repeat' || !detected.some(r=>
    issue.start<r.end && issue.end>r.start || Number.isFinite(r.retainedStart) && issue.start<r.retainedEnd && issue.end>r.retainedStart)),...detected];
  const issues=candidates.filter(issue=>['repeat','missing','mismatch','semantic','spokenDiff','addition','extra'].includes(issue.type))
    .filter(issue=>{
      if(!['mismatch','semantic','spokenDiff'].includes(issue.type))return true;
      const linked=operations.filter(operation=>operation.issueId===issue.id&&operation.spoken);
      const unanchoredSemantic=issue.type==='semantic'&&linked.length>0&&linked.every(operation=>!operation.expected);
      return unanchoredSemantic||captionComparisonKey(issue.spokenText)!==captionComparisonKey(issue.expectedText);
    })
    .map(issue=>{
      const linked=operations.filter(operation=>operation.issueId===issue.id&&operation.spoken);
      const unverifiedAddition=['addition','extra'].includes(issue.type)||issue.type==='semantic'&&linked.length>0&&linked.every(operation=>!operation.expected);
      return {...issue,type:unverifiedAddition?'unverifiedAddition':['semantic','spokenDiff'].includes(issue.type)?'mismatch':issue.type,
      ...(unverifiedAddition?{unverifiedAddition:true}:{}),
      ...(unverifiedAddition?{expectedText:''}:{}),
      ...(unverifiedAddition?{audioEvidence:'spoken'}:{}),
      ...(issue.type==='missing'?{label:'文案词未匹配，试听确认',audioEvidence:'notRecognized'}:{}),
      pendingCaption:false,confirmedCut:!!issue.confirmedCut,alreadyDisplayed:!unverifiedAddition&&issue.type!=='missing',
      needsAudioReview:unverifiedAddition||issue.type==='missing',suppressReview:false,
      action:issue.type==='missing'?'missing':issue.type==='repeat'?'review':unverifiedAddition?'insert':'replace',
      words:operations.filter(op=>op.spoken&&!op.spoken.recoveredFromManuscript&&
        (unverifiedAddition?(!op.expected&&(op.issueId===issue.id||op.captionDecisionIssueId===issue.id)):op.spoken.start<issue.end&&op.spoken.end>issue.start))
        .map(op=>({...op.spoken})),
      reason:unverifiedAddition?'文案外口语已自动加入字幕；试听后可保留或剪除':issue.type==='missing'?'识别结果没有找到对应口播；试听判断是漏读还是识别遗漏':issue.type==='repeat'?'重复口播，可试听后删除对应片段或保留':'与正确文案有差异，可手动替换'};
    });
  const reviewAdditionIds=new Set(issues.filter(issue=>issue.type==='unverifiedAddition').map(issue=>issue.id));
  const excludedOperations=new Set();
  if(reviewUnmatched)for(const operation of operations){
    if(!operation?.spoken||operation.expected||operation.spoken.recoveredFromManuscript)continue;
    if(operation.action==='cut'){
      excludedOperations.add(operation);
      continue;
    }
    if(operation.issueId&&reviewAdditionIds.has(operation.issueId)){
      excludedOperations.add(operation);
      continue;
    }
  }
  const syntheticGroups=[];let group=[];
  const flushGroup=()=>{
    if(!group.length)return;
    const start=Number(group[0].spoken.start||0),end=Number(group.at(-1).spoken.end||start+.04),id=crypto.randomUUID();
    const words=group.map(operation=>({...operation.spoken}));
    for(const operation of group){
      excludedOperations.add(operation);
      operation.captionDecision='review-addition';
      operation.captionDecisionIssueId=id;
    }
    syntheticGroups.push({id,issueId:id,type:'unverifiedAddition',unverifiedAddition:true,label:'文案外口语待确认',spokenText:words.map(word=>word.display).join(' '),expectedText:'',start,end,
      action:'insert',pendingCaption:false,alreadyDisplayed:false,needsAudioReview:true,confirmedCut:false,suppressReview:false,
      reason:'文案外口语已自动加入字幕；试听后可保留或剪除',words});
    group=[];
  };
  if(reviewUnmatched)for(const operation of operations){
    const candidate=operation?.spoken&&!operation.expected&&!operation.spoken.recoveredFromManuscript&&
      (operation.action!=='cut'||operation.type==='extra'||['addition','semantic'].includes(operation.issueType))&&!operation.issueId&&
      (['extra','filler'].includes(operation.type)||operation.issueType==='addition'||operation.issueType==='semantic'||operation.action==='insert')&&
      !['mismatch','repeat','spokenDiff'].includes(operation.issueType);
    if(!candidate){flushGroup();continue;}
    const previous=group.at(-1);
    if(previous&&Number(operation.spoken.start||0)-Number(previous.spoken.end||0)>.55)flushGroup();
    group.push(operation);
  }
  flushGroup();
  issues.push(...syntheticGroups);
  if(reviewUnmatched)for(const operation of operations){
    if(operation?.spoken&&!operation.expected&&!operation.spoken.recoveredFromManuscript&&operation.issueType==='addition'&&operation.action!=='cut')
      excludedOperations.add(operation);
  }
  const words=operations.filter(op=>op.spoken&&!op.spoken.recoveredFromManuscript&&!excludedOperations.has(op)).map(op=>{
    const spoken=op.spoken;let expected=op.expected;
    const localIssues=issues.filter(i=>i.type!=='missing'&&spoken.start<i.end&&spoken.end>i.start);
    const issue=localIssues.find(i=>i.id===op.issueId)||localIssues[0];
    // A local aligner can assign the next sentence's opening word to the
    // previous repeated take. Keep that reference on the retained occurrence.
    if(!expected&&!issue&&op.issueId){
      const repeat=issues.find(i=>i.id===op.issueId&&i.type==='repeat');
      if(repeat)expected=operations.find(other=>other.expected&&other.spoken&&other.spoken.start>=repeat.start&&other.spoken.end<=repeat.end&&
        !captionTextDiffers(other.expected.display,spoken.display))?.expected;
    }
    const matched=expected&&!issue&&(['match','near'].includes(op.type)||!captionTextDiffers(spoken.display,expected.display));
    return {...spoken,display:matched?expected.display:spoken.display,
      originalDisplay:spoken.display,expectedDisplay:expected?.display||'',autoCorrected:!!matched&&spoken.display!==expected.display,ccReferenceReview:!!matched,
      matchType:op.type,
      issueType:issue?.type || '',issueId:issue?.id||'',
      action:issue?.action||'',keepWithPrevious:!!spoken.keepWithPrevious||!!expected?.keepWithPrevious,
      scriptureReference:!!spoken.scriptureReference||!!expected?.scriptureReference};
  }).sort((a,b)=>a.start-b.start||a.end-b.end);
  const mild=correctHarmlessCaptionWords(words,issues);
  const contractions=correctContractionCaptionWords(mild.words,issues);
  const numeric = correctNumericCaptionWords(contractions.words,issues);
  const ignored = new Set(issues.filter(i=>i.type==='mismatch' && !captionReviewDiffers(i.spokenText,i.expectedText)).map(i=>i.id));
  for (const word of numeric.words) if (ignored.has(word.issueId)) Object.assign(word,{issueId:'',issueType:'',action:''});
  const unresolved = new Set(numeric.words.filter(w=>w.issueId).map(w=>w.issueId));
  return {words:numeric.words,issues:issues.filter(i=>!ignored.has(i.id) && (![...numeric.resolvedIssueIds,...contractions.resolvedIssueIds,...mild.resolvedIssueIds].includes(i.id)||unresolved.has(i.id))),pending:[]};
}
