// IM-SEARCH-CLICK-CARD-1620 / IM-CLICK-CARD-FIX-F1-1750 mutation check. Run serially, nothing else reading src/ concurrently.
// node tests/search-click-card-mutations.mjs [out.json]
// Valid mutant: unique anchor and `vue-tsc --noEmit` rc0. KILLED: the full `npm test` suite ran to completion
// (every test reported, none cancelled, no signal/timeout), rc1, with an assertion failure. Anything else is not a kill.
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
  // IM-CLICK-CARD-FIX-F1-1750: F1 and the independent review's survivors (R2/R3/R7/R8/R10).
  ["F1 row not focused before the card opens", P, "  anchor.focus();\n", ""],
  ["F1 row focused only after the card opened", P, "  anchor.focus();\n  emit(\"profile\", anchor, {", "  setTimeout(() => anchor.focus());\n  emit(\"profile\", anchor, {"],
  ["R2 Enter anchors on the first row", P, 'pick(row, document.querySelector<HTMLElement>(".search-panel .search-row.active") ?? undefined);', 'pick(row, document.querySelector<HTMLElement>(".search-panel .search-row") ?? undefined);'],
  ["R3 Enter opens the first row's person", P, "    const row = flat.value[active.value];\n    if (row) {", "    const row = flat.value[0];\n    if (row) {"],
  ["R7 portal-only hit loses its portalUid", P, "    portalUid: entry.provisioned || entry.openId ? undefined : entry.portalUid,", "    portalUid: undefined,"],
  ["R8 not-yet-joined person carries uid '0'", P, '    uid: entry.provisioned ? String(entry.id) : "",', "    uid: String(entry.id),"],
  ["R10 Send message from search keeps search open", A, "    openContact(entry.provisioned ? entry : await provisionContact(entry, readSession));\n    searchOpen.value = false;", "    openContact(entry.provisioned ? entry : await provisionContact(entry, readSession));"],
  ["App: no-address card is a silent no-op again", A, '    loginError.value = t("profile.unavailable");\n    return;\n  }\n  const uid = target.uid;', "    return;\n  }\n  const uid = target.uid;"],
  ["App: uid 0 taken as a real uid", A, '  if (target.uid === "0") target = { ...target, uid: "" };\n', ""],
];
const originals = Object.fromEntries([P, A, O].map((f) => [f, fs.readFileSync(f, "utf8")]));
const results = [];
try {
  for (const [name, file, before, after] of changes) {
    const src = originals[file];
    assert.equal(src.split(before).length - 1, 1, `unique mutation anchor: ${name}`);
    fs.writeFileSync(file, src.replace(before, after));
    const tsc = spawnSync(process.execPath, ["node_modules/vue-tsc/bin/vue-tsc.js", "--noEmit"], { encoding: "utf8", timeout: 180000 });
    const r = tsc.status !== 0 ? null : spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./tests/setup.ts", "--test",
      ...fs.readdirSync("tests").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/${f}`)], { encoding: "utf8", timeout: 300000, maxBuffer: 64 << 20 });
    fs.writeFileSync(file, src);
    const output = r ? r.stdout + r.stderr : tsc.stdout + tsc.stderr;
    const n = (k) => Number(output.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? NaN);
    const [tests, passed, failed, cancelled] = ["tests", "pass", "fail", "cancelled"].map(n);
    const complete = !!r && !r.signal && !r.error && cancelled === 0 && passed + failed === tests && tests > 0;
    const killed = complete && r.status === 1 && failed > 0 && output.includes("ERR_ASSERTION");
    const status = tsc.status !== 0 ? "INVALID_COMPILE" : !complete ? "INVALID_INCOMPLETE" : killed ? "KILLED" : "SURVIVED";
    const failing = [...output.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i && v !== "failing tests:");
    results.push({ name, file, status, killed, tscRc: tsc.status, exitCode: r?.status ?? null, signal: r?.signal ?? null, tests, passed, failed, cancelled, failing });
    console.log(`${status}: ${name} (tsc ${tsc.status}, ${tests} tests, fail ${failed}) ${failing.slice(0, 2).join(" | ")}`);
  }
} finally {
  for (const [f, s] of Object.entries(originals)) fs.writeFileSync(f, s);
}
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(results, null, 2), { mode: 0o600 });
assert.ok(results.length >= 8);
assert.ok(results.every((r) => r.status === "KILLED"), "every behavioral mutation must be a valid kill");
