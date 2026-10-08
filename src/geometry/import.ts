import { Vector2, Vector3 } from 'three';
import { createShape, type Shape } from './index';
import { validateClosedMesh } from './validation';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_VERTICES = 100_000;
const MAX_FACE_VERTICES = 2_048;
const MAX_TRIANGLES = 100_000;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function numeric(value: string, context: string): number {
  if (!NUMBER.test(value) || !Number.isFinite(Number(value))) throw new Error(`Invalid ${context}: expected a finite number.`);
  return Number(value);
}

function normalize(positions: number[], name: string): Shape[] {
  const validation = validateClosedMesh(positions);
  const { min, max } = validation.bounds;
  const dimensions = max.map((value, i) => value - min[i]);
  const scale = 0.5 / Math.max(...dimensions);
  const center = max.map((value, i) => (value + min[i]) / 2);
  const output = positions.map((value, i) => (value - center[i % 3]) * scale);
  // Globally reversed, but consistent, winding is safe to repair without changing topology.
  if (validation.volume < 0) {
    for (let i = 0; i < output.length; i += 9) {
      for (let j = 0; j < 3; j++) [output[i + 3 + j], output[i + 6 + j]] = [output[i + 6 + j], output[i + 3 + j]];
    }
  }
  const shape = createShape('imported');
  shape.name = name;
  shape.size = dimensions[0] * scale;
  shape.width = Math.max(dimensions[1], dimensions[2]) * scale;
  shape.importedSize = shape.size;
  shape.importedWidth = shape.width;
  shape.geometry = output;
  return [shape];
}

/** Triangulate a planar OBJ n-gon by ear clipping; concave openings are preserved. */
function triangulateFace(indices: number[], vertices: Vector3[], line: number): number[][] {
  if (indices.length === 3) return [indices];
  const normal = new Vector3();
  for (let i = 0; i < indices.length; i++) {
    const a = vertices[indices[i]], b = vertices[indices[(i + 1) % indices.length]];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  if (normal.lengthSq() === 0) throw new Error(`OBJ face on line ${line} has no area.`);
  const n = normal.clone().normalize();
  const origin = vertices[indices[0]];
  const extent = Math.max(...indices.map(id => vertices[id].distanceTo(origin)));
  if (indices.some(id => Math.abs(vertices[id].clone().sub(origin).dot(n)) > Math.max(1e-9, extent * 1e-5))) {
    throw new Error(`OBJ face on line ${line} is not planar. Triangulate the mesh in your modeling application before importing.`);
  }
  const axis = Math.abs(normal.x) >= Math.abs(normal.y) && Math.abs(normal.x) >= Math.abs(normal.z) ? 0 : Math.abs(normal.y) >= Math.abs(normal.z) ? 1 : 2;
  const points = indices.map(id => {
    const v = vertices[id];
    return axis === 0 ? new Vector2(v.y, v.z) : axis === 1 ? new Vector2(v.z, v.x) : new Vector2(v.x, v.y);
  });
  const cross = (a: Vector2, b: Vector2, c: Vector2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) signedArea += points[i].cross(points[(i + 1) % points.length]);
  const direction = signedArea >= 0 ? 1 : -1;
  const epsilon = extent * extent * 1e-12;
  const active = points.map((_, i) => i);
  const triangles: number[][] = [];
  while (active.length > 3) {
    let clipped = false;
    for (let j = 0; j < active.length; j++) {
      const a = active[(j + active.length - 1) % active.length], b = active[j], c = active[(j + 1) % active.length];
      if (cross(points[a], points[b], points[c]) * direction <= epsilon) continue;
      const occupied = active.some(p => p !== a && p !== b && p !== c &&
        cross(points[a], points[b], points[p]) * direction >= -epsilon &&
        cross(points[b], points[c], points[p]) * direction >= -epsilon &&
        cross(points[c], points[a], points[p]) * direction >= -epsilon);
      if (occupied) continue;
      triangles.push([indices[a], indices[b], indices[c]]);
      active.splice(j, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error(`OBJ face on line ${line} cannot be triangulated. Remove self-intersections or triangulate the source mesh.`);
  }
  triangles.push(active.map(i => indices[i]));
  return triangles;
}

export function parseObj(source: string, name = 'Imported OBJ'): Shape[] {
  if (new TextEncoder().encode(source).byteLength > MAX_BYTES) throw new Error('Geometry files must be 10 MB or smaller.');
  const vertices: Vector3[] = [];
  const positions: number[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v') {
      if (parts.length < 4) throw new Error(`OBJ vertex on line ${i + 1} needs x, y, and z coordinates.`);
      if (vertices.length >= MAX_VERTICES) throw new Error('Geometry may contain at most 100,000 vertices.');
      const point = new Vector3(...parts.slice(1, 4).map(value => numeric(value, `OBJ vertex on line ${i + 1}`)) as [number, number, number]);
      if (parts.length === 5) {
        const weight = numeric(parts[4], `OBJ vertex weight on line ${i + 1}`);
        if (weight === 0) throw new Error(`OBJ vertex weight on line ${i + 1} cannot be zero.`);
        point.divideScalar(weight);
      }
      vertices.push(point);
    } else if (parts[0] === 'f') {
      if (parts.length < 4) throw new Error(`OBJ face on line ${i + 1} needs at least three vertices.`);
      if (parts.length - 1 > MAX_FACE_VERTICES) throw new Error('OBJ faces may have at most 2,048 vertices. Triangulate larger polygons before importing.');
      const indices = parts.slice(1).map(token => {
        const raw = token.split('/')[0];
        if (!/^-?\d+$/.test(raw)) throw new Error(`Invalid OBJ face index on line ${i + 1}.`);
        const index = Number(raw);
        const resolved = index < 0 ? vertices.length + index : index - 1;
        if (index === 0 || !Number.isSafeInteger(index) || resolved < 0 || resolved >= vertices.length) throw new Error(`OBJ face on line ${i + 1} refers to a missing vertex.`);
        return resolved;
      });
      for (const triangle of triangulateFace(indices, vertices, i + 1)) {
        if (positions.length / 9 >= MAX_TRIANGLES) throw new Error('Geometry may contain at most 100,000 triangles.');
        for (const index of triangle) positions.push(...vertices[index].toArray());
      }
    }
  }
  if (!positions.length) throw new Error('The OBJ contains no faces. Export a closed, triangulated 3D solid.');
  return normalize(positions, name);
}

function asciiStl(source: string): number[] {
  if (!/^\s*solid(?:\s|$)/i.test(source)) throw new Error('Unrecognized STL file. Use a standard ASCII or binary STL export.');
  const positions: number[] = [];
  let inFacet = false;
  let inLoop = false;
  let facetVertices = 0;
  let hasEnd = false;
  for (const [lineIndex, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const keyword = parts[0].toLowerCase();
    if (keyword === 'solid') continue;
    if (keyword === 'facet') {
      if (inFacet) throw new Error(`Malformed STL: nested facet on line ${lineIndex + 1}.`);
      inFacet = true; facetVertices = 0;
    } else if (keyword === 'outer') {
      if (!inFacet || inLoop || parts[1]?.toLowerCase() !== 'loop') throw new Error(`Malformed STL loop on line ${lineIndex + 1}.`);
      inLoop = true;
    } else if (keyword === 'vertex') {
      if (!inFacet || !inLoop || parts.length !== 4 || facetVertices >= 3) throw new Error(`Malformed STL vertex on line ${lineIndex + 1}.`);
      if (positions.length / 3 >= MAX_VERTICES) throw new Error('STL files may contain at most 100,000 triangle vertices.');
      positions.push(...parts.slice(1).map(value => numeric(value, `STL vertex on line ${lineIndex + 1}`)));
      facetVertices++;
    } else if (keyword === 'endloop') {
      if (!inLoop || facetVertices !== 3) throw new Error(`STL facet on line ${lineIndex + 1} must contain exactly three vertices.`);
      inLoop = false;
    } else if (keyword === 'endfacet') {
      if (!inFacet || inLoop || facetVertices !== 3) throw new Error(`Malformed STL facet on line ${lineIndex + 1}.`);
      inFacet = false;
    } else if (keyword === 'endsolid') {
      if (inFacet || inLoop) throw new Error('STL ends inside a facet.');
      hasEnd = true;
    } else throw new Error(`Unrecognized STL content on line ${lineIndex + 1}.`);
  }
  if (!positions.length || inFacet || inLoop || !hasEnd) throw new Error('The ASCII STL is empty or incomplete.');
  return positions;
}

export function parseStl(source: ArrayBuffer | string, name = 'Imported STL'): Shape[] {
  if (typeof source === 'string') {
    if (new TextEncoder().encode(source).byteLength > MAX_BYTES) throw new Error('Geometry files must be 10 MB or smaller.');
    return normalize(asciiStl(source), name);
  }
  if (source.byteLength > MAX_BYTES) throw new Error('Geometry files must be 10 MB or smaller.');
  if (source.byteLength >= 84) {
    const view = new DataView(source);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === source.byteLength) {
      if (!count) throw new Error('The binary STL contains no triangles.');
      if (count * 3 > MAX_VERTICES) throw new Error('STL files may contain at most 100,000 triangle vertices.');
      const positions: number[] = [];
      for (let i = 0; i < count; i++) {
        const start = 84 + i * 50 + 12;
        for (let j = 0; j < 9; j++) {
          const value = view.getFloat32(start + j * 4, true);
          if (!Number.isFinite(value)) throw new Error(`Binary STL triangle ${i + 1} contains a non-finite coordinate.`);
          positions.push(value);
        }
      }
      return normalize(positions, name);
    }
  }
  const text = new TextDecoder('utf-8', { fatal: true });
  try {
    return normalize(asciiStl(text.decode(source)), name);
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Binary STL length does not match its triangle count. The file is truncated or malformed.');
    throw error;
  }
}

export async function importGeometry(file: File): Promise<Shape[]> {
  if (file.size > MAX_BYTES) throw new Error('Geometry files must be 10 MB or smaller.');
  const extension = file.name.split('.').pop()?.toLowerCase();
  const name = file.name.replace(/\.[^.]+$/, '');
  if (extension === 'obj') return parseObj(await file.text(), name);
  if (extension === 'stl') return parseStl(await file.arrayBuffer(), name);
  throw new Error('Import a closed 3D solid as an OBJ or STL file. SVG is a 2D format and cannot define a CFD solid.');
}
