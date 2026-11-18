import { describe, expect, it } from "vitest";
import { parseChatRequest, toGeminiRequest } from "../src/convert/request.js";
import { ProxyError } from "../src/errors.js";
import { SignatureStore, SKIP_SIGNATURE } from "../src/signatures.js";

const convert = (body: object, sigs = new SignatureStore()) => toGeminiRequest(parseChatRequest({ model: "m", ...body }), sigs).body;

describe("リクエスト変換：メッセージ", () => {
  it("system と developer を systemInstruction にまとめる", () => {
    const body = convert({
      messages: [
        { role: "system", content: "S1" },
        { role: "developer", content: "S2" },
        { role: "user", content: "hi" },
      ],
    });
    expect(body.systemInstruction).toEqual({ parts: [{ text: "S1" }, { text: "S2" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("assistant を model にし、メッセージの順番を保つ", () => {
    const body = convert({
      messages: [
        { role: "user", content: "1" },
        { role: "assistant", content: "2" },
        { role: "user", content: "3" },
      ],
    });
    expect(body.contents.map((c) => [c.role, c.parts[0]?.text])).toEqual([
      ["user", "1"],
      ["model", "2"],
      ["user", "3"],
    ]);
  });

  it("同じ role が続いたら1つの contents にまとめる", () => {
    const body = convert({ messages: [{ role: "user", content: "a" }, { role: "user", content: [{ type: "text", text: "b" }] }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "a" }, { text: "b" }] }]);
  });

  it("data URL の画像を inlineData にする", () => {
    const body = convert({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
    });
    expect(body.contents[0]?.parts[0]).toEqual({ inlineData: { mimeType: "image/png", data: "AAAA" } });
  });

  it("外部 URL の画像は取りに行かずに 400 にする", () => {
    expect(() =>
      convert({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }] }),
    ).toThrow(ProxyError);
  });
});

describe("リクエスト変換：生成パラメータ", () => {
  it("temperature・top_p・max_tokens・stop を generationConfig にする", () => {
    const body = convert({ messages: [{ role: "user", content: "x" }], temperature: 0.2, top_p: 0.9, max_tokens: 100, stop: "END" });
    expect(body.generationConfig).toEqual({ temperature: 0.2, topP: 0.9, maxOutputTokens: 100, stopSequences: ["END"] });
  });

  it("max_completion_tokens を max_tokens より優先する", () => {
    const body = convert({ messages: [{ role: "user", content: "x" }], max_tokens: 100, max_completion_tokens: 50 });
    expect(body.generationConfig?.maxOutputTokens).toBe(50);
  });

  it("対応していないパラメータは黙って捨てずに 400 にする", () => {
    try {
      parseChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], logprobs: true });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyError);
      expect((e as ProxyError).status).toBe(400);
      expect((e as ProxyError).code).toBe("unsupported_parameter");
      expect((e as ProxyError).message).toContain("logprobs");
    }
  });

  it("n が 1 以外なら 400 にする", () => {
    expect(() => parseChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], n: 2 })).toThrow(ProxyError);
  });
});

describe("リクエスト変換：ツール", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "ファイルを読む",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
    },
    { type: "function", function: { name: "get_time", parameters: { type: "object", properties: {} } } },
  ];

  it("tools を functionDeclarations にし、スキーマも変換する", () => {
    const { body, schemaWarnings } = toGeminiRequest(parseChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], tools }), new SignatureStore());
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "ファイルを読む",
            parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] },
          },
          { name: "get_time" }, // 引数の無いツールは parameters を付けない
        ],
      },
    ]);
    expect(schemaWarnings).toHaveLength(1);
  });

  it("tool_choice を toolConfig にする", () => {
    const base = { messages: [{ role: "user", content: "x" }], tools };
    expect(convert({ ...base, tool_choice: "auto" }).toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(convert({ ...base, tool_choice: "none" }).toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(convert({ ...base, tool_choice: "required" }).toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(convert({ ...base, tool_choice: { type: "function", function: { name: "read_file" } } }).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
    });
  });

  it("ツール呼び出しの往復：tool_calls → functionCall、tool の結果 → functionResponse（関数名は tool_call_id から引く）", () => {
    const sigs = new SignatureStore();
    sigs.set("call_1", "SIG_1");
    const body = convert(
      {
        messages: [
          { role: "user", content: "README を読んで" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
              { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "# Title" },
          { role: "tool", tool_call_id: "call_2", content: '{"ok":true}' },
        ],
      },
      sigs,
    );
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "README を読んで" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "read_file", args: { path: "README.md" } }, thoughtSignature: "SIG_1" },
          { functionCall: { name: "read_file", args: { path: "a.md" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read_file", response: { result: "# Title" } } },
          { functionResponse: { name: "read_file", response: { ok: true } } },
        ],
      },
    ]);
  });

  it("署名を覚えていないときは、最初の functionCall に回避用の値を付ける", () => {
    const body = convert({
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", tool_calls: [{ id: "unknown", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "unknown", content: "r" },
      ],
    });
    expect(body.contents[1]?.parts[0]?.thoughtSignature).toBe(SKIP_SIGNATURE);
  });

  it("対応する tool_calls が無い tool メッセージは 400 にする", () => {
    expect(() => convert({ messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "nope", content: "r" }] })).toThrow(
      /tool_call_id/,
    );
  });

  it("arguments が JSON として読めなければ 400 にする", () => {
    expect(() =>
      convert({
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{broken" } }] },
        ],
      }),
    ).toThrow(/arguments/);
  });
});
