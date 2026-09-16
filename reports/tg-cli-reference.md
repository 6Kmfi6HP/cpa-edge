
### 4.3 The chat_id sign convention — exact explanation of `-1001695180959` vs `1695180959`

Both numbers are correct and refer to the same chat. They come from **two different code paths**.

**Path A — `chats` prints the *marked* peer id.**
`list_chats` stores `"id": dialog.id` (`client.py:104`). Telethon's `Dialog.id` is
`utils.get_peer_id(self.entity)`, which **marks by default**
(`telethon/tl/custom/dialog.py:92` — comment "The marked ID of the entity").
`get_peer_id` (`telethon/utils.py:1018-1063`) returns:

| Entity | Returned |
|---|---|
| `PeerUser` | `user_id` (positive) |
| `PeerChat` (legacy small group) | `-chat_id` |
| `PeerChannel` (channel / supergroup) | `-(1000000000000 + channel_id)` → **the `-100` prefix** |

So `-1001695180959` = channel with real id `1695180959`. (`resolve_id`, `telethon/utils.py:1066`, reverses it: `>10^12` ⇒ channel.)

**Path B — the `messages` table stores the *bare* entity id.**
`fetch_history` writes `chat_id = entity.id` (`client.py:179`, row built at `client.py:210-220`).
`entity.id` is the raw TL field on `Channel`/`Chat`/`User` — **never marked**. Same in `listen`:
`chat_id=chat.id` (`client.py:352`). Hence `1695180959`.

**Path C — `sender_id` keeps the *marked* form.**
`fetch_history` writes `sender_id=msg.sender_id` (`client.py:215`), and Telethon's
`Message.sender_id` is documented and implemented as "the **marked** sender integer ID"
(`telethon/tl/custom/message.py`, `sender_id` property). For a channel post the sender is the
channel itself, so the row legitimately contains `sender_id = -1001695180959` **while
`chat_id = 1695180959` in the same row** — exactly what this machine's DB shows. Verified: all 3
live rows have `chat_id=1695180959`, `sender_id=-1001695180959`.

**Path D — name lookup normalises, but query filters do not.**
`_canonical_chat_id` (`db.py:40-51`) strips a leading `100` from the absolute value of negative ids:

```
if chat_id < 0: digits = str(abs(chat_id))
    if digits.startswith("100") and len(digits) > 3: return int(digits[3:])
    return abs(chat_id)
return chat_id
```

It is called from **exactly one place** — `find_chats` (`db.py:79-81`). Consequences, all verified against the real DB:

| Input to `-c`/`CHAT` | Resolved? |
|---|---|
| `-1001695180959` | ✅ → row `chat_id=1695180959` |
| `1695180959` | ✅ → same row |
| `1001695180959` (positive with 100 prefix) | ❌ `chat_not_found` — positive ids are **never** stripped (`db.py:51`) |
| `-100123` | ✅ → `123` (the `len>3` guard, `db.py:48`) |
| `-1000` | ✅ → **`0`** — silent wrong-id trap for 4-digit negatives |
| `-123456789` (legacy group, `-` mark only) | ✅ → `123456789` — same value a **user** with that id would produce; collision possible |

**The trap that bites agents:** normalisation is **query-side only**. SQL filters compare the raw
column (`AND chat_id = ?`, e.g. `db.py:213,240,279,320,380`). `MessageDB.get_last_msg_id(-1001695180959)`
returns `None` while `get_last_msg_id(1695180959)` returns `896807` — verified. Any code that takes
the id from `tg chats --json` (`-100…`) and compares it against `stats`/`top`/message rows
(`1695…`) finds **zero** overlap. Rule: strip `-100` yourself before joining, and never mix the two id spaces.

### 4.4 Timestamps, content, markdown, `raw_json`

| Aspect | Behaviour | Evidence |
|---|---|---|
| Storage type | TEXT — SQLite does **no** datetime affinity here | `db.py:27` |
| Written value | `datetime.isoformat()`; `datetime` passed through unchanged if already a str | `db.py:142` (`insert_message`), `db.py:168-172` (`insert_batch`) |
| Normalisation | naive → forced to **UTC** | `client.py:206-208` (history), `client.py:347-349` (listen) |
| Observed format | `2026-09-16T08:20:41+00:00` (fixed width to the second here, explicit `+00:00` offset) | real DB rows |
| Missing/None date | replaced by **insertion time**, `datetime.now(timezone.utc)` | `client.py:218`, `client.py:358` |
| Range filters | computed as `(now(utc) − timedelta(hours=N)).isoformat()` and compared as **strings** | `db.py:219,246,272,383,417` |
| "Today" | local midnight → converted to UTC → string compare | `db.py:303-317` |
| Grouping | `substr(timestamp,1,10)` = `YYYY-MM-DD`; `substr(...,1,13)` = `YYYY-MM-DDTHH` | `db.py:406-409,423` |

Because filtering is **lexicographic on ISO text**, ordering is only correct while every stored
value shares one fixed-width format and a `+00:00` offset. A future writer that emits
`...Z`, a space separator, or fractional seconds would silently break `--hours`/`today`/`timeline`
windows. This is a latent, not currently observed, defect — the current data is uniform.

`timeline --by hour` buckets on the **UTC** hour digits (`db.py:407`); `--by day` buckets on the
**UTC** date (`db.py:409`), while `today` cuts at **local** midnight (`db.py:303-315`). The two
commands therefore disagree about where a day boundary is whenever local ≠ UTC. Verified structurally.

| Content aspect | Behaviour | Evidence |
|---|---|---|
| What is stored | `content = msg.text or msg.message or ""` | `client.py:205` |
| `msg.text` | Telethon's **reverse-markdown**: `parse_mode.unparse(self.message, self.entities)`; client default parse mode is `telethon.extensions.markdown` | `telethon/tl/custom/message.py:395` (`text` property), `telethon/client/telegrambaseclient.py:16,417` |
| Net effect | formatting entities are **flattened into Telegram markdown**, not preserved as raw text and not stripped | verified: live rows contain `[**好烦扫码登录**](https://www.nodeseek.com/post-931817-1)` |
| Delimiters produced | `**bold**`, `__italic__`, `~~strike~~`, `` `code` ``, ```` ```pre ``` ````, `[text](url)` for links | `telethon/extensions/markdown.py:17-26` |
| Consequence | `content` is **markdown**, and it is the same string that later gets fed to Rich markup in human mode → §10.3 crash | `query.py:106-108,175,396`, `data.py:62` |
| Messages skipped | only when **both** `msg.text is None` and `msg.message is None` | `client.py:189-190` |
| ⇒ What is lost | pure media / sticker / poll / service messages (no text) are **never stored**, silently | `client.py:189` |
| ⇒ What is kept | a caption-less photo yields `content = ""` and **is** stored (`msg.message` empty string is not `None`) | `client.py:189` + `db.py:26` |
| `raw_json` | column exists and is JSON-encoded when supplied, but **no caller ever passes it**; no SQL ever reads it | written `db.py:143,173`; callers `client.py:210-220`, `client.py:351-359` omit it → always NULL (verified: all rows NULL) |
| Dedup | `INSERT OR IGNORE` on `UNIQUE(platform,chat_id,msg_id)` → duplicates silently dropped; `insert_batch` returns **rows actually inserted** via `total_changes` delta | `db.py:121,180,178,196` |

`insert_batch` swallows `sqlite3.Error` at `WARNING` log level and returns `0` (`db.py:197-199`);
`insert_message` swallows it at `DEBUG` and returns `False` (`db.py:148-150`). A totally failed
batch therefore looks identical to "nothing new" — see §10.6.

### 4.5 Row → JSON field mapping, and the `export` exception

Every query command returns `SELECT *` rows, so JSON objects have exactly the ten column names:
`id, platform, chat_id, chat_name, msg_id, sender_id, sender_name, content, timestamp, raw_json`
(`db.py:18-30`; verified live for `recent`, `today`, `filter`, `search`). `top`/`timeline`/`stats`
return **aggregate** shapes instead (`db.py:389-393`, `db.py:423`, `db.py:330-334`).

`tg export -f json|yaml` is the **one** place that bypasses the envelope: `data.py:47` serialises the
raw message **list**, so stdout is `[{...}, ...]` with **no `ok`, no `schema_version`, no wrapper**.
Verified: `tg export 1695180959 -f json` prints a bare array (rc 0). Its `no_messages` error, by
contrast, *is* enveloped (`data.py:40-41`). An agent must special-case `export` when parsing.

---

## 5. Environment variables, defaults, resolution order

### 5.1 Loading order

1. `tg_cli.config` is imported → `_load_env()` runs **at import time** (`config.py:47`).
2. `_load_env` iterates exactly two candidates and **returns after the first existing file** (`config.py:15-20`):
   1. `Path.cwd() / ".env"` — the current working directory,
   2. `_PROJECT_ROOT / ".env"` where `_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent` (`config.py:12`).
3. `load_dotenv(candidate)` is called **without `override`**, so pre-existing process env always wins
   (`dotenv/main.py:105-108`: `if k in os.environ and not self.override: continue`).
4. **Only one** file is ever read — if `./.env` exists, the fallback is never consulted.
5. `~/.env` is **not** in the candidate list. Verified on this machine: `~/.env` exists but is not loaded, because `TG_API_ID` is unset at runtime and `tg whoami` printed the api_id=2040 warning (§5.3).

For a `uv`-tool install, candidate 2 resolves to `~/.local/share/uv/tools/kabi-tg-cli/lib/python3.12/.env`
— verified **absent**. Candidate 2 is a leftover of a source-checkout layout and is dead weight in a wheel install.

`dotenv` honours `PYTHON_DOTENV_DISABLED` (`dotenv/main.py:26-28`), which is therefore an **effective
kill switch for `.env` loading** even though `tg_cli` never mentions it.

### 5.2 Every variable actually read

| Variable | Read at | Default if unset / empty | Notes |
|---|---|---|---|
| `TG_API_ID` | `config.py:57` (`get_api_id`), `config.py:72` (`is_default_api_id`) | falls back to **2040** | empty string counts as unset |
| `TG_API_HASH` | `config.py:64` | Telegram Desktop's public hash constant | value intentionally not reproduced here (`config.py:53`) |
| `TG_SESSION_NAME` | `config.py:76` | `"tg_cli"` | used as a **path prefix**, not a bare name (`config.py:83`) |
| `DATA_DIR` | `config.py:88` | platform data home + `/tg-cli` | relative → resolved vs **cwd** (`config.py:39-44`) |
| `DB_PATH` | `config.py:98` | `<data_dir>/messages.db` | highest precedence for the DB; relative → cwd |
| `XDG_DATA_HOME` | `config.py:25` | — | checked **first**, on **all** platforms incl. macOS |
| `LOCALAPPDATA` | `config.py:32` | `~/AppData/Local` | Windows only (`os.name == "nt"`) |
| `OUTPUT` | `cli/_output.py:14,26` | `"auto"` | `yaml`/`json`/`rich`, case-insensitive after `.strip().lower()` |
| `PYTHON_DOTENV_DISABLED` | `dotenv/main.py:26` (library, not tg_cli) | — | disables `.env` loading |

Ordering facts: `_default_data_home` checks `XDG_DATA_HOME` **before** the darwin/nt branches
(`config.py:25-36`), so setting `XDG_DATA_HOME` on macOS **redirects both the DB and the session
file**. `DATA_DIR` beats `XDG_DATA_HOME` (`config.py:88-92`); `DB_PATH` beats `DATA_DIR`
(`config.py:98-100`) but does **not** move the session file, which only follows `DATA_DIR`/`XDG_DATA_HOME`
(`config.py:79-83`). Verified by running all local commands with `DB_PATH=/tmp/…`.

### 5.3 api_id=2040 fallback and the exact warning condition

```
_DEFAULT_API_ID = 2040          # config.py:52
_DEFAULT_API_HASH = <telegram desktop public hash>   # config.py:53
```

`connect()` (`client.py:51-64`):

| Condition | Behaviour |
|---|---|
| `TG_API_ID` unset **or empty string** → `is_default_api_id()` True (`config.py:70-72`) | use **2040 + the hard-coded Desktop hash** (`config.py:60,67`) |
| …and module flag `_default_api_warned` is False (`client.py:48,58-59`) | print the yellow warning **once per process**, to **stderr** (`client.py:60-64`) |
| `TG_API_ID` set to anything non-empty | **no warning**, and `TG_API_HASH` is then required or the hard-coded Desktop hash is used **silently** — there is no check pairing the two |
| `TG_API_HASH` set but `TG_API_ID` unset | still warns and still uses 2040 for the id, but your hash — an MTProto `auth_id` mismatch would then surface as a raw connect error, not a clear message |

Verified live: with `TG_API_ID`/`TG_API_HASH` unset, `tg whoami --json` and `tg status --json`
returned rc 0 with the warning on stderr and nothing extra on stdout — i.e. the warning **cannot
corrupt** machine output. Warning text (verbatim, `client.py:61-63`):
`⚠ Using default Telegram Desktop API credentials (api_id=2040).` / `This increases the risk of account restrictions.` / `Get your own at https://my.telegram.org and set TG_API_ID / TG_API_HASH.`

The shared 2040 credential also means the session file is bound to the Telegram **Desktop** app id;
`connect()` additionally spoofs a Desktop fingerprint: `device_model="Desktop"`,
`system_version="macOS 15.3"`, `app_version="5.12.1"` (`client.py:28-32,66-75`).

### 5.4 Session file

`get_session_path()` returns `str(data_dir / session_name)` (`config.py:79-83`) — **no `.session`
suffix is appended by tg_cli**; Telethon's `SQLiteSession` opens that path directly. On this
machine the file is `~/Library/Application Support/tg-cli/tg_cli.session` (verified; contents never printed).

---

## 6. Destructive commands and their guards

| Command | Destroys | Guard | Verified |
|---|---|---|---|
| `delete` | messages **on Telegram**, for everyone (`client.delete_messages`, `tg.py:464`) | **NONE.** No `--yes`, no prompt, no dry-run. Executes on first run. | source + `--help` shows no guard |
| `send` | posts to a live chat (`tg.py:413`) | **NONE.** | source + `--help` |
| `edit` | overwrites a live message (`tg.py:441`) | **NONE.** | source + `--help` |
| `purge` | **local** rows only (`db.delete_chat`, `data.py:80`) — no Telegram call | `-y/--yes` skips; otherwise `click.confirm(f"Delete {count} messages from chat {chat_id}?")` (`data.py:75-78`) | verified |
| `history` / `sync` / `sync-all` / `refresh` / `listen` / `--sync-first` | DB **growth** + real API traffic + rate-limit budget | **NONE.** | source |
| `export -o PATH` | overwrites `PATH` — `open(..., "w")` with no existence check (`data.py:58`) | **NONE.** Writes only on the non-empty path (`data.py:33-44`) | verified with `-o` |

`purge` confirmation semantics, all verified against a throwaway DB copy:
- answering `n` → prints the prompt, **rc 0**, and deletes nothing (`data.py:77-78` `return`).
- **EOF on stdin (e.g. `</dev/null`, or any non-interactive pipe with no input) → `click.Abort` → `Aborted!` on stderr → rc 1.** Nothing is deleted. This is the *safe* direction, but it means `purge` in a script **without** `-y` fails rather than hangs.
- a hanging stdin (an open pipe nobody writes to) **does** block, because `click.confirm` reads a line (`click/termui.py:330`).
- with `-y`, `data.py:80` deletes with no count shown first: only `✓ Deleted N messages` after the fact.
- the prompt prints the **numeric** `chat_id`, never the name (`data.py:77`), while you passed a name — confirm you are deleting what you think.

**No guard anywhere distinguishes "local row" from "real Telegram object".** `purge` looks like
`delete` and vice versa; one removes only local cache, the other is irreversible server-side.

---

## 7. Rate limits, FloodWaitError, retries — actual behaviour

Three distinct layers, and **tg_cli's own handling is the weakest link**.

### 7.1 Layer 1 — inside Telethon, per RPC (`telethon/client/users.py:32-140`, `TelegramClient` defaults)
- `flood_sleep_threshold` default **60 s** (`telethon/client/telegrambaseclient.py:260,314,488-494`).
- On `FloodWaitError`/`SlowModeWaitError`/… (`users.py:105-125`): if `e.seconds <= 60`, Telethon **sleeps and retries transparently**; otherwise it **re-raises**.
- Pre-emptive: a request whose `CONSTRUCTOR_ID` is already in a known flood window is deferred, or raised if the remaining wait > threshold (`users.py:46-57`). Waits ≤3 s are ignored.
- `ServerError`/`RpcCallFailError`/`TimedOutError` etc.: log a warning, `sleep(2)`, retry — up to `request_retries=5`, i.e. 6 attempts, then `raise last_error` (`users.py:95-104,138`).

### 7.2 Layer 2 — `fetch_history` (`client.py:237-240`): **swallow and report zero**
```
except FloodWaitError as e:
    console.print("⚠ Telegram rate limit hit, waiting {e.seconds}s...")
    await asyncio.sleep(e.seconds + random.uniform(1,3))
    return 0
```
It waits, then **returns 0 without retrying the fetch**. Any messages already flushed in earlier
200-row batches stay committed (`client.py:222-223`), so the sync is **partially applied**. The
command then exits **rc 0** reporting `stored: 0` / `synced: 0` / `new_messages: 0`. **A flood wait
is indistinguishable from "no new messages" by exit code or by payload** — only a stderr line
reveals it. Same shape in `sync_all` per chat: `results[chat_name] = 0` (`client.py:302-307`).

### 7.3 Layer 3 — `sync_all` per-chat catch-all (`client.py:308-310`)
Any other exception per chat prints `✗ {chat_name}: {e}` and records `results[chat_name] = 0`,
continuing to the next chat. Since `sync-all`'s payload is `{"new_messages": sum(results.values()), ...}`
(`tg.py:179-180`), **N hard failures reduce the reported total but never change rc or `ok`**.
Errors are only visible as stderr lines or as zero-valued entries inside `data.results`.

### 7.4 Anti-ban pacing that actually runs

| Mechanism | Default | Effective? | Evidence |
|---|---|---|---|
| `--delay` between chats | 1.0 s, ±20 % jitter, skipped for the last chat, `0` disables | ✅ used by `sync-all`/`refresh` | `client.py:251,258,312-315`; `tg.py:146-150,174-176` |
| `batch_delay` between DB-write batches | parameter default **0**, ±30 % jitter | ❌ **dead** — no caller ever passes it | `client.py:156,167,228-230`; grep shows only the definition/call inside `fetch_history` |
| Telethon's own `flood_sleep_threshold` | 60 s | ✅ active (not configured by tg_cli) | `telegrambaseclient.py:260` |
| `random.uniform(1,3)` extra sleep after a flood | — | ✅ | `client.py:239,306` |

So `sync-all` pacing is one ~1 s sleep **per chat**, with zero pacing between `iter_messages`
pages inside a chat. `--delay 0` removes even that.

### 7.5 `iter_messages` `total_buffer_limit`
`client.iter_messages(...)` is called without it (`client.py:188`), so Telethon's default applies
(10 000). Practically: a `--limit 5000` fetch buffers up to 10 000 entities in memory before
yielding. **UNVERIFIED in this Telethon version's exact default value** — not read; treated as an
implementation detail of Telethon, not of tg_cli.

---

## 8. Interactive stdin: what can block, and the fail-fast knob

| Path | Blocks on stdin? | Evidence |
|---|---|---|
| **All 12 network commands** via `connect()` → `await c.start()` | **YES, if the session is missing/invalid/unauthorised.** Telethon `start()` prompts `Please enter your phone (or bot token): ` via `input()` (`telethon/client/auth.py:22`), then a login **code** via `input()` (`auth.py:102`, `users.py:216`), then a 2FA **password** via `getpass.getpass()` (`auth.py:23`) — up to `max_attempts=3` (`auth.py:30`). | `client.py:76` |
| Same commands when the session **is** authorised | **No** — `_start()` returns as soon as `get_me()` returns a user (`telethon/client/auth.py:141-162`). | verified: `whoami`/`status` returned instantly with no stdin attached |
| `purge` without `-y` | **YES**, one `y/N` line (`data.py:77`) | verified |
| Every other command | never reads stdin | grep for `input(`/`getpass`/`click.confirm` in the package matches **only** `data.py:77` (and `_output.py:33` is `isatty`, a check, not a read) |

**The fail-fast knob.** There is **no tg_cli-level flag or env var** controlling this. Two practical
mechanisms, both external:

1. **Close stdin**: run with `< /dev/null` (or `subprocess.run(..., stdin=subprocess.DEVNULL)`).
   `input()` on closed/EOF stdin raises `EOFError` inside `start()` → the command dies with a
   traceback, **rc 1**, in milliseconds. This is the only universal guard for the auth path, since
   `whoami`/`status` would otherwise convert it to `auth_error` (§1.5) and the other commands just crash.
2. **`-v/--verbose` before the subcommand** (`cli/main.py:13,23-26`) switches logging to `DEBUG`,
   which makes Telethon's own prompts/retries visible on stderr — diagnostic, not protective.
   Note `logging.basicConfig` is used, so DEBUG floods include Telethon's protocol log.

For `purge` specifically, `< /dev/null` yields a clean `Aborted!`/rc 1 (§6), and `-y` avoids stdin entirely.

**Never assume a network command is safe to run unattended:** with a valid session it is; with a
rotated/invalid session it hangs or dies on a phone prompt, and answering that prompt interactively
would be an interactive login on someone else's machine.

---

## 9. Sync limits and defaults

| Knob | Default | Applies to | Evidence |
|---|---|---|---|
| `history -n/--limit` | **1000** (⚠ not in `--help`) | one chat, this run | `tg.py:73` |
| `sync -n/--limit` | **5000** (⚠ hidden) | one chat, this run | `tg.py:105` |
| `sync-all -n/--limit` / `refresh -n/--limit` | **5000** (⚠ hidden) | **per chat** | `tg.py:144,187`; `client.py:249` |
| `sync-all --max-chats` / `refresh --max-chats` | `None` = **all dialogs** | per run; applied as `items[:max_chats]` on the dialog list in dialog-iteration order | `tg.py:152-156,194-199`; `client.py:276-277` |
| `sync-all --delay` / `refresh --delay` | **1.0** s (shown), float, ±20 % jitter | between chats | `tg.py:146-150`; `client.py:312-315` |
| `_FIRST_SYNC_LIMIT` | **500** — hard-coded module constant, **no flag** | **first-time** chats only | `client.py:35,287-289` |
| `--sync-limit` (search/recent/top/timeline/today/filter/stats) | **5000**, shown | acts as `limit_per_chat` for the `--sync-first` fetch | `query.py:44-49,132-137,188-193,233-238,296-301,348-353,407-412` |
| `fetch_history` `limit` (signature) | 1000 | only if a caller omits it — all CLI callers pass one | `client.py:152` |
| `BATCH_SIZE` | **200** rows per DB transaction | all fetches | `client.py:186,222` |
| `search -n` / `recent -n` | 50 (⚠ hidden) | result rows | `query.py:50,138` |
| `search --regex` internal scan | fetches `LIMIT limit*10` rows, then filters in Python | **silent truncation** | `db.py:250,253-261` |
| `top -n` | 20 (⚠ hidden) | sender rows | `query.py:239` |
| `today` | `LIMIT 5000`, **no flag** | rows | `db.py:294,323` |
| `filter` | `100000` with `--hours`, else 5000 via `get_today`; **no `-n`** | rows | `query.py:446-449` |
| `export` | `100000` (both branches), **no flag** | rows | `data.py:29,31` |
| `get_recent` signature default `limit=500` | never used — every caller passes an explicit limit | — | `db.py:268` |

### 9.1 `_FIRST_SYNC_LIMIT` is the big silent one

```
if last_id == 0 and limit_per_chat > _FIRST_SYNC_LIMIT:      # client.py:287
    effective_limit = _FIRST_SYNC_LIMIT                       # client.py:288 → 500
```

`last_id` comes from `MAX(msg_id)` for that `chat_id` (`client.py:283`, `db.py:339-343`).
So in `sync-all`/`refresh`, **a chat never seen before is capped at 500 messages no matter what
`--limit` you pass** — `tg sync-all -n 50000` still fetches only the newest 500 per new chat. It
only logs at `DEBUG` (`client.py:289`), so it is invisible without `-v`. To exceed 500 on a new
chat you must run `sync-all` again (now `last_id != 0`, so the full `--limit` applies) or use
`tg history CHAT -n N` for that chat (`client.py:188` receives the caller's limit directly).

Note the asymmetry: the check is `limit_per_chat > 500`, so `tg sync-all -n 300` fetches 300 on a new chat, and `-n 5000` fetches 500. Both look like "the limit" in the payload.

### 9.2 `min_id` incremental semantics

`sync` uses `min_id = MAX(msg_id)` for the chat (`_sync.py:41,49`), and `sync_all` the same
(`client.py:283,297`). Two consequences:
- `min_id` is Telegram's **message id**, so a chat whose ids were reset/restarted (or a legacy→
  supergroup migration that renumbers ids, which produces a **different** `chat_id`) can make
  `min_id` too high → **silently zero new messages forever**.
- `get_last_msg_id(chat_id)` does **no** id normalisation (§4.3) and is keyed on the **stored bare** id; the
  `chat_id` used here comes from `iter_dialogs()`'s `entity.id` (`client.py:280`), i.e. also bare — consistent ✅.
  But `sync`'s own *display* branch resolves `chat_id` from the **DB** (`tg.py:113`) and prints
  `Syncing from msg_id > {last_id}...` (`tg.py:120`); `_sync.py:40-41` recomputes it independently.
  If those two disagree (ambiguous name, `resolve_chat_id` returning `None`), the printed line and
  the actual fetch are based on **different** chats: `resolve_chat_id` returns `None` for >1 match
  (`db.py:100-103`) → `last_id=0` → a full re-fetch, while the earlier `find_chats` in the command
  already handled the ambiguity. See §10.1.
