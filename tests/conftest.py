"""tests/conftest.py — fixture pytest condivise per i test dell'harness.

Fornisce un ProjectStore temporaneo (montato su tmp_path, quindi autopulito
dal framework) e un progetto già creato, così i test non toccano mai il
workspace reale su disco (projects/).

Nota: pytest.ini ha `asyncio_mode = auto`, quindi le fixture async funzionano
senza decoratori @pytest_asyncio.fixture espliciti.
"""

import pytest

from harness.projects import ProjectStore


@pytest.fixture
async def progetti_store(tmp_path):
    """ProjectStore temporaneo su tmp_path (root isolata dal workspace reale)."""
    return ProjectStore(root=str(tmp_path))


@pytest.fixture
async def progetto(tmp_path):
    """Tuple (store, project): store temporaneo con un progetto 'test' creato.

    s.create() è sincrono; la fixture è async solo per dimostrare che
    l'harness regge fixture async in asyncio_mode=auto.
    """
    s = ProjectStore(root=str(tmp_path))
    p = s.create("test")
    return (s, p)
