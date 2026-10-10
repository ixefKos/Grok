import {
  MEMORY_FLASH_MS,
  type Battery,
  type BatteryItem,
  type Cell,
  type DayIndex,
} from './domain.ts'

function normalize(cells: readonly Cell[]): Cell[] {
  const minRow = Math.min(...cells.map(([row]) => row))
  const minCol = Math.min(...cells.map(([, col]) => col))
  return cells
    .map(([row, col]) => [row - minRow, col - minCol] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

export function rotate90CW(cells: readonly Cell[]): Cell[] {
  return normalize(cells.map(([row, col]) => [col, -row] as const))
}

export function rotate180(cells: readonly Cell[]): Cell[] {
  return rotate90CW(rotate90CW(cells))
}

export function rotate90CCW(cells: readonly Cell[]): Cell[] {
  return rotate90CW(rotate180(cells))
}

export function mirrorHorizontal(cells: readonly Cell[]): Cell[] {
  return normalize(cells.map(([row, col]) => [row, -col] as const))
}

export function sameCells(left: readonly Cell[], right: readonly Cell[]): boolean {
  const key = (cells: readonly Cell[]) =>
    normalize(cells)
      .map(([row, col]) => `${row},${col}`)
      .join('|')
  return key(left) === key(right)
}

/**
 * Soft day-1 = 9-item folded XTRENDS + Marlowe seeds (cite-or-unknown).
 * Factory path `/workspace/ixef-games/research/work-order-2026-09-17/CHRONO_FLASH_QUESTION_BANK_XTRENDS.md`
 * was not in this checkout. Literacy Soft is killed. DET-only short pack is replaced.
 * Never asks the DET–BUF final score or a box score (unknown).
 */
export const DAY1_ITEMS: readonly BatteryItem[] = [
  {
    id: 'q1-verbal-fed-range',
    family: 'verbal',
    kind: 'choice',
    prompt: 'On 16 Sep 2026, the Fed federal funds target range was?',
    choices: [
      { id: '3.25-3.50', label: '3.25%–3.50%' },
      { id: '3.75-4.00', label: '3.75%–4.00%' },
      { id: '4.25-4.50', label: '4.25%–4.50%' },
      { id: '2.00-2.25', label: '2.00%–2.25%' },
    ],
    answer: '3.75-4.00',
  },
  {
    id: 'q2-logic-un-ffm-iran',
    family: 'logic',
    kind: 'choice',
    prompt:
      'UN FFM: which state’s February strikes on a school/sports site in Iran had reasonable grounds for war crimes?',
    choices: [
      { id: 'Israel', label: 'Israel' },
      { id: 'Iran', label: 'Iran' },
      { id: 'United States', label: 'United States' },
      { id: 'Russia', label: 'Russia' },
    ],
    answer: 'United States',
  },
  {
    id: 'q3-attention-yanos',
    family: 'attention',
    kind: 'choice',
    prompt: 'Which ≤72h event is real?',
    choices: [
      { id: 'fed-zero', label: 'Fed cut the funds rate to 0%' },
      { id: 'nato-admit', label: 'NATO admitted Ukraine' },
      { id: 'yanos', label: 'Yaroslavl (YANOS) refinery halted processing after drone damage' },
      { id: 'olympics-kyiv', label: 'Olympics opened in Kyiv' },
    ],
    answer: 'yanos',
  },
  {
    id: 'q4-pattern-yaroslavl-facility',
    family: 'pattern',
    kind: 'choice',
    prompt: 'Drones → fires → facility class near Yaroslavl damaged?',
    choices: [
      { id: 'airport', label: 'Airport' },
      { id: 'refinery', label: 'Oil refinery' },
      { id: 'power', label: 'Power plant' },
      { id: 'silo', label: 'Grain silo' },
    ],
    answer: 'refinery',
  },
  {
    id: 'q5-memory-folded-flash',
    family: 'memory',
    kind: 'memory',
    prompt: 'Which set matches?',
    flash: ['Fed', 'Kyiv', 'YANOS', 'Taif'],
    flashMs: MEMORY_FLASH_MS,
    choices: [
      { id: 'match', label: 'Fed · Kyiv · YANOS · Taif' },
      { id: 'swap-kyiv', label: 'Fed · YANOS · Kyiv · Taif' },
      { id: 'swap-taif', label: 'Fed · Kyiv · Taif · YANOS' },
      { id: 'wrong-tag', label: 'Fed · Kyiv · YANOS · #DETvsBUF' },
    ],
    answer: 'match',
  },
  {
    id: 'q6-verbal-detvsbuf-tag',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Which NFL matchup tag dominated US X trends this Soft evening?',
    choices: [
      { id: 'KCvsBAL', label: '#KCvsBAL' },
      { id: 'DETvsBUF', label: '#DETvsBUF' },
      { id: 'DALvsNYG', label: '#DALvsNYG' },
      { id: 'NYvsNE', label: '#NYvsNE' },
    ],
    answer: 'DETvsBUF',
  },
  {
    id: 'q7-verbal-sweden-pm',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Which Sweden PM resigned on 17 Sep?',
    choices: [
      { id: 'Andersson', label: 'Magdalena Andersson' },
      { id: 'Lofven', label: 'Stefan Löfven' },
      { id: 'Kristersson', label: 'Ulf Kristersson' },
      { id: 'Busch', label: 'Ebba Busch' },
    ],
    answer: 'Kristersson',
  },
  {
    id: 'q8-attention-taif',
    family: 'attention',
    kind: 'choice',
    prompt: 'Houthi debris caused a civilian death in which governorate?',
    choices: [
      { id: 'Riyadh', label: 'Riyadh' },
      { id: 'Jeddah', label: 'Jeddah' },
      { id: 'Taif', label: 'Taif' },
      { id: 'Mecca', label: 'Mecca' },
    ],
    answer: 'Taif',
  },
  {
    id: 'q9-verbal-josh-allen',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Which Bills QB is on US X trends this Soft evening?',
    choices: [
      { id: 'Goff', label: 'Jared Goff' },
      { id: 'Allen', label: 'Josh Allen' },
      { id: 'Mahomes', label: 'Patrick Mahomes' },
      { id: 'Jackson', label: 'Lamar Jackson' },
    ],
    answer: 'Allen',
  },
]

export function batteryForDay(day: DayIndex): Battery {
  return { day, items: DAY1_ITEMS }
}
