// Raw deflate over the platform's CompressionStream (browsers and Node 18+): no dependency.
// Reading is capped, so a small input can't be made to expand into memory.

async function collect(
  stream: ReadableStream<Uint8Array>,
  max: number,
  tooBig: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(tooBig);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });

export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(
    streamOf(bytes).pipeThrough(new CompressionStream("deflate-raw")),
    Number.MAX_SAFE_INTEGER,
    "",
  );
}

/** Inflate, failing with `tooBig` as soon as the result passes `max` bytes. */
export function inflateRaw(bytes: Uint8Array, max: number, tooBig: string): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream("deflate-raw")), max, tooBig);
}
