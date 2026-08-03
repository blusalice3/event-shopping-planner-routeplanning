# 永続化復旧・旧localStorage移行 runbook

## 1. 目的と適用範囲

このrunbookは、IndexedDB（IDB）、実行時localStorage退避、旧localStorage原本の間で競合、保存失敗、移行中断、複数クライアント混在が発生した場合に、データを失わず通常運用へ戻すための手順です。

判断の優先順位は次のとおりです。

1. データ正当性
2. 復旧可能性
3. 通常時の可用性
4. 不要データの削除

候補を一意に選べない場合は推測で上書き、採用、削除を行いません。原本と候補を保持し、復旧画面またはサポート手順へ移行します。

対象は次のとおりです。

- 通常保存、読込、実行時fallback、修復保存
- 旧localStorageからIDBへの移行
- map分割保存、backup restore、起動時autosave制御
- Release A / Release Bの配布、停止、rollback
- Chromium通常タブとインストール済みPWA

クラウド同期、共有機能、サーバー側backupは対象外です。

## 2. 現在の安全状態と禁止事項

2026-08-03時点では、`migrateFromLocalStorage({ cleanupLegacySources })` のcleanup指定は互換性のために残っていますが、物理削除には使用されず、旧原本は保持されます。Release Bの物理cleanupは別API `db.cleanupLegacyPersistenceSources(request)` に分離されています。通常起動、migration、autosave、復旧UIからこのAPIを呼ぶ経路はなく、静的capabilityは `VITE_PERSISTENCE_LEGACY_CLEANUP=true` の完全一致でのみONになります。既定値はOFFです。

APIの安全gateはruntime kill switchの明示的なinactive証明、実環境のWeb Lockのexclusive取得、対応clientのversion handshakeとquiescence、active Service Workerの対応version、waiting worker不在を検査します。自動cleanupではphase開始前、各キー、`removeItem()`直前、最終journal確定前にfull proofをlock内で再検査し、非同期検査後にもraw値を同期再読込します。欠損・timeout・不一致はfail closedで延期または停止します。public DB APIからbuild flagやlock managerを注入して迂回することはできません。

Release Aのprivacy-safeなmetrics送信、同一origin API、Supabase保存schema、24時間集計viewは実装済みです。ただし、対象providerへのmigration適用、server-only環境変数、Firewall/rate limit、canary配布、24時間の実測証跡はrepositoryだけでは完了しません。これらの証跡が本runbookのvalidatorを通るまでRelease Aのproduction gateは閉じたままです。

productionで利用するclient/SW証明provider、通常writerを含むquiescence protocol、再配備不要のkill switch、手動cleanup UIはまだ構成されていません。したがってRelease Bは引き続き禁止であり、`db.cleanupLegacyPersistenceSources`をconsoleや一時コードから直接呼び出してはいけません。

次の条件が未整備の間、Release Bは実施禁止です。

- 再配備なしで停止できるruntime kill switchとproduction用proof provider
- Web Locks等の排他、対応版間version handshake、全clientのquiesce確認
- Service Worker（SW）更新状態の確認
- cleanup前archiveの保存・直接読戻し検証
- payloadを含めない観測backendのproduction probeとalert
- 実ブラウザ/PWA試験とrollback rehearsal

現在のPWAビルドと`vercel.json`はいずれも`/sw.js`を対象にしています。ただし、HTTPS canaryの実レスポンスで再検証headerを確認し、active Service Workerのversion一致を証明するまでは、PWAをcleanup可能clientとして扱いません。

常に禁止する操作:

- ブラウザの「サイトデータを削除」、`localStorage.clear()`、IDB database削除を復旧手順として案内する
- DevToolsから旧キーや内部recordを直接削除する
- revision番号の大小だけで候補を採用する
- recovery JSON、raw localStorage値、イベント名、品目、URL、メモをissue、chat、log、analyticsへ貼り付ける
- cleanup後に旧localStorage依存版へrollbackする
- legacy `syncQueue`を推測変換、送信、通常の同期queueへ併合する

## 3. 役割

| 役割              | 責任                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| Release owner     | gate判定、段階配布、停止、最終sign-off                               |
| Persistence owner | checkpoint、journal、archive、互換reader、復旧結果の技術判定         |
| PWA owner         | SW version、cache header、通常タブ/PWA混在試験                       |
| Support owner     | 利用者への退避案内、payloadを受領しない一次対応、incident escalation |
| Observer          | privacy-safeなmetrics、alert、release evidenceの保管                 |

同一人物が複数役割を兼ねても構いませんが、Release Bの有効化はRelease ownerとPersistence ownerの二者確認を必須とします。

## 4. 用語と制御gate

### 4.1 Release区分

- **Release A**: 読込、保存、checkpoint、互換reader、map正規化、journal、復旧導線を安全化する版。旧localStorageの物理cleanupは常にOFF。
- **Release B**: Release A互換期間後、安全条件を現在のclient群で証明できた場合だけ、キー単位cleanupを段階的に許可する版。

checkpointの実装識別子は次を基準とします。

- record key: `__esp_internal__:checkpoint:v1:<encodedStore>:<encodedKey>`（先頭部分がnamespace）
- kind: `event-shopping-planner-persistence-checkpoint`
- schema: `PersistenceCheckpoint` version 1

別の識別子へ変更する場合は、互換reader、fixture、release evidenceを同じreleaseで更新します。

### 4.2 cleanupの三重gate

実装上の変数名が変わっても、次の論理gateを分離します。

| 論理名                   | 既定値 | 用途                                                                    |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| `cleanup-capability`     | OFF    | buildがcleanupコードを実行可能かを制限する静的gate                      |
| `cleanup-runtime-switch` | OFF    | 運用者が再配備なしでOFFへ戻せるkill switch                              |
| `cleanup-safety-gate`    | false  | lock、version、SW、quiesce、archive、値一致をclient側で毎回検証するgate |

有効条件は`capability AND runtime-switch AND safety-gate`です。設定欠損、取得timeout、形式不正、未知version、観測不能はすべてOFFとして扱います。

`cleanup-runtime-switch`を即時かつfail-closedに配布できる仕組みがない環境では、Release Bを開始しません。build-time環境変数の変更と再配備だけを「即時kill switch」とみなしてはいけません。

### 4.3 cleanup状態

運用上、少なくとも次を区別します。

- `not-started`
- `pending`
- `deferred`
- `in-progress`
- `completed`
- `recovery-required`

`deferred`は正常な安全判断です。cleanup延期だけを理由に通常起動やautosaveを停止しません。

公開migration結果は`dataMigrationStatus`と`cleanupStatus`を別々に返します。検証済み移行でcleanupだけが`deferred`の場合、通常画面は起動し、autosaveを継続して「保存済み・旧データ保全中」と表示します。

## 5. `d2389a0`配布確認

対象commit:

`d2389a02363176ba8354c4562f1a669a0b15dab9`

このcommitが利用者originで一度でも起動されていれば、親revisionを失ったfallback候補が残る可能性があります。

### 5.1 確認する証跡

次を同じ時刻範囲で確認します。

1. GitHubのbranch、tag、release、deploymentに対象SHAまたはそのbuildがあるか
2. Vercel等のproviderで、production / preview / manual CLI deploymentに対象SHAがあるか
3. custom domainのaccess logに、そのdeploymentの配信時刻とrequestがあるか
4. 手動upload、`vercel --prod`等、Git連携外の配布記録があるか
5. operatorが対象commitでproduction URLを開いた記録があるか
6. local `dist`の生成時刻と内容。ただしlocal buildだけでは配布済みの証拠にしない

確認結果は次のいずれかに固定します。

| 判定           | 条件                                                     | 処置                                                 |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `NOT_DEPLOYED` | provider側でも対象SHAの配信がなく、Git外配布も否定できる | 専用fixtureは維持し、通常の親なし候補として隔離      |
| `DEPLOYED`     | 対象SHAの配信または起動を1件でも確認                     | d2389a0孤立候補の検出・退避をRelease A必須gateにする |
| `UNKNOWN`      | provider log不足、手動配布を否定できない                 | `DEPLOYED`と同じ安全処置を取る                       |

### 5.2 2026-08-03のローカル監査結果

- 変更着手時のHEADは`1a61531611ecc2df210c7cdd954e52e30099d79d`
- `d2389a0`はその16 commit前の祖先であり、直親ではない
- ローカル追跡ref `origin/main`は`36272c88bc1db623f4c8f49a71440548c5b1efb4`で、`d2389a0`を含まない
- 対象SHAを含むremote branchとtagはローカル参照上0件
- `origin/main` reflogに対象SHAへの更新はない
- repository内にGitHub Actions等のdeploy workflowはない
- local `dist`の有無や生成時刻は配布証跡にしない
- 公開repositoryにはVercel URLと過去releaseがあり、配布経路自体は存在する

したがって正式な事実判定は`UNKNOWN`です。Release Aでは安全上の処置を`TREAT_AS_DEPLOYED`に固定し、孤立候補を自動採用・自動削除しません。固定fixtureによる「検出 → recovery JSON退避 → 明示採用 → 直後保存」のE2Eを必須gateにします。`NOT_DEPLOYED`へ変更できるのは、provider、Git外手動配布、access logを同一期間で否定し、監査記録が完全な場合だけです。Release Bは正式判定完了まで開始しません。

### 5.3 配布判定記録

release evidenceへ次を残します。利用者payloadやstorage値は記録しません。

```text
audit_id:
audited_at:
auditor:
target_commit: d2389a02363176ba8354c4562f1a669a0b15dab9
git_branch_tag_result:
provider_deployment_result:
manual_deployment_result:
access_result:
verdict: NOT_DEPLOYED | DEPLOYED | UNKNOWN
reviewer:
evidence_links:
```

## 6. legacy `syncQueue`の取扱い

旧実装ではIDB store `syncQueue`に対する保存がIDBで失敗した場合、generic localStorage key `syncQueue`へfallbackできました。現在の画面から`saveSyncQueue` / `loadSyncQueue`を呼ぶproduction経路はありませんが、過去の利用や外部呼出しがなかったことを証明できません。

localStorageに`syncQueue`が存在する場合:

1. 自動削除しない
2. JSONとして有効でも無効でもraw文字列をそのまま保持する
3. 通常の旧データ移行対象へ混ぜない
4. 現行IDBの`syncQueue/data`を上書きしない
5. 認証、共有、Realtime、送信処理へ渡さない
6. `legacyKey`、raw値、digest、取得時刻を復旧archiveへ保存し、直接読戻し検証する
7. recovery JSONへ含める場合は、legacyの未解釈データであることを明示する
8. 利用者が退避後に明示削除を選択するまで保持する

通常の旧データがなくlegacy `syncQueue`だけが存在し、archiveを容量不足等で保存できない場合は、app payloadの選択競合として扱いません。migration結果は`dataMigrationStatus=not-needed`、`cleanupStatus=deferred`、`cleanupDeferredReason=legacy-sync-queue-archive-unavailable`とし、原本を保持したまま通常起動とautosaveを継続します。通常の移行対象も同時に存在する場合のarchive失敗は、引き続き`recovery-required`です。

metricsへ記録できるのは`legacy_sync_queue_present=true/false`、archive成功可否、raw byte数のbucketまでです。raw値、digest、配列長、内部field名は送信しません。

必要な回帰試験:

- 有効JSON、非JSON、空文字、巨大値をrawのままarchiveできる
- archive失敗時に原本を削除しない
- migration、restore、cleanupがIDB `syncQueue/data`と内部control recordを変更しない
- legacy `syncQueue`だけが存在しても通常データへ推測移行しない
- recovery JSON以外のlog、error、telemetryへraw値を出さない

## 7. Release A gate

すべてPASSするまでproductionへ配布しません。

| Gate             | 合格条件                                                                   | 証跡                       |
| ---------------- | -------------------------------------------------------------------------- | -------------------------- |
| A1 exact source  | cleanなrelease worktree、対象SHAを固定                                     | `git status`、full SHA     |
| A2 cleanup OFF   | 物理削除pathが全環境で呼ばれない                                           | flag snapshot、削除spy試験 |
| A3 checkpoint    | payload、metadata、checkpointが同一transactionで確定                       | unit/integration結果       |
| A4 fallback      | cleanup途中失敗、再出現、IDB不能でも巻き戻らない                           | fault injection結果        |
| A5 map           | `{ Event: {} }`を`{}`へpruneし、save/load/migration/restoreでdigest一致    | map回帰結果                |
| A6 migration     | journal互換reader、各段階再開、実IDB root登録、archive検証                 | migration回帰結果          |
| A7 recovery      | 親なし、破損、branchを保持し、JSON退避と再試行が可能                       | UI/integration結果         |
| A8 compatibility | DB v5/v7、既存fallback、public DB API、atomic restore、import/exportを維持 | compatibility結果          |
| A9 syncQueue     | legacy raw保持、IDB queue非破壊                                            | 専用回帰結果               |
| A10 PWA          | `/sw.js` header、更新、offline、通常tab/PWA混在を確認                      | browser evidence           |
| A11 privacy      | payloadなしのmetrics、同一origin backend、cleanup削除件数を確認            | telemetry/API review       |
| A12 quality      | test、typecheck、build、format、文字コード検査がPASS                       | command log                |
| A13 operations   | production probe、24時間canary、実installed PWA、rollbackを完了            | reviewed evidence          |
| A14 evidence     | exact SHAへ結び付いた全証跡をstrict validatorが受理                        | validator output           |

標準の自動確認:

```powershell
npm run lint
npm run test:run
npm run test:release-a-evidence
npm run typecheck
npm run build:release-a
npm run format:check
npm run test:encoding
git diff --check
npm run test:release-a-rollback
```

`npm run lint`は`.eslintrc.cjs`を使用してTypeScript/Reactソースを検査します。errorが残る場合はA12をPASS扱いにしません。warningもcommand logへ記録し、release前に内容と許容理由を確認します。

Release Aは、別canary URLまたは限定cohortで24時間以上観測し、Section 9.4とSection 16の証跡validatorがPASSしてから段階拡大します。Release A中に旧localStorageの削除件数が1件でも観測された場合は即時停止します。

## 8. Release B gate

Release Aの全gateに加え、次を満たす必要があります。

1. Release A互換版を14日以上運用している
2. 直近7日間、観測できたactive clientの99%以上がRelease A互換版
3. 現在開いている全clientについて、対応version、SW version、quiesceを確認できる
4. Web Lockを取得し、取得不能・非対応時は`deferred`になる
5. archiveをIDBへ保存し、別transactionで直接読戻し・digest検証済み
6. cleanup-runtime-switchを5分以内に全配信先でOFFへ反映できる
7. cleanupの値不一致、再出現、途中終了、再起動再開試験がPASS
8. 旧版混在、休止tab、無応答tab、installed PWA、offline試験がPASS
9. rollback rehearsalがPASS
10. `d2389a0`判定が完了し、`DEPLOYED` / `UNKNOWN`なら孤立候補の退避試験がPASS

配布割合は原則`1% → 5% → 25% → 100%`とし、各段階を24時間以上観測します。対象数が少なく割合を使えない場合は、明示的に登録したtest profileだけから開始します。

次の場合は進行を止め、runtime switchをOFFにします。

- 予期しない原本削除、誤採用、巻き戻り: 1件以上
- archive未検証の削除attempt: 1件以上
- 値不一致後も削除を継続: 1件以上
- recovery-required率または保存失敗率が直前baselineの1.25倍を超える
- 起動時間p95が直前baselineから20%以上悪化
- payloadまたは高cardinality識別子がlogへ出た
- SW旧新版混在を検出したままcleanupが開始された

sampleが20件未満のrepairやcleanupは率だけで判断せず、全件を個別triageします。

## 9. privacy-safeな観測

### 9.1 記録してよい項目

- app release ID、commit SHA、SW release ID
- browser family、通常tab / installed PWA、online / offline
- startup結果と所要時間bucket
- checkpoint read/write/adopt結果
- fallback候補数bucket、reconcile結果、repair成功/失敗
- conflict reason code、migration phase、cleanup status
- cleanup延期理由
- archive保存・読戻し検証結果
- delete成功/失敗、値不一致、キー再出現
- recovery画面到達、再試行、local JSON退避の実行結果
- error classと定義済みcause code

### 9.2 記録禁止

- event名、day名、品目、価格、URL、メモ、map cell
- raw localStorage、IDB payload、recovery JSON
- revision、writer ID、storage key、full digestをmetrics labelにすること
- unsanitized error object、stackへ付加されたpayload
- userが保存した退避file名やlocal path

digestはclient内の整合確認と制限されたincident evidenceにだけ使い、中央metricsへ送信しません。production backendをprobeできないreleaseはRelease A gateを通過させず、Release Bも開始しません。

Release Aのclient内観測は`src/utils/persistenceReleaseAMetrics.ts`へ集約します。eventはversion付きの閉じたunionで、checkpoint採用、fallback repair、load conflict、save成否、startup結果と時間bucket、および閉じたcleanup outcome/reasonだけを受け付けます。任意field、payload、raw error、store/key、revision、digestはruntimeで除去します。sink、sessionStorage、backend送信が失敗しても保存・移行・復旧処理へ影響させません。

集計snapshotはsessionStorageの`__esp_internal__:release-a-metrics:v1`へ保存し、`event-shopping-planner:persistence-release-a-metric` CustomEventでも同じsanitized eventを通知します。率は次の分母で計算します。

- checkpoint採用率: `(adopted + already-absorbed) / (adopted + already-absorbed + failed + conflict)`
- repair成功率: `succeeded / (succeeded + failed + conflict)`
- conflict率: `load conflict / 全load結果`
- 保存失敗率: `save failed / 全save結果`
- recovery-required率: `startup recovery-required / 全startup結果`

`not-needed`はcheckpoint採用率の分母へ含めません。startup時間は`<250ms`、`250–999ms`、`1–2999ms`、`3–9999ms`、`10s以上`のbucketだけを保持します。exact millisecondのp50/p95を推測せず、dashboardとrelease evidenceもbucketで判定します。

実装済みcleanup eventは閉じたenumのみを受け付けます。gateのattempted/deferred/blocked/completedに加え、物理処理は`persistence-cleanup-key-confirmed-removed`、`persistence-cleanup-physical-deferred`、`persistence-cleanup-physical-blocked`を通知します。eventへlegacy key、raw値、digest、revision、client ID、例外messageを追加してはいけません。sinkの失敗はcleanupの安全判断へ影響させません。

### 9.3 最低dashboard

- startup outcomeとp50/p95 bucket
- save success/failure
- fallback detected/repaired/conflict
- checkpoint success/failure
- migration status
- cleanup deferred reason
- cleanup attempt/success/failure/mismatch/reappearance
- recovery screen reach/export/retry
- app/SW version分布

Release A backendが直接集計するのはcheckpoint、fallback repair、load、save、startup、およびcleanupです。migration、recovery UI操作、active SW identityは、固定fixture、自動browser試験、実installed PWAチェックの証跡と突き合わせます。backendに存在しないexact値をdashboardへ手入力しません。

### 9.4 production metrics backendと24時間canary

実装資材:

- client transport: `src/utils/persistenceReleaseAMetricsBackend.ts`
- same-origin API: `api/persistence-release-a-metrics.mjs`
- DB schema/dashboard: `supabase/migrations/20260803000000_persistence_release_a_metrics.sql`

配布前にmigrationを対象Supabase projectへ適用し、Vercel等のserver側だけへ次を設定します。service-role keyを`VITE_`変数、client bundle、証跡JSONへ入れてはいけません。

```text
PERSISTENCE_METRICS_ALLOWED_ORIGIN=https://<exact-canary-origin>
PERSISTENCE_METRICS_SUPABASE_URL=https://<project>.supabase.co
PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY=<server-only>
```

`PERSISTENCE_METRICS_ALLOWED_ORIGIN`は末尾slashなしのexact originです。productionではHTTPSだけを許可します。APIは同一origin、1 KiB以下、exact schemaだけを受理し、backend未設定時はfail closedします。browserの`Origin` headerは非browser clientへの認証ではないため、provider側でもこのpathへrate limit/WAFを設定します。

canaryでは次を実施します。

1. cleanなfull SHAから`build:release-a`を作成し、そのartifactだけを限定origin/cohortへ配布する
2. 通常起動と保存を行い、`/api/persistence-release-a-metrics`が`202`を返すことを確認する
3. `persistence_release_a_metrics_dashboard_24h`でbuild ID、観測開始時刻、24時間の総計を確認する
4. `persistence_release_a_metrics_dashboard_hourly_24h`から、対象SHAの完了済みUTC hourを連続24個選び、各hourのsampleが1件以上あることを確認する
5. `persistence_release_a_cleanup_dashboard_24h`で`key-confirmed-removed`が0件であることを確認する
6. `unknown-source`や別SHAを対象buildの分母へ混ぜず、baselineと同じ定義で率を算出する
7. raw event行ではなく集計viewのsnapshot/refだけをrelease evidenceへ残す

baselineは`previous-production-build-matched-cohort-complete-24h/v1`に固定します。直前のproduction buildのfull SHA、canaryと一致するcohort/query定義、canary開始前に完了した24時間、選定者とreviewerを記録し、結果を見て別windowへ差し替えてはいけません。各production rateとstartup bucketの分母が20未満なら個別triageは行いますが、gate合格には使わず、同じ定義のまま観測を延長します。

`persistence_release_a_metrics_dashboard_24h`とcleanup viewはrolling 24時間です。一方、`persistence_release_a_metrics_dashboard_hourly_24h`はpartialな現在hourを除外し、直前の完了済みUTC hourを24個返します。別queryを使う場合もpartialな先頭・末尾を含めず、時刻範囲、重複、欠落をevidence validatorで検証します。24時間未満、hour bucket欠落またはsample 0、backend probe不通、対象SHA不一致、旧原本削除1件以上のどれかがあれば不合格です。

## 10. 利用者データの手動退避と復旧

### 10.1 初動

1. 対象origin、app release、browser、通常tab/PWA、online状態を記録する
2. 他のtabとPWAで編集を止める
3. 「サイトデータ削除」「storage clear」「再インストール」を行わない
4. recovery画面が表示されている場合は、そのままにする。autosaveを再開させない
5. 通常画面を開ける場合は、全データJSON backupも別途保存する

### 10.2 recovery JSON退避

1. recovery画面のJSON退避を実行する
2. 退避完了表示とfile sizeが0でないことを確認する
3. 必要に応じて利用者端末内でSHA-256を計算し、incident記録にはhashではなく「検証済み」の事実だけを残す
4. JSONは利用者が管理し、通常のsupport ticketやchatへ添付しない
5. 退避後も原本と候補を削除しない

退避機能が利用できない場合、support担当者はDevToolsで削除や手編集を行わず、browser profile/site dataの保全が可能な担当へescalateします。

### 10.3 再試行

1. 同じRelease A互換版でonline状態と空き容量を確認する
2. recovery画面から再試行する
3. 成功後、イベント一覧、代表イベント、map、実行列、設定を読取確認する
4. 新しいJSON backupを保存する
5. recovery-requiredが再発する場合は再試行を繰り返さず、候補を保持してescalateする

### 10.4 明示復旧

候補の採用は、復旧UIが次を表示できる場合だけ実行します。

- 採用理由
- source種別とsource / target key
- revisionとdigest
- 自動採用しない理由
- 採用しても削除されない旧原本と未選択候補

選択可能なのは、`role=app-payload`かつ`adoptable=true`として生成されたIDBまたはruntime fallback候補だけです。legacy原本、metadata、checkpoint、migration journal/archive、形式不正候補はJSON退避の対象として表示しても採用できません。

採用処理は画面のsnapshotやIDだけを信頼しません。live source、raw envelope、digest、現在のroot/checkpointを再読込し、候補descriptorと一致する場合だけ進めます。payloadの内容を自動mergeせず、復旧archive、payload、metadata、checkpointを同一IDB transactionで確定します。直接読戻しとdigest/checkpoint検証が完了してから通常起動を再試行し、旧localStorage原本と未選択候補は削除しません。

## 11. cleanup実行手順

この手順はRelease B gate合格後に、監査可能なoperator UIから `db.cleanupLegacyPersistenceSources(request)` を呼ぶ統合が完成している場合だけ実施します。現在のRelease AにはそのUIとproduction proof providerがないため、この節は将来のRelease B手順であり、現時点では実行禁止です。deprecatedな`migrateFromLocalStorage({ cleanupLegacySources: true })`はcleanup操作ではありません。

API契約:

- `mode=auto`: 対応client version、client handshake/quiescence、対応SW version、active/waiting worker証明を必須とする
- `mode=manual`: 他タブとinstalled PWAを閉じたことを専用literalで確認し、Web Locksが存在する環境では実lock取得を必須とする
- 両mode: 実環境のbuild flag、runtime kill switch、archive、committed target、journal CAS、キー単位raw一致を毎回検査する
- 結果: `completed`、`cleanup-deferred`、`cleanup-blocked`を理由codeと削除確認済みの固定legacy key一覧で区別する。この一覧をmetrics labelへ転送しない
- legacy `syncQueue`: archive検証対象には含めるが、削除対象には絶対に含めない

1. runtime switchがOFFであることから開始する
2. archiveとrollback先のRelease A SHAを確認する
3. 他の通常tabとinstalled PWAを終了する
4. 1つの対応版clientを起動し、version/SW handshakeを完了する
5. lock、quiesce、client/SW version、archive直接読戻しがPASSしたことを確認する
6. runtime switchを限定cohortだけONにする
7. キーごとに「full proof再検査 → 現在raw値確認 → `removeItem()`直前再検査 → raw同期再読込 → remove → 欠損読戻し → journal確定」を行う
8. 値不一致、キー再出現、lock喪失、client応答喪失時はその場で停止する
9. `deferred`は成功した安全判断として通常起動を継続する
10. 完了後に通常保存、reload、offline復帰、PWA再起動を確認する

legacy `syncQueue`はこのcleanup対象へ含めません。

## 12. kill switchとincident対応

予期しない削除、巻き戻り、競合増加、privacy違反を検出した場合:

1. `cleanup-runtime-switch`をOFFにする
2. 全配信先でOFFが反映されたことを5分以内に確認する
3. Release A hard-off buildをproductionへ配備する
4. 旧版へrollbackせず、Release A互換版またはforward fixを使う
5. 利用者へstorageを消さないよう案内する
6. 影響release、SW version、browser/PWA、件数、reason codeだけを記録する
7. recovery画面到達者へJSON退避を案内する
8. 原因修正、fault injection、rollback rehearsalが完了するまでRelease Bを再開しない

runtime switchが機能しない場合はRelease Bの設計違反です。provider側で配信を停止し、Release A hard-off buildへ戻します。

## 13. rollback

### 13.1 cleanup前

- checkpoint、journal、archiveを読める直前のRelease A互換版へ戻す
- SWを通常のupdate経路で置き換え、site dataやcacheを利用者に全消去させない
- DBの破壊的down migrationを行わない
- rollback後に既存checkpoint、journal、fallback候補を読取確認する

standalone legacy `syncQueue`は公開migration結果では`dataMigrationStatus=not-needed`ですが、永続journal v2は既存Release A readerとのwire互換を保つため`entries=[]`、`dataMigrationStatus=verified`の従来shapeを維持します。archive内の`sourceKind=preserved-legacy-sync-queue`でapp migrationと区別します。公開状態だけを見てjournalを新形式へ書き換えてはいけません。

### 13.2 cleanup開始後

- 旧localStorage原本へ依存する版へのrollbackは禁止
- Release A形式を読めるhard-off版へ戻す
- archiveとtombstoneを保持する
- 欠損があればarchiveから自動復元せず、復旧UIで明示判断する
- rollback後のautosaveが未解決候補を上書きしないことを確認する

### 13.3 自動rollback rehearsal

cleanなworktreeで、既存previewを停止してから実行します。演習は既定で空いているloopback portを一時選択し、固定portが必要な場合だけ`scripts/rehearse-release-a-rollback.ps1 -Port <port>`を直接指定します。

```powershell
npm run test:release-a-rollback
```

このコマンドは次を同一origin・同一Chrome profileで順に実行します。

1. `build:release-a`でcleanなfull SHAとcleanup forced-offを検証する
2. syntheticな旧`eventMetadata` / `syncQueue`原本を保持したままRelease Aを起動する
3. 既知の互換baseline `e5f26b76b1318d70b5d2373c8808cda20c7bb5c3`へ配信物を切り替える
4. 実`controllerchange`、active workerソースSHA-256、baselineのindex/main assetを照合する
5. checkpoint、journal v2、archiveを読取り、rollback版UIから新規リストを通常保存してreload後も保持する
6. 同じprofileのstandalone app-window相当でもrollback後データを読めることを確認する
7. 最終Release Aへforward updateし、version付きcapabilityをactive controllerからoffline取得する
8. 全段階で旧原本hash不変と対象`localStorage.removeItem`呼出し0件を確認する

演習用profile、baseline source、junction、preview processは`finally`で検証済み一時pathから削除します。途中失敗はPASS扱いにせずnon-zeroで終了します。app-window相当は実installed PWAの代替ではないため、Windows/Android実機試験は別途必要です。

### 13.4 rehearsal記録

```text
rehearsal_id:
source_release:
rollback_release:
sw_release_before_after:
cleanup_switch_off_at:
checkpoint_read:
journal_read:
archive_read:
normal_save_after_rollback:
pwa_update_result:
performed_by:
reviewed_by:
```

## 14. archiveとtombstoneの保持

- archiveとtombstoneは最低90日保持する
- さらに「Release A互換版を2 release cycle以上運用」「30日連続で旧版clientを観測しない」の両方を満たすまで保持する
- version分布を信頼できない場合は期限を設けず保持する
- rollback可能期間中は削除しない
- legacy `syncQueue` raw archiveは利用者の明示削除まで自動GCしない
- GCはRelease B cleanupと分離した別release、別flag、別reviewで行う
- archive容量不足時は原本を削除せず`deferred`とする

archiveはbrowser profile内では暗号化されない前提です。exportしたJSONの保管場所と削除は利用者が管理します。

## 15. Chromium通常タブ/PWA試験

### 15.1 対象

- Windows 11の最新安定版Chrome
- Windows 11の最新安定版Edge
- Android Chromeのinstalled PWA
- cleanup非対応確認用にWeb Locksを利用できないtest profile

開発serverではSWが有効にならないため、PWA試験はproduction buildをHTTPSのcanary URLで配信して行います。

ローカルpreflightは次の順で実行します。

```powershell
npm run build:release-a
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
# 別のPowerShellで
npm run test:release-a-browser
```

`build:release-a`はcleanなsource SHA、Release A mode、cleanup forced-off、内容が一致するstable/version付きcapability manifest、app metaとSW precache内の同一build ID、PWA生成物、`/sw.js` header設定を検証します。browser試験は隔離Chrome profileで通常tab、second tab、同一profileのstandalone app-window相当、installability、active worker実ソース、offlineのversion付きbuild identity、offline reload、online復帰、旧原本hash不変、対象キーの削除呼出し0件を検証します。`sourceState=dirty|unknown|provider-mismatch`は、開発者が`ESP_ALLOW_DIRTY_BUILD=true`を明示した場合以外は拒否します。通常結果の`PREFLIGHT_PASS`はinstalled PWAや実SW版切替の完了を意味しないため、SW往復は13.3、Windows/Androidの実installed PWAは手動で確認します。

### 15.2 基本試験

1. fresh profileで起動、保存、reload、offline起動
2. DB v5 / v7 fixtureから起動
3. 旧localStorageを移行し、原本がRelease Aで残ることを確認
4. fallback新/IDB旧、IDB新/fallback旧、同revision異digest、親なし、複数branch
5. IDB不能、localStorage不能、quota超過、cleanup途中終了
6. `{ Event: {} }`、複数event/day、map部分欠損、restore
7. `copied` / `verified`再開直後、事前loadなしで通常保存
8. backup export/import、atomic restore、IDB `syncQueue/data`維持
9. recovery画面の再試行、JSON退避、重複操作抑止

### 15.3 複数client

1. 同じoriginを通常tab 2枚で開く
2. 片方をbackground化し、もう片方で保存する
3. 旧版client、無応答client、休止clientのfixtureをそれぞれ再現する
4. lockまたはhandshakeを証明できない場合にcleanupが`deferred`になることを確認する
5. `deferred`中も通常起動とautosaveが続くことを確認する
6. 値比較と削除の間へ別clientの書込みを注入し、削除停止と隔離を確認する

### 15.4 SW更新

1. Release Aのinstalled PWAと通常tabを開いたまま次版を配信する
2. `/sw.js`が`max-age=0, must-revalidate`または同等の再検証headerを返すことを確認する
3. 旧clientが残る間はcleanupが開始されないことを確認する
4. 全clientを終了し、PWAを再起動してapp/SW version一致を確認する
5. offlineで旧cacheから起動しても原本を削除しないことを確認する
6. online復帰後、重複migrationや巻き戻りがないことを確認する

`release-capabilities.json`の`buildId`、indexの`event-shopping-planner-build-id` meta、active `sw.js`がprecacheするversion付きcapability filenameはすべて同じfull commit SHAでなければなりません。`sourceState`が`dirty`または`unknown`のartifactはRelease A証跡として使用しません。

### 15.5 証跡

各caseについて、release SHA、SW ID、browser version、profile種別、online状態、期待結果、実結果、実施者、時刻を記録します。screenshotや動画へ利用者payloadを映しません。

app-window相当の自動試験を`installedPwaChecks`へ転記してはいけません。Windows 11 Chrome、Windows 11 Edge、Android Chromeの各caseは実際にinstallしたPWAでonline、offline、更新、旧原本不変を確認し、実施者とは別のreviewerが確認します。

## 16. 文字コードとrelease evidence

対象source、README、docsは原則UTF-8 BOMなし、既存改行を維持します。release前に次を確認します。

- strict UTF-8として読める
- U+FFFDがない
- 不自然な`?`増加がない
- BOMが意図せず変化していない
- 改行だけの大量差分がない
- 代表文字列「ユーザー登録」「エラーが発生しました」が壊れていない

最終release evidenceには次を含めます。

- exact commit SHAと配布環境
- Release A / B gate checklist
- `d2389a0`判定
- test、typecheck、build、format、encoding結果
- Chromium/PWA結果
- flagとkill switchのsnapshot
- dashboard期間と判定
- rollback rehearsal

固定のpending templateを作業用証跡へcopyし、収集済みの参照だけを記入します。

```powershell
Copy-Item -LiteralPath docs\release-a-evidence.template.json -Destination <release-evidence-path>
npm run verify:release-a-evidence -- <release-evidence-path>
```

templateは未実施を誤って合格させないため、そのままでは必ず不合格になります。validatorは少なくとも次を検証します。

- canary/dashboardと全gateが同じclean full SHAに結び付いている
- 24時間以上かつ連続hour bucketが揃い、固定された悪化上限を超えない
- 旧localStorageの物理削除が0件
- Windows 11 Chrome/EdgeとAndroid Chromeのactual installed PWA証跡
- 未来時刻、未知field、重複JSON key、payload/raw/storage/revision/digest fieldがない
- `d2389a0`の事実判定が`UNKNOWN`なら`TREAT_AS_DEPLOYED`で、専用E2EがPASS
- release owner、data safety reviewer、operations reviewerの承認が全gate完了後である

`d2389a0`専用E2Eは次でも単独確認できます。

```powershell
npm run test:run -- src/utils/indexedDB.recoveryAdoption.integration.test.ts -t "d2389a0 orphan recovery E2E fixture"
```

実測していない24時間canary、installed PWA、provider監査、承認を`PASS`として記入してはいけません。validatorのPASSはproduction配布を自動実行するものではなく、Release ownerのgo判断に必要な入力です。

payload、recovery JSON、raw storageはrelease evidenceへ含めません。
