// Partner Collabs Agency Detail page scraper.
// Injected when the user clicks the action icon on
// partner.us.tiktokshop.com/affiliate-campaign/partner-collabs/agency/detail.
// Each row pairs a product with the seller (shop) that registered it.
// Graylog-only — the seller payload doesn't fit the Sheets schema.
(function () {
  var CFG = globalThis.TOK_CONFIG || {};
  var GRAYLOG_ENDPOINT = CFG.GRAYLOG_ENDPOINT;
  var GRAYLOG_TOKEN    = CFG.GRAYLOG_TOKEN;
  var GRAYLOG_HOST     = 'tiktok-bookmarklet-sellers';

  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  var pageTitleEl = document.querySelector('.text-head-l');
  var pageTitle = pageTitleEl ? clean(pageTitleEl.textContent) : '';

  var campaignId = '';
  var cm = location.href.match(/[?&]campaign_id=(\d+)/);
  if (cm) campaignId = cm[1];

  var STATUS_RE = /^(Pending closed|Pending|Approved|Rejected|Closed)$/;
  var labelOf = function (t) {
    var countEl = t.querySelector('.tab-value');
    var countText = countEl ? clean(countEl.textContent) : '';
    var full = clean(t.textContent);
    var label = full;
    if (countText) {
      var i = label.lastIndexOf(countText);
      if (i >= 0) label = label.slice(0, i).trim();
    }
    return { label: label, count: countText };
  };

  var statusTabs = [];
  document.querySelectorAll('.arco-tabs-header-title .arco-tabs-header-title-text').forEach(function (t) {
    var lc = labelOf(t);
    if (!STATUS_RE.test(lc.label)) return;
    statusTabs.push(lc);
  });
  var activeStatus = '';
  var activeCount  = '';
  document.querySelectorAll('.arco-tabs-header-title-active .arco-tabs-header-title-text').forEach(function (t) {
    if (activeStatus) return;
    var lc = labelOf(t);
    if (STATUS_RE.test(lc.label)) {
      activeStatus = lc.label;
      activeCount  = lc.count;
    }
  });

  var get = function (td) {
    if (!td) return '';
    var inner = td.querySelector('.arco-table-cell-wrap-value');
    if (!inner) return '';
    var ps = inner.querySelectorAll('p');
    if (ps.length > 1) {
      var parts = [];
      ps.forEach(function (p) { var s = clean(p.textContent); if (s) parts.push(s); });
      if (parts.length) return parts.join(' / ');
    }
    return clean(inner.textContent);
  };

  var sellers = [];
  var rows = document.querySelectorAll('tbody tr.arco-table-tr');
  rows.forEach(function (row) {
    var checkbox = row.querySelector('input[type="checkbox"]');
    if (!checkbox) return;

    var tds = row.querySelectorAll('td.arco-table-td');

    var productId = checkbox.value || '';
    var productNameEl = tds[1] && tds[1].querySelector('.arco-typography[title]');
    var productName = productNameEl
      ? clean(productNameEl.getAttribute('title') || productNameEl.textContent)
      : '';

    if (!productId && tds[1]) {
      var idEl = tds[1].querySelector('.text-body-s-regular');
      var im = idEl && idEl.textContent.match(/ID:\s*(\S+)/);
      if (im) productId = im[1];
    }

    var ratingValueEl = tds[9] && tds[9].querySelector('.text-body-m-regular');
    var ratingValue = ratingValueEl ? clean(ratingValueEl.textContent) : '';
    var reviewCountEl = tds[9] && tds[9].querySelector('.text-body-s-regular');
    var reviewCount = reviewCountEl ? clean(reviewCountEl.textContent) : '';

    var shopWrap = row.querySelector('#shop-info-wrapper, .shop-info-td');
    var shopName = '', shopRating = '', shopEmail = '', shopCode = '';
    if (shopWrap) {
      var nameEl = shopWrap.querySelector('.arco-typography');
      shopName = nameEl ? clean(nameEl.textContent) : '';

      var ratingEl = shopWrap.querySelector('.font-semibold.ml-2');
      shopRating = ratingEl ? clean(ratingEl.textContent) : '';

      var emailEls = shopWrap.querySelectorAll('.arco-typography');
      shopEmail = emailEls[1] ? clean(emailEls[1].textContent) : '';

      var codeWrap = shopWrap.querySelector('.shop_code');
      if (codeWrap) {
        shopCode = clean(codeWrap.textContent.replace(/^\s*Shop code:\s*/, ''));
      }
    }

    sellers.push({
      'Product ID':                     productId,
      'Product name':                   productName,
      'Date registered':                tds[2] ? get(tds[2]) : '',
      'Total commission rate':          tds[3] ? get(tds[3]) : '',
      'Total Shop Ads commission rate': tds[4] ? get(tds[4]) : '',
      'Sale price':                     tds[5] ? get(tds[5]) : '',
      'Stock':                          tds[6] ? get(tds[6]) : '',
      'Available samples':              tds[7] ? get(tds[7]) : '',
      'Items sold':                     tds[8] ? get(tds[8]) : '',
      'Product rating':                 ratingValue,
      'Reviews':                        reviewCount,
      'Shop name':                      shopName,
      'Shop rating':                    shopRating,
      'Shop email':                     shopEmail,
      'Shop code':                      shopCode,
      'Status':                         activeStatus
    });
  });

  var payload = {
    page:        pageTitle,
    campaignId:  campaignId,
    status:      activeStatus,
    statusCount: activeCount,
    statusTabs:  statusTabs,
    scrapedAt:   new Date().toISOString(),
    sellers:     sellers
  };
  console.log('[tok-scrape:sellers]', payload);

  if (GRAYLOG_ENDPOINT) {
    var gelf = {
      version: '1.1',
      host: GRAYLOG_HOST,
      short_message: 'tiktok seller scrape: ' + (activeStatus || pageTitle || 'unknown') + ' (' + sellers.length + ' sellers)',
      timestamp: Math.floor(Date.now() / 1000),
      _page:          payload.page,
      _campaign_id:   payload.campaignId,
      _status:        payload.status,
      _status_count:  payload.statusCount,
      _scrapedAt:     payload.scrapedAt,
      _tabs_count:    statusTabs.length,
      _tabs_json:     JSON.stringify(statusTabs),
      _sellers_count: sellers.length,
      _sellers_json:  JSON.stringify(sellers),
      _graylog_key:   GRAYLOG_TOKEN
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
