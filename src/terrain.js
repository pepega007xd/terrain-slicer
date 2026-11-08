import * as THREE from 'three';

// World extent of the terrain's longest horizontal side, in world units.
export const WORLD_SIZE = 10;

/**
 * A heightfield grid with normalized heights in [0, 1], mapped to world
 * space so the longest horizontal side is WORLD_SIZE and height is
 * `heightScale` world units.
 */
export class Terrain {
  constructor() {
    this.gridW = 0;
    this.gridH = 0;
    this.h = new Float32Array(0); // normalized [0,1], row-major, row 0 = "top" (far side, -z)
    this.rawMin = 0;
    this.rawMax = 0;
    this.heightScale = WORLD_SIZE * 0.2; // world units (100% on the slider)
    this.version = 0;
    this.info = '';
  }

  get loaded() { return this.gridW > 0; }

  get sizeX() {
    const a = this.gridW / this.gridH;
    return a >= 1 ? WORLD_SIZE : WORLD_SIZE * a;
  }

  get sizeZ() {
    const a = this.gridW / this.gridH;
    return a >= 1 ? WORLD_SIZE / a : WORLD_SIZE;
  }

  get cell() {
    return Math.min(
      this.sizeX / Math.max(1, this.gridW - 1),
      this.sizeZ / Math.max(1, this.gridH - 1)
    );
  }

  get radius() {
    return 0.5 * Math.hypot(this.sizeX, this.sizeZ, this.heightScale);
  }

  /**
   * values: flat array, `channels` samples per pixel, height in channel `chan`.
   * flipY: set true when row 0 of the source is the bottom of the image (EXR).
   */
  setGrid(gridW, gridH, values, channels, chan, flipY, info) {
    const n = gridW * gridH;
    const h = new Float32Array(n);
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < gridH; j++) {
      const srcRow = flipY ? (gridH - 1 - j) : j;
      const base = (srcRow * gridW) * channels + chan;
      for (let i = 0; i < gridW; i++) {
        const v = values[base + i * channels];
        h[j * gridW + i] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    const range = mx > mn ? mx - mn : 1;
    for (let i = 0; i < n; i++) h[i] = (h[i] - mn) / range;
    this.gridW = gridW;
    this.gridH = gridH;
    this.h = h;
    this.rawMin = mn;
    this.rawMax = mx;
    this.info = info;
    this.version++;
  }

  // Bilinear sample of the normalized height grid, grid coords are float, clamped.
  sampleNorm(gx, gz) {
    const gw = this.gridW, gh = this.gridH, h = this.h;
    gx = Math.min(Math.max(gx, 0), gw - 1 - 1e-4);
    gz = Math.min(Math.max(gz, 0), gh - 1 - 1e-4);
    const i = gx | 0, j = gz | 0;
    const fx = gx - i, fz = gz - j;
    const r = j * gw + i, r2 = r + gw;
    const h00 = h[r], h10 = h[r + 1], h01 = h[r2], h11 = h[r2 + 1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  /**
   * Height sampled with the same per-cell triangle split used by
   * buildTerrainGeometry (anti-diagonal), so slice curves lie exactly on the
   * rendered mesh surface — required for clean depth-tested occlusion.
   */
  sampleMeshNorm(gx, gz) {
    const gw = this.gridW, gh = this.gridH, h = this.h;
    gx = Math.min(Math.max(gx, 0), gw - 1 - 1e-4);
    gz = Math.min(Math.max(gz, 0), gh - 1 - 1e-4);
    const i = gx | 0, j = gz | 0;
    const fx = gx - i, fz = gz - j;
    const r = j * gw + i, r2 = r + gw;
    const h00 = h[r], h10 = h[r + 1], h01 = h[r2], h11 = h[r2 + 1];
    if (fx + fz <= 1) {
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    return h11 + (h10 - h11) * (1 - fz) + (h01 - h11) * (1 - fx);
  }
}

/**
 * Build a render mesh for the shaded view. Vertices carry y = normalized
 * height in [0,1]; scale the mesh by terrain.heightScale on the Y axis.
 */
export function buildTerrainGeometry(terrain, cap = 1024) {
  const gw = terrain.gridW, gh = terrain.gridH;
  const step = Math.max(1, Math.ceil(Math.max(gw, gh) / cap));
  const nw = Math.floor((gw - 1) / step) + 1;
  const nh = Math.floor((gh - 1) / step) + 1;
  const sx = terrain.sizeX, sz = terrain.sizeZ;
  const pos = new Float32Array(nw * nh * 3);
  let p = 0;
  for (let j = 0; j < nh; j++) {
    const gz = Math.min(j * step, gh - 1);
    const z = -sz / 2 + (gz / (gh - 1)) * sz;
    for (let i = 0; i < nw; i++) {
      const gx = Math.min(i * step, gw - 1);
      const x = -sx / 2 + (gx / (gw - 1)) * sx;
      pos[p++] = x;
      pos[p++] = terrain.h[gz * gw + gx];
      pos[p++] = z;
    }
  }
  const idx = new Uint32Array((nw - 1) * (nh - 1) * 6);
  let q = 0;
  for (let j = 0; j < nh - 1; j++) {
    for (let i = 0; i < nw - 1; i++) {
      const a = j * nw + i, b = a + 1, c = a + nw, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}
