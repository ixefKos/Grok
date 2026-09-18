import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DAY1_ITEMS, batteryForDay } from './battery.ts'
import {
  MIN_FAMILIES,
  MIN_ITEMS,
  MEMORY_FLASH_MS,
  POST_TIME_INTENT,
  bootSession,
  buildPostTimeUrl,
  canStart,
  dayIndexFor,
  dayLockEnabled,
  isSoftHost,
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
    assert.deepEqual(
      new Set(families),
      new Set(['verbal', 'logic', 'attention', 'pattern', 'memory', 'spatial']),
    )
    assert.equal(families.join(' · '), 'verbal · logic · attention · pattern · memory · spatial')
  })

  it('is not a math-only, snack, literacy, or Fed/UN event pack', () => {
    const patternOnly = battery.items.every((item) => item.family === 'pattern')
    assert.equal(patternOnly, false)
    const blob = JSON.stringify(DAY1_ITEMS)
    assert.equal(blob.includes('Publish'), false)
    assert.equal(blob.includes('Sponsored'), false)
    assert.equal(blob.includes('leaked rumor'), false)
    assert.equal(blob.includes('Wire Desk'), false)
    assert.equal(blob.includes('YANOS'), false)
    assert.equal(blob.includes('3.75%'), false)
    assert.ok(families.includes('verbal'))
    assert.ok(families.includes('spatial'))
    assert.ok(families.includes('logic'))
    assert.ok(families.includes('memory'))
    assert.ok(families.includes('attention'))
    const mix = families.join(' · ')
    assert.equal(mix.includes('pattern'), true)
    assert.notEqual(mix, 'pattern')
    assert.ok(mix.split(' · ').length >= 6)
  })

  it('implements the accepted XTRENDS day-1 prompts and keys', () => {
    assert.equal(DAY1_ITEMS[0]?.prompt, 'On US X trends, #DETvsBUF is which matchup?')
    assert.equal(DAY1_ITEMS[0]?.answer, 'Lions at Bills')
    assert.equal(
      DAY1_ITEMS[0]?.choices.find((choice) => choice.id === DAY1_ITEMS[0].answer)?.label,
      'Detroit Lions at Buffalo Bills',
    )

    assert.equal(DAY1_ITEMS[1]?.prompt, 'Where is that #DETvsBUF game being played?')
    assert.equal(DAY1_ITEMS[1]?.answer, 'Highmark')
    assert.equal(
      DAY1_ITEMS[1]?.choices.find((choice) => choice.id === DAY1_ITEMS[1].answer)?.label,
      'Highmark Stadium (Orchard Park)',
    )

    assert.equal(DAY1_ITEMS[2]?.prompt, 'Josh Allen is quarterback for which team?')
    assert.equal(DAY1_ITEMS[2]?.answer, 'Bills')

    assert.equal(DAY1_ITEMS[3]?.family, 'attention')
    assert.equal(DAY1_ITEMS[3]?.prompt, 'Which name is on US X trends for this Soft evening?')
    assert.equal(DAY1_ITEMS[3]?.answer, 'Campbell')

    assert.equal(DAY1_ITEMS[4]?.prompt, 'Which cluster is the Lions-side X-trends set?')
    assert.equal(DAY1_ITEMS[4]?.answer, 'lions-cluster')
    assert.equal(
      DAY1_ITEMS[4]?.choices.find((choice) => choice.id === 'lions-cluster')?.label,
      'Goff · Gibbs · #OnePride · Dan Campbell',
    )

    assert.equal(DAY1_ITEMS[5]?.prompt, 'Which set matches?')
    assert.deepEqual(DAY1_ITEMS[5]?.flash, ['#DETvsBUF', 'Josh Allen', 'Goff', '#OnePride'])
    assert.equal(DAY1_ITEMS[5]?.flashMs, MEMORY_FLASH_MS)
    assert.equal(DAY1_ITEMS[5]?.answer, 'match')

    assert.equal(
      DAY1_ITEMS[6]?.prompt,
      'Which club is on the worldwide X trends list this Soft evening?',
    )
    assert.equal(DAY1_ITEMS[6]?.answer, 'Flamengo')

    assert.equal(DAY1_ITEMS[7]?.prompt, 'Which trend card is the same card rotated 90° CW?')
    assert.equal(DAY1_ITEMS[7]?.answer, 'rot-90')
  })

  it('never asks the DET–BUF final score', () => {
    const blob = JSON.stringify(DAY1_ITEMS)
    assert.equal(/\bfinal score\b/i.test(blob), false)
    assert.equal(/\bwho won\b/i.test(blob), false)
    assert.equal(/\b\d+\s*[-–]\s*\d+\b/.test(blob), false)
  })

  it('makes the spatial key the trend card rotated 90° CW', () => {
    const spatial = DAY1_ITEMS[7]
    assert.ok(spatial?.promptByline)
    assert.equal(spatial.promptByline.rotate, 0)
    assert.equal(spatial.promptByline.name, '#DETvsBUF')
    const correct = spatial.choices.find((choice) => choice.id === spatial.answer)
    assert.ok(correct?.byline)
    assert.equal(correct.byline.rotate, 90)
    assert.equal(correct.byline.name, spatial.promptByline.name)
    assert.equal(correct.byline.outlet, spatial.promptByline.outlet)
    const nearMisses = spatial.choices.filter((choice) => choice.id !== spatial.answer)
    assert.equal(nearMisses.length, 3)
    for (const option of nearMisses) {
      assert.ok(option.byline)
      assert.equal(option.byline.rotate === 90, false)
      assert.equal(option.byline.name, spatial.promptByline.name)
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
    const mid = reduceSession(playing, { type: 'answer', choice: 'Lions at Bills', elapsedMs: 4000 })
    assert.equal(mid.status, 'playing')
    if (mid.status !== 'playing') return
    assert.equal(mid.startedAt, playing.startedAt)
    assert.equal(mid.index, 1)
  })
})

describe('scoring', () => {
  it('counts correct answers over the full battery', () => {
    const battery = batteryForDay(1)
    assert.equal(
      scoreAnswers(battery, [
        'Lions at Bills',
        'Highmark',
        'Bills',
        'Campbell',
        'lions-cluster',
        'match',
        'Flamengo',
        'rot-90',
      ]),
      8,
    )
    assert.equal(
      scoreAnswers(battery, [
        'Bills at Lions',
        'Ford Field',
        'Lions',
        'Belichick',
        'bills-cluster',
        'swap-qbs',
        'Real Madrid',
        'rot-0',
      ]),
      0,
    )
    assert.equal(
      scoreAnswers(battery, [
        'Lions at Bills',
        'Ford Field',
        'Bills',
        'Belichick',
        'lions-cluster',
        'swap-qbs',
        'Flamengo',
        'rot-0',
      ]),
      4,
    )
  })

  it('finishes a mixed run as Score A/B with the live elapsed', () => {
    const result = answerAll(
      startRun(),
      [
        'Lions at Bills',
        'Ford Field',
        'Bills',
        'Belichick',
        'lions-cluster',
        'swap-qbs',
        'Flamengo',
        'rot-0',
      ],
      125_000,
    )
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, {
      kind: 'solved',
      elapsedMs: 125_000,
      correct: 4,
      total: 8,
    })
    const paste = formatShare({
      dayIndex: 1,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #1\nScore 4/8 · 0:02:05\n${SHARE_URL}`)
  })
})

describe('soft retry off', () => {
  const record = {
    dayKey: TODAY,
    dayIndex: 1 as const,
    outcome: { kind: 'solved' as const, elapsedMs: 12_000, correct: 4, total: 8 },
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
    const result = answerAll(startRun(), [
      'Lions at Bills',
      'Highmark',
      'Bills',
      'Campbell',
      'lions-cluster',
      'match',
      'Flamengo',
      'rot-90',
    ])
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
      outcome: { kind: 'solved', elapsedMs: 125_000, correct: 5, total: 8 },
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #3\nScore 5/8 · 0:02:05\n${SHARE_URL}`)
    assert.equal(isCanonicalShare(paste, 3, SHARE_URL, 8), true)
  })

  it('records DNF as Score —/B · DNF without a fake fast time', () => {
    const playing = startRun(batteryForDay(2))
    const afterTwo = answerAll(playing, ['Lions at Bills', 'Highmark'], 8000)
    const result = reduceSession(afterTwo, { type: 'dnf' })
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, { kind: 'dnf', total: 8 })
    const paste = formatShare({
      dayIndex: 2,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #2\nScore —/8 · DNF\n${SHARE_URL}`)
    assert.equal(paste.includes('0:00:00'), false)
    assert.equal(isCanonicalShare(paste, 2, SHARE_URL, 8), true)
  })

  it('keeps the share card spoiler-safe and builds an X intent URL', () => {
    const outcome = { kind: 'solved' as const, elapsedMs: 4000, correct: 8, total: 8 }
    const paste = formatShare({ dayIndex: 1, outcome, url: SHARE_URL })
    assert.equal(isCanonicalShare(paste, 1, SHARE_URL, 8), true)
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

describe('soft host unlock', () => {
  const record = {
    dayKey: TODAY,
    dayIndex: 1 as const,
    outcome: { kind: 'dnf' as const, total: 8 },
  }

  it('unlocks Soft hosts and keeps a custom LIVE domain locked', () => {
    assert.equal(isSoftHost({ dev: false, hostname: 'chronoflash.example' }), false)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'chronoflash.example' }), true)
    assert.equal(isSoftHost({ dev: false, hostname: 'chrono-flash.vercel.app' }), true)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'chrono-flash.vercel.app' }), false)
    assert.equal(isSoftHost({ dev: false, hostname: 'localhost' }), true)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'localhost' }), false)
    assert.equal(isSoftHost({ dev: false, hostname: '127.0.0.1' }), true)
    assert.equal(isSoftHost({ dev: true, hostname: 'chronoflash.example' }), true)
    assert.equal(
      dayLockEnabled({ dev: false, hostname: 'chronoflash.example', envFlag: true }),
      false,
    )
  })

  it('boots Home with Start when day-lock is off even if today is recorded', () => {
    assert.equal(canStart(record, TODAY, false), true)
    const session = bootSession(batteryForDay(1), record, TODAY, false)
    assert.equal(session.status, 'home')
    const started = reduceSession(session, {
      type: 'start',
      startedAt: 1,
      todayKey: TODAY,
      dayLock: false,
    })
    assert.equal(started.status, 'playing')
  })
})
