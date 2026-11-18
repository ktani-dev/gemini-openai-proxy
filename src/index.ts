import { loadApiKey, loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig(process.env.PROXY_CONFIG ?? "config.json");
// 調査モードでは上流に送らないので、API キーが無くても起動できるようにする
const apiKey = config.capture.enabled ? "" : loadApiKey();

const app = buildServer({
  config,
  apiKey,
  logger: { level: process.env.LOG_LEVEL ?? "info", transport: undefined },
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`OpenAI 互換のエンドポイント: http://${config.host}:${config.port}/v1`);
  app.log.info(`使えるモデル: ${config.models.map((m) => `${m.id} → ${m.upstreamModel}`).join(", ")}`);
  if (config.capture.enabled) app.log.warn(`調査モードです。リクエストは ${config.capture.dir} に保存され、上流には送られません`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
