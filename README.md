[![npm version](https://img.shields.io/npm/v/node-huckleberry-mcp)](https://www.npmjs.com/package/node-huckleberry-mcp)
[![npm downloads](https://img.shields.io/npm/dm/node-huckleberry-mcp)](https://www.npmjs.com/package/node-huckleberry-mcp)

# Huckleberry MCP Server

Unofficial [Huckleberry baby tracker](https://huckleberrycare.com/) MCP server for Claude, Cursor, VS Code, and other AI assistants. Query and log baby sleep, feeds, diapers, pumping, solids, potty, and growth records.

Expose Huckleberry's data (sleep, feeding, growth, diapers, solids) directly in [Claude Desktop](https://claude.ai/download), or integrate the MCP server into other AI applications.

## Installation

### Requirements

- **Node.js** 24+ (matches CI; see `.nvmrc`)
- **npm** 9+

### Quick Start

```bash
npm install -g node-huckleberry-mcp
```

Or use directly via `npx`:

```bash
npx node-huckleberry-mcp
```

### From source

```bash
git clone https://github.com/KenLSM/node-huckleberry-mcp.git
cd node-huckleberry-mcp
npm install
npm run build
node dist/index.js
```

## HTTP transport

For clients that cannot spawn a stdio child process (server-side agents,
Durable Object / worker runtimes), run the streamable-HTTP server instead:

```bash
node dist/http.js      # or: npm run start:http
```

- Listens on `0.0.0.0:8085` by default (`HUCKLEBERRY_MCP_PORT`, `HUCKLEBERRY_MCP_HOST`).
- Stateless protocol mode: no server-issued sessions; safe for concurrent clients; no server-initiated SSE (GET/DELETE requests receive `405`).
- `GET /health` returns `200 {"ok":true}` for load-balancer checks.
- If `HUCKLEBERRY_MCP_TOKEN` is set, requests must send `Authorization: Bearer <token>` (otherwise `401`). Unset = open endpoint with a startup warning.

Client configuration (streamable-HTTP transport):

```json
{
  "mcpServers": {
    "huckleberry": {
      "transport": "http",
      "url": "http://homelab-host:8085/mcp",
      "headers": { "Authorization": "Bearer <HUCKLEBERRY_MCP_TOKEN>" }
    }
  }
}
```

## Configuration

### Environment Variables

The server reads credentials from environment variables:

```bash
HUCKLEBERRY_EMAIL=you@example.com
HUCKLEBERRY_PASSWORD=your-password
HUCKLEBERRY_TIMEZONE=America/New_York
```

Create a `.env` file in your project root (see `.env.example` for a template):

```bash
cp .env.example .env
# Edit .env with your Huckleberry credentials
```

**Note:** Never commit `.env` to version control. The `.gitignore` already excludes it.

### Claude Desktop Integration

To use this server with Claude Desktop, add it to your `claude_desktop_config.json`:

**macOS/Linux:** `~/.config/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "huckleberry": {
      "command": "npx",
      "args": ["node-huckleberry-mcp"],
      "env": {
        "HUCKLEBERRY_EMAIL": "you@example.com",
        "HUCKLEBERRY_PASSWORD": "your-password",
        "HUCKLEBERRY_TIMEZONE": "America/New_York"
      }
    }
  }
}
```

After updating the config, restart Claude Desktop. The Huckleberry tools will appear in the tool list.

## Tools

The server exposes **29 tools** across 6 categories. (Active-session sleep/feed
timers — `start_sleep`, `pause_feeding`, etc. — are not implemented; use the
explicit `log_*` tools to record completed events.)

### Child Management (2)

| Tool        | Input       | Output                                              |
| ----------- | ----------- | --------------------------------------------------- |
| `get_user`  | —           | User profile + child UID list                       |
| `get_child` | `child_uid` | Child profile (`childsName`, `gender`, `birthdate`) |

### Sleep (4)

| Tool                | Input                                                           | Purpose                            |
| ------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `log_sleep`         | `child_uid`, `start`, `end` (epoch s), `notes?`                 | Log a completed sleep session      |
| `get_sleep_history` | `child_uid`, `limit?`                                           | Recent sleep sessions (incl. `id`) |
| `edit_sleep`        | `child_uid`, `interval_id`, + any of `start`/`duration`/`notes` | Edit an existing sleep entry       |
| `delete_sleep`      | `child_uid`, `interval_id`                                      | Permanently delete a sleep entry   |

### Feeding (10)

| Tool                  | Input                                                                                                                            | Purpose                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `log_nursing`         | `child_uid`, `start`, `left_duration?`, `right_duration?`, `last_side?`, `notes?`                                                | Log a nursing session                   |
| `log_bottle`          | `child_uid`, `start`, `amount`, `bottle_type`, `units`, `notes?`                                                                 | Log a bottle feeding                    |
| `log_solids`          | `child_uid`, `start`, `notes?`                                                                                                   | Log a solids feeding                    |
| `log_pump`            | `child_uid`, `start`, `left_amount`/`right_amount` or `total_amount`, `units`, `duration?`, `notes?`                             | Log a pumping session                   |
| `list_pump_intervals` | `child_uid`, `limit?`                                                                                                            | Recent pump sessions (incl. `id`)       |
| `get_feed_history`    | `child_uid`, `limit?`                                                                                                            | Recent feeds (incl. `id`), newest first |
| `edit_feed`           | `child_uid`, `interval_id`, + any of `start`/`amount`/`bottle_type`/`units`/`left_duration`/`right_duration`/`last_side`/`notes` | Edit an existing feed entry             |
| `edit_pump`           | `child_uid`, `interval_id`, + any of `start`/`left_amount`/`right_amount`/`units`/`duration`/`notes`                             | Edit an existing pump entry             |
| `delete_feed`         | `child_uid`, `interval_id`                                                                                                       | Permanently delete a feed entry         |
| `delete_pump`         | `child_uid`, `interval_id`                                                                                                       | Permanently delete a pump entry         |

### Diaper (5)

`color` and `consistency` are restricted to a fixed set of values
(yellow/brown/green/black/red/white/orange/other;
hard/normal/soft/runny/watery/formed/mucousy) to prevent an unrecognized value
from crashing the Huckleberry app on that entry. See `TASKS.md` → BUG2 for how
the set was chosen — adopted from the legacy port, not yet live-confirmed.

| Tool                 | Input                                                                                                             | Purpose                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `log_diaper`         | `child_uid`, `mode` (pee/poo/both/dry), `start`, `color?`, `consistency?`, `pee_amount?`, `poo_amount?`, `notes?` | Log a diaper change                     |
| `log_potty`          | `child_uid`, `mode` (pee/poo), `start`, `notes?`                                                                  | Log potty training activity             |
| `get_diaper_history` | `child_uid`, `limit?`                                                                                             | Diaper + potty history (incl. `id`)     |
| `edit_diaper`        | `child_uid`, `interval_id`, + any of `start`/`mode`/`color`/`consistency`/`pee_amount`/`poo_amount`/`notes`       | Edit an existing diaper/potty entry     |
| `delete_diaper`      | `child_uid`, `interval_id`                                                                                        | Permanently delete a diaper/potty entry |

### Growth (5)

| Tool                 | Input                                                                                      | Purpose                                     |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `log_growth`         | `child_uid`, `weight?`, `height?`, `head?`, `units?` (metric/imperial), `start?`, `notes?` | Log a growth measurement                    |
| `get_latest_growth`  | `child_uid`                                                                                | Most recent growth measurement (incl. `id`) |
| `get_growth_history` | `child_uid`, `limit?`                                                                      | Growth history (incl. `id`)                 |
| `edit_growth`        | `child_uid`, `entry_id`, + any of `start`/`weight`/`height`/`head`/`units`/`notes`         | Edit an existing growth measurement         |
| `delete_growth`      | `child_uid`, `entry_id`                                                                    | Permanently delete a growth measurement     |

### Solids — custom foods (3)

| Tool                 | Input                                                    | Purpose                         |
| -------------------- | -------------------------------------------------------- | ------------------------------- |
| `list_curated_foods` | —                                                        | Fetch the curated food database |
| `list_custom_foods`  | `child_uid`                                              | List custom foods for a child   |
| `create_custom_food` | `child_uid`, `name`, `category?`, `allergens?`, `notes?` | Create a custom food entry      |

> All `start`/`end` inputs are **epoch seconds**. Times are stored with a
> timezone `offset` derived from `HUCKLEBERRY_TIMEZONE`.
>
> Every `log_*` tool accepts an optional free-text `notes` field, which is stored
> on the entry and returned by the matching history/`get_*` tool (each read entry
> includes its Firestore `id`). The `edit_*` tools (`edit_sleep`, `edit_feed`,
> `edit_pump`, `edit_diaper`, `edit_growth`) update `notes` and other fields on an
> existing entry, and the `delete_*` tools remove one — both take the
> `id`/`interval_id`/`entry_id` from the matching read. Deleting does not recompute
> the tracker's `prefs.last*` summary, so a "most recent" view may briefly show a
> deleted entry until the next write.

### Prompts

The server also exposes MCP **prompts** (slash-command-style templates in clients
that support them): `huckleberry_usage` (loads the usage conventions),
`daily_summary` (`date?`), and `log_event` (`event`).

### Agent skill

`skills/huckleberry/SKILL.md` teaches an assistant how to use these tools
correctly (child resolution, natural-language time → epoch seconds, units,
confirm-before-write). Copy it into your Claude skills directory to make the MCP
smoother to use.

## Development

### Scripts

```bash
npm run build            # TypeScript → JavaScript (tsc)
npm run lint             # Lint with oxlint
npm run lint:fix         # Lint and auto-fix
npm run format           # Format with oxfmt
npm run format:check     # Check formatting without changes
npm test                 # Run unit tests (Vitest)
npm run test:watch       # Watch mode for tests
npm run test:integration # Live tests (needs HUCKLEBERRY_* creds; skipped otherwise). Read-only by default; set HUCKLEBERRY_ALLOW_WRITES=1 to also run the log_*→delete write round-trip (test account only)
npm run inspect:schema   # Dump real Firestore shapes (needs creds) — see docs/integration-testing.md
npm run smoke            # Build + run the MCP server smoke test
npm run dev              # Run in dev mode (tsx)
```

### Toolchain

- **TypeScript** 5.3+ with strict mode
- **oxc** (oxlint + oxfmt) — fast, Rust-based linting & formatting
- **Vitest** — unit test runner
- **Zod** — runtime data validation
- **Firebase JS SDK** — Firestore + Auth

### Architecture

```
src/
├── auth/            # Authentication (T1.1)
├── client/          # Huckleberry API operations (T1.2–T1.9)
├── models/          # Zod schemas for Firestore docs (T1.3)
├── server/          # MCP server framework (T2.1–T2.2)
├── tools/           # MCP tool implementations (T2.3–T2.8)
├── __tests__/       # Unit & smoke tests
└── index.ts         # Entry point
```

See [AGENTS.md](./AGENTS.md) for architecture details and conventions.

### Testing

Unit tests are in `src/__tests__/` and use Vitest with Firebase mocked:

```bash
npm test
```

Run a single test file:

```bash
npm test -- models.test.ts
```

Watch mode:

```bash
npm run test:watch
```

**Live integration** (gated) validates against a real account and is skipped
without credentials. It is read-only by default; an opt-in `log_*`→delete write
round-trip runs only with `HUCKLEBERRY_ALLOW_WRITES=1` (use a test account) —
see [docs/integration-testing.md](./docs/integration-testing.md):

```bash
# read-only schema validation
HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… npm run test:integration

# also exercise log_*→delete writes (test account only)
HUCKLEBERRY_EMAIL=… HUCKLEBERRY_PASSWORD=… HUCKLEBERRY_ALLOW_WRITES=1 npm run test:integration
```

## Licensing & Attribution

This project is a Node.js port of two MIT-licensed projects:

- **`py-huckleberry-api`** © 2025 Woyken ([GitHub](https://github.com/Woyken/py-huckleberry-api), [MIT License](https://github.com/Woyken/py-huckleberry-api/blob/main/LICENSE))
- **`py-huckleberry-mcp`** © 2026 Huckleberry MCP Contributors ([GitHub](https://github.com/bckenstler/py-huckleberry-mcp), [MIT License](https://github.com/bckenstler/py-huckleberry-mcp/blob/main/LICENSE))

This port includes substantial design and implementation from both upstream projects.

## Safety & Privacy

- **No data is stored locally.** All operations are authenticated reads/writes to your Huckleberry Firestore database.
- **Credentials are environment-based.** Never commit `.env` or hardcode credentials.
- This is an **unofficial** client of a third-party service; the API is reverse-engineered and may change.

## Support

- **Documentation:** See [AGENTS.md](./AGENTS.md) for contributor guidance.
- **Issues:** Report bugs or request features on [GitHub Issues](https://github.com/KenLSM/node-huckleberry-mcp/issues).
- **Upstream:** For questions about Huckleberry data or API changes, see the original Python projects.

---

Built with ❤️ as a Node/TypeScript port of [`py-huckleberry-api`](https://github.com/Woyken/py-huckleberry-api) and [`py-huckleberry-mcp`](https://github.com/bckenstler/py-huckleberry-mcp).
