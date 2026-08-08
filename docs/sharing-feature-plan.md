# 共有・連携機能 新規実装プラン

> 状態: 未着手
>
> 対象: `event-shopping-planner-routeplanning-1.9.6.7`
>
> この文書は、現行ソースへ共有・連携機能を新規実装するための正本である。旧版向け文書にあった
> migration、RPC、試験結果、工数、commit、承認、完了状態は引き継がない。

## 1. 文書セット

実装時は次の順で参照する。

1. 本書で現在地、実装順、完了条件を確認する。
2. [要件](./sharing-feature-requirements.md)でMVPの範囲と受入条件を確認する。
3. [設計](./sharing-feature-design.md)で現行コードとの統合方法を確認する。
4. [protocol](./sharing-feature-protocol.md)でDB、RPC、RLS、同期契約を確認する。
5. [検証計画](./sharing-feature-verification.md)で必要な試験を確認する。
6. [運用計画](./sharing-feature-operations.md)で有効化、停止、rollbackを確認する。

この6文書に日々の作業ログ、試験出力、SHA、工数実績は追記しない。実装後の証跡はCI、issue、
release記録など、対象commitと環境を特定できる場所に分離する。

## 2. 現行ソースの開始地点

2026-08-06時点のソース監査で確認できた事実は次のとおりである。

| 領域           | 現在の状態                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| フロントエンド | React 18、TypeScript、Vite、PWA。主状態は`src/App.tsx`の`useState`にある                              |
| ローカル永続化 | `src/utils/indexedDB.ts`の`EventShoppingPlannerDB` version 5。通常10 storeと未接続の`syncQueue`がある |
| Supabase       | SDK依存、runtime client、`src/lib/supabase.ts`は存在しない                                            |
| DB型           | `src/lib/database.types.ts`はmigrationで裏付けられていない簡易型であり、実装契約として使用できない    |
| 共有機能       | `src/features/sharing/`、共有UI、Auth、RPC、Realtime、同期処理は存在しない                            |
| backend資材    | 共有用schema、RPC、RLS、DB試験、共有用scriptは存在しない。基盤用migrationを共有契約として流用しない   |
| QR             | QR生成runtimeと直接依存は存在しない                                                                   |
| テスト         | Vitestの既存unit／integration試験はあるが、共有、Auth、RLS、複数client、offline同期の試験はない       |
| 識別子         | eventは変更可能な`eventName`をkeyにする。item IDの発番方式は複数あり、eventの安定IDはない             |

したがって、共有機能の実装状態は「一部完了」ではなく「未着手」とする。既存のDB型と
`syncQueue`は参考資材であり、検証なしに旧設計の続きとして実装しない。

実装とrelease証跡は、変更履歴を追跡できるGit管理下のworking treeで行う。

## 3. MVPの目的と範囲

### 3.1 目的

- 2〜4人程度の小規模グループが、同じイベントの商品と購入状況を共有できるようにする。
- 通信断や同時操作があっても、二重反映、誤った「同期済み」表示、ローカルデータ消失を防ぐ。
- 共有を利用しない既存ユーザーの操作、保存、export／importを変えない。
- 共有を停止した後も、各端末がローカル運用へ明示的に移行できるようにする。

### 3.2 MVPに含める

- 選択したローカルeventから共有roomを作成する。
- 招待URL、QR、手入力codeでroomへ参加する。
- Anonymous Authとnicknameでmemberを識別する。
- 初期商品snapshotを取得し、同名eventへ黙って統合しない。
- 商品の共有項目と購入状態を同期する。
- 変更version、operation ID、request hashによる冪等なmutationを行う。
- Realtime通知後にserver差分を再取得する。
- IndexedDBへ型付きoutboxとserver replicaを保存する。
- 未送信、送信中、競合、権限失効、結果不明、offlineを区別して表示する。
- 退出、hostによるroom終了、期限切れ、server側緊急停止を扱う。
- PC Chrome／EdgeとAndroid Chrome／PWAの主要導線を検証する。

### 3.3 MVPに含めない

- map、hall、route、viewport、表示設定の共有
- 担当者、委託、代理購入、再配分、個人予算
- 複数roomの同時利用、host引継ぎ、端末資格の高度な復旧
- push通知、メール通知、位置情報、一般公開room
- fallback後に分岐したデータの自動merge
- iPhone／iPadの正式サポート
- 旧版の2Rや後続Phaseを示すschema、RPC、休眠列の先行投入

詳細な共有項目と権限は[要件](./sharing-feature-requirements.md)を正本とする。

## 4. 実装原則

- 共有機能は既定OFFとし、環境変数とserver gateの両方で有効化する。
- local stateをserver stateで直接置き換えない。server replicaと楽観的変更を分離する。
- 業務mutationは原則RPC経由とし、browserからの直接table書込を許可しない。
- Realtimeは変更通知に使い、同期完了の証明には使わない。
- client時刻を認可、期限、rate判定、競合の最終判断に使わない。
- 適用済みmigrationを書き換えず、修正はforward migrationで行う。
- 生の招待秘密とservice role keyをlocalStorage、log、診断、XLSXへ保存しない。
- Auth sessionはSupabase SDKの管理下だけで永続化し、application独自のcopyを作らない。保存先と
  logout時の削除をM0で確認する。
- server確定前、revision不一致、outbox残存、結果不明の状態を「同期済み」と表示しない。
- 資格失効、protocol不一致、緊急停止、結果不明の操作を無条件に自動再送しない。
- 各milestoneはclient、server、UI、試験、文書を同じ変更単位で完成させる。

## 5. 実装milestone

すべて未着手から開始する。後続milestoneの作業は、直前の完了条件を満たすまでrelease対象に
含めない。

| ID  | 状態   | 内容               | 主な完了条件                                                                      |
| --- | ------ | ------------------ | --------------------------------------------------------------------------------- |
| M0  | 未着手 | 要件と制約の確定   | 未決事項を決定し、要件IDと設計・試験の参照が一致する                              |
| M1  | 未着手 | local基盤          | 安定event ID、IDB migration、feature gate、共有module骨格が既存データを壊さず動く |
| M2  | 未着手 | backend contract   | local Supabaseでschema、RPC、RLS、冪等性、negative testが合格する                 |
| M3  | 未着手 | room作成・参加     | 作成、招待、参加、初期snapshot、roomとlocal eventの紐付けが動く                   |
| M4  | 未着手 | online同期         | 商品・購入状態のmutation、Realtime invalidation、差分再取得、競合表示が動く       |
| M5  | 未着手 | offline・lifecycle | outbox、再接続、退出、終了、期限切れ、fallback、PWA更新を安全に扱う               |
| M6  | 未着手 | pilot準備          | 自動試験、実browser、accessibility、kill switch、rollback rehearsalが完了する     |

最初のend-to-end sliceは、feature gate OFF回帰、URL／QR参加、read-only初期snapshot、
online購入状態同期までとする。手入力codeとhostの商品内容編集は、この基本経路とsecurity contractが
通った後に同じMVPへ追加する。

### 5.1 M0 — 要件と制約の確定

実施項目:

- 仮置きしている最大4人、最大300商品、room最大7日を実測前提で確認する。
- hostだけが商品内容を編集し、全memberが購入状態を更新する初期権限を確認する。
- 招待URL／QRと手入力codeの有効期限、再発行、失効方法を決める。
- 共有対象field、privacy表示、対応browser、保持期間を決める。
- Supabaseの利用plan、現行制限、staging／production分離方針を確認する。
- offlineでqueueできる操作を購入状態更新に限定する案を確認する。
- 現行`persistSession: true`を維持する場合のAuth session保存先、logout、端末共有時のriskを確認する。

完了条件:

- [要件](./sharing-feature-requirements.md)の「実装前に確定する事項」に未決のまま実装を分岐させる
  項目がない。
- [protocol](./sharing-feature-protocol.md)の仮契約がreviewされている。
- [検証計画](./sharing-feature-verification.md)に全要件IDの受入方法がある。

### 5.2 M1 — local基盤

実施項目:

- `EventMetadata`へ`localEventId`を追加し、既存eventへUUIDを一度だけ付与する。
- rename、duplicate、delete、version付きXLSX export／import時のevent ID規則を実装する。
- legacy XLSX、同名eventへの更新、同一IDのrestore、別copy作成を明示的に区別する。
- 新規itemの発番を`crypto.randomUUID()`へ統一し、既存item IDは変更しない。
- server側では既存item IDを`text`の`source_item_id`として扱う。
- IndexedDB version 5から次versionへ前方migrationする。
- 既存の汎用`syncQueue`を流用せず、型付きの共有用storeを追加する。
- `src/features/sharing/`にdomain、data、hooks、componentsの境界を作る。
- `VITE_SHARING_ENABLED`が明示的に`true`のときだけ共有moduleを起動する。

完了条件:

- version 5の実データfixtureからupgradeして既存10 storeの内容が維持される。
- feature gate OFFまたはSupabase設定欠落時にAuth、Realtime、queue送信が起動しない。
- event rename後も`localEventId`とroom linkが変わらない。
- 共有用storeはlocalStorageへfallbackしない。

### 5.3 M2 — backend contract

実施項目:

- Supabase CLIとlocal migration／DB試験の構成を追加する。
- 最小schema、index、RLS、RPC、server gate、保持処理を実装する。
- Anonymous Auth、operator発行の一回限りcreator code、招待秘密のhash化、rate limitを実装する。
- operation receipt、request hash、row versionを実装する。
- local migrationから`src/lib/database.types.ts`を再生成する。

完了条件:

- 別room、未認証、退出済み、期限切れ、改ざんactorによるread／writeが拒否される。
- 同じoperation IDと同じpayloadは同じ結果を返し、異なるpayloadは拒否される。
- 同時に同じitemを更新してもtransactionとversion規則が維持される。
- server gate OFF時はclientの状態に関係なく業務writeが拒否される。

### 5.4 M3 — room作成・参加

実施項目:

- `EventListScreen`へ「共有roomを作成」「roomへ参加」の入口を追加する。
- 作成前に共有項目、member上限、期限、残余リスクを表示する。
- 初期itemをchunk uploadし、全件確定までroomを公開しない。
- 招待URLは秘密をURL fragmentへ格納し、query、履歴用log、analyticsへ出さない。
- fragmentは読み取り直後にmemoryへ移し、`history.replaceState`でaddress barと履歴entryから除去する。
- QRは招待URLを表し、同値のcopy可能な文字列と手入力codeも提供する。
- 参加previewでevent名、host nickname、商品数、期限、人数を表示する。
- 既存eventへは`localEventId`一致時だけ紐付け候補を出し、それ以外は別copyを既定にする。

完了条件:

- 作成途中のroomへ参加できない。
- 招待失効、期限切れ、満員、rate limitを区別して表示できる。
- 同名eventをID確認なしにmergeしない。
- reload後も秘密を永続化せず、成立済みroomとの非秘密linkだけを復元できる。
- create／invite rotationの応答喪失後は、非秘密operation IDからhost roomを回復し、新しいcredentialへ
  rotateできる。

### 5.5 M4 — online同期

実施項目:

- hostの商品内容変更と、memberの購入状態／限数購入数変更をcommand化する。
- edit、execute、focus、map popup、bulk操作を含む全購入状態mutation入口をinventory化し、共有中は
  共通command境界を必ず通す。
- local optimistic overlay、server replica、送信中commandを別管理する。
- RPC成功時だけserver versionを確定し、拒否時はcanonical stateへ戻す。
- Realtime受信時は対象roomのrevisionを確認し、差分またはsnapshotを再取得する。
- 競合時はserver確定値、端末変更、再適用／破棄の選択を表示する。

完了条件:

- 2つ以上のbrowser contextで同じ結果へ収束する。
- Realtime欠落や重複があっても再取得で収束する。
- stale versionの上書き、別room更新、権限外の商品構造変更が拒否される。
- purchase statusと限数購入数の不変条件がserver transactionで守られる。

### 5.6 M5 — offline・lifecycle

実施項目:

- 購入状態commandをIndexedDB outboxへ保存する。
- timeout、応答喪失、Auth refresh、再接続、reloadを処理する。
- 複数tabではWeb Locks等でapplication writerを1つに制限する。非owner tabは共有eventだけでなく、
  staleな`eventLists`全体を書き戻し得る操作をread-onlyにする。
- 一般memberの退出、hostの終了必須規則、期限切れ、招待失効、全write停止を処理する。
- 端末単位の明示的fallback後はsenderを停止し、local変更を旧roomへ自動再投入しない。
- 既存XLSX exportをfallback時の退避手段として案内する。

完了条件:

- offline、sleep、reload後もoutboxが失われず、重複副作用がない。
- `outcome_unknown`を成功または通常pendingとして誤表示しない。
- 退出／終了／失効後のoutboxを自動送信しない。
- 共有障害時も既存local eventを閲覧・編集・exportできる。

### 5.7 M6 — pilot準備

実施項目:

- [検証計画](./sharing-feature-verification.md)のrelease gateを実行する。
- CSP、PWA cache、Service Worker更新、依存脆弱性を確認する。
- [運用計画](./sharing-feature-operations.md)のkill switchとrollbackをrehearsalする。
- stagingで限定pilotを行い、上限値と監視閾値を実測で確定する。

完了条件:

- 重大なdata loss、cross-room access、秘密漏えい、重複購入が0件である。
- 対象browserとaccessibilityのblockerがない。
- gate OFFへ戻したとき既存local運用が継続する。
- production有効化の判断材料が実測値と再現可能な証跡で揃っている。

## 6. 主な変更予定箇所

| 現行path                                                | 予定する変更                                           |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `src/App.tsx`                                           | 共有sessionと既存event stateを接続する最小adapter      |
| `src/components/EventListScreen.tsx`                    | room作成／参加の入口                                   |
| `src/features/app-shell/components/AppMainContent.tsx`  | 共有入口のprops接続                                    |
| `src/features/app-shell/components/AppHeaderShell.tsx`  | 共有中・offline・未送信状態                            |
| `src/features/app-shell/components/AppOverlayLayer.tsx` | 作成、参加、競合、終了dialog                           |
| `src/features/sharing/`                                 | domain、Supabase adapter、sync coordinator、hooks、UI  |
| `src/types/item.ts`                                     | `localEventId`を含むevent metadataと共有projectionの型 |
| `src/utils/indexedDB.ts`                                | version migrationと共有専用store                       |
| `src/hooks/useIndexedDbPersistence.ts`                  | event ID migrationの接続。共有replicaの正本にはしない  |
| `src/features/events/recordOps.ts`                      | rename／delete時の安定event ID維持                     |
| `src/features/events/bulkAdd.ts`                        | 手動event作成時のmetadata／安定ID                      |
| `src/features/events/exportFlow.ts`                     | version付きXLSXへのevent ID出力                        |
| `src/features/events/fileImport.ts`                     | legacy／restore／別copy importの判定                   |
| `src/utils/exportImport.ts`                             | format versionと`localEventId`のcodec                  |
| `src/lib/supabase.ts`                                   | SDK導入phaseで型付きadapterとして新規作成              |
| `src/lib/database.types.ts`                             | local migrationから再生成                              |
| `supabase/migrations/`                                  | schema、RPC、RLS、server gate                          |
| `supabase/tests/`                                       | RLS、RPC、競合、冪等性、保持のDB試験                   |
| `vite.config.ts`／`vercel.json`                         | Supabase通信とCSPを必要最小限に制限                    |

## 7. 共通quality gate

各milestoneで影響範囲に応じて次を実行する。

- `npm run typecheck`
- `npm run lint`
- `npm run test:run`
- `npm run format:check`
- `npm run build`
- local Supabaseのmigration、DB contract、RLS negative test
- 複数client、offline、reload、PWA更新の統合試験
- keyboard、focus、live region、200% zoom、色以外の状態表現の確認

存在しないtest runnerやscriptを実行済みとして記載しない。導入したcommandは`package.json`と
[検証計画](./sharing-feature-verification.md)を同じ変更で更新する。

## 8. 実装前に確定する事項

次は旧版の数値を確定値として継承せず、M0で確認する。括弧内は設計を進めるための仮置きである。

| 項目             | 仮置き                                          | 確定に必要な確認                          |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| member上限       | hostを含め4人                                   | UI、同時操作、費用、rateの実測            |
| 商品上限         | 300件                                           | 初期upload、snapshot、IDB、低速回線の実測 |
| room期限         | 既定24時間、最大7日                             | cleanup、利用シナリオ、保持方針           |
| 同時room         | local eventごとに1つ                            | UXと状態管理の複雑性                      |
| 商品内容の編集   | hostのみ                                        | 参加者の実運用                            |
| offline queue    | 購入状態変更のみ                                | 競合と誤再送リスク                        |
| 正式browser      | PC Chrome／Edge、Android Chrome                 | PWAと実機試験                             |
| iOS              | MVP対象外                                       | 保存、PWA、deep linkの実測                |
| room作成制限     | server gateとoperator発行の一回限りcreator code | 公開範囲とabuse対策                       |
| 保持期間         | 未確定                                          | privacy、復旧、費用、cleanup実測          |
| Auth session保存 | Supabase SDK管理の永続session                   | reload回復、logout、XSS、共有端末risk     |

これらの変更がMVPのscope、data model、運用費用を大きく変える場合は、M1以降へ進む前に本書、
要件、protocol、検証計画を更新する。
