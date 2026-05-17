# Release checklist

Package name: `@mb4it/bitrix-mcp`.
CLI command: `bitrix-mcp`.
Node.js requirement: `>=22.12.0`.

Use this checklist before publishing a public npm release:

```bash
rm -rf dist
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --help
npm pack --dry-run
npm publish --access public
```

For one-off execution without global installation, use the scoped package name with `npx`:

```bash
npx @mb4it/bitrix-mcp init --agent cursor --no-serve
```

Do not publish from automation until you have confirmed npm authentication with the intended `@mb4it` account or organization.
