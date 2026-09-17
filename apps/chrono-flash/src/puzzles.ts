import type { DayIndex, Puzzle } from './domain.ts'

export const PUZZLES: readonly Puzzle[] = [
  {
    day: 1,
    prompt: 'What comes next?',
    items: ['2', '4', '8', '16'],
    choices: ['24', '32', '18'],
    answer: '32',
  },
  {
    day: 2,
    prompt: 'What comes next?',
    items: ['A', 'C', 'E', 'G'],
    choices: ['H', 'I', 'J'],
    answer: 'I',
  },
  {
    day: 3,
    prompt: 'What comes next?',
    items: ['▲', '▲', '▼', '▲', '▲', '▼'],
    choices: ['▲', '▼', '◆'],
    answer: '▲',
  },
  {
    day: 4,
    prompt: 'What comes next?',
    items: ['1', '1', '2', '3', '5'],
    choices: ['6', '7', '8'],
    answer: '8',
  },
  {
    day: 5,
    prompt: 'What comes next?',
    items: ['3', '6', '9', '12'],
    choices: ['14', '15', '16'],
    answer: '15',
  },
  {
    day: 6,
    prompt: 'What comes next?',
    items: ['red', 'blue', 'red', 'blue'],
    choices: ['green', 'red', 'blue'],
    answer: 'red',
  },
  {
    day: 7,
    prompt: 'What comes next?',
    items: ['○', '○', '●', '○', '○', '●', '○'],
    choices: ['○', '●', '□'],
    answer: '○',
  },
]

export function puzzleForDay(day: DayIndex): Puzzle {
  const puzzle = PUZZLES.find((entry) => entry.day === day)
  if (!puzzle) {
    throw new Error(`missing puzzle for day ${day}`)
  }
  return puzzle
}
