import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { startGuardian } from './guardian/index.js';
import { startCompanion } from './companion/index.js';

// P2 and P1 start once at boot and then work only through the bus (team contract).
// The app's own Demo drawer replaces the Guardian's floating mock panel.
const modules = { guardian: startGuardian({ mockPanel: false }), companion: startCompanion() };

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App modules={modules} />
  </React.StrictMode>,
);
