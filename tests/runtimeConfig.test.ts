import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRuntimeConfig } from "../src/runtimeConfig.ts";
import { pageOf, runtimeFixture, ZONES } from "./fixtures/runtimeConfig.ts";

function render(overrides: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "im-web-csp-"));
  const template = join(directory, "template");
  const output = join(directory, "output");
  const json = join(directory, "runtime-config.json");
  try {
    writeFileSync(template, readFileSync(new URL("../nginx.conf.tpl", import.meta.url)));
    const script = readFileSync(new URL("../docker-entrypoint.d/40-runtime-config.sh", import.meta.url), "utf8")
      .replace("/etc/nginx/runtime.conf.template", template)
      .replace("/etc/nginx/conf.d/default.conf", output)
      .replaceAll("/etc/nucleagent/runtime-config.json", json)
      .replace("mkdir -p /etc/nucleagent", `mkdir -p ${directory}`);
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SHELL_ORIGIN: "https://shell.example.test",
        ...runtimeFixture(),
        ...overrides,
      } as Record<string, string>,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      config: result.status === 0 ? readFileSync(output, "utf8") : "",
      json: result.status === 0 ? readFileSync(json, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("runtime CSP defaults to the shell and preserves nginx variables", () => {
  const result = render({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.config, /frame-ancestors https:\/\/shell\.example\.test"/);
  assert.match(result.config, /try_files \$uri \$uri\/ \/index\.html/);
});

test("runtime CSP accepts an exact configurable origin list", () => {
  const result = render({
    FRAME_ANCESTORS: "https://shell.example.test,https://engine.example.test:8443",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.config,
    /frame-ancestors https:\/\/shell\.example\.test https:\/\/engine\.example\.test:8443"/,
  );
});

test("runtime CSP rejects malformed origins and configuration injection", () => {
  for (const value of [
    "",
    ",",
    "https://shell.example.test,",
    ",https://shell.example.test",
    "https://shell.example.test,,https://engine.example.test",
    "*",
    "'self'",
    "https://*.example.test",
    "https://user:pass@example.test",
    "https://example.test/path",
    "https://example.test?query",
    "https://example.test#fragment",
    "https://example.test:0",
    "https://example.test:65536",
    "https://example.test https://engine.example.test",
    "https://example.test,\nhttps://engine.example.test",
    'https://example.test"; include /tmp/evil; #',
  ]) {
    const result = render({ FRAME_ANCESTORS: value });
    assert.notEqual(result.status, 0, JSON.stringify(value));
    assert.match(result.stderr, /FRAME_ANCESTORS/);
  }
  assert.notEqual(render({ SHELL_ORIGIN: "https://example.test/path" }).status, 0);
});

test("runtime-config.json carries exactly the public whitelist, per environment", () => {
  for (const zone of ZONES) {
    const env = runtimeFixture(zone);
    const result = render({ ...env, SHELL_ORIGIN: "", DB_PASSWORD: "secret-canary", VITE_SECRET: "secret-canary" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.json + result.config, /secret-canary|DB_PASSWORD|VITE_SECRET/);
    const body = JSON.parse(result.json);
    assert.deepEqual(body, env);
    assert.deepEqual({ ...parseRuntimeConfig(body, pageOf(zone)) }, env);
    // SHELL_ORIGIN unset: frame-ancestors follows the configured shell.
    assert.match(result.config, new RegExp(`frame-ancestors ${env.VITE_SHELL_URL.replaceAll(".", "\\.")}"`));
  }
});

test("missing or unsafe browser config fails the container start without echoing it", () => {
  for (const key of ["VITE_AUTH_BASE", "VITE_IM_BASE", "VITE_CORE_BASE", "VITE_SHELL_URL", "VITE_ACCOUNT_UI_URL"]) {
    const env: Record<string, string | undefined> = { ...runtimeFixture() };
    delete env[key];
    const directory = mkdtempSync(join(tmpdir(), "im-web-missing-"));
    try {
      const result = spawnSync("sh", ["-c", readFileSync(new URL("../docker-entrypoint.d/40-runtime-config.sh", import.meta.url), "utf8")
        .replace("mkdir -p /etc/nucleagent", "exit 99")], {
        encoding: "utf8", env: { PATH: process.env.PATH, ...env } as Record<string, string>,
      });
      assert.equal(result.status, 1, `${key}: ${result.stderr}`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  for (const [key, value] of [
    ["VITE_IM_BASE", ""], ["VITE_IM_BASE", "https://im.example.test/"], ["VITE_IM_BASE", 'https://a.test","X":"y'],
    ["VITE_AUTH_BASE", "https://u:secret-canary@auth.example.test"], ["VITE_CORE_BASE", "https://core.example.test?t=secret-canary"],
    ["VITE_ACCOUNT_UI_URL", "https://web.example.test"], ["VITE_ACCOUNT_UI_URL", "https://web.example.test/a.js?t=secret-canary"],
    ["VITE_ACCOUNT_UI_URL", 'https://web.example.test/a".js'], ["VITE_ACCOUNT_UI_URL", "javascript:alert(1)/x"],
    ["VITE_SHELL_ALLOWED_ORIGINS", "https://a.test,"], ["VITE_SHELL_ALLOWED_ORIGINS", "*"],
  ]) {
    const result = render({ [key]: value });
    assert.notEqual(result.status, 0, `${key}=${value}`);
    assert.doesNotMatch(result.stderr, /secret-canary/);
  }
  assert.equal(render({ VITE_ACCOUNT_UI_URL: "" }).status, 0);
  assert.equal(render({ VITE_SHELL_ALLOWED_ORIGINS: "" }).status, 0);
});

test("the image takes no build-time endpoints and keeps the template out of auto-render", () => {
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(dockerfile, /ARG VITE_|test -n|ENV SHELL_ORIGIN/);
  assert.doesNotMatch(dockerfile, /^COPY .*\/etc\/nginx\/templates/m);
  assert.match(dockerfile, /nginx\.conf\.tpl \/etc\/nginx\/runtime\.conf\.template/);
});
