// A text alignment is a proposal, not independent evidence of a spoken mistake.
export function guardAutomaticCuts(aligned, baseline = aligned) {
  const operations = aligned.operations || [];
  const original = new Map((baseline.operations || []).filter(o => o.spoken).map(o => [o.spoken.start, o]));
  const speech = operations.filter(o => o.spoken);
  for (const issue of aligned.issues || []) {
    if (!issue.confirmedCut) continue;
    const removed = speech.filter(o => o.spoken.start >= issue.start && o.spoken.end <= issue.end + .001);
    const tokens = removed.map(o => o.spoken.norm);
    // Only an entire repeated sentence with a separately retained, manuscript-
    // backed copy can be discarded automatically. Short echoes need review.
    const first = speech.indexOf(removed[0]);
    const sentenceStart = first === 0 || /[.!?。！？]$/.test(speech[first - 1]?.spoken.display || '');
    const sentenceEnd = /[.!?。！？]$/.test(removed.at(-1)?.spoken.display || '');
    let retainedCopy = false;
    if (tokens.length >= 5 && sentenceStart && sentenceEnd) {
      for (let i = 0; i <= speech.length - tokens.length; i++) {
        const copy = speech.slice(i, i + tokens.length);
        if (copy.every((o, k) => o.spoken.norm === tokens[k] &&
          (o.spoken.end <= issue.start || o.spoken.start >= issue.end) &&
          o.action !== 'cut' && o.type !== 'repeat-cut' && o.expected?.norm === o.spoken.norm &&
          (!k || o.spoken.start - copy[k - 1].spoken.end < 1.5))) {
          issue.retainedRange = {start:copy[0].spoken.start,end:copy.at(-1).spoken.end};
          retainedCopy = true; break;
        }
      }
    }
    if (issue.type === 'repeat' && retainedCopy) continue;
    issue.confirmedCut = false;
    issue.reviewRequired = true;
    issue.reviewReason = '删除证据不足，已保留原声，请核对整句及重录版本';
    for (const op of operations) {
      if (op.issueId !== issue.id && !removed.includes(op)) continue;
      const saved = original.get(op.spoken?.start);
      if (saved) Object.assign(op, structuredClone(saved));
      op.action = op.spoken ? 'insert' : op.action;
      if (op.type === 'repeat-cut') op.type = 'extra';
    }
  }
  // Reject mutually dependent deletions: a retained copy must survive ALL cuts.
  for (const issue of aligned.issues || []) {
    if (!issue.confirmedCut || !issue.retainedRange) continue;
    if ((aligned.issues || []).some(other => other !== issue && other.confirmedCut &&
      other.start < issue.retainedRange.end && other.end > issue.retainedRange.start)) {
      issue.confirmedCut = false; issue.reviewRequired = true;
      issue.reviewReason = '保留的对应版本也在删除计划中，已阻止删除';
    }
  }
  // Caption eligibility follows actual approved source cuts, never a stale action flag.
  for (const op of operations) {
    if (!op.spoken || (op.action !== 'cut' && op.type !== 'repeat-cut')) continue;
    if (!(aligned.issues || []).some(i => i.confirmedCut && ['repeat','extra'].includes(i.type) &&
      op.spoken.start >= i.start && op.spoken.end <= i.end + .001)) {
      op.action = 'insert'; if (op.type === 'repeat-cut') op.type = 'extra';
    }
  }
  return aligned;
}

export function pendingEditIssues(issues = [], removals = []) {
  return issues.filter(issue => issue.reviewRequired ||
    (['missing', 'mismatch', 'repeat', 'extra'].includes(issue.type) &&
      !removals.some(r => Number(issue.start) >= r.start && Number(issue.end) <= r.end)));
}
