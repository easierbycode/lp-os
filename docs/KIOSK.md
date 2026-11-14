# Self-checkout kiosk

Customers scan items and pay with Cash App at `/kiosk/self`. Staff confirm link
payments at `/kiosk/payments`.

## Ways to pay

- **Cash App link (default).** The kiosk draws a QR for
  `https://cash.app/$cashtag/<cart total>`. Scanning it opens Cash App with the
  cashtag and amount filled in. Nothing reports back, so the customer taps "I've
  paid" and the sale waits on `/kiosk/payments` until staff check Cash App and
  press Confirm paid (items marked sold) or Reject (items back on sale). Set
  with `KIOSK_CASHAPP_URL` (default `https://cash.app/$danieljohnsonaz/5.00`;
  the amount is the price for items with no `current_price`; `off` disables it).
  The same link fits an NFC tag only for one fixed price.
- **Cash App Pay through Square (optional).** Shown when
  `SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID` and `SQUARE_ACCESS_TOKEN` are
  set. The charge is made server-side and confirms on its own. Start with
  `SQUARE_ENVIRONMENT=sandbox`. If Square's answer is unknown (timeout, 5xx) the
  sale shows on `/kiosk/payments` as `error`; check the Square Dashboard before
  confirming.

## Setup

1. `deno task migrate` (adds `kiosk_payments`).
2. On the kiosk device open `/kiosk/self?kiosk=<name>` in a locked browser, for
   example `chrome --kiosk https://<host>/kiosk/self?kiosk=front`.
3. Scan with a USB/Bluetooth keyboard-wedge scanner, the scan relay, or the code
   box. With several kiosks, prefer a scanner per kiosk: every relay listener
   gets every scan.
4. Keep `/kiosk/payments` open on a staff device.

## How a sale works

Scanning only reads. "Pay" creates a quote that reserves the items for
`KIOSK_QUOTE_TTL_SECONDS` (default 300), priced from the database. Cancel or
expiry puts them back. Confirm (link) or a completed Square charge marks each
item `sold` with a `transactions` row. Only `KIOSK_SELLABLE_STATUSES` (default
`available,cleared_to_sell`) can be sold. A disabled kiosk refuses new
checkouts.

## Limits

- The staff page has no auth yet, like the rest of the shell.
- No Square webhook; the server reads the charge result directly.
- A `cleared_to_sell` item that is also listed on eBay is not cross-checked.
