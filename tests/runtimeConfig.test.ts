import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function render(overrides: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "im-web-csp-"));
  const template = join(directory, "template");
  const output = join(directory, "output");
  try {
    writeFileSync(template, readFileSync(new URL("../nginx.conf.tpl", import.meta.url)));
    const script = readFileSync(new URL("../docker-entrypoint.d/40-runtime-config.sh", import.meta.url), "utf8")
      .replace("/etc/nginx/templates/nginx.conf.tpl", template)
      .replace("/etc/nginx/conf.d/default.conf", output);
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SHELL_ORIGIN: "https://shell.example.test",
        ...overrides,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      config: result.status === 0 ? readFileSync(output, "utf8") : "",
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
