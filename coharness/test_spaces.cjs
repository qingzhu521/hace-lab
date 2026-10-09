// 开发者检查目录阅读的数据边界和说明来源。
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const scope = vm.createContext({});
vm.runInContext(readFileSync(__dirname + '/web/spaces.js', 'utf8'), scope);
const file = (path, after = '', extra = {}) => ({path, after, kind: '未修改', previewable: true, ...extra});

test('目录仅展示直接组成，并排除同名前缀和已删除文件', () => {
  const files = [file('src/a.py'), file('src/nested/b.py'), file('src/nested/c.py'),
    file('src-old/outside.py'), file('src/deleted.py', '', {kind: '删除'})];
  const result = scope.directoryContents(files, 'src');
  assert.deepEqual(Array.from(result.files, item => item.path), ['src/a.py']);
  assert.deepEqual(Array.from(result.directories, item => [item.path, item.count]), [['src/nested', 2]]);
  assert.equal(result.members.length, 3);
});

test('目录说明只引用本目录 README，并随最新文本更新', () => {
  const readme = file('src/README.md', '# 源码\n\nEnglish | [中文](README.zh.md)\n\n![badge](x)\n\n<!-- 内部备注 -->\n\n这里组织计算流程。\n\n第二段。');
  const files = [file('README.md', '项目说明'), readme, file('src/child/README.md', '子目录说明')];
  assert.equal(scope.directoryDescription(files, 'src').text, '这里组织计算流程。');
  assert.equal(scope.directoryDescription(files, 'src').source.path, 'src/README.md');
  readme.after = '# 源码\n\n新的目录说明。';
  assert.equal(scope.directoryDescription(files, 'src').text, '新的目录说明。');
});

test('未载入和缺失的目录说明不会被补写为职责', () => {
  assert.equal(scope.directoryDescription([file('child/README.md', '子目录说明')], '').text, '');
  const result = scope.directoryDescription([file('README.md', '', {previewable: false, notice: '预览达到上限。'})], '');
  assert.equal(result.text, '');
  assert.equal(result.notice, '预览达到上限。');
  assert.equal(result.source.path, 'README.md');
});

test('完整索引保留预载范围外的文件，并优先使用已载入正文', () => {
  scope.state = {data: {files: [file('src/a.py', 'actual source')],
    index: [{path: 'src/a.py', kind: '未修改'}, {path: 'other/z.py', kind: '未修改'}]}};
  const files = scope.projectFiles();
  assert.equal(files.length, 2);
  assert.equal(files[0].after, 'actual source');
  assert.equal(files[1].previewable, false);
  assert.equal(scope.directoryContents(files, '').directories.length, 2);
});

test('过期读取响应不会覆盖后来选择的文件', async () => {
  const pending = [];
  const session = vm.createContext({
    state: {space: 'project', file: 'a.txt', data: {workspaceId: 'fixture'}},
    renderMain() {}, postLocal: (route, payload) => new Promise(resolve => pending.push({payload, resolve})),
  });
  vm.runInContext(readFileSync(__dirname + '/web/spaces.js', 'utf8'), session);
  const first = session.loadProjectPreview();
  session.state.file = 'b.txt';
  const second = session.loadProjectPreview();
  pending[1].resolve({file: {path: 'b.txt', after: 'second'}});
  await second;
  pending[0].resolve({file: {path: 'a.txt', after: 'first'}});
  await first;
  assert.equal(session.state.projectPreview.file.after, 'second');
  assert.equal(session.state.projectPreview.path, 'b.txt');
});
