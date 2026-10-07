// Minimal Supabase-style API gateway for local e2e:
//   /auth/v1/*  -> GoTrue   (127.0.0.1:9999)
//   /rest/v1/*  -> PostgREST (127.0.0.1:3000)
// Adds CORS so the Vite dev server can call it from the browser.
import http from 'node:http'

const routes = [
  { prefix: '/auth/v1', port: 9999 },
  { prefix: '/rest/v1', port: 3000 },
]

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, prefer, accept-profile, content-profile, range, x-supabase-api-version',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-range, x-supabase-api-version',
}

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const route = routes.find((r) => req.url.startsWith(r.prefix))
    if (!route) {
      res.writeHead(404, cors)
      return res.end(JSON.stringify({ error: 'not found' }))
    }
    const headers = { ...req.headers, host: `127.0.0.1:${route.port}`, 'x-forwarded-for': req.socket.remoteAddress ?? '' }
    const upstream = http.request(
      { host: '127.0.0.1', port: route.port, path: req.url.slice(route.prefix.length) || '/', method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors })
        up.pipe(res)
      },
    )
    upstream.on('error', (e) => {
      res.writeHead(502, cors)
      res.end(JSON.stringify({ error: String(e) }))
    })
    req.pipe(upstream)
  })
  .listen(54321, '127.0.0.1', () => console.log('gateway on :54321'))
