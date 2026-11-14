# qrcode-generator (vendored)

`qrcode.js` is copied unchanged from the npm package
[`qrcode-generator@1.4.4`](https://www.npmjs.com/package/qrcode-generator)
(Kazuhiko Arase, MIT license; the license header is kept in the file).

The self-serve kiosk (`/kiosk/self`, `kiosk-self.js`) uses it to draw the
Cash App payment QR code in the browser, so the kiosk needs no QR CDN or
server-side image step. Do not edit it by hand; to upgrade, replace the file
with the package's `qrcode.js` and update the version above.
