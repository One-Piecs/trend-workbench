import type { Center, StructureLine } from './market-types';

/** A finer display layer built from confirmed pens. It is deliberately separate
 * from the segment centers used by analysis, scoring and trading scenarios. */
export interface StrokeCenter extends Center {
  layer: 'stroke';
  id: string;
  /** Chronological display number within the supplied history. */
  sequence: number;
  startTime: number;
  /** Raw candle index at which all three initial pens were knowable. */
  formedAt: number;
  formationEndIndex: number;
}

const bounds = (line: StructureLine) => ({
  low: Math.min(line.from.price, line.to.price),
  high: Math.max(line.from.price, line.to.price),
});
const connected = (a: StructureLine, b: StructureLine) =>
  a.to.index === b.from.index && a.to.time === b.from.time &&
  a.to.price === b.from.price && a.direction !== b.direction;
const valid = (line: StructureLine) => line.confirmed === true &&
  [line.from.index, line.to.index, line.confirmedAt].every(n => Number.isInteger(n) && n >= 0) &&
  line.from.index < line.to.index && line.confirmedAt >= line.to.index &&
  [line.from.time, line.to.time, line.from.price, line.to.price].every(n => Number.isFinite(n) && n > 0) &&
  line.from.time < line.to.time &&
  (line.direction === 'up' ? line.to.price > line.from.price : line.to.price < line.from.price);

/** Do not remove an unfinished/missing pen and join its two neighbours. Each
 * uninterrupted run is evaluated independently, retaining older centers. */
export function buildStrokeCenters(strokes: readonly StructureLine[]): StrokeCenter[] {
  const runs: StructureLine[][] = [];
  let run: StructureLine[] = [];
  for (const stroke of strokes) {
    if (!valid(stroke)) { run = []; continue; }
    if (run.length && !connected(run[run.length - 1], stroke)) run = [];
    if (!run.length) runs.push(run);
    run.push(stroke);
  }

  const centers: StrokeCenter[] = [];
  for (const lines of runs) {
    let i = 0;
    while (i + 2 < lines.length) {
      const firstThree = lines.slice(i, i + 3);
      const initial = firstThree.map(bounds);
      const low = Math.max(...initial.map(b => b.low));
      const high = Math.min(...initial.map(b => b.high));
      if (low >= high) { i++; continue; }

      let j = i + 3;
      while (j < lines.length) {
        const next = bounds(lines[j]);
        if (Math.max(low, next.low) > Math.min(high, next.high)) break;
        j++;
      }
      const broken = j < lines.length;
      const start = firstThree[0].from;
      const formationEnd = firstThree[2].to;
      centers.push({
        startIndex: start.index, endIndex: lines[j - 1].to.index,
        low, high, level: '笔中枢', status: broken ? 'broken' : 'active',
        layer: 'stroke',
        // Extension and raw-index shifts do not change an already formed ID.
        id: `stroke:${start.time}:${formationEnd.time}:${low}:${high}`,
        sequence: centers.length + 1, startTime: start.time,
        formedAt: Math.max(...firstThree.map(line => line.confirmedAt)),
        formationEndIndex: formationEnd.index,
      });
      if (!broken) break;
      i = j;
    }
  }
  return centers;
}
