// Seller-side Product Analytics scraper — MAIN-world half.
//   shop.tiktok.com/streamer/compass/product-analysis/view
//
// Why a network hook (and why it has to run in the page's MAIN world): the
// product table virtualizes its DOM to ~10 rows even at 50/Page, so scraping
// the <table> misses 40 of every 50 rows. The complete data arrives via
// POST .../api/v3/insights/creator/product/analytics/list, whose JSON carries
// the full page at data.segments[0].timed_lists[0].stats plus a
// next_pagination { total, total_page } block. fetch/XHR can only be hooked
// from the page's own JS world, so background.js injects this file with
// world:'MAIN'. It captures the responses, drives pagination to (re)trigger
// each page's request at 50/Page, maps the stats, and window.postMessages one
// payload per page to the isolated relay (scrape-product.js), which holds the
// Graylog/Sheets tokens and ships the data.
(function () {
  'use strict';

  var KEY = 'analytics' + '/' + 'list';   // substring of the list API path
  var MSG = 'tok-scrape-product';          // window.postMessage channel marker
  var TARGET_PAGES = 4;
  var TARGET_PAGE_SIZE = 50;
  var COLUMNS = ['Product', 'Product ID', 'GMV', 'Estimated commission', 'Items sold'];

  // Captured API responses accumulate here. Persisted on window so the hook
  // (installed once) and a re-run of this script share the same buffer.
  window.__tokCap = window.__tokCap || [];

  // Install the fetch + XHR capture once. The guard keeps a second action-click
  // from double-wrapping (which would push each response twice).
  if (!window.__tokProductHook) {
    window.__tokProductHook = true;
    var of = window.fetch;
    if (of) {
      window.fetch = function () {
        var args = arguments, self = this, url = '';
        try { url = (args[0] && args[0].url) ? args[0].url : String(args[0]); } catch (e) {}
        return of.apply(self, args).then(function (resp) {
          try {
            if (url.indexOf(KEY) !== -1) {
              resp.clone().json().then(function (j) { window.__tokCap.push(j); }).catch(function () {});
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
      this.addEventListener('load', function () {
        try {
          if (x.__tokUrl && String(x.__tokUrl).indexOf(KEY) !== -1) {
            var data = (x.responseType === 'json') ? x.response : JSON.parse(x.responseText);
            if (data) window.__tokCap.push(data);
          }
        } catch (e) {}
      });
      return oSend.apply(this, arguments);
    };
  }

  var clean = function (s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var waitFor = async function (fn, t) {
    var deadline = Date.now() + (t || 15000);
    while (Date.now() < deadline) {
      try { var v = fn(); if (v) return v; } catch (e) {}
      await sleep(120);
    }
    return null;
  };

  // Header context — same DOM is visible from the MAIN world. Selectors match
  // the other seller scrapers (scrape-streamer.js).
  var pageTitle = (function () {
    var th = document.querySelector('span.text-head-l.font-bold.text-neutral-text1');
    var s = th ? th.querySelector('span') : null;
    return clean(s ? s.textContent : (th ? th.textContent : ''));
  })();
  // The popup/shell selection is the authoritative creator scope. background.js
  // copies it into the MAIN world before injecting this file. Fall back to the
  // TikTok header for old extension builds and non-LP-OS use.
  var creator = (function () {
    var selected = clean(window.LPOS_USER || '');
    if (selected.charAt(0) === '@' && selected.length > 1) return selected;
    var avs = document.querySelectorAll('div.m4b-avatar');
    for (var i = 0; i < avs.length; i++) {
      var sib = avs[i].nextElementSibling;
      if (sib && sib.tagName === 'SPAN') {
        var raw = clean(sib.textContent);
        if (raw) return '@' + raw.replace(/^@/, '');
      }
    }
    return '';
  })();
  var startInput = document.querySelector('input[placeholder="Start date"]');
  var endInput   = document.querySelector('input[placeholder="End date"]');
  var dateRange  = { start: startInput ? startInput.value : '', end: endInput ? endInput.value : '' };
  var prefixEl   = document.querySelector('.arco-picker-prefix');
  var dateLabel  = prefixEl ? clean(prefixEl.textContent.replace(/:\s*$/, '')) : '';

  // Arco pagination controls (the table is zep-table, but the pager is arco).
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
    var clicked = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent.trim() === String(n)) {
        items[i].click();
        clicked = true;
        break;
      }
    }
    if (!clicked) return false;
    return await waitFor(function () { return getActivePage() === n; }, 15000);
  };
  // The page-size control is an m4b/arco select inside `.arco-pagination-option`
  // (singular) — not the `.arco-pagination-options` the docs imply. Options
  // ("20/Page", "50/Page") only render once the dropdown is opened.
  var setPageSize = async function (size) {
    var btn = document.querySelector('.arco-pagination-option .arco-select-view');
    if (!btn) return false;
    if (clean(btn.textContent).indexOf(size + '/Page') !== -1) return true;
    ['mousedown', 'mouseup', 'click'].forEach(function (t) { btn.dispatchEvent(new MouseEvent(t, { bubbles: true })); });
    var item = await waitFor(function () {
      var opts = document.querySelectorAll('.arco-select-option');
      for (var i = 0; i < opts.length; i++) {
        if (clean(opts[i].textContent) === size + '/Page') return opts[i];
      }
      return null;
    }, 5000);
    if (!item) return false;
    ['mousedown', 'mouseup', 'click'].forEach(function (t) { item.dispatchEvent(new MouseEvent(t, { bubbles: true })); });
    return await waitFor(function () { return getActivePage() === 1; }, 10000);
  };

  var amount = function (o) { return o ? (o.amount_formatted || o.amount || '') : ''; };

  // Pull the rows + pagination out of one captured list response.
  var pageData = function (capObj) {
    var seg = capObj && capObj.data && capObj.data.segments && capObj.data.segments[0];
    var np  = seg && seg.list_control && seg.list_control.next_pagination;
    var lst = seg && seg.timed_lists && seg.timed_lists[0];
    return { np: np || null, stats: (lst && lst.stats) || [] };
  };
  var mapStats = function (stats) {
    return stats.map(function (s) {
      var p = s.product || {};
      return {
        'Product':              clean(p.name || ''),
        'Product ID':           p.id || '',
        'GMV':                  amount(s.revenue),
        'Estimated commission': amount(s.commission),
        'Items sold':           (s.item_sold_cnt != null ? String(s.item_sold_cnt) : '')
      };
    });
  };

  // Navigate to page p and return the response captured by that navigation.
  // Page 1 may already have been captured while setPageSize changed the table
  // to 50/Page, so consume that fresh response instead of clicking the active
  // page (a no-op). Otherwise bounce to a neighbor to force a request.
  var capturePage = async function (p) {
    var before = window.__tokCap.length;
    if (p === 1 && getActivePage() === 1 && before > 0) {
      return window.__tokCap[before - 1];
    }
    if (getActivePage() === p) {
      var other = (p === 1) ? 2 : 1;
      if (!(await goToPage(other))) return null;
      await waitFor(function () { return window.__tokCap.length > before; }, 15000);
      before = window.__tokCap.length;
    }
    if (!(await goToPage(p))) return null;
    var captured = await waitFor(function () { return window.__tokCap.length > before; }, 15000);
    if (!captured) return null;
    await sleep(300);
    return window.__tokCap[window.__tokCap.length - 1];
  };

  var post = function (obj) { obj.source = MSG; window.postMessage(obj, window.location.origin); };

  (async function run () {
    window.__tokCap.length = 0;
    var scrapedAt = new Date().toISOString();
    // If the table is already on 50/Page, setPageSize is a no-op and the hook
    // installed above sees no first-page request. Toggle through 20/Page first
    // so returning to 50/Page always produces a fresh, capturable response.
    var sizeBtn = document.querySelector('.arco-pagination-option .arco-select-view');
    if (sizeBtn && clean(sizeBtn.textContent).indexOf(TARGET_PAGE_SIZE + '/Page') !== -1) {
      await setPageSize(20);
      await sleep(300);
    }
    await setPageSize(TARGET_PAGE_SIZE);
    await sleep(800);

    var lastPage = TARGET_PAGES;
    var total = null;
    for (var p = 1; p <= TARGET_PAGES; p++) {
      var capObj = await capturePage(p);
      if (!capObj) { post({ kind: 'error', page: p, message: 'no list response captured for page ' + p }); break; }
      var pd = pageData(capObj);
      if (pd.np) {
        lastPage = Math.min(TARGET_PAGES, pd.np.total_page || TARGET_PAGES);
        total = pd.np.total;
      }
      var rows = mapStats(pd.stats);
      post({
        kind:          'page',
        page:          p,
        pagesTotal:    lastPage,
        totalProducts: total,
        pageSize:      TARGET_PAGE_SIZE,
        creator:       creator,
        pageTitle:     pageTitle,
        dateLabel:     dateLabel,
        dateRange:     dateRange,
        scrapedAt:     scrapedAt,
        columns:       COLUMNS,
        rows:          rows
      });
      if (p >= lastPage) break;
    }
    post({ kind: 'done' });
  })().catch(function (e) { post({ kind: 'error', message: String((e && e.message) || e) }); });
})();
