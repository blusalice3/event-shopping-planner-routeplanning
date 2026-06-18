# スマート挿入のマップ線クリック化 実装プラン 追補

この追補は、最初の実装プランにレビュー指摘を反映して、仕様判断と実装時の事故防止ポイントを明確にするためのものです。

## 非エンジニア向け: 決めるべき事項

### 1. 同じ場所に複数アイテムがある番号をクリックしたとき

例: マップ上の同じ番号セルに「サークルA」と「サークルB」があり、どちらも実行リストに入っている場合。

選択肢:

- 推奨: 小さな選択UIを出して「サークルAの後」「サークルBの後」を選ばせる。
- 代替: そのセルで最初に表示されている番号の後へ自動で入れる。

推奨理由:

同じ場所でも実行リスト上では順番が違うことがあるため、自動で決めると「思った場所と違う」に見えやすい。元プランの通り、選択UIを出す方が安全。

追記仕様:

- 同一セルに複数 route point がある marker hit では即挿入しない。
- 表示上の番号マーカーが1つでも、hit test では同じセルの全 route point を候補として扱う。
- 候補UIには、ルート順、アイテム名またはサークル名、ブロック番号を表示する。

### 2. ルート線と番号マーカーが近くにある場所をクリックしたとき

例: 番号マーカーのすぐ横にルート線が通っていて、クリックがどちらにも当たる場合。

選択肢:

- 推奨: 番号マーカーを優先する。
- 代替: クリック位置から近い方を優先する。

推奨理由:

番号マーカーは「この訪問先の後に入れる」という意味が直感的で、線よりも意図がはっきりしている。元プランの通り marker 優先でよい。

追記仕様:

- hit test は必ず `marker -> line -> 通常セル/空白` の順で判定する。
- marker と line の両方に当たった場合は marker hit として扱う。

### 3. 違うホールや違う優先度の場所をクリックしたとき

例: 「東1ホールの通常アイテム」を追加しようとしているのに、「東2ホール」や「最優先」グループのルートをクリックした場合。

選択肢:

- 推奨: 挿入せず、理由を表示して選び直せるようにする。
- 代替: 通常追加へ戻す。

推奨理由:

クリック後に通常追加へ戻すと、ユーザーは「なぜそこに入らなかったか」を理解しづらい。選択状態を維持して理由を見せる方が、失敗からの回復がしやすい。

追記仕様:

- map 選択開始後のホール違い/優先度違いは拒否する。
- 通常追加へは戻さない。
- pending 状態を維持し、overlay に理由を表示する。
- ユーザーは別のルート線/番号マーカーをクリックするか、キャンセルできる。

### 4. ルート表示OFFのとき、選択中だけ線を見せるか

例: 普段はルート線を非表示にしているユーザーが、スマート挿入だけ使いたい場合。

選択肢:

- 推奨: 選択中だけ一時的にルートを表示する。設定自体は変更しない。
- 代替: ルートOFFなら map 挿入を開始しない。

推奨理由:

map モードでは線や番号をクリックする必要があるため、一時表示しないと操作できない。設定を勝手にONへ変えない点が重要。

追記仕様:

- `forceRouteVisible` により選択中だけ内部的に `effectiveRouteVisible = isRouteVisible || forceRouteVisible` とする。
- 選択終了後、ユーザーのルート表示設定は変更しない。

### 5. map 選択に入れないときの戻り先

例: 実行リストにまだ1件しかなくルート線が作れない、または追加対象がマップ上の番号セルに見つからない場合。

選択肢:

- 推奨: preview へは移動せず、通常追加する。
- 代替: preview ダイアログへ自動で切り替える。

推奨理由:

map モードを選んでいるユーザーに突然 preview が出ると、失敗したのか別機能へ移ったのか分かりにくい。元プランの通り通常追加が分かりやすい。

追記仕様:

- map 選択開始前に成立条件を満たさない場合は通常追加する。
- preview へ自動遷移しない。
- 複数ID追加では1件でも成立しなければ全件まとめて通常追加する。

## 実装向け追記

### 1. route point 解決 utility を先に作る

`MapView` と `MapCanvas` が別々に route point を作ると、開始判定と実際のクリック判定がずれる可能性がある。

追記:

- 追加: `src/utils/mapRoutePoints.ts`
- `ShoppingItem` から以下を解決する。
  - `itemId`
  - `row`
  - `col`
  - `order`
  - `priorityLevel`
  - `groupKey`
- 解決条件は「対象 map 上の番号セルへ解決できること」とする。
- `eventDate` / `block` / `number` から `row` / `col` を取得できない item は route point 不成立とする。
- map 選択開始前の判定と `MapCanvas` の描画・hit test は同じ utility の結果を使う。

### 2. `generateRouteSegments` は既存呼び出しを壊さない

`generateRouteSegments` は `MapCanvas` だけでなく `FocusMode` からも使われている。`itemId` や `order` を必須にすると既存機能が壊れる。

追記:

- `generateRouteSegments` の入力型は既存の `{ row, col, priorityLevel? }` を引き続き許可する。
- `itemId` / `order` は optional として扱う。
- `RouteSegment` の `fromItemId` / `toItemId` / `fromOrder` / `toOrder` も optional にする。
- line hit test で `fromItemId` が必要な map 挿入時は、`MapCanvas` が itemId/order 付き route point を渡す。
- `FocusMode` の既存呼び出しでは itemId/order がなくても動くことをテストする。

### 3. `effectiveRouteVisible` を全ルート関連処理に使う

追記:

- `MapCanvas` 内で `const effectiveRouteVisible = isRouteVisible || forceRouteVisible` を定義する。
- 以下はすべて `effectiveRouteVisible` を使う。
  - route point 生成
  - visible route marker 生成
  - route segment 生成
  - route 描画
  - route crossing cache
  - route hit test
- `isRouteVisible` を直接参照している箇所を残さない。ただし props の受け取りとユーザー設定表示は除く。

### 4. hit test は表示 marker ではなく全 route point を見る

同一セルの表示番号は1つでも、挿入先候補は複数存在し得る。

追記:

- `mapRouteHitTest` は `visibleRouteMarkers` ではなく、全 `routePoints` を受け取る。
- marker hit ではクリックされたセルに属する全 route point を集める。
- 1件ならその item の後へ挿入する。
- 複数件なら `duplicateItemIds` を返し、MapView 側で候補UIを出す。
- 表示上の番号を1つに絞る既存仕様は維持する。

### 5. hit test の座標系を固定する

回転・ズーム中のクリックずれを避けるため、hit test に渡す座標を統一する。

追記:

- `mapRouteHitTest` は `toMapCoordinates` 後の map pixel 座標を受け取る。
- 引数例:
  - `mapX`
  - `mapY`
  - `cellSize`
  - `routePoints`
  - `routeSegments`
- marker 判定は `((col - 0.5) * cellSize, (row - 0.5) * cellSize)` を中心に行う。
- line 判定は route segment の `path` を同じ map pixel 座標へ変換して距離判定する。

### 6. map 選択中の通常セルクリックは副作用を抑える

通常セルクリック時に `CellItemsPopup` が開くと overlay と競合する。

追記:

- map 挿入選択中に通常セル/番号セルをクリックしても `onCellClick` を呼ばない。
- `CellItemsPopup` は開かない。
- overlay に「ルート線または番号をクリックしてください」と表示する。
- `vertexSelectionMode` / `cellSelectionMode` が有効な場合に備え、`mapCellClick` dispatch の扱いも確認する。
- 少なくとも map 挿入選択中は、通常セルクリックが別の選択機能へ副作用を出さないことをテストする。

### 7. groupKey 検証は表示中ルートと同じ解決を使う

追記:

- anchor item と追加対象 item の比較は、route point 解決 utility が返す `groupKey` で行う。
- `groupKey` は「表示中のルート順で使われるホール/優先度グループ」を表す。
- `selectedHallId` が `all` ではない場合も、表示中ルートの解決結果と矛盾しないこと。
- 1件でも `groupKey` が一致しない場合、複数ID追加は全件拒否する。

## 実装順序の推奨

1. `SmartInsertMode` の共通型を `'map' | 'preview'` に変更し、localStorage migration を追加する。
2. route point 解決 utility を追加し、`MapCanvas` の route point 生成を置き換える。
3. `generateRouteSegments` と `RouteSegment` を後方互換のまま拡張する。
4. `mapRouteHitTest` と単体テストを追加する。
5. `mapSmartInsert` の groupKey 検証と単体テストを追加する。
6. `MapCanvas` に `forceRouteVisible` と hit test props/callback を追加する。
7. `MapView` に pending state、overlay、同一セル候補UI、拒否動作を追加する。
8. `InsertPositionDialog` を preview 専用へ整理し、card UI を削除する。
9. Header の長押し切替と badge を `M` / `P` に変更する。
10. integration test と build を実行する。

## 追加テスト

- `generateRouteSegments` は旧形式の `{ row, col }` 入力でも動く。
- `generateRouteSegments` は itemId/order 付き入力では `fromItemId` / `toItemId` / `fromOrder` / `toOrder` を保持する。
- 同一セルに複数 route point がある場合、表示 marker は1つでも hit result は全 itemId を返す。
- marker と line の両方に当たる場合は marker を返す。
- 回転角ありの状態でも marker/line hit が成立する。
- `forceRouteVisible` 中はルートOFFでも route point / segment / hit test が有効になる。
- map 選択終了後、ユーザーの route 表示設定は変わらない。
- map 選択中の通常セルクリックでは `CellItemsPopup` が開かない。
- map 選択中の通常セルクリックが `vertexSelectionMode` / `cellSelectionMode` に副作用を出さない。
- `selectedHallId !== 'all'` かつ複数 hall candidate を持つ item でも groupKey 検証が表示中ルートと一致する。
- batch callback がない場合、単体 callback fallback で複数IDが anchor 直後に順序通り入る。

## 最終確認コマンド

```bash
npx vitest run src/utils/mapRouteHitTest.test.ts src/utils/mapSmartInsert.test.ts src/utils/mapRoutePoints.test.ts
npx vitest run src/utils/pathfinding.test.ts src/utils/mapRouteOrder.test.ts src/utils/hallGrouping.test.ts src/components/map/MapVisitListPanel.integration.test.tsx
npm run build
```
