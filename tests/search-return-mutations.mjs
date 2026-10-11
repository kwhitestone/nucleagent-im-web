// Run serially, with no build/test process reading App.vue concurrently.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

process.umask(0o077);
const file = "src/App.vue";
const original = fs.readFileSync(file, "utf8");
const changes = [
  ["search never closes", "function selectRail(mode: RailMode): void {\n  searchOpen.value = false;", "function selectRail(mode: RailMode): void {"],
  ["wrong destination", "railMode.value = mode;", 'railMode.value = "all";'],
  ["desktop chat cleared", 'if (window.matchMedia("(max-width: 720px)").matches) activeChannel.value = undefined;', "activeChannel.value = undefined;"],
  ["mobile chat covers list", 'if (window.matchMedia("(max-width: 720px)").matches) activeChannel.value = undefined;', ""],
  ["stale list highlight", ':class="{ active: !searchOpen && railMode === \'all\' }"', ':class="{ active: railMode === \'all\' }"'],
  ["stale list accessibility state", ':aria-pressed="!searchOpen && railMode === \'groups\'"', ':aria-pressed="railMode === \'groups\'"'],
  ["search highlight missing", ':class="{ active: searchOpen }"', ""],
  ["search accessibility state missing", ':aria-pressed="searchOpen"', ""],
];
const results = [];
try {
  for (const [name, before, after] of changes) {
    assert.equal(original.split(before).length - 1, 1, `unique mutation anchor: ${name}`);
    fs.writeFileSync(file, original.replace(before, after));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "tests/search-return.checks.ts"], { encoding: "utf8", timeout: 15000 });
    const output = r.stdout + r.stderr;
    const failed = output.match(/(?:ℹ|#) fail (\d+)/)?.[1];
    const killed = r.status === 1 && Number(failed) > 0 && output.includes("ERR_ASSERTION");
    results.push({ name, killed, failedTests: Number(failed), exitCode: r.status });
    console.log(`${killed ? "KILLED" : "SURVIVED"}: ${name}`);
  }
} finally {
  fs.writeFileSync(file, original);
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results, null, 2), { mode: 0o600 });
assert.equal(results.length, 8);
assert.ok(results.every(r => r.killed), "every behavioral mutation must fail an assertion");
