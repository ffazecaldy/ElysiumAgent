"""engine/budget.py — cap token/round, MAI prezzi $ inventati (pitfall #29).

Stima pre-flight (Phase 0.7a): planned_subagents × estimated_rounds × summary_cap.
Tracking token reali accumulati. Nessun prezzo in dollari (non noto all'agente).
"""
from __future__ import annotations


def estimate_tokens(subagents: int, rounds: int, summary_cap_tokens: int) -> int:
    """Stima conservativa dei token per la pre-flight cost check."""
    return int(subagents) * int(rounds) * int(summary_cap_tokens)


class BudgetTracker:
    """Traccia i token consumati e segnala quando si supera il cap."""

    def __init__(self, round_cap: int = 3, summary_cap_tokens: int = 1000,
                 tokens_per_round: int = 6000):
        self.round_cap = round_cap
        self.summary_cap_tokens = summary_cap_tokens
        # costo nominale massimo per round = builder(4000 max) + critic(2000 max)
        self.tokens_per_round = tokens_per_round
        self.tokens_used = 0

    def add_tokens(self, n: int) -> None:
        self.tokens_used += int(n)

    @property
    def estimate(self) -> int:
        """Cap totale del run = round × costo massimo nominale per round."""
        return int(self.round_cap) * int(self.tokens_per_round)

    def hit(self) -> bool:
        """True se i token usati superano il cap nominale del run."""
        return self.tokens_used > 0 and self.tokens_used >= self.estimate

    def remaining(self) -> int:
        return max(0, self.estimate - self.tokens_used)

    def as_dict(self) -> dict:
        return {
            "tokens_used": self.tokens_used,
            "cap_tokens": self.estimate,
            "remaining_tokens": self.remaining(),
        }
