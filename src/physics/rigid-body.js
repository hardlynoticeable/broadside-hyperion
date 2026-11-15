/**
 * BROADSIDE HYPERION — 2D Rigid Body Kinematics & Thruster Dynamics
 * Pure Newtonian mechanics in vacuum: zero linear/angular friction.
 * Real thruster torque (tau = r x F), asymmetric thruster damage,
 * PID-based SAS attitude controller, and 180° roll state management.
 */

import {
  HULL_CLASSES,
  getThrusterMounts,
  MAX_PITCH_RAD,
  MAX_GIMBAL_RAD,
  SHIP_PACING_SCALE,
  MAX_SPIN_RATE,
  clampAngularVelocity,
} from './constants.js';

export { clampAngularVelocity };

/**
 * Computes manual control authority factor [0, 1] given commanded input [-1, 1],
 * current angular rate (rad/s), and maximum allowable manual rate (rad/s).
 * - Full authority (1.0) when braking/reversing opposite to current spin.
 * - Smoothly tapers from 1.0 to 0.0 as rate in the commanded direction approaches maxRate.
 * - Drops to 0.0 if rate exceeds maxRate in the commanded direction.
 */
function getManualRateGovernorFactor(command, currentRate, maxRate) {
  if (Math.abs(command) < 1e-4 || maxRate <= 0) return 1.0;

  // Check if command is in the same direction as current rotation
  const isPushingSpin = (command > 0 && currentRate > 0) || (command < 0 && currentRate < 0);
  if (!isPushingSpin) {
    // Braking or reversing opposite to current spin: 100% full authority!
    return 1.0;
  }

  const speed = Math.abs(currentRate);
  if (speed >= maxRate) {
    return 0.0;
  }

  const taperStart = 0.65 * maxRate;
  if (speed <= taperStart) {
    return 1.0;
  }

  const t = (speed - taperStart) / (maxRate - taperStart);
  // Smooth Hermite interpolation (3*t^2 - 2*t^3)
  return Math.max(0, Math.min(1, 1.0 - (3 * t * t - 2 * t * t * t)));
}

export class RigidBody {
  /**
   * @param {string|object} hullClassKey - 'corvette' | 'frigate' | 'dreadnought' or config
   * @param {object} [options={}] - initial position, velocity, angle, omega, modules
   */
  constructor(hullClassKey = 'corvette', options = {}) {
    this.hullClassKey = typeof hullClassKey === 'string' ? hullClassKey : 'corvette';
    this.hull = typeof hullClassKey === 'object' && hullClassKey !== null
      ? hullClassKey
      : (HULL_CLASSES[this.hullClassKey] || HULL_CLASSES.corvette);

    // Position and orientation
    this.pos = { x: options.x ?? 0, y: options.y ?? 0, z: options.z ?? 0 };
    this.vel = { x: options.vx ?? 0, y: options.vy ?? 0, z: options.vz ?? 0 };
    this.angle = options.angle ?? 0; // radians (0 = facing East +X)
    this.omega = options.omega ?? 0; // angular rate (rad/s)
    this.pitch = options.pitch ?? 0;
    this.pitchOmega = options.pitchOmega ?? 0;

    // Mass properties from hull spec
    this.mass = options.mass ?? this.hull.mass;
    this.inertia = options.inertia ?? this.hull.momentOfInertia;
    this.pitchInertia = options.pitchInertia ?? (this.hull.pitchInertia || this.inertia * 0.9);
    this.length = options.length ?? this.hull.length;
    this.width = options.width ?? this.hull.width;
    this.rcsThrust = options.rcsThrust ?? this.hull.rcsThrust;
    this.mainThrust = options.mainThrust ?? this.hull.mainThrust;
    this.armor = options.armor ?? this.hull.armor;
    this.maxHullHp = options.maxHullHp ?? this.hull.maxHullHp;
    this.hullHp = options.hullHp ?? this.maxHullHp;

    // Manual angular rate governors (rad/s)
    this.maxManualYawRate = options.maxManualYawRate ?? this.hull.maxManualYawRate ?? 0.72;
    this.maxManualPitchRate = options.maxManualPitchRate ?? this.hull.maxManualPitchRate ?? 0.60;
    this.maxManualRollRate = options.maxManualRollRate ?? this.hull.maxManualRollRate ?? 1.08;

    // Physical roll properties
    this.rollInertia = options.rollInertia ?? this.hull.rollMomentOfInertia ?? ((1 / 6) * this.mass * this.width * this.width);
    this.rollAngle = options.rollAngle ?? (options.rollState === 1 ? Math.PI : 0);
    this.rollOmega = options.rollOmega ?? 0;
    this.stopRollActive = Boolean(options.stopRollActive);
    this.manualRollCommanded = false;
    this.manualPitchCommanded = false;
    this.autoOrientMode = options.autoOrientMode || null;
    this.turnAndBurn = false;

    // Drydock loadout modules
    this.modules = options.modules || {
      helm: 'overdrive_rcs',
      weapons: 'heavy_torpedoes',
      engineer: 'standard_drones',
    };

    // Stability Augmentation System (SAS)
    this.sasActive = options.sasActive !== undefined ? Boolean(options.sasActive) : true;
    this.sasPid = {
      kp: 8.0,
      kd: 0.5,
      ki: 0.1,
      integralError: 0,
    };
    this.sasPitchPid = {
      kp: 6.0,
      ki: 0.5,
      kd: 0.0,
      integralError: 0,
    };
    this.manualTurnCommanded = false;
    this.manualStrafeCommanded = false;

    // Thruster mounting physical geometry
    this.thrusterMounts = getThrusterMounts({ length: this.length, width: this.width, height: this.hull.height });

    // Individual thruster banks
    this.thrusters = {
      bowPort: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      bowStarboard: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      sternPort: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      sternStarboard: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      dorsalRoll: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      ventralRoll: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      bowDorsal: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      bowVentral: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      sternDorsal: { health: 100, powered: true, throttle: 0.0, isFiring: false },
      sternVentral: { health: 100, powered: true, throttle: 0.0, isFiring: false },
    };

    // Main Drive & Gimbal
    this.mainDrive = {
      health: 100,
      powered: true,
      throttle: 0.0,
      isFiring: false,
      gimbalYaw: 0,
      gimbalPitch: 0,
      heat: 0,
      maxHeat: 100,
      overheated: false,
    };

    // Thermal trackers for subsystems (work at reduced 0.30 effectiveness when overheated)
    this.rcsThermal = { heat: 0, maxHeat: 100, overheated: false };
    this.sasThermal = { heat: 0, maxHeat: 100, overheated: false };

    // Commanded manual pilot inputs for engine gimbal awareness
    this.commandedTurn = 0;
    this.commandedPitch = 0;
    this.rcsForward = 0;
    this.manualRcsForwardCommanded = false;

    clampAngularVelocity(this);
  }

  get rollState() {
    return Math.cos(this.rollAngle) < 0 ? 1 : 0;
  }

  set rollState(val) {
    this.rollAngle = val ? Math.PI : 0;
  }

  /**
   * Sets main drive throttle [0.0, 1.0].
   */
  setMainDriveThrottle(throttle) {
    this.mainDrive.throttle = Math.max(0, Math.min(1, Number(throttle) || 0));
  }

  /**
   * Sets throttle for a specific RCS bank [0.0, 1.0].
   */
  fireThruster(bankKey, throttle) {
    if (this.thrusters[bankKey]) {
      this.thrusters[bankKey].throttle = Math.max(0, Math.min(1, Number(throttle) || 0));
      if (['bowPort', 'bowStarboard', 'sternPort', 'sternStarboard'].includes(bankKey)) {
        if (this.thrusters[bankKey].throttle > 0) {
          this.manualTurnCommanded = true;
          this.autoOrientMode = null;
          if (bankKey === 'bowPort' || bankKey === 'sternStarboard') {
            this.commandedTurn = this.thrusters[bankKey].throttle;
          } else {
            this.commandedTurn = -this.thrusters[bankKey].throttle;
          }
        }
      }
      if (['bowDorsal', 'bowVentral', 'sternDorsal', 'sternVentral'].includes(bankKey)) {
        if (this.thrusters[bankKey].throttle > 0) {
          this.manualPitchCommanded = true;
          this.autoOrientMode = null;
          if (bankKey === 'bowVentral' || bankKey === 'sternDorsal') {
            this.commandedPitch = this.thrusters[bankKey].throttle;
          } else {
            this.commandedPitch = -this.thrusters[bankKey].throttle;
          }
        }
      }
      if (bankKey === 'dorsalRoll' || bankKey === 'ventralRoll') {
        if (this.thrusters[bankKey].throttle > 0) {
          this.manualRollCommanded = true;
          this.stopRollActive = false;
        }
      }
    }
  }

  /**
   * Helper for pilot input controls: { forward, strafe, turn, roll, pitch }.
   * - forward > 0: fires main drive
   * - strafe > 0: fires bowPort + sternPort (pushes to Starboard +y)
   * - strafe < 0: fires bowStarboard + sternStarboard (pushes to Port -y)
   * - turn > 0: fires bowPort + sternStarboard (positive torque, CCW / bow to Starboard)
   * - turn < 0: fires bowStarboard + sternPort (negative torque, CW / bow to Port)
   * - roll > 0: fires dorsalRoll (positive roll torque)
   * - roll < 0: fires ventralRoll (negative roll torque)
   * - pitch > 0: nose up / pull back (fires bowVentral + sternDorsal)
   * - pitch < 0: nose down / pitch forwards (fires bowDorsal + sternVentral)
   */
  commandPilot(input = {}) {
    const forward = input.forward ?? 0;
    const rcsForward = Math.max(-1, Math.min(1, Number(input.rcsForward) || 0));
    const strafe = input.strafe ?? 0;
    const turn = input.turn ?? 0;
    const roll = input.roll ?? 0;
    const pitch = input.pitch ?? 0;

    this.rcsForward = rcsForward;
    this.manualRcsForwardCommanded = Math.abs(rcsForward) > 0.001;
    this.commandedTurn = turn;
    this.commandedPitch = pitch;

    // Turn-and-burn is cancelled by any steering, translation, roll or thrust input,
    // or if something else took over auto-orientation.
    if (this.turnAndBurn) {
      if (
        forward > 0.001 ||
        Math.abs(rcsForward) > 0.001 ||
        Math.abs(turn) > 0.001 ||
        Math.abs(pitch) > 0.001 ||
        Math.abs(strafe) > 0.001 ||
        Math.abs(roll) > 0.001 ||
        this.autoOrientMode !== 'retrograde'
      ) {
        this.cancelTurnAndBurn();
      }
    }

    if (forward > 0) {
      this.setMainDriveThrottle(forward);
    } else {
      this.setMainDriveThrottle(0);
    }

    if (this.turnAndBurn) {
      this.applyTurnAndBurn();
    }

    if (Math.abs(turn) > 0.001) {
      this.autoOrientMode = null;
    }
    if (Math.abs(pitch) > 0.001) {
      this.autoOrientMode = null;
    }

    this.manualTurnCommanded = Math.abs(turn) > 0.001;
    this.manualStrafeCommanded = Math.abs(strafe) > 0.001;
    this.manualRollCommanded = Math.abs(roll) > 0.001;
    this.manualPitchCommanded = Math.abs(pitch) > 0.001;

    if (this.manualRollCommanded) {
      this.stopRollActive = false;
    }

    let bp = 0;
    let bs = 0;
    let sp = 0;
    let ss = 0;

    // Strafe allocation
    if (strafe > 0) {
      bp += strafe;
      sp += strafe;
    } else if (strafe < 0) {
      bs += -strafe;
      ss += -strafe;
    }

    // Turn allocation
    if (turn > 0) {
      bp += turn;
      ss += turn;
    } else if (turn < 0) {
      bs += -turn;
      sp += -turn;
    }

    this.thrusters.bowPort.throttle = Math.min(1, Math.max(0, bp));
    this.thrusters.bowStarboard.throttle = Math.min(1, Math.max(0, bs));
    this.thrusters.sternPort.throttle = Math.min(1, Math.max(0, sp));
    this.thrusters.sternStarboard.throttle = Math.min(1, Math.max(0, ss));

    this.thrusters.dorsalRoll.throttle = roll > 0 ? Math.min(1, roll) : 0;
    this.thrusters.ventralRoll.throttle = roll < 0 ? Math.min(1, -roll) : 0;

    // Pitch allocation
    if (pitch > 0.001) {
      this.thrusters.bowVentral.throttle = Math.min(1, Math.max(0, pitch));
      this.thrusters.sternDorsal.throttle = Math.min(1, Math.max(0, pitch));
      this.thrusters.bowDorsal.throttle = 0;
      this.thrusters.sternVentral.throttle = 0;
    } else if (pitch < -0.001) {
      this.thrusters.bowDorsal.throttle = Math.min(1, Math.max(0, -pitch));
      this.thrusters.sternVentral.throttle = Math.min(1, Math.max(0, -pitch));
      this.thrusters.bowVentral.throttle = 0;
      this.thrusters.sternDorsal.throttle = 0;
    } else {
      this.thrusters.bowDorsal.throttle = 0;
      this.thrusters.bowVentral.throttle = 0;
      this.thrusters.sternDorsal.throttle = 0;
      this.thrusters.sternVentral.throttle = 0;
    }
  }

  /**
   * Returns forward unit vector F in 3D physics space:
   * F = (cos(angle) * cos(pitch), sin(angle) * cos(pitch), sin(pitch))
   */
  getForwardVector() {
    const cosA = Math.cos(this.angle);
    const sinA = Math.sin(this.angle);
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    return {
      x: cosA * cosP,
      y: sinA * cosP,
      z: sinP,
    };
  }

  /**
   * Transforms local 3D vector { fx, fy, fz } to world coordinates taking
   * roll, pitch, and yaw (angle) into account.
   */
  localToWorldVector({ x: fx = 0, y: fy = 0, z: fz = 0 } = {}) {
    const cosR = Math.cos(this.rollAngle), sinR = Math.sin(this.rollAngle);
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
    const y1 = cosR * fy + sinR * fz;
    const z1 = -sinR * fy + cosR * fz;
    const x2 = cosP * fx - sinP * z1;
    const z2 = sinP * fx + cosP * z1;
    return {
      x: cosA * x2 - sinA * y1,
      y: sinA * x2 + cosA * y1,
      z: z2,
    };
  }

  /**
   * Actively stops roll angular rate to zero using opposing roll RCS thrusters.
   */
  stopRoll(active = true) {
    this.stopRollActive = Boolean(active);
    if (active) {
      this.manualRollCommanded = false;
      this.thrusters.dorsalRoll.throttle = 0;
      this.thrusters.ventralRoll.throttle = 0;
    }
  }

  /**
   * Sets auto-orientation mode: 'prograde' | 'retrograde' | 'target' | 'anti_target' | null
   */
  setAutoOrientMode(mode) {
    this.turnAndBurn = false;
    const validModes = ['prograde', 'retrograde', 'target', 'anti_target', 'face_enemy', 'away_enemy', 'level', 'stabilize'];
    if (validModes.includes(mode)) {
      this.autoOrientMode = mode;
      this.sasActive = true;
    } else {
      this.autoOrientMode = null;
    }
  }

  /**
   * Engages turn-and-burn: flip retrograde and burn the main drive until velocity is zero.
   * Does nothing when the ship is already (nearly) stationary.
   */
  startTurnAndBurn() {
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z || 0);
    if (speed < 0.5) return false;
    this.turnAndBurn = true;
    this.sasActive = true;
    this.autoOrientMode = 'retrograde';
    this.setMainDriveThrottle(0);
    return true;
  }

  /**
   * Cancels turn-and-burn, releasing auto-orientation and the main drive.
   */
  cancelTurnAndBurn() {
    if (!this.turnAndBurn) return;
    this.turnAndBurn = false;
    if (this.autoOrientMode === 'retrograde') this.autoOrientMode = null;
    this.setMainDriveThrottle(0);
  }

  /**
   * Per-tick turn-and-burn controller: holds the nose retrograde and burns
   * (tapering near zero speed) once aligned; self-cancels when velocity reaches zero.
   */
  applyTurnAndBurn() {
    const vx = this.vel.x;
    const vy = this.vel.y;
    const vz = this.vel.z || 0;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < 0.5) {
      this.cancelTurnAndBurn();
      return;
    }

    this.sasActive = true;
    this.autoOrientMode = 'retrograde';

    const F = this.getForwardVector();
    const alignment = -(F.x * vx + F.y * vy + F.z * vz) / speed;
    if (alignment > 0.97) {
      const accel = this.mass > 0 ? this.mainThrust / this.mass : 0;
      const taper = accel > 0 ? Math.min(1, speed / (accel * 0.5)) : 1;
      this.setMainDriveThrottle(Math.max(0.15, taper));
    } else {
      this.setMainDriveThrottle(0);
    }
  }

  /**
   * Resolves target orientation angle (radians) for active auto-orientation mode.
   */
  resolveAutoOrientAngle(navContext = null) {
    if (!this.autoOrientMode) return null;

    if (this.autoOrientMode === 'prograde') {
      return Math.hypot(this.vel.x, this.vel.y) > 0.5
        ? Math.atan2(this.vel.y, this.vel.x)
        : null;
    }

    if (this.autoOrientMode === 'retrograde') {
      return Math.hypot(this.vel.x, this.vel.y) > 0.5
        ? Math.atan2(-this.vel.y, -this.vel.x)
        : null;
    }

    if (this.autoOrientMode === 'target' || this.autoOrientMode === 'face_enemy') {
      return (navContext?.enemyKnown && navContext?.enemyPos)
        ? Math.atan2(navContext.enemyPos.y - this.pos.y, navContext.enemyPos.x - this.pos.x)
        : null;
    }

    if (this.autoOrientMode === 'anti_target' || this.autoOrientMode === 'away_enemy') {
      return (navContext?.enemyKnown && navContext?.enemyPos)
        ? Math.atan2(this.pos.y - navContext.enemyPos.y, this.pos.x - navContext.enemyPos.x)
        : null;
    }

    return null;
  }

  /**
   * Resolves target pitch angle (radians) for active auto-orientation mode.
   */
  resolveAutoOrientPitch(navContext = null) {
    if (!this.autoOrientMode) return null;

    if (this.autoOrientMode === 'prograde') {
      const horizontalSpeed = Math.hypot(this.vel.x, this.vel.y);
      const totalSpeed = Math.hypot(horizontalSpeed, this.vel.z || 0);
      return totalSpeed > 0.5
        ? Math.atan2(this.vel.z || 0, horizontalSpeed)
        : null;
    }

    if (this.autoOrientMode === 'retrograde') {
      const horizontalSpeed = Math.hypot(this.vel.x, this.vel.y);
      const totalSpeed = Math.hypot(horizontalSpeed, this.vel.z || 0);
      return totalSpeed > 0.5
        ? Math.atan2(-(this.vel.z || 0), horizontalSpeed)
        : null;
    }

    if (this.autoOrientMode === 'target' || this.autoOrientMode === 'face_enemy') {
      if (navContext?.enemyKnown && navContext?.enemyPos) {
        const dx = navContext.enemyPos.x - this.pos.x;
        const dy = navContext.enemyPos.y - this.pos.y;
        const dz = (navContext.enemyPos.z ?? 0) - (this.pos.z ?? 0);
        return Math.atan2(dz, Math.hypot(dx, dy));
      }
      return null;
    }

    if (this.autoOrientMode === 'anti_target' || this.autoOrientMode === 'away_enemy') {
      if (navContext?.enemyKnown && navContext?.enemyPos) {
        const dx = navContext.enemyPos.x - this.pos.x;
        const dy = navContext.enemyPos.y - this.pos.y;
        const dz = (navContext.enemyPos.z ?? 0) - (this.pos.z ?? 0);
        return Math.atan2(-dz, Math.hypot(dx, dy));
      }
      return null;
    }

    if (this.autoOrientMode === 'level' || this.autoOrientMode === 'stabilize') {
      return 0;
    }

    return null;
  }

  /**
   * Toggles or sets SAS attitude stabilization.
   */
  toggleSas(active) {
    this.sasActive = active !== undefined ? Boolean(active) : !this.sasActive;
    if (!this.sasActive) {
      this.sasPid.integralError = 0;
      this.sasPitchPid.integralError = 0;
    }
  }

  /**
   * Applies an instantaneous local force at a local offset.
   * Computes world force and torque.
   */
  applyForce(localForce, localOffset = { x: 0, y: 0, z: 0 }) {
    const fx = localForce.x || 0;
    const fy = localForce.y || 0;
    const fz = localForce.z || 0;
    const rx = localOffset.x || 0;
    const ry = localOffset.y || 0;
    const rz = localOffset.z || 0;

    const worldForce = this.localToWorldVector({ x: fx, y: fy, z: fz });
    const torque = rx * fy - ry * fx;
    const torquePitch = rx * fz - rz * fx;

    const linearAcc = {
      x: this.mass ? worldForce.x / this.mass : 0,
      y: this.mass ? worldForce.y / this.mass : 0,
      z: this.mass ? worldForce.z / this.mass : 0,
    };
    const angularAcc = this.inertia ? torque / this.inertia : 0;
    const pitchAngularAcc = this.pitchInertia ? torquePitch / this.pitchInertia : 0;

    return {
      worldForce,
      torque,
      torquePitch,
      linearAcc,
      angularAcc,
      pitchAngularAcc,
    };
  }

  /**
   * Maps an incoming world hit angle or 3D unit/direction vector to effective quadrant
   * ('fore', 'starboard', 'aft', 'port').
   * Accounts for 180° roll inversion: when rolled, Port and Starboard swap in world space.
   */
  getEffectiveQuadrant(worldHitAngleOrVec) {
    if (typeof worldHitAngleOrVec === 'number') {
      let diff = worldHitAngleOrVec - this.angle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;

      if (Math.abs(diff) <= Math.PI / 4) {
        return 'fore';
      }
      if (Math.abs(diff) >= (3 * Math.PI) / 4) {
        return 'aft';
      }
      if (diff > 0) {
        return this.rollState === 0 ? 'starboard' : 'port';
      }
      return this.rollState === 0 ? 'port' : 'starboard';
    }

    if (typeof worldHitAngleOrVec === 'object' && worldHitAngleOrVec !== null) {
      const dx = worldHitAngleOrVec.x ?? 0;
      const dy = worldHitAngleOrVec.y ?? 0;
      const dz = worldHitAngleOrVec.z ?? 0;
      const mag = Math.hypot(dx, dy, dz);
      const D = mag > 1e-6
        ? { x: dx / mag, y: dy / mag, z: dz / mag }
        : { x: 1, y: 0, z: 0 };

      const F = this.getForwardVector();
      const dotF = D.x * F.x + D.y * F.y + D.z * F.z;
      const cos45 = Math.SQRT1_2;

      if (dotF >= cos45 - 1e-6) {
        return 'fore';
      }
      if (dotF <= -cos45 + 1e-6) {
        return 'aft';
      }

      const R = this.localToWorldVector({ x: 0, y: 1, z: 0 });
      const dotR = D.x * R.x + D.y * R.y + D.z * R.z;
      return dotR >= 0 ? 'starboard' : 'port';
    }

    return 'fore';
  }

  getState() {
    return {
      pos: { ...this.pos },
      vel: { ...this.vel },
      angle: this.angle,
      omega: this.omega,
      pitch: this.pitch,
      pitchOmega: this.pitchOmega,
      rollAngle: this.rollAngle,
      rollOmega: this.rollOmega,
      rollState: this.rollState,
      rcsForward: this.rcsForward,
      mainDrive: { ...this.mainDrive },
      thrusters: { ...this.thrusters },
      rcsThermal: { ...this.rcsThermal },
      sasThermal: { ...this.sasThermal },
      sasActive: this.sasActive,
      autoOrientMode: this.autoOrientMode,
    };
  }

  /**
   * Updates physics for a timestep dt.
   * Evaluates thrusters, SAS PID counter-torques, physical roll RCS, auto-orientation, engine gimbal thrust vectoring, thermal overheating, and integrates kinematics.
   *
   * @param {number} dt - Timestep in seconds (e.g. 1/60)
   * @param {number|boolean} [rcsPowered=1] - Power state of RCS grid subsystem
   * @param {number|boolean} [mainDrivePowered=1] - Power state of Main Drive grid subsystem
   * @param {number|boolean} [sasPowered=1] - Power state of SAS computer grid subsystem
   * @param {object|null} [navContext=null] - Navigation context { enemyPos, enemyKnown, coolantMap }
   */
  update(dt, rcsPowered = 1, mainDrivePowered = 1, sasPowered = 1, navContext = null) {
    const rcsScale = typeof rcsPowered === 'number' ? Math.max(0, rcsPowered) : (rcsPowered ? 1.0 : 0.0);
    const mainDriveScale = typeof mainDrivePowered === 'number' ? Math.max(0, mainDrivePowered) : (mainDrivePowered ? 1.0 : 0.0);
    const sasScale = typeof sasPowered === 'number' ? Math.max(0, sasPowered) : (sasPowered ? 1.0 : 0.0);

    const rcsIsPowered = rcsScale > 0;
    const mainDriveIsPowered = mainDriveScale > 0;
    const sasIsPowered = sasScale > 0;

    // Coolant map support (defaults to 1.0 if navContext or entry omitted)
    const coolantMap = navContext?.coolantMap || {};
    const mainCoolant = coolantMap.main_drive !== undefined ? coolantMap.main_drive : 1.0;
    const rcsCoolant = coolantMap.rcs_thrusters !== undefined ? coolantMap.rcs_thrusters : 1.0;
    const sasCoolant = coolantMap.sas_computer !== undefined ? coolantMap.sas_computer : 1.0;

    // Subsystem thermal effectiveness: 0.30 when overheated
    const mainThermalEff = this.mainDrive.overheated ? 0.30 : 1.0;
    const rcsThermalEff = this.rcsThermal.overheated ? 0.30 : 1.0;
    const sasThermalEff = this.sasThermal.overheated ? 0.30 : 1.0;

    // Drydock helm module modifier
    const rcsMultiplier = this.modules?.helm === 'overdrive_rcs' ? 1.35 : 1.0;
    const effectiveRcsThrust = this.rcsThrust * rcsMultiplier * rcsThermalEff;
    const effectiveMainThrust = this.mainThrust;

    let netLocalForce = { x: 0, y: 0, z: 0 };
    let netTorque = 0;
    let netRollTorque = 0;
    let netPitchTorque = 0;
    let rcsAxialHealthFactor = 0;

    // Convert current Euler rates to body-frame rates
    const cosP = Math.max(0.1736, Math.cos(this.pitch));
    const cosR = Math.cos(this.rollAngle);
    const sinR = Math.sin(this.rollAngle);

    const omegaWorldYaw = this.omega * cosP;
    let omegaBody = omegaWorldYaw * cosR - this.pitchOmega * sinR;
    let pitchOmegaBody = omegaWorldYaw * sinR + this.pitchOmega * cosR;

    // Reset SAS-controlled thruster throttles if no manual pilot input is commanded
    const rcsBanks = ['bowPort', 'bowStarboard', 'sternPort', 'sternStarboard'];
    if (!this.manualTurnCommanded && !this.manualStrafeCommanded) {
      for (const bankKey of rcsBanks) {
        this.thrusters[bankKey].throttle = 0;
        this.thrusters[bankKey].isFiring = false;
      }
    }

    const pitchBanks = ['bowDorsal', 'bowVentral', 'sternDorsal', 'sternVentral'];
    if (!this.manualPitchCommanded) {
      for (const bankKey of pitchBanks) {
        this.thrusters[bankKey].throttle = 0;
        this.thrusters[bankKey].isFiring = false;
      }
    }

    if (!this.manualRollCommanded) {
      this.thrusters.dorsalRoll.throttle = 0;
      this.thrusters.dorsalRoll.isFiring = false;
      this.thrusters.ventralRoll.throttle = 0;
      this.thrusters.ventralRoll.isFiring = false;
    }

    // 0. Compute desired steering demands (normalized [-1, 1]) for gimbal & RCS
    let steerYaw = 0;
    let steerPitch = 0;
    let tauDesired = null;
    let tauPitchDesired = null;

    const tauNominalRef = 0.8 * this.length * effectiveRcsThrust;

    // SAS PID integral windup fix: reset integral when manual command active or angular rate negligible
    if (this.manualTurnCommanded || Math.abs(this.omega) <= 1e-4) {
      this.sasPid.integralError = 0;
    }
    if (this.manualPitchCommanded || Math.abs(this.pitchOmega) <= 1e-4) {
      this.sasPitchPid.integralError = 0;
    }

    let tauDesiredWorldYaw = null;
    let tauPitchDesiredWorld = null;

    // World yaw steering calculation
    if (!this.manualTurnCommanded && (this.sasActive || this.autoOrientMode) && sasIsPowered) {
      const targetAngle = this.resolveAutoOrientAngle(navContext);
      if (targetAngle !== null) {
        let angleErr = (targetAngle - this.angle) % (2 * Math.PI);
        while (angleErr > Math.PI) angleErr -= 2 * Math.PI;
        while (angleErr < -Math.PI) angleErr += 2 * Math.PI;

        const alphaAvail = (0.8 * this.length * effectiveRcsThrust * rcsScale) / this.inertia;
        const absErr = Math.abs(angleErr);
        const signErr = Math.sign(angleErr);
        const omegaDes = absErr < 0.12
          ? (4.5 * SHIP_PACING_SCALE * angleErr)
          : signErr * Math.min(Math.min(MAX_SPIN_RATE, 3.5 * SHIP_PACING_SCALE), Math.sqrt(2 * 0.55 * Math.max(0.01, alphaAvail) * absErr));

        const alphaDesired = 8.0 * (omegaDes - this.omega);
        tauDesiredWorldYaw = this.inertia * alphaDesired;
        this.sasPid.integralError = 0;
      } else if (this.sasActive) {
        if (Math.abs(this.omega) > 1e-4) {
          const e = -this.omega;
          this.sasPid.integralError = Math.max(
            -5.0,
            Math.min(5.0, this.sasPid.integralError + e * dt)
          );
          const desiredAlpha =
            this.sasPid.kp * e +
            this.sasPid.ki * this.sasPid.integralError;
          tauDesiredWorldYaw = this.inertia * desiredAlpha;
        } else {
          this.sasPid.integralError = 0;
        }
      }
    } else if (!this.sasActive || !sasIsPowered) {
      this.sasPid.integralError = 0;
    }

    // World pitch steering calculation
    if (!this.manualPitchCommanded && (this.sasActive || this.autoOrientMode) && sasIsPowered) {
      const targetPitch = this.resolveAutoOrientPitch(navContext);
      if (targetPitch !== null) {
        const clampedTargetPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, targetPitch));
        const pitchErr = clampedTargetPitch - this.pitch;
        const alphaPitchAvail = (0.8 * this.length * effectiveRcsThrust * rcsScale) / this.pitchInertia;
        const absErr = Math.abs(pitchErr);
        const signErr = Math.sign(pitchErr);
        const pitchOmegaDes = absErr < 0.12
          ? (4.5 * SHIP_PACING_SCALE * pitchErr)
          : signErr * Math.min(Math.min(MAX_SPIN_RATE, 3.0 * SHIP_PACING_SCALE), Math.sqrt(2 * 0.55 * Math.max(0.01, alphaPitchAvail) * absErr));

        const alphaDesired = 8.0 * (pitchOmegaDes - this.pitchOmega);
        tauPitchDesiredWorld = this.pitchInertia * alphaDesired;
        this.sasPitchPid.integralError = 0;
      } else if (this.sasActive) {
        if (Math.abs(this.pitchOmega) > 1e-4) {
          const e = -this.pitchOmega;
          this.sasPitchPid.integralError = Math.max(
            -5.0,
            Math.min(5.0, this.sasPitchPid.integralError + e * dt)
          );
          const desiredAlpha =
            this.sasPitchPid.kp * e +
            this.sasPitchPid.ki * this.sasPitchPid.integralError;
          tauPitchDesiredWorld = this.pitchInertia * desiredAlpha;
        } else {
          this.sasPitchPid.integralError = 0;
        }
      }
    } else if (!this.sasActive || !sasIsPowered) {
      this.sasPitchPid.integralError = 0;
    }

    // Transform world desired torques into body-frame desired torques
    if (tauDesiredWorldYaw !== null || tauPitchDesiredWorld !== null) {
      const alphaWorldYaw = tauDesiredWorldYaw !== null ? (tauDesiredWorldYaw / this.inertia) : 0;
      const pitchAlphaWorld = tauPitchDesiredWorld !== null ? (tauPitchDesiredWorld / this.pitchInertia) : 0;

      const alphaDesiredBodyYaw = alphaWorldYaw * cosR - pitchAlphaWorld * sinR;
      const alphaDesiredBodyPitch = alphaWorldYaw * sinR + pitchAlphaWorld * cosR;

      if (!this.manualTurnCommanded) {
        tauDesired = this.inertia * alphaDesiredBodyYaw * Math.max(0, sasScale) * sasThermalEff;
      }
      if (!this.manualPitchCommanded) {
        tauPitchDesired = this.pitchInertia * alphaDesiredBodyPitch * Math.max(0, sasScale) * sasThermalEff;
      }
    }

    // Commanded steer yaw (with governor)
    if (this.manualTurnCommanded) {
      const govYaw = getManualRateGovernorFactor(this.commandedTurn, omegaBody, this.maxManualYawRate);
      steerYaw = Math.max(-1, Math.min(1, (this.commandedTurn || 0) * govYaw));
    } else if (tauDesired !== null) {
      steerYaw = tauNominalRef > 0 ? Math.max(-1, Math.min(1, tauDesired / tauNominalRef)) : (tauDesired > 0 ? 1 : (tauDesired < 0 ? -1 : 0));
    }

    // Commanded steer pitch (with governor)
    if (this.manualPitchCommanded) {
      const govPitch = getManualRateGovernorFactor(this.commandedPitch, pitchOmegaBody, this.maxManualPitchRate);
      steerPitch = Math.max(-1, Math.min(1, (this.commandedPitch || 0) * govPitch));
    } else if (tauPitchDesired !== null) {
      steerPitch = tauNominalRef > 0 ? Math.max(-1, Math.min(1, tauPitchDesired / tauNominalRef)) : (tauPitchDesired > 0 ? 1 : (tauPitchDesired < 0 ? -1 : 0));
    }

    // 1. Main Drive & Engine Gimbal (Thrust vectoring at stern mount rx = -0.5 * length)
    let tauGimbalYaw = 0;
    let tauGimbalPitch = 0;
    const mainDriveActive =
      this.mainDrive.health > 0 &&
      this.mainDrive.powered &&
      mainDriveIsPowered &&
      this.mainDrive.throttle > 0;

    if (mainDriveActive) {
      this.mainDrive.isFiring = true;
      const F_main = this.mainDrive.throttle * effectiveMainThrust * mainDriveScale * mainThermalEff;

      // Deflect gimbalYaw and gimbalPitch clamped strictly to [-MAX_GIMBAL_RAD, +MAX_GIMBAL_RAD]
      const gimbalYaw = Math.max(-MAX_GIMBAL_RAD, Math.min(MAX_GIMBAL_RAD, steerYaw * MAX_GIMBAL_RAD));
      const gimbalPitch = Math.max(-MAX_GIMBAL_RAD, Math.min(MAX_GIMBAL_RAD, steerPitch * MAX_GIMBAL_RAD));
      this.mainDrive.gimbalYaw = gimbalYaw;
      this.mainDrive.gimbalPitch = gimbalPitch;

      const Fx = F_main * Math.cos(gimbalYaw) * Math.cos(gimbalPitch);
      const Fy = -F_main * Math.sin(gimbalYaw) * Math.cos(gimbalPitch);
      const Fz = -F_main * Math.sin(gimbalPitch);

      netLocalForce.x += Fx;
      netLocalForce.y += Fy;
      netLocalForce.z += Fz;

      tauGimbalYaw = (-0.5 * this.length) * Fy;   // = +0.5 * L * F_main * sin(gimbalYaw) * cos(gimbalPitch)
      netTorque += tauGimbalYaw;

      tauGimbalPitch = (-0.5 * this.length) * Fz; // = +0.5 * L * F_main * sin(gimbalPitch)
      netPitchTorque += tauGimbalPitch;
    } else {
      this.mainDrive.isFiring = false;
      this.mainDrive.gimbalYaw = 0;
      this.mainDrive.gimbalPitch = 0;
    }

    // 2. Manual RCS Firings (Yaw / Lateral) & Gimbal Cooperation
    let rcsTurnAssist = 1.0;
    if (this.mainDrive.isFiring && Math.abs(tauGimbalYaw) > 1e-4) {
      const tauNominalAct = tauNominalRef * rcsScale;
      rcsTurnAssist = tauNominalAct > 0
        ? Math.max(0, 1.0 - Math.abs(tauGimbalYaw) / tauNominalAct)
        : 1.0;
    }

    for (const bankKey of rcsBanks) {
      const bank = this.thrusters[bankKey];
      const mount = this.thrusterMounts[bankKey];

      if (bank.health > 0 && bank.powered && rcsIsPowered && bank.throttle > 0) {
        bank.isFiring = true;
        const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
        let firingThrottle = bank.throttle;
        if (this.manualTurnCommanded && !this.manualStrafeCommanded) {
          const govYaw = getManualRateGovernorFactor(this.commandedTurn, omegaBody, this.maxManualYawRate);
          firingThrottle = bank.throttle * govYaw * rcsTurnAssist;
        }
        const F = firingThrottle * effectiveRcsThrust * healthFactor * rcsScale;
        const fx = F * mount.fx;
        const fy = F * mount.fy;
        netLocalForce.x += fx;
        netLocalForce.y += fy;
        const tau = mount.rx * fy - mount.ry * fx;
        netTorque += tau;
      }
    }

    // 2a. Longitudinal RCS Translation (KeyW / KeyS)
    rcsAxialHealthFactor = 0;
    for (const bankKey of rcsBanks) {
      const b = this.thrusters[bankKey];
      if (b && b.powered && b.health > 0) {
        rcsAxialHealthFactor += Math.max(0, Math.min(1, b.health / 100)) * 0.25;
      }
    }
    if (rcsIsPowered && Math.abs(this.rcsForward) > 1e-4 && rcsAxialHealthFactor > 0) {
      const F_rcsAxial = this.rcsForward * 2 * effectiveRcsThrust * rcsAxialHealthFactor * rcsScale;
      netLocalForce.x += F_rcsAxial;
    }

    // 2b. Manual Pitch RCS Firings & Gimbal Cooperation
    let rcsPitchAssist = 1.0;
    if (this.mainDrive.isFiring && Math.abs(tauGimbalPitch) > 1e-4) {
      const tauPitchNominalAct = tauNominalRef * rcsScale;
      rcsPitchAssist = tauPitchNominalAct > 0
        ? Math.max(0, 1.0 - Math.abs(tauGimbalPitch) / tauPitchNominalAct)
        : 1.0;
    }

    for (const bankKey of pitchBanks) {
      const bank = this.thrusters[bankKey];
      const mount = this.thrusterMounts[bankKey];

      if (bank.health > 0 && bank.powered && rcsIsPowered && bank.throttle > 0) {
        bank.isFiring = true;
        const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
        let firingThrottle = bank.throttle;
        if (this.manualPitchCommanded) {
          const govPitch = getManualRateGovernorFactor(this.commandedPitch, pitchOmegaBody, this.maxManualPitchRate);
          firingThrottle = bank.throttle * govPitch * rcsPitchAssist;
        }
        const F = firingThrottle * effectiveRcsThrust * healthFactor * rcsScale;
        const fz = F * (mount.fz || 0);
        netLocalForce.z += fz;
        netPitchTorque += mount.rx * fz;
      }
    }

    // 3. Reaction Wheel Emergency Torque (if helm module equipped)
    if (this.modules?.helm === 'reaction_wheel') {
      const allRcsDown =
        !rcsIsPowered ||
        rcsBanks.every((k) => this.thrusters[k].health <= 0 || !this.thrusters[k].powered);

      if (allRcsDown && this.manualTurnCommanded && !mainDriveActive) {
        const tauRwMax = 0.25 * (0.8 * this.length * effectiveRcsThrust);
        const posCommand = (this.thrusters.bowPort.throttle + this.thrusters.sternStarboard.throttle) * 0.5;
        const negCommand = (this.thrusters.bowStarboard.throttle + this.thrusters.sternPort.throttle) * 0.5;
        const turnEffort = posCommand - negCommand;
        netTorque += turnEffort * tauRwMax;
      }
    }

    // 4. Auto-Orientation & SAS Yaw Controller (RCS cooperation: only asks RCS for remaining torque needed)
    if ((this.sasActive || this.autoOrientMode) && sasIsPowered && !this.manualTurnCommanded && tauDesired !== null) {
      const tauRemaining = tauDesired - tauGimbalYaw;

      if (Math.abs(tauRemaining) > 1e-4) {
        const tauNominalMax = 0.8 * this.length * effectiveRcsThrust * rcsScale;
        const commandedThrottle = tauNominalMax > 0 ? Math.min(1.0, Math.abs(tauRemaining) / tauNominalMax) : 0;

        if (tauRemaining > 0) {
          const bp = this.thrusters.bowPort;
          const ss = this.thrusters.sternStarboard;
          const bpAvail = bp.health > 0 && bp.powered && rcsIsPowered;
          const ssAvail = ss.health > 0 && ss.powered && rcsIsPowered;

          if (bpAvail || ssAvail) {
            if (bpAvail) {
              const healthFactor = Math.max(0, Math.min(1, bp.health / 100));
              bp.throttle = Math.max(bp.throttle, commandedThrottle);
              bp.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fy = F * this.thrusterMounts.bowPort.fy;
              netLocalForce.y += fy;
              netTorque += this.thrusterMounts.bowPort.rx * fy;
            }
            if (ssAvail) {
              const healthFactor = Math.max(0, Math.min(1, ss.health / 100));
              ss.throttle = Math.max(ss.throttle, commandedThrottle);
              ss.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fy = F * this.thrusterMounts.sternStarboard.fy;
              netLocalForce.y += fy;
              netTorque += this.thrusterMounts.sternStarboard.rx * fy;
            }
          } else if (this.modules?.helm === 'reaction_wheel') {
            const tauRwMax = 0.25 * (0.8 * this.length * effectiveRcsThrust);
            netTorque += Math.min(tauRwMax, tauRemaining);
          }
        } else if (tauRemaining < 0) {
          const bs = this.thrusters.bowStarboard;
          const sp = this.thrusters.sternPort;
          const bsAvail = bs.health > 0 && bs.powered && rcsIsPowered;
          const spAvail = sp.health > 0 && sp.powered && rcsIsPowered;

          if (bsAvail || spAvail) {
            if (bsAvail) {
              const healthFactor = Math.max(0, Math.min(1, bs.health / 100));
              bs.throttle = Math.max(bs.throttle, commandedThrottle);
              bs.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fy = F * this.thrusterMounts.bowStarboard.fy;
              netLocalForce.y += fy;
              netTorque += this.thrusterMounts.bowStarboard.rx * fy;
            }
            if (spAvail) {
              const healthFactor = Math.max(0, Math.min(1, sp.health / 100));
              sp.throttle = Math.max(sp.throttle, commandedThrottle);
              sp.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fy = F * this.thrusterMounts.sternPort.fy;
              netLocalForce.y += fy;
              netTorque += this.thrusterMounts.sternPort.rx * fy;
            }
          } else if (this.modules?.helm === 'reaction_wheel') {
            const tauRwMax = 0.25 * (0.8 * this.length * effectiveRcsThrust);
            netTorque += Math.max(-tauRwMax, tauRemaining);
          }
        }
      }
    }

    // 4b. Auto-Orientation & SAS Pitch Controller (RCS cooperation)
    if ((this.sasActive || this.autoOrientMode) && sasIsPowered && !this.manualPitchCommanded && tauPitchDesired !== null) {
      const tauPitchRemaining = tauPitchDesired - tauGimbalPitch;

      if (Math.abs(tauPitchRemaining) > 1e-4) {
        const tauPitchNominalMax = 0.8 * this.length * effectiveRcsThrust * rcsScale;
        const commandedThrottle = tauPitchNominalMax > 0 ? Math.min(1.0, Math.abs(tauPitchRemaining) / tauPitchNominalMax) : 0;

        if (tauPitchRemaining > 0) {
          const bv = this.thrusters.bowVentral;
          const sd = this.thrusters.sternDorsal;
          const bvAvail = bv.health > 0 && bv.powered && rcsIsPowered;
          const sdAvail = sd.health > 0 && sd.powered && rcsIsPowered;

          if (bvAvail || sdAvail) {
            if (bvAvail) {
              const healthFactor = Math.max(0, Math.min(1, bv.health / 100));
              bv.throttle = Math.max(bv.throttle, commandedThrottle);
              bv.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fz = F * this.thrusterMounts.bowVentral.fz;
              netLocalForce.z += fz;
              netPitchTorque += this.thrusterMounts.bowVentral.rx * fz;
            }
            if (sdAvail) {
              const healthFactor = Math.max(0, Math.min(1, sd.health / 100));
              sd.throttle = Math.max(sd.throttle, commandedThrottle);
              sd.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fz = F * this.thrusterMounts.sternDorsal.fz;
              netLocalForce.z += fz;
              netPitchTorque += this.thrusterMounts.sternDorsal.rx * fz;
            }
          }
        } else if (tauPitchRemaining < 0) {
          const bd = this.thrusters.bowDorsal;
          const sv = this.thrusters.sternVentral;
          const bdAvail = bd.health > 0 && bd.powered && rcsIsPowered;
          const svAvail = sv.health > 0 && sv.powered && rcsIsPowered;

          if (bdAvail || svAvail) {
            if (bdAvail) {
              const healthFactor = Math.max(0, Math.min(1, bd.health / 100));
              bd.throttle = Math.max(bd.throttle, commandedThrottle);
              bd.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fz = F * this.thrusterMounts.bowDorsal.fz;
              netLocalForce.z += fz;
              netPitchTorque += this.thrusterMounts.bowDorsal.rx * fz;
            }
            if (svAvail) {
              const healthFactor = Math.max(0, Math.min(1, sv.health / 100));
              sv.throttle = Math.max(sv.throttle, commandedThrottle);
              sv.isFiring = true;
              const F = commandedThrottle * effectiveRcsThrust * healthFactor * rcsScale;
              const fz = F * this.thrusterMounts.sternVentral.fz;
              netLocalForce.z += fz;
              netPitchTorque += this.thrusterMounts.sternVentral.rx * fz;
            }
          }
        }
      }
    }

    // 5. Physical Roll RCS & Roll Stopping
    const tauRollMax = 0.5 * this.width * effectiveRcsThrust * rcsScale;

    if (this.manualRollCommanded) {
      const rollCommand = this.thrusters.dorsalRoll.throttle > 0
        ? this.thrusters.dorsalRoll.throttle
        : -this.thrusters.ventralRoll.throttle;
      const govRoll = getManualRateGovernorFactor(rollCommand, this.rollOmega, this.maxManualRollRate);

      if (this.thrusters.dorsalRoll.throttle > 0) {
        const bank = this.thrusters.dorsalRoll;
        if (bank.health > 0 && bank.powered && rcsIsPowered) {
          const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
          bank.isFiring = true;
          netRollTorque += bank.throttle * govRoll * tauRollMax * healthFactor;
        } else {
          bank.isFiring = false;
        }
      }
      if (this.thrusters.ventralRoll.throttle > 0) {
        const bank = this.thrusters.ventralRoll;
        if (bank.health > 0 && bank.powered && rcsIsPowered) {
          const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
          bank.isFiring = true;
          netRollTorque -= bank.throttle * govRoll * tauRollMax * healthFactor;
        } else {
          bank.isFiring = false;
        }
      }
    } else if (this.stopRollActive && rcsIsPowered) {
      if (Math.abs(this.rollOmega) < 1e-4) {
        this.rollOmega = 0;
        this.stopRollActive = false;
      } else if (this.rollOmega > 0) {
        const bank = this.thrusters.ventralRoll;
        if (bank.health > 0 && bank.powered) {
          const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
          const neededAlpha = this.rollOmega / dt;
          const neededTau = this.rollInertia * neededAlpha;
          const throttle = Math.min(1.0, neededTau / tauRollMax);
          bank.throttle = throttle;
          bank.isFiring = true;
          netRollTorque -= throttle * tauRollMax * healthFactor;
        }
      } else if (this.rollOmega < 0) {
        const bank = this.thrusters.dorsalRoll;
        if (bank.health > 0 && bank.powered) {
          const healthFactor = Math.max(0, Math.min(1, bank.health / 100));
          const neededAlpha = (-this.rollOmega) / dt;
          const neededTau = this.rollInertia * neededAlpha;
          const throttle = Math.min(1.0, neededTau / tauRollMax);
          bank.throttle = throttle;
          bank.isFiring = true;
          netRollTorque += throttle * tauRollMax * healthFactor;
        }
      }
    }

    // 6. Kinematics Integration (Zero vacuum friction!)
    const worldForce = this.localToWorldVector(netLocalForce);
    const ax = this.mass ? worldForce.x / this.mass : 0;
    const ay = this.mass ? worldForce.y / this.mass : 0;
    const az = this.mass ? worldForce.z / this.mass : 0;

    const alphaBody = this.inertia ? netTorque / this.inertia : 0;
    const pitchAlphaBody = this.pitchInertia ? netPitchTorque / this.pitchInertia : 0;

    // Linear velocity & position integration
    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z = (this.vel.z || 0) + az * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z = (this.pos.z || 0) + this.vel.z * dt;

    // Apply body-frame yaw and pitch accelerations to body rates
    omegaBody += alphaBody * dt;
    pitchOmegaBody += pitchAlphaBody * dt;
    omegaBody = Math.max(-MAX_SPIN_RATE, Math.min(MAX_SPIN_RATE, omegaBody));
    pitchOmegaBody = Math.max(-MAX_SPIN_RATE, Math.min(MAX_SPIN_RATE, pitchOmegaBody));

    // Map updated body rates back to world-Euler rates
    const updatedOmegaWorldYaw = omegaBody * cosR + pitchOmegaBody * sinR;
    this.pitchOmega = -omegaBody * sinR + pitchOmegaBody * cosR;
    this.omega = updatedOmegaWorldYaw / cosP;

    // Roll angular velocity & angle integration
    const rollAlpha = this.rollInertia ? netRollTorque / this.rollInertia : 0;
    const prevRollOmega = this.rollOmega;
    this.rollOmega += rollAlpha * dt;

    // If stopping, detect zero-crossing or completion
    if (this.stopRollActive) {
      if (
        (prevRollOmega > 0 && this.rollOmega <= 0) ||
        (prevRollOmega < 0 && this.rollOmega >= 0) ||
        Math.abs(this.rollOmega) < 1e-5
      ) {
        this.rollOmega = 0;
        this.stopRollActive = false;
        this.thrusters.dorsalRoll.throttle = 0;
        this.thrusters.dorsalRoll.isFiring = false;
        this.thrusters.ventralRoll.throttle = 0;
        this.thrusters.ventralRoll.isFiring = false;
      }
    }

    // Universal spin and roll cap (1 rev / 2s => Math.PI rad/s)
    clampAngularVelocity(this);

    // Yaw angle integration
    this.angle += this.omega * dt;

    // Normalize yaw angle to [-PI, PI]
    while (this.angle > Math.PI) this.angle -= 2 * Math.PI;
    while (this.angle < -Math.PI) this.angle += 2 * Math.PI;

    // Pitch angle integration
    this.pitch += this.pitchOmega * dt;

    // Clamp pitch to [-MAX_PITCH_RAD, +MAX_PITCH_RAD]
    if (this.pitch > MAX_PITCH_RAD) {
      this.pitch = MAX_PITCH_RAD;
      this.pitchOmega = 0;
      this.sasPitchPid.integralError = 0;
    } else if (this.pitch < -MAX_PITCH_RAD) {
      this.pitch = -MAX_PITCH_RAD;
      this.pitchOmega = 0;
      this.sasPitchPid.integralError = 0;
    }

    this.rollAngle += this.rollOmega * dt;

    // Normalize roll angle to [-PI, PI]
    while (this.rollAngle > Math.PI) this.rollAngle -= 2 * Math.PI;
    while (this.rollAngle < -Math.PI) this.rollAngle += 2 * Math.PI;

    // 7. Subsystem Thermal & Overheating State Updates
    // Main Drive thermal update
    const mainActive = mainDriveIsPowered && this.mainDrive.health > 0 && this.mainDrive.powered && this.mainDrive.throttle > 0.05;
    if (mainActive && mainCoolant < 0.5) {
      const loadRate = 22 * this.mainDrive.throttle;
      this.mainDrive.heat = Math.min(100, this.mainDrive.heat + loadRate * (1 - mainCoolant) * dt);
    }
    if (mainCoolant > 0 || !mainActive) {
      this.mainDrive.heat = Math.max(0, this.mainDrive.heat - (18 * mainCoolant + (!mainActive ? 3.5 : 0)) * dt);
    }
    if (this.mainDrive.heat >= 100) {
      this.mainDrive.overheated = true;
    } else if (this.mainDrive.heat <= 75) {
      this.mainDrive.overheated = false;
    }

    // RCS Thrusters thermal update
    const anyRcsFiring =
      Object.values(this.thrusters).some(t => t.isFiring && t.throttle > 0.05) ||
      (rcsIsPowered && Math.abs(this.rcsForward) > 0.05 && rcsAxialHealthFactor > 0);
    const rcsActive = rcsIsPowered && anyRcsFiring;
    if (rcsActive && rcsCoolant < 0.5) {
      const loadRate = 22;
      this.rcsThermal.heat = Math.min(100, this.rcsThermal.heat + loadRate * (1 - rcsCoolant) * dt);
    }
    if (rcsCoolant > 0 || !rcsActive) {
      this.rcsThermal.heat = Math.max(0, this.rcsThermal.heat - (18 * rcsCoolant + (!rcsActive ? 3.5 : 0)) * dt);
    }
    if (this.rcsThermal.heat >= 100) {
      this.rcsThermal.overheated = true;
    } else if (this.rcsThermal.heat <= 75) {
      this.rcsThermal.overheated = false;
    }

    // SAS Computer thermal update
    const sasActive = sasIsPowered && (this.sasActive || Boolean(this.autoOrientMode)) && (!this.manualTurnCommanded || !this.manualPitchCommanded) && (Math.abs(this.omega) > 0.01 || Math.abs(this.pitchOmega) > 0.01 || Boolean(this.autoOrientMode));
    if (sasActive && sasCoolant < 0.5) {
      const loadRate = 22;
      this.sasThermal.heat = Math.min(100, this.sasThermal.heat + loadRate * (1 - sasCoolant) * dt);
    }
    if (sasCoolant > 0 || !sasActive) {
      this.sasThermal.heat = Math.max(0, this.sasThermal.heat - (18 * sasCoolant + (!sasActive ? 3.5 : 0)) * dt);
    }
    if (this.sasThermal.heat >= 100) {
      this.sasThermal.overheated = true;
    } else if (this.sasThermal.heat <= 75) {
      this.sasThermal.overheated = false;
    }
  }
}
