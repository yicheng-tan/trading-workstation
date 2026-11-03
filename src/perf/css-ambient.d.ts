/**
 * Ambient module declaration for plain CSS side-effect imports
 * (`import './Foo.css'`), scoped to this package.
 *
 * Vite ships this via `vite/client.d.ts`, but nothing in the repo
 * currently references `vite/client` from `tsconfig.app.json` (no
 * `vite-env.d.ts` exists yet, and that shared tsconfig is out of scope for
 * this workstream). Declaring it here - additively - lets the perf overlay
 * and stress-control components import their own plain CSS and still
 * type-check under `tsc -p tsconfig.app.json --noEmit`, without touching
 * any shared config files. Mirrors `src/panels/css-modules.d.ts`, which
 * does the same thing for `*.module.css`.
 */
declare module '*.css';
