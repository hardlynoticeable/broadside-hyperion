/**
 * BROADSIDE HYPERION — Main Client Application & Station Router
 *
 * Coordinates WebSocket connection, 30Hz snapshot ingestion with 60FPS client-side
 * dead-reckoning interpolation, procedural Web Audio sound synthesis, diegetic station
 * consoles (Helm, Weapons, Engineer), and Lobby / Drydock fleet configuration.
 */

import { HelmController } from './controls-helm.js';
import { WeaponsController } from './controls-weapons.js';
import { EngineerController } from './controls-engineer.js';
import { SpaceRenderer } from './renderer.js';
import { initPwa } from './pwa.js';

/**
 * Procedural Web Audio API Sound Synthesizer.
 * Generates zero-dependency sci-fi sound effects directly in code.
 */
export class SoundSynth {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.muted = false;
    this.railgunCharge = null;
  }

  /**
   * Initializes or resumes the AudioContext on first user interaction.
   */
  initContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
      return this.ctx;
    }

    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    try {
      this.ctx = new AudioCtx();
      this.unlocked = true;
    } catch (e) {
      // AudioContext unavailable
    }
    return this.ctx;
  }

  /**
   * Unlocks audio on user gesture.
   */
  unlock() {
    this.initContext();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Generates a white noise buffer.
   */
  createNoiseBuffer(duration = 0.5) {
    const ctx = this.initContext();
    if (!ctx) return null;

    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * RCS compressed-gas thruster hiss.
   */
  playRcsHiss() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = this.createNoiseBuffer(0.2);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1200, now);
      filter.Q.setValueAtTime(2.5, now);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.dest(ctx));

      noise.start(now);
      noise.stop(now + 0.2);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Twin Pulse Laser firing zap.
   */
  playLaserZap() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(850, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.12);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 0.13);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Heavy Railgun hold-to-charge hum.
   */
  playRailgunCharge() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      this.stopRailgunCharge(true);

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(55, now);
      osc.frequency.exponentialRampToValueAtTime(260, now + 1.2);

      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 1.2);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 1.25);

      const handle = { osc, gain, timerId: null };
      handle.timerId = setTimeout(() => {
        if (this.railgunCharge === handle) {
          this.railgunCharge = null;
        }
        try {
          osc.disconnect();
        } catch (e) {}
        try {
          gain.disconnect();
        } catch (e) {}
      }, 1260);
      this.railgunCharge = handle;

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Smoothly stops and cleans up active railgun charge oscillator.
   */
  stopRailgunCharge(immediate = false) {
    if (!this.railgunCharge) return false;

    const rc = this.railgunCharge;
    this.railgunCharge = null;

    if (rc.timerId) {
      clearTimeout(rc.timerId);
      rc.timerId = null;
    }

    try {
      const now = this.ctx?.currentTime || 0;
      if (rc.gain?.gain?.setTargetAtTime) {
        rc.gain.gain.setTargetAtTime(0, now, immediate ? 0.005 : 0.02);
      } else if (rc.gain?.gain) {
        rc.gain.gain.value = 0;
      }
    } catch (e) {
      try {
        if (rc.gain?.gain) rc.gain.gain.value = 0;
      } catch (err) {}
    }

    const cleanupDelay = immediate ? 30 : 80;
    setTimeout(() => {
      try {
        rc.osc?.stop?.();
      } catch (e) {}
      try {
        rc.osc?.disconnect?.();
      } catch (e) {}
      try {
        rc.gain?.disconnect?.();
      } catch (e) {}
    }, cleanupDelay);

    return true;
  }

  /**
   * Heavy Railgun hypersonic crack.
   */
  playRailgunFire() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;

      // Heavy low punch
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'triangle';
      sub.frequency.setValueAtTime(120, now);
      sub.frequency.exponentialRampToValueAtTime(30, now + 0.35);
      subGain.gain.setValueAtTime(0.4, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      sub.connect(subGain);
      subGain.connect(this.dest(ctx));
      sub.start(now);
      sub.stop(now + 0.36);

      // Supersonic noise snap
      const snap = ctx.createBufferSource();
      snap.buffer = this.createNoiseBuffer(0.1);
      const snapGain = ctx.createGain();
      snapGain.gain.setValueAtTime(0.3, now);
      snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      snap.connect(snapGain);
      snapGain.connect(this.dest(ctx));
      snap.start(now);
      snap.stop(now + 0.09);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Homing Torpedo launch thump & whoosh.
   */
  playTorpedoLaunch() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.3);

      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 0.32);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Point-Defense Flak burst detonation boom.
   */
  playFlakDetonation() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const noise = ctx.createBufferSource();
      noise.buffer = this.createNoiseBuffer(0.5);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(300, now);
      filter.frequency.exponentialRampToValueAtTime(60, now + 0.4);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.dest(ctx));

      noise.start(now);
      noise.stop(now + 0.5);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Conduit rotation click.
   */
  playConduitClick() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(1600, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 0.05);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Circuit breaker toggle snap.
   */
  playBreakerToggle() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(340, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 0.07);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Capacitor energy surge discharge buzz.
   */
  playCapacitorDischarge() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.linearRampToValueAtTime(660, now + 0.35);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 0.36);
      return true;
    } catch (e) {
      return false;
    }
  }




  /**
   * Returns the audio sink for new sounds: a per-call volume bus when set by playAtVolume(),
   * otherwise the context destination.
   */
  dest(ctx) {
    return this._bus || ctx.destination;
  }

  /**
   * Runs a sound-playing function with all of its nodes routed through a volume bus.
   *
   * @param {number} volume - linear gain 0..1
   * @param {Function} fn - sound player to invoke synchronously
   */
  playAtVolume(volume, fn) {
    const ctx = this.initContext();
    if (!ctx || this.muted || volume >= 0.999) return fn();
    const bus = ctx.createGain();
    bus.gain.value = Math.max(0, volume);
    bus.connect(ctx.destination);
    this._bus = bus;
    try {
      return fn();
    } finally {
      this._bus = null;
    }
  }

  /**
   * Continuous main-engine rumble driven by throttle (0..1). Call every snapshot;
   * pass 0 to silence. Lazily builds a looping filtered-noise + sub-oscillator voice.
   */
  updateEngine(throttle = 0) {
    const ctx = this.initContext();
    if (!ctx) return false;
    const level = this.muted ? 0 : Math.max(0, Math.min(1, Number(throttle) || 0));

    try {
      if (!this.engine) {
        if (level <= 0.001) return false;
        const noise = ctx.createBufferSource();
        noise.buffer = this.createNoiseBuffer(2);
        noise.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 180;
        const sub = ctx.createOscillator();
        sub.type = 'sawtooth';
        sub.frequency.value = 42;
        const subGain = ctx.createGain();
        subGain.gain.value = 0.5;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        noise.connect(filter);
        filter.connect(gain);
        sub.connect(subGain);
        subGain.connect(filter);
        gain.connect(ctx.destination);
        noise.start();
        sub.start();
        this.engine = { gain, filter, sub };
      }

      const now = ctx.currentTime;
      this.engine.gain.gain.setTargetAtTime(level * 0.22, now, 0.15);
      this.engine.filter.frequency.setTargetAtTime(150 + level * 350, now, 0.2);
      this.engine.sub.frequency.setTargetAtTime(38 + level * 30, now, 0.2);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Killing blow slow-motion time dilation drone.
   */
  playKillCamSlowMo() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(90, now);
      osc.frequency.exponentialRampToValueAtTime(45, now + 1.2);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

      osc.connect(gain);
      gain.connect(this.dest(ctx));

      osc.start(now);
      osc.stop(now + 1.25);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Continuous ascending warp charge hum (110Hz + charge * 130Hz).
   * Gentle harmonic triangle + filtered sine tracking charging progress continuously.
   */
  updateWarpChargeSound(active, charge = 0, muted = false) {
    const isMuted = this.muted || muted;
    if (!active || isMuted || charge <= 0) {
      if (this.warpCharge) {
        try {
          const now = this.ctx?.currentTime || 0;
          this.warpCharge.gain.gain.setTargetAtTime(0, now, 0.08);
          const wc = this.warpCharge;
          this.warpCharge = null;
          setTimeout(() => {
            try {
              wc.osc1?.stop();
              wc.osc2?.stop();
              wc.gain?.disconnect();
            } catch (e) {}
          }, 200);
        } catch (e) {
          this.warpCharge = null;
        }
      }
      return false;
    }

    const ctx = this.initContext();
    if (!ctx) return false;

    try {
      const now = ctx.currentTime;
      const progress = Math.max(0, Math.min(1, Number(charge) || 0));

      if (!this.warpCharge) {
        const osc1 = ctx.createOscillator();
        osc1.type = 'triangle';
        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(450, now);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, now);

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(this.dest(ctx));

        osc1.start(now);
        osc2.start(now);
        this.warpCharge = { osc1, osc2, filter, gain };
      }

      const freq = 110 + progress * 130;
      this.warpCharge.osc1.frequency.setTargetAtTime(freq, now, 0.08);
      this.warpCharge.osc2.frequency.setTargetAtTime(freq * 0.5, now, 0.08);
      this.warpCharge.filter.frequency.setTargetAtTime(350 + progress * 400, now, 0.08);
      this.warpCharge.gain.gain.setTargetAtTime(0.22, now, 0.08);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Star Trek TNG/Kelvin warp jump engagement.
   * Ascending warp core build sweep (55Hz -> 320Hz), high shimmer harmonic (triangle 440Hz -> 1320Hz),
   * bandpass noise swoosh (300Hz -> 3600Hz), culminating around +0.42s in downward snap/thump (880Hz -> 62Hz).
   */
  playWarpEngage() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;

      // 1. Ascending warp core build sweep (55Hz -> 320Hz)
      const core = ctx.createOscillator();
      const coreGain = ctx.createGain();
      core.type = 'sawtooth';
      core.frequency.setValueAtTime(55, now);
      core.frequency.exponentialRampToValueAtTime(320, now + 0.42);
      coreGain.gain.setValueAtTime(0.05, now);
      coreGain.gain.linearRampToValueAtTime(0.28, now + 0.40);
      coreGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      core.connect(coreGain);
      coreGain.connect(this.dest(ctx));
      core.start(now);
      core.stop(now + 0.46);

      // 2. High shimmer harmonic (triangle 440Hz -> 1320Hz)
      const shimmer = ctx.createOscillator();
      const shimmerGain = ctx.createGain();
      shimmer.type = 'triangle';
      shimmer.frequency.setValueAtTime(440, now);
      shimmer.frequency.exponentialRampToValueAtTime(1320, now + 0.42);
      shimmerGain.gain.setValueAtTime(0.02, now);
      shimmerGain.gain.linearRampToValueAtTime(0.18, now + 0.38);
      shimmerGain.gain.exponentialRampToValueAtTime(0.001, now + 0.44);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(this.dest(ctx));
      shimmer.start(now);
      shimmer.stop(now + 0.45);

      // 3. Bandpass noise swoosh (300Hz -> 3600Hz)
      const noise = ctx.createBufferSource();
      noise.buffer = this.createNoiseBuffer(0.5);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.setValueAtTime(300, now);
      noiseFilter.frequency.exponentialRampToValueAtTime(3600, now + 0.42);
      noiseFilter.Q.setValueAtTime(3.0, now);
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.05, now);
      noiseGain.gain.linearRampToValueAtTime(0.25, now + 0.40);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.46);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.dest(ctx));
      noise.start(now);
      noise.stop(now + 0.48);

      // 4. Downward Star Trek warp snap/thump around +0.42s (880Hz -> 62Hz)
      const snap = ctx.createOscillator();
      const snapGain = ctx.createGain();
      snap.type = 'sine';
      snap.frequency.setValueAtTime(880, now + 0.40);
      snap.frequency.exponentialRampToValueAtTime(62, now + 0.58);
      snapGain.gain.setValueAtTime(0.001, now);
      snapGain.gain.setValueAtTime(0.35, now + 0.41);
      snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.62);
      snap.connect(snapGain);
      snapGain.connect(this.dest(ctx));
      snap.start(now + 0.40);
      snap.stop(now + 0.64);

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Starts smooth subspace warp thrum (68Hz + softly modulated bandpass noise).
   * Active only while ship is in warp transit ('jumping').
   */
  startWarpTravelSound() {
    if (this.muted) return false;
    const ctx = this.initContext();
    if (!ctx) return false;

    if (this.warpTravel) return true;

    try {
      const now = ctx.currentTime;

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(68, now);

      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.2, now);

      const noise = ctx.createBufferSource();
      noise.buffer = this.createNoiseBuffer(2.0);
      noise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(180, now);
      filter.Q.setValueAtTime(2.0, now);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.08, now);

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.001, now);
      masterGain.gain.linearRampToValueAtTime(0.22, now + 0.2);

      sub.connect(subGain);
      subGain.connect(masterGain);
      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(masterGain);
      masterGain.connect(this.dest(ctx));

      sub.start(now);
      noise.start(now);
      this.warpTravel = { sub, noise, masterGain };
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Stops continuous subspace warp thrum.
   */
  stopWarpTravelSound() {
    if (!this.warpTravel) return;
    try {
      const wt = this.warpTravel;
      this.warpTravel = null;
      const now = this.ctx?.currentTime || 0;
      wt.masterGain.gain.setTargetAtTime(0, now, 0.05);
      setTimeout(() => {
        try {
          wt.sub?.stop();
          wt.noise?.stop();
          wt.masterGain?.disconnect();
        } catch (e) {}
      }, 100);
    } catch (e) {
      this.warpTravel = null;
    }
  }

  /**
   * Heavy de-warp deceleration sub-bass drop (220Hz -> 36Hz) + power-down sag (520Hz -> 75Hz).
   */
  playWarpExitBoom() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;

      // 1. Sub-bass deceleration drop (220Hz -> 36Hz)
      const sub = ctx.createOscillator();
      const subGain = ctx.createGain();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(220, now);
      sub.frequency.exponentialRampToValueAtTime(36, now + 0.45);
      subGain.gain.setValueAtTime(0.38, now);
      subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
      sub.connect(subGain);
      subGain.connect(this.dest(ctx));
      sub.start(now);
      sub.stop(now + 0.54);

      // 2. Power-down sag (520Hz -> 75Hz)
      const sag = ctx.createOscillator();
      const sagGain = ctx.createGain();
      sag.type = 'sawtooth';
      sag.frequency.setValueAtTime(520, now);
      sag.frequency.exponentialRampToValueAtTime(75, now + 0.4);
      sagGain.gain.setValueAtTime(0.18, now);
      sagGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      sag.connect(sagGain);
      sagGain.connect(this.dest(ctx));
      sag.start(now);
      sag.stop(now + 0.46);

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Two-tone rising Starfleet bridge startup chime (330Hz -> 495Hz).
   */
  playRebootStage1() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;

      // Tone 1: 330 Hz
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(330, now);
      gain1.gain.setValueAtTime(0.2, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc1.connect(gain1);
      gain1.connect(this.dest(ctx));
      osc1.start(now);
      osc1.stop(now + 0.18);

      // Tone 2: 495 Hz
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(495, now + 0.14);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.22, now + 0.14);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
      osc2.connect(gain2);
      gain2.connect(this.dest(ctx));
      osc2.start(now + 0.14);
      osc2.stop(now + 0.38);

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Crisp 3-note ascending C5-E5-G5 harmonic chime (523.25Hz, 659.25Hz, 783.99Hz).
   */
  playRebootComplete() {
    const ctx = this.initContext();
    if (!ctx || this.muted) return false;

    try {
      const now = ctx.currentTime;
      const notes = [
        { freq: 523.25, time: 0.0, dur: 0.14 },
        { freq: 659.25, time: 0.11, dur: 0.14 },
        { freq: 783.99, time: 0.22, dur: 0.26 },
      ];

      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, now + n.time);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.setValueAtTime(0.22, now + n.time);
        gain.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);
        osc.connect(gain);
        gain.connect(this.dest(ctx));
        osc.start(now + n.time);
        osc.stop(now + n.time + n.dur + 0.02);
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Stops all active continuous sound loops (railgun charge, engine, warp charge, warp transit).
   */
  stopAllLoops() {
    this.stopRailgunCharge(true);
    if (typeof this.updateEngine === 'function') this.updateEngine(0);
    if (typeof this.updateWarpChargeSound === 'function') this.updateWarpChargeSound(false, 0);
    if (typeof this.stopWarpTravelSound === 'function') this.stopWarpTravelSound();
  }
}

/**
 * Main Client Application Coordinator.
 */
export class BroadsideClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || this.resolveWebSocketUrl();
    this.ws = null;
    this.connected = false;

    this.playerId = null;
    this.player = null;
    this.team = 'alpha';
    this.station = 'helm';

    this.sound = new SoundSynth();

    // Snapshot interpolation state
    this.lastSnapshot = null;
    this.currentSnapshot = null;
    this.lastSnapshotTime = 0;

    // Controllers
    this.helm = null;
    this.weapons = null;
    this.engineer = null;
    this.renderer = null;

    this.camera = { x: 0, y: 0, z: 0, zoom: 1 };
    this.running = false;
    this._listeners = [];
    this.pwa = null;

    // Replay tracking & camera state
    this._wasReplayActive = false;
    this._lastReplayFrameIndex = -1;
    this._lastReplayAudioFrameIndex = -1;
    this.replayCamera = { x: 0, y: 0, z: 0, zoom: 0.25 };
    this._replayCamInitialized = false;

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.init();
    }
  }

  /**
   * Resolves WebSocket URL based on window location.
   */
  resolveWebSocketUrl() {
    if (typeof window === 'undefined' || !window.location) {
      return 'ws://localhost:3000/ws';
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  /**
   * Initializes application, controllers, audio unlock, and connects WebSocket.
   */
  init() {
    if (!this.pwa) {
      this.pwa = initPwa();
    }

    // Unlock Web Audio on first user interaction
    const unlockAudio = () => {
      this.sound.unlock();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    window.addEventListener('touchstart', unlockAudio);

    // Initialize Station Controllers
    const sendFn = (msg) => this.send(msg);

    this.helm = new HelmController({ send: sendFn, sound: this.sound, isActive: this.station === 'helm' });
    this.helmController = this.helm;
    this.weapons = new WeaponsController({
      send: sendFn,
      sound: this.sound,
      getCamera: () => this.camera,
      renderer: this.renderer,
      myTeam: this.team,
      isActive: this.station === 'weapons',
    });
    this.weaponsController = this.weapons;
    this.engineer = new EngineerController({ send: sendFn, sound: this.sound, isActive: this.station === 'engineer' });
    this.engineerController = this.engineer;

    // Initialize Viewport Canvas Renderer if available
    const canvas = document.getElementById('space-canvas');
    if (canvas && SpaceRenderer) {
      try {
        this.renderer = new SpaceRenderer(canvas);
        if (this.weapons) this.weapons.renderer = this.renderer;
      } catch (e) {
        // SpaceRenderer initialization fallback
      }
    }

    // Initial resize and deferred layout stabilization
    this.renderer?.resize();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => this.renderer?.resize());
    }

    // Window resize & orientationchange listeners with 100ms deferred re-measure for tablets
    const handleResize = () => {
      this.renderer?.resize();
      setTimeout(() => this.renderer?.resize(), 100);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    this._listeners.push(() => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    });

    // ResizeObserver on #viewport-container for aspect ratio tracking
    const viewportEl = document.getElementById('viewport-container');
    if (typeof ResizeObserver !== 'undefined' && viewportEl) {
      this.resizeObserver = new ResizeObserver(() => {
        this.renderer?.resize();
      });
      this.resizeObserver.observe(viewportEl);
    }

    // Bind UI controls
    this.bindUI();

    // Initial station controller synchronization
    this.syncStationControllers();

    // Connect WebSocket
    this.connect();

    // Start 60 FPS Render / Interpolation Loop
    this.running = true;
    this.startLoop();
  }

  /**
   * Connects to authoritative server WebSocket.
   */
  connect() {
    if (typeof WebSocket === 'undefined') return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (e) {
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        // Ignore unparseable frames
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      // Reconnect after 1.5 seconds
      setTimeout(() => {
        if (this.running) this.connect();
      }, 1500);
    };
  }

  /**
   * Sends JSON message payload over WebSocket.
   */
  send(msg) {
    if (this.ws && this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Handles incoming network messages from server.
   */
  handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'welcome': {
        this.playerId = msg.playerId;
        this.player = msg.player;
        if (msg.player?.team) this.team = msg.player.team;
        if (msg.player?.station) this.switchStation(msg.player.station, false);
        if (msg.snapshot) this.handleSnapshot(msg.snapshot);
        break;
      }

      case 'snapshot': {
        if (msg.snapshot) this.handleSnapshot(msg.snapshot);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Opens the Drydock / Lobby modal overlay.
   */
  openLobby() {
    if (typeof document === 'undefined') return;
    const lobbyOverlay = document.getElementById('lobby-overlay');
    const btnOpenLobby = document.getElementById('btn-open-lobby');
    if (lobbyOverlay) {
      lobbyOverlay.classList.add('active');
      lobbyOverlay.style.display = 'flex';
    }
    if (btnOpenLobby) {
      btnOpenLobby.classList.add('active');
    }
    this.syncStationControllers();
  }

  /**
   * Closes the Drydock / Lobby modal overlay.
   */
  closeLobby() {
    if (typeof document === 'undefined') return;
    const lobbyOverlay = document.getElementById('lobby-overlay');
    const btnOpenLobby = document.getElementById('btn-open-lobby');
    if (lobbyOverlay) {
      lobbyOverlay.classList.remove('active');
      lobbyOverlay.style.display = 'none';
    }
    if (btnOpenLobby) {
      btnOpenLobby.classList.remove('active');
    }
    this.syncStationControllers();
    this.renderer?.resize();
  }

  /**
   * Toggles the Drydock / Lobby modal overlay.
   */
  toggleLobby() {
    if (typeof document === 'undefined') return;
    const lobbyOverlay = document.getElementById('lobby-overlay');
    if (lobbyOverlay && (lobbyOverlay.classList.contains('active') || lobbyOverlay.style.display === 'flex')) {
      this.closeLobby();
    } else {
      this.openLobby();
    }
  }

  /**
   * Safely checks whether the battle outcome overlay is currently visible in the DOM.
   *
   * @returns {boolean}
   */
  _isOutcomeOverlayVisible() {
    if (typeof document === 'undefined') return false;
    const el = document.getElementById('battle-outcome-overlay');
    if (!el) return false;
    const isHidden = typeof el.classList?.contains === 'function' ? el.classList.contains('hidden') : false;
    const isDisplayNone = el.style && el.style.display === 'none';
    return !isHidden && !isDisplayNone;
  }

  /**
   * Helper returning whether the current match has ended or replay is active.
   * Returns false when snapshot is null or match state is 'lobby'.
   */
  _isBattleEndedOrReplay(snapshot = this.currentSnapshot) {
    if (this._isOutcomeOverlayVisible()) return true;
    return Boolean(snapshot?.replayActive || snapshot?.state === 'gameover' || snapshot?.state === 'game_over' || snapshot?.state === 'restarting');
  }

  /**
   * Helper returning whether own ship is destroyed or reduced to 0 hull integrity.
   */
  _isOwnShipDestroyed(snapshot = this.currentSnapshot) {
    const shipsSource = (snapshot?.replayActive && snapshot?.replayFrame?.ships) ? snapshot.replayFrame.ships : snapshot?.ships;
    const myShip = shipsSource?.[this.team];
    return Boolean(myShip && (myShip.destroyed === true || (myShip.hullHp !== undefined && myShip.hullHp <= 0)));
  }

  /**
   * Synchronizes station controller activation and top HUD / station telemetry.
   */
  syncStationControllers(snapshot = this.currentSnapshot) {
    const lobbyEl = typeof document !== 'undefined' ? document.getElementById('lobby-overlay') : null;
    const lobbyOpen = Boolean(lobbyEl && (lobbyEl.classList.contains('active') || lobbyEl.style.display === 'flex'));
    const isReplay = Boolean(snapshot?.replayActive);
    const battleEnded = this._isBattleEndedOrReplay(snapshot);
    const shipsSource = (isReplay && snapshot?.replayFrame?.ships) ? snapshot.replayFrame.ships : snapshot?.ships;
    const myShip = shipsSource?.[this.team];
    const enemyTeam = this.team === 'alpha' ? 'omega' : 'alpha';
    const enemyShip = shipsSource?.[enemyTeam];
    const shipDestroyed = this._isOwnShipDestroyed(snapshot);

    if (snapshot) {
      if (this.helm) {
        this.helm.latestSnapshot = snapshot;
        if (myShip) this.helm._lastShip = myShip;
      }
      if (this.weapons) {
        this.weapons.latestSnapshot = snapshot;
        this.weapons.myTeam = this.team;
        if (myShip) this.weapons._lastShip = myShip;
      }
      if (this.engineer) {
        this.engineer.latestSnapshot = snapshot;
        if (myShip) this.engineer.ship = myShip;
      }
    }

    if (lobbyOpen || !this.station || battleEnded || shipDestroyed) {
      this.helm?.setActive(false);
      this.weapons?.setActive(false);
      this.engineer?.setActive(false);
    } else {
      this.helm?.setActive(this.station === 'helm');
      this.weapons?.setActive(this.station === 'weapons');
      this.engineer?.setActive(this.station === 'engineer');
    }

    if (!snapshot) return;

    this.updateTopHUD(myShip);

    const helmCtrl = this.helmController || this.helm;
    if (helmCtrl && this.station === 'helm') {
      helmCtrl.updateHUD(myShip, enemyShip);
    }
    if (this.weapons && this.station === 'weapons') {
      this.weapons.updateHUD(myShip, enemyShip);
    }
    if (this.engineer && this.station === 'engineer') {
      this.engineer.updateHUD(myShip);
    }
  }

  /**
   * Constructs shallow-cloned render snapshot for instant replay playback.
   * Feeds replayFrame ships, projectiles, tick, and non-destructively maps destroyed asteroids.
   * Deduplicates replay frame events to fire particle bursts exactly once per unique frameIndex.
   */
  buildReplayRenderSnapshot(snapshot) {
    if (!snapshot?.replayActive || !snapshot?.replayFrame) {
      return snapshot;
    }
    const rf = snapshot.replayFrame;
    const isNewFrame = rf.frameIndex !== this._lastReplayFrameIndex;
    if (isNewFrame) {
      this._lastReplayFrameIndex = rf.frameIndex;
    }

    let sector = snapshot.sector;
    if (sector && Array.isArray(sector.asteroids) && Array.isArray(rf.destroyedAsteroidIds)) {
      const destroyedSet = new Set(rf.destroyedAsteroidIds);
      sector = {
        ...sector,
        asteroids: sector.asteroids.map((ast) => {
          const isDestroyed = destroyedSet.has(ast.id);
          if (Boolean(ast.destroyed) === isDestroyed) return ast;
          return { ...ast, destroyed: isDestroyed };
        }),
      };
    }

    const replayShips = {};
    if (rf.ships) {
      for (const [id, s] of Object.entries(rf.ships)) {
        if (!s) continue;
        replayShips[id] = {
          ...s,
          hyperspace: s.hyperspace || { state: 'ready', charge: 0 },
          sensorsOnline: s.sensorsOnline ?? (s.hyperspace?.state !== 'jumping' && (s.hyperspace?.state !== 'rebooting' || (s.hyperspace?.rebootTimer ?? 0) >= 7.0)),
          externalViewsOnline: s.externalViewsOnline ?? (s.hyperspace?.state !== 'jumping' && (s.hyperspace?.state !== 'rebooting' || (s.hyperspace?.rebootTimer ?? 0) >= 4.0)),
          shields: {
            ...(s.shields || {}),
            online: s.shields?.online || { fore: true, aft: true, port: true, starboard: true },
          },
        };
      }
    }

    return {
      ...snapshot,
      tick: rf.tick ?? snapshot.tick,
      slowMoActive: rf.slowMoActive ?? snapshot.slowMoActive,
      ships: rf.ships ? replayShips : snapshot.ships,
      projectiles: rf.projectiles || [],
      events: isNewFrame ? (rf.events || []) : [],
      sector,
    };
  }

  /**
   * Updates replay broadcast camera: frames both ships cleanly at start,
   * then smoothly zooms (<= 1.15) onto the doomed/destroyed victim ship.
   */
  updateReplayCamera(replaySnapshot, dt) {
    if (!replaySnapshot?.ships) return;
    const alpha = replaySnapshot.ships.alpha;
    const omega = replaySnapshot.ships.omega;

    // Determine doomed/destroyed victim ship
    let victim = null;
    if (alpha && (alpha.hullHp <= 0 || (replaySnapshot.winner === 'omega' && alpha.hullHp <= (omega?.hullHp ?? 1000)))) {
      victim = alpha;
    } else if (omega && (omega.hullHp <= 0 || (replaySnapshot.winner === 'alpha' && omega.hullHp <= (alpha?.hullHp ?? 1000)))) {
      victim = omega;
    } else if (replaySnapshot.winner === 'alpha') {
      victim = omega;
    } else if (replaySnapshot.winner === 'omega') {
      victim = alpha;
    }

    const hasBoth = Boolean(alpha?.pos && omega?.pos);
    const midX = hasBoth ? (alpha.pos.x + omega.pos.x) / 2 : (alpha?.pos?.x || omega?.pos?.x || 0);
    const midY = hasBoth ? (alpha.pos.y + omega.pos.y) / 2 : (alpha?.pos?.y || omega?.pos?.y || 0);
    const midZ = hasBoth ? ((alpha.pos.z || 0) + (omega.pos.z || 0)) / 2 : (alpha?.pos?.z || omega?.pos?.z || 0);

    const dist = hasBoth ? Math.hypot(alpha.pos.x - omega.pos.x, alpha.pos.y - omega.pos.y, (alpha.pos.z || 0) - (omega.pos.z || 0)) : 1000;
    const fitZoom = Math.max(0.15, Math.min(0.55, 1200 / (dist + 600)));

    if (!this._replayCamInitialized) {
      this.replayCamera.x = midX;
      this.replayCamera.y = midY;
      this.replayCamera.z = midZ;
      this.replayCamera.zoom = fitZoom;
      this._replayCamInitialized = true;
      return;
    }

    let targetX = midX;
    let targetY = midY;
    let targetZ = midZ;
    let targetZoom = fitZoom;

    if (victim?.pos && (victim.hullHp <= 0 || replaySnapshot.slowMoActive)) {
      targetX = victim.pos.x;
      targetY = victim.pos.y;
      targetZ = victim.pos.z || 0;
      targetZoom = Math.min(1.15, 0.95);
    }

    const lerpRate = Math.min(1.0, (dt || 0.016) * 2.5);
    this.replayCamera.x += (targetX - this.replayCamera.x) * lerpRate;
    this.replayCamera.y += (targetY - this.replayCamera.y) * lerpRate;
    this.replayCamera.z += (targetZ - this.replayCamera.z) * lerpRate;
    this.replayCamera.zoom += (targetZoom - this.replayCamera.zoom) * lerpRate;
    this.replayCamera.zoom = Math.min(1.15, Math.max(0.15, this.replayCamera.zoom));
  }

  /**
   * Updates replay mode class on body, toggles #replay-hud-banner, and updates progress fill.
   */
  updateReplayBanner(snapshot) {
    const isReplay = Boolean(snapshot?.replayActive);

    if (isReplay && !this._wasReplayActive) {
      if (typeof this.closeLobby === 'function') {
        this.closeLobby();
      }
      this._lastReplayFrameIndex = -1;
      this._lastReplayAudioFrameIndex = -1;
      this._replayCamInitialized = false;
    }
    this._wasReplayActive = isReplay;

    if (typeof document !== 'undefined') {
      document.body?.classList?.toggle('replay-mode', isReplay);

      const banner = document.getElementById('replay-hud-banner');
      if (banner) {
        if (isReplay) {
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
        }
      }

      const fill = document.getElementById('replay-progress-fill');
      if (fill) {
        const pct = Math.max(0, Math.min(100, Math.round((snapshot?.replayProgress || 0) * 100)));
        fill.style.width = `${pct}%`;
      }
    }
  }

  /**
   * Updates battle conclusion overlay: displays Victorious or Destroyed banner
   * when battle concludes, keeping exact casing with zero decorative emojis.
   */
  updateBattleOutcomeOverlay(snapshot) {
    if (typeof document === 'undefined') return;

    const overlay = document.getElementById('battle-outcome-overlay');
    if (!overlay) return;

    const isGameOver = snapshot?.state === 'gameover' || snapshot?.state === 'game_over';
    if (!isGameOver || snapshot?.replayActive) {
      overlay.classList.add('hidden');
      overlay.classList.remove('outcome-victorious', 'outcome-destroyed', 'outcome-draw');
      return;
    }

    overlay.classList.remove('hidden', 'outcome-victorious', 'outcome-destroyed', 'outcome-draw');

    const titleEl = document.getElementById('battle-outcome-title');
    const subtitleEl = document.getElementById('battle-outcome-subtitle');

    if (snapshot.winner) {
      const isWinner = this.team === snapshot.winner;
      overlay.classList.add(isWinner ? 'outcome-victorious' : 'outcome-destroyed');
      if (titleEl) {
        titleEl.textContent = isWinner ? 'Victorious' : 'Destroyed';
      }
      if (subtitleEl) {
        if (isWinner) {
          subtitleEl.textContent = 'HOSTILE VESSEL ELIMINATED — SECTOR CONTROL SECURED';
        } else {
          const enemyShipName = snapshot.winner === 'omega' ? 'KRS VANGUARD' : 'UNS HYPERION';
          subtitleEl.textContent = `CATASTROPHIC HULL COLLAPSE — DESTROYED BY ${enemyShipName}`;
        }
      }
    } else {
      overlay.classList.add('outcome-draw');
      if (titleEl) {
        titleEl.textContent = 'Draw';
      }
      if (subtitleEl) {
        subtitleEl.textContent = 'MUTUAL DESTRUCTION — NO COMBAT SURVIVORS';
      }
    }
  }

  /**
   * Updates lobby station slot buttons, AI toggle, and drydock selects from snapshot.
   */
  updateLobbyUI(snapshot) {
    if (!snapshot || typeof document === 'undefined') return;

    // 1. Update station slots
    const slotButtons = document.querySelectorAll('.btn-station-slot');
    const players = Array.isArray(snapshot.players) ? snapshot.players : [];

    slotButtons.forEach((btn) => {
      const team = btn.dataset.team;
      const station = btn.dataset.station;
      const occupant = players.find(
        (p) => p.team === team && p.station === station && !p.isSpectator
      );
      const occupantSpan = btn.querySelector('.slot-occupant');

      if (occupant) {
        btn.classList.add('occupied');
        if (occupant.id === this.playerId) {
          btn.classList.add('selected');
          if (occupantSpan) occupantSpan.textContent = `${occupant.name} (YOU)`;
        } else {
          btn.classList.remove('selected');
          if (occupantSpan) occupantSpan.textContent = occupant.name;
        }
      } else {
        btn.classList.remove('occupied');
        btn.classList.remove('selected');
        if (occupantSpan) {
          occupantSpan.textContent =
            snapshot.aiEnabled !== false ? 'UNASSIGNED (AI)' : 'UNASSIGNED';
        }
      }
    });

    // 2. Sync AI Bots toggle
    const toggleBots = document.getElementById('toggle-ai-bots');
    if (toggleBots && document.activeElement !== toggleBots) {
      toggleBots.checked = snapshot.aiEnabled !== false;
    }

    // 3. Sync Drydock dropdowns
    if (snapshot.drydock) {
      for (const team of ['alpha', 'omega']) {
        const teamConfig = snapshot.drydock[team];
        if (!teamConfig) continue;

        const hullSelect = document.getElementById(`${team}-hull-select`);
        if (hullSelect && document.activeElement !== hullSelect && teamConfig.hullClass) {
          hullSelect.value = teamConfig.hullClass;
        }

        const modHelm = document.getElementById(`${team}-mod-helm`);
        if (modHelm && document.activeElement !== modHelm && teamConfig.modules?.helm) {
          modHelm.value = teamConfig.modules.helm;
        }

        const modWeapons = document.getElementById(`${team}-mod-weapons`);
        if (modWeapons && document.activeElement !== modWeapons && teamConfig.modules?.weapons) {
          modWeapons.value = teamConfig.modules.weapons;
        }

        const modEngineer = document.getElementById(`${team}-mod-engineer`);
        if (modEngineer && document.activeElement !== modEngineer && teamConfig.modules?.engineer) {
          modEngineer.value = teamConfig.modules.engineer;
        }
      }
    }
  }

  /**
   * Updates all-crew Hyperspace HUD status banner and external optics blackout overlay.
   *
   * @param {object} [myShip] - Own ship snapshot
   * @param {string} [gamePhase='playing'] - Current game phase ('playing'|'lobby'|'gameover'|'replay')
   */
  updateHyperspaceUI(myShip, gamePhase = 'playing') {
    if (typeof document === 'undefined') return;

    const bannerEl = document.getElementById('hyperspace-status-banner');
    const bannerTextEl = document.getElementById('hyperspace-banner-text');
    const blackoutEl = document.getElementById('hyperspace-blackout-overlay');
    const blackoutBar = document.getElementById('hyperspace-blackout-bar');
    const blackoutTimers = document.getElementById('hyperspace-blackout-timers');

    const hs = myShip?.hyperspace;
    const isPlaying = gamePhase === 'playing';

    if (bannerEl) {
      if (!isPlaying || !hs || hs.state === 'ready' || myShip?.destroyed) {
        bannerEl.classList.add('hidden');
      } else if (hs.state === 'charging') {
        bannerEl.classList.remove('hidden');
        if (bannerTextEl) {
          bannerTextEl.textContent = `HYPERSPACE CHARGING: ${Math.round((hs.charge || 0) * 100)}%`;
        }
      } else if (hs.state === 'jumping') {
        bannerEl.classList.remove('hidden');
        if (bannerTextEl) {
          bannerTextEl.textContent = 'WARP TRANSIT ACTIVE';
        }
      } else if (hs.state === 'rebooting') {
        bannerEl.classList.remove('hidden');
        const t = hs.rebootTimer ?? 0;
        const stage1 = hs.stage1Sec || 4.0;
        const total = hs.rebootDuration || 7.0;
        if (bannerTextEl) {
          if (t < stage1) {
            bannerTextEl.textContent = `HYPERSPACE EXIT — SHIP REBOOTING (VIEWS/ENGINES ${(stage1 - t).toFixed(1)}s · ALL ${(total - t).toFixed(1)}s)`;
          } else {
            bannerTextEl.textContent = `VIEWS & DRIVE ONLINE — REBOOTING SHIELDS / WPN / TGT (${(total - t).toFixed(1)}s)`;
          }
        }
      } else {
        bannerEl.classList.add('hidden');
      }
    }

    if (blackoutEl) {
      const showBlackout = isPlaying && !myShip?.destroyed && hs?.state === 'rebooting' && (hs.rebootTimer ?? 0) < 4.0;
      if (showBlackout) {
        blackoutEl.classList.remove('hidden');
        const t = hs.rebootTimer ?? 0;
        const pct = Math.max(0, Math.min(100, (t / 4.0) * 100));
        if (blackoutBar) {
          blackoutBar.style.width = `${pct.toFixed(1)}%`;
        }
        if (blackoutTimers) {
          blackoutTimers.textContent = `VIEWS / DRIVE / RCS: ${(4.0 - t).toFixed(1)}s · ALL SYSTEMS: ${(7.0 - t).toFixed(1)}s`;
        }
      } else {
        blackoutEl.classList.add('hidden');
      }
    }
  }

  /**
   * Updates all-crew Edge Dampening Field HUD status banner.
   *
   * @param {object} [myShip] - Own ship snapshot
   * @param {string} [gamePhase='playing'] - Current game phase ('playing'|'lobby'|'gameover'|'replay')
   */
  updateDampeningFieldUI(myShip, gamePhase = 'playing') {
    if (typeof document === 'undefined') return;

    const bannerEl = document.getElementById('dampening-field-banner');
    const bannerTextEl = document.getElementById('dampening-banner-text');

    const factor = Math.max(0, Math.min(1, Number(myShip?.dampeningFactor ?? (myShip?.inDampeningField ? 1 : 0)) || 0));
    const isVisible = gamePhase === 'playing' && !myShip?.destroyed && myShip?.hyperspace?.state !== 'jumping' && myShip?.externalViewsOnline !== false && factor > 0;

    if (bannerEl) {
      if (isVisible) {
        bannerEl.classList.remove('hidden');
        if (bannerTextEl) {
          bannerTextEl.textContent = `DAMPENING FIELD — -${(factor * 10).toFixed(1)}%/s DRAG`;
        }
      } else {
        bannerEl.classList.add('hidden');
      }
    }
  }

  /**
   * Updates pre-game bridge standby banner text and actions.
   */
  updatePreGameBanner(snapshot) {
    if (!snapshot || typeof document === 'undefined') return;

    const banner = document.getElementById('pregame-station-banner');
    const textEl = document.getElementById('pregame-banner-text');
    const launchBtn = document.getElementById('btn-bridge-launch');
    if (!banner) return;

    if (snapshot.replayActive) {
      banner.classList.add('hidden');
      return;
    }

    if (snapshot.state === 'lobby') {
      banner.classList.remove('hidden');
      if (textEl) {
        const shipName = this.team === 'alpha' ? 'UNS HYPERION' : 'KRS VANGUARD';
        textEl.textContent = `PRE-FLIGHT STATION CHECK — ${shipName} [${this.station.toUpperCase()}] READY`;
      }
      if (launchBtn) {
        launchBtn.textContent = 'LAUNCH MATCH';
      }
    } else if (snapshot.state === 'playing') {
      banner.classList.add('hidden');
    } else if (snapshot.state === 'gameover' || snapshot.state === 'game_over') {
      banner.classList.remove('hidden');
      if (textEl) {
        const winnerName = snapshot.winner === 'omega' ? 'KRS VANGUARD' : 'UNS HYPERION';
        textEl.textContent = `MATCH COMPLETE — ${winnerName} VICTORY`;
      }
      if (launchBtn) {
        launchBtn.textContent = 'START NEW MATCH';
      }
    }
  }

  /**
   * Plays the sound for a weapon-fire event. Every crew station hears it: the player's own
   * ship at full volume, the enemy ship at reduced volume.
   */
  playWeaponEventSound(ev) {
    if (!ev || !this.sound) return;
    const players = {
      laser_fired: 'playLaserZap',
      railgun_fired: 'playRailgunFire',
      torpedo_launched: 'playTorpedoLaunch',
      flak_burst: 'playFlakDetonation',
      hyperspace_enter: 'playWarpEngage',
      hyperspace_exit: 'playWarpExitBoom',
      hyperspace_reboot_stage1: 'playRebootStage1',
      hyperspace_reboot_complete: 'playRebootComplete',
    };
    const method = players[ev.type];
    if (!method || typeof this.sound[method] !== 'function') return;

    const own = !ev.shipId || ev.shipId === this.team;
    const volume = own ? 1.0 : 0.35;
    if (typeof this.sound.playAtVolume === 'function') {
      this.sound.playAtVolume(volume, () => this.sound[method]());
    } else {
      this.sound[method]();
    }
  }

  /**
   * Drives the continuous main-engine rumble from the player's own ship throttle.
   * Silent during replay, lobby, game over, or when the ship is destroyed.
   */
  updateEngineSound(snapshot) {
    if (!this.sound || typeof this.sound.updateEngine !== 'function') return;
    const ship = snapshot?.ships?.[this.team];
    const live = snapshot?.state === 'playing' && !snapshot?.replayActive && ship && !ship.destroyed;
    const throttle = live ? (ship.mainDrive?.throttle || 0) : 0;
    this.sound.updateEngine(throttle);
  }

  /**
   * Ingests 30Hz snapshot and dispatches telemetry to HUD and station consoles.
   */
  handleSnapshot(snapshot) {
    this.lastSnapshot = this.currentSnapshot;
    this.currentSnapshot = snapshot;
    this.lastSnapshotTime = performance.now();

    // 1. Update Replay mode transition & banner
    this.updateReplayBanner(snapshot);

    // 2. Process one-shot audio events (own ship at full volume, enemy ship fainter)
    if (snapshot.replayActive && snapshot.replayFrame) {
      const rf = snapshot.replayFrame;
      if (rf.frameIndex !== this._lastReplayAudioFrameIndex) {
        this._lastReplayAudioFrameIndex = rf.frameIndex;
        if (Array.isArray(rf.events)) {
          for (const ev of rf.events) this.playWeaponEventSound(ev);
        }
      }
    } else if (snapshot.state === 'playing' && snapshot.events && snapshot.events.length > 0) {
      for (const ev of snapshot.events) this.playWeaponEventSound(ev);
    }

    // 2b. Engine rumble for own ship, audible to every crew station
    this.updateEngineSound(snapshot);

    // 2c. Continuous warp sounds for own ship (charge hum & travel thrum)
    const myShip = snapshot?.ships?.[this.team];
    if (this.sound) {
      const isDestroyed = !myShip || myShip.destroyed || (myShip.hullHp !== undefined && myShip.hullHp <= 0);
      const live = Boolean(snapshot?.state === 'playing' && !snapshot?.replayActive && !isDestroyed);
      if (!live) {
        this.sound.stopRailgunCharge?.();
      }
      const hs = myShip?.hyperspace;
      const isCharging = Boolean(live && hs?.state === 'charging');
      if (typeof this.sound.updateWarpChargeSound === 'function') {
        this.sound.updateWarpChargeSound(isCharging, isCharging ? (hs?.charge || 0) : 0);
      }
      if (typeof this.sound.startWarpTravelSound === 'function' && typeof this.sound.stopWarpTravelSound === 'function') {
        if (live && hs?.state === 'jumping') {
          this.sound.startWarpTravelSound();
        } else {
          this.sound.stopWarpTravelSound();
        }
      }
    }

    // 3. DOM Alerts (if in browser)
    if (typeof document !== 'undefined') {
      const killCamBanner = document.getElementById('kill-cam-banner');
      if (killCamBanner) {
        if (snapshot.slowMoActive && !snapshot.replayActive) {
          if (killCamBanner.classList.contains('hidden')) {
            killCamBanner.classList.remove('hidden');
            this.sound.playKillCamSlowMo();
          }
        } else {
          killCamBanner.classList.add('hidden');
        }
      }
    }

    // 4. Update UI and controllers
    this.updateLobbyUI(snapshot);
    this.updatePreGameBanner(snapshot);
    this.updateHyperspaceUI(myShip, snapshot?.replayActive ? 'replay' : snapshot?.state);
    this.updateDampeningFieldUI(myShip, snapshot?.replayActive ? 'replay' : snapshot?.state);
    this.updateBattleOutcomeOverlay(snapshot);
    this.syncStationControllers(snapshot);
  }

  /**
   * Updates ship callsign, hull integrity bar, and 4-quadrant shield summary.
   */
  updateTopHUD(ship) {
    if (!ship || typeof document === 'undefined') return;

    // Callsign badge
    const nameEl = document.getElementById('hud-ship-name');
    if (nameEl) {
      const teamLabel = this.team === 'alpha' ? 'UNS HYPERION' : 'KRS VANGUARD';
      nameEl.textContent = `${teamLabel} (${ship.hullClass?.toUpperCase() || 'FRIGATE'})`;
      nameEl.className = `badge-value text-team-${this.team}`;
    }

    // Hull integrity bar
    const hullHp = ship.hullHp ?? 1000;
    const maxHullHp = ship.maxHullHp ?? 1000;
    const hullBar = document.getElementById('hud-hull-bar');
    if (hullBar) {
      const pct = Math.min(100, Math.max(0, (hullHp / maxHullHp) * 100));
      hullBar.style.width = `${pct}%`;
    }

    const hullText = document.getElementById('hud-hull-text');
    if (hullText) {
      hullText.textContent = `${Math.round(hullHp)} / ${maxHullHp}`;
    }

    // 4-quadrant shields summary mini grid
    const shields = ship.shields?.hp || {};
    const quads = ['fore', 'port', 'starboard', 'aft'];
    for (const quad of quads) {
      const el = document.querySelector(`.shield-quad[data-quad="${quad}"] .q-val`);
      if (el) {
        const isOnline = ship.shields?.online ? ship.shields.online[quad] !== false : true;
        if (!isOnline) {
          el.textContent = 'OFF';
          el.classList.add('offline');
        } else {
          el.textContent = Math.round(shields[quad] ?? 0);
          el.classList.remove('offline');
        }
      }
    }
  }

  /**
   * Binds station tabs, lobby overlay, drydock selects, and match buttons.
   */
  bindUI() {
    // 1. Station switching buttons
    const stations = ['helm', 'weapons', 'engineer'];
    for (const st of stations) {
      const btn = document.getElementById(`btn-station-${st}`);
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          this.switchStation(st, true);
          this.closeLobby();
        });
      }
    }

    // 2. Lobby modal overlay toggle
    const btnOpenLobby = document.getElementById('btn-open-lobby');
    const btnCloseLobby = document.getElementById('btn-close-lobby');

    if (btnOpenLobby) {
      btnOpenLobby.addEventListener('click', (e) => {
        e.preventDefault();
        this.toggleLobby();
      });
    }

    if (btnCloseLobby) {
      btnCloseLobby.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeLobby();
      });
    }

    // Pre-game Bridge banner buttons
    const btnBridgeDrydock = document.getElementById('btn-bridge-drydock');
    if (btnBridgeDrydock) {
      btnBridgeDrydock.addEventListener('click', (e) => {
        e.preventDefault();
        this.openLobby();
      });
    }

    const btnBridgeLaunch = document.getElementById('btn-bridge-launch');
    if (btnBridgeLaunch) {
      btnBridgeLaunch.addEventListener('click', (e) => {
        e.preventDefault();
        const actionType =
          this.currentSnapshot?.state === 'gameover' || this.currentSnapshot?.state === 'game_over'
            ? 'restart_match'
            : 'start_match';
        this.send({ type: actionType });
        this.closeLobby();
      });
    }

    // 3. Station Slot Joining Buttons
    const slotButtons = document.querySelectorAll('.btn-station-slot');
    slotButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const team = btn.dataset.team;
        const station = btn.dataset.station;
        const nameInput = document.getElementById('player-name-input');
        const name = nameInput?.value?.trim() || 'Commander';

        this.team = team;
        this.switchStation(station, false);

        this.send({
          type: 'join_station',
          team,
          station,
          name,
        });

        this.closeLobby();
      });
    });

    // 4. Drydock loadout dropdowns
    this.bindDrydockSelects('alpha');
    this.bindDrydockSelects('omega');

    // 5. Match Launch / Restart / AI Bot controls
    const toggleBots = document.getElementById('toggle-ai-bots');
    if (toggleBots) {
      toggleBots.addEventListener('change', () => {
        this.send({
          type: 'toggle_bots',
          enabled: toggleBots.checked,
        });
      });
    }

    const btnStartMatch = document.getElementById('btn-start-match');
    if (btnStartMatch) {
      btnStartMatch.addEventListener('click', () => {
        this.send({ type: 'start_match' });
        this.closeLobby();
      });
    }

    const btnRestartMatch = document.getElementById('btn-restart-match');
    if (btnRestartMatch) {
      btnRestartMatch.addEventListener('click', () => {
        this.send({ type: 'restart_match' });
        this.closeLobby();
      });
    }

    // Battle Outcome Overlay actions
    const btnOutcomeRematch = document.getElementById('btn-outcome-rematch');
    if (btnOutcomeRematch) {
      btnOutcomeRematch.addEventListener('click', (e) => {
        e.preventDefault();
        this.send({ type: 'restart_match' });
        this.closeLobby();
      });
    }

    const btnOutcomeDrydock = document.getElementById('btn-outcome-drydock');
    if (btnOutcomeDrydock) {
      btnOutcomeDrydock.addEventListener('click', (e) => {
        e.preventDefault();
        this.openLobby();
      });
    }
  }

  /**
   * Binds drydock configuration selects for a team.
   */
  bindDrydockSelects(team) {
    const hullSelect = document.getElementById(`${team}-hull-select`);
    const modHelm = document.getElementById(`${team}-mod-helm`);
    const modWeapons = document.getElementById(`${team}-mod-weapons`);
    const modEngineer = document.getElementById(`${team}-mod-engineer`);

    const onDrydockChange = () => {
      this.send({
        type: 'drydock_loadout',
        team,
        hullClass: hullSelect?.value || 'frigate',
        modules: {
          helm: modHelm?.value || 'overdrive_rcs',
          weapons: modWeapons?.value || 'heavy_torpedoes',
          engineer: modEngineer?.value || 'standard_drones',
        },
      });
    };

    [hullSelect, modHelm, modWeapons, modEngineer].forEach((el) => {
      if (el) el.addEventListener('change', onDrydockChange);
    });
  }

  /**
   * Switches active station console (Helm, Weapons, Engineer).
   */
  switchStation(newStation, notifyServer = true) {
    if (!['helm', 'weapons', 'engineer'].includes(newStation)) return;
    this.station = newStation;

    // Update switcher tabs and console visibility if DOM is present
    if (typeof document !== 'undefined') {
      ['helm', 'weapons', 'engineer'].forEach((st) => {
        const tab = document.getElementById(`btn-station-${st}`);
        if (tab) {
          if (st === newStation) tab.classList.add('active');
          else tab.classList.remove('active');
        }

        const consoleEl = document.getElementById(`console-${st}`);
        if (consoleEl) {
          if (st === newStation) consoleEl.classList.add('active');
          else consoleEl.classList.remove('active');
        }
      });
    }

    if (notifyServer) {
      this.send({
        type: 'switch_station',
        team: this.team,
        station: newStation,
      });
    }

    this.syncStationControllers(this.currentSnapshot);
    if (this.currentSnapshot) {
      this.updatePreGameBanner(this.currentSnapshot);
      this.updateReplayBanner(this.currentSnapshot);
      this.updateBattleOutcomeOverlay(this.currentSnapshot);
    }

    this.renderer?.resize();
    if (!this._isBattleEndedOrReplay(this.currentSnapshot) && !this._isOwnShipDestroyed(this.currentSnapshot)) {
      this.sound?.playConduitClick?.();
    }
  }

  /**
   * Starts client-side 60 FPS dead-reckoning and rendering loop.
   */
  startLoop() {
    let lastFrameTime = performance.now();

    const loop = (now) => {
      if (!this.running) return;

      const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
      lastFrameTime = now;

      // Render interpolated space canvas
      if (this.renderer && this.currentSnapshot) {
        if (this.currentSnapshot.replayActive && this.currentSnapshot.replayFrame) {
          const renderSnap = this.buildReplayRenderSnapshot(this.currentSnapshot);
          this.updateReplayCamera(renderSnap, dt);

          if (typeof document !== 'undefined') {
            const indEl = document.getElementById('enemy-edge-indicator');
            if (indEl) indEl.classList.add('hidden');
          }

          this.renderer.render(renderSnap, {
            cameraPos: this.replayCamera,
            zoom: this.replayCamera.zoom || 0.25,
            myShipTeam: this.team,
            cameraMode: 'bsg_replay',
            dt,
            showLeadReticle: false,
            leadReticle: null,
            pipSlots: undefined,
          });
        } else {
          const myShip = this.currentSnapshot.ships?.[this.team];
          const enemyTeam = this.team === 'alpha' ? 'omega' : 'alpha';
          const enemyShip = this.currentSnapshot.ships?.[enemyTeam];

          if (myShip?.pos) {
            this.camera.x = myShip.pos.x;
            this.camera.y = myShip.pos.y;
            this.camera.z = myShip.pos.z || 0;
          }

          // Advance helm throttle ramping & controls step
          if (this.station === 'helm' && this.helm) {
            this.helm.step(dt);
          }

          // Sync weapons context and update free-look orientation
          if (this.weapons) {
            this.weapons.renderer = this.renderer;
            this.weapons.latestSnapshot = this.currentSnapshot;
            this.weapons.myTeam = this.team;
            if (this.station === 'weapons') {
              this.weapons.updateGunnerView(dt, myShip);
            }
          }

          // Render Helm Sector Radar mini-map
          if (this.station === 'helm' && typeof document !== 'undefined') {
            const miniCanvas = document.getElementById('helm-minimap-canvas');
            if (miniCanvas) {
              SpaceRenderer.renderArenaMiniMap(miniCanvas, this.currentSnapshot, this.team);
            }
          }

          // Render Enemy Edge Indicator
          const sensorsOffline = myShip?.sensorsOnline === false || !myShip?.targetAvailable || enemyShip?.hyperspace?.state === 'jumping' || myShip?.hyperspace?.state === 'jumping';
          if (this.station === 'helm' && typeof this.renderer.projectEnemyToViewportEdge === 'function' && typeof document !== 'undefined') {
            const viewportRect = this.renderer.canvas?.getBoundingClientRect
              ? this.renderer.canvas.getBoundingClientRect()
              : { width: this.renderer.width, height: this.renderer.height };
            const edgeInfo = !sensorsOffline ? this.renderer.projectEnemyToViewportEdge(myShip, enemyShip, viewportRect) : null;
            const indEl = document.getElementById('enemy-edge-indicator');
            const lobbyEl = document.getElementById('lobby-overlay');
            const lobbyOpen = Boolean(lobbyEl && (lobbyEl.classList.contains('active') || lobbyEl.style.display === 'flex'));

            if (indEl) {
              if (!lobbyOpen && !sensorsOffline && edgeInfo?.visible && !edgeInfo.inFrustum) {
                indEl.classList.remove('hidden');
                indEl.style.display = '';
                indEl.style.left = `${edgeInfo.screenX}px`;
                indEl.style.top = `${edgeInfo.screenY}px`;
                const arrowEl = indEl.querySelector('.edge-arrow-icon') || indEl;
                arrowEl.style.transform = `rotate(${edgeInfo.arrowAngleRad + Math.PI / 2}rad)`;
                const distEl = document.getElementById('enemy-edge-dist');
                if (distEl) {
                  distEl.textContent = `${Math.round(edgeInfo.distanceMeters || 0)}m`;
                }
              } else {
                indEl.classList.add('hidden');
                indEl.style.display = 'none';
              }
            }
          } else if (typeof document !== 'undefined') {
            const indEl = document.getElementById('enemy-edge-indicator');
            if (indEl) {
              indEl.classList.add('hidden');
              indEl.style.display = 'none';
            }
          }

          const currentStation = this.activeStation || this.station;
          const cameraMode = currentStation === 'helm'
            ? 'helm_pov'
            : (currentStation === 'weapons'
                ? 'weapons_pov'
                : (currentStation === 'engineer' ? 'engineer_pov' : 'spectator'));
          let pipSlots = undefined;
          if (this.station === 'helm' && typeof document !== 'undefined') {
            pipSlots = [
              { el: document.querySelector('.pip-slot[data-pip="dorsal"]'), view: 'dorsal' },
              { el: document.querySelector('.pip-slot[data-pip="side"]'), view: 'side' },
              { el: document.querySelector('.pip-slot[data-pip="stern"]'), view: 'stern' },
            ].filter((s) => s.el);
          }
          const gunnerWorldAngle = this.weapons ? this.weapons.getGunnerWorldAngle(myShip) : (myShip?.angle || 0);
          const pitchOffset = this.weapons?.gunnerPitchOffset || 0;
          const weaponsZoom = this.weapons?.weaponsZoom ?? 1.0;
          const leadReticle = this.weapons ? this.weapons.getLeadReticle() : null;

          this.renderer.render(this.currentSnapshot, {
            cameraPos: this.camera,
            zoom: this.camera.zoom || 1.0,
            myShipTeam: this.team,
            cameraMode,
            pipSlots,
            gunnerWorldAngle,
            pitchOffset,
            weaponsZoom,
            showLeadReticle: this.station === 'weapons' || Boolean(leadReticle),
            leadReticle,
          });
        }
      }

      requestAnimationFrame(loop);
    };

    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(loop);
    }
  }

  /**
   * Cleanly shuts down client, sockets, and controllers.
   */
  destroy() {
    this.running = false;
    if (typeof document !== 'undefined') {
      document.body?.classList?.remove('replay-mode');
    }
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch (e) {}
      this.resizeObserver = null;
    }
    for (const unbind of this._listeners) {
      unbind();
    }
    this._listeners = [];

    if (this.helm) {
      this.helm.setActive(false);
      this.helm.destroy();
    }
    if (this.weapons) {
      this.weapons.setActive(false);
      this.weapons.destroy();
    }
    if (this.engineer) {
      this.engineer.setActive(false);
      this.engineer.destroy();
    }
    if (this.sound) {
      this.sound.stopAllLoops?.();
      if (typeof this.sound.updateWarpChargeSound === 'function') {
        this.sound.updateWarpChargeSound(false, 0);
      }
      if (typeof this.sound.stopWarpTravelSound === 'function') {
        this.sound.stopWarpTravelSound();
      }
    }
    if (this.pwa) {
      this.pwa.destroy();
      this.pwa = null;
    }
  }
}

export function bootstrapBroadsideClient() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (!window.broadsideApp && document.getElementById('space-canvas')) {
    window.broadsideApp = new BroadsideClient();
  }
  return window.broadsideApp || null;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => bootstrapBroadsideClient());
  } else {
    bootstrapBroadsideClient();
  }
}
