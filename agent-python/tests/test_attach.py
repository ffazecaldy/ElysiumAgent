"""tests/test_attach.py — collegamento progetti a cartelle esistenti (in-place)."""
import os

import pytest

from harness.projects import ProjectStore


def _store(tmp_path):
    return ProjectStore(root=str(tmp_path / "harness_root"))


def test_attach_cartella_esistente(tmp_path):
    folder = tmp_path / "repo_utente"
    folder.mkdir()
    (folder / "src.py").write_text("x = 1\n", encoding="utf-8")
    (folder / "README.md").write_text("# repo\n", encoding="utf-8")

    s = _store(tmp_path)
    p, err = s.attach("repo-utente", str(folder))
    assert err is None
    assert p.attached is True
    assert p.files_dir == str(folder)
    # file della cartella visibili nel workspace
    paths = {f["path"] for f in s.list_files(p)}
    assert "src.py" in paths and "README.md" in paths
    # metadata isolato: chat.json NON nella cartella utente
    assert not os.path.isdir(str(folder / "chat.json"))
    assert not os.path.isdir(str(folder / "runs"))


def test_attach_path_inesistente(tmp_path):
    s = _store(tmp_path)
    p, err = s.attach("x", str(tmp_path / "non-esiste"))
    assert p is None
    assert "non trovata" in err


def test_attach_file_non_directory(tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("", encoding="utf-8")
    s = _store(tmp_path)
    p, err = s.attach("x", str(f))
    assert p is None


def test_attach_vieta_cartella_interna_harness(tmp_path):
    s = _store(tmp_path)
    p, err = s.attach("x", str(tmp_path / "harness_root"))
    assert p is None
    assert "interna del harness" in err


def test_attach_delete_non_tocca_cartella_utente(tmp_path):
    folder = tmp_path / "repo_utente"
    folder.mkdir()
    (folder / "importante.py").write_text("keep = True\n", encoding="utf-8")

    s = _store(tmp_path)
    p, err = s.attach("repo", str(folder))
    assert err is None

    # delete del progetto NON deve rimuovere la cartella utente
    assert s.delete(p.id) is True
    assert folder.is_dir()
    assert (folder / "importante.py").read_text(encoding="utf-8") == "keep = True\n"


def test_attach_scrive_file_in_cartella_utente(tmp_path):
    folder = tmp_path / "repo_utente"
    folder.mkdir()
    s = _store(tmp_path)
    p, err = s.attach("repo", str(folder))
    assert err is None
    r = s.write_file(p, "nuovo.py", "print('ciao')\n")
    assert r.get("ok")
    assert (folder / "nuovo.py").read_text(encoding="utf-8") == "print('ciao')\n"


def test_attach_persistito_tra_store(tmp_path):
    folder = tmp_path / "repo_utente"
    folder.mkdir()
    (folder / "a.py").write_text("a=1", encoding="utf-8")
    s = _store(tmp_path)
    p, err = s.attach("repo", str(folder))
    assert err is None

    s2 = ProjectStore(root=str(tmp_path / "harness_root"))
    p2 = s2.get(p.id)
    assert p2 is not None
    assert p2.attached is True
    assert p2.files_dir == str(folder)
    assert any(f["path"] == "a.py" for f in s2.list_files(p2))


def test_attach_chat_isolata_da_cartella_utente(tmp_path):
    folder = tmp_path / "repo_utente"
    folder.mkdir()
    s = _store(tmp_path)
    p, _ = s.attach("repo", str(folder))
    s.append_message(p, "user", "ciao")
    # la chat vive nel metadata del harness, non nella cartella utente
    assert not (folder / "chat.json").exists()
    assert len(s.read_chat(p)) == 1
