import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Overview, Source } from '../overview/schema.ts';
import { buildStory, STORY_NODE_HEIGHT, STORY_NODE_WIDTH } from './architecture-story.ts';
import css from './panel.module.css';

const STEP_DURATION = 3600;

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function capture(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function ArchitectureStory({ overview, sources }: { overview: Overview; sources: Source[] }): ReactNode {
  const story = useMemo(() => buildStory(overview), [overview]);
  const [trackIndex, setTrackIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const started = useRef(false);
  const track = story.tracks[Math.min(trackIndex, story.tracks.length - 1)] ?? story.tracks[0]!;
  const step = track.steps[Math.min(stepIndex, track.steps.length - 1)] ?? track.steps[0]!;
  const atEnd = stepIndex >= track.steps.length - 1;

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const apply = () => { setReduced(query.matches); if (query.matches) setPlaying(false); };
    apply();
    query.addEventListener?.('change', apply);
    return () => query.removeEventListener?.('change', apply);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!reduced) setPlaying(true);
  }, [reduced]);

  // A new overview starts again from the first step.
  useEffect(() => {
    setTrackIndex(0);
    setStepIndex(0);
    if (!reduced) setPlaying(true);
  }, [overview, reduced]);

  useEffect(() => {
    if (!playing) return;
    if (atEnd) { setPlaying(false); return; }
    const timer = setTimeout(() => setStepIndex(value => Math.min(value + 1, track.steps.length - 1)), STEP_DURATION);
    return () => clearTimeout(timer);
  }, [playing, atEnd, stepIndex, track]);

  const chooseTrack = (index: number) => {
    setTrackIndex(index);
    setStepIndex(0);
    if (!reduced) setPlaying(true);
  };
  const toggle = () => {
    if (atEnd) { setStepIndex(0); setPlaying(true); return; }
    setPlaying(value => !value);
  };
  const move = (delta: number) => {
    setPlaying(false);
    setStepIndex(value => Math.max(0, Math.min(track.steps.length - 1, value + delta)));
  };

  const active = new Set(step.moduleIds);
  const activeLabel = active.size ? [...active].map(id => story.modules.find(module => module.id === id)?.name).filter(Boolean).join('、') : '文件依据';
  const sourceFor = (id: string) => sources.find(source => source.id === id);

  return <section className={css.architectureStory} aria-label="项目架构演示动画">
    <header className={css.storyHeader}>
      <div className={css.storyIdentity}><strong>架构演示</strong><span>动画根据模型概览绘制 · 不代表运行路径</span></div>
      <div className={css.storyControls} role="group" aria-label="架构演示播放控制">
        <button type="button" onClick={() => move(-1)} disabled={stepIndex === 0} aria-label="上一步">‹</button>
        <button type="button" className={css.storyPlay} onClick={toggle}>{playing ? '暂停' : atEnd ? '重播' : '播放'}</button>
        <button type="button" onClick={() => move(1)} disabled={atEnd} aria-label="下一步">›</button>
      </div>
    </header>
    <nav className={css.storyTracks} aria-label="架构演示场景">
      {story.tracks.map((item, index) => <button key={item.id} type="button" aria-pressed={index === trackIndex}
        onClick={() => chooseTrack(index)}>{clip(item.label, 14)}</button>)}
    </nav>
    <div className={css.storyStage} aria-busy={playing}>
      <svg viewBox={`0 0 ${story.graph.width} ${story.graph.height}`} role="img"
        aria-label={`架构图。当前高亮：${activeLabel}。${step.title}。`}>
        <defs>
          <marker id="coharness-story-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={css.storyArrow} />
          </marker>
        </defs>
        {story.graph.edges.map(edge => {
          const fromActive = active.has(edge.from);
          const toActive = active.has(edge.to);
          const touching = fromActive || toActive;
          const flowing = step.kind === 'scenario' && fromActive && toActive;
          return <g key={edge.id} className={`${css.storyEdge} ${touching ? css.storyEdgeActive : ''} ${flowing ? css.storyEdgeFlow : ''}`}>
            <title>{edge.description}</title>
            <path d={edge.path} markerEnd="url(#coharness-story-arrow)" />
          </g>;
        })}
        {story.graph.nodes.map((node, index) => {
          const selected = active.has(node.id);
          const dimmed = active.size > 0 && !selected;
          return <g key={node.id} className={`${css.storyNode} ${selected ? css.storyNodeActive : ''} ${dimmed ? css.storyNodeDim : ''}`}
            style={{ animationDelay: `${Math.min(index, 9) * 80}ms` }}>
            <title>{node.responsibility}</title>
            <rect x={node.x} y={node.y} width={STORY_NODE_WIDTH} height={STORY_NODE_HEIGHT} rx={10} />
            <text x={node.x + STORY_NODE_WIDTH / 2} y={node.y + 27} className={css.storyNodeName}>{clip(node.name, 12)}</text>
            <text x={node.x + STORY_NODE_WIDTH / 2} y={node.y + 46} className={css.storyNodeMeta}>模块 {String(index + 1).padStart(2, '0')}</text>
          </g>;
        })}
      </svg>
      {!story.graph.nodes.length && <p className={css.storyEmpty}>模型没有给出可绘制的模块。</p>}
    </div>
    <div className={css.storyCaption} aria-live="polite">
      <span className={css.storyEyebrow}>{track.label} · 第 {stepIndex + 1} / {track.steps.length} 步</span>
      <h3>{step.title}</h3>
      <p>{capture(step.detail, 520)}</p>
      <div className={css.storyEvidence}>{step.sourceIds.map(id => {
        const source = sourceFor(id);
        return source ? <code key={id} title={`${source.path}:${source.startLine}`}>{clip(`${source.path}:${source.startLine}`, 34)}</code> : null;
      })}</div>
    </div>
    <footer className={css.storyFooter}>
      <div className={css.storyDots} role="group" aria-label="选择演示步骤">
        {track.steps.map((item, index) => <button key={item.key} type="button" aria-label={`第 ${index + 1} 步：${item.title}`}
          aria-pressed={index === stepIndex} onClick={() => { setPlaying(false); setStepIndex(index); }}>
          <span style={{ width: `${index === stepIndex ? 22 : 7}px` }} />
        </button>)}
      </div>
      <span>{step.kind === 'scenario' ? '场景步骤来自模型概览。系统尚未运行项目。' : '说明来自模型概览与文件依据。'}</span>
    </footer>
  </section>;
}

