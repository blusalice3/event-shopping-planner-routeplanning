import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ShoppingItem } from '../types';
import { getItemKey } from '../utils/itemComparison';

interface ImportScreenProps {
  onBulkAdd: (eventName: string, items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string, layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }> }) => void;
  activeEventName: string | null;
  itemToEdit: ShoppingItem | null;
  onUpdateItem: (item: ShoppingItem) => void;
  onDoneEditing: () => void;
  availableEventDates?: string[]; // 既存イベントの参加日リスト
}

const ImportScreen: React.FC<ImportScreenProps> = ({ onBulkAdd, activeEventName, itemToEdit, onUpdateItem, onDoneEditing, availableEventDates = [] }) => {
  // State for bulk add (creating new list)
  const [eventName, setEventName] = useState('');
  const [circles, setCircles] = useState('');
  const [eventDates, setEventDates] = useState('');
  const [blocks, setBlocks] = useState('');
  const [numbers, setNumbers] = useState('');
  const [titles, setTitles] = useState('');
  const [prices, setPrices] = useState('');
  const [remarks, setRemarks] = useState('');
  const [spreadsheetUrl, setSpreadsheetUrl] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // State for single item add/edit
  const [singleCircle, setSingleCircle] = useState('');
  const [singleEventDate, setSingleEventDate] = useState('1日目');
  const [singleBlock, setSingleBlock] = useState('');
  const [singleNumber, setSingleNumber] = useState('');
  const [singleTitle, setSingleTitle] = useState('');
  const [singlePrice, setSinglePrice] = useState('0');
  const [singleRemarks, setSingleRemarks] = useState('');
  
  const isEditing = itemToEdit !== null;
  const isCreatingNew = activeEventName === null;

  useEffect(() => {
    if (isEditing) {
        setSingleCircle(itemToEdit.circle);
        setSingleEventDate(itemToEdit.eventDate);
        setSingleBlock(itemToEdit.block);
        setSingleNumber(itemToEdit.number);
        setSingleTitle(itemToEdit.title);
        setSinglePrice(itemToEdit.price === null ? '' : String(itemToEdit.price));
        setSingleRemarks(itemToEdit.remarks);
    }
  }, [itemToEdit, isEditing]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const pasteData = e.clipboardData.getData('text');
    const rows = pasteData.split('\n').filter(row => row.trim() !== '');

    const cols: { [key: string]: string[] } = {
        circles: [], eventDates: [], blocks: [], numbers: [], titles: [], prices: [],
    };

    rows.forEach(row => {
        const cells = row.split('\t');
        cols.circles.push(cells[0] || '');
        cols.eventDates.push(cells[1] || '');
        cols.blocks.push(cells[2] || '');
        cols.numbers.push(cells[3] || '');
        cols.titles.push(cells[4] || '');
        cols.prices.push(cells[5] || '');
    });

    setCircles(cols.circles.join('\n'));
    setEventDates(cols.eventDates.join('\n'));
    setBlocks(cols.blocks.join('\n'));
    setNumbers(cols.numbers.join('\n'));
    setTitles(cols.titles.join('\n'));
    setPrices(cols.prices.join('\n'));
  };

  const parseCSVLine = (line: string): string[] => {
    const cells: string[] = [];
    let currentCell = '';
    let insideQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      
      if (char === '"') {
        if (insideQuotes && line[j + 1] === '"') {
          currentCell += '"';
          j++;
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        cells.push(currentCell);
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell);
    return cells;
  };

  const processImportData = (lines: string[]): {
    items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[];
    spreadsheetUrl?: string;
    layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }>;
  } => {
    const newItems: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
    let spreadsheetUrl: string | undefined;
    const layoutInfo: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }> = [];
    
    // ヘッダー行とメタデータ行をスキップ
    let startIndex = 0;
    
    // 1行目がヘッダー行かチェック
    if (lines.length > 0 && lines[0].includes('サークル名')) {
      startIndex = 1;
    }
    
    // メタデータ行をチェック（ファイルの最後にある可能性がある）
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('#METADATA')) {
        const metadataCells = parseCSVLine(lines[i]);
        if (metadataCells.length >= 3 && metadataCells[1] === 'spreadsheetUrl') {
          spreadsheetUrl = metadataCells[2]?.trim();
        }
        // メタデータ行は処理対象から除外（既にstartIndex以降の行を処理するので問題ない）
        break;
      }
    }
    
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      // メタデータ行をスキップ
      if (line.startsWith('#METADATA')) {
        continue;
      }
      
      // ヘッダー行をスキップ（念のため再チェック）
      if (line.includes('サークル名') && line.includes('参加日') && line.includes('ブロック')) {
        continue;
      }
      
      const cells = parseCSVLine(line);
      
      // エクスポートされたCSVファイル形式（A列から始まる）を優先的にチェック
      let circle = cells[0]?.trim() || ''; // A列: サークル名
      let eventDate = cells[1]?.trim() || ''; // B列: 参加日
      let block = cells[2]?.trim() || ''; // C列: ブロック
      let number = cells[3]?.trim() || ''; // D列: ナンバー
      let title = cells[4]?.trim() || ''; // E列: タイトル
      let priceStr = cells[5]?.trim() || ''; // F列: 頒布価格
      let remarks = cells[7]?.trim() || ''; // H列: 備考
      let columnType: 'execute' | 'candidate' | null = null; // I列: 列の種類
      let order = 0; // J列: 列内順番
      
      // 配置情報がある場合（エクスポートされたCSV形式）
      if (cells.length >= 10) {
        const columnTypeStr = cells[8]?.trim() || '';
        if (columnTypeStr === '実行列') {
          columnType = 'execute';
        } else if (columnTypeStr === '候補リスト') {
          columnType = 'candidate';
        }
        order = parseInt(cells[9]?.trim() || '0', 10) || 0;
      }
      
      // A列からD列が全て入力されているかチェック
      if (!circle || !eventDate || !block || !number) {
        // スプレッドシート形式（M列から始まる）を試す
        circle = cells[12]?.trim() || ''; // M列
        eventDate = cells[13]?.trim() || ''; // N列
        block = cells[14]?.trim() || ''; // O列
        number = cells[15]?.trim() || ''; // P列
        title = cells[16]?.trim() || ''; // Q列
        priceStr = cells[17]?.trim() || ''; // R列
        remarks = cells[22]?.trim() || ''; // W列
        
        // それでも必須項目が揃わない場合はスキップ
        if (!circle || !eventDate || !block || !number) {
          continue;
        }
      }
      
      // 空欄の場合はnull、0と入力されている場合は0を設定
      const price = priceStr === '' ? null : (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0);
      
      const item: Omit<ShoppingItem, 'id' | 'purchaseStatus'> = {
        circle,
        eventDate,
        block,
        number,
        title,
        price,
        remarks,
      };
      
      newItems.push(item);
      
      // 配置情報を記録
      if (columnType && order > 0) {
        const itemKey = getItemKey(item);
        layoutInfo.push({
          itemKey,
          eventDate,
          columnType,
          order,
        });
      }
    }
    
    return {
      items: newItems,
      spreadsheetUrl,
      layoutInfo: layoutInfo.length > 0 ? layoutInfo : undefined,
    };
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const importResult = processImportData(lines);
    
    if (importResult.items.length > 0) {
      const metadata: { url?: string; layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }> } = {};
      if (importResult.spreadsheetUrl) {
        metadata.url = importResult.spreadsheetUrl;
      }
      if (importResult.layoutInfo) {
        metadata.layoutInfo = importResult.layoutInfo;
      }
      
      onBulkAdd(eventName || 'インポートリスト', importResult.items, Object.keys(metadata).length > 0 ? metadata : undefined);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      const urlMessage = importResult.spreadsheetUrl ? `スプレッドシートURLも保存されました。` : '';
      const layoutMessage = importResult.layoutInfo && importResult.layoutInfo.length > 0 ? `配置情報も復元されました。` : '';
      alert(`${importResult.items.length}件のアイテムをインポートしました。${urlMessage}${layoutMessage}`);
    } else {
      alert('インポートできるデータが見つかりませんでした。A列からD列の値が全て入力されている行が必要です。');
    }
  };

  const handleUrlImport = async () => {
    if (!spreadsheetUrl.trim()) {
      alert('スプレッドシートのURLを入力してください。');
      return;
    }

    if (!eventName.trim()) {
      alert('即売会名を入力してください。');
      return;
    }

    try {
      const sheetIdMatch = spreadsheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!sheetIdMatch) {
        throw new Error('無効なURL');
      }

      const sheetName = '品目表';
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
      
      const response = await fetch(csvUrl);
      if (!response.ok) {
        throw new Error('スプレッドシートの読み込みに失敗しました。');
      }

      const text = await response.text();
      const lines = text.split('\n').filter(line => line.trim() !== '');
      const importResult = processImportData(lines);
      
      if (importResult.items.length > 0) {
        onBulkAdd(eventName.trim(), importResult.items, { url: spreadsheetUrl, sheetName });
        setSpreadsheetUrl('');
        alert(`${importResult.items.length}件のアイテムをインポートしました。`);
      } else {
        alert('インポートできるデータが見つかりませんでした。A列からD列の値が全て入力されている行が必要です。');
      }
    } catch (error) {
      console.error('Import error:', error);
      alert('スプレッドシートのインポートに失敗しました。URLが正しいか確認してください。');
    }
  };
  
  const resetSingleForm = () => {
    setSingleCircle('');
    setSingleEventDate('1日目');
    setSingleBlock('');
    setSingleNumber('');
    setSingleTitle('');
    setSinglePrice('');
    setSingleRemarks('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isEditing) {
        if (!singleCircle.trim() && !singleTitle.trim()) {
            alert('サークル名かタイトルを入力してください。');
            return;
        }
        // 空欄の場合はnull、0と入力されている場合は0を設定
        const priceStr = String(singlePrice).trim();
        const price = priceStr === '' ? null : (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0);
        const updatedItem: ShoppingItem = {
            ...itemToEdit,
            circle: singleCircle.trim(),
            eventDate: singleEventDate,
            block: singleBlock.trim(),
            number: singleNumber.trim(),
            title: singleTitle.trim(),
            price: price,
            remarks: singleRemarks.trim(),
        };
        onUpdateItem(updatedItem);
        onDoneEditing();
        return;
    }

    if (isCreatingNew) {
      if (!eventName.trim()) {
          alert('即売会名を入力してください。');
          return;
      }
      const finalEventName = eventName.trim();
      const circlesArr = circles.split('\n').map(s => s.trim());
      const eventDatesArr = eventDates.split('\n').map(s => s.trim());
      const blocksArr = blocks.split('\n').map(s => s.trim());
      const numbersArr = numbers.split('\n').map(s => s.trim());
      const titlesArr = titles.split('\n').map(s => s.trim());
      const pricesArr = prices.split('\n').map(s => s.trim());
      const remarksArr = remarks.split('\n').map(s => s.trim());
      const numItems = Math.max(circlesArr.length, eventDatesArr.length, blocksArr.length, numbersArr.length, titlesArr.length, pricesArr.length, remarksArr.length);
      if (numItems === 0 || (circlesArr.length === 1 && circlesArr[0] === '')) {
        alert('インポートするデータがありません。');
        return;
      }
      const newItems: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
      for (let i = 0; i < numItems; i++) {
        const circle = circlesArr[i] || '';
        const eventDate = eventDatesArr[i] || '';
        const block = blocksArr[i] || '';
        const number = numbersArr[i] || '';
        // A列からD列（サークル、参加日、ブロック、ナンバー）の値が全て入力されている行のみをインポート
        if (!circle || !eventDate || !block || !number) {
          continue;
        }
        // 空欄の場合はnull、0と入力されている場合は0を設定
        const priceString = pricesArr[i] || '';
        const price = priceString === '' ? null : (parseInt(priceString.replace(/[^0-9]/g, ''), 10) || 0);
        newItems.push({
          circle, eventDate, block, number, title: titlesArr[i] || '', price: price, remarks: remarksArr[i] || '',
        });
      }
      if (newItems.length > 0) {
          onBulkAdd(finalEventName, newItems);
          setEventName(''); setCircles(''); setEventDates(''); setBlocks(''); setNumbers(''); setTitles(''); setPrices(''); setRemarks('');
      } else {
          alert('有効なアイテムデータが見つかりませんでした。A列からD列の値が全て入力されている行が必要です。');
      }
    } else { // Adding single item to existing list
        if (!singleCircle.trim() && !singleTitle.trim()) {
            alert('サークル名かタイトルを入力してください。');
            return;
        }
        // 空欄の場合はnull、0と入力されている場合は0を設定
        const priceStr = String(singlePrice).trim();
        const price = priceStr === '' ? null : (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0);
        const newItem: Omit<ShoppingItem, 'id' | 'purchaseStatus'> = {
            circle: singleCircle.trim(),
            eventDate: singleEventDate,
            block: singleBlock.trim(),
            number: singleNumber.trim(),
            title: singleTitle.trim(),
            price: price,
            remarks: singleRemarks.trim(),
        };
        onBulkAdd(activeEventName, [newItem]);
        resetSingleForm();
    }
  };

  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
        options.push(i);
    }
    return options;
  }, []);

  const formTextareaClass = "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow duration-200 h-32 resize-y font-mono text-sm";
  const formInputClass = "block w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition";
  const labelClass = "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";
  
  const handlePriceInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      // Allow only numbers
      if (/^\d*$/.test(value)) {
          setSinglePrice(value);
      }
  };
  
  const handlePriceSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSinglePrice(e.target.value);
  };
  
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg shadow-lg p-6 sm:p-8 animate-fade-in">
      <h2 className="text-xl sm:text-2xl font-bold mb-2 text-slate-900 dark:text-white text-center">
        {isEditing ? 'アイテムを編集' : isCreatingNew ? '新規リスト作成' : `「${activeEventName}」にアイテムを追加`}
      </h2>
      <p className="text-center text-slate-600 dark:text-slate-400 mb-6">
        {isCreatingNew 
          ? 'スプレッドシートのM列からR列とW列をコピーし、下の「サークル名」の欄に貼り付けてください。データが自動で振り分けられます。'
          : isEditing ? 'アイテムの情報を編集してください。' : '追加するアイテムのデータを入力してください。'
        }
      </p>
      
      <form onSubmit={handleSubmit} className="space-y-6">
        {isCreatingNew ? (
            <>
                <div>
                    <label htmlFor="eventName" className={labelClass}>即売会名</label>
                    <input 
                        type="text" 
                        id="eventName" 
                        value={eventName} 
                        onChange={e => setEventName(e.target.value)}
                        className={`mt-1 ${formInputClass.replace('p-2', 'p-2 mt-1')}`}
                        placeholder="例: C105"
                        required 
                    />
                </div>
                
                {/* インポート方法の選択 */}
                <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4">インポート方法</h3>
                  
                  {/* URLインポート */}
                  <div className="mb-4">
                    <label htmlFor="spreadsheetUrl" className={labelClass}>スプレッドシートURLからインポート</label>
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        id="spreadsheetUrl" 
                        value={spreadsheetUrl} 
                        onChange={e => setSpreadsheetUrl(e.target.value)}
                        className={formInputClass}
                        placeholder="https://docs.google.com/spreadsheets/d/..../edit"
                      />
                      <button
                        type="button"
                        onClick={handleUrlImport}
                        className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors whitespace-nowrap"
                      >
                        URLからインポート
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">シート名「品目表」のM列からR列とW列をインポートします</p>
                  </div>
                  
                  {/* CSVファイルインポート */}
                  <div className="mb-4">
                    <label htmlFor="csvFile" className={labelClass}>CSVファイルからインポート</label>
                    <input
                      type="file"
                      id="csvFile"
                      ref={fileInputRef}
                      accept=".csv"
                      onChange={handleFileImport}
                      className={formInputClass}
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">A列からD列の値が全て入力されている行のみをインポートします</p>
                  </div>
                  
                  <div className="text-center text-slate-500 dark:text-slate-400 my-4">または</div>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
                    <div className="md:col-span-1"><label htmlFor="circles" className={labelClass}>サークル名 </label><textarea id="circles" value={circles} onChange={e => setCircles(e.target.value)} onPaste={handlePaste} className={formTextareaClass} placeholder="サークルA&#10;サークルB" /></div>
                    <div className="md:col-span-1"><label htmlFor="event-dates" className={labelClass}>参加日 </label><textarea id="event-dates" value={eventDates} onChange={e => setEventDates(e.target.value)} className={formTextareaClass} placeholder="1日目&#10;2日目" /></div>
                    <div className="md:col-span-1"><label htmlFor="blocks" className={labelClass}>ブロック </label><textarea id="blocks" value={blocks} onChange={e => setBlocks(e.target.value)} className={formTextareaClass} placeholder="G&#10;カ" /></div>
                    <div className="md:col-span-1"><label htmlFor="numbers" className={labelClass}>ナンバー </label><textarea id="numbers" value={numbers} onChange={e => setNumbers(e.target.value)} className={formTextareaClass} placeholder="01a&#10;03b" /></div>
                    <div className="md:col-span-1"><label htmlFor="titles" className={labelClass}>タイトル </label><textarea id="titles" value={titles} onChange={e => setTitles(e.target.value)} className={formTextareaClass} placeholder="新刊セット&#10;既刊1" /></div>
                    <div className="md:col-span-1"><label htmlFor="prices" className={labelClass}>頒布価格 </label><textarea id="prices" value={prices} onChange={e => setPrices(e.target.value)} className={formTextareaClass} placeholder="1000&#10;500" /></div>
                </div>
                <div>
                    <label htmlFor="remarks" className={labelClass}>備考 </label>
                    <textarea id="remarks" value={remarks} onChange={e => setRemarks(e.target.value)} className={`${formTextareaClass} h-24`} placeholder="スケブお願い&#10;挨拶に行く" />
                </div>
            </>
        ) : (
            <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div><label htmlFor="singleCircle" className={labelClass}>サークル名</label><input type="text" id="singleCircle" value={singleCircle} onChange={e => setSingleCircle(e.target.value)} className={formInputClass} placeholder="サークル名" /></div>
                    <div><label htmlFor="singleTitle" className={labelClass}>タイトル</label><input type="text" id="singleTitle" value={singleTitle} onChange={e => setSingleTitle(e.target.value)} className={formInputClass} placeholder="新刊セット" /></div>
                </div>
                 <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label htmlFor="singleEventDate" className={labelClass}>参加日</label>
                        {availableEventDates.length > 0 ? (
                            <select id="singleEventDate" value={singleEventDate} onChange={e => setSingleEventDate(e.target.value)} className={formInputClass}>
                                {availableEventDates.map(date => (
                                    <option key={date} value={date}>{date}</option>
                                ))}
                            </select>
                        ) : (
                            <input 
                                type="text" 
                                id="singleEventDate" 
                                value={singleEventDate} 
                                onChange={e => setSingleEventDate(e.target.value)} 
                                className={formInputClass} 
                                placeholder="1日目" 
                            />
                        )}
                    </div>
                    <div><label htmlFor="singleBlock" className={labelClass}>ブロック</label><input type="text" id="singleBlock" value={singleBlock} onChange={e => setSingleBlock(e.target.value)} className={formInputClass} placeholder="東1" /></div>
                    <div>
                        <label htmlFor="singleNumber" className={labelClass}>ナンバー</label>
                        <input type="text" id="singleNumber" value={singleNumber} onChange={e => setSingleNumber(e.target.value)} className={formInputClass} inputMode="text" pattern="[a-zA-Z0-9-]*" placeholder="A-01a" />
                    </div>
                </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                    <div className="relative">
                        <label htmlFor="singlePrice" className={labelClass}>頒布価格</label>
                        <input
                            type="text"
                            id="singlePrice"
                            value={singlePrice}
                            onChange={handlePriceInputChange}
                            className={`${formInputClass} pr-12`}
                            placeholder="0"
                            inputMode="numeric"
                            pattern="[0-9]*"
                        />
                        <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">円</span>
                    </div>
                    <div>
                        <label htmlFor="price-quick-select" className={labelClass}>クイック選択</label>
                        <select 
                            id="price-quick-select"
                            onChange={handlePriceSelectChange}
                            className={formInputClass}
                            value={priceOptions.includes(Number(singlePrice)) ? singlePrice : ""}
                        >
                            <option value="" disabled>金額を選択...</option>
                            {priceOptions.map(p => <option key={p} value={p}>{p.toLocaleString()}円</option>)}
                        </select>
                    </div>
                </div>
                <div>
                    <label htmlFor="singleRemarks" className={labelClass}>備考</label>
                    <input type="text" id="singleRemarks" value={singleRemarks} onChange={e => setSingleRemarks(e.target.value)} className={formInputClass} placeholder="スケブお願い" />
                </div>
            </div>
        )}

        <div className="pt-4 flex flex-col sm:flex-row-reverse sm:justify-start sm:space-x-4 sm:space-x-reverse space-y-4 sm:space-y-0">
          <button
            type="submit"
            className="w-full sm:w-auto inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-slate-400 dark:disabled:bg-slate-600 disabled:cursor-not-allowed transition-colors duration-200"
          >
            {isEditing ? 'アイテムを更新' : isCreatingNew ? 'リストを作成' : 'リストに追加'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ImportScreen;

