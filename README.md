# Guarani Verify: AI code review and security verification

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16112/badge)](https://www.bestpractices.dev/en/projects/16112)
[![Test](https://github.com/guarani-llc/guarani-verify-action/actions/workflows/test.yml/badge.svg)](https://github.com/guarani-llc/guarani-verify-action/actions/workflows/test.yml)

Guarani Verify applies versioned policy rules to verification findings and returns `CLEARED` or `HOLD`. The same findings and policy produce the same verdict.

**Guarani AI is in private beta.** The official Private Beta clients are published on npm as [@guarani-ai/cli](https://www.npmjs.com/package/@guarani-ai/cli) and [@guarani-ai/sdk](https://www.npmjs.com/package/@guarani-ai/sdk), and on PyPI as [guarani-ai](https://pypi.org/project/guarani-ai/). Remote execution at [https://api.guarani-llc.com/v1](https://api.guarani-llc.com/v1) requires a `GUARANI_TOKEN` issued to a provisioned Private Beta workspace. Installing a client does not provision service access. This action fails if it cannot obtain a valid verification result.

## GitHub Action

Install [Guarani Verify Action v1.0.2 from GitHub Marketplace](https://github.com/marketplace/actions/guarani-verify-ai-security-pr-review).

Create `guarani.yml` at the repository root and store your workspace token in the `GUARANI_TOKEN` repository secret. For example:

```yaml
name: guarani
on: pull_request

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: guarani-llc/guarani-verify-action@v1.0.2
        with:
          token: ${{ secrets.GUARANI_TOKEN }}
          profile: pull-request
```

The action uses an installed `guarani` CLI when available and otherwise calls the REST API. `CLEARED` exits 0 and `HOLD` exits 1. Missing credentials, service errors, invalid results, failed runs and timeouts fail the step without reporting a verdict. Findings returned by the service are emitted as GitHub Actions annotations.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | Yes | | Workspace access token (`GUARANI_TOKEN`). |
| `profile` | No | `pull-request` | Profile defined in `guarani.yml`. |
| `repo` | No | `${{ github.repository }}` | Repository in `owner/name` format. |
| `ref` | No | `${{ github.ref }}` | Git ref to verify. |
| `report` | No | `github` | Accepted for compatibility; external reports are not published. |
| `api_url` | No | `https://api.guarani-llc.com/v1` | REST API base URL. |

Outputs are `id`, `verdict` and `findings_count` after a completed verification. The token is sent to the configured API URL. HTTPS is required except for a local reference server.

REST requests require TLS 1.2 or later, OpenSSL security level 2 and valid server certificates. The action refuses to run with `NODE_TLS_REJECT_UNAUTHORIZED=0`. Both CLI invocations receive these TLS defaults through `NODE_OPTIONS` and certificate verification is enabled. Install only a trusted Node.js CLI that uses the standard TLS defaults; an external executable can override its own environment or connection options. Local HTTP is available only when explicitly selecting a loopback API URL for testing.

Run the tests with `node --test`. The HTTPS tests use the `openssl` command to create temporary certificates and check that weak keys, old protocols and invalid certificates are rejected before credentials reach the server.

## CLI example from the documentation

The following is the documented CLI workflow. It requires Node.js 20 or later, the published Private Beta CLI package and a provisioned workspace token.

```yaml
name: guarani
on: pull_request

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm i -g @guarani-ai/cli@0.1.0-beta.1
      - run: guarani verify --profile pull-request --report github
        env:
          GUARANI_TOKEN: ${{ secrets.GUARANI_TOKEN }}
```

See the [official documentation](https://guarani-llc.com/en/docs#github-actions) and your workspace's available implementation.

Example configuration from the [documentation](https://guarani-llc.com/en/docs#configuration):

```yaml
# guarani.yml
version: 1
project: acme/core-api

profiles:
  pull-request:
    checks: [architecture, contracts, performance, security]
    tests: generate-missing
    hold_on: [blocking]
  release:
    checks: [architecture, contracts, performance, security, tests]
    mobile: checkout
    hold_on: [blocking, flaky-device]

budgets:
  latency_p95_ms: 450
  memory_mb: 512

mesh:
  policy: balanced  # latency | balanced | cost
  providers: [azure-openai, amazon-bedrock, google-gemini-enterprise, gpu-open-weight]
  residency: us     # us | eu
  daily_budget_usd:
    payments: 66
    search: 60

mobile:
  suites:
    checkout:
      framework: maestro
      path: e2e/checkout
  devices: [pixel-10, iphone-17, galaxy-s25]
  retries: 1
```

The configuration above is sample data and must be adapted to your workspace.

## Support

See [Guarani AI documentation](https://guarani-llc.com/en/docs) or contact sylvain@guarani-llc.com. Report bugs and request features through [GitHub Issues](https://github.com/guarani-llc/guarani-verify-action/issues). See the [contribution guidelines](https://github.com/guarani-llc/.github/blob/main/CONTRIBUTING.md) for the pull request process, and the [security policy](https://github.com/guarani-llc/.github/blob/main/SECURITY.md) for private vulnerability reports.
