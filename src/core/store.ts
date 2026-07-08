import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Tiny disk-backed key-value store: one JSON object per file, loaded on
 * construct, persisted atomically (temp + rename) on every mutation. Used by
 * the mock adapter's per-run cart so it survives a process restart (proving the
 * durable EXECUTE gate end-to-end). Real adapters keep state server-side at the
 * target; Mastra's own snapshots persist the run/approval state.
 */
export class JsonStore<T> {
  private data: Record<string, T>

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      this.data = {}
    }
  }

  get(key: string): T | undefined {
    return this.data[key]
  }

  set(key: string, value: T): void {
    this.data[key] = value
    this.flush()
  }

  delete(key: string): void {
    delete this.data[key]
    this.flush()
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}
