import { useEffect, useState, type ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import type { WorkspaceInfo } from '../protocol.ts';
import { selectWorkspace } from './selection.ts';
import type {} from './locales.ts';
import { ProjectPicker, type ProjectActions } from './ProjectPicker.tsx';
import { OverviewPanel, type OverviewActions } from './Overview.tsx';
import { Workbench, type IdeActions, type Space } from './Workbench.tsx';
import css from './panel.module.css';

export interface PanelActions extends OverviewActions, ProjectActions, IdeActions {
  readWorkspace(id: string, signal: AbortSignal): Promise<WorkspaceInfo>;
}

type Props = PropsRuntime<'main'> & PropsLocale<'coharness'> & PanelActions;
type ReadState = { id: string; kind: 'loading' | 'error' } | { id: string; kind: 'ready'; value: WorkspaceInfo };

export function Panel({ t, useSessions, useWorkspaces, readWorkspace, overview, ide, listDirectory, openProject }: Props): ReactNode {
  const sessions = useSessions((value: SessionListState) => value);
  const workspaces = useWorkspaces((value: WorkspaceSnapshot) => value);
  const selection = selectWorkspace(sessions, workspaces);
  const selected = selection.kind === 'selected' ? selection.workspace : undefined;
  const id = selected?.workspaceId;
  const updatedAt = selected?.updatedAt;
  const [space, setSpace] = useState<Space>('project');
  const [projectView, setProjectView] = useState<'overview' | 'files'>('overview');
  const [picking, setPicking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<ReadState>();

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setRead(previous => previous?.id === id && previous.kind === 'ready' ? previous : { id, kind: 'loading' });
    readWorkspace(id, controller.signal).then(value => {
      if (!controller.signal.aborted) setRead({ id, kind: 'ready', value });
    }).catch(() => {
      if (!controller.signal.aborted) setRead({ id, kind: 'error' });
    });
    return () => controller.abort();
  }, [id, updatedAt, revision, readWorkspace]);

  const currentRead = read?.id === id ? read : undefined;
  const info = selection.kind === 'selected' && currentRead?.kind === 'ready' ? currentRead.value : undefined;
  const pending = selection.kind === 'selected' && (!currentRead || currentRead.kind === 'loading');

  return <section className={css.shell} aria-label={t('panel')}>
    <header className={css.shellHeader}>
      <div className={css.identity}><strong>CoHarness</strong><span title={info?.path}>{info?.title ?? '打开一个项目'}</span></div>
      <nav className={css.spaces} aria-label="空间导航">
        {(['project','development','review'] as const).map((name,index) => <button key={name} aria-pressed={space===name}
          onClick={()=>setSpace(name)}>{['项目空间','开发空间','审阅空间'][index]}</button>)}
      </nav>
      <div className={css.projectActions}>
        <Button variant="outline" size="sm" onClick={()=>setPicking(true)}>{t('openProject')}</Button>
        <Button variant="ghost" size="sm" disabled={!id||pending} onClick={()=>setRevision(value=>value+1)}>{t('refresh')}</Button>
      </div>
    </header>
    {!info && <p className={css.notice} role={currentRead?.kind==='error'?'alert':undefined}>
      {t(selection.kind!=='selected'?selection.kind:currentRead?.kind==='error'?'unavailable':'loading')}</p>}
    {info && <>
      {space==='project' && <nav className={css.projectNav} aria-label="项目导航">
        <button aria-pressed={projectView==='overview'} onClick={()=>setProjectView('overview')}>项目阅读</button>
        <button aria-pressed={projectView==='files'} onClick={()=>setProjectView('files')}>文件浏览</button>
        <code title={info.path}>{info.path}</code>
      </nav>}
      <div className={css.overviewScroll} hidden={space!=='project'||projectView!=='overview'}>
        <div className={css.readingContent}><OverviewPanel key={info.workspaceId} workspaceId={info.workspaceId} revision={revision} overview={overview} t={t}/></div>
      </div>
      <Workbench key={info.workspaceId} workspaceId={info.workspaceId} space={space} visible={space!=='project'||projectView==='files'}
        revision={revision} ide={ide} onSpace={setSpace} onOverview={()=>{setSpace('project');setProjectView('overview');}}/>
    </>}
    {picking && <ProjectPicker initialPath={info?.path} listDirectory={listDirectory} openProject={openProject}
      onClose={()=>setPicking(false)} t={t}/>}
  </section>;

}

export function PanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" aria-hidden="true"><path d="M3 5h7l2 2h9v13H3z" /><path d="M7 11h10M7 15h6" /></svg>;
}
