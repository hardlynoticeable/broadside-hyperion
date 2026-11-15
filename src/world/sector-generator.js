/**
 * BROADSIDE HYPERION — Procedural Sector Generator & Sector Hazards
 *
 * Implements deterministic seeded sector generation (Mulberry32 PRNG),
 * procedural asteroids with ore veins, drifting rigid-body debris fields,
 * concealed magnetic proximity tether mines, micro-singularities (gravity wells),
 * ion storm nebulae, and orbital munitions derelict (+3 torpedo resupply).
 */

import {
  ARENA_RADIUS,
  SECTOR_Z_HALF_EXTENT,
  DEFAULT_SPAWN_OFFSET_X,
  clampAngularVelocity,
} from '../physics/constants.js';

export const SHIP_SPAWN_POINTS = [
  { x: -DEFAULT_SPAWN_OFFSET_X, y: 0, z: 0 },
  { x: DEFAULT_SPAWN_OFFSET_X, y: 0, z: 0 },
];
// Counter-clockwise orbital headings on the arena map:
// Alpha at (-2200, 0) faces South (+PI/2); Omega at (+2200, 0) faces North (-PI/2).
export const SHIP_SPAWN_ANGLES = [Math.PI / 2, -Math.PI / 2];
export const SPAWN_SAFE_RADIUS = 750; // Minimum edge-to-spawn clearance (m)

/**
 * Returns true iff for every spawn point in spawnPoints:
 * distance - entityRadius >= SPAWN_SAFE_RADIUS + extraMargin
 *
 * @param {{x: number, y: number, z?: number}} pos - entity candidate position
 * @param {number} [entityRadius=0] - collision/protrusion/trigger radius of entity
 * @param {number} [extraMargin=0] - additional safety buffer
 * @param {Array<{x: number, y: number, z?: number}>} [spawnPoints=SHIP_SPAWN_POINTS] - ship spawn points
 * @returns {boolean}
 */
export function isClearOfSpawns(pos, entityRadius = 0, extraMargin = 0, spawnPoints = SHIP_SPAWN_POINTS) {
  const pz = pos.z ?? 0;
  return spawnPoints.every(sp =>
    (Math.hypot(pos.x - sp.x, pos.y - sp.y, pz - (sp.z ?? 0)) - entityRadius) >= (SPAWN_SAFE_RADIUS + extraMargin)
  );
}

/**
 * Randomly samples a position between minR and maxR that is clear of all ship spawns in 3D.
 * Falls back deterministically to the Y-axis corridor far from (+-900, 0) if maxAttempts exhausted.
 *
 * @param {function(): number} rng - PRNG
 * @param {number} minR - minimum distance from sector center
 * @param {number} maxR - maximum distance from sector center
 * @param {number} entityRadius - radius of entity
 * @param {number} [extraMargin=0] - extra buffer
 * @param {number} [maxAttempts=40] - maximum random attempts
 * @param {number} [zHalfExtent=0] - half-extent in Z
 * @returns {{x: number, y: number, z: number}}
 */
export function sampleSafePosition(rng, minR, maxR, entityRadius, extraMargin = 0, maxAttempts = 40, zHalfExtent = 0) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const angle = rng() * Math.PI * 2;
    const dist = minR + rng() * (maxR - minR);
    const z = zHalfExtent > 0 ? (rng() * 2 - 1) * zHalfExtent : 0;
    const candidate = {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      z,
    };
    if (isClearOfSpawns(candidate, entityRadius, extraMargin)) {
      return candidate;
    }
  }
  // Deterministic Fallback: place along the Y-axis corridor where |x| is far from +-900
  const signY = rng() < 0.5 ? 1 : -1;
  const fallbackY = signY * Math.max(minR, SPAWN_SAFE_RADIUS + entityRadius + extraMargin + 150);
  const fallbackX = (rng() - 0.5) * 300; // |x| <= 150, so >= 750m in X alone from +-900
  const fallbackZ = zHalfExtent > 0 ? (rng() * 2 - 1) * (zHalfExtent * 0.7) : 0;
  return { x: fallbackX, y: fallbackY, z: fallbackZ };
}

/**
 * Creates a deterministic Mulberry32 pseudo-random number generator.
 *
 * @param {number} seed - integer seed
 * @returns {function(): number} PRNG returning float in [0, 1)
 */
export function createSeededRng(seed = 12345) {
  let s = Math.floor(seed) >>> 0;
  return function() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a complete deterministic sector layout with celestial bodies,
 * hazards, debris fields, and derelicts.
 *
 * @param {number} [seed=12345] - PRNG seed
 * @param {object} [options={}] - optional overrides { forceTetherMine, arenaRadius }
 * @returns {object} sector state
 */
export function generateSector(seed = 12345, options = {}) {
  const rng = createSeededRng(seed);
  const arenaRadius = options.arenaRadius || ARENA_RADIUS || 5250;

  // 1. Procedural Asteroids (14–18 craggy asteroids)
  const numAsteroids = 14 + Math.floor(rng() * 5); // 14 to 18
  const asteroids = [];
  const oreTypes = ['titanium', 'plasma_crystal', 'ferrite'];

  for (let i = 0; i < numAsteroids; i++) {
    const radius = 70 + rng() * 110; // 70m to 180m
    let pos = null;

    let targetZ;
    if (i === 0) {
      targetZ = 0; // Primary orbital anchor asteroid
    } else if (i % 3 === 1) {
      targetZ = 200 + rng() * 600; // Above z > 150
    } else if (i % 3 === 2) {
      targetZ = -200 - rng() * 600; // Below z < -150
    } else {
      targetZ = (rng() * 2 - 1) * 120; // Near orbital plane
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const angle = rng() * Math.PI * 2;
      const dist = 825 + rng() * (arenaRadius * 0.78 - 825);
      const candidate = {
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        z: targetZ,
      };
      const overlaps = asteroids.some(
        a => Math.hypot(candidate.x - a.pos.x, candidate.y - a.pos.y, candidate.z - a.pos.z) < a.radius + radius
      );
      if (!overlaps && isClearOfSpawns(candidate, radius * 1.2, 0)) {
        pos = candidate;
        break;
      }
    }

    if (!pos) {
      for (let fbAttempt = 0; fbAttempt < 40; fbAttempt++) {
        const signY = rng() < 0.5 ? 1 : -1;
        const fallbackY = signY * Math.max(825, SPAWN_SAFE_RADIUS + radius * 1.2 + 150 + rng() * 400);
        const fallbackX = (rng() - 0.5) * 300;
        const candidate = { x: fallbackX, y: fallbackY, z: targetZ };
        const overlaps = asteroids.some(
          a => Math.hypot(candidate.x - a.pos.x, candidate.y - a.pos.y, candidate.z - a.pos.z) < a.radius + radius
        );
        if (!overlaps && isClearOfSpawns(candidate, radius * 1.2, 0)) {
          pos = candidate;
          break;
        }
      }
      if (!pos) {
        const signY = rng() < 0.5 ? 1 : -1;
        pos = {
          x: (rng() - 0.5) * 300,
          y: signY * (SPAWN_SAFE_RADIUS + radius * 1.2 + 200 + i * 50),
          z: targetZ,
        };
      }
    }

    // Craggy polygon vertices
    const vertexCount = 10 + Math.floor(rng() * 6);
    const vertices = [];
    for (let v = 0; v < vertexCount; v++) {
      const vAngle = (v / vertexCount) * Math.PI * 2;
      const vDist = radius * (0.8 + rng() * 0.4);
      vertices.push({
        x: pos.x + Math.cos(vAngle) * vDist,
        y: pos.y + Math.sin(vAngle) * vDist,
        z: pos.z,
      });
    }

    // Ore veins
    const oreVeins = [];
    const veinCount = 1 + Math.floor(rng() * 3);
    for (let o = 0; o < veinCount; o++) {
      oreVeins.push({
        type: oreTypes[Math.floor(rng() * oreTypes.length)],
        angle: rng() * Math.PI * 2,
        depth: 0.2 + rng() * 0.6,
      });
    }

    asteroids.push({
      id: 'asteroid_' + i,
      pos,
      radius,
      vertices,
      oreVeins,
      maxHp: Math.round(radius * 2.5),
      hp: Math.round(radius * 2.5),
      destroyed: false,
    });
  }

  // 2. Debris Fields (80%+ spawn chance across sectors; default sector seed 12345 has 2 fields)
  // Across 100 seeds, >= 80% contain 1–3 debris fields.
  const hasDebris = (seed === 12345 || options.forceTetherMine) ? true : (rng() < 0.85);
  const debrisFields = [];
  const tetherMines = [];

  let numFields = 0;
  if (hasDebris) {
    numFields = (seed === 12345) ? 2 : (1 + Math.floor(rng() * 2));
  }

  for (let f = 0; f < numFields; f++) {
    const fieldRadius = 280 + rng() * 120; // 280..400m
    const fieldPos = sampleSafePosition(rng, 1125, arenaRadius * 0.72, fieldRadius, 50, 40, 750);

    // 12–25 drifting rigid-body debris chunks
    const numChunks = 12 + Math.floor(rng() * 14);
    const debrisChunks = [];

    for (let c = 0; c < numChunks; c++) {
      const cAngle = rng() * Math.PI * 2;
      const cDist = rng() * fieldRadius;
      let pos = {
        x: fieldPos.x + Math.cos(cAngle) * cDist,
        y: fieldPos.y + Math.sin(cAngle) * cDist,
        z: (fieldPos.z ?? 0) + (rng() - 0.5) * (fieldRadius * 0.4),
      };
      const chunkRadius = 6 + rng() * 16;
      if (!isClearOfSpawns(pos, chunkRadius, 10)) {
        pos = { x: fieldPos.x, y: fieldPos.y, z: fieldPos.z ?? 0 };
      }
      const mass = 80 + rng() * 160; // 80..240 kg

      debrisChunks.push({
        id: `chunk_${f}_${c}`,
        pos,
        vel: {
          x: (rng() - 0.5) * 8,
          y: (rng() - 0.5) * 8,
          z: (rng() - 0.5) * 4,
        },
        angle: rng() * Math.PI * 2,
        omega: (rng() - 0.5) * 1.5,
        radius: chunkRadius,
        mass,
        vertices: [
          { x: -chunkRadius, y: -chunkRadius },
          { x: chunkRadius, y: -chunkRadius },
          { x: chunkRadius, y: chunkRadius },
          { x: -chunkRadius, y: chunkRadius },
        ],
      });
    }

    // Tether Mines: 25–30% spawn chance per debris field (or forced via options)
    const spawnMine = options.forceTetherMine || (rng() < 0.28);
    let mine = null;

    if (spawnMine) {
      const triggerRadius = 150;
      let minePos = {
        x: fieldPos.x + (rng() - 0.5) * fieldRadius * 0.5,
        y: fieldPos.y + (rng() - 0.5) * fieldRadius * 0.5,
        z: (fieldPos.z ?? 0) + (rng() - 0.5) * (fieldRadius * 0.3),
      };
      if (!isClearOfSpawns(minePos, triggerRadius, 20)) {
        minePos = { x: fieldPos.x, y: fieldPos.y, z: fieldPos.z ?? 0 };
      }

      mine = {
        id: 'tether_mine_' + f,
        fieldId: 'field_' + f,
        pos: minePos,
        vel: { x: 0, y: 0, z: 0 },
        triggerRadius,
        blinkPhase: rng(),
        armed: true,
        tetheredShipId: null,
      };
      tetherMines.push(mine);
    }

    debrisFields.push({
      id: 'field_' + f,
      pos: fieldPos,
      radius: fieldRadius,
      debrisChunks,
      tetherMine: mine,
    });
  }

  // 3. Micro-Singularities / Gravity Wells (1–2 wells)
  const numWells = 1 + Math.floor(rng() * 2);
  const gravityWells = [];
  for (let w = 0; w < numWells; w++) {
    const wellZ = (w % 2 === 0 ? 1 : -1) * (270 + rng() * 480);
    const pos = sampleSafePosition(rng, 1425, arenaRadius * 0.65, 350, 0, 40, 0);
    pos.z = wellZ;
    gravityWells.push({
      id: 'singularity_' + w,
      pos,
      mass: 350 + rng() * 250,
      eventHorizonRadius: 35,
      pullRadius: 750,
      epsilon: 25,
    });
  }

  // 4. Ion Storm Nebulae (1–3 clouds)
  const numNebulae = 1 + Math.floor(rng() * 3);
  const ionNebulae = [];
  for (let n = 0; n < numNebulae; n++) {
    const radius = 380 + rng() * 180; // 380..560m
    const nebZ = (n % 2 === 0 ? 1 : -1) * (240 + rng() * 480);
    const pos = sampleSafePosition(rng, 1050, arenaRadius * 0.68, radius, 0, 40, 0);
    pos.z = nebZ;
    ionNebulae.push({
      id: 'nebula_' + n,
      pos,
      radius,
      surgeInterval: 12.0,
      surgeTimer: 0,
    });
  }

  // 5. Orbital Munitions Derelict (1 supply hulk)
  // Anchored on orbital plane (z = 0) with 3D velocity drift for resupply compatibility
  const dPos = sampleSafePosition(rng, 675, 1800, 35, 0, 40, 0);
  dPos.z = 0;
  const velZ = (rng() - 0.5) * 2;
  const munitionsDerelict = {
    id: 'derelict_alpha',
    pos: dPos,
    vel: {
      x: (rng() - 0.5) * 4,
      y: (rng() - 0.5) * 4,
      z: Math.abs(velZ) < 0.1 ? 0.5 : velZ,
    },
    radius: 35,
    resupplyRange: 80,
    maxRelativeSpeed: 15,
    requiredTractorTime: 5.0,
    progressByShip: {},
    cooldown: 0,
  };

  return {
    seed,
    arenaRadius,
    asteroids,
    debrisFields,
    tetherMines,
    gravityWells,
    ionNebulae,
    munitionsDerelict,
  };
}

/**
 * Updates tether mines: triggers proximity detonation when ship comes within 150m.
 * Imparts violent rotational spin impulse to the ship and damages an external RCS bank.
 *
 * @param {Array<object>} mines - array of tether mines
 * @param {Array<object>} ships - array of ships
 * @param {number} dt - timestep in seconds
 * @returns {Array<object>} detonations triggered during this step
 */
export function updateTetherMines(mines = [], ships = [], dt = 1 / 60) {
  const detonations = [];

  for (const mine of mines) {
    if (!mine.armed || mine.destroyed) continue;

    mine.blinkPhase = (mine.blinkPhase || 0) + dt;

    if (mine.vel) {
      mine.pos.x += (mine.vel.x || 0) * dt;
      mine.pos.y += (mine.vel.y || 0) * dt;
      mine.pos.z = (mine.pos.z || 0) + (mine.vel.z || 0) * dt;
    }

    for (const ship of ships) {
      const sPos = ship.body?.pos || ship.pos;
      if (!sPos) continue;
      const dx = sPos.x - mine.pos.x;
      const dy = sPos.y - mine.pos.y;
      const dz = (sPos.z ?? 0) - (mine.pos.z ?? 0);
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= (mine.triggerRadius || 150)) {
        // Mine triggers!
        mine.armed = false;
        mine.triggered = true;
        mine.tetheredShipId = ship.id;

        // Impart violent rotational impulse (at least 2.5 rad/s)
        const sign = (ship.omega == null || ship.omega >= 0) ? 1 : -1;
        ship.omega = (ship.omega || 0) + sign * 2.5;
        clampAngularVelocity(ship);
        if (ship.body) {
          clampAngularVelocity(ship.body);
        }

        // Damage an external RCS thruster bank
        let damagedBank = null;
        if (ship.thrusters) {
          const bankKeys = ['bowPort', 'bowStarboard', 'sternPort', 'sternStarboard'];
          damagedBank = bankKeys.find(k => ship.thrusters[k]?.health > 0) || 'bowPort';
          if (ship.thrusters[damagedBank]) {
            ship.thrusters[damagedBank].health = Math.max(0, ship.thrusters[damagedBank].health - 50);
          }
        }

        // Damage 1 random conduit tile on the Engineer's 10x10 grid
        if (ship.grid && typeof ship.grid.damageRandomTiles === 'function') {
          ship.grid.damageRandomTiles(1);
        }

        detonations.push({
          mineId: mine.id,
          shipId: ship.id,
          damagedBank,
        });
        break;
      } else if (dist <= 300 && mine.vel) {
        // 3D chase acceleration towards ship
        const chaseAcc = 18;
        mine.vel.x += (dx / dist) * chaseAcc * dt;
        mine.vel.y += (dy / dist) * chaseAcc * dt;
        mine.vel.z = (mine.vel.z || 0) + (dz / dist) * chaseAcc * dt;
      }
    }
  }

  return detonations;
}

/**
 * Updates Ion Nebulae: marks ships inside nebulae, disrupts locks, and triggers
 * periodic conduit surges flipping 1–2 tiles on the Engineer's 10x10 grid.
 *
 * @param {Array<object>} nebulae - array of ion nebulae
 * @param {Array<object>} ships - array of ships
 * @param {number} dt - timestep in seconds
 * @param {function} [rng=Math.random]
 */
export function updateIonNebulae(nebulae = [], ships = [], dt = 1 / 60, rng = Math.random) {
  for (const ship of ships) {
    ship.inNebula = false;
    const sPos = ship.body?.pos || ship.pos;
    if (!sPos) continue;

    for (const neb of nebulae) {
      const dx = sPos.x - neb.pos.x;
      const dy = sPos.y - neb.pos.y;
      const dz = (sPos.z ?? 0) - (neb.pos.z ?? 0);
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= neb.radius) {
        ship.inNebula = true;
        neb.surgeTimer = (neb.surgeTimer || 0) + dt;

        if (neb.surgeTimer >= (neb.surgeInterval || 8.0)) {
          neb.surgeTimer = 0;
          if (ship.grid && typeof ship.grid.applyIonStormSurge === 'function') {
            ship.grid.applyIonStormSurge(rng);
          }
        }
      }
    }
  }
}

/**
 * Updates Orbital Munitions Derelict:
 * Resupplies +3 Torpedoes to a ship that stays within 80m with relative speed < 15 m/s
 * and has cargo_tractor powered continuously for 5.0 seconds.
 *
 * @param {object} derelict - munitions derelict
 * @param {Array<object>} ships - array of ships
 * @param {number} dt - timestep in seconds
 * @returns {Array<object>} list of resupply events this tick
 */
export function updateMunitionsDerelict(derelict, ships = [], dt = 1 / 60) {
  const events = [];
  if (!derelict) return events;

  // Move derelict drifting in 3D
  if (derelict.vel) {
    derelict.pos.x += (derelict.vel.x || 0) * dt;
    derelict.pos.y += (derelict.vel.y || 0) * dt;
    derelict.pos.z = (derelict.pos.z || 0) + (derelict.vel.z || 0) * dt;
  }

  for (const ship of ships) {
    const shipId = ship.id || 'alpha';
    const sPos = ship.body?.pos || ship.pos;
    const sVel = ship.body?.vel || ship.vel;
    if (!sPos) continue;
    const dx = sPos.x - derelict.pos.x;
    const dy = sPos.y - derelict.pos.y;
    const dz = (sPos.z ?? 0) - (derelict.pos.z ?? 0);
    const dist = Math.hypot(dx, dy, dz);
    const dvx = (sVel?.x || 0) - (derelict.vel?.x || 0);
    const dvy = (sVel?.y || 0) - (derelict.vel?.y || 0);
    const dvz = (sVel?.z || 0) - (derelict.vel?.z || 0);
    const relSpeed = Math.hypot(dvx, dvy, dvz);

    const tractorOnline = !ship.destroyed && (
      ship.powerMap?.reactorOnline
        ?? ship.grid?.lastPowerMap?.reactorOnline
        ?? (ship.powerMap?.cargo_tractor !== undefined ? ship.powerMap.cargo_tractor > 0 : true)
    );

    const inRange = dist <= (derelict.resupplyRange || 80);
    const slowEnough = relSpeed < (derelict.maxRelativeSpeed || 15);
    const powered = tractorOnline;

    if (inRange && slowEnough && powered) {
      derelict.progressByShip[shipId] = (derelict.progressByShip[shipId] || 0) + dt;

      if (derelict.progressByShip[shipId] >= (derelict.requiredTractorTime || 5.0)) {
        if (ship.weapons && typeof ship.weapons.resupplyTorpedoes === 'function') {
          ship.weapons.resupplyTorpedoes(3);
        }
        derelict.progressByShip[shipId] = 0;
        events.push({
          type: 'resupply_complete',
          shipId,
          amount: 3,
        });
      }
    } else {
      derelict.progressByShip[shipId] = 0;
    }
  }

  return events;
}

/**
 * Creates ejected debris chunks when an asteroid takes chipping damage or is destroyed.
 * Matches existing debrisChunks schema:
 * { id, pos: { x, y, z }, vel: { x, y, z }, angle, omega, radius, mass, vertices }
 *
 * @param {object} asteroid - { id, pos, radius }
 * @param {object|null} impactPos - { x, y, [z] } point of impact
 * @param {number} count - number of chunks to spawn
 * @param {function} [rng=Math.random] - PRNG function
 * @returns {Array<object>} spawned debris chunks
 */
export function createAsteroidDebrisChunks(asteroid, impactPos, count, rng = Math.random) {
  const chunks = [];
  if (!asteroid || count <= 0) return chunks;

  const astPos = asteroid.pos || { x: 0, y: 0, z: 0 };
  const astRadius = asteroid.radius || 100;
  const hasImpact = impactPos && typeof impactPos.x === 'number' && typeof impactPos.y === 'number';

  for (let i = 0; i < count; i++) {
    const chunkRadius = 10 + rng() * 12; // 10..22
    const mass = 200 + rng() * 250;      // 200..450

    let theta;
    if (hasImpact && count <= 2) {
      // Chipping debris: eject around impact normal
      const baseAngle = Math.atan2(impactPos.y - astPos.y, impactPos.x - astPos.x);
      theta = baseAngle + (rng() - 0.5) * 1.0;
    } else {
      // Full shatter or undirected: distribute around perimeter
      theta = (i / Math.max(1, count)) * Math.PI * 2 + (rng() - 0.5) * (Math.PI * 2 / Math.max(1, count) * 0.7);
    }

    const spawnDist = astRadius + chunkRadius + 2 + rng() * 6;
    const pos = {
      x: astPos.x + Math.cos(theta) * spawnDist,
      y: astPos.y + Math.sin(theta) * spawnDist,
      z: astPos.z ?? 0,
    };

    const speed = 35 + rng() * 85; // 35..120 m/s
    const vz = (rng() - 0.5) * (speed * 0.35);
    const vel = {
      x: Math.cos(theta) * speed,
      y: Math.sin(theta) * speed,
      z: vz,
    };

    const angle = rng() * Math.PI * 2;
    const omega = (rng() - 0.5) * 3.0;

    chunks.push({
      id: `asteroid_chunk_${asteroid.id || 'ast'}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      pos,
      vel,
      angle,
      omega,
      radius: chunkRadius,
      mass,
      vertices: [
        { x: -chunkRadius, y: -chunkRadius },
        { x: chunkRadius, y: -chunkRadius },
        { x: chunkRadius, y: chunkRadius },
        { x: -chunkRadius, y: chunkRadius },
      ],
    });
  }

  return chunks;
}


