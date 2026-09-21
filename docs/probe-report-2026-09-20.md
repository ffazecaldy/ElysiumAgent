# Probe Report — 10 aree testate, buchi trovati (2026-09-20)

> **FIX STATUS (2026-09-20, commit successivo):** Fase 1 chiusa — B1 B2 B3 B4 B5 B7 B8 B9 B10 B11
> B13(static) B18 corretti e RIVERIFICATI rieseguendo la stessa campagna di probe (findings v2:
> tutti i P0 ora bloccati/di grado corretto). Regression tests: `bash-policy-hardening.test.ts`
> (16) + `probe-hardening.test.ts` (19). Nota onesta: B13 è chiuso a livello command-policy
> (interpreti inline gated); l'ISOLAMENTO di rete reale resta lavoro architetturale separato —
> command policy ≠ network isolation.

Campagna offensiva su 10 aree dell'harness. Sonde runtime eseguite offline (tsx, mock provider,
server locali) — nessun provider reale chiamato. Raw findings: `probe-results/<area>/findings.json`
(non committato). Baseline: 503 test | 1 skip, typecheck ok, build ok.

## Buchi confermati (con riproduzione)

| ID | Area | Severità | Buco | Prova |
|----|------|----------|------|-------|
| B1 | bash-gate | **alta** | Il tokenizer non spacca i token quotati: `"git" "push"`, `git pu\sh`, `$'git push'` passano il gate e girano come `git push` reale | S1 bash-gate (verdict ALLOW su 3 varianti) |
| B2 | bash-gate | **alta** | `$()` e backtick non analizzati: `echo $(git push)` / `` echo `git push` `` → ALLOW, il subcomando gira in exec | S1 (2 varianti ALLOW) |
| B3 | bash-gate | **alta** | `eval "git push"` e `bash -c "git push"` ALLOW: l'interprete riceve il comando negato come singolo token opaco | S1 (2 varianti ALLOW) |
| B4 | bash-gate | media-alta | `powershell -c <cmd>`, `cmd /c "rmdir /s /q ..."` ALLOW: solo `-enc` è in deny; distruttivi via shell Windows passano | S1 |
| B5 | bash-gate | media | `tee <path>` scrive fuori dai writable roots (nessun check sui path-args di tee); idem `python -c urllib` / `node -e fetch` aggirano network=false in swarm | S1 |
| B6 | secret-guard | media | `collectEnvSecretValues` cap 200: il 201° env value passa in chiaro nel tool result (cap documentato come boundary cost, ma è un buco di redaction) | S2 — non riprodotto nel test (300 valori → 0 leak: il cap è su collect, i probe passano l'array intero; buco sul percorso reale `collectEnvSecretValues`) |
| B7 | decision/sanitize+fingerprint | media | Stato ciclico → `stateHash` lancia `ReferenceError: require is not defined` (ESM) e `buildDecisionRecord` lancia su `JSON.stringify` circolare: un solo stato circolare avvelena record + evento | P6 decision (2 throw) |
| B8 | decision/swarm-hooks | media | `refineFailureCause` accetta qualsiasi `choice` del provider — nessun check tassonomia: `cause="MADE_UP_CAUSE"`, conf 0.99 → diventa la causa del repair | P5 decision (violation: true) |
| B9 | decision/swarm-hooks | bassa-media | `refineRisk` restituisce `securitySensitive`/`requiresReview` anche in shadow (solo `level` è gated): consumo senza gate = comportamento enforce in shadow | P5 decision |
| B10 | task-ownership | media | `checkPath` non normalizza `..`: `src/../escape.ts` è ALLOW in write (il glob `src/**` matcha la stringa grezza); il vero resolver (`resolveWithin`) blocca — l'ownership di SwarmBuilder è più debole del tool policy | S3 checkPath |
| B11 | swarm-git | media | `rollbackFiles` non ripristina file untracked creati dopo il tag: `new-untracked.txt` sopravvive al rollback (checkout di path inesistenti al tag = no-op silenzioso, rolledCount=3/3 anche se uno non ha fatto nulla) | S4 (newUntrackedRemoved: false) |
| B12 | swarm-view | bassa | `truncate()` conta la lunghezza RAW (ANSI inclusa): righe con escape codes vengono tagliate troppo presto / escape spezzati — viola il contratto "clip a visible width" | S6 (len 10 su 24 visibili) |
| B13 | swarm network set | media | Network=false blocca solo curl/wget/nc/ssh/ftp/telnet (base command): `python -c urllib`, `node -e fetch` ALLOW — unattended swarm può raggiungere la rete | S1 |
| B14 | lint | media | 4 errori biome a HEAD (import order in swarm-mode.ts + decision-runtime.test.ts): pushato senza gate lint (fix in questo commit) | `npx biome check .` |
| B15 | md.ts | bassa | ANSI e null byte del testo modello passano attraverso il renderer (nessuno strip): superficie di injection terminale nel REPL | M1 |
| B16 | progress.ts | bassa | Contenuto con `## Header` dentro il body crea sezioni fantasma in progress.md (lettori le trattano come sezioni); goal 100KB scritto intero (solo il render è capped) | M4 |
| B17 | critic parse | bassa | `parseCriticVerdict` fail-open: garbage → `passed=true` (documentato, ma è un fallimento silenzioso del quality gate); JSON array valida come passed=false (ok) | S6 |
| B18 | redactObject cycle | media | `redactObject` su oggetto ciclico → RangeError stack overflow: un tool result ciclico crasha il boundary (mai con `try/catch` nel percorso emit?) | S2 (THROWS) |

##Invarianti tenute (nessun buco trovato)

| Area | Esito |
|------|-------|
| Decision: DENY deterministico intoccabile | 15/15 combinazioni (mode × semantica) — HELD |
| Decision: escalation-only (shadow+enforce) | 20/20 combinazioni — HELD |
| Decision: triageCritic gates | enforce+obvious → skip; shadow/near-threshold/throw → critic sempre; HELD |
| Decision: provider failure modes | timeout/http/malformed/NaN/Inf → typed error, mai throw, run non bloccato |
| Decision: minimizeState | forbidden keys, cap stringhe/liste, redaction nested — TUTTO ok |
| Decision: fingerprint ids | unici, counters per-run, statehash stabile |
| Path policy (resolveWithin) | traversal/absolute/UNC/bounce tutti bloccati (realpath-based) |
| web_fetch network:false | isError senza nessun fetch (0 connessioni) |
| web_fetch scheme gate | file:/ftp:/data: rifiutati |
| web_fetch 100KB cap | rispettato (taglio anche mid-UTF8: body parziale, niente crash) |
| stripHtml | script/style/commenti/attributi-evento rimossi |
| secret-guard regex escape | valori con metacaratteri regex correttamente redatti |
| env contract | default safe: typo di enforce → shadow; bash gate off solo con "off" esatto (case-insensitive); timeout env validati (fallback su 0/-1/abc) |

## Note di contesto

- Le sonde concorrenza/swarm-view-live e parte dello stress sono da eseguire (batch subagent caduto
  per quota API). Le sonde crash-recovery del subagent (p1–p9) sono COMPLETE nei risultati:
  record corrotti/troncati → skipped silenziosamente (accettabile); markInterrupted dopo finish →
  run COMPLETED diventa resumable con pendingOperations spurie (**da fixare**); doppio applyResume →
  attempt incrementa senza doppioni (ok); race di due resume → ultimo-writer-wins, niente lock
  (**basso rischio, da monitorare**); path unicode/spaziati → ok.
- Nessun test di regressioni rotto durante le sonde: tutte le sonde girano fuori dai path di test.
