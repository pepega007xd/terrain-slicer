// Deterministic fbm value-noise terrain, used as the built-in sample.
// Framework-agnostic ESM so the node sample-file generator can reuse it.

function smoothstep(a, b, x) {
  x = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

function hash2(ix, iz) {
  let x = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function generateSampleHeights(n = 512) {
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n, v = j / n;
      let x = u * 6, z = v * 6;
      let amp = 1, sum = 0, norm = 0;
      for (let o = 0; o < 6; o++) {
        sum += vnoise(x, z) * amp;
        norm += amp;
        amp *= 0.55;
        x = x * 2.03 + 7.31;
        z = z * 2.03 + 3.17;
      }
      let e = sum / norm;
      // island falloff so edges sink down (nice for ridge plots)
      const r = Math.hypot(u - 0.5, v - 0.5) * 2;
      e *= 1 - smoothstep(0.55, 1.05, r);
      e = Math.pow(Math.max(0, e), 1.15);
      out[j * n + i] = e;
    }
  }
  return { gridW: n, gridH: n, values: out, channels: 1 };
}
