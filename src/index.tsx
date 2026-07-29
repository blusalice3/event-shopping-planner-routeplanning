import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SpaceNavigatorProvider } from './features/space-navigation/SpaceNavigatorContext';
import { SpaceNavigatorHost } from './features/space-navigation/components/SpaceNavigatorHost';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <SpaceNavigatorProvider>
      <App />
      <SpaceNavigatorHost />
    </SpaceNavigatorProvider>
  </React.StrictMode>,
);
