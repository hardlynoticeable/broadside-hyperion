/**
 * BROADSIDE HYPERION — Gravitational Mechanics
 * Computes inverse-square gravitational acceleration from celestial bodies,
 * micro-singularities, and planetary masses for ships, debris, and projectiles.
 */

import { G as DEFAULT_G } from './constants.js';

/**
 * Calculates net gravitational acceleration vector at a given position from all gravity wells.
 * a_net = sum_i ( G * M_i / (|r_i|^2 + epsilon^2)^(3/2) * r_i )
 *
 * @param {object} pos - { x, y, [z] } target position
 * @param {Array<object>} gravityWells - array of { x, y, [z], mass, epsilon }
 * @param {number} [G=DEFAULT_G] - gravitational constant (default 50000.0)
 * @returns {object} { x, y, z } acceleration vector
 */
export function calculateGravityAcceleration(pos, gravityWells = [], G = DEFAULT_G) {
  let ax = 0;
  let ay = 0;
  let az = 0;

  const pz = pos.z ?? 0;

  for (const well of gravityWells) {
    const wx = (well.pos && typeof well.pos.x === 'number') ? well.pos.x : (well.x ?? 0);
    const wy = (well.pos && typeof well.pos.y === 'number') ? well.pos.y : (well.y ?? 0);
    const wz = (well.pos && typeof well.pos.z === 'number') ? well.pos.z : (well.z ?? 0);
    const rx = wx - pos.x;
    const ry = wy - pos.y;
    const rz = wz - pz;
    const distSq = rx * rx + ry * ry + rz * rz;
    const epsilon = well.epsilon ?? 15.0; // Softening parameter to prevent division by zero
    const mass = well.mass ?? 1000.0;

    const denom = Math.pow(distSq + epsilon * epsilon, 1.5);
    const factor = (G * mass) / denom;

    ax += factor * rx;
    ay += factor * ry;
    az += factor * rz;
  }

  return { x: ax, y: ay, z: az };
}

/**
 * Applies gravitational acceleration to a body over timestep dt, updating its velocity.
 *
 * @param {object} body - { pos: { x, y, [z] }, vel: { x, y, [z] } }
 * @param {Array<object>} gravityWells - array of { x, y, [z], mass, epsilon }
 * @param {number} dt - timestep in seconds
 * @param {number} [G=DEFAULT_G] - gravitational constant
 * @returns {object} { x, y, z } acceleration vector applied
 */
export function applyGravity(body, gravityWells = [], dt, G = DEFAULT_G) {
  const acc = calculateGravityAcceleration(body.pos, gravityWells, G);
  body.vel.x += acc.x * dt;
  body.vel.y += acc.y * dt;
  body.vel.z = (body.vel.z || 0) + acc.z * dt;
  return acc;
}
