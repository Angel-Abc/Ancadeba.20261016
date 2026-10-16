# Agents Guide

## Code conventions

- Use single quotes and omit semicolons.
- Adhere to SOLID principles.
- Prefer dependency injection over global singletons.
- Emphasize single responsibility for classes/modules.
- Keep schemas, game-runtime, and utilities independent of browser and Node globals.
- Keep all tests and fixtures under the root `tests/` directory, named `*.test.ts`.
- Use Vite+ APIs from `vite-plus` and test APIs from `vite-plus/test`.

## Development instances

- Reserve ports 5173 (engine), 5174 (editor UI), and 3000 (editor server) for the user's instances.
- Use separate free ports for agent instances, such as 5273, 5274, and 3100.
- Scope temporary environment overrides to agent processes; do not write shared `.env` files.
- Never stop or restart user processes. Clean up only processes started by the agent.

## Validation

Before completing a code task, run `pnpm lint`, `pnpm test`, and `pnpm build`.
Run `pnpm typecheck` when tests or TypeScript configuration change.
