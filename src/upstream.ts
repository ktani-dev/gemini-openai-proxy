import type { Config } from "./config.js";
import { fromUpstreamError, ProxyError } from "./errors.js";
import type { GeminiRequest } from "./types.js";

/** 再試行する上流のステータス */
export const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** 同時に上流へ送る数を制限する */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const i = this.waiting.indexOf(go);
          if (i !== -1) this.waiting.splice(i, 1);
          reject(signal?.reason ?? new Error("aborted"));
        };
        const go = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiting.push(go);
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }

  get inUse(): number {
    return this.active;
  }
}

export interface UpstreamDeps {
  config: Config;
  apiKey: string;
  fetch: typeof fetch;
  semaphore: Semaphore;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

export interface UpstreamCall {
  upstreamModel: string;
  body: GeminiRequest;
  stream: boolean;
  /** クライアントが切断したら abort される */
  signal: AbortSignal;
}

/**
 * Gemini にリクエストを送る。
 * - URL は設定ファイルの baseUrl と、設定にあるモデル名からだけ作る（リクエストから上流は変えられない）
 * - 429・502・503・504 とネットワークエラーは、間を空けて再試行する（レスポンスを流し始める前だけ）
 * - 返り値の release() を呼ぶまで、同時実行の枠を1つ使う
 */
export async function callUpstream(deps: UpstreamDeps, call: UpstreamCall): Promise<{ response: Response; release: () => void }> {
  const { config } = deps;
  const action = call.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${config.upstream.baseUrl}/models/${encodeURIComponent(call.upstreamModel)}:${action}`;
  const sleep = deps.sleep ?? defaultSleep;
  const { maxRetries, baseDelayMs, maxDelayMs } = config.upstream.retry;

  const release = await deps.semaphore.acquire(call.signal);
  try {
    for (let attempt = 0; ; attempt++) {
      // ヘッダーが返ってくるまでのタイムアウト。クライアントの切断でも止まる
      const timeout = AbortSignal.timeout(config.upstream.headersTimeoutMs);
      const signal = AbortSignal.any([call.signal, timeout]);
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": deps.apiKey },
          body: JSON.stringify(call.body),
          signal,
        });
      } catch (err) {
        if (call.signal.aborted) throw err; // クライアントが切断した：再試行しない
        if (timeout.aborted) {
          throw new ProxyError(504, `上流 API が ${config.upstream.headersTimeoutMs}ms 以内に応答しませんでした`, "upstream_error", "timeout");
        }
        if (attempt >= maxRetries) {
          throw new ProxyError(502, `上流 API に接続できませんでした: ${(err as Error).message}`, "upstream_error", "connection_error");
        }
        const wait = backoff(attempt, baseDelayMs, maxDelayMs);
        deps.log?.(`上流への接続に失敗したため ${wait}ms 後に再試行します（${attempt + 1}/${maxRetries}）`);
        await sleep(wait, call.signal);
        continue;
      }

      if (response.ok) return { response, release };

      const text = await response.text().catch(() => "");
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
        throw fromUpstreamError(response.status, text);
      }
      const wait = retryAfterMs(response.headers.get("retry-after"), maxDelayMs) ?? backoff(attempt, baseDelayMs, maxDelayMs);
      deps.log?.(`上流が ${response.status} を返したため ${wait}ms 後に再試行します（${attempt + 1}/${maxRetries}）`);
      await sleep(wait, call.signal);
    }
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * レスポンスの本文を読みながら、一定時間データが来なければ止める。
 * クライアントの切断（signal）でも読み込みを止め、上流との接続を閉じる。
 */
export async function* readWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      if (signal.aborted) return;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProxyError(504, `上流から ${idleMs}ms データが届きませんでした`, "upstream_error", "timeout")), idleMs);
        }),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          onAbort = () => resolve({ done: true, value: undefined });
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
      });
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // 途中で止めたときも上流の接続を閉じる
    await reader.cancel().catch(() => {});
  }
}

function backoff(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** attempt);
}

function retryAfterMs(header: string | null, max: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(max, seconds * 1000);
  return undefined;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
