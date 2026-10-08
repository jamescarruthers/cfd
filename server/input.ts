export type Vec3 = [number, number, number]
export type JobSettings = {
  velocity: number
  viscosity: number
  domain: { min: Vec3; max: Vec3 }
  cells: Vec3
  iterations: number
  cores: 2 | 4
  turbulence?: 'kOmegaSST' | 'laminar'
  boundary?: 'external' | 'channel'
}
export type JobInput = { scene: { stl: string; shapes?: unknown[] }; settings: JobSettings }
export type ValidatedInput = JobInput & { triangleCount: number; locationInMesh: Vec3; refinementLevel: number; minimumWall?: number }

export class InputError extends Error {}

function vector(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new InputError(`${name} must contain three finite numbers.`)
  }
  return value as Vec3
}

export function validateInput(value: unknown): ValidatedInput {
  if (!value || typeof value !== 'object') throw new InputError('A scene and settings are required.')
  const candidate = value as Partial<JobInput>
  const settings = candidate.settings
  if (!settings || typeof settings !== 'object') throw new InputError('Simulation settings are required.')
  const min = vector(settings.domain?.min, 'Domain minimum')
  const max = vector(settings.domain?.max, 'Domain maximum')
  const cells = vector(settings.cells, 'Cell counts')
  for (let axis = 0; axis < 3; axis++) {
    if (max[axis] <= min[axis] || max[axis] - min[axis] > 100 || Math.abs(min[axis]) > 1000 || Math.abs(max[axis]) > 1000) {
      throw new InputError('Each domain extent must be positive and no greater than 100 metres.')
    }
    if (!Number.isInteger(cells[axis]) || cells[axis] < 4 || cells[axis] > 128) {
      throw new InputError('Each cell count must be an integer between 4 and 128.')
    }
  }
  if (cells[0] * cells[1] * cells[2] > 150_000) throw new InputError('The initial grid is limited to 150,000 cells.')
  if (!Number.isFinite(settings.velocity) || settings.velocity <= 0 || settings.velocity > 100) {
    throw new InputError('Inlet speed must be greater than zero and at most 100 m/s.')
  }
  if (!Number.isFinite(settings.viscosity) || settings.viscosity < 1e-8 || settings.viscosity > 1) {
    throw new InputError('Kinematic viscosity must be between 1e-8 and 1 m²/s.')
  }
  if (!Number.isInteger(settings.iterations) || settings.iterations < 10 || settings.iterations > 1000) {
    throw new InputError('Solver iterations must be an integer between 10 and 1000.')
  }
  if (settings.cores !== 2 && settings.cores !== 4) throw new InputError('Choose two or four CPU processes.')
  if (settings.turbulence !== undefined && settings.turbulence !== 'laminar' && settings.turbulence !== 'kOmegaSST') {
    throw new InputError('Supported flow models are laminar and kOmegaSST.')
  }
  if (settings.boundary !== undefined && settings.boundary !== 'external' && settings.boundary !== 'channel') {
    throw new InputError('Supported outer boundaries are external and channel.')
  }
  const stl = candidate.scene?.stl ?? ''
  if (typeof stl !== 'string' || Buffer.byteLength(stl, 'utf8') > 8_000_000) throw new InputError('ASCII STL must be no larger than 8 MB.')
  let triangleCount = 0
  let minimumWall: number | undefined
  const shapes = candidate.scene?.shapes
  if (shapes !== undefined) {
    if (!Array.isArray(shapes) || shapes.length > 50) throw new InputError('A scene may contain at most 50 shapes.')
    for (const shape of shapes) {
      if (!shape || typeof shape !== 'object') throw new InputError('Shape metadata must contain valid objects.')
      const metadata = shape as { type?: unknown; wall?: unknown; width?: unknown; size?: unknown }
      if (['pipe', 'elbow', 'tee'].includes(String(metadata.type))) {
        if (typeof metadata.wall !== 'number' || !Number.isFinite(metadata.wall) || metadata.wall <= 0
          || typeof metadata.width !== 'number' || !Number.isFinite(metadata.width) || metadata.width <= metadata.wall * 2) {
          throw new InputError('Pipe metadata requires positive wall thickness smaller than its outside radius.')
        }
        minimumWall = Math.min(minimumWall ?? Infinity, metadata.wall)
      }
    }
  }
  const baseCell = Math.max(...max.map((n, axis) => (n - min[axis]) / cells[axis]))
  const requiredLevel = minimumWall ? Math.max(1, Math.ceil(Math.log2(2 * baseCell / minimumWall))) : 1
  if (requiredLevel > 4) {
    throw new InputError(`Pipe walls are too thin for this grid. Use wall thickness of at least ${(2 * baseCell / 16).toFixed(4)} m, or increase the base grid resolution.`)
  }
  const surfaceBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  if (stl.trim()) {
    if (!/^\s*solid\b/i.test(stl) || !/endsolid\b/i.test(stl)) throw new InputError('Upload an ASCII STL containing a closed solid.')
    const vertices: Vec3[] = []
    const vertexLines = stl.matchAll(/^\s*vertex\s+([^\r\n]+)\s*$/gim)
    for (const line of vertexLines) {
      const parts = line[1].trim().split(/\s+/).map(Number)
      const vertex = vector(parts, 'STL vertex')
      for (let axis = 0; axis < 3; axis++) {
        if (vertex[axis] <= min[axis] || vertex[axis] >= max[axis]) {
          throw new InputError('All solid vertices must lie strictly inside the flow domain. Enlarge the domain around the geometry.')
        }
        surfaceBounds.min[axis] = Math.min(surfaceBounds.min[axis], vertex[axis])
        surfaceBounds.max[axis] = Math.max(surfaceBounds.max[axis], vertex[axis])
      }
      vertices.push(vertex)
      if (vertices.length > 150_000) throw new InputError('The surface is limited to 50,000 triangles.')
    }
    triangleCount = vertices.length / 3
    const facets = [...stl.matchAll(/^\s*facet\s+normal\b/gim)].length
    if (!Number.isInteger(triangleCount) || triangleCount === 0 || triangleCount !== facets) {
      throw new InputError('Each STL triangle must have exactly three vertices.')
    }
    // Use the same tolerant seam welding and manifold/orientation checks as the editor.
    try { validateClosedMesh(vertices.flat()) }
    catch (error) { throw new InputError(error instanceof Error ? error.message : 'Invalid solid geometry.') }
  }
  // Locate a guaranteed external seed before the geometry's bounding box, away from block faces.
  const locationInMesh: Vec3 = min.map((n, axis) => {
    const gap = stl.trim() ? surfaceBounds.min[axis] - n : (max[axis] - n) * 0.25
    return n + gap * 0.5
  }) as Vec3
  return {
    scene: { stl },
    settings: { ...settings, domain: { min: [...min], max: [...max] }, cells: [...cells] },
    triangleCount,
    locationInMesh,
    refinementLevel: requiredLevel,
    minimumWall,
  }
}
import { validateClosedMesh } from '../src/geometry/validation'
