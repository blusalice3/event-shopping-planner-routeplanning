import React from 'react';

interface ZoomControlProps {
    zoomLevel: number;
    onZoomChange: (newZoom: number) => void;
}

const ZoomControl: React.FC<ZoomControlProps> = ({ zoomLevel, onZoomChange }) => {
    const zoomOptions = [30, 50, 75, 100, 125, 150];

    return (
        <div className="fixed bottom-4 left-4 z-30">
            <select
                value={zoomLevel}
                onChange={(e) => onZoomChange(Number(e.target.value))}
                className="px-4 py-2 bg-white/90 dark:bg-slate-800/90 backdrop-blur-sm rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold focus:ring-2 focus:ring-blue-500 focus:outline-none"
            >
                {zoomOptions.map(zoom => (
                    <option key={zoom} value={zoom}>
                        {zoom}%
                    </option>
                ))}
            </select>
        </div>
    );
};

export default ZoomControl;
