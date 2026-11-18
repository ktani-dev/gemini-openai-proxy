# gemini-openai-proxy

OpenAI Chat Completions形式のリクエストを、Gemini API（generateContent）に変換して中継するローカルプロキシです。
GitHub CopilotのようにOpenAI互換のエンドポイントしか受け付けないツールから、Geminiのモデルをエージェントとして使えるようにします。

- ツール呼び出し（function calling）の往復に対応。Copilotのエージェントモードで使えます
- ストリーミング（SSE）に対応
- Copilotが送ってくる100を超えるツール定義のJSON Schemaを、Geminiが受け付ける形に変換します
- 自分のPC（127.0.0.1）だけで動きます。外部の変換サービスは使いません

```
GitHub Copilot ──(OpenAI形式)──▶ このプロキシ（127.0.0.1:8787） ──(Gemini形式)──▶ Gemini API
               ◀─(OpenAI形式)──                                ◀─(Gemini形式)──
```

## 背景

GitHub Copilotのカスタムエンドポイントは、OpenAI Chat Completions形式が前提です。GeminiのAPIはgenerateContent形式なので、そのままでは使えません。

既製の変換ツール（LiteLLMなど）もありますが、やりたいことは形式の変換とSSEの中継だけです。そのために依存を増やすより、中身を把握できる小さなプロキシを手元で動かす方が安全だと考えて、自作しました。実行時の依存はFastifyとZodの2つだけです。

## 設計で考えたこと

### 1. ツール定義のスキーマは「境界でまとめて」変換する

Copilotはリクエストのたびに、100個を超えるツール定義を送ってきます。その中に、Geminiが受け付けないJSON Schemaの書き方が混ざっていて、上流のAPIでエラーになりました。

最初、実装を担当したAIは「実APIに流す → エラーになったキーワードを1つ直す → また流す」を繰り返そうとしました。しかし、このやり方には問題があります。

- APIを何度も無駄に呼ぶ
- エラーは1回に1つしか分からないので、終わりが見えない
- 新しいツールが増えるたびに、また壊れる

そこで止めて、方針を変えました。

1. **入り口で捕まえて分析する**：上流には送らず、届いたリクエストを保存して、ツール群で実際に使われているキーワードを数えました（下の「調査モード」）
2. **公式仕様と見比べる**：OpenAI側（JSON Schema）とGemini側（OpenAPI 3.0のサブセット）の仕様を見比べて、書き換えのルールを決めました
3. **ホワイトリストで絞る**：見比べても決めきれないものは、Geminiが受け付けるキーだけを残し、それ以外は落とす方式にしました。落としたキーはログに出します

特定のツールに合わせたパッチではなく、スキーマ全体を再帰的に変換する処理を境界に1つ置いたので、ツールが増えても同じ処理で対応できます。

| 元の書き方 | 変換後 |
|---|---|
| `$schema` | 消す |
| `const: "a"` | `enum: ["a"]` |
| `oneOf` | `anyOf` |
| `$ref`・`$defs`・`definitions` | 参照先の中身を展開して埋め込む（循環していたら打ち切る） |
| `type: ["string", "null"]` | `type: "STRING"`＋`nullable: true` |
| `examples: [...]` | `example`（最初の1つ） |
| `allOf: [...]` | 1つにまとめる（`properties`と`required`は合わせる） |
| `additionalProperties`・`exclusiveMinimum`など | ホワイトリストに無いので落とす |
| `format: "uri"`など | その型で使えないformatは落とす |

実装は[src/convert/schema.ts](src/convert/schema.ts)です。

> 補足：公開版のGemini APIのSchemaには`ref`・`defs`がありません。そのため`$ref`は、名前を書き換えるのではなく、参照先の中身を展開して埋め込んでいます。

### 2. Gemini 3の`thoughtSignature`をプロキシが覚えておく

Gemini 3系は、ツール呼び出しに`thoughtSignature`（思考の署名）を付けて返します。次のリクエストでこれを付けて送り返さないと、400エラーになります。

ところがOpenAI形式には署名を入れる場所が無いので、Copilotは署名を送り返してくれません。そこでプロキシが、`tool_call`のidと署名を結びつけて覚えておき、送り返すときに付け直します（[src/signatures.ts](src/signatures.ts)）。
プロキシを再起動した直後など、署名が見つからないときは、Geminiの公式ドキュメントにある回避用の値を使います。

### 3. OpenAIとGeminiの違いを吸収する

| | OpenAI | Gemini | このプロキシでの扱い |
|---|---|---|---|
| システムプロンプト | `role: system`／`developer` | `systemInstruction` | まとめて`systemInstruction`にする |
| アシスタント | `role: assistant` | `role: model` | 名前を変える |
| ツール定義 | `tools[].function` | `functionDeclarations` | スキーマも変換する |
| ツール呼び出し | `tool_calls`（idあり） | `functionCall` | idが無ければ作る |
| ツールの結果 | `role: tool`＋`tool_call_id` | `functionResponse`（関数名が必要） | 前の`tool_calls`から関数名を引く |
| ストリームの終わり | `data: [DONE]` | なし | プロキシが足す |

SSEは、バイト列を受け取りながら変換します。UTF-8の1文字（日本語は3バイト）がチャンクの境目で分かれても、文字化けしないようにしています（[src/convert/stream.ts](src/convert/stream.ts)）。

### 4. 安全と無駄づかいの防止

- APIキーは環境変数で渡します。リポジトリには入れません
- `127.0.0.1`でだけ待ち受け、それ以外からの接続は403で断ります
- 上流のURLは設定ファイルだけで決まります。リクエストの中身で接続先を変えることはできません
- 対応していないパラメータは、黙って捨てずに400で返します
- Copilotが切断したら（チャットを止めたときなど）、上流へのリクエストとSSEの送信も止めます。使われない回答のためにAPIを使い続けないようにするためです
- 同時に上流へ送る数に上限を設けています
- 429・502・503・504は、間を空けて再試行します（`Retry-After`があれば従います）
- 上流のエラーは、OpenAI形式のエラーにして返します

## 使い方

### 必要なもの

- Node.js 22以上
- Gemini APIのキー（[Google AI Studio](https://aistudio.google.com/)で発行できます）

### セットアップ

```bash
npm install
npm run build
```

APIキーは、環境変数`GEMINI_API_KEY`に設定するか、`.env.example`を`.env`にコピーして書きます。

### 起動

```bash
npm start
```

Windowsでは`start.cmd`をダブルクリックしても起動できます。
起動すると、`http://127.0.0.1:8787/v1`がOpenAI互換のエンドポイントになります。

### GitHub Copilotから使う

VS CodeのCopilot Chatで、モデルの管理画面からOpenAI互換のエンドポイントを追加し、次のように設定します。

- URL：`http://127.0.0.1:8787/v1`
- モデル：`config.json`の`models[].id`（例：`gemini-3.8-flash`）
- APIキー：プロキシは使わないので、任意の文字列で構いません

### 設定（config.json）

| 項目 | 内容 |
|---|---|
| `models` | Copilotから見えるモデル名（`id`）と、実際に呼ぶGeminiのモデル名（`upstreamModel`）。モデルが新しくなっても、ここを書き換えるだけで対応できます |
| `upstream.headersTimeoutMs` | 上流が応答し始めるまで待つ時間 |
| `upstream.streamIdleTimeoutMs` | ストリームの途中で、データが来ないまま待つ時間 |
| `upstream.maxConcurrency` | 同時に上流へ送る数の上限 |
| `upstream.retry` | 再試行の回数と待ち時間 |
| `capture` | 調査モード（下記） |

### 調査モード

`config.json`の`capture.enabled`を`true`にすると、上流には送らずに、届いたリクエストを`captures/`に保存します（ヘッダーは保存しないので、APIキーなどは残りません）。
Copilotから何回か話しかけたあと、次のコマンドで、ツール定義のスキーマで使われているキーワードを数えられます。

```bash
npm run analyze -- captures
```

Geminiでそのまま使えないキーワードが先に並ぶので、変換ルールを足すときの材料になります。

## テスト

```bash
npm test
```

単体テストと結合テストで62件あります。

- **単体テスト**：変換の処理をHTTPから切り離してテストしています（スキーマの各パターン、メッセージの順番、生成パラメータ、ツール呼び出しの往復、SSEの変換、UTF-8の分割など）
- **結合テスト**：Gemini APIをまねたモックのサーバーを立てて、プロキシを通しで確かめています（再試行、タイムアウト、エラーの変換、同時実行数の上限、切断したときの中止、localhostの制限、調査モードなど）

実際のGemini APIでの確認は、プロキシを起動してから次のスクリプトで行えます。

```bash
node scripts/live-check.mjs
```

## 担当の分け方

このプロキシは、AIと分担して作りました。

- **自分**：企画、OpenAI・Geminiの公式仕様の調査と比較、要件の定義、テストの設計と確認、問題が起きたときの方針の判断（上の「スキーマは境界でまとめて変換する」など）
- **AI**：実装

## 制限

- `n`は1だけ対応しています
- 画像はdata URL（base64）だけ対応しています。外部のURLは取りに行きません
- 署名はメモリに置いているので、プロキシを再起動すると消えます（その場合は回避用の値で続けます）

## ライセンス

MIT
