import { describe, it, expect, beforeEach } from 'vitest';
import {
  WeaponSystem,
  calculateLeadTarget,
  applyRailgunImpact,
  applyTorpedoImpact,
  damageAsteroid,
  RAILGUN_MAX_SLEW_RATE,
  RAILGUN_JAM_THRESHOLD,
  TORPEDO_MUZZLE_SPEED,
  RAILGUN_COOLDOWN_SEC,
  TORPEDO_COOLDOWN_SEC,
  TORPEDO_LIFETIME_SEC,
} from '../../src/combat/weapons.js';
import { ShieldSystem, MIN_SHIELD_POWER, SHIELD_RECHARGE_PERCENT_PER_SEC, DEFAULT_QUADRANT_SUBSYSTEMS } from '../../src/combat/shields.js';
import { ConduitGrid10x10 } from '../../src/systems/grid-10x10.js';
import { ARENA_RADIUS, SHIP_PACING_SCALE } from '../../src/physics/constants.js';

describe('Combat Systems: Weapons & Shields', () => {
  describe('calculateLeadTarget (Quadratic Intercept)', () => {
    it('calculates direct forward intercept when target is stationary', () => {
      const shooterPos = { x: 0, y: 0 };
      const shooterVel = { x: 0, y: 0 };
      const targetPos = { x: 600, y: 0 };
      const targetVel = { x: 0, y: 0 };
      const projSpeed = 600; // 600 m/s

      const res = calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projSpeed);
      expect(res.timeToIntercept).toBeCloseTo(1.0, 3);
      expect(res.x).toBeCloseTo(600, 2);
      expect(res.y).toBeCloseTo(0, 2);
      expect(res.aimAngle).toBeCloseTo(0, 3);
    });

    it('accounts for shooter velocity inheritance and target lateral velocity', () => {
      // Shooter moving East at 100 m/s
      const shooterPos = { x: 0, y: 0 };
      const shooterVel = { x: 100, y: 0 };
      // Target at (500, 0) moving North (+Y) at 200 m/s
      const targetPos = { x: 500, y: 0 };
      const targetVel = { x: 100, y: 200 };
      const projSpeed = 600;

      const res = calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projSpeed);
      expect(res.timeToIntercept).toBeGreaterThan(0);

      // Verify that at intercept time t, projectile pos matches target pos
      const t = res.timeToIntercept;
      const targetX = targetPos.x + targetVel.x * t;
      const targetY = targetPos.y + targetVel.y * t;

      expect(res.x).toBeCloseTo(targetX, 2);
      expect(res.y).toBeCloseTo(targetY, 2);

      // Projectile world vel = shooterVel + (cos(aimAngle), sin(aimAngle)) * projSpeed
      const projVelX = shooterVel.x + Math.cos(res.aimAngle) * projSpeed;
      const projVelY = shooterVel.y + Math.sin(res.aimAngle) * projSpeed;

      const projFinalX = shooterPos.x + projVelX * t;
      const projFinalY = shooterPos.y + projVelY * t;

      expect(projFinalX).toBeCloseTo(targetX, 2);
      expect(projFinalY).toBeCloseTo(targetY, 2);
    });
  });

  describe('Twin Pulse Lasers', () => {
    let weapons;
    const testShip = {
      id: 'ship_alpha',
      pos: { x: 100, y: 200, z: 15 },
      vel: { x: 50, y: -20, z: -10 },
    };

    beforeEach(() => {
      weapons = new WeaponSystem('frigate');
    });

    it('fires laser along 3D aim vector without velocity inheritance (v_proj = v_muzzle)', () => {
      const aimAngle = 0; // East
      const proj = weapons.fireLaser(testShip, aimAngle, 1.0);

      expect(proj).not.toBeNull();
      expect(proj.type).toBe('laser');
      // No velocity inheritance: muzzle speed (600) along aim angle, independent of ship vel
      expect(proj.vel.x).toBeCloseTo(600, 3);
      expect(proj.vel.y).toBeCloseTo(0, 3);
      expect(proj.vel.z).toBeCloseTo(0, 3);
      expect(proj.pos.x).toBe(100);
      expect(proj.pos.y).toBe(200);
      expect(proj.pos.z).toBe(15);
      expect(proj.shieldMultiplier).toBe(2.0);
    });

    it('accumulates heat and overheats after reaching 100 heat, continuing to fire at 0.5x damage and 0.65s fire rate', () => {
      // Fire 16 times: 16 * 6 = 96 heat
      for (let i = 0; i < 16; i++) {
        weapons.cooldown = 0; // Bypass rate limit
        weapons.fireLaser(testShip, 0, 1.0);
      }
      expect(weapons.heat).toBe(96);
      expect(weapons.overheated).toBe(false);

      // 17th shot pushes heat over 100
      weapons.cooldown = 0;
      weapons.fireLaser(testShip, 0, 1.0);
      expect(weapons.heat).toBe(100);
      expect(weapons.overheated).toBe(true);
      expect(weapons.overheatTimer).toBe(3.0);

      // Overheated laser continues firing at 0.5x damage and 0.65s reduced rate
      weapons.cooldown = 0;
      const overheatedShot = weapons.fireLaser(testShip, 0, 1.0);
      expect(overheatedShot).not.toBeNull();
      expect(overheatedShot.damage).toBe(weapons.laserBaseDamage * 1.0 * 0.5);
      expect(weapons.cooldown).toBe(0.65);

      // Cool down over 3.0 seconds
      weapons.update(3.1, {}, 1.0);
      expect(weapons.overheated).toBe(false);
      expect(weapons.heat).toBeLessThan(100);

      // Now can fire again at nominal rate and full damage
      weapons.cooldown = 0;
      const resumeShot = weapons.fireLaser(testShip, 0, 1.0);
      expect(resumeShot).not.toBeNull();
      expect(resumeShot.damage).toBe(weapons.laserBaseDamage * 1.0);
      expect(weapons.cooldown).toBe(0.25);
    });

    it('dissipates heat over time proportional to coolant flow', () => {
      weapons.heat = 60;
      // Normal coolant flow (1.0)
      weapons.update(1.0, {}, 1.0);
      expect(weapons.heat).toBe(60 - 12); // 12 heat/sec dissipated

      // Boosted coolant flow (2.0)
      weapons.update(1.0, {}, 2.0);
      expect(weapons.heat).toBe(48 - 24); // 24 heat/sec dissipated
    });
  });

  describe('Heavy Railgun', () => {
    let weapons;
    const testShip = {
      id: 'ship_alpha',
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
    };

    beforeEach(() => {
      weapons = new WeaponSystem('frigate');
    });

    it('requires 1.2s charge time before release', () => {
      weapons.startRailgunCharge();
      expect(weapons.charging).toBe(true);
      expect(weapons.chargeProgress).toBe(0);

      // Advance by 0.6s with railgun power
      weapons.update(0.6, { weapons_railgun: 2.0 });
      expect(weapons.chargeProgress).toBeCloseTo(0.5, 2);

      // Attempt to release early fails
      const earlySlug = weapons.releaseRailgun(testShip, 0);
      expect(earlySlug).toBeNull();

      // Complete 1.2s charge
      weapons.update(0.65, { weapons_railgun: 2.0 });
      expect(weapons.chargeProgress).toBe(1.0);

      // Successfully releases 900 m/s slug
      const slug = weapons.releaseRailgun(testShip, Math.PI / 2);
      expect(slug).not.toBeNull();
      expect(slug.type).toBe('railgun');
      expect(slug.vel.x).toBeCloseTo(0, 2);
      expect(slug.vel.y).toBeCloseTo(900, 2);
      expect(weapons.chargeProgress).toBe(0);
    });

    it('breaks 1-3 tiles on target 10x10 grid on unshielded penetration', () => {
      const targetGrid = new ConduitGrid10x10('frigate');
      const targetShip = {
        id: 'target',
        pos: { x: 100, y: 0 },
        vel: { x: 0, y: 0 },
        hullHp: 1000,
        thrusters: { bowPort: { health: 100 } },
      };

      const slug = {
        damage: 250,
        pos: { x: 100, y: 0 },
        targetedSubsystem: 'bowPort',
      };

      // Target with depleted shield
      const targetShields = new ShieldSystem(100);
      targetShields.hp.fore = 0;
      targetShields.hp.port = 0;
      targetShields.hp.starboard = 0;
      targetShields.hp.aft = 0;

      const res = applyRailgunImpact(slug, targetShip, targetShields, targetGrid);
      expect(res.penetrated).toBe(true);
      expect(targetShip.hullHp).toBeLessThan(1000);
      expect(targetShip.thrusters.bowPort.health).toBeLessThan(100);
      expect(res.brokenTiles.length).toBeGreaterThanOrEqual(1);
      expect(res.brokenTiles.length).toBeLessThanOrEqual(3);

      // Verify that damaged tiles in grid have status === 'broken'
      for (const t of res.brokenTiles) {
        expect(targetGrid.getTile(t.row, t.col).status).toBe('broken');
      }
    });

    it('caps railgun slew rate at <= 20 deg/s (~0.349 rad/s) when fully healthy and powered', () => {
      const shipAngle = 0;
      const desiredAngle = Math.PI / 2; // 90 deg away

      // 1 second update with full power
      const state = weapons.updateRailgunTraverse(1.0, shipAngle, desiredAngle, { weapons_railgun: 2.0 });

      expect(state.railgunSlewRate).toBeCloseTo(RAILGUN_MAX_SLEW_RATE, 4);
      expect(state.railgunLocalAngle).toBeCloseTo(RAILGUN_MAX_SLEW_RATE, 4);
      expect(state.railgunAngle).toBeCloseTo(RAILGUN_MAX_SLEW_RATE, 4);
      expect(state.railgunJammed).toBe(false);
    });

    it('slows railgun traverse when damaged and jams completely at health <= 15', () => {
      // 50% health reduces slew rate
      weapons.railgunHardware.health = 50;
      weapons.updateRailgunTraverse(1.0, 0, Math.PI / 2, { weapons_railgun: 2.0 });
      expect(weapons.railgunSlewRate).toBeCloseTo(RAILGUN_MAX_SLEW_RATE * 0.5, 4);
      expect(weapons.railgunJammed).toBe(false);

      // Lock current local angle
      const lockedLocalAngle = weapons.railgunLocalAngle;

      // Damage below threshold <= 15
      weapons.railgunHardware.health = 10;
      const jammedState = weapons.updateRailgunTraverse(1.0, 0, Math.PI / 2, { weapons_railgun: 2.0 });

      expect(jammedState.railgunJammed).toBe(true);
      expect(jammedState.railgunSlewRate).toBe(0);
      expect(jammedState.railgunLocalAngle).toBeCloseTo(lockedLocalAngle, 4);

      // When jammed, firing releases along the stuck railgunAngle
      weapons.chargeProgress = 1.0;
      weapons.railgunCooldown = 0;
      const slug = weapons.releaseRailgun(testShip, jammedState.railgunAngle, 1.0);
      expect(slug).not.toBeNull();
      const fireAngle = Math.atan2(slug.vel.y, slug.vel.x);
      expect(fireAngle).toBeCloseTo(jammedState.railgunAngle, 3);
    });

    it('damages railgunHardware, stabilizerHardware, and laserHardware when targeted in applyRailgunImpact', () => {
      const targetGrid = new ConduitGrid10x10('frigate');
      const targetShip = {
        id: 'target',
        pos: { x: 100, y: 0 },
        vel: { x: 0, y: 0 },
        hullHp: 1000,
        thrusters: {},
      };
      const targetShields = new ShieldSystem(100);
      targetShields.hp.fore = 0;
      targetShields.hp.port = 0;
      targetShields.hp.starboard = 0;
      targetShields.hp.aft = 0;

      const targetWeapons = new WeaponSystem('frigate');
      expect(targetWeapons.railgunHardware.health).toBe(100);
      expect(targetWeapons.stabilizerHardware.health).toBe(100);
      expect(targetWeapons.laserHardware.health).toBe(100);

      // 1. Damage railgunHardware
      const slugRailgun = { damage: 250, pos: { x: 100, y: 0 }, targetedSubsystem: 'weapons_railgun' };
      applyRailgunImpact(slugRailgun, targetShip, targetShields, targetGrid, Math.random, targetWeapons);
      expect(targetWeapons.railgunHardware.health).toBe(45); // 100 - 55 = 45

      // 2. Damage stabilizerHardware
      const slugSAS = { damage: 250, pos: { x: 100, y: 0 }, targetedSubsystem: 'sas_computer' };
      applyRailgunImpact(slugSAS, targetShip, targetShields, targetGrid, Math.random, targetWeapons);
      expect(targetWeapons.stabilizerHardware.health).toBe(45);

      // 3. Damage laserHardware
      const slugLaser = { damage: 250, pos: { x: 100, y: 0 }, targetedSubsystem: 'weapons_laser' };
      applyRailgunImpact(slugLaser, targetShip, targetShields, targetGrid, Math.random, targetWeapons);
      expect(targetWeapons.laserHardware.health).toBe(45);
    });

    it('damages hyperspace hardware (25..40 damage clamped to >= 0) when targeted in applyRailgunImpact', () => {
      const targetGrid = new ConduitGrid10x10('frigate');
      const targetShip = {
        id: 'target',
        pos: { x: 100, y: 0 },
        vel: { x: 0, y: 0 },
        hullHp: 1000,
        thrusters: {},
        hyperspace: { health: 100 },
      };
      const targetShields = new ShieldSystem(100);
      targetShields.hp.fore = 0;
      targetShields.hp.port = 0;
      targetShields.hp.starboard = 0;
      targetShields.hp.aft = 0;

      // Deterministic rng = 0.5 -> roll = 0.5 -> 25 + Math.floor(0.5 * 16) = 25 + 8 = 33
      const slug = { damage: 250, pos: { x: 100, y: 0 }, targetedSubsystem: 'hyperspace' };
      applyRailgunImpact(slug, targetShip, targetShields, targetGrid, () => 0.5, null);
      expect(targetShip.hyperspace.health).toBe(67); // 100 - 33 = 67

      // Clamped to 0
      targetShip.hyperspace.health = 10;
      applyRailgunImpact(slug, targetShip, targetShields, targetGrid, () => 1.0, null);
      expect(targetShip.hyperspace.health).toBe(0);
    });
  });

  describe('Destructible Asteroids & damageAsteroid', () => {
    it('applies non-fatal kinetic damage and chips off debris chunks', () => {
      const asteroid = {
        id: 'ast_combat_1',
        radius: 100,
        pos: { x: 0, y: 0 },
        maxHp: 250,
        hp: 250,
        destroyed: false,
      };

      const res = damageAsteroid(asteroid, 100, { x: 100, y: 0 }, { chipDebris: true });
      expect(res.hit).toBe(true);
      expect(res.hp).toBe(150);
      expect(res.destroyed).toBe(false);
      expect(res.spawnedChunks.length).toBeGreaterThanOrEqual(1);
      expect(res.spawnedChunks.length).toBeLessThanOrEqual(2);
    });

    it('destroys asteroid when hp drops to 0 and spawns 4 to 8 debris chunks', () => {
      const asteroid = {
        id: 'ast_combat_lethal',
        radius: 80,
        pos: { x: 200, y: 300 },
        maxHp: 200,
        hp: 150,
        destroyed: false,
      };

      const res = damageAsteroid(asteroid, 250, { x: 200, y: 380 });
      expect(res.hit).toBe(true);
      expect(res.hp).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(asteroid.destroyed).toBe(true);
      expect(res.spawnedChunks.length).toBeGreaterThanOrEqual(4);
      expect(res.spawnedChunks.length).toBeLessThanOrEqual(8);

      // Subsequent hits on destroyed asteroid return hit: false
      const ghostHit = damageAsteroid(asteroid, 50, { x: 200, y: 380 });
      expect(ghostHit.hit).toBe(false);
      expect(ghostHit.spawnedChunks.length).toBe(0);
    });

    it('shatters full-HP large asteroid into 4-8 debris chunks in 1 hit when shatter option is true', () => {
      const asteroid = {
        id: 'ast_combat_large',
        radius: 180,
        pos: { x: 500, y: 500 },
        maxHp: 450,
        hp: 450,
        destroyed: false,
      };

      const res = damageAsteroid(asteroid, 600, { x: 500, y: 680 }, { shatter: true });
      expect(res.hit).toBe(true);
      expect(res.hp).toBe(0);
      expect(res.destroyed).toBe(true);
      expect(asteroid.destroyed).toBe(true);
      expect(res.spawnedChunks.length).toBeGreaterThanOrEqual(4);
      expect(res.spawnedChunks.length).toBeLessThanOrEqual(8);
    });
  });

  describe('Homing Torpedoes & Finite Magazine', () => {
    it('decrements magazine and refuses to fire when empty', () => {
      const weapons = new WeaponSystem('corvette', 'heavy_torpedoes');
      expect(weapons.magazine).toBe(6);

      const ship = { id: 's1', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };

      for (let i = 0; i < 6; i++) {
        weapons.torpedoCooldown = 0;
        const torp = weapons.launchTorpedo(ship, 0, 'target1');
        expect(torp).not.toBeNull();
      }

      expect(weapons.magazine).toBe(0);
      weapons.torpedoCooldown = 0;
      const failTorp = weapons.launchTorpedo(ship, 0, 'target1');
      expect(failTorp).toBeNull();

      // Resupply
      weapons.resupplyTorpedoes(3);
      expect(weapons.magazine).toBe(3);
    });

    it('scales magazine to 16 for swarm_missiles module', () => {
      const weapons = new WeaponSystem('frigate', 'swarm_missiles');
      expect(weapons.magazine).toBe(16);
      expect(weapons.maxMagazine).toBe(16);
    });

    it('steers toward target, but breaks lock when entering Ion Nebula', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'shooter', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };
      const target = { id: 'target_omega', pos: { x: 500, y: 300 }, vel: { x: 0, y: 0 }, hullHp: 1000 };

      const torp = weapons.launchTorpedo(ship, 0, 'target_omega');
      expect(torp.lockBroken).toBe(false);

      // Step outside nebula: torpedo turns towards target (positive Y)
      weapons.updateProjectiles([torp], 0.1, [target], [], [], []);
      expect(torp.vel.y).toBeGreaterThan(0);

      // Place torpedo inside an Ion Nebula
      const nebulae = [{ id: 'neb1', pos: { x: torp.pos.x, y: torp.pos.y }, radius: 300 }];
      weapons.updateProjectiles([torp], 0.1, [target], [], nebulae, []);

      expect(torp.lockBroken).toBe(true);

      // Now torpedo maintains straight ballistic flight
      const vyBefore = torp.vel.y;
      weapons.updateProjectiles([torp], 0.1, [target], [], nebulae, []);
      expect(torp.vel.y).toBeCloseTo(vyBefore, 3);
    });

    it('applies EMP blast to grid on EMP torpedo impact', () => {
      const grid = new ConduitGrid10x10('frigate');
      const target = { id: 't1', pos: { x: 0, y: 0 }, hullHp: 500 };
      const shields = new ShieldSystem(0);

      const empTorp = {
        damage: 150,
        torpedoType: 'emp_torpedoes',
        empDuration: 8.0,
        pos: { x: 0, y: 0 },
      };

      const res = applyTorpedoImpact(empTorp, target, shields, grid);
      expect(res.empApplied).toBe(true);
      expect(target.hullHp).toBe(350);

      // Tiles in 3x3 center around [4, 5] should have empTimer = 8.0
      expect(grid.getTile(4, 5).empTimer).toBe(8.0);
    });

    it('scales conduit damage on target grid with torpedo overflow (Math.floor(overflow / 90))', () => {
      const grid = new ConduitGrid10x10('frigate');
      const target = { id: 't1', pos: { x: 0, y: 0 }, hullHp: 1000 };
      const shields = new ShieldSystem(0);

      const heavyTorp = {
        damage: 400,
        torpedoType: 'heavy_torpedoes',
        pos: { x: 0, y: 0 },
      };

      const res = applyTorpedoImpact(heavyTorp, target, shields, grid);
      expect(res.overflow).toBe(400);
      // Math.min(3, Math.floor(400 / 90)) = 3 tiles broken
      expect(res.brokenTiles.length).toBe(3);
    });
  });

  describe('Point-Defense Flak Cannon', () => {
    it('destroys enemy torpedoes and active tether mines within 200m radius', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'my_ship', pos: { x: 0, y: 0 } };

      const projectiles = [
        // Friendly torpedo (should NOT be destroyed)
        { id: 'p1', shooterId: 'my_ship', type: 'torpedo', pos: { x: 50, y: 0 }, destroyed: false },
        // Enemy torpedo within 200m (SHOULD be destroyed)
        { id: 'p2', shooterId: 'enemy', type: 'torpedo', pos: { x: 120, y: 50 }, destroyed: false },
        // Enemy torpedo far away (should NOT be destroyed)
        { id: 'p3', shooterId: 'enemy', type: 'torpedo', pos: { x: 350, y: 0 }, destroyed: false },
      ];

      const tetherMines = [
        // Armed mine in range (SHOULD be destroyed)
        { id: 'm1', armed: true, destroyed: false, pos: { x: -80, y: 70 } },
        // Armed mine far away (should NOT be destroyed)
        { id: 'm2', armed: true, destroyed: false, pos: { x: -300, y: 0 } },
      ];

      const res = weapons.fireFlak(ship, projectiles, tetherMines);

      expect(res.destroyedProjectiles.length).toBe(1);
      expect(res.destroyedProjectiles[0].id).toBe('p2');
      expect(projectiles[1].destroyed).toBe(true);
      expect(projectiles[0].destroyed).toBe(false);
      expect(projectiles[2].destroyed).toBe(false);

      expect(res.destroyedMines.length).toBe(1);
      expect(res.destroyedMines[0].id).toBe('m1');
      expect(tetherMines[0].destroyed).toBe(true);
      expect(tetherMines[1].destroyed).toBe(false);
    });
  });

  describe('ShieldSystem & 180° Roll Port/Starboard Inversion', () => {
    let shields;

    beforeEach(() => {
      shields = new ShieldSystem(100);
    });

    it('absorbs fore and aft hits correctly', () => {
      // Hit directly from front (angle 0)
      const foreRes = shields.absorbDamage(40, 0, 0, 0);
      expect(foreRes.quadrant).toBe('fore');
      expect(foreRes.absorbed).toBe(40);
      expect(foreRes.overflow).toBe(0);
      expect(shields.hp.fore).toBe(60);

      // Hit directly from rear (angle Math.PI)
      const aftRes = shields.absorbDamage(50, Math.PI, 0, 0);
      expect(aftRes.quadrant).toBe('aft');
      expect(aftRes.absorbed).toBe(50);
      expect(aftRes.overflow).toBe(0);
      expect(shields.hp.aft).toBe(50);
    });

    it('swaps Port and Starboard quadrants in world space when rollState === 1', () => {
      // Angle +PI/2 (+90 degrees): Right side of ship in world space
      // Normal roll (0): Right side is Starboard
      const normalRes = shields.absorbDamage(30, Math.PI / 2, 0, 0);
      expect(normalRes.quadrant).toBe('starboard');
      expect(shields.hp.starboard).toBe(70);

      // Inverted roll (1): 180° inverted vessel inverts its lateral sides in world space!
      // Hit coming from world +PI/2 now impacts Port side!
      const rolledRes = shields.absorbDamage(30, Math.PI / 2, 0, 1);
      expect(rolledRes.quadrant).toBe('port');
      expect(shields.hp.port).toBe(70);

      // Hit coming from world -PI/2 now impacts Starboard side!
      const rolledRes2 = shields.absorbDamage(20, -Math.PI / 2, 0, 1);
      expect(rolledRes2.quadrant).toBe('starboard');
      expect(shields.hp.starboard).toBe(50);
    });

    it('ShieldSystem setSystemOnline gates power, effective HP, recharge, and damage absorption', () => {
      const s = new ShieldSystem('frigate');
      expect(s.systemOnline).toBe(true);
      expect(DEFAULT_QUADRANT_SUBSYSTEMS.starboard).toContain('hyperspace');

      s.setSystemOnline(false);
      expect(s.systemOnline).toBe(false);
      expect(s.isQuadrantPowered('fore')).toBe(false);
      expect(s.getEffectiveHp('fore')).toBe(0);

      s.hp.fore = 50;
      const snap = s.recharge(1.0, { shields_fore: 2.0 });
      expect(snap.systemOnline).toBe(false);
      expect(s.hp.fore).toBe(50); // Unchanged because system is offline!

      // Absorb damage when offline deals 0 absorption and 100% overflow
      const res = s.absorbDamage(50, 0, 0, 0);
      expect(res.powered).toBe(false);
      expect(res.absorbed).toBe(0);
      expect(res.overflow).toBe(50);

      // Re-enabling system restores powered state
      s.setSystemOnline(true);
      expect(s.isQuadrantPowered('fore')).toBe(true);
      expect(s.getEffectiveHp('fore')).toBe(50);
    });

    it('recharges quadrants proportional to allocated power (1% per second base rate)', () => {
      shields.hp.fore = 20;
      shields.hp.aft = 40;

      // Fore power: 2.0, Aft power: 1.0 (recharge rate = 1% maxHp/s = 1.0 HP/s per unit power)
      shields.recharge(1.0, { shields_fore: 2.0, shields_aft: 1.0 });

      expect(shields.hp.fore).toBe(20 + 100 * SHIELD_RECHARGE_PERCENT_PER_SEC * 2.0 * 1.0); // 22
      expect(shields.hp.aft).toBe(40 + 100 * SHIELD_RECHARGE_PERCENT_PER_SEC * 1.0 * 1.0);  // 41
    });

    it('scales shield recharge with thermal coolant efficiency when coolantMap is provided', () => {
      shields.hp.fore = 20;
      // Fore power: 2.0, Fore coolant: 0.8 -> eff = 0.4 + 0.6 * 0.8 = 0.88
      shields.recharge(1.0, {
        shields_fore: 2.0,
        coolantMap: { shields_fore: 0.8 },
      });

      const expectedRecharge = 100 * SHIELD_RECHARGE_PERCENT_PER_SEC * 2.0 * (0.4 + 0.6 * 0.8) * 1.0; // 1.76
      expect(shields.hp.fore).toBeCloseTo(20 + expectedRecharge, 4);
    });

    it('safely handles NaN or non-finite values in coolantMap without corrupting shield HP', () => {
      shields.hp.fore = 20;
      shields.recharge(1.0, {
        shields_fore: 1.0,
        coolantMap: { shields_fore: NaN, shields_aft: undefined },
      });

      expect(Number.isFinite(shields.hp.fore)).toBe(true);
      expect(shields.hp.fore).toBeGreaterThan(20);
    });

    it('WeaponSystem.update(dt, powerMap) uses powerMap.coolantMap instead of hardcoded 1.0 default', () => {
      const wLowCool = new WeaponSystem('frigate');
      const wHighCool = new WeaponSystem('frigate');
      wLowCool.heat = 50;
      wHighCool.heat = 50;

      wLowCool.update(1.0, { weapons_laser: 0.8, coolantMap: { weapons_laser: 0.25 } });
      wHighCool.update(1.0, { weapons_laser: 0.8, coolantMap: { weapons_laser: 1.0 } });

      // Low coolant (0.25 -> 3.0/s cooling -> 47) retains more heat than high coolant (1.0 -> 12.0/s -> 38)
      expect(wLowCool.heat).toBeCloseTo(47, 5);
      expect(wHighCool.heat).toBeCloseTo(38, 5);
    });

    it('ShieldSystem("frigate") starts with 200 HP per quadrant and takes >= 5 laser hits to collapse', () => {
      const frigateShields = new ShieldSystem('frigate');
      expect(frigateShields.maxHp.fore).toBe(200);
      expect(frigateShields.maxHp.aft).toBe(200);
      expect(frigateShields.maxHp.port).toBe(200);
      expect(frigateShields.maxHp.starboard).toBe(200);
      expect(frigateShields.hp.fore).toBe(200);

      // Pulse Laser hit: 18 base * 0.8 power * 2.0 shield multiplier = 28.8 damage
      const laserDmg = 18 * 0.8 * 2.0;
      let hits = 0;
      while (frigateShields.hp.fore > 0) {
        hits++;
        frigateShields.absorbDamage(laserDmg, 0, 0, 0);
      }
      expect(hits).toBeGreaterThanOrEqual(5);
      expect(hits).toBe(7); // 200 / 28.8 = 6.94 -> 7 hits

      // Also check unpowered 36 dmg/shot takes >= 5 hits
      const frigateShieldsUnpowered = new ShieldSystem('frigate');
      let hitsUnpowered = 0;
      while (frigateShieldsUnpowered.hp.fore > 0) {
        hitsUnpowered++;
        frigateShieldsUnpowered.absorbDamage(36, 0, 0, 0);
      }
      expect(hitsUnpowered).toBeGreaterThanOrEqual(5);
      expect(hitsUnpowered).toBe(6); // 200 / 36 = 5.55 -> 6 hits

      // Helper getQuadrantForAngle works cleanly
      expect(frigateShields.getQuadrantForAngle(0, 0, 0)).toBe('fore');
      expect(frigateShields.getQuadrantForAngle(Math.PI, 0, 0)).toBe('aft');
      expect(frigateShields.getQuadrantForAngle(Math.PI / 2, 0, 0)).toBe('starboard');
      expect(frigateShields.getQuadrantForAngle(Math.PI / 2, 0, 1)).toBe('port');
    });

    it('collapses struck quadrant shield to 0 on 1 Railgun hit and 1 Torpedo hit with accurate overflow', () => {
      // 1. Railgun (250 damage) vs Frigate (200 HP shield)
      const frigateShields = new ShieldSystem('frigate');
      const targetFrigate = { pos: { x: 0, y: 0 }, angle: 0, hullHp: 1000 };
      const slug = { damage: 250, pos: { x: 50, y: 0 } }; // hits fore
      const preForeHp = frigateShields.hp.fore; // 200

      const railRes = applyRailgunImpact(slug, targetFrigate, frigateShields, null);
      expect(frigateShields.hp.fore).toBe(0);
      expect(railRes.overflow).toBe(Math.max(0, slug.damage - preForeHp)); // 50
      expect(railRes.absorbed).toBe(200);
      expect(targetFrigate.hullHp).toBe(950);

      // 2. EMP Torpedo (150 damage) vs Dreadnought (260 HP shield)
      const dreadShields = new ShieldSystem('dreadnought');
      expect(dreadShields.maxHp.fore).toBe(260);
      expect(dreadShields.hp.fore).toBe(260);

      const targetDread = { pos: { x: 0, y: 0 }, angle: 0, hullHp: 2000 };
      const empTorp = { damage: 150, torpedoType: 'emp_torpedoes', pos: { x: 80, y: 0 } }; // hits fore
      const preDreadForeHp = dreadShields.hp.fore; // 260

      const torpRes = applyTorpedoImpact(empTorp, targetDread, dreadShields, null);
      // 1 hit collapses the struck shield quadrant to 0 HP
      expect(dreadShields.hp.fore).toBe(0);
      // While hull overflow is 0 (shield absorbed all weapon damage before collapsing)
      expect(torpRes.overflow).toBe(Math.max(0, empTorp.damage - preDreadForeHp)); // 0
      expect(torpRes.absorbed).toBe(150);
      expect(targetDread.hullHp).toBe(2000); // zero hull damage!

      // 3. Heavy Torpedo (400 damage) vs Corvette (160 HP shield)
      const corvetteShields = new ShieldSystem('corvette');
      expect(corvetteShields.maxHp.aft).toBe(160);
      const targetCorvette = { pos: { x: 0, y: 0 }, angle: 0, hullHp: 600 };
      const heavyTorp = { damage: 400, torpedoType: 'heavy_torpedoes', pos: { x: -80, y: 0 } }; // hits aft
      const preCorvetteAftHp = corvetteShields.hp.aft; // 160

      const heavyRes = applyTorpedoImpact(heavyTorp, targetCorvette, corvetteShields, null);
      expect(corvetteShields.hp.aft).toBe(0);
      expect(heavyRes.overflow).toBe(Math.max(0, heavyTorp.damage - preCorvetteAftHp)); // 240
      expect(heavyRes.absorbed).toBe(160);
      expect(targetCorvette.hullHp).toBe(600 - 240); // 360
    });

    it('does not regenerate and has no effect when shield power is below 10% (< MIN_SHIELD_POWER)', () => {
      const s = new ShieldSystem(100);
      s.hp.fore = 50;

      // Update power to 0.09 (< 0.10)
      s.updatePower({ shields_fore: 0.09 });
      expect(s.isQuadrantPowered('fore')).toBe(false);
      expect(s.getEffectiveHp('fore')).toBe(0);

      // recharge with power < 0.1 does not increase HP
      s.recharge(1.0, { shields_fore: 0.09 });
      expect(s.hp.fore).toBe(50);

      // absorbDamage with unpowered shield absorbs 0, 100% overflows, and leaves stored HP intact
      const res = s.absorbDamage(30, 0, 0, 0);
      expect(res.powered).toBe(false);
      expect(res.absorbed).toBe(0);
      expect(res.overflow).toBe(30);
      expect(res.shieldDepleted).toBe(true);
      expect(s.hp.fore).toBe(50); // Stored HP untouched

      // When power is restored to >= 10% (0.8), shield becomes active with preserved HP
      s.updatePower({ shields_fore: 0.8 });
      expect(s.isQuadrantPowered('fore')).toBe(true);
      expect(s.getEffectiveHp('fore')).toBe(50);

      const activeRes = s.absorbDamage(20, 0, 0, 0);
      expect(activeRes.powered).toBe(true);
      expect(activeRes.absorbed).toBe(20);
      expect(activeRes.overflow).toBe(0);
      expect(s.hp.fore).toBe(30);
    });

    it('bypasses unpowered shields (< 10% power) for Railgun and Torpedo impacts dealing 100% hull overflow', () => {
      // 1. Railgun vs unpowered Frigate shield
      const frigateShields = new ShieldSystem('frigate');
      frigateShields.updatePower({ shields_fore: 0.05 }); // 5% power < 10% cutoff
      expect(frigateShields.isQuadrantPowered('fore')).toBe(false);
      expect(frigateShields.hp.fore).toBe(200);

      const targetFrigate = { pos: { x: 0, y: 0 }, angle: 0, hullHp: 1000 };
      const slug = { damage: 250, pos: { x: 50, y: 0 } };

      const railRes = applyRailgunImpact(slug, targetFrigate, frigateShields, null);
      expect(railRes.powered).toBe(false);
      expect(railRes.absorbed).toBe(0);
      expect(railRes.overflow).toBe(250);
      expect(targetFrigate.hullHp).toBe(750); // Full 250 damage to hull!
      expect(frigateShields.hp.fore).toBe(200); // Shield HP preserved, not drained by unpowered hit

      // 2. Torpedo vs unpowered Dreadnought shield
      const dreadShields = new ShieldSystem('dreadnought');
      dreadShields.updatePower({ shields_fore: 0.0 }); // 0% power
      expect(dreadShields.isQuadrantPowered('fore')).toBe(false);
      expect(dreadShields.hp.fore).toBe(260);

      const targetDread = { pos: { x: 0, y: 0 }, angle: 0, hullHp: 2000 };
      const torp = { damage: 150, torpedoType: 'emp_torpedoes', pos: { x: 80, y: 0 } };

      const torpRes = applyTorpedoImpact(torp, targetDread, dreadShields, null);
      expect(torpRes.powered).toBe(false);
      expect(torpRes.absorbed).toBe(0);
      expect(torpRes.overflow).toBe(150);
      expect(targetDread.hullHp).toBe(1850); // Full 150 damage directly to hull!
      expect(dreadShields.hp.fore).toBe(260); // Shield HP preserved
    });

    it('treats shields at exactly 10% power (MIN_SHIELD_POWER = 0.1) as powered and active', () => {
      const s = new ShieldSystem(100);
      s.hp.fore = 50;
      s.updatePower({ shields_fore: 0.1 });

      expect(s.isQuadrantPowered('fore')).toBe(true);
      expect(s.getEffectiveHp('fore')).toBe(50);

      // Regenerates at 1% of maxHp scaled by 0.1 power
      s.recharge(1.0, { shields_fore: 0.1 });
      // 50 + 100 * 0.01 * 0.1 * 1.0 = 50.1
      expect(s.hp.fore).toBeCloseTo(50.1, 5);

      // Absorbs damage normally
      const res = s.absorbDamage(20, 0, 0, 0);
      expect(res.powered).toBe(true);
      expect(res.absorbed).toBe(20);
      expect(res.overflow).toBe(0);
      expect(s.hp.fore).toBeCloseTo(30.1, 5);
    });
  });

  describe('Phase 10 Slice 2: 3D Combat Ballistics & Turret Articulation', () => {
    it('calculates 3D lead targeting intercept returning non-zero z, aimPitch, and t', () => {
      // Shooter at (0, 0, 0) moving with vz = 20 m/s
      const shooterPos = { x: 0, y: 0, z: 0 };
      const shooterVel = { x: 50, y: 0, z: 20 };
      // Target at (600, 0, 300) moving with vz = 50 m/s, vy = 100 m/s
      const targetPos = { x: 600, y: 0, z: 300 };
      const targetVel = { x: 50, y: 100, z: 50 };
      const projSpeed = 600;

      const res = calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projSpeed);
      expect(res.t).toBeGreaterThan(0);
      expect(res.timeToIntercept).toBe(res.t);
      expect(res.z).toBeGreaterThan(300);
      expect(res.aimPitch).toBeGreaterThan(0);

      const t = res.t;
      const expectedTargetX = targetPos.x + targetVel.x * t;
      const expectedTargetY = targetPos.y + targetVel.y * t;
      const expectedTargetZ = targetPos.z + targetVel.z * t;
      expect(res.x).toBeCloseTo(expectedTargetX, 2);
      expect(res.y).toBeCloseTo(expectedTargetY, 2);
      expect(res.z).toBeCloseTo(expectedTargetZ, 2);

      // Verify projectile hits target at time t in 3D
      const dirX = Math.cos(res.aimPitch) * Math.cos(res.aimAngle);
      const dirY = Math.cos(res.aimPitch) * Math.sin(res.aimAngle);
      const dirZ = Math.sin(res.aimPitch);

      const projVelX = shooterVel.x + dirX * projSpeed;
      const projVelY = shooterVel.y + dirY * projSpeed;
      const projVelZ = shooterVel.z + dirZ * projSpeed;

      expect(shooterPos.x + projVelX * t).toBeCloseTo(expectedTargetX, 2);
      expect(shooterPos.y + projVelY * t).toBeCloseTo(expectedTargetY, 2);
      expect(shooterPos.z + projVelZ * t).toBeCloseTo(expectedTargetZ, 2);
    });

    it('fires 3D laser and railgun projectiles climbing and diving along z', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = {
        id: 'ship_3d',
        pos: { x: 0, y: 0, z: 100 },
        vel: { x: 0, y: 0, z: 10 },
      };

      // 1. Laser climbing along +z with aimPitch = 30 deg (~0.5236 rad)
      const pitchUp = (30 * Math.PI) / 180;
      const laserProj = weapons.fireLaser(ship, 0, 1.0, pitchUp);
      expect(laserProj).not.toBeNull();
      expect(laserProj.pos.z).toBe(100);
      expect(laserProj.aimPitch).toBeCloseTo(pitchUp, 4);
      expect(laserProj.vel.z).toBeCloseTo(Math.sin(pitchUp) * weapons.laserMuzzleSpeed, 2);
      expect(laserProj.vel.x).toBeCloseTo(Math.cos(pitchUp) * weapons.laserMuzzleSpeed, 2);

      // 2. Railgun diving along -z with aimPitch = -45 deg (~ -0.7854 rad)
      weapons.chargeProgress = 1.0;
      weapons.railgunCooldown = 0;
      const pitchDown = (-45 * Math.PI) / 180;
      const railSlug = weapons.releaseRailgun(ship, 0, 1.0, pitchDown);
      expect(railSlug).not.toBeNull();
      expect(railSlug.pos.z).toBe(100);
      expect(railSlug.aimPitch).toBeCloseTo(pitchDown, 4);
      expect(railSlug.vel.z).toBeCloseTo(10 + Math.sin(pitchDown) * weapons.railgunMuzzleSpeed, 2);
      expect(railSlug.vel.x).toBeCloseTo(Math.cos(pitchDown) * weapons.railgunMuzzleSpeed, 2);
    });

    it('articulates railgun pitch slew rate limited to <= 20 deg/s and jams when damaged', () => {
      const weapons = new WeaponSystem('frigate');
      const shipAngle = 0;
      const shipPitch = 0;
      const desiredAngle = 0;
      const desiredPitch = (60 * Math.PI) / 180; // 60 deg pitch up

      // Step 1.0s at full power: pitch should increase by at most RAILGUN_MAX_SLEW_RATE (20 deg)
      const state1 = weapons.updateRailgunTraverse(1.0, shipAngle, desiredAngle, { weapons_railgun: 2.0 }, shipPitch, desiredPitch);
      expect(state1.railgunPitch).toBeCloseTo(RAILGUN_MAX_SLEW_RATE, 4);
      expect(state1.railgunLocalPitch).toBeCloseTo(RAILGUN_MAX_SLEW_RATE, 4);
      expect(state1.railgunJammed).toBe(false);

      // Step another 1.0s: pitch should reach 2 * RAILGUN_MAX_SLEW_RATE (40 deg)
      const state2 = weapons.updateRailgunTraverse(1.0, shipAngle, desiredAngle, { weapons_railgun: 2.0 }, shipPitch, desiredPitch);
      expect(state2.railgunPitch).toBeCloseTo(2 * RAILGUN_MAX_SLEW_RATE, 4);

      // Damage railgunHardware to <= 15 (jammed threshold)
      weapons.railgunHardware.health = 10;
      const jammedPitch = weapons.railgunPitch;
      const jammedState = weapons.updateRailgunTraverse(1.0, shipAngle, desiredAngle, { weapons_railgun: 2.0 }, shipPitch, desiredPitch);
      expect(jammedState.railgunJammed).toBe(true);
      expect(jammedState.railgunSlewRate).toBe(0);
      expect(jammedState.railgunPitch).toBeCloseTo(jammedPitch, 4);
    });

    it('steers 3D homing torpedoes converging toward elevated and depressed targets', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'shooter', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

      // Target elevated at z = 400
      const targetElevated = { id: 'target_up', pos: { x: 600, y: 0, z: 400 }, vel: { x: 0, y: 0, z: 0 }, hullHp: 1000 };
      const torpUp = weapons.launchTorpedo(ship, 0, 'target_up', 1.0, 0);
      expect(torpUp.vel.z).toBeCloseTo(0, 3);

      // Step simulation: torpedo should pitch up toward target (positive vel.z)
      weapons.updateProjectiles([torpUp], 0.2, [targetElevated], [], [], []);
      expect(torpUp.vel.z).toBeGreaterThan(10);
      expect(torpUp.pos.z).toBeGreaterThan(0);

      // Target depressed at z = -400
      const targetDepressed = { id: 'target_down', pos: { x: 600, y: 0, z: -400 }, vel: { x: 0, y: 0, z: 0 }, hullHp: 1000 };
      weapons.torpedoCooldown = 0;
      const torpDown = weapons.launchTorpedo(ship, 0, 'target_down', 1.0, 0);
      expect(torpDown.vel.z).toBeCloseTo(0, 3);

      // Step simulation: torpedo should pitch down toward target (negative vel.z)
      weapons.updateProjectiles([torpDown], 0.2, [targetDepressed], [], [], []);
      expect(torpDown.vel.z).toBeLessThan(-10);
      expect(torpDown.pos.z).toBeLessThan(0);
    });

    it('deflects railgun slug kinetic trajectory in 3D (including vel.z and aimPitch) upon hitting debris', () => {
      const weapons = new WeaponSystem('frigate');
      const slug = {
        id: 'slug_3d_deflect',
        type: 'railgun',
        pos: { x: 100, y: 0, z: 50 },
        vel: { x: 500, y: 0, z: 200 },
        radius: 6,
        lifetime: 5,
        damage: 300,
        destroyed: false,
      };

      // Debris chunk located ahead and higher in Z
      const debris = {
        pos: { x: 110, y: 0, z: 65 },
        radius: 15,
      };

      weapons.updateProjectiles([slug], 0.016, [], [], [], [debris]);

      expect(slug.deflected).toBe(true);
      // Slug hit debris with positive normal.z, so vel.z should be reflected downward
      expect(slug.vel.z).toBeLessThan(200);
      expect(typeof slug.aimPitch).toBe('number');
      expect(slug.aimPitch).toBeCloseTo(Math.atan2(slug.vel.z, Math.hypot(slug.vel.x, slug.vel.y)), 3);
    });
  });

  describe('Phase 11: Straight Non-Torpedo Ballistics & Monotonic Projectile IDs', () => {
    it('maintains straight ballistic flight for Pulse Lasers and Heavy Railguns near strong gravity wells', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'ship_shooter', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

      // Strong gravity well nearby, perpendicular to trajectory (at y: 500)
      const gravityWells = [{ x: 0, y: 500, z: 0, mass: 5000 }];

      // Fire Pulse Laser along +X axis (aimAngle = 0, aimPitch = 0)
      const laser = weapons.fireLaser(ship, 0, 1.0, 0);
      expect(laser).not.toBeNull();
      const initialLaserVel = { ...laser.vel };
      const initialLaserAngle = laser.aimAngle;
      const initialLaserPitch = laser.aimPitch;

      // Charge and release Heavy Railgun slug along +X axis
      weapons.charging = true;
      weapons.chargeProgress = 1.0;
      const slug = weapons.releaseRailgun(ship, 0, 1.0, 0);
      expect(slug).not.toBeNull();
      const initialSlugVel = { ...slug.vel };
      const initialSlugAngle = slug.aimAngle;
      const initialSlugPitch = slug.aimPitch;

      // Advance updateProjectiles for 1.0s (20 steps of dt = 0.05)
      for (let step = 0; step < 20; step++) {
        weapons.updateProjectiles([laser, slug], 0.05, [], gravityWells, [], []);
      }

      // Assert (vel.x, vel.y, vel.z) remains strictly unchanged for laser (zero lateral drift/curvature)
      expect(laser.vel.x).toBe(initialLaserVel.x);
      expect(laser.vel.y).toBe(initialLaserVel.y);
      expect(laser.vel.z).toBe(initialLaserVel.z);
      expect(laser.aimAngle).toBe(initialLaserAngle);
      expect(laser.aimPitch).toBe(initialLaserPitch);
      expect(laser.pos.y).toBe(0);
      expect(laser.pos.z).toBe(0);

      // Assert (vel.x, vel.y, vel.z) remains strictly unchanged for railgun slug (zero lateral drift/curvature)
      expect(slug.vel.x).toBe(initialSlugVel.x);
      expect(slug.vel.y).toBe(initialSlugVel.y);
      expect(slug.vel.z).toBe(initialSlugVel.z);
      expect(slug.aimAngle).toBe(initialSlugAngle);
      expect(slug.aimPitch).toBe(initialSlugPitch);
      expect(slug.pos.y).toBe(0);
      expect(slug.pos.z).toBe(0);
    });

    it('curves torpedoes via homing steering toward targets, and curves via gravity when lock is broken', () => {
      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'shooter', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };
      const gravityWells = [{ x: 0, y: 500, z: 0, mass: 5000 }];

      // Part A: Homing torpedo continues steering toward target
      const target = { id: 'target_curving', pos: { x: 600, y: 400, z: 0 }, vel: { x: 0, y: 0, z: 0 }, hullHp: 1000 };
      const homingTorp = weapons.launchTorpedo(ship, 0, 'target_curving', 1.0, 0);
      expect(homingTorp).not.toBeNull();
      expect(homingTorp.lockBroken).toBe(false);

      // Advance simulation: torpedo should steer/curve toward target (positive Y velocity and positive aimAngle)
      weapons.updateProjectiles([homingTorp], 0.2, [target], [], [], []);
      expect(homingTorp.vel.y).toBeGreaterThan(0);
      expect(homingTorp.aimAngle).toBeGreaterThan(0);

      // Part B: Torpedo responds to gravity wells when lockBroken is true
      weapons.torpedoCooldown = 0;
      const unguidedTorp = weapons.launchTorpedo(ship, 0, 'target_curving', 1.0, 0);
      expect(unguidedTorp).not.toBeNull();
      unguidedTorp.lockBroken = true; // Lock broken (e.g. from ECM or nebula)
      const initialTorpVy = unguidedTorp.vel.y; // 0

      // Advance simulation near gravity well at y: 500
      weapons.updateProjectiles([unguidedTorp], 0.2, [target], gravityWells, [], []);
      // Gravity well at y: 500 should pull unguided torpedo toward +Y
      expect(unguidedTorp.vel.y).toBeGreaterThan(initialTorpVy);
      expect(unguidedTorp.pos.y).toBeGreaterThan(0);
    });

    it('generates unique sequential projectile IDs across rapid burst firing', () => {
      const weapons = new WeaponSystem('frigate', 'swarm_missiles');
      const ship = { id: 'ship_burst', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

      const ids = [];

      // Burst fire lasers
      for (let i = 0; i < 20; i++) {
        weapons.cooldown = 0;
        weapons.heat = 0;
        const p = weapons.fireLaser(ship, 0, 1.0, 0);
        expect(p).not.toBeNull();
        expect(p.id).toMatch(/^laser_\d+_\d+_[a-z0-9]+$/);
        ids.push(p.id);
      }

      // Burst fire railgun slugs
      for (let i = 0; i < 20; i++) {
        weapons.charging = true;
        weapons.chargeProgress = 1.0;
        weapons.railgunCooldown = 0;
        const p = weapons.releaseRailgun(ship, 0, 1.0, 0);
        expect(p).not.toBeNull();
        expect(p.id).toMatch(/^railgun_\d+_\d+_[a-z0-9]+$/);
        ids.push(p.id);
      }

      // Burst fire torpedoes
      for (let i = 0; i < 20; i++) {
        weapons.magazine = 20;
        weapons.torpedoCooldown = 0;
        const p = weapons.launchTorpedo(ship, 0, null, 1.0, 0);
        expect(p).not.toBeNull();
        expect(p.id).toMatch(/^torpedo_\d+_\d+_[a-z0-9]+$/);
        ids.push(p.id);
      }

      expect(ids.length).toBe(60);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(60);
    });
  });

  describe('Phase 12: Charged Railgun Bypass, Thermal Overheating & Projectile Range Culling', () => {
    const testShip = { id: 'ship_alpha', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

    it('prevents uncharged railgun from charging at 0 power, but allows pre-charged railgun to fire with 0 power', () => {
      const weapons = new WeaponSystem('frigate');

      // 1. Uncharged railgun cannot build charge at 0 power
      weapons.startRailgunCharge();
      expect(weapons.charging).toBe(true);
      expect(weapons.chargeProgress).toBe(0);

      weapons.update(1.0, { weapons_railgun: 0 });
      expect(weapons.chargeProgress).toBe(0);

      // Attempt to release uncharged railgun returns null
      expect(weapons.releaseRailgun(testShip, 0, 0)).toBeNull();

      // 2. Charge to 100% with power
      weapons.update(2.0, { weapons_railgun: 1.0 });
      expect(weapons.chargeProgress).toBe(1.0);

      // 3. Cut grid power completely: weapons_railgun = 0
      // Pre-charged capacitors allow discharge even at 0 power!
      const slug = weapons.releaseRailgun(testShip, 0, 0);
      expect(slug).not.toBeNull();
      expect(slug.type).toBe('railgun');
      expect(slug.damage).toBe(weapons.railgunBaseDamage); // 250
      expect(weapons.chargeProgress).toBe(0);
      expect(weapons.railgunCooldown).toBe(RAILGUN_COOLDOWN_SEC);
    });

    it('overheats railgun, torpedoes, and shields when operated without coolant, operating at reduced effectiveness', () => {
      const weapons = new WeaponSystem('frigate');
      const dt = 0.1;
      const zeroCoolantMap = {
        weapons_railgun: 1.0,
        weapons_torpedo: 1.0,
        coolantMap: {
          weapons_railgun: 0,
          weapons_torpedo: 0,
        },
      };

      // 1. Heavy Railgun overheat without coolant
      weapons.startRailgunCharge();
      for (let i = 0; i < 40; i++) {
        weapons.update(dt, zeroCoolantMap);
        if (weapons.chargeProgress >= 1.0) weapons.chargeProgress = 0.5; // keep actively charging
      }
      expect(weapons.railgunHeat).toBe(100);
      expect(weapons.railgunOverheated).toBe(true);

      // Overheated railgun charge rate builds at 0.30x speed
      weapons.chargeProgress = 0;
      weapons.update(0.2, zeroCoolantMap);
      const overheatedCharge = weapons.chargeProgress;
      expect(overheatedCharge).toBeGreaterThan(0);
      expect(overheatedCharge).toBeLessThan(0.2); // severely slowed compared to nominal 1.2s charge time

      // Cool railgun down below 75 heat with coolant
      weapons.stopRailgunCharge();
      const cooledMap = { weapons_railgun: 0, coolantMap: { weapons_railgun: 1.0 } };
      for (let i = 0; i < 30; i++) {
        weapons.update(dt, cooledMap);
      }
      expect(weapons.railgunHeat).toBeLessThanOrEqual(75);
      expect(weapons.railgunOverheated).toBe(false);

      // 2. Torpedo reload overheat without coolant
      weapons.torpedoCooldown = 1.0;
      for (let i = 0; i < 40; i++) {
        weapons.torpedoCooldown = 1.0; // keep tube active
        weapons.update(dt, zeroCoolantMap);
      }
      expect(weapons.torpedoHeat).toBe(100);
      expect(weapons.torpedoOverheated).toBe(true);

      // Overheated torpedo recovers cooldown at 0.30x rate
      weapons.torpedoCooldown = 1.0;
      weapons.update(0.5, zeroCoolantMap);
      expect(weapons.torpedoCooldown).toBeGreaterThan(0.7); // recovered much less than 0.5s

      // 3. Shield quadrant overheat without coolant
      const shields = new ShieldSystem('frigate');
      shields.hp.fore = 50; // Damaged, actively regenerating
      const shieldZeroCoolant = {
        shields_fore: 1.0,
        coolantMap: { shields_fore: 0 },
      };

      for (let i = 0; i < 40; i++) {
        shields.hp.fore = 50; // keep actively regenerating
        shields.recharge(dt, shieldZeroCoolant);
      }
      expect(shields.heat.fore).toBe(100);
      expect(shields.overheated.fore).toBe(true);

      // Overheated shield regenerates at 0.25x rate
      shields.hp.fore = 50;
      shields.recharge(1.0, shieldZeroCoolant);
      const overheatedRegen = shields.hp.fore - 50;
      // Nominal regen at 100% power and full coolant: 200 * 0.01 * 1.0 = 2.0 HP/s
      // Overheated (0.25x) and coolantEff = 0.4: 200 * 0.01 * 0.4 * 0.25 = 0.2 HP/s
      expect(overheatedRegen).toBeCloseTo(0.2, 2);

      // Cool shield down below 75 heat
      const shieldFullCoolant = { shields_fore: 0, coolantMap: { shields_fore: 1.0 } };
      for (let i = 0; i < 30; i++) {
        shields.recharge(dt, shieldFullCoolant);
      }
      expect(shields.heat.fore).toBeLessThanOrEqual(75);
      expect(shields.overheated.fore).toBe(false);
    });

    it('keeps projectiles active at 4000m and culls them past the expanded ARENA_RADIUS (5250m)', () => {
      const weapons = new WeaponSystem('frigate');

      const projInArena = {
        id: 'laser_test_in',
        type: 'laser',
        pos: { x: 4000, y: 0, z: 0 },
        vel: { x: 600, y: 0, z: 0 },
        lifetime: 5.0,
        destroyed: false,
      };

      const projPastArena = {
        id: 'laser_test_out',
        type: 'laser',
        pos: { x: ARENA_RADIUS + 50, y: 0, z: 0 },
        vel: { x: 600, y: 0, z: 0 },
        lifetime: 5.0,
        destroyed: false,
      };

      const surviving = weapons.updateProjectiles([projInArena, projPastArena], 0.016, [], [], [], []);

      expect(projInArena.destroyed).toBe(false);
      expect(projPastArena.destroyed).toBe(true);
      expect(surviving.some(p => p.id === 'laser_test_in')).toBe(true);
      expect(surviving.some(p => p.id === 'laser_test_out')).toBe(false);
    });
  });

  describe('Phase 13 Slice 2 — 120% Power & Coolant Boost for Weapons & Shields', () => {
    const testShip = { id: 'ship_boost', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 } };

    it('boosts pulse laser damage (21.6) and heat dissipation (14.4 heat/s) with 1.2 power and 1.2 coolant', () => {
      const weapons = new WeaponSystem('frigate');

      // 1.2 power increases pulse laser damage: 18 * 1.2 = 21.6
      const laser1 = weapons.fireLaser(testShip, 0, 1.0);
      weapons.cooldown = 0;
      const laserBoosted = weapons.fireLaser(testShip, 0, 1.2);
      expect(laser1.damage).toBe(18);
      expect(laserBoosted.damage).toBeCloseTo(21.6, 2);

      // 1.2 coolant increases heat dissipation: 12.0 * 1.2 = 14.4/s
      weapons.heat = 60;
      weapons.update(1.0, { weapons_laser: 1.0, coolantMap: { weapons_laser: 1.2 } });
      expect(weapons.heat).toBeCloseTo(60 - 14.4, 4);
    });

    it('boosts railgun slew rate (1.12x), charge speed (1.12x) and slug damage (300) with 1.2 power and 1.2 coolant', () => {
      const weapons = new WeaponSystem('frigate');

      // 1.2 coolant yields 1.12x slew rate
      weapons.updateRailgunTraverse(1 / 60, 0, Math.PI / 2, {
        weapons_railgun: 1.0,
        coolantMap: { weapons_railgun: 1.2 },
      });
      expect(weapons.railgunSlewRate).toBeCloseTo(RAILGUN_MAX_SLEW_RATE * 1.12, 5);

      // 1.2 coolant yields 1.12x charge speed (0.56 after 0.6s)
      weapons.startRailgunCharge();
      weapons.update(0.6, {
        weapons_railgun: 1.0,
        coolantMap: { weapons_railgun: 1.2 },
      });
      expect(weapons.chargeProgress).toBeCloseTo(0.56, 3);

      // 1.2 power yields 300 slug damage (250 * 1.2)
      weapons.chargeProgress = 1.0;
      const slug = weapons.releaseRailgun(testShip, 0, 1.2);
      expect(slug).not.toBeNull();
      expect(slug.damage).toBe(300);
    });

    it('boosts torpedo damage (480) and turn rate (2.4) with 1.2 power, speeds cooldown recovery with 1.2 coolant, and retains baseline at <= 1.0 power', () => {
      const weapons = new WeaponSystem('frigate');

      // 1.2 power scales damage to 480 (400 * 1.2) and turnRate to 1.44 (2.0 * SHIP_PACING_SCALE * 1.2)
      const boostedTorp = weapons.launchTorpedo(testShip, 0, 'enemy1', 1.2);
      expect(boostedTorp).not.toBeNull();
      expect(boostedTorp.damage).toBe(480);
      expect(boostedTorp.turnRate).toBeCloseTo(2.4 * SHIP_PACING_SCALE, 4);

      // power <= 1.0 retains baseline damage (400) and turn rate (1.2 = 2.0 * SHIP_PACING_SCALE)
      weapons.torpedoCooldown = 0;
      const baselineTorp = weapons.launchTorpedo(testShip, 0, 'enemy1', 0.8);
      expect(baselineTorp).not.toBeNull();
      expect(baselineTorp.damage).toBe(400);
      expect(baselineTorp.turnRate).toBeCloseTo(2.0 * SHIP_PACING_SCALE, 4);

      // 1.2 coolant yields 1.12x cooldown recovery rate
      weapons.torpedoCooldown = 1.0;
      weapons.update(0.5, { coolantMap: { weapons_torpedo: 1.2 } });
      expect(weapons.torpedoCooldown).toBeCloseTo(1.0 - 0.5 * 1.12, 4);
    });

    it('boosts shield recharge rate to 1.344x and cooling to 1.2x with 1.2 power and 1.2 coolant', () => {
      const shields = new ShieldSystem(100);
      shields.hp.fore = 20;

      // 1.2 power & 1.2 coolant: 100 * 0.01 * 1.2 * (0.4 + 0.6 * 1.2) = 1.344 HP/s
      shields.recharge(1.0, {
        shields_fore: 1.2,
        coolantMap: { shields_fore: 1.2 },
      });
      expect(shields.hp.fore).toBeCloseTo(20 + 1.344, 4);

      // 1.2 coolant cools shields at 14.4 heat/s (12.0 * 1.2)
      shields.heat.fore = 50;
      shields.hp.fore = 100; // full hp prevents active regeneration
      shields.recharge(1.0, {
        shields_fore: 1.2,
        coolantMap: { shields_fore: 1.2 },
      });
      expect(shields.heat.fore).toBeCloseTo(50 - 14.4, 4);
    });
  });

  describe('Phase 19 Slice 1: Weapon Torpedo Speed & Railgun/Torpedo Cooldown Scaling', () => {
    it('scales torpedo muzzle speed (150 m/s), railgun cooldown (2.5s), torpedo cooldown (5/3s), and lifetime (50/3s) by SHIP_PACING_SCALE', () => {
      expect(TORPEDO_MUZZLE_SPEED).toBe(150);
      expect(RAILGUN_COOLDOWN_SEC).toBe(2.5);
      expect(TORPEDO_COOLDOWN_SEC).toBeCloseTo(5 / 3, 5);
      expect(TORPEDO_LIFETIME_SEC).toBeCloseTo(50 / 3, 5);

      const weapons = new WeaponSystem('frigate');
      const ship = { id: 'ship1', pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } };

      // Torpedo launch sets muzzle speed to 150, cooldown to 5/3, lifetime to 50/3
      const torp = weapons.launchTorpedo(ship, 0, 'target1');
      expect(torp.speed).toBe(150);
      expect(torp.lifetime).toBeCloseTo(50 / 3, 5);
      expect(weapons.torpedoCooldown).toBeCloseTo(5 / 3, 5);

      // Railgun release sets cooldown to 2.5s
      weapons.chargeProgress = 1.0;
      weapons.railgunCooldown = 0;
      const slug = weapons.releaseRailgun(ship, 0, 1.0);
      expect(slug).not.toBeNull();
      expect(weapons.railgunCooldown).toBe(2.5);

      // Torpedo cooldown recovers at torpThermalEff * (overheated ? 0.30 : 1.0)
      const beforeCd = weapons.torpedoCooldown;
      weapons.update(0.5, { coolantMap: { weapons_torpedo: 1.0 } }); // torpThermalEff = 1.0
      expect(weapons.torpedoCooldown).toBeCloseTo(beforeCd - 0.5, 4);

      // Boosted torpedo at power 1.2 scales turnRate to 2.0 * SHIP_PACING_SCALE * 1.2 = 1.44
      weapons.torpedoCooldown = 0;
      const boostedTorp = weapons.launchTorpedo(ship, 0, 'target2', 1.2);
      expect(boostedTorp.speed).toBe(150);
      expect(boostedTorp.damage).toBe(480);
      expect(boostedTorp.turnRate).toBeCloseTo(2.4 * SHIP_PACING_SCALE, 4);
    });
  });
});
