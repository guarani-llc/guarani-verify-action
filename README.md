# Guarani Verify — Autonomous Multi-Agent PR Code & Security Review Action

Official GitHub Action for **[Guarani Verify](https://guarani-llc.com/en/)**, built by **Guarani AI (GUARANI LLC)**.

Guarani Verify runs autonomous multi-agent pull-request reviews, static/semantic security vulnerability detection (SAST/secrets/injection patterns), and architecture compliance checks powered by the **Guarani Mesh** enterprise LLM gateway.

---

## Features

- **Autonomous Multi-Agent PR Triage**: Analyzes pull-request diffs across security, memory safety, authentication flows, and architectural boundaries.
- **Zero-Retention Enterprise Gateway**: Routed through **Guarani Mesh** with context caching and strict tenant isolation.
- **Inline PR Annotations**: Posts actionable remediation diffs directly on pull requests and blocks merges when findings exceed your `severity_threshold`.

---

## Quick Start

Add the following workflow to `.github/workflows/guarani-verify.yml`:

```yaml
name: Guarani Verify PR Security Audit

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  guarani-verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Guarani Verify AI Security & PR Review
        uses: guarani-llc/guarani-verify-action@v1.0.0
        with:
          guarani_api_key: ${{ secrets.GUARANI_API_KEY }}
          severity_threshold: 'high'
```

---

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `guarani_api_key` | **Yes** | — | Your Guarani AI API key (`https://guarani-llc.com/en/`) |
| `api_base_url` | No | `https://api.guarani-llc.com/v1` | Guarani Mesh OpenAI-compatible gateway URL |
| `model` | No | `guarani-verify-pro` | Verification model routed via Guarani Mesh |
| `severity_threshold` | No | `high` | Minimum finding severity to fail the workflow (`low`, `medium`, `high`, `critical`) |
| `github_token` | No | `${{ github.token }}` | Token used to read PR diffs and post review comments |

---

## About Guarani AI (GUARANI LLC)

- **Website**: [https://guarani-llc.com/en/](https://guarani-llc.com/en/)
- **GitHub Organization**: [https://github.com/guarani-llc](https://github.com/guarani-llc)
- **Support & Enterprise Onboarding**: `sylvain@guarani-llc.com`
