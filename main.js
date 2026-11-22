import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ====================================================================== */
/* Settings you may want to change                                         */
/* ====================================================================== */
const ASSETS = './assets/';
const COMPOSITE_SIZE = Number(new URLSearchParams(location.search).get('size')) || 512;  // texture the roll draws: 512 like the game, or 1024 or 2048
const MIP_BIAS = -0.7;   // sharpening: below 0 picks a bigger copy of each texture (0 = off, -1 = strong, may shimmer)
const ZOOM_MIN = 0.6, ZOOM_MAX = 1.1;  // how far people may zoom, as a share of the "everything fits" distance
const PITCH_LIMIT = 0.6;                 // how far the hat may tip up or down (radians)
const FOV = 28;
const JIGGLE_STRENGTH = 0.1;   // how much of the hat's turning reaches the tail: 1 = full physical lag, 0.1 = a tenth of it
// A plain grey head with no textures (for if you cannot publish the mannequin's textures). Set true, or add ?plainhead to the address.
const PLAIN_HEAD = false || new URLSearchParams(location.search).has('plainhead');
const USE_LIGHTWARP_FILE = false;       // set true after adding assets/lightwarp.png (the real pyro_lightwarp as a PNG)

// Lighting. Set by eye, not measured from the game: change them to match a screenshot.
const LIGHT_COLOUR = [0.78, 0.77, 0.74];
const AMBIENT_UP = [0.34, 0.36, 0.40];
const AMBIENT_DOWN = [0.13, 0.12, 0.11];
const RIM_SCALE = 1.0;                   // overall rim light strength

/* ====================================================================== */
/* The seed: same hashing and rolling as the Workbench's compositor        */
/* ====================================================================== */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function unit(seed, path, field) {
  let a = (hash32(`${seed}|${path}|${field}`) + 0x6d2b79f5) | 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}
function parseRange(text) {
  const p = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return p.length === 1 ? [p[0], p[0]] : [p[0], p[1]];
}
function rollField(seed, path, field, spec) {
  const [a, b] = parseRange(spec);
  return a + (b - a) * unit(seed, path, field);
}

/* The paintkit definition, written out. Structure (fixed in the shader below):
   result = lerp( fur_a x gradient , fur_b x gradient , (blotch x marks).red ) x static_uv        */
const L = '0:combine_multiply/0:combine_lerp';
const LOOKUPS = {
  fa: { path: `${L}/0:combine_multiply/0:texture_lookup`, tex: 'fur_a',        rot: '0 360', tu: '0 1',  tv: '0 1',  scale: '0.075 0.125' },
  ga: { path: `${L}/0:combine_multiply/1:texture_lookup`, tex: 'fur_gradient', rot: '0',     tu: '0 10', tv: '0 10', scale: '0.025' },
  fb: { path: `${L}/1:combine_multiply/0:texture_lookup`, tex: 'fur_b',        rot: '0 360', tu: '0 1',  tv: '0 1',  scale: '0.075 0.125' },
  gb: { path: `${L}/1:combine_multiply/1:texture_lookup`, tex: 'fur_gradient', rot: '0',     tu: '0 10', tv: '0 10', scale: '0.025' },
  bl: { path: `${L}/2:combine_multiply/0:texture_lookup`, tex: 'blotch',       rot: '0 360', tu: '0 1',  tv: '0 1',  scale: '0.075 0.125' },
  mk: { path: `${L}/2:combine_multiply/1:texture_lookup`, tex: 'marks',        rot: '0',     tu: '0 1',  tv: '0 1',  scale: '0.1' },
};

/** All the numbers one seed decides: [rotation (radians), scale, translate u, translate v] for every layer. */
function rollSeed(seed) {
  const out = {};
  for (const [key, d] of Object.entries(LOOKUPS)) {
    out[key] = [
      rollField(seed, d.path, 'rotation', d.rot) * Math.PI / 180,
      rollField(seed, d.path, 'scale_uv', d.scale),
      rollField(seed, d.path, 'translate_u', d.tu),
      rollField(seed, d.path, 'translate_v', d.tv),
    ];
  }
  return out;
}

/* ====================================================================== */
/* Loading                                                                  */
/* ====================================================================== */
const textureLoader = new THREE.TextureLoader();
function loadTexture(url, { repeat = false } = {}) {
  return new Promise((resolve, reject) => {
    textureLoader.load(url, (t) => {
      t.flipY = false;                       // glTF UVs count from the top, like the image files
      t.colorSpace = THREE.NoColorSpace;     // raw numbers: the shaders below do their own colour handling
      t.magFilter = THREE.LinearFilter;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      resolve(t);
    }, undefined, () => reject(new Error('Could not load ' + url)));
  });
}
const tryTexture = (url, opts) => loadTexture(url, opts).catch(() => null);

// the head's textures, or one plain colour each when PLAIN_HEAD is on
function headTexture(url, rgba) {
  if (!PLAIN_HEAD) return loadTexture(url, { repeat: true });
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
  return Promise.resolve(t);
}

/* ====================================================================== */
/* Renderer, scene                                                          */
/* ====================================================================== */
const canvas = document.getElementById('view');
const frame = document.getElementById('frame');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1000);
const rig = new THREE.Group();   // turned by the user
scene.add(rig);

let dirty = true;
const requestRender = () => { dirty = true; };

/* ====================================================================== */
/* The roll: draws the hat's whole texture on the graphics card             */
/* ====================================================================== */
const COMPOSITOR_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// One output pixel at (u, v) reads each layer at  scale * Rotate(rot) * (uv - 0.5) + 0.5 + translate  (wrapping), as in the Workbench.
const COMPOSITOR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tFa, tGa, tFb, tGb, tBl, tMk, tSt;
uniform vec4 xFa, xGa, xFb, xGb, xBl, xMk;   // rotation, scale, translate u, translate v
vec3 look(sampler2D t, vec4 x) {
  vec2 d = vUv - 0.5;
  float c = cos(x.x), s = sin(x.x);
  vec2 r = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  return texture2D(t, r * x.y + 0.5 + x.zw).rgb;
}
void main() {
  vec3 a = look(tFa, xFa) * look(tGa, xGa);
  vec3 b = look(tFb, xFb) * look(tGb, xGb);
  float m = (look(tBl, xBl) * look(tMk, xMk)).r;
  vec3 col = mix(a, b, m) * texture2D(tSt, vUv).rgb;
  gl_FragColor = vec4(col, 1.0);
}`;

function makeCompositor(tex) {
  const u = {
    tFa: { value: tex.fur_a }, tGa: { value: tex.fur_gradient }, tFb: { value: tex.fur_b }, tGb: { value: tex.fur_gradient },
    tBl: { value: tex.blotch }, tMk: { value: tex.marks }, tSt: { value: tex.static_uv },
    xFa: { value: new THREE.Vector4() }, xGa: { value: new THREE.Vector4() }, xFb: { value: new THREE.Vector4() },
    xGb: { value: new THREE.Vector4() }, xBl: { value: new THREE.Vector4() }, xMk: { value: new THREE.Vector4() },
  };
  const mat = new THREE.ShaderMaterial({ uniforms: u, vertexShader: COMPOSITOR_VERT, fragmentShader: COMPOSITOR_FRAG, depthTest: false, depthWrite: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const s = new THREE.Scene(); s.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const rt = new THREE.WebGLRenderTarget(COMPOSITE_SIZE, COMPOSITE_SIZE, {
    depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.anisotropy = maxAniso;
  const KEY = { fa: 'xFa', ga: 'xGa', fb: 'xFb', gb: 'xGb', bl: 'xBl', mk: 'xMk' };
  return {
    texture: rt.texture, target: rt,
    draw(seed) {
      const r = rollSeed(seed);
      for (const k of Object.keys(KEY)) u[KEY[k]].value.set(r[k][0], r[k][1], r[k][2], r[k][3]);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(s, cam);
      renderer.setRenderTarget(prev);
    },
  };
}

/* ====================================================================== */
/* TF2 style shading (VertexLitGeneric: light ramp, half Lambert, phong, rim) */
/* ====================================================================== */
const TF2_VERT = `
varying vec3 vN; varying vec3 vP; varying vec2 vUv;
#ifdef SKIN
attribute vec3 aSkin;          // weights: hat, tail_jiggle_1, tail_jiggle_2
uniform mat4 uJ1, uJ2;         // how far each tail bone has moved from its rest pose
#endif
void main() {
  vUv = uv;
  vec3 pos = position, nrm = normal;
#ifdef SKIN
  vec4 p4 = vec4(position, 1.0);
  pos = aSkin.x * position + aSkin.y * (uJ1 * p4).xyz + aSkin.z * (uJ2 * p4).xyz;
  nrm = aSkin.x * normal + aSkin.y * (mat3(uJ1) * normal) + aSkin.z * (mat3(uJ2) * normal);
#endif
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vP = mv.xyz;
  vN = normalMatrix * nrm;
  gl_Position = projectionMatrix * mv;
}`;

const TF2_FRAG = `
precision highp float;
varying vec3 vN; varying vec3 vP; varying vec2 vUv;
uniform sampler2D tMap, tNormal, tExp, tWarp;
uniform float uHasExp;      // 1: exponent, tint mask and rim mask come from tExp
uniform float uExp;         // constant exponent when there is no texture
uniform float uBoost;
uniform vec3  uFres;
uniform float uRimExp, uRimBoost, uRimMask, uTint;
uniform vec3  uLightDir, uLightCol, uAmbUp, uAmbDown;
uniform float uRimScale;
uniform float uBias;        // mip bias (sharpening)

mat3 cotangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float inv = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  return mat3(T * inv, B * inv, N);
}
vec3 ambient(vec3 n) { return mix(uAmbDown, uAmbUp, n.y * 0.5 + 0.5); }
float fresnel(float ndv) {
  float f = clamp(1.0 - ndv, 0.0, 1.0); f *= f;
  return f < 0.5 ? mix(uFres.x, uFres.y, 2.0 * f) : mix(uFres.y, uFres.z, 2.0 * f - 1.0);
}

void main() {
  vec3 N0 = normalize(vN);
  if (!gl_FrontFacing) N0 = -N0;
  vec4 nm = texture2D(tNormal, vUv, uBias);
  vec3 nt = nm.rgb * 2.0 - 1.0;                       // DirectX style map: green follows the image's v, which the frame below uses
  vec3 N = normalize(cotangentFrame(N0, vP, vUv) * nt);
  vec3 V = normalize(-vP);
  vec3 Ld = normalize(uLightDir);

  vec3 albedo = pow(texture2D(tMap, vUv, uBias).rgb, vec3(2.2));
  vec4 ex = texture2D(tExp, vUv, uBias);

  // diffuse: half Lambert (phong forces it in TF2) through the light ramp, which is doubled
  float hl = dot(N, Ld) * 0.5 + 0.5;
  vec3 warp = texture2D(tWarp, vec2(hl, 0.5)).rgb * 2.0;
  vec3 diffuse = albedo * (warp * uLightCol + ambient(N));

  // phong: mask is the normal map's alpha
  float exponent = mix(uExp, 1.0 + 149.0 * ex.r, uHasExp);
  vec3 R = reflect(-Ld, N);
  float ndl = clamp(dot(N, Ld), 0.0, 1.0);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float spec = pow(max(dot(R, V), 0.0), exponent) * ndl * uBoost * nm.a * fresnel(ndv);
  float tintMask = uTint * mix(1.0, ex.g, uHasExp);
  // rim: strongest at the silhouette, from the ambient light, limited by the rim mask (exponent texture alpha)
  float rimMask = mix(1.0, ex.a, uRimMask);
  float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), uRimExp) * uRimBoost * rimMask * uRimScale;
  vec3 rimCol = rim * ambient(N) * 0.5;

  // $phongalbedotint: all the specular light, rim included, takes the diffuse texture's colour where the exponent texture's green channel says so
  vec3 tintCol = mix(vec3(1.0), albedo, tintMask);
  vec3 specCol = (vec3(spec) * uLightCol + rimCol) * tintCol;

  vec3 col = diffuse + specCol;
  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

const sharedLight = {
  uLightDir: { value: new THREE.Vector3(-0.4, 0.5, 0.75).normalize() },
  uLightCol: { value: new THREE.Vector3(...LIGHT_COLOUR) },
  uAmbUp: { value: new THREE.Vector3(...AMBIENT_UP) },
  uAmbDown: { value: new THREE.Vector3(...AMBIENT_DOWN) },
  uRimScale: { value: RIM_SCALE },
  uBias: { value: MIP_BIAS },
};

const skinUniforms = { uJ1: { value: new THREE.Matrix4() }, uJ2: { value: new THREE.Matrix4() } };
function makeTF2Material(p) {
  return new THREE.ShaderMaterial({
    vertexShader: TF2_VERT, fragmentShader: TF2_FRAG, side: THREE.DoubleSide,
    defines: p.skin ? { SKIN: 1 } : {},
    uniforms: {
      tMap: { value: p.map }, tNormal: { value: p.normal }, tExp: { value: p.exp }, tWarp: { value: p.warp },
      uHasExp: { value: p.exp === p.blank ? 0 : 1 }, uExp: { value: p.exponent ?? 10 },
      uBoost: { value: p.boost }, uFres: { value: new THREE.Vector3(...p.fresnel) },
      uRimExp: { value: p.rimExp }, uRimBoost: { value: p.rimBoost }, uRimMask: { value: p.rimMask ? 1 : 0 }, uTint: { value: p.tint ? 1 : 0 },
      ...sharedLight, ...(p.skin ? skinUniforms : {}),
    },
  });
}

/* An approximation of models/player/pyro/pyro_lightwarp (256 x 1). If assets/lightwarp.png exists it is used instead. */
function proceduralWarp() {
  const n = 256, data = new Uint8Array(n * 4);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1), v = 0.17 + 0.40 * ss(0.12, 0.92, x);
    data.set([Math.round(v * 255 * 1.02), Math.round(v * 255), Math.round(v * 255 * 0.97), 255], i * 4);
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace; t.magFilter = t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}

/* ====================================================================== */
/* Start up                                                                 */
/* ====================================================================== */
let compositor = null;
let state = { yaw: 0.55, pitch: 0.1, zoom: 1 };
let fitDistance = 50, pivotRadius = 14;

async function start() {
  const P = ASSETS + 'patterns/', H = ASSETS + 'hat/', D = ASSETS + 'head/';
  const names = ['fur_a', 'fur_b', 'fur_gradient', 'blotch', 'marks', 'static_uv'];
  const [pat, hatNormal, hatExp, hatColour, headA, headAn, headB, headBn, warpFile, gltf, jiggleData] = await Promise.all([
    Promise.all(names.map((n) => loadTexture(P + n + '.png', { repeat: true }))),
    loadTexture(H + 'normal.png', { repeat: true }), loadTexture(H + 'phongexponent.png', { repeat: true }), loadTexture(H + 'color.png', { repeat: true }),
    headTexture(D + 'a_mannequin.webp', [150, 148, 144, 255]), headTexture(D + 'a_mannequin_normals.webp', [128, 128, 255, 255]),
    headTexture(D + 'b_metal.webp', [60, 60, 62, 255]), headTexture(D + 'b_metal_normals.webp', [128, 128, 255, 255]),
    USE_LIGHTWARP_FILE ? tryTexture(ASSETS + 'lightwarp.png') : null,
    new GLTFLoader().loadAsync(ASSETS + 'hat_head.glb'),
    fetch(ASSETS + 'jiggle.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const tex = Object.fromEntries(names.map((n, i) => [n, pat[i]]));
  for (const t of [hatNormal, hatExp, hatColour, headA, headAn, headB, headBn]) t.anisotropy = maxAniso;
  const warp = warpFile ? (warpFile.wrapS = warpFile.wrapT = THREE.ClampToEdgeWrapping, warpFile) : proceduralWarp();

  compositor = makeCompositor(tex);
  const blank = new THREE.DataTexture(new Uint8Array([0, 255, 0, 255]), 1, 1, THREE.RGBAFormat); blank.needsUpdate = true;

  const mats = {
    matrandom: makeTF2Material({ map: compositor.texture, normal: hatNormal, exp: hatExp, warp, blank,
      boost: 2.75, fresnel: [0.1, 0.4, 1], rimExp: 4, rimBoost: 25, rimMask: true, skin: true, tint: !new URLSearchParams(location.search).has('notint') }),
    a_mannequin: makeTF2Material({ map: headA, normal: headAn, exp: blank, warp, blank, exponent: 12,
      boost: 2.0, fresnel: [0.25, 0.5, 1], rimExp: 6, rimBoost: 1.5, rimMask: false, tint: false }),
    b_metal: makeTF2Material({ map: headB, normal: headBn, exp: blank, warp, blank, exponent: 20,
      boost: 6.0, fresnel: [0.25, 0.5, 1], rimExp: 12, rimBoost: 1.0, rimMask: false, tint: false }),
  };

  const model = gltf.scene;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const m = mats[o.material?.name];
    if (m) o.material = m;
  });

  // pivot on the head, and work out how far back the camera must stand so everything stays in view while it turns
  const headBox = new THREE.Box3(), all = new THREE.Box3().setFromObject(model);
  model.traverse((o) => { if (o.isMesh && o.material !== mats.matrandom) headBox.expandByObject(o); });
  const pivot = headBox.isEmpty() ? all.getCenter(new THREE.Vector3()) : headBox.getCenter(new THREE.Vector3());
  model.position.sub(pivot);
  setupJiggle(model, jiggleData, pivot, mats.matrandom);
  all.translate(pivot.clone().negate());
  rig.add(model);
  // the farthest real vertex from the pivot (not the corner of a box), so the fit is as tight as it can be
  model.updateMatrixWorld(true);
  let r2 = 0; const v = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); r2 = Math.max(r2, v.lengthSq()); }
  });
  pivotRadius = Math.sqrt(r2);

  resize();
  const hashSeed = Number((location.hash.match(/seed=(\d+)/) || [])[1]);
  roll(Number.isFinite(hashSeed) && hashSeed > 0 ? hashSeed : randomSeed());
  document.getElementById('loading').classList.add('done');
}

function randomSeed() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return (a[0] >>> 1) || 1;   // 1 to 2^31
}
let currentSeed = 0;
function roll(seed) {
  currentSeed = seed;
  compositor.draw(seed);
  requestRender();
}

/* ====================================================================== */
/* Tail jiggle: two springs from the QC's jigglebones (stiffness 100, damping 7) */
/* ====================================================================== */
const jig = { ok: false, on: true, q1: new THREE.Vector3(), q2: new THREE.Vector3(), v1: new THREE.Vector3(), v2: new THREE.Vector3(),
  P0: new THREE.Vector3(), r1: new THREE.Vector3(), r2: new THREE.Vector3(), L1: 1, L2: 1, k: 100, c: 7, pivot: new THREE.Vector3(),
  prevQ: new THREE.Quaternion(), last: 0, active: false };

function setupJiggle(model, data, pivot, hatMaterial) {
  let hat = null;
  model.traverse((o) => { if (o.isMesh && o.material === hatMaterial) hat = o; });
  if (!hat) return;
  const n = hat.geometry.attributes.position.count;
  const valid = data && data.vertexCount === n && data.weights?.length === n && data.points?.length === 3;
  const w = new Float32Array(n * 3);
  if (valid) data.weights.forEach((a, i) => w.set(a, i * 3)); else for (let i = 0; i < n; i++) w[i * 3] = 1;
  hat.geometry.setAttribute('aSkin', new THREE.BufferAttribute(w, 3));
  if (!valid) return;
  jig.P0.fromArray(data.points[0]); jig.r1.fromArray(data.points[1]); jig.r2.fromArray(data.points[2]);
  jig.L1 = jig.r1.distanceTo(jig.P0); jig.L2 = jig.r2.distanceTo(jig.r1);
  jig.k = data.stiffness ?? 100; jig.c = data.damping ?? 7;
  jig.pivot.copy(pivot);
  jig.ok = true;
  jiggleReset();
}
function jiggleReset() {
  jig.q1.copy(jig.r1); jig.q2.copy(jig.r2); jig.v1.set(0, 0, 0); jig.v2.set(0, 0, 0);
  skinUniforms.uJ1.value.identity(); skinUniforms.uJ2.value.identity();
  jig.active = false; jig.last = 0; jig.prevQ.copy(rig.quaternion);
  requestRender();
}
const _qid = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _qa = new THREE.Quaternion(), _t = new THREE.Matrix4();
function boneMatrix(out, pivotRest, base, restDir, curDir) {
  _qa.setFromUnitVectors(restDir, curDir);
  out.makeRotationFromQuaternion(_qa);
  out.setPosition(base);
  _t.makeTranslation(-pivotRest.x, -pivotRest.y, -pivotRest.z);
  out.multiply(_t);
  return _qa;
}
function stepJiggle(now) {
  if (!jig.ok || !jig.on) return;
  const dt = jig.last ? Math.min((now - jig.last) / 1000, 1 / 20) : 0; jig.last = now;
  // the model was turned by the user: the tail keeps its place in the world, so in the model's own space it gets carried the other way
  _qa.copy(rig.quaternion).invert().multiply(jig.prevQ);          // new^-1 * old
  jig.prevQ.copy(rig.quaternion);
  _qa.slerp(_qid.identity(), 1 - JIGGLE_STRENGTH);               // only a part of the turn reaches the tail
  const turned = Math.abs(_qa.w) < 0.9999999;
  if (turned) for (const [q, v] of [[jig.q1, jig.v1], [jig.q2, jig.v2]]) {
    q.sub(jig.pivot).applyQuaternion(_qa).add(jig.pivot); v.applyQuaternion(_qa);
  }
  if (!dt && !turned) return;
  const d1r = _a.subVectors(jig.r1, jig.P0).normalize().clone(), d2r = _b.subVectors(jig.r2, jig.r1).normalize().clone();
  const steps = Math.max(1, Math.ceil(dt / 0.004)), h = dt / steps;
  const t2 = new THREE.Vector3(), d1 = new THREE.Vector3(), q1r = new THREE.Quaternion();
  for (let s = 0; s < steps; s++) {
    // bone 1: its tip is pulled to the rest tip
    jig.v1.addScaledVector(t2.subVectors(jig.r1, jig.q1), jig.k * h).addScaledVector(jig.v1, -jig.c * h);
    jig.q1.addScaledVector(jig.v1, h);
    d1.subVectors(jig.q1, jig.P0).normalize(); jig.q1.copy(jig.P0).addScaledVector(d1, jig.L1);
    jig.v1.addScaledVector(d1, -jig.v1.dot(d1));
    // bone 2: its tip is pulled to where it would be if it followed bone 1
    q1r.setFromUnitVectors(d1r, d1);
    const tgt = _a.copy(jig.r2).sub(jig.r1).applyQuaternion(q1r).add(jig.q1);
    jig.v2.addScaledVector(t2.subVectors(tgt, jig.q2), jig.k * h).addScaledVector(jig.v2, -jig.c * h);
    jig.q2.addScaledVector(jig.v2, h);
    const d2 = _b.subVectors(jig.q2, jig.q1).normalize(); jig.q2.copy(jig.q1).addScaledVector(d2, jig.L2);
    jig.v2.addScaledVector(d2, -jig.v2.dot(d2));
  }
  // matrices for the shader
  d1.subVectors(jig.q1, jig.P0).normalize();
  boneMatrix(skinUniforms.uJ1.value, jig.P0, jig.P0, d1r, d1);
  const d2n = new THREE.Vector3().subVectors(jig.q2, jig.q1).normalize();
  boneMatrix(skinUniforms.uJ2.value, jig.r1, jig.q1, d2r, d2n);
  const energy = jig.v1.lengthSq() + jig.v2.lengthSq() + jig.q1.distanceToSquared(jig.r1) + jig.q2.distanceToSquared(jig.r2);
  jig.active = energy > 1e-5;
  if (!jig.active) { skinUniforms.uJ1.value.identity(); skinUniforms.uJ2.value.identity(); jig.q1.copy(jig.r1); jig.q2.copy(jig.r2); jig.v1.set(0, 0, 0); jig.v2.set(0, 0, 0); }
  dirty = true;
}
// the tail always jiggles; this is only for the ?debug tests
function setJiggle(on) {
  jig.on = on; if (!on) jiggleReset(); else { jig.prevQ.copy(rig.quaternion); jig.last = 0; }
}

/* ====================================================================== */
/* Size, camera                                                             */
/* ====================================================================== */
function resize() {
  const w = Math.max(1, frame.clientWidth), h = Math.max(1, frame.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const vHalf = THREE.MathUtils.degToRad(FOV) / 2, hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  fitDistance = (pivotRadius / Math.sin(Math.min(vHalf, hHalf))) * 1.02;
  placeCamera(); requestRender();
}
function placeCamera() {
  camera.position.set(0, 0, fitDistance * state.zoom);
  camera.lookAt(0, 0, 0);
  rig.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
}
new ResizeObserver(resize).observe(frame);

/* ====================================================================== */
/* Turning and zooming: mouse, touch, pinch, wheel                          */
/* ====================================================================== */
const pointers = new Map();
let pinchStart = null;
const light = { x: -0.42, y: -0.5 };   // light position, -1 to 1, y down
function applyLight() {
  const len = Math.hypot(light.x, light.y);
  if (len > 1) { light.x /= len; light.y /= len; }
  const z = Math.sqrt(Math.max(0.06, 1 - light.x * light.x - light.y * light.y));
  sharedLight.uLightDir.value.set(light.x, -light.y, z).normalize();
  requestRender();
}
// mouse: drag = turn the hat, Ctrl + left drag = move the light, Ctrl + right drag = zoom (wheel zooms too)
// touch: one finger turns, two fingers pinch to zoom and slide together to move the light
function modeOf(e) {
  if (e.pointerType === 'mouse' && e.ctrlKey) return e.button === 2 ? 'zoom' : 'light';
  return 'turn';
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* some browsers refuse: dragging still works inside the frame */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, mode: modeOf(e) });
  canvas.classList.add('drag');
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom }; }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  const prev = { x: p.x, y: p.y };
  p.x = e.clientX; p.y = e.clientY;
  const lk = 2 / Math.max(200, canvas.clientWidth);
  if (pointers.size === 1) {
    if (p.mode === 'light') { light.x += dx * lk * 1.6; light.y += dy * lk * 1.6; applyLight(); }
    else if (p.mode === 'zoom') { state.zoom = clampZoom(state.zoom * Math.exp(dy * 0.006)); }
    else {
      const k = (Math.PI * 1.6) / Math.max(200, canvas.clientWidth);
      state.yaw += dx * k;
      state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + dy * k));
    }
  } else if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    state.zoom = clampZoom(pinchStart.zoom * (pinchStart.d / Math.max(1, d)));
    // midpoint movement = light (this pointer's half of it)
    light.x += (dx / 2) * lk * 1.6; light.y += (dy / 2) * lk * 1.6; applyLight();
  }
  placeCamera(); requestRender();
});
const endPointer = (e) => { pointers.delete(e.pointerId); pinchStart = null; if (!pointers.size) canvas.classList.remove('drag'); };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); state.zoom = clampZoom(state.zoom * Math.exp(e.deltaY * 0.0012)); placeCamera(); requestRender(); }, { passive: false });
canvas.addEventListener('dblclick', () => { Object.assign(state, { yaw: 0.55, pitch: 0.1, zoom: 1 }); placeCamera(); requestRender(); });
const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
applyLight();

/* ====================================================================== */
/* The button, the loop                                                     */
/* ====================================================================== */
document.getElementById('roll').addEventListener('click', () => roll(randomSeed()));
addEventListener('keydown', (e) => { if (e.key === ' ' && e.target === document.body) { e.preventDefault(); roll(randomSeed()); } });

(function loop(now) {
  requestAnimationFrame(loop);
  stepJiggle(now || performance.now());
  if (!dirty) return;
  dirty = false;
  renderer.render(scene, camera);
})();

start().catch((err) => {
  const el = document.getElementById('loading');
  el.textContent = 'Could not load: ' + err.message;
  console.error(err);
});

// test hook, only with ?debug
if (new URLSearchParams(location.search).has('debug')) {
  window.__hat = { jig, setJiggle, roll, rollSeed, get seed() { return currentSeed; }, renderer, get compositor() { return compositor; }, state, placeCamera, requestRender, THREE };
}
