import { readFileSync } from 'node:fs'

/** Minimal .env loader for the CLI/scripts run via tsx (Next.js loads .env
 * itself). Real env vars win; a missing file is fine. */
export function loadDotEnv(path = '.env'): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2]
  }
}
