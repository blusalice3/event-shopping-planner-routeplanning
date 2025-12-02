import * as XLSX from 'xlsx';

/**
 * xlsxファイルからマップデータを読み込む
 * @param file xlsxファイル
 * @returns マップデータ（参加日をキーとしたオブジェクト）
 */
export async function readMapDataFromXlsx(file: File): Promise<Map<string, any[][]>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        const mapData = new Map<string, any[][]>();
        
        // 「1日目」と「2日目」シートを探してマップデータとして読み込む
        workbook.SheetNames.forEach((sheetName) => {
          const trimmedSheetName = sheetName.trim();
          // 「1日目」シートを検索（完全一致または含む）
          if (trimmedSheetName === '1日目' || trimmedSheetName.includes('1日目')) {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
            mapData.set('1日目マップ', jsonData);
          } 
          // 「2日目」シートを検索（完全一致または含む）
          else if (trimmedSheetName === '2日目' || trimmedSheetName.includes('2日目')) {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
            mapData.set('2日目マップ', jsonData);
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

