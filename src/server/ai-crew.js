/**
 * BROADSIDE HYPERION — AI Auto-Crew Bridge Automation
 *
 * Implements intelligent automated crew agents for unmanned stations:
 * - AIHelm: Range maintenance (500-900m), hazard avoidance, shield alignment, SAS damping, 180° Roll
 * - AIWeapons: Velocity-inherited lead target calculation, pulse lasers, railgun, homing torpedoes, flak
 * - AIEngineer: Zero-waste power routing, broken conduit & subsystem repair, derelict tractor resupply
 */

import { calculateLeadTarget } from '../combat/weapons.js';
import { MAX_PITCH_RAD, ARENA_RADIUS, SHIP_PACING_SCALE } from '../physics/constants.js';
import { TOTAL_EXTERNAL_SYSTEMS, SUBSYSTEM_NODES } from '../systems/grid-10x10.js';
import { getQuadrantForAngle } from '../combat/shields.js';

/**
 * Checks whether an unoccluded line-of-sight exists between two positions,
 * ignoring destroyed asteroids in 3D.
 *
 * @param {{ x: number, y: number, z?: number }} posA
 * @param {{ x: number, y: number, z?: number }} posB
 * @param {Array<object>} [asteroids=[]]
 * @returns {boolean}
 */
export function hasLineOfSight(posA, posB, asteroids = []) {
  if (!posA || !posB) return true;
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dz = (posB.z ?? 0) - (posA.z ?? 0);
  const lenSq = dx * dx + dy * dy + dz * dz;
  if (lenSq < 1e-4) return true;

  for (const ast of asteroids) {
    if (ast.destroyed) continue;
    const astZ = ast.pos.z ?? 0;
    const t = Math.max(0, Math.min(1, ((ast.pos.x - posA.x) * dx + (ast.pos.y - posA.y) * dy + (astZ - (posA.z ?? 0)) * dz) / lenSq));
    const projX = posA.x + t * dx;
    const projY = posA.y + t * dy;
    const projZ = (posA.z ?? 0) + t * dz;
    const dist = Math.hypot(ast.pos.x - projX, ast.pos.y - projY, astZ - projZ);
    if (dist < ast.radius) {
      return false;
    }
  }
  return true;
}

/**
 * Helper to retrieve effective shield HP (taking power state into account).
 *
 * @param {object} shields - ship shields object
 * @param {string} quad - 'fore' | 'aft' | 'port' | 'starboard'
 * @returns {number}
 */
export function getEffectiveShieldHp(shields, quad) {
  if (!shields) return 0;
  if (typeof shields.getEffectiveHp === 'function') {
    return shields.getEffectiveHp(quad);
  }
  return shields.hp?.[quad] ?? 0;
}

/**
 * Normalizes an angle into [-π, π].
 *
 * @param {number} a
 * @returns {number}
 */
export function normalizeAngle(a) {
  let diff = a % (2 * Math.PI);
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

/**
 * Evaluates tactical metrics (shield healths, directional threats, enemy weaknesses)
 * and determines the ship's tactical stance and combat engagement parameters.
 *
 * @param {object} ship - friendly ship entity
 * @param {object} enemyShip - opponent ship entity
 * @param {object} roomState - room state
 * @returns {object} tactical evaluation state
 */
export function evaluateTacticalSituation(ship, enemyShip, roomState) {
  const shields = ship?.shields;
  const maxFore = shields?.maxHp?.fore || 100;
  const maxAft = shields?.maxHp?.aft || 100;
  const maxPort = shields?.maxHp?.port || 100;
  const maxStbd = shields?.maxHp?.starboard || 100;

  const foreHp = getEffectiveShieldHp(shields, 'fore');
  const aftHp = getEffectiveShieldHp(shields, 'aft');
  const portHp = getEffectiveShieldHp(shields, 'port');
  const stbdHp = getEffectiveShieldHp(shields, 'starboard');

  const foreRatio = maxFore > 0 ? foreHp / maxFore : 0;
  const aftRatio = maxAft > 0 ? aftHp / maxAft : 0;
  const portRatio = maxPort > 0 ? portHp / maxPort : 0;
  const stbdRatio = maxStbd > 0 ? stbdHp / maxStbd : 0;
  const maxOwnShieldRatio = Math.max(foreRatio, aftRatio, portRatio, stbdRatio);

  // bestOwnQuad: quadrant with highest effective HP (tie-breaking in order 'fore', 'starboard', 'port', 'aft')
  const ownQuads = ['fore', 'starboard', 'port', 'aft'];
  let bestOwnQuad = 'fore';
  let bestHp = -1;
  for (const q of ownQuads) {
    const hp = q === 'fore' ? foreHp : (q === 'starboard' ? stbdHp : (q === 'port' ? portHp : aftHp));
    if (hp > bestHp) {
      bestHp = hp;
      bestOwnQuad = q;
    }
  }

  // Enemy shield analysis
  const enemyQuads = ['fore', 'starboard', 'port', 'aft'];
  let weakestEnemyQuad = 'fore';
  let lowestEnemyHp = Infinity;
  let strongestEnemyQuad = 'fore';
  let highestEnemyHp = -Infinity;

  for (const q of enemyQuads) {
    const hp = getEffectiveShieldHp(enemyShip?.shields, q);
    if (hp < lowestEnemyHp) {
      lowestEnemyHp = hp;
      weakestEnemyQuad = q;
    }
    if (hp > highestEnemyHp) {
      highestEnemyHp = hp;
      strongestEnemyQuad = q;
    }
  }

  const weakestEnemyQuadHp = Number.isFinite(lowestEnemyHp) ? lowestEnemyHp : 0;
  const strongestEnemyQuadHp = Number.isFinite(highestEnemyHp) ? highestEnemyHp : 0;

  // Direction vector pointing outward from enemyShip.body.pos toward weakestEnemyQuad
  const enemyAngle = enemyShip?.body?.angle ?? enemyShip?.angle ?? 0;
  const enemyRollState = enemyShip?.body?.rollState ?? enemyShip?.rollState ?? 0;

  let weakAngle = enemyAngle;
  if (weakestEnemyQuad === 'aft') {
    weakAngle = enemyAngle + Math.PI;
  } else if (weakestEnemyQuad === 'starboard') {
    weakAngle = enemyAngle + (enemyRollState === 1 ? -Math.PI / 2 : Math.PI / 2);
  } else if (weakestEnemyQuad === 'port') {
    weakAngle = enemyAngle + (enemyRollState === 1 ? Math.PI / 2 : -Math.PI / 2);
  }

  const weakQuadDir = {
    x: Math.cos(weakAngle),
    y: Math.sin(weakAngle),
  };

  const weakQuadPos = enemyShip?.body?.pos
    ? {
        x: enemyShip.body.pos.x + 700 * weakQuadDir.x,
        y: enemyShip.body.pos.y + 700 * weakQuadDir.y,
        z: enemyShip.body.pos.z ?? 0,
      }
    : null;

  // Distances and enemy facing shield
  const shipPos = ship?.body?.pos || ship?.pos || { x: 0, y: 0, z: 0 };
  const enemyPos = enemyShip?.body?.pos || enemyShip?.pos || null;
  const distEnemy = enemyPos
    ? Math.hypot(enemyPos.x - shipPos.x, enemyPos.y - shipPos.y, (enemyPos.z ?? 0) - (shipPos.z ?? 0))
    : 2000;

  let enemyFacingHp = 100;
  if (enemyPos) {
    const dxToEnemy = shipPos.x - enemyPos.x;
    const dyToEnemy = shipPos.y - enemyPos.y;
    const hitAngleOnEnemy = Math.atan2(dyToEnemy, dxToEnemy);
    const enemyFacingQuad = getQuadrantForAngle(hitAngleOnEnemy, enemyAngle, enemyRollState);
    enemyFacingHp = getEffectiveShieldHp(enemyShip?.shields, enemyFacingQuad);
  }

  // Which of our own shield quadrants faces the enemy?
  let facingShieldSystemKey = 'shields_fore';
  if (enemyPos) {
    const dxFromEnemy = enemyPos.x - shipPos.x;
    const dyFromEnemy = enemyPos.y - shipPos.y;
    const hitAngleOnSelf = Math.atan2(dyFromEnemy, dxFromEnemy);
    const selfAngle = ship?.body?.angle ?? ship?.angle ?? 0;
    const selfRollState = ship?.body?.rollState ?? ship?.rollState ?? 0;
    const selfFacingQuad = getQuadrantForAngle(hitAngleOnSelf, selfAngle, selfRollState);
    facingShieldSystemKey = 'shields_' + selfFacingQuad;
  }

  const currentSpeed = ship?.body?.vel
    ? Math.hypot(ship.body.vel.x, ship.body.vel.y, ship.body.vel.z || 0)
    : 0;

  const laserPower = ship?.powerMap?.weapons_laser ?? 0.8;
  const railgunPower = ship?.powerMap?.weapons_railgun ?? 0.8;
  const railgunHealth = ship?.weapons?.railgunHardware?.health ?? 100;
  const railgunJammed = ship?.weapons?.railgunJammed ?? false;
  const railgunOperational = railgunHealth > 25 && !railgunJammed && railgunPower > 0;

  const laserHealth = ship?.weapons?.laserHardware?.health ?? 100;
  const laserOverheated = ship?.weapons?.overheated ?? false;
  const hullHp = ship?.hullHp ?? 1000;
  const maxHullHp = ship?.maxHullHp ?? 1000;

  let stance = 'brawler';
  let minRange = 500;
  let maxRange = 900;

  // Stance determination (priority order)
  // 1. Evasive Regen
  const isEvasiveRegen =
    maxOwnShieldRatio < 0.20 ||
    (foreRatio < 0.20 && (hullHp / maxHullHp) < 0.60 && distEnemy < 1100) ||
    (laserPower <= 0 && railgunPower <= 0);

  // 2. Railgun Sniper
  const isSniperBand =
    ((ship?.weapons?.charging && (ship?.weapons?.chargeProgress ?? 0) > 0.35) || (ship?.weapons?.chargeProgress ?? 0) >= 1.0) &&
    currentSpeed > 0.5 &&
    foreHp < 130;

  const isRailgunSniper =
    ship?.aiPreferredStance === 'railgun_sniper' ||
    (railgunOperational &&
      (laserOverheated ||
       laserHealth < 50 ||
       (foreHp < 85 && enemyFacingHp > 100 && distEnemy > 1000) ||
       isSniperBand));

  // 3. Flank Weak Quadrant
  const isFlankWeakQuad =
    distEnemy < 1500 &&
    weakestEnemyQuadHp < 50 &&
    strongestEnemyQuadHp > 90;

  if (isEvasiveRegen) {
    stance = 'evasive_regen';
    minRange = 1150;
    maxRange = 1550;
  } else if (isRailgunSniper) {
    stance = 'railgun_sniper';
    minRange = 1250;
    maxRange = 1650;
  } else if (isFlankWeakQuad) {
    stance = 'flank_weak_quad';
    minRange = 550;
    maxRange = 880;
  } else {
    stance = 'brawler';
    minRange = 500;
    maxRange = 900;
  }

  const tactical = {
    stance,
    minRange,
    maxRange,
    distEnemy,
    foreHp,
    aftHp,
    portHp,
    stbdHp,
    foreRatio,
    aftRatio,
    portRatio,
    stbdRatio,
    maxOwnShieldRatio,
    bestOwnQuad,
    facingShieldSystemKey,
    weakestEnemyQuad,
    weakestEnemyQuadHp,
    strongestEnemyQuadHp,
    weakQuadDir,
    weakQuadPos,
  };

  if (ship) {
    ship.aiTactical = tactical;
  }

  return tactical;
}

/**
 * Scans asteroids for an intact asteroid whose dynamic shatter debris would damage
 * the enemy ship while keeping the friendly ship safe.
 *
 * @param {object} ship - friendly ship entity
 * @param {object} enemyShip - opponent ship entity
 * @param {Array<object>} [asteroids=[]]
 * @returns {object|null} qualifying asteroid closest to enemy hull, or null
 */
export function findTacticalShatterAsteroid(ship, enemyShip, asteroids = []) {
  if (!ship?.body?.pos || !enemyShip?.body?.pos || !asteroids || asteroids.length === 0) {
    return null;
  }

  const myPos = ship.body.pos;
  const enemyPos = enemyShip.body.pos;
  const railgunPower = ship.powerMap?.weapons_railgun ?? 0.8;
  const railgunCharged = (ship.weapons?.chargeProgress ?? 0) >= 1.0;
  const laserPower = ship.powerMap?.weapons_laser ?? 0.8;

  let bestAsteroid = null;
  let minEnemyDist = Infinity;

  for (const ast of asteroids) {
    if (ast.destroyed) continue;

    const astPos = ast.pos || { x: ast.x, y: ast.y, z: ast.z || 0 };
    const radius = ast.radius || 40;

    const distEnemyToAst = Math.hypot(
      enemyPos.x - astPos.x,
      enemyPos.y - astPos.y,
      (enemyPos.z ?? 0) - (astPos.z ?? 0)
    );
    const distShipToAst = Math.hypot(
      myPos.x - astPos.x,
      myPos.y - astPos.y,
      (myPos.z ?? 0) - (astPos.z ?? 0)
    );

    // 1. Enemy is within debris blast proximity (surface distance <= 240)
    if (distEnemyToAst - radius > 240) continue;

    // 2. Friendly ship is safely outside self-damage range (surface distance >= 260)
    if (distShipToAst - radius < 260) continue;

    // 3. Unoccluded line of sight exists from ship to asteroid
    const otherAsteroids = asteroids.filter(a => a !== ast);
    if (!hasLineOfSight(myPos, astPos, otherAsteroids)) continue;

    // 4. Asteroid is within weapon range
    const canRailgun = distShipToAst <= 2200 && (railgunPower > 0 || railgunCharged);
    const canLaser = distShipToAst <= 1200 && laserPower > 0 && (ast.hp ?? 100) <= 100;
    if (!canRailgun && !canLaser) continue;

    if (distEnemyToAst < minEnemyDist) {
      minEnemyDist = distEnemyToAst;
      bestAsteroid = ast;
    }
  }

  return bestAsteroid;
}

/**
 * Selects the optimal pinpoint subsystem target on the enemy ship.
 *
 * @param {object} ship - friendly ship entity
 * @param {object} enemyShip - opponent ship entity
 * @param {string} [stance='brawler']
 * @returns {string} subsystem key
 */
export function selectOptimalSubsystemTarget(ship, enemyShip, stance = 'brawler') {
  if (!enemyShip) return 'sas_computer';

  const myPos = ship?.body?.pos || ship?.pos;
  const enemyPos = enemyShip?.body?.pos || enemyShip?.pos;
  const distEnemy = (myPos && enemyPos)
    ? Math.hypot(enemyPos.x - myPos.x, enemyPos.y - myPos.y, (enemyPos.z ?? 0) - (myPos.z ?? 0))
    : 1000;

  // 1. 'hyperspace' if enemy hyperspace charging and health > 0
  if (enemyShip.hyperspace?.state === 'charging' && (enemyShip.hyperspace?.health ?? 100) > 0) {
    return 'hyperspace';
  }

  // 2. 'weapons_railgun' if stance === 'railgun_sniper' or enemy railgun health > 15
  const enemyRailgunHp = enemyShip.weapons?.railgunHardware?.health ?? 100;
  if (stance === 'railgun_sniper' || enemyRailgunHp > 15) {
    return 'weapons_railgun';
  }

  // 3. 'mainDrive' if enemy mainDrive health > 40 and distEnemy > 950
  const enemyMainDriveHp = enemyShip.body?.mainDrive?.health ?? 100;
  if (enemyMainDriveHp > 40 && distEnemy > 950) {
    return 'mainDrive';
  }

  // 4. 'weapons_laser' if enemy laserHardware health > 20
  const enemyLaserHp = enemyShip.weapons?.laserHardware?.health ?? 100;
  if (enemyLaserHp > 20) {
    return 'weapons_laser';
  }

  // 5. 'sas_computer' as fallback
  return 'sas_computer';
}

export class AIHelm {
  /**
   * Updates helm steering, translation, and tactical attitude.
   *
   * @param {object} ship - friendly ship entity { id, body, shields, hullHp, ... }
   * @param {object} enemyShip - opponent ship entity
   * @param {object} roomState - { sector, projectiles, ... }
   * @param {number} dt - simulation timestep (s)
   */
  static update(ship, enemyShip, roomState, dt) {
    if (
      !ship ||
      !ship.body ||
      ship.destroyed ||
      (ship.hullHp !== undefined && ship.hullHp <= 0) ||
      Boolean(roomState?.replayActive) ||
      (roomState?.state && roomState.state !== 'playing')
    ) {
      return { forward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0, throttle: 0, rcsForward: 0 };
    }

    if (
      ship.hyperspace?.state === 'jumping' ||
      (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 4.0)
    ) {
      ship.body.commandPilot({ forward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0 });
      if (ship.helmInput) {
        ship.helmInput.forward = 0;
        ship.helmInput.strafe = 0;
        ship.helmInput.turn = 0;
        ship.helmInput.roll = 0;
        ship.helmInput.pitch = 0;
        ship.helmInput.rcsForward = 0;
        ship.helmInput.mainThrottle = 0;
      }
      return { forward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0, throttle: 0, rcsForward: 0 };
    }

    const body = ship.body;
    let forward = 0;
    let strafe = 0;
    let turn = 0;
    let roll = 0;
    let pitch = 0;
    let rcsForward = 0;

    // 1. Boundary & Hazard Avoidance (Highest Priority)
    const arenaRadius = roomState?.sector?.arenaRadius || ARENA_RADIUS;
    const distFromCenter = Math.hypot(body.pos.x, body.pos.y, body.pos.z || 0);
    const outwardVel = distFromCenter > 1
      ? (body.pos.x * body.vel.x + body.pos.y * body.vel.y + (body.pos.z || 0) * (body.vel.z || 0)) / distFromCenter
      : 0;
    const currentSpeed = Math.hypot(body.vel.x, body.vel.y, body.vel.z || 0);

    let emergencyNav = false;
    let desiredAngle = body.angle;
    let desiredPitch = body.pitch || 0;

    const nearBoundary = distFromCenter > arenaRadius * 0.8 || Boolean(ship.inDampeningField);
    const fastOutward = distFromCenter > arenaRadius * 0.68 && outwardVel > 45 * SHIP_PACING_SCALE;

    if (nearBoundary || fastOutward) {
      if (currentSpeed > 0.5) {
        // Desired inward velocity: v_des = -95 * SHIP_PACING_SCALE * (pos / distFromCenter)
        const desSpeed = 95 * SHIP_PACING_SCALE;
        const desVx = -desSpeed * (body.pos.x / distFromCenter);
        const desVy = -desSpeed * (body.pos.y / distFromCenter);
        const desVz = -desSpeed * ((body.pos.z || 0) / distFromCenter);
        const dvX = desVx - body.vel.x;
        const dvY = desVy - body.vel.y;
        const dvZ = desVz - (body.vel.z || 0);

        desiredAngle = Math.atan2(dvY, dvX);
        desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2(dvZ, Math.max(1, Math.hypot(dvX, dvY)))));

        let angleDiff = normalizeAngle(desiredAngle - body.angle);
        if (Math.cos(angleDiff) < 0.35) {
          forward = 0.0;
          rcsForward = -1.0;
        } else {
          forward = 1.0;
        }
      } else {
        // Stationary initial condition: steer directly towards center (0, 0, 0)
        desiredAngle = Math.atan2(-body.pos.y, -body.pos.x);
        desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2(-(body.pos.z || 0), Math.max(1, Math.hypot(body.pos.x, body.pos.y)))));
        forward = 1.0;
      }
      emergencyNav = true;
    } else if (roomState?.sector?.gravityWells && roomState.sector.gravityWells.length > 0) {
      // Check micro-singularities
      for (const well of roomState.sector.gravityWells) {
        const wellPos = well.pos || { x: well.x, y: well.y, z: well.z || 0 };
        const distWell = Math.hypot(body.pos.x - wellPos.x, body.pos.y - wellPos.y, (body.pos.z || 0) - (wellPos.z ?? 0));
        const dangerRadius = Math.max(260, (well.pullRadius || 750) * 0.45);
        if (distWell < dangerRadius) {
          desiredAngle = Math.atan2(body.pos.y - wellPos.y, body.pos.x - wellPos.x);
          desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2((body.pos.z || 0) - (wellPos.z ?? 0), Math.max(1, Math.hypot(body.pos.x - wellPos.x, body.pos.y - wellPos.y)))));
          forward = 1.0;
          emergencyNav = true;
          break;
        }
      }
    }

    // Asteroid Avoidance
    if (!emergencyNav && roomState?.sector?.asteroids) {
      for (const ast of roomState.sector.asteroids) {
        if (ast.destroyed) continue;
        const astPos = ast.pos || { x: ast.x, y: ast.y, z: ast.z || 0 };
        const distAst = Math.hypot(body.pos.x - astPos.x, body.pos.y - astPos.y, (body.pos.z || 0) - (astPos.z ?? 0));
        if (distAst < (ast.radius || 40) + 160) {
          desiredAngle = Math.atan2(body.pos.y - astPos.y, body.pos.x - astPos.x);
          desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2((body.pos.z || 0) - (astPos.z ?? 0), Math.max(1, Math.hypot(body.pos.x - astPos.x, body.pos.y - astPos.y)))));
          forward = 0.85;
          emergencyNav = true;
          break;
        }
      }
    }

    // Tether Mine Avoidance
    if (!emergencyNav && roomState?.sector?.tetherMines) {
      for (const mine of roomState.sector.tetherMines) {
        if (mine.armed && !mine.destroyed) {
          const minePos = mine.pos || { x: mine.x, y: mine.y, z: mine.z || 0 };
          const distMine = Math.hypot(body.pos.x - minePos.x, body.pos.y - minePos.y, (body.pos.z || 0) - (minePos.z ?? 0));
          if (distMine < (mine.triggerRadius || 150) + 110) {
            desiredAngle = Math.atan2(body.pos.y - minePos.y, body.pos.x - minePos.x);
            desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2((body.pos.z || 0) - (minePos.z ?? 0), Math.max(1, Math.hypot(body.pos.x - minePos.x, body.pos.y - minePos.y)))));
            forward = 0.85;
            emergencyNav = true;
            break;
          }
        }
      }
    }

    // 2. Tactical Combat Navigation (when not in emergency hazard avoidance)
    const canTargetEnemy = !emergencyNav &&
      enemyShip &&
      enemyShip.body &&
      enemyShip.hullHp > 0 &&
      enemyShip.hyperspace?.state !== 'jumping' &&
      ship.targetAvailable !== false &&
      ship.sensorsOnline !== false;

    if (canTargetEnemy) {
      const tactical = evaluateTacticalSituation(ship, enemyShip, roomState);

      const dx = enemyShip.body.pos.x - body.pos.x;
      const dy = enemyShip.body.pos.y - body.pos.y;
      const dz = (enemyShip.body.pos.z ?? 0) - (body.pos.z ?? 0);
      const distXY = Math.hypot(dx, dy);
      const distEnemy = Math.hypot(dx, dy, dz);
      const angleToEnemy = Math.atan2(dy, dx);
      desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2(dz, Math.max(1, distXY))));

      const uLosX = dx / Math.max(1, distEnemy);
      const uLosY = dy / Math.max(1, distEnemy);
      const uLosZ = dz / Math.max(1, distEnemy);

      const vRelX = body.vel.x - (enemyShip.body.vel?.x || 0);
      const vRelY = body.vel.y - (enemyShip.body.vel?.y || 0);
      const vRelZ = (body.vel.z || 0) - (enemyShip.body.vel?.z || 0);

      const vClosing = vRelX * uLosX + vRelY * uLosY + vRelZ * uLosZ;
      const vTanX = vRelX - vClosing * uLosX;
      const vTanY = vRelY - vClosing * uLosY;
      const vTanZ = vRelZ - vClosing * uLosZ;
      const vTan = Math.hypot(vTanX, vTanY, vTanZ);

      const minRange = tactical.minRange;
      const maxRange = tactical.maxRange;
      const MAX_AI_CRUISE_SPEED = 110 * SHIP_PACING_SCALE;

      const foreHp = tactical.foreHp;
      const aftHp = tactical.aftHp;
      const portHp = tactical.portHp;
      const stbdHp = tactical.stbdHp;
      const foreShieldCritical = foreHp < 35 && (portHp > 60 || stbdHp > 60);

      // Stance-specific and range-maintenance steering
      if (distEnemy > maxRange && !foreShieldCritical) {
        // Pursuit / Closing
        const vRadDes = Math.min(MAX_AI_CRUISE_SPEED, 55 * SHIP_PACING_SCALE + (distEnemy - maxRange) * 0.06);

        let pursuitDirX = uLosX;
        let pursuitDirY = uLosY;
        let pursuitDirZ = uLosZ;

        if (tactical.stance === 'flank_weak_quad' && tactical.weakQuadPos) {
          const fdx = tactical.weakQuadPos.x - body.pos.x;
          const fdy = tactical.weakQuadPos.y - body.pos.y;
          const fdz = (tactical.weakQuadPos.z ?? 0) - (body.pos.z ?? 0);
          const fDist = Math.hypot(fdx, fdy, fdz);
          if (fDist > 1) {
            pursuitDirX = fdx / fDist;
            pursuitDirY = fdy / fDist;
            pursuitDirZ = fdz / fDist;
          }
        }

        const desVx = vRadDes * pursuitDirX;
        const desVy = vRadDes * pursuitDirY;
        const desVz = vRadDes * pursuitDirZ;

        const dvX = desVx - body.vel.x;
        const dvY = desVy - body.vel.y;
        const dvZ = desVz - (body.vel.z || 0);

        if (currentSpeed <= 0.5) {
          desiredAngle = angleToEnemy;
          desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2(dz, Math.max(1, distXY))));
          forward = 0.85;
        } else {
          desiredAngle = Math.atan2(dvY, dvX);
          desiredPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2(dvZ, Math.max(1, Math.hypot(dvX, dvY)))));

          let aimDiff = normalizeAngle(desiredAngle - body.angle);
          let pDiff = desiredPitch - (body.pitch || 0);
          const alignCos = Math.cos(aimDiff) * Math.cos(pDiff);

          const ownClosing = body.vel.x * uLosX + body.vel.y * uLosY + (body.vel.z || 0) * uLosZ;

          if (alignCos <= 0.5) {
            forward = 0.0;
          } else if (ownClosing < MAX_AI_CRUISE_SPEED || vTan > 20) {
            forward = Math.min(0.95, Math.max(0.40, 0.85 * alignCos));
          } else {
            forward = 0.0;
          }

          // Damping sideways drift with strafe & rcsForward
          const heading = body.angle;
          const cosH = Math.cos(heading);
          const sinH = Math.sin(heading);
          const bodyFwd = dvX * cosH + dvY * sinH;
          const bodyRight = dvX * sinH - dvY * cosH;

          // Only strafe when heading error is small so rcsTurnAssist is not suppressed during turns
          if (Math.abs(aimDiff) < 0.35 && Math.abs(bodyRight) > 15) {
            strafe = Math.sign(bodyRight) * 0.8;
          }
          if (bodyFwd < -20) {
            rcsForward = -0.8;
          } else if (bodyFwd > 20 && alignCos > 0.5) {
            rcsForward = 0.5;
          }
        }
      } else if (distEnemy < minRange) {
        // Too Close / Kiting Back
        if (distEnemy < 500 && currentSpeed <= 0.5) {
          forward = 0.0;
          desiredAngle = angleToEnemy;
          strafe = portHp > stbdHp ? -0.8 : 0.8;
          rcsForward = -0.8;
        } else if (tactical.stance === 'railgun_sniper' || tactical.stance === 'evasive_regen') {
          if (aftHp > Math.max(foreHp, portHp, stbdHp) + 40 && Math.max(foreHp, portHp, stbdHp) < 35) {
            desiredAngle = angleToEnemy + Math.PI;
          } else if (foreHp >= portHp && foreHp >= stbdHp) {
            desiredAngle = angleToEnemy;
          } else if (stbdHp >= portHp) {
            desiredAngle = (body.rollState === 0) ? angleToEnemy - Math.PI / 2 : angleToEnemy + Math.PI / 2;
          } else {
            desiredAngle = (body.rollState === 0) ? angleToEnemy + Math.PI / 2 : angleToEnemy - Math.PI / 2;
          }

          forward = 0.0;
          rcsForward = -1.0;
          strafe = portHp > stbdHp ? -0.8 : 0.8;
        } else {
          forward = 0.0;
          rcsForward = -1.0;
          desiredAngle = angleToEnemy;
          strafe = portHp > stbdHp ? -0.8 : 0.8;
        }
      } else {
        // Within Engagement Bracket [minRange, maxRange] or foreShieldCritical
        if (aftHp > Math.max(foreHp, portHp, stbdHp) + 40 && Math.max(foreHp, portHp, stbdHp) < 35) {
          desiredAngle = angleToEnemy + Math.PI;
        } else if (foreHp >= portHp && foreHp >= stbdHp && !foreShieldCritical) {
          desiredAngle = angleToEnemy;
        } else if (stbdHp >= portHp) {
          desiredAngle = (body.rollState === 0) ? angleToEnemy - Math.PI / 2 : angleToEnemy + Math.PI / 2;
        } else {
          desiredAngle = (body.rollState === 0) ? angleToEnemy + Math.PI / 2 : angleToEnemy - Math.PI / 2;
        }

        if (currentSpeed <= 0.5) {
          forward = distEnemy > 900 ? 0.85 : 0.35;
        } else {
          if (vClosing > 35 * SHIP_PACING_SCALE) {
            rcsForward = -0.8;
          } else if (vClosing < -30 * SHIP_PACING_SCALE) {
            rcsForward = 0.6;
          }

          if (tactical.stance === 'flank_weak_quad') {
            strafe = 0.6;
          }

          let aimDiff = normalizeAngle(desiredAngle - body.angle);
          if (Math.abs(aimDiff) < 0.6 && currentSpeed < 65 * SHIP_PACING_SCALE && vClosing < 20 * SHIP_PACING_SCALE) {
            forward = 0.35;
          } else {
            forward = 0.0;
          }
        }
      }

      // 3. Tactical Roll Decision:
      // When the currently facing lateral shield quadrant drops below 25%
      // while the opposite lateral quadrant is > 60%, execute physical roll RCS!
      let relHitAngle = normalizeAngle(angleToEnemy - body.angle);

      // Determine facing lateral side: relHitAngle > 0 => Starboard (roll 0) / Port (roll 1)
      let facingLateral = null;
      let oppositeLateral = null;

      if (Math.abs(relHitAngle) > Math.PI / 6 && Math.abs(relHitAngle) < (5 * Math.PI) / 6) {
        if (relHitAngle > 0) {
          facingLateral = body.rollState === 0 ? 'starboard' : 'port';
          oppositeLateral = body.rollState === 0 ? 'port' : 'starboard';
        } else {
          facingLateral = body.rollState === 0 ? 'port' : 'starboard';
          oppositeLateral = body.rollState === 0 ? 'starboard' : 'port';
        }

        const maxFacing = ship.shields?.maxHp?.[facingLateral] || 100;
        const maxOpposite = ship.shields?.maxHp?.[oppositeLateral] || 100;
        const effFacing = getEffectiveShieldHp(ship.shields, facingLateral);
        const effOpposite = getEffectiveShieldHp(ship.shields, oppositeLateral);
        const ratioFacing = effFacing / maxFacing;
        const ratioOpposite = effOpposite / maxOpposite;
        const oppositeOnline = typeof ship.shields?.isQuadrantPowered === 'function'
          ? ship.shields.isQuadrantPowered(oppositeLateral)
          : (ship.shields?.power?.[oppositeLateral] ?? 1) >= 0.10;

        if (ratioFacing < 0.25 && ratioOpposite > 0.60 && effOpposite > effFacing && oppositeOnline) {
          roll = 1.0;
        } else if (Math.abs(body.rollOmega) > 0.01) {
          body.stopRoll(true);
        }
      } else if (Math.abs(body.rollOmega) > 0.01) {
        body.stopRoll(true);
      }
    }

    // 4. Calculate Steering PID / Rate towards desiredAngle & desiredPitch
    let angleDiff = normalizeAngle(desiredAngle - body.angle);
    let pitchDiff = desiredPitch - (body.pitch || 0);

    // Transform world angle errors to ship body frame so AI steers correctly when rolled/inverted
    const rollA = body.rollAngle !== undefined ? body.rollAngle : ((body.rollState || 0) * Math.PI);
    const cosR = Math.cos(rollA);
    const sinR = Math.sin(rollA);
    const cosP = Math.max(0.1736, Math.cos(body.pitch || 0));

    const eWorldYawEffective = angleDiff * cosP;
    const eBodyYaw = eWorldYawEffective * cosR - pitchDiff * sinR;
    const eBodyPitch = eWorldYawEffective * sinR + pitchDiff * cosR;

    const omegaYaw = body.omega || 0;
    const rawTurn = eBodyYaw * 2.5 - omegaYaw * 0.45;
    if (Math.abs(eBodyYaw) > 0.08 || Math.abs(omegaYaw) > 0.15) {
      turn = Math.sign(rawTurn) * Math.min(1.0, Math.abs(rawTurn));
    } else {
      turn = 0; // Hand over to SAS PID damping!
    }

    const pitchRate = body.pitchOmega ?? body.pitchRate ?? 0;
    const rawPitch = eBodyPitch * 2.5 - pitchRate * 0.45;
    if (Math.abs(eBodyPitch) > 0.05 || Math.abs(pitchRate) > 0.15) {
      pitch = Math.sign(rawPitch) * Math.min(1.0, Math.abs(rawPitch));
    } else {
      pitch = 0;
    }

    // Command pilot maneuvers
    body.commandPilot({ forward, strafe, turn, roll, pitch, rcsForward });
    if (ship.helmInput) {
      ship.helmInput.forward = forward;
      ship.helmInput.strafe = strafe;
      ship.helmInput.turn = turn;
      ship.helmInput.roll = roll;
      ship.helmInput.pitch = pitch;
      ship.helmInput.rcsForward = rcsForward;
      ship.helmInput.mainThrottle = forward;
    }

    // Ensure SAS is active to damp residual angular rate when not steering
    if (turn === 0 && pitch === 0 && !body.sasActive) {
      body.toggleSas(true);
    }

    return { forward, strafe, turn, roll, pitch, throttle: forward, rcsForward };
  }
}

export class AIWeapons {
  /**
   * Updates weapons targeting, articulated turrets, pulse lasers, railgun charge,
   * homing torpedoes, and point-defense flak.
   *
   * @param {object} ship - friendly ship entity { id, body, weapons, powerMap, inNebula, ... }
   * @param {object} enemyShip - opponent ship entity
   * @param {object} roomState - { sector, projectiles, events, ... }
   * @param {number} dt - simulation timestep (s)
   */
  static update(ship, enemyShip, roomState, dt) {
    if (
      !ship ||
      !ship.weapons ||
      ship.destroyed ||
      (ship.hullHp !== undefined && ship.hullHp <= 0) ||
      Boolean(roomState?.replayActive) ||
      (roomState?.state && roomState.state !== 'playing') ||
      (enemyShip && (enemyShip.destroyed || (enemyShip.hullHp !== undefined && enemyShip.hullHp <= 0))) ||
      ship.weaponsOnline === false ||
      ship.hyperspace?.state === 'jumping' ||
      (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 7.0)
    ) {
      if (ship?.weapons?.charging) {
        ship.weapons.stopRailgunCharge();
      }
      if (ship?.weaponsInput) {
        ship.weaponsInput.firingLaser = false;
        ship.weaponsInput.chargingRailgun = false;
      }
      return { fireLaser: false, chargeRailgun: false, fireRailgun: false };
    }

    const weapons = ship.weapons;
    const body = ship.body;
    if (body && !body.id && ship.id) body.id = ship.id;
    const powerMap = ship.powerMap || {};

    // 1. Point-Defense Flak Trigger (Immediate Threat Reaction)
    // Detonates flak if any enemy torpedo or armed tether mine comes within 190m in 3D!
    let threatDetected = false;

    if (roomState?.projectiles && roomState.projectiles.length > 0) {
      for (const p of roomState.projectiles) {
        if (!p.destroyed && p.shooterId !== ship.id && (p.type === 'torpedo' || p.torpedoType)) {
          const dist = Math.hypot(p.pos.x - body.pos.x, p.pos.y - body.pos.y, (p.pos.z ?? 0) - (body.pos.z ?? 0));
          if (dist <= 190) {
            threatDetected = true;
            break;
          }
        }
      }
    }

    if (!threatDetected && roomState?.sector?.tetherMines) {
      for (const mine of roomState.sector.tetherMines) {
        if (mine.armed && !mine.destroyed) {
          const dist = Math.hypot(mine.pos.x - body.pos.x, mine.pos.y - body.pos.y, (mine.pos.z ?? 0) - (body.pos.z ?? 0));
          if (dist <= 190) {
            threatDetected = true;
            break;
          }
        }
      }
    }

    if (threatDetected && weapons.flakCooldown <= 0 && (weapons.flakHardware?.health ?? 100) > 0) {
      const flakResult = weapons.fireFlak(
        body,
        roomState.projectiles,
        roomState.sector?.tetherMines
      );
      if (roomState.events) {
        roomState.events.push({
          type: 'flak_burst',
          shipId: ship.id,
          pos: { x: body.pos.x, y: body.pos.y, z: body.pos.z ?? 0 },
          destroyedProjectiles: flakResult.destroyedProjectiles?.length || 0,
          destroyedMines: flakResult.destroyedMines?.length || 0,
        });
      }
    }

    // No target available
    if (
      !enemyShip ||
      !enemyShip.body ||
      enemyShip.destroyed ||
      (enemyShip.hullHp !== undefined && enemyShip.hullHp <= 0) ||
      enemyShip.hyperspace?.state === 'jumping' ||
      ship.targetAvailable === false ||
      ship.sensorsOnline === false
    ) {
      if (ship.weapons?.charging) {
        ship.weapons.stopRailgunCharge();
      }
      if (ship.weaponsInput) {
        ship.weaponsInput.firingLaser = false;
        ship.weaponsInput.chargingRailgun = false;
      }
      return { fireLaser: false, chargeRailgun: false, fireRailgun: false };
    }

    // 2. Tactical Situation & Pinpoint Subsystem Targeting
    const tactical = ship.aiTactical || evaluateTacticalSituation(ship, enemyShip, roomState);
    const optimalSub = selectOptimalSubsystemTarget(ship, enemyShip, tactical.stance);
    weapons.targetedSubsystem = optimalSub;
    if (ship.weaponsInput) {
      ship.weaponsInput.targetedSubsystem = optimalSub;
    }

    // 3. Velocity-Inherited Lead Target Calculation in 3D
    const lead = calculateLeadTarget(
      body.pos,
      body.vel,
      enemyShip.body.pos,
      enemyShip.body.vel,
      weapons.laserMuzzleSpeed || 600
    );
    ship.leadTarget = lead;

    const railgunLead = calculateLeadTarget(
      body.pos,
      body.vel,
      enemyShip.body.pos,
      enemyShip.body.vel,
      weapons.railgunMuzzleSpeed || 900
    );

    // Check line of sight against active asteroids in 3D
    const asteroids = roomState?.sector?.asteroids || [];
    const hasLOS = hasLineOfSight(body.pos, enemyShip.body.pos, asteroids);
    let blockingAsteroid = null;

    if (!hasLOS) {
      const dx = enemyShip.body.pos.x - body.pos.x;
      const dy = enemyShip.body.pos.y - body.pos.y;
      const dz = (enemyShip.body.pos.z ?? 0) - (body.pos.z ?? 0);
      const lenSq = dx * dx + dy * dy + dz * dz;
      let minT = 1.0;

      for (const ast of asteroids) {
        if (ast.destroyed) continue;
        const astPos = ast.pos || { x: ast.x, y: ast.y, z: ast.z || 0 };
        const astZ = astPos.z ?? 0;
        const t = Math.max(0, Math.min(1, ((astPos.x - body.pos.x) * dx + (astPos.y - body.pos.y) * dy + (astZ - (body.pos.z ?? 0)) * dz) / lenSq));
        const projX = body.pos.x + t * dx;
        const projY = body.pos.y + t * dy;
        const projZ = (body.pos.z ?? 0) + t * dz;
        const dist = Math.hypot(astPos.x - projX, astPos.y - projY, astZ - projZ);
        if (dist < (ast.radius || 40) && t < minT) {
          minT = t;
          blockingAsteroid = ast;
        }
      }
    }

    const distEnemy = Math.hypot(
      enemyShip.body.pos.x - body.pos.x,
      enemyShip.body.pos.y - body.pos.y,
      (enemyShip.body.pos.z ?? 0) - (body.pos.z ?? 0)
    );

    const railgunPower = powerMap.weapons_railgun || 0;
    const laserPower = powerMap.weapons_laser || 0;

    // Check for proximity shatter asteroid opportunity
    const shatterAsteroid = findTacticalShatterAsteroid(ship, enemyShip, asteroids);

    let targetAimAngle = lead.aimAngle;
    let targetAimPitch = lead.aimPitch || 0;
    let allowLaserRailgun = hasLOS;
    let targetDist = distEnemy;

    if (
      shatterAsteroid &&
      ((railgunPower > 0 || weapons.chargeProgress >= 1.0) ||
       (laserPower > 0 && Math.hypot(
          (shatterAsteroid.pos?.x ?? shatterAsteroid.x) - body.pos.x,
          (shatterAsteroid.pos?.y ?? shatterAsteroid.y) - body.pos.y,
          ((shatterAsteroid.pos?.z ?? shatterAsteroid.z) ?? 0) - (body.pos.z ?? 0)
        ) <= 1200 && (shatterAsteroid.hp ?? 100) <= 100))
    ) {
      const astPos = shatterAsteroid.pos || { x: shatterAsteroid.x, y: shatterAsteroid.y, z: shatterAsteroid.z || 0 };
      const distToAst = Math.hypot(astPos.x - body.pos.x, astPos.y - body.pos.y, (astPos.z ?? 0) - (body.pos.z ?? 0));
      targetAimAngle = Math.atan2(astPos.y - body.pos.y, astPos.x - body.pos.x);
      targetAimPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2((astPos.z ?? 0) - (body.pos.z ?? 0), Math.max(1, Math.hypot(astPos.x - body.pos.x, astPos.y - body.pos.y)))));
      allowLaserRailgun = true;
      targetDist = distToAst;
      ship.aiShatterTargetId = shatterAsteroid.id;
    } else if (!hasLOS && blockingAsteroid) {
      const astPos = blockingAsteroid.pos || { x: blockingAsteroid.x, y: blockingAsteroid.y, z: blockingAsteroid.z || 0 };
      const distAst = Math.hypot(astPos.x - body.pos.x, astPos.y - body.pos.y, (astPos.z ?? 0) - (body.pos.z ?? 0));
      if (distAst <= 900 || (distAst <= 1800 && railgunPower > 0)) {
        targetAimAngle = Math.atan2(astPos.y - body.pos.y, astPos.x - body.pos.x);
        targetAimPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Math.atan2((astPos.z ?? 0) - (body.pos.z ?? 0), Math.max(1, Math.hypot(astPos.x - body.pos.x, astPos.y - body.pos.y)))));
        allowLaserRailgun = true;
        targetDist = distAst;
      }
    } else if (hasLOS) {
      if (distEnemy > 1200 || (weapons.chargeProgress >= 1.0 && weapons.railgunCooldown <= 0)) {
        targetAimAngle = railgunLead.aimAngle;
        targetAimPitch = railgunLead.aimPitch || 0;
      } else {
        targetAimAngle = lead.aimAngle;
        targetAimPitch = lead.aimPitch || 0;
      }
      targetDist = distEnemy;
    }

    ship.turretAngle = targetAimAngle;
    ship.turretPitch = targetAimPitch;
    if (ship.weaponsInput) {
      ship.weaponsInput.aimAngle = targetAimAngle;
      ship.weaponsInput.aimPitch = targetAimPitch;
    }
    if (ship.weaponsState) {
      ship.weaponsState.aimAngle = targetAimAngle;
      ship.weaponsState.aimPitch = targetAimPitch;
    }

    // 4. Twin Pulse Lasers (Medium Range Combat)
    const laserCoolant = powerMap?.coolantMap?.weapons_laser ?? 1.0;
    const canFireOverheated = weapons.overheated && (targetDist <= 700 || laserCoolant <= 0);
    const laserHeatOk = !weapons.overheated ? (weapons.heat < 90 || targetDist <= 700) : canFireOverheated;

    if (allowLaserRailgun && targetDist <= 1200 && laserPower > 0 && laserHeatOk && weapons.cooldown <= 0) {
      const proj = weapons.fireLaser(body, targetAimAngle, laserPower, targetAimPitch);
      if (proj) {
        if (roomState.projectiles && !roomState.projectiles.includes(proj)) {
          roomState.projectiles.push(proj);
        }
        if (roomState.events) {
          roomState.events.push({
            type: 'laser_fired',
            shipId: ship.id,
            pos: { x: body.pos.x, y: body.pos.y, z: body.pos.z ?? 0 },
            aimAngle: targetAimAngle,
            aimPitch: targetAimPitch,
          });
        }
      }
    }

    // 5. Heavy Railgun (Long-Range Kinetic Piercing)
    const canFireRailgun = allowLaserRailgun && targetDist <= 2200;

    if (canFireRailgun && railgunPower > 0 && weapons.chargeProgress < 1.0) {
      if (!weapons.charging && weapons.railgunCooldown <= 0) {
        weapons.startRailgunCharge();
      }
    }

    if (weapons.chargeProgress >= 1.0 && !weapons.railgunJammed && canFireRailgun) {
      let angleDiff = normalizeAngle(weapons.railgunAngle - targetAimAngle);
      let pitchDiff = (weapons.railgunPitch || 0) - targetAimPitch;

      if (Math.abs(angleDiff) <= 0.15 && Math.abs(pitchDiff) <= 0.15) {
        const slug = weapons.releaseRailgun(body, weapons.railgunAngle, Math.max(0.8, railgunPower), weapons.railgunPitch || 0);
        if (slug) {
          if (roomState.projectiles && !roomState.projectiles.includes(slug)) {
            roomState.projectiles.push(slug);
          }
          if (roomState.events) {
            roomState.events.push({
              type: 'railgun_fired',
              shipId: ship.id,
              pos: { x: body.pos.x, y: body.pos.y, z: body.pos.z ?? 0 },
              aimAngle: weapons.railgunAngle,
              aimPitch: weapons.railgunPitch || 0,
            });
          }
        }
      }
    } else if (weapons.charging && weapons.chargeProgress < 1.0 && (railgunPower <= 0 || !canFireRailgun)) {
      weapons.stopRailgunCharge();
    }

    // 6. Homing Torpedoes
    const torpedoPower = powerMap.weapons_torpedo || 0;
    const neitherInNebula = !ship.inNebula && !enemyShip.inNebula;

    if (
      hasLOS &&
      distEnemy <= 1500 &&
      neitherInNebula &&
      torpedoPower > 0 &&
      weapons.magazine > 0 &&
      weapons.torpedoCooldown <= 0
    ) {
      const torp = weapons.launchTorpedo(body, lead.aimAngle, enemyShip.id, torpedoPower, lead.aimPitch || 0);
      if (torp) {
        if (roomState.projectiles && !roomState.projectiles.includes(torp)) {
          roomState.projectiles.push(torp);
        }
        if (roomState.events) {
          roomState.events.push({
            type: 'torpedo_launched',
            shipId: ship.id,
            pos: { x: body.pos.x, y: body.pos.y, z: body.pos.z ?? 0 },
            targetId: enemyShip.id,
            aimPitch: lead.aimPitch || 0,
          });
        }
      }
    }
  }
}

export class AIEngineer {
  /**
   * Updates 10x10 conduit power routing, repair drone dispatching,
   * idle system disconnection (zero-waste rule), and derelict cargo tractor resupply.
   *
   * @param {object} ship - friendly ship entity { id, body, grid, drones, weapons, ... }
   * @param {object} enemyShip - opponent ship entity
   * @param {object} roomState - { sector, ... }
   * @param {number} dt - simulation timestep (s)
   */
  static update(ship, enemyShip, roomState, dt) {
    if (
      !ship ||
      !ship.grid ||
      ship.destroyed ||
      (ship.hullHp !== undefined && ship.hullHp <= 0) ||
      Boolean(roomState?.replayActive) ||
      (roomState?.state && roomState.state !== 'playing')
    ) {
      return null;
    }

    const grid = ship.grid;
    const drones = ship.drones;
    const body = ship.body;

    // 1. Scan for broken conduit tiles on the 10x10 grid (sorted by proximity to Reactor (2,3) & Coolant (2,6))
    const brokenTiles = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const tile = grid.tiles[r][c];
        if (tile.status === 'broken') {
          brokenTiles.push(tile);
        }
      }
    }
    brokenTiles.sort((a, b) => {
      const distA = Math.min(Math.abs(a.row - 2) + Math.abs(a.col - 3), Math.abs(a.row - 2) + Math.abs(a.col - 6));
      const distB = Math.min(Math.abs(b.row - 2) + Math.abs(b.col - 3), Math.abs(b.row - 2) + Math.abs(b.col - 6));
      return distA - distB;
    });

    // 2. Scan for damaged ship subsystems (priority sorted: railgun, main drive, laser, lowest HP)
    const damagedSubsystems = [];
    if (body.thrusters) {
      for (const [bankKey, bank] of Object.entries(body.thrusters)) {
        if (bank.health < 100) {
          damagedSubsystems.push({ key: bankKey, health: bank.health });
        }
      }
    }
    if (body.mainDrive && body.mainDrive.health < 100) {
      damagedSubsystems.push({ key: 'mainDrive', health: body.mainDrive.health });
    }
    if (ship.weapons?.railgunHardware && ship.weapons.railgunHardware.health < 100) {
      damagedSubsystems.push({ key: 'weapons_railgun', health: ship.weapons.railgunHardware.health });
    }
    if (ship.weapons?.laserHardware && ship.weapons.laserHardware.health < 100) {
      damagedSubsystems.push({ key: 'weapons_laser', health: ship.weapons.laserHardware.health });
    }
    if (ship.weapons?.stabilizerHardware && ship.weapons.stabilizerHardware.health < 100) {
      damagedSubsystems.push({ key: 'sas_computer', health: ship.weapons.stabilizerHardware.health });
    }
    if (ship.hyperspace && ship.hyperspace.health < 100) {
      damagedSubsystems.push({ key: 'hyperspace', health: ship.hyperspace.health });
    }

    const priorityOrder = { weapons_railgun: 1, mainDrive: 2, main_drive: 2, weapons_laser: 3 };
    damagedSubsystems.sort((a, b) => {
      const pA = priorityOrder[a.key] || 99;
      const pB = priorityOrder[b.key] || 99;
      if (pA !== pB) return pA - pB;
      return a.health - b.health;
    });

    const needsRepair = brokenTiles.length > 0 || damagedSubsystems.length > 0;

    // 3. Dynamic Phase 13 System Boost Coordination (<= 3 systems)
    const tactical = ship.aiTactical || evaluateTacticalSituation(ship, enemyShip, roomState);
    if (typeof grid.setSystemBoost === 'function' && typeof grid.clearBoosts === 'function') {
      let desiredBoosts = [];
      if (ship.hyperspace?.state === 'charging') {
        desiredBoosts = ['hyperspace', 'shields_fore'];
      } else if (tactical.stance === 'railgun_sniper' || (tactical.distEnemy != null && tactical.distEnemy > 1200)) {
        desiredBoosts = ['weapons_railgun', 'main_drive', 'rcs_thrusters'];
      } else if (tactical.stance === 'evasive_regen') {
        desiredBoosts = [tactical.facingShieldSystemKey || 'shields_fore', 'rcs_thrusters', 'main_drive'];
      } else {
        // 'brawler' / 'flank_weak_quad'
        desiredBoosts = [
          'weapons_laser',
          'weapons_railgun',
          (ship.weapons?.magazine > 0 && tactical.distEnemy <= 1200) ? 'weapons_torpedo' : (tactical.facingShieldSystemKey || 'shields_fore'),
        ];
      }

      const validBoosts = desiredBoosts.filter(k => SUBSYSTEM_NODES.includes(k)).slice(0, 3);
      const currentBoosts = grid.boostedSystems || new Set();
      const isMatch = currentBoosts.size === validBoosts.length && validBoosts.every(k => currentBoosts.has(k));

      if (!isMatch) {
        grid.clearBoosts();
        for (const key of validBoosts) {
          grid.setSystemBoost(key, true);
        }
        ship.powerMap = grid.solvePowerFlow(ship.hull?.maxReactorPower || grid.defaultReactorCap, 0);
        ship.shields?.updatePower?.(ship.powerMap);
      }
    }

    // 4. Drone Management & Tasking
    if (drones && needsRepair) {
      // Collect currently tasked targets
      const taskedTiles = new Set();
      const taskedSubsystems = new Set();
      for (const d of drones.drones) {
        if (d.state !== 'idle') {
          if (d.targetType === 'tile' && d.target) {
            taskedTiles.add(`${d.target.row}_${d.target.col}`);
          } else if (d.targetType === 'subsystem' && d.target) {
            taskedSubsystems.add(d.target);
          }
        }
      }

      // Assign idle drones to broken tiles first
      for (const tile of brokenTiles) {
        const key = `${tile.row}_${tile.col}`;
        if (!taskedTiles.has(key)) {
          const idleDrone = drones.findFirstIdleDrone();
          if (idleDrone) {
            drones.assignToTile(idleDrone.id, tile.row, tile.col);
            taskedTiles.add(key);
          }
        }
      }

      // Assign remaining idle drones to damaged subsystems
      for (const sub of damagedSubsystems) {
        if (!taskedSubsystems.has(sub.key)) {
          const idleDrone = drones.findFirstIdleDrone();
          if (idleDrone) {
            drones.assignToSubsystem(idleDrone.id, sub.key, grid);
            taskedSubsystems.add(sub.key);
          }
        }
      }
    }

    // 5. Misaligned Tile Repair (from Ion Storm)
    // Periodically restores misaligned rotatable pipes back to DEFAULT_GRID_LAYOUT
    if (typeof grid.repairOneMisalignedTile === 'function') {
      const disconnected = (grid.lastPowerMap?.powerConnectedCount ?? TOTAL_EXTERNAL_SYSTEMS) < TOTAL_EXTERNAL_SYSTEMS ||
                           (grid.lastPowerMap?.coolantConnectedCount ?? TOTAL_EXTERNAL_SYSTEMS) < TOTAL_EXTERNAL_SYSTEMS;
      if (disconnected || !needsRepair) {
        grid.repairOneMisalignedTile();
      }
    }

    // 6. Capacitor Batteries Surge (if drydock module equipped and under combat pressure)
    if (grid.drydockModules?.engineer === 'capacitor_batteries') {
      const shieldFore = getEffectiveShieldHp(ship.shields, 'fore');
      if (shieldFore < 40) {
        // Find charged non-discharging capacitor
        for (let r = 0; r < 10; r++) {
          for (let c = 0; c < 10; c++) {
            const t = grid.tiles[r][c];
            if (t.type === 'capacitor' && t.charge > 5 && !t.discharging) {
              grid.dischargeCapacitor(r, c);
              break;
            }
          }
        }
      }
    }
  }
}

/**
 * Runs AI Auto-Crew for any unmanned stations on a ship.
 *
 * @param {object} ship - ship entity
 * @param {object} enemyShip - opponent ship entity
 * @param {object} roomState - room state
 * @param {number} dt - timestep in seconds
 * @param {object} [unmannedStations={ helm: true, weapons: true, engineer: true }]
 */
export function runAICrewForShip(
  ship,
  enemyShip,
  roomState,
  dt,
  unmannedStations = { helm: true, weapons: true, engineer: true }
) {
  if (
    !ship ||
    ship.destroyed ||
    (ship.hullHp !== undefined && ship.hullHp <= 0) ||
    Boolean(roomState?.replayActive) ||
    (roomState?.state && roomState.state !== 'playing')
  ) {
    return { helm: null, weapons: null, engineer: null };
  }

  let helm = null;
  let weapons = null;
  let engineer = null;

  if (unmannedStations.helm) {
    helm = AIHelm.update(ship, enemyShip, roomState, dt);
  }
  if (unmannedStations.weapons) {
    weapons = AIWeapons.update(ship, enemyShip, roomState, dt);
  }
  if (unmannedStations.engineer) {
    engineer = AIEngineer.update(ship, enemyShip, roomState, dt);
  }

  return { helm, weapons, engineer };
}
