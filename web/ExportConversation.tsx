import { useRef, useState } from 'react';
import { request } from './api';

export function ExportConversation({ projectId, disabled }: { projectId?: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reportUrl, setReportUrl] = useState('');
  const pending = useRef(false);
  const exportReport = async () => {
    if (!projectId || disabled || pending.current) return;
    pending.current = true;
    setBusy(true); setNotice(''); setReportUrl('');
    // Open synchronously from the click so popup blockers do not see an async popup.
    const tab = window.open('about:blank', '_blank');
    if (tab) {
      tab.opener = null;
      tab.document.title = 'Preparing report — ELSE';
      tab.document.body.textContent = 'Preparing your conversation report…';
      tab.document.body.style.cssText = 'margin:48px;font:16px system-ui;color:#303030;background:#f7f6f2';
    }
    try {
      const result: { id: string; url: string } = await request(`/api/projects/${encodeURIComponent(projectId)}/reports`, {});
      if (tab && !tab.closed) tab.location.replace(result.url);
      else { setReportUrl(result.url); setNotice('Your report is ready.'); }
    } catch (error) {
      tab?.close();
      setNotice(error instanceof Error ? error.message : 'Could not export the conversation. Please try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <>
    <button type="button" className="export-conversation" aria-label="Summary" title="Open conversation summary" disabled={disabled || busy || !projectId} aria-busy={busy} onClick={() => void exportReport()}>
      <span>Summary</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10"/></svg>
    </button>
    {notice && <div className="export-notice" role="status"><span>{notice} {reportUrl && <a href={reportUrl} target="_blank" rel="noopener noreferrer">Open report ↗</a>}</span><button type="button" aria-label="Dismiss export message" onClick={() => setNotice('')}>×</button></div>}
  </>;
}
