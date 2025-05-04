export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries = 1,
  timeoutMs = 5000 // default timeout 5 seconds
): Promise<Response> {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      if (res.ok) return res;
      lastError = new Error(`HTTP error: ${res.status}`);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(id);
    }
  }
  throw lastError;
} 