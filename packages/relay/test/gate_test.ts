// Origin/token/capacity gate tests. The gate runs before the WebSocket
// upgrade, so most cases are testable with synthetic Requests (Deno keeps
// the upgrade/origin headers on constructed Requests). When the gate PASSES
// the handler proceeds to Deno.upgradeWebSocket; gateAllows() treats
// anything that is not a 4xx/5xx JSON rejection as "allowed".

import { assert, assertEquals } from "@std/assert";
import type { ScanRelayServer } from "../server.ts";
import { withRelay, WsProbe } from "./helpers.ts";

function upgradeReq(url: string, origin?: string): Request {
  const headers: Record<string, string> = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  };
  if (origin) headers.origin = origin;
  return new Request(url, { headers });
}

function gateAllows(relay: ScanRelayServer, req: Request): boolean {
  try {
    const res = relay.handleUpgrade(req);
    return res.status < 400;
  } catch {
    // Synthetic requests can pass the gate but fail the actual socket
    // upgrade — that still proves the gate allowed them.
    return true;
  }
}

Deno.test("non-websocket requests get 400 (real wire)", async () => {
  await withRelay({}, {}, async ({ httpUrl }) => {
    const res = await fetch(`${httpUrl}/api/scan-socket`);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "WebSocket upgrade required");
  });
});

Deno.test("unknown browser origins are rejected with 403", async () => {
  await withRelay({}, {}, ({ relay }) => {
    const req = upgradeReq(
      "http://relay.example.com/api/scan-socket",
      "https://evil.example.com",
    );
    const res = relay.handleUpgrade(req);
    assertEquals(res.status, 403);
    return Promise.resolve();
  });
});

Deno.test("localhost origins are always allowed", async () => {
  await withRelay({}, {}, ({ relay }) => {
    for (
      const origin of [
        "http://localhost:5173",
        "http://127.0.0.1:8000",
        "http://[::1]:3000",
      ]
    ) {
      assert(
        gateAllows(
          relay,
          upgradeReq("http://relay.example.com/api/scan-socket", origin),
        ),
        `expected ${origin} to be allowed`,
      );
    }
    return Promise.resolve();
  });
});

Deno.test("allowedOrigins option and SCAN_RELAY_ORIGINS env are honored", async () => {
  await withRelay(
    { allowedOrigins: ["https://kiosk.example.com"] },
    { SCAN_RELAY_ORIGINS: "https://ops.example.com/, https://two.example.com" },
    ({ relay }) => {
      const url = "http://relay.example.com/api/scan-socket";
      assert(gateAllows(relay, upgradeReq(url, "https://kiosk.example.com")));
      // env origins are trimmed and trailing slashes stripped
      assert(gateAllows(relay, upgradeReq(url, "https://ops.example.com")));
      assert(gateAllows(relay, upgradeReq(url, "https://two.example.com")));
      assertEquals(
        relay.handleUpgrade(upgradeReq(url, "https://other.example.com"))
          .status,
        403,
      );
      return Promise.resolve();
    },
  );
});

Deno.test("same-origin requests are allowed (request URL origin)", async () => {
  await withRelay({}, {}, ({ relay }) => {
    const req = upgradeReq(
      "https://lp-os.example.com/api/scan-socket",
      "https://lp-os.example.com",
    );
    assert(gateAllows(relay, req));
    return Promise.resolve();
  });
});

Deno.test("token is a fallback for origin-less clients only", async () => {
  await withRelay({ token: "sekret" }, {}, ({ relay }) => {
    const base = "http://relay.example.com/api/scan-socket";
    // no origin + valid token -> allowed
    assert(gateAllows(relay, upgradeReq(`${base}?scanToken=sekret`)));
    // legacy ?token= param also accepted
    assert(gateAllows(relay, upgradeReq(`${base}?token=sekret`)));
    // no origin + wrong/missing token -> 403
    assertEquals(
      relay.handleUpgrade(upgradeReq(`${base}?scanToken=wrong`)).status,
      403,
    );
    assertEquals(relay.handleUpgrade(upgradeReq(base)).status, 403);
    // a foreign origin is NOT rescued by a valid token (data-pimp semantics)
    assertEquals(
      relay.handleUpgrade(
        upgradeReq(`${base}?scanToken=sekret`, "https://evil.example.com"),
      ).status,
      403,
    );
    return Promise.resolve();
  });
});

Deno.test("SCAN_RELAY_ALLOW_NO_ORIGIN opens the origin-less path", async () => {
  await withRelay({}, { SCAN_RELAY_ALLOW_NO_ORIGIN: "true" }, ({ relay }) => {
    assert(
      gateAllows(relay, upgradeReq("http://relay.example.com/api/scan-socket")),
    );
    return Promise.resolve();
  });
});

Deno.test("relay refuses new sockets at capacity with 503", async () => {
  await withRelay(
    {},
    { SCAN_RELAY_MAX_CLIENTS: "1" },
    async ({ relay, url }) => {
      const first = await WsProbe.connect(url);
      first.send({ type: "hello", role: "scanner", deviceId: "only" });
      // Wait until the server registered the socket (presence broadcast).
      await first.next((m) => m.type === "scanners" && m.count === 1, {
        label: "first client registered",
      });
      const res = relay.handleUpgrade(
        upgradeReq(
          "http://127.0.0.1:1/api/scan-socket",
          "http://localhost:5173",
        ),
      );
      assertEquals(res.status, 503);
      await first.dispose();
    },
  );
});
