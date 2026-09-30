import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ReportPage } from './ReportPage';
import './styles.css';

const reportPath = location.pathname.match(/^\/report\/([^/]+)\/?$/);
createRoot(document.getElementById('root')!).render(<React.StrictMode>{reportPath ? <ReportPage id={reportPath[1]}/> : <App />}</React.StrictMode>);
