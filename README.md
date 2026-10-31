# Guarani Verify: AI code review and security verification

Guarani Verify applies versioned policy rules to verification findings and returns `CLEARED` or `HOLD`. The same findings and policy produce the same verdict.

**Guarani AI is in private beta. Access tokens (GUARANI_TOKEN) are issued to provisioned workspaces.** The CLI, SDKs and hosted API are not publicly available yet. Access to a provisioned workspace and the relevant private beta services is required. This action fails if it cannot obtain a valid verification result.

## GitHub Action

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
      - uses: guarani-llc/guarani-verify-action@v1.0.1
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

## CLI example from the documentation

The following is the documented CLI workflow. It requires Node.js 20 or later and an available private beta CLI package.

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
      - run: npm i -g @guarani-ai/cli
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
