// Mint anon / service_role JWTs for the local stack (HS256).
import crypto from 'node:crypto'

const secret = process.argv[2]
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const sign = (payload) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(payload)
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
const exp = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600
console.log(`VITE_SUPABASE_URL=http://localhost:54321`)
console.log(`VITE_SUPABASE_ANON_KEY=${sign({ role: 'anon', iss: 'supabase', exp })}`)
console.log(`SUPABASE_SERVICE_ROLE_KEY=${sign({ role: 'service_role', iss: 'supabase', exp })}`)
