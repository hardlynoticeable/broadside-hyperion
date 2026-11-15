import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateSector,
  createSeededRng,
  updateTetherMines,
  updateIonNebulae,
  updateMunitionsDerelict,
  createAsteroidDebrisChunks,
  SHIP_SPAWN_POINTS,
  SHIP_SPAWN_ANGLES,
  SPAWN_SAFE_RADIUS,
} from '../../src/world/sector-generator.js';
import { ARENA_RADIUS, SECTOR_Z_HALF_EXTENT, DEFAULT_SPAWN_OFFSET_X, MAX_SPIN_RATE } from '../../src/physics/constants.js';
import { WeaponSystem } from '../../src/combat/weapons.js';
import { ShieldSystem } from '../../src/combat/shields.js';
import { ConduitGrid10x10 } from '../../src/systems/grid-10x10.js';

describe('Procedural Sector Generator & Hazards', () => {
  describe('Deterministic Sector Generation', () => {
    it('produces identical sector layout when given identical seed', () => {
      const sectorA = generateSector(4242);
      const sectorB = generateSector(4242);

      expect(sectorA.asteroids.length).toBe(sectorB.asteroids.length);
      expect(sectorA.asteroids[0].pos.x).toBe(sectorB.asteroids[0].pos.x);
      expect(sectorA.asteroids[0].pos.y).toBe(sectorB.asteroids[0].pos.y);
      expect(sectorA.debrisFields.length).toBe(sectorB.debrisFields.length);
      expect(sectorA.munitionsDerelict.pos.x).toBe(sectorB.munitionsDerelict.pos.x);
    });

    it('produces different layouts for different seeds', () => {
      const sectorA = generateSector(1111);
      const sectorB = generateSector(9999);

      expect(sectorA.asteroids[0].pos.x).not.toBe(sectorB.asteroids[0].pos.x);
    });

    it('generates 14 to 18 craggy asteroids with ore veins', () => {
      const sector = generateSector(12345);
      expect(sector.asteroids.length).toBeGreaterThanOrEqual(14);
      expect(sector.asteroids.length).toBeLessThanOrEqual(18);

      for (const ast of sector.asteroids) {
        expect(ast.radius).toBeGreaterThanOrEqual(70);
        expect(ast.radius).toBeLessThanOrEqual(180);
        expect(ast.vertices.length).toBeGreaterThanOrEqual(8);
        expect(ast.oreVeins.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('Phase 12: verifies expanded arena radius (5250m), Z half-extent (1500m), spawn points (±2200m), and safe radius (750m)', () => {
      expect(ARENA_RADIUS).toBe(5250);
      expect(SECTOR_Z_HALF_EXTENT).toBe(1500);
      expect(DEFAULT_SPAWN_OFFSET_X).toBe(2200);
      expect(SPAWN_SAFE_RADIUS).toBe(750);
      expect(SHIP_SPAWN_POINTS).toEqual([
        { x: -2200, y: 0, z: 0 },
        { x: 2200, y: 0, z: 0 },
      ]);
      const sector = generateSector(42);
      expect(sector.arenaRadius).toBe(5250);
    });

    it('enforces SPAWN_SAFE_RADIUS (750m) exclusion zone for all celestial bodies across 50+ seeds', () => {
      const seedsToTest = [];
      for (let s = 1; s <= 50; s++) seedsToTest.push(s);
      seedsToTest.push(12345);
      seedsToTest.push(1731427200000); // large timestamp seed
      seedsToTest.push(987654321);

      for (const seed of seedsToTest) {
        const sector = generateSector(seed, { forceTetherMine: true });

        // Check asteroids: edge-to-spawn clearance >= SPAWN_SAFE_RADIUS (600m) in 3D
        for (const ast of sector.asteroids) {
          for (const sp of SHIP_SPAWN_POINTS) {
            const dist = Math.hypot(ast.pos.x - sp.x, ast.pos.y - sp.y, (ast.pos.z ?? 0) - (sp.z ?? 0));
            expect(dist - ast.radius).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS - 1e-4);
          }
        }

        // Check debris chunks: edge-to-spawn clearance >= SPAWN_SAFE_RADIUS (600m) in 3D
        for (const field of sector.debrisFields) {
          for (const chunk of field.debrisChunks) {
            for (const sp of SHIP_SPAWN_POINTS) {
              const dist = Math.hypot(chunk.pos.x - sp.x, chunk.pos.y - sp.y, (chunk.pos.z ?? 0) - (sp.z ?? 0));
              expect(dist - chunk.radius).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS - 1e-4);
            }
          }
        }

        // Check tether mines: trigger-to-spawn clearance >= SPAWN_SAFE_RADIUS (600m) in 3D
        for (const mine of sector.tetherMines) {
          for (const sp of SHIP_SPAWN_POINTS) {
            const dist = Math.hypot(mine.pos.x - sp.x, mine.pos.y - sp.y, (mine.pos.z ?? 0) - (sp.z ?? 0));
            expect(dist - mine.triggerRadius).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS - 1e-4);
          }
        }

        // Check gravity wells center: center distance >= 950m in 3D
        for (const well of sector.gravityWells) {
          for (const sp of SHIP_SPAWN_POINTS) {
            const dist = Math.hypot(well.pos.x - sp.x, well.pos.y - sp.y, (well.pos.z ?? 0) - (sp.z ?? 0));
            expect(dist).toBeGreaterThanOrEqual(950 - 1e-4);
          }
        }

        // Check ion nebulae: edge-to-spawn clearance >= SPAWN_SAFE_RADIUS (600m) in 3D
        for (const neb of sector.ionNebulae) {
          for (const sp of SHIP_SPAWN_POINTS) {
            const dist = Math.hypot(neb.pos.x - sp.x, neb.pos.y - sp.y, (neb.pos.z ?? 0) - (sp.z ?? 0));
            expect(dist - neb.radius).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS - 1e-4);
          }
        }

        // Check munitions derelict: edge-to-spawn clearance >= SPAWN_SAFE_RADIUS (600m) in 3D
        if (sector.munitionsDerelict) {
          const derelict = sector.munitionsDerelict;
          for (const sp of SHIP_SPAWN_POINTS) {
            const dist = Math.hypot(derelict.pos.x - sp.x, derelict.pos.y - sp.y, (derelict.pos.z ?? 0) - (sp.z ?? 0));
            expect(dist - derelict.radius).toBeGreaterThanOrEqual(SPAWN_SAFE_RADIUS - 1e-4);
          }
        }
      }
    });

    it('generates toned-down environmental hazard parameters', () => {
      const sector = generateSector(12345, { forceTetherMine: true });

      // Gravity wells
      expect(sector.gravityWells.length).toBeGreaterThanOrEqual(1);
      for (const well of sector.gravityWells) {
        expect(well.mass).toBeGreaterThanOrEqual(350);
        expect(well.mass).toBeLessThanOrEqual(600);
        expect(well.pullRadius).toBe(750);
        expect(well.eventHorizonRadius).toBe(35);
        expect(well.epsilon).toBe(25);
      }

      // Debris chunks
      expect(sector.debrisFields.length).toBeGreaterThanOrEqual(1);
      for (const field of sector.debrisFields) {
        for (const chunk of field.debrisChunks) {
          expect(chunk.mass).toBeGreaterThanOrEqual(80);
          expect(chunk.mass).toBeLessThanOrEqual(240);
        }
      }

      // Ion Nebulae
      expect(sector.ionNebulae.length).toBeGreaterThanOrEqual(1);
      for (const neb of sector.ionNebulae) {
        expect(neb.surgeInterval).toBe(12.0);
      }
    });

    it('spawns debris fields with >=80% probability across 100 seeds, and default seed 12345 has 2 fields', () => {
      const defaultSector = generateSector(12345);
      expect(defaultSector.debrisFields.length).toBe(2);

      let sectorsWithDebris = 0;
      for (let s = 1; s <= 100; s++) {
        const sec = generateSector(s * 7919);
        if (sec.debrisFields.length >= 1) {
          sectorsWithDebris++;
        }
      }

      // Must be >= 80%
      expect(sectorsWithDebris).toBeGreaterThanOrEqual(80);
    });

    it('supports forceTetherMine option to guarantee tether mine spawn', () => {
      const sector = generateSector(8888, { forceTetherMine: true });
      expect(sector.tetherMines.length).toBeGreaterThanOrEqual(1);
      expect(sector.tetherMines[0].armed).toBe(true);
      expect(sector.tetherMines[0].triggerRadius).toBe(150);
    });

    it('does not generate solarFlare on sector object', () => {
      const sector = generateSector(12345);
      expect(sector.solarFlare).toBeUndefined();
    });
  });

  describe('Tether Mine Hazard', () => {
    it('triggers proximity detonation within 150m, spinning ship and damaging an RCS bank', () => {
      const mine = {
        id: 'mine_1',
        pos: { x: 100, y: 100 },
        armed: true,
        triggerRadius: 150,
      };

      const ship = {
        id: 'ship_beta',
        pos: { x: 100, y: 150 }, // 50m distance (within 150m)
        omega: 0,
        thrusters: {
          bowPort: { health: 100 },
          bowStarboard: { health: 100 },
        },
      };

      const detonations = updateTetherMines([mine], [ship], 1 / 60);

      expect(detonations.length).toBe(1);
      expect(mine.armed).toBe(false);
      expect(mine.triggered).toBe(true);
      expect(mine.tetheredShipId).toBe('ship_beta');

      // Strong rotational impulse
      expect(Math.abs(ship.omega)).toBeGreaterThanOrEqual(2.5);

      // Damaged RCS bank
      expect(ship.thrusters.bowPort.health).toBe(50);
    });

    it('damages 1 random tile on Engineer grid when mine detonates on a ship with grid', () => {
      const mine = {
        id: 'mine_grid',
        pos: { x: 0, y: 0 },
        armed: true,
        triggerRadius: 150,
      };
      const grid = new ConduitGrid10x10('frigate');
      const ship = {
        id: 'ship_grid',
        pos: { x: 50, y: 0 },
        omega: 0,
        thrusters: { bowPort: { health: 100 } },
        grid,
      };

      const brokenBefore = grid.tiles.flat().filter(t => t.status === 'broken').length;
      updateTetherMines([mine], [ship], 1 / 60);
      const brokenAfter = grid.tiles.flat().filter(t => t.status === 'broken').length;
      expect(brokenAfter).toBe(brokenBefore + 1);
    });

    it('does not trigger if ship is outside triggerRadius (150m)', () => {
      const mine = {
        id: 'mine_1',
        pos: { x: 100, y: 100 },
        armed: true,
        triggerRadius: 150,
      };

      const ship = {
        id: 'ship_beta',
        pos: { x: 100, y: 300 }, // 200m distance (> 150m)
        omega: 0,
        thrusters: { bowPort: { health: 100 } },
      };

      const detonations = updateTetherMines([mine], [ship], 1 / 60);
      expect(detonations.length).toBe(0);
      expect(mine.armed).toBe(true);
      expect(ship.omega).toBe(0);
    });

    it('caps ship.omega to Math.PI even when detonating multiple stacked tether mines', () => {
      const mine1 = { id: 'm1', pos: { x: 0, y: 0 }, armed: true, triggerRadius: 150 };
      const mine2 = { id: 'm2', pos: { x: 10, y: 0 }, armed: true, triggerRadius: 150 };
      const mine3 = { id: 'm3', pos: { x: 20, y: 0 }, armed: true, triggerRadius: 150 };

      const ship = {
        id: 'ship_stacked',
        pos: { x: 0, y: 50 },
        omega: 2.0, // already spinning
        thrusters: { bowPort: { health: 100 } },
      };

      updateTetherMines([mine1, mine2, mine3], [ship], 1 / 60);
      expect(ship.omega).toBeLessThanOrEqual(MAX_SPIN_RATE);
      expect(ship.omega).toBeCloseTo(MAX_SPIN_RATE, 5);
    });
  });

  describe('Ion Storm Nebulae', () => {
    it('marks ships inside nebula and triggers periodic tile rotations on 10x10 grid', () => {
      const nebula = {
        id: 'nebula_1',
        pos: { x: 0, y: 0 },
        radius: 500,
        surgeInterval: 2.0,
        surgeTimer: 1.95,
      };

      const grid = new ConduitGrid10x10('frigate');
      const ship = {
        id: 'ship_in_nebula',
        pos: { x: 100, y: 100 }, // Inside 500m radius
        inNebula: false,
        grid,
      };

      // Step by 0.1s: crosses surgeInterval (1.95 + 0.1 = 2.05 >= 2.0)
      updateIonNebulae([nebula], [ship], 0.1);

      expect(ship.inNebula).toBe(true);
      expect(nebula.surgeTimer).toBe(0); // Reset after surge
    });
  });

  describe('Orbital Munitions Derelict (Tractor Resupply)', () => {
    let derelict;
    let ship;

    beforeEach(() => {
      derelict = {
        id: 'derelict_alpha',
        pos: { x: 500, y: 500 },
        vel: { x: 0, y: 0 },
        resupplyRange: 80,
        maxRelativeSpeed: 15,
        requiredTractorTime: 5.0,
        progressByShip: {},
      };

      const weapons = new WeaponSystem('frigate');
      weapons.magazine = 2; // Low ammo

      ship = {
        id: 'ship_tractor',
        pos: { x: 500, y: 540 }, // 40m distance (within 80m)
        vel: { x: 5, y: 0 },      // 5 m/s rel speed (< 15 m/s)
        powerMap: { cargo_tractor: 1.5 }, // Active tractor beam power
        weapons,
      };
    });

    it('resupplies +3 torpedoes after 5.0 continuous seconds of powered tractor hold', () => {
      expect(ship.weapons.magazine).toBe(2);

      // Advance by 4.9 seconds: not yet complete
      for (let i = 0; i < 49; i++) {
        updateMunitionsDerelict(derelict, [ship], 0.1);
      }
      expect(ship.weapons.magazine).toBe(2);
      expect(derelict.progressByShip[ship.id]).toBeCloseTo(4.9, 2);

      // Final 0.2s completes the 5.0s requirement
      const events = updateMunitionsDerelict(derelict, [ship], 0.2);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('resupply_complete');
      expect(ship.weapons.magazine).toBe(5); // 2 + 3 = 5!
      expect(derelict.progressByShip[ship.id]).toBe(0); // Progress reset
    });

    it('resets progress if relative velocity exceeds 15 m/s', () => {
      // Accumulate 3 seconds
      for (let i = 0; i < 30; i++) {
        updateMunitionsDerelict(derelict, [ship], 0.1);
      }
      expect(derelict.progressByShip[ship.id]).toBeCloseTo(3.0, 2);

      // Ship accelerates to 20 m/s
      ship.vel.x = 20;
      updateMunitionsDerelict(derelict, [ship], 0.1);
      expect(derelict.progressByShip[ship.id]).toBe(0);
    });

    it('resets progress if cargo tractor power is lost', () => {
      // Accumulate 2 seconds
      for (let i = 0; i < 20; i++) {
        updateMunitionsDerelict(derelict, [ship], 0.1);
      }
      expect(derelict.progressByShip[ship.id]).toBeCloseTo(2.0, 2);

      // Engineer cuts tractor power
      ship.powerMap.cargo_tractor = 0;
      updateMunitionsDerelict(derelict, [ship], 0.1);
      expect(derelict.progressByShip[ship.id]).toBe(0);
    });
  });

  describe('Destructible Asteroids & Dynamic Debris Chunks', () => {
    it('initializes maxHp, hp, and destroyed: false on every generated asteroid', () => {
      const sector = generateSector(12345);
      expect(sector.asteroids.length).toBeGreaterThan(0);

      for (const ast of sector.asteroids) {
        expect(ast.maxHp).toBe(Math.round(ast.radius * 2.5));
        expect(ast.hp).toBe(Math.round(ast.radius * 2.5));
        expect(ast.destroyed).toBe(false);
      }
    });

    it('createAsteroidDebrisChunks spawns dynamic cover chunks with radius in 10..22, mass in 200..450, and radial ejection at 35..120 m/s', () => {
      const asteroid = {
        id: 'ast_test_99',
        pos: { x: 500, y: -300 },
        radius: 120,
      };
      const impactPos = { x: 620, y: -300 };

      // Chip damage chunks (count = 2)
      const chipChunks = createAsteroidDebrisChunks(asteroid, impactPos, 2);
      expect(chipChunks.length).toBe(2);

      for (const chunk of chipChunks) {
        expect(chunk.id).toContain('ast_test_99');
        expect(chunk.radius).toBeGreaterThanOrEqual(10);
        expect(chunk.radius).toBeLessThanOrEqual(22);
        expect(chunk.mass).toBeGreaterThanOrEqual(200);
        expect(chunk.mass).toBeLessThanOrEqual(450);

        const speed = Math.hypot(chunk.vel.x, chunk.vel.y);
        expect(speed).toBeGreaterThanOrEqual(35);
        expect(speed).toBeLessThanOrEqual(120);

        // Positioned outside asteroid radius
        const distFromCenter = Math.hypot(chunk.pos.x - asteroid.pos.x, chunk.pos.y - asteroid.pos.y);
        expect(distFromCenter).toBeGreaterThanOrEqual(asteroid.radius);

        expect(chunk.vertices.length).toBe(4);
        expect(chunk.angle).toBeDefined();
        expect(chunk.omega).toBeDefined();
      }

      // Shatter chunks (count = 6)
      const shatterChunks = createAsteroidDebrisChunks(asteroid, null, 6);
      expect(shatterChunks.length).toBe(6);
      for (const chunk of shatterChunks) {
        expect(chunk.radius).toBeGreaterThanOrEqual(10);
        expect(chunk.radius).toBeLessThanOrEqual(22);
        expect(chunk.mass).toBeGreaterThanOrEqual(200);
        expect(chunk.mass).toBeLessThanOrEqual(450);
        const speed = Math.hypot(chunk.vel.x, chunk.vel.y);
        expect(speed).toBeGreaterThanOrEqual(35);
        expect(speed).toBeLessThanOrEqual(120);
      }
    });
  });

  describe('3D Sector Coordinates & Vertical Distribution', () => {
    it('generates asteroids with an explicit mix above z > 150 and below z < -150', () => {
      const sector = generateSector(12345);

      const aboveAsteroids = sector.asteroids.filter(a => a.pos.z > 150);
      const belowAsteroids = sector.asteroids.filter(a => a.pos.z < -150);

      expect(aboveAsteroids.length).toBeGreaterThanOrEqual(4);
      expect(belowAsteroids.length).toBeGreaterThanOrEqual(4);

      // Verify all asteroids have valid numeric z coordinates and vertices match pos.z
      for (const ast of sector.asteroids) {
        expect(typeof ast.pos.z).toBe('number');
        expect(Number.isFinite(ast.pos.z)).toBe(true);
        for (const v of ast.vertices) {
          expect(v.z).toBe(ast.pos.z);
        }
      }
    });

    it('distributes celestial bodies, debris, nebulae, and derelict across 3D space with z != 0', () => {
      const sector = generateSector(12345, { forceTetherMine: true });

      // Gravity wells have z != 0
      expect(sector.gravityWells.length).toBeGreaterThan(0);
      for (const well of sector.gravityWells) {
        expect(typeof well.pos.z).toBe('number');
        expect(well.pos.z).not.toBe(0);
      }

      // Ion Nebulae have z != 0
      expect(sector.ionNebulae.length).toBeGreaterThan(0);
      for (const neb of sector.ionNebulae) {
        expect(typeof neb.pos.z).toBe('number');
        expect(neb.pos.z).not.toBe(0);
      }

      // Munitions derelict has 3D position and subtle 3D velocity drift
      expect(typeof sector.munitionsDerelict.pos.z).toBe('number');
      expect(sector.munitionsDerelict.pos.z).toBe(0); // Orbital plane anchor for baseline resupply compatibility
      expect(typeof sector.munitionsDerelict.vel.z).toBe('number');
      expect(sector.munitionsDerelict.vel.z).not.toBe(0);

      // Tether mines have 3D position
      for (const mine of sector.tetherMines) {
        expect(typeof mine.pos.z).toBe('number');
      }

      // Debris chunks have 3D pos and vel
      for (const field of sector.debrisFields) {
        for (const chunk of field.debrisChunks) {
          expect(typeof chunk.pos.z).toBe('number');
          expect(typeof chunk.vel.z).toBe('number');
        }
      }
    });

    it('createAsteroidDebrisChunks assigns 3D z position matching asteroid.pos.z and 3D velocity spread', () => {
      const asteroid = {
        id: 'ast_3d_test',
        pos: { x: 300, y: -200, z: 250 },
        radius: 90,
      };

      const chunks = createAsteroidDebrisChunks(asteroid, null, 4);
      expect(chunks.length).toBe(4);
      for (const chunk of chunks) {
        expect(chunk.pos.z).toBeCloseTo(250, 0);
        expect(typeof chunk.vel.z).toBe('number');
      }
    });

    it('SHIP_SPAWN_ANGLES orient ships counter-clockwise (Alpha facing South +PI/2, Omega facing North -PI/2)', () => {
      expect(SHIP_SPAWN_ANGLES[0]).toBeCloseTo(Math.PI / 2, 5);
      expect(SHIP_SPAWN_ANGLES[1]).toBeCloseTo(-Math.PI / 2, 5);

      // In Three.js / Spectator screen coordinates (X = x, Y_screen = -y), verify CCW orbital cross product: r_screen x f_screen > 0
      const alphaCross = SHIP_SPAWN_POINTS[0].x * (-Math.sin(SHIP_SPAWN_ANGLES[0])) - (-SHIP_SPAWN_POINTS[0].y) * Math.cos(SHIP_SPAWN_ANGLES[0]);
      const omegaCross = SHIP_SPAWN_POINTS[1].x * (-Math.sin(SHIP_SPAWN_ANGLES[1])) - (-SHIP_SPAWN_POINTS[1].y) * Math.cos(SHIP_SPAWN_ANGLES[1]);
      expect(alphaCross).toBeGreaterThan(0);
      expect(omegaCross).toBeGreaterThan(0);
    });
  });
});
