/**
 * BROADSIDE HYPERION — Physics Constants & Hull Specifications
 * Defines hull classes, drydock modules, thruster geometry, and global physical constants.
 */

export const MAX_PITCH_RAD = (80 * Math.PI) / 180;
export const MAX_GIMBAL_RAD = (20 * Math.PI) / 180;
export const SECTOR_Z_HALF_EXTENT = 1500;
export const DEFAULT_SPAWN_OFFSET_X = 2200;

export const SHIP_PACING_SCALE = 0.60;
export const MAX_SPIN_RATE = Math.PI; // 1 revolution every 2 seconds (~3.14159 rad/s)
export const DAMPENING_FIELD_WIDTH = 750; // outer 750m spherical shell inside ARENA_RADIUS (4500m..5250m)
export const DAMPENING_FIELD_MAX_RATE = 0.10; // up to 10% per second decay at arena edge

export const HULL_CLASSES = {
  corvette: {
    mass: 1000,
    length: 40,
    width: 20,
    height: 12,
    momentOfInertia: (1 / 12) * 1000 * (40 * 40 + 20 * 20), // 166,666.67 kg*m^2
    pitchInertia: (1 / 12) * 1000 * (40 * 40 + 12 * 12), // 145,333.33 kg*m^2
    armor: 40,
    maxHullHp: 600,
    rcsThrust: 24000,
    mainThrust: 120000,
    maxReactorPower: 8.0,
    maxTorpedoes: 6,
    rollMomentOfInertia: (1 / 6) * 1000 * (20 * 20), // 66,666.67 kg*m^2
    maxManualYawRate: 0.96,
    maxManualPitchRate: 0.78,
    maxManualRollRate: 1.32,
  },
  frigate: {
    mass: 1800,
    length: 60,
    width: 28,
    height: 18,
    momentOfInertia: (1 / 12) * 1800 * (60 * 60 + 28 * 28), // 657,600 kg*m^2
    pitchInertia: (1 / 12) * 1800 * (60 * 60 + 18 * 18), // 588,600 kg*m^2
    armor: 75,
    maxHullHp: 1000,
    rcsThrust: 39000,
    mainThrust: 192000,
    maxReactorPower: 8.0,
    maxTorpedoes: 8,
    rollMomentOfInertia: (1 / 6) * 1800 * (28 * 28), // 235,200 kg*m^2
    maxManualYawRate: 0.72,
    maxManualPitchRate: 0.60,
    maxManualRollRate: 1.08,
  },
  dreadnought: {
    mass: 3200,
    length: 90,
    width: 40,
    height: 26,
    momentOfInertia: (1 / 12) * 3200 * (90 * 90 + 40 * 40), // 2,586,666.67 kg*m^2
    pitchInertia: (1 / 12) * 3200 * (90 * 90 + 26 * 26), // 2,339,733.33 kg*m^2
    armor: 120,
    maxHullHp: 1800,
    rcsThrust: 60000,
    mainThrust: 300000,
    maxReactorPower: 8.0,
    maxTorpedoes: 12,
    rollMomentOfInertia: (1 / 6) * 3200 * (40 * 40), // 853,333.33 kg*m^2
    maxManualYawRate: 0.51,
    maxManualPitchRate: 0.45,
    maxManualRollRate: 0.84,
  },
};

export const DRYDOCK_MODULES = {
  helm: {
    overdrive_rcs: {
      name: 'Overdrive RCS',
      description: 'RCS thrust and torque increased by +35%',
      thrustMultiplier: 1.35,
    },
    reinforced_prow: {
      name: 'Reinforced Prow',
      description: 'Self-collision damage reduced by 60%; ramming damage to opponent increased by +150%',
      selfDamageMultiplier: 0.4,
      targetDamageMultiplier: 2.5,
    },
    reaction_wheel: {
      name: 'Reaction Wheel',
      description: 'Generates emergency internal angular torque (0.25 * tau_rcs) even if all RCS thruster banks are unpowered or destroyed',
      emergencyTorqueFactor: 0.25,
    },
  },
  weapons: {
    heavy_torpedoes: {
      name: 'Heavy Torpedoes',
      description: 'Standard high-yield torpedoes (400 kinetic damage)',
      damage: 400,
      type: 'kinetic',
    },
    emp_torpedoes: {
      name: 'EMP Torpedoes',
      description: 'Disables a 3x3 region on enemy Engineer grid for 8.0s; 150 kinetic damage',
      damage: 150,
      empDuration: 8.0,
      type: 'emp',
    },
    swarm_missiles: {
      name: 'Swarm Missiles',
      description: 'Magazine count scaled to 16 missiles; high turning speed; 70 kinetic damage each',
      damage: 70,
      magazineCount: 16,
      type: 'swarm',
    },
  },
  engineer: {
    standard_drones: {
      name: 'Standard Drones',
      description: '3 repair drones, speed 2.0 tiles/sec, repair rate 1.5%/sec',
      droneCount: 3,
      speed: 2.0,
      repairRate: 1.5,
    },
    turbo_drones: {
      name: 'Turbo Drones',
      description: '2 high-speed repair drones, speed 3.6 tiles/sec, repair rate 1.5%/sec',
      droneCount: 2,
      speed: 3.6,
      repairRate: 1.5,
    },
    capacitor_batteries: {
      name: 'Capacitor Batteries',
      description: 'Grid spawns 2 Capacitor tiles that can store surplus power and be discharged on demand for +2 temporary power for 12 seconds',
      surgePower: 2.0,
      surgeDuration: 12,
    },
  },
};

/**
 * Returns physical coordinates { rx, ry } relative to Center of Mass and unit force direction { fx, fy }
 * in ship-local space (+x = forward/Bow, -x = aft/Stern, -y = Port, +y = Starboard).
 */
export function getThrusterMounts(hullClassKey = 'corvette') {
  const hull = (typeof hullClassKey === 'object' && hullClassKey !== null)
    ? hullClassKey
    : (HULL_CLASSES[hullClassKey] || HULL_CLASSES.corvette);

  const L = hull.length;
  const W = hull.width;
  const H = hull.height || (W * 0.6);

  return {
    mainDrive: {
      rx: -0.5 * L,
      ry: 0,
      fx: 1,
      fy: 0,
    },
    bowPort: {
      rx: 0.4 * L,
      ry: -0.5 * W,
      fx: 0,
      fy: 1,
    },
    bowStarboard: {
      rx: 0.4 * L,
      ry: 0.5 * W,
      fx: 0,
      fy: -1,
    },
    sternPort: {
      rx: -0.4 * L,
      ry: -0.5 * W,
      fx: 0,
      fy: 1,
    },
    sternStarboard: {
      rx: -0.4 * L,
      ry: 0.5 * W,
      fx: 0,
      fy: -1,
    },
    dorsalRoll: {
      rx: 0,
      ry: 0,
      fx: 0,
      fy: 0,
      rollAxis: 1,
    },
    ventralRoll: {
      rx: 0,
      ry: 0,
      fx: 0,
      fy: 0,
      rollAxis: -1,
    },
    bowDorsal: {
      rx: 0.4 * L,
      ry: 0,
      rz: 0.35 * H,
      fx: 0,
      fy: 0,
      fz: -1,
    },
    bowVentral: {
      rx: 0.4 * L,
      ry: 0,
      rz: -0.35 * H,
      fx: 0,
      fy: 0,
      fz: 1,
    },
    sternDorsal: {
      rx: -0.4 * L,
      ry: 0,
      rz: 0.35 * H,
      fx: 0,
      fy: 0,
      fz: -1,
    },
    sternVentral: {
      rx: -0.4 * L,
      ry: 0,
      rz: -0.35 * H,
      fx: 0,
      fy: 0,
      fz: 1,
    },
  };
}

export const G = 50000.0;
export const ARENA_RADIUS = 5250.0;
export const COLLISION_RESTITUTION = 0.65;

/**
 * Clamps angular velocities of a rigid body so |omega|, |pitchOmega|, |rollOmega| <= maxRate.
 *
 * @param {object} body
 * @param {number} [maxRate=MAX_SPIN_RATE]
 */
export function clampAngularVelocity(body, maxRate = MAX_SPIN_RATE) {
  if (!body) return;
  if (typeof body.omega === 'number') {
    body.omega = Math.max(-maxRate, Math.min(maxRate, body.omega));
  }
  if (typeof body.pitchOmega === 'number') {
    body.pitchOmega = Math.max(-maxRate, Math.min(maxRate, body.pitchOmega));
  }
  if (typeof body.rollOmega === 'number') {
    body.rollOmega = Math.max(-maxRate, Math.min(maxRate, body.rollOmega));
  }
}

/**
 * Computes dampening field decay strength factor [0, 1] based on distance from arena center.
 * Uses smoothstep Hermite curve across the outer spherical shell.
 *
 * @param {object} pos - { x, y, [z] }
 * @param {number} [arenaRadius=ARENA_RADIUS]
 * @param {number} [fieldWidth=DAMPENING_FIELD_WIDTH]
 * @returns {number} 0 inside boundary, up to 1.0 at arena edge
 */
export function computeDampeningFieldStrength(pos, arenaRadius = ARENA_RADIUS, fieldWidth = DAMPENING_FIELD_WIDTH) {
  if (!pos || fieldWidth <= 0 || arenaRadius <= 0) return 0;
  const dist = Math.hypot(pos.x || 0, pos.y || 0, pos.z || 0);
  const innerRadius = Math.max(0, arenaRadius - fieldWidth);
  if (dist <= innerRadius) return 0;
  const t = Math.max(0, Math.min(1, (dist - innerRadius) / fieldWidth));
  return t * t * (3 - 2 * t);
}

