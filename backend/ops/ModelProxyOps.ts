/**
 * The model proxy's pure helpers: reading the usage an Anthropic answer
 * reports while handing it back unchanged.
 */

/**
 * Pass a response body through, reading the token usage it reports: the
 * `usage` of a JSON body, or `message_start` / `message_delta` of a stream.
 * Counts are the largest seen, never summed, since a stream repeats them.
 * @param body - The upstream body.
 * @param onDone - Called once with the usage when the body ends.
 * @returns The body to hand back.
 */
export function teeUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (usage: { inputTokens: number; outputTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  const read = (json: unknown) => {
    const u =
      (json as { usage?: Record<string, number> })?.usage ??
      (json as { message?: { usage?: Record<string, number> } })?.message
        ?.usage;
    if (!u) return;
    const input =
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
    inputTokens = Math.max(inputTokens, input);
    outputTokens = Math.max(outputTokens, u.output_tokens ?? 0);
  };
  const lines = (final: boolean) => {
    const parts = buffer.split("\n");
    buffer = final ? "" : (parts.pop() ?? "");
    for (const line of parts) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : null;
      if (!data) continue;
      try {
        read(JSON.parse(data));
      } catch {
        // Not every line of a stream is JSON.
      }
    }
  };
  let whole = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        const text = decoder.decode(chunk, { stream: true });
        buffer += text;
        if (whole.length < 4 * 1024 * 1024) whole += text;
        lines(false);
      },
      flush() {
        lines(true);
        if (inputTokens === 0 && outputTokens === 0) {
          try {
            read(JSON.parse(whole));
          } catch {
            // A body that is neither a stream nor JSON reports nothing.
          }
        }
        onDone({ inputTokens, outputTokens });
      },
    }),
  );
}
