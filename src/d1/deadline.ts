const COORDINATOR_TIMEOUT_MS = 2_000;

export async function withinCoordinatorDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cache coordinator timeout')), COORDINATOR_TIMEOUT_MS); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
