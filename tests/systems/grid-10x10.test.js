import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConduitGrid10x10,
  GRID_ROWS,
  GRID_COLS,
  TOTAL_EXTERNAL_SYSTEMS,
  BASELINE_SHARE_RATIO,
  BASE_RESOURCE_POOL,
  CAPACITOR_SURGE_POOL,
  BOOST_TARGET_RATIO,
  NOMINAL_CAP_RATIO,
  allocateResourcePool,
  EXTERNAL_SYSTEMS,
  SUBSYSTEM_NODES,
  CONDUIT_TYPES,
  DEFAULT_GRID_LAYOUT,
  getTilePorts,
} from '../../src/systems/grid-10x10.js';

describe('ConduitGrid10x10 — Core Dual-Resource 10x10 Grid & Dynamic Redistribution', () => {
  let grid;

  beforeEach(() => {
    grid = new ConduitGrid10x10('frigate');
  });

  describe('1. Grid Dimensions & Tile Matrix (Strict 10x10 = 100 tiles)', () => {
    it('has exactly 10 rows and 10 columns', () => {
      expect(GRID_ROWS).toBe(10);
      expect(GRID_COLS).toBe(10);
      expect(grid.tiles.length).toBe(10);
      for (let r = 0; r < 10; r++) {
        expect(grid.tiles[r].length).toBe(10);
      }
    });

    it('all 100 tiles have valid initial properties', () => {
      let count = 0;
      for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          const tile = grid.getTile(r, c);
          expect(tile).not.toBeNull();
          expect(tile.row).toBe(r);
          expect(tile.col).toBe(c);
          expect(tile.status).toBe('nominal');
          expect(tile.empTimer).toBe(0);
          expect(typeof tile.type).toBe('string');
          count++;
        }
      }
      expect(count).toBe(100);
    });

    it('returns null for out-of-bounds coordinates', () => {
      expect(grid.getTile(-1, 0)).toBeNull();
      expect(grid.getTile(0, 10)).toBeNull();
      expect(grid.getTile(10, 5)).toBeNull();
      expect(grid.setTile(-1, 0, {})).toBeNull();
    });

    it('defines exact 11 perimeter external systems around the border', () => {
      expect(TOTAL_EXTERNAL_SYSTEMS).toBe(11);
      expect(EXTERNAL_SYSTEMS.length).toBe(11);
      expect(SUBSYSTEM_NODES.length).toBe(11);

      const expectedKeys = [
        'sas_computer',
        'shields_fore',
        'rcs_thrusters',
        'shields_aft',
        'main_drive',
        'weapons_torpedo',
        'shields_port',
        'weapons_laser',
        'hyperspace',
        'shields_starboard',
        'weapons_railgun',
      ];
      for (const k of expectedKeys) {
        expect(SUBSYSTEM_NODES).toContain(k);
        const sys = EXTERNAL_SYSTEMS.find(s => s.key === k);
        expect(sys).toBeDefined();
        expect(['N', 'S', 'E', 'W']).toContain(sys.side);
        expect(sys.cells.length).toBe(2);
        expect(sys.droneAnchor).toBeDefined();
      }

      const hyperspaceSys = EXTERNAL_SYSTEMS.find(s => s.key === 'hyperspace');
      expect(hyperspaceSys.side).toBe('E');
      expect(hyperspaceSys.cells).toEqual([[1, 9], [2, 9]]);
      expect(hyperspaceSys.droneAnchor).toEqual({ row: 1.5, col: 9 });
    });

    it('places reactor at (2,3) and coolant at (2,6)', () => {
      expect(grid.reactorPos).toEqual({ row: 2, col: 3 });
      expect(grid.coolantPos).toEqual({ row: 2, col: 6 });

      const reactorTile = grid.getTile(2, 3);
      expect(reactorTile.type).toBe('reactor');

      const coolantTile = grid.getTile(2, 6);
      expect(coolantTile.type).toBe('coolant');
    });

    it('correctly reports open directional ports via getTilePorts', () => {
      expect(getTilePorts({ type: 'straight', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'S']);
      expect(getTilePorts({ type: 'straight', orientation: 1, status: 'nominal', empTimer: 0 })).toEqual(['E', 'W']);

      expect(getTilePorts({ type: 'elbow', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E']);
      expect(getTilePorts({ type: 'elbow', orientation: 1, status: 'nominal', empTimer: 0 })).toEqual(['E', 'S']);
      expect(getTilePorts({ type: 'elbow', orientation: 2, status: 'nominal', empTimer: 0 })).toEqual(['S', 'W']);
      expect(getTilePorts({ type: 'elbow', orientation: 3, status: 'nominal', empTimer: 0 })).toEqual(['W', 'N']);

      expect(getTilePorts({ type: 't_split', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E', 'S']);
      expect(getTilePorts({ type: 't_split', orientation: 1, status: 'nominal', empTimer: 0 })).toEqual(['E', 'S', 'W']);
      expect(getTilePorts({ type: 't_split', orientation: 2, status: 'nominal', empTimer: 0 })).toEqual(['S', 'W', 'N']);
      expect(getTilePorts({ type: 't_split', orientation: 3, status: 'nominal', empTimer: 0 })).toEqual(['W', 'N', 'E']);

      expect(getTilePorts({ type: 'cross_bridge', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E', 'S', 'W']);
      expect(getTilePorts({ type: 'reactor', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E', 'S', 'W']);
      expect(getTilePorts({ type: 'coolant', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E', 'S', 'W']);
      expect(getTilePorts({ type: 'capacitor', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual(['N', 'E', 'S', 'W']);

      expect(getTilePorts({ type: 'empty', orientation: 0, status: 'nominal', empTimer: 0 })).toEqual([]);
      expect(getTilePorts({ type: 'straight', orientation: 0, status: 'broken', empTimer: 0 })).toEqual([]);
      expect(getTilePorts({ type: 'straight', orientation: 0, status: 'nominal', empTimer: 5.0 })).toEqual([]);
    });
  });

  describe('2. Turn 0 Dual-Path BFS Reachability & Baseline Share (8/11)', () => {
    it('both Reactor (2,3) and Coolant (2,6) reach 11/11 external systems on turn 0 without crossing each other', () => {
      const powerRes = grid.traceResourcePaths(grid.reactorPos, grid.coolantPos);
      expect(powerRes.reached.size).toBe(11);
      for (const k of SUBSYSTEM_NODES) {
        expect(powerRes.reached.has(k)).toBe(true);
        expect(powerRes.paths[k]).toBeDefined();
        expect(powerRes.paths[k].cells.length).toBeGreaterThan(1);
      }

      const coolantRes = grid.traceResourcePaths(grid.coolantPos, grid.reactorPos);
      expect(coolantRes.reached.size).toBe(11);
      for (const k of SUBSYSTEM_NODES) {
        expect(coolantRes.reached.has(k)).toBe(true);
        expect(coolantRes.paths[k]).toBeDefined();
        expect(coolantRes.paths[k].cells.length).toBeGreaterThan(1);
      }
    });

    it('verifies diagram layout: Reactor (2,3) reaches all 11 systems without hitting Coolant (2,6), Coolant (2,6) reaches all 11 systems without hitting Reactor (2,3), and capacitor isolation at (3,4) & (4,4) holds on turn 0', () => {
      // 1. Reactor BFS reachability: all 11 systems reached, forbidden coolant node never traversed
      const powerRes = grid.traceResourcePaths(grid.reactorPos, grid.coolantPos);
      expect(powerRes.reached.size).toBe(11);
      expect(powerRes.reachableTiles.has('2,6')).toBe(false);
      for (const k of SUBSYSTEM_NODES) {
        expect(powerRes.reached.has(k)).toBe(true);
      }

      // 2. Coolant BFS reachability: all 11 systems reached, forbidden reactor node never traversed
      const coolantRes = grid.traceResourcePaths(grid.coolantPos, grid.reactorPos);
      expect(coolantRes.reached.size).toBe(11);
      expect(coolantRes.reachableTiles.has('2,3')).toBe(false);
      for (const k of SUBSYSTEM_NODES) {
        expect(coolantRes.reached.has(k)).toBe(true);
      }

      // 3. Capacitor isolation at (3,4) and (4,4)
      const capGrid = new ConduitGrid10x10('frigate', { engineer: 'capacitor_batteries' });
      const cap34 = capGrid.getTile(3, 4);
      const cap44 = capGrid.getTile(4, 4);
      expect(cap34.type).toBe('capacitor');
      expect(cap44.type).toBe('capacitor');

      // East/West neighbors do not connect horizontally into capacitors
      // (3,3) E3 has ports [W, N] -> no East port
      expect(capGrid.getTilePorts(capGrid.getTile(3, 3))).not.toContain('E');
      // (3,5) S0 has ports [N, S] -> no West port
      expect(capGrid.getTilePorts(capGrid.getTile(3, 5))).not.toContain('W');
      // (4,3) S0 has ports [N, S] -> no East port
      expect(capGrid.getTilePorts(capGrid.getTile(4, 3))).not.toContain('E');
      // (4,5) S0 has ports [N, S] -> no West port
      expect(capGrid.getTilePorts(capGrid.getTile(4, 5))).not.toContain('W');
    });

    it('solves default power and coolant flow with baseline share (8/11 per system)', () => {
      const powerMap = grid.solvePowerFlow();

      expect(powerMap.reactorOnline).toBe(true);
      expect(powerMap.coolantOnline).toBe(true);
      expect(powerMap.powerConnectedCount).toBe(11);
      expect(powerMap.coolantConnectedCount).toBe(11);
      expect(powerMap.totalPower).toBe(BASE_RESOURCE_POOL); // 8.0
      expect(powerMap.totalCoolant).toBe(BASE_RESOURCE_POOL); // 8.0

      // Baseline share ratio = 8.0 / 11
      const baselineShare = 8.0 / 11;
      expect(powerMap.powerPerSystem).toBeCloseTo(baselineShare, 5);
      expect(powerMap.coolantPerSystem).toBeCloseTo(baselineShare, 5);

      for (const k of SUBSYSTEM_NODES) {
        expect(powerMap[k]).toBeCloseTo(baselineShare, 5);
        expect(powerMap.coolantMap[k]).toBeCloseTo(baselineShare, 5);
      }

      // Reconstructed paths exist for all 11 systems
      expect(Object.keys(powerMap.powerPaths).length).toBe(11);
      expect(Object.keys(powerMap.coolantPaths).length).toBe(11);
    });
  });

  describe('3. Dynamic Redistribution on Conduit Disconnection', () => {
    it('redistributes power up to 100% (1.0) when external systems are disconnected', () => {
      // Disconnect rcs_thrusters by breaking border cells [0, 7] and [0, 8]
      grid.damageTile(0, 7);
      grid.damageTile(0, 8);

      const powerMap = grid.solvePowerFlow();
      // Now 10 or fewer systems reached
      expect(powerMap.powerConnectedCount).toBeLessThan(11);
      expect(powerMap.rcs_thrusters).toBe(0);

      // Remaining connected systems receive redistributed power: min(1.0, 8.0 / k)
      const expected = Math.min(1.0, 8.0 / powerMap.powerConnectedCount);
      expect(powerMap.shields_fore).toBeCloseTo(expected, 5);
      expect(powerMap.weapons_laser).toBeCloseTo(expected, 5);
      expect(powerMap.powerPerSystem).toBeCloseTo(expected, 5);
    });

    it('caps power per system at 1.0 even if only 5 systems are connected (8.0 / 5 = 1.6 -> 1.0)', () => {
      // Isolate down to 5 systems by breaking border conduits
      // Break shields_aft, main_drive, weapons_torpedo, shields_port, weapons_laser
      grid.damageTile(9, 2);
      grid.damageTile(9, 3);
      grid.damageTile(9, 6);
      grid.damageTile(9, 7);
      grid.damageTile(1, 0);
      grid.damageTile(2, 0);
      grid.damageTile(4, 0);
      grid.damageTile(5, 0);
      grid.damageTile(7, 0);
      grid.damageTile(8, 0);

      const powerMap = grid.solvePowerFlow();
      expect(powerMap.powerConnectedCount).toBeLessThanOrEqual(5);
      expect(powerMap.powerPerSystem).toBe(1.0); // Capped at 1.0!
    });

    it('zeros all power if reactor is broken or EMP-disabled', () => {
      grid.damageTile(2, 3);
      const powerMap = grid.solvePowerFlow();

      expect(powerMap.reactorOnline).toBe(false);
      expect(powerMap.totalPower).toBe(0);
      expect(powerMap.powerPerSystem).toBe(0);
      for (const k of SUBSYSTEM_NODES) {
        expect(powerMap[k]).toBe(0);
      }
      // Coolant remains unaffected
      expect(powerMap.coolantOnline).toBe(true);
      expect(powerMap.coolantPerSystem).toBeCloseTo(8.0 / 11, 5);
    });

    it('zeros all coolant if coolant is broken or EMP-disabled', () => {
      grid.damageTile(2, 6);
      const powerMap = grid.solvePowerFlow();

      expect(powerMap.coolantOnline).toBe(false);
      expect(powerMap.totalCoolant).toBe(0);
      expect(powerMap.coolantPerSystem).toBe(0);
      for (const k of SUBSYSTEM_NODES) {
        expect(powerMap.coolantMap[k]).toBe(0);
      }
      // Reactor power remains unaffected
      expect(powerMap.reactorOnline).toBe(true);
      expect(powerMap.powerPerSystem).toBeCloseTo(8.0 / 11, 5);
    });
  });

  describe('4. Capacitor Batteries Module & Surge Discharge', () => {
    it('spawns 2 capacitors at (3,4) and (4,4) with clean N-S isolation', () => {
      const capGrid = new ConduitGrid10x10('frigate', { engineer: 'capacitor_batteries' });
      const cap1 = capGrid.getTile(3, 4);
      const cap2 = capGrid.getTile(4, 4);

      expect(cap1.type).toBe('capacitor');
      expect(cap2.type).toBe('capacitor');
      expect(cap1.charge).toBe(20);
      expect(cap2.charge).toBe(20);

      // Verify N-S conduction and no cross-conduction to col 3 or col 5
      const ports1 = capGrid.getTilePorts(cap1);
      expect(ports1).toEqual(['N', 'E', 'S', 'W']);

      // West neighbor (3,3) is E3 [W, N], has NO East port!
      const westTile1 = capGrid.getTile(3, 3);
      expect(capGrid.getTilePorts(westTile1)).not.toContain('E');

      // East neighbor (3,5) is S0 [N, S], has NO West port!
      const eastTile1 = capGrid.getTile(3, 5);
      expect(capGrid.getTilePorts(eastTile1)).not.toContain('W');
    });

    it('discharging capacitor adds +2.0 surge power boosting 11 systems to (10/11)', () => {
      const capGrid = new ConduitGrid10x10('frigate', { engineer: 'capacitor_batteries' });

      // Before discharge: 8.0 power pool -> 8/11 per system
      let powerMap = capGrid.solvePowerFlow();
      expect(powerMap.totalPower).toBe(8.0);
      expect(powerMap.powerPerSystem).toBeCloseTo(8.0 / 11, 5);

      // Discharge capacitor at [3, 4]
      const discharged = capGrid.dischargeCapacitor(3, 4);
      expect(discharged).toBe(true);

      // Total power becomes 8.0 + 2.0 = 10.0!
      // min(1.0, 10.0 / 11) = 10/11 power to all 11 systems!
      powerMap = capGrid.solvePowerFlow(undefined, 0);
      expect(powerMap.totalPower).toBe(10.0);
      expect(powerMap.powerPerSystem).toBeCloseTo(10.0 / 11, 5);
      for (const k of SUBSYSTEM_NODES) {
        expect(powerMap[k]).toBeCloseTo(10.0 / 11, 5);
      }

      // Advance 10 seconds (still active)
      powerMap = capGrid.solvePowerFlow(undefined, 10.0);
      expect(powerMap.totalPower).toBe(10.0);

      // Advance past 12 seconds (discharge expires)
      powerMap = capGrid.solvePowerFlow(undefined, 3.0);
      expect(powerMap.totalPower).toBe(8.0);
      expect(powerMap.powerPerSystem).toBeCloseTo(8.0 / 11, 5);
      expect(capGrid.getTile(3, 4).discharging).toBe(false);
    });

    it('cannot discharge broken or EMP-disabled capacitor', () => {
      const capGrid = new ConduitGrid10x10('frigate', { engineer: 'capacitor_batteries' });
      capGrid.damageTile(3, 4);
      expect(capGrid.dischargeCapacitor(3, 4)).toBe(false);
    });
  });

  describe('5. Tile Rotation, Damage, EMP, and Misaligned Tile Repair', () => {
    it('rotates rotatable pipes clockwise and rejects rotation on reactor, coolant, capacitor, empty, or broken tiles', () => {
      // Row 0 Col 0 is elbow (E3)
      const elbow = grid.getTile(0, 0);
      expect(elbow.type).toBe('elbow');
      expect(elbow.orientation).toBe(3);
      expect(grid.rotateTile(0, 0)).toBe(true);
      expect(elbow.orientation).toBe(0);

      // Straight tile
      grid.setTile(1, 1, { type: 'straight', orientation: 0 });
      expect(grid.rotateTile(1, 1)).toBe(true);
      expect(grid.getTile(1, 1).orientation).toBe(1);
      expect(grid.rotateTile(1, 1)).toBe(true);
      expect(grid.getTile(1, 1).orientation).toBe(0);

      // Rejects non-rotatable tiles
      expect(grid.rotateTile(grid.reactorPos.row, grid.reactorPos.col)).toBe(false);
      expect(grid.rotateTile(grid.coolantPos.row, grid.coolantPos.col)).toBe(false);

      // Rejects empty
      grid.setTile(3, 9, { type: 'empty' });
      expect(grid.rotateTile(3, 9)).toBe(false);

      // Rejects broken
      grid.damageTile(0, 0);
      expect(grid.rotateTile(0, 0)).toBe(false);
    });

    it('damageRandomTiles damages specified count of valid non-source tiles', () => {
      const damaged = grid.damageRandomTiles(3);
      expect(damaged.length).toBe(3);
      for (const d of damaged) {
        expect(grid.getTile(d.row, d.col).status).toBe('broken');
        expect(grid.getTile(d.row, d.col).type).not.toBe('reactor');
        expect(grid.getTile(d.row, d.col).type).not.toBe('coolant');
        expect(grid.getTile(d.row, d.col).type).not.toBe('empty');
      }
    });

    it('applyEmpBlast disables 3x3 region for specified duration and decays over dt', () => {
      const affected = grid.applyEmpBlast(4, 5, 8.0);
      expect(affected.length).toBe(9);

      grid.solvePowerFlow(undefined, 4.0);
      expect(grid.getTile(4, 5).empTimer).toBeCloseTo(4.0, 2);

      grid.solvePowerFlow(undefined, 4.5);
      expect(grid.getTile(4, 5).empTimer).toBe(0);
    });

    it('repairOneMisalignedTile restores a pipe rotated by Ion Storm back to DEFAULT_GRID_LAYOUT', () => {
      // Find a rotatable tile at default orientation
      const tile = grid.getTile(0, 0);
      expect(tile.orientation).toBe(3);

      // Rotate it away from default
      grid.rotateTile(0, 0);
      expect(tile.orientation).toBe(0);

      // repairOneMisalignedTile restores it
      const repaired = grid.repairOneMisalignedTile();
      expect(repaired).toBe(true);
      expect(tile.orientation).toBe(3);

      // When all are aligned, returns false
      expect(grid.repairOneMisalignedTile()).toBe(false);
    });
  });

  describe('6. Serialization', () => {
    it('serialize outputs complete snapshot matching Phase 9 architecture', () => {
      grid.solvePowerFlow();
      const snapshot = grid.serialize();

      expect(snapshot.rows).toBe(10);
      expect(snapshot.cols).toBe(10);
      expect(snapshot.hullClass).toBe('frigate');
      expect(snapshot.reactorPos).toEqual({ row: 2, col: 3 });
      expect(snapshot.coolantPos).toEqual({ row: 2, col: 6 });
      expect(snapshot.externalSystems.length).toBe(11);
      expect(snapshot.tiles.length).toBe(10);
      expect(snapshot.tiles[0].length).toBe(10);
      expect(snapshot.lastPowerMap).toBeDefined();
      expect(snapshot.lastPowerMap.powerConnectedCount).toBe(11);
      expect(snapshot.lastPowerMap.coolantConnectedCount).toBe(11);
      expect(snapshot.boostedSystems).toEqual([]);
    });
  });

  describe('7. Subsystem Boost Redistribution (Phase 13 Slice 1)', () => {
    describe('allocateResourcePool pure helper', () => {
      it('exports canonical boost constants', () => {
        expect(BOOST_TARGET_RATIO).toBe(1.2);
        expect(NOMINAL_CAP_RATIO).toBe(1.0);
      });

      it('allocates baseline unboosted shares when no systems are boosted', () => {
        const reached = new Set(SUBSYSTEM_NODES);
        const res = allocateResourcePool(reached, 8.0, new Set());

        expect(res.boostedConnectedCount).toBe(0);
        expect(res.unboostedConnectedCount).toBe(11);
        expect(res.boostedShare).toBe(0);
        expect(res.unboostedShare).toBeCloseTo(8.0 / 11, 5);
        for (const k of SUBSYSTEM_NODES) {
          expect(res.allocations[k]).toBeCloseTo(8.0 / 11, 5);
        }
      });

      it('handles single system boost (1.20 on boosted, 6.8 / 10 = 0.68 on unboosted, exact sum === 8.0)', () => {
        const reached = new Set(SUBSYSTEM_NODES);
        const boosted = new Set(['main_drive']);
        const res = allocateResourcePool(reached, 8.0, boosted);

        expect(res.boostedConnectedCount).toBe(1);
        expect(res.unboostedConnectedCount).toBe(10);
        expect(res.boostedShare).toBe(1.2);
        expect(res.unboostedShare).toBeCloseTo(0.68, 5);

        expect(res.allocations.main_drive).toBe(1.2);
        for (const k of SUBSYSTEM_NODES) {
          if (k !== 'main_drive') {
            expect(res.allocations[k]).toBeCloseTo(0.68, 5);
          }
        }

        const sum = SUBSYSTEM_NODES.reduce((acc, k) => acc + res.allocations[k], 0);
        expect(sum).toBeCloseTo(8.0, 5);
      });

      it('handles multiple systems boosted (2 and 6 systems at 1.20, sum === 8.0)', () => {
        const reached = new Set(SUBSYSTEM_NODES);

        // 2 systems boosted
        const boosted2 = new Set(['main_drive', 'weapons_railgun']);
        const res2 = allocateResourcePool(reached, 8.0, boosted2);
        expect(res2.boostedConnectedCount).toBe(2);
        expect(res2.unboostedConnectedCount).toBe(9);
        expect(res2.boostedShare).toBe(1.2);
        expect(res2.unboostedShare).toBeCloseTo((8.0 - 2.4) / 9, 5); // 5.6 / 9
        expect(res2.allocations.main_drive).toBe(1.2);
        expect(res2.allocations.weapons_railgun).toBe(1.2);
        expect(res2.allocations.sas_computer).toBeCloseTo((8.0 - 2.4) / 9, 5);
        const sum2 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res2.allocations[k], 0);
        expect(sum2).toBeCloseTo(8.0, 5);

        // 6 systems boosted
        const boosted6 = new Set([
          'main_drive',
          'weapons_railgun',
          'weapons_laser',
          'weapons_torpedo',
          'shields_fore',
          'shields_aft',
        ]);
        const res6 = allocateResourcePool(reached, 8.0, boosted6);
        expect(res6.boostedConnectedCount).toBe(6);
        expect(res6.unboostedConnectedCount).toBe(5);
        expect(res6.boostedShare).toBe(1.2);
        expect(res6.unboostedShare).toBeCloseTo((8.0 - 7.2) / 5, 5); // 0.8 / 5 = 0.16
        const sum6 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res6.allocations[k], 0);
        expect(sum6).toBeCloseTo(8.0, 5);
      });

      it('strictly conserves finite pool during over-saturation (7, 8, 10, 11 boosted on 8.0 pool -> 8.0 / b, unboosted 0)', () => {
        const reached = new Set(SUBSYSTEM_NODES);

        // 7 boosted systems: 7 * 1.2 = 8.4 > 8.0 -> saturates pool!
        const boosted7 = new Set(SUBSYSTEM_NODES.slice(0, 7));
        const res7 = allocateResourcePool(reached, 8.0, boosted7);
        expect(res7.boostedConnectedCount).toBe(7);
        expect(res7.unboostedConnectedCount).toBe(4);
        expect(res7.boostedShare).toBeCloseTo(8.0 / 7, 5);
        expect(res7.unboostedShare).toBe(0);
        const sum7 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res7.allocations[k], 0);
        expect(sum7).toBeCloseTo(8.0, 5);

        // 8 boosted systems
        const boosted8 = new Set(SUBSYSTEM_NODES.slice(0, 8));
        const res8 = allocateResourcePool(reached, 8.0, boosted8);
        expect(res8.boostedConnectedCount).toBe(8);
        expect(res8.unboostedConnectedCount).toBe(3);
        expect(res8.boostedShare).toBeCloseTo(8.0 / 8, 5); // 1.0
        expect(res8.unboostedShare).toBe(0);
        const sum8 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res8.allocations[k], 0);
        expect(sum8).toBeCloseTo(8.0, 5);

        // 10 boosted systems
        const boosted10 = new Set(SUBSYSTEM_NODES.slice(0, 10));
        const res10 = allocateResourcePool(reached, 8.0, boosted10);
        expect(res10.boostedConnectedCount).toBe(10);
        expect(res10.unboostedConnectedCount).toBe(1);
        expect(res10.boostedShare).toBeCloseTo(8.0 / 10, 5); // 0.8
        expect(res10.unboostedShare).toBe(0);
        const sum10 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res10.allocations[k], 0);
        expect(sum10).toBeCloseTo(8.0, 5);

        // 11 boosted systems
        const boosted11 = new Set(SUBSYSTEM_NODES);
        const res11 = allocateResourcePool(reached, 8.0, boosted11);
        expect(res11.boostedConnectedCount).toBe(11);
        expect(res11.unboostedConnectedCount).toBe(0);
        expect(res11.boostedShare).toBeCloseTo(8.0 / 11, 5);
        expect(res11.unboostedShare).toBe(0);
        const sum11 = SUBSYSTEM_NODES.reduce((acc, k) => acc + res11.allocations[k], 0);
        expect(sum11).toBeCloseTo(8.0, 5);
      });

      it('allocates 0 to all when pool <= 0 or when no systems are reached', () => {
        const reached = new Set(SUBSYSTEM_NODES);
        const resZeroPool = allocateResourcePool(reached, 0, new Set(['main_drive']));
        expect(resZeroPool.boostedShare).toBe(0);
        expect(resZeroPool.unboostedShare).toBe(0);
        for (const k of SUBSYSTEM_NODES) {
          expect(resZeroPool.allocations[k]).toBe(0);
        }

        const resEmptyReached = allocateResourcePool(new Set(), 8.0, new Set(['main_drive']));
        expect(resEmptyReached.boostedConnectedCount).toBe(0);
        expect(resEmptyReached.unboostedConnectedCount).toBe(0);
        expect(resEmptyReached.boostedShare).toBe(0);
        expect(resEmptyReached.unboostedShare).toBe(0);
      });

      it('supports capacitor surge (totalPool = 10.0) with multi-boost', () => {
        const reached = new Set(SUBSYSTEM_NODES);
        const boosted8 = new Set(SUBSYSTEM_NODES.slice(0, 8));
        const res = allocateResourcePool(reached, 10.0, boosted8);

        // 8 * 1.2 = 9.6 <= 10.0
        expect(res.boostedConnectedCount).toBe(8);
        expect(res.unboostedConnectedCount).toBe(3);
        expect(res.boostedShare).toBe(1.2);
        expect(res.unboostedShare).toBeCloseTo((10.0 - 9.6) / 3, 5); // 0.40 / 3
        const sum = SUBSYSTEM_NODES.reduce((acc, k) => acc + res.allocations[k], 0);
        expect(sum).toBeCloseTo(10.0, 5);
      });

      it('ensures disconnected systems receive 0 and do NOT consume pool budget', () => {
        // Only 5 systems connected, 1 of which is boosted
        const reached = new Set(['main_drive', 'weapons_railgun', 'weapons_laser', 'shields_fore', 'shields_aft']);
        // boostedSystems contains 'main_drive' AND disconnected 'rcs_thrusters'
        const boosted = new Set(['main_drive', 'rcs_thrusters']);

        const res = allocateResourcePool(reached, 8.0, boosted);
        // rcs_thrusters is disconnected -> must not count as boosted connected!
        expect(res.boostedConnectedCount).toBe(1);
        expect(res.unboostedConnectedCount).toBe(4);
        expect(res.allocations.rcs_thrusters).toBe(0);
        expect(res.allocations.main_drive).toBe(1.2);

        // Remaining 4 unboosted connected systems share (8.0 - 1.2) = 6.8 / 4 = 1.7 -> capped at nominalCap 1.0!
        expect(res.allocations.weapons_railgun).toBe(1.0);
        expect(res.allocations.weapons_laser).toBe(1.0);
        expect(res.allocations.shields_fore).toBe(1.0);
        expect(res.allocations.shields_aft).toBe(1.0);
      });
    });

    describe('ConduitGrid10x10 boost management methods', () => {
      it('initializes with an empty boostedSystems Set', () => {
        expect(grid.boostedSystems).toBeInstanceOf(Set);
        expect(grid.boostedSystems.size).toBe(0);
      });

      it('setSystemBoost sets and clears boost state and validates subsystem keys', () => {
        expect(grid.setSystemBoost('bogus', true)).toBe(false);
        expect(grid.setSystemBoost('bogus', false)).toBe(false);

        expect(grid.setSystemBoost('main_drive', true)).toBe(true);
        expect(grid.isSystemBoosted('main_drive')).toBe(true);
        expect(grid.boostedSystems.has('main_drive')).toBe(true);

        expect(grid.setSystemBoost('main_drive', false)).toBe(true);
        expect(grid.isSystemBoosted('main_drive')).toBe(false);
        expect(grid.boostedSystems.has('main_drive')).toBe(false);
      });

      it('toggleSystemBoost toggles boost membership and rejects invalid keys', () => {
        expect(grid.toggleSystemBoost('invalid_key')).toBe(false);

        expect(grid.toggleSystemBoost('weapons_railgun')).toBe(true);
        expect(grid.isSystemBoosted('weapons_railgun')).toBe(true);

        expect(grid.toggleSystemBoost('weapons_railgun')).toBe(true);
        expect(grid.isSystemBoosted('weapons_railgun')).toBe(false);
      });

      it('clearBoosts removes all active boosts', () => {
        grid.setSystemBoost('main_drive', true);
        grid.setSystemBoost('weapons_railgun', true);
        grid.setSystemBoost('shields_fore', true);
        expect(grid.boostedSystems.size).toBe(3);

        grid.clearBoosts();
        expect(grid.boostedSystems.size).toBe(0);
        expect(grid.isSystemBoosted('main_drive')).toBe(false);
      });

      it('initGrid resets boostedSystems back to empty Set', () => {
        grid.setSystemBoost('sas_computer', true);
        expect(grid.boostedSystems.size).toBe(1);

        grid.initGrid();
        expect(grid.boostedSystems.size).toBe(0);
        expect(grid.isSystemBoosted('sas_computer')).toBe(false);
      });
    });

    describe('ConduitGrid10x10 solvePowerFlow with boost redistribution', () => {
      it('solves power and coolant flow with single system boost', () => {
        grid.setSystemBoost('main_drive', true);
        const powerMap = grid.solvePowerFlow();

        expect(powerMap.main_drive).toBe(1.2);
        expect(powerMap.coolantMap.main_drive).toBe(1.2);

        for (const k of SUBSYSTEM_NODES) {
          if (k !== 'main_drive') {
            expect(powerMap[k]).toBeCloseTo(0.68, 5);
            expect(powerMap.coolantMap[k]).toBeCloseTo(0.68, 5);
          }
        }

        expect(powerMap.boostedSystems).toEqual(['main_drive']);
        expect(powerMap.boostedPowerPerSystem).toBe(1.2);
        expect(powerMap.boostedCoolantPerSystem).toBe(1.2);
        expect(powerMap.unboostedPowerPerSystem).toBeCloseTo(0.68, 5);
        expect(powerMap.unboostedCoolantPerSystem).toBeCloseTo(0.68, 5);
        expect(powerMap.powerPerSystem).toBeCloseTo(0.68, 5);
        expect(powerMap.coolantPerSystem).toBeCloseTo(0.68, 5);

        // Tile allocatedPower on power-conducting tile reflects unboosted baseline flow
        const tile = grid.getTile(2, 3);
        expect(tile.powerFlow).toBe(true);
        expect(tile.allocatedPower).toBeCloseTo(0.68, 5);
      });

      it('sets powerPerSystem to boostedShare when all connected systems are boosted', () => {
        for (const k of SUBSYSTEM_NODES) {
          grid.setSystemBoost(k, true);
        }
        const powerMap = grid.solvePowerFlow();

        expect(powerMap.boostedSystems.length).toBe(11);
        expect(powerMap.powerPerSystem).toBeCloseTo(8.0 / 11, 5);
        expect(powerMap.coolantPerSystem).toBeCloseTo(8.0 / 11, 5);
        expect(powerMap.boostedPowerPerSystem).toBeCloseTo(8.0 / 11, 5);
        expect(powerMap.unboostedPowerPerSystem).toBe(0);

        for (const k of SUBSYSTEM_NODES) {
          expect(powerMap[k]).toBeCloseTo(8.0 / 11, 5);
        }
      });

      it('handles asymmetric disconnection (boosted system with broken Power path and intact Coolant path)', () => {
        // Damaging tile (1, 3) severs Power path to rcs_thrusters while leaving Coolant path intact
        grid.damageTile(1, 3);
        grid.setSystemBoost('rcs_thrusters', true);

        const powerMap = grid.solvePowerFlow();

        // Power path to rcs_thrusters is broken: receives 0 Power and does not consume Power budget!
        expect(powerMap.rcs_thrusters).toBe(0);
        expect(powerMap.boostedPowerPerSystem).toBe(0); // 0 connected boosted systems for Power

        // Power pool is shared among the surviving connected systems (which are unboosted)
        expect(powerMap.powerConnectedCount).toBeLessThan(11);
        const expectedPowerPerSys = Math.min(1.0, 8.0 / powerMap.powerConnectedCount);
        expect(powerMap.sas_computer).toBeCloseTo(expectedPowerPerSys, 5);

        // Coolant path to rcs_thrusters is INTACT: receives 1.20 Coolant!
        expect(powerMap.coolantMap.rcs_thrusters).toBe(1.2);
        expect(powerMap.boostedCoolantPerSystem).toBe(1.2);

        // Unboosted systems with coolant receive their fair share of remaining coolant
        const expectedCoolantUnboosted = (8.0 - 1.2) / (powerMap.coolantConnectedCount - 1);
        expect(powerMap.coolantMap.shields_fore).toBeCloseTo(expectedCoolantUnboosted, 5);
      });

      it('includes boostedSystems in serialization snapshot', () => {
        grid.setSystemBoost('weapons_laser', true);
        grid.setSystemBoost('shields_aft', true);
        grid.solvePowerFlow();

        const snapshot = grid.serialize();
        expect(snapshot.boostedSystems).toContain('weapons_laser');
        expect(snapshot.boostedSystems).toContain('shields_aft');
        expect(snapshot.boostedSystems.length).toBe(2);
      });
    });
  });
});
