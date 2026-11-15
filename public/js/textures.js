/**
 * BROADSIDE HYPERION — Procedural PBR Bitmap Skinning Library
 *
 * Generates deterministic, headless-safe RGBA THREE.DataTexture bitmaps
 * (diffuse `map`, height `bumpMap`, `roughnessMap`, and `emissiveMap`) for every
 * 3D model in the game:
 *  - Asteroids & surface boulders (multi-scale impact craters, ejecta rays,
 *    and deep branching tectonic fissures)
 *  - Crystal ore veins & luminous rock fractures
 *  - Capital Starships (hull plating, ablative armor, team livery, mechanical
 *    greeble trenches, armored bridge canopy, engine nozzles, radiators, shields, plumes)
 *  - Wreckage debris chunks, spiked tether mines, orbital munitions derelict
 *    (industrial cargo plating, hazard stripes, photovoltaic solar wings),
 *    arena beacon pylons, accretion disks, ion nebulae, and homing torpedoes
 *
 * 100% pure Uint8Array math — zero DOM / Canvas / Image calls (Vitest Node safe).
 * Every bitmap set is cached at module scope for O(1) reuse across frames and tests.
 */

import * as THREE from 'three';

// --- DETERMINISTIC HASH, PRNG & NOISE PRIMITIVES ---

function clampByte(v) {
  return v <= 0 ? 0 : (v >= 255 ? 255 : (v + 0.5) | 0);
}

function clamp01(v) {
  return v <= 0 ? 0 : (v >= 1 ? 1 : v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function fract(x) {
  return x - Math.floor(x);
}

function hashInt3(ix, iy, iz, seed = 0) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 2147483647) + Math.imul(seed, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function hashInt2(ix, iy, seed = 0) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1597334677)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function createPrng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Continuous 3D lattice value noise in [0, 1].
 */
function noise3D(x, y, z, seed = 1) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hashInt3(ix, iy, iz, seed);
  const n100 = hashInt3(ix + 1, iy, iz, seed);
  const n010 = hashInt3(ix, iy + 1, iz, seed);
  const n110 = hashInt3(ix + 1, iy + 1, iz, seed);
  const n001 = hashInt3(ix, iy, iz + 1, seed);
  const n101 = hashInt3(ix + 1, iy, iz + 1, seed);
  const n011 = hashInt3(ix, iy + 1, iz + 1, seed);
  const n111 = hashInt3(ix + 1, iy + 1, iz + 1, seed);

  const nx00 = lerp(n000, n100, ux);
  const nx10 = lerp(n010, n110, ux);
  const nx01 = lerp(n001, n101, ux);
  const nx11 = lerp(n011, n111, ux);

  const nxy0 = lerp(nx00, nx10, uy);
  const nxy1 = lerp(nx01, nx11, uy);

  return lerp(nxy0, nxy1, uz);
}

/**
 * 3D Fractal Brownian Motion in [0, 1].
 */
function fbm3D(x, y, z, seed = 1, octaves = 4) {
  let value = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    value += amp * noise3D(x * freq, y * freq, z * freq, seed + o * 97);
    norm += amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return value / norm;
}

/**
 * 3D Voronoi cellular fracture field returning [f1, f2, edgeDist].
 * `edgeDist = f2 - f1` approaches 0 along sharp branching tectonic fissures.
 */
function voronoi3D(x, y, z, seed = 17) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);

  let f1 = 999.0;
  let f2 = 999.0;

  for (let dz = -1; dz <= 1; dz++) {
    const cz = iz + dz;
    for (let dy = -1; dy <= 1; dy++) {
      const cy = iy + dy;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx;
        const px = cx + 0.15 + 0.7 * hashInt3(cx, cy, cz, seed);
        const py = cy + 0.15 + 0.7 * hashInt3(cx, cy, cz, seed + 131);
        const pz = cz + 0.15 + 0.7 * hashInt3(cx, cy, cz, seed + 257);

        const rx = px - x;
        const ry = py - y;
        const rz = pz - z;
        const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);

        if (dist < f1) {
          f2 = f1;
          f1 = dist;
        } else if (dist < f2) {
          f2 = dist;
        }
      }
    }
  }

  return { f1, f2, edgeDist: f2 - f1 };
}

/**
 * Seamless periodic 2D lattice noise over [0, 1) UV space.
 */
function noise2DPeriodic(u, v, periodX, periodY, seed = 1) {
  const gx = fract(u) * periodX;
  const gy = fract(v) * periodY;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const ix0 = ((x0 % periodX) + periodX) % periodX;
  const iy0 = ((y0 % periodY) + periodY) % periodY;
  const ix1 = (ix0 + 1) % periodX;
  const iy1 = (iy0 + 1) % periodY;

  const n00 = hashInt2(ix0, iy0, seed);
  const n10 = hashInt2(ix1, iy0, seed);
  const n01 = hashInt2(ix0, iy1, seed);
  const n11 = hashInt2(ix1, iy1, seed);

  return lerp(lerp(n00, n10, ux), lerp(n01, n11, ux), uy);
}

/**
 * Seamless periodic 2D Fractal Brownian Motion over [0, 1) UV space.
 */
function fbm2DPeriodic(u, v, basePeriod = 8, seed = 1, octaves = 4) {
  let value = 0;
  let amp = 0.5;
  let p = basePeriod;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    value += amp * noise2DPeriodic(u, v, p, p, seed + o * 53);
    norm += amp;
    p *= 2;
    amp *= 0.5;
  }
  return value / norm;
}

// --- DATA TEXTURE & GEOMETRY UV HELPERS ---

/**
 * Wraps an RGBA Uint8Array into a configured THREE.DataTexture.
 */
export function createBitmapDataTexture(data, width, height, options = {}) {
  const {
    wrapS = THREE.RepeatWrapping,
    wrapT = THREE.RepeatWrapping,
    repeatX = 1,
    repeatY = 1,
    srgb = false,
    anisotropy = 4,
  } = options;

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = wrapS;
  texture.wrapT = wrapT;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeatX !== 1 || repeatY !== 1) {
    texture.repeat.set(repeatX, repeatY);
  }
  texture.needsUpdate = true;
  return texture;
}

/**
 * Normalizes world-unit UVs on ExtrudeGeometry / custom BufferGeometry into
 * consistent tiling space matching BoxGeometry panels.
 */
export function normalizeGeometryUVs(geometry, scale = 0.025) {
  if (!geometry || !geometry.attributes || !geometry.attributes.uv) return geometry;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * scale, uv.getY(i) * scale);
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Generates seamless equirectangular spherical UVs from vertex positions
 * on non-indexed polyhedral geometries (IcosahedronGeometry, DodecahedronGeometry),
 * correcting longitudinal wrap triangles crossing u = 0 / 1.
 */
export function applySphericalUVs(geometry) {
  if (!geometry || !geometry.attributes || !geometry.attributes.position) return geometry;

  const pos = geometry.attributes.position;
  const uvs = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i);
    const vy = pos.getY(i);
    const vz = pos.getZ(i);
    const len = Math.hypot(vx, vy, vz) || 1;
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;

    const u = Math.atan2(ny, nx) / (Math.PI * 2) + 0.5;
    const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, nz))) / Math.PI;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  // Fix longitude seam wrap per triangle (when geometry is non-indexed)
  if (!geometry.index) {
    for (let i = 0; i + 2 < pos.count; i += 3) {
      const u0 = uvs[i * 2];
      const u1 = uvs[(i + 1) * 2];
      const u2 = uvs[(i + 2) * 2];
      const maxU = Math.max(u0, u1, u2);
      const minU = Math.min(u0, u1, u2);
      if (maxU - minU > 0.5) {
        if (u0 < 0.5) uvs[i * 2] = u0 + 1.0;
        if (u1 < 0.5) uvs[(i + 1) * 2] = u1 + 1.0;
        if (u2 < 0.5) uvs[(i + 2) * 2] = u2 + 1.0;
      }
    }
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.attributes.uv.needsUpdate = true;
  return geometry;
}

// --- MODULE-SCOPE CACHE ---
const cache = {
  hullBump: null,
  shipHull: null,
  armorPlate: null,
  teamLivery: new Map(),
  greeble: null,
  canopy: new Map(),
  nozzle: null,
  radiator: null,
  shieldHex: null,
  plumePlasma: null,
  asteroids: new Map(),
  oreCrystals: new Map(),
  debris: null,
  mine: null,
  derelictHull: null,
  solarPanel: null,
  hazardStripe: null,
  accretionDisk: null,
  nebulaCloud: null,
  torpedo: null,
};

// --- 1. ASTEROID CRATER & FISSURE BITMAPS (4 VARIANTS) ---

const ASTEROID_PALETTES = [
  // 0: Silicate basalt (slate-grey with pale mineral dust & dark obsidian chasms)
  { base: [122, 128, 138], dark: [48, 52, 60], ejecta: [188, 194, 202], warmTint: [148, 134, 120] },
  // 1: Carbonaceous chondrite (deep charcoal-umber with pale rim fractures)
  { base: [104, 102, 108], dark: [38, 38, 44], ejecta: [168, 166, 170], warmTint: [132, 114, 102] },
  // 2: Iron-nickel metallic asteroid (cool gunmetal-slate with silvery fractures)
  { base: [128, 138, 152], dark: [50, 58, 70], ejecta: [204, 214, 226], warmTint: [142, 150, 164] },
  // 3: Olivine chondrite (warm mineral grey-brown with chalky impact rays)
  { base: [124, 120, 112], dark: [46, 44, 40], ejecta: [186, 180, 168], warmTint: [152, 138, 112] },
];

/**
 * Generates and caches a 256x128 seamless equirectangular bitmap set for asteroids:
 * - Multi-scale impact craters (46 craters: macro, medium, micro-pitting) with
 *   bowls, central peaks on large craters, terraced walls, raised rims, and ejecta rays
 * - Deep branching tectonic fissures via warped 3D Voronoi fracture borders
 * - Realistic regolith grain & roughness contrast
 *
 * @param {number} [variantIndex=0]
 * @returns {{ map: THREE.DataTexture, bumpMap: THREE.DataTexture, roughnessMap: THREE.DataTexture }}
 */
export function getAsteroidSkinBitmaps(variantIndex = 0) {
  const vIdx = ((variantIndex | 0) % ASTEROID_PALETTES.length + ASTEROID_PALETTES.length) % ASTEROID_PALETTES.length;
  if (cache.asteroids.has(vIdx)) return cache.asteroids.get(vIdx);

  const width = 256;
  const height = 128;
  const mapData = new Uint8Array(width * height * 4);
  const bumpData = new Uint8Array(width * height * 4);
  const roughData = new Uint8Array(width * height * 4);

  const rng = createPrng(0xA57E0001 + vIdx * 7919);
  const palette = ASTEROID_PALETTES[vIdx];

  // Generate seeded craters (macro, medium, micro) on unit sphere
  const craters = [];
  const tierSpecs = [
    { count: 9, minR: 0.22, maxR: 0.36, minD: 0.55, maxD: 0.85, hasRays: true },
    { count: 16, minR: 0.10, maxR: 0.20, minD: 0.35, maxD: 0.60, hasRays: false },
    { count: 24, minR: 0.04, maxR: 0.09, minD: 0.20, maxD: 0.40, hasRays: false },
  ];

  for (const tier of tierSpecs) {
    for (let c = 0; c < tier.count; c++) {
      const theta = rng() * Math.PI * 2;
      const cosPhi = 2 * rng() - 1;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      const nx = sinPhi * Math.cos(theta);
      const ny = sinPhi * Math.sin(theta);
      const nz = cosPhi;
      const rad = lerp(tier.minR, tier.maxR, rng());
      const depth = lerp(tier.minD, tier.maxD, rng());

      // Tangent frame for fast radial ejecta rays without acos
      let tx = -ny;
      let ty = nx;
      let tz = 0;
      const tLen = Math.hypot(tx, ty);
      if (tLen < 1e-4) {
        tx = 1; ty = 0; tz = 0;
      } else {
        tx /= tLen; ty /= tLen;
      }
      const bx = ny * tz - nz * ty;
      const by = nz * tx - nx * tz;
      const bz = nx * ty - ny * tx;

      // Angular chord thresholds: d^2 = 2 - 2*cos(theta)
      const outerR = tier.hasRays ? rad * 2.15 : rad * 1.38;
      const maxChordSq = 2 - 2 * Math.cos(Math.min(Math.PI, outerR));
      const rimChord = 2 * Math.sin(rad * 0.5);

      craters.push({
        nx, ny, nz,
        tx, ty, tz,
        bx, by, bz,
        rad,
        depth,
        hasRays: tier.hasRays,
        raySeed: rng() * 100,
        maxChordSq,
        rimChord,
      });
    }
  }

  const seedMacro = 101 + vIdx * 313;
  const seedFrac1 = 409 + vIdx * 521;
  const seedFrac2 = 911 + vIdx * 733;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const lat = (v - 0.5) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const lon = (u - 0.5) * Math.PI * 2;
      const sx = cosLat * Math.cos(lon);
      const sy = cosLat * Math.sin(lon);
      const sz = sinLat;

      // 1. Multi-octave rocky regolith relief
      const fbmCoarse = fbm3D(sx * 2.8 + 11.3, sy * 2.8 + 5.7, sz * 2.8 + 19.1, seedMacro, 4);
      const fbmFine = fbm3D(sx * 11.5, sy * 11.5, sz * 11.5, seedMacro + 50, 3);
      const speckle = hashInt3((sx * 160) | 0, (sy * 160) | 0, (sz * 160) | 0, seedMacro + 99);

      let elev = 0.52 + (fbmCoarse - 0.5) * 0.30 + (fbmFine - 0.5) * 0.14;
      let ejectaBright = 0;
      let bowlDarken = 0;
      let craterRimHighlight = 0;

      // 2. Accumulate multi-scale impact craters
      for (let c = 0; c < craters.length; c++) {
        const cr = craters[c];
        const dx = sx - cr.nx;
        const dy = sy - cr.ny;
        const dz = sz - cr.nz;
        const chordSq = dx * dx + dy * dy + dz * dz;
        if (chordSq > cr.maxChordSq) continue;

        const chord = Math.sqrt(chordSq);
        const rn = chord / cr.rimChord;

        if (rn < 1.0) {
          // Inside crater bowl & terraced inner wall
          const bowlProfile = 1.0 - rn * rn;
          let drop = cr.depth * 0.52 * bowlProfile;

          // Subtle concentric wall terrace step around rn ~ 0.78
          const terrace = Math.exp(-Math.pow((rn - 0.78) / 0.08, 2)) * 0.08 * cr.depth;
          drop -= terrace;

          // Central rebound peak on large craters
          if (cr.hasRays && rn < 0.24) {
            const peak = (1.0 - rn / 0.24);
            drop -= peak * peak * cr.depth * 0.22;
          }

          elev -= drop;
          bowlDarken = Math.max(bowlDarken, smoothstep(0.95, 0.25, rn) * 0.42);
        } else if (rn < 1.38) {
          // Raised ejecta crater rim
          const rimT = (rn - 1.0) / 0.38;
          const rimProfile = Math.sin((1.0 - rimT) * Math.PI * 0.5);
          const rimBoost = rimProfile * rimProfile * cr.depth * 0.28;
          elev += rimBoost;
          craterRimHighlight = Math.max(craterRimHighlight, rimProfile * 0.55);
        }

        // Radial ejecta rays for major craters
        if (cr.hasRays && rn >= 0.92 && rn < 2.15) {
          const projT = dx * cr.tx + dy * cr.ty + dz * cr.tz;
          const projB = dx * cr.bx + dy * cr.by + dz * cr.bz;
          const az = Math.atan2(projB, projT);
          const rayWave = Math.sin(az * 11.0 + cr.raySeed) * 0.5 + Math.sin(az * 23.0 - cr.raySeed * 1.7) * 0.5;
          if (rayWave > 0.2) {
            const falloff = 1.0 - smoothstep(0.92, 2.15, rn);
            ejectaBright = Math.max(ejectaBright, (rayWave - 0.2) * 0.65 * falloff);
          }
        }
      }

      // 3. Deep branching tectonic fissures via warped 3D Voronoi fractures
      const warpX = (fbmCoarse - 0.5) * 0.85 + (fbmFine - 0.5) * 0.25;
      const warpY = (fbm3D(sx * 3.1 + 4.1, sy * 3.1 + 9.2, sz * 3.1 + 2.3, seedFrac1, 3) - 0.5) * 0.85;
      const warpZ = (fbm3D(sx * 3.1 + 13.7, sy * 3.1 + 1.9, sz * 3.1 + 7.4, seedFrac2, 3) - 0.5) * 0.85;

      const vorMacro = voronoi3D((sx + warpX) * 2.5, (sy + warpY) * 2.5, (sz + warpZ) * 2.5, seedFrac1);
      const vorBranch = voronoi3D((sx + warpX * 0.6) * 5.2, (sy + warpY * 0.6) * 5.2, (sz + warpZ * 0.6) * 5.2, seedFrac2);

      // Primary tectonic chasm + secondary branching fissures
      const primaryFissure = 1.0 - smoothstep(0.015, 0.068, vorMacro.edgeDist);
      const branchFissure = (1.0 - smoothstep(0.010, 0.052, vorBranch.edgeDist)) * 0.68;
      const fissureMask = Math.max(primaryFissure, branchFissure);

      // Sharp fractured lip flanking the fissure
      const primaryLip = smoothstep(0.045, 0.075, vorMacro.edgeDist) * (1.0 - smoothstep(0.075, 0.12, vorMacro.edgeDist));
      const branchLip = smoothstep(0.035, 0.060, vorBranch.edgeDist) * (1.0 - smoothstep(0.060, 0.095, vorBranch.edgeDist)) * 0.6;
      const fissureLip = Math.max(primaryLip, branchLip);

      elev -= fissureMask * 0.58;
      elev += fissureLip * 0.14;
      elev += (speckle - 0.5) * 0.05;

      const heightVal = clamp01(elev);

      // 4. Photorealistic Rock Albedo Shading
      const strata = smoothstep(0.25, 0.78, fbmCoarse);
      let r = lerp(palette.dark[0], palette.base[0], strata);
      let g = lerp(palette.dark[1], palette.base[1], strata);
      let b = lerp(palette.dark[2], palette.base[2], strata);

      // Warm mineral patches
      const warmMix = smoothstep(0.55, 0.85, fbmFine) * 0.45;
      r = lerp(r, palette.warmTint[0], warmMix);
      g = lerp(g, palette.warmTint[1], warmMix);
      b = lerp(b, palette.warmTint[2], warmMix);

      // Fine crystalline / mineral dust speckle
      const grainDelta = (speckle - 0.5) * 26 + (fbmFine - 0.5) * 28;
      r += grainDelta;
      g += grainDelta;
      b += grainDelta;

      // Crater bowl shadow vs sun-bleached rim & ejecta rays
      r *= (1.0 - bowlDarken * 0.52);
      g *= (1.0 - bowlDarken * 0.52);
      b *= (1.0 - bowlDarken * 0.52);

      const lightMix = Math.max(craterRimHighlight * 0.65, ejectaBright * 0.75, fissureLip * 0.55);
      r = lerp(r, palette.ejecta[0], lightMix);
      g = lerp(g, palette.ejecta[1], lightMix);
      b = lerp(b, palette.ejecta[2], lightMix);

      // Deep dark chasm interior inside fissures
      if (fissureMask > 0.01) {
        r = lerp(r, 12, fissureMask * 0.92);
        g = lerp(g, 14, fissureMask * 0.92);
        b = lerp(b, 18, fissureMask * 0.92);
      }

      // 5. Roughness Map (dusty regolith rough ~0.92, fractured lips/metallic specks ~0.48)
      const metallicGlint = speckle > 0.94 ? 0.35 : 0;
      const roughVal = clamp01(
        0.86
        + bowlDarken * 0.08
        + fissureMask * 0.10
        - fissureLip * 0.24
        - craterRimHighlight * 0.16
        - metallicGlint
      );

      const idx = (y * width + x) * 4;
      mapData[idx] = clampByte(r);
      mapData[idx + 1] = clampByte(g);
      mapData[idx + 2] = clampByte(b);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  const bundle = {
    map: createBitmapDataTexture(mapData, width, height, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      srgb: true,
    }),
    bumpMap: createBitmapDataTexture(bumpData, width, height, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      srgb: false,
    }),
    roughnessMap: createBitmapDataTexture(roughData, width, height, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      srgb: false,
    }),
  };

  cache.asteroids.set(vIdx, bundle);
  return bundle;
}

// --- 2. CRYSTAL ORE VEIN & FISSURE BITMAPS ---

/**
 * Generates faceted crystalline ore bitmaps with luminous internal fracture veins.
 * @param {string} [oreType='gold'] - 'plasma_crystal' | 'titanium' | 'gold'
 */
export function getOreCrystalSkinBitmaps(oreType = 'gold') {
  const key = oreType === 'plasma_crystal' ? 'plasma_crystal' : (oreType === 'titanium' ? 'titanium' : 'gold');
  if (cache.oreCrystals.has(key)) return cache.oreCrystals.get(key);

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const emissiveData = new Uint8Array(size * size * 4);

  const colors = key === 'plasma_crystal'
    ? { core: [216, 160, 255], deep: [92, 33, 148], vein: [250, 220, 255] }
    : (key === 'titanium'
      ? { core: [152, 224, 255], deep: [30, 88, 130], vein: [224, 248, 255] }
      : { core: [255, 208, 86], deep: [130, 74, 16], vein: [255, 245, 190] });

  const seed = key === 'plasma_crystal' ? 701 : (key === 'titanium' ? 709 : 719);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n1 = fbm2DPeriodic(u, v, 6, seed, 3);
      const n2 = fbm2DPeriodic(u * 2, v * 2, 12, seed + 41, 2);

      // Sharp angular crystal cleavage planes
      const diag1 = Math.abs(fract(u * 5 + v * 3 + n1 * 0.25) - 0.5) * 2;
      const diag2 = Math.abs(fract(u * 3 - v * 6 + n2 * 0.2) - 0.5) * 2;
      const veinGlow = Math.pow(clamp01(1.0 - Math.min(diag1, diag2) * 3.2), 2.2);
      const facetShade = 0.45 + 0.55 * smoothstep(0.2, 0.85, diag1 * 0.6 + diag2 * 0.4);

      const r = lerp(lerp(colors.deep[0], colors.core[0], facetShade), colors.vein[0], veinGlow);
      const g = lerp(lerp(colors.deep[1], colors.core[1], facetShade), colors.vein[1], veinGlow);
      const b = lerp(lerp(colors.deep[2], colors.core[2], facetShade), colors.vein[2], veinGlow);

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(r);
      mapData[idx + 1] = clampByte(g);
      mapData[idx + 2] = clampByte(b);
      mapData[idx + 3] = 255;

      const hByte = clampByte((0.4 + facetShade * 0.45 + veinGlow * 0.15) * 255);
      bumpData[idx] = hByte;
      bumpData[idx + 1] = hByte;
      bumpData[idx + 2] = hByte;
      bumpData[idx + 3] = 255;

      const emFactor = 0.25 + veinGlow * 0.75;
      emissiveData[idx] = clampByte(colors.vein[0] * emFactor);
      emissiveData[idx + 1] = clampByte(colors.vein[1] * emFactor);
      emissiveData[idx + 2] = clampByte(colors.vein[2] * emFactor);
      emissiveData[idx + 3] = 255;
    }
  }

  const bundle = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    emissiveMap: createBitmapDataTexture(emissiveData, size, size, { srgb: true }),
  };
  cache.oreCrystals.set(key, bundle);
  return bundle;
}

// --- 3. STARSHIP HULL, ARMOR, LIVERY, GREEBLE, CANOPY, NOZZLE & SHIELD BITMAPS ---

/**
 * High-detail 256x256 procedural hull panel heightmap DataTexture (exported for backwards compat).
 * @returns {THREE.DataTexture}
 */
export function getHullPanelDataTexture() {
  if (cache.hullBump) return cache.hullBump;
  return getShipHullSkinBitmaps().bumpMap;
}

/**
 * Generates interlocking spacecraft hull plating bitmaps (256x256):
 * staggered rectangular armor tiles, recessed dark panel seams, micro-rivets,
 * inspection hatches, directional brushed titanium grain, and micrometeoroid weathering.
 */
export function getShipHullSkinBitmaps() {
  if (cache.shipHull) return cache.shipHull;

  const size = 256;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      // Primary 64x32 staggered aerospace hull plates
      const cellRow = Math.floor(y / 32);
      const staggerX = (cellRow % 2 === 1) ? 32 : 0;
      const sx = (x + staggerX) % size;
      const cellCol = Math.floor(sx / 64);

      const lx = sx % 64;
      const ly = y % 32;

      // Secondary sub-panel seam at lx == 32 on alternating plates
      const hasSubSeam = ((cellRow + cellCol) % 3 === 0);
      const isPrimarySeam = lx === 0 || lx === 63 || ly === 0 || ly === 31;
      const isSubSeam = hasSubSeam && (lx === 31 || lx === 32);
      const isBevelHighlight = !isPrimarySeam && (lx === 1 || ly === 1 || (hasSubSeam && lx === 33));
      const isBevelShadow = !isPrimarySeam && (lx === 62 || ly === 30 || (hasSubSeam && lx === 30));

      // Micro-rivets along inner plate borders
      const isRivetRowY = (ly === 3 || ly === 28) && (lx % 8 === 4) && lx >= 4 && lx <= 60;
      const isRivetColX = (lx === 3 || lx === 60) && (ly % 8 === 4) && ly >= 4 && ly <= 28;
      const isRivet = isRivetRowY || isRivetColX;

      // Service hatch / vent inset on select plates
      const isHatchPlate = ((cellRow * 7 + cellCol * 13) % 5 === 0);
      const isHatchBorder = isHatchPlate && ((lx === 14 || lx === 46) && ly >= 8 && ly <= 23 || (ly === 8 || ly === 23) && lx >= 14 && lx <= 46);
      const isHatchInside = isHatchPlate && lx > 14 && lx < 46 && ly > 8 && ly < 23;

      // Per-panel tonal variation + brushed longitudinal alloy streaks
      const plateTone = hashInt2(cellCol, cellRow, 31) * 0.24;
      const brushNoise = fbm2DPeriodic(u * 0.5, v * 3.0, 16, 47, 3);
      const microGrain = hashInt2(x, y, 89) * 0.04;
      const grime = fbm2DPeriodic(u, v, 8, 113, 3);

      let lum = 0.52 + plateTone + (brushNoise - 0.5) * 0.14 - grime * 0.12 + microGrain;
      let heightVal = 0.55 + plateTone * 0.4 + (brushNoise - 0.5) * 0.08;
      let roughVal = 0.40 + grime * 0.25 + (1 - plateTone) * 0.12;

      if (isHatchInside) {
        lum *= 0.88;
        heightVal -= 0.08;
        if (ly % 3 === 0) {
          lum *= 0.85;
          heightVal -= 0.06;
        }
      }

      if (isPrimarySeam || isSubSeam || isHatchBorder) {
        lum = 0.16;
        heightVal = 0.10;
        roughVal = 0.85;
      } else if (isBevelHighlight) {
        lum += 0.14;
        heightVal += 0.14;
        roughVal -= 0.10;
      } else if (isBevelShadow) {
        lum -= 0.10;
        heightVal -= 0.10;
      } else if (isRivet) {
        lum += 0.18;
        heightVal += 0.24;
        roughVal = 0.26;
      }

      const idx = (y * size + x) * 4;
      // Cool aerospace gunmetal-slate RGB balance
      mapData[idx] = clampByte(lum * 212);
      mapData[idx + 1] = clampByte(lum * 224);
      mapData[idx + 2] = clampByte(lum * 242);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.hullBump = createBitmapDataTexture(bumpData, size, size, { repeatX: 3, repeatY: 3, srgb: false });
  cache.shipHull = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 3, repeatY: 3, srgb: true }),
    bumpMap: cache.hullBump,
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 3, repeatY: 3, srgb: false }),
  };
  return cache.shipHull;
}

/**
 * Generates heavy ablative armor plating bitmaps (256x256) with beveled armor blocks,
 * corner bolts, weld seams, and battle-scuffed titanium sheen.
 */
export function getArmorPlateSkinBitmaps() {
  if (cache.armorPlate) return cache.armorPlate;

  const size = 256;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const cellX = Math.floor(x / 64);
      const cellY = Math.floor(y / 64);
      const lx = x % 64;
      const ly = y % 64;

      const edgeDist = Math.min(lx, 63 - lx, ly, 63 - ly);
      const isSeam = edgeDist === 0;
      const isChamfer = edgeDist >= 1 && edgeDist <= 3;

      // Corner heavy hex bolts
      const cx = lx < 32 ? 7 : 56;
      const cy = ly < 32 ? 7 : 56;
      const boltDist = Math.hypot(lx - cx, ly - cy);
      const isBolt = boltDist <= 2.3;

      const plateVar = hashInt2(cellX, cellY, 173) * 0.16;
      const brush = fbm2DPeriodic(u * 2.0, v * 0.5, 16, 211, 3);
      const scuff = fbm2DPeriodic(u, v, 12, 239, 3);

      let lum = 0.62 + plateVar + (brush - 0.5) * 0.12;
      let heightVal = 0.65 + plateVar * 0.3 + (brush - 0.5) * 0.06;
      let roughVal = 0.34 + scuff * 0.20;

      if (scuff > 0.72) {
        lum += 0.10;
        roughVal -= 0.12;
      }

      if (isSeam) {
        lum = 0.18;
        heightVal = 0.12;
        roughVal = 0.86;
      } else if (isChamfer) {
        const slopeDir = (lx <= 3 || ly <= 3) ? 0.12 : -0.09;
        lum += slopeDir;
        heightVal -= (4 - edgeDist) * 0.09;
      } else if (isBolt) {
        lum = 0.88;
        heightVal = 0.96;
        roughVal = 0.22;
      }

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(lum * 225);
      mapData[idx + 1] = clampByte(lum * 234);
      mapData[idx + 2] = clampByte(lum * 246);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.armorPlate = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 2, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
  };
  return cache.armorPlate;
}

/**
 * Generates painted military team accent livery with subtle stripes, panel seams, and edge wear.
 */
export function getTeamLiverySkinBitmaps(team = 'alpha') {
  const key = team === 'omega' ? 'omega' : 'alpha';
  if (cache.teamLivery.has(key)) return cache.teamLivery.get(key);

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const seed = key === 'omega' ? 509 : 401;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const isSeam = (x % 32 === 0) || (y % 32 === 0);
      const wear = fbm2DPeriodic(u, v, 8, seed, 3);
      const stripe = Math.abs(fract(u * 2 + v * 2) - 0.5) < 0.08;

      let lum = 0.85 + (wear - 0.5) * 0.18;
      let heightVal = 0.65;
      let roughVal = 0.30 + wear * 0.20;

      if (stripe) {
        lum *= 0.72;
        roughVal += 0.12;
      }
      if (isSeam) {
        lum = 0.30;
        heightVal = 0.15;
        roughVal = 0.82;
      }

      const idx = (y * size + x) * 4;
      const cByte = clampByte(lum * 255);
      mapData[idx] = cByte;
      mapData[idx + 1] = cByte;
      mapData[idx + 2] = cByte;
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  const bundle = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 2, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
  };
  cache.teamLivery.set(key, bundle);
  return bundle;
}

/**
 * Generates mechanical trench & greeble machinery bay bitmaps (256x256):
 * parallel pipe manifolds, ribbed cooling louvers, and recessed maintenance grates.
 */
export function getGreebleSkinBitmaps() {
  if (cache.greeble) return cache.greeble;

  const size = 256;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const blockX = Math.floor(x / 64);
      const blockY = Math.floor(y / 64);
      const lx = x % 64;
      const ly = y % 64;

      const mode = (blockX + blockY * 2) % 3;
      const grime = fbm2DPeriodic(u, v, 8, 613, 3);
      let lum = 0.40;
      let heightVal = 0.35;
      let roughVal = 0.65;

      if (mode === 0) {
        // Parallel hydraulic conduit pipes
        const pipePhase = (ly % 16) / 16;
        const pipeCurve = Math.sin(pipePhase * Math.PI);
        const clampBand = (lx === 16 || lx === 17 || lx === 48 || lx === 49);
        lum = 0.25 + pipeCurve * 0.48 + (clampBand ? 0.15 : 0);
        heightVal = 0.20 + pipeCurve * 0.65 + (clampBand ? 0.12 : 0);
        roughVal = 0.72 - pipeCurve * 0.38;
      } else if (mode === 1) {
        // Louvered radiator / intake vent slats
        const slat = (lx % 8) < 5;
        lum = slat ? 0.56 : 0.14;
        heightVal = slat ? 0.72 : 0.12;
        roughVal = slat ? 0.45 : 0.90;
      } else {
        // Perforated industrial deck grating
        const gridHole = ((lx % 12) >= 3 && (lx % 12) <= 9) && ((ly % 12) >= 3 && (ly % 12) <= 9);
        lum = gridHole ? 0.15 : 0.58;
        heightVal = gridHole ? 0.10 : 0.78;
        roughVal = gridHole ? 0.92 : 0.48;
      }

      if (lx === 0 || ly === 0 || lx === 63 || ly === 63) {
        lum = 0.64;
        heightVal = 0.85;
        roughVal = 0.42;
      }

      lum = clamp01(lum * (1.0 - grime * 0.22));
      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(lum * 205);
      mapData[idx + 1] = clampByte(lum * 218);
      mapData[idx + 2] = clampByte(lum * 235);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.greeble = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 2, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
  };
  return cache.greeble;
}

/**
 * Generates armored bridge viewport glass with dark structural mullions & glowing interior console panes.
 */
export function getCanopyGlassSkinBitmaps(team = 'alpha') {
  const key = team === 'omega' ? 'omega' : 'alpha';
  if (cache.canopy.has(key)) return cache.canopy.get(key);

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const emissiveData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const isStrut = (x % 32 < 3) || (y % 64 < 4);
      const consoleGlow = 0.55 + 0.45 * Math.sin(v * Math.PI) * (0.7 + 0.3 * hashInt2(x >> 2, y >> 2, 91));

      const idx = (y * size + x) * 4;
      if (isStrut) {
        mapData[idx] = 40;
        mapData[idx + 1] = 48;
        mapData[idx + 2] = 58;
        mapData[idx + 3] = 255;

        bumpData[idx] = 240;
        bumpData[idx + 1] = 240;
        bumpData[idx + 2] = 240;
        bumpData[idx + 3] = 255;

        emissiveData[idx] = 0;
        emissiveData[idx + 1] = 0;
        emissiveData[idx + 2] = 0;
        emissiveData[idx + 3] = 255;
      } else {
        const glassByte = clampByte((0.68 + consoleGlow * 0.30) * 255);
        mapData[idx] = glassByte;
        mapData[idx + 1] = glassByte;
        mapData[idx + 2] = glassByte;
        mapData[idx + 3] = 255;

        bumpData[idx] = 75;
        bumpData[idx + 1] = 75;
        bumpData[idx + 2] = 75;
        bumpData[idx + 3] = 255;

        const emByte = clampByte(consoleGlow * 235);
        emissiveData[idx] = emByte;
        emissiveData[idx + 1] = emByte;
        emissiveData[idx + 2] = emByte;
        emissiveData[idx + 3] = 255;
      }
    }
  }

  const bundle = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    emissiveMap: createBitmapDataTexture(emissiveData, size, size, { srgb: true }),
  };
  cache.canopy.set(key, bundle);
  return bundle;
}

/**
 * Generates heat-treated thruster bell & gun barrel bitmaps (128x128):
 * axial regenerative cooling ribs, circumferential stress bands, and carbon exhaust scoring.
 */
export function getNozzleSkinBitmaps() {
  if (cache.nozzle) return cache.nozzle;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Axial cooling channels along cylinder circumference (u) & rings along v
      const rib = 0.5 + 0.5 * Math.sin(u * Math.PI * 32);
      const band = (y % 32 < 3) ? 1.0 : 0.0;
      const heatScorch = smoothstep(0.55, 1.0, v) * 0.45;
      const microNoise = fbm2DPeriodic(u, v, 12, 811, 2);

      let lum = 0.46 + rib * 0.22 + band * 0.16 - heatScorch * 0.24 + (microNoise - 0.5) * 0.10;
      const heightVal = 0.35 + rib * 0.40 + band * 0.25;
      const roughVal = 0.36 + (1 - rib) * 0.24 + heatScorch * 0.30;

      // Subtle heat-blued & bronze temper tint
      const r = lum * (195 + heatScorch * 35);
      const g = lum * (205 - heatScorch * 15);
      const b = lum * (222 - heatScorch * 40);

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(r);
      mapData[idx + 1] = clampByte(g);
      mapData[idx + 2] = clampByte(b);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.nozzle = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { srgb: false }),
  };
  return cache.nozzle;
}

/**
 * Generates thermal radiator fin array bitmaps (128x128) with micro louver channels.
 */
export function getRadiatorSkinBitmaps() {
  if (cache.radiator) return cache.radiator;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fin = (x % 8 < 5);
      const manifold = (y < 10 || y > 118 || (y > 58 && y < 70));
      const lum = manifold ? 0.72 : (fin ? 0.55 : 0.18);
      const hVal = manifold ? 0.88 : (fin ? 0.70 : 0.15);
      const rVal = manifold ? 0.35 : (fin ? 0.42 : 0.85);

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(lum * 220);
      mapData[idx + 1] = clampByte(lum * 215);
      mapData[idx + 2] = clampByte(lum * 210);
      mapData[idx + 3] = 255;

      const bByte = clampByte(hVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(rVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.radiator = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { srgb: false }),
  };
  return cache.radiator;
}

/**
 * Generates a subtle hexagonal deflector lattice bitmap for 3D energy shields.
 */
export function getShieldHexSkinBitmap() {
  if (cache.shieldHex) return cache.shieldHex;

  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const hexScale = 12.0;
  const sqrt3 = 1.7320508;

  for (let y = 0; y < size; y++) {
    const v = (y / size) * hexScale;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * hexScale;

      // 2D hexagonal distance field
      const px = u;
      const py = v;
      const rx = 1.0;
      const ry = sqrt3;
      const ax = Math.abs(fract(px / rx) - 0.5) * rx;
      const ay = Math.abs(fract(py / ry) - 0.5) * ry;
      const bx = Math.abs(fract(px / rx + 0.5) - 0.5) * rx;
      const by = Math.abs(fract(py / ry + 0.5) - 0.5) * ry;

      const dA = Math.hypot(ax, ay);
      const dB = Math.hypot(bx, by);
      const edgeDist = Math.abs(dA - dB);
      const hexLine = 1.0 - smoothstep(0.03, 0.14, edgeDist);
      const val = clampByte((0.52 + hexLine * 0.48) * 255);

      const idx = (y * size + x) * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }

  cache.shieldHex = createBitmapDataTexture(data, size, size, { repeatX: 3, repeatY: 2, srgb: true });
  return cache.shieldHex;
}

/**
 * Generates Mach shock-diamond plasma plume bitmap for thruster & engine cones.
 */
export function getPlumePlasmaSkinBitmap() {
  if (cache.plumePlasma) return cache.plumePlasma;

  const size = 128;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const shockDiamond = Math.pow(0.5 + 0.5 * Math.cos(v * Math.PI * 8), 2);
      const filament = 0.7 + 0.3 * Math.sin(u * Math.PI * 16 + v * 6);
      const falloff = smoothstep(0.0, 0.25, v) * (1.0 - smoothstep(0.65, 1.0, v) * 0.4);
      const intensity = clamp01(0.55 + shockDiamond * 0.35 * filament * falloff);
      const byte = clampByte(intensity * 255);

      const idx = (y * size + x) * 4;
      data[idx] = byte;
      data[idx + 1] = byte;
      data[idx + 2] = byte;
      data[idx + 3] = 255;
    }
  }

  cache.plumePlasma = createBitmapDataTexture(data, size, size, { srgb: true });
  return cache.plumePlasma;
}

// --- 4. DEBRIS, TETHER MINES, MUNITIONS DERELICT, SOLAR PANELS, ACCRETION & TORPEDOES ---

/**
 * Generates scorched, battle-torn wreckage alloy bitmaps (128x128).
 */
export function getDebrisSkinBitmaps() {
  if (cache.debris) return cache.debris;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const scorch = fbm2DPeriodic(u, v, 6, 941, 4);
      const scratch = fbm2DPeriodic(u * 4, v * 0.7, 8, 953, 2);
      const isSeam = (x % 32 === 0) || (y % 32 === 0);
      const isChar = scorch > 0.56;

      let lum = 0.60 + (scratch - 0.5) * 0.22;
      let heightVal = 0.55 + (scratch - 0.5) * 0.25;
      let roughVal = 0.52 + scorch * 0.38;

      if (isChar) {
        lum *= lerp(1.0, 0.32, (scorch - 0.56) / 0.44);
        heightVal -= 0.14;
      }
      if (isSeam) {
        lum = 0.20;
        heightVal = 0.15;
        roughVal = 0.90;
      }

      const idx = (y * size + x) * 4;
      // Subtle burnt rust/carbon tint in scorched regions
      mapData[idx] = clampByte(lum * (isChar ? 195 : 210));
      mapData[idx + 1] = clampByte(lum * (isChar ? 175 : 215));
      mapData[idx + 2] = clampByte(lum * (isChar ? 165 : 225));
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.debris = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { srgb: false }),
  };
  return cache.debris;
}

/**
 * Generates naval magnetic tether mine casing bitmaps (128x128).
 */
export function getMineSkinBitmaps() {
  if (cache.mine) return cache.mine;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wear = fbm2DPeriodic(u, v, 8, 1021, 3);
      const isWeldSeam = (y % 32 < 2) || (x % 32 < 2);
      const isRivet = (y % 32 === 5 || y % 32 === 26) && (x % 8 === 4);
      const redBand = (v > 0.44 && v < 0.56) && ((x >> 3) % 2 === 0);

      let lum = 0.48 + (wear - 0.5) * 0.18;
      let heightVal = 0.52 + (wear - 0.5) * 0.12;
      let roughVal = 0.44 + wear * 0.25;

      if (isWeldSeam) {
        lum = 0.24;
        heightVal = 0.20;
        roughVal = 0.85;
      } else if (isRivet) {
        lum = 0.82;
        heightVal = 0.92;
        roughVal = 0.24;
      }

      const idx = (y * size + x) * 4;
      if (redBand && !isWeldSeam) {
        mapData[idx] = clampByte(lum * 245);
        mapData[idx + 1] = clampByte(lum * 85);
        mapData[idx + 2] = clampByte(lum * 75);
      } else {
        mapData[idx] = clampByte(lum * 195);
        mapData[idx + 1] = clampByte(lum * 208);
        mapData[idx + 2] = clampByte(lum * 224);
      }
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.mine = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { srgb: false }),
  };
  return cache.mine;
}

/**
 * Generates weathered orbital industrial station hull bitmaps (256x256)
 * for the Munitions Derelict and Arena Beacon Pylons.
 */
export function getDerelictHullSkinBitmaps() {
  if (cache.derelictHull) return cache.derelictHull;

  const size = 256;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const cellX = Math.floor(x / 64);
      const cellY = Math.floor(y / 32);
      const lx = x % 64;
      const ly = y % 32;

      const grime = fbm2DPeriodic(u, v, 8, 1201, 4);
      const rustNoise = fbm2DPeriodic(u * 2, v * 2, 16, 1217, 3);
      const isSeam = lx === 0 || lx === 63 || ly === 0 || ly === 31;
      const isRivet = (ly === 3 || ly === 28) && (lx % 8 === 4);
      const hasAmberStripe = (cellY === 2 || cellY === 6) && (ly >= 10 && ly <= 20);

      const plateVar = hashInt2(cellX, cellY, 333) * 0.22;
      let lum = 0.52 + plateVar - grime * 0.22;
      let heightVal = 0.55 + plateVar * 0.3 + (rustNoise - 0.5) * 0.12;
      let roughVal = 0.48 + grime * 0.36;

      if (isSeam) {
        lum = 0.16;
        heightVal = 0.12;
        roughVal = 0.90;
      } else if (isRivet) {
        lum += 0.18;
        heightVal += 0.24;
        roughVal = 0.30;
      }

      const rustBlend = smoothstep(0.62, 0.88, rustNoise) * 0.55;
      let r = lerp(lum * 195, lum * 175, rustBlend);
      let g = lerp(lum * 206, lum * 125, rustBlend);
      let b = lerp(lum * 222, lum * 90, rustBlend);

      if (hasAmberStripe && !isSeam) {
        r = lerp(r, 235 * lum, 0.7);
        g = lerp(g, 165 * lum, 0.7);
        b = lerp(b, 42 * lum, 0.7);
      }

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(r);
      mapData[idx + 1] = clampByte(g);
      mapData[idx + 2] = clampByte(b);
      mapData[idx + 3] = 255;

      const bByte = clampByte(heightVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(roughVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.derelictHull = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 2, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
  };
  return cache.derelictHull;
}

/**
 * Generates photovoltaic solar array wing bitmaps (256x256):
 * deep sapphire-blue silicon wafer cells, silver conductive busbars, and gold interconnects.
 */
export function getSolarPanelSkinBitmaps() {
  if (cache.solarPanel) return cache.solarPanel;

  const size = 256;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lx = x % 32;
      const ly = y % 64;
      const isFrame = lx <= 1 || lx >= 30 || ly <= 2 || ly >= 61;
      const isCornerCut = (lx + ly <= 4) || ((31 - lx) + ly <= 4) || (lx + (63 - ly) <= 4) || ((31 - lx) + (63 - ly) <= 4);
      const isBusbar = !isFrame && (lx === 10 || lx === 21);
      const isFinger = !isFrame && (ly % 8 === 0);

      let r = 24, g = 62, b = 152;
      let hVal = 0.45;
      let rVal = 0.14;

      if (isFrame) {
        r = 148; g = 160; b = 178;
        hVal = 0.85;
        rVal = 0.42;
      } else if (isCornerCut) {
        r = 212; g = 170; b = 68; // gold foil interconnect tabs
        hVal = 0.65;
        rVal = 0.25;
      } else if (isBusbar) {
        r = 198; g = 214; b = 232; // silver busbar
        hVal = 0.58;
        rVal = 0.20;
      } else if (isFinger) {
        r = 76; g = 118; b = 198;
        hVal = 0.50;
        rVal = 0.18;
      } else {
        // Subtle silicon wafer sheen variation
        const cellShade = 0.90 + 0.18 * hashInt2(x >> 5, y >> 6, 1301);
        r *= cellShade;
        g *= cellShade;
        b *= cellShade;
      }

      const idx = (y * size + x) * 4;
      mapData[idx] = clampByte(r);
      mapData[idx + 1] = clampByte(g);
      mapData[idx + 2] = clampByte(b);
      mapData[idx + 3] = 255;

      const bByte = clampByte(hVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(rVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.solarPanel = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 2, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { repeatX: 2, repeatY: 2, srgb: false }),
  };
  return cache.solarPanel;
}

/**
 * Generates weathered industrial black-and-amber caution chevron stripes (128x128).
 */
export function getHazardStripeSkinBitmaps() {
  if (cache.hazardStripe) return cache.hazardStripe;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wear = fbm2DPeriodic(u, v, 10, 1409, 3);
      const diag = fract(u * 4 + v * 4);
      const isAmber = diag < 0.5;
      const borderEdge = Math.abs(diag - 0.5) < 0.02 || diag < 0.02;

      const scuff = wear > 0.68 ? 0.65 : (0.85 + (wear - 0.5) * 0.25);
      const idx = (y * size + x) * 4;

      if (isAmber) {
        mapData[idx] = clampByte(245 * scuff);
        mapData[idx + 1] = clampByte(162 * scuff);
        mapData[idx + 2] = clampByte(24 * scuff);
      } else {
        mapData[idx] = clampByte(34 * scuff);
        mapData[idx + 1] = clampByte(38 * scuff);
        mapData[idx + 2] = clampByte(44 * scuff);
      }
      mapData[idx + 3] = 255;

      const bByte = clampByte((borderEdge ? 0.35 : (isAmber ? 0.65 : 0.52)) * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;
    }
  }

  cache.hazardStripe = {
    map: createBitmapDataTexture(mapData, size, size, { repeatX: 2, repeatY: 1, srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { repeatX: 2, repeatY: 1, srgb: false }),
  };
  return cache.hazardStripe;
}

/**
 * Generates swirling relativistic plasma vortex bitmap (256x256) for black hole accretion disks.
 */
export function getAccretionDiskSkinBitmap() {
  if (cache.accretionDisk) return cache.accretionDisk;

  const size = 256;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const swirl = fbm2DPeriodic(u + v * 0.5, v, 8, 1601, 4);
      const band = 0.5 + 0.5 * Math.sin(v * Math.PI * 10 + swirl * 6.0);
      const filament = smoothstep(0.25, 0.9, band * 0.65 + swirl * 0.55);

      const r = lerp(95, 255, filament);
      const g = lerp(45, 215, filament * filament);
      const b = lerp(195, 255, filament);

      const idx = (y * size + x) * 4;
      data[idx] = clampByte(r);
      data[idx + 1] = clampByte(g);
      data[idx + 2] = clampByte(b);
      data[idx + 3] = 255;
    }
  }

  cache.accretionDisk = createBitmapDataTexture(data, size, size, { repeatX: 3, repeatY: 1, srgb: true });
  return cache.accretionDisk;
}

/**
 * Generates turbulent ionized gas cloud filament bitmap (128x128) for Ion Storm Nebulae.
 */
export function getNebulaCloudSkinBitmap() {
  if (cache.nebulaCloud) return cache.nebulaCloud;

  const size = 128;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const wisp = fbm2DPeriodic(u, v, 6, 1709, 4);
      const ridge = 1.0 - Math.abs(wisp * 2 - 1);
      const intensity = smoothstep(0.2, 0.95, ridge * 0.7 + wisp * 0.3);

      const idx = (y * size + x) * 4;
      data[idx] = clampByte(lerp(56, 220, intensity));
      data[idx + 1] = clampByte(lerp(150, 245, intensity));
      data[idx + 2] = clampByte(lerp(220, 255, intensity));
      data[idx + 3] = 255;
    }
  }

  cache.nebulaCloud = createBitmapDataTexture(data, size, size, { srgb: true });
  return cache.nebulaCloud;
}

/**
 * Generates segmented ordnance fuselage bitmaps (128x128) for Homing Torpedoes.
 */
export function getTorpedoSkinBitmaps() {
  if (cache.torpedo) return cache.torpedo;

  const size = 128;
  const mapData = new Uint8Array(size * size * 4);
  const bumpData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const isCollar = (y % 32 < 3);
      const isStencil = (v > 0.42 && v < 0.52) && ((x >> 2) % 2 === 0);
      const brush = fbm2DPeriodic(u * 2, v, 8, 1811, 2);

      let lum = 0.60 + (brush - 0.5) * 0.14;
      let hVal = 0.55;
      let rVal = 0.35;

      if (isCollar) {
        lum = 0.25;
        hVal = 0.85;
        rVal = 0.65;
      }

      const idx = (y * size + x) * 4;
      if (isStencil) {
        mapData[idx] = 225;
        mapData[idx + 1] = 175;
        mapData[idx + 2] = 60;
      } else {
        mapData[idx] = clampByte(lum * 205);
        mapData[idx + 1] = clampByte(lum * 215);
        mapData[idx + 2] = clampByte(lum * 228);
      }
      mapData[idx + 3] = 255;

      const bByte = clampByte(hVal * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;

      const rByte = clampByte(rVal * 255);
      roughData[idx] = rByte;
      roughData[idx + 1] = rByte;
      roughData[idx + 2] = rByte;
      roughData[idx + 3] = 255;
    }
  }

  cache.torpedo = {
    map: createBitmapDataTexture(mapData, size, size, { srgb: true }),
    bumpMap: createBitmapDataTexture(bumpData, size, size, { srgb: false }),
    roughnessMap: createBitmapDataTexture(roughData, size, size, { srgb: false }),
  };
  return cache.torpedo;
}
