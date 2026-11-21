export function normalizeLanguagePunctuationForScript(text) {
        let str = String(text || "");
        const protectedText = [];
        str = str.replace(/(?:https?:\/\/|www\.)[^\s<>"“”]+[^\s<>"“”.,!?;:)]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:[A-Za-z]\.){2,}|\b[\w-]+\.(?:com|org|net|edu|gov|io|co\.nz)\b(?:\/[^\s,]*)?|\b\d+(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/gi, value => {
          const key = `\uE000${protectedText.length}\uE001`;
          protectedText.push(value);
          return key;
        });
        // Keep digit:digit (scripture e.g. 24:36, clock time e.g. 10:30) compact
        str = str.replace(/(\d)\s*:\s*(\d)/g, "$1:$2");

        // 1. English context: convert full-width Chinese punctuation adjacent to Latin letters/numbers to half-width
        str = str.replace(/([a-zA-Z0-9])([，,])(?:\s*)([a-zA-Z0-9])/gu, (match, before, comma, after, offset, source) => {
          // Keep contiguous thousands groups, but preserve spaced numeric lists.
          if (comma === ',' && /^\d,\d$/.test(match)
            && /^\d{3}(?=,\d{3}|\.|\b)/.test(source.slice(offset + 2))) return match;
          return `${before}, ${after}`;
        });
        str = str.replace(/([a-zA-Z])([：:])(?:\s*)([a-zA-Z0-9])/gu, "$1: $3");
        str = str.replace(/(\d)([：:])(?:\s*)([a-zA-Z])/gu, "$1: $3");
        str = str.replace(/([a-zA-Z0-9])([；;])(?:\s*)([a-zA-Z0-9])/gu, "$1; $3");
        str = str.replace(/([a-zA-Z0-9])，/gu, "$1, ");
        str = str.replace(/([a-zA-Z0-9])。/gu, "$1. ");
        str = str.replace(/([a-zA-Z0-9])！/gu, "$1! ");
        str = str.replace(/([a-zA-Z0-9])？/gu, "$1? ");
        str = str.replace(/([a-zA-Z])：/gu, "$1: ");
        str = str.replace(/([a-zA-Z0-9])；/gu, "$1; ");

        // 2. Chinese context: convert half-width punctuation between/after CJK characters to full-width Chinese punctuation
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1，$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]):([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1：$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]);([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])/gu, "$1；$2");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]),(?!\s*[a-zA-Z0-9])/gu, "$1，");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])!(?!\s*[a-zA-Z0-9])/gu, "$1！");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF])\?(?!\s*[a-zA-Z0-9])/gu, "$1？");
        str = str.replace(/([\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]);(?!\s*[a-zA-Z0-9])/gu, "$1；");

        // Clean redundant spaces before English punctuation
        str = str.replace(/\s+([.,!?;:])/g, "$1");
        // Clean redundant spaces around Chinese punctuation
        str = str.replace(/\s*([，。、！？；：])\s*/gu, "$1");
        str = str.replace(/\s+([”’」』》〉）】〕〗])/gu, "$1");
        str = str.replace(/([“‘「『《〈（【〔〖])\s+/gu, "$1");
        str = str.replace(/([\u3400-\u9FFF])\s+([“‘「『《〈（【〔〖])/gu, "$1$2");
        str = str.replace(/([”’」』》〉）】〕〗])\s+([\u3400-\u9FFF])/gu, "$1$2");

        // A manuscript newline after English punctuation is a word separator too.
        // Lookahead keeps consecutive short items (a,b,c) from skipping a comma.
        str = str.replace(/([A-Za-z0-9\uE001][,.]["'”’)]*)\s*(?=[A-Za-z0-9“‘(\uE000])/g,
          (match, before) => (match.match(/\n/g) || []).length > 1 ? match : `${before} `);
        return str.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedText[Number(index)]);
      }
      function removeSurplusBoundaryQuotes(input) {
        let text = String(input || "").trim();
        // Leading quote marks are stray copied punctuation in this script field,
        // not part of the spoken text. Remove the whole contiguous prefix run;
        // quote marks elsewhere in the manuscript continue through normal pairing.
        text = text.replace(/^["'“”„‟＂＇]+\s*/, "");
        // Whole-document wrappers can contain same-style quotations. Odd quote
        // counts in both boundary paragraphs identify a pair spanning the text,
        // unlike two independently quoted paragraphs (even counts in each).
        let blocks = text.split(/\n\s*\n/);
        while (blocks.length > 1 && /^[“”„‟＂"]/.test(text) && /[“”„‟＂"]$/.test(text)
          && (blocks[0].match(/[“”„‟＂"]/g) || []).length % 2 === 1
          && (blocks.at(-1).match(/[“”„‟＂"]/g) || []).length % 2 === 1) {
          text = text.slice(1, -1).trim();
          blocks = text.split(/\n\s*\n/);
        }
        function pairs(value) {
          const stack = [], matches = new Map();
          for (let i = 0; i < value.length; i++) {
            const c = value[i];
            if (c === "„" || c === "‟") stack.push(i);
            else if (c === "“") {
              if (stack.length && value[stack.at(-1)] === "„") matches.set(stack.pop(), i);
              else stack.push(i);
            }
            else if (c === "”") { if (stack.length) matches.set(stack.pop(), i); }
            else if (c === '"' || c === '＂') {
              const previous = value[i - 1] || "";
              const next = value[i + 1] || "";
              const nextStartsText = /[\p{L}\p{N}]/u.test(next)
                || (/\s/.test(next) && /^\s+[\p{L}\p{N}]/u.test(value.slice(i + 1)));
              const nestedOpening = stack.length && nextStartsText
                && (/[\s:([{]/.test(previous) || /[\p{L}\p{N}]/u.test(previous));
              if (stack.length && /["＂]/.test(value[stack.at(-1)]) && !nestedOpening) matches.set(stack.pop(), i);
              else stack.push(i);
            }
          }
          return matches;
        }
        // Remove only boundary quote characters or pairs enclosing whitespace.
        // Never slice away non-quote content when an unmatched mark is found.
        let previous;
        do {
          previous = text;
          if (/^[“”„‟＂"]/.test(text)) {
            const end = pairs(text).get(0);
            if (end === text.length - 1) text = text.slice(1, -1).trim();
            else if (end !== undefined && !text.slice(1, end).trim()) text = text.slice(end + 1).trimStart();
            else if (end === undefined) text = text.slice(1).trimStart();
          }
          if (/[“”„‟＂"]$/.test(text)) {
            const finalBlockStart = Math.max(0, text.lastIndexOf("\n\n") + 2);
            const finalBlock = text.slice(finalBlockStart);
            const localMatch = [...pairs(finalBlock)].find(([, end]) => end === finalBlock.length - 1);
            const globalMatch = [...pairs(text)].find(([, end]) => end === text.length - 1);
            const matchStart = localMatch ? finalBlockStart + localMatch[0] : globalMatch?.[0];
            if (matchStart === undefined) text = text.slice(0, -1).trimEnd();
            else if (!(localMatch ? finalBlock.slice(localMatch[0] + 1, -1) : text.slice(matchStart + 1, -1)).trim()) text = text.slice(0, matchStart).trimEnd();
          }
        } while (text !== previous);
        return text;
      }
      function scriptSentences(block) {
        const value = String(block || "").replace(/\s*\n\s*/g, " ").trim();
        if (!value) return [];
        const sentences = [];
        // Dots inside addresses and abbreviations are not sentence boundaries.
        const protectedSpans = [...value.matchAll(/(?:https?:\/\/|www\.)[^\s<>"“”]+[^\s<>"“”.,!?;:)]|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:[A-Za-z]\.){2,}|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:\/[^\s]*)?/g)]
          .map(match => [match.index, match.index + match[0].length]);
        let start = 0;
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index];
          if (!".!?".includes(character)) continue;
          if (protectedSpans.some(([from, to]) => index >= from && index < to)) continue;
          if (character === ".") {
            const previous = value[index - 1] || "";
            const next = value[index + 1] || "";
            if (/\d/.test(previous) && /\d/.test(next)) continue;
            if (value.slice(index, index + 3) === "...") {
              index += 2;
            } else {
              const word = (value.slice(start, index).match(/[A-Za-z]+$/) || [""])[0];
              if (/^(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Rev|Jr|Sr)$/i.test(word)) continue;
            }
          }
          while (/["'”’」』）)\]]/.test(value[index + 1] || "")) index += 1;
          const sentence = value.slice(start, index + 1).trim();
          if (sentence) sentences.push(sentence);
          start = index + 1;
        }
        const tail = value.slice(start).trim();
        if (tail) sentences.push(tail);
        return sentences;
      }
      function segmentScriptParagraphs(input, maxSentences = 3, maxLength = 240) {
        const sourceBlocks = String(input || "").split(/\n\s*\n/).filter((block) => block.trim());
        const paragraphs = [];
        for (const sourceBlock of sourceBlocks) {
          const sentences = scriptSentences(sourceBlock);
          let current = [];
          let currentLength = 0;
          for (const sentence of sentences) {
            const nextLength = currentLength + (current.length ? 1 : 0) + sentence.length;
            if (current.length && (current.length >= maxSentences || nextLength > maxLength)) {
              paragraphs.push(current.join(" "));
              current = [];
              currentLength = 0;
            }
            current.push(sentence);
            currentLength += (current.length > 1 ? 1 : 0) + sentence.length;
          }
          if (current.length) paragraphs.push(current.join(" "));
        }
        return paragraphs.join("\n\n");
      }
export function cleanScriptCopy(input, options = {}) {
        const useMarkupCleanup = options.cleanMarkup !== false;
        const usePunctuationNormalization = options.normalizePunctuation !== false;
        const useSymbolCollapse = options.collapseSymbols !== false;
        const punctuation = {
          "，": ",", "。": ".", "：": ":", "；": ";", "？": "?", "！": "!",
          "（": "(", "）": ")", "【": "[", "】": "]", "《": "<", "》": ">",
          "、": "、", "…": "...", "—": "-", "–": "-",
          "‘": "'", "’": "'", "‚": "'", "‛": "'",
          "“": '"', "”": '"', "„": '"', "‟": '"', "＇": "'", "＂": '"',
        };
        let text = String(input ?? "").replace(/\r\n?/g, "\n");
        text = text.replace(/[\u00A0\u202F]/g, " ");
        text = text.replace(/[\uFEFF\u200B\u200C\u200D]/g, "");
        if (useMarkupCleanup) text = text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u20E3]/gu, "");
        // Keep the readable label while removing common Markdown wrappers.
        if (useMarkupCleanup) {
          text = text.replace(/!\[([^\]]*)\]\([^\n)]+\)/g, "$1");
          text = text.replace(/\[([^\]]+)\]\([^\n)]+\)/g, "$1");
          text = text.replace(/^\s*```[^\n]*$/gm, "");
          text = text.replace(/`([^`\n]+)`/g, "$1").replace(/`+/g, "");
          // Keep ordered-list markers: they are part of the user's script, not decoration.
          text = text.replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "");
          text = text.replace(/~~([^~\n]+)~~/g, "$1");
          text = text.replace(/(?:\*\*|__)([^\n]+?)(?:\*\*|__)/g, "$1");
          text = text.replace(/(?:\*|_)([^\n]+?)(?:\*|_)/g, "$1");
          text = text.replace(/[\*#]+/g, "");
        }
        text = removeSurplusBoundaryQuotes(text);
        // Attach closing quotes before sentence splitting. Once curly quotes are
        // normalized to straight quotes their opening/closing role is lost.
        let doubleQuoteOpen = false;
        let doubleQuoteOpening = "";
        let singleQuoteOpen = false;
        let attached = "";
        for (let index = 0; index < text.length; index += 1) {
          const character = text[index];
          const apostrophe = /['’]/.test(character)
            && /[\p{L}\p{N}]/u.test(text[index - 1] || "")
            && (/[\p{L}\p{N}]/u.test(text[index + 1] || "") || !singleQuoteOpen);
          let closing = /[”’」』]/.test(character) && !apostrophe;
          if (!apostrophe) {
            if (character === '"' || character === '＂') {
              closing = doubleQuoteOpen;
              doubleQuoteOpen = !doubleQuoteOpen;
            } else if (character === "„" || character === "‟") {
              doubleQuoteOpen = true;
              doubleQuoteOpening = character;
            } else if (character === "“") {
              closing = doubleQuoteOpen && doubleQuoteOpening === "„";
              doubleQuoteOpen = !closing;
              doubleQuoteOpening = closing ? "" : character;
            }
            else if (character === "”") doubleQuoteOpen = false;
            else if (character === "'" || character === "＇") {
              closing = singleQuoteOpen;
              singleQuoteOpen = !singleQuoteOpen;
            } else if (character === "‘") singleQuoteOpen = true;
            else if (character === "’") singleQuoteOpen = false;
          }
          const previous = text[index - 1] || "";
          const next = text[index + 1] || "";
          const word = /[\p{L}\p{N}]/u;
          if (!closing && /["＂“„‟]/.test(character) && word.test(next)
            && (word.test(previous) || /[:：]/.test(previous))) attached = attached.trimEnd() + " ";
          if (closing) attached = attached.trimEnd();
          attached += character;
          if (closing && word.test(next)) attached += " ";
        }
        text = removeSurplusBoundaryQuotes(attached);
        if (usePunctuationNormalization) text = [...text].map((character) => punctuation[character] ?? character).join("");
        if (useSymbolCollapse) text = text
          .replace(/"{2,}/g, '"')
          .replace(/'{2,}/g, "'")
          .replace(/\.{4,}/g, "...")
          .replace(/([,;:])(?:\s*\1)+/g, "$1")
          .replace(/[!?](?:\s*[!?])+/g, (run) => run.replace(/\s/g, "").at(-1));
        // A damaged saved manuscript may retain the opening quote after its
        // final `Send:` call to action but lose only the closing quote. Restore
        // that unambiguous final quote after the sentence punctuation.
        text = text.replace(/(\bSend\s*:\s*)(["“„])\s*([^"“”„‟\n]+[.!?])\s*$/u,
          (match, prefix, opening, body) => `${prefix.replace(/:\s*$/u, ": ")}"${body.trim()}"`);
        text = text.replace(/\bSend\s*:\s*"\s+([^"\n]+)"\s*$/u,
          (match, body) => `Send: "${body.trim()}"`);
        text = text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n");
        text = text.replace(/\s+([,.;:!?])/g, "$1");
        text = text.replace(/([\[(])\s+/g, "$1").replace(/\s+([\])])/g, "$1");
        text = text.replace(/\n{3,}/g, "\n\n");
        return segmentScriptParagraphs(normalizeLanguagePunctuationForScript(text.trim()));
      }
