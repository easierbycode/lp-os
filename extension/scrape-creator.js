// Partner Center Custom Report scraper.
// Injected by background.js on partner.us.tiktokshop.com/compass/custom-report
// (and the legacy /creator-analysis URL, which redirects there).
//
// Two-phase scrape: first captures the default multi-dimension table across
// pages 1-4 at 50 rows/page (17 metric columns), then unchecks every
// dimension except Creator, re-runs Search, and captures the Creator-only
// single-row breakdown (25 metric columns). Both payloads go to Graylog.
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-custom-report';

  var DIM_LABELS = ['Creator', 'LIVE', 'Video', 'Product', 'Shop', 'Product category'];
  var KEEP_DIM   = 'Creator';
  var TARGET_PAGES = 4;
  var TARGET_PAGE_SIZE = 50;

  var clean = function (s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var waitFor = async function (fn, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      try { var v = fn(); if (v) return v; } catch (_) {}
      await sleep(150);
    }
    return null;
  };

  var getDateRange = function () {
    var startEl = document.querySelector('input[placeholder="Start date"]');
    var endEl   = document.querySelector('input[placeholder="End date"]');
    return { start: startEl ? startEl.value || '' : '', end: endEl ? endEl.value || '' : '' };
  };

  // Each Arco th nests the column header AND the summary cell inside the same
  // .arco-table-th-item-title span, so th.innerText is "Header" + "SummaryValue"
  // smashed together. Pull them apart by walking the two child blocks.
  var readHeadersAndSummary = function () {
    var ths = document.querySelectorAll('thead th');
    var headers = [];
    var summary = [];
    ths.forEach(function (th) {
      var titleSpan = th.querySelector('.arco-table-th-item-title');
      if (!titleSpan) { headers.push(clean(th.textContent)); summary.push(''); return; }
      var inner = titleSpan.firstElementChild;
      var blocks = inner ? inner.children : [];
      var hdrEl = blocks[0] && blocks[0].querySelector('.text-neutral-text1');
      headers.push(hdrEl ? clean(hdrEl.textContent) : clean(blocks[0] && blocks[0].textContent));
      summary.push(blocks[1] ? clean(blocks[1].textContent) : '');
    });
    return { headers: headers, summary: summary };
  };

  var readRows = function (headers) {
    var trs = document.querySelectorAll('tbody tr.arco-table-tr');
    var out = [];
    trs.forEach(function (tr) {
      var tds = tr.querySelectorAll('td');
      var row = {};
      headers.forEach(function (h, i) { row[h] = tds[i] ? clean(tds[i].textContent) : ''; });
      out.push(row);
    });
    return out;
  };

  var getActivePage = function () {
    var items = document.querySelectorAll('.arco-pagination-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains('arco-pagination-item-active')) {
        var n = parseInt(items[i].textContent.trim(), 10);
        return isNaN(n) ? null : n;
      }
    }
    return null;
  };

  var goToPage = async function (n) {
    var items = document.querySelectorAll('.arco-pagination-item');
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent.trim() === String(n)) { items[i].click(); break; }
    }
    return await waitFor(function () { return getActivePage() === n; }, 15000);
  };

  // Open the page-size dropdown and pick the "50/Page" item.
  var setPageSize = async function (size) {
    var sizeBtn = document.querySelector('.arco-pagination-options .arco-select-view, .arco-pagination-size-option');
    if (!sizeBtn) return false;
    if (clean(sizeBtn.textContent).indexOf(size + '/Page') !== -1) return true;
    sizeBtn.click();
    var item = await waitFor(function () {
      var opts = document.querySelectorAll('.arco-select-option, .arco-dropdown-option');
      for (var i = 0; i < opts.length; i++) {
        if (clean(opts[i].textContent) === size + '/Page') return opts[i];
      }
      return null;
    }, 5000);
    if (!item) return false;
    item.click();
    return await waitFor(function () {
      var trs = document.querySelectorAll('tbody tr.arco-table-tr');
      return trs.length > 20 || getActivePage() === 1;
    }, 10000);
  };

  var findDimCheckbox = function (label) {
    var labels = document.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (clean(labels[i].textContent) === label) {
        return labels[i].querySelector('input[type="checkbox"]');
      }
    }
    return null;
  };

  var setDimensions = function (keep) {
    DIM_LABELS.forEach(function (label) {
      var cb = findDimCheckbox(label);
      if (!cb || cb.disabled) return;
      var want = (label === keep);
      if (cb.checked !== want) cb.click();
    });
  };

  var dimensionState = function () {
    var out = {};
    DIM_LABELS.forEach(function (label) {
      var cb = findDimCheckbox(label);
      out[label] = cb ? !!cb.checked : null;
    });
    return out;
  };

  var clickSearch = async function () {
    var btn = null;
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (clean(btns[i].textContent) === 'Search') { btn = btns[i]; break; }
    }
    if (!btn) return false;
    btn.click();
    // Wait for the staleness banner to clear AND a tbody row to render.
    return await waitFor(function () {
      var stale = document.body.innerText.indexOf('This information is now outdated') !== -1;
      var trs = document.querySelectorAll('tbody tr.arco-table-tr');
      return !stale && trs.length > 0;
    }, 20000);
  };

  var postGelf = function (payload) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({
        source: 'tok-scrape',
        type:   'gelf',
        endpoint: GRAYLOG_ENDPOINT,
        payload: payload
      }, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false });
        }
      });
    });
  };

  (async function run () {
    if (!GRAYLOG_ENDPOINT) {
      console.warn('[tok-scrape:custom-report] missing GRAYLOG_ENDPOINT');
      return;
    }
    var headersReady = await waitFor(function () {
      return document.querySelectorAll('thead th').length > 0;
    }, 15000);
    if (!headersReady) { console.warn('[tok-scrape:custom-report] no table headers'); return; }

    await setPageSize(TARGET_PAGE_SIZE);
    if (getActivePage() !== 1) await goToPage(1);

    var scrapedAt = new Date().toISOString();
    var ts = Math.floor(Date.now() / 1000);
    var dateRange = getDateRange();
    var multiDims = dimensionState();

    // Phase 1: pages 1..N (capped at TARGET_PAGES) of the default view.
    var firstHs = readHeadersAndSummary();
    var pagesOut = [];
    var totalPages = (function () {
      var items = document.querySelectorAll('.arco-pagination-item');
      var max = 0;
      items.forEach(function (el) {
        var n = parseInt(el.textContent.trim(), 10);
        if (!isNaN(n) && n > max) max = n;
      });
      return max || 1;
    })();
    var lastPage = Math.min(TARGET_PAGES, totalPages);

    for (var p = 1; p <= lastPage; p++) {
      if (p !== 1) {
        var moved = await goToPage(p);
        if (!moved) { console.warn('[tok-scrape:custom-report] failed to load page', p); break; }
        await sleep(500);
      }
      var rows = readRows(firstHs.headers);
      pagesOut.push({ page: p, rows: rows });
      var pageGelf = {
        version: '1.1',
        host: GRAYLOG_HOST,
        short_message: 'tiktok scrape: custom-report multi-dim page ' + p + ' (' + rows.length + ' rows)',
        timestamp: ts,
        _scrapedAt:       scrapedAt,
        _mode:            'multi_dim',
        _dimensions_json: JSON.stringify(multiDims),
        _date_start:      dateRange.start,
        _date_end:        dateRange.end,
        _page:            p,
        _page_size:       TARGET_PAGE_SIZE,
        _pages_total:     lastPage,
        _rows_count:      rows.length,
        _columns_json:    JSON.stringify(firstHs.headers),
        _summary_json:    JSON.stringify(firstHs.summary),
        _rows_json:       JSON.stringify(rows),
        _graylog_key:     GRAYLOG_TOKEN
      };
      var r1 = await postGelf(pageGelf);
      console.log('[tok-scrape:custom-report] page', p, 'graylog', r1);
    }

    // Phase 2: keep only the Creator dimension, re-run Search, scrape the
    // single aggregated row that has the full 25-metric column set.
    setDimensions(KEEP_DIM);
    await sleep(300);
    var ran = await clickSearch();
    if (!ran) { console.warn('[tok-scrape:custom-report] creator-only search did not return'); return; }
    await sleep(500);

    var coHs = readHeadersAndSummary();
    var coRows = readRows(coHs.headers);
    var coDims = dimensionState();
    var coDateRange = getDateRange();
    var coGelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok scrape: custom-report creator-only (' + coRows.length + ' rows, ' + coHs.headers.length + ' columns)',
      timestamp: Math.floor(Date.now() / 1000),
      _scrapedAt:       new Date().toISOString(),
      _mode:            'creator_only',
      _dimensions_json: JSON.stringify(coDims),
      _date_start:      coDateRange.start,
      _date_end:        coDateRange.end,
      _rows_count:      coRows.length,
      _columns_json:    JSON.stringify(coHs.headers),
      _summary_json:    JSON.stringify(coHs.summary),
      _rows_json:       JSON.stringify(coRows),
      _graylog_key:     GRAYLOG_TOKEN
    };
    var r2 = await postGelf(coGelf);
    console.log('[tok-scrape:custom-report] creator-only graylog', r2);
  })().catch(function (e) { console.warn('[tok-scrape:custom-report] failed', e); });
})();
