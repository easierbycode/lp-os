// Seller-side LIVE Dashboard scraper:
//   shop.tiktok.com/workbench/live/overview?room_id=<id>&region=<region>
// Pulls per-session KPIs (GMV, Items sold, Viewers), the Performance trends
// carousel (Impressions / Views / GMV per hour / etc.), the Traffic source
// breakdown, and the Product List ranking.
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-live';
  var SHEET_ENDPOINT   = CFG.SHEET_ENDPOINT;
  var SHEET_TOKEN      = CFG.SHEET_TOKEN;

  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  var pageTitleEl = document.querySelector('.font-medium.text-xl.leading-9');
  var pageTitle = pageTitleEl ? clean(pageTitleEl.textContent) : '';

  var shop = '';
  document.querySelectorAll('.flex.items-center.ml-7').forEach(function (el) {
    if (shop) return;
    if (!el.querySelector('img[alt="avatar"]')) return;
    var t = el.querySelector('.truncate');
    if (t) shop = clean(t.textContent);
  });

  var roomId = '';
  var rm = location.href.match(/[?&]room_id=(\d+)/);
  if (rm) roomId = rm[1];

  var duration = '';
  var sessionRange = '';
  document.querySelectorAll('.text-neutral-text-1.text-base.leading-6.font-medium').forEach(function (el) {
    var t = clean(el.textContent);
    if (!t) return;
    if (/^\d+h\d+m/.test(t) || /^\d+m\d+s/.test(t) || /^\d+s$/.test(t)) {
      if (!duration) duration = t;
    } else if (/-/.test(t) && /[A-Z][a-z]{2}\s/.test(t)) {
      if (!sessionRange) sessionRange = t;
    }
  });

  var gmv = '';
  var odoBlock = document.querySelector('.ecom-screen-animated-number-container');
  if (odoBlock) {
    var digits = [];
    odoBlock.querySelectorAll('.odometer-value').forEach(function (d) {
      digits.push(clean(d.textContent));
    });
    gmv = digits.join('');
  }

  var statValue = function (stat) {
    return stat ? clean(stat.textContent) : '';
  };

  var sideKpis = {};
  document.querySelectorAll('.bg-state-normal').forEach(function (badge) {
    var labelEl = badge.querySelector('.text-xl.font-medium.text-neutral-text-1.ml-1');
    if (!labelEl) return;
    var label = clean(labelEl.textContent);
    if (!label) return;
    var value = statValue(badge.querySelector('.arco-statistic-value'));
    sideKpis[label] = value;
  });

  var perfMap = {};
  document.querySelectorAll('.arco-col').forEach(function (col) {
    var labelEl = col.querySelector('.text-base.text-neutral-text-1.truncate');
    var valueEl = col.querySelector('.arco-statistic-value');
    if (!labelEl || !valueEl) return;
    var label = clean(labelEl.textContent);
    if (!label || perfMap[label] != null) return;
    perfMap[label] = statValue(valueEl);
  });
  var performance = Object.keys(perfMap).map(function (k) {
    return { name: k, value: perfMap[k] };
  });

  var findSectionTable = function (headerText) {
    var header = null;
    document.querySelectorAll('.text-xl.font-medium').forEach(function (el) {
      if (header) return;
      if (clean(el.textContent).indexOf(headerText) === 0) header = el;
    });
    if (!header) return null;
    var node = header;
    for (var i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      var tbl = node.querySelector('.arco-table');
      if (tbl) return tbl;
    }
    return null;
  };

  var cellText = function (td) {
    if (!td) return '';
    var inner = td.querySelector('.arco-table-cell-wrap-value');
    return inner ? clean(inner.textContent) : '';
  };

  var trafficSources = [];
  var trafficTable = findSectionTable('Traffic source');
  if (trafficTable) {
    var headers = [];
    trafficTable.querySelectorAll('thead .arco-table-th-item-title').forEach(function (h) {
      headers.push(clean(h.textContent));
    });
    trafficTable.querySelectorAll('tbody tr.arco-table-tr').forEach(function (tr) {
      var tds = tr.querySelectorAll('td.arco-table-td');
      if (tds.length !== 4) return;
      var first = tds[0];
      if (first.getAttribute('colspan') !== '1') return;
      if (first.querySelector('.arco-progress')) return;
      trafficSources.push({
        Channel:     cellText(tds[0]),
        GMV:         cellText(tds[1]),
        Impressions: cellText(tds[2]),
        Views:       cellText(tds[3])
      });
    });
    if (headers.length === 4) {
      trafficSources._headers = headers;
    }
  }

  var products = [];
  var productTable = findSectionTable('Product List');
  if (productTable) {
    var pHeaders = [];
    productTable.querySelectorAll('thead .arco-table-th-item-title').forEach(function (h) {
      var inner = h.querySelector('.text-wrap, .line-clamp-3');
      pHeaders.push(clean(inner ? inner.textContent : h.textContent));
    });
    productTable.querySelectorAll('tbody tr.arco-table-tr').forEach(function (tr) {
      var tds = tr.querySelectorAll('td.arco-table-td');
      if (tds.length < 2) return;
      var fixedCell = tds[0];
      var nameLink = fixedCell.querySelector('a[href*="/view/product/"]');
      var idEl     = fixedCell.querySelector('span.opacity-50');
      var productName = nameLink ? clean(nameLink.textContent) : '';
      var productHref = nameLink ? nameLink.getAttribute('href') : '';
      var productId   = '';
      if (idEl) {
        productId = clean(idEl.textContent.replace(/^\s*ID:\s*/, ''));
      }
      if (!productId && productHref) {
        var pm = productHref.match(/\/view\/product\/(\d+)/);
        if (pm) productId = pm[1];
      }
      var rowMetrics = [];
      for (var i = 1; i < tds.length; i++) {
        rowMetrics.push(cellText(tds[i]));
      }
      products.push({
        'Product ID':   productId,
        'Product name': productName,
        'Product link': productHref,
        'Metrics':      rowMetrics
      });
    });
    if (pHeaders.length) products._headers = pHeaders;
  }

  var payload = {
    page:           pageTitle,
    shop:           shop,
    roomId:         roomId,
    duration:       duration,
    sessionRange:   sessionRange,
    scrapedAt:      new Date().toISOString(),
    gmv:            gmv,
    sideKpis:       sideKpis,
    performance:    performance,
    trafficSources: trafficSources,
    products:       products
  };
  console.log('[tok-scrape:live]', payload);

  if (SHEET_ENDPOINT) {
    chrome.runtime.sendMessage({
      source: 'tok-scrape',
      type:   'sheet',
      endpoint: SHEET_ENDPOINT,
      payload: {
        token:          SHEET_TOKEN,
        page:           payload.page,
        shop:           payload.shop,
        roomId:         payload.roomId,
        duration:       payload.duration,
        sessionRange:   payload.sessionRange,
        scrapedAt:      payload.scrapedAt,
        gmv:            payload.gmv,
        sideKpis:       payload.sideKpis,
        performance:    payload.performance,
        trafficSources: payload.trafficSources,
        products:       payload.products
      }
    }, function (resp) {
      if (chrome.runtime.lastError) {
        console.warn('[sheet] post failed', chrome.runtime.lastError.message);
      } else if (resp && resp.ok) {
        console.log('[sheet]', resp.body || resp.status);
      } else {
        console.warn('[sheet] post failed', resp && (resp.error || resp.status));
      }
    });
  }

  if (GRAYLOG_ENDPOINT) {
    // Graylog stores custom GELF additional fields as OpenSearch `keyword`,
    // and Lucene caps a single keyword term at 32,766 bytes. A long product
    // list blows that limit (~50KB for ~140 products) — the GELF input still
    // returns 202, but OpenSearch then rejects the entire document at index
    // time, so the message never appears in search. Sheets gets the full
    // payload, so for the GELF copy we just omit any blob that would trip
    // the limit and leave the *_count fields as the queryable summary.
    //
    // Threshold is conservative: Lucene's 32766 minus headroom for UTF-8
    // expansion of multi-byte characters (emoji, CJK in product titles).
    var MAX_GELF_KEYWORD_BYTES = 30000;
    var safeJson = function (v) {
      var s = JSON.stringify(v);
      // Byte length, not char length — Lucene checks UTF-8 size.
      var bytes = new TextEncoder().encode(s).length;
      return bytes > MAX_GELF_KEYWORD_BYTES ? null : s;
    };
    var sideKpisJson  = safeJson(payload.sideKpis);
    var perfJson      = safeJson(payload.performance);
    var trafficJson   = safeJson(payload.trafficSources);
    var productsJson  = safeJson(payload.products);

    var gelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok live scrape: ' + (shop || 'unknown') + ' (' + products.length + ' products, gmv=' + (gmv || '?') + ')',
      timestamp: Math.floor(Date.now() / 1000),
      _page:                 payload.page,
      _shop:                 payload.shop,
      _room_id:              payload.roomId,
      _duration:             payload.duration,
      _session_range:        payload.sessionRange,
      _scrapedAt:            payload.scrapedAt,
      _gmv:                  payload.gmv,
      _performance_count:    payload.performance.length,
      _traffic_count:        payload.trafficSources.length,
      _products_count:       payload.products.length,
      _graylog_key:          GRAYLOG_TOKEN
    };
    if (sideKpisJson !== null) gelf._side_kpis_json       = sideKpisJson;
    if (perfJson     !== null) gelf._performance_json     = perfJson;
    if (trafficJson  !== null) gelf._traffic_sources_json = trafficJson;
    if (productsJson !== null) gelf._products_json        = productsJson;
    else gelf._products_json_omitted = 'too large for index (>' + MAX_GELF_KEYWORD_BYTES + ' bytes); see Sheets';
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
