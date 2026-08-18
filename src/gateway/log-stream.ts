import { logger } from "../shared/logger";

type Subscriber = {
  write: (chunk: string) => void;
  dropped: number;
};

const subscribers = new Map<string, Set<Subscriber>>();

const MAX_BUFFERED_BYTES = 1_000_000;

export function subscribe(jobId: string, sub: Subscriber): () => void {
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId)!.add(sub);
  logger.debug({ jobId }, "log subscriber attached");

  return () => {
    const set = subscribers.get(jobId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) subscribers.delete(jobId);
    logger.debug({ jobId }, "log subscriber detached");
  };
}

export function publish(jobId: string, content: string): void {
  const set = subscribers.get(jobId);
  if (!set || set.size === 0) return;

  for (const sub of set) {
    try {
      sub.write(content);
    } catch (err: any) {
      logger.warn({ jobId, err: err.message }, "dropping failed log subscriber");
      set.delete(sub);
    }
  }
}

export function publishEnd(jobId: string, status: string): void {
  const set = subscribers.get(jobId);
  if (!set) return;
  for (const sub of set) {
    try {
      sub.write(`\n--- job ${status} ---\n`);
    } catch {}
  }
}

export { MAX_BUFFERED_BYTES };