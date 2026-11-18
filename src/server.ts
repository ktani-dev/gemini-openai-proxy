import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CAPTURE_REPLY, saveCapture } from "./capture/capture.js";
import type { Config } from "./config.js";
import { parseChatRequest, toGeminiRequest } from "./convert/request.js";
import { toChatCompletion } from "./convert/response.js";
import { parseSse, toOpenAISse } from "./convert/stream.js";
import { ProxyError } from "./errors.js";
import { SignatureStore } from "./signatures.js";
import type { GeminiResponse } from "./types.js";
import { callUpstream, readWithIdleTimeout, Semaphore } from "./upstream.js";

export interface ServerOptions {
  config: Config;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: boolean | object;
}

const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { config } = opts;
  // Copilot は 128 個前後のツール定義を毎回送ってくるので、本文の上限は大きめにする
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  const signatures = new SignatureStore();
  const semaphore = new Semaphore(config.upstream.maxConcurrency);
  const upstreamDeps = {
    config,
    apiKey: opts.apiKey,
    fetch: opts.fetch ?? fetch,
    semaphore,
    sleep: opts.sleep,
    log: (msg: string) => app.log.warn(msg),
  };
  const modelMap = new Map(config.models.map((m) => [m.id, m.upstreamModel]));

  // 自分の PC からのリクエストだけ受け付ける（listen も 127.0.0.1 にしているが、念のため二重に確認）
  app.addHook("onRequest", async (request, reply) => {
    if (!LOCAL_ADDRESSES.has(request.ip)) {
      return reply.code(403).send(new ProxyError(403, "localhost 以外からの接続は受け付けません", "permission_error").toBody());
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProxyError) return reply.code(err.status).send(err.toBody());
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      // JSON が壊れている、本文が大きすぎる、など Fastify 自身が出すエラー
      return reply.code(e.statusCode).send(new ProxyError(e.statusCode, e.message ?? "bad request").toBody());
    }
    request.log.error(err);
    return reply.code(500).send(new ProxyError(500, "プロキシの内部でエラーが起きました", "server_error").toBody());
  });

  app.get("/health", async () => ({ status: "ok" }));

  const listModels = async () => ({
    object: "list",
    data: config.models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "google" })),
  });
  app.get("/v1/models", listModels);
  app.get("/models", listModels);

  const chatHandler = async (request: { body: unknown; log: FastifyInstance["log"] }, reply: FastifyReply) => {
    // 調査モード：変換も上流への送信もせず、届いた形のまま保存する
    if (config.capture.enabled) {
      const file = await saveCapture(config.capture.dir, request.body);
      request.log.info(`リクエストを保存しました: ${file}`);
      return captureReply(request.body, reply);
    }

    const req = parseChatRequest(request.body);
    const upstreamModel = modelMap.get(req.model);
    if (!upstreamModel) {
      throw new ProxyError(404, `モデル ${req.model} は config.json にありません`, "not_found_error", "model_not_found", "model");
    }

    const { body, schemaWarnings } = toGeminiRequest(req, signatures);
    if (schemaWarnings.length > 0) {
      // ツールごとに1行ずつ出すとうるさいので、まとめて1回だけ出す
      const keys = [...new Set(schemaWarnings.map((w) => w.message))];
      request.log.warn({ count: schemaWarnings.length, kinds: keys.slice(0, 20) }, "ツール定義のスキーマを変換しました");
    }

    // クライアント（Copilot）が切断したら、上流へのリクエストと SSE の送信を止める
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort(new Error("client disconnected"));
    });

    const { response, release } = await callUpstream(upstreamDeps, {
      upstreamModel,
      body,
      stream: req.stream === true,
      signal: controller.signal,
    });

    if (!req.stream) {
      try {
        const json = (await response.json()) as GeminiResponse;
        return toChatCompletion(json, req.model, signatures);
      } finally {
        release();
      }
    }

    if (!response.body) {
      release();
      throw new ProxyError(502, "上流のレスポンスに本文がありません", "upstream_error");
    }

    const sse = toOpenAISse(parseSse(readWithIdleTimeout(response.body, config.upstream.streamIdleTimeoutMs, controller.signal)), {
      model: req.model,
      includeUsage: req.stream_options?.include_usage === true,
      signatures,
    });

    async function* withCleanup() {
      try {
        yield* sse;
      } catch (err) {
        // ヘッダーはもう送っているので、エラーは SSE のイベントとして伝える
        if (!controller.signal.aborted) {
          const pe = err instanceof ProxyError ? err : new ProxyError(502, `ストリームの途中でエラーが起きました: ${(err as Error).message}`, "upstream_error");
          request.log.warn(pe.message);
          yield `data: ${JSON.stringify(pe.toBody())}\n\n`;
          yield "data: [DONE]\n\n";
        }
      } finally {
        release();
      }
    }

    reply
      .header("content-type", "text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("connection", "keep-alive");
    return reply.send(Readable.from(withCleanup(), { objectMode: false }));
  };

  app.post("/v1/chat/completions", chatHandler);
  app.post("/chat/completions", chatHandler);

  return app;
}

function captureReply(body: unknown, reply: FastifyReply) {
  const model = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : "capture";
  const stream = (body as { stream?: unknown })?.stream === true;
  const base = { id: "chatcmpl-capture", created: Math.floor(Date.now() / 1000), model };
  if (!stream) {
    return reply.send({
      ...base,
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: CAPTURE_REPLY }, finish_reason: "stop" }],
    });
  }
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  reply.header("content-type", "text/event-stream; charset=utf-8");
  return reply.send(chunk({ role: "assistant", content: CAPTURE_REPLY }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
}
