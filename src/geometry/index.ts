import { BoxGeometry, BufferGeometry, Euler, Float32BufferAttribute, Matrix4, SphereGeometry, Vector3 } from 'three';

export type ShapeType = 'pipe' | 'elbow' | 'tee' | 'box' | 'sphere' | 'imported';

/** All lengths are meters. Geometry is local; rotations are XYZ Euler degrees. */
export interface Shape {
  id: string;
  type: ShapeType;
  name: string;
  x: number;
  y: number;
  z: number;
  rotation: [number, number, number];
  size: number;
  width: number;
  wall: number;
  /** Triangulated local positions, in meters, for imported geometry. */
  geometry?: number[];
  /** Dimensions at import; subsequent size/width edits scale the original mesh. */
  importedSize?: number;
  importedWidth?: number;
}

const RADIAL_SEGMENTS = 64;
const BEND_SEGMENTS = 40;
const DEGREES = Math.PI / 180;

export function createShape(type: ShapeType, x = 0, y = 0, z = 0): Shape {
  const names: Record<ShapeType, string> = { pipe: 'Straight pipe', elbow: '90° elbow', tee: 'T union', box: 'Box', sphere: 'Sphere', imported: 'Imported mesh' };
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `shape-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type, name: names[type], x, y, z, rotation: [0, 0, 0],
    size: type === 'box' || type === 'sphere' || type === 'imported' ? 0.3 : 0.8,
    width: type === 'box' || type === 'sphere' || type === 'imported' ? 0.3 : 0.2,
    wall: 0.012,
  };
}

function assertDimensions(shape: Shape): void {
  if (!Number.isFinite(shape.size) || !Number.isFinite(shape.width) || shape.size <= 0 || shape.width <= 0) {
    throw new Error('Geometry dimensions must be finite, positive lengths in meters.');
  }
  if (shape.type === 'pipe' || shape.type === 'elbow' || shape.type === 'tee') {
    if (!Number.isFinite(shape.wall) || shape.wall <= 0 || shape.wall >= shape.width / 2) {
      throw new Error('Pipe wall thickness must be positive and smaller than half the outside diameter.');
    }
    if (shape.size <= shape.width) throw new Error('Pipe length or bend diameter must be larger than its outside diameter.');
  }
}

/** A watertight solid shell, with annular end faces and an open fluid lumen. */
function tubeShell(shape: Shape, bend: boolean): BufferGeometry {
  const outer = shape.width / 2;
  const inner = outer - shape.wall;
  const steps = bend ? BEND_SEGMENTS : 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const bendRadius = shape.size / 2;
  const point = (s: number, j: number, radius: number): Vector3 => {
    const phi = j * Math.PI * 2 / RADIAL_SEGMENTS;
    if (!bend) return new Vector3((s / steps - 0.5) * shape.size, radius * Math.cos(phi), radius * Math.sin(phi));
    const theta = -Math.PI / 2 + s / steps * Math.PI / 2;
    return new Vector3(
      -bendRadius / 2 + (bendRadius + radius * Math.cos(phi)) * Math.cos(theta),
      bendRadius / 2 + (bendRadius + radius * Math.cos(phi)) * Math.sin(theta),
      radius * Math.sin(phi),
    );
  };
  for (const radius of [outer, inner]) {
    for (let s = 0; s <= steps; s++) {
      for (let j = 0; j < RADIAL_SEGMENTS; j++) positions.push(...point(s, j, radius).toArray());
    }
  }
  const layerLength = (steps + 1) * RADIAL_SEGMENTS;
  const at = (layer: number, s: number, j: number) => layer * layerLength + s * RADIAL_SEGMENTS + (j % RADIAL_SEGMENTS);
  // Compare each face with the known outward direction; this also handles the bend's changing frame.
  const face = (a: number, b: number, c: number, d: number, normal: Vector3) => {
    const va = new Vector3().fromArray(positions, a * 3);
    const vb = new Vector3().fromArray(positions, b * 3);
    const vc = new Vector3().fromArray(positions, c * 3);
    const cross = vb.sub(va).cross(vc.sub(va));
    if (cross.dot(normal) > 0) indices.push(a, b, c, a, c, d);
    else indices.push(a, c, b, a, d, c);
  };
  for (let layer = 0; layer < 2; layer++) {
    for (let s = 0; s < steps; s++) {
      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const phi = (j + 0.5) * Math.PI * 2 / RADIAL_SEGMENTS;
        const theta = -Math.PI / 2 + (s + 0.5) / steps * Math.PI / 2;
        const n = bend
          ? new Vector3(Math.cos(phi) * Math.cos(theta), Math.cos(phi) * Math.sin(theta), Math.sin(phi))
          : new Vector3(0, Math.cos(phi), Math.sin(phi));
        if (layer === 1) n.negate();
        face(at(layer, s, j), at(layer, s, j + 1), at(layer, s + 1, j + 1), at(layer, s + 1, j), n);
      }
    }
  }
  for (const s of [0, steps]) {
    const n = bend ? (s === 0 ? new Vector3(-1, 0, 0) : new Vector3(0, 1, 0)) : new Vector3(s === 0 ? -1 : 1, 0, 0);
    for (let j = 0; j < RADIAL_SEGMENTS; j++) face(at(0, s, j), at(1, s, j), at(1, s, j + 1), at(0, s, j + 1), n);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function teeGeometry(shape: Shape): BufferGeometry {
  // The intersection of two equal perpendicular cylinders is y = |x| on the
  // +Y branch. Parameterizing that curve directly avoids CSG T-junctions and
  // preserves a conforming closed triangulation for downstream volume meshing.
  const outer = shape.width / 2;
  const inner = outer - shape.wall;
  const half = shape.size / 2;
  const positions: number[] = [];
  const addQuad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3, outward: Vector3) => {
    const positive = b.clone().sub(a).cross(c.clone().sub(a)).dot(outward) > 0;
    for (const vertex of positive ? [a, b, c, a, c, d] : [a, c, b, a, d, c]) positions.push(vertex.x, vertex.y, vertex.z);
  };
  const angular = (j: number) => j % RADIAL_SEGMENTS * Math.PI * 2 / RADIAL_SEGMENTS;
  const horizontal = (radius: number, j: number, end: 'left' | 'right' | 'leftSeam' | 'rightSeam') => {
    const theta = angular(j);
    const y = radius * Math.cos(theta), z = radius * Math.sin(theta);
    const x = end === 'left' ? -half : end === 'right' ? half : (end === 'leftSeam' ? -1 : 1) * Math.max(y, 0);
    return new Vector3(x, y, z);
  };
  const branch = (radius: number, j: number, end: boolean) => {
    const theta = angular(j);
    const x = radius * Math.cos(theta), z = radius * Math.sin(theta);
    return new Vector3(x, end ? half : Math.abs(x), z);
  };
  for (const [radius, direction] of [[outer, 1], [inner, -1]]) {
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const theta = (j + 0.5) * Math.PI * 2 / RADIAL_SEGMENTS;
      const horizontalNormal = new Vector3(0, Math.cos(theta) * direction, Math.sin(theta) * direction);
      addQuad(horizontal(radius, j, 'left'), horizontal(radius, j + 1, 'left'), horizontal(radius, j + 1, 'leftSeam'), horizontal(radius, j, 'leftSeam'), horizontalNormal);
      addQuad(horizontal(radius, j, 'rightSeam'), horizontal(radius, j + 1, 'rightSeam'), horizontal(radius, j + 1, 'right'), horizontal(radius, j, 'right'), horizontalNormal);
      addQuad(branch(radius, j, false), branch(radius, j + 1, false), branch(radius, j + 1, true), branch(radius, j, true), new Vector3(Math.cos(theta) * direction, 0, Math.sin(theta) * direction));
    }
  }
  for (let j = 0; j < RADIAL_SEGMENTS; j++) {
    for (const end of ['left', 'right'] as const) {
      addQuad(horizontal(outer, j, end), horizontal(inner, j, end), horizontal(inner, j + 1, end), horizontal(outer, j + 1, end), new Vector3(end === 'left' ? -1 : 1, 0, 0));
    }
    addQuad(branch(outer, j, true), branch(inner, j, true), branch(inner, j + 1, true), branch(outer, j + 1, true), new Vector3(0, 1, 0));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

/** Returns local geometry. Apply shapeTransform before exporting or solving. */
export function createShapeGeometry(shape: Shape): BufferGeometry {
  assertDimensions(shape);
  switch (shape.type) {
    case 'pipe': return tubeShell(shape, false);
    case 'elbow': return tubeShell(shape, true);
    case 'tee': return teeGeometry(shape);
    case 'box': return new BoxGeometry(shape.size, shape.width, shape.width);
    case 'sphere': return new SphereGeometry(shape.size / 2, 48, 32);
    case 'imported': {
      if (!shape.geometry?.length || shape.geometry.length % 9 !== 0) throw new Error('Imported geometry must contain complete triangles.');
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(shape.geometry, 3));
      const horizontal = shape.size / (shape.importedSize ?? shape.size);
      const transverse = shape.width / (shape.importedWidth ?? shape.width);
      geometry.scale(horizontal, transverse, transverse);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      return geometry;
    }
  }
}

export function shapeTransform(shape: Shape): Matrix4 {
  if (![shape.x, shape.y, shape.z, ...shape.rotation].every(Number.isFinite)) throw new Error('Shape positions and rotations must be finite numbers.');
  return new Matrix4().makeRotationFromEuler(new Euler(...shape.rotation.map(value => value * DEGREES) as [number, number, number], 'XYZ')).setPosition(shape.x, shape.y, shape.z);
}

/** World-space triangle positions suitable for meshing and geometry checks. */
export function sceneTriangles(shapes: Shape[]): number[] {
  const triangles: number[] = [];
  for (const shape of shapes) {
    const geometry = createShapeGeometry(shape);
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const transform = shapeTransform(shape);
    const vertex = new Vector3();
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(transform);
      triangles.push(vertex.x, vertex.y, vertex.z);
    }
    geometry.dispose();
  }
  return triangles;
}

/** ASCII STL in meters. Each object remains a closed solid; overlapping objects are not fused. */
export function exportSceneSTL(shapes: Shape[]): string {
  const vertices = sceneTriangles(shapes);
  const output = ['solid flow_studio'];
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  const normal = new Vector3(), edge = new Vector3();
  for (let i = 0; i < vertices.length; i += 9) {
    a.fromArray(vertices, i); b.fromArray(vertices, i + 3); c.fromArray(vertices, i + 6);
    normal.subVectors(b, a).cross(edge.subVectors(c, a)).normalize();
    output.push(`  facet normal ${normal.x} ${normal.y} ${normal.z}`, '    outer loop', `      vertex ${a.x} ${a.y} ${a.z}`, `      vertex ${b.x} ${b.y} ${b.z}`, `      vertex ${c.x} ${c.y} ${c.z}`, '    endloop', '  endfacet');
  }
  output.push('endsolid flow_studio');
  return output.join('\n');
}

export { importGeometry, parseObj, parseStl } from './import';
export { validateClosedMesh } from './validation';
export type { MeshValidation } from './validation';
