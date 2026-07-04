import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installMockBridge } from './mockBridge'
import './styles.css'

if (import.meta.env.DEV && !window.ranparty) installMockBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
