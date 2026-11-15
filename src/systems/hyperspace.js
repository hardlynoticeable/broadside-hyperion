/**
 * BROADSIDE HYPERION — Hyperspace Drive System
 *
 * Implements the Hyperspace Jump Drive state machine:
 * 'ready' -> 'charging' (10s at 100% power) -> 'jumping' (2.2s intangible warp)
 * -> 'rebooting' (Stage 1 at 4.0s: external views, Main Drive, RCS online;
 *                 Stage 2 at 7.0s: shields, weapons, sensors, SAS, drones online)
 * -> 'ready'
 *
 * Includes forward-cone destination sampling with clearance verification
 * across celestial bodies, debris, singularities, mines, and enemy ships.
 */

import { SECTOR_Z_HALF_EXTENT, ARENA_RADIUS } from '../physics/constants.js';

export const HYPERSPACE_CHARGE_DURATION_100 = 10.0;
export const HYPERSPACE_BASE_CHARGE_RATE = 0.1;
export const HYPERSPACE_CHARGE_DECAY_RATE = 0.1;
export const HYPERSPACE_JUMP_DURATION = 2.2;
export const HYPERSPACE_REBOOT_STAGE1_SEC = 4.0;
export const HYPERSPACE_REBOOT_TOTAL_SEC = 7.0;
export const HYPERSPACE_MIN_JUMP_DIST = 1200;
export const HYPERSPACE_MAX_JUMP_DIST = 4200;
export const HYPERSPACE_FORWARD_HALF_ANGLE = Math.PI / 3; // 60 deg half-angle cone (cos >= 0.5)
export const HYPERSPACE_CLEARANCE_PADDING = 180;
export const HYPERSPACE_ARENA_EDGE_MARGIN = 220;
export const HYPERSPACE_Z_EDGE_MARGIN = 200;

/**
 * Creates initial Hyperspace subsystem state.
 *
 * @returns {object}
 */
export function createHyperspaceState() {
  return {
    state: 'ready',
    charge: 0,
    jumpTimer: 0,
    rebootTimer: 0,
    health: 100,
    maxHealth: 100,
    originPos: null,
    destinationPos: null,
    warpHeadingAngle: 0,
    warpHeadingPitch: 0,
    jumpCount: 0,
  };
}

/**
 * Evaluates ship hyperspace state and returns active system restrictions.
 *
 * @param {object} ship - ship entity or hyperspace state object
 * @returns {object} restrictions dictionary
 */
export function getHyperspaceRestrictions(ship) {
  const hs = ship?.hyperspace || ship || {};
  const state = hs.state || 'ready';
  const rebootTimer = hs.rebootTimer ?? 0;

  if (state === 'jumping') {
    return {
      state: 'jumping',
      jumping: true,
      rebooting: false,
      externalViewsOnline: true,
      enginesOnline: false,
      rcsOnline: false,
      sasOnline: false,
      shieldsOnline: false,
      weaponsOnline: false,
      targetingOnline: false,
      sensorsOnline: false,
      dronesOnline: false,
      hyperspaceOnline: false,
      stage1RemainingSec: 0,
      stage2RemainingSec: 0,
    };
  }

  if (state === 'rebooting') {
    const stage1Done = rebootTimer >= (HYPERSPACE_REBOOT_STAGE1_SEC - 1e-6);
    return {
      state: 'rebooting',
      jumping: false,
      rebooting: true,
      externalViewsOnline: stage1Done,
      enginesOnline: stage1Done,
      rcsOnline: stage1Done,
      sasOnline: false,
      shieldsOnline: false,
      weaponsOnline: false,
      targetingOnline: false,
      sensorsOnline: false,
      dronesOnline: false,
      hyperspaceOnline: false,
      stage1RemainingSec: Math.max(0, HYPERSPACE_REBOOT_STAGE1_SEC - rebootTimer),
      stage2RemainingSec: Math.max(0, HYPERSPACE_REBOOT_TOTAL_SEC - rebootTimer),
    };
  }

  return {
    state,
    jumping: false,
    rebooting: false,
    externalViewsOnline: true,
    enginesOnline: true,
    rcsOnline: true,
    sasOnline: true,
    shieldsOnline: true,
    weaponsOnline: true,
    targetingOnline: true,
    sensorsOnline: true,
    dronesOnline: true,
    hyperspaceOnline: true,
    stage1RemainingSec: 0,
    stage2RemainingSec: 0,
  };
}

/**
 * Checks whether candidate 3D position is clear of arena boundaries,
 * origin position, asteroids, debris, gravity wells, mines, nebulae, derelict, and ships.
 *
 * @param {{x: number, y: number, z?: number}} pos
 * @param {number} [shipRadius=30]
 * @param {{x: number, y: number, z?: number}|null} [originPos=null]
 * @param {object|null} [sector=null]
 * @param {Array<object>} [otherShips=[]]
 * @param {number} [minRelocation=500]
 * @returns {boolean}
 */
export function isPointEmptySpace(
  pos,
  shipRadius = 30,
  originPos = null,
  sector = null,
  otherShips = [],
  minRelocation = 500
) {
  const pz = pos.z ?? 0;

  // 1. Arena X/Y radius check
  const arenaRadius = sector?.arenaRadius || ARENA_RADIUS || 3600;
  const maxArenaDist = arenaRadius - shipRadius - HYPERSPACE_ARENA_EDGE_MARGIN;
  if (Math.hypot(pos.x, pos.y) > maxArenaDist) {
    return false;
  }

  // 2. Arena Z extent check
  const maxZ = SECTOR_Z_HALF_EXTENT - HYPERSPACE_Z_EDGE_MARGIN;
  if (Math.abs(pz) > maxZ) {
    return false;
  }

  // 3. Minimum jump separation from originPos
  if (originPos != null) {
    const oz = originPos.z ?? 0;
    const distOrigin = Math.hypot(pos.x - originPos.x, pos.y - originPos.y, pz - oz);
    if (distOrigin < minRelocation) {
      return false;
    }
  }

  // 4. Asteroid clearance
  if (sector?.asteroids) {
    for (const a of sector.asteroids) {
      if (a.destroyed) continue;
      const az = a.pos?.z ?? a.z ?? 0;
      const ax = a.pos?.x ?? a.x ?? 0;
      const ay = a.pos?.y ?? a.y ?? 0;
      const dist = Math.hypot(pos.x - ax, pos.y - ay, pz - az);
      if (dist < (a.radius || 0) + shipRadius + HYPERSPACE_CLEARANCE_PADDING) {
        return false;
      }
    }
  }

  // 5. Debris fields & chunks clearance
  if (sector?.debrisFields) {
    for (const field of sector.debrisFields) {
      const fx = field.pos?.x ?? field.x ?? 0;
      const fy = field.pos?.y ?? field.y ?? 0;
      const fz = field.pos?.z ?? field.z ?? 0;
      const distField = Math.hypot(pos.x - fx, pos.y - fy, pz - fz);
      if (distField < (field.radius || 200) + shipRadius + 60) {
        return false;
      }
      if (field.debrisChunks) {
        for (const c of field.debrisChunks) {
          if (c.destroyed) continue;
          const cx = c.pos?.x ?? c.x ?? 0;
          const cy = c.pos?.y ?? c.y ?? 0;
          const cz = c.pos?.z ?? c.z ?? 0;
          const distChunk = Math.hypot(pos.x - cx, pos.y - cy, pz - cz);
          if (distChunk < (c.radius || 18) + shipRadius + 140) {
            return false;
          }
        }
      }
    }
  }

  if (sector?.dynamicDebrisChunks) {
    for (const c of sector.dynamicDebrisChunks) {
      if (c.destroyed) continue;
      const cx = c.pos?.x ?? c.x ?? 0;
      const cy = c.pos?.y ?? c.y ?? 0;
      const cz = c.pos?.z ?? c.z ?? 0;
      const distChunk = Math.hypot(pos.x - cx, pos.y - cy, pz - cz);
      if (distChunk < (c.radius || 18) + shipRadius + 140) {
        return false;
      }
    }
  }

  // 6. Gravity wells
  if (sector?.gravityWells) {
    for (const well of sector.gravityWells) {
      const wx = well.pos?.x ?? well.x ?? 0;
      const wy = well.pos?.y ?? well.y ?? 0;
      const wz = well.pos?.z ?? well.z ?? 0;
      const distWell = Math.hypot(pos.x - wx, pos.y - wy, pz - wz);
      const safeRadius = Math.max((well.eventHorizonRadius || 35) + 280, (well.pullRadius || 750) * 0.45);
      if (distWell < safeRadius) {
        return false;
      }
    }
  }

  // 7. Tether mines
  if (sector?.tetherMines) {
    for (const m of sector.tetherMines) {
      if (m.destroyed) continue;
      const mx = m.pos?.x ?? m.x ?? 0;
      const my = m.pos?.y ?? m.y ?? 0;
      const mz = m.pos?.z ?? m.z ?? 0;
      const distMine = Math.hypot(pos.x - mx, pos.y - my, pz - mz);
      if (distMine < (m.triggerRadius || 150) + shipRadius + HYPERSPACE_CLEARANCE_PADDING) {
        return false;
      }
    }
  }

  // 8. Ion nebulae
  if (sector?.ionNebulae) {
    for (const nebula of sector.ionNebulae) {
      const nx = nebula.pos?.x ?? nebula.x ?? 0;
      const ny = nebula.pos?.y ?? nebula.y ?? 0;
      const nz = nebula.pos?.z ?? nebula.z ?? 0;
      const distNebula = Math.hypot(pos.x - nx, pos.y - ny, pz - nz);
      if (distNebula < (nebula.radius || 220) + shipRadius + 80) {
        return false;
      }
    }
  }

  // 9. Munitions derelict
  if (sector?.munitionsDerelict) {
    const derelict = sector.munitionsDerelict;
    const dx = derelict.pos?.x ?? derelict.x ?? 0;
    const dy = derelict.pos?.y ?? derelict.y ?? 0;
    const dz = derelict.pos?.z ?? derelict.z ?? 0;
    const distDerelict = Math.hypot(pos.x - dx, pos.y - dy, pz - dz);
    if (distDerelict < (derelict.radius || 35) + shipRadius + 150) {
      return false;
    }
  }

  // 10. Other living ships
  if (otherShips && otherShips.length > 0) {
    for (const s of otherShips) {
      if (!s || s.destroyed) continue;
      const sp = s.body?.pos || s.pos;
      if (!sp) continue;
      const sx = sp.x ?? 0;
      const sy = sp.y ?? 0;
      const sz = sp.z ?? 0;
      const distShip = Math.hypot(pos.x - sx, pos.y - sy, pz - sz);
      const otherRadius = s.body?.radius || (s.body?.length ? s.body.length * 0.45 : 40);
      if (distShip < otherRadius + shipRadius + 350) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Samples a candidate 3D position along a spherical cone defined by an orthonormal basis.
 */
function sampleConePoint(originPos, Fn, Rn, Un, cosTheta, phi, dist) {
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const Dx = cosTheta * Fn.x + sinTheta * cosPhi * Rn.x + sinTheta * sinPhi * Un.x;
  const Dy = cosTheta * Fn.y + sinTheta * cosPhi * Rn.y + sinTheta * sinPhi * Un.y;
  const Dz = cosTheta * Fn.z + sinTheta * cosPhi * Rn.z + sinTheta * sinPhi * Un.z;

  return {
    x: originPos.x + Dx * dist,
    y: originPos.y + Dy * dist,
    z: (originPos.z ?? 0) + Dz * dist,
  };
}

/**
 * Computes a clearance safety score for a candidate hyperspace destination point.
 * Higher scores indicate greater distance/clearance from boundaries, celestial bodies,
 * hazards, and other ships.
 */
function getCandidateClearanceScore(cand, shipRadius, originPos, sector, otherShips) {
  const arenaRadius = sector?.arenaRadius || ARENA_RADIUS || 3600;
  const maxArenaDist = arenaRadius - shipRadius - HYPERSPACE_ARENA_EDGE_MARGIN;
  const distCenter = Math.hypot(cand.x, cand.y);
  if (distCenter > maxArenaDist) return -1e9 - (distCenter - maxArenaDist);

  const maxZ = SECTOR_Z_HALF_EXTENT - HYPERSPACE_Z_EDGE_MARGIN;
  const pz = cand.z ?? 0;
  if (Math.abs(pz) > maxZ) return -1e9 - (Math.abs(pz) - maxZ);

  let minClearance = Infinity;

  // Asteroid clearance margin
  if (sector?.asteroids) {
    for (const a of sector.asteroids) {
      if (a.destroyed) continue;
      const ax = a.pos?.x ?? a.x ?? 0;
      const ay = a.pos?.y ?? a.y ?? 0;
      const az = a.pos?.z ?? a.z ?? 0;
      const d = Math.hypot(cand.x - ax, cand.y - ay, pz - az) - ((a.radius || 0) + shipRadius);
      if (d < minClearance) minClearance = d;
    }
  }

  // Debris chunks clearance margin
  if (sector?.debrisFields) {
    for (const field of sector.debrisFields) {
      if (field.debrisChunks) {
        for (const c of field.debrisChunks) {
          if (c.destroyed) continue;
          const cx = c.pos?.x ?? c.x ?? 0;
          const cy = c.pos?.y ?? c.y ?? 0;
          const cz = c.pos?.z ?? c.z ?? 0;
          const d = Math.hypot(cand.x - cx, cand.y - cy, pz - cz) - ((c.radius || 18) + shipRadius);
          if (d < minClearance) minClearance = d;
        }
      }
    }
  }

  // Gravity wells clearance margin
  if (sector?.gravityWells) {
    for (const well of sector.gravityWells) {
      const wx = well.pos?.x ?? well.x ?? 0;
      const wy = well.pos?.y ?? well.y ?? 0;
      const wz = well.pos?.z ?? well.z ?? 0;
      const d = Math.hypot(cand.x - wx, cand.y - wy, pz - wz) - ((well.pullRadius || 750) * 0.45 + shipRadius);
      if (d < minClearance) minClearance = d;
    }
  }

  // Tether mines clearance margin
  if (sector?.tetherMines) {
    for (const m of sector.tetherMines) {
      if (m.destroyed || !m.armed) continue;
      const mx = m.pos?.x ?? m.x ?? 0;
      const my = m.pos?.y ?? m.y ?? 0;
      const mz = m.pos?.z ?? m.z ?? 0;
      const d = Math.hypot(cand.x - mx, cand.y - my, pz - mz) - ((m.triggerRadius || 150) + shipRadius);
      if (d < minClearance) minClearance = d;
    }
  }

  // Other ships clearance margin
  if (otherShips) {
    for (const s of otherShips) {
      if (!s || s.destroyed) continue;
      const sp = s.body?.pos || s.pos;
      if (!sp) continue;
      const otherRadius = s.body?.radius || (s.body?.length ? s.body.length * 0.45 : 40);
      const d = Math.hypot(cand.x - (sp.x ?? 0), cand.y - (sp.y ?? 0), pz - (sp.z ?? 0)) - (otherRadius + shipRadius);
      if (d < minClearance) minClearance = d;
    }
  }

  return minClearance === Infinity ? 1000 : minClearance;
}

/**
 * Searches for a valid, clear hyperspace jump destination in the general forward direction.
 *
 * @param {object} ship - jumping ship
 * @param {object|null} sector - sector hazard layout
 * @param {Array<object>} [otherShips=[]] - opponent/other ships
 * @param {function} [rng=Math.random]
 * @returns {{x: number, y: number, z: number}}
 */
export function findHyperspaceDestination(ship, sector = null, otherShips = [], rng = Math.random) {
  const originPos = ship.body?.pos
    ? { x: ship.body.pos.x, y: ship.body.pos.y, z: ship.body.pos.z ?? 0 }
    : (ship.pos ? { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z ?? 0 } : { x: 0, y: 0, z: 0 });

  const shipRadius = ship.body?.length ? ship.body.length * 0.45 : (ship.body?.radius || 30);
  const livingOtherShips = otherShips.filter(s => s && s !== ship && s.id !== ship.id);

  // Track closest/safest candidate scored during Pass 1–3
  let bestCandidate = null;
  let bestCandidateScore = -Infinity;

  // Obtain forward heading vector
  let F;
  if (typeof ship.body?.getForwardVector === 'function') {
    F = ship.body.getForwardVector();
  } else if (ship.body?.angle !== undefined) {
    const pitch = ship.body.pitch || 0;
    F = {
      x: Math.cos(ship.body.angle) * Math.cos(pitch),
      y: Math.sin(ship.body.angle) * Math.cos(pitch),
      z: Math.sin(pitch),
    };
  } else {
    F = { x: 1, y: 0, z: 0 };
  }

  const fLen = Math.hypot(F.x, F.y, F.z) || 1;
  const Fn = { x: F.x / fLen, y: F.y / fLen, z: F.z / fLen };

  // Construct orthonormal basis { Fn, Rn, Un }
  const ref = Math.abs(Fn.z) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  let Rx = Fn.y * ref.z - Fn.z * ref.y;
  let Ry = Fn.z * ref.x - Fn.x * ref.z;
  let Rz = Fn.x * ref.y - Fn.y * ref.x;
  const rLen = Math.hypot(Rx, Ry, Rz) || 1;
  const Rn = { x: Rx / rLen, y: Ry / rLen, z: Rz / rLen };

  const Ux = Rn.y * Fn.z - Rn.z * Fn.y;
  const Uy = Rn.z * Fn.x - Rn.x * Fn.z;
  const Uz = Rn.x * Fn.y - Rn.y * Fn.x;
  const uLen = Math.hypot(Ux, Uy, Uz) || 1;
  const Un = { x: Ux / uLen, y: Uy / uLen, z: Uz / uLen };

  // Pass 1 (96 tries): uniform cone cosTheta in [cos(HYPERSPACE_FORWARD_HALF_ANGLE), 1]
  const minCos1 = Math.cos(HYPERSPACE_FORWARD_HALF_ANGLE);
  for (let i = 0; i < 96; i++) {
    const cosTheta = minCos1 + rng() * (1 - minCos1);
    const phi = rng() * 2 * Math.PI;
    const dist = HYPERSPACE_MIN_JUMP_DIST + rng() * (HYPERSPACE_MAX_JUMP_DIST - HYPERSPACE_MIN_JUMP_DIST);
    const cand = sampleConePoint(originPos, Fn, Rn, Un, cosTheta, phi, dist);
    const score = getCandidateClearanceScore(cand, shipRadius, originPos, sector, livingOtherShips);
    if (score > bestCandidateScore) {
      bestCandidateScore = score;
      bestCandidate = cand;
    }
    if (isPointEmptySpace(cand, shipRadius, originPos, sector, livingOtherShips, 500)) {
      return cand;
    }
  }

  // Pass 2 (48 tries): wider forward hemisphere cosTheta in [0.2, 1], dist in [650, 3200]
  for (let i = 0; i < 48; i++) {
    const cosTheta = 0.2 + rng() * (1 - 0.2);
    const phi = rng() * 2 * Math.PI;
    const dist = 650 + rng() * (3200 - 650);
    const cand = sampleConePoint(originPos, Fn, Rn, Un, cosTheta, phi, dist);
    const score = getCandidateClearanceScore(cand, shipRadius, originPos, sector, livingOtherShips);
    if (score > bestCandidateScore) {
      bestCandidateScore = score;
      bestCandidate = cand;
    }
    if (isPointEmptySpace(cand, shipRadius, originPos, sector, livingOtherShips, 500)) {
      return cand;
    }
  }

  // Pass 3 (36 tries): safe random point inside arena (r <= arenaRadius * 0.82)
  const arenaRadius = sector?.arenaRadius || ARENA_RADIUS || 3600;
  const safeArenaRadius = arenaRadius * 0.82;
  const zLimit = (SECTOR_Z_HALF_EXTENT - HYPERSPACE_Z_EDGE_MARGIN) * 0.8;
  let bestPass3 = null;
  let bestPass3Dot = -Infinity;

  for (let i = 0; i < 36; i++) {
    const r = Math.sqrt(rng()) * safeArenaRadius;
    const th = rng() * 2 * Math.PI;
    const z = (rng() * 2 - 1) * zLimit;
    const cand = { x: r * Math.cos(th), y: r * Math.sin(th), z };
    const score = getCandidateClearanceScore(cand, shipRadius, originPos, sector, livingOtherShips);
    if (score > bestCandidateScore) {
      bestCandidateScore = score;
      bestCandidate = cand;
    }
    if (isPointEmptySpace(cand, shipRadius, originPos, sector, livingOtherShips, 300)) {
      const dot = (cand.x - originPos.x) * Fn.x + (cand.y - originPos.y) * Fn.y + (cand.z - (originPos.z ?? 0)) * Fn.z;
      if (dot > 0) {
        return cand;
      }
      if (dot > bestPass3Dot) {
        bestPass3Dot = dot;
        bestPass3 = cand;
      }
    }
  }

  if (bestPass3) {
    return bestPass3;
  }

  if (isPointEmptySpace({ x: 0, y: 0, z: 0 }, shipRadius, originPos, sector, otherShips, 0)) {
    return { x: 0, y: 0, z: 0 };
  }

  return bestCandidate || { x: 0, y: 0, z: 0 };
}

/**
 * Updates hyperspace charge, warp transit, or reboot progression for a ship.
 *
 * @param {object} ship - ship entity
 * @param {number} dt - simulation timestep in seconds
 * @param {object} [context={}]
 * @param {object} [context.sector]
 * @param {object} [context.enemyShip]
 * @param {function} [context.rng]
 * @returns {Array<string>} emitted state transition event types
 */
export function updateHyperspaceState(ship, dt, { sector, enemyShip, rng = Math.random } = {}) {
  const hs = ship?.hyperspace;
  if (!hs) return [];

  const events = [];

  if (hs.state === 'charging') {
    const power = Math.max(0, Number(ship.powerMap?.hyperspace ?? 0));
    const coolant = Math.max(0, Number(ship.powerMap?.coolantMap?.hyperspace ?? 1.0));
    const health = Math.max(0, Number(hs.health ?? 100));

    // Nominal cooling (coolant >= 0.5) gives coolantFactor = 1.0
    // Severed/low cooling (coolant < 0.5) degrades coolantFactor = 0.4 + 1.2 * coolant
    const coolantFactor = coolant >= 0.5 ? 1.0 : (0.4 + 1.2 * coolant);

    if (power > 0 && health > 0) {
      hs.charge = Math.min(1.0, hs.charge + HYPERSPACE_BASE_CHARGE_RATE * power * coolantFactor * (health / 100) * dt);
    } else {
      hs.charge = Math.max(0, hs.charge - HYPERSPACE_CHARGE_DECAY_RATE * dt);
    }

    if (hs.charge >= 1.0 - 1e-6) {
      hs.state = 'jumping';
      hs.jumpTimer = 0;
      hs.originPos = {
        x: ship.body?.pos?.x ?? ship.pos?.x ?? 0,
        y: ship.body?.pos?.y ?? ship.pos?.y ?? 0,
        z: ship.body?.pos?.z ?? ship.pos?.z ?? 0,
      };
      hs.warpHeadingAngle = ship.body?.angle ?? ship.angle ?? 0;
      hs.warpHeadingPitch = ship.body?.pitch ?? ship.pitch ?? 0;
      events.push('enter_hyperspace');
    }
  } else if (hs.state === 'jumping') {
    hs.jumpTimer += dt;
    if (hs.jumpTimer >= HYPERSPACE_JUMP_DURATION - 1e-6) {
      const otherShips = enemyShip ? [enemyShip] : [];
      const dest = findHyperspaceDestination(ship, sector, otherShips, rng);
      hs.destinationPos = { ...dest };
      hs.state = 'rebooting';
      hs.rebootTimer = 0;
      hs.charge = 0;
      hs.jumpCount = (hs.jumpCount || 0) + 1;
      events.push('exit_hyperspace');
    }
  } else if (hs.state === 'rebooting') {
    const prevTimer = hs.rebootTimer;
    hs.rebootTimer += dt;
    if (prevTimer < (HYPERSPACE_REBOOT_STAGE1_SEC - 1e-6) && hs.rebootTimer >= (HYPERSPACE_REBOOT_STAGE1_SEC - 1e-6)) {
      events.push('reboot_stage1');
    }
    if (hs.rebootTimer >= (HYPERSPACE_REBOOT_TOTAL_SEC - 1e-6)) {
      hs.state = 'ready';
      hs.rebootTimer = 0;
      events.push('reboot_complete');
    }
  }

  return events;
}
