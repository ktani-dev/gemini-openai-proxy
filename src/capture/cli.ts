import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeRequests, formatReport } from "./analyze.js";

// 使い方：npm run analyze -- [保存先のフォルダ]（省略すると captures）
const dir = process.argv[2] ?? "captures";
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
if (files.length === 0) {
  console.error(`${dir} に保存したリクエストがありません。config.json の capture.enabled を true にして集めてください。`);
  process.exit(1);
}
const bodies = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown);
console.log(formatReport(analyzeRequests(bodies)));
