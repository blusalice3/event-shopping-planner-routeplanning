
import React, { useState } from 'react';
import { BulkSortDirection } from '../App';
import SortAscendingIcon from './icons/SortAscendingIcon';
import SortDescendingIcon from './icons/SortDescendingIcon';
import XIcon from './icons/XIcon';

interface BulkActionControlsProps {
  onSort: (direction: BulkSortDirection) => void;
  onClear: () => void;
}

const BulkActionControls: React.FC<BulkActionControlsProps> = ({ onSort, onClear }) => {
  const [sortDirection, setSortDirection] = useState<BulkSortDirection>('asc');

  const handleSortClick = () => {
    onSort(sortDirection);
    // Toggle direction for the next click
    setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
  };

  return (
    <div className="flex items-center gap-2 animate-fade-in">
      <button 
        onClick={handleSortClick}
        className="p-2 rounded-md bg-white dark:bg-slate-700 hover:bg-blue-100 dark:hover:bg-blue-900 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        title={`ナンバーで${sortDirection === 'asc' ? '昇順' : '降順'}に並び替え`}
      >
        {sortDirection === 'asc' ? <SortAscendingIcon className="w-5 h-5" /> : <SortDescendingIcon className="w-5 h-5" />}
      </button>
      <button 
        onClick={onClear}
        className="p-2 rounded-md bg-white dark:bg-slate-700 hover:bg-red-100 dark:hover:bg-red-900 text-slate-600 dark:text-slate-300 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        title="選択を解除"
      >
        <XIcon className="w-5 h-5" />
      </button>
    </div>
  );
};

export default BulkActionControls;
