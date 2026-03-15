# Contributing to Flight Proxy

Thanks for your interest in contributing to Flight Proxy. This guide covers everything you need to get started.

## Prerequisites

- **Node.js** 20.11.0 or later
- **npm** (ships with Node.js)
- A terminal with git

## Getting Started

```bash
git clone https://github.com/lewisnsmith/flight.git
cd flight
npm install
npm run build
npm link   # makes the `flight` command available globally
```

Verify the setup:

```bash
flight --help
npm run check
```

## Project Structure

```
src/              TypeScript source
  cli.ts          CLI entry point (commander)
  proxy.ts        Core STDIO proxy
  logger.ts       JSONL session logger
  json-rpc.ts     JSON-RPC message parsing
  init.ts         Config discovery and wrapping
  setup.ts        Claude Code hook integration
  hooks.ts        Hallucination hint detection
  progressive-disclosure.ts   Token optimization logic
  lifecycle.ts    Log compression and retention
  stats.ts        Session statistics
  summary.ts      Log summary generation
  export.ts       CSV/JSONL export
  replay.ts       Session replay
  log-commands.ts CLI log subcommands
  index.ts        Public API exports

test/             Test files (vitest)
  *.test.ts       Unit and integration tests
  mock-mcp-server.ts  Test helper

docs/             Documentation
  flight-prd.md   Product requirements document
  plan.md         Sprint plan and roadmap
  CHANGELOG.md    Iteration history

bench/            Benchmarks
  throughput.ts   Throughput benchmark
```

## Development Workflow

The key npm scripts:

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript with tsup |
| `npm run dev` | Build in watch mode |
| `npm test` | Run tests once (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Run ESLint on src/ |
| `npm run typecheck` | Run tsc --noEmit (src and test configs) |
| `npm run check` | Lint + typecheck + test (CI equivalent) |
| `npm run bench` | Run throughput benchmark |

Always run `npm run check` before submitting a PR. This is the same pipeline CI runs.

## Code Style

- TypeScript in strict mode.
- ESLint enforced. Run `npm run lint` to check.
- No emojis in source code or log output.
- Prefer explicit types over `any`. Use `unknown` when the type is genuinely unknown.
- Keep functions small and focused. One export per module where practical.
- Use `readonly` for arrays and objects that should not be mutated.

## Testing Guidelines

Tests use [vitest](https://vitest.dev/).

- Test files live in `test/` and follow the pattern `<module>.test.ts`.
- Each source module should have a corresponding test file.
- Write tests for:
  - Public API surface of each module
  - Edge cases (empty input, malformed JSON-RPC, disk full)
  - Error paths (not just the happy path)
- Use the `mock-mcp-server.ts` helper for integration tests that need a simulated MCP server.
- Keep tests fast. Avoid real filesystem or network access where possible.

Run a single test file:

```bash
npx vitest run test/logger.test.ts
```

## PR Process

1. Fork the repository and create a branch from `main`.
2. Make your changes. Keep commits focused and well-described.
3. Run `npm run check` and confirm everything passes.
4. Open a pull request against `main`.
5. CI runs lint, typecheck, and tests on Node 20 and 22. All checks must pass.
6. A maintainer will review your PR. Address feedback and push updates to the same branch.

Keep PRs small when possible. One feature or fix per PR is easier to review.

## Release Process

Releases are automated via CI and triggered by git tags:

1. A maintainer bumps the version in `package.json`.
2. A tag is pushed: `git tag v0.3.0 && git push --tags`.
3. The release workflow runs `npm run check`, builds, publishes to npm, and creates a GitHub Release with auto-generated release notes.

Contributors do not need to worry about releases. Just get your PR merged into `main`.

## Questions

Open an issue on GitHub if you have questions or want to discuss a feature before starting work.
