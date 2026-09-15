# Prometheus Engine → Elysium Swarmloop: Comparison & Roadmap

Generated: July 2026 | From conversation comparing Prometheus Engine v5.7.0 vs Elysium Swarmloop v5.1.1

## Feature Gap Matrix

| Feature | Prometheus | Elysium (v5.2.0) |
|---------|-----------|-------------------|
| Core loop (assess → decide → decompose → scatter → stream → learn) | ✅ | ✅ |
| Tier system (1-4 auto-detect) | ✅ Raffinato | ✅ Base |
| Streaming gather + immediate retry | ✅ | ✅ |
| Hierarchical orchestration (depth-2) | ✅ | ✅ |
| Self-learning (pattern capture + calibration) | ✅ | ✅ |
| **Security AUTO Shield** (hardcoded secrets, SQL injection) | ✅ Phase 3d-ter | ✅ **Phase 3d (NEW)** |
| **Self-Learning Guardrails** (5 guardrail types) | ✅ Phase 4f (11 guardrail) | ✅ **Phase 4d (NEW)** |
| **Clarification Interview** (pre-plan Q&A) | ✅ Phase 0.5a | ✅ **Phase 0.5 (NEW)** |
| **Plan Integration** (structured plan writing) | ✅ Phase 0.5b | ✅ **Phase 0.5 (NEW)** |
| **Structural Alignment** (scan conventions before creating) | ✅ Phase 0.5c | ✅ **Phase 0.5 (NEW)** |
| Dynamic Subagent Allocation + Familiarity Factor | ✅ | ❌ |
| Quality-First Mode Override | ✅ | ❌ |
| Precedence Rule System (policy conflict resolver) | ✅ | ❌ |
| Shared Interface Contracts (function signatures between agents) | ✅ Phase 1c | ❌ |
| Clean Code Standards (type hints, SRP, DRY) | ✅ Phase 1d-bis | ❌ |
| Debug Mode (user-reported error handling) | ✅ Phase 3a-quater | ❌ |
| Parallel Sandbox Racing (3-5 variants) | ✅ Phase 3a-quinques | ❌ |
| Actor-Critic Escalation (failure pattern analysis) | ✅ Phase 3a-ter | ❌ |
| Git Checkpoint Policy (conditional commit/push per task) | ✅ Phase 3a-bis | ❌ |
| Assembly Task (post-batch shared file integration) | ✅ | ❌ |
| Adaptive Threshold Tuning (mid-loop granularity adjustment) | ✅ Phase 3c | ❌ |
| Context Window Protection (budget-based batching) | ✅ Phase 3e | ❌ |
| Global Re-Check Pass (project-wide quality review) | ✅ Phase 3f | ❌ |
| Dynamic Knowledge Expansion (Local/Global pattern split) | ✅ Phase 4g | ❌ |
| Token-Efficient Recall (structured pre-loop recall) | ✅ Phase 4b | ❌ |
| Skill Ecosystem Integration (map skill→loop phase) | ✅ Phase 10 | ❌ |
| Long Session Management (session_manager.py) | ✅ Phase 11 | ❌ |
| Convergence-Based Retry Limits | ✅ Phase 6c | ❌ |
| Pre-Dispatch Validation (detailed checklist) | ✅ Phase 2 | ❌ |
| Self-Feedback (autovalutazione 0-100%) | ✅ Phase 8 | ❌ |
| Config Prerequisites (hermes config set commands) | ✅ | ❌ |
| Python executable scripts (prometheus_engine.py, session_manager.py, e2e_test.py) | ✅ 3 scripts | ✅ 2 scripts (bash) |

## Priority Recommendations

### 🟢 Already Implemented (v5.2.0)
- Phase 0.5 — Clarification & Plan & Structural Alignment
- Phase 3d — Security AUTO Shield
- Phase 4d — Self-Learning Guardrails (5 guardrail)

### 🟡 Next Candidates for Elysium

| Priority | Feature | Impact | Complexity |
|----------|---------|--------|------------|
| 1 | **Shared Interface Contracts** (Phase 1c) | Elimina 90% dei bug di integrazione tra subagenti paralleli | Bassa (~50 righe) |
| 2 | **Context Window Protection** (Phase 3e) | Previene death spiral su Tier 3-4 con 50+ subagenti | Media (~80 righe) |
| 3 | **Convergence-Based Retry Limits** (Phase 6c) | Smarter retry: ferma se peggiora, cambia strategia se stalla | Bassa (~40 righe) |
| 4 | **Dynamic Knowledge Expansion** (Phase 4g) | Pattern discovery automatico post 3+ retry | Media (~100 righe) |
| 5 | **Familiarity Factor** (Dynamic Allocation) | Riduce subagenti su codebase conosciuto | Bassa (~30 righe) |
| 6 | **Adaptive Threshold Tuning** (Phase 3c) | Regola granularità decomposizione in base a FPR | Media (~60 righe) |

### 🔴 Deferred (when Elysium needs a major version)
- Parallel Sandbox Racing (require worktree isolation)
- Actor-Critic Escalation (require semantic analysis)
- Long Session Management (require session_manager.py)
- Skill Ecosystem Integration (require multiple complementary skills)

## Key Insight

Prometheus Engine is **more defensive** (security, guardrail, context protection), while Elysium Swarmloop is **more streamlined** (480→720 lines vs 2378). The gap is intentional — Elysium prefers lean execution with targeted protection, Prometheus prefers comprehensive safety nets. The v5.2.0 additions bring the critical safety features without ballooning the skill size.
