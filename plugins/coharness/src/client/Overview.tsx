import { useEffect, useState, type ReactNode } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { OverviewSnapshot, Source } from '../overview/schema.ts';
import type {} from './locales.ts';
import { Architecture } from './Architecture.tsx';
import css from './panel.module.css';

export interface OverviewActions {
  overview(workspaceId: string, operation: 'get' | 'start' | 'cancel', signal: AbortSignal, runId?: string): Promise<OverviewSnapshot>;
}
type Props = PropsLocale<'coharness'> & OverviewActions & { workspaceId: string; revision: number };

export function OverviewPanel({ workspaceId, revision, overview, t }: Props): ReactNode {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>();
  const [error, setError] = useState(false);
  const [command, setCommand] = useState<{ operation: 'get' | 'start' | 'cancel'; nonce: number; runId?: string }>({ operation: 'get', nonce: 0 });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setBusy(true); setError(false);
    async function request(operation: 'get' | 'start' | 'cancel') {
      try {
        const value = await overview(workspaceId, operation, controller.signal, command.runId);
        if (controller.signal.aborted) return;
        setSnapshot(value); setBusy(false);
        if (value.run?.status === 'running') timer = setTimeout(() => { void request('get'); }, 1200);
      } catch {
        if (!controller.signal.aborted) { setError(true); setBusy(false); }
      }
    }
    void request(command.operation);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [workspaceId, command, overview]);
  // A workspace refresh only fetches state; it never repeats a generation command.
  useEffect(() => { setCommand(value => ({ operation: 'get', nonce: value.nonce + 1 })); }, [revision]);
  const run = snapshot?.run;
  const running = run?.status === 'running';
  const result = run?.overview;
  const sources = run?.sources ?? [];
  const stale = new Set(snapshot?.stalePaths ?? []);
  const act = (operation: 'get' | 'start' | 'cancel') => setCommand(value => ({ operation, nonce: value.nonce + 1, runId: run?.runId }));
  const evidence = (ids: string[]) => <div className={css.evidence}>{ids.map(id => {
    const source = sources.find(item => item.id === id);
    return source ? <SourceExcerpt key={id} source={source} stale={stale.has(source.path)} t={t} /> : null;
  })}</div>;
  const credentialError = /MISSING_CREDENTIAL|INVALID_CREDENTIAL|NO_ADAPTER|AUTH/.test(run?.error ?? '');

  return <section className={css.overview} aria-label={t('overviewTitle')}>
    <div className={css.toolbar}>
      <h2>{t('overviewTitle')}</h2>
      {running ? <Button variant="outline" size="sm" disabled={busy} onClick={() => act('cancel')}>{t('cancel')}</Button>
        : <Button variant="primary" size="sm" disabled={busy || !snapshot} onClick={() => act('start')}>
          {run ? t('regenerate') : t('generate')}</Button>}
    </div>
    {!run && <p className={css.explanation}>{t('overviewEmpty')}</p>}
    <div aria-live="polite">
      {error && <p role="alert">{t('overviewError')} <Button variant="ghost" size="sm" onClick={() => act('get')}>{t('refresh')}</Button></p>}
      {running && <p role="status">{t('generating')} · {t('step')} {run.step}
        {run.activity.startsWith('read:') || run.activity.startsWith('list:') ? <code className={css.activity}>{run.activity.slice(5)}</code> : null}</p>}
      {run && run.status !== 'running' && run.status !== 'completed' && <p role="alert">
        {t(run.status === 'cancelled' ? 'cancelled' : run.status === 'interrupted' ? 'interrupted' : credentialError ? 'credentialError' : 'generationError')}
      </p>}
    </div>
    {run && <p className={css.meta}>{t('defaultModel')}: {run.provider} / {run.model}</p>}
    {result && <>
      <p className={css.badge}>{t('staticOnly')}</p>
      <p className={css.meta}>{t('generatedAt')}: {new Date(run.createdAt).toLocaleString()} · {t('checkedAt')}: {new Date(snapshot!.checkedAt).toLocaleTimeString()}</p>
      {stale.size > 0 && <p role="alert" className={css.warning}>{t('staleOverview')}</p>}
      <Architecture html={result.architectureHtml} />
      <article className={css.purpose}><h3>{t('purpose')}</h3><p>{result.purpose.text}</p>{evidence(result.purpose.sourceIds)}</article>
      <h3>{t('modules')}</h3>
      <div className={css.moduleGrid}>{result.modules.map((module, index) => <article key={index} className={css.module}>
        <h4>{module.name}</h4><p>{module.responsibility}</p>{evidence(module.sourceIds)}
      </article>)}</div>
      <h3>{t('scenarios')}</h3>
      {result.scenarios.length === 0 && <p className={css.explanation}>{t('noScenarios')}</p>}
      {result.scenarios.map((scenario, index) => <details className={css.scenario} key={index}>
        <summary>{scenario.name}<span>{t('openReading')}</span></summary>
        <dl><dt>{t('action')}</dt><dd>{scenario.action}</dd><dt>{t('expectedResult')}</dt><dd>{scenario.expectedResult}</dd></dl>
        <ol>{scenario.readingSteps.map((step, index) => <li key={index}><p>{step.explanation}</p>{evidence([step.sourceId])}</li>)}</ol>
      </details>)}
      {result.unknowns.length > 0 && <aside className={css.unknowns}><h3>{t('unknowns')}</h3><ul>{result.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul></aside>}
    </>}
    {run && <details className={css.audit}><summary>{t('generationRecord')}</summary>
      <dl><dt>{t('runId')}</dt><dd><code>{run.runId}</code></dd><dt>{t('sessionId')}</dt><dd><code>{run.sessionId}</code></dd>
        <dt>{t('step')}</dt><dd>{run.step}</dd>{run.error && <><dt>{t('errorCode')}</dt><dd><code>{run.error}</code></dd></>}</dl>
      <p>{t('auditDetail')}</p>
    </details>}
  </section>;
}

function SourceExcerpt({ source, stale, t }: { source: Source; stale: boolean } & PropsLocale<'coharness'>): ReactNode {
  return <details className={css.source}>
    <summary><code>{source.path}:{source.startLine}–{source.endLine}</code>{stale && <span>{t('stale')}</span>}</summary>
    <p className={css.meta}>{t('sourceSnapshot')} · SHA-256 {source.hash.slice(0, 12)}</p>
    <pre><code>{source.excerpt}</code></pre>
  </details>;
}
