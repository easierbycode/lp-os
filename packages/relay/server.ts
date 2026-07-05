// Scan-socket realtime relay (port of data-pimp main.ts /api/scan-socket).
// Handheld Scanner devices (role "scanner") push scan events; every other
// connected client (role "listener": the OS shell, Inventory/Kiosk tabs)
// receives them instantly. Presence updates keep the OS dock indicator and
// the Kiosk Fleet panel in sync. State is in-memory per relay instance; a
// BroadcastChannel bridge (when the runtime provides one) and an optional
// Postgres NOTIFY/LISTEN bridge forward scans/presence across isolates.
// Wire-protocol-identical to the original thirsty.store relay.

// @ts-types="npm:@types/pg@^8.15.5"
import pg from "pg";
import type { Client, ClientConfig, Notification, Pool } from "pg";
import type { ScannerPresence } from "./client.ts";

export type { ScanEvent, ScannerPresence } from "./client.ts";

export interface KioskInfo {
  id: string;
  lastSeen: number;
  online: boolean;
  disabled: boolean;
  kind: "kiosk" | "scanner";
  label: string;
}

export interface ScanRelayServer {
  handleUpgrade(req: Request): Response; // WS upgrade + origin/token check
  presenceSnapshot(): ScannerPresence; // {count, devices:[{id,name?,since?}]}
  heartbeat(body: unknown): KioskInfo; // POST /api/heartbeat handler logic
  kiosks(): KioskInfo[];
  setKioskDisabled(id: string, disabled: boolean): KioskInfo | null;
  close(): Promise<void>;
}

export interface ScanRelayServerOptions {
  pool?: Pool; // enables Postgres NOTIFY/LISTEN bridge
  // Dedicated connection config for the LISTEN session. Defaults to the pool's
  // own construction config, so passing just `pool` still gets a bridge — but
  // the LISTEN session NEVER checks a client out of the request pool (data-pimp
  // ran its pool at max:1; a permanently held pool client starves every
  // DB-backed route).
  listenConnection?: string | ClientConfig;
  allowedOrigins?: string[]; // merged with SCAN_RELAY_ORIGINS env + localhost
  token?: string; // fallback: SCAN_RELAY_TOKEN env
}

const PG_CHANNEL = "lp_os_scan_relay";
// pg NOTIFY payloads cap at 8000 BYTES. Anything over the guard below is
// dropped rather than erroring — possible for a scan event whose 4096-char
// value is heavily non-ASCII (UTF-8 expands it), or an enormous presence list.
const PG_MAX_PAYLOAD_BYTES = 7500;
const PG_MAX_RECONNECTS = 10;
const BROADCAST_CHANNEL_NAME = "lp-os-scan-relay";
const KIOSK_ONLINE_WINDOW_MS = 15_000;

type ScanClient = {
  socket: WebSocket;
  role: "scanner" | "listener";
  deviceId: string;
  name: string;
  since: number;
  hello: boolean;
  scanTimes: number[];
};

type KioskEntry = {
  lastSeen: number;
  disabled: boolean;
  kind?: "kiosk" | "scanner";
  label?: string;
};

function envValue(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    return undefined; // no --allow-env: run on defaults
  }
}

function numberEnv(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // deno-lint-ignore no-control-regex -- stripping control chars is the point
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function cleanDeviceId(value: unknown): string {
  const cleaned = cleanText(value, 120)
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || `scanner-${crypto.randomUUID().slice(0, 8)}`;
}

function localOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createScanRelay(
  opts: ScanRelayServerOptions = {},
): ScanRelayServer {
  // Config is read once per relay instance so tests (and hot-swaps) can vary
  // limits via env without module-level state.
  const token = opts.token ?? envValue("SCAN_RELAY_TOKEN") ?? "";
  const allowNoOrigin = envValue("SCAN_RELAY_ALLOW_NO_ORIGIN") === "true";
  const maxClients = numberEnv("SCAN_RELAY_MAX_CLIENTS", 200);
  const maxMessageChars = numberEnv("SCAN_RELAY_MAX_MESSAGE_CHARS", 8192);
  const maxValueChars = numberEnv("SCAN_RELAY_MAX_VALUE_CHARS", 4096);
  const rateWindowMs = numberEnv("SCAN_RELAY_RATE_WINDOW_MS", 10_000);
  const maxScansPerWindow = numberEnv("SCAN_RELAY_MAX_SCANS_PER_WINDOW", 40);
  const remoteTtlMs = numberEnv("SCAN_RELAY_REMOTE_TTL_MS", 30_000);

  const configuredOrigins = new Set<string>();
  for (const raw of opts.allowedOrigins ?? []) {
    const origin = normalizeOrigin(raw);
    if (origin) configuredOrigins.add(origin);
  }
  for (const raw of (envValue("SCAN_RELAY_ORIGINS") || "").split(",")) {
    const origin = normalizeOrigin(raw);
    if (origin) configuredOrigins.add(origin);
  }

  const instanceId = crypto.randomUUID();
  const clients = new Set<ScanClient>();
  const remoteScanners = new Map<
    string,
    {
      id: string;
      name: string;
      since: number;
      relayId: string;
      expiresAt: number;
    }
  >();
  const kiosks = new Map<string, KioskEntry>();
  let closed = false;

  /* --------------------------------------------------- origin/token gate -- */

  function allowedScanOrigins(req: Request): Set<string> {
    // The relay's own origin is always allowed: shell pages and the socket
    // are served from the same host.
    const origins = new Set(configuredOrigins);
    try {
      origins.add(new URL(req.url).origin);
    } catch {
      // synthetic request without a valid URL — configured set still applies
    }
    return origins;
  }

  function tokenValid(req: Request): boolean {
    if (!token) return true;
    const url = new URL(req.url);
    const supplied = url.searchParams.get("scanToken") ||
      url.searchParams.get("token") || "";
    return supplied === token;
  }

  function originAllowed(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin) {
      // Non-browser clients (no Origin header): allow when the request hits a
      // localhost listener, when explicitly opted in, or with a valid token.
      const url = new URL(req.url);
      return localOrigin(url.origin) ||
        allowNoOrigin ||
        Boolean(token && tokenValid(req));
    }
    return allowedScanOrigins(req).has(normalizeOrigin(origin)) ||
      localOrigin(origin);
  }

  /* ------------------------------------------------ cross-isolate bridge -- */

  // BroadcastChannel is the fast path between isolates, but not every runtime
  // provides it; the Postgres bridge below rides the DATABASE_URL every full
  // deployment already has. Scans from other isolates fan out to local
  // sockets only — never re-published, so no echo loops.

  // Both transports can be live at once (BroadcastChannel + pg NOTIFY), so a
  // remote scan can arrive twice. Dedupe by scanId with a short TTL; presence
  // messages are idempotent and need no dedupe.
  const BRIDGE_SCAN_TTL_MS = 30_000;
  const seenBridgeScans = new Map<string, number>(); // scanId → expiresAt
  function bridgeScanSeen(scanId: string): boolean {
    const now = Date.now();
    if (seenBridgeScans.size > 500) {
      for (const [key, expires] of seenBridgeScans) {
        if (expires <= now) seenBridgeScans.delete(key);
      }
    }
    const expires = seenBridgeScans.get(scanId);
    if (expires !== undefined && expires > now) return true;
    seenBridgeScans.set(scanId, now + BRIDGE_SCAN_TTL_MS);
    return false;
  }

  function handleBridgeMessage(data: unknown) {
    if (!data || typeof data !== "object") return;
    const msg = data as Record<string, unknown>;
    if (msg.relayId === instanceId) return;
    if (
      msg.type === "scan-event" && msg.event && typeof msg.event === "object"
    ) {
      const event = msg.event as Record<string, unknown>;
      const scanId = typeof event.scanId === "string" ? event.scanId : "";
      if (scanId && bridgeScanSeen(scanId)) return; // other transport won
      sendToLocal(event, null);
    } else if (msg.type === "scanner-presence" && Array.isArray(msg.devices)) {
      receiveRemotePresence(
        String(msg.relayId || ""),
        msg.devices as Array<Record<string, unknown>>,
      );
    }
  }

  const channel = (() => {
    try {
      return new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    } catch {
      return null; // runtime without BroadcastChannel — pg bridge still covers
    }
  })();
  channel?.addEventListener("message", (e: MessageEvent) => {
    handleBridgeMessage(e.data);
  });

  // The provided pool serves request traffic; LISTEN needs a connection held
  // open forever, so the bridge opens a DEDICATED pg Client (never a pool
  // checkout — data-pimp sized its request pool at max:1, and a permanently
  // held pool client would starve every DB-backed route). The session config
  // comes from opts.listenConnection, falling back to the pool's own
  // construction config (same server, same TLS). Reconnects with capped
  // backoff if the connection drops.
  let pgReady = false;
  let pgAttempts = 0;
  let listenClient: Client | null = null;
  let pgRetryTimer: ReturnType<typeof setTimeout> | undefined;

  function listenClientConfig(): ClientConfig | null {
    const conn = opts.listenConnection;
    if (typeof conn === "string") return { connectionString: conn };
    if (conn && typeof conn === "object") return conn;
    // pg.Pool keeps its construction config on `.options` (connectionString,
    // ssl, …) — reuse it so the LISTEN session dials the same server.
    const options = (opts.pool as unknown as { options?: ClientConfig })
      ?.options;
    return options ?? null;
  }

  function schedulePgRetry() {
    if (closed) return;
    clearTimeout(pgRetryTimer);
    // Delay from the LIVE counter (reset to 0 on success): a healthy
    // connection that drops retries in ~1-2s, while repeated connect
    // failures climb the exponential ladder.
    pgRetryTimer = setTimeout(
      startPgBridge,
      Math.min(1000 * 2 ** Math.max(pgAttempts, 1), 60_000),
    );
  }

  function startPgBridge() {
    const config = listenClientConfig();
    if (!config || closed) return;
    if (pgAttempts >= PG_MAX_RECONNECTS) {
      console.warn("[scan-relay] pg bridge gave up after repeated failures");
      return;
    }
    pgAttempts++;
    pgReady = false;

    const client = new pg.Client(config);
    listenClient = client;

    client.on("notification", (n: Notification) => {
      if (n.channel !== PG_CHANNEL || !n.payload) return;
      try {
        handleBridgeMessage(JSON.parse(n.payload));
      } catch {
        // Foreign writers on the channel must not crash the relay.
      }
    });

    const reconnect = () => {
      if (listenClient !== client) return; // superseded by a newer attempt
      listenClient = null;
      pgReady = false;
      client.end().catch(() => {/* already gone */});
      schedulePgRetry();
    };
    client.on("error", reconnect);
    client.on("end", reconnect);

    client.connect().then(() => {
      if (closed) {
        listenClient = null;
        client.end().catch(() => {/* already gone */});
        return;
      }
      // Channel names cannot be parameterized; PG_CHANNEL is a local constant.
      return client.query(`LISTEN ${PG_CHANNEL}`).then(() => {
        pgReady = true;
        pgAttempts = 0; // healthy — future drops restart the backoff ladder
      });
    }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn("[scan-relay] pg bridge connect/LISTEN failed:", detail);
      reconnect();
    });
  }

  startPgBridge();

  // Publish to every available bridge transport (both are best-effort; local
  // sockets were already served directly before this is called).
  function publishBridgeMessage(message: Record<string, unknown>) {
    try {
      channel?.postMessage(message);
    } catch {
      // BroadcastChannel post can fail on teardown; pg below still covers it.
    }
    const client = listenClient;
    if (!client || !pgReady) return;
    const payload = JSON.stringify(message);
    // Postgres enforces the NOTIFY limit in UTF-8 bytes, not JS string length.
    if (new TextEncoder().encode(payload).length <= PG_MAX_PAYLOAD_BYTES) {
      // NOTIFY rides the dedicated LISTEN session (like the original bridge),
      // so publishing never queues behind request traffic in the shared pool.
      client.query("select pg_notify($1, $2)", [PG_CHANNEL, payload])
        .catch(() => {
          // Connection errors also surface on the listen client → reconnect.
        });
    } else if (message.type === "scan-event") {
      console.warn("[scan-relay] scan event too large for pg bridge; dropped");
    }
  }

  /* ------------------------------------------------------------ presence -- */

  function localScanners(): ScanClient[] {
    return [...clients].filter((c) => c.role === "scanner");
  }

  function scannerDevice(client: ScanClient) {
    return { id: client.deviceId, name: client.name, since: client.since };
  }

  function pruneRemoteScanners(now = Date.now()) {
    for (const [key, device] of remoteScanners) {
      if (device.expiresAt <= now) remoteScanners.delete(key);
    }
  }

  const pruneTimer = setInterval(() => {
    const before = remoteScanners.size;
    pruneRemoteScanners();
    if (remoteScanners.size !== before) broadcastPresence(false);
  }, Math.max(5000, Math.floor(remoteTtlMs / 2)));

  function allScannerDevices() {
    pruneRemoteScanners();
    const devices = new Map<
      string,
      { id: string; name: string; since: number }
    >();
    for (const device of remoteScanners.values()) {
      devices.set(device.id, {
        id: device.id,
        name: device.name,
        since: device.since,
      });
    }
    for (const scanner of localScanners()) {
      devices.set(scanner.deviceId, scannerDevice(scanner));
    }
    return [...devices.values()];
  }

  function sendToLocal(
    event: Record<string, unknown>,
    from: ScanClient | null,
  ) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client === from) continue;
      try {
        if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(payload);
        }
      } catch {
        // A dying socket must not break the fan-out to everyone else.
      }
    }
  }

  function publishLocalPresence() {
    // Cross-isolate presence is best-effort; local sockets remain accurate.
    publishBridgeMessage({
      type: "scanner-presence",
      relayId: instanceId,
      devices: localScanners().map(scannerDevice),
      at: Date.now(),
    });
  }

  function receiveRemotePresence(
    relayId: string,
    devices: Array<Record<string, unknown>>,
  ) {
    if (!relayId) return;
    for (const [key, device] of remoteScanners) {
      if (device.relayId === relayId) remoteScanners.delete(key);
    }
    const now = Date.now();
    for (const device of devices) {
      const id = cleanDeviceId(device.id);
      const name = cleanText(device.name, 80);
      const since =
        typeof device.since === "number" && Number.isFinite(device.since)
          ? device.since
          : now;
      remoteScanners.set(`${relayId}:${id}`, {
        id,
        name,
        since,
        relayId,
        expiresAt: now + remoteTtlMs,
      });
      touchScannerFleetDevice(id, name);
    }
    broadcastPresence(false);
  }

  // Presence snapshot for local + bridged scanners, broadcast on every
  // join/leave and scanner heartbeat so the OS dock badge updates live.
  function broadcastPresence(publish = true) {
    const devices = allScannerDevices();
    sendToLocal({ type: "scanners", count: devices.length, devices }, null);
    if (publish) publishLocalPresence();
  }

  /* ---------------------------------------------------------- kiosk fleet -- */

  // A connected scanner is fleet-visible: keep its heartbeat fresh while the
  // socket lives so the Kiosk Fleet panel shows it online.
  function touchScannerFleetDevice(deviceId: string, name: string) {
    const existing = kiosks.get(deviceId);
    kiosks.set(deviceId, {
      lastSeen: Date.now(),
      disabled: existing?.disabled || false,
      kind: "scanner",
      label: name,
    });
  }

  function touchScannerFleet(client: ScanClient) {
    if (client.role !== "scanner") return;
    touchScannerFleetDevice(client.deviceId, client.name);
  }

  function kioskInfo(id: string): KioskInfo | null {
    const k = kiosks.get(id);
    if (!k) return null;
    return {
      id,
      lastSeen: k.lastSeen,
      online: !k.disabled && Date.now() - k.lastSeen < KIOSK_ONLINE_WINDOW_MS,
      disabled: k.disabled,
      kind: k.kind || "kiosk",
      label: k.label || "",
    };
  }

  /* ------------------------------------------------------------ messages -- */

  function parseSocketMessage(data: unknown): Record<string, unknown> | null {
    if (typeof data !== "string") return null;
    if (data.length > maxMessageChars) return null;
    try {
      const msg = JSON.parse(data);
      return msg && typeof msg === "object" && !Array.isArray(msg)
        ? msg as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  function rateLimitScan(client: ScanClient): boolean {
    const now = Date.now();
    client.scanTimes = client.scanTimes.filter((t) => now - t < rateWindowMs);
    if (client.scanTimes.length >= maxScansPerWindow) return false;
    client.scanTimes.push(now);
    return true;
  }

  function acceptSocket(req: Request): Response {
    const { socket, response } = Deno.upgradeWebSocket(req);
    const client: ScanClient = {
      socket,
      role: "listener",
      deviceId: crypto.randomUUID(),
      name: "",
      since: Date.now(),
      hello: false,
      scanTimes: [],
    };

    socket.onopen = () => {
      clients.add(client);
      broadcastPresence();
    };

    socket.onmessage = (e) => {
      const msg = parseSocketMessage(e.data);
      if (!msg) {
        try {
          socket.close(1003, "Invalid scan-relay message");
        } catch { /* already closing */ }
        return;
      }

      if (msg.type === "hello") {
        client.role = msg.role === "scanner" ? "scanner" : "listener";
        client.hello = true;
        client.deviceId = client.role === "scanner"
          ? cleanDeviceId(msg.deviceId)
          : cleanDeviceId(msg.deviceId || client.deviceId);
        client.name = cleanText(msg.name, 80) ||
          (client.role === "scanner" ? client.deviceId : "listener");
        touchScannerFleet(client);
        broadcastPresence();
        return;
      }
      if (msg.type === "ping") {
        touchScannerFleet(client);
        if (client.role === "scanner") broadcastPresence();
        try {
          socket.send(JSON.stringify({ type: "pong" }));
        } catch { /* closing */ }
        return;
      }
      if (
        msg.type === "scan" && typeof msg.value === "string" &&
        msg.value.length > 0
      ) {
        if (!client.hello || client.role !== "scanner") {
          try {
            socket.close(1008, "Scan publisher must identify as scanner");
          } catch { /* already closing */ }
          return;
        }
        if (kiosks.get(client.deviceId)?.disabled) return;
        if (!rateLimitScan(client)) {
          try {
            socket.close(1008, "Scan rate limit exceeded");
          } catch { /* already closing */ }
          return;
        }
        const value = cleanText(msg.value, maxValueChars);
        if (!value || value.length !== msg.value.trim().length) return;
        const event = {
          type: "scan",
          value,
          format: cleanText(msg.format, 64) || "unknown",
          scanId: cleanText(msg.scanId, 120) || crypto.randomUUID(),
          deviceId: client.deviceId,
          deviceName: client.name,
          at: Date.now(),
        };
        touchScannerFleet(client);
        sendToLocal(event, client);
        publishBridgeMessage({
          type: "scan-event",
          relayId: instanceId,
          event,
        });
        return;
      }
    };

    const drop = () => {
      if (!clients.has(client)) return;
      clients.delete(client);
      // Leave the fleet entry in place — it flips to OFFLINE via the 15s
      // lastSeen window, mirroring how kiosk heartbeats age out.
      broadcastPresence();
    };
    socket.onclose = drop;
    socket.onerror = drop;

    return response;
  }

  /* ---------------------------------------------------------- public API -- */

  return {
    handleUpgrade(req: Request): Response {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "WebSocket upgrade required" }, 400);
      }
      if (clients.size >= maxClients) {
        return json({ error: "Scan relay is at capacity" }, 503);
      }
      if (!originAllowed(req)) {
        return json({ error: "Forbidden scan relay origin" }, 403);
      }
      return acceptSocket(req);
    },

    presenceSnapshot(): ScannerPresence {
      const devices = allScannerDevices();
      return { count: devices.length, devices };
    },

    heartbeat(body: unknown): KioskInfo {
      const b = (body && typeof body === "object" ? body : {}) as Record<
        string,
        unknown
      >;
      const id = cleanDeviceId(b.id ?? b.kioskId ?? "unknown");
      const existing = kiosks.get(id);
      kiosks.set(id, {
        lastSeen: Date.now(),
        disabled: existing?.disabled || false,
        kind: b.kind === "scanner" ? "scanner" : (existing?.kind || "kiosk"),
        label: cleanText(b.label, 80) || existing?.label || "",
      });
      return kioskInfo(id)!;
    },

    kiosks(): KioskInfo[] {
      return [...kiosks.keys()].map((id) => kioskInfo(id)!);
    },

    setKioskDisabled(id: string, disabled: boolean): KioskInfo | null {
      const cleanId = cleanDeviceId(id);
      const existing = kiosks.get(cleanId);
      kiosks.set(cleanId, {
        lastSeen: existing?.lastSeen || (disabled ? 0 : Date.now()),
        disabled,
        kind: existing?.kind || "kiosk",
        label: existing?.label || "",
      });
      return kioskInfo(cleanId);
    },

    close(): Promise<void> {
      closed = true;
      clearInterval(pruneTimer);
      clearTimeout(pgRetryTimer);
      try {
        channel?.close();
      } catch { /* already closed */ }
      for (const client of [...clients]) {
        try {
          client.socket.close(1001, "Relay shutting down");
        } catch { /* already closing */ }
      }
      clients.clear();
      remoteScanners.clear();
      const held = listenClient;
      listenClient = null;
      pgReady = false;
      if (held) {
        held.end().catch(() => {/* already closed */});
      }
      return Promise.resolve();
    },
  };
}
