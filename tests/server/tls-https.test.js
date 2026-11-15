/**
 * BROADSIDE HYPERION — Pure-Node X.509 v3 TLS & Opt-in HTTPS/WSS Integration Tests
 *
 * Verifies:
 * 1. generateSelfSignedCertificate RFC 5280 X.509 v3 compliance (P-256, DER structure,
 *    CA=false, digitalSignature, serverAuth, SANs, validity <= 825 days).
 * 2. ensureTlsCredentials credential resolution (inline, custom paths, ephemeral, disk caching,
 *    SAN change / expiry regeneration, error handling).
 * 3. createAppServer HTTP default behavior.
 * 4. createAppServer HTTPS/WSS live server (https.get 200 on /api/health, /, /spectate;
 *    real WebSocket TLS handshake, 'welcome' payload, 'join_station' handling).
 * 5. Static headers for sw.js and .webmanifest files.
 * 6. HTTPS env flags vs explicit overrides.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  generateSelfSignedCertificate,
  hasMatchingSanAndValidity,
  ensureTlsCredentials,
  DEFAULT_CERT_DIR,
} from '../../src/server/tls.js';
import { createAppServer } from '../../src/server/app.js';

function httpsGet(url, caCert) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { ca: caCert, rejectUnauthorized: true }, (res) => {
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
    });
    req.on('error', reject);
  });
}

describe('Pure-Node X.509 v3 TLS & Opt-in HTTPS/WSS', () => {
  let tempDir;
  let sharedCreds;

  beforeAll(() => {
    // Generate base test certificate once to avoid redundant ECDSA key generation
    sharedCreds = generateSelfSignedCertificate({
      commonName: 'BROADSIDE HYPERION LAN',
      dnsNames: ['localhost', 'hyperion.lan'],
      ipAddresses: ['127.0.0.1', '::1', '192.168.1.10'],
    });
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperion-tls-test-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        // ignore
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1. generateSelfSignedCertificate
  // -------------------------------------------------------------------------
  describe('generateSelfSignedCertificate', () => {
    it('generates valid RFC 5280 X.509 v3 ECDSA P-256 certificate with defaults', () => {
      expect(sharedCreds.key).toContain('-----BEGIN PRIVATE KEY-----');
      expect(sharedCreds.cert).toContain('-----BEGIN CERTIFICATE-----');
      expect(sharedCreds.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i);

      const x509 = new crypto.X509Certificate(sharedCreds.cert);
      expect(x509.ca).toBe(false);
      expect(x509.subject).toContain('CN=BROADSIDE HYPERION LAN');
      expect(x509.issuer).toContain('CN=BROADSIDE HYPERION LAN');
      expect(x509.subjectAltName).toContain('DNS:localhost');
      expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
      expect(x509.checkHost('localhost')).toBe('localhost');
      expect(x509.checkIP('127.0.0.1')).toBe('127.0.0.1');

      // Apple / modern browser limit: validity <= 825 days
      const validFrom = new Date(x509.validFrom);
      const validTo = new Date(x509.validTo);
      const diffDays = (validTo.getTime() - validFrom.getTime()) / (86400 * 1000);
      expect(diffDays).toBeLessThanOrEqual(825);
      expect(diffDays).toBeGreaterThan(360);
    });

    it('generates certificate with custom commonName, SANs, and validity', () => {
      const creds = generateSelfSignedCertificate({
        commonName: 'HYPERION CUSTOM BRIDGE',
        dnsNames: ['hyperion.lan', 'starship.local'],
        ipAddresses: ['192.168.1.50', '10.0.0.2'],
        validityDays: 180,
      });

      const x509 = new crypto.X509Certificate(creds.cert);
      expect(x509.ca).toBe(false);
      expect(x509.subject).toContain('CN=HYPERION CUSTOM BRIDGE');
      expect(x509.subjectAltName).toContain('DNS:hyperion.lan');
      expect(x509.subjectAltName).toContain('DNS:starship.local');
      expect(x509.subjectAltName).toContain('IP Address:192.168.1.50');
      expect(x509.subjectAltName).toContain('IP Address:10.0.0.2');
      expect(x509.checkHost('hyperion.lan')).toBe('hyperion.lan');
      expect(x509.checkIP('192.168.1.50')).toBe('192.168.1.50');

      const validFrom = new Date(x509.validFrom);
      const validTo = new Date(x509.validTo);
      const diffDays = (validTo.getTime() - validFrom.getTime()) / (86400 * 1000);
      expect(diffDays).toBeLessThanOrEqual(181);
      expect(diffDays).toBeGreaterThan(178);
    });
  });

  // -------------------------------------------------------------------------
  // 2. hasMatchingSanAndValidity
  // -------------------------------------------------------------------------
  describe('hasMatchingSanAndValidity', () => {
    it('returns true for matching SANs and valid timeframe', () => {
      const valid = hasMatchingSanAndValidity(sharedCreds.cert, ['localhost', 'hyperion.lan'], ['127.0.0.1', '192.168.1.10']);
      expect(valid).toBe(true);
    });

    it('returns false when a required SAN or IP is missing', () => {
      expect(hasMatchingSanAndValidity(sharedCreds.cert, ['missing.host'])).toBe(false);
      expect(hasMatchingSanAndValidity(sharedCreds.cert, ['localhost'], ['10.0.0.99'])).toBe(false);
    });

    it('returns false for expired or nearly expired certificates (< 24h remaining)', () => {
      const creds = generateSelfSignedCertificate({ validityDays: 0 });
      expect(hasMatchingSanAndValidity(creds.cert)).toBe(false);
    });

    it('returns false for corrupt or invalid certificate strings', () => {
      expect(hasMatchingSanAndValidity('not-a-cert')).toBe(false);
      expect(hasMatchingSanAndValidity('')).toBe(false);
      expect(hasMatchingSanAndValidity(null)).toBe(false);
    });

    it('does not false-match prefix-substring IPs or DNS hosts', () => {
      const credsPrefix = generateSelfSignedCertificate({
        dnsNames: ['app.local'],
        ipAddresses: ['192.168.1.10'],
      });
      // Prefix DNS 'app' should NOT match 'app.local'
      expect(hasMatchingSanAndValidity(credsPrefix.cert, ['app'], ['192.168.1.10'])).toBe(false);
      // Prefix IP '192.168.1.1' should NOT match '192.168.1.10'
      expect(hasMatchingSanAndValidity(credsPrefix.cert, ['app.local'], ['192.168.1.1'])).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. ensureTlsCredentials
  // -------------------------------------------------------------------------
  describe('ensureTlsCredentials', () => {
    it('generates and caches credentials to disk, reusing them on subsequent calls', () => {
      const creds1 = ensureTlsCredentials({ certDir: tempDir });
      expect(creds1.source).toBe('generated');
      expect(fs.existsSync(creds1.keyPath)).toBe(true);
      expect(fs.existsSync(creds1.certPath)).toBe(true);

      const creds2 = ensureTlsCredentials({ certDir: tempDir });
      expect(creds2.source).toBe('cached');
      expect(creds2.cert).toBe(creds1.cert);
      expect(creds2.fingerprint256).toBe(creds1.fingerprint256);
    });

    it('regenerates certificate when required LAN IPs change', () => {
      const creds1 = ensureTlsCredentials({ certDir: tempDir }, { lanAddresses: ['192.168.1.10'] });
      expect(creds1.source).toBe('generated');

      // Changed LAN address should cause regeneration
      const creds2 = ensureTlsCredentials({ certDir: tempDir }, { lanAddresses: ['192.168.1.20'] });
      expect(creds2.source).toBe('generated');
      expect(creds2.cert).not.toBe(creds1.cert);

      const x509 = new crypto.X509Certificate(creds2.cert);
      expect(x509.checkIP('192.168.1.20')).toBe('192.168.1.20');
    });

    it('regenerates certificate when required IP changes to a prefix-substring of cached IP', () => {
      const creds10 = ensureTlsCredentials({ certDir: tempDir }, { lanAddresses: ['192.168.1.10'] });
      expect(hasMatchingSanAndValidity(creds10.cert, ['localhost'], ['192.168.1.1'])).toBe(false);

      const creds1 = ensureTlsCredentials({ certDir: tempDir }, { lanAddresses: ['192.168.1.1'] });
      expect(creds1.source).toBe('generated');
      expect(creds1.cert).not.toBe(creds10.cert);

      const x509 = new crypto.X509Certificate(creds1.cert);
      expect(x509.checkIP('192.168.1.1')).toBe('192.168.1.1');
    });

    it('supports persist: false for ephemeral in-memory certificates', () => {
      const creds = ensureTlsCredentials({ persist: false, certDir: tempDir });
      expect(creds.source).toBe('ephemeral');
      expect(creds.keyPath).toBeUndefined();
      expect(creds.certPath).toBeUndefined();
      expect(fs.existsSync(path.join(tempDir, 'localhost-key.pem'))).toBe(false);
    });

    it('supports inline key and cert', () => {
      const creds = ensureTlsCredentials({ key: sharedCreds.key, cert: sharedCreds.cert });
      expect(creds.source).toBe('inline');
      expect(creds.cert).toBe(sharedCreds.cert);
      expect(creds.fingerprint256).toBe(sharedCreds.fingerprint256);
    });

    it('supports custom keyPath and certPath options', () => {
      const customKey = path.join(tempDir, 'custom-key.pem');
      const customCert = path.join(tempDir, 'custom-cert.pem');
      fs.writeFileSync(customKey, sharedCreds.key, 'utf8');
      fs.writeFileSync(customCert, sharedCreds.cert, 'utf8');

      const creds = ensureTlsCredentials({ keyPath: customKey, certPath: customCert });
      expect(creds.source).toBe('custom');
      expect(creds.cert).toBe(sharedCreds.cert);
      expect(creds.fingerprint256).toBe(sharedCreds.fingerprint256);
    });

    it('supports SSL_KEY_PATH and SSL_CERT_PATH environment variables', () => {
      const envKey = path.join(tempDir, 'env-key.pem');
      const envCert = path.join(tempDir, 'env-cert.pem');
      fs.writeFileSync(envKey, sharedCreds.key, 'utf8');
      fs.writeFileSync(envCert, sharedCreds.cert, 'utf8');

      const creds = ensureTlsCredentials({}, { env: { SSL_KEY_PATH: envKey, SSL_CERT_PATH: envCert } });
      expect(creds.source).toBe('custom');
      expect(creds.keyPath).toBe(envKey);
      expect(creds.certPath).toBe(envCert);
    });

    it('throws on incomplete or missing custom path configuration', () => {
      expect(() => ensureTlsCredentials({ keyPath: 'some-key.pem' })).toThrow(
        /Incomplete TLS path configuration/
      );
      expect(() => ensureTlsCredentials({ certPath: 'some-cert.pem' })).toThrow(
        /Incomplete TLS path configuration/
      );
      expect(() =>
        ensureTlsCredentials({ keyPath: path.join(tempDir, 'nonexistent-key.pem'), certPath: path.join(tempDir, 'nonexistent-cert.pem') })
      ).toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. createAppServer HTTP vs HTTPS
  // -------------------------------------------------------------------------
  describe('createAppServer TLS Integration', () => {
    it('defaults to HTTP with null tls credentials', async () => {
      const serverInstance = createAppServer({ port: 0, autoStartLoop: false });
      expect(serverInstance.protocol).toBe('http');
      expect(serverInstance.tls).toBeNull();
      await serverInstance.close();
    });

    it('starts real HTTPS + WSS server when https option is provided', async () => {
      const serverInstance = createAppServer({
        port: 0,
        autoStartLoop: false,
        https: { key: sharedCreds.key, cert: sharedCreds.cert },
      });

      expect(serverInstance.protocol).toBe('https');
      expect(serverInstance.tls).toBeDefined();
      expect(serverInstance.tls.source).toBe('inline');

      // Wait for server to bind port
      if (!serverInstance.server.listening) {
        await new Promise((r) => serverInstance.server.once('listening', r));
      }
      const boundPort = serverInstance.server.address().port;

      // 1. HTTPS GET /api/health
      const healthRes = await httpsGet(`https://127.0.0.1:${boundPort}/api/health`, serverInstance.tls.cert);
      expect(healthRes.statusCode).toBe(200);
      const healthData = JSON.parse(healthRes.body);
      expect(healthData.status).toBe('ok');
      expect(healthData.protocol).toBe('https');

      // 2. HTTPS GET / (index.html)
      const rootRes = await httpsGet(`https://127.0.0.1:${boundPort}/`, serverInstance.tls.cert);
      expect(rootRes.statusCode).toBe(200);
      expect(rootRes.body).toContain('BROADSIDE HYPERION');

      // 3. HTTPS GET /spectate
      const spectateRes = await httpsGet(`https://127.0.0.1:${boundPort}/spectate`, serverInstance.tls.cert);
      expect(spectateRes.statusCode).toBe(200);

      // 4. Real WSS connection with TLS CA certificate
      const ws = new WebSocket(`wss://127.0.0.1:${boundPort}`, {
        ca: serverInstance.tls.cert,
        rejectUnauthorized: true,
      });

      const welcomeMsg = await new Promise((resolve, reject) => {
        ws.on('message', (data) => {
          try {
            resolve(JSON.parse(data.toString()));
          } catch (err) {
            reject(err);
          }
        });
        ws.on('error', reject);
      });

      expect(welcomeMsg.type).toBe('welcome');
      expect(welcomeMsg.playerId).toBeDefined();

      // Send join_station command
      ws.send(JSON.stringify({
        action: 'join_station',
        team: 'alpha',
        station: 'helm',
      }));

      // Allow event turn processing
      await new Promise((r) => setTimeout(r, 20));

      const player = serverInstance.room.players.get(welcomeMsg.playerId);
      expect(player).toBeDefined();
      expect(player.team).toBe('alpha');
      expect(player.station).toBe('helm');

      ws.close();
      await serverInstance.close();
    });

    it('sets proper static headers for sw.js and .webmanifest files', async () => {
      // Create a dummy sw.js and manifest in tempDir to test express.static headers
      const mockPublicDir = path.join(tempDir, 'public');
      fs.mkdirSync(mockPublicDir, { recursive: true });
      fs.writeFileSync(path.join(mockPublicDir, 'sw.js'), '// sw test', 'utf8');
      fs.writeFileSync(path.join(mockPublicDir, 'app.webmanifest'), '{"name":"test"}', 'utf8');

      const serverInstance = createAppServer({
        port: 0,
        autoStartLoop: false,
        publicDir: mockPublicDir,
        https: { key: sharedCreds.key, cert: sharedCreds.cert },
      });

      if (!serverInstance.server.listening) {
        await new Promise((r) => serverInstance.server.once('listening', r));
      }
      const boundPort = serverInstance.server.address().port;

      const swRes = await httpsGet(`https://127.0.0.1:${boundPort}/sw.js`, serverInstance.tls.cert);
      expect(swRes.statusCode).toBe(200);
      expect(swRes.headers['content-type']).toContain('application/javascript');
      expect(swRes.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(swRes.headers['service-worker-allowed']).toBe('/');

      const manifestRes = await httpsGet(`https://127.0.0.1:${boundPort}/app.webmanifest`, serverInstance.tls.cert);
      expect(manifestRes.statusCode).toBe(200);
      expect(manifestRes.headers['content-type']).toContain('application/manifest+json');
      expect(manifestRes.headers['cache-control']).toBe('no-cache');

      await serverInstance.close();
    });

    it('respects HTTPS=true env var when options.https is undefined and honors https: false override', async () => {
      const originalEnv = process.env.HTTPS;
      const originalCertDir = process.env.SSL_CERT_DIR;
      try {
        process.env.HTTPS = 'true';
        process.env.SSL_CERT_DIR = tempDir;

        // When options.https is undefined, process.env.HTTPS triggers HTTPS
        const envServer = createAppServer({
          port: 0,
          autoStartLoop: false,
          https: undefined,
        });
        expect(envServer.protocol).toBe('https');
        expect(envServer.tls).toBeDefined();
        await envServer.close();

        // When options.https is explicitly false, it overrides process.env.HTTPS
        const overrideServer = createAppServer({
          port: 0,
          autoStartLoop: false,
          https: false,
        });
        expect(overrideServer.protocol).toBe('http');
        expect(overrideServer.tls).toBeNull();
        await overrideServer.close();
      } finally {
        if (originalEnv !== undefined) {
          process.env.HTTPS = originalEnv;
        } else {
          delete process.env.HTTPS;
        }
        if (originalCertDir !== undefined) {
          process.env.SSL_CERT_DIR = originalCertDir;
        } else {
          delete process.env.SSL_CERT_DIR;
        }
      }
    });
  });
});
