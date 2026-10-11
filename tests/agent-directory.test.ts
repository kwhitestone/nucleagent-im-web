import assert from "node:assert/strict";
import test from "node:test";
import { AgentDirectory } from "../src/agents.ts";

const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "unit-test-session" };
const agent = { uid: 12, name: "New", description: "", avatar: "", revision: "opaque-a" };
const response = (data: unknown, revision = "directory-a") => new Response(JSON.stringify({ code: 0, data }),
  { headers: { "X-IM-Directory-Revision": revision } });

test("directory invokes native fetch without an AgentDirectory receiver", async () => {
  const directory = new AgentDirectory(async function (this: unknown, input) {
    assert.equal(this, undefined, "Browser fetch rejects a custom receiver");
    return String(input).includes("/events?")
      ? response({ changed: false, revision: "directory-a" }) : response([agent]);
  });
  await directory.refresh(session);
  assert.equal(await directory.poll(session), false);
  assert.deepEqual(directory.agents, [agent]);
});

test("directory invalidation uses opaque fingerprints and rereads only on change", async () => {
  const calls: string[] = [];
  let changed = false;
  const directory = new AgentDirectory(async input => {
    calls.push(String(input));
    return String(input).includes("/events?") ? response({ changed, revision: changed ? "directory-b" : "directory-a" }) : response([agent]);
  });
  await directory.refresh(session);
  await directory.poll(session);
  assert.equal(calls.length, 2);
  changed = true;
  await directory.poll(session);
  assert.equal(calls.length, 4);
  assert.match(calls[1], /after=directory-a$/);
  assert.deepEqual(directory.agents, [agent]);
});

test("directory discards responses from superseded reads and from previous sessions", async () => {
  let resolve!: (value: Response) => void;
  let first = true;
  const directory = new AgentDirectory(async () => {
    if (first) { first = false; return new Promise<Response>(done => { resolve = done; }); }
    return response([agent], "current");
  });
  const old = directory.refresh(session);
  await directory.refresh(session);
  resolve(response([{ ...agent, name: "Old" }], "old"));
  await old;
  assert.equal(directory.agents[0].name, "New");
  const pending = directory.refresh(session);
  directory.clear();
  await pending;
  assert.deepEqual(directory.agents, []);
});

test("directory read failure clears usable entries and never masquerades as successful empty state", async () => {
  let status = 200;
  const directory = new AgentDirectory(async () => status === 200 ? response([agent]) : new Response("denied", { status }));
  await directory.refresh(session);
  status = 403;
  await assert.rejects(directory.refresh(session), /403/);
  assert.deepEqual(directory.agents, []);
  assert.equal(directory.revision, "");
});
test("event failure clears the fingerprint so recovery must reread the directory", async () => {
  let failed = false;
  const directory = new AgentDirectory(async input => String(input).includes("/events?")
    ? new Response("denied", { status: 403 }) : response([{ ...agent, name: failed ? "Recovered" : "New" }]));
  await directory.refresh(session);
  await assert.rejects(directory.poll(session), /403/);
  assert.equal(directory.revision, "");
  assert.deepEqual(directory.agents, []);
  failed = true;
  assert.equal(await directory.poll(session), true);
  assert.equal(directory.agents[0].name, "Recovered");
});
test("malformed or duplicate directory identities fail closed before rendering", async () => {
  for (const rows of [[null], [{ ...agent, uid: -1 }], [{ ...agent, name: null }],
    [{ ...agent, description: {} }], [{ ...agent, avatar: 2 }], [{ ...agent, revision: 3 }],
    [agent, agent]]) {
    const directory = new AgentDirectory(async () => response(rows));
    await assert.rejects(directory.refresh(session), /Invalid agent directory/);
    assert.deepEqual(directory.agents, []);
    assert.equal(directory.revision, "");
  }
});
