# GitHub-compatible forge

A single-process, dependency-free Git forge for the make.fun `github-core-clone-01` competition. It serves Git smart HTTP, a GitHub-style REST API, GraphQL, and MCP from one in-memory store.

## Run

Use Node.js 22:

```sh
node --experimental-strip-types main.ts
```

In the competition runtime, `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` are provided by the harness. The server binds an ephemeral port, registers it with the harness, and exits when the trial is complete.

Licensed under the MIT License.
