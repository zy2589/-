import {transcriptCacheKey,readTranscriptCache,writeTranscriptCache} from './transcript-cache.mjs';
import {normalizeBibleVersionSegments} from './bible-version-casing.mjs';
import {refineSentenceTimings} from './alignment/word-timing.mjs';
import {recoverAudioOmissions} from './alignment/audio-omissions.mjs';
import {recoverUntranscribedGaps} from './alignment/audio-gaps.mjs';
import {verifyAdjacentAsrEchoes} from './alignment/asr-echoes.mjs';
import { readProtectedSecret, writeProtectedSecret } from './secret-store.mjs';
import { seedUserPreference } from './user-seeds.mjs';
import { pendingCaptionPlan } from './alignment/pending.mjs';
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  alignScript,
  buildCaptions,
  buildReviewCaptions,
  manuscriptCaptionWords,
  referenceCaptionWords,
  manuscriptPunctuationWords,
  normalizeWord,
  displayWords,
} from "./alignment.mjs";
import { captionMatchLineLimit } from "./text-layout.mjs";
import { normalizeScriptureReferences } from "./scripture-references.mjs";
import { speechLanguageForManuscript } from "./manuscript-language.mjs";
import { mediaBinary, supportRoot } from "./media.mjs";
import { mapSourceTime, mergeRanges } from "./pausecut.mjs";
import { extractArchive, isWindows } from "./platform.mjs";
import {
  completeGeminiTranscription,
  GEMINI_SPEECH_MODEL,
  geminiTranscriptionReady,
  reviewReady,
} from "./ai-settings.mjs";
import {
  applyJudgeDecisions,
  blockingScriptureIssues,
  buildGlobalPolishPlan,
  buildReviewCompareRecord,
  formatGlobalPolishSummary,
  judgeAlignmentIssues,
  normalizeReviewMode,
  writeReviewCompareLog,
} from "./script-judge.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const downloads = new Map();
const analyses = new Map();
const autoCaptionAnalyses = new Map();
function logSpeechJob(job,event,details={}){
  try{
    const directory=path.join(supportRoot(),'logs');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    fs.appendFileSync(path.join(directory,'transcription-jobs.jsonl'),JSON.stringify({
      at:new Date().toISOString(),event,jobId:String(job?.id||''),kind:String(job?.kind||'script'),
      engine:String(job?.engine||''),forceRecognition:Boolean(job?.forceRecognition),
      manuscriptLanguage:String(job?.manuscriptLanguage||''),speechLanguage:String(job?.speechLanguage||''),
      recognitionChunkCount:Number(job?.recognitionChunkCount||0),recognitionChunkSeconds:Number(job?.recognitionChunkSeconds||0),
      cacheDecision:String(job?.cacheDecision||'unknown'),...details,
    })+'\n',{encoding:'utf8',mode:0o600});
  }catch{/* diagnostics must never interrupt transcription */}
}
function transcriptCacheSettings(languageOverride = ""){const settings=loadSpeechSettings();return {...settings,speechLanguage:languageOverride||settings.speechLanguage,geminiSpeechModel:settings.engine==='gemini'?GEMINI_SPEECH_MODEL:'',deepgramChunkSeconds:settings.engine==='deepgram'?DEEPGRAM_CHUNK_SECONDS:undefined};}
export { finalizeScriptAnalysis, finalizeAutoCaptionAnalysis };
const HF_WHISPER =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const LOCAL_WHISPER_MODELS = [
  {
    id: "small-en",
    file: "ggml-small.en.bin",
    label: "Small English",
    hint: "约 470MB，快。口播草稿可以，卡壳和经文容易听错。",
    sizeLabel: "约 470MB",
    minBytes: 350_000_000,
    language: "en",
    englishOnly: true,
    dtwPreset: "SmallEn",
    recommended: false,
  },
  {
    id: "medium-en",
    file: "ggml-medium.en.bin",
    label: "Medium English",
    hint: "约 1.5GB，英文专用。口播、口吃比 Small 稳。",
    sizeLabel: "约 1.5GB",
    minBytes: 1_200_000_000,
    language: "en",
    englishOnly: true,
    dtwPreset: "MediumEn",
    recommended: false,
  },
  {
    id: "turbo-q5",
    file: "ggml-large-v3-turbo-q5_0.bin",
    label: "Large v3 Turbo Q5（推荐）",
    hint: "约 550MB。快，质量和 Large v3 接近，口播对齐默认用这个。",
    sizeLabel: "约 550MB",
    minBytes: 400_000_000,
    language: "en",
    englishOnly: false,
    dtwPreset: "LargeV3",
    recommended: true,
  },
  {
    id: "large-v3-q5",
    file: "ggml-large-v3-q5_0.bin",
    label: "Large v3 Q5（最高质量）",
    hint: "约 1.0GB，完整 Large v3。词更准，速度慢一截。",
    sizeLabel: "约 1.0GB",
    minBytes: 800_000_000,
    language: "en",
    englishOnly: false,
    dtwPreset: "LargeV3",
    recommended: false,
  },
];

export const SPEECH_LANGUAGES = [
  { id: "auto", label: "自动检测", english: "auto", aliases: ["detect", "自动"] },
  { id: "en", label: "英语（默认）", english: "english", aliases: ["英文", "english"] },
  { id: "zh", label: "中文（普通话）", english: "chinese", aliases: ["汉语", "国语", "普通话", "mandarin", "zh-cn", "zh-tw", "cn"] },
  { id: "yue", label: "粤语", english: "cantonese", aliases: ["广东话", "cantonese"] },
  { id: "ja", label: "日语", english: "japanese", aliases: ["日本語", "日文"] },
  { id: "ko", label: "韩语", english: "korean", aliases: ["한국어", "朝鲜语"] },
  { id: "es", label: "西班牙语", english: "spanish", aliases: ["español"] },
  { id: "fr", label: "法语", english: "french", aliases: ["français"] },
  { id: "de", label: "德语", english: "german", aliases: ["deutsch"] },
  { id: "pt", label: "葡萄牙语", english: "portuguese", aliases: ["português"] },
  { id: "ru", label: "俄语", english: "russian", aliases: ["русский"] },
  { id: "it", label: "意大利语", english: "italian", aliases: ["italiano"] },
  { id: "ar", label: "阿拉伯语", english: "arabic" },
  { id: "hi", label: "印地语", english: "hindi" },
  { id: "id", label: "印尼语", english: "indonesian" },
  { id: "vi", label: "越南语", english: "vietnamese", aliases: ["tiếng việt"] },
  { id: "th", label: "泰语", english: "thai" },
  { id: "tr", label: "土耳其语", english: "turkish" },
  { id: "pl", label: "波兰语", english: "polish" },
  { id: "nl", label: "荷兰语", english: "dutch" },
  { id: "sv", label: "瑞典语", english: "swedish" },
  { id: "uk", label: "乌克兰语", english: "ukrainian" },
  { id: "el", label: "希腊语", english: "greek" },
  { id: "he", label: "希伯来语", english: "hebrew" },
  { id: "cs", label: "捷克语", english: "czech" },
  { id: "ro", label: "罗马尼亚语", english: "romanian" },
  { id: "da", label: "丹麦语", english: "danish" },
  { id: "fi", label: "芬兰语", english: "finnish" },
  { id: "hu", label: "匈牙利语", english: "hungarian" },
  { id: "no", label: "挪威语", english: "norwegian" },
  { id: "nn", label: "新挪威语", english: "nynorsk" },
  { id: "ms", label: "马来语", english: "malay" },
  { id: "ta", label: "泰米尔语", english: "tamil" },
  { id: "te", label: "泰卢固语", english: "telugu" },
  { id: "ur", label: "乌尔都语", english: "urdu" },
  { id: "fa", label: "波斯语", english: "persian", aliases: ["farsi"] },
  { id: "bn", label: "孟加拉语", english: "bengali" },
  { id: "pa", label: "旁遮普语", english: "punjabi" },
  { id: "mr", label: "马拉地语", english: "marathi" },
  { id: "gu", label: "古吉拉特语", english: "gujarati" },
  { id: "kn", label: "卡纳达语", english: "kannada" },
  { id: "ml", label: "马拉雅拉姆语", english: "malayalam" },
  { id: "si", label: "僧伽罗语", english: "sinhala" },
  { id: "ne", label: "尼泊尔语", english: "nepali" },
  { id: "as", label: "阿萨姆语", english: "assamese" },
  { id: "sa", label: "梵语", english: "sanskrit" },
  { id: "my", label: "缅甸语", english: "myanmar", aliases: ["burmese"] },
  { id: "km", label: "高棉语", english: "khmer", aliases: ["柬埔寨语"] },
  { id: "lo", label: "老挝语", english: "lao" },
  { id: "bo", label: "藏语", english: "tibetan" },
  { id: "ka", label: "格鲁吉亚语", english: "georgian" },
  { id: "hy", label: "亚美尼亚语", english: "armenian" },
  { id: "az", label: "阿塞拜疆语", english: "azerbaijani" },
  { id: "kk", label: "哈萨克语", english: "kazakh" },
  { id: "uz", label: "乌兹别克语", english: "uzbek" },
  { id: "mn", label: "蒙古语", english: "mongolian" },
  { id: "tg", label: "塔吉克语", english: "tajik" },
  { id: "tk", label: "土库曼语", english: "turkmen" },
  { id: "tt", label: "鞑靼语", english: "tatar" },
  { id: "ba", label: "巴什基尔语", english: "bashkir" },
  { id: "be", label: "白俄罗斯语", english: "belarusian" },
  { id: "bg", label: "保加利亚语", english: "bulgarian" },
  { id: "sr", label: "塞尔维亚语", english: "serbian" },
  { id: "hr", label: "克罗地亚语", english: "croatian" },
  { id: "bs", label: "波斯尼亚语", english: "bosnian" },
  { id: "sl", label: "斯洛文尼亚语", english: "slovenian" },
  { id: "sk", label: "斯洛伐克语", english: "slovak" },
  { id: "lt", label: "立陶宛语", english: "lithuanian" },
  { id: "lv", label: "拉脱维亚语", english: "latvian" },
  { id: "et", label: "爱沙尼亚语", english: "estonian" },
  { id: "mk", label: "马其顿语", english: "macedonian" },
  { id: "sq", label: "阿尔巴尼亚语", english: "albanian" },
  { id: "ca", label: "加泰罗尼亚语", english: "catalan" },
  { id: "gl", label: "加利西亚语", english: "galician" },
  { id: "eu", label: "巴斯克语", english: "basque" },
  { id: "cy", label: "威尔士语", english: "welsh" },
  { id: "is", label: "冰岛语", english: "icelandic" },
  { id: "fo", label: "法罗语", english: "faroese" },
  { id: "mt", label: "马耳他语", english: "maltese" },
  { id: "lb", label: "卢森堡语", english: "luxembourgish" },
  { id: "br", label: "布列塔尼语", english: "breton" },
  { id: "oc", label: "奥克语", english: "occitan" },
  { id: "la", label: "拉丁语", english: "latin" },
  { id: "yi", label: "意第绪语", english: "yiddish" },
  { id: "af", label: "南非荷兰语", english: "afrikaans" },
  { id: "sw", label: "斯瓦希里语", english: "swahili" },
  { id: "am", label: "阿姆哈拉语", english: "amharic" },
  { id: "ha", label: "豪萨语", english: "hausa" },
  { id: "yo", label: "约鲁巴语", english: "yoruba" },
  { id: "so", label: "索马里语", english: "somali" },
  { id: "sn", label: "绍纳语", english: "shona" },
  { id: "ln", label: "林加拉语", english: "lingala" },
  { id: "mg", label: "马尔加什语", english: "malagasy" },
  { id: "ht", label: "海地克里奥尔语", english: "haitian creole" },
  { id: "tl", label: "他加禄语", english: "tagalog", aliases: ["菲律宾语", "filipino"] },
  { id: "jw", label: "爪哇语", english: "javanese" },
  { id: "su", label: "巽他语", english: "sundanese" },
  { id: "mi", label: "毛利语", english: "maori" },
  { id: "haw", label: "夏威夷语", english: "hawaiian" },
  { id: "sd", label: "信德语", english: "sindhi" },
  { id: "ps", label: "普什图语", english: "pashto" },
];

export function normalizeSpeechLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (SPEECH_LANGUAGES.some((item) => item.id === raw)) return raw;
  const alias = SPEECH_LANGUAGES.find((item) =>
    (item.aliases || []).some((name) => String(name).toLowerCase() === raw),
  );
  if (alias) return alias.id;
  return "en";
}

export function filterSpeechLanguages(query, languages = SPEECH_LANGUAGES) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return languages;
  return languages.filter((item) => {
    const hay = [item.id, item.label, item.english, ...(item.aliases || [])]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function speechLanguage() {
  return loadSpeechSettings().speechLanguage || "en";
}

function resolveSpeechLanguage(script, configuredLanguage, manuscriptLanguage = "") {
  const selected = String(manuscriptLanguage || "").trim();
  return selected ? normalizeSpeechLanguage(selected) : speechLanguageForManuscript(script, configuredLanguage);
}

const DEFAULT_LOCAL_WHISPER = "turbo-q5";

export function normalizeLocalWhisperModel(value) {
  if (LOCAL_WHISPER_MODELS.some((item) => item.id === value)) return value;
  if (value === "local" || value === "turbo" || value === "whisper-turbo")
    return "turbo-q5";
  return DEFAULT_LOCAL_WHISPER;
}

export function localWhisperSpec(id = "") {
  const normalized = normalizeLocalWhisperModel(id);
  return LOCAL_WHISPER_MODELS.find((item) => item.id === normalized);
}

export function modelPath(id = "") {
  const spec = localWhisperSpec(id || loadSpeechSettings().localModel);
  return path.join(supportRoot(), "models", spec.file);
}

function modelHeaderValid(file) {
  if (!file || !fs.existsSync(file)) return false;
  const header = Buffer.alloc(16);
  const handle = fs.openSync(file, "r");
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  return !header.toString("utf8").trimStart().startsWith("<");
}

function modelFileComplete(file, minBytes = 400_000_000) {
  return (
    !!file &&
    fs.existsSync(file) &&
    fs.statSync(file).size > minBytes &&
    modelHeaderValid(file)
  );
}

const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_STT_MODEL = "whisper-large-v3";
const GROQ_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const GROQ_CHUNK_SECONDS = 480;
const GROQ_CHUNK_OVERLAP = 1.2;
const GEMINI_CHUNK_SECONDS = 360;
const GEMINI_CHUNK_OVERLAP = 1.5;
const GEMINI_MAX_INLINE_BYTES = 16 * 1024 * 1024;
const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_STT_MODEL = "nova-3";
// Shorter requests avoid Nova-3 drifting into phonetic or unrelated words on
// ordinary multi-minute clips. The overlap preserves words across boundaries.
const DEEPGRAM_CHUNK_SECONDS = 40;
const DEEPGRAM_CHUNK_OVERLAP = 1.2;

function groqKeyFile() {
  const directory = path.join(supportRoot(), "secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, "groq-api-key.txt");
}

function maskSecret(value) {
  const key = String(value || "");
  if (key.length < 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function getGroqApiKey() {
  const fromEnv = String(process.env.GROQ_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readProtectedSecret(groqKeyFile());
  } catch {
    return "";
  }
}

export function groqKeyStatus() {
  const key = getGroqApiKey();
  const configured = key.length >= 20;
  return {
    configured,
    source: String(process.env.GROQ_API_KEY || "").trim()
      ? "env"
      : configured
        ? "file"
        : "none",
    hint: configured ? maskSecret(key) : "",
  };
}

export function saveGroqApiKey(value) {
  const key = String(value || "").replace(/\s+/g, "").trim();
  if (!key) throw new Error("请粘贴 Groq API Key。");
  if (key.length < 20) throw new Error("Groq API Key 看起来不完整。");
  writeProtectedSecret(groqKeyFile(), key);
  return groqKeyStatus();
}

export function clearGroqApiKey() {
  try {
    fs.unlinkSync(groqKeyFile());
  } catch {
    /* already absent */
  }
  return groqKeyStatus();
}

function deepgramKeyFile() {
  const directory = path.join(supportRoot(), "secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, "deepgram-api-key.txt");
}

export function getDeepgramApiKey() {
  const fromEnv = String(process.env.DEEPGRAM_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readProtectedSecret(deepgramKeyFile());
  } catch {
    return "";
  }
}

export function deepgramKeyStatus() {
  const key = getDeepgramApiKey();
  const configured = key.length >= 16;
  return {
    configured,
    source: String(process.env.DEEPGRAM_API_KEY || "").trim()
      ? "env"
      : configured
        ? "file"
        : "none",
    hint: configured ? maskSecret(key) : "",
  };
}

export function saveDeepgramApiKey(value) {
  const key = String(value || "").replace(/\s+/g, "").trim();
  if (!key) throw new Error("请粘贴 Deepgram API Key。");
  if (key.length < 16) throw new Error("Deepgram API Key 看起来不完整。");
  writeProtectedSecret(deepgramKeyFile(), key);
  return deepgramKeyStatus();
}

export function clearDeepgramApiKey() {
  try {
    fs.unlinkSync(deepgramKeyFile());
  } catch {
    /* already absent */
  }
  return deepgramKeyStatus();
}

function normalizeSpeechEngine(value) {
  if (value === "gemini" || value === "deepgram" || value === "groq" || value === "local")
    return value;
  return "deepgram";
}

export function localModelInstalled(id = "") {
  const spec = localWhisperSpec(id || loadSpeechSettings().localModel);
  return modelFileComplete(modelPath(spec.id), spec.minBytes);
}

export function listLocalWhisperModels() {
  return LOCAL_WHISPER_MODELS.map((item) => ({
    ...item,
    url: `${HF_WHISPER}/${item.file}`,
    installed: modelFileComplete(
      path.join(supportRoot(), "models", item.file),
      item.minBytes,
    ),
  }));
}

function speechSettingsPath() {
  const directory = path.join(supportRoot(), "secrets");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "speech-settings.json");
  seedUserPreference(file, "speech-settings.json");
  return file;
}

export function loadSpeechSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(speechSettingsPath(), "utf8"));
  } catch {
    stored = {};
  }
  return {
    engine: normalizeSpeechEngine(stored.engine),
    localModel: normalizeLocalWhisperModel(stored.localModel),
    speechLanguage: normalizeSpeechLanguage(stored.speechLanguage),
  };
}

export function saveSpeechSettings(input = {}) {
  const current = loadSpeechSettings();
  const next = {
    engine: input.engine ? normalizeSpeechEngine(input.engine) : current.engine,
    localModel: input.localModel
      ? normalizeLocalWhisperModel(input.localModel)
      : current.localModel,
    speechLanguage: input.speechLanguage
      ? normalizeSpeechLanguage(input.speechLanguage)
      : current.speechLanguage,
  };
  fs.writeFileSync(speechSettingsPath(), JSON.stringify(next, null, 2), { mode: 0o600, encoding: "utf8" });
  return speechStatus();
}

export function speechStatus() {
  const settings = loadSpeechSettings();
  const groq = groqKeyStatus();
  const deepgram = deepgramKeyStatus();
  const gemini = geminiTranscriptionReady();
  const localInstalled = localModelInstalled();
  const ready =
    settings.engine === "gemini"
      ? gemini
      : settings.engine === "deepgram"
        ? deepgram.configured
        : settings.engine === "local"
          ? localInstalled
          : groq.configured;
  const spec = localWhisperSpec(settings.localModel);
  return {
    engine: settings.engine,
    groq,
    deepgram,
    gemini: { configured: gemini, model: GEMINI_SPEECH_MODEL },
    localModel: spec.id,
    localModels: listLocalWhisperModels(),
    localInstalled,
    speechLanguage: settings.speechLanguage,
    speechLanguages: SPEECH_LANGUAGES,
    ready,
  };
}

export function canTranscribe() {
  const settings = loadSpeechSettings();
  if (settings.engine === "gemini") return geminiTranscriptionReady();
  if (settings.engine === "deepgram") return Boolean(getDeepgramApiKey());
  if (settings.engine === "local") return localModelInstalled();
  return Boolean(getGroqApiKey());
}

function assertSpeechModelSupportsLanguage(engine, language, modelId = "") {
  if (engine !== "local") return;
  const spec = localWhisperSpec(modelId || loadSpeechSettings().localModel);
  if (spec.englishOnly && language !== "en") {
    throw new Error(`当前本地模型“${spec.label}”仅支持英语。请切换到多语言本地模型，或选择 Groq、Deepgram、Gemini 等听写服务后再匹配。`);
  }
}

export function modelStatus() {
  const target = modelPath();
  const exists = fs.existsSync(target);
  const partial = `${target}.download`;
  const speech = speechStatus();
  const groq = speech.groq;
  const deepgram = speech.deepgram;
  const localInstalled = speech.localInstalled;
  const preferred = speech.engine;
  const geminiReady = preferred === "gemini" && speech.gemini.configured;
  const deepgramReady = preferred === "deepgram" && deepgram.configured;
  const groqReady = preferred === "groq" && groq.configured;
  const localReady = preferred === "local" && localInstalled;
  const engine = geminiReady
    ? "gemini"
    : deepgramReady
      ? "deepgram"
      : groqReady
        ? "groq"
        : localReady
          ? "local"
          : "none";
  const ready = geminiReady || deepgramReady || groqReady || localReady;
  return {
    installed: ready,
    localInstalled,
    ready,
    engine,
    preferredEngine: preferred,
    groq,
    deepgram,
    gemini: speech.gemini,
    path: target,
    name:
      engine === "gemini"
        ? GEMINI_SPEECH_MODEL
        : engine === "deepgram"
          ? "Deepgram Nova-3"
          : engine === "groq"
            ? "Groq Whisper"
            : engine === "local"
              ? `本地 ${localWhisperSpec(speech.localModel).label}`
              : "Whisper",
    expectedSize: localWhisperSpec(speech.localModel).sizeLabel,
    localModel: speech.localModel,
    localModels: speech.localModels,
    speechLanguage: speech.speechLanguage,
    speechLanguages: speech.speechLanguages,
    partialBytes: fs.existsSync(partial) ? fs.statSync(partial).size : 0,
  };
}

export function startModelDownload(input = {}) {
  const spec = localWhisperSpec(input.model || loadSpeechSettings().localModel);
  for (const job of downloads.values())
    if (["starting", "downloading"].includes(job.state))
      return { jobId: job.id };
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const job = {
    id,
    state: "starting",
    progress: 0,
    received: 0,
    total: 0,
    error: "",
    controller,
    model: spec.id,
  };
  downloads.set(id, job);
  (async () => {
    try {
      const destination = modelPath(spec.id);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const partial = `${destination}.download`;
      const existing = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      if (modelFileComplete(partial, spec.minBytes)) {
        fs.renameSync(partial, destination);
        job.state = "completed";
        job.progress = 1;
        return;
      }
      const response = await fetch(`${HF_WHISPER}/${spec.file}`, {
        redirect: "follow",
        signal: controller.signal,
        headers: existing ? { Range: `bytes=${existing}-` } : {},
      });
      if (!response.ok || !response.body)
        throw new Error(`模型下载失败（${response.status}）`);
      const resumed = existing > 0 && response.status === 206;
      const offset = resumed ? existing : 0;
      if (existing && !resumed) fs.rmSync(partial, { force: true });
      job.received = offset;
      job.total = offset + Number(response.headers.get("content-length") || 0);
      job.state = "downloading";
      const source = Readable.fromWeb(response.body);
      source.on("data", (chunk) => {
        job.received += chunk.length;
        if (job.total) job.progress = job.received / job.total;
      });
      await pipeline(
        source,
        fs.createWriteStream(partial, {
          mode: 0o600,
          flags: resumed ? "a" : "w",
        }),
      );
      if (fs.statSync(partial).size < spec.minBytes)
        throw new Error("下载的模型文件不完整，请重试。");
      if (!modelHeaderValid(partial)) {
        fs.rmSync(partial, { force: true });
        throw new Error("下载内容不是有效模型，请重试。");
      }
      fs.renameSync(partial, destination);
      job.state = "completed";
      job.progress = 1;
    } catch (error) {
      job.state = error.name === "AbortError" ? "cancelled" : "failed";
      job.error = error.message;
    }
  })();
  return { jobId: id };
}

export function modelDownloadStatus(jobId) {
  const job = downloads.get(String(jobId || ""));
  if (!job) throw new Error("模型下载任务已经不存在。");
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    received: job.received,
    total: job.total,
    error: job.error,
  };
}

export function cancelModelDownload(jobId) {
  const job = downloads.get(String(jobId || ""));
  if (!job) return false;
  job.controller.abort();
  return true;
}

function parseSeconds(value) {
  const match = String(value).match(/^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  return match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : null;
}

export function parseTimestampLine(line) {
  const clean = String(line || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
  const match = clean.match(
    /^\[\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*-->\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\s*\]\s*(.+)$/,
  );
  if (!match) return null;
  const start = parseSeconds(match[1]);
  const end = parseSeconds(match[2]);
  if (start === null || end === null || end <= start || !match[3].trim())
    return null;
  return { text: match[3].trim(), start, end };
}

function workerPath() {
  return path.join(moduleDir, "whisper-worker.mjs");
}

const WHISPER_CLI_URL =
  "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
const WHISPER_CLI_SHA256 = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a";
const WHISPER_CLI_MAX_BYTES = 64 * 1024 * 1024;

export function isWhisperCliArchiveDigestValid(digest) {
  return String(digest || "").toLowerCase() === WHISPER_CLI_SHA256;
}

function findWhisperCli(root) {
  if (!root || !fs.existsSync(root)) return "";
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (/^whisper-cli(\.exe)?$/i.test(entry.name)) return absolute;
    }
  }
  return "";
}

export function whisperCliPath() {
  return (
    process.env.CLIPASSIST_WHISPER_CLI ||
    findWhisperCli(path.join(supportRoot(), "whisper-cli")) ||
    findWhisperCli(path.resolve(moduleDir, "../../../media/whisper-cli"))
  );
}

function canUseNapiWhisper() {
  if (isWindows) return false;
  try {
    import.meta.resolve("@napi-rs/whisper");
    return true;
  } catch {
    return false;
  }
}

export async function ensureWhisperCli() {
  const existing = whisperCliPath();
  if (existing) return existing;
  const directory = path.join(supportRoot(), "whisper-cli");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const zipPath = path.join(directory, `whisper-bin-x64-${crypto.randomUUID()}.zip`);
  const response = await fetch(WHISPER_CLI_URL, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`无法下载 Windows 语音识别组件（${response.status}）。`);
  const digest = crypto.createHash("sha256");
  let downloaded = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, encoding, callback) {
          downloaded += chunk.length;
          if (downloaded > WHISPER_CLI_MAX_BYTES) {
            callback(new Error("Windows 语音识别组件下载超过安全大小限制。"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(zipPath, { flags: "wx", mode: 0o600 }),
    );
    if (!isWhisperCliArchiveDigestValid(digest.digest("hex")))
      throw new Error("Windows 语音识别组件校验失败，已拒绝安装。请稍后重试或联系开发者。");
    extractArchive(zipPath, directory);
  } finally {
    try { fs.unlinkSync(zipPath); } catch { /* remove partial download when possible */ }
  }
  const resolved = findWhisperCli(directory);
  if (!resolved) throw new Error("Windows 语音识别组件下载后无法找到 whisper-cli。");
  return resolved;
}

function groqSegmentUsable(row) {
  const noSpeech = Number(row?.no_speech_prob);
  const confidence = Number(row?.avg_logprob);
  if (Number.isFinite(noSpeech) && noSpeech >= 0.45) return false;
  if (Number.isFinite(confidence) && confidence <= -0.85) return false;
  return true;
}

function groqToken(entry) {
  return {
    text: String(entry?.word || entry?.text || "").trim(),
    start: Number(entry?.start || 0),
    end: Number(entry?.end || entry?.start || 0),
  };
}

export function parseGroqTranscription(data, offset = 0) {
  const shift = Math.max(0, Number(offset || 0));
  const toSegment = (text, start, end) => {
    const clean = String(text || "").trim();
    if (!clean || !Number.isFinite(start)) return null;
    return {
      text: clean,
      start: shift + start,
      end: Math.max(shift + start + 0.04, shift + end),
      timebase: "seconds",
    };
  };
  const rows = Array.isArray(data?.segments) ? data.segments.filter(groqSegmentUsable) : [];
  const words = Array.isArray(data?.words) ? data.words.map(groqToken).filter((item) => item.text) : [];
  if (rows.length) {
    const output = [];
    for (const row of rows) {
      const start = Number(row.start || 0);
      const end = Number(row.end || row.start || 0);
      const inside = words.filter((word) => {
        const mid = (word.start + Math.max(word.start, word.end)) / 2;
        return mid >= start - 0.03 && mid <= end + 0.03;
      });
      const averageLength =
        inside.reduce((sum, word) => sum + word.text.length, 0) / Math.max(1, inside.length);
      if (inside.length >= 2 && averageLength >= 2) {
        for (const word of inside) {
          const item = toSegment(word.text, word.start, word.end);
          if (item) output.push(item);
        }
      } else {
        const item = toSegment(row.text, start, end);
        if (item) output.push(item);
      }
    }
    if (output.length) return output;
  }
  return words
    .map((word) => toSegment(word.text, word.start, word.end))
    .filter(Boolean);
}

export function tightenTranscriptWordTimes(segments = []) {
  const words = (segments || []).map((item) => ({ ...item }));
  words.sort(
    (left, right) =>
      Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end),
  );
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const next = words[index + 1];
    const text = String(word.text || "").trim();
    const letters = text.replace(/[^\p{L}\p{N}']+/gu, "");
    const tokens = text.split(/\s+/).filter(Boolean).length || 1;
    const closes = /[.!?…]["'”’)]*$/.test(text);
    const maxDur =
      Math.min(0.28 + tokens * 0.42, Math.max(0.16, 0.1 + letters.length * 0.052 + tokens * 0.08)) +
      (closes ? 0.2 : 0);
    const start = Number(word.start);
    if (!Number.isFinite(start)) continue;
    let end = Number(word.end);
    if (!Number.isFinite(end) || end <= start) end = start + Math.min(0.32, maxDur);
    // Keep the recognizer's measured endpoint.
    if (next && Number.isFinite(Number(next.start))) end = Math.min(end, Number(next.start) - 0.012);
    word.end = Math.max(start + 0.04, end);
  }
  return words;
}

export function manuscriptRecognitionPrompt(script = "", startRatio = 0, spanRatio = 1, language = speechLanguage()) {
  const words = lexicalWords(script);
  const languageName = SPEECH_LANGUAGES.find((item) => item.id === language)?.english || "the detected language";
  if (!words.length) return `Clear spoken ${languageName} speech.`;
  const start = Math.max(0, Math.min(words.length - 1, Math.floor(words.length * startRatio) - 30));
  const desired = Math.max(90, Math.min(190, Math.ceil(words.length * Math.max(0.08, spanRatio)) + 60));
  const excerpt = words.slice(start, start + desired).join(" ");
  return `Clear spoken ${languageName} transcript. Keep the original language and wording. Expected vocabulary and wording: ${excerpt}`.slice(0, 1200);
}

export function parseTimestampSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const clock = text.match(/^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (clock) {
    const hours = clock[1] ? Number(clock[1]) : 0;
    return hours * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const minutes = text.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  return Number.NaN;
}

export function parseGeminiTranscription(data, offset = 0) {
  const shift = Math.max(0, Number(offset || 0));
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = { text: payload };
    }
  }
  const toSegment = (text, startValue, endValue) => {
    const clean = String(text || "").trim();
    const start = parseTimestampSeconds(startValue);
    const end = parseTimestampSeconds(endValue);
    if (!clean || !Number.isFinite(start)) return null;
    return {
      text: clean,
      start: shift + start,
      end: Math.max(shift + start + 0.04, shift + (Number.isFinite(end) ? end : start + 0.35)),
      timebase: "seconds",
    };
  };
  const rows = [
    ...(payload?.segments || []),
    ...(payload?.words || []),
  ];
  const output = [];
  for (const row of rows) {
    const words = Array.isArray(row?.words) ? row.words : [];
    if (words.length >= 2) {
      for (const word of words) {
        const item = toSegment(word.text || word.word, word.start ?? word.start_time, word.end ?? word.end_time);
        if (item) output.push(item);
      }
      continue;
    }
    const item = toSegment(
      row?.text || row?.content || row?.word,
      row?.start ?? row?.start_time ?? row?.timestamp,
      row?.end ?? row?.end_time,
    );
    if (item) output.push(item);
  }
  if (output.length) return output;
  const fallback = String(payload?.text || "").trim();
  return fallback ? [toSegment(fallback, 0, 0.5)].filter(Boolean) : [];
}

const GEMINI_STT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
          words: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                start: { type: "number" },
                end: { type: "number" },
              },
              required: ["text", "start", "end"],
            },
          },
        },
        required: ["start", "end", "text"],
      },
    },
  },
  required: ["segments"],
};

async function geminiTranscribeFile(filePath, { signal, language = speechLanguage(), script = "" } = {}) {
  if (!geminiTranscriptionReady()) throw new Error("请在纠正设置里保存 Gemini API Key，或配置 Vertex 凭证。Antigravity 仅用于文稿纠正。");
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length > GEMINI_MAX_INLINE_BYTES)
    throw new Error("这段音频太大，请把视频剪短后再用 Gemini 听写。");
  const raw = await completeGeminiTranscription({
    model: GEMINI_SPEECH_MODEL,
    system:
      `You are a multilingual speech-to-text engine. Detect the language spoken in the audio${language && language !== "auto" ? `; it is expected to be ${SPEECH_LANGUAGES.find((item) => item.id === language)?.english || language}` : ""}. Transcribe verbatim in that same language. Keep restarts, repeated words, false starts, and fillers. Do not translate, summarize, or silently correct grammar. Capitalize proper nouns correctly, including God, Jesus, Christ, Lord, Bible, Scripture, and Holy Spirit. Preserve the speaker's words exactly.${script ? ` Expected vocabulary and wording from the manuscript: ${lexicalWords(script).slice(0, 150).join(" ")}` : ""}`,
    input: [
      {
        type: "text",
        text: "Transcribe this audio. Return JSON only with seconds as numbers: {\"text\":\"...\",\"segments\":[{\"start\":0,\"end\":1.2,\"text\":\"...\",\"words\":[{\"text\":\"...\",\"start\":0,\"end\":0.3}]}]}. Do not use MM:SS.",
      },
      {
        type: "audio",
        mime_type: String(filePath).toLowerCase().endsWith(".flac") ? "audio/flac" : "audio/wav",
        data: bytes.toString("base64"),
      },
    ],
    signal,
    responseSchema: GEMINI_STT_SCHEMA,
  });
  return raw;
}

export async function transcribeWithGemini(
  audioPath,
  { duration = 0, job = null, signal = null, language = speechLanguage(), script = "" } = {},
) {
  const totalDuration = Math.max(0.04, Number(duration || 0.04));
  const size = fs.statSync(audioPath).size;
  const needChunks =
    size > GEMINI_MAX_INLINE_BYTES || totalDuration > GEMINI_CHUNK_SECONDS + 20;
  if (!needChunks) {
    if (job) job.progress = 0.22;
    const raw = await geminiTranscribeFile(audioPath, { signal, language, script });
    if (job) job.progress = 0.86;
    const segments = parseGeminiTranscription(raw.text, 0);
    return {
      segments,
      fallbackText: segments.map((item) => item.text).join(" "),
      model: raw.model,
    };
  }
  const segments = [];
  const models = new Set();
  const directory = path.dirname(audioPath);
  let index = 0;
  for (
    let start = 0;
    start < totalDuration;
    start += GEMINI_CHUNK_SECONDS - GEMINI_CHUNK_OVERLAP, index += 1
  ) {
    if (signal?.aborted || job?.state === "cancelled") throw new Error("cancelled");
    const length = Math.min(GEMINI_CHUNK_SECONDS, totalDuration - start);
    if (length < 0.25) break;
    const chunkPath = path.join(directory, `gemini-chunk-${index}.flac`);
    await extractAudioSlice(audioPath, chunkPath, start, length);
    if (job) job.progress = 0.14 + Math.min(0.7, (start / totalDuration) * 0.7);
    try {
      const raw = await geminiTranscribeFile(chunkPath, { signal, language, script });
      segments.push(...parseGeminiTranscription(raw.text, start));
      if (raw.model) models.add(raw.model);
    } finally {
      try {
        fs.unlinkSync(chunkPath);
      } catch {
        /* temp chunk */
      }
    }
  }
  if (job) job.progress = 0.88;
  return {
    segments,
    fallbackText: segments.map((item) => item.text).join(" "),
    model: [...models].join(" + "),
  };
}

export function parseDeepgramTranscription(data, offset = 0) {
  const shift = Math.max(0, Number(offset || 0));
  const toSegment = (text, start, end) => {
    const clean = String(text || "").trim();
    if (!clean || !Number.isFinite(Number(start))) return null;
    return {
      text: clean,
      start: shift + Number(start),
      end: Math.max(shift + Number(start) + 0.04, shift + Number(end || start)),
      timebase: "seconds",
    };
  };
  const alternative = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  const words = Array.isArray(alternative.words) ? alternative.words : [];
  const utterances = Array.isArray(data?.results?.utterances) ? data.results.utterances : [];
  if (words.length) {
    const output = words
      .map((word) =>
        toSegment(word.punctuated_word || word.word || word.text, word.start, word.end),
      )
      .filter(Boolean);
    // Deepgram can occasionally omit a complete utterance from `words` while
    // still returning it in the utterance list. Merge only utterances with no
    // word midpoint in their span so we recover real gaps without duplicating
    // normal word-level output.
    for (const row of utterances) {
      const start = Number(row?.start);
      const end = Number(row?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const covered = output.some((word) => {
        const midpoint = (Number(word.start) + Number(word.end)) / 2 - shift;
        return midpoint >= start - 0.04 && midpoint <= end + 0.04;
      });
      if (!covered) {
        const recovered = toSegment(row.transcript || row.text, start, end);
        if (recovered) output.push({ ...recovered, recoveredFromUtterance: true });
      }
    }
    output.sort((left, right) => left.start - right.start || left.end - right.end);
    if (output.length) return output;
  }
  if (utterances.length) {
    const output = utterances
      .map((row) => toSegment(row.transcript || row.text, row.start, row.end))
      .filter(Boolean);
    if (output.length) return output;
  }
  const fallback = String(alternative.transcript || data?.transcript || "").trim();
  return fallback ? [toSegment(fallback, 0, 0.5)].filter(Boolean) : [];
}

function deepgramHttpError(status, body) {
  let message = "";
  try {
    const parsed = JSON.parse(body);
    message = String(parsed?.err_msg || parsed?.error || parsed?.message || "").trim();
  } catch {
    message = String(body || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }
  if (status === 401 || status === 403)
    return new Error("Deepgram API Key 无效或没有权限，请重新保存。");
  if (status === 429) return new Error("Deepgram 请求过于频繁，请稍后再试。");
  if (status === 413) return new Error("音频文件超过 Deepgram 上传限制，请把视频剪短后再匹配。");
  return new Error(message || `Deepgram 识别失败（${status}）。`);
}

function deepgramKeyterms(script = "") {
  const common = new Set(["about", "after", "again", "also", "because", "before", "being", "between", "could", "every", "first", "from", "have", "into", "just", "more", "other", "said", "says", "that", "their", "there", "these", "they", "this", "through", "very", "what", "when", "where", "which", "while", "with", "would", "your"]);
  const seen = new Set();
  return (String(script || "").match(/[\p{L}][\p{L}’'-]{3,}/gu) || [])
    .filter((word) => {
      const key = word.toLowerCase();
      if (common.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => right.length - left.length)
    .slice(0, 35);
}

async function deepgramTranscribeFile(filePath, { signal, script = "", language = speechLanguage() } = {}) {
  const key = getDeepgramApiKey();
  if (!key) throw new Error("还没有保存 Deepgram API Key。");
  const bytes = await fs.promises.readFile(filePath);
  const type = String(filePath).toLowerCase().endsWith(".flac") ? "audio/flac" : "audio/wav";
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set("model", DEEPGRAM_STT_MODEL);
  // Keep Deepgram's raw disfluencies and repetitions intact for the alignment
  // engine. Formatting is done locally after word-level timestamps are secured.
  url.searchParams.set("smart_format", "false");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("utterances", "true");
  url.searchParams.set("filler_words", "true");
  if (language === "auto") url.searchParams.set("detect_language", "true");
  else url.searchParams.set("language", language);
  for (const keyterm of deepgramKeyterms(script)) url.searchParams.append("keyterm", keyterm);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": type,
    },
    body: bytes,
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw deepgramHttpError(response.status, body);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Deepgram 返回了无法解析的识别结果。");
  }
}

export async function transcribeWithDeepgram(
  audioPath,
  { duration = 0, job = null, signal = null, script = "", language = speechLanguage() } = {},
) {
  const totalDuration = Math.max(0.04, Number(duration || 0.04));
  const needChunks = totalDuration > DEEPGRAM_CHUNK_SECONDS + 2;
  if(job){
    job.recognitionChunkCount=needChunks?Math.ceil(totalDuration/(DEEPGRAM_CHUNK_SECONDS-DEEPGRAM_CHUNK_OVERLAP)):1;
    job.recognitionChunkSeconds=needChunks?DEEPGRAM_CHUNK_SECONDS:Math.ceil(totalDuration);
  }
  if (!needChunks) {
    if (job) job.progress = 0.22;
    const data = await deepgramTranscribeFile(audioPath, { signal, script, language });
    if (job) job.progress = 0.86;
    return {
      segments: parseDeepgramTranscription(data, 0),
      fallbackText: String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ""),
    };
  }
  const segments = [];
  const texts = [];
  const directory = path.dirname(audioPath);
  let index = 0;
  for (
    let start = 0;
    start < totalDuration;
    start += DEEPGRAM_CHUNK_SECONDS - DEEPGRAM_CHUNK_OVERLAP, index += 1
  ) {
    if (signal?.aborted || job?.state === "cancelled") throw new Error("cancelled");
    const length = Math.min(DEEPGRAM_CHUNK_SECONDS, totalDuration - start);
    if (length < 0.25) break;
    const chunkPath = path.join(directory, `deepgram-chunk-${index}.flac`);
    await extractAudioSlice(audioPath, chunkPath, start, length);
    if (job) job.progress = 0.14 + Math.min(0.7, (start / totalDuration) * 0.7);
    try {
      const data = await deepgramTranscribeFile(chunkPath, { signal, script, language });
      segments.push(...parseDeepgramTranscription(data, start).map(segment => ({ ...segment, chunkIndex: index })));
      const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      if (text) texts.push(String(text));
    } finally {
      try {
        fs.unlinkSync(chunkPath);
      } catch {
        /* temp chunk */
      }
    }
  }
  if (job) job.progress = 0.88;
  return { segments, fallbackText: texts.join(" ") };
}

function groqHttpError(status, body) {
  let message = "";
  try {
    message = String(JSON.parse(body)?.error?.message || "").trim();
  } catch {
    message = String(body || "").replace(/\s+/g, " ").trim().slice(0, 180);
  }
  if (status === 401 || status === 403)
    return new Error("Groq API Key 无效或没有权限，请重新保存。");
  if (status === 429) return new Error("Groq 请求过于频繁，请稍后再试。");
  if (status === 413) return new Error("音频文件超过 Groq 上传限制，请把视频剪短后再匹配。");
  return new Error(message || `Groq 识别失败（${status}）。`);
}

function extractAudioSlice(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      mediaBinary("ffmpeg"),
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        String(Math.max(0, start)),
        "-t",
        String(Math.max(0.2, duration)),
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        path.extname(outputPath).toLowerCase() === ".wav" ? "pcm_s16le" : "flac",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(outputPath)
        : reject(new Error(stderr.trim() || "无法切分识别音频。")),
    );
  });
}

async function groqTranscribeFile(filePath, { script, signal, start = 0, length = 0, totalDuration = 0, language = speechLanguage() } = {}) {
  const key = getGroqApiKey();
  if (!key) throw new Error("还没有保存 Groq API Key。");
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  const type = String(filePath).toLowerCase().endsWith(".flac")
    ? "audio/flac"
    : "audio/wav";
  form.append(
    "file",
    new Blob([bytes], { type }),
    path.basename(filePath) || "audio.wav",
  );
  form.append("model", GROQ_STT_MODEL);
  if (language && language !== "auto") form.append("language", language);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  const total = Math.max(0.04, Number(totalDuration || length || 0.04));
  const prompt = manuscriptRecognitionPrompt(
    script,
    Math.max(0, Number(start || 0)) / total,
    Math.max(0.04, Number(length || total)) / total,
    language,
  );
  if (prompt) form.append("prompt", prompt);
  const response = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw groqHttpError(response.status, body);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Groq 返回了无法解析的识别结果。");
  }
}

export async function transcribeWithGroq(
  audioPath,
  { duration = 0, script = "", job = null, signal = null, language = speechLanguage() } = {},
) {
  const totalDuration = Math.max(0.04, Number(duration || 0.04));
  const size = fs.statSync(audioPath).size;
  const needChunks =
    size > GROQ_MAX_UPLOAD_BYTES || totalDuration > GROQ_CHUNK_SECONDS + 30;
  if (!needChunks) {
    if (job) job.progress = 0.22;
    const data = await groqTranscribeFile(audioPath, {
      script, signal, start: 0, length: totalDuration, totalDuration,
      language,
    });
    if (job) job.progress = 0.86;
    return {
      segments: parseGroqTranscription(data, 0),
      fallbackText: String(data.text || ""),
    };
  }
  const segments = [];
  const texts = [];
  const directory = path.dirname(audioPath);
  let index = 0;
  for (
    let start = 0;
    start < totalDuration;
    start += GROQ_CHUNK_SECONDS - GROQ_CHUNK_OVERLAP, index += 1
  ) {
    if (signal?.aborted || job?.state === "cancelled")
      throw new Error("cancelled");
    const length = Math.min(GROQ_CHUNK_SECONDS, totalDuration - start);
    if (length < 0.25) break;
    const chunkPath = path.join(directory, `groq-chunk-${index}.flac`);
    await extractAudioSlice(audioPath, chunkPath, start, length);
    if (job)
      job.progress = 0.14 + Math.min(0.7, (start / totalDuration) * 0.7);
    try {
      const data = await groqTranscribeFile(chunkPath, {
        script, signal, start, length, totalDuration,
        language,
      });
      segments.push(...parseGroqTranscription(data, start));
      if (data.text) texts.push(String(data.text));
    } finally {
      try {
        fs.unlinkSync(chunkPath);
      } catch {
        /* temp chunk */
      }
    }
  }
  if (job) job.progress = 0.88;
  return { segments, fallbackText: texts.join(" ") };
}

function parseWhisperJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  const rows = Array.isArray(data.transcription)
    ? data.transcription
    : Array.isArray(data.segments)
      ? data.segments
      : [];
  return rows
    .map((row) => {
      const text = String(row.text || row.transcription || "").trim();
      const start =
        Number(row.offsets?.from ?? (Number(row.start) || 0) * 1000) / 1000;
      const end =
        Number(row.offsets?.to ?? (Number(row.end) || start + 0.04) * 1000) / 1000;
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { text, start, end: Math.max(start + 0.04, end) };
    })
    .filter(Boolean);
}

function plainWords(text) {
  return String(text || "").match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) || [];
}

function timedChunks(words, start, end, chunkSize = 20) {
  const chunks = [];
  for (let index = 0; index < words.length; index += chunkSize) {
    const part = words.slice(index, index + chunkSize),
      partStart = start + ((end - start) * index) / Math.max(1, words.length),
      partEnd = start + ((end - start) * (index + part.length)) / Math.max(1, words.length);
    chunks.push({
      text: part.join(" ").replace(/\s+([.,!?;:])/g, "$1"),
      start: partStart,
      end: Math.max(partStart + 0.04, partEnd),
      recovered: true,
    });
  }
  return chunks;
}

function lexicalWords(text) {
  return String(text || "").match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) || [];
}

export function normalizeTranscriptTimebase(segments = [], duration = 0) {
  const videoDuration = Math.max(0.04, Number(duration || 0.04));
  return (segments || []).map((original) => {
    const segment = { ...original };
    let start = Number(segment.start || 0);
    let end = Number(segment.end || start + 0.04);
    const chunkOffset = Number(
      segment.chunkOffset ?? Number(segment.chunkIndex || 0) * 43.9,
    );
    const explicitCentiseconds = segment.timebase === "whisper-centiseconds";
    const explicitSeconds = segment.timebase === "seconds";
    const localStart = start - chunkOffset;
    const localEnd = end - chunkOffset;
    const inferredCentiseconds =
      !explicitSeconds &&
      (end > videoDuration * 4 + chunkOffset);
    if (explicitCentiseconds || inferredCentiseconds) {
      start = chunkOffset + localStart / 100;
      end = chunkOffset + localEnd / 100;
    }
    segment.start = Math.max(0, Math.min(videoDuration, start));
    segment.end = Math.max(
      segment.start + 0.04,
      Math.min(videoDuration, end),
    );
    segment.timebase = "seconds";
    return segment;
  });
}

export function stitchTranscriptSegments(segments = []) {
  const sorted = [...segments]
    .filter((segment) => String(segment?.text || "").trim())
    .sort(
      (left, right) =>
        Number(left.start || 0) - Number(right.start || 0) ||
        Number(left.chunkIndex || 0) - Number(right.chunkIndex || 0),
    );
  const output = [];
  for (const original of sorted) {
    const segment = {
      ...original,
      text: String(original.text || "").trim(),
      start: Math.max(0, Number(original.start || 0)),
      end: Math.max(
        Number(original.start || 0) + 0.04,
        Number(original.end || Number(original.start || 0) + 0.04),
      ),
    };
    const previous = output.at(-1);
    if (!previous) {
      output.push(segment);
      continue;
    }
    const sameChunk =
      (previous.chunkIndex == null && segment.chunkIndex == null) ||
      Number(previous.chunkIndex) === Number(segment.chunkIndex);
    const previousNorm = lexicalWords(previous.text).map(normalizeWord).filter(Boolean);
    let currentWords = lexicalWords(segment.text);
    let currentNorm = currentWords.map(normalizeWord).filter(Boolean);
    if (
      !sameChunk &&
      segment.start < previous.end + 0.08 &&
      previousNorm.length &&
      currentNorm.length
    ) {
      let overlap = 0;
      const maximum = Math.min(16, previousNorm.length, currentNorm.length);
      for (let length = maximum; length >= 1; length -= 1) {
        if (
          previousNorm
            .slice(-length)
            .every((word, index) => word === currentNorm[index])
        ) {
          overlap = length;
          break;
        }
      }
      if (overlap >= currentNorm.length) continue;
      if (overlap) {
        const originalCount = Math.max(1, currentWords.length);
        currentWords = currentWords.slice(overlap);
        currentNorm = currentNorm.slice(overlap);
        segment.text = currentWords.join(" ");
        segment.start +=
          ((segment.end - segment.start) * overlap) / originalCount;
      }
    }
    const duplicate = !sameChunk &&
      currentNorm.length === previousNorm.length &&
      currentNorm.every((word, index) => word === previousNorm[index]) &&
      segment.start <= previous.end + 0.15;
    if (duplicate || !segment.text) continue;
    if (!sameChunk && segment.start < previous.end)
      segment.start = Math.max(0, previous.end);
    segment.end = Math.max(segment.start + 0.04, segment.end);
    output.push(segment);
  }
  return output;
}

export function recoverIncompleteSegments(segments, fallbackText, duration) {
  const current = [...(segments || [])],
    fullWords = plainWords(fallbackText),
    spokenWords = plainWords(current.map((item) => item.text).join(" ")),
    end = Math.max(0.1, Number(duration || current.at(-1)?.end || 0.1)),
    lastEnd = Number(current.at(-1)?.end || 0);
  if (!fullWords.length) return current;
  if (!current.length) return timedChunks(fullWords, 0, end);
  if (fullWords.length <= spokenWords.length * 1.12 || lastEnd >= end * 0.94)
    return current;
  const fullNorm = fullWords.map(normalizeWord).filter(Boolean),
    spokenNorm = spokenWords.map(normalizeWord).filter(Boolean),
    anchorLength = Math.min(10, spokenNorm.length),
    anchor = spokenNorm.slice(-anchorLength);
  let anchorAt = -1;
  for (let index = 0; index + anchor.length <= fullNorm.length; index += 1)
    if (anchor.every((word, offset) => word === fullNorm[index + offset]))
      anchorAt = index;
  if (anchorAt >= 0) {
    const remaining = fullWords.slice(anchorAt + anchorLength);
    if (remaining.length)
      current.push(...timedChunks(remaining, Math.min(end - 0.04, lastEnd), end));
    return current;
  }
  // The realtime callback was incomplete and diverged too much to splice
  // safely. Preserve the full transcript and give alignment fresh time spans
  // instead of letting one bad segment erase the remainder of the manuscript.
  if (lastEnd < end * 0.78 && fullWords.length > spokenWords.length * 1.25)
    return timedChunks(fullWords, 0, end);
  return current;
}

export function retainedTranscriptSegments(segments, removals = [], duration = 0) {
  const cuts = mergeRanges(removals, duration);
  if (!cuts.length) return segments;
  return segments.flatMap(segment => {
    const tokens = displayWords(segment.text);
    const start = Number(segment.start || 0);
    const end = Math.max(start + 0.04, Number(segment.end || start));
    return tokens.flatMap((token, index) => {
      const a = start + (end - start) * index / tokens.length;
      const b = start + (end - start) * (index + 1) / tokens.length;
      const midpoint = (a + b) / 2;
      if (cuts.some(cut => midpoint >= cut.start && midpoint < cut.end)) return [];
      const mappedStart = mapSourceTime(a, cuts), mappedEnd = mapSourceTime(b, cuts);
      return mappedEnd > mappedStart + 0.001
        ? [{ ...segment, text: token.display, start: mappedStart, end: mappedEnd }]
        : [];
    });
  });
}

export function transcriptOnPlacedClips(segments, clips = []) {
  return [...clips].sort((a,b)=>a.start-b.start).flatMap(clip => {
    const rate = (clip.sourceEnd-clip.sourceStart)/(clip.end-clip.start);
    if (!(rate > 0)) return [];
    return segments.flatMap(segment => {
      const tokens=displayWords(segment.text), start=Number(segment.start||0), end=Number(segment.end||start);
      return tokens.flatMap((token,index)=>{
        const a=start+(end-start)*index/tokens.length, b=start+(end-start)*(index+1)/tokens.length;
        if ((a+b)/2 < clip.sourceStart || (a+b)/2 >= clip.sourceEnd) return [];
        const from=Math.max(a,clip.sourceStart), to=Math.min(b,clip.sourceEnd);
        return to>from ? [{...segment,text:token.display,start:clip.start+(from-clip.sourceStart)/rate,end:clip.start+(to-clip.sourceStart)/rate}] : [];
      });
    });
  });
}

async function verifyAudioOmissions(job,segments,script,duration) {
  if(!job.inputPath || !fs.existsSync(job.inputPath))return segments;
  const transcribe=async(start,length)=>{
    if(job.state==='cancelled')throw new Error('cancelled');
    const directory=fs.mkdtempSync(path.join(supportRoot(),'verify-omission-'));
    const engine=job.engine||loadSpeechSettings().engine;
    const file=path.join(directory,engine==='local'?'context.wav':'context.flac');
    const controller=new AbortController();job.controller=controller;
    const timer=setTimeout(()=>controller.abort(),30000);
    try {
      await extractAudioSlice(job.inputPath,file,start,length);
      const options={duration:length,script,signal:controller.signal,language:job.speechLanguage||speechLanguage()};
      let result;
      if(engine==='deepgram')result=await transcribeWithDeepgram(file,options);
      else if(engine==='groq')result=await transcribeWithGroq(file,options);
      else if(engine==='gemini')result=await transcribeWithGemini(file,options);
      else {
        const verifyJob={state:'transcribing',engine:'local',kind:'caption',captionLines:1};
        await new Promise((resolve,reject)=>{
          let settled=false;
          const poll=setInterval(()=>{if(controller.signal.aborted){verifyJob.child?.kill();clearInterval(poll);if(!settled){settled=true;reject(new Error('local verification timed out'));}}else if(['completed','failed'].includes(verifyJob.state)){clearInterval(poll);if(!settled){settled=true;verifyJob.state==='completed'?resolve():reject(new Error(verifyJob.error));}}},100);
          verifyJob.speechLanguage=job.speechLanguage||speechLanguage();
          void startLocalTranscription(verifyJob,{wavPath:file,duration:length,script:'',removals:[],cleanup:()=>{},speechLanguage:verifyJob.speechLanguage});
        });
        result={segments:verifyJob.result.segments};
      }
      if(job.state==='cancelled')throw new Error('cancelled');
      return result.segments;
    } catch(error) {
      if(job.state==='cancelled')throw new Error('cancelled');
      throw new Error(error.message);
    } finally {clearTimeout(timer);if(job.controller===controller)job.controller=null;fs.rmSync(directory,{recursive:true,force:true});}
  };
  segments=await refineSentenceTimings(segments,{duration,transcribe});
  segments=await recoverUntranscribedGaps({segments,duration,transcribe,sourceClips:job.sourceClips});
  if(script)segments=await recoverAudioOmissions({segments,script,duration,transcribe});
  return verifyAdjacentAsrEchoes({segments,duration,transcribe});
}

async function finalizeScriptAnalysis(job, segments, fallbackText, duration, script, removals) {
  if(job.state==='cancelled')return;
  if (job.kind === 'caption') {
    return finalizeAutoCaptionAnalysis(job, segments, duration, job.captionLines, script, job.forcedAlignment, fallbackText);
  }
  job.requestRemovals=removals || [];
  await finalizeAutoCaptionAnalysis(job,segments,duration,job.captionLines,script,false,fallbackText);
  if(job.state==='cancelled')return;
  job.result.transcript=job.result.recognizedTranscript;
}

export async function reviewScriptIssues(input = {}) {
  if (!reviewReady())
    throw new Error("请先在纠正设置里保存 Gemini / Vertex 凭证，或安装并登录 Antigravity CLI。");
  const mode = normalizeReviewMode(input.mode);
  const issues = Array.isArray(input.issues) ? input.issues.map((issue) => ({ ...issue })) : [];
  if (!issues.length) throw new Error("请先匹配文案，再使用 AI 纠正。");
  const operations = Array.isArray(input.operations) ? input.operations : [];
  const judged = await judgeAlignmentIssues({
    script: input.script || "",
    issues,
    operations,
    mode,
  });
  const decisions = judged.decisions || judged;
  const aligned = { issues, operations };
  const summary = applyJudgeDecisions(aligned, decisions, mode);
  const compare = buildReviewCompareRecord({
    mode,
    issues,
    decisions,
    summary,
    batches: judged.batches || [],
  });
  const logged = writeReviewCompareLog(compare);
  const visibleIssues = pendingCaptionPlan({operations,issues:issues.filter(issue=>!issue.suppressReview)}).issues;
  const outputDuration = Math.max(
    0.04,
    Number(input.outputDuration || 0),
    ...issues.map((issue) => Number(issue.end || 0)),
  );
  const polishPlan = buildGlobalPolishPlan(issues);
  return {
    mode,
    issues: visibleIssues,
    reviewCaptions: buildReviewCaptions(visibleIssues, [], outputDuration),
    judgeSummary: { ...summary, logPath: logged.latest },
    reviewLogPath: logged.latest,
    polishPlan,
    polishSummary: formatGlobalPolishSummary(polishPlan, polishPlan.autoCut.length),
  };
}

function watchTranscriptChild(job, child, { wavPath, duration, script, removals, cleanup, jsonPath = "" }) {
  job.child = child;
  let buffer = "";
  let fallbackText = "";
  let workerError = "";
  const segments = [];
  const consume = (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === "progress")
          job.progress =
            0.06 + (Math.max(0, Math.min(100, event.value)) / 100) * 0.9;
        if (event.type === "segment") segments.push(event.segment);
        if (event.type === "fallback")
          fallbackText = String(event.text || "").trim();
      } catch {
        const segment = parseTimestampLine(line);
        if (segment) segments.push(segment);
      }
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", (chunk) => {
    workerError = (workerError + chunk.toString()).slice(-8000);
    consume(chunk);
    const progress = String(chunk).match(/progress\s*=\s*(\d+)/i);
    if (progress)
      job.progress = 0.06 + (Number(progress[1]) / 100) * 0.9;
  });
  child.on("error", (error) => {
    job.state = "failed";
    job.error = error.message;
    cleanup();
  });
  child.on("close", (workerCode) => {
    job.child = null;
    if (job.state === "cancelled") return cleanup();
    const jsonSegments = parseWhisperJson(jsonPath);
    if (jsonPath) {
      try {
        fs.unlinkSync(jsonPath);
      } catch {
        /* temp whisper json */
      }
    }
    cleanup();
    const merged = jsonSegments.length ? jsonSegments : segments;
    if (workerCode !== 0 && !merged.length) {
      job.state = "failed";
      job.error = workerError.trim() || "本地语音识别失败。";
      return;
    }
    void finalizeScriptAnalysis(
      job,
      merged,
      fallbackText || merged.map((item) => item.text).join(" "),
      duration,
      script,
      removals,
    ).catch((error) => {
      if (job.state === "cancelled") return;
      job.state = "failed";
      job.error = error.message;
    });
  });
}

async function beginTranscription(job, context) {
  const preferred = job.engine || loadSpeechSettings().engine;
  job.engine = preferred;
  if (preferred === "gemini") {
    if (!geminiTranscriptionReady()) {
      job.state = "failed";
      job.error = "听写选了 Gemini，请保存 Gemini API Key，或配置 Vertex 凭证。";
      context.cleanup();
      return;
    }
    const controller = new AbortController();
    job.controller = controller;
    try {
      job.progress = 0.1;
      const transcribed = await transcribeWithGemini(context.wavPath, {
        duration: context.duration,
        job,
        signal: controller.signal,
        language: context.speechLanguage || job.speechLanguage || speechLanguage(),
        script: context.script,
      });
      if (job.state === "cancelled") {
        context.cleanup();
        return;
      }
      job.asrModel = transcribed.model || GEMINI_SPEECH_MODEL;
      context.cleanup();
      job.child = null;
      await finalizeScriptAnalysis(
        job,
        transcribed.segments,
        transcribed.fallbackText,
        context.duration,
        context.script,
        context.removals,
      );
      job.controller = null;
    } catch (error) {
      context.cleanup();
      job.child = null;
      job.controller = null;
      if (job.state === "cancelled" || error?.name === "AbortError" || error?.message === "cancelled")
        return;
      job.state = "failed";
      job.error = error.message;
    }
    return;
  }
  if (preferred === "deepgram") {
    if (!getDeepgramApiKey()) {
      job.state = "failed";
      job.error = "听写选了 Deepgram，请先保存 Deepgram API Key。";
      context.cleanup();
      return;
    }
    const controller = new AbortController();
    job.controller = controller;
    try {
      job.progress = 0.1;
      const transcribed = await transcribeWithDeepgram(context.wavPath, {
        duration: context.duration,
        job,
        signal: controller.signal,
        script: context.script,
        language: context.speechLanguage || job.speechLanguage || speechLanguage(),
      });
      if (job.state === "cancelled") {
        context.cleanup();
        return;
      }
      context.cleanup();
      job.child = null;
      await finalizeScriptAnalysis(
        job,
        transcribed.segments,
        transcribed.fallbackText,
        context.duration,
        context.script,
        context.removals,
      );
      job.controller = null;
    } catch (error) {
      context.cleanup();
      job.child = null;
      job.controller = null;
      if (job.state === "cancelled" || error?.name === "AbortError" || error?.message === "cancelled")
        return;
      job.state = "failed";
      job.error = error.message;
    }
    return;
  }
  if (preferred === "local") {
    void startLocalTranscription(job, context);
    return;
  }
  if (!getGroqApiKey()) {
    job.state = "failed";
    job.error = "听写选了 Groq，请先保存 Groq API Key。";
    context.cleanup();
    return;
  }
  const controller = new AbortController();
  job.controller = controller;
  try {
    job.progress = 0.1;
    const transcribed = await transcribeWithGroq(context.wavPath, {
      duration: context.duration,
      script: context.script,
      language: context.speechLanguage || job.speechLanguage || speechLanguage(),
      job,
      signal: controller.signal,
    });
    if (job.state === "cancelled") {
      context.cleanup();
      return;
    }
    context.cleanup();
    job.child = null;
    await finalizeScriptAnalysis(
      job,
      transcribed.segments,
      transcribed.fallbackText,
      context.duration,
      context.script,
      context.removals,
    );
    job.controller = null;
  } catch (error) {
    context.cleanup();
    job.child = null;
    job.controller = null;
    if (job.state === "cancelled" || error?.name === "AbortError" || error?.message === "cancelled")
      return;
    job.state = "failed";
    job.error = error.message;
  }
}

async function startLocalTranscription(job, context) {
  if (!localModelInstalled()) {
    job.state = "failed";
    job.error = "还没有这个本地模型。请先下载后再匹配。";
    context.cleanup();
    return;
  }
  const spec = localWhisperSpec(loadSpeechSettings().localModel);
  if (canUseNapiWhisper()) {
    watchTranscriptChild(
      job,
      spawn(
        process.execPath,
        [workerPath(), modelPath(spec.id), context.wavPath, spec.dtwPreset, context.speechLanguage || job.speechLanguage || speechLanguage()],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
      context,
    );
    return;
  }
  try {
    job.progress = 0.07;
    const cli = await ensureWhisperCli();
    const prefix = path.join(path.dirname(context.wavPath), "whisper-out");
    const jsonPath = `${prefix}.json`;
    const args = [
      "-m",
      modelPath(spec.id),
      "-f",
      context.wavPath,
      "-l",
      (context.speechLanguage || job.speechLanguage || speechLanguage()) === "auto" ? "auto" : (context.speechLanguage || job.speechLanguage || speechLanguage()),
      "-t",
      String(Math.max(2, Math.min(8, os.cpus()?.length || 4))),
      "-sow",
      "-ml",
      "24",
      "-oj",
      "-of",
      prefix,
    ];
    watchTranscriptChild(
      job,
      spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
      { ...context, jsonPath },
    );
  } catch (error) {
    context.cleanup();
    job.state = "failed";
    job.error = error.message;
  }
}

export function startScriptAnalysis({
  inputPath,
  duration,
  script,
  removals = [],
  captionLines = 2,
  naturalPunctuation = false,
  sourceClips,
  alignmentOnly = false,
  forceRecognition = false,
  scriptLanguage = "",
}) {
  if (!canTranscribe()) {
    const engine = loadSpeechSettings().engine;
    throw new Error(
      engine === "local"
        ? "请先下载当前选的本地 Whisper 模型。"
        : engine === "deepgram"
          ? "请先保存 Deepgram API Key。"
          : engine === "gemini"
            ? "请先在纠正设置里保存 Gemini / Vertex 凭证。"
            : "请先保存 Groq API Key。",
    );
  }
  if (!String(script || "").trim()) throw new Error("请先粘贴正确文案。");
  const id = crypto.randomUUID();
  const tempDir = fs.mkdtempSync(path.join(supportRoot(), "analysis-"));
  const settings = loadSpeechSettings();
  const effectiveSpeechLanguage = resolveSpeechLanguage(script, settings.speechLanguage, scriptLanguage);
  assertSpeechModelSupportsLanguage(settings.engine, effectiveSpeechLanguage, settings.localModel);
  const useLocal = settings.engine === "local";
  const wavPath = path.join(tempDir, useLocal ? "audio.wav" : "audio.flac");
  const job = {
    id,
    kind: "script",
    engine: settings.engine,
    state: "extracting",
    progress: 0.02,
    error: "",
    result: null,
    child: null,
    controller: null,
    captionLines,
    naturalPunctuation: !!naturalPunctuation,
    sourceClips,
    inputPath,
    alignmentOnly,
    forceRecognition:Boolean(forceRecognition),
    manuscriptLanguage:String(scriptLanguage||''),
    speechLanguage: effectiveSpeechLanguage,
    cacheKey:transcriptCacheKey(inputPath,transcriptCacheSettings(effectiveSpeechLanguage)),
  };
  analyses.set(id, job);
  const cached=forceRecognition?null:readTranscriptCache(supportRoot(),job.cacheKey);
  job.cacheHit=Boolean(cached);
  job.cacheDecision=forceRecognition?'bypassed':cached?'hit':'miss';
  logSpeechJob(job,'started',{cacheDecision:job.cacheDecision});
  if(cached){
    job.asrModel=cached.model||'';
    fs.rmSync(tempDir,{recursive:true,force:true});
    void finalizeScriptAnalysis(job,cached.segments,cached.fallbackText,duration,script,removals).catch(error=>{if(job.state==='cancelled')return;job.state="failed";job.error=error.message;});
    return {jobId:id};
  }
  const cleanup = () => {
    try {
      fs.unlinkSync(wavPath);
      fs.rmdirSync(tempDir);
    } catch {
      /* ignore */
    }
  };
  const ffmpeg = spawn(
    mediaBinary("ffmpeg"),
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      useLocal ? "pcm_s16le" : "flac",
      wavPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  job.child = ffmpeg;
  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => {
    ffmpegError = (ffmpegError + chunk.toString()).slice(-6000);
  });
  ffmpeg.on("error", (error) => {
    job.state = "failed";
    job.error = error.message;
    cleanup();
  });
  ffmpeg.on("close", (code) => {
    if (job.state === "cancelled") {
      cleanup();
      return;
    }
    if (code !== 0 || !fs.existsSync(wavPath)) {
      job.state = "failed";
      job.error = ffmpegError || "无法提取视频音频。";
      cleanup();
      return;
    }
    job.state = "transcribing";
    job.progress = 0.06;
    void beginTranscription(job, {
      wavPath,
      duration,
      script,
      speechLanguage: effectiveSpeechLanguage,
      removals,
      cleanup,
    });
  });
  return { jobId: id };
}

export function scriptAnalysisStatus(jobId) {
  const job = analyses.get(String(jobId || ""));
  if (!job) throw new Error("文案匹配任务已经不存在。");
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error,
    result: job.state === "completed" ? job.result : null,
  };
}

export function cancelScriptAnalysis(jobId) {
  const job = analyses.get(String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state))
    return false;
  job.state = "cancelled";
  try {
    job.controller?.abort();
  } catch {
    /* already stopped */
  }
  try {
    job.child?.kill("SIGTERM");
  } catch {
    /* already stopped */
  }
  return true;
}

function autoCaptionWords(segments = []) {
  return stitchTranscriptSegments(segments).map((segment) => ({
    display: String(segment.text || "").trim(),
    text: String(segment.text || "").trim(),
    start: Number(segment.start || 0),
    end: Number(segment.end || Number(segment.start || 0) + 0.04),
    matchType: "match",
  })).filter((word) => word.display && word.end > word.start);
}

function capitalizeTranscriptProperNouns(segments = []) {
  const properNouns = /\b(god|jesus|christ|lord|bible|scripture)(['’]s)?\b/giu;
  const holySpirit = /\bholy\s+spirit\b/giu;
  return segments.map((segment) => ({
    ...segment,
    text: String(segment.text || "")
      .replace(properNouns, (_match, name, possessive = "") =>
        `${name[0].toLocaleUpperCase()}${name.slice(1).toLocaleLowerCase()}${possessive}`)
      .replace(holySpirit, "Holy Spirit"),
  }));
}

function capitalizeCaptionProperNouns(words = [], script = "") {
  const manuscriptCase = manuscriptProperCaseKeys(script);
  return words.map((word) => {
    const original = String(word.display || word.text || "");
    const expected = String(word.expectedDisplay || "");
    const expectedKey = normalizeWord(expected);
    const scriptCaseMatch = expectedKey && expectedKey === normalizeWord(original) && manuscriptCase.has(expectedKey);
    const knownCase = capitalizeTranscriptProperNouns([{ text: original }])[0].text;
    const display = scriptCaseMatch ? expected : knownCase;
    return display === original
      ? word
      : { ...word, display, text: display, originalDisplay: word.originalDisplay || original, autoCorrected: true };
  });
}

function manuscriptProperCaseKeys(script = "") {
  const text=String(script||"");
  const keys=new Set();
  const sentenceBoundary=/[.!?…\n\r]/gu;
  for(const match of text.matchAll(/[\p{Lu}][\p{L}\p{N}'’.-]*/gu)){
    const token=match[0];
    const before=text.slice(0,match.index);
    let boundary=-1;
    for(const punctuation of before.matchAll(sentenceBoundary))boundary=punctuation.index;
    const sentencePrefix=before.slice(boundary+1);
    const sentenceInitial=!/[\p{L}\p{N}]/u.test(sentencePrefix);
    if(/[a-z][A-Z]/u.test(token)||/^[A-Z]{2,}$/u.test(token)||!sentenceInitial)
      keys.add(normalizeWord(token));
  }
  return keys;
}

function applyManuscriptFormattingOnly(words=[], script="") {
  const properCase=manuscriptProperCaseKeys(script);
  return words.map(word=>{
    const spoken=String(word.originalDisplay??word.display??"");
    const expected=String(word.expectedDisplay||"");
    const caseOnly=expected&&spoken!==expected&&spoken.toLocaleLowerCase()===expected.toLocaleLowerCase();
    const useManuscriptCase=caseOnly&&(word.scriptureReference||properCase.has(normalizeWord(expected)));
    const display=useManuscriptCase?expected:spoken;
    return {...word,display,text:display,matchType:"match",issueType:"",issueId:"",action:"",ccReferenceReview:false,
      ...(useManuscriptCase?{originalDisplay:spoken,autoCorrected:true}:{})};
  });
}

async function finalizeAutoCaptionAnalysis(job, segments, duration, captionLines, script = "", forcedAlignment = false, fallbackText = "") {
  if(job.state==='cancelled')return;
  let unique = normalizeTranscriptTimebase(segments, duration);
  unique = tightenTranscriptWordTimes(recoverIncompleteSegments(stitchTranscriptSegments(unique), fallbackText, duration));
  unique = normalizeBibleVersionSegments(await verifyAudioOmissions(job,unique,job.proofread===false?'':script,duration));
  if(unique.some(s=>s.asrEchoVerified))fallbackText=unique.map(s=>s.text).join(' ');
  if(job.state==='cancelled')return;
  const orderedTranscript=[...unique].sort((a,b)=>a.start-b.start);
  const transcriptGaps=[];
  for(let index=1;index<orderedTranscript.length;index++){
    const gap=Number(orderedTranscript[index].start)-Number(orderedTranscript[index-1].end);
    if(gap>12)transcriptGaps.push(gap);
  }
  logSpeechJob(job,'transcript-ready',{segmentCount:unique.length,audioVerifiedWordCount:unique.filter(segment=>segment.audioVerified).length,
    gapsOver12Seconds:transcriptGaps.length,longestGapSeconds:Math.round(Math.max(0,...transcriptGaps)*100)/100});
  if(job.cacheKey) {try{writeTranscriptCache(supportRoot(),job.cacheKey,unique,fallbackText,job.asrModel||'');}catch{/* cache is optional */}}
  const sourceSegments=unique.map(segment=>({...segment}));
  const placed=Array.isArray(job.sourceClips)?job.sourceClips:null;
  const cutRanges=placed?[]:mergeRanges(job.requestRemovals || [],duration);
  const outputDuration=placed?Math.max(.04,...placed.map(clip=>Number(clip.end)||0)):Math.max(.04,mapSourceTime(Number(duration)||.04,cutRanges));
  unique=placed?transcriptOnPlacedClips(unique,placed):retainedTranscriptSegments(unique,cutRanges,duration);
  unique = capitalizeTranscriptProperNouns(unique);
  const recognizedWords = autoCaptionWords(unique);
  if (!recognizedWords.length) throw new Error(placed?'当前时间线没有保留可匹配的人声，请检查音频片段裁切范围。':'没有识别到清晰的人声。');
  const manuscript = String(script || "").trim();
  const correctScript = job.proofread===false ? "" : manuscript;
  const aligned = correctScript
    ? alignScript({ segments: unique, script: correctScript, duration:outputDuration, recoverMissing: false })
    : null;
  if(aligned && placed) {
    const full=alignScript({segments:sourceSegments,script:correctScript,duration,recoverMissing:false});
    const removedExpected=new Set(full.operations.filter(op=>op.spoken && op.expected && !placed.some(c=>op.spoken.start<c.sourceEnd && op.spoken.end>c.sourceStart)).map(op=>op.expected.scriptIndex));
    const removedIds=new Set(aligned.issues.filter(issue=>issue.type==='missing' && aligned.operations.filter(op=>op.issueId===issue.id && op.expected).length && aligned.operations.filter(op=>op.issueId===issue.id && op.expected).every(op=>removedExpected.has(op.expected.scriptIndex))).map(issue=>issue.id));
    aligned.issues=aligned.issues.filter(issue=>!removedIds.has(issue.id));
  }
  for(const issue of aligned?.issues||[])if(issue.type==='missing'){issue.needsAudioReview=true;issue.reason='未识别到这段内容，请先试听核对；确认漏读后再补录';}
  const plan = aligned ? pendingCaptionPlan(aligned) : null;
  const formatOnlyPlan = !aligned&&manuscript
    ? pendingCaptionPlan(alignScript({segments:unique,script:manuscript,duration:outputDuration,recoverMissing:false}))
    : null;
  const formattedSpeech = !plan&&formatOnlyPlan
    ? applyManuscriptFormattingOnly(formatOnlyPlan.words,manuscript)
    : recognizedWords;
  const words = capitalizeCaptionProperNouns(
    normalizeScriptureReferences(plan ? plan.words : formattedSpeech,{rangeReference:manuscript}),
    manuscript,
  );
  const captions = buildCaptions(words, {
    maxWords: 10,
    maxChars: 34,
    maxLines: captionMatchLineLimit(captionLines),
    naturalPunctuation: !!job.naturalPunctuation,
  });
  job.result = {
    transcript: words.map((word) => word.display).join(" ").replace(/\s+([，。！？、；：,.!?;:])/gu, "$1"),
    recognizedTranscript: recognizedWords.map((word) => word.display).join(" ").replace(/\s+([，。！？、；：,.!?;:])/gu, "$1"),
    words,
    ...(aligned || {}),
    segments: unique,
    sourceSegments,
    timelinePlaced:Boolean(placed),
    cacheHit:!!job.cacheHit,
    captions,
    outputDuration,
    engine: job.engine || "deepgram",
    model: job.engine === 'groq' ? GROQ_STT_MODEL : job.engine === 'local' ? loadSpeechSettings().localModel : job.engine === 'gemini' ? (job.asrModel || GEMINI_SPEECH_MODEL) : DEEPGRAM_STT_MODEL,
    scriptAssisted: Boolean(correctScript),
    scriptMode: forcedAlignment && correctScript ? "forced" : correctScript ? "reference" : "none",
    forcedAlignment: Boolean(forcedAlignment && correctScript),
    issues: plan?.issues || [],
    reviewCaptions: plan ? buildReviewCaptions(plan.issues, [], outputDuration) : [],
  };
  job.state = "completed";
  job.progress = 1;
}

export function startAutoCaptionAnalysis({ inputPath, duration, captionLines = 1, script = "", forcedAlignment = false, proofread = undefined, sourceClips, alignmentOnly = false,forceRecognition = false,scriptLanguage = "" } = {}) {
  if (!canTranscribe()) throw new Error("请先配置当前选择的听写引擎，与匹配文案使用相同设置。");
  if (!inputPath) throw new Error("请先导入视频或音频。");
  const id = crypto.randomUUID();
  const tempDir = fs.mkdtempSync(path.join(supportRoot(), "auto-caption-"));
  const settings = loadSpeechSettings();
  const effectiveSpeechLanguage = resolveSpeechLanguage(script, settings.speechLanguage, scriptLanguage);
  assertSpeechModelSupportsLanguage(settings.engine, effectiveSpeechLanguage, settings.localModel);
  const engine = settings.engine;
  const audioPath = path.join(tempDir, engine === 'local' ? 'audio.wav' : 'audio.flac');
  const job = {
    id,
    kind: 'caption', engine, captionLines, forcedAlignment, proofread, inputPath,sourceClips,alignmentOnly,
    forceRecognition:Boolean(forceRecognition),
    manuscriptLanguage:String(scriptLanguage||''),
    speechLanguage: effectiveSpeechLanguage,
    cacheKey:transcriptCacheKey(inputPath,transcriptCacheSettings(effectiveSpeechLanguage)),
    state: "extracting",
    progress: 0.02,
    error: "",
    result: null,
    child: null,
    controller: null,
  };
  autoCaptionAnalyses.set(id, job);
  const cached=forceRecognition?null:readTranscriptCache(supportRoot(),job.cacheKey);
  job.cacheHit=Boolean(cached);
  job.cacheDecision=forceRecognition?'bypassed':cached?'hit':'miss';
  logSpeechJob(job,'started',{cacheDecision:job.cacheDecision});
  if(cached){fs.rmSync(tempDir,{recursive:true,force:true});
    void finalizeAutoCaptionAnalysis(job,cached.segments,Number(duration||0),captionLines,script,forcedAlignment,cached.fallbackText).catch(error=>{if(job.state==='cancelled')return;job.state="failed";job.error=error.message;});
    return {jobId:id};
  }
  const cleanup = () => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* temp output */ }
  };
  const ffmpeg = spawn(mediaBinary("ffmpeg"), [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", engine === 'local' ? 'pcm_s16le' : 'flac', audioPath,
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  job.child = ffmpeg;
  let ffmpegError = "";
  ffmpeg.stderr.on("data", (chunk) => { ffmpegError = (ffmpegError + chunk.toString()).slice(-6000); });
  ffmpeg.on("error", (error) => { job.state = "failed"; job.error = error.message; cleanup(); });
  ffmpeg.on("close", async (code) => {
    if (job.state === "cancelled") return cleanup();
    if (code !== 0 || !fs.existsSync(audioPath)) {
      job.state = "failed";
      job.error = ffmpegError || "无法提取视频音频。";
      return cleanup();
    }
    job.state = "transcribing";
    job.progress = 0.08;
    await beginTranscription(job, { wavPath: audioPath, duration: Number(duration || 0), script, removals: [], cleanup, speechLanguage: effectiveSpeechLanguage });
  });
  return { jobId: id };
}

export function autoCaptionAnalysisStatus(jobId) {
  const job = autoCaptionAnalyses.get(String(jobId || ""));
  if (!job) throw new Error("自动字幕任务已经不存在。");
  return {
    jobId: job.id,
    state: job.state,
    progress: job.progress,
    error: job.error,
    result: job.state === "completed" ? job.result : null,
  };
}

export function cancelAutoCaptionAnalysis(jobId) {
  const job = autoCaptionAnalyses.get(String(jobId || ""));
  if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return false;
  job.state = "cancelled";
  try { job.controller?.abort(); } catch { /* stopped */ }
  try { job.child?.kill("SIGTERM"); } catch { /* stopped */ }
  return true;
}
