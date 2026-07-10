import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import 'leaflet/dist/leaflet.css';
import './styles.css';

// Perf: the heatmap library reads canvas pixels repeatedly. Telling the
// browser "we'll read this canvas often" lets it keep the buffer in a
// faster-to-read place. This silences the Canvas2D willReadFrequently
// warning and gives a small speed-up on weaker devices (phones).
{
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === '2d') attrs = { willReadFrequently: true, ...(attrs || {}) };
    return orig.call(this, type, attrs);
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);

// PWA: register the service worker in production builds only
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
