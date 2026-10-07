/**
 * Per-turn phases of a live interview. The bot drives these; every transition is checked so
 * a resumed (reconnected or failed-over) interview can never skip a step.
 */
export const PHASES = [
  'created',
  'asking',
  'listening',
  'evaluating',
  'deciding',
  'closing',
  'ended',
] as const;
export type Phase = (typeof PHASES)[number];

const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  created: ['asking', 'ended'],
  asking: ['listening', 'ended'],
  listening: ['evaluating', 'ended'],
  evaluating: ['deciding', 'ended'],
  deciding: ['asking', 'closing', 'ended'],
  closing: ['ended'],
  ended: [],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal interview phase transition: ${from} -> ${to}`);
  }
}
