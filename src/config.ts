import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const ConfigSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  upstream: z.object({
    baseUrl: z.url(),
    headersTimeoutMs: z.number().int().positive().default(300_000),
    streamIdleTimeoutMs: z.number().int().positive().default(120_000),
    maxConcurrency: z.number().int().positive().default(4),
    retry: z
      .object({
        maxRetries: z.number().int().min(0).default(3),
        baseDelayMs: z.number().int().min(0).default(1000),
        maxDelayMs: z.number().int().min(0).default(15_000),
      })
      .prefault({}),
  }),
  models: z
    .array(z.object({ id: z.string().min(1), upstreamModel: z.string().regex(/^[\w.-]+$/) }))
    .min(1),
  capture: z
    .object({ enabled: z.boolean().default(false), dir: z.string().default("captures") })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`config.json の内容が正しくありません:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(path = "config.json"): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * API キーを環境変数から読む。.env があれば先に読み込む。
 * GEMINI_API_KEY を優先し、なければ gemini-api-key も見る。
 */
export function loadApiKey(envFile = ".env"): string {
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.GEMINI_API_KEY ?? process.env["gemini-api-key"];
  if (!key) {
    throw new Error("API キーがありません。環境変数 GEMINI_API_KEY を設定するか、.env に書いてください。");
  }
  return key;
}
