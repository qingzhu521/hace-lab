import { useEffect, useState } from 'react';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type {} from './locales.ts';
import css from './panel.module.css';

type Listing = DirectoryListing;
export interface ProjectActions {
  listDirectory(path?: string, signal?: AbortSignal): Promise<Listing>;
  openProject(path: string): Promise<void>;
}

type Props = PropsLocale<'coharness'> & ProjectActions & {
  initialPath?: string;
  onClose(): void;
};

export function ProjectPicker({ initialPath, onClose, listDirectory, openProject, t }: Props) {
  const [path, setPath] = useState(initialPath ?? '');
  const [target, setTarget] = useState({ path: initialPath, revision: 0 });
  const [listing, setListing] = useState<Listing>();
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [browseError, setBrowseError] = useState(false);
  const [openError, setOpenError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setBrowseError(false); setListing(undefined);
    listDirectory(target.path, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setListing(value); setPath(value.path); setLoading(false);
    }).catch(() => {
      if (!controller.signal.aborted) { setBrowseError(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [target, listDirectory]);
  const close = () => { if (!opening) onClose(); };
  const navigate = (value?: string) => { setPath(value ?? ''); setTarget(previous => ({ path: value, revision: previous.revision + 1 })); setOpenError(false); };
  const adopt = async () => {
    if (!path.trim() || opening || loading) return;
    setOpening(true); setOpenError(false);
    try { await openProject(path.trim()); onClose(); }
    catch { setOpenError(true); setOpening(false); }
  };
  return <Modal open title={t('openProject')} closeLabel={t('closePicker')} onClose={close}
    description={t('pickerDescription')} footer={<>
      <Button variant="ghost" disabled={opening} onClick={close}>{t('closePicker')}</Button>
      <Button variant="primary" disabled={opening || loading || !path.trim()} onClick={() => { void adopt(); }}>
        {opening ? t('openingProject') : t('openProject')}</Button>
    </>}>
    <form className={css.pickerPath} onSubmit={event => { event.preventDefault(); navigate(path.trim() || undefined); }}>
      <label htmlFor="coharness-project-path">{t('directoryPath')}</label>
      <div><input id="coharness-project-path" data-modal-autofocus value={path} disabled={opening || loading}
        onChange={event => setPath(event.target.value)} placeholder={t('directoryPlaceholder')} />
        <Button type="submit" variant="outline" disabled={opening || loading}>{t('browseDirectory')}</Button></div>
    </form>
    <div className={css.pickerCrumbs} aria-label={t('directoryAncestors')}>
      <Button variant="ghost" size="sm" disabled={opening || loading} onClick={() => navigate()}>{t('homeDirectory')}</Button>
      {listing?.crumbs.map(crumb => <Button key={crumb.path} variant="ghost" size="sm" disabled={opening || loading}
        onClick={() => navigate(crumb.path)}>{crumb.name}</Button>)}
    </div>
    <div className={css.pickerDirectories} aria-busy={loading}>
      {loading && <p role="status">{t('loadingDirectory')}</p>}
      {browseError && <p role="alert">{t('browseDirectoryError')}</p>}
      {listing?.entries.filter(entry => !entry.hidden).map(entry => <button type="button" key={entry.path}
        disabled={opening || loading} onClick={() => navigate(entry.path)} className={css.pickerDirectory}>
        <span aria-hidden="true">▸</span><span>{entry.name}</span>
      </button>)}
      {listing && !listing.entries.some(entry => !entry.hidden) && <p>{t('emptyDirectory')}</p>}
      {listing?.truncated && <p>{t('directoryTruncated')}</p>}
    </div>
    {openError && <p role="alert">{t('openProjectError')}</p>}
  </Modal>;
}
