import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ShoppingItem } from '../types';

interface ImportScreenProps {
  onBulkAdd: (eventName: string, items: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string }) => void;
  activeEventName: string | null;
  itemToEdit: ShoppingItem | null;
  onUpdateItem: (item: ShoppingItem) => void;
  onDoneEditing: () => void;
}

type ImportMode = 'paste' | 'csv' | 'sheets';

const ImportScreen: React.FC<ImportScreenProps> = ({ onBulkAdd, activeEventName, itemToEdit, onUpdateItem, onDoneEditing }) => {
  // Import mode selection
  const [importMode, setImportMode] = useState<ImportMode>('paste');
  
  // State for bulk add (creating new list)
  const [eventName, setEventName] = useState('');
  const [circles, setCircles] = useState('');
  const [eventDates, setEventDates] =useState('');
  const [blocks, setBlocks] = useState('');
  const [numbers, setNumbers] = useState('');
  const [titles, setTitles] = useState('');
  const [prices, setPrices] = useState('');
  const [remarks, setRemarks] = useState('');

  // CSV upload state
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Google Sheets state
  const [sheetsUrl, setSheetsUrl] = useState('');
  const [sheetName, setSheetName] = useState('');
  const [isLoadingSheets, setIsLoadingSheets] = useState(false);

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
        setSinglePrice(String(itemToEdit.price));
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

  // CSV file handling
  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCsvFile(file);
      parseCsvFile(file);
    }
  };

  const parseCsvFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const lines = text.split('\n').filter(line => line.trim() !== '');
      
      // Skip header if exists
      const startIndex = lines[0].includes('サークル') || lines[0].includes('circle') ? 1 : 0;
      
      const cols: { [key: string]: string[] } = {
        circles: [], eventDates: [], blocks: [], numbers: [], titles: [], prices: [], remarks: []
      };

      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
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

        // ブロックとナンバーが両方入力されている行のみ取り込む
        const block = cells[2]?.trim() || '';
        const number = cells[3]?.trim() || '';
        if (!block || !number) {
          continue; // スキップ
        }

        cols.circles.push(cells[0] || '');
        cols.eventDates.push(cells[1] || '');
        cols.blocks.push(block);
        cols.numbers.push(number);
        cols.titles.push(cells[4] || '');
        cols.prices.push((cells[5] || '0').replace(/[^0-9]/g, ''));
        cols.remarks.push(cells[7] || '');
      }

      setCircles(cols.circles.join('\n'));
      setEventDates(cols.eventDates.join('\n'));
      setBlocks(cols.blocks.join('\n'));
      setNumbers(cols.numbers.join('\n'));
      setTitles(cols.titles.join('\n'));
      setPrices(cols.prices.join('\n'));
      setRemarks(cols.remarks.join('\n'));

      alert(`${cols.circles.length}件のデータを読み込みました。`);
    };

    reader.readAsText(file, 'UTF-8');
  };

  // Google Sheets handling
  const extractSheetId = (url: string): string | null => {
    const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
  };

  const handleLoadFromSheets = async () => {
    const sheetId = extractSheetId(sheetsUrl);
    if (!sheetId) {
      alert('有効なGoogleスプレッドシートのURLを入力してください。\n例: https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit');
      return;
    }

    setIsLoadingSheets(true);

    try {
      // Use Google Sheets public CSV export
      // This only works if the sheet is publicly readable
      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv${sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : ''}`;
      
      const response = await fetch(csvUrl);
      
      if (!response.ok) {
        throw new Error('スプレッドシートの読み込みに失敗しました。\n\nスプレッドシートが「リンクを知っている全員が閲覧可」に設定されているか確認してください。');
      }

      const text = await response.text();
      const lines = text.split('\n').filter(line => line.trim() !== '');
      
      // Skip header row
      const startIndex = 1;
      
      const cols: { [key: string]: string[] } = {
        circles: [], eventDates: [], blocks: [], numbers: [], titles: [], prices: [], remarks: []
      };

      for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i];
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

        // ブロックとナンバーが両方入力されている行のみ取り込む
        const block = cells[2]?.trim() || '';
        const number = cells[3]?.trim() || '';
        if (!block || !number) {
          continue; // スキップ
        }

        // Assuming columns: サークル名, 参加日, ブロック, ナンバー, タイトル, 頒布価格, (購入状態), 備考
        cols.circles.push(cells[0] || '');
        cols.eventDates.push(cells[1] || '');
        cols.blocks.push(block);
        cols.numbers.push(number);
        cols.titles.push(cells[4] || '');
        cols.prices.push((cells[5] || '0').replace(/[^0-9]/g, ''));
        cols.remarks.push(cells[7] || '');
      }

      setCircles(cols.circles.join('\n'));
      setEventDates(cols.eventDates.join('\n'));
      setBlocks(cols.blocks.join('\n'));
      setNumbers(cols.numbers.join('\n'));
      setTitles(cols.titles.join('\n'));
      setPrices(cols.prices.join('\n'));
      setRemarks(cols.remarks.join('\n'));

      alert(`✓ ${cols.circles.length}件のデータを読み込みました。`);
      setImportMode('paste'); // Switch to paste view to show loaded data

    } catch (error) {
      console.error('Sheets loading error:', error);
      alert(error instanceof Error ? error.message : 'スプレッドシートの読み込みに失敗しました。');
    } finally {
      setIsLoadingSheets(false);
    }
  };
  
  const resetSingleForm = () => {
    setSingleCircle('');
    setSingleEventDate('1日目');
    setSingleBlock('');
    setSingleNumber('');
    setSingleTitle('');
    setSinglePrice('0');
    setSingleRemarks('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isEditing) {
        if (!singleCircle.trim() && !singleTitle.trim()) {
            alert('サークル名かタイトルを入力してください。');
            return;
        }
        const price = parseInt(String(singlePrice).replace(/[^0-9]/g, ''), 10) || 0;
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
        const block = blocksArr[i] || '';
        const number = numbersArr[i] || '';
        if (!circle && !block && !number && !titlesArr[i]) {
          continue;
        }
        const priceString = (pricesArr[i] || '0').replace(/[^0-9]/g, '');
        const price = parseInt(priceString, 10) || 0;
        newItems.push({
          circle, eventDate: eventDatesArr[i] || '1日目', block, number, title: titlesArr[i] || '', price: price, remarks: remarksArr[i] || '',
        });
      }
      if (newItems.length > 0) {
          // メタデータを渡す
          const metadata = sheetsUrl ? { url: sheetsUrl, sheetName: sheetName } : undefined;
          onBulkAdd(finalEventName, newItems, metadata);
          setEventName(''); setCircles(''); setEventDates(''); setBlocks(''); setNumbers(''); setTitles(''); setPrices(''); setRemarks('');
          setCsvFile(null);
          setSheetsUrl('');
          setSheetName('');
      } else {
          alert('有効なアイテムデータが見つかりませんでした。必須項目が入力されているか確認してください。');
      }
    } else { // Adding single item to existing list
        if (!singleCircle.trim() && !singleTitle.trim()) {
            alert('サークル名かタイトルを入力してください。');
            return;
        }
        const price = parseInt(String(singlePrice).replace(/[^0-9]/g, ''), 10) || 0;
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
    for (let i = 100; i <= 10000; i += 100) {
        options.push(i);
    }
    return options;
  }, []);

  const formTextareaClass = "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-shadow duration-200 h-32 resize-y font-mono text-sm";
  const formInputClass = "block w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition";
  const labelClass = "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";
  
  const handlePriceInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
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
      
      {isCreatingNew && !isEditing && (
        <div className="mb-6">
          <div className="flex justify-center space-x-2 mb-4">
            <button
              onClick={() => setImportMode('paste')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                importMode === 'paste'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'
              }`}
            >
              📋 コピー&ペースト
            </button>
            <button
              onClick={() => setImportMode('csv')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                importMode === 'csv'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'
              }`}
            >
              📄 CSVファイル
            </button>
            <button
              onClick={() => setImportMode('sheets')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                importMode === 'sheets'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'
              }`}
            >
              📊 スプレッドシート
            </button>
          </div>

          {importMode === 'csv' && (
            <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-md border border-blue-200 dark:border-blue-800">
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-3">
                他のデバイスで出力したCSVファイルをアップロードしてデータをインポートできます。
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleCsvFileChange}
                className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/50 dark:file:text-blue-300"
              />
              {csvFile && (
                <p className="mt-2 text-sm text-green-600 dark:text-green-400">
                  ✓ {csvFile.name} を読み込みました
                </p>
              )}
            </div>
          )}

          {importMode === 'sheets' && (
            <div className="mb-6 p-4 bg-green-50 dark:bg-green-900/20 rounded-md border border-green-200 dark:border-green-800">
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-3">
                Googleスプレッドシートから直接データを読み込みます。
              </p>
              <div className="space-y-3">
                <div>
                  <label className={labelClass}>スプレッドシートURL</label>
                  <input
                    type="url"
                    value={sheetsUrl}
                    onChange={(e) => setSheetsUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/..."
                    className={formInputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>シート名（オプション）</label>
                  <input
                    type="text"
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                    placeholder="空欄の場合は最初のシート"
                    className={formInputClass}
                  />
                </div>
                <button
                  onClick={handleLoadFromSheets}
                  disabled={!sheetsUrl || isLoadingSheets}
                  className="w-full px-4 py-2 text-sm font-semibold rounded-md text-white bg-green-600 hover:bg-green-700 disabled:bg-slate-400 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoadingSheets ? '読み込み中...' : '📊 スプレッドシートから読み込む'}
                </button>
              </div>
              <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded border border-yellow-200 dark:border-yellow-800">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  <strong>⚠️ 重要:</strong> スプレッドシートの共有設定を「リンクを知っている全員が閲覧可」にしてください。
                  <br />
                  列の順序: サークル名 | 参加日 | ブロック | ナンバー | タイトル | 頒布価格 | (購入状態) | 備考
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-center text-slate-600 dark:text-slate-400 mb-6">
        {isCreatingNew 
          ? importMode === 'paste' 
            ? 'スプレッドシートのM列からR列をコピーし、下の「サークル名」の欄に貼り付けてください。データが自動で振り分けられます。'
            : importMode === 'csv'
            ? 'CSVファイルを選択すると、自動的にデータが読み込まれます。'
            : 'スプレッドシートのURLを入力して読み込んでください。'
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
                <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
                    <div className="md:col-span-1"><label htmlFor="circles" className={labelClass}>サークル名 (M)</label><textarea id="circles" value={circles} onChange={e => setCircles(e.target.value)} onPaste={handlePaste} className={formTextareaClass} placeholder="サークルA&#10;サークルB" /></div>
                    <div className="md:col-span-1"><label htmlFor="event-dates" className={labelClass}>参加日 (N)</label><textarea id="event-dates" value={eventDates} onChange={e => setEventDates(e.target.value)} className={formTextareaClass} placeholder="1日目&#10;2日目" /></div>
                    <div className="md:col-span-1"><label htmlFor="blocks" className={labelClass}>ブロック (O)</label><textarea id="blocks" value={blocks} onChange={e => setBlocks(e.target.value)} className={formTextareaClass} placeholder="東1&#10;西3" /></div>
                    <div className="md:col-span-1"><label htmlFor="numbers" className={labelClass}>ナンバー (P)</label><textarea id="numbers" value={numbers} onChange={e => setNumbers(e.target.value)} className={formTextareaClass} placeholder="A-01a&#10;C-03a" /></div>
                    <div className="md:col-span-1"><label htmlFor="titles" className={labelClass}>タイトル (Q)</label><textarea id="titles" value={titles} onChange={e => setTitles(e.target.value)} className={formTextareaClass} placeholder="新刊セット&#10;既刊1" /></div>
                    <div className="md:col-span-1"><label htmlFor="prices" className={labelClass}>頒布価格 (R)</label><textarea id="prices" value={prices} onChange={e => setPrices(e.target.value)} className={formTextareaClass} placeholder="1000&#10;500" /></div>
                </div>
                <div>
                    <label htmlFor="remarks" className={labelClass}>備考 (W列)</label>
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
                        <select id="singleEventDate" value={singleEventDate} onChange={e => setSingleEventDate(e.target.value)} className={formInputClass}>
                            <option value="1日目">1日目</option>
                            <option value="2日目">2日目</option>
                        </select>
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
