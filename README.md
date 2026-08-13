# Querky

![Querky Cover](querky-cover.png)

A quirky terminal SQL client with vim keybindings, schema-aware autocomplete, query aliases, and AI-powered query explanation.

## Features

- **Beautiful tables** — clean, aligned output with automatic expanded mode for wide results
- **Vim mode** — full normal/insert mode with motions, operators, yank/paste
- **Query history** — persisted across sessions, navigate with ↑↓
- **AI explanation** — explain any SQL query in plain English via Groq or Ollama
- **Slash commands** — with Tab autocomplete and ↑↓ suggestion navigation
- **Responsive layout** — auto-switches to vertical key=value mode when the table is wider than the terminal
- **Connection wizard** — interactive form on startup if no connection string is provided
- **Multiple drivers** — PostgreSQL, MySQL, and SQLite
- **Credential storage** — passwords saved to OS keychain automatically
- **Schema-aware autocomplete** — Tab-completes table names, column names, and SQL keywords based on context
- **Query aliases** — save queries under short names, scoped per database, with positional and named parameters
- **Pagination** — navigate large result sets with `/next` and `/prev`
- **Export** — save results to CSV or JSON

---

## Requirements

- Node.js 18+

---

## Install

```bash
npm install -g @deaquinodev/querky
```

After that, `querky` is available globally.

### Install from source

```bash
git clone https://github.com/arthurdaquinosilva/querky.git
cd querky
pnpm install
pnpm build
pnpm install -g .
```

---

## Connecting

### With a connection string

```bash
# PostgreSQL
querky --connection postgresql://user:pass@localhost/mydb
querky -c postgresql://user:pass@localhost/mydb

# MySQL
querky -c mysql://user:pass@localhost/mydb

# SQLite
querky -c sqlite:///path/to/database.db
```

### With the interactive wizard

Run `querky` with no arguments and fill in the form:

```bash
querky
```

Use **Tab** or **↑↓** to move between fields, **←→** to cycle the driver, **Enter** to connect. Passwords are saved to the OS keychain after a successful connection and pre-filled on the next run.

---

## AI Setup

Querky can explain your queries using any OpenAI-compatible API.

### Groq (recommended — fast and free)

1. Get a free API key at [console.groq.com](https://console.groq.com)
2. Set the key in your shell:

```bash
# Add to ~/.zshrc or ~/.bashrc
export QUERKY_API_KEY=gsk_...
```

3. Connect with Groq:

```bash
querky -c postgresql://... \
  --ai-url https://api.groq.com/openai/v1 \
  --ai-model llama-3.1-8b-instant
```

### Ollama (local, offline)

```bash
ollama pull llama3.2
ollama serve
```

```bash
querky -c postgresql://... --ai-model llama3.2
```

Ollama is the default endpoint (`http://localhost:11434/v1`).

---

## Slash Commands

| Command | Description |
|---|---|
| `/explain <SQL>` | Explain a SQL query in plain English |
| `/explain-previous` | Explain the last query you ran |
| `/databases` | List available databases |
| `/tables` | List tables in the current database |
| `/describe <table>` | Show columns, types, and key constraints for a table |
| `/export csv` | Export last result to a CSV file |
| `/export json` | Export last result to a JSON file |
| `/next` | Next page of results |
| `/prev` | Previous page of results |
| `/clear` | Clear the screen and scrollback |
| `/toggle-vim-mode` | Toggle vim keybindings on/off |
| `/save <name>` | Save the last query as an alias |
| `/alias <name> <SQL>` | Define an alias inline |
| `/aliases` | List all aliases for the current database |
| `/unalias <name>` | Remove a saved alias |

Type `/` and use **Tab** or **↑↓** to navigate and complete commands.

---

## Schema-aware Autocomplete

Querky fetches your schema on connect and completes as you type. Press **Tab** to cycle through suggestions, **Enter** to accept.

| Context | Completes |
|---|---|
| After `FROM`, `JOIN`, `INTO` | Table names |
| After `SELECT`, `WHERE`, `ON` | Column names + tables |
| After `table.` | Columns for that specific table |
| Anywhere else | SQL keywords + tables + columns |

Works with PostgreSQL, MySQL, and SQLite. Suggestions appear after 1 character.

---

## Query Aliases

Save any query under a short name, scoped to the current database.

```bash
# Save the last executed query
/save get_all_users

# Or define one inline
/alias get_user SELECT * FROM users WHERE id = $1
/alias add_user INSERT INTO users(name, email) VALUES (:name, :email)
```

Then invoke them like any other command:

```bash
/get_all_users
/get_user 42
/add_user name="Alice" email="alice@example.com"
```

**Positional params** use `$1, $2, …` — pass values in order.
**Named params** use `:param` — pass `key=value` pairs (quote values with spaces).

Aliases are stored in `~/.config/querky/aliases.json` and are Tab-completable.

---

## psql Aliases

Users coming from `psql` can use familiar meta-commands:

| Command | Equivalent |
|---|---|
| `\l` | List databases |
| `\d` or `\dt` | List tables |
| `\d <table>` | Show columns for a table |
| `\du` | List users |
| `\c` | Show current database |
| `\c <dbname>` | Switch to a different database |

---

## Vim Mode

Querky starts in INSERT mode. Press `Escape` to enter NORMAL mode.

| Keys | Action |
|---|---|
| `i` / `a` / `A` | Enter INSERT mode |
| `h` / `l` | Move left/right |
| `w` / `b` / `e` | Word forward/backward/end |
| `0` / `$` | Start/end of line |
| `dd` / `cc` / `S` | Clear line |
| `dw` / `cw` | Delete/change word |
| `x` / `s` | Delete/substitute character |
| `D` / `C` | Delete/change to end of line |
| `yy` / `p` | Yank line / paste |
| `e` | Open current input in `$EDITOR` |

In INSERT mode, **↑↓** navigates query history. **Ctrl+E** opens `$EDITOR` from INSERT mode.

Disable vim mode with `/toggle-vim-mode` or pass `--no-vim` for plain input.

---

## Shell Mode

Prefix any command with `!` to run it in your shell without leaving querky:

```
! ls -la
! pg_dump mydb > backup.sql
! cat results.csv | wc -l
```

Output appears inline. ANSI colors and pipes are preserved.

---

## All Flags

| Flag | Default | Description |
|---|---|---|
| `--connection`, `-c` | — | Connection string (optional — wizard shown if omitted) |
| `--ai-url` | `http://localhost:11434/v1` | OpenAI-compatible API base URL |
| `--ai-model` | `llama3.2` | Model name |
| `--api-key` | `$QUERKY_API_KEY` | API key for remote endpoints |

---

## Development

```bash
pnpm dev --connection postgresql://user:pass@localhost/mydb
pnpm test
pnpm lint
pnpm build
```
