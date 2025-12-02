import { CellInfo } from '../types';

/**
 * ワークシートからセル情報を取得
 */
function extractCellInfo(worksheet: any, maxRow: number, maxCol: number, XLSX: any): CellInfo[][] {
  const cells: CellInfo[][] = [];
  
  // 2次元配列を初期化
  for (let r = 0; r <= maxRow; r++) {
    cells[r] = [];
    for (let c = 0; c <= maxCol; c++) {
      cells[r][c] = {
        value: '',
        isNumber: false,
        row: r,
        col: c,
      };
    }
  }
  
  // ワークシートの各セルを処理
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = worksheet[cellAddress];
      
      if (cell) {
        const value = cell.v !== undefined ? cell.v : '';
        const isNumber = cell.t === 'n' || (typeof value === 'number');
        
        cells[R][C] = {
          value,
          isNumber,
          row: R,
          col: C,
        };
      }
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
        const workbook = XLSX.read(data, { type: 'array' });
        
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

