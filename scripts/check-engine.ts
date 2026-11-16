// Sanity check for the demo scenario: run with `node scripts/check-engine.ts`
import { exposure, styleMarkers } from '../src/engine/stylometry.ts';
import { LINEUP, DRAFT, REWRITE, MARTA_PUBLIC, DECOYS } from '../src/demo/scenario.ts';
const b = exposure(DRAFT, LINEUP, 'marta');
const a = exposure(REWRITE, LINEUP, 'marta');
console.log('before rank', b.rank, b.score.toFixed(2), b.ranked.map((r) => r.id + ':' + r.delta.toFixed(2)).join(' '));
console.log('after  rank', a.rank, a.score.toFixed(2), a.ranked.map((r) => r.id + ':' + r.delta.toFixed(2)).join(' '));
console.log(styleMarkers(DRAFT, MARTA_PUBLIC, DECOYS.map((d) => d.corpus)).map((m) => m.phrase));
console.log(styleMarkers(REWRITE, MARTA_PUBLIC, DECOYS.map((d) => d.corpus)).map((m) => m.phrase));
