/**
 * The desktop launcher catalog the Admin panel edits against — the folders and
 * apps a role's capability flags gate, and the `Folder/Item` names its
 * `default_home` boot layout references.
 *
 * This is the SERVER-SIDE mirror of the `FOLDERS` array in `static/os.js`: same
 * folder/item display names and the same gating `flag` per entry, minus the
 * runtime-only fields (url/allow/width/…). The OS shell owns the live launcher
 * table; the Admin window only needs "what can this role see, and what may its
 * boot layout point at", so it reads this trimmed view (injected as
 * `globalThis.LPOS_CATALOG`, also served at `/api/catalog`).
 *
 * KEEP IN SYNC with os.js FOLDERS: adding/renaming a folder or app there means
 * mirroring the name + flag here so the Admin preview and boot-layout picker
 * match what the shell actually launches. Boot-layout refs are matched
 * case-insensitively by `resolveAppPath` in os.js, so casing here is cosmetic.
 */

export interface CatalogItem {
  id: string;
  name: string;
  /** Capability flag that gates this app, or undefined for always-visible. */
  flag?: string;
}

export interface CatalogFolder {
  id: string;
  name: string;
  /** Capability flag that gates the whole folder. */
  flag: string;
  items: CatalogItem[];
}

export const APP_CATALOG: CatalogFolder[] = [
  {
    id: "apps",
    name: "Apps",
    flag: "folder.apps",
    items: [
      {
        id: "product-analysis",
        name: "Product Analysis",
        flag: "app.productAnalysis",
      },
      { id: "inventory", name: "Inventory", flag: "app.inventory" },
      { id: "kiosk", name: "Kiosk", flag: "app.kiosk" },
      { id: "scanner", name: "Scanner", flag: "app.scanner" },
      { id: "graylog", name: "Graylog", flag: "app.graylog" },
      {
        id: "install-extension",
        name: "Install Extension",
        flag: "app.installExtension",
      },
      { id: "marketplace", name: "Marketplace", flag: "app.marketplace" },
      { id: "warehouse", name: "Warehouse", flag: "app.warehouse" },
      { id: "admin", name: "Admin", flag: "app.admin" },
      { id: "settings", name: "Settings", flag: "app.settings" },
    ],
  },
  {
    id: "demos",
    name: "Demos",
    flag: "folder.demos",
    items: [
      { id: "sample-valuation", name: "Sample Valuation" },
      { id: "samples", name: "Samples" },
      { id: "samples-import", name: "Samples-Import" },
      { id: "e2e", name: "E2E" },
      { id: "ebay-pricing", name: "eBay Pricing" },
      { id: "content-by-sample", name: "Content by Sample" },
    ],
  },
  {
    id: "member",
    name: "Member",
    flag: "folder.member",
    items: [
      { id: "tokscrape-dashboard", name: "App" },
      { id: "member-web", name: "Web" },
      { id: "lifepreneur", name: "LP" },
    ],
  },
];
