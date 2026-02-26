# Contributing to Porthook MCP

Thanks for your interest in contributing. This is a small, focused project — PRs welcome.

## Setup

```bash
git clone https://github.com/kwestradotcom/Porthook_MCP.git
cd Porthook_MCP
npm install
```

Copy the example env file and add your Firecrawl key:

```bash
cp .env.example .env
# edit .env and set FIRECRAWL_API_KEY
```

## Development

Run the server directly from TypeScript (no build step):

```bash
npm run dev
```

Type-check without building:

```bash
npm run typecheck
```

Build to `dist/`:

```bash
npm run build
```

## Project structure

```
src/
└── index.ts        # Single-file MCP server (all 19 tools)
skills/
└── porthook/       # Claude Code skill — workflow patterns for agents
dist/               # Compiled output (not committed)
```

All tools live in `src/index.ts`. Each tool is registered via `server.tool(name, schema, handler)` using the MCP SDK.

## Adding a tool

1. Define the Zod schema for the tool's input parameters
2. Register it with `server.tool('tool_name', { description, inputSchema }, handler)`
3. Return `{ content: [{ type: 'text', text: '...' }] }` from the handler
4. Add it to the tools table in `README.md`

## Pull requests

- Keep changes focused — one feature or fix per PR
- Run `npm run typecheck` before submitting
- Update `README.md` if you add or change tool behaviour
- No hardcoded credentials, URLs, or environment-specific paths

## Reporting bugs

Use [GitHub Issues](https://github.com/kwestradotcom/Porthook_MCP/issues) with the bug report template.

## License

By contributing you agree your changes will be licensed under MIT.
