# Contributing to Zaroorat Backend

Welcome to the team! This guide will help you understand our development process and standards.

## Final Production Flow

Here is an overview of our standard pipeline from code change to deployment:

```text
Developer
      │
      ▼
git add
      │
      ▼
git commit
      │
      ▼
pre-commit
      │
      ├── lint-staged
      ├── ESLint --fix
      ├── Prettier
      ├── TypeScript
      └── Secret Scan (later)
      │
      ▼
commit-msg
      │
      └── Commitlint
      │
      ▼
Commit Created
      │
      ▼
git push
      │
      ▼
pre-push
      │
      ├── TypeScript
      ├── Unit Tests
      ├── Build
      └── Success
      │
      ▼
GitHub Actions
      │
      ├── Lint
      ├── Typecheck
      ├── Tests
      ├── Build
      ├── Security Scan
      ├── Docker Build
      └── Deploy
```

## Branches

- `main`: The production-ready branch. Never push directly to `main`.
- `feature/*`: For new features (e.g., `feature/add-login`).
- `fix/*`: For bug fixes (e.g., `fix/auth-crash`).

## Commits & Commitlint

We strictly follow [Conventional Commits](https://www.conventionalcommits.org/). Our Husky hooks will automatically reject any commit that does not conform to this standard.

### Scopes

You must use one of the following scopes when writing your commit message:

- `auth`
- `driver`
- `ride`
- `payment`
- `notification`
- `admin`

### Examples

- `feat(auth): add login endpoint`
- `fix(driver): resolve GPS update issue`
- `refactor(ride): simplify loader`
- `test(ride): add fare calculation tests`
- `docs(admin): update authentication guide`

## PR Process

1. Create a Pull Request against `main`.
2. Ensure all GitHub Actions CI checks pass.
3. Obtain a code review from a designated code owner.
4. Merge using Squash and Merge.

## Development Setup

- Install dependencies using `npm install` (Yarn/PNPM are disallowed).
- Use Node.js version `v26.4.0` (run `nvm use`).
