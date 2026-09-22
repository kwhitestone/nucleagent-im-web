// Minimal SFC renderer for the component tests.
//
// The suite deliberately has no test framework and no jsdom — `node --test`
// plus the compiler and server renderer that already ship inside `vue` are
// enough to assert what a component puts on screen. Pulling in vitest and
// @vue/test-utils to render three components would be a far larger dependency
// surface than the thing under test.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import { parse, compileScript, compileTemplate } from "vue/compiler-sfc";
import { createI18n } from "vue-i18n";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";

// Under the project root, not /tmp and not node_modules: type stripping needs
// the nearest package.json to say "type": "module" (/tmp has none) and node
// refuses to strip types anywhere inside node_modules.
const scratch = mkdtempSync(join(process.cwd(), ".sfc-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;

/**
 * Compiles a .vue SFC to a live component.
 *
 * The compiled output still carries the TypeScript annotations from
 * `<script setup lang="ts">`, so it is written to a real `.ts` file and
 * imported as `.mts` — node's own type stripping (already used to run this
 * suite) handles it. A data: URL would not be stripped, and hand-rolling a regex
 * for it breaks on the first annotation shape nobody predicted.
 */
export async function loadComponent(path: string): Promise<unknown> {
  const source = readFileSync(path, "utf8");
  const { descriptor } = parse(source, { filename: path });
  // inlineTemplate is deliberately off: with it, setup() returns the render
  // function and the component's reactive state is unreachable, so a test could
  // never open a disclosure. Compiled separately, setup() returns its bindings.
  const script = compileScript(descriptor, { id: path });
  const template = compileTemplate({
    source: descriptor.template?.content || "",
    filename: path,
    id: path,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  // Relative imports inside the component resolve against its own directory,
  // not the scratch directory the compiled copy lives in.
  const base = new URL(path, `file://${process.cwd()}/`);
  const code = rewriteImports(script.content, base).replace(
    /export default /,
    "const _sfc_main = ",
  );
  const file = join(scratch, `component-${++seq}.mts`);
  writeFileSync(
    file,
    `${code}\n${rewriteImports(template.code, base)}\n`
      + "const __c = _sfc_main;\n__c.render = render;\nexport default __c;\n",
    "utf8",
  );
  return (await import(`file://${file}`)).default;
}

/** Renders a component to HTML with a real i18n instance installed. */
export async function render(
  component: unknown,
  props: Record<string, unknown> = {},
  locale: "zh" | "en" = "zh",
): Promise<string> {
  const app = createSSRApp(component as never, props);
  app.use(createI18n({ legacy: false, locale, fallbackLocale: "zh", messages: { zh, en } as never }));
  return renderToString(app);
}

/** Vite resolves extensionless and directory imports; node does not. */
function rewriteImports(code: string, base: URL): string {
  return code.replace(/from\s+["'](\.[^"']+)["']/g, (_match, specifier: string) => {
    const url = new URL(specifier, base);
    if (!/\.[a-z]+$/.test(url.pathname)) {
      url.pathname += existsSync(url.pathname) && statSync(url.pathname).isDirectory()
        ? "/index.ts"
        : ".ts";
    }
    return `from "${url.href}"`;
  });
}

/**
 * Renders a component with its disclosure already open.
 *
 * The identity card hides the profile behind a click and SSR only emits the
 * collapsed branch, so the expanded state needs opening first. This flips the
 * component's own `open` ref through the bindings its setup returns — the same
 * state a click sets — rather than pulling in jsdom to deliver one event.
 */
export async function openExpanded(
  component: unknown,
  props: Record<string, unknown> = {},
  locale: "zh" | "en" = "zh",
): Promise<string> {
  const target = component as { setup?: (p: unknown, c: unknown) => unknown };
  const original = target.setup;
  if (!original) throw new Error("component has no setup()");
  target.setup = function patched(this: unknown, componentProps: unknown, context: unknown) {
    const bindings = original.call(this, componentProps, context) as Record<string, unknown>;
    const open = bindings?.open as { value: boolean } | undefined;
    if (!open) throw new Error("component exposes no `open` state");
    open.value = true;
    return bindings;
  };
  try {
    return await render(component, props, locale);
  } finally {
    target.setup = original;
  }
}
