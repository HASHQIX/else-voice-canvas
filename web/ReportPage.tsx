import { useEffect, useState } from 'react';
import { ApiError, request } from './api';
import { reportToText, type ConversationReport } from '../shared/report';
import { speechSpeakerLabels } from '../shared/transcript';

function ReportList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <section className="report-section"><h2>{title}</h2>{items.length ? <ol>{items.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p className="report-empty">{empty}</p>}</section>;
}

export function ReportPage({ id }: { id: string }) {
  const [report, setReport] = useState<ConversationReport | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [copying, setCopying] = useState(false);
  const speakerLabels = speechSpeakerLabels(report?.transcript || []);
  useEffect(() => {
    let active = true;
    setReport(null); setError(''); setCopyStatus('');
    void request(`/api/reports/${encodeURIComponent(id)}`).then(({ report }: { report: ConversationReport }) => {
      if (active) { setReport(report); document.title = `${report.title} — ELSE`; }
    }).catch(error => {
      if (active) setError(error instanceof ApiError && [401, 404].includes(error.status) ? 'This report is unavailable. Open it in the browser where the conversation was recorded.' : 'Could not load this report. Please reload to try again.');
    });
    return () => { active = false; };
  }, [id]);
  const copyReport = async () => {
    if (!report || copying) return;
    setCopying(true); setCopyStatus('');
    try {
      await navigator.clipboard.writeText(reportToText(report));
      setCopyStatus('Report copied.');
    } catch { setCopyStatus('Copy is unavailable. You can select and copy the report text below.'); }
    finally { setCopying(false); }
  };
  return <main className="report-page">
    <header className="report-toolbar"><span className="report-brand">ELSE</span><button type="button" disabled={!report || copying} onClick={() => void copyReport()}>{copying ? 'Copying…' : 'Copy report'}</button></header>
    <div className="report-copy-status" role="status">{copyStatus}</div>
    {error ? <p className="report-load-message" role="alert">{error}</p> : !report ? <p className="report-load-message" role="status">Preparing your report…</p> : <article className="report-document">
      <header className="report-heading"><p>Conversation report</p><h1>{report.title}</h1><time dateTime={report.capturedAt}>{new Date(report.capturedAt).toLocaleString('en', { dateStyle: 'long', timeStyle: 'short' })}</time>
        {report.inProgress && <p className="report-live-note">Exported during an ongoing conversation. The latest speech may still be awaiting analysis.</p>}
      </header>
      <ReportList title="Settled · priority order" items={report.decisions} empty="No confirmed decisions or facts recorded."/>
      <ReportList title="Still open · priority order" items={report.openQuestions} empty="No open questions recorded."/>
      <ReportList title="Next steps · priority order" items={report.nextSteps} empty="No next steps recorded."/>
      <section className="report-section"><h2>Summary</h2><p>{report.summary || 'No summary recorded yet.'}</p></section>
      <section className="report-section"><h2>Topics discussed</h2>{report.topics.length ? report.topics.map((topic, index) => <div className="report-topic" key={index}><h3>{topic.title}</h3><p>{topic.summary}</p></div>) : <p className="report-empty">No topics recorded yet.</p>}</section>
      <section className="report-section report-transcript"><h2>Full transcript</h2><p className="report-section-note">From the beginning of the conversation.</p>{report.transcript.length ? report.transcript.map(segment => <div key={segment.id}>
        {speakerLabels.has(segment.id) && <span className="transcript-speaker" title="Automatic voice label. Speaker numbering is separate for each microphone session.">{speakerLabels.get(segment.id)}</span>}
        <p>{segment.text}</p>{!segment.final && <span className="report-section-note">Unfinished speech</span>}</div>) : <p className="report-empty">No transcript recorded.</p>}</section>
    </article>}
  </main>;
}
