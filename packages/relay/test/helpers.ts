// Shared plumbing for relay tests: spin a real Deno.serve on an ephemeral
// port routing /api/scan-socket to the relay under test, and a WebSocket
// probe that buffers parsed messages with predicate-based waiting.

import {
  createScanRelay,
  type ScanRelayServer,
  type ScanRelayServerOptions,
} from "../server.ts";

export interface RelayCtx {
  relay: ScanRelayServer;
  url: string; // ws://127.0.0.1:<port>/api/scan-socket
  httpUrl: string; // http://127.0.0.1:<port>
}

// env entries are set only for the duration of createScanRelay (config is
// captured at factory time), keeping tests deterministic and isolated.
export async function withRelay(
  opts: ScanRelayServerOptions,
  env: Record<string, string>,
  fn: (ctx: RelayCtx) => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, Deno.env.get(key) ?? undefined);
    Deno.env.set(key, value);
  }
  let relay: ScanRelayServer;
  try {
    relay = createScanRelay(opts);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/api/scan-socket") return relay.handleUpgrade(req);
      return new Response("not found", { status: 404 });
    },
  );
  const addr = server.addr as Deno.NetAddr;
  try {
    await fn({
      relay,
      url: `ws://127.0.0.1:${addr.port}/api/scan-socket`,
      httpUrl: `http://127.0.0.1:${addr.port}`,
    });
  } finally {
    await relay.close();
    await server.shutdown();
  }
}

type Msg = Record<string, unknown>;
type Waiter = { pred: (m: Msg) => boolean; resolve: (m: Msg) => void };

export class WsProbe {
  readonly ws: WebSocket;
  readonly messages: Msg[] = [];
  readonly closed: Promise<CloseEvent>;
  private waiters: Waiter[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (e) => resolve(e), { once: true });
    });
    ws.addEventListener("message", (e: MessageEvent) => {
      let msg: Msg;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  static connect(url: string): Promise<WsProbe> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const probe = new WsProbe(ws);
      ws.addEventListener("open", () => resolve(probe), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error(`WebSocket connect failed: ${url}`)),
        { once: true },
      );
    });
  }

  send(payload: Msg) {
    this.ws.send(JSON.stringify(payload));
  }

  // Index to pass as `after` so a later next() ignores already-buffered
  // messages (e.g. stale presence snapshots).
  mark(): number {
    return this.messages.length;
  }

  next(
    pred: (m: Msg) => boolean,
    opts: { after?: number; timeoutMs?: number; label?: string } = {},
  ): Promise<Msg> {
    const { after = 0, timeoutMs = 3000, label = "message" } = opts;
    const hit = this.messages.slice(after).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  scans(): Msg[] {
    return this.messages.filter((m) => m.type === "scan");
  }

  async dispose() {
    if (this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        // already closing
      }
      await this.closed;
    }
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out: ${label}`)),
      ms,
    );
    promise.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }, (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
