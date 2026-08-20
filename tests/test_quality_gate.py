from engine.result_parser import parse_result
from engine.quality_gate import apply_penalties
from engine.security_shield import scan


def test_parse_self_score():
    txt = "## RESULT\n- task_id: t1\n- status: pass\n- quality_score: 8/10"
    r = parse_result(txt)
    assert r["task_id"] == "t1" and r["quality_score"] == 8.0


def test_parse_score_sloppy():
    # il modello scrive in formati diversi
    assert parse_result("score: 7/10, id=t1")["quality_score"] == 7.0


def test_stub_cap_non_azzeramento():
    assert apply_penalties(8.0, has_stubs=True, security_issues=[]) == 3.0
    assert apply_penalties(2.5, has_stubs=True, security_issues=[]) == 2.5


def test_security_blocco_secco():
    assert apply_penalties(9.0, False, security_issues=["CRIT"]) == 0.0


def test_hardcoded_secret_bloccato():
    issues = scan('API_KEY = "sk-abcdefgh123456"')
    assert any(i.severity == "CRITICAL" for i in issues)


def test_fstring_sql_bloccato():
    assert any("SQL" in i.id for i in scan('q = f"SELECT * FROM u WHERE id={uid}"'))
