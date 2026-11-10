// Editor overlays drawn over the finished image: selection frame, transform guides, the
// brush cursor and the construction plane. Thin lines in the interface's ink and accent.
import * as THREE from 'three/webgpu';
import type { App } from '../app/App';
import { apertureOutline } from '../scene/meshes';
import type { Tools } from './Tools';

const INK = 0x1d1b18;
const ACCENT = 0xb86a1c;

function lineMaterial(color: number, opacity = 1): THREE.LineBasicNodeMaterial {
  const m = new THREE.LineBasicNodeMaterial({ color, transparent: opacity < 1, opacity });
  m.depthTest = false;
  m.depthWrite = false;
  return m;
}

function circle(segments = 48): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i <= segments; i++) { const a = (i / segments) * Math.PI * 2; pts.push(Math.cos(a), 0, Math.sin(a)); }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
}

export interface Cursor { point: THREE.Vector3; normal: THREE.Vector3; radius: number; drop: boolean }

export class Overlay {
  private readonly box: THREE.LineSegments;
  private readonly ring: THREE.Line;
  private readonly axes: THREE.LineSegments;
  private readonly outline: THREE.Line;
  private readonly brush: THREE.Line;
  private readonly drop: THREE.Line;
  private readonly grid: THREE.LineSegments;
  private readonly path: THREE.Line;
  private current: Cursor | null = null;
  private gridKey = '';

  constructor(private readonly app: App) {
    const s = app.overlay;
    this.box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMaterial(ACCENT));
    this.box.matrixAutoUpdate = false;
    this.ring = new THREE.Line(circle(), lineMaterial(INK, 0.55));
    this.axes = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    ], 3)), lineMaterial(INK, 0.55));
    this.outline = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(15), 3)), lineMaterial(ACCENT));
    this.brush = new THREE.Line(circle(32), lineMaterial(ACCENT));
    this.drop = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3)), lineMaterial(ACCENT, 0.6));
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial(INK, 0.22));
    this.path = new THREE.Line(new THREE.BufferGeometry(), lineMaterial(ACCENT, 0.8));
    for (const o of [this.box, this.ring, this.axes, this.outline, this.brush, this.drop, this.grid, this.path]) {
      o.visible = false;
      o.frustumCulled = false;
      o.renderOrder = 10;
      s.add(o);
    }
  }

  cursor(c: Cursor | null) { this.current = c; }

  update(tools: Tools) {
    const { doc, runtime } = this.app;
    const sel = doc.selection;
    const entry = sel.type === 'object' ? runtime.entries.get(sel.id) : undefined;
    const editing = tools.mode === 'select' || tools.mode === 'paint';

    // Selection frame around the object's own bounds.
    this.box.visible = !!entry && entry.mesh.visible;
    this.ring.visible = this.axes.visible = this.box.visible && tools.mode === 'select';
    this.path.visible = false;
    if (entry && this.box.visible) {
      const g = entry.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox!;
      const size = bb.getSize(new THREE.Vector3()).addScalar(0.012), centre = bb.getCenter(new THREE.Vector3());
      entry.mesh.updateMatrixWorld();
      this.box.matrix.copy(entry.mesh.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z)).scale(size);
      this.box.matrixWorldNeedsUpdate = true;
      const p = entry.mesh.position;
      const r = Math.max(size.x, size.z) * 0.5 + 0.12;
      // Guides: ground cross for moving, a ring for turning, a vertical for lifting and scaling.
      this.ring.position.copy(p);
      this.ring.scale.setScalar(r);
      this.ring.visible &&= tools.transform === 'rotate';
      this.axes.position.copy(p);
      this.axes.scale.set(r, tools.transform === 'rotate' ? 0 : 0.5, r);
      this.axes.visible &&= tools.transform !== 'rotate';
      // A recorded motion path, drawn from the object's rest position.
      const o = doc.selectedObject;
      const m = o?.motions.find((x) => x.kind === 'path' && x.path && x.path.length > 1);
      if (o && m && editing) {
        const pts = m.path!.flatMap((q) => [o.position[0] + q[0] * m.amplitude, o.position[1] + q[1] * m.amplitude, o.position[2] + q[2] * m.amplitude]);
        this.path.geometry.dispose();
        this.path.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        this.path.visible = true;
      }
    }

    // Selected opening.
    const ap = doc.selectedAperture;
    this.outline.visible = !!ap;
    if (ap) {
      const pts = apertureOutline(doc.scene.room, ap);
      const attr = this.outline.geometry.attributes.position as THREE.BufferAttribute;
      pts.forEach((q, i) => attr.setXYZ(i, q[0], q[1], q[2]));
      attr.needsUpdate = true;
    }

    // Brush cursor.
    const c = this.current;
    this.brush.visible = !!c;
    this.drop.visible = !!c && c.drop;
    if (c) {
      this.brush.position.copy(c.point).addScaledVector(c.normal, 0.004);
      this.brush.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.normal);
      this.brush.scale.setScalar(Math.max(c.radius, 0.012));
      if (c.drop) {
        const attr = this.drop.geometry.attributes.position as THREE.BufferAttribute;
        attr.setXYZ(0, c.point.x, c.point.y, c.point.z);
        attr.setXYZ(1, c.point.x, 0, c.point.z);
        attr.needsUpdate = true;
      }
    }

    // Construction plane: a level grid at the brush elevation.
    const level = tools.mode === 'paint' && tools.brush.target === 'level';
    this.grid.visible = level;
    if (level) {
      const [w, , d] = doc.scene.room.size;
      const key = `${w},${d}`;
      if (key !== this.gridKey) {
        this.gridKey = key;
        const pts: number[] = [];
        for (let x = -Math.floor(w / 2 / 0.5) * 0.5; x <= w / 2; x += 0.5) pts.push(x, 0, -d / 2, x, 0, d / 2);
        for (let z = -Math.floor(d / 2 / 0.5) * 0.5; z <= d / 2; z += 0.5) pts.push(-w / 2, 0, z, w / 2, 0, z);
        this.grid.geometry.dispose();
        this.grid.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      }
      this.grid.position.y = tools.brush.elevation;
    }
  }
}
