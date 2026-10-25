/**
 * Fold correction lessons into the app's built-in starting point.
 *
 *   npm run bake-lessons -- layercraft-lessons.json [more files…]
 *
 * Lessons are numbers only (the clues the tracer saw at a fixed shape, and what the user chose).
 * A lesson set is accepted only if:
 *   1. every lesson is well formed (9 finite clues, action 0/1/2), duplicates dropped;
 *   2. the model learnt from the other pictures already agrees with it more often than not, or it
 *      is the first picture to teach that case (so one odd picture can't flip what others taught);
 *   3. the retrained model keeps every test picture passing (npm run test:trace).
 * Accepted lessons are kept in scripts/lessons/accepted.json so every bake is reproducible from the
 * hand-written rules. Nothing is written if a check fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { SIT_FEATURES, SIT_RULES, trainSit } from '../src/trace';
import type { SitExample } from '../src/trace';

type Lesson = { p: string; f: number[]; a: number };
const ROOT = new URL('..', import.meta.url).pathname;
const ACC = `${ROOT}scripts/lessons/accepted.json`, OUT = `${ROOT}src/learned-defaults.json`;

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { console.log('usage: npm run bake-lessons -- layercraft-lessons.json [more…]'); process.exit(2); }

const accepted: Lesson[] = existsSync(ACC) ? JSON.parse(readFileSync(ACC, 'utf8')).lessons : [];
const key = (l: { f: number[]; a: number }) => `${l.a}:${l.f.map((v) => v.toFixed(3)).join(',')}`;
const seen = new Set(accepted.map(key));
const predict = (W: number[][], f: number[]) => { const sc = W.map((r) => r.reduce((t, v, k) => t + v * (f[k] ?? 0), 0)); return sc[0] >= sc[1] && sc[0] >= sc[2] ? 0 : sc[1] >= sc[2] ? 1 : 2; };

let fresh: Lesson[] = [];
files.forEach((file, fi) => {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  if (d?.app !== 'layercraft' || d?.kind !== 'lessons' || !Array.isArray(d.lessons)) { console.log(`skip ${file}: not a Layercraft lessons file`); return; }
  let bad = 0, dup = 0;
  for (const l of d.lessons) {
    const ok = Array.isArray(l?.f) && l.f.length === SIT_FEATURES && l.f.every((v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100) && [0, 1, 2].includes(l.a);
    if (!ok) { bad++; continue; }
    const L = { p: `${fi}.${Number(l.p) | 0}.${Date.now().toString(36)}`, f: l.f.map((v: number) => Math.round(v * 1000) / 1000), a: l.a };
    if (seen.has(key(L))) { dup++; continue; }
    seen.add(key(L)); fresh.push(L);
  }
  console.log(`${file}: ${d.lessons.length} lessons, ${bad} malformed, ${dup} already known`);
});

// 2. picture by picture: does what everyone else taught already lean the same way?
const pics = [...new Set(fresh.map((l) => l.p))];
const keep: Lesson[] = [];
for (const p of pics) {
  const mine = fresh.filter((l) => l.p === p), others = [...accepted, ...fresh.filter((l) => l.p !== p)];
  const W = trainSit(others.map(({ f, a }) => ({ f, a })), SIT_RULES);
  const agree = mine.filter((l) => predict(W, l.f) === l.a).length;
  const novel = mine.filter((l) => !others.some((o) => o.f.every((v, k) => Math.abs(v - l.f[k]) < 0.15))).length;
  const ok = !others.length || agree * 2 >= mine.length || novel * 2 >= mine.length;
  console.log(`picture ${p}: ${mine.length} lessons, ${agree} agree with the others, ${novel} new cases → ${ok ? 'kept' : 'left out (disagrees with what other pictures taught)'}`);
  if (ok) keep.push(...mine);
}
if (!keep.length) { console.log('nothing new to bake'); process.exit(0); }

// 3. retrain from the rules on everything accepted, then the test pictures must still pass
const all = [...accepted, ...keep];
const W = trainSit(all.map(({ f, a }): SitExample => ({ f, a })), SIT_RULES).map((r) => r.map((v) => Math.round(v * 1e4) / 1e4));
const fit = all.filter((l) => predict(W, l.f) === l.a).length;
console.log(`retrained on ${all.length} lessons; it matches ${fit} of them`);
const before = readFileSync(OUT, 'utf8');
writeFileSync(OUT, JSON.stringify({ version: 1, note: JSON.parse(before).note, lessons: all.length, weights: W }, null, 2) + '\n');
const t = spawnSync('npx', ['tsx', 'tests/run.ts'], { cwd: ROOT, stdio: 'inherit' });
if (t.status !== 0) { writeFileSync(OUT, before); console.log('\ntest pictures got worse: built-in lessons left unchanged'); process.exit(1); }
mkdirSync(`${ROOT}scripts/lessons`, { recursive: true });
writeFileSync(ACC, JSON.stringify({ lessons: all }, null, 0) + '\n');
console.log(`\nbaked: the app now starts from ${all.length} lessons (rebuild and republish to ship them)`);
