import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import BackstageApp from './BackstageApp.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BackstageApp />
  </StrictMode>,
);
