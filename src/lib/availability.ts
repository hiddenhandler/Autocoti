import { addMinutes, minutesToHHMM, weekdayOf } from "./time";

export type Range = { start: string; end: string }; // local "YYYY-MM-DD HH:MM"

export type SlotInput = {
  date: string; // YYYY-MM-DD
  durationMin: number;
  intervalMin: number;
  hours: { weekday: number; start_min: number; end_min: number }[];
  busy: Range[]; // existing appointments + time off
  earliest: string; // no slot may start before this local time
};

const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

/** Start times ("HH:MM") on `date` where a service of `durationMin` fits. */
export function computeSlots(input: SlotInput): string[] {
  const weekday = weekdayOf(input.date);
  const slots = new Set<string>();
  for (const h of input.hours) {
    if (h.weekday !== weekday) continue;
    for (let m = h.start_min; m + input.durationMin <= h.end_min; m += input.intervalMin) {
      const start = `${input.date} ${minutesToHHMM(m)}`;
      if (start < input.earliest) continue;
      const candidate = { start, end: addMinutes(start, input.durationMin) };
      if (input.busy.some((b) => overlaps(candidate, b))) continue;
      slots.add(minutesToHHMM(m));
    }
  }
  return [...slots].sort();
}

export function rangesOverlap(a: Range, b: Range): boolean {
  return overlaps(a, b);
}
