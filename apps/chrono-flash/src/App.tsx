import { useEffect, useMemo, useState } from 'react'
import { batteryForDay } from './battery.ts'
import {
  bootSession,
  buildPostTimeUrl,
  dayIndexFor,
  dayLockEnabled,
  isSoftHost,
  elapsedMs,
  formatElapsed,
  formatShare,
  localDayKey,
  reduceSession,
  skillFamilies,
  type BatteryItem,
  type BylineCard as Byline,
  type Cell,
  type DayRecord,
  type Session,
} from './domain.ts'
import { SOFT_KICKER, SOFT_TIP, SOFT_TITLE } from './soft-label.ts'
import { loadRecord, saveRecord } from './storage.ts'

function shareUrl(): string {
  return window.location.origin + window.location.pathname
}

function hostGate() {
  return {
    dev: import.meta.env.DEV,
    hostname: window.location.hostname,
    envFlag: import.meta.env.VITE_SOFT_UNLOCK === '1',
  }
}

function hostDayLock(): boolean {
  return dayLockEnabled(hostGate())
}

function hostSoftLabel(): boolean {
  return isSoftHost(hostGate())
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

const SHAPE_CELL_PX = 18
const SHAPE_GAP_PX = 3
const BYLINE_W = 112
const BYLINE_H = 68
const BYLINE_BOX = 120

function shapeBoardSize(count: number): number {
  return count * SHAPE_CELL_PX + Math.max(0, count - 1) * SHAPE_GAP_PX
}

function ShapeGrid({ cells }: { cells: readonly Cell[] }) {
  const rows = Math.max(3, ...cells.map(([row]) => row + 1))
  const cols = Math.max(3, ...cells.map(([, col]) => col + 1))
  const filled = new Set(cells.map(cellKey))
  const width = shapeBoardSize(cols)
  const height = shapeBoardSize(rows)
  return (
    <div
      className="shape-board"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${cols}, ${SHAPE_CELL_PX}px)`,
        gridTemplateRows: `repeat(${rows}, ${SHAPE_CELL_PX}px)`,
        gap: SHAPE_GAP_PX,
        width,
        height,
        minWidth: width,
        minHeight: height,
      }}
      aria-hidden="true"
    >
      {Array.from({ length: rows * cols }, (_, index) => {
        const row = Math.floor(index / cols)
        const col = index % cols
        const on = filled.has(`${row},${col}`)
        return (
          <span
            key={`${row}-${col}`}
            className={on ? 'shape-cell on' : 'shape-cell'}
            style={{
              display: 'block',
              width: SHAPE_CELL_PX,
              height: SHAPE_CELL_PX,
              minWidth: SHAPE_CELL_PX,
              minHeight: SHAPE_CELL_PX,
            }}
          />
        )
      })}
    </div>
  )
}

function BylineCard({ card }: { card: Byline }) {
  return (
    <div
      className="byline-board"
      style={{
        display: 'grid',
        placeItems: 'center',
        width: BYLINE_BOX,
        height: BYLINE_BOX,
        minWidth: BYLINE_BOX,
        minHeight: BYLINE_BOX,
      }}
      aria-hidden="true"
    >
      <svg
        className="byline-card"
        width={BYLINE_W}
        height={BYLINE_H}
        viewBox={`0 0 ${BYLINE_W} ${BYLINE_H}`}
        style={{
          display: 'block',
          width: BYLINE_W,
          height: BYLINE_H,
          minWidth: BYLINE_W,
          minHeight: BYLINE_H,
          transform: `rotate(${card.rotate}deg)`,
          transformOrigin: 'center center',
        }}
      >
        <rect
          x="1.5"
          y="1.5"
          width={BYLINE_W - 3}
          height={BYLINE_H - 3}
          rx="7"
          fill="#12141a"
          stroke="#2a2f3a"
          strokeWidth="1.5"
        />
        <rect x="8" y="10" width="28" height="6" rx="1.5" fill="#f2b705" />
        <text x="10" y="32" fill="#f4f1ea" fontSize="11" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
          {card.name}
        </text>
        <text x="10" y="46" fill="#9aa1ad" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
          {card.outlet}
        </text>
        <text x="10" y="58" fill="#9aa1ad" fontSize="10" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
          {card.time}
        </text>
      </svg>
    </div>
  )
}

function SpatialPrompt({ item }: { item: BatteryItem }) {
  if (item.promptByline) return <BylineCard card={item.promptByline} />
  if (item.promptShape) return <ShapeGrid cells={item.promptShape} />
  return null
}

function SpatialChoice({ item }: { item: ChoiceLike }) {
  if (item.byline) return <BylineCard card={item.byline} />
  if (item.shape) return <ShapeGrid cells={item.shape} />
  return item.label
}

type ChoiceLike = BatteryItem['choices'][number]

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
        {(item.flash ?? []).join(' · ')}
      </p>
    )
  }
  return (
    <>
      <p className="prompt">{item.prompt}</p>
      {item.kind === 'spatial' ? <SpatialPrompt item={item} /> : null}
    </>
  )
}

export default function App() {
  const today = useMemo(() => todayParts(), [])
  const dayLock = hostDayLock()
  const softLabel = hostSoftLabel()
  const [session, setSession] = useState<Session>(() =>
    bootSession(today.battery, loadRecord(window.localStorage), today.dayKey, dayLock),
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
    if (!dayLock) return
    persistResult(session, today.dayKey)
  }, [dayLock, session, today.dayKey])

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
        dayLock,
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
        <p className="kicker">{softLabel ? SOFT_KICKER : 'Daily IQ battery'}</p>
        <h1>{softLabel ? SOFT_TITLE : 'Chrono Flash'}</h1>
        <p className="day">
          #{today.dayIndex}
          {softLabel ? ` · ${SOFT_TIP}` : null}
        </p>
      </header>

      {session.status === 'home' ? (
        <section className="card">
          <p className="lede">
            Six mixed-skill items. One official timed run today. No practice retry.
          </p>
          <p className="mix">{skillFamilies(today.battery).join(' · ')}</p>
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
                    choice.shape || choice.byline
                      ? 'choice shape-choice'
                      : current.kind === 'memory'
                        ? 'choice memory-choice'
                        : 'choice'
                  }
                  onClick={() => choose(choice.id)}
                >
                  {choice.shape || choice.byline ? <SpatialChoice item={choice} /> : choice.label}
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
        </section>
      ) : null}
    </main>
  )
}
