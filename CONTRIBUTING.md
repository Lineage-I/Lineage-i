# Contributing to Lineage

Thank you for your interest in contributing to **Lineage** — a supply chain provenance and anti-counterfeiting platform built on the Stellar blockchain.

This guide covers everything you need to get the project running locally, understand the architecture, and submit a quality pull request.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Project Architecture](#project-architecture)
- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
  - [1. Smart Contract](#1-smart-contract)
  - [2. Backend](#2-backend)
  - [3. Frontend](#3-frontend)
- [Running Tests](#running-tests)
- [Development Workflow](#development-workflow)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Issue Labels](#issue-labels)
- [Good First Issues](#good-first-issues)
- [Style Guide](#style-guide)

---

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it. Please report unacceptable behaviour to the maintainers.

---

## Project Architecture

```
lineage/
├── contract/      # Rust · Soroban smart contract (on-chain custody logic)
├── backend/       # Node.js · TypeScript · Express · Prisma (REST API)
└── frontend/      # React 18 · TypeScript · Tailwind CSS · Vite (UI)
```

The three packages are **fully independent** — each builds and runs on its own. You do not need to run all three to work on one.

| Layer | What it does |
|-------|-------------|
| Contract | Stores actors, batches, and transfer events permanently on Stellar |
| Backend | Builds unsigned Soroban transactions, submits signed XDRs, indexes chain events into Postgres, serves the REST API |
| Frontend | Wallet auth via Freighter, producer dashboard, public QR verify page |

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20 | Backend and frontend |
| Rust | stable | Contract only |
| wasm32-unknown-unknown target | — | `rustup target add wasm32-unknown-unknown` |
| Soroban CLI | latest | `cargo install --locked soroban-cli --features opt` |
| Docker | any | Easiest way to run Postgres + Redis locally |
| Git | any | — |

---

## Local Development Setup

### 1. Smart Contract

```bash
cd contract

# Run all tests (should see 10 passing)
cargo test

# Build the WASM (optional — only needed for deployment)
cargo build --target wasm32-unknown-unknown --release
```

No environment variables are needed to run the contract test suite.

### 2. Backend

```bash
# Start Postgres and Redis via Docker
docker run -d --name lineage-pg \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=lineage \
  -e POSTGRES_DB=lineage \
  postgres:15

docker run -d --name lineage-redis \
  -p 6379:6379 \
  redis:7

cd backend
cp .env.example .env
# Edit .env — fill in DATABASE_URL and the Stellar/Pinata values
# Minimum for local dev (no real Stellar calls):
#   DATABASE_URL=postgresql://postgres:lineage@localhost:5432/lineage
#   JWT_SECRET=any-32-char-string-for-local-dev-only
#   CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM
#   ADMIN_SECRET_KEY=SCZANGBA5AAAH4D2FFMDJBVTABFUHBWFLU2OVAP7PKLQYQLWXKCIQB3K

npm install
npm run db:generate   # generates Prisma client
npm run db:push       # creates tables

npm run dev           # starts on :3000 with hot reload
```

The backend exposes a `/health` endpoint — confirm it's running:
```bash
curl http://localhost:3000/health
# {"status":"ok","version":"1.0.0","timestamp":"..."}
```

### 3. Frontend

```bash
cd frontend
cp .env.example .env
# Set VITE_API_URL=http://localhost:3000

npm install
npm run dev           # starts on :5173
```

Open `http://localhost:5173`. Install [Freighter](https://freighter.app) and switch it to **Testnet** to use wallet features.

---

## Running Tests

### Contract (Rust)

```bash
cd contract
cargo test
# 10 tests — all must pass before opening a PR that touches contract/
```

### Backend (TypeScript)

```bash
cd backend
npm test
# Integration tests for auth, actors, and batches routes
```

Backend tests use an in-memory SQLite database via Prisma — no Docker required to run them.

### Frontend

```bash
cd frontend
npm run build   # TypeScript type-check + Vite build
npm run lint    # ESLint
```

There is currently no frontend unit test suite — adding one is a [good first issue](#good-first-issues).

---

## Development Workflow

1. **Find an issue** — look for issues labelled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) or [`help wanted`](../../issues?q=label%3A%22help+wanted%22).
2. **Comment on the issue** to let maintainers know you're working on it. This avoids duplicate effort.
3. **Fork** the repository and clone your fork.
4. **Create a branch** off `main`:
   ```bash
   git checkout -b fix/your-descriptive-branch-name
   ```
5. **Make your change.** Keep it focused — one issue per PR.
6. **Run tests** for the layer(s) you changed (see [Running Tests](#running-tests)).
7. **Commit** with a clear message:
   ```
   fix(backend): validate docHashHex length before Buffer.from conversion

   Buffer.from with 'hex' encoding silently pads odd-length strings.
   Add an explicit regex check for exactly 64 hex characters.
   ```
8. **Push** and open a pull request against `main`.

---

## Submitting a Pull Request

Before opening a PR please confirm:

- [ ] Tests pass for every layer you touched
- [ ] `npm run build` succeeds in `backend/` and `frontend/`
- [ ] No secrets or `.env` files are committed
- [ ] New behaviour is covered by a test (or you've noted why it isn't)
- [ ] Your branch is up to date with `main`

**PR title format:** `type(scope): short description`
- `fix(contract): prevent double-initialization`
- `feat(backend): add pagination to /actors endpoint`
- `docs: clarify IPFS upload flow in README`

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

---

## Issue Labels

| Label | Meaning |
|-------|---------|
| `good first issue` | Small, well-scoped, great for new contributors |
| `help wanted` | Maintainer would welcome a contribution |
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `contract` | Touches the Soroban smart contract |
| `backend` | Touches the Node.js API |
| `frontend` | Touches the React UI |
| `documentation` | Docs, comments, README |
| `tests` | Adding or improving test coverage |

---

## Good First Issues

Not sure where to start? These areas are well-scoped and self-contained:

- **Add frontend unit tests** — set up Vitest + React Testing Library for key components (`BatchCard`, `Timeline`, `Badge`)
- **Add a `/actors/:address/batches` endpoint** — return all batches ever produced or held by a given actor
- **Improve error messages** — many API errors return generic strings; make them actionable
- **Add IPFS gateway fallback** — if Pinata is unreachable, retry with a secondary gateway
- **Add contract event for actor registration** — emit a `(symbol_short!("actor"), symbol_short!("register"))` event from `register_actor`

Look for issues tagged [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) on GitHub.

---

## Style Guide

### Rust (contract)
- Follow standard `rustfmt` formatting (`cargo fmt`)
- Run `cargo clippy` and address all warnings before committing
- Every public function must have a doc comment explaining inputs, outputs, and error cases

### TypeScript (backend + frontend)
- Use the existing ESLint configuration
- Prefer `const` over `let`; avoid `any` — use `unknown` and narrow it
- Async handlers must be wrapped in `try/catch` and call `next(err)` — never swallow errors silently
- All external input must be validated with Zod before use

### Git
- One logical change per commit
- Write commit messages in the imperative mood: "Add X", "Fix Y", "Remove Z"
- Never force-push to `main`

---

*Questions? Open a [GitHub Discussion](../../discussions) or file an issue.*
