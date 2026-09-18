import { useEffect, useMemo, useState } from 'react'
import { batteryForDay } from './battery.ts'
import {
  allowSoftReset,
  buildPostTimeUrl,
  bootSession,
  dayIndexFor,
  elapsedMs,
  formatElapsed,
  formatShare,
  localDayKey,
  reduceSession,
  type BatteryItem,
  type Cell,
  type DayRecord,
  type Session,
} from './domain.ts'
import { clearRecord, loadRecord, saveRecord } from './storage.ts'

function shareUrl(): string {
  return window.location.origin + window.location.pathname
}

function softResetEnabled(): boolean {
  return allowSoftReset({
    dev: import.meta.env.DEV,
    hostname: window.location.hostname,
    search: window.location.search,
    envFlag: import.meta.env.VITE_SOFT_RESET === '1',
  })
}

function todayParts(now = new Date()) {
  const dayKey = localDayKey(now)
  const dayIndex = dayIndexFor(now)
  return { dayKey, dayIndex, battery: batteryForDay(dayIndex) }
}

function persistResult(session: Session, dayKey: string): DayRecord | null {
  if (session.status !== 'result') return null
  const record: DayRecord = {
    dayKey,
    dayIndex: session.battery.day,
    outcome: session.outcome,
  }
  saveRecord(window.localStorage, record)
  return record
}

function cellKey(cell: Cell): string {
  return `${cell[0]},${cell[1]}`
}

function ShapeGrid({ cells }: { cells: readonly Cell[] }) {
  const rows = Math.max(3, ...cells.map(([row]) => row + 1))
  const cols = Math.max(3, ...cells.map(([, col]) => col + 1))
  const filled = new Set(cells.map(cellKey))
  return (
    <div
      className="shape-board"
      style={{ gridTemplateColumns: `repeat(${cols}, 1.15rem)` }}
      aria-hidden="true"
    >
      {Array.from({ length: rows * cols }, (_, index) => {
        const row = Math.floor(index / cols)
        const col = index % cols
        const on = filled.has(`${row},${col}`)
        return <span key={`${row}-${col}`} className={on ? 'shape-cell on' : 'shape-cell'} />
      })}
    </div>
  )
}

function choicesClass(item: BatteryItem): string {
  if (item.kind === 'spatial') return 'choices spatial'
  if (item.kind === 'memory') return 'choices memory'
  if (item.choices.length === 3) return 'choices triple'
  return 'choices'
}

function ItemPrompt({ item, memoryReady }: { item: BatteryItem; memoryReady: boolean }) {
  if (item.kind === 'memory' && !memoryReady) {
    return (
      <p className="flash-set" aria-label="Memorize this set">
        {(item.flash ?? []).join(' ')}
      </p>
    )
  }
  return (
    <>
      <p className="prompt">{item.prompt}</p>
      {item.kind === 'spatial' && item.promptShape ? <ShapeGrid cells={item.promptShape} /> : null}
    </>
  )
}

export default function App() {
  const today = useMemo(() => todayParts(), [])
  const [session, setSession] = useState<Session>(() =>
    bootSession(today.battery, loadRecord(window.localStorage), today.dayKey),
  )
  const [nowMs, setNowMs] = useState(() => performance.now())
  const [fallbackCopied, setFallbackCopied] = useState(false)
  const [memoryUnlockAt, setMemoryUnlockAt] = useState(0)

  const current = session.status === 'playing' ? session.battery.items[session.index] : null
  const memoryReady =
    !current || current.kind !== 'memory' || nowMs >= memoryUnlockAt
  const memoryFlashing = Boolean(current && current.kind === 'memory' && !memoryReady)

  useEffect(() => {
    if (session.status !== 'playing') return
    let frame = 0
    const tick = (t: number) => {
      setNowMs(t)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [session.status])

  useEffect(() => {
    persistResult(session, today.dayKey)
  }, [session, today.dayKey])

  const liveElapsed =
    session.status === 'playing' ? elapsedMs(session.startedAt, nowMs) : 0

  function start() {
    const mark = performance.now()
    setFallbackCopied(false)
    const first = today.battery.items[0]
    if (first?.kind === 'memory') {
      setMemoryUnlockAt(mark + (first.flashMs ?? 2500))
    }
    setSession((currentSession) =>
      reduceSession(currentSession, {
        type: 'start',
        startedAt: mark,
        todayKey: today.dayKey,
      }),
    )
  }

  function choose(choice: string) {
    if (session.status !== 'playing') return
    const mark = performance.now()
    const upcoming = session.battery.items[session.index + 1]
    if (upcoming?.kind === 'memory') {
      setMemoryUnlockAt(mark + (upcoming.flashMs ?? 2500))
    }
    setSession((currentSession) =>
      reduceSession(currentSession, {
        type: 'answer',
        choice,
        elapsedMs: elapsedMs(
          currentSession.status === 'playing' ? currentSession.startedAt : 0,
          mark,
        ),
      }),
    )
  }

  function giveUp() {
    setSession((currentSession) => reduceSession(currentSession, { type: 'dnf' }))
  }

  function resetDay() {
    clearRecord(window.localStorage)
    setFallbackCopied(false)
    setSession(bootSession(today.battery, null, today.dayKey))
  }

  async function copyFallback(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setFallbackCopied(true)
  }

  function postTime() {
    if (session.status !== 'result') return
    const text = formatShare({
      dayIndex: session.battery.day,
      outcome: session.outcome,
      url: shareUrl(),
    })
    const intent = buildPostTimeUrl(text)
    const popup = window.open(intent, '_blank', 'noopener,noreferrer')
    if (popup == null) {
      void copyFallback(text)
    }
  }

  const shareText =
    session.status === 'result'
      ? formatShare({
          dayIndex: session.battery.day,
          outcome: session.outcome,
          url: shareUrl(),
        })
      : ''

  return (
    <main className="shell">
      <header className="brand">
        <p className="kicker">Daily IQ battery</p>
        <h1>Chrono Flash</h1>
        <p className="day">#{today.dayIndex}</p>
      </header>

      {session.status === 'home' ? (
        <section className="card">
          <p className="lede">
            Six mixed-skill items. One official timed run today. No practice retry.
          </p>
          <button type="button" className="primary" onClick={start}>
            Start
          </button>
        </section>
      ) : null}

      {session.status === 'playing' && current ? (
        <section className="card playing">
          <p className="timer" aria-live="polite" aria-atomic="true">
            {formatElapsed(liveElapsed)}
          </p>
          <p className="progress">
            {session.index + 1} / {session.battery.items.length}
          </p>
          <ItemPrompt item={current} memoryReady={memoryReady} />
          {memoryFlashing ? null : (
            <div className={choicesClass(current)}>
              {current.choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={
                    choice.shape
                      ? 'choice shape-choice'
                      : current.kind === 'memory'
                        ? 'choice memory-choice'
                        : 'choice'
                  }
                  onClick={() => choose(choice.id)}
                >
                  {choice.shape ? <ShapeGrid cells={choice.shape} /> : choice.label}
                </button>
              ))}
            </div>
          )}
          {memoryFlashing ? null : (
            <button type="button" className="ghost give-up" onClick={giveUp}>
              Give up
            </button>
          )}
        </section>
      ) : null}

      {session.status === 'result' ? (
        <section className="card">
          <p className="lede">
            {session.outcome.kind === 'solved' ? 'Official run' : 'Did not finish'}
          </p>
          <p className="score">
            {session.outcome.kind === 'solved'
              ? `Score ${session.outcome.correct}/${session.outcome.total}`
              : `Score —/${session.outcome.total}`}
          </p>
          <p className={session.outcome.kind === 'solved' ? 'timer result solved' : 'timer result dnf'}>
            {session.outcome.kind === 'solved'
              ? formatElapsed(session.outcome.elapsedMs)
              : 'DNF'}
          </p>
          <pre className="share-card" aria-label="Share card">
            {shareText}
          </pre>
          <button type="button" className="primary" onClick={postTime}>
            Post time
          </button>
          {fallbackCopied ? (
            <p className="note">Intent blocked. Score card copied as a fallback.</p>
          ) : (
            <p className="note">Come back tomorrow for the next battery.</p>
          )}
          {softResetEnabled() ? (
            <button type="button" className="ghost reset-day" onClick={resetDay}>
              Reset day
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  )
}
