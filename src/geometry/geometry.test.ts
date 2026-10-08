import { describe, expect, it } from 'vitest';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { createShape, createShapeGeometry, exportSceneSTL, parseObj, parseStl, sceneTriangles, validateClosedMesh } from './index';

function intersections(type: 'pipe' | 'tee', origin: Vector3, direction: Vector3, far = 3): number {
  const geometry = createShapeGeometry(createShape(type));
  const material = new MeshBasicMaterial({ side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.updateMatrixWorld(true);
  const count = new Raycaster(origin, direction, 0, far).intersectObject(mesh).length;
  geometry.dispose(); material.dispose();
  return count;
}

const cubeObj = `v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 4 8 7 3
f 1 5 8 4
f 2 3 7 6`;

describe('physical 3D pipe geometry', () => {
  it('creates a closed material shell with an open straight lumen', () => {
    const shape = createShape('pipe');
    const validation = validateClosedMesh(sceneTriangles([shape]));
    const expectedVolume = Math.PI * ((shape.width / 2) ** 2 - (shape.width / 2 - shape.wall) ** 2) * shape.size;
    expect(validation.volume).toBeGreaterThan(0);
    expect(validation.volume / expectedVolume).toBeCloseTo(1, 2);
    expect(validation.bounds.min[0]).toBeCloseTo(-0.4);
    expect(validation.bounds.max[0]).toBeCloseTo(0.4);
    expect(intersections('pipe', new Vector3(-1, 0, 0), new Vector3(1, 0, 0))).toBe(0);
    expect(intersections('pipe', new Vector3(-1, 0.095, 0), new Vector3(1, 0, 0))).toBeGreaterThan(0);
  });

  it('creates a watertight annular bend with correct material volume', () => {
    const shape = createShape('elbow');
    const validation = validateClosedMesh(sceneTriangles([shape]));
    const area = Math.PI * ((shape.width / 2) ** 2 - (shape.width / 2 - shape.wall) ** 2);
    expect(validation.volume / (area * Math.PI * shape.size / 4)).toBeCloseTo(1, 2);
    expect(validation.bounds.max[2]).toBeCloseTo(0.1);
    expect(validation.bounds.min[2]).toBeCloseTo(-0.1);
  });

  it('connects the tee lumens while retaining solid walls', () => {
    const validation = validateClosedMesh(sceneTriangles([createShape('tee')]));
    expect(validation.volume).toBeGreaterThan(0);
    expect(intersections('tee', new Vector3(-1, 0, 0), new Vector3(1, 0, 0))).toBe(0);
    expect(intersections('tee', new Vector3(0, 0, 0), new Vector3(0, 1, 0))).toBe(0);
    expect(intersections('tee', new Vector3(-1, 0, 0.095), new Vector3(1, 0, 0))).toBeGreaterThan(0);
  });

  it('applies XYZ rotation and world translation to STL triangles', () => {
    const shape = createShape('pipe', 0.2, -0.1, 0.3);
    shape.rotation = [0, 0, 90];
    const bounds = validateClosedMesh(sceneTriangles([shape])).bounds;
    expect(bounds.min[0]).toBeCloseTo(0.1);
    expect(bounds.max[0]).toBeCloseTo(0.3);
    expect(bounds.min[1]).toBeCloseTo(-0.5);
    expect(bounds.max[1]).toBeCloseTo(0.3);
    expect(exportSceneSTL([shape])).toContain('facet normal');
  });
});

describe('closed 3D import', () => {
  it('triangulates OBJ quads and scales a solid to half a meter', () => {
    const [shape] = parseObj(cubeObj);
    expect(shape.geometry).toHaveLength(12 * 9);
    expect(shape.size).toBeCloseTo(0.5);
    expect(shape.width).toBeCloseTo(0.5);
    expect(validateClosedMesh(shape.geometry!).volume).toBeCloseTo(0.125);
  });

  it('supports negative OBJ indices', () => {
    const obj = cubeObj.replace('f 2 3 7 6', 'f -7 -6 -2 -3');
    expect(parseObj(obj)).toHaveLength(1);
  });

  it('preserves a concave OBJ solid instead of filling its notch', () => {
    const outline = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const lines = [-0.5, 0.5].flatMap(z => outline.map(([x, y]) => `v ${x} ${y} ${z}`));
    lines.push('f 6 5 4 3 2 1', 'f 7 8 9 10 11 12');
    for (let i = 0; i < 6; i++) {
      const a = i + 1, b = (i + 1) % 6 + 1;
      lines.push(`f ${a} ${b} ${b + 6} ${a + 6}`);
    }
    const [shape] = parseObj(lines.join('\n'));
    expect(validateClosedMesh(shape.geometry!).volume).toBeCloseTo(3 / 64);
    const geometry = createShapeGeometry(shape);
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const mesh = new Mesh(geometry, material);
    mesh.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(0.1875, 0.1875, 1), new Vector3(0, 0, -1));
    expect(ray.intersectObject(mesh)).toHaveLength(0);
    geometry.dispose(); material.dispose();
  });

  it('round trips real 3D ASCII STL', () => {
    const [shape] = parseStl(exportSceneSTL([createShape('pipe')]));
    expect(validateClosedMesh(shape.geometry!).volume).toBeGreaterThan(0);
    expect(shape.size).toBeCloseTo(0.5);
    expect(shape.width).toBeCloseTo(0.125);
  });

  it('parses binary STL even when the header begins with solid', () => {
    const positions = sceneTriangles([createShape('box')]);
    const buffer = new ArrayBuffer(84 + positions.length / 9 * 50);
    const view = new DataView(buffer);
    new Uint8Array(buffer).set(new TextEncoder().encode('solid binary STL'));
    view.setUint32(80, positions.length / 9, true);
    for (let i = 0; i < positions.length / 9; i++) for (let j = 0; j < 9; j++) view.setFloat32(84 + i * 50 + 12 + j * 4, positions[i * 9 + j], true);
    expect(parseStl(buffer)).toHaveLength(1);
  });

  it('rejects open and malformed meshes rather than silently filling them', () => {
    expect(() => parseObj(cubeObj.replace('f 2 3 7 6', ''))).toThrow(/watertight/);
    expect(() => parseObj(cubeObj.replace('f 2 3 7 6', 'f 2 3 7 900'))).toThrow(/missing vertex/);
    expect(() => parseStl('solid empty\nendsolid empty')).toThrow(/empty/);
    expect(() => createShapeGeometry({ ...createShape('pipe'), wall: 0.1 })).toThrow(/wall thickness/);
  });

  it('rejects two otherwise closed solids that share a non-manifold vertex', () => {
    const first = createShape('box');
    const second = createShape('box', 0.3, 0.3, 0.3);
    expect(() => validateClosedMesh(sceneTriangles([first, second]))).toThrow(/non-manifold vertices/);
  });
});
