import React, { useRef } from 'react';

interface SearchBarProps {
  searchKeyword: string;
  onSearchKeywordChange: (keyword: string) => void;
  onSearchNext: () => void;
  matchCount: number;
  currentMatchIndex: number;
}

const SearchBar: React.FC<SearchBarProps> = ({
  searchKeyword,
  onSearchKeywordChange,
  onSearchNext,
  matchCount,
  currentMatchIndex,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchNext();
    }
  };

  return (
    <div className="flex items-center gap-2 px-2">
      <input
        ref={inputRef}
        type="text"
        value={searchKeyword}
        onChange={(e) => onSearchKeywordChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="検索..."
        className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition w-40"
      />
      <button
        onClick={onSearchNext}
        disabled={!searchKeyword.trim()}
        className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors bg-blue-600 text-white hover:bg-blue-700 disabled:bg-slate-400 dark:disabled:bg-slate-600 disabled:cursor-not-allowed whitespace-nowrap"
      >
        次を検索
      </button>
      {searchKeyword.trim() && matchCount > 0 && currentMatchIndex >= 0 && (
        <span className="text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
          {currentMatchIndex + 1} / {matchCount}
        </span>
      )}
      {searchKeyword.trim() && matchCount > 0 && currentMatchIndex < 0 && (
        <span className="text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
          {matchCount}件見つかりました
        </span>
      )}
      {searchKeyword.trim() && matchCount === 0 && (
        <span className="text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
          該当なし
        </span>
      )}
    </div>
  );
};

export default SearchBar;

