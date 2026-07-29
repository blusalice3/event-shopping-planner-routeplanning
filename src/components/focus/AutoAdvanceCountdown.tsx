interface AutoAdvanceCountdownProps {
  countdown: number | null;
}

export function AutoAdvanceCountdown({ countdown }: AutoAdvanceCountdownProps) {
  if (countdown === null) return null;

  return (
    <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-orange-500 text-white px-6 py-3 rounded-lg shadow-lg">
      {countdown}秒後に次の訪問先へ移動します...
    </div>
  );
}
