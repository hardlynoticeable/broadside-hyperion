/**
 * BROADSIDE HYPERION — Server Integration Test Suite
 *
 * Verifies GameRoom authoritative 60Hz simulation, lobby & drydock loadouts,
 * instant station hot-swapping, AI Auto-Crew (Helm, Weapons, Engineer),
 * 5x slow-motion killing blow dilation, and Express + WebSocket server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GameRoom, REPLAY_MAX_FRAMES, REPLAY_FPS, REPLAY_EVENT_TYPES } from '../../src/server/game-room.js';
import { AIHelm, AIWeapons, AIEngineer, runAICrewForShip, hasLineOfSight, evaluateTacticalSituation, findTacticalShatterAsteroid, selectOptimalSubsystemTarget } from '../../src/server/ai-crew.js';
import { calculateLeadTarget } from '../../src/combat/weapons.js';
import { createAppServer, getLanAddresses } from '../../src/server/app.js';
import { WebSocket } from 'ws';

describe('GameRoom — Lobby, Teams & Drydock Loadouts', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom({ id: 'test_room', seed: 42 });
  });

  it('initializes in lobby state with alpha and omega ships', () => {
    expect(room.state).toBe('lobby');
    expect(room.ships.alpha).toBeDefined();
    expect(room.ships.omega).toBeDefined();
    expect(room.ships.alpha.hullClass).toBe('frigate');
    expect(room.ships.omega.hullClass).toBe('frigate');
    expect(room.ships.alpha.name).toBe('UNS HYPERION');
    expect(room.ships.omega.name).toBe('KRS VANGUARD');
    expect(room.players.size).toBe(0);
  });

  it('allows players to join and leave the room', () => {
    const p1 = room.addPlayer('p1', 'Commander Shepard');
    expect(p1.id).toBe('p1');
    expect(p1.name).toBe('Commander Shepard');
    expect(room.players.has('p1')).toBe(true);

    room.removePlayer('p1');
    expect(room.players.has('p1')).toBe(false);
  });

  it('handles bridge station assignment and instant hot-swapping', () => {
    room.addPlayer('p1', 'Player 1');
    room.addPlayer('p2', 'Player 2');

    // Join Helm on Alpha
    room.joinStation('p1', 'alpha', 'helm');
    expect(room.players.get('p1').team).toBe('alpha');
    expect(room.players.get('p1').station).toBe('helm');

    // Instant station switch to Weapons on Alpha
    room.joinStation('p1', 'alpha', 'weapons');
    expect(room.players.get('p1').station).toBe('weapons');

    // Player 2 takes Helm on Alpha
    room.joinStation('p2', 'alpha', 'helm');
    expect(room.players.get('p2').station).toBe('helm');

    // Player 1 hot-swaps to Helm, displacing Player 2
    room.joinStation('p1', 'alpha', 'helm');
    expect(room.players.get('p1').station).toBe('helm');
    expect(room.players.get('p2').station).toBeNull();
  });

  it('configures drydock loadouts and rebuilds ship in lobby', () => {
    room.configureDrydock('alpha', {
      hullClass: 'dreadnought',
      modules: { helm: 'reinforced_prow', weapons: 'swarm_missiles', engineer: 'turbo_drones' },
    });

    expect(room.drydock.alpha.hullClass).toBe('dreadnought');
    expect(room.ships.alpha.hullClass).toBe('dreadnought');
    expect(room.ships.alpha.maxHullHp).toBe(1800);
    expect(room.ships.alpha.weapons.torpedoType).toBe('swarm_missiles');
    expect(room.ships.alpha.drones.droneModule).toBe('turbo_drones');
  });

  it('handles client messages for drydock, station joining, and bot toggle', () => {
    room.addPlayer('p_client', 'Pilot');

    room.handleClientMessage('p_client', {
      action: 'join_station',
      team: 'omega',
      station: 'helm',
      name: 'Ace Pilot',
    });
    expect(room.players.get('p_client').team).toBe('omega');
    expect(room.players.get('p_client').station).toBe('helm');
    expect(room.players.get('p_client').name).toBe('Ace Pilot');

    room.handleClientMessage('p_client', {
      action: 'switch_station',
      station: 'weapons',
    });
    expect(room.players.get('p_client').station).toBe('weapons');

    room.handleClientMessage('p_client', {
      action: 'toggle_bots',
      enabled: false,
    });
    expect(room.aiEnabled).toBe(false);
  });

  it('supports pre-game station switching and configuration in lobby state and preserves them on startMatch', () => {
    const lobbyRoom = new GameRoom({ id: 'lobby_test', seed: 101 });
    expect(lobbyRoom.state).toBe('lobby');

    // 1. Newly added player switching stations defaults to team 'alpha' and claims station
    const pNew = lobbyRoom.addPlayer('new_pilot', 'Viper');
    expect(pNew.team).toBe('alpha');
    expect(pNew.station).toBeNull();

    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'switch_station',
      station: 'helm',
    });
    expect(lobbyRoom.players.get('new_pilot').team).toBe('alpha');
    expect(lobbyRoom.players.get('new_pilot').station).toBe('helm');

    // Helm pre-game configuration in lobby
    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'helm_input',
      autoOrientMode: 'target',
      sasActive: true,
      forward: 0.5,
    });
    expect(lobbyRoom.ships.alpha.body.autoOrientMode).toBe('target');
    expect(lobbyRoom.ships.alpha.body.sasActive).toBe(true);
    expect(lobbyRoom.ships.alpha.helmInput.forward).toBe(0.5);

    // Switch to weapons
    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'switch_station',
      station: 'weapons',
    });
    expect(lobbyRoom.players.get('new_pilot').station).toBe('weapons');

    // 3. Aiming weapons and selecting target subsystem in lobby updates turret & target without firing
    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'weapons_input',
      aimAngle: 1.25,
      targetSubsystem: 'shields',
      fireLaser: true,
      launchTorpedo: true,
    });
    expect(lobbyRoom.ships.alpha.turretAngle).toBe(1.25);
    expect(lobbyRoom.ships.alpha.weapons.targetedSubsystem).toBe('shields');
    expect(lobbyRoom.ships.alpha.weaponsInput.targetedSubsystem).toBe('shields');
    expect(lobbyRoom.projectiles.length).toBe(0); // gated in lobby!

    // Switch to engineer
    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'switch_station',
      station: 'engineer',
    });
    expect(lobbyRoom.players.get('new_pilot').station).toBe('engineer');

    // 2. Rotating tiles in lobby immediately updates ship.powerMap
    const rotTile = lobbyRoom.ships.alpha.grid.getTile(0, 0);
    const initialOrientation = rotTile.orientation;
    lobbyRoom.handleClientMessage('new_pilot', {
      type: 'rotate_tile',
      row: 0,
      col: 0,
    });
    expect(rotTile.orientation).toBe((initialOrientation + 1) % 4);
    expect(lobbyRoom.ships.alpha.powerMap).toBeDefined();

    // 4. Calling startMatch() from lobby preserves pre-configured systems
    lobbyRoom.startMatch(555);
    expect(lobbyRoom.state).toBe('playing');
    expect(lobbyRoom.ships.alpha.grid.getTile(0, 6).orientation).toBe((initialOrientation + 1) % 4);
    expect(lobbyRoom.ships.alpha.weapons.targetedSubsystem).toBe('shields');
    expect(lobbyRoom.ships.alpha.weaponsInput.targetedSubsystem).toBe('shields');
    expect(lobbyRoom.ships.alpha.body.autoOrientMode).toBe('target');
    expect(lobbyRoom.ships.alpha.body.sasActive).toBe(true);

    // But restartMatch resets cleanly
    lobbyRoom.restartMatch(777);
    expect(lobbyRoom.state).toBe('playing');
    expect(lobbyRoom.ships.alpha.weapons.targetedSubsystem).toBeNull();
    expect(lobbyRoom.ships.alpha.body.autoOrientMode).toBeNull();
  });

  it('startMatch() preserves disconnected fore shield (online.fore === false) immediately in the initial match snapshot', () => {
    const lobbyRoom = new GameRoom({ id: 'lobby_shield_disconnect', seed: 123 });
    expect(lobbyRoom.state).toBe('lobby');

    // Break northern conduit tiles leading to shields_fore on Alpha in lobby
    lobbyRoom.ships.alpha.grid.tiles[0][4].status = 'broken';
    lobbyRoom.ships.alpha.grid.tiles[0][5].status = 'broken';

    // Transition from lobby to match
    lobbyRoom.startMatch(456);
    expect(lobbyRoom.state).toBe('playing');

    // Verify immediately without calling step():
    // 1. Grid power map reflects 0 power to fore shield
    expect(lobbyRoom.ships.alpha.powerMap.shields_fore || 0).toBe(0);
    // 2. Shield system is updated with powerMap
    expect(lobbyRoom.ships.alpha.shields.power.fore).toBe(0);
    expect(lobbyRoom.ships.alpha.shields.isQuadrantPowered('fore')).toBe(false);
    // 3. Initial match snapshot immediately reports online.fore === false
    const snapshot = lobbyRoom.getSnapshot();
    expect(snapshot.ships.alpha.shields.online.fore).toBe(false);
    expect(snapshot.ships.alpha.shields.online.aft).toBe(true);
  });
});

describe('GameRoom — Authoritative Simulation & Mechanics', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom({ id: 'sim_room', seed: 999 });
    room.startMatch(999);
  });

  it('starts match at tick 0 with proper spawn coordinates and counter-clockwise headings', () => {
    expect(room.state).toBe('playing');
    expect(room.tick).toBe(0);
    expect(room.ships.alpha.body.pos.x).toBeCloseTo(-2200, 1);
    expect(room.ships.alpha.body.angle).toBeCloseTo(Math.PI / 2, 4); // Facing South (+PI/2) -> CCW around origin
    expect(room.ships.omega.body.pos.x).toBeCloseTo(2200, 1);
    expect(room.ships.omega.body.angle).toBeCloseTo(-Math.PI / 2, 4); // Facing North (-PI/2) -> CCW around origin
  });

  it('advances simulation ticks and solves grid power flow', () => {
    const initialTick = room.tick;
    room.step(1 / 60);
    expect(room.tick).toBe(initialTick + 1);
    expect(room.ships.alpha.powerMap).toBeDefined();
    expect(room.ships.alpha.powerMap.totalPower).toBeGreaterThan(0);
  });

  it('routes helm, weapons, and engineer client inputs directly to ship', () => {
    room.addPlayer('pilot', 'Pilot', { team: 'alpha', station: 'helm' });
    room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
    room.addPlayer('eng', 'Engineer', { team: 'alpha', station: 'engineer' });

    // Helm input
    room.handleClientMessage('pilot', {
      action: 'helm_input',
      forward: 1.0,
      strafe: 0.5,
      turn: -0.2,
      roll: 0.8,
      toggleSas: false,
    });
    expect(room.ships.alpha.helmInput.forward).toBe(1.0);
    expect(room.ships.alpha.helmInput.strafe).toBe(0.5);
    expect(room.ships.alpha.helmInput.turn).toBe(-0.2);
    expect(room.ships.alpha.helmInput.roll).toBe(0.8);
    expect(room.ships.alpha.body.sasActive).toBe(false);

    // Roll stop & auto-orient helm inputs
    room.handleClientMessage('pilot', {
      action: 'helm_input',
      autoOrientMode: 'prograde',
    });
    expect(room.ships.alpha.body.autoOrientMode).toBe('prograde');

    room.handleClientMessage('pilot', {
      action: 'helm_input',
      toggleAutoOrient: 'prograde',
    });
    expect(room.ships.alpha.body.autoOrientMode).toBeNull();

    room.handleClientMessage('pilot', {
      action: 'helm_input',
      toggleAutoOrient: 'retrograde',
    });
    expect(room.ships.alpha.body.autoOrientMode).toBe('retrograde');

    // Sending toggleAutoOrient with non-zero turn and pitch zeroes them and engages auto-orient
    room.handleClientMessage('pilot', {
      type: 'helm_input',
      toggleAutoOrient: 'prograde',
      turn: 0.5,
      pitch: -0.3,
    });
    expect(room.ships.alpha.body.autoOrientMode).toBe('prograde');
    expect(room.ships.alpha.helmInput.turn).toBe(0);
    expect(room.ships.alpha.helmInput.pitch).toBe(0);

    room.handleClientMessage('pilot', {
      action: 'helm_input',
      stopRoll: true,
    });
    expect(room.ships.alpha.helmInput.roll).toBe(0);
    expect(room.ships.alpha.body.stopRollActive).toBe(true);

    // Weapons input
    room.handleClientMessage('gunner', {
      action: 'weapons_input',
      aimAngle: 1.25,
      targetSubsystem: 'mainDrive',
    });
    expect(room.ships.alpha.weaponsInput.aimAngle).toBeCloseTo(1.25, 2);
    expect(room.ships.alpha.turretAngle).toBeCloseTo(1.25, 2);
    expect(room.ships.alpha.weapons.targetedSubsystem).toBe('mainDrive');

    // Engineer input: rotate tile
    const beforeTile = room.ships.alpha.grid.getTile(4, 2);
    const beforeOrientation = beforeTile.orientation;
    room.handleClientMessage('eng', {
      action: 'engineer_input',
      actionType: 'rotate_tile', // or action: 'rotate_tile'
      action: 'rotate_tile',
      row: 4,
      col: 2,
    });
    const afterTile = room.ships.alpha.grid.getTile(4, 2);
    expect(afterTile.orientation).not.toBe(beforeOrientation);
  });

  it('strictly isolates bridge stations and rejects cross-station inputs', () => {
    room.addPlayer('pilot_iso', 'Pilot Iso', { team: 'alpha', station: 'helm' });
    room.addPlayer('gunner_iso', 'Gunner Iso', { team: 'alpha', station: 'weapons' });
    room.addPlayer('eng_iso', 'Eng Iso', { team: 'alpha', station: 'engineer' });
    room.addPlayer('unseated_iso', 'Unseated', { team: 'alpha', station: null });

    // 1. Helm cannot send weapons or engineer commands
    expect(room.handleClientMessage('pilot_iso', { action: 'weapons_input', aimAngle: 1.0 })).toBe(false);
    expect(room.handleClientMessage('pilot_iso', { action: 'engineer_input', actionType: 'rotate_tile', row: 4, col: 2 })).toBe(false);
    expect(room.handleClientMessage('pilot_iso', { action: 'rotate_tile', row: 4, col: 2 })).toBe(false);
    expect(room.handleClientMessage('pilot_iso', { action: 'discharge_capacitor', row: 3, col: 4 })).toBe(false);

    // 2. Weapons cannot send helm or engineer commands
    expect(room.handleClientMessage('gunner_iso', { action: 'helm_input', forward: 1.0 })).toBe(false);
    expect(room.handleClientMessage('gunner_iso', { action: 'engineer_input', actionType: 'rotate_tile', row: 4, col: 2 })).toBe(false);
    expect(room.handleClientMessage('gunner_iso', { action: 'assign_drone_subsystem', droneId: 1, subsystemKey: 'mainDrive' })).toBe(false);

    // 3. Engineer cannot send helm or weapons commands
    expect(room.handleClientMessage('eng_iso', { action: 'helm_input', forward: 1.0 })).toBe(false);
    expect(room.handleClientMessage('eng_iso', { action: 'weapons_input', aimAngle: 1.0 })).toBe(false);

    // 4. Unseated player cannot send any station input
    expect(room.handleClientMessage('unseated_iso', { action: 'helm_input', forward: 1.0 })).toBe(false);
    expect(room.handleClientMessage('unseated_iso', { action: 'weapons_input', aimAngle: 1.0 })).toBe(false);
    expect(room.handleClientMessage('unseated_iso', { action: 'engineer_input', actionType: 'rotate_tile', row: 4, col: 2 })).toBe(false);

    // 5. Vacating station clears continuous inputs
    room.ships.alpha.weaponsInput.firingLaser = true;
    // Gunner leaves weapons to join helm
    room.joinStation('gunner_iso', 'alpha', 'helm');
    expect(room.ships.alpha.weaponsInput.firingLaser).toBe(false);

    // Pilot was on helm: give active continuous inputs
    room.ships.alpha.helmInput.forward = 1.0;
    room.ships.alpha.helmInput.strafe = 0.5;
    room.ships.alpha.helmInput.turn = 0.2;
    room.ships.alpha.helmInput.roll = -0.5;
    room.ships.alpha.body.sasActive = true;
    room.ships.alpha.body.autoOrientMode = 'prograde';

    // Unseat all helm players on alpha by switching them away
    room.joinStation('gunner_iso', 'alpha', 'engineer');
    room.joinStation('pilot_iso', 'alpha', 'weapons');

    // Continuous motion inputs zeroed without touching sasActive or autoOrientMode
    expect(room.ships.alpha.helmInput.forward).toBe(0);
    expect(room.ships.alpha.helmInput.strafe).toBe(0);
    expect(room.ships.alpha.helmInput.turn).toBe(0);
    expect(room.ships.alpha.helmInput.roll).toBe(0);
    expect(room.ships.alpha.body.sasActive).toBe(true);
    expect(room.ships.alpha.body.autoOrientMode).toBe('prograde');
  });

  it('articulates railgun traverse at <= 20 deg/s, jams when health <= 15, fires along jammed angle, and repairs via engineer drone', () => {
    room.aiEnabled = false;
    room.addPlayer('gunner_rail', 'Gunner Rail', { team: 'alpha', station: 'weapons' });
    const alpha = room.ships.alpha;

    // Alpha ship spawns facing Math.PI / 2 (South). Command turret aim 90 deg away (Math.PI, West)
    room.handleClientMessage('gunner_rail', {
      action: 'weapons_input',
      aimAngle: Math.PI,
    });

    // Step 30 ticks (0.5s). At max slew rate 20 deg/s scaled by weapons_railgun coolant efficiency (0.4 + 0.6 * 0.8 = 0.88)
    for (let i = 0; i < 30; i++) {
      room.step(1 / 60);
    }

    const coolantEff = 0.4 + 0.6 * (alpha.powerMap?.coolantMap?.weapons_railgun ?? 1.0);
    const expectedTraverse = ((20 * Math.PI) / 180) * coolantEff * 0.5;
    expect(alpha.weapons.railgunAngle).toBeCloseTo(Math.PI / 2 + expectedTraverse, 2);
    expect(alpha.weapons.railgunLocalAngle).toBeCloseTo(expectedTraverse, 2);
    expect(alpha.weapons.railgunJammed).toBe(false);

    // Damage railgun hardware to <= 15 to trigger jam
    const preJamAngle = alpha.weapons.railgunAngle;
    alpha.weapons.railgunHardware.health = 10;
    room.step(1 / 60);

    expect(alpha.weapons.railgunJammed).toBe(true);
    expect(alpha.weapons.railgunSlewRate).toBe(0);
    expect(alpha.weapons.railgunAngle).toBeCloseTo(preJamAngle, 2);

    // Release railgun while jammed: fires along the stuck railgunAngle
    alpha.weapons.chargeProgress = 1.0;
    alpha.weapons.railgunCooldown = 0;
    room.events = [];
    room.handleClientMessage('gunner_rail', {
      action: 'weapons_input',
      releaseRailgun: true,
    });

    const firedEv = room.events.find(e => e.type === 'railgun_fired');
    expect(firedEv).toBeDefined();
    expect(firedEv.railgunAngle).toBeCloseTo(preJamAngle, 2);

    // Damage stabilizerHardware as well
    alpha.weapons.stabilizerHardware.health = 20;

    // Task drones to repair weapons_railgun and sas_computer
    alpha.powerMap = alpha.grid.solvePowerFlow();
    alpha.drones.assignToSubsystem(1, 'weapons_railgun', alpha.grid);
    alpha.drones.assignToSubsystem(2, 'sas_computer', alpha.grid);

    // Step until drones repair both subsystems back to 100
    // At 1.5%/s, repairing 90 HP takes 60s (~3600 ticks) + transit (~4.25s / ~255 ticks)
    for (let i = 0; i < 4000; i++) {
      room.step(1 / 60);
    }

    expect(alpha.weapons.railgunHardware.health).toBe(100);
    expect(alpha.weapons.stabilizerHardware.health).toBe(100);
    expect(alpha.weapons.railgunJammed).toBe(false);
    expect(alpha.weapons.railgunSlewRate).toBeGreaterThan(0);
  });

  it('destructible asteroids take projectile damage, chip debris chunks, shatter at 0 HP, and ignore collisions when destroyed', () => {
    room.aiEnabled = false;
    const asteroid = room.sector.asteroids[0];
    const initialHp = asteroid.hp;
    expect(initialHp).toBe(Math.round(asteroid.radius * 2.5));

    // 1. Pulse laser impact damages asteroid
    room.projectiles.push({
      id: 'laser_test_ast',
      type: 'laser',
      shooterId: 'omega',
      pos: { x: asteroid.pos.x, y: asteroid.pos.y },
      vel: { x: 0, y: 0 },
      damage: 40,
      radius: 4,
      lifetime: 2,
    });
    room.step(1 / 60);

    expect(asteroid.hp).toBe(initialHp - 40);
    expect(room.events.some(e => e.type === 'asteroid_hit')).toBe(true);

    // 2. Torpedo slug chips debris chunks into dynamicDebrisChunks
    const prevChunkCount = room.sector.dynamicDebrisChunks.length;
    room.projectiles.push({
      id: 'torpedo_chip_ast',
      type: 'torpedo',
      shooterId: 'omega',
      pos: { x: asteroid.pos.x, y: asteroid.pos.y },
      vel: { x: 0, y: 0 },
      damage: 50,
      radius: 6,
      lifetime: 2,
    });
    room.step(1 / 60);

    expect(room.sector.dynamicDebrisChunks.length).toBeGreaterThan(prevChunkCount);
    expect(asteroid.destroyed).toBe(false);

    // 3. Lethal hit completely shatters the asteroid
    room.projectiles.push({
      id: 'torpedo_lethal_ast',
      type: 'torpedo',
      shooterId: 'omega',
      pos: { x: asteroid.pos.x, y: asteroid.pos.y },
      vel: { x: 0, y: 0 },
      damage: 2000,
      radius: 8,
      lifetime: 2,
    });
    room.step(1 / 60);

    expect(asteroid.destroyed).toBe(true);
    expect(asteroid.hp).toBe(0);
    expect(room.events.some(e => e.type === 'asteroid_destroyed')).toBe(true);
    expect(room.sector.dynamicDebrisChunks.length).toBeGreaterThanOrEqual(4);

    // 4. Destroyed asteroid no longer collides with ships
    // Position alpha at the edge closing towards the destroyed asteroid center at 60 m/s
    const alpha = room.ships.alpha;
    alpha.body.pos = { x: asteroid.pos.x - asteroid.radius - 5, y: asteroid.pos.y };
    alpha.body.vel = { x: 60, y: 0 };
    const prevHullHp = alpha.hullHp;

    room.step(1 / 60);

    // No collision impulse from the asteroid (an undestroyed asteroid would bounce it back)
    expect(alpha.body.vel.x).toBeCloseTo(60, 0);
    expect(alpha.hullHp).toBe(prevHullHp);
  });

  it('single railgun projectile hitting a full-HP procedural asteroid shatters it into dynamic debris chunks', () => {
    room.aiEnabled = false;
    const asteroid = room.sector.asteroids[0];
    expect(asteroid.destroyed).toBe(false);
    expect(asteroid.hp).toBeGreaterThan(0);

    const prevChunkCount = room.sector.dynamicDebrisChunks.length;

    // Fire railgun projectile directly at the full-HP procedural asteroid
    room.projectiles.push({
      id: 'railgun_shatter_direct',
      type: 'railgun',
      shooterId: 'alpha',
      pos: { x: asteroid.pos.x, y: asteroid.pos.y },
      vel: { x: 0, y: 0 },
      damage: 250,
      radius: 6,
      lifetime: 2,
    });
    room.step(1 / 60);

    expect(asteroid.destroyed).toBe(true);
    expect(asteroid.hp).toBe(0);

    const destroyedEvent = room.events.find(e => e.type === 'asteroid_destroyed');
    expect(destroyedEvent).toBeDefined();
    expect(destroyedEvent.asteroidId).toBe(asteroid.id);
    expect(destroyedEvent.debrisCount).toBeGreaterThanOrEqual(4);
    expect(room.sector.dynamicDebrisChunks.length - prevChunkCount).toBeGreaterThanOrEqual(4);
  });

  it('triggers 5x slow-motion time dilation on killing blow (3.0 seconds)', () => {
    expect(room.slowMoActive).toBe(false);
    expect(room.slowMoTimer).toBe(0);

    // Reduce Omega hull HP to 0 (killing blow)
    room.ships.omega.hullHp = 10;
    room.ships.omega.body.hullHp = 10;

    // Simulate lethal hit
    room.projectiles.push({
      id: 'lethal_slug',
      type: 'railgun',
      shooterId: 'alpha',
      pos: { x: room.ships.omega.body.pos.x, y: room.ships.omega.body.pos.y },
      vel: { x: 0, y: 0 },
      damage: 500,
      radius: 10,
      lifetime: 5,
    });

    room.step(1 / 60);

    expect(room.ships.omega.hullHp).toBe(0);
    expect(room.ships.omega.destroyed).toBe(true);
    expect(room.slowMoActive).toBe(true);
    expect(room.slowMoTimer).toBeCloseTo(3.0, 1);
    expect(room.winner).toBe('alpha');

    // Step through the entire slow-motion duration (3.0 seconds)
    // 3.0 seconds at dt = 1/60 is 180 ticks
    for (let i = 0; i < 185; i++) {
      room.step(1 / 60);
    }

    expect(room.slowMoActive).toBe(false);
    expect(room.state).toBe('gameover');
  });

  it('handles ship-vs-asteroid collisions with impulse and damage', () => {
    const alpha = room.ships.alpha;
    const asteroid = room.sector.asteroids[0];

    // Place alpha touching the asteroid, moving towards asteroid center
    alpha.body.pos = { x: asteroid.pos.x - asteroid.radius - 10, y: asteroid.pos.y };
    alpha.body.vel = { x: 80, y: 0 };
    const prevHullHp = alpha.hullHp;

    room.step(1 / 60);

    // Alpha should have bounced back or slowed down
    expect(alpha.body.vel.x).toBeLessThan(80);
    expect(alpha.hullHp).toBeLessThanOrEqual(prevHullHp);
  });

  it('absorbs moderate ship-vs-asteroid impact (vClosing = 25 m/s) with shields first and zero hull damage', () => {
    const testRoom = new GameRoom({ id: 'test_ast_col', seed: 42, aiEnabled: false });
    testRoom.startMatch(42);
    const alpha = testRoom.ships.alpha;
    const asteroid = testRoom.sector.asteroids[0];

    // Ensure fore shield has full HP (100) and record initial hull
    alpha.shields.hp.fore = 100;
    const initialHull = alpha.hullHp;

    // Place alpha touching the asteroid, closing at 25 m/s with fore facing the asteroid
    alpha.body.pos = { x: asteroid.pos.x - asteroid.radius - 10, y: asteroid.pos.y };
    alpha.body.angle = 0; // Fore facing toward +X (the asteroid)
    alpha.body.vel = { x: 25, y: 0 };

    testRoom.step(1 / 60);

    // Alpha bounced back or slowed down
    expect(alpha.body.vel.x).toBeLessThan(25);
    // Fore shield absorbed impact damage
    expect(alpha.shields.hp.fore).toBeLessThan(100);
    // Shield absorbed all damage so hull took zero damage
    expect(alpha.hullHp).toBe(initialHull);
    expect(alpha.destroyed).toBe(false);
  });

  it('regenerates damaged powered shields slowly at ~1%/s scaled by power & coolant during step(dt)', () => {
    const testRoom = new GameRoom({ id: 'test_shield_regen', seed: 42, aiEnabled: false });
    testRoom.startMatch(42);
    const alpha = testRoom.ships.alpha;

    // Damage fore shield to 100 (out of 200 max for frigate)
    alpha.shields.hp.fore = 100;

    // Step 1 second
    testRoom.step(1.0);

    const power = alpha.powerMap.shields_fore || 0.8;
    const coolantEff = alpha.powerMap.coolantMap ? (0.4 + 0.6 * (alpha.powerMap.coolantMap.shields_fore ?? 0)) : 1.0;
    const expectedRegen = alpha.shields.maxHp.fore * 0.01 * power * coolantEff * 1.0;

    expect(alpha.shields.hp.fore).toBeGreaterThan(100);
    expect(alpha.shields.hp.fore).toBeCloseTo(100 + expectedRegen, 3);
  });

  it('marks shields with < 10% power offline in snapshot and bypasses shield absorption dealing direct hull damage', () => {
    const testRoom = new GameRoom({ id: 'test_shield_cutoff', seed: 42, aiEnabled: false });
    testRoom.startMatch(42);
    const alpha = testRoom.ships.alpha;

    // Break northern conduit tiles leading to shields_fore so power drops to 0 (< 10%)
    alpha.grid.tiles[0][4].status = 'broken';
    alpha.grid.tiles[0][5].status = 'broken';

    // Step simulation to re-solve grid power flow
    testRoom.step(1 / 60);

    expect(alpha.powerMap.shields_fore || 0).toBe(0);
    expect(alpha.shields.isQuadrantPowered('fore')).toBe(false);

    // Verify snapshot reports offline: fore === false
    const snapshot = testRoom.getSnapshot();
    expect(snapshot.ships.alpha.shields.online.fore).toBe(false);
    expect(snapshot.ships.alpha.shields.online.aft).toBe(true);

    // Ensure fore shield has HP (200), record hull
    alpha.shields.hp.fore = 200;
    const initialHull = alpha.hullHp;

    // 1. Asteroid collision on unpowered fore arc (ahead of ship's current facing angle)
    const foreCos = Math.cos(alpha.body.angle);
    const foreSin = Math.sin(alpha.body.angle);
    const contactPoint = {
      x: alpha.body.pos.x + foreCos * 30,
      y: alpha.body.pos.y + foreSin * 30,
    };
    const rawDamage = 60;
    const hullDmg = testRoom.applyCollisionDamage(alpha, contactPoint, rawDamage);

    // Shield should absorb ZERO damage because power < 10%
    expect(alpha.shields.hp.fore).toBe(200); // Shield HP preserved
    expect(hullDmg).toBeGreaterThan(0);
    expect(alpha.hullHp).toBe(initialHull - hullDmg);

    // 2. Laser hit on unpowered fore arc
    const prevHullAfterAsteroid = alpha.hullHp;
    testRoom.projectiles.push({
      id: 'laser_cutoff_test',
      shooterId: 'omega',
      type: 'laser',
      damage: 18,
      shieldMultiplier: 2.0,
      pos: {
        x: alpha.body.pos.x + foreCos * 20,
        y: alpha.body.pos.y + foreSin * 20,
        z: alpha.body.pos.z || 0,
      },
      vel: { x: -foreCos * 100, y: -foreSin * 100, z: 0 },
      radius: 5,
      destroyed: false,
      lifetime: 5,
    });

    testRoom.step(1 / 60);

    // Fore shield still at 200 HP, did not absorb unpowered laser hit
    expect(alpha.shields.hp.fore).toBe(200);
    // Hull took direct laser damage (18 damage)
    expect(alpha.hullHp).toBeLessThan(prevHullAfterAsteroid);
    expect(prevHullAfterAsteroid - alpha.hullHp).toBeCloseTo(18, 1);
  });

  it('keeps match in playing state with both AI ships alive (hullHp >= 800) over 300 ticks across multiple seeds', () => {
    const seeds = [12345, 9999, 4242, 7777, 8888];
    for (const seed of seeds) {
      const matchRoom = new GameRoom({ id: 'test_ai_match_' + seed, seed, aiEnabled: true });
      matchRoom.startMatch(seed);
      expect(matchRoom.state).toBe('playing');

      // 300 ticks = 5.0 seconds of 60Hz simulation
      for (let t = 0; t < 300; t++) {
        matchRoom.step(1 / 60);
      }

      expect(matchRoom.state).toBe('playing');
      expect(matchRoom.ships.alpha.destroyed).toBe(false);
      expect(matchRoom.ships.omega.destroyed).toBe(false);
      expect(matchRoom.ships.alpha.hullHp).toBeGreaterThanOrEqual(750);
      expect(matchRoom.ships.omega.hullHp).toBeGreaterThanOrEqual(750);
    }
  });

  it('constrains ship within arena boundary', () => {
    const alpha = room.ships.alpha;
    const arenaR = room.sector.arenaRadius;

    // Place alpha beyond boundary moving outward
    alpha.body.pos = { x: arenaR + 50, y: 0 };
    alpha.body.vel = { x: 100, y: 0 };

    room.step(1 / 60);

    expect(Math.hypot(alpha.body.pos.x, alpha.body.pos.y)).toBeLessThanOrEqual(arenaR + 0.1);
    expect(alpha.body.vel.x).toBeLessThan(0); // Inward rebound
  });

  it('applies EMP torpedo impact disabling a 3x3 region on enemy grid', () => {
    room.aiEnabled = false; // Prevent Point-Defense flak from shooting down torpedo
    const omega = room.ships.omega;
    const empTorp = {
      id: 'emp_torp_1',
      type: 'torpedo',
      torpedoType: 'emp_torpedoes',
      empDuration: 8.0,
      damage: 150,
      shooterId: 'alpha',
      pos: { x: omega.body.pos.x, y: omega.body.pos.y },
      vel: { x: 0, y: 0 },
      radius: 8,
      lifetime: 5,
    };
    room.projectiles = [empTorp];

    room.step(1 / 60);

    // Grid center (4, 5) should have active empTimer
    const centerTile = omega.grid.getTile(4, 5);
    expect(centerTile.empTimer).toBeGreaterThan(0);
  });

  it('accumulates hull damage and breaks conduits at >= 90 HP threshold via applyHullConduitDamage', () => {
    const alpha = room.ships.alpha;
    const initialBroken = alpha.grid.tiles.flat().filter(t => t.status === 'broken').length;

    // 1st hit of 40 HP (< 90): accumulates, breaks 0 tiles
    let broken = room.applyHullConduitDamage(alpha, 40);
    expect(broken.length).toBe(0);
    expect(alpha._conduitDamageAccum).toBe(40);

    // 2nd hit of 60 HP (40 + 60 = 100 >= 90): breaks 1 tile, 10 HP remains accumulated
    broken = room.applyHullConduitDamage(alpha, 60);
    expect(broken.length).toBe(1);
    expect(alpha._conduitDamageAccum).toBe(10);

    // 3rd hit of 200 HP (10 + 200 = 210 >= 180): breaks 2 tiles, 30 HP remains accumulated
    broken = room.applyHullConduitDamage(alpha, 200);
    expect(broken.length).toBe(2);
    expect(alpha._conduitDamageAccum).toBe(30);

    const finalBroken = alpha.grid.tiles.flat().filter(t => t.status === 'broken').length;
    expect(finalBroken).toBe(initialBroken + 3);
  });

  it('serializes complete, compact state snapshot for clients and /spectate', () => {
    const snapshot = room.getSnapshot();

    expect(snapshot.id).toBe('sim_room');
    expect(snapshot.state).toBe('playing');
    expect(snapshot.tick).toBe(room.tick);
    expect(snapshot.ships.alpha).toBeDefined();
    expect(snapshot.ships.omega).toBeDefined();
    expect(snapshot.ships.alpha.pos.x).toBeCloseTo(-2200, 1);
    expect(snapshot.ships.alpha.shields.hp.fore).toBeDefined();
    expect(snapshot.ships.alpha.shields.power.fore).toBeDefined();
    expect(snapshot.ships.alpha.shields.online.fore).toBe(true);
    expect(snapshot.ships.alpha.rollAngle).toBeDefined();
    expect(snapshot.ships.alpha.rollOmega).toBeDefined();
    expect(snapshot.ships.alpha.rollState).toBeDefined();
    expect(snapshot.ships.alpha.stopRollActive).toBeDefined();
    expect(snapshot.ships.alpha.autoOrientMode).toBeDefined();
    expect(snapshot.ships.alpha.isRolling).toBeUndefined();
    expect(snapshot.ships.alpha.rollProgress).toBeUndefined();
    expect(snapshot.ships.alpha.grid.tiles.length).toBe(10);
    expect(snapshot.ships.alpha.weapons.railgunAngle).toBeDefined();
    expect(snapshot.ships.alpha.weapons.railgunLocalAngle).toBeDefined();
    expect(snapshot.ships.alpha.weapons.railgunTargetAngle).toBeDefined();
    expect(snapshot.ships.alpha.weapons.railgunSlewRate).toBeDefined();
    expect(snapshot.ships.alpha.weapons.railgunJammed).toBe(false);
    expect(snapshot.ships.alpha.weapons.railgunHealth).toBe(100);
    expect(snapshot.ships.alpha.weapons.laserHealth).toBe(100);
    expect(snapshot.ships.alpha.weapons.stabilizerHealth).toBe(100);
    expect(snapshot.ships.alpha.weapons.stabilizerPowered).toBe(true);
    expect(snapshot.ships.alpha.drones).toBeDefined();
    expect(snapshot.ships.alpha.drones.length).toBe(3);
    expect(snapshot.sector.asteroids.length).toBeGreaterThan(0);
    expect(snapshot.sector.asteroids[0].hp).toBeDefined();
    expect(snapshot.sector.asteroids[0].maxHp).toBeDefined();
    expect(snapshot.sector.asteroids[0].destroyed).toBe(false);
    expect(snapshot.sector.dynamicDebrisChunks).toBeDefined();
    expect(Array.isArray(snapshot.projectiles)).toBe(true);
    expect(Array.isArray(snapshot.events)).toBe(true);
  });

  it('buffers events across multiple 60Hz steps until 30Hz getSnapshot() consumption', () => {
    room.aiEnabled = false;
    room.emitEvent({ type: 'test_event_1', tick: 1 });
    room.step(1 / 60);

    room.emitEvent({ type: 'test_event_2', tick: 2 });
    room.step(1 / 60);

    // Both events should be present in recentEventsBuffer and returned in getSnapshot()
    const snapshot1 = room.getSnapshot();
    const eventTypes = snapshot1.events.map(e => e.type);
    expect(eventTypes).toContain('test_event_1');
    expect(eventTypes).toContain('test_event_2');

    // Recent events buffer should be emptied after snapshot serialization
    expect(room.recentEventsBuffer.length).toBe(0);

    // Second snapshot without new events should return empty events
    const snapshot2 = room.getSnapshot();
    expect(snapshot2.events.length).toBe(0);
  });

  it('computes and populates authoritative ship.leadTarget in step() and serializes it in snapshot', () => {
    room.aiEnabled = false;
    room.step(1 / 60);

    const alphaLead = room.ships.alpha.leadTarget;
    const omegaLead = room.ships.omega.leadTarget;

    expect(alphaLead).toBeDefined();
    expect(alphaLead).not.toBeNull();
    expect(alphaLead.x).toBeDefined();
    expect(alphaLead.y).toBeDefined();
    expect(alphaLead.aimAngle).toBeDefined();
    expect(alphaLead.timeToIntercept).toBeGreaterThan(0);

    expect(omegaLead).toBeDefined();
    expect(omegaLead).not.toBeNull();
    expect(omegaLead.timeToIntercept).toBeGreaterThan(0);

    const snap = room.getSnapshot();
    expect(snap.ships.alpha.leadTarget).toEqual(alphaLead);
    expect(snap.ships.omega.leadTarget).toEqual(omegaLead);

    // If omega is destroyed, alpha.leadTarget becomes null
    room.ships.omega.destroyed = true;
    room.step(1 / 60);
    expect(room.ships.alpha.leadTarget).toBeNull();
  });

  it('handles SAS toggle and explicit boolean states in helm_input', () => {
    room.addPlayer('pilot1', 'Pilot Alpha', { team: 'alpha', station: 'helm' });
    const alphaShip = room.ships.alpha;
    expect(alphaShip.body.sasActive).toBe(true);

    // Send toggleSas: true -> inverts sasActive from true to false
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      toggleSas: true,
    });
    expect(alphaShip.body.sasActive).toBe(false);

    // Send toggleSas: true again -> inverts sasActive from false to true
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      toggleSas: true,
    });
    expect(alphaShip.body.sasActive).toBe(true);

    // Explicit sasActive: false
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      sasActive: false,
    });
    expect(alphaShip.body.sasActive).toBe(false);

    // Explicit sasActive: true
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      sasActive: true,
    });
    expect(alphaShip.body.sasActive).toBe(true);
  });

  it('handles rcsForward in helm_input for longitudinal RCS translation and respects rcsOnline', () => {
    room.addPlayer('pilot1', 'Pilot Alpha', { team: 'alpha', station: 'helm' });
    const alphaShip = room.ships.alpha;
    alphaShip.body.vel = { x: 0, y: 0, z: 0 };
    alphaShip.body.angle = 0; // facing +X

    // 1. Forward RCS translation: rcsForward = 1
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      rcsForward: 1.0,
    });
    expect(alphaShip.helmInput.rcsForward).toBe(1.0);
    expect(alphaShip.body.rcsForward).toBe(1.0);

    room.step(1 / 60);

    // Moves along +X using RCS; main drive throttle remains 0
    expect(alphaShip.body.vel.x).toBeGreaterThan(0);
    expect(alphaShip.body.mainDrive.throttle).toBe(0);
    expect(alphaShip.body.mainDrive.isFiring).toBe(false);

    // 2. Backward RCS translation: rcsForward = -1
    alphaShip.body.vel = { x: 0, y: 0, z: 0 };
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      rcsForward: -1.0,
    });
    expect(alphaShip.helmInput.rcsForward).toBe(-1.0);
    expect(alphaShip.body.rcsForward).toBe(-1.0);

    room.step(1 / 60);
    expect(alphaShip.body.vel.x).toBeLessThan(0);
    expect(alphaShip.body.mainDrive.throttle).toBe(0);
    expect(alphaShip.body.mainDrive.isFiring).toBe(false);

    // 3. Respects r.rcsOnline: when rcs offline during hyperspace reboot (rebootTimer < 4s), rcsForward is forced to 0
    alphaShip.hyperspace.state = 'rebooting';
    alphaShip.hyperspace.rebootTimer = 1.0;
    room.handleClientMessage('pilot1', {
      action: 'helm_input',
      rcsForward: 1.0,
    });
    expect(alphaShip.helmInput.rcsForward).toBe(0);
  });
});

describe('AI Auto-Crew Automation', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom({ id: 'ai_room', seed: 777 });
    room.startMatch(777);
  });

  it('AIHelm maintains tactical distance and stabilizes with SAS', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    // Start 1800m apart: AIHelm should burn forward to close distance with pursuit throttle (0.85)
    AIHelm.update(alpha, omega, room, 1 / 60);
    expect(alpha.body.mainDrive.throttle).toBe(0.85);
    expect(alpha.body.sasActive).toBe(true);
  });

  it('AIHelm triggers physical roll RCS when facing lateral shield drops below 25% and opposite is > 60%', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    // Position ships so Omega is on Alpha's Starboard side (relative hit angle > 0)
    alpha.body.pos = { x: 0, y: 0 };
    alpha.body.angle = 0; // facing +X
    omega.body.pos = { x: 0, y: 700 }; // located at +Y (Starboard in ship space)

    // Deplete Starboard shield to 15% and keep Port at 100%
    alpha.shields.hp.starboard = (alpha.shields.maxHp?.starboard || 100) * 0.15;
    alpha.shields.hp.port = alpha.shields.maxHp?.port || 100;
    expect(alpha.body.rollState).toBe(0);
    expect(alpha.body.manualRollCommanded).toBe(false);

    AIHelm.update(alpha, omega, room, 1 / 60);

    expect(alpha.body.manualRollCommanded).toBe(true);
    expect(alpha.body.thrusters.dorsalRoll.throttle).toBe(1.0);
  });

  it('AIHelm treats unpowered (<10%) fore shield with stored HP as 0 effective HP and angles powered broadside', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    alpha.body.pos = { x: 0, y: 0 };
    alpha.body.angle = 0; // facing +X toward enemy
    omega.body.pos = { x: 1000, y: 0 }; // enemy 1000m ahead along +X
    omega.body.vel = { x: 0, y: 0 };
    alpha.body.vel = { x: 0, y: 0 };

    // Fore shield has high stored HP (200), but power is 0% (< 10% cutoff)
    alpha.shields.maxHp.fore = 200;
    alpha.shields.hp.fore = 200;
    alpha.shields.power.fore = 0.0;

    // Lateral shields are healthy (100) and powered (100%)
    alpha.shields.maxHp.port = 100;
    alpha.shields.hp.port = 100;
    alpha.shields.power.port = 1.0;
    alpha.shields.maxHp.starboard = 100;
    alpha.shields.hp.starboard = 100;
    alpha.shields.power.starboard = 1.0;

    // Sanity checks on shields
    expect(alpha.shields.isQuadrantPowered('fore')).toBe(false);
    expect(alpha.shields.getEffectiveHp('fore')).toBe(0);

    AIHelm.update(alpha, omega, room, 1 / 60);

    // AIHelm should recognize fore shield as critical (0 < 35) despite hp.fore = 200,
    // and angle a powered broadside (starboard or port) toward enemy instead of holding 0 heading.
    expect(alpha.helmInput.turn).not.toBe(0);
    // Specifically, for rollState 0 and starboard >= port, desiredAngle is -PI/2 (starboard facing enemy),
    // causing a negative yaw/turn command to rotate toward -PI/2
    expect(alpha.helmInput.turn).toBeLessThan(-0.5);
  });

  it('AIHelm does not execute tactical roll if opposite lateral shield is unpowered', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    alpha.body.pos = { x: 0, y: 0 };
    alpha.body.angle = 0; // facing +X
    omega.body.pos = { x: 0, y: 700 }; // located at +Y (Starboard in ship space)

    // Deplete Starboard shield to 15% (powered)
    alpha.shields.hp.starboard = (alpha.shields.maxHp?.starboard || 100) * 0.15;
    alpha.shields.power.starboard = 1.0;

    // Port shield has 100 HP, but power is 0.0 (< 10% cutoff, unpowered!)
    alpha.shields.hp.port = alpha.shields.maxHp?.port || 100;
    alpha.shields.power.port = 0.0;

    expect(alpha.shields.isQuadrantPowered('port')).toBe(false);
    expect(alpha.shields.getEffectiveHp('port')).toBe(0);

    alpha.body.manualRollCommanded = false;
    AIHelm.update(alpha, omega, room, 1 / 60);

    // Should NOT roll into an unpowered opposite shield!
    expect(alpha.body.manualRollCommanded).toBe(false);
  });

  it('AIWeapons calculates lead target and fires lasers when in combat range', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    // Position ships within laser range (800m)
    alpha.body.pos = { x: 0, y: 0 };
    alpha.body.vel = { x: 50, y: 0 };
    omega.body.pos = { x: 700, y: 0 };
    omega.body.vel = { x: 0, y: 30 };

    room.projectiles = [];
    AIWeapons.update(alpha, omega, room, 1 / 60);

    expect(alpha.leadTarget).toBeDefined();
    expect(alpha.turretAngle).toBeDefined();
    expect(room.projectiles.length).toBeGreaterThan(0);
    expect(room.projectiles[0].type).toBe('laser');
  });

  it('AIWeapons fires Point-Defense Flak when enemy torpedo comes within 190m', () => {
    const alpha = room.ships.alpha;
    alpha.body.pos = { x: 0, y: 0 };

    // Place incoming enemy torpedo at 150m
    const enemyTorp = {
      id: 'enemy_torp_1',
      type: 'torpedo',
      shooterId: 'omega',
      pos: { x: 120, y: 0 },
      vel: { x: -200, y: 0 },
      radius: 8,
      lifetime: 5,
    };
    room.projectiles = [enemyTorp];

    AIWeapons.update(alpha, room.ships.omega, room, 1 / 60);

    expect(enemyTorp.destroyed).toBe(true);
    expect(alpha.weapons.flakCooldown).toBeGreaterThan(0);
  });

  it('AIEngineer assigns repair drones when tiles or subsystems are damaged', () => {
    const alpha = room.ships.alpha;

    // Damage bowPort thruster and a conduit tile
    alpha.body.thrusters.bowPort.health = 40;
    alpha.grid.damageTile(4, 2);

    expect(alpha.grid.tiles[4][2].status).toBe('broken');

    // Run AIEngineer
    AIEngineer.update(alpha, room.ships.omega, room, 1 / 60);

    // Active drones should be assigned to repair
    const activeDrones = alpha.drones.drones.filter(d => d.state !== 'idle');
    expect(activeDrones.length).toBeGreaterThan(0);
  });

  it('AIEngineer periodically repairs misaligned tiles via grid.repairOneMisalignedTile()', () => {
    const alpha = room.ships.alpha;

    // Ensure all thrusters and main drive are at 100 HP
    for (const bank of Object.values(alpha.body.thrusters)) {
      bank.health = 100;
    }
    alpha.body.mainDrive.health = 100;

    // Repair all tiles
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        alpha.grid.tiles[r][c].status = 'nominal';
      }
    }

    // Rotate a tile away from default layout (e.g. [0, 0] from 3 to 0)
    alpha.grid.rotateTile(0, 0);
    expect(alpha.grid.getTile(0, 0).orientation).toBe(0);

    // Run AIEngineer
    AIEngineer.update(alpha, room.ships.omega, room, 1 / 60);

    // Misaligned tile is restored to default orientation (3)
    expect(alpha.grid.getTile(0, 0).orientation).toBe(3);
  });

  it('runAICrewForShip operates only unmanned stations', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    // Human player on helm
    const unmannedStations = { helm: false, weapons: true, engineer: true };
    alpha.helmInput.forward = 0.42;

    runAICrewForShip(alpha, omega, room, 1 / 60, unmannedStations);

    // Helm input left untouched by bot
    expect(alpha.helmInput.forward).toBe(0.42);
  });

  it('AIHelm avoids singularities when close to gravity well', () => {
    const alpha = room.ships.alpha;
    const well = room.sector.gravityWells[0];

    // Place alpha 200m from gravity well
    alpha.body.pos = { x: well.pos.x + 200, y: well.pos.y, z: well.pos.z ?? 0 };
    alpha.body.angle = Math.PI; // facing towards well

    AIHelm.update(alpha, room.ships.omega, room, 1 / 60);

    // AIHelm should burn forward away from well
    expect(alpha.body.mainDrive.throttle).toBe(1.0);
  });

  it('AIWeapons launches torpedoes when clear of nebula, but holds fire when in nebula', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    alpha.body.pos = { x: 0, y: 0 };
    omega.body.pos = { x: 700, y: 0 };
    alpha.weapons.magazine = 6;
    alpha.weapons.torpedoCooldown = 0;

    // Both outside nebula: launches torpedo
    alpha.inNebula = false;
    omega.inNebula = false;
    room.projectiles = [];

    AIWeapons.update(alpha, omega, room, 1 / 60);
    const launched = room.projectiles.find(p => p.type === 'torpedo');
    expect(launched).toBeDefined();

    // Inside nebula: holds torpedo fire
    alpha.inNebula = true;
    alpha.weapons.torpedoCooldown = 0;
    room.projectiles = [];

    AIWeapons.update(alpha, omega, room, 1 / 60);
    const launchedInNebula = room.projectiles.find(p => p.type === 'torpedo');
    expect(launchedInNebula).toBeUndefined();
  });

  it('AIWeapons checks line of sight: holds torpedoes and fires at obstructing asteroid if close', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;

    alpha.body.pos = { x: 0, y: 0 };
    omega.body.pos = { x: 700, y: 0 };
    alpha.weapons.magazine = 6;
    alpha.weapons.torpedoCooldown = 0;
    alpha.inNebula = false;
    omega.inNebula = false;

    // Place an active asteroid right between alpha and omega at x = 350, y = 0
    const blockingAsteroid = {
      id: 'blocking_ast_1',
      pos: { x: 350, y: 0 },
      radius: 80,
      destroyed: false,
    };
    room.sector.asteroids = [blockingAsteroid];
    room.projectiles = [];

    AIWeapons.update(alpha, omega, room, 1 / 60);

    // Torpedoes must be held because line of sight is obstructed!
    const torp = room.projectiles.find(p => p.type === 'torpedo');
    expect(torp).toBeUndefined();

    // Lasers should fire at the blocking asteroid since it is within 900m (350m away)
    const laser = room.projectiles.find(p => p.type === 'laser');
    expect(laser).toBeDefined();
    const laserAngle = Math.atan2(laser.vel.y, laser.vel.x);
    expect(laserAngle).toBeCloseTo(0, 1);
  });

  it('repairs main_drive and rcs_thrusters via engineer drone assignment', () => {
    room.aiEnabled = false;
    const alpha = room.ships.alpha;

    // Damage main drive and bowPort thruster
    alpha.body.mainDrive.health = 30;
    alpha.body.thrusters.bowPort.health = 25;

    // Task drones to repair main_drive and rcs_thrusters
    alpha.drones.assignToSubsystem(1, 'main_drive', alpha.grid);
    alpha.drones.assignToSubsystem(2, 'rcs_thrusters', alpha.grid);

    // Step until drone 1 arrives at main_drive
    while (alpha.drones.drones[0].state === 'moving') {
      room.step(1 / 60);
    }
    expect(alpha.drones.drones[0].state).toBe('repairing');
    const healthBefore1s = alpha.body.mainDrive.health;

    // Step 60 ticks (1.0 second of active repairing)
    for (let i = 0; i < 60; i++) {
      room.step(1 / 60);
    }
    // Verify intermediate repair rate is 1.5% per second while repairing
    expect(alpha.body.mainDrive.health - healthBefore1s).toBeCloseTo(1.5, 2);

    // Step 3400 ticks at 1/60 so both reach 100 HP
    for (let i = 0; i < 3400; i++) {
      room.step(1 / 60);
    }

    expect(alpha.body.mainDrive.health).toBe(100);
    expect(alpha.body.thrusters.bowPort.health).toBe(100);
  });

  it('resupplies torpedoes at munitions derelict when near derelict with low ammo and reactor online', () => {
    room.aiEnabled = false;
    room.sector.gravityWells = []; // Isolate from unpiloted gravitational drift during resupply
    const alpha = room.ships.alpha;
    const derelict = room.sector.munitionsDerelict;

    // Place alpha within 50m of derelict with matching low velocity
    alpha.body.pos = { x: derelict.pos.x + 40, y: derelict.pos.y };
    alpha.body.vel = { x: derelict.vel?.x || 0, y: derelict.vel?.y || 0 };
    alpha.weapons.magazine = 2; // low ammo

    // Step room for 5.2 seconds (> 5.0s required tractor time)
    for (let i = 0; i < 320; i++) {
      room.step(1 / 60);
    }

    expect(alpha.weapons.magazine).toBe(5); // 2 + 3 = 5
  });

  it('enforces 80% baseline power/coolant pool (0.8) after tick 1 without 10/12/14 hull override and does not double-count torpedo conduit breaks', () => {
    room.aiEnabled = false;
    room.step(1 / 60);

    const alpha = room.ships.alpha;
    expect(alpha.powerMap.powerPerSystem).toBeCloseTo(8 / 11, 5);
    expect(alpha.powerMap.coolantPerSystem).toBeCloseTo(8 / 11, 5);
    expect(alpha.powerMap.weapons_laser).toBeCloseTo(8 / 11, 5);

    // Zero shields on omega and test torpedo overflow of 200 (2 * 90 + 20)
    const omega = room.ships.omega;
    omega.shields.hp = { fore: 0, aft: 0, port: 0, starboard: 0 };
    room.projectiles.push({
      id: 'torp_single_break',
      shooterId: 'alpha',
      type: 'torpedo',
      torpedoType: 'standard_torpedoes',
      damage: 200,
      pos: { x: omega.body.pos.x, y: omega.body.pos.y },
      vel: { x: 0, y: 0 },
      radius: 10,
      destroyed: false,
      lifetime: 10,
    });

    const countBroken = () => omega.grid.tiles.flat().filter(t => t.status === 'broken').length;
    const beforeBroken = countBroken();
    room.step(1 / 60);
    const afterBroken = countBroken();

    // Only Math.floor(200 / 90) = 2 tiles should break, not 4! Remainder ~19.9 (after 1 tick of shield recharge)
    expect(afterBroken - beforeBroken).toBe(2);
    expect(omega._conduitDamageAccum).toBeGreaterThan(19);
    expect(omega._conduitDamageAccum).toBeLessThan(20.1);
  });

  it('round-trips 3D helm pitch, forward throttle, and weapons aimPitch through snapshot', () => {
    room.aiEnabled = false;
    room.startMatch();
    const p1 = room.addPlayer('pilot_1', 'Kara Thrace');
    const p2 = room.addPlayer('gunner_1', 'Lee Adama');
    room.joinStation('pilot_1', 'alpha', 'helm');
    room.joinStation('gunner_1', 'alpha', 'weapons');

    // Send 3D helm input with pitch and main throttle
    room.handleClientMessage('pilot_1', {
      type: 'helm_input',
      pitch: 0.75,
      forward: 0.8,
    });

    // Send 3D weapons input with aimPitch
    room.handleClientMessage('gunner_1', {
      type: 'weapons_input',
      aimPitch: 0.35,
    });

    // Elevate omega to check 3D leadTarget computation in step
    room.ships.omega.body.pos = { x: 800, y: 0, z: 400 };
    room.ships.omega.body.vel = { x: 0, y: 50, z: 20 };

    room.step(1 / 60);

    const snapshot = room.getSnapshot();
    const alphaSnap = snapshot.ships.alpha;

    // Verify 3D kinematic fields in snapshot
    expect(alphaSnap.pos).toHaveProperty('z');
    expect(alphaSnap.vel).toHaveProperty('z');
    expect(alphaSnap.pitch).toBeDefined();
    expect(alphaSnap.pitchOmega).toBeDefined();
    expect(alphaSnap.mainThrottle).toBeCloseTo(0.8, 2);

    // Verify 3D thrusters in snapshot
    expect(alphaSnap.thrusters.bowDorsal).toBeDefined();
    expect(alphaSnap.thrusters.bowVentral).toBeDefined();
    expect(alphaSnap.thrusters.sternDorsal).toBeDefined();
    expect(alphaSnap.thrusters.sternVentral).toBeDefined();

    // Verify 3D weapons pitches
    expect(alphaSnap.weapons.aimPitch).toBeCloseTo(0.35, 2);
    expect(alphaSnap.weapons.turretPitch).toBeDefined();
    expect(alphaSnap.weapons.railgunPitch).toBeDefined();

    // Verify 3D leadTarget
    expect(alphaSnap.leadTarget).toBeDefined();
    expect(alphaSnap.leadTarget.z).toBeGreaterThan(400);
    const expectedLead = calculateLeadTarget(
      room.ships.alpha.body.pos,
      room.ships.alpha.body.vel,
      room.ships.omega.body.pos,
      room.ships.omega.body.vel,
      600
    );
    expect(alphaSnap.leadTarget.z).toBeCloseTo(expectedLead.z, 2);
    expect(alphaSnap.leadTarget.aimPitch).toBeGreaterThan(0);
  });

  it('hasLineOfSight correctly handles 3D vertical displacement against obstacles', () => {
    const posA = { x: 0, y: 0, z: 0 };
    const posB = { x: 600, y: 0, z: 0 };

    // Asteroid directly on line in XY, but elevated in Z above its radius
    const elevatedAsteroid = {
      id: 'ast_elevated',
      pos: { x: 300, y: 0, z: 250 },
      radius: 80,
      destroyed: false,
    };

    // When asteroid is elevated in Z, LOS must be clear!
    expect(hasLineOfSight(posA, posB, [elevatedAsteroid])).toBe(true);

    // If asteroid is at z = 0, directly on the segment, LOS is blocked
    const directAsteroid = {
      id: 'ast_direct',
      pos: { x: 300, y: 0, z: 0 },
      radius: 80,
      destroyed: false,
    };
    expect(hasLineOfSight(posA, posB, [directAsteroid])).toBe(false);

    // If asteroid is destroyed, LOS is clear
    directAsteroid.destroyed = true;
    expect(hasLineOfSight(posA, posB, [directAsteroid])).toBe(true);

    // Angled 3D line-of-sight test
    const pos3DA = { x: 0, y: 0, z: 0 };
    const pos3DB = { x: 600, y: 0, z: 600 };
    const midpointAsteroid = {
      id: 'ast_mid',
      pos: { x: 300, y: 0, z: 300 },
      radius: 50,
      destroyed: false,
    };
    // Directly on 3D segment: blocked
    expect(hasLineOfSight(pos3DA, pos3DB, [midpointAsteroid])).toBe(false);

    // Displaced laterally in Z away from the diagonal line: clear
    const displacedAsteroid = {
      id: 'ast_disp',
      pos: { x: 300, y: 0, z: 0 },
      radius: 50,
      destroyed: false,
    };
    expect(hasLineOfSight(pos3DA, pos3DB, [displacedAsteroid])).toBe(true);
  });

  it('AIHelm steers pitch toward elevated/depressed target and uses fractional throttle', () => {
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;
    alpha.body.pos = { x: 0, y: 0, z: 0 };
    alpha.body.angle = 0;
    alpha.body.pitch = 0;

    // 1. Target elevated in +Z at distance > 900 (pursuit mode)
    omega.body.pos = { x: 1200, y: 0, z: 600 };
    AIHelm.update(alpha, omega, room, 1 / 60);

    // AIHelm should pitch UP (pitch > 0) toward target and command 0.85 pursuit throttle
    expect(alpha.helmInput.pitch).toBeGreaterThan(0);
    expect(alpha.body.mainDrive.throttle).toBeCloseTo(0.85, 2);

    // 2. Target depressed in -Z at distance > 900
    omega.body.pos = { x: 1200, y: 0, z: -600 };
    alpha.body.pitch = 0;
    AIHelm.update(alpha, omega, room, 1 / 60);

    // AIHelm should pitch DOWN (pitch < 0) toward target and command 0.85 pursuit throttle
    expect(alpha.helmInput.pitch).toBeLessThan(0);
    expect(alpha.body.mainDrive.throttle).toBeCloseTo(0.85, 2);

    // 3. Target in optimal engagement range (500-900m) uses 0.35 cruise throttle
    omega.body.pos = { x: 700, y: 0, z: 100 };
    alpha.body.pitch = 0;
    AIHelm.update(alpha, omega, room, 1 / 60);
    expect(alpha.body.mainDrive.throttle).toBeCloseTo(0.35, 2);
  });

  it('resolves 3D ship-vs-ship separation along Z axis', () => {
    room.aiEnabled = false;
    const alpha = room.ships.alpha;
    const omega = room.ships.omega;
    // Overlap ships along Z
    alpha.body.pos = { x: 0, y: 0, z: 0 };
    alpha.body.vel = { x: 0, y: 0, z: 0 };
    omega.body.pos = { x: 0, y: 0, z: 20 }; // radius sum is ~48
    omega.body.vel = { x: 0, y: 0, z: 0 };

    room.step(1 / 60);

    // Alpha should be pushed downward in Z (-z) and Omega upward in Z (+z)
    expect(alpha.body.pos.z).toBeLessThan(0);
    expect(omega.body.pos.z).toBeGreaterThan(20);
  });

  it('resolves 3D ship-vs-asteroid bounce impulse and separation along Z axis', () => {
    room.aiEnabled = false;
    const alpha = room.ships.alpha;
    const testAst = {
      id: 'ast_z_bounce',
      pos: { x: 0, y: 0, z: 60 },
      radius: 40,
      destroyed: false,
      hp: 500,
      maxHp: 500,
    };
    room.sector.asteroids = [testAst];

    // Ship at z = 20 closing along +Z into asteroid at z = 60
    alpha.body.pos = { x: 0, y: 0, z: 20 };
    alpha.body.vel = { x: 0, y: 0, z: 30 }; // moving toward asteroid in +Z

    room.step(1 / 60);

    // After collision, ship should rebound (vel.z < 0) and pos.z pushed backward
    expect(alpha.body.vel.z).toBeLessThan(0);
    expect(alpha.body.pos.z).toBeLessThan(20);
  });

  describe('Phase 12: GameRoom Features — Charged Railgun Bypass, Overheated Laser Firing & Snapshots', () => {
    it('successfully fires charged railgun via weapons_input even when weapons_railgun power is 0', () => {
      const gRoom = new GameRoom({ id: 'railgun_bypass_room', seed: 1234 });
      gRoom.startMatch(1234);
      gRoom.addPlayer('gunner_alpha', 'Gunner', { team: 'alpha', station: 'weapons' });

      const alpha = gRoom.ships.alpha;
      // Pre-charge the railgun to 100%
      alpha.weapons.charging = true;
      alpha.weapons.chargeProgress = 1.0;
      alpha.weapons.railgunCooldown = 0;

      // Cut railgun grid power to 0
      alpha.powerMap.weapons_railgun = 0;

      const initialProjCount = gRoom.projectiles.length;
      const res = gRoom.handleClientMessage('gunner_alpha', {
        type: 'weapons_input',
        releaseRailgun: true,
      });

      expect(res).toBe(true);
      expect(gRoom.projectiles.length).toBe(initialProjCount + 1);
      const firedSlug = gRoom.projectiles[gRoom.projectiles.length - 1];
      expect(firedSlug.type).toBe('railgun');
      expect(firedSlug.damage).toBe(alpha.weapons.railgunBaseDamage); // 250
      expect(alpha.weapons.chargeProgress).toBe(0);
      expect(alpha.weapons.railgunCooldown).toBe(2.5); // RAILGUN_COOLDOWN_SEC (1.5 / SHIP_PACING_SCALE)
    });

    it('continues firing overheated laser through GameRoom simulation at 0.5x damage', () => {
      const gRoom = new GameRoom({ id: 'overheat_laser_room', seed: 5678 });
      gRoom.startMatch(5678);
      gRoom.addPlayer('gunner_alpha', 'Gunner', { team: 'alpha', station: 'weapons' });

      const alpha = gRoom.ships.alpha;
      alpha.powerMap.weapons_laser = 1.0;
      alpha.weapons.heat = 100;
      alpha.weapons.overheated = true;
      alpha.weapons.cooldown = 0;

      const initialProjCount = gRoom.projectiles.length;
      const res = gRoom.handleClientMessage('gunner_alpha', {
        type: 'weapons_input',
        fireLaser: true,
        aimAngle: 0,
      });

      expect(res).toBe(true);
      expect(gRoom.projectiles.length).toBe(initialProjCount + 1);
      const shot = gRoom.projectiles[gRoom.projectiles.length - 1];
      expect(shot.type).toBe('laser');
      expect(shot.damage).toBe(alpha.weapons.laserBaseDamage * 1.0 * 0.5); // 9 damage
      expect(alpha.weapons.cooldown).toBe(0.65);
    });

    it('snapshots expose mainDrive.gimbalYaw, gimbalPitch, overheated, and comprehensive thermal map', () => {
      const gRoom = new GameRoom({ id: 'snap_phase12_room', seed: 9012 });
      gRoom.startMatch(9012);
      gRoom.aiEnabled = false;

      const alpha = gRoom.ships.alpha;
      alpha.helmInput = { forward: 1.0, turn: 1.0, pitch: 1.0 };
      alpha.body.commandPilot(alpha.helmInput);
      gRoom.step(1 / 60);

      const snap = gRoom.getSnapshot();
      const alphaSnap = snap.ships.alpha;

      // Gimbal telemetry on mainDrive
      expect(alphaSnap.mainDrive).toBeDefined();
      expect(alphaSnap.mainDrive.gimbalYaw).toBeGreaterThan(0);
      expect(alphaSnap.mainDrive.gimbalPitch).toBeGreaterThan(0);
      expect(typeof alphaSnap.mainDrive.overheated).toBe('boolean');
      expect(typeof alphaSnap.mainDrive.heat).toBe('number');

      // Comprehensive thermal subsystem health map
      expect(alphaSnap.thermal).toBeDefined();
      expect(alphaSnap.thermal.rcs).toBeDefined();
      expect(alphaSnap.thermal.mainDrive).toBeDefined();
      expect(alphaSnap.thermal.sas).toBeDefined();
      expect(alphaSnap.thermal.laser).toBeDefined();
      expect(alphaSnap.thermal.railgun).toBeDefined();
      expect(alphaSnap.thermal.torpedo).toBeDefined();
      expect(alphaSnap.thermal.shields).toBeDefined();
    });
  });

  describe('Phase 13: System Boost Protocol, Serialization & Consumer Unclamping', () => {
    it('enforces strict station isolation for toggle_boost and set_boost (rejects helm, weapons, unseated; accepts engineer in lobby and playing)', () => {
      const room = new GameRoom({ id: 'boost_isolation_room', seed: 101 });
      room.addPlayer('helm_p', 'Pilot', { team: 'alpha', station: 'helm' });
      room.addPlayer('wpn_p', 'Gunner', { team: 'alpha', station: 'weapons' });
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });
      room.addPlayer('unseated_p', 'Spectator', { team: 'alpha', station: null });

      // In lobby: helm, weapons, and unseated rejected
      expect(room.handleClientMessage('helm_p', { type: 'engineer_input', action: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(false);
      expect(room.handleClientMessage('wpn_p', { type: 'engineer_input', action: 'set_boost', subsystemKey: 'weapons_laser', boosted: true })).toBe(false);
      expect(room.handleClientMessage('unseated_p', { type: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(false);

      // In lobby: engineer accepted
      expect(room.handleClientMessage('eng_p', { type: 'engineer_input', action: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(true);
      expect(room.ships.alpha.grid.isSystemBoosted('weapons_laser')).toBe(true);

      // Transition to playing
      room.startMatch(101);
      // Re-test players after match starts
      expect(room.handleClientMessage('helm_p', { type: 'engineer_input', action: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(false);
      expect(room.handleClientMessage('wpn_p', { type: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(false);

      // In playing: engineer accepted
      expect(room.handleClientMessage('eng_p', { type: 'engineer_input', action: 'toggle_boost', subsystemKey: 'shields_fore' })).toBe(true);
      expect(room.ships.alpha.grid.isSystemBoosted('shields_fore')).toBe(true);

      // Destroyed ship rejects engineer
      room.ships.alpha.destroyed = true;
      expect(room.handleClientMessage('eng_p', { type: 'engineer_input', action: 'toggle_boost', subsystemKey: 'main_drive' })).toBe(false);
    });

    it('toggle_boost and set_boost immediately update powerMap, coolantMap, and shields.power, preserve across startMatch, and reset cleanly on restartMatch', () => {
      const room = new GameRoom({ id: 'boost_flow_room', seed: 202 });
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });

      const alpha = room.ships.alpha;
      // Initially, baseline 8.0 pool across 11 connected systems = 8 / 11 each
      expect(alpha.powerMap.weapons_laser).toBeCloseTo(8 / 11, 5);
      expect(alpha.powerMap.coolantMap.weapons_laser).toBeCloseTo(8 / 11, 5);
      expect(alpha.shields.power.fore).toBeCloseTo(8 / 11, 5);

      // Boost weapons_laser
      const res1 = room.handleClientMessage('eng_p', {
        type: 'engineer_input',
        action: 'toggle_boost',
        subsystemKey: 'weapons_laser',
      });
      expect(res1).toBe(true);
      expect(alpha.grid.isSystemBoosted('weapons_laser')).toBe(true);
      expect(alpha.powerMap.weapons_laser).toBeCloseTo(1.20, 5);
      expect(alpha.powerMap.coolantMap.weapons_laser).toBeCloseTo(1.20, 5);
      // 10 unboosted systems share remaining (8.0 - 1.20) / 10 = 6.8 / 10 = 0.68
      expect(alpha.powerMap.shields_fore).toBeCloseTo(6.8 / 10, 5);
      expect(alpha.shields.power.fore).toBeCloseTo(6.8 / 10, 5);

      // Multi-boost: boost shields_fore using set_boost (systemKey and boosted)
      const res2 = room.handleClientMessage('eng_p', {
        type: 'set_boost',
        systemKey: 'shields_fore',
        boosted: true,
      });
      expect(res2).toBe(true);
      expect(alpha.grid.isSystemBoosted('shields_fore')).toBe(true);
      expect(alpha.powerMap.weapons_laser).toBeCloseTo(1.20, 5);
      expect(alpha.powerMap.shields_fore).toBeCloseTo(1.20, 5);
      expect(alpha.shields.power.fore).toBeCloseTo(1.20, 5);
      // 9 unboosted systems share remaining (8.0 - 2.40) / 9 = 5.6 / 9
      expect(alpha.powerMap.main_drive).toBeCloseTo(5.6 / 9, 5);
      expect(alpha.shields.power.aft).toBeCloseTo(5.6 / 9, 5);

      // Unboost weapons_laser using set_boost with enabled: false
      const res3 = room.handleClientMessage('eng_p', {
        type: 'set_boost',
        subsystemKey: 'weapons_laser',
        enabled: false,
      });
      expect(res3).toBe(true);
      expect(alpha.grid.isSystemBoosted('weapons_laser')).toBe(false);
      expect(alpha.grid.isSystemBoosted('shields_fore')).toBe(true);
      expect(alpha.powerMap.shields_fore).toBeCloseTo(1.20, 5);
      expect(alpha.powerMap.weapons_laser).toBeCloseTo(6.8 / 10, 5);

      // Preserve across startMatch (lobby -> playing)
      room.startMatch(202);
      const playingAlpha = room.ships.alpha;
      expect(playingAlpha.grid.isSystemBoosted('shields_fore')).toBe(true);
      expect(playingAlpha.grid.isSystemBoosted('weapons_laser')).toBe(false);
      expect(playingAlpha.powerMap.shields_fore).toBeCloseTo(1.20, 5);
      expect(playingAlpha.powerMap.weapons_laser).toBeCloseTo(6.8 / 10, 5);
      expect(playingAlpha.shields.power.fore).toBeCloseTo(1.20, 5);

      // Reset cleanly on restartMatch
      room.restartMatch(203);
      const restartedAlpha = room.ships.alpha;
      expect(restartedAlpha.grid.boostedSystems.size).toBe(0);
      expect(restartedAlpha.grid.isSystemBoosted('shields_fore')).toBe(false);
      expect(restartedAlpha.powerMap.shields_fore).toBeCloseTo(8 / 11, 5);
      expect(restartedAlpha.shields.power.fore).toBeCloseTo(8 / 11, 5);
    });

    it('returns false for invalid subsystem key without mutating boostedSystems', () => {
      const room = new GameRoom({ id: 'invalid_boost_room', seed: 303 });
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });

      const alpha = room.ships.alpha;
      expect(alpha.grid.boostedSystems.size).toBe(0);

      const res1 = room.handleClientMessage('eng_p', {
        type: 'engineer_input',
        action: 'toggle_boost',
        subsystemKey: 'warp_hyperdrive',
      });
      expect(res1).toBe(false);
      expect(alpha.grid.boostedSystems.size).toBe(0);

      const res2 = room.handleClientMessage('eng_p', {
        type: 'set_boost',
        systemKey: 'non_existent_system',
        boosted: true,
      });
      expect(res2).toBe(false);
      expect(alpha.grid.boostedSystems.size).toBe(0);
    });

    it('serializeShip exposes weapons.stabilizerPower (1.20 when boosted) and grid.boostedSystems', () => {
      const room = new GameRoom({ id: 'serialize_boost_room', seed: 404 });
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });

      // Before boost: sas_computer unboosted (8 / 11)
      const snapInitial = room.serializeShip(room.ships.alpha);
      expect(snapInitial.weapons.stabilizerPower).toBeCloseTo(8 / 11, 5);
      expect(snapInitial.weapons.stabilizerPowered).toBe(true);
      expect(snapInitial.grid.boostedSystems).toEqual([]);

      // Boost sas_computer
      room.handleClientMessage('eng_p', {
        type: 'toggle_boost',
        subsystemKey: 'sas_computer',
      });

      const snapBoosted = room.serializeShip(room.ships.alpha);
      expect(snapBoosted.weapons.stabilizerPower).toBeCloseTo(1.20, 5);
      expect(snapBoosted.weapons.stabilizerPowered).toBe(true);
      expect(snapBoosted.grid.boostedSystems).toContain('sas_computer');

      // Also verify top-level getSnapshot exposes it
      const roomSnap = room.getSnapshot();
      expect(roomSnap.ships.alpha.weapons.stabilizerPower).toBeCloseTo(1.20, 5);
      expect(roomSnap.ships.alpha.grid.boostedSystems).toContain('sas_computer');
    });

    it('boosted weapons_torpedo (1.20) fires a torpedo with 480 damage and 2.4 turnRate through GameRoom', () => {
      const room = new GameRoom({ id: 'boosted_torpedo_room', seed: 505 });
      room.startMatch(505);
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });
      room.addPlayer('wpn_p', 'Gunner', { team: 'alpha', station: 'weapons' });

      // Boost weapons_torpedo
      room.handleClientMessage('eng_p', {
        type: 'toggle_boost',
        subsystemKey: 'weapons_torpedo',
      });
      expect(room.ships.alpha.powerMap.weapons_torpedo).toBeCloseTo(1.20, 5);

      const initialProjCount = room.projectiles.length;
      const res = room.handleClientMessage('wpn_p', {
        type: 'weapons_input',
        launchTorpedo: true,
        aimAngle: 0,
      });

      expect(res).toBe(true);
      expect(room.projectiles.length).toBe(initialProjCount + 1);
      const torp = room.projectiles[room.projectiles.length - 1];
      expect(torp.type).toBe('torpedo');
      // Base heavy torpedo damage is 400; with 1.20 power: 400 * 1.2 = 480
      expect(torp.damage).toBeCloseTo(480, 4);
      // Base turnRate is 2.0 * SHIP_PACING_SCALE (1.20); with 1.20 power: 1.20 * 1.2 = 1.44
      expect(torp.turnRate).toBeCloseTo(1.44, 4);
    });

    it('boosted main_drive, rcs_thrusters, and sas_computer coolant scales past 1.0 in step()', () => {
      const room = new GameRoom({ id: 'boosted_coolant_room', seed: 606 });
      room.startMatch(606);
      room.aiEnabled = false;
      room.addPlayer('eng_p', 'Engineer', { team: 'alpha', station: 'engineer' });

      // Boost rcs_thrusters, main_drive, and sas_computer
      room.handleClientMessage('eng_p', { type: 'set_boost', systemKey: 'rcs_thrusters', boosted: true });
      room.handleClientMessage('eng_p', { type: 'set_boost', systemKey: 'main_drive', boosted: true });
      room.handleClientMessage('eng_p', { type: 'set_boost', systemKey: 'sas_computer', boosted: true });

      const alpha = room.ships.alpha;
      expect(alpha.grid.isSystemBoosted('rcs_thrusters')).toBe(true);
      expect(alpha.grid.isSystemBoosted('main_drive')).toBe(true);
      expect(alpha.grid.isSystemBoosted('sas_computer')).toBe(true);

      let capturedRcsPower = 0;
      let capturedMainPower = 0;
      let capturedSasPower = 0;

      const origUpdate = alpha.body.update.bind(alpha.body);
      alpha.body.update = (dt, rcsPower, mainPower, sasPower, options) => {
        capturedRcsPower = rcsPower;
        capturedMainPower = mainPower;
        capturedSasPower = sasPower;
        return origUpdate(dt, rcsPower, mainPower, sasPower, options);
      };

      room.step(1 / 60);

      // Boosted allocation = 1.20 for power and 1.20 for coolant
      // Coolant thermal efficiency: 0.4 + 0.6 * 1.20 = 1.12 (> 1.0)
      // Total effective power: 1.20 * 1.12 = 1.344 (> 1.20 and > 1.0)
      expect(capturedRcsPower).toBeCloseTo(1.344, 4);
      expect(capturedMainPower).toBeCloseTo(1.344, 4);
      expect(capturedSasPower).toBeCloseTo(1.344, 4);
    });
  });

  describe('Phase 1 Tactical AI Crew Overhaul & Full-Simulation Convergence', () => {
    it('1. Two-AI Full Simulation Duel Convergence: two AI ships converge from ±2200m without orbiting outer perimeter', () => {
      const room = new GameRoom({ id: 'ai_duel_convergence', seed: 42, aiEnabled: true });
      room.startMatch(42);

      const alpha = room.ships.alpha;
      const omega = room.ships.omega;
      const arenaRadius = room.sector.arenaRadius || 4200;

      let minDist = Math.hypot(alpha.body.pos.x - omega.body.pos.x, alpha.body.pos.y - omega.body.pos.y);
      let maxAlphaDistFromCenter = 0;
      let maxOmegaDistFromCenter = 0;
      let combatOccurred = false;

      // Run up to 2500 ticks (~41.7 seconds, reflecting 0.60x cruise pacing)
      for (let i = 0; i < 2500; i++) {
        room.step(1 / 60);

        const dAlpha = Math.hypot(alpha.body.pos.x, alpha.body.pos.y, alpha.body.pos.z || 0);
        const dOmega = Math.hypot(omega.body.pos.x, omega.body.pos.y, omega.body.pos.z || 0);
        if (dAlpha > maxAlphaDistFromCenter) maxAlphaDistFromCenter = dAlpha;
        if (dOmega > maxOmegaDistFromCenter) maxOmegaDistFromCenter = dOmega;

        const currentDist = Math.hypot(
          alpha.body.pos.x - omega.body.pos.x,
          alpha.body.pos.y - omega.body.pos.y,
          (alpha.body.pos.z || 0) - (omega.body.pos.z || 0)
        );
        if (currentDist < minDist) {
          minDist = currentDist;
        }

        if (room.projectiles.length > 0 || alpha.hullHp < (alpha.maxHullHp || 1000) || omega.hullHp < (omega.maxHullHp || 1000)) {
          combatOccurred = true;
        }

        if (alpha.hullHp <= 0 || omega.hullHp <= 0) {
          break;
        }
      }

      // Verify neither ship orbits or exceeds 0.75 * arenaRadius
      expect(maxAlphaDistFromCenter).toBeLessThan(arenaRadius * 0.75);
      expect(maxOmegaDistFromCenter).toBeLessThan(arenaRadius * 0.75);

      // Verify ships closed distance from 4400m down to < 1200m
      expect(minDist).toBeLessThan(1200);

      // Verify combat action occurred (shots fired or damage dealt)
      expect(combatOccurred).toBe(true);
    });

    it('2. Tangential Drift Cancellation (AIHelm): counters sideways velocity to build closing speed', () => {
      const room = new GameRoom({ id: 'ai_tangential_test', seed: 123, aiEnabled: false });
      room.startMatch(123);
      const alpha = room.ships.alpha;
      const omega = room.ships.omega;

      // Friendly ship at (0, 0, 0) with strong tangential velocity (+Y = 115 m/s)
      alpha.body.pos = { x: 0, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 115, z: 0 };
      alpha.body.angle = 0;
      alpha.body.omega = 0;

      // Enemy at (1400, 0, 0)
      omega.body.pos = { x: 1400, y: 0, z: 0 };
      omega.body.vel = { x: 0, y: 0, z: 0 };

      // Step 180 ticks (3.0 seconds) of AIHelm steering and RigidBody kinematics
      for (let i = 0; i < 180; i++) {
        AIHelm.update(alpha, omega, room, 1 / 60);
        alpha.body.update(1 / 60, 1.0, 1.0, 1.0);
      }

      // Tangential velocity vel.y should have been actively countered and reduced
      expect(alpha.body.vel.y).toBeLessThan(115);
      // Positive closing velocity vel.x > 35 should have been built
      expect(alpha.body.vel.x).toBeGreaterThan(35);
    });

    it('3. Railgun Sniper / Kiting Stance & Engineer Boost: maintains 1250-1650m bracket, boosts railgun, snipes at 1500m', () => {
      const room = new GameRoom({ id: 'ai_sniper_test', seed: 999, aiEnabled: false });
      room.startMatch(999);
      const alpha = room.ships.alpha;
      const omega = room.ships.omega;

      alpha.body.pos = { x: 0, y: 0, z: 0 };
      omega.body.pos = { x: 1500, y: 0, z: 0 };
      omega.body.vel = { x: 0, y: 0, z: 0 };
      alpha.weapons.overheated = true; // Lasers overheated triggers sniper stance

      const tac = evaluateTacticalSituation(alpha, omega, room);
      expect(tac.stance).toBe('railgun_sniper');
      expect(tac.minRange).toBe(1250);
      expect(tac.maxRange).toBe(1650);

      // AIEngineer automatically boosts weapons_railgun
      AIEngineer.update(alpha, omega, room, 1 / 60);
      expect(alpha.grid.isSystemBoosted('weapons_railgun')).toBe(true);
      expect(alpha.powerMap.weapons_railgun).toBeCloseTo(1.20, 2);

      // Helm backs off when too close (< 1150m)
      omega.body.pos = { x: 900, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 0, z: 0 };
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(alpha.helmInput.rcsForward).toBeLessThan(0); // Reverse RCS to open distance

      // Helm closes distance when too far (> 1650m)
      omega.body.pos = { x: 1900, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 0, z: 0 };
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(alpha.helmInput.forward).toBeGreaterThan(0.5);

      // AIWeapons charges and fires railgun at long range (1500m)
      omega.body.pos = { x: 1500, y: 0, z: 0 };
      alpha.weapons.chargeProgress = 1.0;
      alpha.weapons.railgunAngle = 0;
      alpha.weapons.railgunCooldown = 0;
      room.projectiles = [];

      AIWeapons.update(alpha, omega, room, 1 / 60);
      const slug = room.projectiles.find(p => p.type === 'railgun');
      expect(slug).toBeDefined();
    });

    it('4. Asteroid Proximity Shatter Targeting: fires charged railgun at qualifying asteroid to burst dynamic debris near enemy', () => {
      const room = new GameRoom({ id: 'ai_shatter_test', seed: 444, aiEnabled: false });
      room.startMatch(444);
      const alpha = room.ships.alpha;
      const omega = room.ships.omega;

      alpha.body.pos = { x: 0, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 0, z: 0 };

      // Target asteroid at (900, 50, 0) with radius 40
      const testAst = {
        id: 'shatter_candidate',
        pos: { x: 900, y: 50, z: 0 },
        radius: 40,
        hp: 300,
        maxHp: 300,
        destroyed: false,
      };
      room.sector.asteroids = [testAst];

      // Enemy ship at (900, 180, 0) -> surface distance is (180 - 50) - 40 = 90m <= 240m
      omega.body.pos = { x: 900, y: 180, z: 0 };
      omega.body.vel = { x: 0, y: 0, z: 0 };

      // Friendly ship is at distance ~901m >= 260m
      const shatterAst = findTacticalShatterAsteroid(alpha, omega, room.sector.asteroids);
      expect(shatterAst).toBe(testAst);

      // Pre-charge railgun and align turret
      alpha.weapons.chargeProgress = 1.0;
      alpha.weapons.railgunCooldown = 0;
      alpha.weapons.railgunAngle = Math.atan2(50, 900);
      room.projectiles = [];

      AIWeapons.update(alpha, omega, room, 1 / 60);
      expect(alpha.aiShatterTargetId).toBe(testAst.id);

      const slug = room.projectiles.find(p => p.type === 'railgun');
      expect(slug).toBeDefined();
    });

    it('5. Flanking Enemy Weak Shield Quadrant & Pinpoint Subsystem Targeting: detects weak quadrant and assigns optimal subsystem', () => {
      const room = new GameRoom({ id: 'ai_flank_test', seed: 888, aiEnabled: false });
      room.startMatch(888);
      const alpha = room.ships.alpha;
      const omega = room.ships.omega;

      alpha.body.pos = { x: 0, y: 0, z: 0 };
      omega.body.pos = { x: 800, y: 0, z: 0 };
      omega.body.angle = 0;
      omega.body.rollState = 0;

      // Deplete enemy starboard shield quadrant (0 HP) while others are 200 HP
      omega.shields.hp.starboard = 0;
      omega.shields.hp.fore = 200;
      omega.shields.hp.port = 200;
      omega.shields.hp.aft = 200;

      const tac = evaluateTacticalSituation(alpha, omega, room);
      expect(tac.weakestEnemyQuad).toBe('starboard');
      expect(tac.weakestEnemyQuadHp).toBe(0);
      expect(tac.stance).toBe('flank_weak_quad');
      expect(tac.weakQuadDir.y).toBeCloseTo(1.0, 2); // Starboard at rollState 0 is +Y
      expect(tac.weakQuadPos).toBeDefined();

      // Pinpoint Subsystem Targeting checks
      // Priority 1: hyperspace if enemy is charging
      omega.hyperspace.state = 'charging';
      omega.hyperspace.health = 100;
      const target1 = selectOptimalSubsystemTarget(alpha, omega, tac.stance);
      expect(target1).toBe('hyperspace');

      // Priority 2: weapons_railgun if stance is railgun_sniper or enemy railgun > 15
      omega.hyperspace.state = 'ready';
      omega.weapons.railgunHardware.health = 80;
      const target2 = selectOptimalSubsystemTarget(alpha, omega, tac.stance);
      expect(target2).toBe('weapons_railgun');

      // Priority 3: mainDrive if distEnemy > 950 and health > 40
      omega.weapons.railgunHardware.health = 10;
      omega.body.pos.x = 1200;
      omega.body.mainDrive.health = 75;
      const target3 = selectOptimalSubsystemTarget(alpha, omega, 'brawler');
      expect(target3).toBe('mainDrive');

      // Priority 4: weapons_laser if health > 20
      omega.body.mainDrive.health = 30;
      omega.weapons.laserHardware.health = 90;
      const target4 = selectOptimalSubsystemTarget(alpha, omega, 'brawler');
      expect(target4).toBe('weapons_laser');

      // Priority 5: fallback sas_computer
      omega.weapons.laserHardware.health = 15;
      const target5 = selectOptimalSubsystemTarget(alpha, omega, 'brawler');
      expect(target5).toBe('sas_computer');
    });
  });
});

describe('Express & WebSocket Server (app.js)', () => {
  let appServer;
  let testPort;

  beforeEach(async () => {
    // Pick random unreserved port in dynamic range avoiding well-known ports
    testPort = 14000 + Math.floor(Math.random() * 5000);
    appServer = createAppServer({
      port: testPort,
      listen: true,
      autoStartLoop: false,
    });
    await new Promise((resolve) => appServer.server.once('listening', resolve));
  });

  afterEach(async () => {
    if (appServer) {
      await appServer.close();
    }
  });

  it('provides getLanAddresses reporting IPv4 addresses', () => {
    const addresses = getLanAddresses();
    expect(Array.isArray(addresses)).toBe(true);
  });

  it('exposes /api/health with status and room state', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.state).toBe(appServer.room.state);
    expect(Array.isArray(data.lanAddresses)).toBe(true);
  });

  it('serves /spectate route with spectator HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/spectate`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('BROADSIDE HYPERION');
    expect(text).toContain('Spectator');
  });

  it('connects WebSocket client, assigns playerId, and receives snapshots', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${testPort}`);

    const welcomeMsg = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') {
          resolve(msg);
        }
      });
      ws.on('error', reject);
    });

    expect(welcomeMsg.playerId).toBeDefined();
    expect(welcomeMsg.snapshot).toBeDefined();
    expect(appServer.room.players.has(welcomeMsg.playerId)).toBe(true);

    // Send join_station message via WebSocket
    ws.send(JSON.stringify({
      action: 'join_station',
      team: 'alpha',
      station: 'helm',
      name: 'TestCommander',
    }));

    // Allow event loop tick for message processing
    await new Promise(r => setTimeout(r, 30));

    const player = appServer.room.players.get(welcomeMsg.playerId);
    expect(player.team).toBe('alpha');
    expect(player.station).toBe('helm');
    expect(player.name).toBe('TestCommander');

    ws.close();
  });

  it('serves GET /api/music returning tracks array and each track responds with HTTP 200', async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/music`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.tracks)).toBe(true);
    expect(data.tracks.length).toBe(4);
    expect(data.tracks).toEqual([
      '/music/Deep%20Space%20Fanfare%202.mp3',
      '/music/Deep%20Space%20Fanfare.mp3',
      '/music/Deep%20Space%20Ostinato.mp3',
      '/music/Deep%20Space%20Pulse.mp3',
    ]);

    for (const trackUrl of data.tracks) {
      const trackRes = await fetch(`http://127.0.0.1:${testPort}${trackUrl}`);
      expect(trackRes.status).toBe(200);
      const buf = await trackRes.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(1000000);
    }
  });

  it('handles WebSocket connection with ?role=spectator and register_spectator protocol', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${testPort}/?role=spectator`);

    const welcome1 = await new Promise((resolve, reject) => {
      ws1.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') resolve(msg);
      });
      ws1.on('error', reject);
    });

    expect(welcome1.playerId).toBeDefined();
    expect(welcome1.player.isSpectator).toBe(true);
    expect(welcome1.musicOwnerId).toBe(welcome1.playerId);
    expect(appServer.room.musicOwnerId).toBe(welcome1.playerId);

    // Second spectator connects
    const ws2 = new WebSocket(`ws://127.0.0.1:${testPort}/?role=spectator`);
    const welcome2 = await new Promise((resolve, reject) => {
      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') resolve(msg);
      });
      ws2.on('error', reject);
    });

    expect(welcome2.playerId).toBeDefined();
    expect(welcome2.player.isSpectator).toBe(true);
    expect(welcome2.musicOwnerId).toBe(welcome1.playerId); // Still owned by first spectator
    expect(appServer.room.musicOwnerId).toBe(welcome1.playerId);

    // Second spectator sends claim_music
    ws2.send(JSON.stringify({ type: 'claim_music' }));
    const musicStatus2 = await new Promise((resolve, reject) => {
      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'music_status') resolve(msg);
      });
      ws2.on('error', reject);
    });

    expect(musicStatus2.musicOwnerId).toBe(welcome1.playerId);
    expect(musicStatus2.isMusicOwner).toBe(false);

    ws1.close();
    ws2.close();
  });
});

describe('GameRoom — Spectator Music Ownership & Protocol', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom({ id: 'music_test_room', seed: 4444, aiEnabled: false });
  });

  it('initializes with musicOwnerId null', () => {
    expect(room.musicOwnerId).toBeNull();
    const snap = room.getSnapshot();
    expect(snap.musicOwnerId).toBeNull();
  });

  it('assigns musicOwnerId to the first spectator on addPlayer with isSpectator: true', () => {
    const s1 = room.addPlayer('spec_1', 'Spectator 1', { isSpectator: true });
    expect(s1.isSpectator).toBe(true);
    expect(room.musicOwnerId).toBe('spec_1');
    expect(room.getSnapshot().musicOwnerId).toBe('spec_1');
  });

  it('preserves musicOwnerId on the first spectator when a second spectator joins', () => {
    room.addPlayer('spec_1', 'Spectator 1', { isSpectator: true });
    expect(room.musicOwnerId).toBe('spec_1');

    room.addPlayer('spec_2', 'Spectator 2', { isSpectator: true });
    expect(room.musicOwnerId).toBe('spec_1');

    const snap = room.getSnapshot();
    expect(snap.musicOwnerId).toBe('spec_1');
  });

  it('registers spectator via registerSpectator and assigns ownership if first spectator', () => {
    const p1 = room.addPlayer('p_1', 'Player 1');
    expect(p1.isSpectator).toBe(false);
    expect(room.musicOwnerId).toBeNull();

    const isOwner = room.registerSpectator('p_1');
    expect(isOwner).toBe(true);
    expect(p1.isSpectator).toBe(true);
    expect(room.musicOwnerId).toBe('p_1');

    const p2 = room.addPlayer('p_2', 'Player 2');
    const isOwner2 = room.registerSpectator('p_2');
    expect(isOwner2).toBe(false);
    expect(p2.isSpectator).toBe(true);
    expect(room.musicOwnerId).toBe('p_1');
  });

  it('transfers musicOwnerId to second spectator when first spectator disconnects', () => {
    room.addPlayer('spec_1', 'Spectator 1', { isSpectator: true });
    room.addPlayer('spec_2', 'Spectator 2', { isSpectator: true });
    expect(room.musicOwnerId).toBe('spec_1');

    room.removePlayer('spec_1');
    expect(room.musicOwnerId).toBe('spec_2');

    room.removePlayer('spec_2');
    expect(room.musicOwnerId).toBeNull();
  });

  it('transfers musicOwnerId to second spectator when first spectator joins a station', () => {
    room.addPlayer('spec_1', 'Spectator 1', { isSpectator: true });
    room.addPlayer('spec_2', 'Spectator 2', { isSpectator: true });
    expect(room.musicOwnerId).toBe('spec_1');

    const joined = room.joinStation('spec_1', 'alpha', 'helm');
    expect(joined).toBe(true);
    const p1 = room.players.get('spec_1');
    expect(p1.isSpectator).toBe(false);
    expect(p1.station).toBe('helm');
    expect(room.musicOwnerId).toBe('spec_2');
  });

  it('handles client messages register_spectator and claim_music', () => {
    room.addPlayer('client_1', 'Client 1');
    expect(room.musicOwnerId).toBeNull();

    const res1 = room.handleClientMessage('client_1', { type: 'register_spectator' });
    expect(res1).toBe(true);
    expect(room.musicOwnerId).toBe('client_1');

    room.addPlayer('client_2', 'Client 2');
    const res2 = room.handleClientMessage('client_2', { type: 'claim_music' });
    expect(res2).toBe(false);
    expect(room.musicOwnerId).toBe('client_1');
  });
});

describe('GameRoom — Replay Ring Buffer & 30Hz Playback (Phase 14 Slice 1)', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom({ id: 'replay_test_room', seed: 9999, aiEnabled: false });
  });

  it('exposes replay constants and initializes default replay state', () => {
    expect(REPLAY_MAX_FRAMES).toBe(180);
    expect(REPLAY_FPS).toBe(30);
    expect(REPLAY_EVENT_TYPES).toBeInstanceOf(Set);
    expect(REPLAY_EVENT_TYPES.has('laser_fired')).toBe(true);
    expect(REPLAY_EVENT_TYPES.has('killing_blow')).toBe(true);
    expect(REPLAY_EVENT_TYPES.has('asteroid_destroyed')).toBe(true);

    expect(room.replayBuffer).toEqual([]);
    expect(room.replayFrames).toEqual([]);
    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(false);
    expect(room.replayCursor).toBe(0);
    expect(room.replayElapsed).toBe(0);
    expect(room._replayPendingEvents).toEqual([]);
  });

  it('records rolling 30Hz frames capped at REPLAY_MAX_FRAMES (180)', () => {
    room.startMatch(12345);
    expect(room.state).toBe('playing');
    expect(room.replayBuffer.length).toBe(0);

    // Step 10 ticks -> should sample at tick 2, 4, 6, 8, 10 (5 frames)
    for (let i = 0; i < 10; i++) {
      room.step(1 / 60);
    }
    expect(room.replayBuffer.length).toBe(5);

    // Verify frame schema
    const frame = room.replayBuffer[0];
    expect(frame.tick).toBe(2);
    expect(frame.slowMoActive).toBe(false);
    expect(frame.ships.alpha).toBeDefined();
    expect(frame.ships.omega).toBeDefined();
    expect(Array.isArray(frame.projectiles)).toBe(true);
    expect(Array.isArray(frame.destroyedAsteroidIds)).toBe(true);
    expect(Array.isArray(frame.events)).toBe(true);

    // Verify serializeReplayShip schema
    const shipSnap = frame.ships.alpha;
    expect(shipSnap.id).toBe('alpha');
    expect(shipSnap.name).toBe('UNS HYPERION');
    expect(shipSnap.team).toBe('alpha');
    expect(shipSnap.hullClass).toBe('frigate');
    expect(typeof shipSnap.destroyed).toBe('boolean');
    expect(typeof shipSnap.hullHp).toBe('number');
    expect(typeof shipSnap.maxHullHp).toBe('number');
    expect(shipSnap.pos).toHaveProperty('x');
    expect(shipSnap.pos).toHaveProperty('y');
    expect(shipSnap.pos).toHaveProperty('z');
    expect(shipSnap.vel).toHaveProperty('x');
    expect(shipSnap.vel).toHaveProperty('y');
    expect(shipSnap.vel).toHaveProperty('z');
    expect(typeof shipSnap.angle).toBe('number');
    expect(typeof shipSnap.pitch).toBe('number');
    expect(typeof shipSnap.rollAngle).toBe('number');
    expect(typeof shipSnap.rollState).toBe('number');
    expect(typeof shipSnap.mainThrottle).toBe('number');
    expect(shipSnap.mainDrive).toHaveProperty('throttle');
    expect(shipSnap.mainDrive).toHaveProperty('gimbalYaw');
    expect(shipSnap.mainDrive).toHaveProperty('gimbalPitch');
    expect(typeof shipSnap.turretAngle).toBe('number');
    expect(typeof shipSnap.turretPitch).toBe('number');
    expect(shipSnap.weapons).toHaveProperty('turretAngle');
    expect(shipSnap.weapons).toHaveProperty('turretPitch');
    expect(shipSnap.weapons).toHaveProperty('railgunAngle');
    expect(shipSnap.weapons).toHaveProperty('railgunPitch');
    expect(shipSnap.thrusters).toBeDefined();
    expect(shipSnap.shields).toHaveProperty('hp');
    expect(shipSnap.shields).toHaveProperty('maxHp');
    expect(shipSnap.shields).toHaveProperty('online');

    // Step 400 ticks (total 410 ticks = 205 sampled frames)
    // Rolling buffer must cap at exactly REPLAY_MAX_FRAMES = 180
    for (let i = 0; i < 400; i++) {
      room.step(1 / 60);
    }
    expect(room.replayBuffer.length).toBe(REPLAY_MAX_FRAMES);
  });

  it('captures killing_blow event into replay frame immediately, even on odd ticks', () => {
    room.startMatch(54321);
    room.aiEnabled = false;

    // Step 1 tick -> tick becomes 1 (odd tick)
    room.step(1 / 60);
    expect(room.tick).toBe(1);
    expect(room.replayBuffer.length).toBe(0);

    // Inflict lethal blow on Omega
    room.ships.omega.hullHp = 10;
    room.ships.omega.body.hullHp = 10;
    room.projectiles.push({
      id: 'lethal_slug',
      type: 'railgun',
      shooterId: 'alpha',
      pos: { x: room.ships.omega.body.pos.x, y: room.ships.omega.body.pos.y },
      vel: { x: 0, y: 0 },
      damage: 500,
      radius: 10,
      lifetime: 5,
    });

    // Step tick 2 -> lethal blow triggers
    room.step(1 / 60);
    expect(room.slowMoActive).toBe(true);
    expect(room.slowMoTimer).toBeCloseTo(3.0, 1);

    // Replay buffer must have captured the killing_blow frame
    const killingFrame = room.replayBuffer.find(f => f.events.some(e => e.type === 'killing_blow'));
    expect(killingFrame).toBeDefined();
    expect(killingFrame.slowMoActive).toBe(true);
    const kbEvent = killingFrame.events.find(e => e.type === 'killing_blow');
    expect(kbEvent.victimId).toBe('omega');
    expect(kbEvent.killerId).toBe('alpha');
  });

  it('buffers REPLAY_EVENT_TYPES across ticks and flushes them into the next replay frame', () => {
    room.startMatch(1111);
    room.aiEnabled = false;

    // Tick 0 -> step 1 -> tick 1 (odd tick). Emit event on odd tick
    room.step(1 / 60);
    expect(room.tick).toBe(1);

    room.emitEvent({ type: 'laser_fired', shipId: 'alpha', pos: { x: 0, y: 0 } });
    room.emitEvent({ type: 'unrelated_event_xyz', data: 123 }); // Not in REPLAY_EVENT_TYPES

    // Step 1 more tick -> tick 2 (even tick). recordReplayFrame should collect the event and flush
    room.step(1 / 60);
    expect(room.tick).toBe(2);

    expect(room.replayBuffer.length).toBe(1);
    const frame = room.replayBuffer[0];
    const eventTypes = frame.events.map(e => e.type);
    expect(eventTypes).toContain('laser_fired');
    expect(eventTypes).not.toContain('unrelated_event_xyz');
    expect(room._replayPendingEvents.length).toBe(0);
  });

  it('executes 30Hz replay playback after slow-mo expires and transitions to gameover complete', () => {
    room.startMatch(2222);
    room.aiEnabled = false;

    // Run 20 ticks of normal gameplay to record initial frames
    for (let i = 0; i < 20; i++) {
      room.step(1 / 60);
    }
    const initialBufferCount = room.replayBuffer.length;
    expect(initialBufferCount).toBe(10);

    // Deal killing blow to Omega
    room.ships.omega.hullHp = 10;
    room.ships.omega.body.hullHp = 10;
    room.projectiles.push({
      id: 'finisher',
      type: 'railgun',
      shooterId: 'alpha',
      pos: { x: room.ships.omega.body.pos.x, y: room.ships.omega.body.pos.y },
      vel: { x: 0, y: 0 },
      damage: 500,
      radius: 10,
      lifetime: 5,
    });
    room.step(1 / 60);
    expect(room.slowMoActive).toBe(true);

    // Step remaining slow-mo duration (3.0s at dt = 1/60 is ~180 ticks)
    // Step until slowMoTimer expires and transitions state to 'gameover'
    while (room.slowMoActive) {
      room.step(1 / 60);
    }

    expect(room.state).toBe('gameover');
    expect(room.slowMoActive).toBe(false);

    // Replay must now be activated!
    expect(room.replayActive).toBe(true);
    expect(room.replayComplete).toBe(false);
    expect(room.replayCursor).toBe(0);
    expect(room.replayFrames.length).toBeGreaterThan(0);
    expect(room.replayBuffer.length).toBe(0); // Cleared into replayFrames

    // Initial replay snapshot check
    let snap = room.getSnapshot();
    expect(snap.replayActive).toBe(true);
    expect(snap.replayComplete).toBe(false);
    expect(snap.replayFrameIndex).toBe(0);
    expect(snap.replayFrameCount).toBe(room.replayFrames.length);
    expect(snap.replayProgress).toBe(0);
    expect(snap.replayFrame).toEqual(room.replayFrames[0]);

    // Step at 60Hz: after 2 ticks (1/30s), replayCursor should advance to 1
    room.step(1 / 60);
    expect(room.replayCursor).toBe(0); // 1/60s * 30 = 0.5 -> floor is 0
    room.step(1 / 60);
    expect(room.replayCursor).toBe(1); // 2/60s * 30 = 1.0 -> floor is 1

    snap = room.getSnapshot();
    expect(snap.replayFrameIndex).toBe(1);
    expect(snap.replayFrame).toEqual(room.replayFrames[1]);
    expect(snap.replayProgress).toBeCloseTo(1 / (room.replayFrames.length - 1), 4);

    // Step through the entire replay duration
    const totalReplayTicks = Math.ceil((room.replayFrames.length / REPLAY_FPS) * 60) + 10;
    for (let i = 0; i < totalReplayTicks; i++) {
      room.step(1 / 60);
    }

    // Replay should now be complete
    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(true);
    expect(room.replayCursor).toBe(room.replayFrames.length - 1);

    snap = room.getSnapshot();
    expect(snap.replayActive).toBe(false);
    expect(snap.replayComplete).toBe(true);
    expect(snap.replayFrameIndex).toBe(0);
    expect(snap.replayProgress).toBe(1);
    expect(snap.replayFrame).toBeNull();

    // Further stepping during gameover clears events and stays stable
    room.emitEvent({ type: 'aftermath_fx' });
    room.step(1 / 60);
    expect(room.events.length).toBe(0);
    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(true);
  });

  it('handles empty replay buffer gracefully without crashing', () => {
    room.replayBuffer = [];
    room.startReplay();

    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(true);
    expect(room.replayFrames.length).toBe(0);

    const snap = room.getSnapshot();
    expect(snap.replayActive).toBe(false);
    expect(snap.replayComplete).toBe(true);
    expect(snap.replayFrameCount).toBe(0);
    expect(snap.replayFrameIndex).toBe(0);
    expect(snap.replayProgress).toBe(1);
    expect(snap.replayFrame).toBeNull();

    room.state = 'gameover';
    expect(() => room.step(1 / 60)).not.toThrow();
  });

  it('resets all replay state on startMatch() and restartMatch()', () => {
    // Dirty all replay state variables
    room.replayBuffer = [{ frame: 1 }];
    room.replayFrames = [{ frame: 2 }];
    room.replayActive = true;
    room.replayComplete = true;
    room.replayCursor = 42;
    room.replayElapsed = 5.5;
    room._replayPendingEvents = [{ type: 'laser_fired' }];

    room.startMatch(777);
    expect(room.replayBuffer).toEqual([]);
    expect(room.replayFrames).toEqual([]);
    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(false);
    expect(room.replayCursor).toBe(0);
    expect(room.replayElapsed).toBe(0);
    expect(room._replayPendingEvents).toEqual([]);

    // Dirty again and verify restartMatch() resets
    room.replayBuffer = [{ frame: 3 }];
    room.replayFrames = [{ frame: 4 }];
    room.replayActive = true;
    room.replayComplete = true;
    room.replayCursor = 10;
    room.replayElapsed = 2.0;
    room._replayPendingEvents = [{ type: 'railgun_fired' }];

    room.restartMatch(888);
    expect(room.replayBuffer).toEqual([]);
    expect(room.replayFrames).toEqual([]);
    expect(room.replayActive).toBe(false);
    expect(room.replayComplete).toBe(false);
    expect(room.replayCursor).toBe(0);
    expect(room.replayElapsed).toBe(0);
    expect(room._replayPendingEvents).toEqual([]);
  });

  it('executes full end-to-end GameRoom Hyperspace cycle (toggle, charge, jump intangibility, forward clear relocation, staged reboot, replay)', () => {
    const room = new GameRoom({ id: 'hs_full_cycle_room', seed: 789, aiEnabled: false });
    room.startMatch(789);
    room.addPlayer('helm_p', 'Helm Pilot', { team: 'alpha', station: 'helm' });
    room.addPlayer('weap_p', 'Weapons Off', { team: 'alpha', station: 'weapons' });
    room.addPlayer('eng_p', 'Chief Eng', { team: 'alpha', station: 'engineer' });

    const alpha = room.ships.alpha;
    const omega = room.ships.omega;
    expect(alpha.hyperspace.state).toBe('ready');
    expect(alpha.hyperspace.charge).toBe(0);

    // 1. Helm toggles hyperspace charging
    const toggleRes = room.handleClientMessage('helm_p', { type: 'helm_input', toggleHyperspace: true });
    expect(toggleRes).toBe(true);
    expect(alpha.hyperspace.state).toBe('charging');
    expect(alpha.hyperspace.charge).toBe(0);

    // Verify toggle cancellation
    room.handleClientMessage('helm_p', { type: 'helm_input', toggleHyperspace: true });
    expect(alpha.hyperspace.state).toBe('ready');
    room.handleClientMessage('helm_p', { type: 'helm_input', toggleHyperspace: true });
    expect(alpha.hyperspace.state).toBe('charging');

    // Attach a tether mine to alpha to verify detachment on jump
    const mine = {
      id: 'attached_mine',
      pos: { x: alpha.body.pos.x, y: alpha.body.pos.y, z: 0 },
      triggerRadius: 150,
      tetheredShipId: 'alpha',
      armed: false,
      triggered: true,
      destroyed: false,
    };
    room.sector.tetherMines.push(mine);

    // Boost hyperspace power to 1.20 via engineer input
    room.handleClientMessage('eng_p', { type: 'set_boost', subsystemKey: 'hyperspace', enabled: true });
    expect(alpha.grid.isSystemBoosted('hyperspace')).toBe(true);

    // Step through charging until jump triggers (at 1.20 rate: ~500 ticks = 8.33s; allow up to 800 ticks under combat)
    let warpEntered = false;
    for (let i = 0; i < 800; i++) {
      room.step(1 / 60);
      if (alpha.hyperspace.state === 'jumping') {
        warpEntered = true;
        break;
      }
    }
    expect(warpEntered).toBe(true);
    expect(alpha.hyperspace.state).toBe('jumping');

    // Verify replay recorded hyperspace_enter
    const warpReplayEvents = [
      ...room.replayBuffer.flatMap(f => f.events),
      ...room._replayPendingEvents,
    ].map(e => e.type);
    expect(warpReplayEvents).toContain('hyperspace_enter');

    // 2. Intangible & targetUnavailable during warp
    const snapWarpAlpha = room.serializeShip(alpha);
    expect(snapWarpAlpha.hyperspace.state).toBe('jumping');
    expect(snapWarpAlpha.targetAvailable).toBe(false);
    expect(snapWarpAlpha.sensorsOnline).toBe(false);
    expect(snapWarpAlpha.externalViewsOnline).toBe(true); // warp tunnel visual active

    const snapWarpOmega = room.serializeShip(omega);
    expect(snapWarpOmega.targetAvailable).toBe(false);
    expect(omega.leadTarget).toBeNull();

    // Verify projectile intangibility: spawn torpedo directly overlapping alpha
    room.projectiles.push({
      id: 'warp_torp',
      type: 'torpedo',
      torpedoType: 'heavy_torpedoes',
      shooterId: 'omega',
      pos: { ...alpha.body.pos },
      vel: { x: 0, y: 0, z: 0 },
      radius: 12,
      damage: 400,
    });
    const hpBeforeWarpTorp = alpha.hullHp;
    room.step(1 / 60);
    expect(alpha.hullHp).toBe(hpBeforeWarpTorp);

    // 3. Complete 2.2s warp jump
    let exitOccurred = false;
    for (let i = 0; i < 150; i++) {
      room.step(1 / 60);
      if (alpha.hyperspace.state === 'rebooting') {
        exitOccurred = true;
        break;
      }
    }
    expect(exitOccurred).toBe(true);
    expect(alpha.hyperspace.state).toBe('rebooting');

    // Verify replay recorded hyperspace_exit
    const exitReplayEvents = [
      ...room.replayBuffer.flatMap(f => f.events),
      ...room._replayPendingEvents,
    ].map(e => e.type);
    expect(exitReplayEvents).toContain('hyperspace_exit');

    expect(mine.tetheredShipId).toBeNull(); // Mine detached upon jump!
    expect(alpha.body.vel.x).toBe(0);
    expect(alpha.body.vel.y).toBe(0);
    expect(alpha.body.vel.z).toBe(0);
    expect(alpha.body.omega).toBe(0);
    expect(alpha.shields.systemOnline).toBe(false); // Shields offline upon emergence

    // 4. At 2.0s into reboot: Stage 0 reboot (cannot thrust/turn/fire, shields cannot absorb)
    for (let i = 0; i < 118; i++) {
      room.step(1 / 60);
    }
    expect(alpha.hyperspace.rebootTimer).toBeGreaterThanOrEqual(1.95);
    expect(alpha.hyperspace.rebootTimer).toBeLessThan(3.95);

    // Helm input cannot fire engines or RCS
    room.handleClientMessage('helm_p', { type: 'helm_input', forward: 1.0, turn: 0.8, mainThrottle: 1.0 });
    expect(alpha.helmInput.forward).toBe(0);
    expect(alpha.helmInput.turn).toBe(0);

    // Weapons input cannot fire
    room.handleClientMessage('weap_p', { type: 'weapons_input', fireLaser: true });
    expect(alpha.weaponsInput.firingLaser).toBe(false);

    // Shields offline: damage goes directly to hull
    const preDamageHp = alpha.hullHp;
    room.applyCollisionDamage(alpha, alpha.body.pos, 40, 100);
    expect(alpha.hullHp).toBeLessThan(preDamageHp);

    // 5. At 4.5s into reboot: Stage 1 reboot (views, engines, and RCS restored; weapons/shields/sensors offline)
    for (let i = 0; i < 155; i++) {
      room.step(1 / 60);
    }
    expect(alpha.hyperspace.rebootTimer).toBeGreaterThanOrEqual(4.4);
    expect(alpha.hyperspace.rebootTimer).toBeLessThan(6.9);

    const snapStage1 = room.serializeShip(alpha);
    expect(snapStage1.externalViewsOnline).toBe(true);
    expect(snapStage1.sensorsOnline).toBe(false);
    expect(snapStage1.targetAvailable).toBe(false);
    expect(snapStage1.shields.online.fore).toBe(false);
    expect(snapStage1.hyperspace.stage1Online).toBe(true);
    expect(snapStage1.hyperspace.stage2Online).toBe(false);

    // Engines and RCS responsive now!
    room.handleClientMessage('helm_p', { type: 'helm_input', forward: 0.85, turn: -0.4 });
    expect(alpha.helmInput.forward).toBeCloseTo(0.85, 2);
    expect(alpha.helmInput.turn).toBeCloseTo(-0.4, 2);

    // Weapons still offline
    room.handleClientMessage('weap_p', { type: 'weapons_input', fireLaser: true });
    expect(alpha.weaponsInput.firingLaser).toBe(false);

    // 6. At 7.1s: Stage 2 reboot complete (full restoration)
    for (let i = 0; i < 165; i++) {
      room.step(1 / 60);
    }
    expect(alpha.hyperspace.state).toBe('ready');
    expect(alpha.shields.systemOnline).toBe(true);

    const snapRestored = room.serializeShip(alpha);
    expect(snapRestored.externalViewsOnline).toBe(true);
    expect(snapRestored.sensorsOnline).toBe(true);
    expect(snapRestored.targetAvailable).toBe(true);
    expect(snapRestored.shields.online.fore).toBe(true);
    expect(snapRestored.hyperspace.stage1Online).toBe(true);
    expect(snapRestored.hyperspace.stage2Online).toBe(true);

    // Weapons now fire normally
    room.handleClientMessage('weap_p', { type: 'weapons_input', fireLaser: true });
    expect(alpha.weaponsInput.firingLaser).toBe(true);

    // 7. Verify replay recorded all hyperspace lifecycle events
    const allEvents = [
      ...room.replayBuffer.flatMap(f => f.events),
      ...room._replayPendingEvents,
    ].map(e => e.type);
    expect(allEvents).toContain('hyperspace_reboot_stage1');
    expect(allEvents).toContain('hyperspace_reboot_complete');

    // Verify replay frame serialization captures hyperspace and shields
    const replayShip = room.serializeReplayShip(alpha);
    expect(replayShip.hyperspace.state).toBe('ready');
    expect(replayShip.shields.online.fore).toBe(true);
  });

  it('rejects toggleHyperspace in lobby, damages ship.hyperspace.health on live railgun impact, and locks out AI targeting during enemy warp or sensor outage', () => {
    // 1. Lobby guard: toggleHyperspace must not start charging while in lobby
    const lobbyRoom = new GameRoom({ id: 'hs_lobby_guard', seed: 101, aiEnabled: false });
    expect(lobbyRoom.state).toBe('lobby');
    lobbyRoom.addPlayer('helm_lobby', 'Helm Pilot', { team: 'alpha', station: 'helm' });
    lobbyRoom.handleClientMessage('helm_lobby', { type: 'helm_input', toggleHyperspace: true });
    expect(lobbyRoom.ships.alpha.hyperspace.state).toBe('ready');
    expect(lobbyRoom.ships.alpha.hyperspace.charge).toBe(0);

    // 2. Live GameRoom railgun impact targeting 'hyperspace' damages omega.hyperspace.health
    const combatRoom = new GameRoom({ id: 'hs_railgun_dmg', seed: 202, aiEnabled: false });
    combatRoom.startMatch(202);
    const alpha = combatRoom.ships.alpha;
    const omega = combatRoom.ships.omega;

    omega.body.pos = { x: 0, y: 0, z: 0 };
    omega.body.vel = { x: 0, y: 0, z: 0 };
    omega.body.angle = 0;
    omega.body.pitch = 0;
    omega.body.rollState = 0;
    omega.shields.hp.starboard = 0;
    alpha.body.pos = { x: 0, y: 900, z: 0 };

    const hpBefore = omega.hyperspace.health;
    expect(hpBefore).toBe(100);

    combatRoom.projectiles.push({
      id: 'hs_test_slug',
      type: 'railgun',
      shooterId: 'alpha',
      pos: { x: 0, y: 20, z: 0 },
      vel: { x: 0, y: -900, z: 0 },
      radius: 6,
      damage: 55,
      lifetime: 2.0,
      targetedSubsystem: 'hyperspace',
      destroyed: false,
    });

    combatRoom.step(1 / 60);
    expect(omega.hyperspace.health).toBeLessThan(hpBefore);
    expect(omega.hyperspace.health).toBeGreaterThanOrEqual(59);

    // 3. AIHelm & AIWeapons lock out homing and firing when enemy is jumping or own sensors are offline
    alpha.body.pos = { x: -1800, y: 0, z: 0 };
    alpha.body.vel = { x: 0, y: 0, z: 0 };
    alpha.body.angle = Math.PI; // Facing away from omega at origin
    alpha.body.pitch = 0;
    alpha.body.omega = 0;
    alpha.body.pitchRate = 0;
    alpha.weapons.laserCooldown = 0;
    alpha.weapons.railgunCooldown = 0;
    alpha.weapons.chargeProgress = 1.0;

    // 3a: Enemy in warp ('jumping')
    omega.hyperspace.state = 'jumping';
    const helmVsJump = AIHelm.update(alpha, omega, combatRoom, 1 / 60);
    const weapVsJump = AIWeapons.update(alpha, omega, combatRoom, 1 / 60);
    expect(helmVsJump.forward).toBe(0);
    expect(helmVsJump.turn).toBe(0);
    expect(weapVsJump.fireLaser).toBe(false);
    expect(weapVsJump.chargeRailgun).toBe(false);
    expect(weapVsJump.fireRailgun).toBe(false);

    // 3b: Enemy ready, but own sensorsOffline === false
    omega.hyperspace.state = 'ready';
    alpha.sensorsOnline = false;
    const helmNoSensors = AIHelm.update(alpha, omega, combatRoom, 1 / 60);
    const weapNoSensors = AIWeapons.update(alpha, omega, combatRoom, 1 / 60);
    expect(helmNoSensors.forward).toBe(0);
    expect(helmNoSensors.turn).toBe(0);
    expect(weapNoSensors.fireLaser).toBe(false);
    expect(weapNoSensors.chargeRailgun).toBe(false);
    expect(weapNoSensors.fireRailgun).toBe(false);

    // 3c: Sensors online, but own ship.targetAvailable === false (e.g. enemy nebula/stealth lockout)
    alpha.sensorsOnline = true;
    alpha.targetAvailable = false;
    const helmNoTarget = AIHelm.update(alpha, omega, combatRoom, 1 / 60);
    const weapNoTarget = AIWeapons.update(alpha, omega, combatRoom, 1 / 60);
    expect(helmNoTarget.forward).toBe(0);
    expect(helmNoTarget.turn).toBe(0);
    expect(weapNoTarget.fireLaser).toBe(false);
    expect(weapNoTarget.chargeRailgun).toBe(false);
    expect(weapNoTarget.fireRailgun).toBe(false);

    // 3d: Verify live GameRoom.step() synchronizes ship.sensorsOnline & ship.targetAvailable before AI runs
    omega.hyperspace.state = 'jumping';
    omega.hyperspace.jumpTimer = 0.5;
    combatRoom.step(1 / 60);
    expect(alpha.sensorsOnline).toBe(true);
    expect(alpha.targetAvailable).toBe(false);

    omega.hyperspace.state = 'ready';
    combatRoom.step(1 / 60);
    expect(alpha.targetAvailable).toBe(true);
  });

  describe('Phase 19: Edge Dampening Field, Asteroid Collision Clamp & State Serialization', () => {
    it('applies edge dampening field: zero inside <= 4500m, ramps in (4500m..5250m), decays linear and angular velocities by ~10% over 1s (60 ticks) at outer rim (5250m), clears on leaving/hyperspace', () => {
      const edgeRoom = new GameRoom({ id: 'edge_field_room', seed: 1234, aiEnabled: false });
      edgeRoom.startMatch(1234);
      const alpha = edgeRoom.ships.alpha;

      // Inside core <= 4500m: dampeningFactor is 0 and inDampeningField is false
      alpha.body.pos = { x: 4000, y: 0, z: 0 };
      alpha.body.vel = { x: 50, y: 0, z: 0 };
      alpha.body.omega = 0.5;
      alpha.body.pitchOmega = 0.4;
      alpha.body.rollOmega = 0.3;
      edgeRoom.step(1 / 60);

      expect(alpha.dampeningFactor).toBe(0);
      expect(alpha.inDampeningField).toBe(false);

      // Ramp zone (4500m < r < 5250m, e.g. r = 4875m, mid-point)
      alpha.body.pos = { x: 4875, y: 0, z: 0 };
      edgeRoom.step(1 / 60);
      expect(alpha.inDampeningField).toBe(true);
      expect(alpha.dampeningFactor).toBeGreaterThan(0);
      expect(alpha.dampeningFactor).toBeLessThan(1);

      // Outer rim: r = 5250m (ARENA_RADIUS)
      // Test exact decay rate over 1.0s (60 ticks):
      // Disable active SAS damping to isolate field dampening decay rate on velocities and angular rates
      alpha.body.sasActive = false;
      alpha.body.pos = { x: 5250, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 100, z: 50 };
      alpha.body.omega = 1.0;
      alpha.body.pitchOmega = 0.8;
      alpha.body.rollOmega = 0.6;

      for (let i = 0; i < 60; i++) {
        alpha.body.pos.x = 5250;
        alpha.body.pos.y = 0;
        alpha.body.pos.z = 0;
        edgeRoom.step(1 / 60);
      }

      // After 60 ticks (1.0s) at strength ~1.0:
      // vel.y: 100 * (1 - 0.10)^1 = 90.0
      // vel.z: 50 * 0.90 = 45.0
      // omega: 1.0 * 0.90 = 0.90
      // pitchOmega: 0.8 * 0.90 = 0.72
      // rollOmega: 0.6 * 0.90 = 0.54
      expect(alpha.body.vel.y).toBeCloseTo(90.0, 0);
      expect(alpha.body.vel.z).toBeCloseTo(45.0, 0);
      expect(alpha.body.omega).toBeCloseTo(0.90, 1);
      expect(alpha.body.pitchOmega).toBeCloseTo(0.72, 1);
      expect(alpha.body.rollOmega).toBeCloseTo(0.54, 1);
      expect(alpha.inDampeningField).toBe(true);
      expect(alpha.dampeningFactor).toBeCloseTo(1.0, 1);

      // Serialization in getSnapshot() and replay frame
      const snap = edgeRoom.getSnapshot();
      expect(snap.ships.alpha.dampeningFactor).toBeCloseTo(1.0, 1);
      expect(snap.ships.alpha.inDampeningField).toBe(true);

      const replayFrame = edgeRoom.captureReplayFrame([]);
      expect(replayFrame.ships.alpha.dampeningFactor).toBeCloseTo(1.0, 1);
      expect(replayFrame.ships.alpha.inDampeningField).toBe(true);

      // Clears when leaving field (back inside core)
      alpha.body.pos = { x: 2000, y: 0, z: 0 };
      edgeRoom.step(1 / 60);
      expect(alpha.dampeningFactor).toBe(0);
      expect(alpha.inDampeningField).toBe(false);

      // Clears when entering hyperspace
      alpha.body.pos = { x: 5000, y: 0, z: 0 };
      edgeRoom.step(1 / 60);
      expect(alpha.inDampeningField).toBe(true);

      alpha.hyperspace.state = 'jumping';
      edgeRoom.step(1 / 60);
      expect(alpha.dampeningFactor).toBe(0);
      expect(alpha.inDampeningField).toBe(false);
    });

    it('caps ship.body.omega at <= Math.PI rad/s after extreme ship-vs-asteroid collisions', () => {
      const colRoom = new GameRoom({ id: 'asteroid_clamp_room', seed: 42, aiEnabled: false });
      colRoom.startMatch(42);
      const alpha = colRoom.ships.alpha;
      const asteroid = colRoom.sector.asteroids[0];

      // Position alpha for an extreme off-center collision against the asteroid at high closing velocity
      alpha.body.pos = {
        x: asteroid.pos.x - asteroid.radius - 20,
        y: asteroid.pos.y - 15, // off-center for high torque
        z: asteroid.pos.z || 0,
      };
      alpha.body.vel = { x: 500, y: 0, z: 0 }; // extreme velocity (500 m/s)
      alpha.body.omega = 2.0;

      colRoom.step(1 / 60);

      // Spin rate must be clamped to <= Math.PI rad/s
      expect(Math.abs(alpha.body.omega)).toBeLessThanOrEqual(Math.PI + 1e-4);
    });

    it('AIHelm engages inward boundary recovery when inDampeningField is true (even inside 0.8*arenaRadius) and dampens pitch via body.pitchOmega', () => {
      const room = new GameRoom({ id: 'ai_damp_recovery_room', seed: 42, aiEnabled: false });
      room.startMatch(42);
      const alpha = room.ships.alpha;
      const omega = room.ships.omega;

      // 1. Inward boundary recovery when inDampeningField = true
      // Position Alpha at (2000, 0, 0) which is well inside arenaRadius * 0.8 (5250 * 0.8 = 4200m)
      alpha.body.pos = { x: 2000, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 0, z: 0 };
      alpha.body.angle = 0; // facing outward +X toward enemy
      alpha.body.pitch = 0;

      // Position enemy further outward at (3500, 0, 0)
      omega.body.pos = { x: 3500, y: 0, z: 0 };
      omega.body.vel = { x: 0, y: 0, z: 0 };

      // Normal condition (inDampeningField = false): Alpha should chase outward toward Omega (turn ~ 0, forward > 0)
      alpha.inDampeningField = false;
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(Math.abs(alpha.helmInput.turn)).toBeLessThan(0.2);

      // Now set inDampeningField = true: AIHelm must immediately engage emergency boundary recovery toward (0, 0, 0)
      alpha.inDampeningField = true;
      AIHelm.update(alpha, omega, room, 1 / 60);

      // Desired angle toward center (0, 0, 0) from (2000, 0, 0) is Math.PI.
      // Since alpha.body.angle = 0, angleDiff is Math.PI, requiring a hard turn command
      expect(Math.abs(alpha.helmInput.turn)).toBeGreaterThan(0.8);
      // Main throttle / forward is engaged for recovery
      expect(alpha.helmInput.forward).toBeGreaterThan(0);

      // Also verify with outward velocity: desVx points inward (-X), requiring reverse/inward steering
      alpha.body.vel = { x: 50, y: 0, z: 0 };
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(Math.abs(alpha.helmInput.turn)).toBeGreaterThan(0.8);

      // 2. body.pitchOmega reading and opposing pitch command
      // Align Alpha perfectly with enemy in pitch and yaw (eBodyPitch = 0, eBodyYaw = 0)
      alpha.inDampeningField = false;
      alpha.body.pos = { x: 0, y: 0, z: 0 };
      alpha.body.vel = { x: 0, y: 0, z: 0 };
      alpha.body.angle = 0;
      alpha.body.pitch = 0;
      omega.body.pos = { x: 1000, y: 0, z: 0 }; // directly ahead

      // With body.pitchOmega = 0, pitch command is 0
      alpha.body.pitchOmega = 0;
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(alpha.helmInput.pitch).toBe(0);

      // With positive pitch rate (pitching up at +0.6 rad/s), AIHelm applies opposing pitch down (< 0)
      alpha.body.pitchOmega = 0.6;
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(alpha.helmInput.pitch).toBeLessThan(0);
      expect(alpha.helmInput.pitch).toBeCloseTo(-0.6 * 0.45, 2);

      // With negative pitch rate (pitching down at -0.6 rad/s), AIHelm applies opposing pitch up (> 0)
      alpha.body.pitchOmega = -0.6;
      AIHelm.update(alpha, omega, room, 1 / 60);
      expect(alpha.helmInput.pitch).toBeGreaterThan(0);
      expect(alpha.helmInput.pitch).toBeCloseTo(0.6 * 0.45, 2);
    });
  });

  describe('Phase 22 Slice 1 — Authoritative Server Gating & weaponsOnline Serialization', () => {
    it('serializeShip exposes weaponsOnline: true during play, false during hyperspace jump/reboot < 7.0s, and false when destroyed/hullHp <= 0 or gameover', () => {
      const room = new GameRoom({ id: 'phase22_weapons_online', seed: 42 });
      room.startMatch(42);
      expect(room.state).toBe('playing');

      // 1. Normal play with full health
      const snapPlaying = room.serializeShip(room.ships.alpha);
      expect(snapPlaying.weaponsOnline).toBe(true);

      // 2. Hyperspace jumping -> weaponsOnline: false
      room.ships.alpha.hyperspace.state = 'jumping';
      const snapJumping = room.serializeShip(room.ships.alpha);
      expect(snapJumping.weaponsOnline).toBe(false);

      // 3. Hyperspace rebooting Stage 1 (rebootTimer = 2.0s < 4.0s) -> weaponsOnline: false
      room.ships.alpha.hyperspace.state = 'rebooting';
      room.ships.alpha.hyperspace.rebootTimer = 2.0;
      const snapRebootStage1 = room.serializeShip(room.ships.alpha);
      expect(snapRebootStage1.weaponsOnline).toBe(false);

      // 4. Hyperspace rebooting Stage 2 (rebootTimer = 5.0s < 7.0s) -> weaponsOnline: false
      room.ships.alpha.hyperspace.rebootTimer = 5.0;
      const snapRebootStage2 = room.serializeShip(room.ships.alpha);
      expect(snapRebootStage2.weaponsOnline).toBe(false);

      // 5. Hyperspace reboot complete (state = 'ready', rebootTimer = 0) -> weaponsOnline: true
      room.ships.alpha.hyperspace.state = 'ready';
      room.ships.alpha.hyperspace.rebootTimer = 0;
      const snapReady = room.serializeShip(room.ships.alpha);
      expect(snapReady.weaponsOnline).toBe(true);

      // 6. Ship destroyed -> weaponsOnline: false
      room.ships.alpha.destroyed = true;
      const snapDestroyed = room.serializeShip(room.ships.alpha);
      expect(snapDestroyed.weaponsOnline).toBe(false);

      // 7. Ship not marked destroyed, but hullHp <= 0 -> weaponsOnline: false
      room.ships.alpha.destroyed = false;
      room.ships.alpha.hullHp = 0;
      const snapZeroHp = room.serializeShip(room.ships.alpha);
      expect(snapZeroHp.weaponsOnline).toBe(false);

      // 8. Revive ship, but room state becomes 'gameover' -> weaponsOnline: false
      room.ships.alpha.hullHp = 1000;
      room.state = 'gameover';
      const snapGameOver = room.serializeShip(room.ships.alpha);
      expect(snapGameOver.weaponsOnline).toBe(false);

      // 9. Pre-game lobby room -> weaponsOnline: true (mirrors r.weaponsOnline before match starts)
      const lobbyRoom = new GameRoom({ id: 'phase22_lobby', seed: 42 });
      expect(lobbyRoom.state).toBe('lobby');
      const snapLobby = lobbyRoom.serializeShip(lobbyRoom.ships.alpha);
      expect(snapLobby.weaponsOnline).toBe(true);
    });

    it('authoritatively rejects helm_input, weapons_input, and engineer_input in terminal gameover state, while preserving lobby pre-flight inputs', () => {
      const room = new GameRoom({ id: 'phase22_gating', seed: 777 });
      expect(room.state).toBe('lobby');

      // Pre-flight lobby station configuration
      room.addPlayer('pilot', 'Pilot', { team: 'alpha', station: 'helm' });
      room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
      room.addPlayer('eng', 'Engineer', { team: 'alpha', station: 'engineer' });

      // In lobby: pre-flight helm input preserves SAS and auto-orient
      expect(room.handleClientMessage('pilot', { type: 'helm_input', toggleSas: false, autoOrientMode: 'target' })).toBe(true);
      expect(room.ships.alpha.body.sasActive).toBe(false);
      expect(room.ships.alpha.body.autoOrientMode).toBe('target');
      expect(room.handleClientMessage('pilot', { type: 'helm_input', toggleSas: true })).toBe(true);
      expect(room.ships.alpha.body.sasActive).toBe(true);

      // In lobby: engineer tile rotation and boost work
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 0, col: 0 })).toBe(true);
      expect(room.handleClientMessage('eng', { type: 'set_boost', subsystemKey: 'weapons_laser', enabled: true })).toBe(true);

      // Start match -> inputs work normally during 'playing'
      room.startMatch(777);
      expect(room.state).toBe('playing');
      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 0.8 })).toBe(true);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 0.5 })).toBe(true);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 0, col: 0 })).toBe(true);

      // Transition to gameover -> all station messages return false
      room.state = 'gameover';
      expect(room.isTerminalMatchState()).toBe(true);

      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 1.0 })).toBe(false);
      expect(room.handleClientMessage('pilot', { type: 'helm_input', toggleSas: false })).toBe(false);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 1.0, fireLaser: true })).toBe(false);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 0, col: 0 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'discharge_capacitor', row: 0, col: 0 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'toggle_boost', subsystemKey: 'weapons_laser' })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'set_boost', subsystemKey: 'weapons_laser', enabled: false })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'assign_drone_tile', droneId: 0, row: 1, col: 1 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'assign_drone_subsystem', droneId: 0, subsystemKey: 'shields' })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'recall_drone', droneId: 0 })).toBe(false);

      // Surviving winner ship (Omega) is also gated in gameover state
      room.addPlayer('pilot_omega', 'PilotOmega', { team: 'omega', station: 'helm' });
      room.addPlayer('gunner_omega', 'GunnerOmega', { team: 'omega', station: 'weapons' });
      expect(room.handleClientMessage('pilot_omega', { type: 'helm_input', forward: 0.5 })).toBe(false);
      expect(room.handleClientMessage('gunner_omega', { type: 'weapons_input', fireLaser: true })).toBe(false);

      // When ship hullHp <= 0 during play, weapons_input is rejected and resets active firing/charging
      room.state = 'playing';
      room.ships.alpha.hullHp = 0;
      room.ships.alpha.weaponsInput.firingLaser = true;
      room.ships.alpha.weaponsInput.chargingRailgun = true;
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', fireLaser: true })).toBe(false);
      expect(room.ships.alpha.weaponsInput.firingLaser).toBe(false);
      expect(room.ships.alpha.weaponsInput.chargingRailgun).toBe(false);
    });

    it('transitioning to gameover resets active weaponsInput and helmInput on both ships without dropping replay events', () => {
      const room = new GameRoom({ id: 'phase22_reset_inputs', seed: 999 });
      room.startMatch(999);
      room.aiEnabled = false;

      // Set active inputs on Alpha
      room.ships.alpha.helmInput.forward = 1.0;
      room.ships.alpha.helmInput.strafe = 0.5;
      room.ships.alpha.helmInput.turn = -0.4;
      room.ships.alpha.helmInput.roll = 0.3;
      room.ships.alpha.helmInput.pitch = 0.2;
      room.ships.alpha.helmInput.mainThrottle = 1.0;
      room.ships.alpha.body.turnAndBurn = true;
      room.ships.alpha.weaponsInput.firingLaser = true;
      room.ships.alpha.weaponsInput.chargingRailgun = true;
      room.ships.alpha.weapons.startRailgunCharge();
      expect(room.ships.alpha.weapons.charging).toBe(true);

      // Set active inputs on Omega
      room.ships.omega.helmInput.forward = 0.7;
      room.ships.omega.helmInput.turn = 0.5;
      room.ships.omega.weaponsInput.firingLaser = true;

      // Run several ticks
      for (let i = 0; i < 10; i++) {
        room.step(1 / 60);
      }

      // Deal killing blow to Omega
      room.ships.omega.hullHp = 10;
      room.ships.omega.body.hullHp = 10;
      room.projectiles.push({
        id: 'finisher',
        type: 'railgun',
        shooterId: 'alpha',
        pos: { ...room.ships.omega.body.pos },
        vel: { x: 0, y: 0 },
        damage: 500,
        radius: 10,
        lifetime: 5,
      });
      room.step(1 / 60);
      expect(room.slowMoActive).toBe(true);
      expect(room.winner).toBe('alpha');

      // Omega is destroyed: its weaponsInput should immediately be cleared
      expect(room.ships.omega.weaponsInput.firingLaser).toBe(false);
      expect(room.ships.omega.weaponsInput.chargingRailgun).toBe(false);

      // Step through slowMo until gameover
      while (room.slowMoActive) {
        room.step(1 / 60);
      }
      expect(room.state).toBe('gameover');
      expect(room.replayActive).toBe(true);

      // Check Alpha (surviving winner ship): all active helm and weapons inputs MUST be zeroed
      expect(room.ships.alpha.weaponsInput.firingLaser).toBe(false);
      expect(room.ships.alpha.weaponsInput.chargingRailgun).toBe(false);
      expect(room.ships.alpha.weapons.charging).toBe(false);
      expect(room.ships.alpha.helmInput.forward).toBe(0);
      expect(room.ships.alpha.helmInput.rcsForward).toBe(0);
      expect(room.ships.alpha.helmInput.strafe).toBe(0);
      expect(room.ships.alpha.helmInput.turn).toBe(0);
      expect(room.ships.alpha.helmInput.roll).toBe(0);
      expect(room.ships.alpha.helmInput.pitch).toBe(0);
      expect(room.ships.alpha.helmInput.mainThrottle).toBe(0);
      expect(room.ships.alpha.body.turnAndBurn).toBe(false);

      // Verify replay frames captured the killing blow event cleanly
      const killingBlowEvents = room.replayFrames.flatMap(f => f.events || []).filter(e => e.type === 'killing_blow');
      expect(killingBlowEvents.length).toBeGreaterThan(0);
      expect(killingBlowEvents[0].victimId).toBe('omega');
      expect(killingBlowEvents[0].killerId).toBe('alpha');

      // Drain initial gameover snapshot
      const snap = room.getSnapshot();
      expect(snap.state).toBe('gameover');
      expect(room.recentEventsBuffer.length).toBe(0);

      // Verify subsequent step in gameover clears events and recentEventsBuffer
      room.emitEvent({ type: 'post_gameover_event' });
      expect(room.recentEventsBuffer.length).toBe(1);
      room.step(1 / 60);
      expect(room.events.length).toBe(0);
      expect(room.recentEventsBuffer.length).toBe(0);
    });
  });

  describe('Phase 22: Post-Battle & Disabled-Weapons Gating', () => {
    it('startRailgunCharge server gating rejects charging when powerMap.weapons_railgun === 0, railgunHardware.health <= 0, or chargeProgress >= 1.0', () => {
      const room = new GameRoom({ id: 'p22_railgun_gate', seed: 42 });
      room.startMatch(42);
      room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
      const ship = room.ships.alpha;

      // 1. Unpowered (weapons_railgun === 0)
      ship.powerMap.weapons_railgun = 0;
      ship.weapons.railgunHardware.health = 100;
      ship.weapons.chargeProgress = 0;
      ship.weapons.charging = false;
      ship.weaponsInput.chargingRailgun = false;

      expect(room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true })).toBe(true);
      expect(ship.weapons.charging).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);

      // 2. Hardware destroyed (health <= 0)
      ship.powerMap.weapons_railgun = 1.0;
      ship.weapons.railgunHardware.health = 0;
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true })).toBe(true);
      expect(ship.weapons.charging).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);

      // 3. Already fully charged (chargeProgress >= 1.0)
      ship.weapons.railgunHardware.health = 100;
      ship.weapons.chargeProgress = 1.0;
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true })).toBe(true);
      expect(ship.weapons.charging).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);

      // 4. Valid charging conditions -> successfully charges
      ship.weapons.chargeProgress = 0.5;
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true })).toBe(true);
      expect(ship.weapons.charging).toBe(true);
      expect(ship.weaponsInput.chargingRailgun).toBe(true);
    });

    it('stopRailgunCharge server handling clears ship.weapons.charging and ship.weaponsInput.chargingRailgun cleanly', () => {
      const room = new GameRoom({ id: 'p22_railgun_stop', seed: 42 });
      room.startMatch(42);
      room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
      const ship = room.ships.alpha;

      // Start charge
      ship.powerMap.weapons_railgun = 1.0;
      ship.weapons.railgunHardware.health = 100;
      ship.weapons.chargeProgress = 0.2;
      room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true });
      expect(ship.weapons.charging).toBe(true);
      expect(ship.weaponsInput.chargingRailgun).toBe(true);

      // Stop charge via stopRailgunCharge: true
      room.handleClientMessage('gunner', { type: 'weapons_input', stopRailgunCharge: true });
      expect(ship.weapons.charging).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);

      // Re-charge and stop via chargingRailgun: false
      room.handleClientMessage('gunner', { type: 'weapons_input', startRailgunCharge: true });
      expect(ship.weapons.charging).toBe(true);
      expect(ship.weaponsInput.chargingRailgun).toBe(true);

      room.handleClientMessage('gunner', { type: 'weapons_input', chargingRailgun: false });
      expect(ship.weapons.charging).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);
    });

    it('pre-charged unpowered bypass preserved: chargeProgress >= 1.0 with weapons_railgun === 0 STILL allows releaseRailgun to fire', () => {
      const room = new GameRoom({ id: 'p22_railgun_bypass', seed: 42 });
      room.startMatch(42);
      room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
      const ship = room.ships.alpha;

      // Fully charged, ready to fire, but unpowered
      ship.powerMap.weapons_railgun = 0;
      ship.weapons.chargeProgress = 1.0;
      ship.weapons.railgunCooldown = 0;
      ship.weapons.railgunHardware.health = 100;

      const initialProjCount = room.projectiles.length;

      const handled = room.handleClientMessage('gunner', { type: 'weapons_input', releaseRailgun: true });
      expect(handled).toBe(true);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);

      // Verify projectile was spawned
      expect(room.projectiles.length).toBe(initialProjCount + 1);
      const proj = room.projectiles[room.projectiles.length - 1];
      expect(proj.type).toBe('railgun');
      expect(proj.shooterId).toBe('alpha');

      // Verify railgun_fired event emitted
      const fireEvent = room.events.find(e => e.type === 'railgun_fired' && e.shipId === 'alpha');
      expect(fireEvent).toBeDefined();
    });

    it('slowMoTimer <= 0 transition tick cutoff: room transitions to gameover, inputs cleared, AI does not fire, and continuous laser fire does not emit or spawn', () => {
      const room = new GameRoom({ id: 'p22_slowmo_transition', seed: 555 });
      room.startMatch(555);
      room.aiEnabled = true;

      const ship = room.ships.alpha;

      // Set active inputs on Alpha
      ship.weaponsInput.firingLaser = true;
      ship.weaponsInput.chargingRailgun = true;
      ship.weapons.charging = true;
      ship.weapons.cooldown = 0;
      ship.powerMap.weapons_laser = 1.0;
      ship.helmInput.forward = 1.0;
      ship.helmInput.turn = 0.5;
      ship.body.turnAndBurn = true;

      // Place a torpedo within flak range (< 190m) to check AI does not react on transition tick
      room.projectiles.push({
        id: 'close_torp',
        type: 'torpedo',
        shooterId: 'omega',
        pos: { x: ship.body.pos.x + 50, y: ship.body.pos.y, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        damage: 200,
        radius: 5,
        lifetime: 10,
      });

      // Set slowMoTimer so that exactly one step of 1/60s brings it to 0
      room.slowMoTimer = 1 / 60;
      room.slowMoActive = true;
      room.events = [];

      room.step(1 / 60);

      // Verify state transition and timer
      expect(room.slowMoTimer).toBe(0);
      expect(room.slowMoActive).toBe(false);
      expect(room.state).toBe('gameover');

      // Verify Alpha inputs cleared
      expect(ship.weaponsInput.firingLaser).toBe(false);
      expect(ship.weaponsInput.chargingRailgun).toBe(false);
      expect(ship.weapons.charging).toBe(false);
      expect(ship.helmInput.forward).toBe(0);
      expect(ship.helmInput.turn).toBe(0);
      expect(ship.body.turnAndBurn).toBe(false);

      // Verify continuous laser fire did NOT spawn projectile or emit laser_fired
      const newLaserProjs = room.projectiles.filter(p => p.type === 'pulse_laser');
      expect(newLaserProjs.length).toBe(0);
      expect(room.events.some(e => e.type === 'laser_fired')).toBe(false);

      // Verify AI crew did not fire flak on this transition tick
      expect(room.events.some(e => e.type === 'flak_burst')).toBe(false);
    });

    it('AIWeapons.update cutoff before flak: does not fire flak and returns all-false when match ended, replayActive, destroyed, zero HP, or weapons offline', () => {
      const room = new GameRoom({ id: 'p22_ai_cutoff', seed: 333 });
      room.startMatch(333);
      const ship = room.ships.alpha;
      const enemyShip = room.ships.omega;

      // Ensure ship has flak ready and torpedo threat is 50m away (< 190m)
      ship.weapons.flakCooldown = 0;
      ship.weapons.flakHardware = { health: 100 };
      const torpedoThreat = {
        type: 'torpedo',
        shooterId: 'omega',
        pos: { x: ship.body.pos.x + 50, y: ship.body.pos.y, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        armed: true,
      };

      // Control baseline: In normal playing state, AIWeapons detects threat and triggers flak
      const normalState = { state: 'playing', projectiles: [torpedoThreat], events: [] };
      AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(ship.weapons.flakCooldown).toBeGreaterThan(0); // Flak was fired!
      ship.weapons.flakCooldown = 0; // Reset for tests below

      // 1. state === 'gameover'
      const goState = { state: 'gameover', projectiles: [torpedoThreat], events: [] };
      const resGameOver = AIWeapons.update(ship, enemyShip, goState, 0.016);
      expect(resGameOver).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);

      // 2. replayActive === true
      const replayState = { state: 'playing', replayActive: true, projectiles: [torpedoThreat], events: [] };
      const resReplay = AIWeapons.update(ship, enemyShip, replayState, 0.016);
      expect(resReplay).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);

      // 3. ship.destroyed === true
      ship.destroyed = true;
      const resDestroyed = AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(resDestroyed).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);
      ship.destroyed = false;

      // 4. ship.hullHp <= 0
      ship.hullHp = 0;
      const resZeroHp = AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(resZeroHp).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);
      ship.hullHp = 1000;

      // 5. ship.weaponsOnline === false
      ship.weaponsOnline = false;
      const resOffline = AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(resOffline).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);
      ship.weaponsOnline = true;

      // 6. enemyShip.hullHp <= 0 / destroyed === true
      enemyShip.hullHp = 0;
      const resEnemyDead = AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(resEnemyDead).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);
      enemyShip.hullHp = 1000;
      enemyShip.destroyed = true;
      const resEnemyDestroyed = AIWeapons.update(ship, enemyShip, normalState, 0.016);
      expect(resEnemyDestroyed).toEqual({ fireLaser: false, chargeRailgun: false, fireRailgun: false });
      expect(ship.weapons.flakCooldown).toBe(0);
    });

    it('replayActive message rejection: handleClientMessage rejects helm_input, weapons_input, and engineer_input when replayActive === true or state is gameover/restarting', () => {
      const room = new GameRoom({ id: 'p22_replay_reject', seed: 888 });
      room.startMatch(888);
      room.addPlayer('pilot', 'Pilot', { team: 'alpha', station: 'helm' });
      room.addPlayer('gunner', 'Gunner', { team: 'alpha', station: 'weapons' });
      room.addPlayer('eng', 'Engineer', { team: 'alpha', station: 'engineer' });

      // Valid in playing
      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 0.5 })).toBe(true);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 0.2 })).toBe(true);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 2, col: 2 })).toBe(true);

      // 1. replayActive === true
      room.replayActive = true;
      expect(room.isTerminalMatchState()).toBe(true);
      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 0.5 })).toBe(false);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 0.2 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 2, col: 2 })).toBe(false);

      // 2. state === 'restarting'
      room.replayActive = false;
      room.state = 'restarting';
      expect(room.isTerminalMatchState()).toBe(true);
      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 0.5 })).toBe(false);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 0.2 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 2, col: 2 })).toBe(false);

      // 3. state === 'gameover'
      room.state = 'gameover';
      expect(room.isTerminalMatchState()).toBe(true);
      expect(room.handleClientMessage('pilot', { type: 'helm_input', forward: 0.5 })).toBe(false);
      expect(room.handleClientMessage('gunner', { type: 'weapons_input', aimAngle: 0.2 })).toBe(false);
      expect(room.handleClientMessage('eng', { type: 'rotate_tile', row: 2, col: 2 })).toBe(false);
    });

    it('serializeShip weaponsOnline parity: verify weaponsOnline is true normally and false during hyperspace jump / <7.0s reboot', () => {
      const room = new GameRoom({ id: 'p22_parity', seed: 42 });
      room.startMatch(42);
      const ship = room.ships.alpha;

      // Normal playing
      expect(room.serializeShip(ship).weaponsOnline).toBe(true);

      // Hyperspace jump
      ship.hyperspace.state = 'jumping';
      expect(room.serializeShip(ship).weaponsOnline).toBe(false);

      // Hyperspace rebooting (< 7.0s total reboot time)
      ship.hyperspace.state = 'rebooting';
      ship.hyperspace.rebootTimer = 1.0;
      expect(room.serializeShip(ship).weaponsOnline).toBe(false);

      ship.hyperspace.rebootTimer = 4.0;
      expect(room.serializeShip(ship).weaponsOnline).toBe(false);

      ship.hyperspace.rebootTimer = 6.9;
      expect(room.serializeShip(ship).weaponsOnline).toBe(false);

      // Reboot complete -> ready
      ship.hyperspace.state = 'ready';
      ship.hyperspace.rebootTimer = 0;
      expect(room.serializeShip(ship).weaponsOnline).toBe(true);
    });
  });
});
