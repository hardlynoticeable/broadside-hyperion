/**
 * BROADSIDE HYPERION — 10x10 Engineer Conduit Grid (Dual-Resource Dual-Path Architecture)
 *
 * Implements a strictly 10x10 rectangular matrix (100 tiles, rows 0..9, cols 0..9)
 * managing independent Power and Coolant distribution from internal source nodes
 * (Reactor at (2,3), Coolant at (2,6)) to 11 perimeter external starship subsystems
 * via BFS shortest-path graph traversals with dynamic baseline power/coolant redistribution
 * (8/11 ≈ 72.7% full-load share, 100% share when <= 8 systems connected).
 */

export const GRID_ROWS = 10;
export const GRID_COLS = 10;

export const TOTAL_EXTERNAL_SYSTEMS = 11;
export const BASELINE_SHARE_RATIO = 0.8;
export const BASE_RESOURCE_POOL = 8.0;
export const CAPACITOR_SURGE_POOL = 2.0;
export const BOOST_TARGET_RATIO = 1.2;
export const NOMINAL_CAP_RATIO = 1.0;

/**
 * Exact 11 perimeter systems situated around the outside of the 10x10 border.
 */
export const EXTERNAL_SYSTEMS = [
  { key: 'sas_computer', label: 'SAS COMPUTER', side: 'N', cells: [[0, 1], [0, 2]], droneAnchor: { row: 0, col: 1.5 } },
  { key: 'shields_fore', label: 'SHIELD FORE', side: 'N', cells: [[0, 4], [0, 5]], droneAnchor: { row: 0, col: 4.5 } },
  { key: 'rcs_thrusters', label: 'RCS THRUSTERS', side: 'N', cells: [[0, 7], [0, 8]], droneAnchor: { row: 0, col: 7.5 } },
  { key: 'shields_aft', label: 'SHIELD AFT', side: 'S', cells: [[9, 2], [9, 3]], droneAnchor: { row: 9, col: 2.5 } },
  { key: 'main_drive', label: 'MAIN DRIVE', side: 'S', cells: [[9, 6], [9, 7]], droneAnchor: { row: 9, col: 6.5 } },
  { key: 'weapons_torpedo', label: 'WPN TORPEDO', side: 'W', cells: [[1, 0], [2, 0]], droneAnchor: { row: 1.5, col: 0 } },
  { key: 'shields_port', label: 'SHIELD PORT', side: 'W', cells: [[4, 0], [5, 0]], droneAnchor: { row: 4.5, col: 0 } },
  { key: 'weapons_laser', label: 'WPN LASER', side: 'W', cells: [[7, 0], [8, 0]], droneAnchor: { row: 7.5, col: 0 } },
  { key: 'hyperspace', label: 'HYPERSPACE', side: 'E', cells: [[1, 9], [2, 9]], droneAnchor: { row: 1.5, col: 9 } },
  { key: 'shields_starboard', label: 'SHIELD STBD', side: 'E', cells: [[4, 9], [5, 9]], droneAnchor: { row: 4.5, col: 9 } },
  { key: 'weapons_railgun', label: 'WPN RAILGUN', side: 'E', cells: [[7, 9], [8, 9]], droneAnchor: { row: 7.5, col: 9 } },
];

export const SUBSYSTEM_NODES = EXTERNAL_SYSTEMS.map(s => s.key);

export const CONDUIT_TYPES = [
  'straight',
  'elbow',
  't_split',
  'cross_bridge',
];

export const HULL_REACTOR_CAPS = {
  corvette: 8.0,
  frigate: 8.0,
  dreadnought: 8.0,
};

export const PORT_DIRECTIONS = ['N', 'E', 'S', 'W'];

export const OPPOSITE_DIR = {
  N: 'S',
  S: 'N',
  E: 'W',
  W: 'E',
};

export const DIR_OFFSETS = {
  N: { dr: -1, dc: 0 },
  S: { dr: 1, dc: 0 },
  E: { dr: 0, dc: 1 },
  W: { dr: 0, dc: -1 },
};

/**
 * Verified 10x10 default matrix from blueprint.
 * Both Reactor (2,3) and Coolant (2,6) reach 11/11 external systems on turn 0 without crossing each other.
 */
export const DEFAULT_GRID_LAYOUT = [
  ['E3', 'S0', 'S0', 'T0', 'T1', 'T2', 'S0', 'E0', 'T1', 'E2'],
  ['E1', 'T2', 'T0', 'S1', 'E3', 'E0', 'S1', 'T3', 'T2', 'E0'],
  ['E3', 'E0', 'T3', 'REC', 'E2', 'E1', 'COL', 'T2', 'S0', 'S0'],
  ['E1', 'T1', 'S1', 'E3', 'S0', 'S0', 'E0', 'S1', 'T3', 'E2'],
  ['E3', 'X',  'E0', 'S0', 'S0', 'S0', 'S0', 'E3', 'X',  'E0'],
  ['E1', 'T2', 'E0', 'E0', 'T0', 'T2', 'E3', 'E3', 'T1', 'T3'],
  ['S0', 'X',  'E2', 'T3', 'S0', 'S0', 'T1', 'E0', 'X',  'S0'],
  ['T1', 'X',  'E0', 'T1', 'T2', 'T0', 'S0', 'S0', 'S0', 'E3'],
  ['E2', 'X',  'E0', 'E1', 'S0', 'S0', 'T3', 'S1', 'X',  'E1'],
  ['E0', 'T1', 'T1', 'S1', 'E3', 'E0', 'S1', 'T1', 'T3', 'E3'],
];

/**
 * Parses shorthand string cell code into { type, orientation }
 * @param {string} code
 * @returns {{ type: string, orientation: number }}
 */
export function parseLayoutCell(code) {
  if (!code || code === '.') {
    return { type: 'empty', orientation: 0 };
  }
  if (code === 'REC') {
    return { type: 'reactor', orientation: 0 };
  }
  if (code === 'COL') {
    return { type: 'coolant', orientation: 0 };
  }
  if (code === 'X') {
    return { type: 'cross_bridge', orientation: 0 };
  }
  const typeChar = code[0];
  const ori = parseInt(code.slice(1), 10) || 0;
  if (typeChar === 'S') return { type: 'straight', orientation: ori };
  if (typeChar === 'E') return { type: 'elbow', orientation: ori };
  if (typeChar === 'T') return { type: 't_split', orientation: ori };
  return { type: 'empty', orientation: 0 };
}

/**
 * Returns directional ports available on a tile based on type and orientation.
 * Broken tiles and EMP-disabled tiles return [] (blocking all conduction).
 * @param {object} tile
 * @returns {Array<string>} list of open port directions ['N', 'E', 'S', 'W']
 */
export function getTilePorts(tile) {
  if (!tile || !tile.type || tile.type === 'empty') return [];
  if (tile.status === 'broken' || (tile.empTimer && tile.empTimer > 0)) return [];

  switch (tile.type) {
    case 'straight':
      return (tile.orientation % 2 === 0) ? ['N', 'S'] : ['E', 'W'];
    case 'elbow': {
      const ori = ((tile.orientation % 4) + 4) % 4;
      if (ori === 0) return ['N', 'E'];
      if (ori === 1) return ['E', 'S'];
      if (ori === 2) return ['S', 'W'];
      return ['W', 'N'];
    }
    case 't_split': {
      const ori = ((tile.orientation % 4) + 4) % 4;
      if (ori === 0) return ['N', 'E', 'S'];
      if (ori === 1) return ['E', 'S', 'W'];
      if (ori === 2) return ['S', 'W', 'N'];
      return ['W', 'N', 'E'];
    }
    case 'cross_bridge':
    case 'reactor':
    case 'coolant':
    case 'capacitor':
      return ['N', 'E', 'S', 'W'];
    default:
      return [];
  }
}

/**
 * Pure allocation helper to distribute a finite resource pool across connected perimeter systems,
 * prioritizing boosted systems up to boostTarget (1.20) and distributing remaining pool among unboosted systems.
 * Disconnected systems receive 0 and do not consume pool budget.
 *
 * @param {Set<string>|null} reachedSet - Set of connected subsystem keys
 * @param {number} totalPool - Available resource pool (e.g. 8.0)
 * @param {Set<string>|Array<string>|null} boostedSystems - Boosted subsystem keys
 * @param {number} [boostTarget=BOOST_TARGET_RATIO] - Target allocation for boosted systems (1.2)
 * @param {number} [nominalCap=NOMINAL_CAP_RATIO] - Maximum nominal cap for unboosted systems (1.0)
 * @returns {{
 *   allocations: Object<string, number>,
 *   boostedShare: number,
 *   unboostedShare: number,
 *   boostedConnectedCount: number,
 *   unboostedConnectedCount: number
 * }}
 */
export function allocateResourcePool(
  reachedSet,
  totalPool,
  boostedSystems,
  boostTarget = BOOST_TARGET_RATIO,
  nominalCap = NOMINAL_CAP_RATIO
) {
  const isConnected = (key) => Boolean(reachedSet && reachedSet.has(key));
  const isBoosted = (key) => {
    if (!boostedSystems) return false;
    if (boostedSystems instanceof Set || typeof boostedSystems.has === 'function') {
      return boostedSystems.has(key);
    }
    if (Array.isArray(boostedSystems)) {
      return boostedSystems.includes(key);
    }
    return false;
  };

  let b = 0;
  let u = 0;
  for (const key of SUBSYSTEM_NODES) {
    if (isConnected(key)) {
      if (isBoosted(key)) {
        b++;
      } else {
        u++;
      }
    }
  }

  let boostedShare = 0;
  let unboostedShare = 0;

  if (totalPool <= 0 || b + u === 0) {
    boostedShare = 0;
    unboostedShare = 0;
  } else if (b === 0) {
    boostedShare = 0;
    unboostedShare = Math.min(nominalCap, totalPool / u);
  } else if (b * boostTarget <= totalPool) {
    boostedShare = boostTarget;
    const remPool = Math.max(0, totalPool - b * boostTarget);
    unboostedShare = u > 0 ? Math.min(nominalCap, remPool / u) : 0;
  } else {
    boostedShare = Math.min(boostTarget, totalPool / b);
    unboostedShare = 0;
  }

  const allocations = {};
  for (const key of SUBSYSTEM_NODES) {
    if (!isConnected(key)) {
      allocations[key] = 0;
    } else if (isBoosted(key)) {
      allocations[key] = boostedShare;
    } else {
      allocations[key] = unboostedShare;
    }
  }

  return {
    allocations,
    boostedShare,
    unboostedShare,
    boostedConnectedCount: b,
    unboostedConnectedCount: u,
  };
}

export class ConduitGrid10x10 {
  /**
   * @param {string} hullClass - 'corvette' | 'frigate' | 'dreadnought'
   * @param {object} drydockModules - e.g. { engineer: 'standard_drones' | 'turbo_drones' | 'capacitor_batteries' }
   */
  constructor(hullClass = 'frigate', drydockModules = {}) {
    this.hullClass = hullClass;
    this.drydockModules = { ...drydockModules };
    this.defaultReactorCap = BASE_RESOURCE_POOL;

    this.reactorPos = { row: 2, col: 3 };
    this.coolantPos = { row: 2, col: 6 };

    this.subsystemLocations = {};
    for (const sys of EXTERNAL_SYSTEMS) {
      this.subsystemLocations[sys.key] = {
        row: sys.droneAnchor.row,
        col: sys.droneAnchor.col,
      };
    }

    this.boostedSystems = new Set();
    this.lastPowerMap = null;
    this.initGrid();
  }

  /**
   * Initialize 10x10 grid with default layout and optional capacitor drydock modules
   */
  initGrid() {
    if (this.boostedSystems) {
      this.boostedSystems.clear();
    } else {
      this.boostedSystems = new Set();
    }

    this.tiles = Array.from({ length: GRID_ROWS }, (_, r) =>
      Array.from({ length: GRID_COLS }, (_, c) => {
        const parsed = parseLayoutCell(DEFAULT_GRID_LAYOUT[r][c]);
        return {
          id: `${r}_${c}`,
          row: r,
          col: c,
          type: parsed.type,
          orientation: parsed.orientation,
          status: 'nominal',
          empTimer: 0,
          allocatedPower: 0,
          powerFlow: false,
          coolantFlow: false,
          charge: 0,
          maxCharge: 20,
          discharging: false,
          dischargeTimer: 0,
        };
      })
    );

    // Explicitly confirm reactor and coolant placements
    this.setTile(this.reactorPos.row, this.reactorPos.col, {
      type: 'reactor',
      orientation: 0,
    });
    this.setTile(this.coolantPos.row, this.coolantPos.col, {
      type: 'coolant',
      orientation: 0,
    });

    // Capacitor batteries module: replace slots [3, 4] and [4, 4] with capacitors
    if (this.drydockModules?.engineer === 'capacitor_batteries') {
      this.setTile(3, 4, {
        type: 'capacitor',
        orientation: 0,
        charge: 20,
        maxCharge: 20,
      });
      this.setTile(4, 4, {
        type: 'capacitor',
        orientation: 0,
        charge: 20,
        maxCharge: 20,
      });
    }
  }

  /**
   * Get tile by coordinates
   */
  getTile(row, col) {
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
      return null;
    }
    return this.tiles[row][col];
  }

  /**
   * Set or update tile at coordinates
   */
  setTile(row, col, tileData) {
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
      return null;
    }
    const current = this.tiles[row][col];
    this.tiles[row][col] = {
      ...current,
      ...tileData,
      row,
      col,
    };
    return this.tiles[row][col];
  }

  /**
   * Rotate a rotatable conduit tile 90 degrees clockwise.
   * Rejects rotation on reactor, coolant, capacitor, empty, or broken tiles.
   */
  rotateTile(row, col) {
    const tile = this.getTile(row, col);
    if (!tile) return false;
    if (tile.status === 'broken') return false;
    if (tile.type === 'reactor' || tile.type === 'coolant' || tile.type === 'capacitor' || tile.type === 'empty' || tile.type === 'cross_bridge') {
      return false;
    }

    if (tile.type === 'straight') {
      tile.orientation = (tile.orientation + 1) % 2;
      return true;
    }
    if (tile.type === 'elbow' || tile.type === 't_split') {
      tile.orientation = (tile.orientation + 1) % 4;
      return true;
    }
    return false;
  }

  /**
   * Discharge capacitor on demand for +2.0 temporary power surge for 12 seconds
   */
  dischargeCapacitor(row, col) {
    const tile = this.getTile(row, col);
    if (!tile || tile.type !== 'capacitor') return false;
    if (tile.status === 'broken' || tile.empTimer > 0) return false;
    if (tile.charge <= 0 && !tile.discharging) return false;

    tile.discharging = true;
    tile.dischargeTimer = 12.0;
    return true;
  }

  /**
   * Set boost state for an external subsystem.
   * @param {string} systemKey
   * @param {boolean} [enabled=true]
   * @returns {boolean} True if systemKey is valid, false otherwise
   */
  setSystemBoost(systemKey, enabled = true) {
    if (!SUBSYSTEM_NODES.includes(systemKey)) {
      return false;
    }
    if (enabled) {
      this.boostedSystems.add(systemKey);
    } else {
      this.boostedSystems.delete(systemKey);
    }
    return true;
  }

  /**
   * Toggle boost state for an external subsystem.
   * @param {string} systemKey
   * @returns {boolean} True if systemKey is valid, false otherwise
   */
  toggleSystemBoost(systemKey) {
    if (!SUBSYSTEM_NODES.includes(systemKey)) {
      return false;
    }
    if (this.boostedSystems.has(systemKey)) {
      this.boostedSystems.delete(systemKey);
    } else {
      this.boostedSystems.add(systemKey);
    }
    return true;
  }

  /**
   * Check if a subsystem is currently boosted.
   * @param {string} systemKey
   * @returns {boolean}
   */
  isSystemBoosted(systemKey) {
    return this.boostedSystems.has(systemKey);
  }

  /**
   * Clear all active system boosts.
   */
  clearBoosts() {
    this.boostedSystems.clear();
  }

  /**
   * Damage tile: broken tiles block all conduction and cannot be rotated
   */
  damageTile(row, col) {
    const tile = this.getTile(row, col);
    if (!tile) return false;
    tile.status = 'broken';
    return true;
  }

  /**
   * Repair tile back to nominal status
   */
  repairTile(row, col) {
    const tile = this.getTile(row, col);
    if (!tile) return false;
    tile.status = 'nominal';
    return true;
  }

  /**
   * Damage random eligible non-source tiles (excludes empty, reactor, coolant, and already broken)
   */
  damageRandomTiles(count = 1, rng = Math.random) {
    const candidates = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const t = this.tiles[r][c];
        if (t.type !== 'empty' && t.type !== 'reactor' && t.type !== 'coolant' && t.status !== 'broken') {
          candidates.push(t);
        }
      }
    }
    const damaged = [];
    const toDamage = Math.min(count, candidates.length);
    for (let i = 0; i < toDamage; i++) {
      const idx = Math.min(candidates.length - 1, Math.max(0, Math.floor(rng() * candidates.length)));
      const chosen = candidates.splice(idx, 1)[0];
      if (chosen) {
        chosen.status = 'broken';
        damaged.push({ row: chosen.row, col: chosen.col });
      }
    }
    return damaged;
  }

  /**
   * Ion Storm Surge: randomly rotates 1 or 2 rotatable unbroken conduit tiles by 90 degrees
   */
  applyIonStormSurge(rng = Math.random) {
    const rotatables = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const t = this.tiles[r][c];
        if (['straight', 'elbow', 't_split'].includes(t.type) && t.status !== 'broken') {
          rotatables.push(t);
        }
      }
    }
    if (rotatables.length === 0) return [];

    const numToRotate = Math.min(rotatables.length, rng() > 0.5 ? 2 : 1);
    const rotated = [];
    for (let i = 0; i < numToRotate; i++) {
      const idx = Math.floor(rng() * rotatables.length);
      const chosen = rotatables.splice(idx, 1)[0];
      this.rotateTile(chosen.row, chosen.col);
      rotated.push({ row: chosen.row, col: chosen.col });
    }
    return rotated;
  }

  /**
   * Finds a tile whose orientation !== DEFAULT_GRID_LAYOUT[r][c].orientation (only rotatable pipes)
   * and restores its default orientation, returning true, else false.
   */
  repairOneMisalignedTile() {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const defaultParsed = parseLayoutCell(DEFAULT_GRID_LAYOUT[r][c]);
        if (['straight', 'elbow', 't_split'].includes(defaultParsed.type)) {
          const tile = this.tiles[r][c];
          if (tile.type === defaultParsed.type && tile.orientation !== defaultParsed.orientation) {
            tile.orientation = defaultParsed.orientation;
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * EMP Blast: disables conduction in a 3x3 region for `duration` seconds
   */
  applyEmpBlast(centerRow, centerCol, duration = 8.0) {
    const affected = [];
    for (let r = Math.max(0, centerRow - 1); r <= Math.min(GRID_ROWS - 1, centerRow + 1); r++) {
      for (let c = Math.max(0, centerCol - 1); c <= Math.min(GRID_COLS - 1, centerCol + 1); c++) {
        const tile = this.tiles[r][c];
        tile.empTimer = Math.max(tile.empTimer, duration);
        affected.push(tile);
      }
    }
    return affected;
  }

  /**
   * Helper returning port directions available on a tile
   */
  getTilePorts(tile) {
    return getTilePorts(tile);
  }

  /**
   * Traces resource flow from sourcePos using BFS, never visiting forbiddenPos.
   * Discovers reached external systems and reconstructs shortest path cells.
   *
   * @param {{ row: number, col: number }} sourcePos
   * @param {{ row: number, col: number }} forbiddenPos
   * @returns {{ reached: Set<string>, reachableTiles: Set<string>, paths: object }}
   */
  traceResourcePaths(sourcePos, forbiddenPos) {
    const reached = new Set();
    const reachableTiles = new Set();
    const paths = {};

    const startTile = this.getTile(sourcePos.row, sourcePos.col);
    if (!startTile || startTile.status !== 'nominal' || (startTile.empTimer && startTile.empTimer > 0)) {
      return { reached, reachableTiles, paths };
    }

    const queue = [{ row: sourcePos.row, col: sourcePos.col }];
    const visited = new Set([`${sourcePos.row},${sourcePos.col}`]);
    const parentMap = new Map(); // key -> { row, col }

    while (queue.length > 0) {
      const curr = queue.shift();
      const currKey = `${curr.row},${curr.col}`;
      reachableTiles.add(currKey);

      const tile = this.getTile(curr.row, curr.col);
      const ports = this.getTilePorts(tile);

      // Check perimeter external border connections
      for (const sys of EXTERNAL_SYSTEMS) {
        if (!reached.has(sys.key) && ports.includes(sys.side)) {
          const isBorderCell = sys.cells.some(([cr, cc]) => cr === curr.row && cc === curr.col);
          if (isBorderCell) {
            reached.add(sys.key);

            // Reconstruct path from sourcePos to this border exit cell
            const pathCells = [];
            let trace = { row: curr.row, col: curr.col };
            while (trace) {
              pathCells.push({ row: trace.row, col: trace.col });
              trace = parentMap.get(`${trace.row},${trace.col}`);
            }
            pathCells.reverse();

            paths[sys.key] = {
              cells: pathCells,
              exitDir: sys.side,
              entryRow: curr.row,
              entryCol: curr.col,
            };
          }
        }
      }

      // Explore neighbors through open matching ports
      for (const dir of ports) {
        const offset = DIR_OFFSETS[dir];
        const nr = curr.row + offset.dr;
        const nc = curr.col + offset.dc;

        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        if (nr === forbiddenPos.row && nc === forbiddenPos.col) continue;

        const nbrKey = `${nr},${nc}`;
        if (visited.has(nbrKey)) continue;

        const nbrTile = this.getTile(nr, nc);
        const nbrPorts = this.getTilePorts(nbrTile);
        if (nbrPorts.includes(OPPOSITE_DIR[dir])) {
          visited.add(nbrKey);
          parentMap.set(nbrKey, { row: curr.row, col: curr.col });
          queue.push({ row: nr, col: nc });
        }
      }
    }

    return { reached, reachableTiles, paths };
  }

  /**
   * Solves power and coolant flow via dual BFS path tracing and dynamic baseline redistribution.
   * @param {number} [poolOverride] - Overriding total power pool
   * @param {number} [dt=0.0166] - Simulation delta time in seconds
   * @returns {object} Power and coolant distribution snapshot
   */
  solvePowerFlow(poolOverride, dt = 0.0166) {
    const delta = typeof dt === 'number' ? dt : 0;

    // 1. Advance timers & discharge capacitors
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.tiles[r][c];
        if (tile.empTimer > 0) {
          tile.empTimer = Math.max(0, tile.empTimer - delta);
        }
        if (tile.type === 'capacitor' && tile.discharging) {
          tile.dischargeTimer = Math.max(0, tile.dischargeTimer - delta);
          if (tile.dischargeTimer <= 0) {
            tile.discharging = false;
          }
        }
      }
    }

    // 2. Determine source nominal statuses
    const reactorTile = this.getTile(this.reactorPos.row, this.reactorPos.col);
    const coolantTile = this.getTile(this.coolantPos.row, this.coolantPos.col);

    const reactorOnline = Boolean(
      reactorTile && reactorTile.status === 'nominal' && (!reactorTile.empTimer || reactorTile.empTimer <= 0)
    );
    const coolantOnline = Boolean(
      coolantTile && coolantTile.status === 'nominal' && (!coolantTile.empTimer || coolantTile.empTimer <= 0)
    );

    // 3. Trace Resource Paths
    const powerRes = reactorOnline
      ? this.traceResourcePaths(this.reactorPos, this.coolantPos)
      : { reached: new Set(), reachableTiles: new Set(), paths: {} };

    const coolantRes = coolantOnline
      ? this.traceResourcePaths(this.coolantPos, this.reactorPos)
      : { reached: new Set(), reachableTiles: new Set(), paths: {} };

    // 4. Update discharging capacitors boost & recharge idle capacitors
    let capacitorSurge = 0;
    if (reactorOnline) {
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          const tile = this.tiles[r][c];
          if (tile.type === 'capacitor') {
            const isReachable = powerRes.reachableTiles.has(`${r},${c}`);
            if (tile.discharging && tile.status === 'nominal' && tile.empTimer <= 0 && isReachable) {
              capacitorSurge += CAPACITOR_SURGE_POOL;
            } else if (!tile.discharging && tile.status === 'nominal' && tile.empTimer <= 0 && isReachable) {
              tile.charge = Math.min(tile.maxCharge || 20, (tile.charge || 0) + (delta > 0 ? 5 * delta : 0));
            }
          }
        }
      }
    }

    // 5. Total Resource Pools
    const basePower = (typeof poolOverride === 'number')
      ? poolOverride
      : BASE_RESOURCE_POOL;
    const totalPower = reactorOnline ? (basePower + capacitorSurge) : 0;
    const totalCoolant = coolantOnline ? BASE_RESOURCE_POOL : 0;

    // 6. Independent Power & Coolant Allocation with Boost Redistribution
    const k = powerRes.reached.size;
    const m = coolantRes.reached.size;

    const powerAlloc = allocateResourcePool(
      powerRes.reached,
      totalPower,
      this.boostedSystems
    );
    const coolantAlloc = allocateResourcePool(
      coolantRes.reached,
      totalCoolant,
      this.boostedSystems
    );

    const powerPerSystem = (powerAlloc.unboostedConnectedCount > 0)
      ? powerAlloc.unboostedShare
      : powerAlloc.boostedShare;

    const coolantPerSystem = (coolantAlloc.unboostedConnectedCount > 0)
      ? coolantAlloc.unboostedShare
      : coolantAlloc.boostedShare;

    const powerMap = {};
    const coolantMap = {};

    for (const sysKey of SUBSYSTEM_NODES) {
      powerMap[sysKey] = powerAlloc.allocations[sysKey];
      coolantMap[sysKey] = coolantAlloc.allocations[sysKey];
    }

    // Metadata properties
    powerMap.totalPower = totalPower;
    powerMap.totalCoolant = totalCoolant;
    powerMap.powerConnectedCount = k;
    powerMap.connectedCount = k; // backwards compatibility
    powerMap.coolantConnectedCount = m;
    powerMap.powerPerSystem = powerPerSystem;
    powerMap.coolantPerSystem = coolantPerSystem;
    powerMap.reactorOnline = reactorOnline;
    powerMap.coolantOnline = coolantOnline;
    powerMap.coolantMap = coolantMap;
    powerMap.coolant = coolantMap; // backwards compatibility
    powerMap.powerPaths = powerRes.paths;
    powerMap.coolantPaths = coolantRes.paths;

    powerMap.boostedSystems = Array.from(this.boostedSystems);
    powerMap.boostedPowerPerSystem = powerAlloc.boostedShare;
    powerMap.boostedCoolantPerSystem = coolantAlloc.boostedShare;
    powerMap.unboostedPowerPerSystem = powerAlloc.unboostedShare;
    powerMap.unboostedCoolantPerSystem = coolantAlloc.unboostedShare;

    // 7. Update tile flow indicators
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.tiles[r][c];
        const tileKey = `${r},${c}`;
        tile.powerFlow = powerRes.reachableTiles.has(tileKey);
        tile.coolantFlow = coolantRes.reachableTiles.has(tileKey);
        tile.allocatedPower = tile.powerFlow ? (powerMap.powerPerSystem || powerAlloc.boostedShare) : 0;
      }
    }

    this.lastPowerMap = powerMap;
    return powerMap;
  }

  /**
   * Serialize grid state for network transmission and snapshot broadcasting
   */
  serialize() {
    return {
      rows: GRID_ROWS,
      cols: GRID_COLS,
      hullClass: this.hullClass,
      reactorPos: { ...this.reactorPos },
      coolantPos: { ...this.coolantPos },
      externalSystems: EXTERNAL_SYSTEMS,
      boostedSystems: Array.from(this.boostedSystems),
      tiles: this.tiles.map(row =>
        row.map(tile => ({
          row: tile.row,
          col: tile.col,
          type: tile.type,
          orientation: tile.orientation,
          status: tile.status,
          empTimer: tile.empTimer,
          allocatedPower: tile.allocatedPower,
          powerFlow: tile.powerFlow,
          coolantFlow: tile.coolantFlow,
          charge: tile.charge,
          maxCharge: tile.maxCharge,
          discharging: tile.discharging,
          dischargeTimer: tile.dischargeTimer,
        }))
      ),
      lastPowerMap: this.lastPowerMap,
    };
  }
}
