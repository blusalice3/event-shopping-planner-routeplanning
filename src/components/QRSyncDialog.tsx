import React, { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import pako from 'pako';
import {
  ShoppingItem,
  DayMapData,
  BlockDefinition,
  HallDefinition,
  HallRouteSettings,
  ExecuteModeItems,
} from '../types';

// 転送データ形式
interface SyncData {
  version: string;
  exportDate: string;
  eventName: string;
  items: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
  mapData?: { [dayMapName: string]: DayMapData };
  blockDefinitions?: { [dayMapName: string]: BlockDefinition[] };
  hallDefinitions?: { [dayMapName: string]: HallDefinition[] };
  hallRouteSettings?: { [dayMapName: string]: HallRouteSettings };
}

// QRパケット形式
interface TransferPacket {
  v: string;      // バージョン
  sid: string;    // セッションID
  t: number;      // 総パート数
  i: number;      // 現在のパートインデックス
  cs?: string;    // チェックサム（最終パートのみ）
  d: string;      // データ断片
}

interface QRSyncDialogProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'send' | 'receive' | null;
  eventName: string;
  // 送信用データ
  items?: ShoppingItem[];
  executeModeItems?: ExecuteModeItems;
  mapData?: { [dayMapName: string]: DayMapData };
  blockDefinitions?: { [dayMapName: string]: BlockDefinition[] };
  hallDefinitions?: { [dayMapName: string]: HallDefinition[] };
  hallRouteSettings?: { [dayMapName: string]: HallRouteSettings };
  // 受信完了時のコールバック
  onReceiveComplete?: (data: SyncData) => void;
}

const PACKET_SIZE = 500; // 1パートあたりのデータサイズ（小さくして読み取りやすく）
const QR_INTERVAL = 800; // QRコード切替間隔（ミリ秒）- 読み取り時間を確保

// セッションID生成（8文字）
const generateSessionId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// 簡易チェックサム（先頭8文字）
const generateChecksum = (data: string): string => {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
};

// データ圧縮・エンコード
const compressAndEncode = (data: SyncData): string => {
  const jsonStr = JSON.stringify(data);
  console.log('圧縮前サイズ:', jsonStr.length, 'bytes');
  const compressed = pako.gzip(jsonStr);
  console.log('圧縮後サイズ:', compressed.length, 'bytes');
  // Uint8Array → Base64
  const binary = String.fromCharCode(...compressed);
  const encoded = btoa(binary);
  console.log('Base64サイズ:', encoded.length, 'bytes');
  return encoded;
};

// データ解凍・デコード
const decodeAndDecompress = (encoded: string): SyncData => {
  console.log('解凍開始、エンコードデータ長:', encoded.length);
  // Base64 → Uint8Array
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const decompressed = pako.ungzip(bytes, { to: 'string' });
  console.log('解凍完了、JSONサイズ:', decompressed.length);
  return JSON.parse(decompressed);
};

// データを分割
const splitData = (encodedData: string, sessionId: string): TransferPacket[] => {
  const packets: TransferPacket[] = [];
  const totalParts = Math.ceil(encodedData.length / PACKET_SIZE);
  const checksum = generateChecksum(encodedData);
  console.log('パケット分割:', totalParts, '個、チェックサム:', checksum);
  
  for (let i = 0; i < totalParts; i++) {
    const start = i * PACKET_SIZE;
    const end = Math.min(start + PACKET_SIZE, encodedData.length);
    const packet: TransferPacket = {
      v: '1',
      sid: sessionId,
      t: totalParts,
      i: i,
      d: encodedData.substring(start, end),
    };
    // 最終パートにチェックサムを追加
    if (i === totalParts - 1) {
      packet.cs = checksum;
    }
    packets.push(packet);
  }
  
  return packets;
};

const QRSyncDialog: React.FC<QRSyncDialogProps> = ({
  isOpen,
  onClose,
  mode,
  eventName,
  items = [],
  executeModeItems = {},
  mapData,
  blockDefinitions,
  hallDefinitions,
  hallRouteSettings,
  onReceiveComplete,
}) => {
  // 送信用state
  const [sendOptions, setSendOptions] = useState({
    includeItems: true,
    includeVisitList: true,
    includeMapData: false,
    includeBlockDefinitions: false,
    includeHallDefinitions: false,
  });
  const [packets, setPackets] = useState<TransferPacket[]>([]);
  const [currentPacketIndex, setCurrentPacketIndex] = useState(0);
  const [sessionId, setSessionId] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [estimatedSize, setEstimatedSize] = useState(0);
  const [estimatedQRCount, setEstimatedQRCount] = useState(0);
  
  // 受信用state
  const [isScanning, setIsScanning] = useState(false);
  const [receivedPackets, setReceivedPackets] = useState<Map<number, string>>(new Map());
  const [receiveSessionId, setReceiveSessionId] = useState<string | null>(null);
  const [totalPackets, setTotalPackets] = useState(0);
  const [receiveChecksum, setReceiveChecksum] = useState<string | null>(null);
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receivedData, setReceivedData] = useState<SyncData | null>(null);
  const [importMode, setImportMode] = useState<'overwrite' | 'merge' | 'new'>('overwrite');
  
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const intervalRef = useRef<number | null>(null);
  const scannerContainerRef = useRef<HTMLDivElement>(null);

  // 推定サイズ計算
  useEffect(() => {
    if (mode !== 'send') return;
    
    const data: Partial<SyncData> = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      eventName,
    };
    
    if (sendOptions.includeItems) {
      data.items = items;
    } else {
      data.items = [];
    }
    
    if (sendOptions.includeVisitList) {
      data.executeModeItems = executeModeItems;
    } else {
      data.executeModeItems = {};
    }
    
    // mapDataは { [dayMapName: string]: DayMapData } 形式
    if (sendOptions.includeMapData && mapData && Object.keys(mapData).length > 0) {
      data.mapData = mapData;
    }
    
    if (sendOptions.includeBlockDefinitions && blockDefinitions && Object.keys(blockDefinitions).length > 0) {
      data.blockDefinitions = blockDefinitions;
    }
    
    if (sendOptions.includeHallDefinitions) {
      if (hallDefinitions && Object.keys(hallDefinitions).length > 0) {
        data.hallDefinitions = hallDefinitions;
      }
      if (hallRouteSettings && Object.keys(hallRouteSettings).length > 0) {
        data.hallRouteSettings = hallRouteSettings;
      }
    }
    
    try {
      const encoded = compressAndEncode(data as SyncData);
      setEstimatedSize(Math.round(encoded.length / 1024 * 10) / 10);
      setEstimatedQRCount(Math.ceil(encoded.length / PACKET_SIZE));
    } catch (err) {
      console.error('推定サイズ計算エラー:', err);
      setEstimatedSize(0);
      setEstimatedQRCount(0);
    }
  }, [mode, sendOptions, items, executeModeItems, mapData, blockDefinitions, hallDefinitions, hallRouteSettings, eventName]);

  // QRコード生成開始
  const startSending = useCallback(() => {
    const data: SyncData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      eventName,
      items: sendOptions.includeItems ? items : [],
      executeModeItems: sendOptions.includeVisitList ? executeModeItems : {},
    };
    
    if (sendOptions.includeMapData && mapData && Object.keys(mapData).length > 0) {
      data.mapData = mapData;
    }
    if (sendOptions.includeBlockDefinitions && blockDefinitions && Object.keys(blockDefinitions).length > 0) {
      data.blockDefinitions = blockDefinitions;
    }
    if (sendOptions.includeHallDefinitions) {
      if (hallDefinitions && Object.keys(hallDefinitions).length > 0) {
        data.hallDefinitions = hallDefinitions;
      }
      if (hallRouteSettings && Object.keys(hallRouteSettings).length > 0) {
        data.hallRouteSettings = hallRouteSettings;
      }
    }
    
    try {
      const encoded = compressAndEncode(data);
      const sid = generateSessionId();
      const pkts = splitData(encoded, sid);
      
      setSessionId(sid);
      setPackets(pkts);
      setCurrentPacketIndex(0);
      setIsSending(true);
    } catch (error) {
      console.error('データ圧縮エラー:', error);
      alert('データの圧縮に失敗しました');
    }
  }, [sendOptions, items, executeModeItems, mapData, blockDefinitions, hallDefinitions, hallRouteSettings, eventName]);

  // QRコード表示ループ
  useEffect(() => {
    if (!isSending || packets.length === 0 || !qrCanvasRef.current) return;
    
    const renderQR = async (index: number) => {
      const packet = packets[index];
      const packetStr = JSON.stringify(packet);
      
      try {
        await QRCode.toCanvas(qrCanvasRef.current, packetStr, {
          width: 320,
          margin: 4,
          errorCorrectionLevel: 'M', // エラー訂正レベルを上げる
          color: {
            dark: '#000000',
            light: '#FFFFFF',
          },
        });
      } catch (error) {
        console.error('QR生成エラー:', error, 'パケットサイズ:', packetStr.length);
      }
    };
    
    renderQR(currentPacketIndex);
    
    intervalRef.current = window.setInterval(() => {
      setCurrentPacketIndex((prev) => (prev + 1) % packets.length);
    }, QR_INTERVAL);
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isSending, packets, currentPacketIndex]);

  // 送信停止
  const stopSending = useCallback(() => {
    setIsSending(false);
    setPackets([]);
    setCurrentPacketIndex(0);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  }, []);

  // スキャン開始（UIの状態のみ変更、実際の開始はuseEffectで）
  const startScanning = useCallback(() => {
    setReceiveError(null);
    setReceivedPackets(new Map());
    setReceiveSessionId(null);
    setTotalPackets(0);
    setReceiveChecksum(null);
    setReceivedData(null);
    setIsScanning(true);
  }, []);

  // スキャナーの実際の開始（DOMにコンテナが存在してから）
  useEffect(() => {
    if (!isScanning || scannerRef.current) return;
    
    // DOMにコンテナが追加されるのを待つ
    const timer = setTimeout(async () => {
      const container = document.getElementById('qr-scanner-container');
      if (!container) {
        console.error('スキャナーコンテナが見つかりません');
        setReceiveError('カメラの初期化に失敗しました。');
        setIsScanning(false);
        return;
      }
      
      try {
        const scanner = new Html5Qrcode('qr-scanner-container');
        scannerRef.current = scanner;
        
        // カメラデバイスを取得
        const devices = await Html5Qrcode.getCameras();
        console.log('利用可能なカメラ:', devices);
        
        if (devices && devices.length > 0) {
          // バックカメラを優先的に選択
          const backCamera = devices.find(d => 
            d.label.toLowerCase().includes('back') || 
            d.label.toLowerCase().includes('rear') ||
            d.label.toLowerCase().includes('環境')
          );
          const cameraId = backCamera ? backCamera.id : devices[0].id;
          
          await scanner.start(
            cameraId,
            {
              fps: 10,
              qrbox: { width: 250, height: 250 },
            },
            (decodedText) => {
              console.log('QRコード検出! データ長:', decodedText.length);
              try {
                const packet: TransferPacket = JSON.parse(decodedText);
                console.log('パケット解析成功:', {
                  version: packet.v,
                  sessionId: packet.sid,
                  index: packet.i,
                  total: packet.t,
                  hasChecksum: !!packet.cs,
                  dataLength: packet.d?.length
                });
                
                // バージョンチェック
                if (packet.v !== '1') {
                  console.log('バージョン不一致:', packet.v);
                  return;
                }
                
                setReceiveSessionId((prevSid) => {
                  // 新しいセッションの場合はリセット
                  if (prevSid && prevSid !== packet.sid) {
                    console.log('新しいセッション検出、リセット');
                    setReceivedPackets(new Map());
                    setReceiveChecksum(null);
                  }
                  return packet.sid;
                });
                
                setTotalPackets(packet.t);
                
                // チェックサムを保存
                if (packet.cs) {
                  console.log('チェックサム受信:', packet.cs);
                  setReceiveChecksum(packet.cs);
                }
                
                // パケットを保存
                setReceivedPackets((prev) => {
                  const newMap = new Map(prev);
                  if (!newMap.has(packet.i)) {
                    console.log(`パケット ${packet.i + 1}/${packet.t} を保存`);
                    newMap.set(packet.i, packet.d);
                  }
                  return newMap;
                });
              } catch (e) {
                console.log('パースエラー:', e, 'データ:', decodedText.substring(0, 100));
              }
            },
            _errorMessage => {
              // スキャン中のエラー（QRコードが見つからない等）は頻繁に発生するので無視
            }
          );
          
          console.log('カメラ起動成功');
        } else {
          // デバイスリストが取得できない場合、facingModeで試行
          console.log('デバイスリストが空、facingModeで試行');
          await scanner.start(
            { facingMode: 'environment' },
            {
              fps: 10,
              qrbox: { width: 250, height: 250 },
            },
            (decodedText) => {
              console.log('QRコード検出(facingMode)! データ長:', decodedText.length);
              try {
                const packet: TransferPacket = JSON.parse(decodedText);
                console.log('パケット解析成功:', {
                  version: packet.v,
                  sessionId: packet.sid,
                  index: packet.i,
                  total: packet.t,
                  hasChecksum: !!packet.cs,
                  dataLength: packet.d?.length
                });
                
                if (packet.v !== '1') {
                  console.log('バージョン不一致:', packet.v);
                  return;
                }
                
                setReceiveSessionId((prevSid) => {
                  if (prevSid && prevSid !== packet.sid) {
                    console.log('新しいセッション検出、リセット');
                    setReceivedPackets(new Map());
                    setReceiveChecksum(null);
                  }
                  return packet.sid;
                });
                
                setTotalPackets(packet.t);
                
                if (packet.cs) {
                  console.log('チェックサム受信:', packet.cs);
                  setReceiveChecksum(packet.cs);
                }
                
                setReceivedPackets((prev) => {
                  const newMap = new Map(prev);
                  if (!newMap.has(packet.i)) {
                    console.log(`パケット ${packet.i + 1}/${packet.t} を保存`);
                    newMap.set(packet.i, packet.d);
                  }
                  return newMap;
                });
              } catch (e) {
                console.log('パースエラー:', e, 'データ:', decodedText.substring(0, 100));
              }
            },
            _errorMessage => {
              // スキャン中のエラーは無視
            }
          );
          
          console.log('カメラ起動成功（facingMode）');
        }
      } catch (error) {
        console.error('スキャン開始エラー:', error);
        const errorMessage = error instanceof Error ? error.message : '不明なエラー';
        setReceiveError(`カメラの起動に失敗しました: ${errorMessage}`);
        setIsScanning(false);
        scannerRef.current = null;
      }
    }, 100); // DOMの更新を待つ
    
    return () => clearTimeout(timer);
  }, [isScanning]);

  // スキャン停止
  const stopScanning = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
      } catch {
        // 停止エラーは無視
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  }, []);

  // 全パケット受信完了チェック
  useEffect(() => {
    console.log(`受信状況チェック: ${receivedPackets.size}/${totalPackets}`);
    if (totalPackets === 0 || receivedPackets.size < totalPackets) return;
    
    console.log('全パケット受信完了！データ結合中...');
    
    // 全パケット揃った
    const sortedParts = Array.from({ length: totalPackets }, (_, i) => receivedPackets.get(i) || '');
    const fullData = sortedParts.join('');
    console.log('結合データ長:', fullData.length);
    
    // チェックサム検証
    if (receiveChecksum) {
      const calculatedChecksum = generateChecksum(fullData);
      console.log('チェックサム比較:', { expected: receiveChecksum, calculated: calculatedChecksum });
      if (calculatedChecksum !== receiveChecksum) {
        console.error('チェックサム不一致！');
        setReceiveError('データが破損しています。再度送信してください。');
        return;
      }
      console.log('チェックサム検証OK');
    }
    
    try {
      console.log('データ解凍開始...');
      const data = decodeAndDecompress(fullData);
      console.log('データ解凍成功:', { eventName: data.eventName, itemCount: data.items?.length });
      setReceivedData(data);
      stopScanning();
    } catch (error) {
      console.error('データ解凍エラー:', error);
      setReceiveError('データの解凍に失敗しました。');
    }
  }, [receivedPackets, totalPackets, receiveChecksum, stopScanning]);

  // インポート実行
  const handleImport = useCallback(() => {
    if (receivedData && onReceiveComplete) {
      onReceiveComplete(receivedData);
      onClose();
    }
  }, [receivedData, onReceiveComplete, onClose]);

  // ダイアログを閉じる時のクリーンアップ
  useEffect(() => {
    if (!isOpen) {
      stopSending();
      stopScanning();
    }
  }, [isOpen, stopSending, stopScanning]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">
            {mode === 'send' ? 'QRコードで送信' : 'QRコードで受信'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* コンテンツ */}
        <div className="p-4">
          {mode === 'send' && !isSending && (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                送信するイベント: <span className="font-semibold text-slate-900 dark:text-white">{eventName}</span>
              </p>
              
              <div className="space-y-3 mb-4">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">送信データ:</p>
                <label className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={sendOptions.includeItems}
                    onChange={(e) => setSendOptions(prev => ({ ...prev, includeItems: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">
                    アイテムリスト ({items.length}件)
                  </span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={sendOptions.includeVisitList}
                    onChange={(e) => setSendOptions(prev => ({ ...prev, includeVisitList: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">訪問先リスト</span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={sendOptions.includeMapData}
                    onChange={(e) => setSendOptions(prev => ({ ...prev, includeMapData: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    disabled={!mapData || Object.keys(mapData).length === 0}
                  />
                  <span className={`text-sm ${!mapData || Object.keys(mapData).length === 0 ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    マップデータ {(!mapData || Object.keys(mapData).length === 0) && '(なし)'}
                  </span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={sendOptions.includeBlockDefinitions}
                    onChange={(e) => setSendOptions(prev => ({ ...prev, includeBlockDefinitions: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    disabled={!blockDefinitions || Object.keys(blockDefinitions).length === 0}
                  />
                  <span className={`text-sm ${!blockDefinitions || Object.keys(blockDefinitions).length === 0 ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    ブロック定義 {(!blockDefinitions || Object.keys(blockDefinitions).length === 0) && '(なし)'}
                  </span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="checkbox"
                    checked={sendOptions.includeHallDefinitions}
                    onChange={(e) => setSendOptions(prev => ({ ...prev, includeHallDefinitions: e.target.checked }))}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    disabled={!hallDefinitions || Object.keys(hallDefinitions).length === 0}
                  />
                  <span className={`text-sm ${!hallDefinitions || Object.keys(hallDefinitions).length === 0 ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}`}>
                    ホール定義 {(!hallDefinitions || Object.keys(hallDefinitions).length === 0) && '(なし)'}
                  </span>
                </label>
              </div>
              
              <div className="bg-slate-100 dark:bg-slate-700 rounded-lg p-3 mb-4">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  推定サイズ: <span className="font-semibold">{estimatedSize}KB</span>
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  QRコード: <span className="font-semibold">{estimatedQRCount}枚</span>
                  <span className="text-xs ml-2">(約{Math.ceil(estimatedQRCount * QR_INTERVAL / 1000)}秒)</span>
                </p>
              </div>
              
              <button
                onClick={startSending}
                disabled={!sendOptions.includeItems && !sendOptions.includeVisitList}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-semibold rounded-lg transition-colors"
              >
                QRコード生成開始
              </button>
            </>
          )}

          {mode === 'send' && isSending && (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 text-center">
                受信端末のカメラをこの画面に向けてください
              </p>
              
              <div className="flex justify-center mb-4 bg-white p-2 rounded-lg">
                <canvas ref={qrCanvasRef} className="border-2 border-slate-300 rounded-lg" />
              </div>
              
              <div className="text-center mb-4 p-3 bg-slate-100 dark:bg-slate-700 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                  セッションID: <span className="font-mono font-semibold text-blue-600">{sessionId}</span>
                </p>
                <p className="text-lg font-bold text-slate-700 dark:text-slate-300">
                  パート {currentPacketIndex + 1} / {packets.length}
                </p>
                <div className="w-full bg-slate-300 dark:bg-slate-600 rounded-full h-3 mt-2">
                  <div
                    className="bg-blue-500 h-3 rounded-full transition-all duration-200"
                    style={{ width: `${((currentPacketIndex + 1) / packets.length) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                  更新間隔: {QR_INTERVAL}ms / パケットサイズ: {PACKET_SIZE}文字
                </p>
              </div>
              
              <button
                onClick={stopSending}
                className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 font-semibold rounded-lg transition-colors"
              >
                中止
              </button>
            </>
          )}

          {mode === 'receive' && !isScanning && !receivedData && (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                送信端末のQRコードをカメラで読み取ります
              </p>
              
              {receiveError && (
                <div className="bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{receiveError}</p>
                </div>
              )}
              
              <button
                onClick={startScanning}
                className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors"
              >
                カメラを起動してスキャン開始
              </button>
            </>
          )}

          {mode === 'receive' && isScanning && (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4 text-center">
                送信端末のQRコードをカメラで読み取ってください
              </p>
              
              <div 
                id="qr-scanner-container" 
                ref={scannerContainerRef}
                className="w-full aspect-square mb-4 rounded-lg overflow-hidden bg-black"
                style={{ minHeight: '280px' }}
              />
              
              {/* デバッグ情報（常に表示） */}
              <div className="text-center mb-4 p-3 bg-slate-100 dark:bg-slate-700 rounded-lg">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                  スキャン状態: <span className="font-semibold text-green-600">アクティブ</span>
                </p>
                {receiveSessionId ? (
                  <>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                      セッションID: <span className="font-mono font-semibold text-blue-600">{receiveSessionId}</span>
                    </p>
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      受信: {receivedPackets.size} / {totalPackets} パート
                    </p>
                    <div className="w-full bg-slate-300 dark:bg-slate-600 rounded-full h-3 mt-2">
                      <div
                        className="bg-green-500 h-3 rounded-full transition-all duration-200"
                        style={{ width: totalPackets > 0 ? `${(receivedPackets.size / totalPackets) * 100}%` : '0%' }}
                      />
                    </div>
                    {receivedPackets.size > 0 && (
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                        受信済みパート: {Array.from(receivedPackets.keys()).sort((a, b) => a - b).map(i => i + 1).join(', ')}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    QRコードを待機中...
                  </p>
                )}
              </div>
              
              {receiveError && (
                <div className="bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg p-3 mb-4">
                  <p className="text-sm text-red-700 dark:text-red-300">{receiveError}</p>
                </div>
              )}
              
              <button
                onClick={stopScanning}
                className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 font-semibold rounded-lg transition-colors"
              >
                中止
              </button>
            </>
          )}

          {mode === 'receive' && receivedData && (
            <>
              <div className="flex items-center justify-center mb-4">
                <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
              
              <p className="text-center text-lg font-semibold text-slate-900 dark:text-white mb-4">
                データを受信しました
              </p>
              
              <div className="bg-slate-100 dark:bg-slate-700 rounded-lg p-3 mb-4">
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  イベント: <span className="font-semibold text-slate-900 dark:text-white">{receivedData.eventName}</span>
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  アイテム: <span className="font-semibold">{receivedData.items?.length || 0}件</span>
                </p>
                {receivedData.executeModeItems && Object.keys(receivedData.executeModeItems).length > 0 && (
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    訪問先: {Object.entries(receivedData.executeModeItems).map(([day, ids]) => (
                      <span key={day}>{day} {ids.length}件 </span>
                    ))}
                  </p>
                )}
                {receivedData.mapData && (
                  <p className="text-sm text-slate-600 dark:text-slate-400">マップデータ: あり</p>
                )}
                {receivedData.blockDefinitions && (
                  <p className="text-sm text-slate-600 dark:text-slate-400">ブロック定義: あり</p>
                )}
                {receivedData.hallDefinitions && (
                  <p className="text-sm text-slate-600 dark:text-slate-400">ホール定義: あり</p>
                )}
              </div>
              
              <div className="space-y-2 mb-4">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">インポート方法:</p>
                <label className="flex items-center space-x-3">
                  <input
                    type="radio"
                    name="importMode"
                    checked={importMode === 'overwrite'}
                    onChange={() => setImportMode('overwrite')}
                    className="w-4 h-4 border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">既存データに上書き</span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="radio"
                    name="importMode"
                    checked={importMode === 'merge'}
                    onChange={() => setImportMode('merge')}
                    className="w-4 h-4 border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">既存データとマージ</span>
                </label>
                <label className="flex items-center space-x-3">
                  <input
                    type="radio"
                    name="importMode"
                    checked={importMode === 'new'}
                    onChange={() => setImportMode('new')}
                    className="w-4 h-4 border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-700 dark:text-slate-300">新規イベントとして追加</span>
                </label>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 font-semibold rounded-lg transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleImport}
                  className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors"
                >
                  インポート実行
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default QRSyncDialog;
