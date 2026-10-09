import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import { CHANNEL, ENDPOINT, OVERVIEW_ENDPOINT, isWorkspaceInfo } from '../protocol.ts';
import { snapshotSchema } from '../overview/schema.ts';
import { zh, en } from './locales.ts';
import { Panel, PanelIcon, type PanelActions } from './Panel.tsx';
import styleText from './panel.module.css?inline';

export const inject = ['slots', 'locale', 'layout', 'connection', 'uiSession', 'uiWorkspace', 'workspaces'];
const panelId = 'coharness' as MainPanelId;

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('coharness', { zh, en }), 'coharness: locale');
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'coharness-dsh';
    style.textContent = styleText;
    document.head.append(style);
    return () => style.remove();
  }, 'coharness: styles');
  const t = ctx.locale.bind('coharness');
  const connection = ctx.get('connection') as ConnectionHandle;
  const workspaces = ctx.get('workspaces') as IWorkspaces;
  const actions: PanelActions = {
    async ide(workspaceId, route, data, signal) {
      const result = await connection.rpc.call(CHANNEL, 'coharness/ide', { workspaceId, route, data }, signal);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
    async openProject(path) {
      const workspace = await workspaces.create({ path });
      let opened = false;
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, () => { opened = true; });
      if (opened) ctx.layout.selectPanel(panelId);
    },
    async overview(workspaceId, operation, signal, runId) {
      const result = await connection.rpc.call(CHANNEL, OVERVIEW_ENDPOINT, { workspaceId, operation, ...(runId ? { runId } : {}) }, signal);
      if (!result.ok) throw new Error(result.error.message);
      const snapshot = snapshotSchema.parse(result.value);
      if (snapshot.run && snapshot.run.workspaceId !== workspaceId) throw new Error('Invalid overview workspace');
      return snapshot;
    },
    async readWorkspace(workspaceId, signal) {
      const result = await connection.rpc.call(CHANNEL, ENDPOINT, { workspaceId }, signal);
      if (!result.ok) throw new Error(result.error.message);
      if (!isWorkspaceInfo(result.value) || result.value.workspaceId !== workspaceId) {
        throw new Error('Invalid CoHarness workspace response');
      }
      return result.value;
    },
  };
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: 'coharness', inject: () => actions,
  }, Panel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 10,
    label: () => t('panel'), locale: 'coharness',
  }, PanelIcon));
}
