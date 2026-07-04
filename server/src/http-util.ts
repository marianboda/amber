// Read a web ReadableStream up to `limit` bytes. Returns the collected bytes,
// or null once the limit is exceeded (stream is cancelled) — so callers never
// buffer an unbounded body into memory before rejecting it.
export async function readStreamLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<Buffer | null> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

export async function readTextLimited(
  stream: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<string | null> {
  const bytes = await readStreamLimited(stream, limit);
  return bytes === null ? null : bytes.toString("utf8");
}
