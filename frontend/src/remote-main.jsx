import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import RemoteSlidesApp from './RemoteSlidesApp.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary label="Slides remote" silent={false}>
      <RemoteSlidesApp />
    </ErrorBoundary>
  </StrictMode>,
);
