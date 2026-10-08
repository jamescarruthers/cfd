import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

function meshList(text: string): { count: number; values: number[] } {
  const content = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/FoamFile\s*\{[^}]*\}/, '').trim()
  const list = /^(\d+)\s*\(/.exec(content)
  if (!list) throw new Error('Unsupported ASCII polyMesh list.')
  const count = Number(list[1])
  if (count > 8_000_000) throw new Error('Mesh list exceeds the supported result size.')
  const values = (content.slice(list[0].length).match(NUMBER) ?? []).map(Number)
  if (values.some((n) => !Number.isFinite(n))) throw new Error('The mesh contains non-finite coordinates.')
  return { count, values }
}

/** Exact volume centroids via oriented tetrahedra, avoiding runtime function-object compilation. */
export function cellCentresFromMesh(pointsText: string, facesText: string, ownerText: string, neighbourText: string): number[] {
  const points = meshList(pointsText)
  const faces = meshList(facesText)
  const owner = meshList(ownerText)
  const neighbour = meshList(neighbourText)
  if (points.values.length !== points.count * 3 || owner.values.length !== faces.count || owner.count !== faces.count || neighbour.values.length !== neighbour.count) {
    throw new Error('Inconsistent polyMesh topology.')
  }
  let count = 0
  for (const label of owner.values) count = Math.max(count, label + 1)
  for (const label of neighbour.values) count = Math.max(count, label + 1)
  const volume = new Float64Array(count)
  const moments = new Float64Array(count * 3)
  // A local reference reduces cancellation for models placed far from world origin.
  const reference = points.values.slice(0, 3)
  let offset = 0
  const accumulate = (cell: number, signedVolume: number, a: number, b: number, c: number) => {
    volume[cell] += signedVolume
    for (let axis = 0; axis < 3; axis++) moments[cell * 3 + axis] += signedVolume * (points.values[a * 3 + axis] + points.values[b * 3 + axis] + points.values[c * 3 + axis] - 3 * reference[axis]) / 4
  }
  for (let face = 0; face < faces.count; face++) {
    const vertices = faces.values[offset++]
    if (!Number.isInteger(vertices) || vertices < 3 || offset + vertices > faces.values.length) throw new Error('Invalid mesh face connectivity.')
    const a = faces.values[offset]
    for (let corner = 1; corner < vertices - 1; corner++) {
      const b = faces.values[offset + corner]
      const c = faces.values[offset + corner + 1]
      if ([a, b, c].some((label) => label < 0 || label >= points.count || !Number.isInteger(label))) throw new Error('Invalid mesh point label.')
      const [ax, ay, az] = points.values.slice(a * 3, a * 3 + 3).map((n, axis) => n - reference[axis])
      const [bx, by, bz] = points.values.slice(b * 3, b * 3 + 3).map((n, axis) => n - reference[axis])
      const [cx, cy, cz] = points.values.slice(c * 3, c * 3 + 3).map((n, axis) => n - reference[axis])
      const signedVolume = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
      accumulate(owner.values[face], signedVolume, a, b, c)
      if (face < neighbour.count) accumulate(neighbour.values[face], -signedVolume, a, b, c)
    }
    offset += vertices
  }
  return [...moments].map((moment, index) => {
    const denominator = volume[Math.floor(index / 3)]
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-20) throw new Error('A mesh cell has zero volume.')
    return moment / denominator + reference[index % 3]
  })
}

async function readCellCentres(directory: string): Promise<number[]> {
  const mesh = path.join(directory, 'constant', 'polyMesh')
  const [points, faces, owner, neighbour] = await Promise.all(['points', 'faces', 'owner', 'neighbour'].map((name) => readFile(path.join(mesh, name), 'utf8')))
  return cellCentresFromMesh(points, faces, owner, neighbour)
}

export function parseField(text: string, components: 1 | 3, expectedCount?: number): number[] {
  const marker = /internalField\s+(uniform|nonuniform)\s+/.exec(text)
  if (!marker || marker.index === undefined) throw new Error('Missing OpenFOAM internalField.')
  const content = text.slice(marker.index + marker[0].length)
  if (marker[1] === 'uniform') {
    if (expectedCount === undefined) throw new Error('A uniform field needs a known cell count.')
    const end = content.indexOf(';')
    const values = content.slice(0, end).replace(/[()]/g, ' ').trim().split(/\s+/).map(Number)
    if (values.length !== components || values.some((n) => !Number.isFinite(n))) throw new Error('Invalid uniform field values.')
    return Array.from({ length: expectedCount * components }, (_, index) => values[index % components])
  }
  const list = new RegExp(`^List<${components === 3 ? 'vector' : 'scalar'}>\\s+(\\d+)\\s*\\(`).exec(content)
  if (!list) throw new Error('Unsupported OpenFOAM field list format.')
  const count = Number(list[1])
  if (count > 1_000_000 || (expectedCount !== undefined && count !== expectedCount)) throw new Error('Inconsistent or excessive field cell count.')
  let depth = 1
  let end = list[0].length
  for (; end < content.length; end++) {
    if (content[end] === '(') depth++
    else if (content[end] === ')' && --depth === 0) break
  }
  if (depth !== 0) throw new Error('Truncated OpenFOAM field.')
  const values = content.slice(list[0].length, end).replace(/[()]/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number)
  if (values.some((n) => !Number.isFinite(n))) throw new Error('The solver produced a non-finite field.')
  if (values.length !== count * components) throw new Error('Truncated OpenFOAM field.')
  return values
}

export async function latestTime(directory: string): Promise<string> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(b) - Number(a))
  if (!names.length || Number(names[0]) === 0) throw new Error('The solver did not write a result time.')
  return names[0]
}

export async function readResults(directory: string, time: string, maximumPoints = 20_000) {
  const [points, velocityText, pressureText] = await Promise.all([
    readCellCentres(directory),
    readFile(path.join(directory, time, 'U'), 'utf8'),
    readFile(path.join(directory, time, 'p'), 'utf8'),
  ])
  const count = points.length / 3
  const velocity = parseField(velocityText, 3, count)
  const kinematicPressure = parseField(pressureText, 1, count)
  // Incompressible OpenFOAM p is pressure / density. Present pressure in physical Pa.
  const pressure = kinematicPressure.map((p) => p * 1.225)
  const step = Math.max(1, Math.ceil(count / maximumPoints))
  const sampled = { points: [] as number[], velocity: [] as number[], pressure: [] as number[] }
  let maxVelocity = 0
  let meanVelocity = 0
  let pressureMin = Infinity
  let pressureMax = -Infinity
  for (let cell = 0; cell < count; cell++) {
    const speed = Math.hypot(...velocity.slice(cell * 3, cell * 3 + 3))
    maxVelocity = Math.max(maxVelocity, speed)
    meanVelocity += speed / count
    pressureMin = Math.min(pressureMin, pressure[cell])
    pressureMax = Math.max(pressureMax, pressure[cell])
    if (cell % step === 0) {
      sampled.points.push(...points.slice(cell * 3, cell * 3 + 3))
      sampled.velocity.push(...velocity.slice(cell * 3, cell * 3 + 3))
      sampled.pressure.push(pressure[cell])
    }
  }
  return { result: sampled, metrics: { cellCount: count, maxVelocity, meanVelocity, pressureMin, pressureMax, airDensity: 1.225, resultTime: Number(time) } }
}
