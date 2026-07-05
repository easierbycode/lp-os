// Client-side tests: pure helpers plus the ScanRelay class speaking to a
// real relay server over a real socket.

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  BARCODE_RE,
  classifyScan,
  defaultRelayUrl,
  PRODUCT_ID_RE,
  type RelayStatus,
  SCAN_BLE_CHARACTERISTIC,
  SCAN_BLE_SERVICE,
  scanDeviceId,
  scanDeviceName,
  type ScanEvent,
  type ScannerPresence,
  ScanRelay,
  setScanDeviceName,
} from "../client.ts";
import { withRelay, withTimeout } from "./helpers.ts";

Deno.test("classifyScan mirrors the relay's value taxonomy", () => {
  // TikTok product ids: 18-19 digits
  assertEquals(classifyScan("173189175654944429"), "productId"); // 18
  assertEquals(classifyScan("1731891756549444298"), "productId"); // 19
  // Retail barcodes: UPC-A/E, EAN-8/13, ITF-14
  assertEquals(classifyScan("12345678"), "barcode"); // EAN-8 / UPC-E
  assertEquals(classifyScan("036000291452"), "barcode"); // UPC-A (12)
  assertEquals(classifyScan("4006381333931"), "barcode"); // EAN-13
  assertEquals(classifyScan("15400141288763"), "barcode"); // ITF-14
  // Everything else
  assertEquals(classifyScan("123456789"), "other"); // 9 digits
  assertEquals(classifyScan("1234567890"), "other"); // 10 digits
  assertEquals(classifyScan("12345678901234567"), "other"); // 17 digits
  assertEquals(classifyScan("17318917565494442980"), "other"); // 20 digits
  assertEquals(classifyScan("not-a-code"), "other");
  assertEquals(classifyScan(""), "other");

  assert(PRODUCT_ID_RE.test("1731891756549444298"));
  assert(BARCODE_RE.test("036000291452"));
});

Deno.test("BLE GATT identity is unchanged from the deployed hardware", () => {
  assertEquals(SCAN_BLE_SERVICE, "c0de5ca0-ba7c-4de1-9a0d-2b5a3f1c9e01");
  assertEquals(SCAN_BLE_CHARACTERISTIC, "c0de5ca1-ba7c-4de1-9a0d-2b5a3f1c9e01");
});

Deno.test("defaultRelayUrl falls back to the shell's local port outside browsers", () => {
  // No browser location in Deno tests.
  assertEquals(defaultRelayUrl(), "ws://localhost:8000/api/scan-socket");
});

Deno.test("device identity persists and clamps", () => {
  const id = scanDeviceId();
  assertMatch(id, /^scanner-[0-9a-f]{8}$/);
  assertEquals(scanDeviceId(), id); // stable across calls

  setScanDeviceName("  Warehouse Zebra  ");
  assertEquals(scanDeviceName(), "Warehouse Zebra");
  setScanDeviceName("x".repeat(100));
  assertEquals(scanDeviceName().length, 80);
  setScanDeviceName("");
  assertEquals(scanDeviceName(), "");
});

Deno.test("ScanRelay scanner/listener pair: hello, presence, sendScan", async () => {
  await withRelay({}, {}, async ({ url }) => {
    const statuses: RelayStatus[] = [];
    const scanEvents: ScanEvent[] = [];
    let presenceResolve: (p: ScannerPresence) => void;
    const presenceSeen = new Promise<ScannerPresence>((resolve) => {
      presenceResolve = resolve;
    });
    let scanResolve: (e: ScanEvent) => void;
    const scanSeen = new Promise<ScanEvent>((resolve) => {
      scanResolve = resolve;
    });

    const listener = new ScanRelay({
      role: "listener",
      url,
      onStatus: (s) => statuses.push(s),
      onPresence: (p) => {
        if (p.count === 1) presenceResolve(p);
      },
      onScan: (e) => {
        scanEvents.push(e);
        scanResolve(e);
      },
    });
    listener.connect();

    const scanner = new ScanRelay({
      role: "scanner",
      deviceId: "cli-dev",
      name: "Cli Scanner",
      url,
    });
    scanner.connect();

    const presence = await withTimeout(presenceSeen, 3000, "presence count 1");
    assertEquals(presence.devices[0].id, "cli-dev");
    assert(listener.isOpen);
    assert(scanner.isOpen);
    assertEquals(statuses[0], "connecting");
    assert(statuses.includes("open"));

    const sent = scanner.sendScan("036000291452", "upc_a");
    assertEquals(sent.type, "scan");
    assertEquals(sent.deviceId, "cli-dev");
    assert(sent.scanId.length > 0);

    const received = await withTimeout(scanSeen, 3000, "scan delivery");
    assertEquals(received.value, "036000291452");
    assertEquals(received.format, "upc_a");
    assertEquals(received.scanId, sent.scanId);
    assertEquals(received.deviceId, "cli-dev");
    assertEquals(received.deviceName, "Cli Scanner");
    assertEquals(scanEvents.length, 1);

    scanner.close();
    listener.close();
    assert(!scanner.isOpen);
    assert(!listener.isOpen);
  });
});
