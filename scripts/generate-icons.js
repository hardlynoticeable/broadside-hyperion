/**
 * BROADSIDE HYPERION — Zero-Dependency PWA Icon Generator
 *
 * Generates razor-sharp tactical starship icons and vector SVG:
 * - icon-192.png (192x192)
 * - icon-512.png (512x512)
 * - icon-maskable-192.png (192x192, inner 70% safe zone on full-bleed #0b0f19)
 * - icon-maskable-512.png (512x512, inner 70% safe zone on full-bleed #0b0f19)
 * - apple-touch-icon-180.png (180x180, opaque #0b0f19)
 * - icon.svg (512x512 vector emblem, zero emojis, zero text dependencies)
 *
 * Dependencies: Node built-in node:fs, node:path, node:zlib, node:url only.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Precompute CRC-32 lookup table (polynomial 0xEDB88320)
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

/**
 * Computes standard IEEE 802.3 CRC-32 checksum of a Buffer.
 * @param {Buffer} buf
 * @returns {number} 32-bit unsigned integer
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Formats a single PNG chunk [length, type, data, crc32].
 * @param {string} type 4-character ASCII chunk type
 * @param {Buffer} [data] Chunk payload
 * @returns {Buffer} Formatted chunk
 */
export function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Encodes raw RGBA buffer into a valid binary PNG Buffer with filter byte 0 per scanline.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgbaBuffer Raw RGBA bytes (length must equal width * height * 4)
 * @returns {Buffer} Complete PNG file buffer
 */
export function encodePngRgba(width, height, rgbaBuffer) {
  if (!Buffer.isBuffer(rgbaBuffer) || rgbaBuffer.length !== width * height * 4) {
    throw new Error(`Expected rgbaBuffer length ${width * height * 4}, got ${rgbaBuffer ? rgbaBuffer.length : 'none'}`);
  }

  // 8-byte PNG file signature
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk (13 bytes)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit depth
  ihdr.writeUInt8(6, 9); // RGBA (color type 6)
  ihdr.writeUInt8(0, 10); // Deflate compression (method 0)
  ihdr.writeUInt8(0, 11); // Filter method 0
  ihdr.writeUInt8(0, 12); // No interlace

  // Raw scanlines with filter byte 0 (None)
  const rowBytes = width * 4;
  const rawScanlines = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (1 + rowBytes);
    rawScanlines[rawOffset] = 0; // Filter byte 0 (None)
    const srcOffset = y * rowBytes;
    rgbaBuffer.copy(rawScanlines, rawOffset + 1, srcOffset, srcOffset + rowBytes);
  }

  // Deflate compress raw scanlines at level 9
  const idatData = zlib.deflateSync(rawScanlines, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Analytical Geometry & Signed Distance Fields for Starship Icon
// ---------------------------------------------------------------------------

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

// Polygons in normalized emblem coordinates: u in [-1, 1], v in [-1, 1]
const POLY_PROW_LEFT = [[0, -0.68], [-0.09, -0.42], [-0.15, -0.36], [-0.11, -0.30], [0, -0.24]];
const POLY_PROW_RIGHT = [[0, -0.68], [0.09, -0.42], [0.15, -0.36], [0.11, -0.30], [0, -0.24]];

const POLY_WING_LEFT = [
  [-0.11, -0.30], [-0.38, 0.12], [-0.36, 0.35], [-0.24, 0.44],
  [-0.12, 0.36], [-0.03, 0.34], [-0.03, -0.06], [-0.06, -0.15], [-0.03, -0.24]
];
const POLY_WING_RIGHT = [
  [0.11, -0.30], [0.38, 0.12], [0.36, 0.35], [0.24, 0.44],
  [0.12, 0.36], [0.03, 0.34], [0.03, -0.06], [0.06, -0.15], [0.03, -0.24]
];

const POLY_CHAFER_LEFT = [
  [-0.38, 0.12], [-0.36, 0.35], [-0.24, 0.44],
  [-0.27, 0.38], [-0.32, 0.30], [-0.33, 0.14]
];
const POLY_CHAFER_RIGHT = [
  [0.38, 0.12], [0.36, 0.35], [0.24, 0.44],
  [0.27, 0.38], [0.32, 0.30], [0.33, 0.14]
];

const POLY_BRIDGE_OUTER = [[0, -0.22], [0.05, -0.15], [0, -0.08], [-0.05, -0.15]];
const POLY_BRIDGE_INNER = [[0, -0.19], [0.025, -0.15], [0, -0.11], [-0.025, -0.15]];

/**
 * Samples RGBA color at normalized emblem coordinates (u, v).
 * @param {number} u Horizontal coordinate [-1, 1]
 * @param {number} v Vertical coordinate [-1, 1] (-1 is top/forward, +1 is bottom/aft)
 * @returns {[number, number, number, number]} [r, g, b, a]
 */
export function sampleEmblem(u, v) {
  // Background: dark alloy #0b0f19 (11, 15, 25, 255)
  let r = 11, g = 15, b = 25;
  const rad = Math.hypot(u, v);

  // 1. Subtle Circular Radar Reticle Rings
  // Outer ring R=0.88, thickness 0.016 (#1e293b)
  const dOuter = Math.abs(rad - 0.88);
  if (dOuter < 0.012) {
    r = 30; g = 41; b = 59;
  }
  // Middle ring R=0.60, thickness 0.014 with translucent cyan tint
  const dMid = Math.abs(rad - 0.60);
  if (dMid < 0.010) {
    r = 25; g = 75; b = 110;
  }
  // Inner ring R=0.32, thickness 0.010 (#1e293b)
  const dInner = Math.abs(rad - 0.32);
  if (dInner < 0.008) {
    r = 30; g = 41; b = 59;
  }
  // Crosshair ticks
  if (Math.abs(u) < 0.006 && ((rad >= 0.24 && rad <= 0.40) || (rad >= 0.75 && rad <= 0.94))) {
    r = 30; g = 41; b = 59;
  }
  if (Math.abs(v) < 0.006 && ((rad >= 0.42 && rad <= 0.55) || (rad >= 0.75 && rad <= 0.94))) {
    r = 30; g = 41; b = 59;
  }

  // 2. Crimson Broadside Accent Arcs (#f43f5e: 244, 63, 94)
  if (rad >= 0.63 && rad <= 0.70 && Math.abs(u) >= 0.42 && v >= -0.22 && v <= 0.32) {
    const dArc = Math.abs(rad - 0.665);
    if (dArc < 0.022) {
      r = 244; g = 63; b = 94;
    } else {
      const t = (0.035 - dArc) / 0.013;
      r = Math.round(r + (244 - r) * t * 0.5);
      g = Math.round(g + (63 - g) * t * 0.5);
      b = Math.round(b + (94 - b) * t * 0.5);
    }
  }

  // 3. Thruster Plumes (#38bdf8: 56, 189, 248 with white-hot core)
  // Center main drive thruster: nozzle v=0.36, plume down to v=0.66
  if (v >= 0.36 && v <= 0.66) {
    const t = (v - 0.36) / 0.30;
    const w = 0.075 * Math.pow(1 - t, 0.65);
    const du = Math.abs(u);
    if (du <= w) {
      const uFrac = du / w;
      if (uFrac < 0.35 && t < 0.60) {
        r = 235; g = 248; b = 255;
      } else {
        const alpha = (1 - uFrac) * (1 - t * 0.7);
        r = Math.round(r + (56 - r) * alpha);
        g = Math.round(g + (189 - g) * alpha);
        b = Math.round(b + (248 - b) * alpha);
      }
    }
  }
  // Auxiliary thrusters at u = +-0.18, v in [0.43, 0.58]
  if (v >= 0.43 && v <= 0.58) {
    const t = (v - 0.43) / 0.15;
    const w = 0.035 * Math.pow(1 - t, 0.65);
    const duLeft = Math.abs(u - (-0.18));
    const duRight = Math.abs(u - 0.18);
    const du = Math.min(duLeft, duRight);
    if (du <= w) {
      const uFrac = du / w;
      if (uFrac < 0.35 && t < 0.55) {
        r = 224; g = 242; b = 254;
      } else {
        const alpha = (1 - uFrac) * (1 - t * 0.7);
        r = Math.round(r + (56 - r) * alpha);
        g = Math.round(g + (189 - g) * alpha);
        b = Math.round(b + (248 - b) * alpha);
      }
    }
  }

  // 4. Stylized Starship Silhouette & Hull Armor Plates
  if (Math.abs(u) <= 0.40 && v >= -0.70 && v <= 0.48) {
    if (pointInPoly(u, v, POLY_PROW_LEFT)) {
      // Highlight side: #f8fafc (248, 250, 252)
      r = 248; g = 250; b = 252;
    } else if (pointInPoly(u, v, POLY_PROW_RIGHT)) {
      // Standard hull: #e2e8f0 (226, 232, 240)
      r = 226; g = 232; b = 240;
    } else if (pointInPoly(u, v, POLY_CHAFER_LEFT) || pointInPoly(u, v, POLY_CHAFER_RIGHT)) {
      // Armor flank chafers: #94a3b8 (148, 163, 184)
      r = 148; g = 163; b = 184;
    } else if (pointInPoly(u, v, POLY_WING_LEFT)) {
      // Port wing: #e2e8f0 (226, 232, 240)
      r = 226; g = 232; b = 240;
    } else if (pointInPoly(u, v, POLY_WING_RIGHT)) {
      // Starboard wing: #cbd5e1 (203, 213, 225)
      r = 203; g = 213; b = 225;
    }

    // Engine bay bulkhead: #1e293b (30, 41, 59)
    if (v >= 0.36 && v <= 0.42 && Math.abs(u) <= 0.14) {
      r = 30; g = 41; b = 59;
    }

    // Armor panel seams: #334155 (51, 65, 85)
    const dSeamL = distToSegment(u, v, -0.11, -0.30, 0, -0.24);
    const dSeamR = distToSegment(u, v, 0.11, -0.30, 0, -0.24);
    const dWingL = distToSegment(u, v, -0.36, 0.16, -0.03, 0.12);
    const dWingR = distToSegment(u, v, 0.36, 0.16, 0.03, 0.12);
    if (Math.min(dSeamL, dSeamR, dWingL, dWingR) < 0.007) {
      r = 51; g = 65; b = 85;
    }

    // Central spine energy conduit: #38bdf8 (56, 189, 248)
    if (Math.abs(u) < 0.012 && ((v >= -0.34 && v <= -0.22) || (v >= -0.07 && v <= 0.30))) {
      r = 56; g = 189; b = 248;
    }

    // Bridge Diamond & Inner Glow (#38bdf8 + #e0f2fe)
    if (pointInPoly(u, v, POLY_BRIDGE_INNER)) {
      r = 224; g = 242; b = 254; // #e0f2fe
    } else if (pointInPoly(u, v, POLY_BRIDGE_OUTER)) {
      r = 56; g = 189; b = 248; // #38bdf8
    }
  }

  return [r, g, b, 255];
}

/**
 * Renders raster PNG icon with 3x3 supersampling.
 * @param {number} size Output square dimension (e.g. 180, 192, 512)
 * @param {object} [options]
 * @param {boolean} [options.isMaskable=false] Keep emblem strictly within inner 70% safe zone
 * @returns {Buffer} Valid PNG file buffer
 */
export function renderIcon(size, { isMaskable = false } = {}) {
  // For maskable icons, scale = 0.60 guarantees max emblem radius <= 0.53, well inside 0.70 safe zone
  const scale = isMaskable ? 0.60 : 0.85;
  const half = size / 2;
  const rgba = Buffer.alloc(size * size * 4);

  // 3x3 supersampling subpixel offsets
  const subOffsets = [-1/3, 0, 1/3];

  let ptr = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < 3; sy++) {
        const yNorm = ((py + 0.5 + subOffsets[sy] * 0.5) - half) / half;
        const v = yNorm / scale;
        for (let sx = 0; sx < 3; sx++) {
          const xNorm = ((px + 0.5 + subOffsets[sx] * 0.5) - half) / half;
          const u = xNorm / scale;
          const [r, g, b, a] = sampleEmblem(u, v);
          rSum += r; gSum += g; bSum += b; aSum += a;
        }
      }
      rgba[ptr++] = Math.round(rSum / 9);
      rgba[ptr++] = Math.round(gSum / 9);
      rgba[ptr++] = Math.round(bSum / 9);
      rgba[ptr++] = Math.round(aSum / 9);
    }
  }
  return encodePngRgba(size, size, rgba);
}

/**
 * Generates vector SVG emblem matching the starship icon.
 * Zero emojis, zero text dependencies, viewBox="0 0 512 512".
 * @returns {string} SVG markup string
 */
export function generateSvg() {
  const scale = 0.85;
  const cx = 256, cy = 256;
  const R0 = 256 * scale; // 217.6

  function toPx(u, v) {
    return `${(cx + u * R0).toFixed(1)},${(cy + v * R0).toFixed(1)}`;
  }

  function polyToSvg(poly) {
    return poly.map(([u, v]) => toPx(u, v)).join(' ');
  }

  const rOuter = (0.88 * R0).toFixed(1);
  const rMid = (0.60 * R0).toFixed(1);
  const rInner = (0.32 * R0).toFixed(1);

  // Broadside arc parameters (R ~ 0.665 * R0 = 144.7px)
  const arcR = (0.665 * R0).toFixed(1);
  const arcLStart = toPx(-0.62, -0.22);
  const arcLEnd = toPx(-0.58, 0.32);
  const arcRStart = toPx(0.62, -0.22);
  const arcREnd = toPx(0.58, 0.32);

  // Thruster plumes
  const mainThrust = `${toPx(-0.065, 0.36)} ${toPx(0.065, 0.36)} ${toPx(0, 0.66)}`;
  const auxThrustL = `${toPx(-0.21, 0.43)} ${toPx(-0.15, 0.43)} ${toPx(-0.18, 0.58)}`;
  const auxThrustR = `${toPx(0.15, 0.43)} ${toPx(0.21, 0.43)} ${toPx(0.18, 0.58)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="thrust-main" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e0f2fe"/>
      <stop offset="35%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="thrust-aux" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e0f2fe"/>
      <stop offset="40%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
    </linearGradient>
    <filter id="crimson-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="5" flood-color="#f43f5e" flood-opacity="0.7"/>
    </filter>
  </defs>

  <!-- Background -->
  <rect width="512" height="512" fill="#0b0f19"/>

  <!-- Radar Reticle Rings -->
  <circle cx="256" cy="256" r="${rOuter}" fill="none" stroke="#1e293b" stroke-width="3" stroke-dasharray="10 8"/>
  <circle cx="256" cy="256" r="${rMid}" fill="none" stroke="#38bdf8" stroke-width="2" stroke-opacity="0.35"/>
  <circle cx="256" cy="256" r="${rInner}" fill="none" stroke="#1e293b" stroke-width="2"/>

  <!-- Radar Axis Crosshair Ticks -->
  <path d="M256,52 L256,88 M256,424 L256,460 M52,256 L88,256 M424,256 L460,256" stroke="#1e293b" stroke-width="2.5" stroke-linecap="round"/>

  <!-- Broadside Crimson Accent Arcs (#f43f5e) -->
  <path d="M ${arcLStart} A ${arcR} ${arcR} 0 0 0 ${arcLEnd}" fill="none" stroke="#f43f5e" stroke-width="7" stroke-linecap="round" filter="url(#crimson-glow)"/>
  <path d="M ${arcRStart} A ${arcR} ${arcR} 0 0 1 ${arcREnd}" fill="none" stroke="#f43f5e" stroke-width="7" stroke-linecap="round" filter="url(#crimson-glow)"/>

  <!-- Thruster Exhaust Plumes (#38bdf8) -->
  <polygon points="${mainThrust}" fill="url(#thrust-main)"/>
  <polygon points="${auxThrustL}" fill="url(#thrust-aux)"/>
  <polygon points="${auxThrustR}" fill="url(#thrust-aux)"/>

  <!-- Starship Hull Plates -->
  <!-- Main Wing Plates -->
  <polygon points="${polyToSvg(POLY_WING_LEFT)}" fill="#e2e8f0"/>
  <polygon points="${polyToSvg(POLY_WING_RIGHT)}" fill="#cbd5e1"/>

  <!-- Armor Flank Chafers -->
  <polygon points="${polyToSvg(POLY_CHAFER_LEFT)}" fill="#94a3b8"/>
  <polygon points="${polyToSvg(POLY_CHAFER_RIGHT)}" fill="#94a3b8"/>

  <!-- Forward Prow Plates -->
  <polygon points="${polyToSvg(POLY_PROW_LEFT)}" fill="#f8fafc"/>
  <polygon points="${polyToSvg(POLY_PROW_RIGHT)}" fill="#e2e8f0"/>

  <!-- Engine Bulkhead -->
  <polygon points="${toPx(-0.12, 0.36)} ${toPx(0.12, 0.36)} ${toPx(0.08, 0.40)} ${toPx(-0.08, 0.40)}" fill="#1e293b"/>

  <!-- Armor Panel Seam Lines -->
  <path d="M ${toPx(-0.11, -0.30)} L ${toPx(0, -0.24)} L ${toPx(0.11, -0.30)}" fill="none" stroke="#334155" stroke-width="2"/>
  <path d="M ${toPx(-0.36, 0.16)} L ${toPx(-0.03, 0.12)}" fill="none" stroke="#334155" stroke-width="1.5"/>
  <path d="M ${toPx(0.36, 0.16)} L ${toPx(0.03, 0.12)}" fill="none" stroke="#334155" stroke-width="1.5"/>

  <!-- Central Spine Conduit (#38bdf8) -->
  <path d="M ${toPx(0, -0.34)} L ${toPx(0, -0.22)} M ${toPx(0, -0.07)} L ${toPx(0, 0.30)}" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/>

  <!-- Bridge Diamond & Glow (#38bdf8 + #e0f2fe) -->
  <polygon points="${polyToSvg(POLY_BRIDGE_OUTER)}" fill="#38bdf8"/>
  <polygon points="${polyToSvg(POLY_BRIDGE_INNER)}" fill="#e0f2fe"/>
</svg>`;
}

/**
 * Generates PWA icon assets and writes them into output directory.
 * @param {string} [outDir] Target directory, defaults to public/icons
 * @param {object} [options] Optional generation settings
 * @param {Array<{ name: string, size: number, isMaskable?: boolean }>} [options.specs] Custom icon specs
 * @returns {Promise<Record<string, { path: string, size: number }>>}
 */
export async function generateIcons(outDir = path.resolve(__dirname, '../public/icons'), options = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const files = options.specs || [
    { name: 'icon-192.png', size: 192, isMaskable: false },
    { name: 'icon-512.png', size: 512, isMaskable: false },
    { name: 'icon-maskable-192.png', size: 192, isMaskable: true },
    { name: 'icon-maskable-512.png', size: 512, isMaskable: true },
    { name: 'apple-touch-icon-180.png', size: 180, isMaskable: false },
  ];

  const results = {};

  for (const item of files) {
    const pngBuf = renderIcon(item.size, { isMaskable: Boolean(item.isMaskable) });
    const targetPath = path.join(outDir, item.name);
    fs.writeFileSync(targetPath, pngBuf);
    results[item.name] = { path: targetPath, size: pngBuf.length };
  }

  const svgContent = generateSvg();
  const svgPath = path.join(outDir, 'icon.svg');
  fs.writeFileSync(svgPath, svgContent, 'utf8');
  results['icon.svg'] = { path: svgPath, size: Buffer.byteLength(svgContent, 'utf8') };

  return results;
}

// Entrypoint CLI execution guard
const isCli = Boolean(
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
   pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
);

if (isCli) {
  generateIcons()
    .then((results) => {
      console.log('Successfully generated all Broadside Hyperion PWA icon assets:');
      for (const [name, info] of Object.entries(results)) {
        console.log(` - ${name}: ${info.size} bytes -> ${info.path}`);
      }
    })
    .catch((err) => {
      console.error('Failed to generate icons:', err);
      process.exit(1);
    });
}
