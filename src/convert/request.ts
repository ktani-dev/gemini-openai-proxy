import { z } from "zod";
import { ProxyError } from "../errors.js";
import { SKIP_SIGNATURE, type SignatureStore } from "../signatures.js";
import type { GeminiContent, GeminiFunctionDeclaration, GeminiPart, GeminiRequest, JsonObject } from "../types.js";
import { convertSchema, type SchemaWarning } from "./schema.js";

// ---------------------------------------------------------------------------
// OpenAI Chat Completions のリクエスト（受け付ける範囲）
// ---------------------------------------------------------------------------

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const ImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string(), detail: z.string().optional() }),
});
const ContentPart = z.discriminatedUnion("type", [TextPart, ImagePart]);
const Content = z.union([z.string(), z.array(ContentPart)]).nullish();

const ToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const Message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: Content, name: z.string().optional() }),
  z.object({ role: z.literal("developer"), content: Content, name: z.string().optional() }),
  z.object({ role: z.literal("user"), content: Content, name: z.string().optional() }),
  z.object({
    role: z.literal("assistant"),
    content: Content,
    name: z.string().optional(),
    tool_calls: z.array(ToolCall).optional(),
    refusal: z.string().nullish(),
  }),
  z.object({ role: z.literal("tool"), content: Content, tool_call_id: z.string() }),
]);

const Tool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullish(),
  }),
});

const ToolChoice = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
]);

/**
 * strictObject なので、ここに無いパラメータが来たら 400 で断る（黙って捨てない）。
 * 「受け取るが Gemini に送らない」ものは IGNORED_PARAMS に分けて明示する。
 */
export const ChatRequestSchema = z.strictObject({
  model: z.string(),
  messages: z.array(Message).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(5)]).nullish(),
  n: z.literal(1).nullish(),
  tools: z.array(Tool).optional(),
  tool_choice: ToolChoice.optional(),
  // 以下は受け取るが Gemini には送らない（意味が無い・対応する項目が無いもの）
  parallel_tool_calls: z.boolean().optional(),
  user: z.string().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const IGNORED_PARAMS = ["parallel_tool_calls", "user"] as const;

export function parseChatRequest(body: unknown): ChatRequest {
  const result = ChatRequestSchema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0]!;
  if (issue.code === "unrecognized_keys") {
    throw new ProxyError(
      400,
      `このプロキシが対応していないパラメータです: ${issue.keys.join(", ")}`,
      "invalid_request_error",
      "unsupported_parameter",
      issue.keys[0] ?? null,
    );
  }
  const param = issue.path.join(".");
  throw new ProxyError(400, `リクエストの形が正しくありません（${param || "body"}）: ${issue.message}`, "invalid_request_error", null, param || null);
}

// ---------------------------------------------------------------------------
// OpenAI → Gemini の変換
// ---------------------------------------------------------------------------

export interface ConvertedRequest {
  body: GeminiRequest;
  schemaWarnings: SchemaWarning[];
}

export function toGeminiRequest(req: ChatRequest, signatures: SignatureStore): ConvertedRequest {
  const systemParts: GeminiPart[] = [];
  const contents: GeminiContent[] = [];
  // tool_call_id → 関数名（role: tool のメッセージには関数名が無いので、前の assistant から引く）
  const toolNames = new Map<string, string>();

  const push = (role: GeminiContent["role"], parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    // Gemini は同じ role が続くのを嫌うので、続いたら1つにまとめる（順番は保つ）
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const [i, msg] of req.messages.entries()) {
    switch (msg.role) {
      case "system":
      case "developer":
        // Gemini の systemInstruction は1つだけなので、途中にあってもまとめる
        systemParts.push(...toParts(msg.content, `messages.${i}`));
        break;

      case "user":
        push("user", toParts(msg.content, `messages.${i}`));
        break;

      case "assistant": {
        const parts = toParts(msg.content, `messages.${i}`);
        for (const [j, call] of (msg.tool_calls ?? []).entries()) {
          toolNames.set(call.id, call.function.name);
          const part: GeminiPart = {
            functionCall: { name: call.function.name, args: parseArguments(call.function.arguments, `messages.${i}.tool_calls.${j}`) },
          };
          // Gemini 3 系：1ターンの最初の functionCall には署名が必要
          if (j === 0) part.thoughtSignature = signatures.get(call.id) ?? SKIP_SIGNATURE;
          else {
            const sig = signatures.get(call.id);
            if (sig) part.thoughtSignature = sig;
          }
          parts.push(part);
        }
        push("model", parts);
        break;
      }

      case "tool": {
        const name = toolNames.get(msg.tool_call_id);
        if (!name) {
          throw new ProxyError(400, `tool_call_id に対応する tool_calls がありません: ${msg.tool_call_id}`, "invalid_request_error", null, `messages.${i}.tool_call_id`);
        }
        push("user", [{ functionResponse: { name, response: toResponseObject(contentToText(msg.content)) } }]);
        break;
      }
    }
  }

  if (contents.length === 0) {
    throw new ProxyError(400, "system 以外のメッセージが1つもありません", "invalid_request_error", null, "messages");
  }

  const body: GeminiRequest = { contents };
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };

  const schemaWarnings: SchemaWarning[] = [];
  if (req.tools && req.tools.length > 0) {
    const declarations: GeminiFunctionDeclaration[] = req.tools.map((tool) => {
      const decl: GeminiFunctionDeclaration = { name: tool.function.name };
      if (tool.function.description) decl.description = tool.function.description;
      const params = tool.function.parameters;
      // 引数の無いツールは parameters を付けない（空の OBJECT は Gemini が嫌う）
      if (params && Object.keys(asObject(params.properties)).length > 0) {
        const { schema, warnings } = convertSchema(params, tool.function.name);
        decl.parameters = schema;
        schemaWarnings.push(...warnings);
      }
      return decl;
    });
    body.tools = [{ functionDeclarations: declarations }];
  }

  if (req.tool_choice) body.toolConfig = toToolConfig(req.tool_choice);

  const gen: NonNullable<GeminiRequest["generationConfig"]> = {};
  if (req.temperature != null) gen.temperature = req.temperature;
  if (req.top_p != null) gen.topP = req.top_p;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens != null) gen.maxOutputTokens = maxTokens;
  if (req.stop != null) gen.stopSequences = typeof req.stop === "string" ? [req.stop] : req.stop;
  if (Object.keys(gen).length > 0) body.generationConfig = gen;

  return { body, schemaWarnings };
}

function toToolConfig(choice: NonNullable<ChatRequest["tool_choice"]>): NonNullable<GeminiRequest["toolConfig"]> {
  if (choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
}

type OpenAIContent = z.infer<typeof Content>;

function toParts(content: OpenAIContent, param: string): GeminiPart[] {
  if (content == null) return [];
  if (typeof content === "string") return content === "" ? [] : [{ text: content }];
  return content.map((part, k): GeminiPart => {
    if (part.type === "text") return { text: part.text };
    // 画像は data URL（base64）だけ受け付ける。外部 URL を取りに行くことはしない
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url.url);
    if (!m) {
      throw new ProxyError(400, "画像は data URL（base64）の形だけ対応しています", "invalid_request_error", null, `${param}.content.${k}.image_url.url`);
    }
    return { inlineData: { mimeType: m[1]!, data: m[2]! } };
  });
}

function contentToText(content: OpenAIContent): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

function parseArguments(args: string, param: string): JsonObject {
  if (args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // 下で 400 にする
  }
  throw new ProxyError(400, "tool_calls の arguments が JSON オブジェクトとして読めません", "invalid_request_error", null, `${param}.function.arguments`);
}

/** ツールの結果を functionResponse.response（JSON オブジェクト）にする */
function toResponseObject(text: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch {
    // ただの文字列なら下でくるむ
  }
  return { result: text };
}

function asObject(v: unknown): JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
}
