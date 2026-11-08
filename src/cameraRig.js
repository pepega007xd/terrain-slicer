import * as THREE from 'three';
import { WORLD_SIZE } from './terrain.js';

const DEG = Math.PI / 180;
// Elevation is clamped to strictly positive angles: the camera can never
// dip below the terrain plane (no viewing from underneath).
const MIN_ELEV = 0.15 * DEG;
const MAX_ELEV = 90 * DEG - 0.05 * DEG;

/**
 * Orbit camera rig.
 *
 * - yaw / elevation orbit around `target`, elevation kept in (0, 90).
 * - `frame` = world units visible vertically at the target distance
 *   (used both for perspective and orthographic, so zoom feels identical).
 * - `persp` in [0,1] blends perspective -> orthographic: the fov shrinks
 *   while the camera pulls back so the framing stays constant; at 1 a true
 *   orthographic camera takes over.
 */
export class CameraRig {
  constructor() {
    this.target = new THREE.Vector3(0, 1, 0);
    this.yaw = 25 * DEG;
    this.elevation = 33 * DEG;
    this.frame = 18;
    this.persp = 0;
    this.bounds = { size: WORLD_SIZE, height: 2 };
    this.dirty = true;

    this.perspCam = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 500);
    this._dir = new THREE.Vector3();
  }

  get activeCamera() {
    return this.persp >= 1 ? this.orthoCam : this.perspCam;
  }

  update(aspect, radius) {
    radius = Math.max(radius, 1);
    if (this.persp < 1) {
      // distance-linear interpolation => perceptually smooth blend
      const tanH = Math.tan(22.5 * DEG) + (Math.tan(1 * DEG) - Math.tan(22.5 * DEG)) * this.persp;
      const d = this.frame / (2 * tanH);
      const cam = this.perspCam;
      cam.fov = 2 * Math.atan(tanH) / DEG;
      cam.aspect = aspect;
      cam.near = Math.max(d * 0.02, d - 1.6 * radius);
      cam.far = d + 1.8 * radius;
      cam.updateProjectionMatrix();
      this._place(cam, d);
    } else {
      const cam = this.orthoCam;
      const hh = this.frame / 2, hw = hh * aspect;
      cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
      const d = Math.max(4 * radius, this.frame * 1.5);
      cam.near = 0.01;
      cam.far = d + 2.5 * radius;
      cam.updateProjectionMatrix();
      this._place(cam, d);
    }
    this.dirty = false;
  }

  _place(cam, d) {
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    this._dir.set(Math.sin(this.yaw) * ce, se, Math.cos(this.yaw) * ce);
    cam.position.copy(this.target).addScaledVector(this._dir, d);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.target);
    cam.updateMatrixWorld();
  }

  reset() {
    this.yaw = 25 * DEG;
    this.elevation = 33 * DEG;
    this.frame = 18;
    this.target.set(0, this.bounds.height / 2, 0);
    this.dirty = true;
  }

  /**
   * Attach mouse controls to a surface element. `overUI(event)` should
   * return true when the event lands on UI that must not orbit the camera.
   */
  attach(surface, overUI) {
    let drag = null;

    surface.addEventListener('pointerdown', (e) => {
      if (overUI(e)) return;
      const mode = (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'rotate';
      drag = { mode, x: e.clientX, y: e.clientY };
      surface.setPointerCapture(e.pointerId);
      document.body.classList.add('dragging');
    });
    surface.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'rotate') {
        this.yaw -= dx * 0.0055;
        this.elevation = Math.min(MAX_ELEV, Math.max(MIN_ELEV, this.elevation + dy * 0.0055));
      } else {
        this.pan(dx, dy);
      }
      this.dirty = true;
    });
    const end = (e) => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove('dragging');
      try { surface.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    surface.addEventListener('pointerup', end);
    surface.addEventListener('pointercancel', end);
    surface.addEventListener('wheel', (e) => {
      if (overUI(e)) return;
      e.preventDefault();
      this.frame = Math.min(80, Math.max(0.5, this.frame * Math.exp(e.deltaY * 0.0012)));
      this.dirty = true;
    }, { passive: false });
    surface.addEventListener('contextmenu', (e) => {
      if (!overUI(e)) e.preventDefault();
    });
  }

  pan(dx, dy) {
    const w = Math.max(1, this._viewH || window.innerHeight);
    const wpp = this.frame / w; // world units per pixel at the target
    const yaw = this.yaw;
    // camera right on the ground plane, and screen-up direction
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const ux = -Math.sin(yaw) * se, uy = ce, uz = -Math.cos(yaw) * se;
    this.target.x += (-dx * rx + dy * ux) * wpp;
    this.target.y += dy * uy * wpp;
    this.target.z += (-dx * rz + dy * uz) * wpp;
    const b = this.bounds;
    this.target.x = Math.min(b.size, Math.max(-b.size, this.target.x));
    this.target.z = Math.min(b.size, Math.max(-b.size, this.target.z));
    this.target.y = Math.min(b.height + 1, Math.max(-0.5, this.target.y));
  }

  setViewHeight(h) { this._viewH = h; }
}
