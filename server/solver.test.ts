import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { caseFiles } from './case'
import { cellCentresFromMesh, parseField } from './fields'
import { validateInput } from './input'
import { JobManager, type Job } from './jobs'
import { createShape, exportSceneSTL } from '../src/geometry'
import { securityConfiguration, validBearer } from './security'

describe('remote API access controls', () => {
  it('requires explicit credentials and origins for public listeners', () => {
    expect(() => securityConfiguration({ CFD_API_HOST: '0.0.0.0' })).toThrow('requires')
    expect(() => securityConfiguration({ CFD_API_HOST: '0.0.0.0', CFD_API_TOKEN: 'test', CFD_ALLOWED_ORIGINS: '*' })).toThrow('origins')
    expect(securityConfiguration({}).host).toBe('127.0.0.1')
    expect(securityConfiguration({ CFD_API_HOST: '0.0.0.0', CFD_API_TOKEN: 'test', CFD_ALLOWED_ORIGINS: 'https://example.github.io' }).origins.has('https://example.github.io')).toBe(true)
  })
  it('validates bearer tokens without accepting prefixes or missing authentication', () => {
    expect(validBearer('Bearer secret', 'secret')).toBe(true)
    expect(validBearer('Bearer secret-extra', 'secret')).toBe(false)
    expect(validBearer(undefined, 'secret')).toBe(false)
  })
})

const baseline = () => ({
  scene: { stl: '' },
  settings: { velocity: 1, viscosity: 1.5e-5, domain: { min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] }, cells: [16, 8, 8], iterations: 40, cores: 2 },
})

describe('validated OpenFOAM case generation', () => {
  it('rejects excessive mesh and non-finite physical inputs', () => {
    const input = baseline()
    input.settings.cells = [128, 128, 128]
    expect(() => validateInput(input)).toThrow('150,000')
    input.settings.cells = [16, 8, 8]
    input.settings.velocity = NaN
    expect(() => validateInput(input)).toThrow('Inlet speed')
  })

  it('rejects open surfaces before they reach the mesher', () => {
    const input = baseline()
    input.scene.stl = 'solid open\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 0.1 0 0\nvertex 0 0.1 0\nendloop\nendfacet\nendsolid open'
    expect(() => validateInput(input)).toThrow('watertight')
  })

  it('writes SI transport parameters and actual parallel decomposition', () => {
    const files = caseFiles(validateInput(baseline()))
    expect(files['constant/transportProperties']).toContain('0.000015')
    expect(files['system/decomposeParDict']).toContain('numberOfSubdomains 2')
    expect(files['system/decomposeParDict']).toContain('hierarchical')
    expect(files['constant/turbulenceProperties']).toContain('kOmegaSST')
    expect(files['system/controlDict']).not.toContain('functions')
  })

  it('refines pipe walls to at least two cells and rejects unresolvable walls', () => {
    const input = { ...baseline(), scene: { stl: '', shapes: [{ type: 'pipe', wall: 0.016, width: 0.28 }] } }
    input.settings.cells = [32, 16, 16]
    expect(validateInput(input).refinementLevel).toBe(3)
    input.scene.shapes[0].wall = 0.001
    expect(() => validateInput(input)).toThrow('too thin')
  })
})

describe('native solver result parsing', () => {
  it('reads scalar/vector fields, including uniform fields and rejects inconsistent counts', () => {
    expect(parseField('internalField nonuniform List<vector> 2 ((1 2 3) (4 5 6)); boundaryField{}', 3, 2)).toEqual([1, 2, 3, 4, 5, 6])
    expect(parseField('internalField uniform 2.5e-3;', 1, 2)).toEqual([0.0025, 0.0025])
    expect(() => parseField('internalField nonuniform List<scalar> 1 (0);', 1, 2)).toThrow('cell count')
    expect(() => parseField('internalField uniform nan;', 1, 2)).toThrow('Invalid')
    expect(() => parseField('internalField nonuniform List<scalar> 2 (nan 1); boundaryField { value uniform 2; }', 1, 2)).toThrow('non-finite')
    expect(() => parseField('internalField nonuniform List<scalar> 2 (1); boundaryField { value uniform 2; }', 1, 2)).toThrow('Truncated')
  })

  it('computes exact oriented-polyhedron centroids for an offset cuboid', () => {
    const points = '8 ((1 2 3) (3 2 3) (3 4 3) (1 4 3) (1 2 5) (3 2 5) (3 4 5) (1 4 5))'
    const faces = '6 (4(0 4 7 3) 4(1 2 6 5) 4(0 1 5 4) 4(3 7 6 2) 4(0 3 2 1) 4(4 5 6 7))'
    const centre = cellCentresFromMesh(points, faces, '6(0 0 0 0 0 0)', '0()')
    expect(centre[0]).toBeCloseTo(2, 10)
    expect(centre[1]).toBeCloseTo(3, 10)
    expect(centre[2]).toBeCloseTo(4, 10)
  })
})

async function finished(job: Job): Promise<void> {
  const start = Date.now()
  while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    if (Date.now() - start > 160_000) throw new Error(`Solver timed out:\n${job.logs.slice(-4000)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (job.status === 'failed') throw new Error(`${job.error}\n${job.logs.slice(-6000)}`)
}

const integration = process.env.RUN_OPENFOAM_BENCHMARK === '1' ? describe : describe.skip
integration('real OpenFOAM engineering benchmarks', () => {
  it('preserves uniform 3D airflow through an empty domain on two MPI ranks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cfd-uniform-'))
    const manager = new JobManager(directory)
    try {
      const job = manager.create(baseline())
      await finished(job)
      expect(job.status).toBe('completed')
      expect(job.metrics.cellCount).toBe(1024)
      expect(job.metrics.maxVelocity).toBeCloseTo(1, 6)
      expect(job.result!.velocity.filter((_, i) => i % 3 !== 0).every((n) => Math.abs(n) < 1e-6)).toBe(true)
      expect(job.metrics.pressureMax! - job.metrics.pressureMin!).toBeLessThan(1e-6)
      expect(job.logs).toContain('nProcs : 2')
      expect(job.result!.points.every(Number.isFinite)).toBe(true)
    } finally { manager.cancelAll(); await rm(directory, { recursive: true, force: true }) }
  }, 180_000)

  it('meshes a closed obstacle and computes a finite disturbed flow using four MPI ranks', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cfd-obstacle-'))
    const manager = new JobManager(directory)
    try {
      const input = baseline()
      input.scene.stl = exportSceneSTL([createShape('box')])
      input.settings.cells = [32, 16, 16]
      input.settings.iterations = 80
      input.settings.cores = 4
      const job = manager.create(input)
      await finished(job)
      expect(job.status).toBe('completed')
      expect(job.metrics.cellCount).toBeGreaterThan(32 * 16 * 16)
      expect(job.result!.velocity.every(Number.isFinite)).toBe(true)
      expect(job.result!.pressure.every(Number.isFinite)).toBe(true)
      expect(job.metrics.maxVelocity).toBeGreaterThan(1.05)
      expect(job.metrics.pressureMax! - job.metrics.pressureMin!).toBeGreaterThan(0.1)
      expect(job.logs).toContain('Mesh OK.')
      expect(job.logs).toContain('nProcs : 4')
    } finally { manager.cancelAll(); await rm(directory, { recursive: true, force: true }) }
  }, 180_000)

  it('resolves a default pipe wall while keeping its bore open to fluid', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cfd-pipe-'))
    const manager = new JobManager(directory)
    try {
      const pipe = { ...createShape('pipe'), size: 0.9, width: 0.28, wall: 0.016 }
      const input = { ...baseline(), scene: { stl: exportSceneSTL([pipe]), shapes: [{ type: pipe.type, wall: pipe.wall, width: pipe.width }] } }
      input.settings.cells = [32, 16, 16]
      input.settings.iterations = 80
      const job = manager.create(input)
      await finished(job)
      expect(job.status).toBe('completed')
      expect(job.input.refinementLevel).toBe(3)
      expect(job.metrics.cellCount).toBeGreaterThan(20_000)
      const points = job.result!.points
      let borePoints = 0
      let wallPoints = 0
      for (let offset = 0; offset < points.length; offset += 3) {
        if (Math.abs(points[offset]) > 0.35) continue
        const radius = Math.hypot(points[offset + 1], points[offset + 2])
        if (radius < 0.11) borePoints++
        if (radius > 0.126 && radius < 0.138) wallPoints++
      }
      expect(borePoints).toBeGreaterThan(20)
      expect(wallPoints).toBe(0)
      expect(job.result!.velocity.every(Number.isFinite)).toBe(true)
      expect(job.logs).toContain('Mesh OK.')
    } finally { manager.cancelAll(); await rm(directory, { recursive: true, force: true }) }
  }, 180_000)

  it('reproduces developed square-duct laminar pressure gradient within 15 percent', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cfd-duct-'))
    const manager = new JobManager(directory)
    try {
      const job = manager.create({ scene: { stl: '' }, settings: {
        velocity: 0.05, viscosity: 0.01, domain: { min: [0, 0, 0], max: [1, 0.1, 0.1] },
        cells: [64, 12, 12], iterations: 200, cores: 2, turbulence: 'laminar', boundary: 'channel',
      } })
      await finished(job)
      expect(job.status).toBe('completed')
      const { points, pressure } = job.result!
      const samples = pressure.map((p, cell) => ({ x: points[cell * 3], p })).filter(({ x }) => x > 0.5 && x < 0.9)
      const meanX = samples.reduce((sum, sample) => sum + sample.x, 0) / samples.length
      const meanP = samples.reduce((sum, sample) => sum + sample.p, 0) / samples.length
      const slope = samples.reduce((sum, { x, p }) => sum + (x - meanX) * (p - meanP), 0) / samples.reduce((sum, { x }) => sum + (x - meanX) ** 2, 0)
      const exactGradient = 28.454 * 0.01 * 0.05 / 0.1 ** 2 * 1.225
      expect(Math.abs(-slope / exactGradient - 1)).toBeLessThan(0.15)
      expect(job.metrics.maxVelocity).toBeGreaterThan(0.09)
      expect(job.metrics.maxVelocity).toBeLessThan(0.12)
      expect(job.metrics.residual!).toBeLessThan(1e-3)
    } finally { manager.cancelAll(); await rm(directory, { recursive: true, force: true }) }
  }, 180_000)

  it('cancels an active job and terminates its process group', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cfd-cancel-'))
    const manager = new JobManager(directory)
    try {
      const job = manager.create(baseline())
      while (!job.child && !['failed', 'completed'].includes(job.status)) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(job.child?.pid).toBeDefined()
      manager.cancel(job.id)
      await finished(job)
      expect(job.status).toBe('cancelled')
      expect(job.child).toBeUndefined()
      expect(job.result).toBeUndefined()
    } finally { manager.cancelAll(); await rm(directory, { recursive: true, force: true }) }
  }, 180_000)
})
