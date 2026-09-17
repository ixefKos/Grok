import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bootSession,
  canStart,
  dayIndexFor,
  elapsedMs,
  formatElapsed,
  formatShare,
  localDayKey,
  parseDayRecord,
  isCanonicalShare,
  reduceSession,
} from './domain.ts'
import { PUZZLES, puzzleForDay } from './puzzles.ts'

const SHARE_URL = 'https://chrono-flash-probe.vercel.app'

describe('day index', () => {
  it('maps the pack epoch to day 1', () => {
    assert.equal(dayIndexFor(new Date(2026, 8, 17, 15, 0, 0)), 1)
    assert.equal(localDayKey(new Date(2026, 8, 17, 23, 59, 0)), '2026-09-17')
  })

  it('cycles the 7-day pack', () => {
    assert.equal(dayIndexFor(new Date(2026, 8, 18)), 2)
    assert.equal(dayIndexFor(new Date(2026, 8, 23)), 7)
    assert.equal(dayIndexFor(new Date(2026, 8, 24)), 1)
    assert.equal(dayIndexFor(new Date(2026, 8, 16)), 7)
  })
})

describe('timer', () => {
  it('measures elapsed from a start mark without pause math', () => {
    assert.equal(elapsedMs(1000, 4500), 3500)
    assert.equal(elapsedMs(1000, 900), 0)
  })

  it('formats the share time as H:MM:SS', () => {
    assert.equal(formatElapsed(0), '0:00:00')
    assert.equal(formatElapsed(1500), '0:00:01')
    assert.equal(formatElapsed(61_000), '0:01:01')
    assert.equal(formatElapsed(3_661_000), '1:01:01')
  })
})

describe('one official run per day', () => {
  const today = '2026-09-17'
  const record = {
    dayKey: today,
    dayIndex: 1 as const,
    outcome: { kind: 'solved' as const, elapsedMs: 12_000 },
  }

  it('blocks a second start on the same day key', () => {
    assert.equal(canStart(null, today), true)
    assert.equal(canStart(record, today), false)
    assert.equal(canStart(record, '2026-09-18'), true)
  })

  it('boots a finished day on result, not home', () => {
    const session = bootSession(puzzleForDay(1), record, today)
    assert.equal(session.status, 'result')
    if (session.status === 'result') {
      assert.deepEqual(session.outcome, record.outcome)
    }
  })

  it('ignores start after a result', () => {
    const playing = reduceSession(
      { status: 'home', puzzle: puzzleForDay(1), record: null },
      { type: 'start', startedAt: 10, todayKey: '2026-09-17' },
    )
    const result = reduceSession(playing, { type: 'solve', elapsedMs: 2345 })
    const again = reduceSession(result, { type: 'start', startedAt: 99 })
    assert.equal(again.status, 'result')
  })
})

describe('share unit', () => {
  it('pastes day, time, and url only on a solve', () => {
    const paste = formatShare({
      dayIndex: 3,
      outcome: { kind: 'solved', elapsedMs: 125_000 },
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #3\n0:02:05\n${SHARE_URL}`)
  })

  it('records DNF without a fake fast time', () => {
    const playing = reduceSession(
      { status: 'home', puzzle: puzzleForDay(2), record: null },
      { type: 'start', startedAt: 0, todayKey: '2026-09-17' },
    )
    const result = reduceSession(playing, { type: 'dnf' })
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    const paste = formatShare({
      dayIndex: 2,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #2\nDNF\n${SHARE_URL}`)
    assert.equal(paste.includes('0:00:00'), false)
  })

  it('keeps every shipped puzzle to a three-line time card', () => {
    assert.equal(PUZZLES.length, 7)
    for (const puzzle of PUZZLES) {
      assert.equal(puzzle.choices.includes(puzzle.answer), true)
      const paste = formatShare({
        dayIndex: puzzle.day,
        outcome: { kind: 'solved', elapsedMs: 4000 },
        url: SHARE_URL,
      })
      assert.equal(isCanonicalShare(paste, puzzle.day, SHARE_URL), true)
      assert.equal(paste.includes(puzzle.prompt), false)
      assert.equal(paste.split('\n').length, 3)
    }
  })

  it('refuses a second official start on the same day', () => {
    const blocked = reduceSession(
      {
        status: 'home',
        puzzle: puzzleForDay(1),
        record: {
          dayKey: '2026-09-17',
          dayIndex: 1,
          outcome: { kind: 'solved', elapsedMs: 9000 },
        },
      },
      { type: 'start', startedAt: 1, todayKey: '2026-09-17' },
    )
    assert.equal(blocked.status, 'home')
  })
})

describe('storage boundary', () => {
  it('rejects a malformed record', () => {
    assert.equal(parseDayRecord(null), null)
    assert.equal(parseDayRecord({ dayKey: 'nope', dayIndex: 1, outcome: { kind: 'dnf' } }), null)
    assert.equal(
      parseDayRecord({
        dayKey: '2026-09-17',
        dayIndex: 1,
        outcome: { kind: 'solved' },
      }),
      null,
    )
  })

  it('accepts a valid record', () => {
    const parsed = parseDayRecord({
      dayKey: '2026-09-17',
      dayIndex: 1,
      outcome: { kind: 'dnf' },
    })
    assert.deepEqual(parsed, {
      dayKey: '2026-09-17',
      dayIndex: 1,
      outcome: { kind: 'dnf' },
    })
  })
})
