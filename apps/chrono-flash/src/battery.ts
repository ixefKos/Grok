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

const BYLINE: Omit<BylineCard, 'rotate'> = {
  name: 'R. Chen',
  outlet: 'Wire Desk',
  time: '06:12',
}

function byline(rotate: BylineCard['rotate']): BylineCard {
  return { ...BYLINE, rotate }
}

export const DAY1_ITEMS: readonly BatteryItem[] = [
  {
    id: 'q1-pattern-desk-flow',
    family: 'pattern',
    kind: 'choice',
    prompt: 'Which comes next? Tip → Report → Edit → ?',
    choices: [
      { id: 'Retweet', label: 'Retweet' },
      { id: 'Publish', label: 'Publish' },
      { id: 'Embargo', label: 'Embargo' },
      { id: 'Archive', label: 'Archive' },
    ],
    answer: 'Publish',
  },
  {
    id: 'q2-verbal-odd-source',
    family: 'verbal',
    kind: 'choice',
    prompt:
      'Odd one out: eyewitness video · official transcript · leaked rumor screenshot · on-the-record interview',
    choices: [
      { id: 'eyewitness video', label: 'eyewitness video' },
      { id: 'official transcript', label: 'official transcript' },
      { id: 'leaked rumor screenshot', label: 'leaked rumor screenshot' },
      { id: 'on-the-record interview', label: 'on-the-record interview' },
    ],
    answer: 'leaked rumor screenshot',
  },
  {
    id: 'q3-spatial-byline-rotate',
    family: 'spatial',
    kind: 'spatial',
    prompt: 'Which byline card is the same card rotated 90° CW?',
    promptByline: byline(0),
    choices: [
      { id: 'rot-270', label: 'A', byline: byline(270) },
      { id: 'rot-90', label: 'B', byline: byline(90) },
      { id: 'rot-180', label: 'C', byline: byline(180) },
      { id: 'rot-0', label: 'D', byline: byline(0) },
    ],
    answer: 'rot-90',
  },
  {
    id: 'q4-logic-wire-copy',
    family: 'logic',
    kind: 'choice',
    prompt:
      'All wire copy is edited before air. A segment aired live unedited. Was it wire copy?',
    choices: [
      { id: 'Yes', label: 'Yes' },
      { id: 'No', label: 'No' },
      { id: 'Not enough info', label: 'Not enough info' },
    ],
    answer: 'No',
  },
  {
    id: 'q5-memory-desk-labels',
    family: 'memory',
    kind: 'memory',
    prompt: 'Which set matches?',
    flash: ['LIVE', 'UPDATE', 'ANALYSIS'],
    flashMs: MEMORY_FLASH_MS,
    choices: [
      { id: 'LIVE · UPDATE · ANALYSIS', label: 'LIVE · UPDATE · ANALYSIS' },
      { id: 'LIVE · ANALYSIS · UPDATE', label: 'LIVE · ANALYSIS · UPDATE' },
      { id: 'UPDATE · LIVE · ANALYSIS', label: 'UPDATE · LIVE · ANALYSIS' },
      { id: 'LIVE · UPDATE · OPINION', label: 'LIVE · UPDATE · OPINION' },
    ],
    answer: 'LIVE · UPDATE · ANALYSIS',
  },
  {
    id: 'q6-attention-sponsored',
    family: 'attention',
    kind: 'choice',
    prompt: 'Which label marks a paid placement?',
    choices: [
      { id: 'Breaking', label: 'Breaking' },
      { id: 'Exclusive', label: 'Exclusive' },
      { id: 'Sponsored', label: 'Sponsored' },
      { id: 'Updated', label: 'Updated' },
    ],
    answer: 'Sponsored',
  },
]

export function batteryForDay(day: DayIndex): Battery {
  return { day, items: DAY1_ITEMS }
}
