/**
 * BROADSIDE HYPERION — Cinematic Spectator Screen Controller
 *
 * Implements:
 * - Smart Broadcast Camera with dynamic auto-framing bounding box and smooth lerp zoom
 * - Killing blow slow-motion 5x zoom and broadcast replay banner
 * - Screen-dominant Victor announcement overlay on battle conclusion
 * - LAN Host Quick Action: Instant Demo / AI Match launch trigger
 */

import { SpaceRenderer } from './renderer.js';
import { initPwa } from './pwa.js';

export const SPECTATOR_MUSIC_TRACKS = [
  '/music/Deep%20Space%20Fanfare%202.mp3',
  '/music/Deep%20Space%20Fanfare.mp3',
  '/music/Deep%20Space%20Ostinato.mp3',
  '/music/Deep%20Space%20Pulse.mp3',
];
export const DEFAULT_MUSIC_VOLUME = 0.5;
export const MUSIC_VOLUME_STEP = 0.05;

class SpectatorApp {
  static _activeMusicOwner = null;

  static resetMusicOwnerLock() {
    if (SpectatorApp._activeMusicOwner?.audio?.pause) {
      try {
        SpectatorApp._activeMusicOwner.audio.pause();
      } catch (e) {}
    }
    SpectatorApp._activeMusicOwner = null;
  }

  constructor(options = {}) {
    this.options = options;
    this.pwa = null;
    this.canvas = typeof document !== 'undefined' ? document.getElementById('space-canvas') : null;
    this.renderer = options.renderer || (this.canvas ? new SpaceRenderer(this.canvas) : null);

    // Camera Framing State
    this.cameraPos = { x: 0, y: 0, z: 0 };
    this.targetCameraPos = { x: 0, y: 0, z: 0 };
    this.zoom = 0.22;
    this.targetZoom = 0.22;
    this._cameraInitialized = false;

    // Snapshot Store & Player Identity
    this.playerId = null;
    this.lastSnapshot = null;
    this.ws = null;
    this.reconnectTimer = null;

    // Replay Tracking State
    this._wasReplayActive = false;
    this._lastReplayFrameIndex = -1;
    this._lastRenderReplayFrameIndex = -1;
    this._lastFrameTime = 0;

    // Music System Initialization
    this.initMusic(options);

    // Bind UI & Network
    this.initElements();
    this.bindEvents();
    if (options.connectWebSocket !== false && typeof window !== 'undefined' && window.location) {
      this.connectWebSocket();
    }

    // Start 60FPS RAF Render Loop
    if (this.renderer?.resize) {
      this.renderer.resize();
    }
    if (typeof requestAnimationFrame === 'function') {
      this._rafId = requestAnimationFrame(this.renderLoop.bind(this));
    }
  }

  createAudioElement() {
    if (typeof Audio !== 'undefined') {
      try {
        return new Audio();
      } catch (e) {
        // Fall back to headless mock
      }
    }
    const self = this;
    const mockAudio = {
      src: '',
      volume: typeof self.musicVolume === 'number' ? self.musicVolume : DEFAULT_MUSIC_VOLUME,
      loop: false,
      preload: 'auto',
      paused: true,
      currentTime: 0,
      _listeners: {},
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (!this._listeners[type]) return;
        this._listeners[type] = this._listeners[type].filter(f => f !== fn);
      },
      dispatchEvent(evt) {
        const type = typeof evt === 'string' ? evt : evt?.type;
        const list = this._listeners[type] || [];
        for (const fn of list) {
          try {
            fn.call(this, typeof evt === 'string' ? { type: evt, target: this } : evt);
          } catch (e) {}
        }
      },
      play() {
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
    };
    return mockAudio;
  }

  initMusic(options = {}) {
    this.musicTracks = Array.isArray(options.musicTracks) && options.musicTracks.length > 0
      ? [...options.musicTracks]
      : [...SPECTATOR_MUSIC_TRACKS];
    this.currentTrackIndex = 0;
    this.musicVolume = typeof options.volume === 'number'
      ? Math.max(0, Math.min(1, Math.round(options.volume * 100) / 100))
      : DEFAULT_MUSIC_VOLUME;
    this.isMusicOwner = false;
    this._musicAutoplayBlocked = false;
    this._trackErrorCount = 0;

    this.audio = options.audio || this.createAudioElement();
    if (this.audio) {
      this.audio.preload = 'auto';
      this.audio.loop = false;
      this.audio.volume = this.musicVolume;
      if (this.musicTracks.length > 0) {
        this.audio.src = this.musicTracks[this.currentTrackIndex];
      }

      this._onAudioEnded = () => {
        this._trackErrorCount = 0;
        this.nextTrack();
      };
      this._onAudioError = () => {
        this._trackErrorCount++;
        if (this._trackErrorCount <= this.musicTracks.length) {
          this.nextTrack();
        }
      };

      if (typeof this.audio.addEventListener === 'function') {
        this.audio.addEventListener('ended', this._onAudioEnded);
        this.audio.addEventListener('error', this._onAudioError);
      }
    }

    // Dynamic fetch of playlist from /api/music when running in browser and options.musicTracks was not explicitly provided
    if (
      !options.musicTracks &&
      typeof fetch === 'function' &&
      typeof window !== 'undefined' &&
      window.location &&
      /^https?:/i.test(window.location.protocol)
    ) {
      fetch('/api/music')
        .then((res) => res.json())
        .then((data) => {
          if (data && Array.isArray(data.tracks) && data.tracks.length > 0) {
            this.musicTracks = [...data.tracks];
            if (this.audio && !this.audio.src && this.musicTracks.length > 0) {
              this.audio.src = this.musicTracks[this.currentTrackIndex % this.musicTracks.length];
            }
          }
        })
        .catch(() => {
          // Keep existing synchronous defaults
        });
    }

    if (!SpectatorApp._activeMusicOwner || SpectatorApp._activeMusicOwner === this) {
      this.setMusicOwnership(true);
    } else {
      this.setMusicOwnership(false);
    }
  }

  tryPlayMusic() {
    if (!this.isMusicOwner || !this.audio || !this.musicTracks || this.musicTracks.length === 0) {
      return false;
    }
    try {
      this.audio.volume = this.musicVolume;
      if (!this.audio.src && this.musicTracks[this.currentTrackIndex]) {
        this.audio.src = this.musicTracks[this.currentTrackIndex];
      }
      const res = this.audio.play();
      if (res && typeof res.then === 'function') {
        res.then(() => {
          this._musicAutoplayBlocked = false;
        }).catch(() => {
          this._musicAutoplayBlocked = true;
        });
      } else {
        this._musicAutoplayBlocked = false;
      }
      return true;
    } catch (e) {
      this._musicAutoplayBlocked = true;
      return false;
    }
  }

  stopMusic() {
    if (this.audio && typeof this.audio.pause === 'function') {
      try {
        this.audio.pause();
      } catch (e) {}
    }
  }

  nextTrack() {
    if (!this.musicTracks || this.musicTracks.length === 0) return;
    this.currentTrackIndex = (this.currentTrackIndex + 1) % this.musicTracks.length;
    if (this.audio) {
      this.audio.src = this.musicTracks[this.currentTrackIndex];
    }
    if (this.isMusicOwner) {
      this.tryPlayMusic();
    }
  }

  setMusicOwnership(isOwner) {
    const nextOwner = Boolean(isOwner);
    if (nextOwner) {
      if (
        SpectatorApp._activeMusicOwner &&
        SpectatorApp._activeMusicOwner !== this &&
        SpectatorApp._activeMusicOwner.isMusicOwner &&
        !this.playerId
      ) {
        this.isMusicOwner = false;
        this.stopMusic();
        return false;
      }
      if (SpectatorApp._activeMusicOwner && SpectatorApp._activeMusicOwner !== this) {
        SpectatorApp._activeMusicOwner.isMusicOwner = false;
        SpectatorApp._activeMusicOwner.stopMusic();
      }
      SpectatorApp._activeMusicOwner = this;
      this.isMusicOwner = true;
      if (this.audio && this.audio.paused !== false) {
        this.tryPlayMusic();
      }
      return true;
    } else {
      this.isMusicOwner = false;
      if (SpectatorApp._activeMusicOwner === this) {
        SpectatorApp._activeMusicOwner = null;
      }
      this.stopMusic();
      return false;
    }
  }

  setMusicVolume(volume) {
    const val = Number.isFinite(Number(volume)) ? Number(volume) : DEFAULT_MUSIC_VOLUME;
    this.musicVolume = Math.max(0, Math.min(1, Math.round(val * 100) / 100));
    if (this.audio) {
      this.audio.volume = this.musicVolume;
    }
    return this.musicVolume;
  }

  adjustMusicVolume(delta) {
    return this.setMusicVolume((this.musicVolume ?? DEFAULT_MUSIC_VOLUME) + Number(delta || 0));
  }

  handleKeyDown(event) {
    if (!event) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault?.();
      this.adjustMusicVolume(MUSIC_VOLUME_STEP);
      if (this.isMusicOwner && this.audio?.paused) {
        this.tryPlayMusic();
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault?.();
      this.adjustMusicVolume(-MUSIC_VOLUME_STEP);
      if (this.isMusicOwner && this.audio?.paused) {
        this.tryPlayMusic();
      }
    } else if (this.isMusicOwner && (this._musicAutoplayBlocked || this.audio?.paused)) {
      this.tryPlayMusic();
    }
  }

  initElements() {
    this.elMatchStatus = typeof document !== 'undefined' ? document.getElementById('spectate-match-status') : null;
    this.btnStartDemo = typeof document !== 'undefined' ? document.getElementById('btn-spectate-start') : null;
    this.elKillCam = typeof document !== 'undefined' ? document.getElementById('spectate-kill-cam') : null;
    this.elReplayBanner = typeof document !== 'undefined' ? document.getElementById('spectate-replay-banner') : null;

    // Victor Overlay Elements
    this.elVictorOverlay = typeof document !== 'undefined' ? document.getElementById('spectate-victor-overlay') : null;
    this.elVictorBanner = typeof document !== 'undefined' ? document.getElementById('spectate-victor-banner') : null;
    this.elVictorTitle = typeof document !== 'undefined' ? document.getElementById('spectate-victor-title') : null;
    this.elVictorSubtitle = typeof document !== 'undefined' ? document.getElementById('spectate-victor-subtitle') : null;
  }

  bindEvents() {
    this._onResize = () => {
      this.renderer?.resize?.();
    };
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', this._onResize);
    }

    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      const targetEl = this.canvas.parentElement || this.canvas;
      if (targetEl) {
        const ro = new ResizeObserver(() => {
          this.renderer?.resize?.();
        });
        ro.observe(targetEl);
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this.renderer?.resize?.());
    }

    if (this.btnStartDemo) {
      this.btnStartDemo.addEventListener('click', () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.lastSnapshot && this.lastSnapshot.state === 'playing') {
          this.ws.send(JSON.stringify({ type: 'restart_match' }));
        } else {
          this.ws.send(JSON.stringify({ type: 'start_match' }));
        }
      });
    }

    this._onKeyDown = (e) => this.handleKeyDown(e);
    this._onUserGesture = () => {
      if (this.isMusicOwner && (this._musicAutoplayBlocked || this.audio?.paused)) {
        this.tryPlayMusic();
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('pointerdown', this._onUserGesture);
      window.addEventListener('click', this._onUserGesture);
    }

    if (this.options?.initPwa !== false && !this.pwa) {
      this.pwa = initPwa();
    }
  }

  destroy() {
    this.setMusicOwnership(false);
    if (this.pwa) {
      this.pwa.destroy();
      this.pwa = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
      if (this._onUserGesture) {
        window.removeEventListener('pointerdown', this._onUserGesture);
        window.removeEventListener('click', this._onUserGesture);
      }
      if (this._onResize) window.removeEventListener('resize', this._onResize);
    }
    if (this.audio && typeof this.audio.removeEventListener === 'function') {
      if (this._onAudioEnded) this.audio.removeEventListener('ended', this._onAudioEnded);
      if (this._onAudioError) this.audio.removeEventListener('error', this._onAudioError);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/?role=spectator`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      if (this.elMatchStatus) {
        const label = this.elMatchStatus.querySelector('.status-label');
        if (label) label.textContent = 'STANDBY / CONNECTED';
      }
      try {
        this.ws.send(JSON.stringify({ type: 'register_spectator' }));
      } catch (e) {}
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') {
          this.playerId = msg.playerId || null;
          if (msg.musicOwnerId !== undefined && this.playerId) {
            this.setMusicOwnership(msg.musicOwnerId === this.playerId);
          }
          if (msg.snapshot) {
            this.handleSnapshot(msg.snapshot);
          }
        } else if (msg.type === 'music_status') {
          const isOwner = Boolean(msg.isMusicOwner ?? (this.playerId && msg.musicOwnerId === this.playerId));
          this.setMusicOwnership(isOwner);
        } else if (msg.type === 'snapshot') {
          this.handleSnapshot(msg.snapshot || msg.data);
        }
      } catch (err) {
        // Ignore unparseable socket messages
      }
    };

    this.ws.onclose = () => {
      if (this.elMatchStatus) {
        const label = this.elMatchStatus.querySelector('.status-label');
        if (label) label.textContent = 'DISCONNECTED (RETRYING)';
      }
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2000);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  /**
   * Retrieves active snapshot for rendering, non-destructively merging replayFrame
   * when an instant replay is active.
   *
   * @returns {object|null}
   */
  getActiveRenderSnapshot() {
    if (!this.lastSnapshot) return null;
    if (!this.lastSnapshot.replayActive || !this.lastSnapshot.replayFrame) {
      return this.lastSnapshot;
    }

    const base = this.lastSnapshot;
    const rf = base.replayFrame;

    let sector = base.sector;
    if (base.sector && Array.isArray(base.sector.asteroids) && rf.destroyedAsteroidIds) {
      const destroyedSet = new Set(rf.destroyedAsteroidIds);
      sector = {
        ...base.sector,
        asteroids: base.sector.asteroids.map((ast) => ({
          ...ast,
          destroyed: Boolean(ast.destroyed || destroyedSet.has(ast.id)),
        })),
      };
    }

    return {
      ...base,
      ships: rf.ships !== undefined ? rf.ships : base.ships,
      projectiles: rf.projectiles !== undefined ? rf.projectiles : base.projectiles,
      tick: rf.tick !== undefined ? rf.tick : base.tick,
      slowMoActive: rf.slowMoActive !== undefined ? rf.slowMoActive : base.slowMoActive,
      events: rf.events !== undefined ? rf.events : (base.events || []),
      sector,
    };
  }

  handleSnapshot(snapshot) {
    if (!snapshot) return;
    this.lastSnapshot = snapshot;

    if (snapshot.musicOwnerId !== undefined && this.playerId) {
      this.setMusicOwnership(snapshot.musicOwnerId === this.playerId);
    }

    const isReplay = Boolean(snapshot.replayActive);
    if (isReplay && !this._wasReplayActive) {
      this.renderer?.clearEffects3D?.();
      this._lastReplayFrameIndex = -1;
      this._lastRenderReplayFrameIndex = -1;
    } else if (!isReplay && this._wasReplayActive) {
      this.renderer?.resetBsgReplayCamera?.();
      this._lastReplayFrameIndex = -1;
      this._lastRenderReplayFrameIndex = -1;
    }
    if (isReplay && snapshot.replayFrame && snapshot.replayFrame.frameIndex !== undefined) {
      this._lastReplayFrameIndex = snapshot.replayFrame.frameIndex;
    }
    this._wasReplayActive = isReplay;

    // Update Top Match Status & Controls
    this.updateMatchStatus(snapshot);

    // Update Victor Overlay
    this.updateVictorOverlay(snapshot);

    // Update Kill-Cam Banner
    this.updateBanners(snapshot);
  }

  updateMatchStatus(snapshot) {
    if (!this.elMatchStatus) return;
    const label = this.elMatchStatus.querySelector('.status-label');

    if (snapshot.replayActive) {
      if (label) label.textContent = 'INSTANT REPLAY — FINAL IMPACT';
      if (this.btnStartDemo) {
        this.btnStartDemo.classList.add('hidden');
      }
      return;
    }

    if (snapshot.state === 'playing') {
      if (label) label.textContent = 'ENGAGED / COMBAT ACTIVE';
      if (this.btnStartDemo) {
        this.btnStartDemo.textContent = 'RESTART COMBAT MATCH';
        if (snapshot.winner) {
          this.btnStartDemo.classList.remove('hidden');
        } else {
          this.btnStartDemo.classList.add('hidden');
        }
      }
    } else if (snapshot.state === 'gameover' || snapshot.state === 'game_over') {
      const winnerName = snapshot.winner === 'alpha' ? 'UNS HYPERION' : (snapshot.winner === 'omega' ? 'KRS VANGUARD' : 'DRAW');
      if (label) {
        label.textContent = winnerName === 'DRAW' ? 'MATCH CONCLUDED — DRAW' : `VICTORY — ${winnerName}`;
      }
      if (this.btnStartDemo) {
        this.btnStartDemo.textContent = 'START NEW MATCH';
        this.btnStartDemo.classList.remove('hidden');
      }
    } else {
      if (label) label.textContent = 'LOBBY / DRY-DOCK OUTFITTING';
      if (this.btnStartDemo) {
        this.btnStartDemo.textContent = 'START / DEMO AI MATCH';
        this.btnStartDemo.classList.remove('hidden');
      }
    }
  }

  updateVictorOverlay(snapshot) {
    if (!this.elVictorOverlay) return;

    const hasWinner = Boolean(snapshot.winner);
    const isGameOver = snapshot.state === 'gameover' || snapshot.state === 'game_over';
    const showOverlay = !snapshot.replayActive && hasWinner && isGameOver;

    if (showOverlay) {
      this.elVictorOverlay.classList.remove('hidden');
      const winnerName = snapshot.winner === 'alpha' ? 'UNS HYPERION' : (snapshot.winner === 'omega' ? 'KRS VANGUARD' : 'COMBAT DRAW');
      if (this.elVictorTitle) {
        this.elVictorTitle.textContent = 'VICTOR: ' + winnerName;
      }
      if (this.elVictorSubtitle) {
        this.elVictorSubtitle.textContent = snapshot.winner === 'alpha'
          ? 'TEAM ALPHA VICTORY'
          : (snapshot.winner === 'omega' ? 'TEAM OMEGA VICTORY' : 'MATCH CONCLUDED IN A DRAW');
      }
      if (this.elVictorBanner) {
        this.elVictorBanner.classList.toggle('victor-alpha', snapshot.winner === 'alpha');
        this.elVictorBanner.classList.toggle('victor-omega', snapshot.winner === 'omega');
      }
    } else {
      this.elVictorOverlay.classList.add('hidden');
    }
  }

  updateBanners(snapshot) {
    if (this.elKillCam) {
      this.elKillCam.classList.toggle('hidden', !snapshot.slowMoActive);
    }
    if (this.elReplayBanner) {
      this.elReplayBanner.classList.toggle('hidden', !snapshot.replayActive);
    }
  }

  // ==========================================================================
  // SMART BROADCAST CAMERA (AUTO-FRAMING BOUNDING BOX & KILL-CAM ZOOM)
  // ==========================================================================

  updateCamera(snapshot) {
    if (this.canvas && this.renderer && this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0 &&
        (this.canvas.clientWidth !== this.renderer.width || this.canvas.clientHeight !== this.renderer.height)) {
      this.renderer.resize();
    }

    const snap = snapshot || this.getActiveRenderSnapshot();
    if (!snap || !snap.ships) return;

    const alpha = snap.ships.alpha;
    const omega = snap.ships.omega;

    if (!alpha && !omega) return;

    // Calculate Bounding Box of Ships first so targetCameraPos is strictly anchored on ship midpoint
    let shipMinX = Infinity, shipMaxX = -Infinity;
    let shipMinY = Infinity, shipMaxY = -Infinity;
    let shipMinZ = Infinity, shipMaxZ = -Infinity;

    const includeShipPoint = (pos) => {
      if (!pos) return;
      const x = pos.x;
      const y = pos.y;
      const z = pos.z;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < shipMinX) shipMinX = x;
      if (x > shipMaxX) shipMaxX = x;
      if (y < shipMinY) shipMinY = y;
      if (y > shipMaxY) shipMaxY = y;
      const safeZ = Number.isFinite(z) ? z : 0;
      if (safeZ < shipMinZ) shipMinZ = safeZ;
      if (safeZ > shipMaxZ) shipMaxZ = safeZ;
    };

    if (alpha && alpha.pos) includeShipPoint(alpha.pos);
    if (omega && omega.pos) includeShipPoint(omega.pos);

    if (Number.isFinite(shipMinX) && Number.isFinite(shipMaxX)) {
      this.targetCameraPos.x = (shipMinX + shipMaxX) / 2;
      this.targetCameraPos.y = (shipMinY + shipMaxY) / 2;
      this.targetCameraPos.z = Number.isFinite(shipMinZ) && Number.isFinite(shipMaxZ) ? (shipMinZ + shipMaxZ) / 2 : 0;
    }
    if (!Number.isFinite(this.targetCameraPos.x)) this.targetCameraPos.x = 0;
    if (!Number.isFinite(this.targetCameraPos.y)) this.targetCameraPos.y = 0;
    if (!Number.isFinite(this.targetCameraPos.z)) this.targetCameraPos.z = 0;

    const shipSpanX = Number.isFinite(shipMinX) && Number.isFinite(shipMaxX) ? (shipMaxX - shipMinX) : 0;
    const shipSpanY = Number.isFinite(shipMinY) && Number.isFinite(shipMaxY) ? (shipMaxY - shipMinY) : 0;
    const shipSpanZ = Number.isFinite(shipMinZ) && Number.isFinite(shipMaxZ) ? (shipMaxZ - shipMinZ) : 0;
    const shipHalfSpan = Math.max(shipSpanX, shipSpanY, shipSpanZ) / 2;

    // Collect framing points: both ships, plus nearby active tactical torpedoes
    const framingPoints = [];
    if (alpha && alpha.pos && Number.isFinite(alpha.pos.x) && Number.isFinite(alpha.pos.y)) framingPoints.push(alpha.pos);
    if (omega && omega.pos && Number.isFinite(omega.pos.x) && Number.isFinite(omega.pos.y)) framingPoints.push(omega.pos);

    const maxTorpDist = Math.max(1800, shipHalfSpan + 800);
    const maxTorpDistSq = maxTorpDist * maxTorpDist;

    if (snap.projectiles) {
      for (const p of snap.projectiles) {
        if (p.type === 'torpedo' && p.pos && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)) {
          const tdx = (p.pos.x || 0) - this.targetCameraPos.x;
          const tdy = (p.pos.y || 0) - this.targetCameraPos.y;
          const tdz = (p.pos.z || 0) - this.targetCameraPos.z;
          if ((tdx * tdx + tdy * tdy + tdz * tdz) <= maxTorpDistSq) {
            framingPoints.push(p.pos);
          }
        }
      }
    }

    // 3D Frustum Framing calculation for 30°-pitched 45° FOV PerspectiveCamera
    const viewW = Math.max(320, this.renderer?.width || 1280);
    const viewH = Math.max(240, this.renderer?.height || 720);
    const aspect = viewW / viewH;
    const effectiveHeight = aspect < 1 ? (viewH / Math.max(0.55, aspect)) : viewH;
    const fovRad = (45 * Math.PI) / 180;
    const tanHalfFov = Math.tan(fovRad / 2);
    const pitchAngle = (30 * Math.PI) / 180;
    const sinPitch = Math.sin(pitchAngle);
    const cosPitch = Math.cos(pitchAngle);

    const SAFE_NDC = 0.72;
    const SHIP_PAD = 320;
    const minSpanDist = Math.max(750, 900 / Math.max(0.55, aspect)) / (2 * tanHalfFov);
    let requiredDist = minSpanDist;

    const refCenters = [this.targetCameraPos];
    if (this._cameraInitialized && this.cameraPos) {
      refCenters.push(this.cameraPos);
    }

    for (const pt of framingPoints) {
      if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      for (const ref of refCenters) {
        if (!ref || !Number.isFinite(ref.x) || !Number.isFinite(ref.y)) continue;
        const dx = Math.abs(pt.x - (ref.x || 0)) + SHIP_PAD;
        const dy = pt.y - (ref.y || 0);
        const dz = (pt.z || 0) - (ref.z || 0);

        // 3D pitched camera vertical offset and perspective depth shift toward camera lens
        const yCam3D = Math.abs(-dy * cosPitch + dz * sinPitch) + SHIP_PAD;
        const yCam2D = Math.abs(dy) + SHIP_PAD;
        const depthShift = Math.abs(dy) * sinPitch + Math.abs(dz) * cosPitch + SHIP_PAD;

        const distX = depthShift + dx / (SAFE_NDC * tanHalfFov * aspect);
        const distY3D = depthShift + yCam3D / (SAFE_NDC * tanHalfFov);
        const distY2D = yCam2D / (SAFE_NDC * tanHalfFov);

        requiredDist = Math.max(requiredDist, distX, distY3D, distY2D);
      }
    }

    let desiredZoom = effectiveHeight / (requiredDist * 2 * tanHalfFov);
    if (!Number.isFinite(desiredZoom) || desiredZoom <= 0) {
      desiredZoom = 0.22;
    }

    const arenaRadius = snap?.sector?.arenaRadius || 5250;
    const minScaleDim = Math.min(viewW, effectiveHeight);
    const minZoom = Math.max(0.02, Math.min(desiredZoom, minScaleDim / (arenaRadius * 4.0)));
    desiredZoom = Math.max(minZoom, Math.min(0.85, desiredZoom));

    // Dramatic Close-Up Zoom during Slow-Mo Killing Blow
    if (snap.slowMoActive) {
      desiredZoom = Math.min(1.2, desiredZoom * 1.8);
      // Focus on the destroyed ship
      const victim = (alpha && (alpha.hullHp <= 0 || alpha.destroyed)) ? alpha : omega;
      if (victim && victim.pos) {
        this.targetCameraPos.x = victim.pos.x;
        this.targetCameraPos.y = victim.pos.y;
        this.targetCameraPos.z = victim.pos.z || 0;
      }
    }

    this.targetZoom = Number.isFinite(desiredZoom) ? desiredZoom : 0.22;

    // Initialization vs Smooth Lerp
    if (!this._cameraInitialized) {
      this.cameraPos = {
        x: Number.isFinite(this.targetCameraPos.x) ? this.targetCameraPos.x : 0,
        y: Number.isFinite(this.targetCameraPos.y) ? this.targetCameraPos.y : 0,
        z: Number.isFinite(this.targetCameraPos.z) ? this.targetCameraPos.z : 0,
      };
      this.zoom = this.targetZoom;
      this._cameraInitialized = true;
    } else {
      const lerpRate = snap.slowMoActive ? 0.04 : 0.08;
      this.cameraPos.x += (this.targetCameraPos.x - this.cameraPos.x) * lerpRate;
      this.cameraPos.y += (this.targetCameraPos.y - this.cameraPos.y) * lerpRate;
      this.cameraPos.z = (this.cameraPos.z || 0) + ((this.targetCameraPos.z || 0) - (this.cameraPos.z || 0)) * lerpRate;
      const zoomLerpRate = (!snap.slowMoActive && this.targetZoom < this.zoom) ? 0.20 : lerpRate;
      this.zoom += (this.targetZoom - this.zoom) * zoomLerpRate;
      if (!Number.isFinite(this.cameraPos.x)) this.cameraPos.x = 0;
      if (!Number.isFinite(this.cameraPos.y)) this.cameraPos.y = 0;
      if (!Number.isFinite(this.cameraPos.z)) this.cameraPos.z = 0;
      if (!Number.isFinite(this.zoom)) this.zoom = 0.22;
    }
  }

  // ==========================================================================
  // 60FPS ANIMATION LOOP
  // ==========================================================================

  renderLoop() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this._lastFrameTime ? Math.max(0.001, Math.min(0.1, (now - this._lastFrameTime) / 1000)) : (1 / 60);
    this._lastFrameTime = now;

    const activeSnapshot = this.getActiveRenderSnapshot();
    this.updateCamera(activeSnapshot);

    // Render Main World Viewport via SpaceRenderer
    if (activeSnapshot) {
      let renderSnapshot = activeSnapshot;
      if (this.lastSnapshot?.replayActive && this.lastSnapshot?.replayFrame) {
        const rf = this.lastSnapshot.replayFrame;
        const frameIndex = rf.frameIndex !== undefined ? rf.frameIndex : (rf.tick !== undefined ? rf.tick : 0);
        if (frameIndex === this._lastRenderReplayFrameIndex) {
          renderSnapshot = { ...activeSnapshot, events: [] };
        } else {
          this._lastRenderReplayFrameIndex = frameIndex;
          renderSnapshot = { ...activeSnapshot, events: rf.events || [] };
        }
      }

      const isReplay = Boolean(this.lastSnapshot?.replayActive);

      this.renderer.render(renderSnapshot, {
        cameraPos: this.cameraPos,
        zoom: this.zoom,
        cameraMode: isReplay ? 'bsg_replay' : 'spectator',
        dt,
        showLeadReticle: false,
      });
    }

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(this.renderLoop.bind(this));
    }
  }
}

export { SpectatorApp };

// Instantiate on Page Load
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const initSpectator = () => {
    if (!window.spectatorApp && document.getElementById('space-canvas')) {
      window.spectatorApp = new SpectatorApp();
    }
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initSpectator);
  } else {
    initSpectator();
  }
}
