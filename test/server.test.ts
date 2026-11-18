import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRequests } from "../src/capture/analyze.js";
import { parseConfig, type Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// 上流（Gemini）をまねたモックサーバーを立てて、プロキシを通しで確かめる結合テスト
// ---------------------------------------------------------------------------

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

interface Mock {
  url: string;
  calls: { url: string; headers: Record<string, unknown>; body: any }[];
  app: FastifyInstance;
}

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startMock(handler: Handler): Promise<Mock> {
  // ストリームを流し続けるモックもあるので、閉じるときは接続を強制的に切る（Node.js 22 では切らないと close が終わらない）
  const app = Fastify({ forceCloseConnections: true });
  const calls: Mock["calls"] = [];
  app.post("/v1beta/models/:action", async (req, reply) => {
    calls.push({ url: req.url, headers: req.headers, body: req.body });
    return handler(req, reply);
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  return { url: `${address}/v1beta`, calls, app };
}

function makeConfig(baseUrl: string, overrides: Partial<Config["upstream"]> & { capture?: Config["capture"] } = {}): Config {
  const { capture, ...upstream } = overrides;
  return parseConfig({
    upstream: { baseUrl, maxConcurrency: 4, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }, ...upstream },
    models: [{ id: "gemini-flash", upstreamModel: "gemini-test-model" }],
    capture,
  });
}

function makeProxy(config: Config, waits: number[] = []) {
  const app = buildServer({
    config,
    apiKey: "TEST_KEY",
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  cleanups.push(() => app.close());
  return app;
}

const chat = (extra: object = {}) => ({ model: "gemini-flash", messages: [{ role: "user", content: "hi" }], ...extra });

const geminiText = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
});

function sseLines(payload: string): Record<string, any>[] {
  return payload
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

describe("通しの動き", () => {
  it("stream なし：モデル名を対応づけ、API キーをヘッダーで送り、OpenAI 形式で返す", async () => {
    const mock = await startMock(() => geminiText("やあ"));
    const proxy = makeProxy(makeConfig(mock.url));

    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe("やあ");
    expect(mock.calls[0]?.url).toBe("/v1beta/models/gemini-test-model:generateContent");
    expect(mock.calls[0]?.headers["x-goog-api-key"]).toBe("TEST_KEY");
    expect(mock.calls[0]?.body).toEqual({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  });

  it("stream あり：Gemini の SSE を OpenAI の SSE にして返す（UTF-8 が分割されても壊れない）", async () => {
    const mock = await startMock((_req, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const ev = new TextEncoder().encode(`data: ${JSON.stringify(geminiText("日本語のテキスト"))}\r\n\r\n`);
      const cut = ev.indexOf(0xe6) + 1; // 「日」の途中で切る
      reply.raw.write(ev.slice(0, cut));
      setTimeout(() => {
        reply.raw.write(ev.slice(cut));
        reply.raw.end();
      }, 10);
      return reply;
    });
    const proxy = makeProxy(makeConfig(mock.url));

    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ stream: true }) });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(mock.calls[0]?.url).toBe("/v1beta/models/gemini-test-model:streamGenerateContent?alt=sse");
    expect(res.payload.endsWith("data: [DONE]\n\n")).toBe(true);
    const text = sseLines(res.payload).map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("日本語のテキスト");
  });

  it("ツールを使う会話の往復で、Gemini 3 の thoughtSignature を覚えて送り返す", async () => {
    let turn = 0;
    const mock = await startMock(() =>
      ++turn === 1
        ? { candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.md" } }, thoughtSignature: "REAL_SIG" }] }, finishReason: "STOP" }] }
        : geminiText("読みました"),
    );
    const proxy = makeProxy(makeConfig(mock.url));
    const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } }];

    const first = (await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ tools }) })).json();
    const call = first.choices[0].message.tool_calls[0];
    expect(first.choices[0].finish_reason).toBe("tool_calls");

    // Copilot はツールを実行して、結果を付けて次のリクエストを送ってくる（署名は送ってこない）
    await proxy.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: chat({
        tools,
        messages: [
          { role: "user", content: "a.md を読んで" },
          { role: "assistant", content: null, tool_calls: [call] },
          { role: "tool", tool_call_id: call.id, content: "中身" },
        ],
      }),
    });

    const sent = mock.calls[1]?.body.contents;
    expect(sent[1].parts[0]).toEqual({ functionCall: { name: "read_file", args: { path: "a.md" } }, thoughtSignature: "REAL_SIG" });
    expect(sent[2].parts[0]).toEqual({ functionResponse: { name: "read_file", response: { result: "中身" } } });
  });

  it("GET /v1/models は config.json のモデルを返す", async () => {
    const proxy = makeProxy(makeConfig("http://127.0.0.1:1/v1beta"));
    const res = await proxy.inject({ method: "GET", url: "/v1/models" });
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(["gemini-flash"]);
  });
});

describe("エラーと再試行", () => {
  it("503 のあとに成功したら、再試行して結果を返す", async () => {
    let n = 0;
    const mock = await startMock((_req, reply) => (++n === 1 ? reply.code(503).send({ error: { message: "busy" } }) : geminiText("ok")));
    const waits: number[] = [];
    const proxy = makeProxy(makeConfig(mock.url), waits);

    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });

    expect(res.statusCode).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(waits).toEqual([1]);
  });

  it("429 の Retry-After に従って待つ。回数を使い切ったら 429 を OpenAI 形式で返す", async () => {
    const mock = await startMock((_req, reply) =>
      reply.code(429).header("retry-after", "0").send({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }),
    );
    const waits: number[] = [];
    const proxy = makeProxy(makeConfig(mock.url), waits);

    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });

    expect(mock.calls).toHaveLength(3); // 最初の1回 + 再試行2回
    expect(waits).toEqual([0, 0]);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: { message: "[upstream 429] quota", type: "rate_limit_error", code: "RESOURCE_EXHAUSTED", param: null },
    });
  });

  it("400 は再試行せずにそのまま返す", async () => {
    const mock = await startMock((_req, reply) => reply.code(400).send({ error: { message: "bad schema", status: "INVALID_ARGUMENT" } }));
    const proxy = makeProxy(makeConfig(mock.url));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });
    expect(mock.calls).toHaveLength(1);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("bad schema");
  });

  it("上流の 500 は 502 にして返す", async () => {
    const mock = await startMock((_req, reply) => reply.code(500).send("oops"));
    const proxy = makeProxy(makeConfig(mock.url));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe("upstream_error");
  });

  it("上流がヘッダーを返さないままなら 504 にする", async () => {
    const mock = await startMock(() => new Promise(() => {})); // 返事をしない
    const proxy = makeProxy(makeConfig(mock.url, { headersTimeoutMs: 50 }));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() });
    expect(res.statusCode).toBe(504);
  });

  it("ストリームの途中でデータが止まったら、エラーのイベントと [DONE] を送って終える", async () => {
    const mock = await startMock((_req, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      reply.raw.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "途中" }] } }] })}\n\n`);
      return reply; // そのまま何も送らない
    });
    const proxy = makeProxy(makeConfig(mock.url, { streamIdleTimeoutMs: 50 }));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ stream: true }) });
    const events = sseLines(res.payload);
    expect(events.at(-1)?.error.code).toBe("timeout");
    expect(res.payload.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("config.json に無いモデルは 404", async () => {
    const proxy = makeProxy(makeConfig("http://127.0.0.1:1/v1beta"));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ model: "gpt-4o" }) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("model_not_found");
  });

  it("対応していないパラメータは上流に送らずに 400", async () => {
    const mock = await startMock(() => geminiText("x"));
    const proxy = makeProxy(makeConfig(mock.url));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ logprobs: true }) });
    expect(res.statusCode).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it("壊れた JSON は 400 を OpenAI 形式で返す", async () => {
    const proxy = makeProxy(makeConfig("http://127.0.0.1:1/v1beta"));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: "{oops" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe("invalid_request_error");
  });
});

describe("安全と無駄づかいの防止", () => {
  it("localhost 以外からの接続は 403", async () => {
    const proxy = makeProxy(makeConfig("http://127.0.0.1:1/v1beta"));
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat(), remoteAddress: "192.168.0.10" });
    expect(res.statusCode).toBe(403);
  });

  it("リクエストの中身で上流の URL を変えられない", async () => {
    const mock = await startMock(() => geminiText("x"));
    const proxy = makeProxy(makeConfig(mock.url));
    // モデル名に URL を入れても、config.json に無いので 404 になり、どこにも送られない
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat({ model: "../../evil.example.com" }) });
    expect(res.statusCode).toBe(404);
    expect(mock.calls).toHaveLength(0);
  });

  it("同時に上流へ送る数を maxConcurrency までにする", async () => {
    let active = 0;
    let peak = 0;
    const mock = await startMock(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return geminiText("x");
    });
    const proxy = makeProxy(makeConfig(mock.url, { maxConcurrency: 2 }));
    const results = await Promise.all(Array.from({ length: 5 }, () => proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: chat() })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(peak).toBe(2);
  });

  it("クライアントが切断したら、上流へのストリームも止める", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    let chunksSent = 0;
    const mock = await startMock((req, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(() => {
        chunksSent++;
        reply.raw.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "." }] } }] })}\n\n`);
      }, 10);
      req.raw.socket.on("close", () => {
        clearInterval(timer);
        upstreamClosed();
      });
      return reply;
    });
    const proxy = makeProxy(makeConfig(mock.url));
    const address = await proxy.listen({ host: "127.0.0.1", port: 0 });

    const controller = new AbortController();
    const res = await fetch(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chat({ stream: true })),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // 1つ受け取ってから
    controller.abort(); // 切断する

    await closed; // 上流との接続も閉じられる（閉じられなければテストがタイムアウトする）
    const sentAtClose = chunksSent;
    await new Promise((r) => setTimeout(r, 50));
    expect(chunksSent).toBe(sentAtClose);
  });
});

describe("調査モード", () => {
  it("上流に送らずにリクエストを保存し、スキーマのキーワードを数えられる", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const mock = await startMock(() => geminiText("x"));
    const proxy = makeProxy(makeConfig(mock.url, { capture: { enabled: true, dir } }));

    const body = chat({
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "edit",
            parameters: {
              $schema: "x",
              type: "object",
              properties: { mode: { oneOf: [{ const: "a" }, { const: "b" }] }, type: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
    });
    const res = await proxy.inject({ method: "POST", url: "/v1/chat/completions", payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("[capture mode]");
    expect(mock.calls).toHaveLength(0);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(dir, files[0]!), "utf8"));
    expect(saved).toEqual(body);

    const result = analyzeRequests([saved]);
    const byKey = Object.fromEntries(result.keywords.map((k) => [k.keyword, k]));
    expect(byKey.const?.count).toBe(2);
    expect(byKey.oneOf?.allowed).toBe(false);
    expect(byKey.$schema?.allowed).toBe(false);
    // properties の中の "type" はプロパティ名なので数えない（キーワードの type は object と string の2回）
    expect(byKey.type?.count).toBe(2);
    // 使えないキーワードが先に並ぶ
    expect(result.keywords[0]?.allowed).toBe(false);
  });
});
