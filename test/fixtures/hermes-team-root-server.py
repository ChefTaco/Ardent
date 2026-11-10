"""Run independent reference root coordination transactions behind an A2A wire fixture."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import time
from urllib.parse import urlparse

from pathlib import Path
from team_reference import RootFixture, canonical
from plugins.platforms.a2a import protocol

port, home_text = int(sys.argv[1]), sys.argv[2]
home = Path(home_text)
home.mkdir(parents=True, exist_ok=True)
store = RootFixture(home)
grants = {name: store.reserve(name) for name in ('first', 'second')}


def reserve(name):
    return store.reserve(name)


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
            self.send_json(200, {'name': 'Reference team root', 'description': 'Hermes team root fixture', 'version': '1.0',
                'supportedInterfaces': [{'url': f'http://127.0.0.1:{port}/a2a/jsonrpc', 'protocolBinding': 'JSONRPC', 'protocolVersion': '1.0'}],
                'capabilities': {'streaming': False}, 'defaultInputModes': ['text/plain'], 'defaultOutputModes': ['application/json'],
                'skills': [{'id': 'coordination', 'name': 'Coordination', 'description': 'Reference team root control', 'tags': ['team']}],
                'metadata': {'hermesTeam': {'coordinationProtocolVersions': ['1.0']}}})
        elif path in {'/fixture/grant', '/fixture/grant/second', '/fixture/grant/third'}:
            if path.endswith('/third') and 'third' not in grants:
                grants['third'] = reserve('third')
            self.send_json(200, grants[path.rsplit('/', 1)[-1]] if path != '/fixture/grant' else grants['first'])
        elif path == '/fixture/status':
            requested = 'third' if 'child=third' in self.path else 'second' if 'child=second' in self.path else 'first'
            status = store.status(grants[requested]['child_id'])
            self.send_json(200, status)
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/a2a/jsonrpc' or self.headers.get('Authorization') != 'Bearer coordinator-root-token-1234567890':
            self.send_json(401, {'error': 'unauthorized'})
            return
        raw = self.rfile.read(min(int(self.headers.get('Content-Length', '0')), 65536))
        request = {}
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
            receipt = store.process(control)
            tasks = protocol.TaskStore()
            tasks.create('control-' + control['key'], msg['contextId'], 'assistant')
            tasks.complete('control-' + control['key'], protocol.STATE_COMPLETED, canonical(receipt))
            self.send_json(200, {'jsonrpc': '2.0', 'id': request['id'], 'result': protocol.TaskStore.to_task(tasks.get('control-' + control['key']))})
        except Exception as error:
            self.send_json(200, {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32602, 'message': str(error)}})


server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
print('READY', flush=True)
server.serve_forever()
