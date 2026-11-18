import { ALLOWED_KEYS } from "../convert/schema.js";

/**
 * 保存したリクエストから、ツール定義の JSON Schema で使われているキーワードを数える。
 * プロパティ名（properties の中のキー）はキーワードではないので数えない。
 */
export interface KeywordStat {
  keyword: string;
  count: number;
  /** そのキーワードを使っているツール名（重複なし） */
  tools: string[];
  /** Gemini のホワイトリストにそのまま入っているか */
  allowed: boolean;
}

export interface AnalyzeResult {
  requests: number;
  tools: number;
  keywords: KeywordStat[];
}

/** 中身が「名前 → スキーマ」の対応表になっているキーワード */
const MAP_KEYWORDS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
/** 中身がスキーマの配列になっているキーワード */
const ARRAY_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems", "items"]);
/** 中身がスキーマ1つのキーワード */
const SCHEMA_KEYWORDS = new Set(["items", "not", "additionalProperties", "contains", "if", "then", "else", "propertyNames"]);

export function analyzeRequests(bodies: unknown[]): AnalyzeResult {
  const stats = new Map<string, { count: number; tools: Set<string> }>();
  const toolNames = new Set<string>();

  const visit = (node: unknown, tool: string) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const s = stats.get(key) ?? { count: 0, tools: new Set<string>() };
      s.count++;
      s.tools.add(tool);
      stats.set(key, s);

      if (MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null) {
        for (const child of Object.values(value)) visit(child, tool);
      } else if (ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
        for (const child of value) visit(child, tool);
      } else if (SCHEMA_KEYWORDS.has(key)) {
        visit(value, tool);
      }
    }
  };

  for (const body of bodies) {
    const tools = (body as { tools?: { function?: { name?: string; parameters?: unknown } }[] })?.tools ?? [];
    for (const t of tools) {
      const name = t.function?.name ?? "(no name)";
      toolNames.add(name);
      visit(t.function?.parameters, name);
    }
  }

  const keywords = [...stats.entries()]
    .map(([keyword, s]) => ({ keyword, count: s.count, tools: [...s.tools].sort(), allowed: ALLOWED_KEYS.has(keyword) }))
    .sort((a, b) => Number(a.allowed) - Number(b.allowed) || b.count - a.count);

  return { requests: bodies.length, tools: toolNames.size, keywords };
}

export function formatReport(result: AnalyzeResult): string {
  const lines = [
    `リクエスト ${result.requests} 件、ツール ${result.tools} 種類`,
    "",
    "| キーワード | 回数 | ツール数 | Gemini でそのまま使える | 例 |",
    "|---|---:|---:|---|---|",
  ];
  for (const k of result.keywords) {
    const example = k.tools.slice(0, 3).join(", ") + (k.tools.length > 3 ? " ほか" : "");
    lines.push(`| \`${k.keyword}\` | ${k.count} | ${k.tools.length} | ${k.allowed ? "はい" : "**いいえ**"} | ${example} |`);
  }
  return lines.join("\n");
}
