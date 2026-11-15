/**
 * BROADSIDE HYPERION — Engineer Control Console (10x10 Matrix & Perimeter Canvas)
 *
 * Implements an interactive 10x10 Rectangular Conduit Grid (100 tiles, 560x560)
 * padded by 100px border in a 760x760 canvas with 11 external perimeter subsystem boxes,
 * dual-resource independent flow animation (Power Cyan #38bdf8 & Coolant Emerald #22c55e),
 * shortest-path circulation dots with dual-carrier lateral separation and staggered phase,
 * tap/click conduit rotation, capacitor discharge, drone dispatch, and live telemetry.
 */

export const CANVAS_SIZE = 760;
export const GRID_OFFSET_X = 100;
export const GRID_OFFSET_Y = 100;
export const TILE_SIZE = 56;
export const GRID_ROWS = 10;
export const GRID_COLS = 10;
export const PROTRUSION = 84;
export const DOT_SPACING = 28;
export const DOT_SPEED = 48;
export const DOT_RADIUS = 3.2;

/**
 * Exact 11 perimeter systems situated around the outside of the 10x10 border.
 */
export const EXTERNAL_SYSTEMS = [
  { key: 'sas_computer', label: 'SAS COMPUTER', short: 'SAS', side: 'N', cells: [[0, 1], [0, 2]], droneAnchor: { row: 0, col: 1.5 } },
  { key: 'shields_fore', label: 'SHIELD FORE', short: 'SHD FORE', side: 'N', cells: [[0, 4], [0, 5]], droneAnchor: { row: 0, col: 4.5 } },
  { key: 'rcs_thrusters', label: 'RCS THRUSTERS', short: 'RCS', side: 'N', cells: [[0, 7], [0, 8]], droneAnchor: { row: 0, col: 7.5 } },
  { key: 'shields_aft', label: 'SHIELD AFT', short: 'SHD AFT', side: 'S', cells: [[9, 2], [9, 3]], droneAnchor: { row: 9, col: 2.5 } },
  { key: 'main_drive', label: 'MAIN DRIVE', short: 'DRIVE', side: 'S', cells: [[9, 6], [9, 7]], droneAnchor: { row: 9, col: 6.5 } },
  { key: 'weapons_torpedo', label: 'WPN TORPEDO', short: 'TORP', side: 'W', cells: [[1, 0], [2, 0]], droneAnchor: { row: 1.5, col: 0 } },
  { key: 'shields_port', label: 'SHIELD PORT', short: 'SHD PORT', side: 'W', cells: [[4, 0], [5, 0]], droneAnchor: { row: 4.5, col: 0 } },
  { key: 'weapons_laser', label: 'WPN LASER', short: 'LASER', side: 'W', cells: [[7, 0], [8, 0]], droneAnchor: { row: 7.5, col: 0 } },
  { key: 'hyperspace', label: 'HYPERSPACE', short: 'HYPER', side: 'E', cells: [[1, 9], [2, 9]], droneAnchor: { row: 1.5, col: 9 } },
  { key: 'shields_starboard', label: 'SHIELD STBD', short: 'SHD STBD', side: 'E', cells: [[4, 9], [5, 9]], droneAnchor: { row: 4.5, col: 9 } },
  { key: 'weapons_railgun', label: 'WPN RAILGUN', short: 'RAILGUN', side: 'E', cells: [[7, 9], [8, 9]], droneAnchor: { row: 7.5, col: 9 } },
];

/**
 * Clean subsystem labels for telemetry cards and boost toggles (zero decorative emojis).
 */
export const SUBSYSTEM_LABELS = {
  sas_computer: 'SAS COMPUTER',
  shields_fore: 'FORE SHIELDS',
  rcs_thrusters: 'RCS THRUSTERS',
  shields_aft: 'AFT SHIELDS',
  main_drive: 'MAIN DRIVE',
  weapons_torpedo: 'TORPEDO TUBES',
  shields_port: 'PORT SHIELDS',
  weapons_laser: 'PULSE LASERS',
  hyperspace: 'HYPERSPACE DRIVE',
  shields_starboard: 'STARBOARD SHIELDS',
  weapons_railgun: 'RAILGUN',
};

/**
 * Computes bounding rectangle for an external perimeter box protruding outside the 10x10 border.
 *
 * @param {object} sys - External system definition
 * @param {number} [gridOffsetX=100]
 * @param {number} [gridOffsetY=100]
 * @param {number} [tileSize=56]
 * @param {number} [protrusion=84]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function getPerimeterBoxRect(sys, gridOffsetX = GRID_OFFSET_X, gridOffsetY = GRID_OFFSET_Y, tileSize = TILE_SIZE, protrusion = PROTRUSION) {
  const side = sys.side;
  if (side === 'N') {
    const minCol = Math.min(sys.cells[0][1], sys.cells[1][1]);
    return {
      x: gridOffsetX + minCol * tileSize,
      y: gridOffsetY - protrusion,
      width: 2 * tileSize,
      height: protrusion,
    };
  } else if (side === 'S') {
    const minCol = Math.min(sys.cells[0][1], sys.cells[1][1]);
    return {
      x: gridOffsetX + minCol * tileSize,
      y: gridOffsetY + 10 * tileSize,
      width: 2 * tileSize,
      height: protrusion,
    };
  } else if (side === 'W') {
    const minRow = Math.min(sys.cells[0][0], sys.cells[1][0]);
    return {
      x: gridOffsetX - protrusion,
      y: gridOffsetY + minRow * tileSize,
      width: protrusion,
      height: 2 * tileSize,
    };
  } else if (side === 'E') {
    const minRow = Math.min(sys.cells[0][0], sys.cells[1][0]);
    return {
      x: gridOffsetX + 10 * tileSize,
      y: gridOffsetY + minRow * tileSize,
      width: protrusion,
      height: 2 * tileSize,
    };
  }
  return null;
}

/**
 * Canonical unordered segment representation between two points.
 * Sorts endpoints (pMin -> pMax) so opposite direction flows along the same pipe
 * produce the exact same key and canonical perpendicular normal (nx, ny).
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {{ key: string, pMin: {x, y}, pMax: {x, y}, nx: number, ny: number, len: number }}
 */
export function normalizeSeg(ax, ay, bx, by) {
  const p1 = { x: Math.round(ax), y: Math.round(ay) };
  const p2 = { x: Math.round(bx), y: Math.round(by) };
  const isP1Min = p1.x < p2.x || (p1.x === p2.x && p1.y < p2.y);
  const pMin = isP1Min ? p1 : p2;
  const pMax = isP1Min ? p2 : p1;
  const key = `${pMin.x},${pMin.y}_${pMax.x},${pMax.y}`;
  const dx = pMax.x - pMin.x;
  const dy = pMax.y - pMin.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular normal pointing to one canonical side
  const nx = -dy / len;
  const ny = dx / len;
  return { key, pMin, pMax, nx, ny, len };
}

/**
 * Computes lateral offset and phase shift for dual-carrier flow dots.
 * - Single carrier: lateral offset 0px, phase 0
 * - Dual carrier: Power (Cyan) offset +3.5px (phase 0); Coolant (Emerald) offset -3.5px (phase 0.5 * DOT_SPACING = 14px)
 *
 * @param {'power'|'coolant'} carrierType
 * @param {boolean} isDualCarrier
 * @param {{ nx: number, ny: number }} normal
 * @returns {{ offsetX: number, offsetY: number, phase: number }}
 */
export function computeDualCarrierOffset(carrierType, isDualCarrier, normal) {
  if (!isDualCarrier || !normal) {
    return { offsetX: 0, offsetY: 0, phase: 0 };
  }
  const isPower = carrierType === 'power';
  const mag = isPower ? 3.5 : -3.5;
  const phase = isPower ? 0 : 0.5 * DOT_SPACING; // 14px
  return {
    offsetX: normal.nx * mag,
    offsetY: normal.ny * mag,
    phase,
  };
}

/**
 * Builds continuous polyline points from path descriptor:
 * Source center -> each cell center -> exit border edge -> external subsystem box.
 */
export function buildPathPolyline(pathInfo, sourcePos, gridOffsetX = GRID_OFFSET_X, gridOffsetY = GRID_OFFSET_Y, tileSize = TILE_SIZE) {
  if (!pathInfo || !pathInfo.cells || !pathInfo.cells.length) return [];
  const points = [];
  for (const c of pathInfo.cells) {
    points.push({
      x: gridOffsetX + c.col * tileSize + tileSize / 2,
      y: gridOffsetY + c.row * tileSize + tileSize / 2,
    });
  }

  // Extend out through exit border edge into external system box
  const lastCell = pathInfo.cells[pathInfo.cells.length - 1];
  const lastX = gridOffsetX + lastCell.col * tileSize + tileSize / 2;
  const lastY = gridOffsetY + lastCell.row * tileSize + tileSize / 2;
  const exitDir = pathInfo.exitDir;

  if (exitDir === 'N') {
    points.push({ x: lastX, y: gridOffsetY });
    points.push({ x: lastX, y: gridOffsetY - 42 });
  } else if (exitDir === 'S') {
    points.push({ x: lastX, y: gridOffsetY + 10 * tileSize });
    points.push({ x: lastX, y: gridOffsetY + 10 * tileSize + 42 });
  } else if (exitDir === 'W') {
    points.push({ x: gridOffsetX, y: lastY });
    points.push({ x: gridOffsetX - 42, y: lastY });
  } else if (exitDir === 'E') {
    points.push({ x: gridOffsetX + 10 * tileSize, y: lastY });
    points.push({ x: gridOffsetX + 10 * tileSize + 42, y: lastY });
  }
  return points;
}

/**
 * Discovers shared segments between Power and Coolant shortest paths.
 * Accepts either arrays of polylines or paths maps ({ sysKey: { cells, exitDir, ... } }).
 *
 * @param {object|Array} powerInput
 * @param {object|Array} coolantInput
 * @param {object} [geometry={}]
 * @returns {{ sharedSegments: Set<string>, powerPolylines: Array, coolantPolylines: Array, segmentNormals: Map<string, object> }}
 */
export function computeDualCarrierSegments(powerInput, coolantInput, geometry = {}) {
  const gridOffsetX = geometry.gridOffsetX ?? GRID_OFFSET_X;
  const gridOffsetY = geometry.gridOffsetY ?? GRID_OFFSET_Y;
  const tileSize = geometry.tileSize ?? TILE_SIZE;

  const powerPolylines = Array.isArray(powerInput)
    ? powerInput
    : Object.values(powerInput || {}).map(p => buildPathPolyline(p, { row: 2, col: 3 }, gridOffsetX, gridOffsetY, tileSize));

  const coolantPolylines = Array.isArray(coolantInput)
    ? coolantInput
    : Object.values(coolantInput || {}).map(p => buildPathPolyline(p, { row: 2, col: 6 }, gridOffsetX, gridOffsetY, tileSize));

  const powerSegments = new Set();
  const segmentNormals = new Map();

  for (const poly of powerPolylines) {
    for (let i = 0; i < poly.length - 1; i++) {
      const seg = normalizeSeg(poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y);
      powerSegments.add(seg.key);
      if (!segmentNormals.has(seg.key)) {
        segmentNormals.set(seg.key, seg);
      }
    }
  }

  const sharedSegments = new Set();
  for (const poly of coolantPolylines) {
    for (let i = 0; i < poly.length - 1; i++) {
      const seg = normalizeSeg(poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y);
      if (!segmentNormals.has(seg.key)) {
        segmentNormals.set(seg.key, seg);
      }
      if (powerSegments.has(seg.key)) {
        sharedSegments.add(seg.key);
      }
    }
  }

  return {
    sharedSegments,
    powerPolylines,
    coolantPolylines,
    segmentNormals,
  };
}

export class EngineerController {
  /**
   * @param {object} [options={}]
   * @param {function} [options.send] - Network send callback: send(msg)
   * @param {object} [options.sound] - SoundSynthesizer instance
   */
  constructor(options = {}) {
    this.send = typeof options === 'function' ? options : (options.send || options.sendInput || (() => {}));
    this.sound = options.sound || options.soundSynth || null;
    this.isActive = options.isActive !== undefined ? Boolean(options.isActive) : true;

    this.grid = null;
    this.drones = [];
    this.powerMap = null;
    this.ship = null;
    this.latestSnapshot = null;

    this.selectedDroneId = null;
    this.draggedDrone = null;

    this._animTime = 0;
    this.animTime = 0; // backwards compatibility
    this._rafId = null;

    this.bound = false;
    this._listeners = [];

    this.canvasSize = CANVAS_SIZE;
    this.gridOffsetX = GRID_OFFSET_X;
    this.gridOffsetY = GRID_OFFSET_Y;
    this.tileSize = TILE_SIZE;
    this.gridRows = GRID_ROWS;
    this.gridCols = GRID_COLS;
    this.protrusion = PROTRUSION;

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.bind();
    }

    if (this.isActive) {
      this.startAnimationLoop();
    }
  }

  /**
   * Starts continuous RAF render loop for smooth flow dots animation (~30-60 FPS).
   */
  startAnimationLoop() {
    if (this._rafId || typeof requestAnimationFrame !== 'function') return;
    let lastTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    const loop = (currentTime) => {
      if (!this.isActive) {
        this._rafId = null;
        return;
      }
      const dt = Math.min(0.1, (currentTime - lastTime) / 1000);
      lastTime = currentTime;
      this._animTime += dt;
      this.animTime = this._animTime;

      this.renderCanvas();
      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  /**
   * Stops RAF animation loop cleanly.
   */
  stopAnimationLoop() {
    if (this._rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
  }

  /**
   * Activates or deactivates Engineer input handling.
   *
   * @param {boolean} active
   */
  setActive(active) {
    this.isActive = Boolean(active);
    if (!this.isActive) {
      this.selectedDroneId = null;
      this.draggedDrone = null;
      this.stopAnimationLoop();
    } else {
      this.startAnimationLoop();
    }
  }

  /**
   * Evaluates whether engineer input is blocked due to battle outcome overlay,
   * match conclusion/replay snapshot state, or player ship destruction.
   *
   * @returns {boolean}
   */
  _isBlockedByState() {
    if (typeof document !== 'undefined') {
      const outcome = document.getElementById('battle-outcome-overlay');
      if (
        outcome &&
        (!outcome.classList || !outcome.classList.contains('hidden')) &&
        (!outcome.style || outcome.style.display !== 'none')
      ) {
        return true;
      }
    }

    if (this.latestSnapshot) {
      if (
        this.latestSnapshot.replayActive ||
        ['gameover', 'game_over', 'restarting'].includes(this.latestSnapshot.state)
      ) {
        return true;
      }
    }

    if (this.ship) {
      if (this.ship.destroyed === true || (typeof this.ship.hullHp === 'number' && this.ship.hullHp <= 0)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks whether Engineer controller is active and permitted to process inputs.
   *
   * @returns {boolean}
   */
  canHandleInput() {
    if (!this.isActive || this._isBlockedByState()) {
      this.draggedDrone = null;
      return false;
    }
    if (typeof document === 'undefined') return true;

    const lobby = document.getElementById('lobby-overlay');
    if (lobby && (lobby.classList.contains('active') || lobby.style.display === 'flex')) {
      this.draggedDrone = null;
      return false;
    }

    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      return false;
    }

    return true;
  }

  /**
   * Binds canvas interactions and sidebar DOM events.
   */
  bind() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;

    const canvas = document.getElementById('engineer-grid-canvas');
    if (canvas) {
      const onClick = (e) => {
        if (!this.canHandleInput()) {
          this.draggedDrone = null;
          return false;
        }
        this.handleCanvasClick(e, canvas);
      };
      const onTouchStart = (e) => {
        if (!this.canHandleInput()) {
          this.draggedDrone = null;
          return false;
        }
        this.handleCanvasTouch(e, canvas);
      };

      canvas.addEventListener('click', onClick);
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });

      this._listeners.push(() => {
        canvas.removeEventListener('click', onClick);
        canvas.removeEventListener('touchstart', onTouchStart);
      });
    }

    // Hardware Subsystem Repair Buttons
    const repairList = document.getElementById('eng-subsystem-repair-list');
    if (repairList) {
      const onRepairClick = (e) => {
        if (!this.canHandleInput()) {
          this.draggedDrone = null;
          return false;
        }
        const btn = e.target.closest('.btn-repair-target');
        if (!btn) return;
        e.preventDefault();
        const subsystemKey = btn.dataset.subsystem;
        if (subsystemKey) {
          this.assignDroneToSubsystem(subsystemKey);
        }
      };
      repairList.addEventListener('click', onRepairClick);
      this._listeners.push(() => repairList.removeEventListener('click', onRepairClick));
    }

    // Drone Card Selection / Recall clicks
    const droneList = document.getElementById('drone-list-container');
    if (droneList) {
      let lastRecallTimestamp = 0;
      const handleRecallAction = (e) => {
        if (!this.canHandleInput()) {
          this.draggedDrone = null;
          return false;
        }
        const recallBtn = e.target.closest('.btn-recall-drone');
        if (recallBtn) {
          e.preventDefault();
          const now = Date.now();
          if (now - lastRecallTimestamp < 150) return;
          if (recallBtn.disabled || recallBtn.classList.contains('recalling')) return;
          const droneId = parseInt(recallBtn.dataset.droneId, 10);
          if (Number.isFinite(droneId)) {
            lastRecallTimestamp = now;
            this.updateDroneButtonState(recallBtn, 'returning');
            this.recallDrone(droneId);
          }
          return;
        }

        if (e.type === 'click') {
          const card = e.target.closest('.drone-card');
          if (card) {
            const droneId = parseInt(card.dataset.droneId, 10);
            if (Number.isFinite(droneId)) {
              this.selectDrone(this.selectedDroneId === droneId ? null : droneId);
            }
          }
        }
      };

      droneList.addEventListener('click', handleRecallAction);
      droneList.addEventListener('pointerup', handleRecallAction);
      this._listeners.push(() => {
        droneList.removeEventListener('click', handleRecallAction);
        droneList.removeEventListener('pointerup', handleRecallAction);
      });
    }

    // Subsystem Boost Buttons
    const boostList = document.getElementById('eng-system-boost-list');
    if (boostList) {
      const onBoostClick = (e) => {
        if (!this.canHandleInput()) {
          this.draggedDrone = null;
          return false;
        }
        const btn = e.target.closest('.btn-boost-system');
        if (!btn) return;
        e.preventDefault();
        const subsystemKey = btn.dataset.subsystem;
        if (subsystemKey) {
          this.toggleSystemBoost(subsystemKey);
        }
      };
      boostList.addEventListener('click', onBoostClick);
      this._listeners.push(() => boostList.removeEventListener('click', onBoostClick));
    }
  }

  /**
   * Unbinds all registered listeners and cancels RAF loop.
   */
  destroy() {
    this.stopAnimationLoop();
    for (const unbind of this._listeners) {
      unbind();
    }
    this._listeners = [];
    this.bound = false;
  }

  /**
   * Handles canvas tap / click for tile rotation, capacitor discharge, or drone assignment.
   */
  handleCanvasClick(e, canvas) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return this.handleGridPointAction(x, y, canvas);
  }

  /**
   * Handles canvas touch event.
   */
  handleCanvasTouch(e, canvas) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    if (e.touches.length === 0) return false;
    e.preventDefault();
    const touch = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (touch.clientX - rect.left) * scaleX;
    const y = (touch.clientY - rect.top) * scaleY;
    return this.handleGridPointAction(x, y, canvas);
  }

  /**
   * Resolves click/tap at (x, y) coordinates on 760x760 canvas:
   * 1. Check perimeter external system boxes (assign_drone_subsystem)
   * 2. Check 10x10 conduit grid (tile rotation, capacitor discharge, or drone repair)
   */
  handleGridPointAction(x, y, canvas) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }

    // 1. Check external perimeter system boxes
    for (const sys of EXTERNAL_SYSTEMS) {
      const box = getPerimeterBoxRect(sys, this.gridOffsetX, this.gridOffsetY, this.tileSize, this.protrusion);
      if (box && x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        this.assignDroneToSubsystem(sys.key);
        return;
      }
    }

    // 2. Check 10x10 internal grid
    if (
      x < this.gridOffsetX ||
      x >= this.gridOffsetX + this.gridCols * this.tileSize ||
      y < this.gridOffsetY ||
      y >= this.gridOffsetY + this.gridRows * this.tileSize
    ) {
      return;
    }

    const col = Math.floor((x - this.gridOffsetX) / this.tileSize);
    const row = Math.floor((y - this.gridOffsetY) / this.tileSize);

    if (row < 0 || row >= this.gridRows || col < 0 || col >= this.gridCols) {
      return;
    }

    if (!this.grid || !this.grid.tiles || !this.grid.tiles[row]) return;
    const tile = this.grid.tiles[row][col];
    if (!tile) return;

    // Action A: If a drone is selected, assign it to repair this tile
    if (this.selectedDroneId !== null) {
      this.assignDroneToTile(this.selectedDroneId, row, col);
      this.selectDrone(null);
      return;
    }

    // Action B: If tile is broken, automatically assign first idle drone
    if (tile.status === 'broken') {
      this.assignDroneToTile(null, row, col);
      return;
    }

    // Action C: Capacitor tile discharge
    if (tile.type === 'capacitor') {
      this.dischargeCapacitor(row, col);
      return;
    }

    // Action D: Rotatable conduits (straight, elbow, t_split, cross_bridge)
    if (['straight', 'elbow', 't_split', 'cross_bridge'].includes(tile.type)) {
      this.rotateTile(row, col);
    }
  }

  /**
   * Rotates conduit tile 90° clockwise.
   */
  rotateTile(row, col) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    this.send({
      type: 'engineer_input',
      action: 'rotate_tile',
      actionType: 'rotate_tile',
      row,
      col,
    });
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
    return true;
  }

  /**
   * Discharges capacitor energy surge.
   */
  dischargeCapacitor(row, col) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    this.send({
      type: 'engineer_input',
      action: 'discharge_capacitor',
      actionType: 'discharge_capacitor',
      row,
      col,
    });
    if (this.sound && typeof this.sound.playCapacitorDischarge === 'function') {
      this.sound.playCapacitorDischarge();
    }
    return true;
  }

  /**
   * Assigns drone to repair a grid tile.
   */
  assignDroneToTile(droneId, row, col) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    this.send({
      type: 'engineer_input',
      action: 'assign_drone_tile',
      actionType: 'assign_drone_tile',
      droneId: droneId || this.findFirstAvailableDroneId(),
      row,
      col,
    });
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
    return true;
  }

  /**
   * Assigns drone to repair a damaged ship subsystem.
   */
  assignDroneToSubsystem(arg1, arg2) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    const droneId = arg2 !== undefined
      ? (arg1 || this.findFirstAvailableDroneId())
      : (this.selectedDroneId || this.findFirstAvailableDroneId());
    const subsystemKey = arg2 !== undefined ? arg2 : arg1;
    this.send({
      type: 'engineer_input',
      action: 'assign_drone_subsystem',
      actionType: 'assign_drone_subsystem',
      droneId,
      subsystemKey,
    });
    this.selectDrone(null);
    if (this.sound && typeof this.sound.playConduitClick === 'function') {
      this.sound.playConduitClick();
    }
    return true;
  }

  /**
   * Recalls a drone back to the Drone Bay.
   */
  recallDrone(droneId) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    this.send({
      type: 'engineer_input',
      action: 'recall_drone',
      actionType: 'recall_drone',
      droneId,
    });
    return true;
  }

  /**
   * Toggles emergency boost overcharge on an external perimeter subsystem.
   *
   * @param {string} subsystemKey
   * @param {boolean} [enabled]
   */
  toggleSystemBoost(subsystemKey, enabled) {
    if (!this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    if (!subsystemKey) return false;
    const payload = {
      type: 'engineer_input',
      action: 'toggle_boost',
      actionType: 'toggle_boost',
      subsystemKey,
    };
    if (enabled !== undefined) {
      payload.enabled = Boolean(enabled);
    }
    this.send(payload);
    if (this.sound && typeof this.sound.playBreakerToggle === 'function') {
      this.sound.playBreakerToggle();
    }
    return true;
  }

  /**
   * Finds the ID of the first idle drone.
   */
  findFirstAvailableDroneId() {
    const idleDrone = this.drones.find(d => d.state === 'idle');
    return idleDrone ? idleDrone.id : (this.drones[0]?.id || 1);
  }

  /**
   * Selects or deselects a drone for targeted assignment.
   */
  selectDrone(droneId) {
    if (droneId !== null && !this.canHandleInput()) {
      this.draggedDrone = null;
      return false;
    }
    this.selectedDroneId = droneId;
    this.renderDroneCards();
  }

  /**
   * Updates engineer console telemetry, grid canvas, and drone fleet cards.
   *
   * @param {object} ship - Player ship snapshot
   */
  updateHUD(ship) {
    if (!ship) return;
    this.ship = ship;
    if (typeof document === 'undefined') return;
    this.grid = ship.grid;
    this.drones = ship.drones || [];
    this.powerMap = ship.powerMap || ship.grid?.lastPowerMap || {};
    this.coolantMap = this.powerMap.coolantMap || this.powerMap.coolant || ship.coolantMap || {};

    const powerPool = this.powerMap.totalPower ?? 8.0;
    const coolantPool = this.powerMap.totalCoolant ?? 8.0;
    const k = this.powerMap.powerConnectedCount ?? this.powerMap.connectedCount ?? 0;
    const m = this.powerMap.coolantConnectedCount ?? 0;
    const powerPerSystem = this.powerMap.powerPerSystem ?? (k > 0 ? Math.min(1.0, powerPool / k) : 0);
    const coolantPerSystem = this.powerMap.coolantPerSystem ?? (m > 0 ? Math.min(1.0, coolantPool / m) : 0);

    // 1. Dual-Resource Telemetry Gauges (80% Baseline Dynamic Redistribution)
    const reactorCapEl = document.getElementById('eng-reactor-cap');
    if (reactorCapEl) {
      reactorCapEl.textContent = `${powerPool.toFixed(1)} PWR / ${coolantPool.toFixed(1)} COL`;
    }

    const connectedEl = document.getElementById('eng-connected-count');
    if (connectedEl) {
      connectedEl.textContent = `P:${k}/${EXTERNAL_SYSTEMS.length} · C:${m}/${EXTERNAL_SYSTEMS.length}`;
    }

    const powerPerNodeEl = document.getElementById('eng-power-per-node');
    if (powerPerNodeEl) {
      powerPerNodeEl.textContent = `${Math.round(powerPerSystem * 100)}%`;
    }

    const coolantShareEl = document.getElementById('eng-coolant-share');
    if (coolantShareEl) {
      coolantShareEl.textContent = `${Math.round(coolantPerSystem * 100)}%`;
    }

    // 2. Drone Bay Status (Stalled if reactor is offline)
    const droneBayPill = document.getElementById('eng-drone-bay-status');
    if (droneBayPill) {
      droneBayPill.classList.remove('nominal', 'warning', 'offline', 'alert');
      const reactorOnline = this.powerMap.reactorOnline !== false;
      if (!reactorOnline) {
        droneBayPill.classList.add('alert');
        droneBayPill.textContent = 'REACTOR OFFLINE — DRONES STALLED';
      } else {
        const anyDroneActive = this.drones.some(d => d.state !== 'idle');
        droneBayPill.classList.add('nominal');
        droneBayPill.textContent = anyDroneActive ? 'DRONE BAY: ACTIVE REPAIR' : 'DRONE BAY: STANDBY';
      }
    }

    // 3. Render Drone Fleet Cards
    this.renderDroneCards();

    // 4. Render System Power & Boost List (In-Place DOM Reconciliation)
    this.renderSystemBoostList();

    // 5. Render Canvas Frame (in case RAF is inactive or headless)
    this.renderCanvas();

    // 6. Update Subsystem Repair Badges
    const repairBtns = typeof document.querySelectorAll === 'function'
      ? document.querySelectorAll('.btn-repair-target')
      : [];
    if (repairBtns && repairBtns.length > 0) {
      repairBtns.forEach((btn) => {
        const sub = btn.dataset.subsystem;
        let health = 100;
        if (sub === 'main_drive') {
          health = ship.mainDrive?.health ?? 100;
        } else if (sub === 'rcs_thrusters') {
          const thrusters = Object.values(ship.thrusters || {});
          health = thrusters.length ? thrusters.reduce((sum, t) => sum + (t.health ?? 100), 0) / thrusters.length : 100;
        } else if (sub === 'sas_computer') {
          health = ship.weapons?.stabilizerHealth ?? 100;
        } else if (sub === 'shields_fore') {
          const maxFore = typeof ship.shields?.maxHp === 'object'
            ? (ship.shields.maxHp.fore || 100)
            : (ship.shields?.maxHp || 100);
          health = ship.shields?.subsystemHealth?.fore ?? (
            ship.shields?.hp?.fore !== undefined ? (ship.shields.hp.fore / maxFore) * 100 : 100
          );
        } else if (sub === 'weapons_laser') {
          health = ship.weapons?.laserHealth ?? 100;
        } else if (sub === 'weapons_railgun') {
          health = ship.weapons?.railgunHealth ?? 100;
        } else if (sub === 'hyperspace') {
          health = ship.hyperspace?.health ?? ship.ship?.hyperspace?.health ?? 100;
        }

        let badge = btn.querySelector('.health-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'health-badge';
          btn.appendChild(badge);
        }
        const safeHealth = Number.isFinite(health)
          ? Math.max(0, Math.min(100, Math.round(health)))
          : 100;
        badge.textContent = `${safeHealth}%`;
        badge.className = `health-badge ${safeHealth < 40 ? 'danger' : (safeHealth < 80 ? 'warning' : 'nominal')}`;
      });
    }
  }

  /**
   * Formats drone target label text.
   *
   * @param {object} drone
   * @returns {string}
   */
  formatDroneTarget(drone) {
    if (!drone) return 'None';
    if (drone.targetType === 'tile' && drone.target) {
      return `Tile [${drone.target.row}, ${drone.target.col}]`;
    }
    if (drone.targetType === 'subsystem' && drone.target) {
      return `Sys: ${String(drone.target).toUpperCase()}`;
    }
    return 'None';
  }

  /**
   * Updates a drone recall button's disabled, text, and class state.
   *
   * @param {HTMLButtonElement} btn
   * @param {string} state
   */
  updateDroneButtonState(btn, state) {
    if (!btn) return;
    if (state === 'returning') {
      btn.style.display = '';
      if (btn.classList) {
        btn.classList.remove('hidden');
        btn.classList.add('recalling');
      }
      btn.className = 'btn-recall-drone recalling';
      btn.textContent = 'RECALLING';
      btn.disabled = true;
    } else if (state === 'moving' || state === 'repairing') {
      btn.style.display = '';
      if (btn.classList) {
        btn.classList.remove('hidden', 'recalling');
      }
      btn.className = 'btn-recall-drone';
      btn.textContent = 'RECALL';
      btn.disabled = false;
    } else {
      // idle or docked
      btn.style.display = 'none';
      if (btn.classList) {
        btn.classList.add('hidden');
        btn.classList.remove('recalling');
      }
      btn.className = 'btn-recall-drone hidden';
      btn.disabled = true;
    }
  }

  /**
   * Renders drone status cards in sidebar with persistent DOM elements.
   */
  renderDroneCards() {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('drone-list-container');
    if (!container) return;

    if (!this.drones || this.drones.length === 0) {
      container.innerHTML = '<div class="empty-drones">NO DRONES ACTIVE</div>';
      return;
    }

    // Fallback for headless / mock environments without full DOM methods
    if (typeof container.querySelectorAll !== 'function' || typeof container.appendChild !== 'function') {
      let html = '';
      for (const drone of this.drones) {
        const isSelected = this.selectedDroneId === drone.id;
        const stateClass = drone.stalled ? 'stalled' : drone.state;
        const stateText = drone.stalled ? 'STALLED (NO PWR)' : drone.state.toUpperCase();
        const targetInfo = this.formatDroneTarget(drone);

        let buttonHtml = '';
        if (drone.state === 'returning') {
          buttonHtml = `<button class="btn-recall-drone recalling" data-drone-id="${drone.id}" type="button" disabled>RECALLING</button>`;
        } else if (drone.state === 'moving' || drone.state === 'repairing') {
          buttonHtml = `<button class="btn-recall-drone" data-drone-id="${drone.id}" type="button">RECALL</button>`;
        } else {
          buttonHtml = `<button class="btn-recall-drone hidden" data-drone-id="${drone.id}" type="button" style="display: none;" disabled>RECALL</button>`;
        }

        html += `
        <div class="drone-card ${isSelected ? 'selected' : ''} ${stateClass}" data-drone-id="${drone.id}">
          <div class="drone-card-header">
            <span class="drone-id drone-title">UNIT ${drone.id}</span>
            <span class="drone-status-tag drone-status-pill ${stateClass}">${stateText}</span>
          </div>
          <div class="drone-detail">
            <span class="d-label">TARGET:</span>
            <span class="d-val drone-target-label">${targetInfo}</span>
          </div>
          <div class="drone-card-actions">
            ${buttonHtml}
          </div>
        </div>`;
      }
      container.innerHTML = html;
      return;
    }

    // DOM-aware persistent card reconciliation
    const existingCards = Array.from(container.querySelectorAll('.drone-card[data-drone-id]'));
    const existingIds = existingCards.map(c => parseInt(c.dataset.droneId, 10)).filter(Number.isFinite);
    const newIds = this.drones.map(d => d.id);

    const idsMatch = existingCards.length === this.drones.length &&
      existingIds.every((id, idx) => id === newIds[idx]);

    // Rebuild cards only when the set of drone IDs changes or empty placeholder was showing
    if (!idsMatch || container.querySelector('.empty-drones')) {
      container.innerHTML = '';
      for (const drone of this.drones) {
        const isSelected = this.selectedDroneId === drone.id;
        const stateClass = drone.stalled ? 'stalled' : drone.state;
        const stateText = drone.stalled ? 'STALLED (NO PWR)' : drone.state.toUpperCase();

        const card = document.createElement('div');
        card.className = `drone-card ${isSelected ? 'selected' : ''} ${stateClass}`;
        card.dataset.droneId = String(drone.id);

        const header = document.createElement('div');
        header.className = 'drone-card-header';

        const title = document.createElement('span');
        title.className = 'drone-id drone-title';
        title.textContent = `UNIT ${drone.id}`;

        const statusPill = document.createElement('span');
        statusPill.className = `drone-status-tag drone-status-pill ${stateClass}`;
        statusPill.textContent = stateText;

        header.appendChild(title);
        header.appendChild(statusPill);

        const detail = document.createElement('div');
        detail.className = 'drone-detail';

        const label = document.createElement('span');
        label.className = 'd-label';
        label.textContent = 'TARGET:';

        const val = document.createElement('span');
        val.className = 'd-val drone-target-label';
        val.textContent = this.formatDroneTarget(drone);

        detail.appendChild(label);
        detail.appendChild(val);

        const actions = document.createElement('div');
        actions.className = 'drone-card-actions';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.droneId = String(drone.id);
        this.updateDroneButtonState(btn, drone.state);
        actions.appendChild(btn);

        card.appendChild(header);
        card.appendChild(detail);
        card.appendChild(actions);

        container.appendChild(card);
      }
      return;
    }

    // Subsequent updates: update existing DOM nodes in-place without recreating button elements!
    for (const drone of this.drones) {
      const card = container.querySelector(`.drone-card[data-drone-id="${drone.id}"]`);
      if (!card) continue;

      const isSelected = this.selectedDroneId === drone.id;
      const stateClass = drone.stalled ? 'stalled' : drone.state;
      const stateText = drone.stalled ? 'STALLED (NO PWR)' : drone.state.toUpperCase();

      card.className = `drone-card ${isSelected ? 'selected' : ''} ${stateClass}`;

      const title = card.querySelector('.drone-title') || card.querySelector('.drone-id');
      if (title && title.textContent !== `UNIT ${drone.id}`) {
        title.textContent = `UNIT ${drone.id}`;
      }

      const statusPill = card.querySelector('.drone-status-pill') || card.querySelector('.drone-status-tag');
      if (statusPill) {
        statusPill.className = `drone-status-tag drone-status-pill ${stateClass}`;
        if (statusPill.textContent !== stateText) {
          statusPill.textContent = stateText;
        }
      }

      const targetVal = card.querySelector('.drone-target-label') || card.querySelector('.d-val');
      const targetText = this.formatDroneTarget(drone);
      if (targetVal && targetVal.textContent !== targetText) {
        targetVal.textContent = targetText;
      }

      let btn = card.querySelector('.btn-recall-drone');
      if (!btn) {
        const actions = card.querySelector('.drone-card-actions');
        if (actions) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.dataset.droneId = String(drone.id);
          actions.appendChild(btn);
        }
      }
      if (btn) {
        this.updateDroneButtonState(btn, drone.state);
      }
    }
  }

  /**
   * Reconciles external subsystem boost states in the PWR-03 sidebar list in place.
   * Preserves exact .btn-boost-system element references across repeated updateHUD() ticks.
   */
  renderSystemBoostList() {
    if (typeof document === 'undefined') return;
    const container = document.getElementById('eng-system-boost-list');
    if (!container) return;

    const boostedArr = this.grid?.boostedSystems || this.powerMap?.boostedSystems || this.ship?.grid?.boostedSystems || [];
    const boostedSet = new Set(Array.isArray(boostedArr) ? boostedArr : []);
    const powerMap = this.powerMap || {};
    const coolantMap = this.coolantMap || powerMap.coolantMap || powerMap.coolant || {};

    const subsystems = EXTERNAL_SYSTEMS.map(s => s.key);
    const fallbackShare = 8 / EXTERNAL_SYSTEMS.length;

    for (const key of subsystems) {
      const isBoosted = boostedSet.has(key);
      const pwr = powerMap[key] !== undefined ? powerMap[key] : (powerMap.connectedCount ? (powerMap.powerPerSystem ?? fallbackShare) : 0);
      const col = coolantMap[key] !== undefined ? coolantMap[key] : (powerMap.coolantConnectedCount ? (powerMap.coolantPerSystem ?? fallbackShare) : 0);
      const isDisconnected = pwr <= 0 && col <= 0;

      let row = null;
      if (typeof container.querySelector === 'function') {
        row = container.querySelector(`.system-boost-row[data-subsystem="${key}"]`);
      }
      if (!row && container.children) {
        const childrenArr = Array.from(container.children);
        row = childrenArr.find(c => (c.dataset && c.dataset.subsystem === key) || (typeof c.getAttribute === 'function' && c.getAttribute('data-subsystem') === key));
      }

      if (!row) {
        if (typeof document.createElement !== 'function') continue;
        row = document.createElement('div');
        row.className = 'system-boost-row';
        row.dataset.subsystem = key;
        if (typeof row.setAttribute === 'function') {
          row.setAttribute('data-subsystem', key);
        }

        const meta = document.createElement('div');
        meta.className = 'sys-boost-meta';

        const name = document.createElement('span');
        name.className = 'sys-boost-name';
        name.textContent = SUBSYSTEM_LABELS[key] || key.toUpperCase();

        const readouts = document.createElement('span');
        readouts.className = 'sys-boost-readouts';

        const pwrVal = document.createElement('span');
        pwrVal.className = 'sys-pwr-val';

        const colVal = document.createElement('span');
        colVal.className = 'sys-col-val';

        readouts.appendChild(pwrVal);
        readouts.appendChild(colVal);
        meta.appendChild(name);
        meta.appendChild(readouts);

        const btn = document.createElement('button');
        btn.className = 'btn-boost-system';
        btn.dataset.subsystem = key;
        if (typeof btn.setAttribute === 'function') {
          btn.setAttribute('data-subsystem', key);
          btn.setAttribute('aria-pressed', 'false');
        }
        btn.type = 'button';
        btn.textContent = 'BOOST';

        row.appendChild(meta);
        row.appendChild(btn);
        if (typeof container.appendChild === 'function') {
          container.appendChild(row);
        }
      }

      // Mutate only classes and attributes in-place on existing nodes
      let rowClass = 'system-boost-row';
      if (isBoosted) rowClass += ' boosted';
      if (isDisconnected) rowClass += ' disconnected';
      row.className = rowClass;

      const pwrPct = Math.round((pwr || 0) * 100);
      const colPct = Math.round((col || 0) * 100);

      let pwrEl = null;
      let colEl = null;
      if (typeof row.querySelector === 'function') {
        pwrEl = row.querySelector('.sys-pwr-val');
        colEl = row.querySelector('.sys-col-val');
      }

      if (pwrEl) {
        pwrEl.textContent = `P:${pwrPct}%`;
        const pwrBoosted = pwr > 1.0 || (isBoosted && pwr > 0);
        const pwrOffline = pwr <= 0;
        pwrEl.className = `sys-pwr-val ${pwrBoosted ? 'boosted' : (pwrOffline ? 'offline' : 'nominal')}`;
      }

      if (colEl) {
        colEl.textContent = `C:${colPct}%`;
        const colBoosted = col > 1.0 || (isBoosted && col > 0);
        const colOffline = col <= 0;
        colEl.className = `sys-col-val ${colBoosted ? 'boosted' : (colOffline ? 'offline' : 'nominal')}`;
      }

      let btn = null;
      if (typeof row.querySelector === 'function') {
        btn = row.querySelector('.btn-boost-system');
      }
      if (btn) {
        if (typeof btn.setAttribute === 'function') {
          btn.setAttribute('aria-pressed', isBoosted ? 'true' : 'false');
        }
        btn.className = `btn-boost-system ${isBoosted ? 'active' : ''}`.trim();
        btn.textContent = isBoosted ? 'BOOST ON' : 'BOOST';
      }
    }
  }

  /**
   * Renders the 760x760 perimeter grid canvas.
   */
  renderCanvas() {
    const canvas = document.getElementById('engineer-grid-canvas');
    if (!canvas || !this.grid || !this.grid.tiles) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const offX = this.gridOffsetX;
    const offY = this.gridOffsetY;
    const size = this.tileSize;

    // Clear background
    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, W, H);

    // 1. Draw 11 External Perimeter System Boxes & Stubs
    this.drawPerimeterSystems(ctx);

    // 2. Draw 10x10 Grid Tiles & Conduits
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        const tile = this.grid.tiles[r][c];
        const x = offX + c * size;
        const y = offY + r * size;
        this.drawTile(ctx, tile, x, y, size);
      }
    }

    // Outer grid border line
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.strokeRect(offX, offY, this.gridCols * size, this.gridRows * size);

    // 3. Draw Dual Power & Coolant Circulation Dots
    const powerPaths = this.powerMap?.powerPaths || {};
    const coolantPaths = this.powerMap?.coolantPaths || {};
    const dualRes = computeDualCarrierSegments(powerPaths, coolantPaths, {
      gridOffsetX: offX,
      gridOffsetY: offY,
      tileSize: size,
    });

    this.drawCirculationDots(
      ctx,
      dualRes.powerPolylines,
      dualRes.coolantPolylines,
      dualRes.sharedSegments,
      dualRes.segmentNormals,
      this._animTime
    );

    // 4. Draw Active Repair Drones on grid
    if (this.drones) {
      for (const drone of this.drones) {
        this.drawDrone(ctx, drone);
      }
    }
  }

  /**
   * Draws 11 external perimeter subsystem boxes with stubs and live power/coolant bars.
   */
  drawPerimeterSystems(ctx) {
    const offX = this.gridOffsetX;
    const offY = this.gridOffsetY;
    const size = this.tileSize;
    const powerMap = this.powerMap || {};
    const coolantMap = this.coolantMap || powerMap.coolantMap || powerMap.coolant || {};
    const boostedArr = this.grid?.boostedSystems || this.powerMap?.boostedSystems || this.ship?.grid?.boostedSystems || [];
    const boostedSet = new Set(Array.isArray(boostedArr) ? boostedArr : []);

    for (const sys of EXTERNAL_SYSTEMS) {
      const box = getPerimeterBoxRect(sys, offX, offY, size, this.protrusion);
      if (!box) continue;

      const pwr = powerMap[sys.key] || 0;
      const col = coolantMap[sys.key] || 0;
      const isPowerActive = pwr > 0;
      const isCoolantActive = col > 0;
      const isBoosted = boostedSet.has(sys.key);
      const isDisconnected = !isPowerActive && !isCoolantActive;

      // Draw connecting conduit stubs into the 2 border cells
      ctx.lineWidth = 6;
      ctx.strokeStyle = (isPowerActive && isCoolantActive)
        ? '#38bdf8'
        : (isPowerActive ? '#38bdf8' : (isCoolantActive ? '#22c55e' : '#1e293b'));

      for (const [cr, cc] of sys.cells) {
        const cellCenterX = offX + cc * size + size / 2;
        const cellCenterY = offY + cr * size + size / 2;

        ctx.beginPath();
        if (sys.side === 'N') {
          ctx.moveTo(cellCenterX, offY);
          ctx.lineTo(cellCenterX, cellCenterY);
        } else if (sys.side === 'S') {
          ctx.moveTo(cellCenterX, offY + 10 * size);
          ctx.lineTo(cellCenterX, cellCenterY);
        } else if (sys.side === 'W') {
          ctx.moveTo(offX, cellCenterY);
          ctx.lineTo(cellCenterX, cellCenterY);
        } else if (sys.side === 'E') {
          ctx.moveTo(offX + 10 * size, cellCenterY);
          ctx.lineTo(cellCenterX, cellCenterY);
        }
        ctx.stroke();
      }

      // Box background & border
      ctx.fillStyle = '#0b1120';
      ctx.fillRect(box.x + 2, box.y + 2, box.width - 4, box.height - 4);

      if (isBoosted) {
        ctx.fillStyle = isDisconnected ? 'rgba(180, 83, 9, 0.15)' : 'rgba(245, 158, 11, 0.18)';
        ctx.fillRect(box.x + 2, box.y + 2, box.width - 4, box.height - 4);

        ctx.strokeStyle = isDisconnected ? '#b45309' : '#f59e0b';
        ctx.lineWidth = 2.0;
      } else {
        ctx.strokeStyle = isPowerActive ? '#38bdf8' : (isCoolantActive ? '#22c55e' : '#1e293b');
        ctx.lineWidth = 1.5;
      }
      ctx.strokeRect(box.x + 2, box.y + 2, box.width - 4, box.height - 4);

      // Label text
      const midX = box.x + box.width / 2;
      const midY = box.y + box.height / 2;

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sys.short || sys.label, midX, isBoosted ? box.y + 13 : box.y + 16);

      if (isBoosted) {
        ctx.font = 'bold 9px monospace';
        ctx.fillStyle = isDisconnected ? '#b45309' : '#f59e0b';
        ctx.textAlign = 'center';
        ctx.fillText('BOOST', midX, box.y + 24);
      }

      // Power % Bar & Text
      const pwrPct = Math.round(pwr * 100);
      const barW = Math.min(box.width - 16, 72);
      const barH = 5;
      const barX = midX - barW / 2;

      // Power bar normalized to 1.2 max with amber overcharge when > 1.0
      const pwrBarY = box.y + (isBoosted ? 36 : 32);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(barX, pwrBarY, barW, barH);

      const pwrRatio = Math.max(0, Math.min(1.0, pwr / 1.2));
      ctx.fillStyle = pwr > 1.0 ? '#f59e0b' : '#38bdf8';
      ctx.fillRect(barX, pwrBarY, barW * pwrRatio, barH);

      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = pwr > 1.0 ? '#fbbf24' : '#38bdf8';
      ctx.textAlign = 'center';
      ctx.fillText(`PWR ${pwrPct}%`, midX, pwrBarY + 11);

      // Coolant % Bar & Text normalized to 1.2 max with amber overcharge when > 1.0
      const colPct = Math.round(col * 100);
      const colBarY = box.y + (isBoosted ? 57 : 54);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(barX, colBarY, barW, barH);

      const colRatio = Math.max(0, Math.min(1.0, col / 1.2));
      ctx.fillStyle = col > 1.0 ? '#f59e0b' : '#22c55e';
      ctx.fillRect(barX, colBarY, barW * colRatio, barH);

      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = col > 1.0 ? '#fbbf24' : '#22c55e';
      ctx.textAlign = 'center';
      ctx.fillText(`COL ${colPct}%`, midX, colBarY + 11);
    }
  }

  /**
   * Draws a single conduit tile on the 10x10 matrix.
   */
  drawTile(ctx, tile, x, y, size) {
    // Tile base background
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(x + 1, y + 1, size - 2, size - 2);

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

    const cx = x + size / 2;
    const cy = y + size / 2;

    const isPowered = Boolean(tile.powerFlow || (tile.allocatedPower || 0) > 0);
    const isCoolant = Boolean(tile.coolantFlow);

    // Pipe Track Color
    let conduitColor = '#334155';
    if (isPowered && isCoolant) {
      conduitColor = '#38bdf8';
    } else if (isPowered) {
      conduitColor = '#38bdf8';
    } else if (isCoolant) {
      conduitColor = '#22c55e';
    }

    // 1. Draw Tile Specific Types
    switch (tile.type) {
      case 'reactor': {
        const pulse = 0.8 + 0.2 * Math.sin(this._animTime * 4);
        ctx.fillStyle = `rgba(14, 165, 233, ${pulse})`;
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('REACTOR', cx, cy);
        return;
      }

      case 'coolant': {
        const pulse = 0.8 + 0.2 * Math.sin(this._animTime * 3);
        ctx.fillStyle = `rgba(34, 197, 94, ${pulse})`;
        ctx.beginPath();
        ctx.arc(cx, cy, size * 0.36, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('COOLANT', cx, cy);
        return;
      }

      case 'capacitor': {
        this.drawCapacitor(ctx, cx, cy, size, tile, conduitColor);
        break;
      }

      case 'straight': {
        this.drawStraightConduit(ctx, cx, cy, size, tile.orientation, conduitColor, isPowered, isCoolant);
        break;
      }

      case 'elbow': {
        this.drawElbowConduit(ctx, cx, cy, size, tile.orientation, conduitColor, isPowered, isCoolant);
        break;
      }

      case 't_split': {
        this.drawTSplitConduit(ctx, cx, cy, size, tile.orientation, conduitColor, isPowered, isCoolant);
        break;
      }

      case 'cross_bridge': {
        this.drawCrossBridge(ctx, cx, cy, size, conduitColor, isPowered, isCoolant);
        break;
      }

      case 'empty':
      default:
        break;
    }

    // 2. Broken / Burning Tile Hazard Overlay
    if (tile.status === 'broken' || tile.status === 'burning') {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
      ctx.fillRect(x + 2, y + 2, size - 4, size - 4);

      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4);
      ctx.lineTo(x + size - 4, y + size - 4);
      ctx.moveTo(x + size - 4, y + 4);
      ctx.lineTo(x + 4, y + size - 4);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('BROKEN', cx, cy + size * 0.28);
    }

    // 3. EMP Blackout Overlay
    if ((tile.empTimer || 0) > 0) {
      ctx.fillStyle = 'rgba(147, 51, 234, 0.5)';
      ctx.fillRect(x + 2, y + 2, size - 4, size - 4);

      ctx.fillStyle = '#e9d5ff';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`EMP ${(tile.empTimer).toFixed(1)}s`, cx, cy);
    }
  }

  drawStraightConduit(ctx, cx, cy, size, orientation, color, isPowered, isCoolant) {
    // Outer pipe track
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    if (orientation === 0) {
      ctx.moveTo(cx, cy - size / 2);
      ctx.lineTo(cx, cy + size / 2);
    } else {
      ctx.moveTo(cx - size / 2, cy);
      ctx.lineTo(cx + size / 2, cy);
    }
    ctx.stroke();

    // Lit pipe core
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawElbowConduit(ctx, cx, cy, size, orientation, color, isPowered, isCoolant) {
    // Outer pipe track
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    if (orientation === 0) {
      ctx.moveTo(cx, cy - size / 2);
      ctx.quadraticCurveTo(cx, cy, cx + size / 2, cy);
    } else if (orientation === 1) {
      ctx.moveTo(cx + size / 2, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy + size / 2);
    } else if (orientation === 2) {
      ctx.moveTo(cx, cy + size / 2);
      ctx.quadraticCurveTo(cx, cy, cx - size / 2, cy);
    } else {
      ctx.moveTo(cx - size / 2, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy - size / 2);
    }
    ctx.stroke();

    // Lit pipe core
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawTSplitConduit(ctx, cx, cy, size, orientation, color, isPowered, isCoolant) {
    // Outer pipe track
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    if (orientation === 0) {
      ctx.moveTo(cx, cy - size / 2);
      ctx.lineTo(cx, cy + size / 2);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + size / 2, cy);
    } else if (orientation === 1) {
      ctx.moveTo(cx - size / 2, cy);
      ctx.lineTo(cx + size / 2, cy);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + size / 2);
    } else if (orientation === 2) {
      ctx.moveTo(cx, cy - size / 2);
      ctx.lineTo(cx, cy + size / 2);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - size / 2, cy);
    } else {
      ctx.moveTo(cx - size / 2, cy);
      ctx.lineTo(cx + size / 2, cy);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy - size / 2);
    }
    ctx.stroke();

    // Lit pipe core
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawCrossBridge(ctx, cx, cy, size, color, isPowered, isCoolant) {
    // Outer pipe track
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size / 2);
    ctx.lineTo(cx, cy + size / 2);
    ctx.moveTo(cx - size / 2, cy);
    ctx.lineTo(cx + size / 2, cy);
    ctx.stroke();

    // Lit pipe core
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  drawCapacitor(ctx, cx, cy, size, tile, color) {
    ctx.strokeStyle = tile.discharging ? '#eab308' : color;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 15, cy - 15, 30, 30);

    const chargePct = Math.min(1, (tile.charge || 0) / (tile.maxCharge || 20));
    ctx.fillStyle = tile.discharging ? '#facc15' : '#38bdf8';
    ctx.fillRect(cx - 13, cy + 13 - (26 * chargePct), 26, 26 * chargePct);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CAP', cx, cy - 4);
    ctx.fillText(tile.discharging ? 'SURGE' : `${Math.round(tile.charge || 0)}`, cx, cy + 6);
  }

  /**
   * Draws animated shortest-path flow dots for both Power (Cyan #38bdf8) and Coolant (Emerald #22c55e).
   * Shared conduit segments apply opposite lateral offsets (+3.5px / -3.5px) and staggered phase (0 / 14px).
   */
  drawCirculationDots(ctx, powerPolylines, coolantPolylines, sharedSegments, segmentNormals, animTime) {
    const drawCarrierDots = (polylines, carrierType, color) => {
      for (const poly of polylines) {
        if (!poly || poly.length < 2) continue;

        const cumDists = [0];
        for (let i = 0; i < poly.length - 1; i++) {
          const d = Math.hypot(poly[i + 1].x - poly[i].x, poly[i + 1].y - poly[i].y);
          cumDists.push(cumDists[i] + d);
        }
        const totalLen = cumDists[cumDists.length - 1];
        if (totalLen <= 0) continue;

        const dotSpeed = DOT_SPEED; // 48 px/s
        const dotSpacing = DOT_SPACING; // 28 px
        const phaseShift = (carrierType === 'coolant') ? (0.5 * dotSpacing) : 0; // 14px phase
        const baseOffset = (animTime * dotSpeed);

        const count = Math.ceil(totalLen / dotSpacing);
        for (let k = 0; k < count; k++) {
          let rawDist = (baseOffset + phaseShift + k * dotSpacing) % totalLen;
          if (rawDist < 0) rawDist += totalLen;

          let segIdx = 0;
          while (segIdx < cumDists.length - 2 && cumDists[segIdx + 1] < rawDist) {
            segIdx++;
          }

          const segStartDist = cumDists[segIdx];
          const segEndDist = cumDists[segIdx + 1];
          const segLen = segEndDist - segStartDist;
          const segFrac = segLen > 0 ? (rawDist - segStartDist) / segLen : 0;

          const pA = poly[segIdx];
          const pB = poly[segIdx + 1];

          let dotX = pA.x + segFrac * (pB.x - pA.x);
          let dotY = pA.y + segFrac * (pB.y - pA.y);

          const seg = normalizeSeg(pA.x, pA.y, pB.x, pB.y);
          const isDual = sharedSegments && sharedSegments.has(seg.key);

          if (isDual) {
            const offset = computeDualCarrierOffset(carrierType, true, seg);
            dotX += offset.offsetX;
            dotY += offset.offsetY;
          }

          ctx.beginPath();
          ctx.arc(dotX, dotY, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 4;
          ctx.fill();
        }
      }
    };

    ctx.save();
    // Power dots (Cyan #38bdf8), phase 0
    drawCarrierDots(powerPolylines, 'power', '#38bdf8');
    // Coolant dots (Emerald #22c55e), phase 0.5 * DOT_SPACING (14px)
    drawCarrierDots(coolantPolylines, 'coolant', '#22c55e');
    ctx.restore();
  }

  /**
   * Draws an active repair drone glyph moving across the 10x10 grid or external subsystem junctions.
   */
  drawDrone(ctx, drone) {
    const col = drone.currentPos?.col ?? drone.currentPos?.y ?? 0;
    const row = drone.currentPos?.row ?? drone.currentPos?.x ?? 0;

    const x = this.gridOffsetX + col * this.tileSize + this.tileSize / 2;
    const y = this.gridOffsetY + row * this.tileSize + this.tileSize / 2;

    ctx.save();
    ctx.translate(x, y);

    const isSelected = this.selectedDroneId === drone.id;
    ctx.fillStyle = isSelected ? '#f59e0b' : (drone.stalled ? '#ef4444' : '#06b6d4');
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${drone.id}`, 0, 0);

    ctx.restore();
  }
}
