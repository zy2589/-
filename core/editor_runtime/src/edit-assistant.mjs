import { completeGeminiReview, reviewReady } from "./ai-settings.mjs";

export const EDIT_ASSISTANT_ACTIONS = Object.freeze({
  transcribe_captions: "转录并生成字幕",
  align_script: "按正确文案对齐字幕",
  check_differences: "核对错词和重读",
  remove_confirmed_repeats: "剪除 AI 已确认的重读片段",
});

const ACTION_IDS = new Set(Object.keys(EDIT_ASSISTANT_ACTIONS));
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    actions: { type: "array", items: { type: "string", enum: [...ACTION_IDS] } },
  },
  required: ["reply", "actions"],
};

function boundedText(value, limit) {
  return String(value || "").slice(0, limit);
}

function safeContext(value = {}) {
  const context = value && typeof value === "object" ? value : {};
  const issues = Array.isArray(context.issues) ? context.issues.slice(0, 40) : [];
  return {
    projectName: boundedText(context.projectName, 100),
    hasVideo: context.hasVideo === true,
    mediaCount: Math.max(0, Math.min(200, Number(context.mediaCount) || 0)),
    duration: Math.max(0, Math.min(24 * 60 * 60, Number(context.duration) || 0)),
    hasScript: context.hasScript === true,
    script: boundedText(context.script, 12000),
    hasTranscript: context.hasTranscript === true,
    transcript: boundedText(context.transcript, 12000),
    captionCount: Math.max(0, Math.min(10000, Number(context.captionCount) || 0)),
    issues: issues.map((issue) => ({
      id: boundedText(issue?.id, 80),
      type: boundedText(issue?.type, 30),
      start: Math.max(0, Number(issue?.start) || 0),
      end: Math.max(0, Number(issue?.end) || 0),
      spoken: boundedText(issue?.spoken || issue?.spokenText, 180),
      expected: boundedText(issue?.expected || issue?.expectedText, 180),
      scripture: issue?.scripture === true,
      confirmedCut: issue?.confirmedCut === true,
      action: boundedText(issue?.action, 24),
    })),
  };
}

function parseAssistantResponse(raw) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate || candidate === text) {
    try { return JSON.parse(text); } catch { throw new Error("AI 返回的剪辑建议格式无法识别，请重试。"); }
  }
  try { return JSON.parse(candidate); }
  catch { throw new Error("AI 返回的剪辑建议格式无法识别，请重试。"); }
}

export async function planEditAssistant(input = {}) {
  const message = boundedText(input.message, 2000).trim();
  if (!message) throw new Error("请先描述你想处理的转录、字幕或片段问题。");
  const context = safeContext(input.context);
  if (!context.hasVideo) {
    return {
      reply: "当前工程还没有导入视频或音频。先把素材导入工程，再让我转录、对齐字幕或核对重复片段。",
      actions: [],
      labels: EDIT_ASSISTANT_ACTIONS,
    };
  }
  if (!reviewReady()) throw new Error("请先在「纠正设置」中完成 Gemini 账号登录或配置 Gemini API Key。");

  const history = (Array.isArray(input.history) ? input.history : [])
    .slice(-8)
    .map((item) => ({
      role: item?.role === "assistant" ? "assistant" : "user",
      content: boundedText(item?.content, 1200),
    }));
  const system = [
    "你是剪辑助手里的对话剪辑助手。只帮助完成正常口播/采访剪辑：语音转录、字幕生成、按正确文案对齐、发现错词/重复/重读，并可剪除明确确认的重复重读。",
    "不做精彩集锦、社交媒体短片、竖屏改编、素材生成、音乐生成或与视频剪辑无关的动作。",
    "只能返回 JSON：{\"reply\":\"面向用户的简短中文回复\",\"actions\":[允许的动作ID]}。",
    `允许的动作ID：${[...ACTION_IDS].join(", ")}。动作只可从这组 ID 选择，不得输出工具名、代码或其他动作。`,
    "转录/字幕：有视频时可选 transcribe_captions。若有正确文案，优先建议 align_script。",
    "核对错词和重读：需有正确文案和视频；选择 check_differences。若用户明确要求删除重复重读，可在核对之后再选择 remove_confirmed_repeats。",
    "错词、缺词、经文差异或无法确定的重读必须保留并标记供人工核对；remove_confirmed_repeats 只会剪除应用判断为可安全删除的重复重读。绝不建议按单纯文本相同自动删片。",
    "如果缺少视频或正确文案，先简短说明还需要什么，并返回空 actions。不要编造识别结果或假称已经剪辑。",
    "只根据用户请求和工程上下文决定要运行的步骤。按执行顺序输出，无需重复已经完成的步骤。reply 简短、清楚。",
  ].join("\n");
  const user = JSON.stringify({
    request: message,
    recentConversation: history,
    currentProject: context,
  });
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 60_000);
  let raw;
  try {
    raw = await completeGeminiReview({ system, user, signal: controller.signal, responseSchema: RESPONSE_SCHEMA });
  } catch (error) {
    if (timedOut) throw new Error("Gemini 60 秒内没有返回。请检查 Gemini 登录状态和网络后重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const result = parseAssistantResponse(raw);
  const actions = [...new Set((Array.isArray(result?.actions) ? result.actions : [])
    .filter((action) => ACTION_IDS.has(action)))].slice(0, 4);
  if (actions.some((action) => action !== "transcribe_captions") && !context.hasVideo) {
    return { reply: "请先在当前工程导入视频或音频。", actions: [] };
  }
  if (actions.some((action) => ["align_script", "check_differences", "remove_confirmed_repeats"].includes(action)) && !context.hasScript) {
    return { reply: "要对齐字幕、核对错词或判断重读，请先在「正确文案」里粘贴对应文稿。", actions: [] };
  }
  return {
    reply: boundedText(result?.reply, 700).trim() || "我可以帮你转录、对齐字幕，或核对错词和重复重读。",
    actions,
    labels: EDIT_ASSISTANT_ACTIONS,
  };
}
