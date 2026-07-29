import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import RemoteSlidesApp from './RemoteSlidesApp.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RemoteSlidesApp />
  </StrictMode>,
);
