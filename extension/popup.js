// LP-OS scraper popup: shows the resolved role/user, lets the user set or
// override chrome.storage.local.lpos_user, shows the per-behavior enable
// matrix, and triggers the (role-gated) scrape of the current tab.

var activeTab = null;

function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(Object.assign({ source: 'lp-os-popup' }, msg), function (resp) {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'no response' });
      }
    });
  });
}

function el(id) { return document.getElementById(id); }

function render(status) {
  var who = el('who');
  if (!status.ok) {
    who.innerHTML = '<span class="role-none">Error:</span> ' + (status.error || 'unknown');
    return;
  }
  if (status.user) {
    var roleCls = 'role-' + (status.role || 'none');
    who.innerHTML =
      'User: <b>' + escapeHtml(status.user) + '</b><br>' +
      'Role: <b class="' + roleCls + '">' + (status.role || 'none (disabled)') + '</b> ' +
      '<span class="muted">(via ' + status.via + ')</span>';
  } else {
    who.innerHTML =
      '<span class="role-none">No LP-OS user resolved — all scraping disabled.</span><br>' +
      '<span class="muted">Open the LP-OS shell with ?user=&lt;id&gt; or set a user below.</span>';
  }

  var list = el('behaviors');
  list.innerHTML = '';
  (status.behaviors || []).forEach(function (b) {
    var li = document.createElement('li');
    li.title = b.desc || '';
    li.innerHTML =
      '<span>' + escapeHtml(b.label) + ' <span class="muted">(' + b.family + ')</span></span>' +
      '<span class="' + (b.enabled ? 'on' : 'off') + '">' + (b.enabled ? 'enabled' : 'disabled') + '</span>';
    list.appendChild(li);
  });

  var tabstatus = el('tabstatus');
  var scrapeBtn = el('scrape');
  if (status.route) {
    tabstatus.innerHTML = 'This tab: <b>' + escapeHtml(status.route.desc || status.route.label) + '</b>' +
      (status.route.enabled
        ? ' <span class="on">— ready</span>'
        : ' <span class="role-none">— blocked for this role</span>');
    scrapeBtn.disabled = !status.route.enabled;
  } else {
    tabstatus.innerHTML = '<span class="muted">This tab: no scrapeable page detected.</span>';
    scrapeBtn.disabled = true;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function refresh() {
  return send({ type: 'status', tabUrl: activeTab && activeTab.url }).then(render);
}

document.addEventListener('DOMContentLoaded', function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    activeTab = (tabs && tabs[0]) || null;
    refresh();
  });

  chrome.storage.local.get('lpos_user', function (got) {
    if (got && got.lpos_user) el('user').value = got.lpos_user;
  });

  el('save').addEventListener('click', function () {
    send({ type: 'set-user', user: el('user').value, tabUrl: activeTab && activeTab.url })
      .then(function (status) {
        render(status);
        el('feedback').textContent = 'Saved.';
      });
  });

  el('clear').addEventListener('click', function () {
    el('user').value = '';
    send({ type: 'set-user', user: '', tabUrl: activeTab && activeTab.url })
      .then(function (status) {
        render(status);
        el('feedback').textContent = 'Override cleared.';
      });
  });

  el('scrape').addEventListener('click', function () {
    if (!activeTab || !activeTab.id) return;
    el('feedback').textContent = 'Injecting…';
    send({ type: 'scrape', tabId: activeTab.id }).then(function (resp) {
      if (resp.ok) {
        el('feedback').innerHTML = '<span class="on">Scrape "' + escapeHtml(resp.route) + '" injected.</span>';
      } else {
        el('feedback').innerHTML = '<span class="role-none">Blocked: ' +
          escapeHtml(resp.reason || resp.error || 'unknown') + '</span>';
      }
    });
  });
});
