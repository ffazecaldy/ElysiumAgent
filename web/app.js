/* Elysium Agent — SPA Alpine.js: stato, progetti, chat con stream live,
   loop Elysium, pannello file (sola lettura) e vista run con dettaglio.

   NESSUNA doppia append: il server salva la conversazione in chat.json;
   il client mostra lo stream in `streamText` (variabile separata, non
   dentro `messages`) e alla fine sincronizza `messages` sostituendo
   l'array dall'archivio. Nessun messaggio viene ricopiato a mano.

   Persistenza: vista (chat/run) e ultimo progetto in localStorage,
   ripristinati all'avvio. Il dialog "nuovo progetto" e il viewer file
   hanno focus trap (Tab ciclato) e chiusura con Esc. */

const API = "/api";

/* ── helper di formattazione ────────────────────────────────── */
function smart(n) {
  if (n === null || n === undefined) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + "k";
  return String(n);
}

function pct(x) {
  if (x === null || x === undefined) return "—";
  return Math.round(x * 100) + "%";
}

function fmtBytes(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1).replace(".", ",") + " kB";
  return (n / 1048576).toFixed(1).replace(".", ",") + " MB";
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const pad = (x) => String(x).padStart(2, "0");
  const opts = { day: "2-digit", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  const giorno = d.toLocaleDateString("it-IT", opts);
  return giorno + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function fmtDur(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return Math.round(sec) + "s";
  const m = Math.floor(sec / 60);
  return m + "m " + Math.round(sec % 60) + "s";
}

function fileExt(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(path || "");
  return m ? m[1].toUpperCase().slice(0, 4) : "FILE";
}

function statusLabel(s) {
  return ({ completed: "completata", partial: "parziale",
            running: "in corso", failed: "fallita" })[s] || s || "—";
}

function statusClass(s) {
  return ["completed", "partial", "running", "failed"].includes(s) ? s : "unknown";
}

/* stato derivato per la card run (la lista non espone final_status) */
function runPill(r) {
  const fpr = r.first_pass_rate;
  if (fpr === null || fpr === undefined) return { label: "in corso", cls: "running" };
  if (fpr >= 1) return { label: "completo", cls: "completed" };
  if (fpr > 0) return { label: "parziale", cls: "partial" };
  return { label: "fallito", cls: "failed" };
}

/* localStorage sicuro (può lanciare in contesti ristretti) */
function saveLS(k, v) {
  try { localStorage.setItem(k, v); } catch (e) { /* silenzioso */ }
}
function loadLS(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdToHtml(md) {
  /* mini renderer markdown: code, pre, bold, italic, liste */
  md = esc(md || "");
  md = md.replace(/```(?:python|py|json|yaml)?\n([\s\S]*?)```/g, (m, code) => `<pre>${code}</pre>`);
  md = md.replace(/`([^`]+)`/g, "<code>$1</code>");
  md = md.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  md = md.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  md = md.replace(/^##?\s+(.+)$/gm, "<strong>$1</strong>");
  md = md.replace(/^- (.+)$/gm, "• $1<br>");
  md = md.replace(/\n/g, "<br>");
  return md;
}

/* ── componente Alpine ──────────────────────────────────────── */
function app() {
  return {
    view: "chat",
    connected: false,
    projects: [],
    current: null,
    messages: [],
    draft: "",
    busy: false,
    loopActive: false,
    loopTier: null,
    streamText: "",          // testo stream in diretta (non in messages)
    liveReport: null,        // report del loop mostrato appena concluso
    error: null,
    loadingProjects: true,
    sidebarOpen: false,

    /* dialog nuovo progetto */
    newProjectOpen: false,
    newProjectName: "",
    _modalFocus: null,

    /* file viewer (sola lettura) */
    viewer: { open: false, path: "", content: "", bytes: 0,
              truncated: false, loading: false, error: null },
    _viewerFocus: null,

    /* run */
    runs: [],
    runsLoading: false,
    expandedRun: null,
    runDetail: null,

    /* ripristino da localStorage (consumato al primo switch) */
    _pendingRestoreView: null,
    _restoreProject: null,

    smart, pct, fmtBytes, fmtDate, fmtDur, fileExt,
    statusLabel, statusClass, runPill,

    init() {
      this._pendingRestoreView = loadLS("elysium.view") === "runs" ? "runs" : null;
      this._restoreProject = loadLS("elysium.project");
      this.loadProjects();
      this.pollHealth();
      setInterval(() => this.pollHealth(), 8000);
    },

    async pollHealth() {
      try {
        const r = await fetch(API + "/projects");
        this.connected = r.ok;
      } catch (e) { this.connected = false; }
    },

    async loadProjects() {
      this.loadingProjects = true;
      try {
        const r = await fetch(API + "/projects");
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore");
        this.projects = d.projects || [];
        if (!this.current && this.projects.length) {
          const target = this.projects.find((p) => p.id === this._restoreProject) || this.projects[0];
          await this.switchProject(target.id);
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loadingProjects = false;
      }
    },

    /* ── dialog nuovo progetto (focus trap + Esc) ─────────────── */
    openNewProject() {
      this._modalFocus = document.activeElement;
      this.newProjectOpen = true;
      this.newProjectName = "";
      this.sidebarOpen = false;
      this.$nextTick(() => {
        const el = this.$refs.npInput;
        if (el && el.focus) el.focus();
      });
    },

    cancelNewProject() {
      this.newProjectOpen = false;
      this.newProjectName = "";
      this.$nextTick(() => {
        const prev = this._modalFocus;
        if (prev && prev.isConnected && prev.focus) prev.focus();
      });
    },

    async confirmNewProject() {
      const name = this.newProjectName.trim();
      if (!name) return;
      this.newProjectOpen = false;
      this.newProjectName = "";
      try {
        const r = await fetch(API + "/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore");
        this.projects.unshift({ id: d.id, name: d.name, files_count: 0 });
        await this.switchProject(d.id);
      } catch (e) { this.error = e.message; }
    },

    /* focus trap generico: il Tab cicla dentro il pannello indicato */
    trapFocus(e, refName) {
      const el = this.$refs[refName];
      if (!el) return;
      const focusables = el.querySelectorAll(
        'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },

    async switchProject(id) {
      try {
        const r = await fetch(API + "/projects/" + id);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore");
        this.current = d;
        this.runs = d.runs || [];
        this.expandedRun = null;
        this.runDetail = null;
        this.liveReport = null;
        this.closeViewer(true); // senza ripristino focus
        saveLS("elysium.project", id);
        const c = await (await fetch(API + `/projects/${id}/chat`)).json();
        this.messages = this.keyMessages(c.messages || []);
        this.error = null;
        this.view = "chat";
        saveLS("elysium.view", "chat");
        this.sidebarOpen = false;
        if (this._pendingRestoreView === "runs") {
          this._pendingRestoreView = null;
          await this.openRuns();
          return;
        }
        this.$nextTick(() => this.scrollBottom());
      } catch (e) { this.error = e.message; }
    },

    /* chiavi stabili: il DOM viene riusato da Alpine, quindi le animazioni
       di ingresso partono solo per i messaggi realmente nuovi. */
    keyMessages(msgs) {
      return msgs.map((m, i) => ({ ...m, _key: (m.role || "?") + ":" + i }));
    },

    get sortedFiles() {
      if (!this.current) return [];
      return [...(this.current.files || [])]
        .sort((a, b) => a.path.localeCompare(b.path, "it", { numeric: true }));
    },

    scrollBottom() {
      const el = this.$refs.messages;
      if (el) el.scrollTop = el.scrollHeight;
    },

    renderMd(m) { return mdToHtml(m); },

    /* ── navigazione ─────────────────────────────────────────── */
    openChat() {
      this.view = "chat";
      saveLS("elysium.view", "chat");
      this.sidebarOpen = false;
      this.$nextTick(() => this.scrollBottom());
    },

    async openRuns() {
      this.closeViewer(true);
      this.view = "runs";
      saveLS("elysium.view", "runs");
      if (this.current) await this.loadRuns();
      else this.runs = [];
    },

    toggleSidebar() { this.sidebarOpen = !this.sidebarOpen; },

    /* ── file viewer ─────────────────────────────────────────── */
    async openFile(path) {
      if (!this.current) return;
      this._viewerFocus = document.activeElement;
      this.viewer = { open: true, path, content: "", bytes: 0,
                      truncated: false, loading: true, error: null };
      this.sidebarOpen = false;
      this.$nextTick(() => {
        const el = this.$refs.viewerClose;
        if (el && el.focus) el.focus();
      });
      try {
        const addr = path.split("/").map(encodeURIComponent).join("/");
        const r = await fetch(`${API}/projects/${this.current.id}/files/${addr}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "impossibile leggere il file");
        this.viewer.content = d.content || "";
        this.viewer.bytes = (d.content || "").length;
        this.viewer.truncated = !!d.truncated;
      } catch (e) {
        this.viewer.error = e.message;
      } finally {
        this.viewer.loading = false;
      }
    },

    closeViewer(silent) {
      this.viewer.open = false;
      this.viewer.error = null;
      if (!silent) {
        this.$nextTick(() => {
          const prev = this._viewerFocus;
          if (prev && prev.isConnected && prev.focus) prev.focus();
        });
      }
    },

    /* ── run ─────────────────────────────────────────────────── */
    async loadRuns() {
      if (!this.current) { this.runs = []; return; }
      this.runsLoading = true;
      try {
        const r = await fetch(`${API}/projects/${this.current.id}/runs`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore caricamento run");
        this.runs = d.runs || [];
      } catch (e) { this.error = e.message; }
      finally { this.runsLoading = false; }
    },

    async expandRun(run) {
      if (!this.current) return;
      if (this.expandedRun === run.id) {
        this.expandedRun = null;
        this.runDetail = null;
        return;
      }
      this.expandedRun = run.id;
      this.runDetail = null;
      try {
        const r = await fetch(`${API}/projects/${this.current.id}/runs/${run.id}`);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore caricamento run");
        this.runDetail = d;
      } catch (e) { this.error = e.message; }
    },

    async refreshProject() {
      if (!this.current) return;
      try {
        const [pr, pl] = await Promise.all([
          fetch(API + "/projects/" + this.current.id),
          fetch(API + "/projects"),
        ]);
        const d = await pr.json();
        const dl = await pl.json();
        if (pr.ok) { this.current = d; this.connected = true; }
        if (dl.projects) this.projects = dl.projects;
      } catch (e) { /* silenzioso */ }
    },

    /* ── invio + SSE ─────────────────────────────────────────── */
    async send() {
      const text = this.draft.trim();
      if (!text || this.busy) return;
      this.draft = "";
      this.error = null;
      this.streamText = "";
      this.loopActive = false;
      this.liveReport = null;
      // eco utente locale; la chiave coincide con quella del sync,
      // così il nodo viene riusato (niente doppia animazione)
      this.messages.push({ role: "user", content: text, _key: "user:" + this.messages.length });
      this.busy = true;
      this.scrollBottom();

      try {
        const res = await fetch(API + `/projects/${this.current.id}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
          body: JSON.stringify({ message: text }),
        });
        if (!res.ok || !res.body) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.detail || "errore " + res.status);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
            this.handleEvent(ev);
          }
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
        this.loopActive = false;
        // lo stream è già stato salvato dal server: ricarica l'archivio.
        // L'array viene sostituito per intero → nessuna doppia append.
        try {
          const c = await (await fetch(API + `/projects/${this.current.id}/chat`)).json();
          this.messages = this.keyMessages(c.messages || []);
          await this.refreshProject();
          if (this.view === "runs") await this.loadRuns();
        } catch (e) { /* silenzioso */ }
        this.scrollBottom();
      }
    },

    handleEvent(ev) {
      switch (ev.type) {
        case "loop":
          this.loopActive = true;
          this.loopTier = ev.tier;
          this.streamText = "";
          break;
        case "chunk":
          this.streamText += ev.text;
          this.scrollBottom();
          break;
        case "report":
          // loop concluso: riepilogo live finché il sync sostituisce i messaggi
          this.liveReport = ev.report;
          break;
        case "error":
          this.error = ev.detail;
          this.loopActive = false;
          this.liveReport = null;
          break;
        case "done":
          this.loopActive = false;
          break;
      }
    },

    /* ── alias/riempitivi compat per eventuale refactor di index.html ──
       La UI parallela può introdurre nomi alternativi per gli stessi
       concetti (files, fileOpen, loadFiles, closeFile, openRunDetail,
       closeRunDetail, newProject). Li esponiamo come alias sicuri:
       nessuna rottura del DOM attuale, nulla viene rimosso. */
    get files() { return this.current ? this.current.files : []; },

    get fileOpen() { return this.viewer.open; },

    loadFiles() {
      // alias di refreshProject: ricarica i file del progetto corrente
      return this.refreshProject();
    },

    closeFile() { this.closeViewer(); },

    openRunDetail(run) { return this.expandRun(run); },
    closeRunDetail() { this.expandedRun = null; this.runDetail = null; },

    newProject() { this.openNewProject(); },
  };
}
