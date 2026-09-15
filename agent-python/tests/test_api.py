import time, json
from fastapi.testclient import TestClient
from api.main import app

def test_projects_crud_e_chat():
    with TestClient(app) as c:
        r = c.post('/api/projects', json={'name': 'demo'})
        assert r.status_code == 201
        pid = r.json()['id']
        assert c.get('/api/projects').json()['projects']
        assert c.get(f'/api/projects/{pid}/chat').status_code == 200
        assert c.get(f'/api/projects/{pid}/files').status_code == 200
        assert c.get(f'/api/projects/{pid}/runs').status_code == 200
        # delete
        assert c.delete(f'/api/projects/{pid}').status_code == 204

def test_404_progetto_inesistente():
    with TestClient(app) as c:
        assert c.get('/api/projects/nope').status_code == 404
        assert c.get('/api/projects/nope/chat').status_code == 404

def test_chat_sse_errore_quota_prima_di_LLM():
    # senza API key reale nel processo test, la chat deve restituire evento errore, non crash
    import os
    os.environ['OPTIMIZE_ENGINE_API_KEY'] = ''
    os.environ['OPENCODE_GO_API_KEY'] = ''
    with TestClient(app) as c:
        pid = c.post('/api/projects', json={'name': 'se'}).json()['id']
        with c.stream('POST', f'/api/projects/{pid}/chat', json={'message': 'fixa un typo'}) as resp:
            body = resp.read().decode()
        assert 'data:' in body
        assert ('error' in body or 'done' in body)

def test_validazione_nome_obbligatorio():
    with TestClient(app) as c:
        assert c.post('/api/projects', json={'name': ''}).status_code == 422
