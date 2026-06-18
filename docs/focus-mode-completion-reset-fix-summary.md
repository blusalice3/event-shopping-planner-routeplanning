# 集中モード完了画面 再入場時ダイアログ表示仕様

## 対象ファイル
- `src/components/FocusMode.tsx`
- `src/components/focus/resumeChoice.ts`
- `src/components/FocusMode.fixtures.tsx`
- `src/components/focus/resumeChoice.test.ts`
- `src/components/FocusMode.integration.test.tsx`
- `src/test/setup.ts`
- `vitest.config.ts`

## 現行仕様

### 完了済みセッションの再入場(別モードから戻る / タブ切替)
- 完了済み再入場時(`resumeState.isCompleted === true`)は **再開ダイアログ** を表示する。
- ダイアログの選択肢:
  - 最後に購入状態を変更したスペース(`lastChange`)
  - 離脱時のポインタ位置(`pointer`) … 選択時に完了画面を復元する
  - 現在のフェーズの最初から(`phaseStart`)
  - 通常フェーズの最初から(`normalStart`)
- 完了済み再入場時も `lastPurchaseChangeAt` を保持する。`pointer` 選択で完了画面を復元する場合も保持し、他の選択肢(`lastChange` / `phaseStart` / `normalStart`)ではクリアする。

### 同一セッション内
- 完了画面表示中は自動で通常フェーズへ戻さない(既存仕様を維持)。

### リロード後
- `focusModeSessions` は `useIndexedDbPersistence` の永続化対象外(揮発 state)であるため、フルリロード後は `resumeState=null` となり新規セッション扱い。通常フェーズ先頭から開始する。
- リロード後も完了状態を維持したい場合は、別 PR で `focusModeSessions` を IndexedDB 永続化対象に追加する必要がある。

### その他の保護
- 実行列が空(`allVisits.length === 0`)の場合は、完了状態より優先して「訪問先がありません」画面を表示する。
- 再開ダイアログ表示中は auto-advance を抑止し、既存の auto-advance タイマーも停止する。
- 再開ダイアログ表示中は `isAutoAdvancing` 早期 return も抑止し、ダイアログを優先表示する。
- 再開ダイアログ初期化完了まで `onSessionStateChange` による親への書き戻しを抑止する。加えて、render 時点の `isResumeTransitioning` 判定とダイアログ開中フラグでも書き戻しを抑止する。
- `resumeState` の null↔non-null 遷移時はダイアログ初期化フラグ、初期解決フラグ、snapshot ref を一括で reset / 差し替える。

## 主な実装ポイント

### 1. 初期化 state (`FocusMode.tsx`)
```tsx
const [currentPhase, setCurrentPhase] = useState<FocusPhase>(
  () => resumeState?.phase || 'normal',
);
const [currentPhaseIndex, setCurrentPhaseIndex] = useState(
  () => Math.max(0, resumeState?.phaseIndex || 0),
);
// 完了状態は常に false 初期化。完了済み再入場時は再開ダイアログの pointer 選択で復元する。
const [isCompleted, setIsCompleted] = useState(false);
const [lastPurchaseChangeAt, setLastPurchaseChangeAt] = useState<{...} | null>(
  () => resumeState?.lastPurchaseChangeAt ?? null,
);
```

### 2. 初回 `resumeState` スナップショット
親の `onSessionStateChange` で上書きされる前の値を保持する。再開ダイアログ判定で使う。
```tsx
const initialResumeStateRef = useRef<FocusModeSessionState | null>(resumeState ?? null);
useEffect(() => {
  if (!initialResumeStateRef.current && resumeState) {
    initialResumeStateRef.current = resumeState;
  }
}, [resumeState]);
```

### 3. 初期解決ゲート
```tsx
const [isResumeInitResolved, setIsResumeInitResolved] = useState(() => !resumeState);
const isResumeTransitioning = Boolean(resumeState) && !hadResumeStateRef.current;
```
`onSessionStateChange` の書き戻しは以下 3 条件を満たすまで抑止:
1. 遷移中でない(`!isResumeTransitioning`)
2. 初期解決完了(`isResumeInitResolved`)
3. 再開ダイアログが閉じている(`!resumeChoiceDialog?.isOpen`)

### 4. ダイアログ state 生成とユーザー選択適用の純粋関数
`src/components/focus/resumeChoice.ts` に `buildResumeChoiceDialogState` と `resolveResumeChoice` を切り出す。ダイアログ state には `pointerPhase` / `pointerIndex` / `phaseStartPhase` / `wasCompleted` を snapshot として保持する。

### 5. `applyResumeChoice` の `pointer` 分岐
```tsx
if (choice === 'pointer') {
  setCurrentPhaseIndex((prev) => clampPhaseIndex(currentPhase, prev));
  if (dialog.wasCompleted) result.isCompleted = true;
}
// lastPurchaseChangeAt は pointer + 完了復元時のみ保持(他の選択肢ではクリア)
if (result.isCompleted !== true) setLastPurchaseChangeAt(null);
```

## テストハーネス運用

`src/components/FocusMode.fixtures.tsx` の `StatefulFocusModeHarness` は
統合テスト用の items state 管理ラッパ。設計上、`initialItems` prop の
後続変更は **無視** する (ユーザー操作で変化した state を上書きしないため)。

- items を差し替える必要があるテストでは `<StatefulFocusModeHarness key={n} .../>`
  のように key を変えて明示的にリマウントすること。
- props の差し替えだけでは state は更新されない。

## テスト

- 単体テスト: `src/components/focus/resumeChoice.test.ts` (17 ケース)
  - `buildResumeChoiceDialogState`: 完了済み + lpc あり/なし、allVisits=0、未完了、null 入力、phaseStartPhase スナップ、visitKey マッチ/ミスマッチ
  - `resolveResumeChoice`: 4 選択肢 × enabled/disabled 組合せ、pointer の wasCompleted 分岐
- 統合テスト: `src/components/FocusMode.integration.test.tsx` (8 ケース)
  - 同一マウント内の null→non-null 遷移でダイアログ表示
  - 初回 isCompleted=true でダイアログ表示
  - ダイアログ表示中に isCompleted=false の書き戻しが発生しない
  - pointer 選択で完了画面表示
  - normalStart 選択で通常フェーズ先頭訪問 UI 表示(完了画面にならない)
  - pointer 選択後も lastPurchaseChangeAt が親 payload に保持される
  - auto-advance 起動中に non-null→null 遷移するとタイマーが発火せず phase/phaseIndex が動かない
  - null→non-null 遷移直後の遷移中ガードで isCompleted=false 書き戻しが発生しない

実行: `npm run test:run`
