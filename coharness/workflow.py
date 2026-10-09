"""系统通过现有 KV 存储衔接任务、Git 历史与暂存。"""

import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath

from workspace import run_git, EXCLUDED, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, decode_text


def git_state(workspace):
    """系统以 Git 状态判断整个所选目录的修改。"""
    result = run_git(workspace.root, 'rev-parse', '--verify', 'HEAD', check=False)
    head = result.stdout.decode().strip() if not result.returncode else None
    branch = run_git(workspace.root, 'symbolic-ref', '--short', '-q', 'HEAD', check=False).stdout.decode().strip()
    raw = run_git(workspace.git_root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', workspace.prefix or '.').stdout
    changes, stamps = [], []
    for row in raw.split(b'\0'):
        if not row:
            continue
        status, name = row[:2].decode(), row[3:].decode(errors='surrogateescape')
        path = name[len(workspace.prefix):]
        kind = '冲突' if 'U' in status or status in ('AA', 'DD') else '新增' if status == '??' or 'A' in status else '删除' if 'D' in status else '修改'
        changes.append({'path': path, 'status': status, 'kind': kind})
        try:
            info = (workspace.git_root / name).lstat()
            stamps.append((name, info.st_size, info.st_mtime_ns, info.st_ctime_ns))
        except OSError:
            stamps.append((name, None))
    index = run_git(workspace.git_root, 'diff', '--cached', '--raw', '--no-abbrev', '--', workspace.prefix or '.').stdout.decode(errors='replace') if changes else ''
    token = hashlib.sha256(json.dumps([head, branch, changes, stamps, index], ensure_ascii=True).encode()).hexdigest()
    return {'head': head, 'branch': branch or '分离 HEAD', 'clean': not changes, 'changes': changes,
            'conflicted': any(item['kind'] == '冲突' for item in changes), 'token': token,
            'canStash': workspace.root == workspace.git_root and bool(head)}


def workflow_state(workspace):
    """系统读取当前目录的任务状态。"""
    return workspace.store.get('workflow') or {'revision': 0, 'active': None, 'paused': []}


def checked_workflow(workspace, payload):
    """系统拒绝过期页面覆盖当前任务。"""
    if payload.get('workspaceId') != workspace.id:
        raise ValueError('工作区已经切换。请重新打开目标目录。')
    state = workflow_state(workspace)
    if payload.get('revision') != state['revision']:
        raise ValueError('任务状态已经变化。请刷新页面后重试。')
    return state


def persist(workspace, state, kind):
    """系统保存任务状态及对应事件。"""
    state['revision'] += 1
    workspace.store.put('workflow', state, kind)
    return state


def task_view(value):
    """系统限制审阅位置与草稿的保存大小。"""
    if not isinstance(value, dict) or len(json.dumps(value).encode()) > 180000:
        raise ValueError('任务阅读状态超过保存范围。')
    return value


def save_task(workspace, payload):
    """系统保存需求并恢复同目录未完成的任务。"""
    with workspace.store.lock:
        state = checked_workflow(workspace, payload)
        request = payload.get('request', '')
        if not isinstance(request, str) or len(request) > 12000:
            raise ValueError('需求内容超过保存范围。')
        task = state['active']
        if not task:
            if not request.strip():
                raise ValueError('请先输入你希望实现的功能。')
            task = {'id': uuid.uuid4().hex, 'created': datetime.now(timezone.utc).isoformat(), 'phase': '需求讨论'}
        task.update(request=request, view=task_view(payload.get('view', {})), updated=datetime.now(timezone.utc).isoformat())
        state['active'] = task
        return persist(workspace, state, '用户保存任务')


def stash_refs(workspace):
    """系统读取暂存对象的稳定编号。"""
    return set(run_git(workspace.git_root, 'stash', 'list', '--format=%H').stdout.decode().splitlines())


def pause_task(workspace, payload):
    """系统暂存整个仓库的已跟踪修改和新建文件。"""
    with workspace.store.lock:
        state = checked_workflow(workspace, payload)
        status = git_state(workspace)
        if payload.get('gitToken') != status['token']:
            raise ValueError('目录内容已经变化。请刷新后重新暂存。')
        if status['conflicted']:
            raise ValueError('目录存在冲突。请先处理冲突。')
        if not status['clean'] and not status['canStash']:
            raise ValueError('代码暂存需要打开已有提交的仓库根目录。')
        if state['active'] and state['active'].get('phase') in ('暂存处理中', '暂存待处理', '恢复处理中'):
            raise ValueError('上次任务操作尚未完成。请先检查任务记录和 Git 暂存。')
        if not status['clean']:
            for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'):
                path = run_git(workspace.git_root, 'rev-parse', '--git-path', name).stdout.decode().strip()
                if (workspace.git_root / path).exists():
                    raise ValueError('Git 正在合并或变基。请先完成该操作。')
            store_path = workspace.store.path.resolve()
            if store_path.is_relative_to(workspace.git_root):
                relative = store_path.relative_to(workspace.git_root).as_posix()
                if run_git(workspace.git_root, 'check-ignore', '--quiet', '--', relative, check=False).returncode:
                    raise ValueError('任务数据库位于暂存范围内。请将状态目录移到仓库外。')
        task = state['active'] or {'id': uuid.uuid4().hex, 'request': '审阅已有修改', 'phase': '修改审阅', 'created': datetime.now(timezone.utc).isoformat()}
        task['view'] = task_view(payload.get('view', task.get('view', {})))
        task['baseHead'] = status['head']
        task['stash'] = None
        task['phaseBeforePause'] = task.get('phase', '修改审阅')
        if not status['clean']:
            # 系统先保存恢复线索，避免 Git 成功后丢失任务关联。
            task['phase'] = '暂存处理中'
            message = 'coharness-task:' + task['id'] + ':' + uuid.uuid4().hex
            task['stashMessage'] = message
            state['active'] = task
            persist(workspace, state, '任务开始暂存')
            before = stash_refs(workspace)
            result = run_git(workspace.git_root, 'stash', 'push', '--include-untracked', '--message', message, check=False)
            after = stash_refs(workspace)
            created = after - before
            matching = []
            for oid in created:
                subject = run_git(workspace.git_root, 'show', '-s', '--format=%s', oid).stdout.decode()
                if message in subject:
                    matching.append(oid)
            task['stash'] = matching[0] if len(matching) == 1 else None
            if result.returncode or not task['stash'] or not git_state(workspace)['clean']:
                task['phase'] = '暂存待处理'
                task['error'] = '暂存未完整完成。系统保留任务和已创建的 Git 暂存，请检查工作区。'
                persist(workspace, state, '任务暂存未完成')
                raise ValueError(task['error'])
        task['phase'] = '已暂存'
        task['pausedAt'] = datetime.now(timezone.utc).isoformat()
        state['paused'].insert(0, task)
        state['active'] = None
        return persist(workspace, state, '用户暂存任务')


def restore_task(workspace, payload):
    """系统应用暂存并保留 Git 备份。"""
    with workspace.store.lock:
        state = checked_workflow(workspace, payload)
        if state['active']:
            raise ValueError('请先暂存当前任务，再恢复其他任务。')
        task = next((item for item in state['paused'] if item['id'] == payload.get('taskId')), None)
        if not task:
            raise ValueError('系统未找到该暂存任务。')
        status = git_state(workspace)
        if payload.get('gitToken') != status['token'] or not status['clean']:
            raise ValueError('恢复任务需要干净且未发生变化的工作区。')
        oid = task.get('stash')
        if oid:
            if workspace.root != workspace.git_root:
                raise ValueError('恢复代码暂存需要打开仓库根目录。')
            if oid not in stash_refs(workspace):
                raise ValueError('对应的 Git 暂存已被外部移除。系统保留任务记录。')
        state['paused'].remove(task)
        state['active'] = task
        task['phase'] = '恢复处理中'
        persist(workspace, state, '任务开始恢复')
        if oid:
            result = run_git(workspace.git_root, 'stash', 'apply', '--index', oid, check=False)
            if result.returncode:
                task['phase'] = '恢复待处理'
                task['error'] = 'Git 未能完整恢复修改。请检查冲突或文件占用。暂存备份仍然保留。'
                persist(workspace, state, '任务恢复未完成')
                return {'workflow': state, 'warning': task['error']}
        task['phase'] = task.pop('phaseBeforePause', '需求讨论')
        task.pop('error', None)
        task['restoredAt'] = datetime.now(timezone.utc).isoformat()
        persist(workspace, state, '用户恢复任务')
        return {'workflow': state, 'warning': ''}


def commit_history(workspace, skip=0):
    """系统分页读取真实提交历史。"""
    if not isinstance(skip, int) or not 0 <= skip <= 100000:
        raise ValueError('提交历史页码无效。')
    if run_git(workspace.root, 'rev-parse', '--verify', 'HEAD', check=False).returncode:
        return {'commits': [], 'next': None}
    scope = ['--', workspace.prefix] if workspace.prefix else []
    raw = run_git(workspace.git_root, 'log', '-31', f'--skip={skip}', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00', *scope).stdout.decode(errors='replace')
    fields = raw.split('\0')
    commits = []
    for index in range(0, len(fields) - 5, 5):
        oid, parents, author, date, subject = fields[index:index + 5]
        commits.append({'id': oid.strip(), 'parents': parents.split(), 'author': author, 'date': date, 'subject': subject})
    return {'commits': commits[:30], 'next': skip + 30 if len(commits) > 30 else None}


def commit_info(workspace, oid):
    """系统读取指定提交的身份与比较基准。"""
    if not isinstance(oid, str) or not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', oid):
        raise ValueError('提交编号无效。')
    if run_git(workspace.git_root, 'cat-file', '-t', oid).stdout.strip() != b'commit':
        raise ValueError('该编号不是 Git 提交。')
    parents = run_git(workspace.git_root, 'show', '-s', '--format=%P', oid).stdout.decode().strip().split()
    subject = run_git(workspace.git_root, 'show', '-s', '--format=%s', oid).stdout.decode(errors='replace').strip()
    return {'id': oid, 'parent': parents[0] if parents else None, 'merge': len(parents) > 1, 'subject': subject}


def commit_files(workspace, info):
    """系统从 Git 对象读取提交前后的变动文件。"""
    def tree(oid):
        entries = {}
        if not oid:
            return entries
        scope = ['--', workspace.prefix] if workspace.prefix else []
        for row in run_git(workspace.git_root, 'ls-tree', '-r', '-l', '-z', oid, *scope).stdout.split(b'\0'):
            if not row:
                continue
            metadata, name = row.split(b'\t', 1)
            path = name.decode(errors='surrogateescape')[len(workspace.prefix):]
            if any(part in EXCLUDED for part in PurePosixPath(path).parts):
                continue
            mode, kind, blob, size = metadata.split()
            entries[path] = (mode, kind, blob, int(size) if size != b'-' else 0)
        return entries

    old, new = tree(info['parent']), tree(info['id'])
    paths = sorted(path for path in old.keys() | new.keys() if old.get(path) != new.get(path))
    notices = [f'该提交包含 {len(paths)} 个变动文件，当前仅展示前 {MAX_FILES} 个文件。'] if len(paths) > MAX_FILES else []
    remaining, files = MAX_TOTAL_BYTES, []
    for path in paths[:MAX_FILES]:
        before, after = old.get(path), new.get(path)
        version = hashlib.sha256(repr((before, after)).encode()).hexdigest()
        file = {'path': path, 'before': '', 'after': '', 'exists': bool(after), 'baseExists': bool(before),
                'kind': '新增' if not before else '删除' if not after else '修改', 'editable': False,
                'previewable': False, 'notice': '', 'version': version, 'size': after[3] if after else 0, 'consumed': 0}
        try:
            entries = [entry for entry in (before, after) if entry]
            if any(entry[0] == b'120000' or entry[1] != b'blob' for entry in entries):
                raise ValueError('链接或子模块需要专门的查看器。')
            if any(entry[3] > MAX_FILE_BYTES for entry in entries):
                raise ValueError('文件超过 512 KiB，当前仅显示文件信息。')
            if sum(entry[3] for entry in entries) > remaining:
                raise ValueError('本次文本预览已达到 8 MiB 上限。')
            contents = []
            for entry in (before, after):
                raw = run_git(workspace.git_root, 'cat-file', 'blob', entry[2].decode()).stdout if entry else b''
                remaining -= len(raw)
                content, error = decode_text(raw)
                if error:
                    raise ValueError(error)
                contents.append(content)
            file.update(before=contents[0], after=contents[1], previewable=True)
        except ValueError as error:
            file['notice'] = str(error)
        files.append(file)
    return files, notices


def commit_detail(workspace, oid):
    """系统比较选定提交与第一父提交。"""
    info = commit_info(workspace, oid)
    scope = ['--', workspace.prefix or '.']
    if info['parent']:
        patch = run_git(workspace.git_root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', info['parent'], oid, *scope).stdout
    else:
        patch = run_git(workspace.git_root, 'show', '--root', '--format=', '--no-ext-diff', '--no-textconv', '--no-renames', oid, *scope).stdout
    limit = 1024 * 1024
    return {**info,
            'patch': patch[:limit].decode(errors='replace'), 'truncated': len(patch) > limit}
