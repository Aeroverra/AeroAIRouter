// Build the config-UI client bundle with esbuild.
//
//   node scripts/build-ui.mjs            # one-off production build
//   node scripts/build-ui.mjs --watch    # rebuild on change (dev)
//
// Input:  src/ui/client/main.jsx (Preact + signals, JSX, imports styles.css)
// Output: src/ui/public/app.js  +  src/ui/public/app.css  (both committed to the
//         repo, so a plain `git pull` / fresh clone needs NO build step to run).
// The output is loaded as external `'self'` resources, satisfying the strict CSP
// (script-src 'self'; style-src 'self'; no inline, no CDN).
import { build, context } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, "src/ui/client/main.jsx")],
  outfile: join(root, "src/ui/public/app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "css", ".svg": "text" },
  minify: !watch,
  sourcemap: true,
  legalComments: "none",
  logLevel: "info",
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build:ui] watching for changes…");
} else {
  await build(options);
  console.log("[build:ui] built src/ui/public/app.js + app.css");
}
