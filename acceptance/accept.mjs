// IM-GROUP-BLOCKERS-FIX-NOW browser acceptance (copy of IM-GROUP-IMPLEMENT-NOW accept.mjs + B1-B4 checks).
// CDP 9226, own tab, test data only (local harness). The DEV account-ui URL is answered with the
// local nucleagent-web feat/profile-card-host build via CDP Fetch. Run: flock /tmp/cdp9226.lock node accept.mjs
import fs from "node:fs";
const PORT = 9226, BASE = process.env.BASE || "http://127.0.0.1:26696/acceptance/";
const OUT = "/tmp/imgbf/shots"; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const consoleErrors = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`); };

const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
let seq = 0; const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Fetch.requestPaused") serveShell(msg.params);
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
const send = (method, params = {}, ms = 30000) => new Promise((ok, no) => {
  const id = ++seq; const t = setTimeout(() => no(new Error(`timeout ${method}`)), ms);
  pending.set(id, (msg) => { clearTimeout(t); msg.error ? no(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const SHELL = "/tmp/imgbf/nucleagent-web/dist/remote/";
function serveShell(p) {
  const file = p.request.url.includes("account-ui.version.json") ? "account-ui.version.json" : "account-ui.js";
  const body = fs.readFileSync(SHELL + file).toString("base64");
  const type = file.endsWith(".json") ? "application/json" : "text/javascript";
  send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, body,
    responseHeaders: [{ name: "content-type", value: type }, { name: "access-control-allow-origin", value: "*" }] }).catch(() => {});
}
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
  return r.result.value;
};
const waitFor = async (expr, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(150); } return false; };
let mobile = false;
async function tap(selector, nth = 0) {
  const r = await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no element ${selector}[${nth}]`);
  if (mobile) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
  }
  await sleep(250);
}
const esc = async () => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 75 }, 60000);
  fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(data, "base64")); return `${OUT}/${name}.jpg`;
};
// Is the element's centre on screen, inside the dialog, and is it what a click there hits?
const reachable = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const d = document.querySelector(".group-dialog"); if (!e || !d) return { ok: false, why: "missing" };
  const b = e.getBoundingClientRect(), D = d.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const hit = document.elementFromPoint(x, y); const inView = y > 0 && y < innerHeight && x > 0 && x < innerWidth; const inDialog = b.bottom <= D.bottom + 0.5 && b.top >= D.top - 0.5;
  return { ok: inView && inDialog && !!hit && (hit === e || e.contains(hit)), y: Math.round(y), vh: innerHeight, dBottom: Math.round(D.bottom), h: Math.round(b.height), hit: hit && hit.tagName + "." + hit.className }; })()`);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 768, height: 1024, mobile: true },
  { name: "phone", width: 393, height: 852, mobile: true },
];
const shots = [];
try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*nucleagent-web.dev.ndaeweb.com/remote/account-ui*" }] });
  for (const vp of VIEWPORTS) {
    mobile = vp.mobile;
    await send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
    await send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 });
    for (const n of [2, 30, 80]) {
      const tag = `${vp.name}-n${n}`;
      await send("Page.navigate", { url: `${BASE}?n=${n}` });
      const up = await waitFor(`document.querySelectorAll(".member-row").length === ${n}`, 45000);
      check(`${tag} panel renders ${n} members`, up, await ev(`document.querySelectorAll(".member-row").length`));
      if (!up) continue;
      for (const sel of ['[data-testid="im-group-save"]', ".dialog-actions .danger-text"]) check(`${tag} ${sel} reachable before scroll`, (await reachable(sel)).ok, await reachable(sel));
      const sc = await ev(`(() => { const b = document.querySelector('[data-testid="im-group-body"]'); b.scrollTop = b.scrollHeight; return { scrollable: b.scrollHeight > b.clientHeight, atEnd: Math.abs(b.scrollTop + b.clientHeight - b.scrollHeight) < 2, overflowY: getComputedStyle(b).overflowY }; })()`);
      check(`${tag} body is the scroller and reaches its end`, sc.atEnd && sc.overflowY === "auto", sc);
      await sleep(200);
      const lastRow = '.allowlist:last-of-type .allowlist-hint';
      check(`${tag} last allowlist block reachable after scroll`, (await reachable(lastRow)).ok, await reachable(lastRow));
      for (const sel of ['[data-testid="im-group-save"]', ".dialog-actions .danger-text"]) check(`${tag} ${sel} reachable after scroll`, (await reachable(sel)).ok);
      const small = await ev(`[...document.querySelectorAll(".group-dialog button, .group-dialog .check-row")].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44 && !e.classList.contains("member-name")).map((e) => e.className + ":" + Math.round(e.getBoundingClientRect().height)).slice(0, 5)`);
      if (vp.mobile) check(`${tag} touch targets >= 44px`, small.length === 0, small);
      shots.push(await shot(`${tag}-scrolled`));
    }
    // Interactions on a 30-member group in this viewport.
    const tag = `${vp.name}-n30`;
    await send("Page.navigate", { url: `${BASE}?n=30` });
    await waitFor(`document.querySelectorAll(".member-row").length === 30`, 45000);
    await tap('[data-testid="im-member-remove"]', 2);
    check(`${tag} remove arms confirm, nothing deleted`, await ev(`!!document.querySelector('[data-testid="im-member-remove-confirm"]') && !__calls.some((c) => c.startsWith("DELETE"))`));
    shots.push(await shot(`${tag}-remove-confirm`));
    await esc();
    check(`${tag} Esc disarms confirm, panel stays`, await ev(`!document.querySelector('[data-testid="im-member-remove-confirm"]') && !!document.querySelector(".group-dialog")`));
    await tap('[data-testid="im-member-remove"]', 2);
    await tap('[data-testid="im-member-remove-confirm"]');
    check(`${tag} confirm deletes exactly that member`, await waitFor(`__calls.filter((c) => c.startsWith("DELETE")).length === 1 && document.querySelectorAll(".member-row").length === 29`), await ev(`__calls.filter((c) => c.startsWith("DELETE"))`));
    // Picker view.
    await tap('[data-testid="im-group-add"]');
    check(`${tag} picker replaces member list`, await ev(`!!document.querySelector(".group-dialog .contact-picker") && !document.querySelector(".member-list")`));
    await tap(".group-dialog .contact-search");
    const listed = await waitFor(`document.querySelectorAll(".group-dialog .contact-row, .group-dialog .contact-result").length > 0`, 15000);
    check(`${tag} picker lists candidates`, listed, await ev(`document.querySelectorAll(".group-dialog .contact-row, .group-dialog .contact-result").length`));
    if (listed) {
      const pick = await ev(`(() => { const r = document.querySelector(".group-dialog .contact-row button, .group-dialog .contact-result"); return r && (r.className); })()`);
      await tap(".group-dialog .contact-row > button:first-child, .group-dialog .contact-result", 0);
      await tap(".group-dialog .contact-row > button:first-child, .group-dialog .contact-result", 0);
      check(`${tag} picked 2, add button counts them and is reachable`, (await reachable('[data-testid="im-group-add-confirm"]')).ok && await ev(`/\\(2\\)/.test(document.querySelector('[data-testid="im-group-add-confirm"]').textContent)`), { pick, text: await ev(`document.querySelector('[data-testid="im-group-add-confirm"]').textContent`) });
      shots.push(await shot(`${tag}-picker`));
    }
    await esc(); // closes the open list (if any) only
    const stillPicker = await ev(`!!document.querySelector(".group-dialog .contact-picker")`);
    if (stillPicker) await esc();
    check(`${tag} Esc leaves picker back to members, panel open`, await ev(`!!document.querySelector(".member-list") && !!document.querySelector(".group-dialog")`), { escPressesNeeded: stillPicker ? 2 : 1 });
    if (listed) {
      await tap('[data-testid="im-group-add"]');
      await tap(".group-dialog .contact-search");
      await waitFor(`document.querySelectorAll(".group-dialog .contact-row, .group-dialog .contact-result").length > 0`, 15000);
      await tap(".group-dialog .contact-row > button:first-child, .group-dialog .contact-result", 0);
      await tap('[data-testid="im-group-add-confirm"]');
      check(`${tag} add submits and returns to member list`, await waitFor(`__calls.some((c) => c === "POST /api/v1/im/groups/8/members") && !!document.querySelector(".member-list") && document.querySelectorAll(".member-row").length === 30`), await ev(`__calls.filter((c) => c.startsWith("POST"))`));
    }
    // Profile card: the shared card (feature build) renders in the panel's card area (G2).
    await tap('[data-testid="im-member-profile"]', 3);
    const card = await waitFor(`!!document.querySelector(".acct-pc:not([data-state=loading])")`, 20000);
    check(`${tag} shared profile card opens from a member row`, card);
    if (card) {
      const info = await ev(`(() => { const c = document.querySelector(".acct-pc"); const d = document.querySelector(".group-dialog"); const body = document.querySelector('[data-testid="im-group-body"]');
        const hostEl = c.closest('[data-testid="im-group-card-host"]'); const C = (hostEl || c).getBoundingClientRect(), D = d.getBoundingClientRect(), B = body.getBoundingClientRect();
        const rows = [...document.querySelectorAll(".member-row")].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > B.top && b.top < B.bottom; });
        const covered = rows.filter((r) => { const b = r.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, Math.max(b.top, B.top) + 2); return hit && !r.contains(hit); }).length;
        return { inHost: !!c.closest('[data-testid="im-group-card-host"]'), position: getComputedStyle(c).position, inDialog: C.top >= D.top - 0.5 && C.bottom <= D.bottom + 0.5,
          aboveList: C.bottom <= B.top + 0.5, visibleRows: rows.length, covered, scrims: document.querySelectorAll(".acct-pop-scrim").length,
          addToGroup: /加入群聊|Add to group/.test(c.innerText), name: c.querySelector("[data-testid=acct-pc-name]")?.textContent, panel: !!d }; })()`);
      check(`${tag} G2 card renders inside the panel above the list, covers no member row`, /测试成员|测试智能体/.test(info.name || "") && info.inHost && info.position === "static" && info.inDialog && info.aboveList && info.covered === 0 && info.visibleRows > 0 && info.scrims === 0, info);
      const act = await ev(`(() => { const h = document.querySelector('[data-testid="im-group-card-host"]'); const b = document.querySelector('.acct-pc .acct-pop-btn'); if (!h || !b) return { ok: false };
        b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(), H = h.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { ok: r.top >= H.top - 0.5 && r.bottom <= H.bottom + 0.5 && hit === b, hostScrolls: h.scrollHeight > h.clientHeight }; })()`);
      check(`${tag} card action reachable inside its area (host scrolls when the card is taller)`, act.ok, act);
      check(`${tag} card in group panel has no 'Add to group', panel kept`, !info.addToGroup && info.panel, info);
      for (const sel of ['[data-testid="im-group-save"]', ".dialog-actions .danger-text"]) check(`${tag} ${sel} reachable with card open`, (await reachable(sel)).ok, await reachable(sel));
      await tap('[data-testid="im-member-remove"]', 4);
      check(`${tag} a member row is clickable with the card open (outside click closes card, arms remove)`, await ev(`!document.querySelector(".acct-pc") && !!document.querySelector('[data-testid="im-member-remove-confirm"]')`));
      await esc();
      shots.push(await shot(`${tag}-after-card`));
      await tap('[data-testid="im-member-profile"]', 3);
      await waitFor(`!!document.querySelector(".acct-pc:not([data-state=loading])")`, 10000);
      shots.push(await shot(`${tag}-profile-card`));
      await esc();
      check(`${tag} Esc closes only the card`, await ev(`!document.querySelector(".acct-pc") && !!document.querySelector(".group-dialog") && !__events.includes("close")`), await ev(`({ card: !!document.querySelector(".acct-pc"), events: __events })`));
      await tap('[data-testid="im-member-profile"]', 3);
      await waitFor(`!!document.querySelector(".acct-pc")`, 10000);
      await esc(); await esc();
      check(`${tag} closing the panel takes the card with it`, await ev(`!document.querySelector(".group-dialog") && !document.querySelector(".acct-pc")`));
    } else {
      await esc();
    }
    await esc();
    check(`${tag} final Esc has closed the panel`, await ev(`!document.querySelector(".group-dialog") && __events.includes("close")`));
  }
  // B1-B3 and dissolve through the real buttons (desktop, 30 members).
  mobile = false;
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
  const open30 = async () => { await send("Page.navigate", { url: `${BASE}?n=30` }); await waitFor(`document.querySelectorAll(".member-row").length === 30`, 45000); await sleep(300); };
  const box = (agent, nth) => `.allowlist:nth-of-type(${agent}) .check-row:not(.owner-row) input`;
  const puts = `__calls.filter((c) => c.startsWith("PUT"))`;
  await open30();
  await ev(`__allow[38] = [100, 101]`); // another tab edited agent 38 after this panel opened
  await tap(".allowlist:nth-of-type(1) .check-row:not(.owner-row)", 0); // this panel edits agent 37 only
  await tap('[data-testid="im-group-save"]');
  await waitFor(`!document.querySelector('[data-testid="im-group-save"]').disabled`, 10000);
  check("B1 Save writes only the changed agent; the other tab's edit to 38 survives",
    (await ev(`JSON.stringify(${puts})`)) === JSON.stringify(["PUT /api/v1/im/groups/8/agents/37/allowlist"]) && (await ev(`JSON.stringify(__allow)`)) === JSON.stringify({ 37: [100], 38: [100, 101] }),
    await ev(`({ puts: ${puts}, allow: __allow })`));
  await open30();
  await tap(".allowlist:nth-of-type(1) .check-row:not(.owner-row)", 1); // add uid 101 to 37
  await ev(`__leave(101)`); // ... who leaves before Save
  await tap('[data-testid="im-group-save"]');
  await waitFor(`!document.querySelector('[data-testid="im-group-save"]').disabled`, 10000);
  check("B2 a departed member is dropped, Save succeeds with no error", (await ev(`JSON.stringify(__allow[37])`)) === "[]" && !(await ev(`document.querySelector(".group-dialog .error")?.textContent || ""`)),
    await ev(`({ allow: __allow, error: document.querySelector(".group-dialog .error")?.textContent || "" })`));
  await open30();
  await ev(`__failPut.add(37)`);
  await tap(".allowlist:nth-of-type(1) .check-row:not(.owner-row)", 0);
  await tap(".allowlist:nth-of-type(2) .check-row:not(.owner-row)", 0);
  await tap('[data-testid="im-group-save"]');
  await waitFor(`!document.querySelector('[data-testid="im-group-save"]').disabled`, 10000);
  const partial = await ev(`({ allow: __allow, summary: document.querySelector('[data-testid="im-group-body"] > .error')?.textContent || "", perAgent: [...document.querySelectorAll('[data-testid="im-allowlist-error"]')].map((e) => e.closest(".allowlist").querySelector("strong").textContent) })`);
  check("B3 37 fails, 38 still saved; summary and the failed agent's block name 37", partial.allow[38].includes(100) && partial.allow[37].length === 0 && /测试智能体A/.test(partial.summary) && !/测试智能体B/.test(partial.summary) && partial.perAgent.length === 1 && /测试智能体A/.test(partial.perAgent[0]), partial);
  shots.push(await shot("desktop-n30-partial-save"));
  await ev(`__failPut.clear(); __calls.length = 0`);
  await tap('[data-testid="im-group-save"]');
  await waitFor(`!document.querySelector('[data-testid="im-group-save"]').disabled`, 10000);
  check("B3 Save again retries only 37 and clears the errors", (await ev(`JSON.stringify(${puts})`)) === JSON.stringify(["PUT /api/v1/im/groups/8/agents/37/allowlist"]) && (await ev(`__allow[37].includes(100) && !document.querySelector('[data-testid="im-allowlist-error"]')`)),
    await ev(`({ puts: ${puts}, allow: __allow })`));
  await open30();
  await ev(`window.__confirmAnswer = false; window.confirm = () => window.__confirmAnswer`);
  await tap(".dialog-actions .danger-text");
  check("dissolve: cancel sends nothing", await ev(`!__calls.some((c) => c.startsWith("DELETE /api/v1/im/groups/8")) && !!document.querySelector(".group-dialog")`));
  await ev(`window.__confirmAnswer = true`);
  await tap(".dialog-actions .danger-text");
  check("dissolve: confirm DELETEs the group", await waitFor(`__calls.includes("DELETE /api/v1/im/groups/8")`, 10000), await ev(`__calls.filter((c) => c.startsWith("DELETE"))`));
} catch (error) {
  check("script error", false, String(error && error.stack || error));
} finally {
  const relevant = consoleErrors.filter(Boolean);
  check("console errors = 0", relevant.length === 0, relevant.slice(0, 5));
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync("/tmp/imgbf/accept-out.json", JSON.stringify({ passed, total: results.length, results, shots, consoleErrors: relevant }, null, 1));
  console.log(`TOTAL ${passed}/${results.length}`);
  try { await send("Target.closeTarget", { targetId: target.id }, 5000); } catch { await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {}); }
  ws.close();
}
