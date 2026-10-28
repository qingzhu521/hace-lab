import test from 'node:test';
import assert from 'node:assert/strict';
import type { Overview } from '../src/overview/schema.ts';
import { buildStory, storyGraph, storyModules, storyRelations } from '../src/client/architecture-story.ts';

function overview(extra: Partial<Overview> = {}): Overview {
  return {
    architectureHtml: '<article>architecture</article>',
    purpose: { text: '这个项目帮助用户阅读代码。', sourceIds: ['source-1'] },
    modules: [
      { id: 'reader', name: '阅读器', responsibility: '读取源码。', sourceIds: ['source-1'] },
      { id: 'panel', name: '面板', responsibility: '组织界面。', sourceIds: ['source-2'] },
    ],
    relations: [{ from: 'panel', to: 'reader', description: '面板调用阅读器。', sourceIds: ['source-2'] }],
    scenarios: [{
      name: '阅读文件', action: '用户打开文件。', expectedResult: '用户看到文件内容。',
      readingSteps: [
        { explanation: '面板接收用户操作。', sourceId: 'source-2' },
        { explanation: '阅读器读取文件。', sourceId: 'source-1' },
      ],
    }],
    unknowns: [],
    ...extra,
  };
}

test('模块缺少 id 时生成稳定标识并去重', () => {
  const modules = storyModules({
    ...overview(),
    modules: [
      { name: '模块一', responsibility: '职责一。', sourceIds: ['source-1'] },
      { id: '模块一', name: '模块二', responsibility: '职责二。', sourceIds: ['source-2'] },
    ],
  } as Overview);
  assert.deepEqual(modules.map(module => module.id), ['module-1', '模块一']);
});

test('依赖关系只保留已知模块，并拒绝自环和重复边', () => {
  const modules = storyModules(overview());
  const relations = storyRelations(overview({
    relations: [
      { from: 'panel', to: 'reader', description: '第一次。', sourceIds: ['source-2'] },
      { from: 'panel', to: 'reader', description: '重复。', sourceIds: ['source-2'] },
      { from: 'panel', to: 'panel', description: '自环。', sourceIds: ['source-2'] },
      { from: 'panel', to: 'missing', description: '未知。', sourceIds: ['source-2'] },
    ],
  }), modules);
  assert.equal(relations.length, 1);
  assert.equal(relations[0]!.description, '第一次。');
});

test('场景步骤按 sourceId 映射到模块并保留总览轨道', () => {
  const story = buildStory(overview());
  assert.equal(story.tracks[0]!.id, 'overview');
  assert.equal(story.tracks[0]!.steps.length, 2);
  const scenario = story.tracks[1]!;
  assert.equal(scenario.label, '阅读文件');
  assert.deepEqual(scenario.steps[0]!.moduleIds, ['panel']);
  assert.deepEqual(scenario.steps[1]!.moduleIds, ['reader']);
  assert.equal(scenario.steps[0]!.title, '面板');
});

test('分层布局把被使用方放在使用方下方', () => {
  const modules = storyModules(overview());
  const relations = storyRelations(overview(), modules);
  const graph = storyGraph(modules, relations);
  const panel = graph.nodes.find(node => node.id === 'panel')!;
  const reader = graph.nodes.find(node => node.id === 'reader')!;
  assert.ok(panel.layer < reader.layer);
  assert.ok(panel.y < reader.y);
  assert.equal(graph.edges.length, 1);
});

test('没有关系时使用网格布局，位置互不重叠', () => {
  const modules = storyModules(overview());
  const graph = storyGraph(modules, []);
  assert.equal(graph.edges.length, 0);
  const keys = new Set(graph.nodes.map(node => `${node.x}:${node.y}`));
  assert.equal(keys.size, graph.nodes.length);
  assert.ok(graph.width >= 560);
});

test('循环依赖不会让布局无限增长', () => {
  const modules = storyModules(overview({
    modules: [
      { id: 'a', name: 'A', responsibility: '甲。', sourceIds: ['source-1'] },
      { id: 'b', name: 'B', responsibility: '乙。', sourceIds: ['source-2'] },
    ],
    relations: [
      { from: 'a', to: 'b', description: '甲用乙。', sourceIds: ['source-1'] },
      { from: 'b', to: 'a', description: '乙用甲。', sourceIds: ['source-2'] },
    ],
  }));
  const graph = storyGraph(modules, storyRelations(overview({
    modules: [
      { id: 'a', name: 'A', responsibility: '甲。', sourceIds: ['source-1'] },
      { id: 'b', name: 'B', responsibility: '乙。', sourceIds: ['source-2'] },
    ],
    relations: [
      { from: 'a', to: 'b', description: '甲用乙。', sourceIds: ['source-1'] },
      { from: 'b', to: 'a', description: '乙用甲。', sourceIds: ['source-2'] },
    ],
  }), modules));
  assert.ok(graph.nodes.every(node => node.layer <= 4));
  assert.ok(Number.isFinite(graph.height));
});
