/** クライアントに OpenAI 形式のエラーとして返す例外 */
export class ProxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(message);
  }

  toBody() {
    return { error: { message: this.message, type: this.type, code: this.code, param: this.param } };
  }
}

const TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
};

/**
 * 上流（Gemini）の HTTP エラーを OpenAI 形式のエラーに変換する。
 * Gemini のエラーは { error: { code, message, status } } の形。
 */
export function fromUpstreamError(status: number, bodyText: string): ProxyError {
  let message = bodyText.slice(0, 2000) || `上流 API がステータス ${status} を返しました`;
  let code: string | null = null;
  try {
    const body = JSON.parse(bodyText) as { error?: { message?: string; status?: string } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.status) code = body.error.status;
  } catch {
    // JSON でなければ本文をそのまま使う
  }
  // 上流の 5xx は「プロキシの先で失敗した」ことが分かるように 502 にする
  const outStatus = status >= 500 ? 502 : status;
  const type = TYPE_BY_STATUS[status] ?? (status >= 500 ? "upstream_error" : "invalid_request_error");
  return new ProxyError(outStatus, `[upstream ${status}] ${message}`, type, code);
}
