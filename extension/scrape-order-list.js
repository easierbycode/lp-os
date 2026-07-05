// Buyer-side order LIST scraper (inventory feed):
//   https://www.tiktok.com/shop/order_list
// Emits one row per order card — store, ordered-on date, status, and the
// product name(s) (read from each product image's alt text, the only place the
// name appears on this page). The list page exposes NO prices and NO order IDs,
// so this is purely a "what orders exist" feed; the Default price lives on the
// order_detail page (see scrape-order.js). Graylog-only, relay-through-background.
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-orders-list';

  // Logged-in account that owns this order list, from the Modern.js SSR blob.
  // A DISPLAY NAME (`user_nick_name`), not an @handle — one buyer owns the page,
  // so the top-level `_creator` covers the whole feed. See scrape-order.js.
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

  var cards = document.querySelectorAll(
    'div.flex.flex-col.gap-12.background-color-UIPageFlat1.p-16.rounded-6.cursor-pointer.shadow'
  );
  if (!cards.length) {
    console.warn('[tok-scrape:orders-list] no order cards found; page not ready or DOM changed');
    return;
  }

  var orders = [];
  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var storeEl  = card.querySelector('.H4-Semibold.text-color-UIText1');
    var dateEl   = card.querySelector('.P3-Regular.text-color-UIText2');
    var statusEl = card.querySelector('.H4-Bold.text-color-UIText1');

    var products = [];
    var imgs = card.querySelectorAll('div.relative.flex-shrink-0.w-80.h-80 img[alt]');
    for (var pi = 0; pi < imgs.length; pi++) {
      var alt = clean(imgs[pi].getAttribute('alt'));
      if (alt) products.push(alt);
    }

    orders.push({
      store:    storeEl  ? clean(storeEl.textContent)  : '',
      date:     dateEl   ? clean(dateEl.textContent)   : '',
      status:   statusEl ? clean(statusEl.textContent) : '',
      products: products
    });
  }

  var payload = {
    page:       'Order List',
    orderCount: orders.length,
    orders:     orders,
    scrapedAt:  new Date().toISOString()
  };
  console.log('[tok-scrape:orders-list]', payload);

  if (GRAYLOG_ENDPOINT) {
    // Same Lucene 32,766-byte keyword cap guard as scrape-live.js: a long order
    // history with many products could exceed it; omit the blob if so and leave
    // _order_count as the queryable summary.
    var MAX_GELF_KEYWORD_BYTES = 30000;
    var safeJson = function (v) {
      var s = JSON.stringify(v);
      var bytes = new TextEncoder().encode(s).length;
      return bytes > MAX_GELF_KEYWORD_BYTES ? null : s;
    };
    var ordersJson = safeJson(orders);

    var gelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok orders list: ' + orders.length + ' orders',
      timestamp: Math.floor(Date.now() / 1000),
      _order_count: orders.length,
      _scrapedAt:   payload.scrapedAt,
      _creator:      orderCreator,
      _creator_kind: 'display_name',
      _graylog_key: GRAYLOG_TOKEN
    };
    if (ordersJson !== null) gelf._orders_json = ordersJson;
    else gelf._orders_json_omitted = 'too large for index (>' + MAX_GELF_KEYWORD_BYTES + ' bytes)';

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
})();
