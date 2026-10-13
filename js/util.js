// Small helpers ported from Utils.cpp / Utils.h

export const rnd = () => Math.random();   // late-bound, so a bot can seed Math.random
export const randomI = (r) => Math.floor(Math.random() * r);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Gradient noise (gnoise3d from Utils.cpp), used for the warped title lettering.
const PERM = [
  225,155,210,108,175,199,221,144,203,116, 70,213, 69,158, 33,252,
    5, 82,173,133,222,139,174, 27,  9, 71, 90,246, 75,130, 91,191,
  169,138,  2,151,194,235, 81,  7, 25,113,228,159,205,253,134,142,
  248, 65,224,217, 22,121,229, 63, 89,103, 96,104,156, 17,201,129,
   36,  8,165,110,237,117,231, 56,132,211,152, 20,181,111,239,218,
  170,163, 51,172,157, 47, 80,212,176,250, 87, 49, 99,242,136,189,
  162,115, 44, 43,124, 94,150, 16,141,247, 32, 10,198,223,255, 72,
   53,131, 84, 57,220,197, 58, 50,208, 11,241, 28,  3,192, 62,202,
   18,215,153, 24, 76, 41, 15,179, 39, 46, 55,  6,128,167, 23,188,
  106, 34,187,140,164, 73,112,182,244,195,227, 13, 35, 77,196,185,
   26,200,226,119, 31,123,168,125,249, 68,183,230,177,135,160,180,
   12,  1,243,148,102,166, 38,238,251, 37,240,126, 64, 74,161, 40,
  184,149,171,178,101, 66, 29, 59,146, 61,254,107, 42, 86,154,  4,
  236,232,120, 21,233,209, 45, 98,193,114, 78, 19,206, 14,118,127,
   48, 79,147, 85, 30,207,219, 54, 88,234,190,122, 95, 67,143,109,
  137,214,145, 93, 92,100,245,  0,216,186, 60, 83,105, 97,204, 52,
];

const gradientTab = new Float32Array(256 * 3);
(function gradientTabInit(seed) {
  // Park-Miller minimal standard generator, as in LongRandom()
  let s = seed;
  const next = () => {
    const hi = Math.floor(s / 127773), lo = s % 127773;
    const test = 16807 * lo - 2836 * hi;
    s = test > 0 ? test : test + 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 256; i++) {
    const z = 1 - 2 * next();
    const r = Math.sqrt(1 - z * z);
    const theta = 2 * 3.14159 * next();
    gradientTab[i * 3] = r * Math.cos(theta);
    gradientTab[i * 3 + 1] = r * Math.sin(theta);
    gradientTab[i * 3 + 2] = z;
  }
})(665);

const perm = (x) => PERM[x & 255];
const glattice = (ix, iy, iz, fx, fy, fz) => {
  const g = perm(ix + perm(iy + perm(iz))) * 3;
  return gradientTab[g] * fx + gradientTab[g + 1] * fy + gradientTab[g + 2] * fz;
};
const ease = (x) => x * x * (3 - 2 * x);
const lerp = (t, a, b) => a + t * (b - a);

export function gnoise3d(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx0 = x - ix, fx1 = fx0 - 1, wx = ease(fx0);
  const fy0 = y - iy, fy1 = fy0 - 1, wy = ease(fy0);
  const fz0 = z - iz, fz1 = fz0 - 1, wz = ease(fz0);
  let vx0 = glattice(ix, iy, iz, fx0, fy0, fz0);
  let vx1 = glattice(ix + 1, iy, iz, fx1, fy0, fz0);
  let vy0 = lerp(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz, fx0, fy1, fz0);
  vx1 = glattice(ix + 1, iy + 1, iz, fx1, fy1, fz0);
  let vy1 = lerp(wx, vx0, vx1);
  const vz0 = lerp(wy, vy0, vy1);
  vx0 = glattice(ix, iy, iz + 1, fx0, fy0, fz1);
  vx1 = glattice(ix + 1, iy, iz + 1, fx1, fy0, fz1);
  vy0 = lerp(wx, vx0, vx1);
  vx0 = glattice(ix, iy + 1, iz + 1, fx0, fy1, fz1);
  vx1 = glattice(ix + 1, iy + 1, iz + 1, fx1, fy1, fz1);
  vy1 = lerp(wx, vx0, vx1);
  const vz1 = lerp(wy, vy0, vy1);
  return lerp(wz, vz0, vz1);
}

// localStorage can be missing or throw (private mode, blocked storage)
export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* storage unavailable */ }
}
