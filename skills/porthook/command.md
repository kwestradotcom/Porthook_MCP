---
name: porthook
prefix: "@porthook"
category: qa
color: orange
description: "Expose, test, and QA local services with Porthook MCP"
argument-hint: "<workflow>"
---

# /porthook Command

Execute a porthook workflow based on the argument. Parse the user's input and call the appropriate MCP tools.

## Argument Parsing

| Pattern | Action |
|---------|--------|
| `tunnel <port>` | Start a tunnel on the given port |
| `qa <url>` | Full QA: scrape + screenshot + health check |
| `test <url>` | Run a flow test on the URL |
| `crawl <url>` | Crawl the site for broken pages |
| `agent "<prompt>"` | Run the autonomous agent with the given prompt |
| `stop` | Stop all running tunnels |
| `status` | Show cloudflared status and active tunnels |

## Workflow: `tunnel <port>`

1. Call `mcp__porthook__tunnel_start` with the given port
2. Report the public URL back to the user
3. Remind them to stop the tunnel when done

## Workflow: `qa <url>`

Run all three QA checks in sequence:

1. `mcp__porthook__qa_check(url)` — HTTP status, title, link count
2. `mcp__porthook__qa_scrape(url, formats: ["markdown", "links"])` — content + navigation
3. `mcp__porthook__qa_screenshot(url, full_page: true)` — visual snapshot

Summarize findings: status, content overview, screenshot link, any issues found.

## Workflow: `test <url>`

1. Ask the user what flow to test (login, signup, checkout, etc.) if not specified
2. Build a `steps` array from their description
3. Call `mcp__porthook__qa_flow_test(url, name, steps, pass_if)`
4. Report PASS/FAIL with evidence

## Workflow: `crawl <url>`

1. Call `mcp__porthook__qa_crawl(url, limit: 20, max_depth: 3)`
2. Summarize results: total pages, any 4xx/5xx errors, broken links

## Workflow: `agent "<prompt>"`

1. Parse the prompt (everything after `agent`)
2. Extract any URLs mentioned in the prompt for the `urls` parameter
3. Call `mcp__porthook__qa_agent(prompt, urls)`
4. Return the agent's structured output

## Workflow: `stop`

1. Call `mcp__porthook__tunnel_stop_all`
2. Confirm all tunnels stopped

## Workflow: `status`

1. Call `mcp__porthook__cloudflared_status`
2. Report version, install status, and active tunnels

## No argument

If invoked with no argument, show available workflows:

```
/porthook tunnel 5173     — Start tunnel on port
/porthook qa <url>        — Full QA (scrape + screenshot + check)
/porthook test <url>      — Run a flow test
/porthook crawl <url>     — Crawl for broken pages
/porthook agent "prompt"  — Autonomous agent extraction
/porthook stop            — Stop all tunnels
/porthook status          — Show cloudflared status
```
