import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SCALE, type Group } from './geom';
import type { EngineResult, Settings } from './engine';
import { palette } from './render2d';

export class Stack3D {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root = new THREE.Group();
  meshes: THREE.Mesh[] = [];
  explode = 0;
  thickness = 3;
  private raf = 0;
  lost = false;
  onLost?: () => void;
  private lastKey: unknown = null;

  constructor(private host: HTMLElement) {
    const mobile = Math.min(screen.width, screen.height) < 820;
    this.renderer = new THREE.WebGLRenderer({ antialias: !mobile, preserveDrawingBuffer: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(mobile ? 1.5 : 2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.onLost?.(); });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    this.camera.position.set(0, -420, 520);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(this.root);
    this.scene.add(new THREE.HemisphereLight(0xfff4e6, 0x30261c, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-260, 320, 520);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -320; sc.right = sc.top = 320; sc.near = 10; sc.far = 1600;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.raf) return;
    const tick = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(tick); };
    tick();
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  setExplode(e: number) {
    this.explode = e;
    this.meshes.forEach((m, i) => { m.position.z = -(i + 1) * this.thickness * (1 + e * 6); });
  }

  build(r: EngineResult, s: Settings, pal: string) {
    const key = [r, pal];
    if (this.lastKey && (this.lastKey as any)[0] === r && (this.lastKey as any)[1] === pal) return;
    this.lastKey = key;
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); this.root.remove(m); }
    this.meshes = [];
    this.thickness = s.thickness;
    const P = palette(pal);
    const n = r.layers.length;
    r.layers.forEach((L, i) => {
      const shapes = toShapes(L.groups);
      const geo = new THREE.ExtrudeGeometry(shapes, { depth: s.thickness, bevelEnabled: false, curveSegments: 1 });
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.colour(i, n, s.material)), roughness: s.material === 'paper' ? 0.95 : 0.78, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.root.add(mesh);
      this.meshes.push(mesh);
    });
    this.setExplode(this.explode);
    // y-down (SVG) -> y-up (3D)
    this.root.scale.set(1, -1, 1);
    const size = Math.max(s.width, s.height);
    this.frameIfFirst(size);
  }

  private framed = 0;
  frameIfFirst(size: number) {
    if (this.framed === size) return;
    this.framed = size;
    this.frame(size);
  }
  frame(size: number) {
    this.camera.position.set(size * 0.45, -size * 1.25, size * 2.05);
    this.controls.target.set(0, 0, -this.thickness * 3);
    this.controls.update();
  }

  snapshot(): string { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

// thin out vertices closer than ~0.35 mm to keep phone GPUs within memory
function thin(c: { x: number; y: number }[]): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const min2 = (0.35 * SCALE) ** 2;
  let lx = Infinity, ly = Infinity;
  for (const p of c) {
    if ((p.x - lx) ** 2 + (p.y - ly) ** 2 < min2) continue;
    out.push(new THREE.Vector2(p.x / SCALE, p.y / SCALE)); lx = p.x; ly = p.y;
  }
  return out;
}

function toShapes(groups: Group[]): THREE.Shape[] {
  const shapes: THREE.Shape[] = [];
  for (const g of groups) {
    const outer = thin(g.outer);
    if (outer.length < 3) continue;
    const sh = new THREE.Shape(outer);
    for (const h of g.holes) { const hh = thin(h); if (hh.length >= 3) sh.holes.push(new THREE.Path(hh)); }
    shapes.push(sh);
  }
  return shapes;
}
