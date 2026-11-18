import { describe, expect, it } from "vitest";
import { mapFinishReason, toChatCompletion } from "../src/convert/response.js";
import { parseSse, toOpenAISse } from "../src/convert/stream.js";
import { SignatureStore } from "../src/signatures.js";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function* bytes(...chunks: (string | Uint8Array)[]) {
  for (const c of chunks) yield typeof c === "string" ? new TextEncoder().encode(c) : c;
}

const parseChunks = (lines: string[]) =>
  lines.filter((l) => l !== "data: [DONE]\n\n").map((l) => JSON.parse(l.replace(/^data: /, "")) as Record<string, any>);

describe("レスポンス変換（stream なし）", () => {
  it("本文を message.content にし、usage も変換する", () => {
    const res = toChatCompletion(
      {
        candidates: [{ content: { parts: [{ text: "考え中", thought: true }, { text: "こんにちは" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3, totalTokenCount: 18 },
      },
      "gemini-flash",
      new SignatureStore(),
    );
    expect(res.choices[0]).toEqual({ index: 0, message: { role: "assistant", content: "こんにちは" }, finish_reason: "stop" });
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 });
    expect(res.model).toBe("gemini-flash");
  });

  it("functionCall を tool_calls にし、署名を覚える", () => {
    const sigs = new SignatureStore();
    const res = toChatCompletion(
      {
        candidates: [
          { content: { parts: [{ functionCall: { id: "fc1", name: "read_file", args: { path: "a" } }, thoughtSignature: "S" }] }, finishReason: "STOP" },
        ],
      },
      "m",
      sigs,
    );
    expect(res.choices[0]?.message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "fc1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(res.choices[0]?.finish_reason).toBe("tool_calls");
    expect(sigs.get("fc1")).toBe("S");
  });

  it("Gemini が id を返さないときは tool_call の id を作る", () => {
    const res = toChatCompletion({ candidates: [{ content: { parts: [{ functionCall: { name: "f" } }] } }] }, "m", new SignatureStore());
    expect(res.choices[0]?.message.tool_calls?.[0]?.id).toMatch(/^call_[0-9a-f]{24}$/);
  });

  it("finishReason を対応づける", () => {
    expect(mapFinishReason("STOP", false)).toBe("stop");
    expect(mapFinishReason("MAX_TOKENS", false)).toBe("length");
    expect(mapFinishReason("SAFETY", false)).toBe("content_filter");
    expect(mapFinishReason("STOP", true)).toBe("tool_calls");
  });

  it("プロンプトがブロックされたときは content_filter にする", () => {
    const res = toChatCompletion({ promptFeedback: { blockReason: "SAFETY" } }, "m", new SignatureStore());
    expect(res.choices[0]?.finish_reason).toBe("content_filter");
  });
});

describe("SSE の読み取り", () => {
  it("UTF-8 の1文字がチャンクの境目で分かれても壊さない", async () => {
    const all = new TextEncoder().encode('data: {"t":"日本語"}\n\n');
    // 「日」（3バイト）の途中で切る
    const cut = all.indexOf(0xe6) + 1;
    const events = await collect(parseSse(bytes(all.slice(0, cut), all.slice(cut))));
    expect(events).toEqual(['{"t":"日本語"}']);
  });

  it("\\r\\n の改行と、最後の空行が無い場合にも対応する", async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\r\n\r\ndata: {"b":2}')));
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("1つのイベントが複数のチャンクに分かれても1つにつなげる", async () => {
    const events = await collect(parseSse(bytes("da", 'ta: {"x"', ":1}\n", "\n")));
    expect(events).toEqual(['{"x":1}']);
  });
});

describe("SSE の変換（Gemini → OpenAI）", () => {
  const run = (events: object[], includeUsage = false, sigs = new SignatureStore()) =>
    collect(
      toOpenAISse(
        (async function* () {
          for (const e of events) yield JSON.stringify(e);
        })(),
        { model: "gemini-flash", includeUsage, signatures: sigs },
      ),
    );

  it("本文を delta.content にし、最後に [DONE] を足す", async () => {
    const lines = await run([
      { candidates: [{ content: { parts: [{ text: "こん" }] } }] },
      { candidates: [{ content: { parts: [{ text: "にちは" }] }, finishReason: "STOP" }] },
    ]);
    expect(lines.at(-1)).toBe("data: [DONE]\n\n");
    const chunks = parseChunks(lines);
    expect(chunks[0]?.choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks.map((c) => c.choices[0]?.delta.content).filter(Boolean).join("")).toBe("こんにちは");
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
    expect(chunks.every((c) => c.object === "chat.completion.chunk" && c.model === "gemini-flash")).toBe(true);
    // id はストリームの中で全部同じ
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  });

  it("functionCall を tool_calls の delta にし、index を振る", async () => {
    const sigs = new SignatureStore();
    const lines = await run(
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { id: "a", name: "f1", args: { x: 1 } }, thoughtSignature: "SIG" },
                  { functionCall: { id: "b", name: "f2", args: {} } },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      ],
      false,
      sigs,
    );
    const calls = parseChunks(lines).flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(calls).toEqual([
      { index: 0, id: "a", type: "function", function: { name: "f1", arguments: '{"x":1}' } },
      { index: 1, id: "b", type: "function", function: { name: "f2", arguments: "{}" } },
    ]);
    expect(parseChunks(lines).at(-1)?.choices[0].finish_reason).toBe("tool_calls");
    expect(sigs.get("a")).toBe("SIG");
  });

  it("include_usage のときは usage だけの chunk を [DONE] の前に送る", async () => {
    const lines = await run(
      [{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } }],
      true,
    );
    const last = parseChunks(lines).at(-1);
    expect(last?.choices).toEqual([]);
    expect(last?.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});
