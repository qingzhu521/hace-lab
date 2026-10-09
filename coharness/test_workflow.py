"""系统在临时仓库中验证任务、提交历史和 Git 暂存。"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server
from workspace import run_git
from workflow import (git_state, workflow_state, save_task, pause_task,
                      restore_task, stash_refs, commit_history, commit_detail)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.root = self.directory / 'project'
        self.root.mkdir()
        self.source = self.root / 'sample.txt'
        self.source.write_text('baseline\n')
        self.manager = server.WorkspaceManager(self.root, self.directory / 'state')
        self.workspace = self.manager.current
        run_git(self.root, 'config', 'user.name', 'Fixture')
        run_git(self.root, 'config', 'user.email', 'fixture@example.invalid')
        run_git(self.root, 'config', 'commit.gpgsign', 'false')
        self.commit('Initial content')

    def tearDown(self):
        self.temp.cleanup()

    def commit(self, message):
        run_git(self.root, 'add', '--all')
        run_git(self.root, 'commit', '--quiet', '-m', message)
        return run_git(self.root, 'rev-parse', 'HEAD').stdout.decode().strip()

    def payload(self, **fields):
        return {'workspaceId': self.workspace.id,
                'revision': workflow_state(self.workspace)['revision'],
                'gitToken': git_state(self.workspace)['token'], **fields}

    def save(self):
        return save_task(self.workspace, self.payload(request='系统提供修改地图。', view={'file': 'sample.txt'}))

    def pause(self):
        return pause_task(self.workspace, self.payload(view={'file': 'sample.txt'}))

    def restore(self, task):
        return restore_task(self.workspace, self.payload(taskId=task['id']))

    def test_clean_git_ignores_crlf_and_unparsed_files(self):
        (self.root / '.gitattributes').write_text('*.cmd text eol=crlf\n')
        (self.root / 'script.cmd').write_bytes(b'echo test\r\n')
        (self.root / 'large.txt').write_bytes(b'a' * (513 * 1024))
        (self.root / 'link').symlink_to('sample.txt')
        self.commit('Platform files')
        snap = server.snapshot(self.workspace)
        self.assertTrue(snap['git']['clean'])
        self.assertTrue(all(item['kind'] == '未修改' and not item['changes'] for item in snap['files']))
        self.assertFalse(next(item for item in snap['files'] if item['path'] == 'large.txt')['previewable'])

    def test_task_survives_restart_and_rejects_stale_revision(self):
        payload = self.payload(request='需求', view={'file': 'sample.txt'})
        saved = save_task(self.workspace, payload)
        reopened = server.WorkspaceManager(self.root, self.directory / 'state').current
        self.assertEqual(workflow_state(reopened), saved)
        with self.assertRaisesRegex(ValueError, '任务状态已经变化'):
            save_task(reopened, payload)
        other = self.directory / 'other'
        other.mkdir()
        self.manager.open(other)
        self.assertIsNone(workflow_state(self.manager.current)['active'])
        with self.assertRaisesRegex(ValueError, '工作区已经切换'):
            save_task(self.manager.current, payload)

    def test_clean_pause_only_saves_task_and_restores_view(self):
        saved = self.save()
        paused = self.pause()
        self.assertIsNone(paused['active'])
        self.assertEqual(stash_refs(self.workspace), set())
        task = paused['paused'][0]
        self.assertIsNone(task['stash'])
        restored = self.restore(task)['workflow']['active']
        self.assertEqual(restored['id'], saved['active']['id'])
        self.assertEqual(restored['view']['file'], 'sample.txt')

    def test_stash_restores_index_unstaged_and_untracked_without_dropping_backup(self):
        (self.root / '.gitignore').write_text('ignored.txt\n')
        head = self.commit('Ignore generated file')
        (self.root / 'ignored.txt').write_text('retained')
        self.source.write_text('staged\n')
        run_git(self.root, 'add', 'sample.txt')
        self.source.write_text('working\n')
        (self.root / 'new file.txt').write_text('new content')
        self.save()
        before = run_git(self.root, 'status', '--porcelain=v1', '-z').stdout
        task = self.pause()['paused'][0]
        self.assertTrue(git_state(self.workspace)['clean'])
        self.assertFalse((self.root / 'new file.txt').exists())
        self.assertEqual((self.root / 'ignored.txt').read_text(), 'retained')
        self.assertEqual(run_git(self.root, 'rev-parse', 'HEAD').stdout.decode().strip(), head)
        self.assertFalse(self.restore(task)['warning'])
        self.assertEqual(self.source.read_text(), 'working\n')
        self.assertEqual(run_git(self.root, 'show', ':sample.txt').stdout, b'staged\n')
        self.assertEqual((self.root / 'new file.txt').read_text(), 'new content')
        self.assertEqual(run_git(self.root, 'status', '--porcelain=v1', '-z').stdout, before)
        self.assertIn(task['stash'], stash_refs(self.workspace))

    def test_restore_uses_stable_id_when_external_stash_changes_stack(self):
        self.source.write_text('task content\n')
        task = self.pause()['paused'][0]
        self.source.write_text('external content\n')
        run_git(self.root, 'stash', 'push', '-m', 'External backup')
        refs = stash_refs(self.workspace)
        self.assertEqual(len(refs), 2)
        self.restore(task)
        self.assertEqual(self.source.read_text(), 'task content\n')
        self.assertEqual(stash_refs(self.workspace), refs)

    def test_pause_rejects_changed_files_and_changed_index(self):
        self.source.write_text('stage one\n')
        run_git(self.root, 'add', 'sample.txt')
        self.source.write_text('working\n')
        old = self.payload()
        self.source.write_text('later\n')
        with self.assertRaisesRegex(ValueError, '目录内容已经变化'):
            pause_task(self.workspace, old)
        old = self.payload()
        run_git(self.root, 'reset', '--quiet', 'HEAD', '--', 'sample.txt')
        with self.assertRaisesRegex(ValueError, '目录内容已经变化'):
            pause_task(self.workspace, old)
        self.assertEqual(stash_refs(self.workspace), set())

    def test_restore_rejects_dirty_workspace_and_removed_stash(self):
        self.source.write_text('task change\n')
        task = self.pause()['paused'][0]
        self.source.write_text('unrelated\n')
        with self.assertRaisesRegex(ValueError, '干净'):
            self.restore(task)
        run_git(self.root, 'restore', 'sample.txt')
        run_git(self.root, 'stash', 'drop')
        with self.assertRaisesRegex(ValueError, '外部移除'):
            self.restore(task)
        self.assertEqual(workflow_state(self.workspace)['paused'][0]['id'], task['id'])

    def test_failed_restore_preserves_task_and_stash(self):
        self.source.write_text('task change\n')
        task = self.pause()['paused'][0]
        self.source.write_text('different committed change\n')
        self.commit('Conflicting baseline')
        result = self.restore(task)
        self.assertTrue(result['warning'])
        self.assertEqual(result['workflow']['active']['phase'], '恢复待处理')
        self.assertEqual(result['workflow']['active']['stash'], task['stash'])
        self.assertIn(task['stash'], stash_refs(self.workspace))

    def test_subdirectory_and_unborn_repo_cannot_stash_code(self):
        nested = self.root / 'nested'
        nested.mkdir()
        (nested / 'new.txt').write_text('content')
        self.workspace = self.manager.open(nested)
        self.assertEqual(git_state(self.workspace)['changes'][0]['path'], 'new.txt')
        with self.assertRaisesRegex(ValueError, '仓库根目录'):
            self.pause()
        empty = self.directory / 'unborn'
        empty.mkdir()
        (empty / 'new.txt').write_text('content')
        self.workspace = self.manager.open(empty)
        with self.assertRaisesRegex(ValueError, '已有提交'):
            self.pause()

    def test_pending_pause_cannot_overwrite_recovery_reference(self):
        saved = self.save()
        saved['active'].update(phase='暂存待处理', stash='retained-reference')
        self.workspace.store.put('workflow', saved, '测试恢复线索')
        with self.assertRaisesRegex(ValueError, '尚未完成'):
            self.pause()
        self.assertEqual(workflow_state(self.workspace)['active']['stash'], 'retained-reference')

    def test_history_paginates_and_reads_root_and_parent_diffs(self):
        initial = commit_history(self.workspace)['commits'][0]
        self.assertEqual(initial['subject'], 'Initial content')
        self.assertIsNone(commit_detail(self.workspace, initial['id'])['parent'])
        self.assertIn('+baseline', commit_detail(self.workspace, initial['id'])['patch'])
        for index in range(31):
            self.source.write_text(f'iteration {index}\n')
            self.commit(f'Iteration {index}')
        first = commit_history(self.workspace)
        second = commit_history(self.workspace, first['next'])
        self.assertEqual(len(first['commits']), 30)
        self.assertEqual(len(second['commits']), 2)
        self.assertIsNone(second['next'])
        detail = commit_detail(self.workspace, first['commits'][0]['id'])
        self.assertEqual(detail['parent'], first['commits'][1]['id'])
        self.assertIn('-iteration 29', detail['patch'])
        self.assertIn('+iteration 30', detail['patch'])
        self.assertTrue(git_state(self.workspace)['clean'])

    def test_root_history_keeps_merge_head(self):
        branch = run_git(self.root, 'symbolic-ref', '--short', 'HEAD').stdout.decode().strip()
        run_git(self.root, 'checkout', '-qb', 'fixture-feature')
        (self.root / 'feature.txt').write_text('feature')
        self.commit('Feature change')
        run_git(self.root, 'checkout', '-q', branch)
        run_git(self.root, 'merge', '--no-ff', '-qm', 'Merge feature', 'fixture-feature')
        head = git_state(self.workspace)['head']
        self.assertEqual(commit_history(self.workspace)['commits'][0]['id'], head)
        self.assertTrue(commit_detail(self.workspace, head)['merge'])

    def test_commit_review_uses_git_objects_and_keeps_working_state(self):
        parent = git_state(self.workspace)['head']
        self.source.write_text('def compute(value):\n    return value + 2\n')
        oid = self.commit('Change calculation')
        self.source.write_text('unsaved working change\n')
        index = run_git(self.root, 'ls-files', '--stage').stdout
        events = self.workspace.store.events()
        snap = server.snapshot(self.workspace, oid)
        file = snap['files'][0]
        self.assertEqual(snap['review']['parent'], parent)
        self.assertEqual(file['before'], 'baseline\n')
        self.assertIn('value + 2', file['after'])
        self.assertFalse(file['editable'])
        self.assertTrue(file['changes'])
        self.assertEqual(self.source.read_text(), 'unsaved working change\n')
        self.assertEqual(run_git(self.root, 'ls-files', '--stage').stdout, index)
        self.assertEqual(self.workspace.store.events(), events)
        self.source.write_text('another working change\n')
        self.assertEqual(server.snapshot(self.workspace, oid)['basis'], snap['basis'])

    def test_commit_alignment_is_separate_and_survives_head_change(self):
        self.source.write_text('changed\n')
        oid = self.commit('Change content')
        snap = server.snapshot(self.workspace, oid)
        file = snap['files'][0]
        payload = {'workspaceId': self.workspace.id, 'commit': oid, 'path': file['path'],
                   'version': file['version'], 'basis': snap['basis'], 'change': file['changes'][0]['id'],
                   'expectation': '系统采用新内容。', 'status': '已对齐'}
        server.save_alignment(self.workspace, payload)
        self.source.write_text('later\n')
        self.commit('Later commit')
        self.assertEqual(len(server.snapshot(self.workspace, oid)['records']), 1)
        self.assertFalse(server.snapshot(self.workspace)['records'])
        with self.assertRaises(ValueError):
            server.save_alignment(self.workspace, {**payload, 'commit': git_state(self.workspace)['head']})

    def test_commit_review_handles_add_delete_binary_and_subdirectory(self):
        (self.root / 'nested').mkdir()
        (self.root / 'nested/new.py').write_text('def added():\n    return 1\n')
        (self.root / 'image.bin').write_bytes(b'\x00\xff')
        self.source.unlink()
        oid = self.commit('Change file set')
        snap = server.snapshot(self.workspace, oid)
        files = {file['path']: file for file in snap['files']}
        self.assertEqual(files['sample.txt']['kind'], '删除')
        self.assertEqual(files['nested/new.py']['kind'], '新增')
        self.assertFalse(files['image.bin']['previewable'])
        self.assertEqual(snap['symbols'][0]['name'], 'added')
        nested = self.manager.open(self.root / 'nested')
        self.assertEqual([file['path'] for file in server.snapshot(nested, oid)['files']], ['new.py'])

    def test_initial_commit_review_compares_empty_tree(self):
        snap = server.snapshot(self.workspace, git_state(self.workspace)['head'])
        self.assertIsNone(snap['review']['parent'])
        self.assertEqual(snap['files'][0]['before'], '')
        self.assertEqual(snap['files'][0]['kind'], '新增')
        with self.assertRaises(ValueError):
            server.snapshot(self.workspace, 'HEAD')

    def test_inventory_prioritizes_changes_beyond_display_limit(self):
        (self.root / 'z-last.txt').write_text('baseline')
        self.commit('Another file')
        (self.root / 'z-last.txt').write_text('changed')
        with patch('workspace.MAX_FILES', 1):
            snap = server.snapshot(self.workspace)
        self.assertEqual(snap['files'][0]['path'], 'z-last.txt')
        self.assertFalse(snap['git']['clean'])


if __name__ == '__main__':
    unittest.main()
