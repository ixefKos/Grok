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

const L_TETROMINO: readonly Cell[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
]

const SPATIAL_PROMPT = L_TETROMINO
const SPATIAL_CW90 = rotate90CW(SPATIAL_PROMPT)
const SPATIAL_CCW90 = rotate90CCW(SPATIAL_PROMPT)
const SPATIAL_180 = rotate180(SPATIAL_PROMPT)
const SPATIAL_MIRROR = mirrorHorizontal(SPATIAL_PROMPT)

export const DAY1_ITEMS: readonly BatteryItem[] = [
  {
    id: 'q1-pattern-doubling',
    family: 'pattern',
    kind: 'choice',
    prompt: 'Which comes next? 2 · 4 · 8 · 16 · ?',
    choices: [
      { id: '24', label: '24' },
      { id: '32', label: '32' },
      { id: '18', label: '18' },
      { id: '30', label: '30' },
    ],
    answer: '32',
  },
  {
    id: 'q2-verbal-odd-one',
    family: 'verbal',
    kind: 'choice',
    prompt: 'Odd one out: apple · banana · carrot · grape',
    choices: [
      { id: 'apple', label: 'apple' },
      { id: 'banana', label: 'banana' },
      { id: 'carrot', label: 'carrot' },
      { id: 'grape', label: 'grape' },
    ],
    answer: 'carrot',
  },
  {
    id: 'q3-spatial-l-rotate',
    family: 'spatial',
    kind: 'spatial',
    prompt: 'Which option is the same shape rotated 90° CW?',
    promptShape: SPATIAL_PROMPT,
    choices: [
      { id: 'rot-270', label: 'A', shape: SPATIAL_CCW90 },
      { id: 'rot-90', label: 'B', shape: SPATIAL_CW90 },
      { id: 'rot-180', label: 'C', shape: SPATIAL_180 },
      { id: 'mirror', label: 'D', shape: SPATIAL_MIRROR },
    ],
    answer: 'rot-90',
  },
  {
    id: 'q4-logic-flips',
    family: 'logic',
    kind: 'choice',
    prompt: 'All Flips are Glims. No Glims are Tarns. Can a Flip be a Tarn?',
    choices: [
      { id: 'Yes', label: 'Yes' },
      { id: 'No', label: 'No' },
      { id: 'Not enough info', label: 'Not enough info' },
    ],
    answer: 'No',
  },
  {
    id: 'q5-memory-symbols',
    family: 'memory',
    kind: 'memory',
    prompt: 'Which set matches?',
    flash: ['★', '◆', '○'],
    flashMs: MEMORY_FLASH_MS,
    choices: [
      { id: '★ ◆ ○', label: '★ ◆ ○' },
      { id: '★ ○ ◆', label: '★ ○ ◆' },
      { id: '◆ ★ ○', label: '◆ ★ ○' },
      { id: '★ ◆ △', label: '★ ◆ △' },
    ],
    answer: '★ ◆ ○',
  },
  {
    id: 'q6-pattern-letters',
    family: 'pattern',
    kind: 'choice',
    prompt: 'Complete: A C E G ?',
    choices: [
      { id: 'H', label: 'H' },
      { id: 'I', label: 'I' },
      { id: 'J', label: 'J' },
      { id: 'F', label: 'F' },
    ],
    answer: 'I',
  },
]

export function batteryForDay(day: DayIndex): Battery {
  return { day, items: DAY1_ITEMS }
}
