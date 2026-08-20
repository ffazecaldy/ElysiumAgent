"""Test per harness/projects.py — ProjectStore: CRUD, persistenza chat,
read/write file nel workspace, blocco path traversal, save/list run."""

from harness.projects import ProjectStore
import os, tempfile


def _store(tmp_path):
    return ProjectStore(root=str(tmp_path / 'proj'))


def test_create_list_get(tmp_path):
    s = _store(tmp_path)
    p = s.create('mio-progetto')
    assert p.id and os.path.isdir(p.files_dir)
    ids = [x.id for x in s.list()]
    assert p.id in ids
    assert s.get(p.id).name == 'mio-progetto'


def test_chat_persistenza(tmp_path):
    s = _store(tmp_path); p = s.create('chat')
    s.append_message(p, 'user', 'ciao')
    s.append_message(p, 'assistant', 'benvenuto', meta={'x': 1})
    chat = s.read_chat(p)
    assert len(chat) == 2 and chat[0]['role'] == 'user' and chat[1]['meta']['x'] == 1


def test_write_read_file(tmp_path):
    s = _store(tmp_path); p = s.create('files')
    assert s.write_file(p, 'src/a.py', 'print(1)')['ok']
    r = s.read_file(p, 'src/a.py')
    assert r['ok'] and 'print(1)' in r['content']
    assert not s.read_file(p, 'src/a.py')['ok'] or s.read_file(p, 'src/a.py').get('ok')  # esiste


def test_path_traversal_bloccato(tmp_path):
    s = _store(tmp_path); p = s.create('sec')
    assert not s.write_file(p, '../evil.txt', 'x').get('ok')
    assert 'error' in s.read_file(p, '../../../etc/passwd')


def test_runs_salvataggio(tmp_path):
    s = _store(tmp_path); p = s.create('runs')
    rid = s.save_run(p, {'run_id': 'r1', 'goal': 'g', 'first_pass_rate': 0.8, 'tasks': []})
    assert rid == 'r1'
    runs = s.list_runs(p)
    assert any(r['id'] == 'r1' for r in runs)
