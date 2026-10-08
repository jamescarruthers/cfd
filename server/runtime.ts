import { constants, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
export const TOOL_NAMES = ['blockMesh', 'snappyHexMesh', 'checkMesh', 'decomposePar', 'simpleFoam', 'reconstructPar', 'foamToVTK', 'mpirun'] as const
export type ToolName = typeof TOOL_NAMES[number]

export function runtimeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const root = env.CFD_OPENFOAM_DIR ?? path.join(env.CFD_RUNTIME_DIR ?? '/workspace/.cfd', 'openfoam')
  if (existsSync(path.join(root, 'usr/bin/simpleFoam'))) {
    const project = path.join(root, 'usr/share/openfoam')
    Object.assign(env, {
      WM_PROJECT: 'OpenFOAM', WM_PROJECT_VERSION: 'v1912', WM_PROJECT_DIR: project,
      WM_PROJECT_USER_DIR: path.join(env.CFD_RUNTIME_DIR ?? '/workspace/.cfd', 'openfoam-user'),
      WM_MPLIB: 'SYSTEMOPENMPI', WM_OPTIONS: 'linux64GccDPInt32Opt', FOAM_API: '1912',
      FOAM_ETC: path.join(project, 'etc'), FOAM_CONFIG_ETC: path.join(project, 'etc'),
      FOAM_APPBIN: path.join(root, 'usr/bin'), FOAM_LIBBIN: path.join(root, 'usr/lib'), FOAM_MPI: 'openmpi-system',
      PATH: `${path.join(root, 'usr/bin')}:${env.PATH ?? ''}`,
      LD_LIBRARY_PATH: [path.join(root, 'usr/lib/openmpi-system'), path.join(root, 'usr/lib'), path.join(root, 'usr/lib/x86_64-linux-gnu'), env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    })
  }
  return env
}

export async function resolveTools(env = runtimeEnvironment()): Promise<Record<ToolName, string>> {
  const result = {} as Record<ToolName, string>
  for (const name of TOOL_NAMES) {
    for (const directory of (env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, name)
      try {
        await access(candidate, constants.X_OK)
        result[name] = candidate
        break
      } catch { /* Continue searching the configured toolchain. */ }
    }
    if (!result[name]) throw new Error(`OpenFOAM tool ${name} is unavailable. Run bash scripts/install-openfoam.sh.`)
  }
  return result
}

export async function runtimeHealth() {
  try {
    const env = runtimeEnvironment()
    const tools = await resolveTools(env)
    const output = await executeFile(tools.simpleFoam, ['-help'], { env, timeout: 10_000, maxBuffer: 128_000 })
    const text = `${output.stdout}\n${output.stderr}`
    const version = text.match(/OpenFOAM[^\n]*(?:v1912|1912)/)?.[0] ?? env.WM_PROJECT_VERSION ?? 'installed'
    return { ready: true, solver: 'OpenFOAM simpleFoam', version, tools: TOOL_NAMES, availableCores: availableParallelism(), units: { length: 'm', velocity: 'm/s', pressure: 'Pa', viscosity: 'm²/s' } }
  } catch (error) {
    return { ready: false, solver: 'OpenFOAM simpleFoam', error: error instanceof Error ? error.message : String(error), availableCores: availableParallelism() }
  }
}
