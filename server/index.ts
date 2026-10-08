import express from 'express'
import { spawn } from 'node:child_process'
import { CapacityError, JobManager } from './jobs'
import { InputError } from './input'
import { runtimeHealth } from './runtime'
import { protectApi, securityConfiguration } from './security'

const app = express()
const jobs = new JobManager()
const security = securityConfiguration()
app.disable('x-powered-by')
app.use('/api', protectApi(security))
app.use(express.json({ limit: '9mb' }))

app.get('/api/health', async (_request, response) => { response.json(await runtimeHealth()) })

app.post('/api/jobs', async (request, response) => {
  try {
    const health = await runtimeHealth()
    if (!health.ready) { response.status(503).json({ error: health.error }); return }
    const job = jobs.create(request.body)
    response.status(202).json({ id: job.id })
  } catch (error) {
    response.status(error instanceof InputError ? 400 : error instanceof CapacityError ? 429 : 500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) { response.status(404).json({ error: 'Simulation job not found.' }); return }
  response.json(jobs.view(job))
})

app.post('/api/jobs/:id/cancel', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) { response.status(404).json({ error: 'Simulation job not found.' }); return }
  jobs.cancel(job.id)
  response.json(jobs.view(job))
})

app.get('/api/jobs/:id/download', (request, response) => {
  const job = jobs.get(request.params.id)
  if (!job) { response.status(404).json({ error: 'Simulation job not found.' }); return }
  if (!['completed', 'failed', 'cancelled'].includes(job.status)) { response.status(409).json({ error: 'Wait until the job has finished before downloading its case.' }); return }
  response.setHeader('Content-Type', 'application/gzip')
  response.setHeader('Content-Disposition', `attachment; filename="flow-studio-${job.id}.tar.gz"`)
  const archive = spawn('tar', ['-czf', '-', '-C', jobs.directory, job.id], { stdio: ['ignore', 'pipe', 'pipe'] })
  archive.stdout.pipe(response)
  archive.on('error', () => response.destroy())
  archive.on('close', (code) => { if (code !== 0) response.destroy() })
  response.on('close', () => { if (!archive.killed) archive.kill() })
})

app.use((error: Error & { type?: string }, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: error.message })
})

const port = Number(process.env.CFD_API_PORT ?? 3001)
const server = app.listen(port, security.host, () => console.log(`Flow Studio CFD API listening on ${security.host}:${port}`))
function shutdown() {
  jobs.cancelAll()
  server.close()
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
