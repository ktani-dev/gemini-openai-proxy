import type { SignatureStore } from "../signatures.js";
import type { GeminiResponse } from "../types.js";
import { mapFinishReason, mapUsage, newCompletionId, splitParts } from "./response.js";

// ---------------------------------------------------------------------------
// Gemini の SSE（streamGenerateContent?alt=sse）→ OpenAI の SSE（chat.completion.chunk）
// ---------------------------------------------------------------------------

/**
 * バイト列の流れを SSE のイベント（data: の中身）に分ける。
 * - TextDecoder を stream モードで使い、UTF-8 の1文字がチャンクの境目で分かれても壊さない
 * - 改行は \n と \r\n の両方に対応する
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];

  const takeLines = function* (final: boolean): Generator<string> {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        // 空行でイベントが終わる
        if (dataLines.length > 0) yield dataLines.join("\n");
        dataLines = [];
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // event: / id: / コメント行（: で始まる）は使わないので読み飛ばす
    }
    if (final) {
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).replace(/^ /, ""));
      buffer = "";
      if (dataLines.length > 0) yield dataLines.join("\n");
      dataLines = [];
    }
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* takeLines(false);
  }
  buffer += decoder.decode();
  yield* takeLines(true);
}

export interface StreamOptions {
  model: string;
  includeUsage: boolean;
  signatures: SignatureStore;
}

/**
 * Gemini のイベントを OpenAI の chunk に変換し、SSE の文字列として1つずつ返す。
 * 最後に、Gemini には無い `data: [DONE]` を足す。
 */
export async function* toOpenAISse(events: AsyncIterable<string>, opts: StreamOptions): AsyncGenerator<string> {
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: object, finish: string | null, extra: object = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

  yield chunk({ role: "assistant", content: "" }, null);

  let toolIndex = 0;
  let finishReason: string | undefined;
  let blocked = false;
  let usage: GeminiResponse["usageMetadata"];

  for await (const data of events) {
    let res: GeminiResponse;
    try {
      res = JSON.parse(data) as GeminiResponse;
    } catch {
      continue; // 壊れたイベントは飛ばす
    }
    if (res.usageMetadata) usage = res.usageMetadata;
    if (!res.candidates?.length && res.promptFeedback?.blockReason) blocked = true;

    const candidate = res.candidates?.[0];
    const { text, toolCalls } = splitParts(candidate?.content?.parts, opts.signatures);
    if (text) yield chunk({ content: text }, null);
    for (const call of toolCalls) {
      // Gemini は関数呼び出しを分割せず1回で送ってくるので、arguments もまとめて送る
      yield chunk({ tool_calls: [{ index: toolIndex++, ...call }] }, null);
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason;
  }

  const finish = blocked ? "content_filter" : (mapFinishReason(finishReason, toolIndex > 0) ?? "stop");
  yield chunk({}, finish);

  if (opts.includeUsage && usage) {
    yield `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [], usage: mapUsage(usage) })}\n\n`;
  }
  yield "data: [DONE]\n\n";
}
