import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, clientId, createGuest, createProject, createSession, getProject, getTranscript, listProjects, openLive, request, type Project, type Snapshot } from './api';
import { mergeSpeechSegments, type SpeechSegment } from '../shared/transcript';
import { ConversationField } from './ConversationField';
import { ConversationPlan } from './ConversationPlan';
import { MicrophoneCapture } from './voice';
import { useBrowserInsets } from './useBrowserInsets';
type Phase = 'idle' | 'starting' | 'listening' | 'thinking' | 'pausing';
const messageFor = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
    if (error instanceof DOMException && error.name === 'NotAllowedError')
        return 'Allow microphone access in your browser, then try again.';
    if (error instanceof DOMException && error.name === 'NotFoundError')
        return 'Connect a microphone, then try again.';
    const messages: Record<string, string> = {
        microphone_gesture_required: 'Your browser needs a click to start audio. Press Resume microphone.',
        provider_unavailable: 'The conversation service is unavailable. Your saved field is still here.',
        budget_exhausted: 'The daily analysis limit has been reached. Your field is saved.',
        editor_lease: 'This conversation is open in another tab.',
        access_code_required: 'Enter the access code to begin.',
    };
    return messages[code] || (error instanceof Error ? error.message : 'Unable to connect. Please try again.');
};
export function App() {
    useBrowserInsets();
    const [project, setProject] = useState<Project | null>(null);
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [leaseReady, setLeaseReady] = useState(false);
    const [writable, setWritable] = useState(true);
    const [initialized, setInitialized] = useState(false);
    const [error, setError] = useState('');
    const [transcript, setTranscript] = useState('');
    const [speechSegments, setSpeechSegments] = useState<SpeechSegment[]>([]);
    const [preview, setPreview] = useState('');
    const [needCode, setNeedCode] = useState(false);
    const [code, setCode] = useState('');
    const [creating, setCreating] = useState(false);
    const creatingConversation = useRef(false);
    const mic = useRef<MicrophoneCapture | null>(null);
    const microphoneLevel = useRef<HTMLSpanElement>(null);
    const stream = useRef<MediaStream | null>(null);
    const live = useRef<ReturnType<typeof openLive> | null>(null);
    const generation = useRef(0);
    const ready = useRef(false);
    const connecting = useRef(false);
    const autoAttempt = useRef('');
    const pauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const resumeAfterClose = useRef(false);
    const startAgain = useRef<() => Promise<void>>(async () => { });
    const pauseForRenewal = useRef<(renew?: boolean) => Promise<void>>(async () => { });
    const boot = useRef<Promise<Project> | null>(null);
    const current = useRef({ project, snapshot, leaseReady, writable });
    current.current = { project, snapshot, leaseReady, writable };
    const showProject = useCallback((value: Project) => {
        const branch = value.branches.find(branch => branch.is_main) || value.branches[0];
        current.current = { project: value, snapshot: branch.snapshot, leaseReady: false, writable: true };
        setProject(value);
        setSnapshot(branch.snapshot);
        setLeaseReady(false);
        setWritable(true);
        setTranscript('');
        setSpeechSegments([]);
        setPreview('');
        setError('');
        localStorage.setItem('else.project', value.id);
    }, []);
    const disconnect = useCallback(() => {
        generation.current++;
        ready.current = false;
        connecting.current = false;
        clearTimeout(pauseTimer.current);
        clearTimeout(renewTimer.current);
        resumeAfterClose.current = false;
        const connection = live.current;
        live.current = null;
        connection?.close();
        const capture = mic.current;
        mic.current = null;
        void capture?.stop();
        stream.current?.getTracks().forEach(track => track.stop());
        stream.current = null;
        microphoneLevel.current?.style.setProperty('--microphone-level', '0');
        setPhase('idle');
    }, []);
    const load = useCallback((accessCode?: string) => {
        return (async () => {
            await createGuest(accessCode);
            const projects = await listProjects();
            const last = localStorage.getItem('else.project');
            const id = projects.find(project => project.id === last)?.id || projects[0]?.id;
            return id ? getProject(id) : createProject('Untitled conversation', 'en');
        })();
    }, []);
    useEffect(() => {
        let active = true;
        boot.current ||= load();
        boot.current.then(value => { if (active)
            showProject(value); }).catch(error => {
            if (!active)
                return;
            setNeedCode(error instanceof ApiError && error.code === 'access_code_required');
            setError(messageFor(error));
        }).finally(() => { if (active)
            setInitialized(true); });
        return () => { active = false; disconnect(); };
    }, [load, showProject, disconnect]);
    useEffect(() => {
        if (!project) return;
        let active = true;
        getTranscript(project.id).then(({ segments }) => {
            // Speech received while history loads is newer than the fetched copy.
            if (active && current.current.project?.id === project.id) setSpeechSegments(current => mergeSpeechSegments(segments, current));
        }).catch(error => { if (active && current.current.project?.id === project.id) setError(messageFor(error)); });
        return () => { active = false; };
    }, [project?.id]);
    useEffect(() => {
        if (!project)
            return;
        let active = true;
        const refresh = async () => {
            try {
                const result = await request(`/api/projects/${project.id}/lease`, { clientId });
                if (!active || current.current.project?.id !== project.id)
                    return;
                current.current.leaseReady = true;
                current.current.writable = result.writable;
                setLeaseReady(true);
                setWritable(result.writable);
                if (!result.writable)
                    disconnect();
            }
            catch (error) {
                if (active && current.current.project?.id === project.id) {
                    current.current.leaseReady = false;
                    setLeaseReady(false);
                    disconnect();
                    setError(messageFor(error));
                }
            }
        };
        void refresh();
        const timer = setInterval(refresh, 15000);
        return () => { active = false; clearInterval(timer); };
    }, [project?.id, disconnect]);
    useEffect(() => {
        // A recap may finish after a deliberate microphone pause closed the socket.
        if (phase !== 'idle' || !project || !snapshot?.field?.planPending) return;
        let active = true, attempts = 0;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const value = await getProject(project.id);
                const next = value.branches.find(branch => branch.id === current.current.snapshot?.branchId)?.snapshot;
                if (!active || current.current.project?.id !== project.id) return;
                if (next && next.revision > (current.current.snapshot?.revision ?? -1)) {
                    current.current.snapshot = next;
                    setSnapshot(next);
                }
            } catch { /* The saved field remains visible; live reconnect also reloads it. */ }
            if (active && ++attempts < 8 && current.current.snapshot?.field?.planPending)
                timer = setTimeout(refresh, 5000);
        };
        timer = setTimeout(refresh, 1500);
        return () => { active = false; clearTimeout(timer); };
    }, [project?.id, phase, snapshot?.revision, snapshot?.field?.planPending]);
    const start = useCallback(async () => {
        const state = current.current;
        if (!state.project || !state.snapshot || !state.leaseReady || !state.writable || creatingConversation.current || connecting.current || live.current)
            return;
        const token = ++generation.current;
        connecting.current = true;
        setPhase('starting');
        setError('');
        let granted: MediaStream | undefined;
        let createdSessionId: string | undefined;
        try {
            if (!navigator.mediaDevices?.getUserMedia)
                throw new Error('Microphone access requires HTTPS or localhost.');
            // Request permission immediately, before waiting for a provider connection.
            granted = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
            if (token !== generation.current) {
                granted.getTracks().forEach(track => track.stop());
                return;
            }
            stream.current = granted;
            const health = await request('/readyz');
            if (!health.voiceReady)
                throw new Error('provider_unavailable');
            if (token !== generation.current)
                return;
            const session = await createSession(state.project.id, state.snapshot.branchId, 'en');
            createdSessionId = session.id;
            if (token !== generation.current) {
                await request(`/api/sessions/${encodeURIComponent(session.id)}`, undefined, 'DELETE');
                return;
            }
            let epoch = 0;
            const connection = openLive(session.id, {
                message: message => {
                    if (token !== generation.current || message.sessionId !== session.id || message.contextEpoch < epoch)
                        return;
                    epoch = message.contextEpoch;
                    const payload = message.payload || {};
                    switch (message.type) {
                        case 'fork.ready':
                            ready.current = true;
                            mic.current?.setReady(true);
                            setPhase('listening');
                            break;
                        case 'fork.transcript':
                            setTranscript(payload.text || payload.transcript || '');
                            break;
                        case 'fork.speech_segment':
                            if (payload.segment)
                                setSpeechSegments(current => mergeSpeechSegments(current, [payload.segment]));
                            break;
                        case 'fork.draft':
                            setPreview(payload.preview?.ideaTitle || '');
                            break;
                        case 'fork.agent_status':
                            if (payload.status === 'finalizing')
                                setPhase(value => value === 'pausing' ? value : 'thinking');
                            if (payload.status === 'listening' || payload.status === 'speaking')
                                setPhase(value => value === 'pausing' ? value : 'listening');
                            break;
                        case 'fork.committed':
                            if (payload.snapshot) {
                                current.current.snapshot = payload.snapshot;
                                setSnapshot(payload.snapshot);
                            }
                            setTranscript('');
                            setPreview('');
                            setError('');
                            setPhase(value => value === 'pausing' ? value : 'listening');
                            break;
                        case 'fork.plan':
                            // Memory refreshes do not reset live speech, camera, or microphone state.
                            if (payload.snapshot?.projectId === current.current.project?.id &&
                                payload.snapshot.branchId === current.current.snapshot?.branchId &&
                                payload.snapshot.revision > (current.current.snapshot?.revision ?? -1)) {
                                current.current.snapshot = payload.snapshot;
                                setSnapshot(payload.snapshot);
                            }
                            break;
                        case 'fork.error':
                            setError(payload.message || 'The connection was interrupted. Please resume the microphone.');
                            if (payload.recoverableText)
                                setTranscript(payload.recoverableText);
                            setPhase(value => value === 'pausing' ? value : 'listening');
                            break;
                    }
                },
                error: () => { if (token === generation.current)
                    setError('Connection interrupted. Your saved field is still here.'); },
                close: () => {
                    if (token !== generation.current)
                        return;
                    const renew = resumeAfterClose.current;
                    disconnect();
                    if (renew)
                        void startAgain.current();
                },
            });
            live.current = connection;
            await connection.ready;
            if (token !== generation.current)
                return;
            const capture = new MicrophoneCapture({
                // Update only the tiny meter, without rerendering the whole field for every audio frame.
                onLevel: level => {
                    if (token === generation.current)
                        microphoneLevel.current?.style.setProperty('--microphone-level', String(Math.min(1, level * 3)));
                },
                onError: error => { if (token === generation.current) {
                    disconnect();
                    setError(messageFor(error));
                } } });
            mic.current = capture;
            await capture.start(connection.socket, granted);
            if (token !== generation.current) {
                await capture.stop();
                return;
            }
            capture.setReady(ready.current);
            connection.send('fork.start', { language: 'en', muted: true, hold: false, mode: 'develop' });
            // Renew before the server's ten-minute cap, after saving the current thought.
            const expires = Date.parse(session.expiresAt);
            if (Number.isFinite(expires))
                renewTimer.current = setTimeout(() => void pauseForRenewal.current(true), Math.max(1000, expires - Date.now() - 90000));
        }
        catch (error) {
            granted?.getTracks().forEach(track => track.stop());
            if (token === generation.current) {
                disconnect();
                setError(messageFor(error));
            }
            if (createdSessionId) void request(`/api/sessions/${encodeURIComponent(createdSessionId)}`, undefined, 'DELETE').catch(() => {});
        }
        finally {
            if (token === generation.current)
                connecting.current = false;
        }
    }, [disconnect]);
    startAgain.current = start;
    useEffect(() => {
        if (!project || !leaseReady || !writable || autoAttempt.current === project.id)
            return;
        autoAttempt.current = project.id;
        void start();
    }, [project?.id, leaseReady, writable, start]);
    const pause = async (renew = false) => {
        clearTimeout(renewTimer.current);
        resumeAfterClose.current = renew;
        if (!live.current || !ready.current) {
            disconnect();
            return;
        }
        const token = generation.current;
        setPhase('pausing');
        try {
            await mic.current?.flush();
        }
        catch { /* Retain the transcript if transport failed. */ }
        await mic.current?.stop();
        if (token !== generation.current)
            return;
        stream.current = null;
        mic.current = null;
        live.current?.send('fork.stop');
        pauseTimer.current = setTimeout(() => {
            if (token === generation.current) {
                disconnect();
                setError('The last thought could not be confirmed. Your saved field is preserved.');
            }
        }, 65000);
    };
    pauseForRenewal.current = pause;
    const newConversation = async () => {
        if (creatingConversation.current || !current.current.project)
            return;
        creatingConversation.current = true;
        setCreating(true);
        // Invalidate pending speech, analysis and startup callbacks before switching.
        disconnect();
        setError('');
        try {
            showProject(await createProject('Untitled conversation', 'en'));
        }
        catch (error) {
            setError(messageFor(error));
        }
        finally {
            creatingConversation.current = false;
            setCreating(false);
        }
    };
    const active = phase === 'listening' || phase === 'thinking';
    const disabled = !leaseReady || !writable || creating || phase === 'pausing';
    const status = phase === 'starting' ? 'Connecting microphone' : phase === 'pausing' ? 'Saving your last thought' : active ? 'Microphone on' : 'Microphone off';
    return <div className="app-shell">
    <header className="app-logo"><a href="/" className="brand" aria-label="ELSE home">ELSE</a></header>
    <main><ConversationField key={snapshot?.branchId || project?.id || 'empty'} field={snapshot?.field} transcript={transcript} preview={preview} thinking={phase === 'thinking'} paused={initialized && phase === 'idle'} microphone={{ disabled, status: initialized ? status : 'Preparing your conversation', onStart: () => void start() }}/></main>
    <ConversationPlan projectId={project?.id} field={snapshot?.field} transcript={speechSegments} newConversation={{
      disabled: creating || !project, busy: creating,
      title: 'Start a new conversation with a clear transcript, field and plan.',
      onStart: () => void newConversation(),
    }} microphone={{
      active, busy: phase === 'starting' || phase === 'pausing', disabled, status, levelRef: microphoneLevel,
      label: phase === 'idle' ? 'Resume microphone' : phase === 'starting' ? 'Cancel microphone connection' : 'Pause microphone',
      onToggle: () => phase === 'idle' ? void start() : void pause(),
    }}/>
    {(error || !writable) && <div className="error-toast" role="alert"><span>{!writable ? 'This conversation is being edited in another tab. Close it there, then reload.' : error}</span>{writable && <button onClick={() => setError('')} aria-label="Dismiss message">×</button>}</div>}
    {initialized && !project && !needCode && <div className="access-dialog"><p>We couldn’t open your conversation.</p><button onClick={() => location.reload()}>Try again</button></div>}
    {needCode && <form className="access-dialog" onSubmit={async (event) => { event.preventDefault(); try {
        showProject(await load(code));
        setNeedCode(false);
    }
    catch (error) {
        setError(messageFor(error));
    } }}><label htmlFor="access-code">Conversation access code</label><input id="access-code" type="password" value={code} onChange={event => setCode(event.target.value)} autoFocus/><button type="submit">Continue</button></form>}
  </div>;
}
