// Generates the PWA/desktop icon set for both apps — PNGs (192, 512, 512
// maskable) plus a Windows .ico — from the shared LP-OS diamond mark, with no
// image dependencies (pixels are rasterized here and PNG-encoded via
// CompressionStream). The matching icon.svg files are authored by hand in each
// app's static/icons/; keep the geometry in sync (diamond half-diagonal 0.34
// of the canvas, corner radius 0.1875).
//
//   deno run -A scripts/gen-icons.ts

type Rgb = [number, number, number];

interface Palette {
  bg: Rgb;
  markTop: Rgb;
  markBottom: Rgb;
}

const APPS: { dir: string; palette: Palette }[] = [
  {
    // apps/shell — os.css --bg / --accent-2 / --accent
    dir: "apps/shell/static/icons",
    palette: {
      bg: hex("#0b0d11"),
      markTop: hex("#f5832e"),
      markBottom: hex("#e8650a"),
    },
  },
  {
    // apps/member — app.html theme-color / brand yellow (logo.svg)
    dir: "apps/member/static/icons",
    palette: {
      bg: hex("#1a1916"),
      markTop: hex("#ffe95c"),
      markBottom: hex("#ffcb1e"),
    },
  },
];

function hex(value: string): Rgb {
  const v = value.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/* ------------------------------------------------------------ rasterize -- */

// Supersampled flat rasterizer: draw at 4x, box-filter down. Shapes are the
// rounded-square background and the centered diamond (|dx| + |dy| <= r) with
// a vertical top→bottom gradient.
function drawIcon(
  size: number,
  palette: Palette,
  opts: { maskable: boolean },
): Uint8Array {
  const SS = 4;
  const big = size * SS;
  const px = new Uint8Array(big * big * 4);
  const cx = (big - 1) / 2;
  const cy = (big - 1) / 2;
  // Maskable: full-bleed background, mark shrunk into the 40%-radius safe zone.
  const cornerR = opts.maskable ? 0 : big * 0.1875;
  const diamondR = big * (opts.maskable ? 0.27 : 0.34);

  for (let y = 0; y < big; y++) {
    const t = y / (big - 1);
    const mark: Rgb = [
      Math.round(
        palette.markTop[0] + (palette.markBottom[0] - palette.markTop[0]) * t,
      ),
      Math.round(
        palette.markTop[1] + (palette.markBottom[1] - palette.markTop[1]) * t,
      ),
      Math.round(
        palette.markTop[2] + (palette.markBottom[2] - palette.markTop[2]) * t,
      ),
    ];
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;
      if (!insideRoundedSquare(x, y, big, cornerR)) continue; // transparent
      const color = Math.abs(x - cx) + Math.abs(y - cy) <= diamondR
        ? mark
        : palette.bg;
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = 255;
    }
  }
  return downsample(px, big, SS);
}

function insideRoundedSquare(
  x: number,
  y: number,
  size: number,
  radius: number,
): boolean {
  if (radius <= 0) return true;
  const nx = Math.max(0, Math.max(radius - x, x - (size - 1 - radius)));
  const ny = Math.max(0, Math.max(radius - y, y - (size - 1 - radius)));
  return nx * nx + ny * ny <= radius * radius;
}

function downsample(px: Uint8Array, big: number, ss: number): Uint8Array {
  const size = big / ss;
  const out = new Uint8Array(size * size * 4);
  const samples = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * big + x * ss + sx) * 4;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          a += px[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / samples);
      out[o + 1] = Math.round(g / samples);
      out[o + 2] = Math.round(b / samples);
      out[o + 3] = Math.round(a / samples);
    }
  }
  return out;
}

/* --------------------------------------------------------------- encode -- */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function encodePng(rgba: Uint8Array, size: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  // Scanlines, filter byte 0 per row.
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(
      rgba.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1,
    );
  }

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", await zlibDeflate(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Single-image ICO wrapping a 256x256 PNG (PNG-in-ICO, Vista+).
function encodeIco(png: Uint8Array): Uint8Array {
  const out = new Uint8Array(22 + png.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, 1, true); // one image
  // width/height bytes: 0 means 256
  view.setUint16(10, 1, true); // color planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, png.length, true);
  view.setUint32(18, 22, true); // image data offset
  out.set(png, 22);
  return out;
}

/* ----------------------------------------------------------------- main -- */

const root = new URL("..", import.meta.url);

for (const { dir, palette } of APPS) {
  const outDir = new URL(`${dir}/`, root);
  await Deno.mkdir(outDir, { recursive: true });

  const files: [string, Uint8Array][] = [
    [
      "icon-192.png",
      await encodePng(drawIcon(192, palette, { maskable: false }), 192),
    ],
    [
      "icon-512.png",
      await encodePng(drawIcon(512, palette, { maskable: false }), 512),
    ],
    [
      "icon-512-maskable.png",
      await encodePng(drawIcon(512, palette, { maskable: true }), 512),
    ],
    [
      "icon.ico",
      encodeIco(
        await encodePng(drawIcon(256, palette, { maskable: true }), 256),
      ),
    ],
  ];
  for (const [name, bytes] of files) {
    await Deno.writeFile(new URL(name, outDir), bytes);
    console.log(`wrote ${dir}/${name} (${bytes.length} bytes)`);
  }
}
