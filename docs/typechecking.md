# Type checking

The app has **no build step**. `tsc` runs only as a checker — it never
emits. It reads the JavaScript in place, using JSDoc annotations and the
shared shapes in `types/qms-guardian.d.ts`.

## Run it

```
npm install      # once, at the repo root — installs the type checker
npm run typecheck
```

CI runs the same command on every push and pull request
(`.github/workflows/ci.yml`).

## How adoption works

`checkJs` is **off** in `tsconfig.json`. A file is only checked once it
has a `// @ts-check` line as its first line. Everything else is parsed
for cross-file inference but never reported on, so the checker stays
green while coverage grows one file at a time.

Checked so far:

- `public/js/session.js`
- `public/js/dom.js`

## Opting a file in

1. Add `// @ts-check` as the first line.
2. `npm run typecheck` and read what it flags.
3. Fix real problems; for a genuinely-safe access TypeScript can't see,
   use a JSDoc cast rather than silencing it:

   ```js
   const node = /** @type {HTMLElement} */ (found);
   ```

   Reach for `// @ts-expect-error` (with a reason) only as a last resort.
4. When the file is clean, add it to the list above.

## Shared shapes

`types/qms-guardian.d.ts` declares `QmsField`, `QmsColumn`,
`QmsFormDefinition`, `QmsRecord`, `ApiError`, and related types as
**globals** — reference them from any checked file without an import:

```js
/** @param {QmsField} field */
function buildField(field) { /* ... */ }
```

The server owns these shapes (`server/src/routes/*.js`). Keep the `.d.ts`
in step with `problemWith` in `masterdata.js` and the record routes.
