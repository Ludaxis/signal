// A keyed in-process async mutex shared across bundles through globalThis (same pattern as the autopilot locks()).
// Every store write that reads-then-writes (ledger, events, heads, index files) runs inside it. One Signal server
// process owns a content folder; a second process is not coordinated (documented limit).
type G = typeof globalThis & { __signalPostmakerMutex?: Map<string, Promise<unknown>> };
const chains = () => ((globalThis as G).__signalPostmakerMutex ??= new Map());

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const map = chains();
  const prev = map.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  map.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (map.get(key) === tail) map.delete(key);
  }
}
