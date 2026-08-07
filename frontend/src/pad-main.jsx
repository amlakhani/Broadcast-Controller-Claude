import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import RemotePadApp from './RemotePadApp.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary label="Control pad" silent={false}>
      <RemotePadApp />
    </ErrorBoundary>
  </StrictMode>,
);
