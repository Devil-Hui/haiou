import { NextResponse } from "next/server";
import { traceId } from "./api-error";

export const NO_STORE = { "Cache-Control": "no-store" };

export const json = (data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  NextResponse.json(data, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });

export const ok = (data: unknown, status = 200) => json(data, { status });
/**
 * 统一错误出口。
 *
 * 现在同时带上 code（机器可读）与 traceId（与日志对齐），
 * 而 error 字段保持原样——现有前端读 error 的代码一行都不用改。
 * 新增 code 只是**附加**信息，因此这是向后兼容的改造。
 *
 * code 可省略（此时不返回该字段），用于过渡期；新代码应一律传。
 */
export const fail = (error: string, status: number, code?: string) => {
  // 响应体与响应头必须用同一个 id：traceId() 在没有请求上下文时每次都会新生成，
  // 调用两次会得到两个不同的值，客户端与日志就再也对不上了。
  const id = traceId();
  return json({ error, ...(code ? { code } : {}), traceId: id }, { status, headers: { "X-Trace-Id": id } });
};

// Reads the body while counting bytes, so an oversized payload is never fully materialised.
// `content-length` is only a hint (a chunked request omits it), and `request.text()` would
// buffer the whole thing before any size check could run. Space is therefore O(limit) rather
// than O(body size). If the stream is unavailable it falls back to the plain reader, which
// keeps the worst case at the previous behaviour instead of something worse.
async function readBounded(request: Request, limit: number): Promise<string | null> {
  const stream = request.body;
  if (!stream || typeof stream.getReader !== "function") {
    const text = await request.text();
    return text.length > limit ? null : text;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// Returns null for anything oversized, non-object or unparsable, letting callers answer 400
// without ever parsing attacker-sized payloads.
export async function readJson(request: Request, limit = 4096): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") || 0) > limit) return null;
  const text = await readBounded(request, limit);
  if (text === null) return null;
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch { return null; }
}
