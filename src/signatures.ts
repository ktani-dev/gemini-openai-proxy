/**
 * Gemini 3 系の thoughtSignature を覚えておく入れ物。
 *
 * Gemini 3 系は、ツール呼び出し（functionCall）に thoughtSignature を付けて返し、
 * 次のリクエストでそれを付けたまま送り返さないと 400 エラーになる。
 * OpenAI 形式には署名を入れる場所がないため、Copilot は署名を送り返してくれない。
 * そこで、プロキシが tool_call の id と署名を結びつけて覚えておき、送り返すときに付け直す。
 */
export class SignatureStore {
  private readonly map = new Map<string, string>();

  constructor(private readonly maxEntries = 5000) {}

  set(toolCallId: string, signature: string): void {
    this.map.delete(toolCallId);
    this.map.set(toolCallId, signature);
    // 古いものから捨てる（Map は入れた順に並ぶ）
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(toolCallId: string): string | undefined {
    return this.map.get(toolCallId);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * 署名が見つからないときに使う値。Gemini の公式ドキュメントにある回避用の値で、
 * 検証は通るが回答の質が下がることがある（プロキシを再起動した直後など、最後の手段）。
 */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";
