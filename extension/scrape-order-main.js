// Buyer-side order DETAIL — MAIN-world numeric-productId capture.
//
// Why this exists: the order_detail DOM carries product NAMES but no numeric
// TikTok product id (confirmed — the SSR blob has only basic_info + main_order_id,
// and the line item is an <img> with a hash-CDN src). The id only appears in the
// page's own data fetch, observable solely from the page's MAIN world. Unlike the
// product-analytics scraper (which re-triggers its fetch via pagination), an order
// loads its data ONCE at page load — so this MUST run at document_start (it's a
// world:"MAIN", run_at:"document_start" content script in manifest.json) to hook
// fetch/XHR before that request fires. It buffers product {name -> id} pairs and
// hands them to the isolated-world scrape-order.js on request (postMessage).
//
// HONESTY: TikTok's order-detail API endpoint + response shape are NOT documented
// here, so the extractor is a robust *heuristic* — it recursively collects any
// object carrying a product-id-shaped field (product_id / productId / spu_id /
// product.id, 12+ digits) paired with a name. If a real order page uses a
// different shape, set localStorage.tokOrderDebug='1' to log captured payloads and
// refine. If order detail turns out to be pure SSR (no client fetch), nothing is
// captured and scrape-order.js cleanly falls back to name-match (no regression).
(function () {
  if (window.__tokOrderHook) return;
  window.__tokOrderHook = true;

  var MSG = "tok-scrape-order";
  var cap = (window.__tokOrderCap = window.__tokOrderCap || []);
  var MAX = 40;
  var debug = function () {
    try { return localStorage.getItem("tokOrderDebug") === "1"; } catch (e) { return false; }
  };

  function record(url, json) {
    if (debug()) {
      try { console.log("[tok-scrape:order-main] captured", url, json); } catch (e) {}
    }
    cap.push(json);
    if (cap.length > MAX) cap.shift();
  }

  // --- fetch + XHR capture (installed at document_start) -------------------
  var of = window.fetch;
  if (typeof of === "function") {
    window.fetch = function () {
      var url = "";
      try { url = String((arguments[0] && arguments[0].url) || arguments[0] || ""); } catch (e) {}
      return of.apply(this, arguments).then(function (resp) {
        try {
          var ct = resp.headers && resp.headers.get && resp.headers.get("content-type");
          if (!ct || ct.indexOf("json") !== -1) {
            resp.clone().json().then(function (j) { record(url, j); }).catch(function () {});
          }
        } catch (e) {}
        return resp;
      });
    };
  }
  var oOpen = XMLHttpRequest.prototype.open;
  var oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tokUrl = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener("load", function () {
      try {
        var ct = x.getResponseHeader && x.getResponseHeader("content-type");
        if (ct && ct.indexOf("json") === -1) return;
        var data = JSON.parse(x.responseText);
        record(String(x.__tokUrl || ""), data);
      } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };

  // --- extract product {name, id} pairs from captured JSON -----------------
  function digitsOf(v) {
    if (v == null) return "";
    var s = String(v).trim();
    return /^\d{12,}$/.test(s) ? s : "";
  }
  function collect(node, out, depth) {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) collect(node[i], out, depth + 1); return; }
    if (typeof node !== "object") return;
    var id = digitsOf(node.product_id) || digitsOf(node.productId) || digitsOf(node.spu_id) ||
             (node.product && typeof node.product === "object" ? digitsOf(node.product.id) : "");
    var name = node.product_name || node.productName || node.title || node.name;
    if (id && name) out.push({ productId: id, name: String(name).trim() });
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) collect(node[k], out, depth + 1);
    }
  }
  function extract() {
    var raw = [];
    for (var i = 0; i < cap.length; i++) collect(cap[i], raw, 0);
    var seen = {}, items = [];
    for (var j = 0; j < raw.length; j++) {
      var key = raw[j].productId + "|" + raw[j].name.toLowerCase();
      if (!seen[key]) { seen[key] = 1; items.push(raw[j]); }
    }
    return items;
  }

  // --- respond to the isolated-world scraper's request ---------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== MSG || d.kind !== "request") return;
    var items = extract();
    if (debug()) console.log("[tok-scrape:order-main] replying with", items.length, "product id(s)");
    window.postMessage({
      source: MSG,
      kind: "ids",
      items: items,
      productIds: items.map(function (it) { return it.productId; }),
    }, window.location.origin);
  }, false);

  if (debug()) console.log("[tok-scrape:order-main] capture installed");
})();
