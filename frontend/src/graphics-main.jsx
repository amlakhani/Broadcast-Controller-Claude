import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import GraphicsApp from './GraphicsApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <GraphicsApp />
  </StrictMode>,
)
