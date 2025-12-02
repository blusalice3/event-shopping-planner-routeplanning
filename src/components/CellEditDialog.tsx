import React, { useState, useEffect } from 'react';
import { ShoppingItem } from '../types';

interface CellEditDialogProps {
  cellAddress: string; // 例: "ク-19a"
  eventDate: string; // 例: "1日目"
  number: string; // セルの数値
  block?: string; // ブロック値（のちに実装）
  items: ShoppingItem[]; // このセルに関連するアイテム
  onSave: (eventDate: string, number: string, block: string | undefined, side: 'A' | 'B', data: {
    circle: string;
    title: string;
    price: number | null;
  }) => void;
  onCancel: () => void;
}

const CellEditDialog: React.FC<CellEditDialogProps> = ({
  cellAddress,
  eventDate,
  number,
  block,
  items,
  onSave,
  onCancel,
}) => {
  const [aSideCircle, setASideCircle] = useState('');
  const [aSideTitle, setASideTitle] = useState('');
  const [aSidePrice, setASidePrice] = useState<string>('');
  const [bSideCircle, setBSideCircle] = useState('');
  const [bSideTitle, setBSideTitle] = useState('');
  const [bSidePrice, setBSidePrice] = useState<string>('');

  // アイテムから初期値を設定
  useEffect(() => {
    // A側とB側のアイテムを分ける
    // 暫定的に、最初のアイテムをA側、2つ目のアイテムをB側とする
    const aSideItem = items[0];
    const bSideItem = items[1];

    // A側のアイテムから値を取得
    if (aSideItem) {
      setASideCircle(aSideItem.circle || '');
      setASideTitle(aSideItem.title || '');
      setASidePrice(aSideItem.price !== null ? String(aSideItem.price) : '');
    }

    // B側のアイテムから値を取得
    if (bSideItem) {
      setBSideCircle(bSideItem.circle || '');
      setBSideTitle(bSideItem.title || '');
      setBSidePrice(bSideItem.price !== null ? String(bSideItem.price) : '');
    }
  }, [items]);

  const handleSave = () => {
    // A側の保存
    const aPrice = aSidePrice.trim() === '' ? null : (isNaN(Number(aSidePrice)) ? null : Number(aSidePrice));
    onSave(eventDate, number, block, 'A', {
      circle: aSideCircle.trim(),
      title: aSideTitle.trim(),
      price: aPrice,
    });

    // B側の保存（値が入力されている場合のみ）
    if (bSideCircle.trim() || bSideTitle.trim() || bSidePrice.trim()) {
      const bPrice = bSidePrice.trim() === '' ? null : (isNaN(Number(bSidePrice)) ? null : Number(bSidePrice));
      onSave(eventDate, number, block, 'B', {
        circle: bSideCircle.trim(),
        title: bSideTitle.trim(),
        price: bPrice,
      });
    }

    onCancel();
  };

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onCancel}
    >
      <div 
        className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
            {cellAddress}
          </h2>
          
          <div className="space-y-6">
            {/* A側セクション */}
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">
                A側
              </h3>
              <div className="space-y-3">
                <div>
                  <label 
                    htmlFor="aSideCircle" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    サークル名
                  </label>
                  <input
                    type="text"
                    id="aSideCircle"
                    value={aSideCircle}
                    onChange={(e) => setASideCircle(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="サークル名を入力"
                  />
                </div>
                <div>
                  <label 
                    htmlFor="aSideTitle" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    タイトル
                  </label>
                  <input
                    type="text"
                    id="aSideTitle"
                    value={aSideTitle}
                    onChange={(e) => setASideTitle(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="タイトルを入力"
                  />
                </div>
                <div>
                  <label 
                    htmlFor="aSidePrice" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    頒布価格
                  </label>
                  <input
                    type="number"
                    id="aSidePrice"
                    value={aSidePrice}
                    onChange={(e) => setASidePrice(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="価格を入力（数値のみ）"
                    min="0"
                  />
                </div>
              </div>
            </div>

            {/* B側セクション */}
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">
                B側
              </h3>
              <div className="space-y-3">
                <div>
                  <label 
                    htmlFor="bSideCircle" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    サークル名
                  </label>
                  <input
                    type="text"
                    id="bSideCircle"
                    value={bSideCircle}
                    onChange={(e) => setBSideCircle(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="サークル名を入力"
                  />
                </div>
                <div>
                  <label 
                    htmlFor="bSideTitle" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    タイトル
                  </label>
                  <input
                    type="text"
                    id="bSideTitle"
                    value={bSideTitle}
                    onChange={(e) => setBSideTitle(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="タイトルを入力"
                  />
                </div>
                <div>
                  <label 
                    htmlFor="bSidePrice" 
                    className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    頒布価格
                  </label>
                  <input
                    type="number"
                    id="bSidePrice"
                    value={bSidePrice}
                    onChange={(e) => setBSidePrice(e.target.value)}
                    className="w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="価格を入力（数値のみ）"
                    min="0"
                  />
                </div>
              </div>
            </div>

            {/* 関連アイテムの表示 */}
            {items.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
                <h4 className="text-sm font-semibold text-slate-900 dark:text-white mb-2">
                  関連アイテム ({items.length}件)
                </h4>
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {items.map((item) => (
                    <div 
                      key={item.id}
                      className="text-xs text-slate-600 dark:text-slate-400 p-2 bg-slate-50 dark:bg-slate-700/50 rounded"
                    >
                      <div className="font-medium">{item.circle} - {item.title || '(タイトルなし)'}</div>
                      {item.price !== null && (
                        <div>¥{item.price.toLocaleString()}</div>
                      )}
                      <div className="text-slate-500 dark:text-slate-500">
                        {item.block && `ブロック: ${item.block}`} {item.number && `ナンバー: ${item.number}`}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3 pt-6 mt-6 border-t border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium rounded-md text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 dark:text-slate-300 dark:bg-slate-700 dark:border-slate-600 dark:hover:bg-slate-600 transition-colors"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CellEditDialog;
