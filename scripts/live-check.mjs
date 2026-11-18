// 実際の Gemini API を通して、プロキシの主な動きを確かめるスクリプト。
// 先にプロキシを起動してから実行する：node scripts/live-check.mjs
const BASE = process.env.PROXY_URL ?? "http://127.0.0.1:8787/v1";
const MODEL = process.env.PROXY_MODEL ?? "gemini-3.8-flash";

const post = (body) =>
  fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, ...body }) });

// Copilot のツール定義によくある、Gemini がそのままでは受け付けない書き方をわざと入れる
const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "指定した都市の天気を返す",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          city: { type: "string", examples: ["Tokyo"] },
          unit: { oneOf: [{ const: "celsius" }, { const: "fahrenheit" }] },
          options: { $ref: "#/$defs/Options" },
          note: { type: ["string", "null"] },
        },
        required: ["city"],
        additionalProperties: false,
        $defs: {
          Options: {
            allOf: [{ type: "object", properties: { detailed: { type: "boolean" } } }, { properties: { days: { type: "integer", exclusiveMinimum: 0 } } }],
          },
        },
      },
    },
  },
];

let ok = true;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "NG "} ${name}${detail ? `  … ${detail}` : ""}`);
  if (!cond) ok = false;
};

// 1. stream なし
{
  const res = await post({ messages: [{ role: "user", content: "「こんにちは」とだけ返して" }] });
  const json = await res.json();
  check("stream なし", res.status === 200 && typeof json.choices?.[0]?.message?.content === "string", JSON.stringify(json.choices?.[0]?.message?.content ?? json));
}

// 2. stream あり
{
  const res = await post({ stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "1から5まで日本語で数えて" }] });
  const text = await res.text();
  const chunks = text.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
  check("stream あり", res.status === 200 && text.endsWith("data: [DONE]\n\n") && content.length > 0, JSON.stringify(content));
  check("stream の usage", chunks.some((c) => c.usage?.total_tokens > 0));
}

// 3. ツール呼び出しの往復（スキーマ変換と thoughtSignature の送り返し）
{
  const messages = [{ role: "user", content: "東京の天気を摂氏で調べて、一言で教えて" }];
  const res1 = await post({ stream: true, messages, tools });
  const text1 = await res1.text();
  const chunks = text1.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  check("スキーマを変換したツール定義が通り、ツールが呼ばれる", res1.status === 200 && calls.length > 0, JSON.stringify(calls.map((c) => c.function)));

  if (calls.length > 0) {
    messages.push({ role: "assistant", content: null, tool_calls: calls.map(({ index, ...c }) => c) });
    for (const c of calls) messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ weather: "晴れ", temperature: 18 }) });
    const res2 = await post({ messages, tools });
    const json2 = await res2.json();
    check("ツールの結果を返して、最後の答えが返る（署名の送り返し）", res2.status === 200 && !!json2.choices?.[0]?.message?.content, JSON.stringify(json2.choices?.[0]?.message?.content ?? json2));
  }
}

// 4. 対応していないパラメータ
{
  const res = await post({ messages: [{ role: "user", content: "x" }], logprobs: true });
  check("未対応のパラメータは 400", res.status === 400, (await res.json()).error?.message);
}

console.log(ok ? "\nすべて OK" : "\nNG があります");
process.exit(ok ? 0 : 1);
