import * as THREE from 'three';
import { samplePalette, rgbToCss } from './palette.js';

const MAX_SLICES = 800;
const SAMPLE_BUDGET = 400000; // total samples across all slices per recompute
const WORLD_V = 10;           // vertical reference scale for decimation (conservative)

/**
 * Slice renderer.
 *
 * A set of evenly spaced vertical planes (heading = azimuth of the plane
 * normals) intersects the terrain in curved polylines. Every frame the
 * polylines are projected with the active camera and drawn on a 2D canvas
 * from the farthest plane to the closest one, painter's-algorithm style:
 *
 *   1. the curtain — the slice's plane below its curve — is filled with the
 *      slice's color (or erased to the sky when plane coloring is off),
 *      covering everything farther behind it;
 *   2. the curve itself is stroked on top.
 *
 * Because everything is drawn on one 2D canvas, what you see on screen and
 * what gets exported are pixel-identical by construction.
 *
 * Points are stored with y normalized to [0,1] and multiplied by
 * terrain.heightScale only at projection time, so changing the vertical
 * scale does not require recomputing the slices.
 */
export class SliceRenderer {
  constructor() {
    this.headingDeg = 0;
    this.locked = true;
    this.lineCount = 60;
    // Line coloring
    this.lineColorMode = 'gradient';    // 'static' | 'gradient'
    this.linePalette = null;            // { mode: 'rgb'|'hsv', stops: [{t, color:[r,g,b]}] }, set by main
    // Curtain ("slice plane") coloring — always palette-based
    this.curtainPalette = null;
    this.color = '#ffffff';             // flat line color for the Static mode
    this.thickness = 1.0;
    this.aa = 1;                        // supersampling factor per axis
    this.renderScale = 1;               // device pixels per css pixel (dpr * aa), set by main
    this.dpEpsMult = 0.5;               // decimation epsilon multiplier (0 = full detail)
    this.debugSlice = -1;               // when >= 0, draw only this slice (debugging)

    this.key = null;
    this.nx = 0; this.nz = 1;
    this.numSlices = 0;
    this.extent = 0;
    this.spacing = 0;

    this.pts = new Float32Array(0);   // x, yNorm, z per point
    this.start = new Int32Array(0);   // first point index per slice
    this.count = new Int32Array(0);   // point count per slice
    this.cvals = new Float32Array(0); // plane offset along normal per slice

    this._scratch = new Float32Array(1600 * 3);
    this._keep = new Uint8Array(1600);
    this._stack = new Int32Array(1600 * 2);
    this._sx = new Float32Array(0);
    this._sy = new Float32Array(0);
    this._sv = new Uint8Array(0);
    this._gx = new Float32Array(0);
    this._gy = new Float32Array(0);
    this._order = new Int32Array(0);
    this._dists = new Float32Array(0);  // camera-plane distance per slice
    this._sliceColors = [];             // css color per slice index
    this._m = new THREE.Matrix4();
  }

  invalidate() { this.key = null; }

  /**
   * Per-slice color as [r,g,b] (0..255): sampled from the palette by the
   * slice's perpendicular distance from the camera (nearest = left palette
   * end, farthest = right end), or null when gradient coloring is off
   * (callers fall back to the flat color).
   */
  sliceColorsRgb(camera, gradient, palette) {
    const nS = this.numSlices;
    if (nS === 0) return null;
    if (!(gradient && palette && palette.stops && palette.stops.length)) {
      return null;
    }
    const pos = camera.position;
    const ref = this.nx * pos.x + this.nz * pos.z;
    let dmin = Infinity, dmax = -Infinity;
    const dists = this._dists = grow(this._dists, nS);
    for (let i = 0; i < nS; i++) {
      const d = Math.abs(this.cvals[i] - ref);
      dists[i] = d;
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
    }
    const dr = dmax - dmin;
    const out = new Array(nS);
    for (let i = 0; i < nS; i++) {
      const t = dr > 1e-9 ? (dists[i] - dmin) / dr : 0.5;
      out[i] = samplePalette(palette, t);
    }
    return out;
  }

  compute(terrain, headingRad, lineCount) {
    const key = `${terrain.version}|${headingRad.toFixed(5)}|${lineCount}|${this.dpEpsMult}`;
    if (key === this.key) return;
    this.key = key;

    const gw = terrain.gridW, gh = terrain.gridH;
    const sx = terrain.sizeX, sz = terrain.sizeZ;
    const cell = terrain.cell;
    const nx = Math.sin(headingRad), nz = Math.cos(headingRad);
    this.nx = nx; this.nz = nz;
    const ux = nz, uz = -nx;
    const x0 = -sx / 2, x1 = sx / 2, z0 = -sz / 2, z1 = sz / 2;

    let cmin = Infinity, cmax = -Infinity;
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      const c = cx * nx + cz * nz;
      if (c < cmin) cmin = c;
      if (c > cmax) cmax = c;
    }
    const extent = cmax - cmin;
    this.extent = extent;
    const count = Math.max(1, Math.min(Math.round(lineCount), MAX_SLICES));
    const spacing = extent / count;
    this.spacing = spacing;

    const maxPerLine = Math.max(128, Math.min(1600, Math.floor(SAMPLE_BUDGET / count)));
    const step = cell;

    const maxPts = count * maxPerLine;
    if (this.pts.length < maxPts * 3) this.pts = new Float32Array(maxPts * 3);
    this.start = grow(this.start, count);
    this.count = grow(this.count, count);
    this.cvals = grow(this.cvals, count);
    this._order = grow(this._order, count);
    this._sx = grow(this._sx, maxPts);
    this._sy = grow(this._sy, maxPts);
    this._sv = grow(this._sv, maxPts);
    this._gx = grow(this._gx, maxPts);
    this._gy = grow(this._gy, maxPts);

    const pts = this.pts;
    const invGx = (gw - 1) / sx, invGz = (gh - 1) / sz;
    let w = 0;  // next free point index in pts
    let ns = 0; // slice count

    for (let s = 0; s < count; s++) {
      const c = cmin + spacing * (s + 0.5);
      const baseX = nx * c, baseZ = nz * c;
      let t0 = -Infinity, t1 = Infinity;
      if (Math.abs(ux) > 1e-9) {
        const ta = (x0 - baseX) / ux, tb = (x1 - baseX) / ux;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      } else if (baseX < x0 || baseX > x1) continue;
      if (Math.abs(uz) > 1e-9) {
        const ta = (z0 - baseZ) / uz, tb = (z1 - baseZ) / uz;
        t0 = Math.max(t0, Math.min(ta, tb));
        t1 = Math.min(t1, Math.max(ta, tb));
      } else if (baseZ < z0 || baseZ > z1) continue;
      const len = t1 - t0;
      if (!(len > step * 0.15)) continue;

      const n = Math.min(maxPerLine, Math.max(2, Math.floor(len / step) + 2));
      const sc = this._scratch;
      for (let k = 0; k < n; k++) {
        const t = t0 + (len * k) / (n - 1);
        const x = baseX + t * ux, z = baseZ + t * uz;
        sc[k * 3] = x;
        sc[k * 3 + 1] = terrain.sampleMeshNorm((x + sx / 2) * invGx, (z + sz / 2) * invGz);
        sc[k * 3 + 2] = z;
      }
      const kept = this._decimate(sc, n, len / (n - 1) / step, this.dpEpsMult * 0.02);

      this.start[ns] = w;
      this.count[ns] = kept;
      this.cvals[ns] = c;
      for (let k = 0; k < n; k++) {
        if (!this._keep[k]) continue;
        pts[w * 3] = sc[k * 3];
        pts[w * 3 + 1] = sc[k * 3 + 1];
        pts[w * 3 + 2] = sc[k * 3 + 2];
        w++;
      }
      ns++;
    }
    this.numSlices = ns;
  }

  // Douglas-Peucker in the (t-in-cells, height*WORLD_V) plane; writes keep
  // flags into this._keep and returns the number of kept points.
  // eps <= 0 keeps every sampled point (full detail).
  _decimate(sc, n, cellsPerIndex, eps) {
    const keep = this._keep, stack = this._stack;
    if (n <= 2 || eps <= 0) { keep.fill(1, 0, n); return n; }
    keep.fill(0, 0, n);
    keep[0] = 1; keep[n - 1] = 1;
    let sp = 0;
    stack[sp++] = 0; stack[sp++] = n - 1;
    while (sp > 0) {
      const end = stack[--sp], beg = stack[--sp];
      const ay = sc[beg * 3 + 1] * WORLD_V;
      const bx = (end - beg) * cellsPerIndex, by = sc[end * 3 + 1] * WORLD_V;
      const dx = bx, dy = by - ay;
      const L = Math.hypot(dx, dy);
      let maxD = -1, maxI = -1;
      for (let k = beg + 1; k < end; k++) {
        const px = (k - beg) * cellsPerIndex;
        const py = sc[k * 3 + 1] * WORLD_V - ay;
        const d = L > 1e-12 ? Math.abs(dx * py - dy * px) / L : Math.hypot(px, py);
        if (d > maxD) { maxD = d; maxI = k; }
      }
      if (maxI > 0 && maxD > eps) {
        keep[maxI] = 1;
        stack[sp++] = beg; stack[sp++] = maxI;
        stack[sp++] = maxI; stack[sp++] = end;
      }
    }
    let kept = 0;
    for (let k = 0; k < n; k++) kept += keep[k];
    return kept;
  }

  /**
   * Draw one frame. w/h are CSS-pixel viewport dimensions; the context must
   * already carry the transform mapping CSS px -> device px.
   *
   * drawPlanes: fill each slice's curtain (its plane below the curve) with
   * the slice's gradient color; when false, the curtains are erased to the
   * sky instead (classic black bands). drawLines: stroke the curves.
   * Both are drawn far -> near, so nearer planes occlude farther ones.
   */
  render(ctx, camera, terrain, w, h, drawPlanes, drawLines) {
    const nS = this.numSlices;
    if (nS === 0) return;
    if (!drawPlanes && !drawLines) return;
    camera.updateMatrixWorld(true);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = this._m.elements;
    const v = camera.matrixWorldInverse.elements;
    const vz2 = v[2], vz6 = v[6], vz10 = v[10], vz14 = v[14];
    const near = camera.near;
    const pos = camera.position;
    const sigmaRef = this.nx * pos.x + this.nz * pos.z;

    // Sort planes far -> near. For parallel planes this is |offset - ref|,
    // which is correct both when the camera is on one side of all planes
    // and when it sits between them. Sort only the active prefix: the typed
    // arrays keep stale entries from a previous larger slice count, and
    // sorting the full array would let ghost slices into the draw order.
    const order = this._order, cv = this.cvals;
    for (let i = 0; i < nS; i++) order[i] = i;
    order.subarray(0, nS).sort((a, b) =>
      Math.abs(cv[b] - sigmaRef) - Math.abs(cv[a] - sigmaRef));

    const hs = terrain.heightScale;
    const pts = this.pts, sxr = this._sx, syr = this._sy, svr = this._sv;
    const gxr = this._gx, gyr = this._gy;
    const m0 = e[0], m4 = e[4], m8 = e[8], m12 = e[12];
    const m1 = e[1], m5 = e[5], m9 = e[9], m13 = e[13];
    const m2 = e[2], m6 = e[6], m10 = e[10], m14 = e[14];
    const m3 = e[3], m7 = e[7], m11 = e[11], m15 = e[15];
    const pad = 64;

    const lineCols = this.sliceColorsRgb(camera, this.lineColorMode === 'gradient', this.linePalette);
    const fillCols = this.sliceColorsRgb(camera, true, this.curtainPalette);

    const dbg = this.debug = { total: nS, tiny: 0, noValid: 0, offscreen: 0, drawn: 0, ptsCulled: 0 };

    for (let oi = 0; oi < nS; oi++) {
      const si = order[oi];
      if (this.debugSlice >= 0 && si !== this.debugSlice) continue;
      const s0 = this.start[si], n = this.count[si];
      if (n < 2) { dbg.tiny++; continue; }
      let minx = Infinity, maxx = -Infinity, miny = Infinity, anyProj = false;
      for (let k = 0; k < n; k++) {
        const pi = (s0 + k) * 3;
        const x = pts[pi], y = pts[pi + 1] * hs, z = pts[pi + 2];
        // project the curve point and its ground projection (y = 0): the fill
        // polygon is the true projected curtain between the two
        const vzC = vz2 * x + vz6 * y + vz10 * z + vz14;
        const cwC = m3 * x + m7 * y + m11 * z + m15;
        const vzG = vz2 * x + vz10 * z + vz14;
        const cwG = m3 * x + m11 * z + m15;
        let ok = vzC < -near && cwC > 1e-9 && vzG < -near && cwG > 1e-9;
        let px = 0, py = 0, gx = 0, gy = 0;
        if (ok) {
          const inv = 1 / cwC;
          px = ((m0 * x + m4 * y + m8 * z + m12) * inv * 0.5 + 0.5) * w;
          py = (0.5 - (m1 * x + m5 * y + m9 * z + m13) * inv * 0.5) * h;
          const invG = 1 / cwG;
          gx = ((m0 * x + m8 * z + m12) * invG * 0.5 + 0.5) * w;
          gy = (0.5 - (m1 * x + m9 * z + m13) * invG * 0.5) * h;
          if (!Number.isFinite(px) || !Number.isFinite(py) ||
            !Number.isFinite(gx) || !Number.isFinite(gy)) ok = false;
        }
        sxr[s0 + k] = px; syr[s0 + k] = py; svr[s0 + k] = ok ? 1 : 0;
        gxr[s0 + k] = gx; gyr[s0 + k] = gy;
        if (!ok) dbg.ptsCulled++;
        else {
          anyProj = true;
          if (px < minx) minx = px;
          if (px > maxx) maxx = px;
          if (py < miny) miny = py;
          if (gy < miny) miny = gy;
        }
      }
      if (!anyProj) { dbg.noValid++; continue; }
      if (maxx < -pad || minx > w + pad || miny > h + pad) { dbg.offscreen++; continue; }

      const strokePath = new Path2D();
      const fillPath = drawPlanes ? new Path2D() : null;
      let runStart = -1;
      for (let k = 0; k <= n; k++) {
        const valid = k < n ? svr[s0 + k] : 0;
        if (valid && runStart < 0) runStart = k;
        else if (!valid && runStart >= 0) {
          const runEnd = k - 1;
          if (runEnd > runStart) {
            const x0p = sxr[s0 + runStart], y0p = syr[s0 + runStart];
            strokePath.moveTo(x0p, y0p);
            for (let q = runStart + 1; q <= runEnd; q++) {
              strokePath.lineTo(sxr[s0 + q], syr[s0 + q]);
            }
            if (fillPath) {
              // the curtain: the true projected plane section — the curve
              // along the top, its ground trace along the bottom
              fillPath.moveTo(x0p, y0p);
              for (let q = runStart + 1; q <= runEnd; q++) {
                fillPath.lineTo(sxr[s0 + q], syr[s0 + q]);
              }
              for (let q = runEnd; q >= runStart; q--) {
                fillPath.lineTo(gxr[s0 + q], gyr[s0 + q]);
              }
              fillPath.closePath();
            }
          }
          runStart = -1;
        }
      }
      if (fillPath) {
        if (drawPlanes) {
          ctx.fillStyle = fillCols ? rgbToCss(fillCols[si]) : this.color;
          ctx.fill(fillPath, 'nonzero');
        } else {
          // classic look: erase the band to the sky (the canvas is
          // transparent there, the page background shows through)
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = '#000';
          ctx.fill(fillPath, 'nonzero');
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      if (drawLines) {
        ctx.strokeStyle = lineCols ? rgbToCss(lineCols[si]) : this.color;
        ctx.lineWidth = this.thickness;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(strokePath);
      }
      dbg.drawn++;
    }
  }
}

function grow(arr, n) {
  return arr.length >= n ? arr : new arr.constructor(n);
}
