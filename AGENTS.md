# Working on this repository

Archnemesis (command `archnm`) is an architecture-diagram tool: one model saved as YAML,
edited live on a canvas by people and agents. This file is for coding agents changing this
code. For using the tool, see `README.md`; `docs/DESIGN.md` says why the code is shaped as it is.

## Layout and import rules

- `shared/`: pure code for browser and server (model, file grammar, checking, agent tools in
  `shared/tools/`). Lint refuses imports of `server/`, `src/`, `cli/` and `node:*` here.
- `server/`: Node. HTTP API, live sync, MCP endpoint, git, SQLite, sign-in.
- `src/`: the React app. Lint refuses imports of `server/` and `cli/`. It reaches its backend
  only through `src/backend/` (a server backend and a local one for the static build).
- `cli/`: the `archnm` command. Uses `shared/` and talks to servers over HTTP.

## Commands

```sh
pnpm install        # also installs the git hooks
pnpm dev            # server on 127.0.0.1:5190, Vite serving src/
pnpm check          # typecheck, lint, format check, tests
pnpm test:run       # tests once
pnpm knip           # unused files, exports, dependencies
pnpm format         # prettier --write
pnpm build          # the app and the scripts the server hands out
pnpm build:static   # the server-less app into dist-static/
pnpm build:npm      # the publishable package into dist-npm/ (runs pnpm build; see below)
```

## The npm package

`pnpm build:npm` compiles `server/`, `shared/` and `cli/` with tsc (`tsconfig.npm.json`) into
`dist-npm/`, keeping the checkout's layout, and copies `dist/`, `schema/` and `examples/auth/`
beside them; the server finds those one folder above `server/`, so keep reading them that way.
`scripts/build-npm.ts` writes its `package.json`: dependencies are the packages the compiled
code imports, at the versions in the root `package.json`, plus the two read by path in
`server/render.ts`. Its bin is `server/personal-main.ts` (personal mode: `server/personal.ts`).
Publishing is manual: `cd dist-npm && npm publish`.

## Rules lint enforces

- Named exports only; no default exports. No assignments to `window`, `globalThis`, `global`
  or `self`.
- No raw `fetch(...)` in `src/` outside `src/backend/` (tests excepted).
- `process.env` is read only in `server/config.ts` (plus `server/env-compat.ts`,
  `server/e2e.ts`, `server/testing.ts`) and nowhere in `cli/`; take the setting from the
  Config instead.
- Files at most 600 lines and functions at most 150 (blank lines and comments not counted);
  cyclomatic complexity at most 25. Not applied to tests, `cli/`, `scripts/` or config files.
- No `any`; unused variables and arguments must start with `_`; `console.log` is an error
  outside `server/`, tests, `cli/` and `scripts/` (`warn` and `error` are allowed).

## Lint debt

Existing violations are recorded in `eslint-suppressions.json`. A file you touch must be
clean: fix its violations rather than leaning on the record. Never edit that file by hand;
after paying debt off run `pnpm lint:bank`, which prunes it.

## Pre-push hook

`pnpm install` sets up lefthook (`lefthook.yml`). On push it runs the format check, typecheck,
lint, the tests and knip, one after another. The same checks run on GitHub before anything deploys (`.github/workflows/`). `LEFTHOOK_EXCLUDE=slow git push` skips the tests
and knip; `git push --no-verify` skips everything.

## Running a throwaway server

Settings are environment variables read in `server/config.ts`. Use a spare port and private
paths so you do not touch another running server's data:

```sh
ARCHNM_PORT=<spare port> ARCHNM_DB=<tmp dir>/archnm.sqlite ARCHNM_ROOT=<tmp dir>/designs node server/main.ts
```

`<spare port>` is a free port (5190 is the default, and other agents may be using it). Call
`node cli/archnm.ts config` for every setting.

## Commits

One plain sentence saying what changed, as in `git log --oneline`. No type prefixes.
