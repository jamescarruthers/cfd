import { createHash, timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'

export type ApiSecurity = { host: string; token?: string; origins: Set<string> }

export function securityConfiguration(env: NodeJS.ProcessEnv = process.env): ApiSecurity {
  const host = env.CFD_API_HOST ?? '127.0.0.1'
  const token = env.CFD_API_TOKEN?.trim() || undefined
  const origins = new Set((env.CFD_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  for (const origin of origins) {
    let parsed: URL
    try { parsed = new URL(origin) } catch { throw new Error('CFD_ALLOWED_ORIGINS must contain exact HTTP(S) origins.') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('CFD_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths or wildcards.')
    }
  }
  const publicHost = !['127.0.0.1', 'localhost', '::1'].includes(host)
  if ((publicHost || env.CFD_REQUIRE_AUTH === '1') && (!token || origins.size === 0)) {
    throw new Error('A public CFD API requires CFD_API_TOKEN and explicit CFD_ALLOWED_ORIGINS.')
  }
  return { host, token, origins }
}

export function validBearer(authorization: string | undefined, token: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false
  const provided = authorization.slice('Bearer '.length)
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(provided), digest(token))
}

export function protectApi(config: ApiSecurity): RequestHandler {
  return (request, response, next) => {
    const origin = request.get('Origin')
    const sameOrigin = origin === `${request.protocol}://${request.get('host')}`
    if (origin && !sameOrigin && !config.origins.has(origin)) {
      response.status(403).json({ error: 'This browser origin is not allowed to access the CFD API.' })
      return
    }
    if (origin && (sameOrigin || config.origins.has(origin))) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      response.setHeader('Access-Control-Max-Age', '600')
    }
    if (request.method === 'OPTIONS') { response.sendStatus(204); return }
    if (config.token && !validBearer(request.get('Authorization'), config.token)) {
      response.status(401).json({ error: 'A valid CFD API bearer token is required.' })
      return
    }
    next()
  }
}
