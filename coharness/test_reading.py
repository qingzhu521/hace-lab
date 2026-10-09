"""开发者检查阅读依据、项目隔离和验证状态。"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from server import WorkspaceManager
from reading import reading_guide


class ReadingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.project = root / 'project'
        self.project.mkdir()
        self.source = self.project / 'example.py'
        self.source.write_text('def calculate(value):\n    return value + 1\n')
        self.workspace = WorkspaceManager(self.project, root / 'state').current
        self.path = self.workspace.store.path.with_suffix('.reading.json')
        self.guide = {'schema': 1, 'workspaceId': self.workspace.id, 'description': '示例项目',
                      'author': '测试', 'coverage': '单个函数',
                      'sources': [{'id': 'source', 'path': 'example.py', 'start': 1, 'end': 2,
                                   'label': '计算实现', 'version': hashlib.sha256(self.source.read_bytes()).hexdigest()}],
                      'scenes': [{'id': 'scene', 'title': '计算', 'action': '用户输入数值。', 'outcome': '返回结果。',
                                  'preparation': {'command': 'python example.py', 'requirements': [], 'effects': []},
                                  'steps': [{'id': 'step', 'title': '计算结果', 'module': '计算模块',
                                             'role': '处理输入', 'input': '数值', 'output': '结果',
                                             'expectations': [{'text': '结果加一。', 'sources': ['source']}]}]}]}

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        self.workspace.store.put('reading:generated', {'origin': 'model', 'guide': self.guide}, '测试模型生成路线')

    def test_missing_route_stays_empty(self):
        self.assertIsNone(reading_guide(self.workspace)['guide'])
        self.assertFalse(self.path.exists())

    def test_predefined_json_is_not_loaded_as_a_generated_route(self):
        self.path.write_text(json.dumps(self.guide))
        self.assertIsNone(reading_guide(self.workspace)['guide'])

    def test_exact_source_version_exposes_only_requested_lines(self):
        self.guide['sources'][0]['start'] = 2
        self.save()
        source = reading_guide(self.workspace)['guide']['sources'][0]
        self.assertEqual(source['status'], 'current')
        self.assertEqual(source['excerpt'], '    return value + 1')

    def test_changed_source_does_not_mislabel_shifted_lines(self):
        self.save()
        self.source.write_text('# inserted\n' + self.source.read_text())
        source = reading_guide(self.workspace)['guide']['sources'][0]
        self.assertEqual(source['status'], 'stale')
        self.assertEqual(source['excerpt'], '')

    def test_imported_claims_cannot_impersonate_runtime_evidence(self):
        self.guide['scenes'][0]['runs'] = [{'exitCode': 0}]
        self.guide['scenes'][0]['steps'][0]['expectations'][0]['status'] = 'verified'
        self.save()
        result = reading_guide(self.workspace)
        self.assertFalse(result['executionAvailable'])
        scene = result['guide']['scenes'][0]
        self.assertEqual(scene['runs'], [])
        self.assertEqual(scene['steps'][0]['expectations'][0]['status'], 'unverified')

    def test_other_project_route_is_rejected(self):
        self.guide['workspaceId'] = 'another-project'
        self.save()
        with self.assertRaisesRegex(ValueError, '不匹配'):
            reading_guide(self.workspace)

    def test_outside_source_is_unavailable(self):
        self.guide['sources'][0]['path'] = '../outside.txt'
        self.save()
        source = reading_guide(self.workspace)['guide']['sources'][0]
        self.assertEqual(source['status'], 'unavailable')
        self.assertEqual(source['excerpt'], '')

    def test_unknown_reference_is_rejected(self):
        self.guide['scenes'][0]['steps'][0]['expectations'][0]['sources'] = ['unknown']
        self.save()
        with self.assertRaisesRegex(ValueError, '未知依据'):
            reading_guide(self.workspace)


if __name__ == '__main__':
    unittest.main()
