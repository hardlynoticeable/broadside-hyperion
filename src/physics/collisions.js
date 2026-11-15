/**
 * BROADSIDE HYPERION — Rigid Body Collisions & Impulse Resolution
 * Implements circle/sphere collision detection, 3D rigid-body impulse
 * resolution with angular momentum transfer, and damage calculation (with
 * reinforced prow modifier).
 */

import { COLLISION_RESTITUTION, clampAngularVelocity } from './constants.js';

/**
 * Checks for collision between two circles or spheres in 3D.
 * Returns hit boolean, overlap depth, normal pointing from 1 to 2, and contact point.
 */
export function checkCircleCollision(pos1, r1, pos2, r2) {
  const dx = pos2.x - pos1.x;
  const dy = pos2.y - pos1.y;
  const dz = (pos2.z ?? 0) - (pos1.z ?? 0);
  const distSq = dx * dx + dy * dy + dz * dz;
  const radSum = r1 + r2;

  if (distSq >= radSum * radSum) {
    return {
      hit: false,
      depth: 0,
      normal: { x: 0, y: 0, z: 0 },
      contactPoint: null,
    };
  }

  const dist = Math.sqrt(distSq);
  const depth = radSum - dist;
  let nx = 1;
  let ny = 0;
  let nz = 0;

  if (dist > 1e-6) {
    nx = dx / dist;
    ny = dy / dist;
    nz = dz / dist;
  }

  const contactPoint = {
    x: pos1.x + nx * (r1 - depth * 0.5),
    y: pos1.y + ny * (r1 - depth * 0.5),
    z: (pos1.z ?? 0) + nz * (r1 - depth * 0.5),
  };

  return {
    hit: true,
    depth,
    normal: { x: nx, y: ny, z: nz },
    contactPoint,
  };
}

export const checkSphereCollision = checkCircleCollision;

/**
 * Resolves 3D rigid-body collision impulse between bodyA and bodyB.
 * Normal points from bodyA to bodyB.
 * Computes linear velocity delta (x, y, z), angular velocity delta, and kinetic damage.
 *
 * @param {object} bodyA - First rigid body { pos, vel, omega, mass, inertia, angle, armor, modules, hullHp }
 * @param {object} bodyB - Second rigid body
 * @param {object} contactPoint - World coordinate of impact { x, y, z }
 * @param {object} normal - Unit normal pointing from A to B { x, y, z }
 * @param {number} [restitution=COLLISION_RESTITUTION] - Coefficient of restitution
 */
export function resolveImpulse(
  bodyA,
  bodyB,
  contactPoint,
  normal,
  restitution = COLLISION_RESTITUTION
) {
  const nx = normal.x || 0;
  const ny = normal.y || 0;
  const nz = normal.z || 0;

  // Lever arms relative to Center of Mass
  const rAx = contactPoint.x - bodyA.pos.x;
  const rAy = contactPoint.y - bodyA.pos.y;
  const rBx = contactPoint.x - bodyB.pos.x;
  const rBy = contactPoint.y - bodyB.pos.y;

  // Point velocities: u = v + omega x r
  const uAx = (bodyA.vel.x || 0) - (bodyA.omega || 0) * rAy;
  const uAy = (bodyA.vel.y || 0) + (bodyA.omega || 0) * rAx;
  const uAz = bodyA.vel.z || 0;
  const uBx = (bodyB.vel.x || 0) - (bodyB.omega || 0) * rBy;
  const uBy = (bodyB.vel.y || 0) + (bodyB.omega || 0) * rBx;
  const uBz = bodyB.vel.z || 0;

  // Relative velocity (A relative to B)
  const vRelX = uAx - uBx;
  const vRelY = uAy - uBy;
  const vRelZ = uAz - uBz;

  // Closing velocity along normal (pointing from A to B)
  const vClosing = vRelX * nx + vRelY * ny + vRelZ * nz;

  // If bodies are separating, no impulse
  if (vClosing <= 0) {
    return { impulseScalar: 0, damageA: 0, damageB: 0 };
  }

  // 2D cross product: r x n = rx * ny - ry * nx
  const rAxN = rAx * ny - rAy * nx;
  const rBxN = rBx * ny - rBy * nx;

  const invMassA = bodyA.mass ? 1 / bodyA.mass : 0;
  const invMassB = bodyB.mass ? 1 / bodyB.mass : 0;
  const invInertiaA = bodyA.inertia ? 1 / bodyA.inertia : 0;
  const invInertiaB = bodyB.inertia ? 1 / bodyB.inertia : 0;

  const invEffMass =
    invMassA +
    invMassB +
    rAxN * rAxN * invInertiaA +
    rBxN * rBxN * invInertiaB;

  if (invEffMass < 1e-9) {
    return { impulseScalar: 0, damageA: 0, damageB: 0 };
  }

  // Impulse scalar
  const J = ((1 + restitution) * vClosing) / invEffMass;

  // Apply linear and angular velocity changes
  bodyA.vel.x = (bodyA.vel.x || 0) - J * nx * invMassA;
  bodyA.vel.y = (bodyA.vel.y || 0) - J * ny * invMassA;
  bodyA.vel.z = (bodyA.vel.z || 0) - J * nz * invMassA;
  bodyA.omega = (bodyA.omega || 0) - J * rAxN * invInertiaA;

  bodyB.vel.x = (bodyB.vel.x || 0) + J * nx * invMassB;
  bodyB.vel.y = (bodyB.vel.y || 0) + J * ny * invMassB;
  bodyB.vel.z = (bodyB.vel.z || 0) + J * nz * invMassB;
  bodyB.omega = (bodyB.omega || 0) + J * rBxN * invInertiaB;

  if (!bodyA.isDebris) {
    clampAngularVelocity(bodyA);
  }
  if (!bodyB.isDebris) {
    clampAngularVelocity(bodyB);
  }

  // Kinetic collision damage calculation: D = max(0, |J| * 0.05 - armor)
  const Jmag = Math.abs(J);
  let damageA = Math.max(0, Jmag * 0.05 - (bodyA.armor || 0));
  let damageB = Math.max(0, Jmag * 0.05 - (bodyB.armor || 0));

  // Determine if contact is at the Bow (rx > 0 in ship-local coordinates)
  const angleA = bodyA.angle || 0;
  const rAlocalX = rAx * Math.cos(angleA) + rAy * Math.sin(angleA);
  const prowHitA = rAlocalX > 0 && bodyA.modules?.helm === 'reinforced_prow';

  const angleB = bodyB.angle || 0;
  const rBlocalX = rBx * Math.cos(angleB) + rBy * Math.sin(angleB);
  const prowHitB = rBlocalX > 0 && bodyB.modules?.helm === 'reinforced_prow';

  // Reinforced prow: -60% self damage, +150% opponent damage
  if (prowHitA) {
    damageA *= 0.4;
    damageB *= 2.5;
  }
  if (prowHitB) {
    damageB *= 0.4;
    damageA *= 2.5;
  }

  if (typeof bodyA.hullHp === 'number') {
    bodyA.hullHp = Math.max(0, bodyA.hullHp - damageA);
  }
  if (typeof bodyB.hullHp === 'number') {
    bodyB.hullHp = Math.max(0, bodyB.hullHp - damageB);
  }

  return {
    impulseScalar: J,
    damageA,
    damageB,
  };
}


