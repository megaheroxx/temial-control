import { networkInterfaces } from 'node:os'

/** Non-internal IPv4 addresses of this machine. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === 'IPv4' && !info.internal)
    .map((info) => info!.address)
}

/** Addresses a Temial can use as baseHost to reach this server. */
export function baseHostCandidates(port: number, override?: string): string[] {
  return override ? [override] : lanAddresses().map((address) => `http://${address}:${port}`)
}
