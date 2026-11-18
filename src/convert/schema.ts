import type { JsonObject } from "../types.js";

/**
 * ツール定義の JSON Schema を、Gemini の Schema（OpenAPI 3.0 のサブセット）に変換する。
 *
 * 方針：特定のツールごとに直すのではなく、
 *   1. 公式仕様を見比べて分かっている書き換えを再帰的に行い、
 *   2. 最後に Gemini が受け付けるキーだけを残す（ホワイトリスト）。
 * 落としたキーは warnings に記録し、呼び出し側でまとめてログに出す。
 */

/** Gemini の Schema が受け付けるキー（公式リファレンスの Schema オブジェクトより） */
export const ALLOWED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
]);

/** 型ごとに Gemini が受け付ける format */
const ALLOWED_FORMATS: Record<string, Set<string>> = {
  STRING: new Set(["enum", "date-time"]),
  NUMBER: new Set(["float", "double"]),
  INTEGER: new Set(["int32", "int64"]),
};

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

/** 展開する $ref の深さの上限（循環参照の対策） */
const MAX_REF_DEPTH = 8;

export interface SchemaWarning {
  path: string;
  message: string;
}

interface Ctx {
  defs: Record<string, unknown>;
  warnings: SchemaWarning[];
  refStack: string[];
}

export function convertSchema(schema: unknown, path = "#"): { schema: JsonObject; warnings: SchemaWarning[] } {
  const root = isObject(schema) ? schema : {};
  const ctx: Ctx = {
    defs: { ...asObject(root.definitions), ...asObject(root.$defs) },
    warnings: [],
    refStack: [],
  };
  return { schema: convertNode(root, path, ctx), warnings: ctx.warnings };
}

function convertNode(input: unknown, path: string, ctx: Ctx): JsonObject {
  if (!isObject(input)) {
    if (input !== true) ctx.warnings.push({ path, message: `スキーマがオブジェクトではないため空にしました: ${JSON.stringify(input)}` });
    return {};
  }

  let node: JsonObject = { ...input };

  // $ref：公開版の Gemini API には ref/defs が無いので、$defs の中身を展開して埋め込む。
  // 参照先の変換が終わるまで refStack に積んでおき、循環を見つけたら OBJECT で打ち切る。
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    const { $ref: _ref, ...rest } = node;
    const target = lookupRef(ref, ctx);
    if (!target) {
      ctx.warnings.push({ path, message: `解決できない $ref を落としました: ${ref}` });
      return convertNode(rest, path, ctx);
    }
    if (ctx.refStack.includes(ref) || ctx.refStack.length >= MAX_REF_DEPTH) {
      ctx.warnings.push({ path, message: `循環している $ref を OBJECT に置き換えました: ${ref}` });
      return typeof rest.description === "string" ? { type: "OBJECT", description: rest.description } : { type: "OBJECT" };
    }
    ctx.refStack.push(ref);
    try {
      // 参照元に書かれた description などで、参照先の中身を上書きする
      return convertNode({ ...target, ...rest }, path, ctx);
    } finally {
      ctx.refStack.pop();
    }
  }

  // allOf：中身を1つにまとめる
  if (Array.isArray(node.allOf)) {
    node = mergeAllOf(node, path, ctx);
  }

  // oneOf → anyOf
  if (Array.isArray(node.oneOf)) {
    node.anyOf = [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...node.oneOf];
    delete node.oneOf;
  }

  // const → enum（要素1つ）
  if ("const" in node) {
    if (typeof node.const === "string") {
      node.enum = [node.const];
      node.type ??= "string";
    } else {
      ctx.warnings.push({ path, message: `文字列以外の const は Gemini の enum にできないため落としました: ${JSON.stringify(node.const)}` });
    }
    delete node.const;
  }

  // examples → example（最初の1つ）
  if (Array.isArray(node.examples)) {
    if (node.example === undefined && node.examples.length > 0) node.example = node.examples[0];
    delete node.examples;
  }

  // type: ["string", "null"] → type: "string" ＋ nullable: true
  if (Array.isArray(node.type)) {
    const types = node.type.filter((t): t is string => typeof t === "string");
    const nonNull = types.filter((t) => t !== "null");
    if (types.includes("null")) node.nullable = true;
    if (nonNull.length === 1) {
      node.type = nonNull[0];
    } else if (nonNull.length > 1) {
      // 複数の型 → anyOf に分ける
      delete node.type;
      node.anyOf = [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...nonNull.map((t) => ({ type: t }))];
    } else {
      delete node.type;
    }
  }
  if (node.type === "null") {
    delete node.type;
    node.nullable = true;
  }

  // anyOf の中の {type: "null"} は nullable にまとめる
  if (Array.isArray(node.anyOf)) {
    const withoutNull = node.anyOf.filter((s) => !(isObject(s) && s.type === "null" && Object.keys(s).length === 1));
    if (withoutNull.length !== node.anyOf.length) node.nullable = true;
    if (withoutNull.length === 1 && isObject(withoutNull[0])) {
      // 選択肢が1つだけなら anyOf をやめて中身を持ち上げる
      const only = withoutNull[0];
      delete node.anyOf;
      node = { ...only, ...stripUndefined(node) };
      return convertNode(node, path, ctx);
    }
    node.anyOf = withoutNull;
  }

  // ---- ここから子要素の変換と、ホワイトリストによる絞り込み ----
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" || key === "definitions") continue; // 展開済み
    if (!ALLOWED_KEYS.has(key)) {
      ctx.warnings.push({ path, message: `未対応のキーを落としました: ${key}` });
      continue;
    }
    switch (key) {
      case "type": {
        if (typeof value === "string" && JSON_TYPES.has(value)) out.type = value.toUpperCase();
        else ctx.warnings.push({ path, message: `不明な type を落としました: ${JSON.stringify(value)}` });
        break;
      }
      case "properties": {
        if (!isObject(value)) break;
        const props: JsonObject = {};
        for (const [name, child] of Object.entries(value)) {
          props[name] = convertNode(child, `${path}/properties/${name}`, ctx);
        }
        out.properties = props;
        break;
      }
      case "items": {
        if (Array.isArray(value)) {
          // タプル形式は Gemini に無いので、最初の要素の型で代表させる
          ctx.warnings.push({ path, message: "items の配列（タプル形式）は最初の要素だけ残しました" });
          out.items = convertNode(value[0] ?? {}, `${path}/items`, ctx);
        } else {
          out.items = convertNode(value, `${path}/items`, ctx);
        }
        break;
      }
      case "anyOf": {
        out.anyOf = (value as unknown[]).map((s, i) => convertNode(s, `${path}/anyOf/${i}`, ctx));
        break;
      }
      case "enum": {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          out.enum = value;
        } else {
          ctx.warnings.push({ path, message: `文字列以外を含む enum は Gemini で使えないため落としました: ${JSON.stringify(value)}` });
        }
        break;
      }
      default:
        out[key] = value;
    }
  }

  // format は型ごとに許可されたものだけ残す
  if (out.format !== undefined) {
    const allowed = ALLOWED_FORMATS[String(out.type)];
    if (!allowed?.has(String(out.format))) {
      ctx.warnings.push({ path, message: `この型では使えない format を落としました: ${JSON.stringify(out.format)}` });
      delete out.format;
    }
  }

  // enum があれば型は STRING にそろえる（Gemini の enum は文字列のみ）
  if (out.enum && out.type === undefined) out.type = "STRING";

  // required は実在するプロパティだけ残す
  if (out.required !== undefined) {
    const props = isObject(out.properties) ? out.properties : {};
    const req = Array.isArray(out.required) ? out.required.filter((r): r is string => typeof r === "string" && r in props) : [];
    if (req.length > 0) out.required = req;
    else delete out.required;
  }

  // properties があるのに type が無いときは OBJECT とみなす
  if (out.properties && out.type === undefined) out.type = "OBJECT";

  return out;
}

function lookupRef(ref: string, ctx: Ctx): JsonObject | undefined {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  const target = match ? ctx.defs[decodeURIComponent(match[1]!)] : undefined;
  return isObject(target) ? target : undefined;
}

function mergeAllOf(node: JsonObject, path: string, ctx: Ctx): JsonObject {
  const { allOf, ...base } = node;
  const merged: JsonObject = { ...base };
  const properties: JsonObject = { ...asObject(base.properties) };
  const required = new Set<string>(Array.isArray(base.required) ? (base.required as string[]) : []);

  for (const [i, part] of (allOf as unknown[]).entries()) {
    let sub = isObject(part) ? part : {};
    // allOf の中の $ref は、まとめる前に参照先の中身を取り出す（循環は1段で打ち切る）
    if (typeof sub.$ref === "string") {
      const { $ref, ...rest } = sub;
      const target = ctx.refStack.includes($ref as string) ? undefined : lookupRef($ref as string, ctx);
      if (!target) ctx.warnings.push({ path: `${path}/allOf/${i}`, message: `allOf の中の $ref を展開できませんでした: ${String($ref)}` });
      sub = { ...(target ?? {}), ...rest };
    }
    if (Array.isArray(sub.allOf)) sub = mergeAllOf(sub, `${path}/allOf/${i}`, ctx);
    for (const [key, value] of Object.entries(sub)) {
      if (key === "properties") Object.assign(properties, asObject(value));
      else if (key === "required" && Array.isArray(value)) value.forEach((r) => required.add(String(r)));
      else if (merged[key] === undefined) merged[key] = value; // 先に書かれた方を優先
    }
  }
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): JsonObject {
  return isObject(v) ? v : {};
}

function stripUndefined(o: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
