// IM-SEARCH-CLICK-CARD-1620 mutation check. Run serially, nothing else reading src/ concurrently.
// node tests/search-click-card-mutations.mjs [out.json]
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

process.umask(0o077);
const P = "src/components/SearchPanel.vue", A = "src/App.vue", O = "src/accountPopover.ts";
const changes = [
  ["row opens the chat again", P, 'else if (row.kind === "contact") inspect(row.entry, row.title, anchor);', 'else if (row.kind === "contact") emit("contact", row.entry);'],
  ["row opens chat AND card", P, 'else if (row.kind === "contact") inspect(row.entry, row.title, anchor);', 'else if (row.kind === "contact") { inspect(row.entry, row.title, anchor); emit("contact", row.entry); }'],
  ["card message wired to nothing", P, '    message: () => emit("contact", entry),', ""],
  ["card primary back to Select", P, '    message: () => emit("contact", entry),', '    select: () => emit("contact", entry),'],
  ["click loses its anchor", P, '@click="pick(row, $event.currentTarget as HTMLElement)"', '@click="pick(row)"'],
  ["Enter loses its anchor", P, 'pick(row, document.querySelector<HTMLElement>(".search-panel .search-row.active") ?? undefined);', "pick(row);"],
  ["Tab captured again", P, '  if (event.key === "ArrowDown") {', '  if (event.key === "Tab") {\n    event.preventDefault();\n    const at = tabs.indexOf(tab.value) + (event.shiftKey ? -1 : 1);\n    tab.value = tabs[(at + tabs.length) % tabs.length];\n  } else if (event.key === "ArrowDown") {'],
  ["no dialog semantics on the row", P, ":aria-haspopup=\"row.kind === 'contact' ? 'dialog' : undefined\"", ""],
  ["picking clears the query", P, 'function pick(row: Row, anchor?: HTMLElement): void {', 'function pick(row: Row, anchor?: HTMLElement): void {\n  query.value = "";'],
  ["picking switches the category", P, 'function pick(row: Row, anchor?: HTMLElement): void {', 'function pick(row: Row, anchor?: HTMLElement): void {\n  tab.value = "all";'],
  ["card targets the wrong account", P, '    uid: entry.provisioned ? String(entry.id) : "",', '    uid: entry.provisioned ? String(flat.value.find((r) => r.kind === "contact")?.entry.id ?? entry.id) : "",'],
  ["App ignores the search's open", A, "onMessage: can.message ? () => void (target.message ?? message)() : undefined,", "onMessage: can.message ? () => void message() : undefined,"],
  ["card failure is silent", A, '.then((shown) => { if (!shown && session.value === opener) loginError.value = t("profile.unavailable"); });', ";"],
  ["self row offers Send message", O, "const other = target.uid ? target.uid !== context.selfUid : !!(target.openId || target.message);", "const other = target.uid ? true : !!(target.openId || target.message);"],
  ["portal-only hit cannot be messaged", O, "const other = target.uid ? target.uid !== context.selfUid : !!(target.openId || target.message);", "const other = target.uid ? target.uid !== context.selfUid : !!target.openId;"],
];
const originals = Object.fromEntries([P, A, O].map((f) => [f, fs.readFileSync(f, "utf8")]));
const results = [];
try {
  for (const [name, file, before, after] of changes) {
    const src = originals[file];
    assert.equal(src.split(before).length - 1, 1, `unique mutation anchor: ${name}`);
    fs.writeFileSync(file, src.replace(before, after));
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./tests/setup.ts", "--test", "tests/search-click-card.test.ts"], { encoding: "utf8", timeout: 60000 });
    fs.writeFileSync(file, src);
    const output = r.stdout + r.stderr;
    const failed = Number(output.match(/ℹ fail (\d+)/)?.[1] ?? NaN);
    const passed = Number(output.match(/ℹ pass (\d+)/)?.[1] ?? NaN);
    // Valid kill: the suite ran to completion (not a timeout/compile crash) and an assertion failed.
    const killed = r.status === 1 && failed > 0 && passed + failed === 10 && output.includes("ERR_ASSERTION");
    const failing = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i && v !== "failing tests:");
    results.push({ name, file, killed, exitCode: r.status, signal: r.signal, passed, failed, failing });
    console.log(`${killed ? "KILLED" : "SURVIVED"}: ${name} (fail ${failed})`);
  }
} finally {
  for (const [f, s] of Object.entries(originals)) fs.writeFileSync(f, s);
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results, null, 2), { mode: 0o600 });
assert.ok(results.length >= 8);
assert.ok(results.every((r) => r.killed), "every behavioral mutation must fail an assertion");
