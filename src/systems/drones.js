/**
 * BROADSIDE HYPERION — Repair Drone Management
 *
 * Implements autonomous repair drones for grid conduits and ship subsystems.
 * Supports standard_drones and turbo_drones drydock loadouts.
 * Requires active reactor power (reactorOnline):
 * If !reactorOnline, all drones immediately stall and neither move nor repair!
 */

export const SUBSYSTEM_REPAIR_RATE = 1.5;

export const DRONE_CONFIGS = {
  standard_drones: {
    count: 3,
    speed: 2.0,           // tiles / s
    repairRate: SUBSYSTEM_REPAIR_RATE,     // HP / s for ship subsystems (1.5%/sec)
    tileRepairTime: 2.5,  // seconds to repair a broken grid tile
  },
  turbo_drones: {
    count: 2,
    speed: 3.6,           // tiles / s
    repairRate: SUBSYSTEM_REPAIR_RATE,     // HP / s for ship subsystems (1.5%/sec)
    tileRepairTime: 1.25, // seconds to repair a broken grid tile
  },
};

export class DroneManager {
  /**
   * @param {string} droneModule - 'standard_drones' | 'turbo_drones'
   * @param {object} [options]
   * @param {object} [options.homePos] - { row, col, x, y } (defaults to Reactor at row 2, col 3)
   */
  constructor(droneModule = 'standard_drones', options = {}) {
    this.droneModule = DRONE_CONFIGS[droneModule] ? droneModule : 'standard_drones';
    const config = DRONE_CONFIGS[this.droneModule];

    this.homePos = options.homePos
      ? { ...options.homePos }
      : { row: 2, col: 3, x: 2, y: 3 };

    this.drones = Array.from({ length: config.count }, (_, i) => ({
      id: i + 1,
      type: this.droneModule,
      state: 'idle', // 'idle' | 'moving' | 'repairing' | 'returning'
      targetType: null, // 'tile' | 'subsystem' | null
      target: null, // { row, col } or subsystemKey
      currentPos: { row: this.homePos.row, col: this.homePos.col, x: this.homePos.row, y: this.homePos.col },
      targetPos: null,
      progress: 0,
      stalled: false,
      speed: config.speed,
      repairRate: config.repairRate,
      tileRepairTime: config.tileRepairTime,
      recallTimer: 0,
      get pos() {
        return this.currentPos;
      },
      get targetSystem() {
        return this.targetType === 'subsystem' ? this.target : null;
      },
    }));
  }

  /**
   * Find drone by ID
   */
  findDrone(droneId) {
    return this.drones.find(d => d.id === droneId || String(d.id) === String(droneId)) || null;
  }

  /**
   * Find first available idle drone
   */
  findFirstIdleDrone() {
    return this.drones.find(d => d.state === 'idle') || null;
  }

  /**
   * Assign drone to travel to and repair a broken grid tile
   */
  assignToTile(droneId, row, col) {
    const drone = (droneId != null) ? this.findDrone(droneId) : this.findFirstIdleDrone();
    if (!drone) return false;

    drone.state = 'moving';
    drone.targetType = 'tile';
    drone.target = { row, col };
    drone.targetPos = { row, col, x: row, y: col };
    drone.progress = 0;
    drone.stalled = false;
    drone.recallTimer = 0;
    return true;
  }

  /**
   * Assign drone to repair a damaged ship subsystem.
   * Resolves target anchor from grid.subsystemLocations, mapping physical thruster banks to 'rcs_thrusters'
   * and 'mainDrive' to 'main_drive'.
   */
  assignToSubsystem(droneId, subsystemKey, grid = null) {
    const drone = (droneId != null) ? this.findDrone(droneId) : this.findFirstIdleDrone();
    if (!drone) return false;

    drone.state = 'moving';
    drone.targetType = 'subsystem';
    drone.target = subsystemKey;

    let targetPos = null;
    let targetKey = subsystemKey;
    if (['bowPort', 'bowStarboard', 'sternPort', 'sternStarboard', 'dorsalRoll', 'ventralRoll'].includes(subsystemKey)) {
      targetKey = 'rcs_thrusters';
    } else if (subsystemKey === 'mainDrive') {
      targetKey = 'main_drive';
    }

    if (grid && grid.subsystemLocations && grid.subsystemLocations[targetKey]) {
      const loc = grid.subsystemLocations[targetKey];
      targetPos = { row: loc.row, col: loc.col, x: loc.row, y: loc.col };
    } else {
      targetPos = { ...this.homePos };
    }

    drone.targetPos = targetPos;
    drone.progress = 0;
    drone.stalled = false;
    drone.recallTimer = 0;
    return true;
  }

  /**
   * Recall a specific drone (or all drones) to the Reactor home position
   */
  recallDrone(droneId = null) {
    const recallSingle = (drone) => {
      drone.state = 'returning';
      drone.targetType = null;
      drone.target = null;
      drone.targetPos = { ...this.homePos };
      drone.progress = 0;

      const dr = drone.targetPos.row - drone.currentPos.row;
      const dc = drone.targetPos.col - drone.currentPos.col;
      const dist = Math.hypot(dr, dc);
      if (dist < 0.5) {
        drone.recallTimer = 0.45;
      } else {
        drone.recallTimer = 0;
      }
    };

    if (droneId != null) {
      const drone = this.findDrone(droneId);
      if (!drone) return false;
      recallSingle(drone);
      return true;
    }

    // Recall all drones
    for (const d of this.drones) {
      recallSingle(d);
    }
    return true;
  }

  /**
   * Authoritative simulation update step.
   * If !reactorOnline (false, 0, or null), all drones immediately stall and neither move nor repair.
   *
   * @param {number} dt - delta time in seconds
   * @param {boolean|number} reactorOnline - whether the ship's reactor is actively delivering power
   * @param {object} [grid] - ConduitGrid10x10 instance
   * @param {object} [shipSubsystems] - Subsystem health states map
   */
  update(dt, reactorOnline, grid = null, shipSubsystems = null) {
    if (reactorOnline === false || reactorOnline === 0 || reactorOnline == null) {
      for (const drone of this.drones) {
        drone.stalled = true;
      }
      return;
    }

    for (const drone of this.drones) {
      drone.stalled = false;

      if (drone.state === 'idle') {
        continue;
      }

      // Movement handling for moving and returning states
      if (drone.state === 'moving' || drone.state === 'returning') {
        if (!drone.targetPos) {
          drone.state = 'idle';
          continue;
        }

        const dr = drone.targetPos.row - drone.currentPos.row;
        const dc = drone.targetPos.col - drone.currentPos.col;
        const dist = Math.hypot(dr, dc);
        const step = drone.speed * dt;

        if (step >= dist || dist < 0.0001) {
          drone.currentPos.row = drone.targetPos.row;
          drone.currentPos.col = drone.targetPos.col;
          drone.currentPos.x = drone.targetPos.row;
          drone.currentPos.y = drone.targetPos.col;

          if (drone.state === 'returning') {
            if (drone.recallTimer > 0) {
              drone.recallTimer -= dt;
              if (drone.recallTimer <= 0) {
                drone.recallTimer = 0;
                drone.state = 'idle';
                drone.targetPos = null;
              }
            } else {
              drone.state = 'idle';
              drone.targetPos = null;
            }
          } else {
            drone.state = 'repairing';
            drone.progress = 0;
          }
        } else {
          drone.currentPos.row += (dr / dist) * step;
          drone.currentPos.col += (dc / dist) * step;
          drone.currentPos.x = drone.currentPos.row;
          drone.currentPos.y = drone.currentPos.col;
          if (drone.state === 'returning' && drone.recallTimer > 0) {
            drone.recallTimer = Math.max(0, drone.recallTimer - dt);
          }
        }
      }

      // Active repair handling
      if (drone.state === 'repairing') {
        if (drone.targetType === 'tile') {
          drone.progress += dt;
          if (drone.progress >= drone.tileRepairTime) {
            if (grid && drone.target) {
              grid.repairTile(drone.target.row, drone.target.col);
            }
            drone.state = 'idle';
            drone.target = null;
            drone.targetType = null;
            drone.targetPos = null;
            drone.progress = 0;
          }
        } else if (drone.targetType === 'subsystem') {
          if (shipSubsystems && drone.target) {
            const key = drone.target;
            const sub = shipSubsystems[key];
            if (sub && typeof sub === 'object' && typeof sub.health === 'number') {
              sub.health = Math.min(100, sub.health + drone.repairRate * dt);
              if (sub.health >= 100) {
                drone.state = 'idle';
                drone.target = null;
                drone.targetType = null;
                drone.targetPos = null;
              }
            } else if (typeof sub === 'number') {
              shipSubsystems[key] = Math.min(100, sub + drone.repairRate * dt);
              if (shipSubsystems[key] >= 100) {
                drone.state = 'idle';
                drone.target = null;
                drone.targetType = null;
                drone.targetPos = null;
              }
            } else {
              drone.progress += dt;
              if (drone.progress >= drone.tileRepairTime) {
                drone.state = 'idle';
                drone.target = null;
                drone.targetType = null;
                drone.targetPos = null;
              }
            }
          } else {
            drone.progress += dt;
            if (drone.progress >= drone.tileRepairTime) {
              drone.state = 'idle';
              drone.target = null;
              drone.targetType = null;
              drone.targetPos = null;
            }
          }
        }
      }
    }
  }

  /**
   * Serialize drones state for snapshot broadcasting
   */
  serialize() {
    return {
      droneModule: this.droneModule,
      homePos: { ...this.homePos },
      drones: this.drones.map(d => ({
        id: d.id,
        type: d.type,
        state: d.state,
        targetType: d.targetType,
        target: d.target,
        targetSystem: d.targetType === 'subsystem' ? d.target : null,
        currentPos: { ...d.currentPos },
        pos: { ...d.currentPos },
        targetPos: d.targetPos ? { ...d.targetPos } : null,
        progress: d.progress,
        stalled: d.stalled,
        speed: d.speed,
        repairRate: d.repairRate,
        tileRepairTime: d.tileRepairTime,
        recallTimer: d.recallTimer || 0,
      })),
    };
  }
}
