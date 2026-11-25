import { join } from 'node:path'
import { createApp } from './app.ts'
import { parseLang, translator } from './i18n.ts'
import { baseHostCandidates } from './network.ts'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data')
const token = process.env.APP_TOKEN || undefined
// Inside Docker the detected addresses are container-internal, so allow overriding them.
const baseHost = process.env.BASE_HOST || undefined
const language = parseLang(process.env.APP_LANGUAGE) ?? 'en'
const t = translator(language)

const { server, close } = await createApp({ dataDir, token, baseHost, language })

server.listen(port, host, () => {
  console.log(t('console.running', { port }))
  console.log(`  Dashboard:   http://localhost:${port}/`)
  for (const url of baseHostCandidates(port, baseHost)) console.log(t('console.baseHost', { url }))
  if (token) console.log(t('console.token'))
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => close().then(() => process.exit(0)))
}
