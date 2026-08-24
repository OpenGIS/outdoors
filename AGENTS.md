## Understanding

To best understand this project:

1. Read the [`README.md`](README.md), then
2. Read **all** of the [Documentation](docs/README.md).

## Making Changes

**Run both builds** after any code change to catch import/resolve errors early:

```bash
npm run build        # builds style.json from build.mjs feature flags
npm run demo:build   # builds the Vue compare app to demo/ via Vite
```

## Documentation

Never write the current state of feature flags or settings into READMEs or docs. Toggles in `scripts/build.mjs` (and similar settings) flip frequently, so "X is currently off/on" claims go stale fast and contradict whatever state the reader has checked out. Describe what each feature or toggle does and how it is controlled — never whether it is currently enabled, disabled, or present in the committed `style.json`.

Likewise, never link to source code by line number (e.g. `scripts/build.mjs#L2555-L2607`) — line anchors go out of sync the moment the file changes. Reference the function, constant, or section by name instead, e.g. `` `fetchBasemap()` in [`scripts/build.mjs`](scripts/build.mjs) ``.
