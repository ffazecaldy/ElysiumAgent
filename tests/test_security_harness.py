"""tests/test_security_harness.py — il security_shield e il quality gate bloccano
secret hardcoded, SQL injection e stub prodotti dai worker dell'harness.

Integrazione dimostrata:
  - engine.security_shield.scan()  -> flagga secret/SQLi/pattern deprecati
  - engine.quality_gate.apply_penalties() -> blocco secco (0.0) su issue di
    sicurezza, cap a 3.0 sugli stub.
"""
from engine.quality_gate import apply_penalties
from engine.security_shield import scan


def test_secret_bloccato():
    iss = scan('API_KEY = "sk-abcdef123456"')
    assert any(i.severity == "CRITICAL" for i in iss)


def test_sql_injection():
    iss = scan('q = f"SELECT * FROM u WHERE id={uid}"')
    assert any("SQL" in i.id for i in iss)


def test_nessun_false_positive_env():
    iss = scan('API_KEY = os.getenv("API_KEY")')
    assert not any(i.id == "HARDCODED_SECRET" for i in iss)


def test_security_in_quality_gate():
    assert apply_penalties(9.0, False, security_issues=["CRIT"]) == 0.0


def test_stub_cap():
    assert apply_penalties(8.0, True, security_issues=[]) == 3.0
