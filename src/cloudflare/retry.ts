const BASE_BACKOFF_MS = 50;

export const isRetryable = (error: unknown): boolean =>
  !!error && typeof error === "object" && Reflect.get(error, "retryable") === true && Reflect.get(error, "overloaded") !== true;

export async function retryTransient<T>(call: () => Promise<T>, attempts: number, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryable(error)) throw error;
      await sleep(BASE_BACKOFF_MS * Math.random() * 2 ** attempt);
    }
  }
}
