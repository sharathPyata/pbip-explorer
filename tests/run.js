// Runs every tests/*.test.js. No dependencies — just Node.
//   node tests/run.js                              tests ./pbip-explorer.html
//   node tests/run.js path/to/pbip-explorer.html    tests another copy, e.g. the pre-fix version,
//                                                   to confirm a new test fails before a fix
'use strict';
const fs = require('fs');
const path = require('path');

if (process.argv[2]) process.env.PBIP_HTML = path.resolve(process.argv[2]);

(async () => {
  let total = 0, failed = 0;
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
  for (const file of files) {
    console.log(`\n${file}`);
    let tests;
    try { tests = require(path.join(__dirname, file)); }
    catch (e) { total++; failed++; console.log(`  FAIL  (suite didn't load)\n          ${e.message}`); continue; }
    for (const t of tests) {
      total++;
      try { await t.fn(); console.log(`  PASS  ${t.name}`); }
      catch (e) { failed++; console.log(`  FAIL  ${t.name}\n          ${String((e && e.message) || e).split('\n')[0]}`); }
    }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
