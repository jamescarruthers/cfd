import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeCase } from './case'
import { latestTime, readResults } from './fields'
import { validateInput, type ValidatedInput } from './input'
import { resolveTools, runtimeEnvironment, type ToolName } from './runtime'

export type JobStatus = 'queued' | 'meshing' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobMetrics = {
  cellCount?: number
  maxVelocity?: number
  meanVelocity?: number
  pressureMin?: number
  pressureMax?: number
  airDensity?: number
  resultTime?: number
  iterations: number
  residual?: number
  residuals: Record<string, number>
  elapsedSeconds: number
  converged: boolean
}
export type JobResult = { points: number[]; velocity: number[]; pressure: number[] }
export type Job = {
  id: string
  status: JobStatus
  progress: number
  logs: string
  metrics: JobMetrics
  result?: JobResult
  error?: string
  createdAt: string
  completedAt?: string
  directory: string
  input: ValidatedInput
  cancelRequested: boolean
  child?: ChildProcess
  parseBuffer: string
  startedAt?: number
}

class CancelledError extends Error {}
export class CapacityError extends Error {}
const FINISHED = new Set<JobStatus>(['completed', 'failed', 'cancelled'])

export class JobManager {
  private jobs = new Map<string, Job>()
  private running = false
  readonly directory: string

  constructor(directory = process.env.CFD_RUNS_DIR ?? '/workspace/cfd-runs') {
    this.directory = path.resolve(directory)
  }

  create(value: unknown): Job {
    const input = validateInput(value)
    const pending = [...this.jobs.values()].filter((job) => !FINISHED.has(job.status))
    if (pending.length >= 8) throw new CapacityError('The simulation queue is full. Wait for a job to finish before submitting another.')
    if (this.jobs.size >= 32) {
      const oldestFinished = [...this.jobs.values()].find((job) => FINISHED.has(job.status))
      if (oldestFinished) this.jobs.delete(oldestFinished.id)
    }
    const id = randomUUID()
    const job: Job = {
      id, input, directory: path.join(this.directory, id), createdAt: new Date().toISOString(),
      status: 'queued', progress: 0, logs: '', cancelRequested: false, parseBuffer: '',
      metrics: { iterations: 0, residuals: {}, elapsedSeconds: 0, converged: false },
    }
    this.jobs.set(id, job)
    void this.drain()
    return job
  }

  get(id: string): Job | undefined { return this.jobs.get(id) }

  view(job: Job) {
    const elapsedSeconds = job.startedAt && !FINISHED.has(job.status) ? (Date.now() - job.startedAt) / 1000 : job.metrics.elapsedSeconds
    return {
      id: job.id, status: job.status, progress: job.progress, logs: job.logs,
      metrics: { ...job.metrics, elapsedSeconds }, result: job.result, error: job.error,
      createdAt: job.createdAt, completedAt: job.completedAt,
      settings: job.input.settings,
    }
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || FINISHED.has(job.status)) return false
    job.cancelRequested = true
    if (job.status === 'queued') {
      job.status = 'cancelled'
      job.completedAt = new Date().toISOString()
    }
    if (job.child?.pid) {
      const pid = job.child.pid
      try { process.kill(-pid, 'SIGTERM') } catch { /* The command may have just exited. */ }
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch { /* Already terminated. */ }
      }, 3000)
      timer.unref()
    }
    return true
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) this.cancel(job.id)
  }

  private append(job: Job, text: string): void {
    job.logs = (job.logs + text).slice(-256_000)
    job.parseBuffer += text
    const lines = job.parseBuffer.split(/\r?\n/)
    job.parseBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const time = /^Time = (\d+(?:\.\d+)?)/.exec(line)
      if (time && job.status === 'running') {
        job.metrics.iterations = Number(time[1])
        job.metrics.residuals = {}
        job.progress = Math.min(94, 45 + 49 * job.metrics.iterations / job.input.settings.iterations)
      }
      const residual = /Solving for (\w+), Initial residual = ([\d.eE+-]+)/.exec(line)
      if (residual) {
        const value = Number(residual[2])
        if (Number.isFinite(value)) {
          // Retain the largest initial residual across pressure-correction passes.
          job.metrics.residuals[residual[1]] = Math.max(job.metrics.residuals[residual[1]] ?? 0, value)
          job.metrics.residual = Math.max(...Object.values(job.metrics.residuals))
        }
      }
    }
  }

  private async command(job: Job, tool: ToolName, args: string[], tools: Record<ToolName, string>, env: NodeJS.ProcessEnv): Promise<string> {
    if (job.cancelRequested) throw new CancelledError('Cancelled by user.')
    this.append(job, `\n$ ${tool} ${args.join(' ')}\n`)
    let output = ''
    await new Promise<void>((resolve, reject) => {
      // No shell: request data never becomes executable command text.
      const child = spawn(tools[tool], args, { cwd: job.directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      job.child = child
      const onData = (data: Buffer) => {
        const text = data.toString('utf8')
        output = (output + text).slice(-512_000)
        this.append(job, text)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', reject)
      child.once('close', (code, signal) => {
        job.child = undefined
        if (job.cancelRequested) reject(new CancelledError('Cancelled by user.'))
        else if (code !== 0) reject(new Error(`${tool} failed (${signal ?? `exit ${code}`}). See the solver log.`))
        else resolve()
      })
    })
    return output
  }

  private async run(job: Job): Promise<void> {
    job.startedAt = Date.now()
    try {
      const env = runtimeEnvironment()
      const tools = await resolveTools(env)
      await mkdir(job.directory, { recursive: true })
      await writeCase(job.directory, job.input)
      if (job.input.triangleCount) {
        this.append(job, `Surface refinement level ${job.input.refinementLevel}.${job.input.minimumWall ? ` Minimum pipe wall ${job.input.minimumWall} m; target at least two cells across the wall.` : ' Imported thin features need an explicit mesh-resolution study.'}\n`)
      }
      job.status = 'meshing'
      job.progress = 5
      await this.command(job, 'blockMesh', [], tools, env)
      job.progress = 15
      if (job.input.triangleCount) {
        const meshing = await this.command(job, 'snappyHexMesh', ['-overwrite'], tools, env)
        if (/reached.*(?:maxGlobalCells|cell limit)|stopping.*(?:maxGlobalCells|cell limit)/i.test(meshing)) {
          throw new Error('Surface refinement reached the 300,000-cell limit. Simplify the scene, enlarge pipe walls, or use a smaller domain.')
        }
      }
      job.progress = 30
      // Standard geometric quality checks plus exhaustive topology. The optional
      // -allGeometry convexity check rejects valid snappy refinement polyhedra.
      const meshCheck = await this.command(job, 'checkMesh', ['-allTopology'], tools, env)
      if (!/Mesh OK\./.test(meshCheck) || /Failed\s+\d+\s+mesh checks/.test(meshCheck)) {
        throw new Error('Mesh quality validation failed. Adjust the domain, geometry, or grid and review the mesh log.')
      }
      job.progress = 40
      await this.command(job, 'decomposePar', [], tools, env)
      job.status = 'running'
      job.progress = 45
      const output = await this.command(job, 'mpirun', ['--allow-run-as-root', '--oversubscribe', '-np', String(job.input.settings.cores), tools.simpleFoam, '-parallel', '-noFunctionObjects'], tools, env)
      job.metrics.converged = /SIMPLE solution converged/.test(output)
      job.progress = 95
      await this.command(job, 'reconstructPar', ['-latestTime'], tools, env)
      await this.command(job, 'foamToVTK', ['-ascii', '-legacy', '-latestTime', '-fields', '(U p)', '-no-boundary'], tools, env)
      const time = await latestTime(job.directory)
      const results = await readResults(job.directory, time)
      if (job.cancelRequested) throw new CancelledError('Cancelled by user.')
      job.result = results.result
      Object.assign(job.metrics, results.metrics)
      job.status = 'completed'
      job.progress = 100
      this.append(job, job.metrics.converged ? '\nSIMPLE residual convergence criterion reached.\n' : '\nIteration limit reached; inspect residuals and perform mesh-independence checks before using results.\n')
    } catch (error) {
      job.status = error instanceof CancelledError || job.cancelRequested ? 'cancelled' : 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      this.append(job, `\n${job.status.toUpperCase()}: ${job.error}\n`)
    } finally {
      job.completedAt = new Date().toISOString()
      job.metrics.elapsedSeconds = (Date.now() - job.startedAt) / 1000
      if (job.directory) {
        try {
          await writeFile(path.join(job.directory, 'flow-studio.log'), job.logs)
          await writeFile(path.join(job.directory, 'flow-studio-report.json'), JSON.stringify({ ...this.view(job), result: undefined, logs: undefined }, null, 2))
        } catch { /* Missing tools can fail before the case directory is created. */ }
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (;;) {
        const next = [...this.jobs.values()].find((job) => job.status === 'queued')
        if (!next) break
        await this.run(next)
      }
    } finally { this.running = false }
  }
}
