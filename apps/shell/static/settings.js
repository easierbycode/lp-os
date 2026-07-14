// LP-OS Settings window — Account, Security, Plan & Billing, Notifications, and
// Team. A vanilla, framework-free port of the Claude Design "LP-OS Settings"
// handoff, rendered inside an os.js window iframe (styles its BODY only).
//
// The Team tab shares the Admin window's model + backend: it loads the live
// config from GET /api/roles (currentUser resolved from the ?user= the shell
// rides along) and the launcher catalog from GET /api/catalog, edits a local
// copy, and persists with POST /api/roles — same flag-resolution rules as
// core/roles.ts / os.js (explicit per-role value wins, else the "*" wildcard,
// else deny). Access is UX gating, not authz (see os.js) — the same caveat here.
//
// Account/Security/Plan/Notifications are per-device UI: Account prefills the
// signed-in user's identity from /api/roles; the rest are local preferences with
// no server backend (a mock-login OS has no auth/billing surface), so their
// Save/Cancel just flash a toast. No password or card value is read, stored, or
// transmitted anywhere — the Change-password inputs are non-functional and the
// Payment card fields are display-only.

(() => {
  "use strict";

  const root = document.getElementById("settings-root");

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  /* ------------------------------------------------------------- icons -- */

  // Lucide line-icon paths used by the notification matrix + center. "C:cx:cy:r"
  // encodes a <circle>; every other entry is a <path d>.
  const LUCIDE = {
    tag: [
      "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
      "C:7.5:7.5:0.5",
    ],
    box: [
      "m7.5 4.27 9 5.15",
      "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
      "M3.29 7 12 12l8.71-5",
      "M12 22V12",
    ],
    cart: [
      "C:8:21:1",
      "C:19:21:1",
      "M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12",
    ],
    scan: [
      "M3 7V5a2 2 0 0 1 2-2h2",
      "M17 3h2a2 2 0 0 1 2 2v2",
      "M21 17v2a2 2 0 0 1-2 2h-2",
      "M7 21H5a2 2 0 0 1-2-2v-2",
      "M7 12h10",
    ],
    trending: ["M16 17h6v-6", "m22 17-8.5-8.5-5 5L2 7"],
    triangle: [
      "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z",
      "M12 9v4",
      "M12 17h.01",
    ],
    monitor: [
      "M3 4h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
      "M8 21h8",
      "M12 17v4",
    ],
    mail: [
      "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
      "m2 7 10 6 10-6",
    ],
    chat: ["M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"],
  };

  function icon(name, o) {
    o = o || {};
    const size = o.size || 18,
      stroke = o.stroke || "currentColor",
      sw = o.sw || 2;
    const kids = (LUCIDE[name] || []).map((d) => {
      if (d[0] === "C") {
        const p = d.split(":");
        return `<circle cx="${+p[1]}" cy="${+p[2]}" r="${+p[3]}"></circle>`;
      }
      return `<path d="${d}"></path>`;
    }).join("");
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="display:block">${kids}</svg>`;
  }

  // Mini folder tile drawn in the Team live preview (gradients in settings.html).
  const FOLDER_SVG =
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 17a4 4 0 0 1 4-4h13.2a4 4 0 0 1 2.9 1.25L31 19h24a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" fill="url(#g-folder-back)"></path><path d="M7 27a3 3 0 0 1 3-3h44a3 3 0 0 1 3 3v21a4 4 0 0 1-4 4H10a3 3 0 0 1-3-3Z" fill="url(#g-folder-front)"></path></svg>`;

  const mix = (color, pct) =>
    `color-mix(in oklab, ${color} ${pct}%, transparent)`;

  /* ------------------------------------------------- fallback seed data -- */
  // Mirrors core/roles.json + core/catalog.ts so the window still renders if the
  // shell APIs are unreachable; a live GET /api/roles + /api/catalog overrides.

  const SEED = () =>
    JSON.parse(JSON.stringify({
      defaultUser: "dj",
      flags: [
        { id: "folder.apps", label: "Apps folder" },
        { id: "folder.demos", label: "Demos folder" },
        { id: "folder.member", label: "Member folder" },
        { id: "app.productAnalysis", label: "Product Analysis app" },
        { id: "app.inventory", label: "Inventory (LP Sample Tracker)" },
        { id: "app.kiosk", label: "Kiosk / checkout" },
        { id: "app.installExtension", label: "Install Extension helper" },
        { id: "app.scanner", label: "Scanner (remote barcode scanner)" },
        { id: "app.graylog", label: "Graylog log search" },
        { id: "app.marketplace", label: "Marketplace listings (eBay)" },
        { id: "app.warehouse", label: "Warehouse (3D dashboard)" },
        { id: "app.admin", label: "Admin (users & roles)" },
        { id: "app.settings", label: "Settings" },
        { id: "ops.debugCounts", label: "Row-count debug endpoint" },
        {
          id: "ops.checkoutAlerts",
          label: "Stakeholder for stale-checkout alerts",
        },
      ],
      roles: [
        { id: "admin", name: "Admin", default_home: [], flags: { "*": true } },
        {
          id: "creator",
          name: "Creator",
          default_home: [["Member/App", "left"], ["Member/Web", "right"]],
          flags: { "folder.member": true },
        },
        {
          id: "warehouse",
          name: "Warehouse",
          default_home: [["Apps/Inventory?status=cleared_to_sell", "left"], [
            "Apps/Kiosk",
            "right",
          ]],
          flags: {
            "folder.apps": true,
            "app.inventory": true,
            "app.kiosk": true,
            "app.installExtension": true,
            "app.scanner": true,
            "app.marketplace": true,
            "app.warehouse": true,
            "app.graylog": false,
            "app.productAnalysis": false,
            "folder.demos": false,
            "folder.member": false,
            "ops.debugCounts": false,
            "ops.checkoutAlerts": true,
          },
        },
      ],
      users: [
        {
          id: "dj",
          name: "DJ",
          role: "admin",
          email: "daniel@lifepreneur.com",
        },
        { id: "ka", name: "Karl", role: "warehouse", email: "" },
        {
          id: "@boosteddealsdaily",
          name: "@boosteddealsdaily",
          role: "creator",
          email: "",
        },
      ],
    }));

  const FALLBACK_CATALOG = [
    {
      id: "apps",
      name: "Apps",
      flag: "folder.apps",
      items: [
        {
          id: "product-analysis",
          name: "Product Analysis",
          flag: "app.productAnalysis",
        },
        { id: "inventory", name: "Inventory", flag: "app.inventory" },
        { id: "kiosk", name: "Kiosk", flag: "app.kiosk" },
        { id: "scanner", name: "Scanner", flag: "app.scanner" },
        { id: "graylog", name: "Graylog", flag: "app.graylog" },
        {
          id: "install-extension",
          name: "Install Extension",
          flag: "app.installExtension",
        },
        { id: "marketplace", name: "Marketplace", flag: "app.marketplace" },
        { id: "warehouse", name: "Warehouse", flag: "app.warehouse" },
        { id: "admin", name: "Admin", flag: "app.admin" },
        { id: "settings", name: "Settings", flag: "app.settings" },
      ],
    },
    {
      id: "demos",
      name: "Demos",
      flag: "folder.demos",
      items: [
        { id: "sample-valuation", name: "Sample Valuation" },
        { id: "samples", name: "Samples" },
        { id: "samples-import", name: "Samples-Import" },
        { id: "e2e", name: "E2E" },
        { id: "ebay-pricing", name: "eBay Pricing" },
        { id: "content-by-sample", name: "Content by Sample" },
      ],
    },
    {
      id: "member",
      name: "Member",
      flag: "folder.member",
      items: [
        { id: "tokscrape-dashboard", name: "App" },
        { id: "member-web", name: "Web" },
        { id: "lifepreneur", name: "LP" },
      ],
    },
  ];

  /* -------------------------------------------------------------- state -- */

  const npDefault = () => ({
    alerts: {
      marketplaceTx: { desktop: true, email: true, sms: false },
      inventoryOverdue: { desktop: true, email: true, sms: false },
      staleCheckout: { desktop: true, email: true, sms: true },
      scannerOffline: { desktop: true, email: false, sms: false },
      lowStock: { desktop: false, email: true, sms: false },
      syncError: { desktop: true, email: false, sms: false },
    },
    digest: "weekly",
    product: true,
    security: true,
    quiet: false,
  });

  const np0 = npDefault();
  let CATALOG = FALLBACK_CATALOG;
  const seededModel = SEED();

  const state = {
    tab: "account", // account | security | plan | notifications | team
    me: "dj", // signed-in user id (from /api/roles currentUser)
    account: {
      name: "Daniel Whitfield",
      username: "dj",
      title: "Founder & Operator",
      company: "Lifepreneur",
      about:
        "Operator building the LP-OS stack — sourcing, sample tracking, and marketplace ops under one roof.",
      email: "daniel@lifepreneur.com",
      phone: "(512) 555-0147",
      country: "United States",
      tz: "Central (US) · CT",
    },
    sec2fa: true,
    secRotate: false,
    planSel: "studio",
    np: np0,
    npSaved: JSON.stringify(np0),
    clockShort: "",
    status: "",
    statusOn: false,
    _t: 0,
    // Team model (loaded from /api/roles; falls back to SEED).
    t: {
      model: seededModel,
      saved: JSON.stringify(seededModel),
      panel: "role",
      roleId: "warehouse",
      confirm: null,
      drag: null,
      over: null,
      addTo: null,
      draftName: "",
      draftEmail: "",
      newRole: false,
      newRoleName: "",
      nfPrefix: "app.",
      nfLabel: "",
      // Only true once a real GET /api/roles is applied. While false the Team
      // editor stays hidden so a transient API blip can't let a Save overwrite
      // core/roles.json with the hardcoded SEED fallback (nor mis-resolve the
      // self-lockout guard against the seed identity).
      loaded: false,
    },
  };

  /* -------------------------------------------------- team pure helpers -- */

  const T = () => state.t;
  const model = () => state.t.model;
  const roleById = (id) => model().roles.find((r) => r.id === id) || null;
  const role = () => roleById(T().roleId) || model().roles[0];
  const dirty = () => JSON.stringify(model()) !== T().saved;

  function resolve(flags, id) {
    const e = flags[id];
    if (typeof e === "boolean") return e;
    return flags["*"] === true;
  }
  function allows(r, flag) {
    if (!flag) return true;
    if (!r || !r.flags) return false;
    return resolve(r.flags, flag);
  }
  function visible(r) {
    return CATALOG
      .map((f) => ({ ...f, items: f.items.filter((i) => allows(r, i.flag)) }))
      .filter((f) => allows(r, f.flag) && f.items.length > 0);
  }
  function totalLaunchers() {
    return CATALOG.reduce((n, f) => n + f.items.length, 0);
  }
  function allowedApps(r) {
    return visible(r).flatMap((f) =>
      f.items.map((i) => ({
        name: i.name,
        folder: f.name,
        ref: f.name + "/" + i.name,
      }))
    );
  }
  const PRESET = { admin: "#f5b73c", creator: "#f472b6", warehouse: "#4fc3a1" };
  const EXTRA = ["#5b9bd5", "#a78bfa", "#38bdf8", "#fb7185"];
  function roleColor(id) {
    if (PRESET[id]) return PRESET[id];
    const idx = model().roles.findIndex((r) => r.id === id);
    return EXTRA[Math.max(0, idx) % EXTRA.length];
  }
  function myRoleId() {
    const me = model().users.find((u) => u.id === state.me);
    return me ? me.role : (model().roles[0] && model().roles[0].id) || "";
  }
  function initials(name) {
    const t = String(name || "").replace(/^@/, "").trim();
    if (!t) return "?";
    const parts = t.split(/\s+/);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : t.slice(0, 2);
    return s.toUpperCase();
  }
  function uniq(id, taken) {
    let x = id, n = 2;
    while (taken.includes(x)) {
      x = id + "-" + n;
      n++;
    }
    return x;
  }
  function userIdFor(name) {
    const t = String(name || "").trim();
    if (!t) return "…";
    const base = t.startsWith("@")
      ? t.toLowerCase().replace(/\s+/g, "")
      : (t.split(/\s+/).map((w) => w[0]).join("").toLowerCase().slice(0, 3) ||
        "u");
    return uniq(base, model().users.map((u) => u.id));
  }
  function camelId(prefix, label) {
    const words = String(label || "").trim().split(/[^a-zA-Z0-9]+/).filter(
      Boolean,
    );
    if (!words.length) return prefix + "…";
    const cam = words
      .map((w, i) =>
        i === 0
          ? w.toLowerCase()
          : w[0].toUpperCase() + w.slice(1).toLowerCase()
      )
      .join("");
    return prefix + cam;
  }
  function setHome(r, side, ref) {
    const others = (r.default_home || []).filter((e) => e[1] !== side);
    const mine = ref ? [[ref, side]] : [];
    r.default_home = others.concat(mine)
      .sort((x, y) => (x[1] === "left" ? 0 : 1) - (y[1] === "left" ? 0 : 1));
  }
  function clockShort() {
    return new Date().toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /* ------------------------------------------------------- small builders -- */

  function toggle(on, attrs, aria, locked, mini) {
    const cls = "toggle" + (mini ? " mini" : "") + (on ? " on" : "") +
      (locked ? " locked" : "");
    return `<button class="${cls}" ${attrs}${
      locked ? " disabled" : ""
    } aria-label="${esc(aria)}"><span class="knob"></span></button>`;
  }
  function opts(list, sel) {
    return list.map((o) =>
      `<option value="${esc(o)}"${o === sel ? " selected" : ""}>${
        esc(o)
      }</option>`
    ).join("");
  }

  /* ---------------------------------------------------------- ACCOUNT -- */

  function accountHTML() {
    const a = state.account;
    const meUser = model().users.find((u) => u.id === state.me);
    // The header shows the signed-in identity, kept independent of the editable
    // form fields below — so typing in the form never leaves the header stale
    // (its values only change when a real /api/roles identity is loaded).
    const headerName = (meUser && meUser.name) || a.name;
    const headerEmail = (meUser && meUser.email) || a.email;
    const roleName = meUser
      ? ((roleById(meUser.role) || {}).name || meUser.role)
      : "";
    const metaLine = [headerEmail, roleName].filter(Boolean).join(" · ");
    return `<div class="panel account">
      <div class="acct-id">
        <span class="acct-av">${esc(initials(headerName))}</span>
        <div class="acct-id-body">
          <div class="acct-name">${esc(headerName)}</div>
          <div class="acct-meta">${esc(metaLine)}</div>
        </div>
        <button class="btn-ghost" data-action="acct-photo">Change photo</button>
      </div>
      <div class="rule"></div>
      <div><div class="sec-head-title">Profile</div><div class="sec-head-sub">Shown on your Lifepreneur creator page and to your team.</div></div>
      <div class="grid-2">
        <label class="field-label"><span class="lbl">Full name</span><input class="input" data-action="acct" data-field="name" data-focus="acct-name" value="${
      esc(a.name)
    }"></label>
        <label class="field-label"><span class="lbl">Username</span><span class="affix"><span class="prefix">lifepreneur.com/</span><input data-action="acct" data-field="username" data-focus="acct-username" value="${
      esc(a.username)
    }"></span></label>
        <label class="field-label"><span class="lbl">Title</span><input class="input" data-action="acct" data-field="title" data-focus="acct-title" value="${
      esc(a.title)
    }"></label>
        <label class="field-label"><span class="lbl">Company</span><input class="input" data-action="acct" data-field="company" data-focus="acct-company" value="${
      esc(a.company)
    }"></label>
        <label class="field-label span-2"><span class="lbl">About</span><textarea class="textarea" rows="3" data-action="acct" data-field="about" data-focus="acct-about">${
      esc(a.about)
    }</textarea></label>
      </div>
      <div class="rule"></div>
      <div><div class="sec-head-title">Contact</div><div class="sec-head-sub">Kept private — used for account and billing notices only.</div></div>
      <div class="grid-2">
        <label class="field-label"><span class="lbl">Email</span><input class="input" data-action="acct" data-field="email" data-focus="acct-email" value="${
      esc(a.email)
    }"></label>
        <label class="field-label"><span class="lbl">Phone</span><input class="input" data-action="acct" data-field="phone" data-focus="acct-phone" value="${
      esc(a.phone)
    }"></label>
        <label class="field-label"><span class="lbl">Country</span><select class="pick" data-action="acct" data-field="country">${
      opts(
        ["United States", "Canada", "United Kingdom", "Australia"],
        a.country,
      )
    }</select></label>
        <label class="field-label"><span class="lbl">Time zone</span><select class="pick" data-action="acct" data-field="tz">${
      opts(
        ["Central (US) · CT", "Eastern (US) · ET", "Pacific (US) · PT"],
        a.tz,
      )
    }</select></label>
      </div>
      <div class="form-actions"><button class="btn-ghost" data-action="form-cancel">Cancel</button><button class="btn-primary" data-action="form-save">Save changes</button></div>
    </div>`;
  }

  /* --------------------------------------------------------- SECURITY -- */

  function secToggleRow(key, label, desc) {
    return `<div class="pref-row"><div class="pref-body"><div class="pref-label">${
      esc(label)
    }</div><div class="pref-desc">${esc(desc)}</div></div>${
      toggle(
        state[key],
        `data-action="sec-toggle" data-field="${key}"`,
        label,
        false,
      )
    }</div>`;
  }
  function securityHTML() {
    return `<div class="panel security">
      <div><div class="sec-head-title">Change password</div><div class="sec-head-sub">Use at least 10 characters with a number and a symbol.</div></div>
      <div class="pw-stack">
        <label class="field-label"><span class="lbl">Current password</span><input class="input" type="password" autocomplete="current-password" placeholder="Enter your current password"></label>
        <label class="field-label"><span class="lbl">New password</span><input class="input" type="password" autocomplete="new-password" placeholder="Enter a new password"></label>
        <label class="field-label"><span class="lbl">Confirm new password</span><input class="input" type="password" autocomplete="new-password" placeholder="Re-enter the new password"></label>
      </div>
      <div class="rule"></div>
      <div><div class="sec-head-title">Security preferences</div></div>
      ${
      secToggleRow(
        "sec2fa",
        "Two-factor authentication",
        "Require a one-time code from your authenticator app on every sign-in.",
      )
    }
      ${
      secToggleRow(
        "secRotate",
        "Rotate password every 90 days",
        "Prompt for a new password quarterly. Recommended for shared workstations.",
      )
    }
      <div class="form-actions"><button class="btn-ghost" data-action="form-cancel">Cancel</button><button class="btn-primary" data-action="form-save">Save changes</button></div>
    </div>`;
  }

  /* --------------------------------------------------- PLAN & BILLING -- */

  function planHTML() {
    const plans = [
      [
        "starter",
        "Starter",
        "1 seat. Personal sourcing + sample tracking.",
        "$12",
        "/ mo",
      ],
      [
        "studio",
        "Studio",
        "Up to 10 seats. Roles, kiosk, and marketplace ops.",
        "$29",
        "/ mo",
      ],
      [
        "enterprise",
        "Enterprise",
        "Unlimited seats, SSO, and priority relay.",
        "$79",
        "/ mo",
      ],
    ];
    const cards = plans.map(([v, label, details, price, unit]) =>
      `<button class="plan-card${
        state.planSel === v ? " sel" : ""
      }" data-action="plan-sel" data-plan="${v}"><span class="plan-check">✓</span><span class="plan-name">${
        esc(label)
      }</span><span class="plan-details">${
        esc(details)
      }</span><span class="plan-price"><b>${esc(price)}</b><span> ${
        esc(unit)
      }</span></span></button>`
    ).join("");
    return `<div class="panel plan">
      <div><div class="sec-head-title">Your plan</div><div class="sec-head-sub">Seats cover everyone in the Team tab. Change anytime — prorated to your cycle.</div></div>
      <div class="plan-grid">${cards}</div>
      <div class="rule"></div>
      <div><div class="sec-head-title">Payment method</div><div class="sec-head-sub">Billed monthly on the 1st. Next charge Aug 1.</div></div>
      <div class="grid-2">
        <label class="field-label span-2"><span class="lbl">Cardholder</span><input class="input" value="${
      esc(state.account.name)
    }" readonly></label>
        <label class="field-label"><span class="lbl">Card number</span><input class="input mono" value="•••• •••• •••• 4471" readonly></label>
        <div class="grid-2">
          <label class="field-label"><span class="lbl">Expiry</span><input class="input" value="09 / 27" readonly></label>
          <label class="field-label"><span class="lbl">CVC</span><input class="input" value="•••" readonly></label>
        </div>
      </div>
      <div class="form-actions"><span class="muted-note">Invoices are emailed to ${
      esc(state.account.email)
    }.</span><span class="spacer"></span><button class="btn-ghost" data-action="form-cancel">Cancel</button><button class="btn-primary" data-action="form-save">Save changes</button></div>
    </div>`;
  }

  /* --------------------------------------------------- NOTIFICATIONS -- */

  const ALERT_DEFS = [
    [
      "marketplaceTx",
      "Marketplace transactions",
      "An eBay listing sells or a buyer sends an offer.",
      "tag",
      "#f5b73c",
    ],
    [
      "inventoryOverdue",
      "Inventory overdue",
      "A sample passes its cleared-to-sell deadline.",
      "box",
      "#4fc3a1",
    ],
    [
      "staleCheckout",
      "Stale checkout alerts",
      "A kiosk sale sits unconfirmed past the threshold.",
      "cart",
      "#5b9bd5",
    ],
    [
      "scannerOffline",
      "Scanner offline",
      "A paired barcode scanner drops its connection.",
      "scan",
      "#a78bfa",
    ],
    [
      "lowStock",
      "Low stock",
      "A product dips below its reorder point.",
      "trending",
      "#f5832e",
    ],
    [
      "syncError",
      "Sync & log errors",
      "A background job fails or Graylog error-rate spikes.",
      "triangle",
      "#f87171",
    ],
  ];
  const CHANS = ["desktop", "email", "sms"];

  function notificationsHTML() {
    const head = `<div class="n-head n-grid">
      <span class="n-head-event">Event</span>
      <span class="n-chan"><span class="ic">${
      icon("monitor", { size: 16, stroke: "#99a2af" })
    }</span><span class="cap">Desktop</span></span>
      <span class="n-chan"><span class="ic">${
      icon("mail", { size: 16, stroke: "#99a2af" })
    }</span><span class="cap">Email</span></span>
      <span class="n-chan"><span class="ic">${
      icon("chat", { size: 16, stroke: "#99a2af" })
    }</span><span class="cap">SMS</span></span>
    </div>`;
    const rows = ALERT_DEFS.map(([id, label, desc, ic, color]) => {
      const cells = CHANS.map((ch) =>
        `<div class="n-cell">${
          toggle(
            state.np.alerts[id][ch],
            `data-action="n-alert" data-alert="${id}" data-chan="${ch}"`,
            label + " " + ch,
            false,
          )
        }</div>`
      ).join("");
      return `<div class="n-row n-grid">
        <div class="n-event"><span class="n-ic" style="background:${
        mix(color, 20)
      }">${
        icon(ic, { size: 17, stroke: color })
      }</span><div style="min-width:0"><div class="n-label">${
        esc(label)
      }</div><div class="n-desc">${esc(desc)}</div></div></div>
        ${cells}
      </div>`;
    }).join("");

    const digest = [["off", "Off"], ["daily", "Daily"], ["weekly", "Weekly"]]
      .map(([v, label]) =>
        `<button class="seg-btn${
          state.np.digest === v ? " on" : ""
        }" data-action="n-digest" data-digest="${v}">${label}</button>`
      ).join("");

    const extras = [
      ["product", "Product updates", "New LP-OS apps and features."],
      ["security", "Security notices", "Sign-ins and role changes."],
      [
        "quiet",
        "Quiet hours (10pm–7am)",
        "Hold non-critical alerts overnight.",
      ],
    ].map(([key, label, desc]) =>
      `<div class="n-extra-row"><div style="flex:1;min-width:0"><div class="n-extra-label">${
        esc(label)
      }</div><div class="n-extra-desc">${esc(desc)}</div></div>${
        toggle(
          state.np[key],
          `data-action="n-extra" data-field="${key}"`,
          label,
          false,
        )
      }</div>`
    ).join("");

    return `<div class="panel notifications">
      <div><div class="sec-head-title">Operations alerts</div><div class="sec-head-sub">Choose how each LP-OS app reaches you. Alerts show live in the notification center — the bell in your taskbar.</div></div>
      <div class="n-card">${head}${rows}</div>
      <div class="n-two">
        <div class="n-digest">
          <div class="n-digest-title">Summary digest</div>
          <div class="n-digest-sub">A roll-up of everything above, on a schedule.</div>
          <div class="seg">${digest}</div>
        </div>
        <div class="n-extra">${extras}</div>
      </div>
      <div class="form-actions"><button class="link-btn" data-action="nc-open">Open notification center →</button><span class="spacer"></span><button class="btn-ghost" data-action="n-cancel">Reset</button><button class="btn-primary" data-action="n-save">Save preferences</button></div>
    </div>`;
  }

  /* -------------------------------------------------------------- TEAM -- */

  function buildGroups(r) {
    const wildcardOn = r.flags["*"] === true;
    const defs = [
      { key: "folder.", name: "Folders" },
      { key: "app.", name: "Apps" },
      { key: "ops.", name: "Operations" },
    ];
    const groups = defs.map((d) => ({ name: d.name, rows: [] }));
    const other = { name: "Other", rows: [] };
    model().flags.forEach((f) => {
      const explicit = typeof r.flags[f.id] === "boolean";
      const on = resolve(r.flags, f.id);
      const gi = defs.findIndex((d) => f.id.startsWith(d.key));
      const g = gi >= 0 ? groups[gi] : other;
      g.rows.push({
        label: f.label,
        id: f.id,
        explicit,
        on,
        srcText: wildcardOn ? "on via Everything" : "off by default",
      });
    });
    if (other.rows.length) groups.push(other);
    return groups.filter((g) => g.rows.length);
  }
  function inspGroupHTML(g) {
    const rows = g.rows.map((row) =>
      `<div class="cap-row" title="${esc(row.id)}">
        <span class="cap-row-label">${esc(row.label)}</span>
        ${
        row.explicit
          ? `<button class="cap-clear" data-action="t-clear-flag" data-id="${
            esc(row.id)
          }" title="Clear override">set ✕</button>`
          : ""
      }
        ${
        toggle(
          row.on,
          `data-action="t-flag" data-id="${esc(row.id)}"`,
          row.label,
          false,
          true,
        )
      }
      </div>`
    ).join("");
    return `<div class="cap-group-name">${
      esc(g.name)
    }</div><div class="cap-card">${rows}</div>`;
  }
  // Boot-layout dropdowns (LEFT / RIGHT). Options are the apps this role can
  // open; the option value carries any query string on the current entry so it
  // stays selected. "— None —" clears the slot.
  function slotsSelectHTML(r) {
    const allowed = allowedApps(r);
    return ["left", "right"].map((side) => {
      const entry = (r.default_home || []).find((e) => e[1] === side);
      const ref = entry ? entry[0] : "";
      const base = ref.split("?")[0];
      const options = allowed.map((x) => ({
        name: x.folder + " / " + x.name,
        value: (base === x.ref && ref !== x.ref) ? ref : x.ref,
      }));
      if (ref && !options.some((o) => o.value === ref)) {
        options.push({
          name: (base.split("/")[1] || base) + " (hidden)",
          value: ref,
        });
      }
      const missing = !!ref && !allowed.some((x) => x.ref === base);
      const optionsHtml =
        `<option value=""${ref === "" ? " selected" : ""}>— None —</option>` +
        options.map((o) =>
          `<option value="${esc(o.value)}"${
            o.value === ref ? " selected" : ""
          }>${esc(o.name)}</option>`
        ).join("");
      return `<div class="boot-slot">
        <span class="boot-slot-side">${
        side === "left" ? "LEFT" : "RIGHT"
      }</span>
        <select class="select boot-slot-select" data-action="t-slot" data-side="${side}" aria-label="${
        side === "left" ? "Left" : "Right"
      } boot app">${optionsHtml}</select>
      </div>${
        missing
          ? `<div class="boot-slot-missing">Hidden for this role — grant its flag or pick another.</div>`
          : ""
      }`;
    }).join("");
  }

  // Kanban of role columns; each member is a draggable card, and dropping one
  // onto another column reassigns that user's role.
  function columnsHTML() {
    return model().roles.map((r) => {
      const inspected = T().panel === "role" && r.id === T().roleId;
      const color = roleColor(r.id);
      const users = model().users.filter((u) => u.role === r.id);
      const cards = users.map((u) => {
        const confirming = T().confirm === "cuser:" + u.id;
        const isYou = u.id === state.me;
        return `<div class="member-card" draggable="true" data-drag-user="${
          esc(u.id)
        }">
          <div class="member-top">
            <span class="avatar xs" style="background:${
          mix(color, 22)
        };color:${color}">${esc(initials(u.name))}</span>
            <span class="member-name">${esc(u.name)}</span>
            ${isYou ? `<span class="badge-you">you</span>` : ""}
            ${
          isYou
            ? ""
            : `<button class="card-remove${
              confirming ? " confirming" : ""
            }" data-action="t-card-remove" data-id="${
              esc(u.id)
            }" title="Remove user">${confirming ? "sure?" : "✕"}</button>`
        }
          </div>
          <div class="member-sub">${esc(u.email || u.id)}</div>
        </div>`;
      }).join("");
      const adding = T().addTo === r.id;
      const empty = users.length === 0 && !adding;
      const addBlock = adding
        ? `<div class="add-member">
            <input class="am-input" data-action="t-draft-name" data-focus="t-draft-name" value="${
          esc(T().draftName)
        }" placeholder="Name (or @handle)">
            <input class="am-input" data-action="t-draft-email" data-focus="t-draft-email" value="${
          esc(T().draftEmail)
        }" placeholder="Email (optional)">
            <div class="am-actions"><button class="btn-primary sm" data-action="t-add-confirm" data-id="${
          esc(r.id)
        }">Add</button><button class="am-cancel" data-action="t-add-cancel">Cancel</button></div>
          </div>`
        : `<button class="add-open" data-action="t-add-open" data-id="${
          esc(r.id)
        }">+ Add to ${esc(r.name)}</button>`;
      return `<div class="role-col${
        inspected ? " inspected" : ""
      }" data-drop-role="${esc(r.id)}">
        <button class="role-col-head" data-action="t-inspect" data-id="${
        esc(r.id)
      }">
          <span class="dot" style="background:${color}"></span>
          <span class="role-col-name">${esc(r.name)}</span>
          <span class="role-col-count">${users.length}</span>
          <span class="role-col-edit${inspected ? " on" : ""}">Edit ›</span>
        </button>
        <div class="role-col-body">
          ${cards}
          ${empty ? `<div class="col-empty">Drag someone here</div>` : ""}
          ${addBlock}
        </div>
      </div>`;
    }).join("");
  }

  function newRoleColumnHTML() {
    if (!T().newRole) {
      return `<button class="new-role-col" data-action="t-newrole-open">+ New role</button>`;
    }
    return `<div class="new-role-edit">
      <input class="nr-input" data-action="t-newrole-name" data-focus="t-newrole-name" value="${
      esc(T().newRoleName)
    }" placeholder="Role name">
      <div class="nr-hint">Starts with nothing granted — an empty desktop.</div>
      <div class="nr-actions"><button class="btn-primary sm" data-action="t-newrole-create">Create</button><button class="am-cancel" data-action="t-newrole-cancel">Cancel</button></div>
    </div>`;
  }
  // Slim desktop preview for the inspector (no members list — the columns are
  // the roster now).
  function slimPreviewHTML(r) {
    const vis = visible(r);
    const nItems = vis.reduce((n, f) => n + f.items.length, 0);
    const home = r.default_home || [];
    const left = home.find((e) => e[1] === "left");
    const right = home.find((e) => e[1] === "right");
    const nameOf = (e) => {
      if (!e) return "";
      const base = e[0].split("?")[0];
      return base.split("/")[1] || base;
    };
    const lockedOut = vis.length === 0;
    let caption;
    if (lockedOut) {
      caption = "Sees nothing — every folder is hidden. A locked-out profile.";
    } else {
      const boot = (left || right)
        ? "Boots with " +
          [
            left && (nameOf(left) + " (left)"),
            right && (nameOf(right) + " (right)"),
          ].filter(Boolean).join(" + ")
        : "Boots to an empty desktop";
      caption = boot + " · sees " + vis.length + " of " + CATALOG.length +
        " folders · " + nItems + " of " + totalLaunchers() + " launchers.";
    }
    const folders = vis.map((f) =>
      `<div class="screen-folder">${FOLDER_SVG}<span>${
        esc(f.name)
      }</span></div>`
    ).join("");
    const dots =
      `<i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>`;
    const pane = (side, name) =>
      `<div class="screen-pane ${side}"><div class="screen-pane-bar">${dots}</div><div class="screen-pane-name">${
        esc(name)
      }</div></div>`;
    return `<div class="screen">
        <div class="screen-folders">${folders}</div>
        ${left ? pane("left", nameOf(left)) : ""}
        ${right ? pane("right", nameOf(right)) : ""}
        <div class="screen-taskbar"><span class="mark">◆</span><span class="name">LP-OS</span><span class="spacer"></span><span class="clk js-clock">${
      esc(clockShort())
    }</span></div>
      </div>
      <div class="insp-caption${lockedOut ? " locked" : ""}">${
      esc(caption)
    }</div>`;
  }

  // Inspector, role mode: rename/delete, live preview, capability toggles, and
  // the boot-layout dropdowns for the selected role.
  function rolePanelHTML() {
    const r = role();
    if (!r) return `<div class="insp-empty">Select a role to inspect.</div>`;
    const mine = r.id === myRoleId();
    const color = roleColor(r.id);
    const members = model().users.filter((u) => u.role === r.id).length;
    const delDisabled = members > 0 || mine;
    const delConfirming = T().confirm === "role:" + r.id;
    const delHint = mine
      ? "You're signed in with this role"
      : members > 0
      ? `Move its ${members} member${
        members > 1 ? "s" : ""
      } to another role first`
      : "Removes the role from roles.json";
    const wildcardOn = r.flags["*"] === true;
    const wcHint = mine
      ? "Locked — it's the role you're signed in with"
      : wildcardOn
      ? "Turn off to start from nothing"
      : "Turn on to grant everything";
    return `
      <div class="insp-role-head">
        <span class="dot" style="background:${color}"></span>
        <input class="inline-input insp-role-name" data-action="t-role-name" data-focus="t-role-name" value="${
      esc(r.name)
    }" aria-label="Role name">
        <button class="btn-remove xs danger${
      delConfirming ? " confirming" : ""
    }" data-action="t-del-role"${delDisabled ? " disabled" : ""} title="${
      esc(delHint)
    }">${delConfirming ? "Confirm" : "Delete"}</button>
      </div>
      <div class="insp-role-id">${esc(r.id)}</div>
      ${
      mine
        ? `<div class="banner-warn sm">Your own role — Everything stays on so you can't lock yourself out.</div>`
        : ""
    }
      ${slimPreviewHTML(r)}
      <div class="insp-label">Capabilities</div>
      <div class="cap-wildcard">
        <div class="cap-wildcard-body"><span class="cap-wild-title">Everything</span> <span class="cap-wild-star">*</span></div>
        ${
      toggle(
        wildcardOn,
        `data-action="t-wildcard" title="${esc(wcHint)}"`,
        "Everything",
        mine,
        true,
      )
    }
      </div>
      ${buildGroups(r).map(inspGroupHTML).join("")}
      <div class="insp-label">Boot layout</div>
      ${slotsSelectHTML(r)}`;
  }

  // Inspector, flags mode: rename/remove capability flags and add new ones.
  function flagsPanelHTML() {
    const rows = model().flags.map((f) => {
      const confirming = T().confirm === "flag:" + f.id;
      const granted = grantedBy(f);
      return `<div class="flagx-card">
        <div class="flagx-top">
          <input class="inline-input flagx-label" data-action="t-flag-label" data-id="${
        esc(f.id)
      }" data-focus="t-flag-label:${esc(f.id)}" value="${
        esc(f.label)
      }" aria-label="Flag label">
          <button class="btn-remove xs${
        confirming ? " confirming" : ""
      }" data-action="t-remove-flag" data-id="${esc(f.id)}">${
        confirming ? "Confirm?" : "Remove"
      }</button>
        </div>
        <div class="flagx-id">${esc(f.id)}</div>
        <div class="flagx-granted">${esc(granted)}</div>
      </div>`;
    }).join("");
    return `
      <div class="insp-flags-head">
        <span class="insp-flags-title">Capability flags</span>
        <button class="insp-close" data-action="t-toggle-flags" aria-label="Back to role">×</button>
      </div>
      <div class="insp-flags-sub">Every folder and app declares one of these. Roles grant them.</div>
      ${rows}
      <div class="flagx-add">
        <div class="flagx-add-row">
          <select class="select mono" data-action="t-nf-prefix" aria-label="Flag prefix">
            <option value="app."${
      T().nfPrefix === "app." ? " selected" : ""
    }>app.</option>
            <option value="folder."${
      T().nfPrefix === "folder." ? " selected" : ""
    }>folder.</option>
            <option value="ops."${
      T().nfPrefix === "ops." ? " selected" : ""
    }>ops.</option>
          </select>
          <input class="field-sm grow" data-action="t-nf-label" data-focus="t-nf-label" value="${
      esc(T().nfLabel)
    }" placeholder="Label">
        </div>
        <div class="flagx-add-row2"><span class="id-preview">${
      esc(camelId(T().nfPrefix, T().nfLabel))
    }</span><button class="btn-primary sm" data-action="t-add-flag">Add flag</button></div>
      </div>`;
  }

  function grantedBy(f) {
    const list = model().roles.map((r) => {
      const e = r.flags[f.id];
      if (e === true) return r.name;
      if (e === false) return null;
      return r.flags["*"] === true ? r.name + " (via *)" : null;
    }).filter(Boolean);
    return list.length
      ? "Granted to " + list.join(" · ")
      : "No role grants this yet";
  }
  function teamHTML() {
    // The Team tab is the only one backed by roles.json. If the config didn't
    // load, refuse to render an editable seed so a Save can't clobber the real
    // file — the other tabs keep working. Mirrors admin.js's hard-stop.
    if (!T().loaded) {
      return `<div class="panel team"><div class="team-sub">Couldn't load the roles config — the shell API didn't answer. The People &amp; Access editor is hidden so it can't overwrite <span class="mono">core/roles.json</span> with defaults. The other Settings tabs still work; reopen Settings to retry.</div></div>`;
    }
    const flagsOn = T().panel === "flags";
    return `<div class="panel team">
      <div class="team-console">
        <div class="team-head">
          <span class="team-head-title">People &amp; Access</span>
          <span class="team-src">core/roles.json</span>
          <span class="spacer"></span>
          <button class="team-flags-btn${
      flagsOn ? " on" : ""
    }" data-action="t-toggle-flags">Capability flags</button>
        </div>
        <div class="team-body">
          <div class="team-columns">${columnsHTML()}${newRoleColumnHTML()}</div>
          <div class="team-inspector">${
      flagsOn ? flagsPanelHTML() : rolePanelHTML()
    }</div>
        </div>
      </div>
    </div>`;
  }

  /* --------------------------------------------------- shell chrome -- */

  function tabsHTML() {
    const defs = [
      ["account", "Account"],
      ["security", "Security"],
      ["plan", "Plan & Billing"],
      ["notifications", "Notifications"],
      ["team", "Team"],
    ];
    return defs.map(([id, label]) =>
      `<button class="set-tab${
        state.tab === id ? " is-active" : ""
      }" data-action="tab" data-tab="${id}">${esc(label)}</button>`
    ).join("");
  }
  function saveBarHTML() {
    if (state.tab !== "team" || !T().loaded || !dirty()) return "";
    return `<div class="savebar">
      <span class="savebar-dot"></span>
      <span class="savebar-text">Unsaved changes — saving rewrites <span class="mono">core/roles.json</span> for everyone on this OS.</span>
      <span class="spacer"></span>
      <button class="btn-ghost sm" data-action="t-revert">Revert</button>
      <button class="btn-primary sm" data-action="t-save">Save changes</button>
    </div>`;
  }
  function toastHTML() {
    return `<div class="toast${state.statusOn ? " show" : ""}">${
      esc(state.status)
    }</div>`;
  }
  function panelHTML() {
    switch (state.tab) {
      case "security":
        return securityHTML();
      case "plan":
        return planHTML();
      case "notifications":
        return notificationsHTML();
      case "team":
        return teamHTML();
      default:
        return accountHTML();
    }
  }

  /* ------------------------------------------------------------ render -- */

  function captureFocus() {
    const a = document.activeElement;
    const key = a && a.getAttribute && a.getAttribute("data-focus");
    if (!key) return null;
    const f = { key };
    try {
      f.start = a.selectionStart;
      f.end = a.selectionEnd;
    } catch (_) { /* not a text field */ }
    return f;
  }
  function restoreFocus(f) {
    if (!f) return;
    const sel = '[data-focus="' + f.key.replace(/["\\]/g, "\\$&") + '"]';
    const el = root.querySelector(sel);
    if (!el) return;
    el.focus();
    if (f.start != null && el.setSelectionRange) {
      try {
        el.setSelectionRange(f.start, f.end);
      } catch (_) { /* selection unsupported */ }
    }
  }
  function render() {
    const f = captureFocus();
    root.innerHTML =
      `<div class="set-header"><div class="set-title">Settings</div><div class="set-tabs">${tabsHTML()}</div></div>` +
      `<div class="set-body"><div class="set-scroll">${panelHTML()}</div>${saveBarHTML()}${toastHTML()}</div>`;
    restoreFocus(f);
  }
  function flash(msg) {
    state.status = msg;
    state.statusOn = true;
    render();
    clearTimeout(state._t);
    state._t = setTimeout(() => {
      state.statusOn = false;
      render();
    }, 2200);
  }
  function confirmable(key, doIt) {
    if (T().confirm !== key) {
      T().confirm = key;
      render();
      return;
    }
    T().confirm = null;
    doIt(); // its own flash() re-renders
  }

  /* ------------------------------------------------------ team actions -- */

  function newRoleOpen() {
    T().newRole = true;
    T().newRoleName = "";
    render();
  }
  function newRoleCancel() {
    T().newRole = false;
    render();
  }
  function newRoleCreate() {
    const nm = T().newRoleName.trim();
    if (!nm) {
      flash("Give the role a name first");
      return;
    }
    const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "role";
    const id = uniq(slug, model().roles.map((r) => r.id));
    model().roles.push({ id, name: nm, default_home: [], flags: {} });
    T().roleId = id;
    T().panel = "role";
    T().newRole = false;
    flash(nm + " created — nothing granted yet");
  }
  function deleteRole() {
    const r = role();
    if (!r) return;
    const members = model().users.filter((u) => u.role === r.id).length;
    if (members > 0 || r.id === myRoleId()) return;
    confirmable("role:" + r.id, () => {
      model().roles = model().roles.filter((x) => x.id !== r.id);
      T().roleId = model().roles[0] ? model().roles[0].id : "";
      flash("Role deleted");
    });
  }
  function toggleWildcard() {
    const r = role();
    if (!r || r.id === myRoleId()) return;
    if (r.flags["*"] === true) delete r.flags["*"];
    else r.flags["*"] = true;
    T().confirm = null;
    render();
  }
  function toggleFlag(id) {
    const r = role();
    if (!r) return;
    r.flags[id] = !resolve(r.flags, id);
    T().confirm = null;
    render();
  }
  function clearFlag(id) {
    const r = role();
    if (!r) return;
    delete r.flags[id];
    T().confirm = null;
    flash("Override cleared — back to the role's default");
  }
  function inspect(id) {
    T().panel = "role";
    T().roleId = id;
    T().confirm = null;
    render();
  }
  function toggleFlagsPanel() {
    T().panel = T().panel === "flags" ? "role" : "flags";
    T().confirm = null;
    render();
  }
  function addOpen(id) {
    T().addTo = id;
    T().draftName = "";
    T().draftEmail = "";
    render();
  }
  function addCancel() {
    T().addTo = null;
    render();
  }
  function addMemberConfirm(roleId) {
    const nm = T().draftName.trim();
    if (!nm) {
      flash("Give them a name first");
      return;
    }
    const id = userIdFor(nm);
    model().users.push({
      id,
      name: nm,
      role: roleId,
      email: T().draftEmail.trim(),
    });
    T().addTo = null;
    T().draftName = "";
    T().draftEmail = "";
    const rr = roleById(roleId);
    flash(nm + " added to " + (rr ? rr.name : roleId) + " as " + id);
  }
  function cardRemove(id) {
    if (id === state.me) return;
    confirmable("cuser:" + id, () => {
      const u = model().users.find((x) => x.id === id);
      model().users = model().users.filter((x) => x.id !== id);
      flash((u ? u.name : id) + " removed");
    });
  }
  function slotSelect(side, value) {
    const r = role();
    if (r) setHome(r, side, value || null);
    render();
  }
  function addFlag() {
    const label = T().nfLabel.trim();
    if (!label) {
      flash("Give the flag a label first");
      return;
    }
    const id = camelId(T().nfPrefix, label);
    if (model().flags.some((f) => f.id === id)) {
      flash(id + " already exists");
      return;
    }
    model().flags.push({ id, label });
    T().nfLabel = "";
    flash(id + " added — grant it per role");
  }
  function removeFlag(id) {
    confirmable("flag:" + id, () => {
      model().flags = model().flags.filter((f) => f.id !== id);
      model().roles.forEach((r) => {
        delete r.flags[id];
      });
      flash("Flag removed everywhere");
    });
  }
  function revert() {
    const saved = JSON.parse(T().saved);
    T().model = saved;
    T().confirm = null;
    if (!model().roles.some((r) => r.id === T().roleId)) {
      T().roleId = model().roles[0] ? model().roles[0].id : "";
    }
    flash("Changes reverted");
  }
  async function save() {
    let data = {};
    try {
      const res = await fetch("/api/roles" + location.search, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: model() }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        flash("Save failed — " + (data.error || ("HTTP " + res.status)));
        return;
      }
    } catch (err) {
      flash("Save failed — " + ((err && err.message) || err));
      return;
    }
    T().saved = JSON.stringify(model());
    flash(
      data.persisted === false
        ? "Saved in memory — disk is read-only, restart won't keep it"
        : "Saved roles.json ✓ — shells pick it up on reload",
    );
  }

  /* ----------------------------------------------------------- events -- */

  function onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const action = el.getAttribute("data-action");
    const id = el.getAttribute("data-id");
    switch (action) {
      case "tab":
        state.tab = el.getAttribute("data-tab");
        T().confirm = null;
        render();
        break;
      // account / security / plan — no server backend, so Save/Cancel just toast.
      case "acct-photo":
        flash("Photo upload isn't wired up in this prototype");
        break;
      case "form-save":
        flash("Changes saved ✓");
        break;
      case "form-cancel":
        flash("Reverted to last saved");
        break;
      case "sec-toggle": {
        const key = el.getAttribute("data-field");
        state[key] = !state[key];
        // Flip the switch in place (CSS moves the knob off the `on` class)
        // rather than a full render, so text typed into the uncontrolled
        // Change-password inputs above isn't discarded mid-edit.
        el.classList.toggle("on", state[key]);
        break;
      }
      case "plan-sel":
        state.planSel = el.getAttribute("data-plan");
        render();
        break;
      // notifications (local prefs)
      case "n-alert": {
        const a = el.getAttribute("data-alert");
        const ch = el.getAttribute("data-chan");
        state.np.alerts[a][ch] = !state.np.alerts[a][ch];
        render();
        break;
      }
      case "n-digest":
        state.np.digest = el.getAttribute("data-digest");
        render();
        break;
      case "n-extra":
        state.np[el.getAttribute("data-field")] = !state
          .np[el.getAttribute("data-field")];
        render();
        break;
      case "n-save":
        state.npSaved = JSON.stringify(state.np);
        flash("Notification preferences saved ✓");
        break;
      case "n-cancel":
        state.np = JSON.parse(state.npSaved);
        flash("Preferences reset");
        break;
      case "nc-open":
        flash("The notification center isn't wired into the shell taskbar yet");
        break;
      // team (People & Access console)
      case "t-toggle-flags":
        toggleFlagsPanel();
        break;
      case "t-inspect":
        inspect(id);
        break;
      case "t-card-remove":
        cardRemove(id);
        break;
      case "t-add-open":
        addOpen(id);
        break;
      case "t-add-confirm":
        addMemberConfirm(id);
        break;
      case "t-add-cancel":
        addCancel();
        break;
      case "t-newrole-open":
        newRoleOpen();
        break;
      case "t-newrole-create":
        newRoleCreate();
        break;
      case "t-newrole-cancel":
        newRoleCancel();
        break;
      case "t-del-role":
        deleteRole();
        break;
      case "t-wildcard":
        toggleWildcard();
        break;
      case "t-flag":
        toggleFlag(id);
        break;
      case "t-clear-flag":
        clearFlag(id);
        break;
      case "t-remove-flag":
        removeFlag(id);
        break;
      case "t-add-flag":
        addFlag();
        break;
      case "t-revert":
        revert();
        break;
      case "t-save":
        save();
        break;
    }
  }

  function onInput(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const id = el.getAttribute("data-id");
    const v = el.value;
    switch (action) {
      // Account form fields feed no in-tab derived UI (the header is the
      // signed-in identity, not these fields) and there is no save bar, so we
      // store without a re-render — the caret stays put with zero focus juggling.
      case "acct":
        state.account[el.getAttribute("data-field")] = v;
        break;
      case "t-role-name": {
        const r = role();
        if (r) r.name = v;
        render();
        break;
      }
      case "t-flag-label": {
        const f = model().flags.find((x) => x.id === id);
        if (f) f.label = v;
        render();
        break;
      }
      // Add-member / new-role drafts drive no derived UI, so store without a
      // re-render (the DOM value persists; Create/Add reads it back from state).
      case "t-draft-name":
        T().draftName = v;
        break;
      case "t-draft-email":
        T().draftEmail = v;
        break;
      case "t-newrole-name":
        T().newRoleName = v;
        break;
      case "t-nf-label":
        T().nfLabel = v;
        render();
        break;
    }
  }

  function onChange(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const v = el.value;
    switch (action) {
      case "acct":
        state.account[el.getAttribute("data-field")] = v;
        break;
      case "t-slot":
        slotSelect(el.getAttribute("data-side"), v);
        break;
      case "t-nf-prefix":
        T().nfPrefix = v;
        render();
        break;
    }
  }

  // Member-card drag/drop: drag a card onto another role column to reassign
  // that user's role. The dragged card + column highlight are toggled directly
  // (not via re-render) so replacing the DOM mid-drag can't abort the gesture;
  // only a completed drop re-renders.
  function onDragStart(e) {
    const card = e.target.closest("[data-drag-user]");
    if (!card) return;
    const userId = card.getAttribute("data-drag-user");
    try {
      e.dataTransfer.setData("text/plain", userId);
      e.dataTransfer.effectAllowed = "move";
    } catch (_) { /* dataTransfer may be locked */ }
    T().drag = { userId };
    card.classList.add("dragging");
  }
  function onDragEnd() {
    T().drag = null;
    T().over = null;
    root.querySelectorAll(".member-card.dragging").forEach((c) =>
      c.classList.remove("dragging")
    );
    root.querySelectorAll(".role-col.over").forEach((s) =>
      s.classList.remove("over")
    );
  }
  function onDragOver(e) {
    const col = e.target.closest("[data-drop-role]");
    if (!col || !T().drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!col.classList.contains("over")) {
      root.querySelectorAll(".role-col.over").forEach((s) =>
        s.classList.remove("over")
      );
      col.classList.add("over");
      T().over = col.getAttribute("data-drop-role");
    }
  }
  function onDragLeave(e) {
    const col = e.target.closest("[data-drop-role]");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
  }
  function onDrop(e) {
    const col = e.target.closest("[data-drop-role]");
    if (!col) return;
    e.preventDefault();
    const roleId = col.getAttribute("data-drop-role");
    const userId = T().drag && T().drag.userId;
    T().drag = null;
    T().over = null;
    if (userId) {
      const u = model().users.find((x) => x.id === userId);
      if (u && u.role !== roleId) {
        u.role = roleId;
        const rr = roleById(roleId);
        flash(u.name + " moved to " + (rr ? rr.name : roleId));
        return;
      }
    }
    render();
  }

  /* --------------------------------------------------------------- boot -- */

  function applyConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.roles) || !cfg.roles.length) return;
    const m = {
      defaultUser: cfg.defaultUser,
      flags: cfg.flags || [],
      roles: cfg.roles || [],
      users: cfg.users || [],
    };
    T().model = m;
    T().saved = JSON.stringify(m);
    state.me = (cfg.currentUser && cfg.currentUser.id) || cfg.defaultUser ||
      state.me;
    // Land the Team role selector on the signed-in user's role.
    const meUser = m.users.find((u) => u.id === state.me);
    T().roleId = (meUser && meUser.role) || (m.roles[0] && m.roles[0].id) || "";
    // Prefill Account identity from the signed-in user.
    if (meUser) {
      state.account.name = meUser.name || state.account.name;
      state.account.username = meUser.id || state.account.username;
      if (meUser.email) state.account.email = meUser.email;
    }
    T().loaded = true;
  }

  async function boot() {
    const [cfg, cat] = await Promise.all([
      fetch("/api/roles" + location.search).then((r) => r.json()).catch(() =>
        null
      ),
      fetch("/api/catalog").then((r) => r.json()).catch(() => null),
    ]);
    if (Array.isArray(cat) && cat.length) CATALOG = cat;
    applyConfig(cfg);

    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("dragstart", onDragStart);
    root.addEventListener("dragend", onDragEnd);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);

    render();
    setInterval(() => {
      const t = clockShort();
      root.querySelectorAll(".js-clock").forEach((el) => {
        el.textContent = t;
      });
    }, 15000);
  }

  boot();
})();
