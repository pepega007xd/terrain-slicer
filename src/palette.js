// Multi-stop color palette with RGB or HSV interpolation.
// Colors are stored as [r, g, b] arrays with 0..255 components.

export function rgbToCss(c) {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

export function rgbToHex(c) {
  return '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 0..255 sRGB component -> 0..1 linear (for GPU vertex colors). */
export function srgbToLinear(v255) {
  const s = v255 / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h, s, v) {
  h = (h % 1 + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return [r * 255, g * 255, b * 255];
}

/**
 * Sample the palette at position t in [0, 1]. Stops must be sorted by t.
 * RGB mode lerps each channel; HSV mode lerps hue along the shorter arc
 * plus saturation/value.
 */
export function samplePalette(palette, t) {
  const stops = palette.stops;
  if (!stops || stops.length === 0) return [255, 255, 255];
  t = Math.min(1, Math.max(0, t));
  if (t <= stops[0].t) return stops[0].color;
  const last = stops[stops.length - 1];
  if (t >= last.t) return last.color;
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t < t) i++;
  const a = stops[i], b = stops[i + 1];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  if (palette.mode === 'hsv') {
    const [h1, s1, v1] = rgbToHsv(a.color[0], a.color[1], a.color[2]);
    const [h2, s2, v2] = rgbToHsv(b.color[0], b.color[1], b.color[2]);
    let dh = h2 - h1;
    if (dh > 0.5) dh -= 1;
    else if (dh < -0.5) dh += 1;
    return hsvToRgb(h1 + dh * f, s1 + (s2 - s1) * f, v1 + (v2 - v1) * f);
  }
  return [
    a.color[0] + (b.color[0] - a.color[0]) * f,
    a.color[1] + (b.color[1] - a.color[1]) * f,
    a.color[2] + (b.color[2] - a.color[2]) * f,
  ];
}

export function defaultLinePalette() {
  return {
    mode: 'rgb',
    stops: [
      { t: 0, color: [255, 255, 255] },  // nearest slices
      { t: 1, color: [0x24, 0x1f, 0x31] }, // farthest slices
    ],
  };
}

export function defaultPlanePalette() {
  return {
    mode: 'rgb',
    stops: [
      { t: 0, color: [0x24, 0x1f, 0x31] }, // nearest slices
      { t: 1, color: [0, 0, 0] },          // farthest slices
    ],
  };
}
