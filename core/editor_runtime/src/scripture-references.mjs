// Format explicit English scripture references after alignment, without changing
// the recognition transcript or treating chapter/verse as one ordinary number.
const plainBooks = 'Genesis Exodus Leviticus Numbers Deuteronomy Joshua Judges Ruth Ezra Nehemiah Esther Job Psalms Proverbs Ecclesiastes Isaiah Jeremiah Lamentations Ezekiel Daniel Hosea Joel Amos Obadiah Jonah Micah Nahum Habakkuk Zephaniah Haggai Zechariah Malachi Matthew Mark Luke John Acts Romans Galatians Ephesians Philippians Colossians Titus Philemon Hebrews James Jude Revelation'.split(' ');
const books = new Map(plainBooks.map(book => [book.toLowerCase(), book]));
books.set('psalm', 'Psalms');
books.set('song of solomon', 'Song of Solomon');
books.set('song of songs', 'Song of Solomon');
for (const book of ['Samuel','Kings','Chronicles','Corinthians','Thessalonians','Timothy','Peter','John']) {
  for (const [index, ordinal] of ['First','Second','Third'].entries()) {
    if (index === 2 && book !== 'John') continue;
    books.set(`${index + 1} ${book}`.toLowerCase(), `${index + 1} ${book}`);
    books.set(`${ordinal} ${book}`.toLowerCase(), `${index + 1} ${book}`);
  }
}
const units = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const tens = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
const values = new Map([...units.map((word, i) => [word, i]), ...tens.map((word, i) => [word, (i + 2) * 10])]);
const unit = units.slice(1,10).join('|');
const underHundred = '(?:' + tens.join('|') + ')(?:[ \\t-]+(?:' + unit + '))?|(?:' + units.slice(1,20).sort((a,b)=>b.length-a.length).join('|') + ')';
const number = '(?:\\d+|(?:' + unit + ')[ \\t]+hundred(?:[ \\t]+(?:and[ \\t]+)?(?:' + underHundred + '))?|(?:' + underHundred + '))(?![a-z\\d])';
const phrase = number + '(?:[ \\t]+' + number + ')?';
const names = [...books.keys()].sort((a,b) => b.length-a.length).join('|');
const reference = new RegExp('\\b(' + names + ')[ \\t]+(?:chapter[ \\t]+)?(' + phrase + ')(?:[ \\t]*(?::|verse[s]?)[ \\t]*(' + number + '))?(?:[ \\t]*(?<rangeConnector>through|to|and|[–—-])[ \\t]*(' + number + '))?', 'gi');
function integer(text) {
  const words = text.toLowerCase().trim().split(/[\s-]+/);
  if (words.length === 1 && /^\d+$/.test(words[0])) return Number(words[0]);
  let total = 0;
  if (words.length >= 2 && values.get(words[0]) >= 1 && values.get(words[0]) <= 9 && words[1] === 'hundred') {
    total = values.get(words.shift()) * 100;
    words.shift();
    if (words[0] === 'and') words.shift();
    if (!words.length) return total;
  }
  if (words.length === 1 && values.has(words[0])) return total + values.get(words[0]);
  if (words.length === 2 && values.get(words[0]) >= 20 && values.get(words[1]) >= 1 && values.get(words[1]) <= 9) return total + values.get(words[0]) + values.get(words[1]);
  return null;
}
function chapterVerse(first, second) {
  const valid = (chapter, verse) => chapter >= 1 && chapter <= 150 && verse >= 1 && verse <= 176;
  if (second) {
    const chapter = integer(first), verse = integer(second);
    return valid(chapter,verse) ? {chapter,verse} : null;
  }
  const atoms = first.trim().split(/\s+/);
  // A single number phrase is a chapter-only or ambiguous mention.
  if (integer(first) !== null) return null;
  const candidates = [];
  for (let i=1;i<atoms.length;i++) {
    const chapter=integer(atoms.slice(0,i).join(' ')), verse=integer(atoms.slice(i).join(' '));
    if(valid(chapter,verse)) candidates.push({chapter,verse});
  }
  return candidates.length === 1 ? candidates[0] : null;
}
export function normalizeScriptureReferences(words = [], {rangeReference = ""} = {}) {
  let text = '';
  const spans = words.map(word => {
    if(text) text += ' ';
    const start=text.length;
    text += String(word.display || word.text || '');
    return {start,end:text.length};
  });
  const replacements=[];
  for(const match of text.matchAll(reference)) {
    const after=text[match.index+match[0].length] || '';
    if (/[\p{L}\p{N}:/]/u.test(after) || (after === '.' && /\d/.test(text[match.index+match[0].length+1] || ''))) continue;
    // ASR can render a range separator as "verses": "five thirty nine
    // verses forty". Only accept it when the preceding phrase already has
    // an unambiguous chapter AND verse; never reinterpret chapter-only prose.
    let parsed=chapterVerse(match[2],match[3]);
    let rangeText=match[5];
    if (!parsed && match[3] && !match[5] && /\bverses?\b/i.test(match[0])) {
      parsed=chapterVerse(match[2]);
      if (parsed) rangeText=match[3];
    }
    if(!parsed) continue;
    // Interpret a conjunction as a range only with an exact manuscript citation.
    if (match.groups?.rangeConnector?.toLowerCase() === 'and') {
      const canonical = `${books.get(match[1].toLowerCase())} ${parsed.chapter}:${parsed.verse}-${integer(rangeText)}`;
      const referenceText = String(rangeReference).replace(/[–—]/g, '-').replace(/\s*([:-])\s*/g, '$1');
      const offset = referenceText.toLowerCase().indexOf(canonical.toLowerCase());
      if (offset < 0 || /[\d]/.test(referenceText[offset + canonical.length] || '')) continue;
    }
    const verseEnd=rangeText ? integer(rangeText) : null;
    if(rangeText && !(verseEnd >= parsed.verse && verseEnd <=176)) continue;
    const start=spans.findIndex(span=>span.end>match.index);
    const end=spans.findIndex(span=>span.end>=match.index+match[0].length);
    if(start<0 || end<start || replacements.at(-1)?.end>=start) continue;
    const prefix=text.slice(spans[start].start,match.index);
    const suffix=text.slice(match.index+match[0].length,spans[end].end);
    if(/[\p{L}\p{N}]/u.test(prefix+suffix)) continue;
    if (words.slice(start+1,end+1).some((word,i) => Number(word.start)-Number(words[start+i].end)>1.85)) continue;
    // Do not discard existing review decisions while reflowing saved captions.
    // Re-matching raw recognition is required to resolve these safely.
    if (words.slice(start,end+1).some(word => word.issueType || word.action === 'cut')) continue;
    const sourceWords=words.slice(start,end+1).flatMap(word=>word.sourceWords || [{...word}]);
    const display=`${prefix}${books.get(match[1].toLowerCase())} ${parsed.chapter}:${parsed.verse}${verseEnd===null?'':`–${verseEnd}`}${suffix}`;
    replacements.push({start,end,word:{...words[start],display,text:display,
      originalDisplay:display,expectedDisplay:display,referenceExpected:display,
      recognizedDisplay:sourceWords.map(word=>word.recognizedDisplay || word.originalDisplay || word.display || word.text || '').join(' '),
      autoNumericCorrected:false,end:words[end].end,
      ...(words[end].sourceEnd !== undefined ? {sourceEnd:words[end].sourceEnd} : {}),
      scriptureReference:true,scriptureCitation:{book:books.get(match[1].toLowerCase()),...parsed,verseEnd},sourceWords}});
  }
  const result=[];
  let cursor=0;
  for(const replacement of replacements) {
    result.push(...words.slice(cursor,replacement.start),replacement.word);
    cursor=replacement.end+1;
  }
  return [...result,...words.slice(cursor)];
}
