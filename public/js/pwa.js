/**
 * BROADSIDE HYPERION — Client PWA & Install Prompt Controller
 *
 * Headless-safe ES module managing beforeinstallprompt lifecycle,
 * iOS Add-to-Home-Screen instructions, and root-scoped service worker registration.
 * Strictly zero emojis.
 */

export const IOS_HINT_DISMISSED_KEY = 'broadside_ios_hint_dismissed';

/**
 * Checks whether the current window/document is running in standalone or fullscreen PWA mode.
 * @param {Window|null} [win]
 * @returns {boolean}
 */
export function isStandaloneMode(win = (typeof window !== 'undefined' ? window : null)) {
  if (!win) {
    return false;
  }

  if (Boolean(win.matchMedia?.('(display-mode: standalone)')?.matches)) {
    return true;
  }

  if (Boolean(win.matchMedia?.('(display-mode: fullscreen)')?.matches)) {
    return true;
  }

  if (win.navigator?.standalone === true) {
    return true;
  }

  if (Boolean(win.document?.referrer?.startsWith?.('android-app://'))) {
    return true;
  }

  return false;
}

/**
 * Checks whether the client environment is Mobile Safari on iOS/iPadOS outside standalone mode.
 * @param {Navigator|null} [nav]
 * @param {Window|null} [win]
 * @returns {boolean}
 */
export function isIosSafari(
  nav = (typeof navigator !== 'undefined' ? navigator : null),
  win = (typeof window !== 'undefined' ? window : null)
) {
  if (!nav) {
    return false;
  }

  const ua = nav.userAgent || '';
  const isIosDevice =
    /iPad|iPhone|iPod/i.test(ua) ||
    (/Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1);

  if (!isIosDevice) {
    return false;
  }

  if (!/Safari/i.test(ua)) {
    return false;
  }

  if (/CriOS|FxiOS|EdgiOS|OPiOS|Android/i.test(ua)) {
    return false;
  }

  if (isStandaloneMode(win)) {
    return false;
  }

  return true;
}

/**
 * Manages PWA installation prompt, iOS instructions banner, and Service Worker updates.
 */
export class InstallPromptController {
  constructor(options = {}) {
    this.win = options.win ?? (typeof window !== 'undefined' ? window : null);
    this.doc = options.doc ?? (typeof document !== 'undefined' ? document : null);
    this.nav = options.nav ?? (typeof navigator !== 'undefined' ? navigator : null);
    this.storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.buttonEl = options.buttonEl ?? null;
    this.iosHintEl = options.iosHintEl ?? null;
    this.dismissBtnEl = options.dismissBtnEl ?? null;
    this.onUpdateFound = typeof options.onUpdateFound === 'function' ? options.onUpdateFound : null;

    this.deferredPrompt = null;
    this.installed = false;
    this.iosDismissed = false;
    this.registration = null;
    this.initialized = false;

    this._onBeforeInstallPrompt = null;
    this._onAppInstalled = null;
    this._standaloneMql = null;
    this._onDisplayModeChange = null;
    this._onButtonClick = null;
    this._onDismissClick = null;
    this._onUpdateFoundListener = null;
    this._installingWorker = null;
    this._onStateChangeListener = null;
  }

  /**
   * Initializes listeners and service worker registration.
   * @returns {this}
   */
  init() {
    if (this.initialized || !this.win) {
      return this;
    }

    if (!this.buttonEl && this.doc?.getElementById) {
      this.buttonEl = this.doc.getElementById('btn-install-app');
    }
    if (!this.iosHintEl && this.doc?.getElementById) {
      this.iosHintEl = this.doc.getElementById('ios-install-hint');
    }
    if (!this.dismissBtnEl && this.doc?.getElementById) {
      this.dismissBtnEl = this.doc.getElementById('btn-dismiss-ios-hint');
    }

    this.iosDismissed = this.isIosHintDismissed();
    if (isStandaloneMode(this.win)) {
      this.installed = true;
    }

    this._onBeforeInstallPrompt = (e) => {
      if (typeof e?.preventDefault === 'function') {
        e.preventDefault();
      }
      this.deferredPrompt = e;
      this.syncVisibility();
    };
    this.win.addEventListener?.('beforeinstallprompt', this._onBeforeInstallPrompt);

    this._onAppInstalled = () => {
      this.deferredPrompt = null;
      this.installed = true;
      this.syncVisibility();
    };
    this.win.addEventListener?.('appinstalled', this._onAppInstalled);

    this._standaloneMql = this.win.matchMedia?.('(display-mode: standalone)') || null;
    if (this._standaloneMql) {
      this._onDisplayModeChange = (e) => {
        if (e?.matches) {
          this.installed = true;
        }
        this.syncVisibility();
      };
      if (typeof this._standaloneMql.addEventListener === 'function') {
        this._standaloneMql.addEventListener('change', this._onDisplayModeChange);
      } else if (typeof this._standaloneMql.addListener === 'function') {
        this._standaloneMql.addListener(this._onDisplayModeChange);
      }
    }

    if (this.buttonEl) {
      this._onButtonClick = () => {
        this.promptInstall();
      };
      this.buttonEl.addEventListener?.('click', this._onButtonClick);
    }

    if (this.dismissBtnEl) {
      this._onDismissClick = () => {
        this.dismissIosHint();
      };
      this.dismissBtnEl.addEventListener?.('click', this._onDismissClick);
    }

    this.initialized = true;
    this.syncVisibility();

    this.registerServiceWorker().catch(() => {});
    return this;
  }

  /**
   * Checks whether the user previously dismissed the iOS install hint.
   * @returns {boolean}
   */
  isIosHintDismissed() {
    if (this.iosDismissed) {
      return true;
    }
    try {
      return this.storage?.getItem?.(IOS_HINT_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Dismisses the iOS install hint and stores the flag in persistent storage.
   */
  dismissIosHint() {
    try {
      this.storage?.setItem?.(IOS_HINT_DISMISSED_KEY, '1');
    } catch {
      // Ignore storage quota or permission errors
    }
    this.iosDismissed = true;
    this.syncVisibility();
  }

  /**
   * Synchronizes visibility states for install button and iOS guidance container.
   */
  syncVisibility() {
    const standalone = isStandaloneMode(this.win);
    const canInstall = !standalone && !this.installed && Boolean(this.deferredPrompt);
    const showIosHint =
      !standalone &&
      !this.installed &&
      !canInstall &&
      isIosSafari(this.nav, this.win) &&
      !this.isIosHintDismissed();

    if (this.buttonEl?.classList?.toggle) {
      this.buttonEl.classList.toggle('hidden', !canInstall);
    }
    if (this.iosHintEl?.classList?.toggle) {
      this.iosHintEl.classList.toggle('hidden', !showIosHint);
    }
  }

  /**
   * Triggers the native browser install prompt dialog.
   * @returns {Promise<{ outcome: string }|null>}
   */
  async promptInstall() {
    if (!this.deferredPrompt) {
      return null;
    }

    const evt = this.deferredPrompt;
    this.deferredPrompt = null;
    this.syncVisibility();

    if (typeof evt.prompt === 'function') {
      try {
        await evt.prompt();
      } catch {
        // Ignore prompt call errors
      }
    }

    let choice = { outcome: 'dismissed' };
    if (evt.userChoice) {
      try {
        choice = await evt.userChoice;
      } catch {
        choice = { outcome: 'dismissed' };
      }
    }

    if (choice?.outcome === 'accepted') {
      this.installed = true;
      this.syncVisibility();
    }

    return choice;
  }

  /**
   * Registers the root-scoped service worker at /sw.js.
   * @returns {Promise<ServiceWorkerRegistration|null>}
   */
  async registerServiceWorker() {
    if (!this.nav?.serviceWorker?.register) {
      return null;
    }
    if (this.win?.isSecureContext === false) {
      return null;
    }
    const protocol = this.win?.location?.protocol || '';
    if (!/^https?:$/i.test(protocol)) {
      return null;
    }

    try {
      const reg = await this.nav.serviceWorker.register('/sw.js', { scope: '/' });
      if (!this.initialized) {
        return reg;
      }
      this.registration = reg;

      if (reg) {
        this._onUpdateFoundListener = () => {
          const worker = reg.installing;
          if (!worker) {
            return;
          }
          this._installingWorker = worker;
          this._onStateChangeListener = () => {
            if (worker.state === 'installed' && this.nav?.serviceWorker?.controller) {
              try {
                this.onUpdateFound?.(reg, worker);
              } catch {
                // Ignore callback errors; never reload window automatically
              }
            }
          };
          worker.addEventListener?.('statechange', this._onStateChangeListener);
        };
        reg.addEventListener?.('updatefound', this._onUpdateFoundListener);
      }

      return reg;
    } catch {
      return null;
    }
  }

  /**
   * Unbinds all registered listeners and resets runtime state.
   */
  destroy() {
    if (this._onBeforeInstallPrompt && this.win?.removeEventListener) {
      this.win.removeEventListener('beforeinstallprompt', this._onBeforeInstallPrompt);
    }
    if (this._onAppInstalled && this.win?.removeEventListener) {
      this.win.removeEventListener('appinstalled', this._onAppInstalled);
    }
    if (this._standaloneMql && this._onDisplayModeChange) {
      if (typeof this._standaloneMql.removeEventListener === 'function') {
        this._standaloneMql.removeEventListener('change', this._onDisplayModeChange);
      } else if (typeof this._standaloneMql.removeListener === 'function') {
        this._standaloneMql.removeListener(this._onDisplayModeChange);
      }
    }
    if (this.buttonEl && this._onButtonClick && this.buttonEl.removeEventListener) {
      this.buttonEl.removeEventListener('click', this._onButtonClick);
    }
    if (this.dismissBtnEl && this._onDismissClick && this.dismissBtnEl.removeEventListener) {
      this.dismissBtnEl.removeEventListener('click', this._onDismissClick);
    }
    if (this.registration && this._onUpdateFoundListener && this.registration.removeEventListener) {
      this.registration.removeEventListener('updatefound', this._onUpdateFoundListener);
    }
    if (this._installingWorker && this._onStateChangeListener && this._installingWorker.removeEventListener) {
      this._installingWorker.removeEventListener('statechange', this._onStateChangeListener);
    }

    this._onBeforeInstallPrompt = null;
    this._onAppInstalled = null;
    this._standaloneMql = null;
    this._onDisplayModeChange = null;
    this._onButtonClick = null;
    this._onDismissClick = null;
    this._onUpdateFoundListener = null;
    this._installingWorker = null;
    this._onStateChangeListener = null;
    this.deferredPrompt = null;
    this.initialized = false;
  }
}

/**
 * Convenience helper to instantiate and initialize an InstallPromptController.
 * @param {object} [options]
 * @returns {InstallPromptController}
 */
export function initPwa(options = {}) {
  const controller = new InstallPromptController(options);
  controller.init();
  return controller;
}
