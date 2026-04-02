import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QRCodeDisplayProps {
  roomCode: string;
}

const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({ roomCode }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const joinUrl = `${window.location.origin}/join/${roomCode}`;

  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, joinUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#1e293b', light: '#ffffff' },
      });
    }
  }, [joinUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // フォールバック
      const input = document.createElement('input');
      input.value = joinUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'ルームに参加',
          text: `ルームコード: ${roomCode}`,
          url: joinUrl,
        });
      } catch {
        // ユーザーキャンセル
      }
    }
  };

  return (
    <div className="flex flex-col items-center space-y-4">
      <canvas ref={canvasRef} className="rounded-lg shadow-md" />

      <div className="text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-1">ルームコード</p>
        <p className="text-3xl font-bold tracking-widest text-slate-800 dark:text-white">
          {roomCode}
        </p>
      </div>

      <div className="flex space-x-3">
        <button
          onClick={handleCopy}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
        >
          {copied ? 'コピーしました' : 'URLをコピー'}
        </button>
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button
            onClick={handleShare}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            共有
          </button>
        )}
      </div>
    </div>
  );
};

export default QRCodeDisplay;
