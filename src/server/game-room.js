/**
 * BROADSIDE HYPERION — Authoritative 60Hz Game Room Simulation
 *
 * Implements authoritative game lifecycle (lobby -> playing -> gameover),
 * team & station management (instant hot-swapping), drydock configuration,
 * 60Hz simulation step with 5x slow-motion time dilation on killing blow,
 * AI Auto-Crew takeover for unmanned stations, rigid-body physics integration,
 * projectile ballistics, hazard updates, and snapshot serialization.
 */

import { RigidBody } from '../physics/rigid-body.js';
import { ConduitGrid10x10 } from '../systems/grid-10x10.js';
import { DroneManager } from '../systems/drones.js';
import {
  MAX_PITCH_RAD,
  ARENA_RADIUS,
  SHIP_PACING_SCALE,
  MAX_SPIN_RATE,
  DAMPENING_FIELD_WIDTH,
  DAMPENING_FIELD_MAX_RATE,
  clampAngularVelocity,
  computeDampeningFieldStrength,
} from '../physics/constants.js';
import {
  WeaponSystem,
  applyRailgunImpact,
  applyTorpedoImpact,
  calculateLeadTarget,
  damageAsteroid,
} from '../combat/weapons.js';
import { ShieldSystem } from '../combat/shields.js';
import {
  generateSector,
  updateTetherMines,
  updateIonNebulae,
  updateMunitionsDerelict,
  SHIP_SPAWN_POINTS,
  SHIP_SPAWN_ANGLES,
} from '../world/sector-generator.js';
import { checkCircleCollision, resolveImpulse } from '../physics/collisions.js';
import { applyGravity } from '../physics/gravity.js';
import { runAICrewForShip } from './ai-crew.js';
import {
  createHyperspaceState,
  getHyperspaceRestrictions,
  updateHyperspaceState,
  HYPERSPACE_JUMP_DURATION,
  HYPERSPACE_REBOOT_STAGE1_SEC,
  HYPERSPACE_REBOOT_TOTAL_SEC,
} from '../systems/hyperspace.js';

export const REPLAY_MAX_FRAMES = 180; // (~6.0s at 30Hz)
export const REPLAY_FPS = 30;
export const REPLAY_EVENT_TYPES = new Set([
  'laser_fired',
  'railgun_fired',
  'torpedo_launched',
  'flak_burst',
  'laser_hit',
  'railgun_hit',
  'torpedo_hit',
  'asteroid_hit',
  'asteroid_destroyed',
  'collision',
  'tether_mine_detonated',
  'killing_blow',
  'hyperspace_enter',
  'hyperspace_exit',
  'hyperspace_reboot_stage1',
  'hyperspace_reboot_complete',
]);

export class GameRoom {
  /**
   * @param {object} [options={}]
   * @param {string} [options.id='room_default']
   * @param {number} [options.seed=12345]
   * @param {boolean} [options.aiEnabled=true]
   */
  constructor(options = {}) {
    this.id = options.id || 'room_default';
    this.state = options.state || 'lobby'; // 'lobby' | 'playing' | 'gameover'
    this.tick = 0;
    this.slowMoActive = false;
    this.slowMoTimer = 0.0;
    this.winner = null;
    this.aiEnabled = options.aiEnabled !== undefined ? Boolean(options.aiEnabled) : true;

    // Players collection: playerId -> { id, name, team, station, isSpectator }
    this.players = new Map();
    this.musicOwnerId = null;

    // Drydock loadout configurations
    this.drydock = options.drydock || {
      alpha: {
        hullClass: 'frigate',
        modules: {
          helm: 'overdrive_rcs',
          weapons: 'heavy_torpedoes',
          engineer: 'standard_drones',
        },
      },
      omega: {
        hullClass: 'frigate',
        modules: {
          helm: 'overdrive_rcs',
          weapons: 'heavy_torpedoes',
          engineer: 'standard_drones',
        },
      },
    };

    this.seed = options.seed || 12345;
    this.sector = generateSector(this.seed);
    if (!this.sector.dynamicDebrisChunks) {
      this.sector.dynamicDebrisChunks = [];
    }
    if (this.sector.gravityWells) {
      for (const w of this.sector.gravityWells) {
        if (w.pos) {
          w.x = w.pos.x;
          w.y = w.pos.y;
        }
      }
    }

    // Ship entities for alpha and omega (CCW tangents: Alpha faces South, Omega faces North)
    this.ships = {
      alpha: this.createShip('alpha', this.drydock.alpha, SHIP_SPAWN_POINTS[0], SHIP_SPAWN_ANGLES[0]),
      omega: this.createShip('omega', this.drydock.omega, SHIP_SPAWN_POINTS[1], SHIP_SPAWN_ANGLES[1]),
    };

    this.projectiles = [];
    this.events = [];
    this.recentEventsBuffer = [];

    // Replay ring buffer & 30Hz playback state (Phase 14)
    this.replayBuffer = [];
    this.replayFrames = [];
    this.replayActive = false;
    this.replayComplete = false;
    this.replayCursor = 0;
    this.replayElapsed = 0;
    this._replayPendingEvents = [];
  }

  /**
   * Pushes a simulation event to both the single-tick event list, the 30Hz snapshot buffer,
   * and the replay ring buffer event collector if matching REPLAY_EVENT_TYPES.
   *
   * @param {object} ev - Event payload
   */
  emitEvent(ev) {
    this.events.push(ev);
    this.recentEventsBuffer.push(ev);
    if (REPLAY_EVENT_TYPES.has(ev.type) && !this._replayPendingEvents.includes(ev)) {
      this._replayPendingEvents.push(ev);
    }
  }

  /**
   * Constructs a ship entity wrapping physics, systems, combat, and input state.
   *
   * @param {string} team - 'alpha' | 'omega'
   * @param {object} config - { hullClass, modules }
   * @param {object} [spawnPos] - { x, y }
   * @param {number} [spawnAngle] - radians
   * @returns {object} ship entity
   */
  createShip(team, config, spawnPos = null, spawnAngle = null) {
    const hullClass = config.hullClass || 'frigate';
    const modules = config.modules || {
      helm: 'overdrive_rcs',
      weapons: 'heavy_torpedoes',
      engineer: 'standard_drones',
    };

    const defaultPos = team === 'alpha' ? SHIP_SPAWN_POINTS[0] : SHIP_SPAWN_POINTS[1];
    const defaultAngle = team === 'alpha' ? SHIP_SPAWN_ANGLES[0] : SHIP_SPAWN_ANGLES[1];
    const pos = spawnPos || defaultPos;
    const angle = spawnAngle != null ? spawnAngle : defaultAngle;

    const body = new RigidBody(hullClass, {
      x: pos.x,
      y: pos.y,
      angle,
      modules,
    });
    body.id = team;

    const grid = new ConduitGrid10x10(hullClass, modules);
    const drones = new DroneManager(modules.engineer);
    const weapons = new WeaponSystem(hullClass, modules.weapons);
    const shields = new ShieldSystem(hullClass);

    body.weaponsRef = weapons;
    weapons.railgunAngle = angle;
    weapons.railgunTargetAngle = angle;
    weapons.railgunLocalAngle = 0;

    // Initial power flow solve
    const powerMap = grid.solvePowerFlow();
    shields.updatePower(powerMap);

    return {
      id: team,
      name: team === 'alpha' ? 'UNS HYPERION' : 'KRS VANGUARD',
      team,
      hullClass,
      hull: body.hull,
      modules,
      hullHp: body.hullHp,
      maxHullHp: body.maxHullHp,
      armor: body.armor,
      destroyed: false,
      get pos() { return body.pos; },
      set pos(val) { body.pos = val; },
      get vel() { return body.vel; },
      set vel(val) { body.vel = val; },
      get angle() { return body.angle; },
      set angle(val) { body.angle = val; },
      get omega() { return body.omega; },
      set omega(val) { body.omega = val; },
      get rollState() { return body.rollState; },
      set rollState(val) { body.rollState = val; },
      get rollAngle() { return body.rollAngle; },
      set rollAngle(val) { body.rollAngle = val; },
      get rollOmega() { return body.rollOmega; },
      set rollOmega(val) { body.rollOmega = val; },
      get stopRollActive() { return body.stopRollActive; },
      set stopRollActive(val) { body.stopRollActive = val; },
      get autoOrientMode() { return body.autoOrientMode; },
      set autoOrientMode(val) { body.autoOrientMode = val; },
      get thrusters() { return body.thrusters; },
      get mainDrive() { return body.mainDrive; },
      body,
      grid,
      drones,
      weapons,
      shields,
      powerMap,
      helmInput: { forward: 0, rcsForward: 0, strafe: 0, turn: 0, roll: 0, pitch: 0, mainThrottle: 0 },
      weaponsInput: {
        aimAngle: angle,
        aimPitch: 0,
        firingLaser: false,
        chargingRailgun: false,
        targetedSubsystem: null,
      },
      weaponsState: {
        aimAngle: angle,
        aimPitch: 0,
      },
      turretAngle: angle,
      turretPitch: 0,
      leadTarget: null,
      inNebula: false,
      dampeningFactor: 0,
      inDampeningField: false,
      hyperspace: createHyperspaceState(),
    };
  }

  /**
   * Ensures an active spectator player owns background music playback.
   * Keeps existing ownership if owner is still an active spectator.
   *
   * @param {string|null} [preferredPlayerId=null]
   * @returns {string|null} active musicOwnerId
   */
  ensureMusicOwner(preferredPlayerId = null) {
    if (this.musicOwnerId) {
      const current = this.players.get(this.musicOwnerId);
      if (current && current.isSpectator === true) {
        return this.musicOwnerId;
      }
    }

    if (preferredPlayerId) {
      const preferred = this.players.get(preferredPlayerId);
      if (preferred && preferred.isSpectator === true) {
        this.musicOwnerId = preferredPlayerId;
        return this.musicOwnerId;
      }
    }

    for (const p of this.players.values()) {
      if (p.isSpectator === true) {
        this.musicOwnerId = p.id;
        return this.musicOwnerId;
      }
    }

    this.musicOwnerId = null;
    return null;
  }

  /**
   * Registers a player as a spectator and sets up music ownership.
   *
   * @param {string} playerId
   * @returns {boolean} True if player is now the active music owner
   */
  registerSpectator(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;

    player.isSpectator = true;
    player.station = null;
    this.cleanUpVacatedStations();
    this.ensureMusicOwner(playerId);
    return this.musicOwnerId === playerId;
  }

  /**
   * Adds a player to the room.
   */
  addPlayer(id, name, options = {}) {
    const player = {
      id,
      name: name || 'Player_' + String(id).slice(0, 4),
      team: options.team || 'alpha',
      station: options.station || null,
      isSpectator: Boolean(options.isSpectator),
    };
    this.players.set(id, player);
    if (player.isSpectator) {
      this.ensureMusicOwner(id);
    }
    return player;
  }

  /**
   * Removes a player from the room.
   */
  removePlayer(id) {
    const res = this.players.delete(id);
    if (this.musicOwnerId === id) {
      this.ensureMusicOwner();
    }
    this.cleanUpVacatedStations();
    return res;
  }

  /**
   * Cleans up vacated station continuous inputs when leaving or switching stations:
   * If no remaining player occupies 'weapons', clears ship.weaponsInput.firingLaser = false;
   * If 'playing' and no remaining player occupies 'helm', zeroes continuous ship.helmInput
   * (forward/strafe/turn/roll/mainThrottle = 0) without altering autoOrientMode/sasActive.
   */
  cleanUpVacatedStations() {
    for (const team of ['alpha', 'omega']) {
      const ship = this.ships?.[team];
      if (!ship) continue;

      let hasWeaponsPlayer = false;
      let hasHelmPlayer = false;

      for (const p of this.players.values()) {
        if (!p.isSpectator && p.team === team) {
          if (p.station === 'weapons') hasWeaponsPlayer = true;
          if (p.station === 'helm') hasHelmPlayer = true;
        }
      }

      if (!hasWeaponsPlayer && ship.weaponsInput) {
        ship.weaponsInput.firingLaser = false;
      }

      if (!hasHelmPlayer && this.state === 'playing' && ship.helmInput) {
        ship.helmInput.forward = 0;
        ship.helmInput.rcsForward = 0;
        ship.helmInput.strafe = 0;
        ship.helmInput.turn = 0;
        ship.helmInput.roll = 0;
        ship.helmInput.pitch = 0;
        ship.helmInput.mainThrottle = 0;
      }
    }
  }

  /**
   * Assigns a player to a specific team and station.
   * Supports instant hot-swapping both in lobby and mid-match.
   */
  joinStation(playerId, team, station) {
    const player = this.players.get(playerId);
    if (!player) return false;

    // If another player was at this team/station, unseat them
    for (const [otherId, other] of this.players) {
      if (otherId !== playerId && other.team === team && other.station === station) {
        other.station = null;
      }
    }

    player.team = team;
    player.station = station;
    player.isSpectator = false;

    if (this.musicOwnerId === playerId) {
      this.ensureMusicOwner();
    }

    this.cleanUpVacatedStations();
    return true;
  }

  /**
   * Updates drydock loadout configuration for a team.
   */
  configureDrydock(team, config = {}) {
    if (!this.drydock[team]) return false;

    if (config.hullClass) {
      this.drydock[team].hullClass = config.hullClass;
    }
    if (config.modules) {
      this.drydock[team].modules = {
        ...this.drydock[team].modules,
        ...config.modules,
      };
    }

    // Rebuild the ship entity if match is in lobby or not started
    if (this.state === 'lobby') {
      const currentPos = { ...this.ships[team].body.pos };
      const currentAngle = this.ships[team].body.angle;
      this.ships[team] = this.createShip(team, this.drydock[team], currentPos, currentAngle);
    }

    return true;
  }

  /**
   * Initializes a new match with sector procedural generation and initial spawns.
   */
  startMatch(seed = Date.now()) {
    const wasLobby = this.state === 'lobby';
    const prevAlpha = this.ships?.alpha;
    const prevOmega = this.ships?.omega;

    this.seed = seed;
    this.sector = generateSector(this.seed);
    this.sector.dynamicDebrisChunks = [];
    if (this.sector.gravityWells) {
      for (const w of this.sector.gravityWells) {
        if (w.pos) {
          w.x = w.pos.x;
          w.y = w.pos.y;
        }
      }
    }

    // Alpha spawns at SHIP_SPAWN_POINTS[0] facing South (+PI/2, CCW tangent)
    this.ships.alpha = this.createShip('alpha', this.drydock.alpha, SHIP_SPAWN_POINTS[0], SHIP_SPAWN_ANGLES[0]);
    // Omega spawns at SHIP_SPAWN_POINTS[1] facing North (-PI/2, CCW tangent)
    this.ships.omega = this.createShip('omega', this.drydock.omega, SHIP_SPAWN_POINTS[1], SHIP_SPAWN_ANGLES[1]);

    // If transitioning from lobby, preserve pre-game grid configuration, target subsystem, SAS, and auto-orient
    if (wasLobby) {
      for (const team of ['alpha', 'omega']) {
        const prevShip = team === 'alpha' ? prevAlpha : prevOmega;
        const nextShip = this.ships[team];
        if (
          prevShip &&
          prevShip.hullClass === nextShip.hullClass &&
          prevShip.modules?.engineer === nextShip.modules?.engineer
        ) {
          nextShip.grid = prevShip.grid;
          nextShip.powerMap = nextShip.grid.solvePowerFlow();
          nextShip.shields?.updatePower?.(nextShip.powerMap);
        }
        if (prevShip?.weapons?.targetedSubsystem) {
          nextShip.weapons.targetedSubsystem = prevShip.weapons.targetedSubsystem;
          nextShip.weaponsInput.targetedSubsystem = prevShip.weapons.targetedSubsystem;
        }
        if (prevShip?.body?.sasActive !== undefined) {
          nextShip.body.toggleSas(prevShip.body.sasActive);
        }
        if (prevShip?.body?.autoOrientMode) {
          nextShip.body.setAutoOrientMode(prevShip.body.autoOrientMode);
        }
      }
    }

    this.projectiles = [];
    this.events = [];
    this.recentEventsBuffer = [];
    this.tick = 0;
    this.slowMoTimer = 0.0;
    this.slowMoActive = false;
    this.winner = null;
    this.state = 'playing';

    // Reset replay buffer & playback state (Phase 14)
    this.replayBuffer = [];
    this.replayFrames = [];
    this.replayActive = false;
    this.replayComplete = false;
    this.replayCursor = 0;
    this.replayElapsed = 0;
    this._replayPendingEvents = [];

    return true;
  }

  /**
   * Restarts the match with a new or given seed.
   */
  restartMatch(seed = Date.now()) {
    this.state = 'restarting';
    this.replayBuffer = [];
    this.replayFrames = [];
    this.replayActive = false;
    this.replayComplete = false;
    this.replayCursor = 0;
    this.replayElapsed = 0;
    this._replayPendingEvents = [];
    return this.startMatch(seed);
  }

  /**
   * Checks which stations on a team currently have no human players assigned.
   */
  getUnmannedStations(team) {
    const unmanned = { helm: true, weapons: true, engineer: true };
    for (const player of this.players.values()) {
      if (player.team === team && player.station && !player.isSpectator) {
        if (player.station in unmanned) {
          unmanned[player.station] = false;
        }
      }
    }
    return unmanned;
  }

  /**
   * Returns true if the match is in a terminal (ended or restarting) state.
   * In terminal states, live station inputs are authoritatively rejected.
   *
   * @returns {boolean}
   */
  isTerminalMatchState() {
    return this.state === 'gameover' || this.state === 'game_over' || this.state === 'restarting' || Boolean(this.replayActive);
  }

  /**
   * Resets and stops all transient active pilot/gunner inputs on a ship entity.
   *
   * @param {object} ship
   */
  clearShipActiveInputs(ship) {
    if (!ship) return;
    if (ship.weaponsInput) {
      ship.weaponsInput.firingLaser = false;
      ship.weaponsInput.chargingRailgun = false;
    }
    if (ship.weapons) {
      ship.weapons.charging = false;
      if (typeof ship.weapons.stopRailgunCharge === 'function') {
        ship.weapons.stopRailgunCharge();
      }
    }
    if (ship.helmInput) {
      ship.helmInput.forward = 0;
      ship.helmInput.rcsForward = 0;
      ship.helmInput.strafe = 0;
      ship.helmInput.turn = 0;
      ship.helmInput.roll = 0;
      ship.helmInput.pitch = 0;
      ship.helmInput.mainThrottle = 0;
    }
    if (ship.body) {
      ship.body.turnAndBurn = false;
      if (typeof ship.body.commandPilot === 'function') {
        ship.body.commandPilot(ship.helmInput);
      }
    }
  }

  /**
   * Handles incoming client action messages.
   */
  handleClientMessage(playerId, msg = {}) {
    if (!msg || typeof msg !== 'object') return false;

    const player = this.players.get(playerId);

    switch (msg.type || msg.action) {
      case 'register_spectator':
      case 'claim_music': {
        return this.registerSpectator(playerId);
      }

      case 'join_station': {
        if (msg.name && player) player.name = msg.name;
        return this.joinStation(playerId, msg.team, msg.station);
      }

      case 'switch_station': {
        if (!player) return false;
        const team = msg.team || player.team || 'alpha';
        if (msg.name) player.name = msg.name;
        return this.joinStation(playerId, team, msg.station);
      }

      case 'drydock_loadout': {
        const team = msg.team || player?.team;
        if (!team) return false;
        return this.configureDrydock(team, {
          hullClass: msg.hullClass,
          modules: msg.modules,
        });
      }

      case 'toggle_bots': {
        this.aiEnabled = Boolean(msg.enabled);
        return this.aiEnabled;
      }

      case 'start_match': {
        return this.startMatch(msg.seed || Date.now());
      }

      case 'restart_match': {
        return this.restartMatch(msg.seed || Date.now());
      }

      case 'update_name': {
        if (!player) return false;
        if (msg.name) player.name = String(msg.name);
        return true;
      }

      case 'helm_input': {
        if (this.isTerminalMatchState()) return false;
        if (!player || player.station !== 'helm') return false;
        if (!player.team) player.team = 'alpha';
        const ship = this.ships[player.team];
        if (!ship || ship.destroyed || (ship.hullHp !== undefined && ship.hullHp <= 0)) {
          this.clearShipActiveInputs(ship);
          return false;
        }

        const r = getHyperspaceRestrictions(ship);

        // Edge-triggered toggleHyperspace
        if (msg.toggleHyperspace === true) {
          if (
            this.state === 'playing' &&
            ship.hyperspace?.state === 'ready' &&
            !ship.destroyed &&
            (ship.powerMap?.hyperspace || 0) > 0 &&
            (ship.hyperspace?.health ?? 100) > 0
          ) {
            ship.hyperspace.state = 'charging';
            ship.hyperspace.charge = 0;
          } else if (ship.hyperspace?.state === 'charging') {
            ship.hyperspace.state = 'ready';
            ship.hyperspace.charge = 0;
          }
        }

        // When !r.enginesOnline: ignore throttle, forward, boost
        if (r.enginesOnline) {
          if (msg.forward !== undefined) ship.helmInput.forward = Math.max(0, Math.min(1, Number(msg.forward) || 0));
          else if (msg.mainThrottle !== undefined) ship.helmInput.forward = Math.max(0, Math.min(1, Number(msg.mainThrottle) || 0));
          else if (msg.throttle !== undefined) ship.helmInput.forward = Math.max(0, Math.min(1, Number(msg.throttle) || 0));
          ship.helmInput.mainThrottle = ship.helmInput.forward;
        } else {
          ship.helmInput.forward = 0;
          ship.helmInput.mainThrottle = 0;
        }

        // When !r.rcsOnline: ignore turn, roll, pitch, strafe, stopRoll
        if (r.rcsOnline) {
          if (msg.rcsForward !== undefined) ship.helmInput.rcsForward = Math.max(-1, Math.min(1, Number(msg.rcsForward) || 0));
          if (msg.strafe !== undefined) ship.helmInput.strafe = Math.max(-1, Math.min(1, Number(msg.strafe) || 0));
          if (msg.turn !== undefined) ship.helmInput.turn = Math.max(-1, Math.min(1, Number(msg.turn) || 0));
          if (msg.roll !== undefined) ship.helmInput.roll = Math.max(-1, Math.min(1, Number(msg.roll) || 0));
          if (msg.pitch !== undefined) ship.helmInput.pitch = Math.max(-1, Math.min(1, Number(msg.pitch) || 0));
        } else {
          ship.helmInput.rcsForward = 0;
          ship.helmInput.strafe = 0;
          ship.helmInput.turn = 0;
          ship.helmInput.roll = 0;
          ship.helmInput.pitch = 0;
        }

        const currentAutoOrient = ship.body.autoOrientMode;
        if (msg.autoOrientMode !== undefined || msg.toggleAutoOrient) {
          ship.helmInput.turn = 0;
          ship.helmInput.pitch = 0;
        }

        // When !r.sasOnline: reject turnAndBurn, autoOrientMode, sasToggle
        if (r.sasOnline) {
          if (msg.toggleTurnAndBurn) {
            if (ship.body.turnAndBurn) {
              ship.body.cancelTurnAndBurn();
            } else {
              ship.helmInput.forward = 0;
              ship.helmInput.rcsForward = 0;
              ship.helmInput.mainThrottle = 0;
              ship.helmInput.strafe = 0;
              ship.helmInput.turn = 0;
              ship.helmInput.roll = 0;
              ship.helmInput.pitch = 0;
              ship.body.startTurnAndBurn();
            }
          }

          if (msg.stopRoll && r.rcsOnline) {
            ship.helmInput.roll = 0;
            ship.body.stopRoll(true);
          }
          if (msg.autoOrientMode !== undefined) {
            ship.body.setAutoOrientMode(msg.autoOrientMode);
          }
          if (msg.toggleAutoOrient) {
            const nextMode = currentAutoOrient === msg.toggleAutoOrient ? null : msg.toggleAutoOrient;
            ship.body.setAutoOrientMode(nextMode);
          }
          if (msg.sasActive !== undefined) {
            ship.body.toggleSas(Boolean(msg.sasActive));
          } else if (msg.toggleSas === true) {
            ship.body.toggleSas(!ship.body.sasActive);
          } else if (msg.toggleSas === false) {
            ship.body.toggleSas(false);
          }
        }

        ship.body.commandPilot(ship.helmInput);
        return true;
      }

      case 'weapons_input': {
        if (this.isTerminalMatchState()) return false;
        if (!player || player.station !== 'weapons') return false;
        if (!player.team) player.team = 'alpha';
        const ship = this.ships[player.team];
        if (!ship || ship.destroyed || (ship.hullHp !== undefined && ship.hullHp <= 0)) {
          if (ship?.weaponsInput) {
            ship.weaponsInput.firingLaser = false;
            ship.weaponsInput.chargingRailgun = false;
          }
          if (ship?.weapons?.charging) {
            ship.weapons.stopRailgunCharge();
          }
          return false;
        }

        const r = getHyperspaceRestrictions(ship);

        if (msg.aimAngle !== undefined) {
          ship.weaponsInput.aimAngle = Number(msg.aimAngle) || 0;
          ship.turretAngle = ship.weaponsInput.aimAngle;
        }
        if (msg.aimPitch !== undefined) {
          ship.weaponsInput.aimPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, Number(msg.aimPitch) || 0));
          ship.turretPitch = ship.weaponsInput.aimPitch;
        }
        if (ship.weaponsState) {
          ship.weaponsState.aimAngle = ship.weaponsInput.aimAngle;
          ship.weaponsState.aimPitch = ship.weaponsInput.aimPitch;
        }
        if (msg.targetSubsystem !== undefined) {
          ship.weaponsInput.targetedSubsystem = msg.targetSubsystem;
          ship.weapons.targetedSubsystem = msg.targetSubsystem;
        }

        if (!r.weaponsOnline) {
          ship.weaponsInput.firingLaser = false;
          ship.weaponsInput.chargingRailgun = false;
          if (ship.weapons.charging) {
            ship.weapons.stopRailgunCharge();
          }
          return true;
        }

        if (this.state === 'playing') {
          if (msg.fireLaser !== undefined) {
            ship.weaponsInput.firingLaser = Boolean(msg.fireLaser);
            if (msg.fireLaser && ship.weapons.cooldown <= 0) {
              const power = ship.powerMap.weapons_laser || 0;
              if (power > 0) {
                const proj = ship.weapons.fireLaser(ship.body, ship.weaponsInput.aimAngle, power, ship.weaponsInput.aimPitch || 0);
                if (proj) {
                  if (!this.projectiles.includes(proj)) this.projectiles.push(proj);
                  this.emitEvent({
                    type: 'laser_fired',
                    shipId: ship.id,
                    pos: { ...ship.body.pos },
                    aimPitch: ship.weaponsInput.aimPitch || 0,
                  });
                }
              }
            }
          }
          if (msg.stopRailgunCharge || msg.chargingRailgun === false) {
            if (ship.weaponsInput) ship.weaponsInput.chargingRailgun = false;
            if (ship.weapons) {
              ship.weapons.charging = false;
              ship.weapons.stopRailgunCharge?.();
            }
          }
          if (msg.startRailgunCharge) {
            const rgPower = ship.powerMap?.weapons_railgun || 0;
            const rgHealth = ship.weapons.railgunHardware?.health ?? 100;
            if (rgPower > 0 && rgHealth > 0 && (ship.weapons.chargeProgress ?? 0) < 1.0) {
              if (ship.weaponsInput) ship.weaponsInput.chargingRailgun = true;
              ship.weapons.startRailgunCharge();
            }
          }
          if (msg.releaseRailgun) {
            if (ship.weaponsInput) ship.weaponsInput.chargingRailgun = false;
            const power = ship.powerMap.weapons_railgun || 0;
            if (ship.weapons.chargeProgress >= 1.0 && ship.weapons.railgunCooldown <= 0) {
              const slug = ship.weapons.releaseRailgun(ship.body, ship.weapons.railgunAngle, power, ship.weapons.railgunPitch || 0);
              if (slug) {
                if (!this.projectiles.includes(slug)) this.projectiles.push(slug);
                this.emitEvent({
                  type: 'railgun_fired',
                  shipId: ship.id,
                  pos: { ...ship.body.pos },
                  railgunAngle: ship.weapons.railgunAngle,
                  railgunPitch: ship.weapons.railgunPitch || 0,
                });
              }
            }
          }
          if (msg.launchTorpedo) {
            const power = ship.powerMap?.weapons_torpedo || 0;
            const targetId = ship.id === 'alpha' ? 'omega' : 'alpha';
            if (power > 0 && ship.weapons.magazine > 0 && ship.weapons.torpedoCooldown <= 0) {
              const torp = ship.weapons.launchTorpedo(ship.body, ship.weaponsInput.aimAngle, targetId, power, ship.weaponsInput.aimPitch || 0);
              if (torp) {
                if (!this.projectiles.includes(torp)) this.projectiles.push(torp);
                this.emitEvent({
                  type: 'torpedo_launched',
                  shipId: ship.id,
                  pos: { ...ship.body.pos },
                  targetId,
                  aimPitch: ship.weaponsInput.aimPitch || 0,
                });
              }
            }
          }
          if (msg.fireFlak) {
            const flakHealth = ship.weapons.flakHardware?.health ?? 100;
            if (ship.weapons.flakCooldown <= 0 && flakHealth > 0) {
              const flakRes = ship.weapons.fireFlak(ship.body, this.projectiles, this.sector.tetherMines);
              this.emitEvent({
                type: 'flak_burst',
                shipId: ship.id,
                pos: { ...ship.body.pos },
                destroyedProjectiles: flakRes.destroyedProjectiles?.length || 0,
                destroyedMines: flakRes.destroyedMines?.length || 0,
              });
            }
          }
        }

        return true;
      }

      case 'engineer_input':
      case 'rotate_tile':
      case 'discharge_capacitor':
      case 'assign_drone_tile':
      case 'assign_drone_subsystem':
      case 'recall_drone':
      case 'toggle_boost':
      case 'set_boost': {
        if (this.isTerminalMatchState()) return false;
        if (!player || player.station !== 'engineer') return false;
        if (!player.team) player.team = 'alpha';
        const ship = this.ships[player.team];
        if (!ship || ship.destroyed || (ship.hullHp !== undefined && ship.hullHp <= 0)) return false;

        const action = msg.actionType || msg.engineerAction || (msg.action !== 'engineer_input' ? msg.action : null) || msg.type;
        if (action === 'rotate_tile') {
          const res = ship.grid.rotateTile(msg.row, msg.col);
          ship.powerMap = ship.grid.solvePowerFlow();
          return res;
        }
        if (action === 'discharge_capacitor') {
          const res = ship.grid.dischargeCapacitor(msg.row, msg.col);
          ship.powerMap = ship.grid.solvePowerFlow();
          return res;
        }
        if (action === 'toggle_boost') {
          const sysKey = msg.subsystemKey || msg.systemKey;
          const res = ship.grid.toggleSystemBoost(sysKey);
          if (res === true) {
            ship.powerMap = ship.grid.solvePowerFlow(ship.hull?.maxReactorPower || ship.grid.defaultReactorCap, 0);
            ship.shields?.updatePower?.(ship.powerMap);
          }
          return res;
        }
        if (action === 'set_boost') {
          const sysKey = msg.subsystemKey || msg.systemKey;
          const res = ship.grid.setSystemBoost(sysKey, Boolean(msg.boosted ?? msg.enabled));
          if (res === true) {
            ship.powerMap = ship.grid.solvePowerFlow(ship.hull?.maxReactorPower || ship.grid.defaultReactorCap, 0);
            ship.shields?.updatePower?.(ship.powerMap);
          }
          return res;
        }
        if (action === 'assign_drone_tile') {
          return ship.drones.assignToTile(msg.droneId, msg.row, msg.col);
        }
        if (action === 'assign_drone_subsystem') {
          return ship.drones.assignToSubsystem(msg.droneId, msg.subsystemKey, ship.grid);
        }
        if (action === 'recall_drone') {
          return ship.drones.recallDrone(msg.droneId);
        }

        return false;
      }

      default:
        return false;
    }
  }

  /**
   * Applies hull damage overflow to 10x10 Engineer grid conduits.
   * Breaks 1 tile per >= 90 HP damage accumulated, up to 3 tiles per hit.
   *
   * @param {object} ship - starship entity
   * @param {number} hullDmg - hull damage amount
   * @returns {Array<object>} broken tiles
   */
  applyHullConduitDamage(ship, hullDmg) {
    if (!ship || ship.destroyed || !hullDmg || hullDmg <= 0) return [];
    ship._conduitDamageAccum = (ship._conduitDamageAccum || 0) + hullDmg;
    const tilesToBreak = Math.min(3, Math.floor(ship._conduitDamageAccum / 90));
    if (tilesToBreak > 0) {
      ship._conduitDamageAccum -= tilesToBreak * 90;
      if (ship.grid && typeof ship.grid.damageRandomTiles === 'function') {
        return ship.grid.damageRandomTiles(tilesToBreak);
      }
    }
    return [];
  }

  /**
   * Applies collision damage to a ship, absorbing damage through directional shields first.
   *
   * @param {object} ship - ship entity
   * @param {{x: number, y: number}} contactPoint - collision contact point in world coordinates
   * @param {number} rawDamage - uncapped collision damage
   * @param {number} [maxCap=120] - damage cap ceiling
   * @returns {number} hull damage dealt
   */
  applyCollisionDamage(ship, contactPoint, rawDamage, maxCap = 120) {
    if (!ship || ship.destroyed || rawDamage <= 0) return 0;
    const cappedDamage = Math.min(maxCap, rawDamage);
    const hitVec = {
      x: contactPoint.x - ship.body.pos.x,
      y: contactPoint.y - ship.body.pos.y,
      z: (contactPoint.z ?? 0) - (ship.body.pos.z ?? 0),
    };
    const hitAngle = Math.atan2(hitVec.y, hitVec.x);
    const quad = typeof ship.body?.getEffectiveQuadrant === 'function'
      ? ship.body.getEffectiveQuadrant(hitVec)
      : undefined;
    const shieldRes = ship.shields.absorbDamage(
      cappedDamage,
      hitAngle,
      ship.body.angle,
      ship.body.rollState,
      quad ? { quadrant: quad } : undefined
    );
    const hullDmg = Math.max(0, shieldRes.overflow - (ship.body.armor || 0) * 0.25);
    ship.hullHp = Math.max(0, ship.hullHp - hullDmg);
    ship.body.hullHp = ship.hullHp;
    this.applyHullConduitDamage(ship, hullDmg);
    return hullDmg;
  }

  /**
   * Authoritative 60Hz simulation step.
   * Executes physics, energy distribution, AI bots, combat ballistics, and collisions.
   *
   * @param {number} [dt=1/60] - timestep in seconds
   */
  step(dt = 1 / 60) {
    if (this.state !== 'playing' && this.state !== 'gameover') {
      return;
    }

    if (this.state === 'gameover') {
      if (this.replayActive) {
        this.replayElapsed += dt;
        const nextCursor = Math.floor(this.replayElapsed * REPLAY_FPS);
        if (nextCursor >= this.replayFrames.length) {
          this.replayActive = false;
          this.replayComplete = true;
          this.replayCursor = Math.max(0, this.replayFrames.length - 1);
        } else {
          this.replayCursor = nextCursor;
        }
      }
      this.events = [];
      this.recentEventsBuffer = [];
      return;
    }

    const wasPlaying = this.state === 'playing';

    // Collect any events emitted prior to step() into replay buffer before clearing
    if (this.events && this.events.length > 0) {
      for (const ev of this.events) {
        if (REPLAY_EVENT_TYPES.has(ev.type) && !this._replayPendingEvents.includes(ev)) {
          this._replayPendingEvents.push(ev);
        }
      }
    }

    // Clear one-shot events from previous tick
    this.events = [];

    // 1. Slow-Motion Time Dilation on Killing Blow:
    // If slowMoTimer > 0, decrement timer and scale step by 0.2 (5x slow-motion)
    let simDt = dt;
    if (this.slowMoTimer > 0) {
      this.slowMoTimer = Math.max(0, this.slowMoTimer - dt);
      this.slowMoActive = this.slowMoTimer > 0;
      simDt = dt * 0.2;

      if (this.slowMoTimer <= 0) {
        this.state = 'gameover';
        for (const s of [this.ships?.alpha, this.ships?.omega]) {
          this.clearShipActiveInputs(s);
        }
      }
    }

    const shipAlpha = this.ships.alpha;
    const shipOmega = this.ships.omega;
    const shipList = [shipAlpha, shipOmega];

    // Keep live AI & ship visibility flags current before AI Crew acts
    this.updateShipSensorFlags(shipAlpha, shipOmega);
    this.updateShipSensorFlags(shipOmega, shipAlpha);

    // 2. AI Auto-Crew execution for unmanned stations
    if (this.aiEnabled && this.state === 'playing') {
      const unmannedAlpha = this.getUnmannedStations('alpha');
      const unmannedOmega = this.getUnmannedStations('omega');

      runAICrewForShip(shipAlpha, shipOmega, this, simDt, unmannedAlpha);
      runAICrewForShip(shipOmega, shipAlpha, this, simDt, unmannedOmega);
    }

    // 3. Update each ship's systems & physics
    for (const ship of shipList) {
      if (ship.destroyed) continue;

      const enemyShip = ship.id === 'alpha' ? shipOmega : shipAlpha;

      // Update Hyperspace State Machine
      const hsEvents = updateHyperspaceState(ship, simDt, {
        sector: this.sector,
        enemyShip,
        rng: this.rng || Math.random,
      });

      let justExitedHyperspace = false;
      for (const evType of hsEvents) {
        if (evType === 'enter_hyperspace') {
          ship.helmInput.forward = 0;
          ship.helmInput.rcsForward = 0;
          ship.helmInput.mainThrottle = 0;
          ship.helmInput.strafe = 0;
          ship.helmInput.turn = 0;
          ship.helmInput.roll = 0;
          ship.helmInput.pitch = 0;
          ship.dampeningFactor = 0;
          ship.inDampeningField = false;
          ship.body.turnAndBurn = false;
          ship.body.autoOrientMode = null;
          ship.weaponsInput.firingLaser = false;
          ship.weaponsInput.chargingRailgun = false;
          if (ship.weapons.charging) {
            ship.weapons.stopRailgunCharge();
          }
          if (this.sector.tetherMines) {
            for (const mine of this.sector.tetherMines) {
              if (mine.tetheredShipId === ship.id) {
                mine.tetheredShipId = null;
              }
            }
          }
          this.emitEvent({
            type: 'hyperspace_enter',
            shipId: ship.id,
            pos: { ...ship.body.pos },
          });
        } else if (evType === 'exit_hyperspace') {
          justExitedHyperspace = true;
          const hs = ship.hyperspace;
          if (hs?.destinationPos) {
            ship.body.pos = { ...hs.destinationPos };
          }
          ship.body.vel = { x: 0, y: 0, z: 0 };
          ship.body.omega = 0;
          ship.body.pitchOmega = 0;
          ship.body.rollOmega = 0;
          if (ship.body.mainDrive) {
            ship.body.mainDrive.throttle = 0;
          }
          for (const thruster of Object.values(ship.body.thrusters || {})) {
            thruster.throttle = 0;
            thruster.isFiring = false;
          }
          ship.body.turnAndBurn = false;
          ship.body.autoOrientMode = null;
          ship.dampeningFactor = 0;
          ship.inDampeningField = false;
          ship.leadTarget = null;
          ship.inNebula = false;
          ship.shields.setSystemOnline(false);
          ship.weaponsInput.firingLaser = false;
          ship.weaponsInput.chargingRailgun = false;
          if (ship.weapons.charging) {
            ship.weapons.stopRailgunCharge();
          }
          this.emitEvent({
            type: 'hyperspace_exit',
            shipId: ship.id,
            pos: { ...ship.body.pos },
          });
        } else if (evType === 'reboot_stage1') {
          this.emitEvent({
            type: 'hyperspace_reboot_stage1',
            shipId: ship.id,
            pos: { ...ship.body.pos },
          });
        } else if (evType === 'reboot_complete') {
          ship.shields.setSystemOnline(true);
          this.emitEvent({
            type: 'hyperspace_reboot_complete',
            shipId: ship.id,
            pos: { ...ship.body.pos },
          });
        }
      }

      const r = this.updateShipSensorFlags(ship, enemyShip);
      ship.shields.setSystemOnline(r.shieldsOnline);

      // Solve 10x10 conduit grid power flow
      ship.powerMap = ship.grid.solvePowerFlow(ship.hull?.maxReactorPower || ship.grid.defaultReactorCap, simDt);
      ship.shields.updatePower(ship.powerMap);

      // Update Repair Drones
      const thrusterList = Object.values(ship.body.thrusters || {});
      const lowestThruster = thrusterList.length > 0
        ? thrusterList.reduce((a, b) => (a.health <= b.health ? a : b))
        : null;

      const subsystemMap = {
        ...ship.body.thrusters,
        main_drive: ship.body.mainDrive,
        mainDrive: ship.body.mainDrive,
        rcs_thrusters: lowestThruster,
        weapons_railgun: ship.weapons.railgunHardware,
        weapons_laser: ship.weapons.laserHardware,
        sas_computer: ship.weapons.stabilizerHardware,
        hyperspace: ship.hyperspace,
        shields_fore: {
          get health() {
            const max = ship.shields?.maxHp?.fore || 100;
            return Math.min(100, Math.max(0, ((ship.shields?.hp?.fore ?? max) / max) * 100));
          },
          set health(val) {
            const max = ship.shields?.maxHp?.fore || 100;
            if (ship.shields && ship.shields.hp) {
              ship.shields.hp.fore = Math.min(max, Math.max(0, (val / 100) * max));
            }
          },
        },
        shields_aft: {
          get health() {
            const max = ship.shields?.maxHp?.aft || 100;
            return Math.min(100, Math.max(0, ((ship.shields?.hp?.aft ?? max) / max) * 100));
          },
          set health(val) {
            const max = ship.shields?.maxHp?.aft || 100;
            if (ship.shields && ship.shields.hp) {
              ship.shields.hp.aft = Math.min(max, Math.max(0, (val / 100) * max));
            }
          },
        },
        shields_port: {
          get health() {
            const max = ship.shields?.maxHp?.port || 100;
            return Math.min(100, Math.max(0, ((ship.shields?.hp?.port ?? max) / max) * 100));
          },
          set health(val) {
            const max = ship.shields?.maxHp?.port || 100;
            if (ship.shields && ship.shields.hp) {
              ship.shields.hp.port = Math.min(max, Math.max(0, (val / 100) * max));
            }
          },
        },
        shields_starboard: {
          get health() {
            const max = ship.shields?.maxHp?.starboard || 100;
            return Math.min(100, Math.max(0, ((ship.shields?.hp?.starboard ?? max) / max) * 100));
          },
          set health(val) {
            const max = ship.shields?.maxHp?.starboard || 100;
            if (ship.shields && ship.shields.hp) {
              ship.shields.hp.starboard = Math.min(max, Math.max(0, (val / 100) * max));
            }
          },
        },
      };
      ship.drones.update(simDt, Boolean(ship.powerMap?.reactorOnline && r.dronesOnline), ship.grid, subsystemMap);

      if (ship.hyperspace.state === 'jumping' || justExitedHyperspace) {
        // Intangible during warp jump or emerging on this tick
        continue;
      }

      // Enforce restrictions on helm input
      if (!r.enginesOnline) {
        ship.helmInput.forward = 0;
        ship.helmInput.mainThrottle = 0;
      }
      if (!r.rcsOnline) {
        ship.helmInput.rcsForward = 0;
        ship.helmInput.strafe = 0;
        ship.helmInput.turn = 0;
        ship.helmInput.roll = 0;
        ship.helmInput.pitch = 0;
      }
      if (!r.sasOnline) {
        ship.body.turnAndBurn = false;
        ship.body.autoOrientMode = null;
        ship.body.sasActive = false;
      }

      // Pilot commands to RigidBody
      ship.body.commandPilot(ship.helmInput);

      // Update railgun traverse articulation
      ship.weapons.updateRailgunTraverse(
        simDt,
        ship.body.angle,
        ship.weaponsInput.aimAngle,
        ship.powerMap,
        ship.body.pitch || 0,
        ship.weaponsInput.aimPitch != null ? ship.weaponsInput.aimPitch : 0
      );
      ship.turretAngle = ship.weapons.railgunAngle;
      ship.turretPitch = ship.weapons.railgunPitch;

      // Update RigidBody kinematics with grid power inputs and thermal coolant scaling
      const rcsCoolant = ship.powerMap?.coolantMap?.rcs_thrusters ?? 1.0;
      const rcsPower = (ship.powerMap?.rcs_thrusters || 0) * (0.4 + 0.6 * Math.max(0, rcsCoolant));
      const mainCoolant = ship.powerMap?.coolantMap?.main_drive ?? 1.0;
      const mainPower = (ship.powerMap?.main_drive || 0) * (0.4 + 0.6 * Math.max(0, mainCoolant));
      const sasCoolant = ship.powerMap?.coolantMap?.sas_computer ?? 1.0;
      const sasRawPower = ((ship.weapons?.stabilizerHardware?.health ?? 100) > 0) ? (ship.powerMap?.sas_computer || 0) : 0;
      const sasPower = sasRawPower * (0.4 + 0.6 * Math.max(0, sasCoolant));

      const enemyKnown = Boolean(
        enemyShip && !enemyShip.destroyed && enemyShip.hullHp > 0 && enemyShip.hyperspace?.state !== 'jumping' && !ship.inNebula && !enemyShip.inNebula
      );
      ship.body.update(
        simDt,
        r.rcsOnline ? rcsPower : 0,
        r.enginesOnline ? mainPower : 0,
        r.sasOnline ? sasPower : 0,
        {
          enemyPos: enemyKnown ? enemyShip.body.pos : null,
          enemyKnown,
          coolantMap: ship.powerMap?.coolantMap,
        }
      );

      // Apply Gravity Wells to ship
      if (this.sector.gravityWells && this.sector.gravityWells.length > 0) {
        applyGravity(ship.body, this.sector.gravityWells, simDt);
      }

      // Recharge shields based on grid power
      if (r.shieldsOnline) {
        ship.shields.recharge(simDt, ship.powerMap);
      }

      // Update weapons (cooling, railgun charge, cooldowns)
      if (r.weaponsOnline) {
        ship.weapons.update(simDt, ship.powerMap);
      } else {
        ship.weapons.update(simDt, {});
      }

      // Continuous laser fire if commanded
      if (this.state === 'playing' && r.weaponsOnline && ship.weaponsInput.firingLaser && ship.weapons.cooldown <= 0) {
        const laserPower = ship.powerMap.weapons_laser || 0;
        if (laserPower > 0) {
          const proj = ship.weapons.fireLaser(ship.body, ship.weaponsInput.aimAngle, laserPower, ship.weaponsInput.aimPitch || 0);
          if (proj) {
            if (!this.projectiles.includes(proj)) this.projectiles.push(proj);
            this.emitEvent({
              type: 'laser_fired',
              shipId: ship.id,
              pos: { ...ship.body.pos },
              aimPitch: ship.weaponsInput.aimPitch || 0,
            });
          }
        }
      }
    }

    // 3b. Calculate Lead Targeting Reticles
    if (shipAlpha && shipOmega) {
      const rAlpha = getHyperspaceRestrictions(shipAlpha);
      const rOmega = getHyperspaceRestrictions(shipOmega);
      const sameNebula = shipAlpha.inNebula && shipOmega.inNebula;

      const alphaCanTarget = Boolean(
        rAlpha.targetingOnline &&
        !shipAlpha.destroyed &&
        !shipOmega.destroyed &&
        shipOmega.hyperspace?.state !== 'jumping' &&
        (!shipOmega.inNebula || sameNebula) &&
        (!shipAlpha.inNebula || sameNebula)
      );
      shipAlpha.leadTarget = alphaCanTarget
        ? calculateLeadTarget(shipAlpha.body.pos, shipAlpha.body.vel, shipOmega.body.pos, shipOmega.body.vel, 600)
        : null;

      const omegaCanTarget = Boolean(
        rOmega.targetingOnline &&
        !shipOmega.destroyed &&
        !shipAlpha.destroyed &&
        shipAlpha.hyperspace?.state !== 'jumping' &&
        (!shipAlpha.inNebula || sameNebula) &&
        (!shipOmega.inNebula || sameNebula)
      );
      shipOmega.leadTarget = omegaCanTarget
        ? calculateLeadTarget(shipOmega.body.pos, shipOmega.body.vel, shipAlpha.body.pos, shipAlpha.body.vel, 600)
        : null;
    }

    // 4. Update Projectiles & Ballistic flight
    const allDebrisChunks = [
      ...(this.sector.debrisFields?.flatMap(f => f.debrisChunks) || []),
      ...(this.sector.dynamicDebrisChunks || []),
    ];
    const activeTargetShips = shipList.filter(s => !s.destroyed && s.hyperspace?.state !== 'jumping');
    this.projectiles = shipAlpha.weapons.updateProjectiles(
      this.projectiles,
      simDt,
      activeTargetShips,
      this.sector.gravityWells,
      this.sector.ionNebulae,
      allDebrisChunks
    );
    const projectileArenaRadius = this.sector?.arenaRadius || ARENA_RADIUS;
    if (this.projectiles && this.projectiles.length > 0) {
      for (const p of this.projectiles) {
        if (Math.hypot(p.pos.x, p.pos.y, p.pos.z || 0) > projectileArenaRadius) {
          p.destroyed = true;
        }
      }
      this.projectiles = this.projectiles.filter(p => !p.destroyed);
    }

    // 5. Projectile Impacts (Asteroids & Ships)
    for (const p of this.projectiles) {
      if (p.destroyed) continue;

      // Check collisions against active (non-destroyed) asteroids
      if (this.sector.asteroids && this.sector.asteroids.length > 0) {
        for (const ast of this.sector.asteroids) {
          if (ast.destroyed) continue;

          const projRadius = p.radius || 6;
          const hitRadius = ast.radius + projRadius;
          const dist = Math.hypot(p.pos.x - ast.pos.x, p.pos.y - ast.pos.y, (p.pos.z ?? 0) - (ast.pos.z ?? 0));

          if (dist <= hitRadius) {
            p.destroyed = true;

            const damage = p.type === 'railgun' ? Math.max((p.damage || 250) * 3, 600) : (p.type === 'torpedo' ? (p.damage || 400) : (p.damage || 18));
            const impactPos = { x: p.pos.x, y: p.pos.y, z: p.pos.z || 0 };

            const res = damageAsteroid(ast, damage, impactPos, { chipDebris: p.type === 'torpedo', shatter: p.type === 'railgun' });
            if (res.hit) {
              if (res.spawnedChunks && res.spawnedChunks.length > 0) {
                if (!this.sector.dynamicDebrisChunks) this.sector.dynamicDebrisChunks = [];
                for (const chunk of res.spawnedChunks) {
                  this.sector.dynamicDebrisChunks.push(chunk);
                }
                while (this.sector.dynamicDebrisChunks.length > 60) {
                  this.sector.dynamicDebrisChunks.shift();
                }
              }

              this.emitEvent({
                type: 'asteroid_hit',
                asteroidId: ast.id,
                pos: impactPos,
                hp: ast.hp,
                maxHp: ast.maxHp,
              });

              if (res.destroyed) {
                this.emitEvent({
                  type: 'asteroid_destroyed',
                  asteroidId: ast.id,
                  pos: { ...ast.pos },
                  radius: ast.radius,
                  debrisCount: res.spawnedChunks.length,
                });
              }
            }
            break;
          }
        }
      }

      if (p.destroyed) continue;

      for (const target of shipList) {
        if (target.destroyed || p.shooterId === target.id || target.hyperspace?.state === 'jumping') continue;

        const targetRadius = (target.body.length || 60) * 0.45;
        const hitRadius = (p.radius || 6) + targetRadius;
        const dist = Math.hypot(p.pos.x - target.body.pos.x, p.pos.y - target.body.pos.y, (p.pos.z ?? 0) - (target.body.pos.z ?? 0));

        if (dist <= hitRadius) {
          p.destroyed = true;

          if (p.type === 'laser') {
            const hitVec = {
              x: p.pos.x - target.body.pos.x,
              y: p.pos.y - target.body.pos.y,
              z: (p.pos.z ?? 0) - (target.body.pos.z ?? 0),
            };
            const hitAngle = Math.atan2(hitVec.y, hitVec.x);
            const totalLaserDmg = (p.damage || 18) * (p.shieldMultiplier || 2.0);
            const quad = typeof target.body?.getEffectiveQuadrant === 'function'
              ? target.body.getEffectiveQuadrant(hitVec)
              : undefined;
            const shieldRes = target.shields.absorbDamage(
              totalLaserDmg,
              hitAngle,
              target.body.angle,
              target.body.rollState,
              quad ? { quadrant: quad } : undefined
            );

            if (shieldRes.overflow > 0) {
              const hullDmg = shieldRes.overflow / (p.shieldMultiplier || 2.0);
              target.hullHp = Math.max(0, target.hullHp - hullDmg);
              target.body.hullHp = target.hullHp;
              this.applyHullConduitDamage(target, hullDmg);
            }

            this.emitEvent({
              type: 'laser_hit',
              targetId: target.id,
              pos: { ...p.pos },
              shieldDepleted: shieldRes.shieldDepleted,
            });
          } else if (p.type === 'railgun') {
            const res = applyRailgunImpact(p, target.body, target.shields, target.grid, Math.random, target.weapons, target.hyperspace);
            target.hullHp = target.body.hullHp;
            this.emitEvent({
              type: 'railgun_hit',
              targetId: target.id,
              pos: { ...p.pos },
              damagedSubsystem: res.damagedSubsystem,
              brokenTiles: res.brokenTiles?.length || 0,
            });
          } else if (p.type === 'torpedo') {
            const res = applyTorpedoImpact(p, target.body, target.shields, target.grid);
            target.hullHp = target.body.hullHp;
            const uncountedOverflow = Math.max(0, res.overflow - (res.brokenTiles?.length || 0) * 90);
            if (uncountedOverflow > 0) {
              this.applyHullConduitDamage(target, uncountedOverflow);
            }
            this.emitEvent({
              type: 'torpedo_hit',
              targetId: target.id,
              pos: { ...p.pos },
              empApplied: res.empApplied,
            });
          }

          // Killing Blow Check
          if (target.hullHp <= 0 && !target.destroyed) {
            target.destroyed = true;
            target.hullHp = 0;
            if (target.weaponsInput) {
              target.weaponsInput.firingLaser = false;
              target.weaponsInput.chargingRailgun = false;
            }
            if (target.weapons) {
              target.weapons.charging = false;
              if (typeof target.weapons.stopRailgunCharge === 'function') {
                target.weapons.stopRailgunCharge();
              }
            }
            if (this.slowMoTimer <= 0) {
              this.slowMoTimer = 3.0;
              this.slowMoActive = true;
              this.winner = target.id === 'alpha' ? 'omega' : 'alpha';
              this.emitEvent({
                type: 'killing_blow',
                victimId: target.id,
                killerId: this.winner,
                pos: { ...target.body.pos },
              });
            }
          }
        }
      }
    }

    // 6. Rigid-Body Collisions
    // Ship-vs-Ship
    if (!shipAlpha.destroyed && !shipOmega.destroyed && shipAlpha.hyperspace?.state !== 'jumping' && shipOmega.hyperspace?.state !== 'jumping') {
      const rA = (shipAlpha.body.length || 60) * 0.4;
      const rB = (shipOmega.body.length || 60) * 0.4;
      const col = checkCircleCollision(shipAlpha.body.pos, rA, shipOmega.body.pos, rB);

      if (col.hit) {
        const prevAlphaHp = shipAlpha.hullHp;
        const prevOmegaHp = shipOmega.hullHp;

        const res = resolveImpulse(shipAlpha.body, shipOmega.body, col.contactPoint, col.normal);

        shipAlpha.hullHp = prevAlphaHp;
        shipAlpha.body.hullHp = prevAlphaHp;
        shipOmega.hullHp = prevOmegaHp;
        shipOmega.body.hullHp = prevOmegaHp;

        this.applyCollisionDamage(shipAlpha, col.contactPoint, res.damageA * 0.15, 140);
        this.applyCollisionDamage(shipOmega, col.contactPoint, res.damageB * 0.15, 140);

        // Push apart
        const sep = col.depth * 0.5;
        shipAlpha.body.pos.x -= col.normal.x * sep;
        shipAlpha.body.pos.y -= col.normal.y * sep;
        shipAlpha.body.pos.z = (shipAlpha.body.pos.z || 0) - (col.normal.z || 0) * sep;
        shipOmega.body.pos.x += col.normal.x * sep;
        shipOmega.body.pos.y += col.normal.y * sep;
        shipOmega.body.pos.z = (shipOmega.body.pos.z || 0) + (col.normal.z || 0) * sep;

        this.emitEvent({
          type: 'collision',
          subType: 'ship_ship',
          impulse: res.impulseScalar,
          pos: col.contactPoint,
        });
      }
    }

    // Ship-vs-Asteroid
    for (const ship of shipList) {
      if (ship.destroyed || ship.hyperspace?.state === 'jumping') continue;
      const rShip = (ship.body.length || 60) * 0.4;

      for (const ast of this.sector.asteroids || []) {
        if (ast.destroyed) continue;
        const col = checkCircleCollision(ship.body.pos, rShip, ast.pos, ast.radius);
        if (col.hit) {
          // Resolve elastic impulse against immovable asteroid
          const rAx = col.contactPoint.x - ship.body.pos.x;
          const rAy = col.contactPoint.y - ship.body.pos.y;
          const uAx = ship.body.vel.x - (ship.body.omega || 0) * rAy;
          const uAy = ship.body.vel.y + (ship.body.omega || 0) * rAx;
          const uAz = ship.body.vel.z || 0;
          const nx = col.normal.x;
          const ny = col.normal.y;
          const nz = col.normal.z || 0;
          const vClosing = uAx * nx + uAy * ny + uAz * nz;

          if (vClosing > 0) {
            const invMass = 1 / ship.body.mass;
            const rAxN = rAx * ny - rAy * nx;
            const invEffMass = invMass + (rAxN * rAxN) / ship.body.inertia;
            const J = (1 + 0.65) * vClosing / invEffMass;

            ship.body.vel.x -= J * nx * invMass;
            ship.body.vel.y -= J * ny * invMass;
            ship.body.vel.z = (ship.body.vel.z || 0) - J * nz * invMass;
            ship.body.omega = (ship.body.omega || 0) - J * rAxN / ship.body.inertia;
            clampAngularVelocity(ship.body);

            const rawDamage = Math.max(0, vClosing * 1.6);
            this.applyCollisionDamage(ship, col.contactPoint, rawDamage, 160);
          }

          // Push ship out
          ship.body.pos.x -= nx * col.depth;
          ship.body.pos.y -= ny * col.depth;
          ship.body.pos.z = (ship.body.pos.z || 0) - nz * col.depth;
        }
      }
    }

    // Ship-vs-Debris & Debris Kinematics
    const debrisChunkSources = [
      ...(this.sector.debrisFields?.map(f => f.debrisChunks) || []),
      this.sector.dynamicDebrisChunks || [],
    ];
    for (const chunkList of debrisChunkSources) {
      for (const chunk of chunkList) {
        // Integrate chunk position
        chunk.pos.x += chunk.vel.x * simDt;
        chunk.pos.y += chunk.vel.y * simDt;
        chunk.pos.z = (chunk.pos.z || 0) + (chunk.vel.z || 0) * simDt;
        chunk.angle += (chunk.omega || 0) * simDt;

        // Apply gravity to debris
        if (this.sector.gravityWells && this.sector.gravityWells.length > 0) {
          applyGravity(chunk, this.sector.gravityWells, simDt);
        }

        // Check collision against ships
        for (const ship of shipList) {
          if (ship.destroyed || ship.hyperspace?.state === 'jumping') continue;
          const rShip = (ship.body.length || 60) * 0.4;
          const col = checkCircleCollision(ship.body.pos, rShip, chunk.pos, chunk.radius || 15);
          if (col.hit) {
            const chunkBody = {
              pos: chunk.pos,
              vel: chunk.vel,
              omega: chunk.omega || 0,
              mass: chunk.mass || 300,
              inertia: 0.5 * (chunk.mass || 300) * (chunk.radius || 15) * (chunk.radius || 15),
              armor: 10,
              hullHp: 100,
              isDebris: true,
            };

            const prevShipHp = ship.hullHp;
            const res = resolveImpulse(ship.body, chunkBody, col.contactPoint, col.normal);
            ship.hullHp = prevShipHp;
            ship.body.hullHp = prevShipHp;

            this.applyCollisionDamage(ship, col.contactPoint, res.impulseScalar * 0.003, 25);

            chunk.vel = chunkBody.vel;
            chunk.omega = chunkBody.omega;

            // Separate
            ship.body.pos.x -= col.normal.x * col.depth * 0.5;
            ship.body.pos.y -= col.normal.y * col.depth * 0.5;
            ship.body.pos.z = (ship.body.pos.z || 0) - (col.normal.z || 0) * col.depth * 0.5;
            chunk.pos.x += col.normal.x * col.depth * 0.5;
            chunk.pos.y += col.normal.y * col.depth * 0.5;
            chunk.pos.z = (chunk.pos.z || 0) + (col.normal.z || 0) * col.depth * 0.5;
          }
        }
      }
    }

    // Arena Boundary Containment
    const arenaRadius = this.sector.arenaRadius || ARENA_RADIUS;
    for (const ship of shipList) {
      if (ship.destroyed || ship.hyperspace?.state === 'jumping') continue;
      const distCenter = Math.hypot(ship.body.pos.x, ship.body.pos.y, ship.body.pos.z || 0);
      if (distCenter > arenaRadius) {
        const nx = ship.body.pos.x / distCenter;
        const ny = ship.body.pos.y / distCenter;
        const nz = (ship.body.pos.z || 0) / distCenter;
        ship.body.pos.x = nx * arenaRadius;
        ship.body.pos.y = ny * arenaRadius;
        ship.body.pos.z = nz * arenaRadius;

        const dot = ship.body.vel.x * nx + ship.body.vel.y * ny + (ship.body.vel.z || 0) * nz;
        if (dot > 0) {
          ship.body.vel.x -= 1.65 * dot * nx;
          ship.body.vel.y -= 1.65 * dot * ny;
          ship.body.vel.z = (ship.body.vel.z || 0) - 1.65 * dot * nz;
        }
      }
    }

    // Edge Dampening Field (outer 750m spherical rim)
    for (const ship of shipList) {
      if (ship.destroyed || ship.hyperspace?.state === 'jumping') {
        ship.dampeningFactor = 0;
        ship.inDampeningField = false;
        continue;
      }
      const strength = computeDampeningFieldStrength(ship.body.pos, arenaRadius, DAMPENING_FIELD_WIDTH);
      if (strength > 0) {
        const damp = Math.pow(1 - DAMPENING_FIELD_MAX_RATE * strength, simDt);
        ship.body.vel.x *= damp;
        ship.body.vel.y *= damp;
        ship.body.vel.z = (ship.body.vel.z || 0) * damp;
        ship.body.omega *= damp;
        ship.body.pitchOmega *= damp;
        ship.body.rollOmega *= damp;
        ship.dampeningFactor = strength;
        ship.inDampeningField = true;
      } else {
        ship.dampeningFactor = 0;
        ship.inDampeningField = false;
      }
    }

    // 7. Update World Hazards
    // Tether mines
    const activeHazardShips = shipList.filter(s => !s.destroyed && s.hyperspace?.state !== 'jumping');
    const mineDetonations = updateTetherMines(this.sector.tetherMines, activeHazardShips, simDt);
    for (const det of mineDetonations) {
      this.emitEvent({
        type: 'tether_mine_detonated',
        ...det,
      });
    }

    // Ion Nebulae
    updateIonNebulae(this.sector.ionNebulae, activeHazardShips, simDt);

    // Munitions Derelict
    const derelictEvents = updateMunitionsDerelict(this.sector.munitionsDerelict, activeHazardShips, simDt);
    for (const ev of derelictEvents) {
      this.emitEvent(ev);
    }

    // Final killing blow sweep for hazard/collision kills
    for (const ship of shipList) {
      if (ship.hullHp <= 0 && !ship.destroyed) {
        ship.destroyed = true;
        ship.hullHp = 0;
        if (ship.weaponsInput) {
          ship.weaponsInput.firingLaser = false;
          ship.weaponsInput.chargingRailgun = false;
        }
        if (ship.weapons) {
          ship.weapons.charging = false;
          if (typeof ship.weapons.stopRailgunCharge === 'function') {
            ship.weapons.stopRailgunCharge();
          }
        }
        if (this.slowMoTimer <= 0) {
          this.slowMoTimer = 3.0;
          this.slowMoActive = true;
          this.winner = ship.id === 'alpha' ? 'omega' : 'alpha';
          this.emitEvent({
            type: 'killing_blow',
            victimId: ship.id,
            killerId: this.winner,
            pos: { ...ship.body.pos },
          });
        }
      }
    }

    // 8. Advance tick counter
    this.tick++;

    if (wasPlaying) {
      this.recordReplayFrame(this.state === 'gameover');
      if (this.state === 'gameover') {
        for (const s of [this.ships?.alpha, this.ships?.omega]) {
          this.clearShipActiveInputs(s);
        }
        this.startReplay();
      }
    }
  }

  /**
   * Computes and synchronizes live sensor/target/view flags on a ship entity.
   */
  updateShipSensorFlags(ship, enemyShip) {
    if (!ship) return null;
    const r = getHyperspaceRestrictions(ship);
    const sameNebula = Boolean(ship.inNebula && enemyShip?.inNebula);
    const targetAvailable = Boolean(
      r.targetingOnline &&
      enemyShip &&
      !enemyShip.destroyed &&
      enemyShip.hullHp > 0 &&
      enemyShip.hyperspace?.state !== 'jumping' &&
      (!enemyShip.inNebula || sameNebula) &&
      (!ship.inNebula || sameNebula)
    );
    ship.sensorsOnline = r.targetingOnline;
    ship.externalViewsOnline = r.externalViewsOnline;
    ship.targetAvailable = targetAvailable;
    ship.weaponsOnline = Boolean(r.weaponsOnline && !ship.destroyed && ship.hullHp > 0 && !this.isTerminalMatchState());
    return r;
  }

  /**
   * Serializes a ship entity for snapshot broadcasting.
   */
  serializeShip(ship) {
    if (!ship) return null;
    const hs = ship.hyperspace || {};
    const enemyShip = ship.id === 'alpha' ? this.ships?.omega : this.ships?.alpha;
    const r = this.updateShipSensorFlags(ship, enemyShip);
    const targetAvailable = ship.targetAvailable;
    return {
      id: ship.id,
      name: ship.name,
      team: ship.team,
      hullClass: ship.hullClass,
      modules: ship.modules,
      pos: { x: ship.body.pos.x, y: ship.body.pos.y, z: ship.body.pos.z || 0 },
      vel: { x: ship.body.vel.x, y: ship.body.vel.y, z: ship.body.vel.z || 0 },
      angle: ship.body.angle,
      omega: ship.body.omega,
      pitch: ship.body.pitch || 0,
      pitchOmega: ship.body.pitchOmega || 0,
      rollAngle: ship.body.rollAngle,
      rollOmega: ship.body.rollOmega,
      rollState: ship.body.rollState,
      stopRollActive: ship.body.stopRollActive,
      autoOrientMode: ship.body.autoOrientMode,
      turnAndBurn: Boolean(ship.body.turnAndBurn),
      targetAvailable,
      sensorsOnline: r.targetingOnline,
      externalViewsOnline: r.externalViewsOnline,
      weaponsOnline: Boolean(r.weaponsOnline && !ship.destroyed && ship.hullHp > 0 && !this.isTerminalMatchState()),
      sasActive: ship.body.sasActive,
      thrusters: ship.body.thrusters,
      mainDrive: {
        ...ship.body.mainDrive,
        gimbalYaw: ship.body.mainDrive?.gimbalYaw ?? 0,
        gimbalPitch: ship.body.mainDrive?.gimbalPitch ?? 0,
        heat: ship.body.mainDrive?.heat ?? 0,
        overheated: Boolean(ship.body.mainDrive?.overheated),
      },
      mainThrottle: ship.body.mainDrive?.throttle ?? 0,
      hullHp: ship.hullHp,
      maxHullHp: ship.maxHullHp,
      armor: ship.armor,
      destroyed: ship.destroyed,
      hyperspace: {
        state: hs.state || 'ready',
        charge: hs.charge || 0,
        jumpTimer: hs.jumpTimer || 0,
        jumpDuration: HYPERSPACE_JUMP_DURATION,
        rebootTimer: hs.rebootTimer || 0,
        rebootDuration: HYPERSPACE_REBOOT_TOTAL_SEC,
        stage1Sec: HYPERSPACE_REBOOT_STAGE1_SEC,
        stage1Online: r.enginesOnline,
        stage2Online: r.targetingOnline,
        health: Math.round(hs.health ?? 100),
        maxHealth: hs.maxHealth ?? 100,
        originPos: hs.originPos ? { ...hs.originPos } : null,
        destinationPos: hs.destinationPos ? { ...hs.destinationPos } : null,
        warpHeadingAngle: hs.warpHeadingAngle || 0,
        warpHeadingPitch: hs.warpHeadingPitch || 0,
      },
      thermal: {
        rcs: ship.body.rcsThermal,
        mainDrive: {
          heat: ship.body.mainDrive.heat,
          overheated: ship.body.mainDrive.overheated,
        },
        sas: ship.body.sasThermal,
        laser: {
          heat: ship.weapons.heat,
          overheated: ship.weapons.overheated,
        },
        railgun: {
          heat: ship.weapons.railgunHeat,
          overheated: ship.weapons.railgunOverheated,
        },
        torpedo: {
          heat: ship.weapons.torpedoHeat,
          overheated: ship.weapons.torpedoOverheated,
        },
        shields: {
          heat: ship.shields.heat,
          overheated: ship.shields.overheated,
        },
      },
      shields: {
        hp: { ...ship.shields.hp },
        maxHp: { ...ship.shields.maxHp },
        power: { ...(ship.shields.power || {}) },
        online: {
          fore: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('fore') : true,
          aft: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('aft') : true,
          port: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('port') : true,
          starboard: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('starboard') : true,
        },
      },
      weapons: {
        heat: ship.weapons.heat,
        maxHeat: ship.weapons.maxHeat,
        overheated: ship.weapons.overheated,
        railgunHeat: ship.weapons.railgunHeat,
        railgunOverheated: ship.weapons.railgunOverheated,
        torpedoHeat: ship.weapons.torpedoHeat,
        torpedoOverheated: ship.weapons.torpedoOverheated,
        charging: ship.weapons.charging,
        chargeProgress: ship.weapons.chargeProgress,
        magazine: ship.weapons.magazine,
        maxMagazine: ship.weapons.maxMagazine,
        torpedoType: ship.weapons.torpedoType,
        cooldown: ship.weapons.cooldown,
        railgunCooldown: ship.weapons.railgunCooldown,
        torpedoCooldown: ship.weapons.torpedoCooldown,
        flakCooldown: ship.weapons.flakCooldown,
        targetedSubsystem: ship.weapons.targetedSubsystem,
        railgunAngle: ship.weapons.railgunAngle,
        railgunLocalAngle: ship.weapons.railgunLocalAngle,
        railgunTargetAngle: ship.weapons.railgunTargetAngle,
        railgunPitch: ship.weapons.railgunPitch || 0,
        railgunLocalPitch: ship.weapons.railgunLocalPitch || 0,
        railgunTargetPitch: ship.weapons.railgunTargetPitch || 0,
        railgunSlewRate: ship.weapons.railgunSlewRate,
        railgunJammed: ship.weapons.railgunJammed,
        turretPitch: ship.weapons.turretPitch || 0,
        aimPitch: ship.weaponsInput?.aimPitch || 0,
        laserHealth: ship.weapons.laserHardware?.health ?? 100,
        railgunHealth: ship.weapons.railgunHardware?.health ?? 100,
        stabilizerHealth: ship.weapons.stabilizerHardware?.health ?? 100,
        stabilizerPowered: (ship.powerMap?.sas_computer || 0) > 0,
        stabilizerPower: ship.powerMap?.sas_computer ?? 0,
      },
      leadTarget: ship.leadTarget || null,
      grid: ship.grid.serialize(),
      drones: ship.drones.drones,
      powerMap: ship.powerMap,
      inNebula: Boolean(ship.inNebula),
      dampeningFactor: ship.dampeningFactor || 0,
      inDampeningField: Boolean(ship.inDampeningField),
      turretAngle: ship.turretAngle,
      turretPitch: ship.weapons.turretPitch || 0,
    };
  }

  /**
   * Serializes a compact snapshot of a ship entity specifically for the replay ring buffer.
   *
   * @param {object} ship - ship entity
   * @returns {object|null} compact replay ship snapshot
   */
  serializeReplayShip(ship) {
    if (!ship) return null;

    const thrusters = {};
    if (ship.body?.thrusters) {
      for (const [k, t] of Object.entries(ship.body.thrusters)) {
        thrusters[k] = {
          isFiring: Boolean(t?.isFiring),
          throttle: t?.throttle ?? 0,
          health: t?.health ?? 100,
        };
      }
    }

    return {
      id: ship.id,
      name: ship.name,
      team: ship.team,
      hullClass: ship.hullClass,
      destroyed: Boolean(ship.destroyed),
      hullHp: ship.hullHp,
      maxHullHp: ship.maxHullHp,
      pos: { x: ship.body.pos.x, y: ship.body.pos.y, z: ship.body.pos.z || 0 },
      vel: { x: ship.body.vel.x, y: ship.body.vel.y, z: ship.body.vel.z || 0 },
      angle: ship.body.angle,
      pitch: ship.body.pitch || 0,
      rollAngle: ship.body.rollAngle,
      rollState: ship.body.rollState,
      mainThrottle: ship.body.mainDrive?.throttle ?? 0,
      mainDrive: {
        throttle: ship.body.mainDrive?.throttle ?? 0,
        gimbalYaw: ship.body.mainDrive?.gimbalYaw ?? 0,
        gimbalPitch: ship.body.mainDrive?.gimbalPitch ?? 0,
      },
      turretAngle: ship.turretAngle,
      turretPitch: ship.turretPitch || 0,
      weapons: {
        turretAngle: ship.turretAngle,
        turretPitch: ship.turretPitch || 0,
        railgunAngle: ship.weapons?.railgunAngle ?? ship.turretAngle,
        railgunPitch: ship.weapons?.railgunPitch || 0,
      },
      thrusters,
      shields: {
        hp: { ...ship.shields.hp },
        maxHp: { ...ship.shields.maxHp },
        online: {
          fore: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('fore') : true,
          aft: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('aft') : true,
          port: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('port') : true,
          starboard: typeof ship.shields.isQuadrantPowered === 'function' ? ship.shields.isQuadrantPowered('starboard') : true,
        },
      },
      dampeningFactor: ship.dampeningFactor || 0,
      inDampeningField: Boolean(ship.inDampeningField),
      hyperspace: {
        state: ship.hyperspace?.state || 'ready',
        charge: ship.hyperspace?.charge || 0,
        jumpTimer: ship.hyperspace?.jumpTimer || 0,
        rebootTimer: ship.hyperspace?.rebootTimer || 0,
        originPos: ship.hyperspace?.originPos ? { ...ship.hyperspace.originPos } : null,
        destinationPos: ship.hyperspace?.destinationPos ? { ...ship.hyperspace.destinationPos } : null,
        warpHeadingAngle: ship.hyperspace?.warpHeadingAngle || 0,
        warpHeadingPitch: ship.hyperspace?.warpHeadingPitch || 0,
      },
    };
  }

  /**
   * Captures a single 30Hz frame of simulation state for the replay ring buffer.
   *
   * @param {Array<object>} [events=[]] - Simulation events occurring since last sample
   * @returns {object} replay frame
   */
  captureReplayFrame(events = []) {
    return {
      tick: this.tick,
      slowMoActive: Boolean(this.slowMoActive),
      ships: {
        alpha: this.serializeReplayShip(this.ships?.alpha),
        omega: this.serializeReplayShip(this.ships?.omega),
      },
      projectiles: (this.projectiles || []).map(p => ({
        id: p.id,
        type: p.type,
        torpedoType: p.torpedoType,
        shooterId: p.shooterId,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z || 0 },
        vel: { x: p.vel.x, y: p.vel.y, z: p.vel.z || 0 },
        aimAngle: p.aimAngle,
        aimPitch: p.aimPitch || 0,
        radius: p.radius,
        lifetime: p.lifetime,
      })),
      destroyedAsteroidIds: (this.sector?.asteroids || []).filter(a => a.destroyed).map(a => a.id),
      events: events || [],
    };
  }

  /**
   * Samples a simulation frame into the rolling replay buffer at 30Hz (every 2 ticks)
   * or immediately on a killing blow event. Caps buffer at REPLAY_MAX_FRAMES.
   *
   * @param {boolean} [force=false] - If true, samples immediately regardless of tick cadence
   */
  recordReplayFrame(force = false) {
    if (this.events && this.events.length > 0) {
      for (const ev of this.events) {
        if (REPLAY_EVENT_TYPES.has(ev.type) && !this._replayPendingEvents.includes(ev)) {
          this._replayPendingEvents.push(ev);
        }
      }
    }

    const hasKillingBlow = Boolean(
      (this.events && this.events.some(e => e.type === 'killing_blow')) ||
      this._replayPendingEvents.some(e => e.type === 'killing_blow')
    );
    const shouldSample = force || (this.tick % 2 === 0) || hasKillingBlow;

    if (shouldSample) {
      const frameEvents = [...this._replayPendingEvents];
      this._replayPendingEvents = [];
      const frame = this.captureReplayFrame(frameEvents);
      this.replayBuffer.push(frame);
      while (this.replayBuffer.length > REPLAY_MAX_FRAMES) {
        this.replayBuffer.shift();
      }
    }
  }

  /**
   * Freezes the recorded replay buffer into an immutable playback array and starts 30Hz replay.
   */
  startReplay() {
    this.clearShipActiveInputs(this.ships?.alpha);
    this.clearShipActiveInputs(this.ships?.omega);
    this.replayFrames = this.replayBuffer.map((f, idx) => ({ ...f, frameIndex: idx }));
    this.replayBuffer = [];
    this._replayPendingEvents = [];
    this.replayCursor = 0;
    this.replayElapsed = 0;
    if (this.replayFrames.length > 0) {
      this.replayActive = true;
      this.replayComplete = false;
    } else {
      this.replayActive = false;
      this.replayComplete = true;
    }
  }

  /**
   * Returns a complete JSON-serializable snapshot of game room state.
   */
  getSnapshot() {
    const allDebrisChunks = [
      ...(this.sector.debrisFields?.flatMap(f => f.debrisChunks) || []),
      ...(this.sector.dynamicDebrisChunks || []),
    ];

    const snapshotEvents = this.recentEventsBuffer.length > 0
      ? [...this.recentEventsBuffer]
      : [...this.events];
    this.recentEventsBuffer = [];

    return {
      id: this.id,
      state: this.state,
      tick: this.tick,
      slowMoActive: this.slowMoActive,
      slowMoTimer: this.slowMoTimer,
      winner: this.winner,
      aiEnabled: this.aiEnabled,
      players: Array.from(this.players.values()),
      drydock: this.drydock,
      ships: {
        alpha: this.serializeShip(this.ships.alpha),
        omega: this.serializeShip(this.ships.omega),
      },
      projectiles: this.projectiles.map(p => ({
        id: p.id,
        type: p.type,
        torpedoType: p.torpedoType,
        shooterId: p.shooterId,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z || 0 },
        vel: { x: p.vel.x, y: p.vel.y, z: p.vel.z || 0 },
        aimAngle: p.aimAngle,
        aimPitch: p.aimPitch || 0,
        radius: p.radius,
        lifetime: p.lifetime,
      })),
      sector: {
        arenaRadius: this.sector.arenaRadius,
        asteroids: this.sector.asteroids,
        debrisFields: this.sector.debrisFields,
        debrisChunks: allDebrisChunks,
        dynamicDebrisChunks: this.sector.dynamicDebrisChunks || [],
        tetherMines: this.sector.tetherMines,
        gravityWells: this.sector.gravityWells,
        ionNebulae: this.sector.ionNebulae,
        munitionsDerelict: this.sector.munitionsDerelict,
      },
      events: snapshotEvents,
      replayActive: this.replayActive,
      replayComplete: this.replayComplete,
      replayFrameIndex: this.replayActive ? this.replayCursor : 0,
      replayFrameCount: this.replayFrames.length,
      replayProgress: this.replayActive && this.replayFrames.length > 1
        ? this.replayCursor / (this.replayFrames.length - 1)
        : (this.replayComplete ? 1 : 0),
      replayFrame: this.replayActive ? (this.replayFrames[this.replayCursor] || null) : null,
      musicOwnerId: this.musicOwnerId,
    };
  }
}
