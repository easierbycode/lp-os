// Zips the merged Chrome extension (repo's extension/ folder) for the
// /install page's download link. `deno task build:extension-zip` writes
// static/extension.zip (run by the "build" task for Deploy/desktop builds);
// main.ts imports buildExtensionZip() as a runtime fallback so a dev server
// serves /extension.zip without a prior build.
import { zipSync } from "fflate";
import { fromFileUrl, join } from "@std/path";

const EXTENSION_DIR = fromFileUrl(
  new URL("../../../extension/", import.meta.url),
);
const OUT_FILE = fromFileUrl(
  new URL("../static/extension.zip", import.meta.url),
);

// Tests aren't part of the installable extension.
const EXCLUDE = new Set(["test"]);

// Entries live under one root folder so unzipping yields a single directory
// to point Chrome's "Load unpacked" at.
const ZIP_ROOT = "lp-os-extension/";

async function collect(
  dir: string,
  prefix: string,
  entries: Record<string, Uint8Array>,
): Promise<void> {
  for await (const item of Deno.readDir(dir)) {
    if (prefix === "" && EXCLUDE.has(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory) {
      await collect(path, `${prefix}${item.name}/`, entries);
    } else if (item.isFile) {
      entries[`${ZIP_ROOT}${prefix}${item.name}`] = await Deno.readFile(path);
    }
  }
}

export async function buildExtensionZip(): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  await collect(EXTENSION_DIR, "", entries);
  if (!entries[`${ZIP_ROOT}manifest.json`]) {
    throw new Error(`no manifest.json found under ${EXTENSION_DIR}`);
  }
  return zipSync(entries, { level: 9 });
}

if (import.meta.main) {
  const zip = await buildExtensionZip();
  await Deno.writeFile(OUT_FILE, zip);
  console.log(`wrote ${OUT_FILE} (${zip.byteLength} bytes)`);
}
