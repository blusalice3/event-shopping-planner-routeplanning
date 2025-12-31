import React, { useState, useEffect } from 'react';

const OfflineNotification: React.FC = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [showNotification, setShowNotification] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // オンラインに復帰したら一時的に通知を表示
      setShowNotification(true);
      setTimeout(() => setShowNotification(false), 3000);
    };

    const handleOffline = () => {
      setIsOnline(false);
      setShowNotification(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // 初期状態がオフラインの場合は通知を表示
    if (!navigator.onLine) {
      setShowNotification(true);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (!showNotification) return null;

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm font-medium transition-all duration-300 ${
        isOnline
          ? 'bg-green-500 text-white'
          : 'bg-amber-500 text-white'
      }`}
    >
      {isOnline ? (
        <span>✓ オンラインに復帰しました</span>
      ) : (
        <span>⚠ オフラインモードで動作中（データはローカルに保存されています）</span>
      )}
      {!isOnline && (
        <button
          onClick={() => setShowNotification(false)}
          className="ml-4 px-2 py-0.5 bg-amber-600 rounded hover:bg-amber-700"
        >
          ✕
        </button>
      )}
    </div>
  );
};

export default OfflineNotification;
