import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RenderStage } from './RenderStage';
import './App.css';

// The export pipeline loads this same renderer with ?render=1 in a hidden
// window and drives a deterministic, frame-by-frame view of the reel instead
// of the full app UI.
const isRenderWindow = new URLSearchParams(window.location.search).has('render');

createRoot(document.getElementById('root')!).render(
  isRenderWindow ? (
    <RenderStage />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
