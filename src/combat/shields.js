/**
 * BROADSIDE HYPERION — 4-Quadrant Directional Shields
 *
 * Implements directional shields (Fore, Aft, Port, Starboard), power-based
 * regeneration, hull/subsystem penetration, and 180° Roll port/starboard
 * spatial inversion in world space.
 */

import { HULL_CLASSES } from '../physics/constants.js';

export const QUADRANT_KEYS = ['fore', 'aft', 'port', 'starboard'];
export const MIN_SHIELD_POWER = 0.1;
export const SHIELD_RECHARGE_PERCENT_PER_SEC = 0.01;

export const DEFAULT_QUADRANT_SUBSYSTEMS = {
  fore: ['bowPort', 'bowStarboard', 'sas_computer'],
  aft: ['mainDrive', 'sternPort', 'sternStarboard'],
  port: ['bowPort', 'sternPort'],
  starboard: ['bowStarboard', 'sternStarboard', 'hyperspace'],
};

/**
 * Determines which shield quadrant faces an incoming hit angle.
 * When rollState === 1 (inverted ship), Port and Starboard quadrants swap in world space!
 *
 * @param {number} worldHitAngle - world angle of incoming fire / radiation (radians)
 * @param {number} [shipAngle=0] - world heading angle of the ship (radians)
 * @param {number} [rollState=0] - 0 = normal dorsal up, 1 = inverted 180° roll
 * @returns {string} 'fore' | 'aft' | 'port' | 'starboard'
 */
export function getQuadrantForAngle(worldHitAngle, shipAngle = 0, rollState = 0) {
  let relAngle = (worldHitAngle - shipAngle) % (2 * Math.PI);
  if (relAngle > Math.PI) relAngle -= 2 * Math.PI;
  if (relAngle < -Math.PI) relAngle += 2 * Math.PI;

  if (relAngle >= -Math.PI / 4 && relAngle <= Math.PI / 4) {
    return 'fore';
  } else if (relAngle > Math.PI / 4 && relAngle <= (3 * Math.PI) / 4) {
    return rollState === 1 ? 'port' : 'starboard';
  } else if (relAngle >= (-3 * Math.PI) / 4 && relAngle < -Math.PI / 4) {
    return rollState === 1 ? 'starboard' : 'port';
  } else {
    return 'aft';
  }
}

export class ShieldSystem {
  /**
   * @param {number|string|object} maxPerQuadrant - number (default 100), hullClassKey ('corvette'|'frigate'|'dreadnought'), or quad map
   */
  constructor(maxPerQuadrant = 100) {
    let baseHp = 100;
    if (typeof maxPerQuadrant === 'number') {
      baseHp = maxPerQuadrant;
    } else if (typeof maxPerQuadrant === 'string' && HULL_CLASSES[maxPerQuadrant]) {
      // Scale shield HP by hull class: Corvette 160, Frigate 200, Dreadnought 260
      const hullScale = { corvette: 160, frigate: 200, dreadnought: 260 };
      baseHp = hullScale[maxPerQuadrant] || 100;
    }

    this.maxHp = {
      fore: typeof maxPerQuadrant === 'object' && maxPerQuadrant?.fore != null ? maxPerQuadrant.fore : baseHp,
      aft: typeof maxPerQuadrant === 'object' && maxPerQuadrant?.aft != null ? maxPerQuadrant.aft : baseHp,
      port: typeof maxPerQuadrant === 'object' && maxPerQuadrant?.port != null ? maxPerQuadrant.port : baseHp,
      starboard: typeof maxPerQuadrant === 'object' && maxPerQuadrant?.starboard != null ? maxPerQuadrant.starboard : baseHp,
    };

    this.hp = { ...this.maxHp };
    this.systemOnline = true;
    this.power = { fore: 1.0, aft: 1.0, port: 1.0, starboard: 1.0 };
    this.coolant = { fore: 1.0, aft: 1.0, port: 1.0, starboard: 1.0 };
    this.heat = { fore: 0, aft: 0, port: 0, starboard: 0 };
    this.overheated = { fore: false, aft: false, port: false, starboard: false };
    this.rechargeRate = SHIELD_RECHARGE_PERCENT_PER_SEC; // 0.01 fraction/sec of maxHp
  }

  /**
   * Enables or disables shield system online state (e.g. from power grid).
   * @param {boolean} online
   */
  setSystemOnline(online) {
    this.systemOnline = Boolean(online);
  }

  /**
   * Returns a snapshot copy of current shield state.
   */
  getSnapshot() {
    return {
      hp: { ...this.hp },
      maxHp: { ...this.maxHp },
      power: { ...this.power },
      coolant: { ...this.coolant },
      heat: { ...this.heat },
      overheated: { ...this.overheated },
      systemOnline: this.systemOnline,
    };
  }

  /**
   * Resets shield HP and thermal tracking.
   */
  reset() {
    this.systemOnline = true;
    this.hp = { ...this.maxHp };
    for (const quad of QUADRANT_KEYS) {
      this.heat[quad] = 0;
      this.overheated[quad] = false;
      this.power[quad] = 1.0;
      this.coolant[quad] = 1.0;
    }
  }

  /**
   * Updates internal power levels for each quadrant based on powerMap.
   *
   * @param {object} powerMap - subsystem power map { shields_fore, shields_aft, ... }
   */
  updatePower(powerMap = {}) {
    for (const quad of QUADRANT_KEYS) {
      const p = powerMap['shields_' + quad] ?? powerMap.shields ?? 0;
      this.power[quad] = Math.max(0, Number(p) || 0);

      if (powerMap.coolantMap) {
        const rawCool = Number(powerMap.coolantMap['shields_' + quad] ?? powerMap.coolantMap.shields);
        this.coolant[quad] = Number.isFinite(rawCool) ? Math.max(0, rawCool) : 1.0;
      } else {
        this.coolant[quad] = 1.0;
      }
    }
  }

  /**
   * Checks whether a quadrant has >= MIN_SHIELD_POWER (10% power) and shield system is online.
   *
   * @param {string} quad - 'fore' | 'aft' | 'port' | 'starboard'
   * @returns {boolean}
   */
  isQuadrantPowered(quad) {
    return Boolean(this.systemOnline) && (this.power?.[quad] ?? 0) >= MIN_SHIELD_POWER;
  }

  /**
   * Returns effective HP for a quadrant (0 if unpowered < 10% power).
   *
   * @param {string} quad - 'fore' | 'aft' | 'port' | 'starboard'
   * @returns {number}
   */
  getEffectiveHp(quad) {
    return this.isQuadrantPowered(quad) ? Math.max(0, this.hp?.[quad] ?? 0) : 0;
  }

  /**
   * Recharges each quadrant shield proportional to allocated power in powerMap (1% per second base rate).
   * If a shield has less than 10% power, it does not regenerate.
   *
   * @param {number} dt - timestep in seconds
   * @param {object} powerMap - subsystem power map { shields_fore, shields_aft, ... }
   */
  recharge(dt, powerMap = {}) {
    if (!this.systemOnline) {
      return this.getSnapshot();
    }

    for (const quad of QUADRANT_KEYS) {
      const power = Math.max(0, Number(powerMap['shields_' + quad] ?? powerMap.shields ?? this.power[quad] ?? 0) || 0);
      this.power[quad] = power;

      let coolant = 1.0;
      if (powerMap.coolantMap) {
        const rawCool = Number(powerMap.coolantMap['shields_' + quad] ?? powerMap.coolantMap.shields);
        coolant = Number.isFinite(rawCool) ? Math.max(0, rawCool) : 0;
      } else if (this.coolant[quad] != null) {
        coolant = this.coolant[quad];
      }
      this.coolant[quad] = coolant;

      // Thermal tracking: active regeneration with insufficient coolant builds heat
      const isActivelyRegenerating = power >= MIN_SHIELD_POWER && this.hp[quad] < this.maxHp[quad];
      if (coolant < 0.5 && isActivelyRegenerating) {
        const buildRate = 30.0;
        this.heat[quad] = Math.min(100, this.heat[quad] + buildRate * (1 - coolant) * dt);
      } else {
        const coolRate = coolant > 0 ? 12.0 * coolant : (isActivelyRegenerating ? 0 : 2.0);
        this.heat[quad] = Math.max(0, this.heat[quad] - coolRate * dt);
      }

      if (this.heat[quad] >= 100) {
        this.overheated[quad] = true;
      } else if (this.heat[quad] <= 75) {
        this.overheated[quad] = false;
      }

      if (power < MIN_SHIELD_POWER) {
        continue;
      }

      const coolantEff = 0.4 + 0.6 * Math.max(0, coolant);
      const overheatMult = this.overheated[quad] ? 0.25 : 1.0;
      const regenAmount = this.maxHp[quad] * this.rechargeRate * power * coolantEff * overheatMult * dt;
      this.hp[quad] = Math.min(this.maxHp[quad], this.hp[quad] + regenAmount);
    }
    return this.getSnapshot();
  }

  /**
   * Determines which shield quadrant faces an incoming hit angle.
   * When rollState === 1 (inverted ship), Port and Starboard quadrants swap in world space!
   *
   * @param {number} worldHitAngle - world angle of incoming fire / radiation (radians)
   * @param {number} [shipAngle=0] - world heading angle of the ship (radians)
   * @param {number} [rollState=0] - 0 = normal dorsal up, 1 = inverted 180° roll
   * @returns {string} 'fore' | 'aft' | 'port' | 'starboard'
   */
  getQuadrantForAngle(worldHitAngle, shipAngle = 0, rollState = 0) {
    return getQuadrantForAngle(worldHitAngle, shipAngle, rollState);
  }

  /**
   * Determines which shield quadrant faces an incoming hit angle and absorbs damage.
   * When rollState === 1 (inverted ship), Port and Starboard quadrants swap in world space!
   * If quadrant has < 10% power, it has no effect (absorbs 0, 100% overflow, stored HP untouched).
   *
   * @param {number} damage - raw incoming damage
   * @param {number} worldHitAngle - world angle of incoming fire / radiation (radians)
   * @param {number} [shipAngle=0] - world heading angle of the ship (radians)
   * @param {number} [rollState=0] - 0 = normal dorsal up, 1 = inverted 180° roll
   * @param {object} [options={}] - optional overrides (e.g. options.quadrant)
   * @returns {object} { quadrant, absorbed, overflow, shieldDepleted, powered, damagedSubsystem }
   */
  absorbDamage(damage, worldHitAngle, shipAngle = 0, rollState = 0, options = {}) {
    const quadrant = options.quadrant || this.getQuadrantForAngle(worldHitAngle, shipAngle, rollState);
    const powered = this.isQuadrantPowered(quadrant);
    const currentShieldHp = powered ? Math.max(0, this.hp[quadrant] ?? 0) : 0;
    const absorbed = Math.min(currentShieldHp, Math.max(0, damage));
    if (absorbed > 0) {
      this.hp[quadrant] -= absorbed;

      // Thermal spike on damage absorption scaled by (1 - coolant)
      const quadCoolant = Math.max(0, Math.min(1, this.coolant?.[quadrant] ?? 1.0));
      if (quadCoolant < 1.0) {
        const spike = absorbed * 0.25 * (1 - quadCoolant);
        this.heat[quadrant] = Math.min(100, (this.heat[quadrant] || 0) + spike);
        if (this.heat[quadrant] >= 100) {
          this.overheated[quadrant] = true;
        }
      }
    }
    const overflow = Math.max(0, damage - absorbed);
    const shieldDepleted = (powered ? this.hp[quadrant] : 0) <= 0;

    let damagedSubsystem = null;
    if (overflow > 0 || shieldDepleted) {
      const candidates = DEFAULT_QUADRANT_SUBSYSTEMS[quadrant];
      damagedSubsystem = candidates ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    }

    return {
      quadrant,
      absorbed,
      overflow,
      shieldDepleted,
      powered,
      damagedSubsystem,
    };
  }
}
