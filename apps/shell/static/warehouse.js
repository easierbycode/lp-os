/* warehouse.js — drives the CSS-3D LP warehouse (/warehouse).
 *
 * Three jobs:
 *  1. Generate the repetitive 3D geometry (BIN A–Z wall, the two inventory
 *     aisles of 3-level racks, the marketplace kiosk, the per-zone "virtual
 *     screens") so warehouse.html stays readable.
 *  2. Run the step dashboard: camera presets per step, keyboard/slider
 *     control, auto-tour.
 *  3. Talk to the OS shell when embedded: every step change posts
 *     {source:"lp-os-warehouse", type:"warehouse-step", step} up; os.js
 *     launches the matching apps and answers with a warehouse-ack listing
 *     what it opened. Standalone (top-level) the scene still works, minus
 *     the auto-launching.
 */

/* eslint-env browser */

const ground = document.getElementById("ground");
const wrapper = document.getElementById("wrapper");
const SESSION_ID = crypto.randomUUID();
const EMBEDDED = (() => {
  try {
    return globalThis.parent !== globalThis;
  } catch {
    return true;
  }
})();

/* ------------------------------------------------------------ step model -- */

// Camera presets: fx/fy = the ground point to pivot on, rx/ry tilt/orbit,
// z = screen-space zoom (positive = closer), y = vertical lift.
const STEPS = {
  overview: {
    title: "Warehouse overview",
    body: "Follow a sample through the building: 1 Receiving (BIN A–Z at the " +
      "dock), 2 Inventory (two aisles of three-level racks), 3 Studio " +
      "(content + fulfillment), 4 Marketplace (kiosk, ready-to-sell picking " +
      "and processing). Click a zone, a screen, or use the steps above.",
    cam: { fx: 400, fy: 300, rx: -24, ry: -30, z: -140, y: 40 },
  },
  receiving: {
    title: "1 · Receiving",
    body:
      "The truck backs onto the dock and every sample lands in a lettered " +
      "bin — BIN A through BIN Z — then rides the conveyor to put-away. " +
      "The scan-intake screen logs each barcode as it arrives.",
    cam: { fx: 165, fy: 420, rx: -18, ry: -16, z: 300, y: 20 },
  },
  inventory: {
    title: "2 · Inventory",
    body: "Two aisles, four racks, three levels each. The forklift shuttles " +
      "pallets while the workbench screen tracks every unit: status, " +
      "location, assignee — scan a barcode and the row lights up.",
    cam: { fx: 430, fy: 175, rx: -26, ry: -35, z: 220, y: 30 },
  },
  studio: {
    title: "3 · Studio (fulfillment)",
    body: "Ring light on, camera rolling: samples get their content moment, " +
      "then move to the packing table for fulfillment. Imports and creator " +
      "assignments happen on the studio screen.",
    cam: { fx: 145, fy: 165, rx: -20, ry: -24, z: 280, y: 30 },
  },
  marketplace: {
    title: "4 · Marketplace",
    body:
      "Cleared-to-sell stock is picked into the READY crates, priced at the " +
      "kiosk, processed at the desk, and shipped from the far dock. The " +
      "kiosk + marketplace screens run checkout and eBay listings.",
    cam: { fx: 685, fy: 285, rx: -20, ry: -48, z: 240, y: 30 },
  },
};

const STEP_ORDER = [
  "overview",
  "receiving",
  "inventory",
  "studio",
  "marketplace",
];

/* ------------------------------------------------------- geometry helpers -- */

function el(cls, parent = ground) {
  const node = document.createElement("div");
  node.className = cls;
  parent.appendChild(node);
  return node;
}

function face(parent, w, h, transform, background, text) {
  const f = document.createElement("div");
  f.className = "face";
  f.style.width = w + "px";
  f.style.height = h + "px";
  f.style.transform = transform;
  f.style.background = background;
  if (text) f.textContent = text;
  parent.appendChild(f);
  return f;
}

// A cuboid standing on the floor: footprint w×d at ground (x,y), height h.
// Faces get shaded variants of `color` so the volume reads without lighting.
function makeBox({ x, y, z = 0, w, d, h, color, top, label, cls = "" }) {
  const box = el(("box3d " + cls).trim());
  box.style.width = w + "px";
  box.style.height = d + "px";
  box.style.transform = `translate3d(${x}px, ${y}px, ${z}px)`;

  const shade = (amt) =>
    `color-mix(in oklab, ${color} ${100 - amt}%, black ${amt}%)`;

  // top (lightest), front + back (mid), left + right (darkest)
  face(box, w, d, `translateZ(${h}px)`, top || shade(0));
  face(
    box,
    w,
    h,
    `translate3d(0px, ${d - h}px, 0px) rotateX(-90deg)`,
    shade(18),
    label,
  ).style.transformOrigin = "50% 100%";
  const back = face(
    box,
    w,
    h,
    `translate3d(0px, ${-h}px, 0px) rotateX(-90deg)`,
    shade(18),
  );
  back.style.transformOrigin = "50% 100%";
  const left = face(
    box,
    d,
    h,
    `translate3d(${-d / 2}px, ${
      d / 2 - h
    }px, 0px) rotateX(-90deg) rotateY(90deg)`,
    shade(34),
  );
  left.style.transformOrigin = "50% 100%";
  const right = face(
    box,
    d,
    h,
    `translate3d(${w - d / 2}px, ${
      d / 2 - h
    }px, 0px) rotateX(-90deg) rotateY(90deg)`,
    shade(34),
  );
  right.style.transformOrigin = "50% 100%";
  return box;
}

/* -------------------------------------------------------- BIN A–Z wall ---- */

const BIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const binEls = new Map(); // "A" -> element

function buildBins() {
  BIN_LETTERS.forEach((letter, i) => {
    const row = i < 13 ? 0 : 1;
    const col = i % 13;
    const x = 40 + col * 17;
    const y = 372 + row * 46;
    const hue = row === 0 ? "#60a5fa" : "#38bdf8";
    const bin = makeBox({
      x,
      y,
      w: 15,
      d: 14,
      h: 16,
      color: hue,
      label: letter,
      cls: "bin",
    });
    bin.dataset.bin = letter;
    binEls.set(letter, bin);
  });
}

/* ------------------------------------------------- inventory rack aisles -- */

const SHELF_STOCK = ["📦", "🧴", "🧋", "📦", "🧸", "🥤", "📦", "🎧"];

function buildRacks() {
  const RACK_X = 310;
  const RACK_LEN = 240;
  const RACK_DEPTH = 22;
  const LEVELS = [0, 26, 52];
  const POST_H = 74;
  const rackYs = [56, 128, 200, 272]; // aisle A between 1–2, aisle B between 3–4

  rackYs.forEach((ry, rackIdx) => {
    const rack = el("box3d rack");
    rack.style.width = RACK_LEN + "px";
    rack.style.height = RACK_DEPTH + "px";
    rack.style.transform = `translate3d(${RACK_X}px, ${ry}px, 0px)`;

    for (const z of LEVELS) {
      // Shelf board (flat) + a lit front edge so each level reads in 3D.
      const board = document.createElement("div");
      board.className = "rack-board";
      board.style.cssText =
        `position:absolute;width:${RACK_LEN}px;height:${RACK_DEPTH}px;` +
        `transform:translateZ(${z}px);`;
      rack.appendChild(board);

      const edge = document.createElement("div");
      edge.className = "rack-edge";
      edge.style.cssText = `position:absolute;width:${RACK_LEN}px;height:4px;` +
        `transform:translate3d(0px, ${
          RACK_DEPTH - 4
        }px, ${z}px) rotateX(-90deg);`;
      rack.appendChild(edge);

      // Stock: deterministic pseudo-random emoji per slot.
      for (let slot = 0; slot < 7; slot++) {
        if ((rackIdx * 7 + slot + z) % 5 === 4) continue; // leave gaps
        const item = document.createElement("div");
        item.className = "shelf-item";
        item.textContent =
          SHELF_STOCK[(rackIdx * 3 + slot * 2 + z / 26) % SHELF_STOCK.length];
        item.style.cssText = `position:absolute;font-size:15px;` +
          `transform:translate3d(${14 + slot * 33}px, ${
            RACK_DEPTH - 18
          }px, ${z}px) rotateX(-90deg);`;
        rack.appendChild(item);
      }
    }

    // Four posts, each an X of two thin planes so it reads from every angle.
    for (const px of [0, RACK_LEN - 4]) {
      for (const py of [2, RACK_DEPTH - 2]) {
        for (const spin of [0, 90]) {
          const post = document.createElement("div");
          post.className = "rack-post";
          post.style.cssText =
            `position:absolute;width:4px;height:${POST_H}px;` +
            `transform:translate3d(${px}px, ${
              py - POST_H
            }px, 0px) rotateX(-90deg) rotateY(${spin}deg);`;
          rack.appendChild(post);
        }
      }
    }

    // Aisle name plate on the first rack of each aisle.
    if (rackIdx === 0 || rackIdx === 2) {
      const plate = document.createElement("div");
      plate.className = "bb";
      plate.textContent = rackIdx === 0 ? "AISLE 1" : "AISLE 2";
      plate.style.cssText =
        `position:absolute;font:700 11px/1 var(--font-display);color:#f5b73c;` +
        `background:#14171ee6;border:1px solid #f5b73c66;border-radius:6px;` +
        `padding:3px 8px;letter-spacing:.12em;` +
        `transform:translate3d(-4px, ${RACK_DEPTH}px, ${
          POST_H + 6
        }px) rotateX(-90deg) rotateY(calc(var(--cam-ry) * -1));`;
      rack.appendChild(plate);
    }

    ground.appendChild(rack);
  });
}

/* ------------------------------------------------------ marketplace kiosk -- */

function buildKiosk() {
  // Counter.
  makeBox({ x: 625, y: 105, w: 140, d: 30, h: 26, color: "#8b5a2b" });
  // Awning posts.
  makeBox({ x: 625, y: 76, w: 5, d: 5, h: 58, color: "#4b5563" });
  makeBox({ x: 760, y: 76, w: 5, d: 5, h: 58, color: "#4b5563" });
  // Striped awning: a flat canopy tilted down toward the shopper.
  const awning = el("box3d");
  awning.style.transform = "translate3d(617px, 70px, 58px) rotateX(8deg)";
  const canopy = document.createElement("div");
  canopy.style.cssText =
    "position:absolute;width:156px;height:46px;border-radius:4px;" +
    "background:repeating-linear-gradient(90deg,#dc2626 0 16px,#f8fafc 16px 32px);" +
    "border:2px solid #7f1d1d;box-shadow:0 4px 10px rgba(0,0,0,.35);";
  awning.appendChild(canopy);

  // Goods on the counter.
  const goods = document.createElement("div");
  goods.className = "shelf-item";
  goods.textContent = "🧋🧴📦";
  goods.style.cssText = "position:absolute;font-size:14px;" +
    "transform:translate3d(650px, 128px, 26px) rotateX(-90deg);";
  ground.appendChild(goods);

  // Shopkeeper + a browsing customer.
  const keeper = document.createElement("div");
  keeper.className = "shelf-item";
  keeper.textContent = "🧑‍💼";
  keeper.style.cssText = "position:absolute;font-size:24px;" +
    "transform:translate(688px, 100px) rotateX(-90deg) rotateY(180deg);";
  ground.appendChild(keeper);

  // READY-TO-SELL picking crates.
  const spots = [
    [630, 265, "#166534"],
    [668, 258, "#15803d"],
    [706, 268, "#166534"],
    [648, 305, "#14532d"],
    [692, 300, "#15803d"],
  ];
  for (const [x, y, c] of spots) {
    makeBox({ x, y, w: 26, d: 22, h: 15, color: c, label: "🏷️" });
  }
}

/* --------------------------------------------------------- virtual screens -- */

// One monitor per zone. In the OS these mirror real windows; standalone they
// still glow when their step is active.
const SCREENS = [
  { step: "receiving", x: 218, y: 356, glyph: "📥", label: "Scan intake" },
  { step: "inventory", x: 425, y: 318, glyph: "🗄️", label: "Workbench" },
  { step: "studio", x: 210, y: 158, glyph: "🎬", label: "Samples import" },
  { step: "marketplace", x: 588, y: 368, glyph: "🏪", label: "Kiosk · eBay" },
];

const screenEls = new Map(); // step -> element

function buildScreens() {
  for (const s of SCREENS) {
    const screen = el("screen bb");
    screen.dataset.step = s.step;
    screen.style.transform =
      `translate(${s.x}px, ${s.y}px) rotateX(-90deg) rotateY(calc(var(--cam-ry) * -1))`;
    screen.innerHTML = `
      <div class="screen-face">
        <span class="screen-glyph"></span>
        <span class="screen-label"></span>
      </div>
      <div class="screen-stand"></div>
      <div class="screen-base"></div>`;
    screen.querySelector(".screen-glyph").textContent = s.glyph;
    screen.querySelector(".screen-label").textContent = s.label;
    screen.addEventListener("click", () => setStep(s.step));
    screenEls.set(s.step, screen);
  }
}

/* ----------------------------------------------------------- step engine -- */

const chips = [...document.querySelectorAll(".step-chip")];
const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");
const infoApps = document.getElementById("infoApps");
const rotateSlider = document.getElementById("rotateSlider");
const zoomSlider = document.getElementById("zoomSlider");

let currentStep = "overview";
let zoomOffset = 0;

function applyCamera() {
  const cam = STEPS[currentStep].cam;
  wrapper.style.setProperty("--cam-rx", cam.rx + "deg");
  wrapper.style.setProperty("--cam-ry", rotateSlider.value + "deg");
  wrapper.style.setProperty("--cam-z", cam.z + zoomOffset + "px");
  wrapper.style.setProperty("--cam-y", cam.y + "px");
  ground.style.setProperty("--pan-x", 400 - cam.fx + "px");
  ground.style.setProperty("--pan-y", 300 - cam.fy + "px");
}

function setStep(step, { announce = true } = {}) {
  if (!STEPS[step]) return;
  currentStep = step;
  document.body.dataset.focus = step;

  const cam = STEPS[step].cam;
  rotateSlider.value = String(cam.ry);
  zoomOffset = 0;
  zoomSlider.value = "0";
  applyCamera();

  for (const chip of chips) {
    chip.classList.toggle("active", chip.dataset.step === step);
  }
  infoTitle.textContent = STEPS[step].title;
  infoBody.textContent = STEPS[step].body;
  infoApps.textContent = "";

  for (const [s, screenEl] of screenEls) {
    screenEl.classList.toggle("live", s === step);
  }

  if (announce && EMBEDDED) {
    globalThis.parent.postMessage(
      {
        source: "lp-os-warehouse",
        type: "warehouse-step",
        step,
        sessionId: SESSION_ID,
      },
      "*",
    );
  }
}

// The OS confirms which app windows it opened for the step.
globalThis.addEventListener("message", (e) => {
  const data = e.data;
  if (!data || data.source !== "thirsty-os" || data.type !== "warehouse-ack") {
    return;
  }
  if (data.step !== currentStep) return;
  const opened = Array.isArray(data.opened) ? data.opened : [];
  infoApps.textContent = "";
  for (const app of opened) {
    const chip = document.createElement("span");
    chip.className = "app-chip";
    chip.textContent = `▶ ${app} launched`;
    infoApps.appendChild(chip);
  }
});

/* ------------------------------------------------------------- controls -- */

rotateSlider.addEventListener("input", () => {
  wrapper.style.setProperty("--cam-ry", rotateSlider.value + "deg");
});

zoomSlider.addEventListener("input", () => {
  zoomOffset = Number(zoomSlider.value);
  const cam = STEPS[currentStep].cam;
  wrapper.style.setProperty("--cam-z", cam.z + zoomOffset + "px");
});

document.getElementById("steps").addEventListener("click", (e) => {
  const chip = e.target.closest(".step-chip");
  if (chip) setStep(chip.dataset.step);
});

for (const decal of document.querySelectorAll(".zone-decal")) {
  decal.addEventListener("click", () => setStep(decal.dataset.step));
}

// Auto-tour: walk the four steps every few seconds.
const tourBtn = document.getElementById("tourBtn");
let tourTimer = 0;

function stopTour() {
  clearInterval(tourTimer);
  tourTimer = 0;
  tourBtn.classList.remove("running");
  tourBtn.textContent = "▶ Tour";
}

function startTour() {
  tourBtn.classList.add("running");
  tourBtn.textContent = "⏸ Touring";
  const advance = () => {
    const i = STEP_ORDER.indexOf(currentStep);
    setStep(STEP_ORDER[(i + 1) % STEP_ORDER.length]);
  };
  advance();
  tourTimer = setInterval(advance, 7000);
}

tourBtn.addEventListener("click", () => (tourTimer ? stopTour() : startTour()));

document.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    stopTour();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const i = STEP_ORDER.indexOf(currentStep);
    setStep(STEP_ORDER[(i + dir + STEP_ORDER.length) % STEP_ORDER.length]);
    e.preventDefault();
  } else if (/^[1-5]$/.test(e.key)) {
    stopTour();
    setStep(STEP_ORDER[Number(e.key) - 1] || "overview");
  } else if (e.key === " ") {
    tourTimer ? stopTour() : startTour();
    e.preventDefault();
  }
});

/* ------------------------------------------------------------ live stats -- */

// Same-origin API (the shell serves /warehouse). Decorative fallback when the
// DB is offline: the scene simply shows its default stock.
async function loadLiveStats() {
  try {
    const res = await fetch("/api/samples?limit=500");
    if (!res.ok) return;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return;

    const total = rows.length;
    const ready = rows.filter((r) => r.status === "cleared_to_sell").length;
    const out = rows.filter((r) => r.status === "checked_out").length;
    const binCounts = new Map();
    for (const row of rows) {
      const m = /^BIN ([A-Z])$/i.exec(String(row.location || "").trim());
      if (m) {
        const letter = m[1].toUpperCase();
        binCounts.set(letter, (binCounts.get(letter) || 0) + 1);
      }
    }

    document.getElementById("infoStats").innerHTML =
      `Live: <b>${total}</b> samples · <b>${ready}</b> ready to sell · ` +
      `<b>${out}</b> checked out · <b>${binCounts.size}</b> bins in use`;

    // Light up bins that actually hold stock.
    for (const [letter, bin] of binEls) {
      bin.classList.toggle("bin-hot", binCounts.has(letter));
    }
  } catch {
    /* offline/no DB — stay decorative */
  }
}

/* ----------------------------------------------------------------- boot -- */

buildBins();
buildRacks();
buildKiosk();
buildScreens();
setStep("overview", { announce: false });
loadLiveStats();

// Auto-start the walk-through when launched with ?tour=1. The OS shell opens
// this pane with tour=1 (see os.js ?tour= handling) so a shared /?tour=1 link
// boots straight into the tour; /warehouse?tour=1 also works standalone.
const tourParam = new URLSearchParams(location.search).get("tour");
if (tourParam && tourParam !== "0" && tourParam !== "false") startTour();

if (!EMBEDDED) {
  document.getElementById("standaloneNote").hidden = false;
}
