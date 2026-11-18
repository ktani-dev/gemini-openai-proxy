import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 調査モード：上流には送らず、届いたリクエストをそのままファイルに保存する。
 * 保存するのはリクエストの本文だけ（ヘッダーは保存しないので、Authorization なども残らない）。
 */
let counter = 0;

export async function saveCapture(dir: string, body: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const file = join(dir, `${stamp}-${String(++counter).padStart(4, "0")}.json`);
  await writeFile(file, JSON.stringify(body, null, 2), "utf8");
  return file;
}

/** 調査モードのときにクライアントへ返す短い応答（クライアントを待たせないため） */
export const CAPTURE_REPLY = "[capture mode] リクエストを保存しました。上流には送っていません。";
