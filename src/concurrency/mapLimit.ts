/**
 * Map over items with at most `limit` tasks in flight, results in input order.
 *
 * For fanning out independent I/O. A plain `for … await` loop keeps exactly one read in
 * flight, so a batch of N independent object reads costs N round-trips of latency while the
 * CPU idles; `Promise.all` over all N removes the latency but lets an unbounded number of
 * file descriptors open at once, which on a large history is how a reader runs out of them.
 * This bounds the fan-out and keeps it saturated: a worker takes the next index as soon as
 * its previous item settles, so a single slow item cannot stall the rest of the batch.
 *
 * Order is by index, not completion, because callers rely on it (the op-log's first-write
 * order, for one). Rejections propagate like `Promise.all`: the first rejection is thrown,
 * and in-flight work is left to settle on its own.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
