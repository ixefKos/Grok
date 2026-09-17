import { useEffect, useMemo, useRef, useState } from 'react'
import {
  bootSession,
  dayIndexFor,
  elapsedMs,
  formatElapsed,
  formatShare,
  localDayKey,
  reduceSession,
  type DayRecord,
  type Session,
} from './domain.ts'
import { puzzleForDay } from './puzzles.ts'
import { loadRecord, saveRecord } from './storage.ts'

function shareUrl(): string {
  return window.location.origin + window.location.pathname
}

function todayParts(now = new Date()) {
  const dayKey = localDayKey(now)
  const dayIndex = dayIndexFor(now)
  return { dayKey, dayIndex, puzzle: puzzleForDay(dayIndex) }
}

function persistResult(session: Session, dayKey: string): DayRecord | null {
  if (session.status !== 'result') return null
  const record: DayRecord = {
    dayKey,
    dayIndex: session.puzzle.day,
    outcome: session.outcome,
  }
  saveRecord(window.localStorage, record)
  return record
}

export default function App() {
  const today = useMemo(() => todayParts(), [])
  const [session, setSession] = useState<Session>(() =>
    bootSession(today.puzzle, loadRecord(window.localStorage), today.dayKey),
  )
  const [nowMs, setNowMs] = useState(() => performance.now())
  const [copied, setCopied] = useState(false)
  const [wrong, setWrong] = useState<string[]>([])
  const copyReset = useRef<number>(0)

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
    setWrong([])
    setCopied(false)
    setSession((current) =>
      reduceSession(current, {
        type: 'start',
        startedAt: performance.now(),
        todayKey: today.dayKey,
      }),
    )
  }

  function choose(choice: string) {
    if (session.status !== 'playing') return
    if (choice === session.puzzle.answer) {
      setSession((current) =>
        reduceSession(current, {
          type: 'solve',
          elapsedMs: elapsedMs(current.status === 'playing' ? current.startedAt : 0, performance.now()),
        }),
      )
      return
    }
    setWrong((current) => (current.includes(choice) ? current : [...current, choice]))
  }

  function giveUp() {
    setSession((current) => reduceSession(current, { type: 'dnf' }))
  }

  async function copyShare() {
    if (session.status !== 'result') return
    const text = formatShare({
      dayIndex: session.puzzle.day,
      outcome: session.outcome,
      url: shareUrl(),
    })
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
    setCopied(true)
    window.clearTimeout(copyReset.current)
    copyReset.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <main className="shell">
      <header className="brand">
        <p className="kicker">Daily pattern</p>
        <h1>Chrono Flash</h1>
        <p className="day">#{today.dayIndex}</p>
      </header>

      {session.status === 'home' ? (
        <section className="card">
          <p className="lede">One official timed run today. No practice retry.</p>
          <button type="button" className="primary" onClick={start}>
            Start
          </button>
        </section>
      ) : null}

      {session.status === 'playing' ? (
        <section className="card">
          <p className="timer" aria-live="polite" aria-atomic="true">
            {formatElapsed(liveElapsed)}
          </p>
          <p className="prompt">{session.puzzle.prompt}</p>
          <ol className="sequence">
            {session.puzzle.items.map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
            <li className="unknown" aria-label="unknown">
              ?
            </li>
          </ol>
          <div className="choices">
            {session.puzzle.choices.map((choice) => (
              <button
                key={choice}
                type="button"
                className={wrong.includes(choice) ? 'choice wrong' : 'choice'}
                disabled={wrong.includes(choice)}
                onClick={() => choose(choice)}
              >
                {choice}
              </button>
            ))}
          </div>
          <button type="button" className="ghost" onClick={giveUp}>
            Give up
          </button>
        </section>
      ) : null}

      {session.status === 'result' ? (
        <section className="card">
          <p className="lede">
            {session.outcome.kind === 'solved' ? 'Official time' : 'Did not finish'}
          </p>
          <p className="timer result">
            {session.outcome.kind === 'solved'
              ? formatElapsed(session.outcome.elapsedMs)
              : 'DNF'}
          </p>
          <pre className="share-card" aria-label="Share card">
            {formatShare({
              dayIndex: session.puzzle.day,
              outcome: session.outcome,
              url: shareUrl(),
            })}
          </pre>
          <button type="button" className="primary" onClick={copyShare}>
            {copied ? 'Copied' : 'Copy time'}
          </button>
          <p className="note">Come back tomorrow for the next pattern.</p>
        </section>
      ) : null}
    </main>
  )
}
