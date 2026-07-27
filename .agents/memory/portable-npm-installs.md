---
name: Portable npm installs
description: Deployment constraint for npm lockfiles generated inside Replit.
---

This project must not ship an npm lockfile whose `resolved` entries point to Replit's private package firewall hostname. External builders such as Vercel cannot access that hostname.

**Why:** The generated lockfile caused Vercel's dependency install to fail before the application build started.

**How to apply:** Before external deployment, validate lockfile URLs against the public npm registry. If the lockfile is absent, Vercel can generate one from `package.json`; if it is committed, generate it against `https://registry.npmjs.org` and verify with a clean `npm ci`.