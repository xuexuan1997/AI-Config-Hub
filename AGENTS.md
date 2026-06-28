# Agent Notes

## Local Node Environment

This project requires Node `>=24 <25` as declared in `package.json`.

Use `fnm` to manage the local Node version when running project commands:

```sh
fnm install 24
fnm use 24
node --version
```

If Vitest, Vite, Rolldown, or other tooling fails with missing modern `node:*` exports, first verify that the active shell is using Node 24 through `fnm`.
