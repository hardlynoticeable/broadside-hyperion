import { describe, it, expect } from 'vitest';
import { checkCircleCollision, resolveImpulse } from '../../src/physics/collisions.js';
import { calculateGravityAcceleration, applyGravity } from '../../src/physics/gravity.js';
import { RigidBody } from '../../src/physics/rigid-body.js';
import { G, MAX_SPIN_RATE } from '../../src/physics/constants.js';

describe('Collisions & Impulse Resolution', () => {
  describe('checkCircleCollision', () => {
    it('detects overlap between two circles and computes contact geometry', () => {
      const pos1 = { x: 0, y: 0 };
      const r1 = 30;
      const pos2 = { x: 50, y: 0 };
      const r2 = 30;

      const res = checkCircleCollision(pos1, r1, pos2, r2);
      expect(res.hit).toBe(true);
      expect(res.depth).toBe(10); // (30 + 30) - 50 = 10
      expect(res.normal.x).toBeCloseTo(1, 4);
      expect(res.normal.y).toBeCloseTo(0, 4);
      expect(res.contactPoint.x).toBeCloseTo(25, 4);
      expect(res.contactPoint.y).toBeCloseTo(0, 4);
    });

    it('returns hit false when circles do not touch', () => {
      const pos1 = { x: 0, y: 0 };
      const r1 = 20;
      const pos2 = { x: 100, y: 0 };
      const r2 = 20;

      const res = checkCircleCollision(pos1, r1, pos2, r2);
      expect(res.hit).toBe(false);
      expect(res.depth).toBe(0);
    });

    it('detects 3D sphere collision separated along z-axis and computes 3D normal', () => {
      const pos1 = { x: 0, y: 0, z: 0 };
      const r1 = 30;
      const pos2 = { x: 0, y: 0, z: 50 };
      const r2 = 30;

      const res = checkCircleCollision(pos1, r1, pos2, r2);
      expect(res.hit).toBe(true);
      expect(res.depth).toBe(10);
      expect(res.normal.x).toBeCloseTo(0, 4);
      expect(res.normal.y).toBeCloseTo(0, 4);
      expect(res.normal.z).toBeCloseTo(1, 4);
      expect(res.contactPoint.x).toBeCloseTo(0, 4);
      expect(res.contactPoint.y).toBeCloseTo(0, 4);
      expect(res.contactPoint.z).toBeCloseTo(25, 4);
    });

    it('returns hit false when separated vertically along z-axis beyond radius sum', () => {
      const pos1 = { x: 0, y: 0, z: 0 };
      const r1 = 20;
      const pos2 = { x: 0, y: 0, z: 50 };
      const r2 = 20;

      const res = checkCircleCollision(pos1, r1, pos2, r2);
      expect(res.hit).toBe(false);
      expect(res.depth).toBe(0);
    });
  });

  describe('resolveImpulse (Rigid Body Dynamics)', () => {
    it('transfers linear momentum and induces rotational spin based on contact offset', () => {
      // Body A moving East at 100 m/s
      const shipA = new RigidBody('corvette', { x: 0, y: 0, vx: 100, vy: 0 });
      // Stationary Body B at (50, 0)
      const shipB = new RigidBody('corvette', { x: 50, y: 0, vx: 0, vy: 0 });

      // Contact point is offset along Y axis at (25, 10), inducing torque on both
      const contactPoint = { x: 25, y: 10 };
      const normal = { x: 1, y: 0 }; // Normal points from A to B

      const res = resolveImpulse(shipA, shipB, contactPoint, normal, 1.0); // Perfectly elastic

      expect(res.impulseScalar).toBeGreaterThan(0);
      // Ship A slowed down in X
      expect(shipA.vel.x).toBeLessThan(100);
      // Ship B pushed forward in X
      expect(shipB.vel.x).toBeGreaterThan(0);

      // Contact offset at y = 10 induces torque:
      // rAx = 25, rAy = 10. rAxN = rx*ny - ry*nx = 25*0 - 10*1 = -10
      // delta omega_A = -J * (-10) / I_A > 0
      expect(shipA.omega).toBeGreaterThan(0);
      // rBx = -25, rBy = 10. rBxN = -25*0 - 10*1 = -10
      // delta omega_B = +J * (-10) / I_B < 0
      expect(shipB.omega).toBeLessThan(0);
    });

    it('does not resolve impulse when bodies are separating', () => {
      const shipA = new RigidBody('corvette', { x: 0, y: 0, vx: -50, vy: 0 });
      const shipB = new RigidBody('corvette', { x: 50, y: 0, vx: 50, vy: 0 });
      const contactPoint = { x: 25, y: 0 };
      const normal = { x: 1, y: 0 };

      const res = resolveImpulse(shipA, shipB, contactPoint, normal);
      expect(res.impulseScalar).toBe(0);
      expect(res.damageA).toBe(0);
      expect(res.damageB).toBe(0);
      expect(shipA.vel.x).toBe(-50);
      expect(shipB.vel.x).toBe(50);
    });

    it('reinforced_prow module reduces self damage by 60% and increases target damage by 150%', () => {
      // Standard ramming baseline (no prow module)
      const attackerStd = new RigidBody('corvette', {
        x: 0,
        y: 0,
        vx: 80,
        angle: 0, // Facing East, Bow is at +X
        modules: { helm: 'none' },
      });
      const defenderStd = new RigidBody('corvette', {
        x: 40,
        y: 0,
        vx: 0,
        angle: 0,
        modules: { helm: 'none' },
      });

      const contactStd = { x: 20, y: 0 }; // In front of attacker
      const normalStd = { x: 1, y: 0 };
      const resStd = resolveImpulse(attackerStd, defenderStd, contactStd, normalStd);

      // Now with reinforced_prow on attacker
      const attackerProw = new RigidBody('corvette', {
        x: 0,
        y: 0,
        vx: 80,
        angle: 0,
        modules: { helm: 'reinforced_prow' },
      });
      const defenderProw = new RigidBody('corvette', {
        x: 40,
        y: 0,
        vx: 0,
        angle: 0,
        modules: { helm: 'none' },
      });

      const resProw = resolveImpulse(attackerProw, defenderProw, contactStd, normalStd);

      // Verify damage reduction on attacker (-60% => 0.4x)
      expect(resProw.damageA).toBeCloseTo(resStd.damageA * 0.4, 4);
      // Verify damage multiplier on defender (+150% => 2.5x)
      expect(resProw.damageB).toBeCloseTo(resStd.damageB * 2.5, 4);
    });

    it('resolves 3D collision impulse and velocity delta along normal.z', () => {
      // Body A moving Dorsal (+Z) at 60 m/s
      const shipA = new RigidBody('corvette', { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 60 });
      // Stationary Body B at (0, 0, 40)
      const shipB = new RigidBody('corvette', { x: 0, y: 0, z: 40, vx: 0, vy: 0, vz: 0 });

      const contactPoint = { x: 0, y: 0, z: 20 };
      const normal = { x: 0, y: 0, z: 1 }; // Normal points from A to B along +Z

      const res = resolveImpulse(shipA, shipB, contactPoint, normal, 1.0);

      expect(res.impulseScalar).toBeGreaterThan(0);
      // Ship A slowed down in Z
      expect(shipA.vel.z).toBeLessThan(60);
      // Ship B propelled in +Z
      expect(shipB.vel.z).toBeGreaterThan(0);
    });

    it('clamps ship omega to Math.PI when resolveImpulse produces violent rotational impulse, while preserving isDebris fast tumbling', () => {
      // Massive dreadnought vs corvette offset collision with huge velocity
      const shipA = new RigidBody('dreadnought', { x: 0, y: 0, vx: 500, vy: 0 });
      const shipB = new RigidBody('corvette', { x: 40, y: 0, vx: -500, vy: 0 });
      const contactPoint = { x: 20, y: 15 };
      const normal = { x: 1, y: 0 };

      resolveImpulse(shipA, shipB, contactPoint, normal, 1.0);
      expect(Math.abs(shipA.omega)).toBeLessThanOrEqual(MAX_SPIN_RATE);
      expect(Math.abs(shipB.omega)).toBeLessThanOrEqual(MAX_SPIN_RATE);

      // Debris chunk allows high tumbling rate (isDebris: true)
      const debris = {
        isDebris: true,
        pos: { x: 40, y: 0 },
        vel: { x: 0, y: 0 },
        omega: 0,
        mass: 10,
        inertia: 50,
      };
      const heavyShip = new RigidBody('dreadnought', { x: 0, y: 0, vx: 500, vy: 0 });
      resolveImpulse(heavyShip, debris, contactPoint, normal, 1.0);
      expect(Math.abs(heavyShip.omega)).toBeLessThanOrEqual(MAX_SPIN_RATE);
      // debris omega can exceed Math.PI because isDebris = true
      expect(Math.abs(debris.omega)).toBeGreaterThan(MAX_SPIN_RATE);
    });
  });
});

describe('Gravitational Mechanics', () => {
  const gravityWells = [
    { x: 500, y: 0, mass: 1000, epsilon: 10 },
  ];

  it('calculates inverse-square acceleration towards gravity well', () => {
    const pos = { x: 0, y: 0 };
    const acc = calculateGravityAcceleration(pos, gravityWells, G);

    // rx = 500, ry = 0. dist = 500
    // a_x = G * M * r / (r^2 + eps^2)^(3/2) approx G * M / r^2
    const expectedAx = (G * 1000) / (500 * 500); // 50000 * 1000 / 250000 = 200 m/s^2
    expect(acc.x).toBeCloseTo(expectedAx, 0);
    expect(acc.y).toBe(0);
    expect(acc.x).toBeGreaterThan(0); // Pulls towards well (+x)
  });

  it('applies gravity to a rigid body velocity over dt', () => {
    const ship = new RigidBody('corvette', { x: 0, y: 0, vx: 0, vy: 0 });
    const dt = 1 / 60;

    applyGravity(ship, gravityWells, dt, G);

    expect(ship.vel.x).toBeGreaterThan(0);
    expect(ship.vel.y).toBe(0);
  });

  it('superposes acceleration linearly from multiple gravity wells', () => {
    const dualWells = [
      { x: 500, y: 0, mass: 1000, epsilon: 10 },
      { x: -500, y: 0, mass: 1000, epsilon: 10 },
    ];

    const pos = { x: 0, y: 0 };
    const acc = calculateGravityAcceleration(pos, dualWells, G);

    // Symmetrical wells cancel out exactly at origin
    expect(acc.x).toBeCloseTo(0, 4);
    expect(acc.y).toBeCloseTo(0, 4);
  });

  it('calculates 3D gravitational acceleration towards off-plane gravity well (z != 0)', () => {
    const well3D = [{ x: 0, y: 0, z: 500, mass: 1000, epsilon: 10 }];
    const pos = { x: 0, y: 0, z: 0 };
    const acc = calculateGravityAcceleration(pos, well3D, G);

    const expectedAz = (G * 1000) / (500 * 500); // 200 m/s^2
    expect(acc.x).toBe(0);
    expect(acc.y).toBe(0);
    expect(acc.z).toBeCloseTo(expectedAz, 0);
    expect(acc.z).toBeGreaterThan(0);
  });

  it('applies 3D gravitational acceleration to body vel.z over dt', () => {
    const well3D = [{ x: 0, y: 0, z: -500, mass: 1000, epsilon: 10 }];
    const ship = new RigidBody('corvette', { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    const dt = 1 / 60;

    applyGravity(ship, well3D, dt, G);

    expect(ship.vel.x).toBe(0);
    expect(ship.vel.y).toBe(0);
    expect(ship.vel.z).toBeLessThan(0); // Pulled down in -Z
  });
});
