// Gradient-stop palette editor: a bar showing the interpolated palette.
// Click the bar to add a stop, drag stops to move them, double-click a stop
// (or the ✕ button) to remove it. Interpolates in RGB or HSV.

import { samplePalette, rgbToCss, rgbToHex, hexToRgb } from './palette.js';

function el(tag, cls) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  return d;
}

export function createPaletteWidget(container, palette, onChange) {
  container.appendChild(el('canvas', 'pal-bar'));
  container.appendChild(el('div', 'pal-stops'));
  const row = el('div', 'pal-row');
  const colorInput = el('input');
  colorInput.type = 'color';
  colorInput.title = 'Selected stop color';
  const delBtn = el('button', 'pal-del');
  delBtn.textContent = '✕';
  delBtn.title = 'Remove selected stop';
  const modeSel = el('select', 'pal-mode');
  for (const [value, label] of [['rgb', 'RGB'], ['hsv', 'HSV']]) {
    const o = el('option');
    o.value = value;
    o.textContent = label;
    modeSel.appendChild(o);
  }
  modeSel.title = 'Interpolation';
  row.append(colorInput, delBtn, modeSel);
  container.appendChild(row);

  let selected = null; // the selected stop object
  const handles = new Map(); // stop object -> handle element (kept stable across redraws)

  function drawBar() {
    const bar = container.querySelector('.pal-bar');
    const w = Math.max(2, bar.clientWidth || container.clientWidth || 200);
    if (bar.width !== w) bar.width = w;
    const g = bar.getContext('2d');
    for (let x = 0; x < w; x++) {
      const c = samplePalette(palette, w > 1 ? x / (w - 1) : 0);
      g.fillStyle = rgbToCss(c);
      g.fillRect(x, 0, 1, bar.height);
    }
  }

  // Update the stop handles in place — element identity must survive redraws
  // for native double-click detection (rebuilding them would detach the node
  // mid-click and break the event, plus re-detach hazards for the camera rig).
  function syncStops() {
    const stopsLayer = container.querySelector('.pal-stops');
    for (const [stop, d] of Array.from(handles)) {
      if (!palette.stops.includes(stop)) {
        d.remove();
        handles.delete(stop);
      }
    }
    palette.stops.forEach((s) => {
      let d = handles.get(s);
      if (!d) {
        d = el('div', 'pal-stop');
        d.title = 'Drag to move · double-click to edit color · right-click to remove';
        d.addEventListener('pointerdown', (e) => {
          e.stopPropagation(); // keep the camera rig out of palette interactions
          if (e.button === 2) { removeStop(s); return; }
          if (e.button !== 0) return;
          selected = s;
          syncStops();
          startDrag(e, s);
        });
        d.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openColorPicker(s);
        });
        stopsLayer.appendChild(d);
        handles.set(s, d);
      }
      d.style.left = (s.t * 100).toFixed(2) + '%';
      d.style.background = rgbToCss(s.color);
      d.classList.toggle('sel', s === selected);
    });
  }

  function redraw() {
    drawBar();
    syncStops();
    if (selected && palette.stops.includes(selected)) {
      colorInput.disabled = false;
      if (document.activeElement !== colorInput) colorInput.value = rgbToHex(selected.color);
      delBtn.disabled = palette.stops.length <= 1;
    } else {
      colorInput.disabled = true;
      delBtn.disabled = true;
    }
    modeSel.value = palette.mode;
  }

  function commit() {
    if (onChange) onChange();
    redraw();
  }

  function openColorPicker(stop) {
    selected = stop;
    redraw();
    colorInput.disabled = false;
    colorInput.value = rgbToHex(stop.color);
    colorInput.focus();
    let opened = false;
    try { colorInput.showPicker(); opened = true; } catch { /* fallback below */ }
    if (!opened) { try { colorInput.click(); } catch { /* input stays editable */ } }
  }

  function removeStop(stop) {
    if (palette.stops.length <= 1) return;
    const i = palette.stops.indexOf(stop);
    if (i >= 0) palette.stops.splice(i, 1);
    if (selected === stop) selected = null;
    commit();
  }

  function startDrag(e, stop) {
    e.preventDefault();
    const rect = container.querySelector('.pal-stops').getBoundingClientRect();
    const move = (ev) => {
      stop.t = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      palette.stops.sort((a, b) => a.t - b.t);
      commit();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }

  container.addEventListener('contextmenu', (e) => e.preventDefault()); // right-click deletes stops

  container.querySelector('.pal-bar').addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // keep the camera rig out of palette interactions
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const stop = { t, color: samplePalette(palette, t) };
    palette.stops.push(stop);
    palette.stops.sort((a, b) => a.t - b.t);
    selected = stop;
    commit();
  });

  colorInput.addEventListener('input', () => {
    if (!selected) return;
    selected.color = hexToRgb(colorInput.value);
    commit();
  });

  delBtn.addEventListener('click', () => {
    if (selected) removeStop(selected);
  });

  modeSel.addEventListener('change', () => {
    palette.mode = modeSel.value;
    commit();
  });

  redraw();

  return { redraw };
}
