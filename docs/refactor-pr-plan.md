# Refactor PR Plan (2026-04-25)

## 現状スナップショット

- `src/App.tsx`: 5813 lines / `useState` 27 / `useCallback` 99
- `src/components/FocusMode.tsx`: 2530 lines
- `src/components/ShoppingList.tsx`: 2498 lines
- `src/components/map/MapCanvas.tsx`: 2274 lines
- `src/components/FocusModeMapCanvas.tsx`: 1928 lines
- `src/features/events/itemOps.ts`: 1096 lines
- テスト: `vitest` は 6 file 中 1 failed (`src/components/FocusMode.integration.test.tsx`)
- Lint: `npm run lint` は ESLint 設定ファイル未検出で失敗
- 差分確認: `src/components/FocusMode_backup.tsx` が残存（過去計画との不整合あり）

## 目標 (この計画の完了条件)

- `App.tsx` を「画面合成 + ルーティング + 最小限の状態」に縮小する
- 主要巨大ファイルの責務を分割し、1ファイルあたりの認知負荷を下げる
- リファクタリング中の回帰を防ぐため、テストと lint を常時グリーンに保つ
- 計画と実コードの状態差分をなくし、継続開発しやすい基盤を整える

## 実行方針

- 1 PR = 1責務で小さく分割し、挙動変更を最小化する
- まず「壊れている品質ゲート」を直してから本体分割に入る
- 高リスク領域（Focus/Map/並び替え）は先にテスト補強してから抽出する
- ファイル分割は「UI」「状態」「ドメインロジック」の3層で統一する

## PRロードマップ

## PR-7: 品質ゲート復旧（最優先）

- 目的: リファクタリング前に安全網を復旧する
- 対象:
- `ESLint` 設定ファイルを再導入し、`npm run lint` を通す
- `src/components/FocusMode.integration.test.tsx` の失敗要因を修正
- 完了条件:
- `npm run lint` 成功
- `npm run test:run` 全件成功
- 備考: このPRが未完了だと以降の差分検証が不安定

## PR-8: App シェル分割（表示責務の切り出し）

- 目的: `App.tsx` から巨大な JSX/モーダル制御を分離する
- 対象:
- `src/App.tsx` の画面表示ブロックを `src/features/app-shell/` に分離
- 例: `MainContent`、`DialogLayer`、`MapOverlayLayer` 等
- 完了条件:
- `App.tsx` から 1000+ lines 削減
- 分離後も UI 動作と props 契約が維持される

## PR-9: リスト操作状態の抽出（編集/実行共通）

- 目的: 選択、範囲選択、スペース折りたたみ、フィルタ状態を `App.tsx` から分離
- 対象:
- `selectedItemIds`、`rangeStart/rangeEnd`、`selectedBlockFilters`、`collapsedSpaces` など
- `src/features/lists/hooks/useListInteractionState.ts`（新規）
- 完了条件:
- `App.tsx` の `useState` 数を 27 -> 18 以下に削減
- `ShoppingList` 連携の挙動（範囲選択/移動/折りたたみ）が回帰しない

## PR-10: Map/Hall ドメイン操作の分離

- 目的: `App.tsx` 内の map/hall 更新ロジックを `features/map` に移す
- 対象:
- ホール定義更新、mapless 同期、hall order 保存、visit list 連携
- `src/features/map/domain/` と `src/features/map/hooks/` の拡張
- 完了条件:
- map/hall 更新ハンドラの主体が `App.tsx` 外に移る
- Map タブと visit list パネルの編集フローが既存通り動作

## PR-11: FocusMode 分割（セッション/タイマー/表示）

- 目的: `FocusMode.tsx` の状態集中を解消する
- 対象:
- `resume` 系ロジック、`auto-advance`、phase 管理、通知管理を hook 化
- 候補: `useFocusSessionState`、`useAutoAdvance`、`useResumeFlow`
- 完了条件:
- `FocusMode.tsx` を 2530 -> 1600 lines 以下へ削減
- 既存 integration test に加え resume 系のユニットテストを追加

## PR-12: Canvas 相互重複の整理（MapCanvas / FocusModeMapCanvas）

- 目的: パン/ズーム/回転/ポインタ処理の重複を減らす
- 対象:
- `src/components/map/MapCanvas.tsx`
- `src/components/FocusModeMapCanvas.tsx`
- 共通 hook 化: `src/features/map/canvas/useCanvasViewport.ts`（新規）
- 完了条件:
- 共通化対象の操作ロジックを再利用化
- 描画結果と操作感（PC/モバイル）が変わらない

## PR-13: event itemOps の責務分割

- 目的: `src/features/events/itemOps.ts` を操作種別ごとに分割する
- 対象:
- CRUD系、実行列移動系、優先度/ホール順序系を別ファイル化
- `src/features/events/itemOps/` ディレクトリ化
- 完了条件:
- `itemOps.ts` をエントリにして内部モジュール化
- 既存エクスポート互換を維持し、呼び出し側の変更を最小限にする

## PR-14: 型定義と不要コードの整理

- 目的: 維持コストの高い単一巨大ファイルを分割し、死蔵コードを削除する
- 対象:
- `src/types.ts` をドメイン別に分割（item/map/focus/export など）
- `src/components/FocusMode_backup.tsx` の削除
- `VisitListPanel` 2実装の役割整理（統合または命名明確化）
- 完了条件:
- 未使用ファイル削除
- 型importが意図単位で追える構成になる

## PR-15: テスト強化と回帰防止

- 目的: 分割後の保守性を担保する
- 対象:
- `itemOps` の主要関数（move, priority, hall order）の単体テスト追加
- map/hall 同期処理のユースケーステスト追加
- Focus resume 遷移のケース拡充
- 完了条件:
- 失敗再発が起きやすい領域に対し最小限の回帰テストが揃う

## 優先実行順

1. PR-7
2. PR-8
3. PR-9
4. PR-10
5. PR-11
6. PR-12
7. PR-13
8. PR-14
9. PR-15

## リスクと対策

- リスク: 大規模分割で挙動を壊す
- 対策: PRごとに対象領域を固定し、先にテストを足してから抽出
- リスク: Props の受け渡しが複雑化
- 対策: container component と hook で state 境界を明確化
- リスク: 計画と現実の乖離再発
- 対策: 各PR完了時にこのドキュメントの「現状スナップショット」を更新

## 補足（履歴）

- 過去フェーズ（PR-1〜PR-6）で persistence/event/map の一次分割は実施済み
- ただし現コードには未解消の巨大ファイルと品質ゲート崩れが残っているため、本計画で再整流する
