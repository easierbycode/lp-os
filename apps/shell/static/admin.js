// LP-OS Admin window — users, roles, capability flags, and each role's
// default_home boot layout, over core/roles.json. A vanilla, framework-free
// port of the Claude Design "Workbench — roles first" (1a) handoff: a left role
// rail, a main editor, and a right live-preview rail, with a save bar.
//
// Loads the live config from GET /api/roles (currentUser resolved from the
// ?user= the shell rides along) and the launcher catalog from GET /api/catalog,
// edits a local copy, and persists with POST /api/roles. Flag resolution mirrors
// core/roles.ts / os.js: an explicit per-role value wins, else the "*" wildcard,
// else deny. Access is UX gating, not authz (see os.js) — the same caveat here.

(() => {
  "use strict";

  const root = document.getElementById("admin-root");

  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  // The small folder tile drawn in the live-preview desktop (gradients defined
  // once in admin.html).
  const FOLDER_SVG =
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M5 17a4 4 0 0 1 4-4h13.2a4 4 0 0 1 2.9 1.25L31 19h24a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4Z" fill="url(#g-folder-back)"></path><path d="M7 27a3 3 0 0 1 3-3h44a3 3 0 0 1 3 3v21a4 4 0 0 1-4 4H10a3 3 0 0 1-3-3Z" fill="url(#g-folder-front)"></path><path d="M7 27a3 3 0 0 1 3-3h44a3 3 0 0 1 3 3v3H7Z" fill="#fff" opacity=".14"></path></svg>`;

  // Standalone fallbacks so the page still renders if the APIs are unreachable
  // (mirrors core/roles.json + core/catalog.ts). Save will fail until the
  // server answers, which the toast reports.
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

  /* ------------------------------------------------------ pure helpers -- */

  const PRESET = { admin: "#f5b73c", creator: "#f472b6", warehouse: "#4fc3a1" };
  const EXTRA = ["#5b9bd5", "#a78bfa", "#38bdf8", "#fb7185"];

  function roleColor(m, id) {
    if (PRESET[id]) return PRESET[id];
    const idx = m.roles.findIndex((r) => r.id === id);
    return EXTRA[Math.max(0, idx) % EXTRA.length];
  }

  function resolve(flags, id) {
    const e = flags[id];
    if (typeof e === "boolean") return e;
    return flags["*"] === true;
  }

  function allows(role, flag) {
    if (!flag) return true;
    if (!role || !role.flags) return false;
    return resolve(role.flags, flag);
  }

  function visible(role) {
    return CATALOG
      .map((f) => ({
        ...f,
        items: f.items.filter((i) => allows(role, i.flag)),
      }))
      .filter((f) => allows(role, f.flag) && f.items.length > 0);
  }

  function totalLaunchers() {
    return CATALOG.reduce((n, f) => n + f.items.length, 0);
  }

  function allowedApps(role) {
    return visible(role).flatMap((f) =>
      f.items.map((i) => ({
        name: i.name,
        folder: f.name,
        ref: f.name + "/" + i.name,
      }))
    );
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

  function userIdFor(name, m) {
    const t = String(name || "").trim();
    if (!t) return "…";
    const base = t.startsWith("@")
      ? t.toLowerCase().replace(/\s+/g, "")
      : (t.split(/\s+/).map((w) => w[0]).join("").toLowerCase().slice(0, 3) ||
        "u");
    return uniq(base, m.users.map((u) => u.id));
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

  // Place `ref` in a role's boot layout half (or clear it with ref=null),
  // keeping left before right.
  function setHome(role, side, ref) {
    const others = (role.default_home || []).filter((e) => e[1] !== side);
    const mine = ref ? [[ref, side]] : [];
    role.default_home = others.concat(mine)
      .sort((x, y) => (x[1] === "left" ? 0 : 1) - (y[1] === "left" ? 0 : 1));
  }

  function clockShort() {
    return new Date().toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /* -------------------------------------------------------------- state -- */

  let CATALOG = FALLBACK_CATALOG;
  let model = null; // { defaultUser, flags, roles, users } — the edited copy
  const state = {
    saved: "",
    me: "dj",
    view: "role", // "role" | "users" | "flags"
    roleId: "",
    confirm: null, // "role:<id>" | "user:<id>" | "flag:<id>"
    drag: null, // { ref } while dragging a boot-layout chip
    over: null, // "left" | "right"
    status: "",
    statusOn: false,
    _t: 0,
    nuName: "",
    nuEmail: "",
    nuRole: "",
    nfPrefix: "app.",
    nfLabel: "",
  };

  const byId = (id) => model.users.find((u) => u.id === id);
  const flagById = (id) => model.flags.find((f) => f.id === id);
  const role = () =>
    model.roles.find((r) => r.id === state.roleId) || model.roles[0];
  const dirty = () => JSON.stringify(model) !== state.saved;

  function meRoleId() {
    const u = model.users.find((x) => x.id === state.me);
    return u ? u.role : (model.roles[0] && model.roles[0].id) || "";
  }

  /* -------------------------------------------------------------- toggle -- */

  function toggleHTML(on, opts) {
    const cls = "toggle" + (on ? " on" : "") + (opts.locked ? " locked" : "");
    const attrs = `data-action="${opts.action}"` +
      (opts.id != null ? ` data-id="${esc(opts.id)}"` : "") +
      (opts.locked ? " disabled" : "");
    const title = opts.title ? ` title="${esc(opts.title)}"` : "";
    return `<button class="${cls}" ${attrs}${title} aria-label="${
      esc(opts.label || "")
    }"><span class="toggle-knob"></span></button>`;
  }

  /* ---------------------------------------------------------- left rail -- */

  function railHTML() {
    const roles = model.roles.map((r) => {
      const active = state.view === "role" && r.id === state.roleId;
      const count = model.users.filter((u) => u.role === r.id).length;
      return `<button class="rail-btn${
        active ? " is-active" : ""
      }" data-action="nav-role" data-id="${esc(r.id)}">
        <span class="role-dot" style="background:${
        roleColor(model, r.id)
      }"></span>
        <span class="rail-btn-name">${esc(r.name)}</span>
        <span class="rail-count">${count}</span>
      </button>`;
    }).join("");
    const dirs = [
      { label: "Users", count: model.users.length, view: "users" },
      { label: "Capability flags", count: model.flags.length, view: "flags" },
    ].map((d) => {
      const active = state.view === d.view;
      return `<button class="rail-btn${
        active ? " is-active" : ""
      }" data-action="nav-view" data-view="${d.view}">
        <span class="rail-btn-name">${esc(d.label)}</span>
        <span class="rail-count">${d.count}</span>
      </button>`;
    }).join("");
    return `<div class="rail">
      <div class="rail-label">Roles</div>
      ${roles}
      <button class="rail-add" data-action="add-role">+ New role</button>
      <div class="rail-gap"></div>
      <div class="rail-label tight">Directory</div>
      ${dirs}
      <div class="rail-spacer"></div>
      <div class="rail-note">Access is a kiosk profile, not a lock — hidden apps stay reachable by direct URL.</div>
    </div>`;
  }

  /* --------------------------------------------------------- role view -- */

  function buildGroups(r) {
    const wildcardOn = r.flags["*"] === true;
    const defs = [
      { key: "folder.", name: "Folders" },
      { key: "app.", name: "Apps" },
      { key: "ops.", name: "Operations" },
    ];
    const groups = defs.map((d) => ({ name: d.name, rows: [] }));
    const other = { name: "Other", rows: [] };
    model.flags.forEach((f) => {
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

  function groupHTML(g) {
    const rows = g.rows.map((row) =>
      `<div class="flag-row">
      <div class="flag-main">
        <div class="flag-name">${esc(row.label)}</div>
        <div class="flag-id">${esc(row.id)}</div>
      </div>
      ${
        row.explicit
          ? `<button class="chip-clear" data-action="clear-flag" data-id="${
            esc(row.id)
          }" title="Clear this override — fall back to the role's default">set here ✕</button>`
          : `<span class="src-text">${esc(row.srcText)}</span>`
      }
      ${
        toggleHTML(row.on, {
          action: "toggle-flag",
          id: row.id,
          label: row.label,
        })
      }
    </div>`
    ).join("");
    return `<div class="group"><div class="group-name">${
      esc(g.name)
    }</div><div class="group-card">${rows}</div></div>`;
  }

  function slotsHTML(r) {
    const allowed = allowedApps(r).map((x) => x.ref);
    return ["left", "right"].map((side) => {
      const entry = (r.default_home || []).find((e) => e[1] === side);
      const ref = entry ? entry[0] : "";
      const base = ref.split("?")[0];
      const over = state.over === side && state.drag;
      const name = base.split("/")[1] || base;
      const missing = !!ref && !allowed.includes(base);
      const body = ref
        ? `<div class="slot-app">
            <div class="slot-app-body">
              <div class="slot-app-name">${esc(name)}</div>
              <div class="slot-app-path">${esc(ref)}</div>
            </div>
            <button class="slot-clear" data-action="clear-slot" data-side="${side}" aria-label="Clear slot">×</button>
          </div>${
          missing
            ? `<div class="slot-missing">Hidden for this role — grant its flag above, or clear it.</div>`
            : ""
        }`
        : `<div class="slot-empty">Drop an app here — or click one below</div>`;
      return `<div class="slot${over ? " over" : ""}" data-drop-side="${side}">
        <div class="slot-side">${
        side === "left" ? "LEFT HALF" : "RIGHT HALF"
      }</div>
        ${body}
      </div>`;
    }).join("");
  }

  function chipsHTML(r) {
    const apps = allowedApps(r);
    if (!apps.length) {
      return `<div class="chips-empty">Nothing yet — grant a folder or app above first.</div>`;
    }
    const chips = apps.map((x) => {
      const dragging = state.drag && state.drag.ref === x.ref;
      return `<button class="chip${
        dragging ? " dragging" : ""
      }" draggable="true" data-drag-ref="${
        esc(x.ref)
      }" data-action="chip-click" data-ref="${
        esc(x.ref)
      }" title="Drag into a half, or click">
        <span class="chip-folder">${esc(x.folder)}/</span>${esc(x.name)}
      </button>`;
    }).join("");
    return `<div class="chips">${chips}</div>`;
  }

  function roleViewHTML() {
    const r = role();
    if (!r) {
      return `<div class="view-sub">No roles yet — add one from the rail.</div>`;
    }
    const mine = r.id === meRoleId();
    const members = model.users.filter((u) => u.role === r.id).length;
    const delDisabled = members > 0 || mine;
    const delConfirming = state.confirm === "role:" + r.id;
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
      <div class="role-head">
        <input class="inline-input role-name-input" data-action="role-name" data-focus="role-name" value="${
      esc(r.name)
    }" aria-label="Role name">
        <span class="mono-chip">${esc(r.id)}</span>
        <span class="spacer"></span>
        <button class="btn-remove danger${
      delConfirming ? " confirming" : ""
    }" data-action="delete-role"${delDisabled ? " disabled" : ""} title="${
      esc(delHint)
    }">${delConfirming ? "Confirm delete" : "Delete role"}</button>
      </div>
      ${
      mine
        ? `<div class="banner-warn">This is the role you're signed in with. Everything stays on for it, so you can't lock yourself out of this panel.</div>`
        : ""
    }
      <div class="wildcard">
        <div class="wildcard-body">
          <div class="wildcard-title">Everything <span class="mono-inline">*</span></div>
          <div class="wildcard-sub">Grants every capability — including flags added later — unless a switch below turns one off.</div>
        </div>
        ${
      toggleHTML(wildcardOn, {
        action: "toggle-wildcard",
        locked: mine,
        label: "Everything",
        title: wcHint,
      })
    }
      </div>
      ${buildGroups(r).map(groupHTML).join("")}
      <div class="boot">
        <div class="boot-title">Boot layout</div>
        <div class="boot-sub">Windows that open automatically, snapped side by side, when someone with this role boots LP-OS.</div>
        <div class="boot-slots">${slotsHTML(r)}</div>
        <div class="boot-hint">Apps this role can open — drag one into a half, or click to fill the next empty slot:</div>
        ${chipsHTML(r)}
      </div>`;
  }

  /* -------------------------------------------------------- users view -- */

  function usersViewHTML() {
    const rows = model.users.map((u) => {
      const color = roleColor(model, u.role);
      const confirming = state.confirm === "user:" + u.id;
      const isYou = u.id === state.me;
      const roleOptions = model.roles
        .map((r) =>
          `<option value="${esc(r.id)}"${r.id === u.role ? " selected" : ""}>${
            esc(r.name)
          }</option>`
        )
        .join("");
      return `<div class="table-row users-grid">
        <div class="user-name-cell">
          <span class="avatar sm" style="--av:${color}">${
        esc(initials(u.name))
      }</span>
          <input class="inline-input" data-action="user-name" data-id="${
        esc(u.id)
      }" data-focus="user-name:${esc(u.id)}" value="${
        esc(u.name)
      }" aria-label="Name">
          ${isYou ? `<span class="badge-you">you</span>` : ""}
        </div>
        <span class="cell-mono">${esc(u.id)}</span>
        <input class="inline-input email-input" data-action="user-email" data-id="${
        esc(u.id)
      }" data-focus="user-email:${esc(u.id)}" value="${
        esc(u.email || "")
      }" placeholder="—" aria-label="Email">
        <select class="select" data-action="user-role" data-id="${esc(u.id)}"${
        isYou ? " disabled" : ""
      } title="${
        isYou
          ? "Your own role — switch profiles from the taskbar instead"
          : "Sets what their desktop shows"
      }" aria-label="Role">${roleOptions}</select>
        <button class="btn-remove${
        confirming ? " confirming" : ""
      }" data-action="remove-user" data-id="${esc(u.id)}"${
        isYou ? " disabled" : ""
      } title="${isYou ? "That's you" : "Remove from roles.json"}">${
        confirming ? "Confirm?" : "Remove"
      }</button>
      </div>`;
    }).join("");
    const newRoleOptions = model.roles
      .map((r) =>
        `<option value="${esc(r.id)}"${
          r.id === state.nuRole ? " selected" : ""
        }>${esc(r.name)}</option>`
      )
      .join("");
    return `
      <div class="view-title">Users</div>
      <div class="view-sub">Anyone here can be picked from the taskbar switcher. Their role decides what the desktop shows.</div>
      <div class="table">
        <div class="table-head users-grid"><span>Name</span><span>User ID</span><span>Email</span><span>Role</span><span></span></div>
        ${rows}
      </div>
      <div class="add-row">
        <input class="field grow-2" data-action="nu-name" data-focus="nu-name" value="${
      esc(state.nuName)
    }" placeholder="Name (or @handle)">
        <input class="field grow-2" data-action="nu-email" data-focus="nu-email" value="${
      esc(state.nuEmail)
    }" placeholder="Email (optional)">
        <select class="select" data-action="nu-role" aria-label="Role for new user">${newRoleOptions}</select>
        <button class="btn-primary" data-action="add-user">Add user</button>
      </div>
      <div class="hint">ID <span class="mono">${
      esc(userIdFor(state.nuName, model))
    }</span> is assigned automatically — @handles keep the handle as their ID.</div>`;
  }

  /* -------------------------------------------------------- flags view -- */

  function grantedBy(f) {
    const list = model.roles.map((r) => {
      const e = r.flags[f.id];
      if (e === true) return r.name;
      if (e === false) return null;
      return r.flags["*"] === true ? r.name + " (via *)" : null;
    }).filter(Boolean);
    return list.length
      ? "Granted to " + list.join(" · ")
      : "No role grants this yet";
  }

  function flagsViewHTML() {
    const rows = model.flags.map((f) => {
      const confirming = state.confirm === "flag:" + f.id;
      const granted = grantedBy(f);
      return `<div class="table-row flags-grid">
        <input class="inline-input" data-action="flag-label" data-id="${
        esc(f.id)
      }" data-focus="flag-label:${esc(f.id)}" value="${
        esc(f.label)
      }" aria-label="Flag label">
        <span class="cell-id">${esc(f.id)}</span>
        <span class="cell-granted" title="${esc(granted)}">${
        esc(granted)
      }</span>
        <button class="btn-remove${
        confirming ? " confirming" : ""
      }" data-action="remove-flag" data-id="${esc(f.id)}">${
        confirming ? "Confirm?" : "Remove"
      }</button>
      </div>`;
    }).join("");
    return `
      <div class="view-title">Capability flags</div>
      <div class="view-sub">The switches roles grant. Every folder and app in the OS declares which flag gates it.</div>
      <div class="table">${rows}</div>
      <div class="add-row">
        <select class="select mono" data-action="nf-prefix" aria-label="Flag prefix">
          <option value="app."${
      state.nfPrefix === "app." ? " selected" : ""
    }>app.</option>
          <option value="folder."${
      state.nfPrefix === "folder." ? " selected" : ""
    }>folder.</option>
          <option value="ops."${
      state.nfPrefix === "ops." ? " selected" : ""
    }>ops.</option>
        </select>
        <input class="field grow" data-action="nf-label" data-focus="nf-label" value="${
      esc(state.nfLabel)
    }" placeholder="Label — e.g. Payouts dashboard">
        <span class="id-preview">${
      esc(camelId(state.nfPrefix, state.nfLabel))
    }</span>
        <button class="btn-primary" data-action="add-flag">Add flag</button>
      </div>
      <div class="hint">New flags start off for every role — except roles with Everything, which pick them up automatically.</div>`;
  }

  /* ------------------------------------------------------ preview rail -- */

  function previewHTML() {
    const r = role();
    if (!r) return `<div class="preview"></div>`;
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
      caption =
        "Sees nothing — every folder is hidden. That's a locked-out profile.";
    } else {
      const boot = (left || right)
        ? "Boots with " +
          [
            left && (nameOf(left) + " (left)"),
            right && (nameOf(right) + " (right)"),
          ]
            .filter(Boolean).join(" + ")
        : "Boots to an empty desktop";
      caption = boot + " · sees " + vis.length + " of " + CATALOG.length +
        " folders · " + nItems + " of " + totalLaunchers() + " launchers.";
    }
    const color = roleColor(model, r.id);
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
    const members = model.users.filter((u) => u.role === r.id);
    const membersHTML = members.map((u) =>
      `<div class="preview-member">
        <span class="avatar xs" style="--av:${color}">${
        esc(initials(u.name))
      }</span>
        <span class="preview-member-name">${esc(u.name)}</span>
        ${u.id === state.me ? `<span class="badge-you">you</span>` : ""}
      </div>`
    ).join("");
    return `<div class="preview">
      <div class="preview-label">Live preview</div>
      <div class="preview-role">
        <span class="role-dot" style="background:${color}"></span>
        <span class="preview-role-name">${esc(r.name)}</span>
        <span class="preview-boots">boots into:</span>
      </div>
      <div class="screen">
        <div class="screen-folders">${folders}</div>
        ${left ? pane("left", nameOf(left)) : ""}
        ${right ? pane("right", nameOf(right)) : ""}
        <div class="screen-taskbar"><span class="mark">◆</span><span class="name">LP-OS</span><span class="spacer"></span><span class="clk js-clock">${
      esc(clockShort())
    }</span></div>
      </div>
      <div class="preview-caption${lockedOut ? " locked" : ""}">${
      esc(caption)
    }</div>
      <div class="preview-members-label">Members · ${members.length}</div>
      ${
      members.length === 0
        ? `<div class="preview-no-members">No one holds this role yet.</div>`
        : `<div class="preview-members">${membersHTML}</div>`
    }
    </div>`;
  }

  /* ---------------------------------------------------- save bar / toast -- */

  function savebarHTML() {
    if (!dirty()) return "";
    return `<div class="savebar">
      <span class="savebar-dot"></span>
      <span class="savebar-text">Unsaved changes — saving rewrites <span class="mono">core/roles.json</span> for everyone on this OS.</span>
      <span class="spacer"></span>
      <button class="btn-ghost" data-action="revert">Revert</button>
      <button class="btn-primary" data-action="save">Save changes</button>
    </div>`;
  }

  function toastHTML() {
    return `<div class="toast${state.statusOn ? " show" : ""}">${
      esc(state.status)
    }</div>`;
  }

  /* ------------------------------------------------------------- render -- */

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
    let main;
    if (state.view === "users") main = usersViewHTML();
    else if (state.view === "flags") main = flagsViewHTML();
    else main = roleViewHTML();
    root.innerHTML = railHTML() + `<div class="main">${main}</div>` +
      previewHTML() +
      savebarHTML() + toastHTML();
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
    }, 2000);
  }

  function confirmable(key, doIt) {
    if (state.confirm !== key) {
      state.confirm = key;
      render();
      return;
    }
    state.confirm = null;
    doIt(); // its own flash() re-renders
  }

  /* ------------------------------------------------------------ actions -- */

  function addRole() {
    const id = uniq("new-role", model.roles.map((r) => r.id));
    model.roles.push({ id, name: "New role", default_home: [], flags: {} });
    state.roleId = id;
    state.view = "role";
    state.confirm = null;
    flash("Role created — nothing granted yet");
  }

  function deleteRole() {
    const r = role();
    if (!r) return;
    const members = model.users.filter((u) => u.role === r.id).length;
    if (members > 0 || r.id === meRoleId()) return;
    confirmable("role:" + r.id, () => {
      model.roles = model.roles.filter((x) => x.id !== r.id);
      state.roleId = model.roles[0] ? model.roles[0].id : "";
      state.view = "role";
      flash("Role deleted");
    });
  }

  function toggleWildcard() {
    const r = role();
    if (!r || r.id === meRoleId()) return;
    if (r.flags["*"] === true) delete r.flags["*"];
    else r.flags["*"] = true;
    state.confirm = null;
    render();
  }

  function toggleFlag(id) {
    const r = role();
    if (!r) return;
    r.flags[id] = !resolve(r.flags, id);
    state.confirm = null;
    render();
  }

  function clearFlag(id) {
    const r = role();
    if (!r) return;
    delete r.flags[id];
    state.confirm = null;
    flash("Override cleared — back to the role's default");
  }

  function chipClick(ref) {
    const r = role();
    if (!r) return;
    const home = r.default_home || [];
    const side = !home.some((e) => e[1] === "left")
      ? "left"
      : !home.some((e) => e[1] === "right")
      ? "right"
      : null;
    if (!side) {
      flash("Both halves are full — clear one first");
      return;
    }
    setHome(r, side, ref);
    render();
  }

  function addUser() {
    const nm = state.nuName.trim();
    if (!nm) {
      flash("Give them a name first");
      return;
    }
    const id = userIdFor(nm, model);
    const roleTo = model.roles.some((r) => r.id === state.nuRole)
      ? state.nuRole
      : (model.roles[0] && model.roles[0].id) || "";
    model.users.push({
      id,
      name: nm,
      role: roleTo,
      email: state.nuEmail.trim(),
    });
    state.nuName = "";
    state.nuEmail = "";
    flash(nm + " added as " + id);
  }

  function removeUser(id) {
    if (id === state.me) return;
    confirmable("user:" + id, () => {
      const u = byId(id);
      model.users = model.users.filter((x) => x.id !== id);
      flash((u ? u.name : id) + " removed");
    });
  }

  function addFlag() {
    const label = state.nfLabel.trim();
    if (!label) {
      flash("Give the flag a label first");
      return;
    }
    const id = camelId(state.nfPrefix, label);
    if (model.flags.some((f) => f.id === id)) {
      flash(id + " already exists");
      return;
    }
    model.flags.push({ id, label });
    state.nfLabel = "";
    flash(id + " added — grant it per role");
  }

  function removeFlag(id) {
    confirmable("flag:" + id, () => {
      model.flags = model.flags.filter((f) => f.id !== id);
      model.roles.forEach((r) => {
        delete r.flags[id];
      });
      flash("Flag removed everywhere");
    });
  }

  function revert() {
    const saved = JSON.parse(state.saved);
    // Mutate the existing model object in place so all closures stay valid.
    model.defaultUser = saved.defaultUser;
    model.flags = saved.flags;
    model.roles = saved.roles;
    model.users = saved.users;
    state.confirm = null;
    if (!model.roles.some((r) => r.id === state.roleId)) {
      state.roleId = model.roles[0] ? model.roles[0].id : "";
    }
    flash("Changes reverted");
  }

  async function save() {
    let data = {};
    try {
      const res = await fetch("/api/roles" + location.search, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: model }),
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
    state.saved = JSON.stringify(model);
    flash(
      data.persisted === false
        ? "Saved in memory — disk is read-only, restart won't keep it"
        : "Saved roles.json ✓ — shells pick it up on reload",
    );
  }

  /* ---------------------------------------------------- event delegation -- */

  function onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el || el.disabled) return;
    const action = el.getAttribute("data-action");
    const id = el.getAttribute("data-id");
    switch (action) {
      case "nav-role":
        state.view = "role";
        state.roleId = id;
        state.confirm = null;
        render();
        break;
      case "nav-view":
        state.view = el.getAttribute("data-view");
        state.confirm = null;
        render();
        break;
      case "add-role":
        addRole();
        break;
      case "delete-role":
        deleteRole();
        break;
      case "toggle-wildcard":
        toggleWildcard();
        break;
      case "toggle-flag":
        toggleFlag(id);
        break;
      case "clear-flag":
        clearFlag(id);
        break;
      case "clear-slot": {
        const r = role();
        if (r) setHome(r, el.getAttribute("data-side"), null);
        render();
        break;
      }
      case "chip-click":
        chipClick(el.getAttribute("data-ref"));
        break;
      case "remove-user":
        removeUser(id);
        break;
      case "add-user":
        addUser();
        break;
      case "remove-flag":
        removeFlag(id);
        break;
      case "add-flag":
        addFlag();
        break;
      case "save":
        save();
        break;
      case "revert":
        revert();
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
      case "role-name": {
        const r = role();
        if (r) r.name = v;
        render();
        break;
      }
      case "user-name": {
        const u = byId(id);
        if (u) u.name = v;
        render();
        break;
      }
      case "user-email": {
        const u = byId(id);
        if (u) u.email = v;
        render();
        break;
      }
      case "flag-label": {
        const f = flagById(id);
        if (f) f.label = v;
        render();
        break;
      }
      case "nu-name":
        state.nuName = v;
        render();
        break;
      case "nu-email":
        state.nuEmail = v;
        render();
        break;
      case "nf-label":
        state.nfLabel = v;
        render();
        break;
    }
  }

  function onChange(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const id = el.getAttribute("data-id");
    const v = el.value;
    if (action === "user-role") {
      const u = byId(id);
      if (u) {
        u.role = v;
        const rr = model.roles.find((r) => r.id === v);
        flash(u.name + " is now " + (rr ? rr.name : v));
      }
    } else if (action === "nu-role") {
      state.nuRole = v;
      render();
    } else if (action === "nf-prefix") {
      state.nfPrefix = v;
      render();
    }
  }

  // Boot-layout drag/drop. The dragged chip and the drop-target highlight are
  // toggled directly (not via re-render) so replacing the DOM mid-drag can't
  // abort the gesture; only a completed drop re-renders.
  function onDragStart(e) {
    const chip = e.target.closest("[data-drag-ref]");
    if (!chip) return;
    const ref = chip.getAttribute("data-drag-ref");
    try {
      e.dataTransfer.setData("text/plain", ref);
      e.dataTransfer.effectAllowed = "copy";
    } catch (_) { /* dataTransfer may be locked */ }
    state.drag = { ref };
    chip.classList.add("dragging");
  }

  function onDragEnd() {
    state.drag = null;
    state.over = null;
    root.querySelectorAll(".chip.dragging").forEach((c) =>
      c.classList.remove("dragging")
    );
    root.querySelectorAll(".slot.over").forEach((s) =>
      s.classList.remove("over")
    );
  }

  function onDragOver(e) {
    const slot = e.target.closest("[data-drop-side]");
    if (!slot || !state.drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!slot.classList.contains("over")) {
      root.querySelectorAll(".slot.over").forEach((s) =>
        s.classList.remove("over")
      );
      slot.classList.add("over");
      state.over = slot.getAttribute("data-drop-side");
    }
  }

  function onDragLeave(e) {
    const slot = e.target.closest("[data-drop-side]");
    if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove("over");
  }

  function onDrop(e) {
    const slot = e.target.closest("[data-drop-side]");
    if (!slot) return;
    e.preventDefault();
    const side = slot.getAttribute("data-drop-side");
    const ref = state.drag && state.drag.ref;
    state.drag = null;
    state.over = null;
    if (ref) {
      const r = role();
      if (r) setHome(r, side, ref);
    }
    render();
  }

  /* --------------------------------------------------------------- boot -- */

  async function boot() {
    const [cfg, cat] = await Promise.all([
      fetch("/api/roles" + location.search).then((r) => r.json()).catch(() =>
        null
      ),
      fetch("/api/catalog").then((r) => r.json()).catch(() => null),
    ]);
    if (Array.isArray(cat) && cat.length) CATALOG = cat;
    if (!cfg || !Array.isArray(cfg.roles) || !cfg.roles.length) {
      root.innerHTML =
        `<div class="admin-loading">Couldn't load roles config — the shell API didn't answer.</div>`;
      return;
    }
    model = {
      defaultUser: cfg.defaultUser,
      flags: cfg.flags || [],
      roles: cfg.roles || [],
      users: cfg.users || [],
    };
    state.saved = JSON.stringify(model);
    state.me = (cfg.currentUser && cfg.currentUser.id) || model.defaultUser;
    state.roleId = (model.roles[0] && model.roles[0].id) || "";
    // Least-privilege default for the "add user" role picker.
    const nonWild = model.roles.find((r) => r.flags["*"] !== true) ||
      model.roles[0];
    state.nuRole = (nonWild && nonWild.id) || "";

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
