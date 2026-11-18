import { randomUUID } from "node:crypto";
import type { SignatureStore } from "../signatures.js";
import type { GeminiPart, GeminiResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Gemini → OpenAI の変換（stream なし・stream ありで共通の部品）
// ---------------------------------------------------------------------------

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function newCompletionId(): string {
  return `chatcmpl-${randomUUID().replaceAll("-", "")}`;
}

function newToolCallId(): string {
  return `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Gemini の finishReason を OpenAI の finish_reason にする */
export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason | null {
  if (hasToolCalls) return "tool_calls";
  switch (reason) {
    case undefined:
    case "FINISH_REASON_UNSPECIFIED":
      return null;
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "content_filter";
    default:
      return "stop";
  }
}

export function mapUsage(usage: GeminiResponse["usageMetadata"]) {
  if (!usage) return undefined;
  const prompt = usage.promptTokenCount ?? 0;
  // 思考に使ったトークンも、課金上は出力トークンに入るので足しておく
  const completion = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokenCount ?? prompt + completion,
  };
}

/** parts を本文とツール呼び出しに分ける。思考の要約（thought: true）は出さない */
export function splitParts(parts: GeminiPart[] | undefined, signatures: SignatureStore) {
  let text = "";
  const toolCalls: OpenAIToolCall[] = [];
  for (const part of parts ?? []) {
    if (part.functionCall) {
      const id = part.functionCall.id ?? newToolCallId();
      // 署名は次のリクエストで送り返すために覚えておく
      if (part.thoughtSignature) signatures.set(id, part.thoughtSignature);
      toolCalls.push({
        id,
        type: "function",
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
      });
    } else if (typeof part.text === "string" && !part.thought) {
      text += part.text;
    }
  }
  return { text, toolCalls };
}

/** stream なしのレスポンスを変換する */
export function toChatCompletion(res: GeminiResponse, model: string, signatures: SignatureStore) {
  const candidate = res.candidates?.[0];
  const { text, toolCalls } = splitParts(candidate?.content?.parts, signatures);
  // 候補が無いのは、プロンプト自体がブロックされたとき
  const blocked = !candidate && res.promptFeedback?.blockReason;
  const finish = blocked ? "content_filter" : (mapFinishReason(candidate?.finishReason, toolCalls.length > 0) ?? "stop");

  return {
    id: newCompletionId(),
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant" as const,
          content: text === "" && toolCalls.length > 0 ? null : text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    ...(res.usageMetadata ? { usage: mapUsage(res.usageMetadata) } : {}),
  };
}
