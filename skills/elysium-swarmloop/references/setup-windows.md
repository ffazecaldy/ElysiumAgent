# Elysium Swarmloop — Setup Windows (Hermes Desktop)

Setup validato su Hermes Desktop (Windows 10/11, git-bash).

## Passaggi essenziali

### 1. Delegation settings (config.yaml)

```bash
hermes config set delegation.orchestrator_enabled true
hermes config set delegation.max_concurrent_children 100
hermes config set delegation.max_spawn_depth 2
```

Verifica: `grep -A10 "^delegation:" "$HOME/AppData/Local/hermes/config.yaml"`

### 2. jq (per bootloader bash)

```bash
# Scarica jq-win64.exe
curl -L -o "C:/Users/$USER/bin/jq.exe" \
  "https://github.com/jqlang/jq/releases/download/jq-1.7/jq-win64.exe"
chmod +x "C:/Users/$USER/bin/jq.exe"

# Aggiungi al PATH permanente
echo 'export PATH="C:/Users/$USER/bin:$PATH"' >> ~/.bashrc
export PATH="C:/Users/$USER/bin:$PATH"
jq --version   # → jq-1.7
```

### 3. Pattern store SQLite

La skill registra i pattern nel database di Hermes. **Il DB non è `~/.hermes/hermes.db`** su Windows Desktop — si trova in:

```
C:\Users\<USER>\AppData\Local\hermes\state.db
```

Inizializzazione (una tantum):

```python
import sqlite3

db = r'C:\Users\<USER>\AppData\Local\hermes\state.db'
sql = r'C:\Users\<USER>\AppData\Local\hermes\skills\autonomous-ai-agents\elysium-swarmloop\references\pattern-store.sql'

conn = sqlite3.connect(db)
with open(sql) as f:
    conn.executescript(f.read())
conn.commit()

# Verifica
cur = conn.execute(
    "SELECT name FROM sqlite_master WHERE type='table' "
    "AND name IN ('executions','decomposition_patterns','pitfalls','calibrations')"
)
print("OK:", [r[0] for r in cur.fetchall()])
conn.close()
```

`executescript()` gestisce automaticamente commenti e statement multipli — non serve pre-processare l'SQL.

### 4. Test bootloader

```bash
cd "$HOME/AppData/Local/hermes/skills/autonomous-ai-agents/elysium-swarmloop"

# Quick fix → Tier 1
bash scripts/init-state.sh --json "Fix typo in config"
# → {tier: 1, subagents: 3, threshold: 6}

# API → Tier 3
bash scripts/init-state.sh --json "Build REST API for booking"
# → {tier: 3, subagents: 35, threshold: 7}

# Greenfield → Tier 4
bash scripts/init-state.sh --json "Build greenfield full-stack platform"
# → {tier: 4, subagents: 80, threshold: 8}
```

## Note

- `init-state.sh` crea `.state.json` nella directory della skill
- I valori di tier/subagents/threshold sono idempotenti: rieseguire con lo stesso goal riusa i contatori
- La modalità `--json` stampa solo JSON su stdout (utile per scripting) senza scrivere su file
