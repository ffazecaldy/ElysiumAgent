from harness.chat import wants_loop, build_messages
from harness.projects import ProjectStore
from harness.chat import ChatAgent


class FakeStream:
    async def stream(self, messages, max_tokens=None):
        for w in ['ciao', ' ', 'mondo']:
            yield w

    async def complete(self, messages, max_tokens=None):
        return {'choices': [{'message': {'content': 'x'}}]}


def test_wants_loop_tier1_falso():
    assert wants_loop('fixa un typo in utils.py') is False


def test_wants_loop_tier3_vero():
    assert wants_loop('refactor sistema auth con API e test su 8 file') is True


def test_wants_loop_forzato():
    assert wants_loop('attiva elysium: ordina i file') is True


def test_build_messages_inietta_sistema():
    msgs = build_messages([{'role': 'user', 'content': 'x'}], system='SYS')
    assert msgs[0]['role'] == 'system' and msgs[0]['content'] == 'SYS'
    assert msgs[-1]['role'] == 'user'


def test_build_messages_compatta_report():
    chat = [{'role': 'user', 'content': 'g', 'meta': {'run_report': {'final_status': 'completed', 'first_pass_rate': 0.8, 'avg_quality': 8.0, 'n_tasks': 3, 'files_written': [{'path': 'a.py'}]}}}]
    out = build_messages(chat)
    assert 'completed' in out[-1]['content']


async def test_agent_stream_diretto(tmp_path):
    s = ProjectStore(root=str(tmp_path)); p = s.create('p')
    ag = ChatAgent(FakeStream(), p, s)
    evs = []
    async for e in ag.respond_stream('fixa un typo in utils.py'):
        evs.append(e)
    types = [e['type'] for e in evs]
    assert 'chunk' in types and 'done' in types
    assert 'loop' not in types
    assert len(s.read_chat(p)) == 2  # user + assistant
