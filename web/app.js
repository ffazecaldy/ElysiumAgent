/* Optimize Engine — SPA Alpine.js: stato, polling, progress live. */

const API = "";

function smart(n) {
  /* numeri smart format: 1500 -> 1.5k, 1234567 -> 1.2M */
  if (n === null || n === undefined) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + "k";
  return String(n);
}

function app() {
  return {
    view: "new",
    busy: false,
    error: null,
    history: [],
    historyError: null,
    preflight: null,
    current: { status: "", max_rounds: 3, events: [] },
    form: { goal: "", bar: "pytest", max_rounds: 3 },
    _timer: null,
    _poll: null,

    smart,

    init() {
      this._loadHistory();
    },

    statusClass() {
      return this.current.status || "";
    },
    statusClassShort(s) {
      return (s || "").replace(/-/g, "_");
    },

    /* ── creazione ─────────────────────────────────────────── */
    async createRun() {
      if (!this.form.goal.trim()) { this.error = "Inserisci un obiettivo."; return; }
      this.busy = true; this.error = null; this.preflight = null;
      try {
        const r = await fetch(API + "/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.form),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail || "Errore creazione run");
        this.preflight = body;
        this.saveLocal(body);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },

    /* ── pre-flight / confirm / continue / stop ────────────── */
    async confirmRun() {
      this.busy = true; this.error = null;
      const id = this.preflight.id;
      try {
        const r = await fetch(API + `/runs/${id}/confirm`, { method: "POST" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail || "Errore conferma");
        await this.openRun(id);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },

    async continueRun() {
      this.busy = true;
      try {
        const r = await fetch(API + `/runs/${this.current.id}/continue`, { method: "POST" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail || "Errore continue");
        await this.openRun(this.current.id);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },

    async stopRun() {
      this.busy = true;
      try {
        const r = await fetch(API + `/runs/${this.current.id}/stop`, { method: "POST" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail || "Errore stop");
        await this.openRun(this.current.id);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
      }
    },

    /* ── polling ───────────────────────────────────────────── */
    async openRun(id) {
      this.clearPoll();
      this.view = "run";
      await this._fetchRun(id);
      // polling GET /runs/{id}/events ogni 2s
      this._poll = setInterval(async () => {
        if (this.view !== "run") return;
        await this._fetchRun(id);
        const st = this.current.status;
        if (["completed", "stopped", "quota_exhausted", "failed"].includes(st)) {
          this.clearPoll();
          this._loadHistory();
        }
      }, 2000);
    },

    async _fetchRun(id) {
      try {
        const r = await fetch(API + `/runs/${id}`);
        const body = await r.json();
        if (!r.ok) throw new Error(body.detail || "Errore");
        this.current = body;
        this.error = null;
      } catch (e) {
        this.error = e.message;
      }
    },

    clearPoll() {
      if (this._poll) { clearInterval(this._poll); this._poll = null; }
    },

    back() {
      this.clearPoll();
      this.view = "new";
      this.current = { status: "", max_rounds: 3, events: [] };
      this.preflight = null;
      this.error = null;
      this._loadHistory();
    },

    /* ── cronologia (localStorage) ─────────────────────────── */
    saveLocal(body) {
      try {
        const k = "optimize-engine-runs";
        const arr = JSON.parse(localStorage.getItem(k) || "[]");
        arr.push({ id: body.id, goal: this.form.goal, created_at: Date.now() / 1000 });
        localStorage.setItem(k, JSON.stringify(arr.slice(-20)));
      } catch (e) { /* storage non disponibile */ }
    },

    _loadHistory() {
      try {
        const k = "optimize-engine-runs";
        this.history = JSON.parse(localStorage.getItem(k) || "[]");
      } catch (e) {
        this.history = [];
      }
      // prova a ricaricare lo stato server per i run recenti
      fetch(API + "/runs").then((r) => r.json()).then((d) => {
        const servers = {};
        (d.runs || []).forEach((run) => { servers[run.id] = run; });
        this.history = this.history.map((h) =>
          servers[h.id] ? { ...h, status: servers[h.id].status } : h
        ).filter((h) => h.goal);
      }).catch(() => {});
    },
  };
}
