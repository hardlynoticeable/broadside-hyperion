import { describe, it, expect, beforeEach } from 'vitest';
import { RigidBody } from '../../src/physics/rigid-body.js';
import {
  HULL_CLASSES,
  getThrusterMounts,
  MAX_PITCH_RAD,
  MAX_GIMBAL_RAD,
  SHIP_PACING_SCALE,
  MAX_SPIN_RATE,
  DAMPENING_FIELD_WIDTH,
  DAMPENING_FIELD_MAX_RATE,
  clampAngularVelocity,
  computeDampeningFieldStrength,
} from '../../src/physics/constants.js';
import { AIHelm } from '../../src/server/ai-crew.js';

describe('RigidBody Physics & Dynamics', () => {
  describe('Hull Specs & Initial State', () => {
    it('initializes with default Corvette specs', () => {
      const ship = new RigidBody('corvette');
      expect(ship.mass).toBe(1000);
      expect(ship.length).toBe(40);
      expect(ship.width).toBe(20);
      expect(ship.inertia).toBeCloseTo(166666.67, 1);
      expect(ship.armor).toBe(40);
      expect(ship.maxHullHp).toBe(600);
      expect(ship.hullHp).toBe(600);
      expect(ship.rollInertia).toBeCloseTo(66666.67, 1);
      expect(ship.rollAngle).toBe(0);
      expect(ship.rollOmega).toBe(0);
      expect(ship.rollState).toBe(0);
      expect(ship.stopRollActive).toBe(false);
      expect(ship.autoOrientMode).toBeNull();
      expect(ship.sasActive).toBe(true);
    });

    it('initializes Frigate and Dreadnought specs correctly', () => {
      const frigate = new RigidBody('frigate');
      expect(frigate.mass).toBe(1800);
      expect(frigate.length).toBe(60);
      expect(frigate.width).toBe(28);
      expect(frigate.inertia).toBeCloseTo(657600, 1);
      expect(frigate.armor).toBe(75);
      expect(frigate.rollInertia).toBeCloseTo(235200, 1);

      const dread = new RigidBody('dreadnought');
      expect(dread.mass).toBe(3200);
      expect(dread.length).toBe(90);
      expect(dread.width).toBe(40);
      expect(dread.inertia).toBeCloseTo(2586666.67, 1);
      expect(dread.armor).toBe(120);
      expect(dread.rollInertia).toBeCloseTo(853333.33, 1);
    });
  });

  describe('Newtonian Kinematics (Zero Friction in Vacuum)', () => {
    it('retains constant linear velocity indefinitely without applied forces', () => {
      const ship = new RigidBody('corvette', { vx: 150, vy: 0 });
      const dt = 1 / 60;

      // Simulate 100 ticks
      for (let i = 0; i < 100; i++) {
        ship.update(dt);
      }

      // No drag in vacuum: velocity must remain exactly 150 m/s
      expect(ship.vel.x).toBe(150);
      expect(ship.vel.y).toBe(0);
      expect(ship.pos.x).toBeCloseTo(150 * (100 * dt), 5);
      expect(ship.pos.y).toBe(0);
    });

    it('retains constant angular velocity when SAS is disabled', () => {
      const ship = new RigidBody('corvette', { omega: 1.5, sasActive: false });
      const dt = 1 / 60;

      for (let i = 0; i < 100; i++) {
        ship.update(dt);
      }

      expect(ship.omega).toBe(1.5);
    });

    it('accelerates linearly under main drive thrust', () => {
      const ship = new RigidBody('corvette', { modules: { helm: 'none' } });
      ship.setMainDriveThrottle(1.0);
      const dt = 1 / 60;

      // Expected linear acceleration: a = F_main / m = 120,000 / 1000 = 120 m/s^2
      ship.update(dt);
      expect(ship.vel.x).toBeCloseTo(120 * dt, 4);
      expect(ship.vel.y).toBeCloseTo(0, 4);
      expect(ship.omega).toBe(0); // Main drive through CoM produces zero torque
    });
  });

  describe('RCS Thruster Torque & Geometry', () => {
    it('produces positive torque when firing bowPort and negative torque for sternPort', () => {
      const ship = new RigidBody('corvette', { modules: { helm: 'none' }, sasActive: false });
      const mounts = getThrusterMounts('corvette');
      const dt = 1 / 60;

      // bowPort is at rx = +0.4 L, ry = -0.5 W, fy = +1
      // tau = rx * fy - ry * fx = (+0.4 L)(+1) - (-0.5 W)(0) = +0.4 * 40 = +16 m
      // Force = 24,000 N -> tau = +384,000 N*m
      ship.fireThruster('bowPort', 1.0);
      ship.update(dt);
      const expectedAlpha = 384000 / ship.inertia;
      expect(ship.omega).toBeCloseTo(expectedAlpha * dt, 4);
      expect(ship.omega).toBeGreaterThan(0);

      // Reset and test sternPort
      const ship2 = new RigidBody('corvette', { modules: { helm: 'none' }, sasActive: false });
      ship2.fireThruster('sternPort', 1.0);
      ship2.update(dt);
      expect(ship2.omega).toBeCloseTo(-expectedAlpha * dt, 4);
      expect(ship2.omega).toBeLessThan(0);
    });

    it('produces zero net torque and pure lateral acceleration during symmetrical strafe', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      ship.commandPilot({ strafe: 1.0 }); // Starboard strafe fires bowPort + sternPort
      const dt = 1 / 60;

      ship.update(dt);

      // Torques cancel out completely
      expect(ship.omega).toBeCloseTo(0, 6);
      // Net lateral acceleration in ship's local +y direction
      expect(ship.vel.y).toBeGreaterThan(0);
      expect(ship.vel.x).toBeCloseTo(0, 6);
    });

    it('spins the ship when bowPort is damaged (thruster damage asymmetry)', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      // Damage bowPort to 0 health
      ship.thrusters.bowPort.health = 0;

      // Command strafe starboard (normally bowPort + sternPort)
      ship.commandPilot({ strafe: 1.0 });
      const dt = 1 / 60;

      ship.update(dt);

      // Only sternPort fires! Produces negative torque (tau = -0.4 * L * F)
      expect(ship.omega).toBeLessThan(0);
      expect(Math.abs(ship.omega)).toBeGreaterThan(0.001);
      // Still provides lateral thrust from sternPort
      expect(ship.vel.y).toBeGreaterThan(0);
    });

    it('spins in reverse when sternPort is damaged during strafe', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      ship.thrusters.sternPort.health = 0;

      ship.commandPilot({ strafe: 1.0 });
      const dt = 1 / 60;

      ship.update(dt);

      // Only bowPort fires! Produces positive torque (tau = +0.4 * L * F)
      expect(ship.omega).toBeGreaterThan(0);
    });
  });

  describe('Stability Augmentation System (SAS) PID Controller', () => {
    it('damps spinning ship (omega = 2.0 rad/s) to |omega| < 0.01 within 2 seconds when powered', () => {
      const ship = new RigidBody('corvette', { omega: 2.0, sasActive: true });
      const dt = 1 / 60;
      const ticks = 120; // 2.0 seconds

      for (let i = 0; i < ticks; i++) {
        ship.update(dt, 1, 1, 1); // RCS, mainDrive, SAS all powered
      }

      expect(Math.abs(ship.omega)).toBeLessThan(0.01);
    });

    it('maintains angular rate without deceleration when SAS is unpowered', () => {
      const ship = new RigidBody('corvette', { omega: 2.0, sasActive: true });
      const dt = 1 / 60;
      const ticks = 120;

      for (let i = 0; i < ticks; i++) {
        ship.update(dt, 1, 1, 0); // sasPowered = 0 (unpowered)
      }

      // Zero counter-torque applied
      expect(ship.omega).toBe(2.0);
    });

    it('maintains angular rate without deceleration when SAS is toggled off', () => {
      const ship = new RigidBody('corvette', { omega: 1.8, sasActive: false });
      const dt = 1 / 60;

      for (let i = 0; i < 60; i++) {
        ship.update(dt, 1, 1, 1);
      }

      expect(ship.omega).toBe(1.8);
    });
  });

  describe('Physical Roll RCS & Stop-Roll Kinematics', () => {
    it('fires dorsalRoll to produce positive roll torque, increasing rollOmega and rollAngle', () => {
      const ship = new RigidBody('corvette', { modules: { helm: 'none' } });
      const dt = 1 / 60;

      // Single bank roll torque: 0.5 * W * F_rcs = 0.5 * 20 * 24,000 = 240,000 N*m
      // rollAlpha = 240,000 / 66666.67 = 3.6 rad/s^2
      ship.fireThruster('dorsalRoll', 1.0);
      expect(ship.thrusters.dorsalRoll.throttle).toBe(1.0);
      expect(ship.manualRollCommanded).toBe(true);
      expect(ship.stopRollActive).toBe(false);

      ship.update(dt);
      expect(ship.thrusters.dorsalRoll.isFiring).toBe(true);
      expect(ship.rollOmega).toBeCloseTo(3.6 * dt, 4);
      expect(ship.rollOmega).toBeGreaterThan(0);
      expect(ship.rollAngle).toBeGreaterThan(0);
    });

    it('fires ventralRoll to produce negative roll torque, decreasing rollOmega and rollAngle', () => {
      const ship = new RigidBody('corvette', { modules: { helm: 'none' } });
      const dt = 1 / 60;

      ship.fireThruster('ventralRoll', 1.0);
      expect(ship.thrusters.ventralRoll.throttle).toBe(1.0);
      expect(ship.manualRollCommanded).toBe(true);

      ship.update(dt);
      expect(ship.thrusters.ventralRoll.isFiring).toBe(true);
      expect(ship.rollOmega).toBeCloseTo(-3.6 * dt, 4);
      expect(ship.rollOmega).toBeLessThan(0);
      expect(ship.rollAngle).toBeLessThan(0);
    });

    it('allocates roll controls via commandPilot({ roll })', () => {
      const ship = new RigidBody('corvette');
      ship.commandPilot({ roll: 0.75 });
      expect(ship.thrusters.dorsalRoll.throttle).toBe(0.75);
      expect(ship.thrusters.ventralRoll.throttle).toBe(0);
      expect(ship.manualRollCommanded).toBe(true);

      ship.commandPilot({ roll: -0.5 });
      expect(ship.thrusters.dorsalRoll.throttle).toBe(0);
      expect(ship.thrusters.ventralRoll.throttle).toBe(0.5);
      expect(ship.manualRollCommanded).toBe(true);
    });

    it('retains constant rollOmega indefinitely in vacuum (zero drag)', () => {
      const ship = new RigidBody('corvette', { rollOmega: 2.5 });
      const dt = 1 / 60;

      for (let i = 0; i < 120; i++) {
        ship.update(dt);
      }

      // No drag in vacuum: roll rate must remain exactly 2.5 rad/s
      expect(ship.rollOmega).toBe(2.5);
      expect(ship.rollAngle).not.toBe(0);
    });

    it('stopRoll(true) fires opposing roll RCS thruster to damp rollOmega to 0', () => {
      const ship = new RigidBody('corvette', { rollOmega: 2.0 });
      const dt = 1 / 60;

      ship.stopRoll(true);
      expect(ship.stopRollActive).toBe(true);
      expect(ship.manualRollCommanded).toBe(false);

      // In the first tick, ventralRoll must fire to counter positive rollOmega
      ship.update(dt);
      expect(ship.thrusters.ventralRoll.isFiring).toBe(true);
      expect(ship.rollOmega).toBeLessThan(2.0);

      // Simulate further ticks until fully stopped
      for (let i = 0; i < 60; i++) {
        ship.update(dt);
      }

      expect(ship.rollOmega).toBe(0);
      expect(ship.stopRollActive).toBe(false);
      expect(ship.thrusters.ventralRoll.isFiring).toBe(false);
      expect(ship.thrusters.ventralRoll.throttle).toBe(0);
    });

    it('fails to stop roll if the opposing roll RCS thruster is destroyed', () => {
      const ship = new RigidBody('corvette', { rollOmega: 2.0 });
      const dt = 1 / 60;

      // Opposing thruster (ventralRoll) is destroyed
      ship.thrusters.ventralRoll.health = 0;
      ship.stopRoll(true);

      for (let i = 0; i < 60; i++) {
        ship.update(dt);
      }

      // Ship fails to brake because ventralRoll cannot produce counter-torque!
      expect(ship.rollOmega).toBe(2.0);
      expect(ship.stopRollActive).toBe(true);
    });
  });

  describe('Auto-Orientation Modes & Controller', () => {
    it('sets valid modes and falls back to null for invalid modes', () => {
      const ship = new RigidBody('corvette');
      ship.setAutoOrientMode('prograde');
      expect(ship.autoOrientMode).toBe('prograde');
      expect(ship.sasActive).toBe(true);

      ship.setAutoOrientMode('invalid_mode');
      expect(ship.autoOrientMode).toBeNull();
    });

    it('aligns to prograde velocity heading', () => {
      // Ship moving in +Y direction (heading = PI / 2)
      const ship = new RigidBody('corvette', { vx: 0, vy: 80, angle: 0 });
      ship.setAutoOrientMode('prograde');
      const dt = 1 / 60;

      for (let i = 0; i < 180; i++) {
        ship.update(dt);
      }

      expect(ship.angle).toBeCloseTo(Math.PI / 2, 1);
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('aligns to retrograde velocity heading', () => {
      // Ship moving in +X direction (heading = 0; retrograde = PI)
      const ship = new RigidBody('corvette', { vx: 80, vy: 0, angle: 0 });
      ship.setAutoOrientMode('retrograde');
      const dt = 1 / 60;

      for (let i = 0; i < 180; i++) {
        ship.update(dt);
        expect(Math.abs(ship.omega)).toBeLessThanOrEqual(2.1 + 1e-3);
      }

      expect(Math.abs(Math.abs(ship.angle) - Math.PI)).toBeLessThan(0.15);
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('caps instantaneous auto-orient slew rate at <= 2.1 rad/s (yaw) and <= 1.8 rad/s (pitch) over large orientation errors', () => {
      // Large yaw error (facing 0, target enemy at -X, error ~ 180 deg)
      // Large pitch error (facing pitch 0, target enemy pitched up)
      const ship = new RigidBody('corvette', { x: 0, y: 0, z: 0, angle: 0, pitch: 0 });
      ship.setAutoOrientMode('target');
      const dt = 1 / 60;
      // Enemy at (-1000, 0, 800) -> requires large 180° yaw slew and ~38.6° pitch slew
      const navContext = { enemyPos: { x: -1000, y: 0, z: 800 }, enemyKnown: true };

      let maxObservedYawRate = 0;
      let maxObservedPitchRate = 0;

      for (let i = 0; i < 240; i++) {
        ship.update(dt, 1, 1, 1, navContext);
        const absYaw = Math.abs(ship.omega);
        const absPitch = Math.abs(ship.pitchOmega);
        if (absYaw > maxObservedYawRate) maxObservedYawRate = absYaw;
        if (absPitch > maxObservedPitchRate) maxObservedPitchRate = absPitch;

        // Instantaneous rate caps must hold on every single tick
        // Yaw cap: 3.5 * SHIP_PACING_SCALE = 3.5 * 0.6 = 2.1 rad/s
        // Pitch cap: 3.0 * SHIP_PACING_SCALE = 3.0 * 0.6 = 1.8 rad/s
        expect(absYaw).toBeLessThanOrEqual(2.1 + 1e-3);
        expect(absPitch).toBeLessThanOrEqual(1.8 + 1e-3);
      }

      expect(maxObservedYawRate).toBeGreaterThan(0.5);
      expect(maxObservedPitchRate).toBeGreaterThan(0.5);
      expect(maxObservedYawRate).toBeLessThanOrEqual(2.1 + 1e-3);
      expect(maxObservedPitchRate).toBeLessThanOrEqual(1.8 + 1e-3);
    });

    it('aligns to target enemy position when enemy is known', () => {
      // Ship at (0, 0), enemy at (0, 600) -> target angle = PI / 2
      const ship = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      ship.setAutoOrientMode('target');
      const dt = 1 / 60;
      const navContext = { enemyPos: { x: 0, y: 600 }, enemyKnown: true };

      for (let i = 0; i < 180; i++) {
        ship.update(dt, 1, 1, 1, navContext);
      }

      expect(ship.angle).toBeCloseTo(Math.PI / 2, 1);
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('aligns to anti_target away from enemy position', () => {
      // Ship at (0, 0), enemy at (600, 0) -> vector away is (-600, 0), angle = PI
      const ship = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      ship.setAutoOrientMode('anti_target');
      const dt = 1 / 60;
      const navContext = { enemyPos: { x: 600, y: 0 }, enemyKnown: true };

      for (let i = 0; i < 180; i++) {
        ship.update(dt, 1, 1, 1, navContext);
      }

      expect(Math.abs(Math.abs(ship.angle) - Math.PI)).toBeLessThan(0.15);
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('masks target orientation when in nebula (enemyKnown: false)', () => {
      const ship = new RigidBody('corvette', { x: 0, y: 0, angle: 0, omega: 1.0 });
      ship.setAutoOrientMode('target');
      const navContext = { enemyPos: { x: 0, y: 600 }, enemyKnown: false };

      expect(ship.resolveAutoOrientAngle(navContext)).toBeNull();

      // Because resolveAutoOrientAngle returns null, SAS dampens angular rate
      for (let i = 0; i < 120; i++) {
        ship.update(1 / 60, 1, 1, 1, navContext);
      }
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('cancels auto-orientation when manual turn is commanded', () => {
      const ship = new RigidBody('corvette');
      ship.setAutoOrientMode('prograde');
      expect(ship.autoOrientMode).toBe('prograde');

      ship.commandPilot({ turn: 0.5 });
      expect(ship.autoOrientMode).toBeNull();
    });

    it('struggles to orient (reduced torque, lateral drift, and braking overshoot) when RCS jets are broken or damaged', () => {
      const dt = 1 / 60;
      const navContext = { enemyPos: { x: 0, y: 600 }, enemyKnown: true }; // Target = +PI/2

      // 1. Healthy ship vs ship with broken bowPort (only sternStarboard fires for +torque)
      const healthyShip = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      const damagedTurnShip = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      damagedTurnShip.thrusters.bowPort.health = 0; // Broken bowPort!

      healthyShip.setAutoOrientMode('target');
      damagedTurnShip.setAutoOrientMode('target');

      healthyShip.update(dt, 1, 1, 1, navContext);
      damagedTurnShip.update(dt, 1, 1, 1, navContext);

      // With bowPort broken, damagedTurnShip achieves only half the angular acceleration AND drifts sideways!
      expect(damagedTurnShip.omega).toBeCloseTo(healthyShip.omega * 0.5, 4);
      expect(Math.abs(healthyShip.vel.y)).toBeLessThan(1e-6); // Balanced couple -> zero lateral drift
      expect(Math.abs(damagedTurnShip.vel.y)).toBeGreaterThan(0.1); // Unbalanced single jet -> lateral drift!

      // 2. When both braking jets (bowStarboard & sternPort) are broken, the ship cannot arrest its turn and overshoots wildly!
      const brokenBrakeShip = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      brokenBrakeShip.thrusters.bowStarboard.health = 0;
      brokenBrakeShip.thrusters.sternPort.health = 0;
      brokenBrakeShip.setAutoOrientMode('target');

      for (let i = 0; i < 60; i++) {
        brokenBrakeShip.update(dt, 1, 1, 1, navContext);
      }
      // Because it cannot fire negative-torque braking jets, it still has high positive omega and overshoots PI/2!
      expect(brokenBrakeShip.omega).toBeGreaterThan(1.0);
      expect(brokenBrakeShip.angle).toBeGreaterThan(Math.PI / 2 + 0.1);

      // 3. When both turning jets (bowPort & sternStarboard) are broken, it cannot initiate positive turn at all
      const deadTurnShip = new RigidBody('corvette', { x: 0, y: 0, angle: 0 });
      deadTurnShip.thrusters.bowPort.health = 0;
      deadTurnShip.thrusters.sternStarboard.health = 0;
      deadTurnShip.setAutoOrientMode('target');
      deadTurnShip.update(dt, 1, 1, 1, navContext);
      expect(deadTurnShip.omega).toBe(0);
    });
  });

  describe('Drydock Helm Modules', () => {
    it('overdrive_rcs increases RCS thrust and torque by +35%', () => {
      const normalShip = new RigidBody('corvette', { modules: { helm: 'none' }, sasActive: false });
      const overdriveShip = new RigidBody('corvette', { modules: { helm: 'overdrive_rcs' }, sasActive: false });
      const dt = 1 / 60;

      normalShip.fireThruster('bowPort', 1.0);
      overdriveShip.fireThruster('bowPort', 1.0);

      normalShip.update(dt);
      overdriveShip.update(dt);

      expect(overdriveShip.omega / normalShip.omega).toBeCloseTo(1.35, 3);
    });

    it('reaction_wheel provides emergency torque when all RCS thrusters are unpowered/destroyed', () => {
      const ship = new RigidBody('corvette', { modules: { helm: 'reaction_wheel' }, sasActive: false });
      // Unpower RCS
      ship.commandPilot({ turn: 1.0 });
      const dt = 1 / 60;

      // Update with rcsPowered = 0
      ship.update(dt, 0, 1, 0);

      // Reaction wheel generates emergency torque: 0.25 * (0.8 * L * F_rcs) = 0.2 * L * F_rcs
      expect(ship.omega).toBeGreaterThan(0);
      const expectedTau = 0.25 * (0.8 * ship.length * ship.rcsThrust);
      const expectedAlpha = expectedTau / ship.inertia;
      expect(ship.omega).toBeCloseTo(expectedAlpha * dt, 4);
    });
  });

  describe('Effective Quadrant Mapping with 180° Roll', () => {
    it('correctly maps 4 quadrants when normal (rollState = 0)', () => {
      const ship = new RigidBody('corvette', { angle: 0 }); // Facing East (+X)
      expect(ship.getEffectiveQuadrant(0)).toBe('fore');
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('starboard');
      expect(ship.getEffectiveQuadrant(Math.PI)).toBe('aft');
      expect(ship.getEffectiveQuadrant(-Math.PI / 2)).toBe('port');
    });

    it('swaps Port and Starboard in world space when inverted (rollState = 1)', () => {
      const ship = new RigidBody('corvette', { angle: 0, rollState: 1 });
      expect(ship.getEffectiveQuadrant(0)).toBe('fore');
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('port'); // Inverted!
      expect(ship.getEffectiveQuadrant(Math.PI)).toBe('aft');
      expect(ship.getEffectiveQuadrant(-Math.PI / 2)).toBe('starboard'); // Inverted!
    });

    it('derives rollState dynamically from physical rollAngle crossing +/-90 degrees', () => {
      const ship = new RigidBody('corvette', { angle: 0, rollAngle: 0 });
      expect(ship.rollState).toBe(0);
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('starboard');

      // Roll to +120° (past +90°)
      ship.rollAngle = (2 * Math.PI) / 3;
      expect(ship.rollState).toBe(1);
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('port');

      // Roll to -120° (past -90°)
      ship.rollAngle = -(2 * Math.PI) / 3;
      expect(ship.rollState).toBe(1);
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('port');

      // Roll back upright to 45° (< 90°)
      ship.rollAngle = Math.PI / 4;
      expect(ship.rollState).toBe(0);
      expect(ship.getEffectiveQuadrant(Math.PI / 2)).toBe('starboard');
    });

    it('scales thrust and torque continuously with numeric power inputs (0.8 RCS, 0.5 Main Drive)', () => {
      const fullShip = new RigidBody('corvette', { sasActive: false });
      const scaledShip = new RigidBody('corvette', { sasActive: false });
      const dt = 1 / 60;

      fullShip.commandPilot({ forward: 1.0, turn: 1.0 });
      scaledShip.commandPilot({ forward: 1.0, turn: 1.0 });

      // fullShip gets power = 1.0, scaledShip gets rcsPower = 0.8, mainDrivePower = 0.5
      fullShip.update(dt, 1.0, 1.0, 1.0);
      scaledShip.update(dt, 0.8, 0.5, 0.8);

      // Linear acceleration scales with main drive power (0.5x)
      expect(scaledShip.vel.x / fullShip.vel.x).toBeCloseTo(0.5, 3);

      // Cooperated angular acceleration reflects gimbal + topped-up RCS scaling to rcsPower (0.8x)
      expect(scaledShip.omega / fullShip.omega).toBeCloseTo(0.8, 2);

      // Pure RCS without forward thrust (forward: 0) scales purely with RCS power (0.8x)
      const rcsFull = new RigidBody('corvette', { sasActive: false });
      const rcsScaled = new RigidBody('corvette', { sasActive: false });
      rcsFull.commandPilot({ forward: 0, turn: 1.0 });
      rcsScaled.commandPilot({ forward: 0, turn: 1.0 });
      rcsFull.update(dt, 1.0, 1.0, 1.0);
      rcsScaled.update(dt, 0.8, 0.5, 0.8);
      expect(rcsScaled.omega / rcsFull.omega).toBeCloseTo(0.8, 3);
    });
  });

  describe('3D Pitch Dynamics, RCS Couplers & Attitude Control', () => {
    it('initializes pitch properties and 3D position/velocity specs', () => {
      const ship = new RigidBody('corvette', { z: 120, vz: -15, pitch: 0.2, pitchOmega: 0.1 });
      expect(ship.pos.z).toBe(120);
      expect(ship.vel.z).toBe(-15);
      expect(ship.pitch).toBe(0.2);
      expect(ship.pitchOmega).toBe(0.1);
      expect(ship.pitchInertia).toBeCloseTo((1 / 12) * 1000 * (40 * 40 + 12 * 12), 1);
      expect(ship.thrusters.bowDorsal).toBeDefined();
      expect(ship.thrusters.bowVentral).toBeDefined();
      expect(ship.thrusters.sternDorsal).toBeDefined();
      expect(ship.thrusters.sternVentral).toBeDefined();
    });

    it('commandPilot({ pitch: 1.0 }) fires bowVentral and sternDorsal to produce positive pitch torque (nose up)', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      ship.commandPilot({ pitch: 1.0 });

      expect(ship.thrusters.bowVentral.throttle).toBe(1.0);
      expect(ship.thrusters.sternDorsal.throttle).toBe(1.0);
      expect(ship.thrusters.bowDorsal.throttle).toBe(0);
      expect(ship.thrusters.sternVentral.throttle).toBe(0);
      expect(ship.manualPitchCommanded).toBe(true);

      const dt = 1 / 60;
      ship.update(dt);

      expect(ship.thrusters.bowVentral.isFiring).toBe(true);
      expect(ship.thrusters.sternDorsal.isFiring).toBe(true);
      expect(ship.pitchOmega).toBeGreaterThan(0);
      // Balanced couple produces zero net linear z acceleration
      expect(ship.vel.z).toBeCloseTo(0, 6);
    });

    it('commandPilot({ pitch: -1.0 }) fires bowDorsal and sternVentral to produce negative pitch torque (nose down)', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      ship.commandPilot({ pitch: -1.0 });

      expect(ship.thrusters.bowDorsal.throttle).toBe(1.0);
      expect(ship.thrusters.sternVentral.throttle).toBe(1.0);
      expect(ship.thrusters.bowVentral.throttle).toBe(0);
      expect(ship.thrusters.sternDorsal.throttle).toBe(0);
      expect(ship.manualPitchCommanded).toBe(true);

      const dt = 1 / 60;
      ship.update(dt);

      expect(ship.thrusters.bowDorsal.isFiring).toBe(true);
      expect(ship.thrusters.sternVentral.isFiring).toBe(true);
      expect(ship.pitchOmega).toBeLessThan(0);
      expect(ship.vel.z).toBeCloseTo(0, 6);
    });

    it('accelerates in 3D along forward vector (cosA*cosP, sinA*cosP, sinP) under main drive', () => {
      const pitch = Math.PI / 6; // 30 degrees
      const angle = 0;           // East (+X)
      const ship = new RigidBody('corvette', { angle, pitch, sasActive: false });
      ship.setMainDriveThrottle(1.0);

      const dt = 1 / 60;
      ship.update(dt);

      // Linear acceleration a = F / m = 120,000 / 1000 = 120 m/s^2
      // ax = 120 * cos(0) * cos(30) = 120 * sqrt(3)/2 approx 103.923
      // az = 120 * sin(30) = 60
      // ay = 0
      const expectedAx = 120 * Math.cos(angle) * Math.cos(pitch);
      const expectedAz = 120 * Math.sin(pitch);
      expect(ship.vel.x).toBeCloseTo(expectedAx * dt, 4);
      expect(ship.vel.y).toBeCloseTo(0, 4);
      expect(ship.vel.z).toBeCloseTo(expectedAz * dt, 4);
    });

    it('clamps pitch strictly within [-MAX_PITCH_RAD, +MAX_PITCH_RAD] and zeroes pitchOmega upon hitting limit', () => {
      const ship = new RigidBody('corvette', { pitch: MAX_PITCH_RAD - 0.01, sasActive: false });
      ship.commandPilot({ pitch: 1.0 });
      const dt = 1 / 60;

      // Accelerate pitch upwards across the clamp threshold
      for (let i = 0; i < 20; i++) {
        ship.update(dt);
      }

      expect(ship.pitch).toBeCloseTo(MAX_PITCH_RAD, 6);
      expect(ship.pitchOmega).toBe(0);
      expect(ship.sasPitchPid.integralError).toBe(0);

      // Now pitch downwards across negative clamp threshold
      ship.pitch = -MAX_PITCH_RAD + 0.01;
      ship.commandPilot({ pitch: -1.0 });
      for (let i = 0; i < 20; i++) {
        ship.update(dt);
      }

      expect(ship.pitch).toBeCloseTo(-MAX_PITCH_RAD, 6);
      expect(ship.pitchOmega).toBe(0);
      expect(ship.sasPitchPid.integralError).toBe(0);
    });

    it('Pitch SAS damps pitchOmega to near zero within 2 seconds when powered', () => {
      const ship = new RigidBody('corvette', { pitchOmega: 1.5, sasActive: true });
      const dt = 1 / 60;

      for (let i = 0; i < 120; i++) {
        ship.update(dt, 1, 1, 1);
      }

      expect(Math.abs(ship.pitchOmega)).toBeLessThan(0.05);
    });

    it('maps 3D hit vectors correctly to effective quadrants and accounts for pitch/roll', () => {
      const ship = new RigidBody('corvette', { angle: 0, pitch: 0, rollAngle: 0 });

      // Fore / Aft / Starboard / Port in 3D direction vectors
      expect(ship.getEffectiveQuadrant({ x: 1, y: 0, z: 0 })).toBe('fore');
      expect(ship.getEffectiveQuadrant({ x: -1, y: 0, z: 0 })).toBe('aft');
      expect(ship.getEffectiveQuadrant({ x: 0, y: 1, z: 0 })).toBe('starboard');
      expect(ship.getEffectiveQuadrant({ x: 0, y: -1, z: 0 })).toBe('port');

      // Hits with vertical inclination (e.g. 20 degrees above horizontal forward)
      expect(ship.getEffectiveQuadrant({ x: Math.cos(0.3), y: 0, z: Math.sin(0.3) })).toBe('fore');

      // Swap port/starboard when rolled 180°
      ship.rollAngle = Math.PI;
      expect(ship.getEffectiveQuadrant({ x: 0, y: 1, z: 0 })).toBe('port');
      expect(ship.getEffectiveQuadrant({ x: 0, y: -1, z: 0 })).toBe('starboard');
    });

    it('resolves 3D target pitch angle for prograde, retrograde, and enemy target modes', () => {
      // Prograde pitch
      const ship = new RigidBody('corvette', { vx: 100, vy: 0, vz: 100 });
      ship.setAutoOrientMode('prograde');
      // Velocity vector at 45 degrees up in XZ plane
      expect(ship.resolveAutoOrientPitch()).toBeCloseTo(Math.PI / 4, 4);

      // Retrograde pitch
      ship.setAutoOrientMode('retrograde');
      expect(ship.resolveAutoOrientPitch()).toBeCloseTo(-Math.PI / 4, 4);

      // Target mode with 3D enemy coordinates
      ship.pos = { x: 0, y: 0, z: 0 };
      ship.setAutoOrientMode('target');
      const navContext = {
        enemyKnown: true,
        enemyPos: { x: 300, y: 0, z: 300 }, // dx = 300, dy = 0, dz = 300 -> 45 deg
      };
      expect(ship.resolveAutoOrientPitch(navContext)).toBeCloseTo(Math.PI / 4, 4);
    });
  });

  describe('Phase 12: Engine Gimbal Vectoring, Thermal Overheat & RCS Cooperation', () => {
    it('produces zero gimbal yaw, zero gimbal pitch, and zero gimbal torque when forward thrust is zero', () => {
      const ship = new RigidBody('frigate', { sasActive: false });
      ship.commandPilot({ forward: 0, turn: 1.0, pitch: 1.0 });
      ship.update(1 / 60, 1, 1, 1);

      expect(ship.mainDrive.isFiring).toBe(false);
      expect(ship.mainDrive.gimbalYaw).toBe(0);
      expect(ship.mainDrive.gimbalPitch).toBe(0);
    });

    it('deflects gimbal up to MAX_GIMBAL_RAD (20°) under thrust and scales torque proportionally with thrust', () => {
      const dt = 1 / 60;
      const shipFull = new RigidBody('frigate', { sasActive: false });
      const shipHalf = new RigidBody('frigate', { sasActive: false });

      shipFull.commandPilot({ forward: 1.0, turn: 1.0, pitch: 1.0 });
      shipHalf.commandPilot({ forward: 0.5, turn: 1.0, pitch: 1.0 });

      // Disable RCS so only engine gimbal torque acts on the hull
      shipFull.update(dt, 0, 1, 0);
      shipHalf.update(dt, 0, 1, 0);

      // Deflection clamped to MAX_GIMBAL_RAD (20°)
      expect(shipFull.mainDrive.gimbalYaw).toBeCloseTo(MAX_GIMBAL_RAD, 5);
      expect(shipFull.mainDrive.gimbalPitch).toBeCloseTo(MAX_GIMBAL_RAD, 5);
      expect(shipHalf.mainDrive.gimbalYaw).toBeCloseTo(MAX_GIMBAL_RAD, 5);
      expect(shipHalf.mainDrive.gimbalPitch).toBeCloseTo(MAX_GIMBAL_RAD, 5);

      // Gimbal torque and angular acceleration scale with main drive thrust (F_main ~ throttle)
      expect(shipHalf.omega / shipFull.omega).toBeCloseTo(0.5, 3);
      expect(shipHalf.pitchOmega / shipFull.pitchOmega).toBeCloseTo(0.5, 3);
      expect(shipHalf.vel.x / shipFull.vel.x).toBeCloseTo(0.5, 3);
    });

    it('enables gimbal-only yaw and pitch steering when rcs_thrusters is completely unpowered/offline', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      ship.commandPilot({ forward: 1.0, turn: -1.0, pitch: 1.0 });

      // RCS powered = 0, SAS powered = 0, Main Drive powered = 1
      ship.update(1 / 60, 0, 1, 0);

      // RCS thrusters do not fire
      for (const t of Object.values(ship.thrusters)) {
        expect(t.isFiring).toBe(false);
      }

      // Gimbal steers negative yaw (CCW/port) and positive pitch (nose up)
      expect(ship.mainDrive.gimbalYaw).toBeCloseTo(-MAX_GIMBAL_RAD, 5);
      expect(ship.mainDrive.gimbalPitch).toBeCloseTo(MAX_GIMBAL_RAD, 5);
      expect(ship.omega).toBeLessThan(0);
      expect(ship.pitchOmega).toBeGreaterThan(0);
      expect(ship.vel.x).toBeGreaterThan(0);
    });

    it('cooperates cleanly between RCS and Gimbal without duplicate fighting or excessive overshooting', () => {
      const dt = 1 / 60;
      // Under SAS stabilization with main drive active, gimbal torque is deducted from desired torque (tauRemaining = tauDesired - tauGimbalYaw)
      const shipSasWithMain = new RigidBody('corvette', { omega: 1.0, sasActive: true });
      const shipSasNoMain = new RigidBody('corvette', { omega: 1.0, sasActive: true });

      shipSasWithMain.commandPilot({ forward: 1.0 });
      shipSasNoMain.commandPilot({ forward: 0 });

      shipSasWithMain.update(dt, 1, 1, 1);
      shipSasNoMain.update(dt, 1, 1, 1);

      // Gimbal deflects to counter-rotate
      expect(shipSasWithMain.mainDrive.gimbalYaw).toBeLessThan(0);

      // Because gimbal produces counter-torque, RCS thrusters need less throttle to achieve stabilization
      expect(shipSasWithMain.thrusters.bowStarboard.throttle).toBeLessThan(shipSasNoMain.thrusters.bowStarboard.throttle);

      // Manual turn under thrust combines both RCS and gimbal torque cleanly
      const shipManual = new RigidBody('corvette', { sasActive: false });
      shipManual.commandPilot({ forward: 1.0, turn: 1.0 });
      shipManual.update(dt, 1, 1, 1);
      expect(shipManual.mainDrive.gimbalYaw).toBeCloseTo(MAX_GIMBAL_RAD, 5);
      expect(shipManual.thrusters.bowPort.isFiring).toBe(true);
      expect(shipManual.omega).toBeGreaterThan(0);
    });

    it('degrades subsystem performance to 0.30x on thermal overheat without coolant and recovers after cooling below 75 heat', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      const dt = 0.1;
      const zeroCoolantCtx = {
        coolantMap: {
          main_drive: 0,
          rcs_thrusters: 0,
          sas_computer: 0,
        },
      };

      // Baseline nominal thrust
      ship.commandPilot({ forward: 1.0 });
      ship.update(dt, 1, 1, 1);
      const nominalDv = ship.vel.x;

      // Reset velocity and run with zero coolant until overheated (heat >= 100)
      ship.vel.x = 0;
      for (let step = 0; step < 60; step++) {
        ship.commandPilot({ forward: 1.0 });
        ship.update(dt, 1, 1, 1, zeroCoolantCtx);
      }

      expect(ship.mainDrive.heat).toBe(100);
      expect(ship.mainDrive.overheated).toBe(true);

      // In overheated state, continues thrusting at reduced 0.30x output (not locked to 0)
      const prevVx = ship.vel.x;
      ship.update(dt, 1, 1, 1, zeroCoolantCtx);
      const overheatedDv = ship.vel.x - prevVx;
      expect(overheatedDv / nominalDv).toBeCloseTo(0.30, 2);

      // Restore full coolant flow with zero throttle to cool down
      ship.commandPilot({ forward: 0 });
      const fullCoolantCtx = {
        coolantMap: {
          main_drive: 1.0,
          rcs_thrusters: 1.0,
          sas_computer: 1.0,
        },
      };

      for (let step = 0; step < 25; step++) {
        ship.update(dt, 1, 1, 1, fullCoolantCtx);
      }

      expect(ship.mainDrive.heat).toBeLessThanOrEqual(75);
      expect(ship.mainDrive.overheated).toBe(false);
    });
  });

  describe('Phase 13 Slice 2 — 120% Power & Coolant Consumer Unclamping', () => {
    it('scales thrust and torque cleanly to 1.2x with 1.2 RCS and Main Drive power', () => {
      const baseShip = new RigidBody('corvette', { sasActive: false });
      const boostedShip = new RigidBody('corvette', { sasActive: false });
      const dt = 1 / 60;

      // Pure forward main drive acceleration at 1.0 vs 1.2
      baseShip.commandPilot({ forward: 1.0, turn: 0 });
      boostedShip.commandPilot({ forward: 1.0, turn: 0 });
      baseShip.update(dt, 1.0, 1.0, 1.0);
      boostedShip.update(dt, 1.0, 1.2, 1.0);
      expect(boostedShip.vel.x / baseShip.vel.x).toBeCloseTo(1.2, 3);

      // Pure RCS yaw torque at 1.0 vs 1.2
      const rcsBase = new RigidBody('corvette', { sasActive: false });
      const rcsBoosted = new RigidBody('corvette', { sasActive: false });
      rcsBase.commandPilot({ forward: 0, turn: 1.0 });
      rcsBoosted.commandPilot({ forward: 0, turn: 1.0 });
      rcsBase.update(dt, 1.0, 1.0, 1.0);
      rcsBoosted.update(dt, 1.2, 1.0, 1.0);
      expect(rcsBoosted.omega / rcsBase.omega).toBeCloseTo(1.2, 3);

      // Pure RCS pitch torque at 1.0 vs 1.2
      const pitchBase = new RigidBody('corvette', { sasActive: false });
      const pitchBoosted = new RigidBody('corvette', { sasActive: false });
      pitchBase.commandPilot({ forward: 0, pitch: 1.0 });
      pitchBoosted.commandPilot({ forward: 0, pitch: 1.0 });
      pitchBase.update(dt, 1.0, 1.0, 1.0);
      pitchBoosted.update(dt, 1.2, 1.0, 1.0);
      expect(pitchBoosted.pitchOmega / pitchBase.pitchOmega).toBeCloseTo(1.2, 3);
    });

    it('verifies sasPower = 1.2 produces stronger SAS PID damping and auto-orient torque than sasPower = 1.0', () => {
      const dt = 1 / 60;

      // 1. SAS yaw damping: initial omega = 0.05 (unsaturated throttle)
      const shipSas1 = new RigidBody('corvette', { omega: 0.05, sasActive: true });
      const shipSas12 = new RigidBody('corvette', { omega: 0.05, sasActive: true });
      shipSas1.update(dt, 1.2, 1.0, 1.0); // rcs=1.2, sas=1.0
      shipSas12.update(dt, 1.2, 1.0, 1.2); // rcs=1.2, sas=1.2

      const dOmega1 = 0.05 - shipSas1.omega;
      const dOmega12 = 0.05 - shipSas12.omega;
      expect(dOmega12 / dOmega1).toBeCloseTo(1.2, 3);
      expect(Math.abs(shipSas12.omega)).toBeLessThan(Math.abs(shipSas1.omega));

      // 2. SAS pitch damping: initial pitchOmega = 0.05
      const pitchSas1 = new RigidBody('corvette', { pitchOmega: 0.05, sasActive: true });
      const pitchSas12 = new RigidBody('corvette', { pitchOmega: 0.05, sasActive: true });
      pitchSas1.update(dt, 1.2, 1.0, 1.0);
      pitchSas12.update(dt, 1.2, 1.0, 1.2);

      const dPitchOmega1 = 0.05 - pitchSas1.pitchOmega;
      const dPitchOmega12 = 0.05 - pitchSas12.pitchOmega;
      expect(dPitchOmega12 / dPitchOmega1).toBeCloseTo(1.2, 3);

      // 3. Auto-orient mode: target mode toward enemy with small angle error (< 0.12)
      const navCtx = {
        enemyPos: { x: 500, y: 10, z: 0 },
        enemyKnown: true,
      };
      const autoOrient1 = new RigidBody('corvette', { angle: 0, sasActive: true, autoOrientMode: 'target' });
      const autoOrient12 = new RigidBody('corvette', { angle: 0, sasActive: true, autoOrientMode: 'target' });
      autoOrient1.update(dt, 1.2, 1.0, 1.0, navCtx);
      autoOrient12.update(dt, 1.2, 1.0, 1.2, navCtx);

      expect(autoOrient12.omega / autoOrient1.omega).toBeCloseTo(1.2, 3);
    });
  });
});


describe('Turn and Burn', () => {
  const dt = 1 / 60;

  it('flips retrograde, burns, and self-cancels once velocity is zero', () => {
    const ship = new RigidBody('frigate');
    ship.vel.x = 60;
    ship.angle = 0;
    expect(ship.startTurnAndBurn()).toBe(true);
    expect(ship.turnAndBurn).toBe(true);
    expect(ship.autoOrientMode).toBe('retrograde');

    let burned = false;
    for (let i = 0; i < 60 * 120 && ship.turnAndBurn; i++) {
      ship.commandPilot({ forward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0 });
      if (ship.mainDrive.throttle > 0) burned = true;
      ship.update(dt, 1, 1, 1, null);
    }
    expect(burned).toBe(true);
    expect(ship.turnAndBurn).toBe(false);
    expect(Math.hypot(ship.vel.x, ship.vel.y, ship.vel.z || 0)).toBeLessThan(5);
  });

  it('does not engage when already stationary', () => {
    const ship = new RigidBody('corvette');
    expect(ship.startTurnAndBurn()).toBe(false);
    expect(ship.turnAndBurn).toBe(false);
  });

  it('is cancelled by steering, thrust, strafe, roll, or rcsForward input', () => {
    for (const input of [{ turn: 1 }, { pitch: -1 }, { forward: 0.5 }, { strafe: 1 }, { roll: 1 }, { rcsForward: 1 }, { rcsForward: -1 }]) {
      const ship = new RigidBody('frigate');
      ship.vel.x = 60;
      ship.startTurnAndBurn();
      ship.commandPilot({ forward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0, ...input });
      expect(ship.turnAndBurn).toBe(false);
    }
  });

  it('is cancelled when another auto-orient mode is selected', () => {
    const ship = new RigidBody('frigate');
    ship.vel.x = 60;
    ship.startTurnAndBurn();
    ship.setAutoOrientMode('prograde');
    expect(ship.turnAndBurn).toBe(false);
  });
});

describe('RCS Longitudinal Translation (Decoupled KeyW / KeyS)', () => {
  const dt = 1 / 60;

  it('moves the ship forward (vel.x > 0) via RCS only when rcsForward = 1.0', () => {
    const ship = new RigidBody('corvette', { angle: 0 });
    ship.commandPilot({ rcsForward: 1.0 });

    expect(ship.rcsForward).toBe(1.0);
    expect(ship.manualRcsForwardCommanded).toBe(true);

    ship.update(dt, 1.0, 1.0, 1.0);

    expect(ship.vel.x).toBeGreaterThan(0);
    expect(ship.mainDrive.throttle).toBe(0);
    expect(ship.mainDrive.isFiring).toBe(false);
  });

  it('moves the ship backward (vel.x < 0) via RCS only when rcsForward = -1.0', () => {
    const ship = new RigidBody('corvette', { angle: 0 });
    ship.commandPilot({ rcsForward: -1.0 });

    expect(ship.rcsForward).toBe(-1.0);
    expect(ship.manualRcsForwardCommanded).toBe(true);

    ship.update(dt, 1.0, 1.0, 1.0);

    expect(ship.vel.x).toBeLessThan(0);
    expect(ship.mainDrive.throttle).toBe(0);
    expect(ship.mainDrive.isFiring).toBe(false);
  });

  it('works when mainDrivePowered = 0 and rcsPowered = 1', () => {
    const ship = new RigidBody('corvette', { angle: 0 });
    ship.commandPilot({ rcsForward: 1.0 });

    // mainDrivePowered = 0, rcsPowered = 1
    ship.update(dt, 1.0, 0.0, 1.0);

    expect(ship.vel.x).toBeGreaterThan(0);
    expect(ship.mainDrive.isFiring).toBe(false);
  });

  it('produces zero thrust when rcsPowered = 0', () => {
    const ship = new RigidBody('corvette', { angle: 0 });
    ship.commandPilot({ rcsForward: 1.0 });

    // rcsPowered = 0, mainDrivePowered = 1
    ship.update(dt, 0.0, 1.0, 1.0);

    expect(ship.vel.x).toBe(0);
    expect(ship.mainDrive.isFiring).toBe(false);
  });

  it('cancels active turnAndBurn when rcsForward is commanded', () => {
    const ship = new RigidBody('frigate');
    ship.vel.x = 50;
    expect(ship.startTurnAndBurn()).toBe(true);
    expect(ship.turnAndBurn).toBe(true);

    ship.commandPilot({ rcsForward: 1.0 });
    expect(ship.turnAndBurn).toBe(false);
  });

  describe('Slice 1: Body-Frame Angular Kinematics, Governors & SAS Windup Fix', () => {
    it('produces negative world omega when commanding turn: 1.0 while inverted (rollAngle = Math.PI)', () => {
      const ship = new RigidBody('corvette', { rollAngle: Math.PI, sasActive: false });
      ship.commandPilot({ turn: 1.0 });
      ship.update(1 / 60);

      // Inverted pilot: turn: 1.0 applies positive body torque, mapping to negative world omega
      expect(ship.omega).toBeLessThan(0);
    });

    it('produces negative world pitchOmega when commanding pitch: 1.0 while inverted (rollAngle = Math.PI)', () => {
      const ship = new RigidBody('corvette', { rollAngle: Math.PI, sasActive: false });
      ship.commandPilot({ pitch: 1.0 });
      ship.update(1 / 60);

      // Inverted pilot: pitch: 1.0 applies positive body pitch torque, mapping to negative world pitchOmega
      expect(ship.pitchOmega).toBeLessThan(0);
    });

    it('couples body pitch into world omega when banked 90° (rollAngle = Math.PI / 2)', () => {
      const ship = new RigidBody('corvette', { rollAngle: Math.PI / 2, sasActive: false });
      ship.commandPilot({ pitch: 1.0 });
      ship.update(1 / 60);

      // Banked 90°: body pitch produces world yaw (omega) in the dorsal direction
      expect(ship.omega).toBeGreaterThan(0);
      expect(Math.abs(ship.pitchOmega)).toBeLessThan(1e-4);
    });

    it('holding turn: 1.0 + forward: 1.0 converges smoothly to maxManualYawRate without runaway spin', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      const dt = 1 / 60;
      const maxYaw = ship.maxManualYawRate;
      expect(maxYaw).toBe(0.96);

      ship.commandPilot({ forward: 1.0, turn: 1.0 });

      // Run for 3 seconds (180 ticks)
      for (let i = 0; i < 180; i++) {
        ship.update(dt);
      }

      // Angular velocity must converge smoothly near maxManualYawRate without runaway spin
      expect(ship.omega).toBeGreaterThan(maxYaw * 0.90);
      expect(ship.omega).toBeLessThanOrEqual(maxYaw + 0.05);

      // Coast/hold for another second — remains stabilized at governor rate
      for (let i = 0; i < 60; i++) {
        ship.update(dt);
      }
      expect(ship.omega).toBeGreaterThan(maxYaw * 0.90);
      expect(ship.omega).toBeLessThanOrEqual(maxYaw + 0.05);
    });

    it('holding pitch: 1.0 + forward: 1.0 converges smoothly to maxManualPitchRate', () => {
      const ship = new RigidBody('frigate', { sasActive: false });
      const dt = 1 / 60;
      const maxPitch = ship.maxManualPitchRate;
      expect(maxPitch).toBe(0.60);

      ship.commandPilot({ forward: 1.0, pitch: 1.0 });

      // Simulate 40 ticks (~0.67s) to reach steady state before hitting MAX_PITCH_RAD (80°) stop
      for (let i = 0; i < 40; i++) {
        ship.update(dt);
      }

      expect(ship.pitchOmega).toBeGreaterThan(maxPitch * 0.85);
      expect(ship.pitchOmega).toBeLessThanOrEqual(maxPitch + 0.05);
    });

    it('maintains 100% full authority when braking opposite to current spin', () => {
      const ship = new RigidBody('corvette', { omega: 1.5, sasActive: false });
      const dt = 1 / 60;

      // Pilot commands reverse turn (-1.0) while spinning positive (+1.5)
      ship.commandPilot({ turn: -1.0 });
      ship.update(dt);

      // Deceleration should have full authority
      expect(ship.omega).toBeLessThan(1.5);
    });

    it('does not clamp or damp coasting velocity or external collision impulses when no manual input is commanded', () => {
      // Ship given external spin 2.5 rad/s (> maxManualYawRate of 0.96)
      const ship = new RigidBody('corvette', { omega: 2.5, sasActive: false });
      const dt = 1 / 60;

      for (let i = 0; i < 60; i++) {
        ship.update(dt);
      }

      // Without manual input and with SAS off, vacuum inertia must keep 2.5 rad/s indefinitely
      expect(ship.omega).toBe(2.5);
    });

    it('resets sasPid.integralError and sasPitchPid.integralError to 0 during manual commands and when rates <= 1e-4', () => {
      const ship = new RigidBody('corvette', { sasActive: true });
      const dt = 1 / 60;

      // Accumulate some integral error with small residual rates
      ship.omega = 0.05;
      ship.pitchOmega = 0.05;
      ship.update(dt);
      expect(ship.sasPid.integralError).not.toBe(0);
      expect(ship.sasPitchPid.integralError).not.toBe(0);

      // Commanding manual turn resets yaw integral error
      ship.commandPilot({ turn: 1.0 });
      ship.update(dt);
      expect(ship.sasPid.integralError).toBe(0);

      // Commanding manual pitch resets pitch integral error
      ship.commandPilot({ pitch: 1.0 });
      ship.update(dt);
      expect(ship.sasPitchPid.integralError).toBe(0);

      // When rates are negligible (<= 1e-4), integral errors remain 0
      ship.commandPilot({});
      ship.omega = 0;
      ship.pitchOmega = 0;
      ship.update(dt);
      expect(ship.sasPid.integralError).toBe(0);
      expect(ship.sasPitchPid.integralError).toBe(0);
    });

    it('SAS successfully damps spinning ship even when inverted (rollAngle = Math.PI)', () => {
      const ship = new RigidBody('corvette', { rollAngle: Math.PI, omega: 1.2, sasActive: true });
      const dt = 1 / 60;

      for (let i = 0; i < 180; i++) {
        ship.update(dt);
      }

      // SAS must damp world omega towards zero without positive feedback runaway
      expect(Math.abs(ship.omega)).toBeLessThan(0.05);
    });

    it('AIHelm steers towards target correctly when inverted (rollState = 1 / rollAngle = Math.PI)', () => {
      const ship = {
        body: new RigidBody('corvette', { angle: 0, rollAngle: Math.PI }),
        shields: {
          power: { fore: 1, aft: 1, port: 1, starboard: 1 },
          maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 },
          fore: 100, aft: 100, port: 100, starboard: 100,
        },
        hullHp: 600,
        helmInput: {},
      };
      const enemyShip = {
        id: 'omega',
        body: new RigidBody('corvette', { x: 0, y: 700 }),
        hullHp: 600,
      };

      AIHelm.update(ship, enemyShip, { sector: {} }, 1 / 60);

      // Desired angle to enemy at (0, 700) from (0, 0) is +PI/2 (North)
      // When inverted, body-frame turn should be negative to produce positive world angle turn
      expect(ship.helmInput.turn).toBeLessThan(0);

      // Updating the body with this input must rotate body.angle toward +PI/2
      ship.body.update(1 / 60);
      expect(ship.body.omega).toBeGreaterThan(0);
      expect(ship.body.angle).toBeGreaterThan(0);
    });
  });

  describe('Phase 19 Slice 1: Core Physics Pacing Scaling & Universal Spin/Roll Caps', () => {
    it('exports SHIP_PACING_SCALE (0.60), MAX_SPIN_RATE (PI), DAMPENING_FIELD_WIDTH (750), DAMPENING_FIELD_MAX_RATE (0.10)', () => {
      expect(SHIP_PACING_SCALE).toBe(0.60);
      expect(MAX_SPIN_RATE).toBeCloseTo(Math.PI, 6);
      expect(DAMPENING_FIELD_WIDTH).toBe(750);
      expect(DAMPENING_FIELD_MAX_RATE).toBe(0.10);
    });

    it('clampAngularVelocity clamps omega, pitchOmega, rollOmega to [-MAX_SPIN_RATE, MAX_SPIN_RATE]', () => {
      const obj = { omega: 10.0, pitchOmega: -5.0, rollOmega: 4.0 };
      clampAngularVelocity(obj);
      expect(obj.omega).toBe(Math.PI);
      expect(obj.pitchOmega).toBe(-Math.PI);
      expect(obj.rollOmega).toBe(Math.PI);

      const within = { omega: 1.0, pitchOmega: -2.0, rollOmega: 0.5 };
      clampAngularVelocity(within);
      expect(within.omega).toBe(1.0);
      expect(within.pitchOmega).toBe(-2.0);
      expect(within.rollOmega).toBe(0.5);

      // handles missing or non-object gracefully
      expect(() => clampAngularVelocity(null)).not.toThrow();
      expect(() => clampAngularVelocity({})).not.toThrow();
    });

    it('enforces invariant |omega|, |pitchOmega|, |rollOmega| <= Math.PI across extreme initial spin in constructor and update()', () => {
      const ship = new RigidBody('corvette', {
        omega: 12.0,
        pitchOmega: -8.0,
        rollOmega: 20.0,
        sasActive: false,
      });

      // Constructor clamps initial rates
      expect(ship.omega).toBe(Math.PI);
      expect(ship.pitchOmega).toBe(-Math.PI);
      expect(ship.rollOmega).toBe(Math.PI);

      ship.update(1 / 60);
      expect(Math.abs(ship.omega)).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(ship.pitchOmega)).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(ship.rollOmega)).toBeLessThanOrEqual(Math.PI);
    });

    it('caps omega even under 1/cos(pitch) amplification at extreme pitch (80°)', () => {
      // At pitch = 80 deg (MAX_PITCH_RAD), cosP is ~0.1736. 1/cosP is ~5.75x!
      const ship = new RigidBody('corvette', { pitch: MAX_PITCH_RAD, sasActive: false });
      ship.commandPilot({ turn: 1.0 });

      // Run multiple ticks to spin up
      for (let i = 0; i < 60; i++) {
        ship.update(1 / 60);
        expect(Math.abs(ship.omega)).toBeLessThanOrEqual(Math.PI);
      }
      expect(ship.omega).toBeLessThanOrEqual(Math.PI);
    });

    it('caps omega and rollOmega under asymmetric damaged strafing', () => {
      const ship = new RigidBody('corvette', { sasActive: false });
      // Break diagonal thrusters to maximize net torque during strafe
      ship.thrusters.bowPort.health = 0;
      ship.thrusters.sternStarboard.health = 0;
      ship.commandPilot({ strafe: 1.0 });

      for (let i = 0; i < 180; i++) {
        ship.update(1 / 60);
        expect(Math.abs(ship.omega)).toBeLessThanOrEqual(Math.PI);
        expect(Math.abs(ship.rollOmega)).toBeLessThanOrEqual(Math.PI);
      }
    });

    it('computeDampeningFieldStrength returns 0 inside <= 4500m, smoothstep in (4500, 5250), and 1 at >= 5250m', () => {
      // Inside arena inner boundary (<= 4500m)
      expect(computeDampeningFieldStrength({ x: 0, y: 0, z: 0 })).toBe(0);
      expect(computeDampeningFieldStrength({ x: 2000, y: 2000, z: 0 })).toBe(0); // dist ~2828m
      expect(computeDampeningFieldStrength({ x: 4500, y: 0, z: 0 })).toBe(0);

      // Between 4500m and 5250m: smoothstep Hermite curve
      const midPos = { x: 4875, y: 0, z: 0 }; // midpoint (t = 0.5)
      const midVal = computeDampeningFieldStrength(midPos);
      // smoothstep(0.5) = 0.5^2 * (3 - 2*0.5) = 0.25 * 2 = 0.5
      expect(midVal).toBeCloseTo(0.5, 5);

      const quarterPos = { x: 4500 + 750 * 0.25, y: 0, z: 0 }; // t = 0.25
      const qVal = computeDampeningFieldStrength(quarterPos);
      // smoothstep(0.25) = 0.25^2 * (3 - 2*0.25) = 0.0625 * 2.5 = 0.15625
      expect(qVal).toBeCloseTo(0.15625, 5);

      // At boundary or outside (>= 5250m)
      expect(computeDampeningFieldStrength({ x: 5250, y: 0, z: 0 })).toBe(1);
      expect(computeDampeningFieldStrength({ x: 6000, y: 0, z: 0 })).toBe(1);
      expect(computeDampeningFieldStrength({ x: 3500, y: 3500, z: 2000 })).toBe(1); // dist > 5250m

      // Edge cases: null or invalid parameters
      expect(computeDampeningFieldStrength(null)).toBe(0);
      expect(computeDampeningFieldStrength({ x: 5000, y: 0 }, 5250, 0)).toBe(0);
      expect(computeDampeningFieldStrength({ x: 5000, y: 0 }, 0, 750)).toBe(0);
    });
  });
});
