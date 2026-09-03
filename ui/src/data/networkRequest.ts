const REQUEST_TIMEOUT_MS = 10_000;
const MAX_NETWORK_RETRIES = 3;
const RETRY_DELAY_MS = 250;

export class NetworkTimeoutError extends Error {}

export async function withNetworkRetries<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withNetworkTimeout(operation);
    } catch (error) {
      if (!isNetworkError(error) || attempt >= MAX_NETWORK_RETRIES) throw error;
      await delay(RETRY_DELAY_MS * 2 ** attempt);
    }
  }
}

async function withNetworkTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = timeoutAfter(controller);
  try {
    return await Promise.race([operation(controller.signal), timeout.promise]);
  } finally {
    clearTimeout(timeout.id);
  }
}

function timeoutAfter(controller: AbortController) {
  let id: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    id = setTimeout(() => {
      const error = new NetworkTimeoutError("network request timed out");
      controller.abort(error);
      reject(error);
    }, REQUEST_TIMEOUT_MS);
  });
  return { promise, id: id! };
}

export function isNetworkError(error: unknown): boolean {
  if (error instanceof NetworkTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return (
    error instanceof TypeError &&
    /fetch|network|load failed|offline/i.test(error.message)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
