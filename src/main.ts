import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.ts'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
const token = process.env.APP_TOKEN || undefined
// Inside Docker the detected addresses are container-internal, so allow overriding them.
const baseHost = process.env.BASE_HOST || undefined

const { server, close } = await createApp({ dataDir, token })

server.listen(port, host, () => {
  console.log(`Temial Control läuft auf Port ${port}`)
  console.log(`  Dashboard:   http://localhost:${port}/`)
  const hosts = baseHost ? [baseHost] : lanAddresses().map((address) => `http://${address}:${port}`)
  for (const host of hosts) console.log(`  baseHost für die Temial: ${host}`)
  if (token) console.log('  API ist per APP_TOKEN geschützt')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => close().then(() => process.exit(0)))
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === 'IPv4' && !info.internal)
    .map((info) => info!.address)
}
