import { CellInfo } from '../types';

/**
 * ワークシートからセル情報を取得
 */
function extractCellInfo(worksheet: any, maxRow: number, maxCol: number, XLSX: any): CellInfo[][] {
  const cells: CellInfo[][] = [];
  
  // セルの幅と高さの情報を取得
  const colWidths = worksheet['!cols'] || [];
  const rowHeights = worksheet['!rows'] || [];
  const merges = worksheet['!merges'] || [];
  
  // マージ情報をマップに変換（開始セルから終了セルへのマッピング）
  const mergeMap = new Map<string, { r: number; c: number; rs: number; cs: number }>();
  merges.forEach((merge: any) => {
    const startCell = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    mergeMap.set(startCell, {
      r: merge.s.r,
      c: merge.s.c,
      rs: merge.e.r - merge.s.r + 1,
      cs: merge.e.c - merge.s.c + 1,
    });
  });
  
  // 2次元配列を初期化（すべてのセルを含む）
  for (let r = 0; r <= maxRow; r++) {
    cells[r] = [];
    for (let c = 0; c <= maxCol; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r: r, c: c });
      const isMerged = Array.from(mergeMap.values()).some(merge => {
        return r >= merge.r && r < merge.r + merge.rs && c >= merge.c && c < merge.c + merge.cs;
      });
      const isMergeStart = mergeMap.has(cellAddress);
      
      cells[r][c] = {
        value: '',
        isNumber: false,
        row: r,
        col: c,
        isMerged: isMerged && !isMergeStart,
        mergeInfo: isMergeStart ? mergeMap.get(cellAddress) : undefined,
        width: colWidths[c]?.wpx || colWidths[c]?.width ? (colWidths[c].wpx || colWidths[c].width * 7) : undefined,
        height: rowHeights[r]?.hpt || rowHeights[r]?.height ? (rowHeights[r].hpt || rowHeights[r].height * 1.33) : undefined,
      };
    }
  }
  
  // ワークシートの各セルを処理
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = worksheet[cellAddress];
      
      // マージされたセルの場合は開始セルの情報を取得
      let actualCell = cell;
      let actualR = R;
      let actualC = C;
      for (const [startCell, mergeInfo] of mergeMap.entries()) {
        if (R >= mergeInfo.r && R < mergeInfo.r + mergeInfo.rs && 
            C >= mergeInfo.c && C < mergeInfo.c + mergeInfo.cs) {
          actualR = mergeInfo.r;
          actualC = mergeInfo.c;
          actualCell = worksheet[startCell];
          break;
        }
      }
      
      // セルが存在する場合も、存在しない場合も処理
      const value = actualCell && actualCell.v !== undefined ? actualCell.v : '';
      const isNumber = actualCell && (actualCell.t === 'n' || (typeof value === 'number'));
      
      // マージ情報を取得
      const mergeInfo = R === actualR && C === actualC ? mergeMap.get(cellAddress) : undefined;
      
      // マージされたセルの幅と高さを計算
      let totalWidth = colWidths[C]?.wpx || colWidths[C]?.width ? (colWidths[C].wpx || colWidths[C].width * 7) : 48;
      let totalHeight = rowHeights[R]?.hpt || rowHeights[R]?.height ? (rowHeights[R].hpt || rowHeights[R].height * 1.33) : 20;
      
      if (mergeInfo) {
        // マージされたセルの幅を合計
        totalWidth = 0;
        for (let c = mergeInfo.c; c < mergeInfo.c + mergeInfo.cs; c++) {
          const w = colWidths[c]?.wpx || colWidths[c]?.width ? (colWidths[c].wpx || colWidths[c].width * 7) : 48;
          totalWidth += w;
        }
        // マージされたセルの高さを合計
        totalHeight = 0;
        for (let r = mergeInfo.r; r < mergeInfo.r + mergeInfo.rs; r++) {
          const h = rowHeights[r]?.hpt || rowHeights[r]?.height ? (rowHeights[r].hpt || rowHeights[r].height * 1.33) : 20;
          totalHeight += h;
        }
      }
      
      // スタイル情報を取得（xlsxライブラリでは通常取得できないが、試行）
      let fillColor: string | undefined;
      let borderStyle: any = {};
      
      if (actualCell && actualCell.s) {
        // 塗りつぶし色
        if (actualCell.s.fill && actualCell.s.fill.fgColor) {
          const rgb = actualCell.s.fill.fgColor.rgb;
          if (rgb) {
            fillColor = `#${rgb}`;
          } else if (actualCell.s.fill.fgColor.theme !== undefined) {
            // テーマカラーの場合はデフォルトの色を使用
            fillColor = undefined;
          }
        }
        
        // 罫線情報
        if (actualCell.s.border) {
          borderStyle = {
            top: actualCell.s.border.top,
            bottom: actualCell.s.border.bottom,
            left: actualCell.s.border.left,
            right: actualCell.s.border.right,
          };
        }
      }
      
      cells[R][C] = {
        value,
        isNumber,
        row: R,
        col: C,
        isMerged: R !== actualR || C !== actualC,
        mergeInfo,
        width: mergeInfo ? totalWidth : (colWidths[C]?.wpx || colWidths[C]?.width ? (colWidths[C].wpx || colWidths[C].width * 7) : 48),
        height: mergeInfo ? totalHeight : (rowHeights[R]?.hpt || rowHeights[R]?.height ? (rowHeights[R].hpt || rowHeights[R].height * 1.33) : 20),
        style: {
          fill: fillColor ? { bgColor: fillColor } : undefined,
          border: Object.keys(borderStyle).length > 0 ? borderStyle : undefined,
        },
      };
    }
  }
  
  return cells;
}

/**
 * xlsxファイルからマップデータを読み込む
 * @param file xlsxファイル
 * @returns マップデータ（参加日をキーとしたオブジェクト）
 */
export async function readMapDataFromXlsx(file: File): Promise<Map<string, CellInfo[][]>> {
  // グローバルにXLSXが読み込まれているか確認
  if (typeof window === 'undefined') {
    throw new Error('ブラウザ環境で実行してください');
  }
  
  const XLSX = (window as any).XLSX;
  if (!XLSX) {
    throw new Error('xlsxライブラリが読み込まれていません。ページをリロードしてください。');
  }
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        // スタイル情報を含めて読み込む（可能な場合）
        const workbook = XLSX.read(data, { type: 'array', cellStyles: true });
        
        const mapData = new Map<string, CellInfo[][]>();
        
        // 「1日目」と「2日目」シートを探してマップデータとして読み込む
        workbook.SheetNames.forEach((sheetName: string) => {
          const trimmedSheetName = sheetName.trim();
          // 「1日目」シートを検索（完全一致または含む）
          if (trimmedSheetName === '1日目' || trimmedSheetName.includes('1日目')) {
            const worksheet = workbook.Sheets[sheetName];
            if (worksheet['!ref']) {
              const range = XLSX.utils.decode_range(worksheet['!ref']);
              const cellInfo = extractCellInfo(worksheet, range.e.r, range.e.c, XLSX);
              mapData.set('1日目マップ', cellInfo);
            }
          } 
          // 「2日目」シートを検索（完全一致または含む）
          else if (trimmedSheetName === '2日目' || trimmedSheetName.includes('2日目')) {
            const worksheet = workbook.Sheets[sheetName];
            if (worksheet['!ref']) {
              const range = XLSX.utils.decode_range(worksheet['!ref']);
              const cellInfo = extractCellInfo(worksheet, range.e.r, range.e.c, XLSX);
              mapData.set('2日目マップ', cellInfo);
            }
          }
        });
        
        // マップデータが見つからない場合の警告
        if (mapData.size === 0) {
          console.warn('マップデータが見つかりませんでした。「1日目」または「2日目」という名前のシートが含まれているか確認してください。');
        }
        
        resolve(mapData);
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => {
      reject(new Error('ファイルの読み込みに失敗しました'));
    };
    
    reader.readAsArrayBuffer(file);
  });
}

