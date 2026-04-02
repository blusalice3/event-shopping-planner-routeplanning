import { useEffect, useState } from 'react';
import { NumberCellOutlineStyle } from '../types';

const STORAGE_KEY = 'numberCellOutlineStyle';
const DEFAULT_STYLE: NumberCellOutlineStyle = 'rounded';

export function useNumberCellOutlineStyle() {
  const [numberCellOutlineStyle, setNumberCellOutlineStyle] = useState<NumberCellOutlineStyle>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && ['rounded', 'square', 'none', 'dashed'].includes(saved)) {
        return saved as NumberCellOutlineStyle;
      }
    } catch {
      // Ignore malformed localStorage payload.
    }
    return DEFAULT_STYLE;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, numberCellOutlineStyle);
  }, [numberCellOutlineStyle]);

  return { numberCellOutlineStyle, setNumberCellOutlineStyle, DEFAULT_OUTLINE_STYLE: DEFAULT_STYLE } as const;
}
