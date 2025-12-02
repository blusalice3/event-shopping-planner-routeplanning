import React from 'react';

interface MapViewProps {
  mapData: any[][];
}

const MapView: React.FC<MapViewProps> = ({ mapData }) => {
  if (!mapData || mapData.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[calc(100vh-300px)] bg-white dark:bg-slate-800 rounded-lg shadow p-4">
      <table className="border-collapse border border-slate-300 dark:border-slate-600 w-full">
        <tbody>
          {mapData.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const cellValue = cell !== null && cell !== undefined ? String(cell) : '';
                const isEmpty = cellValue.trim() === '';
                
                return (
                  <td
                    key={cellIndex}
                    className={`border border-slate-300 dark:border-slate-600 p-2 text-sm ${
                      isEmpty 
                        ? 'bg-slate-50 dark:bg-slate-900' 
                        : 'bg-white dark:bg-slate-800'
                    }`}
                    style={{ minWidth: '50px', whiteSpace: 'pre-wrap' }}
                  >
                    {cellValue}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default MapView;

