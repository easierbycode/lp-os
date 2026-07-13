// Merged config for all LP-OS scrapers — agency side (creator custom-report,
// partner-collabs sellers) and seller side (live, streamer, product,
// data-overview, analytics, order detail/list).
//
// GELF ingest goes to the LP-OS shell's POST /gelf endpoint — production is
// https://thirsty.store (LP-OS replaced data-pimp behind it). Per-machine
// overrides come in as globals (LPOS_GELF_ENDPOINT / LPOS_GELF_TOKEN), which
// background.js pre-injects from chrome.storage.local before this file runs;
// point LPOS_GELF_ENDPOINT at http://localhost:8000/gelf for a local shell.
var DEFAULT_GRAYLOG_ENDPOINT = 'https://thirsty.store/gelf';
// Legacy graylog-shim write token, kept verbatim from both source extensions
// so the payload scripts' _graylog_key field keeps passing the ingest gate
// (LP-OS honors it when GRAYLOG_INGEST_TOKEN is set to the same value).
var DEFAULT_GRAYLOG_TOKEN = '1dfl48d81q96uu1djdahq1ic87cvnlmu4jqsvco2l0bh8u3adns8';

var GRAYLOG_ENDPOINT = globalThis.LPOS_GELF_ENDPOINT || DEFAULT_GRAYLOG_ENDPOINT;
var GRAYLOG_TOKEN = globalThis.LPOS_GELF_TOKEN || DEFAULT_GRAYLOG_TOKEN;

globalThis.TOK_CONFIG = {
  GRAYLOG_ENDPOINT: GRAYLOG_ENDPOINT,
  GRAYLOG_TOKEN: GRAYLOG_TOKEN,
  SHEET_ENDPOINT: 'https://script.google.com/macros/s/AKfycbzRGJMcZGvdRsAd9UHHATRG5ilpeh4JHCZ11ye5CMhHbs4LulaYJJsnndw8I2NfgvdG/exec',
  SHEET_TOKEN: '**dingleding&&',
  // Resolved LP-OS user (e.g. '@boosteddealsdaily' or 'dj'); stamped by
  // background.js so creator-scoped scrapes can carry their handle. Product
  // Analytics consumes the same value in its MAIN-world capture half.
  LPOS_USER: globalThis.LPOS_USER || null
};
