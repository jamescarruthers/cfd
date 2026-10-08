import { Box3, Vector3 } from 'three';

export interface MeshValidation {
  triangleCount: number;
  vertexCount: number;
  volume: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Verify a triangle soup is a closed, oriented two-manifold before using it for CFD. */
export function validateClosedMesh(positions: readonly number[]): MeshValidation {
  if (!positions.length || positions.length % 9 !== 0) throw new Error('A mesh must contain complete triangles.');
  if (!positions.every(Number.isFinite)) throw new Error('Mesh vertices must contain finite coordinates.');
  const bounds = new Box3();
  const point = new Vector3();
  for (let i = 0; i < positions.length; i += 3) bounds.expandByPoint(point.fromArray(positions, i));
  const diagonal = bounds.min.distanceTo(bounds.max);
  if (diagonal <= 0) throw new Error('The mesh has no spatial extent.');
  const tolerance = Math.max(diagonal * 1e-7, 1e-12);
  const toleranceSquared = tolerance * tolerance;
  const cells = new Map<string, number[]>();
  const vertices: Vector3[] = [];
  const vertexIds: number[] = [];
  // Search neighboring cells, rather than rounding alone, to weld STL/CSG seams reliably.
  for (let i = 0; i < positions.length; i += 3) {
    point.fromArray(positions, i);
    const cell = [Math.floor(point.x / tolerance), Math.floor(point.y / tolerance), Math.floor(point.z / tolerance)];
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const id of cells.get(`${cell[0] + dx},${cell[1] + dy},${cell[2] + dz}`) ?? []) {
        if (vertices[id].distanceToSquared(point) <= toleranceSquared) { found = id; break search; }
      }
    }
    if (found < 0) {
      found = vertices.length;
      vertices.push(point.clone());
      const key = cell.join(',');
      const ids = cells.get(key) ?? [];
      ids.push(found);
      cells.set(key, ids);
    }
    vertexIds.push(found);
  }
  const edges = new Map<string, { count: number; orientation: number; faces: number[] }>();
  const faces = new Set<string>();
  const vertexFaces: number[][] = vertices.map(() => []);
  const faceNeighbors: number[][] = [];
  const ab = new Vector3(), ac = new Vector3(), normal = new Vector3();
  const center = bounds.getCenter(new Vector3());
  let volume = 0;
  for (let i = 0; i < vertexIds.length; i += 3) {
    const faceId = i / 3;
    faceNeighbors.push([]);
    const ids = vertexIds.slice(i, i + 3);
    const [a, b, c] = ids.map(id => vertices[id]);
    if (new Set(ids).size !== 3 || normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).lengthSq() <= toleranceSquared * toleranceSquared) {
      throw new Error(`Mesh triangle ${i / 3 + 1} is degenerate. Remove collapsed or zero-area faces before importing.`);
    }
    const faceKey = [...ids].sort((x, y) => x - y).join(',');
    if (faces.has(faceKey)) throw new Error('The mesh contains duplicate faces. Remove duplicates before importing.');
    faces.add(faceKey);
    for (const id of ids) vertexFaces[id].push(faceId);
    for (let j = 0; j < 3; j++) {
      const start = ids[j], end = ids[(j + 1) % 3];
      const key = start < end ? `${start},${end}` : `${end},${start}`;
      const edge = edges.get(key) ?? { count: 0, orientation: 0, faces: [] };
      edge.count++;
      edge.orientation += start < end ? 1 : -1;
      edge.faces.push(faceId);
      edges.set(key, edge);
    }
    // Shift to the bounding-box center to reduce cancellation for far-from-origin imports.
    const shiftedA = a.clone().sub(center), shiftedB = b.clone().sub(center), shiftedC = c.clone().sub(center);
    volume += shiftedA.dot(shiftedB.cross(shiftedC)) / 6;
  }
  let open = 0, nonManifold = 0, winding = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) open++;
    else if (edge.count !== 2) nonManifold++;
    else {
      if (edge.orientation !== 0) winding++;
      faceNeighbors[edge.faces[0]].push(edge.faces[1]);
      faceNeighbors[edge.faces[1]].push(edge.faces[0]);
    }
  }
  if (open) throw new Error(`The mesh is open (${open} boundary edges). CFD requires a watertight solid; repair or cap the mesh before importing.`);
  if (nonManifold) throw new Error(`The mesh has ${nonManifold} non-manifold edges. Repair overlapping or branching faces before importing.`);
  if (winding) throw new Error(`The mesh has ${winding} inconsistently oriented edges. Recalculate outward face normals before importing.`);
  // Closed edge pairs alone miss solids that touch at a single bow-tie vertex.
  for (const incident of vertexFaces) {
    const allowed = new Set(incident);
    const visited = new Set<number>();
    const pending = [incident[0]];
    while (pending.length) {
      const face = pending.pop()!;
      if (visited.has(face)) continue;
      visited.add(face);
      for (const neighbor of faceNeighbors[face]) if (allowed.has(neighbor) && !visited.has(neighbor)) pending.push(neighbor);
    }
    if (visited.size !== incident.length) throw new Error('The mesh has non-manifold vertices where separate surfaces touch. Separate or join those solids before importing.');
  }
  if (Math.abs(volume) <= diagonal ** 3 * 1e-12) throw new Error('The closed mesh encloses no measurable volume. Check for collapsed or intersecting surfaces.');
  return {
    triangleCount: positions.length / 9,
    vertexCount: vertices.length,
    volume,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  };
}
