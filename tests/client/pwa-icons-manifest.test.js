/**
 * BROADSIDE HYPERION — Phase 21 Slice 2: PWA Icons & Web App Manifest Test
 *
 * Validates:
 * - public/manifest.webmanifest JSON structure, required values, zero emojis
 * - Presence on disk of every referenced icon + apple-touch-icon-180.png
 * - Binary PNG format: 8-byte signature, IHDR chunk dimensions, non-empty IDAT payload
 * - public/icons/icon.svg: valid SVG root, viewBox 0 0 512 512, zero emojis, zero text
 * - Maskable icon 70% safe zone compliance and full-bleed #0b0f19 background
 * - scripts/generate-icons.js helper exports (encodePngRgba, crc32, pngChunk, generateIcons)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crc32,
  pngChunk,
  encodePngRgba,
  sampleEmblem,
  renderIcon,
  generateSvg,
  generateIcons,
} from '../../scripts/generate-icons.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const publicDir = path.resolve(rootDir, 'public');
const manifestPath = path.resolve(publicDir, 'manifest.webmanifest');
const iconsDir = path.resolve(publicDir, 'icons');

// Emoji detector regex
const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

describe('Phase 21 Slice 2 — Zero-Dependency PWA Icons & Web App Manifest', () => {
  let manifest;
  let manifestRaw;

  beforeAll(async () => {
    // Ensure icons are generated and present before running tests
    await generateIcons(iconsDir);

    expect(fs.existsSync(manifestPath)).toBe(true);
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(manifestRaw);
  });

  describe('Web App Manifest (public/manifest.webmanifest)', () => {
    it('is valid JSON and strictly contains zero emojis', () => {
      expect(typeof manifest).toBe('object');
      expect(manifest).not.toBeNull();
      expect(EMOJI_REGEX.test(manifestRaw)).toBe(false);
    });

    it('defines exact required top-level metadata', () => {
      expect(manifest.id).toBe('/');
      expect(manifest.name).toBe('BROADSIDE HYPERION');
      expect(manifest.short_name).toBe('HYPERION');
      expect(typeof manifest.description).toBe('string');
      expect(manifest.description.length).toBeGreaterThan(0);
      expect(manifest.start_url).toBe('/');
      expect(manifest.scope).toBe('/');
      expect(manifest.display).toBe('standalone');
      expect(manifest.display_override).toEqual(['standalone', 'fullscreen']);
      expect(manifest.orientation).toBe('landscape');
      expect(manifest.theme_color).toBe('#0b0f19');
      expect(manifest.background_color).toBe('#0b0f19');
      expect(manifest.categories).toEqual(['games', 'entertainment']);
    });

    it('declares all required icons with accurate types, sizes, and purposes', () => {
      expect(Array.isArray(manifest.icons)).toBe(true);
      expect(manifest.icons.length).toBe(5);

      const expectedIcons = [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      ];

      for (const expected of expectedIcons) {
        const found = manifest.icons.find(i => i.src === expected.src);
        expect(found, `Icon ${expected.src} not found in manifest`).toBeDefined();
        expect(found.sizes).toBe(expected.sizes);
        expect(found.type).toBe(expected.type);
        expect(found.purpose).toBe(expected.purpose);
      }
    });

    it('declares required shortcuts pointing to / and /spectate with icon references', () => {
      expect(Array.isArray(manifest.shortcuts)).toBe(true);
      expect(manifest.shortcuts.length).toBe(2);

      const bridgeShortcut = manifest.shortcuts.find(s => s.url === '/');
      expect(bridgeShortcut).toBeDefined();
      expect(bridgeShortcut.name).toBe('Bridge Console');
      expect(bridgeShortcut.short_name).toBe('Bridge');
      expect(bridgeShortcut.icons[0].src).toBe('/icons/icon-192.png');
      expect(bridgeShortcut.icons[0].sizes).toBe('192x192');

      const spectateShortcut = manifest.shortcuts.find(s => s.url === '/spectate');
      expect(spectateShortcut).toBeDefined();
      expect(spectateShortcut.name).toBe('Spectator View');
      expect(spectateShortcut.short_name).toBe('Spectate');
      expect(spectateShortcut.icons[0].src).toBe('/icons/icon-192.png');
      expect(spectateShortcut.icons[0].sizes).toBe('192x192');
    });
  });

  describe('Static Icon Assets on Disk', () => {
    const requiredFiles = [
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-192.png',
      'icon-maskable-512.png',
      'apple-touch-icon-180.png',
      'icon.svg',
    ];

    it.each(requiredFiles)('verifies %s exists on disk and is non-empty', (filename) => {
      const filePath = path.join(iconsDir, filename);
      expect(fs.existsSync(filePath), `Missing ${filename}`).toBe(true);
      const stat = fs.statSync(filePath);
      expect(stat.size).toBeGreaterThan(500);
    });
  });

  describe('Binary PNG Encoding Verification', () => {
    const pngSpecs = [
      { file: 'icon-192.png', width: 192, height: 192, isMaskable: false },
      { file: 'icon-512.png', width: 512, height: 512, isMaskable: false },
      { file: 'icon-maskable-192.png', width: 192, height: 192, isMaskable: true },
      { file: 'icon-maskable-512.png', width: 512, height: 512, isMaskable: true },
      { file: 'apple-touch-icon-180.png', width: 180, height: 180, isMaskable: false },
    ];

    it.each(pngSpecs)('validates binary PNG headers, dimensions, and IDAT payload for $file', ({ file, width, height }) => {
      const filePath = path.join(iconsDir, file);
      const buf = fs.readFileSync(filePath);

      // 1. Verify 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A
      const expectedSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(buf.subarray(0, 8).equals(expectedSig)).toBe(true);

      // 2. Verify IHDR chunk
      const ihdrLen = buf.readUInt32BE(8);
      expect(ihdrLen).toBe(13);
      const ihdrType = buf.subarray(12, 16).toString('ascii');
      expect(ihdrType).toBe('IHDR');

      const imgWidth = buf.readUInt32BE(16);
      const imgHeight = buf.readUInt32BE(20);
      expect(imgWidth).toBe(width);
      expect(imgHeight).toBe(height);

      const bitDepth = buf.readUInt8(24);
      expect(bitDepth).toBe(8); // 8 bits per channel

      const colorType = buf.readUInt8(25);
      expect(colorType).toBe(6); // RGBA

      const compMethod = buf.readUInt8(26);
      expect(compMethod).toBe(0); // Deflate

      const filterMethod = buf.readUInt8(27);
      expect(filterMethod).toBe(0); // Standard filter method

      const interlace = buf.readUInt8(28);
      expect(interlace).toBe(0); // No interlace

      // Verify IHDR CRC
      const ihdrCrc = buf.readUInt32BE(29);
      const calcIhdrCrc = crc32(buf.subarray(12, 29));
      expect(ihdrCrc).toBe(calcIhdrCrc);

      // 3. Scan for IDAT and IEND chunks
      let offset = 33;
      let foundIdat = false;
      let idatLength = 0;
      let foundIend = false;

      while (offset < buf.length) {
        const chunkLen = buf.readUInt32BE(offset);
        const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
        const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLen);
        const chunkCrc = buf.readUInt32BE(offset + 8 + chunkLen);

        // Verify chunk CRC
        const calcCrc = crc32(buf.subarray(offset + 4, offset + 8 + chunkLen));
        expect(chunkCrc).toBe(calcCrc);

        if (chunkType === 'IDAT') {
          foundIdat = true;
          idatLength += chunkLen;
        } else if (chunkType === 'IEND') {
          foundIend = true;
          expect(chunkLen).toBe(0);
        }

        offset += 12 + chunkLen;
      }

      expect(foundIdat).toBe(true);
      expect(idatLength).toBeGreaterThan(100);
      expect(foundIend).toBe(true);
      expect(offset).toBe(buf.length);
    });
  });

  describe('Maskable Icon Safe Zone & Palette Compliance', () => {
    it('guarantees corners and safe-zone perimeter remain solid #0b0f19 for maskable icons', () => {
      // Test sampleEmblem outside the 70% safe zone (r > 0.55 in emblem space)
      // At scale 0.60, canvas radius r_c = r_e * 0.60. For r_c >= 0.35 * 2 = 0.70, r_e >= 1.16
      const corners = [
        [-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0],
        [-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8],
      ];

      for (const [uNorm, vNorm] of corners) {
        // In maskable icon, canvas coords (uNorm, vNorm) scale to emblem (uNorm / 0.60, vNorm / 0.60)
        const [r, g, b, a] = sampleEmblem(uNorm / 0.60, vNorm / 0.60);
        expect(r).toBe(11);
        expect(g).toBe(15);
        expect(b).toBe(25);
        expect(a).toBe(255);
      }
    });

    it('verifies apple-touch-icon-180.png has opaque background #0b0f19', () => {
      // Four outer corners of apple-touch-icon (normalized canvas +-0.95)
      const testPoints = [
        [-0.95, -0.95], [0.95, -0.95], [-0.95, 0.95], [0.95, 0.95],
      ];
      for (const [cx, cy] of testPoints) {
        const [r, g, b, a] = sampleEmblem(cx / 0.85, cy / 0.85);
        expect(r).toBe(11);
        expect(g).toBe(15);
        expect(b).toBe(25);
        expect(a).toBe(255);
      }
    });

    it('samples forward starship prow and bridge glow accurately in emblem space', () => {
      // Bridge diamond core at (0, -0.15) should be bright #e0f2fe
      const [rB, gB, bB] = sampleEmblem(0, -0.15);
      expect(rB).toBe(224);
      expect(gB).toBe(242);
      expect(bB).toBe(254);

      // Starboard prow armor plate at (0.05, -0.50) should be #e2e8f0
      const [rP, gP, bP] = sampleEmblem(0.05, -0.50);
      expect(rP).toBe(226);
      expect(gP).toBe(232);
      expect(bP).toBe(240);

      // Crimson broadside arc at (0.66, 0.05) should be #f43f5e
      const [rC, gC, bC] = sampleEmblem(0.66, 0.05);
      expect(rC).toBe(244);
      expect(gC).toBe(63);
      expect(bC).toBe(94);
    });
  });

  describe('Vector SVG Icon (public/icons/icon.svg)', () => {
    let svgContent;

    beforeAll(() => {
      const svgPath = path.join(iconsDir, 'icon.svg');
      expect(fs.existsSync(svgPath)).toBe(true);
      svgContent = fs.readFileSync(svgPath, 'utf8');
    });

    it('is valid SVG with viewBox="0 0 512 512"', () => {
      expect(svgContent.startsWith('<svg')).toBe(true);
      expect(svgContent.endsWith('</svg>')).toBe(true);
      expect(svgContent).toContain('viewBox="0 0 512 512"');
      expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    it('strictly contains zero emojis and zero text dependencies', () => {
      expect(EMOJI_REGEX.test(svgContent)).toBe(false);
      expect(svgContent).not.toContain('<text');
      expect(svgContent).not.toContain('<tspan');
    });

    it('contains all canonical theme colors: #0b0f19, #e2e8f0, #38bdf8, and #f43f5e', () => {
      expect(svgContent).toContain('#0b0f19'); // dark alloy background
      expect(svgContent).toContain('#1e293b'); // radar reticle
      expect(svgContent).toContain('#e2e8f0'); // hull plates
      expect(svgContent).toContain('#38bdf8'); // cyan spine & thrusters
      expect(svgContent).toContain('#f43f5e'); // crimson broadside arcs
    });
  });

  describe('Generator Script Exports (scripts/generate-icons.js)', () => {
    it('exports crc32, pngChunk, encodePngRgba, and generateIcons', () => {
      expect(typeof crc32).toBe('function');
      expect(typeof pngChunk).toBe('function');
      expect(typeof encodePngRgba).toBe('function');
      expect(typeof generateSvg).toBe('function');
      expect(typeof generateIcons).toBe('function');
    });

    it('crc32 correctly computes standard CRC-32 on test buffers', () => {
      // Known standard vector: CRC32 of ASCII 'IEND' is 0xAE426082
      const iendBuf = Buffer.from('IEND', 'ascii');
      expect(crc32(iendBuf)).toBe(0xae426082);

      // Empty buffer CRC is 0
      expect(crc32(Buffer.alloc(0))).toBe(0);
    });

    it('pngChunk constructs valid [length, type, data, crc] buffers', () => {
      const chunk = pngChunk('IEND', Buffer.alloc(0));
      expect(chunk.length).toBe(12); // 4 len + 4 type + 0 data + 4 crc
      expect(chunk.readUInt32BE(0)).toBe(0);
      expect(chunk.subarray(4, 8).toString('ascii')).toBe('IEND');
      expect(chunk.readUInt32BE(8)).toBe(0xae426082);
    });

    it('encodePngRgba validates buffer length and throws on mismatch', () => {
      expect(() => encodePngRgba(16, 16, Buffer.alloc(100))).toThrow(/Expected rgbaBuffer length 1024/);
    });

    it('encodePngRgba produces valid PNG for custom dimension', () => {
      const w = 8, h = 8;
      const raw = Buffer.alloc(w * h * 4, 255);
      const png = encodePngRgba(w, h, raw);

      expect(png.readUInt32BE(16)).toBe(w);
      expect(png.readUInt32BE(20)).toBe(h);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });

    it('generateIcons writes PNG and SVG files to an arbitrary destination directory', async () => {
      const tmpDir = path.resolve(rootDir, 'tests/client/.tmp-icons-test');
      try {
        const results = await generateIcons(tmpDir, {
          specs: [
            { name: 'icon-32.png', size: 32, isMaskable: false },
            { name: 'icon-maskable-32.png', size: 32, isMaskable: true },
          ],
        });
        expect(Object.keys(results).length).toBe(3);
        const stdBuf = fs.readFileSync(path.join(tmpDir, 'icon-32.png'));
        const maskBuf = fs.readFileSync(path.join(tmpDir, 'icon-maskable-32.png'));
        expect(stdBuf.readUInt32BE(16)).toBe(32);
        expect(maskBuf.readUInt32BE(16)).toBe(32);
        expect(fs.existsSync(path.join(tmpDir, 'icon.svg'))).toBe(true);
      } finally {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });
  });
});
