// Seller-side Product Analytics scraper — isolated-world relay half.
//   shop.tiktok.com/streamer/compass/product-analysis/view
//
// Pairs with scrape-product-main.js, which background.js injects into the
// page's MAIN world. That half hooks the product-analytics list API and
// window.postMessages one payload per page (see it for why the network hook is
// required). This half runs in the extension's isolated world, so it holds
// TOK_CONFIG (from config.js) and can reach chrome.runtime — it stamps the
// Graylog token onto each page and forwards it to the background service
// worker, which POSTs it where the page CSP can't. Graylog only: the product
// rows aren't mirrored to the Sheets sink the other seller scrapers use.
(function () {
  'use strict';

  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-product-analysis';
  var MSG = 'tok-scrape-product';

  // "May 20, 2026" → "2026-05-20". OpenSearch dynamically mapped date_start/
  // date_end as type=date from earlier scrapers' ISO values, so the formatted
  // strings the picker renders would be rejected at index time. Local
  // components avoid the UTC day-shift toISOString() would introduce. Mirrors
  // scrape-streamer.js.
  var toISODate = function (s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  };

  var sendGelf = function (payload) {
    chrome.runtime.sendMessage({ source: 'tok-scrape', type: 'gelf', endpoint: GRAYLOG_ENDPOINT, payload: payload }, function (resp) {
      if (chrome.runtime.lastError) console.warn('[graylog] post failed', chrome.runtime.lastError.message);
      else if (resp && resp.ok) console.log('[graylog] sent', resp.status);
      else console.warn('[graylog] post failed', resp && (resp.error || resp.status));
    });
  };

  var onPage = function (m) {
    var dr = m.dateRange || {};
    var rows = m.rows || [];
    console.log('[tok-scrape:product] page ' + m.page + '/' + m.pagesTotal + ' — ' + rows.length + ' products');

    if (GRAYLOG_ENDPOINT) {
      sendGelf({
        version: '1.1',
        host: GRAYLOG_HOST,
        short_message: 'tiktok product-analysis scrape: ' + (m.creator || m.pageTitle || 'unknown') +
          ' page ' + m.page + ' (' + rows.length + ' products)',
        timestamp: Math.floor(Date.now() / 1000),
        _creator:         m.creator,
        _page:            m.pageTitle,
        _date_label:      m.dateLabel,
        _date_start:      toISODate(dr.start),
        _date_end:        toISODate(dr.end),
        _scrapedAt:       m.scrapedAt,
        _page_num:        m.page,
        _page_size:       m.pageSize,
        _pages_total:     m.pagesTotal,
        _total_products:  m.totalProducts,
        _rows_count:      rows.length,
        _columns_json:    JSON.stringify(m.columns || []),
        _rows_json:       JSON.stringify(rows),
        _graylog_key:     GRAYLOG_TOKEN
      });
    }
  };

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== MSG) return;
    if (d.kind === 'page')       onPage(d);
    else if (d.kind === 'error') console.warn('[tok-scrape:product] main-world error:', d.message || d);
    else if (d.kind === 'done')  console.log('[tok-scrape:product] done');
  }, false);

  console.log('[tok-scrape:product] relay ready');
})();
