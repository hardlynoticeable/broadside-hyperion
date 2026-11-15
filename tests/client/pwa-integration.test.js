/**
 * BROADSIDE HYPERION — Phase 21 Slice 4: PWA HTML, CSS, Client Entry Wiring & Live Integration Tests
 *
 * Validates:
 * - public/index.html and public/spectate.html PWA meta tags, manifest link, icons, install button, and iOS hints
 * - public/css/style.css safe-area insets, install button, iOS instructions, and spectate stack styling
 * - Strict zero-emoji audit across all PWA HTML, CSS, JS, manifest, and SVG files
 * - public/js/main.js and public/js/spectator.js static initPwa imports with zero await import(...)
 * - Live Express HTTP and HTTPS delivery for /manifest.webmanifest and /sw.js with correct headers
 * - Critical precache audit: EVERY asset in APP_SHELL_ASSETS resolves with HTTP 200 over HTTP & HTTPS
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { createAppServer } from '../../src/server/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const publicDir = path.resolve(rootDir, 'public');

const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

/**
 * Extracts APP_SHELL_ASSETS string array from public/sw.js without running full worker.
 * @param {string} swSource
 * @returns {string[]}
 */
function extractAppShellAssets(swSource) {
  const match = swSource.match(/const\s+APP_SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error('APP_SHELL_ASSETS declaration not found in sw.js');
  }
  const rawItems = match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0 && !item.startsWith('//'));
  return rawItems;
}

/**
 * HTTP GET request helper.
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      })
      .on('error', reject);
  });
}

/**
 * HTTPS GET request helper.
 */
function httpsGet(url, caCert) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { ca: caCert, rejectUnauthorized: true }, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      })
      .on('error', reject);
  });
}

describe('Phase 21 Slice 4 — HTML, CSS, Client Entry Wiring & Live Integration Tests', () => {
  let activeServer = null;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = null;
    }
  });

  describe('Static HTML & Head Tag Verification', () => {
    it('public/index.html includes complete PWA meta tags, manifest, icons, and install UI', () => {
      const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

      // Head metadata & manifest
      expect(html).toMatch(/<meta\s+name="theme-color"\s+content="#0b0f19">/);
      expect(html).toMatch(/<meta\s+name="mobile-web-app-capable"\s+content="yes">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="HYPERION">/);
      expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest">/);
      expect(html).toMatch(/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/icons\/icon\.svg">/);
      expect(html).toMatch(/<link\s+rel="icon"\s+type="image\/png"\s+sizes="192x192"\s+href="\/icons\/icon-192\.png">/);
      expect(html).toMatch(/<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/apple-touch-icon-180\.png">/);

      // Lobby overlay & actions
      expect(html).toMatch(/id="lobby-overlay"[^>]*class="[^"]*modal-overlay active[^"]*"/);
      expect(html).toMatch(/id="btn-open-lobby"[^>]*class="[^"]*btn-hud-action active[^"]*"/);

      // Install button and iOS hint
      expect(html).toContain('id="btn-install-app"');
      expect(html).toMatch(/id="btn-install-app"[^>]*class="[^"]*btn-install-app hidden[^"]*"/);
      expect(html).toContain('INSTALL APP');

      expect(html).toContain('id="ios-install-hint"');
      expect(html).toMatch(/id="ios-install-hint"[^>]*class="[^"]*ios-install-hint hidden[^"]*"/);
      expect(html).toContain('id="btn-dismiss-ios-hint"');
      expect(html).toContain('INSTALL APP ON IPAD / IPHONE: TAP SAFARI SHARE, THEN ADD TO HOME SCREEN');
    });

    it('public/spectate.html includes complete PWA meta tags, manifest, icons, spectate stack, and install UI', () => {
      const html = fs.readFileSync(path.join(publicDir, 'spectate.html'), 'utf8');

      // Head metadata & manifest
      expect(html).toMatch(/<meta\s+name="theme-color"\s+content="#0b0f19">/);
      expect(html).toMatch(/<meta\s+name="mobile-web-app-capable"\s+content="yes">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent">/);
      expect(html).toMatch(/<meta\s+name="apple-mobile-web-app-title"\s+content="HYPERION">/);
      expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest">/);
      expect(html).toMatch(/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/icons\/icon\.svg">/);
      expect(html).toMatch(/<link\s+rel="icon"\s+type="image\/png"\s+sizes="192x192"\s+href="\/icons\/icon-192\.png">/);
      expect(html).toMatch(/<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/icons\/apple-touch-icon-180\.png">/);

      // Spectate corner stack
      expect(html).toContain('class="spectate-corner-stack"');
      expect(html).toContain('id="spectate-hud-corner"');
      expect(html).toContain('id="btn-spectate-start"');

      // Install button and iOS hint
      expect(html).toContain('id="btn-install-app"');
      expect(html).toMatch(/id="btn-install-app"[^>]*class="[^"]*btn-install-app hidden[^"]*"/);
      expect(html).toContain('id="ios-install-hint"');
      expect(html).toMatch(/id="ios-install-hint"[^>]*class="[^"]*ios-install-hint ios-install-hint-spectate hidden[^"]*"/);
      expect(html).toContain('id="btn-dismiss-ios-hint"');

      // Preserves existing overlays
      expect(html).toContain('id="spectate-kill-cam"');
      expect(html).toContain('id="spectate-replay-banner"');
      expect(html).toContain('id="spectate-victor-overlay"');
    });
  });

  describe('CSS Safe Area Insets & Dark Alloy Styling', () => {
    it('public/css/style.css defines safe-area insets, install button, and dark alloy banner styling', () => {
      const css = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');

      // Safe-area horizontal padding on .hud-bar
      expect(css).toMatch(/\.hud-bar\s*\{[\s\S]*?padding:\s*0\s+max\(16px,\s*env\(safe-area-inset-right\)\)\s+0\s+max\(16px,\s*env\(safe-area-inset-left\)\);/);
      expect(css).toMatch(/\.hud-bar\s*\{[\s\S]*?height:\s*54px;/);

      // Modal actions & install button
      expect(css).toContain('.modal-header-actions');
      expect(css).toContain('.btn-install-app');
      expect(css).toContain('.ios-install-hint');
      expect(css).toContain('.btn-dismiss-hint');

      // Spectate stack and hint override
      expect(css).toContain('.spectate-corner-stack');
      expect(css).toContain('.spectate-corner-stack .spectate-floating-corner');
      expect(css).toContain('.ios-install-hint-spectate');

      // Ensure .hidden display: none !important rule exists
      expect(css).toMatch(/\.hidden\s*\{[\s\S]*?display:\s*none\s*!important;/);
    });
  });

  describe('Strict Zero-Emoji Auditing (Rule #29)', () => {
    const filesToAudit = [
      'index.html',
      'spectate.html',
      'css/style.css',
      'js/pwa.js',
      'sw.js',
      'manifest.webmanifest',
      'icons/icon.svg',
    ];

    for (const relPath of filesToAudit) {
      it(`public/${relPath} strictly contains zero emojis`, () => {
        const filePath = path.join(publicDir, relPath);
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf8');
        expect(EMOJI_REGEX.test(content)).toBe(false);
      });
    }
  });

  describe('Client Entrypoint Static Imports & Headless Safety', () => {
    it('public/js/main.js statically imports initPwa from ./pwa.js with zero await import(...)', () => {
      const mainPath = path.join(publicDir, 'js/main.js');
      const mainSource = fs.readFileSync(mainPath, 'utf8');

      expect(mainSource).toMatch(/import\s*\{[^}]*initPwa[^}]*\}\s*from\s*['"]\.\/pwa\.js['"]/);
      expect(mainSource).not.toMatch(/await\s+import\s*\(/);
      expect(mainSource).toContain('this.pwa = initPwa();');
      expect(mainSource).toContain('this.pwa.destroy();');
    });

    it('public/js/spectator.js statically imports initPwa from ./pwa.js with zero await import(...)', () => {
      const specPath = path.join(publicDir, 'js/spectator.js');
      const specSource = fs.readFileSync(specPath, 'utf8');

      expect(specSource).toMatch(/import\s*\{[^}]*initPwa[^}]*\}\s*from\s*['"]\.\/pwa\.js['"]/);
      expect(specSource).not.toMatch(/await\s+import\s*\(/);
      expect(specSource).toContain('initPwa()');
      expect(specSource).toContain('this.pwa.destroy();');
    });
  });

  describe('Live Express HTTP Delivery Integration', () => {
    it('serves /manifest.webmanifest with HTTP 200, application/manifest+json, and valid JSON payload', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: false,
      });

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const res = await httpGet(`http://127.0.0.1:${boundPort}/manifest.webmanifest`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/manifest+json');
      expect(res.headers['cache-control']).toContain('no-cache');

      const manifestData = JSON.parse(res.body);
      const expectedManifest = JSON.parse(
        fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8')
      );
      expect(manifestData).toEqual(expectedManifest);
      expect(manifestData.name).toBe('BROADSIDE HYPERION');
      expect(manifestData.short_name).toBe('HYPERION');
      expect(manifestData.start_url).toBe('/');
      expect(manifestData.display).toBe('standalone');
      expect(Array.isArray(manifestData.icons)).toBe(true);
      expect(manifestData.icons.length).toBe(5);
    });

    it('serves /sw.js with HTTP 200, application/javascript, service-worker-allowed, and no-cache', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: false,
      });

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const res = await httpGet(`http://127.0.0.1:${boundPort}/sw.js`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers['service-worker-allowed']).toBe('/');
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(res.body).toContain('APP_SHELL_ASSETS');
    });

    it('CRITICAL PRECACHE AUDIT (HTTP): serves every single asset in APP_SHELL_ASSETS with HTTP 200', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: false,
      });

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
      const assets = extractAppShellAssets(swSource);
      expect(assets.length).toBeGreaterThanOrEqual(20);

      for (const assetPath of assets) {
        const url = `http://127.0.0.1:${boundPort}${assetPath}`;
        const res = await httpGet(url);
        expect(
          res.statusCode,
          `Expected HTTP 200 for precache asset: "${assetPath}" (status was ${res.statusCode})`
        ).toBe(200);
      }
    });
  });

  describe('Live Express HTTPS Delivery Integration', () => {
    it('serves /manifest.webmanifest with HTTPS 200 and valid headers', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: { persist: false },
      });

      expect(activeServer.protocol).toBe('https');
      expect(activeServer.tls).toBeDefined();

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const res = await httpsGet(
        `https://127.0.0.1:${boundPort}/manifest.webmanifest`,
        activeServer.tls.cert
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/manifest+json');

      const manifestData = JSON.parse(res.body);
      expect(manifestData.name).toBe('BROADSIDE HYPERION');
    });

    it('serves /sw.js with HTTPS 200 and root scope header', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: { persist: false },
      });

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const res = await httpsGet(
        `https://127.0.0.1:${boundPort}/sw.js`,
        activeServer.tls.cert
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers['service-worker-allowed']).toBe('/');
    });

    it('CRITICAL PRECACHE AUDIT (HTTPS): serves every single asset in APP_SHELL_ASSETS with HTTPS 200', async () => {
      activeServer = createAppServer({
        port: 0,
        listen: true,
        autoStartLoop: false,
        https: { persist: false },
      });

      if (!activeServer.server.listening) {
        await new Promise((resolve) => activeServer.server.once('listening', resolve));
      }
      const boundPort = activeServer.server.address().port;

      const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
      const assets = extractAppShellAssets(swSource);

      for (const assetPath of assets) {
        const url = `https://127.0.0.1:${boundPort}${assetPath}`;
        const res = await httpsGet(url, activeServer.tls.cert);
        expect(
          res.statusCode,
          `Expected HTTPS 200 for precache asset: "${assetPath}" (status was ${res.statusCode})`
        ).toBe(200);
      }
    });
  });
});
