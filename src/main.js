import './style.css';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { decode as decodePng } from 'fast-png';
import { Terrain, WORLD_SIZE, buildTerrainGeometry } from './terrain.js';
import { generateSampleHeights } from './sampleTerrain.js';
import { CameraRig } from './cameraRig.js';
import { SliceRenderer } from './slicer.js';
import { defaultLinePalette, defaultPlanePalette } from './palette.js';
import { createPaletteWidget } from './paletteUI.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

const terrain = new Terrain();
const rig = new CameraRig();
const slicer = new SliceRenderer();
slicer.linePalette = defaultLinePalette();
slicer.curtainPalette = defaultPlanePalette();
const state = { mode: 'slices', showLines: true, showPlanes: true };

// --- three.js setup -------------------------------------------------------
const glCanvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f13);
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ color: 0x9aa3ad }));
scene.add(mesh);
const dirLight = new THREE.DirectionalLight(0xffffff, 2.6);
dirLight.position.set(6, 10, 4);
scene.add(dirLight);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));

const lineCanvas = $('lines');
const lctx = lineCanvas.getContext('2d');

// --- curtain depth prepass (for exact slice occlusion) ---------------------
// The slice renderer's curtain mesh (one vertical "wall" below each slice
// curve) is rendered from the active camera into a small render target. A
// custom shader stores each fragment's clip-space z/w (the exact quantity the
// curve points are tested against) packed into the R/G channels — no reliance
// on three's depth packing/mapping conventions. The nearest curtain at each
// pixel then occludes farther slice lines; the terrain between the planes
// never occludes, so looking between planes shows what is behind them.
let depthRT = null;
let depthBuf = null;
let depthData = null;
let lastDepthStats = null;
const DEPTH_SCALE = 0.5; // fraction of CSS viewport size
const depthScene = new THREE.Scene();
depthScene.add(slicer.curtainMesh);

// --- colored curtain fills (the visible bands between the lines) -----------
// A second transparent WebGL layer under the 2D line canvas renders the
// curtain mesh with per-slice vertex colors; the GPU depth test resolves
// curtain-vs-curtain occlusion exactly, and the sky stays transparent so the
// background color shows through.
const fillCanvas = $('fills');
const fillRenderer = new THREE.WebGLRenderer({ canvas: fillCanvas, alpha: true, antialias: true });
fillRenderer.setClearColor(0x000000, 0);
const fillScene = new THREE.Scene();
fillScene.add(slicer.fillMesh);

function resizeFillRenderer() {
  fillRenderer.setPixelRatio(dpr());
  fillRenderer.setSize(window.innerWidth, window.innerHeight, false);
}

function resizeDepthRT() {
  const w = Math.max(2, Math.round(window.innerWidth * DEPTH_SCALE));
  const h = Math.max(2, Math.round(window.innerHeight * DEPTH_SCALE));
  if (depthRT && depthRT.width === w && depthRT.height === h) return;
  if (depthRT) depthRT.dispose();
  depthRT = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    generateMipmaps: false,
  });
  depthBuf = new Uint8Array(w * h * 4);
  depthData = new Float32Array(w * h);
}

function renderDepthBuffer() {
  resizeDepthRT();
  const cam = rig.activeCamera;
  cam.updateMatrixWorld(true);
  renderer.setClearColor(0xffffff, 1); // sky = t 1.0 = no curtain
  renderer.setRenderTarget(depthRT);
  renderer.render(depthScene, cam);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x0d0f13, 1);
  renderer.readRenderTargetPixels(depthRT, 0, 0, depthRT.width, depthRT.height, depthBuf);
  // shader packed t = (clip.z/clip.w + 1)/2 as (floor(t*255), fract(t*255))
  const n = depthRT.width * depthRT.height;
  let mn = 1, mx = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = (depthBuf[o] + depthBuf[o + 1] / 255) / 255;
    depthData[i] = d;
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  lastDepthStats = { mn, mx, w: depthRT.width, h: depthRT.height };
  return { data: depthData, w: depthRT.width, h: depthRT.height };
}

let needsRender = true;
const invalidate = () => { needsRender = true; };// --- sizing ---------------------------------------------------------------
function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

function resizeLineCanvas() {
  const w = window.innerWidth, h = window.innerHeight;
  let scale = dpr() * slicer.aa;
  const maxPixels = 28e6; // cap backing-store size
  if (w * h * scale * scale > maxPixels) {
    scale = Math.max(1, Math.sqrt(maxPixels / (w * h)));
  }
  lineCanvas.width = Math.max(1, Math.round(w * scale));
  lineCanvas.height = Math.max(1, Math.round(h * scale));
  slicer.renderScale = scale;
  invalidate();
}

// --- terrain loading ------------------------------------------------------
function applyTerrain() {
  mesh.geometry.dispose();
  mesh.geometry = buildTerrainGeometry(terrain, 1024);
  mesh.scale.y = terrain.heightScale;
  slicer.setCurtainScale(terrain.heightScale);
  rig.bounds = { size: WORLD_SIZE, height: terrain.heightScale };
  rig.target.y = terrain.heightScale / 2;
  $('terrainInfo').textContent =
    `${terrain.info} · raw range ${fmt(terrain.rawMin)}…${fmt(terrain.rawMax)}`;
  slicer.invalidate();
  invalidate();
}

function fmt(v) {
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 1 ? v.toFixed(3) : v.toPrecision(3);
}

function loadSample() {
  const s = generateSampleHeights(512);
  terrain.setGrid(s.gridW, s.gridH, s.values, s.channels, 0, false, 'sample terrain · 512×512');
  applyTerrain();
}

async function loadFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.exr')) {
      const loader = new EXRLoader().setDataType(THREE.FloatType);
      const tex = loader.parse(buf);
      const ch = fmtChannels(tex.format);
      terrain.setGrid(tex.width, tex.height, tex.data, ch, 0, true,
        `${file.name} · EXR ${tex.width}×${tex.height}`);
    } else if (lower.endsWith('.png')) {
      const png = decodePng(new Uint8Array(buf));
      terrain.setGrid(png.width, png.height, png.data, png.channels, 0, false,
        `${file.name} · PNG ${png.width}×${png.height} · ${png.depth}-bit`);
    } else {
      throw new Error('unsupported file type — use .exr or .png');
    }
    applyTerrain();
    toast(`Loaded ${file.name}`);
  } catch (err) {
    console.error(err);
    toast(`Load failed: ${err.message}`, true);
  }
}

function fmtChannels(format) {
  if (format === THREE.RedFormat) return 1;
  if (format === THREE.RGFormat) return 2;
  if (format === THREE.RGBFormat) return 3;
  return 4; // RGBAFormat and anything else
}

// --- UI -------------------------------------------------------------------
function setMode(m) {
  state.mode = m;
  document.body.classList.toggle('slices', m === 'slices');
  $('modeShaded').classList.toggle('on', m === 'shaded');
  $('modeSlices').classList.toggle('on', m === 'slices');
  invalidate();
}

function setHeightPct(pct) {
  terrain.heightScale = (pct / 100) * WORLD_SIZE;
  mesh.scale.y = terrain.heightScale;
  slicer.setCurtainScale(terrain.heightScale);
  rig.bounds = { size: WORLD_SIZE, height: terrain.heightScale };
  rig.target.y = terrain.heightScale / 2;
  $('heightVal').textContent = `${pct}%`;
  invalidate();
}

function countToSlider(c) {
  return Math.round((Math.log(Math.max(4, c) / 4) / Math.log(150)) * 100);
}
function sliderToCount(v) {
  return Math.round(4 * Math.pow(150, v / 100));
}

function setLineCount(c) {
  slicer.lineCount = Math.max(1, Math.min(800, Math.round(c)));
  slicer.invalidate();
  $('countVal').textContent = String(slicer.lineCount);
  invalidate();
}

function setLocked(v) {
  slicer.locked = !!v;
  $('heading').disabled = slicer.locked;
  if (!slicer.locked) slicer.invalidate();
  invalidate();
}

function setHeading(deg) {
  slicer.headingDeg = ((deg % 360) + 360) % 360;
  slicer.invalidate();
  $('headingVal').textContent = `${slicer.headingDeg.toFixed(1)}°`;
  invalidate();
}

function savePNG() {
  let out;
  if (state.mode === 'shaded') {
    renderer.render(scene, rig.activeCamera); // ensure fresh buffer
    out = glCanvas;
  } else {
    // Re-render the slice view offscreen. Supersample at least 2x (or at the
    // user's chosen level when higher), capped like the display canvas.
    const w = window.innerWidth, h = window.innerHeight;
    let scale = dpr() * Math.max(2, slicer.aa);
    if (w * h * scale * scale > 28e6) scale = Math.max(1, Math.sqrt(28e6 / (w * h)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const cx = c.getContext('2d');
    cx.fillStyle = slicer.bgColor;
    cx.fillRect(0, 0, c.width, c.height);
    if (state.showPlanes) {
      // render the colored curtain fills at the export resolution too
      fillRenderer.setPixelRatio(1);
      fillRenderer.setSize(c.width, c.height, false);
      slicer.updateCurtainColors(rig.activeCamera);
      fillRenderer.render(fillScene, rig.activeCamera);
      cx.drawImage(fillCanvas, 0, 0, c.width, c.height);
      fillRenderer.setPixelRatio(dpr());
      fillRenderer.setSize(w, h, false);
    }
    if (state.showLines) drawSliceFrame(c, cx, scale, w, h, false);
    out = c;
  }
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `terrain-${state.mode}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function wireUI() {
  $('btnLoad').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btnSample').addEventListener('click', loadSample);

  $('modeShaded').addEventListener('click', () => setMode('shaded'));
  $('modeSlices').addEventListener('click', () => setMode('slices'));

  $('height').addEventListener('input', (e) => setHeightPct(+e.target.value));

  $('proj').addEventListener('input', (e) => {
    rig.persp = +e.target.value / 100;
    $('projVal').textContent = rig.persp >= 1 ? 'Orthographic'
      : rig.persp === 0 ? 'Perspective' : `${Math.round(rig.persp * 100)}%`;
    rig.dirty = true;
    invalidate();
  });

  $('lock').addEventListener('change', (e) => setLocked(e.target.checked));
  $('heading').addEventListener('input', (e) => setHeading(+e.target.value));
  $('count').addEventListener('input', (e) => setLineCount(sliderToCount(+e.target.value)));
  $('precision').addEventListener('input', (e) => {
    const p = +e.target.value;
    slicer.dpEpsMult = 8 * (1 - p / 100) * (1 - p / 100); // 100% = full detail (no decimation)
    $('precVal').textContent = `${p}%`;
    slicer.invalidate();
    invalidate();
  });

  $('lineColor').addEventListener('input', (e) => { slicer.color = e.target.value; invalidate(); });
  $('showLines').addEventListener('change', (e) => {
    state.showLines = e.target.checked;
    invalidate();
  });
  const linePalWidget = createPaletteWidget($('linePaletteEditor'), slicer.linePalette, invalidate);
  const setLineColorMode = (m) => {
    slicer.lineColorMode = m;
    $('lineModeStatic').classList.toggle('on', m === 'static');
    $('lineModeGradient').classList.toggle('on', m === 'gradient');
    $('lineFlatRow').style.display = m === 'static' ? '' : 'none';
    $('linePaletteEditor').style.display = m === 'gradient' ? '' : 'none';
    if (m === 'gradient') linePalWidget.redraw(); // bar width is 0 while hidden
    invalidate();
  };
  $('lineModeStatic').addEventListener('click', () => setLineColorMode('static'));
  $('lineModeGradient').addEventListener('click', () => setLineColorMode('gradient'));
  setLineColorMode('gradient');

  $('showPlanes').addEventListener('change', (e) => {
    state.showPlanes = e.target.checked;
    invalidate();
  });
  createPaletteWidget($('planePaletteEditor'), slicer.curtainPalette, invalidate);

  $('bgColor').addEventListener('input', (e) => {
    slicer.bgColor = e.target.value;
    document.body.style.setProperty('--slice-bg', e.target.value);
    invalidate();
  });
  $('thickness').addEventListener('input', (e) => {
    slicer.thickness = +e.target.value;
    $('thickVal').textContent = slicer.thickness.toFixed(2);
    invalidate();
  });
  $('aa').addEventListener('change', (e) => {
    slicer.aa = +e.target.value;
    resizeLineCanvas();
  });

  $('btnSave').addEventListener('click', savePNG);
  $('btnReset').addEventListener('click', () => { rig.reset(); invalidate(); });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
}

// --- frame loop -----------------------------------------------------------
function tick() {
  requestAnimationFrame(tick);

  if (rig.dirty) {
    rig.update(window.innerWidth / window.innerHeight, terrain.radius);
    invalidate();
  }

  if (state.mode === 'slices' && slicer.locked) {
    const hd = ((rig.yaw / DEG) % 360 + 360) % 360;
    if (Math.abs(hd - slicer.headingDeg) > 0.005) {
      slicer.headingDeg = hd;
      slicer.invalidate();
      $('headingVal').textContent = `${hd.toFixed(1)}°`;
      $('heading').value = hd;
      invalidate();
    }
  }

  if (!needsRender) return;
  needsRender = false;

  if (state.mode === 'shaded') {
    renderer.render(scene, rig.activeCamera);
  } else {
    slicer.compute(terrain, slicer.headingDeg * DEG, slicer.lineCount);
    if (state.showPlanes) {
      slicer.updateCurtainColors(rig.activeCamera);
      fillRenderer.render(fillScene, rig.activeCamera);
    } else {
      fillRenderer.clear();
    }
    if (state.showLines) {
      drawSliceFrame(lineCanvas, lctx, slicer.renderScale, window.innerWidth, window.innerHeight, true);
    } else {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, lineCanvas.width, lineCanvas.height);
    }
    $('sliceInfo').textContent =
      `${slicer.numSlices} lines · spacing ${slicer.spacing.toFixed(3)} · ${(slicer._totalPoints())} pts`;
  }
}

// Render the slice view into a 2D context at the given scale (device px per
// CSS px). Shared by the display canvas and the PNG exporter.
function drawSliceFrame(canvas, ctx, scale, w, h, clear) {
  const depth = renderDepthBuffer();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (clear) ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  slicer.render(ctx, rig.activeCamera, terrain, w, h, depth);
}

// small helper attached to slicer for the status line
SliceRenderer.prototype._totalPoints = function () {
  let t = 0;
  for (let i = 0; i < this.numSlices; i++) t += this.count[i];
  return t;
};

// --- boot -----------------------------------------------------------------
wireUI();
rig.attach(document.body, (e) =>
  e.target instanceof Element && !!e.target.closest('#panel, #toast'));
window.addEventListener('resize', resize);
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(dpr());
  renderer.setSize(w, h, false);
  rig.setViewHeight(h);
  resizeLineCanvas();
  resizeDepthRT();
  resizeFillRenderer();
  invalidate();
}
resize();
loadSample();
setMode('slices');
setLocked(true);
// exposed for debugging / automated tests
window.__app = { terrain, rig, slicer, state, mesh, scene, renderer, invalidate,
  get depthStats() { return lastDepthStats; },
  get depthData() { return { data: depthData, w: depthRT.width, h: depthRT.height }; },
  get depthRaw() { return depthBuf; } };
requestAnimationFrame(tick);
