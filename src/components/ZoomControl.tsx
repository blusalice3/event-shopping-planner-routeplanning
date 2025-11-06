
import React from 'react';
import PlusIcon from './icons/PlusIcon';
import MinusIcon from './icons/MinusIcon';

interface ZoomControlProps {
    zoomLevel: number;
    onZoomChange: (newZoom: number) => void;
}

const ZoomControl: React.FC<ZoomControlProps> = ({ zoomLevel, onZoomChange }) => {
    const handleZoomIn = () => onZoomChange(zoomLevel + 25);
    const handleZoomOut = () => onZoomChange(zoomLevel - 25);

    return (
        <div className="fixed bottom-6 left-4 z-30 flex items-center bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm rounded-full shadow-lg border border-slate-200 dark:border-slate-700">
            <button
                onClick={handleZoomOut}
                disabled={zoomLevel <= 50}
                className="p-3 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Zoom out"
            >
                <MinusIcon className="w-5 h-5" />
            </button>
            <span className="px-3 text-sm font-semibold text-slate-700 dark:text-slate-200 w-16 text-center">
                {zoomLevel}%
            </span>
            <button
                onClick={handleZoomIn}
                disabled={zoomLevel >= 150}
                className="p-3 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                aria-label="Zoom in"
            >
                <PlusIcon className="w-5 h-5" />
            </button>
        </div>
    );
};

export default ZoomControl;
