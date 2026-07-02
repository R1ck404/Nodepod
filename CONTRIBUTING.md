# Contributing to nodepod

Thanks for your interest in contributing!

## Setup

```bash
git clone https://github.com/ScelarOrg/Nodepod.git
cd Nodepod
corepack enable
pnpm install
```

## Development

```bash
pnpm run type-check    # TypeScript validation (must pass with 0 errors)
pnpm run build:lib     # Build ESM + CJS library bundles
pnpm run build:types   # Generate type declarations
pnpm run build:publish # Full publish build (lib + types)
pnpm test              # Run test suite
pnpm run test:watch    # Run tests in watch mode
```

## Project Structure

- `src/` — All source code (TypeScript)
  - `polyfills/` — Node.js built-in module implementations
  - `shell/` — Bash-like shell interpreter
  - `packages/` — npm package management
  - `threading/` — Worker-based process model
  - `sdk/` — Public SDK layer (Nodepod, NodepodFS, NodepodTerminal, NodepodProcess)
- `docs/` — Architecture documentation
- `static/` — Service Worker for HTTP interception

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure `pnpm run type-check` passes with 0 errors
4. Ensure `pnpm run build:lib` succeeds
5. Open a PR with a clear description of the change

## Key Conventions

- All polyfill files in `src/polyfills/` are named to match their Node.js module (e.g., `fs.ts`, `http.ts`)
- EventEmitter methods must use `this._reg()` (lazy init pattern) — never access `this._registry` directly
- ESM-to-CJS replacement strings must include trailing semicolons
- CORE_MODULES polyfills must never use `async` functions
- The shell (`src/shell/`) uses `Record<string, string>` for env (not `Map`)

## License

By contributing, you agree that your contributions will be licensed under the MIT + Commons Clause License.
