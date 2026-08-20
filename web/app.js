/* Elysium Agent — SPA Alpine.js: state, progetti, SSE streaming, run. */

const API = "/api";

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
    error: null,
    loadingProjects: true,
    _poll: null,

    smart, pct,

    init() {
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
        // auto-seleziona l'ultimo se non c'è selezione
        if (!this.current && this.projects.length) {
          await this.switchProject(this.projects[0].id);
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loadingProjects = false;
      }
    },

    async newProject() {
      const name = prompt("Nome del progetto:");
      if (!name || !name.trim()) return;
      try {
        const r = await fetch(API + "/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore");
        this.projects.unshift({ id: d.id, name: d.name, files_count: 0 });
        await this.switchProject(d.id);
      } catch (e) { this.error = e.message; }
    },

    async switchProject(id) {
      try {
        const r = await fetch(API + "/projects/" + id);
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "errore");
        this.current = d;
        const c = await (await fetch(API + `/projects/${id}/chat`)).json();
        this.messages = c.messages || [];
        this.error = null;
        this.view = "chat";
        this.$nextTick(() => this.scrollBottom());
      } catch (e) { this.error = e.message; }
    },

    scrollBottom() {
      const el = this.$refs.messages;
      if (el) el.scrollTop = el.scrollHeight;
    },

    renderMd(m) { return mdToHtml(m); },

    /* ── invio + SSE ─────────────────────────────────────── */
    async send() {
      const text = this.draft.trim();
      if (!text || this.busy) return;
      this.draft = "";
      this.error = null;
      this.messages.push({ role: "user", content: text });
      this.busy = true;
      this.loopActive = false;
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
        let assistantText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              this.handleEvent(ev);
              if (ev.type === "chunk") assistantText += ev.text;
            } catch (e) { /* salta eventi malformati */ }
          }
        }
        if (assistantText) {
          // risposta già salvata dal server; aggiorna l'ultimo assistant se presente
          const last = this.messages[this.messages.length - 1];
          if (last && last.role === "assistant") last.content = assistantText;
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.busy = false;
        this.loopActive = false;
        // ricarica chat (report loop salvati dal server) + file
        const c = await (await fetch(API + `/projects/${this.current.id}/chat`)).json();
        this.messages = c.messages || [];
        this.refreshProject();
        this.scrollBottom();
      }
    },

    handleEvent(ev) {
      switch (ev.type) {
        case "loop":
          this.loopActive = true;
          this.loopTier = ev.tier;
          break;
        case "chunk":
          break; // gestito dal buffer
        case "report":
          this.loopActive = false;
          break;
        case "error":
          this.error = ev.detail;
          this.loopActive = false;
          break;
        case "done":
          this.loopActive = false;
          break;
      }
    },

    async refreshProject() {
      if (!this.current) return;
      try {
        const r = await fetch(API + "/projects/" + this.current.id);
        const d = await r.json();
        if (r.ok) { this.current = d; this.connected = true; }
        await this.loadProjects();
      } catch (e) { /* silenzioso */ }
    },

    async openRuns() {
      if (this.current) await this.refreshProject();
      this.view = "runs";
    },
  };
}
