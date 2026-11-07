"""Run accepted Hermes root coordination transactions behind an A2A wire fixture."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import time
from urllib.parse import urlparse

from test_team import Store, fake_origin
from test_contracts import mission
from team_under_test import coordination, contracts
from plugins.platforms.a2a import protocol

port, home_text = int(sys.argv[1]), sys.argv[2]
from pathlib import Path
home = Path(home_text)
home.mkdir(parents=True, exist_ok=True)
cfg = {'role': 'coordinator', 'peers': {'peerb': {}, 'assistant': {}}}
(home / 'team.json').write_text(json.dumps(cfg))
store = Store(home)
scope = mission()
scope.update(resources=['public:news'], allowed_actions=['observe', 'analyze'], deadline=int(time.time()) + 300)
parent = store.submit('operator', 'root-child-fixture', {'peer': 'peerb', 'caller': 'coordinator', 'task': 'bounded work',
    'mission': scope, 'mutating': False, 'depends_on': [], 'origin': fake_origin(), 'allow_readonly_children': True})
assert store.claim(parent['id'])
store.update(parent['id'], status='working')
child_scope = {**scope, 'parent_task': parent['id']}
grants = {}
def reserve(name):
    reservation = {'parent_task': parent['id'], 'request_key': 'assistant-child-' + name, 'target': 'assistant',
                   'mission': child_scope, 'objective': 'Inspect public news evidence'}
    with store.db() as db:
        db.execute('BEGIN IMMEDIATE')
        return coordination.process(db, 'peerb', {'version': '1.0', 'action': 'reserve_child',
            'key': 'reserve-assistant-child-' + name, 'payload': reservation}, cfg, home)['data']['grant']

for name in ('first', 'second'):
    grants[name] = reserve(name)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in {'/.well-known/agent-card.json', '/.well-known/hermes-team-card.json'}:
            self.send_json(200, {'name': 'Pinned Hermes root', 'description': 'Hermes team root fixture', 'version': '1.0',
                'supportedInterfaces': [{'url': f'http://127.0.0.1:{port}/a2a/jsonrpc', 'protocolBinding': 'JSONRPC', 'protocolVersion': '1.0'}],
                'capabilities': {'streaming': False}, 'defaultInputModes': ['text/plain'], 'defaultOutputModes': ['application/json'],
                'skills': [{'id': 'coordination', 'name': 'Coordination', 'description': 'Pinned Hermes root control', 'tags': ['team']}],
                'metadata': {'hermesTeam': {'coordinationProtocolVersions': ['1.0']}}})
        elif path in {'/fixture/grant', '/fixture/grant/second', '/fixture/grant/third'}:
            if path.endswith('/third') and 'third' not in grants:
                grants['third'] = reserve('third')
            self.send_json(200, grants[path.rsplit('/', 1)[-1]] if path != '/fixture/grant' else grants['first'])
        elif path == '/fixture/status':
            requested = 'third' if 'child=third' in self.path else 'second' if 'child=second' in self.path else 'first'
            with store.db() as db:
                db.execute('BEGIN IMMEDIATE')
                status = coordination.process(db, 'assistant', {'version': '1.0', 'action': 'status_child',
                    'key': 'status-assistant-child-' + requested, 'payload': {'child_id': grants[requested]['child_id']}}, cfg, home)['data']
            self.send_json(200, status)
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/a2a/jsonrpc' or self.headers.get('Authorization') != 'Bearer coordinator-root-token-1234567890':
            self.send_json(401, {'error': 'unauthorized'})
            return
        raw = self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 65536))
        try:
            request = json.loads(raw)
            if request.get('method') != 'SendMessage':
                raise ValueError('Only SendMessage is supported')
            msg = request['params']['message']
            if msg.get('parts') != [{'text': 'HERMES_COORDINATION_CONTROL'}] or set(msg.get('metadata', {})) != {'hermesTeamControl'}:
                raise ValueError('Control framing differs: ' + json.dumps({'parts': msg.get('parts'), 'metadata_keys': list(msg.get('metadata', {}))}))
            control = msg['metadata']['hermesTeamControl']
            if control['action'] not in {'claim_child', 'settle_child'}:
                raise ValueError('Unsupported fixture control')
            with store.db() as db:
                db.execute('BEGIN IMMEDIATE')
                receipt = coordination.process(db, 'assistant', control, cfg, home)
            tasks = protocol.TaskStore()
            tasks.create('control-' + control['key'], msg['contextId'], 'assistant')
            tasks.complete('control-' + control['key'], protocol.STATE_COMPLETED, coordination.canonical(receipt))
            self.send_json(200, {'jsonrpc': '2.0', 'id': request['id'], 'result': protocol.TaskStore.to_task(tasks.get('control-' + control['key']))})
        except Exception as error:
            self.send_json(200, {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32602, 'message': str(error)}})


server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
print('READY', flush=True)
server.serve_forever()
