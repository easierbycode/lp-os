// Postgres NOTIFY/LISTEN bridge integration test. Skips unless DATABASE_URL
// is set (per repo conventions). Two relay instances share a Pool: a scan on
// relay A must reach a listener on relay B via channel lp_os_scan_relay.
// (Deno's CLI does not expose BroadcastChannel without an unstable flag, so
// in this test the pg bridge is the only cross-instance transport.)

import { assert, assertEquals } from "@std/assert";
import { Pool } from "pg";
import { withRelay, WsProbe } from "./helpers.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

Deno.test({
  name: "pg bridge fans scans and presence across relay instances",
  ignore: !DATABASE_URL,
}, async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 15_000,
  });
  try {
    await withRelay({ pool }, {}, async (a) => {
      await withRelay({ pool }, {}, async (b) => {
        const scanner = await WsProbe.connect(a.url);
        scanner.send({
          type: "hello",
          role: "scanner",
          deviceId: "pg-dev",
          name: "Bridged",
        });
        await scanner.next((m) => m.type === "scanners" && m.count === 1, {
          label: "local presence",
        });

        const listener = await WsProbe.connect(b.url);
        listener.send({ type: "hello", role: "listener" });

        // The LISTEN connection comes up asynchronously; retry until the
        // first bridged scan lands (rate limit default is 40/10s, so the
        // retry budget stays well under it).
        let received: Record<string, unknown> | null = null;
        for (let i = 0; i < 30 && !received; i++) {
          scanner.send({
            type: "scan",
            value: "036000291452",
            format: "ean13",
            scanId: `bridge-${i}`,
          });
          try {
            received = await listener.next((m) => m.type === "scan", {
              timeoutMs: 500,
              label: "bridged scan",
            });
          } catch {
            // bridge not ready yet — try again
          }
        }
        assert(received, "bridged scan never arrived via pg NOTIFY");
        assertEquals(received.value, "036000291452");
        assertEquals(received.deviceId, "pg-dev");

        // Remote presence: a scanner ping republishes presence over the
        // bridge (the hello-time publish may predate B's LISTEN), and relay
        // B rebroadcasts it to its local listeners.
        const mark = listener.mark();
        scanner.send({ type: "ping" });
        await listener.next(
          (m) =>
            m.type === "scanners" && m.count === 1 &&
            (m.devices as { id: string }[]).some((d) => d.id === "pg-dev"),
          { after: mark, timeoutMs: 5000, label: "bridged presence" },
        );
        assertEquals(b.relay.presenceSnapshot().count, 1);
        assertEquals(b.relay.presenceSnapshot().devices[0].id, "pg-dev");

        await scanner.dispose();
        await listener.dispose();
      });
    });
  } finally {
    await pool.end();
  }
});
