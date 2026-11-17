import { completeGeminiReview, reviewReady } from "./ai-settings.mjs";

const TARGET_LANGUAGES = Object.freeze({
  en: "英语",
  fr: "法语",
  es: "西班牙语",
  pt: "葡萄牙语",
  de: "德语",
  it: "意大利语",
  nl: "荷兰语",
  ar: "阿拉伯语",
  ja: "日语",
  ko: "韩语",
  hi: "印地语",
  id: "印度尼西亚语",
  vi: "越南语",
  th: "泰语",
  fil: "菲律宾语",
  ru: "俄语",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁体中文",
});

function cleanModelText(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseJson(raw) {
  const cleaned = cleanModelText(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  for (const candidate of [cleaned, start >= 0 && end > start ? cleaned.slice(start, end + 1) : ""]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  throw new Error("翻译服务没有返回有效的 JSON，请重试。");
}

function protectedMarkers(text) {
  return String(text || "").match(/⟦CLIPASSIST_[A-Z0-9_]+⟧/g) || [];
}

function normalizeTranslatedRow(row, original) {
  const text = String(row?.text ?? "").trim();
  if (!text) throw new Error("译文为空。");
  const before = protectedMarkers(original.text).sort();
  const after = protectedMarkers(text).sort();
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("号码或占位符未能原样保留。");
  const spans = {};
  for (const span of original.spans) {
    const value = String(row?.spans?.[span.id] || "").trim();
    if (!value || !text.includes(value))
      throw new Error("强调样式映射失败。");
    spans[span.id] = value;
  }
  return { index: original.index, text, spans };
}

function mapRowsToPending(rows, pending) {
  const mapped = new Map();
  if (!Array.isArray(rows) || !pending.length) return mapped;
  const expected = new Set(pending.map((line) => line.index));
  for (const row of rows) {
    const index = Number(row?.index);
    if (!Number.isInteger(index) || !expected.has(index) || mapped.has(index)) continue;
    mapped.set(index, row);
  }

  if (rows.length === pending.length && rows.every((row) => String(row?.text ?? "").trim())) {
    if (mapped.size === pending.length) return mapped;
    return new Map(pending.map((line, position) => [line.index, rows[position]]));
  }

  const compactIndexes = rows.every((row, position) => Number(row?.index) === position);
  const sourceIndexesAreCompact = pending.every((line, position) => line.index === position);
  if (compactIndexes && !sourceIndexesAreCompact) return new Map();
  return mapped;
}

function rowsFromCompletion(raw) {
  const parsed = parseJson(raw);
  return Array.isArray(parsed?.lines) ? parsed.lines : [];
}

export function leadTemplateTranslationPrompt(lines, targetLanguage) {
  const target = TARGET_LANGUAGES[targetLanguage];
  if (!target) throw new Error("不支持这个模板语言。");
  return {
    system: [
      `你是专业的营销文案翻译。把每一行文案自然地翻译成${target}。`,
      "保留原意、语气、圣经学习邀请和行动号召；不要增加解释、注释或新内容。",
      "严格保持行数、行序和每行边界，不合并、不拆分、不重排。",
      "每一行的 index 是原文行号，必须原样返回，不要把行号重新从 0 编号。",
      "⟦CLIPASSIST_...⟧ 是电话号码或占位符，必须原样保留在同一行。",
      "输入 spans 中的 id 标记需要保持对应的强调含义；返回的 spans 值必须是译文中准确出现的对应词或短语。",
      "只输出 JSON：{\"lines\":[{\"index\":0,\"text\":\"译文\",\"spans\":{\"id\":\"译文中的对应词\"}}]}。",
    ].join("\n"),
    user: JSON.stringify({ targetLanguage: target, lines }),
  };
}

export async function translateLeadTemplate(
  { lines = [], targetLanguage = "fr" } = {},
  complete = completeGeminiReview,
) {
  const target = String(targetLanguage || "");
  if (!TARGET_LANGUAGES[target]) throw new Error("不支持这个模板语言。");
  if (target === "en") return { lines: (lines || []).map((line) => ({ ...line })) };
  if (!reviewReady())
    throw new Error("请先在剪辑助手的“纠正设置”中配置 Gemini、Vertex 或 Antigravity，再转换引流文案。");

  const source = (lines || []).map((line, index) => ({
    index,
    text: String(line?.text ?? ""),
    spans: Array.isArray(line?.spans) ? line.spans.map((span) => ({
      id: String(span?.id || ""),
      text: String(span?.text || ""),
    })).filter((span) => span.id && span.text) : [],
    skip: Boolean(line?.skip),
  }));
  const pending = source.filter((line) => !line.skip && line.text.trim());
  if (!pending.length) return { lines: source.map(({ index, text, spans }) => ({ index, text, spans: {} })) };

  const translated = new Map();
  const applyRows = (batch, rows) => {
    const mapped = mapRowsToPending(rows, batch);
    for (const line of batch) {
      const row = mapped.get(line.index);
      if (!row) continue;
      try {
        translated.set(line.index, normalizeTranslatedRow(row, line));
      } catch {
        // Retry only this row below instead of losing the entire template.
      }
    }
  };
  const requestRows = async (batch) => rowsFromCompletion(
    await complete(leadTemplateTranslationPrompt(batch, target)),
  );
  const requestAndApply = async (batch) => {
    try {
      applyRows(batch, await requestRows(batch));
    } catch (error) {
      if (!String(error?.message || "").includes("没有返回有效的 JSON")) throw error;
      // A malformed batch is repaired with smaller requests below.
    }
  };

  await requestAndApply(pending);
  let missing = pending.filter((line) => !translated.has(line.index));
  if (missing.length > 1) {
    await requestAndApply(missing);
    missing = pending.filter((line) => !translated.has(line.index));
  }
  for (const line of missing) {
    let row;
    try {
      const rows = await requestRows([line]);
      row = rows.find((item) => Number(item?.index) === line.index && String(item?.text ?? "").trim())
        || rows.find((item) => String(item?.text ?? "").trim());
      if (!row) throw new Error("未返回译文。");
      translated.set(line.index, normalizeTranslatedRow(row, line));
    } catch (error) {
      throw new Error(`第 ${line.index + 1} 行补译失败：${error?.message || "翻译服务未返回有效内容。"}`);
    }
  }

  return {
    lines: source.map((line) => translated.get(line.index) || {
      index: line.index,
      text: line.text,
      spans: {},
    }),
  };
}

export function templateLanguageLabels() {
  return { ...TARGET_LANGUAGES };
}
