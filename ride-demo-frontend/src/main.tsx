import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import { initializeAuth } from './auth/index.ts';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found in index.html');

// Kicked off before the first paint; the shell shows an initializing state
// until it settles, so no route decides on a half-restored session.
void initializeAuth();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
