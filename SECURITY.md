# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅ Yes    |
| < 0.2   | ❌ No     |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **security@kwestra.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

We'll respond within 48 hours and aim to patch within 7 days for critical issues.

## Credential handling

Porthook MCP never stores, logs, or transmits credentials beyond their intended target:

- `FIRECRAWL_API_KEY` is sent only to `api.firecrawl.dev` over HTTPS
- Cloudflare tunnel tokens are passed directly to the `cloudflared` binary
- No credentials are written to disk, logged to stdout/stderr, or included in error messages

## Process isolation

Each tunnel runs as a child process (`cloudflared`). All child processes are terminated on server exit via `SIGINT`/`SIGTERM` handlers, and on uncaught exceptions.
