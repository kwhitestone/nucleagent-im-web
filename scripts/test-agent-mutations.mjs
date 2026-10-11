import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

process.umask(0o077);
const root = resolve(import.meta.dirname, "..");
const cases = [
  ["field-policy", "draft.ts", '!editablePaths.includes(path)', "false", "agent-definition.test.ts"],
  ["dirty-leaves", "draft.ts", "!Object.is(readPath(baseline, path), value)", "true", "agent-definition.test.ts"],
  ["explicit-conflict", "draft.ts", "row.conflict && !choices[row.path]", "false", "agent-definition.test.ts"],
  ["revision-precision", "draft.ts", "BigInt(candidate) > BigInt(current)", "Number(candidate) > Number(current)", "agent-definition.test.ts"],
  ["binding-preservation", "draft.ts", 'previous.find((b) => b.skillId === skillId) ?? catalog.find((b) => b.skillId === skillId)', 'catalog.find((b) => b.skillId === skillId)', "agent-definition.test.ts"],
  ["strong-cas", "api.ts", '"If-Match": record.etag', '"If-Match": "*"', "agent-definition-api.test.ts"],
  ["read-revocation", "state.ts", "if (!record.capabilities.read) { this.revokeRead(); return; }", "", "agent-definition-state.test.ts"],
  ["late-save", "state.ts", "if (generation !== this.generation) return null;", "if (false) return null;", "agent-definition-state.test.ts"],
  ["session-isolation", "transport.ts", "current()?.uid !== session.uid || current()?.jwt !== session.jwt", "false", "agent-definition-transport.test.ts"],
];
const run = (cwd, test) => spawnSync(process.execPath, ["--experimental-strip-types", "--test", `tests/${test}`],
  { cwd, encoding: "utf8", timeout: 10000 });
const results = [];
for (const [name, file, before, after, test] of cases) {
  const dir = mkdtempSync(join(tmpdir(), "im-agent-mutation-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    cpSync(join(root, "src/agent-definition"), join(dir, "src/agent-definition"), { recursive: true });
    cpSync(join(root, "tests"), join(dir, "tests"), { recursive: true });
    const baseline = run(dir, test);
    assert.equal(baseline.status, 0, `Baseline failed for ${name}: ${baseline.stderr}`);
    const target = join(dir, "src/agent-definition", file);
    const source = readFileSync(target, "utf8");
    assert.ok(source.includes(before), `Mutation anchor absent: ${name}`);
    writeFileSync(target, source.replace(before, after));
    const mutated = run(dir, test);
    const killed = mutated.status !== 0 && /AssertionError|ERR_ASSERTION/.test(mutated.stdout + mutated.stderr);
    results.push({ name, baseline: "PASS", killed, status: mutated.status });
    assert.ok(killed, `Mutation survived or failed outside assertions: ${name}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ scope: "Isolated unit mutations, not business E2E", results }, null, 2));
