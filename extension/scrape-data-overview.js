// Seller-side Streamer Compass Data Overview scraper:
//   shop.tiktok.com/streamer/compass/data-overview/view
// Pulls the 8 Core data KPI tiles (Commission base, attributed_gmv,
// Est. commission, LIVE GMV, Video GMV, Items sold, Product views,
// Product clicks). Same metric "shape" as scrape-streamer.js but a
// different layout (flex-wrap grid, nested label div, $ rendered as
// a separate sibling rather than inside the head value).
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-data-overview';

  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  var pageTitle = 'Data Overview';

  var creator = '';
  var avatarEls = document.querySelectorAll('div.m4b-avatar');
  for (var ai = 0; ai < avatarEls.length && !creator; ai++) {
    var sib = avatarEls[ai].nextElementSibling;
    if (sib && sib.tagName === 'SPAN') {
      var raw = clean(sib.textContent);
      if (raw) creator = '@' + raw.replace(/^@/, '');
    }
  }
  if (!creator) {
    console.warn('[tok-scrape:data-overview] could not extract username; m4b-avatar count=' + avatarEls.length);
  }

  var startInput = document.querySelector('input[placeholder="Start date"]');
  var endInput   = document.querySelector('input[placeholder="End date"]');
  var dateRange = {
    start: startInput ? startInput.value : '',
    end:   endInput   ? endInput.value   : ''
  };
  var prefixEl = document.querySelector('.arco-picker-prefix');
  var dateLabel = prefixEl ? clean(prefixEl.textContent.replace(/:\s*$/, '')) : '';

  var metrics = [];
  var grid = document.querySelector('.flex.flex-wrap.gap-12');
  if (grid) {
    grid.querySelectorAll(':scope > div').forEach(function (card) {
      var labelEl = card.querySelector('.text-body-m-regular.text-neutral-text2');
      if (!labelEl) return;
      var name = clean(labelEl.textContent);
      // The numeric value lives inside `.text-head-l.mt-4 > .flex > <div> > <div> > .text-head-l`
      // The leading `$` is a sibling `.text-body-l-regular.mr-2`, so the inner
      // `.text-head-l` selector strips it cleanly. Non-money tiles render the
      // value directly inside `.text-head-l.mt-4` with no inner `.text-head-l`,
      // so fall back to the row's textContent if needed.
      var valueEl = card.querySelector('.text-head-l.mt-4 .text-head-l');
      var value;
      if (valueEl) {
        value = clean(valueEl.textContent);
      } else {
        var valueRow = card.querySelector('.text-head-l.mt-4');
        value = valueRow ? clean(valueRow.textContent) : '';
      }
      var currencyEl = card.querySelector('.text-body-l-regular.mr-2');
      var currency = currencyEl ? clean(currencyEl.textContent) : '';
      var cmpRow = card.querySelector('.text-body-s-regular.text-neutral-text3.h-18');
      var compareKey = '';
      var delta = '';
      if (cmpRow) {
        if (cmpRow.children[0]) compareKey = clean(cmpRow.children[0].textContent);
        var deltaEl = cmpRow.querySelector('.text-body-s-regular.mr-5');
        if (deltaEl) delta = clean(deltaEl.textContent);
      }
      metrics.push({
        name:       name,
        value:      value,
        currency:   currency,
        compareKey: compareKey,
        delta:      delta
      });
    });
  }

  var payload = {
    creator:   creator,
    page:      pageTitle,
    dateLabel: dateLabel,
    dateRange: dateRange,
    scrapedAt: new Date().toISOString(),
    metrics:   metrics
  };
  console.log('[tok-scrape:data-overview]', payload);

  if (GRAYLOG_ENDPOINT) {
    // OpenSearch dynamically mapped `date_end`/`date_start` as type=date from
    // earlier creator-scraper messages (which send "2026-04-27"). The streamer
    // page's date inputs render "May 14, 2026", which fails OpenSearch's date
    // parsers and rejects the whole message at index time. Normalize to ISO
    // YYYY-MM-DD using local components (avoid toISOString() — it converts to
    // UTC and can shift the date by one day).
    var toISODate = function (s) {
      if (!s) return '';
      var d = new Date(s);
      if (isNaN(d.getTime())) return s;
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var dd = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + dd;
    };
    var gelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok data-overview scrape: ' + (creator || pageTitle || 'unknown') + ' (' + metrics.length + ' kpis)',
      timestamp: Math.floor(Date.now() / 1000),
      _creator:        payload.creator,
      _page:           payload.page,
      _date_label:     payload.dateLabel,
      _date_start:     toISODate(dateRange.start),
      _date_end:       toISODate(dateRange.end),
      _scrapedAt:      payload.scrapedAt,
      _metrics_count:  metrics.length,
      _metrics_json:   JSON.stringify(metrics),
      _graylog_key:    GRAYLOG_TOKEN
    };
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
