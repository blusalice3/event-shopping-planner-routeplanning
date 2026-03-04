import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';

const userAgent = navigator.userAgent || '';
const isAndroidFirefox = /Android/i.test(userAgent) && /Firefox/i.test(userAgent) && !/FxiOS/i.test(userAgent);

if (!isAndroidFirefox) {
  registerSW({ immediate: true });
} else if ('serviceWorker' in navigator) {
  // Android FirefoxではPWA/SW実装差で不安定になるケースがあるため、既存SWを除去する
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      void registration.unregister();
    });
  });

  if ('caches' in window) {
    void caches.keys().then((keys) => {
      keys.forEach((key) => {
        void caches.delete(key);
      });
    });
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
