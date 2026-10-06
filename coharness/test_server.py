"""Tests exercise ordinary projects, Git baselines, and editor conflicts."""

import tempfile
import unittest
from pathlib import Path

import server
from workspace import Workspace, run_git, safe_path


class ParameterTests(unittest.TestCase):
    def test_javascript_counts_bindings_instead_of_nested_commas(self):
        cases = {'': 0, 'value': 1, 'value, options = {}, ...rest': 3,
                 '{x, y}, [first, second], label = "a,b",': 3,
                 'callback = (x, y) => [x, y], options = {a: 1, b: 2}': 2}
        for declaration, expected in cases.items():
            with self.subTest(declaration=declaration):
                source = f'function sample({declaration}) {{\n  return null;\n}}'
                symbol = server.symbols_for('sample.js', source)[0]
                self.assertEqual(symbol['parameterCount'], expected)

    def test_javascript_keeps_unsupported_syntax_unknown(self):
        for declaration in ['value = /a,b/', 'value = `a,b`', 'value /* comment */, next']:
            self.assertIsNone(server.javascript_parameter_count(declaration))

    def test_python_counts_all_declared_parameter_kinds(self):
        source = 'def sample(first, /, value=1, *items, flag=True, **options):\n    pass\n'
        symbol = server.symbols_for('sample.py', source)[0]
        self.assertEqual(symbol['parameterCount'], 5)
        self.assertEqual(symbol['parameters'], 'first, value, *items, flag, **options')
        self.assertEqual(server.symbols_for('sample.py', 'def empty():\n    pass\n')[0]['parameterCount'], 0)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.root = self.directory / 'ordinary-project'
        self.root.mkdir()
        self.source = self.root / 'example.py'
        self.source.write_text('def first(value):\n    """系统调用第二个函数。"""\n    return second(value)\n\ndef second(value):\n    return value + 1\n')
        self.manager = server.WorkspaceManager(self.root, self.directory / 'state')
        self.workspace = self.manager.current

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return server.snapshot(self.workspace)

    def payload(self):
        snap = self.snapshot()
        file = next(file for file in snap['files'] if file['path'] == 'example.py')
        return {'workspaceId': self.workspace.id, 'path': file['path'], 'version': file['version'],
                'basis': snap['basis'], 'change': file['changes'][0]['id'],
                'expectation': '函数返回输入值加一。', 'status': '讨论中'}

    def commit_fixture(self):
        run_git(self.root, 'add', '--all')
        run_git(self.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Test baseline')

    def test_generic_directory_has_no_project_specific_registry(self):
        snap = self.snapshot()
        self.assertEqual(snap['project'], 'ordinary-project')
        self.assertEqual([f['path'] for f in snap['files']], ['example.py'])
        self.assertIsNone(snap['head'])
        self.assertTrue((self.root / '.git').is_dir())
        first, second = snap['symbols']
        self.assertEqual(first['calls'][0]['target'], second['id'])
        self.assertEqual(first['calls'][0]['line'], 3)

    def test_stale_alignment_cannot_confirm_new_version(self):
        payload = self.payload()
        self.source.write_text(self.source.read_text().replace('value + 1', 'value + 2'))
        with self.assertRaisesRegex(ValueError, '源文件已变化'):
            server.save_alignment(self.workspace, payload)
        self.assertFalse(self.snapshot()['records'])

    def test_history_survives_source_change_and_restart(self):
        payload = self.payload()
        payload['status'] = '已对齐'
        server.save_alignment(self.workspace, payload)
        self.source.write_text(self.source.read_text() + '\n# changed\n')
        reopened = server.WorkspaceManager(self.root, self.directory / 'state')
        snap = server.snapshot(reopened.current)
        record = next(iter(snap['records'].values()))
        self.assertNotEqual(record['basis'], snap['basis'])
        self.assertEqual(record['verification'], '待验证')

    def test_snapshot_refresh_does_not_invent_operations(self):
        self.snapshot()
        self.snapshot()
        self.assertEqual(len(self.workspace.store.events()), 1)

    def test_git_baseline_distinguishes_unchanged_changed_and_deleted(self):
        (self.root / 'empty.txt').touch()
        self.commit_fixture()
        before = self.snapshot()
        self.assertTrue(all(f['kind'] == '未修改' for f in before['files']))
        self.source.write_text(self.source.read_text().replace('value + 1', 'value + 2'))
        (self.root / 'empty.txt').unlink()
        files = {f['path']: f for f in self.snapshot()['files']}
        self.assertEqual(files['example.py']['addedLines'], [6])
        self.assertEqual(files['example.py']['removedLines'], [6])
        self.assertEqual(files['empty.txt']['kind'], '删除')
        self.assertEqual(len(files['empty.txt']['changes']), 1)

    def test_external_new_files_and_gitignore_are_detected(self):
        (self.root / '.gitignore').write_text('private/\n')
        (self.root / 'private').mkdir()
        (self.root / 'private/token.txt').write_text('fixture')
        (self.root / 'new.js').write_text('function added() { return 1; }\n')
        files = {f['path'] for f in self.snapshot()['files']}
        self.assertIn('new.js', files)
        self.assertNotIn('private/token.txt', files)

    def test_editor_saves_working_snapshot_without_git_commit_or_index_change(self):
        self.commit_fixture()
        head = run_git(self.root, 'rev-parse', 'HEAD').stdout
        index = run_git(self.root, 'ls-files', '--stage').stdout
        snap = self.snapshot()
        file = snap['files'][0]
        self.workspace.save_file({'workspaceId': self.workspace.id, 'path': file['path'], 'version': file['version'], 'content': 'print(42)\n'})
        self.assertEqual(self.source.read_text(), 'print(42)\n')
        self.assertEqual(run_git(self.root, 'rev-parse', 'HEAD').stdout, head)
        self.assertEqual(run_git(self.root, 'ls-files', '--stage').stdout, index)
        versions = [v for k, v in self.workspace.store.values().items() if k.startswith('working:')]
        self.assertEqual(len(versions), 2)
        self.assertIn('print(42)\n', [v['content'] for v in versions])

    def test_editor_rejects_external_change(self):
        file = self.snapshot()['files'][0]
        self.source.write_text('external edit\n')
        with self.assertRaisesRegex(ValueError, '磁盘文件已经变化'):
            self.workspace.save_file({'workspaceId': self.workspace.id, 'path': file['path'], 'version': file['version'], 'content': 'stale edit'})
        self.assertEqual(self.source.read_text(), 'external edit\n')

    def test_workspace_switch_isolates_records_and_rejects_old_requests(self):
        payload = self.payload()
        server.save_alignment(self.workspace, payload)
        other = self.directory / 'other'
        other.mkdir()
        (other / 'example.py').write_text(self.source.read_text())
        self.manager.open(other)
        self.assertFalse(server.snapshot(self.manager.current)['records'])
        with self.assertRaisesRegex(ValueError, '工作区已经切换'):
            server.save_alignment(self.manager.current, payload)
        self.manager.open(self.root)
        self.assertEqual(len(server.snapshot(self.manager.current)['records']), 1)

    def test_scope_rejects_parent_paths_symlinks_and_git_metadata(self):
        for path in ('../outside', '.git/config', '/etc/passwd'):
            with self.assertRaises(ValueError):
                safe_path(self.root, path)
        (self.root / 'link.txt').symlink_to(self.source)
        file = next(f for f in self.snapshot()['files'] if f['path'] == 'link.txt')
        self.assertFalse(file['editable'])

    def test_subdirectory_does_not_include_parent_repository_files(self):
        (self.root / 'nested').mkdir()
        (self.root / 'nested/child.txt').write_text('child')
        self.commit_fixture()
        self.manager.open(self.root / 'nested')
        snap = server.snapshot(self.manager.current)
        self.assertEqual([f['path'] for f in snap['files']], ['child.txt'])
        self.assertEqual(snap['files'][0]['before'], 'child')

    def test_binary_files_are_visible_but_not_editable(self):
        (self.root / 'image.bin').write_bytes(b'\x00\xff\x01')
        file = next(f for f in self.snapshot()['files'] if f['path'] == 'image.bin')
        self.assertFalse(file['editable'])
        self.assertFalse(file['previewable'])
        self.assertEqual(file['kind'], '新增')


if __name__ == '__main__':
    unittest.main()
