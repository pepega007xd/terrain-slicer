import * as THREE from 'three';

const MAX_SLICES = 800;
const SAMPLE_BUDGET = 400000; // total samples across all slices per recompute
const WORLD_V = 10;           // vertical reference scale for decimation (conservative)

// Depth prepass material: writes each fragment's clip-space z/w (the exact
// quantity the curve points are tested against) packed into R/G channels.
// Used on the curtain mesh, not the terrain — the occluders are the planes
// below the slice curves, never the terrain surface between planes.
const depthVert = /* glsl */`
  varying vec4 vClip;
  void main() {
    vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    vClip = p;
    gl_Position = p;
  }`;
const depthFrag = /* glsl */`
  varying vec4 vClip;
  void main() {
    float t = clamp( 0.5 * vClip.z / vClip.w + 0.5, 0.0, 1.0 );
    gl_FragColor = vec4( floor( t * 255.0 ) / 255.0, fract( t * 255.0 ), 0.0, 1.0 );
  }`;

/**
 * Slice renderer.
 *
 * A set of evenly spaced vertical planes (heading = azimuth of the plane
 * normals) intersects the terrain in curved polylines. Every frame the
 * polylines are projected with the active camera and drawn on a 2D canvas
 * from the farthest plane to the closest one. For each plane, everything
 * *below* its curve is first erased (destination-out), then the curve
 * itself is stroked — nearer curves thus occlude farther ones.
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
    this.color = '#ffffff';
    this.bgColor = '#000000';
    this.thickness = 1.0;
    this.aa = 1;            // supersampling factor per axis
    this.renderScale = 1;   // device pixels per css pixel (dpr * aa), set by main
    this.depthBias = 1.5;   // visibility bias in grid cells (covers rasterization/sampling mismatch)
    this.dpEpsMult = 0.5;   // decimation epsilon multiplier (0 = full detail)
    this.debugSlice = -1;   // when >= 0, draw only this slice (debugging)

    this.key = null;
    this.nx = 0; this.nz = 1;
    this.numSlices = 0;
    this.extent = 0;
    this.spacing = 0;

    this.pts = new Float32Array(0);   // x, yNorm, z per point
    this.start = new Int32Array(0);   // first point index per slice
    this.count = new Int32Array(0);   // point count per slice
    this.cvals = new Float32Array(0); // plane offset along normal per slice

    // Curtain geometry for the depth prepass: for every curve point a vertex
    // pair (curve point, its ground projection), triangulated per segment.
    // The occluder of a slice is exactly this vertical curtain — the terrain
    // between planes must never occlude (looking between planes must show
    // what is behind them).
    this.curtainPos = new Float32Array(0); // xyz per vertex, y normalized (mesh scale.y = heightScale)
    this.curtainIdx = new Uint32Array(0);  // 6 indices per segment
    this._curtainGeo = new THREE.BufferGeometry();
    this._applyCurtainAttributes();
    this.curtainMesh = new THREE.Mesh(this._curtainGeo, new THREE.ShaderMaterial({
      vertexShader: depthVert,
      fragmentShader: depthFrag,
      side: THREE.DoubleSide,
    }));
    this.curtainMesh.frustumCulled = false;

    this._scratch = new Float32Array(1600 * 3);
    this._keep = new Uint8Array(1600);
    this._stack = new Int32Array(1600 * 2);
    this._sx = new Float32Array(0);
    this._sy = new Float32Array(0);
    this._sv = new Uint8Array(0);
    this._order = new Int32Array(0);
    this._keys = new Float32Array(0);
    this._m = new THREE.Matrix4();
  }

  _applyCurtainAttributes() {
    this._curtainGeo.setAttribute('position',
      new THREE.BufferAttribute(this.curtainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this._curtainGeo.setIndex(
      new THREE.BufferAttribute(this.curtainIdx, 1).setUsage(THREE.DynamicDrawUsage));
  }

  invalidate() { this.key = null; }

  compute(terrain, headingRad, lineCount) {
    const key = `${terrain.version}|${headingRad.toFixed(5)}|${lineCount}|${this.dpEpsMult}`;
    if (key === this.key) return;
    this.key = key;

    const gw = terrain.gridW, gh = terrain.gridH;
    const sx = terrain.sizeX, sz = terrain.sizeZ;
    const cell = terrain.cell;
    const nx = Math.sin(headingRad), nz = Math.cos(headingRad);
    this.nx = nx; this.nz = nz;
    const ux = nz, uz = -nx; // in-plane horizontal direction
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
    this.start = _grow(this.start, count);
    this.count = _grow(this.count, count);
    this.cvals = _grow(this.cvals, count);
    this._sx = _grow(this._sx, maxPts);
    this._sy = _grow(this._sy, maxPts);
    this._sv = _grow(this._sv, maxPts);
    this._order = _grow(this._order, count);
    this._keys = _grow(this._keys, count);

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
    this._pointTotal = w;
    this._buildCurtains();
  }

  // (Re)fill the curtain geometry from the current slices: per curve point a
  // vertex pair (curve point at normalized y, its projection on the ground),
  // indexed into two triangles per segment. The mesh's scale.y carries the
  // height scale, so height changes don't require a rebuild.
  _buildCurtains() {
    const totalPts = this._pointTotal;
    const totalSegs = totalPts - this.numSlices;
    const needV = totalPts * 2, needI = totalSegs * 6;
    if (this.curtainPos.length < needV * 3 || this.curtainIdx.length < needI) {
      this.curtainPos = new Float32Array(Math.max(needV * 3, (this.curtainPos.length * 1.5) | 0));
      this.curtainIdx = new Uint32Array(Math.max(needI, (this.curtainIdx.length * 1.5) | 0));
      this._applyCurtainAttributes();
    }
    const pts = this.pts, pos = this.curtainPos, idx = this.curtainIdx;
    let v = 0, ic = 0;
    for (let si = 0; si < this.numSlices; si++) {
      const s0 = this.start[si], n = this.count[si];
      const vBase = v;
      for (let k = 0; k < n; k++) {
        const p = (s0 + k) * 3, q = v * 3;
        pos[q] = pts[p];
        pos[q + 1] = pts[p + 1]; // normalized y; bottom vertex below is 0
        pos[q + 2] = pts[p + 2];
        pos[q + 3] = pts[p];
        pos[q + 4] = 0;
        pos[q + 5] = pts[p + 2];
        v += 2;
      }
      for (let k = 0; k + 1 < n; k++) {
        const a = vBase + k * 2, b = a + 2;
        idx[ic++] = a;     idx[ic++] = b;     idx[ic++] = a + 1;
        idx[ic++] = a + 1; idx[ic++] = b;     idx[ic++] = b + 1;
      }
    }
    this.curtainVertCount = v;
    const geo = this._curtainGeo;
    geo.attributes.position.needsUpdate = true;
    geo.index.needsUpdate = true;
    geo.setDrawRange(0, ic);
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
      const ax = 0, ay = sc[beg * 3 + 1] * WORLD_V;
      const bx = (end - beg) * cellsPerIndex, by = sc[end * 3 + 1] * WORLD_V;
      const dx = bx - ax, dy = by - ay;
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
   * `depth` is the curtain depth buffer rendered from the same camera (by
   * main.js, via curtainMesh): { data: Float32Array (row 0 = bottom), w, h }.
   * Each curve point is tested against the nearest curtain at its pixel, so
   * lines are hidden exactly where a nearer slice's plane-below-the-curve
   * covers them — the classic ridge-plot occlusion, correct from any view
   * direction. Looking between two planes shows whatever is behind them.
   */
  render(ctx, camera, terrain, w, h, depth) {
    const nS = this.numSlices;
    if (nS === 0) return;
    camera.updateMatrixWorld(true);
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const e = this._m.elements;
    const v = camera.matrixWorldInverse.elements;
    const vz2 = v[2], vz6 = v[6], vz10 = v[10], vz14 = v[14];
    const near = camera.near;
    const pos = camera.position;
    const sigmaRef = this.nx * pos.x + this.nz * pos.z;

    const isPersp = camera.isPerspectiveCamera === true;
    const p10 = camera.projectionMatrix.elements[10];
    const p14 = camera.projectionMatrix.elements[14];
    const useDepth = !!depth;
    const biasWorld = terrain.cell * this.depthBias;

    // Sort planes far -> near. For parallel planes this is |offset - ref|,
    // which is correct both when the camera is on one side of all planes
    // and when it sits between them.
    const order = this._order, keys = this._keys, cv = this.cvals;
    for (let i = 0; i < nS; i++) {
      order[i] = i;
      keys[i] = Math.abs(cv[i] - sigmaRef);
    }
    order.sort((a, b) => keys[b] - keys[a]);

    const hs = terrain.heightScale;
    const pts = this.pts, sxr = this._sx, syr = this._sy, svr = this._sv;
    const m0 = e[0], m4 = e[4], m8 = e[8], m12 = e[12];
    const m1 = e[1], m5 = e[5], m9 = e[9], m13 = e[13];
    const m2 = e[2], m6 = e[6], m10 = e[10], m14 = e[14];
    const m3 = e[3], m7 = e[7], m11 = e[11], m15 = e[15];
    const pad = 64;
    let cst = 0, cpx = 0, cpy = 0; // classify() outputs

    const dbg = this.debug = { total: nS, tiny: 0, noValid: 0, offscreen: 0, drawn: 0, ptsCulled: 0, ptsHidden: 0, subTests: 0 };

    // Classify one world-space point: 0 = behind near plane / unprojectable,
    // 1 = visible, 2 = hidden behind a nearer curtain. Screen coords go to
    // cpx/cpy. Used for the curve points and for subdivision midpoints.
    const classify = (x, y, z) => {
      const vz = vz2 * x + vz6 * y + vz10 * z + vz14;
      if (!(vz < -near)) { cst = 0; return; }
      const cw = m3 * x + m7 * y + m11 * z + m15;
      if (!(cw > 1e-9)) { cst = 0; return; }
      const inv = 1 / cw;
      const ndcX = (m0 * x + m4 * y + m8 * z + m12) * inv;
      const ndcY = (m1 * x + m5 * y + m9 * z + m13) * inv;
      const px = (ndcX * 0.5 + 0.5) * w;
      const py = (0.5 - ndcY * 0.5) * h;
      if (!(Number.isFinite(px) && Number.isFinite(py))) { cst = 0; return; }
      if (useDepth) {
        // sample nearest curtain depth at this pixel (buffer row 0 = bottom);
        // take the max of the 2x2 neighborhood so points win ties at
        // silhouette edges and steep depth gradients (fewer dropouts)
        let fx = ((ndcX * 0.5 + 0.5) * depth.w) | 0;
        let fy = ((0.5 - ndcY * 0.5) * depth.h) | 0;
        fx = fx < 0 ? 0 : fx >= depth.w ? depth.w - 1 : fx;
        fy = fy < 0 ? 0 : fy >= depth.h ? depth.h - 1 : fy;
        const fx1 = fx < depth.w - 1 ? fx + 1 : fx;
        const fy1 = fy < depth.h - 1 ? fy + 1 : fy;
        const row0 = (depth.h - 1 - fy) * depth.w;
        const row1 = (depth.h - 1 - fy1) * depth.w;
        const d00 = depth.data[row0 + fx], d10 = depth.data[row0 + fx1];
        const d01 = depth.data[row1 + fx], d11 = depth.data[row1 + fx1];
        const surf = d00 > d10 ? (d01 > d11 ? (d00 > d01 ? d00 : d01) : (d00 > d11 ? d00 : d11))
          : (d01 > d11 ? (d10 > d01 ? d10 : d01) : (d10 > d11 ? d10 : d11));
        if (surf < 0.9995) { // 1.0 = clear color = no curtain (sky)
          const zNdc = (m2 * x + m6 * y + m10 * z + m14) * inv;
          const pd = (zNdc + 1) * 0.5;
          // world-space bias -> NDC -> [0,1]
          const dzdv = isPersp ? Math.abs(p14) / (vz * vz) : Math.abs(p10);
          const bias = dzdv * biasWorld * 0.5;
          if (pd > surf + bias) { cst = 2; cpx = px; cpy = py; return; }
        }
      }
      cst = 1; cpx = px; cpy = py;
    };

    // Adaptive subdivision: decimated segments can be long, and testing only
    // their endpoints makes them pop in/out whole (or draw straight sections
    // over nearer curtains). Each pair is midpoint-tested and split until the
    // pieces are short, with a finer threshold where visibility flips, so
    // occlusion boundaries resolve to a few pixels.
    const SUBDIV_PX = 12;   // same-visibility pairs longer than this get split
    const BOUNDARY_PX = 3;  // visibility-flip pairs refined to this length
    const HIDDEN_PX = 24;   // hidden-hidden pairs (coarser: hidden spans are long)
    const MAX_DEPTH = 7;

    for (let oi = 0; oi < nS; oi++) {
      const si = order[oi];
      if (this.debugSlice >= 0 && si !== this.debugSlice) continue;
      const s0 = this.start[si], n = this.count[si];
      if (n < 2) { dbg.tiny++; continue; }
      let minx = Infinity, maxx = -Infinity, anyProj = false;
      for (let k = 0; k < n; k++) {
        const pi = (s0 + k) * 3;
        classify(pts[pi], pts[pi + 1] * hs, pts[pi + 2]);
        const st = cst;
        sxr[s0 + k] = cpx; syr[s0 + k] = cpy; svr[s0 + k] = st;
        if (st === 0) dbg.ptsCulled++;
        else {
          anyProj = true;
          if (st === 2) dbg.ptsHidden++;
          if (cpx < minx) minx = cpx;
          if (cpx > maxx) maxx = cpx;
        }
      }
      if (!anyProj) { dbg.noValid++; continue; }
      if (maxx < -pad || minx > w + pad) { dbg.offscreen++; continue; }

      // Emit one sub-point; visible points extend the current run, anything
      // else closes it.
      const strokePath = new Path2D();
      let runOpen = false;
      const emit = (px, py, st) => {
        if (st === 1) {
          if (runOpen) strokePath.lineTo(px, py);
          else { strokePath.moveTo(px, py); runOpen = true; }
        } else {
          runOpen = false;
        }
      };

      const subPair = (ax, ay, az, pax, pay, stA, bx, by, bz, pbx, pby, stB, depth) => {
        if (stA === 0 && stB === 0) return;
        let len = Infinity;
        if (stA !== 0 && stB !== 0) len = Math.hypot(pbx - pax, pby - pay);
        const thr = stA !== stB ? BOUNDARY_PX : (stA === 2 ? HIDDEN_PX : SUBDIV_PX);
        if (depth >= MAX_DEPTH || len <= thr) { emit(pbx, pby, stB); return; }
        const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
        classify(mx, my, mz);
        const stM = cst, pmx = cpx, pmy = cpy;
        dbg.subTests++;
        subPair(ax, ay, az, pax, pay, stA, mx, my, mz, pmx, pmy, stM, depth + 1);
        subPair(mx, my, mz, pmx, pmy, stM, bx, by, bz, pbx, pby, stB, depth + 1);
      };

      emit(sxr[s0], syr[s0], svr[s0]);
      for (let k = 0; k + 1 < n; k++) {
        const j = s0 + k, stA = svr[j], stB = svr[j + 1];
        if (stA === 1 && stB === 1) {
          const dx = sxr[j + 1] - sxr[j], dy = syr[j + 1] - syr[j];
          if (dx * dx + dy * dy <= SUBDIV_PX * SUBDIV_PX) {
            strokePath.lineTo(sxr[j + 1], syr[j + 1]);
            continue;
          }
        }
        subPair(pts[j * 3], pts[j * 3 + 1] * hs, pts[j * 3 + 2], sxr[j], syr[j], stA,
          pts[j * 3 + 3], pts[j * 3 + 4] * hs, pts[j * 3 + 5], sxr[j + 1], syr[j + 1], stB, 0);
      }
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.thickness;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(strokePath);
      dbg.drawn++;
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function _grow(arr, n) {
  return arr.length >= n ? arr : new arr.constructor(n);
}
