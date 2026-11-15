/**
 * BROADSIDE HYPERION — Weapons Control Console
 *
 * Implements Gunner 360° Free-Look with ship motion perturbation and damageable recentering,
 * weapon mode selection (Pulse Lasers, Heavy Railgun, Homing Torpedoes, Point-Defense Flak),
 * click/tap-to-fire on the 3D space viewport, pinpoint subsystem targeting,
 * and velocity-inherited lead reticle calculation.
 */

/**
 * Solves quadratic intercept for ballistic velocity inheritance:
 * |p_rel + v_rel * t| = v_proj * t
 */
export function calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projectileSpeed) {
  if (!shooterPos || !targetPos) {
    return { x: 0, y: 0, z: 0, aimAngle: 0, aimPitch: 0, t: 0, timeToIntercept: 0 };
  }

  const px = targetPos.x - shooterPos.x;
  const py = targetPos.y - shooterPos.y;
  const pz = (targetPos.z || 0) - (shooterPos.z || 0);

  const vx = (targetVel?.x || 0) - (shooterVel?.x || 0);
  const vy = (targetVel?.y || 0) - (shooterVel?.y || 0);
  const vz = (targetVel?.z || 0) - (shooterVel?.z || 0);

  const a = vx * vx + vy * vy + vz * vz - projectileSpeed * projectileSpeed;
  const b = 2 * (px * vx + py * vy + pz * vz);
  const c = px * px + py * py + pz * pz;

  let t = 0;
  const disc = b * b - 4 * a * c;

  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8) {
      const root = -c / b;
      if (root > 0) t = root;
    }
  } else if (disc >= 0) {
    const sqrtDisc = Math.sqrt(disc);
    const t1 = (-b - sqrtDisc) / (2 * a);
    const t2 = (-b + sqrtDisc) / (2 * a);

    if (t1 > 0 && t2 > 0) {
      t = Math.min(t1, t2);
    } else if (t1 > 0) {
      t = t1;
    } else if (t2 > 0) {
      t = t2;
    }
  }

  if (t <= 0) {
    const dist = Math.hypot(px, py, pz);
    t = dist / Math.max(1, projectileSpeed);
  }

  const targetFutureX = targetPos.x + (targetVel?.x || 0) * t;
  const targetFutureY = targetPos.y + (targetVel?.y || 0) * t;
  const targetFutureZ = (targetPos.z || 0) + (targetVel?.z || 0) * t;

  const muzzleDirX = (px + vx * t) / t;
  const muzzleDirY = (py + vy * t) / t;
  const muzzleDirZ = (pz + vz * t) / t;
  const aimAngle = Math.atan2(muzzleDirY, muzzleDirX);
  const muzzleDirH = Math.hypot(muzzleDirX, muzzleDirY);
  const aimPitch = Math.atan2(muzzleDirZ, Math.max(1e-5, muzzleDirH));

  return {
    x: targetFutureX,
    y: targetFutureY,
    z: targetFutureZ,
    aimAngle,
    aimPitch,
    t,
    timeToIntercept: t,
  };
}

export class WeaponsController {
  /**
   * @param {object} [options={}]
   * @param {function} [options.send] - Network send callback: send(msg)
   * @param {object} [options.sound] - SoundSynthesizer instance
   * @param {function} [options.getCamera] - Callback returning current viewport camera { x, y, zoom }
   * @param {object} [options.renderer] - SpaceRenderer instance
   * @param {string} [options.myTeam] - 'alpha' | 'omega'
   * @param {boolean} [options.isActive=true] - Input activation status
   * @param {string} [options.selectedWeapon='laser'] - 'laser' | 'railgun' | 'torpedo' | 'flak'
   */
  constructor(options = {}) {
    this.send = typeof options === 'function' ? options : (options.send || options.sendInput || (() => {}));
    this.sound = options.sound || options.soundSynth || null;
    this.getCamera = options.getCamera || (() => ({ x: 0, y: 0, zoom: 1 }));
    this.renderer = options.renderer || null;
    this.myTeam = options.myTeam || 'alpha';

    this.isActive = options.isActive !== undefined ? Boolean(options.isActive) : true;
    this.selectedWeapon = options.selectedWeapon || 'laser';

    this.aimAngle = 0;
    this.aimPitch = 0;
    this.isFiringLaser = false;
    this.isChargingRailgun = false;

    // Weapons optical zoom state (mouse wheel / 2-finger pinch)
    this.weaponsZoom = 1.0;
    this.isPinchZooming = false;
    this._pinchStartDist = 0;
    this._pinchStartZoom = 1.0;

    // Cached lead reticle coordinates
    this.leadReticle = null;
    this.latestSnapshot = null;
    this._lastShip = null;
    this._lastEnemyShip = null;

    // Gunner 360° Free-Look & Motion Perturbation State
    this.gunnerLookOffset = 0;      // Current combined look yaw offset [-PI, PI]
    this.desiredLookOffset = 0;     // Gunner intended look angle controlled by stick/keys/drag
    this.viewPerturbation = 0;      // Transient displacement caused by ship motion & rotation
    this.gunnerPitchOffset = 0;     // Vertical pitch offset [-1.35, 1.35]
    this.isLookingDrag = false;
    this.lookDragStart = { x: 0, y: 0 };
    this.lookStickVec = { x: 0, y: 0 };
    this.lookKeys = {
      KeyA: false,
      KeyD: false,
      KeyW: false,
      KeyS: false,
      ArrowLeft: false,
      ArrowRight: false,
      ArrowUp: false,
      ArrowDown: false,
      clear() {
        this.KeyA = false;
        this.KeyD = false;
        this.KeyW = false;
        this.KeyS = false;
        this.ArrowLeft = false;
        this.ArrowRight = false;
        this.ArrowUp = false;
        this.ArrowDown = false;
      },
    };

    // Click/Tap to fire state
    this.isPointerFiring = false;
    this.railgunPointerCharging = false;
    this.pendingRailgunAutoFire = false;
    this.pointerDownTime = 0;
    this._prevVel = null;

    this.bound = false;
    this._listeners = [];

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.bind();
    }
  }

  /**
   * Activates or deactivates Weapons input handling.
   * When deactivated, immediately clears held firing triggers and active look pointers.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.isActive = Boolean(active);
    if (!this.isActive) {
      if (typeof this.lookKeys?.clear === 'function') {
        this.lookKeys.clear();
      } else {
        for (const k in this.lookKeys) {
          if (typeof this.lookKeys[k] === 'boolean') this.lookKeys[k] = false;
        }
      }
      this.lookStickVec = { x: 0, y: 0 };
      this.isLookingDrag = false;
      this.isPinchZooming = false;
      this._pinchStartDist = 0;
      this._prevVel = null;
      this._cancelPointerFireWithoutFiring();
      this.sound?.stopRailgunCharge?.(true);
    }
  }

  /**
   * Cancels pointer laser/railgun states without releasing a railgun shot.
   * Used when transitioning from an initial single-finger touch into a two-finger pinch
   * or when weapons controls deactivate.
   */
  _cancelPointerFireWithoutFiring() {
    if (this.isPointerFiring || this.isFiringLaser) {
      this.isPointerFiring = false;
      this.isFiringLaser = false;
      this.setLaserFiring(false);
    }
    this.railgunPointerCharging = false;
    this.pendingRailgunAutoFire = false;
    this.isChargingRailgun = false;
    this.sound?.stopRailgunCharge?.(true);
  }

  /**
   * Sets the weapons optical zoom magnification clamped to [0.6, 5.0].
   *
   * @param {number} zoom
   * @returns {number}
   */
  setZoom(zoom) {
    if (!Number.isFinite(zoom)) return this.weaponsZoom;
    this.weaponsZoom = Math.max(0.6, Math.min(5.0, zoom));
    if (typeof document !== 'undefined') {
      const zoomEl = document.getElementById('weapons-zoom-readout');
      if (zoomEl) {
        zoomEl.textContent = `ZOOM ${this.weaponsZoom.toFixed(1)}x`;
      }
    }
    return this.weaponsZoom;
  }

  /**
   * Multiplies current weapons optical zoom by the given factor.
   *
   * @param {number} factor
   * @returns {number}
   */
  adjustZoom(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return this.weaponsZoom;
    return this.setZoom(this.weaponsZoom * factor);
  }

  /**
   * Safely checks whether the battle outcome overlay is currently visible.
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
   * Checks whether Weapons controller is active and permitted to process inputs.
   *
   * @returns {boolean}
   */
  canHandleInput() {
    if (!this.isActive) return false;

    if (this._isOutcomeOverlayVisible()) {
      return false;
    }

    if (this.latestSnapshot && (
      this.latestSnapshot.replayActive ||
      this.latestSnapshot.state === 'gameover' ||
      this.latestSnapshot.state === 'game_over' ||
      this.latestSnapshot.state === 'restarting' ||
      this.latestSnapshot.state === 'lobby'
    )) {
      return false;
    }

    if (this._lastShip && (
      this._lastShip.destroyed === true ||
      (typeof this._lastShip.hullHp === 'number' && this._lastShip.hullHp <= 0)
    )) {
      return false;
    }

    if (typeof document !== 'undefined') {
      const lobby = document.getElementById('lobby-overlay');
      if (lobby && (lobby.classList.contains('active') || lobby.style.display === 'flex')) {
        return false;
      }

      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
        return false;
      }
    }

    return true;
  }

  /**
   * Normalizes an angle in radians to [-PI, PI].
   *
   * @param {number} rad
   * @returns {number}
   */
  normalizeAngle(rad) {
    return ((rad + Math.PI) % (Math.PI * 2) + (Math.PI * 2)) % (Math.PI * 2) - Math.PI;
  }

  /**
   * Returns authoritative gunner world facing angle (ship angle + look offset).
   *
   * @param {object} [myShip]
   * @returns {number}
   */
  getGunnerWorldAngle(myShip) {
    return (myShip?.angle || 0) + this.gunnerLookOffset;
  }

  /**
   * Returns current effective gunner aim pitch clamped to [-1.396, +1.396] radians (~±80°).
   *
   * @returns {number}
   */
  getGunnerAimPitch() {
    return Math.max(-1.396, Math.min(1.396, -0.03 + this.gunnerPitchOffset));
  }

  /**
   * Selects active firing weapon mode.
   *
   * @param {'laser'|'railgun'|'torpedo'|'flak'} mode
   */
  selectWeapon(mode) {
    if (!['laser', 'railgun', 'torpedo', 'flak'].includes(mode)) return;
    this.selectedWeapon = mode;

    if (typeof document !== 'undefined') {
      ['laser', 'railgun', 'torpedo', 'flak'].forEach((m) => {
        const btn = document.getElementById(`btn-select-${m}`);
        if (btn) {
          if (m === mode) btn.classList.add('active');
          else btn.classList.remove('active');
        }
      });
    }
  }

  /**
   * Recenters gunner view to bow heading (look angle -> 0).
   */
  recenterView() {
    this.desiredLookOffset = 0;
    this.gunnerPitchOffset = 0;
    this.aimPitch = this.getGunnerAimPitch();
    if (typeof document !== 'undefined') {
      const angleEl = document.getElementById('weapons-look-angle');
      if (angleEl) angleEl.textContent = 'LOOK +000° / +00°';
    }
  }

  /**
   * Updates gunner view orientation based on ship motion perturbation,
   * look controller inputs, and damageable SAS computer stabilization decay.
   *
   * @param {number} dt - Frame delta in seconds (typically ~0.016s)
   * @param {object} [myShip] - Player ship state
   */
  updateGunnerView(dt = 0.016, myShip = null) {
    const stabHealth = myShip?.weapons?.stabilizerHealth ?? 100;
    const stabPowered = myShip?.weapons?.stabilizerPowered ?? true;
    const stabPower = myShip?.weapons?.stabilizerPower ?? myShip?.powerMap?.sas_computer ?? (stabPowered ? 1.0 : 0);
    const stabEff = Math.max(0.1, (stabHealth / 100) * (stabPower > 0 ? stabPower : 0.35));

    // 1. Ship Motion Perturbation (omega, roll, and linear acceleration disturbances)
    const omega = myShip?.omega || 0;
    const rollOmega = myShip?.rollOmega || 0;
    const joltGain = 1.0 - 0.72 * stabEff;
    this.viewPerturbation -= omega * joltGain * dt;
    this.viewPerturbation += (rollOmega * 0.35) * (1.0 - 0.75 * stabEff) * dt;

    const safeDt = Math.max(0.001, Math.min(0.1, dt));
    const curVx = myShip?.vel?.x || 0;
    const curVy = myShip?.vel?.y || 0;
    if (this._prevVel) {
      const ax = (curVx - this._prevVel.x) / safeDt;
      const ay = (curVy - this._prevVel.y) / safeDt;
      const clampedAx = Math.max(-500, Math.min(500, ax));
      const clampedAy = Math.max(-500, Math.min(500, ay));
      const gunnerWorldAngle = this.getGunnerWorldAngle(myShip);
      const sinG = Math.sin(gunnerWorldAngle);
      const cosG = Math.cos(gunnerWorldAngle);
      const accelGain = 0.015;
      const linearJolt = (-sinG * clampedAx + cosG * clampedAy) * accelGain * joltGain * safeDt;
      this.viewPerturbation += linearJolt;
    }
    this._prevVel = { x: curVx, y: curVy };

    // 2. Look Controller Input (Thumbstick or Keyboard A/D / W/S / Arrows)
    let lookDir = this.lookStickVec.x;
    if (this.lookKeys.KeyA || this.lookKeys.ArrowLeft) lookDir -= 1;
    if (this.lookKeys.KeyD || this.lookKeys.ArrowRight) lookDir += 1;
    lookDir = Math.max(-1, Math.min(1, lookDir));

    const lookZoomScale = 1 / Math.max(0.75, this.weaponsZoom || 1);

    if (Math.abs(lookDir) > 0.05) {
      this.desiredLookOffset += lookDir * 2.4 * lookZoomScale * dt;
      this.desiredLookOffset = this.normalizeAngle(this.desiredLookOffset);
    }

    let pitchDir = 0;
    if (this.lookKeys.KeyW || this.lookKeys.ArrowUp) pitchDir += 1;
    if (this.lookKeys.KeyS || this.lookKeys.ArrowDown) pitchDir -= 1;
    if (Math.abs(this.lookStickVec.y) > 0.05) {
      pitchDir -= this.lookStickVec.y;
    }
    if (Math.abs(pitchDir) > 0.05) {
      this.gunnerPitchOffset = Math.max(-1.35, Math.min(1.35, this.gunnerPitchOffset + pitchDir * 1.5 * lookZoomScale * dt));
      this.aimPitch = this.getGunnerAimPitch();
    }

    // 3. Damageable Recentering of Perturbation
    const recenterRate = 2.8 * stabEff;
    if (Math.abs(this.viewPerturbation) > 1e-4) {
      this.viewPerturbation *= Math.exp(-recenterRate * dt);
      if (Math.abs(this.viewPerturbation) < 1e-4) {
        this.viewPerturbation = 0;
      }
    } else {
      this.viewPerturbation = 0;
    }

    // Combined look offset
    this.gunnerLookOffset = this.normalizeAngle(this.desiredLookOffset + this.viewPerturbation);

    // Update readout in DOM if present
    if (typeof document !== 'undefined') {
      const angleEl = document.getElementById('weapons-look-angle');
      if (angleEl) {
        const yawDeg = Math.round((this.gunnerLookOffset * 180) / Math.PI);
        const pitchDeg = Math.round((this.gunnerPitchOffset * 180) / Math.PI);
        const yawSign = yawDeg >= 0 ? '+' : '';
        const pitchSign = pitchDeg >= 0 ? '+' : '';
        angleEl.textContent = `LOOK ${yawSign}${yawDeg}° / ${pitchSign}${pitchDeg}°`;
      }

      if (myShip && this._lastEnemyShip) {
        this.updateEnemyVector(myShip, this._lastEnemyShip);
      }
    }
  }

  /**
   * Computes aim angle in world space from viewport client coordinates.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {HTMLElement} [canvas=null]
   */
  computeAimAngleFromScreen(clientX, clientY, canvas = null) {
    const spaceCanvas = canvas || (typeof document !== 'undefined' ? document.getElementById('space-canvas') : null);
    const myShip = this.latestSnapshot?.ships?.[this.myTeam];

    if (this.renderer && typeof this.renderer.screenToAim3D === 'function') {
      const aim3D = this.renderer.screenToAim3D(clientX, clientY, this.latestSnapshot, this.myTeam);
      if (aim3D && typeof aim3D.aimAngle === 'number') {
        this.aimAngle = aim3D.aimAngle;
        this.aimPitch = aim3D.aimPitch ?? this.getGunnerAimPitch();
        return;
      }
    }

    if (this.renderer && typeof this.renderer.screenToWorldOnPlane === 'function') {
      const worldPt = this.renderer.screenToWorldOnPlane(clientX, clientY, this.latestSnapshot, this.myTeam);
      if (worldPt && myShip?.pos) {
        this.aimAngle = Math.atan2(worldPt.y - myShip.pos.y, worldPt.x - myShip.pos.x);
        this.aimPitch = this.getGunnerAimPitch();
        return;
      }
    }

    if (spaceCanvas) {
      const rect = spaceCanvas.getBoundingClientRect ? spaceCanvas.getBoundingClientRect() : { left: 0, top: 0, width: 1280, height: 720 };
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const camera = this.getCamera() || { x: 0, y: 0, zoom: 1 };
      const zoom = camera.zoom || 1;
      const relX = (screenX - cx) / zoom;
      const relY = (screenY - cy) / zoom;
      this.aimAngle = Math.atan2(relY, relX);
      this.aimPitch = this.getGunnerAimPitch();
      return;
    }

    this.aimAngle = this.getGunnerWorldAngle(myShip);
    this.aimPitch = this.getGunnerAimPitch();
  }

  /**
   * Evaluates if ship weapons are currently permitted to fire or charge.
   * Returns false if battle outcome overlay is visible, snapshot indicates game over/replay,
   * ship is destroyed, weapons are offline, ship is in warp, or in reboot < 7.0s.
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  areWeaponsPermitted(ship = this._lastShip) {
    if (this._isOutcomeOverlayVisible()) {
      return false;
    }
    if (this.latestSnapshot && (
      this.latestSnapshot.replayActive ||
      ['gameover', 'game_over', 'restarting', 'lobby'].includes(this.latestSnapshot.state)
    )) {
      return false;
    }
    if (!ship) return true;
    if (ship.destroyed === true || (typeof ship.hullHp === 'number' && ship.hullHp <= 0)) {
      return false;
    }
    if (ship.weaponsOnline === false) return false;
    const hs = ship.hyperspace;
    if (hs) {
      if (hs.state === 'jumping') return false;
      if (hs.state === 'rebooting' && (hs.rebootTimer ?? 0) < 7.0) return false;
    }
    return true;
  }

  /**
   * Returns true if twin pulse laser is capable of firing.
   * Requires weapons permitted, laser powered (> 0), and laser hardware intact (> 0).
   * Note: Overheated lasers remain capable of firing at reduced rate (0.65s / 0.5x damage).
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  canFireLaser(ship = this._lastShip) {
    if (!this.areWeaponsPermitted(ship)) return false;
    if (ship?.powerMap && (ship.powerMap.weapons_laser ?? 0) <= 0) return false;
    if (ship?.weapons?.laserHardware && (ship.weapons.laserHardware.health ?? 100) <= 0) return false;
    if (typeof ship?.weapons?.laserHealth === 'number' && ship.weapons.laserHealth <= 0) return false;
    return true;
  }

  /**
   * Returns true if heavy railgun can initiate charging.
   * Requires weapons permitted, railgun powered (> 0), hardware intact (> 0), and charge progress < 1.0.
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  canChargeRailgun(ship = this._lastShip) {
    if (!this.areWeaponsPermitted(ship)) return false;
    if (ship?.powerMap && (ship.powerMap.weapons_railgun ?? 0) <= 0) return false;
    if (ship?.weapons?.railgunHardware && (ship.weapons.railgunHardware.health ?? 100) <= 0) return false;
    if (typeof ship?.weapons?.railgunHealth === 'number' && ship.weapons.railgunHealth <= 0) return false;
    if ((ship?.weapons?.chargeProgress ?? 0) >= 1.0) return false;
    return true;
  }

  /**
   * Returns true if heavy railgun slug can be released.
   * Requires weapons permitted, chargeProgress >= 1.0, and railgunCooldown <= 0.
   * Note: Does NOT block release on weapons_railgun === 0 or railgunJammed (Capacitor Charged Bypass).
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  canReleaseRailgun(ship = this._lastShip) {
    if (!this.areWeaponsPermitted(ship)) return false;
    if (ship?.weapons) {
      if ((ship.weapons.chargeProgress ?? 0) < 1.0) return false;
      if ((ship.weapons.railgunCooldown ?? 0) > 0) return false;
      if (ship.weapons.railgunHardware && (ship.weapons.railgunHardware.health ?? 100) <= 0) return false;
      if (typeof ship.weapons.railgunHealth === 'number' && ship.weapons.railgunHealth <= 0) return false;
    }
    return true;
  }

  /**
   * Returns true if homing torpedo can be launched.
   * Requires weapons permitted, torpedo rack powered (> 0), hardware intact (> 0), magazine > 0, and cooldown <= 0.
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  canLaunchTorpedo(ship = this._lastShip) {
    if (!this.areWeaponsPermitted(ship)) return false;
    if (ship?.powerMap && (ship.powerMap.weapons_torpedo ?? 0) <= 0) return false;
    if (ship?.weapons?.torpedoHardware && (ship.weapons.torpedoHardware.health ?? 100) <= 0) return false;
    if (typeof ship?.weapons?.torpedoHealth === 'number' && ship.weapons.torpedoHealth <= 0) return false;
    if (ship?.weapons && (ship.weapons.magazine ?? 1) <= 0) return false;
    if (ship?.weapons && (ship.weapons.torpedoCooldown ?? 0) > 0) return false;
    return true;
  }

  /**
   * Returns true if point-defense flak can be detonated.
   * Requires weapons permitted, flak hardware intact (> 0), and flakCooldown <= 0.
   *
   * @param {object} [ship=this._lastShip]
   * @returns {boolean}
   */
  canFireFlak(ship = this._lastShip) {
    if (!this.areWeaponsPermitted(ship)) return false;
    if (ship?.weapons?.flakHardware && (ship.weapons.flakHardware.health ?? 100) <= 0) return false;
    if (typeof ship?.weapons?.flakHealth === 'number' && ship.weapons.flakHealth <= 0) return false;
    if (ship?.weapons && (ship.weapons.flakCooldown ?? 0) > 0) return false;
    return true;
  }

  /**
   * Initiates firing for the selected weapon on click/tap down.
   *
   * @param {number} clientX
   * @param {number} clientY
   */
  handlePointerFireStart(clientX, clientY) {
    if (!this.canHandleInput() || !this.areWeaponsPermitted()) return;
    this.computeAimAngleFromScreen(clientX, clientY);
    this.pointerDownTime = performance.now();

    switch (this.selectedWeapon) {
      case 'laser':
        if (!this.canFireLaser()) return;
        this.isPointerFiring = true;
        this.setLaserFiring(true);
        break;

      case 'railgun':
        if (!this.canChargeRailgun() && !this.canReleaseRailgun()) return;
        this.railgunPointerCharging = true;
        this.startRailgunCharge();
        break;

      case 'torpedo':
        if (!this.canLaunchTorpedo()) return;
        this.launchTorpedo();
        break;

      case 'flak':
        if (!this.canFireFlak()) return;
        this.fireFlak();
        break;
    }
  }

  /**
   * Tracks pointer drag during active laser firing or railgun charging.
   *
   * @param {number} clientX
   * @param {number} clientY
   */
  handlePointerFireMove(clientX, clientY) {
    if (this.isPointerFiring || this.railgunPointerCharging) {
      if (!this.canHandleInput() || !this.areWeaponsPermitted()) {
        this.handlePointerFireEnd();
        return;
      }
      this.computeAimAngleFromScreen(clientX, clientY);
      this.send({
        type: 'weapons_input',
        aimAngle: this.aimAngle,
        aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
        ...(this.isPointerFiring ? { fireLaser: true } : {}),
        ...(this.railgunPointerCharging ? { startRailgunCharge: true } : {}),
      });
    }
  }

  /**
   * Releases pointer firing trigger.
   */
  handlePointerFireEnd() {
    const wasFiring = this.isPointerFiring || this.isFiringLaser;
    const wasCharging = this.railgunPointerCharging || this.isChargingRailgun;
    this.isPointerFiring = false;
    this.railgunPointerCharging = false;
    this.pendingRailgunAutoFire = false;
    this.isLookingDrag = false;

    if (!this.canHandleInput() || !this.areWeaponsPermitted()) {
      this.isFiringLaser = false;
      this.isChargingRailgun = false;
      this.sound?.stopRailgunCharge?.(true);
      return;
    }

    if (wasFiring) {
      this.setLaserFiring(false);
    }
    if (wasCharging) {
      this.releaseRailgun();
    } else {
      this.sound?.stopRailgunCharge?.(true);
    }
  }

  /**
   * Binds mouse, touch, keyboard, and HUD button listeners.
   */
  bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;

    const canvas = document.getElementById('space-canvas');

    // Pointer down/up/move aiming and firing on space canvas
    if (canvas) {
      const onMouseDown = (e) => {
        if (!this.canHandleInput()) return;
        if (e.target && e.target.id !== 'space-canvas') return;

        if (e.button === 2) {
          // Right click: Free-look rotation
          e.preventDefault();
          this.isLookingDrag = true;
          this.lookDragStart = { x: e.clientX, y: e.clientY };
          return;
        }

        if (e.button === 0) {
          this.handlePointerFireStart(e.clientX, e.clientY);
        }
      };

      const onMouseMove = (e) => {
        if (this.isLookingDrag) {
          const dx = e.clientX - this.lookDragStart.x;
          const dy = e.clientY - this.lookDragStart.y;
          this.lookDragStart = { x: e.clientX, y: e.clientY };
          const lookZoomScale = 1 / Math.max(0.75, this.weaponsZoom || 1);
          this.desiredLookOffset = this.normalizeAngle(this.desiredLookOffset + dx * 0.006 * lookZoomScale);
          this.gunnerPitchOffset = Math.max(-1.35, Math.min(1.35, this.gunnerPitchOffset - dy * 0.003 * lookZoomScale));
          this.aimPitch = this.getGunnerAimPitch();
          return;
        }

        if (this.isPointerFiring || this.railgunPointerCharging) {
          this.handlePointerFireMove(e.clientX, e.clientY);
        }
      };

      const onMouseUp = (e) => {
        if (e.button === 2) {
          this.isLookingDrag = false;
        } else if (e.button === 0) {
          this.handlePointerFireEnd();
        }
      };

      const onContextMenu = (e) => e.preventDefault();

      const onWheel = (e) => {
        if (!this.canHandleInput()) return;
        if (e.target && canvas && e.target !== canvas && e.target.id !== 'space-canvas') return;
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
        const scale = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
        const rawY = (e.deltaY || 0) * scale;
        const clampedY = Math.max(-180, Math.min(180, rawY));
        this.adjustZoom(Math.exp(-clampedY * 0.0025));
      };

      // Touch events on canvas for tablets (1-finger fire/aim, 2-finger pinch zoom)
      const onTouchStart = (e) => {
        if (!this.canHandleInput()) return;
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
        const touches = e.touches;
        if (touches && touches.length >= 2) {
          this._cancelPointerFireWithoutFiring();
          this.isPinchZooming = true;
          this._pinchStartDist = Math.hypot(
            touches[1].clientX - touches[0].clientX,
            touches[1].clientY - touches[0].clientY
          );
          this._pinchStartZoom = this.weaponsZoom;
          return;
        }
        if (!this.isPinchZooming && touches && touches.length === 1) {
          const touch = touches[0];
          this.handlePointerFireStart(touch.clientX, touch.clientY);
        }
      };

      const onTouchMove = (e) => {
        const touches = e.touches;
        if (this.isPinchZooming || (touches && touches.length >= 2)) {
          if (!this.canHandleInput()) return;
          if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
          }
          if (touches && touches.length >= 2) {
            if (!this.isPinchZooming) {
              this._cancelPointerFireWithoutFiring();
              this.isPinchZooming = true;
              this._pinchStartZoom = this.weaponsZoom;
            }
            const dist = Math.hypot(
              touches[1].clientX - touches[0].clientX,
              touches[1].clientY - touches[0].clientY
            );
            if (this._pinchStartDist <= 1) {
              this._pinchStartDist = dist;
              this._pinchStartZoom = this.weaponsZoom;
            } else if (dist > 1) {
              this.setZoom(this._pinchStartZoom * (dist / this._pinchStartDist));
            }
          }
          return;
        }
        if (touches && touches.length > 0) {
          const touch = touches[0];
          if (this.isPointerFiring || this.railgunPointerCharging) {
            this.handlePointerFireMove(touch.clientX, touch.clientY);
          }
        }
      };

      const onTouchEnd = (e) => {
        const remaining = e.touches ? e.touches.length : 0;
        if (this.isPinchZooming) {
          if (e && typeof e.preventDefault === 'function') {
            e.preventDefault();
          }
          this._pinchStartDist = 0;
          this._pinchStartZoom = this.weaponsZoom;
          this.isPinchZooming = remaining > 0;
          return;
        }
        if (!this.isPointerFiring && !this.railgunPointerCharging) return;
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
        this.handlePointerFireEnd();
      };

      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('contextmenu', onContextMenu);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd, { passive: false });
      window.addEventListener('touchcancel', onTouchEnd, { passive: false });

      this._listeners.push(() => {
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('contextmenu', onContextMenu);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        window.removeEventListener('touchend', onTouchEnd);
        window.removeEventListener('touchcancel', onTouchEnd);
      });
    }

    // Keyboard weapon controls (Space, Shift, C, T, F, 1-4)
    const onKeyDown = (e) => this.handleKeyDown(e);
    const onKeyUp = (e) => this.handleKeyUp(e);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this._listeners.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    });

    // Weapon Selection Tabs [data-weapon-mode="laser"|"railgun"|"torpedo"|"flak"]
    const modeButtons = document.querySelectorAll('[data-weapon-mode]');
    modeButtons.forEach((btn) => {
      const onModeClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.selectWeapon(btn.dataset.weaponMode);
      };
      btn.addEventListener('click', onModeClick);
      this._listeners.push(() => btn.removeEventListener('click', onModeClick));
    });

    // Recenter View Button
    const btnRecenter = document.getElementById('btn-recenter-view');
    if (btnRecenter) {
      const onRecenterClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.recenterView();
      };
      btnRecenter.addEventListener('click', onRecenterClick);
      this._listeners.push(() => btnRecenter.removeEventListener('click', onRecenterClick));
    }

    // Weapons Look Thumbstick
    const lookStickZone = document.getElementById('weapons-look-stick-zone');
    if (lookStickZone) {
      this.bindLookThumbstick(lookStickZone);
    }

    // Touch & HUD action buttons (legacy compatibility)
    const btnLaser = document.getElementById('btn-fire-laser');
    if (btnLaser) {
      const onLaserDown = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.setLaserFiring(true);
      };
      const onLaserUp = (e) => {
        e.preventDefault();
        this.setLaserFiring(false);
      };

      btnLaser.addEventListener('mousedown', onLaserDown);
      btnLaser.addEventListener('mouseup', onLaserUp);
      btnLaser.addEventListener('touchstart', onLaserDown, { passive: false });
      btnLaser.addEventListener('touchend', onLaserUp, { passive: false });

      this._listeners.push(() => {
        btnLaser.removeEventListener('mousedown', onLaserDown);
        btnLaser.removeEventListener('mouseup', onLaserUp);
        btnLaser.removeEventListener('touchstart', onLaserDown);
        btnLaser.removeEventListener('touchend', onLaserUp);
      });
    }

    const btnRailgun = document.getElementById('btn-railgun-charge');
    if (btnRailgun) {
      const onRailDown = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.startRailgunCharge();
      };
      const onRailUp = (e) => {
        e.preventDefault();
        this.releaseRailgun();
      };

      btnRailgun.addEventListener('mousedown', onRailDown);
      btnRailgun.addEventListener('mouseup', onRailUp);
      btnRailgun.addEventListener('touchstart', onRailDown, { passive: false });
      btnRailgun.addEventListener('touchend', onRailUp, { passive: false });

      this._listeners.push(() => {
        btnRailgun.removeEventListener('mousedown', onRailDown);
        btnRailgun.removeEventListener('mouseup', onRailUp);
        btnRailgun.removeEventListener('touchstart', onRailDown);
        btnRailgun.removeEventListener('touchend', onRailUp);
      });
    }

    const btnTorpedo = document.getElementById('btn-launch-torpedo');
    if (btnTorpedo) {
      const onTorpClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.launchTorpedo();
      };
      btnTorpedo.addEventListener('click', onTorpClick);
      this._listeners.push(() => btnTorpedo.removeEventListener('click', onTorpClick));
    }

    const btnFlak = document.getElementById('btn-fire-flak');
    if (btnFlak) {
      const onFlakClick = (e) => {
        e.preventDefault();
        if (!this.canHandleInput()) return;
        this.fireFlak();
      };
      btnFlak.addEventListener('click', onFlakClick);
      this._listeners.push(() => btnFlak.removeEventListener('click', onFlakClick));
    }

    // Subsystem Target Select removed: enemy status diagram is display-only.
  }

  /**
   * Binds the virtual thumbstick for gunner view panning.
   *
   * @param {HTMLElement} element
   */
  bindLookThumbstick(element) {
    const maxRadius = 45;
    const knob = element.querySelector('.stick-knob');
    let touchId = null;

    const resetKnob = () => {
      touchId = null;
      this.lookStickVec = { x: 0, y: 0 };
      if (knob) knob.style.transform = 'translate3d(0px, 0px, 0)';
    };

    const updateStick = (clientX, clientY, startX, startY) => {
      const dx = clientX - startX;
      const dy = clientY - startY;
      const dist = Math.hypot(dx, dy);
      const clampedDist = Math.min(dist, maxRadius);
      const angle = Math.atan2(dy, dx);
      const clampedX = Math.cos(angle) * clampedDist;
      const clampedY = Math.sin(angle) * clampedDist;

      if (knob) {
        knob.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
      }

      this.lookStickVec = {
        x: clampedX / maxRadius,
        y: clampedY / maxRadius,
      };
    };

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e) => {
      if (!this.canHandleInput()) return;
      if (touchId !== null) return;
      e.preventDefault();
      const touch = e.changedTouches[0];
      touchId = touch.identifier;

      const rect = element.getBoundingClientRect();
      startX = rect.left + rect.width / 2;
      startY = rect.top + rect.height / 2;
      updateStick(touch.clientX, touch.clientY, startX, startY);
    };

    const onTouchMove = (e) => {
      if (touchId === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === touchId) {
          e.preventDefault();
          updateStick(touch.clientX, touch.clientY, startX, startY);
          break;
        }
      }
    };

    const onTouchEnd = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === touchId) {
          e.preventDefault();
          resetKnob();
          break;
        }
      }
    };

    element.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    this._listeners.push(() => {
      element.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    });
  }

  /**
   * Unbinds all registered DOM listeners.
   */
  destroy() {
    this.isPinchZooming = false;
    this._pinchStartDist = 0;
    this.isLookingDrag = false;
    this.isPointerFiring = false;
    this.isFiringLaser = false;
    this.railgunPointerCharging = false;
    this.pendingRailgunAutoFire = false;
    this.isChargingRailgun = false;
    this.sound?.stopRailgunCharge?.(true);
    for (const unbind of this._listeners) {
      unbind();
    }
    this._listeners = [];
    this.bound = false;
  }

  /**
   * Handles mouse movement over canvas to update aim angle in world space.
   */
  handleMouseMove(e, canvas) {
    if (!this.canHandleInput()) return;
    this.handlePointAim(e.clientX, e.clientY, canvas);
  }

  /**
   * Converts viewport client coordinates to world coordinates and computes aim angle.
   */
  handlePointAim(clientX, clientY, canvas) {
    this.computeAimAngleFromScreen(clientX, clientY, canvas);
    this.send({
      type: 'weapons_input',
      aimAngle: this.aimAngle,
      aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
    });
  }

  /**
   * Handles mouse down events for firing.
   */
  handleMouseDown(e) {
    if (!this.canHandleInput()) return;
    if (e.target && e.target.id !== 'space-canvas') return;

    if (e.button === 0) {
      this.handlePointerFireStart(e.clientX, e.clientY);
    } else if (e.button === 2) {
      e.preventDefault();
      this.isLookingDrag = true;
      this.lookDragStart = { x: e.clientX, y: e.clientY };
    }
  }

  /**
   * Handles mouse up events for releasing weapon triggers.
   */
  handleMouseUp(e) {
    if (e.button === 0) {
      this.handlePointerFireEnd();
    } else if (e.button === 2) {
      this.isLookingDrag = false;
    }
  }

  /**
   * Handles keyboard weapon triggers.
   */
  handleKeyDown(e) {
    if (!this.canHandleInput()) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
      return;
    }

    if (e.repeat && ['ShiftLeft', 'ShiftRight', 'Space', 'KeyT', 'KeyF'].includes(e.code)) {
      return;
    }

    if (e.code === 'Digit1') {
      e.preventDefault();
      this.selectWeapon('laser');
      return;
    }
    if (e.code === 'Digit2') {
      e.preventDefault();
      this.selectWeapon('railgun');
      return;
    }
    if (e.code === 'Digit3') {
      e.preventDefault();
      this.selectWeapon('torpedo');
      return;
    }
    if (e.code === 'Digit4') {
      e.preventDefault();
      this.selectWeapon('flak');
      return;
    }

    if (e.code === 'KeyC') {
      e.preventDefault();
      this.recenterView();
      return;
    }

    if (e.code in this.lookKeys) {
      this.lookKeys[e.code] = true;
    }

    if (e.code === 'Space') {
      const consoleWeapons = typeof document !== 'undefined' ? document.getElementById('console-weapons') : null;
      if (!consoleWeapons || consoleWeapons.classList.contains('active')) {
        e.preventDefault();
        this.setLaserFiring(true);
      }
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (this.canReleaseRailgun()) {
        e.preventDefault();
        this.releaseRailgun();
      } else if (!this.isChargingRailgun) {
        e.preventDefault();
        this.startRailgunCharge();
      }
    } else if (e.code === 'KeyT') {
      e.preventDefault();
      this.launchTorpedo();
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      this.fireFlak();
    }
  }

  /**
   * Handles keyboard key releases.
   */
  handleKeyUp(e) {
    if (e.code in this.lookKeys) {
      this.lookKeys[e.code] = false;
    }

    if (e.code === 'Space') {
      const wasFiring = this.isFiringLaser || this.isPointerFiring;
      this.isPointerFiring = false;
      if (!this.canHandleInput() || !this.areWeaponsPermitted()) {
        this.isFiringLaser = false;
      } else if (wasFiring) {
        this.setLaserFiring(false);
      }
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      const wasCharging = this.isChargingRailgun || this.railgunPointerCharging;
      this.railgunPointerCharging = false;
      this.pendingRailgunAutoFire = false;
      if (!this.canHandleInput() || !this.areWeaponsPermitted()) {
        this.isChargingRailgun = false;
        this.sound?.stopRailgunCharge?.(true);
      } else if (wasCharging) {
        this.releaseRailgun();
      }
    }
  }

  /**
   * Sets twin pulse laser firing state.
   */
  setLaserFiring(firing) {
    if (!firing) {
      this.isFiringLaser = false;
      const battleEnded = Boolean(
        this._isOutcomeOverlayVisible() ||
        this.latestSnapshot?.replayActive ||
        ['gameover', 'game_over', 'restarting'].includes(this.latestSnapshot?.state)
      );
      if (!battleEnded) {
        this.send({
          type: 'weapons_input',
          fireLaser: false,
          aimAngle: this.aimAngle,
          aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
        });
      }
      return;
    }

    if (!this.canHandleInput() || !this.areWeaponsPermitted() || !this.canFireLaser()) {
      this.isFiringLaser = false;
      return;
    }

    this.isFiringLaser = true;
    this.send({
      type: 'weapons_input',
      fireLaser: true,
      aimAngle: this.aimAngle,
      aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
    });
    // Fire sound plays from the authoritative laser_fired event so every crew station hears it once.
  }

  /**
   * Starts charging heavy railgun.
   */
  startRailgunCharge() {
    if (!this.canHandleInput() || !this.areWeaponsPermitted() || !this.canChargeRailgun()) {
      this.isChargingRailgun = false;
      this.sound?.stopRailgunCharge?.(true);
      return;
    }

    const wasCharging = Boolean(this.isChargingRailgun);
    this.isChargingRailgun = true;
    this.send({
      type: 'weapons_input',
      startRailgunCharge: true,
      aimAngle: this.aimAngle,
      aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
    });
    if (!wasCharging && this.sound && typeof this.sound.playRailgunCharge === 'function') {
      this.sound.playRailgunCharge();
    }
  }

  /**
   * Releases heavy railgun slug.
   */
  releaseRailgun() {
    this.sound?.stopRailgunCharge?.();
    const wasCharging = Boolean(this.isChargingRailgun);
    this.isChargingRailgun = false;

    if (!this.canHandleInput() || !this.areWeaponsPermitted()) {
      const battleEnded = Boolean(
        this._isOutcomeOverlayVisible() ||
        this.latestSnapshot?.replayActive ||
        ['gameover', 'game_over', 'restarting', 'lobby'].includes(this.latestSnapshot?.state) ||
        (this._lastShip && (this._lastShip.destroyed === true || (typeof this._lastShip.hullHp === 'number' && this._lastShip.hullHp <= 0)))
      );
      if (wasCharging && !battleEnded) {
        this.send({ type: 'weapons_input', stopRailgunCharge: true });
      }
      return;
    }

    if ((wasCharging || (this._lastShip?.weapons?.chargeProgress ?? 0) >= 1.0) && this.canReleaseRailgun()) {
      this.send({
        type: 'weapons_input',
        releaseRailgun: true,
        aimAngle: this.aimAngle,
        aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
      });
    }
    // Railgun crack plays from the authoritative railgun_fired event for all crew stations.
  }

  /**
   * Launches homing torpedo.
   */
  launchTorpedo() {
    if (!this.canHandleInput() || !this.areWeaponsPermitted() || !this.canLaunchTorpedo()) return;
    this.send({
      type: 'weapons_input',
      launchTorpedo: true,
      aimAngle: this.aimAngle,
      aimPitch: this.aimPitch !== undefined ? this.aimPitch : this.getGunnerAimPitch(),
    });
    // Launch sound plays from the authoritative torpedo_launched event for all crew stations.
  }

  /**
   * Fires point-defense flak.
   */
  fireFlak() {
    if (!this.canHandleInput() || !this.areWeaponsPermitted() || !this.canFireFlak()) return;
    this.send({
      type: 'weapons_input',
      fireFlak: true,
    });
    // Burst sound plays from the authoritative flak_burst event for all crew stations.
  }

  /**
   * Returns current velocity-inherited target lead reticle coordinates.
   */
  getLeadReticle() {
    return this.leadReticle;
  }

  /**
   * Updates relative enemy vector HUD overlay for Weapons station.
   * Uses gunner's current world viewing angle so relative bearing aligns with camera look.
   *
   * @param {object} ship - Player's ship snapshot
   * @param {object} enemyShip - Opponent's ship snapshot
   */
  updateEnemyVector(ship, enemyShip) {
    if (typeof document === 'undefined') return;

    const card = document.getElementById('weapons-enemy-vector');
    const statusEl = document.getElementById('weapons-enemy-status');
    const arrowEl = document.getElementById('weapons-enemy-arrow');
    const bearingEl = document.getElementById('weapons-enemy-bearing');
    const velocityEl = document.getElementById('weapons-enemy-velocity');

    if (!card) return;

    const isEnemyInWarp = enemyShip?.hyperspace?.state === 'jumping';
    const isSensorsOffline = ship?.sensorsOnline === false;
    const isObscured = !ship ||
      isSensorsOffline ||
      ship.targetAvailable === false ||
      isEnemyInWarp ||
      ship.inNebula === true ||
      ship.targetHiddenInNebula === true ||
      ship.enemyHidden === true ||
      ship.enemyHiddenInNebula === true ||
      !enemyShip ||
      enemyShip.inNebula === true ||
      enemyShip.enemyHiddenInNebula === true ||
      enemyShip.destroyed === true ||
      !enemyShip.pos;

    if (isObscured) {
      card.classList.add('obscured');
      let statusText = 'SIGNAL OBSCURED / NEBULA';
      if (isSensorsOffline) {
        statusText = 'TARGETING OFFLINE — REBOOTING';
      } else if (isEnemyInWarp) {
        statusText = 'TARGET IN WARP';
      } else if (ship?.targetAvailable === false) {
        statusText = 'NO TARGET LOCK';
      } else if (enemyShip?.destroyed) {
        statusText = 'TARGET DESTROYED';
      }
      if (statusEl) statusEl.textContent = statusText;
      if (bearingEl) bearingEl.textContent = 'BRG ---° | ELV --° | RNG ----m';
      if (velocityEl) velocityEl.textContent = 'VEL --- m/s | HDG ---° | CLS --- m/s';
      if (arrowEl) arrowEl.style.transform = '';
      return;
    }

    card.classList.remove('obscured');
    if (statusEl) statusEl.textContent = 'TRACKING';

    const dx = enemyShip.pos.x - ship.pos.x;
    const dy = enemyShip.pos.y - ship.pos.y;
    const dz = (enemyShip.pos.z || 0) - (ship.pos.z || 0);

    const enemyAngle = Math.atan2(dy, dx);
    const viewAngle = this.getGunnerWorldAngle(ship);
    const relYaw = this.normalizeAngle(enemyAngle - viewAngle);
    const distHoriz = Math.hypot(dx, dy);
    const rng = Math.hypot(dx, dy, dz);
    const elvDeg = Math.round(Math.atan2(dz, Math.max(1, distHoriz)) * 180 / Math.PI);

    // Rotate arrow relative to gunner's current view
    const arrowDeg = (relYaw * 180 / Math.PI).toFixed(1);
    if (arrowEl) {
      arrowEl.style.transform = `rotate(${arrowDeg}deg)`;
    }

    const relBrgDeg = Math.round((((relYaw * 180 / Math.PI) % 360) + 360) % 360).toString().padStart(3, '0');
    const elvSign = elvDeg >= 0 ? '+' : '-';
    if (bearingEl) {
      bearingEl.textContent = `BRG ${relBrgDeg}° | ELV ${elvSign}${Math.abs(elvDeg)}° | RNG ${Math.round(rng)}m`;
    }

    const evx = enemyShip.vel?.x || 0;
    const evy = enemyShip.vel?.y || 0;
    const evz = enemyShip.vel?.z || 0;
    const vel = Math.hypot(evx, evy, evz);
    const hdg = (((Math.atan2(evy, evx) * 180 / Math.PI) % 360) + 360) % 360;

    const mvx = ship.vel?.x || 0;
    const mvy = ship.vel?.y || 0;
    const mvz = ship.vel?.z || 0;
    const closing = -((evx - mvx) * dx + (evy - mvy) * dy + (evz - mvz) * dz) / Math.max(1, rng);

    const hdgDeg = Math.round(hdg).toString().padStart(3, '0');
    const clsSign = closing >= 0 ? '+' : '';
    if (velocityEl) {
      velocityEl.textContent = `VEL ${Math.round(vel)} m/s | HDG ${hdgDeg}° | CLS ${clsSign}${Math.round(closing)} m/s`;
    }
  }

  /**
   * Updates weapons HUD elements from latest ship and target snapshot.
   *
   * @param {object} ship - Player's ship snapshot
   * @param {object} [enemyShip] - Opponent's ship snapshot
   */
  updateHUD(ship, enemyShip) {
    if (!ship) return;

    if (enemyShip !== undefined) {
      this._lastEnemyShip = enemyShip;
    }
    this._lastShip = ship;
    const currentEnemyShip = enemyShip || this._lastEnemyShip || null;

    this.latestSnapshot = {
      ...(this.latestSnapshot || {}),
      ships: {
        ...(this.latestSnapshot?.ships || {}),
        [ship.team || this.myTeam]: ship,
        ...(currentEnemyShip ? { [currentEnemyShip.team || (this.myTeam === 'alpha' ? 'omega' : 'alpha')]: currentEnemyShip } : {}),
      },
    };

    // Suppress firing / charging commands and clean up SFX if weapons are not permitted
    if (!this.areWeaponsPermitted(ship)) {
      const wasCharging = this.isChargingRailgun || this.railgunPointerCharging;
      this.isFiringLaser = false;
      this.isPointerFiring = false;
      this.railgunPointerCharging = false;
      this.pendingRailgunAutoFire = false;
      this.isChargingRailgun = false;
      this.sound?.stopRailgunCharge?.(true);

      const battleEnded = Boolean(
        this._isOutcomeOverlayVisible() ||
        this.latestSnapshot?.replayActive ||
        ['gameover', 'game_over', 'restarting', 'lobby'].includes(this.latestSnapshot?.state) ||
        ship.destroyed === true ||
        (typeof ship.hullHp === 'number' && ship.hullHp <= 0)
      );
      if (wasCharging && !battleEnded) {
        this.send({ type: 'weapons_input', stopRailgunCharge: true });
      }
    }

    if (typeof document === 'undefined') {
      const isSensorsOffline = ship.sensorsOnline === false;
      const isEnemyInWarp = currentEnemyShip?.hyperspace?.state === 'jumping';
      if (!isSensorsOffline && !isEnemyInWarp && currentEnemyShip && currentEnemyShip.pos && !currentEnemyShip.destroyed && ship.targetAvailable !== false) {
        this.leadReticle = calculateLeadTarget(ship.pos, ship.vel, currentEnemyShip.pos, currentEnemyShip.vel, 600);
      } else {
        this.leadReticle = null;
      }
      return;
    }

    const powerMap = ship.powerMap || {};
    const weapons = ship.weapons || {};
    const thermal = ship.thermal || {};

    // 1. Enemy Vector Overlay
    this.updateEnemyVector(ship, currentEnemyShip);

    // 2. Calculate Target Lead Reticle (laser speed: 600 m/s)
    const isSensorsOffline = ship.sensorsOnline === false;
    const isEnemyInWarp = currentEnemyShip?.hyperspace?.state === 'jumping';
    if (!isSensorsOffline && !isEnemyInWarp && currentEnemyShip && currentEnemyShip.pos && !currentEnemyShip.destroyed && ship.targetAvailable !== false) {
      this.leadReticle = calculateLeadTarget(
        ship.pos,
        ship.vel,
        currentEnemyShip.pos,
        currentEnemyShip.vel,
        600
      );
    } else {
      this.leadReticle = null;
    }

    // 3. Pulse Laser Heat Bar, Status & Offline/Overheat Alerts
    const heat = weapons.heat || 0;
    const maxHeat = weapons.maxHeat || 100;
    const heatPct = Math.min(100, Math.max(0, (heat / maxHeat) * 100));

    const heatBar = document.getElementById('laser-heat-bar');
    if (heatBar) {
      heatBar.style.width = `${heatPct}%`;
      if (weapons.overheated) {
        heatBar.classList.add('overheated');
      } else {
        heatBar.classList.remove('overheated');
      }
    }

    const heatFill = document.getElementById('laser-heat-fill');
    if (heatFill) {
      heatFill.style.width = `${heatPct}%`;
    }

    const laserOffline = (powerMap.weapons_laser ?? 1) <= 0 || (weapons.laserHealth ?? 100) <= 0;
    const btnSelectLaser = document.getElementById('btn-select-laser');
    const rowLaser = document.getElementById('weapon-row-laser');
    const heatText = document.getElementById('laser-heat-text');
    const btnLaser = document.getElementById('btn-fire-laser');

    if (btnLaser) {
      btnLaser.disabled = !this.canFireLaser(ship);
    }

    if (laserOffline) {
      btnSelectLaser?.classList.add('alert-flash-red');
      rowLaser?.classList.add('alert-flash-red');
      rowLaser?.classList.remove('alert-flash-yellow');
      if (heatText) {
        heatText.textContent = (powerMap.weapons_laser ?? 1) <= 0 ? 'LASER NO POWER' : 'LASER OFFLINE';
        heatText.classList.add('text-alert');
      }
    } else {
      btnSelectLaser?.classList.remove('alert-flash-red');
      rowLaser?.classList.remove('alert-flash-red');
      if (weapons.overheated) {
        if (heatText) {
          heatText.textContent = 'OVERHEATED (REDUCED RATE)';
          heatText.classList.add('text-alert');
        }
        rowLaser?.classList.add('alert-flash-yellow');
      } else {
        rowLaser?.classList.remove('alert-flash-yellow');
        if (heatText) {
          heatText.textContent = `HEAT: ${Math.round(heat)} / ${maxHeat}`;
          heatText.classList.remove('text-alert');
        }
      }
    }

    // 4. Railgun Charge Bar, Status, Mechanical Jam & Capacitor Charged Bypass Alerts
    const chargePct = Math.min(100, Math.round((weapons.chargeProgress || 0) * 100));
    const railBar = document.getElementById('railgun-charge-bar');
    if (railBar) {
      railBar.style.width = `${chargePct}%`;
    }

    const railFill = document.getElementById('railgun-charge-fill');
    if (railFill) {
      railFill.style.width = `${chargePct}%`;
    }

    const railgunHasPower = (powerMap.weapons_railgun ?? 1) > 0;
    const railgunHealthy = (weapons.railgunHealth ?? 100) > 0 && !weapons.railgunJammed;
    const railgunCharged = (weapons.chargeProgress ?? 0) >= 1.0;
    const btnSelectRailgun = document.getElementById('btn-select-railgun');
    const rowRailgun = document.getElementById('weapon-row-railgun');
    const railgunSlewEl = document.getElementById('railgun-slew-status');
    const barrelReticle = document.getElementById('railgun-barrel-reticle');
    const reticleStatus = document.getElementById('railgun-reticle-status');
    const btnRailgun = document.getElementById('btn-railgun-charge');

    if (btnRailgun) {
      btnRailgun.disabled = !this.canChargeRailgun(ship) && !this.canReleaseRailgun(ship);
    }

    if (!railgunHealthy || (!railgunHasPower && !railgunCharged)) {
      btnSelectRailgun?.classList.add('alert-flash-red');
      btnSelectRailgun?.classList.remove('alert-flash-yellow');
      rowRailgun?.classList.add('alert-flash-red');
      rowRailgun?.classList.remove('alert-flash-yellow');

      if (reticleStatus) {
        if (weapons.railgunJammed) {
          reticleStatus.textContent = 'JAMMED';
          reticleStatus.className = 'reticle-status-tag alert';
        } else if (!railgunHealthy) {
          reticleStatus.textContent = 'DAMAGED';
          reticleStatus.className = 'reticle-status-tag alert';
        } else {
          reticleStatus.textContent = 'NO POWER';
          reticleStatus.className = 'reticle-status-tag alert';
        }
      }
    } else if (!railgunHasPower && railgunCharged) {
      // Capacitor Charged Bypass!
      btnSelectRailgun?.classList.add('alert-flash-yellow');
      btnSelectRailgun?.classList.remove('alert-flash-red');
      rowRailgun?.classList.add('alert-flash-yellow');
      rowRailgun?.classList.remove('alert-flash-red');

      if (reticleStatus) {
        reticleStatus.textContent = 'CHARGED (NO PWR)';
        reticleStatus.className = 'reticle-status-tag warning';
      }
    } else if (weapons.railgunOverheated || thermal.railgun?.overheated) {
      btnSelectRailgun?.classList.remove('alert-flash-red', 'alert-flash-yellow');
      rowRailgun?.classList.add('alert-flash-yellow');
      rowRailgun?.classList.remove('alert-flash-red');
    } else {
      btnSelectRailgun?.classList.remove('alert-flash-red', 'alert-flash-yellow');
      rowRailgun?.classList.remove('alert-flash-red', 'alert-flash-yellow');
    }

    if (weapons.railgunJammed) {
      if (railgunSlewEl) {
        railgunSlewEl.textContent = 'JAMMED';
        railgunSlewEl.className = 'status-badge alert danger';
      }
      if (barrelReticle) {
        barrelReticle.classList.add('jammed');
        barrelReticle.classList.remove('slewing');
      }
      if (reticleStatus && !(!railgunHealthy || (!railgunHasPower && !railgunCharged))) {
        reticleStatus.textContent = 'JAMMED';
        reticleStatus.className = 'reticle-status-tag alert';
      }
    } else {
      const barrelAngle = weapons.railgunAngle ?? ship.angle ?? 0;
      const targetAngle = this.aimAngle || this.getGunnerWorldAngle(ship);
      const angleDiff = Math.abs(this.normalizeAngle(barrelAngle - targetAngle));
      const isSlewing = angleDiff > 0.05;

      if (railgunSlewEl) {
        if (isSlewing) {
          railgunSlewEl.textContent = 'SLEWING';
          railgunSlewEl.className = 'status-badge warning';
        } else {
          railgunSlewEl.textContent = 'ALIGNED';
          railgunSlewEl.className = 'status-badge nominal';
        }
      }

      if (barrelReticle) {
        if (isSlewing) {
          barrelReticle.classList.add('slewing');
          barrelReticle.classList.remove('jammed');
        } else {
          barrelReticle.classList.remove('slewing', 'jammed');
        }
      }

      if (reticleStatus) {
        if (!railgunHealthy || (!railgunHasPower && !railgunCharged)) {
          // Handled above
        } else if (!railgunHasPower && railgunCharged) {
          // 'CHARGED (NO PWR)' handled above
        } else {
          reticleStatus.textContent = isSlewing ? 'SLEWING' : 'READY';
          reticleStatus.className = `reticle-status-tag ${isSlewing ? 'warning' : 'nominal'}`;
        }
      }
    }

    // 5. View Stabilizer / Free-Look Status & Alerts
    const stabEl = document.getElementById('stabilizer-status');
    const sHealth = weapons.stabilizerHealth ?? 100;
    const sPowered = weapons.stabilizerPowered ?? true;
    const sasOffline = sPowered === false || sHealth <= 0;
    const lookPanel = document.getElementById('weapons-look-panel');

    if (lookPanel) {
      if (sasOffline) {
        lookPanel.classList.add('alert-flash-red');
        lookPanel.classList.remove('alert-flash-yellow');
      } else if (ship.thermal?.sas?.overheated) {
        lookPanel.classList.remove('alert-flash-red');
        lookPanel.classList.add('alert-flash-yellow');
      } else {
        lookPanel.classList.remove('alert-flash-red', 'alert-flash-yellow');
      }
    }

    if (stabEl) {
      if (!sPowered) {
        stabEl.textContent = 'STABILIZER UNPOWERED';
        stabEl.className = 'status-badge alert';
      } else if (sHealth < 100) {
        stabEl.textContent = `STABILIZER ${Math.round(sHealth)}%`;
        stabEl.className = 'status-badge warning';
      } else {
        stabEl.textContent = 'STABILIZER 100%';
        stabEl.className = 'status-badge nominal';
      }
    }

    // 6. Torpedo Magazine Rack & Alerts
    const torpOffline = (powerMap.weapons_torpedo ?? 1) <= 0;
    const btnSelectTorp = document.getElementById('btn-select-torpedo');
    const rowTorp = document.getElementById('weapon-row-torpedo');

    if (torpOffline) {
      btnSelectTorp?.classList.add('alert-flash-red');
      rowTorp?.classList.add('alert-flash-red');
      rowTorp?.classList.remove('alert-flash-yellow');
    } else if (weapons.torpedoOverheated || thermal.torpedo?.overheated) {
      btnSelectTorp?.classList.remove('alert-flash-red');
      rowTorp?.classList.remove('alert-flash-red');
      rowTorp?.classList.add('alert-flash-yellow');
    } else {
      btnSelectTorp?.classList.remove('alert-flash-red');
      rowTorp?.classList.remove('alert-flash-red', 'alert-flash-yellow');
    }

    const mag = weapons.magazine ?? 0;
    const maxMag = weapons.maxMagazine ?? 8;

    const torpCountEl = document.getElementById('torpedo-count');
    if (torpCountEl) {
      torpCountEl.textContent = String(mag);
    }

    const torpText = document.getElementById('torpedo-count-text');
    if (torpText) {
      torpText.textContent = `MAGAZINE: ${mag} / ${maxMag}`;
    }

    const rackDisplay = document.getElementById('torpedo-rack-display');
    if (rackDisplay && rackDisplay.childElementCount !== maxMag) {
      rackDisplay.innerHTML = '';
      for (let i = 0; i < maxMag; i++) {
        const pip = document.createElement('div');
        pip.className = `torp-pip ${i < mag ? 'loaded' : 'empty'}`;
        rackDisplay.appendChild(pip);
      }
    } else if (rackDisplay) {
      const pips = rackDisplay.children;
      for (let i = 0; i < pips.length; i++) {
        if (i < mag) {
          pips[i].className = 'torp-pip loaded';
        } else {
          pips[i].className = 'torp-pip empty';
        }
      }
    }

    const btnTorp = document.getElementById('btn-launch-torp') || document.getElementById('btn-launch-torpedo');
    if (btnTorp) {
      btnTorp.disabled = !this.canLaunchTorpedo(ship);
    }
    const btnLaunchTorp = document.getElementById('btn-launch-torp');
    if (btnLaunchTorp && btnLaunchTorp !== btnTorp) {
      btnLaunchTorp.disabled = !this.canLaunchTorpedo(ship);
    }
    const btnLaunchTorpedo = document.getElementById('btn-launch-torpedo');
    if (btnLaunchTorpedo && btnLaunchTorpedo !== btnTorp) {
      btnLaunchTorpedo.disabled = !this.canLaunchTorpedo(ship);
    }

    // 7. Flak Cooldown Status
    const btnFlak = document.getElementById('btn-fire-flak');
    const flakCdEl = document.getElementById('flak-cooldown');
    const flakCd = weapons.flakCooldown || 0;

    if (btnFlak) {
      btnFlak.disabled = !this.canFireFlak(ship);
      if (flakCd > 0) {
        btnFlak.textContent = `FLAK RECHARGE (${flakCd.toFixed(1)}s)`;
      } else {
        btnFlak.textContent = 'DETONATE FLAK BURST';
      }
    }

    if (flakCdEl) {
      if (flakCd > 0) {
        flakCdEl.textContent = `${flakCd.toFixed(1)}s`;
        flakCdEl.classList.remove('hidden');
      } else {
        flakCdEl.textContent = 'READY';
      }
    }

    // 8. Enemy vessel status diagram and damaged-systems list
    this.updateEnemyDiagram(currentEnemyShip, ship);
  }

  /**
   * Redraws the top-down enemy diagram and rebuilds the damaged-systems list
   * (the list only re-renders when its content changes).
   *
   * @param {object|null} enemy - Opponent ship snapshot
   * @param {object|null} [myShip=null] - Own ship snapshot for sensor/nebula checks
   */
  updateEnemyDiagram(enemy, myShip = null) {
    if (typeof document === 'undefined') return;
    const report = buildEnemyDamageReport(enemy, myShip);

    const canvas = document.getElementById('enemy-diagram-canvas');
    if (canvas && typeof canvas.getContext === 'function') {
      const ctx = canvas.getContext('2d');
      if (ctx) drawEnemyDiagram(ctx, canvas.width, canvas.height, report, enemy);
    }

    const listEl = document.getElementById('enemy-damage-list');
    if (listEl) {
      const key = JSON.stringify(report.systems);
      if (this._enemyListKey !== key) {
        this._enemyListKey = key;
        listEl.innerHTML = '';
        for (const sys of report.systems) {
          const li = document.createElement('li');
          li.className = sys.status;
          const name = document.createElement('span');
          name.textContent = sys.label;
          const state = document.createElement('span');
          state.textContent = sys.text;
          li.appendChild(name);
          li.appendChild(state);
          listEl.appendChild(li);
        }
      }
    }
  }
}

const ENEMY_SHIELD_KEYS = ['fore', 'aft', 'port', 'starboard'];

/**
 * Builds a display-ready damage report for an enemy ship snapshot.
 *
 * @param {object|null} enemy
 * @param {object|null} [myShip=null]
 * @returns {{signal: boolean, obscured: boolean, hullPct: number, shields: object, systems: Array<{label: string, status: string, text: string}>}}
 */
export function buildEnemyDamageReport(enemy, myShip = null) {
  const empty = {
    signal: false,
    obscured: false,
    hullPct: 0,
    shields: {},
    systems: [{ label: 'NO TARGET SIGNAL', status: 'offline', text: '--' }],
  };
  if (myShip?.sensorsOnline === false) {
    return {
      ...empty,
      obscured: true,
      systems: [{ label: 'TARGETING OFFLINE — REBOOTING', status: 'offline', text: '--' }],
    };
  }
  if (enemy?.hyperspace?.state === 'jumping') {
    return {
      ...empty,
      obscured: true,
      systems: [{ label: 'TARGET IN WARP', status: 'offline', text: '--' }],
    };
  }
  if (enemy?.destroyed) {
    return {
      ...empty,
      systems: [{ label: 'TARGET DESTROYED', status: 'offline', text: '--' }],
    };
  }
  const obscured = Boolean(
    myShip?.targetAvailable === false ||
    myShip?.inNebula === true ||
    myShip?.targetHiddenInNebula === true ||
    myShip?.enemyHidden === true ||
    myShip?.enemyHiddenInNebula === true ||
    enemy?.inNebula === true ||
    enemy?.enemyHiddenInNebula === true
  );
  if (obscured) {
    return {
      ...empty,
      obscured: true,
      systems: [{ label: 'SIGNAL OBSCURED / NEBULA', status: 'offline', text: '--' }],
    };
  }
  if (!enemy) return empty;

  const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((v / max) * 100))) : 0);
  const shields = {};
  for (const key of ENEMY_SHIELD_KEYS) {
    const hp = enemy.shields?.hp?.[key] ?? 0;
    const max = enemy.shields?.maxHp?.[key] ?? 100;
    const online = enemy.shields?.online ? enemy.shields.online[key] !== false : true;
    shields[key] = { pct: online ? pct(hp, max) : 0, online };
  }

  const systems = [];
  if (enemy.reactorOnline === false) {
    systems.push({ label: 'REACTOR', status: 'offline', text: 'OFFLINE' });
  }

  const reportSystem = (label, { health, jammed = false, overheated = false, unpowered = false } = {}) => {
    if (health !== undefined && health !== null && health <= 0) {
      systems.push({ label, status: 'offline', text: 'OFFLINE' });
      return;
    }
    const flags = [];
    if (jammed) flags.push('JAMMED');
    if (unpowered) flags.push('UNPOWERED');
    if (overheated) flags.push('OVERHEATED');

    const hasDmg = health !== undefined && health !== null && health < 100;
    if (flags.length > 0 && hasDmg) {
      systems.push({ label, status: 'offline', text: `${flags[0]} ${Math.round(health)}%` });
    } else if (flags.length > 0) {
      const sev = jammed || unpowered ? 'offline' : 'warning';
      systems.push({ label, status: sev, text: flags.join(' / ') });
    } else if (hasDmg && health <= 50) {
      systems.push({ label, status: 'offline', text: `CRITICAL ${Math.round(health)}%` });
    } else if (hasDmg) {
      systems.push({ label, status: 'warning', text: `DAMAGED ${Math.round(health)}%` });
    }
  };

  reportSystem('MAIN DRIVE', {
    health: enemy.mainDrive?.health,
    overheated: Boolean(enemy.mainDrive?.overheated || enemy.thermal?.mainDrive?.overheated),
    unpowered: enemy.powerMap?.main_drive !== undefined && enemy.powerMap.main_drive <= 0,
  });

  const thrusters = Object.values(enemy.thrusters || {});
  const rcsOverheated = Boolean(enemy.thermal?.rcs?.overheated);
  const rcsUnpowered = enemy.powerMap?.rcs_thrusters !== undefined && enemy.powerMap.rcs_thrusters <= 0;
  if (thrusters.length) {
    const down = thrusters.filter((t) => (t?.health ?? 100) <= 0).length;
    const hurt = thrusters.filter((t) => (t?.health ?? 100) < 100).length;
    if (down === thrusters.length) systems.push({ label: 'RCS THRUSTERS', status: 'offline', text: 'OFFLINE' });
    else if (down > 0) systems.push({ label: 'RCS THRUSTERS', status: 'offline', text: `${down}/${thrusters.length} DOWN` });
    else if (rcsUnpowered) systems.push({ label: 'RCS THRUSTERS', status: 'offline', text: 'UNPOWERED' });
    else if (rcsOverheated) systems.push({ label: 'RCS THRUSTERS', status: 'warning', text: 'OVERHEATED' });
    else if (hurt > 0) systems.push({ label: 'RCS THRUSTERS', status: 'warning', text: 'DAMAGED' });
  } else if (rcsUnpowered || rcsOverheated) {
    reportSystem('RCS THRUSTERS', { overheated: rcsOverheated, unpowered: rcsUnpowered });
  }

  reportSystem('PULSE LASERS', {
    health: enemy.weapons?.laserHealth,
    overheated: Boolean(enemy.weapons?.overheated || enemy.thermal?.laser?.overheated),
    unpowered: enemy.powerMap?.weapons_laser !== undefined && enemy.powerMap.weapons_laser <= 0,
  });

  reportSystem('RAILGUN', {
    health: enemy.weapons?.railgunHealth,
    jammed: Boolean(enemy.weapons?.railgunJammed),
    overheated: Boolean(enemy.weapons?.railgunOverheated || enemy.thermal?.railgun?.overheated),
    unpowered: enemy.powerMap?.weapons_railgun !== undefined && enemy.powerMap.weapons_railgun <= 0,
  });

  reportSystem('TORPEDO TUBE', {
    overheated: Boolean(enemy.weapons?.torpedoOverheated || enemy.thermal?.torpedo?.overheated),
    unpowered: enemy.powerMap?.weapons_torpedo !== undefined && enemy.powerMap.weapons_torpedo <= 0,
  });

  reportSystem('SAS / VIEW STAB', {
    health: enemy.weapons?.stabilizerHealth,
    unpowered: Boolean(
      enemy.weapons?.stabilizerPowered === false ||
      (enemy.powerMap?.sas_computer !== undefined && enemy.powerMap.sas_computer <= 0)
    ),
    overheated: Boolean(enemy.thermal?.sas?.overheated),
  });

  for (const key of ENEMY_SHIELD_KEYS) {
    if (!shields[key].online) {
      systems.push({ label: `${key.toUpperCase()} SHIELD`, status: 'offline', text: 'UNPOWERED' });
    } else if (shields[key].pct <= 0) {
      systems.push({ label: `${key.toUpperCase()} SHIELD`, status: 'offline', text: 'COLLAPSED' });
    }
  }
  if (enemy.thermal?.shields?.overheated) {
    systems.push({ label: 'SHIELD EMITTERS', status: 'warning', text: 'OVERHEATED' });
  }

  let broken = 0;
  for (const row of enemy.grid?.tiles || []) {
    for (const tile of row || []) {
      if (tile?.status === 'broken') broken++;
    }
  }
  if (broken > 0) systems.push({ label: 'POWER CONDUITS', status: 'warning', text: `${broken} BROKEN` });

  if (systems.length === 0) systems.push({ label: 'ALL SYSTEMS', status: 'nominal', text: 'NOMINAL' });

  const hullPct = pct(enemy.hullHp ?? 0, enemy.maxHullHp ?? 1000);
  return { signal: true, obscured: false, hullPct, shields, systems };
}

/**
 * Draws the top-down enemy diagram (nose up): hull silhouette tinted by hull integrity,
 * four shield arcs colored by strength, and engine glow state.
 */
export function drawEnemyDiagram(ctx, width, height, report, enemy) {
  ctx.clearRect(0, 0, width, height);
  if (!report.signal) {
    ctx.fillStyle = report.obscured ? '#f59e0b' : '#64748b';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = report.obscured ? 'NEBULA OBSCURED' : (enemy?.destroyed ? 'TARGET DESTROYED' : 'NO SIGNAL');
    ctx.fillText(msg, width / 2, height / 2);
    return;
  }

  const cx = width / 2;
  const cy = height / 2;
  const baseScale = Math.min(width / 240, height / 190);
  const scaleByClass = { corvette: 0.72, frigate: 0.86, dreadnought: 0.98 };
  const s = (scaleByClass[enemy?.hullClass] || 0.86) * baseScale;
  const rx = 58 * s;
  const ry = 62 * s;

  const strengthColor = (p, online) => {
    if (!online || p <= 0) return '#475569';
    if (p > 66) return '#38bdf8';
    if (p > 33) return '#f59e0b';
    return '#ef4444';
  };

  // Shield arcs: nose up, so fore = top, aft = bottom, port = left, starboard = right.
  const arcs = [
    { key: 'fore', a0: -Math.PI * 0.75, a1: -Math.PI * 0.25, lx: cx, ly: Math.max(10, cy - ry - 13) },
    { key: 'starboard', a0: -Math.PI * 0.25, a1: Math.PI * 0.25, lx: Math.min(width - 20, cx + rx + 18), ly: cy },
    { key: 'aft', a0: Math.PI * 0.25, a1: Math.PI * 0.75, lx: cx, ly: Math.min(height - 10, cy + ry + 13) },
    { key: 'port', a0: Math.PI * 0.75, a1: Math.PI * 1.25, lx: Math.max(20, cx - rx - 18), ly: cy },
  ];
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const arc of arcs) {
    const sh = report.shields[arc.key];
    const color = strengthColor(sh.pct, sh.online);
    ctx.strokeStyle = color;
    ctx.globalAlpha = sh.online && sh.pct > 0 ? 0.35 + 0.65 * (sh.pct / 100) : 0.4;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, arc.a0 + 0.08, arc.a1 - 0.08);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.fillText(sh.online ? `${sh.pct}%` : 'OFF', arc.lx, arc.ly);
  }

  // Hull silhouette (nose up), tinted by hull integrity
  const hullColor = report.hullPct > 66 ? '#94a3b8' : (report.hullPct > 33 ? '#d97706' : '#dc2626');
  ctx.fillStyle = hullColor;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 46 * s);
  ctx.lineTo(cx + 12 * s, cy - 15 * s);
  ctx.lineTo(cx + 26 * s, cy + 12 * s);
  ctx.lineTo(cx + 19 * s, cy + 38 * s);
  ctx.lineTo(cx - 19 * s, cy + 38 * s);
  ctx.lineTo(cx - 26 * s, cy + 12 * s);
  ctx.lineTo(cx - 12 * s, cy - 15 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Engine glow: red if main drive damaged or offline
  const driveHealth = enemy?.mainDrive?.health ?? 100;
  ctx.fillStyle = driveHealth <= 0 ? '#ef4444' : (driveHealth < 100 ? '#f59e0b' : '#38bdf8');
  ctx.fillRect(cx - 10 * s, cy + 38 * s, 20 * s, 5 * s);

  // Hull integrity readout with dark backdrop outline for legibility on narrow hulls
  ctx.font = 'bold 10px monospace';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 3;
  ctx.strokeText(`HULL ${report.hullPct}%`, cx, cy + 3);
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(`HULL ${report.hullPct}%`, cx, cy + 3);
}
