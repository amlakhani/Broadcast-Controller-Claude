import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import GraphicsApp from './GraphicsApp.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* Silent on purpose: this tree renders on the live output, where a visible error message
        would be projected to the audience. Black is the correct failure mode here; the details
        go to the console and to the server via client_error. */}
    <ErrorBoundary label="Graphics output">
      <GraphicsApp />
    </ErrorBoundary>
  </StrictMode>,
)
