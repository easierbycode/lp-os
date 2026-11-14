// Staff view for self-checkout payments (/kiosk/payments). Cash App link
// payments can't be confirmed automatically, so a customer's "I've paid"
// lands here as `claimed`: check Cash App for the amount, then Confirm
// (items marked sold) or Reject (items back on sale). `error` rows are Square
// charges whose outcome was unknown: check the Square Dashboard first.

const LIST = document.getElementById("kp-list");
const FILTER = document.getElementById("kp-filter");
const OPERATOR = document.getElementById("kp-operator");

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

try {
  OPERATOR.value = localStorage.getItem("lpos-kiosk-operator") || "";
} catch {
  // storage blocked: type the name each time
}
OPERATOR.addEventListener("change", () => {
  try {
    localStorage.setItem("lpos-kiosk-operator", OPERATOR.value.trim());
  } catch {
    // ignore
  }
});

async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json" },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `${res.status} ${res.statusText}`);
  }
  return data;
}

function cardHtml(q) {
  const waiting = q.status === "claimed" || q.status === "error" ||
    q.status === "pending";
  const via = q.method === "square" ? "Cash App Pay (Square)" : "Cash App link";
  const meta = [
    via,
    q.kioskId || "kiosk",
    `started ${when(q.createdAt)}`,
    q.claimedAt ? `customer said paid ${when(q.claimedAt)}` : "",
    q.paidAt ? `paid ${when(q.paidAt)}` : "",
    q.confirmedBy ? `by ${q.confirmedBy}` : "",
  ].filter(Boolean).join(" · ");
  const items = q.items.map((i) =>
    `<li>${esc(i.name || `Sample ${i.sampleId}`)}: ${money(i.priceCents)}${
      i.priced ? "" : " (default price)"
    }</li>`
  ).join("");
  return `<div class="kp-card" data-id="${esc(q.id)}">
    <div class="kp-row">
      <span class="kp-amount">${money(q.amountCents)}</span>
      <span class="kp-badge kp-badge-${esc(q.status)}">${esc(q.status)}</span>
    </div>
    <p class="ks-muted ks-small">${esc(meta)}</p>
    <ul class="kp-items">${items}</ul>
    ${
    q.providerPaymentId
      ? `<p class="ks-muted ks-small">Square payment ${
        esc(q.providerPaymentId)
      }</p>`
      : ""
  }
    ${q.lastError ? `<p class="kp-error ks-small">${esc(q.lastError)}</p>` : ""}
    ${
    waiting
      ? `<div class="kp-actions">
          <button class="ks-btn ks-btn-cash" type="button" data-act="confirm">Confirm paid</button>
          <button class="ks-btn" type="button" data-act="reject">Reject</button>
        </div>`
      : ""
  }
  </div>`;
}

async function load() {
  LIST.innerHTML = `<p class="ks-muted">Loading…</p>`;
  try {
    const rows = await api(
      `/api/kiosk/quotes?status=${encodeURIComponent(FILTER.value)}`,
    );
    LIST.innerHTML = rows.length
      ? rows.map(cardHtml).join("")
      : `<p class="ks-muted">Nothing here.</p>`;
  } catch (error) {
    LIST.innerHTML = `<p class="kp-error">${esc(error.message)}</p>`;
  }
}

LIST.addEventListener("click", async (e) => {
  const btn = e.target instanceof Element
    ? e.target.closest("[data-act]")
    : null;
  if (!btn) return;
  const card = btn.closest("[data-id]");
  const id = card?.getAttribute("data-id");
  const act = btn.getAttribute("data-act");
  if (!id || !act) return;
  const amount = card.querySelector(".kp-amount")?.textContent || "";
  const question = act === "confirm"
    ? `Did ${amount} arrive in Cash App? Confirming marks these items sold.`
    : "Reject this payment and put the items back on sale?";
  if (!globalThis.confirm(question)) return;
  btn.disabled = true;
  try {
    await api(`/api/kiosk/quotes/${encodeURIComponent(id)}/${act}`, {
      method: "POST",
      body: JSON.stringify({ operator: OPERATOR.value.trim() || "staff" }),
    });
    await load();
  } catch (error) {
    btn.disabled = false;
    globalThis.alert(error.message);
  }
});

FILTER.addEventListener("change", load);
document.getElementById("kp-refresh").addEventListener("click", load);
setInterval(() => {
  if (FILTER.value === "claimed,error") load();
}, 30000);
load();
