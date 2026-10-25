/**
 * npm run test:trace            run every test picture, exit 1 if any check fails
 * npm run test:trace -- --update accept the current results as the new baselines (after checking them)
 */
import { mkdirSync, writeFileSync } from 'fs';
import { BASE, CASES } from './suite';

const update = process.argv.includes('--update');
let failed = 0;
mkdirSync(BASE(''), { recursive: true });
for (const c of CASES) {
  const t0 = Date.now();
  const { sheets, checks } = c.run();
  console.log(`\n${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const k of checks) {
    const bad = !k.pass && !(update && k.name === 'accepted result');
    if (bad) failed++;
    console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${k.name}: ${k.value}  (${k.limit})`);
  }
  if (update) { writeFileSync(BASE(c.base), JSON.stringify(sheets)); console.log(`  baseline saved: tests/baselines/${c.base}`); }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall test pictures pass');
process.exit(failed ? 1 : 0);
