/**
 * BROADSIDE HYPERION — Unit Tests for SpaceRenderer (3D Three.js) & Spectator View
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  SpaceRenderer,
  BSG_HULL_RADII,
  isExternalBlackoutActive,
  getHullPanelDataTexture,
} from '../../public/js/renderer.js';
import {
  getAsteroidSkinBitmaps,
  getOreCrystalSkinBitmaps,
  getShipHullSkinBitmaps,
  getArmorPlateSkinBitmaps,
  getTeamLiverySkinBitmaps,
  getGreebleSkinBitmaps,
  getCanopyGlassSkinBitmaps,
  getNozzleSkinBitmaps,
  getRadiatorSkinBitmaps,
  getShieldHexSkinBitmap,
  getPlumePlasmaSkinBitmap,
  getDebrisSkinBitmaps,
  getMineSkinBitmaps,
  getDerelictHullSkinBitmaps,
  getSolarPanelSkinBitmaps,
  getHazardStripeSkinBitmaps,
  getAccretionDiskSkinBitmap,
  getNebulaCloudSkinBitmap,
  getTorpedoSkinBitmaps,
} from '../../public/js/textures.js';
import {
  SpectatorApp,
  SPECTATOR_MUSIC_TRACKS,
  DEFAULT_MUSIC_VOLUME,
  MUSIC_VOLUME_STEP,
} from '../../public/js/spectator.js';

function createMockContext() {
  const noop = vi.fn();
  const gradMock = { addColorStop: vi.fn() };
  return {
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    rect: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    fill: noop,
    stroke: noop,
    setLineDash: noop,
    fillText: noop,
    createRadialGradient: vi.fn(() => gradMock),
    createLinearGradient: vi.fn(() => gradMock),
    fillStyle: '#000000',
    strokeStyle: '#ffffff',
    lineWidth: 1,
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1.0,
    font: '',
    textAlign: '',
  };
}

function createMockCanvas(width = 1280, height = 720) {
  const ctx = createMockContext();
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: vi.fn(() => ctx),
    getBoundingClientRect: vi.fn(() => ({ width, height, left: 0, top: 0 })),
  };
}

describe('SpaceRenderer (public/js/renderer.js)', () => {
  it('instantiates cleanly with canvas, mock context, and authoritative 3D scene', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    expect(renderer).toBeDefined();
    expect(renderer.canvas).toBe(canvas);

    // Verify Three.js 3D authoritative scene and camera graph
    expect(renderer.scene).toBeDefined();
    expect(renderer.scene.isScene).toBe(true);
    expect(renderer.camera3d).toBeDefined();
    expect(renderer.camera3d.isPerspectiveCamera).toBe(true);

    // Verify 3D lighting is initialized in the scene
    const hasLight = renderer.scene.children.some(child => child.isLight);
    expect(hasLight).toBe(true);

    // Parallax background items
    expect(renderer.stars.length).toBeGreaterThan(50);
    expect(renderer.dustSpecks.length).toBeGreaterThan(30);

    // Ensure drawAsteroidShadow is completely removed
    expect(renderer.drawAsteroidShadow).toBeUndefined();
  });

  it('resizes canvas buffer and transforms DPI scale', () => {
    const canvas = createMockCanvas(1920, 1080);
    const renderer = new SpaceRenderer(canvas);

    renderer.resize();
    expect(canvas.getContext).toHaveBeenCalledWith('2d', expect.any(Object));
    expect(renderer.camera3d.aspect).toBeCloseTo(1920 / 1080, 2);
  });

  it('builds 3D ship meshes for corvette, frigate, and dreadnought with complete articulated hardware', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const classes = ['corvette', 'frigate', 'dreadnought'];
    for (const hullClass of classes) {
      const mesh = renderer.createShipMesh3D(hullClass, 'alpha');
      expect(mesh).toBeDefined();

      // Child hullRollGroup & shieldGroup
      expect(mesh.hullRollGroup).toBeDefined();
      expect(mesh.hullRollGroup.name).toBe('hullRollGroup');
      expect(mesh.shieldGroup).toBeDefined();
      expect(mesh.shieldGroup.name).toBe('shieldGroup');

      // 3D Rotating & Recoiling Turret Mount (turretGroup)
      expect(mesh.turretGroup).toBeDefined();
      expect(mesh.turretGroup.name).toBe('turretGroup');

      // 6 Physical 3D RCS Thruster Pods (rcsPods)
      expect(mesh.rcsPods).toBeDefined();
      expect(mesh.rcsPods.get('bowPort')).toBeDefined();
      expect(mesh.rcsPods.get('bowStarboard')).toBeDefined();
      expect(mesh.rcsPods.get('sternPort')).toBeDefined();
      expect(mesh.rcsPods.get('sternStarboard')).toBeDefined();
      expect(mesh.rcsPods.get('dorsalRoll')).toBeDefined();
      expect(mesh.rcsPods.get('ventralRoll')).toBeDefined();

      // 3D Glowing Radiator Material
      expect(mesh.radiatorMaterial).toBeDefined();
      expect(mesh.radiatorMaterial.isMaterial).toBe(true);

      // Shield materials use THREE.FrontSide, depthWrite: false, and default opacities
      expect(mesh.shieldQuads).toBeDefined();
      for (const q of Object.values(mesh.shieldQuads)) {
        expect(q.surface.material.side).toBe(THREE.FrontSide);
        expect(q.surface.material.depthWrite).toBe(false);
        expect(q.surface.material.opacity).toBeCloseTo(0.10, 2);

        expect(q.wire.material.depthWrite).toBe(false);
        expect(q.wire.material.opacity).toBeCloseTo(0.16, 2);
      }
    }
  });

  it('syncShips3D sets ultra-clear bridge opacity in helm_pov and weapons_pov for own ship and translucent opacity for spectator/enemies', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const shipAlpha = {
      team: 'alpha',
      hullClass: 'frigate',
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
    };
    const shipOmega = {
      team: 'omega',
      hullClass: 'frigate',
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
    };

    // 1. Own ship in helm_pov
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'helm_pov', myShipTeam: 'alpha' }
    );
    const alphaMeshHelm = renderer.shipMeshes.get('alpha');
    const omegaMeshHelm = renderer.shipMeshes.get('omega');

    // Alpha (own ship) should have ultra-clear bridge glass: surface <= 0.05, wire <= 0.12
    const alphaForeHelm = alphaMeshHelm.shieldQuads.fore;
    expect(alphaForeHelm.surface.material.opacity).toBeLessThanOrEqual(0.05);
    expect(alphaForeHelm.wire.material.opacity).toBeLessThanOrEqual(0.12);

    // Omega (enemy ship) should have crisp translucent opacity: surface > 0.05, wire > 0.12
    const omegaForeHelm = omegaMeshHelm.shieldQuads.fore;
    expect(omegaForeHelm.surface.material.opacity).toBeGreaterThan(0.05);
    expect(omegaForeHelm.wire.material.opacity).toBeGreaterThan(0.12);

    // 2. Own ship in weapons_pov
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'weapons_pov', myShipTeam: 'alpha' }
    );
    expect(alphaForeHelm.surface.material.opacity).toBeLessThanOrEqual(0.05);
    expect(alphaForeHelm.wire.material.opacity).toBeLessThanOrEqual(0.12);

    // 3. Spectator mode: both ships have crisp translucent opacity
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'spectator', myShipTeam: 'alpha' }
    );
    expect(alphaForeHelm.surface.material.opacity).toBeGreaterThan(0.05);
    expect(alphaForeHelm.wire.material.opacity).toBeGreaterThan(0.12);
  });

  it('hides own-ship hull while keeping shields visible with DoubleSide material in helm_pov and weapons_pov', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const shipAlpha = {
      team: 'alpha',
      hullClass: 'frigate',
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
    };
    const shipOmega = {
      team: 'omega',
      hullClass: 'frigate',
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
    };

    // 1. In helm_pov with myShipTeam: 'alpha'
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'helm_pov', myShipTeam: 'alpha' }
    );
    const alphaMesh = renderer.shipMeshes.get('alpha');
    const omegaMesh = renderer.shipMeshes.get('omega');

    // Alpha (own ship): shieldGroup is visible
    expect(alphaMesh.shieldGroup.visible).toBe(true);
    for (const qKey of ['fore', 'aft', 'port', 'starboard']) {
      expect(alphaMesh.shieldQuads[qKey].group.visible).toBe(true);
      expect(alphaMesh.shieldQuads[qKey].surface.material.side).toBe(THREE.DoubleSide);
    }
    // All other direct children of Alpha's hullRollGroup are hidden
    const alphaNonShieldChildren = alphaMesh.hullRollGroup.children.filter((c) => c !== alphaMesh.shieldGroup);
    expect(alphaNonShieldChildren.length).toBeGreaterThan(0);
    for (const child of alphaNonShieldChildren) {
      expect(child.visible).toBe(false);
    }

    // Omega (enemy ship): all direct children of hullRollGroup are visible, shields use FrontSide
    expect(omegaMesh.hullRollGroup.children.length).toBeGreaterThan(0);
    for (const child of omegaMesh.hullRollGroup.children) {
      expect(child.visible).toBe(true);
    }
    for (const qKey of ['fore', 'aft', 'port', 'starboard']) {
      expect(omegaMesh.shieldQuads[qKey].group.visible).toBe(true);
      expect(omegaMesh.shieldQuads[qKey].surface.material.side).toBe(THREE.FrontSide);
    }

    // 2. In weapons_pov with myShipTeam: 'alpha'
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'weapons_pov', myShipTeam: 'alpha' }
    );
    expect(alphaMesh.shieldGroup.visible).toBe(true);
    for (const child of alphaNonShieldChildren) {
      expect(child.visible).toBe(false);
    }
    for (const qKey of ['fore', 'aft', 'port', 'starboard']) {
      expect(alphaMesh.shieldQuads[qKey].surface.material.side).toBe(THREE.DoubleSide);
    }

    // 3. Switching back to cameraMode: 'spectator' restores visibility and FrontSide
    renderer.syncShips3D(
      { alpha: shipAlpha, omega: shipOmega },
      { cameraMode: 'spectator', myShipTeam: 'alpha' }
    );
    for (const child of alphaMesh.hullRollGroup.children) {
      expect(child.visible).toBe(true);
    }
    for (const qKey of ['fore', 'aft', 'port', 'starboard']) {
      expect(alphaMesh.shieldQuads[qKey].surface.material.side).toBe(THREE.FrontSide);
    }
  });

  it('renders fallback 2D with hideHull on own ship in helm_pov and weapons_pov while drawing shields for both', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const snapshot = {
      tick: 1,
      state: 'playing',
      ships: {
        alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -100, y: 0 }, angle: 0, shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } } },
        omega: { team: 'omega', hullClass: 'frigate', pos: { x: 100, y: 0 }, angle: Math.PI, shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } } },
      },
    };

    const drawHullPlatesSpy = vi.spyOn(renderer, 'drawHullPlates');
    const drawHexShieldsSpy = vi.spyOn(renderer, 'drawHexagonalShields');

    // 1. helm_pov
    drawHullPlatesSpy.mockClear();
    drawHexShieldsSpy.mockClear();
    renderer.renderFallback2D(snapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'helm_pov', snapshot.ships.alpha);

    // drawHullPlates should be called once (only for omega)
    expect(drawHullPlatesSpy).toHaveBeenCalledTimes(1);
    expect(drawHullPlatesSpy).toHaveBeenCalledWith(expect.any(Object), snapshot.ships.omega, 'frigate', '#f43f5e');

    // drawHexagonalShields should be called twice (for both alpha and omega)
    expect(drawHexShieldsSpy).toHaveBeenCalledTimes(2);

    // 2. weapons_pov
    drawHullPlatesSpy.mockClear();
    drawHexShieldsSpy.mockClear();
    renderer.renderFallback2D(snapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'weapons_pov', snapshot.ships.alpha);

    expect(drawHullPlatesSpy).toHaveBeenCalledTimes(1);
    expect(drawHexShieldsSpy).toHaveBeenCalledTimes(2);

    // 3. spectator mode: drawHullPlates called for both ships
    drawHullPlatesSpy.mockClear();
    drawHexShieldsSpy.mockClear();
    renderer.renderFallback2D(snapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'spectator', snapshot.ships.alpha);

    expect(drawHullPlatesSpy).toHaveBeenCalledTimes(2);
    expect(drawHexShieldsSpy).toHaveBeenCalledTimes(2);
  });

  it('renderMultiAnglePips3D temporarily reveals own ship hull during PiP scissor rendering and restores prior visibility in finally block', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);
    renderer.webglRenderer = {
      setScissorTest: vi.fn(),
      setViewport: vi.fn(),
      setScissor: vi.fn(),
      render: vi.fn(),
    };

    const shipAlpha = {
      team: 'alpha',
      hullClass: 'frigate',
      pos: { x: 0, y: 0, z: 0 },
      angle: 0,
      pitch: 0,
      rollAngle: 0,
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
    };

    // Put own ship into helm_pov mode so hull is hidden
    renderer.syncShips3D({ alpha: shipAlpha }, { cameraMode: 'helm_pov', myShipTeam: 'alpha' });
    const alphaMesh = renderer.shipMeshes.get('alpha');
    const nonShieldChildren = alphaMesh.hullRollGroup.children.filter((c) => c !== alphaMesh.shieldGroup);
    expect(nonShieldChildren.every((c) => c.visible === false)).toBe(true);

    let observedVisibilityDuringPip = null;
    renderer.webglRenderer.render = vi.fn(() => {
      observedVisibilityDuringPip = nonShieldChildren.map((c) => c.visible);
    });

    const mockSlot = {
      el: {
        getBoundingClientRect: vi.fn(() => ({ left: 10, top: 10, right: 100, bottom: 80, width: 90, height: 70 })),
      },
      view: 'dorsal',
    };

    renderer.renderMultiAnglePips3D([mockSlot], shipAlpha);

    // During PiP render, hull was visible
    expect(observedVisibilityDuringPip).toBeDefined();
    expect(observedVisibilityDuringPip.every((v) => v === true)).toBe(true);

    // After renderMultiAnglePips3D completes, prior hidden state is restored
    expect(nonShieldChildren.every((c) => c.visible === false)).toBe(true);
  });

  it('verifies true 3D barrel roll rotation on hullRollGroup around longitudinal X-axis with continuous rollAngle', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // 1. Continuous physical rollAngle = 0.75 * Math.PI
    const continuousShip = {
      pos: { x: 0, y: 0 },
      angle: 0,
      rollAngle: 0.75 * Math.PI,
      hullClass: 'corvette',
      weapons: { heat: 0 },
      shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
      thrusters: {
        ventralRoll: { isFiring: true, throttle: 1 },
        dorsalRoll: { isFiring: false, throttle: 0 },
      },
    };

    renderer.syncShips3D({ alpha: continuousShip });
    const alphaMesh = renderer.shipMeshes.get('alpha');
    expect(alphaMesh).toBeDefined();
    expect(alphaMesh.hullRollGroup.rotation.x).toBeCloseTo(0.75 * Math.PI, 4);

    // Verify ventralRoll plume ignites in 3D
    expect(alphaMesh.rcsPods.get('ventralRoll').plume.visible).toBe(true);
    expect(alphaMesh.rcsPods.get('dorsalRoll').plume.visible).toBe(false);

    // 2. Fully inverted roll state with continuous rollAngle = Math.PI and dorsalRoll firing
    const invertedShip = {
      pos: { x: 100, y: 100 },
      angle: Math.PI / 2,
      rollAngle: Math.PI,
      hullClass: 'dreadnought',
      weapons: { heat: 80 },
      shields: { hp: { fore: 50, aft: 50, port: 50, starboard: 50 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
      thrusters: {
        ventralRoll: { isFiring: false },
        dorsalRoll: { isFiring: true, throttle: 1 },
      },
    };

    renderer.syncShips3D({ omega: invertedShip });
    const omegaMesh = renderer.shipMeshes.get('omega');
    expect(omegaMesh).toBeDefined();
    expect(omegaMesh.hullRollGroup.rotation.x).toBeCloseTo(Math.PI, 4);
    expect(omegaMesh.rcsPods.get('dorsalRoll').plume.visible).toBe(true);

    // 3. Negative continuous angle: rollAngle = -0.4 * Math.PI
    renderer.syncShips3D({ alpha: { ...continuousShip, rollAngle: -0.4 * Math.PI } });
    expect(alphaMesh.hullRollGroup.rotation.x).toBeCloseTo(-0.4 * Math.PI, 4);
  });

  it('renders complete authoritative snapshot without crashing and without solar flares or asteroid shadows', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // Authoritative snapshot with ZERO solarFlare
    const snapshot = {
      tick: 100,
      state: 'playing',
      slowMoActive: false,
      ships: {
        alpha: {
          id: 'ship_alpha',
          team: 'alpha',
          hullClass: 'frigate',
          pos: { x: -400, y: 0 },
          vel: { x: 10, y: 0 },
          angle: 0,
          omega: 0.1,
          hullHp: 900,
          maxHullHp: 1000,
          rollState: 0,
          rollProgress: 0,
          isRolling: false,
          weapons: { heat: 45, maxHeat: 100, magazine: 6, maxMagazine: 8 },
          shields: { hp: { fore: 80, aft: 90, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
          thrusters: {
            bowPort: { health: 100, isFiring: true },
            bowStarboard: { health: 30, isFiring: false },
          },
          mainDrive: { throttle: 0.8, isFiring: true },
          turretAngle: 0.5,
          leadTarget: { x: 200, y: 50 },
        },
        omega: {
          id: 'ship_omega',
          team: 'omega',
          hullClass: 'dreadnought',
          pos: { x: 400, y: 0 },
          vel: { x: -5, y: 0 },
          angle: Math.PI,
          omega: 0,
          hullHp: 1600,
          maxHullHp: 1800,
          rollState: 1,
          rollProgress: 0,
          isRolling: false,
          weapons: { heat: 90, maxHeat: 100, magazine: 8, maxMagazine: 12 },
          shields: { hp: { fore: 50, aft: 0, port: 80, starboard: 40 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
          thrusters: {
            sternPort: { health: 100, isFiring: false },
          },
          mainDrive: { throttle: 0, isFiring: false },
        },
      },
      sector: {
        arenaRadius: 5250,
        // ZERO solarFlare property
        asteroids: [
          {
            id: 'ast_1',
            pos: { x: 0, y: 500 },
            radius: 120,
            vertices: [{ x: -50, y: 450 }, { x: 50, y: 450 }, { x: 0, y: 550 }],
            oreVeins: [{ type: 'plasma_crystal', angle: 0.2, depth: 0.4 }],
          },
        ],
        gravityWells: [
          { pos: { x: 1000, y: -500 }, pullRadius: 1200, eventHorizonRadius: 45 },
        ],
        ionNebulae: [
          { pos: { x: -800, y: -800 }, radius: 500 },
        ],
        debrisChunks: [
          { pos: { x: 100, y: 100 }, radius: 10, angle: 0.5 },
        ],
        tetherMines: [
          { pos: { x: 200, y: 200 }, radius: 18, tetheredShipId: 'alpha' },
        ],
        munitionsDerelict: {
          pos: { x: -200, y: 300 },
          resupplyRange: 80,
          progressByShip: { alpha: 3.5 },
        },
      },
      projectiles: [
        { type: 'laser', pos: { x: 0, y: 0 }, vel: { x: 500, y: 0 } },
        { type: 'railgun', pos: { x: 50, y: 0 }, vel: { x: 900, y: 0 } },
        { type: 'torpedo', torpedoType: 'emp_torpedoes', pos: { x: -100, y: 0 }, vel: { x: 200, y: 0 } },
        { type: 'flak', pos: { x: 20, y: 20 }, radius: 40 },
      ],
      events: [
        { type: 'flak_burst', pos: { x: 20, y: 20 } },
      ],
    };

    expect(() => {
      renderer.render(snapshot, {
        cameraPos: { x: 0, y: 0 },
        zoom: 0.5,
        myShipTeam: 'alpha',
        showLeadReticle: true,
      });
    }).not.toThrow();

    // Verify context drawing calls were made in fallback mode
    const ctx = renderer.ctx;
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.beginPath).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it('renders visual 180° roll foreshortening animation scale', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const rollingShip = {
      pos: { x: 0, y: 0 },
      angle: 0,
      hullClass: 'corvette',
      isRolling: true,
      rollProgress: 0.5,
      rollState: 0,
      weapons: { heat: 0 },
      shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
    };

    expect(() => {
      renderer.drawShip(renderer.ctx, rollingShip, '#38bdf8', true);
    }).not.toThrow();
  });
});

describe('SpaceRenderer.renderMiniGrid10x10', () => {
  it('renders 10x10 grid with tiles and drones without crashing', () => {
    const ctx = createMockContext();

    const tiles = [];
    for (let r = 0; r < 10; r++) {
      const row = [];
      for (let c = 0; c < 10; c++) {
        let type = 'straight';
        if (r === 2 && c === 3) type = 'reactor';
        else if (r === 2 && c === 6) type = 'coolant';
        else if (r === 3 && c === 4) type = 'capacitor';

        row.push({
          row: r,
          col: c,
          type,
          allocatedPower: type === 'reactor' ? 8.0 : 0.8,
          powerFlow: r < 5,
          coolantFlow: r >= 2 && r < 7,
          status: (r === 3 && c === 3) ? 'broken' : ((r === 5 && c === 5) ? 'burning' : 'nominal'),
          empTimer: (r === 6 && c === 6) ? 2.5 : 0,
          discharging: false,
        });
      }
      tiles.push(row);
    }

    const gridData = {
      rows: 10,
      cols: 10,
      tiles,
      lastPowerMap: {
        sas_computer: 0.8,
        shields_fore: 0.8,
        coolantMap: {
          sas_computer: 0.8,
        },
      },
      externalSystems: [
        { key: 'sas_computer', side: 'N', cells: [[0, 1], [0, 2]] },
        { key: 'shields_fore', side: 'N', cells: [[0, 4], [0, 5]] },
      ],
    };

    const drones = [
      { id: 1, currentPos: { x: 3, y: 3 } },
      { id: 2, currentPos: { x: 5, y: 5 } },
    ];

    expect(() => {
      SpaceRenderer.renderMiniGrid10x10(ctx, gridData, drones, 0, 0, 220, '#38bdf8');
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.strokeRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it('handles empty or missing grid gracefully', () => {
    const ctx = createMockContext();
    expect(() => {
      SpaceRenderer.renderMiniGrid10x10(ctx, null, [], 0, 0, 220, '#38bdf8');
      SpaceRenderer.renderMiniGrid10x10(ctx, { tiles: [] }, [], 0, 0, 220, '#38bdf8');
    }).not.toThrow();
  });

  it('Phase 14 Slice 2: SpaceRenderer.render() clears explodedShips when replayActive transitions false -> true so triggerShipExplosion3D triggers during replay', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // Initial normal gameplay: Omega ship is destroyed
    const normalSnapshot = {
      state: 'playing',
      tick: 150,
      replayActive: false,
      ships: {
        alpha: { team: 'alpha', pos: { x: -200, y: 0, z: 0 }, angle: 0, destroyed: false, hullHp: 100 },
        omega: { team: 'omega', pos: { x: 200, y: 0, z: 0 }, angle: 0, destroyed: true, hullHp: 0 },
      },
      sector: {},
      projectiles: [],
      events: [],
    };

    renderer.render(normalSnapshot);
    expect(renderer.explodedShips.has('omega')).toBe(true);
    expect(renderer._wasReplayActive).toBe(false);

    const triggerSpy = vi.spyOn(renderer, 'triggerShipExplosion3D');

    // Transition into instant replay: replayActive becomes true
    const replayRewindSnapshot = {
      state: 'playing',
      tick: 90,
      replayActive: true,
      ships: {
        alpha: { team: 'alpha', pos: { x: -100, y: 0, z: 0 }, angle: 0, destroyed: false, hullHp: 100 },
        omega: { team: 'omega', pos: { x: 100, y: 0, z: 0 }, angle: 0, destroyed: false, hullHp: 30 },
      },
      sector: {},
      projectiles: [],
      events: [],
    };

    renderer.render(replayRewindSnapshot);
    // Transitioning false -> true must clear explodedShips
    expect(renderer.explodedShips.size).toBe(0);
    expect(renderer._wasReplayActive).toBe(true);

    // Climax of replay: Omega ship is destroyed again
    const replayClimaxSnapshot = {
      state: 'playing',
      tick: 145,
      replayActive: true,
      ships: {
        alpha: { team: 'alpha', pos: { x: -180, y: 0, z: 0 }, angle: 0, destroyed: false, hullHp: 100 },
        omega: { team: 'omega', pos: { x: 180, y: 0, z: 0 }, angle: 0, destroyed: true, hullHp: 0 },
      },
      sector: {},
      projectiles: [],
      events: [{ type: 'killing_blow', victimId: 'omega', victimTeam: 'omega', pos: { x: 180, y: 0, z: 0 } }],
    };

    renderer.render(replayClimaxSnapshot);
    expect(triggerSpy).toHaveBeenCalledWith('omega', expect.any(Object), expect.any(String), 'omega');
    expect(renderer.explodedShips.has('omega')).toBe(true);
  });
});

describe('SpectatorApp (public/js/spectator.js)', () => {
  it('exports SpectatorApp class', async () => {
    const mod = await import('../../public/js/spectator.js');
    expect(mod.SpectatorApp).toBeDefined();
  });

  it('updates match status, start button and flashes victor overlay when winner is set', async () => {
    const mod = await import('../../public/js/spectator.js');
    const label = { textContent: '' };
    const btnClassList = {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    };
    const btn = { textContent: '', classList: btnClassList, style: { display: '' } };
    const elMatchStatus = {
      querySelector: vi.fn(() => label),
    };
    const elVictorOverlay = {
      classList: {
        toggle: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
      },
      style: { display: 'none' },
    };
    const elVictorTitle = { textContent: '' };
    const elVictorSubtitle = { textContent: '' };
    const elVictorBanner = {
      classList: {
        toggle: vi.fn(),
      },
    };

    const app = Object.create(mod.SpectatorApp.prototype);
    app.elMatchStatus = elMatchStatus;
    app.btnStartDemo = btn;
    app.elVictorOverlay = elVictorOverlay;
    app.elVictorTitle = elVictorTitle;
    app.elVictorSubtitle = elVictorSubtitle;
    app.elVictorBanner = elVictorBanner;

    // 1. Combat in progress
    app.updateMatchStatus({ state: 'playing' });
    expect(label.textContent).toBe('ENGAGED / COMBAT ACTIVE');
    expect(btn.textContent).toBe('RESTART COMBAT MATCH');
    expect(btnClassList.add).toHaveBeenCalledWith('hidden');

    // 2. GameOver Alpha victory
    app.updateMatchStatus({ state: 'gameover', winner: 'alpha' });
    app.updateVictorOverlay({ state: 'gameover', winner: 'alpha' });
    expect(label.textContent).toBe('VICTORY — UNS HYPERION');
    expect(btn.textContent).toBe('START NEW MATCH');
    expect(btnClassList.remove).toHaveBeenCalledWith('hidden');
    expect(elVictorOverlay.classList.remove).toHaveBeenCalledWith('hidden');
    expect(elVictorTitle.textContent).toBe('VICTOR: UNS HYPERION');

    // 3. GameOver Omega victory
    app.updateMatchStatus({ state: 'game_over', winner: 'omega' });
    app.updateVictorOverlay({ state: 'game_over', winner: 'omega' });
    expect(label.textContent).toBe('VICTORY — KRS VANGUARD');
    expect(elVictorTitle.textContent).toBe('VICTOR: KRS VANGUARD');
  });

  it('Phase 14 Slice 2: SpectatorApp shows #spectate-replay-banner and hides #spectate-victor-overlay while snapshot.replayActive === true, deduplicates 60FPS render frame events, and reveals #spectate-victor-overlay once replayActive === false (replayComplete: true)', async () => {
    const mod = await import('../../public/js/spectator.js');

    const label = { textContent: '' };
    const btnClassList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    const btn = { textContent: '', classList: btnClassList, style: { display: '' } };
    const elMatchStatus = { querySelector: vi.fn(() => label) };
    const elVictorOverlayClassList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    const elVictorOverlay = { classList: elVictorOverlayClassList, style: { display: 'none' } };
    const elVictorTitle = { textContent: '' };
    const elVictorSubtitle = { textContent: '' };
    const elVictorBanner = { classList: { toggle: vi.fn() } };
    const elKillCamClassList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    const elKillCam = { classList: elKillCamClassList };
    const elReplayBannerClassList = { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() };
    const elReplayBanner = { classList: elReplayBannerClassList };

    const app = Object.create(mod.SpectatorApp.prototype);
    app.elMatchStatus = elMatchStatus;
    app.btnStartDemo = btn;
    app.elVictorOverlay = elVictorOverlay;
    app.elVictorTitle = elVictorTitle;
    app.elVictorSubtitle = elVictorSubtitle;
    app.elVictorBanner = elVictorBanner;
    app.elKillCam = elKillCam;
    app.elReplayBanner = elReplayBanner;
    app.cameraPos = { x: 0, y: 0, z: 0 };
    app.targetCameraPos = { x: 0, y: 0, z: 0 };
    app.zoom = 0.22;
    app.targetZoom = 0.22;
    app._wasReplayActive = false;
    app._lastReplayFrameIndex = -1;
    app._lastRenderReplayFrameIndex = -1;

    const mockRender = vi.fn();
    const mockClearEffects3D = vi.fn();
    const mockResetBsgReplayCamera = vi.fn();
    app.renderer = {
      width: 1280,
      height: 720,
      render: mockRender,
      clearEffects3D: mockClearEffects3D,
      resetBsgReplayCamera: mockResetBsgReplayCamera,
    };

    // 1. Initial snapshot entering replay with a winner set
    const originalAsteroids = [
      { id: 'ast_1', destroyed: false },
      { id: 'ast_2', destroyed: false },
    ];
    const replaySnapshot = {
      state: 'playing',
      winner: 'alpha',
      replayActive: true,
      replayFrame: {
        frameIndex: 10,
        tick: 140,
        slowMoActive: true,
        ships: {
          alpha: { team: 'alpha', pos: { x: -100, y: 0 }, destroyed: false },
          omega: { team: 'omega', pos: { x: 100, y: 0 }, destroyed: false },
        },
        projectiles: [{ type: 'torpedo', pos: { x: 0, y: 0 } }],
        events: [{ type: 'torpedo_hit', pos: { x: 90, y: 0 } }],
        destroyedAsteroidIds: ['ast_1'],
      },
      sector: {
        arenaRadius: 5250,
        asteroids: originalAsteroids,
      },
    };

    app.handleSnapshot(replaySnapshot);

    // clearEffects3D called on entering replay
    expect(mockClearEffects3D).toHaveBeenCalled();
    // Replay banner shown (hidden toggle false)
    expect(elReplayBannerClassList.toggle).toHaveBeenCalledWith('hidden', false);
    // Victor overlay suppressed while replayActive === true
    expect(elVictorOverlayClassList.add).toHaveBeenCalledWith('hidden');
    // Status text indicates instant replay
    expect(label.textContent).toBe('INSTANT REPLAY — FINAL IMPACT');
    expect(btnClassList.add).toHaveBeenCalledWith('hidden');

    // 2. Non-destructive getActiveRenderSnapshot() verification
    const activeSnapshot = app.getActiveRenderSnapshot();
    expect(activeSnapshot).toBeDefined();
    expect(activeSnapshot.tick).toBe(140);
    expect(activeSnapshot.slowMoActive).toBe(true);
    expect(activeSnapshot.ships.alpha.pos.x).toBe(-100);
    // Verify cached original snapshot sector was NOT mutated
    expect(originalAsteroids[0].destroyed).toBe(false);
    expect(activeSnapshot.sector.asteroids[0].destroyed).toBe(true);
    expect(activeSnapshot.sector.asteroids[1].destroyed).toBe(false);

    // 3. 60FPS Event deduplication in renderLoop()
    // First renderLoop call for frameIndex 10: receives events + BSG replay cameraMode
    app.renderLoop();
    expect(mockRender).toHaveBeenCalledTimes(1);
    const firstCallArgs = mockRender.mock.calls[0][0];
    const firstCallOpts = mockRender.mock.calls[0][1];
    expect(firstCallArgs.events).toHaveLength(1);
    expect(firstCallArgs.events[0].type).toBe('torpedo_hit');
    expect(firstCallOpts.cameraMode).toBe('bsg_replay');

    // Second renderLoop call (same frameIndex 10 at 60FPS): deduplicates events to empty array
    app.renderLoop();
    expect(mockRender).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockRender.mock.calls[1][0];
    expect(secondCallArgs.events).toEqual([]);

    // Advance to next replay frame (frameIndex 11): receives new events
    app.lastSnapshot = {
      ...replaySnapshot,
      replayFrame: {
        ...replaySnapshot.replayFrame,
        frameIndex: 11,
        tick: 141,
        events: [{ type: 'killing_blow', victimId: 'omega', pos: { x: 100, y: 0 } }],
      },
    };
    app.renderLoop();
    expect(mockRender).toHaveBeenCalledTimes(3);
    const thirdCallArgs = mockRender.mock.calls[2][0];
    expect(thirdCallArgs.events).toHaveLength(1);
    expect(thirdCallArgs.events[0].type).toBe('killing_blow');

    // 4. Replay finishes: replayActive === false, replayComplete === true, match is gameover
    const finishedSnapshot = {
      state: 'gameover',
      winner: 'alpha',
      replayActive: false,
      replayComplete: true,
      slowMoActive: false,
      ships: {
        alpha: { team: 'alpha', pos: { x: -100, y: 0 }, destroyed: false },
        omega: { team: 'omega', pos: { x: 100, y: 0 }, destroyed: true },
      },
      sector: {
        asteroids: originalAsteroids,
      },
    };

    app.handleSnapshot(finishedSnapshot);

    // BSG replay camera resets on exiting replay
    expect(mockResetBsgReplayCamera).toHaveBeenCalledTimes(1);
    // Replay banner hidden (hidden toggle true)
    expect(elReplayBannerClassList.toggle).toHaveBeenCalledWith('hidden', true);
    // Victor overlay revealed once replayActive === false
    expect(elVictorOverlayClassList.remove).toHaveBeenCalledWith('hidden');
    expect(elVictorTitle.textContent).toBe('VICTOR: UNS HYPERION');
    expect(label.textContent).toBe('VICTORY — UNS HYPERION');

    // Next renderLoop call transitions back to standard spectator cameraMode
    app.lastSnapshot = finishedSnapshot;
    app.renderLoop();
    expect(mockRender.mock.calls[3][1].cameraMode).toBe('spectator');
  });

  describe('SpectatorApp — Background Music, Volume Controls & Single-Client Ownership', () => {
    beforeEach(() => {
      SpectatorApp.resetMusicOwnerLock();
    });

    afterEach(() => {
      SpectatorApp.resetMusicOwnerLock();
    });

    it('exports music constants with expected playlist and defaults', () => {
      expect(Array.isArray(SPECTATOR_MUSIC_TRACKS)).toBe(true);
      expect(SPECTATOR_MUSIC_TRACKS).toEqual([
        '/music/Deep%20Space%20Fanfare%202.mp3',
        '/music/Deep%20Space%20Fanfare.mp3',
        '/music/Deep%20Space%20Ostinato.mp3',
        '/music/Deep%20Space%20Pulse.mp3',
      ]);
      expect(DEFAULT_MUSIC_VOLUME).toBe(0.5);
      expect(MUSIC_VOLUME_STEP).toBe(0.05);
    });

    it('loads the 4 songs in SPECTATOR_MUSIC_TRACKS and plays on the first opened spectator', () => {
      const app = new SpectatorApp({ connectWebSocket: false });
      expect(app.musicTracks).toEqual(SPECTATOR_MUSIC_TRACKS);
      expect(app.currentTrackIndex).toBe(0);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[0]);
      expect(app.isMusicOwner).toBe(true);
      expect(app.audio.paused).toBe(false);
      expect(app.musicVolume).toBe(0.5);
      expect(app.audio.volume).toBe(0.5);
      app.destroy();
    });

    it('cycles tracks 0 -> 1 -> 2 -> 3 -> 0 when ended event fires', () => {
      const app = new SpectatorApp({ connectWebSocket: false });
      expect(app.currentTrackIndex).toBe(0);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[0]);

      // Fire ended event 1: 0 -> 1
      app.audio.dispatchEvent('ended');
      expect(app.currentTrackIndex).toBe(1);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[1]);
      expect(app.audio.paused).toBe(false);

      // Fire ended event 2: 1 -> 2
      app.audio.dispatchEvent('ended');
      expect(app.currentTrackIndex).toBe(2);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[2]);
      expect(app.audio.paused).toBe(false);

      // Fire ended event 3: 2 -> 3
      app.audio.dispatchEvent('ended');
      expect(app.currentTrackIndex).toBe(3);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[3]);
      expect(app.audio.paused).toBe(false);

      // Fire ended event 4: 3 -> 0 (looping back)
      app.audio.dispatchEvent('ended');
      expect(app.currentTrackIndex).toBe(0);
      expect(app.audio.src).toBe(SPECTATOR_MUSIC_TRACKS[0]);
      expect(app.audio.paused).toBe(false);

      app.destroy();
    });

    it('adjusts volume with ArrowUp (+0.05, clamped at 1.0) and ArrowDown (-0.05, clamped at 0.0) calling preventDefault()', () => {
      const app = new SpectatorApp({ connectWebSocket: false });
      expect(app.musicVolume).toBe(0.5);

      const preventMockUp = vi.fn();
      app.handleKeyDown({ key: 'ArrowUp', preventDefault: preventMockUp });
      expect(preventMockUp).toHaveBeenCalled();
      expect(app.musicVolume).toBe(0.55);
      expect(app.audio.volume).toBe(0.55);

      // Up to max clamp 1.0
      for (let i = 0; i < 15; i++) {
        app.handleKeyDown({ key: 'ArrowUp' });
      }
      expect(app.musicVolume).toBe(1.0);
      expect(app.audio.volume).toBe(1.0);

      // Down to min clamp 0.0
      const preventMockDown = vi.fn();
      app.handleKeyDown({ key: 'ArrowDown', preventDefault: preventMockDown });
      expect(preventMockDown).toHaveBeenCalled();
      expect(app.musicVolume).toBe(0.95);

      for (let i = 0; i < 25; i++) {
        app.handleKeyDown({ key: 'ArrowDown' });
      }
      expect(app.musicVolume).toBe(0.0);
      expect(app.audio.volume).toBe(0.0);

      app.destroy();
    });

    it('enforces single-client music ownership when two SpectatorApp views are opened', () => {
      const app1 = new SpectatorApp({ connectWebSocket: false });
      expect(app1.isMusicOwner).toBe(true);
      expect(app1.audio.paused).toBe(false);

      const app2 = new SpectatorApp({ connectWebSocket: false });
      expect(app2.isMusicOwner).toBe(false);
      expect(app2.audio.paused).toBe(true);

      // Destroying or closing app1 allows app2 to take ownership
      app1.destroy();
      expect(app1.isMusicOwner).toBe(false);

      app2.setMusicOwnership(true);
      expect(app2.isMusicOwner).toBe(true);
      expect(app2.audio.paused).toBe(false);

      app2.destroy();
    });

    it('enforces authoritative server snapshot musicOwnerId across two spectator instances', () => {
      const app1 = new SpectatorApp({ connectWebSocket: false });
      app1.playerId = 'player_spectator_1';

      const app2 = new SpectatorApp({ connectWebSocket: false });
      app2.playerId = 'player_spectator_2';

      // Snapshot grants ownership to player_spectator_1
      app1.handleSnapshot({ state: 'playing', musicOwnerId: 'player_spectator_1' });
      app2.handleSnapshot({ state: 'playing', musicOwnerId: 'player_spectator_1' });

      expect(app1.isMusicOwner).toBe(true);
      expect(app1.audio.paused).toBe(false);
      expect(app2.isMusicOwner).toBe(false);
      expect(app2.audio.paused).toBe(true);

      // Server transfers ownership to player_spectator_2
      app1.handleSnapshot({ state: 'playing', musicOwnerId: 'player_spectator_2' });
      app2.handleSnapshot({ state: 'playing', musicOwnerId: 'player_spectator_2' });

      expect(app1.isMusicOwner).toBe(false);
      expect(app1.audio.paused).toBe(true);
      expect(app2.isMusicOwner).toBe(true);
      expect(app2.audio.paused).toBe(false);

      app1.destroy();
      app2.destroy();
    });
  });

  it('Phase 16: SpectatorApp auto-frames both ships comfortably in 3D camera frustum across extreme separations and stray torpedoes', async () => {
    const { SpectatorApp } = await import('../../public/js/spectator.js');

    const testScenarios = [
      {
        name: 'Standard spawn distance (x = ±2200, y = 0, z = 0)',
        width: 1280,
        height: 720,
        ships: {
          alpha: { team: 'alpha', pos: { x: -2200, y: 0, z: 0 } },
          omega: { team: 'omega', pos: { x: 2200, y: 0, z: 0 } },
        },
        projectiles: [],
      },
      {
        name: 'Far horizontal separation (x = ±5000, y = 0, z = 0)',
        width: 1280,
        height: 720,
        ships: {
          alpha: { team: 'alpha', pos: { x: -5000, y: 0, z: 0 } },
          omega: { team: 'omega', pos: { x: 5000, y: 0, z: 0 } },
        },
        projectiles: [],
      },
      {
        name: 'Far vertical (North-South) separation (x = 0, y = ±5000, z = 0) on 1280x720',
        width: 1280,
        height: 720,
        ships: {
          alpha: { team: 'alpha', pos: { x: 0, y: -5000, z: 0 } },
          omega: { team: 'omega', pos: { x: 0, y: 5000, z: 0 } },
        },
        projectiles: [],
      },
      {
        name: 'Far vertical (North-South) separation (x = 0, y = ±5000, z = 0) on 1920x1080',
        width: 1920,
        height: 1080,
        ships: {
          alpha: { team: 'alpha', pos: { x: 0, y: -5000, z: 0 } },
          omega: { team: 'omega', pos: { x: 0, y: 5000, z: 0 } },
        },
        projectiles: [],
      },
      {
        name: 'Far 3D diagonal + altitude separation (alpha = (-4000, -3800, -1000), omega = (4000, 3800, 1000))',
        width: 1280,
        height: 720,
        ships: {
          alpha: { team: 'alpha', pos: { x: -4000, y: -3800, z: -1000 } },
          omega: { team: 'omega', pos: { x: 4000, y: 3800, z: 1000 } },
        },
        projectiles: [],
      },
      {
        name: 'Presence of a distant stray torpedo at (5200, 5200, 0)',
        width: 1280,
        height: 720,
        ships: {
          alpha: { team: 'alpha', pos: { x: -2500, y: -2000, z: 0 } },
          omega: { team: 'omega', pos: { x: 1500, y: -1800, z: 0 } },
        },
        projectiles: [
          { type: 'torpedo', pos: { x: 5200, y: 5200, z: 0 } },
        ],
        checkCenter: true,
      },
    ];

    for (const sc of testScenarios) {
      const canvas = createMockCanvas(sc.width, sc.height);
      const renderer = new SpaceRenderer(canvas);
      renderer.resize();

      const app = Object.create(SpectatorApp.prototype);
      app.canvas = canvas;
      app.renderer = renderer;
      app.cameraPos = { x: 0, y: 0, z: 0 };
      app.targetCameraPos = { x: 0, y: 0, z: 0 };
      app.zoom = 0.22;
      app.targetZoom = 0.22;
      app._cameraInitialized = false;

      const snapshot = {
        state: 'playing',
        ships: sc.ships,
        projectiles: sc.projectiles,
        sector: { arenaRadius: 5250 },
      };

      app.updateCamera(snapshot);

      if (sc.checkCenter) {
        const expectedMidX = (sc.ships.alpha.pos.x + sc.ships.omega.pos.x) / 2;
        const expectedMidY = (sc.ships.alpha.pos.y + sc.ships.omega.pos.y) / 2;
        expect(app.targetCameraPos.x).toBeCloseTo(expectedMidX, 1);
        expect(app.targetCameraPos.y).toBeCloseTo(expectedMidY, 1);
      }

      // Update renderer 3D camera with the calculated spectator framing
      renderer.updateCamera3D(app.cameraPos, app.zoom, false);

      for (const shipKey of ['alpha', 'omega']) {
        const s = sc.ships[shipKey];
        const ndc = new THREE.Vector3(s.pos.x, -s.pos.y, s.pos.z || 0).project(renderer.camera3d);
        expect(Math.abs(ndc.x)).toBeLessThan(0.85);
        expect(Math.abs(ndc.y)).toBeLessThan(0.85);
        expect(ndc.z).toBeGreaterThan(-1);
        expect(ndc.z).toBeLessThan(1);
      }
    }
  });

  it('gracefully normalizes legacy ship object 2nd argument and renders lead reticle from options or ship', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);
    const drawLeadSpy = vi.spyOn(renderer, 'drawLeadReticle');

    const snapshot = {
      tick: 1,
      ships: {
        alpha: {
          team: 'alpha',
          pos: { x: -100, y: 0 },
          vel: { x: 0, y: 0 },
          leadTarget: { x: 500, y: 0 },
          shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
          weapons: { heat: 0 },
        },
      },
      sector: {},
      projectiles: [],
      events: [],
    };

    // Legacy positional call with ship object as options:
    const legacyShip = { pos: { x: -100, y: 0 }, team: 'alpha' };
    expect(() => renderer.render(snapshot, legacyShip)).not.toThrow();
    expect(renderer.cameraPos.x).toBe(-100);

    // Call with showLeadReticle: true using server-calculated ship.leadTarget:
    renderer.render(snapshot, {
      cameraPos: { x: 0, y: 0 },
      myShipTeam: 'alpha',
      showLeadReticle: true,
    });
    expect(drawLeadSpy).toHaveBeenCalledWith(expect.any(Object), snapshot.ships.alpha, snapshot.ships.alpha.leadTarget);

    // Call with client-calculated leadReticle override:
    const clientLead = { x: 520, y: 10 };
    renderer.render(snapshot, {
      cameraPos: { x: 0, y: 0 },
      myShipTeam: 'alpha',
      showLeadReticle: true,
      leadReticle: clientLead,
    });
    expect(drawLeadSpy).toHaveBeenCalledWith(expect.any(Object), snapshot.ships.alpha, clientLead);
  });

  it('verifies 3D rcsPods coordinates (+Y Port, -Y Starboard, +Z Dorsal, -Z Ventral), plume orientations, and 2D drawRcsThrusterPlumes angles', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);
    const mesh = renderer.createShipMesh3D('frigate', 'alpha');

    const pods = mesh.rcsPods;
    const bowPort = pods.get('bowPort');
    const bowStarboard = pods.get('bowStarboard');
    const sternPort = pods.get('sternPort');
    const sternStarboard = pods.get('sternStarboard');
    const dorsalRoll = pods.get('dorsalRoll');
    const ventralRoll = pods.get('ventralRoll');

    // 1. Verify 3D mount coordinates
    expect(bowPort.group.position.y).toBeGreaterThan(0); // Port is +Y
    expect(bowStarboard.group.position.y).toBeLessThan(0); // Starboard is -Y
    expect(sternPort.group.position.y).toBeGreaterThan(0);
    expect(sternStarboard.group.position.y).toBeLessThan(0);
    expect(dorsalRoll.group.position.z).toBeGreaterThan(0); // Dorsal is +Z
    expect(ventralRoll.group.position.z).toBeLessThan(0); // Ventral is -Z

    // 2. Verify plume directions (Newton's 3rd law exhaust vectors)
    expect(bowPort.dir).toEqual([0, 1, 0]);
    expect(bowStarboard.dir).toEqual([0, -1, 0]);
    expect(sternPort.dir).toEqual([0, 1, 0]);
    expect(sternStarboard.dir).toEqual([0, -1, 0]);
    expect(dorsalRoll.dir).toEqual([0, 1, 0]);
    expect(ventralRoll.dir).toEqual([0, 1, 0]);
    expect(bowPort.group.userData.dir).toEqual([0, 1, 0]);

    // 3. Verify non-zero plume geometry parameters
    expect(bowPort.plume.geometry.parameters.height).toBe(12);
    expect(bowStarboard.plume.geometry.parameters.height).toBe(12);

    // 4. Verify 2D drawRcsThrusterPlumes angles (Math.PI Port vs 0 Starboard)
    const ship = {
      hullClass: 'frigate',
      thrusters: {
        bowPort: { isFiring: true },
        bowStarboard: { isFiring: true },
      },
    };
    renderer.drawRcsThrusterPlumes(renderer.ctx, ship, 'frigate');
    const mounts = renderer.rcsMounts2d;
    expect(mounts.find(m => m.id === 'bowPort').angle).toBe(Math.PI);
    expect(mounts.find(m => m.id === 'bowStarboard').angle).toBe(0);
    expect(mounts.find(m => m.id === 'sternPort').angle).toBe(Math.PI);
    expect(mounts.find(m => m.id === 'sternStarboard').angle).toBe(0);
    expect(mounts.find(m => m.id === 'dorsalRoll').angle).toBe(Math.PI);
    expect(mounts.find(m => m.id === 'ventralRoll').angle).toBe(Math.PI);

    // 5. Verify railgunGroup on ship mesh and articulated rotation tracking
    expect(mesh.railgunGroup).toBeDefined();
    expect(mesh.railgunGroup.name).toBe('railgunGroup');
    renderer.syncShips3D({
      alpha: {
        pos: { x: 0, y: 0 },
        angle: 0,
        weapons: { railgunAngle: 0.5, turretAngle: 1.2 },
      },
    });
    const alphaMesh = renderer.shipMeshes.get('alpha');
    expect(alphaMesh.railgunGroup).toBeDefined();
    expect(alphaMesh.railgunGroup.rotation.z).toBeCloseTo(-0.5, 4);
    expect(alphaMesh.turretGroup.rotation.z).toBeCloseTo(-1.2, 4);
  });

  it('updates camera3d.aspect on resize() and scales cleanly for portrait (aspect < 1) without squishing', () => {
    const portraitCanvas = createMockCanvas(600, 1000);
    const renderer = new SpaceRenderer(portraitCanvas);

    renderer.resize();
    expect(renderer.camera3d.aspect).toBeCloseTo(600 / 1000, 2);

    // Test portrait scale in updateCamera3D
    renderer.updateCamera3D({ x: 0, y: 0 }, 1.0, false);
    const fovRad = (renderer.camera3d.fov * Math.PI) / 180;
    const aspect = 600 / 1000;
    const expectedEffectiveHeight = 1000 / Math.max(0.55, aspect);
    const expectedDist = expectedEffectiveHeight / (2 * Math.tan(fovRad / 2));
    const expectedZ = expectedDist * Math.cos((30 * Math.PI) / 180);
    expect(renderer.camera3d.position.z).toBeCloseTo(expectedZ, 1);

    // Test landscape scale preserves effectiveHeight = height
    const landscapeCanvas = createMockCanvas(1280, 720);
    const landRenderer = new SpaceRenderer(landscapeCanvas);
    landRenderer.resize();
    landRenderer.updateCamera3D({ x: 0, y: 0 }, 1.0, false);
    const landFovRad = (landRenderer.camera3d.fov * Math.PI) / 180;
    const expectedLandDist = 720 / (2 * Math.tan(landFovRad / 2));
    const expectedLandZ = expectedLandDist * Math.cos((30 * Math.PI) / 180);
    expect(landRenderer.camera3d.position.z).toBeCloseTo(expectedLandZ, 1);
  });

  it('syncAsteroids3D removes destroyed: true asteroids and adds damage emissive tint', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const ast1 = { id: 'ast_test_1', pos: { x: 100, y: 200 }, radius: 80, hp: 100, maxHp: 100, destroyed: false };
    const ast2 = { id: 'ast_test_2', pos: { x: -300, y: 150 }, radius: 80, hp: 50, maxHp: 100, destroyed: false };
    renderer.syncAsteroids3D([ast1, ast2]);

    expect(renderer.asteroidMeshes.has('ast_test_1')).toBe(true);
    expect(renderer.asteroidMeshes.has('ast_test_2')).toBe(true);

    // Damaged asteroid has emissive tint
    const mesh2 = renderer.asteroidMeshes.get('ast_test_2');
    expect(mesh2.material.emissiveIntensity).toBeGreaterThan(0);

    // Mark ast1 as destroyed and re-sync
    ast1.destroyed = true;
    renderer.syncAsteroids3D([ast1, ast2]);
    expect(renderer.asteroidMeshes.has('ast_test_1')).toBe(false);
    expect(renderer.asteroidMeshes.has('ast_test_2')).toBe(true);
  });

  it('projectEnemyToViewportEdge returns visible: false when !myShip.targetAvailable and clamps accurate edge coordinates when off-screen or behind', () => {
    const canvas = createMockCanvas(1280, 720);
    const renderer = new SpaceRenderer(canvas);

    const myShip = { pos: { x: 0, y: 0 }, angle: 0, targetAvailable: false };
    const enemyShip = { pos: { x: 500, y: 0 }, destroyed: false };

    // 1. Hidden by ion nebula / jamming: visible: false
    const hiddenRes = renderer.projectEnemyToViewportEdge(myShip, enemyShip);
    expect(hiddenRes.visible).toBe(false);

    // 2. Visible enemy behind camera
    myShip.targetAvailable = true;
    const behindRes = renderer.projectEnemyToViewportEdge(myShip, { pos: { x: -2000, y: 0 }, destroyed: false }, { width: 1280, height: 720 });
    expect(behindRes.visible).toBe(true);
    expect(behindRes.inFrustum).toBe(false);
    expect(behindRes.screenX).toBeGreaterThanOrEqual(36);
    expect(behindRes.screenX).toBeLessThanOrEqual(1280 - 36);
    expect(behindRes.screenY).toBeGreaterThanOrEqual(36);
    expect(behindRes.screenY).toBeLessThanOrEqual(720 - 36);
    expect(typeof behindRes.arrowAngleRad).toBe('number');
    expect(behindRes.distanceMeters).toBeCloseTo(2000, 1);
  });

  it('SpaceRenderer.renderArenaMiniMap draws without throwing with both visible and nebula-hidden enemy', () => {
    const miniCanvas = createMockCanvas(160, 160);

    const snapshot = {
      sector: {
        arenaRadius: 3500,
        gravityWells: [{ pos: { x: 500, y: 500 }, pullRadius: 800, eventHorizonRadius: 40 }],
        ionNebulae: [{ pos: { x: -500, y: -500 }, radius: 400 }],
        asteroids: [
          { pos: { x: 200, y: 200 }, radius: 60, destroyed: false },
          { pos: { x: -200, y: -200 }, radius: 60, destroyed: true },
        ],
        debrisChunks: [{ pos: { x: 100, y: 100 } }],
        munitionsDerelict: { pos: { x: 0, y: 600 } },
      },
      ships: {
        alpha: { pos: { x: -300, y: 0 }, angle: 0, targetAvailable: true, destroyed: false },
        omega: { pos: { x: 300, y: 0 }, angle: Math.PI, destroyed: false },
      },
    };

    // 1. Visible enemy
    expect(() => SpaceRenderer.renderArenaMiniMap(miniCanvas, snapshot, 'alpha')).not.toThrow();

    // 2. Nebula-hidden enemy (targetAvailable: false)
    const hiddenSnapshot = {
      ...snapshot,
      ships: {
        alpha: { ...snapshot.ships.alpha, targetAvailable: false },
        omega: snapshot.ships.omega,
      },
    };
    expect(() => SpaceRenderer.renderArenaMiniMap(miniCanvas, hiddenSnapshot, 'alpha')).not.toThrow();
  });

  it('supports helm_pov and weapons_pov camera modes in render() and raycasts plane with screenToWorldOnPlane()', () => {
    const canvas = createMockCanvas(1280, 720);
    const renderer = new SpaceRenderer(canvas);

    const snapshot = {
      tick: 1,
      ships: {
        alpha: {
          team: 'alpha',
          pos: { x: -200, y: 50 },
          angle: 0.2,
          rollAngle: 0.4,
          hullClass: 'frigate',
          weapons: { heat: 0, turretAngle: 0.5, railgunAngle: 0.3 },
          targetAvailable: true,
        },
        omega: {
          team: 'omega',
          pos: { x: 400, y: 0 },
          angle: Math.PI,
          hullClass: 'dreadnought',
          radius: 45,
          destroyed: false,
        },
      },
      sector: {
        asteroids: [{ id: 'ast1', pos: { x: 100, y: 0 }, radius: 80, destroyed: false }],
      },
      projectiles: [],
      events: [],
    };

    // 1. Helm POV
    expect(() => {
      renderer.render(snapshot, { cameraMode: 'helm_pov', myShipTeam: 'alpha' });
    }).not.toThrow();
    expect(renderer.camera3d.fov).toBe(62);
    expect(renderer.camera3d.near).toBe(2);

    // 2. Weapons POV
    expect(() => {
      renderer.render(snapshot, { cameraMode: 'weapons_pov', myShipTeam: 'alpha', gunnerWorldAngle: 0.8 });
    }).not.toThrow();
    expect(renderer.camera3d.fov).toBe(62);

    // 3. Reset back to spectator
    renderer.render(snapshot, { cameraMode: 'spectator' });
    expect(renderer.camera3d.fov).toBe(45);
    expect(renderer.camera3d.near).toBe(10);

    // 4. screenToWorldOnPlane
    const worldPoint = renderer.screenToWorldOnPlane(640, 360, snapshot, 'alpha');
    expect(worldPoint).toBeDefined();
    expect(typeof worldPoint.x).toBe('number');
    expect(typeof worldPoint.y).toBe('number');
  });

  it('tilts camera up vector with -sin(roll) sign when positive rollAngle is applied in updateHelmCamera3D and updateWeaponsCamera3D', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);
    renderer.resize();

    const ship = {
      pos: { x: 0, y: 0 },
      angle: 0,
      rollAngle: 0.5,
      hullClass: 'frigate',
    };

    // 1. Helm Camera
    renderer.updateHelmCamera3D(ship);
    expect(renderer.camera3d.up.x).toBeCloseTo(0, 2);
    expect(renderer.camera3d.up.y).toBeLessThan(0);
    expect(renderer.camera3d.up.z).toBeGreaterThan(0);

    // 2. Weapons Camera (with gunnerWorldAngle = 0)
    renderer.updateWeaponsCamera3D(ship, 0);
    expect(renderer.camera3d.up.x).toBeCloseTo(0, 2);
    expect(renderer.camera3d.up.y).toBeLessThan(0);
    expect(renderer.camera3d.up.z).toBeGreaterThan(0);
  });

  it('Phase 10 Slice 3: verifies 10 rcsPods, 3D ship mesh pitch & elevation, and pitch thruster firing', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const pitchedShip = {
      pos: { x: 120, y: -80, z: 250 },
      vel: { x: 0, y: 0, z: 0 },
      angle: 0.3,
      pitch: 0.45,
      rollAngle: 0.2,
      hullClass: 'frigate',
      weapons: { heat: 0 },
      shields: { hp: { fore: 100, aft: 100, port: 100, starboard: 100 }, maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 } },
      thrusters: {
        bowDorsal: { isFiring: true, throttle: 1 },
        bowVentral: { isFiring: false },
        sternDorsal: { isFiring: false },
        sternVentral: { isFiring: true, throttle: 0.8 },
      },
    };

    renderer.syncShips3D({ alpha: pitchedShip });
    const mesh = renderer.shipMeshes.get('alpha');
    expect(mesh).toBeDefined();

    // Verify 10 RCS pods are all registered
    expect(mesh.rcsPods.size).toBe(10);
    expect(mesh.rcsPods.has('bowPort')).toBe(true);
    expect(mesh.rcsPods.has('bowStarboard')).toBe(true);
    expect(mesh.rcsPods.has('sternPort')).toBe(true);
    expect(mesh.rcsPods.has('sternStarboard')).toBe(true);
    expect(mesh.rcsPods.has('dorsalRoll')).toBe(true);
    expect(mesh.rcsPods.has('ventralRoll')).toBe(true);
    expect(mesh.rcsPods.has('bowDorsal')).toBe(true);
    expect(mesh.rcsPods.has('bowVentral')).toBe(true);
    expect(mesh.rcsPods.has('sternDorsal')).toBe(true);
    expect(mesh.rcsPods.has('sternVentral')).toBe(true);

    // Verify position (x, -y, z) and rotation
    expect(mesh.position.x).toBe(120);
    expect(mesh.position.y).toBe(80);
    expect(mesh.position.z).toBe(250);
    expect(mesh.rotation.y).toBeCloseTo(-0.45, 4);

    // Verify firing thruster plumes
    expect(mesh.rcsPods.get('bowDorsal').plume.visible).toBe(true);
    expect(mesh.rcsPods.get('bowVentral').plume.visible).toBe(false);
    expect(mesh.rcsPods.get('sternVentral').plume.visible).toBe(true);
  });

  it('Phase 10 Slice 3: verifies updateHelmCamera3D and updateWeaponsCamera3D in 3D with pitch and wide pitch offsets', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);
    renderer.resize();

    const shipWithPitch = {
      pos: { x: 500, y: 300, z: 150 },
      angle: 0.2,
      pitch: 0.5,
      rollAngle: 0.1,
      hullClass: 'frigate',
    };

    // Helm camera mounts at ship altitude and pitches
    renderer.updateHelmCamera3D(shipWithPitch);
    expect(renderer.camera3d.position.z).toBeGreaterThan(150);
    expect(renderer.camera3d.up.z).toBeGreaterThan(0);

    // Weapons camera supports wide pitch offset (e.g. +1.2 rad / ~68°)
    renderer.updateWeaponsCamera3D(shipWithPitch, 0.4, 1.2);
    expect(renderer.camera3d.position.z).toBeGreaterThan(150);
    expect(renderer.camera3d.up.z).toBeGreaterThan(0);
    expect(renderer.camera3d.fov).toBeCloseTo(62, 1);

    // Optical weaponsZoom adjusts FOV inversely around 62 deg baseline and scales 2D fallback
    const projSpy = vi.spyOn(renderer.camera3d, 'updateProjectionMatrix');
    renderer.updateWeaponsCamera3D(shipWithPitch, 0.4, 0, 2.0);
    expect(projSpy).toHaveBeenCalled();
    expect(renderer.camera3d.fov).toBeCloseTo(33.44, 1);

    renderer.updateWeaponsCamera3D(shipWithPitch, 0.4, 0, 5.0);
    expect(renderer.camera3d.fov).toBeCloseTo(13.71, 1);

    renderer.updateWeaponsCamera3D(shipWithPitch, 0.4, 0, 0.6);
    expect(renderer.camera3d.fov).toBeCloseTo(90.08, 1);

    // renderFallback2D scales by options.weaponsZoom in weapons_pov mode
    const fbCanvas = createMockCanvas(1280, 720);
    const fbCtx = fbCanvas.getContext('2d');
    const scaleSpy = vi.fn();
    fbCtx.scale = scaleSpy;
    const fbRenderer = new SpaceRenderer(fbCanvas);
    fbRenderer.webglRenderer = null;
    fbRenderer.render(
      {
        ships: { alpha: shipWithPitch },
        projectiles: [],
        torpedoes: [],
        drones: [],
        particles: [],
        events: [],
      },
      { cameraPos: { x: 0, y: 0 }, cameraMode: 'weapons_pov', myShipTeam: 'alpha', gunnerWorldAngle: 0.4, weaponsZoom: 2.5 }
    );
    expect(scaleSpy).toHaveBeenCalledWith(2.5, 2.5);
  });

  it('Phase 10 Slice 3: verifies screenToAim3D extracts 3D aimAngle and aimPitch for elevated targets', () => {
    const canvas = createMockCanvas(800, 600);
    const renderer = new SpaceRenderer(canvas);
    renderer.resize();

    // Mock webglRenderer with domElement and bounding box for 3D raycasting
    renderer.webglRenderer = {
      domElement: canvas,
      render: vi.fn(),
      setSize: vi.fn(),
    };

    const snapshot = {
      ships: {
        alpha: {
          team: 'alpha',
          pos: { x: 0, y: 0, z: 0 },
          angle: 0,
          targetAvailable: true,
        },
        omega: {
          team: 'omega',
          pos: { x: 1000, y: 0, z: 400 }, // 400m above orbital plane
          radius: 50,
          destroyed: false,
        },
      },
      sector: {
        asteroids: [
          {
            id: 'ast_below',
            pos: { x: 800, y: 600, z: -300 }, // 300m below orbital plane
            radius: 80,
            destroyed: false,
          },
        ],
      },
    };

    // 1. Raycast hit on elevated enemy ship at (1000, 0, 400)
    renderer.camera3d.position.set(0, 0, 0);
    renderer.camera3d.up.set(0, 0, 1);
    renderer.camera3d.lookAt(1000, 0, 400);
    renderer.camera3d.updateMatrixWorld();

    const aimShip = renderer.screenToAim3D(400, 300, snapshot, 'alpha');
    expect(aimShip).toBeDefined();
    expect(aimShip.targetType).toBe('ship');
    expect(aimShip.aimPitch).toBeGreaterThan(0.1);
    expect(aimShip.aimPitch).toBeCloseTo(Math.atan2(400, 1000), 2); // ~0.3805 rad
    expect(aimShip.aimAngle).toBeCloseTo(0, 2);

    // 2. Raycast hit on depressed asteroid at (800, 600, -300)
    // Three.js coords: x = 800, y = -600, z = -300
    renderer.camera3d.position.set(0, 0, 0);
    renderer.camera3d.up.set(0, 0, 1);
    renderer.camera3d.lookAt(800, -600, -300);
    renderer.camera3d.updateMatrixWorld();

    // Disable enemy ship so ray selects the asteroid
    snapshot.ships.omega.destroyed = true;

    const aimAst = renderer.screenToAim3D(400, 300, snapshot, 'alpha');
    expect(aimAst).toBeDefined();
    expect(aimAst.targetType).toBe('asteroid');
    expect(aimAst.aimPitch).toBeLessThan(-0.1);
    expect(aimAst.aimPitch).toBeCloseTo(Math.atan2(-300, Math.hypot(800, 600)), 2); // ~ -0.2915 rad
    expect(aimAst.aimAngle).toBeCloseTo(Math.atan2(600, 800), 2);
  });

  it('Phase 10 Slice 3: verifies renderArenaMiniMap renders 3D tilted radar with stems and ΔZ tags without ctx.ellipse', () => {
    const miniCanvas = createMockCanvas(160, 160);
    const ctx = miniCanvas.getContext('2d');
    const fillTextSpy = ctx.fillText;

    const snapshot = {
      sector: {
        arenaRadius: 3500,
        gravityWells: [{ pos: { x: 500, y: 500, z: 80 }, pullRadius: 800 }],
        ionNebulae: [{ pos: { x: -500, y: -500, z: -50 }, radius: 400 }],
        asteroids: [
          { pos: { x: 200, y: 200, z: 120 }, radius: 60, destroyed: false },
        ],
        munitionsDerelict: { pos: { x: 0, y: 600, z: 30 } },
      },
      ships: {
        alpha: { pos: { x: -300, y: 0, z: 100 }, angle: 0, targetAvailable: true, destroyed: false },
        omega: { pos: { x: 300, y: 0, z: -60 }, angle: Math.PI, destroyed: false },
      },
    };

    expect(() => SpaceRenderer.renderArenaMiniMap(miniCanvas, snapshot, 'alpha')).not.toThrow();
    // Elevation text tags and ΔZ tags drawn via fillText
    expect(fillTextSpy).toHaveBeenCalled();
  });

  it('Phase 11 Slice 2A: verifies projectile ID keying, type persistence, and selective lifecycle removal', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const p1 = { id: 't1', type: 'torpedo', torpedoType: 'emp_torpedoes', pos: { x: 10, y: 20, z: 5 }, vel: { x: 100, y: 0, z: 0 } };
    const p2 = { id: 'l1', type: 'laser', pos: { x: 50, y: 60, z: 0 }, vel: { x: 200, y: 0, z: 0 } };

    // 1. Initial sync with t1 (torpedo) and l1 (laser)
    renderer.syncProjectiles3D([p1, p2]);
    expect(renderer.projectileMeshes.size).toBe(2);
    expect(renderer.projectileMeshes.has('t1')).toBe(true);
    expect(renderer.projectileMeshes.has('l1')).toBe(true);

    const t1Mesh = renderer.projectileMeshes.get('t1');
    const l1Mesh = renderer.projectileMeshes.get('l1');
    expect(t1Mesh.userData.projType).toBe('torpedo');
    expect(t1Mesh.userData.torpedoType).toBe('emp_torpedoes');
    expect(l1Mesh.userData.projType).toBe('laser');
    expect(renderer.scene.children).toContain(t1Mesh);
    expect(renderer.scene.children).toContain(l1Mesh);

    // 2. Remove t1, keep l1
    renderer.syncProjectiles3D([p2]);
    expect(renderer.projectileMeshes.size).toBe(1);
    expect(renderer.projectileMeshes.has('t1')).toBe(false);
    expect(renderer.projectileMeshes.has('l1')).toBe(true);
    expect(renderer.projectileMeshes.get('l1')).toBe(l1Mesh);
    expect(renderer.projectileMeshes.get('l1').userData.projType).toBe('laser');
    expect(renderer.scene.children).not.toContain(t1Mesh);
    expect(renderer.scene.children).toContain(l1Mesh);

    // 3. Re-type l1 from laser to railgun under same ID
    const p2Railgun = { id: 'l1', type: 'railgun', pos: { x: 80, y: 60, z: 0 }, vel: { x: 300, y: 0, z: 0 } };
    renderer.syncProjectiles3D([p2Railgun]);
    const newL1Mesh = renderer.projectileMeshes.get('l1');
    expect(newL1Mesh).not.toBe(l1Mesh);
    expect(newL1Mesh.userData.projType).toBe('railgun');
    expect(renderer.scene.children).not.toContain(l1Mesh);
    expect(renderer.scene.children).toContain(newL1Mesh);

    // Verify railgun 3D mesh uses spherical geometry (SphereGeometry) for all mesh children
    expect(newL1Mesh.children.length).toBeGreaterThanOrEqual(2);
    for (const child of newL1Mesh.children) {
      expect(child.geometry.type).toBe('SphereGeometry');
    }
  });

  it('verifies railgun projectile spherical 3D mesh and 2D canvas drawing', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const railProj = {
      id: 'rg_test',
      type: 'railgun',
      radius: 8,
      pos: { x: 120, y: 240, z: 15 },
      vel: { x: 800, y: 0, z: 0 },
    };

    renderer.syncProjectiles3D([railProj]);
    const mesh = renderer.projectileMeshes.get('rg_test');
    expect(mesh).toBeDefined();
    expect(mesh.userData.projType).toBe('railgun');
    expect(mesh.children.length).toBe(2);

    const [core, halo] = mesh.children;
    expect(core.geometry.type).toBe('SphereGeometry');
    expect(core.geometry.parameters.radius).toBe(8);
    expect(halo.geometry.type).toBe('SphereGeometry');
    expect(halo.geometry.parameters.radius).toBeCloseTo(8 * 1.45, 2);

    // 2D fallback drawing test
    const ctx = createMockContext();
    const arcSpy = vi.spyOn(ctx, 'arc');
    const fillSpy = vi.spyOn(ctx, 'fill');
    const strokeSpy = vi.spyOn(ctx, 'stroke');

    renderer.drawProjectile(ctx, railProj);
    expect(arcSpy).toHaveBeenCalledWith(0, 0, 8, 0, Math.PI * 2);
    expect(fillSpy).toHaveBeenCalled();
    expect(strokeSpy).toHaveBeenCalled();
  });

  it('Phase 11 Slice 2A: verifies 10% linear shield opacity scaling and online status gating', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const makeShip = (hp, online = true) => ({
      team: 'omega',
      hullClass: 'frigate',
      shields: {
        hp: { fore: hp, aft: hp, port: hp, starboard: hp },
        maxHp: { fore: 100, aft: 100, port: 100, starboard: 100 },
        online: { fore: online, aft: online, port: online, starboard: online },
      },
    });

    // 1. External (Spectator) 100% HP -> 0.10 surface, 0.16 wire
    renderer.syncShips3D({ omega: makeShip(100) }, { cameraMode: 'spectator' });
    const omegaMesh = renderer.shipMeshes.get('omega');
    const fore100 = omegaMesh.shieldQuads.fore;
    expect(fore100.group.visible).toBe(true);
    expect(fore100.surface.material.opacity).toBeCloseTo(0.10, 4);
    expect(fore100.wire.material.opacity).toBeCloseTo(0.16, 4);

    // 2. External 50% HP -> 0.05 surface, 0.08 wire
    renderer.syncShips3D({ omega: makeShip(50) }, { cameraMode: 'spectator' });
    const fore50 = omegaMesh.shieldQuads.fore;
    expect(fore50.group.visible).toBe(true);
    expect(fore50.surface.material.opacity).toBeCloseTo(0.05, 4);
    expect(fore50.wire.material.opacity).toBeCloseTo(0.08, 4);

    // 3. External 10% HP -> 0.01 surface, 0.016 wire
    renderer.syncShips3D({ omega: makeShip(10) }, { cameraMode: 'spectator' });
    const fore10 = omegaMesh.shieldQuads.fore;
    expect(fore10.group.visible).toBe(true);
    expect(fore10.surface.material.opacity).toBeCloseTo(0.01, 4);
    expect(fore10.wire.material.opacity).toBeCloseTo(0.016, 4);

    // 4. External 0% HP -> visible: false, opacity 0
    renderer.syncShips3D({ omega: makeShip(0) }, { cameraMode: 'spectator' });
    const fore0 = omegaMesh.shieldQuads.fore;
    expect(fore0.group.visible).toBe(false);
    expect(fore0.surface.material.opacity).toBe(0);
    expect(fore0.wire.material.opacity).toBe(0);

    // 5. Offline shield with HP > 0 -> visible: false, opacity 0
    renderer.syncShips3D({ omega: makeShip(100, false) }, { cameraMode: 'spectator' });
    const foreOffline = omegaMesh.shieldQuads.fore;
    expect(foreOffline.group.visible).toBe(false);
    expect(foreOffline.surface.material.opacity).toBe(0);
    expect(foreOffline.wire.material.opacity).toBe(0);

    // 6. Own-ship POV stays ultra-clear <= 0.03 surface and <= 0.08 wire
    renderer.syncShips3D(
      { alpha: { ...makeShip(100), team: 'alpha' } },
      { cameraMode: 'helm_pov', myShipTeam: 'alpha' }
    );
    const alphaMesh = renderer.shipMeshes.get('alpha');
    const alphaFore = alphaMesh.shieldQuads.fore;
    expect(alphaFore.surface.material.opacity).toBeCloseTo(0.03, 4);
    expect(alphaFore.wire.material.opacity).toBeCloseTo(0.08, 4);
    expect(alphaFore.surface.material.opacity).toBeLessThanOrEqual(0.03);
    expect(alphaFore.wire.material.opacity).toBeLessThanOrEqual(0.08);
  });

  it('Phase 11 Slice 2A: verifies 3D ship destruction explosion FX lifecycle and lobby/tick reset', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const snapshotDestroyed = {
      tick: 10,
      state: 'playing',
      ships: {
        omega: {
          team: 'omega',
          pos: { x: 200, y: -150, z: 50 },
          hullClass: 'frigate',
          destroyed: true,
        },
      },
      events: [
        { type: 'killing_blow', victimId: 'omega', pos: { x: 200, y: -150, z: 50 }, hullClass: 'frigate' },
      ],
      sector: {},
      projectiles: [],
    };

    // 1. Render destroyed ship -> triggers explosion
    renderer.render(snapshotDestroyed, { dt: 0.016 });
    expect(renderer.explodedShips.has('omega')).toBe(true);
    expect(renderer.explosions3D.length).toBe(1);

    const exp = renderer.explosions3D[0];
    expect(exp.id).toBe('omega');
    expect(exp.core).toBeDefined();
    expect(exp.fireball).toBeDefined();
    expect(exp.light).toBeDefined();
    expect(exp.light.isPointLight).toBe(true);
    expect(exp.rings).toBeDefined();
    expect(exp.rings.length).toBe(2);
    expect(exp.fragments.length).toBeGreaterThanOrEqual(20);
    expect(renderer.scene.children).toContain(exp.group);

    // Verify idempotency (calling render again does not spawn a second explosion)
    renderer.render(snapshotDestroyed, { dt: 0.016 });
    expect(renderer.explosions3D.length).toBe(1);

    // 2. Advance render past maxLife (3.5s) -> cleans up from scene and explosions3D
    for (let frame = 0; frame < 40; frame++) {
      renderer.render({ tick: 11 + frame, state: 'playing', ships: snapshotDestroyed.ships, events: [], sector: {} }, { dt: 0.1 });
    }
    expect(renderer.explosions3D.length).toBe(0);
    expect(renderer.scene.children).not.toContain(exp.group);

    // 3. Reset ship to destroyed: false -> clears from explodedShips
    renderer.render({
      tick: 60,
      state: 'playing',
      ships: {
        omega: { team: 'omega', pos: { x: 0, y: 0, z: 0 }, hullClass: 'frigate', destroyed: false },
      },
      sector: {},
    }, { dt: 0.016 });
    expect(renderer.explodedShips.has('omega')).toBe(false);

    // 4. Tick reset (e.g. rematch from tick 100 to tick 0) or lobby clears explodedShips and effects
    renderer.explodedShips.add('alpha');
    renderer.render({ tick: 0, state: 'playing', ships: {}, sector: {} }, { dt: 0.016 });
    expect(renderer.explodedShips.size).toBe(0);

    // Lobby state clears effects
    renderer.explodedShips.add('omega');
    renderer.render({ tick: 1, state: 'lobby', ships: {}, sector: {} }, { dt: 0.016 });
    expect(renderer.explodedShips.size).toBe(0);
  });

  it('Phase 11 Slice 2A: verifies 3D combat hit particles spawn in scene, cap at 150, and expire cleanly', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const hitEvents = [
      { type: 'torpedo_hit', pos: { x: 10, y: 20, z: 0 } },
      { type: 'railgun_hit', pos: { x: 30, y: 40, z: 10 } },
      { type: 'laser_hit', pos: { x: 50, y: 60, z: -10 } },
      { type: 'asteroid_hit', pos: { x: 70, y: 80, z: 0 } },
      { type: 'asteroid_destroyed', pos: { x: 90, y: 100, z: 20 } },
      { type: 'flak_burst', pos: { x: 110, y: 120, z: 0 } },
      { type: 'mine_detonation', pos: { x: 130, y: 140, z: 5 } },
      { type: 'collision', pos: { x: 150, y: 160, z: 0 } },
    ];

    // 1. Spawning hit events adds 3D particles to particles3D and scene
    renderer.syncParticles3D(hitEvents, 0.016);
    expect(renderer.particles3D.length).toBeGreaterThan(30);
    for (const p of renderer.particles3D) {
      expect(renderer.scene.children).toContain(p.mesh);
    }

    // 2. Cap at 150 active particles
    const manyEvents = [];
    for (let i = 0; i < 25; i++) {
      manyEvents.push({ type: 'torpedo_hit', pos: { x: i * 10, y: 0, z: 0 } });
    }
    renderer.syncParticles3D(manyEvents, 0.016);
    expect(renderer.particles3D.length).toBeLessThanOrEqual(150);

    // 3. Advancing time past max particle lifetime expires and removes all particles
    for (let step = 0; step < 20; step++) {
      renderer.syncParticles3D([], 0.1);
    }
    expect(renderer.particles3D.length).toBe(0);
  });

  it('Phase 11 Slice 2B: upgraded ship meshes (Corvette, Frigate, Dreadnought) preserve all handles, bumpMap DataTexture, nav lights/strobes, and enriched details', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const classes = ['corvette', 'frigate', 'dreadnought'];
    const thrusterIds = [
      'bowPort', 'bowStarboard', 'sternPort', 'sternStarboard',
      'dorsalRoll', 'ventralRoll', 'bowDorsal', 'bowVentral',
      'sternDorsal', 'sternVentral',
    ];

    for (const hullClass of classes) {
      const mesh = renderer.createShipMesh3D(hullClass, 'alpha');
      expect(mesh).toBeDefined();

      // Invariants: Public handles
      expect(mesh.hullRollGroup).toBeDefined();
      expect(mesh.shieldGroup).toBeDefined();
      expect(mesh.turretGroup).toBeDefined();
      expect(mesh.railgunGroup).toBeDefined();
      expect(mesh.barrelRecoilGroup).toBeDefined();
      expect(mesh.radiatorMaterial).toBeDefined();
      expect(mesh.drivePlumeGroup).toBeDefined();
      expect(mesh.engineLight).toBeDefined();
      expect(mesh.shieldQuads).toBeDefined();

      // All 10 RCS thrusters on rcsPods Map and named properties with height === 12
      expect(mesh.rcsPods).toBeDefined();
      expect(mesh.rcsPods.size).toBe(10);
      for (const tid of thrusterIds) {
        const pod = mesh.rcsPods.get(tid);
        expect(pod).toBeDefined();
        expect(mesh.rcsPods[tid]).toBe(pod);
        expect(pod.plume.geometry.parameters.height).toBe(12);
      }

      // Procedural bumpMap (THREE.DataTexture) applied to hull materials
      let foundBumpMap = false;
      mesh.traverse((child) => {
        if (child.isMesh && child.material && child.material.bumpMap) {
          expect(child.material.bumpMap.isDataTexture).toBe(true);
          expect(child.material.bumpScale).toBeCloseTo(0.45, 2);
          foundBumpMap = true;
        }
      });
      expect(foundBumpMap).toBe(true);

      // Running nav lights & strobe beacon
      expect(mesh.userData.navStrobeMat).toBeDefined();
      expect(mesh.userData.navStrobeMat.isMaterial).toBe(true);
      const portLight = mesh.hullRollGroup.children.find(c => c.name === 'navLight_port');
      const stbdLight = mesh.hullRollGroup.children.find(c => c.name === 'navLight_starboard');
      const dorsalStrobe = mesh.hullRollGroup.children.find(c => c.name === 'strobe_dorsal');
      expect(portLight).toBeDefined();
      expect(portLight.material.color.getHex()).toBe(0xef4444);
      expect(stbdLight).toBeDefined();
      expect(stbdLight.material.color.getHex()).toBe(0x22c55e);
      expect(dorsalStrobe).toBeDefined();
      expect(dorsalStrobe.material).toBe(mesh.userData.navStrobeMat);

      // Shared turret and railgun enrichment
      expect(mesh.turretGroup.children.length).toBeGreaterThanOrEqual(4); // collar, housing, mantlet, sensorBox, recoilGroup
      expect(mesh.barrelRecoilGroup.children.length).toBeGreaterThanOrEqual(6); // 2 barrels, 2 shrouds, 2 muzzle collars
      expect(mesh.railgunGroup.children.length).toBeGreaterThanOrEqual(7); // trunnion, rails, coils, conduits, brakes, breech

      // Class-specific enriched sub-mesh counts
      if (hullClass === 'corvette') {
        expect(mesh.userData.commsDish).toBeDefined();
      } else if (hullClass === 'frigate') {
        expect(mesh.userData.radarDish).toBeDefined();
      } else if (hullClass === 'dreadnought') {
        // High complexity citadel, casemate sub-turrets, hangar pod
        expect(mesh.hullRollGroup.children.length).toBeGreaterThan(25);
      }
    }

    // syncShips3D updates navStrobeMat opacity and rotates Frigate radar dish
    const ships = {
      alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: 0, y: 0, z: 0 }, angle: 0, pitch: 0 },
    };
    renderer.animTime = 0.25;
    renderer.syncShips3D(ships, {}, 0.05);
    const shipMesh = renderer.shipMeshes.get('alpha');
    expect(shipMesh.userData.navStrobeMat.opacity).toBeGreaterThan(0);
    expect(shipMesh.userData.radarDish.rotation.z).toBeGreaterThan(0);
  });

  it('Phase 11 Slice 2B: seeded syncAsteroids3D produces non-uniform craggy vertices within safe radial bounds and preserves mesh damage emissive glow', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const r = 90;
    const ast = { id: 'ast_craggy_42', pos: { x: 200, y: 150, z: 10 }, radius: r, hp: 80, maxHp: 100, oreVeins: [{ type: 'plasma_crystal', angle: 0.5, depth: 0.7 }] };
    renderer.syncAsteroids3D([ast]);

    const mesh = renderer.asteroidMeshes.get('ast_craggy_42');
    expect(mesh).toBeDefined();
    expect(mesh.isMesh).toBe(true);
    expect(mesh.material).toBeDefined();

    // Vertices deviate non-uniformly while strictly bounded: 0.65 * r <= dist <= 1.22 * r
    const posAttr = mesh.geometry.attributes.position;
    const distances = [];
    for (let i = 0; i < posAttr.count; i++) {
      const d = Math.hypot(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      distances.push(d);
      expect(d).toBeGreaterThanOrEqual(0.65 * r);
      expect(d).toBeLessThanOrEqual(1.22 * r);
    }
    const minD = Math.min(...distances);
    const maxD = Math.max(...distances);
    expect(maxD - minD).toBeGreaterThan(5); // Non-uniform deviation

    // Surface outcrops & ore crystal cluster attached as children of mesh
    expect(mesh.children.length).toBeGreaterThanOrEqual(4); // 3-6 boulder outcrops + ore cluster
    const cluster = mesh.children.find(c => c.name === 'oreCluster');
    expect(cluster).toBeDefined();
    expect(cluster.children.length).toBeGreaterThanOrEqual(3); // 2-3 crystals + fissure accent

    // Preserves material emissiveIntensity damage glow
    ast.hp = 40;
    renderer.syncAsteroids3D([ast]);
    expect(mesh.material.emissiveIntensity).toBeGreaterThan(0);
  });

  it('Phase 11 Slice 2B: detailed multi-part debris, >= 8-spiked tether mines, and multi-section munitions derelict construct and animate cleanly', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // 1. Debris Chunks (multi-part Group with girder, armor fragment, and pipe strut)
    const sector = {
      debrisChunks: [{ id: 'chunk_alpha_1', pos: { x: 50, y: 60, z: 5 }, radius: 15 }],
      tetherMines: [{ id: 'mine_beta_1', pos: { x: -100, y: -200, z: 0 }, radius: 20 }],
    };
    renderer.syncDebrisAndMines3D(sector, {}, 0.016);

    const debrisGroup = renderer.debrisMeshes.get('chunk_alpha_1');
    expect(debrisGroup).toBeDefined();
    expect(debrisGroup.isGroup).toBe(true);
    expect(debrisGroup.children.length).toBeGreaterThanOrEqual(3);

    // 2. Tether Mine with >= 8 spikes + beacon + tetherLine
    const mineGroup = renderer.mineMeshes.get('mine_beta_1');
    expect(mineGroup).toBeDefined();
    expect(mineGroup.isGroup).toBe(true);
    expect(mineGroup.userData.beacon).toBeDefined();
    expect(mineGroup.userData.tetherLine).toBeDefined();

    // Count cone spikes (geometry parameters or ConeGeometry type)
    let spikeCount = 0;
    mineGroup.traverse((c) => {
      if (c.isMesh && c.geometry && (c.geometry.type === 'ConeGeometry' || c.geometry.parameters?.radius !== undefined)) {
        spikeCount++;
      }
    });
    expect(spikeCount).toBeGreaterThanOrEqual(8);

    // 3. Munitions Derelict with multi-section hull, rotating ring, canister racks, and solar paddles
    const derelict = { pos: { x: 300, y: -150, z: 20 } };
    renderer.syncDerelict3D(derelict, {}, 0.05);

    const dMesh = renderer.derelictMesh;
    expect(dMesh).toBeDefined();
    expect(dMesh.isGroup).toBe(true);
    expect(dMesh.userData.ring).toBeDefined();
    expect(dMesh.userData.ring.rotation.z).toBeGreaterThan(0);

    // Check children include canisters and solar paddles
    expect(dMesh.children.length).toBeGreaterThanOrEqual(10);
  });

  it('Phase 12: SpaceRenderer creates gimbalPivotGroup for all hull classes and applies gimbalYaw and gimbalPitch on syncShips3D', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const classes = ['corvette', 'frigate', 'dreadnought'];
    for (const hc of classes) {
      const mesh = renderer.createShipMesh3D(hc, 'alpha');
      expect(mesh.gimbalPivotGroup).toBeDefined();
      expect(mesh.gimbalPivotGroup.name).toBe('gimbalPivotGroup');
      expect(mesh.gimbalPivotGroup.isGroup).toBe(true);
    }

    // syncShips3D applies gimbal yaw and pitch to gimbalPivotGroup
    const ship = {
      team: 'alpha',
      hullClass: 'frigate',
      pos: { x: 0, y: 0, z: 0 },
      angle: 0,
      pitch: 0,
      mainDrive: {
        throttle: 0.8,
        gimbalYaw: 0.25,
        gimbalPitch: -0.15,
        isFiring: true,
      },
    };

    renderer.syncShips3D({ alpha: ship });
    const shipMesh = renderer.shipMeshes.get('alpha');
    expect(shipMesh.gimbalPivotGroup.rotation.z).toBeCloseTo(0.25, 4);
    expect(shipMesh.gimbalPivotGroup.rotation.y).toBeCloseTo(-0.15, 4);
    expect(shipMesh.drivePlumeGroup.visible).toBe(true);
  });

  describe('Phase 15 Slice 1: Core 3D BSG (2003) Replay Camera Director', () => {
    it('exports BSG_HULL_RADII with exact hull radii', () => {
      expect(BSG_HULL_RADII).toEqual({
        corvette: 40,
        frigate: 60,
        dreadnought: 90,
      });
    });

    it('initializes bsgReplayCam state in constructor via createBsgReplayState()', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      expect(renderer.bsgReplayCam).toBeDefined();
      expect(renderer.bsgReplayCam.active).toBe(false);
      expect(renderer.bsgReplayCam.lastBeat).toBe(-1);
      expect(renderer.bsgReplayCam.sideSign).toBe(1);
      expect(renderer.bsgReplayCam.trackedProjId).toBeNull();
      expect(renderer.bsgReplayCam.pos).toBeInstanceOf(THREE.Vector3);
      expect(renderer.bsgReplayCam.pos.x).toBe(0);
      expect(renderer.bsgReplayCam.pos.y).toBe(-300);
      expect(renderer.bsgReplayCam.pos.z).toBe(80);
      expect(renderer.bsgReplayCam.lookAt.x).toBe(0);
      expect(renderer.bsgReplayCam.lookAt.y).toBe(0);
      expect(renderer.bsgReplayCam.lookAt.z).toBe(0);
      expect(renderer.bsgReplayCam.fov).toBe(50);
      expect(renderer.bsgReplayCam.dutchRoll).toBe(0);
      expect(renderer.bsgReplayCam.shakeIntensity).toBe(0);
      expect(renderer.bsgReplayCam.shakeTime).toBe(0);
      expect(renderer.bsgReplayCam.initialized).toBe(false);
      expect(renderer._lastSnapshotTick).toBeNull();
      expect(renderer._wasReplayActive).toBe(false);
    });

    it('resetBsgReplayCamera() resets camera state to defaults', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      renderer.bsgReplayCam.active = true;
      renderer.bsgReplayCam.lastBeat = 2;
      renderer.bsgReplayCam.shakeIntensity = 0.8;
      renderer.bsgReplayCam.initialized = true;

      renderer.resetBsgReplayCamera();
      expect(renderer.bsgReplayCam.active).toBe(false);
      expect(renderer.bsgReplayCam.lastBeat).toBe(-1);
      expect(renderer.bsgReplayCam.shakeIntensity).toBe(0);
      expect(renderer.bsgReplayCam.initialized).toBe(false);
    });

    it('updateBsgReplayCamera3D handles zero-ships fallback gracefully without throwing', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      renderer.updateBsgReplayCamera3D({ ships: {} });

      expect(renderer.camera3d.position.x).toBe(0);
      expect(renderer.camera3d.position.y).toBe(-300);
      expect(renderer.camera3d.position.z).toBe(80);
      expect(renderer.camera3d.fov).toBe(48);
      expect(renderer.camera3d.near).toBe(2);
      expect(renderer.bsgReplayCam.initialized).toBe(true);
    });

    it('updateBsgReplayCamera3D handles single-ship fallback', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const snapshot = {
        ships: {
          alpha: {
            team: 'alpha',
            hullClass: 'frigate',
            pos: { x: 50, y: 100, z: 10 },
            angle: 0.5,
            pitch: 0.1,
            hullHp: 1000,
          },
        },
      };

      renderer.updateBsgReplayCamera3D(snapshot);
      expect(renderer.bsgReplayCam.active).toBe(true);
      expect(Number.isFinite(renderer.camera3d.position.x)).toBe(true);
      expect(Number.isFinite(renderer.camera3d.position.y)).toBe(true);
      expect(Number.isFinite(renderer.camera3d.position.z)).toBe(true);
      expect(Number.isNaN(renderer.camera3d.position.x)).toBe(false);
    });

    it('resolves attacker and victim correctly based on destroyed flag, winner, and HP ratio', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      // 1. Destroyed ship is victim
      const snapDestroyed = {
        tick: 10,
        replayProgress: 0.05,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -200, y: 0, z: 0 }, destroyed: false, hullHp: 800 },
          omega: { team: 'omega', hullClass: 'dreadnought', pos: { x: 200, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
      };
      renderer.updateBsgReplayCamera3D(snapDestroyed);
      // In beat 0, camera is anchored near attacker (alpha: x near -200)
      expect(renderer.bsgReplayCam.pos.x).toBeLessThan(0);

      // 2. Winner flag determines attacker and victim
      renderer.resetBsgReplayCamera();
      const snapWinner = {
        tick: 11,
        winner: 'omega',
        replayProgress: 0.05,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -200, y: 0, z: 0 }, destroyed: false, hullHp: 500, maxHullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 200, y: 0, z: 0 }, destroyed: false, hullHp: 500, maxHullHp: 1000 },
        },
      };
      renderer.updateBsgReplayCamera3D(snapWinner);
      // Winner is omega (attacker at x=200), so camera in beat 0 is near omega (x > 0)
      expect(renderer.bsgReplayCam.pos.x).toBeGreaterThan(0);

      // 3. Lower HP ratio is victim
      renderer.resetBsgReplayCamera();
      const snapHp = {
        tick: 12,
        replayProgress: 0.05,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -200, y: 0, z: 0 }, destroyed: false, hullHp: 900, maxHullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 200, y: 0, z: 0 }, destroyed: false, hullHp: 200, maxHullHp: 1000 },
        },
      };
      renderer.updateBsgReplayCamera3D(snapHp);
      // alpha has higher HP -> attacker -> camera near x = -200
      expect(renderer.bsgReplayCam.pos.x).toBeLessThan(0);
    });

    it('computes deterministic sideSign on initialization', () => {
      const canvas = createMockCanvas();
      const renderer1 = new SpaceRenderer(canvas);
      // tick 10 + victim omega (1) = 11 -> odd -> sideSign = -1
      renderer1.updateBsgReplayCamera3D({
        tick: 10,
        ships: {
          alpha: { team: 'alpha', pos: { x: -100, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', pos: { x: 100, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
      });
      expect(renderer1.bsgReplayCam.sideSign).toBe(-1);

      const renderer2 = new SpaceRenderer(canvas);
      // tick 10 + victim alpha (0) = 10 -> even -> sideSign = 1
      renderer2.updateBsgReplayCamera3D({
        tick: 10,
        ships: {
          alpha: { team: 'alpha', pos: { x: -100, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
          omega: { team: 'omega', pos: { x: 100, y: 0, z: 0 }, hullHp: 1000 },
        },
      });
      expect(renderer2.bsgReplayCam.sideSign).toBe(1);
    });

    it('progresses through all 4 editorial beats based on replay progress', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const baseSnap = {
        tick: 100,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -300, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 300, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
        projectiles: [
          { id: 'torp_1', type: 'torpedo', shooterId: 'alpha', pos: { x: -50, y: 0, z: 0 }, vel: { x: 200, y: 0, z: 0 } },
        ],
      };

      // Beat 0: Broadside tracking (p = 0.10)
      renderer.updateBsgReplayCamera3D({ ...baseSnap, replayProgress: 0.10 });
      expect(renderer.bsgReplayCam.lastBeat).toBe(0);
      expect(renderer.bsgReplayCam.fov).toBeLessThanOrEqual(52);
      expect(renderer.bsgReplayCam.fov).toBeGreaterThan(45);

      // Beat 1: Ordnance flyby (p = 0.40)
      renderer.updateBsgReplayCamera3D({ ...baseSnap, replayProgress: 0.40 });
      expect(renderer.bsgReplayCam.lastBeat).toBe(1);
      expect(renderer.bsgReplayCam.trackedProjId).toBe('torp_1');

      // Beat 2: Telephoto crash-zoom (p = 0.70)
      renderer.updateBsgReplayCamera3D({ ...baseSnap, replayProgress: 0.70 });
      expect(renderer.bsgReplayCam.lastBeat).toBe(2);
      // Snap-zoom drops FOV dramatically (below 35)
      expect(renderer.bsgReplayCam.fov).toBeLessThan(35);

      // Beat 3: Destruction orbit (p = 0.90)
      renderer.updateBsgReplayCamera3D({ ...baseSnap, replayProgress: 0.90 });
      expect(renderer.bsgReplayCam.lastBeat).toBe(3);
      // Orbit FOV widens back out
      expect(renderer.bsgReplayCam.fov).toBeGreaterThan(35);
    });

    it('hard-cuts on beat transition by snapping state and adding cut jolt (+0.12) to shakeIntensity', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const snapBeat0 = {
        tick: 200,
        replayProgress: 0.15,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -300, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 300, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
      };

      renderer.updateBsgReplayCamera3D(snapBeat0);
      expect(renderer.bsgReplayCam.lastBeat).toBe(0);

      // Transition to Beat 1 (p = 0.35)
      const snapBeat1 = { ...snapBeat0, replayProgress: 0.35 };
      renderer.updateBsgReplayCamera3D(snapBeat1);
      expect(renderer.bsgReplayCam.lastBeat).toBe(1);
      // Cut jolt was added
      expect(renderer.bsgReplayCam.shakeIntensity).toBeGreaterThan(0.05);
    });

    it('accumulates event trauma from snapshot events and decays exponentially', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const snapWithKillingBlow = {
        tick: 50,
        replayProgress: 0.65,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -100, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 100, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
        events: [{ type: 'killing_blow' }],
      };

      renderer.updateBsgReplayCamera3D(snapWithKillingBlow, 0.016);
      expect(renderer.bsgReplayCam.shakeIntensity).toBeGreaterThanOrEqual(0.95);

      const highShake = renderer.bsgReplayCam.shakeIntensity;
      // Step forward with no new events: shake should decay
      const snapNoEvents = { ...snapWithKillingBlow, events: [] };
      renderer.updateBsgReplayCamera3D(snapNoEvents, 0.1);
      expect(renderer.bsgReplayCam.shakeIntensity).toBeLessThan(highShake);
    });

    it('enforces safe standoff avoiding clipping into ships and asteroids', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const snap = {
        tick: 1,
        replayProgress: 0.70,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: 0, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'dreadnought', pos: { x: 50, y: 50, z: 0 }, destroyed: true, hullHp: 0 },
        },
        sector: {
          asteroids: [
            { id: 'ast1', pos: { x: 0, y: -200, z: 50 }, radius: 80, destroyed: false },
          ],
        },
      };

      renderer.updateBsgReplayCamera3D(snap);
      const camPos = renderer.camera3d.position;

      // Distance from dreadnought (radius 90 + 25 = 115)
      const distToVictim = camPos.distanceTo(new THREE.Vector3(50, -50, 0));
      expect(distToVictim).toBeGreaterThanOrEqual(115 - 1e-2);
    });

    it('render() defaults cameraMode to bsg_replay when snapshot.replayActive === true and resets on exit', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const replaySnap = {
        state: 'playing',
        tick: 100,
        replayActive: true,
        replayProgress: 0.2,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -100, y: 0, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 100, y: 0, z: 0 }, destroyed: true, hullHp: 0 },
        },
      };

      renderer.render(replaySnap);
      expect(renderer.bsgReplayCam.active).toBe(true);
      expect(renderer.bsgReplayCam.initialized).toBe(true);

      // Replay ends -> transitions to normal spectator -> resets bsgReplayCam
      const liveSnap = {
        ...replaySnap,
        replayActive: false,
      };
      renderer.render(liveSnap);
      expect(renderer.bsgReplayCam.active).toBe(false);
    });

    it('renderFallback2D uses bsgReplayCam.lookAt when cameraPos is omitted in bsg_replay mode', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const replaySnap = {
        state: 'playing',
        tick: 100,
        replayActive: true,
        replayProgress: 0.5,
        ships: {
          alpha: { team: 'alpha', hullClass: 'frigate', pos: { x: -200, y: 100, z: 0 }, hullHp: 1000 },
          omega: { team: 'omega', hullClass: 'frigate', pos: { x: 200, y: -100, z: 0 }, destroyed: true, hullHp: 0 },
        },
      };

      renderer.render(replaySnap);
      expect(renderer.cameraPos).toBeDefined();
      expect(renderer.cameraPos.x).toBeCloseTo(renderer.bsgReplayCam.lookAt.x, 2);
      expect(renderer.cameraPos.y).toBeCloseTo(-renderer.bsgReplayCam.lookAt.y, 2);
    });
  });
});


describe('Shield quadrant orientation', () => {
  it('places each shield patch on its matching hull side (fore +X, aft -X, starboard -Y, port +Y) and rides the hull roll group', () => {
    const renderer = new SpaceRenderer(createMockCanvas());
    for (const hc of ['corvette', 'frigate', 'dreadnought']) {
      const mesh = renderer.createShipMesh3D(hc, 'alpha');
      expect(mesh.shieldGroup.parent).toBe(mesh.hullRollGroup);
      const center = (key) => {
        const geo = mesh.shieldQuads[key].surface.geometry;
        geo.computeBoundingBox();
        return geo.boundingBox.getCenter(new THREE.Vector3());
      };
      expect(center('fore').x).toBeGreaterThan(5);
      expect(center('aft').x).toBeLessThan(-5);
      expect(center('starboard').y).toBeLessThan(-5);
      expect(center('port').y).toBeGreaterThan(5);
    }
  });

  it('extends port and starboard shields around dorsal (+Z) and ventral (-Z) to meet at the y = 0 midline without covering fore/aft', () => {
    const renderer = new SpaceRenderer(createMockCanvas());
    const radii = { corvette: 28, frigate: 42, dreadnought: 58 };
    for (const hc of ['corvette', 'frigate', 'dreadnought']) {
      const R = radii[hc];
      const mesh = renderer.createShipMesh3D(hc, 'alpha');

      const box = (key) => {
        const geo = mesh.shieldQuads[key].surface.geometry;
        geo.computeBoundingBox();
        return geo.boundingBox;
      };

      const portBox = box('port');
      const stbdBox = box('starboard');
      const foreBox = box('fore');
      const aftBox = box('aft');

      // Port and starboard reach full ±R vertically (+Z dorsal and -Z ventral)
      expect(portBox.max.z).toBeCloseTo(R, 3);
      expect(portBox.min.z).toBeCloseTo(-R, 3);
      expect(stbdBox.max.z).toBeCloseTo(R, 3);
      expect(stbdBox.min.z).toBeCloseTo(-R, 3);

      // Port (y >= 0) and starboard (y <= 0) meet at the y = 0 midline
      expect(portBox.min.y).toBeCloseTo(0, 3);
      expect(portBox.max.y).toBeCloseTo(R, 3);
      expect(stbdBox.max.y).toBeCloseTo(0, 3);
      expect(stbdBox.min.y).toBeCloseTo(-R, 3);

      // Port and starboard do not extend all the way to the front (+R) or back (-R)
      expect(portBox.max.x).toBeLessThan(R * 0.85);
      expect(portBox.min.x).toBeGreaterThan(-R * 0.85);
      expect(stbdBox.max.x).toBeLessThan(R * 0.85);
      expect(stbdBox.min.x).toBeGreaterThan(-R * 0.85);

      // Fore and aft do not wrap to the top/bottom poles
      expect(foreBox.max.z).toBeLessThan(R * 0.75);
      expect(foreBox.min.z).toBeGreaterThan(-R * 0.75);
      expect(aftBox.max.z).toBeLessThan(R * 0.75);
      expect(aftBox.min.z).toBeGreaterThan(-R * 0.75);
    }
  });
});

describe('Phase 16 Slice 5: Star Trek 3D/2D Warp VFX, 4s External Blackout, Shield Offline Mesh Gating, Engineer Fallback Grid & Spectator Integration', () => {
  it('evaluates isExternalBlackoutActive correctly across camera modes and reboot timers', () => {
    const shipRebooting2s = { hyperspace: { state: 'rebooting', rebootTimer: 2.0 } };
    const shipRebooting4_2s = { hyperspace: { state: 'rebooting', rebootTimer: 4.2 } };
    const shipJumping = { hyperspace: { state: 'jumping', jumpTimer: 1.0 } };
    const shipReady = { hyperspace: { state: 'ready' } };

    // helm_pov and weapons_pov should be blacked out during reboot < 4.0s
    expect(isExternalBlackoutActive(shipRebooting2s, 'helm_pov')).toBe(true);
    expect(isExternalBlackoutActive(shipRebooting2s, 'weapons_pov')).toBe(true);
    expect(isExternalBlackoutActive(shipRebooting2s, 'cockpit')).toBe(true);
    expect(SpaceRenderer.isExternalBlackoutActive(shipRebooting2s, 'helm_pov')).toBe(true);

    // restored at >= 4.0s
    expect(isExternalBlackoutActive(shipRebooting4_2s, 'helm_pov')).toBe(false);
    expect(isExternalBlackoutActive(shipRebooting4_2s, 'weapons_pov')).toBe(false);

    // spectator broadcast and bsg_replay NEVER experience blackout
    expect(isExternalBlackoutActive(shipRebooting2s, 'spectator')).toBe(false);
    expect(isExternalBlackoutActive(shipRebooting2s, 'bsg_replay')).toBe(false);

    // other states are not blacked out
    expect(isExternalBlackoutActive(shipJumping, 'helm_pov')).toBe(false);
    expect(isExternalBlackoutActive(shipReady, 'helm_pov')).toBe(false);
    expect(isExternalBlackoutActive(null, 'helm_pov')).toBe(false);
  });

  it('renderFallback2D fills #02040a dark void and skips entity drawing during blackout < 4.0s, and restores full rendering at 4.2s', () => {
    const canvas = createMockCanvas();
    const ctx = canvas.getContext('2d');
    const renderer = new SpaceRenderer(canvas);
    const drawShipSpy = vi.spyOn(renderer, 'drawShip');

    const blackoutSnapshot = {
      sector: { arenaRadius: 5250 },
      ships: {
        alpha: { team: 'alpha', pos: { x: 0, y: 0, z: 0 }, angle: 0, hyperspace: { state: 'rebooting', rebootTimer: 2.0 } },
        omega: { team: 'omega', pos: { x: 500, y: 0, z: 0 }, angle: Math.PI },
      },
    };

    // 1. Blackout active in helm_pov at 2.0s: fills #02040a and returns early
    renderer.renderFallback2D(blackoutSnapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'helm_pov', blackoutSnapshot.ships.alpha);
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(ctx.fillStyle).toBe('#02040a');
    expect(drawShipSpy).not.toHaveBeenCalled();

    // 2. Blackout restored at 4.2s in helm_pov: draws ships
    drawShipSpy.mockClear();
    const restoredSnapshot = {
      ...blackoutSnapshot,
      ships: {
        ...blackoutSnapshot.ships,
        alpha: { ...blackoutSnapshot.ships.alpha, hyperspace: { state: 'rebooting', rebootTimer: 4.2 } },
      },
    };
    renderer.renderFallback2D(restoredSnapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'helm_pov', restoredSnapshot.ships.alpha);
    expect(drawShipSpy).toHaveBeenCalled();

    // 3. Spectator mode at 2.0s: never blacked out
    drawShipSpy.mockClear();
    renderer.renderFallback2D(blackoutSnapshot, {}, { x: 0, y: 0 }, 1, 0.016, 'spectator', blackoutSnapshot.ships.alpha);
    expect(drawShipSpy).toHaveBeenCalled();
  });

  it('renders 2D fallback without errors during jumping and executes 2D warp streaks', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const jumpingSnapshot = {
      sector: { arenaRadius: 5250 },
      ships: {
        alpha: { team: 'alpha', pos: { x: 0, y: 0, z: 0 }, angle: 0, hyperspace: { state: 'jumping', jumpTimer: 0.8 } },
        omega: { team: 'omega', pos: { x: 500, y: 0, z: 0 }, angle: Math.PI },
      },
    };

    expect(() => {
      renderer.renderFallback2D(jumpingSnapshot, { myShipTeam: 'alpha' }, { x: 0, y: 0 }, 1, 0.016, 'helm_pov', jumpingSnapshot.ships.alpha);
    }).not.toThrow();
  });

  it('syncShips3D elongates hull forward in jumping < 0.40s, vanishes ship for >= 0.40s, and settles arrival snap in reboot < 0.45s', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // 1. Jump entry (jt = 0.20 < 0.40): elongated forward, visible
    const jumpingEarly = {
      team: 'alpha',
      hullClass: 'frigate',
      pos: { x: 100, y: 50, z: 0 },
      angle: 0,
      pitch: 0,
      hyperspace: { state: 'jumping', jumpTimer: 0.20 },
    };
    renderer.syncShips3D({ alpha: jumpingEarly }, { cameraMode: 'spectator' });
    const meshEarly = renderer.shipMeshes.get('alpha');
    expect(meshEarly.visible).toBe(true);
    expect(meshEarly.scale.x).toBeGreaterThan(3.0);

    // 2. In subspace transit (jt = 1.0 >= 0.40): vanished into subspace
    const jumpingMid = {
      ...jumpingEarly,
      hyperspace: { state: 'jumping', jumpTimer: 1.0 },
    };
    renderer.syncShips3D({ alpha: jumpingMid }, { cameraMode: 'spectator' });
    expect(meshEarly.visible).toBe(false);

    // 3. Hyperspace arrival snap (rebootTimer = 0.20 < 0.45): visible with momentary stretch
    const rebootingEarly = {
      ...jumpingEarly,
      hyperspace: { state: 'rebooting', rebootTimer: 0.20 },
    };
    renderer.syncShips3D({ alpha: rebootingEarly }, { cameraMode: 'spectator' });
    expect(meshEarly.visible).toBe(true);
    expect(meshEarly.scale.x).toBeGreaterThan(1.5);

    // 4. Settled post-reboot snap (rebootTimer = 1.0 >= 0.45): reset scale (1, 1, 1)
    const rebootingSettled = {
      ...jumpingEarly,
      hyperspace: { state: 'rebooting', rebootTimer: 1.0 },
    };
    renderer.syncShips3D({ alpha: rebootingSettled }, { cameraMode: 'spectator' });
    expect(meshEarly.visible).toBe(true);
    expect(meshEarly.scale.x).toBeCloseTo(1.0, 2);
    expect(meshEarly.scale.y).toBeCloseTo(1.0, 2);
    expect(meshEarly.scale.z).toBeCloseTo(1.0, 2);
  });

  it('drawShip in 2D hides ship for jumpTimer >= 0.40s and renders stretch/snap without throwing', () => {
    const canvas = createMockCanvas();
    const ctx = canvas.getContext('2d');
    const renderer = new SpaceRenderer(canvas);
    const drawPlatesSpy = vi.spyOn(renderer, 'drawHullPlates');

    // jt = 1.0s >= 0.40s: vanished, drawHullPlates should not be called
    const shipJumpingMid = {
      team: 'alpha',
      hullClass: 'frigate',
      pos: { x: 0, y: 0 },
      angle: 0,
      hyperspace: { state: 'jumping', jumpTimer: 1.0 },
    };
    renderer.drawShip(ctx, shipJumpingMid, '#38bdf8', false);
    expect(drawPlatesSpy).not.toHaveBeenCalled();

    // jt = 0.2s < 0.40s: drawn with stretch
    drawPlatesSpy.mockClear();
    const shipJumpingEarly = {
      ...shipJumpingMid,
      hyperspace: { state: 'jumping', jumpTimer: 0.2 },
    };
    expect(() => renderer.drawShip(ctx, shipJumpingEarly, '#38bdf8', false)).not.toThrow();
    expect(drawPlatesSpy).toHaveBeenCalled();

    // rebootTimer = 0.2s < 0.45s: arrival snap
    drawPlatesSpy.mockClear();
    const shipRebootEarly = {
      ...shipJumpingMid,
      hyperspace: { state: 'rebooting', rebootTimer: 0.2 },
    };
    expect(() => renderer.drawShip(ctx, shipRebootEarly, '#38bdf8', false)).not.toThrow();
    expect(drawPlatesSpy).toHaveBeenCalled();
  });

  it('gates shield visibility during < 7.0s reboot (opacity = 0) and restores visibility at >= 7.0s', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    // 1. During < 7.0s reboot: shields completely invisible (opacity = 0)
    const shipRebootShieldsOffline = {
      team: 'alpha',
      hullClass: 'frigate',
      shields: {
        online: { fore: false, aft: false, port: false, starboard: false },
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
      hyperspace: { state: 'rebooting', rebootTimer: 3.5 },
    };
    renderer.syncShips3D({ alpha: shipRebootShieldsOffline }, { cameraMode: 'spectator' });
    const mesh = renderer.shipMeshes.get('alpha');
    for (const q of Object.values(mesh.shieldQuads)) {
      expect(q.group.visible).toBe(false);
      expect(q.surface.material.opacity).toBe(0);
      expect(q.wire.material.opacity).toBe(0);
    }

    // 2. Also handles missing shields.online fallback during < 7.0s reboot
    const shipFallbackOffline = {
      team: 'alpha',
      hullClass: 'frigate',
      shields: {
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
      hyperspace: { state: 'rebooting', rebootTimer: 3.5 },
    };
    renderer.syncShips3D({ alpha: shipFallbackOffline }, { cameraMode: 'spectator' });
    for (const q of Object.values(mesh.shieldQuads)) {
      expect(q.group.visible).toBe(false);
      expect(q.surface.material.opacity).toBe(0);
    }

    // 3. At >= 7.0s reboot complete: shields online restored
    const shipRebootShieldsRestored = {
      team: 'alpha',
      hullClass: 'frigate',
      shields: {
        online: { fore: true, aft: true, port: true, starboard: true },
        hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
      },
      hyperspace: { state: 'rebooting', rebootTimer: 7.2 },
    };
    renderer.syncShips3D({ alpha: shipRebootShieldsRestored }, { cameraMode: 'spectator' });
    for (const q of Object.values(mesh.shieldQuads)) {
      expect(q.group.visible).toBe(true);
      expect(q.surface.material.opacity).toBeGreaterThan(0);
      expect(q.wire.material.opacity).toBeGreaterThan(0);
    }
  });

  it('renderArenaMiniMap suppresses enemy blip and draws SENSORS REBOOTING when sensorsOnline === false or jumping', () => {
    const miniCanvas = createMockCanvas(160, 160);
    const ctx = miniCanvas.getContext('2d');

    const baseSnapshot = {
      sector: { arenaRadius: 3500 },
      ships: {
        alpha: { pos: { x: -300, y: 0, z: 0 }, angle: 0, targetAvailable: true, sensorsOnline: true, destroyed: false },
        omega: { pos: { x: 300, y: 0, z: 0 }, angle: Math.PI, destroyed: false },
      },
    };

    // 1. sensorsOnline === false -> renders 'SENSORS REBOOTING'
    const sensorsDownSnapshot = {
      ...baseSnapshot,
      ships: {
        alpha: { ...baseSnapshot.ships.alpha, sensorsOnline: false },
        omega: baseSnapshot.ships.omega,
      },
    };
    ctx.fillText.mockClear();
    SpaceRenderer.renderArenaMiniMap(miniCanvas, sensorsDownSnapshot, 'alpha');
    expect(ctx.fillText).toHaveBeenCalledWith('SENSORS REBOOTING', expect.any(Number), expect.any(Number));

    // 2. myShip in hyperspace jumping -> renders 'SENSORS REBOOTING'
    const jumpingSnapshot = {
      ...baseSnapshot,
      ships: {
        alpha: { ...baseSnapshot.ships.alpha, hyperspace: { state: 'jumping', jumpTimer: 0.5 } },
        omega: baseSnapshot.ships.omega,
      },
    };
    ctx.fillText.mockClear();
    SpaceRenderer.renderArenaMiniMap(miniCanvas, jumpingSnapshot, 'alpha');
    expect(ctx.fillText).toHaveBeenCalledWith('SENSORS REBOOTING', expect.any(Number), expect.any(Number));

    // 3. enemy in hyperspace jumping while own sensors are online -> enemy blip omitted
    const enemyJumpingSnapshot = {
      ...baseSnapshot,
      ships: {
        alpha: baseSnapshot.ships.alpha,
        omega: { ...baseSnapshot.ships.omega, hyperspace: { state: 'jumping', jumpTimer: 0.5 } },
      },
    };
    ctx.fillText.mockClear();
    ctx.arc.mockClear();
    SpaceRenderer.renderArenaMiniMap(miniCanvas, enemyJumpingSnapshot, 'alpha');
    expect(ctx.fillText).not.toHaveBeenCalledWith('SENSORS REBOOTING', expect.any(Number), expect.any(Number));
    expect(ctx.arc).toHaveBeenCalled();
    const enemyBlipCalls = ctx.arc.mock.calls.filter(call => call[2] === 3);
    expect(enemyBlipCalls).toHaveLength(0);
  });

  it('drawEngineerGrid perimeter fallback contains hyperspace at East [[1, 9], [2, 9]]', () => {
    const canvas = createMockCanvas(300, 300);
    const ctx = canvas.getContext('2d');
    const renderer = new SpaceRenderer(canvas);

    const gridData = {
      tiles: [],
      drones: [],
      lastPowerMap: { hyperspace: 2 },
    };

    expect(() => {
      renderer.drawEngineerGrid(ctx, gridData, 300);
    }).not.toThrow();

    expect(ctx.fillRect).toHaveBeenCalled();
    const fillTextCalls = ctx.fillText.mock.calls.map(c => c[0]);
    expect(fillTextCalls).toContain('HYPER');

    // Test external blackout gating: active for engineer_pov, inactive for spectator
    const rebootShip = { hyperspace: { state: 'rebooting', rebootTimer: 2.0 } };
    expect(isExternalBlackoutActive(rebootShip, 'engineer_pov')).toBe(true);
    expect(isExternalBlackoutActive(rebootShip, 'spectator')).toBe(false);
  });

  it('SpectatorApp handles snapshots with jumping and rebooting ships without throwing or NaN camera coordinates', () => {
    const canvas = createMockCanvas();
    const renderer = new SpaceRenderer(canvas);

    const app = Object.create(SpectatorApp.prototype);
    app.canvas = canvas;
    app.renderer = renderer;
    app.cameraPos = { x: 0, y: 0, z: 0 };
    app.targetCameraPos = { x: 0, y: 0, z: 0 };
    app.zoom = 0.22;
    app.targetZoom = 0.22;
    app._cameraInitialized = false;

    // Snapshot with alpha jumping and omega rebooting
    const snap = {
      state: 'playing',
      sector: { arenaRadius: 5250 },
      ships: {
        alpha: { team: 'alpha', pos: { x: 200, y: 150, z: 40 }, angle: 0, hyperspace: { state: 'jumping', jumpTimer: 0.5 } },
        omega: { team: 'omega', pos: { x: -300, y: -200, z: -20 }, angle: Math.PI, hyperspace: { state: 'rebooting', rebootTimer: 2.0 } },
      },
    };

    expect(() => app.updateCamera(snap)).not.toThrow();
    expect(Number.isFinite(app.targetCameraPos.x)).toBe(true);
    expect(Number.isFinite(app.targetCameraPos.y)).toBe(true);
    expect(Number.isFinite(app.targetCameraPos.z)).toBe(true);
    expect(Number.isFinite(app.zoom)).toBe(true);
    expect(app.zoom).toBeGreaterThan(0);

    // Spectator mode renders without blackout even if both ships are rebooting
    const bothRebooting = {
      state: 'playing',
      sector: { arenaRadius: 5250 },
      ships: {
        alpha: { team: 'alpha', pos: { x: 0, y: 0 }, angle: 0, hyperspace: { state: 'rebooting', rebootTimer: 1.5 } },
        omega: { team: 'omega', pos: { x: 100, y: 100 }, angle: 0, hyperspace: { state: 'rebooting', rebootTimer: 1.5 } },
      },
    };

    expect(() => {
      renderer.render(bothRebooting, {
        cameraPos: app.cameraPos,
        zoom: app.zoom,
        cameraMode: 'spectator',
      });
    }).not.toThrow();

    expect(renderer.isExternalBlackoutActive(bothRebooting.ships.alpha, 'spectator')).toBe(false);
  });

  describe('Phase 19 Slice 3: Edge Dampening Field Ship Amber-Gold Glow & Translucent Aura', () => {
    it('initializes hullGlowMaterials and dampeningAuraMesh on shipGroup without polluting hullRollGroup.children', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);
      const mesh = renderer.createShipMesh3D('frigate', 'alpha');

      // 1. Baseline glow materials defined on userData
      expect(mesh.userData.hullGlowMaterials).toBeDefined();
      expect(mesh.userData.hullGlowMaterials.length).toBe(3);
      expect(mesh.userData.hullGlowMaterials[0].baseIntensity).toBe(0);
      expect(mesh.userData.hullGlowMaterials[1].baseIntensity).toBe(0);
      expect(mesh.userData.hullGlowMaterials[2].baseIntensity).toBe(0.3);

      // 2. dampeningAuraMesh is attached directly to shipGroup, NOT hullRollGroup.children
      expect(mesh.dampeningAuraMesh).toBeDefined();
      expect(mesh.dampeningAuraMesh.parent).toBe(mesh);
      expect(mesh.hullRollGroup.children).not.toContain(mesh.dampeningAuraMesh);

      // 3. Aura mesh properties
      expect(mesh.dampeningAuraMesh.visible).toBe(false);
      expect(mesh.dampeningAuraMesh.material.color.getHex()).toBe(0xfbbf24);
      expect(mesh.dampeningAuraMesh.material.transparent).toBe(true);
      expect(mesh.dampeningAuraMesh.material.depthWrite).toBe(false);
    });

    it('syncShips3D activates amber-gold emissive glow and updates dampeningAuraMesh in spectator vs helm_pov', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const shipAlpha = {
        team: 'alpha',
        hullClass: 'frigate',
        pos: { x: 0, y: 0, z: 0 },
        angle: 0,
        rollAngle: 0.5,
        dampeningFactor: 0.8,
      };

      // 1. Spectator mode: FrontSide, visible aura, pulsed emissive
      renderer.syncShips3D({ alpha: shipAlpha }, { cameraMode: 'spectator', myShipTeam: 'alpha' });
      const mesh = renderer.shipMeshes.get('alpha');
      expect(mesh).toBeDefined();
      expect(mesh.dampeningAuraMesh.visible).toBe(true);
      expect(mesh.dampeningAuraMesh.material.side).toBe(THREE.FrontSide);
      expect(mesh.dampeningAuraMesh.material.opacity).toBeGreaterThan(0.15);
      expect(mesh.dampeningAuraMesh.rotation.x).toBeCloseTo(0.5, 4);

      for (const entry of mesh.userData.hullGlowMaterials) {
        expect(entry.mat.emissive.getHex()).toBe(0xf59e0b);
        expect(entry.mat.emissiveIntensity).toBeGreaterThan(0.5);
      }

      // 2. Helm POV mode: BackSide, reduced opacity, hullRollGroup children hidden (except shieldGroup)
      renderer.syncShips3D({ alpha: shipAlpha }, { cameraMode: 'helm_pov', myShipTeam: 'alpha' });
      expect(mesh.dampeningAuraMesh.visible).toBe(true);
      expect(mesh.dampeningAuraMesh.material.side).toBe(THREE.BackSide);
      expect(mesh.dampeningAuraMesh.material.opacity).toBeLessThan(0.15);
      expect(mesh.dampeningAuraMesh.material.opacity).toBeGreaterThan(0);

      // Verify own-ship POV invariant: hullRollGroup non-shield children are hidden
      for (const child of mesh.hullRollGroup.children) {
        if (child === mesh.shieldGroup) {
          expect(child.visible).toBe(true);
        } else {
          expect(child.visible).toBe(false);
        }
      }

      // 3. Reset when dampeningFactor is 0
      const shipSettled = { ...shipAlpha, dampeningFactor: 0 };
      renderer.syncShips3D({ alpha: shipSettled }, { cameraMode: 'spectator', myShipTeam: 'alpha' });
      expect(mesh.dampeningAuraMesh.visible).toBe(false);
      expect(mesh.userData.hullGlowMaterials[0].mat.emissive.getHex()).toBe(0x000000);
      expect(mesh.userData.hullGlowMaterials[0].mat.emissiveIntensity).toBe(0);
      expect(mesh.userData.hullGlowMaterials[2].mat.emissive.getHex()).toBe(0x38bdf8);
      expect(mesh.userData.hullGlowMaterials[2].mat.emissiveIntensity).toBe(0.3);

      // 4. inDampeningField boolean fallback
      const shipBoolField = { ...shipAlpha, dampeningFactor: undefined, inDampeningField: true };
      renderer.syncShips3D({ alpha: shipBoolField }, { cameraMode: 'spectator', myShipTeam: 'alpha' });
      expect(mesh.dampeningAuraMesh.visible).toBe(true);
      expect(mesh.userData.hullGlowMaterials[0].mat.emissive.getHex()).toBe(0xf59e0b);

      // 5. Destroyed ship hides dampening aura
      const shipDestroyed = { ...shipAlpha, destroyed: true };
      renderer.syncShips3D({ alpha: shipDestroyed }, { cameraMode: 'spectator', myShipTeam: 'alpha' });
      expect(mesh.dampeningAuraMesh.visible).toBe(false);
      expect(mesh.userData.hullGlowMaterials[0].mat.emissive.getHex()).toBe(0x000000);
    });

    it('drawShip renders subtle 2D amber-gold radial glow halo when dampeningFactor > 0 (with and without createRadialGradient)', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      const shipWithDamp = {
        hullClass: 'frigate',
        team: 'alpha',
        pos: { x: 100, y: 200 },
        angle: 0.2,
        dampeningFactor: 0.75,
      };

      // 1. With createRadialGradient available
      const ctxWithGrad = createMockContext();
      const arcSpy = vi.spyOn(ctxWithGrad, 'arc');
      const fillSpy = vi.spyOn(ctxWithGrad, 'fill');
      const saveSpy = vi.spyOn(ctxWithGrad, 'save');
      const restoreSpy = vi.spyOn(ctxWithGrad, 'restore');

      renderer.drawShip(ctxWithGrad, shipWithDamp, '#38bdf8', false, false);
      expect(ctxWithGrad.createRadialGradient).toHaveBeenCalled();
      expect(arcSpy).toHaveBeenCalled();
      expect(fillSpy).toHaveBeenCalled();
      expect(saveSpy).toHaveBeenCalled();
      expect(restoreSpy).toHaveBeenCalled();

      // 2. Without createRadialGradient (headless canvas mock fallback)
      const ctxNoGrad = createMockContext();
      ctxNoGrad.createRadialGradient = undefined;
      let fillStyleDuringHalo = null;
      ctxNoGrad.fill = vi.fn(() => {
        if (!fillStyleDuringHalo && typeof ctxNoGrad.fillStyle === 'string' && ctxNoGrad.fillStyle.includes('245, 158, 11')) {
          fillStyleDuringHalo = ctxNoGrad.fillStyle;
        }
      });
      const arcNoGradSpy = vi.spyOn(ctxNoGrad, 'arc');

      expect(() => renderer.drawShip(ctxNoGrad, shipWithDamp, '#38bdf8', false, false)).not.toThrow();
      expect(arcNoGradSpy).toHaveBeenCalled();
      expect(ctxNoGrad.fill).toHaveBeenCalled();
      expect(fillStyleDuringHalo).toMatch(/rgba\(245,\s*158,\s*11,/);

      // 3. When dampeningFactor is 0: createRadialGradient should NOT be called for dampening halo
      const ctxZeroDamp = createMockContext();
      const shipZeroDamp = { ...shipWithDamp, dampeningFactor: 0 };
      renderer.drawShip(ctxZeroDamp, shipZeroDamp, '#38bdf8', false, false);
      expect(ctxZeroDamp.createRadialGradient).not.toHaveBeenCalled();
    });

    it('confirms the Edge Dampening Field is invisible in 3D arena, 2D boundary, and minimap', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);

      // 1. syncArena3D creates only arena perimeter mesh, orbital reference rings, and buoys — no dampening ring
      renderer.syncArena3D(5250);
      const arenaChildren = renderer.scene.children.filter((c) => c === renderer.arenaMesh || c.name === 'orbitalReferenceRings' || c.name === 'arenaBeaconPylons');
      expect(arenaChildren.length).toBe(3);
      const dampeningMeshInScene = renderer.scene.children.find((c) => c.name && c.name.toLowerCase().includes('dampening'));
      expect(dampeningMeshInScene).toBeUndefined();

      // 2. drawArenaBoundary only strokes the arena radius & alert boundary
      const ctx = createMockContext();
      const arcSpy = vi.spyOn(ctx, 'arc');
      renderer.drawArenaBoundary(ctx, 5250);
      // Exactly 2 arcs: boundary radius and alert radius (+20)
      expect(arcSpy).toHaveBeenCalledTimes(2);

      // 3. renderArenaMiniMap renders minimap without dampening field elements
      const miniCanvas = createMockCanvas(160, 160);
      const snap = {
        sector: { arenaRadius: 5250 },
        ships: {
          alpha: { team: 'alpha', pos: { x: 0, y: 0, z: 0 }, dampeningFactor: 0.8 },
        },
      };
      expect(() => SpaceRenderer.renderArenaMiniMap(miniCanvas, snap, 'alpha')).not.toThrow();
    });

    it('renderMultiAnglePips3D temporarily switches dampeningAuraMesh to FrontSide and external opacity during PiP render in helm_pov, restoring BackSide in finally', () => {
      const canvas = createMockCanvas();
      const renderer = new SpaceRenderer(canvas);
      renderer.webglRenderer = {
        setScissorTest: vi.fn(),
        setViewport: vi.fn(),
        setScissor: vi.fn(),
        render: vi.fn(),
      };

      const shipAlpha = {
        team: 'alpha',
        hullClass: 'frigate',
        pos: { x: 0, y: 0, z: 0 },
        angle: 0,
        pitch: 0,
        rollAngle: 0,
        dampeningFactor: 1.0,
        shields: {
          hp: { fore: 200, aft: 200, port: 200, starboard: 200 },
          maxHp: { fore: 200, aft: 200, port: 200, starboard: 200 },
        },
      };

      // 1. Sync in helm_pov mode
      renderer.syncShips3D({ alpha: shipAlpha }, { cameraMode: 'helm_pov', myShipTeam: 'alpha' });
      const alphaMesh = renderer.shipMeshes.get('alpha');
      const aura = alphaMesh.dampeningAuraMesh;

      expect(aura).toBeDefined();
      expect(aura.visible).toBe(true);
      expect(aura.material.side).toBe(THREE.BackSide);
      const povOpacity = aura.material.opacity;
      expect(povOpacity).toBeLessThan(0.15);
      expect(povOpacity).toBeGreaterThan(0);
      expect(aura.userData.externalOpacity).toBeGreaterThan(0.20);
      expect(aura.userData.povOpacity).toBe(povOpacity);

      // Track aura side and opacity during PiP rendering
      let auraSideDuringPip = null;
      let auraOpacityDuringPip = null;
      renderer.webglRenderer.render = vi.fn(() => {
        auraSideDuringPip = aura.material.side;
        auraOpacityDuringPip = aura.material.opacity;
      });

      const mockSlot = {
        el: {
          getBoundingClientRect: vi.fn(() => ({ left: 10, top: 10, right: 100, bottom: 80, width: 90, height: 70 })),
        },
        view: 'dorsal',
      };

      renderer.renderMultiAnglePips3D([mockSlot], shipAlpha);

      // During PiP render, aura is switched to FrontSide and external opacity (> 0.20)
      expect(auraSideDuringPip).toBe(THREE.FrontSide);
      expect(auraOpacityDuringPip).toBeGreaterThan(0.20);
      expect(auraOpacityDuringPip).toBe(aura.userData.externalOpacity);

      // After renderMultiAnglePips3D finishes, prior BackSide & POV opacity restored cleanly
      expect(aura.material.side).toBe(THREE.BackSide);
      expect(aura.material.opacity).toBe(povOpacity);

      // Test clean restoration even when rendering throws (finally block safety)
      renderer.webglRenderer.render = vi.fn(() => {
        throw new Error('Simulated WebGL error');
      });
      expect(() => renderer.renderMultiAnglePips3D([mockSlot], shipAlpha)).toThrow('Simulated WebGL error');
      expect(aura.material.side).toBe(THREE.BackSide);
      expect(aura.material.opacity).toBe(povOpacity);
    });
  });
});

describe('Phase 20: Procedural PBR Bitmap Skinning for All 3D Models', () => {
  function assertValidDataTexture(tex, expectedColorSpace = null) {
    expect(tex).toBeDefined();
    expect(tex.isDataTexture).toBe(true);
    expect(tex.image).toBeDefined();
    expect(tex.image.width).toBeGreaterThanOrEqual(64);
    expect(tex.image.height).toBeGreaterThanOrEqual(64);
    expect(tex.image.data).toBeInstanceOf(Uint8Array);
    if (expectedColorSpace) {
      expect(tex.colorSpace).toBe(expectedColorSpace);
    }

    // Verify non-uniform RGBA detail (craters/fissures/plating/patterns exist)
    const data = tex.image.data;
    let minVal = 255;
    let maxVal = 0;
    for (let i = 0; i < data.length; i += 16) {
      const lum = data[i] + data[i + 1] + data[i + 2];
      const avg = Math.round(lum / 3);
      if (avg < minVal) minVal = avg;
      if (avg > maxVal) maxVal = avg;
    }
    expect(maxVal - minVal).toBeGreaterThan(20);
  }

  it('generates and caches deterministic RGBA DataTextures for every asset category', () => {
    for (let v = 0; v < 4; v++) {
      const ast1 = getAsteroidSkinBitmaps(v);
      const ast2 = getAsteroidSkinBitmaps(v);
      expect(ast1).toBe(ast2);
      assertValidDataTexture(ast1.map, THREE.SRGBColorSpace);
      assertValidDataTexture(ast1.bumpMap, THREE.NoColorSpace);
      assertValidDataTexture(ast1.roughnessMap, THREE.NoColorSpace);
    }

    for (const oreType of ['gold', 'titanium', 'plasma_crystal']) {
      const ore = getOreCrystalSkinBitmaps(oreType);
      expect(ore).toBe(getOreCrystalSkinBitmaps(oreType));
      assertValidDataTexture(ore.map, THREE.SRGBColorSpace);
      assertValidDataTexture(ore.bumpMap, THREE.NoColorSpace);
      assertValidDataTexture(ore.emissiveMap, THREE.SRGBColorSpace);
    }

    const shipHull = getShipHullSkinBitmaps();
    expect(getHullPanelDataTexture()).toBe(shipHull.bumpMap);
    assertValidDataTexture(shipHull.map, THREE.SRGBColorSpace);
    assertValidDataTexture(shipHull.bumpMap, THREE.NoColorSpace);
    assertValidDataTexture(shipHull.roughnessMap, THREE.NoColorSpace);

    const armor = getArmorPlateSkinBitmaps();
    assertValidDataTexture(armor.map, THREE.SRGBColorSpace);
    assertValidDataTexture(armor.bumpMap, THREE.NoColorSpace);
    assertValidDataTexture(armor.roughnessMap, THREE.NoColorSpace);

    const liveryAlpha = getTeamLiverySkinBitmaps('alpha');
    const liveryOmega = getTeamLiverySkinBitmaps('omega');
    expect(liveryAlpha).toBe(getTeamLiverySkinBitmaps('alpha'));
    expect(liveryOmega).toBe(getTeamLiverySkinBitmaps('omega'));
    assertValidDataTexture(liveryAlpha.map, THREE.SRGBColorSpace);
    assertValidDataTexture(liveryOmega.map, THREE.SRGBColorSpace);

    const greeble = getGreebleSkinBitmaps();
    assertValidDataTexture(greeble.map, THREE.SRGBColorSpace);
    assertValidDataTexture(greeble.bumpMap, THREE.NoColorSpace);

    const canopyAlpha = getCanopyGlassSkinBitmaps('alpha');
    const canopyOmega = getCanopyGlassSkinBitmaps('omega');
    assertValidDataTexture(canopyAlpha.map, THREE.SRGBColorSpace);
    assertValidDataTexture(canopyOmega.emissiveMap, THREE.SRGBColorSpace);

    const nozzle = getNozzleSkinBitmaps();
    assertValidDataTexture(nozzle.map, THREE.SRGBColorSpace);
    assertValidDataTexture(nozzle.bumpMap, THREE.NoColorSpace);

    const radiator = getRadiatorSkinBitmaps();
    assertValidDataTexture(radiator.map, THREE.SRGBColorSpace);
    assertValidDataTexture(radiator.bumpMap, THREE.NoColorSpace);

    assertValidDataTexture(getShieldHexSkinBitmap(), THREE.SRGBColorSpace);
    assertValidDataTexture(getPlumePlasmaSkinBitmap(), THREE.SRGBColorSpace);

    const debris = getDebrisSkinBitmaps();
    assertValidDataTexture(debris.map, THREE.SRGBColorSpace);
    assertValidDataTexture(debris.bumpMap, THREE.NoColorSpace);

    const mine = getMineSkinBitmaps();
    assertValidDataTexture(mine.map, THREE.SRGBColorSpace);
    assertValidDataTexture(mine.bumpMap, THREE.NoColorSpace);

    const derelictHull = getDerelictHullSkinBitmaps();
    assertValidDataTexture(derelictHull.map, THREE.SRGBColorSpace);
    assertValidDataTexture(derelictHull.bumpMap, THREE.NoColorSpace);

    const solar = getSolarPanelSkinBitmaps();
    assertValidDataTexture(solar.map, THREE.SRGBColorSpace);
    assertValidDataTexture(solar.bumpMap, THREE.NoColorSpace);

    const hazard = getHazardStripeSkinBitmaps();
    assertValidDataTexture(hazard.map, THREE.SRGBColorSpace);
    assertValidDataTexture(hazard.bumpMap, THREE.NoColorSpace);

    assertValidDataTexture(getAccretionDiskSkinBitmap(), THREE.SRGBColorSpace);
    assertValidDataTexture(getNebulaCloudSkinBitmap(), THREE.SRGBColorSpace);

    const torpedo = getTorpedoSkinBitmaps();
    assertValidDataTexture(torpedo.map, THREE.SRGBColorSpace);
    assertValidDataTexture(torpedo.bumpMap, THREE.NoColorSpace);
  });

  it('skins asteroids, boulders, ore crystals, and ridge studs with craters & fissures and spherical UVs', () => {
    const renderer = new SpaceRenderer(createMockCanvas());
    const radius = 120;
    const ast = {
      id: 'ast_crater_fissure_test',
      x: 200,
      y: -150,
      z: 20,
      radius,
      hp: 300,
      maxHp: 300,
      oreVeins: [
        { type: 'gold', angle: 0.4, depth: 0.55 },
        { type: 'plasma_crystal', angle: 2.1, depth: 0.6 },
      ],
    };

    renderer.syncAsteroids3D([ast], 0.016);
    const mesh = renderer.asteroidMeshes.get(ast.id);
    expect(mesh).toBeDefined();

    // Main asteroid bitmap skin & UVs & displacement bounds
    expect(mesh.material.map?.isDataTexture).toBe(true);
    expect(mesh.material.bumpMap?.isDataTexture).toBe(true);
    expect(mesh.material.roughnessMap?.isDataTexture).toBe(true);
    expect(mesh.material.bumpScale).toBeGreaterThan(1.0);
    expect(mesh.material.flatShading).toBe(false);
    expect(mesh.geometry.attributes.uv).toBeDefined();

    const posAttr = mesh.geometry.attributes.position;
    let minD = Infinity;
    let maxD = 0;
    for (let i = 0; i < posAttr.count; i++) {
      const d = Math.hypot(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
    expect(minD).toBeGreaterThanOrEqual(radius * 0.65);
    expect(maxD).toBeLessThanOrEqual(radius * 1.22);
    expect(maxD - minD).toBeGreaterThan(10);

    // Child boulders, ore crystals, fissure accents & mineral studs must also be skinned
    const boulders = mesh.children.filter(c => c.isMesh && c.geometry?.type === 'DodecahedronGeometry');
    expect(boulders.length).toBeGreaterThanOrEqual(3);
    for (const b of boulders) {
      expect(b.geometry.attributes.uv).toBeDefined();
      expect(b.material.map?.isDataTexture).toBe(true);
      expect(b.material.bumpMap?.isDataTexture).toBe(true);
    }

    const oreClusters = mesh.children.filter(c => c.name === 'oreCluster');
    expect(oreClusters.length).toBe(2);
    for (const cluster of oreClusters) {
      for (const part of cluster.children) {
        expect(part.material.map?.isDataTexture).toBe(true);
        expect(part.material.emissiveMap?.isDataTexture).toBe(true);
      }
    }

    // 2D fallback draws crater circles and fissure crack lines cleanly
    const mock2d = createMockContext();
    renderer.drawAsteroid(mock2d, ast);
    expect(mock2d.arc.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mock2d.lineTo.mock.calls.length).toBeGreaterThan(0);
  });

  it('skins all starship classes, arena pylons, black holes, nebulae, debris, mines, derelict, torpedoes & explosions', () => {
    const renderer = new SpaceRenderer(createMockCanvas());

    // 1. All 3 starship hull classes & teams
    for (const hullClass of ['corvette', 'frigate', 'dreadnought']) {
      for (const team of ['alpha', 'omega']) {
        const shipGroup = renderer.createShipMesh3D(hullClass, team);
        let mappedMeshes = 0;
        shipGroup.traverse((child) => {
          if (child.isMesh && child.material?.map?.isDataTexture) {
            mappedMeshes++;
          }
          if (child.isMesh && child.material?.bumpMap) {
            expect(child.material.bumpScale).toBeCloseTo(0.45, 2);
          }
        });
        expect(mappedMeshes).toBeGreaterThanOrEqual(15);

        // Shield hex quad keeps Phase 11 opacity & culling invariants alongside hex bitmap
        for (const quad of Object.values(shipGroup.shieldQuads)) {
          expect(quad.surface.material.map?.isDataTexture).toBe(true);
          expect(quad.surface.material.opacity).toBeCloseTo(0.10, 2);
          expect(quad.surface.material.side).toBe(THREE.FrontSide);
          expect(quad.surface.material.depthWrite).toBe(false);
        }
      }
    }

    // 2. Arena pylons
    renderer.syncArena3D(2700);
    const pylonGroup = renderer.arenaMesh.userData.beaconGroup;
    expect(pylonGroup).toBeDefined();
    const firstBuoy = pylonGroup.children[0];
    const pylonMesh = firstBuoy.children.find(c => c.isMesh && c.geometry?.type === 'CylinderGeometry');
    expect(pylonMesh.material.map?.isDataTexture).toBe(true);
    expect(pylonMesh.material.bumpMap?.isDataTexture).toBe(true);

    // 3. Gravity wells (accretion disk & jets)
    renderer.syncGravityWells3D([{ id: 'gw1', pos: { x: 0, y: 0, z: 0 }, eventHorizonRadius: 40 }], 0.016);
    const well = renderer.wellMeshes.get('well_0');
    expect(well.userData.accretionDisk.material.map?.isDataTexture).toBe(true);
    const wellJets = well.children.filter(c => c.isMesh && c.geometry?.type === 'ConeGeometry');
    expect(wellJets.length).toBe(2);
    for (const jet of wellJets) {
      expect(jet.material.map?.isDataTexture).toBe(true);
    }

    // 4. Ion Nebulae
    renderer.syncNebulae3D([{ id: 'neb1', pos: { x: 400, y: 300, z: 0 }, radius: 180 }], 0.016);
    const neb = renderer.nebulaMeshes.get('neb1');
    const nebSpheres = neb.children.filter(c => c.isMesh && c.geometry?.type === 'SphereGeometry');
    expect(nebSpheres.length).toBe(3);
    for (const sph of nebSpheres) {
      expect(sph.material.map?.isDataTexture).toBe(true);
    }

    // 5. Debris & Tether Mines
    renderer.syncDebrisAndMines3D(
      [{ id: 'deb1', pos: { x: -300, y: 100, z: 0 }, radius: 16 }],
      [{ id: 'mine1', pos: { x: 300, y: -100, z: 0 }, radius: 18 }],
      0.016
    );
    const debGroup = renderer.debrisMeshes.get('deb1');
    for (const part of debGroup.children) {
      expect(part.material.map?.isDataTexture).toBe(true);
      expect(part.material.bumpMap?.isDataTexture).toBe(true);
    }
    const mineGroup = renderer.mineMeshes.get('mine1');
    const mineBody = mineGroup.children.find(c => c.geometry?.type === 'DodecahedronGeometry');
    expect(mineBody.geometry.attributes.uv).toBeDefined();
    expect(mineBody.material.map?.isDataTexture).toBe(true);
    expect(mineBody.material.bumpMap?.isDataTexture).toBe(true);

    // 6. Munitions Derelict
    renderer.syncDerelict3D({ id: 'derelict_0', pos: { x: 0, y: 500, z: 0 }, active: true }, {}, 0.016);
    let derelictTexturedCount = 0;
    renderer.derelictMesh.traverse((child) => {
      if (child.isMesh && child.material?.map?.isDataTexture) {
        derelictTexturedCount++;
      }
    });
    expect(derelictTexturedCount).toBeGreaterThanOrEqual(20);

    // 7. Homing Torpedo projectile
    renderer.syncProjectiles3D(
      [{ id: 'torp1', type: 'torpedo', torpedoType: 'heavy_torpedoes', pos: { x: 10, y: 20, z: 0 }, vel: { x: 100, y: 0, z: 0 }, angle: 0 }],
      0.016
    );
    const torpGroup = renderer.projectileMeshes.get('torp1');
    const torpBody = torpGroup.children.find(c => c.geometry?.type === 'CylinderGeometry');
    expect(torpBody.material.map?.isDataTexture).toBe(true);
    expect(torpBody.material.bumpMap?.isDataTexture).toBe(true);
    const torpFin = torpGroup.children.find(c => c.geometry?.type === 'BoxGeometry');
    expect(torpFin.material.map?.isDataTexture).toBe(true);

    // 8. Ship explosion alloy shards
    renderer.triggerShipExplosion3D('alpha', { x: 0, y: 0, z: 0 }, 'frigate', 'alpha');
    expect(renderer.explosions3D.length).toBeGreaterThan(0);
    const exp = renderer.explosions3D[0];
    const plateFrags = exp.fragments.filter(f => f.mesh?.geometry?.type === 'BoxGeometry');
    expect(plateFrags.length).toBeGreaterThan(0);
    for (const frag of plateFrags) {
      expect(frag.mesh.material.map?.isDataTexture).toBe(true);
    }
  });
});
