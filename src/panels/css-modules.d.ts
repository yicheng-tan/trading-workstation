/**
 * Ambient module declaration for CSS Modules, scoped to this package.
 *
 * Vite ships this exact declaration in `vite/client.d.ts`, but nothing in
 * the repo currently references `vite/client` from `tsconfig.app.json`
 * (no `vite-env.d.ts` exists yet, and that tsconfig is out of scope for
 * this workstream), so plain `tsc` doesn't know `*.module.css` imports
 * resolve to a class-name map. Declaring it here - additively, matching
 * Vite's own shape - makes `import styles from './X.module.css'` type-check
 * without touching any shared config files.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
