import {
  MEMORY_FLASH_MS,
  type Battery,
  type BatteryItem,
  type BylineCard,
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

/** Trend-card chrome for the spatial rotate item. Not a literacy byline. */
const TREND: Omit<BylineCard, 'rotate'> = {
  name: '#DETvsBUF',
  outlet: 'US X trends',
  time: 'Soft p.m.',
}

function trendCard(rotate: BylineCard['rotate']): BylineCard {
  return { ...TREND, rotate }
}

/**
 * Soft day-1 from Wren XTRENDS table (cite-or-unknown).
 * Factory path `/workspace/ixef-games/research/work-order-2026-09-17/CHRONO_FLASH_QUESTION_BANK_XTRENDS.md`
 * was not in this checkout. Literacy Soft and NEWS_BANK Fed/UN/YANOS pack are not this cut.
 * Never asks the DET–BUF final score (unknown).
 */
export const DAY1_ITEMS: readonly BatteryItem[] = [
  {
    id: 'q1-verbal-detvsbuf-matchup',
    family: 'verbal',
    kind: 'choice',
    prompt: 'On US X trends, #DETvsBUF is which matchup?',
    choices: [
      { id: 'Bills at Lions', label: 'Buffalo Bills at Detroit Lions' },
      { id: 'Lions at Bills', label: 'Detroit Lions at Buffalo Bills' },
      { id: 'Lions at Chiefs', label: 'Detroit Lions at Kansas City Chiefs' },
      { id: 'Cowboys at Bills', label: 'Dallas Cowboys at Buffalo Bills' },
    ],
    answer: 'Lions at Bills',
  },
  {
    id: 'q2-verbal-highmark-venue',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Where is that #DETvsBUF game being played?',
    choices: [
      { id: 'Ford Field', label: 'Ford Field (Detroit)' },
      { id: 'Arrowhead', label: 'Arrowhead Stadium (Kansas City)' },
      { id: 'Highmark', label: 'Highmark Stadium (Orchard Park)' },
      { id: 'MetLife', label: 'MetLife Stadium (East Rutherford)' },
    ],
    answer: 'Highmark',
  },
  {
    id: 'q3-logic-josh-allen',
    family: 'logic',
    kind: 'choice',
    prompt: 'Josh Allen is quarterback for which team?',
    choices: [
      { id: 'Lions', label: 'Detroit Lions' },
      { id: 'Bills', label: 'Buffalo Bills' },
      { id: 'Chiefs', label: 'Kansas City Chiefs' },
      { id: 'Ravens', label: 'Baltimore Ravens' },
    ],
    answer: 'Bills',
  },
  {
    id: 'q4-attention-dan-campbell',
    family: 'attention',
    kind: 'choice',
    prompt: 'Which name is on US X trends for this Soft evening?',
    choices: [
      { id: 'Belichick', label: 'Bill Belichick' },
      { id: 'Campbell', label: 'Dan Campbell' },
      { id: 'Brady', label: 'Tom Brady' },
      { id: 'McVay', label: 'Sean McVay' },
    ],
    answer: 'Campbell',
  },
  {
    id: 'q5-pattern-lions-cluster',
    family: 'pattern',
    kind: 'choice',
    prompt: 'Which cluster is the Lions-side X-trends set?',
    choices: [
      { id: 'bills-cluster', label: 'Allen · Cook · #BillsMafia · McDermott' },
      { id: 'mixed-cluster', label: 'Goff · Allen · #DETvsBUF · Highmark' },
      { id: 'lions-cluster', label: 'Goff · Gibbs · #OnePride · Dan Campbell' },
      { id: 'nfl-cluster', label: 'Mahomes · Kelce · #ChiefsKingdom · Reid' },
    ],
    answer: 'lions-cluster',
  },
  {
    id: 'q6-memory-xtends-flash',
    family: 'memory',
    kind: 'memory',
    prompt: 'Which set matches?',
    flash: ['#DETvsBUF', 'Josh Allen', 'Goff', '#OnePride'],
    flashMs: MEMORY_FLASH_MS,
    choices: [
      { id: 'match', label: '#DETvsBUF · Josh Allen · Goff · #OnePride' },
      { id: 'swap-qbs', label: '#DETvsBUF · Goff · Josh Allen · #OnePride' },
      { id: 'bills-swap', label: '#DETvsBUF · Josh Allen · Cook · #BillsMafia' },
      { id: 'pride-swap', label: '#OnePride · Josh Allen · Goff · #DETvsBUF' },
    ],
    answer: 'match',
  },
  {
    id: 'q7-verbal-flamengo-ww',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Which club is on the worldwide X trends list this Soft evening?',
    choices: [
      { id: 'Real Madrid', label: 'Real Madrid' },
      { id: 'Flamengo', label: 'Flamengo' },
      { id: 'Manchester City', label: 'Manchester City' },
      { id: 'Boca Juniors', label: 'Boca Juniors' },
    ],
    answer: 'Flamengo',
  },
  {
    id: 'q8-spatial-trend-rotate',
    family: 'spatial',
    kind: 'spatial',
    prompt: 'Which trend card is the same card rotated 90° CW?',
    promptByline: trendCard(0),
    choices: [
      { id: 'rot-270', label: 'A', byline: trendCard(270) },
      { id: 'rot-90', label: 'B', byline: trendCard(90) },
      { id: 'rot-180', label: 'C', byline: trendCard(180) },
      { id: 'rot-0', label: 'D', byline: trendCard(0) },
    ],
    answer: 'rot-90',
  },
]

export function batteryForDay(day: DayIndex): Battery {
  return { day, items: DAY1_ITEMS }
}
