"""系统将项目阅读路线绑定到真实文件依据。"""

import hashlib
import json
import re
from workspace import safe_path, MAX_FILE_BYTES


def text_fields(item, names):
    """系统检查阅读文案的类型和长度。"""
    if not isinstance(item, dict) or any(not isinstance(item.get(name), str) or not item[name].strip() or len(item[name]) > 12000 for name in names):
        raise ValueError('项目阅读路线缺少有效文案。')


def reading_guide(workspace):
    """系统读取独立项目路线，并检查引用版本。"""
    saved = workspace.store.get('reading:generated')
    if not saved:
        return {'workspaceId': workspace.id, 'guide': None, 'executionAvailable': False}
    guide = saved.get('guide')
    if saved.get('origin') != 'model' or not isinstance(guide, dict):
        raise ValueError('阅读路线缺少模型生成记录。')
    return validate_guide(workspace, guide)


def validate_guide(workspace, guide):
    """系统检查模型路线的结构和实际文件依据。"""
    if len(json.dumps(guide, ensure_ascii=False).encode()) > 1024 * 1024:
        raise ValueError('项目阅读路线超过 1 MiB。')
    text_fields(guide, ['workspaceId', 'description', 'author', 'coverage'])
    if guide.get('schema') != 1 or guide.get('workspaceId') != workspace.id:
        raise ValueError('项目阅读路线与当前目录不匹配。')
    sources = guide.get('sources', [])
    scenes = guide.get('scenes', [])
    if not isinstance(sources, list) or not isinstance(scenes, list) or len(sources) > 40 or len(scenes) > 20:
        raise ValueError('项目阅读路线结构无效。')
    _, _, paths, _ = workspace.inventory(limit=None)
    allowed = set(paths)
    ids = set()
    for source in sources:
        text_fields(source, ['id', 'path', 'label', 'version'])
        if not re.fullmatch('[0-9a-f]{64}', source['version']):
            raise ValueError('依据版本无效。')
        source_id = source.get('id')
        if not isinstance(source_id, str) or source_id in ids:
            raise ValueError('代码依据标识无效。')
        ids.add(source_id)
        start, end = source.get('start'), source.get('end')
        if type(start) is not int or type(end) is not int or not 1 <= start <= end < start + 80:
            raise ValueError('代码依据的行号范围无效。')
        source.update(status='unavailable', excerpt='', notice='')
        try:
            target = safe_path(workspace.root, source.get('path'))
            if source['path'] not in allowed:
                raise ValueError('依据文件已移出项目索引。')
            if not target.is_file():
                raise ValueError('依据对象不是普通文件。')
            with target.open('rb') as stream:
                raw = stream.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                raise ValueError('依据文件超过片段读取范围。')
            current = hashlib.sha256(raw).hexdigest()
            source['currentVersion'] = current
            if current != source.get('version'):
                source.update(status='stale', notice='依据文件已经变化。原行号需要重新核对。')
                continue
            lines = raw.decode('utf-8').splitlines()
            if end > len(lines):
                raise ValueError('依据行号超出文件范围。')
            source.update(status='current', excerpt='\n'.join(lines[start - 1:end]))
        except (ValueError, OSError) as error:
            source['notice'] = str(error)
    scene_ids = set()
    for scene in scenes:
        text_fields(scene, ['id', 'title', 'action', 'outcome'])
        preparation = scene.get('preparation')
        text_fields(preparation, ['command'])
        for field in ['requirements', 'effects']:
            items = preparation.get(field)
            if not isinstance(items, list) or len(items) > 20 or any(not isinstance(item, str) or len(item) > 2000 for item in items):
                raise ValueError('运行准备信息无效。')
        if not isinstance(scene.get('id'), str) or scene['id'] in scene_ids:
            raise ValueError('场景标识无效。')
        scene_ids.add(scene['id'])
        steps = scene.get('steps', [])
        if not isinstance(steps, list) or not 1 <= len(steps) <= 20:
            raise ValueError('场景步骤数量无效。')
        step_ids = set()
        for step in steps:
            text_fields(step, ['id', 'title', 'module', 'role', 'input', 'output'])
            if not isinstance(step.get('id'), str) or step['id'] in step_ids:
                raise ValueError('步骤标识无效。')
            step_ids.add(step['id'])
            claims = step.get('expectations', [])
            if not isinstance(claims, list) or len(claims) > 20:
                raise ValueError('预期行为结构无效。')
            for claim in claims:
                text_fields(claim, ['text'])
                if not isinstance(claim.get('sources'), list) or not claim['sources'] or any(not isinstance(ref, str) or ref not in ids for ref in claim['sources']):
                    raise ValueError('预期行为引用了未知依据。')
                # 当前版本没有执行器，因此不能接收导入的验证结论。
                claim['status'] = 'unverified'
        scene['runs'] = []
    return {'workspaceId': workspace.id, 'guide': guide, 'executionAvailable': False}
