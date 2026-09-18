export type DayIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7

export type SkillFamily =
  | 'pattern'
  | 'spatial'
  | 'verbal'
  | 'logic'
  | 'memory'
  | 'attention'

export type Cell = readonly [row: number, col: number]

export type Choice = {
  id: string
  label: string
  shape?: readonly Cell[]
}

export type ItemKind = 'choice' | 'spatial' | 'memory'

export type BatteryItem = {
  id: string
  family: SkillFamily
  kind: ItemKind
  prompt: string
  choices: readonly Choice[]
  answer: string
  flash?: readonly string[]
  flashMs?: number
  promptShape?: readonly Cell[]
}

export type Battery = {
  day: DayIndex
  items: readonly BatteryItem[]
}

export type Outcome =
  | { kind: 'solved'; elapsedMs: number; correct: number; total: number }
  | { kind: 'dnf'; total: number }

export type DayRecord = {
  dayKey: string
  dayIndex: DayIndex
  outcome: Outcome
}

export type Session =
  | { status: 'home'; battery: Battery; record: DayRecord | null }
  | {
      status: 'playing'
      battery: Battery
      startedAt: number
      index: number
      answers: readonly string[]
    }
  | { status: 'result'; battery: Battery; outcome: Outcome }

export type SessionEvent =
  | { type: 'start'; startedAt: number; todayKey: string; dayLock?: boolean }
  | { type: 'answer'; choice: string; elapsedMs: number }
  | { type: 'dnf' }

export type HostGate = {
  dev: boolean
  hostname: string
  envFlag?: boolean
}

export const PACK_EPOCH = { year: 2026, monthIndex: 8, day: 17 } as const
export const PACK_SIZE = 7
export const MIN_ITEMS = 6
export const MIN_FAMILIES = 4
export const MEMORY_FLASH_MS = 2500
export const SHARE_DOT = '·'
export const DNF_MARK = '—'
export const POST_TIME_INTENT = 'https://twitter.com/intent/tweet'

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

export function canStart(
  record: DayRecord | null,
  todayKey: string,
  dayLock = true,
): boolean {
  if (!dayLock) return true
  return record === null || record.dayKey !== todayKey
}

/** Soft preview only (*.vercel.app / localhost / DEV / VITE_SOFT_UNLOCK=1). LIVE custom domain must stay locked — do not merge LIVE with day-lock OFF. */
export function isSoftHost(input: HostGate): boolean {
  if (input.dev || input.envFlag) return true
  const host = input.hostname.toLowerCase()
  return host.endsWith('.vercel.app') || host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export function dayLockEnabled(input: HostGate): boolean {
  return !isSoftHost(input)
}

export function bootSession(
  battery: Battery,
  record: DayRecord | null,
  todayKey: string,
  dayLock = true,
): Session {
  if (dayLock && record && record.dayKey === todayKey) {
    return { status: 'result', battery, outcome: record.outcome }
  }
  return { status: 'home', battery, record: dayLock ? record : null }
}

export function scoreAnswers(battery: Battery, answers: readonly string[]): number {
  return battery.items.reduce(
    (count, item, index) => count + (answers[index] === item.answer ? 1 : 0),
    0,
  )
}

export function skillFamilies(battery: Battery): SkillFamily[] {
  return [...new Set(battery.items.map((item) => item.family))]
}

export function reduceSession(session: Session, event: SessionEvent): Session {
  switch (session.status) {
    case 'home':
      if (event.type === 'start' && canStart(session.record, event.todayKey, event.dayLock ?? true)) {
        return {
          status: 'playing',
          battery: session.battery,
          startedAt: event.startedAt,
          index: 0,
          answers: [],
        }
      }
      return session
    case 'playing':
      if (event.type === 'answer') {
        const item = session.battery.items[session.index]
        if (!item || session.answers.length !== session.index) return session
        const answers = [...session.answers, event.choice]
        if (answers.length >= session.battery.items.length) {
          return {
            status: 'result',
            battery: session.battery,
            outcome: {
              kind: 'solved',
              elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
              correct: scoreAnswers(session.battery, answers),
              total: session.battery.items.length,
            },
          }
        }
        return {
          status: 'playing',
          battery: session.battery,
          startedAt: session.startedAt,
          index: session.index + 1,
          answers,
        }
      }
      if (event.type === 'dnf') {
        return {
          status: 'result',
          battery: session.battery,
          outcome: { kind: 'dnf', total: session.battery.items.length },
        }
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

export function formatScoreLine(outcome: Outcome): string {
  if (outcome.kind === 'dnf') {
    return `Score ${DNF_MARK}/${outcome.total} ${SHARE_DOT} DNF`
  }
  return `Score ${outcome.correct}/${outcome.total} ${SHARE_DOT} ${formatElapsed(outcome.elapsedMs)}`
}

export function formatShare(input: {
  dayIndex: DayIndex
  outcome: Outcome
  url: string
}): string {
  return `Chrono Flash #${input.dayIndex}\n${formatScoreLine(input.outcome)}\n${input.url}`
}

export function buildPostTimeUrl(text: string): string {
  return `${POST_TIME_INTENT}?text=${encodeURIComponent(text)}`
}

export function isCanonicalShare(
  paste: string,
  dayIndex: DayIndex,
  url: string,
  total: number,
): boolean {
  const lines = paste.split('\n')
  if (lines.length !== 3) return false
  if (lines[0] !== `Chrono Flash #${dayIndex}`) return false
  const solved = new RegExp(`^Score \\d+/${total} ${SHARE_DOT} \\d+:\\d{2}:\\d{2}$`)
  const dnf = `Score ${DNF_MARK}/${total} ${SHARE_DOT} DNF`
  if (lines[1] !== dnf && !solved.test(lines[1])) return false
  if (lines[1].includes('DNF') && lines[1].includes('0:00:00')) return false
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
  if (
    value.kind === 'dnf' &&
    typeof value.total === 'number' &&
    Number.isInteger(value.total) &&
    value.total >= MIN_ITEMS
  ) {
    return { kind: 'dnf', total: value.total }
  }
  if (
    value.kind === 'solved' &&
    typeof value.elapsedMs === 'number' &&
    Number.isFinite(value.elapsedMs) &&
    typeof value.correct === 'number' &&
    Number.isInteger(value.correct) &&
    value.correct >= 0 &&
    typeof value.total === 'number' &&
    Number.isInteger(value.total) &&
    value.total >= MIN_ITEMS &&
    value.correct <= value.total
  ) {
    return {
      kind: 'solved',
      elapsedMs: Math.max(0, Math.round(value.elapsedMs)),
      correct: value.correct,
      total: value.total,
    }
  }
  return null
}
