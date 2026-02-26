---
name: porthook
description: "Porthook MCP usage patterns: tunnel, QA, browser sandbox, agent workflows"
---

# Porthook MCP Skill

Porthook MCP is an MCP server that combines Cloudflare Tunnels (expose localhost) with Firecrawl v2 (scrape, screenshot, crawl, browser sandbox, AI agent). It has 19 tools across four categories.

## Available Tools

### Tunnel Tools (9)

| MCP Tool Name | Description |
|---------------|-------------|
| `mcp__porthook__cloudflared_status` | Check if cloudflared is installed, show version, list active tunnels |
| `mcp__porthook__cloudflared_install` | Install cloudflared via Homebrew (`brew`) or npm (`npm`) |
| `mcp__porthook__tunnel_start` | Start a quick (temporary) tunnel on a port. Returns a public `*.trycloudflare.com` URL. Auto-patches Vite `allowedHosts` |
| `mcp__porthook__tunnel_stop` | Stop a tunnel by label. Reverts Vite config if patched |
| `mcp__porthook__tunnel_stop_all` | Stop all running tunnels |
| `mcp__porthook__tunnel_list` | List named (persistent) tunnels on the Cloudflare account |
| `mcp__porthook__tunnel_create` | Create a named persistent tunnel (requires `cloudflared tunnel login`) |
| `mcp__porthook__tunnel_run` | Run a named tunnel with local credentials or a dashboard token |
| `mcp__porthook__tunnel_delete` | Delete a named tunnel permanently |

### QA Tools (5)

| MCP Tool Name | Description |
|---------------|-------------|
| `mcp__porthook__qa_scrape` | Scrape a URL to markdown, HTML, links, or screenshot |
| `mcp__porthook__qa_screenshot` | Take a viewport or full-page screenshot |
| `mcp__porthook__qa_crawl` | Crawl an entire site, check all pages load, find broken links |
| `mcp__porthook__qa_check` | Quick health check: HTTP status, title, link count, errors |
| `mcp__porthook__qa_flow_test` | Multi-step UI flow test with browser actions, JS execution, and pass/fail assertions |

### Browser Sandbox Tools (4)

| MCP Tool Name | Description |
|---------------|-------------|
| `mcp__porthook__browser_create` | Create a persistent browser session with Playwright `page` object |
| `mcp__porthook__browser_execute` | Execute code (Node/Python/Bash) in a session. State persists between calls |
| `mcp__porthook__browser_list` | List all active browser sessions |
| `mcp__porthook__browser_close` | Close a browser session |

### Agent Tool (1)

| MCP Tool Name | Description |
|---------------|-------------|
| `mcp__porthook__qa_agent` | Autonomous AI agent that navigates, clicks, fills forms, extracts structured data |

## Decision Tree

```
Need to expose localhost?
  Quick (no account needed) → tunnel_start
  Persistent (named, reusable) → tunnel_create + tunnel_run

Need to verify content?
  Readable text / links    → qa_scrape (formats: markdown, links)
  Visual appearance        → qa_screenshot (full_page: true for full scroll)
  Quick health check       → qa_check (HTTP status + title + link count)

Need to test a user flow?
  Declarative steps + assertions → qa_flow_test (define steps[], pass_if)
  Stateful multi-step session    → browser_create + browser_execute (N times) + browser_close

Need to find broken pages?
  → qa_crawl (limit + max_depth)

Need autonomous data extraction?
  → qa_agent (give it a prompt, optional JSON schema, it navigates on its own)
```

## Workflow Patterns

### 1. Tunnel + QA

Expose, verify, tear down:

```
tunnel_start(port: 3000, label: "app")
  → public URL

qa_screenshot(url: "<tunnel_url>")
  → screenshot URL

qa_scrape(url: "<tunnel_url>", formats: ["markdown", "links"])
  → page content + links

tunnel_stop(label: "app")
```

### 2. Browser Testing

Persistent browser session with Playwright control:

```
tunnel_start(port: 3000, label: "app")

browser_create(ttl: 300)
  → session_id, liveViewUrl

browser_execute(session_id: "...", code: `
  await page.goto('<tunnel_url>');
  await page.fill('#email', 'test@example.com');
  await page.click('button[type=submit]');
  return await page.title();
`)

browser_execute(session_id: "...", code: `
  // State persists — still on the same page
  const text = await page.textContent('.welcome');
  return text;
`)

browser_close(session_id: "...")
tunnel_stop(label: "app")
```

### 3. Flow Test

Declarative UI test with pass/fail:

```
tunnel_start(port: 5173, label: "app")

qa_flow_test(
  url: "<tunnel_url>/login",
  name: "Login flow",
  steps: [
    { action: "click", selector: "#email" },
    { action: "type", text: "user@test.com" },
    { action: "click", selector: "#password" },
    { action: "type", text: "password123" },
    { action: "click", selector: "button[type=submit]" },
    { action: "wait", milliseconds: 2000 }
  ],
  pass_if: { url_contains: "/dashboard" }
)

tunnel_stop(label: "app")
```

### 4. Site Crawl

Find broken pages across the site:

```
tunnel_start(port: 3000, label: "app")

qa_crawl(url: "<tunnel_url>", limit: 20, max_depth: 3)
  → pages with HTTP status, links, errors

tunnel_stop(label: "app")
```

### 5. Agent Extraction

Autonomous navigation + structured output. Works on any public URL (no tunnel needed):

```
qa_agent(
  prompt: "Navigate to the pricing page and extract all plan names, prices, and features",
  urls: ["https://example.com"],
  schema: {
    "plans": [{ "name": "string", "price": "string", "features": ["string"] }]
  }
)
```

## Tool Parameters Quick Reference

### Tunnel

| Tool | Key Parameters |
|------|---------------|
| `tunnel_start` | `port` (required, 1-65535), `label` (optional, auto-generated if omitted) |
| `tunnel_stop` | `label` (required) |
| `tunnel_create` | `name` (required) |
| `tunnel_run` | `name` (required), `token` (optional, for dashboard-managed tunnels) |
| `tunnel_delete` | `name` (required), `force` (optional, default false) |
| `cloudflared_install` | `method` ("brew" or "npm") |

### QA

| Tool | Key Parameters |
|------|---------------|
| `qa_scrape` | `url`, `formats` (array of: markdown, html, links, screenshot), `wait_for` (ms, default 1000), `only_main_content` (default true) |
| `qa_screenshot` | `url`, `wait_for` (ms, default 2000), `full_page` (default false) |
| `qa_crawl` | `url`, `limit` (max pages, default 10), `max_depth` (default 2) |
| `qa_check` | `url` |
| `qa_flow_test` | `url`, `name`, `steps` (array of actions), `pass_if` (assertions object) |

### Browser Sandbox

| Tool | Key Parameters |
|------|---------------|
| `browser_create` | `ttl` (seconds, 60-3600, default 300), `activity_ttl` (seconds, 30-1800, default 120) |
| `browser_execute` | `session_id`, `code` (Playwright code with `page` object), `language` (node/python/bash, default node), `timeout` (ms, default 30000) |
| `browser_close` | `session_id` |

### Agent

| Tool | Key Parameters |
|------|---------------|
| `qa_agent` | `prompt` (required), `urls` (optional starting URLs), `schema` (optional JSON schema for structured output) |

## Important Notes

- **Vite auto-patching**: `tunnel_start` detects Vite dev servers and patches `allowedHosts: true` into the config. `tunnel_stop` reverts it. No manual config needed.
- **Always stop tunnels**: Call `tunnel_stop` when done, or `tunnel_stop_all` to clean up everything.
- **Browser state persists**: `browser_execute` calls share the same `page` object. Navigate once, then interact across multiple calls.
- **Agent accepts JSON schema**: Pass a `schema` parameter to `qa_agent` for structured output instead of free-form text.
- **QA tools work on any URL**: Not limited to tunnel URLs. Use them on staging, production, or any public URL.
- **Firecrawl API key**: Set via `FIRECRAWL_API_KEY` env var in MCP config. All QA/browser/agent tools fall back to this. You can also pass `api_key` per-call.
