import { describe, it, expect, beforeEach } from 'vitest';
import { DroneManager, DRONE_CONFIGS } from '../../src/systems/drones.js';
import { ConduitGrid10x10 } from '../../src/systems/grid-10x10.js';

describe('DroneManager — Repair Drone Management', () => {
  let manager;
  let grid;

  beforeEach(() => {
    manager = new DroneManager('standard_drones');
    grid = new ConduitGrid10x10('frigate');
  });

  describe('1. Drone Module Configuration & Initial State', () => {
    it('initializes standard_drones with 3 drones and correct stats at reactor home (2,3)', () => {
      expect(manager.droneModule).toBe('standard_drones');
      expect(manager.drones.length).toBe(3);
      const d1 = manager.drones[0];
      expect(d1.speed).toBe(2.0);
      expect(d1.repairRate).toBe(1.5);
      expect(d1.tileRepairTime).toBe(2.5);
      expect(d1.state).toBe('idle');
      expect(d1.stalled).toBe(false);
      expect(d1.currentPos.row).toBe(2);
      expect(d1.currentPos.col).toBe(3);
    });

    it('initializes turbo_drones with 2 drones and turbo stats (3.6 speed, 1.5 repairRate)', () => {
      const turboManager = new DroneManager('turbo_drones');
      expect(turboManager.droneModule).toBe('turbo_drones');
      expect(turboManager.drones.length).toBe(2);
      const d1 = turboManager.drones[0];
      expect(d1.speed).toBe(3.6);
      expect(d1.repairRate).toBe(1.5);
      expect(d1.tileRepairTime).toBe(1.25);
    });

    it('falls back to standard_drones on unknown module name', () => {
      const fallback = new DroneManager('unknown_drones');
      expect(fallback.droneModule).toBe('standard_drones');
      expect(fallback.drones.length).toBe(3);
    });
  });

  describe('2. Critical Reactor Online Constraint & Stalling', () => {
    it('all drones immediately stall when reactorOnline is false or 0', () => {
      manager.assignToTile(1, 4, 5);
      expect(manager.drones[0].state).toBe('moving');

      // Update with reactor offline (false / 0)
      manager.update(0.5, false, grid);
      expect(manager.drones[0].stalled).toBe(true);
      expect(manager.drones[1].stalled).toBe(true);
      expect(manager.drones[2].stalled).toBe(true);

      // Drone did NOT advance position
      expect(manager.drones[0].currentPos.row).toBe(2);
      expect(manager.drones[0].currentPos.col).toBe(3);
    });

    it('drones resume movement and repair when reactorOnline is true', () => {
      manager.assignToTile(1, 4, 5);

      // Stalled with reactor offline
      manager.update(0.5, 0, grid);
      expect(manager.drones[0].stalled).toBe(true);

      // Power restored!
      manager.update(0.5, true, grid);
      expect(manager.drones[0].stalled).toBe(false);

      // Drone has moved closer towards target (4, 5) from (2, 3)
      expect(manager.drones[0].currentPos.row).toBeGreaterThan(2);
      expect(manager.drones[0].currentPos.col).toBeGreaterThan(3);
    });

    it('pauses active tile repairs when reactor goes offline and resumes when restored', () => {
      // Place drone directly at broken tile
      grid.damageTile(4, 5);
      manager.assignToTile(1, 4, 5);
      manager.drones[0].currentPos = { row: 4, col: 5, x: 4, y: 5 };
      manager.drones[0].state = 'repairing';
      manager.drones[0].progress = 1.0; // 1.0s of 2.5s done

      // Reactor offline: stalled
      manager.update(0.5, false, grid);
      expect(manager.drones[0].stalled).toBe(true);
      expect(manager.drones[0].progress).toBe(1.0); // No progress made!
      expect(grid.getTile(4, 5).status).toBe('broken');

      // Reactor restored: progresses
      manager.update(0.5, true, grid);
      expect(manager.drones[0].stalled).toBe(false);
      expect(manager.drones[0].progress).toBeCloseTo(1.5, 2);
    });
  });

  describe('3. Broken Grid Tile Repair Execution', () => {
    it('drone travels to broken tile, repairs it, and returns to idle', () => {
      grid.damageTile(2, 3); // At reactor for instant arrival
      manager.assignToTile(1, 2, 3);

      // Update by dt = 0.01 to arrive
      manager.update(0.01, true, grid);
      expect(manager.drones[0].state).toBe('repairing');

      // Update through tileRepairTime (2.5 seconds)
      manager.update(2.5, true, grid);

      // Tile is restored to nominal!
      expect(grid.getTile(2, 3).status).toBe('nominal');
      expect(manager.drones[0].state).toBe('idle');
      expect(manager.drones[0].progress).toBe(0);
    });

    it('assignToTile automatically picks first idle drone if droneId is null', () => {
      manager.assignToTile(null, 1, 1);
      expect(manager.drones[0].state).toBe('moving');

      manager.assignToTile(null, 2, 2);
      expect(manager.drones[1].state).toBe('moving');

      manager.assignToTile(null, 3, 3);
      expect(manager.drones[2].state).toBe('moving');

      // All 3 busy, 4th assignment returns false
      expect(manager.assignToTile(null, 4, 4)).toBe(false);
    });
  });

  describe('4. Ship Subsystem Repair Execution', () => {
    it('repairs damaged ship subsystem object up to 100 HP', () => {
      const shipSubsystems = {
        bowPort: { health: 60 },
        weapons_laser: { health: 40 },
      };

      manager.assignToSubsystem(1, 'bowPort', grid);
      const d1 = manager.drones[0];
      // Target anchor mapped to rcs_thrusters
      expect(d1.targetPos).toEqual({ row: 0, col: 7.5, x: 0, y: 7.5 });
      expect(d1.state).toBe('moving');

      // While moving, subsystem health does not increase
      manager.update(0.5, true, grid, shipSubsystems);
      expect(d1.state).toBe('moving');
      expect(shipSubsystems.bowPort.health).toBe(60);

      // Place at target for immediate repair
      d1.state = 'repairing';
      d1.currentPos = { ...d1.targetPos };

      // Subsystem repairRate is 1.5 %/s; 2 seconds = +3.0 HP (63.0 HP)
      manager.update(2.0, true, grid, shipSubsystems);
      expect(shipSubsystems.bowPort.health).toBeCloseTo(63.0, 1);
      expect(d1.state).toBe('repairing');

      // Another 25.0s of repair caps at 100 HP max and completes (returns to idle)
      manager.update(25.0, true, grid, shipSubsystems);
      expect(shipSubsystems.bowPort.health).toBe(100);
      expect(d1.state).toBe('idle');
    });

    it('repairs numeric subsystem map up to 100', () => {
      const shipSubsystems = {
        weapons_railgun: 50,
      };

      manager.assignToSubsystem(1, 'weapons_railgun', grid);
      const d1 = manager.drones[0];
      expect(d1.targetPos).toEqual({ row: 7.5, col: 9, x: 7.5, y: 9 });
      d1.state = 'repairing';

      manager.update(2.0, true, grid, shipSubsystems);
      expect(shipSubsystems.weapons_railgun).toBeCloseTo(53.0, 1);
    });
  });

  describe('5. Turbo Drones vs Standard Drones Performance', () => {
    it('turbo drones travel 1.8x faster and repair tiles 2x faster, while both repair subsystems at 1.5%/s', () => {
      const standard = new DroneManager('standard_drones');
      const turbo = new DroneManager('turbo_drones');

      expect(turbo.drones[0].speed / standard.drones[0].speed).toBeCloseTo(1.8, 2);
      expect(standard.drones[0].tileRepairTime / turbo.drones[0].tileRepairTime).toBe(2.0);
      expect(standard.drones[0].repairRate).toBe(1.5);
      expect(turbo.drones[0].repairRate).toBe(1.5);
    });
  });

  describe('6. Drone Recall and Serialization', () => {
    it('recallDrone commands drone to return home and transitions to idle on arrival', () => {
      manager.assignToTile(1, 0, 0);
      manager.drones[0].currentPos = { row: 0, col: 0, x: 0, y: 0 };

      manager.recallDrone(1);
      expect(manager.drones[0].state).toBe('returning');
      expect(manager.drones[0].targetPos).toEqual(manager.homePos);

      // Simulate travel back to home (dist ~ 3.6 tiles, at 2 tiles/s ~ 1.8s)
      manager.update(3.0, true, grid);
      expect(manager.drones[0].state).toBe('idle');
      expect(manager.drones[0].currentPos.row).toBe(manager.homePos.row);
      expect(manager.drones[0].currentPos.col).toBe(manager.homePos.col);
    });

    it('recallDrone without arguments recalls all drones', () => {
      manager.assignToTile(1, 1, 1);
      manager.assignToTile(2, 2, 2);
      manager.recallDrone();
      expect(manager.drones[0].state).toBe('returning');
      expect(manager.drones[1].state).toBe('returning');
      expect(manager.drones[2].state).toBe('returning');
    });

    it('Phase 12: drone recalled near homePos (dist < 0.5) stays in returning with recallTimer > 0 for brief transit before idle', () => {
      // Drone very close to homePos (2,3), e.g. at (2.1, 3.1) -> dist ≈ 0.141 < 0.5
      manager.drones[0].currentPos = { row: 2.1, col: 3.1, x: 2.1, y: 3.1 };
      manager.drones[0].state = 'moving';

      manager.recallDrone(1);
      const drone = manager.drones[0];
      expect(drone.state).toBe('returning');
      expect(drone.recallTimer).toBeCloseTo(0.45, 2);

      // On a small step (0.1s), step >= dist, snaps to homePos but recallTimer is still > 0 so it stays returning
      manager.update(0.1, true, grid);
      expect(drone.state).toBe('returning');
      expect(drone.currentPos.row).toBe(manager.homePos.row);
      expect(drone.currentPos.col).toBe(manager.homePos.col);
      expect(drone.recallTimer).toBeCloseTo(0.35, 2);

      // Advance past remaining recallTimer (0.4s) -> now transitions to idle
      manager.update(0.4, true, grid);
      expect(drone.state).toBe('idle');
      expect(drone.recallTimer).toBe(0);
    });

    it('serialize produces valid snapshot of drone fleet', () => {
      const snap = manager.serialize();
      expect(snap.droneModule).toBe('standard_drones');
      expect(snap.homePos).toBeDefined();
      expect(snap.drones.length).toBe(3);
      expect(snap.drones[0].id).toBe(1);
      expect(snap.drones[0].speed).toBe(2.0);
    });
  });
});
