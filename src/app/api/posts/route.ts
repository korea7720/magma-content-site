import { NextRequest, NextResponse } from "next/server";
import { PublishError, publishPost, verifyApiKey } from "@/lib/publish";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: NextRequest) {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0)
      return NextResponse.json({ error: "Content-Length 값이 올바르지 않습니다" }, { status: 400 });
    if (length > MAX_BODY_BYTES)
      return NextResponse.json({ error: "요청 본문은 256 KiB 이하여야 합니다" }, { status: 413 });
  }

  if (!verifyApiKey(req.headers.get("authorization"))) {
    return NextResponse.json(
      { error: "인증 실패 — 'Authorization: Bearer {PUBLISH_API_KEY}' 헤더를 확인하세요" },
      { status: 401 },
    );
  }
  let body: unknown;
  try {
    body = await readLimitedJson(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError)
      return NextResponse.json({ error: "요청 본문은 256 KiB 이하여야 합니다" }, { status: 413 });
    return NextResponse.json({ error: "본문이 JSON 이 아닙니다" }, { status: 422 });
  }
  try {
    const result = await publishPost(body);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PublishError) return NextResponse.json(err.body, { status: err.status });
    console.error("[publish] 예기치 못한 오류:", err);
    return NextResponse.json({ error: "서버 오류" }, { status: 500 });
  }
}

class PayloadTooLargeError extends Error {}

async function readLimitedJson(req: Request, limit: number): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError("missing JSON body");

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
