// CI test runner: every test/*.test.js EXCEPT two that need a live nginx binary
// (a `nginx -t` config-lint that returns nonzero on hosted runners' runtime paths,
// and a test that boots nginx). All other tests are self-contained. Runs
// sequentially, fails on the first failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const EXCLUDE = new Set(['checkconfigs.test.js', 'runnginx.test.js', 'start.test.js']);
const files = readdirSync('test')
  .filter((f) => f.endsWith('.test.js') && !EXCLUDE.has(f))
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [`test/${f}`], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nFAIL: ${f} (exit ${r.status})`);
    failed = 1;
    break;
  }
}
console.log(`\n${failed ? 'FAILED' : 'OK'} — ran ${files.length} test files (excluded: ${[...EXCLUDE].join(', ')})`);
process.exit(failed);
