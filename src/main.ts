import { join } from 'node:path'
import { createApp } from './app.ts'
import { baseHostCandidates } from './network.ts'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
const token = process.env.APP_TOKEN || undefined
// Inside Docker the detected addresses are container-internal, so allow overriding them.
const baseHost = process.env.BASE_HOST || undefined

const { server, close } = await createApp({ dataDir, token, baseHost })

server.listen(port, host, () => {
  console.log(`Temial Control läuft auf Port ${port}`)
  console.log(`  Dashboard:   http://localhost:${port}/`)
  for (const candidate of baseHostCandidates(port, baseHost)) console.log(`  baseHost für die Temial: ${candidate}`)
  if (token) console.log('  API ist per APP_TOKEN geschützt')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => close().then(() => process.exit(0)))
}
