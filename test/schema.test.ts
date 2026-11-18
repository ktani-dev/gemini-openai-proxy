import { describe, expect, it } from "vitest";
import { convertSchema } from "../src/convert/schema.js";

const conv = (s: unknown) => convertSchema(s);

describe("スキーマ変換：公式仕様を見比べて決めた書き換え", () => {
  it("$schema を消す", () => {
    const { schema } = conv({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } });
    expect(schema).toEqual({ type: "OBJECT", properties: { a: { type: "STRING" } } });
  });

  it("const を要素1つの enum にする", () => {
    expect(conv({ const: "read" }).schema).toEqual({ type: "STRING", enum: ["read"] });
  });

  it("oneOf を anyOf にする", () => {
    const { schema } = conv({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(schema).toEqual({ anyOf: [{ type: "STRING" }, { type: "NUMBER" }] });
  });

  it("$ref を $defs の中身で展開する（公開版の Gemini API には ref/defs が無いため）", () => {
    const { schema } = conv({
      type: "object",
      properties: { pos: { $ref: "#/$defs/Position", description: "カーソル位置" } },
      $defs: { Position: { type: "object", properties: { line: { type: "integer" } }, required: ["line"] } },
    });
    expect(schema).toEqual({
      type: "OBJECT",
      properties: {
        pos: { type: "OBJECT", description: "カーソル位置", properties: { line: { type: "INTEGER" } }, required: ["line"] },
      },
    });
  });

  it("definitions（古い書き方）の $ref も展開する", () => {
    const { schema } = conv({ properties: { a: { $ref: "#/definitions/A" } }, definitions: { A: { type: "boolean" } } });
    expect(schema).toEqual({ type: "OBJECT", properties: { a: { type: "BOOLEAN" } } });
  });

  it("循環する $ref は OBJECT で打ち切り、止まらなくならない", () => {
    const { schema, warnings } = conv({
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" } } } },
    });
    expect(schema).toEqual({ type: "OBJECT", properties: { child: { type: "OBJECT" } } });
    expect(warnings.some((w) => w.message.includes("循環"))).toBe(true);
  });

  it("null を含む型の配列を nullable にする", () => {
    expect(conv({ type: ["string", "null"] }).schema).toEqual({ type: "STRING", nullable: true });
  });

  it("null 以外の型が複数あるときは anyOf に分ける", () => {
    expect(conv({ type: ["string", "integer", "null"] }).schema).toEqual({
      nullable: true,
      anyOf: [{ type: "STRING" }, { type: "INTEGER" }],
    });
  });

  it("anyOf の中の {type: null} も nullable にまとめる", () => {
    expect(conv({ anyOf: [{ type: "string" }, { type: "null" }] }).schema).toEqual({ type: "STRING", nullable: true });
  });

  it("examples を example にする（最初の1つ）", () => {
    expect(conv({ type: "string", examples: ["a", "b"] }).schema).toEqual({ type: "STRING", example: "a" });
  });

  it("allOf を1つにまとめる（properties と required は合わせる）", () => {
    const { schema } = conv({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(schema).toEqual({
      type: "OBJECT",
      properties: { a: { type: "STRING" }, b: { type: "NUMBER" } },
      required: ["a", "b"],
    });
  });
});

describe("スキーマ変換：ホワイトリストと後始末", () => {
  it("Gemini が受け付けないキーは落とし、警告に残す", () => {
    const { schema, warnings } = conv({
      type: "object",
      additionalProperties: false,
      properties: { n: { type: "number", exclusiveMinimum: 0, multipleOf: 2 } },
    });
    expect(schema).toEqual({ type: "OBJECT", properties: { n: { type: "NUMBER" } } });
    expect(warnings.map((w) => w.message)).toEqual([
      "未対応のキーを落としました: additionalProperties",
      "未対応のキーを落としました: exclusiveMinimum",
      "未対応のキーを落としました: multipleOf",
    ]);
  });

  it("深くネストしたところまで再帰的に変換する", () => {
    const { schema } = conv({
      type: "object",
      properties: {
        list: { type: "array", items: { type: "object", properties: { tag: { const: "x", $comment: "c" } } } },
      },
    });
    expect(schema).toEqual({
      type: "OBJECT",
      properties: { list: { type: "ARRAY", items: { type: "OBJECT", properties: { tag: { type: "STRING", enum: ["x"] } } } } },
    });
  });

  it("その型で使えない format は落とす", () => {
    expect(conv({ type: "string", format: "uri" }).schema).toEqual({ type: "STRING" });
    expect(conv({ type: "string", format: "date-time" }).schema).toEqual({ type: "STRING", format: "date-time" });
  });

  it("文字列以外の enum は落とす（Gemini の enum は文字列のみ）", () => {
    const { schema, warnings } = conv({ type: "integer", enum: [1, 2] });
    expect(schema).toEqual({ type: "INTEGER" });
    expect(warnings).toHaveLength(1);
  });

  it("required から、存在しないプロパティを取り除く", () => {
    expect(conv({ type: "object", properties: { a: { type: "string" } }, required: ["a", "ghost"] }).schema).toEqual({
      type: "OBJECT",
      properties: { a: { type: "STRING" } },
      required: ["a"],
    });
  });

  it("description・default・title などの許可されたキーはそのまま残す", () => {
    const input = { type: "string", description: "d", default: "x", title: "t", minLength: 1, pattern: "^a" };
    expect(conv(input).schema).toEqual({ ...input, type: "STRING" });
  });

  it("元のスキーマを書き換えない", () => {
    const input = { type: ["string", "null"], examples: ["a"] };
    const copy = structuredClone(input);
    conv(input);
    expect(input).toEqual(copy);
  });
});
