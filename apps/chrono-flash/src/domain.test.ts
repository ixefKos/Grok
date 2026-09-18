import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DAY1_ITEMS, batteryForDay, rotate90CW, sameCells } from './battery.ts'
import {
  MIN_FAMILIES,
  MIN_ITEMS,
  MEMORY_FLASH_MS,
  POST_TIME_INTENT,
  bootSession,
  buildPostTimeUrl,
  canStart,
  dayIndexFor,
  elapsedMs,
  formatElapsed,
  formatShare,
  isCanonicalShare,
  localDayKey,
  parseDayRecord,
  reduceSession,
  scoreAnswers,
  skillFamilies,
  type Battery,
  type Session,
} from './domain.ts'

const SHARE_URL = 'https://chrono-flash-xavierfouilleux-6035.vercel.app'
const TODAY = '2026-09-17'

function startRun(battery: Battery = batteryForDay(1)): Session {
  return reduceSession(
    { status: 'home', battery, record: null },
    { type: 'start', startedAt: 1_000, todayKey: TODAY },
  )
}

function answerAll(session: Session, choices: readonly string[], elapsed = 12_345): Session {
  return choices.reduce(
    (current, choice) => reduceSession(current, { type: 'answer', choice, elapsedMs: elapsed }),
    session,
  )
}

describe('day index', () => {
  it('maps the pack epoch to day 1', () => {
    assert.equal(dayIndexFor(new Date(2026, 8, 17, 15, 0, 0)), 1)
    assert.equal(localDayKey(new Date(2026, 8, 17, 23, 59, 0)), '2026-09-17')
  })

  it('cycles the 7-day index', () => {
    assert.equal(dayIndexFor(new Date(2026, 8, 18)), 2)
    assert.equal(dayIndexFor(new Date(2026, 8, 23)), 7)
    assert.equal(dayIndexFor(new Date(2026, 8, 24)), 1)
    assert.equal(dayIndexFor(new Date(2026, 8, 16)), 7)
  })
})

describe('day-1 pack coverage', () => {
  const battery = batteryForDay(1)
  const families = skillFamilies(battery)

  it('ships at least 6 items across at least 4 skill families', () => {
    assert.ok(battery.items.length >= MIN_ITEMS)
    assert.ok(families.length >= MIN_FAMILIES)
    assert.deepEqual(new Set(families), new Set(['pattern', 'verbal', 'spatial', 'logic', 'memory']))
  })

  it('is not a math-only or single-family snack', () => {
    const patternOnly = battery.items.every((item) => item.family === 'pattern')
    assert.equal(patternOnly, false)
    assert.ok(families.includes('verbal'))
    assert.ok(families.includes('spatial'))
    assert.ok(families.includes('logic'))
    assert.ok(families.includes('memory'))
  })

  it('implements the accepted day-1 prompts and keys verbatim', () => {
    assert.equal(DAY1_ITEMS[0]?.prompt, 'Which comes next? 2 · 4 · 8 · 16 · ?')
    assert.equal(DAY1_ITEMS[0]?.answer, '32')
    assert.deepEqual(
      DAY1_ITEMS[0]?.choices.map((choice) => choice.label),
      ['24', '32', '18', '30'],
    )

    assert.equal(DAY1_ITEMS[1]?.prompt, 'Odd one out: apple · banana · carrot · grape')
    assert.equal(DAY1_ITEMS[1]?.answer, 'carrot')

    assert.equal(DAY1_ITEMS[2]?.prompt, 'Which option is the same shape rotated 90° CW?')
    assert.equal(DAY1_ITEMS[2]?.answer, 'rot-90')

    assert.equal(
      DAY1_ITEMS[3]?.prompt,
      'All Flips are Glims. No Glims are Tarns. Can a Flip be a Tarn?',
    )
    assert.equal(DAY1_ITEMS[3]?.answer, 'No')
    assert.deepEqual(
      DAY1_ITEMS[3]?.choices.map((choice) => choice.label),
      ['Yes', 'No', 'Not enough info'],
    )

    assert.equal(DAY1_ITEMS[4]?.prompt, 'Which set matches?')
    assert.equal(DAY1_ITEMS[4]?.answer, '★ ◆ ○')
    assert.deepEqual(DAY1_ITEMS[4]?.flash, ['★', '◆', '○'])
    assert.equal(DAY1_ITEMS[4]?.flashMs, MEMORY_FLASH_MS)
    assert.deepEqual(
      DAY1_ITEMS[4]?.choices.map((choice) => choice.label),
      ['★ ◆ ○', '★ ○ ◆', '◆ ★ ○', '★ ◆ △'],
    )

    assert.equal(DAY1_ITEMS[5]?.prompt, 'Complete: A C E G ?')
    assert.equal(DAY1_ITEMS[5]?.answer, 'I')
    assert.deepEqual(
      DAY1_ITEMS[5]?.choices.map((choice) => choice.label),
      ['H', 'I', 'J', 'F'],
    )
  })

  it('makes the spatial key the L-tetromino rotated 90° CW', () => {
    const spatial = DAY1_ITEMS[2]
    assert.ok(spatial?.promptShape)
    const correct = spatial.choices.find((choice) => choice.id === spatial.answer)
    assert.ok(correct?.shape)
    assert.equal(sameCells(correct.shape, rotate90CW(spatial.promptShape)), true)
    const nearMisses = spatial.choices.filter((choice) => choice.id !== spatial.answer)
    assert.equal(nearMisses.length, 3)
    for (const option of nearMisses) {
      assert.ok(option.shape)
      assert.equal(sameCells(option.shape, rotate90CW(spatial.promptShape)), false)
    }
  })
})

describe('timer', () => {
  it('measures elapsed from a start mark without pause math', () => {
    assert.equal(elapsedMs(1000, 4500), 3500)
    assert.equal(elapsedMs(1000, 900), 0)
  })

  it('formats share time as H:MM:SS', () => {
    assert.equal(formatElapsed(0), '0:00:00')
    assert.equal(formatElapsed(1500), '0:00:01')
    assert.equal(formatElapsed(61_000), '0:01:01')
    assert.equal(formatElapsed(3_661_000), '1:01:01')
  })

  it('keeps the start mark across the whole battery', () => {
    const playing = startRun()
    assert.equal(playing.status, 'playing')
    if (playing.status !== 'playing') return
    const mid = reduceSession(playing, { type: 'answer', choice: '32', elapsedMs: 4000 })
    assert.equal(mid.status, 'playing')
    if (mid.status !== 'playing') return
    assert.equal(mid.startedAt, playing.startedAt)
    assert.equal(mid.index, 1)
  })
})

describe('scoring', () => {
  it('counts correct answers over the full battery', () => {
    const battery = batteryForDay(1)
    assert.equal(scoreAnswers(battery, ['32', 'carrot', 'rot-90', 'No', '★ ◆ ○', 'I']), 6)
    assert.equal(scoreAnswers(battery, ['24', 'apple', 'mirror', 'Yes', '★ ○ ◆', 'H']), 0)
    assert.equal(scoreAnswers(battery, ['32', 'apple', 'rot-90', 'Yes', '★ ◆ ○', 'H']), 3)
  })

  it('finishes a mixed run as Score A/B with the live elapsed', () => {
    const result = answerAll(startRun(), ['32', 'apple', 'rot-90', 'Yes', '★ ◆ ○', 'H'], 125_000)
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, {
      kind: 'solved',
      elapsedMs: 125_000,
      correct: 3,
      total: 6,
    })
    const paste = formatShare({
      dayIndex: 1,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #1\nScore 3/6 · 0:02:05\n${SHARE_URL}`)
  })
})

describe('soft retry off', () => {
  const record = {
    dayKey: TODAY,
    dayIndex: 1 as const,
    outcome: { kind: 'solved' as const, elapsedMs: 12_000, correct: 4, total: 6 },
  }

  it('blocks a second start on the same day key', () => {
    assert.equal(canStart(null, TODAY), true)
    assert.equal(canStart(record, TODAY), false)
    assert.equal(canStart(record, '2026-09-18'), true)
  })

  it('boots a finished day on result, not home', () => {
    const session = bootSession(batteryForDay(1), record, TODAY)
    assert.equal(session.status, 'result')
    if (session.status === 'result') {
      assert.deepEqual(session.outcome, record.outcome)
    }
  })

  it('ignores start after a result', () => {
    const result = answerAll(startRun(), ['32', 'carrot', 'rot-90', 'No', '★ ◆ ○', 'I'])
    const again = reduceSession(result, { type: 'start', startedAt: 99, todayKey: TODAY })
    assert.equal(again.status, 'result')
  })

  it('refuses a second official start when today is already recorded', () => {
    const blocked = reduceSession(
      { status: 'home', battery: batteryForDay(1), record },
      { type: 'start', startedAt: 1, todayKey: TODAY },
    )
    assert.equal(blocked.status, 'home')
  })
})

describe('share unit', () => {
  it('pastes Score A/B, time, and url on a solve', () => {
    const paste = formatShare({
      dayIndex: 3,
      outcome: { kind: 'solved', elapsedMs: 125_000, correct: 5, total: 6 },
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #3\nScore 5/6 · 0:02:05\n${SHARE_URL}`)
    assert.equal(isCanonicalShare(paste, 3, SHARE_URL, 6), true)
  })

  it('records DNF as Score —/B · DNF without a fake fast time', () => {
    const playing = startRun(batteryForDay(2))
    const afterTwo = answerAll(playing, ['32', 'carrot'], 8000)
    const result = reduceSession(afterTwo, { type: 'dnf' })
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, { kind: 'dnf', total: 6 })
    const paste = formatShare({
      dayIndex: 2,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #2\nScore —/6 · DNF\n${SHARE_URL}`)
    assert.equal(paste.includes('0:00:00'), false)
    assert.equal(isCanonicalShare(paste, 2, SHARE_URL, 6), true)
  })

  it('keeps the share card spoiler-safe and builds an X intent URL', () => {
    const outcome = { kind: 'solved' as const, elapsedMs: 4000, correct: 6, total: 6 }
    const paste = formatShare({ dayIndex: 1, outcome, url: SHARE_URL })
    assert.equal(isCanonicalShare(paste, 1, SHARE_URL, 6), true)
    assert.equal(paste.split('\n').length, 3)
    for (const item of DAY1_ITEMS) {
      assert.equal(paste.includes(item.prompt), false)
      for (const choice of item.choices) {
        if (choice.label.length <= 1) continue
        assert.equal(paste.includes(choice.label), false)
      }
    }
    const intent = buildPostTimeUrl(paste)
    assert.equal(intent.startsWith(`${POST_TIME_INTENT}?text=`), true)
    assert.equal(decodeURIComponent(intent.slice(`${POST_TIME_INTENT}?text=`.length)), paste)
    assert.equal(intent.toLowerCase().includes('copy'), false)
  })
})

describe('storage boundary', () => {
  it('rejects a malformed or snack-era record', () => {
    assert.equal(parseDayRecord(null), null)
    assert.equal(parseDayRecord({ dayKey: 'nope', dayIndex: 1, outcome: { kind: 'dnf' } }), null)
    assert.equal(
      parseDayRecord({
        dayKey: '2026-09-17',
        dayIndex: 1,
        outcome: { kind: 'solved', elapsedMs: 1200 },
      }),
      null,
    )
    assert.equal(
      parseDayRecord({
        dayKey: '2026-09-17',
        dayIndex: 1,
        outcome: { kind: 'dnf' },
      }),
      null,
    )
  })

  it('accepts a valid battery record', () => {
    const parsed = parseDayRecord({
      dayKey: '2026-09-17',
      dayIndex: 1,
      outcome: { kind: 'solved', elapsedMs: 8800, correct: 4, total: 6 },
    })
    assert.deepEqual(parsed, {
      dayKey: '2026-09-17',
      dayIndex: 1,
      outcome: { kind: 'solved', elapsedMs: 8800, correct: 4, total: 6 },
    })
  })
})
