/**
 * BROADSIDE HYPERION — Frontend Client Assets & Controllers Integration Test
 *
 * Verifies syntax, exports, input dispatching, telemetry processing,
 * procedural Web Audio synthesis, and Express static asset serving for:
 * - controls-helm.js
 * - controls-weapons.js
 * - controls-engineer.js
 * - main.js
 * - renderer.js (when present)
 * - spectator.js (when present)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

import { HelmController } from '../../public/js/controls-helm.js';
import { WeaponsController, calculateLeadTarget, buildEnemyDamageReport, drawEnemyDiagram } from '../../public/js/controls-weapons.js';
import { EngineerController, computeDualCarrierOffset, computeDualCarrierSegments, normalizeSeg, getPerimeterBoxRect, EXTERNAL_SYSTEMS, SUBSYSTEM_LABELS } from '../../public/js/controls-engineer.js';
import { SoundSynth, BroadsideClient } from '../../public/js/main.js';
import { createAppServer } from '../../src/server/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');

/**
 * Helper to perform HTTP GET requests against server.
 */
function fetchGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${requestPath}`, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    }).on('error', reject);
  });
}

describe('Frontend Client Modules & Controllers', () => {
  describe('controls-helm.js (HelmController)', () => {
    it('instantiates and dispatches keyboard and pilot input', () => {
      const messages = [];
      const helm = new HelmController({
        send: (msg) => messages.push(msg),
      });

      expect(helm).toBeInstanceOf(HelmController);

      // RCS forward translation
      helm.keys.KeyW = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();

      expect(messages.length).toBeGreaterThan(0);
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg.type).toBe('helm_input');
      expect(lastMsg.rcsForward).toBe(1.0);
      expect(lastMsg.forward).toBe(0);
      expect(lastMsg.strafe).toBe(0);
      expect(lastMsg.turn).toBe(0);

      // Port strafe
      helm.keys.KeyW = false;
      helm.keys.KeyQ = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].strafe).toBe(-1.0);

      // Starboard strafe
      helm.keys.KeyQ = false;
      helm.keys.KeyE = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].strafe).toBe(1.0);

      // Rotational Turn: KeyA / ArrowLeft turns port / CCW (-1.0), KeyD / ArrowRight turns starboard / CW (+1.0)
      helm.keys.KeyE = false;
      helm.keys.KeyA = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].turn).toBe(-1.0);

      helm.keys.KeyA = false;
      helm.keys.KeyD = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].turn).toBe(1.0);

      // Roll Port (Ventral RCS) via KeyR and BracketLeft
      helm.keys.KeyD = false;
      helm.keys.KeyR = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].roll).toBe(-1.0);

      helm.keys.KeyR = false;
      helm.keys.BracketLeft = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].roll).toBe(-1.0);

      // Roll Starboard (Dorsal RCS) via KeyT and BracketRight
      helm.keys.BracketLeft = false;
      helm.keys.KeyT = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].roll).toBe(1.0);

      helm.keys.KeyT = false;
      helm.keys.BracketRight = true;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].roll).toBe(1.0);

      // Roll released -> 0
      helm.keys.BracketRight = false;
      helm.updateStateFromKeyboard();
      helm.emitHelmInput();
      expect(messages[messages.length - 1].roll).toBe(0);

      // SAS toggle
      helm.toggleSas();
      expect(messages[messages.length - 1].toggleSas).toBe(true);

      // Roll Damper (stopRoll)
      helm.stopRoll();
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'helm_input',
        stopRoll: true,
        roll: 0,
      }));

      // Flight Computer Auto-Orientation
      helm.setAutoOrient('prograde');
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'helm_input',
        toggleAutoOrient: 'prograde',
      }));

      helm.setAutoOrient('retrograde');
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'helm_input',
        toggleAutoOrient: 'retrograde',
      }));

      helm.setAutoOrient('target');
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'helm_input',
        toggleAutoOrient: 'target',
      }));

      helm.setAutoOrient('anti_target');
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'helm_input',
        toggleAutoOrient: 'anti_target',
      }));

      // Mock DOM elements to verify updateHUD telemetry and button states
      const mockElements = new Map();
      const createMockEl = (id) => {
        const classes = new Set();
        const el = {
          id,
          textContent: '',
          classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
          },
          disabled: false,
          dataset: {},
          querySelector: vi.fn(() => null),
        };
        mockElements.set(id, el);
        return el;
      };

      const elementIds = [
        'helm-speed', 'helm-heading', 'helm-omega', 'helm-throttle',
        'helm-roll-telemetry', 'btn-toggle-sas', 'btn-stop-roll',
        'btn-roll-port', 'btn-roll-starboard', 'btn-orient-prograde',
        'btn-orient-retrograde', 'btn-orient-target', 'btn-orient-anti-target',
        'rcs-bowPort', 'rcs-bowStarboard', 'rcs-sternPort',
        'rcs-sternStarboard', 'rcs-dorsalRoll', 'rcs-ventralRoll'
      ];
      elementIds.forEach(createMockEl);

      const origDoc = globalThis.document;
      globalThis.document = {
        getElementById: (id) => mockElements.get(id) || null,
      };

      try {
        // Standard normal roll update
        helm.updateHUD({
          vel: { x: 50, y: 50 },
          angle: 1.57,
          omega: 0.1,
          rollAngle: 0,
          rollOmega: 0,
          mainDrive: { throttle: 0.8 },
          thrusters: {
            bowPort: { health: 100, powered: true, throttle: 0, isFiring: false },
            ventralRoll: { health: 100, powered: true, throttle: 1, isFiring: true },
            dorsalRoll: { health: 100, powered: true, throttle: 0, isFiring: false },
          },
          sasActive: true,
          stopRollActive: false,
          autoOrientMode: 'prograde',
        });

        const rollTelemetry = mockElements.get('helm-roll-telemetry');
        expect(rollTelemetry.textContent).toContain('0.0° (0.00 rad/s)');
        expect(rollTelemetry.textContent).not.toContain('[INVERTED]');
        expect(mockElements.get('btn-roll-port').classList.contains('active')).toBe(true);
        expect(mockElements.get('btn-roll-starboard').classList.contains('active')).toBe(false);
        expect(mockElements.get('btn-orient-prograde').classList.contains('active')).toBe(true);
        expect(mockElements.get('btn-orient-prograde').classList.contains('disabled')).toBe(false);

        // Inverted roll with roll damper active and low speed (disables prograde)
        helm.updateHUD({
          vel: { x: 0.1, y: 0.1 },
          angle: 0,
          omega: 0,
          rollAngle: Math.PI,
          rollOmega: 0.45,
          mainDrive: { throttle: 0 },
          thrusters: {
            ventralRoll: { health: 100, powered: true, throttle: 0, isFiring: false },
            dorsalRoll: { health: 100, powered: true, throttle: 1, isFiring: true },
          },
          sasActive: false,
          stopRollActive: true,
          autoOrientMode: 'target',
        });

        expect(rollTelemetry.textContent).toContain('180.0° (0.45 rad/s)');
        expect(rollTelemetry.textContent).toContain('[INVERTED]');
        expect(mockElements.get('btn-stop-roll').classList.contains('active')).toBe(true);
        expect(mockElements.get('btn-roll-port').classList.contains('active')).toBe(false);
        expect(mockElements.get('btn-roll-starboard').classList.contains('active')).toBe(true);
        expect(mockElements.get('btn-orient-target').classList.contains('active')).toBe(true);
        expect(mockElements.get('btn-orient-prograde').classList.contains('disabled')).toBe(true);
      } finally {
        globalThis.document = origDoc;
      }

      helm.destroy();
    });
  });

  describe('controls-weapons.js (WeaponsController & Lead Targeting)', () => {
    it('calculates velocity-inherited lead intercept coordinates accurately', () => {
      const shooterPos = { x: 0, y: 0 };
      const shooterVel = { x: 0, y: 0 };
      const targetPos = { x: 600, y: 0 };
      const targetVel = { x: 0, y: 0 };
      const projectileSpeed = 600; // 1 second to travel 600m

      const lead = calculateLeadTarget(shooterPos, shooterVel, targetPos, targetVel, projectileSpeed);
      expect(lead).toBeDefined();
      expect(lead.timeToIntercept).toBeCloseTo(1.0, 1);
      expect(lead.x).toBeCloseTo(600, 1);
      expect(lead.y).toBeCloseTo(0, 1);
      expect(lead.aimAngle).toBeCloseTo(0, 2);
    });

    it('instantiates WeaponsController and dispatches weapon triggers', () => {
      const messages = [];
      const weapons = new WeaponsController({
        send: (msg) => messages.push(msg),
      });

      expect(weapons).toBeInstanceOf(WeaponsController);

      // Pulse Laser trigger
      weapons.setLaserFiring(true);
      expect(messages[messages.length - 1]).toEqual({
        type: 'weapons_input',
        fireLaser: true,
        aimAngle: 0,
        aimPitch: 0,
      });

      weapons.setLaserFiring(false);
      expect(messages[messages.length - 1].fireLaser).toBe(false);

      // Railgun charge and release
      weapons.startRailgunCharge();
      expect(messages[messages.length - 1].startRailgunCharge).toBe(true);

      weapons.releaseRailgun();
      expect(messages[messages.length - 1].releaseRailgun).toBe(true);

      // Homing Torpedo launch
      weapons.launchTorpedo();
      expect(messages[messages.length - 1].launchTorpedo).toBe(true);

      // Point-Defense Flak burst
      weapons.fireFlak();
      expect(messages[messages.length - 1].fireFlak).toBe(true);

      // Weapons optical zoom clamping & multiplicative adjustZoom
      expect(weapons.weaponsZoom).toBe(1.0);
      expect(weapons.setZoom(2.5)).toBe(2.5);
      expect(weapons.adjustZoom(3.0)).toBe(5.0);
      expect(weapons.setZoom(0.1)).toBe(0.6);
      expect(weapons.setZoom(1.0)).toBe(1.0);

      // updateHUD safety check
      expect(() => {
        weapons.updateHUD(
          {
            pos: { x: 0, y: 0 },
            vel: { x: 0, y: 0 },
            weapons: {
              heat: 20,
              maxHeat: 100,
              overheated: false,
              charging: false,
              chargeProgress: 0,
              magazine: 6,
              maxMagazine: 8,
              flakCooldown: 0,
            },
          },
          {
            pos: { x: 500, y: 500 },
            vel: { x: 10, y: 0 },
            destroyed: false,
          }
        );
      }).not.toThrow();

      expect(weapons.getLeadReticle()).toBeDefined();
      weapons.destroy();
    });
  });

  describe('controls-engineer.js (EngineerController & 10x10 Grid)', () => {
    it('instantiates EngineerController and dispatches grid interactions and drone assignments', () => {
      const messages = [];
      const engineer = new EngineerController({
        send: (msg) => messages.push(msg),
      });

      expect(engineer).toBeInstanceOf(EngineerController);

      // Rotate tile
      engineer.rotateTile(3, 4);
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'rotate_tile',
        actionType: 'rotate_tile',
        row: 3,
        col: 4,
      });

      // Discharge capacitor
      engineer.dischargeCapacitor(5, 5);
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'discharge_capacitor',
        actionType: 'discharge_capacitor',
        row: 5,
        col: 5,
      });

      // Assign drone to broken tile
      engineer.assignDroneToTile(1, 2, 8);
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'assign_drone_tile',
        actionType: 'assign_drone_tile',
        droneId: 1,
        row: 2,
        col: 8,
      });

      // Assign drone to damaged subsystem
      engineer.selectDrone(2);
      engineer.assignDroneToSubsystem('rcs_thrusters');
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'assign_drone_subsystem',
        actionType: 'assign_drone_subsystem',
        droneId: 2,
        subsystemKey: 'rcs_thrusters',
      });

      // Recall drone
      engineer.recallDrone(2);
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'recall_drone',
        actionType: 'recall_drone',
        droneId: 2,
      });

      // updateHUD safety check
      expect(() => {
        engineer.updateHUD({
          grid: {
            tiles: Array.from({ length: 10 }, (_, r) =>
              Array.from({ length: 10 }, (_, c) => ({
                row: r,
                col: c,
                type: 'straight',
                orientation: 0,
                status: 'nominal',
                powerFlow: true,
                coolantFlow: true,
              }))
            ),
          },
          drones: [
            { id: 1, state: 'idle', stalled: false },
            { id: 2, state: 'moving', stalled: false, targetType: 'tile', target: { row: 2, col: 3 } },
          ],
          powerMap: {
            totalPower: 8.0,
            totalCoolant: 8.0,
            powerConnectedCount: 11,
            coolantConnectedCount: 11,
            powerPerSystem: 8 / 11,
            coolantPerSystem: 8 / 11,
            reactorOnline: true,
          },
        });
      }).not.toThrow();

      engineer.destroy();
    });

    it('verifies 760x760 canvas click and touch coordinate mapping for conduit rotation and perimeter subsystems', () => {
      const messages = [];
      const engineer = new EngineerController({
        send: (msg) => messages.push(msg),
      });

      engineer.grid = {
        tiles: Array.from({ length: 10 }, (_, r) =>
          Array.from({ length: 10 }, (_, c) => ({
            row: r,
            col: c,
            type: 'straight',
            orientation: 0,
            status: 'nominal',
          }))
        ),
      };

      // Mock canvas with 760x760 buffer, rendered at 380x380 (scale = 2.0)
      const mockCanvas = {
        width: 760,
        height: 760,
        getBoundingClientRect: () => ({ left: 50, top: 50, width: 380, height: 380 }),
      };

      // 1. Click inside 10x10 internal grid on tile (3, 4)
      // Cell (3, 4) center in buffer: x = 100 + 4*56 + 28 = 352, y = 100 + 3*56 + 28 = 296
      // Client coords: clientX = 50 + 352 / 2 = 226, clientY = 50 + 296 / 2 = 198
      engineer.handleCanvasClick({ clientX: 226, clientY: 198 }, mockCanvas);
      expect(messages[messages.length - 1]).toEqual({
        type: 'engineer_input',
        action: 'rotate_tile',
        actionType: 'rotate_tile',
        row: 3,
        col: 4,
      });

      // 2. Click outside grid on external perimeter system box (sas_computer on top edge: x=156..268, y=16..100)
      // Box center: x = 212, y = 58 -> Client coords: clientX = 50 + 212/2 = 156, clientY = 50 + 58/2 = 79
      engineer.handleCanvasClick({ clientX: 156, clientY: 79 }, mockCanvas);
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'engineer_input',
        action: 'assign_drone_subsystem',
        actionType: 'assign_drone_subsystem',
        subsystemKey: 'sas_computer',
      }));

      // 3. Touch tap on main_drive (bottom edge external box)
      // main_drive: S edge cells [[9, 6], [9, 7]], x = 436..548, y = 660..744. Center: x = 492, y = 702
      // Client coords: clientX = 50 + 492/2 = 296, clientY = 50 + 702/2 = 401
      const preventDefaultMock = vi.fn();
      engineer.handleCanvasTouch({
        preventDefault: preventDefaultMock,
        touches: [{ clientX: 296, clientY: 401 }],
      }, mockCanvas);
      expect(preventDefaultMock).toHaveBeenCalled();
      expect(messages[messages.length - 1]).toEqual(expect.objectContaining({
        type: 'engineer_input',
        action: 'assign_drone_subsystem',
        actionType: 'assign_drone_subsystem',
        subsystemKey: 'main_drive',
      }));

      engineer.destroy();
    });

    it('verifies dual-carrier canonical dot offset helper and segment discovery', () => {
      // 1. normalizeSeg canonical sorting
      const segForward = normalizeSeg(100, 100, 200, 100);
      const segBackward = normalizeSeg(200, 100, 100, 100);

      expect(segForward.key).toBe(segBackward.key);
      expect(segForward.nx).toBeCloseTo(segBackward.nx, 5);
      expect(segForward.ny).toBeCloseTo(segBackward.ny, 5);
      expect(segForward.len).toBeCloseTo(100, 2);

      // 2. computeDualCarrierOffset for Power vs Coolant
      const powerOffset = computeDualCarrierOffset('power', true, segForward);
      const coolantOffset = computeDualCarrierOffset('coolant', true, segForward);

      // Power: +3.5px offset, phase 0
      expect(powerOffset.offsetX).toBeCloseTo(segForward.nx * 3.5, 4);
      expect(powerOffset.offsetY).toBeCloseTo(segForward.ny * 3.5, 4);
      expect(powerOffset.phase).toBe(0);

      // Coolant: -3.5px offset, phase 14px (0.5 * 28px)
      expect(coolantOffset.offsetX).toBeCloseTo(segForward.nx * -3.5, 4);
      expect(coolantOffset.offsetY).toBeCloseTo(segForward.ny * -3.5, 4);
      expect(coolantOffset.phase).toBe(14);

      // Offset vectors are exactly opposite, separated by 7.0px
      const sepX = powerOffset.offsetX - coolantOffset.offsetX;
      const sepY = powerOffset.offsetY - coolantOffset.offsetY;
      expect(Math.hypot(sepX, sepY)).toBeCloseTo(7.0, 4);

      // Single carrier offset is 0px
      const singleOffset = computeDualCarrierOffset('power', false, segForward);
      expect(singleOffset.offsetX).toBe(0);
      expect(singleOffset.offsetY).toBe(0);
      expect(singleOffset.phase).toBe(0);

      // 3. computeDualCarrierSegments
      const powerPaths = {
        sys1: {
          cells: [{ row: 2, col: 3 }, { row: 1, col: 3 }, { row: 0, col: 3 }],
          exitDir: 'N',
        },
      };
      const coolantPaths = {
        sys1: {
          cells: [{ row: 2, col: 6 }, { row: 1, col: 6 }, { row: 1, col: 3 }, { row: 0, col: 3 }],
          exitDir: 'N',
        },
      };

      const dual = computeDualCarrierSegments(powerPaths, coolantPaths);
      expect(dual.sharedSegments.size).toBeGreaterThan(0);
    });

    it('verifies updateHUD telemetry displays dual pools, connected counts, and #eng-coolant-share', () => {
      const origDoc = globalThis.document;
      const mockElements = {
        'eng-reactor-cap': { textContent: '' },
        'eng-connected-count': { textContent: '' },
        'eng-power-per-node': { textContent: '' },
        'eng-coolant-share': { textContent: '' },
        'eng-drone-bay-status': {
          textContent: '',
          classList: { remove: vi.fn(), add: vi.fn() },
        },
        'drone-list-container': { innerHTML: '' },
        'eng-subsystem-repair-list': null,
      };

      globalThis.document = {
        getElementById: (id) => mockElements[id] || null,
        querySelectorAll: () => [],
      };

      try {
        const engineer = new EngineerController({ send: () => {} });
        engineer.updateHUD({
          grid: { tiles: [] },
          drones: [{ id: 1, state: 'idle' }],
          powerMap: {
            totalPower: 8.0,
            totalCoolant: 8.0,
            powerConnectedCount: 11,
            coolantConnectedCount: 11,
            powerPerSystem: 8 / 11,
            coolantPerSystem: 8 / 11,
            reactorOnline: true,
          },
        });

        expect(mockElements['eng-reactor-cap'].textContent).toBe('8.0 PWR / 8.0 COL');
        expect(mockElements['eng-connected-count'].textContent).toBe('P:11/11 · C:11/11');
        expect(mockElements['eng-power-per-node'].textContent).toBe('73%');
        expect(mockElements['eng-coolant-share'].textContent).toBe('73%');

        engineer.destroy();
      } finally {
        globalThis.document = origDoc;
      }
    });
  });

  describe('main.js (SoundSynth & BroadsideClient)', () => {
    it('instantiates SoundSynth without crashing', () => {
      const sound = new SoundSynth();
      expect(sound).toBeInstanceOf(SoundSynth);

      // Verify all audio synthesizer trigger methods exist and execute safely
      expect(() => sound.playRcsHiss()).not.toThrow();
      expect(() => sound.playLaserZap()).not.toThrow();
      expect(() => sound.playRailgunCharge()).not.toThrow();
      expect(() => sound.playRailgunFire()).not.toThrow();
      expect(() => sound.playTorpedoLaunch()).not.toThrow();
      expect(() => sound.playFlakDetonation()).not.toThrow();
      expect(() => sound.playConduitClick()).not.toThrow();
      expect(() => sound.playBreakerToggle()).not.toThrow();
      expect(() => sound.playCapacitorDischarge()).not.toThrow();
      expect(() => sound.playKillCamSlowMo()).not.toThrow();
    });

    it('instantiates BroadsideClient and manages station switching', () => {
      const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
      expect(client).toBeInstanceOf(BroadsideClient);

      // Switch stations
      client.switchStation('weapons', false);
      expect(client.station).toBe('weapons');

      client.switchStation('engineer', false);
      expect(client.station).toBe('engineer');

      client.switchStation('helm', false);
      expect(client.station).toBe('helm');

      // Test welcome message parsing
      client.handleMessage({
        type: 'welcome',
        playerId: 'p123',
        player: { team: 'omega', station: 'weapons' },
        snapshot: {
          ships: {
            alpha: { hullHp: 1000, maxHullHp: 1000 },
            omega: { hullHp: 900, maxHullHp: 1000 },
          },
        },
      });

      expect(client.playerId).toBe('p123');
      expect(client.team).toBe('omega');
      expect(client.station).toBe('weapons');

      client.destroy();
    });

    it('passes structured options object to SpaceRenderer during rendering loop', () => {
      const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
      const mockRenderer = {
        render: vi.fn(),
      };
      client.renderer = mockRenderer;
      client.team = 'alpha';
      client.station = 'weapons';
      client.camera = { x: 10, y: 20, zoom: 1.2 };
      client.currentSnapshot = {
        ships: {
          alpha: { pos: { x: 100, y: 200 } },
          omega: { pos: { x: 800, y: 200 } },
        },
      };

      // Execute render frame dispatch matching main.js startLoop logic
      const myShip = client.currentSnapshot.ships[client.team];
      if (myShip?.pos) {
        client.camera.x = myShip.pos.x;
        client.camera.y = myShip.pos.y;
      }
      const leadReticle = client.weapons ? client.weapons.getLeadReticle() : null;
      client.renderer.render(client.currentSnapshot, {
        cameraPos: client.camera,
        zoom: client.camera.zoom || 1.0,
        myShipTeam: client.team,
        showLeadReticle: client.station === 'weapons' || Boolean(leadReticle),
        leadReticle,
      });

      expect(mockRenderer.render).toHaveBeenCalledWith(
        client.currentSnapshot,
        expect.objectContaining({
          cameraPos: expect.objectContaining({ x: 100, y: 200 }),
          zoom: 1.2,
          myShipTeam: 'alpha',
          showLeadReticle: true,
        })
      );

      client.destroy();
    });

    it('verifies public/index.html starts with #lobby-overlay active and includes #pregame-station-banner, and main.js has no top-level await import', () => {
      const htmlPath = path.join(publicDir, 'index.html');
      const htmlContent = fs.readFileSync(htmlPath, 'utf8');

      // #lobby-overlay has class="modal-overlay active"
      expect(htmlContent).toMatch(/id="lobby-overlay"[^>]*class="[^"]*modal-overlay active[^"]*"/);

      // #btn-open-lobby has class="btn-hud-action active"
      expect(htmlContent).toMatch(/id="btn-open-lobby"[^>]*class="[^"]*btn-hud-action active[^"]*"/);

      // Contains #pregame-station-banner with actions
      expect(htmlContent).toContain('id="pregame-station-banner"');
      expect(htmlContent).toContain('id="pregame-banner-text"');
      expect(htmlContent).toContain('id="btn-bridge-drydock"');
      expect(htmlContent).toContain('id="btn-bridge-launch"');
      expect(htmlContent).toContain('GO TO STATION');

      // public/js/main.js has no top-level await import
      const mainPath = path.join(publicDir, 'js/main.js');
      const mainContent = fs.readFileSync(mainPath, 'utf8');
      expect(mainContent).not.toMatch(/await\s+import\s*\(/);
      expect(mainContent).toContain("import { SpaceRenderer } from './renderer.js';");
      expect(mainContent).toContain('export function bootstrapBroadsideClient');
    });

    it('verifies BroadsideClient openLobby, closeLobby, toggleLobby, updateLobbyUI, and updatePreGameBanner across states', () => {
      const makeClassList = (initial = []) => {
        const classes = new Set(initial);
        return {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, force) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
          contains: (c) => classes.has(c),
        };
      };

      const makeMockEl = (classes = [], extra = {}) => ({
        classList: makeClassList(classes),
        style: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...extra,
      });

      const mockElements = {
        'lobby-overlay': makeMockEl(['modal-overlay', 'active'], { style: { display: 'flex' } }),
        'btn-open-lobby': makeMockEl(['btn-hud-action', 'active']),
        'btn-close-lobby': makeMockEl(['btn-close-modal']),
        'pregame-station-banner': makeMockEl(['pregame-station-banner']),
        'pregame-banner-text': makeMockEl([], { textContent: '' }),
        'btn-bridge-drydock': makeMockEl(['btn-bridge-secondary']),
        'btn-bridge-launch': makeMockEl(['btn-bridge-primary'], { textContent: '' }),
        'toggle-ai-bots': makeMockEl([], { checked: true }),
        'btn-start-match': makeMockEl(['btn-match-start']),
        'btn-restart-match': makeMockEl(['btn-match-restart']),
        'btn-station-helm': makeMockEl(['station-tab-btn']),
        'btn-station-weapons': makeMockEl(['station-tab-btn']),
        'btn-station-engineer': makeMockEl(['station-tab-btn']),
        'alpha-hull-select': makeMockEl([], { value: 'frigate' }),
        'alpha-mod-helm': makeMockEl([], { value: 'overdrive_rcs' }),
        'alpha-mod-weapons': makeMockEl([], { value: 'heavy_torpedoes' }),
        'alpha-mod-engineer': makeMockEl([], { value: 'standard_drones' }),
        'omega-hull-select': makeMockEl([], { value: 'frigate' }),
        'omega-mod-helm': makeMockEl([], { value: 'overdrive_rcs' }),
        'omega-mod-weapons': makeMockEl([], { value: 'heavy_torpedoes' }),
        'omega-mod-engineer': makeMockEl([], { value: 'standard_drones' }),
      };

      const mockSlotButtons = [
        {
          dataset: { team: 'alpha', station: 'helm' },
          classList: makeClassList(['btn-station-slot']),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          querySelector: (sel) => (sel === '.slot-occupant' ? { textContent: '' } : null),
        },
        {
          dataset: { team: 'alpha', station: 'weapons' },
          classList: makeClassList(['btn-station-slot']),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          querySelector: (sel) => (sel === '.slot-occupant' ? { textContent: '' } : null),
        },
        {
          dataset: { team: 'omega', station: 'helm' },
          classList: makeClassList(['btn-station-slot']),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          querySelector: (sel) => (sel === '.slot-occupant' ? { textContent: '' } : null),
        },
      ];

      const needWindowCleanup = !globalThis.window;
      const needDocCleanup = !globalThis.document;

      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: () => {},
          removeEventListener: () => {},
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      }
      if (!globalThis.document) {
        globalThis.document = {
          getElementById: (id) => mockElements[id] || null,
          querySelector: () => null,
          querySelectorAll: (sel) => (sel === '.btn-station-slot' ? mockSlotButtons : []),
          activeElement: null,
          addEventListener: () => {},
        };
      } else {
        vi.spyOn(document, 'getElementById').mockImplementation((id) => mockElements[id] || null);
        vi.spyOn(document, 'querySelectorAll').mockImplementation((sel) => (sel === '.btn-station-slot' ? mockSlotButtons : []));
      }

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        client.playerId = 'player_alpha_helm';
        client.team = 'alpha';
        client.station = 'helm';

        // 1. Test closeLobby()
        client.closeLobby();
        expect(mockElements['lobby-overlay'].classList.contains('active')).toBe(false);
        expect(mockElements['lobby-overlay'].style.display).toBe('none');
        expect(mockElements['btn-open-lobby'].classList.contains('active')).toBe(false);

        // 2. Test openLobby()
        client.openLobby();
        expect(mockElements['lobby-overlay'].classList.contains('active')).toBe(true);
        expect(mockElements['lobby-overlay'].style.display).toBe('flex');
        expect(mockElements['btn-open-lobby'].classList.contains('active')).toBe(true);

        // 3. Test toggleLobby()
        client.toggleLobby();
        expect(mockElements['lobby-overlay'].classList.contains('active')).toBe(false);
        client.toggleLobby();
        expect(mockElements['lobby-overlay'].classList.contains('active')).toBe(true);

        // 4. Test updateLobbyUI with players & drydock configs
        const lobbySnapshot = {
          state: 'lobby',
          aiEnabled: true,
          players: [
            { id: 'player_alpha_helm', name: 'Maverick', team: 'alpha', station: 'helm', isSpectator: false },
            { id: 'player_omega_helm', name: 'Iceman', team: 'omega', station: 'helm', isSpectator: false },
          ],
          drydock: {
            alpha: {
              hullClass: 'dreadnought',
              modules: { helm: 'reinforced_prow', weapons: 'swarm_missiles', engineer: 'turbo_drones' },
            },
            omega: {
              hullClass: 'corvette',
              modules: { helm: 'overdrive_rcs', weapons: 'flak_specialist', engineer: 'capacitor_batteries' },
            },
          },
        };

        client.updateLobbyUI(lobbySnapshot);
        // Alpha Helm should be occupied and selected by this player
        expect(mockSlotButtons[0].classList.contains('occupied')).toBe(true);
        expect(mockSlotButtons[0].classList.contains('selected')).toBe(true);
        // Omega Helm should be occupied by Iceman, not selected
        expect(mockSlotButtons[2].classList.contains('occupied')).toBe(true);
        expect(mockSlotButtons[2].classList.contains('selected')).toBe(false);
        // Alpha Weapons is unassigned
        expect(mockSlotButtons[1].classList.contains('occupied')).toBe(false);
        expect(mockSlotButtons[1].classList.contains('selected')).toBe(false);

        // Drydock selects synced
        expect(mockElements['alpha-hull-select'].value).toBe('dreadnought');
        expect(mockElements['alpha-mod-weapons'].value).toBe('swarm_missiles');
        expect(mockElements['omega-hull-select'].value).toBe('corvette');

        // 5. Test updatePreGameBanner across 'lobby', 'playing', 'gameover'
        // In 'lobby'
        client.updatePreGameBanner({ state: 'lobby' });
        expect(mockElements['pregame-station-banner'].classList.contains('hidden')).toBe(false);
        expect(mockElements['pregame-banner-text'].textContent).toContain('PRE-FLIGHT STATION CHECK');
        expect(mockElements['pregame-banner-text'].textContent).toContain('UNS HYPERION [HELM] READY');
        expect(mockElements['btn-bridge-launch'].textContent).toBe('LAUNCH MATCH');

        // In 'playing'
        client.updatePreGameBanner({ state: 'playing' });
        expect(mockElements['pregame-station-banner'].classList.contains('hidden')).toBe(true);

        // In 'gameover'
        client.updatePreGameBanner({ state: 'gameover', winner: 'alpha' });
        expect(mockElements['pregame-station-banner'].classList.contains('hidden')).toBe(false);
        expect(mockElements['pregame-banner-text'].textContent).toContain('MATCH COMPLETE — UNS HYPERION VICTORY');
        expect(mockElements['btn-bridge-launch'].textContent).toBe('START NEW MATCH');

        client.destroy();
      } finally {
        if (needWindowCleanup) delete globalThis.window;
        if (needDocCleanup) delete globalThis.document;
      }
    });
  });

  describe('Dynamic verification for Slice 5A modules (renderer.js & spectator.js)', () => {
    it('verifies renderer.js exports SpaceRenderer once present', async () => {
      const rendererFile = path.join(publicDir, 'js/renderer.js');
      if (fs.existsSync(rendererFile)) {
        const mod = await import('../../public/js/renderer.js');
        expect(mod.SpaceRenderer).toBeDefined();
      }
    });

    it('verifies spectator.js exports once present', async () => {
      const spectatorFile = path.join(publicDir, 'js/spectator.js');
      if (fs.existsSync(spectatorFile)) {
        const needWindowCleanup = !globalThis.window;
        const needDocCleanup = !globalThis.document;

        if (!globalThis.window) {
          globalThis.window = {
            addEventListener: () => {},
            removeEventListener: () => {},
            location: { protocol: 'http:', host: 'localhost:3000' },
          };
        }
        if (!globalThis.document) {
          globalThis.document = {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
          };
        }

        try {
          const mod = await import('../../public/js/spectator.js');
          expect(mod).toBeDefined();
        } finally {
          if (needWindowCleanup) delete globalThis.window;
          if (needDocCleanup) delete globalThis.document;
        }
      }
    });

    it('verifies SpectatorApp status and victor overlay updates correctly', async () => {
      const { SpectatorApp } = await import('../../public/js/spectator.js');
      expect(SpectatorApp).toBeDefined();

      const makeClassList = () => {
        const classes = new Set();
        return {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, force) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
          contains: (c) => classes.has(c),
        };
      };

      const mockStatusLabel = { textContent: '' };
      const app = Object.create(SpectatorApp.prototype);
      app.elMatchStatus = {
        querySelector: (sel) => (sel === '.status-label' ? mockStatusLabel : null),
      };
      app.btnStartDemo = {
        textContent: '',
        classList: makeClassList(),
      };
      app.elKillCam = {
        classList: makeClassList(),
      };
      app.elVictorOverlay = {
        classList: makeClassList(),
      };
      app.elVictorBanner = {
        classList: makeClassList(),
      };
      app.elVictorTitle = { textContent: '' };
      app.elVictorSubtitle = { textContent: '' };

      // 1. Lobby state
      app.updateMatchStatus({ state: 'lobby' });
      expect(mockStatusLabel.textContent).toBe('LOBBY / DRY-DOCK OUTFITTING');
      expect(app.btnStartDemo.textContent).toBe('START / DEMO AI MATCH');
      expect(app.btnStartDemo.classList.contains('hidden')).toBe(false);

      // 2. Active combat state (no winner)
      app.updateMatchStatus({ state: 'playing', winner: null });
      expect(mockStatusLabel.textContent).toBe('ENGAGED / COMBAT ACTIVE');
      expect(app.btnStartDemo.textContent).toBe('RESTART COMBAT MATCH');
      expect(app.btnStartDemo.classList.contains('hidden')).toBe(true);

      // 3. Victor overlay suppressed during killing blow slow-mo (before replay completes)
      app.updateVictorOverlay({ winner: 'alpha', slowMoActive: true, state: 'playing', replayActive: false });
      expect(app.elVictorOverlay.classList.contains('hidden')).toBe(true);

      // 3b. Victor overlay suppressed during active replay
      app.updateVictorOverlay({ winner: 'alpha', slowMoActive: false, state: 'gameover', replayActive: true });
      expect(app.elVictorOverlay.classList.contains('hidden')).toBe(true);

      // 4. Game Over state (after replay completes)
      app.updateMatchStatus({ state: 'gameover', winner: 'alpha', replayActive: false, replayComplete: true });
      expect(mockStatusLabel.textContent).toBe('VICTORY — UNS HYPERION');
      expect(app.btnStartDemo.textContent).toBe('START NEW MATCH');
      expect(app.btnStartDemo.classList.contains('hidden')).toBe(false);

      app.updateVictorOverlay({ winner: 'alpha', state: 'gameover', replayActive: false, replayComplete: true });
      expect(app.elVictorOverlay.classList.contains('hidden')).toBe(false);
      expect(app.elVictorTitle.textContent).toBe('VICTOR: UNS HYPERION');
      expect(app.elVictorSubtitle.textContent).toBe('TEAM ALPHA VICTORY');
      expect(app.elVictorBanner.classList.contains('victor-alpha')).toBe(true);
      expect(app.elVictorBanner.classList.contains('victor-omega')).toBe(false);

      // 5. Victor overlay on Omega victory after replay completes
      app.updateVictorOverlay({ winner: 'omega', state: 'gameover', replayActive: false, replayComplete: true });
      expect(app.elVictorOverlay.classList.contains('hidden')).toBe(false);
      expect(app.elVictorTitle.textContent).toBe('VICTOR: KRS VANGUARD');
      expect(app.elVictorSubtitle.textContent).toBe('TEAM OMEGA VICTORY');
      expect(app.elVictorBanner.classList.contains('victor-alpha')).toBe(false);
      expect(app.elVictorBanner.classList.contains('victor-omega')).toBe(true);

      // 6. Reset / No winner hides overlay
      app.updateVictorOverlay({ winner: null, state: 'lobby' });
      expect(app.elVictorOverlay.classList.contains('hidden')).toBe(true);

      // 7. Kill Cam banner toggle
      app.updateBanners({ slowMoActive: true });
      expect(app.elKillCam.classList.contains('hidden')).toBe(false);
      app.updateBanners({ slowMoActive: false });
      expect(app.elKillCam.classList.contains('hidden')).toBe(true);
    });
  });

  describe('Phase 8 Slice 3: Station Isolation, POV HUD, Free-Look & Tablet Responsiveness', () => {
    it('enforces strict client station input isolation across all 3 controllers', () => {
      const needWindowCleanup = !globalThis.window;
      const needDocCleanup = !globalThis.document;
      const makeClassList = (initial = []) => {
        const set = new Set(initial);
        return {
          add: (c) => set.add(c),
          remove: (c) => set.delete(c),
          toggle: (c, force) => (force ?? !set.has(c)) ? set.add(c) : set.delete(c),
          contains: (c) => set.has(c),
        };
      };

      const mockLobby = {
        classList: makeClassList(['active']),
        style: { display: 'flex' },
      };

      const mockDoc = {
        getElementById: (id) => {
          if (id === 'lobby-overlay') return mockLobby;
          return null;
        },
        querySelectorAll: () => [],
        querySelector: () => null,
        activeElement: null,
      };

      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: () => {},
          removeEventListener: () => {},
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      }
      const origDoc = globalThis.document;
      globalThis.document = mockDoc;

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        expect(client.helm).toBeDefined();
        expect(client.weapons).toBeDefined();
        expect(client.engineer).toBeDefined();

        // 1. In Lobby: all 3 controllers must be deactivated
        client.openLobby();
        expect(client.helm.isActive).toBe(false);
        expect(client.weapons.isActive).toBe(false);
        expect(client.engineer.isActive).toBe(false);

        // Deactivated controllers reject inputs
        expect(client.helm.canHandleInput()).toBe(false);
        expect(client.weapons.canHandleInput()).toBe(false);
        expect(client.engineer.canHandleInput()).toBe(false);

        // 2. Close lobby -> active station (default 'helm') is activated, others inactive
        client.closeLobby();
        mockLobby.classList.remove('active');
        mockLobby.style.display = 'none';
        client.syncStationControllers();

        expect(client.helm.isActive).toBe(true);
        expect(client.weapons.isActive).toBe(false);
        expect(client.engineer.isActive).toBe(false);

        // Switch to weapons
        client.switchStation('weapons', false);
        expect(client.helm.isActive).toBe(false);
        expect(client.weapons.isActive).toBe(true);
        expect(client.engineer.isActive).toBe(false);

        // Switch to engineer
        client.switchStation('engineer', false);
        expect(client.helm.isActive).toBe(false);
        expect(client.weapons.isActive).toBe(false);
        expect(client.engineer.isActive).toBe(true);

        // 3. Text field focus blocks input
        mockDoc.activeElement = { tagName: 'INPUT' };
        expect(client.engineer.canHandleInput()).toBe(false);
        mockDoc.activeElement = { tagName: 'TEXTAREA' };
        expect(client.engineer.canHandleInput()).toBe(false);
        mockDoc.activeElement = null;
        expect(client.engineer.canHandleInput()).toBe(true);

        // 4. Deactivation clears transient held state
        client.switchStation('weapons', false);
        const weaponsMsgs = [];
        client.weapons.send = (m) => weaponsMsgs.push(m);
        client.weapons.isFiringLaser = true;
        client.weapons.setActive(false);
        expect(client.weapons.isFiringLaser).toBe(false);
        expect(weaponsMsgs[weaponsMsgs.length - 1]).toEqual(
          expect.objectContaining({ type: 'weapons_input', fireLaser: false })
        );

        client.destroy();
      } finally {
        globalThis.document = origDoc;
        if (needDocCleanup) delete globalThis.document;
        if (needWindowCleanup) delete globalThis.window;
      }
    });

    it('triggers renderer.resize on init, window resize, orientationchange, and station switch', () => {
      const resizeCalls = [];
      const mockRenderer = {
        resize: vi.fn(() => resizeCalls.push('resize')),
        render: vi.fn(),
      };

      const needWindowCleanup = !globalThis.window;
      const needDocCleanup = !globalThis.document;

      const listeners = {};
      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); },
          removeEventListener: (evt, fn) => { if (listeners[evt]) listeners[evt] = listeners[evt].filter(f => f !== fn); },
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      } else {
        vi.spyOn(globalThis.window, 'addEventListener').mockImplementation((evt, fn) => {
          (listeners[evt] = listeners[evt] || []).push(fn);
        });
      }

      const origDoc = globalThis.document;
      if (!globalThis.document) {
        globalThis.document = {
          getElementById: () => null,
          querySelector: () => null,
          querySelectorAll: () => [],
        };
      }

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        client.renderer = mockRenderer;

        // Simulate resize and orientationchange events
        if (listeners['resize']) {
          listeners['resize'].forEach(fn => fn());
        }
        if (listeners['orientationchange']) {
          listeners['orientationchange'].forEach(fn => fn());
        }
        expect(mockRenderer.resize).toHaveBeenCalled();

        // Switch station triggers resize
        client.switchStation('helm', false);
        expect(mockRenderer.resize).toHaveBeenCalled();

        // Close lobby triggers resize
        client.closeLobby();
        expect(mockRenderer.resize).toHaveBeenCalled();

        client.destroy();
      } finally {
        globalThis.document = origDoc;
        if (needDocCleanup) delete globalThis.document;
        if (needWindowCleanup) delete globalThis.window;
      }
    });

    it('verifies public/index.html & public/css/style.css include PiP slots, minimap, reticles, side deck, and responsive rules', () => {
      const htmlPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // Helm POV & PiP
      expect(html).toContain('id="helm-minimap-card"');
      expect(html).toContain('id="helm-minimap-canvas"');
      expect(html).toContain('id="helm-pip-panel"');
      expect(html).toContain('data-pip="dorsal"');
      expect(html).toContain('data-pip="side"');
      expect(html).toContain('data-pip="stern"');

      // Enemy edge indicator
      expect(html).toContain('id="enemy-edge-indicator"');
      expect(html).toContain('id="enemy-edge-dist"');

      // Weapons console overhauled
      expect(html).toContain('id="weapons-reticle-overlay"');
      expect(html).toContain('id="railgun-barrel-reticle"');
      expect(html).toContain('id="weapons-look-panel"');
      expect(html).toContain('id="weapons-look-stick-zone"');
      expect(html).toContain('id="btn-recenter-view"');
      expect(html).toContain('id="btn-select-laser"');
      expect(html).toContain('id="btn-select-railgun"');
      expect(html).toContain('id="btn-select-torpedo"');
      expect(html).toContain('id="btn-select-flak"');
      expect(html).toContain('id="railgun-slew-status"');
      expect(html).toContain('id="stabilizer-status"');

      // Top-down enemy status diagram & optical zoom readout replace subsystem select
      expect(html).not.toContain('id="subsystem-target-select"');
      expect(html).toContain('id="enemy-diagram-canvas"');
      expect(html).toContain('id="enemy-damage-list"');
      expect(html).toContain('id="weapons-zoom-readout"');

      // Engineer SAS button updated
      expect(html).toContain('data-subsystem="sas_computer"');
      expect(html).toContain('SAS / VIEW STAB');

      // CSS rules
      const cssPath = path.join(publicDir, 'css/style.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      expect(css).toContain('touch-action: none');
      expect(css).toContain('.enemy-diagram-canvas');
      expect(css).toContain('.weapons-zoom-readout');

      expect(css).toMatch(/\.pip-slot\s*\{[^}]*background:\s*transparent\s*!important/);
      expect(css).toMatch(/\.pip-slot\s*\{[^}]*pointer-events:\s*none/);
      expect(css).toContain('.enemy-edge-indicator');
      expect(css).toContain('.weapons-deck');
      expect(css).toContain('@media (max-width: 1100px)');
      expect(css).toContain('@media (max-height: 650px)');
    });

    it('verifies WeaponsController 360° free-look, motion perturbation decay, weapon modes, and click/tap firing', () => {
      const messages = [];
      const mockRenderer = {
        screenToWorldOnPlane: vi.fn((cx, cy) => ({ x: 700, y: 100 })),
      };

      const weapons = new WeaponsController({
        send: (msg) => messages.push(msg),
        renderer: mockRenderer,
        myTeam: 'alpha',
      });

      // 1. Mode switching
      weapons.selectWeapon('railgun');
      expect(weapons.selectedWeapon).toBe('railgun');
      weapons.selectWeapon('torpedo');
      expect(weapons.selectedWeapon).toBe('torpedo');
      weapons.selectWeapon('flak');
      expect(weapons.selectedWeapon).toBe('flak');
      weapons.selectWeapon('laser');
      expect(weapons.selectedWeapon).toBe('laser');

      // 2. Free look panning via stick & recentering
      weapons.lookStickVec = { x: 1.0, y: 0 };
      weapons.updateGunnerView(0.1, { omega: 0, weapons: { stabilizerHealth: 100 } });
      expect(weapons.desiredLookOffset).toBeGreaterThan(0);
      expect(weapons.getGunnerWorldAngle({ angle: 0 })).toBeCloseTo(weapons.gunnerLookOffset, 2);

      weapons.recenterView();
      expect(weapons.desiredLookOffset).toBe(0);

      // 3. Ship rotation perturbation decays faster with healthy stabilizer than damaged stabilizer
      const wHealthy = new WeaponsController();
      wHealthy.updateGunnerView(0.1, { omega: 1.5, weapons: { stabilizerHealth: 100 } });
      const pertHealthyJolt = Math.abs(wHealthy.viewPerturbation);
      expect(pertHealthyJolt).toBeGreaterThan(0);

      // Decay over 0.5s with zero omega
      wHealthy.updateGunnerView(0.5, { omega: 0, weapons: { stabilizerHealth: 100 } });
      const pertHealthyRemaining = Math.abs(wHealthy.viewPerturbation);

      const wDamaged = new WeaponsController();
      wDamaged.updateGunnerView(0.1, { omega: 1.5, weapons: { stabilizerHealth: 20 } });
      wDamaged.updateGunnerView(0.5, { omega: 0, weapons: { stabilizerHealth: 20 } });
      const pertDamagedRemaining = Math.abs(wDamaged.viewPerturbation);

      expect(pertHealthyRemaining).toBeLessThan(pertDamagedRemaining);

      // 4. Click/Tap-to-fire on space canvas routing through screenToWorldOnPlane
      weapons.latestSnapshot = {
        ships: {
          alpha: { pos: { x: 100, y: 100 } },
        },
      };

      // Laser firing
      weapons.selectWeapon('laser');
      weapons.handlePointerFireStart(600, 300);
      expect(mockRenderer.screenToWorldOnPlane).toHaveBeenCalled();
      const lastLaserMsg = messages[messages.length - 1];
      expect(lastLaserMsg.type).toBe('weapons_input');
      expect(lastLaserMsg.fireLaser).toBe(true);
      expect(lastLaserMsg.aimAngle).toBeCloseTo(0, 1);

      weapons.handlePointerFireEnd();
      expect(messages[messages.length - 1].fireLaser).toBe(false);

      // Railgun firing
      weapons.selectWeapon('railgun');
      weapons.handlePointerFireStart(600, 300);
      expect(messages[messages.length - 1].startRailgunCharge).toBe(true);

      weapons.handlePointerFireEnd();
      expect(messages[messages.length - 1].releaseRailgun).toBe(true);

      // Torpedo firing
      weapons.selectWeapon('torpedo');
      weapons.handlePointerFireStart(600, 300);
      expect(messages[messages.length - 1].launchTorpedo).toBe(true);

      // Flak firing
      weapons.selectWeapon('flak');
      weapons.handlePointerFireStart(600, 300);
      expect(messages[messages.length - 1].fireFlak).toBe(true);

      weapons.destroy();
    });

    it('verifies EngineerController updateHUD displays live hardware health badges on subsystem repair targets', () => {
      const mockBtns = [
        { dataset: { subsystem: 'main_drive' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
        { dataset: { subsystem: 'rcs_thrusters' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
        { dataset: { subsystem: 'sas_computer' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
        { dataset: { subsystem: 'shields_fore' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
        { dataset: { subsystem: 'weapons_laser' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
        { dataset: { subsystem: 'weapons_railgun' }, querySelector: () => null, appendChild: vi.fn(), classList: { add: vi.fn() } },
      ];

      const origDoc = globalThis.document;
      globalThis.document = {
        getElementById: () => null,
        querySelectorAll: (sel) => (sel === '.btn-repair-target' ? mockBtns : []),
        createElement: (tag) => ({ className: '', textContent: '' }),
      };

      try {
        const engineer = new EngineerController({ send: () => {} });
        engineer.updateHUD({
          mainDrive: { health: 70 },
          weapons: { railgunHealth: 15, stabilizerHealth: 45, laserHealth: 90 },
          thrusters: {
            bowPort: { health: 60 },
            bowStarboard: { health: 80 },
          },
          shields: {
            subsystemHealth: { fore: 85 },
          },
        });

        // Each mock button had appendChild called with a created badge
        expect(mockBtns[0].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '70%' }));
        expect(mockBtns[1].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '70%' })); // (60+80)/2
        expect(mockBtns[2].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '45%' }));
        expect(mockBtns[3].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '85%' }));
        expect(mockBtns[4].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '90%' }));
        expect(mockBtns[5].appendChild).toHaveBeenCalledWith(expect.objectContaining({ textContent: '15%' }));

        // Verify object-shaped shields.maxHp computes percentage cleanly without NaN
        engineer.updateHUD({
          mainDrive: { health: 100 },
          shields: { hp: { fore: 100 }, maxHp: { fore: 200 } },
        });
        expect(mockBtns[3].appendChild).toHaveBeenLastCalledWith(expect.objectContaining({ textContent: '50%' }));

        engineer.destroy();
      } finally {
        globalThis.document = origDoc;
      }
    });

    it('verifies WeaponsController updateHUD merges snapshot without clobbering sector and does not double-tick updateGunnerView', () => {
      const weapons = new WeaponsController({ myTeam: 'alpha' });
      weapons.latestSnapshot = {
        sector: { arenaRadius: 5250, asteroids: [{ id: 'ast1' }] },
      };

      const spy = vi.spyOn(weapons, 'updateGunnerView');
      weapons.updateHUD({ id: 'alpha', team: 'alpha' }, { id: 'omega', team: 'omega' });

      // Sector preserved
      expect(weapons.latestSnapshot.sector).toBeDefined();
      expect(weapons.latestSnapshot.sector.arenaRadius).toBe(5250);
      expect(weapons.latestSnapshot.ships.alpha).toBeDefined();
      expect(weapons.latestSnapshot.ships.omega).toBeDefined();

      // updateGunnerView NOT called by updateHUD (single caller is main.js RAF loop)
      expect(spy).not.toHaveBeenCalled();
    });

    it('verifies linear acceleration alters viewPerturbation in updateGunnerView', () => {
      const weapons = new WeaponsController();
      // First frame sets baseline velocity
      weapons.updateGunnerView(0.016, { vel: { x: 0, y: 0 }, omega: 0, rollOmega: 0, weapons: { stabilizerHealth: 100 } });
      expect(weapons.viewPerturbation).toBe(0);

      // Sudden lateral acceleration: vy leaps from 0 to 60 m/s
      weapons.updateGunnerView(0.016, { vel: { x: 0, y: 60 }, omega: 0, rollOmega: 0, weapons: { stabilizerHealth: 100 } });
      expect(Math.abs(weapons.viewPerturbation)).toBeGreaterThan(0);
    });

    it('verifies negative look angle display formats with leading minus sign', () => {
      const origDoc = globalThis.document;
      let angleText = '';
      globalThis.document = {
        getElementById: (id) => (id === 'weapons-look-angle' ? { set textContent(v) { angleText = v; } } : null),
      };

      try {
        const weapons = new WeaponsController();
        weapons.desiredLookOffset = -Math.PI / 4; // -45 degrees
        weapons.updateGunnerView(0.016, { vel: { x: 0, y: 0 }, omega: 0, weapons: { stabilizerHealth: 100 } });
        expect(angleText).toBe('LOOK -45° / +0°');
      } finally {
        globalThis.document = origDoc;
      }
    });

    it('verifies enemy edge arrow in main.js applies + Math.PI / 2 offset to upright arrow icon', () => {
      const mainJs = fs.readFileSync(path.join(publicDir, 'js/main.js'), 'utf8');
      expect(mainJs).toContain('rotate(${edgeInfo.arrowAngleRad + Math.PI / 2}rad)');
    });

    it('verifies Helm HUD CSS positions for PiP panel, RCS panel, and minimap are non-overlapping', () => {
      const css = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');

      // 1. .helm-pip-panel at top-right horizontal strip (non-overlapping with minimap)
      expect(css).toMatch(/\.helm-pip-panel\s*\{[^}]*top:\s*16px/);
      expect(css).toMatch(/\.helm-pip-panel\s*\{[^}]*right:\s*16px/);
      expect(css).toMatch(/\.helm-pip-panel\s*\{[^}]*flex-direction:\s*row/);

      // 2. .rcs-panel moved to left column below telemetry-panel
      expect(css).toMatch(/\.rcs-panel\s*\{[^}]*top:\s*216px/);
      expect(css).toMatch(/\.rcs-panel\s*\{[^}]*left:\s*16px/);
      expect(css).not.toMatch(/\.rcs-panel\s*\{[^}]*right:\s*16px/);

      // 3. .helm-minimap-card positioned at bottom: 196px; right: 16px (above stick-right-zone at bottom: 28px..178px)
      expect(css).toMatch(/\.helm-minimap-card\s*\{[^}]*bottom:\s*196px/);
      expect(css).toMatch(/\.helm-minimap-card\s*\{[^}]*right:\s*16px/);

      // 4. #helm-throttle-panel positioned cleanly above helm actions bar (5-col 2-row grid)
      expect(css).toMatch(/#helm-throttle-panel\s*\{[^}]*bottom:\s*176px/);
      expect(css).toMatch(/\.helm-actions-bar\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*1fr\)/);
    });

    it('verifies WeaponsController onTouchStart calls preventDefault and global onTouchEnd only suppresses clicks when actively firing', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;
      let registeredTouchStart = null;
      let registeredWinTouchEnd = null;
      const mockCanvas = {
        addEventListener: (event, handler) => {
          if (event === 'touchstart') registeredTouchStart = handler;
        },
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      };

      globalThis.document = {
        getElementById: (id) => (id === 'space-canvas' ? mockCanvas : null),
        querySelectorAll: () => [],
      };
      globalThis.window = {
        addEventListener: (event, handler) => {
          if (event === 'touchend') registeredWinTouchEnd = handler;
        },
        removeEventListener: () => {},
      };

      try {
        const weapons = new WeaponsController({ send: () => {} });
        weapons.bind();
        expect(registeredTouchStart).toBeDefined();
        expect(registeredWinTouchEnd).toBeDefined();

        // Idle UI touch (e.g. clicking a Drydock/station button) must NOT call preventDefault
        const idlePrevent = vi.fn();
        registeredWinTouchEnd({ preventDefault: idlePrevent });
        expect(idlePrevent).not.toHaveBeenCalled();

        // Canvas fire touch calls preventDefault on touchstart and on active touchend
        const startPrevent = vi.fn();
        registeredTouchStart({
          preventDefault: startPrevent,
          touches: [{ clientX: 600, clientY: 300 }],
        });
        expect(startPrevent).toHaveBeenCalled();

        const activeEndPrevent = vi.fn();
        registeredWinTouchEnd({ preventDefault: activeEndPrevent });
        expect(activeEndPrevent).toHaveBeenCalled();
        weapons.destroy();
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });

    describe('Phase 10 Slice 3: Helm Pitch & Throttle, Weapons 3D Aim, 3D Elevation & HUD', () => {
      it('verifies DOM elements for throttle panel, telemetry, and 10 RCS pills exist in index.html and style.css', () => {
        const htmlPath = path.join(publicDir, 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        // Throttle panel
        expect(html).toContain('id="helm-throttle-panel"');
        expect(html).toContain('id="helm-throttle-slider"');
        expect(html).toContain('id="helm-throttle-value"');
        expect(html).toContain('id="btn-throttle-zero"');
        expect(html).toContain('id="btn-throttle-max"');

        // Pitch & Elevation telemetry
        expect(html).toContain('id="helm-pitch"');
        expect(html).toContain('id="helm-alt"');

        // All 10 RCS nozzle pills
        expect(html).toContain('id="rcs-bowPort"');
        expect(html).toContain('id="rcs-bowStarboard"');
        expect(html).toContain('id="rcs-sternPort"');
        expect(html).toContain('id="rcs-sternStarboard"');
        expect(html).toContain('id="rcs-dorsalRoll"');
        expect(html).toContain('id="rcs-ventralRoll"');
        expect(html).toContain('id="rcs-bow-dorsal"');
        expect(html).toContain('id="rcs-bow-ventral"');
        expect(html).toContain('id="rcs-stern-dorsal"');
        expect(html).toContain('id="rcs-stern-ventral"');

        // CSS rules
        const cssPath = path.join(publicDir, 'css/style.css');
        const css = fs.readFileSync(cssPath, 'utf8');
        expect(css).toContain('#helm-throttle-panel');
        expect(css).toContain('#helm-throttle-slider');
        expect(css).toContain('.btn-throttle');
      });

      it('verifies HelmController pitch keys (ArrowUp: -1, ArrowDown: +1) and payload structure', () => {
        const messages = [];
        const helm = new HelmController({
          send: (msg) => messages.push(msg),
        });

        helm.handleKeyDown({ code: 'ArrowUp', preventDefault: () => {} });
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'helm_input',
            pitch: -1,
          })
        );

        helm.handleKeyUp({ code: 'ArrowUp', preventDefault: () => {} });
        expect(messages[messages.length - 1].pitch).toBe(0);

        helm.handleKeyDown({ code: 'ArrowDown', preventDefault: () => {} });
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'helm_input',
            pitch: 1,
          })
        );

        helm.handleKeyUp({ code: 'ArrowDown', preventDefault: () => {} });
        expect(messages[messages.length - 1].pitch).toBe(0);

        helm.destroy();
      });

      it('verifies HelmController throttle ramping via Shift/Control, slider binding, and decoupled RCS translation (KeyW / KeyS)', () => {
        const messages = [];
        const slider = { value: '0' };
        const valText = { textContent: '' };

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => {
            if (id === 'helm-throttle-slider') return slider;
            if (id === 'helm-throttle-value') return valText;
            return null;
          },
          querySelectorAll: () => [],
        };

        try {
          const helm = new HelmController({
            send: (msg) => messages.push(msg),
          });

          // 1. Throttle step up via ShiftLeft
          helm.handleKeyDown({ code: 'ShiftLeft', preventDefault: () => {} });
          expect(helm.throttleSetting).toBeCloseTo(0.05, 3);
          expect(messages[messages.length - 1].throttleSetting).toBeCloseTo(0.05, 3);
          expect(messages[messages.length - 1].mainThrottle).toBeCloseTo(0.05, 3);
          expect(messages[messages.length - 1].forward).toBeCloseTo(0.05, 3);

          // Continuous ramp via step(0.5s)
          helm.step(0.5); // + 0.55 * 0.5 = +0.275 -> ~0.325
          expect(helm.throttleSetting).toBeGreaterThan(0.3);
          helm.handleKeyUp({ code: 'ShiftLeft', preventDefault: () => {} });

          // 2. Throttle step down via ControlLeft
          const beforeCtrl = helm.throttleSetting;
          helm.handleKeyDown({ code: 'ControlLeft', preventDefault: () => {} });
          expect(helm.throttleSetting).toBeCloseTo(beforeCtrl - 0.05, 3);
          expect(messages[messages.length - 1].throttleSetting).toBeCloseTo(beforeCtrl - 0.05, 3);
          expect(messages[messages.length - 1].forward).toBeCloseTo(beforeCtrl - 0.05, 3);

          // Continuous ramp down via step(0.2s)
          helm.step(0.2);
          expect(helm.throttleSetting).toBeLessThan(beforeCtrl - 0.05);
          helm.handleKeyUp({ code: 'ControlLeft', preventDefault: () => {} });

          // 3. Slider update
          helm.setThrottleSetting(0.75);
          expect(helm.throttleSetting).toBe(0.75);
          expect(slider.value).toBe('75');
          expect(valText.textContent).toBe('75%');
          expect(messages[messages.length - 1].throttleSetting).toBe(0.75);
          expect(messages[messages.length - 1].forward).toBe(0.75);

          // 4. Decoupled RCS longitudinal translation: KeyW sets rcsForward = 1.0 without modifying throttleSetting or forward
          helm.handleKeyDown({ code: 'KeyW', preventDefault: () => {} });
          expect(helm.state.rcsForward).toBe(1.0);
          expect(messages[messages.length - 1].rcsForward).toBe(1.0);
          expect(helm.state.forward).toBe(0.75);
          expect(helm.throttleSetting).toBe(0.75);

          helm.handleKeyUp({ code: 'KeyW', preventDefault: () => {} });
          expect(helm.state.rcsForward).toBe(0);
          expect(messages[messages.length - 1].rcsForward).toBe(0);
          expect(helm.state.forward).toBe(0.75);
          expect(helm.throttleSetting).toBe(0.75);

          // 5. Decoupled RCS longitudinal translation: KeyS sets rcsForward = -1.0 without modifying throttleSetting or forward
          helm.handleKeyDown({ code: 'KeyS', preventDefault: () => {} });
          expect(helm.state.rcsForward).toBe(-1.0);
          expect(messages[messages.length - 1].rcsForward).toBe(-1.0);
          expect(helm.state.forward).toBe(0.75);
          expect(helm.throttleSetting).toBe(0.75);

          helm.handleKeyUp({ code: 'KeyS', preventDefault: () => {} });
          expect(helm.state.rcsForward).toBe(0);
          expect(messages[messages.length - 1].rcsForward).toBe(0);
          expect(helm.state.forward).toBe(0.75);
          expect(helm.throttleSetting).toBe(0.75);

          helm.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies #helm-throttle-slider focus does not lock out input events or flight keyboard controls', () => {
        const messages = [];
        const sliderEvents = {};
        const mockSlider = {
          tagName: 'INPUT',
          type: 'range',
          value: '40',
          blur: vi.fn(),
          addEventListener: (ev, handler) => {
            sliderEvents[ev] = handler;
          },
          removeEventListener: vi.fn(),
        };

        const origDoc = globalThis.document;
        const origWin = globalThis.window;
        const winListeners = {};

        globalThis.document = {
          activeElement: mockSlider,
          getElementById: (id) => (id === 'helm-throttle-slider' ? mockSlider : null),
          querySelectorAll: () => [],
        };

        globalThis.window = {
          addEventListener: (ev, handler) => {
            winListeners[ev] = handler;
          },
          removeEventListener: vi.fn(),
        };

        try {
          const helm = new HelmController({
            send: (msg) => messages.push(msg),
          });
          helm.bind();

          // 1. canHandleInput must return true even when range slider is activeElement
          expect(helm.canHandleInput()).toBe(true);

          // 2. Dispatch input on slider
          mockSlider.value = '65';
          sliderEvents['input']();
          expect(helm.throttleSetting).toBe(0.65);
          expect(messages[messages.length - 1].throttleSetting).toBe(0.65);

          // 3. Slider blur on change / pointerup
          sliderEvents['change']();
          expect(mockSlider.blur).toHaveBeenCalled();
          sliderEvents['pointerup']();
          expect(mockSlider.blur).toHaveBeenCalledTimes(2);

          // 4. Slider keydown prevents default for flight keys (including ControlLeft / ControlRight / ShiftLeft / ShiftRight / KeyW / KeyS)
          const preventMock = vi.fn();
          sliderEvents['keydown']({ code: 'ArrowUp', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalled();
          sliderEvents['keydown']({ code: 'ControlLeft', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalledTimes(2);
          sliderEvents['keydown']({ code: 'ControlRight', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalledTimes(3);
          sliderEvents['keydown']({ code: 'ShiftLeft', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalledTimes(4);
          sliderEvents['keydown']({ code: 'KeyW', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalledTimes(5);
          sliderEvents['keydown']({ code: 'KeyS', preventDefault: preventMock });
          expect(preventMock).toHaveBeenCalledTimes(6);

          // 5. Flight controls (ArrowUp, ArrowDown, KeyW) work cleanly even if target is mockSlider
          helm.handleKeyDown({ code: 'ArrowUp', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.ArrowUp).toBe(true);
          expect(helm.state.pitch).toBe(-1);
          expect(messages[messages.length - 1].pitch).toBe(-1);

          helm.handleKeyUp({ code: 'ArrowUp', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.ArrowUp).toBe(false);
          expect(helm.state.pitch).toBe(0);

          helm.handleKeyDown({ code: 'ArrowDown', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.ArrowDown).toBe(true);
          expect(helm.state.pitch).toBe(1);

          helm.handleKeyUp({ code: 'ArrowDown', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.ArrowDown).toBe(false);
          expect(helm.state.pitch).toBe(0);

          helm.handleKeyDown({ code: 'KeyW', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.KeyW).toBe(true);
          expect(helm.state.rcsForward).toBe(1.0);

          helm.handleKeyUp({ code: 'KeyW', target: mockSlider, preventDefault: () => {} });
          expect(helm.keys.KeyW).toBe(false);
          expect(helm.state.rcsForward).toBe(0);

          helm.destroy();
        } finally {
          globalThis.document = origDoc;
          globalThis.window = origWin;
        }
      });

      it('verifies pure vel.z displays speed accurately and enables prograde auto-orient', () => {
        const mockElements = new Map();
        const makeEl = (id) => {
          const el = {
            id,
            textContent: '',
            classList: {
              _classes: new Set(),
              add(c) { this._classes.add(c); },
              remove(c) { this._classes.delete(c); },
              contains(c) { return this._classes.has(c); },
            },
            disabled: false,
            dataset: {},
            querySelector: vi.fn(() => ({ textContent: '' })),
          };
          mockElements.set(id, el);
          return el;
        };

        const ids = [
          'helm-speed', 'helm-heading', 'helm-omega', 'helm-roll-telemetry',
          'helm-pitch', 'helm-alt', 'helm-throttle', 'helm-throttle-value',
          'helm-throttle-slider', 'btn-toggle-sas', 'btn-roll-port',
          'btn-stop-roll', 'btn-roll-starboard', 'btn-orient-prograde',
          'btn-orient-retrograde', 'btn-orient-target', 'btn-orient-anti-target',
        ];
        ids.forEach(makeEl);

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => mockElements.get(id) || null,
          querySelectorAll: () => [],
        };

        try {
          const helm = new HelmController({ send: () => {} });
          // Pure Z velocity: vx = 0, vy = 0, vz = 50
          helm.updateHUD({
            vel: { x: 0, y: 0, z: 50 },
            angle: 0,
            omega: 0,
            pitch: 0,
            pos: { x: 0, y: 0, z: 250 },
            mainDrive: { throttle: 0.5 },
            thrusters: {},
            sasActive: true,
            autoOrientMode: 'prograde',
          });

          // Speed telemetry shows 50.0 m/s
          expect(mockElements.get('helm-speed').textContent).toBe('50.0 m/s');
          // Prograde button is enabled (not disabled)
          expect(mockElements.get('btn-orient-prograde').classList.contains('disabled')).toBe(false);
          expect(mockElements.get('btn-orient-prograde').disabled).toBe(false);

          helm.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies window blur event zeroes held keys, buttonRoll, active sticks, and emits zeroed helm_input', () => {
        const messages = [];
        const winListeners = {};
        const origWin = globalThis.window;
        const origDoc = globalThis.document;

        globalThis.window = {
          addEventListener: (ev, fn) => { winListeners[ev] = fn; },
          removeEventListener: vi.fn(),
        };
        globalThis.document = {
          getElementById: () => null,
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };

        try {
          const helm = new HelmController({
            send: (msg) => messages.push(msg),
          });

          // Set active keys, stick inputs, and button roll
          helm.keys.KeyW = true;
          helm.keys.KeyA = true;
          helm.buttonRoll = -1;
          helm.leftStickForward = 0.8;
          helm.rightStickTurn = -0.5;
          helm.recomputeState();
          helm.emitHelmInput();

          const lastActive = messages[messages.length - 1];
          expect(lastActive.rcsForward).toBe(1.0);
          expect(lastActive.turn).toBe(-1.0);
          expect(lastActive.roll).toBe(-1.0);

          // Fire window blur event
          expect(winListeners.blur).toBeDefined();
          winListeners.blur();

          expect(helm.keys.KeyW).toBe(false);
          expect(helm.keys.KeyA).toBe(false);
          expect(helm.buttonRoll).toBe(0);
          expect(helm.leftStickForward).toBe(0);
          expect(helm.rightStickTurn).toBe(0);
          expect(helm.state.rcsForward).toBe(0);
          expect(helm.state.turn).toBe(0);
          expect(helm.state.roll).toBe(0);

          const lastMsg = messages[messages.length - 1];
          expect(lastMsg.rcsForward).toBe(0);
          expect(lastMsg.turn).toBe(0);
          expect(lastMsg.roll).toBe(0);
          expect(lastMsg.strafe).toBe(0);
          expect(lastMsg.pitch).toBe(0);

          helm.destroy();
        } finally {
          globalThis.window = origWin;
          globalThis.document = origDoc;
        }
      });

      it('verifies btn-roll-port pointerdown -> pointerup -> synthetic click does not re-trigger buttonRoll = -1', () => {
        const messages = [];
        const btnListeners = {};
        const mockBtnPort = {
          addEventListener: (ev, fn) => { btnListeners[ev] = fn; },
          removeEventListener: vi.fn(),
          setPointerCapture: vi.fn(),
          releasePointerCapture: vi.fn(),
        };

        const origWin = globalThis.window;
        const origDoc = globalThis.document;

        globalThis.window = {
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };
        globalThis.document = {
          getElementById: (id) => (id === 'btn-roll-port' ? mockBtnPort : null),
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };

        try {
          const helm = new HelmController({
            send: (msg) => messages.push(msg),
          });

          // 1. pointerdown sets buttonRoll = -1 and emits roll: -1
          btnListeners['pointerdown']({ pointerId: 1, preventDefault: vi.fn() });
          expect(helm.buttonRoll).toBe(-1);
          expect(messages[messages.length - 1].roll).toBe(-1.0);
          expect(mockBtnPort.setPointerCapture).toHaveBeenCalledWith(1);

          // 2. pointerup clears buttonRoll = 0 and emits roll: 0
          btnListeners['pointerup']({ pointerId: 1, preventDefault: vi.fn() });
          expect(helm.buttonRoll).toBe(0);
          expect(messages[messages.length - 1].roll).toBe(0);
          expect(mockBtnPort.releasePointerCapture).toHaveBeenCalledWith(1);

          // 3. Synthetic click event that browsers fire after pointerup must NOT re-trigger roll
          const prevMsgCount = messages.length;
          btnListeners['click']({ preventDefault: vi.fn() });
          expect(helm.buttonRoll).toBe(0);
          expect(messages.length).toBe(prevMsgCount);
          expect(helm.state.roll).toBe(0);

          helm.destroy();
        } finally {
          globalThis.window = origWin;
          globalThis.document = origDoc;
        }
      });

      it('verifies thumbstick inputs within 0.12 radial deadzone produce 0 turn/pitch while larger deflections apply 1.5 power curve smoothly', () => {
        const messages = [];
        const stickRightListeners = {};
        const mockKnob = { style: {} };
        const mockStickRight = {
          querySelector: (sel) => (sel === '.stick-knob' ? mockKnob : null),
          getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 100 }), // center = (150, 150)
          addEventListener: (ev, fn) => { stickRightListeners[ev] = fn; },
          removeEventListener: vi.fn(),
        };

        const winListeners = {};
        const origWin = globalThis.window;
        const origDoc = globalThis.document;

        globalThis.window = {
          addEventListener: (ev, fn) => { winListeners[ev] = fn; },
          removeEventListener: vi.fn(),
        };
        globalThis.document = {
          getElementById: (id) => (id === 'stick-right-zone' ? mockStickRight : null),
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        };

        try {
          const helm = new HelmController({
            send: (msg) => messages.push(msg),
          });

          // 1. Deflection within 0.12 deadzone:
          // center is (150, 150), maxRadius is 50.
          // A displacement of 5px rightward is 5 / 50 = 0.10 (< 0.12)
          stickRightListeners['touchstart']({
            changedTouches: [{ identifier: 1, clientX: 155, clientY: 150 }],
            preventDefault: vi.fn(),
          });

          expect(helm.rightStickTurn).toBe(0);
          expect(helm.rightStickPitch).toBe(0);
          expect(helm.state.turn).toBe(0);
          expect(helm.state.pitch).toBe(0);
          expect(messages[messages.length - 1].turn).toBe(0);
          expect(messages[messages.length - 1].pitch).toBe(0);

          // 2. Deflection midway between deadzone (0.12) and max (1.0):
          // rawMag = 0.56 -> clientX = 150 + (0.56 * 50) = 178
          // rescaledMag = (0.56 - 0.12) / (1 - 0.12) = 0.44 / 0.88 = 0.50
          // with 1.5 power curve: curvedMag = 0.5^1.5 = 0.35355...
          winListeners['touchmove']({
            changedTouches: [{ identifier: 1, clientX: 178, clientY: 150 }],
            preventDefault: vi.fn(),
          });

          expect(helm.rightStickTurn).toBeCloseTo(Math.pow(0.5, 1.5), 3);
          expect(helm.rightStickPitch).toBe(0);
          expect(helm.state.turn).toBeCloseTo(Math.pow(0.5, 1.5), 3);
          expect(messages[messages.length - 1].turn).toBeCloseTo(Math.pow(0.5, 1.5), 3);

          // 3. Full deflection (rawMag >= 1.0):
          // clientX = 150 + 50 = 200 -> rawMag = 1.0
          // rescaledMag = 1.0, 1.0^1.5 = 1.0 -> full authority 100%
          winListeners['touchmove']({
            changedTouches: [{ identifier: 1, clientX: 200, clientY: 150 }],
            preventDefault: vi.fn(),
          });

          expect(helm.rightStickTurn).toBeCloseTo(1.0, 3);
          expect(helm.state.turn).toBeCloseTo(1.0, 3);
          expect(messages[messages.length - 1].turn).toBe(1.0);

          // 4. Combined turn and pitch with 1.5 power curve preserves direction
          // 45 degrees deflection: dx = 35.355, dy = 35.355 -> dist = 50 (rawMag = 1.0)
          winListeners['touchmove']({
            changedTouches: [{ identifier: 1, clientX: 150 + 35.355, clientY: 150 + 35.355 }],
            preventDefault: vi.fn(),
          });
          expect(helm.rightStickTurn).toBeCloseTo(Math.cos(Math.PI / 4), 3);
          expect(helm.rightStickPitch).toBeCloseTo(Math.sin(Math.PI / 4), 3);

          // 5. Clean auto-orient & turn-and-burn emission with zeroed turn and pitch
          helm.setAutoOrient('prograde');
          expect(messages[messages.length - 1]).toEqual(
            expect.objectContaining({
              type: 'helm_input',
              toggleAutoOrient: 'prograde',
              turn: 0,
              pitch: 0,
            })
          );

          helm.toggleTurnAndBurn();
          expect(messages[messages.length - 1]).toEqual(
            expect.objectContaining({
              type: 'helm_input',
              toggleTurnAndBurn: true,
              turn: 0,
              pitch: 0,
            })
          );

          helm.destroy();
        } finally {
          globalThis.window = origWin;
          globalThis.document = origDoc;
        }
      });

      it('verifies WeaponsController vertical pan keys and 3D aimPitch inclusion in weapons_input', () => {
        const messages = [];
        const weapons = new WeaponsController({
          send: (msg) => messages.push(msg),
        });

        // 1. Vertical look keys (KeyW / KeyS)
        weapons.handleKeyDown({ code: 'KeyW', preventDefault: () => {} });
        expect(weapons.lookKeys.KeyW).toBe(true);
        weapons.updateGunnerView(0.1, { omega: 0, weapons: { stabilizerHealth: 100 } });
        expect(weapons.gunnerPitchOffset).toBeGreaterThan(0);
        expect(weapons.getGunnerAimPitch()).toBeGreaterThan(-0.03);

        weapons.handleKeyUp({ code: 'KeyW', preventDefault: () => {} });
        expect(weapons.lookKeys.KeyW).toBe(false);

        weapons.handleKeyDown({ code: 'KeyS', preventDefault: () => {} });
        expect(weapons.lookKeys.KeyS).toBe(true);
        weapons.updateGunnerView(0.2, { omega: 0, weapons: { stabilizerHealth: 100 } });
        expect(weapons.gunnerPitchOffset).toBeLessThan(0);
        weapons.handleKeyUp({ code: 'KeyS', preventDefault: () => {} });

        // 2. aimPitch in weapons input for all weapon types
        weapons.aimPitch = 0.42;
        weapons.setLaserFiring(true);
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'weapons_input',
            fireLaser: true,
            aimPitch: 0.42,
          })
        );

        weapons.startRailgunCharge();
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'weapons_input',
            startRailgunCharge: true,
            aimPitch: 0.42,
          })
        );

        weapons.releaseRailgun();
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'weapons_input',
            releaseRailgun: true,
            aimPitch: 0.42,
          })
        );

        weapons.launchTorpedo();
        expect(messages[messages.length - 1]).toEqual(
          expect.objectContaining({
            type: 'weapons_input',
            launchTorpedo: true,
            aimPitch: 0.42,
          })
        );

        weapons.destroy();
      });
    });

    describe('Phase 12: Helm Yaw Signs & Flashing Alerts, Weapons Overheat & Charged Railgun HUD, Enemy Vector Masking & Engineer Drone Cards', () => {
      it('verifies Helm key and stick yaw signs (KeyA/ArrowLeft => -1, KeyD/ArrowRight => +1, right stick +X => +1)', () => {
        const messages = [];
        const helm = new HelmController({ send: (m) => messages.push(m) });

        // KeyA -> -1.0
        helm.keys.KeyA = true;
        helm.updateStateFromKeyboard();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBe(-1.0);
        helm.keys.KeyA = false;

        // ArrowLeft -> -1.0
        helm.keys.ArrowLeft = true;
        helm.updateStateFromKeyboard();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBe(-1.0);
        helm.keys.ArrowLeft = false;

        // KeyD -> +1.0
        helm.keys.KeyD = true;
        helm.updateStateFromKeyboard();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBe(1.0);
        helm.keys.KeyD = false;

        // ArrowRight -> +1.0
        helm.keys.ArrowRight = true;
        helm.updateStateFromKeyboard();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBe(1.0);
        helm.keys.ArrowRight = false;

        // Right virtual touch stick positive X => +1.0, negative X => -1.0
        helm.touchRight.active = true;
        helm.rightStickTurn = 0.85;
        helm.recomputeState();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBeCloseTo(0.85, 2);

        helm.rightStickTurn = -0.75;
        helm.recomputeState();
        helm.emitHelmInput();
        expect(messages[messages.length - 1].turn).toBeCloseTo(-0.75, 2);

        helm.destroy();
      });

      it('verifies Helm HUD flashing alerts for offline main drive, offline RCS, and gimbal fallback', () => {
        const mockElements = new Map();
        const makeEl = (id) => {
          const classes = new Set();
          const el = {
            id,
            textContent: '',
            style: {},
            classList: {
              add: (c) => classes.add(c),
              remove: (...cs) => cs.forEach((c) => classes.delete(c)),
              contains: (c) => classes.has(c),
            },
            querySelector: (sel) => {
              if (sel === '.stick-label') return el._label || (el._label = { textContent: '' });
              return null;
            },
          };
          mockElements.set(id, el);
          return el;
        };

        const ids = [
          'helm-throttle-panel', 'helm-throttle-slider',
          'stick-left-zone', 'stick-right-zone',
          'btn-orient-prograde', 'btn-orient-retrograde', 'btn-orient-target', 'btn-orient-anti-target',
          'btn-roll-port', 'btn-stop-roll', 'btn-roll-starboard',
          'rcs-bowPort', 'rcs-bowStarboard', 'rcs-sternPort', 'rcs-sternStarboard',
          'rcs-dorsalRoll', 'rcs-ventralRoll', 'rcs-bow-dorsal', 'rcs-bow-ventral', 'rcs-stern-dorsal', 'rcs-stern-ventral'
        ];
        ids.forEach(makeEl);

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => mockElements.get(id) || null,
          querySelector: (sel) => {
            if (sel.startsWith('#')) return mockElements.get(sel.slice(1)) || null;
            return null;
          },
        };

        try {
          const helm = new HelmController({ send: () => {} });

          // Case 1: Main Drive Offline -> #helm-throttle-panel alert-flash-red
          helm.updateHUD({
            mainDrive: { health: 0, throttle: 0, powered: false },
            powerMap: { main_drive: 0, rcs_thrusters: 1 },
            thrusters: {
              bowPort: { health: 100, powered: true },
              bowStarboard: { health: 100, powered: true },
              sternPort: { health: 100, powered: true },
              sternStarboard: { health: 100, powered: true },
            },
          });
          const throttlePanel = mockElements.get('helm-throttle-panel');
          expect(throttlePanel.classList.contains('alert-flash-red')).toBe(true);

          // Case 2: RCS Thrusters Offline, Main Drive powered with thrust (throttle = 0.6)
          // -> stick-left-zone alert-flash-red, stick-right-zone alert-flash-yellow & 'ROTATION (GIMBAL ONLY)'
          helm.updateHUD({
            mainDrive: { health: 100, throttle: 0.6, powered: true },
            powerMap: { main_drive: 1, rcs_thrusters: 0 },
            thrusters: {
              bowPort: { health: 0, powered: false },
              bowStarboard: { health: 0, powered: false },
              sternPort: { health: 0, powered: false },
              sternStarboard: { health: 0, powered: false },
            },
          });

          expect(mockElements.get('stick-left-zone').classList.contains('alert-flash-red')).toBe(true);
          expect(mockElements.get('btn-orient-prograde').classList.contains('alert-flash-red')).toBe(true);
          const stickRight = mockElements.get('stick-right-zone');
          expect(stickRight.classList.contains('alert-flash-yellow')).toBe(true);
          expect(stickRight.classList.contains('alert-flash-red')).toBe(false);
          expect(stickRight.querySelector('.stick-label').textContent).toBe('ROTATION (GIMBAL ONLY)');

          // Case 3: RCS Thrusters Offline, Main Drive has NO thrust (throttle = 0)
          // -> stick-right-zone alert-flash-red & 'ROTATION OFFLINE'
          helm.updateHUD({
            mainDrive: { health: 100, throttle: 0, powered: true },
            powerMap: { main_drive: 1, rcs_thrusters: 0 },
            thrusters: {
              bowPort: { health: 0, powered: false },
              bowStarboard: { health: 0, powered: false },
              sternPort: { health: 0, powered: false },
              sternStarboard: { health: 0, powered: false },
            },
          });
          expect(stickRight.classList.contains('alert-flash-red')).toBe(true);
          expect(stickRight.classList.contains('alert-flash-yellow')).toBe(false);
          expect(stickRight.querySelector('.stick-label').textContent).toBe('ROTATION OFFLINE');

          helm.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies Weapons HUD alerts for unpowered vs pre-charged railgun and overheated laser', () => {
        const mockElements = new Map();
        const makeEl = (id) => {
          const classes = new Set();
          const el = {
            id,
            textContent: '',
            className: '',
            style: {},
            classList: {
              add: (c) => classes.add(c),
              remove: (...cs) => cs.forEach((c) => classes.delete(c)),
              contains: (c) => classes.has(c),
            },
          };
          mockElements.set(id, el);
          return el;
        };

        const ids = [
          'laser-heat-bar', 'laser-heat-fill', 'laser-heat-text', 'btn-select-laser', 'weapon-row-laser',
          'railgun-charge-bar', 'railgun-charge-fill', 'btn-select-railgun', 'weapon-row-railgun',
          'railgun-slew-status', 'railgun-barrel-reticle', 'railgun-reticle-status'
        ];
        ids.forEach(makeEl);

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => mockElements.get(id) || null,
          querySelectorAll: () => [],
        };

        try {
          const weapons = new WeaponsController({ myTeam: 'alpha' });

          // 1. Unpowered uncharged railgun flashes red
          weapons.updateHUD({
            weapons: { chargeProgress: 0, railgunHealth: 100, railgunJammed: false },
            powerMap: { weapons_railgun: 0, weapons_laser: 1 },
          });
          const btnRailgun = mockElements.get('btn-select-railgun');
          const rowRailgun = mockElements.get('weapon-row-railgun');
          const reticleStatus = mockElements.get('railgun-reticle-status');
          expect(btnRailgun.classList.contains('alert-flash-red')).toBe(true);
          expect(btnRailgun.classList.contains('alert-flash-yellow')).toBe(false);
          expect(rowRailgun.classList.contains('alert-flash-red')).toBe(true);
          expect(reticleStatus.textContent).toBe('NO POWER');

          // 2. Unpowered pre-charged railgun (chargeProgress = 1.0) flashes yellow (not red)
          weapons.updateHUD({
            weapons: { chargeProgress: 1.0, railgunHealth: 100, railgunJammed: false },
            powerMap: { weapons_railgun: 0, weapons_laser: 1 },
          });
          expect(btnRailgun.classList.contains('alert-flash-yellow')).toBe(true);
          expect(btnRailgun.classList.contains('alert-flash-red')).toBe(false);
          expect(rowRailgun.classList.contains('alert-flash-yellow')).toBe(true);
          expect(rowRailgun.classList.contains('alert-flash-red')).toBe(false);
          expect(reticleStatus.textContent).toBe('CHARGED (NO PWR)');

          // 3. Overheated laser shows 'OVERHEATED (REDUCED RATE)' and alert-flash-yellow
          weapons.updateHUD({
            weapons: { overheated: true, heat: 100, maxHeat: 100, laserHealth: 100 },
            powerMap: { weapons_laser: 1, weapons_railgun: 1 },
          });
          const heatText = mockElements.get('laser-heat-text');
          const rowLaser = mockElements.get('weapon-row-laser');
          expect(heatText.textContent).toBe('OVERHEATED (REDUCED RATE)');
          expect(rowLaser.classList.contains('alert-flash-yellow')).toBe(true);
          expect(rowLaser.classList.contains('alert-flash-red')).toBe(false);

          weapons.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies Enemy Vector HUD renders telemetry when tracking and masks to SIGNAL OBSCURED / NEBULA when obscured', () => {
        const mockElements = new Map();
        const makeEl = (id) => {
          const classes = new Set();
          const el = {
            id,
            textContent: '',
            style: {},
            classList: {
              add: (c) => classes.add(c),
              remove: (...cs) => cs.forEach((c) => classes.delete(c)),
              contains: (c) => classes.has(c),
            },
            querySelector: (sel) => {
              if (sel === '.enemy-vector-status') return el._status || (el._status = { textContent: '' });
              if (sel === '.enemy-vector-bearing') return el._bearing || (el._bearing = { textContent: '' });
              if (sel === '.enemy-vector-velocity') return el._vel || (el._vel = { textContent: '' });
              if (sel === '.enemy-vector-arrow' || sel === '.edge-arrow-icon') return el._arrow || (el._arrow = { style: {} });
              return null;
            },
          };
          mockElements.set(id, el);
          return el;
        };

        [
          'helm-enemy-vector', 'helm-enemy-status', 'helm-enemy-arrow', 'helm-enemy-bearing', 'helm-enemy-velocity',
          'weapons-enemy-vector', 'weapons-enemy-status', 'weapons-enemy-arrow', 'weapons-enemy-bearing', 'weapons-enemy-velocity',
        ].forEach(makeEl);

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => mockElements.get(id) || null,
          querySelectorAll: () => [],
        };

        try {
          const helm = new HelmController({ send: () => {} });
          const weapons = new WeaponsController({ myTeam: 'alpha' });

          const ship = {
            pos: { x: 0, y: 0, z: 0 },
            vel: { x: 0, y: 0, z: 0 },
            angle: 0,
          };
          const enemyTracking = {
            pos: { x: 800, y: 600, z: 100 },
            vel: { x: 50, y: 0, z: 0 },
            destroyed: false,
            targetAvailable: true,
            enemyKnown: true,
            inNebula: false,
          };

          // 1. Nominal tracking in Helm HUD
          helm.updateEnemyVector(ship, enemyTracking);
          const helmCard = mockElements.get('helm-enemy-vector');
          expect(helmCard.classList.contains('obscured')).toBe(false);
          expect(mockElements.get('helm-enemy-status').textContent).toBe('TRACKING');
          expect(mockElements.get('helm-enemy-bearing').textContent).toContain('RNG 1005m');
          expect(mockElements.get('helm-enemy-arrow').style.transform).toMatch(/rotate\(\d+(\.\d+)?deg\)/);

          // 2. Obscured / Nebula masking in Weapons HUD
          const enemyObscured = {
            ...enemyTracking,
            inNebula: true,
            targetAvailable: false,
          };
          weapons.updateEnemyVector(ship, enemyObscured);
          const weapCard = mockElements.get('weapons-enemy-vector');
          expect(weapCard.classList.contains('obscured')).toBe(true);
          expect(mockElements.get('weapons-enemy-status').textContent).toBe('SIGNAL OBSCURED / NEBULA');
          expect(mockElements.get('weapons-enemy-bearing').textContent).toBe('BRG ---° | ELV --° | RNG ----m');
          expect(mockElements.get('weapons-enemy-velocity').textContent).toBe('VEL --- m/s | HDG ---° | CLS --- m/s');

          helm.destroy();
          weapons.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies Engineer renderDroneCards preserves DOM node identity across updates, renders disabled RECALLING button, and dispatches recall', () => {
        const cardsMap = new Map();
        const mockContainer = {
          innerHTML: '',
          _children: [],
          appendChild(child) {
            this._children.push(child);
            if (child.dataset?.droneId) cardsMap.set(child.dataset.droneId, child);
            return child;
          },
          querySelector(sel) {
            const match = sel.match(/\[data-drone-id="(\d+)"\]/);
            if (match) return cardsMap.get(match[1]) || null;
            if (sel === '.empty-drones') return this._children.find(c => c.className?.includes('empty-drones')) || null;
            return null;
          },
          querySelectorAll(sel) {
            if (sel.includes('.drone-card')) return Array.from(cardsMap.values());
            return [];
          },
        };

        const origDoc = globalThis.document;
        globalThis.document = {
          getElementById: (id) => (id === 'drone-list-container' ? mockContainer : null),
          querySelectorAll: (sel) => {
            if (sel.includes('.drone-card')) return Array.from(cardsMap.values());
            return [];
          },
          createElement: (tag) => {
            const classes = new Set();
            const node = {
              tagName: tag.toUpperCase(),
              type: '',
              dataset: {},
              textContent: '',
              disabled: false,
              style: {},
              _children: [],
              classList: {
                add: (...cs) => cs.forEach(c => classes.add(c)),
                remove: (...cs) => cs.forEach(c => classes.delete(c)),
                contains: (c) => classes.has(c),
              },
              get className() { return Array.from(classes).join(' '); },
              set className(val) {
                classes.clear();
                val.split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
              },
              appendChild(child) {
                this._children.push(child);
                return child;
              },
              querySelector(sel) {
                if (sel === '.drone-title' || sel === '.drone-id') return this._children.find(c => c.className?.includes('drone-id') || c.className?.includes('drone-title')) || null;
                if (sel === '.drone-status-pill' || sel === '.drone-status-tag') return this._children.find(c => c.className?.includes('drone-status')) || null;
                if (sel === '.drone-target-label' || sel === '.d-val') {
                  for (const ch of this._children) {
                    if (ch.className?.includes('d-val') || ch.className?.includes('drone-target-label')) return ch;
                    const found = ch.querySelector?.(sel);
                    if (found) return found;
                  }
                }
                if (sel === '.drone-card-actions') return this._children.find(c => c.className?.includes('drone-card-actions')) || null;
                if (sel === '.btn-recall-drone') {
                  for (const ch of this._children) {
                    if (ch.className?.includes('btn-recall-drone')) return ch;
                    const found = ch.querySelector?.(sel);
                    if (found) return found;
                  }
                }
                return null;
              },
            };
            return node;
          },
        };

        const messages = [];
        try {
          const engineer = new EngineerController({ send: (m) => messages.push(m) });

          // Initial render with drone in moving state
          engineer.drones = [
            { id: 1, state: 'moving', targetType: 'tile', target: { row: 5, col: 5 }, stalled: false },
          ];
          engineer.renderDroneCards();

          const card1 = mockContainer.querySelector('.drone-card[data-drone-id="1"]');
          expect(card1).toBeDefined();
          const initialBtn = card1.querySelector('.btn-recall-drone');
          expect(initialBtn).toBeDefined();
          expect(initialBtn.textContent).toBe('RECALL');
          expect(initialBtn.disabled).toBe(false);

          // Update with drone in returning state (persisting same DOM node identity)
          engineer.drones = [
            { id: 1, state: 'returning', targetType: null, target: null, stalled: false },
          ];
          engineer.renderDroneCards();

          const secondBtn = card1.querySelector('.btn-recall-drone');
          expect(secondBtn).toBe(initialBtn); // Node identity strictly preserved!
          expect(secondBtn.textContent).toBe('RECALLING');
          expect(secondBtn.disabled).toBe(true);
          expect(secondBtn.classList.contains('recalling')).toBe(true);

          // Transition back to repairing state
          engineer.drones = [
            { id: 1, state: 'repairing', targetType: 'subsystem', target: 'weapons_laser', stalled: false },
          ];
          engineer.renderDroneCards();
          expect(secondBtn.textContent).toBe('RECALL');
          expect(secondBtn.disabled).toBe(false);

          // Call recallDrone(1)
          engineer.recallDrone(1);
          expect(messages[messages.length - 1]).toEqual(
            expect.objectContaining({
              action: 'recall_drone',
              droneId: 1,
            })
          );

          engineer.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies Phase 13 Slice 4: public/index.html includes PWR-03 boost panel and all 10 perimeter buttons with zero decorative emojis', () => {
        const htmlPath = path.join(publicDir, 'index.html');
        const html = fs.readFileSync(htmlPath, 'utf8');

        // Check grid tip mentions BOOST and 120%
        expect(html).toContain('grid-controls-tip');
        expect(html).toMatch(/BOOST.*120%/i);

        // Check PWR-03 card presence
        expect(html).toContain('id="eng-system-boost-panel"');
        expect(html).toContain('PWR-03');
        expect(html).toContain('SYSTEM POWER & BOOST');
        expect(html).toContain('id="eng-system-boost-list"');

        // Extract PWR-03 panel HTML for emoji inspection
        const panelStart = html.indexOf('id="eng-system-boost-panel"');
        const panelEnd = html.indexOf('<!-- Repair Drone Fleet Cards -->', panelStart);
        expect(panelStart).toBeGreaterThan(0);
        expect(panelEnd).toBeGreaterThan(panelStart);
        const panelHtml = html.substring(panelStart, panelEnd);

        // Verify zero decorative emojis in PWR-03 panel (Rule #29)
        const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
        expect(panelHtml).not.toMatch(emojiRegex);

        // Verify all 10 perimeter subsystems are pre-populated with exact matching labels
        for (const sys of EXTERNAL_SYSTEMS) {
          const rowRegex = new RegExp(`class="system-boost-row"[^>]*data-subsystem="${sys.key}"`);
          expect(html).toMatch(rowRegex);

          const btnRegex = new RegExp(`class="btn-boost-system"[^>]*data-subsystem="${sys.key}"[^>]*>BOOST<\\/button>`);
          expect(html).toMatch(btnRegex);

          const expectedLabel = SUBSYSTEM_LABELS[sys.key];
          expect(expectedLabel).toBeDefined();
          expect(panelHtml).toContain(expectedLabel);
        }
      });

      it('verifies Phase 13 Slice 4: EngineerController.toggleSystemBoost sends toggle_boost action and plays sound', () => {
        const messages = [];
        const soundMock = {
          playBreakerToggle: vi.fn(),
        };
        const engineer = new EngineerController({
          send: (m) => messages.push(m),
          sound: soundMock,
        });

        engineer.toggleSystemBoost('weapons_laser');

        expect(messages.length).toBe(1);
        expect(messages[0]).toEqual({
          type: 'engineer_input',
          action: 'toggle_boost',
          actionType: 'toggle_boost',
          subsystemKey: 'weapons_laser',
        });
        expect(soundMock.playBreakerToggle).toHaveBeenCalledTimes(1);

        // Also test another subsystem
        engineer.toggleSystemBoost('shields_fore');
        expect(messages[1]).toEqual({
          type: 'engineer_input',
          action: 'toggle_boost',
          actionType: 'toggle_boost',
          subsystemKey: 'shields_fore',
        });

        engineer.destroy();
      });

      it('verifies Phase 13 Slice 4: renderSystemBoostList updates rows to 120% / BOOST ON / .boosted and preserves DOM node identity', () => {
        const origDoc = globalThis.document;

        function createMockNode(tag) {
          const classes = new Set();
          const attributes = {};
          const node = {
            tagName: tag.toUpperCase(),
            type: tag === 'button' ? 'button' : '',
            dataset: {},
            textContent: '',
            disabled: false,
            style: {},
            _children: [],
            classList: {
              add: (...cs) => cs.forEach(c => classes.add(c)),
              remove: (...cs) => cs.forEach(c => classes.delete(c)),
              contains: (c) => classes.has(c),
            },
            get className() { return Array.from(classes).join(' '); },
            set className(val) {
              classes.clear();
              (val || '').split(/\s+/).filter(Boolean).forEach(c => classes.add(c));
            },
            setAttribute(name, val) {
              attributes[name] = String(val);
            },
            getAttribute(name) {
              return attributes[name] ?? null;
            },
            appendChild(child) {
              this._children.push(child);
              return child;
            },
            get children() {
              return this._children;
            },
            querySelector(sel) {
              if (sel.startsWith('.system-boost-row[data-subsystem="')) {
                const key = sel.match(/data-subsystem="([^"]+)"/)?.[1];
                return this._children.find(c => c.dataset?.subsystem === key) || null;
              }
              if (sel === '.sys-boost-name') {
                for (const ch of this._children) {
                  if (ch.className?.includes('sys-boost-name')) return ch;
                  const found = ch.querySelector?.(sel);
                  if (found) return found;
                }
              }
              if (sel === '.sys-pwr-val') {
                for (const ch of this._children) {
                  if (ch.className?.includes('sys-pwr-val')) return ch;
                  const found = ch.querySelector?.(sel);
                  if (found) return found;
                }
              }
              if (sel === '.sys-col-val') {
                for (const ch of this._children) {
                  if (ch.className?.includes('sys-col-val')) return ch;
                  const found = ch.querySelector?.(sel);
                  if (found) return found;
                }
              }
              if (sel === '.btn-boost-system') {
                for (const ch of this._children) {
                  if (ch.className?.includes('btn-boost-system')) return ch;
                  const found = ch.querySelector?.(sel);
                  if (found) return found;
                }
              }
              return null;
            },
          };
          return node;
        }

        const mockBoostContainer = createMockNode('div');
        mockBoostContainer.id = 'eng-system-boost-list';

        // Pre-populate container matching public/index.html structure
        for (const sys of EXTERNAL_SYSTEMS) {
          const row = createMockNode('div');
          row.className = 'system-boost-row';
          row.dataset.subsystem = sys.key;

          const meta = createMockNode('div');
          meta.className = 'sys-boost-meta';

          const name = createMockNode('span');
          name.className = 'sys-boost-name';
          name.textContent = SUBSYSTEM_LABELS[sys.key];

          const readouts = createMockNode('span');
          readouts.className = 'sys-boost-readouts';

          const pwrVal = createMockNode('span');
          pwrVal.className = 'sys-pwr-val';
          pwrVal.textContent = 'P:73%';

          const colVal = createMockNode('span');
          colVal.className = 'sys-col-val';
          colVal.textContent = 'C:73%';

          readouts.appendChild(pwrVal);
          readouts.appendChild(colVal);
          meta.appendChild(name);
          meta.appendChild(readouts);

          const btn = createMockNode('button');
          btn.className = 'btn-boost-system';
          btn.dataset.subsystem = sys.key;
          btn.setAttribute('aria-pressed', 'false');
          btn.textContent = 'BOOST';

          row.appendChild(meta);
          row.appendChild(btn);
          mockBoostContainer.appendChild(row);
        }

        globalThis.document = {
          getElementById(id) {
            if (id === 'eng-system-boost-list') return mockBoostContainer;
            return null;
          },
          querySelectorAll(sel) {
            return [];
          },
          createElement(tag) {
            return createMockNode(tag);
          },
        };

        try {
          const engineer = new EngineerController({ send: () => {} });

          // Capture initial button references
          const laserRow = mockBoostContainer.querySelector('.system-boost-row[data-subsystem="weapons_laser"]');
          expect(laserRow).toBeDefined();
          const initialLaserBtn = laserRow.querySelector('.btn-boost-system');
          expect(initialLaserBtn).toBeDefined();
          expect(initialLaserBtn.textContent).toBe('BOOST');
          expect(initialLaserBtn.getAttribute('aria-pressed')).toBe('false');

          const foreRow = mockBoostContainer.querySelector('.system-boost-row[data-subsystem="shields_fore"]');
          expect(foreRow).toBeDefined();
          const initialForeBtn = foreRow.querySelector('.btn-boost-system');
          expect(initialForeBtn).toBeDefined();

          // 1. Tick 1: Boost weapons_laser to 120%
          engineer.updateHUD({
            grid: {
              boostedSystems: ['weapons_laser'],
            },
            powerMap: {
              weapons_laser: 1.2,
              shields_fore: 8 / 11,
              coolantMap: {
                weapons_laser: 1.2,
                shields_fore: 8 / 11,
              },
            },
          });

          // Verify laser row is boosted
          expect(laserRow.classList.contains('boosted')).toBe(true);
          expect(initialLaserBtn.textContent).toBe('BOOST ON');
          expect(initialLaserBtn.getAttribute('aria-pressed')).toBe('true');
          expect(initialLaserBtn.classList.contains('active')).toBe(true);

          const laserPwr = laserRow.querySelector('.sys-pwr-val');
          expect(laserPwr.textContent).toBe('P:120%');
          expect(laserPwr.classList.contains('boosted')).toBe(true);

          const laserCol = laserRow.querySelector('.sys-col-val');
          expect(laserCol.textContent).toBe('C:120%');
          expect(laserCol.classList.contains('boosted')).toBe(true);

          // Verify shields_fore is nominal (unboosted 80%)
          expect(foreRow.classList.contains('boosted')).toBe(false);
          expect(initialForeBtn.textContent).toBe('BOOST');
          expect(initialForeBtn.getAttribute('aria-pressed')).toBe('false');

          // 2. Tick 2: Boost shields_fore as well
          engineer.updateHUD({
            grid: {
              boostedSystems: ['weapons_laser', 'shields_fore'],
            },
            powerMap: {
              weapons_laser: 1.2,
              shields_fore: 1.2,
              coolantMap: {
                weapons_laser: 1.2,
                shields_fore: 1.2,
              },
            },
          });

          // Check strict DOM node identity preservation across ticks!
          const secondLaserBtn = laserRow.querySelector('.btn-boost-system');
          expect(secondLaserBtn).toBe(initialLaserBtn);
          const secondForeBtn = foreRow.querySelector('.btn-boost-system');
          expect(secondForeBtn).toBe(initialForeBtn);

          expect(foreRow.classList.contains('boosted')).toBe(true);
          expect(initialForeBtn.textContent).toBe('BOOST ON');
          expect(initialForeBtn.getAttribute('aria-pressed')).toBe('true');

          // 3. Tick 3: Turn boost off for weapons_laser
          engineer.updateHUD({
            grid: {
              boostedSystems: ['shields_fore'],
            },
            powerMap: {
              weapons_laser: 8 / 11,
              shields_fore: 1.2,
              coolantMap: {
                weapons_laser: 8 / 11,
                shields_fore: 1.2,
              },
            },
          });

          const thirdLaserBtn = laserRow.querySelector('.btn-boost-system');
          expect(thirdLaserBtn).toBe(initialLaserBtn);
          expect(initialLaserBtn.textContent).toBe('BOOST');
          expect(initialLaserBtn.getAttribute('aria-pressed')).toBe('false');
          expect(laserRow.classList.contains('boosted')).toBe(false);
          expect(laserPwr.textContent).toBe('P:73%');
          expect(laserPwr.classList.contains('nominal')).toBe(true);

          engineer.destroy();
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('verifies Phase 13 Slice 4: drawPerimeterSystems renders boosted 1.20 values and amber indicators cleanly without throwing', () => {
        const textCalls = [];
        const fillStyles = [];
        const strokeStyles = [];

        const mockCtx = {
          font: '',
          textAlign: '',
          textBaseline: '',
          lineWidth: 1,
          get fillStyle() { return fillStyles[fillStyles.length - 1] || ''; },
          set fillStyle(val) { fillStyles.push(val); },
          get strokeStyle() { return strokeStyles[strokeStyles.length - 1] || ''; },
          set strokeStyle(val) { strokeStyles.push(val); },
          fillRect: vi.fn(),
          strokeRect: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          stroke: vi.fn(),
          fillText: vi.fn((text, x, y) => {
            textCalls.push({ text, x, y });
          }),
        };

        const engineer = new EngineerController({ send: () => {} });
        engineer.grid = {
          boostedSystems: ['weapons_laser', 'shields_fore'],
        };
        engineer.powerMap = {
          weapons_laser: 1.2,
          shields_fore: 1.2,
          sas_computer: 0,
          coolantMap: {
            weapons_laser: 1.2,
            shields_fore: 1.2,
            sas_computer: 0,
          },
        };

        expect(() => engineer.drawPerimeterSystems(mockCtx)).not.toThrow();

        // Check BOOST text tag rendered
        const boostTags = textCalls.filter(c => c.text === 'BOOST');
        expect(boostTags.length).toBe(2);

        // Check 120% power and coolant text rendered
        const pwr120 = textCalls.filter(c => c.text === 'PWR 120%');
        expect(pwr120.length).toBe(2);

        const col120 = textCalls.filter(c => c.text === 'COL 120%');
        expect(col120.length).toBe(2);

        // Check amber overcharge colors used
        expect(fillStyles).toContain('#f59e0b');
        expect(fillStyles).toContain('#fbbf24');
        expect(strokeStyles).toContain('#f59e0b');

        engineer.destroy();
      });

      it('verifies Phase 13 Slice 4: WeaponsController.updateGunnerView scales stabilizer efficiency up to 1.2 when sas_computer is boosted', () => {
        const weapons = new WeaponsController({ send: () => {} });

        // Nominal 1.0 power
        weapons.viewPerturbation = 1.0;
        weapons.updateGunnerView(0.05, {
          omega: 0,
          rollOmega: 0,
          weapons: { stabilizerHealth: 100, stabilizerPower: 1.0 },
        });
        const nominalPerturbation = weapons.viewPerturbation;

        // Boosted 1.2 power (20% faster recentering / tighter stabilization)
        weapons.viewPerturbation = 1.0;
        weapons.updateGunnerView(0.05, {
          omega: 0,
          rollOmega: 0,
          weapons: { stabilizerHealth: 100, stabilizerPower: 1.2 },
        });
        const boostedPerturbation = weapons.viewPerturbation;

        // Boosted recentering should damp down closer to 0 than nominal
        expect(boostedPerturbation).toBeLessThan(nominalPerturbation);

        // Also test fallback to ship.powerMap.sas_computer
        weapons.viewPerturbation = 1.0;
        weapons.updateGunnerView(0.05, {
          omega: 0,
          rollOmega: 0,
          powerMap: { sas_computer: 1.2 },
        });
        expect(weapons.viewPerturbation).toBeCloseTo(boostedPerturbation, 4);

        weapons.destroy();
      });
    });
  });
});

describe('Express Server Static Asset Delivery', () => {
  let appServer = null;
  let serverPort = 0;

  beforeAll(async () => {
    // Start Express server on ephemeral port (port: 0)
    appServer = createAppServer({
      port: 0,
      listen: true,
      autoStartLoop: false,
    });

    await new Promise((resolve) => {
      if (appServer.server.listening) {
        serverPort = appServer.server.address().port;
        resolve();
      } else {
        appServer.server.on('listening', () => {
          serverPort = appServer.server.address().port;
          resolve();
        });
      }
    });
  });

  afterAll(async () => {
    if (appServer && appServer.close) {
      await appServer.close();
    }
  });

  it('serves GET / (index.html) with HTTP 200', async () => {
    const res = await fetchGet(serverPort, '/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('BROADSIDE HYPERION');
    expect(res.body).toContain('width="760" height="760"');
    expect(res.body).toContain('id="eng-coolant-share"');
    expect(res.body).toContain('CAPACITOR BATTERIES (+2.0 POOL SURGE)');
  });

  it('serves GET /spectate with HTTP 200 without top bar/sidebars and with Victor overlay', async () => {
    const res = await fetchGet(serverPort, '/spectate');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Cinematic Spectator View');
    expect(res.body).not.toContain('id="spectate-top-bar"');
    expect(res.body).not.toContain('id="spectate-alpha-panel"');
    expect(res.body).not.toContain('id="spectate-omega-panel"');
    expect(res.body).toContain('id="spectate-match-status"');
    expect(res.body).toContain('id="btn-spectate-start"');
    expect(res.body).toContain('id="spectate-victor-overlay"');
  });

  it('serves GET /api/music with HTTP 200, returning tracks list and valid audio assets', async () => {
    const res = await fetchGet(serverPort, '/api/music');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(Array.isArray(data.tracks)).toBe(true);
    expect(data.tracks.length).toBe(4);
    expect(data.tracks).toEqual([
      '/music/Deep%20Space%20Fanfare%202.mp3',
      '/music/Deep%20Space%20Fanfare.mp3',
      '/music/Deep%20Space%20Ostinato.mp3',
      '/music/Deep%20Space%20Pulse.mp3',
    ]);
    for (const trackUrl of data.tracks) {
      const trackRes = await fetchGet(serverPort, trackUrl);
      expect(trackRes.statusCode).toBe(200);
    }
  });

  it('serves GET /vendor/three.module.js with HTTP 200 for browser three importmap', async () => {
    const res = await fetchGet(serverPort, '/vendor/three.module.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('THREE');
  });

  it('serves GET /js/main.js with HTTP 200', async () => {
    const res = await fetchGet(serverPort, '/js/main.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('BroadsideClient');
  });

  it('serves GET /js/controls-helm.js with HTTP 200', async () => {
    const res = await fetchGet(serverPort, '/js/controls-helm.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('HelmController');
  });

  it('serves GET /js/controls-weapons.js with HTTP 200', async () => {
    const res = await fetchGet(serverPort, '/js/controls-weapons.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('WeaponsController');
  });

  it('serves GET /js/controls-engineer.js with HTTP 200', async () => {
    const res = await fetchGet(serverPort, '/js/controls-engineer.js');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('EngineerController');
  });

  it('serves GET /api/health with status ok', async () => {
    const res = await fetchGet(serverPort, '/api/health');
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.status).toBe('ok');
  });

  it('serves GET /css/style.css with HTTP 200 once authored by Slice 5A', async () => {
    const stylePath = path.join(publicDir, 'css/style.css');
    if (fs.existsSync(stylePath)) {
      const res = await fetchGet(serverPort, '/css/style.css');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('#engineer-grid-canvas');
      expect(res.body).toContain('aspect-ratio: 1 / 1');
    }
  });

  describe('Phase 14 Slice 3: All-Player Replay Mode & Flashing Battle Outcome Banners', () => {
    it('verifies public/index.html includes replay HUD banner and battle outcome overlay with zero decorative emojis, and public/css/style.css defines replay-mode and flashing keyframes', () => {
      const htmlPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // Check replay HUD banner elements
      expect(html).toContain('id="replay-hud-banner"');
      expect(html).toContain('class="replay-hud-banner hidden"');
      expect(html).toContain('replay-banner-label');
      expect(html).toContain('INSTANT REPLAY — FINAL IMPACT');
      expect(html).toContain('id="replay-progress-track"');
      expect(html).toContain('id="replay-progress-fill"');

      // Check battle outcome overlay elements
      expect(html).toContain('id="battle-outcome-overlay"');
      expect(html).toContain('class="battle-outcome-overlay hidden"');
      expect(html).toContain('id="battle-outcome-banner"');
      expect(html).toContain('id="battle-outcome-kicker"');
      expect(html).toContain('COMBAT ACTION CONCLUDED');
      expect(html).toContain('id="battle-outcome-title"');
      expect(html).toContain('id="battle-outcome-subtitle"');
      expect(html).toContain('id="btn-outcome-rematch"');
      expect(html).toContain('id="btn-outcome-drydock"');
      expect(html).toContain('PLAY AGAIN');
      expect(html).toContain('DRYDOCK / ROLES');

      // Verify zero decorative emojis in both elements (Rule #29)
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      const replayStart = html.indexOf('id="replay-hud-banner"');
      const outcomeEnd = html.indexOf('</main>', replayStart);
      const replayOutcomeHtml = html.substring(replayStart, outcomeEnd);
      expect(replayOutcomeHtml).not.toMatch(emojiRegex);

      // Check CSS rules
      const cssPath = path.join(publicDir, 'css/style.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      // Replay mode hides station consoles, enemy edge indicator, and pregame banner
      expect(css).toMatch(/body\.replay-mode\s+\.station-console/);
      expect(css).toMatch(/body\.replay-mode\s+#enemy-edge-indicator/);
      expect(css).toMatch(/body\.replay-mode\s+#pregame-station-banner/);
      expect(css).toContain('display: none !important');

      // Flashing animation keyframes & classes
      expect(css).toContain('@keyframes outcomeFlashVictor');
      expect(css).toContain('@keyframes outcomeFlashDestroyed');
      expect(css).toContain('.outcome-victorious');
      expect(css).toContain('.outcome-destroyed');
      expect(css).toContain('.outcome-draw');
    });

    it('verifies BroadsideClient enables replay mode across Helm/Weapons/Engineer, deactivates controllers, and deduplicates replayFrame events/audio', () => {
      const makeClassList = (initial = []) => {
        const classes = new Set(initial);
        return {
          add: (...cs) => cs.forEach(c => classes.add(c)),
          remove: (...cs) => cs.forEach(c => classes.delete(c)),
          toggle: (c, force) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
          contains: (c) => classes.has(c),
        };
      };

      const makeMockEl = (classes = [], extra = {}) => ({
        classList: makeClassList(classes),
        style: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...extra,
      });

      const bodyClassList = makeClassList();
      const mockElements = {
        'replay-hud-banner': makeMockEl(['replay-hud-banner', 'hidden']),
        'replay-progress-fill': makeMockEl([], { style: { width: '0%' } }),
        'battle-outcome-overlay': makeMockEl(['battle-outcome-overlay', 'hidden']),
        'battle-outcome-title': makeMockEl([], { textContent: '' }),
        'battle-outcome-subtitle': makeMockEl([], { textContent: '' }),
        'btn-outcome-rematch': makeMockEl(['outcome-btn']),
        'btn-outcome-drydock': makeMockEl(['outcome-btn']),
        'pregame-station-banner': makeMockEl(['pregame-station-banner']),
        'pregame-banner-text': makeMockEl([], { textContent: '' }),
        'btn-bridge-launch': makeMockEl([], { textContent: '' }),
        'lobby-overlay': makeMockEl(['modal-overlay'], { style: { display: 'none' } }),
      };

      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      globalThis.document = {
        body: { classList: bodyClassList },
        getElementById: (id) => mockElements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: null,
        addEventListener: () => {},
      };

      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: () => {},
          removeEventListener: () => {},
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      }

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        client.team = 'alpha';
        client.station = 'helm';

        const helmSpy = vi.fn();
        const weaponsSpy = vi.fn();
        const engSpy = vi.fn();
        client.helm = { setActive: helmSpy, updateHUD: vi.fn(), destroy: vi.fn() };
        client.weapons = { setActive: weaponsSpy, updateHUD: vi.fn(), destroy: vi.fn() };
        client.engineer = { setActive: engSpy, updateHUD: vi.fn(), destroy: vi.fn() };

        // Audio spies
        const zapSpy = vi.spyOn(client.sound, 'playLaserZap');
        const railSpy = vi.spyOn(client.sound, 'playRailgunFire');

        // Create replay snapshot (frame 0)
        const replaySnapshot = {
          state: 'gameover',
          winner: 'alpha',
          replayActive: true,
          replayComplete: false,
          replayProgress: 0.45,
          replayFrame: {
            frameIndex: 0,
            tick: 120,
            slowMoActive: true,
            ships: {
              alpha: { pos: { x: -100, y: 0, z: 0 }, hullHp: 800, maxHullHp: 1000 },
              omega: { pos: { x: 100, y: 0, z: 0 }, hullHp: 0, maxHullHp: 1000 },
            },
            projectiles: [{ id: 'p1', type: 'railgun' }],
            destroyedAsteroidIds: [1, 2],
            events: [
              { type: 'laser_fired' },
              { type: 'railgun_fired' },
            ],
          },
          sector: {
            asteroids: [
              { id: 1, destroyed: false },
              { id: 3, destroyed: false },
            ],
          },
        };

        // Ingest snapshot 1st time
        client.handleSnapshot(replaySnapshot);

        // Body has .replay-mode class
        expect(bodyClassList.contains('replay-mode')).toBe(true);

        // #replay-hud-banner is visible and progress fill updated
        expect(mockElements['replay-hud-banner'].classList.contains('hidden')).toBe(false);
        expect(mockElements['replay-progress-fill'].style.width).toBe('45%');

        // Battle outcome overlay must stay hidden during active replay
        expect(mockElements['battle-outcome-overlay'].classList.contains('hidden')).toBe(true);

        // Controllers must be deactivated
        expect(helmSpy).toHaveBeenLastCalledWith(false);
        expect(weaponsSpy).toHaveBeenLastCalledWith(false);
        expect(engSpy).toHaveBeenLastCalledWith(false);

        // Audio events fired once
        expect(zapSpy).toHaveBeenCalledTimes(1);
        expect(railSpy).toHaveBeenCalledTimes(1);

        // Ingest same frameIndex: 0 a second time — audio must NOT re-fire (deduplication)
        client.handleSnapshot(replaySnapshot);
        expect(zapSpy).toHaveBeenCalledTimes(1);
        expect(railSpy).toHaveBeenCalledTimes(1);

        // Test buildReplayRenderSnapshot deduplicates events across 60FPS RAF calls
        const snapClone1 = client.buildReplayRenderSnapshot(replaySnapshot);
        expect(snapClone1.events.length).toBe(2);
        // Non-destructive asteroid mapping
        expect(snapClone1.sector.asteroids.find(a => a.id === 1).destroyed).toBe(true);
        expect(snapClone1.sector.asteroids.find(a => a.id === 3).destroyed).toBe(false);

        // Second RAF call on same frameIndex: events should be empty
        const snapClone2 = client.buildReplayRenderSnapshot(replaySnapshot);
        expect(snapClone2.events.length).toBe(0);

        // When new frameIndex arrives, audio fires again
        const replaySnapshotFrame1 = {
          ...replaySnapshot,
          replayProgress: 0.90,
          replayFrame: {
            ...replaySnapshot.replayFrame,
            frameIndex: 1,
            events: [{ type: 'laser_fired' }],
          },
        };
        client.handleSnapshot(replaySnapshotFrame1);
        expect(zapSpy).toHaveBeenCalledTimes(2);
        expect(mockElements['replay-progress-fill'].style.width).toBe('90%');

        client.destroy();
        expect(bodyClassList.contains('replay-mode')).toBe(false);
      } finally {
        globalThis.document = origDoc;
        if (!origWin) delete globalThis.window;
        else globalThis.window = origWin;
      }
    });

    it('verifies BroadsideClient displays exact Victorious / Destroyed banners upon battle conclusion and hides them in playing/lobby', () => {
      const makeClassList = (initial = []) => {
        const classes = new Set(initial);
        return {
          add: (...cs) => cs.forEach(c => classes.add(c)),
          remove: (...cs) => cs.forEach(c => classes.delete(c)),
          toggle: (c, force) => {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c);
              else classes.add(c);
            } else if (force) classes.add(c);
            else classes.delete(c);
          },
          contains: (c) => classes.has(c),
        };
      };

      const makeMockEl = (classes = [], extra = {}) => ({
        classList: makeClassList(classes),
        style: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...extra,
      });

      const bodyClassList = makeClassList();
      const mockElements = {
        'replay-hud-banner': makeMockEl(['replay-hud-banner', 'hidden']),
        'replay-progress-fill': makeMockEl([], { style: { width: '0%' } }),
        'battle-outcome-overlay': makeMockEl(['battle-outcome-overlay', 'hidden']),
        'battle-outcome-title': makeMockEl([], { textContent: '' }),
        'battle-outcome-subtitle': makeMockEl([], { textContent: '' }),
        'btn-outcome-rematch': makeMockEl(['outcome-btn']),
        'btn-outcome-drydock': makeMockEl(['outcome-btn']),
        'pregame-station-banner': makeMockEl(['pregame-station-banner']),
        'pregame-banner-text': makeMockEl([], { textContent: '' }),
        'btn-bridge-launch': makeMockEl([], { textContent: '' }),
        'lobby-overlay': makeMockEl(['modal-overlay'], { style: { display: 'none' } }),
      };

      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      globalThis.document = {
        body: { classList: bodyClassList },
        getElementById: (id) => mockElements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: null,
        addEventListener: () => {},
      };

      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: () => {},
          removeEventListener: () => {},
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      }

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        client.team = 'alpha';

        // 1. Battle Concluded: Alpha wins -> Winner sees exact 'Victorious'
        const winnerSnapshot = {
          state: 'gameover',
          winner: 'alpha',
          replayActive: false,
          replayComplete: true,
        };
        client.handleSnapshot(winnerSnapshot);

        const overlay = mockElements['battle-outcome-overlay'];
        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(overlay.classList.contains('outcome-victorious')).toBe(true);
        expect(overlay.classList.contains('outcome-destroyed')).toBe(false);
        expect(mockElements['battle-outcome-title'].textContent).toBe('Victorious');
        expect(mockElements['battle-outcome-subtitle'].textContent).toContain('HOSTILE VESSEL ELIMINATED');

        // Zero decorative emojis in outcome subtitle (Rule #29)
        const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
        expect(mockElements['battle-outcome-subtitle'].textContent).not.toMatch(emojiRegex);

        // 2. Battle Concluded: Omega wins -> Alpha player sees exact 'Destroyed'
        const loserSnapshot = {
          state: 'gameover',
          winner: 'omega',
          replayActive: false,
          replayComplete: true,
        };
        client.handleSnapshot(loserSnapshot);

        expect(overlay.classList.contains('hidden')).toBe(false);
        expect(overlay.classList.contains('outcome-destroyed')).toBe(true);
        expect(overlay.classList.contains('outcome-victorious')).toBe(false);
        expect(mockElements['battle-outcome-title'].textContent).toBe('Destroyed');
        expect(mockElements['battle-outcome-subtitle'].textContent).toContain('CATASTROPHIC HULL COLLAPSE');
        expect(mockElements['battle-outcome-subtitle'].textContent).not.toMatch(emojiRegex);

        // 3. Draw outcome
        const drawSnapshot = {
          state: 'gameover',
          winner: null,
          replayActive: false,
        };
        client.handleSnapshot(drawSnapshot);
        expect(overlay.classList.contains('outcome-draw')).toBe(true);
        expect(mockElements['battle-outcome-title'].textContent).toBe('Draw');

        // 4. Returning to 'playing' hides outcome overlay and replay banner
        client.handleSnapshot({ state: 'playing', replayActive: false });
        expect(overlay.classList.contains('hidden')).toBe(true);
        expect(mockElements['replay-hud-banner'].classList.contains('hidden')).toBe(true);
        expect(bodyClassList.contains('replay-mode')).toBe(false);

        // 5. Returning to 'lobby' hides outcome overlay and replay banner
        client.handleSnapshot({ state: 'lobby', replayActive: false });
        expect(overlay.classList.contains('hidden')).toBe(true);
        expect(mockElements['replay-hud-banner'].classList.contains('hidden')).toBe(true);
        expect(bodyClassList.contains('replay-mode')).toBe(false);

        client.destroy();
      } finally {
        globalThis.document = origDoc;
        if (!origWin) delete globalThis.window;
        else globalThis.window = origWin;
      }
    });

    it('verifies #btn-outcome-rematch sends restart_match and #btn-outcome-drydock opens lobby', () => {
      const sentMessages = [];
      const rematchListeners = [];
      const drydockListeners = [];

      const makeMockEl = (classes = [], extra = {}) => ({
        classList: { contains: () => false, add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
        style: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...extra,
      });

      const mockElements = {
        'btn-outcome-rematch': makeMockEl(['outcome-btn'], {
          addEventListener: (evt, cb) => { if (evt === 'click') rematchListeners.push(cb); },
        }),
        'btn-outcome-drydock': makeMockEl(['outcome-btn'], {
          addEventListener: (evt, cb) => { if (evt === 'click') drydockListeners.push(cb); },
        }),
        'lobby-overlay': makeMockEl(['modal-overlay'], {
          style: { display: 'none' },
        }),
        'btn-open-lobby': makeMockEl(['btn-hud-action']),
        'btn-close-lobby': makeMockEl(['btn-close-modal']),
        'battle-outcome-overlay': makeMockEl(['battle-outcome-overlay']),
      };

      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      globalThis.document = {
        getElementById: (id) => mockElements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: null,
        addEventListener: () => {},
      };

      if (!globalThis.window) {
        globalThis.window = {
          addEventListener: () => {},
          removeEventListener: () => {},
          location: { protocol: 'http:', host: 'localhost:3000' },
        };
      }

      try {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws' });
        client.send = (msg) => sentMessages.push(msg);

        // Trigger rematch click
        expect(rematchListeners.length).toBeGreaterThan(0);
        rematchListeners[0]({ preventDefault: vi.fn() });
        expect(sentMessages).toContainEqual({ type: 'restart_match' });

        // Trigger drydock click
        const openLobbySpy = vi.spyOn(client, 'openLobby');
        expect(drydockListeners.length).toBeGreaterThan(0);
        drydockListeners[0]({ preventDefault: vi.fn() });
        expect(openLobbySpy).toHaveBeenCalledTimes(1);

        client.destroy();
      } finally {
        globalThis.document = origDoc;
        if (!origWin) delete globalThis.window;
        else globalThis.window = origWin;
      }
    });
  });
});


describe('Crew-wide weapon and engine audio', () => {
  const makeClient = (team = 'alpha') => {
    const client = Object.create(BroadsideClient.prototype);
    client.team = team;
    const calls = [];
    client.sound = {
      playAtVolume: (vol, fn) => { calls.push({ vol }); return fn(); },
      playLaserZap: () => calls.push('laser'),
      playRailgunFire: () => calls.push('rail'),
      playTorpedoLaunch: () => calls.push('torp'),
      playFlakDetonation: () => calls.push('flak'),
      updateEngine: (t) => calls.push({ engine: t }),
    };
    return { client, calls };
  };

  it('plays own-ship fire events at full volume and enemy fire fainter, for any station', () => {
    const { client, calls } = makeClient('alpha');
    client.playWeaponEventSound({ type: 'laser_fired', shipId: 'alpha' });
    client.playWeaponEventSound({ type: 'railgun_fired', shipId: 'omega' });
    client.playWeaponEventSound({ type: 'torpedo_launched', shipId: 'alpha' });
    client.playWeaponEventSound({ type: 'flak_burst', shipId: 'alpha' });
    client.playWeaponEventSound({ type: 'shield_hit', shipId: 'alpha' });
    expect(calls).toEqual([
      { vol: 1 }, 'laser',
      { vol: 0.35 }, 'rail',
      { vol: 1 }, 'torp',
      { vol: 1 }, 'flak',
    ]);
  });

  it('drives engine rumble from own ship throttle only while playing and alive', () => {
    const { client, calls } = makeClient('omega');
    const ships = { omega: { mainDrive: { throttle: 0.6 } }, alpha: { mainDrive: { throttle: 1 } } };
    client.updateEngineSound({ state: 'playing', ships });
    client.updateEngineSound({ state: 'playing', replayActive: true, ships });
    client.updateEngineSound({ state: 'lobby', ships });
    client.updateEngineSound({ state: 'playing', ships: { omega: { destroyed: true, mainDrive: { throttle: 1 } } } });
    expect(calls).toEqual([{ engine: 0.6 }, { engine: 0 }, { engine: 0 }, { engine: 0 }]);
  });
});

describe('Phase 15: Enemy Top-Down Status Diagram, Weapons Optical Zoom & BSG Replay Loop', () => {
  it('buildEnemyDamageReport reports shields, all non-functioning/damaged systems, and nebula masking', () => {
    // 1. Nebula obscuration hides target systems & shields
    const obscured = buildEnemyDamageReport(
      { hullHp: 400, maxHullHp: 1000, shields: { hp: { fore: 0 }, maxHp: { fore: 100 } } },
      { targetAvailable: false, inNebula: true }
    );
    expect(obscured.signal).toBe(false);
    expect(obscured.obscured).toBe(true);
    expect(obscured.systems[0].label).toBe('SIGNAL OBSCURED / NEBULA');

    const enemyNebula = buildEnemyDamageReport({ hullHp: 800, maxHullHp: 1000, inNebula: true }, { targetAvailable: true });
    expect(enemyNebula.signal).toBe(false);
    expect(enemyNebula.obscured).toBe(true);

    // 2. Comprehensive non-functioning & damaged system report
    const report = buildEnemyDamageReport({
      hullHp: 350,
      maxHullHp: 1000,
      hullClass: 'dreadnought',
      reactorOnline: false,
      shields: {
        hp: { fore: 80, aft: 0, port: 45, starboard: 100 },
        maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 },
        online: { fore: true, aft: true, port: true, starboard: false },
      },
      mainDrive: { health: 40, overheated: true },
      thrusters: {
        bowPort: { health: 0 },
        bowStarboard: { health: 100 },
        sternPort: { health: 75 },
        sternStarboard: { health: 100 },
      },
      weapons: {
        laserHealth: 60,
        railgunHealth: 85,
        railgunJammed: true,
        stabilizerHealth: 0,
        stabilizerPowered: false,
        torpedoOverheated: true,
      },
      thermal: {
        shields: { overheated: true },
      },
      powerMap: {
        weapons_laser: 0,
      },
      grid: {
        tiles: [[{ status: 'broken' }, { status: 'broken' }]],
      },
    });

    expect(report.signal).toBe(true);
    expect(report.hullPct).toBe(35);
    expect(report.shields.fore).toEqual({ pct: 80, online: true });
    expect(report.shields.starboard).toEqual({ pct: 0, online: false });
    expect(report.shields.aft).toEqual({ pct: 0, online: true });

    const byLabel = Object.fromEntries(report.systems.map((s) => [s.label, s]));
    expect(byLabel['REACTOR']).toMatchObject({ status: 'offline', text: 'OFFLINE' });
    expect(byLabel['MAIN DRIVE']).toMatchObject({ status: 'offline', text: 'OVERHEATED 40%' });
    expect(byLabel['RCS THRUSTERS']).toMatchObject({ status: 'offline', text: '1/4 DOWN' });
    expect(byLabel['PULSE LASERS']).toMatchObject({ status: 'offline', text: 'UNPOWERED 60%' });
    expect(byLabel['RAILGUN']).toMatchObject({ status: 'offline', text: 'JAMMED 85%' });
    expect(byLabel['TORPEDO TUBE']).toMatchObject({ status: 'warning', text: 'OVERHEATED' });
    expect(byLabel['SAS / VIEW STAB']).toMatchObject({ status: 'offline', text: 'OFFLINE' });
    expect(byLabel['AFT SHIELD']).toMatchObject({ status: 'offline', text: 'COLLAPSED' });
    expect(byLabel['STARBOARD SHIELD']).toMatchObject({ status: 'offline', text: 'UNPOWERED' });
    expect(byLabel['SHIELD EMITTERS']).toMatchObject({ status: 'warning', text: 'OVERHEATED' });
    expect(byLabel['POWER CONDUITS']).toMatchObject({ status: 'warning', text: '2 BROKEN' });

    // 3. Nominal enemy ship
    const nominal = buildEnemyDamageReport({
      hullHp: 1000,
      maxHullHp: 1000,
      shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
    });
    expect(nominal.systems).toEqual([{ label: 'ALL SYSTEMS', status: 'nominal', text: 'NOMINAL' }]);
  });

  it('drawEnemyDiagram keeps all shield arcs and percentage labels inside 240x190 bounds across all hull classes', () => {
    const baseReport = buildEnemyDamageReport({
      hullHp: 750,
      maxHullHp: 1000,
      shields: { hp: { fore: 100, aft: 60, port: 25, starboard: 0 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
    });

    for (const hullClass of ['corvette', 'frigate', 'dreadnought']) {
      const textCalls = [];
      const ctx = {
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        ellipse: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        fillRect: vi.fn(),
        strokeText: vi.fn(),
        fillText: vi.fn((text, x, y) => textCalls.push({ text, x, y })),
      };

      drawEnemyDiagram(ctx, 240, 190, baseReport, { hullClass });
      expect(textCalls.length).toBeGreaterThanOrEqual(5);
      for (const call of textCalls) {
        expect(call.x).toBeGreaterThanOrEqual(10);
        expect(call.x).toBeLessThanOrEqual(230);
        expect(call.y).toBeGreaterThanOrEqual(10);
        expect(call.y).toBeLessThanOrEqual(180);
      }
    }
  });

  it('WeaponsController supports mouse wheel zoom, scales look sensitivity, and handles 2-finger pinch without accidental railgun release', () => {
    const handlers = {};
    const canvasEl = {
      id: 'space-canvas',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      addEventListener: (ev, fn) => {
        handlers[`canvas:${ev}`] = fn;
      },
      removeEventListener: vi.fn(),
    };
    const zoomReadoutEl = { textContent: '' };

    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    globalThis.window = {
      addEventListener: (ev, fn) => {
        handlers[`win:${ev}`] = fn;
      },
      removeEventListener: vi.fn(),
    };
    globalThis.document = {
      activeElement: null,
      getElementById: (id) => {
        if (id === 'space-canvas') return canvasEl;
        if (id === 'weapons-zoom-readout') return zoomReadoutEl;
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    try {
      const sent = [];
      const weapons = new WeaponsController({
        send: (msg) => sent.push(msg),
        selectedWeapon: 'railgun',
      });

      // 1. Mouse wheel zooms in/out and updates readout; non-canvas wheel is ignored
      expect(weapons.weaponsZoom).toBe(1.0);
      const wheelPrevent = vi.fn();
      handlers['canvas:wheel']({
        target: canvasEl,
        deltaY: -120,
        deltaMode: 0,
        preventDefault: wheelPrevent,
      });
      expect(wheelPrevent).toHaveBeenCalled();
      expect(weapons.weaponsZoom).toBeGreaterThan(1.3);
      expect(zoomReadoutEl.textContent).toBe(`ZOOM ${weapons.weaponsZoom.toFixed(1)}x`);

      const prevZoom = weapons.weaponsZoom;
      handlers['canvas:wheel']({
        target: { id: 'enemy-damage-list' },
        deltaY: 200,
        deltaMode: 0,
        preventDefault: vi.fn(),
      });
      expect(weapons.weaponsZoom).toBe(prevZoom);

      // Zoom back to 1.0, compare look pan delta vs 4.0x zoom
      weapons.setZoom(1.0);
      weapons.lookKeys.KeyD = true;
      weapons.updateGunnerView(0.1, { angle: 0, vel: { x: 0, y: 0 }, weapons: { stabilizerHealth: 100 } });
      const deltaAt1x = weapons.desiredLookOffset;

      weapons.desiredLookOffset = 0;
      weapons.setZoom(4.0);
      weapons.updateGunnerView(0.1, { angle: 0, vel: { x: 0, y: 0 }, weapons: { stabilizerHealth: 100 } });
      const deltaAt4x = weapons.desiredLookOffset;
      expect(deltaAt4x).toBeCloseTo(deltaAt1x / 4, 4);
      weapons.lookKeys.KeyD = false;

      // 2. Two-finger pinch cancels accidental 1-finger railgun charge WITHOUT discharging railgun
      weapons.setZoom(1.0);
      sent.length = 0;

      // Finger 1 lands briefly before Finger 2
      handlers['canvas:touchstart']({
        touches: [{ clientX: 400, clientY: 360 }],
        preventDefault: vi.fn(),
      });
      expect(weapons.railgunPointerCharging).toBe(true);
      expect(sent.some((m) => m.startRailgunCharge === true)).toBe(true);

      // Finger 2 lands -> starts 100px pinch, cancels railgun charge without releaseRailgun
      handlers['canvas:touchstart']({
        touches: [
          { clientX: 400, clientY: 360 },
          { clientX: 500, clientY: 360 },
        ],
        preventDefault: vi.fn(),
      });
      expect(weapons.isPinchZooming).toBe(true);
      expect(weapons.railgunPointerCharging).toBe(false);
      expect(sent.some((m) => m.releaseRailgun === true)).toBe(false);

      // Spread fingers to 250px -> 2.5x zoom
      handlers['canvas:touchmove']({
        touches: [
          { clientX: 325, clientY: 360 },
          { clientX: 575, clientY: 360 },
        ],
        preventDefault: vi.fn(),
      });
      expect(weapons.weaponsZoom).toBeCloseTo(2.5, 2);

      // Contract fingers to 100px -> 1.0x zoom
      handlers['canvas:touchmove']({
        touches: [
          { clientX: 400, clientY: 360 },
          { clientX: 500, clientY: 360 },
        ],
        preventDefault: vi.fn(),
      });
      expect(weapons.weaponsZoom).toBeCloseTo(1.0, 2);

      // Lift 1st finger, then 2nd finger -> stays safe with zero accidental railgun release
      handlers['win:touchend']({
        touches: [{ clientX: 400, clientY: 360 }],
        preventDefault: vi.fn(),
      });
      expect(weapons.isPinchZooming).toBe(true);

      handlers['win:touchend']({
        touches: [],
        preventDefault: vi.fn(),
      });
      expect(weapons.isPinchZooming).toBe(false);
      expect(sent.some((m) => m.releaseRailgun === true)).toBe(false);

      // 3. Laser 1-finger interrupted by pinch stops laser without leaving firing stuck on
      weapons.selectWeapon('laser');
      sent.length = 0;
      handlers['canvas:touchstart']({
        touches: [{ clientX: 400, clientY: 360 }],
        preventDefault: vi.fn(),
      });
      expect(weapons.isPointerFiring).toBe(true);
      handlers['canvas:touchstart']({
        touches: [
          { clientX: 400, clientY: 360 },
          { clientX: 500, clientY: 360 },
        ],
        preventDefault: vi.fn(),
      });
      expect(weapons.isPointerFiring).toBe(false);
      expect(sent.some((m) => m.fireLaser === false)).toBe(true);

      weapons.destroy();
    } finally {
      globalThis.document = origDoc;
      if (!origWin) delete globalThis.window;
      else globalThis.window = origWin;
    }
  });

  it('BroadsideClient.startLoop forwards weaponsZoom in weapons_pov and cameraMode bsg_replay during replayActive', () => {
    const origRaf = globalThis.requestAnimationFrame;
    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    let rafQueue = [];
    globalThis.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    globalThis.document = {
      body: { classList: { contains: () => false, add: vi.fn(), remove: vi.fn(), toggle: vi.fn() } },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { protocol: 'http:', host: 'localhost:3000' },
    };

    try {
      const mockRender = vi.fn();
      const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws', autoStartLoop: false });
      client.renderer = {
        render: mockRender,
        resize: vi.fn(),
        clearEffects3D: vi.fn(),
        resetBsgReplayCamera: vi.fn(),
      };
      client.team = 'alpha';
      client.station = 'weapons';
      client.weapons = {
        weaponsZoom: 2.75,
        gunnerPitchOffset: 0.1,
        getGunnerWorldAngle: () => 0.5,
        getLeadReticle: () => null,
        updateGunnerView: vi.fn(),
        updateHUD: vi.fn(),
        setActive: vi.fn(),
        destroy: vi.fn(),
      };
      client.helm = { updateHUD: vi.fn(), setActive: vi.fn(), destroy: vi.fn() };
      client.engineer = { updateHUD: vi.fn(), setActive: vi.fn(), destroy: vi.fn() };
      client.currentSnapshot = {
        state: 'playing',
        replayActive: false,
        ships: {
          alpha: { team: 'alpha', pos: { x: 0, y: 0, z: 0 }, angle: 0.5 },
          omega: { team: 'omega', pos: { x: 500, y: 0, z: 0 }, angle: 0 },
        },
        sector: { asteroids: [] },
      };

      // Frame 1: Weapons live -> cameraMode: 'weapons_pov', weaponsZoom: 2.75
      rafQueue = [];
      client.startLoop();
      expect(rafQueue.length).toBeGreaterThan(0);
      const cb1 = rafQueue.shift();
      cb1(16);
      expect(mockRender).toHaveBeenCalledWith(
        client.currentSnapshot,
        expect.objectContaining({
          cameraMode: 'weapons_pov',
          weaponsZoom: 2.75,
        })
      );

      // Frame 2: Active replay -> cameraMode: 'bsg_replay'
      client.currentSnapshot = {
        state: 'gameover',
        replayActive: true,
        replayProgress: 0.5,
        replayFrame: {
          frameIndex: 2,
          tick: 120,
          ships: {
            alpha: { team: 'alpha', pos: { x: 0, y: 0, z: 0 } },
            omega: { team: 'omega', pos: { x: 500, y: 0, z: 0 } },
          },
          events: [],
          destroyedAsteroidIds: [],
        },
        sector: { asteroids: [] },
      };
      const cb2 = rafQueue.shift();
      cb2(32);
      expect(mockRender).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.objectContaining({
          cameraMode: 'bsg_replay',
        })
      );

      // Frame 3: Engineer live -> cameraMode: 'engineer_pov' (subject to Stage-0 external view blackout)
      client.station = 'engineer';
      client.currentSnapshot = {
        state: 'playing',
        replayActive: false,
        ships: {
          alpha: {
            team: 'alpha',
            pos: { x: 0, y: 0, z: 0 },
            angle: 0.5,
            hyperspace: { state: 'rebooting', rebootTimer: 1.5, stage1Sec: 4.0 },
          },
          omega: { team: 'omega', pos: { x: 500, y: 0, z: 0 }, angle: 0 },
        },
        sector: { asteroids: [] },
      };
      const cb3 = rafQueue.shift();
      cb3(48);
      expect(mockRender).toHaveBeenLastCalledWith(
        client.currentSnapshot,
        expect.objectContaining({
          cameraMode: 'engineer_pov',
        })
      );

      client.destroy();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.document = origDoc;
      if (!origWin) delete globalThis.window;
      else globalThis.window = origWin;
    }
  });

  describe('Phase 16 Slice 3: Engineer 11-System UI + Bridge/Helm DOM & CSS', () => {
    it('verifies public/index.html includes Hyperspace HUD banner, blackout overlay, Helm #btn-hyperspace, and Engineer 11-system controls', () => {
      const htmlPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // 1. Hyperspace Status Banner in hud-center
      expect(html).toContain('id="hyperspace-status-banner"');
      expect(html).toContain('class="alert-banner hyperspace-banner hidden"');
      expect(html).toContain('id="hyperspace-banner-text"');

      // 2. Diegetic External Optics Blackout Overlay in viewport-container
      expect(html).toContain('id="hyperspace-blackout-overlay"');
      expect(html).toContain('class="hyperspace-blackout-overlay hidden"');
      expect(html).toContain('id="hyperspace-blackout-title"');
      expect(html).toContain('EXTERNAL OPTICS OFFLINE — SHIP REBOOTING');
      expect(html).toContain('id="hyperspace-blackout-bar"');
      expect(html).toContain('id="hyperspace-blackout-timers"');
      expect(html).toMatch(/VIEWS \/ DRIVE \/ RCS:\s*4\.0s\s*·\s*ALL SYSTEMS:\s*7\.0s/);

      // 3. Helm Actions Bar includes #btn-hyperspace right after #btn-turn-and-burn
      expect(html).toContain('id="btn-hyperspace"');
      expect(html).toContain('class="btn-tactical btn-hyperspace"');
      expect(html).toContain('HYPERSPACE [H]');

      // Verify ordering inside helm-actions-bar: btn-turn-and-burn before btn-hyperspace
      const turnBurnIdx = html.indexOf('id="btn-turn-and-burn"');
      const hyperBtnIdx = html.indexOf('id="btn-hyperspace"');
      expect(turnBurnIdx).toBeGreaterThan(0);
      expect(hyperBtnIdx).toBeGreaterThan(turnBurnIdx);

      // 4. Engineer Station initial counts and 11th subsystem
      expect(html).toContain('id="eng-connected-count"');
      expect(html).toContain('P:11/11 · C:11/11');
      expect(html).toContain('id="eng-power-per-node"');
      expect(html).toContain('id="eng-coolant-share"');
      expect(html).toContain('73%');

      // System boost row for hyperspace
      expect(html).toMatch(/class="system-boost-row"[^>]*data-subsystem="hyperspace"/);
      expect(html).toMatch(/class="btn-boost-system"[^>]*data-subsystem="hyperspace"/);
      expect(html).toContain('HYPERSPACE');

      // Hardware repair target button for hyperspace inside #eng-repair-targets
      expect(html).toContain('id="eng-repair-targets"');
      expect(html).toMatch(/class="btn-repair-target"[^>]*data-subsystem="hyperspace"[^>]*>HYPER<\/button>/);

      // Verify zero decorative emojis in index.html (Rule #29)
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(html).not.toMatch(emojiRegex);
    });

    it('verifies public/css/style.css defines Hyperspace tactical button, blackout overlay, banner, and PiP offline styling', () => {
      const cssPath = path.join(publicDir, 'css', 'style.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      // .btn-hyperspace progress & state classes
      expect(css).toMatch(/\.btn-hyperspace\s*\{[^}]*--hyper-progress:\s*0%/);
      expect(css).toMatch(/\.btn-hyperspace\s*\{[^}]*linear-gradient/);
      expect(css).toMatch(/\.btn-hyperspace\.charging\s*\{/);
      expect(css).toMatch(/\.btn-hyperspace\.jumping\s*\{/);
      expect(css).toMatch(/\.btn-hyperspace\.reboot-stage1\s*\{/);
      expect(css).toMatch(/\.btn-hyperspace\.reboot-stage2\s*\{/);

      // .hyperspace-banner
      expect(css).toMatch(/\.hyperspace-banner\s*\{[^}]*border:\s*1px solid rgba\(56,\s*189,\s*248/);

      // .hyperspace-blackout-overlay
      expect(css).toMatch(/\.hyperspace-blackout-overlay\s*\{[^}]*position:\s*absolute/);
      expect(css).toMatch(/\.hyperspace-blackout-overlay\s*\{[^}]*top:\s*26%/);
      expect(css).toMatch(/\.hyperspace-blackout-overlay\s*\{[^}]*pointer-events:\s*none/);
      expect(css).toMatch(/\.hyperspace-blackout-overlay\s*\{[^}]*z-index:\s*25/);
      expect(css).toMatch(/\.blackout-progress-track\s*\{/);
      expect(css).toMatch(/\.blackout-progress-fill\s*\{/);

      // .helm-pip-panel.pip-offline
      expect(css).toMatch(/\.helm-pip-panel\.pip-offline\s+canvas\s*\{[^}]*opacity:\s*0\.06/);
      expect(css).toMatch(/\.helm-pip-panel\.pip-offline::after\s*\{[^}]*content:\s*'OFFLINE'/);

      // Narrow-tablet @media (max-width: 900px) non-overlapping .helm-actions-bar rules
      expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.helm-actions-bar\s*\{[^}]*max-width:\s*min\(380px,\s*calc\(100vw\s*-\s*380px\)\)/);
      expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.btn-tactical\s*\{[^}]*min-width:\s*0/);

      // Verify zero decorative emojis in style.css
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(css).not.toMatch(emojiRegex);
    });

    it('verifies EngineerController EXTERNAL_SYSTEMS includes hyperspace with East anchor and renders 11 rows cleanly', () => {
      // 1. Check EXTERNAL_SYSTEMS definition
      expect(EXTERNAL_SYSTEMS).toHaveLength(11);

      const hyperSys = EXTERNAL_SYSTEMS.find(s => s.key === 'hyperspace');
      expect(hyperSys).toBeDefined();
      expect(hyperSys).toEqual({
        key: 'hyperspace',
        label: 'HYPERSPACE',
        short: 'HYPER',
        side: 'E',
        cells: [[1, 9], [2, 9]],
        droneAnchor: { row: 1.5, col: 9 },
      });

      // Verify hyperspace is situated right before shields_starboard
      const hyperIndex = EXTERNAL_SYSTEMS.findIndex(s => s.key === 'hyperspace');
      const stbdIndex = EXTERNAL_SYSTEMS.findIndex(s => s.key === 'shields_starboard');
      expect(hyperIndex).toBe(stbdIndex - 1);

      // 2. Check SUBSYSTEM_LABELS definition
      expect(SUBSYSTEM_LABELS.hyperspace).toBe('HYPERSPACE DRIVE');

      // 3. Check perimeter box bounding rectangle for hyperspace
      const box = getPerimeterBoxRect(hyperSys, 100, 100, 56, 84);
      expect(box).toEqual({
        x: 100 + 10 * 56, // 660
        y: 100 + 1 * 56,  // 156
        width: 84,
        height: 112,
      });

      // 4. Test EngineerController repair target badge update for hyperspace
      const origDoc = globalThis.document;
      const hyperRepairBtn = {
        dataset: { subsystem: 'hyperspace' },
        querySelector: vi.fn(),
        appendChild: vi.fn(),
      };
      const badgeEl = { className: '', textContent: '' };
      hyperRepairBtn.querySelector.mockReturnValue(badgeEl);

      globalThis.document = {
        getElementById: () => null,
        querySelectorAll: (sel) => sel === '.btn-repair-target' ? [hyperRepairBtn] : [],
      };

      try {
        const engineer = new EngineerController({ send: () => {} });
        engineer.updateHUD({
          grid: { tiles: [] },
          drones: [],
          powerMap: {
            powerConnectedCount: 11,
            coolantConnectedCount: 11,
            reactorOnline: true,
          },
          hyperspace: { health: 45 },
          ship: {
            hyperspace: { health: 45 },
          },
        });

        expect(badgeEl.textContent).toBe('45%');
        expect(badgeEl.className).toBe('health-badge warning');

        engineer.destroy();
      } finally {
        globalThis.document = origDoc;
      }
    });
  });

  describe('Phase 16 Slice 4: Helm & Weapons Controls, All-Crew HUD Banners/Blackout UI & Star Trek Warp Audio Synth', () => {
    it('verifies HelmController triggerHyperspace, KeyH binding, HUD button states, PiPs offline, and sensor gating', () => {
      const messages = [];
      const origDoc = globalThis.document;

      const styleMap = new Map();
      const classSet = new Set();
      const mockBtn = {
        style: {
          setProperty: (k, v) => styleMap.set(k, v),
        },
        classList: {
          add: (...cs) => cs.forEach(c => classSet.add(c)),
          remove: (...cs) => cs.forEach(c => classSet.delete(c)),
          contains: (c) => classSet.has(c),
        },
        textContent: '',
        disabled: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };

      const pipClassSet = new Set();
      const mockPip = {
        classList: {
          add: (c) => pipClassSet.add(c),
          remove: (c) => pipClassSet.delete(c),
          contains: (c) => pipClassSet.has(c),
        },
      };

      const vectorStatus = { textContent: '' };
      const vectorBearing = { textContent: '' };
      const vectorVelocity = { textContent: '' };
      const vectorCard = { classList: { add: vi.fn(), remove: vi.fn() } };

      globalThis.document = {
        getElementById: (id) => {
          if (id === 'btn-hyperspace') return mockBtn;
          if (id === 'helm-pip-panel') return mockPip;
          if (id === 'helm-enemy-vector') return vectorCard;
          if (id === 'helm-enemy-status') return vectorStatus;
          if (id === 'helm-enemy-bearing') return vectorBearing;
          if (id === 'helm-enemy-velocity') return vectorVelocity;
          return null;
        },
        querySelectorAll: (sel) => {
          if (sel.includes('helm-pip-panel')) return [mockPip];
          return [];
        },
        querySelector: () => null,
      };

      try {
        const helm = new HelmController({
          send: (msg) => messages.push(msg),
        });

        // 1. triggerHyperspace() dispatch
        helm.triggerHyperspace();
        expect(messages.length).toBe(1);
        expect(messages[0]).toEqual({ type: 'helm_input', toggleHyperspace: true });

        // 2. KeyH shortcut
        helm.handleKeyDown({ code: 'KeyH', repeat: false, preventDefault: vi.fn() });
        expect(messages.length).toBe(2);
        expect(messages[1]).toEqual({ type: 'helm_input', toggleHyperspace: true });

        // Ignore repeat KeyH
        helm.handleKeyDown({ code: 'KeyH', repeat: true, preventDefault: vi.fn() });
        expect(messages.length).toBe(2);

        // 3. updateHUD button states
        // Ready state
        helm.updateHUD({
          hyperspace: { state: 'ready', charge: 0, health: 100 },
          powerMap: { hyperspace: 1 },
        });
        expect(mockBtn.textContent).toBe('HYPERSPACE [H]');
        expect(mockBtn.disabled).toBe(false);
        expect(styleMap.get('--hyper-progress')).toBe('0%');

        // Charging state
        helm.updateHUD({
          hyperspace: { state: 'charging', charge: 0.456, health: 100 },
          powerMap: { hyperspace: 1 },
        });
        expect(mockBtn.textContent).toBe('ABORT JUMP 46%');
        expect(classSet.has('charging')).toBe(true);
        expect(styleMap.get('--hyper-progress')).toBe('46%');

        // Jumping state
        helm.updateHUD({
          hyperspace: { state: 'jumping', charge: 1, health: 100 },
          powerMap: { hyperspace: 1 },
        });
        expect(mockBtn.textContent).toBe('WARP TRANSIT');
        expect(classSet.has('jumping')).toBe(true);
        expect(classSet.has('disabled')).toBe(true);
        expect(mockBtn.disabled).toBe(true);
        expect(styleMap.get('--hyper-progress')).toBe('100%');

        // Rebooting Stage 1 (< 4.0s)
        helm.updateHUD({
          hyperspace: { state: 'rebooting', rebootTimer: 1.5, stage1Sec: 4.0, rebootDuration: 7.0, health: 100 },
          powerMap: { hyperspace: 1 },
        });
        expect(mockBtn.textContent).toBe('REBOOT 2.5s');
        expect(classSet.has('reboot-stage1')).toBe(true);
        expect(classSet.has('disabled')).toBe(true);
        expect(mockBtn.disabled).toBe(true);

        // Rebooting Stage 2 (>= 4.0s)
        helm.updateHUD({
          hyperspace: { state: 'rebooting', rebootTimer: 5.5, stage1Sec: 4.0, rebootDuration: 7.0, health: 100 },
          powerMap: { hyperspace: 1 },
        });
        expect(mockBtn.textContent).toBe('SYS BOOT 1.5s');
        expect(classSet.has('reboot-stage2')).toBe(true);
        expect(classSet.has('disabled')).toBe(true);
        expect(mockBtn.disabled).toBe(true);

        // Unpowered ready
        helm.updateHUD({
          hyperspace: { state: 'ready', charge: 0, health: 100 },
          powerMap: { hyperspace: 0 },
        });
        expect(mockBtn.textContent).toBe('HYPERSPACE OFFLINE');
        expect(classSet.has('disabled')).toBe(true);
        expect(mockBtn.disabled).toBe(true);

        // 4. External Views PiPs offline toggle
        helm.updateHUD({
          externalViewsOnline: false,
          hyperspace: { state: 'rebooting', rebootTimer: 1.0 },
        });
        expect(pipClassSet.has('pip-offline')).toBe(true);

        helm.updateHUD({
          externalViewsOnline: true,
          hyperspace: { state: 'ready' },
        });
        expect(pipClassSet.has('pip-offline')).toBe(false);

        // 5. Sensor Gating in updateEnemyVector
        // Sensors offline -> 'SENSORS OFFLINE'
        helm.updateEnemyVector(
          { sensorsOnline: false, targetAvailable: false, pos: { x: 0, y: 0 } },
          { pos: { x: 100, y: 100 } }
        );
        expect(vectorStatus.textContent).toBe('SENSORS OFFLINE');

        // Enemy in warp -> 'NO TARGET LOCK'
        helm.updateEnemyVector(
          { sensorsOnline: true, targetAvailable: true, pos: { x: 0, y: 0 } },
          { pos: { x: 100, y: 100 }, hyperspace: { state: 'jumping' } }
        );
        expect(vectorStatus.textContent).toBe('NO TARGET LOCK');

        helm.destroy();
      } finally {
        globalThis.document = origDoc;
      }
    });

    it('verifies HelmController resets throttleSetting to 0 on hyperspace jump and <4.0s reboot, permitting new throttle at >=4.0s', () => {
      const messages = [];
      const helm = new HelmController({ send: (m) => messages.push(m) });

      // 1. Initial state: pilot commands throttle to 0.8
      helm.throttleSetting = 0.8;
      helm.recomputeState();
      expect(helm.throttleSetting).toBe(0.8);
      expect(helm.state.forward).toBe(0.8);

      // 2. Ship initiates hyperspace jump -> resets throttleSetting to 0
      helm.updateHUD({
        hyperspace: { state: 'jumping', jumpTimer: 0.5, stage1Sec: 4.0 },
      });
      expect(helm.throttleSetting).toBe(0);
      expect(helm.state.forward).toBe(0);

      // 3. Pilot attempts to increase throttle during <4.0s Stage-0 reboot -> reset back to 0
      helm.throttleSetting = 0.5;
      helm.updateHUD({
        hyperspace: { state: 'rebooting', rebootTimer: 1.5, stage1Sec: 4.0, rebootDuration: 7.0 },
      });
      expect(helm.throttleSetting).toBe(0);
      expect(helm.state.forward).toBe(0);

      // 4. Reboot reaches 4.0s (Stage 1 online) -> pilot commands throttle to 0.75
      helm.updateHUD({
        hyperspace: { state: 'rebooting', rebootTimer: 4.0, stage1Sec: 4.0, rebootDuration: 7.0 },
      });
      helm.throttleSetting = 0.75;
      helm.recomputeState();

      // Subsequent updateHUD tick at 4.8s must NOT overwrite pilot's newly commanded throttle!
      helm.updateHUD({
        hyperspace: { state: 'rebooting', rebootTimer: 4.8, stage1Sec: 4.0, rebootDuration: 7.0 },
      });
      expect(helm.throttleSetting).toBe(0.75);
      expect(helm.state.forward).toBe(0.75);

      // Hyperspace returns to ready -> pilot throttle remains 0.75
      helm.updateHUD({
        hyperspace: { state: 'ready' },
      });
      expect(helm.throttleSetting).toBe(0.75);
      expect(helm.state.forward).toBe(0.75);

      helm.destroy();
    });

    it('verifies WeaponsController targeting gating, weapon fire suppression, and damage report', () => {
      const messages = [];
      const weapons = new WeaponsController({
        send: (msg) => messages.push(msg),
      });

      // 1. areWeaponsPermitted evaluation
      expect(weapons.areWeaponsPermitted({ weaponsOnline: true })).toBe(true);
      expect(weapons.areWeaponsPermitted({ weaponsOnline: false })).toBe(false);
      expect(weapons.areWeaponsPermitted({ weaponsOnline: true, hyperspace: { state: 'jumping' } })).toBe(false);
      expect(weapons.areWeaponsPermitted({ weaponsOnline: true, hyperspace: { state: 'rebooting', rebootTimer: 2.0 } })).toBe(false);
      expect(weapons.areWeaponsPermitted({ weaponsOnline: true, hyperspace: { state: 'rebooting', rebootTimer: 7.0 } })).toBe(true);
      expect(weapons.areWeaponsPermitted({ weaponsOnline: true, hyperspace: { state: 'ready' } })).toBe(true);

      // 2. Firing suppression when ship is in warp or reboot
      weapons._lastShip = {
        weaponsOnline: true,
        hyperspace: { state: 'jumping' },
      };

      weapons.setLaserFiring(true);
      weapons.startRailgunCharge();
      weapons.launchTorpedo();
      weapons.fireFlak();
      weapons.handlePointerFireStart(100, 100);

      expect(messages.length).toBe(0);

      // Firing allowed when ship is in ready
      weapons._lastShip = {
        weaponsOnline: true,
        hyperspace: { state: 'ready' },
      };

      weapons.setLaserFiring(true);
      expect(messages.length).toBe(1);
      expect(messages[0].fireLaser).toBe(true);

      weapons.launchTorpedo();
      expect(messages.length).toBe(2);
      expect(messages[1].launchTorpedo).toBe(true);

      weapons.fireFlak();
      expect(messages.length).toBe(3);
      expect(messages[2].fireFlak).toBe(true);

      // 3. Lead Reticle calculation gating in updateHUD
      weapons.updateHUD(
        { sensorsOnline: false, targetAvailable: false, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } },
        { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, destroyed: false }
      );
      expect(weapons.getLeadReticle()).toBeNull();

      weapons.updateHUD(
        { sensorsOnline: true, targetAvailable: true, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } },
        { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, destroyed: false, hyperspace: { state: 'jumping' } }
      );
      expect(weapons.getLeadReticle()).toBeNull();

      weapons.updateHUD(
        { sensorsOnline: true, targetAvailable: true, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } },
        { pos: { x: 100, y: 100 }, vel: { x: 0, y: 0 }, destroyed: false, hyperspace: { state: 'ready' } }
      );
      expect(weapons.getLeadReticle()).not.toBeNull();

      // 4. buildEnemyDamageReport gating
      const rptSensorsOffline = buildEnemyDamageReport(
        { hullHp: 1000, maxHullHp: 1000 },
        { sensorsOnline: false }
      );
      expect(rptSensorsOffline.obscured).toBe(true);
      expect(rptSensorsOffline.systems[0].label).toBe('TARGETING OFFLINE — REBOOTING');

      const rptTargetInWarp = buildEnemyDamageReport(
        { hullHp: 1000, maxHullHp: 1000, hyperspace: { state: 'jumping' } },
        { sensorsOnline: true }
      );
      expect(rptTargetInWarp.obscured).toBe(true);
      expect(rptTargetInWarp.systems[0].label).toBe('TARGET IN WARP');

      weapons.destroy();
    });

    it('verifies SoundSynth Star Trek warp audio synthesis methods', () => {
      const sound = new SoundSynth();

      // Headless / null-safe execution
      expect(sound.updateWarpChargeSound(false, 0)).toBe(false);
      expect(sound.updateWarpChargeSound(true, 0.5)).toBe(false);
      expect(sound.playWarpEngage()).toBe(false);
      expect(sound.startWarpTravelSound()).toBe(false);
      expect(() => sound.stopWarpTravelSound()).not.toThrow();
      expect(sound.playWarpExitBoom()).toBe(false);
      expect(sound.playRebootStage1()).toBe(false);
      expect(sound.playRebootComplete()).toBe(false);

      // Verify node creation and parameter setup using a mock AudioContext
      const mockAudioNodes = [];
      const createParam = () => ({
        value: 0,
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setTargetAtTime: vi.fn(),
      });

      const mockCtx = {
        currentTime: 0.1,
        sampleRate: 44100,
        createOscillator: () => {
          const osc = {
            type: 'sine',
            frequency: createParam(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
          };
          mockAudioNodes.push(osc);
          return osc;
        },
        createGain: () => {
          const gain = {
            gain: createParam(),
            connect: vi.fn(),
            disconnect: vi.fn(),
          };
          mockAudioNodes.push(gain);
          return gain;
        },
        createBiquadFilter: () => {
          const filter = {
            type: 'lowpass',
            frequency: createParam(),
            Q: createParam(),
            connect: vi.fn(),
            disconnect: vi.fn(),
          };
          mockAudioNodes.push(filter);
          return filter;
        },
        createBufferSource: () => {
          const src = {
            buffer: null,
            loop: false,
            connect: vi.fn(),
            disconnect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
          };
          mockAudioNodes.push(src);
          return src;
        },
        createBuffer: (channels, length, rate) => ({
          getChannelData: () => new Float32Array(length),
        }),
        destination: {},
      };

      sound.ctx = mockCtx;

      // 1. Warp Charge Sound
      expect(sound.updateWarpChargeSound(true, 0.75)).toBe(true);
      expect(sound.warpCharge).toBeDefined();
      expect(sound.updateWarpChargeSound(false, 0)).toBe(false);

      // 2. Warp Engage (TNG / Kelvin snap)
      expect(sound.playWarpEngage()).toBe(true);

      // 3. Warp Travel Sound (subspace thrum)
      expect(sound.startWarpTravelSound()).toBe(true);
      expect(sound.warpTravel).toBeDefined();
      sound.stopWarpTravelSound();
      expect(sound.warpTravel).toBeNull();

      // 4. Warp Exit Boom
      expect(sound.playWarpExitBoom()).toBe(true);

      // 5. Reboot Stage 1 chime
      expect(sound.playRebootStage1()).toBe(true);

      // 6. Reboot Complete 3-note chime
      expect(sound.playRebootComplete()).toBe(true);
    });

    it('verifies BroadsideClient audio event routing, HUD banner / blackout UI, and replay snapshot fidelity', () => {
      const client = new BroadsideClient();
      const soundSpy = {
        playLaserZap: vi.fn(),
        playRailgunFire: vi.fn(),
        playTorpedoLaunch: vi.fn(),
        playFlakDetonation: vi.fn(),
        playWarpEngage: vi.fn(),
        playWarpExitBoom: vi.fn(),
        playRebootStage1: vi.fn(),
        playRebootComplete: vi.fn(),
        playAtVolume: vi.fn((vol, fn) => fn()),
      };
      client.sound = soundSpy;
      client.team = 'alpha';

      // 1. Audio event routing for hyperspace events
      client.playWeaponEventSound({ type: 'hyperspace_enter', shipId: 'alpha' });
      expect(soundSpy.playWarpEngage).toHaveBeenCalledTimes(1);

      client.playWeaponEventSound({ type: 'hyperspace_exit', shipId: 'alpha' });
      expect(soundSpy.playWarpExitBoom).toHaveBeenCalledTimes(1);

      client.playWeaponEventSound({ type: 'hyperspace_reboot_stage1', shipId: 'alpha' });
      expect(soundSpy.playRebootStage1).toHaveBeenCalledTimes(1);

      client.playWeaponEventSound({ type: 'hyperspace_reboot_complete', shipId: 'alpha' });
      expect(soundSpy.playRebootComplete).toHaveBeenCalledTimes(1);

      // 2. All-Crew Hyperspace HUD Banner & External Optics Blackout Overlay
      const origDoc = globalThis.document;
      const bannerClassSet = new Set(['hidden']);
      const blackoutClassSet = new Set(['hidden']);
      const bannerText = { textContent: '' };
      const blackoutBar = { style: { width: '' } };
      const blackoutTimers = { textContent: '' };

      globalThis.document = {
        getElementById: (id) => {
          if (id === 'hyperspace-status-banner') {
            return {
              classList: {
                add: (c) => bannerClassSet.add(c),
                remove: (c) => bannerClassSet.delete(c),
                contains: (c) => bannerClassSet.has(c),
              },
            };
          }
          if (id === 'hyperspace-banner-text') return bannerText;
          if (id === 'hyperspace-blackout-overlay') {
            return {
              classList: {
                add: (c) => blackoutClassSet.add(c),
                remove: (c) => blackoutClassSet.delete(c),
                contains: (c) => blackoutClassSet.has(c),
              },
            };
          }
          if (id === 'hyperspace-blackout-bar') return blackoutBar;
          if (id === 'hyperspace-blackout-timers') return blackoutTimers;
          return null;
        },
      };

      try {
        // Charging banner
        client.updateHyperspaceUI({
          hyperspace: { state: 'charging', charge: 0.8 },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toBe('HYPERSPACE CHARGING: 80%');
        expect(blackoutClassSet.has('hidden')).toBe(true);

        // Jumping banner
        client.updateHyperspaceUI({
          hyperspace: { state: 'jumping', charge: 1.0 },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toBe('WARP TRANSIT ACTIVE');
        expect(blackoutClassSet.has('hidden')).toBe(true);

        // Rebooting Stage 0 (< 4.0s) -> Blackout Overlay VISIBLE + Stage 0 Banner
        client.updateHyperspaceUI({
          hyperspace: { state: 'rebooting', rebootTimer: 2.0, stage1Sec: 4.0, rebootDuration: 7.0 },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toContain('HYPERSPACE EXIT — SHIP REBOOTING');
        expect(blackoutClassSet.has('hidden')).toBe(false);
        expect(blackoutBar.style.width).toBe('50.0%');
        expect(blackoutTimers.textContent).toContain('VIEWS / DRIVE / RCS: 2.0s');

        // Rebooting Stage 1 (>= 4.0s) -> Blackout Overlay HIDDEN + Stage 1 Banner
        client.updateHyperspaceUI({
          hyperspace: { state: 'rebooting', rebootTimer: 5.0, stage1Sec: 4.0, rebootDuration: 7.0 },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toContain('VIEWS & DRIVE ONLINE — REBOOTING SHIELDS / WPN / TGT');
        expect(blackoutClassSet.has('hidden')).toBe(true);

        // Ready -> Both hidden
        client.updateHyperspaceUI({
          hyperspace: { state: 'ready' },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(true);
        expect(blackoutClassSet.has('hidden')).toBe(true);

        // Replay phase -> Blackout always hidden
        client.updateHyperspaceUI({
          hyperspace: { state: 'rebooting', rebootTimer: 1.0 },
        }, 'replay');
        expect(blackoutClassSet.has('hidden')).toBe(true);
      } finally {
        globalThis.document = origDoc;
      }

      // 3. buildReplayRenderSnapshot fidelity: preserves hyperspace, sensorsOnline, externalViewsOnline, shields.online
      const replaySnap = client.buildReplayRenderSnapshot({
        replayActive: true,
        replayFrame: {
          frameIndex: 10,
          ships: {
            alpha: {
              id: 'alpha',
              shields: { hp: { fore: 50 }, maxHp: { fore: 100 }, online: { fore: false, aft: false, port: false, starboard: false } },
              hyperspace: { state: 'rebooting', rebootTimer: 2.0 },
            },
          },
        },
      });

      expect(replaySnap.ships.alpha.hyperspace.state).toBe('rebooting');
      expect(replaySnap.ships.alpha.externalViewsOnline).toBe(false);
      expect(replaySnap.ships.alpha.sensorsOnline).toBe(false);
      expect(replaySnap.ships.alpha.shields.online.fore).toBe(false);

      client.destroy();
    });
  });

  describe('Phase 19 Slice 3: Edge Dampening Field UI & HUD Banner', () => {
    it('verifies public/index.html includes #dampening-field-banner right below #hyperspace-status-banner with zero emojis', () => {
      const htmlPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(htmlPath, 'utf8');

      // 1. #dampening-field-banner in hud-center
      expect(html).toContain('id="dampening-field-banner"');
      expect(html).toContain('class="alert-banner dampening-banner hidden"');
      expect(html).toContain('id="dampening-banner-text"');
      expect(html).toContain('DAMPENING FIELD — THRUST &amp; SPIN DAMPENED');

      // Verify ordering inside hud-center: hyperspace-status-banner then dampening-field-banner
      const hyperIdx = html.indexOf('id="hyperspace-status-banner"');
      const dampIdx = html.indexOf('id="dampening-field-banner"');
      expect(hyperIdx).toBeGreaterThan(0);
      expect(dampIdx).toBeGreaterThan(hyperIdx);

      // Verify zero decorative emojis in index.html (Rule #29)
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(html).not.toMatch(emojiRegex);
    });

    it('verifies public/css/style.css defines .dampening-banner amber-gold styling and zero emojis', () => {
      const cssPath = path.join(publicDir, 'css', 'style.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      expect(css).toContain('.dampening-banner {');
      expect(css).toContain('background: rgba(24, 18, 6, 0.78);');
      expect(css).toContain('border: 1px solid rgba(251, 191, 36, 0.55);');
      expect(css).toContain('color: #fbbf24;');
      expect(css).toContain('box-shadow: 0 0 12px rgba(245, 158, 11, 0.28);');

      expect(css).toContain('.dampening-banner .alert-pulse {');
      expect(css).toContain('background: #f59e0b;');
      expect(css).toContain('box-shadow: 0 0 8px rgba(245, 158, 11, 0.8);');

      // Verify zero decorative emojis in style.css (Rule #29)
      const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
      expect(css).not.toMatch(emojiRegex);
    });

    it('verifies BroadsideClient.prototype.updateDampeningFieldUI controls HUD banner visibility and text cleanly across states', () => {
      const client = new BroadsideClient();
      expect(typeof client.updateDampeningFieldUI).toBe('function');

      // Safe no-op when document is undefined
      const origDoc = globalThis.document;
      try {
        delete globalThis.document;
        expect(() => client.updateDampeningFieldUI({ dampeningFactor: 0.8 }, 'playing')).not.toThrow();
      } finally {
        globalThis.document = origDoc;
      }

      // Mock DOM environment
      const bannerClassSet = new Set(['hidden']);
      const bannerText = { textContent: '' };

      globalThis.document = {
        getElementById: (id) => {
          if (id === 'dampening-field-banner') {
            return {
              classList: {
                add: (c) => bannerClassSet.add(c),
                remove: (c) => bannerClassSet.delete(c),
                contains: (c) => bannerClassSet.has(c),
              },
            };
          }
          if (id === 'dampening-banner-text') return bannerText;
          return null;
        },
      };

      try {
        // 1. Normal active dampening in playing phase
        client.updateDampeningFieldUI({
          dampeningFactor: 0.6,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toBe('DAMPENING FIELD — -6.0%/s DRAG');

        // 2. inDampeningField fallback boolean when dampeningFactor omitted
        client.updateDampeningFieldUI({
          inDampeningField: true,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toBe('DAMPENING FIELD — -10.0%/s DRAG');

        // 3. dampeningFactor == 0 -> hidden
        client.updateDampeningFieldUI({
          dampeningFactor: 0,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 4. In lobby phase -> hidden even with high dampeningFactor
        client.updateDampeningFieldUI({
          dampeningFactor: 1.0,
        }, 'lobby');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 5. In replay phase -> hidden
        client.updateDampeningFieldUI({
          dampeningFactor: 0.9,
        }, 'replay');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 6. In gameover phase -> hidden
        client.updateDampeningFieldUI({
          dampeningFactor: 0.8,
        }, 'gameover');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 7. Ship destroyed -> hidden
        client.updateDampeningFieldUI({
          destroyed: true,
          dampeningFactor: 0.7,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 8. Warp transit (jumping) -> hidden
        client.updateDampeningFieldUI({
          dampeningFactor: 0.8,
          hyperspace: { state: 'jumping' },
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 9. Stage-0 reboot blackout (externalViewsOnline: false) -> hidden
        client.updateDampeningFieldUI({
          dampeningFactor: 0.8,
          externalViewsOnline: false,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(true);

        // 10. Stage-1 reboot (externalViewsOnline: true, factor: 0.45) -> visible
        client.updateDampeningFieldUI({
          dampeningFactor: 0.45,
          externalViewsOnline: true,
        }, 'playing');
        expect(bannerClassSet.has('hidden')).toBe(false);
        expect(bannerText.textContent).toBe('DAMPENING FIELD — -4.5%/s DRAG');
      } finally {
        globalThis.document = origDoc;
      }

      client.destroy();
    });
  });

  describe('Phase 22: Post-Battle & Disabled-Weapon Audio/Input Gating', () => {
    describe('SoundSynth railgun charge lifecycle & loop cleanup', () => {
      it('playRailgunCharge, stopRailgunCharge, and stopAllLoops lifecycle', () => {
        const sound = new SoundSynth();
        const mockAudioNodes = [];
        const createParam = () => ({
          value: 0,
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setTargetAtTime: vi.fn(),
        });

        const mockCtx = {
          currentTime: 1.0,
          sampleRate: 44100,
          createOscillator: () => {
            const osc = {
              type: 'sine',
              frequency: createParam(),
              connect: vi.fn(),
              disconnect: vi.fn(),
              start: vi.fn(),
              stop: vi.fn(),
            };
            mockAudioNodes.push(osc);
            return osc;
          },
          createGain: () => {
            const gain = {
              gain: createParam(),
              connect: vi.fn(),
              disconnect: vi.fn(),
            };
            mockAudioNodes.push(gain);
            return gain;
          },
          destination: {},
        };

        sound.ctx = mockCtx;

        // 1. First playRailgunCharge() returns true and creates active handle
        const started1 = sound.playRailgunCharge();
        expect(started1).toBe(true);
        expect(sound.railgunCharge).toBeDefined();
        const firstOsc = sound.railgunCharge.osc;
        const firstGain = sound.railgunCharge.gain;
        expect(firstOsc.start).toHaveBeenCalledTimes(1);

        // 2. Calling playRailgunCharge() a second time cancels/stops first oscillator instead of stacking
        const started2 = sound.playRailgunCharge();
        expect(started2).toBe(true);
        expect(sound.railgunCharge).toBeDefined();
        const secondOsc = sound.railgunCharge.osc;
        expect(secondOsc).not.toBe(firstOsc);
        expect(firstGain.gain.setTargetAtTime).toHaveBeenCalled();

        // 3. stopRailgunCharge() cleans up and returns true
        const stopped = sound.stopRailgunCharge();
        expect(stopped).toBe(true);
        expect(sound.railgunCharge).toBeNull();
        expect(secondOsc.stop).toBeDefined();

        // 4. Calling stopRailgunCharge() when idle safely returns false
        const stoppedIdle = sound.stopRailgunCharge();
        expect(stoppedIdle).toBe(false);

        // 5. stopAllLoops() stops railgun charge, engine, and warp loops without throwing
        expect(() => sound.stopAllLoops()).not.toThrow();
      });
    });

    describe('BroadsideClient post-battle & destroyed gating', () => {
      it('syncStationControllers deactivates all controllers during gameover, restarting, replayActive, outcome overlay, or destroyed', () => {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws', autoStartLoop: false });
        client.team = 'alpha';
        client.station = 'weapons';

        client.helm = { latestSnapshot: null, _lastShip: null, setActive: vi.fn(), updateHUD: vi.fn(), destroy: vi.fn() };
        client.weapons = { latestSnapshot: null, _lastShip: null, myTeam: '', setActive: vi.fn(), updateHUD: vi.fn(), destroy: vi.fn() };
        client.engineer = { latestSnapshot: null, ship: null, setActive: vi.fn(), updateHUD: vi.fn(), destroy: vi.fn() };

        // 1. Alive playing snapshot -> active station (weapons) activated, others deactivated
        const playingSnap = {
          state: 'playing',
          replayActive: false,
          ships: {
            alpha: { id: 'alpha', hullHp: 1000, destroyed: false },
            omega: { id: 'omega', hullHp: 1000, destroyed: false },
          },
        };

        client.syncStationControllers(playingSnap);
        expect(client.weapons.latestSnapshot).toBe(playingSnap);
        expect(client.weapons._lastShip).toBe(playingSnap.ships.alpha);
        expect(client.weapons.myTeam).toBe('alpha');
        expect(client.helm.latestSnapshot).toBe(playingSnap);
        expect(client.helm._lastShip).toBe(playingSnap.ships.alpha);
        expect(client.engineer.latestSnapshot).toBe(playingSnap);
        expect(client.engineer.ship).toBe(playingSnap.ships.alpha);

        expect(client.weapons.setActive).toHaveBeenCalledWith(true);
        expect(client.helm.setActive).toHaveBeenCalledWith(false);
        expect(client.engineer.setActive).toHaveBeenCalledWith(false);

        // 2. Terminal state: 'gameover' -> deactivates ALL
        client.weapons.setActive.mockClear();
        client.helm.setActive.mockClear();
        client.engineer.setActive.mockClear();
        const gameOverSnap = { ...playingSnap, state: 'gameover' };
        client.syncStationControllers(gameOverSnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);
        expect(client.helm.setActive).toHaveBeenCalledWith(false);
        expect(client.engineer.setActive).toHaveBeenCalledWith(false);

        // 3. Terminal state: 'restarting' -> deactivates ALL
        client.weapons.setActive.mockClear();
        const restartSnap = { ...playingSnap, state: 'restarting' };
        client.syncStationControllers(restartSnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);
        expect(client.helm.setActive).toHaveBeenCalledWith(false);
        expect(client.engineer.setActive).toHaveBeenCalledWith(false);

        // 4. replayActive: true -> deactivates ALL
        client.weapons.setActive.mockClear();
        const replaySnap = { ...playingSnap, state: 'gameover', replayActive: true };
        client.syncStationControllers(replaySnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);
        expect(client.helm.setActive).toHaveBeenCalledWith(false);
        expect(client.engineer.setActive).toHaveBeenCalledWith(false);

        // 5. replayActive flips true -> false while state === 'gameover' -> STAYS deactivated
        client.weapons.setActive.mockClear();
        const replayOffGameOverSnap = { ...playingSnap, state: 'gameover', replayActive: false };
        client.syncStationControllers(replayOffGameOverSnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);
        expect(client.helm.setActive).toHaveBeenCalledWith(false);
        expect(client.engineer.setActive).toHaveBeenCalledWith(false);

        // 6. Own ship destroyed: true -> deactivates ALL
        client.weapons.setActive.mockClear();
        const destroyedSnap = {
          state: 'playing',
          ships: {
            alpha: { id: 'alpha', hullHp: 1000, destroyed: true },
            omega: { id: 'omega', hullHp: 1000, destroyed: false },
          },
        };
        client.syncStationControllers(destroyedSnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);

        // 7. Own ship hullHp <= 0 -> deactivates ALL
        client.weapons.setActive.mockClear();
        const zeroHpSnap = {
          state: 'playing',
          ships: {
            alpha: { id: 'alpha', hullHp: 0, destroyed: false },
            omega: { id: 'omega', hullHp: 1000, destroyed: false },
          },
        };
        client.syncStationControllers(zeroHpSnap);
        expect(client.weapons.setActive).toHaveBeenCalledWith(false);

        // 8. #battle-outcome-overlay visible in DOM -> deactivates ALL even during 'playing' state
        const origDoc = globalThis.document;
        try {
          globalThis.document = {
            getElementById: (id) => {
              if (id === 'battle-outcome-overlay') {
                return {
                  classList: { contains: (cls) => cls === 'active' },
                  style: { display: 'flex' },
                };
              }
              return null;
            },
            querySelector: () => null,
            querySelectorAll: () => [],
          };
          client.weapons.setActive.mockClear();
          client.helm.setActive.mockClear();
          client.engineer.setActive.mockClear();
          client.syncStationControllers(playingSnap);
          expect(client.weapons.setActive).toHaveBeenCalledWith(false);
          expect(client.helm.setActive).toHaveBeenCalledWith(false);
          expect(client.engineer.setActive).toHaveBeenCalledWith(false);
        } finally {
          globalThis.document = origDoc;
        }

        client.destroy();
      });

      it('handleSnapshot triggers weapon event SFX only during playing, stays silent during gameover or replay, and stops active railgun charge', () => {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws', autoStartLoop: false });
        client.team = 'alpha';

        const soundSpy = {
          playLaserZap: vi.fn(),
          playRailgunFire: vi.fn(),
          playTorpedoLaunch: vi.fn(),
          playFlakDetonation: vi.fn(),
          playAtVolume: vi.fn((vol, fn) => fn()),
          stopRailgunCharge: vi.fn(),
          updateEngine: vi.fn(),
        };
        client.sound = soundSpy;

        const events = [
          { type: 'laser_fired', shipId: 'alpha' },
          { type: 'railgun_fired', shipId: 'alpha' },
          { type: 'torpedo_launched', shipId: 'alpha' },
          { type: 'flak_burst', shipId: 'alpha' },
        ];

        // 1. In 'playing' state -> triggers all weapon event SFX
        const playingSnap = {
          state: 'playing',
          replayActive: false,
          events,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.handleSnapshot(playingSnap);
        expect(soundSpy.playLaserZap).toHaveBeenCalledTimes(1);
        expect(soundSpy.playRailgunFire).toHaveBeenCalledTimes(1);
        expect(soundSpy.playTorpedoLaunch).toHaveBeenCalledTimes(1);
        expect(soundSpy.playFlakDetonation).toHaveBeenCalledTimes(1);

        // 2. In 'gameover' state -> stays silent
        soundSpy.playLaserZap.mockClear();
        soundSpy.playRailgunFire.mockClear();
        soundSpy.playTorpedoLaunch.mockClear();
        soundSpy.playFlakDetonation.mockClear();
        soundSpy.stopRailgunCharge.mockClear();

        const gameOverSnap = {
          state: 'gameover',
          replayActive: false,
          events,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.handleSnapshot(gameOverSnap);
        expect(soundSpy.playLaserZap).not.toHaveBeenCalled();
        expect(soundSpy.playRailgunFire).not.toHaveBeenCalled();
        expect(soundSpy.playTorpedoLaunch).not.toHaveBeenCalled();
        expect(soundSpy.playFlakDetonation).not.toHaveBeenCalled();
        // Stops active railgun charge on non-playing snapshot
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalled();

        // 3. In replayActive without replayFrame events -> stays silent
        soundSpy.stopRailgunCharge.mockClear();
        const replaySnap = {
          state: 'gameover',
          replayActive: true,
          events,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.handleSnapshot(replaySnap);
        expect(soundSpy.playLaserZap).not.toHaveBeenCalled();
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalled();

        // 4. Destroyed ship in 'playing' -> stops railgun charge
        soundSpy.stopRailgunCharge.mockClear();
        const destroyedSnap = {
          state: 'playing',
          replayActive: false,
          events: [],
          ships: { alpha: { id: 'alpha', hullHp: 0, destroyed: true } },
        };
        client.handleSnapshot(destroyedSnap);
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalled();

        client.destroy();
      });

      it('switchStation suppresses playConduitClick when battle ended or own ship is destroyed', () => {
        const client = new BroadsideClient({ wsUrl: 'ws://127.0.0.1:9999/ws', autoStartLoop: false });
        client.team = 'alpha';
        client.station = 'helm';

        const soundSpy = {
          playConduitClick: vi.fn(),
        };
        client.sound = soundSpy;

        // Normal playing with alive ship -> plays conduit click
        client.currentSnapshot = {
          state: 'playing',
          replayActive: false,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.switchStation('weapons');
        expect(soundSpy.playConduitClick).toHaveBeenCalledTimes(1);

        // Battle ended (state === 'gameover') -> suppressed
        soundSpy.playConduitClick.mockClear();
        client.currentSnapshot = {
          state: 'gameover',
          replayActive: false,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.switchStation('engineer');
        expect(soundSpy.playConduitClick).not.toHaveBeenCalled();

        // Replay active -> suppressed
        soundSpy.playConduitClick.mockClear();
        client.currentSnapshot = {
          state: 'playing',
          replayActive: true,
          ships: { alpha: { id: 'alpha', hullHp: 1000, destroyed: false } },
        };
        client.switchStation('helm');
        expect(soundSpy.playConduitClick).not.toHaveBeenCalled();

        // Ship destroyed -> suppressed
        soundSpy.playConduitClick.mockClear();
        client.currentSnapshot = {
          state: 'playing',
          replayActive: false,
          ships: { alpha: { id: 'alpha', hullHp: 0, destroyed: true } },
        };
        client.switchStation('weapons');
        expect(soundSpy.playConduitClick).not.toHaveBeenCalled();

        client.destroy();
      });
    });

    describe('WeaponsController gating & audio cleanup', () => {
      it('rejects firing/charging/torpedo/flak and skips playRailgunCharge when snapshot is terminal, ship destroyed, weapons offline, or outcome overlay visible', () => {
        const messages = [];
        const soundSpy = {
          playRailgunCharge: vi.fn(),
          stopRailgunCharge: vi.fn(),
        };
        const weapons = new WeaponsController({
          send: (msg) => messages.push(msg),
          sound: soundSpy,
        });
        weapons.isActive = true;
        weapons.myTeam = 'alpha';

        const normalShip = {
          id: 'alpha',
          hullHp: 1000,
          destroyed: false,
          weaponsOnline: true,
          powerMap: { weapons_laser: 1, weapons_railgun: 1, weapons_torpedo: 1 },
          weapons: {
            laserHardware: { health: 100 },
            railgunHardware: { health: 100 },
            torpedoHardware: { health: 100 },
            flakHardware: { health: 100 },
            chargeProgress: 0,
            magazine: 5,
            flakCooldown: 0,
            cooldown: 0,
            railgunCooldown: 0,
            torpedoCooldown: 0,
            overheated: false,
          },
        };

        weapons._lastShip = normalShip;

        const terminalSnapshots = [
          { state: 'gameover', replayActive: false },
          { state: 'restarting', replayActive: false },
          { state: 'lobby', replayActive: false },
          { state: 'playing', replayActive: true },
        ];

        for (const snap of terminalSnapshots) {
          weapons.latestSnapshot = snap;
          messages.length = 0;
          soundSpy.playRailgunCharge.mockClear();

          expect(weapons.canHandleInput()).toBe(false);

          weapons.setLaserFiring(true);
          expect(weapons.isFiringLaser).toBe(false);

          weapons.startRailgunCharge();
          expect(weapons.isChargingRailgun).toBe(false);
          expect(soundSpy.playRailgunCharge).not.toHaveBeenCalled();

          weapons.launchTorpedo();
          weapons.fireFlak();
          expect(messages.length).toBe(0);
        }

        // Own ship destroyed or zero hp
        weapons.latestSnapshot = { state: 'playing', replayActive: false };
        weapons._lastShip = { ...normalShip, destroyed: true };
        expect(weapons.canHandleInput()).toBe(false);

        weapons._lastShip = { ...normalShip, destroyed: false, hullHp: 0 };
        expect(weapons.canHandleInput()).toBe(false);

        // weaponsOnline === false
        weapons._lastShip = { ...normalShip, weaponsOnline: false };
        expect(weapons.areWeaponsPermitted()).toBe(false);
        messages.length = 0;
        weapons.setLaserFiring(true);
        weapons.startRailgunCharge();
        weapons.launchTorpedo();
        weapons.fireFlak();
        expect(messages.length).toBe(0);

        // #battle-outcome-overlay visible in DOM
        weapons._lastShip = normalShip;
        const origDoc = globalThis.document;
        try {
          globalThis.document = {
            getElementById: (id) => {
              if (id === 'battle-outcome-overlay') {
                return {
                  classList: { contains: () => false }, // Not hidden!
                  style: { display: 'flex' },
                };
              }
              return null;
            },
          };
          expect(weapons._isOutcomeOverlayVisible()).toBe(true);
          expect(weapons.canHandleInput()).toBe(false);
        } finally {
          globalThis.document = origDoc;
        }

        weapons.destroy();
      });

      it('per-weapon guards for laser, railgun, torpedo, and flak (preserving unpowered pre-charged railgun bypass)', () => {
        const weapons = new WeaponsController({ send: () => {} });
        weapons.isActive = true;
        weapons.latestSnapshot = { state: 'playing', replayActive: false };

        const baseShip = {
          weaponsOnline: true,
          powerMap: { weapons_laser: 1, weapons_railgun: 1, weapons_torpedo: 1 },
          weapons: {
            laserHardware: { health: 100 },
            railgunHardware: { health: 100 },
            torpedoHardware: { health: 100 },
            flakHardware: { health: 100 },
            chargeProgress: 0,
            magazine: 5,
            flakCooldown: 0,
            overheated: false,
          },
        };

        // 1. Laser guards
        expect(weapons.canFireLaser(baseShip)).toBe(true);
        expect(weapons.canFireLaser({ ...baseShip, powerMap: { ...baseShip.powerMap, weapons_laser: 0 } })).toBe(false);
        expect(weapons.canFireLaser({ ...baseShip, weapons: { ...baseShip.weapons, laserHardware: { health: 0 } } })).toBe(false);
        expect(weapons.canFireLaser({ ...baseShip, weapons: { ...baseShip.weapons, overheated: true } })).toBe(true);

        // 2. Railgun charging guards
        expect(weapons.canChargeRailgun(baseShip)).toBe(true);
        expect(weapons.canChargeRailgun({ ...baseShip, powerMap: { ...baseShip.powerMap, weapons_railgun: 0 } })).toBe(false);
        expect(weapons.canChargeRailgun({ ...baseShip, weapons: { ...baseShip.weapons, railgunHardware: { health: 0 } } })).toBe(false);
        expect(weapons.canChargeRailgun({ ...baseShip, weapons: { ...baseShip.weapons, chargeProgress: 1.0 } })).toBe(false);

        // 3. Pre-charged unpowered railgun bypass preserved
        const preChargedUnpowered = {
          ...baseShip,
          powerMap: { ...baseShip.powerMap, weapons_railgun: 0 },
          weapons: { ...baseShip.weapons, chargeProgress: 1.0, railgunCooldown: 0 },
        };
        expect(weapons.canReleaseRailgun(preChargedUnpowered)).toBe(true);

        // ShiftLeft/ShiftRight pre-charged release even when weapons_railgun: 0
        weapons.latestSnapshot = { state: 'playing', replayActive: false };
        weapons._lastShip = preChargedUnpowered;
        const releaseSpy = vi.spyOn(weapons, 'releaseRailgun');
        const preventDefault = vi.fn();
        weapons.handleKeyDown({ code: 'ShiftLeft', repeat: false, preventDefault });
        expect(preventDefault).toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        releaseSpy.mockClear();
        weapons.handleKeyDown({ code: 'ShiftRight', repeat: false, preventDefault });
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        releaseSpy.mockRestore();

        // 4. Torpedo guards
        expect(weapons.canLaunchTorpedo(baseShip)).toBe(true);
        expect(weapons.canLaunchTorpedo({ ...baseShip, powerMap: { ...baseShip.powerMap, weapons_torpedo: 0 } })).toBe(false);
        expect(weapons.canLaunchTorpedo({ ...baseShip, weapons: { ...baseShip.weapons, magazine: 0 } })).toBe(false);

        // 5. Flak guards
        expect(weapons.canFireFlak(baseShip)).toBe(true);
        expect(weapons.canFireFlak({ ...baseShip, weapons: { ...baseShip.weapons, flakHardware: { health: 0 } } })).toBe(false);
        expect(weapons.canFireFlak({ ...baseShip, weapons: { ...baseShip.weapons, flakCooldown: 1.5 } })).toBe(false);

        weapons.destroy();
      });

      it('calls sound.stopRailgunCharge across cancellation flows, handles post-battle key up, and suppresses repeated inputs', () => {
        const messages = [];
        const soundSpy = {
          playRailgunCharge: vi.fn(),
          stopRailgunCharge: vi.fn(),
        };
        const weapons = new WeaponsController({
          send: (msg) => messages.push(msg),
          sound: soundSpy,
        });
        weapons.isActive = true;
        weapons.latestSnapshot = { state: 'playing', replayActive: false };
        weapons._lastShip = {
          weaponsOnline: true,
          powerMap: { weapons_railgun: 1 },
          weapons: { railgunHardware: { health: 100 }, chargeProgress: 0.5 },
        };

        // 1. releaseRailgun() calls sound.stopRailgunCharge()
        soundSpy.stopRailgunCharge.mockClear();
        weapons.isChargingRailgun = true;
        weapons.releaseRailgun();
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalled();

        // 2. setActive(false) calls sound.stopRailgunCharge(true)
        soundSpy.stopRailgunCharge.mockClear();
        weapons.setActive(false);
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalledWith(true);
        weapons.setActive(true);

        // 3. _cancelPointerFireWithoutFiring() calls sound.stopRailgunCharge(true)
        soundSpy.stopRailgunCharge.mockClear();
        weapons._cancelPointerFireWithoutFiring();
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalledWith(true);

        // 4. destroy() calls sound.stopRailgunCharge(true)
        soundSpy.stopRailgunCharge.mockClear();
        weapons.destroy();
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalledWith(true);

        // 5. handleKeyUp when battle ended mid-hold does not send releaseRailgun: true
        const weapons2 = new WeaponsController({
          send: (msg) => messages.push(msg),
          sound: soundSpy,
        });
        weapons2.isActive = true;
        weapons2.latestSnapshot = { state: 'playing', replayActive: false };
        weapons2._lastShip = {
          weaponsOnline: true,
          powerMap: { weapons_railgun: 1 },
          weapons: { railgunHardware: { health: 100 }, chargeProgress: 0.5 },
        };
        weapons2.startRailgunCharge();
        expect(weapons2.isChargingRailgun).toBe(true);

        // Match ends mid-hold
        weapons2.latestSnapshot = { state: 'gameover', replayActive: false };
        messages.length = 0;
        soundSpy.stopRailgunCharge.mockClear();

        weapons2.handleKeyUp({ code: 'ShiftLeft' });
        expect(weapons2.isChargingRailgun).toBe(false);
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalledWith(true);
        // Verify releaseRailgun message was NOT sent
        expect(messages.some(m => m.releaseRailgun)).toBe(false);

        // 6. updateHUD when weapons become unpermitted stops railgun charge
        weapons2.latestSnapshot = { state: 'playing', replayActive: false };
        weapons2.isChargingRailgun = true;
        soundSpy.stopRailgunCharge.mockClear();
        weapons2.updateHUD({ id: 'alpha', weaponsOnline: false });
        expect(weapons2.isChargingRailgun).toBe(false);
        expect(soundSpy.stopRailgunCharge).toHaveBeenCalledWith(true);

        // 7. Suppresses repeated inputs across ShiftLeft, ShiftRight, Space, KeyT, KeyF on live controller
        weapons2.latestSnapshot = { state: 'playing', replayActive: false };
        weapons2._lastShip = {
          weaponsOnline: true,
          powerMap: { weapons_railgun: 1, weapons_laser: 1, weapons_torpedo: 1 },
          weapons: {
            laserHardware: { health: 100 },
            railgunHardware: { health: 100 },
            torpedoHardware: { health: 100 },
            flakHardware: { health: 100 },
            chargeProgress: 0,
            railgunCooldown: 0,
            magazine: 5,
            flakCooldown: 0,
          },
        };
        weapons2.isChargingRailgun = false;
        soundSpy.playRailgunCharge.mockClear();
        messages.length = 0;

        // ShiftLeft with repeat: false DOES trigger railgun charge
        weapons2.handleKeyDown({ code: 'ShiftLeft', repeat: false, preventDefault: vi.fn() });
        expect(soundSpy.playRailgunCharge).toHaveBeenCalledTimes(1);
        expect(weapons2.isChargingRailgun).toBe(true);

        // ShiftLeft with repeat: true does NOT trigger duplicate charge
        soundSpy.playRailgunCharge.mockClear();
        messages.length = 0;
        const laserSpy = vi.spyOn(weapons2, 'setLaserFiring');
        const torpSpy = vi.spyOn(weapons2, 'launchTorpedo');
        const flakSpy = vi.spyOn(weapons2, 'fireFlak');

        weapons2.handleKeyDown({ code: 'ShiftLeft', repeat: true, preventDefault: vi.fn() });
        weapons2.handleKeyDown({ code: 'ShiftRight', repeat: true, preventDefault: vi.fn() });
        weapons2.handleKeyDown({ code: 'Space', repeat: true, preventDefault: vi.fn() });
        weapons2.handleKeyDown({ code: 'KeyT', repeat: true, preventDefault: vi.fn() });
        weapons2.handleKeyDown({ code: 'KeyF', repeat: true, preventDefault: vi.fn() });

        expect(soundSpy.playRailgunCharge).not.toHaveBeenCalled();
        expect(laserSpy).not.toHaveBeenCalled();
        expect(torpSpy).not.toHaveBeenCalled();
        expect(flakSpy).not.toHaveBeenCalled();
        expect(messages.length).toBe(0);

        laserSpy.mockRestore();
        torpSpy.mockRestore();
        flakSpy.mockRestore();

        weapons2.destroy();
      });
    });

    describe('HelmController gating & audio cleanup', () => {
      it('blocks actions and suppresses SFX when match concluded, replay active, ship destroyed, or outcome overlay visible', () => {
        const messages = [];
        const soundSpy = {
          playRcsHiss: vi.fn(),
          playConduitClick: vi.fn(),
        };
        const helm = new HelmController({
          send: (msg) => messages.push(msg),
          sound: soundSpy,
        });
        helm.isActive = true;

        const terminalStates = [
          { state: 'gameover', replayActive: false },
          { state: 'restarting', replayActive: false },
          { state: 'playing', replayActive: true },
        ];

        for (const snap of terminalStates) {
          helm.latestSnapshot = snap;
          helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false };
          messages.length = 0;
          soundSpy.playRcsHiss.mockClear();
          soundSpy.playConduitClick.mockClear();

          expect(helm.canHandleInput()).toBe(false);

          helm.toggleSas();
          helm.stopRoll();
          helm.toggleTurnAndBurn();
          helm.setAutoOrient('prograde');
          helm.triggerHyperspace();

          expect(messages.length).toBe(0);
          expect(soundSpy.playRcsHiss).not.toHaveBeenCalled();
          expect(soundSpy.playConduitClick).not.toHaveBeenCalled();
        }

        // Own ship destroyed or hullHp <= 0
        helm.latestSnapshot = { state: 'playing', replayActive: false };
        helm._lastShip = { id: 'alpha', hullHp: 0, destroyed: true };
        expect(helm.canHandleInput()).toBe(false);

        // #battle-outcome-overlay visible
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false };
        const origDoc = globalThis.document;
        try {
          globalThis.document = {
            getElementById: (id) => {
              if (id === 'battle-outcome-overlay') {
                return {
                  classList: { contains: () => false },
                  style: { display: 'block' },
                };
              }
              return null;
            },
          };
          expect(helm._isBlockedByState()).toBe(true);
          expect(helm.canHandleInput()).toBe(false);
        } finally {
          globalThis.document = origDoc;
        }

        // Specific stopRoll guards: hyperspace jumping, rebooting < 4.0s, or rcs_thrusters === 0
        helm.latestSnapshot = { state: 'playing', replayActive: false };
        soundSpy.playRcsHiss.mockClear();
        messages.length = 0;

        // Jumping
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false, hyperspace: { state: 'jumping' } };
        helm.stopRoll();
        expect(messages.length).toBe(0);
        expect(soundSpy.playRcsHiss).not.toHaveBeenCalled();

        // Rebooting < 4.0s
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false, hyperspace: { state: 'rebooting', rebootTimer: 2.0, stage1Sec: 4.0 } };
        helm.stopRoll();
        expect(messages.length).toBe(0);
        expect(soundSpy.playRcsHiss).not.toHaveBeenCalled();

        // rcs_thrusters === 0
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false, powerMap: { rcs_thrusters: 0 } };
        helm.stopRoll();
        expect(messages.length).toBe(0);
        expect(soundSpy.playRcsHiss).not.toHaveBeenCalled();

        // Normal stopRoll works
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false, powerMap: { rcs_thrusters: 1 } };
        helm.stopRoll();
        expect(messages.length).toBe(1);
        expect(messages[0].stopRoll).toBe(true);
        expect(soundSpy.playRcsHiss).toHaveBeenCalledTimes(1);

        helm.destroy();
      });

      it('handleKeyUp clears stuck keys cleanly without sending network messages when blocked', () => {
        const messages = [];
        const helm = new HelmController({ send: (msg) => messages.push(msg) });
        helm.isActive = true;

        // Set pressed keys
        helm.keys.KeyW = true;
        helm.keys.KeyA = true;
        helm.keys.KeyQ = true;
        helm.recomputeState();

        // Block controller
        helm.latestSnapshot = { state: 'gameover', replayActive: false };
        expect(helm.canHandleInput()).toBe(false);

        // Key releases
        helm.handleKeyUp({ code: 'KeyW' });
        expect(helm.keys.KeyW).toBe(false);
        expect(messages.length).toBe(0);

        helm.handleKeyUp({ code: 'KeyA' });
        expect(helm.keys.KeyA).toBe(false);
        expect(messages.length).toBe(0);

        helm.handleKeyUp({ code: 'KeyQ' });
        expect(helm.keys.KeyQ).toBe(false);
        expect(messages.length).toBe(0);

        expect(helm.state.rcsForward).toBe(0);
        expect(helm.state.turn).toBe(0);
        expect(helm.state.strafe).toBe(0);

        helm.destroy();
      });

      it('bindThumbstick mouse dragging sets stick axes during play and resets cleanly when blocked or destroyed', () => {
        const messages = [];
        const helm = new HelmController({ send: (msg) => messages.push(msg) });
        helm.isActive = true;
        helm.latestSnapshot = { state: 'playing', replayActive: false };
        helm._lastShip = { id: 'alpha', hullHp: 1000, destroyed: false };
        expect(helm.canHandleInput()).toBe(true);

        const knob = { style: { transform: '' } };
        const elementListeners = {};
        const windowListeners = {};

        const element = {
          querySelector: (sel) => (sel === '.stick-knob' ? knob : null),
          getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 100 }), // center: (150, 150)
          addEventListener: (type, fn) => { elementListeners[type] = fn; },
          removeEventListener: (type, fn) => { if (elementListeners[type] === fn) delete elementListeners[type]; },
        };

        const mockWindow = {
          addEventListener: (type, fn) => { windowListeners[type] = fn; },
          removeEventListener: (type, fn) => { if (windowListeners[type] === fn) delete windowListeners[type]; },
        };

        const origWindow = globalThis.window;
        try {
          globalThis.window = mockWindow;

          helm.bindThumbstick(element, helm.touchLeft, (normX, normY) => {
            helm.leftStickForward = Math.max(-1, Math.min(1, -normY));
            helm.leftStickStrafe = normX;
            helm.recomputeState();
            helm.emitHelmInput();
          }, 1.0);

          // 1. Mouse down initiates drag and activates stick
          const preventDefault = vi.fn();
          elementListeners.mousedown({ button: 0, clientX: 150, clientY: 150, preventDefault });
          expect(preventDefault).toHaveBeenCalled();
          expect(helm.touchLeft.active).toBe(true);
          expect(helm.touchLeft.id).toBe('mouse');

          // 2. Mouse move sets forward and strafe axes on left stick during active play
          messages.length = 0;
          // Center is (150, 150). Move to (180, 110) -> dx = +30 (strafe stbd), dy = -40 (forward)
          // dist = 50px (maxRadius). normX = 30/50 = 0.6, normY = -40/50 = -0.8
          windowListeners.mousemove({ clientX: 180, clientY: 110, preventDefault: vi.fn() });

          expect(helm.leftStickForward).toBeCloseTo(0.8, 2);
          expect(helm.leftStickStrafe).toBeCloseTo(0.6, 2);
          expect(helm.state.rcsForward).toBeCloseTo(0.8, 2);
          expect(helm.state.strafe).toBeCloseTo(0.6, 2);
          expect(knob.style.transform).not.toBe('translate3d(0px, 0px, 0)');
          expect(messages.length).toBeGreaterThan(0);
          expect(messages[messages.length - 1].rcsForward).toBeCloseTo(0.8, 2);

          // 3. Blocked by gameover while mouse is held -> mousemove calls resetKnob and zeroes axes
          helm.latestSnapshot = { state: 'gameover', replayActive: false };
          expect(helm.canHandleInput()).toBe(false);

          windowListeners.mousemove({ clientX: 185, clientY: 105, preventDefault: vi.fn() });
          expect(helm.touchLeft.active).toBe(false);
          expect(helm.leftStickForward).toBe(0);
          expect(helm.leftStickStrafe).toBe(0);
          expect(helm.state.rcsForward).toBe(0);
          expect(helm.state.strafe).toBe(0);
          expect(knob.style.transform).toBe('translate3d(0px, 0px, 0)');

          // 4. step() no-ops while blocked by gameover
          const prevThrottle = helm.throttleSetting;
          helm.keys.ShiftLeft = true;
          helm.step(0.016);
          expect(helm.throttleSetting).toBe(prevThrottle);

          // 5. Blocked by destroyed -> step() no-ops
          helm.latestSnapshot = { state: 'playing', replayActive: false };
          helm._lastShip = { id: 'alpha', hullHp: 0, destroyed: true };
          expect(helm.canHandleInput()).toBe(false);
          helm.step(0.016);
          expect(helm.throttleSetting).toBe(prevThrottle);
          helm.keys.ShiftLeft = false;

          // 6. Mouse up completes cleanly
          windowListeners.mouseup();
          expect(helm.touchLeft.active).toBe(false);

          helm.destroy();
        } finally {
          globalThis.window = origWindow;
        }
      });
    });

    describe('EngineerController gating & audio cleanup', () => {
      it('blocks actions and suppresses SFX when match concluded, replay active, ship destroyed, or outcome overlay visible', () => {
        const messages = [];
        const soundSpy = {
          playConduitClick: vi.fn(),
          playCapacitorDischarge: vi.fn(),
          playBreakerToggle: vi.fn(),
        };
        const eng = new EngineerController({
          send: (msg) => messages.push(msg),
          sound: soundSpy,
        });
        eng.isActive = true;

        const terminalStates = [
          { state: 'gameover', replayActive: false },
          { state: 'restarting', replayActive: false },
          { state: 'playing', replayActive: true },
        ];

        for (const snap of terminalStates) {
          eng.latestSnapshot = snap;
          eng.ship = { id: 'alpha', hullHp: 1000, destroyed: false };
          messages.length = 0;
          soundSpy.playConduitClick.mockClear();
          soundSpy.playCapacitorDischarge.mockClear();
          soundSpy.playBreakerToggle.mockClear();

          expect(eng.canHandleInput()).toBe(false);

          expect(eng.rotateTile(1, 1)).toBe(false);
          expect(eng.dischargeCapacitor(2, 2)).toBe(false);
          expect(eng.assignDroneToTile(1, 1, 1)).toBe(false);
          expect(eng.assignDroneToSubsystem('weapons_laser')).toBe(false);
          expect(eng.recallDrone(1)).toBe(false);
          expect(eng.toggleSystemBoost('weapons_laser')).toBe(false);

          expect(messages.length).toBe(0);
          expect(soundSpy.playConduitClick).not.toHaveBeenCalled();
          expect(soundSpy.playCapacitorDischarge).not.toHaveBeenCalled();
          expect(soundSpy.playBreakerToggle).not.toHaveBeenCalled();
        }

        // Own ship destroyed or hullHp <= 0
        eng.latestSnapshot = { state: 'playing', replayActive: false };
        eng.ship = { id: 'alpha', hullHp: 0, destroyed: true };
        expect(eng.canHandleInput()).toBe(false);

        // #battle-outcome-overlay visible
        eng.ship = { id: 'alpha', hullHp: 1000, destroyed: false };
        const origDoc = globalThis.document;
        try {
          globalThis.document = {
            getElementById: (id) => {
              if (id === 'battle-outcome-overlay') {
                return {
                  classList: { contains: () => false },
                  style: { display: 'flex' },
                };
              }
              return null;
            },
          };
          expect(eng._isBlockedByState()).toBe(true);
          expect(eng.canHandleInput()).toBe(false);
        } finally {
          globalThis.document = origDoc;
        }

        eng.destroy();
      });

      it('updateHUD updates this.ship safely in headless mode without document', () => {
        const eng = new EngineerController({ send: () => {} });
        const origDoc = globalThis.document;
        try {
          delete globalThis.document;
          const destroyedShip = { id: 'alpha', hullHp: 0, destroyed: true, grid: { tiles: [] } };
          expect(() => eng.updateHUD(destroyedShip)).not.toThrow();
          expect(eng.ship).toBe(destroyedShip);
        } finally {
          globalThis.document = origDoc;
        }
        eng.destroy();
      });
    });
  });
});
