import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

// Minimal shapes so this file typechecks without @types/node.
type Req = { url?: string; method?: string; resume(): void; on(ev: 'end', cb: () => void): void }
type Res = { statusCode: number; setHeader(k: string, v: string): void; end(body: string): void }

// Fake API + fake collector so the demo runs without the Worker.
function fakeBackend(): Plugin {
  const json = (res: Res, status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  let n = 0
  const handle = (req: Req, res: Res, next: () => void) => {
    const url = req.url ?? ''
    if (url.startsWith('/api/server-error'))
      return json(res, 500, { success: false, code: 'InternalServerError', message: 'Object reference not set' })
    if (url.startsWith('/api/validation'))
      return json(res, 400, { success: false, errors: { amount: ['Amount must be greater than 0'] } })
    if (url.startsWith('/api/app-error'))
      return json(res, 200, { success: false, code: 'PlayerNotFound', message: 'Player not found' })
    if (url.startsWith('/api/ok')) return json(res, 200, { success: true, data: [] })
    if (url.startsWith('/v1/reports') && req.method === 'POST') {
      req.resume()
      req.on('end', () => {
        n++
        json(res, 201, { id: `r${n}`, ref: `DEMO-${n}`, url: `http://localhost/reports/r${n}` })
      })
      return
    }
    next()
  }
  return {
    name: 'dalil-fake-backend',
    configureServer: (s) => void s.middlewares.use(handle as unknown as Connect.NextHandleFunction),
    configurePreviewServer: (s) => void s.middlewares.use(handle as unknown as Connect.NextHandleFunction),
  }
}

export default defineConfig({
  plugins: [react(), fakeBackend()],
  build: { outDir: 'dist', emptyOutDir: true },
})
