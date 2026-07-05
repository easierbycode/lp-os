// Wire-protocol tests: real WebSocket pairs against a relay hosted by
// Deno.serve on an ephemeral port.

import { assert, assertEquals } from "@std/assert";
import { withRelay, WsProbe } from "./helpers.ts";

Deno.test("scanner hello -> listener receives scan with device attribution", async () => {
  await withRelay({}, {}, async ({ url }) => {
    const listener = await WsProbe.connect(url);
    listener.send({ type: "hello", role: "listener", name: "OS Shell" });
    const scanner = await WsProbe.connect(url);
    scanner.send({
      type: "hello",
      role: "scanner",
      deviceId: "dev-1",
      name: "Handheld",
    });
    await listener.next(
      (m) => m.type === "scanners" && m.count === 1,
      { label: "presence count 1" },
    );

    const mark = listener.mark();
    scanner.send({
      type: "scan",
      value: "036000291452",
      format: "ean13",
      scanId: "scan-abc",
    });
    const scan = await listener.next((m) => m.type === "scan", {
      after: mark,
      label: "scan fanout",
    });
    assertEquals(scan.value, "036000291452");
    assertEquals(scan.format, "ean13");
    assertEquals(scan.scanId, "scan-abc");
    assertEquals(scan.deviceId, "dev-1");
    assertEquals(scan.deviceName, "Handheld");
    assert(typeof scan.at === "number");
    // Fanout excludes the publishing socket.
    assertEquals(scanner.scans().length, 0);

    await listener.dispose();
    await scanner.dispose();
  });
});

Deno.test("presence broadcasts, snapshot and kiosk fleet track scanners", async () => {
  await withRelay({}, {}, async ({ url, relay }) => {
    const listener = await WsProbe.connect(url);
    listener.send({ type: "hello", role: "listener" });

    const s1 = await WsProbe.connect(url);
    s1.send({ type: "hello", role: "scanner", deviceId: "dev-1", name: "One" });
    await listener.next(
      (m) =>
        m.type === "scanners" && m.count === 1 &&
        (m.devices as { id: string }[]).some((d) => d.id === "dev-1"),
      { label: "presence count 1" },
    );

    const s2 = await WsProbe.connect(url);
    s2.send({ type: "hello", role: "scanner", deviceId: "dev-2", name: "Two" });
    await listener.next((m) => m.type === "scanners" && m.count === 2, {
      label: "presence count 2",
    });

    const snapshot = relay.presenceSnapshot();
    assertEquals(snapshot.count, 2);
    assertEquals(
      snapshot.devices.map((d) => d.id).sort(),
      ["dev-1", "dev-2"],
    );

    const fleet = relay.kiosks();
    const one = fleet.find((k) => k.id === "dev-1");
    assert(one);
    assertEquals(one.kind, "scanner");
    assertEquals(one.label, "One");
    assertEquals(one.online, true);

    // Listeners never appear in presence.
    assert(!snapshot.devices.some((d) => d.id.includes("listener")));

    const mark = listener.mark();
    await s2.dispose();
    await listener.next((m) => m.type === "scanners" && m.count === 1, {
      after: mark,
      label: "presence back to 1",
    });
    assertEquals(relay.presenceSnapshot().count, 1);

    await s1.dispose();
    await listener.dispose();
  });
});

Deno.test("ping returns pong and refreshes the fleet heartbeat", async () => {
  await withRelay({}, {}, async ({ url, relay }) => {
    const scanner = await WsProbe.connect(url);
    scanner.send({
      type: "hello",
      role: "scanner",
      deviceId: "dev-ping",
      name: "Pinger",
    });
    scanner.send({ type: "ping" });
    await scanner.next((m) => m.type === "pong", { label: "pong" });
    const info = relay.kiosks().find((k) => k.id === "dev-ping");
    assert(info);
    assertEquals(info.online, true);
    await scanner.dispose();
  });
});

Deno.test("per-client rate limiting closes the socket with 1008", async () => {
  await withRelay(
    {},
    { SCAN_RELAY_MAX_SCANS_PER_WINDOW: "2" },
    async ({ url }) => {
      const listener = await WsProbe.connect(url);
      listener.send({ type: "hello", role: "listener" });
      const scanner = await WsProbe.connect(url);
      scanner.send({
        type: "hello",
        role: "scanner",
        deviceId: "dev-rl",
        name: "Rapid",
      });
      await listener.next((m) => m.type === "scanners" && m.count === 1, {
        label: "scanner online",
      });

      scanner.send({ type: "scan", value: "11111111", format: "ean8" });
      scanner.send({ type: "scan", value: "22222222", format: "ean8" });
      scanner.send({ type: "scan", value: "33333333", format: "ean8" });

      const close = await scanner.closed;
      assertEquals(close.code, 1008);

      // Only the first two scans were relayed.
      await listener.next((m) => m.type === "scan" && m.value === "22222222", {
        label: "second scan",
      });
      assertEquals(listener.scans().length, 2);

      await listener.dispose();
    },
  );
});

Deno.test("scan before hello (or from a listener) closes with 1008", async () => {
  await withRelay({}, {}, async ({ url }) => {
    const anon = await WsProbe.connect(url);
    anon.send({ type: "scan", value: "11111111", format: "ean8" });
    assertEquals((await anon.closed).code, 1008);

    const listener = await WsProbe.connect(url);
    listener.send({ type: "hello", role: "listener" });
    listener.send({ type: "scan", value: "11111111", format: "ean8" });
    assertEquals((await listener.closed).code, 1008);
  });
});

Deno.test("malformed frames close with 1003", async () => {
  await withRelay({}, {}, async ({ url }) => {
    const probe = await WsProbe.connect(url);
    probe.ws.send("not json");
    assertEquals((await probe.closed).code, 1003);
  });
});

Deno.test("disabled devices are silently muted until re-enabled", async () => {
  await withRelay({}, {}, async ({ url, relay }) => {
    relay.setKioskDisabled("dev-9", true);

    const listener = await WsProbe.connect(url);
    listener.send({ type: "hello", role: "listener" });
    const scanner = await WsProbe.connect(url);
    scanner.send({
      type: "hello",
      role: "scanner",
      deviceId: "dev-9",
      name: "Muted",
    });
    await listener.next((m) => m.type === "scanners" && m.count === 1, {
      label: "scanner online",
    });

    scanner.send({ type: "scan", value: "11111111", format: "ean8" });
    // Round-trip a ping so the (dropped) scan was definitely processed.
    scanner.send({ type: "ping" });
    await scanner.next((m) => m.type === "pong", { label: "pong" });

    relay.setKioskDisabled("dev-9", false);
    scanner.send({ type: "scan", value: "22222222", format: "ean8" });
    const scan = await listener.next((m) => m.type === "scan", {
      label: "post-enable scan",
    });
    assertEquals(scan.value, "22222222");
    assertEquals(listener.scans().length, 1);

    await listener.dispose();
    await scanner.dispose();
  });
});

Deno.test("scan values are sanitized: control characters cause a silent drop", async () => {
  await withRelay({}, {}, async ({ url }) => {
    const listener = await WsProbe.connect(url);
    listener.send({ type: "hello", role: "listener" });
    const scanner = await WsProbe.connect(url);
    scanner.send({ type: "hello", role: "scanner", deviceId: "dev-s" });
    await listener.next((m) => m.type === "scanners" && m.count === 1, {
      label: "scanner online",
    });

    // Stripping the interior NUL shrinks the value vs its trimmed original,
    // so the scan is dropped silently (data-pimp behavior).
    scanner.send({ type: "scan", value: "1234\u000067", format: "code128" });
    scanner.send({ type: "scan", value: "ok-value", format: "code128" });
    const scan = await listener.next((m) => m.type === "scan", {
      label: "clean scan",
    });
    assertEquals(scan.value, "ok-value");
    assertEquals(scan.format, "code128");
    assertEquals(listener.scans().length, 1);
    // Missing scanId is generated server-side.
    assert(
      typeof scan.scanId === "string" && (scan.scanId as string).length > 0,
    );

    await listener.dispose();
    await scanner.dispose();
  });
});

Deno.test("kiosk heartbeat map: heartbeat, disable, enable, listing", async () => {
  await withRelay({}, {}, ({ relay }) => {
    const beat = relay.heartbeat({ id: "kiosk-1", label: "Front Desk" });
    assertEquals(beat.id, "kiosk-1");
    assertEquals(beat.kind, "kiosk");
    assertEquals(beat.label, "Front Desk");
    assertEquals(beat.disabled, false);
    assertEquals(beat.online, true);

    const off = relay.setKioskDisabled("kiosk-1", true);
    assert(off);
    assertEquals(off.disabled, true);
    assertEquals(off.online, false);

    // Heartbeats do not clear the disable flag.
    assertEquals(relay.heartbeat({ id: "kiosk-1" }).disabled, true);

    const on = relay.setKioskDisabled("kiosk-1", false);
    assert(on);
    assertEquals(on.disabled, false);
    assertEquals(on.online, true);

    // Disabling an unknown id creates the (offline) entry, like data-pimp.
    const ghost = relay.setKioskDisabled("kiosk-ghost", true);
    assert(ghost);
    assertEquals(ghost.disabled, true);
    assertEquals(ghost.lastSeen, 0);

    assertEquals(relay.kiosks().length, 2);
    return Promise.resolve();
  });
});
