# Vendored anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied from: `skills/install-anti-slop/assets/anti-slop/`
- Installed at: `tools/oxlint/anti-slop/`
- License: MIT; see `LICENSE`. The nested ESLint Stylistic license and provenance are retained.
- This folder is excluded from project linting and formatting to preserve upstream source conventions.
- `@oxlint/plugins` is pinned to 1.88.0, matching the Oxlint version bundled with Vite+ 1.3.0. Keep these versions compatible when upgrading Vite+.

## Local source change

`rules/no-module-mocking.ts` also recognizes `vi` imported from `vite-plus/test`, including import aliases and computed mock method names. Upstream only recognizes the `vitest` and `@jest/globals` import paths. This adaptation is covered by `tests/anti-slop.test.ts`; preserve it when updating the vendored plugin.

## Local policy

The root `vite.config.ts` enables eight generic rules: chained assertions, known-value widening, module mocking, broad `object` parameters, `Reflect.apply`, `Reflect.get`, widen-then-assert flows, and assertion justifications.

The other generic rules and the Effect plugin are intentionally disabled. In particular, unvalidated JSON/MCP dictionaries, `unknown` boundary parameters, runtime type checks, existing spacing, and conditional property omission remain supported. Reconsider dictionary restrictions alongside a deliberate redesign of the raw-document contracts, rather than replacing them solely to satisfy lint.

Assertions must document a specific checked invariant with `SAFETY:`. Tests may use a line-scoped suppression with a reason when they deliberately violate a public type contract to exercise runtime rejection. Do not disable the selected rules for entire test files or directories.
