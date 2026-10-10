import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DAY1_ITEMS, batteryForDay } from './battery.ts'
import { shortTipSha } from './soft-label.ts'
import { STORAGE_KEY, loadRecord, saveRecord } from './storage.ts'
import {
  MIN_FAMILIES,
  MIN_ITEMS,
  MEMORY_FLASH_MS,
  POST_TIME_INTENT,
  bootSession,
  buildPostTimeUrl,
  openPostTimeIntent,
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

  it('ships a 9-item folded pack across at least 4 skill families', () => {
    assert.equal(battery.items.length, 9)
    assert.ok(battery.items.length >= MIN_ITEMS)
    assert.ok(families.length >= MIN_FAMILIES)
    assert.deepEqual(
      new Set(families),
      new Set(['verbal', 'logic', 'attention', 'pattern', 'memory']),
    )
    assert.equal(families.join(' · '), 'verbal · logic · attention · pattern · memory')
  })

  it('is not a math-only, snack, literacy, or DET-only short pack', () => {
    const patternOnly = battery.items.every((item) => item.family === 'pattern')
    assert.equal(patternOnly, false)
    const blob = JSON.stringify(DAY1_ITEMS)
    assert.equal(blob.includes('Publish'), false)
    assert.equal(blob.includes('Sponsored'), false)
    assert.equal(blob.includes('leaked rumor'), false)
    assert.equal(blob.includes('Wire Desk'), false)
    assert.ok(blob.includes('3.75%–4.00%'))
    assert.ok(blob.includes('YANOS'))
    assert.ok(blob.includes('#DETvsBUF'))
    assert.ok(blob.includes('Ulf Kristersson'))
    assert.ok(blob.includes('Josh Allen'))
    assert.ok(families.includes('verbal'))
    assert.ok(families.includes('logic'))
    assert.ok(families.includes('memory'))
    assert.ok(families.includes('attention'))
    assert.ok(families.includes('pattern'))
    const mix = families.join(' · ')
    assert.notEqual(mix, 'pattern')
    assert.ok(mix.split(' · ').length >= 5)
  })

  it('implements the revised XTRENDS + Marlowe folded keys', () => {
    assert.equal(DAY1_ITEMS[0]?.prompt, 'On 16 Sep 2026, the Fed federal funds target range was?')
    assert.equal(DAY1_ITEMS[0]?.answer, '3.75-4.00')
    assert.equal(
      DAY1_ITEMS[0]?.choices.find((choice) => choice.id === DAY1_ITEMS[0].answer)?.label,
      '3.75%–4.00%',
    )

    assert.equal(
      DAY1_ITEMS[1]?.prompt,
      'UN FFM: which state’s February strikes on a school/sports site in Iran had reasonable grounds for war crimes?',
    )
    assert.equal(DAY1_ITEMS[1]?.answer, 'United States')

    assert.equal(DAY1_ITEMS[2]?.family, 'attention')
    assert.equal(DAY1_ITEMS[2]?.prompt, 'Which ≤72h event is real?')
    assert.equal(DAY1_ITEMS[2]?.answer, 'yanos')
    assert.equal(
      DAY1_ITEMS[2]?.choices.find((choice) => choice.id === 'yanos')?.label,
      'Yaroslavl (YANOS) refinery halted processing after drone damage',
    )

    assert.equal(DAY1_ITEMS[3]?.prompt, 'Drones → fires → facility class near Yaroslavl damaged?')
    assert.equal(DAY1_ITEMS[3]?.answer, 'refinery')

    assert.equal(DAY1_ITEMS[4]?.prompt, 'Which set matches?')
    assert.deepEqual(DAY1_ITEMS[4]?.flash, ['Fed', 'Kyiv', 'YANOS', 'Taif'])
    assert.equal(DAY1_ITEMS[4]?.flashMs, MEMORY_FLASH_MS)
    assert.equal(DAY1_ITEMS[4]?.answer, 'match')

    assert.equal(
      DAY1_ITEMS[5]?.prompt,
      'Which NFL matchup tag dominated US X trends this Soft evening?',
    )
    assert.equal(DAY1_ITEMS[5]?.answer, 'DETvsBUF')

    assert.equal(DAY1_ITEMS[6]?.prompt, 'Which Sweden PM resigned on 17 Sep?')
    assert.equal(DAY1_ITEMS[6]?.answer, 'Kristersson')

    assert.equal(DAY1_ITEMS[7]?.prompt, 'Houthi debris caused a civilian death in which governorate?')
    assert.equal(DAY1_ITEMS[7]?.answer, 'Taif')

    assert.equal(DAY1_ITEMS[8]?.prompt, 'Which Bills QB is on US X trends this Soft evening?')
    assert.equal(DAY1_ITEMS[8]?.answer, 'Allen')
  })

  it('never asks the DET–BUF final score or a box score', () => {
    const blob = JSON.stringify(DAY1_ITEMS)
    assert.equal(/\bfinal score\b/i.test(blob), false)
    assert.equal(/\bbox score\b/i.test(blob), false)
    assert.equal(/\bwho won\b/i.test(blob), false)
    const nfl = DAY1_ITEMS.filter((item) => /DET|BUF|Allen|#DET/i.test(JSON.stringify(item)))
    for (const item of nfl) {
      const text = `${item.prompt} ${item.choices.map((choice) => choice.label).join(' ')}`
      assert.equal(/\b(won|final|box score)\b/i.test(text), false)
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
    const mid = reduceSession(playing, { type: 'answer', choice: '3.75-4.00', elapsedMs: 4000 })
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
        '3.75-4.00',
        'United States',
        'yanos',
        'refinery',
        'match',
        'DETvsBUF',
        'Kristersson',
        'Taif',
        'Allen',
      ]),
      9,
    )
    assert.equal(
      scoreAnswers(battery, [
        '3.25-3.50',
        'Israel',
        'fed-zero',
        'airport',
        'swap-kyiv',
        'KCvsBAL',
        'Andersson',
        'Riyadh',
        'Goff',
      ]),
      0,
    )
    assert.equal(
      scoreAnswers(battery, [
        '3.75-4.00',
        'Israel',
        'yanos',
        'airport',
        'match',
        'KCvsBAL',
        'Kristersson',
        'Riyadh',
        'Allen',
      ]),
      5,
    )
  })

  it('finishes a mixed run as Score A/B with the live elapsed', () => {
    const result = answerAll(
      startRun(),
      [
        '3.75-4.00',
        'Israel',
        'yanos',
        'airport',
        'match',
        'KCvsBAL',
        'Kristersson',
        'Riyadh',
        'Allen',
      ],
      125_000,
    )
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, {
      kind: 'solved',
      elapsedMs: 125_000,
      correct: 5,
      total: 9,
    })
    const paste = formatShare({
      dayIndex: 1,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #1\nScore 5/9 · 0:02:05\n${SHARE_URL}`)
  })
})

describe('soft retry off', () => {
  const record = {
    dayKey: TODAY,
    dayIndex: 1 as const,
    outcome: { kind: 'solved' as const, elapsedMs: 12_000, correct: 4, total: 9 },
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
      '3.75-4.00',
      'United States',
      'yanos',
      'refinery',
      'match',
      'DETvsBUF',
      'Kristersson',
      'Taif',
      'Allen',
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
      outcome: { kind: 'solved', elapsedMs: 125_000, correct: 5, total: 9 },
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #3\nScore 5/9 · 0:02:05\n${SHARE_URL}`)
    assert.equal(isCanonicalShare(paste, 3, SHARE_URL, 9), true)
  })

  it('records DNF as Score —/B · DNF without a fake fast time', () => {
    const playing = startRun(batteryForDay(2))
    const afterTwo = answerAll(playing, ['3.75-4.00', 'United States'], 8000)
    const result = reduceSession(afterTwo, { type: 'dnf' })
    assert.equal(result.status, 'result')
    if (result.status !== 'result') return
    assert.deepEqual(result.outcome, { kind: 'dnf', total: 9 })
    const paste = formatShare({
      dayIndex: 2,
      outcome: result.outcome,
      url: SHARE_URL,
    })
    assert.equal(paste, `Chrono Flash #2\nScore —/9 · DNF\n${SHARE_URL}`)
    assert.equal(paste.includes('0:00:00'), false)
    assert.equal(isCanonicalShare(paste, 2, SHARE_URL, 9), true)
  })

  it('keeps the share card spoiler-safe and builds an X intent URL', () => {
    const outcome = { kind: 'solved' as const, elapsedMs: 4000, correct: 9, total: 9 }
    const paste = formatShare({ dayIndex: 1, outcome, url: SHARE_URL })
    assert.equal(isCanonicalShare(paste, 1, SHARE_URL, 9), true)
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

  it('opens X intent without a features string and does not treat a handle as blocked', () => {
    const intent = buildPostTimeUrl('Chrono Flash #1\nScore 9/9 · 0:00:04\nhttps://example.test')
    const calls: unknown[] = []
    const popup = { opener: 'parent' as unknown }
    const opened = openPostTimeIntent((url, target) => {
      calls.push([url, target])
      return popup
    }, intent)
    assert.equal(opened, true)
    assert.equal(popup.opener, null)
    assert.deepEqual(calls, [[intent, '_blank']])
  })

  it('uses clipboard fallback only when the popup handle is actually null', () => {
    const opened = openPostTimeIntent(() => null, `${POST_TIME_INTENT}?text=x`)
    assert.equal(opened, false)
  })

  it('treats a thrown window.open as a true block', () => {
    const opened = openPostTimeIntent(() => {
      throw new Error('blocked')
    }, `${POST_TIME_INTENT}?text=x`)
    assert.equal(opened, false)
  })
})

describe('soft tip SHA', () => {
  it('shortens a full commit SHA to 7 chars for the Soft home/footer', () => {
    assert.equal(shortTipSha('30759f5c0ffeebad'), '30759f5')
    assert.equal(shortTipSha('30759f5'), '30759f5')
    assert.equal(shortTipSha(''), 'unknown')
    assert.equal(shortTipSha(undefined), 'unknown')
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

  it('ignores a v1 Score 6/6 Soft lock and writes only the v2 xtrends key', () => {
    assert.equal(STORAGE_KEY, 'chrono-flash:v2:xtrends')
    const memory = new Map<string, string>()
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value)
      },
    } as Pick<Storage, 'getItem' | 'setItem'> as Storage
    storage.setItem(
      'chrono-flash:v1:battery',
      JSON.stringify({
        dayKey: TODAY,
        dayIndex: 1,
        outcome: { kind: 'solved', elapsedMs: 12_000, correct: 6, total: 6 },
      }),
    )
    assert.equal(loadRecord(storage), null)
    const fresh = {
      dayKey: TODAY,
      dayIndex: 1 as const,
      outcome: { kind: 'solved' as const, elapsedMs: 8_800, correct: 9, total: 9 },
    }
    saveRecord(storage, fresh)
    assert.equal(memory.has('chrono-flash:v1:battery'), true)
    assert.deepEqual(loadRecord(storage), fresh)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'chrono-flash.vercel.app' }), true)
  })
})

describe('soft host day-lock', () => {
  const record = {
    dayKey: TODAY,
    dayIndex: 1 as const,
    outcome: { kind: 'dnf' as const, total: 9 },
  }

  it('locks Soft preview hosts and LIVE domains', () => {
    assert.equal(isSoftHost({ dev: false, hostname: 'chronoflash.example' }), false)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'chronoflash.example' }), true)
    assert.equal(isSoftHost({ dev: false, hostname: 'chrono-flash.vercel.app' }), true)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'chrono-flash.vercel.app' }), true)
    assert.equal(isSoftHost({ dev: false, hostname: 'localhost' }), true)
    assert.equal(dayLockEnabled({ dev: false, hostname: 'localhost' }), true)
    assert.equal(isSoftHost({ dev: false, hostname: '127.0.0.1' }), true)
    assert.equal(dayLockEnabled({ dev: false, hostname: '127.0.0.1' }), true)
    assert.equal(isSoftHost({ dev: true, hostname: 'chronoflash.example' }), true)
    assert.equal(
      dayLockEnabled({ dev: false, hostname: 'chronoflash.example', envFlag: true }),
      true,
    )
  })

  it('boots a finished Soft day on result and refuses a second start', () => {
    assert.equal(canStart(record, TODAY, true), false)
    const session = bootSession(batteryForDay(1), record, TODAY, true)
    assert.equal(session.status, 'result')
    const again = reduceSession(
      { status: 'home', battery: batteryForDay(1), record },
      { type: 'start', startedAt: 1, todayKey: TODAY, dayLock: true },
    )
    assert.equal(again.status, 'home')
  })

  it('allows a new official run when the day key changes', () => {
    assert.equal(canStart(record, '2026-09-18', true), true)
    const session = bootSession(batteryForDay(1), record, '2026-09-18', true)
    assert.equal(session.status, 'home')
  })
})
