# Resilient Persistence Recovery and Safe Legacy Migration Plan

永続化復旧・旧localStorage安全移行の是正計画

## 目的

IndexedDB（以下IDB）とlocalStorageの間で、因果関係を確認できる最新の確定データを一意に選択できるようにします。保存失敗、cleanupの部分失敗、処理中断、複数タブ、旧版との混在が発生しても、古い値への巻き戻りや検証前の原本消失を起こさず、通常起動と安全な復旧を継続できる永続化基盤を完成させることが目的です。

優先順位は、`データ正当性 > 復旧可能性 > 通常時の可用性 > 不要データの削除` とします。新旧を安全に判定できない場合は推測で上書きせず、両方を保持して復旧操作へ移行します。

## レビュー結果と対象課題

最新コミットではrevision付きフォールバック、競合検出、移行ジャーナル、復旧画面の基礎が追加されています。一方、正常運用へ移行する前に次の残存課題を解消する必要があります。

| 優先度       | 課題                                                                                           | 想定される影響                                                            | 本計画での対応                                                      |
| ------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 必須         | フォールバックcleanupが途中で失敗すると、吸収済み候補の証拠まで一部失われる                    | 後続読込で古い候補を未知branchと判定、またはIDB障害時に古い値を返す可能性 | IDBへ吸収checkpointを原子的に保存し、削除後もtombstoneを保持        |
| 必須         | 旧localStorage移行後のcleanupが完了せず、原本が残り続ける                                      | 容量を圧迫し、以後の実行時フォールバック保存も失敗する可能性              | 検証済み移行とcleanupを分離し、安全条件を満たす場合だけ段階的に削除 |
| 必須         | `mapData` の `{ Event: {} }` が論理上残る一方、物理レコードは作られない                        | 保存時digestと読戻し結果が一致せず、誤競合になる                          | 空eventの意味を確定し、正規化または明示マーカーを全経路で統一       |
| 必須         | `copied` / `verified` から移行を再開した際、実データではなく再構成したrootを登録する経路がある | 移行直後の通常保存で偽のCAS競合になる                                     | IDBを直接読戻して得た実rootだけを登録                               |
| 条件付き必須 | 過去コミット `d2389a0` が実環境で動作済みの場合、親revisionを失った候補が残り得る              | 自動選択できない孤立branchが発生                                          | 配布実績を確認し、該当時は隔離・退避・明示選択による専用復旧を先行  |

## スコープ

### 対象

- [indexedDB.ts](../src/utils/indexedDB.ts) の保存、読込、修復保存、移行、restore
- [persistenceResilience.ts](../src/utils/persistenceResilience.ts) のrevision照合、候補選択、metadata、checkpoint
- [mapDataPersistence.ts](../src/utils/mapDataPersistence.ts) の論理正規化、分割保存、再構築、digest
- [useIndexedDbPersistence.ts](../src/hooks/useIndexedDbPersistence.ts) の起動状態、autosave抑止、cleanup再試行
- [PersistenceRecoveryScreen.tsx](../src/components/PersistenceRecoveryScreen.tsx) と状態表示の復旧導線
- 関連するunit、integration、実ブラウザ/PWAテストおよび運用手順

### 対象外

- 買い物計画、経路計画、地図操作など永続化以外の機能変更
- クラウド同期やサーバー側バックアップの新設
- 因果関係を証明できないbranchの自動マージ
- 旧版・休止中タブの不在を確認できない状態でのlocalStorage強制削除
- `mapData` を実行時フォールバックの対象へ追加する仕様変更

## 設計上の不変条件

1. revision番号の大小だけでは最新とみなさず、`baseRevision`、digest、確定rootとの連続性を検証する。
2. payload、metadata、吸収checkpointは、対象storeと予約レコードを含む同一IDB transactionで確定する。
3. cleanup失敗後も、どの候補がIDBへ吸収済みかを判定できる証拠を失わない。
4. 全対象領域の保存と直接読戻し検証が完了するまで、旧localStorage原本を1件も削除しない。
5. 移行開始後に値が変化した原本は削除せず、新しい候補または競合として隔離する。
6. 移行完了とcleanup完了を別状態にし、cleanup延期だけで通常起動やautosaveを停止しない。
7. mapの正規化、digest、物理保存、再構築は同じ論理表現を使用する。
8. 各処理は任意のtransactionまたはキー処理直後に中断しても、再実行可能かつ冪等にする。
9. ログ、telemetry、エラー報告へユーザーpayloadを出力しない。

## 実装計画

### Phase 0: 仕様確定と失敗テストの固定

- `d2389a0` の配布・起動実績を確認し、孤立候補向け復旧を必須にするかgo/no-goを決定します。
- `{ Event: {} }` と `{}` を同一と扱うかを決定します。同一なら空eventをpruneし、別物なら物理マーカーを導入します。
- 自動cleanupを許可する対応ブラウザ、PWA更新条件、旧版タブ検知方法、手動cleanupの運用責任を確定します。
- 現在の不具合と残存課題を再現する失敗テストを先に追加し、修正前に期待結果を固定します。
- この段階では本番データ形式やcleanup動作を変更しません。

### Phase 1: フォールバック吸収checkpointの導入

- 既存DBバージョンと生payload形式は原則維持し、既存の予約領域へversion付きcheckpointを追加します。新しいobject storeが必要と判明した場合だけ、別途DB upgrade互換性を審査します。
- checkpointには最低限、確定済みの`revision`とdigest、吸収済み候補の`revision`、`baseRevision`、digest、schema versionを記録します。
- 通常保存、フォールバックからの修復保存、migration、backup restoreのすべてで、payload・metadata・checkpointを同一transactionへ含めます。
- 新しい保存を開始する前にもlocalStorage候補を走査し、未解決branchがあればrevisionを進めず競合として保持します。
- IDB commit後にフォールバックをcleanupします。各候補は「現在値確認 → 削除 → 欠損確認」の順で処理し、途中で失敗してもcheckpointから吸収済みと判定できるようにします。
- tombstoneは削除直後に破棄せず、旧版が再び候補を書き戻せないversion fenceを越えるまで保持します。
- IDBの確定rootもcheckpointも読めない新規セッションでは、孤立候補を推測採用しません。候補を保全したまま`recovery-required`へ移行します。

### Phase 2: map正規化と実root登録の統一

- Phase 0で決めた空eventの表現を、保存前正規化、digest計算、分割put、欠損検査、読戻し、migration、restoreで共通利用します。
- `{ Event: {} }`を空と同一視する場合は、すべての経路で`{}`へ正規化し、意味のないmetadataだけが残らないようにします。
- `copied` / `verified`からの再開ではmetadataを合成せず、IDB内の全対象を直接読み、共通正規化後の実rootを登録します。
- 「移行再開後、事前loadなしで直ちに通常保存する」回帰テストを追加し、偽のCAS競合が発生しないことを確認します。

### Phase 3: 移行ジャーナルv2と復旧アーカイブ

- journalを`prepared → copied → verified → cleanup-ready → cleanup-in-progress → completed`へ拡張し、データ移行状態とcleanup状態を別フィールドで管理します。
- journal v1からv2へ安全に昇格できるreaderを用意し、不明なversionは自動処理せず復旧画面へ送ります。
- `verified`は、全対象storeの直接読戻し、論理正規化後のdigest一致、実root登録まで完了した場合だけ設定します。
- cleanup前に、旧キー名、raw値、digest、取得時刻を含む復旧アーカイブをIDBへ保存して直接読戻し検証します。容量不足などで保全できない場合は削除しません。
- journalへキー単位のcleanup状態と期待digestを記録し、各キー処理後に確定します。
- cleanup中に原本が変化または再出現した場合は削除せず隔離し、ユーザーへ退避・比較・再試行の選択肢を示します。
- アーカイブとtombstoneの保持期間・削除条件は、対応版への移行率とロールバック可能期間を基準に別途明文化します。

### Phase 4: 排他的かつ再開可能な旧原本cleanup

- 自動cleanupは、Web Lock等の排他、対応版タブ間のversion handshake、Service Worker更新状態、全クライアントのquiesce確認がすべて成立する場合だけ実行します。
- 旧版、休止中、無応答のタブがある場合、Web Locks非対応の場合、排他を証明できない場合は`cleanup-deferred`とし、通常起動を継続します。
- localStorageには原子的なcompare-and-deleteがないため、値の一致確認だけで安全を断定しません。排他条件を前提に、raw値の一致確認、`removeItem()`、削除後読戻し、journal更新をキー単位で行います。
- 値が期待値と違う場合は以降の削除を停止し、その値を新しい候補として保存します。
- 自動cleanupできない環境には、他タブをすべて閉じたことを確認してから実行する手動導線を提供します。
- 再起動時はjournalの最後の確定位置から再開し、完了済みキーの再削除や未確認キーの飛び越しを行いません。

### Phase 5: 起動制御、互換性、復旧UI

- `dataMigrationStatus`と`cleanupStatus`を分離します。copyとverificationが完了していれば、cleanupがpending/deferredでも通常起動とautosaveを許可します。
- 起動停止は、digest不一致、未知branch、原本への新規書込み、破損envelopeなど、データを一意に選べない状態に限定します。
- 復旧画面には再試行、候補と旧原本のJSON退避、選択理由を示した明示的採用、何も削除しない終了を用意します。
- `d2389a0`由来の親なし候補は自動採用・自動削除せず隔離します。配布実績がある場合は、この復旧機能をcleanupより先にリリースします。
- 旧generic `syncQueue` localStorageキーの利用実績を調査し、利用者データがあり得る場合は自動削除せずarchive対象へ追加します。
- public DB API、自動保存、atomic restore、map split store、import/export、PWA更新、既存`syncQueue`処理の互換性を回帰確認します。

### Phase 6: 検証、段階リリース、観測

#### Release A: 読込・保存・復旧の安全化

- checkpoint、互換reader、map正規化、実root登録、journal v2、復旧導線を導入します。
- namespaced `syncQueue` runtime fallbackも起動時に検証し、未解決候補は明示採用せずJSON退避専用で復旧画面へ含めます。
- 旧localStorageの物理cleanupはfeature flagで強制OFFにします。
- canary環境でcheckpoint採用率、修復成功率、競合率、保存失敗率、起動時間を観測します。
- `d2389a0`配布済みの場合は、孤立候補の検出・退避が機能することをRelease Bの必須条件にします。

Release Aの「実装完了」は同一のclean full SHAでコード、A1〜A12相当の自動／隔離環境試験、配布資材が完了した状態です。「本番受入完了」はそれに加えてprovider設定、24時間canary、実installed PWA、rollback、証跡validator、承認が完了した状態です。実測していない外部証跡がある場合は前者だけを完了とし、本番承認済みとは判定しません。

#### Release B: 条件付きcleanup

- Release Aの互換期間を経て、対応版クライアントだけで排他を証明できる場合に限りcleanup flagを段階的に有効化します。
- cleanup延期理由、削除成功・失敗、値不一致、キー再出現、復旧画面到達数をpayloadなしで観測します。
- 競合率、データ復旧率、保存失敗率に悪化があればkill switchでcleanupを即時停止します。
- cleanup後は旧localStorage原本へ依存する版へのロールバックを禁止します。Release A形式を読める版へのロールバック互換性は維持します。

## テスト計画

| 分類                  | 主なケース                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| revision unit         | IDB旧／fallback新、その逆、同revision異digest、親なし、複数branch、破損envelope、吸収済み候補の再出現                 |
| fallback integration  | IDB保存失敗、修復失敗、cleanup各候補での部分失敗、容量超過、IDB利用不能、localStorage利用不能、再起動後の再判定       |
| map integration       | `{ Event: {} }`、複数event/day、部分欠損、保存・migration・restore後の論理値とdigest一致                              |
| migration integration | 一部旧キーのみ存在、JSON不正、transaction rollback、各journal段階での中断、原本変化、archive失敗、キー単位cleanup再開 |
| 互換性                | journal v1/v2、既存fallback envelope、DB v5/v7、未対応version拒否、過去コミットからのupgrade fixture                  |
| 実ブラウザ/PWA        | 新版同士・旧版混在の複数タブ、背景化・休止・無応答、Web Locks非対応、lock取得不能、Service Worker更新待ち、offline    |
| 競合注入              | 比較と削除の間の書込み、削除直後の強制終了、cleanup済みキーの再出現、`d2389a0`由来の孤立候補                          |
| 機能回帰              | 通常起動、autosave、backup restore、import/export、map表示・編集、復旧画面、cleanup延期中の継続保存                   |
| 品質                  | 全unit/integration test、型検査、build、format、文字コード・BOM・改行検査                                             |

実ブラウザ試験は少なくともChromium系の通常タブとインストール済みPWAで行います。自動化できない旧版混在、Service Worker更新、タブ休止は手動手順をrunbookへ残します。

## 受け入れ条件

- fallback cleanupが任意の位置で失敗しても、再起動後に最新の確定値を返し、古い値へ巻き戻らない。
- IDBのrootを確認できない場合は古い候補を推測採用せず、データを保持したまま復旧へ移行する。
- 全領域の保存・直接読戻し・digest検証・復旧アーカイブ検証が成功する前に旧原本を削除しない。
- 移行中またはcleanup中に変化した原本を削除しない。
- 安全条件を満たす環境では、cleanupを中断・再開して最終的に`completed`へ到達し、対象旧キーが削除される。
- cleanup延期は通常起動とautosaveを阻害せず、旧版混在時に自動削除しない。
- mapの空eventを含む全対応値が保存・読込・migration・restoreで同じ論理値とdigestになる。
- `copied` / `verified`再開直後の保存で偽のCAS競合が発生しない。
- `d2389a0`由来を含む孤立候補を自動採用・自動削除せず、退避または明示復旧できる。
- namespaced `syncQueue` fallbackを毎起動時に検証し、一意に連続する候補だけを修復する。競合候補はIDB・checkpoint・localStorage原本を保持し、明示採用不可のJSON退避対象として表示する。
- public DB APIおよび永続化以外の既存機能に回帰がない。
- 全自動テスト、型検査、build、format、対象ブラウザ/PWA試験、ロールバック演習が成功する。
- UTF-8 BOMなしと既存改行形式を維持し、U+FFFD、不自然な`?`、日本語文字化け、改行だけの大量差分がない。

## 成果物

- checkpoint、journal v2、map正規化、条件付きcleanupを実装した永続化コード
- 障害注入を含むunit/integration/実ブラウザ回帰テスト
- 復旧画面、cleanup状態表示、手動再試行・JSON退避導線
- feature flag、kill switch、privacy-safeな観測項目
- 配布判定、cleanup実行、ロールバック、孤立候補復旧のrunbook

## 実装開始前の決定事項

次の4点をPhase 0で確定した後に実装規模と日程を見積もります。

1. `d2389a0`が利用者環境へ配布され、実際に起動された可能性
2. `{ Event: {} }`を`{}`と同一視するかどうか
3. 自動cleanupを保証する対応ブラウザとPWA更新方針
4. 自動cleanupできない利用者への手動復旧・サポート方針
