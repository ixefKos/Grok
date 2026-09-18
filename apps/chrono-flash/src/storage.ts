import { parseDayRecord, type DayRecord } from './domain.ts'

/** v2 invalidates Soft 6/6 IQ-battery locks. Day-lock stays ON. */
export const STORAGE_KEY = 'chrono-flash:v2:xtrends'

export function loadRecord(storage: Storage): DayRecord | null {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    return parseDayRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveRecord(storage: Storage, record: DayRecord): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(record))
}
