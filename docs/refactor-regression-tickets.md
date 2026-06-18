# リファクタリング回帰チケット (2026-04-28)

`event-shopping-planner-routeplanning-RC1.9.4` を元コードとして、現リファクタリング版（`docs/refactor-pr-plan.md` の PR-7〜PR-14 の実装結果）を機能比較した結果として検出された差異一覧。

## 凡例

- **Severity**
  - `S1`: ユーザーに見える誤り・機能不全（即修正対象）
  - `S2`: 動作仕様変更（要意図確認）
  - `S3`: 視覚デザイン・UX 微変更（要意図確認）
  - `S4`: 内部最適化の劣化（実害なし）
- **Status**: `open` / `intentional`（意図した変更と判明したもの）/ `fixed`

---

## TICKET-01 [S1] フェーズラベル「遅参」が「遅巡」に誤記

- **Status**: open
- **影響**: ユーザー視認文字列の誤字。元コード全体・新コードでもロジック / コメントは「遅参」に統一されている一方、抽出された一部表示モジュールのみ「遅巡」になっている。
- **箇所**:
  - [src/components/focus/FocusModeDialogs.tsx:55](src/components/focus/FocusModeDialogs.tsx) — フェーズ切替ダイアログ
  - [src/components/focus/FocusModeDialogs.tsx:264](src/components/focus/FocusModeDialogs.tsx) — AddItemDialog のラベル
  - [src/components/focus/FocusModeStateViews.tsx:152](src/components/focus/FocusModeStateViews.tsx) — 完了サマリー
  - [src/components/focus/hooks/useAutoSkipEmptyVisit.ts:111](src/components/focus/hooks/useAutoSkipEmptyVisit.ts) — 通知メッセージ
  - [src/components/focus/hooks/useAutoSkipEmptyVisit.ts:127](src/components/focus/hooks/useAutoSkipEmptyVisit.ts) — 通知メッセージ
- **再現**: フォーカスモードを実行し、後回し → 遅参フェーズに遷移するダイアログ／通知／完了画面を確認すると、本来「遅参」と表示される箇所が「遅巡」になっている。
- **修正**: 該当 5 箇所の `'遅巡'` を `'遅参'` に置換。`FocusModePanels.tsx:198` および `FocusMode.tsx` 内では「遅参」が維持されているので比較対象になる。
- **完了条件**: アプリ全体で `grep "遅巡"` が 0 件。

---

## TICKET-02 [S1] フッタ高さ自動測定が常時無効化（id 欠落）

- **Status**: open
- **影響**: フォーカスモードの SP / PC マップ表示時、ResizeObserver によるフッタ高さ動的調整が機能しない。フッタが折り返した場合などにマップ可視領域がずれる。
- **箇所**:
  - [src/components/FocusMode.tsx:198](src/components/FocusMode.tsx) — `document.getElementById('focus-mode-footer')` を呼んでいる側
  - [src/components/focus/FocusModeFooterPortal.tsx](src/components/focus/FocusModeFooterPortal.tsx) — `id="focus-mode-footer"` を出力していない（元 RC1.9.4 では `FocusMode.tsx:2474` および `FocusMode.tsx:2670` に存在）
- **再現**: フォーカスモードでマップ表示を有効化し、フッタが2行に折り返す程度にウィンドウ幅を狭めると、`measuredFooterHeight` が更新されないことを DevTools で確認できる。
- **修正**: `FocusModeFooterPortal.tsx` でフッタを包むルート div に `id="focus-mode-footer"` を付与する。SP / PC 両方の分岐で同 id を出力する必要がある。
- **完了条件**: `getElementById('focus-mode-footer')` が常に DOM 要素を返すこと。フッタ高さに応じて `measuredFooterHeight` が更新されること（DevTools の React DevTools / log で確認）。

---

## TICKET-03 [S1] MapCanvas / FocusModeMapCanvas の省略記号文字列が文字化け

- **Status**: open
- **影響**: マップ上のテキスト切り詰め描画で、`ctx.measureText` が比較に使う省略記号サフィックスの文字数が変化し、テキストが本来より早く切り詰められる。表示もモジバケ文字列になる。両ファイルともファイル先頭に UTF-8 BOM が新規挿入されており、エディタ経由で Shift-JIS として再デコード→保存された疑い。
- **箇所A**: [src/components/map/MapCanvas.tsx:734, 737, 844, 852, 854](src/components/map/MapCanvas.tsx)
  - 元: `'窶ｦ'` (UTF-8 6 バイト, 2 文字。元々 `'…'` のモジバケだが運用上固定)
  - 後: `'遯ｶ・ｦ'` (UTF-8 12 バイト, 4 文字。さらに二重モジバケ)
- **箇所B**: [src/components/FocusModeMapCanvas.tsx:1006, 1009, 1116, 1124, 1126](src/components/FocusModeMapCanvas.tsx)
  - 元: `'…'` (U+2026, 正しい省略記号)
  - 後: `'窶ｦ'` (新たに文字化け、Shift-JIS as UTF-8)
  - ※こちらは元コードが正しかったので、リファクタで新規に文字化けが発生
- **修正**:
  1. 両ファイルとも該当箇所を本来意図された `'…'` (U+2026) に統一するのが本筋。
  2. ファイル先頭の UTF-8 BOM (`﻿`) を除去。
  3. ファイルを UTF-8 (BOMなし) で保存するエディタ設定を確立。
- **完了条件**: 切り詰めサフィックスが両ファイルとも `'…'` (1 文字) になり、`measureText` の比較幅が回帰しないこと。`grep "窶ｦ\|遯ｶ"` が 0 件。

---

## TICKET-03b [S1] FocusModeMapCanvas のセルラベルが日本語→英語に変化（情報損失）

- **Status**: open
- **影響**: マップ描画上のセルラベル文字が日本語から英語に置き換わっている。**しかも 2 通りのラベルが同じ英語に縮退して情報損失が発生**している。フォーカスモードのマップ表示で「フェーズ開始マーカー」と「個別アイテムの状態マーカー」が区別できなくなる。
- **箇所**: [src/components/FocusModeMapCanvas.tsx:390, 392, 394, 400, 402, 404](src/components/FocusModeMapCanvas.tsx) （元: `:414, 416, 418, 424, 426, 428`）

| 元 (RC1.9.4) | リファクタ後 | 用途 |
|---|---|---|
| `'始'` | `'Start'` | 通常フェーズの開始セル |
| `'後始'` | `'Post'` | 後回しフェーズの開始セル |
| `'遅始'` | `'Late'` | 遅参フェーズの開始セル |
| `'後'` | `'Post'` ←衝突 | 後回しアイテムの一般マーカー |
| `'遅'` | `'Late'` ←衝突 | 遅参アイテムの一般マーカー |
| `'済'` | `'Done'` | 購入済みマーカー |

- **再現**: フォーカスモードでマップ表示を開き、後回しアイテムや遅参アイテムを含むセルを確認すると、`'後始'`/`'後'` 両方が `'Post'`、`'遅始'`/`'遅'` 両方が `'Late'` で表示される。ユーザはフェーズ開始セルと一般セルを判別できない。
- **修正**: 元の日本語ラベル（`'始'`、`'後始'`、`'遅始'`、`'後'`、`'遅'`、`'済'`）に戻す。エディタ起因の文字化けで英訳されたとみられる。
- **完了条件**: 6 つのラベルがすべて元の日本語に復帰し、フェーズ開始と一般状態が視覚的に区別できる。

---

## TICKET-03c [S2] FocusModeMapCanvas のコメントが英訳されている

- **Status**: fixed
- **影響**: 動作には影響しないが、保守時に英語コメントと日本語ロジック（残存している）が混在することで可読性が低下。元コードでは全コメントが日本語だった。
- **箇所**: [src/components/FocusModeMapCanvas.tsx](src/components/FocusModeMapCanvas.tsx) 全般。例: 「ラベル決定ロジック…」→「Decide the label text…」
- **判断ポイント**: 国際化方針か、エディタ起因の自動翻訳か確認。意図しないなら復元。

---

## TICKET-03d [S2] FocusModeMapCanvas のコメント末尾が文字化け

- **Status**: fixed
- **影響**: 動作には影響しないが、コメントが途中で破綻している。
- **箇所**: [src/components/FocusModeMapCanvas.tsx:~1568](src/components/FocusModeMapCanvas.tsx)（元 `強調` → 後 `強�`、置換バイトで終端）
- **修正**: コメントを復元するか、全コメントを再記述。
- **確認**: 現在の [src/components/FocusModeMapCanvas.tsx](src/components/FocusModeMapCanvas.tsx) では該当コメントが `現在対象セルを枠線で強調する。` に復元済み。置換文字 `�` も検出されない。

---

## TICKET-03e [S1] FocusModeMapCanvas の縦書きトークン化正規表現が変更

- **Status**: fixed
- **影響**: 縦書きテキストのトークン化で全角英数字 (`０-９`、`Ａ-Ｚ`、`ａ-ｚ`) が単語クラスから除外され、CJK 分岐に落ちて 1 文字ずつ縦に並ぶようになった。全角英数を含むラベル（例: `１２３スペース`）の表示が崩れる。
- **箇所**: [src/components/FocusModeMapCanvas.tsx:~947](src/components/FocusModeMapCanvas.tsx) `tokenizeForVerticalLayout`
  - 元: `/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/`
  - 後: `/[0-9A-Za-z]/`
- **修正**: 元の文字クラスに戻す。エディタの全角→半角変換による意図せざる変更とみられる。
- **完了条件**: 全角英数を含むラベルが横向きに 1 トークンとしてレイアウトされる。

---

## TICKET-14 [S1] 「価格未定チェックを無効化」UI が完全に消失

- **Status**: open
- **影響**: **ユーザが`disablePriceUndefinedCheck` 設定を ON/OFF する手段がアプリ内に一切存在しなくなった**。元コードでは UI 設定パネル内の「購入管理」セクションにチェックボックスがあったが、リファクタリングで削除された。
- **箇所**:
  - 元 [App.tsx:5271-5292](src/App.tsx) — UI 設定パネルの「購入管理」セクションに `<input type="checkbox" checked={disablePriceUndefinedCheck} ...>` が存在
  - 後 [src/features/app-shell/components/AppHeaderShell.tsx](src/features/app-shell/components/AppHeaderShell.tsx) — 「購入管理」セクションが丸ごと欠落（`grep "購入管理\|価格未定"` 結果 0 件）。`numberCellOutlineStyle` ラジオの直後から「デフォルトに戻す」ボタンに直接接続
- **副次的影響**:
  - 「デフォルトに戻す」ボタンから `setDisablePriceUndefinedCheck(false)` の呼び出しも欠落（元 [App.tsx:5300](src/App.tsx)）。localStorage に古い設定が残っていた場合、リセットできない
  - フック `useDisablePriceUndefinedCheck` 自体は残存しており、`AppMainContent` → `ShoppingList` / `FocusModeContainer` への prop 伝播も生きている。**機能だけが空中浮遊**。TICKET-06 で追加された blink ガード (`!disablePriceUndefinedCheck && hasUndefinedPricePurchased`) も、ユーザが ON にできないため事実上死コード
- **修正**: 元の「購入管理」セクションを `AppHeaderShell.tsx` に復元し、`disablePriceUndefinedCheck` / `setDisablePriceUndefinedCheck` を props で渡す。リセットボタンにも `setDisablePriceUndefinedCheck(false)` を追加。
- **完了条件**: UI 設定パネルからチェックボックスをトグルでき、設定が永続化され、購入時の動作（次へ進めるか、点滅するか）が変化することを目視確認。

---

## TICKET-15 [S1] スマートフォンレイアウトで BulkActionControls が二重表示

- **Status**: open
- **影響**: スマートフォンレイアウトでアイテムを選択すると、ヘッダ内に desktop 用の BulkActionControls + 移動ボタンが表示され、**さらに**画面下部の固定スマートフォン用ツールバー（`AppOverlayLayer.tsx:677-701`）にも同じコントロールが表示される。コントロールが二重に重なって UI が破綻する。
- **箇所**:
  - 元 [App.tsx:5608-5614](src/App.tsx)（ヘッダ用 BulkActionControls）と [App.tsx:5645-5652](src/App.tsx)（ヘッダ用「実行列に移動」ボタン群）— ともに `selectedItemIds.size > 0 && layoutMode !== 'smartphone' && (...)` のガードを持つ
  - 後 [src/features/app-shell/components/AppHeaderShell.tsx:1005-1007](src/features/app-shell/components/AppHeaderShell.tsx) — **`layoutMode !== 'smartphone'` ガードが欠落**。条件は `selectedItemIds.size > 0` のみ
  - 後 `AppHeaderShell.tsx:1041`（移動ボタン群）はガードあり、ここは正しい
  - 後 [src/features/app-shell/components/AppOverlayLayer.tsx:677-680](src/features/app-shell/components/AppOverlayLayer.tsx) — スマートフォン用 BulkActionControls（元 App.tsx:6526-6529）。`layoutMode === 'smartphone'` の暗黙の条件で出る
- **再現**: モバイル幅でアプリを開き、アイテムを 1 件以上選択すると、ヘッダ内とフッタ内の両方にバルクアクション UI が現れる
- **修正**: AppHeaderShell.tsx:1005-1007 の条件式に `&& layoutMode !== 'smartphone'` を追加
- **完了条件**: スマートフォンレイアウトで選択時、BulkActionControls がフッタ側にのみ表示される

---

## TICKET-16 [S2] `visitKeyCellMap` の反復対象が `routePositionItems` から `items` に変化

- **Status**: fixed
- **影響**: フォーカスモードで visitKey→セル座標マップを構築する際、元コードは実行列のアイテムのみ (`routePositionItems` = `executeItems`) を反復していたが、リファクタ後は全アイテム (`items` = props 配列全体) を反復するようになった。候補列のアイテムも同マップに登録される。
- **箇所**: [src/components/FocusMode.tsx:469](src/components/FocusMode.tsx)
  - 元 [FocusMode.tsx:725]: `routePositionItems.forEach((item) => {`
  - 後: `items.forEach((item) => {`
- **動作影響**: 静的解析では「visitKey にはpriorityLevel が埋め込まれているため、候補側のアイテムは別 visitKey 配下に登録される。`precomputedAllVisitCellCoords` は `currentPhaseVisits` 由来の visitKey でしかルックアップしないので、表示上のルートには影響しない」という分析だが、`visitKeyCellMap` 全体は `precomputedVisitKeyCellMap` として `FocusModeMapCanvas` に渡されており、消費側で全エントリを走査する箇所があれば挙動が変わる。`executeItemsRoutingSignature` 削除（TICKET-10）と組み合わせて再レンダー回数も増加する可能性。
- **判断ポイント**: 意図した拡張（候補側もマップにマーキング表示）か、抽出時の取りこぼしか確認。`executeItems` を反復する元の挙動が期待値ならば修正。

---

## TICKET-17 [S2] 完了状態で `allVisits` が空のときの表示分岐が変化

- **Status**: fixed（EmptyVisitStateView 優先へ復帰、回帰テスト追加）
- **影響**: アイテムリストが空（`allVisits.length === 0`）かつ `isCompleted=true` の状態でフォーカスモードに入った場合、元コードは EmptyVisitStateView（「実行列にアイテムを追加してください」）を表示するが、リファクタ後は CompletionStateView（完了画面）を表示する。
- **箇所**:
  - 元 [FocusMode.tsx:1751](src/components/FocusMode.tsx)（RC1.9.4）: `if (allVisits.length === 0)` を `isCompleted` チェックより前で無条件評価
  - 後 [FocusMode.tsx:1258](src/components/FocusMode.tsx): `EmptyVisitStateView` のレンダリング条件が `!isCompleted && allVisits.length === 0`
  - 修正後 [FocusMode.tsx:1196](src/components/FocusMode.tsx): `allVisits.length === 0` を `isCompleted` チェックより前で無条件評価
- **判断ポイント**: TICKET-05（`isCompleted` の resume 初期化変更）とセットで意図的な変更の可能性が高いが、空リスト + 完了状態の境界ケースの UX を作者と確認。

---

## TICKET-04 [S2] ResumeChoiceDialog の表示形態が刷新されている

- **Status**: fixed
- **影響**: 再開ダイアログのレイアウト / インタラクションが大きく変わっている。
- **差異**:
  - 元: 全画面オーバーレイ（`fixed inset-0 z-50 backdrop-blur-sm`）+ ティール / インディゴのグラデーションヘッダ
  - 後: インラインパネル（オーバーレイなし、レンダーツリー上で `ResumeChoiceDialogView` を early-return しビュー全体を置き換える）
  - ボタン順序: `lastChange→pointer→phaseStart→normalStart` から `pointer→lastChange→phaseStart→normalStart` に変更
  - lastChange ラベルから `(${phaseName}フェーズ)` 接尾辞が消失
  - ボタン文言の末尾が `スペース` / `最初から` から `…から再開` 形式に変更
- **箇所**: [src/components/FocusMode.tsx:1255](src/components/FocusMode.tsx)（`if (resumeChoiceDialog?.isOpen) return <ResumeChoiceDialogView />` の early-return 起点）
- **判断ポイント**: UI 改善を意図したのか、抽出時の取りこぼしか作者に確認。意図的であれば `intentional` でクローズし、CHANGELOG に明記。意図せざる変更なら原型復元。
- **対応**: 意図的な刷新と判断できる記録がないため原型復元。`ResumeChoiceDialogView` を全画面オーバーレイ + ティール / インディゴのグラデーションヘッダへ戻し、ボタン順序・lastChange のフェーズ接尾辞・文言末尾を復元。`FocusMode.tsx` の early-return を撤去し、背面ビューを保持したままオーバーレイ表示するよう修正。

---

## TICKET-05 [S2] `isCompleted` の resume 初期化セマンティクス変更

- **Status**: open（要意図確認）
- **影響**: マウント直後に完了画面が即時表示される可能性。元コードでは resume ダイアログの `pointer` 選択経由でのみ完了状態に復帰する設計。
- **箇所**: [src/components/focus/hooks/useFocusSessionState.ts:20](src/components/focus/hooks/useFocusSessionState.ts)
  - 元 `FocusMode.tsx:116` のコメント: 「`isCompleted` は常に `false` で初期化、resume ダイアログの `pointer` 選択でのみ復元される」
  - 後: `useState(() => resumeState?.isCompleted || false)` — 初期値が `resumeState` 由来になっている
- **判断ポイント**: `applyResumeChoice` 内で `setIsCompleted(false)` の明示呼び出しが追加されているため、フローによっては元の挙動と一致するかもしれない。リロード時の表示が元と一致するか手動検証が必要。

---

## TICKET-06 [S2] 価格未定義チェックの blink 効果に新ガード追加

- **Status**: done（仕様として確定）
- **影響**: `disablePriceUndefinedCheck=true` のときに価格未定義アイテムが点滅しなくなる（=「価格未定義チェック無効」設定が点滅にも適用される）。
- **箇所**: [src/components/FocusMode.tsx:732](src/components/FocusMode.tsx)
  - 元 `FocusMode.tsx:1084`: ガードなし — 設定に関係なく点滅
  - 後: `if (!disablePriceUndefinedCheck && hasUndefinedPricePurchased)` — 設定オフ時は点滅しない
  - 依存配列にも `disablePriceUndefinedCheck` が追加されている
- **判断**: 元コードは「moveToNext ロジックでは設定を尊重するが点滅効果では尊重しない」という不整合があったため、リファクタ後の挙動を仕様として採用する。`AppHeaderShell.tsx` には「購入管理」設定UIとリセット処理が存在するため、ユーザが設定を切り替えられる状態でこのガードは有効。
- **対応**: `src/components/FocusMode.ticket06.test.tsx` を追加し、チェック有効時は価格未定義購入アイテムが点滅し、`disablePriceUndefinedCheck=true` では点滅しないことを固定。

---

## TICKET-07 [S3] FocusModeFooterPortal の見た目変更

- **Status**: fixed
- **箇所**: [src/components/focus/FocusModeFooterPortal.tsx](src/components/focus/FocusModeFooterPortal.tsx)
- **差異**:
  - PC フッタ: `残りの合計: ` (コロン付き) → `残りの合計 ` (コロン削除)
  - SP フッタ背景: 元 `bg-white/90` → 現 `bg-white/80` 固定（`compact` フラグの分岐が消失）
  - レイアウトモード切替ボタン: 元はモード一致時に `bg-blue-600` 等のアクティブハイライト + アイコン切替があったが、現在は静的 `LayoutIcon` 固定
- **判断ポイント**: 意図したリデザインか、抽出時のシンプル化漏れか確認。
- **対応**: 抽出時のシンプル化漏れとして復元。非compactフッタの `残りの合計: ` と compact フッタ背景の `bg-white/90 dark:bg-slate-800/90` 分岐を戻した。レイアウトモード切替ボタンのアクティブハイライト・アイコン切替は既に復元済みであることを確認。

---

## TICKET-08 [S3] CompletionStateView / EmptyVisitStateView のアイコン削除と文言変更

- **Status**: open（要意図確認）
- **箇所**: [src/components/focus/FocusModeStateViews.tsx](src/components/focus/FocusModeStateViews.tsx)
- **差異**:
  - 完了サマリーの絵文字（✅ / ❌ / ⚠️ / ⏸️ / 🕐 / ⬚）と操作ボタンの絵文字（📝 / 🏃）が消えてプレーンテキスト化
  - 空訪問先表示: アイコン 📋 → 📍、本文 `実行列にアイテムを追加してください` → `実行前にアイテムを追加してください`
- **判断ポイント**: トーン変更の意図か、素のリビルド漏れか確認。
- **対応**: 抽出時のシンプル化漏れとして復元。完了サマリーと操作ボタンの絵文字、空訪問先表示の 📋 アイコンと `実行列にアイテムを追加してください` 文言を戻した。

---

## TICKET-09 [S3] CellItemPopup / PhaseChangeDialogView の細部 UI 変更

- **Status**: open（要意図確認）
- **箇所**: [src/components/focus/FocusModeDialogs.tsx](src/components/focus/FocusModeDialogs.tsx)
- **差異**:
  - CellItemPopup の閉じる SVG → `'×'` リテラル文字 (`FocusModeDialogs.tsx:137`)
  - 追加ボタン先頭の SVG プラスアイコンが消失
  - 件数表示が全角カッコ `（n件）` → 半角 `(n件)`
  - PhaseChangeDialogView の保存情報表示も全角 `（{n}/{total}）` → 半角 `({n}/{total})`
  - AddItemDialogView の placeholder（circle 入力の `スケブお願い`、URL 入力の `https://example.com`）が消失
  - `<datalist>` の配置位置（input と同 div 内 → 兄弟要素）変更

---

## TICKET-11 [S2] ホール同期で `hallVisitLists` の挙動が変化

- **Status**: intentional（参照切れを防ぐ意図的なバグ修正として確認済み）
- **影響**: マップなしホールやポリゴンホールを他日付に同期する際、訪問リスト内の hallId 参照を新ホールにリマップ／不可ならドロップするように変更された。元コードでは古い hallId のまま放置され、参照切れが発生していた。
- **箇所**:
  - 元: `App.tsx:3870`（`handleSyncMaplessHallsToOtherDates`）と `App.tsx:3920`（`handleSyncPolygonHallsToOtherDates`）— `hallVisitLists: sourceSettings.hallVisitLists || []` のまま
  - 後: [src/App.tsx:3398-3429, 3432-3468](src/App.tsx) → [src/features/map/domain/hallOperations.ts:198-212](src/features/map/domain/hallOperations.ts) `remapHallRouteSettings` を呼び `remapHallGroupId` で各 hallId を変換し、不可なら `.filter` で除外
- **判断ポイント**: 元コードのバグ修正として歓迎する変更だが、リリースノートには明記すべき。同期機能を多用しているユーザの保存データ挙動が変わる可能性がある。
- **対応**: `CHANGELOG.md` に保存データ挙動の変更を明記。`remapHallRouteSettings` の回帰テストで、訪問リストの hallId リマップと未マップ参照の除外を固定。

---

## TICKET-12 [S3] `mergeHallOrder` が groupId サフィックスを除去するように

- **Status**: intentional（優先度別 hallOrder を保持する互換対応として確認済み）
- **影響**: `hallOrder` 配列内の文字列を比較する際、`:priority` / `:highest` 等のサフィックスを取り除いてからマッチさせるよう変更された。
- **箇所**:
  - 元: `App.tsx:3724` `existingPolygonOrder.filter((id) => polygonIds.includes(id))` （素の equality）
  - 後: [src/features/map/domain/hallOperations.ts:53](src/features/map/domain/hallOperations.ts) `existingOrder.filter((id) => hallIds.includes(extractHallIdFromGroupId(id)))`
- **影響度**: 通常 `hallOrder` には素の hallId しか入らないため事実上 no-op。レガシーデータでサフィックス付き ID が混入していた場合、元コードでは破棄、後コードでは保持される。
- **判断ポイント**: マイグレーション意図ならリリースノートに記載。
- **対応**: `hallOrder` は現在 `{hallId}:priority` / `{hallId}:highest` も正規のグループ ID として扱うため、元の equality には戻さない。`CHANGELOG.md` に互換対応として明記し、`mergeHallOrder(['hall-a:priority'], ['hall-a'])` がサフィックス付きグループを保持しつつベース hallId を補完する回帰テストを追加。

---

## TICKET-13 [S3] `handleUpdateHalls` 系 useCallback の deps から `hallRouteSettings` が削除

- **Status**: intentional（確認済み。functional setter による stale closure 回避として妥当）
- **影響**: コールバックの依存配列から `hallRouteSettings` が外れたため、callback の参照識別子が安定化した。setter callback (`prev => ...`) で最新値を読むためのデザインで、stale closure リスクは消えるが、コールバック識別子変化に依存していた consumer の `useMemo`/`useEffect` が再走しなくなる。
- **箇所**: 
  - [src/App.tsx:3344](src/App.tsx)（`handleUpdateHalls`）— 元 `App.tsx:3764` deps `[..., hallRouteSettings]` → 後 `[activeEventName, activeEventDate, isMapTab, currentMapTabName]`
  - [src/App.tsx:3388](src/App.tsx)（`handleUpdateMaplessHalls`）— 同様
- **判断ポイント**: 識別子安定化を意図した変更ならよいが、consumer 側で referential change を signal にしている箇所がないか念のため確認が必要。
- **確認結果**: `handleUpdateHalls` / `handleUpdateMaplessHalls` は `setHallRouteSettings(prev => ...)` で最新 store を読む実装。渡し先は `AppOverlayLayer` 経由の `HallDefinitionPanel` / `SimpleHallDefinitionPanel` のみで、いずれも適用ボタン・同期ボタンの実行ハンドラとして使用しており、callback identity の変化を `useMemo` / `useEffect` の signal として扱う consumer は見当たらない。deps から `hallRouteSettings` を外した状態を維持する。

---

## TICKET-19 [S1] no-map モードでレイアウト切替ボタンが機能しない

- **Status**: open
- **影響**: フォーカスモードの **no-map モード（マップ非表示の状態）**で、フッタにあるレイアウト切替ボタン（スマホ ↔ PC）の動作が壊れている。**現在のレイアウトモードに関係なく必ず `'smartphone'` を送る**ため、SP モードの no-map で押しても何も変わらない（同じモードを再指定するだけ）。
- **箇所**:
  - 元 [FocusMode.tsx:2880-2913](https://github.com/) (RC1.9.4): no-map 用フッタの切替ボタン
    ```
    onClick={() => onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc')}
    className={layoutMode === 'smartphone' ? 'bg-blue-600 text-white' : ...}
    title={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
    aria-label={...}
    icon: layoutMode === 'smartphone' ? <smartphone-svg> : <laptop-svg>
    ```
  - 後 [src/components/focus/FocusModeFooterPortal.tsx:73](src/components/focus/FocusModeFooterPortal.tsx)（共通フッタとして抽出されたため、no-map / PC+map / SP+map すべてここを通る）
    ```
    onClick={() => onLayoutModeChange(compact ? 'pc' : 'smartphone')}
    ```
    - `compact` は SP+map モード時のみ `true`、no-map と PC+map では `false`
    - したがって SP no-map（compact=false）では `'smartphone'` を送ってしまう = 自分自身を再指定 = 無効化
- **副次的な視覚回帰**:
  - `layoutMode==='smartphone'` 時のアクティブハイライト `bg-blue-600 text-white` が消失（常に `bg-slate-200`）
  - SVG アイコンのスマホ/ラップトップ切替が消失（常に `LayoutIcon` 固定）
  - タイトル属性の動的切替が消失
  - `aria-label` 完全消失（アクセシビリティ後退）
  - SP+map の元タイトル `'タブレット/PCモードに切替'` も `'PCモードに切替'` に短縮（"タブレット/" プレフィックス消失）
- **再現**: SP モードでフォーカスモードに入り、マップを非表示にした状態でフッタの切替ボタンを押す → 何も起こらない
- **修正**: `FocusModeFooterPortal.tsx` でフッタを使う側から `layoutMode` を受け取り、`onClick={() => onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc')}` に修正。アイコン・className・title・aria-label すべて元コードと同等の条件分岐で復元。
- **完了条件**: SP no-map / PC no-map / SP+map / PC+map の 4 状態すべてで、ボタン押下が現在のモードから他方に切り替わる。アクセシビリティ属性も復元。

---

## TICKET-20 [S3] AddItemDialog の各種フォーム細部変更

- **Status**: open（要意図確認）
- **影響**: フォーカスモードのアイテム追加ダイアログでフォーム入力の placeholder と微細な視覚要素が変更されている。
- **箇所**: [src/components/focus/FocusModeDialogs.tsx](src/components/focus/FocusModeDialogs.tsx)
- **差異**:
  - `TextField` ヘルパに placeholder prop が無い → 元コードに存在した placeholder が全て消失:
    - `"サークル名"` (元 `FocusMode.tsx:2195`)
    - `"新刊セット"` (元 `:2213`)
    - `"01a"` (元 `:2245`)
    - `"スケブお願い"` (元 `:2327`)
    - `"https://example.com"` (元 `:2337`)
  - `サークル名 *` のラベルでアスタリスク前のスペースが消失 (`サークル名 <span>*</span>` → `{label}{required && <span>*</span>}`)
  - 数量 `<select>` の option value が文字列化（元: 数値 `value={num}`、後: `String(i + 1)`）。DOM 上は文字列強制されるため動作上は等価だが、`form.quantity` が文字列 `'1'` で初期化されているため整合性自体は保たれる
- **判断ポイント**: UI 簡素化を意図したものか、抽出時の取りこぼしか確認。

---

## TICKET-21 [S4] `clampPhaseIndex` ヘルパの削除（インライン化）

- **Status**: verified（実害なし、対応不要）
- **影響**: 元 `FocusMode.tsx:512-519` で `useCallback` として定義されていた `clampPhaseIndex` が削除され、`applyResumeChoice` 内の単一呼び出し箇所にインライン展開された。
- **箇所**: [src/components/FocusMode.tsx:1260-1263](src/components/FocusMode.tsx)
  - 元: `const clampPhaseIndex = useCallback((phase, idx) => Math.min(Math.max(0, idx), len - 1), [...])`
  - 後: `visits.length === 0 ? 0 : Math.min(Math.max(0, idx), visits.length - 1)` 形式
- **動作**: 数式は等価。`len === 0 ? 0 : ...` の境界処理も等価。
- **対応**: 不要（2026-04-28 に再確認済み。記録のみ）。

---

## TICKET-18 [S2] `useCanvasViewport` で `offsetRef.current` を同期書き込みに変更

- **Status**: fixed（意図した stale 参照修正として確認済み）
- **影響**: `setOffset` 内で `offsetRef.current` を即時書き込みするように変更されている。元コードは `setOffset` のみ呼び、`useEffect` 経由で次フレームに ref を同期していた。1 フレーム分の stale 読み込みを防ぐ修正。
- **箇所**:
  - 元 [FocusModeMapCanvas.tsx:1781-1783] (RC1.9.4): `setOffset(newOffset); zoomLevelRef.current = newZoom;`（ref 書き込みなし）
  - 後 [src/features/map/canvas/useCanvasViewport.ts](src/features/map/canvas/useCanvasViewport.ts): `setOffset` 内で `offsetRef.current = newOffset` を同期実行し、ホイール / ピンチ / 外部呼び出しの更新経路を統一
  - また同期 useEffect の deps が `[offset]` → `[offset, offsetRef]` に変更されている（refs は安定識別子のため通常 no-op だが、外部 ref を切り替えた場合に追加実行の可能性）
- **確認結果**: `offsetRef` は座標変換・描画・ドラッグ開始位置などの即時参照として使われており、React state 反映待ちに依存する箇所は見当たらない。ホイール / ピンチハンドラ側の重複代入は削除し、同期書き込みは `setOffset` に集約済み。

---

## TICKET-10 [S4] ルーティング安定化メモ化の削除

- **Status**: fixed
- **影響**: items 配列の identity が変わるたびに `visitKeyCellMap` 再計算が発生する可能性。動作は同じ。
- **箇所**: 元 `FocusMode.tsx:323-354` の `executeItemsRoutingSignature` / `executeItemOrderIds` / `routePositionItems` がリファクタ後ファイルから削除され、`useMemo` の依存に `executeItems` を直接指定する形に変わっていた。
- **対応**: `src/components/FocusMode.tsx` に `executeItemsRoutingSignature` と `routePositionItems` を復元。`visitKeyCellMap` は `routePositionItems` 依存に戻し、ルーティングに必要な item fields が同一なら配列 identity だけの変化では再計算しない。
- **確認**: `npm run lint`、`npm run test:run`、`npm run build` 通過。

---

## 検証で問題なしと確認した範囲（参考）

以下は今回の比較で「動作に影響しない」と判断した範囲。今後同種の指摘が来た際の参照用に列挙。

- ルートディレクトリの設定ファイル `package.json` / `vite.config.ts` / `vitest.config.ts` / `tsconfig.json` / `tsconfig.node.json` / `vercel.json` / `index.html` / `pwa-assets.config.ts` はすべて同一
- `public/` ディレクトリ配下の資産も全て同一
- `src/types.ts` の `types/{item,focus,map,export}.ts` への分割（コメント削除のみ、型定義は同一）
- 共有コンポーネント 14 ファイル（DeleteConfirmationModal / ItemEditDialog / ShoppingList ほか）の差分は import パス変更のみ
- マップ系小コンポーネント（BlockDefinitionPanel / HallDefinitionPanel ほか）の差分は import パス変更のみ
- `features/events/` 各ファイル（bulkAdd / exportFlow / fileImport / uiOrchestration / updateApply / updateDiff / updateFlow ほか）は import パス変更のみ
- `utils/` 各ファイル（pathfinding / polygonValidation / exportImport / itemComparison / hallGrouping ほか）は import パス変更のみ
- `hooks/useIndexedDbPersistence.ts`、`hooks/useNumberCellOutlineStyle.ts`、`hooks/useThemeMode.ts`、`hooks/useDisablePriceUndefinedCheck.ts`、`hooks/useUIVisibilitySettings.ts` の差分は import パス変更のみ
- `useCanvasViewport` の MapCanvas / FocusModeMapCanvas からの抽出（`BASE_CELL_SIZE=28`、ホイール `-deltaY*0.1`、shift+wheel `±15°` ステップ、150ms 回転デバウンス、ピンチ閾値、`passive: false` 登録順、`devicePixelRatio` 計算など全て一致）
- `App.tsx` の `AppHeaderShell` / `AppMainContent` / `AppOverlayLayer` への 3 層分割（条件分岐・props・JSX 構造一致）
- `useListInteractionState` 抽出（8 つの useState、`toggleCurrentRangeSelection` の polygon point-in-poly テスト・block group 解決・rangeStart/End トラッキング・選択トグルセマンティクスすべて元の `handleToggleRangeSelection` と一致）
- `itemOps/` 5 ファイル分割: 14 関数 (`computeUpdateItem`, `computeDeleteItem`, `computeAddItemFromFocusMode`, `computeAddToExecuteListFromMap`, `computeAddToExecuteListFromMapAtPosition`, `computeRemoveFromExecuteListFromMap`, `computeMoveToExecuteColumn`, `computeRemoveFromExecuteColumn`, `reorderExecuteIdsForSpaceAdjacency`, `computeMoveItem`, `computeMoveItemVertical`, `computeUpdateItemPriority`, `computeHallOrderForPriorityChange`, `findItemHallId`) のすべての本体がバイト等価（空白・import パス除く）
- `itemOps.regression.test.ts` の追加テスト（hall-order 挿入、space-group 拡張、hall-boundary D&D ブロック、priority hallOrder 遷移、space adjacency）が高リスクパスをカバー
- `hallOperations.ts` の `splitHallsForStorage`、`splitGlobalHallRouteSettings`、`getCombinedHallRouteSettingsForDate`、`getGlobalHallItemCount`、`reorderExecuteIdsByHallOrder`、`resolveItemHallGroupId` は元のインライン実装と等価（TICKET-11/12 の差異を除く）
- `App.tsx` 残存ハンドラ: `handleSelectItem`、`handleBulkSort`、`handleReorderExecuteListByHallOrder` は元コードとバイト等価（or 等価デリゲート）
- `components/map/VisitListPanel.tsx` → `MapVisitListPanel.tsx` への改名（コンポーネント名・型名のみ変更、JSX / props / ロジックは同一）
- `resumeChoice.ts` のロジック（テストは 3 件追加されているが既存テストはそのまま）
- **`App.tsx` トップレベル useEffect 全 14 箇所**（hall definitions migration、focusModeSessions cleanup、`mapTabMenuOpen` クリック外検知、`mapSmartInsertEnabled` localStorage 永続化、`mapSmartInsertMode` localStorage 永続化、`smartInsertToast` 2000ms 自動消滅、`visitListPanel` map tab 同期、vertex-selection / cellSelection mapCellClick リスナー、`executeColumnItemsRef` / `recentlyChangedItemIdsRef` sync、フィルタボタンリセット、検索インデックスリセット 2 種）— すべて元コードとバイト等価、依存配列も完全一致
- **`FocusModeMapCanvas.tsx` 残存ロジック**: `getPointerViewMetrics`、`calculateCenteredOffset`、ホール選択 useEffect、centering-mode useEffect (`prevCenteringModeRef` ガード、`mapCenteringMode === 'prevToCurrent'` 判定)、ルート線描画 (`lineWidth = max(2, cellSize*0.08)` ほか定数)、クリック/ドラッグ閾値（タッチ 10px / マウス 5px、400ms suppressClick、100ms isDragging クリア）はすべて元コードとバイト等価
- **`rawHideSomething` フローティング目アイコンボタン**: [App.tsx:4291-4344](src/App.tsx)（元 `App.tsx:5746-5799`）に完全保存。条件 `rawHideSomething && activeEventName && (currentMode === 'focus' || currentMode === 'execute')`、ハンドラ、SVG パス、`fixed left-3 top-3 z-20 w-10 h-10 rounded-full` まで全て一致
- **`mapFileInputRef` / `exportFileInputRef` 配線**: [AppOverlayLayer.tsx:630-636, 649-655](src/features/app-shell/components/AppOverlayLayer.tsx) に移動、ref / onChange / `.click()` トリガー全て保存
- **`mapToggleButtonRef` ロングプレスメニュー**（`mapTabMenuOpen === 'mapToggle'`）の 3 項目（📍 訪問リスト / 🔲 ブロック定義 / 🏛️ ホール定義）はすべて元コードとバイト等価
- **`AppMainContent.tsx` の 6 主要コンポーネント prop 受け渡し**: `EventListScreen` (7 props)、`ImportScreen` (7 props)、`MapView` (32 props)、3x `ShoppingList` (25-31 props)、`FocusModeContainer` (22 props) すべて元コードと同一。型注釈 `(prev: boolean)` / `(block: string)` のみ追加（型推論補助のみ、動作影響なし）
- **`TabButton` コンポーネント**: 元 `App.tsx:4436-4498` → 新 `App.tsx:3813-3875` に移動、500ms longPressTimeout、`handleToggleMode()` 呼び出しすべて元と一致
- **抽出 hook 全 5 種の byte 比較**: `useThemeMode` (key=`'themeMode'`、default=`'system'`、deps=`[themeMode]`) / `useUIVisibilitySettings` (key=`'uiVisibilitySettings'`、try/catch、spread merge) / `useNumberCellOutlineStyle` (key=`'numberCellOutlineStyle'`、default=`'rounded'`、import パス変更のみ) / `useDisablePriceUndefinedCheck` (key=`'disablePriceUndefinedCheck'`、default=`false`、`saved === 'true'` 判定) / `useIndexedDbPersistence` (IndexedDB、`saveDelayMs=500`、import 再グループのみ) — すべて Category A
- **`FocusModeMapCanvas` の wheel-zoom / pinch / 回転タイマー / `zoomLevelRef` sync**: `useCanvasViewport` 経由で抽出され元コードと等価 (ホイール `-deltaY*0.1`、shift+wheel ±15°、ピンチ距離比、150ms 回転デバウンス、MIN/MAX_ZOOM クランプすべて一致。`Math.round` の演算順序のみ変更されているが整数 zoom 値範囲では等価)
- **`BatchedPathRenderer` / `collectEdgeWithBridges`**: 両ファイルが `src/utils/routeRendering.ts` から import、ファイル自体が両プロジェクトでバイト等価
- **`mapToggleButtonRef` の onPointerDown ロングプレス開始ロジック** [App.tsx:4939-4963 → AppHeaderShell.tsx:357-381]: 500ms timeout、`setMapTabMenuPosition` / `setMapTabMenuOpen('mapToggle')` 本体、`pointerup`/`pointercancel` cleanup すべて一致
- **`AppMainContent` の outer 呼び出し側**: [App.tsx:4346-4468](src/App.tsx) で 126 props がすべてアルファベット順に渡されており、`AppMainContent.tsx:37-163` の prop interface と完全一致（※ interface は `app-shell/types.ts` ではなく `AppMainContent.tsx` 内にローカル定義）
- **`vitest run` 実行結果**: 8 test files / **56 tests / 全件 PASS**（`itemOps.regression.test.ts` 5件、`hallOperations.test.ts` 5件、`resumeChoice.test.ts` 20件、`FocusMode.integration.test.tsx` 8件、その他 utils テスト 18件）
- **FocusMode 系のモジュールスコープヘルパ全 12 個** (`extractBaseNumber`、`getVisitKey`、`hasCellInputValue`、`normalizeRotationAngle`、`rotatePointAroundCenter`、`parseCssColorToRgb`、`isWhiteLikeColor`、`isDarkLikeColor`、`resolveMapTextColorForTheme`、`isSameIdSet`、`buildIdSetSignature`、各種定数 `SWIPE_THRESHOLD` / `FOOTER_HEIGHT_*` / `HEADER_HEIGHT` / `BASE_CELL_SIZE` / `SCROLL_MARGIN`) — すべて元コードとバイト等価（`||` ↔ `??` の置換、`===` ↔ `==` の変更、off-by-one、regex 変更すべてなし）
- **`mapTabMenuPosition` 座標計算**: `e.currentTarget.getBoundingClientRect()` → `{ left: rect.left + rect.width / 2, top: rect.bottom + 4 }` の演算と `transform: translateX(-50%)` 配置スタイルが両プロジェクトで一致
- **動的 localStorage / IndexedDB キー**: `buildFocusSessionKey(eventName, eventDate)` → `${eventName}::${eventDate}` 一致、`DB_NAME='EventShoppingPlannerDB'` / `DB_VERSION=4` / 11 ストア名一致、レガシーマイグレーション用 9 キー一致、`saveData(STORE, 'data', ...)` のシングルトンキー一致 — **RC1.9.4 から既存ユーザの保存データが完全に保持される**
- **`buildResumeChoiceDialogState`**: 元 [FocusMode.tsx:896](src/components/FocusMode.tsx) → 新 [src/components/focus/hooks/useResumeFlow.ts:144](src/components/focus/hooks/useResumeFlow.ts) に移動済み、削除されてはいない
- **FocusMode.tsx の JSX 主要要素**（3 つの render 分岐の navigation buttons の color cascade `hasUndefinedPricePurchased ? red : isNextButtonBlinking ? green animate-pulse : blue`、`SWIPE_THRESHOLD=50` / `FOOTER_HEIGHT_SP=56` / `HEADER_HEIGHT=64` / `FOOTER_HEIGHT_PC=64` / `footerOverlapGuardPx=1` 等の数値定数、`headerContainerClass` / `itemListContainerClass` / `navPrevStyle` / `navNextStyle` の useMemo 本体、Tailwind class 文字列）— 元コードとバイト等価

---

## 推奨対応順序

1. **TICKET-01, 02, 03, 03b, 03e, 14, 15, 19**（S1: 機能不全・誤字・情報損失・UI 消失・操作不能）を最優先修正
2. **TICKET-03c, 03d, 04, 05, 06, 11, 12, 13, 16, 17, 18**（S2: 仕様変更・意図確認）を作者と確認し、意図に応じて `intentional` クローズ or 復元 PR
3. **TICKET-07, 08, 09, 20**（S3: UI 微変更）を一括レビュー
4. **TICKET-21**（S4）は verified（対応不要、TICKET-10 は fixed）

修正後は `vitest` を全件パス、`npm run lint` を通過、フォーカスモードの手動シナリオ（resume / phase 切替 / マップ表示）を一巡することを完了条件とする。

---

## 残課題（未検証範囲）

静的解析で検証可能な領域はほぼ網羅。残る項目：

- 実ブラウザでの**手動操作シナリオ**（フォーカスモードの phase 切替、resume ダイアログ、マップ表示、SP/PC レイアウト切替、no-map 切替、バルクアクション、UI 設定パネル）— 静的解析では捕捉できない
- E2E テスト（プロジェクトに E2E test framework は存在せず、手動検証のみ）
- IndexedDB スキーマアップグレード経路（`request.onupgradeneeded` 内の挙動、ストア作成は確認済みだが追加マイグレーション処理は未検証）
- `sessionStorage` / Service Worker / Cache API の使用有無（grep スコープでは見当たらず、未使用と推定）
