import { build } from "../node_modules/vite/dist/node/index.js";
import assert from "node:assert/strict";
import vue from "../node_modules/@vitejs/plugin-vue/dist/index.mjs";
import { parse } from "../node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js";
import ts from "../node_modules/typescript/lib/typescript.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const web = resolve(here, "..");
const script = parse(readFileSync(resolve(web, "src/App.vue"), "utf8")).descriptor.scriptSetup.content;
const ast = ts.createSourceFile("App.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const watchers = ast.statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "watch"
  && node.expression.arguments[0]?.getText(ast) === "searchOpen").map(node => node.getText(ast));
assert.equal(watchers.length, 1, "fixture must execute exactly one actual search-exit watcher");
// Execute the consumer's real watcher, not a hand-copied fixture equivalent.
const binding = `import { watch } from "vue"; export default function bind(searchOpen, accountUi) { ${watchers.join("\n")} }`;
await build({
  configFile: false, root: web, logLevel: "warn",
  plugins: [vue(), {
    name: "actual-search-exit",
    resolveId: id => id === "actual-search-exit" ? "\0actual-search-exit" : undefined,
    load: id => id === "\0actual-search-exit" ? binding : undefined,
  }],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: { WEB: web, vue: resolve(web, "node_modules/vue/dist/vue.runtime.esm-bundler.js") } },
  build: { outDir: resolve(root, "build/web"), emptyOutDir: true, copyPublicDir: false,
    target: "es2022", minify: false,
    lib: { entry: resolve(here, "entry.ts"), formats: ["es"], fileName: () => "entry.js" } },
});
for (const [name, tree] of [["main", "shell"], ["host", "shell-host"]]) {
  await build({
    configFile: false, root: resolve(root, tree), logLevel: "warn",
    resolve: { alias: { "@": resolve(root, tree, "src") } },
    build: { outDir: resolve(root, `build/shell-${name}`), emptyOutDir: true, copyPublicDir: false,
      target: "es2022", minify: false,
      lib: { entry: resolve(root, tree, "src/account-ui/popover.ts"), formats: ["es"], fileName: () => "account-ui.js" } },
  });
}
console.log(`Built real search/picker + App watcher (${watchers.length}) + both shell contracts; MOCK network only.`);
