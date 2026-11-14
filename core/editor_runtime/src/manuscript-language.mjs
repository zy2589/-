const LANGUAGE_MARKERS = new Map([
  ["fr", "au aux avec ce ces cette dans de des du elle elles en est et eux il ils je la le les leur lui mais même ne nos notre nous on ou par pas pour que qui sa se ses son sous sur ta te tes toi ton tu un une vos votre vous y c est d l n s qu aujourd hui"],
  ["es", "al algo como con de del desde donde el ella ellas ellos en era es esta este esto fue ha hay la las le les lo los me mi muy no nos o para pero por que se si sin su sus te tiene todo tu un una uno y ya"],
  ["pt", "a ao aos aquela aquele aquilo as até com como da das de dela dele desde do dos e ela elas ele eles em entre era essa esse esta este eu foi isso lhe mais mas me meu minha muito não nas no nos nossa nosso num numa o os ou para pela pelo por porque que se sem ser seu sua suas também tem um uma você vocês"],
  ["de", "aber als am an auch auf aus bei bin bis das dass dem den der des die doch du durch ein eine einem einen einer eines er es für hat ich im in ist kein mit nicht noch nur oder sie sind so und vom von vor war was wenn werden wie wir zu zum zur"],
  ["it", "a al alla alle anche che chi ci con da dal dalla dalle degli dei del della delle dello di e ed è era gli ha il in io la le lei lo ma mi nei nel nella nelle no non o per più quale questo se sei si sono su tra un una uno vi"],
  ["nl", "aan als bij dat de deze die dit een en er geen haar hebben het hij hoe hun ik in is je kan maar me met mijn niet of om ons ook op te tot uit van veel voor waar wat we wel werd wie wij zal ze zijn zo"],
  ["sv", "att av de den det denna där dig du en ett från för han har här hon i inte jag kan med men mig min mot mycket när och om oss på som så till under vi vid var vad"],
  ["pl", "a aby ale albo bardzo bez być co czy dla do gdy ich i jak jest już k nie na od oraz po pod przez przy się tak to tu w we z za ze"],
  ["id", "adalah akan atau bagi bahwa dan dari dengan dia di itu jangan juga kami kamu karena kita lebih mereka menjadi untuk tidak oleh pada saya sebagai sudah tanpa telah terhadap tuhan yang"],
  ["ms", "akan atau bagi bahawa dan dari dengan dia di itu juga kami kamu kerana kita lebih mereka menjadi untuk tidak pada saya sebagai sudah telah tuhan yang"],
  ["tl", "ako ang ay bilang hindi ikaw kami kanila kita mga mula ng niya para siya tayo kanilang"],
  ["vi", "bạn các cho của đã được là lại mà một những người rằng trong và với tôi không"],
  ["tr", "ama artık aslında ben bu bir çok daha da de değil diye için ile gibi hem her hiç ise kadar ki mi mı mu mü ne o olarak olan olacak ve veya ya yok"],
  ["ro", "aceasta acest această al am are au ca care ce cu da de din după ei el era este eu fără fi fost în la mai me nu o pe pentru prin să se si sunt un una și"],
  ["da", "af alle at blev da de den der det dig du en et for fra har hun i ikke jeg kan man med men mig mod meget når og om på som så til var vi vil"],
  ["fi", "ai että ei he hän hänelle heidän hänet jos ja joka myös minä mutta me meidän niin nyt oli olla on ovat oleva tämä tätä tuo vaan vai sekä"],
  ["no", "at av bare ble da de den der det dette du en et for fra ha han hun i ikke jeg kan med men meg mye når og om også på seg selv som så til var vi vil"],
  ["cs", "a aby ale ani až bez byl byla byli bylo bych bude by být co do ho i jak je jsou k ke který která které když na nebo než nic o od po pod pro před přes při s se si ta tak to u v ve z za že"],
  ["hu", "a az egy és ez ha hogy is meg nem ő vagy van volt a"],
].map(([language, words]) => [language, new Set(words.split(" ").map((word) => word.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))]));

const ENGLISH_MARKERS = new Set("a about after all am an and are as at be because been before but by can could did do for from had has have he her here hers him his how i if in into is it its just me more my no not of on one or our out over she so some than that the their them then there these they this through to too up us very was we were what when where which who will with would you your".split(" "));

const NON_LATIN_LANGUAGE_HINTS = [
  /\p{Script=Han}/u,
  /\p{Script=Hiragana}|\p{Script=Katakana}/u,
  /\p{Script=Hangul}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Arabic}/u,
  /\p{Script=Hebrew}/u,
  /\p{Script=Devanagari}/u,
  /\p{Script=Bengali}/u,
  /\p{Script=Gurmukhi}/u,
  /\p{Script=Gujarati}/u,
  /\p{Script=Telugu}/u,
  /\p{Script=Kannada}/u,
  /\p{Script=Malayalam}/u,
  /\p{Script=Thai}/u,
  /\p{Script=Tamil}/u,
  /\p{Script=Sinhala}/u,
  /\p{Script=Myanmar}/u,
  /\p{Script=Khmer}/u,
  /\p{Script=Lao}/u,
  /\p{Script=Tibetan}/u,
  /\p{Script=Georgian}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Greek}/u,
];

export function detectManuscriptLanguage(script = "") {
  const text = String(script || "").normalize("NFC").toLocaleLowerCase("fr");
  const words = text.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) || [];
  if (NON_LATIN_LANGUAGE_HINTS.some((pattern) => pattern.test(text))) return "auto";
  if (words.length < 3) return "";

  const folded = words.map((word) => word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, " ").split(/\s+/));
  const tokens = folded.flat();
  let bestLanguage = "";
  let bestCount = 0;
  let bestRatio = 0;
  for (const [language, markers] of LANGUAGE_MARKERS) {
    const count = tokens.filter((word) => markers.has(word)).length;
    const ratio = count / Math.max(1, tokens.length);
    if (count > bestCount || (count === bestCount && ratio > bestRatio)) {
      bestLanguage = language;
      bestCount = count;
      bestRatio = ratio;
    }
  }

  // Recognize common Latin-script manuscripts from function words, while
  // leaving ambiguous text at the selected language. A diacritic alone is not
  // enough because names and borrowed words often contain one.
  if (bestCount >= 3 && bestRatio >= 0.12) return bestLanguage;
  if (tokens.length <= 12 && bestCount >= 2 && bestRatio >= 0.2) return bestLanguage;
  const hasDiacritics = /\p{M}/u.test(text.normalize("NFD"));
  if (hasDiacritics) return "auto";
  const englishWordCount = tokens.filter((word) => ENGLISH_MARKERS.has(word)).length;
  if (tokens.length >= 8 && englishWordCount / tokens.length < 0.08) return "auto";
  return "";
}

export function speechLanguageForManuscript(script = "", configuredLanguage = "en") {
  const detected = detectManuscriptLanguage(script);
  return detected && (!configuredLanguage || configuredLanguage === "en")
    ? detected
    : configuredLanguage || "en";
}
