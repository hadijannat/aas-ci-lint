# AAS CI Lint

Bring Asset Administration Shell validation into CI with first-class GitHub reporting (SARIF + PR annotations).

[![CI](https://github.com/hadijannat/aas-ci-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/hadijannat/aas-ci-lint/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/%40aas-ci-lint%2Fcli.svg)](https://www.npmjs.com/package/@aas-ci-lint/cli)

## Features

**Validate Early, Validate Automatically**
- Validates AASX packages, AAS JSON, and AAS XML files
- Built on the official [AAS Test Engines](https://github.com/admin-shell-io/aas-test-engines) for correctness
- Extends with template-aware validation for IDTA submodel templates

**CI-First Developer Experience**
- SARIF output for GitHub Code Scanning integration
- PR annotations that show issues inline
- Markdown summaries in PR comments
- Deterministic output for reliable caching

**Flexible Integration**
- Use as a GitHub Action for zero-config CI
- Use as a CLI for local development
- Use as a library for custom workflows

## Quick Start

### GitHub Action

```yaml
name: AAS Validation
on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: hadijannat/aas-ci-lint@v1
        with:
          paths: |
            **/*.aasx
            **/*.json
          fail-on: error
```

### CLI

```bash
# Install
npm install -g @aas-ci-lint/cli

# Validate files
aas-ci-lint **/*.aasx

# Generate SARIF
aas-ci-lint --sarif results.sarif models/
```

## Configuration

| Input | Default | Description |
|-------|---------|-------------|
| `paths` | `**/*.aasx`, `**/*.json` | Glob patterns for files to validate |
| `exclude` | - | Patterns to exclude |
| `fail-on` | `error` | Severities that cause failure |
| `sarif` | `aas-lint.sarif` | SARIF output path |
| `upload-sarif` | `true` | Upload SARIF to GitHub |
| `template-version` | latest | IDTA template version |

## How It Works

AAS CI Lint uses a layered validation approach:

1. **AAS Compliance** (via official Test Engines)
   - Validates metamodel conformance
   - Checks structural constraints
   - Verifies serialization correctness

2. **Template Conformance** (optional)
   - Matches submodels to IDTA templates by semantic ID
   - Validates cardinality constraints
   - Checks required elements

Results are normalized and output as:
- Human-readable terminal output
- SARIF for GitHub integration
- JSON for programmatic processing

## Development

```bash
# Clone
git clone https://github.com/hadijannat/aas-ci-lint.git
cd aas-ci-lint

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Prerequisites

- Node.js 20+
- Python 3.10+
- `aas-test-engines`: `pip install aas-test-engines`

## License

MIT © Hadi Jannat
