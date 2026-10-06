"""Workspace discovery uses Git and reads ordinary local project files."""

import hashlib
import os
import stat
import subprocess
import tempfile
from pathlib import Path, PurePosixPath

MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_FILES = 1000
EXCLUDED = {'.git', '.coharness', '.codex', '.agents', 'node_modules', '__pycache__', '.venv', 'venv'}


def run_git(root, *arguments, check=True):
    """系统通过参数数组调用 Git。"""
    result = subprocess.run(['git', '-C', str(root), *arguments], capture_output=True, timeout=20)
    if check and result.returncode:
        raise ValueError(result.stderr.decode(errors='replace').strip() or 'Git 未能完成操作。')
    return result


def content_version(content, exists=True):
    """系统将文件存在状态纳入内容版本。"""
    return hashlib.sha256((b'file\0' if exists else b'missing\0') + content).hexdigest()


def safe_path(root, relative):
    """系统拒绝目录越界、链接和内部元数据路径。"""
    if not isinstance(relative, str) or not relative or '\x00' in relative:
        raise ValueError('文件路径无效。')
    parts = PurePosixPath(relative).parts
    if relative.startswith('/') or '..' in parts or any(part in EXCLUDED for part in parts):
        raise ValueError('文件路径超出工作区范围。')
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise ValueError('系统不跟随符号链接。')
    if not target.resolve().is_relative_to(root):
        raise ValueError('文件路径超出工作区范围。')
    return target


def decode_text(data):
    """系统仅将有界 UTF-8 内容交给文本编辑器。"""
    if len(data) > MAX_FILE_BYTES:
        return None, '文件超过 512 KiB，当前仅显示文件信息。'
    if b'\0' in data:
        return None, '该文件包含二进制内容。'
    try:
        return data.decode('utf-8'), ''
    except UnicodeDecodeError:
        return None, '该文件使用非 UTF-8 编码，当前仅显示文件信息。'


def source_description(path, source):
    """系统引用文件开头的说明，并注明提取来源。"""
    suffix = Path(path).suffix.lower()
    label = {'.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript', '.html': 'HTML',
             '.css': 'CSS', '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML'}.get(suffix, suffix.lstrip('.').upper() or '文本')
    if source:
        stripped = source.lstrip()
        first = stripped.splitlines()[0]
        if first.startswith(('//', '# ', '/*', '"""', "'''", '<!--')):
            summary = first.strip('/#*\"\'<>!- ').strip()
            if summary:
                return label, summary[:220], '文件首部说明'
    return label, '职责说明待生成。你可以直接阅读实际文件内容。', '尚未生成职责说明'


class Workspace:
    """工作区通过 Git 建立文件清单和比较基准。"""

    def __init__(self, root, initialize=True):
        self.root = Path(root).expanduser().resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError('请选择一个目录。')
        result = run_git(self.root, 'rev-parse', '--show-toplevel', check=False)
        if result.returncode:
            if not initialize:
                raise ValueError('该目录尚未建立 Git 仓库。')
            run_git(self.root, 'init', '--quiet')
            result = run_git(self.root, 'rev-parse', '--show-toplevel')
        self.git_root = Path(result.stdout.decode().strip()).resolve()
        self.prefix = self.root.relative_to(self.git_root).as_posix()
        self.prefix = '' if self.prefix == '.' else self.prefix + '/'
        self.id = hashlib.sha256(str(self.root).encode()).hexdigest()[:20]
        self.blobs = {}
        self.store = None

    def inventory(self):
        """系统合并 Git 基准文件和当前工作目录文件。"""
        result = run_git(self.root, 'rev-parse', '--verify', 'HEAD', check=False)
        head = result.stdout.decode().strip() if result.returncode == 0 else None
        entries = {}
        if head:
            args = ['ls-tree', '-r', '-z', '-l', head]
            if self.prefix:
                args += ['--', self.prefix]
            for row in run_git(self.git_root, *args).stdout.split(b'\0'):
                if not row:
                    continue
                info, name = row.split(b'\t', 1)
                mode, kind, oid, size = info.split()
                path = name.decode(errors='surrogateescape')[len(self.prefix):]
                entries[path] = {'oid': oid.decode(), 'size': int(size) if size != b'-' else 0,
                                 'mode': mode.decode(), 'type': kind.decode()}
        names = run_git(self.root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.').stdout
        paths = set(entries) | {name.decode(errors='surrogateescape') for name in names.split(b'\0') if name}
        paths = sorted(path for path in paths if not any(part in EXCLUDED for part in PurePosixPath(path).parts))
        notice = [f'当前仅展示前 {MAX_FILES} 个文件。'] if len(paths) > MAX_FILES else []
        return head, entries, paths[:MAX_FILES], notice

    def read_file(self, path, entry=None, remaining=MAX_TOTAL_BYTES):
        """系统读取工作内容和对应的 Git 对象。"""
        try:
            target = safe_path(self.root, path)
            exists = target.exists()
            if exists and not stat.S_ISREG(target.stat().st_mode):
                raise ValueError('该项目项不是普通文件。')
            if entry and (entry['mode'] == '120000' or entry['type'] != 'blob'):
                raise ValueError('链接或子模块需要专门的查看器。')
            size = target.stat().st_size if exists else 0
            if size > MAX_FILE_BYTES or (entry and entry['size'] > MAX_FILE_BYTES):
                raise ValueError('文件超过 512 KiB，当前仅显示文件信息。')
            if size + (entry['size'] if entry else 0) > remaining:
                raise ValueError('本次文本预览已达到 8 MiB 上限。')
            after_bytes = target.read_bytes() if exists else b''
            before_bytes = b''
            if entry:
                if entry['oid'] not in self.blobs:
                    self.blobs[entry['oid']] = run_git(self.git_root, 'cat-file', 'blob', entry['oid']).stdout
                before_bytes = self.blobs[entry['oid']]
            after, error = decode_text(after_bytes)
            before, old_error = decode_text(before_bytes)
            editable = not error and not old_error and exists
            kind = '新增' if not entry and exists else '删除' if entry and not exists else '修改' if before_bytes != after_bytes else '未修改'
            return {'path': path, 'after': after or '', 'before': before or '',
                    'exists': exists, 'baseExists': bool(entry), 'kind': kind, 'editable': bool(editable),
                    'previewable': not error and not old_error, 'notice': error or old_error,
                    'version': content_version(after_bytes, exists), 'size': size,
                    'consumed': len(after_bytes) + len(before_bytes)}
        except (ValueError, OSError) as error:
            return {'path': path, 'before': '', 'after': '', 'exists': False, 'baseExists': bool(entry),
                    'editable': False, 'previewable': False, 'kind': '未解析', 'notice': str(error),
                    'version': content_version(str(error).encode()), 'size': 0, 'consumed': 0}

    def save_file(self, payload):
        """系统保存编辑内容和独立工作快照，不创建 Git 提交。"""
        if payload.get('workspaceId') != self.id:
            raise ValueError('工作区已经切换。请重新打开目标文件。')
        path, text = payload.get('path'), payload.get('content')
        if not isinstance(text, str) or len(text.encode()) > MAX_FILE_BYTES:
            raise ValueError('编辑器仅支持不超过 512 KiB 的 UTF-8 文本。')
        with self.store.lock:
            _, entries, paths, _ = self.inventory()
            if path not in paths:
                raise ValueError('该文件已移出工作区清单。')
            current = self.read_file(path, entries.get(path))
            if not current['editable']:
                raise ValueError(current['notice'] or '当前文件无法编辑。')
            if current['version'] != payload.get('version'):
                raise ValueError('磁盘文件已经变化。编辑草稿已保留，请重新读取后合并。')
            target = safe_path(self.root, path)
            before = target.read_bytes()
            self.store.put(f'working:{path}:{current["version"]}',
                           {'path': path, 'version': current['version'], 'content': before.decode(), 'workspaceId': self.id}, '编辑前快照保存')
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.coharness-edit-', delete=False) as output:
                    temporary = Path(output.name)
                    output.write(text.encode())
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, stat.S_IMODE(target.stat().st_mode))
                if safe_path(self.root, path).read_bytes() != before:
                    raise ValueError('保存期间磁盘文件发生变化。请重新读取后合并。')
                os.replace(temporary, target)
            finally:
                if temporary and temporary.exists():
                    temporary.unlink()
            value = {'workspaceId': self.id, 'path': path, 'version': content_version(text.encode()),
                     'previousVersion': current['version'], 'content': text}
            self.store.put(f'working:{path}:{value["version"]}', value, '用户保存工作快照')
            return {'version': value['version'], 'path': path}


def list_directories(path):
    """系统列出用户正在浏览的本地目录。"""
    target = Path(path).expanduser().resolve(strict=True)
    if not target.is_dir():
        raise ValueError('请选择一个目录。')
    children = []
    for child in sorted(target.iterdir(), key=lambda item: item.name.lower()):
        if not child.name.startswith('.') and child.is_dir() and not child.is_symlink():
            children.append({'name': child.name, 'path': str(child)})
    return {'path': str(target), 'parent': str(target.parent), 'directories': children}
