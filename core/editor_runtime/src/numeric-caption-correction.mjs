export function isManuscriptNumber(text) {
  return /^["'“‘(\[]*[$¥€£+−-]?\d[\d,.:/–−+%\-]*(?:st|nd|rd|th|kg|km|cm|mm|px|ms|m|s)?[.!?;:)\]"'”’]*$/iu.test(String(text || '').trim());
}

export function isSpokenNumber(text) {
  const raw = String(text || '').trim();
  if (isManuscriptNumber(raw)) return true;
  const parts = raw.toLowerCase().replace(/["'“”‘’.,!?;:()\[\]%]/g,'').split(/[\s-]+/).filter(Boolean);
  const vocabulary = new Set(('zero oh nought one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion and point decimal percent percentage minus negative plus first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth hundredth thousandth').split(' '));
  return parts.length > 0 && parts.some(p => !['and','point','decimal','percent','percentage','minus','negative','plus'].includes(p)) && parts.every(p => vocabulary.has(p) || /^\d+$/.test(p));
}

export function shouldAutoReplaceManuscriptNumber(spoken, expected) {
  return isManuscriptNumber(expected) && isSpokenNumber(spoken);
}

export function correctNumericCaptionWords(words = [], issues = []) {
  let result = words.map(word => ({...word}));
  for (const word of result) {
    if (!word.scriptureCitation || !word.autoNumericCorrected || word.userKept || word.reviewDismissed || word.matchType === 'edited' || !isManuscriptNumber(word.display)) continue;
    const citation=word.scriptureCitation;
    const full=String(word.text || '');
    const canonical=`${citation.book} ${citation.chapter}:${citation.verse}`;
    if (!full.toLowerCase().includes(canonical.toLowerCase())) continue;
    Object.assign(word,{display:full,originalDisplay:full,recognizedDisplay:full,expectedDisplay:full,referenceExpected:full,
      autoNumericCorrected:false,scriptureRestored:true});
  }
  const resolved = new Set();
  for (const issue of issues) {
    if (!['mismatch','semantic','spokenDiff'].includes(issue.type) ||
        !shouldAutoReplaceManuscriptNumber(issue.spokenText,issue.expectedText)) continue;
    const id = issue.issueId || issue.id;
    const selected = result.filter(w => w.issueId === id && w.start < issue.end && w.end > issue.start);
    if (!selected.length || selected.some(w => w.scriptureCitation || w.scriptureReference || w.userKept || w.reviewDismissed || w.matchType === 'edited' || !isSpokenNumber(w.originalDisplay || w.display))) continue;
    const first = selected[0], last = selected.at(-1);
    Object.assign(first,{recognizedDisplay:selected.map(w=>w.originalDisplay || w.display).join(' '),
      display:issue.expectedText,expectedDisplay:issue.expectedText,referenceExpected:issue.expectedText,
      end:last.end,...(Number.isFinite(last.sourceEnd)?{sourceEnd:last.sourceEnd}:{}),
      autoNumericCorrected:true,autoCorrected:true,matchType:'match',issueType:'',issueId:'',action:''});
    result = result.filter(w => w === first || !selected.includes(w));
    resolved.add(id);
  }
  for (const word of result) {
    if (word.scriptureCitation || word.scriptureReference || word.userKept || word.reviewDismissed || word.matchType === 'edited' || ['repeat','addition','extra','missing','edited-timing'].includes(word.issueType)) continue;
    const expected = word.referenceExpected || word.expectedDisplay || '';
    const spoken = word.recognizedDisplay || word.originalDisplay || word.display;
    if (!shouldAutoReplaceManuscriptNumber(spoken,expected)) continue;
    if (word.issueId) resolved.add(word.issueId);
    Object.assign(word,{recognizedDisplay:spoken,display:expected,expectedDisplay:expected,referenceExpected:expected,
      autoNumericCorrected:true,autoCorrected:spoken!==expected,matchType:'match',issueType:'',issueId:'',action:''});
  }
  return {words:result,resolvedIssueIds:[...resolved]};
}
