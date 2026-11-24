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

export function correctHarmlessCaptionWords(words = []) {
  // Short function words can change the meaning (`in` / `to`, for example).
  // Keep the recognized spelling and let the existing local review show the
  // manuscript candidate; never silently rewrite it or mark the rewrite as a
  // spoken addition.
  return {words:words.map(word=>({...word})),resolvedIssueIds:[]};
}
