import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "im-session-mutations-"));
const mutants = [
  ["captured-credentials", "const current = currentSession();", "const current = session;"],
  ["missing-cancellation", "syncAbort.abort();", "void syncAbort;"],
  ["missing-response-fence",
    "if (signal.aborted || binding !== sdkBinding || currentSession() !== current) throw stale();",
    "void signal;"],
  ["swallowed-current-401", "throw error;", "return [];"],
  ["retired-provider-allowed",
    "if (binding !== sdkBinding || !current || current.uid !== session.uid) throw stale();",
    "if (!current) throw stale();"],
];
try {
  for (const name of ["src", "tests", "package.json"]) cpSync(join(root, name), join(dir, name), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  const path = join(dir, "src/im.ts");
  const source = readFileSync(path, "utf8");
  const run = () => spawnSync(process.execPath, [
    "--experimental-strip-types", "--import", "./tests/setup.ts", "--test", "tests/sdk-session-binding.test.ts",
  ], { cwd: dir, encoding: "utf8", timeout: 20000 });
  const baseline = run();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const results = [];
  for (const [name, before, after] of mutants) {
    assert(source.includes(before), `mutation anchor missing: ${name}`);
    writeFileSync(path, source.replaceAll(before, after));
    const result = run();
    assert.equal(result.signal, null, `${name}: killed or timed out`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(result.stdout, /ERR_ASSERTION/, `${name}: not an assertion failure`);
    results.push({ name, killedByAssertion: true });
  }
  console.log(JSON.stringify({ baselinePassed: true, results }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
