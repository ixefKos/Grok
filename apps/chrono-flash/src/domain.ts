export type DayIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type Puzzle = {
  day: DayIndex
  prompt: string
  items: readonly string[]
  choices: readonly string[]
  answer: string
}

export type Outcome =
  | { kind: 'solved'; elapsedMs: number }
  | { kind: 'dnf' }

export type DayRecord = {
  dayKey: string
  dayIndex: DayIndex
  outcome: Outcome
}

export type Session =
  | { status: 'home'; puzzle: Puzzle; record: DayRecord | null }
  | { status: 'playing'; puzzle: Puzzle; startedAt: number }
  | { status: 'result'; puzzle: Puzzle; outcome: Outcome }

export type SessionEvent =
  | { type: 'start'; startedAt: number; todayKey: string }
  | { type: 'solve'; elapsedMs: number }
  | { type: 'dnf' }

export const PACK_EPOCH = { year: 2026, monthIndex: 8, day: 17 } as const
export const PACK_SIZE = 7

export function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dayIndexFor(date: Date): DayIndex {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const epoch = Date.UTC(PACK_EPOCH.year, PACK_EPOCH.monthIndex, PACK_EPOCH.day)
  const days = Math.floor((utc - epoch) / 86_400_000)
  return (((((days % PACK_SIZE) + PACK_SIZE) % PACK_SIZE) + 1) as DayIndex)
}

export function canStart(record: DayRecord | null, todayKey: string): boolean {
  return record === null || record.dayKey !== todayKey
}

export function bootSession(
  puzzle: Puzzle,
  record: DayRecord | null,
  todayKey: string,
): Session {
  if (record && record.dayKey === todayKey) {
    return { status: 'result', puzzle, outcome: record.outcome }
  }
  return { status: 'home', puzzle, record }
}

export function reduceSession(session: Session, event: SessionEvent): Session {
  switch (session.status) {
    case 'home':
      if (event.type === 'start' && canStart(session.record, event.todayKey)) {
        return { status: 'playing', puzzle: session.puzzle, startedAt: event.startedAt }
      }
      return session
    case 'playing':
      if (event.type === 'solve') {
        return {
          status: 'result',
          puzzle: session.puzzle,
          outcome: { kind: 'solved', elapsedMs: Math.max(0, Math.round(event.elapsedMs)) },
        }
      }
      if (event.type === 'dnf') {
        return { status: 'result', puzzle: session.puzzle, outcome: { kind: 'dnf' } }
      }
      return session
    case 'result':
      return session
  }
}

export function elapsedMs(startedAt: number, now: number): number {
  return Math.max(0, Math.round(now - startedAt))
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatShare(input: {
  dayIndex: DayIndex
  outcome: Outcome
  url: string
}): string {
  const timeLine =
    input.outcome.kind === 'solved' ? formatElapsed(input.outcome.elapsedMs) : 'DNF'
  return `Chrono Flash #${input.dayIndex}\n${timeLine}\n${input.url}`
}

export function isCanonicalShare(
  paste: string,
  dayIndex: DayIndex,
  url: string,
): boolean {
  const lines = paste.split('\n')
  if (lines.length !== 3) return false
  if (lines[0] !== `Chrono Flash #${dayIndex}`) return false
  if (lines[1] !== 'DNF' && !/^\d+:\d{2}:\d{2}$/.test(lines[1])) return false
  return lines[2] === url
}

export function parseDayRecord(raw: unknown): DayRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.dayKey)) {
    return null
  }
  if (
    typeof value.dayIndex !== 'number' ||
    !Number.isInteger(value.dayIndex) ||
    value.dayIndex < 1 ||
    value.dayIndex > PACK_SIZE
  ) {
    return null
  }
  const outcome = parseOutcome(value.outcome)
  if (!outcome) return null
  return {
    dayKey: value.dayKey,
    dayIndex: value.dayIndex as DayIndex,
    outcome,
  }
}

function parseOutcome(raw: unknown): Outcome | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.kind === 'dnf') return { kind: 'dnf' }
  if (value.kind === 'solved' && typeof value.elapsedMs === 'number' && Number.isFinite(value.elapsedMs)) {
    return { kind: 'solved', elapsedMs: Math.max(0, Math.round(value.elapsedMs)) }
  }
  return null
}
