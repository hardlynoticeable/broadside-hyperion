/**
 * BROADSIDE HYPERION — Hyperspace Jump Drive Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  HYPERSPACE_CHARGE_DURATION_100,
  HYPERSPACE_BASE_CHARGE_RATE,
  HYPERSPACE_CHARGE_DECAY_RATE,
  HYPERSPACE_JUMP_DURATION,
  HYPERSPACE_REBOOT_STAGE1_SEC,
  HYPERSPACE_REBOOT_TOTAL_SEC,
  HYPERSPACE_MIN_JUMP_DIST,
  HYPERSPACE_MAX_JUMP_DIST,
  HYPERSPACE_FORWARD_HALF_ANGLE,
  HYPERSPACE_CLEARANCE_PADDING,
  HYPERSPACE_ARENA_EDGE_MARGIN,
  HYPERSPACE_Z_EDGE_MARGIN,
  createHyperspaceState,
  getHyperspaceRestrictions,
  isPointEmptySpace,
  findHyperspaceDestination,
  updateHyperspaceState,
} from '../../src/systems/hyperspace.js';
import { generateSector } from '../../src/world/sector-generator.js';

describe('Hyperspace System — Constants & State Creation', () => {
  it('exports expected timing and tuning constants', () => {
    expect(HYPERSPACE_CHARGE_DURATION_100).toBe(10.0);
    expect(HYPERSPACE_BASE_CHARGE_RATE).toBe(0.1);
    expect(HYPERSPACE_CHARGE_DECAY_RATE).toBe(0.1);
    expect(HYPERSPACE_JUMP_DURATION).toBe(2.2);
    expect(HYPERSPACE_REBOOT_STAGE1_SEC).toBe(4.0);
    expect(HYPERSPACE_REBOOT_TOTAL_SEC).toBe(7.0);
    expect(HYPERSPACE_MIN_JUMP_DIST).toBe(1200);
    expect(HYPERSPACE_MAX_JUMP_DIST).toBe(4200);
    expect(HYPERSPACE_FORWARD_HALF_ANGLE).toBeCloseTo(Math.PI / 3, 5);
    expect(HYPERSPACE_CLEARANCE_PADDING).toBe(180);
    expect(HYPERSPACE_ARENA_EDGE_MARGIN).toBe(220);
    expect(HYPERSPACE_Z_EDGE_MARGIN).toBe(200);
  });

  it('creates initial hyperspace state with ready status', () => {
    const hs = createHyperspaceState();
    expect(hs.state).toBe('ready');
    expect(hs.charge).toBe(0);
    expect(hs.jumpTimer).toBe(0);
    expect(hs.rebootTimer).toBe(0);
    expect(hs.health).toBe(100);
    expect(hs.maxHealth).toBe(100);
    expect(hs.originPos).toBeNull();
    expect(hs.destinationPos).toBeNull();
    expect(hs.warpHeadingAngle).toBe(0);
    expect(hs.warpHeadingPitch).toBe(0);
    expect(hs.jumpCount).toBe(0);
  });
});

describe('Hyperspace Restrictions Matrix', () => {
  it('returns all online for ready and charging states', () => {
    const readyRestr = getHyperspaceRestrictions({ hyperspace: { state: 'ready' } });
    expect(readyRestr.jumping).toBe(false);
    expect(readyRestr.rebooting).toBe(false);
    expect(readyRestr.externalViewsOnline).toBe(true);
    expect(readyRestr.enginesOnline).toBe(true);
    expect(readyRestr.rcsOnline).toBe(true);
    expect(readyRestr.sasOnline).toBe(true);
    expect(readyRestr.shieldsOnline).toBe(true);
    expect(readyRestr.weaponsOnline).toBe(true);
    expect(readyRestr.targetingOnline).toBe(true);
    expect(readyRestr.sensorsOnline).toBe(true);
    expect(readyRestr.dronesOnline).toBe(true);
    expect(readyRestr.hyperspaceOnline).toBe(true);
    expect(readyRestr.stage1RemainingSec).toBe(0);
    expect(readyRestr.stage2RemainingSec).toBe(0);

    const chargingRestr = getHyperspaceRestrictions({ hyperspace: { state: 'charging', charge: 0.5 } });
    expect(chargingRestr.jumping).toBe(false);
    expect(chargingRestr.enginesOnline).toBe(true);
    expect(chargingRestr.shieldsOnline).toBe(true);
  });

  it('enforces jumping restrictions (external views online for warp tunnel, all other systems offline)', () => {
    const jumpRestr = getHyperspaceRestrictions({ hyperspace: { state: 'jumping', jumpTimer: 1.0 } });
    expect(jumpRestr.jumping).toBe(true);
    expect(jumpRestr.rebooting).toBe(false);
    expect(jumpRestr.externalViewsOnline).toBe(true);
    expect(jumpRestr.enginesOnline).toBe(false);
    expect(jumpRestr.rcsOnline).toBe(false);
    expect(jumpRestr.sasOnline).toBe(false);
    expect(jumpRestr.shieldsOnline).toBe(false);
    expect(jumpRestr.weaponsOnline).toBe(false);
    expect(jumpRestr.targetingOnline).toBe(false);
    expect(jumpRestr.sensorsOnline).toBe(false);
    expect(jumpRestr.dronesOnline).toBe(false);
    expect(jumpRestr.hyperspaceOnline).toBe(false);
  });

  it('enforces Stage 0 reboot (0..3.99s): all systems offline, views offline', () => {
    for (const t of [0.0, 1.5, 3.99]) {
      const r = getHyperspaceRestrictions({ hyperspace: { state: 'rebooting', rebootTimer: t } });
      expect(r.jumping).toBe(false);
      expect(r.rebooting).toBe(true);
      expect(r.externalViewsOnline).toBe(false);
      expect(r.enginesOnline).toBe(false);
      expect(r.rcsOnline).toBe(false);
      expect(r.sasOnline).toBe(false);
      expect(r.shieldsOnline).toBe(false);
      expect(r.weaponsOnline).toBe(false);
      expect(r.targetingOnline).toBe(false);
      expect(r.sensorsOnline).toBe(false);
      expect(r.dronesOnline).toBe(false);
      expect(r.hyperspaceOnline).toBe(false);
      expect(r.stage1RemainingSec).toBeCloseTo(4.0 - t, 5);
      expect(r.stage2RemainingSec).toBeCloseTo(7.0 - t, 5);
    }
  });

  it('enforces Stage 1 reboot (4.0..6.99s): external views, engines, and RCS online; weapons/shields/sensors/SAS/drones offline', () => {
    for (const t of [4.0, 5.2, 6.99]) {
      const r = getHyperspaceRestrictions({ hyperspace: { state: 'rebooting', rebootTimer: t } });
      expect(r.jumping).toBe(false);
      expect(r.rebooting).toBe(true);
      expect(r.externalViewsOnline).toBe(true);
      expect(r.enginesOnline).toBe(true);
      expect(r.rcsOnline).toBe(true);
      expect(r.sasOnline).toBe(false);
      expect(r.shieldsOnline).toBe(false);
      expect(r.weaponsOnline).toBe(false);
      expect(r.targetingOnline).toBe(false);
      expect(r.sensorsOnline).toBe(false);
      expect(r.dronesOnline).toBe(false);
      expect(r.hyperspaceOnline).toBe(false);
      expect(r.stage1RemainingSec).toBe(0);
      expect(r.stage2RemainingSec).toBeCloseTo(7.0 - t, 5);
    }
  });
});

describe('Hyperspace State Machine & Charge Timing', () => {
  it('achieves exact 10.0s charge at power=1.0, health=100 with baseline 8/11 coolant', () => {
    const ship = {
      body: { pos: { x: 100, y: 200, z: 0 }, angle: 0.5, pitch: 0.1 },
      powerMap: {
        hyperspace: 1.0,
        coolantMap: { hyperspace: 8 / 11 },
      },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'charging';

    const dt = 1 / 60;
    // Advance 9.99s (599 steps)
    for (let i = 0; i < 599; i++) {
      const events = updateHyperspaceState(ship, dt);
      expect(events).toEqual([]);
      expect(ship.hyperspace.state).toBe('charging');
    }
    expect(ship.hyperspace.charge).toBeCloseTo(0.99833, 4);

    // 600th step (exact 10.0s)
    const events = updateHyperspaceState(ship, dt);
    expect(events).toEqual(['enter_hyperspace']);
    expect(ship.hyperspace.state).toBe('jumping');
    expect(ship.hyperspace.charge).toBe(1.0);
    expect(ship.hyperspace.originPos).toEqual({ x: 100, y: 200, z: 0 });
    expect(ship.hyperspace.warpHeadingAngle).toBe(0.5);
    expect(ship.hyperspace.warpHeadingPitch).toBe(0.1);
  });

  it('charges at identical 10.0s rate with coolant=1.0', () => {
    const ship = {
      body: { pos: { x: 0, y: 0, z: 0 }, angle: 0 },
      powerMap: {
        hyperspace: 1.0,
        coolantMap: { hyperspace: 1.0 },
      },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'charging';

    for (let i = 0; i < 600; i++) {
      updateHyperspaceState(ship, 1 / 60);
    }
    expect(ship.hyperspace.state).toBe('jumping');
  });

  it('charges slower at power=8/11 (nominal unboosted grid share)', () => {
    const ship = {
      body: { pos: { x: 0, y: 0, z: 0 }, angle: 0 },
      powerMap: {
        hyperspace: 8 / 11,
        coolantMap: { hyperspace: 8 / 11 },
      },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'charging';

    for (let i = 0; i < 600; i++) {
      updateHyperspaceState(ship, 1 / 60);
    }
    // At 10s: charge = 0.1 * (8/11) * 10 = 8/11 ≈ 0.72727
    expect(ship.hyperspace.state).toBe('charging');
    expect(ship.hyperspace.charge).toBeCloseTo(8 / 11, 4);
  });

  it('charges faster at power=1.20 (engineer boosted system)', () => {
    const ship = {
      body: { pos: { x: 0, y: 0, z: 0 }, angle: 0 },
      powerMap: {
        hyperspace: 1.20,
        coolantMap: { hyperspace: 1.20 },
      },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'charging';

    // At 1.2 rate: 10.0 / 1.2 = 8.333s = 500 ticks of 1/60
    for (let i = 0; i < 500; i++) {
      updateHyperspaceState(ship, 1 / 60);
    }
    expect(ship.hyperspace.state).toBe('jumping');
    expect(ship.hyperspace.charge).toBe(1.0);
  });

  it('decays charge at 0.1/s when power=0 or health=0', () => {
    const ship = {
      body: { pos: { x: 0, y: 0, z: 0 } },
      powerMap: { hyperspace: 0, coolantMap: { hyperspace: 1.0 } },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'charging';
    ship.hyperspace.charge = 0.8;

    // Decay for 3.0s
    for (let i = 0; i < 180; i++) {
      updateHyperspaceState(ship, 1 / 60);
    }
    expect(ship.hyperspace.charge).toBeCloseTo(0.5, 4);

    // Health = 0 with power > 0 also decays
    ship.powerMap.hyperspace = 1.0;
    ship.hyperspace.health = 0;
    for (let i = 0; i < 180; i++) {
      updateHyperspaceState(ship, 1 / 60);
    }
    expect(ship.hyperspace.charge).toBeCloseTo(0.2, 4);
  });

  it('transitions through jumping (2.2s), reboot Stage 1 (4.0s), and completes reboot (7.0s)', () => {
    const ship = {
      body: { pos: { x: 0, y: 0, z: 0 }, angle: 0 },
      powerMap: { hyperspace: 1.0, coolantMap: { hyperspace: 1.0 } },
      hyperspace: createHyperspaceState(),
    };
    ship.hyperspace.state = 'jumping';

    // Advance 2.19s of jump
    for (let i = 0; i < 131; i++) {
      const ev = updateHyperspaceState(ship, 1 / 60);
      expect(ev).toEqual([]);
      expect(ship.hyperspace.state).toBe('jumping');
    }

    // Step across 2.2s jump duration
    const exitEv = updateHyperspaceState(ship, 1 / 60);
    expect(exitEv).toEqual(['exit_hyperspace']);
    expect(ship.hyperspace.state).toBe('rebooting');
    expect(ship.hyperspace.charge).toBe(0);
    expect(ship.hyperspace.jumpCount).toBe(1);
    expect(ship.hyperspace.destinationPos).toBeTruthy();

    // Advance 3.98s into reboot (no stage 1 yet)
    for (let i = 0; i < 239; i++) {
      const ev = updateHyperspaceState(ship, 1 / 60);
      expect(ev).toEqual([]);
      expect(ship.hyperspace.state).toBe('rebooting');
    }

    // Cross 4.0s mark (Stage 1 online)
    const stage1Ev = updateHyperspaceState(ship, 1 / 60);
    expect(stage1Ev).toEqual(['reboot_stage1']);
    expect(ship.hyperspace.state).toBe('rebooting');

    // Advance until 6.98s
    for (let i = 0; i < 179; i++) {
      const ev = updateHyperspaceState(ship, 1 / 60);
      expect(ev).toEqual([]);
      expect(ship.hyperspace.state).toBe('rebooting');
    }

    // Cross 7.0s total reboot
    const completeEv = updateHyperspaceState(ship, 1 / 60);
    expect(completeEv).toEqual(['reboot_complete']);
    expect(ship.hyperspace.state).toBe('ready');
    expect(ship.hyperspace.rebootTimer).toBe(0);
  });
});

describe('Empty-Space Jump Target Sampling', () => {
  it('finds valid destination across 40+ seeded sectors in general forward direction (dot > 0)', () => {
    for (let seed = 1001; seed <= 1045; seed++) {
      const sector = generateSector(seed);
      const ship = {
        id: 'alpha',
        body: {
          pos: { x: -500, y: 200, z: 0 },
          angle: (seed % 360) * (Math.PI / 180),
          pitch: 0.15,
          length: 60,
          getForwardVector() {
            const cosP = Math.cos(this.pitch);
            return {
              x: Math.cos(this.angle) * cosP,
              y: Math.sin(this.angle) * cosP,
              z: Math.sin(this.pitch),
            };
          },
        },
      };

      const enemyShip = {
        id: 'omega',
        destroyed: false,
        body: { pos: { x: 500, y: -200, z: 0 }, length: 60 },
      };

      const dest = findHyperspaceDestination(ship, sector, [enemyShip]);
      expect(dest).toBeDefined();

      // Destination must be in empty space
      const isEmpty = isPointEmptySpace(dest, 27, ship.body.pos, sector, [enemyShip], 500);
      expect(isEmpty).toBe(true);

      // Must be within arena boundary
      const arenaDist = Math.hypot(dest.x, dest.y);
      expect(arenaDist).toBeLessThanOrEqual(sector.arenaRadius - 27 - HYPERSPACE_ARENA_EDGE_MARGIN);
      expect(Math.abs(dest.z)).toBeLessThanOrEqual(1500 - HYPERSPACE_Z_EDGE_MARGIN);

      // Forward direction: dot product with forward vector must be positive
      const F = ship.body.getForwardVector();
      const dot = (dest.x - ship.body.pos.x) * F.x + (dest.y - ship.body.pos.y) * F.y + (dest.z - ship.body.pos.z) * F.z;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('handles boundary-facing ship fallback without generating coordinates outside the arena', () => {
    const sector = generateSector(999);
    // Position ship near arena boundary facing outward
    const arenaRadius = sector.arenaRadius || 5250;
    const ship = {
      id: 'pinned_ship',
      body: {
        pos: { x: arenaRadius - 350, y: 0, z: 0 },
        angle: 0, // facing directly East (+X) out of the arena
        pitch: 0,
        length: 60,
        getForwardVector() {
          return { x: 1, y: 0, z: 0 };
        },
      },
    };

    const dest = findHyperspaceDestination(ship, sector, []);
    expect(dest).toBeDefined();
    const arenaDist = Math.hypot(dest.x, dest.y);
    expect(arenaDist).toBeLessThanOrEqual(arenaRadius - 27 - HYPERSPACE_ARENA_EDGE_MARGIN);
    expect(Math.abs(dest.z)).toBeLessThanOrEqual(1500 - HYPERSPACE_Z_EDGE_MARGIN);
  });

  it('avoids falling back to an obstructed origin {0,0,0} when Passes 1-3 fail empty-space checks, selecting best clearance candidate via getCandidateClearanceScore', () => {
    // Saturated asteroid hazard sector where maxArenaDist = 650 - 27 - 220 = 403m,
    // and central + polar asteroids block every point within HYPERSPACE_CLEARANCE_PADDING (+180m)
    // across Passes 1-3 and at {0,0,0}, forcing line 515 fallback to bestCandidate.
    const sector = {
      arenaRadius: 650,
      asteroids: [
        { id: 'origin_rock', pos: { x: 0, y: 0, z: 0 }, radius: 250, destroyed: false },
        { id: 'north_cap', pos: { x: 0, y: 0, z: 700 }, radius: 450, destroyed: false },
        { id: 'south_cap', pos: { x: 0, y: 0, z: -700 }, radius: 450, destroyed: false },
      ],
      debrisFields: [],
      gravityWells: [],
      tetherMines: [],
    };
    const ship = {
      id: 'cornered_ship',
      body: {
        pos: { x: 0, y: 0, z: 0 },
        angle: 0,
        pitch: 0,
        length: 60,
        getForwardVector() {
          return { x: 1, y: 0, z: 0 };
        },
      },
    };

    // Deterministic seeded LCG ensures repeatable Pass 1-3 sampling inside arena
    let seed = 1337;
    const seededRng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    expect(isPointEmptySpace({ x: 0, y: 0, z: 0 }, 27, { x: 0, y: 0, z: 0 }, sector, [], 0)).toBe(false);

    const dest = findHyperspaceDestination(ship, sector, [], seededRng);
    expect(dest).toBeDefined();
    // Must not return obstructed {0,0,0}; must select higher-clearance outer rim candidate
    expect(Math.hypot(dest.x, dest.y, dest.z ?? 0)).toBeGreaterThan(250);
    expect(Math.hypot(dest.x, dest.y)).toBeLessThanOrEqual(650 - 27 - HYPERSPACE_ARENA_EDGE_MARGIN);
  });
});
