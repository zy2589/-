import {surplusTakeIssues} from './repeated-takes.mjs';
import {captionTextDiffers,captionReviewDiffers,captionComparisonKey,correctContractionCaptionWords} from '../caption-comparison.mjs';
import {correctNumericCaptionWords} from '../numeric-caption-correction.mjs';
import {correctHarmlessCaptionWords} from '../harmless-caption-correction.mjs';

// One policy for CC, manuscript matching and batch editing. Review annotations
// never remove spoken captions or manufacture audio for missing manuscript words.
export function pendingCaptionPlan(aligned = {}) {
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
  const issues=candidates.filter(issue=>['repeat','missing','mismatch','semantic','spokenDiff'].includes(issue.type))
    .filter(issue=>!['mismatch','semantic','spokenDiff'].includes(issue.type)||captionComparisonKey(issue.spokenText)!==captionComparisonKey(issue.expectedText))
    .map(issue=>({...issue,type:['semantic','spokenDiff'].includes(issue.type)?'mismatch':issue.type,
      pendingCaption:false,confirmedCut:false,alreadyDisplayed:issue.type!=='missing',suppressReview:false,
      action:issue.type==='missing'?'missing':issue.type==='repeat'?'review':'replace',
      words:operations.filter(op=>op.spoken&&!op.spoken.recoveredFromManuscript&&op.spoken.start<issue.end&&op.spoken.end>issue.start).map(op=>({...op.spoken})),
      reason:issue.type==='missing'?'需要补录；请先试听确认是否确实漏读':issue.type==='repeat'?'重复口播，可试听后手动处理':'与正确文案有差异，可手动替换'}));
  const words=operations.filter(op=>op.spoken&&!op.spoken.recoveredFromManuscript).map(op=>{
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
    const addition=!issue&&!matched&&!expected;
    return {...spoken,display:matched?expected.display:spoken.display,
      originalDisplay:spoken.display,expectedDisplay:expected?.display||'',autoCorrected:!!matched&&spoken.display!==expected.display,ccReferenceReview:!!matched,
      matchType:matched?op.type:addition?'spoken_addition':op.type,
      issueType:issue?.type || (addition?'addition':''),issueId:issue?.id||'',
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
