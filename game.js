/* ==========================================================================
   OPEN ROAD – hand-driven interstate at dusk (prototype v0.4)
   Three.js r128 (classic script) + MediaPipe Tasks Vision HandLandmarker (runs in a Web Worker when possible).
   Speed first: opaque canvas, 2 lights, no shadows / transparency / post effects, simple scenery, instanced props,
   internal resolution capped and lowered automatically, hand tracking off the main thread.
   ========================================================================== */
(() => {
'use strict';

const VERSION = 'Build 0.6 (Indian highway)';
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const now = () => performance.now() / 1000;
const KPH = 3.6;

/* --------------------------- error surface ------------------------------ */
let errTimer = 0;
function showError(msg, ms) {
  const e = $('errorTag'); if (!e) return;
  e.textContent = msg; e.hidden = false;
  clearTimeout(errTimer); errTimer = setTimeout(() => { e.hidden = true; }, ms || 12000);
  console.error(msg);
}

function requestTrafficYield() {
  for (const o of obstacles) {
    if (!o.active || o.kind !== 'veh' || o.lc || o.yieldUntil > tNow || o.z > -3 || o.z < -45) continue;
    if (Math.abs(o.x - car.x) > o.hw + carHW + 1.5) continue;
    const lane = nearestLane(o.x), targetLane = Math.max(0, lane - 1);
    const targetX = lane === 0 ? -5.65 : CFG.laneX[targetLane];
    if (Math.abs(targetX - o.x) < 0.7 || !clearAt(targetX, o.z, o.hw, o.hl, o.v, o, 0.55)) continue;
    startLaneChange(o, targetX, targetLane);
    o.yieldUntil = tNow + 3;
  }
}
addEventListener('error', (ev) => showError('Something went wrong: ' + (ev.message || 'unknown error')));
addEventListener('unhandledrejection', (ev) => showError('Something went wrong: ' + String((ev.reason && ev.reason.message) || ev.reason || 'unknown error')));

if (typeof THREE === 'undefined') {
  $('menuStatus').textContent = 'The 3D library could not be loaded. Check your internet connection and reload the page.';
  return;
}

/* ------------------------------ CONFIG ---------------------------------- */
const CFG = {
  carLimit: 5.5,                            // sideways limit for the player car (road half-width is 7)
  laneX: [-4.8, -1.6, 1.6, 4.8],            // lane centres, left to right; Indian traffic keeps left and overtakes on the right
  speed: { min: 10, lost: 22, maxStart: 56, maxEnd: 82, accel: 20, brake: 30, coast: 14 },   // metres per second
  hand: {
    delegate: 'GPU',                        // 'GPU' or 'CPU' for hand tracking (falls back to CPU automatically)
    fistRatio: 1.3,                         // fingertip/palm distance below this = fist (brake)
    steerRange: 0.30,                       // one hand: travel from centre to full lock, as a fraction of camera width
    lostAfter: 0.6,                         // seconds without a hand before the car coasts
    wheelMaxDeg: 35,                        // two hands: tilt for full lock
    wheelSpeed: 9,                          // two hands: sideways speed at full lock
    maxHz: 20,                              // upper limit of hand detections per second (the real rate adapts to your PC)
  },
  keyLateral: 8,
  maxLateral: 10,
  // Traffic difficulty. capStart/capEnd = how many vehicles share the road, rampMeters = distance to full difficulty,
  // spawnMin/Max = seconds between new vehicles, barrierMin/Max = seconds between road-work barriers.
  traffic: { capStart: 14, capEnd: 22, rampMeters: 2600, startDiff: 0.25, spawnMin: 0.3, spawnMax: 0.6, barrierMin: 2.0, barrierMax: 3.6 },
  fog: 0xc48b5a,                            // warm Indian highway haze, also the colour of the horizon
  view: 200,
};
const BACK_Z = 45, SPAN = 300, SPAWN_Z = -215;
const ROAD_W = 14, ROAD_LEN = 330, ROAD_TILE = 12;
let carHW = 0.92, carHL = 2.3;                // collision half-size of the selected player car

/* ------------------------------ RENDERER -------------------------------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: false, alpha: false, stencil: false, powerPreference: 'low-power' });
} catch (err) {
  $('menuStatus').textContent = 'WebGL is not available in this browser, so the 3D view cannot start.';
  return;
}
renderer.setClearColor(CFG.fog, 1);

let gpuName = '', softGL = false;                      // detect software rendering: it explains very low frame rates
try {
  const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  gpuName = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  softGL = /swiftshader|llvmpipe|software|microsoft basic/i.test(gpuName);
} catch (e) { /* not available */ }

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(CFG.fog, 40, CFG.view);
const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.5, 300);
camera.position.set(0, 2.8, 7.4);

/* Internal resolution: capped at 960 px wide, then scaled by the quality level (CSS stretches it to the window). */
const Q = { levels: [1, 0.75, 0.6, 0.5, 0.4, 0.3], level: softGL ? 4 : 1, w: 0, h: 0 };
const decorMeshes = [];
function applyQuality() {
  const s = Q.levels[Q.level], aspect = innerWidth / innerHeight;
  Q.w = Math.max(256, Math.floor(Math.min(innerWidth, 960) * s));
  Q.h = Math.max(144, Math.floor(Q.w / aspect));
  renderer.setPixelRatio(1);
  renderer.setSize(Q.w, Q.h, false);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  for (const m of decorMeshes) m.visible = Q.level < 3;       // drop roadside decoration on weak machines
}
addEventListener('resize', applyQuality);
function cycleQuality() { Q.level = (Q.level + 1) % Q.levels.length; applyQuality(); toast('Render ' + Q.w + ' x ' + Q.h); }

/* ------------------------------ LIGHTS ---------------------------------- */
const hemisphereLight = new THREE.HemisphereLight(0xe3a898, 0x2a2030, 0.95); scene.add(hemisphereLight);
const sunLight = new THREE.DirectionalLight(0xffc890, 0.8); sunLight.position.set(-25, 30, 35); scene.add(sunLight);

/* ------------------------------ HELPERS --------------------------------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const clampTex = (t) => { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };

/* Merge parts into ONE geometry with vertex colours (one draw call per model). */
function mergeGeos(items) {
  const pos = [], col = [], idx = [];
  let off = 0;
  for (const it of items) {
    const g = it.g, pa = g.attributes.position, ia = g.index;
    const c = new THREE.Color(it.c);
    const sx = it.sx || 1, sy = it.sy || 1, sz = it.sz || 1, ox = it.x || 0, oy = it.y || 0, oz = it.z || 0;
    for (let i = 0; i < pa.count; i++) {
      pos.push(pa.getX(i) * sx + ox, pa.getY(i) * sy + oy, pa.getZ(i) * sz + oz);
      col.push(c.r, c.g, c.b);
    }
    if (ia) for (let i = 0; i < ia.count; i++) idx.push(ia.getX(i) + off);
    else for (let i = 0; i < pa.count; i++) idx.push(i + off);
    off += pa.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
const B = (w, h, d, x, y, z, c) => ({ g: new THREE.BoxGeometry(w, h, d), x, y, z, c });
const ICO = new THREE.IcosahedronGeometry(1, 0);
const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 8); wheelGeo.rotateZ(Math.PI / 2);
const WHEEL = (x, y, z, radius, thick) => ({ g: wheelGeo, x, y, z, sx: thick, sy: radius, sz: radius, c: 0x0b0b0e });

/* Hexahedron with a different bottom and top rectangle (slanted windscreens, hoods). */
function hexa(y0, y1, z0b, z1b, wb, z0t, z1t, wt, c) {
  const V = [[-wb, y0, z0b], [wb, y0, z0b], [wb, y0, z1b], [-wb, y0, z1b], [-wt, y1, z0t], [wt, y1, z0t], [wt, y1, z1t], [-wt, y1, z1t]];
  const cen = [0, (y0 + y1) / 2, (z0b + z1b + z0t + z1t) / 4];
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
  const p = [];
  for (const f of faces) {
    let a = V[f[0]], b = V[f[1]], c2 = V[f[2]], d = V[f[3]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c2[0] + d[0]) / 4 - cen[0], my = (a[1] + b[1] + c2[1] + d[1]) / 4 - cen[1], mz = (a[2] + b[2] + c2[2] + d[2]) / 4 - cen[2];
    if (nx * mx + ny * my + nz * mz < 0) { const t = b; b = d; d = t; }
    p.push(a[0], a[1], a[2], b[0], b[1], b[2], c2[0], c2[1], c2[2], a[0], a[1], a[2], c2[0], c2[1], c2[2], d[0], d[1], d[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return { g, c };
}

/* Write position/scale/yaw straight into an instance matrix. */
function setInst(m, i, x, y, z, sx, sy, sz, ry) {
  const a = m.instanceMatrix.array, o = i * 16, c = Math.cos(ry), s = Math.sin(ry);
  a[o] = c * sx;     a[o + 1] = 0;  a[o + 2] = -s * sx;  a[o + 3] = 0;
  a[o + 4] = 0;      a[o + 5] = sy; a[o + 6] = 0;        a[o + 7] = 0;
  a[o + 8] = s * sz; a[o + 9] = 0;  a[o + 10] = c * sz;  a[o + 11] = 0;
  a[o + 12] = x;     a[o + 13] = y; a[o + 14] = z;       a[o + 15] = 1;
}

/* Recycled scenery: items scroll toward the camera and wrap to the far end. One or several meshes can share the same matrices. */
const scatters = [];
function makeScatter(meshes, items, reroll, decor) {
  const list = Array.isArray(meshes) ? meshes : [meshes];
  for (const m of list) { m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); if (decor) decorMeshes.push(m); }
  items.forEach((it, i) => {
    it.idx = i; it.x = it.x || 0; it.y = it.y || 0; it.sx = it.sx || 1; it.sy = it.sy || 1; it.sz = it.sz || 1; it.ry = it.ry || 0;
    reroll(it, true);
  });
  const write = () => {
    for (const it of items) for (const m of list) setInst(m, it.idx, it.x, it.y, it.z, it.sx, it.sy, it.sz, it.ry);
    for (const m of list) m.instanceMatrix.needsUpdate = true;
  };
  write();
  scatters.push({ update(d) { for (const it of items) { it.z += d; if (it.z > BACK_Z) { it.z -= SPAN; reroll(it, false); } } write(); } });
}

/* ------------------------------ EVENING SKY ----------------------------- */
// Sky = one gradient quad (indigo at the top, rose, then sunset orange at the horizon, same colour as the fog).
const SKY_ROWS = [0x24456b, 0x55799a, 0xc58a65, CFG.fog], NIGHT_SKY_ROWS = [0x070b1b, 0x0a1026, 0x111a31, 0x1c2536], SKY_H = 200;
function skyColorAt(y, night = 0) {
  const u = clamp(1 - y / SKY_H, 0, 1) * 3, i = Math.min(2, Math.floor(u)), f = u - i;
  const dayA = new THREE.Color(SKY_ROWS[i]), dayB = new THREE.Color(SKY_ROWS[i + 1]);
  const nightA = new THREE.Color(NIGHT_SKY_ROWS[i]), nightB = new THREE.Color(NIGHT_SKY_ROWS[i + 1]);
  const a = dayA.lerp(nightA, night), b = dayB.lerp(nightB, night);
  return [a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f];
}
const rgbToHex = (c) => ((Math.round(clamp(c[0], 0, 1) * 255) << 16) | (Math.round(clamp(c[1], 0, 1) * 255) << 8) | Math.round(clamp(c[2], 0, 1) * 255));
let skyQuad;
{
  const g = new THREE.PlaneGeometry(900, SKY_H, 1, 3), arr = [];
  SKY_ROWS.forEach((hex) => { const k = new THREE.Color(hex); arr.push(k.r, k.g, k.b, k.r, k.g, k.b); });
  g.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  skyQuad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  skyQuad.position.set(0, SKY_H / 2, -270); scene.add(skyQuad);
}
const skyGroup = new THREE.Group(); scene.add(skyGroup);          // follows the camera: sun, clouds, stars
let sunsetGlow, sunsetSun, sunsetClouds, nightStars;
{
  const glow = new THREE.CircleGeometry(62, 32), n = glow.attributes.position.count, arr = [];
  const rim = skyColorAt(26), mid = new THREE.Color(0xf6b06a);
  for (let i = 0; i < n; i++) { if (i === 0) arr.push(mid.r, mid.g, mid.b); else arr.push(rim[0], rim[1], rim[2]); }
  glow.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  sunsetGlow = new THREE.Mesh(glow, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true }));
  sunsetGlow.position.set(-45, 8, -256); skyGroup.add(sunsetGlow);
  sunsetSun = new THREE.Mesh(new THREE.CircleGeometry(9, 24), new THREE.MeshBasicMaterial({ color: 0xfff1cc, fog: false, transparent: true }));
  sunsetSun.position.set(-45, 8, -255); skyGroup.add(sunsetSun);

  const disc = new THREE.CircleGeometry(1, 12), items = [];
  for (let i = 0; i < 7; i++) {
    const y = rand(16, 74), c = skyColorAt(y);
    items.push({ g: disc, x: rand(-230, 230), y, z: 0, sx: rand(34, 76), sy: rand(1.6, 3.6), sz: 1, c: rgbToHex([c[0] + 0.14, c[1] + 0.1, c[2] + 0.05]) });
  }
  sunsetClouds = new THREE.Mesh(mergeGeos(items), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true }));
  sunsetClouds.position.z = -262; skyGroup.add(sunsetClouds);

  const ns = 70, sa = new Float32Array(ns * 3);
  for (let i = 0; i < ns; i++) {
    const a = rand(-1.05, 1.05), el = rand(0.3, 0.62), R = 235;
    sa[i * 3] = Math.sin(a) * Math.cos(el) * R; sa[i * 3 + 1] = Math.sin(el) * R; sa[i * 3 + 2] = -Math.cos(a) * Math.cos(el) * R;
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sa, 3));
  nightStars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe4ff, size: 1.5, sizeAttenuation: false, fog: false, transparent: true, opacity: 0 }));
  nightStars.frustumCulled = false; nightStars.visible = false; skyGroup.add(nightStars);
}
const hills = (() => {                                   // one merged mesh of dark hills on the horizon
  const cone = new THREE.ConeGeometry(1, 1, 5); cone.translate(0, 0.5, 0);
  const items = [];
  for (let x = -340; x <= 340; x += 44) items.push({ g: cone, x: x + rand(-14, 14), y: 0, z: -246 - rand(0, 4), sx: rand(40, 75), sy: rand(10, 28), sz: rand(18, 30), c: 0x2a1c3a });
  const m = new THREE.Mesh(mergeGeos(items), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
  scene.add(m); return m;
})();

const flatPlane = (w, l, x, y, z, mat) => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); scene.add(m); return m;
};
flatPlane(700, 330, 0, -0.05, -125, new THREE.MeshBasicMaterial({ color: 0x4a5035 }));

/* ------------------------------ INTERSTATE ------------------------------ */
const roadTex = canvasTex(128, 256, (g, w, h) => {
  const px = (x) => (x + ROAD_W / 2) / ROAD_W * w;
  g.fillStyle = '#27252d'; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.16)';
  for (const lx of CFG.laneX) { g.fillRect(px(lx - 0.95) - 3, 0, 6, h); g.fillRect(px(lx + 0.95) - 3, 0, 6, h); }     // worn wheel tracks
  g.fillStyle = '#e4e2e6';
  for (const x of [-3.2, 0, 3.2]) g.fillRect(px(x) - 1.5, 0, 3, h * (3.0 / ROAD_TILE));                              // dashed white lane lines
  g.fillStyle = '#f2f2f4'; g.fillRect(px(6.45) - 1.8, 0, 3.6, h);                                                     // solid white road edge
  g.fillStyle = '#f2f2f4'; g.fillRect(px(-6.55) - 1.8, 0, 3.6, h);                                                    // solid white road edge
});
roadTex.wrapS = THREE.ClampToEdgeWrapping;
roadTex.repeat.set(1, ROAD_LEN / ROAD_TILE);
flatPlane(ROAD_W, ROAD_LEN, 0, 0, -125, new THREE.MeshBasicMaterial({ map: roadTex }));

const vcolMat = new THREE.MeshLambertMaterial({ vertexColors: true });
{   // concrete median divider along the right edge for left-hand traffic
  const m = new THREE.Mesh(mergeGeos([
    B(0.9, 0.38, ROAD_LEN, 7.9, 0.19, -125, 0x8d8a86), B(0.46, 0.5, ROAD_LEN, 7.9, 0.63, -125, 0x9a9792),
  ]), vcolMat);
  scene.add(m);
}
{   // W-beam steel guardrail on the right shoulder
  const guardGeo = mergeGeos([
    B(0.1, 0.34, 12.0, 0, 0.62, 0, 0xaab2ba), B(0.16, 0.1, 12.0, 0, 0.62, 0, 0x9aa2aa),
    B(0.14, 0.8, 0.12, 0.12, 0.4, -4, 0x6c737b), B(0.14, 0.8, 0.12, 0.12, 0.4, 0, 0x6c737b), B(0.14, 0.8, 0.12, 0.12, 0.4, 4, 0x6c737b),
  ]);
  const items = []; for (let i = 0; i < 25; i++) items.push({ z: BACK_Z - (i + 0.5) * 12 });
  makeScatter(new THREE.InstancedMesh(guardGeo, vcolMat, 25), items, (it) => { it.x = -7.7; });
}
{   // street lamps standing on the median, arm over the road
  const lampGeo = mergeGeos([
    B(0.22, 7.5, 0.22, 0, 3.75, 0, 0x4b4f58), B(3.4, 0.12, 0.12, 1.7, 7.4, 0, 0x4b4f58), B(1.0, 0.14, 0.5, 3.1, 7.3, 0, 0xffe2b0),
  ]);
  const items = []; for (let i = 0; i < 8; i++) items.push({ z: BACK_Z - (i + 0.5) * (SPAN / 8) });
  makeScatter(new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), 8), items, (it) => { it.x = -8.5; });
}
{   // green exit signs on the right shoulder
  const tex = clampTex(canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#00693e'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f6f4f1'; g.lineWidth = 8; g.strokeRect(10, 10, w - 20, h - 20);
    g.fillStyle = '#ffcc00'; g.fillRect(26, 26, 190, 58);
    g.fillStyle = '#10120e'; g.font = 'bold 44px Arial, Helvetica, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText('NH 44', 38, 56);
    g.fillStyle = '#f6f4f1'; g.font = 'bold 62px Arial, Helvetica, sans-serif'; g.fillText('AGRA', 30, 140);
    g.font = 'bold 44px Arial, Helvetica, sans-serif'; g.fillText('500 M', 30, 205);
    g.beginPath(); g.moveTo(430, 70); g.lineTo(476, 130); g.lineTo(446, 130); g.lineTo(446, 215); g.lineTo(414, 215); g.lineTo(414, 130); g.lineTo(384, 130); g.closePath(); g.fill();
  }));
  const postGeo = mergeGeos([B(0.16, 4.4, 0.16, -1.6, 2.2, 0, 0x7c828c), B(0.16, 4.4, 0.16, 1.6, 2.2, 0, 0x7c828c)]);
  const boardGeo = new THREE.PlaneGeometry(4.6, 2.3); boardGeo.translate(0, 4.9, 0.12);
  const items = []; for (let i = 0; i < 3; i++) items.push({ z: BACK_Z - (i + 0.5) * 100 });
  makeScatter([new THREE.InstancedMesh(postGeo, vcolMat, 3), new THREE.InstancedMesh(boardGeo, new THREE.MeshBasicMaterial({ map: tex }), 3)], items, (it) => { it.x = -11; }, true);
}

/* ------------------------------ INDIAN HIGHWAY SCENERY ------------------ */
function monumentMesh(parts, phase) {
  const count = 2;
  const geo = mergeGeos(parts), mesh = new THREE.InstancedMesh(geo, vcolMat, count);
  makeScatter(mesh, Array.from({ length: count }, (_, i) => ({
    z: BACK_Z - (i * 6 + phase + 0.5) * (SPAN / (count * 6)),
  })), (it) => {
    it.x = it.idx % 2 ? -19 : 19;
    it.sx = it.sy = it.sz = 0.72;
  });
}
{
  const dome = new THREE.SphereGeometry(1, 12, 8);
  const domePart = (x, y, z, sx, sy, sz, c) => ({ g: dome, x, y, z, sx, sy, sz, c });
  const minaret = new THREE.CylinderGeometry(0.24, 0.38, 9, 8); minaret.translate(0, 4.5, 0);
  const taj = [
    B(13, 1, 10, 0, 0.5, 0, 0xc9bda7), B(9.5, 6, 7.2, 0, 4, 0, 0xe8e0d0),
    domePart(0, 7.5, 0, 2.5, 2.8, 2.5, 0xf1e8d5),
    B(7.5, 0.25, 7.5, 0, 9.4, 0, 0xded3c1),
  ];
  for (const x of [-5.2, 5.2]) for (const z of [-3.6, 3.6]) {
    taj.push({ g: minaret, x, y: 0, z, c: 0xe8e0d0 });
    taj.push(domePart(x, 9.4, z, 0.55, 0.72, 0.55, 0xf1e8d5));
  }
  taj.push(B(1.2, 4.2, 0.12, 0, 3, -3.66, 0x26313a));
  monumentMesh(taj, 0);

  const gate = [
    B(2, 8, 1.4, -4, 4, 0, 0x9a7050), B(2, 8, 1.4, 4, 4, 0, 0x9a7050),
    B(10.5, 2, 1.8, 0, 9, 0, 0xa77b57), B(8.8, 0.5, 1.9, 0, 10.2, 0, 0x8b674c),
    B(0.5, 1.3, 1.4, -2.6, 4.6, 0, 0x8f694d), B(0.5, 1.3, 1.4, 2.6, 4.6, 0, 0x8f694d),
  ];
  for (const x of [-4, 4]) gate.push(domePart(x, 8.1, 0, 1.1, 0.6, 0.9, 0xa77b57));
  monumentMesh(gate, 1);

  const tower = [];
  for (let i = 0; i < 5; i++) {
    const h = 2.6, r = 1.15 - i * 0.16;
    const section = new THREE.CylinderGeometry(r * 0.82, r, h, 9); section.translate(0, h / 2 + i * h, 0);
    tower.push({ g: section, y: 0, c: i % 2 ? 0xb97846 : 0xc68b55 });
    tower.push(B(r * 1.9, 0.18, r * 1.9, 0, (i + 1) * h, 0, 0x8e6040));
  }
  tower.push(domePart(0, 13.6, 0, 0.42, 0.55, 0.42, 0x8e6040));
  monumentMesh(tower, 2);

  const gateway = [
    B(2.2, 8.2, 1.6, -4.2, 4.1, 0, 0x9b6950), B(2.2, 8.2, 1.6, 4.2, 4.1, 0, 0x9b6950),
    B(10.8, 2, 2.0, 0, 9.2, 0, 0xa87857), B(0.5, 6.0, 0.18, -2.55, 3.0, -0.84, 0x543d31),
    B(0.5, 6.0, 0.18, 2.55, 3.0, -0.84, 0x543d31),
    domePart(-4.2, 8.6, 0, 1.0, 0.72, 1.0, 0xb48762),
    domePart(4.2, 8.6, 0, 1.0, 0.72, 1.0, 0xb48762),
  ];
  monumentMesh(gateway, 3);

  const hawa = [B(9.2, 1, 1.2, 0, 0.5, 0, 0xc88d61)];
  for (let row = 0; row < 5; row++) {
    const width = 9 - row * 1.25, y = 1.55 + row * 1.45, columns = 3 + row;
    hawa.push(B(width, 1.2, 0.9, 0, y, 0, row % 2 ? 0xd59b70 : 0xc88d61));
    for (let col = 0; col < columns; col++) {
      const x = -width * 0.42 + col * width * 0.84 / Math.max(1, columns - 1);
      hawa.push(B(0.34, 0.48, 0.06, x, y, -0.49, 0x533a31));
      hawa.push(B(0.5, 0.12, 0.14, x, y + 0.34, -0.52, 0xe0ad7e));
    }
  }
  hawa.push(B(3.0, 0.55, 1.1, 0, 8.95, 0, 0xd59b70));
  monumentMesh(hawa, 4);

  const wheel = new THREE.TorusGeometry(1.35, 0.16, 6, 14);
  const sunTemple = [B(11, 0.8, 7, 0, 0.4, 0, 0x9c6842)];
  for (let i = 0; i < 6; i++) {
    const width = 10.5 - i * 1.45;
    sunTemple.push(B(width, 1.15, 6.3 - i * 0.72, 0, 1.35 + i * 1.12, 0, i % 2 ? 0xb77b4c : 0xa96f43));
  }
  sunTemple.push({ g: wheel, x: -3.2, y: 2.2, z: -3.25, c: 0x593c2b }, { g: wheel, x: 3.2, y: 2.2, z: -3.25, c: 0x593c2b });
  monumentMesh(sunTemple, 5);

  const heritageNames = ['TAJ MAHAL', 'INDIA GATE', 'QUTUB MINAR', 'GATEWAY OF INDIA', 'HAWA MAHAL', 'KONARK TEMPLE'];
  heritageNames.forEach((name, phase) => {
    const tex = clampTex(canvasTex(512, 192, (g, w, h) => {
      g.fillStyle = '#783c28'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#f0d7a8'; g.lineWidth = 10; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#f4e5c9'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'bold 28px Arial, Helvetica, sans-serif'; g.fillText('INDIAN HERITAGE ROUTE', w / 2, 55);
      g.font = 'bold 48px Arial, Helvetica, sans-serif'; g.fillText(name, w / 2, 125);
    }));
    const board = new THREE.PlaneGeometry(5.2, 1.9); board.translate(0, 3.8, 0.12);
    const posts = mergeGeos([B(0.18, 2.9, 0.18, -2.0, 1.45, 0, 0x6f513a), B(0.18, 2.9, 0.18, 2.0, 1.45, 0, 0x6f513a)]);
    const count = 2, items = Array.from({ length: count }, (_, i) => ({
      z: BACK_Z + 7 - (i * 6 + phase + 0.5) * (SPAN / (count * 6)),
    }));
    makeScatter([new THREE.InstancedMesh(posts, vcolMat, count), new THREE.InstancedMesh(board, new THREE.MeshBasicMaterial({ map: tex }), count)], items, (it) => {
      it.x = it.idx % 2 ? -12.5 : 12.5;
      it.sx = it.sy = it.sz = 0.82;
    }, true);
  });
}
{
  const trunk = new THREE.CylinderGeometry(0.35, 0.6, 5, 7); trunk.translate(0, 2.5, 0);
  const canopy = new THREE.SphereGeometry(1, 7, 5);
  const tree = mergeGeos([
    { g: trunk, c: 0x76513a },
    { g: canopy, x: 0, y: 5.3, z: 0, sx: 2.3, sy: 2.8, sz: 2.1, c: 0x56713b },
    { g: canopy, x: -1.25, y: 4.9, z: 0.2, sx: 1.45, sy: 1.8, sz: 1.6, c: 0x6c8542 },
    { g: canopy, x: 1.2, y: 4.9, z: -0.2, sx: 1.5, sy: 1.8, sz: 1.55, c: 0x496438 },
  ]);
  const items = []; for (let i = 0; i < 14; i++) items.push({ z: BACK_Z - (i + 0.5) * (SPAN / 14) });
  makeScatter(new THREE.InstancedMesh(tree, vcolMat, items.length), items, (it) => {
    it.x = (it.idx % 2 ? 1 : -1) * rand(13, 22);
    it.sx = rand(0.7, 1.25); it.sy = rand(0.75, 1.3); it.sz = it.sx;
  }, true);
}
{
  const trunk = new THREE.CylinderGeometry(0.24, 0.42, 8, 7); trunk.translate(0, 4, 0);
  const fronds = [];
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.ConeGeometry(0.34, 5.2, 5);
    leaf.rotateZ(Math.PI * 0.38);
    leaf.rotateY(i * Math.PI * 2 / 7);
    fronds.push({ g: leaf, y: 7.5, c: i % 2 ? 0x3f6a32 : 0x527a38 });
  }
  const palm = mergeGeos([{ g: trunk, c: 0x76513a }, ...fronds]);
  const items = []; for (let i = 0; i < 8; i++) items.push({ z: BACK_Z - (i + 0.5) * (SPAN / 8) });
  makeScatter(new THREE.InstancedMesh(palm, vcolMat, items.length), items, (it) => {
    it.x = (it.idx % 2 ? 1 : -1) * rand(12, 18);
    it.sx = it.sz = rand(0.8, 1.15); it.sy = rand(0.8, 1.25);
  }, true);
}
{   // a few stones, well away from the road
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a5f70, flatShading: true });
  const items = []; for (let i = 0; i < 6; i++) items.push({ z: BACK_Z - (i + Math.random()) * (SPAN / 6) });
  makeScatter(new THREE.InstancedMesh(ICO, mat, 6), items, (it) => {
    const s = rand(0.7, 2.0);
    it.sx = s * rand(0.9, 1.3); it.sy = s * rand(0.6, 1); it.sz = s * rand(0.9, 1.3);
    it.x = Math.random() < 0.5 ? -(10.5 + it.sx + rand(0.5, 14)) : (9.6 + it.sx + rand(0.5, 16));
    it.y = it.sy * 0.35; it.ry = rand(0, 6.28);
  }, true);
}

/* ------------------------------ VEHICLE MODELS -------------------------- */
const VSPEC = {                                    // L length, W width, hw/hl collision half-sizes, ly/lz/ls rear lamp placement, v speed range (m/s)
  hatch:  { L: 3.9,  W: 1.72, hw: 0.88, hl: 1.95, ly: 0.78, lz: 1.98, ls: 0.58, v: [22, 28] },
  sedan:  { L: 4.5,  W: 1.8,  hw: 0.92, hl: 2.25, ly: 0.82, lz: 2.28, ls: 0.62, v: [24, 31] },
  suv:    { L: 4.6,  W: 1.88, hw: 0.95, hl: 2.3,  ly: 0.98, lz: 2.33, ls: 0.68, v: [23, 30] },
  pickup: { L: 5.4,  W: 2.0,  hw: 0.98, hl: 2.7,  ly: 0.9,  lz: 2.78, ls: 0.74, v: [24, 31] },
  lux:    { L: 4.9,  W: 1.92, hw: 0.95, hl: 2.45, ly: 0.84, lz: 2.48, ls: 0.7,  v: [28, 36] },
  sports: { L: 4.4,  W: 1.98, hw: 0.97, hl: 2.2,  ly: 0.68, lz: 2.23, ls: 0.72, v: [32, 42] },
  luxsuv: { L: 4.9,  W: 2.0,  hw: 0.99, hl: 2.45, ly: 1.0,  lz: 2.48, ls: 0.74, v: [27, 34] },
  semi:   { L: 15,   W: 2.5,  hw: 1.28, hl: 7.5,  ly: 1.25, lz: 7.53, ls: 1.0,  v: [21, 26], heavy: true },
  bus:    { L: 10.6, W: 2.55, hw: 1.3,  hl: 5.3,  ly: 1.3,  lz: 5.33, ls: 1.0,  v: [20, 25], heavy: true },
  ambassador: { L: 4.45, W: 1.7, hw: 0.86, hl: 2.23, ly: 0.72, lz: 2.18, ls: 0.58, v: [22, 28] },
  innova: { L: 4.74, W: 1.83, hw: 0.94, hl: 2.37, ly: 0.82, lz: 2.3, ls: 0.64, v: [23, 30] },
  creta: { L: 4.33, W: 1.79, hw: 0.92, hl: 2.17, ly: 0.9, lz: 2.22, ls: 0.66, v: [24, 32] },
  sumo: { L: 4.1, W: 1.8, hw: 0.92, hl: 2.05, ly: 0.88, lz: 2.08, ls: 0.66, v: [21, 27] },
  bike:   { L: 2.0,  W: 0.75, hw: 0.4,  hl: 1.0,  ly: 0.8,  lz: 0.74, ls: 0.1,  v: [24, 34] },
};
const CAR_STYLE = {
  hatch:  { bodyH: 0.62, cabH: 0.56, hood: 0.12, cabZ0: -0.14, cabZ1: 0.46, rakeF: 0.5, rakeR: 0.3 },
  sedan:  { bodyH: 0.58, cabH: 0.5, hood: 0.16, cabZ0: -0.13, cabZ1: 0.3, rakeF: 0.55, rakeR: 0.5 },
  suv:    { bodyH: 0.74, cabH: 0.62, hood: 0.08, cabZ0: -0.2, cabZ1: 0.46, rakeF: 0.35, rakeR: 0.18 },
  lux:    { bodyH: 0.56, cabH: 0.48, hood: 0.2, cabZ0: -0.08, cabZ1: 0.28, rakeF: 0.55, rakeR: 0.5 },
  sports: { bodyH: 0.42, cabH: 0.38, hood: 0.28, cabZ0: -0.02, cabZ1: 0.26, rakeF: 0.45, rakeR: 0.45 },
  luxsuv: { bodyH: 0.78, cabH: 0.62, hood: 0.1, cabZ0: -0.18, cabZ1: 0.44, rakeF: 0.4, rakeR: 0.2 },
  creta:  { bodyH: 0.72, cabH: 0.6, hood: 0.1, cabZ0: -0.19, cabZ1: 0.46, rakeF: 0.38, rakeR: 0.2 },
};

function carModel(L, W, st, body, opt) {
  opt = opt || {};
  const hw = W / 2, y0 = 0.3, y1 = y0 + st.bodyH, y2 = y1 + st.cabH, glass = 0x141c28, dark = 0x15161b, it = [];
  const cz0 = st.cabZ0 * L, cz1 = st.cabZ1 * L;
  it.push(B(W * 0.9, 0.2, L * 0.96, 0, 0.26, 0, dark));
  it.push(hexa(y0, y1, -L / 2, L / 2, hw, -L / 2 + L * st.hood, L / 2 - L * 0.03, hw * 0.94, body));
  it.push(hexa(y1, y2, cz0, cz1, hw * 0.9, cz0 + st.rakeF, cz1 - st.rakeR, hw * 0.8, glass));
  it.push(hexa(y2, y2 + 0.05, cz0 + st.rakeF, cz1 - st.rakeR, hw * 0.8, cz0 + st.rakeF + 0.03, cz1 - st.rakeR - 0.03, hw * 0.76, body));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) it.push(WHEEL(sx * (hw - 0.1), 0.34, sz * (L / 2 - 0.72), 1, 1));
  it.push(B(W * 0.96, 0.2, 0.2, 0, 0.4, L / 2 - 0.05, dark), B(W * 0.96, 0.2, 0.2, 0, 0.4, -L / 2 + 0.05, dark));
  it.push(B(0.52, 0.13, 0.03, 0, y0 + 0.28, L / 2 + 0.01, opt.plate || 0xe8e8ee));
  const hy = y0 + st.bodyH * 0.62, hz = -L / 2 + 0.62 * L * st.hood - 0.01;
  for (const sx of [-1, 1]) it.push(B(0.4, 0.13, 0.06, sx * (hw - 0.3), hy, hz, 0xfff3cf));
  if (opt.spoiler) it.push(B(W * 0.88, 0.05, 0.4, 0, y1 + 0.3, L / 2 - 0.3, dark), B(0.06, 0.3, 0.1, -0.5, y1 + 0.15, L / 2 - 0.3, dark), B(0.06, 0.3, 0.1, 0.5, y1 + 0.15, L / 2 - 0.3, dark));
  return mergeGeos(it);
}
function indianCarModel(kind, body) {
  const dimensions = {
    ambassador: { L: 4.45, W: 1.7, H: 0.72, roof: 1.35 },
    innova: { L: 4.74, W: 1.83, H: 0.78, roof: 1.52 },
    sumo: { L: 4.1, W: 1.8, H: 0.82, roof: 1.48 },
  }[kind];
  const { L, W, H, roof } = dimensions, hw = W / 2, glass = 0x172633, dark = 0x17191c, it = [];
  it.push(B(W * 0.9, 0.22, L * 0.92, 0, 0.28, 0, dark));
  if (kind === 'ambassador') {
    it.push({ g: new THREE.SphereGeometry(1, 12, 8), sx: hw, sy: 0.48, sz: L * 0.48, x: 0, y: 0.57, z: 0, c: body });
    it.push(hexa(0.82, 1.28, -1.35, 1.2, hw * 0.86, -1.12, 1.0, hw * 0.8, glass));
    it.push(B(W * 0.74, 0.1, 1.85, 0, roof, -0.05, body));
    it.push(B(W * 0.94, 0.24, 1.0, 0, 0.68, -1.55, body), B(W * 0.94, 0.2, 0.75, 0, 0.65, 1.72, body));
  } else if (kind === 'innova') {
    it.push(B(W * 0.96, H, L * 0.94, 0, 0.66, 0, body));
    it.push(hexa(1.05, roof, -1.95, 1.95, hw * 0.92, -1.62, 1.72, hw * 0.82, glass));
    it.push(B(W * 0.82, 0.12, 2.85, 0, roof + 0.02, -0.05, body));
    it.push(B(W * 0.97, 0.18, 0.16, 0, 0.48, -L * 0.48, dark), B(W * 0.97, 0.18, 0.16, 0, 0.48, L * 0.48, dark));
  } else {
    it.push(B(W * 0.95, H, L * 0.94, 0, 0.68, 0, body));
    it.push(B(W * 0.86, 0.48, L * 0.52, 0, 1.28, 0.13, glass));
    it.push(B(W * 0.78, 0.12, L * 0.55, 0, roof, 0.1, body));
    it.push(B(W * 0.96, 0.2, 0.16, 0, 0.48, -L * 0.48, dark), B(W * 0.96, 0.2, 0.16, 0, 0.48, L * 0.48, dark));
  }
  if (kind !== 'ambassador') {
    for (const sx of [-1, 1]) {
      it.push(B(0.025, 0.42, kind === 'innova' ? 0.82 : 0.68, sx * (hw + 0.012), 1.2, -1.1, glass));
      it.push(B(0.025, 0.42, kind === 'innova' ? 0.78 : 0.62, sx * (hw + 0.012), 1.2, 0.22, glass));
      it.push(B(0.025, 0.42, 0.48, sx * (hw + 0.012), 1.2, 1.38, glass));
      it.push(B(0.08, 0.16, 0.1, sx * (hw + 0.03), 0.96, 0.05, body));
    }
  }
  for (const sx of [-1, 1]) for (const z of [-L * 0.32, L * 0.32]) it.push(WHEEL(sx * (hw - 0.08), 0.35, z, 0.82, 0.95));
  it.push(B(W * 0.56, 0.28, 0.06, 0, 0.62, -L * 0.49, dark));
  it.push(B(0.18, 0.12, 0.08, -W * 0.34, 0.92, -L * 0.49, 0xfff3cf), B(0.18, 0.12, 0.08, W * 0.34, 0.92, -L * 0.49, 0xfff3cf));
  it.push(B(W * 0.82, 0.16, 0.12, 0, 0.5, L * 0.49, dark));
  return mergeGeos(it);
}
function pickupModel(body) {
  const L = 5.4, W = 2.0, hw = W / 2, glass = 0x141c28, dark = 0x15161b, it = [];
  it.push(B(W * 0.9, 0.25, L * 0.96, 0, 0.45, 0, dark));
  it.push(hexa(0.4, 1.1, -2.7, -0.9, hw, -2.3, -0.9, hw * 0.95, body));                    // hood
  it.push(hexa(0.4, 1.1, -0.9, 1.0, hw, -0.9, 1.0, hw * 0.96, body));                      // cab lower
  it.push(hexa(1.1, 1.75, -0.9, 0.95, hw * 0.92, -0.45, 0.7, hw * 0.8, glass));            // cab glass
  it.push(hexa(1.75, 1.81, -0.45, 0.7, hw * 0.8, -0.42, 0.67, hw * 0.76, body));           // roof
  it.push(B(W * 0.96, 0.1, 1.7, 0, 0.55, 1.85, dark), B(0.1, 0.5, 1.7, -hw * 0.95, 0.85, 1.85, body), B(0.1, 0.5, 1.7, hw * 0.95, 0.85, 1.85, body));
  it.push(B(W * 0.96, 0.5, 0.1, 0, 0.85, 2.7, body), B(W * 0.96, 0.5, 0.1, 0, 0.85, 1.0, body));
  for (const sx of [-1, 1]) for (const z of [-1.65, 1.8]) it.push(WHEEL(sx * (hw - 0.1), 0.4, z, 1.2, 1));
  it.push(B(W * 0.96, 0.25, 0.2, 0, 0.45, -2.65, dark), B(W * 0.96, 0.22, 0.2, 0, 0.45, 2.7, dark), B(0.55, 0.13, 0.03, 0, 0.62, 2.77, 0xe8e8ee));
  for (const sx of [-1, 1]) it.push(B(0.4, 0.14, 0.06, sx * (hw - 0.32), 0.88, -2.64, 0xfff3cf));
  return mergeGeos(it);
}
function semiModel(cab, trailer, stripe) {
  const L = 15, W = 2.5, hw = W / 2, z0 = -L / 2, glass = 0x141c28, dark = 0x16171c, it = [];
  it.push(B(W * 0.8, 0.45, L * 0.97, 0, 0.8, 0, dark));
  it.push(hexa(0.9, 2.1, z0, z0 + 2.2, hw * 0.92, z0 + 0.35, z0 + 2.2, hw * 0.88, cab));            // long nose
  it.push(hexa(0.9, 3.2, z0 + 2.2, z0 + 4.2, hw, z0 + 2.45, z0 + 4.2, hw * 0.96, cab));            // cab
  it.push(B(W * 0.88, 0.95, 0.1, 0, 2.55, z0 + 2.5, glass), B(W * 0.98, 2.3, 1.3, 0, 2.05, z0 + 4.85, cab));
  it.push(B(0.18, 1.7, 0.18, -0.95, 3.3, z0 + 4.1, 0xcfd3d8), B(0.18, 1.7, 0.18, 0.95, 3.3, z0 + 4.1, 0xcfd3d8), B(W * 0.9, 0.3, 0.25, 0, 0.6, z0 - 0.05, 0xcfd3d8));
  const t0 = z0 + 5.6, t1 = L / 2;
  it.push(B(W, 3.0, t1 - t0, 0, 2.7, (t0 + t1) / 2, trailer), B(W + 0.02, 0.5, t1 - t0, 0, 1.35, (t0 + t1) / 2, stripe));
  for (let i = 0; i < 8; i++) it.push(B(W / 8, 0.16, 0.04, -hw + W / 16 + i * W / 8, 0.95, L / 2 + 0.01, i % 2 ? 0xf2f2f2 : 0xc8281f));
  for (const sx of [-1, 1]) for (const z of [z0 + 1.3, z0 + 4.9, z0 + 6.0, 5.3, 6.5]) it.push(WHEEL(sx * (hw - 0.15), 0.5, z, 1.5, 1.2));
  return mergeGeos(it);
}
function busModel(body, stripe) {
  const L = 10.6, W = 2.55, hw = W / 2, it = [];
  it.push(B(W * 0.9, 0.4, L * 0.96, 0, 0.5, 0, 0x16171c), B(W, 1.5, L, 0, 1.45, 0, body), B(W + 0.02, 0.8, L - 0.5, 0, 2.62, 0, 0x141c28));
  it.push(B(W, 0.4, L, 0, 3.22, 0, body), B(W - 0.2, 0.08, L - 0.3, 0, 3.46, 0, body), B(W + 0.03, 0.22, L, 0, 1.2, 0, stripe));
  it.push(B(W * 0.92, 1.0, 0.08, 0, 2.7, -L / 2, 0x141c28), B(W * 0.8, 0.7, 0.05, 0, 2.6, L / 2 + 0.01, 0x10141c));
  for (const sx of [-1, 1]) for (const z of [-L / 2 + 1.6, L / 2 - 2.6, L / 2 - 1.3]) it.push(WHEEL(sx * (hw - 0.12), 0.5, z, 1.5, 1.2));
  return mergeGeos(it);
}
function bikeModel(shirt, helmet) {
  const it = [];
  it.push(WHEEL(0, 0.33, -0.68, 1, 0.5), WHEEL(0, 0.33, 0.68, 1, 0.5));
  it.push(B(0.22, 0.42, 0.9, 0, 0.5, 0.05, 0x1b1b20), B(0.3, 0.2, 0.5, 0, 0.82, -0.2, 0x8a1a1f), B(0.28, 0.1, 0.55, 0, 0.78, 0.3, 0x111114));
  it.push(B(0.08, 0.7, 0.08, 0, 0.62, -0.62, 0x2a2a30), B(0.72, 0.06, 0.06, 0, 1.0, -0.55, 0x2a2a30), B(0.2, 0.2, 0.1, 0, 0.9, -0.72, 0xfff3cf));
  it.push(B(0.34, 0.5, 0.32, 0, 0.95, 0.2, 0x2b3a55), B(0.42, 0.58, 0.3, 0, 1.45, 0.15, shirt), B(0.5, 0.14, 0.45, 0, 1.35, -0.2, shirt));
  it.push({ g: ICO, x: 0, y: 1.88, z: 0.1, sx: 0.2, sy: 0.2, sz: 0.2, c: helmet });
  return mergeGeos(it);
}
/* Road-works barriers: concrete blocks, an orange and white barricade and a taper of traffic cones. */
const ORANGE = 0xff6a00;
const jerseyGeo = (() => {
  const it = [];
  [-2.05, 0, 2.05].forEach((k, i) => {
    it.push(B(0.62, 0.25, 2.0, 0, 0.125, k, 0xa9a69e), B(0.46, 0.3, 2.0, 0, 0.4, k, 0xa9a69e), B(0.26, 0.4, 2.0, 0, 0.75, k, i % 2 ? 0xf0f0f0 : ORANGE));
  });
  it.push(B(0.16, 0.12, 0.16, 0, 1.0, -2.05, 0xffa51f));
  return mergeGeos(it);
})();
const barricadeGeo = (() => {
  const it = [];
  for (const sx of [-1.3, 1.3]) { it.push(B(0.08, 1.0, 0.08, sx, 0.5, 0.12, 0x2a2a2e), B(0.08, 1.0, 0.08, sx, 0.5, -0.12, 0x2a2a2e), B(0.1, 0.06, 0.6, sx, 0.03, 0, 0x2a2a2e)); }
  for (const row of [0.82, 0.5]) for (let i = 0; i < 6; i++) it.push(B(0.5, 0.26, 0.06, -1.25 + 0.5 * i, row, 0, (i + (row > 0.6 ? 0 : 1)) % 2 ? 0xf2f2f2 : ORANGE));
  it.push(B(0.16, 0.12, 0.16, 0, 1.08, 0, 0xffa51f));
  return mergeGeos(it);
})();
const conesGeo = (() => {
  const cone = new THREE.ConeGeometry(0.2, 0.7, 8); cone.translate(0, 0.35, 0);
  const band = new THREE.CylinderGeometry(0.105, 0.125, 0.12, 8); band.translate(0, 0.36, 0);
  const it = [];
  for (let i = 0; i < 5; i++) {
    const x = -1.2 + 0.6 * i, z = -0.8 + 0.4 * i;
    it.push({ g: cone, x, y: 0, z, c: ORANGE }, { g: band, x, y: 0, z, c: 0xf2f2f2 }, B(0.42, 0.05, 0.42, x, 0.025, z, 0x1a1a1d));
  }
  return mergeGeos(it);
})();
const BARRIER = {
  jersey:    { geo: jerseyGeo,    hw: 0.35, hl: 3.1 },
  barricade: { geo: barricadeGeo, hw: 1.5,  hl: 0.4 },
  cones:     { geo: conesGeo,     hw: 1.45, hl: 1.2 },
};

const WHITE = 0xeeeeee, SILVER = 0xc4c8ce;
const GEO = {
  hatch:  [WHITE, WHITE, SILVER, 0x9a1f2b, 0x2b4a86, 0x4a4f57, 0xe3a23b].map((c) => carModel(VSPEC.hatch.L, VSPEC.hatch.W, CAR_STYLE.hatch, c, { plate: 0xf2c230 })),
  sedan:  [WHITE, WHITE, SILVER, 0x14161a, 0x2b3a5a, 0x7a1f2b].map((c) => carModel(VSPEC.sedan.L, VSPEC.sedan.W, CAR_STYLE.sedan, c, { plate: 0xf2c230 })),
  suv:    [WHITE, 0x14161a, SILVER, 0x3c4a3a, 0x8f2230].map((c) => carModel(VSPEC.suv.L, VSPEC.suv.W, CAR_STYLE.suv, c, { plate: 0xf2c230 })),
  pickup: [0xb3262d, 0x2b4a86, WHITE, 0x4a4f57, SILVER].map((c) => pickupModel(c)),
  lux:    [0x101216, 0x1c2a44, 0xd5d8dd, 0x4a2f27, 0x1d3b2f].map((c) => carModel(VSPEC.lux.L, VSPEC.lux.W, CAR_STYLE.lux, c)),
  sports: [0xc8102e, 0xf2b705, 0x1b6bd6, 0xe8e8e8, 0x6a2c91].map((c) => carModel(VSPEC.sports.L, VSPEC.sports.W, CAR_STYLE.sports, c, { spoiler: true })),
  luxsuv: [0x0e1014, WHITE, 0x2b3139, 0x3a2a22].map((c) => carModel(VSPEC.luxsuv.L, VSPEC.luxsuv.W, CAR_STYLE.luxsuv, c)),
  semi:   [[0xc8281f, 0xeeeeee, 0xb0b4ba], [0x1f5fb0, 0xeeeeee, 0xc8c8c8], [0x222831, 0xd8d8d8, 0xc8281f]].map((a) => semiModel(a[0], a[1], a[2])),
  bus:    [[0xf2b705, 0x111111], [0xe8e8e8, 0x2554a8]].map((a) => busModel(a[0], a[1])),
  bike:   [[0x2b6cb0, 0x111111], [0xb3262d, 0xe8e8e8], [0x3a3a40, 0x2b6cb0]].map((a) => bikeModel(a[0], a[1])),
  ambassador: [0xeeeeee, 0x263b2d, 0x8f2528, 0xd6b36a].map((c) => indianCarModel('ambassador', c)),
  innova: [0xeeeeee, 0x20252b, 0x6b6e70, 0x8f2528].map((c) => indianCarModel('innova', c)),
  creta: [0xeeeeee, 0x171a20, 0x1f4c78, 0x8f2528].map((c) => carModel(VSPEC.creta.L, VSPEC.creta.W, CAR_STYLE.creta, c, { plate: 0xf2f2f2 })),
  sumo: [0xeeeeee, 0x24613b, 0xd3b84f, 0x3f5366].map((c) => indianCarModel('sumo', c)),
};
const vehMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const lampBoxes = mergeGeos([B(0.34, 0.13, 0.06, -1, 0, 0, 0xffffff), B(0.34, 0.13, 0.06, 1, 0, 0, 0xffffff)]);
const indGeo = new THREE.BoxGeometry(0.22, 0.13, 0.06);
const indMat = new THREE.MeshBasicMaterial({ color: 0xffa51f });
const LAMP_DIM = 0x5a0c14, LAMP_ON = 0xff2433;

/* ------------------------------ PLAYER CARS ----------------------------- */
const CARS = [
  { id: 'hatch', name: 'City Hatch', blurb: 'Compact and nimble. Easy to slip through gaps.', style: 'hatch', L: 3.9, W: 1.72, hw: 0.86, hl: 1.95, ly: 0.78, lz: 1.98, ls: 0.58,
    top: 0.9, grip: 1.15, accel: 1.0, lives: 2, st: [0.45, 0.85, 0.5], colors: [0xeeeeee, 0xb3262d, 0x2b4a86, 0xe3a23b], opt: { plate: 0xf2c230 } },
  { id: 'suv', name: 'Terrain SUV', blurb: 'Heavy and tough, but one impact ends the run.', style: 'suv', L: 4.6, W: 1.88, hw: 0.96, hl: 2.3, ly: 0.98, lz: 2.33, ls: 0.68,
    top: 0.95, grip: 0.85, accel: 0.9, lives: 1, st: [0.5, 0.5, 1], colors: [0x3c4a3a, 0xeeeeee, 0x14161a, 0x8f2230], opt: { plate: 0xf2c230 } },
  { id: 'lux', name: 'Executive', blurb: 'Smooth, quick and composed.', style: 'lux', L: 4.9, W: 1.92, hw: 0.95, hl: 2.45, ly: 0.84, lz: 2.48, ls: 0.7,
    top: 1.05, grip: 1.0, accel: 1.1, lives: 1, st: [0.7, 0.65, 0.6], colors: [0x101216, 0x1c2a44, 0xd5d8dd, 0x4a2f27], opt: {} },
  { id: 'sports', name: 'Apex GT', blurb: 'The fastest car here, but one impact ends the run.', style: 'sports', L: 4.4, W: 1.98, hw: 0.97, hl: 2.2, ly: 0.68, lz: 2.23, ls: 0.72,
    top: 1.2, grip: 1.2, accel: 1.3, lives: 1, st: [1, 0.9, 0.3], colors: [0xc8102e, 0xf2b705, 0x1b6bd6, 0xe8e8e8], opt: { spoiler: true } },
  { id: 'bike', name: 'Road Motorcycle', blurb: 'Quick and nimble, but has little room for error.', modelType: 'bike', L: 2.0, W: 0.9, hw: 0.48, hl: 1.05, ly: 0.8, lz: 0.74, ls: 0.1,
    headY: 1, headZ: -0.72, top: 1.2, grip: 1.35, accel: 1.2, lives: 1, st: [0.92, 1, 0.25], colors: [0x2b6cb0, 0xb3262d, 0x3a3a40], opt: {} },
  { id: 'truck', name: 'Highway Truck', blurb: 'A powerful, heavy truck with slower handling.', modelType: 'semi', L: 15, W: 2.5, hw: 1.28, hl: 7.5, ly: 1.25, lz: 7.53, ls: 1,
    headY: 1.4, headZ: -7.2, top: 0.72, grip: 0.58, accel: 0.65, lives: 1, st: [0.55, 0.38, 1], colors: [0xc8281f, 0x1f5fb0, 0x222831], opt: {} },
  { id: 'bus', name: 'City Bus', blurb: 'A sturdy bus that trades speed for stability.', modelType: 'bus', L: 10.6, W: 2.55, hw: 1.3, hl: 5.3, ly: 1.3, lz: 5.33, ls: 1,
    headY: 1.1, headZ: -5.1, top: 0.78, grip: 0.68, accel: 0.72, lives: 1, st: [0.62, 0.48, 0.9], colors: [0xf2b705, 0xe8e8e8], opt: {} },
  { id: 'ambassador', name: 'Hindustan Ambassador', blurb: 'A classic Indian road icon with steady handling.', modelType: 'ambassador', L: 4.45, W: 1.7, hw: 0.86, hl: 2.23, ly: 0.72, lz: 2.18, ls: 0.58,
    headY: 0.92, headZ: -2.18, top: 0.9, grip: 0.86, accel: 0.88, lives: 1, st: [0.48, 0.58, 0.78], colors: [0xeeeeee, 0x263b2d, 0x8f2528, 0xd6b36a], opt: {} },
  { id: 'innova', name: 'Toyota Innova', blurb: 'A roomy family MPV built for long highway trips.', modelType: 'innova', L: 4.74, W: 1.83, hw: 0.94, hl: 2.37, ly: 0.82, lz: 2.3, ls: 0.64,
    headY: 1.05, headZ: -2.3, top: 0.96, grip: 0.82, accel: 0.94, lives: 1, st: [0.62, 0.62, 0.82], colors: [0xeeeeee, 0x20252b, 0x6b6e70, 0x8f2528], opt: {} },
  { id: 'creta', name: 'Hyundai Creta', blurb: 'A compact SUV that balances speed and control.', modelType: 'creta', L: 4.33, W: 1.79, hw: 0.92, hl: 2.17, ly: 0.9, lz: 2.22, ls: 0.66,
    headY: 1.05, headZ: -1.92, top: 1.0, grip: 0.92, accel: 1.02, lives: 1, st: [0.7, 0.72, 0.76], colors: [0xeeeeee, 0x171a20, 0x1f4c78, 0x8f2528], opt: { plate: 0xf2f2f2 } },
  { id: 'sumo', name: 'Tata Sumo', blurb: 'A rugged, boxy utility vehicle for the open road.', modelType: 'sumo', L: 4.1, W: 1.8, hw: 0.92, hl: 2.05, ly: 0.88, lz: 2.08, ls: 0.66,
    headY: 1.08, headZ: -2.0, top: 0.82, grip: 0.68, accel: 0.78, lives: 1, st: [0.5, 0.48, 0.95], colors: [0xeeeeee, 0x24613b, 0xd3b84f, 0x3f5366], opt: {} },
];
let selCar = 0, selColor = 0;
try { selCar = clamp((+localStorage.getItem('openroad_car')) | 0, 0, CARS.length - 1); selColor = clamp((+localStorage.getItem('openroad_color')) | 0, 0, 3); } catch (e) { /* storage blocked */ }
const S = { top: 1, grip: 1, accel: 1 };
const playerGeoCache = {};
function playerGeo(i, c) {
  const k = i + ':' + c;
  if (!playerGeoCache[k]) {
    const d = CARS[i];
    playerGeoCache[k] = d.modelType ? GEO[d.modelType][c % GEO[d.modelType].length] : carModel(d.L, d.W, CAR_STYLE[d.style], d.colors[c], d.opt);
  }
  return playerGeoCache[k];
}

const player = new THREE.Group(); scene.add(player);
const playerMesh = new THREE.Mesh(playerGeo(selCar, selColor), vehMat);
const playerBrake = new THREE.Mesh(lampBoxes, new THREE.MeshBasicMaterial({ color: LAMP_DIM }));
const headlightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c1, transparent: true, opacity: 0 });
const headlightGeo = new THREE.BoxGeometry(0.38, 0.14, 0.06);
const headlightMeshes = [-1, 1].map(() => new THREE.Mesh(headlightGeo, headlightMat));
const headlight = new THREE.SpotLight(0xfff1c6, 0, 70, Math.PI / 5, 0.45, 1);
const headlightTarget = new THREE.Object3D();
player.add(playerMesh, playerBrake, ...headlightMeshes, headlight, headlightTarget);
headlight.target = headlightTarget;
function applyPlayerCar() {
  const c = CARS[selCar];
  if (selColor >= c.colors.length) selColor = 0;
  playerMesh.geometry = playerGeo(selCar, selColor);
  playerBrake.position.set(0, c.ly, c.lz); playerBrake.scale.set(c.ls, 1, 1);
  const style = c.style ? CAR_STYLE[c.style] : null;
  const headlightY = c.headY != null ? c.headY : 0.3 + style.bodyH * 0.62;
  const headlightZ = c.headZ != null ? c.headZ : -c.L / 2 + 0.62 * c.L * style.hood - 0.01;
  headlightMeshes.forEach((lamp, i) => lamp.position.set((i ? 1 : -1) * Math.max(0.12, c.W / 2 - 0.3), headlightY, headlightZ));
  headlight.position.set(0, headlightY, headlightZ);
  headlightTarget.position.set(0, 0.1, -45);
  carHW = c.hw; carHL = c.hl;
  S.top = c.top; S.grip = c.grip; S.accel = c.accel;
  try { localStorage.setItem('openroad_car', String(selCar)); localStorage.setItem('openroad_color', String(selColor)); } catch (e) { /* ignore */ }
}
applyPlayerCar();

/* ------------------------------ TRAFFIC + OBSTACLES --------------------- */
const obstacles = [];
// Mix of everyday cars (including compact hatchbacks) and luxury cars; semis and buses stay in the right lanes.
const WEIGHTS = ['hatch', 'hatch', 'sedan', 'sedan', 'suv', 'suv', 'pickup', 'lux', 'sports', 'luxsuv', 'semi', 'bus', 'bike', 'ambassador', 'ambassador', 'innova', 'innova', 'creta', 'sumo', 'sumo'];
const LANES = { hatch: [0, 3], sedan: [0, 3], suv: [0, 3], pickup: [0, 3], lux: [0, 3], sports: [0, 3], luxsuv: [0, 3], semi: [0, 1], bus: [0, 1], bike: [0, 3], ambassador: [0, 3], innova: [0, 3], creta: [0, 3], sumo: [0, 3] };
const SPORTY = { lux: 1, sports: 1, luxsuv: 1 };

for (let i = 0; i < 20; i++) {
  const mesh = new THREE.Mesh(GEO.hatch[0], vehMat); mesh.visible = false;
  const brakeMat = new THREE.MeshBasicMaterial({ color: LAMP_DIM });
  const brake = new THREE.Mesh(lampBoxes, brakeMat), ind = new THREE.Mesh(indGeo, indMat);
  ind.visible = false;
  mesh.add(brake, ind); scene.add(mesh);
  obstacles.push({ mesh, kind: 'veh', brake, brakeMat, ind, indX: 0.8, active: false, type: 'hatch', x: 0, y: 0, z: 0, v: 0, vd: 20, vx: 0, hw: 1, hl: 2, lane: 1, lc: null, signal: 0, think: 0, brakeT: 0, yieldUntil: 0, pers: 'normal', braking: false, passed: false, spec: VSPEC.hatch });
}
for (const sub of ['jersey', 'jersey', 'jersey', 'barricade', 'barricade', 'barricade', 'cones', 'cones', 'cones']) {
  const mesh = new THREE.Mesh(BARRIER[sub].geo, vehMat); mesh.visible = false; scene.add(mesh);
  obstacles.push({ mesh, kind: 'bar', sub, active: false, x: 0, y: 0, z: 0, v: 0, vx: 0, hw: BARRIER[sub].hw, hl: BARRIER[sub].hl, lane: 0, lc: null, passed: false });
}

/* ------------------------------ STATE ----------------------------------- */
let state = 'menu';                 // menu | garage | countdown | playing | over
let handMode = false, paused = false;
let dipperFlash = 0, dipperRequest = 0;
let speed = 0, distance = 0, bonus = 0, score = 0, lives = 3, maxLives = 3;
let invuln = 0, shake = 0, vehTimer = 0, barTimer = 0, countT = 0, goT = 0, overT = 0, fistHold = 0, fistArmed = false, tNow = 0, garageAngle = 0;
let best = 0;
try { best = +localStorage.getItem('openroad_best') || 0; } catch (e) { /* storage blocked */ }
const car = { x: 0, lv: 0, braking: false };

/* ------------------------------ KEYBOARD -------------------------------- */
const keys = Object.create(null);
let lastKeyT = -9;
const GAME_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'];
function triggerDipper() {
  if (state !== 'playing' && state !== 'countdown') return;
  dipperFlash = 0.55;
  dipperRequest = 3;
  toast('Dipper flashed - traffic move left');
}
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (GAME_KEYS.includes(e.code)) { lastKeyT = now(); e.preventDefault(); }
  if (e.repeat) return;
  if (e.code === 'KeyP') togglePause();
  else if (e.code === 'KeyQ') cycleQuality();
  else if (e.code === 'KeyH') toggleHand();
  else if (e.code === 'KeyF') toggleFullscreen();
  else if (e.code === 'KeyL') triggerDipper();
  else if (state === 'garage') {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') changeCar(-1);
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') changeCar(1);
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') changeColor(1);
    else if (e.code === 'ArrowDown' || e.code === 'KeyS') changeColor(-1);
    else if (e.code === 'Enter' || e.code === 'Space') startRun();
    else if (e.code === 'Escape') setState('menu');
  } else if (e.code === 'Space' || e.code === 'Enter') {
    if (state === 'over' && overT > 0.8) startRun();
    else if (state === 'menu' && e.code === 'Enter') startKeyboard();
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function togglePause() { if (state === 'menu' || state === 'garage') return; paused = !paused; $('pauseTag').hidden = !paused; }
function toggleFullscreen() {
  try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch (e) { /* ignore */ }
}
function toggleHand() {
  if (!trackerReady()) { toast('Hand tracking is not started'); return; }
  handMode = !handMode;
  $('cam').classList.toggle('off', !handMode || state === 'menu');
  toast(handMode ? 'Hand tracking on' : 'Hand tracking off');
}

/* ------------------------------ VEHICLE SELECTION ----------------------- */
const statRow = (label, v) => '<span class="st">' + label + '<span class="bar"><b style="width:' + Math.round(v * 100) + '%"></b></span></span>';
function renderGarage() {
  const c = CARS[selCar];
  $('cards').innerHTML = CARS.map((k, i) => '<button class="car-card' + (i === selCar ? ' sel' : '') + '" data-i="' + i + '"><span class="cn">' + k.name + '</span>' +
    statRow('Speed', k.st[0]) + statRow('Handling', k.st[1]) + statRow('Strength', k.st[2]) + '</button>').join('');
  $('gName').textContent = c.name; $('gBlurb').textContent = c.blurb;
  $('swatches').innerHTML = c.colors.map((hex, i) => '<button class="sw' + (i === selColor ? ' sel' : '') + '" data-c="' + i + '" style="background:#' + ('000000' + hex.toString(16)).slice(-6) + '" aria-label="Colour ' + (i + 1) + '"></button>').join('');
}
function changeCar(d) { selCar = (selCar + d + CARS.length) % CARS.length; selColor = 0; applyPlayerCar(); renderGarage(); }
function changeColor(d) { const n = CARS[selCar].colors.length; selColor = (selColor + d + n) % n; applyPlayerCar(); renderGarage(); }
$('cards').onclick = (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
  if (b) { selCar = +b.dataset.i; selColor = 0; applyPlayerCar(); renderGarage(); }
};
$('swatches').onclick = (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-c]') : null;
  if (b) { selColor = +b.dataset.c; applyPlayerCar(); renderGarage(); }
};
function goGarage() { renderGarage(); setState('garage'); }

/* ------------------------------ HAND TRACKING --------------------------- */
const TV = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const video = $('video'), pv = $('pv'), pg = pv.getContext('2d');
const H = { count: 0, lastSeen: -9, x: 0.5, ratio: 2, fist: false, fistFrames: 0, wheel: 0, wheelSeen: -9, mode: 'pos' };
let landmarker = null, worker = null, workerBusy = false, workerSince = 0, trackStarted = false, lastTrack = 0, lastVideoTime = -1, trackErrors = 0, trackMs = 15;
const trackerReady = () => !!(worker || landmarker);
const handFresh = () => handMode && now() - H.lastSeen < CFG.hand.lostAfter;

/* Preferred: detection in a Web Worker, so it can never stall the game. Falls back to the main thread if the worker cannot start. */
const WORKER_SRC = [
  'let lm = null;',
  'self.onmessage = async (e) => {',
  '  const m = e.data;',
  '  if (m.type === "init") {',
  '    try {',
  '      self.module = { exports: {} }; self.exports = self.module.exports;',
  '      importScripts(m.base + "/vision_bundle.cjs");',
  '      const V = (self.module.exports && self.module.exports.HandLandmarker) ? self.module.exports : self.exports;',
  '      const fileset = await V.FilesetResolver.forVisionTasks(m.base + "/wasm");',
  '      const make = (delegate) => V.HandLandmarker.createFromOptions(fileset, { baseOptions: { modelAssetPath: m.model, delegate }, runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });',
  '      try { lm = await make(m.delegate); } catch (err) { lm = await make("CPU"); }',
  '      self.postMessage({ type: "ready" });',
  '    } catch (err) { self.postMessage({ type: "fail", message: String((err && err.message) || err) }); }',
  '  } else if (m.type === "frame") {',
  '    if (!lm) { m.bitmap.close(); self.postMessage({ type: "result", landmarks: [], ms: 0 }); return; }',
  '    const t0 = performance.now();',
  '    try {',
  '      const r = lm.detectForVideo(m.bitmap, m.ts);',
  '      self.postMessage({ type: "result", landmarks: r.landmarks || [], ms: performance.now() - t0 });',
  '    } catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }',
  '    m.bitmap.close();',
  '  }',
  '};',
].join('\n');

function startWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('worker start timed out')); }, 40000);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { clearTimeout(timer); worker = w; w.onmessage = onWorkerMessage; resolve(); }
      else if (m.type === 'fail') { clearTimeout(timer); w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'worker error')); };
    w.postMessage({ type: 'init', base: TV, model: HAND_MODEL, delegate: CFG.hand.delegate });
  });
}
function onWorkerMessage(e) {
  const m = e.data;
  workerBusy = false;
  if (m.type === 'result') { trackMs = lerp(trackMs, m.ms, 0.3); onHandResults(m.landmarks || []); }
  else if (m.type === 'error') { console.warn('hand tracking worker error', m.message); if (++trackErrors > 20) failTracking(m.message); }
}
function failTracking(msg) { handMode = false; toast('Hand tracking stopped'); showError('Hand tracking stopped after repeated errors: ' + msg); }

async function initMainThreadTracking() {
  const vision = await import(TV + '/vision_bundle.mjs');
  const fileset = await vision.FilesetResolver.forVisionTasks(TV + '/wasm');
  const make = (delegate) => vision.HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.55, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await make(CFG.hand.delegate); }
  catch (e) { console.warn('GPU hand tracking unavailable, using CPU', e); landmarker = await make('CPU'); }
}

async function initHandTracking() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera access is unavailable. Open the game from http://localhost:8000 instead of opening the file directly.');
  $('menuStatus').textContent = 'Waiting for camera permission…';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
  $('menuStatus').textContent = 'Loading hand tracking. The first load takes a few seconds…';
  try { await startWorker(); }
  catch (e) { console.warn('Background hand tracking unavailable, using the main thread:', e); await initMainThreadTracking(); }
  handMode = true; trackErrors = 0;
  if (!trackStarted) { trackStarted = true; requestAnimationFrame(trackLoop); }
}

function trackLoop() {
  requestAnimationFrame(trackLoop);
  if (!trackerReady() || !handMode || paused || document.hidden || state === 'menu' || video.readyState < 2) return;
  const t = performance.now();
  if (worker) {
    if (workerBusy) { if (t - workerSince > 3000) workerBusy = false; return; }          // watchdog: never wait forever on a lost reply
    if (t - lastTrack < 1000 / CFG.hand.maxHz || video.currentTime === lastVideoTime) return;
    lastTrack = t; lastVideoTime = video.currentTime; workerBusy = true; workerSince = t;
    const send = (bmp) => worker.postMessage({ type: 'frame', bitmap: bmp, ts: t }, [bmp]);
    createImageBitmap(video, { resizeWidth: 256, resizeHeight: 192 }).then(send)
      .catch(() => createImageBitmap(video).then(send)).catch(() => { workerBusy = false; });
    return;
  }
  const gap = clamp(trackMs * 4.5, 1000 / CFG.hand.maxHz, 180);            // main-thread fallback: limit the share of time it can take
  if (t - lastTrack < gap || video.currentTime === lastVideoTime) return;
  lastTrack = t; lastVideoTime = video.currentTime;
  try {
    const r = landmarker.detectForVideo(video, t);
    trackMs = lerp(trackMs, performance.now() - t, 0.2);
    onHandResults(r.landmarks || []);
  } catch (e) {
    console.warn('hand tracking frame failed', e);
    if (++trackErrors > 20) failTracking(e && e.message);
  }
}

function handInfo(lm, AR) {
  const d = (a, b) => Math.hypot((a.x - b.x) * AR, a.y - b.y);
  const px = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
  const py = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
  const palm = d(lm[0], lm[9]) || 1e-3;
  const tips = (d(lm[0], lm[8]) + d(lm[0], lm[12]) + d(lm[0], lm[16]) + d(lm[0], lm[20])) / 4;
  return { x: 1 - px, y: py, ratio: tips / palm };           // x is mirrored so moving right = positive
}

function onHandResults(L) {
  const t = now();
  if (!L.length) { H.count = 0; drawPreview(L); return; }
  const AR = (video.videoWidth || 320) / (video.videoHeight || 240);
  const info = L.map((lm) => handInfo(lm, AR)).sort((a, b) => a.x - b.x);
  H.lastSeen = t; H.count = info.length;

  // Brake only when every visible hand is closed, so gripping an imaginary wheel does not brake.
  H.ratio = lerp(H.ratio, Math.max(...info.map((i) => i.ratio)), 0.5);
  H.fistFrames = H.ratio < CFG.hand.fistRatio ? H.fistFrames + 1 : 0;
  H.fist = H.fistFrames >= 2;

  if (info.length >= 2) {
    const a = info[0], b = info[info.length - 1];
    const ang = Math.atan2(b.y - a.y, (b.x - a.x) * AR);       // right hand lower = clockwise = steer right
    H.wheel = lerp(H.wheel, clamp(ang / (CFG.hand.wheelMaxDeg * Math.PI / 180), -1, 1), 0.5);
    H.x = (a.x + b.x) / 2; H.mode = 'wheel'; H.wheelSeen = t;
  } else if (t - H.wheelSeen < 0.35) {
    H.mode = 'wheel';                                           // one hand dropped out for a moment: hold the wheel angle
  } else {
    H.x = lerp(H.x, info[0].x, 0.6); H.mode = 'pos';
  }
  drawPreview(L);
}

const CHAINS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20], [5, 9, 13, 17]];
function drawPreview(L) {
  const w = pv.width, h = pv.height;
  pg.clearRect(0, 0, w, h);
  const z0 = (0.5 - CFG.hand.steerRange) * w, z1 = (0.5 + CFG.hand.steerRange) * w;
  pg.fillStyle = 'rgba(255,255,255,0.1)'; pg.fillRect(z0, 0, z1 - z0, h);
  pg.strokeStyle = 'rgba(255,255,255,0.5)'; pg.lineWidth = 1;
  pg.beginPath(); pg.moveTo(w / 2, 0); pg.lineTo(w / 2, h); pg.stroke();
  pg.strokeStyle = H.fist ? '#ff453a' : '#30d158'; pg.fillStyle = pg.strokeStyle; pg.lineWidth = 2;
  for (const lm of L) {
    for (const ch of CHAINS) {
      pg.beginPath();
      ch.forEach((k, i) => { const X = lm[k].x * w, Y = lm[k].y * h; if (i) pg.lineTo(X, Y); else pg.moveTo(X, Y); });
      pg.stroke();
    }
    for (const p of lm) pg.fillRect(p.x * w - 1.5, p.y * h - 1.5, 3, 3);
  }
}

/* ------------------------------ UI -------------------------------------- */
const el = {
  score: $('score'), best: $('best'), dist: $('dist'), gNum: $('gNum'), gFill: $('gFill'), fps: $('fps'), ctl: $('ctlMode'), dot: $('ctlDot'),
  steer: $('steerDot'), camInfo: $('camInfo'), big: $('big'), toast: $('toast'), flash: $('flash'), carName: $('carName'), lives: $('lives'), bars: [],
};
let bigTxt = '', toastTimer = 0, flashTimer = 0;
function setBig(t) { if (t !== bigTxt) { bigTxt = t; el.big.textContent = t; } }
function toast(t) {
  el.toast.textContent = t; el.toast.classList.remove('show'); void el.toast.offsetWidth; el.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1100);
}
function flash() {
  const f = el.flash; f.hidden = false; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { f.hidden = true; }, 480);
}

function setState(s) {
  state = s;
  $('menu').hidden = s !== 'menu';
  $('garage').hidden = s !== 'garage';
  $('hud').hidden = s === 'menu' || s === 'garage';
  $('over').hidden = true;
  $('cam').classList.toggle('off', !handMode || s === 'menu');
  setBig('');
}

const GAUGE_MAX = 240 / KPH;                    // 240 km/h in m/s
let fps = 60, lastCtl = '';
function hudTick() {
  if (state === 'menu' || state === 'garage') return;
  el.score.textContent = Math.floor(score).toLocaleString();
  el.best.textContent = Math.max(best, Math.floor(score)).toLocaleString();
  el.dist.textContent = (distance / 1000).toFixed(2);
  el.gNum.textContent = Math.round(speed * KPH);
  el.gFill.style.strokeDashoffset = (100 - clamp(speed / GAUGE_MAX, 0, 1) * 100).toFixed(1);
  el.bars.forEach((b, i) => b.classList.toggle('lost', i >= lives));
  el.steer.style.left = ((car.x / CFG.carLimit + 1) / 2 * 100).toFixed(1) + '%';
  el.fps.textContent = Math.round(fps) + ' fps, ' + Q.w + 'x' + Q.h + (handMode ? ', hand ' + Math.round(trackMs) + ' ms' + (worker ? ' (bg)' : '') : '');
  const kb = now() - lastKeyT < 1.5;
  let txt = 'Keyboard', cls = 'dot';
  if (handMode && !kb) {
    if (!handFresh()) { txt = 'Show your hand'; cls = 'dot warn'; }
    else if (H.fist) { txt = 'Braking'; cls = 'dot brake'; }
    else txt = H.mode === 'wheel' ? 'Two hands' : 'One hand';
  }
  if (txt !== lastCtl) { el.ctl.textContent = txt; el.dot.className = cls; lastCtl = txt; }
  if (handMode) el.camInfo.textContent = H.count + (H.count === 1 ? ' hand' : ' hands') + ', openness ' + H.ratio.toFixed(2);
}

/* ------------------------------ GAME FLOW ------------------------------- */
function resetRun() {
  const c = CARS[selCar];
  maxLives = c.lives; lives = maxLives;
  el.lives.innerHTML = '<i></i>'.repeat(maxLives); el.bars = Array.from(el.lives.children);
  el.carName.textContent = c.name;
  distance = 0; bonus = 0; score = 0; speed = 8; invuln = 0; shake = 0; countT = 0; fistHold = 0;
  vehTimer = 0.4; barTimer = 3;
  car.x = 0; car.lv = 0; garageAngle = 0;
  for (const o of obstacles) { o.active = false; o.mesh.visible = false; o.lc = null; }
  for (let i = 0, tries = 0; i < 11 && tries < 80; tries++) if (spawnVehicle(-rand(50, 200))) i++;     // traffic is already on the road
}
function startRun() { applyPlayerCar(); resetRun(); setState('countdown'); }
function startKeyboard() { handMode = false; goGarage(); }
function gameOver() {
  const isNew = Math.floor(score) > best && score > 0;
  best = Math.max(best, Math.floor(score));
  try { localStorage.setItem('openroad_best', String(best)); } catch (e) { /* ignore */ }
  overT = 0; fistHold = 0; fistArmed = false;
  setState('over');
  $('overNew').hidden = !isNew;
  $('overScore').textContent = Math.floor(score).toLocaleString();
  $('overBest').textContent = best.toLocaleString();
  $('overDist').textContent = (distance / 1000).toFixed(2) + ' km';
  $('holdWrap').hidden = !handMode;
  $('overHint').textContent = handMode ? 'Hold a fist for 1.5 seconds, or press Space, to drive again.' : 'Press Space to drive again.';
  $('holdBar').style.width = '0%';
}
function hit(o) {
  lives--; invuln = 1.2; shake = 0.8; speed *= 0.45;
  o.active = false; o.mesh.visible = false;
  flash();
  if (lives <= 0) gameOver(); else toast(lives === 1 ? 'One impact left' : 'Impact');
}

const diffNow = () => lerp(CFG.traffic.startDiff, 1, clamp(distance / CFG.traffic.rampMeters, 0, 1));
const maxSpeed = () => lerp(CFG.speed.maxStart, CFG.speed.maxEnd, diffNow()) * S.top;

/* Is there room for a vehicle of this size at lateral x and distance z (given its speed and the closing speed)? */
function clearAt(x, z, hw, hl, v, self, m) {
  for (const w of obstacles) {
    if (!w.active || w === self) continue;
    const lx = Math.min(Math.abs(w.x - x), w.lc ? Math.abs(w.lc.x1 - x) : 1e9);
    if (lx > hw + w.hw + 0.7) continue;
    const dz = z - w.z, wv = w.kind === 'veh' ? w.v : 0;          // dz > 0: w is ahead of us
    const c = dz >= 0 ? Math.max(0, v - wv) : Math.max(0, wv - v);   // closing speed
    if (Math.abs(dz) < (hl + w.hl + 6 + c * 0.5 + c * c / 14) * m) return false;
  }
  if (self && z < 0 && Math.abs(car.x - x) < hw + carHW + 0.8) {                    // check the "mirror" for the player
    const c = Math.max(0, speed - v);
    if (-z < (hl + carHL + 6 + c * 0.5 + c * c / 14) * m) return false;
  }
  return true;
}

function applyLamps(o, sp) {
  o.brake.position.set(0, sp.ly, sp.lz); o.brake.scale.set(sp.ls, 1, 1);
  o.ind.position.set(0, sp.ly, sp.lz + 0.01); o.indX = sp.ls + 0.24;
}

function nearestLane(x) { let b = 0; for (let i = 1; i < 4; i++) if (Math.abs(CFG.laneX[i] - x) < Math.abs(CFG.laneX[b] - x)) b = i; return b; }

function spawnVehicle(z) {
  const o = obstacles.find((q) => q.kind === 'veh' && !q.active);
  if (!o) return false;
  const type = pick(WEIGHTS), sp = VSPEC[type], lane = LANES[type];
  const x = type === 'bike' ? rand(-5.3, 5.3) : CFG.laneX[lane[0] + ((Math.random() * (lane[1] - lane[0] + 1)) | 0)];
  const d = diffNow(), vd = rand(sp.v[0], sp.v[1]) * lerp(1.08, 1.28, d);
  if (!clearAt(x, z, sp.hw, sp.hl, vd, o, 0.8)) return false;
  const r = Math.random(), fast = SPORTY[type] ? 0.25 : 0;
  o.type = type; o.spec = sp; o.mesh.geometry = pick(GEO[type]);
  o.pers = r < 0.18 + fast + d * 0.25 ? 'aggressive' : r < 0.42 + fast + d * 0.25 ? 'braker' : r < 0.62 ? 'calm' : 'normal';
  o.vd = o.pers === 'aggressive' ? vd * 1.1 : vd; o.v = o.vd;
  o.x = x; o.y = 0; o.z = z; o.vx = 0; o.hw = sp.hw; o.hl = sp.hl;
  o.lane = lane[0] === lane[1] ? lane[0] : nearestLane(x);
  o.lc = null; o.signal = 0; o.brakeT = 0; o.yieldUntil = 0; o.braking = false; o.passed = false; o.think = rand(0.4, 1.6);
  applyLamps(o, sp);
  o.brakeMat.color.setHex(LAMP_DIM); o.ind.visible = false;
  o.mesh.position.set(o.x, 0, o.z); o.mesh.rotation.y = 0; o.mesh.visible = true; o.active = true;
  return true;
}

function spawnBarrier() {
  const sub = pick(['jersey', 'barricade', 'cones']);
  const o = obstacles.find((q) => q.kind === 'bar' && q.sub === sub && !q.active);
  if (!o) return false;
  const lane = (Math.random() * 4) | 0;
  const x = CFG.laneX[lane] + (sub === 'jersey' ? rand(-0.7, 0.7) : 0);
  if (!clearAt(x, SPAWN_Z, o.hw, o.hl, 0, o, 1)) return false;
  o.x = x; o.y = 0; o.z = SPAWN_Z; o.lane = lane; o.passed = false; o.active = true;
  o.mesh.position.set(o.x, 0, o.z); o.mesh.rotation.y = sub === 'cones' ? 0 : rand(-0.04, 0.04); o.mesh.visible = true;
  return true;
}

function startLaneChange(o, x1, lane) {
  o.lc = { x0: o.x, x1, t: 0, dur: o.spec.heavy ? 1.6 : 1.1, delay: 0.6, laneFrom: o.lane };
  o.signal = Math.sign(x1 - o.x);
  if (lane != null) o.lane = lane;
}

function decide(o, lead, gap, lv) {
  const sp = o.spec, d = diffNow();
  const needPass = lead && gap < (lead.kind === 'bar' ? 80 : 42) && (lead.kind === 'bar' || lv < o.vd - 1.5);
  const stuck = lead && lead.kind === 'bar' && o.v < 4;                         // queued behind a barrier: accept a smaller gap
  const base = (o.pers === 'aggressive' ? 0.35 : o.pers === 'calm' ? 0.08 : 0.18) * (0.8 + d);
  if (o.type === 'bike') {                                                      // motorcycles filter between lanes
    if (Math.random() < 0.55 || needPass) {
      const lane = nearestLane(o.x), dirs = needPass ? [1, -1] : (Math.random() < 0.5 ? [1, -1] : [-1, 1]);
      for (const dir of dirs) {
        const nl = lane + dir;
        if (nl < 0 || nl > 3) continue;
        const x1 = CFG.laneX[nl];
        if (clearAt(x1, o.z, o.hw, o.hl, o.v, o, 0.7)) { startLaneChange(o, x1, nl); break; }
      }
    }
    return;
  }
  if (!(needPass || Math.random() < base)) return;
  const [lo, hi] = LANES[o.type];
  const dirs = needPass ? [1, -1] : (Math.random() < 0.5 ? [1, -1] : [-1, 1]);       // Indian traffic overtakes on the right
  for (const dir of dirs) {
    const nl = o.lane + dir;
    if (nl < lo || nl > hi) continue;
    const x1 = CFG.laneX[nl];
    if (!clearAt(x1, o.z, o.hw, o.hl, o.v, o, stuck ? 0.4 : o.pers === 'aggressive' ? 0.35 : 0.85)) continue;
    startLaneChange(o, x1, nl);
    return;
  }
}

function latOverlap(a, b, margin) {                                        // do the paths of a and b (now or after a lane change) overlap sideways?
  const ax = a.lc ? [a.x, a.lc.x1] : [a.x], bx = b.lc ? [b.x, b.lc.x1] : [b.x];
  for (const p of ax) for (const q of bx) if (Math.abs(p - q) < a.hw + b.hw + margin) return true;
  return false;
}

function updateVehicle(o, dt) {
  let lead = null, gap = 999;
  for (const w of obstacles) {
    if (!w.active || w === o || w.z >= o.z) continue;
    if (!latOverlap(o, w, 0.5)) continue;
    const g = (o.z - w.z) - (o.hl + w.hl);
    if (g < gap) { gap = g; lead = w; }
  }
  const lv = lead ? (lead.kind === 'veh' ? lead.v : 0) : 99;
  let target = o.vd;
  if (lead && gap < (lead.kind === 'bar' ? 80 : 42)) {                      // keep a time gap and always be able to stop in the space left
    const room = Math.max(0, gap - (4 + o.v * 0.5));
    target = Math.min(target, lv + Math.sqrt(2 * 5 * room));
  }
  o.think -= dt;
  if (!o.lc && o.think <= 0) { o.think = rand(0.4, 1.0); decide(o, lead, gap, lv); }
  if (o.pers === 'braker' && o.brakeT <= 0 && Math.random() < dt * 0.12) o.brakeT = rand(0.9, 1.6);   // sudden braking for no reason
  if (o.brakeT > 0) { o.brakeT -= dt; target = Math.min(target, o.vd * 0.45); }
  const dv = target - o.v;
  const maxDec = (lead && gap < 14 + o.v * 0.6) ? 14 : (o.brakeT > 0 ? 7 : 5.5);
  o.v += clamp(dv, -maxDec * dt, 2.4 * dt);
  o.braking = dv < -1.0 || o.brakeT > 0;

  const px = o.x;
  if (o.lc) {
    if (o.lc.delay > 0) {
      o.lc.delay -= dt;
      if (o.lc.delay <= 0) {
        if (!clearAt(o.lc.x1, o.z, o.hw, o.hl, o.v, o, 0.6)) {
          o.lane = o.lc.laneFrom; o.lc = null; o.signal = 0;
        }
      }
    } else {
      o.lc.t += dt / o.lc.dur;
      const s = clamp(o.lc.t, 0, 1), e = s * s * (3 - 2 * s);
      o.x = o.lc.x0 + (o.lc.x1 - o.lc.x0) * e;
      if (o.lc.t >= 1) { o.x = o.lc.x1; o.lc = null; o.signal = 0; }
    }
  }
  o.vx = (o.x - px) / Math.max(dt, 1e-3);
  o.mesh.rotation.y = -clamp(o.vx * 0.05, -0.28, 0.28);
  o.ind.visible = o.signal !== 0 && Math.floor(tNow * 3) % 2 === 0;
  if (o.signal !== 0) o.ind.position.x = o.signal * o.indX;
  o.brakeMat.color.setHex(o.braking ? LAMP_ON : LAMP_DIM);
}

function updateObstacles(dt) {
  for (const o of obstacles) {
    if (!o.active) continue;
    if (o.kind === 'veh') updateVehicle(o, dt);
    o.z += (speed - o.v) * dt;
    if (o.z > 30 || o.z < -260) { o.active = false; o.mesh.visible = false; continue; }
    o.mesh.position.set(o.x, o.y, o.z);
    if (state !== 'playing') continue;
    if (!o.passed && o.z > o.hl + carHL + 0.3) {
      o.passed = true;
      if (Math.abs(o.x - car.x) < o.hw + carHW + 0.8) { bonus += 60; toast('Close call +60'); } else bonus += 25;
    } else if (invuln <= 0 && Math.abs(o.z) < (o.hl + carHL) * 0.92 && Math.abs(o.x - car.x) < (o.hw + carHW) * 0.92) {
      hit(o);
    }
  }
}

function steer(dt) {
  const l = keys.ArrowLeft || keys.KeyA, r = keys.ArrowRight || keys.KeyD, prev = car.x;
  if (l || r) {
    car.x += ((r ? 1 : 0) - (l ? 1 : 0)) * CFG.keyLateral * S.grip * dt;
  } else if (handFresh()) {
    if (H.mode === 'wheel') {
      let w = Math.abs(H.wheel) < 0.08 ? 0 : H.wheel;
      w = Math.sign(w) * Math.pow(Math.abs(w), 1.25);
      car.x += w * CFG.hand.wheelSpeed * S.grip * dt;
    } else {
      const target = clamp((H.x - 0.5) / CFG.hand.steerRange, -1, 1) * CFG.carLimit, lim = CFG.maxLateral * S.grip * dt;
      car.x += clamp((target - car.x) * Math.min(1, 9 * dt), -lim, lim);
    }
  }
  car.x = clamp(car.x, -CFG.carLimit, CFG.carLimit);
  car.lv = lerp(car.lv, (car.x - prev) / Math.max(dt, 1e-3), Math.min(1, 10 * dt));
}

function playStep(dt) {
  const hf = handFresh(), kbRecent = now() - lastKeyT < 1.5;
  if (dipperRequest > 0) requestTrafficYield();
  steer(dt);
  const braking = !!(keys.ArrowDown || keys.KeyS || (hf && H.fist));
  let target;
  if (braking) target = CFG.speed.min;
  else if (handMode && !hf && !kbRecent) target = CFG.speed.lost;
  else if (!handMode && !(keys.ArrowUp || keys.KeyW)) target = 0;
  else target = maxSpeed();
  const rate = braking ? CFG.speed.brake : (target > speed ? CFG.speed.accel * S.accel : CFG.speed.coast);
  speed += clamp(target - speed, -rate * dt, rate * dt);
  car.braking = braking;
  distance += speed * dt;
  score = Math.floor(distance) + bonus;
  invuln = Math.max(0, invuln - dt);
  if (goT > 0) { goT -= dt; if (goT <= 0) setBig(''); }

  const d = diffNow();
  const TR = CFG.traffic, cap = Math.round(lerp(TR.capStart, TR.capEnd, d));
  let nVeh = 0; for (const o of obstacles) if (o.active && o.kind === 'veh') nVeh++;
  vehTimer -= dt;
  if (vehTimer <= 0) vehTimer = (nVeh < cap && spawnVehicle(SPAWN_Z - rand(0, 8))) ? rand(TR.spawnMin, TR.spawnMax) * (1.2 - d * 0.5) : 0.25;
  barTimer -= dt;
  if (barTimer <= 0) barTimer = spawnBarrier() ? rand(TR.barrierMin, TR.barrierMax) * (1.1 - d * 0.5) : 0.8;
}

function overStep(dt) {
  overT += dt;
  speed += clamp(0 - speed, -CFG.speed.brake * dt, CFG.speed.brake * dt);
  car.braking = true;
  if (overT > 0.7 && $('over').hidden) $('over').hidden = false;
  if (!handMode || overT < 0.8) return;
  const fisting = handFresh() && H.fist;
  if (!fistArmed) { if (!fisting) fistArmed = true; fistHold = 0; }        // the fist must be released first
  else fistHold = fisting ? fistHold + dt : 0;
  $('holdBar').style.width = clamp(fistHold / 1.5, 0, 1) * 100 + '%';
  if (fistHold >= 1.5) startRun();
}

function step(dt) {
  tNow += dt;
  dipperFlash = Math.max(0, dipperFlash - dt);
  dipperRequest = Math.max(0, dipperRequest - dt);
  if (state === 'menu') {
    speed = lerp(speed, 14, Math.min(1, 2 * dt));
    car.x = Math.sin(tNow * 0.5) * 2.2; car.lv = Math.cos(tNow * 0.5) * 1.1; car.braking = false;
  } else if (state === 'garage') {
    speed = lerp(speed, 0, Math.min(1, 3 * dt));
    car.x = lerp(car.x, 0, Math.min(1, 6 * dt)); car.lv = 0; car.braking = false;
    garageAngle += dt * 0.7;
  } else if (state === 'countdown') {
    countT += dt;
    speed = lerp(speed, 10, Math.min(1, 3 * dt));
    steer(dt); car.braking = false;
    if (countT >= 2.7) { setState('playing'); setBig('Go'); goT = 0.8; }
    else setBig(String(3 - Math.floor(countT / 0.9)));
  } else if (state === 'playing') {
    playStep(dt);
  } else {
    overStep(dt);
  }

  updateNightEnvironment();
  const d = speed * dt;
  roadTex.offset.y = (roadTex.offset.y + d / ROAD_TILE) % 1;
  for (const s of scatters) s.update(d);
  updateObstacles(dt);
}

const NIGHT_START_DISTANCE = 250, NIGHT_TRANSITION_DISTANCE = 500;
const dayFogColor = new THREE.Color(CFG.fog), nightFogColor = new THREE.Color(0x111a2b);
const dayHemisphereColor = new THREE.Color(0xe3a898), nightHemisphereColor = new THREE.Color(0x8290c4);
const dayGroundColor = new THREE.Color(0x2a2030), nightGroundColor = new THREE.Color(0x111827);
const daySunColor = new THREE.Color(0xffc890), nightSunColor = new THREE.Color(0x9ca9d1);
const daySkyRows = SKY_ROWS.map((hex) => new THREE.Color(hex));
const nightSkyRows = NIGHT_SKY_ROWS.map((hex) => new THREE.Color(hex));
const blendedSkyRows = SKY_ROWS.map(() => new THREE.Color());
let nightAmount = 0;
function updateNightEnvironment() {
  nightAmount = clamp((distance - NIGHT_START_DISTANCE) / NIGHT_TRANSITION_DISTANCE, 0, 1);
  const colors = skyQuad.geometry.attributes.color;
  for (let i = 0; i < blendedSkyRows.length; i++) {
    const row = blendedSkyRows[i].lerpColors(daySkyRows[i], nightSkyRows[i], nightAmount);
    for (let v = 0; v < 2; v++) colors.setXYZ(i * 2 + v, row.r, row.g, row.b);
  }
  colors.needsUpdate = true;
  scene.fog.color.lerpColors(dayFogColor, nightFogColor, nightAmount);
  renderer.setClearColor(scene.fog.color, 1);
  hemisphereLight.color.lerpColors(dayHemisphereColor, nightHemisphereColor, nightAmount);
  hemisphereLight.groundColor.lerpColors(dayGroundColor, nightGroundColor, nightAmount);
  hemisphereLight.intensity = lerp(0.95, 0.38, nightAmount);
  sunLight.color.lerpColors(daySunColor, nightSunColor, nightAmount);
  sunLight.intensity = lerp(0.8, 0.18, nightAmount);
  nightStars.visible = nightAmount > 0;
  nightStars.material.opacity = nightAmount;
  sunsetGlow.material.opacity = sunsetSun.material.opacity = sunsetClouds.material.opacity = 1 - nightAmount;
  headlightMat.opacity = nightAmount > 0 ? 1 : 0;
  headlight.intensity = nightAmount > 0 ? 2.4 : 0;
}

let lastBraking = null;
const camBase = { x: 0, y: 2.8, z: 7.4 }, camLook = { x: 0, y: 1.1, z: -18 };
function updateVisuals(dt) {
  const G = state === 'garage';
  const selectedCar = CARS[selCar];
  const garageDistance = Math.max(7.4, selectedCar.L * 1.8);
  const driveDistance = Math.max(7.4, selectedCar.L * 1.8);
  const driveHeight = Math.max(2.8, 2.8 + selectedCar.L * 0.4);
  player.position.x = car.x;
  player.rotation.y = G ? garageAngle : -clamp(car.lv * 0.03, -0.25, 0.25);
  player.rotation.z = G ? 0 : clamp(car.lv * 0.004, -0.08, 0.08);
  player.visible = invuln <= 0 || Math.floor(invuln * 14) % 2 === 0;
  if (lastBraking !== car.braking) { playerBrake.material.color.setHex(car.braking ? LAMP_ON : LAMP_DIM); lastBraking = car.braking; }

  shake = Math.max(0, shake - dt * 2.2);
  const sx = (Math.random() - 0.5) * shake * 0.4, sy = (Math.random() - 0.5) * shake * 0.4;
  const k = Math.min(1, (G ? 4 : 5) * dt);
  camBase.x = lerp(camBase.x, G ? 0 : car.x * 0.6, k); camBase.y = lerp(camBase.y, G ? Math.max(1.9, 0.8 + garageDistance * 0.2) : driveHeight, k); camBase.z = lerp(camBase.z, G ? garageDistance : driveDistance, k);
  camLook.x = lerp(camLook.x, G ? 0 : car.x * 0.35, k); camLook.y = lerp(camLook.y, G ? 0.8 : 1.1, k); camLook.z = lerp(camLook.z, G ? 0 : -18, k);
  camera.position.set(camBase.x + sx, camBase.y + sy, camBase.z);
  camera.lookAt(camLook.x, camLook.y, camLook.z);
  camera.rotateZ(-clamp(car.lv * 0.0025, -0.04, 0.04));                 // gentle lean into the steering
  camera.fov = G ? 48 : 54 + clamp(speed / CFG.speed.maxEnd, 0, 1) * 8;
  camera.updateProjectionMatrix();

  skyGroup.position.copy(camera.position);
  skyQuad.position.x = camera.position.x;
  hills.position.x = camera.position.x * 0.9;
}

/* ------------------------------ MAIN LOOP ------------------------------- */
let lastT = performance.now(), fpsAcc = 0, fpsFrames = 0, settle = 1.5, floorLow = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const raw = (t - lastT) / 1000; lastT = t;
  if (paused || !(raw > 0)) return;
  const dt = Math.min(raw, 0.05);
  step(dt);
  updateVisuals(dt);
  renderer.render(scene, camera);

  fpsAcc += raw; fpsFrames++;
  if (fpsAcc >= 0.8) {                                                  // adaptive resolution: step down quickly when the frame rate is poor
    fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0;
    if (settle > 0) settle -= 0.8;
    else if (fps < 46 && Q.level < Q.levels.length - 1) {
      Q.level = Math.min(Q.levels.length - 1, Q.level + (fps < 28 ? 2 : 1));
      applyQuality(); settle = 1.6;
    } else if (fps < 24 && Q.level === Q.levels.length - 1 && ++floorLow === 4) {
      showError('Still slow at the lowest setting. Make sure browser hardware acceleration is on, plug in the charger, close other tabs, and try Chrome or Edge.', 20000);
    }
  }
}

/* ------------------------------ BOOT ------------------------------------ */
$('btnKeys').onclick = startKeyboard;
$('btnBack').onclick = () => setState('menu');
$('btnDrive').onclick = startRun;
$('btnAgain').onclick = () => { if (state === 'over') startRun(); };
$('btnGarage').onclick = () => { if (state === 'over') goGarage(); };
$('btnHand').onclick = async () => {
  $('btnHand').disabled = true; $('btnKeys').disabled = true;
  try {
    if (!trackerReady()) await initHandTracking(); else handMode = true;
    $('menuStatus').textContent = '';
    goGarage();
  } catch (err) {
    console.error(err);
    let msg = err && err.message ? err.message : 'Hand tracking could not start.';
    if (err && err.name === 'NotAllowedError') msg = 'Camera permission was denied. Allow the camera for this page, or use the keyboard.';
    if (err && err.name === 'NotFoundError') msg = 'No camera was found. Connect one, or use the keyboard.';
    $('menuStatus').textContent = msg;
  }
  $('btnHand').disabled = false; $('btnKeys').disabled = false;
};
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'playing' && !paused) togglePause(); });

$('ver').textContent = VERSION + (gpuName ? '. Graphics: ' + gpuName : '');
if (softGL) $('menuStatus').textContent = 'Your browser is drawing with software graphics, which is slow. Turn on hardware acceleration in the browser settings (Chrome: Settings, System, "Use graphics acceleration when available"), then restart the browser.';
else if (location.protocol === 'file:') $('menuStatus').textContent = 'Tip: run start-server.bat and open http://localhost:8000 for reliable camera access.';
applyQuality();
setInterval(hudTick, 100);
requestAnimationFrame(frame);
})();
