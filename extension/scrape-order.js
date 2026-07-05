// Buyer-side order DETAIL scraper:
//   https://www.tiktok.com/shop/order_detail?main_order_id=<id>
// Extracts every line item (product, variant, unit price, strike price, qty),
// order-level fields (orderId, store, status, order info, totals), and surfaces
// the "Default" variant's unit price as the headline value (e.g. 62.89).
// Graylog-only, mirroring the other seller scrapers' relay-through-background
// pattern (see scrape-data-overview.js). Assumes the page is already mounted —
// the cross-page navigation from the orders list lives in the orchestrator
// (run-partner-center-bookmarklet skill), not here.
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-orders';

  // The logged-in account that placed/owns this order, from the Modern.js SSR
  // blob. NOTE: order pages carry only a DISPLAY NAME (`user_nick_name`, e.g.
  // "Neon Deals"), not the `@unique_id` the other scrapers emit — so this is a
  // name, not an @handle. Stamped as `_creator` with `_creator_kind` so the
  // dashboard can name-match it (the lifecycle assigned-creator dropdown is fed
  // by matching the product NAME, since orders carry no numeric product id).
  var orderCreator = '';
  try {
    var ssrEl = document.getElementById('__MODERN_ROUTER_DATA__') ||
                document.getElementById('__MODERN_SSR_DATA__');
    if (ssrEl) {
      var ssrMatch = (ssrEl.textContent || '').match(/"user_nick_name":"([^"]+)"/);
      if (ssrMatch) orderCreator = ssrMatch[1];
    }
  } catch (e) { /* SSR blob absent/changed — leave creator empty */ }

  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  // "$62.89" -> 62.89 (number); "" / unparseable -> null (never NaN, so the
  // OpenSearch numeric mapping behind these GELF fields never breaks).
  var money = function (s) {
    if (!s) return null;
    var m = clean(s).replace(/[^0-9.]/g, '');
    if (!m) return null;
    var n = parseFloat(m);
    return isNaN(n) ? null : n;
  };

  // Readiness guard: the product/price block must be mounted. Bail loudly rather
  // than silent-retry (matches the skill's no-silent-retry guardrail).
  var firstItemImg = document.querySelector('img.w-90.h-90.object-cover.rounded-4[alt]');
  if (!firstItemImg) {
    console.warn('[tok-scrape:order] product block not found; page not ready or DOM changed');
    return;
  }

  // --- Line items (orders can hold several products) -----------------------
  // Each product row is the `div.flex.gap-16` that wraps the 90x90 image plus
  // its text/price column. Scope every lookup under that row so a 2-item order
  // never bleeds item-1's price into item-2. The unit-price (.text-color-UIText1)
  // and qty (.text-color-UIText2) divs share `.H4-Semibold` and differ by a
  // single digit, so both are read from inside the per-item price row only.
  var lineItems = [];
  var itemImgs = document.querySelectorAll('img.w-90.h-90.object-cover.rounded-4[alt]');
  for (var ii = 0; ii < itemImgs.length; ii++) {
    var img = itemImgs[ii];
    var row = img.closest('.flex.gap-16') || img.parentElement;
    if (!row) continue;
    var titleEl   = row.querySelector('.P1-Regular.text-color-UIText1');
    var variantEl = row.querySelector('.P2-Regular.text-color-UIText3');
    var priceRow  = row.querySelector('.flex.justify-between.items-center');
    var unitEl    = priceRow ? priceRow.querySelector('.H4-Semibold.text-color-UIText1') : null;
    var strikeEl  = priceRow ? priceRow.querySelector('.H4-Regular.text-color-UIText3.line-through') : null;
    var qtyEl     = priceRow ? priceRow.querySelector('.H4-Semibold.text-color-UIText2') : null;

    var unitText   = unitEl   ? clean(unitEl.textContent)   : '';
    var strikeText = strikeEl ? clean(strikeEl.textContent) : '';
    var qtyText    = qtyEl    ? clean(qtyEl.textContent)    : ''; // e.g. "x1"
    lineItems.push({
      productName:     titleEl ? clean(titleEl.textContent) : clean(img.getAttribute('alt')),
      productAlt:      clean(img.getAttribute('alt')),
      variant:         variantEl ? clean(variantEl.textContent) : '',
      unitPriceText:   unitText,
      unitPrice:       money(unitText),
      strikePriceText: strikeText,
      strikePrice:     money(strikeText),
      qtyText:         qtyText,
      qty:             qtyText ? (parseInt(qtyText.replace(/[^0-9]/g, ''), 10) || null) : null
    });
  }

  // Headline "Default price": the unit price of the item whose variant label is
  // "Default" (fallback: the sole/first item if no literal "Default" label).
  var defaultItem = null;
  for (var di = 0; di < lineItems.length; di++) {
    if ((lineItems[di].variant || '').toLowerCase() === 'default') { defaultItem = lineItems[di]; break; }
  }
  if (!defaultItem && lineItems.length) defaultItem = lineItems[0];
  var defaultPrice       = defaultItem ? defaultItem.unitPrice : null;
  var defaultProductName = defaultItem ? defaultItem.productName : '';
  var defaultVariant     = defaultItem ? defaultItem.variant : '';

  // --- Order-level label/value rows ----------------------------------------
  // The Order-info card and the Totals card both render rows as
  // `div.flex.justify-between.items-center` with a leaf label div + a value div.
  // The product price row uses the same wrapper, but its first child holds the
  // price cluster as nested elements, so skip any row whose label has element
  // children — that isolates the price row out cleanly.
  var readKeyValues = function () {
    var out = {};
    var rows = document.querySelectorAll('.flex.justify-between.items-center');
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      var label = row.firstElementChild;
      var value = row.lastElementChild;
      if (!label || !value || label === value) continue;
      if (label.childElementCount > 0) continue; // price row (nested cluster), skip
      var key = clean(label.textContent);
      if (!key) continue;
      if (out[key] == null) out[key] = clean(value.textContent);
    }
    return out;
  };
  var kv = readKeyValues();

  var orderId = '';
  var om = location.href.match(/[?&]main_order_id=(\d+)/);
  if (om) orderId = om[1];
  if (!orderId) orderId = kv['Order ID'] || ''; // DOM fallback (file:// fixture has no query string)

  var storeEl  = document.querySelector('.H4-Bold.text-color-UIText1');
  var store    = storeEl ? clean(storeEl.textContent) : '';
  var statusEl = document.querySelector('.H3-Bold.text-color-UIText1');
  var status   = statusEl ? clean(statusEl.textContent) : '';

  var orderPlacedLine = '';
  var subLines = document.querySelectorAll('.P2-Regular.text-color-UIText3');
  for (var si = 0; si < subLines.length && !orderPlacedLine; si++) {
    var t = clean(subLines[si].textContent);
    if (/order placed/i.test(t)) orderPlacedLine = t;
  }

  var orderInfo = {
    orderDate:     kv['Order date']     || '',
    paymentMethod: kv['Payment method'] || '',
    paymentTime:   kv['Payment time']   || '',
    deliveryDate:  kv['Delivery date']  || ''
  };
  var totals = {
    subtotal: money(kv['Subtotal']),
    salesTax: money(kv['Sales tax']),
    shipping: money(kv['Shipping']),
    total:    money(kv['Total'])
  };

  var payload = {
    page:               'Order Detail',
    orderId:            orderId,
    store:              store,
    status:             status,
    orderPlaced:        orderPlacedLine,
    orderInfo:          orderInfo,
    totals:             totals,
    lineItemCount:      lineItems.length,
    lineItems:          lineItems,
    defaultProductName: defaultProductName,
    defaultVariant:     defaultVariant,
    defaultPrice:       defaultPrice, // the user's headline value (e.g. 62.89)
    scrapedAt:          new Date().toISOString()
  };
  console.log('[tok-scrape:order]', payload);

  // Numeric product ids only exist in the page's data fetch, captured by the
  // MAIN-world hook (scrape-order-main.js, installed at document_start). Request
  // them, match by product NAME, stamp _product_id, then send. Times out to
  // name-match-only (source 'none') so a missing/SSR-only API never blocks.
  function resolveProductIds(cb) {
    var done = false;
    function finish(items) {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      cb(items || []);
    }
    function onMsg(ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.source !== 'tok-scrape-order' || d.kind !== 'ids') return;
      finish(d.items || []);
    }
    window.addEventListener('message', onMsg, false);
    try {
      window.postMessage({ source: 'tok-scrape-order', kind: 'request' }, window.location.origin);
    } catch (e) { /* MAIN hook absent — timeout falls back to name-match */ }
    setTimeout(function () { finish([]); }, 1200);
  }

  function matchProductId(name, items) {
    var n = clean(name).toLowerCase();
    if (!n) return '';
    for (var i = 0; i < items.length; i++) {
      var inm = clean(items[i].name).toLowerCase();
      if (inm && (inm === n || inm.indexOf(n) !== -1 || n.indexOf(inm) !== -1)) {
        return items[i].productId;
      }
    }
    return '';
  }

  function sendGelf(productId, productIdSource) {
    if (!GRAYLOG_ENDPOINT) return;
    // Graylog stores GELF additional fields as OpenSearch `keyword`, and Lucene
    // caps a single keyword term at 32,766 bytes. An order's line-item array is
    // tiny, but guard it the same way scrape-live.js does for safety.
    var MAX_GELF_KEYWORD_BYTES = 30000;
    var safeJson = function (v) {
      var s = JSON.stringify(v);
      var bytes = new TextEncoder().encode(s).length;
      return bytes > MAX_GELF_KEYWORD_BYTES ? null : s;
    };
    var lineItemsJson = safeJson(lineItems);

    var gelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok order scrape: ' + (store || 'unknown') + ' #' + (orderId || '?') +
                     ' default=' + (defaultPrice != null ? defaultPrice : '?') +
                     ' (' + lineItems.length + ' items)',
      timestamp: Math.floor(Date.now() / 1000),
      _order_id:         orderId,
      _store:            store,
      _status:           status,
      _default_product:  defaultProductName,
      _default_variant:  defaultVariant,
      _default_price:    defaultPrice,
      _line_item_count:  lineItems.length,
      _order_total:      totals.total,
      _subtotal:         totals.subtotal,
      _sales_tax:        totals.salesTax,
      _shipping:         totals.shipping,
      _order_date:       orderInfo.orderDate,
      _scrapedAt:        payload.scrapedAt,
      _creator:          orderCreator,
      _creator_kind:     'display_name',
      _product_id:       productId,
      _product_id_source: productIdSource,
      _graylog_key:      GRAYLOG_TOKEN
    };
    if (lineItemsJson !== null) gelf._line_items_json = lineItemsJson;
    else gelf._line_items_json_omitted = 'too large for index (>' + MAX_GELF_KEYWORD_BYTES + ' bytes)';

    chrome.runtime.sendMessage({
      source: 'tok-scrape',
      type:   'gelf',
      endpoint: GRAYLOG_ENDPOINT,
      payload: gelf
    }, function (resp) {
      if (chrome.runtime.lastError) {
        console.warn('[graylog] post failed', chrome.runtime.lastError.message);
      } else if (resp && resp.ok) {
        console.log('[graylog] sent', resp.status);
      } else {
        console.warn('[graylog] post failed', resp && (resp.error || resp.status));
      }
    });
  }

  // Synthetic product id for an order line with no real numeric id. FNV-1a over
  // the cleaned product name, "900"-prefixed — byte-identical to
  // extension-creator-demo's persistedProductId() AND data-pimp's stableProductId()
  // (core/samples.ts), so an order event lands in the SAME id space the rest of
  // the system uses for id-less products (the live order_list scraper has always
  // identified products this way). The MAIN-world hook upgrades to a real id when
  // the page actually exposes one.
  function stableProductId(name) {
    var s = clean(name);
    if (!s) return '';
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return '900' + String(h >>> 0).padStart(10, '0');
  }

  resolveProductIds(function (items) {
    // Each line item gets its captured real id, else the synthetic name-hash id.
    for (var li = 0; li < lineItems.length; li++) {
      var realPid = matchProductId(lineItems[li].productName, items) ||
                    matchProductId(lineItems[li].productAlt, items);
      lineItems[li].productId = realPid || stableProductId(lineItems[li].productName);
    }
    var realDefault = matchProductId(defaultProductName, items);
    if (realDefault) {
      sendGelf(realDefault, 'order-api');
    } else {
      var synth = stableProductId(defaultProductName);
      sendGelf(synth, synth ? 'name-hash' : 'none');
    }
  });
})();
