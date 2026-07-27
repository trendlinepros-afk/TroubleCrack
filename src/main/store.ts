import { promises as fs, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { createLogger } from './logger'

const logger = createLogger('store')

/**
 * A tiny atomic JSON store. Writes go to a temp file then rename, so a crash
 * mid-write never corrupts the on-disk state. Reads tolerate a missing or
 * malformed file by returning the provided default. Persisted continuously so
 * killing and reopening the app resumes cleanly.
 */
export class JsonStore<T> {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(fileName: string, private readonly fallback: T) {
    this.filePath = path.join(app.getPath('userData'), fileName)
  }

  read(): T {
    try {
      if (!existsSync(this.filePath)) return structuredClone(this.fallback)
      const raw = readFileSync(this.filePath, 'utf8')
      return JSON.parse(raw) as T
    } catch (err) {
      logger.error(`Failed to read ${path.basename(this.filePath)}, using default`, err)
      return structuredClone(this.fallback)
    }
  }

  /** Serialize writes so overlapping saves never interleave. */
  write(value: T): Promise<void> {
    this.queue = this.queue.then(() => this.writeNow(value)).catch((err) => {
      logger.error(`Failed to persist ${path.basename(this.filePath)}`, err)
    })
    return this.queue
  }

  private async writeNow(value: T): Promise<void> {
    const tmp = `${this.filePath}.${process.pid}.tmp`
    const data = JSON.stringify(value, null, 2)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  get location(): string {
    return this.filePath
  }
}
