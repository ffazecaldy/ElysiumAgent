# SETUP — Elysium Agent harness

Guida di installazione, avvio e troubleshooting dell'harness **Elysium Agent**
(server FastAPI + UI web + loop multi-agente). Dopo l'avvio l'interfaccia è
disponibile su **http://127.0.0.1:8137**.

---

## Prerequisiti

- **Python 3.11 o superiore** (verifica con `python --version`)
- `pip` incluso nella distribuzione Python
- (consigliato) un terminale bash / PowerShell / cmd; su Windows i comandi qui
  sotto usano la convenzione `python` e lo script di attivazione in `.venv\Scripts\`

> Se non hai ancora le dipendenze, il passo 2 le installa tutte a partire da
> `requirements.txt`: FastAPI, uvicorn, httpx, pyyaml, pytest.

---

## Passo 1 — Crea il virtual environment

Dalla root del repository:

```bash
python -m venv .venv
```

Attiva il venv:

- **Windows:** `.venv\Scripts\activate`
- **Linux/macOS:** `source .venv/bin/activate`

Attivo il venv, il prompt del terminale mostra `(.venv)`.

---

## Passo 2 — Installa le dipendenze

```bash
pip install -r requirements.txt
```

---

## Passo 3 — Imposta l'API key

L'harness usa un **LLM OpenAI-compatible** via provider **opencode-go**
(modello `deepseek-v4-flash`). Serve una API key valida; la variabile letta per
default è `OPTIMIZE_ENGINE_API_KEY`, con fallback su `OPENCODE_GO_API_KEY`.

**Windows (PowerShell):**

```powershell
$env:OPTIMIZE_ENGINE_API_KEY = "la-tua-api-key"
```

**Windows (cmd):**

```cmd
set OPTIMIZE_ENGINE_API_KEY=la-tua-api-key
```

**Linux/macOS:**

```bash
export OPTIMIZE_ENGINE_API_KEY="la-tua-api-key"
```

Aggiungi la variabile anche al file `.env` della root perché possa essere
ricaricata tra una sessione e l'altra.

> ⚠️ **Attenzione: non committare mai la key.** La chiave va tenuta solo in
> variabili d'ambiente o in `.env`. Il file `.env` è già escluso via `.gitignore`
> (insieme a `projects/`, `results/` e ai log). **Non** incollare la key dentro
> `config.yaml`, README, o codice e verificare sempre con `git status` che non
> finisca in un commit.

---

## Passo 4 — Avvia il server

Dalla root del repository, col venv attivo:

```bash
python scripts/run_server.py
```

In alternativa, avvio diretto con **uvicorn** (equivalente):

```bash
uvicorn api.main:app --host 127.0.0.1 --port 8137
```

All'avvio il server resta in ascolto su `127.0.0.1:8137` e serve sia l'API sia
la UI web.

---

## Passo 5 — Apri l'interfaccia

Apri il browser su:

```
http://127.0.0.1:8137
```

La UI è una chat dark (Alpine.js + CSS). A fianco della chat trovi l'area
**progetti** per creare e selezionare il workspace.

---

## Passo 6 — Crea un progetto e prova un goal

1. Dalla UI crea un nuovo **progetto** (nome del workspace in cui l'harness
   scriverà i file).
2. Inserisci un **goal** nella chat e invia.
3. Il comportamento dipende dal **tier** auto-detectato dal goal:
   - **tier 1** → risposta diretta dell'LLM (streaming, nessun file scritto);
   - **tier 2+** → viene attivato il **loop multi-agente Elysium**: decompose →
     scatter parallelo → quality gate → scrittura file nel progetto.
4. Il report del loop (stato, task, qualità, file scritti) viene mostrato in
   una card a fine esecuzione.

> Per forzare il loop anche su goal semplici usa il prefisso **"attiva elysium"**
> (vedi Troubleshooting).

---

## Troubleshooting

### HTTP 500 / "errore quota" → `QuotaExhaustedError`

**Sintomo:** la chiamata all'LLM fallisce con un errore di quota (HTTP 429 con
segnale `x-quota-exhausted` o errori tipo *quota exhausted / insufficient*) e il
run passa allo stato `quota_exhausted`.

**Causa:** il provider opencode-go applica una **quota rolling di 5 ore**;
superato il limite le chiamate vengono bloccate. L'harness solleva
`QuotaExhaustedError` **al primo colpo** — qualsiasi retry cieco in questo stato
è inutile e brucerebbe solo i timeout.

**Soluzione:**
- **Attendi** il reset della finestra (rolling 5 ore);
- poi **ricarica** la pagina / riprova il goal.

### Nessun file scritto

**Sintomo:** invii un goal, ottieni una risposta, ma nella cartella del progetto
non compare nessun file.

**Causa (atteso, non un bug):** i **goal tier 1** vengono gestiti con la
**risposta diretta** dell'LLM (solo testo, streaming) e **non eseguono il loop**:
per definizione non scrivono file.

**Soluzione:**
- per attivare il loop multi-agente (che scrive i file) usa goal **tier 2+**
  (goal espliciti, di programmazione/ottimizzazione, che l'auto-detection
  classifica a tier >= 2);
- **oppure** forza il loop col prefisso esplicito **"attiva elysium"** prima del
  goal (accettati anche: *elysium*, *swarmloop*, *fai il loop*, *usa gli agenti*,
  *multi-agente*).

### Porta occupata

**Sintomo:** all'avvio il server fallisce con errore tipo
`address already in use` / `[Errno 10048]` e la porta 8137 non parte.

**Causa:** un'altra istanza dell'harness (o un altro processo) occupa già
`127.0.0.1:8137`.

**Soluzione:**
- chiudi l'eventuale secondo server in esecuzione, oppure
- avvia su un'altra porta con l'opzione `--port`:

```bash
python scripts/run_server.py --port 8138
# oppure con uvicorn:
uvicorn api.main:app --host 127.0.0.1 --port 8138
```

e apri poi `http://127.0.0.1:8138`.
