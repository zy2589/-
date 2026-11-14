// Shared by single-video CC, manuscript matching, batch editing and old projects.
export function harmlessCaptionDifference(spoken, expected) {
  const tokens = value => String(value || '').toLowerCase().replace(/[’]/g,"'").match(/[a-z]+(?:'[a-z]+)*/g) || [];
  let left=tokens(spoken), right=tokens(expected);
  if (!left.length || !right.length || /\d/.test(spoken + expected)) return false;
  while(left.length && right.length && left[0]===right[0]) {left.shift();right.shift();}
  while(left.length && right.length && left.at(-1)===right.at(-1)) {left.pop();right.pop();}
  if(left.length!==1 || right.length!==1) return false;
  const a=left[0],b=right[0];
  // Never treat negation, names, numbers, or a whole missing phrase as minor.
  if (/^(?:no|not|never|without)$/.test(a) || /^(?:no|not|never|without)$/.test(b) || /n't$/.test(a+b)) return false;
  const short=new Set(['in','on','at','of','to','for','from','by','with','a','an','the']);
  if(short.has(a) && short.has(b)) return true;
  if((a==='in' && b==='it') || (a==='it' && b==='in')) return true;
  return /^(?:i|you|we|they|he|she|it)(?:'(?:re|m|s|ve|d|ll))?$/.test(a) && /^(?:i|you|we|they|he|she|it)(?:'(?:re|m|s|ve|d|ll))?$/.test(b) && (a.replace(/'(?:re|m|s|ve|d|ll)$/,'')===b || b.replace(/'(?:re|m|s|ve|d|ll)$/,'')===a);
}

export function correctHarmlessCaptionWords(words, issues = []) {
  let result=words.map(word=>({...word}));const resolvedIssueIds=[];
  for(const issue of issues) {
    if(!['mismatch','semantic','spokenDiff'].includes(issue.type) || issue.scripture || issue.strict ||
      !harmlessCaptionDifference(issue.spokenText,issue.expectedText)) continue;
    const id=issue.issueId || issue.id;
    const selected=result.filter(word=>word.issueId===id && word.start<issue.end && word.end>issue.start);
    if(!selected.length || selected.some(word=>word.userKept || word.reviewDismissed || word.matchType==='edited')) continue;
    const expected=String(issue.expectedText).trim().split(/\s+/);
    const spoken=String(issue.spokenText).trim().split(/\s+/);
    if(selected.length!==expected.length || spoken.length!==expected.length) continue;
    selected.forEach((word,index)=>{
      const changed=word.display!==expected[index];
      Object.assign(word,{display:expected[index],expectedDisplay:expected[index],referenceExpected:expected[index],
        recognizedDisplay:word.recognizedDisplay || word.originalDisplay || word.display,
        originalDisplay:word.originalDisplay || spoken[index],autoMildCorrected:changed,autoCorrected:changed,
        matchType:changed?'spoken_addition':'match',issueType:changed?'addition':'',issueId:'',action:''});
    });
    resolvedIssueIds.push(id);
  }
  for(const word of result){
    const spoken=word.recognizedDisplay || word.originalDisplay || word.display;
    const expected=word.referenceExpected || word.expectedDisplay;
    if(word.userKept || word.reviewDismissed || word.matchType==='edited' || !expected || !harmlessCaptionDifference(spoken,expected))continue;
    if(word.issueId)resolvedIssueIds.push(word.issueId);
    Object.assign(word,{display:expected,recognizedDisplay:spoken,originalDisplay:spoken,referenceExpected:expected,
      autoMildCorrected:true,autoCorrected:true,matchType:'spoken_addition',issueType:'addition',issueId:'',action:''});
  }
  return {words:result,resolvedIssueIds};
}
