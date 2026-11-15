/**
 * BROADSIDE HYPERION — Root-Scoped Service Worker & Client PWA Controller Tests
 *
 * Validates:
 * - public/sw.js execution in isolated ServiceWorkerGlobalScope (via node:vm)
 * - Service worker install event precaching APP_SHELL_ASSETS (including /js/textures.js) without auto-skipWaiting
 * - Precaching excludes /music/
 * - Service worker activate event cleaning obsolete broadside-hyperion caches and calling clients.claim()
 * - Service worker message event handling SKIP_WAITING
 * - Service worker fetch bypass logic (POST, cross-origin, /api/, /ws, /music/, Range, /sw.js)
 * - Service worker Network-First fetch strategy with cache put on HTTP 200
 * - Service worker offline fallbacks for /spectate and / navigation
 * - public/js/pwa.js isStandaloneMode detection across all display modes and referrers
 * - public/js/pwa.js isIosSafari detection including iPadOS desktop-mode and browser exclusions
 * - InstallPromptController lifecycle, button visibility, prompt execution, and iOS hint dismissal
 * - Service worker registration in secure HTTPS contexts and onUpdateFound notification
 * - Zero emojis throughout all files
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  IOS_HINT_DISMISSED_KEY,
  isStandaloneMode,
  isIosSafari,
  InstallPromptController,
  initPwa,
} from '../../public/js/pwa.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');
const publicDir = path.resolve(rootDir, 'public');
const swPath = path.resolve(publicDir, 'sw.js');
const pwaPath = path.resolve(publicDir, 'js/pwa.js');

const EMOJI_REGEX = /\p{Extended_Pictographic}/u;

describe('Phase 21 Slice 3 — Root-Scoped Service Worker & Client PWA Controller', () => {
  let swSource;
  let pwaSource;

  beforeAll(() => {
    expect(fs.existsSync(swPath)).toBe(true);
    expect(fs.existsSync(pwaPath)).toBe(true);

    swSource = fs.readFileSync(swPath, 'utf8');
    pwaSource = fs.readFileSync(pwaPath, 'utf8');
  });

  describe('Static Code Conventions & Emoji Auditing', () => {
    it('public/sw.js strictly contains zero emojis', () => {
      expect(EMOJI_REGEX.test(swSource)).toBe(false);
    });

    it('public/js/pwa.js strictly contains zero emojis', () => {
      expect(EMOJI_REGEX.test(pwaSource)).toBe(false);
    });

    it('public/sw.js is a classic script with no import or export keywords', () => {
      expect(/^\s*import\s+/m.test(swSource)).toBe(false);
      expect(/^\s*export\s+/m.test(swSource)).toBe(false);
    });

    it('public/js/pwa.js contains no top-level await', () => {
      expect(/^await\s+/m.test(pwaSource)).toBe(false);
    });
  });

  describe('Service Worker (public/sw.js) Global Scope Execution', () => {
    function createSwSandbox(origin = 'https://hyperion.lan') {
      const listeners = new Map();
      const cacheStorage = new Map();
      let skipWaitingCalls = 0;
      let claimCalls = 0;

      const getOrCreateStore = (name) => {
        let store = cacheStorage.get(name);
        if (!store) {
          store = new Map();
          cacheStorage.set(name, store);
        }
        return store;
      };

      const createCacheMock = (name) => {
        const store = getOrCreateStore(name);
        return {
          addAll: vi.fn(async (assets) => {
            for (const asset of assets) {
              store.set(asset, new Response(`shell:${asset}`, { status: 200 }));
            }
          }),
          put: vi.fn(async (req, res) => {
            const key = typeof req === 'string' ? req : req.url;
            store.set(key, res);
          }),
          match: vi.fn(async (req) => {
            const key = typeof req === 'string' ? req : req.url;
            if (store.has(key)) {
              return store.get(key);
            }
            try {
              const u = new URL(key, origin);
              if (store.has(u.pathname)) {
                return store.get(u.pathname);
              }
            } catch {
              // Ignore parse error
            }
            return undefined;
          }),
        };
      };

      const caches = {
        open: vi.fn(async (name) => createCacheMock(name)),
        keys: vi.fn(async () => Array.from(cacheStorage.keys())),
        delete: vi.fn(async (name) => cacheStorage.delete(name)),
        match: vi.fn(async (req) => {
          for (const name of cacheStorage.keys()) {
            const c = createCacheMock(name);
            const res = await c.match(req);
            if (res) {
              return res;
            }
          }
          return undefined;
        }),
      };

      const clients = {
        claim: vi.fn(async () => {
          claimCalls += 1;
        }),
      };

      const sandbox = {
        location: {
          origin,
          href: `${origin}/sw.js`,
          pathname: '/sw.js',
        },
        caches,
        clients,
        skipWaiting: vi.fn(async () => {
          skipWaitingCalls += 1;
        }),
        addEventListener: vi.fn((type, handler) => {
          if (!listeners.has(type)) {
            listeners.set(type, []);
          }
          listeners.get(type).push(handler);
        }),
        fetch: vi.fn(),
        URL,
        Headers,
        Request,
        Response,
        Promise,
        console,
        Set,
        Map,
        Array,
        Object,
        String,
        Boolean,
        Error,
      };
      sandbox.self = sandbox;

      const context = vm.createContext(sandbox);
      vm.runInContext(swSource, context);

      return {
        sandbox,
        listeners,
        cacheStorage,
        createCacheMock,
        getSkipWaitingCalls: () => skipWaitingCalls,
        getClaimCalls: () => claimCalls,
      };
    }

    it('registers install, activate, message, and fetch event listeners', () => {
      const { listeners } = createSwSandbox();
      expect(listeners.has('install')).toBe(true);
      expect(listeners.has('activate')).toBe(true);
      expect(listeners.has('message')).toBe(true);
      expect(listeners.has('fetch')).toBe(true);
    });

    it('install event precaches APP_SHELL_ASSETS in broadside-hyperion-v1 without auto-skipWaiting', async () => {
      const scope = createSwSandbox();
      const installHandler = scope.listeners.get('install')[0];

      let waitPromise = null;
      const event = {
        waitUntil: vi.fn((p) => {
          waitPromise = p;
        }),
      };

      installHandler(event);
      expect(event.waitUntil).toHaveBeenCalledTimes(1);
      await waitPromise;

      expect(scope.sandbox.caches.open).toHaveBeenCalledWith('broadside-hyperion-v1');
      expect(scope.getSkipWaitingCalls()).toBe(0);

      const store = scope.cacheStorage.get('broadside-hyperion-v1');
      expect(store).toBeDefined();

      const requiredAssets = [
        '/',
        '/index.html',
        '/spectate',
        '/spectate.html',
        '/manifest.webmanifest',
        '/css/style.css',
        '/js/main.js',
        '/js/spectator.js',
        '/js/renderer.js',
        '/js/controls-helm.js',
        '/js/controls-weapons.js',
        '/js/controls-engineer.js',
        '/js/textures.js',
        '/js/pwa.js',
        '/vendor/three.module.js',
        '/vendor/three.core.js',
        '/icons/icon.svg',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/icon-maskable-192.png',
        '/icons/icon-maskable-512.png',
        '/icons/apple-touch-icon-180.png',
      ];

      for (const asset of requiredAssets) {
        expect(store.has(asset), `Asset ${asset} was not precached`).toBe(true);
      }

      // Assert that /music/ tracks are NOT precached
      for (const key of store.keys()) {
        expect(key.startsWith('/music/')).toBe(false);
      }
    });

    it('activate event cleans obsolete broadside-hyperion caches and calls clients.claim', async () => {
      const scope = createSwSandbox();
      scope.cacheStorage.set('broadside-hyperion-v0', new Map());
      scope.cacheStorage.set('broadside-hyperion-v1', new Map());
      scope.cacheStorage.set('other-app-cache', new Map());

      const activateHandler = scope.listeners.get('activate')[0];
      let waitPromise = null;
      const event = {
        waitUntil: vi.fn((p) => {
          waitPromise = p;
        }),
      };

      activateHandler(event);
      await waitPromise;

      expect(scope.cacheStorage.has('broadside-hyperion-v0')).toBe(false);
      expect(scope.cacheStorage.has('broadside-hyperion-v1')).toBe(true);
      expect(scope.cacheStorage.has('other-app-cache')).toBe(true);
      expect(scope.getClaimCalls()).toBe(1);
    });

    it('message event with type SKIP_WAITING triggers self.skipWaiting', () => {
      const scope = createSwSandbox();
      const messageHandler = scope.listeners.get('message')[0];

      messageHandler({ data: { type: 'OTHER_ACTION' } });
      expect(scope.getSkipWaitingCalls()).toBe(0);

      messageHandler({ data: { type: 'SKIP_WAITING' } });
      expect(scope.getSkipWaitingCalls()).toBe(1);
    });

    describe('Fetch Event Handling and Bypass Logic', () => {
      async function dispatchFetch(scope, request) {
        let respondWithCalled = false;
        let responsePromise = null;

        const event = {
          request,
          respondWith: vi.fn((p) => {
            respondWithCalled = true;
            responsePromise = p;
          }),
        };

        const handlers = scope.listeners.get('fetch') || [];
        for (const handler of handlers) {
          handler(event);
        }

        const response = responsePromise ? await responsePromise : null;
        return { respondWithCalled, response };
      }

      it('bypasses non-GET requests immediately', async () => {
        const scope = createSwSandbox();
        const req = new Request('https://hyperion.lan/api/game', { method: 'POST' });
        const { respondWithCalled } = await dispatchFetch(scope, req);
        expect(respondWithCalled).toBe(false);
      });

      it('bypasses cross-origin requests immediately', async () => {
        const scope = createSwSandbox();
        const req = new Request('https://external-cdn.example/lib.js');
        const { respondWithCalled } = await dispatchFetch(scope, req);
        expect(respondWithCalled).toBe(false);
      });

      it('bypasses /api/ routes immediately', async () => {
        const scope = createSwSandbox();
        const req1 = new Request('https://hyperion.lan/api/health');
        const { respondWithCalled: called1 } = await dispatchFetch(scope, req1);
        expect(called1).toBe(false);

        const req2 = new Request('https://hyperion.lan/api/music');
        const { respondWithCalled: called2 } = await dispatchFetch(scope, req2);
        expect(called2).toBe(false);
      });

      it('bypasses WebSocket routes and Upgrade: websocket requests immediately', async () => {
        const scope = createSwSandbox();
        const reqWs = new Request('https://hyperion.lan/ws');
        const { respondWithCalled: calledWs } = await dispatchFetch(scope, reqWs);
        expect(calledWs).toBe(false);

        const reqUpgrade = new Request('https://hyperion.lan/socket', {
          headers: { upgrade: 'websocket' },
        });
        const { respondWithCalled: calledUpgrade } = await dispatchFetch(scope, reqUpgrade);
        expect(calledUpgrade).toBe(false);
      });

      it('bypasses /music/ routes and Range header requests immediately', async () => {
        const scope = createSwSandbox();
        const reqMusic = new Request('https://hyperion.lan/music/Deep%20Space%20Ostinato.mp3');
        const { respondWithCalled: calledMusic } = await dispatchFetch(scope, reqMusic);
        expect(calledMusic).toBe(false);

        const reqRange = new Request('https://hyperion.lan/video.webm', {
          headers: { range: 'bytes=0-1024' },
        });
        const { respondWithCalled: calledRange } = await dispatchFetch(scope, reqRange);
        expect(calledRange).toBe(false);
      });

      it('bypasses /sw.js to prevent self-caching stale service worker', async () => {
        const scope = createSwSandbox();
        const req = new Request('https://hyperion.lan/sw.js');
        const { respondWithCalled } = await dispatchFetch(scope, req);
        expect(respondWithCalled).toBe(false);
      });

      it('handles Network-First for /js/main.js, caching HTTP 200 response', async () => {
        const scope = createSwSandbox();
        scope.sandbox.fetch.mockResolvedValueOnce(
          new Response('console.log("live main")', { status: 200, statusText: 'OK' })
        );

        const req = new Request('https://hyperion.lan/js/main.js');
        const { respondWithCalled, response } = await dispatchFetch(scope, req);

        expect(respondWithCalled).toBe(true);
        expect(response).toBeDefined();
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe('console.log("live main")');

        const store = scope.cacheStorage.get('broadside-hyperion-v1');
        expect(store).toBeDefined();
        const cached = store.get(req.url) || store.get(req);
        expect(cached).toBeDefined();
      });

      it('falls back to cached asset when network fetch rejects', async () => {
        const scope = createSwSandbox();
        const cache = scope.createCacheMock('broadside-hyperion-v1');
        await cache.put('https://hyperion.lan/js/main.js', new Response('console.log("cached main")', { status: 200 }));

        scope.sandbox.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

        const req = new Request('https://hyperion.lan/js/main.js');
        const { respondWithCalled, response } = await dispatchFetch(scope, req);

        expect(respondWithCalled).toBe(true);
        expect(response).toBeDefined();
        const text = await response.text();
        expect(text).toBe('console.log("cached main")');
      });

      it('falls back to /spectate.html on offline navigation to /spectate', async () => {
        const scope = createSwSandbox();
        const cache = scope.createCacheMock('broadside-hyperion-v1');
        await cache.put('/spectate.html', new Response('<!DOCTYPE html><title>Spectate</title>', { status: 200 }));

        scope.sandbox.fetch.mockRejectedValueOnce(new TypeError('Offline'));

        const req = new Request('https://hyperion.lan/spectate?room=lobby', {
          headers: { accept: 'text/html,application/xhtml+xml' },
        });
        const { respondWithCalled, response } = await dispatchFetch(scope, req);

        expect(respondWithCalled).toBe(true);
        expect(response).toBeDefined();
        const text = await response.text();
        expect(text).toContain('<title>Spectate</title>');
      });

      it('falls back to /index.html on offline navigation to root /', async () => {
        const scope = createSwSandbox();
        const cache = scope.createCacheMock('broadside-hyperion-v1');
        await cache.put('/index.html', new Response('<!DOCTYPE html><title>Broadside</title>', { status: 200 }));

        scope.sandbox.fetch.mockRejectedValueOnce(new TypeError('Offline'));

        const req = new Request('https://hyperion.lan/', {
          headers: { accept: 'text/html' },
        });
        Object.defineProperty(req, 'mode', { value: 'navigate', configurable: true });

        const { respondWithCalled, response } = await dispatchFetch(scope, req);

        expect(respondWithCalled).toBe(true);
        expect(response).toBeDefined();
        const text = await response.text();
        expect(text).toContain('<title>Broadside</title>');
      });

      it('re-throws network error when fetch rejects and no cache matches', async () => {
        const scope = createSwSandbox();
        scope.sandbox.fetch.mockRejectedValueOnce(new TypeError('Network Error'));

        const req = new Request('https://hyperion.lan/nonexistent.json', {
          headers: { accept: 'application/json' },
        });

        await expect(dispatchFetch(scope, req)).rejects.toThrow('Network Error');
      });
    });
  });

  describe('Client PWA Controller (public/js/pwa.js)', () => {
    describe('isStandaloneMode()', () => {
      it('returns false when window is null or undefined', () => {
        expect(isStandaloneMode(null)).toBe(false);
        expect(isStandaloneMode(undefined)).toBe(false);
      });

      it('detects matchMedia standalone display mode', () => {
        const win = {
          matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }),
        };
        expect(isStandaloneMode(win)).toBe(true);
      });

      it('detects matchMedia fullscreen display mode', () => {
        const win = {
          matchMedia: (q) => ({ matches: q === '(display-mode: fullscreen)' }),
        };
        expect(isStandaloneMode(win)).toBe(true);
      });

      it('detects legacy iOS navigator.standalone === true', () => {
        const win = {
          navigator: { standalone: true },
          matchMedia: () => ({ matches: false }),
        };
        expect(isStandaloneMode(win)).toBe(true);
      });

      it('detects android-app:// referrer', () => {
        const win = {
          matchMedia: () => ({ matches: false }),
          document: { referrer: 'android-app://org.broadside.hyperion' },
        };
        expect(isStandaloneMode(win)).toBe(true);
      });

      it('returns false for standard browser tab', () => {
        const win = {
          matchMedia: () => ({ matches: false }),
          navigator: { standalone: false },
          document: { referrer: 'https://google.com' },
        };
        expect(isStandaloneMode(win)).toBe(false);
      });
    });

    describe('isIosSafari()', () => {
      it('returns false when navigator is null or undefined', () => {
        expect(isIosSafari(null)).toBe(false);
        expect(isIosSafari(undefined)).toBe(false);
      });

      it('detects iPhone Safari', () => {
        const nav = {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
          maxTouchPoints: 5,
        };
        const win = { matchMedia: () => ({ matches: false }) };
        expect(isIosSafari(nav, win)).toBe(true);
      });

      it('detects iPadOS desktop-mode user agent (Macintosh with touch points)', () => {
        const nav = {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          maxTouchPoints: 5,
        };
        const win = { matchMedia: () => ({ matches: false }) };
        expect(isIosSafari(nav, win)).toBe(true);
      });

      it('rejects macOS desktop Safari (Macintosh with zero touch points)', () => {
        const nav = {
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          maxTouchPoints: 0,
        };
        const win = { matchMedia: () => ({ matches: false }) };
        expect(isIosSafari(nav, win)).toBe(false);
      });

      it('rejects third-party iOS browsers (Chrome CriOS, Firefox FxiOS, Edge EdgiOS)', () => {
        const win = { matchMedia: () => ({ matches: false }) };

        const cFilter = {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/122.0.6261.62 Mobile/15E148 Safari/604.1',
        };
        expect(isIosSafari(cFilter, win)).toBe(false);

        const fxFilter = {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 FxiOS/123.0 Mobile/15E148 Safari/605.1.15',
        };
        expect(isIosSafari(fxFilter, win)).toBe(false);

        const edgFilter = {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/122.0.2365.67 Mobile/15E148 Safari/605.1.15',
        };
        expect(isIosSafari(edgFilter, win)).toBe(false);
      });

      it('rejects Android browsers', () => {
        const nav = {
          userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.64 Mobile Safari/537.36',
        };
        const win = { matchMedia: () => ({ matches: false }) };
        expect(isIosSafari(nav, win)).toBe(false);
      });

      it('rejects iOS Safari when already in standalone mode', () => {
        const nav = {
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
        };
        const win = {
          navigator: { standalone: true },
          matchMedia: () => ({ matches: true }),
        };
        expect(isIosSafari(nav, win)).toBe(false);
      });
    });

    describe('InstallPromptController Lifecycle', () => {
      function createMockDomElement(id) {
        const classList = new Set(['hidden']);
        const listeners = new Map();
        return {
          id,
          classList: {
            contains: (c) => classList.has(c),
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            toggle: (c, force) => {
              if (force === undefined) {
                if (classList.has(c)) classList.delete(c);
                else classList.add(c);
              } else if (force) {
                classList.add(c);
              } else {
                classList.delete(c);
              }
              return classList.has(c);
            },
          },
          addEventListener: vi.fn((type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
          }),
          removeEventListener: vi.fn((type, fn) => {
            const arr = listeners.get(type) || [];
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
          }),
          click: () => {
            for (const fn of listeners.get('click') || []) fn();
          },
        };
      }

      function createMockEnvironment(options = {}) {
        const winListeners = new Map();
        const storageData = new Map();

        const buttonEl = createMockDomElement('btn-install-app');
        const iosHintEl = createMockDomElement('ios-install-hint');
        const dismissBtnEl = createMockDomElement('btn-dismiss-ios-hint');

        const storage = {
          getItem: vi.fn((k) => (storageData.has(k) ? storageData.get(k) : null)),
          setItem: vi.fn((k, v) => storageData.set(k, String(v))),
          removeItem: vi.fn((k) => storageData.delete(k)),
        };

        const win = {
          isSecureContext: options.isSecureContext ?? true,
          location: { protocol: options.protocol ?? 'https:' },
          addEventListener: vi.fn((type, fn) => {
            if (!winListeners.has(type)) winListeners.set(type, []);
            winListeners.get(type).push(fn);
          }),
          removeEventListener: vi.fn((type, fn) => {
            const arr = winListeners.get(type) || [];
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
          }),
          matchMedia: vi.fn((q) => ({
            matches: options.standalone ?? false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          })),
          dispatchEvent: (type, event) => {
            for (const fn of winListeners.get(type) || []) fn(event);
          },
        };

        const installingWorker = {
          state: 'installing',
          addEventListener: vi.fn((type, fn) => {
            installingWorker._statechange = fn;
          }),
          removeEventListener: vi.fn(),
        };

        const swRegistration = {
          installing: installingWorker,
          addEventListener: vi.fn((type, fn) => {
            swRegistration._updatefound = fn;
          }),
          removeEventListener: vi.fn(),
        };

        const nav = {
          userAgent:
            options.userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          serviceWorker: {
            controller: { state: 'activated' },
            register: vi.fn(async () => swRegistration),
          },
        };

        const doc = {
          getElementById: (id) => {
            if (id === 'btn-install-app') return buttonEl;
            if (id === 'ios-install-hint') return iosHintEl;
            if (id === 'btn-dismiss-ios-hint') return dismissBtnEl;
            return null;
          },
        };

        return {
          win,
          doc,
          nav,
          storage,
          storageData,
          buttonEl,
          iosHintEl,
          dismissBtnEl,
          swRegistration,
          installingWorker,
        };
      }

      it('safely no-ops in headless environment when window is absent', () => {
        const controller = initPwa({ win: null });
        expect(controller.initialized).toBe(false);
      });

      it('reveals install button on beforeinstallprompt and prompts install on click', async () => {
        const env = createMockEnvironment();
        const controller = new InstallPromptController({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
          buttonEl: env.buttonEl,
          iosHintEl: env.iosHintEl,
          dismissBtnEl: env.dismissBtnEl,
        });

        controller.init();
        expect(env.buttonEl.classList.contains('hidden')).toBe(true);

        const promptMock = vi.fn(async () => {});
        const promptEvent = {
          preventDefault: vi.fn(),
          prompt: promptMock,
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        };

        env.win.dispatchEvent('beforeinstallprompt', promptEvent);
        expect(promptEvent.preventDefault).toHaveBeenCalled();
        expect(env.buttonEl.classList.contains('hidden')).toBe(false);

        const choice = await controller.promptInstall();
        expect(choice.outcome).toBe('accepted');
        expect(promptMock).toHaveBeenCalled();
        expect(controller.installed).toBe(true);
        expect(env.buttonEl.classList.contains('hidden')).toBe(true);

        controller.destroy();
      });

      it('hides install button on appinstalled event', () => {
        const env = createMockEnvironment();
        const controller = initPwa({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
          buttonEl: env.buttonEl,
        });

        const promptEvent = {
          preventDefault: vi.fn(),
          prompt: vi.fn(),
          userChoice: Promise.resolve({ outcome: 'dismissed' }),
        };
        env.win.dispatchEvent('beforeinstallprompt', promptEvent);
        expect(env.buttonEl.classList.contains('hidden')).toBe(false);

        env.win.dispatchEvent('appinstalled', {});
        expect(controller.installed).toBe(true);
        expect(env.buttonEl.classList.contains('hidden')).toBe(true);

        controller.destroy();
      });

      it('shows and persists iOS install hint dismissal', () => {
        const env = createMockEnvironment({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
        });

        const controller = initPwa({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
          iosHintEl: env.iosHintEl,
          dismissBtnEl: env.dismissBtnEl,
        });

        expect(env.iosHintEl.classList.contains('hidden')).toBe(false);

        controller.dismissIosHint();
        expect(env.storage.setItem).toHaveBeenCalledWith(IOS_HINT_DISMISSED_KEY, '1');
        expect(env.iosHintEl.classList.contains('hidden')).toBe(true);
        expect(controller.isIosHintDismissed()).toBe(true);

        controller.destroy();
      });

      it('registers service worker in secure HTTPS context', async () => {
        const env = createMockEnvironment({ isSecureContext: true, protocol: 'https:' });
        const controller = new InstallPromptController({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
        });
        controller.init();

        await controller.registerServiceWorker();
        expect(env.nav.serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
      });

      it('skips service worker registration in insecure context or unsupported protocol', async () => {
        const envInsecure = createMockEnvironment({ isSecureContext: false, protocol: 'http:' });
        const c1 = new InstallPromptController({
          win: envInsecure.win,
          doc: envInsecure.doc,
          nav: envInsecure.nav,
        });
        const reg1 = await c1.registerServiceWorker();
        expect(reg1).toBeNull();
        expect(envInsecure.nav.serviceWorker.register).not.toHaveBeenCalled();

        const envFile = createMockEnvironment({ isSecureContext: true, protocol: 'file:' });
        const c2 = new InstallPromptController({
          win: envFile.win,
          doc: envFile.doc,
          nav: envFile.nav,
        });
        const reg2 = await c2.registerServiceWorker();
        expect(reg2).toBeNull();
        expect(envFile.nav.serviceWorker.register).not.toHaveBeenCalled();
      });

      it('notifies onUpdateFound callback on new worker installation without window reload', async () => {
        const env = createMockEnvironment();
        const onUpdateFoundMock = vi.fn();

        const controller = new InstallPromptController({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
          onUpdateFound: onUpdateFoundMock,
        });
        controller.init();

        await controller.registerServiceWorker();
        expect(env.swRegistration.addEventListener).toHaveBeenCalledWith('updatefound', expect.any(Function));

        // Trigger updatefound listener
        env.swRegistration._updatefound();
        expect(env.installingWorker.addEventListener).toHaveBeenCalledWith('statechange', expect.any(Function));

        // Trigger statechange to 'installed'
        env.installingWorker.state = 'installed';
        env.installingWorker._statechange();

        expect(onUpdateFoundMock).toHaveBeenCalledWith(env.swRegistration, env.installingWorker);
        controller.destroy();
      });

      it('safely handles controller.destroy() while service worker registration is pending', async () => {
        const env = createMockEnvironment();
        let resolveRegister;
        env.nav.serviceWorker.register = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveRegister = resolve;
            })
        );

        const controller = new InstallPromptController({
          win: env.win,
          doc: env.doc,
          nav: env.nav,
          storage: env.storage,
        });

        controller.init();
        const regPromise = controller.registerServiceWorker();

        // Destroy controller while registration is pending
        controller.destroy();
        expect(controller.initialized).toBe(false);

        // Resolve registration
        resolveRegister(env.swRegistration);
        const resolvedReg = await regPromise;

        expect(resolvedReg).toBe(env.swRegistration);
        expect(controller.registration).toBeNull();
        expect(env.swRegistration.addEventListener).not.toHaveBeenCalled();
      });
    });
  });
});
