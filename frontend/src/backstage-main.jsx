import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import BackstageApp from './BackstageApp.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary label="Backstage monitor" silent={false}>
      <BackstageApp />
    </ErrorBoundary>
  </StrictMode>,
);
