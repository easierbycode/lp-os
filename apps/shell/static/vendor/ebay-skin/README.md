# eBay Skin (vendored)

Minimal compiled CSS from [@ebay/skin](https://github.com/eBay/skin)
(`@ebay/skin@19.28.0`, MIT), bundled for the eBay-Pricing demo at
`/demos/ebay-pricing`.

- **Do not edit `ebay-skin.css` by hand.** It is generated. To change the set of
  components or upgrade Skin, edit `scripts/vendor-ebay-skin.ts` and run
  `deno task vendor:ebay-skin`.
- Bundled: Evo design tokens (core + light + dark), base reset, typography,
  button, textbox, field, segmented-buttons, listbox, and the Market Sans
  `@font-face`.
- **Market Sans** is referenced from eBay's font CDN (`ir.ebaystatic.com`), the
  only external dependency. Offline it falls back to Arial via
  `font-display: swap`; the page stays fully functional. We reference rather
  than redistribute it because the font is eBay's proprietary brand asset (not
  covered by Skin's MIT license).
- Theme: light at `:root`, dark under `@media (prefers-color-scheme: dark)`,
  with manual `:root[data-skin-theme="light"|"dark"]` overrides driving the
  demo's Auto/Light/Dark switch.
