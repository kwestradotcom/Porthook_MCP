# @kwestra/mcp-porthook

Hook into any local port, expose it publicly, and QA it — all from one MCP server.

Combines [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (expose localhost) with [Firecrawl v2](https://firecrawl.dev) (scrape, screenshot, crawl, browser sandbox, AI agent).

**Workflow**: `tunnel_start` → get public URL → `qa_scrape` / `qa_screenshot` / `browser_create` / `qa_agent` → `tunnel_stop`

---

### ⚡ Let your AI install it

Paste this into Cursor, Claude Code, or any agent — it will clone, build, and wire up the config:

```
Clone https://github.com/kwestradotcom/Porthook_MCP.git, cd into the repo, run npm install && npm run build, then add porthook as an MCP server pointing to the built dist/index.js with my FIRECRAWL_API_KEY env var.
```

> Get a free Firecrawl API key at [firecrawl.dev](https://firecrawl.dev) (500 credits included).

---

## Tools (19)

### Tunnel Tools (9)

| Tool | Description |
|------|-------------|
| `cloudflared_status` | Check if cloudflared is installed, show version, list active tunnels |
| `cloudflared_install` | Install cloudflared via Homebrew or npm |
| `tunnel_start` | Start a quick (temporary) tunnel — returns a public `*.trycloudflare.com` URL. **Auto-detects Vite** and patches `allowedHosts` |
| `tunnel_stop` | Stop a running tunnel by label (reverts Vite config if patched) |
| `tunnel_stop_all` | Stop all running tunnels |
| `tunnel_list` | List named (persistent) tunnels on your Cloudflare account |
| `tunnel_create` | Create a named persistent tunnel (requires `cloudflared tunnel login`) |
| `tunnel_run` | Run a named tunnel (with local credentials or a dashboard token) |
| `tunnel_delete` | Delete a named tunnel permanently |

### QA Tools (5)

| Tool | Description |
|------|-------------|
| `qa_scrape` | Scrape a URL to markdown — verify content, check rendering, extract data |
| `qa_screenshot` | Take a screenshot — visual QA, layout verification, before/after comparison |
| `qa_crawl` | Crawl an entire site — check all pages load, find broken links, verify routes |
| `qa_check` | Quick health check — HTTP status, title, link count, errors |
| `qa_flow_test` | Multi-step UI flow test with browser actions, JS execution, and pass/fail assertions |

### Browser Sandbox Tools (4)

| Tool | Description |
|------|-------------|
| `browser_create` | Create a persistent browser session — returns sessionId, liveViewUrl, cdpUrl |
| `browser_execute` | Execute code (Node/Python/Bash) in a session with pre-initialized `page` object |
| `browser_list` | List all active browser sessions |
| `browser_close` | Close a browser session — returns duration and credits billed |

### Agent Tool (1)

| Tool | Description |
|------|-------------|
| `qa_agent` | Autonomous AI agent — navigates, clicks, fills forms, extracts structured data |

QA tools, browser sandbox, and agent all work with any public URL, not just tunnel URLs.

## Quick Start

```bash
git clone https://github.com/kwestradotcom/Porthook_MCP.git
cd Porthook_MCP
npm install
npm run build
```

Replace `/path/to/Porthook_MCP` below with your actual clone path.

### Cursor

Open **Settings > MCP** (or `Cmd+Shift+P` → "MCP: Add Server"), then add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "porthook": {
      "command": "node",
      "args": ["/path/to/Porthook_MCP/dist/index.js"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

Restart Cursor after saving. The tools will appear in Cursor's agent mode (Cmd+I).

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "porthook": {
      "command": "node",
      "args": ["/path/to/Porthook_MCP/dist/index.js"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

### VS Code (Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "porthook": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Porthook_MCP/dist/index.js"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

### Claude Code

In `.claude/settings.json`:

```json
{
  "mcpServers": {
    "porthook": {
      "command": "node",
      "args": ["/path/to/Porthook_MCP/dist/index.js"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "porthook": {
      "command": "node",
      "args": ["/path/to/Porthook_MCP/dist/index.js"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

### Agent Skill (Claude Code)

Install the Porthook MCP skill to teach your AI assistant how to chain tools effectively:

```bash
cp -r skills/porthook ~/.claude/skills/porthook
```

This gives the agent workflow patterns, decision trees, and tool chaining knowledge. Optional but recommended.

The `/porthook` command is also included — invoke it with `/porthook tunnel 5173`, `/porthook qa <url>`, etc.

### Development mode (no build step)

For any of the above, you can skip the build and run TypeScript directly:

```json
{
  "mcpServers": {
    "porthook": {
      "command": "npx",
      "args": ["tsx", "/path/to/Porthook_MCP/src/index.ts"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-..."
      }
    }
  }
}
```

## Usage Examples

### Full QA workflow

> "Start a tunnel for my app on port 3000, take a screenshot, then scrape the homepage"

```
tunnel_start(port: 3000, label: "app")
→ Public URL: https://threaded-fathers-explore-supplier.trycloudflare.com

qa_screenshot(url: "https://threaded-fathers-explore-supplier.trycloudflare.com")
→ Screenshot: https://firecrawl-screenshots.s3.amazonaws.com/...

qa_scrape(url: "https://threaded-fathers-explore-supplier.trycloudflare.com")
→ # My App
→ Welcome to the homepage...
→ ## Links (12)
→ - /about
→ - /dashboard
→ ...

tunnel_stop(label: "app")
→ Tunnel "app" stopped.
```

### Vite auto-detection

When tunneling a Vite dev server, Porthook MCP automatically patches the Vite config with `allowedHosts: true` so the tunnel works without 403 errors. The config is reverted when the tunnel stops.

```
tunnel_start(port: 5173, label: "vite-app")
→ Tunnel "vite-app" started successfully.
→ Public URL: https://example.trycloudflare.com
→ Local: http://localhost:5173
→ Vite detected (PID 12345). Patched vite.config.ts with allowedHosts: true (will revert on stop).

tunnel_stop(label: "vite-app")
→ Tunnel "vite-app" stopped.
→ Vite config reverted: /path/to/vite.config.ts
```

### Browser Sandbox

> "Open a browser, navigate to my site, fill out the form, and take a screenshot"

```
browser_create(ttl: 300)
→ Session ID: abc-123
→ Live View: https://browser.firecrawl.dev/live/abc-123

browser_execute(session_id: "abc-123", code: `
  await page.goto('https://my-tunnel.trycloudflare.com');
  await page.fill('#email', 'test@example.com');
  await page.fill('#password', 'secret');
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard');
  const title = await page.title();
  return title;
`)
→ Result: "Dashboard - My App"

browser_execute(session_id: "abc-123", code: `
  const screenshot = await page.screenshot({ fullPage: true });
  return screenshot.toString('base64').slice(0, 100) + '...';
`)
→ Result: "iVBORw0KGgoAAAANSUhEUgA..."

browser_close(session_id: "abc-123")
→ Browser session abc-123 closed.
→ Duration: 45s
→ Credits billed: 3
```

### Autonomous Agent

> "Find pricing information on this website"

```
qa_agent(
  prompt: "Navigate to the pricing page and extract all plan names, prices, and features",
  urls: ["https://example.com"],
  schema: {
    "plans": [{
      "name": "string",
      "price": "string",
      "features": ["string"]
    }]
  }
)
→ Agent completed.
→ Credits used: 12
→ {
→   "plans": [
→     { "name": "Free", "price": "$0/mo", "features": ["1 project", "100 requests/day"] },
→     { "name": "Pro", "price": "$29/mo", "features": ["Unlimited projects", "10K requests/day"] }
→   ]
→ }
```

### Flow test with JavaScript

> "Test login and check localStorage"

```
qa_flow_test(
  url: "https://my-tunnel.trycloudflare.com/login",
  name: "Login with localStorage check",
  steps: [
    { action: "click", selector: "#email" },
    { action: "type", text: "user@test.com" },
    { action: "click", selector: "#password" },
    { action: "type", text: "password123" },
    { action: "click", selector: "button[type=submit]" },
    { action: "wait", milliseconds: 2000 },
    { action: "js", text: "return localStorage.getItem('auth_token')" }
  ],
  pass_if: { url_contains: "/dashboard" }
)
→ PASS — Login with localStorage check
→ JavaScript returns:
→   [1] eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Quick health check

> "Is my dev server responding?"

```
tunnel_start(port: 8080, label: "api")
→ Public URL: https://estate-quilt-cfr-forces.trycloudflare.com

qa_check(url: "https://estate-quilt-cfr-forces.trycloudflare.com/health")
→ OK
→ URL    : https://estate-quilt-cfr-forces.trycloudflare.com/health
→ HTTP   : 200
→ Title  : Health Check
→ Links  : 0
```

### Crawl to find broken pages

> "Crawl my site and check all pages load"

```
qa_crawl(url: "https://my-tunnel-url.trycloudflare.com", limit: 20, max_depth: 3)
→ Crawl complete: 15 pages scraped
→ Credits used: 15
→
→ ## Home
→ URL: / (HTTP 200) | Links: 12
→
→ ## About
→ URL: /about (HTTP 200) | Links: 8
→
→ ## Dashboard
→ URL: /dashboard (HTTP 500) | Links: 0
→ Error: Internal Server Error
```

### Scrape any public URL (no tunnel needed)

QA tools work with any URL — not just tunnels:

```
qa_scrape(url: "https://example.com", formats: ["markdown", "screenshot"])
qa_screenshot(url: "https://staging.myapp.com", full_page: true)
```

## Prerequisites

- **Node.js** >= 18
- **cloudflared** binary — for tunnel tools. Installed via the `cloudflared_install` tool, or manually:
  - macOS: `brew install cloudflared`
  - npm: `npm install -g cloudflared`
  - Linux: [download from Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
- **Firecrawl API key** — for QA tools, browser sandbox, and agent. Get one at [firecrawl.dev](https://firecrawl.dev). Free tier includes 500 credits.

## How It Works

**Tunnels**: The server spawns `cloudflared` as a child process, parses stderr for the public URL, and manages the process lifecycle. All tunnels are cleaned up on server exit. When tunneling a Vite dev server, the config is automatically patched with `allowedHosts: true` to prevent 403 errors from Vite's host header validation.

**QA Tools**: Calls the [Firecrawl REST API](https://docs.firecrawl.dev) (v2) to scrape, screenshot, crawl, or run flow tests. The `qa_flow_test` tool supports JavaScript execution for advanced assertions.

**Browser Sandbox**: Creates persistent browser sessions via Firecrawl's Browser API. Each session provides a Playwright `page` object, a live-view URL for observation, and a CDP WebSocket for external tool integration. Sessions auto-expire after their TTL.

**Agent**: Launches an autonomous AI agent that navigates websites, interacts with elements, and extracts structured data. Give it a prompt and optional JSON schema — it figures out the navigation on its own.

**Together**: Start a tunnel to get a public URL, then pass that URL to any QA tool, browser session, or agent. The agent sees the full loop — expose, test, tear down — in one conversation.

## Updating

```bash
cd /path/to/Porthook_MCP
npm run update
```

This pulls the latest code, installs any new dependencies, and rebuilds. After running it, restart your IDE (Cursor, Claude Desktop, etc.) — MCP servers are spawned once at startup, so a restart is required to pick up the new binary.

## License

MIT
