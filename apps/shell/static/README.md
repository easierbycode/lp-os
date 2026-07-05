# os.js — changes vs data-pimp

- Rebranded Thirsty OS → LP-OS; globals are now `LPOS_RBAC` / `LPOS_OS_CONFIG`
  (`{memberAppUrl, scannerAppUrl, inventoryAppUrl, graylogBase}`) /
  `LPOS_SCAN_RELAY`, all with standalone-safe fallbacks.
- Multi-instance apps: window ids are `app:<id>#<n>`; `openApp` always creates a
  new window (titles "Name · 2"+, one dock tile each). Folders/browser windows
  stay single-instance. All fixed `windows.get("app:x")` reads became
  `windowsForApp(appId)` (newest-focused first).
- Pin/Save: 📌 button in every app titlebar; pins live in localStorage
  `lpos.pins.v1` as `{app, url, title, at}` and re-open at boot before
  `default_home`. URL captured live for same-origin frames, else launch URL.
- Users, not roles, are selected: `?user=` > localStorage `lpos-os-user` >
  `RBAC.defaultUser`; the taskbar switcher lists users; flags/default_home
  resolve via the user's role.
- Boot layout is generic: role
  `default_home: [["Folder/Item?query", "left"|"right"|"none"], …]`
  (case-insensitive resolution); the hardcoded warehouse block is gone.
  `?workspace=samples-import` E2E still works.
- postMessage source strings ("thirsty-os", "thirsty-scanner", "samples-import")
  are wire protocol shared with deployed apps — do NOT rebrand them.
