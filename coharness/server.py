"""CoHarness serves a local source map and versioned alignment records."""

import argparse
import ast
import difflib
import hashlib
import json
import re
import secrets
import sqlite3
import subprocess
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from workspace import Workspace, list_directories, source_description, MAX_TOTAL_BYTES, MAX_FILES
from workflow import git_state, workflow_state, save_task, pause_task, restore_task, commit_history, commit_info, commit_files
from reading import reading_guide

ROOT = Path(__file__).resolve().parents[1]


def digest(content):
    """系统计算快照标识。"""
    return hashlib.sha256(content.encode()).hexdigest()


def javascript_parameter_count(parameters):
    """系统统计简单声明中的顶层参数。复杂语法保留未知状态。"""
    if not parameters.strip():
        return 0
    stack, quote, escaped, count = [], None, False, 1
    for char in parameters:
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char in '`/':
            return None
        elif char in '([{':
            stack.append(char)
        elif char in ')]}':
            if not stack or stack.pop() != {')': '(', ']': '[', '}': '{'}[char]:
                return None
        elif char == ',' and not stack:
            count += 1
    if quote or stack:
        return None
    return count - int(parameters.rstrip().endswith(','))


def symbols_for(path, source):
    """系统定位 Python 定义与顶层 JavaScript 函数。"""
    lines = source.splitlines()
    symbols = []
    if path.endswith('.py'):
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                parameters = [a.arg for a in [*node.args.posonlyargs, *node.args.args]]
                if node.args.vararg:
                    parameters.append('*' + node.args.vararg.arg)
                parameters.extend(a.arg for a in node.args.kwonlyargs)
                if node.args.kwarg:
                    parameters.append('**' + node.args.kwarg.arg)
                symbols.append({'name': node.name, 'start': node.lineno, 'end': node.end_lineno,
                                'description': ast.get_docstring(node) or '该函数的职责需要结合代码确认。',
                                'parameters': ', '.join(parameters), 'parameterCount': len(parameters)})
    elif path.endswith('.js'):
        matches = list(re.finditer(r'^(?:async )?function (\w+)\(([^\n]*)\) \{', source, re.M))
        for index, match in enumerate(matches):
            start = source[:match.start()].count('\n') + 1
            end = source[:matches[index + 1].start()].count('\n') if index + 1 < len(matches) else len(lines)
            while end > start and (not lines[end - 1].strip() or lines[end - 1].startswith('//')):
                end -= 1
            description = lines[start - 2].removeprefix('// ').strip() if start > 1 and lines[start - 2].startswith('//') else '请结合代码查看该函数的职责。'
            symbols.append({'name': match[1], 'start': start, 'end': end,
                            'description': description, 'parameters': match[2],
                            'parameterCount': javascript_parameter_count(match[2])})
    for symbol in symbols:
        symbol.update(path=path, id=f'{path}::{symbol["name"]}:{symbol["start"]}',
                      code='\n'.join(lines[symbol['start'] - 1:symbol['end']]))
    return sorted(symbols, key=lambda item: item['start'])


def changes_for(before, after, symbols):
    """系统将实际差异组织为可选择的修改项。"""
    old, new = before.splitlines(), after.splitlines()
    changes = []
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=False)
    if not before and after:
        starts = sorted({1, *(s['start'] for s in symbols)})
        ranges = [(start, starts[i + 1] - 1 if i + 1 < len(starts) else len(new)) for i, start in enumerate(starts)]
        for start, end in ranges:
            symbol = next((s for s in symbols if s['start'] == start), None)
            changes.append({'title': symbol['description'] if symbol else '系统新增该文件的基础内容。',
                            'start': start, 'end': end, 'oldStart': 1, 'oldEnd': 0,
                            'symbolId': symbol['id'] if symbol else None})
    else:
        for group in matcher.get_grouped_opcodes(3):
            start, end = group[0][3] + 1, group[-1][4]
            symbol = next((s for s in symbols if s['start'] <= start <= s['end']), None)
            changes.append({'title': symbol['description'] if symbol else '系统更新该范围内的文件内容。',
                            'start': start, 'end': end, 'oldStart': group[0][1] + 1, 'oldEnd': group[-1][2],
                            'symbolId': symbol['id'] if symbol else None})
    for i, change in enumerate(changes):
        change['id'] = f'change-{i + 1}'
    return changes


def connect_calls(symbols):
    """系统建立可追溯到源码行的同文件调用候选。"""
    for symbol in symbols:
        calls = []
        for offset, line in enumerate(symbol['code'].splitlines()[1:], 1):
            for target in symbols:
                if target['path'] != symbol['path'] or target['id'] == symbol['id']:
                    continue
                if re.search(r'\b' + re.escape(target['name']) + r'\s*\(', line):
                    calls.append({'target': target['id'], 'line': symbol['start'] + offset, 'expression': line.strip()})
        symbol['calls'] = calls
    for symbol in symbols:
        symbol['callers'] = [{'target': caller['id'], 'line': call['line'], 'expression': call['expression']}
                             for caller in symbols for call in caller['calls'] if call['target'] == symbol['id']]


class Store:
    """系统通过 SQLite 保存 KV 投影和操作记录。"""

    def __init__(self, path):
        """系统初始化本地存储。"""
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time TEXT, kind TEXT, data TEXT)')

    @contextmanager
    def db(self):
        """系统在操作完成后关闭数据库连接。"""
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def values(self):
        """系统读取当前 KV 投影。"""
        with self.db() as db:
            return {key: json.loads(value) for key, value in db.execute('SELECT key,value FROM kv')}

    def get(self, key):
        """系统读取指定任务记录。"""
        with self.db() as db:
            row = db.execute('SELECT value FROM kv WHERE key=?', (key,)).fetchone()
            return json.loads(row[0]) if row else None

    def put(self, key, value, kind):
        """系统同时保存记录和事件。"""
        with self.lock, self.db() as db:
            db.execute('INSERT OR REPLACE INTO kv VALUES (?,?)', (key, json.dumps(value, ensure_ascii=False)))
            db.execute('INSERT INTO events(time,kind,data) VALUES (?,?,?)',
                       (datetime.now(timezone.utc).isoformat(), kind, json.dumps(value, ensure_ascii=False)))

    def events(self):
        """系统读取最近的真实服务操作。"""
        with self.db() as db:
            return [{'id': i, 'time': t, 'kind': k, 'data': json.loads(d)} for i, t, k, d in
                    db.execute('SELECT id,time,kind,data FROM events ORDER BY id DESC LIMIT 150')]


def snapshot(workspace, commit=None):
    """系统根据当前工作区生成通用文件地图。"""
    store = workspace.store
    files, all_symbols = [], []
    with store.lock:
        values = store.values()
        review = commit_info(workspace, commit) if commit else None
        historical = {}
        git = git_state(workspace)
        kinds = {item['path']: item['kind'] for item in git['changes']}
        if review:
            items, notices = commit_files(workspace, review)
            historical = {item['path']: item for item in items}
            head, entries, paths = review['id'], {}, list(historical)
            kinds = {item['path']: item['kind'] for item in items}
        else:
            head, entries, all_paths, notices = workspace.inventory(priority=kinds, limit=None)
            paths = all_paths[:MAX_FILES]
            if len(all_paths) > MAX_FILES:
                notices.append(f'目录索引包含 {len(all_paths)} 个文件。系统预载前 {MAX_FILES} 个文件，其余正文按需读取。')
        remaining = MAX_TOTAL_BYTES
        for path in paths:
            file = historical[path] if review else workspace.read_file(path, entries.get(path), remaining)
            remaining -= file.pop('consumed')
            file['kind'] = kinds.get(path, '未修改')
            if file['kind'] == '未修改' and file['previewable']:
                file['before'] = file['after']
            symbols = symbols_for(path, file['after']) if file['previewable'] else []
            label, description, source = source_description(path, file['after'])
            file.update(label=label, description=description, descriptionSource=source,
                        purpose='修改目的待共同说明。系统尚未接入模型执行记录。', symbols=symbols,
                        changes=changes_for(file['before'], file['after'], symbols) if file['previewable'] and file['kind'] != '未修改' else [])
            if file['kind'] != '未修改' and file['previewable'] and not file['changes']:
                file['changes'] = [{'id': 'change-1', 'title': '文件存在状态发生变化。', 'start': 1,
                                    'end': 0, 'oldStart': 1, 'oldEnd': 0, 'symbolId': None}]
            opcodes = difflib.SequenceMatcher(None, file['before'].splitlines(), file['after'].splitlines(), autojunk=False).get_opcodes()
            file['addedLines'] = [line for tag, _, _, start, end in opcodes if tag != 'equal' for line in range(start + 1, end + 1)]
            file['removedLines'] = [line for tag, start, end, _, _ in opcodes if tag != 'equal' for line in range(start + 1, end + 1)]
            files.append(file)
            all_symbols.extend(symbols)
            previous = values.get('map:' + path)
            if not review and (previous is None or previous['version'] != file['version']):
                store.put('map:' + path, {'path': path, 'version': file['version'],
                          'previousVersion': previous['version'] if previous else None,
                          'description': description, 'source': source},
                          '文件快照更新' if previous else '文件快照建立')
        connect_calls(all_symbols)
        directories = {}
        for file in files:
            parts = file['path'].split('/')
            for i in range(len(parts)):
                directory = '/'.join(parts[:i])
                directories.setdefault(directory, {'count': 0, 'changed': 0})
                directories[directory]['count'] += 1
                directories[directory]['changed'] += file['kind'] != '未修改'
        directories = {path: f'包含 {item["count"]} 个文件，其中 {item["changed"]} 个存在变化。目录职责待生成。'
                       for path, item in directories.items()}
        project_version = digest(json.dumps([workspace.id, head, review['parent'] if review else git['token'], [(f['path'], f['version'], f['kind']) for f in files]]))
        return {'files': files, 'index': [{'path': path, 'kind': kinds.get(path, '未修改')} for path in (paths if review else all_paths)],
                'directories': directories, 'symbols': all_symbols, 'basis': project_version,
                'records': {k: v for k, v in store.values().items() if k.startswith('alignment:') and v.get('commit') == commit},
                'events': [{**event, 'data': {key: value for key, value in event['data'].items() if key != 'content'}} for event in store.events()],
                'baseline': (review['parent'][:12] if review['parent'] else '空目录') if review else 'Git HEAD' if head else '尚无已对齐提交', 'head': head, 'review': review,
                'project': workspace.root.name, 'root': str(workspace.root), 'workspaceId': workspace.id,
                'gitRoot': str(workspace.git_root), 'notices': notices, 'git': git,
                'workflow': workflow_state(workspace)}


def save_alignment(workspace, payload):
    """系统将人的预期绑定到提交时的源文件快照。"""
    path = payload.get('path')
    store = workspace.store
    if payload.get('workspaceId') != workspace.id:
        raise ValueError('工作区已经切换。请重新打开目标文件。')
    expectation = payload.get('expectation', '')
    if not isinstance(expectation, str) or not expectation.strip() or len(expectation) > 12000:
        raise ValueError('请输入不超过 12000 字的预期修改效果。')
    with store.lock:
        current = snapshot(workspace, payload.get('commit'))
        file = next((f for f in current['files'] if f['path'] == path), None)
        if not file:
            raise ValueError('系统未找到目标文件。')
        if payload.get('version') != file['version'] or payload.get('basis') != current['basis']:
            raise ValueError('源文件已变化。请刷新修改地图后继续对齐。')
        if payload.get('change') not in [c['id'] for c in file['changes']]:
            raise ValueError('系统未找到目标修改项。')
        status = payload.get('status', '讨论中')
        if status not in ('讨论中', '已对齐'):
            raise ValueError('系统不支持该对齐状态。')
        value = {key: payload[key] for key in ('workspaceId', 'path', 'version', 'basis', 'change')}
        value.update(commit=payload.get('commit'), expectation=expectation.strip(), status=status, time=datetime.now(timezone.utc).isoformat(),
                     verification='待验证', author='用户')
        key = f'alignment:{path}:{current["basis"]}:{payload["change"]}'
        store.put(key, value, '用户确认预期' if status == '已对齐' else '用户提交预期')
        return value


class WorkspaceManager:
    """系统按工作区标识隔离文件和本地记录。"""

    def __init__(self, root, state_dir):
        self.state_dir = Path(state_dir)
        self.lock = threading.RLock()
        self.open(root)

    def open(self, path):
        """系统打开用户选定的目录。"""
        with self.lock:
            workspace = Workspace(path)
            workspace.store = Store(self.state_dir / f'{workspace.id}.sqlite3')
            self.current = workspace
            return workspace


def make_handler(manager, token):
    """系统创建只服务本地页面的请求处理器。"""
    class Handler(BaseHTTPRequestHandler):
        def send(self, status, body, content_type='application/json; charset=utf-8'):
            data = json.dumps(body, ensure_ascii=False).encode() if isinstance(body, dict) else body
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_GET(self):
            if not self.allowed():
                return self.send(403, {'error': '请求地址不匹配。'})
            route = urlsplit(self.path).path
            if route == '/api/snapshot':
                try:
                    with manager.lock:
                        return self.send(200, {**snapshot(manager.current), 'token': token})
                except (ValueError, OSError, subprocess.TimeoutExpired) as error:
                    return self.send(409, {'error': str(error)})
            assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/reading.js': ('reading.js', 'text/javascript'), '/workflow.js': ('workflow.js', 'text/javascript'), '/spaces.js': ('spaces.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            if route in assets:
                name, mime = assets[route]
                return self.send(200, (ROOT / 'coharness/web' / name).read_bytes(), mime + '; charset=utf-8')
            return self.send(404, {'error': '系统未找到该页面。'})

        def do_POST(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if not self.allowed() or self.headers.get('Origin') != origin or self.headers.get('X-CoHarness-Token') != token:
                return self.send(403, {'error': '请求来源不匹配。'})
            if self.path not in ('/api/alignment', '/api/workspace/open', '/api/directories', '/api/file/save', '/api/file/read', '/api/reading',
                                 '/api/task/save', '/api/task/pause', '/api/task/restore', '/api/history', '/api/history/detail'):
                return self.send(404, {'error': '系统未找到该接口。'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4 * 1024 * 1024:
                    raise ValueError('提交内容长度不符合要求。')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError('提交内容格式不符合要求。')
                with manager.lock:
                    if self.path == '/api/directories':
                        result = list_directories(data.get('path') or str(manager.current.root))
                    elif self.path == '/api/workspace/open':
                        if not isinstance(data.get('path'), str) or not data['path'].strip():
                            raise ValueError('请输入目录路径。')
                        manager.open(data['path'])
                        result = {'workspaceId': manager.current.id}
                    elif self.path == '/api/file/save':
                        result = manager.current.save_file(data)
                    elif self.path == '/api/file/read':
                        result = manager.current.read_page(data)
                    elif self.path == '/api/reading':
                        if data.get('workspaceId') != manager.current.id:
                            raise ValueError('工作区已经切换。请刷新页面。')
                        result = reading_guide(manager.current)
                    elif self.path.startswith('/api/task/'):
                        action = {'/api/task/save': save_task, '/api/task/pause': pause_task, '/api/task/restore': restore_task}[self.path]
                        result = action(manager.current, data)
                    elif self.path.startswith('/api/history'):
                        if data.get('workspaceId') != manager.current.id:
                            raise ValueError('工作区已经切换。请刷新页面。')
                        result = commit_history(manager.current, data.get('skip', 0)) if self.path == '/api/history' else snapshot(manager.current, data.get('commit'))
                    else:
                        result = save_alignment(manager.current, data)
                    return self.send(200, result)
            except (ValueError, TypeError, OSError, subprocess.TimeoutExpired) as error:
                return self.send(409, {'error': str(error)})

        def log_message(self, *args):
            pass
    return Handler


def main():
    """系统启动 CoHarness 本地页面。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--workspace', type=Path, default=Path.cwd())
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.coharness/workspaces')
    args = parser.parse_args()
    manager = WorkspaceManager(args.workspace, args.state_dir)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(manager, secrets.token_urlsafe(32)))
    print(f'CoHarness: http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
