import time

import pytest
from fastapi.testclient import TestClient

from api.main import app


@pytest.fixture
def client():
    # inietta componenti fake per non colpire LLM/barre reali nei test
    from api import factory
    factory.configure_for_tests()
    with TestClient(app) as c:
        yield c
    factory.reset_tests()


def test_crea_run_in_pending_confirmation(client):
    r = client.post("/runs", json={"goal": "ottimizza quicksort", "bar": "pytest",
                                   "max_rounds": 2})
    body = r.json()
    assert r.status_code == 200
    assert "id" in body
    # Phase 0.7a: stima token PRIMA di qualunque dispatch, mai $ inventati
    assert "estimate_tokens" in body
    assert body["status"] == "pending_confirmation"


def test_confirm_avvia_dispatch(client):
    rid = client.post("/runs", json={"goal": "refactor del modulo quicksort", "bar": "pytest",
                                     "max_rounds": 2}).json()["id"]
    r = client.post(f"/runs/{rid}/confirm")
    assert r.status_code == 200
    # il run parte in background: aspetta che esca da pending_confirmation
    for _ in range(50):
        s = client.get(f"/runs/{rid}").json()
        if s["status"] in ("running", "completed", "awaiting_approval", "failed"):
            break
        time.sleep(0.05)
    assert s["status"] in ("running", "awaiting_approval", "failed")


def test_tier_atomico_salta_il_loop(client):
    # Tier 1 -> fast-path: nessun dispatch, risposta immediata
    r = client.post("/runs", json={"goal": "fixa un typo in utils.py"}, )
    assert r.json()["status"] in ("pending_confirmation", "completed")


def test_continue_sblocca_checkpoint(client):
    # FakeBar perde sempre -> il run va in awaiting_approval
    rid = client.post("/runs", json={"goal": "refactor sistema auth con API e test su 8 file",
                                     "bar": "pytest", "max_rounds": 3}).json()["id"]
    client.post(f"/runs/{rid}/confirm")
    s = {}
    for _ in range(100):
        s = client.get(f"/runs/{rid}").json()
        if s["status"] == "awaiting_approval":
            break
        time.sleep(0.05)
    assert s["status"] == "awaiting_approval"
    r = client.post(f"/runs/{rid}/continue")
    assert r.status_code == 200
    s2 = client.get(f"/runs/{rid}").json()
    assert s2["status"] in ("running", "awaiting_approval", "completed")


def test_stop_ferma_run(client):
    rid = client.post("/runs", json={"goal": "refactor sistema auth con API e test su 8 file",
                                     "bar": "pytest", "max_rounds": 10}).json()["id"]
    client.post(f"/runs/{rid}/confirm")
    for _ in range(100):
        s = client.get(f"/runs/{rid}").json()
        if s["status"] in ("awaiting_approval", "running"):
            break
        time.sleep(0.05)
    r = client.post(f"/runs/{rid}/stop")
    assert r.status_code == 200
    # il loop esce pulito a fine round
    for _ in range(100):
        s = client.get(f"/runs/{rid}").json()
        if s["status"] == "stopped":
            break
        time.sleep(0.05)
    assert s["status"] == "stopped"


def test_events_queue_per_progress(client):
    rid = client.post("/runs", json={"goal": "ottimizza quicksort su 8 file",
                                     "bar": "pytest", "max_rounds": 3}).json()["id"]
    client.post(f"/runs/{rid}/confirm")
    ev = client.get(f"/runs/{rid}/events?timeout=3")
    assert ev.status_code == 200
    assert ev.json()["status"] in ("running", "awaiting_approval", "completed", "failed", "stopped")


def test_run_404():
    with TestClient(app) as c:
        r = c.get("/runs/inesistente")
        assert r.status_code == 404
