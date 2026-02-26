#!/usr/bin/env node

/**
 * @kwestra/mcp-porthook v0.2.0
 *
 * Hook into any local port, expose it publicly, and QA it — all from one MCP server.
 *
 * Combines Cloudflare Tunnels (expose) + Firecrawl v2 (test):
 *   1. tunnel_start  → expose localhost on a public URL (auto-patches Vite configs)
 *   2. qa_scrape / qa_screenshot / qa_crawl / qa_flow_test → test the live URL
 *   3. browser_create / browser_execute → persistent browser sandbox sessions
 *   4. qa_agent → autonomous AI agent that navigates and extracts data
 *   5. tunnel_stop   → tear down when done
 *
 * Firecrawl tools work with ANY public URL, not just tunnels.
 * Set FIRECRAWL_API_KEY env var or pass it per-call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawn, type ChildProcess } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── State ──────────────────────────────────────────────────────────

interface TunnelEntry {
  process: ChildProcess;
  url: string | null;
  port: number;
  startedAt: Date;
  type: "quick" | "named";
  name?: string;
  viteConfigPath?: string;
  viteConfigOriginal?: string;
}

/** Active tunnels keyed by a user-chosen label or auto-generated id. */
const tunnels = new Map<string, TunnelEntry>();
let nextId = 1;

interface BrowserSession {
  id: string;
  liveViewUrl: string;
  cdpUrl: string;
  createdAt: Date;
  expiresAt: Date;
}

const browserSessions = new Map<string, BrowserSession>();

// ── Helpers ────────────────────────────────────────────────────────

function findBinary(): string | null {
  try {
    return execSync("which cloudflared", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getVersion(): string | null {
  try {
    const out = execSync("cloudflared --version", { encoding: "utf-8", timeout: 5000 });
    const match = out.match(/cloudflared version (\S+)/);
    return match?.[1] ?? out.trim();
  } catch {
    return null;
  }
}

function installInstructions(): string {
  const platform = process.platform;
  const lines = ["cloudflared is not installed. Install it:"];
  if (platform === "darwin") {
    lines.push("  brew install cloudflared");
  } else if (platform === "linux") {
    lines.push("  curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.repo | sudo tee /etc/yum.repos.d/cloudflared.repo");
    lines.push("  # or: sudo apt-get install cloudflared");
  } else {
    lines.push("  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  }
  lines.push("  # or via npm: npm install -g cloudflared");
  return lines.join("\n");
}

/** Wait for the tunnel URL to appear in cloudflared stderr output. */
function waitForUrl(proc: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Tunnel did not produce a URL within ${timeoutMs / 1000}s.\nOutput so far:\n${output}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      // Quick tunnels output: https://<words>.trycloudflare.com
      const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };

    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (!output.includes("trycloudflare.com")) {
        reject(new Error(`cloudflared exited with code ${code} before producing a URL.\n${output}`));
      }
    });
  });
}

// ── Vite Auto-Detection ────────────────────────────────────────────

interface ViteInfo {
  pid: number;
  cwd: string;
  configPath: string;
}

/** Detect if Vite is running on the given port. Returns config info or null. */
function detectViteOnPort(port: number): ViteInfo | null {
  try {
    // Find PIDs listening on this port
    const pidOutput = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
    if (!pidOutput) return null;

    const pids = pidOutput.split("\n").map((p) => p.trim()).filter(Boolean);

    for (const pid of pids) {
      try {
        // Check if this process is Vite
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8", timeout: 5000 }).trim();
        if (!cmd.toLowerCase().includes("vite")) continue;

        // Find the working directory
        const lsofOutput = execSync(`lsof -p ${pid}`, { encoding: "utf-8", timeout: 5000 });
        const cwdMatch = lsofOutput.match(/\bcwd\b\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)/);
        let cwd = cwdMatch?.[1]?.trim();

        if (!cwd) {
          // Fallback: try pwdx on Linux or lsof -d cwd
          try {
            const pwdxOut = execSync(`lsof -d cwd -p ${pid} -Fn`, { encoding: "utf-8", timeout: 5000 });
            const nameMatch = pwdxOut.match(/\nn(.+)/);
            cwd = nameMatch?.[1]?.trim();
          } catch {
            // skip
          }
        }

        if (!cwd) continue;

        // Search for Vite config files
        const configNames = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];
        for (const name of configNames) {
          const configPath = `${cwd}/${name}`;
          if (existsSync(configPath)) {
            return { pid: Number(pid), cwd, configPath };
          }
        }
      } catch {
        // skip this PID
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Inject `allowedHosts: true` into a Vite config's server block. Returns original content for revert, or null if no change needed. */
function injectAllowedHosts(configPath: string): string | null {
  try {
    const original = readFileSync(configPath, "utf-8");

    // Already has allowedHosts — no change needed
    if (original.includes("allowedHosts")) return null;

    // Find `server: {` or `server:{` and inject after the opening brace
    const serverBlockRegex = /(server\s*:\s*\{)/;
    const match = original.match(serverBlockRegex);
    if (!match) return null;

    const modified = original.replace(serverBlockRegex, `$1\n    allowedHosts: true,`);
    writeFileSync(configPath, modified, "utf-8");
    return original;
  } catch {
    return null;
  }
}

/** Revert a Vite config to its original content. Best-effort. */
function revertViteConfig(entry: TunnelEntry): void {
  try {
    if (entry.viteConfigPath && entry.viteConfigOriginal) {
      writeFileSync(entry.viteConfigPath, entry.viteConfigOriginal, "utf-8");
    }
  } catch {
    // best-effort
  }
}

// ── Server ─────────────────────────────────────────────────────────

// ── Firecrawl ─────────────────────────────────────────────────────

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

function getFirecrawlKey(explicit?: string): string | null {
  return explicit || process.env.FIRECRAWL_API_KEY || null;
}

async function firecrawlRequest(
  path: string,
  body: Record<string, unknown>,
  apiKey: string,
  method: "POST" | "GET" | "DELETE" = "POST",
  timeoutMs = 60_000,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text || res.statusText };
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const server = new McpServer({
  name: "mcp-porthook",
  version: "0.2.0",
});

// ── Tool: status ───────────────────────────────────────────────────

server.registerTool(
  "cloudflared_status",
  {
    description:
      "Check if cloudflared is installed, show version, and list active tunnels managed by this server.",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const bin = findBinary();
    if (!bin) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    const version = getVersion();
    const activeTunnels = Array.from(tunnels.entries()).map(([id, t]) => ({
      id,
      url: t.url,
      port: t.port,
      type: t.type,
      name: t.name,
      vitePatched: !!t.viteConfigPath,
      uptime: `${Math.round((Date.now() - t.startedAt.getTime()) / 1000)}s`,
    }));

    const text = [
      `cloudflared: ${bin}`,
      `version: ${version ?? "unknown"}`,
      `active tunnels: ${activeTunnels.length}`,
      ...activeTunnels.map(
        (t) =>
          `  [${t.id}] ${t.url ?? "(connecting...)"} → localhost:${t.port} (${t.type}${t.name ? `, name=${t.name}` : ""}${t.vitePatched ? ", vite-patched" : ""}, uptime ${t.uptime})`,
      ),
    ].join("\n");

    return { content: [{ type: "text" as const, text }] };
  },
);

// ── Tool: tunnel_start ─────────────────────────────────────────────

server.registerTool(
  "tunnel_start",
  {
    description:
      "Start a quick (temporary) Cloudflare Tunnel that exposes a local port to the internet. " +
      "Returns a public https://*.trycloudflare.com URL. No authentication required. " +
      "Auto-detects Vite dev servers and patches their config to allow tunnel Host headers. " +
      "The tunnel stays open until stopped with tunnel_stop.",
    inputSchema: z.object({
      port: z.number().int().min(1).max(65535).describe("Local port to expose (e.g. 3000, 8080)"),
      label: z
        .string()
        .optional()
        .describe("Optional human-readable label for this tunnel (e.g. 'frontend', 'api'). Auto-generated if omitted."),
      protocol: z
        .enum(["http", "https"])
        .default("http")
        .describe("Protocol of the local service. Defaults to http."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ port, label, protocol }) => {
    if (!findBinary()) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    const id = label ?? `tunnel-${nextId++}`;
    if (tunnels.has(id)) {
      return {
        content: [{ type: "text" as const, text: `A tunnel with label "${id}" is already running. Stop it first or use a different label.` }],
        isError: true,
      };
    }

    const localUrl = `${protocol}://localhost:${port}`;
    const proc = spawn("cloudflared", ["tunnel", "--url", localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry: TunnelEntry = {
      process: proc,
      url: null,
      port,
      startedAt: new Date(),
      type: "quick",
    };
    tunnels.set(id, entry);

    proc.on("exit", () => {
      revertViteConfig(entry);
      tunnels.delete(id);
    });

    try {
      const url = await waitForUrl(proc);
      entry.url = url;

      // Vite auto-detection: patch config if Vite is running on this port
      const notes: string[] = [];
      const viteInfo = detectViteOnPort(port);
      if (viteInfo) {
        const original = injectAllowedHosts(viteInfo.configPath);
        if (original) {
          entry.viteConfigPath = viteInfo.configPath;
          entry.viteConfigOriginal = original;
          notes.push(`Vite detected (PID ${viteInfo.pid}). Patched ${viteInfo.configPath} with allowedHosts: true (will revert on stop).`);
        } else {
          notes.push(`Vite detected (PID ${viteInfo.pid}) — allowedHosts already configured.`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Tunnel "${id}" started successfully.`,
              ``,
              `Public URL : ${url}`,
              `Local      : ${localUrl}`,
              ...(notes.length > 0 ? [``, ...notes] : []),
              ``,
              `The URL is live and publicly accessible. Use tunnel_stop to close it.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      // Cleanup on failure
      proc.kill("SIGTERM");
      tunnels.delete(id);
      return {
        content: [{ type: "text" as const, text: `Failed to start tunnel: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: tunnel_stop ──────────────────────────────────────────────

server.registerTool(
  "tunnel_stop",
  {
    description: "Stop a running tunnel by its label/id. Use cloudflared_status to list active tunnels.",
    inputSchema: z.object({
      label: z.string().describe("The label or id of the tunnel to stop"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ label }) => {
    const entry = tunnels.get(label);
    if (!entry) {
      const active = Array.from(tunnels.keys());
      return {
        content: [
          {
            type: "text" as const,
            text: active.length
              ? `No tunnel with label "${label}". Active tunnels: ${active.join(", ")}`
              : `No tunnel with label "${label}". No tunnels are currently running.`,
          },
        ],
        isError: true,
      };
    }

    revertViteConfig(entry);
    entry.process.kill("SIGTERM");
    tunnels.delete(label);

    const parts = [`Tunnel "${label}" stopped. URL ${entry.url ?? "(unknown)"} is no longer accessible.`];
    if (entry.viteConfigPath) {
      parts.push(`Vite config reverted: ${entry.viteConfigPath}`);
    }

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  },
);

// ── Tool: tunnel_stop_all ──────────────────────────────────────────

server.registerTool(
  "tunnel_stop_all",
  {
    description: "Stop all running tunnels managed by this server.",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const count = tunnels.size;
    if (count === 0) {
      return { content: [{ type: "text" as const, text: "No tunnels are running." }] };
    }

    for (const [id, entry] of tunnels) {
      revertViteConfig(entry);
      entry.process.kill("SIGTERM");
      tunnels.delete(id);
    }

    return { content: [{ type: "text" as const, text: `Stopped ${count} tunnel(s).` }] };
  },
);

// ── Tool: tunnel_list_named ────────────────────────────────────────

server.registerTool(
  "tunnel_list",
  {
    description:
      "List all named (persistent) Cloudflare Tunnels registered on your account. Requires prior `cloudflared tunnel login`.",
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    if (!findBinary()) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    try {
      const output = execSync("cloudflared tunnel list", {
        encoding: "utf-8",
        timeout: 15_000,
      });
      return { content: [{ type: "text" as const, text: output.trim() || "No named tunnels found." }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to list tunnels (have you run 'cloudflared tunnel login'?):\n${msg}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: tunnel_create ────────────────────────────────────────────

server.registerTool(
  "tunnel_create",
  {
    description:
      "Create a new named (persistent) Cloudflare Tunnel. Requires prior `cloudflared tunnel login`. " +
      "The tunnel is registered but not running — use tunnel_run to start it.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Name for the persistent tunnel (e.g. 'my-api', 'staging')"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ name }) => {
    if (!findBinary()) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    try {
      const output = execSync(`cloudflared tunnel create ${name}`, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Named tunnel "${name}" created successfully.`,
              ``,
              output.trim(),
              ``,
              `Next steps:`,
              `1. Route DNS: cloudflared tunnel route dns ${name} <hostname>`,
              `2. Start it: use tunnel_run tool with this name`,
            ].join("\n"),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to create tunnel:\n${msg}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: tunnel_run ───────────────────────────────────────────────

server.registerTool(
  "tunnel_run",
  {
    description:
      "Run a named (persistent) Cloudflare Tunnel. The tunnel must already exist (via tunnel_create or the Cloudflare dashboard). " +
      "Stays running until stopped with tunnel_stop.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Name or UUID of the tunnel to run"),
      token: z
        .string()
        .optional()
        .describe("Optional tunnel token for remotely-managed tunnels (from Cloudflare dashboard)"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ name, token }) => {
    if (!findBinary()) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    if (tunnels.has(name)) {
      return {
        content: [{ type: "text" as const, text: `Tunnel "${name}" is already running.` }],
        isError: true,
      };
    }

    const args = token
      ? ["tunnel", "run", "--token", token]
      : ["tunnel", "run", name];

    const proc = spawn("cloudflared", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(token ? { TUNNEL_TOKEN: token } : {}) },
    });

    const entry: TunnelEntry = {
      process: proc,
      url: null,
      port: 0,
      startedAt: new Date(),
      type: "named",
      name,
    };
    tunnels.set(name, entry);

    proc.on("exit", () => {
      revertViteConfig(entry);
      tunnels.delete(name);
    });

    // Named tunnels don't output a trycloudflare URL — they use your DNS.
    // Wait briefly for connection confirmation.
    return new Promise((resolve) => {
      let output = "";
      const timer = setTimeout(() => {
        resolve({
          content: [
            {
              type: "text" as const,
              text: [
                `Named tunnel "${name}" started.`,
                `It is now running and routing traffic through your configured DNS.`,
                `Use tunnel_stop with label "${name}" to shut it down.`,
                output ? `\nRecent output:\n${output.slice(-500)}` : "",
              ].join("\n"),
            },
          ],
        });
      }, 8000);

      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        // If we see a registered connection, resolve early
        if (output.includes("Registered tunnel connection")) {
          clearTimeout(timer);
          resolve({
            content: [
              {
                type: "text" as const,
                text: [
                  `Named tunnel "${name}" connected successfully.`,
                  `Routing traffic through your configured DNS hostname(s).`,
                  `Use tunnel_stop with label "${name}" to shut it down.`,
                ].join("\n"),
              },
            ],
          });
        }
      };

      proc.stderr?.on("data", onData);
      proc.stdout?.on("data", onData);

      proc.on("error", (err) => {
        clearTimeout(timer);
        tunnels.delete(name);
        resolve({
          content: [{ type: "text" as const, text: `Failed to run tunnel: ${err.message}` }],
          isError: true,
        });
      });

      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (!output.includes("Registered tunnel connection")) {
          tunnels.delete(name);
          resolve({
            content: [{ type: "text" as const, text: `Tunnel exited with code ${code}.\n${output.slice(-500)}` }],
            isError: true,
          });
        }
      });
    });
  },
);

// ── Tool: tunnel_delete ────────────────────────────────────────────

server.registerTool(
  "tunnel_delete",
  {
    description:
      "Delete a named Cloudflare Tunnel permanently. The tunnel must be stopped first (no active connections).",
    inputSchema: z.object({
      name: z.string().min(1).describe("Name or UUID of the tunnel to delete"),
      force: z.boolean().default(false).describe("Force delete even if connections exist"),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  async ({ name, force }) => {
    if (!findBinary()) {
      return { content: [{ type: "text" as const, text: installInstructions() }], isError: true };
    }

    // Stop local process if running
    const running = tunnels.get(name);
    if (running) {
      revertViteConfig(running);
      running.process.kill("SIGTERM");
      tunnels.delete(name);
    }

    try {
      const cmd = force
        ? `cloudflared tunnel delete -f ${name}`
        : `cloudflared tunnel delete ${name}`;
      const output = execSync(cmd, { encoding: "utf-8", timeout: 15_000 });
      return {
        content: [{ type: "text" as const, text: `Tunnel "${name}" deleted.\n${output.trim()}` }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to delete tunnel:\n${msg}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: tunnel_install ───────────────────────────────────────────

server.registerTool(
  "cloudflared_install",
  {
    description:
      "Install the cloudflared binary. Attempts Homebrew on macOS, or falls back to the npm `cloudflared` package.",
    inputSchema: z.object({
      method: z
        .enum(["brew", "npm"])
        .default("brew")
        .describe("Installation method. 'brew' for Homebrew (macOS), 'npm' for the npm wrapper package."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ method }) => {
    // Already installed?
    if (findBinary()) {
      const version = getVersion();
      return {
        content: [{ type: "text" as const, text: `cloudflared is already installed (${version ?? "unknown version"}).` }],
      };
    }

    const cmd = method === "brew" ? "brew install cloudflared" : "npm install -g cloudflared";

    try {
      const output = execSync(cmd, { encoding: "utf-8", timeout: 120_000 });
      const version = getVersion();
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `cloudflared installed successfully via ${method}.`,
              version ? `Version: ${version}` : "",
              output.trim() ? `\n${output.trim().slice(-300)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Installation failed:\n${msg}` }],
        isError: true,
      };
    }
  },
);

// ── Firecrawl QA Tools ─────────────────────────────────────────────

server.registerTool(
  "qa_scrape",
  {
    description:
      "Scrape a URL and return its content as markdown. Works with tunnel URLs or any public URL. " +
      "Use this to verify page content, check that text renders correctly, or extract structured data from a live page.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to scrape (e.g. a tunnel URL from tunnel_start)"),
      formats: z
        .array(z.enum(["markdown", "html", "links", "screenshot"]))
        .default(["markdown", "links"])
        .describe("Output formats. 'markdown' for readable text, 'links' to check navigation, 'screenshot' for visual."),
      wait_for: z.number().int().min(0).max(30000).default(1000).describe("Milliseconds to wait for JS rendering before scraping. Default 1000."),
      only_main_content: z.boolean().default(true).describe("Strip nav/footer/headers, keep main content only."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, formats, wait_for, only_main_content, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter.\nGet a key at https://firecrawl.dev" }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest("/scrape", {
        url,
        formats,
        waitFor: wait_for,
        onlyMainContent: only_main_content,
      }, key);

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Firecrawl error (${status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const result = data.data as Record<string, unknown> | undefined;
      if (!result) {
        return { content: [{ type: "text" as const, text: "Scrape returned no data." }], isError: true };
      }

      const parts: string[] = [];
      const meta = result.metadata as Record<string, unknown> | undefined;

      if (meta?.title) parts.push(`# ${meta.title}`);
      if (meta?.statusCode) parts.push(`HTTP ${meta.statusCode}`);
      parts.push("");

      if (result.markdown) {
        const md = String(result.markdown);
        parts.push(md.length > 4000 ? md.slice(0, 4000) + "\n\n...(truncated)" : md);
      }

      if (result.links && Array.isArray(result.links)) {
        parts.push(`\n## Links (${(result.links as string[]).length})`);
        for (const link of (result.links as string[]).slice(0, 20)) {
          parts.push(`- ${link}`);
        }
        if ((result.links as string[]).length > 20) parts.push(`  ...and ${(result.links as string[]).length - 20} more`);
      }

      if (result.screenshot) {
        parts.push(`\n## Screenshot\n${result.screenshot}`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Scrape failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "qa_screenshot",
  {
    description:
      "Take a screenshot of a URL and return the image URL. " +
      "Use this for visual QA — verify layouts, check for rendering bugs, compare before/after.",
    inputSchema: z.object({
      url: z.string().url().describe("The URL to screenshot"),
      wait_for: z.number().int().min(0).max(30000).default(2000).describe("Milliseconds to wait for rendering. Default 2000."),
      full_page: z.boolean().default(false).describe("Capture the full scrollable page, not just the viewport."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, wait_for, full_page, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest("/scrape", {
        url,
        formats: ["screenshot"],
        waitFor: wait_for,
        actions: full_page
          ? [{ type: "screenshot", fullPage: true }, { type: "scrape" }]
          : undefined,
      }, key);

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Firecrawl error (${status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const result = data.data as Record<string, unknown> | undefined;
      const screenshotUrl = result?.screenshot as string | undefined;
      const meta = result?.metadata as Record<string, unknown> | undefined;

      // Check for action screenshots (full-page mode)
      const actions = result?.actions as { screenshots?: string[] } | undefined;
      const actionScreenshot = actions?.screenshots?.[0];
      const finalUrl = actionScreenshot || screenshotUrl;

      if (!finalUrl) {
        return { content: [{ type: "text" as const, text: "Screenshot returned no image URL." }], isError: true };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Screenshot of ${url}`,
              meta?.title ? `Title: ${meta.title}` : "",
              meta?.statusCode ? `HTTP ${meta.statusCode}` : "",
              ``,
              `Image URL: ${finalUrl}`,
              ``,
              `Open the URL above to view the screenshot.`,
            ].filter(Boolean).join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "qa_crawl",
  {
    description:
      "Crawl a site starting from a URL. Returns scraped content for each discovered page. " +
      "Use this to QA an entire site — check that all pages load, find broken links, verify content across routes. " +
      "This is async: starts the crawl and polls until complete or timeout.",
    inputSchema: z.object({
      url: z.string().url().describe("Starting URL to crawl"),
      limit: z.number().int().min(1).max(100).default(10).describe("Max pages to crawl. Default 10."),
      max_depth: z.number().int().min(1).max(5).default(2).describe("Max link-follow depth. Default 2."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, limit, max_depth, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      // Start the crawl
      const start = await firecrawlRequest("/crawl", {
        url,
        limit,
        maxDepth: max_depth,
        scrapeOptions: { formats: ["markdown", "links"] },
      }, key);

      if (!start.ok) {
        return {
          content: [{ type: "text" as const, text: `Firecrawl crawl error (${start.status}): ${JSON.stringify(start.data)}` }],
          isError: true,
        };
      }

      const crawlId = start.data.id as string;
      if (!crawlId) {
        return { content: [{ type: "text" as const, text: "Crawl started but no job ID returned." }], isError: true };
      }

      // Poll for completion (max 120s)
      const deadline = Date.now() + 120_000;
      let result: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));

        const poll = await fetch(`${FIRECRAWL_BASE}/crawl/${crawlId}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const pollData = (await poll.json()) as Record<string, unknown>;

        if (pollData.status === "completed" || pollData.status === "failed") {
          result = pollData;
          break;
        }
      }

      if (!result) {
        return {
          content: [{ type: "text" as const, text: `Crawl ${crawlId} still running after 120s. Check status manually.` }],
        };
      }

      if (result.status === "failed") {
        return {
          content: [{ type: "text" as const, text: `Crawl failed: ${JSON.stringify(result)}` }],
          isError: true,
        };
      }

      // Format results
      const pages = (result.data as Array<Record<string, unknown>>) || [];
      const parts: string[] = [
        `Crawl complete: ${pages.length} pages scraped`,
        `Credits used: ${result.creditsUsed ?? "?"}`,
        "",
      ];

      for (const page of pages.slice(0, 20)) {
        const meta = page.metadata as Record<string, unknown> | undefined;
        const pageUrl = meta?.sourceURL || meta?.url || "?";
        const status = meta?.statusCode || "?";
        const title = meta?.title || "(no title)";
        const md = page.markdown ? String(page.markdown).slice(0, 200) : "";
        const linkCount = Array.isArray(page.links) ? page.links.length : 0;

        parts.push(`## ${title}`);
        parts.push(`URL: ${pageUrl} (HTTP ${status})`);
        parts.push(`Links: ${linkCount}`);
        if (md) parts.push(`Preview: ${md}...`);
        parts.push("");
      }

      if (pages.length > 20) {
        parts.push(`...and ${pages.length - 20} more pages`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Crawl failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "qa_check",
  {
    description:
      "Quick health check: scrape a URL and report HTTP status, title, link count, and any errors. " +
      "The fastest way to verify a tunnel or deployed page is working.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to check"),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest("/scrape", {
        url,
        formats: ["links"],
        waitFor: 500,
        onlyMainContent: false,
      }, key, "POST", 15_000);

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `FAIL — Firecrawl returned ${status}: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const result = data.data as Record<string, unknown> | undefined;
      const meta = result?.metadata as Record<string, unknown> | undefined;
      const links = Array.isArray(result?.links) ? result.links as string[] : [];

      const httpStatus = meta?.statusCode ?? "?";
      const title = meta?.title ?? "(no title)";
      const error = meta?.error;

      const parts = [
        error ? `FAIL` : `OK`,
        `URL    : ${url}`,
        `HTTP   : ${httpStatus}`,
        `Title  : ${title}`,
        `Links  : ${links.length}`,
      ];

      if (error) parts.push(`Error  : ${error}`);

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `FAIL — ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: qa_flow_test ─────────────────────────────────────────────

server.registerTool(
  "qa_flow_test",
  {
    description:
      "Run a multi-step UI flow test with browser actions and pass/fail assertions. " +
      "Automates real browser interactions: click elements, type into inputs, press keys, wait for content, take screenshots, execute JavaScript. " +
      "Then checks the final page state against your assertions. " +
      "Use this to test login flows (submit wrong creds → expect error), signup forms, navigation, checkout, etc. " +
      "Returns PASS/FAIL with screenshot evidence and page content.",
    inputSchema: z.object({
      url: z.string().url().describe("Starting URL for the test (use a tunnel URL for localhost)"),
      name: z.string().default("UI Flow Test").describe("Human-readable test name (shown in results)"),
      steps: z
        .array(
          z.object({
            action: z
              .enum(["wait", "click", "type", "press", "screenshot", "scroll", "js"])
              .describe(
                "wait: wait for selector or ms. click: click a CSS selector. " +
                "type: type text into the focused element (click an input first). " +
                "press: press a key (Enter, Tab, etc). screenshot: capture current state. " +
                "scroll: scroll the page. js: execute JavaScript and capture return value.",
              ),
            selector: z
              .string()
              .optional()
              .describe("CSS selector — required for 'click' and 'wait' (when waiting for an element)"),
            text: z
              .string()
              .optional()
              .describe("Text to type (for 'type'), key name (for 'press', e.g. 'Enter', 'Tab'), or JavaScript code (for 'js')"),
            milliseconds: z
              .number()
              .optional()
              .describe("Wait duration in ms (for 'wait' without selector). Default 1000."),
          }),
        )
        .describe(
          "Ordered browser actions. Common login pattern: " +
          "click input → type email → click input → type password → click submit button. " +
          "Use 'js' to execute JavaScript for advanced checks (e.g. read localStorage, check element state). " +
          "Actions run in sequence in a real browser.",
        ),
      pass_if: z
        .object({
          page_contains: z
            .array(z.string())
            .optional()
            .describe("PASS if ALL of these strings appear in the final page text (case-insensitive)"),
          page_not_contains: z
            .array(z.string())
            .optional()
            .describe("PASS only if NONE of these strings appear on the final page"),
          url_contains: z
            .string()
            .optional()
            .describe("PASS if the final URL contains this substring (e.g. '/dashboard' for successful login)"),
        })
        .optional()
        .describe("Assertion conditions — ALL must be true for PASS. Omit for a smoke test (PASS if page loads without crash)."),
      wait_after: z
        .number()
        .default(2000)
        .describe("Extra ms to wait after all steps before checking assertions. Default 2000."),
      api_key: z
        .string()
        .optional()
        .describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ url, name, steps, pass_if, wait_after, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter.",
          },
        ],
        isError: true,
      };
    }

    // Convert steps to Firecrawl actions
    const actions: Record<string, unknown>[] = [];
    for (const step of steps) {
      switch (step.action) {
        case "wait":
          if (step.selector) {
            actions.push({ type: "wait", selector: step.selector });
          } else {
            actions.push({ type: "wait", milliseconds: step.milliseconds ?? 1000 });
          }
          break;
        case "click":
          actions.push({ type: "click", selector: step.selector });
          break;
        case "type":
          actions.push({ type: "write", text: step.text ?? "" });
          break;
        case "press":
          actions.push({ type: "press", key: step.text ?? "Enter" });
          break;
        case "screenshot":
          actions.push({ type: "screenshot" });
          break;
        case "scroll":
          actions.push({
            type: "scroll",
            direction: step.text ?? "down",
            amount: step.milliseconds ?? 300,
          });
          break;
        case "js":
          actions.push({ type: "executeJavascript", script: step.text ?? "" });
          break;
      }
    }

    // End with: wait → screenshot → scrape (to capture final state)
    actions.push({ type: "wait", milliseconds: wait_after });
    actions.push({ type: "screenshot" });
    actions.push({ type: "scrape" });

    try {
      const { ok, status, data } = await firecrawlRequest(
        "/scrape",
        { url, formats: ["markdown"], actions },
        key,
        "POST",
        90_000,
      );

      if (!ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `FAIL — ${name}\nFirecrawl error (${status}): ${JSON.stringify(data)}`,
            },
          ],
          isError: true,
        };
      }

      const result = data.data as Record<string, unknown> | undefined;
      const meta = result?.metadata as Record<string, unknown> | undefined;
      const markdown = result?.markdown ? String(result.markdown) : "";
      const actionsResult = result?.actions as { screenshots?: string[]; javascriptReturns?: unknown[] } | undefined;
      const screenshots = actionsResult?.screenshots ?? [];
      const jsReturns = actionsResult?.javascriptReturns ?? [];
      const finalUrl = (meta?.sourceURL || meta?.url || url) as string;
      const pageText = markdown.toLowerCase();

      // Evaluate assertions
      const failures: string[] = [];

      if (pass_if?.page_contains) {
        for (const expected of pass_if.page_contains) {
          if (!pageText.includes(expected.toLowerCase())) {
            failures.push(`Expected text "${expected}" NOT found on page`);
          }
        }
      }

      if (pass_if?.page_not_contains) {
        for (const rejected of pass_if.page_not_contains) {
          if (pageText.includes(rejected.toLowerCase())) {
            failures.push(`Unexpected text "${rejected}" found on page`);
          }
        }
      }

      if (pass_if?.url_contains) {
        if (!finalUrl.includes(pass_if.url_contains)) {
          failures.push(`URL "${finalUrl}" does not contain "${pass_if.url_contains}"`);
        }
      }

      const passed = failures.length === 0;

      const parts: string[] = [
        passed ? `PASS — ${name}` : `FAIL — ${name}`,
        ``,
        `URL     : ${url}`,
        `Final   : ${finalUrl}`,
        `HTTP    : ${meta?.statusCode ?? "?"}`,
        `Steps   : ${steps.length} actions executed`,
        `Asserts : ${pass_if ? Object.values(pass_if).flat().filter(Boolean).length : 0} checked`,
      ];

      if (!passed) {
        parts.push(``);
        parts.push(`Failures:`);
        for (const f of failures) parts.push(`  ✗ ${f}`);
      }

      if (jsReturns.length > 0) {
        parts.push(``);
        parts.push(`JavaScript returns:`);
        for (const [i, ret] of jsReturns.entries()) {
          parts.push(`  [${i + 1}] ${typeof ret === "string" ? ret : JSON.stringify(ret)}`);
        }
      }

      if (screenshots.length > 0) {
        parts.push(``);
        parts.push(`Screenshots:`);
        for (const [i, s] of screenshots.entries()) {
          parts.push(`  [${i + 1}] ${s}`);
        }
      }

      if (markdown) {
        const excerpt =
          markdown.length > 1500
            ? markdown.slice(0, 1500) + "\n...(truncated)"
            : markdown;
        parts.push(``);
        parts.push(`Page content:`);
        parts.push(excerpt);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        isError: !passed,
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `FAIL — ${name}\n${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ── Browser Sandbox Tools ──────────────────────────────────────────

server.registerTool(
  "browser_create",
  {
    description:
      "Create a persistent browser sandbox session via Firecrawl. " +
      "Returns a sessionId for use with browser_execute, plus a liveViewUrl for real-time observation " +
      "and a cdpUrl for connecting Playwright/Puppeteer. Sessions auto-expire after the TTL.",
    inputSchema: z.object({
      ttl: z.number().int().min(60).max(3600).default(300).describe("Session time-to-live in seconds. Default 300 (5 min). Max 3600 (1 hour)."),
      activity_ttl: z.number().int().min(30).max(1800).default(120).describe("Seconds of inactivity before session expires. Default 120."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ ttl, activity_ttl, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest("/browser", {
        ttl,
        activityTtl: activity_ttl,
      }, key);

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Firecrawl error (${status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const sessionId = data.sessionId as string;
      const liveViewUrl = data.liveViewUrl as string;
      const cdpUrl = data.cdpUrl as string;

      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Browser session created but no sessionId returned." }], isError: true };
      }

      const now = new Date();
      const session: BrowserSession = {
        id: sessionId,
        liveViewUrl: liveViewUrl || "",
        cdpUrl: cdpUrl || "",
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttl * 1000),
      };
      browserSessions.set(sessionId, session);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Browser session created.`,
              ``,
              `Session ID  : ${sessionId}`,
              `Live View   : ${liveViewUrl || "(not available)"}`,
              `CDP URL     : ${cdpUrl || "(not available)"}`,
              `TTL         : ${ttl}s`,
              `Activity TTL: ${activity_ttl}s`,
              ``,
              `Use browser_execute to run code in this session.`,
              `Use browser_close to end it early (or it auto-expires).`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Browser create failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "browser_execute",
  {
    description:
      "Execute code in a browser sandbox session. The session has a pre-initialized `page` object (Playwright Page). " +
      "Use this to navigate, interact with elements, take screenshots, extract data, or run any browser automation. " +
      "Supports Node.js (default), Python, and Bash. The `page` object is already connected to the browser.",
    inputSchema: z.object({
      session_id: z.string().describe("The browser session ID from browser_create"),
      code: z.string().describe(
        "Code to execute. Has access to a pre-initialized `page` (Playwright Page) object. " +
        "Example: `await page.goto('https://example.com'); const title = await page.title(); return title;`",
      ),
      language: z.enum(["node", "python", "bash"]).default("node").describe("Execution language. All have access to the `page` object. Default: node."),
      timeout: z.number().int().min(1000).max(300_000).default(30_000).describe("Execution timeout in ms. Default 30000."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ session_id, code, language, timeout, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest(
        `/browser/${session_id}/execute`,
        { code, language, timeout },
        key,
        "POST",
        timeout + 10_000, // HTTP timeout = execution timeout + buffer
      );

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Execution error (${status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const result = data.result !== undefined ? data.result : data.data;
      const stdout = data.stdout as string | undefined;
      const stderr = data.stderr as string | undefined;
      const exitCode = data.exitCode as number | undefined;

      const parts: string[] = [`Execution complete (${language})`];

      if (exitCode !== undefined) {
        parts.push(`Exit code: ${exitCode}`);
      }

      if (result !== undefined) {
        parts.push(``);
        parts.push(`Result:`);
        parts.push(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      }

      if (stdout) {
        parts.push(``);
        parts.push(`Stdout:`);
        parts.push(stdout);
      }

      if (stderr) {
        parts.push(``);
        parts.push(`Stderr:`);
        parts.push(stderr);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Execution failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "browser_list",
  {
    description:
      "List all active browser sandbox sessions. Syncs local tracking with remote Firecrawl state.",
    inputSchema: z.object({
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(`${FIRECRAWL_BASE}/browser?status=active`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = (await res.json()) as Record<string, unknown>;

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Firecrawl error (${res.status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const sessions = (data.data || data.sessions || []) as Array<Record<string, unknown>>;

      // Sync local map: remove sessions that are no longer active
      const remoteIds = new Set(sessions.map((s) => s.sessionId || s.id));
      for (const [id] of browserSessions) {
        if (!remoteIds.has(id)) {
          browserSessions.delete(id);
        }
      }

      if (sessions.length === 0) {
        return { content: [{ type: "text" as const, text: "No active browser sessions." }] };
      }

      const parts: string[] = [`Active browser sessions: ${sessions.length}`, ``];
      for (const s of sessions) {
        const id = (s.sessionId || s.id) as string;
        const liveView = s.liveViewUrl as string | undefined;
        parts.push(`  [${id}]${liveView ? ` Live: ${liveView}` : ""}`);
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Browser list failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "browser_close",
  {
    description:
      "Close a browser sandbox session. Returns duration and credits billed. " +
      "Sessions also auto-expire after their TTL, so closing is optional but frees resources sooner.",
    inputSchema: z.object({
      session_id: z.string().describe("The browser session ID to close"),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ session_id, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      const { ok, status, data } = await firecrawlRequest(
        `/browser/${session_id}`,
        {},
        key,
        "DELETE",
        15_000,
      );

      browserSessions.delete(session_id);

      if (!ok) {
        return {
          content: [{ type: "text" as const, text: `Close error (${status}): ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const duration = data.duration as number | undefined;
      const credits = data.creditsBilled as number | undefined;

      const parts = [`Browser session ${session_id} closed.`];
      if (duration !== undefined) parts.push(`Duration: ${duration}s`);
      if (credits !== undefined) parts.push(`Credits billed: ${credits}`);

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      browserSessions.delete(session_id);
      return {
        content: [{ type: "text" as const, text: `Browser close failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Agent Tool ─────────────────────────────────────────────────────

server.registerTool(
  "qa_agent",
  {
    description:
      "Launch an autonomous AI agent that navigates websites, clicks, fills forms, and extracts data. " +
      "Give it a natural-language prompt describing what to do (e.g. 'Find the pricing page and extract all plan names and prices'). " +
      "Optionally provide starting URLs and a JSON schema for structured output. " +
      "The agent runs autonomously — this tool polls until completion (up to 120s).",
    inputSchema: z.object({
      prompt: z.string().describe("Natural-language instructions for the agent (e.g. 'Go to the pricing page and extract all plan details')"),
      urls: z
        .array(z.string().url())
        .optional()
        .describe("Optional starting URLs for the agent. If omitted, the agent searches on its own."),
      schema: z
        .record(z.unknown())
        .optional()
        .describe("Optional JSON schema for structured data extraction. The agent will return data matching this schema."),
      max_credits: z.number().int().min(1).max(1000).default(50).describe("Max credits the agent can spend. Default 50."),
      api_key: z.string().optional().describe("Firecrawl API key. Falls back to FIRECRAWL_API_KEY env var."),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async ({ prompt, urls, schema, max_credits, api_key }) => {
    const key = getFirecrawlKey(api_key);
    if (!key) {
      return {
        content: [{ type: "text" as const, text: "No Firecrawl API key. Set FIRECRAWL_API_KEY env var or pass api_key parameter." }],
        isError: true,
      };
    }

    try {
      // Start the agent
      const body: Record<string, unknown> = { prompt, maxCredits: max_credits };
      if (urls && urls.length > 0) body.urls = urls;
      if (schema) body.schema = schema;

      const start = await firecrawlRequest("/agent", body, key);

      if (!start.ok) {
        return {
          content: [{ type: "text" as const, text: `Agent error (${start.status}): ${JSON.stringify(start.data)}` }],
          isError: true,
        };
      }

      const jobId = (start.data.id || start.data.jobId) as string;
      if (!jobId) {
        // Some APIs return the result directly (synchronous mode)
        if (start.data.data || start.data.result) {
          const result = start.data.data || start.data.result;
          return {
            content: [
              {
                type: "text" as const,
                text: [
                  `Agent completed (synchronous).`,
                  ``,
                  typeof result === "string" ? result : JSON.stringify(result, null, 2),
                ].join("\n"),
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: "Agent started but no job ID returned." }], isError: true };
      }

      // Poll for completion (max 120s)
      const deadline = Date.now() + 120_000;
      let result: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);

        const res = await fetch(`${FIRECRAWL_BASE}/agent/${jobId}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        clearTimeout(timer);

        const pollData = (await res.json()) as Record<string, unknown>;

        if (pollData.status === "completed" || pollData.status === "failed") {
          result = pollData;
          break;
        }
      }

      if (!result) {
        return {
          content: [{ type: "text" as const, text: `Agent ${jobId} still running after 120s. It will continue in the background.` }],
        };
      }

      if (result.status === "failed") {
        return {
          content: [{ type: "text" as const, text: `Agent failed: ${JSON.stringify(result)}` }],
          isError: true,
        };
      }

      // Format results
      const agentData = result.data || result.result;
      const credits = result.creditsUsed as number | undefined;

      const parts: string[] = [
        `Agent completed.`,
        credits !== undefined ? `Credits used: ${credits}` : "",
        ``,
      ].filter(Boolean);

      if (agentData) {
        parts.push(typeof agentData === "string" ? agentData : JSON.stringify(agentData, null, 2));
      } else {
        parts.push("No data returned.");
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Agent failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Startup ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-porthook v0.2.0 running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// ── Cleanup on exit ────────────────────────────────────────────────

function cleanup() {
  // Revert Vite configs and kill tunnel processes
  for (const [, entry] of tunnels) {
    revertViteConfig(entry);
    entry.process.kill("SIGTERM");
  }
  tunnels.clear();

  // Fire-and-forget close browser sessions (they have TTL so they expire anyway)
  const key = getFirecrawlKey();
  if (key) {
    for (const [sessionId] of browserSessions) {
      fetch(`${FIRECRAWL_BASE}/browser/${sessionId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
      }).catch(() => {});
    }
  }
  browserSessions.clear();

  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
