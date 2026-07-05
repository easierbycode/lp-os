// Framework-free scan-relay client (port of tiktok-sample-tracker
// src/lib/scan-link.ts). The /scanner companion page publishes scans through
// here; every other surface (LP-OS shell, inventory tabs) listens through
// here. The wire protocol matches @lp-os/relay server.ts, which is itself
// wire-identical to the original data-pimp /api/scan-socket relay.

// TikTok product ids, e.g. 1731891756549444298 (18-19 digits).
export const PRODUCT_ID_RE = /^\d{18,19}$/;
// Retail barcodes worth an inventory lookup: UPC-A/E, EAN-8/13, ITF-14.
export const BARCODE_RE = /^(\d{8}|\d{12,14})$/;

export type ScanKind = "productId" | "barcode" | "other";

export function classifyScan(value: string): ScanKind {
  if (PRODUCT_ID_RE.test(value)) return "productId";
  if (BARCODE_RE.test(value)) return "barcode";
  return "other";
}

// BLE GATT identity shared with the OS shell and the Cordova build: a scanner
// peripheral advertises this service; scans arrive as notifications on the
// characteristic as UTF-8 JSON ({value, format, scanId}) or bare text. The
// UUIDs are unchanged from the thirsty-store deployment so already-paired
// hardware keeps working.
export const SCAN_BLE_SERVICE = "c0de5ca0-ba7c-4de1-9a0d-2b5a3f1c9e01";
export const SCAN_BLE_CHARACTERISTIC = "c0de5ca1-ba7c-4de1-9a0d-2b5a3f1c9e01";

export interface ScanEvent {
  type: "scan";
  value: string;
  format: string;
  scanId: string;
  deviceId?: string;
  deviceName?: string;
  at?: number;
}

export interface ScannerPresence {
  count: number;
  devices: { id: string; name?: string; since?: number }[];
}

export type RelayStatus = "connecting" | "open" | "closed";

const DEVICE_ID_KEY = "lpos-scanner-device-id";
const DEVICE_NAME_KEY = "lpos-scanner-device-name";
const RELAY_URL_KEY = "lpos-scan-relay-url";
const RELAY_TOKEN_KEY = "lpos-scan-relay-token";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface LocationLike {
  protocol?: string;
  host?: string;
  origin?: string;
  search?: string;
}

// Storage can throw outright (Safari "Block All Cookies", restricted
// webviews) or be absent entirely (server-side import); every touch degrades
// to in-memory fallbacks so the scanner keeps a per-session identity.
function storage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function locationLike(): LocationLike | null {
  try {
    const loc = (globalThis as { location?: LocationLike }).location;
    return loc ?? null;
  } catch {
    return null;
  }
}

let memDeviceId: string | null = null;
let memDeviceName = "";

export function scanDeviceId(): string {
  try {
    const store = storage();
    let id = store?.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = "scanner-" + crypto.randomUUID().slice(0, 8);
      store?.setItem(DEVICE_ID_KEY, id);
      if (!store) return (memDeviceId ??= id);
    }
    return id;
  } catch {
    return (memDeviceId ??= "scanner-" + crypto.randomUUID().slice(0, 8));
  }
}

export function scanDeviceName(): string {
  try {
    return storage()?.getItem(DEVICE_NAME_KEY) || memDeviceName;
  } catch {
    return memDeviceName;
  }
}

export function setScanDeviceName(name: string) {
  memDeviceName = name.trim().slice(0, 80);
  try {
    storage()?.setItem(DEVICE_NAME_KEY, memDeviceName);
  } catch {
    // in-memory fallback already holds it for this session
  }
}

function validRelayUrl(value: string | null | undefined): value is string {
  return !!value && /^wss?:\/\//i.test(value);
}

function relayUrlWithToken(url: string, token: string | null): string {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("scanToken", token);
    return u.href;
  } catch {
    return url;
  }
}

// Same-origin default: the LP-OS shell serves both the pages and the relay,
// so ws(s)://<current host>/api/scan-socket is right wherever a browser is
// involved. Outside a browser (tests, tooling) fall back to the shell's
// default local port.
export function defaultRelayUrl(): string {
  const loc = locationLike();
  if (loc?.host && (loc.protocol === "http:" || loc.protocol === "https:")) {
    return `${
      loc.protocol === "http:" ? "ws" : "wss"
    }://${loc.host}/api/scan-socket`;
  }
  return "ws://localhost:8000/api/scan-socket";
}

// Relay endpoint resolution: explicit ?relay= (persisted for next launch) >
// previously saved override > same-origin default. Lets a dev point a phone
// at a local relay (e.g. ?relay=ws://192.168.1.20:8000/api/scan-socket).
// Optional ?scanToken= / ?relayToken= is persisted separately and appended as
// a query param because browser WebSocket clients cannot send custom headers.
export function relayUrl(): string {
  let token: string | null = null;
  let fromQuery: string | null = null;
  try {
    const params = new URLSearchParams(locationLike()?.search ?? "");
    const fromToken = params.get("scanToken") || params.get("relayToken") ||
      params.get("token");
    fromQuery = params.get("relay");
    token = fromToken;
    try {
      if (fromToken) storage()?.setItem(RELAY_TOKEN_KEY, fromToken);
      token ||= storage()?.getItem(RELAY_TOKEN_KEY) ?? null;
    } catch {
      // Query-provided token still works for this page load.
    }
  } catch {
    // URL access can fail in exotic embeds; fall through to saved/default.
  }
  if (validRelayUrl(fromQuery)) {
    try {
      storage()?.setItem(RELAY_URL_KEY, fromQuery);
    } catch {
      // Explicit launch URL still wins for this page load.
    }
    return relayUrlWithToken(fromQuery, token);
  }
  try {
    const saved = storage()?.getItem(RELAY_URL_KEY);
    if (validRelayUrl(saved)) return relayUrlWithToken(saved, token);
  } catch {
    // storage access can fail in exotic embeds; fall through to default
  }
  return relayUrlWithToken(defaultRelayUrl(), token);
}

// Running inside an LP-OS window (or any iframe)?
export function isEmbedded(): boolean {
  try {
    const w = globalThis as { parent?: unknown; self?: unknown };
    if (w.parent === undefined) return false;
    return w.parent !== w.self;
  } catch {
    return true;
  }
}

// Where to postMessage when embedded: the actual embedding origin when the
// browser exposes it (referrer), else our own origin (shell and apps are
// same-origin in LP-OS).
export function parentShellOrigin(): string {
  try {
    const referrer = (globalThis as { document?: { referrer?: string } })
      .document?.referrer;
    if (referrer) return new URL(referrer).origin;
  } catch {
    // fall through
  }
  return locationLike()?.origin ?? "";
}

export interface ScanRelayOptions {
  role: "scanner" | "listener";
  deviceId?: string;
  name?: string;
  url?: string;
  onScan?: (event: ScanEvent) => void;
  onPresence?: (presence: ScannerPresence) => void;
  onStatus?: (status: RelayStatus) => void;
}

// Auto-reconnecting relay client. Scanners announce themselves (which also
// registers them in the Kiosk Fleet panel); listeners just consume. A 10s
// ping doubles as the fleet heartbeat. Reconnect backoff: 1s doubling to 30s.
export class ScanRelay {
  private opts: ScanRelayOptions;
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 1000;
  private closed = false;

  constructor(opts: ScanRelayOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  connect() {
    this.closed = false;
    this.open();
  }

  private open() {
    if (this.closed) return;
    this.opts.onStatus?.("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url || relayUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retryMs = 1000;
      this.opts.onStatus?.("open");
      this.send({
        type: "hello",
        role: this.opts.role,
        deviceId: this.opts.deviceId,
        name: this.opts.name,
      });
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), 10000);
    });

    socket.addEventListener("message", (e) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "scan" && typeof msg.value === "string") {
        this.opts.onScan?.(msg as unknown as ScanEvent);
      } else if (msg.type === "scanners") {
        this.opts.onPresence?.({
          count: Number(msg.count) || 0,
          devices: Array.isArray(msg.devices)
            ? (msg.devices as ScannerPresence["devices"])
            : [],
        });
      }
    });

    socket.addEventListener(
      "close",
      () => {
        this.opts.onStatus?.("closed");
        this.scheduleRetry();
      },
      { once: true },
    );
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // close event drives reconnect; ignore sockets already closing
      }
    });
  }

  private scheduleRetry() {
    clearInterval(this.pingTimer);
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  private send(payload: Record<string, unknown>) {
    if (this.isOpen) this.socket!.send(JSON.stringify(payload));
  }

  // Build + transmit a scan event; returns it so callers can fan the same
  // event out over other transports (postMessage to the OS shell, BLE).
  sendScan(value: string, format: string): ScanEvent {
    const event: ScanEvent = {
      type: "scan",
      value,
      format,
      scanId: crypto.randomUUID(),
      deviceId: this.opts.deviceId,
      deviceName: this.opts.name,
      at: Date.now(),
    };
    this.send(event as unknown as Record<string, unknown>);
    return event;
  }

  // Update the advertised device name (next hello announces it).
  rename(name: string) {
    this.opts.name = name;
    if (this.isOpen) {
      this.send({
        type: "hello",
        role: this.opts.role,
        deviceId: this.opts.deviceId,
        name,
      });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }
}
