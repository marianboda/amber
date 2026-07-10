import fs from "node:fs";
import path from "node:path";

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

// Stream a request body straight to disk under a byte cap — for uploads (backup
// zips) far too large to buffer. Returns bytes written, or null once the limit
// is exceeded (partial file removed).
export async function streamToFileLimited(
  stream: ReadableStream<Uint8Array> | null,
  file: string,
  limit: number
): Promise<number | null> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!stream) {
    fs.writeFileSync(file, "");
    return 0;
  }
  const out = fs.createWriteStream(file);
  const reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        out.destroy();
        fs.rmSync(file, { force: true });
        return null;
      }
      if (!out.write(value)) {
        await new Promise((resolve, reject) => {
          out.once("drain", resolve);
          out.once("error", reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve());
      out.once("error", reject);
    });
    return total;
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  } finally {
    reader.releaseLock?.();
  }
}
