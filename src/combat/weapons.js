/**
 * BROADSIDE HYPERION — Weapons, Ballistics & Point-Defense
 *
 * Implements ballistic velocity inheritance, quadratic lead targeting,
 * heat accumulation and coolant dissipation, Heavy Railgun charge-and-pierce,
 * finite torpedo magazines (heavy, EMP, swarm), and Point-Defense Flak.
 */

import { HULL_CLASSES, MAX_PITCH_RAD, ARENA_RADIUS, SHIP_PACING_SCALE } from '../physics/constants.js';
import { applyGravity } from '../physics/gravity.js';
import { checkCircleCollision } from '../physics/collisions.js';
import { createAsteroidDebrisChunks } from '../world/sector-generator.js';
import { getQuadrantForAngle, DEFAULT_QUADRANT_SUBSYSTEMS } from './shields.js';

let _projSeq = 0;

export const TORPEDO_MUZZLE_SPEED = 250 * SHIP_PACING_SCALE; // 150 m/s
export const RAILGUN_COOLDOWN_SEC = 1.5 / SHIP_PACING_SCALE; // 2.5 s -> 40% slower cadence
export const TORPEDO_COOLDOWN_SEC = 1.0 / SHIP_PACING_SCALE; // 5/3 s -> 40% slower cadence
export const TORPEDO_LIFETIME_SEC = 10.0 / SHIP_PACING_SCALE; // 50/3 s -> preserves ~2500m range at 150 m/s

export const RAILGUN_MAX_SLEW_RATE = (20 * Math.PI) / 180; // ~0.349066 rad/s (20 deg/s max traverse)
export const RAILGUN_JAM_THRESHOLD = 15;

/**
 * Normalizes an angle into the [-PI, PI] range.
 *
 * @param {number} angle
 * @returns {number}
 */
export function normalizeAngle(angle) {
  let a = (Number(angle) || 0) % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Calculates future intercept position and required firing angle and pitch for a projectile
 * inheriting the shooter's velocity vector.
 *
 * Solves quadratic equation: |p_rel + v_rel * t| = v_proj * t
 * where p_rel = p_target - p_shooter, v_rel = v_target - v_shooter in 3D.
 *
 * @param {object} shooterPos - { x, y, [z] }
 * @param {object} shooterVel - { x, y, [z] }
 * @param {object} targetPos - { x, y, [z] }
 * @param {object} targetVel - { x, y, [z] }
 * @param {number} projectileSpeed - muzzle velocity speed (m/s)
 * @returns {object} { x, y, z, aimAngle, aimPitch, t, timeToIntercept }
 */
export function calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projectileSpeed) {
  const dx = targetPos.x - shooterPos.x;
  const dy = targetPos.y - shooterPos.y;
  const dz = (targetPos.z ?? 0) - (shooterPos.z ?? 0);

  const dvx = (targetVel.x ?? 0) - (shooterVel.x ?? 0);
  const dvy = (targetVel.y ?? 0) - (shooterVel.y ?? 0);
  const dvz = (targetVel.z ?? 0) - (shooterVel.z ?? 0);

  // Coefficients for a * t^2 + b * t + c = 0
  const a = dvx * dvx + dvy * dvy + dvz * dvz - projectileSpeed * projectileSpeed;
  const b = 2 * (dx * dvx + dy * dvy + dz * dvz);
  const c = dx * dx + dy * dy + dz * dz;

  let t = 0;
  const disc = b * b - 4 * a * c;

  if (Math.abs(a) < 1e-8) {
    // Relative speed matches projectile speed
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

  // Fallback if target cannot be intercepted or t <= 0
  if (t <= 0) {
    const dist = Math.hypot(dx, dy, dz);
    t = dist / Math.max(1, projectileSpeed);
  }

  // Future world position of target at intercept time
  const targetFutureX = targetPos.x + (targetVel.x ?? 0) * t;
  const targetFutureY = targetPos.y + (targetVel.y ?? 0) * t;
  const targetFutureZ = (targetPos.z ?? 0) + (targetVel.z ?? 0) * t;

  // Muzzle velocity vector in shooter reference frame: v_muzzle = (p_rel + v_rel * t) / t
  const mx = (dx + dvx * t) / t;
  const my = (dy + dvy * t) / t;
  const mz = (dz + dvz * t) / t;
  const aimAngle = Math.atan2(my, mx);
  const aimPitch = Math.atan2(mz, Math.hypot(mx, my));

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

export class WeaponSystem {
  /**
   * @param {string|object} hullClassKey - 'corvette' | 'frigate' | 'dreadnought'
   * @param {string} torpedoModule - 'heavy_torpedoes' | 'emp_torpedoes' | 'swarm_missiles'
   */
  constructor(hullClassKey = 'frigate', torpedoModule = 'heavy_torpedoes') {
    const hull = (typeof hullClassKey === 'object' && hullClassKey !== null)
      ? hullClassKey
      : (HULL_CLASSES[hullClassKey] || HULL_CLASSES.frigate);

    // Twin Pulse Lasers
    this.heat = 0;
    this.maxHeat = 100;
    this.overheated = false;
    this.overheatTimer = 0;
    this.cooldown = 0; // 4 shots/sec => 0.25s
    this.laserMuzzleSpeed = 600;
    this.laserBaseDamage = 18;
    this.laserShieldMultiplier = 2.0;
    this.laserHeatPerShot = 6;

    // Heavy Railgun
    this.charging = false;
    this.chargeProgress = 0;
    this.chargeTime = 1.2;
    this.railgunCooldown = 0;
    this.railgunMuzzleSpeed = 900;
    this.railgunBaseDamage = 250;
    this.railgunLocalAngle = 0;
    this.railgunAngle = 0;
    this.railgunTargetAngle = 0;
    this.railgunLocalPitch = 0;
    this.railgunPitch = 0;
    this.railgunTargetPitch = 0;
    this.railgunSlewRate = RAILGUN_MAX_SLEW_RATE;
    this.railgunJammed = false;
    this.railgunHeat = 0;
    this.railgunOverheated = false;
    this.turretAngle = 0;
    this.turretPitch = 0;

    // Subsystem Hardware Health Trackers (100 = nominal, <= 15 = jammed/failing)
    this.railgunHardware = { health: 100 };
    this.laserHardware = { health: 100 };
    this.stabilizerHardware = { health: 100 };

    // Homing Torpedoes
    this.torpedoType = torpedoModule;
    let initialMag = hull.maxTorpedoes || 8;
    if (torpedoModule === 'swarm_missiles') {
      initialMag = 16;
    }
    this.magazine = initialMag;
    this.maxMagazine = initialMag;
    this.torpedoCooldown = 0;
    this.lockProgress = 0;
    this.lockedTargetId = null;
    this.torpedoHeat = 0;
    this.torpedoOverheated = false;

    // Point-Defense Flak
    this.flakCooldown = 0;
    this.burstRadius = 200;

    // Pinpoint Subsystem Targeting (e.g. 'bowPort', 'mainDrive', 'sas_computer')
    this.targetedSubsystem = null;

    this.projectiles = [];
  }

  /**
   * Fires Twin Pulse Lasers along the 3D aim vector without inheriting
   * the firing ship's velocity vector (v_proj = v_muzzle).
   *
   * @param {object} ship - { id, pos, vel }
   * @param {number} aimAngle - world yaw angle to aim
   * @param {number} [power=1.0] - weapon power multiplier
   * @param {number} [aimPitch=0] - world pitch angle to aim
   * @returns {object|null} fired projectile or null if unable to fire
   */
  fireLaser(ship, aimAngle, power = 1.0, aimPitch = 0) {
    if (this.cooldown > 0 || power <= 0 || (this.laserHardware?.health ?? 100) <= 0) {
      return null;
    }

    let damage;
    if (this.overheated) {
      this.cooldown = 0.65;
      damage = this.laserBaseDamage * power * 0.5;
      this.heat = Math.min(this.maxHeat, this.heat + this.laserHeatPerShot);
    } else {
      this.cooldown = 0.25;
      this.heat += this.laserHeatPerShot;
      if (this.heat >= this.maxHeat) {
        this.heat = this.maxHeat;
        this.overheated = true;
        this.overheatTimer = 3.0;
      }
      damage = this.laserBaseDamage * power;
    }

    const effectivePitch = aimPitch || 0;
    this.turretAngle = aimAngle;
    this.turretPitch = effectivePitch;
    const dirX = Math.cos(effectivePitch) * Math.cos(aimAngle);
    const dirY = Math.cos(effectivePitch) * Math.sin(aimAngle);
    const dirZ = Math.sin(effectivePitch);

    const vx = dirX * this.laserMuzzleSpeed;
    const vy = dirY * this.laserMuzzleSpeed;
    const vz = dirZ * this.laserMuzzleSpeed;

    const proj = {
      id: 'laser_' + Date.now() + '_' + (++_projSeq) + '_' + Math.random().toString(36).slice(2, 7),
      type: 'laser',
      shooterId: ship.id,
      pos: { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z ?? 0 },
      vel: { x: vx, y: vy, z: vz },
      speed: this.laserMuzzleSpeed,
      aimAngle,
      aimPitch: effectivePitch,
      damage,
      shieldMultiplier: this.laserShieldMultiplier,
      lifetime: 2.5,
      radius: 4,
    };

    this.projectiles.push(proj);
    return proj;
  }

  /**
   * Updates Railgun turret articulation, slew rate limits (<= 20 deg/s),
   * power state, and mechanical jam thresholds.
   *
   * @param {number} dt - simulation timestep in seconds
   * @param {number} shipAngle - starship world yaw angle
   * @param {number|null} desiredWorldAngle - Weapons console target aim angle
   * @param {object} [powerMap={}] - grid power distribution
   * @param {number} [shipPitch=0] - starship world pitch angle
   * @param {number|null} [desiredWorldPitch=null] - Weapons console target aim pitch
   * @returns {{ railgunAngle: number, railgunLocalAngle: number, railgunPitch: number, railgunLocalPitch: number, railgunSlewRate: number, railgunJammed: boolean }}
   */
  updateRailgunTraverse(dt, shipAngle = 0, desiredWorldAngle = null, powerMap = {}, shipPitch = 0, desiredWorldPitch = null) {
    const health = this.railgunHardware?.health ?? 100;

    if (health <= RAILGUN_JAM_THRESHOLD) {
      this.railgunJammed = true;
      this.railgunSlewRate = 0;
    } else {
      this.railgunJammed = false;
      const powered = (powerMap?.weapons_railgun || 0) > 0;
      const coolantVal = powerMap?.coolantMap?.weapons_railgun ?? 1.0;
      const thermalEff = 0.4 + 0.6 * Math.max(0, coolantVal);
      const overheatMult = this.railgunOverheated ? 0.35 : 1.0;
      this.railgunSlewRate = RAILGUN_MAX_SLEW_RATE * Math.max(0.15, health / 100) * (powered ? thermalEff : 0.2) * overheatMult;
    }

    const shipA = shipAngle ?? 0;
    const targetWorld = desiredWorldAngle != null ? desiredWorldAngle : shipA;
    const targetLocal = normalizeAngle(targetWorld - shipA);

    const diff = normalizeAngle(targetLocal - this.railgunLocalAngle);
    const maxStep = this.railgunSlewRate * dt;

    if (Math.abs(diff) <= maxStep || this.railgunSlewRate <= 0) {
      if (this.railgunSlewRate > 0) {
        this.railgunLocalAngle = targetLocal;
      }
    } else {
      this.railgunLocalAngle = normalizeAngle(this.railgunLocalAngle + Math.sign(diff) * maxStep);
    }

    this.railgunTargetAngle = desiredWorldAngle != null ? desiredWorldAngle : (shipA + this.railgunLocalAngle);
    this.railgunAngle = normalizeAngle(shipA + this.railgunLocalAngle);

    // Pitch traverse articulation
    const shipP = shipPitch ?? 0;
    const targetWorldPitch = (desiredWorldPitch !== null && !Number.isNaN(desiredWorldPitch))
      ? Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Number(desiredWorldPitch)))
      : shipP;
    const targetLocalPitch = targetWorldPitch - shipP;
    const diffPitch = targetLocalPitch - (this.railgunLocalPitch ?? 0);

    if (Math.abs(diffPitch) <= maxStep || this.railgunSlewRate <= 0) {
      if (this.railgunSlewRate > 0) {
        this.railgunLocalPitch = targetLocalPitch;
      }
    } else {
      this.railgunLocalPitch = (this.railgunLocalPitch ?? 0) + Math.sign(diffPitch) * maxStep;
    }

    this.railgunTargetPitch = (desiredWorldPitch !== null && !Number.isNaN(desiredWorldPitch))
      ? targetWorldPitch
      : (shipP + this.railgunLocalPitch);
    this.railgunPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, shipP + this.railgunLocalPitch));

    return {
      railgunAngle: this.railgunAngle,
      railgunLocalAngle: this.railgunLocalAngle,
      railgunPitch: this.railgunPitch,
      railgunLocalPitch: this.railgunLocalPitch,
      railgunSlewRate: this.railgunSlewRate,
      railgunJammed: this.railgunJammed,
    };
  }

  /**
   * Begins charging the Heavy Railgun.
   */
  startRailgunCharge() {
    this.charging = true;
  }

  /**
   * Cancels/stops charging the Heavy Railgun.
   */
  stopRailgunCharge() {
    this.charging = false;
    if (this.chargeProgress < 1.0) {
      this.chargeProgress = 0;
    }
  }

  /**
   * Releases charged Heavy Railgun slug.
   * Requires chargeProgress >= 1.0.
   *
   * @param {object} ship - { id, pos, vel }
   * @param {number} aimAngle - world angle
   * @param {number} [power=1.0] - weapon power
   * @param {number} [aimPitch=0] - world pitch
   * @returns {object|null} fired railgun slug or null
   */
  releaseRailgun(ship, aimAngle, power = 1.0, aimPitch = 0) {
    if (this.chargeProgress < 1.0 || this.railgunCooldown > 0 || (this.railgunHardware?.health ?? 100) <= 0) {
      return null;
    }

    this.charging = false;
    this.chargeProgress = 0;
    this.railgunCooldown = RAILGUN_COOLDOWN_SEC;

    const effectiveAngle = aimAngle !== undefined && aimAngle !== null ? aimAngle : this.railgunAngle;
    const effectivePitch = aimPitch !== undefined && aimPitch !== null ? aimPitch : (this.railgunPitch || 0);

    const effectivePower = power > 0 ? power : 1.0;
    const damage = this.railgunBaseDamage * effectivePower;
    const dirX = Math.cos(effectivePitch) * Math.cos(effectiveAngle);
    const dirY = Math.cos(effectivePitch) * Math.sin(effectiveAngle);
    const dirZ = Math.sin(effectivePitch);

    const vx = (ship.vel.x ?? 0) + dirX * this.railgunMuzzleSpeed;
    const vy = (ship.vel.y ?? 0) + dirY * this.railgunMuzzleSpeed;
    const vz = (ship.vel.z ?? 0) + dirZ * this.railgunMuzzleSpeed;

    const slug = {
      id: 'railgun_' + Date.now() + '_' + (++_projSeq) + '_' + Math.random().toString(36).slice(2, 7),
      type: 'railgun',
      shooterId: ship.id,
      pos: { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z ?? 0 },
      vel: { x: vx, y: vy, z: vz },
      speed: this.railgunMuzzleSpeed,
      aimAngle: effectiveAngle,
      aimPitch: effectivePitch,
      damage,
      mass: 50,
      targetedSubsystem: this.targetedSubsystem,
      lifetime: 5.0,
      radius: 6,
    };

    this.projectiles.push(slug);
    return slug;
  }

  /**
   * Launches a Homing Torpedo from the finite magazine.
   *
   * @param {object} ship - { id, pos, vel }
   * @param {number} aimAngle - world angle
   * @param {string|null} [targetId=null] - target ship id
   * @param {number} [power=1.0] - weapon power
   * @param {number} [aimPitch=0] - world pitch
   * @returns {object|null} fired torpedo or null
   */
  launchTorpedo(ship, aimAngle, targetId = null, power = 1.0, aimPitch = 0) {
    if (this.magazine <= 0 || this.torpedoCooldown > 0 || power <= 0) {
      return null;
    }

    this.magazine--;
    this.torpedoCooldown = TORPEDO_COOLDOWN_SEC;

    let damage = 400;
    let turnRate = 2.0;
    let empDuration = 0;

    if (this.torpedoType === 'emp_torpedoes') {
      damage = 150;
      empDuration = 8.0;
    } else if (this.torpedoType === 'swarm_missiles') {
      damage = 70;
      turnRate = 3.5;
    }

    turnRate *= SHIP_PACING_SCALE;

    if (power > 1.0) {
      damage *= power;
      turnRate *= Math.min(1.5, power);
    }

    const muzzleSpeed = TORPEDO_MUZZLE_SPEED;
    const effectivePitch = aimPitch || 0;
    const dirX = Math.cos(effectivePitch) * Math.cos(aimAngle);
    const dirY = Math.cos(effectivePitch) * Math.sin(aimAngle);
    const dirZ = Math.sin(effectivePitch);

    const vx = (ship.vel.x ?? 0) + dirX * muzzleSpeed;
    const vy = (ship.vel.y ?? 0) + dirY * muzzleSpeed;
    const vz = (ship.vel.z ?? 0) + dirZ * muzzleSpeed;

    const torp = {
      id: 'torpedo_' + Date.now() + '_' + (++_projSeq) + '_' + Math.random().toString(36).slice(2, 7),
      type: 'torpedo',
      torpedoType: this.torpedoType,
      shooterId: ship.id,
      targetId,
      pos: { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z ?? 0 },
      vel: { x: vx, y: vy, z: vz },
      speed: muzzleSpeed,
      aimAngle,
      aimPitch: effectivePitch,
      damage,
      turnRate,
      empDuration,
      mass: 100,
      lifetime: TORPEDO_LIFETIME_SEC,
      radius: 8,
      lockBroken: false,
    };

    this.projectiles.push(torp);
    return torp;
  }

  /**
   * Resupplies torpedo magazine (e.g. from Munitions Derelict via Cargo Tractor).
   * Capped at maxMagazine + 6.
   *
   * @param {number} [amount=3]
   * @returns {number} new magazine count
   */
  resupplyTorpedoes(amount = 3) {
    this.magazine = Math.min(this.magazine + amount, this.maxMagazine + 6);
    return this.magazine;
  }

  /**
   * Detonates Point-Defense Flak around the ship.
   * Destroys all enemy torpedoes, missiles, and active tether mines within 200m.
   *
   * @param {object} ship - { id, pos }
   * @param {Array<object>} [projectiles=[]] - list of active projectiles
   * @param {Array<object>} [tetherMines=[]] - list of tether mines
   * @returns {object} { destroyedProjectiles, destroyedMines }
   */
  fireFlak(ship, projectiles = [], tetherMines = []) {
    this.flakCooldown = 2.0;
    const destroyedProjectiles = [];
    const destroyedMines = [];

    const list = (projectiles && projectiles.length > 0) ? projectiles : this.projectiles;

    for (const p of list) {
      if (p.shooterId !== ship.id && (p.type === 'torpedo' || p.torpedoType)) {
        const dist = Math.hypot(p.pos.x - ship.pos.x, p.pos.y - ship.pos.y, (p.pos.z ?? 0) - (ship.pos.z ?? 0));
        if (dist <= this.burstRadius) {
          p.destroyed = true;
          destroyedProjectiles.push(p);
        }
      }
    }

    for (const mine of tetherMines) {
      if (mine.armed && !mine.destroyed) {
        const dist = Math.hypot(mine.pos.x - ship.pos.x, mine.pos.y - ship.pos.y, (mine.pos.z ?? 0) - (ship.pos.z ?? 0));
        if (dist <= this.burstRadius) {
          mine.destroyed = true;
          mine.armed = false;
          destroyedMines.push(mine);
        }
      }
    }

    return { destroyedProjectiles, destroyedMines };
  }

  /**
   * Updates weapon cooldowns, heat cooling, railgun charge, and lockout states.
   *
   * @param {number} dt - timestep in seconds
   * @param {object} [powerMap={}] - subsystem power allocations
   * @param {number|boolean|undefined} [coolantFlow] - optional explicit coolant flow rate override
   */
  update(dt, powerMap = {}, coolantFlow = undefined) {
    // Coolant flow extraction (use powerMap.coolantMap unless an explicit override is passed)
    const rawLaserCoolant = typeof coolantFlow === 'number'
      ? coolantFlow
      : (powerMap?.coolantMap?.weapons_laser ?? (coolantFlow === false ? 0.2 : 1.0));
    const laserCoolant = Math.max(0, Number(rawLaserCoolant) || 0);

    const rawRailgunCoolant = typeof coolantFlow === 'number'
      ? coolantFlow
      : (powerMap?.coolantMap?.weapons_railgun ?? 1.0);
    const railgunCoolant = Math.max(0, Number(rawRailgunCoolant) || 0);

    const rawTorpCoolant = typeof coolantFlow === 'number'
      ? coolantFlow
      : (powerMap?.coolantMap?.weapons_torpedo ?? 1.0);
    const torpCoolant = Math.max(0, Number(rawTorpCoolant) || 0);

    const railgunThermalEff = 0.4 + 0.6 * Math.max(0, railgunCoolant);
    const torpThermalEff = 0.4 + 0.6 * Math.max(0, torpCoolant);

    // Cooldown decrements
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.railgunCooldown = Math.max(0, this.railgunCooldown - dt);
    const torpOverheatMult = this.torpedoOverheated ? 0.30 : 1.0;
    this.torpedoCooldown = Math.max(0, this.torpedoCooldown - dt * torpThermalEff * torpOverheatMult);
    this.flakCooldown = Math.max(0, this.flakCooldown - dt);

    // Pulse Laser heat dissipation
    if (laserCoolant <= 0) {
      if (this.cooldown <= 0) {
        this.heat = Math.max(0, this.heat - 2.0 * dt);
      }
    } else {
      const coolingRate = 12.0 * laserCoolant;
      this.heat = Math.max(0, this.heat - coolingRate * dt);
    }

    if (this.overheated) {
      if (this.overheatTimer > 0) {
        this.overheatTimer = Math.max(0, this.overheatTimer - dt);
      }
      const canClear = laserCoolant <= 0
        ? this.heat <= 75
        : (this.overheatTimer <= 0 && this.heat <= 75);
      if (canClear) {
        this.overheated = false;
        this.overheatTimer = 0;
      }
    }

    // Heavy Railgun Thermal Management
    const railgunPower = powerMap.weapons_railgun ?? powerMap.weapons ?? 0;
    const isRailgunActive = (this.charging && railgunPower > 0) || this.railgunCooldown > 0;
    if (railgunCoolant < 0.5 && isRailgunActive) {
      const buildRate = 35.0;
      this.railgunHeat = Math.min(100, this.railgunHeat + buildRate * (1 - railgunCoolant) * dt);
    } else {
      const railgunCoolRate = railgunCoolant > 0 ? 12.0 * railgunCoolant : (isRailgunActive ? 0 : 2.0);
      this.railgunHeat = Math.max(0, this.railgunHeat - railgunCoolRate * dt);
    }
    if (this.railgunHeat >= 100) {
      this.railgunOverheated = true;
    } else if (this.railgunHeat <= 75) {
      this.railgunOverheated = false;
    }

    // Heavy Railgun charging
    if (this.charging) {
      if (railgunPower > 0) {
        if (this.chargeProgress < 1.0) {
          const overheatMult = this.railgunOverheated ? 0.30 : 1.0;
          this.chargeProgress = Math.min(1.0, this.chargeProgress + (dt / this.chargeTime) * railgunThermalEff * overheatMult);
        }
      }
    }

    // Homing Torpedo Thermal Management
    const isTorpActive = this.torpedoCooldown > 0;
    if (torpCoolant < 0.5 && isTorpActive) {
      const buildRate = 35.0;
      this.torpedoHeat = Math.min(100, this.torpedoHeat + buildRate * (1 - torpCoolant) * dt);
    } else {
      const torpCoolRate = torpCoolant > 0 ? 12.0 * torpCoolant : (isTorpActive ? 0 : 2.0);
      this.torpedoHeat = Math.max(0, this.torpedoHeat - torpCoolRate * dt);
    }
    if (this.torpedoHeat >= 100) {
      this.torpedoOverheated = true;
    } else if (this.torpedoHeat <= 75) {
      this.torpedoOverheated = false;
    }
  }

  /**
   * Advances all active projectiles:
   * - Applies gravity wells to torpedoes (non-torpedo laser and railgun shots travel in straight ballistic trajectories)
   * - Deflects kinetic slugs colliding with debris chunks
   * - Steers homing torpedoes towards target (unless in Ion Nebula)
   * - Integrates positions and removes expired/destroyed entities
   *
   * @param {Array<object>} projectiles - array of active projectiles
   * @param {number} dt - timestep in seconds
   * @param {Array<object>} [ships=[]] - list of ships
   * @param {Array<object>} [gravityWells=[]] - list of gravity wells
   * @param {Array<object>} [nebulae=[]] - list of ion nebulae
   * @param {Array<object>} [debrisList=[]] - list of debris chunks
   * @returns {Array<object>} active surviving projectiles
   */
  updateProjectiles(projectiles, dt, ships = [], gravityWells = [], nebulae = [], debrisList = []) {
    const activeList = projectiles || this.projectiles;

    for (const p of activeList) {
      if (p.destroyed) continue;

      p.lifetime -= dt;
      if (p.lifetime <= 0) {
        p.destroyed = true;
        continue;
      }

      // Applies gravity wells to torpedoes (non-torpedo laser and railgun shots travel in straight ballistic trajectories)
      if (p.type === 'torpedo') {
        applyGravity(p, gravityWells, dt);
      }

      // Deflect kinetic railgun slugs colliding with debris fragments
      if (p.type === 'railgun' && debrisList && debrisList.length > 0) {
        for (const debris of debrisList) {
          const col = checkCircleCollision(p.pos, p.radius || 6, debris.pos, debris.radius || 20);
          if (col.hit) {
            // Elastic deflection along 3D collision normal
            const nx = col.normal.x;
            const ny = col.normal.y;
            const nz = col.normal.z || 0;
            const dot = p.vel.x * nx + p.vel.y * ny + (p.vel.z || 0) * nz;
            p.vel.x -= 2 * dot * nx;
            p.vel.y -= 2 * dot * ny;
            p.vel.z = (p.vel.z || 0) - 2 * dot * nz;

            const hSpeed = Math.hypot(p.vel.x, p.vel.y);
            const totalSpeed = Math.hypot(hSpeed, p.vel.z || 0);
            if (totalSpeed > 1e-4) {
              p.angle = Math.atan2(p.vel.y, p.vel.x);
              p.aimPitch = Math.atan2(p.vel.z || 0, Math.max(1e-4, hSpeed));
            }
            p.deflected = true;
            break;
          }
        }
      }

      // Homing Torpedo steering & Ion Storm disruption
      if (p.type === 'torpedo') {
        const torpInNebula = nebulae.some(neb => Math.hypot(p.pos.x - neb.pos.x, p.pos.y - neb.pos.y, (p.pos.z ?? 0) - (neb.pos.z ?? 0)) <= neb.radius);
        const targetShip = ships.find(s => s.id === p.targetId);
        const targetPos = targetShip ? (targetShip.body?.pos || targetShip.pos) : null;
        const targetInNebula = targetPos && nebulae.some(neb => Math.hypot(targetPos.x - neb.pos.x, targetPos.y - neb.pos.y, (targetPos.z ?? 0) - (neb.pos.z ?? 0)) <= neb.radius);

        if (torpInNebula || targetInNebula) {
          p.lockBroken = true;
        }

        if (!p.lockBroken && targetShip && (targetShip.hullHp == null || targetShip.hullHp > 0) && targetPos) {
          // Steer towards target in 3D
          const dx = targetPos.x - p.pos.x;
          const dy = targetPos.y - p.pos.y;
          const dz = (targetPos.z ?? 0) - (p.pos.z ?? 0);

          const desiredAngle = Math.atan2(dy, dx);
          const currentAngle = Math.atan2(p.vel.y, p.vel.x);
          let diff = (desiredAngle - currentAngle) % (2 * Math.PI);
          if (diff > Math.PI) diff -= 2 * Math.PI;
          if (diff < -Math.PI) diff += 2 * Math.PI;

          const maxTurn = (p.turnRate || 2.0) * dt;
          const turn = Math.max(-maxTurn, Math.min(maxTurn, diff));
          const newAngle = currentAngle + turn;

          const distXY = Math.hypot(dx, dy);
          const desiredPitch = Math.atan2(dz, Math.max(1e-4, distXY));
          const currentPitch = Math.atan2(p.vel.z || 0, Math.max(1e-4, Math.hypot(p.vel.x, p.vel.y)));
          let diffPitch = desiredPitch - currentPitch;
          const turnPitch = Math.max(-maxTurn, Math.min(maxTurn, diffPitch));
          const newPitch = currentPitch + turnPitch;

          const speed = p.speed || Math.hypot(p.vel.x, p.vel.y, p.vel.z || 0);

          p.vel.x = Math.cos(newPitch) * Math.cos(newAngle) * speed;
          p.vel.y = Math.cos(newPitch) * Math.sin(newAngle) * speed;
          p.vel.z = Math.sin(newPitch) * speed;
          p.aimAngle = newAngle;
          p.aimPitch = newPitch;
        }
      }

      // Position integration
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z = (p.pos.z || 0) + (p.vel.z || 0) * dt;

      // Arena sphere boundary culling
      if (Math.hypot(p.pos.x, p.pos.y, p.pos.z || 0) > ARENA_RADIUS) {
        p.destroyed = true;
      }
    }

    const surviving = activeList.filter(p => !p.destroyed && p.lifetime > 0);
    if (!projectiles) {
      this.projectiles = surviving;
    }
    return surviving;
  }
}

/**
 * Handles Railgun slug impact on target ship, shields, and Engineer grid.
 *
 * @param {object} slug - { damage, targetedSubsystem, pos, vel }
 * @param {object} targetShip - { id, pos, vel, angle, rollState, hullHp, maxHullHp, thrusters, mainDrive }
 * @param {object} targetShields - ShieldSystem instance
 * @param {object} targetGrid - ConduitGrid10x10 instance
 * @param {function} [rng=Math.random]
 * @param {object|null} [targetWeapons=null]
 * @param {object|null} [targetHyperspace=null]
 * @returns {object} { penetrated, absorbed, overflow, damagedSubsystem, brokenTiles }
 */
export function applyRailgunImpact(slug, targetShip, targetShields, targetGrid, rng = Math.random, targetWeapons = null, targetHyperspace = null) {
  const shipPos = targetShip.pos || targetShip.body?.pos || { x: 0, y: 0, z: 0 };
  const hitVec = {
    x: slug.pos.x - shipPos.x,
    y: slug.pos.y - shipPos.y,
    z: (slug.pos.z ?? 0) - (shipPos.z ?? 0),
  };
  const hitAngle = Math.atan2(hitVec.y, hitVec.x);

  let shieldRes = null;
  let preHp = 0;
  if (targetShields && typeof targetShields.absorbDamage === 'function') {
    let quad;
    if (typeof targetShip.getEffectiveQuadrant === 'function') {
      quad = targetShip.getEffectiveQuadrant(hitVec);
    } else if (typeof targetShip.body?.getEffectiveQuadrant === 'function') {
      quad = targetShip.body.getEffectiveQuadrant(hitVec);
    } else {
      const getQuad = typeof targetShields.getQuadrantForAngle === 'function'
        ? targetShields.getQuadrantForAngle.bind(targetShields)
        : getQuadrantForAngle;
      quad = getQuad(hitAngle, targetShip.angle || 0, targetShip.rollState || 0);
    }
    const isPowered = typeof targetShields.isQuadrantPowered === 'function'
      ? targetShields.isQuadrantPowered(quad)
      : true;
    preHp = typeof targetShields.getEffectiveHp === 'function'
      ? targetShields.getEffectiveHp(quad)
      : (isPowered ? (targetShields.hp?.[quad] ?? 0) : 0);

    const damageToAbsorb = Math.max(slug.damage, preHp);
    const absorbed = Math.min(preHp, damageToAbsorb);
    if (isPowered && absorbed > 0 && targetShields.hp && quad in targetShields.hp) {
      targetShields.hp[quad] -= absorbed;
    }
    const overflow = damageToAbsorb - absorbed;
    const shieldDepleted = (isPowered ? (targetShields.hp?.[quad] ?? 0) : 0) <= 0;
    const candidates = DEFAULT_QUADRANT_SUBSYSTEMS[quad];
    const damagedSubsystem = candidates ? candidates[Math.floor(rng() * candidates.length)] : null;

    shieldRes = {
      quadrant: quad,
      absorbed,
      overflow,
      shieldDepleted,
      powered: isPowered,
      damagedSubsystem,
    };
  }

  const overflow = shieldRes ? Math.max(0, slug.damage - preHp) : slug.damage;
  const absorbed = shieldRes ? Math.min(preHp, slug.damage) : 0;
  const penetrated = !shieldRes || shieldRes.overflow > 0 || shieldRes.shieldDepleted;

  let damagedSubsystem = null;
  let brokenTiles = [];

  const weapons = targetWeapons || targetShip?.weaponsRef || targetShip?.weapons || null;
  const hyperspaceState = targetHyperspace || targetShip?.hyperspace || null;

  if (penetrated) {
    // Deal hull damage
    if (typeof targetShip.hullHp === 'number') {
      targetShip.hullHp = Math.max(0, targetShip.hullHp - overflow);
    }

    // Damage targeted subsystem or default from shield quadrant
    damagedSubsystem = slug.targetedSubsystem || shieldRes?.damagedSubsystem || 'bowPort';
    if (targetShip.thrusters && targetShip.thrusters[damagedSubsystem]) {
      targetShip.thrusters[damagedSubsystem].health = Math.max(0, targetShip.thrusters[damagedSubsystem].health - 60);
    } else if (targetShip.mainDrive && damagedSubsystem === 'mainDrive') {
      targetShip.mainDrive.health = Math.max(0, targetShip.mainDrive.health - 60);
    }

    if (damagedSubsystem === 'weapons_railgun' && weapons?.railgunHardware) {
      weapons.railgunHardware.health = Math.max(0, weapons.railgunHardware.health - 55);
    } else if (damagedSubsystem === 'sas_computer' && weapons?.stabilizerHardware) {
      weapons.stabilizerHardware.health = Math.max(0, weapons.stabilizerHardware.health - 55);
    } else if (damagedSubsystem === 'weapons_laser' && weapons?.laserHardware) {
      weapons.laserHardware.health = Math.max(0, weapons.laserHardware.health - 55);
    } else if (damagedSubsystem === 'hyperspace' && hyperspaceState) {
      const roll = typeof rng === 'function' ? rng() : Math.random();
      const dmg = 25 + Math.floor(roll * 16);
      const currHealth = typeof hyperspaceState.health === 'number' ? hyperspaceState.health : 100;
      hyperspaceState.health = Math.max(0, currHealth - dmg);
    }

    // Breaks 1–3 tiles on the enemy's 10x10 Engineer grid scaled by overflow (overflow / 90)
    if (targetGrid && typeof targetGrid.damageRandomTiles === 'function') {
      const tileCount = Math.min(3, Math.max(1, Math.floor(overflow / 90)));
      if (tileCount > 0) {
        brokenTiles = targetGrid.damageRandomTiles(tileCount, rng);
      }
    }
  }

  return {
    penetrated,
    absorbed,
    overflow,
    damagedSubsystem,
    brokenTiles,
    powered: shieldRes ? Boolean(shieldRes.powered) : false,
  };
}

/**
 * Handles Torpedo impact on target ship, shields, and Engineer grid.
 * EMP torpedoes call targetGrid.applyEmpBlast(r, c, 8.0).
 *
 * @param {object} torpedo - { damage, torpedoType, empDuration, pos }
 * @param {object} targetShip - target ship
 * @param {object} targetShields - ShieldSystem
 * @param {object} targetGrid - ConduitGrid10x10
 * @returns {object} { absorbed, overflow, empApplied }
 */
export function applyTorpedoImpact(torpedo, targetShip, targetShields, targetGrid) {
  const shipPos = targetShip.pos || targetShip.body?.pos || { x: 0, y: 0, z: 0 };
  const hitVec = {
    x: torpedo.pos.x - shipPos.x,
    y: torpedo.pos.y - shipPos.y,
    z: (torpedo.pos.z ?? 0) - (shipPos.z ?? 0),
  };
  const hitAngle = Math.atan2(hitVec.y, hitVec.x);
  let shieldRes = null;
  let preHp = 0;

  if (targetShields && typeof targetShields.absorbDamage === 'function') {
    let quad;
    if (typeof targetShip.getEffectiveQuadrant === 'function') {
      quad = targetShip.getEffectiveQuadrant(hitVec);
    } else if (typeof targetShip.body?.getEffectiveQuadrant === 'function') {
      quad = targetShip.body.getEffectiveQuadrant(hitVec);
    } else {
      const getQuad = typeof targetShields.getQuadrantForAngle === 'function'
        ? targetShields.getQuadrantForAngle.bind(targetShields)
        : getQuadrantForAngle;
      quad = getQuad(hitAngle, targetShip.angle || 0, targetShip.rollState || 0);
    }
    const isPowered = typeof targetShields.isQuadrantPowered === 'function'
      ? targetShields.isQuadrantPowered(quad)
      : true;
    preHp = typeof targetShields.getEffectiveHp === 'function'
      ? targetShields.getEffectiveHp(quad)
      : (isPowered ? (targetShields.hp?.[quad] ?? 0) : 0);

    const damageToAbsorb = preHp > 0 ? Math.max(torpedo.damage, preHp) : torpedo.damage;
    const absorbed = Math.min(preHp, damageToAbsorb);
    if (isPowered && absorbed > 0 && targetShields.hp && quad in targetShields.hp) {
      targetShields.hp[quad] -= absorbed;
    }
    const overflow = damageToAbsorb - absorbed;
    const shieldDepleted = (isPowered ? (targetShields.hp?.[quad] ?? 0) : 0) <= 0;

    shieldRes = {
      quadrant: quad,
      absorbed,
      overflow,
      shieldDepleted,
      powered: isPowered,
    };
  }

  const overflow = shieldRes ? Math.max(0, torpedo.damage - preHp) : torpedo.damage;
  const absorbed = shieldRes ? Math.min(preHp, torpedo.damage) : 0;

  if (typeof targetShip.hullHp === 'number') {
    targetShip.hullHp = Math.max(0, targetShip.hullHp - overflow);
  }

  let brokenTiles = [];
  if (targetGrid && typeof targetGrid.damageRandomTiles === 'function' && overflow >= 90) {
    const tileCount = Math.min(3, Math.floor(overflow / 90));
    if (tileCount > 0) {
      brokenTiles = targetGrid.damageRandomTiles(tileCount);
    }
  }

  let empApplied = false;
  if (torpedo.torpedoType === 'emp_torpedoes' || torpedo.empDuration > 0) {
    if (targetGrid && typeof targetGrid.applyEmpBlast === 'function') {
      targetGrid.applyEmpBlast(4, 5, torpedo.empDuration || 8.0);
      empApplied = true;
    }
  }

  return {
    absorbed,
    overflow,
    empApplied,
    brokenTiles,
    powered: shieldRes ? Boolean(shieldRes.powered) : false,
  };
}

/**
 * Applies kinetic or explosive damage to an asteroid.
 * Spawns dynamic debris fragments on chip damage or full shatter.
 *
 * @param {object} asteroid - { id, pos, radius, hp, maxHp, destroyed }
 * @param {number} damage - damage amount dealt
 * @param {object|null} impactPos - { x, y } impact coordinates
 * @param {object} [opts={}] - { chipDebris: boolean, shatter: boolean, rng: function }
 * @returns {{ hit: boolean, hp?: number, maxHp?: number, destroyed: boolean, spawnedChunks: Array<object> }}
 */
export function damageAsteroid(asteroid, damage, impactPos, opts = {}) {
  if (!asteroid || asteroid.destroyed) {
    return { hit: false, destroyed: false, spawnedChunks: [] };
  }

  if (asteroid.maxHp == null) {
    asteroid.maxHp = Math.round((asteroid.radius || 100) * 2.5);
  }
  if (asteroid.hp == null) {
    asteroid.hp = asteroid.maxHp;
  }

  if (opts.shatter) {
    asteroid.hp = 0;
  } else {
    asteroid.hp = Math.max(0, asteroid.hp - damage);
  }

  const rng = opts.rng || Math.random;
  let spawnedChunks = [];

  if (asteroid.hp <= 0) {
    asteroid.destroyed = true;
    const count = 4 + Math.floor(rng() * 5); // 4..8 debris chunks
    spawnedChunks = createAsteroidDebrisChunks(asteroid, impactPos, count, rng);
  } else if (opts.chipDebris) {
    const count = 1 + Math.floor(rng() * 2); // 1..2 debris chunks
    spawnedChunks = createAsteroidDebrisChunks(asteroid, impactPos, count, rng);
  }

  return {
    hit: true,
    hp: asteroid.hp,
    maxHp: asteroid.maxHp,
    destroyed: Boolean(asteroid.destroyed),
    spawnedChunks,
  };
}

