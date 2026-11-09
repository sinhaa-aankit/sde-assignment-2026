// Tiny HTTP client for the simulator.
// GETs are retried (safe to repeat). POST/PUT are NOT retried blindly: repeating a write could
// double-advance time or double-submit. Writes are made safe by idempotency keys instead.

export class SimError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function simClient(baseUrl: string) {
  async function call(method: string, path: string, body?: object): Promise<any> {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const isJson = res.headers.get("content-type")?.startsWith("application/json"); // event chunks are NDJSON text
    const data = isJson && text ? JSON.parse(text) : text;
    if (!res.ok) throw new SimError(res.status, data);
    return data;
  }

  async function get(path: string): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call("GET", path);
      } catch (e) {
        const retryable = !(e instanceof SimError) || e.status >= 500;
        if (!retryable || attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt)); // back off: 0.5s, 1s, 1.5s...
      }
    }
  }

  return {
    get,
    post: (path: string, body: object) => call("POST", path, body),
    put: (path: string, body: object) => call("PUT", path, body),
  };
}

export type Sim = ReturnType<typeof simClient>;
