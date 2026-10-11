import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configValue, fetchRuntimeConfig, loadRuntimeConfig, parseRuntimeConfig } from "../src/runtimeConfig.ts";
import { runtimeFixture, ZONES, pageOf } from "./fixtures/runtimeConfig.ts";

test("four environments resolve their own explicit endpoints", () => {
  for (const zone of ZONES) {
    const config = runtimeFixture(zone);
    assert.deepEqual({ ...parseRuntimeConfig(config, pageOf(zone)) }, config);
  }
});

test("an environment's page rejects every sibling environment's endpoints", () => {
  for (const zone of ZONES) for (const other of ZONES) {
    if (zone === other) continue;
    assert.throws(() => parseRuntimeConfig(runtimeFixture(zone), pageOf(other)));
    for (const key of ["VITE_AUTH_BASE", "VITE_IM_BASE", "VITE_CORE_BASE", "VITE_SHELL_URL", "VITE_ACCOUNT_UI_URL"] as const) {
      assert.throws(() => parseRuntimeConfig({ ...runtimeFixture(zone), [key]: runtimeFixture(other)[key] }, pageOf(zone)), key);
    }
  }
});

test("one PROD config maps to outer siblings on the outer page", () => {
  const config = runtimeFixture("sdp.ndaeweb.com");
  const actual = parseRuntimeConfig(config, "https://nucleagent-im-web.new.ndhy.com");
  for (const [key, value] of Object.entries(actual)) {
    assert.equal(value, config[key as keyof typeof config].replaceAll(".sdp.ndaeweb.com", ".new.ndhy.com"), key);
  }
});

test("missing, unknown and unsafe values fail closed without echoing input", () => {
  const config = runtimeFixture();
  const page = pageOf();
  for (const body of [null, [], {}, "x", { ...config, SECRET: "private-fixture" },
    ...(["VITE_AUTH_BASE", "VITE_IM_BASE", "VITE_CORE_BASE", "VITE_SHELL_URL", "VITE_ACCOUNT_UI_URL"] as const)
      .map(key => ({ ...config, [key]: undefined }))]) {
    assert.throws(() => parseRuntimeConfig(body, page));
  }
  for (const value of ["", "http://localhost:26670", "http://127.0.0.1:26670", "https://127.0.0.1",
    "http://nucleagent-auth.dev.ndaeweb.com", "https://nucleagent-auth.dev.ndaeweb.com/",
    "https://nucleagent-auth.dev.ndaeweb.com.evil.test", "https://private-fixture@nucleagent-auth.dev.ndaeweb.com",
    "https://nucleagent-auth.dev.ndaeweb.com/?t=private-fixture", "https://nucleagent-auth.dev.ndaeweb.com/x",
    "https://nucleagent-auth.dev.ndaeweb.com\n", " https://nucleagent-auth.dev.ndaeweb.com", 42]) {
    assert.throws(() => parseRuntimeConfig({ ...config, VITE_AUTH_BASE: value }, page),
      (error: Error) => !error.message.includes("private-fixture"));
  }
  for (const value of ["https://nucleagent-web.dev.ndaeweb.com/remote/a.js?t=private-fixture",
    "https://private-fixture@nucleagent-web.dev.ndaeweb.com/remote/a.js", "http://nucleagent-web.dev.ndaeweb.com/a.js",
    "https://nucleagent-web.dev.ndaeweb.com/remote/a.js#private-fixture", "https://evil.example.test/a.js"]) {
    assert.throws(() => parseRuntimeConfig({ ...config, VITE_ACCOUNT_UI_URL: value }, page),
      (error: Error) => !error.message.includes("private-fixture"));
  }
  for (const value of ["*", "null", "https://shell.example.test/", "http://u:private-fixture@localhost",
    "http://localhost:0", "http://localhost,", ",http://localhost", "http://localhost\n", 1]) {
    assert.throws(() => parseRuntimeConfig({ ...config, VITE_SHELL_ALLOWED_ORIGINS: value }, page),
      (error: Error) => !error.message.includes("private-fixture"));
  }
  for (const host of ["", "http://nucleagent-im-web.dev.ndaeweb.com", "http://localhost:26656", "null"]) {
    assert.throws(() => parseRuntimeConfig(config, host));
  }
});

test("optional values keep their existing meaning", () => {
  const config = runtimeFixture();
  const { VITE_SHELL_ALLOWED_ORIGINS: _omit, ...legacy } = config;
  assert.equal(parseRuntimeConfig(legacy, pageOf()).VITE_SHELL_ALLOWED_ORIGINS, "");
  const list = `${config.VITE_SHELL_URL},http://tauri.localhost,https://localhost`;
  assert.equal(parseRuntimeConfig({ ...config, VITE_SHELL_ALLOWED_ORIGINS: list }, pageOf()).VITE_SHELL_ALLOWED_ORIGINS, list);
  assert.equal(parseRuntimeConfig({ ...config, VITE_ACCOUNT_UI_URL: "" }, pageOf()).VITE_ACCOUNT_UI_URL, "");
});

test("fetch is same-origin, uncached, credential-free and fails closed", async () => {
  const config = runtimeFixture();
  let seen: [string, RequestInit | undefined] | undefined;
  const ok = async (url: string | URL | Request, init?: RequestInit) => {
    seen = [String(url), init];
    return new Response(JSON.stringify(config));
  };
  assert.deepEqual({ ...await fetchRuntimeConfig(pageOf(), ok as typeof fetch) }, config);
  assert.equal(seen?.[0], `${pageOf()}/runtime-config.json`);
  assert.equal(seen?.[1]?.credentials, "omit");
  assert.equal(seen?.[1]?.cache, "no-store");
  assert.equal(seen?.[1]?.redirect, "error");
  await assert.rejects(fetchRuntimeConfig(pageOf(), (async () => new Response("", { status: 404 })) as typeof fetch));
  await assert.rejects(fetchRuntimeConfig(pageOf(), (async () => new Response("<html>")) as typeof fetch));
  await loadRuntimeConfig(pageOf(), ok as typeof fetch);
  assert.equal(configValue("VITE_IM_BASE"), config.VITE_IM_BASE);
});

test("reading config before boot loaded it throws instead of defaulting", () => {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    'const m = await import("./src/runtimeConfig.ts"); try { m.configValue("VITE_IM_BASE"); process.exit(1) } catch (e) { if (!/not initialized/.test(e.message)) process.exit(2) }'],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});
