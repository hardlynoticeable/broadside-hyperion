/**
 * BROADSIDE HYPERION — True 3D (Three.js) Tactical Space Renderer
 *
 * Implements a dual-mode rendering pipeline:
 * - Authoritative 3D Scene Graph (Three.js):
 *   - Perspective Camera tilted at 30° tactical pitch with dynamic orbital sweep during 5x slow-mo kill-cam
 *   - Intricate Multi-Layered Capital Starships (Corvette, Frigate, Dreadnought)
 *   - True 3D Barrel Roll on hullRollGroup around longitudinal X-axis
 *   - Articulated 3D hardware: rotating/recoiling turrets, glowing spinal railgun, 6 RCS nozzle pods with ConeGeometry plumes, multi-cone fusion plasma plumes, radiator fin arrays ramping from dark gunmetal to white-hot
 *   - 4-Quadrant 3D Geodesic Hex Shields with WireframeGeometry lattice
 *   - 3D Polyhedral tumbling asteroids with flat shading, dark craters & crystal ore veins
 *   - 3D Singularities with black event horizon, glowing photon ring, tilted accretion disk & relativistic polar jets
 *   - Volumetric-style ion storm nebulae, tumbling debris chunks, spiked tether mines & orbital munitions derelict
 * - WebGLRenderer in real browser environments with ACESFilmicToneMapping & high performance
 * - 3D-projected fallback rendering onto 2D canvas context for test/headless environments
 * - Static Helper: renderMiniGrid10x10 for Engineer & Spectator PiP Overlays
 * - ZERO Solar Flares and ZERO Asteroid Shadows
 */

import * as THREE from 'three';
import {
  normalizeGeometryUVs,
  applySphericalUVs,
  getAsteroidSkinBitmaps,
  getOreCrystalSkinBitmaps,
  getHullPanelDataTexture,
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
} from './textures.js';

export const BSG_HULL_RADII = { corvette: 40, frigate: 60, dreadnought: 90 };

/**
 * Evaluates whether external optical viewport blackout is active (<4.0s during hyperspace exit reboot).
 *
 * @param {object} myShip
 * @param {string} cameraMode
 * @returns {boolean}
 */
export function isExternalBlackoutActive(myShip, cameraMode) {
  if (cameraMode === 'spectator' || cameraMode === 'bsg_replay') return false;
  return myShip?.hyperspace?.state === 'rebooting' && (myShip.hyperspace.rebootTimer ?? 0) < 4.0;
}

// --- SEEDED PRNG & PROCEDURAL HULL TEXTURE HELPERS (HEADLESS-SAFE) ---

/**
 * Fast 32-bit FNV-1a string hash.
 * @param {string} str
 * @returns {number} 32-bit unsigned integer
 */
export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * Mulberry32 deterministic PRNG generator.
 * @param {number} seed
 * @returns {() => number} Returns float in [0, 1)
 */
export function createPrng(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { getHullPanelDataTexture };

export class SpaceRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.width = canvas ? (canvas.width || 1280) : 1280;
    this.height = canvas ? (canvas.height || 720) : 720;
    this.dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;

    // Simulation & Animation Timers
    this.animTime = 0;
    this.lastFrameTime = performance.now();

    // Camera State
    this.cameraPos = { x: 0, y: 0 };
    this.zoom = 1.0;

    // 1. Full Three.js 3D Authoritative Scene Graph
    this.scene = new THREE.Scene();
    this.camera3d = new THREE.PerspectiveCamera(45, this.width / Math.max(1, this.height), 10, 60000);
    this.shipMeshes = new Map();
    this.asteroidMeshes = new Map();
    this.wellMeshes = new Map();
    this.nebulaMeshes = new Map();
    this.mineMeshes = new Map();
    this.debrisMeshes = new Map();
    this.projectileMeshes = new Map();
    this.derelictMesh = null;
    this.arenaMesh = null;
    this.leadReticleMesh = null;

    // 3D Explosions and Particle FX
    this.explosions3D = [];
    this.explodedShips = new Set();
    this.particles3D = [];
    this.bsgReplayCam = this.createBsgReplayState();
    this._lastSnapshotTick = null;
    this._wasReplayActive = false;

    // Headless-safe Hyperspace VFX State
    this.warpFlashes = [];
    this._lastWarpEnterCount = new Map();
    this._lastWarpExitCount = new Map();
    this._shipHyperspaceStates = new Map();
    this._wasWarpJumping = false;
    this.warpStreaks3d = null;
    this._warpStreakDefs = [];

    // 3D Scene Lighting
    this.initLighting3D();

    // 3D Background Starfield Dome & PiP Camera
    this.initStarfield3D();
    this.initWarpStreaks3D();
    this.pipCamera = new THREE.PerspectiveCamera(44, 1, 1, 20000);

    // 2. Dual-Mode WebGL / 2D Canvas Fallback
    this.webglRenderer = null;
    this.ctx = null;

    const isCanvasElement = typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
    const hasWebGLContext = typeof WebGLRenderingContext !== 'undefined';

    if (isCanvasElement && hasWebGLContext) {
      try {
        this.webglRenderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          powerPreference: 'high-performance',
        });
        this.webglRenderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.webglRenderer.toneMappingExposure = 1.2;
        this.webglRenderer.setPixelRatio(this.dpr);
        this.webglRenderer.setSize(this.width, this.height, false);
      } catch (e) {
        this.webglRenderer = null;
      }
    }

    if (!this.webglRenderer) {
      this.ctx = (canvas && typeof canvas.getContext === 'function')
        ? canvas.getContext('2d', { alpha: false })
        : null;
    }

    // Parallax Stars & Dust Specks (for deep space background)
    this.initBackgroundStars();

    // Persistent Particles
    this.fxParticles = [];
  }

  /**
   * Initializes 3D scene lighting (ambient, key directional, and cyan rim light).
   */
  initLighting3D() {
    this.ambientLight = new THREE.AmbientLight(0x1a2333, 1.2);
    this.scene.add(this.ambientLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.dirLight.position.set(1500, -2000, 3000);
    this.scene.add(this.dirLight);

    this.rimLight = new THREE.DirectionalLight(0x38bdf8, 1.4);
    this.rimLight.position.set(-2000, 1500, -1000);
    this.scene.add(this.rimLight);
  }

  /**
   * Clears and disposes active 3D particle and explosion effects from scene.
   */
  clearEffects3D() {
    for (const exp of this.explosions3D) {
      if (exp && exp.group) {
        this.scene.remove(exp.group);
      }
    }
    this.explosions3D = [];

    for (const p of this.particles3D) {
      if (p && p.mesh) {
        this.scene.remove(p.mesh);
      }
    }
    this.particles3D = [];

    if (Array.isArray(this.warpFlashes)) {
      for (const flash of this.warpFlashes) {
        if (flash?.mesh && this.scene) {
          this.scene.remove(flash.mesh);
          flash.mesh.geometry?.dispose();
          flash.mesh.material?.dispose();
        }
      }
      this.warpFlashes = [];
    }

    if (this.warpStreaks3d) {
      this.warpStreaks3d.visible = false;
    }
    if (this.starfield3d) {
      this.starfield3d.visible = true;
    }

    this.explodedShips.clear();
  }

  /**
   * Initializes 3D background starfield dome with THREE.Points.
   * Provides rich spatial motion cues for 1st-person POV cameras (helm_pov / weapons_pov).
   */
  initStarfield3D() {
    const starCount = 1200;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
      const radius = 9500 + Math.random() * 2500;
      const theta = Math.random() * Math.PI * 2;
      const phi = (Math.random() - 0.5) * Math.PI;

      positions[i * 3] = radius * Math.cos(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi) * Math.sin(theta);
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6000;

      const isCyan = Math.random() > 0.85;
      const isAmber = !isCyan && Math.random() > 0.75;
      if (isCyan) {
        colors[i * 3] = 0.49; colors[i * 3 + 1] = 0.83; colors[i * 3 + 2] = 0.99;
      } else if (isAmber) {
        colors[i * 3] = 0.98; colors[i * 3 + 1] = 0.75; colors[i * 3 + 2] = 0.45;
      } else {
        colors[i * 3] = 0.9; colors[i * 3 + 1] = 0.93; colors[i * 3 + 2] = 1.0;
      }
    }

    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const starMat = new THREE.PointsMaterial({
      size: 2,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
    });
    this.starfield3d = new THREE.Points(starGeo, starMat);
    this.scene.add(this.starfield3d);
  }

  /**
   * Initializes 3D Star Trek style warp star-streaks tunnel using THREE.LineSegments.
   * 240 radial streaks = 480 vertices around active camera.
   */
  initWarpStreaks3D() {
    if (!this.scene || typeof THREE === 'undefined') return;

    const streakCount = 240;
    const vertexCount = streakCount * 2;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    this._warpStreakDefs = [];

    for (let i = 0; i < streakCount; i++) {
      const theta = (i / streakCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.15;
      const radius = 25 + Math.random() * 260;
      const rx = Math.cos(theta) * radius;
      const ry = Math.sin(theta) * radius;
      const zDist = -2000 + Math.random() * 4000;
      const speed = 3800 + Math.random() * 4000;

      this._warpStreakDefs.push({ rx, ry, zDist, speed });

      // Head vertex color: pure white or bright cyan
      const headColor = Math.random() > 0.4 ? [0.95, 0.98, 1.0] : [0.49, 0.83, 0.99];
      // Tail vertex color: cyan to indigo
      const tailColor = Math.random() > 0.5 ? [0.22, 0.74, 0.97] : [0.39, 0.35, 0.95];

      const cIdx = i * 6;
      colors[cIdx] = headColor[0];
      colors[cIdx + 1] = headColor[1];
      colors[cIdx + 2] = headColor[2];

      colors[cIdx + 3] = tailColor[0];
      colors[cIdx + 4] = tailColor[1];
      colors[cIdx + 5] = tailColor[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.warpStreaks3d = new THREE.LineSegments(geo, mat);
    this.warpStreaks3d.visible = false;
    this.scene.add(this.warpStreaks3d);
  }

  /**
   * Spawns a Cherenkov warp flash burst at the given position.
   * Headless-safe pure array push with optional 3D mesh.
   *
   * @param {object} pos
   * @param {number} [color=0x7dd3fc]
   * @returns {object|null}
   */
  spawnWarpFlash(pos, color = 0x7dd3fc) {
    if (!pos) return null;
    const flash = {
      x: pos.x || 0,
      y: pos.y || 0,
      z: pos.z || 0,
      age: 0,
      maxAge: 0.65,
      color,
      mesh: null,
    };

    if (this.scene && typeof THREE !== 'undefined') {
      try {
        const geo = new THREE.SphereGeometry(24, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        flash.mesh = new THREE.Mesh(geo, mat);
        flash.mesh.position.set(flash.x, -flash.y, flash.z);
        this.scene.add(flash.mesh);
      } catch (e) {
        flash.mesh = null;
      }
    }

    this.warpFlashes.push(flash);
    if (this.warpFlashes.length > 40) {
      const oldest = this.warpFlashes.shift();
      if (oldest?.mesh && this.scene) {
        this.scene.remove(oldest.mesh);
        oldest.mesh.geometry?.dispose();
        oldest.mesh.material?.dispose();
      }
    }
    return flash;
  }

  /**
   * Updates and prunes active warp flashes in 3D.
   *
   * @param {number} [dt=0.016]
   */
  syncWarpFlashes3D(dt = 0.016) {
    if (!Array.isArray(this.warpFlashes)) return;
    for (let i = this.warpFlashes.length - 1; i >= 0; i--) {
      const flash = this.warpFlashes[i];
      flash.age += dt;
      const progress = flash.age / flash.maxAge;
      if (progress >= 1.0) {
        if (flash.mesh && this.scene) {
          this.scene.remove(flash.mesh);
          flash.mesh.geometry?.dispose();
          flash.mesh.material?.dispose();
        }
        this.warpFlashes.splice(i, 1);
      } else {
        if (flash.mesh) {
          const scale = 1.0 + progress * 7.0;
          flash.mesh.scale.set(scale, scale, scale);
          if (flash.mesh.material) {
            flash.mesh.material.opacity = Math.max(0, 0.95 * (1.0 - progress));
          }
        }
      }
    }
  }

  /**
   * Updates 3D Star Trek warp streaks tunnel and camera FOV during hyperspace jump.
   *
   * @param {object} myShip
   * @param {string} cameraMode
   * @param {number} [dt=0.016]
   */
  updateWarpStreaks3D(myShip, cameraMode, dt = 0.016) {
    if (!this.scene || typeof THREE === 'undefined') return;

    const isSpectator = cameraMode === 'spectator' || cameraMode === 'bsg_replay';
    const isJumping = !isSpectator && myShip?.hyperspace?.state === 'jumping';

    if (!isJumping) {
      if (this.warpStreaks3d) {
        this.warpStreaks3d.visible = false;
      }
      if (this.starfield3d) {
        this.starfield3d.visible = true;
      }
      if (this._wasWarpJumping) {
        this._wasWarpJumping = false;
        // Strictly reset camera3d.fov = 45 whenever not jumping (unless BSG replay zoom / weapons zoom is active)
        if (this.camera3d && cameraMode !== 'bsg_replay' && cameraMode !== 'weapons_pov') {
          this.camera3d.fov = 45;
          this.camera3d.updateProjectionMatrix();
        }
      }
      return;
    }

    this._wasWarpJumping = true;
    if (this.starfield3d) {
      this.starfield3d.visible = false;
    }

    if (!this.warpStreaks3d) {
      this.initWarpStreaks3D();
    }
    if (!this.warpStreaks3d) return;
    this.warpStreaks3d.visible = true;

    const jt = Math.max(0, Math.min(2.2, myShip.hyperspace?.jumpTimer ?? 0));
    const jumpDuration = 2.2;

    // Modulate camera3d.fov: ramp 45° -> 78° over first 0.45s of jump, hold dramatic wide warp stretch in transit, snap back 78° -> 45° over final 0.35s
    let targetFov = 78;
    if (jt < 0.45) {
      const p = jt / 0.45;
      targetFov = 45 + p * (78 - 45);
    } else if (jt > jumpDuration - 0.35) {
      const p = Math.max(0, (jumpDuration - jt) / 0.35);
      targetFov = 45 + p * (78 - 45);
    }
    if (this.camera3d) {
      this.camera3d.fov = targetFov;
      this.camera3d.updateProjectionMatrix();
    }

    const angle = myShip.angle || 0;
    const pitch = myShip.pitch || 0;
    const roll = myShip.rollAngle !== undefined ? myShip.rollAngle : ((myShip.rollState || 0) * Math.PI);

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    const F3 = new THREE.Vector3(cosA * cosP, -sinA * cosP, sinP).normalize();
    const U3 = new THREE.Vector3(
      -cosA * sinP * cosR - sinA * sinR,
      sinA * sinP * cosR - cosA * sinR,
      cosP * cosR
    ).normalize();
    const R3 = new THREE.Vector3().crossVectors(F3, U3).normalize();

    // Tail elongation: 90m -> 980m scaling smoothly from jumpTimer across jumpDuration (2.2s)
    const tailElongation = 90 + (jt / jumpDuration) * (980 - 90);

    const camPos = this.camera3d ? this.camera3d.position : new THREE.Vector3();
    const posAttr = this.warpStreaks3d.geometry.attributes.position;
    const posArr = posAttr.array;

    const streakCount = this._warpStreakDefs ? this._warpStreakDefs.length : 240;
    for (let i = 0; i < streakCount; i++) {
      const def = this._warpStreakDefs[i];
      // Scroll streak past camera rapidly (3800..7800 m/s)
      def.zDist -= def.speed * dt;
      if (def.zDist < -2200) {
        def.zDist += 4400;
      }

      const headX = camPos.x + F3.x * def.zDist + R3.x * def.rx + U3.x * def.ry;
      const headY = camPos.y + F3.y * def.zDist + R3.y * def.rx + U3.y * def.ry;
      const headZ = camPos.z + F3.z * def.zDist + R3.z * def.rx + U3.z * def.ry;

      const tailX = headX + F3.x * tailElongation;
      const tailY = headY + F3.y * tailElongation;
      const tailZ = headZ + F3.z * tailElongation;

      const idx = i * 6;
      posArr[idx] = headX;
      posArr[idx + 1] = headY;
      posArr[idx + 2] = headZ;
      posArr[idx + 3] = tailX;
      posArr[idx + 4] = tailY;
      posArr[idx + 5] = tailZ;
    }

    posAttr.needsUpdate = true;
  }

  /**
   * Helper evaluating whether external optical viewport blackout is active (<4.0s during hyperspace exit reboot).
   */
  isExternalBlackoutActive(myShip, cameraMode) {
    return isExternalBlackoutActive(myShip, cameraMode);
  }

  static isExternalBlackoutActive(myShip, cameraMode) {
    return isExternalBlackoutActive(myShip, cameraMode);
  }

  /**
   * Initializes multi-layered background starfield and space dust.
   */
  initBackgroundStars() {
    this.distantNebulae = [
      { x: -1400, y: -900, radius: 900, color: 'rgba(56, 189, 248, 0.05)' },
      { x: 1200, y: 800, radius: 1100, color: 'rgba(192, 132, 252, 0.06)' },
      { x: -600, y: 1400, radius: 800, color: 'rgba(244, 63, 94, 0.04)' },
      { x: 1800, y: -1200, radius: 1000, color: 'rgba(16, 185, 129, 0.04)' },
    ];

    // Layer 2: 180 Twinkling Background Stars
    this.stars = [];
    for (let i = 0; i < 180; i++) {
      this.stars.push({
        x: (Math.random() - 0.5) * 8000,
        y: (Math.random() - 0.5) * 8000,
        radius: 0.6 + Math.random() * 1.5,
        twinkleSpeed: 1.5 + Math.random() * 3.0,
        twinklePhase: Math.random() * Math.PI * 2,
        color: Math.random() > 0.8 ? '#93c5fd' : (Math.random() > 0.6 ? '#fed7aa' : '#ffffff'),
      });
    }

    // Layer 3: 100 Foreground Space Dust Specks
    this.dustSpecks = [];
    for (let i = 0; i < 100; i++) {
      this.dustSpecks.push({
        x: (Math.random() - 0.5) * 4000,
        y: (Math.random() - 0.5) * 4000,
        size: 1.0 + Math.random() * 1.5,
        alpha: 0.2 + Math.random() * 0.4,
      });
    }
  }

  /**
   * Resizes canvas buffer and updates perspective camera aspect.
   */
  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement?.getBoundingClientRect() || (this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : {});
    this.width = Math.max(1, Math.floor(rect.width || (typeof window !== 'undefined' ? window.innerWidth : 800)));
    this.height = Math.max(1, Math.floor(rect.height || (typeof window !== 'undefined' ? window.innerHeight - 54 : 600)));
    this.dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

    if (this.camera3d) {
      this.camera3d.aspect = this.width / this.height;
      this.camera3d.updateProjectionMatrix();
    }

    if (this.webglRenderer) {
      this.webglRenderer.setPixelRatio(this.dpr);
      this.webglRenderer.setSize(this.width, this.height, false);
    } else {
      if (this.canvas) {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
      }
      if (this.ctx && this.ctx.setTransform && this.ctx.scale) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(this.dpr, this.dpr);
      }
    }
  }

  /**
   * Updates 3D perspective camera with coordinate mapping and tactical tilt.
   *
   * Maps 2D world coords (x, y) to 3D (x, -y, z).
   * Tilts camera at 30° from vertical along -Y and +Z.
   * During slowMoActive, pitches to 38° with smooth orbital azimuth sweep.
   *
   * @param {object} cameraPos - 2D center { x, y }
   * @param {number} zoom - Viewport zoom factor
   * @param {boolean} slowMoActive - Killing Blow slow-mo flag
   */
  updateCamera3D(cameraPos, zoom, slowMoActive) {
    if (!this.camera3d) return;

    const targetAspect = this.width / Math.max(1, this.height);
    if (this.camera3d.fov !== 45 || this.camera3d.near !== 10 || Math.abs((this.camera3d.aspect || 0) - targetAspect) > 1e-4) {
      this.camera3d.fov = 45;
      this.camera3d.near = 10;
      this.camera3d.aspect = targetAspect;
      this.camera3d.updateProjectionMatrix();
    }

    const targetX = cameraPos.x || 0;
    const targetY = -(cameraPos.y || 0);
    const targetZ = cameraPos.z || 0;

    const aspect = this.width / Math.max(1, this.height);
    const effectiveHeight = aspect < 1 ? (this.height / Math.max(0.55, aspect)) : this.height;

    const fovRad = (this.camera3d.fov * Math.PI) / 180;
    const clampedZoom = Math.max(0.02, Math.min(2.5, zoom || 1.0));
    const distance = (effectiveHeight / clampedZoom) / (2 * Math.tan(fovRad / 2));

    let pitchAngle = (30 * Math.PI) / 180; // 30° from vertical
    let azimuth = 0;

    if (slowMoActive) {
      pitchAngle = (38 * Math.PI) / 180; // 38° in slow-mo
      azimuth = this.animTime * 0.45;     // Smooth orbital sweep
    }

    const sinPitch = Math.sin(pitchAngle);
    const cosPitch = Math.cos(pitchAngle);

    const offsetX = Math.sin(azimuth) * distance * sinPitch;
    const offsetY = -Math.cos(azimuth) * distance * sinPitch;
    const offsetZ = distance * cosPitch;

    this.camera3d.position.set(targetX + offsetX, targetY + offsetY, targetZ + offsetZ);
    this.camera3d.up.set(0, 1, 0);
    this.camera3d.lookAt(targetX, targetY, targetZ);
    this.camera3d.updateMatrixWorld();
  }

  /**
   * Updates 3D camera for Helm forward POV.
   * Positioned on dorsal bridge over prow, looking forward along heading,
   * with horizon banking synchronized to continuous ship rollAngle and pitch.
   *
   * @param {object} myShip
   */
  updateHelmCamera3D(myShip) {
    if (!this.camera3d || !myShip) return;

    this.camera3d.fov = 62;
    this.camera3d.near = 2;
    this.camera3d.aspect = this.width / Math.max(1, this.height);
    this.camera3d.updateProjectionMatrix();

    const hullClass = myShip.hullClass || 'frigate';
    const L = hullClass === 'dreadnought' ? 90 : (hullClass === 'corvette' ? 40 : 60);
    const H = hullClass === 'dreadnought' ? 22 : (hullClass === 'corvette' ? 10 : 14);

    const sx = myShip.pos?.x || 0;
    const sy = -(myShip.pos?.y || 0);
    const sz = myShip.pos?.z || 0;
    const angle = myShip.angle || 0;
    const pitch = myShip.pitch || 0;
    const roll = myShip.rollAngle !== undefined ? myShip.rollAngle : ((myShip.rollState || 0) * Math.PI);

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    // Forward vector F3 and Up vector U3 from ZYX rotation:
    const F3 = new THREE.Vector3(cosA * cosP, -sinA * cosP, sinP);
    const U3 = new THREE.Vector3(
      -cosA * sinP * cosR - sinA * sinR,
      sinA * sinP * cosR - cosA * sinR,
      cosP * cosR
    );

    // Bridge camera mount at (-0.22 * L, 0, +0.95 * H) along F3 and U3
    const camPos = new THREE.Vector3(sx, sy, sz)
      .addScaledVector(F3, -0.22 * L)
      .addScaledVector(U3, 0.95 * H);
    this.camera3d.position.copy(camPos);

    // Look forward along F3 slightly pitched down along -0.025 * U3
    const lookDist = 900;
    const target = camPos.clone().addScaledVector(F3, lookDist).addScaledVector(U3, -0.025 * lookDist);

    this.camera3d.up.copy(U3).normalize();
    this.camera3d.lookAt(target);
    this.camera3d.updateMatrixWorld();
  }

  /**
   * Updates 3D camera for Weapons free-look POV.
   * Positioned above dorsal turret cupola, looking toward gunnerWorldAngle,
   * gently banked by ship roll so maneuvers feel visceral.
   *
   * @param {object} myShip
   * @param {number} gunnerWorldAngle
   * @param {number} [pitchOffset=0]
   */
  updateWeaponsCamera3D(myShip, gunnerWorldAngle, pitchOffset = 0, weaponsZoom = 1.0) {
    if (!this.camera3d || !myShip) return;

    const safeZoom = Math.max(0.6, Math.min(5.0, Number.isFinite(weaponsZoom) ? weaponsZoom : 1.0));
    const halfBaseRad = (62 * Math.PI) / 360;
    const fovDeg = (2 * Math.atan(Math.tan(halfBaseRad) / safeZoom) * 180) / Math.PI;
    this.camera3d.fov = Math.max(12, Math.min(95, fovDeg));
    this.camera3d.near = 2;
    this.camera3d.aspect = this.width / Math.max(1, this.height);
    this.camera3d.updateProjectionMatrix();

    const hullClass = myShip.hullClass || 'frigate';
    const L = hullClass === 'dreadnought' ? 90 : (hullClass === 'corvette' ? 40 : 60);
    const H = hullClass === 'dreadnought' ? 22 : (hullClass === 'corvette' ? 10 : 14);

    const sx = myShip.pos?.x || 0;
    const sy = -(myShip.pos?.y || 0);
    const sz = myShip.pos?.z || 0;
    const angle = myShip.angle || 0;
    const pitch = myShip.pitch || 0;
    const roll = (myShip.rollAngle !== undefined ? myShip.rollAngle : ((myShip.rollState || 0) * Math.PI)) * 0.5;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    const F3 = new THREE.Vector3(cosA * cosP, -sinA * cosP, sinP);
    const U3 = new THREE.Vector3(
      -cosA * sinP * cosR - sinA * sinR,
      sinA * sinP * cosR - cosA * sinR,
      cosP * cosR
    );

    // Turret cupola mount at (-0.04 * L, 0, +1.15 * H) along F3 and U3
    const camPos = new THREE.Vector3(sx, sy, sz)
      .addScaledVector(F3, -0.04 * L)
      .addScaledVector(U3, 1.15 * H);
    this.camera3d.position.copy(camPos);

    const a = gunnerWorldAngle;
    const pEff = Math.max(-1.39, Math.min(1.39, -0.03 + (pitchOffset || 0)));
    const cosEff = Math.cos(pEff);
    const sinEff = Math.sin(pEff);

    const lookDist = 900;
    const lookDir = new THREE.Vector3(cosEff * Math.cos(a), -cosEff * Math.sin(a), sinEff);
    const target = camPos.clone().addScaledVector(lookDir, lookDist);

    const cosG = Math.cos(a);
    const sinG = Math.sin(a);
    const upVec = new THREE.Vector3(
      -cosG * sinP * cosR - sinG * sinR,
      sinG * sinP * cosR - cosG * sinR,
      cosP * cosR
    );

    this.camera3d.up.copy(upVec).normalize();
    this.camera3d.lookAt(target);
    this.camera3d.updateMatrixWorld();
  }

  /**
   * Creates initial state object for the Battlestar Galactica (2003) 3D replay camera director.
   * @returns {object}
   */
  createBsgReplayState() {
    return {
      active: false,
      lastBeat: -1,
      sideSign: 1,
      trackedProjId: null,
      pos: new THREE.Vector3(0, -300, 80),
      lookAt: new THREE.Vector3(0, 0, 0),
      fov: 50,
      dutchRoll: 0,
      shakeIntensity: 0,
      shakeTime: 0,
      initialized: false,
    };
  }

  /**
   * Resets the BSG replay camera state.
   */
  resetBsgReplayCamera() {
    this.bsgReplayCam = this.createBsgReplayState();
  }

  /**
   * Updates 3D camera using the BSG (2003) dynamic Zoic Studios camera director:
   * 4 editorial beats (Broadside tracking, Ordnance flyby/whip-pan, Telephoto crash-zoom, Destruction orbit),
   * organic multi-frequency handheld weave, event trauma impulse/decay, safe standoff avoidance, and Dutch tilt.
   *
   * @param {object} snapshot
   * @param {number} [dt=1/60]
   */
  updateBsgReplayCamera3D(snapshot, dt = 1 / 60) {
    if (!this.camera3d) return;
    if (!this.bsgReplayCam) {
      this.bsgReplayCam = this.createBsgReplayState();
    }
    const state = this.bsgReplayCam;

    const safeNum = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
    const simToThree = (p) => new THREE.Vector3(safeNum(p?.x), -safeNum(p?.y), safeNum(p?.z));
    const stepDt = Math.max(0.001, Math.min(0.1, safeNum(dt, 1 / 60)));

    state.active = true;
    state.shakeTime += stepDt;

    // Decay trauma
    state.shakeIntensity *= Math.exp(-3.2 * stepDt);
    if (state.shakeIntensity < 0.001) state.shakeIntensity = 0;

    const ships = snapshot?.ships || {};
    const shipEntries = Object.entries(ships).filter(([_, s]) => Boolean(s));

    // Zero-ships fallback
    if (shipEntries.length === 0) {
      state.pos.set(0, -300, 80);
      state.lookAt.set(0, 0, 0);
      state.fov = 48;
      state.dutchRoll = 0;
      state.initialized = true;

      this.camera3d.fov = 48;
      this.camera3d.near = 2;
      this.camera3d.aspect = this.width / Math.max(1, this.height);
      this.camera3d.updateProjectionMatrix();
      this.camera3d.position.set(0, -300, 80);
      this.camera3d.up.set(0, 0, 1);
      this.camera3d.lookAt(0, 0, 0);
      this.camera3d.updateMatrixWorld();
      return;
    }

    // Resolve attacker and victim
    let attacker = null;
    let victim = null;
    let attackerTeam = 'alpha';
    let victimTeam = 'omega';

    if (shipEntries.length >= 2) {
      let t1 = 'alpha';
      let s1 = ships.alpha;
      let t2 = 'omega';
      let s2 = ships.omega;
      if (!s1 || !s2) {
        [t1, s1] = shipEntries[0];
        [t2, s2] = shipEntries[1];
      }

      const s1Dead = s1.destroyed === true || (Number.isFinite(s1.hullHp) && s1.hullHp <= 0);
      const s2Dead = s2.destroyed === true || (Number.isFinite(s2.hullHp) && s2.hullHp <= 0);

      if (s1Dead && !s2Dead) {
        victim = s1; victimTeam = t1;
        attacker = s2; attackerTeam = t2;
      } else if (s2Dead && !s1Dead) {
        victim = s2; victimTeam = t2;
        attacker = s1; attackerTeam = t1;
      } else if (snapshot?.winner === t1 || snapshot?.winner === t2) {
        if (snapshot.winner === t1) {
          attacker = s1; attackerTeam = t1;
          victim = s2; victimTeam = t2;
        } else {
          attacker = s2; attackerTeam = t2;
          victim = s1; victimTeam = t1;
        }
      } else {
        const r1 = safeNum(s1.hullHp, 1000) / (safeNum(s1.maxHullHp, 1000) || 1000);
        const r2 = safeNum(s2.hullHp, 1000) / (safeNum(s2.maxHullHp, 1000) || 1000);
        if (r1 < r2) {
          victim = s1; victimTeam = t1;
          attacker = s2; attackerTeam = t2;
        } else {
          victim = s2; victimTeam = t2;
          attacker = s1; attackerTeam = t1;
        }
      }
    } else {
      // Single-ship fallback
      const [onlyTeam, onlyShip] = shipEntries[0];
      attacker = onlyShip; attackerTeam = onlyTeam;
      victim = onlyShip; victimTeam = onlyTeam;
    }

    const a = safeNum(attacker.angle, 0);
    const pAngle = safeNum(attacker.pitch, 0);
    const F3 = new THREE.Vector3(
      Math.cos(a) * Math.cos(pAngle),
      -Math.sin(a) * Math.cos(pAngle),
      Math.sin(pAngle)
    );

    const attackerPos = simToThree(attacker.pos);
    const victimPos = simToThree(victim.pos);

    const aR = BSG_HULL_RADII[attacker.hullClass] || 60;
    const vR = BSG_HULL_RADII[victim.hullClass] || 60;

    let engageVec = victimPos.clone().sub(attackerPos);
    if (engageVec.lengthSq() < 1e-4) {
      engageVec = (F3.lengthSq() > 1e-4 ? F3.clone() : new THREE.Vector3(1, 0, 0));
    }
    const engageDir = engageVec.normalize();
    const worldUp = new THREE.Vector3(0, 0, 1);

    let perpRight = new THREE.Vector3().crossVectors(engageDir, worldUp);
    if (perpRight.lengthSq() < 1e-4) {
      perpRight.set(0, -1, 0);
    }
    perpRight.normalize();

    const perpUp = new THREE.Vector3().crossVectors(perpRight, engageDir).normalize();

    if (!state.initialized) {
      const tickVal = Math.round(safeNum(snapshot?.tick, 0));
      state.sideSign = (Math.abs(tickVal + (victimTeam === 'omega' ? 1 : 0)) % 2 === 0) ? 1 : -1;
    }
    const sideSign = state.sideSign || 1;

    // Compute progress p (0..1)
    let p = 0;
    if (Number.isFinite(snapshot?.replayProgress)) {
      p = snapshot.replayProgress;
    } else if (Number.isFinite(snapshot?.replayFrame?.progress)) {
      p = snapshot.replayFrame.progress;
    } else if (Number.isFinite(snapshot?.replayFrameIndex) && Number.isFinite(snapshot?.replayFrameCount)) {
      p = snapshot.replayFrameIndex / Math.max(1, snapshot.replayFrameCount - 1);
    } else if (Number.isFinite(snapshot?.replayFrame?.index) && Number.isFinite(snapshot?.replayFrame?.count)) {
      p = snapshot.replayFrame.index / Math.max(1, snapshot.replayFrame.count - 1);
    } else if (Number.isFinite(snapshot?.replayFrame?.frameIndex) && Number.isFinite(snapshot?.replayFrame?.frameCount)) {
      p = snapshot.replayFrame.frameIndex / Math.max(1, snapshot.replayFrame.frameCount - 1);
    }
    p = Math.max(0, Math.min(1, safeNum(p, 0)));

    const smoothstep = (x) => {
      const c = Math.max(0, Math.min(1, safeNum(x, 0)));
      return c * c * (3 - 2 * c);
    };

    let beat = 0;
    let u = 0;
    if (p < 0.28) {
      beat = 0;
      u = Math.max(0, Math.min(1, p / 0.28));
    } else if (p < 0.58) {
      beat = 1;
      u = Math.max(0, Math.min(1, (p - 0.28) / 0.30));
    } else if (p < 0.82) {
      beat = 2;
      u = Math.max(0, Math.min(1, (p - 0.58) / 0.24));
    } else {
      beat = 3;
      u = Math.max(0, Math.min(1, (p - 0.82) / 0.18));
    }

    let desiredPos;
    let desiredLook;
    let desiredFov;
    let desiredRoll;

    if (beat === 0) {
      // Beat 0: Attacker Broadside / Wingman Tracking Shot
      desiredPos = attackerPos.clone()
        .addScaledVector(perpRight, (1.85 * aR + 40) * sideSign)
        .addScaledVector(engageDir, (-0.9 + 1.5 * u) * aR)
        .addScaledVector(perpUp, (-0.22 + 0.40 * u) * aR);

      if (attackerPos.distanceToSquared(victimPos) < 1e-4) {
        desiredLook = attackerPos.clone().addScaledVector(engageDir, 120);
      } else {
        desiredLook = attackerPos.clone().lerp(victimPos, 0.18 + 0.22 * u);
      }

      desiredFov = 52 - 10 * smoothstep(u);
      desiredRoll = -0.14 * sideSign + 0.04 * Math.sin(u * Math.PI);
    } else if (beat === 1) {
      // Beat 1: Ordnance Flyby / Crossfire Chase & Whip-Pan
      const projs = Array.isArray(snapshot?.projectiles) ? snapshot.projectiles : [];
      let chosenProj = null;

      if (state.trackedProjId !== null && state.trackedProjId !== undefined) {
        chosenProj = projs.find((pr) => pr && pr.id === state.trackedProjId) || null;
      }

      if (!chosenProj && projs.length > 0) {
        const typeRank = {
          torpedo: 4,
          swarm_missiles: 4,
          missile: 4,
          railgun: 3,
          slug: 3,
          laser: 2,
          beam: 2,
          flak: 1,
          flak_burst: 1,
        };

        let bestScore = -1;
        for (const pr of projs) {
          if (!pr) continue;
          const rank = typeRank[pr.type] || 0;
          const isAttackerShooter = (pr.shooterId === attackerTeam || pr.team === attackerTeam || pr.shooter === attackerTeam);
          const score = rank * 10 + (isAttackerShooter ? 5 : 0);
          if (score > bestScore) {
            bestScore = score;
            chosenProj = pr;
          }
        }
      }

      if (chosenProj && chosenProj.id !== undefined && chosenProj.id !== null) {
        state.trackedProjId = chosenProj.id;
      }

      if (chosenProj) {
        const projPos = simToThree(chosenProj.pos);
        const projVel = simToThree(chosenProj.vel);
        const projDir = projVel.lengthSq() > 1e-4 ? projVel.normalize() : engageDir.clone();
        let projSide = new THREE.Vector3().crossVectors(projDir, worldUp);
        if (projSide.lengthSq() < 1e-4) {
          projSide.copy(perpRight);
        }
        projSide.normalize();

        if (u < 0.65) {
          const w = u / 0.65;
          desiredPos = projPos.clone()
            .addScaledVector(projDir, -(75 - 45 * w))
            .addScaledVector(projSide, 32 * sideSign)
            .addScaledVector(perpUp, -10 + 18 * w);
          desiredLook = projPos.clone().lerp(victimPos, 0.35 + 0.55 * w);
        } else {
          desiredPos = victimPos.clone()
            .addScaledVector(engageDir, -2.2 * vR)
            .addScaledVector(perpRight, 1.1 * vR * sideSign)
            .addScaledVector(perpUp, 0.15 * vR);
          desiredLook = victimPos.clone();
        }
      } else {
        desiredPos = victimPos.clone()
          .addScaledVector(engageDir, (-2.6 + 4.4 * u) * vR)
          .addScaledVector(perpRight, (1.65 * vR + 25) * sideSign)
          .addScaledVector(perpUp, (-0.18 + 0.35 * u) * vR);
        desiredLook = victimPos.clone();
      }

      desiredFov = 56 - 8 * smoothstep(u);
      desiredRoll = 0.21 * sideSign * Math.sin(u * Math.PI * 0.85 + 0.2);
    } else if (beat === 2) {
      // Beat 2: Telephoto Crash-Zoom ("Snap-Zoom") on Impact
      desiredPos = victimPos.clone()
        .addScaledVector(engageDir, -3.1 * vR)
        .addScaledVector(perpRight, -2.4 * vR * sideSign)
        .addScaledVector(perpUp, (-0.32 + 0.20 * u) * vR);

      desiredLook = victimPos.clone().addScaledVector(perpRight, Math.sin(state.shakeTime * 7.5) * 3.5);

      const crash = 1 - Math.exp(-9.0 * u);
      const overshoot = Math.sin(u * Math.PI * 2.2) * Math.exp(-5.5 * u) * 3.2;
      desiredFov = Math.max(18, Math.min(60, 56 - 34 * crash - overshoot));
      desiredRoll = -0.17 * sideSign;
    } else {
      // Beat 3: Hero Low-Angle Destruction Orbit & Shockwave Recoil
      const rOrbit = (2.1 + 0.9 * u) * vR + 30;
      const theta = (-0.7 + 1.45 * u) * sideSign;
      const radial = engageDir.clone().multiplyScalar(-Math.cos(theta)).addScaledVector(perpRight, Math.sin(theta));

      desiredPos = victimPos.clone()
        .addScaledVector(radial, rOrbit)
        .addScaledVector(perpUp, (-0.42 + 0.18 * u) * vR);

      desiredLook = victimPos.clone().addScaledVector(perpUp, 0.12 * vR);
      desiredFov = 34 + 16 * smoothstep(u);
      desiredRoll = 0.16 * sideSign * (1 - 0.4 * u);
    }

    // Hard cut vs smooth damping
    if (!state.initialized || beat !== state.lastBeat) {
      state.pos.copy(desiredPos);
      state.lookAt.copy(desiredLook);
      state.fov = desiredFov;
      state.dutchRoll = desiredRoll;
      state.lastBeat = beat;
      state.initialized = true;
      state.shakeIntensity = Math.min(1.5, state.shakeIntensity + 0.12);
    } else {
      const k = (beat === 1 && u >= 0.65) ? 16 : 10;
      const damp = 1 - Math.exp(-k * stepDt);
      state.pos.lerp(desiredPos, damp);
      state.lookAt.lerp(desiredLook, damp);
      state.fov += (desiredFov - state.fov) * damp;
      state.dutchRoll += (desiredRoll - state.dutchRoll) * damp;
    }

    // Finite / NaN guards
    if (!Number.isFinite(state.pos.x) || !Number.isFinite(state.pos.y) || !Number.isFinite(state.pos.z)) {
      state.pos.set(0, -300, 80);
    }
    if (!Number.isFinite(state.lookAt.x) || !Number.isFinite(state.lookAt.y) || !Number.isFinite(state.lookAt.z)) {
      state.lookAt.set(0, 0, 0);
    }
    if (!Number.isFinite(state.fov)) state.fov = 50;
    if (!Number.isFinite(state.dutchRoll)) state.dutchRoll = 0;

    // Event Trauma / Shake Impulse
    const traumaMap = {
      killing_blow: 0.95,
      ship_destroyed: 0.95,
      torpedo_hit: 0.60,
      railgun_hit: 0.55,
      shield_collapse: 0.45,
      collision: 0.40,
      tether_mine_detonated: 0.40,
      mine_detonation: 0.40,
      flak_burst: 0.25,
      asteroid_destroyed: 0.25,
      laser_hit: 0.15,
      torpedo_launched: 0.12,
      railgun_fired: 0.12,
    };

    if (Array.isArray(snapshot?.events)) {
      for (const ev of snapshot.events) {
        const type = typeof ev === 'string' ? ev : ev?.type;
        if (type && traumaMap[type] !== undefined) {
          state.shakeIntensity = Math.min(1.5, state.shakeIntensity + traumaMap[type]);
        }
      }
    }

    // Handheld Weave, Shake Offset & Dutch Roll
    let baseFwd = state.lookAt.clone().sub(state.pos);
    if (baseFwd.lengthSq() < 1e-4) baseFwd = engageDir.clone();
    baseFwd.normalize();

    let baseRight = new THREE.Vector3().crossVectors(baseFwd, worldUp);
    if (baseRight.lengthSq() < 1e-4) baseRight = perpRight.clone();
    baseRight.normalize();

    const baseUp = new THREE.Vector3().crossVectors(baseRight, baseFwd).normalize();

    const t = state.shakeTime;
    const weaveRight = Math.sin(t * 1.1) * 0.7 + Math.sin(t * 2.3) * 0.35 + Math.sin(t * 4.7) * 0.15;
    const weaveUp = Math.cos(t * 0.9) * 0.65 + Math.cos(t * 2.1) * 0.35 + Math.cos(t * 5.3) * 0.20;

    const shake = state.shakeIntensity;
    const shakeSq = shake * shake;
    const joltRight = shakeSq * 18 * (Math.sin(t * 23.7) * 0.7 + Math.sin(t * 41.3) * 0.3);
    const joltUp = shakeSq * 18 * (Math.cos(t * 29.1) * 0.7 + Math.cos(t * 37.7) * 0.3);

    const dist = state.pos.distanceTo(state.lookAt);
    const lookJoltRight = shakeSq * 0.045 * dist * Math.sin(t * 17.3);
    const lookJoltUp = shakeSq * 0.045 * dist * Math.cos(t * 21.1);

    const rollShiver = shake * Math.sin(t * 19.3) * 0.06;
    const effRoll = state.dutchRoll + rollShiver;

    const finalPos = state.pos.clone()
      .addScaledVector(baseRight, weaveRight + joltRight)
      .addScaledVector(baseUp, weaveUp + joltUp);

    const finalLook = state.lookAt.clone()
      .addScaledVector(baseRight, lookJoltRight)
      .addScaledVector(baseUp, lookJoltUp);

    // Safe Standoff
    for (const [_, ship] of Object.entries(ships)) {
      if (!ship || !ship.pos) continue;
      const shipPos = simToThree(ship.pos);
      const minR = (BSG_HULL_RADII[ship.hullClass] || 60) + 25;
      const d = finalPos.distanceTo(shipPos);
      if (d < minR) {
        let pushDir = finalPos.clone().sub(shipPos);
        if (pushDir.lengthSq() < 1e-4) {
          pushDir = perpRight.clone();
        } else {
          pushDir.normalize();
        }
        finalPos.copy(shipPos).addScaledVector(pushDir, minR);
      }
    }

    const asteroids = snapshot?.sector?.asteroids || [];
    for (const ast of asteroids) {
      if (!ast || ast.destroyed || !ast.pos) continue;
      const astPos = simToThree(ast.pos);
      const minAstR = safeNum(ast.radius, 40) * 1.25 + 20;
      const d = finalPos.distanceTo(astPos);
      if (d < minAstR) {
        let pushDir = finalPos.clone().sub(astPos);
        if (pushDir.lengthSq() < 1e-4) {
          pushDir = perpRight.clone();
        } else {
          pushDir.normalize();
        }
        finalPos.copy(astPos).addScaledVector(pushDir, minAstR);
      }
    }

    // Apply to camera3d
    let camFwd = finalLook.clone().sub(finalPos);
    if (camFwd.lengthSq() < 1e-4) camFwd = engageDir.clone();
    camFwd.normalize();

    let camRight = new THREE.Vector3().crossVectors(camFwd, worldUp);
    if (camRight.lengthSq() < 1e-4) camRight = perpRight.clone();
    camRight.normalize();

    const camUp = new THREE.Vector3().crossVectors(camRight, camFwd).normalize();
    const rolledUp = camUp.clone().multiplyScalar(Math.cos(effRoll)).addScaledVector(camRight, Math.sin(effRoll)).normalize();

    const finalFov = Math.max(15, Math.min(75, safeNum(state.fov, 50)));

    this.camera3d.fov = finalFov;
    this.camera3d.near = 2;
    this.camera3d.aspect = this.width / Math.max(1, this.height);
    this.camera3d.updateProjectionMatrix();

    this.camera3d.position.copy(finalPos);
    this.camera3d.up.copy(rolledUp);
    this.camera3d.lookAt(finalLook);
    this.camera3d.updateMatrixWorld();
  }

  /**
   * Builds high-detail class-specific 3D starship mesh group.
   *
   * @param {string} hullClass - 'corvette' | 'frigate' | 'dreadnought'
   * @param {string} team - 'alpha' | 'omega'
   * @returns {THREE.Group}
   */
  createShipMesh3D(hullClass = 'frigate', team = 'alpha') {
    const isAlpha = team === 'alpha';
    const teamColorHex = isAlpha ? 0x38bdf8 : 0xf43f5e;
    const darkAlloyHex = 0x1e293b;
    const lightAlloyHex = 0x334155;
    const metalGreebleHex = 0x0f172a;

    const shipGroup = new THREE.Group();
    shipGroup.name = `ship_${hullClass}_${team}`;
    shipGroup.rotation.order = 'ZYX';

    const hullRollGroup = new THREE.Group();
    hullRollGroup.name = 'hullRollGroup';
    hullRollGroup.rotation.order = 'ZYX';
    shipGroup.add(hullRollGroup);
    shipGroup.hullRollGroup = hullRollGroup;

    const shieldGroup = new THREE.Group();
    shieldGroup.name = 'shieldGroup';
    // Shields are hull-fixed: they ride the hull roll group so a rolled ship keeps each
    // quadrant on the same physical side the server uses for hit mapping.
    hullRollGroup.add(shieldGroup);
    shipGroup.shieldGroup = shieldGroup;

    // Procedural photorealistic PBR bitmaps (100% pure Uint8Array math, zero DOM calls)
    const shipHullSkin = getShipHullSkinBitmaps();
    const armorSkin = getArmorPlateSkinBitmaps();
    const liverySkin = getTeamLiverySkinBitmaps(team);
    const greebleSkin = getGreebleSkinBitmaps();
    const canopySkin = getCanopyGlassSkinBitmaps(team);
    const nozzleSkin = getNozzleSkinBitmaps();
    const radiatorSkin = getRadiatorSkinBitmaps();
    const plumeTex = getPlumePlasmaSkinBitmap();
    const shieldHexTex = getShieldHexSkinBitmap();

    // Materials
    const mainHullMat = new THREE.MeshStandardMaterial({
      color: 0xd8e2ee,
      map: shipHullSkin.map,
      bumpMap: shipHullSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: shipHullSkin.roughnessMap,
      roughness: 0.65,
      metalness: 0.65,
    });

    const armorPlateMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      map: armorSkin.map,
      bumpMap: armorSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: armorSkin.roughnessMap,
      roughness: 0.55,
      metalness: 0.8,
    });

    const teamAccentMat = new THREE.MeshStandardMaterial({
      color: teamColorHex,
      map: liverySkin.map,
      bumpMap: liverySkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: liverySkin.roughnessMap,
      roughness: 0.35,
      metalness: 0.7,
      emissive: teamColorHex,
      emissiveMap: liverySkin.map,
      emissiveIntensity: 0.3,
    });

    const darkGreebleMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      map: greebleSkin.map,
      bumpMap: greebleSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: greebleSkin.roughnessMap,
      roughness: 0.85,
      metalness: 0.5,
    });

    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: canopySkin.map,
      bumpMap: canopySkin.bumpMap,
      bumpScale: 0.45,
      emissive: teamColorHex,
      emissiveMap: canopySkin.emissiveMap,
      emissiveIntensity: 0.8,
      roughness: 0.15,
      metalness: 0.9,
    });

    const darkNozzleMat = new THREE.MeshStandardMaterial({
      color: 0xd1d5db,
      map: nozzleSkin.map,
      bumpMap: nozzleSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: nozzleSkin.roughnessMap,
      roughness: 0.75,
      metalness: 0.85,
    });

    // 3D Glowing Radiator Material (Color & intensity ramp with heat)
    const radiatorMaterial = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      map: radiatorSkin.map,
      bumpMap: radiatorSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: radiatorSkin.roughnessMap,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.45,
      metalness: 0.85,
    });
    shipGroup.radiatorMaterial = radiatorMaterial;
    hullRollGroup.radiatorMaterial = radiatorMaterial;

    // Running navigation lights & animated dorsal/ventral strobe beacon
    const navStrobeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
    });
    shipGroup.userData.navStrobeMat = navStrobeMat;
    hullRollGroup.userData.navStrobeMat = navStrobeMat;

    let L = 60, W = 28, H = 14;
    if (hullClass === 'corvette') {
      L = 40; W = 20; H = 10;
    } else if (hullClass === 'dreadnought') {
      L = 90; W = 40; H = 22;
    }

    // Port navigation light (Red, +Y in local coords)
    const portNavLight = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
    portNavLight.name = 'navLight_port';
    portNavLight.position.set(-L * 0.05, W * 0.48, H * 0.08);
    hullRollGroup.add(portNavLight);

    // Starboard navigation light (Green, -Y in local coords)
    const stbdNavLight = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
    stbdNavLight.name = 'navLight_starboard';
    stbdNavLight.position.set(-L * 0.05, -W * 0.48, H * 0.08);
    hullRollGroup.add(stbdNavLight);

    // Pulsing white dorsal & ventral beacon
    const dorsalStrobe = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), navStrobeMat);
    dorsalStrobe.name = 'strobe_dorsal';
    dorsalStrobe.position.set(-L * 0.12, 0, H * 0.46);
    hullRollGroup.add(dorsalStrobe);

    const ventralStrobe = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), navStrobeMat);
    ventralStrobe.name = 'strobe_ventral';
    ventralStrobe.position.set(-L * 0.12, 0, -H * 0.36);
    hullRollGroup.add(ventralStrobe);

    // 3D Engine Gimbal Articulation Group positioned at stern engine mount
    const gimbalMountX = -L * 0.44;
    const gimbalPivotGroup = new THREE.Group();
    gimbalPivotGroup.name = 'gimbalPivotGroup';
    gimbalPivotGroup.rotation.order = 'ZYX';
    gimbalPivotGroup.position.set(gimbalMountX, 0, 0);
    hullRollGroup.add(gimbalPivotGroup);
    shipGroup.gimbalPivotGroup = gimbalPivotGroup;
    shipGroup.userData.gimbalPivotGroup = gimbalPivotGroup;
    hullRollGroup.userData.gimbalPivotGroup = gimbalPivotGroup;

    // Articulated mechanical detail around gimbal mount:
    // Armored gimbal shroud ring / collar on stern
    const gimbalSternShroud = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.28, W * 0.30, L * 0.04, 16), armorPlateMat);
    gimbalSternShroud.rotateZ(Math.PI / 2);
    gimbalSternShroud.position.set(gimbalMountX + L * 0.02, 0, 0);
    hullRollGroup.add(gimbalSternShroud);

    // Gimbal collar ring on gimbal housing
    const gimbalCollar = new THREE.Mesh(new THREE.TorusGeometry(W * 0.26, 1.2, 8, 16), darkGreebleMat);
    gimbalCollar.rotateY(Math.PI / 2);
    gimbalCollar.position.set(0, 0, 0);
    gimbalPivotGroup.add(gimbalCollar);

    // 4 hydraulic actuator struts connecting hull stern to the gimbal housing
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0xd8e2ee,
      map: greebleSkin.map,
      bumpMap: greebleSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: greebleSkin.roughnessMap,
      roughness: 0.5,
      metalness: 0.85,
    });
    const strutOffsets = [
      [W * 0.22, H * 0.18],
      [-W * 0.22, H * 0.18],
      [W * 0.22, -H * 0.18],
      [-W * 0.22, -H * 0.18],
    ];
    for (const [sy, sz] of strutOffsets) {
      const strutBase = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, L * 0.06, 8), darkGreebleMat);
      strutBase.rotateZ(Math.PI / 2);
      strutBase.position.set(gimbalMountX + L * 0.03, sy, sz);
      hullRollGroup.add(strutBase);

      const strutPiston = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, L * 0.06, 8), strutMat);
      strutPiston.rotateZ(Math.PI / 2);
      strutPiston.position.set(gimbalMountX - L * 0.005, sy * 0.85, sz * 0.85);
      hullRollGroup.add(strutPiston);
    }

    // --- CLASS-SPECIFIC 3D ARCHITECTURES ---
    if (hullClass === 'corvette') {
      // 1. Sleek 3D Delta Interceptor
      // Beveled arrowhead main hull
      const shape = new THREE.Shape();
      shape.moveTo(L * 0.5, 0);
      shape.lineTo(-L * 0.15, W * 0.5);
      shape.lineTo(-L * 0.5, W * 0.35);
      shape.lineTo(-L * 0.38, 0);
      shape.lineTo(-L * 0.5, -W * 0.35);
      shape.lineTo(-L * 0.15, -W * 0.5);
      shape.closePath();

      const extrudeSettings = { depth: H * 0.4, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 1.5, bevelThickness: 1.5 };
      const hullGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      hullGeo.center();
      normalizeGeometryUVs(hullGeo, 0.028);
      const mainHullMesh = new THREE.Mesh(hullGeo, mainHullMat);
      hullRollGroup.add(mainHullMesh);

      // Chiseled nose cone
      const noseGeo = new THREE.ConeGeometry(H * 0.25, L * 0.25, 4);
      noseGeo.rotateZ(-Math.PI / 2);
      const noseMesh = new THREE.Mesh(noseGeo, armorPlateMat);
      noseMesh.position.set(L * 0.5, 0, 0);
      hullRollGroup.add(noseMesh);

      // Swept forward canard wings
      const canardGeo = new THREE.BoxGeometry(L * 0.18, W * 0.25, H * 0.1);
      const canardPort = new THREE.Mesh(canardGeo, teamAccentMat);
      canardPort.position.set(L * 0.15, -W * 0.38, 0);
      canardPort.rotation.z = -0.3;
      const canardStarboard = new THREE.Mesh(canardGeo, teamAccentMat);
      canardStarboard.position.set(L * 0.15, W * 0.38, 0);
      canardStarboard.rotation.z = 0.3;
      hullRollGroup.add(canardPort);
      hullRollGroup.add(canardStarboard);

      // Swept lateral intake scoops behind the canards
      const scoopGeo = new THREE.BoxGeometry(L * 0.14, W * 0.08, H * 0.18);
      const scoopPort = new THREE.Mesh(scoopGeo, darkGreebleMat);
      scoopPort.position.set(L * 0.02, -W * 0.34, 0);
      scoopPort.rotation.z = -0.2;
      const scoopStbd = new THREE.Mesh(scoopGeo, darkGreebleMat);
      scoopStbd.position.set(L * 0.02, W * 0.34, 0);
      scoopStbd.rotation.z = 0.2;
      hullRollGroup.add(scoopPort);
      hullRollGroup.add(scoopStbd);

      // Layered stepped dorsal spine plates
      const spinePlate1 = new THREE.Mesh(new THREE.BoxGeometry(L * 0.32, W * 0.12, H * 0.1), armorPlateMat);
      spinePlate1.position.set(-L * 0.08, 0, H * 0.28);
      const spinePlate2 = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, W * 0.08, H * 0.08), armorPlateMat);
      spinePlate2.position.set(-L * 0.08, 0, H * 0.34);
      hullRollGroup.add(spinePlate1);
      hullRollGroup.add(spinePlate2);

      // Panel trim strips
      const trimPort = new THREE.Mesh(new THREE.BoxGeometry(L * 0.36, 0.6, 0.6), teamAccentMat);
      trimPort.position.set(-L * 0.05, -W * 0.28, H * 0.12);
      const trimStbd = new THREE.Mesh(new THREE.BoxGeometry(L * 0.36, 0.6, 0.6), teamAccentMat);
      trimStbd.position.set(-L * 0.05, W * 0.28, H * 0.12);
      hullRollGroup.add(trimPort);
      hullRollGroup.add(trimStbd);

      // Twin canted dorsal stabilizer fins
      const finGeo = new THREE.BoxGeometry(L * 0.22, 1.2, H * 0.5);
      const finPort = new THREE.Mesh(finGeo, armorPlateMat);
      finPort.position.set(-L * 0.25, -W * 0.2, H * 0.35);
      finPort.rotation.x = -0.28;
      const finStbd = new THREE.Mesh(finGeo, armorPlateMat);
      finStbd.position.set(-L * 0.25, W * 0.2, H * 0.35);
      finStbd.rotation.x = 0.28;
      hullRollGroup.add(finPort);
      hullRollGroup.add(finStbd);

      // Recessed dark mechanical greeble bay along spine
      const greebleBay = new THREE.Mesh(new THREE.BoxGeometry(L * 0.45, W * 0.16, H * 0.2), darkGreebleMat);
      greebleBay.position.set(-L * 0.05, 0, H * 0.2);
      hullRollGroup.add(greebleBay);

      // Articulated mini comms/sensor dish atop rear spine
      const dishGroup = new THREE.Group();
      dishGroup.name = 'commsDish';
      const dishBase = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 1.5, 8), darkGreebleMat);
      const dishBowl = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.0, 12, 1, true), teamAccentMat);
      dishBowl.rotateX(-Math.PI / 4);
      dishBowl.position.set(0, 0, 1.2);
      dishGroup.add(dishBase);
      dishGroup.add(dishBowl);
      dishGroup.position.set(-L * 0.18, 0, H * 0.4);
      hullRollGroup.add(dishGroup);
      shipGroup.userData.commsDish = dishGroup;

      // Ventral antenna array (3 slender rods)
      for (let a = 0; a < 3; a++) {
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 4.0, 6), darkGreebleMat);
        ant.position.set(L * 0.05 + a * 3.5, 0, -H * 0.32);
        hullRollGroup.add(ant);
      }

      // Glowing canopy dome
      const canopyGeo = new THREE.SphereGeometry(3.5, 16, 8);
      const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
      canopyMesh.scale.set(1.8, 1.0, 0.6);
      canopyMesh.position.set(L * 0.18, 0, H * 0.26);
      hullRollGroup.add(canopyMesh);

      // Viewport cowl frame & brow fins
      const cowlBrow = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, W * 0.18, H * 0.08), armorPlateMat);
      cowlBrow.position.set(L * 0.15, 0, H * 0.36);
      cowlBrow.rotation.y = -0.15;
      hullRollGroup.add(cowlBrow);

      const cowlFinP = new THREE.Mesh(new THREE.BoxGeometry(L * 0.14, 0.6, H * 0.12), armorPlateMat);
      cowlFinP.position.set(L * 0.18, -W * 0.12, H * 0.3);
      cowlFinP.rotation.x = -0.3;
      const cowlFinS = new THREE.Mesh(new THREE.BoxGeometry(L * 0.14, 0.6, H * 0.12), armorPlateMat);
      cowlFinS.position.set(L * 0.18, W * 0.12, H * 0.3);
      cowlFinS.rotation.x = 0.3;
      hullRollGroup.add(cowlFinP);
      hullRollGroup.add(cowlFinS);

      // Dorsal sensor antenna mast & crossbar
      const sensorMast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, H * 0.45, 6), darkGreebleMat);
      sensorMast.position.set(L * 0.08, 0, H * 0.42);
      hullRollGroup.add(sensorMast);

      const mastCrossbar = new THREE.Mesh(new THREE.BoxGeometry(0.4, W * 0.12, 0.4), teamAccentMat);
      mastCrossbar.position.set(L * 0.08, 0, H * 0.6);
      hullRollGroup.add(mastCrossbar);

      // Corvette dorsal heat-sink spine ribs
      for (let r = 0; r < 4; r++) {
        const spineRib = new THREE.Mesh(new THREE.BoxGeometry(0.8, W * 0.16, H * 0.14), radiatorMaterial);
        spineRib.position.set(-L * 0.02 - r * (L * 0.05), 0, H * 0.32);
        hullRollGroup.add(spineRib);
      }

      // Wingtip running lights (Port red at +Y, Starboard green at -Y)
      const tipPort = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
      tipPort.position.set(-L * 0.15, W * 0.5, 0);
      const tipStbd = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
      tipStbd.position.set(-L * 0.15, -W * 0.5, 0);
      hullRollGroup.add(tipPort);
      hullRollGroup.add(tipStbd);

      // Ventral sensor pod
      const sensorPod = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.0, 3, 8), teamAccentMat);
      sensorPod.position.set(L * 0.2, 0, -H * 0.28);
      hullRollGroup.add(sensorPod);

      // Twin 3D fusion bell nozzles parented to gimbalPivotGroup
      const bellGeo = new THREE.CylinderGeometry(2.0, 3.2, 5, 12);
      bellGeo.rotateZ(Math.PI / 2);
      const nozzle1 = new THREE.Mesh(bellGeo, darkNozzleMat);
      nozzle1.position.set(-L * 0.48 - gimbalMountX, -W * 0.18, 0);
      const nozzle2 = new THREE.Mesh(bellGeo, darkNozzleMat);
      nozzle2.position.set(-L * 0.48 - gimbalMountX, W * 0.18, 0);
      gimbalPivotGroup.add(nozzle1);
      gimbalPivotGroup.add(nozzle2);

      // Recessed cowling rings around twin bells
      const cowlGeo = new THREE.TorusGeometry(3.5, 0.6, 8, 16);
      cowlGeo.rotateY(Math.PI / 2);
      const cowl1 = new THREE.Mesh(cowlGeo, armorPlateMat);
      cowl1.position.set(-L * 0.45 - gimbalMountX, -W * 0.18, 0);
      const cowl2 = new THREE.Mesh(cowlGeo, armorPlateMat);
      cowl2.position.set(-L * 0.45 - gimbalMountX, W * 0.18, 0);
      gimbalPivotGroup.add(cowl1);
      gimbalPivotGroup.add(cowl2);

      // Inner glowing plasma fusion collars
      const plasmaMat = new THREE.MeshBasicMaterial({ color: teamColorHex, map: plumeTex });
      const glow1 = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.4, 12), plasmaMat);
      glow1.rotateY(Math.PI / 2);
      glow1.position.set(-L * 0.47 - gimbalMountX, -W * 0.18, 0);
      const glow2 = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.4, 12), plasmaMat);
      glow2.rotateY(Math.PI / 2);
      glow2.position.set(-L * 0.47 - gimbalMountX, W * 0.18, 0);
      gimbalPivotGroup.add(glow1);
      gimbalPivotGroup.add(glow2);

    } else if (hullClass === 'dreadnought') {
      // 2. Colossal Multi-Tier 3D Capital Battleship
      const mainHull = new THREE.Mesh(new THREE.BoxGeometry(L * 0.75, W * 0.7, H * 0.5), mainHullMat);
      mainHull.position.set(-L * 0.05, 0, 0);
      hullRollGroup.add(mainHull);

      // Heavy beveled ramming prow
      const prowShape = new THREE.Shape();
      prowShape.moveTo(L * 0.5, 0);
      prowShape.lineTo(L * 0.28, W * 0.32);
      prowShape.lineTo(L * 0.28, -W * 0.32);
      prowShape.closePath();
      const prowGeo = new THREE.ExtrudeGeometry(prowShape, { depth: H * 0.6, bevelEnabled: true, bevelSize: 2, bevelThickness: 2 });
      prowGeo.center();
      normalizeGeometryUVs(prowGeo, 0.025);
      const prowMesh = new THREE.Mesh(prowGeo, armorPlateMat);
      prowMesh.position.set(L * 0.35, 0, 0);
      hullRollGroup.add(prowMesh);

      // Recessed mechanical trenches with pipe greebles & structural cross-girders
      const trenchMesh = new THREE.Mesh(new THREE.BoxGeometry(L * 0.7, W * 0.18, H * 0.2), darkGreebleMat);
      trenchMesh.position.set(-L * 0.05, 0, H * 0.22);
      hullRollGroup.add(trenchMesh);

      for (let p = 0; p < 4; p++) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, L * 0.15, 8), armorPlateMat);
        pipe.rotateZ(Math.PI / 2);
        pipe.position.set(-L * 0.25 + p * (L * 0.15), 0, H * 0.28);
        hullRollGroup.add(pipe);

        // Spinal trench structural cross-girders
        const girder = new THREE.Mesh(new THREE.BoxGeometry(1.4, W * 0.18, H * 0.08), armorPlateMat);
        girder.position.set(-L * 0.28 + p * (L * 0.14), 0, H * 0.26);
        hullRollGroup.add(girder);
      }

      // Reactor exhaust stacks
      for (const sy of [-W * 0.08, W * 0.08]) {
        const stack = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, H * 0.25, 8), darkGreebleMat);
        stack.position.set(-L * 0.28, sy, H * 0.36);
        hullRollGroup.add(stack);
      }

      // Port & Starboard casemate battery blocks
      const casematePort = new THREE.Mesh(new THREE.BoxGeometry(L * 0.45, W * 0.18, H * 0.4), armorPlateMat);
      casematePort.position.set(-L * 0.05, -W * 0.42, 0);
      const casemateStbd = new THREE.Mesh(new THREE.BoxGeometry(L * 0.45, W * 0.18, H * 0.4), armorPlateMat);
      casemateStbd.position.set(-L * 0.05, W * 0.42, 0);
      hullRollGroup.add(casematePort);
      hullRollGroup.add(casemateStbd);

      // 4 secondary casemate blister sub-turrets on port/starboard casemates
      const subTurretPositions = [
        [-L * 0.18, -W * 0.42, H * 0.22],
        [L * 0.08, -W * 0.42, H * 0.22],
        [-L * 0.18, W * 0.42, H * 0.22],
        [L * 0.08, W * 0.42, H * 0.22],
      ];
      for (const [stx, sty, stz] of subTurretPositions) {
        const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 8, 8), armorPlateMat);
        dome.position.set(stx, sty, stz);
        const subBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 3.5, 6), darkNozzleMat);
        subBarrel.rotateZ(sty > 0 ? Math.PI / 2 : -Math.PI / 2);
        subBarrel.position.set(0, sty > 0 ? 2.0 : -2.0, 0);
        dome.add(subBarrel);
        hullRollGroup.add(dome);
      }

      // Towering multi-deck command citadel with layered heavy armor plates
      const citadelBase = new THREE.Mesh(new THREE.BoxGeometry(L * 0.28, W * 0.28, H * 0.35), mainHullMat);
      citadelBase.position.set(-L * 0.1, 0, H * 0.38);
      const citadelTier2 = new THREE.Mesh(new THREE.BoxGeometry(L * 0.18, W * 0.18, H * 0.3), teamAccentMat);
      citadelTier2.position.set(-L * 0.1, 0, H * 0.65);
      const citadelBridge = new THREE.Mesh(new THREE.BoxGeometry(L * 0.1, W * 0.22, H * 0.15), canopyMat);
      citadelBridge.position.set(-L * 0.06, 0, H * 0.82);
      hullRollGroup.add(citadelBase);
      hullRollGroup.add(citadelTier2);
      hullRollGroup.add(citadelBridge);

      // Citadel armor plates
      const citPlateP = new THREE.Mesh(new THREE.BoxGeometry(L * 0.26, 1.8, H * 0.28), armorPlateMat);
      citPlateP.position.set(-L * 0.1, -W * 0.15, H * 0.42);
      const citPlateS = new THREE.Mesh(new THREE.BoxGeometry(L * 0.26, 1.8, H * 0.28), armorPlateMat);
      citPlateS.position.set(-L * 0.1, W * 0.15, H * 0.42);
      hullRollGroup.add(citPlateP);
      hullRollGroup.add(citPlateS);

      // Heavy armored bridge visor cowl / eyebrow frame & side fins
      const bridgeVisor = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, W * 0.26, H * 0.06), armorPlateMat);
      bridgeVisor.position.set(-L * 0.04, 0, H * 0.90);
      bridgeVisor.rotation.y = -0.12;
      hullRollGroup.add(bridgeVisor);

      const bridgeCowlP = new THREE.Mesh(new THREE.BoxGeometry(L * 0.14, 1.2, H * 0.18), armorPlateMat);
      bridgeCowlP.position.set(-L * 0.06, -W * 0.14, H * 0.84);
      const bridgeCowlS = new THREE.Mesh(new THREE.BoxGeometry(L * 0.14, 1.2, H * 0.18), armorPlateMat);
      bridgeCowlS.position.set(-L * 0.06, W * 0.14, H * 0.84);
      hullRollGroup.add(bridgeCowlP);
      hullRollGroup.add(bridgeCowlS);

      // Twin armored sensor antennae masts atop citadel bridge wings
      const antP = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, H * 0.4, 6), darkGreebleMat);
      antP.position.set(-L * 0.08, -W * 0.12, H * 1.05);
      const antS = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, H * 0.4, 6), darkGreebleMat);
      antS.position.set(-L * 0.08, W * 0.12, H * 1.05);
      hullRollGroup.add(antP);
      hullRollGroup.add(antS);

      // Dreadnought heavy dorsal heat-sink spine ribs forward of citadel
      for (let r = 0; r < 5; r++) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(1.4, W * 0.28, H * 0.18), radiatorMaterial);
        rib.position.set(L * 0.08 + r * (L * 0.05), 0, H * 0.28);
        hullRollGroup.add(rib);
      }

      // Outermost casemate running lights (Port red at +Y, Starboard green at -Y)
      const dreadTipP = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
      dreadTipP.position.set(0, W * 0.52, 0);
      const dreadTipS = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
      dreadTipS.position.set(0, -W * 0.52, 0);
      hullRollGroup.add(dreadTipP);
      hullRollGroup.add(dreadTipS);

      // Twin citadel sensor domes + radar mast antennae
      const domeP = new THREE.Mesh(new THREE.SphereGeometry(2.0, 8, 8), canopyMat);
      domeP.position.set(-L * 0.14, -W * 0.08, H * 0.8);
      const domeS = new THREE.Mesh(new THREE.SphereGeometry(2.0, 8, 8), canopyMat);
      domeS.position.set(-L * 0.14, W * 0.08, H * 0.8);
      hullRollGroup.add(domeP);
      hullRollGroup.add(domeS);

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, H * 0.35, 6), darkGreebleMat);
      mast.position.set(-L * 0.16, 0, H * 0.95);
      hullRollGroup.add(mast);

      // Central glowing reactor core chamber
      const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(H * 0.22, 16, 16), new THREE.MeshStandardMaterial({
        color: 0xfef3c7,
        map: plumeTex,
        bumpMap: greebleSkin.bumpMap,
        bumpScale: 0.45,
        emissive: 0xea580c,
        emissiveMap: plumeTex,
        emissiveIntensity: 1.5,
        roughness: 0.25,
        metalness: 0.7,
      }));
      coreMesh.position.set(0, 0, 0);
      hullRollGroup.add(coreMesh);

      // Ventral armored hangar / reactor pod
      const hangarPod = new THREE.Mesh(new THREE.BoxGeometry(L * 0.45, W * 0.35, H * 0.28), armorPlateMat);
      hangarPod.position.set(-L * 0.05, 0, -H * 0.32);
      const bayDoor = new THREE.Mesh(new THREE.BoxGeometry(L * 0.15, W * 0.18, 0.8), darkGreebleMat);
      bayDoor.position.set(0, 0, -H * 0.47);
      hangarPod.add(bayDoor);
      hullRollGroup.add(hangarPod);

      // 4-Nozzle Capital Fusion Drive Cluster parented to gimbalPivotGroup
      const bellGeo = new THREE.CylinderGeometry(3.0, 4.5, 8, 12);
      bellGeo.rotateZ(Math.PI / 2);
      const offsets = [
        [-W * 0.22, -H * 0.15],
        [-W * 0.22, H * 0.15],
        [W * 0.22, -H * 0.15],
        [W * 0.22, H * 0.15],
      ];
      for (const [oy, oz] of offsets) {
        const bMesh = new THREE.Mesh(bellGeo, darkNozzleMat);
        bMesh.position.set(-L * 0.46 - gimbalMountX, oy, oz);
        gimbalPivotGroup.add(bMesh);
      }

      // Massive 4-nozzle cowling frame
      const cowlFrame = new THREE.Mesh(new THREE.BoxGeometry(L * 0.1, W * 0.65, H * 0.55), armorPlateMat);
      cowlFrame.position.set(-L * 0.48 - gimbalMountX, 0, 0);
      gimbalPivotGroup.add(cowlFrame);

      const plasmaDreadMat = new THREE.MeshBasicMaterial({ color: teamColorHex, map: plumeTex });
      for (const [oy, oz] of offsets) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(2.0, 3.2, 12), plasmaDreadMat);
        ring.rotateY(Math.PI / 2);
        ring.position.set(-L * 0.47 - gimbalMountX, oy, oz);
        gimbalPivotGroup.add(ring);
      }

    } else {
      // 3. Frigate (Twin-Prow 3D Tactical Cruiser) — DEFAULT
      const centerHull = new THREE.Mesh(new THREE.BoxGeometry(L * 0.6, W * 0.5, H * 0.45), mainHullMat);
      centerHull.position.set(-L * 0.05, 0, 0);
      hullRollGroup.add(centerHull);

      // Twin heavy armored forward mandibles
      const mandiblePort = new THREE.Mesh(new THREE.BoxGeometry(L * 0.42, W * 0.2, H * 0.35), armorPlateMat);
      mandiblePort.position.set(L * 0.35, -W * 0.25, 0);
      const mandibleStbd = new THREE.Mesh(new THREE.BoxGeometry(L * 0.42, W * 0.2, H * 0.35), armorPlateMat);
      mandibleStbd.position.set(L * 0.35, W * 0.25, 0);
      hullRollGroup.add(mandiblePort);
      hullRollGroup.add(mandibleStbd);

      // Chamfered mandible prow armor caps + panel inlays
      const capGeo = new THREE.BoxGeometry(L * 0.1, W * 0.22, H * 0.38);
      const capPort = new THREE.Mesh(capGeo, armorPlateMat);
      capPort.position.set(L * 0.52, -W * 0.25, 0);
      const capStbd = new THREE.Mesh(capGeo, armorPlateMat);
      capStbd.position.set(L * 0.52, W * 0.25, 0);
      hullRollGroup.add(capPort);
      hullRollGroup.add(capStbd);

      const inlayGeo = new THREE.BoxGeometry(L * 0.25, 0.4, H * 0.2);
      const inlayPort = new THREE.Mesh(inlayGeo, teamAccentMat);
      inlayPort.position.set(L * 0.35, -W * 0.355, 0);
      const inlayStbd = new THREE.Mesh(inlayGeo, teamAccentMat);
      inlayStbd.position.set(L * 0.35, W * 0.355, 0);
      hullRollGroup.add(inlayPort);
      hullRollGroup.add(inlayStbd);

      // Lateral armored belt ribs
      for (let b = 0; b < 3; b++) {
        const beltP = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, 1.2, H * 0.3), armorPlateMat);
        beltP.position.set(-L * 0.15 + b * (L * 0.1), -W * 0.26, 0);
        const beltS = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, 1.2, H * 0.3), armorPlateMat);
        beltS.position.set(-L * 0.15 + b * (L * 0.1), W * 0.26, 0);
        hullRollGroup.add(beltP);
        hullRollGroup.add(beltS);
      }

      // Dorsal cooling intake louvers
      for (let l = 0; l < 4; l++) {
        const louver = new THREE.Mesh(new THREE.BoxGeometry(1.0, W * 0.18, 0.6), darkGreebleMat);
        louver.position.set(-L * 0.22 + l * 3.0, 0, H * 0.24);
        louver.rotation.y = 0.3;
        hullRollGroup.add(louver);
      }

      // Recessed magnetic accelerator channel with glowing field coils
      const channelFloor = new THREE.Mesh(new THREE.BoxGeometry(L * 0.4, W * 0.15, H * 0.1), darkGreebleMat);
      channelFloor.position.set(L * 0.34, 0, -H * 0.08);
      hullRollGroup.add(channelFloor);

      const coilMat = new THREE.MeshStandardMaterial({
        color: 0xf3e8ff,
        map: plumeTex,
        bumpMap: greebleSkin.bumpMap,
        bumpScale: 0.45,
        emissive: 0xc084fc,
        emissiveMap: plumeTex,
        emissiveIntensity: 0.8,
        roughness: 0.3,
        metalness: 0.7,
      });
      for (let c = 0; c < 4; c++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(W * 0.1, 0.8, 8, 16), coilMat);
        coil.rotateY(Math.PI / 2);
        coil.position.set(L * 0.18 + c * (L * 0.09), 0, 0);
        hullRollGroup.add(coil);
      }

      // 6 pairs of angled structural dorsal/ventral spinal ribs
      const ribGeo = new THREE.BoxGeometry(1.2, W * 0.54, H * 0.52);
      for (let r = 0; r < 6; r++) {
        const rib = new THREE.Mesh(ribGeo, armorPlateMat);
        rib.position.set(-L * 0.3 + r * (L * 0.1), 0, 0);
        hullRollGroup.add(rib);
      }

      // Elevated multi-tier command bridge tower with glowing bridge viewport & radar mast
      const bridgeTower = new THREE.Mesh(new THREE.BoxGeometry(L * 0.18, W * 0.24, H * 0.3), armorPlateMat);
      bridgeTower.position.set(-L * 0.08, 0, H * 0.32);
      const bridgeStrip = new THREE.Mesh(new THREE.BoxGeometry(L * 0.08, W * 0.22, H * 0.08), canopyMat);
      bridgeStrip.position.set(-L * 0.04, 0, H * 0.42);
      const radarMast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, H * 0.3, 8), darkGreebleMat);
      radarMast.position.set(-L * 0.12, 0, H * 0.55);
      hullRollGroup.add(bridgeTower);
      hullRollGroup.add(bridgeStrip);
      hullRollGroup.add(radarMast);

      // Forward bridge viewport cowl brow & side cowl fins
      const bridgeBrow = new THREE.Mesh(new THREE.BoxGeometry(L * 0.1, W * 0.24, H * 0.06), armorPlateMat);
      bridgeBrow.position.set(-L * 0.02, 0, H * 0.48);
      bridgeBrow.rotation.y = -0.15;
      hullRollGroup.add(bridgeBrow);

      const bridgeFinP = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, 0.8, H * 0.14), armorPlateMat);
      bridgeFinP.position.set(-L * 0.04, -W * 0.13, H * 0.44);
      const bridgeFinS = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, 0.8, H * 0.14), armorPlateMat);
      bridgeFinS.position.set(-L * 0.04, W * 0.13, H * 0.44);
      hullRollGroup.add(bridgeFinP);
      hullRollGroup.add(bridgeFinS);

      // Twin lateral bridge sensor antennae outriggers
      const outriggerP = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, H * 0.35, 6), darkGreebleMat);
      outriggerP.position.set(-L * 0.10, -W * 0.14, H * 0.65);
      const outriggerS = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, H * 0.35, 6), darkGreebleMat);
      outriggerS.position.set(-L * 0.10, W * 0.14, H * 0.65);
      hullRollGroup.add(outriggerP);
      hullRollGroup.add(outriggerS);

      // Frigate dorsal heat-sink spine ribs
      for (let r = 0; r < 4; r++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, W * 0.22, H * 0.16), radiatorMaterial);
        fin.position.set(-L * 0.05 + r * (L * 0.06), 0, H * 0.28);
        hullRollGroup.add(fin);
      }

      // Detailed bridge sensor array
      const sensorArray = new THREE.Mesh(new THREE.BoxGeometry(L * 0.05, W * 0.12, H * 0.1), darkGreebleMat);
      sensorArray.position.set(-L * 0.02, 0, H * 0.48);
      hullRollGroup.add(sensorArray);

      // Rotating miniature radar dish bar atop radarMast
      const radarDish = new THREE.Mesh(new THREE.BoxGeometry(L * 0.08, 0.8, 1.5), teamAccentMat);
      radarDish.position.set(-L * 0.12, 0, H * 0.72);
      hullRollGroup.add(radarDish);
      shipGroup.userData.radarDish = radarDish;
      hullRollGroup.userData.radarDish = radarDish;

      // Lateral weapon sponsons
      const sponsonPort = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, W * 0.15, H * 0.2), teamAccentMat);
      sponsonPort.position.set(0, -W * 0.35, 0);
      const sponsonStbd = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, W * 0.15, H * 0.2), teamAccentMat);
      sponsonStbd.position.set(0, W * 0.35, 0);
      hullRollGroup.add(sponsonPort);
      hullRollGroup.add(sponsonStbd);

      // Lateral sponson running lights (Port red at +Y, Starboard green at -Y)
      const sponsonTipP = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
      sponsonTipP.position.set(0, W * 0.43, 0);
      const sponsonTipS = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
      sponsonTipS.position.set(0, -W * 0.43, 0);
      hullRollGroup.add(sponsonTipP);
      hullRollGroup.add(sponsonTipS);

      // Ventral keel strake
      const keelStrake = new THREE.Mesh(new THREE.BoxGeometry(L * 0.55, 1.4, H * 0.18), armorPlateMat);
      keelStrake.position.set(-L * 0.02, 0, -H * 0.26);
      hullRollGroup.add(keelStrake);

      // Armored 3-nozzle fusion engine shroud & inner plasma glow rings parented to gimbalPivotGroup
      const shroudFrame = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, W * 0.52, H * 0.35), armorPlateMat);
      shroudFrame.position.set(-L * 0.44 - gimbalMountX, 0, 0);
      gimbalPivotGroup.add(shroudFrame);

      // 3-Nozzle fusion drive block
      const bellGeo = new THREE.CylinderGeometry(2.2, 3.6, 6, 12);
      bellGeo.rotateZ(Math.PI / 2);
      const nCenter = new THREE.Mesh(bellGeo, darkNozzleMat);
      nCenter.position.set(-L * 0.42 - gimbalMountX, 0, 0);
      const nPort = new THREE.Mesh(bellGeo, darkNozzleMat);
      nPort.position.set(-L * 0.42 - gimbalMountX, -W * 0.2, 0);
      const nStbd = new THREE.Mesh(bellGeo, darkNozzleMat);
      nStbd.position.set(-L * 0.42 - gimbalMountX, W * 0.2, 0);
      gimbalPivotGroup.add(nCenter);
      gimbalPivotGroup.add(nPort);
      gimbalPivotGroup.add(nStbd);

      const plasmaMat = new THREE.MeshBasicMaterial({ color: teamColorHex, map: plumeTex });
      for (const ny of [0, -W * 0.2, W * 0.2]) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 12), plasmaMat);
        ring.rotateY(Math.PI / 2);
        ring.position.set(-L * 0.45 - gimbalMountX, ny, 0);
        gimbalPivotGroup.add(ring);
      }
    }

    // --- ARTICULATED HARDWARE ON EVERY SHIP ---

    // 1. 3D Rotating & Recoiling Multi-Barrel Turret (turretGroup)
    const turretGroup = new THREE.Group();
    turretGroup.name = 'turretGroup';
    turretGroup.position.set(L * 0.05, 0, H * 0.32);

    // Stepped armored base collar ring
    const baseCollar = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.22, W * 0.24, H * 0.08, 16), darkGreebleMat);
    baseCollar.position.set(0, 0, -H * 0.08);
    turretGroup.add(baseCollar);

    const turretHousing = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.16, W * 0.2, H * 0.2, 16), armorPlateMat);
    turretGroup.add(turretHousing);

    // Sloped mantlet shield
    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(L * 0.08, W * 0.22, H * 0.18), armorPlateMat);
    mantlet.position.set(L * 0.06, 0, H * 0.02);
    mantlet.rotation.y = -0.25;
    turretGroup.add(mantlet);

    // Coaxial optical sensor box + cyan lens glow
    const sensorBox = new THREE.Mesh(new THREE.BoxGeometry(L * 0.06, W * 0.06, H * 0.08), darkGreebleMat);
    sensorBox.position.set(L * 0.08, 0, H * 0.12);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.5, 8), new THREE.MeshBasicMaterial({ color: 0x06b6d4, map: canopySkin.map }));
    lens.rotateZ(-Math.PI / 2);
    lens.position.set(L * 0.03 + 0.3, 0, 0);
    sensorBox.add(lens);
    turretGroup.add(sensorBox);

    const barrelRecoilGroup = new THREE.Group();
    barrelRecoilGroup.name = 'barrelRecoilGroup';
    const barrelGeo = new THREE.CylinderGeometry(0.9, 0.9, L * 0.25, 8);
    barrelGeo.rotateZ(-Math.PI / 2);
    const barrelPort = new THREE.Mesh(barrelGeo, darkNozzleMat);
    barrelPort.position.set(L * 0.12, -W * 0.06, 0);
    const barrelStbd = new THREE.Mesh(barrelGeo, darkNozzleMat);
    barrelStbd.position.set(L * 0.12, W * 0.06, 0);
    barrelRecoilGroup.add(barrelPort);
    barrelRecoilGroup.add(barrelStbd);

    // Twin cooling shrouds + perforated muzzle collars on barrelRecoilGroup
    const shroudGeo = new THREE.CylinderGeometry(1.3, 1.3, L * 0.12, 8);
    shroudGeo.rotateZ(-Math.PI / 2);
    const shroudPort = new THREE.Mesh(shroudGeo, darkGreebleMat);
    shroudPort.position.set(L * 0.06, -W * 0.06, 0);
    const shroudStbd = new THREE.Mesh(shroudGeo, darkGreebleMat);
    shroudStbd.position.set(L * 0.06, W * 0.06, 0);
    barrelRecoilGroup.add(shroudPort);
    barrelRecoilGroup.add(shroudStbd);

    const muzzleGeo = new THREE.CylinderGeometry(1.2, 1.2, L * 0.04, 8);
    muzzleGeo.rotateZ(-Math.PI / 2);
    const muzzlePort = new THREE.Mesh(muzzleGeo, armorPlateMat);
    muzzlePort.position.set(L * 0.24, -W * 0.06, 0);
    const muzzleStbd = new THREE.Mesh(muzzleGeo, armorPlateMat);
    muzzleStbd.position.set(L * 0.24, W * 0.06, 0);
    barrelRecoilGroup.add(muzzlePort);
    barrelRecoilGroup.add(muzzleStbd);

    turretGroup.add(barrelRecoilGroup);

    hullRollGroup.add(turretGroup);
    shipGroup.turretGroup = turretGroup;
    hullRollGroup.turretGroup = turretGroup;
    shipGroup.barrelRecoilGroup = barrelRecoilGroup;

    // 1b. Separate Heavy Railgun Barrel Mesh (railgunGroup)
    const railgunGroup = new THREE.Group();
    railgunGroup.name = 'railgunGroup';
    railgunGroup.position.set(L * 0.12, 0, H * 0.18);

    // Heavy armored trunnion mount
    const trunnion = new THREE.Mesh(new THREE.BoxGeometry(L * 0.14, 4.2, 3.6), armorPlateMat);
    trunnion.position.set(-L * 0.05, 0, 0);
    railgunGroup.add(trunnion);

    // Heavy twin-rail barrel along +X
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xd8e2ee,
      map: armorSkin.map,
      bumpMap: armorSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: armorSkin.roughnessMap,
      roughness: 0.4,
      metalness: 0.85,
    });
    const railGeoUpper = new THREE.BoxGeometry(L * 0.36, 1.2, 1.4);
    railGeoUpper.translate(L * 0.18, 0, 0);
    const railUpper = new THREE.Mesh(railGeoUpper, railMat);
    railUpper.position.set(0, -1.2, 0);

    const railGeoLower = new THREE.BoxGeometry(L * 0.36, 1.2, 1.4);
    railGeoLower.translate(L * 0.18, 0, 0);
    const railLower = new THREE.Mesh(railGeoLower, railMat);
    railLower.position.set(0, 1.2, 0);

    railgunGroup.add(railUpper);
    railgunGroup.add(railLower);

    // Twin dorsal magnetic accelerator coils
    const coilGeo = new THREE.TorusGeometry(2.0, 0.45, 8, 16);
    coilGeo.rotateY(Math.PI / 2);
    const coilMat = new THREE.MeshStandardMaterial({
      color: 0xd8e2ee,
      map: greebleSkin.map,
      bumpMap: greebleSkin.bumpMap,
      bumpScale: 0.45,
      roughnessMap: greebleSkin.roughnessMap,
      roughness: 0.45,
      metalness: 0.8,
    });
    const coil1 = new THREE.Mesh(coilGeo, coilMat);
    coil1.position.set(L * 0.12, 0, 0);
    const coil2 = new THREE.Mesh(coilGeo, coilMat);
    coil2.position.set(L * 0.24, 0, 0);
    railgunGroup.add(coil1);
    railgunGroup.add(coil2);

    // Glowing purple power conduit pipes
    const conduitMat = new THREE.MeshStandardMaterial({
      color: 0xf3e8ff,
      map: plumeTex,
      emissive: 0xc084fc,
      emissiveMap: plumeTex,
      emissiveIntensity: 1.5,
      roughness: 0.25,
      metalness: 0.8,
    });
    const conduitPort = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, L * 0.28, 8), conduitMat);
    conduitPort.rotateZ(Math.PI / 2);
    conduitPort.position.set(L * 0.14, -1.8, 0.8);
    const conduitStbd = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, L * 0.28, 8), conduitMat);
    conduitStbd.rotateZ(Math.PI / 2);
    conduitStbd.position.set(L * 0.14, 1.8, 0.8);
    railgunGroup.add(conduitPort);
    railgunGroup.add(conduitStbd);

    // Slotted muzzle brake prongs at barrel tip
    const brakeGeo = new THREE.BoxGeometry(L * 0.06, 0.6, 2.2);
    const brakePort = new THREE.Mesh(brakeGeo, armorPlateMat);
    brakePort.position.set(L * 0.38, -1.2, 0);
    const brakeStbd = new THREE.Mesh(brakeGeo, armorPlateMat);
    brakeStbd.position.set(L * 0.38, 1.2, 0);
    railgunGroup.add(brakePort);
    railgunGroup.add(brakeStbd);

    // Glowing breech capacitor along +X
    const breechGeo = new THREE.BoxGeometry(L * 0.12, 3.2, 3.0);
    const breechMat = new THREE.MeshStandardMaterial({
      color: 0xf3e8ff,
      map: greebleSkin.map,
      bumpMap: greebleSkin.bumpMap,
      bumpScale: 0.45,
      emissive: 0xc084fc,
      emissiveMap: plumeTex,
      emissiveIntensity: 1.2,
      roughness: 0.25,
      metalness: 0.9,
    });
    const breechMesh = new THREE.Mesh(breechGeo, breechMat);
    breechMesh.position.set(0, 0, 0);
    railgunGroup.add(breechMesh);

    hullRollGroup.add(railgunGroup);
    shipGroup.railgunGroup = railgunGroup;
    hullRollGroup.railgunGroup = railgunGroup;

    // 2. 10 Physical 3D RCS Thruster Pods (rcsPods: 6 translation/yaw/roll + 4 pitch)
    const rcsPods = new Map();
    const mounts = [
      { id: 'bowPort', x: 0.4 * L, y: 0.5 * W, z: 0, dir: [0, 1, 0] },
      { id: 'bowStarboard', x: 0.4 * L, y: -0.5 * W, z: 0, dir: [0, -1, 0] },
      { id: 'sternPort', x: -0.4 * L, y: 0.5 * W, z: 0, dir: [0, 1, 0] },
      { id: 'sternStarboard', x: -0.4 * L, y: -0.5 * W, z: 0, dir: [0, -1, 0] },
      { id: 'dorsalRoll', x: 0, y: 0, z: 0.35 * H, dir: [0, 1, 0] },
      { id: 'ventralRoll', x: 0, y: 0, z: -0.35 * H, dir: [0, 1, 0] },
      { id: 'bowDorsal', x: 0.35 * L, y: 0, z: 0.35 * H, dir: [0, 0, 1] },
      { id: 'bowVentral', x: 0.35 * L, y: 0, z: -0.35 * H, dir: [0, 0, -1] },
      { id: 'sternDorsal', x: -0.35 * L, y: 0, z: 0.35 * H, dir: [0, 0, 1] },
      { id: 'sternVentral', x: -0.35 * L, y: 0, z: -0.35 * H, dir: [0, 0, -1] },
    ];

    for (const m of mounts) {
      const podGroup = new THREE.Group();
      podGroup.name = `rcsPod_${m.id}`;
      podGroup.position.set(m.x, m.y, m.z);
      podGroup.userData.id = m.id;
      podGroup.userData.dir = m.dir;

      const podHousing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2.5), darkGreebleMat);
      podGroup.add(podHousing);

      // Visible nozzle cylinder housing oriented along m.dir
      const nozzleGeo = new THREE.CylinderGeometry(0.8, 1.2, 2.5, 8);
      const nozzleMesh = new THREE.Mesh(nozzleGeo, darkNozzleMat);
      if (m.dir[2] !== 0) {
        nozzleGeo.rotateX(Math.PI / 2);
        nozzleMesh.position.set(0, 0, m.dir[2] > 0 ? 1.0 : -1.0);
      } else {
        nozzleMesh.position.set(0, m.dir[1] > 0 ? 1.0 : -1.0, 0);
      }
      podGroup.add(nozzleMesh);

      // Conical Plume (ConeGeometry)
      const plumeGeo = new THREE.ConeGeometry(2.5, 12, 8);
      if (m.dir[2] !== 0) {
        if (m.dir[2] > 0) {
          plumeGeo.rotateX(-Math.PI / 2);
          plumeGeo.translate(0, 0, 6);
        } else {
          plumeGeo.rotateX(Math.PI / 2);
          plumeGeo.translate(0, 0, -6);
        }
      } else if (m.dir[1] < 0) {
        plumeGeo.rotateZ(Math.PI);
        plumeGeo.translate(0, -6, 0);
      } else {
        plumeGeo.translate(0, 6, 0);
      }

      const plumeMat = new THREE.MeshBasicMaterial({
        color: 0x7dd3fc,
        map: plumeTex,
        transparent: true,
        opacity: 0.85,
      });
      const plumeMesh = new THREE.Mesh(plumeGeo, plumeMat);
      plumeMesh.name = 'plume';
      plumeMesh.visible = false;
      podGroup.add(plumeMesh);

      hullRollGroup.add(podGroup);
      const podObj = { group: podGroup, housing: podHousing, nozzle: nozzleMesh, plume: plumeMesh, id: m.id, dir: m.dir };
      rcsPods.set(m.id, podObj);
      rcsPods[m.id] = podObj;
    }
    shipGroup.rcsPods = rcsPods;
    hullRollGroup.rcsPods = rcsPods;

    // 3. Main Drive Multi-Cone Plasma Plumes + Engine PointLight parented to gimbalPivotGroup
    const drivePlumeGroup = new THREE.Group();
    drivePlumeGroup.name = 'drivePlumeGroup';
    drivePlumeGroup.position.set(-L * 0.48 - gimbalMountX, 0, 0);

    const coreConeGeo = new THREE.ConeGeometry(W * 0.12, L * 0.35, 12);
    coreConeGeo.rotateZ(Math.PI / 2);
    coreConeGeo.translate(-L * 0.175, 0, 0);
    const coreConeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, map: plumeTex });
    const coreConeMesh = new THREE.Mesh(coreConeGeo, coreConeMat);
    drivePlumeGroup.add(coreConeMesh);

    const outerConeGeo = new THREE.ConeGeometry(W * 0.22, L * 0.55, 12);
    outerConeGeo.rotateZ(Math.PI / 2);
    outerConeGeo.translate(-L * 0.275, 0, 0);
    const outerConeMat = new THREE.MeshBasicMaterial({
      color: teamColorHex,
      map: plumeTex,
      transparent: true,
      opacity: 0.65,
    });
    const outerConeMesh = new THREE.Mesh(outerConeGeo, outerConeMat);
    drivePlumeGroup.add(outerConeMesh);

    const engineLight = new THREE.PointLight(teamColorHex, 0, 250);
    engineLight.position.set(-L * 0.1, 0, 0);
    drivePlumeGroup.add(engineLight);

    gimbalPivotGroup.add(drivePlumeGroup);
    shipGroup.drivePlumeGroup = drivePlumeGroup;
    shipGroup.engineLight = engineLight;

    // 4. Glowing Radiator Fin Arrays (radiatorMaterial)
    const finPlateGeo = new THREE.BoxGeometry(1.8, 3.5, 4.0);
    for (let f = 0; f < 4; f++) {
      const rx = -L * 0.15 - f * 4.5;
      const finPort = new THREE.Mesh(finPlateGeo, radiatorMaterial);
      finPort.position.set(rx, -W * 0.28, 0);
      finPort.rotation.x = -0.3;
      const finStbd = new THREE.Mesh(finPlateGeo, radiatorMaterial);
      finStbd.position.set(rx, W * 0.28, 0);
      finStbd.rotation.x = 0.3;
      hullRollGroup.add(finPort);
      hullRollGroup.add(finStbd);
    }

    // 5. 4-Quadrant 3D Geodesic Hex Shields (shieldGroup)
    const shieldRadius = (hullClass === 'dreadnought' ? 58 : (hullClass === 'corvette' ? 28 : 42));
    // SphereGeometry patches are centred on local -X at rotateZ(0). Ship nose is +X and
    // starboard is -Y (three.js space mirrors sim +Y), so each patch is rotated to match:
    // fore -> +X, aft -> -X, starboard -> -Y, port -> +Y.
    // Port and starboard extend phi across [-π/2, +π/2] so they wrap all the way up (+Z)
    // and down (-Z) to meet at the dorsal/ventral midline (y = 0) while leaving fore (+X)
    // and aft (-X) uncapped.
    const quads = [
      { key: 'fore', angle: Math.PI, phiStart: -Math.PI / 4, phiLength: Math.PI / 2 },
      { key: 'starboard', angle: Math.PI / 2, phiStart: -Math.PI / 2, phiLength: Math.PI },
      { key: 'aft', angle: 0, phiStart: -Math.PI / 4, phiLength: Math.PI / 2 },
      { key: 'port', angle: -Math.PI / 2, phiStart: -Math.PI / 2, phiLength: Math.PI },
    ];

    const shieldQuads = {};
    for (const q of quads) {
      const quadGroup = new THREE.Group();
      quadGroup.name = `shield_${q.key}`;

      const segGeo = new THREE.SphereGeometry(shieldRadius, 16, 8, q.phiStart, q.phiLength, Math.PI * 0.2, Math.PI * 0.6);
      segGeo.rotateZ(q.angle);

      const segMat = new THREE.MeshBasicMaterial({
        color: teamColorHex,
        map: shieldHexTex,
        transparent: true,
        opacity: 0.10,
        side: THREE.FrontSide,
        depthWrite: false,
      });
      const segMesh = new THREE.Mesh(segGeo, segMat);
      quadGroup.add(segMesh);

      const wireGeo = new THREE.WireframeGeometry(segGeo);
      const wireMat = new THREE.LineBasicMaterial({
        color: teamColorHex,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      });
      const wireMesh = new THREE.LineSegments(wireGeo, wireMat);
      quadGroup.add(wireMesh);

      shieldGroup.add(quadGroup);
      shieldQuads[q.key] = { group: quadGroup, surface: segMesh, wire: wireMesh };
    }
    shieldGroup.userData.quads = shieldQuads;
    shipGroup.shieldQuads = shieldQuads;

    // Baseline material configs for Edge Dampening Field amber-gold hull glow
    shipGroup.userData.hullGlowMaterials = [
      { mat: mainHullMat, baseColor: 0x000000, baseIntensity: 0 },
      { mat: armorPlateMat, baseColor: 0x000000, baseIntensity: 0 },
      { mat: teamAccentMat, baseColor: teamColorHex, baseIntensity: 0.3 },
    ];
    hullRollGroup.userData.hullGlowMaterials = shipGroup.userData.hullGlowMaterials;

    // Outer amber-gold translucent aura mesh attached directly to shipGroup
    // (kept outside hullRollGroup.children so own-ship POV hiding invariants are preserved)
    const auraGeo = new THREE.SphereGeometry(1, 20, 14);
    const auraMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const dampeningAuraMesh = new THREE.Mesh(auraGeo, auraMat);
    dampeningAuraMesh.name = 'dampeningAuraMesh';
    dampeningAuraMesh.scale.set(L * 0.68, W * 0.78, H * 0.95);
    dampeningAuraMesh.visible = false;
    shipGroup.add(dampeningAuraMesh);
    shipGroup.dampeningAuraMesh = dampeningAuraMesh;
    hullRollGroup.dampeningAuraMesh = dampeningAuraMesh;

    return shipGroup;
  }

  /**
   * Syncs Arena perimeter in 3D scene.
   */
  syncArena3D(radius = 5250) {
    if (!this.arenaMesh || this.arenaMesh.userData.radius !== radius) {
      if (this.arenaMesh) {
        this.scene.remove(this.arenaMesh);
        if (this.arenaMesh.userData.innerGroup) {
          this.scene.remove(this.arenaMesh.userData.innerGroup);
        }
        if (this.arenaMesh.userData.beaconGroup) {
          this.scene.remove(this.arenaMesh.userData.beaconGroup);
        }
      }
      const geo = new THREE.RingGeometry(radius - 4, radius + 4, 128);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });
      this.arenaMesh = new THREE.Mesh(geo, mat);
      this.arenaMesh.userData.radius = radius;
      this.scene.add(this.arenaMesh);

      // Translucent z = 0 orbital reference rings / equatorial grid
      const innerGroup = new THREE.Group();
      innerGroup.name = 'orbitalReferenceRings';
      const refMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
      });
      for (const frac of [0.33, 0.66]) {
        const r = radius * frac;
        const ringMesh = new THREE.Mesh(new THREE.RingGeometry(r - 2, r + 2, 96), refMat);
        innerGroup.add(ringMesh);
      }
      this.scene.add(innerGroup);
      this.arenaMesh.userData.innerGroup = innerGroup;

      // Navigation beacon pylons / boundary marker buoys spaced evenly around arenaRadius perimeter ring
      const beaconGroup = new THREE.Group();
      beaconGroup.name = 'arenaBeaconPylons';
      const numBeacons = 24;
      const pylonSkin = getDerelictHullSkinBitmaps();
      const pylonMat = new THREE.MeshStandardMaterial({
        color: 0xd8e2ee,
        map: pylonSkin.map,
        bumpMap: pylonSkin.bumpMap,
        bumpScale: 0.6,
        roughnessMap: pylonSkin.roughnessMap,
        roughness: 0.65,
        metalness: 0.8,
      });
      const pylonLightMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.9,
      });
      const amberLightMat = new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.9,
      });

      for (let i = 0; i < numBeacons; i++) {
        const theta = (i / numBeacons) * Math.PI * 2;
        const bx = Math.cos(theta) * radius;
        const by = Math.sin(theta) * radius;

        const buoy = new THREE.Group();
        buoy.position.set(bx, by, 0);

        // Vertical pylon mast extending above and below orbital plane
        const mastGeo = new THREE.CylinderGeometry(2.5, 3.5, 60, 8);
        mastGeo.rotateX(Math.PI / 2);
        const mastMesh = new THREE.Mesh(mastGeo, pylonMat);
        buoy.add(mastMesh);

        // Floating sensor toroidal collar ring
        const collarGeo = new THREE.TorusGeometry(8, 1.4, 8, 16);
        const collarMesh = new THREE.Mesh(collarGeo, pylonMat);
        buoy.add(collarMesh);

        // Navigational beacon strobes (dorsal + ventral)
        const lightMat = (i % 4 === 0) ? amberLightMat : pylonLightMat;
        const strobeTop = new THREE.Mesh(new THREE.SphereGeometry(3.0, 8, 8), lightMat);
        strobeTop.position.set(0, 0, 32);
        buoy.add(strobeTop);

        const strobeBottom = new THREE.Mesh(new THREE.SphereGeometry(3.0, 8, 8), lightMat);
        strobeBottom.position.set(0, 0, -32);
        buoy.add(strobeBottom);

        beaconGroup.add(buoy);
      }
      this.scene.add(beaconGroup);
      this.arenaMesh.userData.beaconGroup = beaconGroup;
    }
  }

  /**
   * Syncs 3D Polyhedral Tumbling Asteroids with crater facets, crystal ore veins, and destruction states.
   */
  syncAsteroids3D(asteroids = [], dt = 0.016) {
    if (!asteroids) return;

    const activeIds = new Set();
    for (const ast of asteroids) {
      const id = ast.id || `ast_${ast.pos?.x || 0}_${ast.pos?.y || 0}`;

      // Skip and remove destroyed asteroids
      if (ast.destroyed) {
        const existing = this.asteroidMeshes.get(id);
        if (existing) {
          this.scene.remove(existing);
          this.asteroidMeshes.delete(id);
        }
        continue;
      }
      activeIds.add(id);
      let mesh = this.asteroidMeshes.get(id);

      if (!mesh) {
        const r = ast.radius || 100;
        const geo = new THREE.IcosahedronGeometry(r, 3);

        const aSeed = hashStr(String(id));
        const aRng = createPrng(aSeed);
        const astSkin = getAsteroidSkinBitmaps(Math.abs(aSeed) % 4);

        // 4-7 macro geometric crater centers on unit sphere (depressed bowls + raised rims)
        const numCraters = 4 + Math.floor(aRng() * 4);
        const craters = [];
        for (let c = 0; c < numCraters; c++) {
          const theta = aRng() * Math.PI * 2;
          const phi = Math.acos(2 * aRng() - 1);
          craters.push({
            x: Math.sin(phi) * Math.cos(theta),
            y: Math.sin(phi) * Math.sin(theta),
            z: Math.cos(phi),
            depth: 0.11 + aRng() * 0.08,
            radius: 0.24 + aRng() * 0.28,
          });
        }

        // 2-3 tectonic fault-line fissure planes across unit sphere
        const numFissures = 2 + Math.floor(aRng() * 2);
        const fissures = [];
        for (let f = 0; f < numFissures; f++) {
          const fTheta = aRng() * Math.PI * 2;
          const fPhi = Math.acos(2 * aRng() - 1);
          const fnx = Math.sin(fPhi) * Math.cos(fTheta);
          const fny = Math.sin(fPhi) * Math.sin(fTheta);
          const fnz = Math.cos(fPhi);
          // Arbitrary orthogonal axis along fissure great circle
          const ax = Math.abs(fnx) < 0.8 ? 1 : 0;
          const ay = Math.abs(fnx) < 0.8 ? 0 : 1;
          const tLen = Math.hypot(fny * 0 - fnz * ay, fnz * ax - fnx * 0, fnx * ay - fny * ax) || 1;
          const ftx = (-fnz * ay) / tLen;
          const fty = (fnz * ax) / tLen;
          const ftz = (fnx * ay - fny * ax) / tLen;
          fissures.push({
            nx: fnx,
            ny: fny,
            nz: fnz,
            tx: ftx,
            ty: fty,
            tz: ftz,
            halfWidth: 0.085,
            depth: 0.11 + aRng() * 0.06,
            warpFreq: 6.0 + aRng() * 4.0,
            phase: aRng() * Math.PI * 2,
          });
        }

        const p1 = aRng() * Math.PI * 2;
        const p2 = aRng() * Math.PI * 2;
        const p3 = aRng() * Math.PI * 2;
        const freq = 2.0 + aRng() * 1.5;

        // Displace vertices as a pure function of normalized direction (nx, ny, nz)
        // so coincident seam vertices get the exact same radial scale, preventing cracks!
        const posAttr = geo.attributes.position;
        for (let i = 0; i < posAttr.count; i++) {
          const vx = posAttr.getX(i);
          const vy = posAttr.getY(i);
          const vz = posAttr.getZ(i);
          const len = Math.hypot(vx, vy, vz) || 1;
          const nx = vx / len;
          const ny = vy / len;
          const nz = vz / len;

          const o1 = Math.sin(nx * freq + p1) * Math.cos(ny * freq + p2) * Math.sin(nz * freq + p3);
          const o2 = Math.sin(nx * freq * 2.2 + p2) * Math.sin(ny * freq * 2.2 + p3) * Math.cos(nz * freq * 2.2 + p1) * 0.5;
          const o3 = Math.cos(nx * freq * 4.0 + p3) * Math.sin(ny * freq * 4.0 + p1) * 0.25;
          let disp = 1.0 + 0.09 * o1 + 0.05 * o2 + 0.03 * o3;

          for (const cr of craters) {
            const dot = nx * cr.x + ny * cr.y + nz * cr.z;
            const distAngle = Math.acos(Math.max(-1, Math.min(1, dot)));
            if (distAngle < cr.radius) {
              const t = distAngle / cr.radius;
              if (t < 0.72) {
                const u = t / 0.72;
                disp -= (1 - u * u) * cr.depth;
              } else {
                const rimPhase = (t - 0.72) / 0.28;
                disp += Math.sin(rimPhase * Math.PI) * cr.depth * 0.42;
              }
            }
          }

          for (const fs of fissures) {
            const warp = 0.032 * Math.sin((nx * fs.tx + ny * fs.ty + nz * fs.tz) * fs.warpFreq + fs.phase);
            const planeDist = Math.abs(nx * fs.nx + ny * fs.ny + nz * fs.nz + warp);
            if (planeDist < fs.halfWidth) {
              const endMask = Math.max(0.25, 1.0 - Math.abs(nx * fs.tx + ny * fs.ty + nz * fs.tz) * 0.75);
              disp -= (1.0 - planeDist / fs.halfWidth) * fs.depth * endMask;
            }
          }

          // Safe clamp to [0.72, 1.18] keeping max protrusion <= 1.2 * r
          const clamped = Math.max(0.72, Math.min(1.18, disp));
          posAttr.setXYZ(i, nx * r * clamped, ny * r * clamped, nz * r * clamped);
        }
        applySphericalUVs(geo);
        geo.computeVertexNormals();

        const mat = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: astSkin.map,
          bumpMap: astSkin.bumpMap,
          bumpScale: 1.85,
          roughnessMap: astSkin.roughnessMap,
          roughness: 0.9,
          metalness: 0.15,
          flatShading: false,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.userData.id = id;

        // 3-6 seeded rocky surface boulder outcrops (DodecahedronGeometry)
        const numOutcrops = 3 + Math.floor(aRng() * 4);
        for (let b = 0; b < numOutcrops; b++) {
          const theta = aRng() * Math.PI * 2;
          const phi = Math.acos(2 * aRng() - 1);
          const bx = Math.sin(phi) * Math.cos(theta);
          const by = Math.sin(phi) * Math.sin(theta);
          const bz = Math.cos(phi);
          const bRadius = r * (0.08 + aRng() * 0.08);
          const bGeo = new THREE.DodecahedronGeometry(bRadius, 0);
          applySphericalUVs(bGeo);
          const bMat = new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            map: astSkin.map,
            bumpMap: astSkin.bumpMap,
            bumpScale: 1.3,
            roughnessMap: astSkin.roughnessMap,
            roughness: 0.92,
            metalness: 0.15,
            flatShading: false,
          });
          const boulder = new THREE.Mesh(bGeo, bMat);
          boulder.position.set(bx * r * 0.92, by * r * 0.92, bz * r * 0.92);
          boulder.rotation.set(aRng() * Math.PI, aRng() * Math.PI, aRng() * Math.PI);
          mesh.add(boulder);
        }

        // Glowing 3D Crystal Ore Clusters (2-3 crystals + glowing fissure accents)
        if (ast.oreVeins) {
          for (const vein of ast.oreVeins) {
            let vColor = 0xfbbf24;
            if (vein.type === 'plasma_crystal') vColor = 0xc084fc;
            else if (vein.type === 'titanium') vColor = 0x7dd3fc;

            const oreSkin = getOreCrystalSkinBitmaps(vein.type);
            const clusterGroup = new THREE.Group();
            clusterGroup.name = 'oreCluster';

            const vMat = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              map: oreSkin.map,
              bumpMap: oreSkin.bumpMap,
              bumpScale: 0.5,
              emissive: vColor,
              emissiveMap: oreSkin.emissiveMap,
              emissiveIntensity: 1.4,
              roughness: 0.25,
              metalness: 0.8,
            });

            // 2-3 crystal cluster
            const crystalCount = 2 + (Math.abs(hashStr(String(vein.type || 'ore'))) % 2);
            for (let k = 0; k < crystalCount; k++) {
              const vGeo = new THREE.OctahedronGeometry(r * (0.08 + k * 0.02));
              const crystal = new THREE.Mesh(vGeo, vMat);
              crystal.position.set((k - 0.5) * r * 0.06, (k % 2 === 0 ? 1 : -1) * r * 0.04, 0);
              crystal.rotation.set(0.25 * (k + 1), 0.35 * (k - 1), 0.45 * k);
              clusterGroup.add(crystal);
            }

            // Subtle glowing fissure accent
            const fissureGeo = new THREE.BoxGeometry(r * 0.16, r * 0.04, r * 0.02);
            const fissureMat = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              map: oreSkin.map,
              emissive: vColor,
              emissiveMap: oreSkin.emissiveMap,
              emissiveIntensity: 0.9,
            });
            const fissure = new THREE.Mesh(fissureGeo, fissureMat);
            fissure.position.set(0, 0, -r * 0.02);
            clusterGroup.add(fissure);

            const dist = r * (vein.depth || 0.6);
            const vAngle = vein.angle || 0;
            clusterGroup.position.set(Math.cos(vAngle) * dist, Math.sin(vAngle) * dist, r * 0.3);
            mesh.add(clusterGroup);
          }
        }

        // Subtle mineral crystal & ridge studs on large asteroids
        if (r >= 50) {
          const numStuds = 3 + Math.floor(aRng() * 3);
          const studMat = new THREE.MeshStandardMaterial({
            color: 0xd8e2ee,
            map: astSkin.map,
            bumpMap: astSkin.bumpMap,
            bumpScale: 1.0,
            roughnessMap: astSkin.roughnessMap,
            roughness: 0.78,
            metalness: 0.35,
            flatShading: false,
          });
          const tiSkin = getOreCrystalSkinBitmaps('titanium');
          const studCrystalMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            map: tiSkin.map,
            bumpMap: tiSkin.bumpMap,
            bumpScale: 0.4,
            emissive: 0x0ea5e9,
            emissiveMap: tiSkin.emissiveMap,
            emissiveIntensity: 0.6,
            roughness: 0.25,
            metalness: 0.8,
          });
          for (let s = 0; s < numStuds; s++) {
            const sTheta = aRng() * Math.PI * 2;
            const sPhi = Math.acos(2 * aRng() - 1);
            const sx = Math.sin(sPhi) * Math.cos(sTheta);
            const sy = Math.sin(sPhi) * Math.sin(sTheta);
            const sz = Math.cos(sPhi);
            const sGeo = (s % 2 === 0)
              ? new THREE.ConeGeometry(r * 0.05, r * 0.12, 5)
              : new THREE.BoxGeometry(r * 0.08, r * 0.04, r * 0.06);
            const sMesh = new THREE.Mesh(sGeo, (s % 3 === 0) ? studCrystalMat : studMat);
            sMesh.position.set(sx * r * 0.95, sy * r * 0.95, sz * r * 0.95);
            sMesh.rotation.set(aRng() * Math.PI, aRng() * Math.PI, aRng() * Math.PI);
            mesh.add(sMesh);
          }
        }

        this.asteroidMeshes.set(id, mesh);
        this.scene.add(mesh);
      }

      // Position in 3D: (x, -y, z)
      mesh.position.set(ast.pos?.x ?? ast.x ?? 0, -(ast.pos?.y ?? ast.y ?? 0), ast.pos?.z ?? ast.z ?? 0);

      // Slow 3D Tumbling Rotation
      mesh.rotation.x += dt * 0.2;
      mesh.rotation.y += dt * 0.15;
      mesh.rotation.z += dt * 0.1;

      // Damage emissive tint when (ast.hp / ast.maxHp) < 0.75
      if (ast.hp !== undefined && ast.maxHp !== undefined && ast.maxHp > 0 && mesh.material) {
        const hpRatio = ast.hp / ast.maxHp;
        if (hpRatio < 0.75) {
          mesh.material.emissive.setHex(0xea580c);
          mesh.material.emissiveIntensity = (0.75 - hpRatio) * 1.5;
        } else {
          mesh.material.emissive.setHex(0x000000);
          mesh.material.emissiveIntensity = 0;
        }
      }
    }

    // Prune stale asteroid meshes
    for (const [id, mesh] of this.asteroidMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.asteroidMeshes.delete(id);
      }
    }
  }

  /**
   * Syncs 3D Black Hole Singularities (event horizon, photon ring, accretion disk & polar jets).
   */
  syncGravityWells3D(wells = [], dt = 0.016) {
    if (!wells) return;

    for (let w = 0; w < wells.length; w++) {
      const well = wells[w];
      const id = `well_${w}`;
      let mesh = this.wellMeshes.get(id);

      if (!mesh) {
        mesh = new THREE.Group();
        const horizon = well.eventHorizonRadius || 45;

        // 1. Black event horizon sphere
        const horizonMesh = new THREE.Mesh(
          new THREE.SphereGeometry(horizon, 32, 32),
          new THREE.MeshBasicMaterial({ color: 0x000000 })
        );
        mesh.add(horizonMesh);

        // 2. Glowing photon ring
        const photonRing = new THREE.Mesh(
          new THREE.TorusGeometry(horizon * 1.08, horizon * 0.04, 16, 64),
          new THREE.MeshBasicMaterial({ color: 0xf3e8ff })
        );
        mesh.add(photonRing);

        // 3. Tilted multi-ring rotating accretion disk
        const diskTex = getAccretionDiskSkinBitmap();
        const jetTex = getPlumePlasmaSkinBitmap();
        const accretionDisk = new THREE.Mesh(
          new THREE.TorusGeometry(horizon * 2.4, horizon * 0.35, 16, 64),
          new THREE.MeshBasicMaterial({
            color: 0xe9d5ff,
            map: diskTex,
            transparent: true,
            opacity: 0.65,
          })
        );
        accretionDisk.rotation.x = Math.PI / 3;
        mesh.add(accretionDisk);
        mesh.userData.accretionDisk = accretionDisk;

        // 4. Vertical relativistic polar jets (+Z and -Z)
        const jetNorth = new THREE.Mesh(
          new THREE.ConeGeometry(horizon * 0.5, horizon * 3.5, 16),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, map: jetTex, transparent: true, opacity: 0.7 })
        );
        jetNorth.position.set(0, 0, horizon * 2.0);
        jetNorth.rotateX(Math.PI / 2);
        mesh.add(jetNorth);

        const jetSouth = new THREE.Mesh(
          new THREE.ConeGeometry(horizon * 0.5, horizon * 3.5, 16),
          new THREE.MeshBasicMaterial({ color: 0x38bdf8, map: jetTex, transparent: true, opacity: 0.7 })
        );
        jetSouth.position.set(0, 0, -horizon * 2.0);
        jetSouth.rotateX(-Math.PI / 2);
        mesh.add(jetSouth);

        this.wellMeshes.set(id, mesh);
        this.scene.add(mesh);
      }

      mesh.position.set(well.pos?.x ?? well.x ?? 0, -(well.pos?.y ?? well.y ?? 0), well.pos?.z ?? well.z ?? 0);
      if (mesh.userData.accretionDisk) {
        mesh.userData.accretionDisk.rotation.z -= dt * 1.2;
      }
    }
  }

  /**
   * Syncs 3D Volumetric-Style Ion Storm Nebulae with multi-layered cloud spheres & internal lightning.
   */
  syncNebulae3D(nebulae = [], dt = 0.016) {
    if (!nebulae) return;

    for (let n = 0; n < nebulae.length; n++) {
      const neb = nebulae[n];
      const id = neb.id || `neb_${n}`;
      let group = this.nebulaMeshes.get(id);

      if (!group) {
        group = new THREE.Group();
        const radius = neb.radius || 500;

        // Multi-layered cloud spheres at varying Z depths
        const nebulaTex = getNebulaCloudSkinBitmap();
        const zDepths = [-radius * 0.15, 0, radius * 0.15];
        for (const z of zDepths) {
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(radius * 0.65, 16, 16),
            new THREE.MeshBasicMaterial({
              color: 0x38bdf8,
              map: nebulaTex,
              transparent: true,
              opacity: 0.08,
              side: THREE.DoubleSide,
            })
          );
          sphere.position.set((Math.random() - 0.5) * radius * 0.3, (Math.random() - 0.5) * radius * 0.3, z);
          group.add(sphere);
        }

        // Internal 3D jagged lightning bolt lines
        const boltPoints = [
          new THREE.Vector3(-radius * 0.2, 0, 0),
          new THREE.Vector3(-radius * 0.05, radius * 0.1, 10),
          new THREE.Vector3(radius * 0.08, -radius * 0.08, -10),
          new THREE.Vector3(radius * 0.25, 0, 5),
        ];
        const boltGeo = new THREE.BufferGeometry().setFromPoints(boltPoints);
        const boltMat = new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.8 });
        const bolt = new THREE.Line(boltGeo, boltMat);
        group.add(bolt);
        group.userData.bolt = bolt;

        this.nebulaMeshes.set(id, group);
        this.scene.add(group);
      }

      group.position.set(neb.pos?.x ?? neb.x ?? 0, -(neb.pos?.y ?? neb.y ?? 0), neb.pos?.z ?? neb.z ?? 0);
      if (group.userData.bolt) {
        group.userData.bolt.visible = Math.sin(this.animTime * 5 + n) > 0.3;
      }
    }
  }

  /**
   * Syncs 3D Debris Chunks & Spiked Tether Mines with 1Hz red beacon, magnetic tether beam, and stale chunk pruning.
   */
  syncDebrisAndMines3D(sector = {}, ships = {}, dt = 0.016) {
    // Handle either sector object or direct debrisChunks array
    const chunks = Array.isArray(sector) ? sector : (sector.debrisChunks || []);
    const mines = Array.isArray(ships) ? ships : (sector.tetherMines || []);
    const shipsObj = (ships && !Array.isArray(ships)) ? ships : {};

    // 1. Debris Chunks
    const activeChunkIds = new Set();
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const id = chunk.id || (chunk.pos ? `chunk_${chunk.pos.x}_${chunk.pos.y}` : `chunk_${c}`);
      activeChunkIds.add(id);
      let mesh = this.debrisMeshes.get(id);

      if (!mesh) {
        const cr = chunk.radius || 10;
        const group = new THREE.Group();
        group.name = `debris_${id}`;

        const dSeed = hashStr(String(id));
        const dRng = createPrng(dSeed);

        // 1. Twisted structural girder/hull plate
        const debrisSkin = getDebrisSkinBitmaps();
        const armorSkin = getArmorPlateSkinBitmaps();
        const girderMat = new THREE.MeshStandardMaterial({
          color: 0xd8e2ee,
          map: debrisSkin.map,
          bumpMap: debrisSkin.bumpMap,
          bumpScale: 0.85,
          roughnessMap: debrisSkin.roughnessMap,
          roughness: 0.82,
          metalness: 0.55,
        });
        const girder = new THREE.Mesh(new THREE.BoxGeometry(cr * 1.6, cr * 0.45, cr * 0.25), girderMat);
        girder.rotation.set((dRng() - 0.5) * 0.6, (dRng() - 0.5) * 0.6, (dRng() - 0.5) * 0.6);
        group.add(girder);

        // 2. Angled armor fragment
        const armorMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          map: armorSkin.map,
          bumpMap: armorSkin.bumpMap,
          bumpScale: 0.8,
          roughnessMap: armorSkin.roughnessMap,
          roughness: 0.65,
          metalness: 0.7,
        });
        const fragment = new THREE.Mesh(new THREE.BoxGeometry(cr * 1.0, cr * 0.8, cr * 0.35), armorMat);
        fragment.position.set((dRng() - 0.5) * cr * 0.4, (dRng() - 0.5) * cr * 0.4, cr * 0.2);
        fragment.rotation.set(dRng() * 0.8, dRng() * 0.8, dRng() * 0.8);
        group.add(fragment);

        // 3. Snapped spar / pipe strut
        const strutGeo = new THREE.CylinderGeometry(cr * 0.1, cr * 0.12, cr * 1.4, 6);
        const strut = new THREE.Mesh(strutGeo, girderMat);
        strut.rotation.set(Math.PI / 3 + dRng() * 0.4, 0, dRng() * Math.PI);
        strut.position.set(0, 0, -cr * 0.1);
        group.add(strut);

        mesh = group;
        this.debrisMeshes.set(id, mesh);
        this.scene.add(mesh);
      }

      mesh.position.set(chunk.pos?.x ?? chunk.x ?? 0, -(chunk.pos?.y ?? chunk.y ?? 0), chunk.pos?.z ?? chunk.z ?? 0);
      mesh.rotation.x += dt * 0.5;
      mesh.rotation.y += dt * 0.3;
    }

    // Prune stale debris meshes (e.g. FIFO shift when dynamicDebrisChunks caps at 60)
    for (const [id, mesh] of this.debrisMeshes.entries()) {
      if (!activeChunkIds.has(id)) {
        this.scene.remove(mesh);
        this.debrisMeshes.delete(id);
      }
    }

    // 2. Concealed Magnetic Spiked Tether Mines
    for (let m = 0; m < mines.length; m++) {
      const mine = mines[m];
      const id = mine.id || `mine_${m}`;
      let group = this.mineMeshes.get(id);

      if (!group) {
        group = new THREE.Group();
        const r = mine.radius || 18;
        const mineSkin = getMineSkinBitmaps();
        const nozzleSkin = getNozzleSkinBitmaps();

        // 1. Faceted Dodecahedron core (r * 0.85)
        const coreGeo = new THREE.DodecahedronGeometry(r * 0.85, 0);
        applySphericalUVs(coreGeo);
        const coreMat = new THREE.MeshStandardMaterial({
          color: 0xd8e2ee,
          map: mineSkin.map,
          bumpMap: mineSkin.bumpMap,
          bumpScale: 0.9,
          roughnessMap: mineSkin.roughnessMap,
          roughness: 0.55,
          metalness: 0.8,
          flatShading: false,
        });
        const body = new THREE.Mesh(coreGeo, coreMat);
        group.add(body);

        // 2. Equatorial magnetic clamp belt ring (TorusGeometry)
        const beltGeo = new THREE.TorusGeometry(r * 0.9, r * 0.09, 8, 24);
        const beltMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          map: nozzleSkin.map,
          bumpMap: nozzleSkin.bumpMap,
          bumpScale: 0.6,
          roughnessMap: nozzleSkin.roughnessMap,
          roughness: 0.45,
          metalness: 0.82,
        });
        const beltMesh = new THREE.Mesh(beltGeo, beltMat);
        group.add(beltMesh);

        // 3. 8 omni-directional spikes (ConeGeometry) pointing outward in 3D across equatorial & angled planes
        const spikeMat = new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          map: mineSkin.map,
          bumpMap: mineSkin.bumpMap,
          bumpScale: 0.7,
          roughnessMap: mineSkin.roughnessMap,
          roughness: 0.5,
          metalness: 0.75,
        });
        const spikeDirs = [
          // 4 equatorial
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0),
          // 4 angled in 3D across octants
          new THREE.Vector3(0.577, 0.577, 0.577).normalize(),
          new THREE.Vector3(-0.577, -0.577, 0.577).normalize(),
          new THREE.Vector3(0.577, -0.577, -0.577).normalize(),
          new THREE.Vector3(-0.577, 0.577, -0.577).normalize(),
        ];
        const upVec = new THREE.Vector3(0, 1, 0);
        for (const dir of spikeDirs) {
          const spikeGeo = new THREE.ConeGeometry(3, 8, 8);
          const spike = new THREE.Mesh(spikeGeo, spikeMat);
          spike.quaternion.setFromUnitVectors(upVec, dir);
          spike.position.copy(dir.clone().multiplyScalar(r * 0.85 + 4));
          group.add(spike);
        }

        // 4. 1Hz Blinking Red Beacon + Outer translucent warning shell
        const beacon = new THREE.Mesh(
          new THREE.SphereGeometry(4, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xef4444 })
        );
        group.add(beacon);
        group.userData.beacon = beacon;

        const warningShell = new THREE.Mesh(
          new THREE.SphereGeometry(6, 12, 12),
          new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.35 })
        );
        group.add(warningShell);
        group.userData.warningShell = warningShell;

        // Tether Beam Line
        const tetherGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        const tetherLine = new THREE.Line(tetherGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.8 }));
        tetherLine.visible = false;
        group.add(tetherLine);
        group.userData.tetherLine = tetherLine;

        this.mineMeshes.set(id, group);
        this.scene.add(group);
      }

      const mx = mine.pos?.x ?? mine.x ?? 0;
      const my = -(mine.pos?.y ?? mine.y ?? 0);
      const mz = mine.pos?.z ?? mine.z ?? 0;
      group.position.set(mx, my, mz);

      // 1Hz Blinking Red Beacon & Warning Shell
      const blink = Math.sin(this.animTime * Math.PI * 2) > 0;
      if (group.userData.beacon) {
        group.userData.beacon.material.color.setHex(blink ? 0xef4444 : 0x450a0a);
      }
      if (group.userData.warningShell) {
        group.userData.warningShell.material.opacity = blink ? 0.4 : 0.08;
      }

      // Magnetic Tether Beam
      if (mine.tetheredShipId && shipsObj[mine.tetheredShipId]) {
        const targetShip = shipsObj[mine.tetheredShipId];
        const sx = targetShip.pos?.x || 0;
        const sy = -(targetShip.pos?.y || 0);
        const sz = targetShip.pos?.z || 0;
        const tether = group.userData.tetherLine;
        if (tether) {
          tether.visible = true;
          tether.geometry.setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(sx - mx, sy - my, sz - mz)]);
        }
      } else if (group.userData.tetherLine) {
        group.userData.tetherLine.visible = false;
      }
    }
  }

  /**
   * Syncs 3D Orbital Munitions Derelict (+3 Torpedoes Resupply Station).
   */
  syncDerelict3D(derelict, ships = {}, dt = 0.016) {
    if (!derelict) return;

    if (!this.derelictMesh) {
      const group = new THREE.Group();

      // 1. Multi-section broken cargo station hull
      const derelictHullSkin = getDerelictHullSkinBitmaps();
      const derelictGreebleSkin = getGreebleSkinBitmaps();
      const derelictNozzleSkin = getNozzleSkinBitmaps();
      const solarSkin = getSolarPanelSkinBitmaps();
      const hazardSkin = getHazardStripeSkinBitmaps();

      // Central industrial hull section
      const hullMat = new THREE.MeshStandardMaterial({
        color: 0xd8e2ee,
        map: derelictHullSkin.map,
        bumpMap: derelictHullSkin.bumpMap,
        bumpScale: 0.85,
        roughnessMap: derelictHullSkin.roughnessMap,
        roughness: 0.65,
        metalness: 0.78,
      });
      const mainHull = new THREE.Mesh(new THREE.BoxGeometry(56, 40, 24), hullMat);
      group.add(mainHull);

      // Structural transverse hull ribs wrapping central and secondary hull
      const derelictRibMat = new THREE.MeshStandardMaterial({
        color: 0xd8e2ee,
        map: derelictHullSkin.map,
        bumpMap: derelictHullSkin.bumpMap,
        bumpScale: 0.75,
        roughnessMap: derelictHullSkin.roughnessMap,
        roughness: 0.55,
        metalness: 0.8,
      });
      for (let rx = -20; rx <= 20; rx += 10) {
        const hRib = new THREE.Mesh(new THREE.BoxGeometry(2.0, 42, 26), derelictRibMat);
        hRib.position.set(rx, 0, 0);
        group.add(hRib);
      }
      for (let srx = -10; srx <= 10; srx += 10) {
        const sRib = new THREE.Mesh(new THREE.BoxGeometry(1.6, 30, 22), derelictRibMat);
        sRib.position.set(-38 + srx, 12, -4);
        sRib.rotation.set(0.1, 0.15, -0.2);
        group.add(sRib);
      }

      // Secondary broken cargo/habitat section
      const secondaryHull = new THREE.Mesh(
        new THREE.BoxGeometry(32, 28, 20),
        new THREE.MeshStandardMaterial({
          color: 0xe2e8f0,
          map: derelictHullSkin.map,
          bumpMap: derelictHullSkin.bumpMap,
          bumpScale: 0.8,
          roughnessMap: derelictHullSkin.roughnessMap,
          roughness: 0.72,
          metalness: 0.6,
        })
      );
      secondaryHull.position.set(-38, 12, -4);
      secondaryHull.rotation.set(0.1, 0.15, -0.2);
      group.add(secondaryHull);

      // Reinforced docking girder trusses connecting the sections
      const trussMat = new THREE.MeshStandardMaterial({
        color: 0xd8e2ee,
        map: derelictGreebleSkin.map,
        bumpMap: derelictGreebleSkin.bumpMap,
        bumpScale: 0.7,
        roughnessMap: derelictGreebleSkin.roughnessMap,
        roughness: 0.55,
        metalness: 0.8,
      });
      for (const tz of [-6, 6]) {
        const truss = new THREE.Mesh(new THREE.BoxGeometry(18, 3, 3), trussMat);
        truss.position.set(-23, 10, tz);
        group.add(truss);
      }

      // 2. 4 amber-striped cylindrical ordnance canister racks
      const rackPositions = [
        [18, -22, 6],
        [18, -22, -6],
        [-18, -22, 6],
        [-18, -22, -6],
      ];
      const canisterMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        map: derelictNozzleSkin.map,
        bumpMap: derelictNozzleSkin.bumpMap,
        bumpScale: 0.6,
        roughnessMap: derelictNozzleSkin.roughnessMap,
        roughness: 0.45,
        metalness: 0.75,
      });
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: hazardSkin.map,
        bumpMap: hazardSkin.bumpMap,
        bumpScale: 0.5,
        emissive: 0xf59e0b,
        emissiveMap: hazardSkin.map,
        emissiveIntensity: 0.8,
        roughness: 0.35,
        metalness: 0.8,
      });

      for (const [rx, ry, rz] of rackPositions) {
        const canister = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 18, 12), canisterMat);
        canister.rotateX(Math.PI / 2);
        canister.position.set(rx, ry, rz);

        // Amber warning stripe ring
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 4.0, 12), stripeMat);
        stripe.position.set(0, 0, 0);
        canister.add(stripe);

        group.add(canister);
      }

      // 3. 2 solar / radiator truss wing paddles (BoxGeometry)
      const paddleMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        map: solarSkin.map,
        bumpMap: solarSkin.bumpMap,
        bumpScale: 0.65,
        roughnessMap: solarSkin.roughnessMap,
        emissive: 0x0f172a,
        roughness: 0.25,
        metalness: 0.9,
      });
      const paddlePort = new THREE.Mesh(new THREE.BoxGeometry(20, 48, 1.2), paddleMat);
      paddlePort.position.set(0, 46, 0);
      group.add(paddlePort);

      const paddleStbd = new THREE.Mesh(new THREE.BoxGeometry(20, 48, 1.2), paddleMat);
      paddleStbd.position.set(0, -46, 0);
      group.add(paddleStbd);

      // Glowing amber docking guide beacons
      const guideMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
      for (const gx of [-24, 24]) {
        for (const gy of [-16, 16]) {
          const guide = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 8), guideMat);
          guide.position.set(gx, gy, 13);
          group.add(guide);
        }
      }

      // Rotating Docking Ring (TorusGeometry)
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(32, 3.5, 16, 32),
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: hazardSkin.map,
          bumpMap: hazardSkin.bumpMap,
          bumpScale: 0.6,
          roughness: 0.5,
          metalness: 0.65,
        })
      );
      // Docking ring perimeter navigation lights (alternating amber / cyan)
      const ringLightAmberMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const ringLightCyanMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
      for (let i = 0; i < 8; i++) {
        const rAngle = (i / 8) * Math.PI * 2;
        const rlx = Math.cos(rAngle) * 32;
        const rly = Math.sin(rAngle) * 32;
        const rLight = new THREE.Mesh(new THREE.SphereGeometry(1.0, 8, 8), (i % 2 === 0) ? ringLightAmberMat : ringLightCyanMat);
        rLight.position.set(rlx, rly, 3.2);
        ring.add(rLight);
      }
      group.add(ring);
      group.userData.ring = ring;

      // 80m Tractor Range Ring
      const tractorRing = new THREE.Mesh(
        new THREE.RingGeometry(78, 80, 64),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
      );
      group.add(tractorRing);

      this.derelictMesh = group;
      this.scene.add(this.derelictMesh);
    }

    const dx = derelict.pos?.x ?? derelict.x ?? 0;
    const dy = -(derelict.pos?.y ?? derelict.y ?? 0);
    const dz = derelict.pos?.z ?? derelict.z ?? 0;
    this.derelictMesh.position.set(dx, dy, dz);

    if (this.derelictMesh.userData.ring) {
      this.derelictMesh.userData.ring.rotation.z += dt * 0.4;
    }
  }

  /**
   * Syncs 3D Starships (Alpha & Omega), barrel roll rotation, RCS, plumes, radiators, shields & reticles.
   */
  syncShips3D(ships = {}, options = {}, dt = 0.016) {
    if (!ships) return;

    const cameraMode = options?.cameraMode || 'spectator';
    const myTeam = options?.myShipTeam || options?.team || 'alpha';

    for (const [team, ship] of Object.entries(ships)) {
      if (!ship) continue;
      let mesh = this.shipMeshes.get(team);

      if (!mesh || mesh.userData.hullClass !== (ship.hullClass || 'frigate')) {
        if (mesh) this.scene.remove(mesh);
        mesh = this.createShipMesh3D(ship.hullClass || 'frigate', team);
        mesh.userData.hullClass = ship.hullClass || 'frigate';
        this.shipMeshes.set(team, mesh);
        this.scene.add(mesh);
      }

      if (ship.destroyed) {
        mesh.visible = false;
        if (mesh.dampeningAuraMesh) mesh.dampeningAuraMesh.visible = false;
        const glowMats = mesh.userData?.hullGlowMaterials || mesh.hullRollGroup?.userData?.hullGlowMaterials;
        if (glowMats) {
          for (const entry of glowMats) {
            if (entry.mat && entry.mat.emissive) {
              entry.mat.emissive.setHex(entry.baseColor);
              entry.mat.emissiveIntensity = entry.baseIntensity;
            }
          }
        }
        if (!this.explodedShips.has(team)) {
          this.triggerShipExplosion3D(team, ship.pos, ship.hullClass || 'frigate', team);
        }
        continue;
      }
      this.explodedShips.delete(team);

      // State transitions for Cherenkov flashes
      const shipKey = ship.team || team;
      const prevState = this._shipHyperspaceStates ? this._shipHyperspaceStates.get(shipKey) : undefined;
      const currState = ship.hyperspace?.state;
      if (prevState !== currState) {
        if (currState === 'jumping') {
          this.spawnWarpFlash(ship.pos, 0x7dd3fc);
        } else if (currState === 'rebooting' && prevState === 'jumping') {
          this.spawnWarpFlash(ship.pos, 0x38bdf8);
        }
        if (this._shipHyperspaceStates) {
          this._shipHyperspaceStates.set(shipKey, currState);
        }
      }

      // 1. Position & Heading in 3D: (x, -y, z), rotation.z = -ship.angle, rotation.y = -ship.pitch
      mesh.position.set(ship.pos?.x || 0, -(ship.pos?.y || 0), ship.pos?.z || 0);
      mesh.rotation.order = 'ZYX';
      mesh.rotation.z = -(ship.angle || 0);
      mesh.rotation.y = -(ship.pitch || 0);

      const angle = ship.angle || 0;
      const pitch = ship.pitch || 0;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const F3 = new THREE.Vector3(cosA * cosP, -sinA * cosP, sinP);

      if (ship.hyperspace?.state === 'jumping') {
        const jt = ship.hyperspace.jumpTimer ?? 0;
        if (jt < 0.40) {
          const p = jt / 0.40;
          mesh.scale.set(1 + p * 6.5, Math.max(0.35, 1 - p * 0.45), Math.max(0.35, 1 - p * 0.45));
          mesh.position.addScaledVector(F3, p * p * 1800);
          mesh.visible = true;
        } else {
          mesh.visible = false;
        }
      } else if (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 0.45) {
        const rt = ship.hyperspace.rebootTimer ?? 0;
        const u = Math.max(0, 1 - rt / 0.45);
        mesh.visible = true;
        mesh.scale.set(1 + u * u * 5.0, Math.max(0.5, 1 - u * 0.3), Math.max(0.5, 1 - u * 0.3));
      } else {
        mesh.scale.set(1, 1, 1);
        mesh.visible = !ship.destroyed;
      }

      // 2. True 3D Barrel Roll on hullRollGroup around longitudinal X-axis
      const rollAngle = ship.rollAngle !== undefined
        ? ship.rollAngle
        : ((ship.rollState || 0) * Math.PI);
      mesh.hullRollGroup.rotation.order = 'ZYX';
      mesh.hullRollGroup.rotation.x = rollAngle;

      // 3. Turret & Heavy Railgun Rotation
      if (mesh.turretGroup) {
        const turretAngle = ship.weapons?.turretAngle !== undefined ? ship.weapons.turretAngle : (ship.turretAngle !== undefined ? ship.turretAngle : (ship.angle || 0));
        const turretPitch = ship.weapons?.turretPitch !== undefined ? ship.weapons.turretPitch : (ship.pitch || 0);
        mesh.turretGroup.rotation.order = 'ZYX';
        mesh.turretGroup.rotation.z = -(turretAngle - (ship.angle || 0));
        mesh.turretGroup.rotation.y = -(turretPitch - (ship.pitch || 0));
      }
      if (mesh.railgunGroup) {
        const railgunAngle = ship.weapons?.railgunAngle ?? ship.weapons?.turretAngle ?? ship.angle ?? 0;
        const railgunPitch = ship.weapons?.railgunPitch ?? ship.weapons?.turretPitch ?? ship.pitch ?? 0;
        mesh.railgunGroup.rotation.order = 'ZYX';
        mesh.railgunGroup.rotation.z = -(railgunAngle - (ship.angle || 0));
        mesh.railgunGroup.rotation.y = -(railgunPitch - (ship.pitch || 0));
      }

      // 4. RCS Pods Plume Visibility
      const thrusters = ship.thrusters || {};
      if (mesh.rcsPods) {
        for (const [podId, pod] of mesh.rcsPods.entries()) {
          const th = thrusters[podId];
          if (th && (th.isFiring || (th.throttle && th.throttle > 0))) {
            pod.plume.visible = true;
            const s = 1.0 + Math.random() * 0.4;
            pod.plume.scale.set(s, s, s);
          } else {
            pod.plume.visible = false;
          }
        }
      }

      // 5. Main Drive Engine Gimbal Articulation, Plasma Plume & Dynamic Engine PointLight
      const gimbalPivot = mesh.userData.gimbalPivotGroup || mesh.gimbalPivotGroup;
      if (gimbalPivot) {
        const gimbalYaw = ship.mainDrive?.gimbalYaw || 0;
        const gimbalPitch = ship.mainDrive?.gimbalPitch || 0;
        gimbalPivot.rotation.order = 'ZYX';
        gimbalPivot.rotation.z = gimbalYaw;
        gimbalPivot.rotation.y = gimbalPitch;
      }

      const throttle = ship.mainDrive?.throttle || (ship.mainDrive?.isFiring ? 1.0 : 0);
      if (mesh.drivePlumeGroup) {
        if (throttle > 0.01) {
          mesh.drivePlumeGroup.visible = true;
          mesh.drivePlumeGroup.scale.set(throttle * (1.0 + Math.random() * 0.2), 1, 1);
          if (mesh.engineLight) mesh.engineLight.intensity = throttle * 2.5;
        } else {
          mesh.drivePlumeGroup.visible = false;
          if (mesh.engineLight) mesh.engineLight.intensity = 0;
        }
      }

      // 6. Glowing Radiator Fin Arrays (emissive ramp with weapon heat)
      const heat = ship.weapons?.heat || 0;
      const maxHeat = ship.weapons?.maxHeat || 100;
      const heatRatio = Math.min(1.0, heat / maxHeat);
      if (mesh.radiatorMaterial) {
        if (heatRatio > 0.7) {
          mesh.radiatorMaterial.emissive.setHex(0xffffff);
          mesh.radiatorMaterial.emissiveIntensity = 2.0 + (heatRatio - 0.7) * 4.0;
        } else if (heatRatio > 0.3) {
          mesh.radiatorMaterial.emissive.setHex(0xf97316);
          mesh.radiatorMaterial.emissiveIntensity = heatRatio * 2.2;
        } else if (heatRatio > 0.05) {
          mesh.radiatorMaterial.emissive.setHex(0x451a03);
          mesh.radiatorMaterial.emissiveIntensity = heatRatio * 1.5;
        } else {
          mesh.radiatorMaterial.emissive.setHex(0x000000);
          mesh.radiatorMaterial.emissiveIntensity = 0;
        }
      }

      // 7. 4-Quadrant Shield Opacity
      const shields = ship.shields || { hp: { fore: 100, aft: 100, port: 100, starboard: 100 } };
      const maxHp = shields.maxHp || { fore: 100, aft: 100, port: 100, starboard: 100 };
      const quads = mesh.shieldQuads || {};
      const shipTeam = ship.team || team;
      const isOwnShipInPov = (cameraMode === 'helm_pov' || cameraMode === 'weapons_pov') && shipTeam === myTeam;

      if (mesh.hullRollGroup && Array.isArray(mesh.hullRollGroup.children)) {
        for (const child of mesh.hullRollGroup.children) {
          if (child === mesh.shieldGroup) {
            child.visible = true;
          } else {
            child.visible = !isOwnShipInPov;
          }
        }
      }

      for (const [key, qObj] of Object.entries(quads)) {
        const isOnline = ship.shields?.online
          ? ship.shields.online[key] !== false
          : !(ship.hyperspace?.state === 'jumping' || (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 7.0));
        const hp = isOnline ? (shields.hp ? (shields.hp[key] || 0) : 0) : 0;
        const max = maxHp[key] || 100;
        const hpRatio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;

        if (qObj.surface && qObj.surface.material) {
          qObj.surface.material.side = isOwnShipInPov ? THREE.DoubleSide : THREE.FrontSide;
        }

        if (!isOnline || hp <= 0) {
          qObj.group.visible = false;
          qObj.surface.material.opacity = 0;
          qObj.wire.material.opacity = 0;
        } else {
          qObj.group.visible = true;
          if (isOwnShipInPov) {
            qObj.surface.material.opacity = hpRatio * 0.03;
            qObj.wire.material.opacity = hpRatio * 0.08;
          } else {
            qObj.surface.material.opacity = hpRatio * 0.10;
            qObj.wire.material.opacity = hpRatio * 0.16;
          }
        }
      }

      // 8. Rotating Radar Dish & Nav Strobe Animations
      if (mesh.userData.radarDish) {
        mesh.userData.radarDish.rotation.z += dt * 2.0;
      }
      if (mesh.userData.commsDish) {
        mesh.userData.commsDish.rotation.z += dt * 1.0;
      }
      if (mesh.userData.navStrobeMat) {
        const strobePulse = 0.2 + 0.8 * Math.pow(Math.max(0, Math.sin(this.animTime * Math.PI * 2)), 6);
        mesh.userData.navStrobeMat.opacity = strobePulse;
      }

      // 9. Edge Dampening Field Amber-Gold Hull Glow & Translucent Aura
      const dampFactor = Math.max(0, Math.min(1, Number(ship.dampeningFactor ?? (ship.inDampeningField ? 1 : 0)) || 0));
      const isDampeningActive = dampFactor > 0 && mesh.visible && !(ship.hyperspace?.state === 'jumping' && (ship.hyperspace.jumpProgress ?? 0) >= 0.4);
      const pulse = 0.85 + 0.15 * Math.sin((this.animTime || 0) * 5.0);

      const glowMaterials = mesh.userData?.hullGlowMaterials || mesh.hullRollGroup?.userData?.hullGlowMaterials;
      if (glowMaterials) {
        for (const entry of glowMaterials) {
          if (entry.mat && entry.mat.emissive) {
            if (isDampeningActive) {
              entry.mat.emissive.setHex(0xf59e0b);
              entry.mat.emissiveIntensity = (entry.baseIntensity || 0) + dampFactor * 0.95 * pulse;
            } else {
              entry.mat.emissive.setHex(entry.baseColor);
              entry.mat.emissiveIntensity = entry.baseIntensity;
            }
          }
        }
      }

      const auraMesh = mesh.dampeningAuraMesh || mesh.hullRollGroup?.dampeningAuraMesh;
      if (auraMesh) {
        auraMesh.rotation.order = 'ZYX';
        auraMesh.rotation.x = rollAngle;
        auraMesh.visible = isDampeningActive;
        if (auraMesh.material) {
          const auraExtOpacity = 0.28 * dampFactor * pulse;
          const auraPovOpacity = 0.10 * dampFactor * pulse;
          auraMesh.userData = auraMesh.userData || {};
          auraMesh.userData.externalOpacity = auraExtOpacity;
          auraMesh.userData.povOpacity = auraPovOpacity;
          auraMesh.material.side = isOwnShipInPov ? THREE.BackSide : THREE.FrontSide;
          auraMesh.material.opacity = isOwnShipInPov ? auraPovOpacity : auraExtOpacity;
        }
      }
    }
  }

  /**
   * Syncs 3D Ballistic Projectiles (Lasers, Railguns, Torpedoes, Flak).
   */
  syncProjectiles3D(projectiles = [], dt = 0.016) {
    if (!projectiles) return;

    const activeIds = new Set();
    for (let i = 0; i < projectiles.length; i++) {
      const proj = projectiles[i];
      const id = proj.id || `proj_${i}`;
      activeIds.add(id);
      let mesh = this.projectileMeshes.get(id);

      if (mesh && mesh.userData.projType && proj.type && mesh.userData.projType !== proj.type) {
        this.scene.remove(mesh);
        this.projectileMeshes.delete(id);
        mesh = null;
      } else if (mesh && proj.type === 'torpedo' && mesh.userData.torpedoType !== proj.torpedoType) {
        this.scene.remove(mesh);
        this.projectileMeshes.delete(id);
        mesh = null;
      }

      if (!mesh) {
        if (proj.type === 'laser') {
          const group = new THREE.Group();
          const coreGeo = new THREE.CylinderGeometry(1.0, 1.0, 28, 8);
          coreGeo.rotateZ(Math.PI / 2);
          const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
          const coreMesh = new THREE.Mesh(coreGeo, coreMat);
          group.add(coreMesh);

          const glowGeo = new THREE.CylinderGeometry(2.5, 2.5, 32, 8);
          glowGeo.rotateZ(Math.PI / 2);
          const glowMat = new THREE.MeshBasicMaterial({
            color: 0x38bdf8,
            transparent: true,
            opacity: 0.65,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const glowMesh = new THREE.Mesh(glowGeo, glowMat);
          group.add(glowMesh);
          mesh = group;
        } else if (proj.type === 'railgun') {
          const group = new THREE.Group();
          const radius = proj.radius || 6;

          // High-density spherical core
          const coreGeo = new THREE.SphereGeometry(radius, 16, 16);
          const coreMat = new THREE.MeshBasicMaterial({ color: 0xc084fc });
          const coreMesh = new THREE.Mesh(coreGeo, coreMat);
          group.add(coreMesh);

          // Outer plasma halo sphere
          const haloGeo = new THREE.SphereGeometry(radius * 1.45, 16, 16);
          const haloMat = new THREE.MeshBasicMaterial({
            color: 0x818cf8,
            transparent: true,
            opacity: 0.5,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const haloMesh = new THREE.Mesh(haloGeo, haloMat);
          group.add(haloMesh);

          mesh = group;
        } else if (proj.type === 'torpedo') {
          const group = new THREE.Group();
          const warheadColor = proj.torpedoType === 'emp_torpedoes'
            ? 0x38bdf8
            : (proj.torpedoType === 'swarm_missiles' ? 0xfbbf24 : 0xf43f5e);

          const torpSkin = getTorpedoSkinBitmaps();
          const bodyGeo = new THREE.CylinderGeometry(2.4, 2.4, 16, 8);
          bodyGeo.rotateZ(Math.PI / 2);
          const bodyMat = new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            map: torpSkin.map,
            bumpMap: torpSkin.bumpMap,
            bumpScale: 0.5,
            roughnessMap: torpSkin.roughnessMap,
            roughness: 0.45,
            metalness: 0.75,
          });
          const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
          group.add(bodyMesh);

          const noseGeo = new THREE.ConeGeometry(2.4, 6, 8);
          noseGeo.rotateZ(-Math.PI / 2);
          const noseMat = new THREE.MeshBasicMaterial({ color: warheadColor });
          const noseMesh = new THREE.Mesh(noseGeo, noseMat);
          noseMesh.position.x = 11;
          group.add(noseMesh);

          const finGeo = new THREE.BoxGeometry(4, 7, 0.4);
          const finMat = new THREE.MeshBasicMaterial({ color: 0xd8e2ee, map: torpSkin.map });
          const fin1 = new THREE.Mesh(finGeo, finMat);
          fin1.position.x = -6;
          group.add(fin1);
          const fin2 = new THREE.Mesh(finGeo, finMat);
          fin2.position.x = -6;
          fin2.rotation.x = Math.PI / 2;
          group.add(fin2);

          const exhaustGeo = new THREE.ConeGeometry(1.8, 5, 8);
          exhaustGeo.rotateZ(Math.PI / 2);
          const exhaustMat = new THREE.MeshBasicMaterial({
            color: warheadColor,
            transparent: true,
            opacity: 0.85,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          });
          const exhaustMesh = new THREE.Mesh(exhaustGeo, exhaustMat);
          exhaustMesh.position.x = -10.5;
          group.add(exhaustMesh);

          group.userData.torpedoType = proj.torpedoType;
          mesh = group;
        } else {
          mesh = new THREE.Mesh(
            new THREE.SphereGeometry(proj.radius || 30, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xf43f5e, wireframe: true, transparent: true, opacity: 0.7 })
          );
        }

        mesh.userData.projType = proj.type;
        this.projectileMeshes.set(id, mesh);
        this.scene.add(mesh);
      }

      const px = proj.pos?.x ?? proj.x ?? 0;
      const py = -(proj.pos?.y ?? proj.y ?? 0);
      const pz = proj.pos?.z ?? proj.z ?? 0;
      mesh.position.set(px, py, pz);

      const vx = proj.vel?.x ?? proj.vx ?? 0;
      const vy = -(proj.vel?.y ?? proj.vy ?? 0);
      const vz = proj.vel?.z ?? proj.vz ?? 0;
      const vh = Math.hypot(vx, vy);
      mesh.rotation.order = 'ZYX';
      mesh.rotation.z = Math.atan2(vy, vx);
      mesh.rotation.y = -Math.atan2(vz, Math.max(1e-4, vh));
    }

    for (const [id, mesh] of this.projectileMeshes.entries()) {
      if (!activeIds.has(id)) {
        this.scene.remove(mesh);
        this.projectileMeshes.delete(id);
      }
    }
  }

  /**
   * Triggers an authoritative 3D ship destruction explosion with core fireball,
   * shockwave rings, dynamic point light, and 24 tumbling wreckage shards.
   */
  triggerShipExplosion3D(shipId, pos, hullClass = 'frigate', team = 'alpha') {
    if (this.explodedShips.has(shipId)) return;
    this.explodedShips.add(shipId);

    const scale = hullClass === 'dreadnought' ? 1.45 : (hullClass === 'corvette' ? 0.75 : 1.0);
    const teamColorHex = (team === 'omega') ? 0xf43f5e : 0x38bdf8;

    const group = new THREE.Group();
    group.name = `explosion_${shipId}`;
    group.position.set(pos?.x || 0, -(pos?.y || 0), pos?.z || 0);

    // 1. Blast core (white-hot -> orange glow)
    const coreGeo = new THREE.SphereGeometry(12 * scale, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    // 2. Outer fireball (amber/orange)
    const fireGeo = new THREE.SphereGeometry(24 * scale, 16, 16);
    const fireMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const fireball = new THREE.Mesh(fireGeo, fireMat);
    group.add(fireball);

    // 3. Dynamic PointLight
    const light = new THREE.PointLight(0xfbbf24, 18 * scale, 900 * scale);
    group.add(light);

    // 4. Dual expanding shockwave rings
    const ringGeo1 = new THREE.TorusGeometry(12 * scale, 1.5 * scale, 8, 32);
    const ringMat1 = new THREE.MeshBasicMaterial({
      color: 0xfef08a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const ring1 = new THREE.Mesh(ringGeo1, ringMat1);
    group.add(ring1);

    const ringGeo2 = new THREE.TorusGeometry(14 * scale, 1.5 * scale, 8, 32);
    const ringMat2 = new THREE.MeshBasicMaterial({
      color: teamColorHex,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const ring2 = new THREE.Mesh(ringGeo2, ringMat2);
    ring2.rotation.x = Math.PI / 3;
    ring2.rotation.y = Math.PI / 4;
    group.add(ring2);

    // 5. 24 tumbling 3D wreckage shards & glowing embers
    const debrisSkin = getDebrisSkinBitmaps();
    const fragments = [];
    for (let i = 0; i < 24; i++) {
      let fragMesh;
      const baseOpacity = 0.95;
      if (i % 2 === 0) {
        // Alloy plate
        const plateGeo = new THREE.BoxGeometry(4 * scale, 2.5 * scale, 0.8 * scale);
        const plateMat = new THREE.MeshBasicMaterial({
          color: 0xe2e8f0,
          map: debrisSkin.map,
          transparent: true,
          opacity: baseOpacity,
        });
        fragMesh = new THREE.Mesh(plateGeo, plateMat);
      } else {
        // Glowing spark / ember
        const sparkGeo = new THREE.OctahedronGeometry(2 * scale);
        const sparkColor = (i % 4 === 1) ? 0xfbbf24 : 0xf97316;
        const sparkMat = new THREE.MeshBasicMaterial({
          color: sparkColor,
          transparent: true,
          opacity: baseOpacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        fragMesh = new THREE.Mesh(sparkGeo, sparkMat);
      }

      const speed = (60 + Math.random() * 180) * scale;
      const theta = (i / 24) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const phi = (Math.random() - 0.5) * Math.PI;
      const vx = speed * Math.cos(phi) * Math.cos(theta);
      const vy = speed * Math.cos(phi) * Math.sin(theta);
      const vz = speed * Math.sin(phi);
      const rx = (Math.random() - 0.5) * 6;
      const ry = (Math.random() - 0.5) * 6;
      const rz = (Math.random() - 0.5) * 6;

      group.add(fragMesh);
      fragments.push({ mesh: fragMesh, vx, vy, vz, rx, ry, rz, baseOpacity });
    }

    this.scene.add(group);
    this.explosions3D.push({
      id: shipId,
      group,
      core,
      fireball,
      light,
      rings: [ring1, ring2],
      fragments,
      life: 0,
      maxLife: 3.5,
      scale,
    });

    // 2D fallback burst particles
    const x = pos?.x || 0;
    const y = -(pos?.y || 0);
    for (let p = 0; p < 36; p++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = 50 + Math.random() * 200;
      this.fxParticles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        life: 1.2 + Math.random() * 1.5,
        maxLife: 2.7,
        color: p % 2 === 0 ? '#fbbf24' : '#f97316',
      });
    }
  }

  /**
   * Syncs 3D Dynamic Particle FX from instantaneous combat events and advances
   * all active explosions and debris in 3D scene.
   */
  syncParticles3D(events = [], dt = 0.016, slowMoActive = false) {
    const effDt = slowMoActive ? dt * 0.55 : dt;

    // 1. Process new combat events
    if (events && events.length > 0) {
      for (const ev of events) {
        if (!ev) continue;

        if (ev.type === 'killing_blow') {
          const victimId = ev.victimId || ev.shipId || 'unknown';
          const team = ev.victimTeam || (victimId.includes('omega') ? 'omega' : 'alpha');
          this.triggerShipExplosion3D(victimId, ev.pos, ev.hullClass || 'frigate', team);
          continue;
        }

        const hitEventTypes = [
          'torpedo_hit',
          'railgun_hit',
          'laser_hit',
          'asteroid_hit',
          'asteroid_destroyed',
          'flak_burst',
          'tether_mine_detonated',
          'mine_detonation',
          'collision',
        ];

        if (hitEventTypes.includes(ev.type)) {
          let count = 8;
          let colors = [0xfbbf24, 0xf97316];
          let minSpd = 60;
          let maxSpd = 180;
          let minLife = 0.4;
          let maxLife = 0.8;
          let particleType = 'spark';

          if (ev.type === 'torpedo_hit') {
            count = 10;
            colors = [0xf97316, 0xfbbf24, 0xf43f5e];
            minSpd = 80;
            maxSpd = 240;
            minLife = 0.5;
            maxLife = 1.0;
          } else if (ev.type === 'railgun_hit') {
            count = 8;
            colors = [0xc084fc, 0x818cf8, 0xffffff];
            minSpd = 120;
            maxSpd = 300;
            minLife = 0.3;
            maxLife = 0.7;
          } else if (ev.type === 'laser_hit') {
            count = 6;
            colors = [0x38bdf8, 0xffffff];
            minSpd = 60;
            maxSpd = 180;
            minLife = 0.3;
            maxLife = 0.6;
          } else if (ev.type === 'asteroid_hit') {
            count = 6;
            colors = [0x94a3b8, 0x64748b];
            minSpd = 40;
            maxSpd = 120;
            particleType = 'chunk';
            minLife = 0.4;
            maxLife = 0.8;
          } else if (ev.type === 'asteroid_destroyed') {
            count = 14;
            colors = [0x94a3b8, 0x64748b, 0xd97706];
            minSpd = 60;
            maxSpd = 240;
            particleType = 'chunk';
            minLife = 0.6;
            maxLife = 1.2;
          } else if (ev.type === 'flak_burst') {
            count = 10;
            colors = [0xf43f5e, 0xfbbf24];
            minSpd = 80;
            maxSpd = 200;
            minLife = 0.4;
            maxLife = 0.8;
          } else if (ev.type === 'tether_mine_detonated' || ev.type === 'mine_detonation') {
            count = 10;
            colors = [0x06b6d4, 0xfbbf24, 0x38bdf8];
            minSpd = 90;
            maxSpd = 240;
            minLife = 0.5;
            maxLife = 1.0;
          } else if (ev.type === 'collision') {
            count = 8;
            colors = [0xfef08a, 0xf97316];
            minSpd = 50;
            maxSpd = 160;
            minLife = 0.4;
            maxLife = 0.8;
          }

          const px = ev.pos?.x ?? 0;
          const py = -(ev.pos?.y ?? 0);
          const pz = ev.pos?.z ?? 0;

          for (let p = 0; p < count; p++) {
            const color = colors[p % colors.length];
            const size = 1.0 + Math.random() * 2.0;
            let geo;
            let mat;
            if (particleType === 'chunk') {
              geo = new THREE.BoxGeometry(size, size, size);
              mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
            } else {
              geo = new THREE.OctahedronGeometry(size);
              mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.95,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
              });
            }
            const pMesh = new THREE.Mesh(geo, mat);
            pMesh.position.set(px, py, pz);

            const spd = minSpd + Math.random() * (maxSpd - minSpd);
            const theta = Math.random() * Math.PI * 2;
            const phi = (Math.random() - 0.5) * Math.PI;
            const vx = spd * Math.cos(phi) * Math.cos(theta);
            const vy = spd * Math.cos(phi) * Math.sin(theta);
            const vz = spd * Math.sin(phi);
            const rx = (Math.random() - 0.5) * 8;
            const ry = (Math.random() - 0.5) * 8;
            const rz = (Math.random() - 0.5) * 8;
            const pLife = minLife + Math.random() * (maxLife - minLife);

            this.scene.add(pMesh);
            this.particles3D.push({
              mesh: pMesh,
              vx, vy, vz,
              rx, ry, rz,
              life: 0,
              maxLife: pLife,
              baseOpacity: mat.opacity,
            });
          }

          // Cap active 3D particles at 150
          while (this.particles3D.length > 150) {
            const oldest = this.particles3D.shift();
            if (oldest && oldest.mesh) {
              this.scene.remove(oldest.mesh);
            }
          }

          // 2D fallback particles
          for (let p = 0; p < Math.min(8, count); p++) {
            this.fxParticles.push({
              x: px, y: py,
              vx: (Math.random() - 0.5) * 120,
              vy: (Math.random() - 0.5) * 120,
              life: 0.6,
              maxLife: 0.6,
              color: '#fbbf24',
            });
          }
        }
      }
    }

    // 2. Advance active 3D explosions
    const activeExplosions = [];
    for (const exp of this.explosions3D) {
      exp.life += effDt;
      if (exp.life >= exp.maxLife) {
        if (exp.group) this.scene.remove(exp.group);
        continue;
      }
      const progress = exp.life / exp.maxLife;
      if (exp.core) {
        const s = 1 + progress * 5 * exp.scale;
        exp.core.scale.set(s, s, s);
        if (exp.core.material) exp.core.material.opacity = Math.max(0, 1.0 - progress * 2.5);
      }
      if (exp.fireball) {
        const s = 1 + progress * 8 * exp.scale;
        exp.fireball.scale.set(s, s, s);
        if (exp.fireball.material) exp.fireball.material.opacity = Math.max(0, 0.9 * (1.0 - progress));
      }
      if (exp.light) {
        exp.light.intensity = Math.max(0, (18 * exp.scale) * (1.0 - progress));
      }
      if (exp.rings) {
        for (const ring of exp.rings) {
          const s = 1 + progress * 20 * exp.scale;
          ring.scale.set(s, s, s);
          if (ring.material) ring.material.opacity = Math.max(0, 0.85 * (1.0 - progress * 1.2));
        }
      }
      if (exp.fragments) {
        const drag = Math.pow(0.96, effDt * 60);
        for (const frag of exp.fragments) {
          frag.mesh.position.x += frag.vx * effDt;
          frag.mesh.position.y += frag.vy * effDt;
          frag.mesh.position.z += frag.vz * effDt;
          frag.mesh.rotation.x += frag.rx * effDt;
          frag.mesh.rotation.y += frag.ry * effDt;
          frag.mesh.rotation.z += frag.rz * effDt;
          frag.vx *= drag;
          frag.vy *= drag;
          frag.vz *= drag;
          if (frag.mesh.material && frag.mesh.material.transparent) {
            frag.mesh.material.opacity = Math.max(0, frag.baseOpacity * (1.0 - progress));
          }
        }
      }
      activeExplosions.push(exp);
    }
    this.explosions3D = activeExplosions;

    // 3. Advance active 3D particles
    const activeParticles = [];
    for (const p of this.particles3D) {
      p.life += effDt;
      if (p.life >= p.maxLife) {
        if (p.mesh) this.scene.remove(p.mesh);
        continue;
      }
      p.mesh.position.x += p.vx * effDt;
      p.mesh.position.y += p.vy * effDt;
      p.mesh.position.z += p.vz * effDt;
      p.mesh.rotation.x += p.rx * effDt;
      p.mesh.rotation.y += p.ry * effDt;
      p.mesh.rotation.z += p.rz * effDt;
      const progress = p.life / p.maxLife;
      if (p.mesh.material && p.mesh.material.transparent) {
        p.mesh.material.opacity = Math.max(0, p.baseOpacity * (1.0 - progress));
      }
      activeParticles.push(p);
    }
    this.particles3D = activeParticles;
  }

  /**
   * Main 60FPS render loop entrypoint.
   *
   * @param {object} snapshot - Complete authoritative game room snapshot
   * @param {object} [options={}] - Viewport and station options
   */
  render(snapshot, options = {}) {
    if (!snapshot) return;

    if (options && options.pos && !options.cameraPos) {
      options = {
        cameraPos: options.pos,
        myShipTeam: options.team,
        zoom: options.zoom || this.zoom,
      };
    }

    const isReplay = Boolean(snapshot.replayActive || (snapshot.replayFrame && snapshot.replayFrame.isReplay) || snapshot.isReplay);
    if ((isReplay && !this._wasReplayActive) || (!isReplay && this._wasReplayActive)) {
      this.resetBsgReplayCamera();
    }
    if (snapshot.state === 'lobby' || (typeof snapshot.tick === 'number' && this._lastSnapshotTick !== null && snapshot.tick < this._lastSnapshotTick) || (isReplay && !this._wasReplayActive)) {
      this.clearEffects3D();
    }
    this._wasReplayActive = isReplay;
    this._lastSnapshotTick = typeof snapshot.tick === 'number' ? snapshot.tick : this._lastSnapshotTick;

    const cameraMode = options.cameraMode || (isReplay ? 'bsg_replay' : 'spectator');
    if (cameraMode !== 'bsg_replay' && this.bsgReplayCam?.active) {
      this.resetBsgReplayCamera();
    }
    const myTeam = options.myShipTeam || options.team || 'alpha';
    const myShip = snapshot.ships ? snapshot.ships[myTeam] : null;

    const now = performance.now();
    const dt = options.dt !== undefined ? options.dt : Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.animTime += dt;

    let cameraPos = options.cameraPos || (myShip?.pos ? myShip.pos : this.cameraPos);
    const zoom = Math.max(0.02, Math.min(2.5, options.zoom || this.zoom));
    this.cameraPos = cameraPos;
    this.zoom = zoom;

    const sector = snapshot.sector || {};

    // 1. ALWAYS update the 3D Three.js Authoritative Scene Graph
    if (cameraMode === 'helm_pov' && myShip) {
      this.updateHelmCamera3D(myShip);
    } else if (cameraMode === 'weapons_pov' && myShip) {
      const gunnerAngle = options.gunnerWorldAngle ?? options.aimAngle ?? myShip.weapons?.turretAngle ?? myShip.turretAngle ?? myShip.angle ?? 0;
      this.updateWeaponsCamera3D(myShip, gunnerAngle, options.pitchOffset || 0, options.weaponsZoom ?? 1.0);
    } else if (cameraMode === 'bsg_replay') {
      this.updateBsgReplayCamera3D(snapshot, dt);
    } else {
      this.updateCamera3D(cameraPos, zoom, snapshot.slowMoActive);
    }

    if (!options.cameraPos && cameraMode === 'bsg_replay' && this.bsgReplayCam?.initialized) {
      cameraPos = { x: this.bsgReplayCam.lookAt.x, y: -this.bsgReplayCam.lookAt.y };
      this.cameraPos = cameraPos;
    }

    this.syncWarpFlashes3D(dt);
    this.updateWarpStreaks3D(myShip, cameraMode, dt);

    // External View < 4.0s Reboot Blackout check
    if (this.isExternalBlackoutActive(myShip, cameraMode)) {
      if (this.webglRenderer) {
        this.webglRenderer.setClearColor(0x02040a, 1.0);
        this.webglRenderer.clear();
        if (options.pipSlots && myShip) {
          this.renderMultiAnglePips3D(options.pipSlots, myShip);
        }
        return;
      }
      if (this.ctx) {
        this.renderFallback2D(snapshot, options, cameraPos, zoom, dt, cameraMode, myShip);
        return;
      }
    }

    this.syncArena3D(sector.arenaRadius || 5250);
    this.syncAsteroids3D(sector.asteroids, dt);
    this.syncGravityWells3D(sector.gravityWells, dt);
    this.syncNebulae3D(sector.ionNebulae, dt);
    this.syncDebrisAndMines3D(sector, snapshot.ships, dt);
    this.syncDerelict3D(sector.munitionsDerelict, snapshot.ships, dt);
    this.syncShips3D(snapshot.ships, options, dt);
    this.syncProjectiles3D(snapshot.projectiles, dt);
    this.syncParticles3D(snapshot.events, dt, Boolean(snapshot.slowMoActive));

    // 2. WebGL Mode: Real high-performance 3D rendering
    if (this.webglRenderer) {
      this.webglRenderer.render(this.scene, this.camera3d);
      if (options.pipSlots && myShip) {
        this.renderMultiAnglePips3D(options.pipSlots, myShip);
      }
      return;
    }

    // 3. Fallback / Test Mode (2D Canvas Context)
    if (this.ctx) {
      this.renderFallback2D(snapshot, options, cameraPos, zoom, dt, cameraMode, myShip);
    }
  }

  /**
   * Renders 3D-projected tactical wireframe/shaded polyhedral pass onto 2D canvas context.
   * Zero solar flare overlays and zero asteroid shadow code.
   */
  renderFallback2D(snapshot, options, cameraPos, zoom, dt, cameraMode = 'spectator', myShip = null) {
    if (!options?.cameraPos && cameraMode === 'bsg_replay' && this.bsgReplayCam?.initialized) {
      cameraPos = { x: this.bsgReplayCam.lookAt.x, y: -this.bsgReplayCam.lookAt.y };
    }
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;
    if (!ctx) return;

    // External View < 4.0s Reboot Blackout: dark void & skip all world/entity drawing
    if (this.isExternalBlackoutActive(myShip, cameraMode)) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#02040a';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      return;
    }

    // 1. Clear Deep Space Background
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, width, height);

    // 2. Parallax Distant Nebulae & Twinkling Stars
    this.drawParallaxStars(ctx, width, height, cameraPos, zoom);

    // 2D Warp Streaks during jumping for non-spectator
    if (cameraMode !== 'spectator' && myShip?.hyperspace?.state === 'jumping') {
      const jt = myShip.hyperspace.jumpTimer ?? 0;
      const tailScale = 0.5 + Math.min(1.0, jt / 2.2) * 1.5;
      const cx = width / 2;
      const cy = height / 2;
      const num2dStreaks = 80;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = 0; i < num2dStreaks; i++) {
        const angle = (i / num2dStreaks) * Math.PI * 2 + ((i * 17) % 11) * 0.05;
        const speed = 400 + ((i * 37) % 500);
        const dist = ((this.animTime * speed + i * 43) % (Math.max(width, height) * 0.85)) + 20;
        const len = (40 + ((i * 23) % 80)) * tailScale;
        const x1 = cx + Math.cos(angle) * dist;
        const y1 = cy + Math.sin(angle) * dist;
        const x2 = cx + Math.cos(angle) * (dist + len);
        const y2 = cy + Math.sin(angle) * (dist + len);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = (i % 3 === 0) ? 'rgba(255, 255, 255, 0.9)' : ((i % 3 === 1) ? 'rgba(125, 211, 252, 0.8)' : 'rgba(99, 102, 241, 0.7)');
        ctx.lineWidth = 1.5 + (i % 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 3. World Transformations
    ctx.save();
    ctx.translate(width / 2, height / 2);

    if (cameraMode === 'helm_pov' && myShip) {
      ctx.rotate(-myShip.angle - Math.PI / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-myShip.pos.x, -myShip.pos.y);
    } else if (cameraMode === 'weapons_pov' && myShip) {
      const gunnerAngle = options.gunnerWorldAngle ?? options.aimAngle ?? myShip.weapons?.turretAngle ?? myShip.turretAngle ?? myShip.angle ?? 0;
      const wZoom = Math.max(0.6, Math.min(5.0, options.weaponsZoom || zoom || 1));
      ctx.rotate(-gunnerAngle - Math.PI / 2);
      ctx.scale(wZoom, wZoom);
      ctx.translate(-myShip.pos.x, -myShip.pos.y);
    } else {
      ctx.scale(zoom, zoom);
      ctx.translate(-cameraPos.x, -cameraPos.y);
    }

    const sector = snapshot.sector || {};

    // 4. Arena Boundary
    this.drawArenaBoundary(ctx, sector.arenaRadius || 5250);

    // 5. Gravity Wells
    if (sector.gravityWells) {
      for (const well of sector.gravityWells) {
        this.drawGravityWell(ctx, well);
      }
    }

    // 6. Ion Storm Nebulae
    if (sector.ionNebulae) {
      for (const nebula of sector.ionNebulae) {
        this.drawIonNebula(ctx, nebula);
      }
    }

    // 7. Craggy Polyhedral Asteroids (Zero Shadows)
    if (sector.asteroids) {
      for (const ast of sector.asteroids) {
        if (ast.destroyed) continue;
        this.drawAsteroid(ctx, ast);
      }
    }

    // 8. Debris Fields & Chunks
    this.drawDebrisFieldsAndChunks(ctx, sector);

    // 9. Concealed Tether Mines
    if (sector.tetherMines) {
      for (const mine of sector.tetherMines) {
        this.drawTetherMine(ctx, mine, snapshot.ships);
      }
    }

    // 10. Munitions Derelict
    if (sector.munitionsDerelict) {
      this.drawMunitionsDerelict(ctx, sector.munitionsDerelict, snapshot.ships);
    }

    // 11. Ballistic Projectiles
    if (snapshot.projectiles) {
      for (const proj of snapshot.projectiles) {
        this.drawProjectile(ctx, proj);
      }
    }

    // 12. Dynamic Particles
    this.updateAndDrawParticles(ctx, dt, snapshot.events);

    // 13. Starships
    const isPovMode = cameraMode === 'helm_pov' || cameraMode === 'weapons_pov';
    if (snapshot.ships) {
      if (snapshot.ships.alpha) {
        this.drawShip(ctx, snapshot.ships.alpha, '#38bdf8', options.myShipTeam === 'alpha', isPovMode && options.myShipTeam === 'alpha');
      }
      if (snapshot.ships.omega) {
        this.drawShip(ctx, snapshot.ships.omega, '#f43f5e', options.myShipTeam === 'omega', isPovMode && options.myShipTeam === 'omega');
      }
    }

    // 14. Combat Lead Targeting Reticle
    if (options.showLeadReticle && options.myShipTeam && snapshot.ships) {
      const myShip = snapshot.ships[options.myShipTeam];
      if (myShip) {
        const lead = options.leadReticle || myShip.leadTarget;
        if (lead) {
          this.drawLeadReticle(ctx, myShip, lead);
        }
      }
    }

    ctx.restore();

    // 15. Screen-Space Overlays (Slow-Mo Kill Cam Chromatic Edge only — Zero Solar Flare)
    this.drawScreenSpaceHazardOverlays(ctx, width, height, snapshot.slowMoActive);
  }

  // ==========================================================================
  // PARALLAX BACKGROUND & SPACE DUST
  // ==========================================================================

  drawParallaxStars(ctx, width, height, cameraPos, zoom) {
    for (const neb of this.distantNebulae) {
      const px = width / 2 + (neb.x - cameraPos.x * 0.05) * zoom;
      const py = height / 2 + (neb.y - cameraPos.y * 0.05) * zoom;
      const pr = neb.radius * zoom;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, pr);
      grad.addColorStop(0, neb.color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const star of this.stars) {
      const sx = ((star.x - cameraPos.x * 0.15) % width + width) % width;
      const sy = ((star.y - cameraPos.y * 0.15) % height + height) % height;
      const twinkle = 0.4 + 0.6 * Math.sin(this.animTime * star.twinkleSpeed + star.twinklePhase);

      ctx.fillStyle = star.color;
      ctx.globalAlpha = Math.max(0.1, twinkle);
      ctx.beginPath();
      ctx.arc(sx, sy, star.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    ctx.fillStyle = '#94a3b8';
    for (const d of this.dustSpecks) {
      const dx = ((d.x - cameraPos.x * 0.4) % width + width) % width;
      const dy = ((d.y - cameraPos.y * 0.4) % height + height) % height;
      ctx.globalAlpha = d.alpha;
      ctx.fillRect(dx, dy, d.size, d.size);
    }
    ctx.globalAlpha = 1.0;
  }

  // ==========================================================================
  // ARENA & SECTOR CELESTIAL HAZARDS (FALLBACK 2D)
  // ==========================================================================

  drawArenaBoundary(ctx, radius) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.setLineDash([20, 15]);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, radius + 20, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.2)';
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();
  }

  drawGravityWell(ctx, well) {
    const x = well.pos?.x ?? well.x ?? 0;
    const y = well.pos?.y ?? well.y ?? 0;
    const pullRadius = well.pullRadius || 1200;
    const horizon = well.eventHorizonRadius || 45;

    ctx.save();
    ctx.translate(x, y);

    const ringCount = 4;
    for (let i = 1; i <= ringCount; i++) {
      const ringRadius = horizon + (pullRadius - horizon) * (i / ringCount);
      const pulse = Math.sin(this.animTime * 2.5 - i * 0.8) * 4;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius + pulse, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(192, 132, 252, ${0.12 - i * 0.02})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 18]);
      ctx.stroke();
    }

    ctx.rotate(-this.animTime * 0.8);
    for (let a = 0; a < 6; a++) {
      ctx.beginPath();
      const armAngle = (a / 6) * Math.PI * 2;
      ctx.moveTo(Math.cos(armAngle) * horizon, Math.sin(armAngle) * horizon);
      ctx.quadraticCurveTo(
        Math.cos(armAngle + 1.2) * (horizon * 2.5),
        Math.sin(armAngle + 1.2) * (horizon * 2.5),
        Math.cos(armAngle + 2.2) * (horizon * 4.5),
        Math.sin(armAngle + 2.2) * (horizon * 4.5)
      );
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.25)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, horizon, 0, Math.PI * 2);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#f3e8ff';
    ctx.shadowColor = '#c084fc';
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.restore();
  }

  drawIonNebula(ctx, nebula) {
    const x = nebula.pos?.x ?? nebula.x ?? 0;
    const y = nebula.pos?.y ?? nebula.y ?? 0;
    const radius = nebula.radius || 500;

    ctx.save();
    ctx.translate(x, y);

    const puffCount = 5;
    for (let p = 0; p < puffCount; p++) {
      const angle = (p / puffCount) * Math.PI * 2 + this.animTime * 0.15;
      const dist = radius * 0.35;
      const px = Math.cos(angle) * dist;
      const py = Math.sin(angle) * dist;
      const pRadius = radius * 0.75;

      const grad = ctx.createRadialGradient(px, py, 0, px, py, pRadius);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.14)');
      grad.addColorStop(0.5, 'rgba(147, 51, 234, 0.08)');
      grad.addColorStop(1, 'transparent');

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, pRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    if (Math.sin(this.animTime * 4.0 + (nebula.id?.charCodeAt(0) || 0)) > 0.4) {
      ctx.beginPath();
      let lx = (Math.sin(this.animTime * 3) - 0.5) * radius * 0.5;
      let ly = (Math.cos(this.animTime * 2) - 0.5) * radius * 0.5;
      ctx.moveTo(lx, ly);
      for (let s = 0; s < 4; s++) {
        lx += (Math.random() - 0.5) * 80;
        ly += (Math.random() - 0.5) * 80;
        ctx.lineTo(lx, ly);
      }
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.7)';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#38bdf8';
      ctx.shadowBlur = 12;
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Draws craggy faceted asteroid without solar flares or shadow cones.
   */
  drawAsteroid(ctx, ast) {
    const x = ast.pos?.x ?? ast.x ?? 0;
    const y = ast.pos?.y ?? ast.y ?? 0;
    const r = ast.radius || 100;

    ctx.save();
    ctx.translate(x, y);

    const astGrad = ctx.createLinearGradient(r * 0.5, -r * 0.5, -r * 0.5, r * 0.5);
    astGrad.addColorStop(0, '#475569');
    astGrad.addColorStop(0.6, '#1e293b');
    astGrad.addColorStop(1, '#0f172a');

    ctx.beginPath();
    if (ast.vertices && ast.vertices.length > 2) {
      const first = ast.vertices[0];
      ctx.moveTo(first.x - x, first.y - y);
      for (let i = 1; i < ast.vertices.length; i++) {
        ctx.lineTo(ast.vertices[i].x - x, ast.vertices[i].y - y);
      }
    } else {
      ctx.arc(0, 0, r, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fillStyle = astGrad;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#334155';
    ctx.stroke();

    // Procedural 2D fissures and impact craters
    const aSeed2d = hashStr(String(ast.id || `${Math.round(x)}_${Math.round(y)}`));
    const rng2d = createPrng(aSeed2d);

    const numFissures2d = 2 + Math.floor(rng2d() * 2);
    for (let f = 0; f < numFissures2d; f++) {
      const fAngle = rng2d() * Math.PI * 2;
      const startR = r * (0.1 + rng2d() * 0.25);
      const endR = r * (0.62 + rng2d() * 0.16);
      let cx = Math.cos(fAngle) * startR;
      let cy = Math.sin(fAngle) * startR;
      const dx = Math.cos(fAngle + (rng2d() - 0.5) * 0.5) * (endR - startR);
      const dy = Math.sin(fAngle + (rng2d() - 0.5) * 0.5) * (endR - startR);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let seg = 1; seg <= 3; seg++) {
        const t = seg / 3;
        const jx = (rng2d() - 0.5) * r * 0.14;
        const jy = (rng2d() - 0.5) * r * 0.14;
        cx = Math.cos(fAngle) * startR + dx * t + jx;
        cy = Math.sin(fAngle) * startR + dy * t + jy;
        ctx.lineTo(cx, cy);
        if (seg === 2 && rng2d() > 0.35) {
          // Branch fissure
          const bAng = fAngle + (rng2d() > 0.5 ? 0.65 : -0.65);
          const bLen = r * (0.14 + rng2d() * 0.12);
          ctx.lineTo(cx + Math.cos(bAng) * bLen, cy + Math.sin(bAng) * bLen);
          ctx.moveTo(cx, cy);
        }
      }
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.lineWidth = Math.max(1, r * 0.025);
      ctx.stroke();
    }

    const numCraters2d = 4 + Math.floor(rng2d() * 3);
    for (let c = 0; c < numCraters2d; c++) {
      const cAngle = rng2d() * Math.PI * 2;
      const cDist = r * (0.15 + rng2d() * 0.45);
      const crR = r * (0.09 + rng2d() * 0.13);
      const cx = Math.cos(cAngle) * cDist;
      const cy = Math.sin(cAngle) * cDist;

      // Crater pit shadow
      ctx.beginPath();
      ctx.arc(cx, cy, crR, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.48)';
      ctx.fill();

      // Sunlit raised crater rim
      ctx.beginPath();
      ctx.arc(cx, cy, crR, -Math.PI * 0.85, Math.PI * 0.15);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.42)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    if (ast.oreVeins) {
      for (const vein of ast.oreVeins) {
        ctx.save();
        ctx.rotate(vein.angle || 0);
        ctx.beginPath();
        const vDist = r * (vein.depth || 0.5);
        ctx.arc(vDist, 0, 5, 0, Math.PI * 2);

        if (vein.type === 'plasma_crystal') {
          ctx.fillStyle = '#c084fc';
          ctx.shadowColor = '#a855f7';
          ctx.shadowBlur = 8;
        } else if (vein.type === 'titanium') {
          ctx.fillStyle = '#7dd3fc';
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 8;
        } else {
          ctx.fillStyle = '#fbbf24';
          ctx.shadowColor = '#f59e0b';
          ctx.shadowBlur = 6;
        }
        ctx.fill();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // ==========================================================================
  // DEBRIS, MINES & DERELICT (FALLBACK 2D)
  // ==========================================================================

  drawDebrisFieldsAndChunks(ctx, sector) {
    if (sector.debrisFields) {
      for (const f of sector.debrisFields) {
        const fx = f.pos?.x ?? f.x ?? 0;
        const fy = f.pos?.y ?? f.y ?? 0;
        ctx.save();
        ctx.beginPath();
        ctx.arc(fx, fy, f.radius || 400, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.18)';
        ctx.setLineDash([8, 12]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      }
    }

    const chunks = sector.debrisChunks || [];
    for (const chunk of chunks) {
      const cx = chunk.pos?.x ?? chunk.x ?? 0;
      const cy = chunk.pos?.y ?? chunk.y ?? 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(chunk.angle || 0);

      ctx.beginPath();
      if (chunk.vertices && chunk.vertices.length > 2) {
        ctx.moveTo(chunk.vertices[0].x, chunk.vertices[0].y);
        for (let v = 1; v < chunk.vertices.length; v++) {
          ctx.lineTo(chunk.vertices[v].x, chunk.vertices[v].y);
        }
      } else {
        const cr = chunk.radius || 8;
        ctx.rect(-cr, -cr, cr * 2, cr * 2);
      }
      ctx.closePath();
      ctx.fillStyle = '#334155';
      ctx.fill();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawTetherMine(ctx, mine, ships) {
    const mx = mine.pos?.x ?? mine.x ?? 0;
    const my = mine.pos?.y ?? mine.y ?? 0;
    const radius = mine.radius || 18;

    ctx.save();
    ctx.translate(mx, my);

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#475569';
    ctx.stroke();

    for (let s = 0; s < 4; s++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(-4, -radius);
      ctx.lineTo(0, -radius - 7);
      ctx.lineTo(4, -radius);
      ctx.fillStyle = '#64748b';
      ctx.fill();
    }

    const blinkOn = Math.sin(this.animTime * Math.PI * 2) > 0;
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = blinkOn ? '#ef4444' : '#450a0a';
    if (blinkOn) {
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 10;
    }
    ctx.fill();
    ctx.restore();

    if (mine.tetheredShipId && ships) {
      const ship = ships[mine.tetheredShipId];
      if (ship) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(ship.pos?.x || 0, ship.pos?.y || 0);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 10;
        ctx.setLineDash([10, 6]);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawMunitionsDerelict(ctx, derelict, ships) {
    const dx = derelict.pos?.x ?? derelict.x ?? 0;
    const dy = derelict.pos?.y ?? derelict.y ?? 0;
    const resupplyRange = derelict.resupplyRange || 80;

    ctx.save();
    ctx.translate(dx, dy);

    const rangePulse = 0.25 + 0.15 * Math.sin(this.animTime * 3);
    ctx.beginPath();
    ctx.arc(0, 0, resupplyRange, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(56, 189, 248, ${rangePulse})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 8]);
    ctx.stroke();

    ctx.rotate(this.animTime * 0.05);
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(-28, -20, 56, 40);
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.strokeRect(-28, -20, 56, 40);

    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(-18, -14, 8, 28);
    ctx.fillRect(10, -14, 8, 28);

    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fillStyle = Math.sin(this.animTime * 4) > 0 ? '#fbbf24' : '#78350f';
    ctx.fill();

    if (derelict.progressByShip) {
      for (const [shipTeam, progress] of Object.entries(derelict.progressByShip)) {
        if (progress > 0) {
          ctx.beginPath();
          ctx.arc(0, 0, 36, -Math.PI / 2, -Math.PI / 2 + (progress / 5.0) * Math.PI * 2);
          ctx.strokeStyle = shipTeam === 'alpha' ? '#38bdf8' : '#f43f5e';
          ctx.lineWidth = 4;
          ctx.stroke();
        }
      }
    }

    ctx.restore();
  }

  // ==========================================================================
  // PROJECTILES & WEAPON BALLISTICS (FALLBACK 2D)
  // ==========================================================================

  drawProjectile(ctx, proj) {
    const px = proj.pos?.x ?? proj.x ?? 0;
    const py = proj.pos?.y ?? proj.y ?? 0;
    const vx = proj.vel?.x ?? proj.vx ?? 0;
    const vy = proj.vel?.y ?? proj.vy ?? 0;
    const angle = Math.atan2(vy, vx);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);

    if (proj.type === 'laser') {
      ctx.beginPath();
      ctx.moveTo(-18, 0);
      ctx.lineTo(12, 0);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#38bdf8';
      ctx.shadowColor = '#0284c7';
      ctx.shadowBlur = 8;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-12, 0);
      ctx.lineTo(10, 0);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else if (proj.type === 'railgun') {
      const r = proj.radius || 6;
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#a855f7';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (proj.type === 'torpedo') {
      ctx.fillStyle = '#475569';
      ctx.fillRect(-10, -3, 16, 6);

      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(-20 - Math.random() * 8, 0);
      ctx.strokeStyle = proj.torpedoType === 'emp_torpedoes' ? '#38bdf8' : '#f59e0b';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#ea580c';
      ctx.shadowBlur = 8;
      ctx.stroke();
    } else if (proj.type === 'flak') {
      ctx.beginPath();
      ctx.arc(0, 0, proj.radius || 30, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.7)';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.restore();
  }

  // ==========================================================================
  // STARSHIP RENDERING (FALLBACK 2D & MOCK TESTS)
  // ==========================================================================

  /**
   * Draws starship with articulated turrets, 6 RCS gas plumes, heat radiator vents,
   * 180° roll foreshortening animation, and 4-quadrant hexagonal shields.
   * Also ensures 3D mesh roll rotation is kept synchronized.
   */
  drawShip(ctx, ship, teamColor, isPlayerShip, hideHull = false) {
    if (!ship || ship.destroyed) return;

    if (ship.hyperspace?.state === 'jumping') {
      const jt = ship.hyperspace.jumpTimer ?? 0;
      if (jt >= 0.40) return;
    }

    // Sync 3D hullRollGroup rotation if mesh exists
    const team = (teamColor === '#38bdf8' || ship.team === 'alpha') ? 'alpha' : 'omega';
    const mesh = this.shipMeshes.get(team);
    if (mesh && mesh.hullRollGroup) {
      const rollAngle = ship.rollAngle !== undefined
        ? ship.rollAngle
        : ((ship.rollState || 0) * Math.PI);
      mesh.hullRollGroup.rotation.x = rollAngle;
    }

    if (!ctx) return;

    ctx.save();
    ctx.translate(ship.pos?.x || 0, ship.pos?.y || 0);
    ctx.rotate(ship.angle || 0);

    // Visual Roll Foreshortening Animation
    let lateralScale = 1.0;
    if (ship.rollAngle !== undefined) {
      lateralScale = Math.cos(ship.rollAngle);
    } else if (ship.rollState === 1) {
      lateralScale = -1.0;
    }

    if (ship.hyperspace?.state === 'jumping') {
      const jt = ship.hyperspace.jumpTimer ?? 0;
      const p = Math.max(0, Math.min(1.0, jt / 0.40));
      if (p > 0) {
        ctx.translate(p * p * 1800, 0);
      }
      ctx.scale(1 + p * 6.5, Math.max(0.35, (1 - p * 0.45) * lateralScale));
      // Warp stretch Cherenkov flash
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 40 * (1 + p * 2), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(125, 211, 252, ${Math.max(0, 0.8 * (1 - p))})`;
      ctx.fill();
      ctx.restore();
    } else if (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 0.45) {
      const rt = ship.hyperspace.rebootTimer ?? 0;
      const u = Math.max(0, 1 - rt / 0.45);
      ctx.scale(1 + u * u * 5.0, Math.max(0.5, (1 - u * 0.3) * lateralScale));
      // Arrival snap flash
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 45 * (1 + u * 1.5), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(56, 189, 248, ${Math.max(0, 0.7 * u)})`;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.scale(1.0, lateralScale);
    }

    const hullClass = ship.hullClass || 'frigate';

    // Edge Dampening Field subtle amber-gold glow halo (2D fallback)
    const dampFactor = Math.max(0, Math.min(1, Number(ship.dampeningFactor ?? (ship.inDampeningField ? 1 : 0)) || 0));
    if (dampFactor > 0) {
      const haloRadius = (BSG_HULL_RADII[hullClass] || 60) * 0.9;
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, haloRadius, 0, Math.PI * 2);
      if (typeof ctx.createRadialGradient === 'function') {
        const grad = ctx.createRadialGradient(0, 0, haloRadius * 0.2, 0, 0, haloRadius);
        grad.addColorStop(0, `rgba(245, 158, 11, ${(0.32 * dampFactor).toFixed(3)})`);
        grad.addColorStop(0.65, `rgba(251, 191, 36, ${(0.18 * dampFactor).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(251, 191, 36, 0)');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = `rgba(245, 158, 11, ${(0.18 * dampFactor).toFixed(3)})`;
      }
      ctx.fill();
      ctx.restore();
    }

    if (!hideHull) {
      this.drawMainDrivePlume(ctx, ship, hullClass);
      this.drawRcsThrusterPlumes(ctx, ship, hullClass);
      this.drawHullPlates(ctx, ship, hullClass, teamColor);
      this.drawRadiatorHeatVents(ctx, ship, hullClass);
      this.drawCockpitAndRunningLights(ctx, ship, hullClass);
      this.drawArticulatedTurrets(ctx, ship, hullClass);
    }
    this.drawHexagonalShields(ctx, ship, hullClass, teamColor);

    ctx.restore();
  }

  drawMainDrivePlume(ctx, ship, hullClass) {
    const isFiring = ship.mainDrive?.isFiring || (ship.mainDrive?.throttle > 0);
    if (!isFiring) return;

    const throttle = ship.mainDrive?.throttle || 1.0;
    const lFactor = hullClass === 'dreadnought' ? 45 : (hullClass === 'corvette' ? 20 : 30);
    const plumeLength = (lFactor + Math.random() * 12) * throttle;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-lFactor, -8);
    ctx.lineTo(-lFactor - plumeLength, 0);
    ctx.lineTo(-lFactor, 8);
    ctx.closePath();

    const plumeGrad = ctx.createLinearGradient(-lFactor, 0, -lFactor - plumeLength, 0);
    plumeGrad.addColorStop(0, '#ffffff');
    plumeGrad.addColorStop(0.3, '#38bdf8');
    plumeGrad.addColorStop(0.8, '#6366f1');
    plumeGrad.addColorStop(1, 'transparent');

    ctx.fillStyle = plumeGrad;
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 16;
    ctx.fill();
    ctx.restore();
  }

  drawRcsThrusterPlumes(ctx, ship, radiusOrClass) {
    const thrusters = ship.thrusters || {};
    let hullClass = 'frigate';
    if (typeof radiusOrClass === 'string') {
      hullClass = radiusOrClass;
    } else if (ship.hullClass) {
      hullClass = ship.hullClass;
    }
    const L = hullClass === 'dreadnought' ? 90 : (hullClass === 'corvette' ? 40 : 60);
    const W = hullClass === 'dreadnought' ? 40 : (hullClass === 'corvette' ? 20 : 28);

    const mounts = [
      { id: 'bowPort', x: L * 0.4, y: -W * 0.5, angle: Math.PI },
      { id: 'bowStarboard', x: L * 0.4, y: W * 0.5, angle: 0 },
      { id: 'sternPort', x: -L * 0.4, y: -W * 0.5, angle: Math.PI },
      { id: 'sternStarboard', x: -L * 0.4, y: W * 0.5, angle: 0 },
      { id: 'dorsalRoll', x: 0, y: 0, angle: Math.PI },
      { id: 'ventralRoll', x: 0, y: 0, angle: Math.PI },
    ];
    this.rcsMounts2d = mounts;

    for (const m of mounts) {
      const th = thrusters[m.id];
      if (!th) continue;

      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.angle);

      if (th.isFiring || (th.throttle && th.throttle > 0)) {
        ctx.beginPath();
        ctx.moveTo(-3, 0);
        ctx.lineTo(0, 16 + Math.random() * 6);
        ctx.lineTo(3, 0);
        ctx.fillStyle = 'rgba(125, 211, 252, 0.85)';
        ctx.shadowColor = '#38bdf8';
        ctx.shadowBlur = 8;
        ctx.fill();
      }

      if (th.health !== undefined && th.health < 50) {
        if (Math.random() < 0.3) {
          ctx.beginPath();
          ctx.arc((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 2, 0, Math.PI * 2);
          ctx.fillStyle = '#fbbf24';
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  drawHullPlates(ctx, ship, hullClass, teamColor) {
    ctx.save();

    let halfL = 30;
    let halfW = 14;
    if (hullClass === 'corvette') {
      halfL = 20; halfW = 10;
    } else if (hullClass === 'dreadnought') {
      halfL = 45; halfW = 20;
    }

    ctx.beginPath();
    if (hullClass === 'corvette') {
      ctx.moveTo(halfL, 0);
      ctx.lineTo(-halfL * 0.4, halfW);
      ctx.lineTo(-halfL, halfW * 0.7);
      ctx.lineTo(-halfL * 0.8, 0);
      ctx.lineTo(-halfL, -halfW * 0.7);
      ctx.lineTo(-halfL * 0.4, -halfW);
    } else if (hullClass === 'dreadnought') {
      ctx.moveTo(halfL, 0);
      ctx.lineTo(halfL * 0.7, halfW * 0.6);
      ctx.lineTo(halfL * 0.3, halfW);
      ctx.lineTo(-halfL * 0.5, halfW);
      ctx.lineTo(-halfL, halfW * 0.7);
      ctx.lineTo(-halfL, -halfW * 0.7);
      ctx.lineTo(-halfL * 0.5, -halfW);
      ctx.lineTo(halfL * 0.3, -halfW);
      ctx.lineTo(halfL * 0.7, -halfW * 0.6);
    } else {
      ctx.moveTo(halfL, halfW * 0.2);
      ctx.lineTo(halfL * 0.85, halfW * 0.7);
      ctx.lineTo(-halfL * 0.3, halfW);
      ctx.lineTo(-halfL, halfW * 0.8);
      ctx.lineTo(-halfL * 0.85, 0);
      ctx.lineTo(-halfL, -halfW * 0.8);
      ctx.lineTo(-halfL * 0.3, -halfW);
      ctx.lineTo(halfL * 0.85, -halfW * 0.7);
      ctx.lineTo(halfL, -halfW * 0.2);
    }
    ctx.closePath();

    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = teamColor;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(halfL * 0.5, 0);
    ctx.lineTo(-halfL * 0.4, 0);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  }

  drawRadiatorHeatVents(ctx, ship, hullClass) {
    const heat = ship.weapons?.heat || 0;
    const maxHeat = ship.weapons?.maxHeat || 100;
    const heatRatio = Math.min(1.0, heat / maxHeat);

    let ventColor = 'rgba(68, 64, 60, 0.6)';
    if (heatRatio > 0.7) {
      ventColor = `rgba(255, 255, 255, ${0.8 + 0.2 * Math.sin(this.animTime * 10)})`;
    } else if (heatRatio > 0.3) {
      ventColor = `rgba(249, 115, 22, ${0.5 + heatRatio * 0.5})`;
    }

    ctx.save();
    ctx.fillStyle = ventColor;
    if (heatRatio > 0.5) {
      ctx.shadowColor = '#ea580c';
      ctx.shadowBlur = heatRatio * 12;
    }

    const halfL = hullClass === 'dreadnought' ? 45 : (hullClass === 'corvette' ? 20 : 30);
    for (let f = 0; f < 3; f++) {
      const rx = -halfL * 0.4 - f * 4;
      ctx.fillRect(rx, -6, 2, 4);
      ctx.fillRect(rx, 2, 2, 4);
    }
    ctx.restore();
  }

  drawCockpitAndRunningLights(ctx, ship, hullClass) {
    const halfL = hullClass === 'dreadnought' ? 45 : (hullClass === 'corvette' ? 20 : 30);
    const halfW = hullClass === 'dreadnought' ? 20 : (hullClass === 'corvette' ? 10 : 14);

    ctx.save();
    ctx.beginPath();
    ctx.arc(halfL * 0.4, 0, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 6;
    ctx.fill();

    const strobe = Math.sin(this.animTime * Math.PI * 2) > 0.6;
    if (strobe) {
      ctx.beginPath();
      ctx.arc(-halfL * 0.3, -halfW, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(-halfL * 0.3, halfW, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
    }
    ctx.restore();
  }

  drawArticulatedTurrets(ctx, ship, hullClass) {
    const turretAngle = ship.turretAngle !== undefined ? ship.turretAngle : 0;
    const halfL = hullClass === 'dreadnought' ? 45 : (hullClass === 'corvette' ? 20 : 30);

    ctx.save();
    ctx.translate(halfL * 0.1, 0);

    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.rotate(turretAngle - (ship.angle || 0));
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, -2, 14, 4);

    ctx.restore();
  }

  drawHexagonalShields(ctx, ship, hullClass, teamColor) {
    const shields = ship.shields || { hp: { fore: 100, aft: 100, port: 100, starboard: 100 } };
    const maxHp = shields.maxHp || { fore: 100, aft: 100, port: 100, starboard: 100 };
    const radius = (hullClass === 'dreadnought' ? 52 : (hullClass === 'corvette' ? 26 : 38));

    const quadrants = [
      { key: 'fore', start: -Math.PI / 4, end: Math.PI / 4 },
      { key: 'starboard', start: Math.PI / 4, end: (3 * Math.PI) / 4 },
      { key: 'aft', start: (3 * Math.PI) / 4, end: (5 * Math.PI) / 4 },
      { key: 'port', start: (5 * Math.PI) / 4, end: (7 * Math.PI) / 4 },
    ];

    ctx.save();
    for (const q of quadrants) {
      const isOnline = ship.shields?.online
        ? ship.shields.online[q.key] !== false
        : !(ship.hyperspace?.state === 'jumping' || (ship.hyperspace?.state === 'rebooting' && (ship.hyperspace.rebootTimer ?? 0) < 7.0));
      const hp = isOnline ? (shields.hp ? (shields.hp[q.key] || 0) : 0) : 0;
      const max = maxHp[q.key] || 100;
      if (hp <= 0 || !isOnline) continue;

      const hpRatio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
      const strokeAlpha = 0.25 * hpRatio;
      const fillAlpha = 0.10 * hpRatio;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, q.start, q.end);
      ctx.closePath();
      ctx.fillStyle = `rgba(56, 189, 248, ${fillAlpha})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, radius, q.start, q.end);
      ctx.lineWidth = 3;
      ctx.strokeStyle = `rgba(56, 189, 248, ${strokeAlpha})`;
      ctx.shadowColor = teamColor;
      ctx.shadowBlur = 10;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ==========================================================================
  // RETICLE & COMBAT FX OVERLAYS
  // ==========================================================================

  drawLeadReticle(ctx, ship, target) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ship.pos?.x || 0, ship.pos?.y || 0);
    ctx.lineTo(target.x, target.y);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.translate(target.x, target.y);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(12, 0);
    ctx.lineTo(0, 12);
    ctx.lineTo(-12, 0);
    ctx.closePath();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
    ctx.restore();
  }

  updateAndDrawParticles(ctx, dt, events = []) {
    for (const ev of events) {
      if (ev.type === 'flak_burst' || ev.type === 'torpedo_hit') {
        const x = ev.pos?.x ?? 0;
        const y = ev.pos?.y ?? 0;
        for (let p = 0; p < 8; p++) {
          this.fxParticles.push({
            x, y,
            vx: (Math.random() - 0.5) * 120,
            vy: (Math.random() - 0.5) * 120,
            life: 0.6,
            maxLife: 0.6,
            color: '#fbbf24',
          });
        }
      }
    }

    for (let i = this.fxParticles.length - 1; i >= 0; i--) {
      const p = this.fxParticles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) {
        this.fxParticles.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }

  drawScreenSpaceHazardOverlays(ctx, width, height, slowMoActive) {
    if (slowMoActive) {
      ctx.save();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
      ctx.lineWidth = 12;
      ctx.strokeRect(0, 0, width, height);
      ctx.restore();
    }
  }

  // ==========================================================================
  // STATIC HELPER: RENDER 10x10 MINI GRID (FOR ENGINEER & SPECTATOR PIP)
  // ==========================================================================

  /**
   * Renders the 10x10 conduit matrix onto any canvas context.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} gridData - Serialized 10x10 grid from ship.grid
   * @param {Array} drones - Array of active drones from ship.drones
   * @param {number} x - Target x offset
   * @param {number} y - Target y offset
   * @param {number} size - Square dimension in px
   * @param {string} teamColor - Alpha or Omega accent color
   */
  static renderMiniGrid10x10(ctx, gridData, drones = [], x = 0, y = 0, size = 620, teamColor = '#38bdf8') {
    if (!ctx || !gridData) return;

    ctx.save();
    ctx.translate(x, y);

    ctx.fillStyle = '#090e18';
    ctx.fillRect(0, 0, size, size);

    const cellSize = size / 10;
    const tiles = gridData.tiles || [];

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 10; c++) {
        const tile = tiles[r]?.[c];
        if (!tile) continue;

        const tx = c * cellSize;
        const ty = r * cellSize;

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(tx + 1, ty + 1, cellSize - 2, cellSize - 2);

        if (tile.type === 'reactor') {
          // Reactor at (2,3) — cyan #38bdf8
          ctx.fillStyle = '#0284c7';
          ctx.fillRect(tx + 2, ty + 2, cellSize - 4, cellSize - 4);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(tx + 2, ty + 2, cellSize - 4, cellSize - 4);

          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.floor(cellSize * 0.3)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('R', tx + cellSize / 2, ty + cellSize / 2);
        } else if (tile.type === 'coolant') {
          // Coolant at (2,6) — green #22c55e
          ctx.fillStyle = '#16a34a';
          ctx.fillRect(tx + 2, ty + 2, cellSize - 4, cellSize - 4);
          ctx.strokeStyle = '#22c55e';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(tx + 2, ty + 2, cellSize - 4, cellSize - 4);

          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.floor(cellSize * 0.3)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('C', tx + cellSize / 2, ty + cellSize / 2);
        } else if (tile.type === 'capacitor') {
          // Capacitor — amber #eab308 / #facc15
          ctx.fillStyle = tile.discharging ? '#eab308' : '#334155';
          ctx.fillRect(tx + 3, ty + 3, cellSize - 6, cellSize - 6);
          ctx.strokeStyle = '#facc15';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(tx + 3, ty + 3, cellSize - 6, cellSize - 6);

          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.floor(cellSize * 0.22)}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('CAP', tx + cellSize / 2, ty + cellSize / 2);
        } else {
          // Conduits: check powerFlow and coolantFlow
          const hasPower = Boolean(tile.powerFlow || (tile.allocatedPower || 0) > 0);
          const hasCoolant = Boolean(tile.coolantFlow);

          if (hasPower && hasCoolant) {
            // Cyan + green dual tint/dots
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.arc(tx + cellSize * 0.35, ty + cellSize / 2, cellSize * 0.16, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(tx + cellSize * 0.65, ty + cellSize / 2, cellSize * 0.16, 0, Math.PI * 2);
            ctx.fill();
          } else if (hasPower) {
            ctx.fillStyle = '#38bdf8';
            ctx.beginPath();
            ctx.arc(tx + cellSize / 2, ty + cellSize / 2, cellSize * 0.2, 0, Math.PI * 2);
            ctx.fill();
          } else if (hasCoolant) {
            ctx.fillStyle = '#22c55e';
            ctx.beginPath();
            ctx.arc(tx + cellSize / 2, ty + cellSize / 2, cellSize * 0.2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = '#334155';
            ctx.beginPath();
            ctx.arc(tx + cellSize / 2, ty + cellSize / 2, cellSize * 0.15, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Broken status overlay
        if (tile.status === 'broken' || tile.status === 'burning') {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
          ctx.fillRect(tx + 1, ty + 1, cellSize - 2, cellSize - 2);
        } else if (tile.empTimer > 0) {
          ctx.fillStyle = 'rgba(192, 132, 252, 0.5)';
          ctx.fillRect(tx + 1, ty + 1, cellSize - 2, cellSize - 2);
        }

        ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty, cellSize, cellSize);
      }
    }

    // Perimeter system status indicators around outer edges
    const powerMap = gridData.lastPowerMap || {};
    const coolantMap = powerMap.coolantMap || powerMap.coolant || {};
    const extSystems = gridData.externalSystems || [
      { key: 'sas_computer', label: 'SAS COMPUTER', short: 'SAS', side: 'N', cells: [[0, 1], [0, 2]] },
      { key: 'shields_fore', label: 'SHIELD FORE', short: 'SHD FORE', side: 'N', cells: [[0, 4], [0, 5]] },
      { key: 'rcs_thrusters', label: 'RCS THRUSTERS', short: 'RCS', side: 'N', cells: [[0, 7], [0, 8]] },
      { key: 'shields_aft', label: 'SHIELD AFT', short: 'SHD AFT', side: 'S', cells: [[9, 2], [9, 3]] },
      { key: 'main_drive', label: 'MAIN DRIVE', short: 'DRIVE', side: 'S', cells: [[9, 6], [9, 7]] },
      { key: 'weapons_torpedo', label: 'WPN TORPEDO', short: 'TORP', side: 'W', cells: [[1, 0], [2, 0]] },
      { key: 'shields_port', label: 'SHIELD PORT', short: 'SHD PORT', side: 'W', cells: [[4, 0], [5, 0]] },
      { key: 'weapons_laser', label: 'WPN LASER', short: 'LASER', side: 'W', cells: [[7, 0], [8, 0]] },
      { key: 'hyperspace', label: 'HYPERSPACE', short: 'HYPER', side: 'E', cells: [[1, 9], [2, 9]] },
      { key: 'shields_starboard', label: 'SHIELD STBD', short: 'SHD STBD', side: 'E', cells: [[4, 9], [5, 9]] },
      { key: 'weapons_railgun', label: 'WPN RAILGUN', short: 'RAILGUN', side: 'E', cells: [[7, 9], [8, 9]] },
    ];

    for (const sys of extSystems) {
      const pActive = (powerMap[sys.key] || 0) > 0;
      const cActive = (coolantMap[sys.key] || 0) > 0;
      const sysColor = (pActive && cActive) ? '#38bdf8' : (pActive ? '#38bdf8' : (cActive ? '#22c55e' : '#334155'));

      for (const [r, c] of sys.cells) {
        ctx.fillStyle = sysColor;
        if (sys.side === 'N') {
          ctx.fillRect(c * cellSize, 0, cellSize, 2);
        } else if (sys.side === 'S') {
          ctx.fillRect(c * cellSize, size - 2, cellSize, 2);
        } else if (sys.side === 'W') {
          ctx.fillRect(0, r * cellSize, 2, cellSize);
        } else if (sys.side === 'E') {
          ctx.fillRect(size - 2, r * cellSize, 2, cellSize);
        }
      }

      if (typeof ctx.fillText === 'function' && (sys.short || sys.label) && Array.isArray(sys.cells) && sys.cells.length > 0) {
        const firstCell = sys.cells[0];
        const lastCell = sys.cells[sys.cells.length - 1];
        const midR = (firstCell[0] + lastCell[0]) / 2;
        const midC = (firstCell[1] + lastCell[1]) / 2;
        const lx = midC * cellSize + cellSize / 2;
        const ly = midR * cellSize + cellSize / 2;
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(6, Math.floor(cellSize * 0.22))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sys.short || sys.label, lx, ly);
        ctx.restore();
      }
    }

    // Drones
    for (const drone of drones) {
      if (!drone.currentPos) continue;
      const dx = (drone.currentPos.col ?? drone.currentPos.x ?? 0) * cellSize + cellSize / 2;
      const dy = (drone.currentPos.row ?? drone.currentPos.y ?? 0) * cellSize + cellSize / 2;

      ctx.beginPath();
      ctx.arc(dx, dy, cellSize * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#10b981';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Helper alias for renderMiniGrid10x10.
   */
  drawEngineerGrid(ctx, gridData, size = 620, drones = []) {
    return SpaceRenderer.renderMiniGrid10x10(ctx, gridData, drones, 0, 0, size);
  }

  static drawEngineerGrid(ctx, gridData, size = 620, drones = []) {
    return SpaceRenderer.renderMiniGrid10x10(ctx, gridData, drones, 0, 0, size);
  }

  // ==========================================================================
  // PIP VIEWER & RAYCASTING TACTICAL HELPERS
  // ==========================================================================

  /**
   * Single-context multi-angle ship PiP rendering using WebGL scissor test.
   *
   * @param {Array<{ el: HTMLElement, view: 'dorsal'|'side'|'stern' }>} pipSlots
   * @param {object} myShip
   */
  renderMultiAnglePips3D(pipSlots = [], myShip) {
    if (!this.webglRenderer || !pipSlots || !pipSlots.length || !myShip) return;
    if (!this.canvas || !this.canvas.getBoundingClientRect) return;

    const canvasRect = this.canvas.getBoundingClientRect();
    const dpr = this.dpr || 1;

    // External View < 4.0s Reboot Blackout: clear active PiP canvases to #02040a and skip scene rendering
    if (this.isExternalBlackoutActive(myShip, 'pip')) {
      this.webglRenderer.setScissorTest(true);
      try {
        for (const slot of pipSlots) {
          if (!slot || !slot.el || !slot.el.getBoundingClientRect) continue;
          const rect = slot.el.getBoundingClientRect();
          if (rect.width <= 4 || rect.height <= 4) continue;
          const x = rect.left - canvasRect.left;
          const y = canvasRect.height - (rect.bottom - canvasRect.top);
          const vx = Math.floor(x * dpr);
          const vy = Math.floor(y * dpr);
          const vw = Math.floor(rect.width * dpr);
          const vh = Math.floor(rect.height * dpr);
          this.webglRenderer.setViewport(vx, vy, vw, vh);
          this.webglRenderer.setScissor(vx, vy, vw, vh);
          this.webglRenderer.setClearColor(0x02040a, 1.0);
          this.webglRenderer.clear();
          if (typeof slot.el.getContext === 'function') {
            const pipCtx = slot.el.getContext('2d');
            if (pipCtx) {
              pipCtx.fillStyle = '#02040a';
              pipCtx.fillRect(0, 0, slot.el.width || rect.width, slot.el.height || rect.height);
            }
          }
        }
      } finally {
        this.webglRenderer.setScissorTest(false);
        this.webglRenderer.setViewport(0, 0, Math.floor(this.width * dpr), Math.floor(this.height * dpr));
      }
      return;
    }

    if (!this.pipCamera) {
      this.pipCamera = new THREE.PerspectiveCamera(44, 1, 1, 20000);
    }

    const shipX = myShip.pos?.x || 0;
    const shipY = -(myShip.pos?.y || 0);
    const shipZ = myShip.pos?.z || 0;
    const angle = myShip.angle || 0;
    const pitch = myShip.pitch || 0;
    const roll = myShip.rollAngle || 0;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const cosR = Math.cos(roll);
    const sinR = Math.sin(roll);

    const F3 = new THREE.Vector3(cosA * cosP, -sinA * cosP, sinP);
    const U3 = new THREE.Vector3(
      -cosA * sinP * cosR - sinA * sinR,
      sinA * sinP * cosR - cosA * sinR,
      cosP * cosR,
    );

    const myTeam = myShip.team || 'alpha';
    const myMesh = this.shipMeshes ? this.shipMeshes.get(myTeam) : null;
    const savedVisibility = myMesh && myMesh.hullRollGroup ? myMesh.hullRollGroup.children.map((c) => ({ child: c, visible: c.visible })) : null;
    const myAura = myMesh ? (myMesh.dampeningAuraMesh || myMesh.hullRollGroup?.dampeningAuraMesh) : null;
    const savedAura = myAura && myAura.material ? { side: myAura.material.side, opacity: myAura.material.opacity } : null;

    if (savedVisibility) {
      for (const entry of savedVisibility) {
        entry.child.visible = true;
      }
    }
    if (savedAura && myAura && myAura.material && myAura.visible) {
      myAura.material.side = THREE.FrontSide;
      myAura.material.opacity = myAura.userData?.externalOpacity ?? (savedAura.side === THREE.BackSide ? savedAura.opacity * 2.8 : savedAura.opacity);
    }

    this.webglRenderer.setScissorTest(true);
    try {
      for (const slot of pipSlots) {
        if (!slot || !slot.el || !slot.el.getBoundingClientRect) continue;
        const rect = slot.el.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) continue;

        const x = rect.left - canvasRect.left;
        const y = canvasRect.height - (rect.bottom - canvasRect.top);
        const aspect = rect.width / rect.height;

        this.pipCamera.aspect = aspect;
        this.pipCamera.updateProjectionMatrix();

        if (slot.view === 'dorsal') {
          // Overhead looking down, ship heading pointing up on screen
          this.pipCamera.position.set(shipX, shipY, shipZ + 180);
          this.pipCamera.up.set(cosA, -sinA, 0);
          this.pipCamera.lookAt(shipX, shipY, shipZ);
        } else if (slot.view === 'side') {
          // Port lateral profile looking across hull
          this.pipCamera.position.set(shipX - sinA * 120, shipY - cosA * 120, shipZ + 20);
          this.pipCamera.up.set(0, 0, 1);
          this.pipCamera.lookAt(shipX, shipY, shipZ);
        } else {
          // 'stern': behind engines looking forward along 3D forward vector F3
          this.pipCamera.position.set(
            shipX - F3.x * 130 + U3.x * 25,
            shipY - F3.y * 130 + U3.y * 25,
            shipZ - F3.z * 130 + U3.z * 25,
          );
          this.pipCamera.up.copy(U3);
          this.pipCamera.lookAt(
            shipX + F3.x * 50,
            shipY + F3.y * 50,
            shipZ + F3.z * 50,
          );
        }

        this.pipCamera.updateMatrixWorld();

        const vx = Math.floor(x * dpr);
        const vy = Math.floor(y * dpr);
        const vw = Math.floor(rect.width * dpr);
        const vh = Math.floor(rect.height * dpr);

        this.webglRenderer.setViewport(vx, vy, vw, vh);
        this.webglRenderer.setScissor(vx, vy, vw, vh);
        this.webglRenderer.render(this.scene, this.pipCamera);
      }
    } finally {
      this.webglRenderer.setScissorTest(false);
      this.webglRenderer.setViewport(0, 0, Math.floor(this.width * dpr), Math.floor(this.height * dpr));
      if (savedVisibility) {
        for (const entry of savedVisibility) {
          entry.child.visible = entry.visible;
        }
      }
      if (savedAura && myAura && myAura.material) {
        myAura.material.side = savedAura.side;
        myAura.material.opacity = savedAura.opacity;
      }
    }
  }

  /**
   * Projects screen coordinates into a 3D aiming vector (aimAngle, aimPitch)
   * by raycasting against targets (enemy ship, asteroids) or the orbital plane.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {object} snapshot
   * @param {string} [myTeam='alpha']
   * @returns {{ aimAngle: number, aimPitch: number, targetX?: number, targetY?: number, targetZ?: number, targetType?: string, target?: object }}
   */
  screenToAim3D(clientX, clientY, snapshot, myTeam = 'alpha') {
    const myShip = snapshot?.ships?.[myTeam];
    const myPos = myShip?.pos || { x: 0, y: 0, z: 0 };
    const myX = myPos.x || 0;
    const myY = myPos.y || 0;
    const myZ = myPos.z || 0;

    let targetX = myX + Math.cos(myShip?.angle || 0) * 1000;
    let targetY = myY + Math.sin(myShip?.angle || 0) * 1000;
    let targetZ = myZ;
    let targetType = undefined;
    let target = undefined;

    if (this.webglRenderer && this.camera3d && this.canvas?.getBoundingClientRect) {
      const rect = this.canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera3d);

      const enemyTeam = myTeam === 'alpha' ? 'omega' : 'alpha';
      const enemyShip = snapshot?.ships?.[enemyTeam];

      let hit = false;

      // 1. Check enemy ship sphere
      if (enemyShip && !enemyShip.destroyed && myShip?.targetAvailable !== false) {
        const enemyThree = new THREE.Vector3(enemyShip.pos.x, -enemyShip.pos.y, enemyShip.pos.z || 0);
        const radius = (enemyShip.radius || 40) * 1.5;
        const sphere = new THREE.Sphere(enemyThree, radius);
        if (raycaster.ray.intersectsSphere(sphere)) {
          targetX = enemyShip.pos.x;
          targetY = enemyShip.pos.y;
          targetZ = enemyShip.pos.z || 0;
          targetType = 'ship';
          target = enemyShip;
          hit = true;
        }
      }

      // 2. Check asteroids
      if (!hit && snapshot?.sector?.asteroids) {
        for (const ast of snapshot.sector.asteroids) {
          if (ast.destroyed) continue;
          const astThree = new THREE.Vector3(ast.pos?.x ?? ast.x ?? 0, -(ast.pos?.y ?? ast.y ?? 0), ast.pos?.z ?? ast.z ?? 0);
          const sphere = new THREE.Sphere(astThree, ast.radius || 100);
          if (raycaster.ray.intersectsSphere(sphere)) {
            targetX = ast.pos?.x ?? ast.x ?? 0;
            targetY = ast.pos?.y ?? ast.y ?? 0;
            targetZ = ast.pos?.z ?? ast.z ?? 0;
            targetType = 'asteroid';
            target = ast;
            hit = true;
            break;
          }
        }
      }

      // 3. Raycast onto ship elevation plane or z = 0
      if (!hit) {
        const orig = raycaster.ray.origin;
        const dir = raycaster.ray.direction;
        const planeZ = myZ;
        if (Math.abs(dir.z) > 1e-5) {
          const t = (planeZ - orig.z) / dir.z;
          if (t > 0) {
            targetX = orig.x + dir.x * t;
            targetY = -(orig.y + dir.y * t);
            targetZ = planeZ;
            hit = true;
          }
        }
        if (!hit) {
          targetX = orig.x + dir.x * 1200;
          targetY = -(orig.y + dir.y * 1200);
          targetZ = orig.z + dir.z * 1200;
        }
      }
    } else {
      const p = this.screenToWorldOnPlane(clientX, clientY, snapshot, myTeam);
      targetX = p.x;
      targetY = p.y;
      targetZ = p.z || 0;
      targetType = p.targetType;
      target = p.target;
    }

    const dx = targetX - myX;
    const dy = targetY - myY;
    const dz = targetZ - myZ;
    const distHoriz = Math.hypot(dx, dy);

    const aimAngle = Math.atan2(dy, dx);
    const MAX_PITCH_RAD = (80 * Math.PI) / 180;
    let aimPitch = Math.atan2(dz, Math.max(1, distHoriz));
    aimPitch = Math.max(-MAX_PITCH_RAD, Math.min(MAX_PITCH_RAD, aimPitch));

    return {
      aimAngle,
      aimPitch,
      targetX,
      targetY,
      targetZ,
      targetType,
      target,
    };
  }

  /**
   * Projects click/tap screen coordinates onto the game plane (Z = 0 or planeZ) or entities.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @param {object|number} [snapshotOrPlaneZ]
   * @param {string} [myTeam='alpha']
   * @param {number} [planeZ=0]
   * @returns {{ x: number, y: number, z?: number, targetType?: string, target?: object }}
   */
  screenToWorldOnPlane(clientX, clientY, snapshotOrPlaneZ, myTeam = 'alpha', planeZ = 0) {
    let snapshot = null;
    let targetZ = 0;
    if (typeof snapshotOrPlaneZ === 'number') {
      targetZ = snapshotOrPlaneZ;
    } else if (snapshotOrPlaneZ && typeof snapshotOrPlaneZ === 'object') {
      snapshot = snapshotOrPlaneZ;
      if (typeof planeZ === 'number') targetZ = planeZ;
    }

    if (this.webglRenderer && this.camera3d && this.canvas?.getBoundingClientRect) {
      const rect = this.canvas.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ndcY = -(((clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera3d);

      const enemyTeam = myTeam === 'alpha' ? 'omega' : 'alpha';
      const myShip = snapshot?.ships?.[myTeam];
      const enemyShip = snapshot?.ships?.[enemyTeam];

      // 1. Check enemy ship sphere if targetAvailable is not false
      if (enemyShip && !enemyShip.destroyed && myShip?.targetAvailable !== false) {
        const enemyPos = new THREE.Vector3(enemyShip.pos.x, -enemyShip.pos.y, enemyShip.pos.z || 0);
        const enemyRadius = (enemyShip.radius || 40) * 1.5;
        const sphere = new THREE.Sphere(enemyPos, enemyRadius);
        if (raycaster.ray.intersectsSphere(sphere)) {
          return { x: enemyShip.pos.x, y: enemyShip.pos.y, z: enemyShip.pos.z || 0, targetType: 'ship', target: enemyShip };
        }
      }

      // 2. Check active asteroids
      if (snapshot?.sector?.asteroids) {
        for (const ast of snapshot.sector.asteroids) {
          if (ast.destroyed) continue;
          const astPos = new THREE.Vector3(ast.pos?.x ?? ast.x ?? 0, -(ast.pos?.y ?? ast.y ?? 0), ast.pos?.z ?? ast.z ?? 0);
          const sphere = new THREE.Sphere(astPos, ast.radius || 100);
          if (raycaster.ray.intersectsSphere(sphere)) {
            return { x: ast.pos?.x ?? ast.x ?? 0, y: ast.pos?.y ?? ast.y ?? 0, z: ast.pos?.z ?? ast.z ?? 0, targetType: 'asteroid', target: ast };
          }
        }
      }

      // 3. Intersect Z = targetZ plane
      const orig = raycaster.ray.origin;
      const dir = raycaster.ray.direction;
      if (Math.abs(dir.z) > 1e-5) {
        const t = (targetZ - orig.z) / dir.z;
        if (t > 0) {
          return { x: orig.x + dir.x * t, y: -(orig.y + dir.y * t), z: targetZ };
        }
      }

      return { x: orig.x + dir.x * 800, y: -(orig.y + dir.y * 800), z: orig.z + dir.z * 800 };
    }

    // 2D Fallback
    const rect = (this.canvas && this.canvas.getBoundingClientRect)
      ? this.canvas.getBoundingClientRect()
      : { left: 0, top: 0, width: this.width, height: this.height };
    const cx = clientX - (rect.left || 0);
    const cy = clientY - (rect.top || 0);
    const worldX = (cx - this.width / 2) / (this.zoom || 1) + (this.cameraPos.x || 0);
    const worldY = (cy - this.height / 2) / (this.zoom || 1) + (this.cameraPos.y || 0);
    return { x: worldX, y: worldY, z: targetZ };
  }

  /**
   * Projects enemy ship position to screen or clamps to viewport edge with indicator arrow angle.
   *
   * @param {object} myShip
   * @param {object} enemyShip
   * @param {{ width: number, height: number }} [viewportRect]
   * @returns {{ visible: boolean, screenX?: number, screenY?: number, arrowAngleRad?: number, inFrustum?: boolean, distanceMeters?: number }}
   */
  projectEnemyToViewportEdge(myShip, enemyShip, viewportRect) {
    if (!myShip || !enemyShip || enemyShip.destroyed || myShip.targetAvailable === false) {
      return { visible: false };
    }

    const w = viewportRect?.width || this.width || 1280;
    const h = viewportRect?.height || this.height || 720;
    const pad = 36;
    const centerX = w / 2;
    const centerY = h / 2;

    const dxWorld = enemyShip.pos.x - myShip.pos.x;
    const dyWorld = enemyShip.pos.y - myShip.pos.y;
    const dzWorld = (enemyShip.pos.z || 0) - (myShip.pos.z || 0);
    const distanceMeters = Math.hypot(dxWorld, dyWorld, dzWorld);

    if (this.camera3d) {
      this.camera3d.updateMatrixWorld();
      const enemyThreePos = new THREE.Vector3(enemyShip.pos.x, -enemyShip.pos.y, enemyShip.pos.z || 0);

      // Camera view space: -Z is forward, +X is right, +Y is up
      const v = enemyThreePos.clone().applyMatrix4(this.camera3d.matrixWorldInverse);
      const vz = v.z;

      let screenX, screenY;
      let inFrustum = false;

      if (vz < -0.5) {
        // In front of camera
        const projected = enemyThreePos.clone().project(this.camera3d);
        screenX = (projected.x * 0.5 + 0.5) * w;
        screenY = (-projected.y * 0.5 + 0.5) * h;
        inFrustum = (projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1 && projected.z >= -1 && projected.z <= 1);
      } else {
        // Behind camera: avoid negative-W NDC flip by projecting outwards along view direction
        const dirX = Math.abs(v.x) < 1e-4 && Math.abs(v.y) < 1e-4 ? 0 : v.x;
        const dirY = Math.abs(v.x) < 1e-4 && Math.abs(v.y) < 1e-4 ? 1 : -v.y;
        screenX = centerX + dirX * 10000;
        screenY = centerY + dirY * 10000;
        inFrustum = false;
      }

      let edgeX = screenX;
      let edgeY = screenY;

      if (!inFrustum || screenX < pad || screenX > w - pad || screenY < pad || screenY > h - pad) {
        const dx = screenX - centerX;
        const dy = screenY - centerY;
        const maxHalfW = Math.max(10, w / 2 - pad);
        const maxHalfH = Math.max(10, h / 2 - pad);
        const scaleX = Math.abs(dx) > 1e-6 ? maxHalfW / Math.abs(dx) : 1e9;
        const scaleY = Math.abs(dy) > 1e-6 ? maxHalfH / Math.abs(dy) : 1e9;
        const scale = Math.min(scaleX, scaleY);
        edgeX = centerX + dx * scale;
        edgeY = centerY + dy * scale;
      }

      const arrowAngleRad = Math.atan2(edgeY - centerY, edgeX - centerX);
      const isInside = Boolean(inFrustum && screenX >= pad && screenX <= w - pad && screenY >= pad && screenY <= h - pad);

      return {
        visible: true,
        screenX: edgeX,
        screenY: edgeY,
        arrowAngleRad,
        inFrustum: isInside,
        distanceMeters,
      };
    }

    // 2D Fallback
    const angleToEnemy = Math.atan2(dyWorld, dxWorld);
    const relAngle = angleToEnemy - (myShip.angle || 0) + Math.PI / 2;
    const maxR = Math.min(w / 2 - pad, h / 2 - pad);
    const edgeX = centerX + Math.cos(relAngle) * maxR;
    const edgeY = centerY + Math.sin(relAngle) * maxR;

    return {
      visible: true,
      screenX: edgeX,
      screenY: edgeY,
      arrowAngleRad: Math.atan2(edgeY - centerY, edgeX - centerX),
      inFrustum: false,
      distanceMeters,
    };
  }

  // ==========================================================================
  // STATIC HELPER: RENDER ARENA MINI-MAP RADAR
  // ==========================================================================

  /**
   * Static renderer for tactical 3D tilted perspective arena radar mini-map.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {object} snapshot
   * @param {string} [myTeam='alpha']
   */
  static renderArenaMiniMap(canvas, snapshot, myTeam = 'alpha') {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width || 160;
    const h = canvas.height || 160;
    const ARENA_RADIUS = snapshot?.sector?.arenaRadius || 5250;
    const cx = w / 2;
    const cy = h / 2;
    const rX = Math.min(w, h) / 2 - 4;
    const tiltY = 0.62;
    const rY = rX * tiltY;
    const scale = rX / ARENA_RADIUS;

    ctx.save();
    if (ctx.clearRect) {
      ctx.clearRect(0, 0, w, h);
    }

    // Helper: draw tilted ellipse using polylines (compatible with environments without ctx.ellipse)
    const drawTiltedCircle = (centerX, centerY, radiusX, radiusY, segments = 32) => {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const px = centerX + Math.cos(theta) * radiusX;
        const py = centerY + Math.sin(theta) * radiusY;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };

    // Helper: 3D entity projection to tilted orbital disc
    const project3D = (pos) => {
      const x = pos?.x ?? 0;
      const y = pos?.y ?? 0;
      const z = pos?.z ?? 0;
      const bx = cx + x * scale;
      const by = cy + (y * scale) * tiltY;
      const ex = bx;
      const ey = by - (z * scale) * 0.75;
      return { bx, by, ex, ey, x, y, z };
    };

    // Helper: draw elevation stem for entities above or below orbital plane
    const drawStem = (p, color) => {
      if (Math.abs(p.z) > 15) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(p.bx, p.by);
        ctx.lineTo(p.ex, p.ey);
        ctx.stroke();
        if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(p.bx, p.by, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }
    };

    // Background disk
    drawTiltedCircle(cx, cy, rX, rY);
    ctx.fillStyle = '#070b14';
    ctx.fill();

    // Radar perimeter ring
    drawTiltedCircle(cx, cy, rX, rY);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Inner range rings
    for (let ring = 1; ring <= 2; ring++) {
      drawTiltedCircle(cx, cy, (rX * ring) / 3, (rY * ring) / 3);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
      ctx.lineWidth = 1;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4, 6]);
      ctx.stroke();
    }
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);

    // Crosshairs on reference plane
    ctx.beginPath();
    ctx.moveTo(cx - rX, cy);
    ctx.lineTo(cx + rX, cy);
    ctx.moveTo(cx, cy - rY);
    ctx.lineTo(cx, cy + rY);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const ships = snapshot?.ships || {};
    const isSpectator = myTeam === 'spectator';
    const myShip = isSpectator ? null : ships[myTeam];
    const sensorsOffline = !isSpectator && myShip && (myShip.hyperspace?.state === 'jumping' || myShip.sensorsOnline === false);

    // Radar Minimap Gating: render clean dark radar dial with 'SENSORS REBOOTING' text and omit all contacts
    if (sensorsOffline) {
      if (typeof ctx.fillText === 'function') {
        ctx.save();
        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SENSORS REBOOTING', cx, cy);
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    const sector = snapshot?.sector || {};

    // Gravity Wells
    if (sector.gravityWells) {
      for (const well of sector.gravityWells) {
        const p = project3D(well.pos || well);
        drawStem(p, 'rgba(192, 132, 252, 0.4)');

        const pullRx = Math.max(3, (well.pullRadius || 1200) * scale);
        const pullRy = Math.max(2, pullRx * tiltY);
        drawTiltedCircle(p.ex, p.ey, pullRx, pullRy);
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(p.ex, p.ey, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#c084fc';
        ctx.fill();
      }
    }

    // Ion Nebulae
    if (sector.ionNebulae) {
      for (const neb of sector.ionNebulae) {
        const p = project3D(neb.pos || neb);
        drawStem(p, 'rgba(56, 189, 248, 0.3)');

        const nebRx = Math.max(4, (neb.radius || 500) * scale);
        const nebRy = Math.max(2.5, nebRx * tiltY);
        drawTiltedCircle(p.ex, p.ey, nebRx, nebRy);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fill();
      }
    }

    // Munitions Derelict
    if (sector.munitionsDerelict) {
      const d = sector.munitionsDerelict;
      const p = project3D(d.pos || d);
      drawStem(p, 'rgba(245, 158, 11, 0.4)');
      ctx.beginPath();
      ctx.arc(p.ex, p.ey, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
    }

    // Asteroids (skip destroyed)
    if (sector.asteroids) {
      for (const ast of sector.asteroids) {
        if (ast.destroyed) continue;
        const p = project3D(ast.pos || ast);
        drawStem(p, 'rgba(100, 116, 139, 0.4)');
        ctx.beginPath();
        ctx.arc(p.ex, p.ey, Math.max(1, (ast.radius || 100) * scale), 0, Math.PI * 2);
        ctx.fillStyle = '#64748b';
        ctx.fill();
      }
    }

    // Debris chunks
    if (sector.debrisChunks) {
      ctx.fillStyle = '#475569';
      for (const chunk of sector.debrisChunks) {
        const p = project3D(chunk.pos || chunk);
        ctx.fillRect(p.ex - 0.75, p.ey - 0.75, 1.5, 1.5);
      }
    }

    // Own Ship
    if (myShip && !myShip.destroyed) {
      const p = project3D(myShip.pos);
      const sAngle = myShip.angle || 0;
      const myColor = myTeam === 'alpha' ? '#38bdf8' : '#f43f5e';

      drawStem(p, myColor);

      // Camera FOV cone (60° forward)
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p.ex, p.ey);
      ctx.arc(p.ex, p.ey, 24, sAngle - Math.PI / 6, sAngle + Math.PI / 6);
      ctx.closePath();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fill();
      ctx.restore();

      // Own Ship Chevron pointing myShip.angle
      ctx.save();
      ctx.translate(p.ex, p.ey);
      ctx.rotate(sAngle);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-4, -3.5);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, 3.5);
      ctx.closePath();
      ctx.fillStyle = myColor;
      ctx.fill();
      ctx.restore();

      // Elevation text tag
      if (Math.abs(p.z) > 25 && typeof ctx.fillText === 'function') {
        ctx.save();
        ctx.fillStyle = myColor;
        ctx.font = '8px monospace';
        const zSign = p.z > 0 ? '+' : '';
        ctx.fillText(`${zSign}${Math.round(p.z)}m`, p.ex + 7, p.ey - 3);
        ctx.restore();
      }
    }

    // Enemy Ship — ONLY WHEN myShip.targetAvailable IS TRUE AND ENEMY IS NOT JUMPING!
    const enemyTeam = myTeam === 'alpha' ? 'omega' : 'alpha';
    const enemyShip = ships[enemyTeam];
    const enemyJumping = enemyShip?.hyperspace?.state === 'jumping';
    const canSeeEnemy = !enemyJumping && (myShip ? myShip.targetAvailable !== false : true);

    if (enemyShip && !enemyShip.destroyed && canSeeEnemy) {
      const ep = project3D(enemyShip.pos);
      const enemyColor = enemyTeam === 'alpha' ? '#38bdf8' : '#f43f5e';

      drawStem(ep, enemyColor);

      ctx.save();
      ctx.beginPath();
      ctx.arc(ep.ex, ep.ey, 3, 0, Math.PI * 2);
      ctx.fillStyle = enemyColor;
      ctx.fill();

      // Pulsing ring around enemy
      ctx.beginPath();
      ctx.arc(ep.ex, ep.ey, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = enemyColor;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Relative delta Z readout
      const dz = (enemyShip.pos?.z || 0) - (myShip?.pos?.z || 0);
      if (Math.abs(dz) > 20 && typeof ctx.fillText === 'function') {
        ctx.fillStyle = enemyColor;
        ctx.font = '8px monospace';
        const dzSign = dz > 0 ? '+' : '';
        ctx.fillText(`ΔZ ${dzSign}${Math.round(dz)}m`, ep.ex + 7, ep.ey - 3);
      }
      ctx.restore();
    }

    ctx.restore();
  }
}
