# 共有・連携機能 検証計画

> 状態: Test plan／機能未着手
>
> 旧版向け文書にあった試験件数、PASS、端末実績、migration数、commit、remote反映は継承しない。
> 本書の初期状態はすべて`NOT RUN`または`NOT AVAILABLE`である。

## 1. 判定語

| 状態            | 意味                                                   |
| --------------- | ------------------------------------------------------ |
| `PASS`          | 対象commitと環境を特定でき、期待結果を満たす証跡がある |
| `FAIL`          | 実行したが期待結果を満たさない                         |
| `NOT RUN`       | 実行可能だが、このrelease候補では未実行                |
| `NOT AVAILABLE` | 実装またはtest基盤がまだ存在しない                     |
| `N/A`           | 対象外で、理由が記録されている                         |

共有機能のrelease判定では、古いcommit、別環境、旧版repoの`PASS`を流用しない。

## 2. 現行baseline

2026-07-31のsource監査結果:

- 共有UI、Auth、RPC、Realtime、同期runtimeは未実装。
- `supabase/`、migration、DB試験は存在しない。
- IndexedDBはversion 5で、共有用の型付きstoreはない。
- sharing用E2E、複数client、offline、RLS試験はない。

実装とrelease試験はGit管理下のclean working treeで行う。

## 3. 現行command

| Gate              | command                | 初期状態  |
| ----------------- | ---------------------- | --------- |
| type              | `npm run typecheck`    | `NOT RUN` |
| lint              | `npm run lint`         | `NOT RUN` |
| unit／integration | `npm run test:run`     | `NOT RUN` |
| format            | `npm run format:check` | `NOT RUN` |
| production build  | `npm run build`        | `NOT RUN` |

現在存在しないもの:

- Supabase local migration commandとDB test command
- pgTAP等のRLS／RPC test
- Playwright／Cypress等の複数browser E2E
- axe等のaccessibility自動補助検査

導入前はこれらを自動`PASS`と記録しない。追加時は`package.json`、tool設定、本書を同じ変更で更新する。

## 4. release gate

| Gate | 内容                                           | 初期状態        |
| ---- | ---------------------------------------------- | --------------- |
| G0   | 要件、未決事項、脅威、上限、対応browserの確定  | `NOT RUN`       |
| G1   | local ID、IndexedDB migration、feature OFF回帰 | `NOT AVAILABLE` |
| G2   | schema、RPC、RLS、冪等性、競合のDB contract    | `NOT AVAILABLE` |
| G3   | room作成、参加、snapshot、online同期           | `NOT AVAILABLE` |
| G4   | offline、複数tab、lifecycle、fallback          | `NOT AVAILABLE` |
| G5   | browser、PWA、accessibility、security          | `NOT AVAILABLE` |
| G6   | staging、kill switch、rollback、限定pilot      | `NOT AVAILABLE` |

G0から順に満たす。後続gateの一部が動いても、前段のdata lossやsecurity gateを省略しない。

## 5. 要件trace

| 要件領域       | 主な要件ID                 | 自動試験                            | 手動試験                       |
| -------------- | -------------------------- | ----------------------------------- | ------------------------------ |
| feature gate   | `SHR-FLG-*`、`SHR-LOC-001` | unit、existing regression、build    | gate OFF smoke                 |
| stable ID      | `SHR-ID-*`                 | unit、IDB migration、export／import | rename／duplicate確認          |
| room作成       | `SHR-ROOM-*`               | RPC、RLS、payload、integration      | 作成dialog                     |
| 招待／参加     | `SHR-JOIN-*`               | token／code、rate、expiry、E2E      | URL／QR／code                  |
| 共有data       | `SHR-DATA-*`               | projection、validation、permission  | 共有前preview                  |
| 同期／競合     | `SHR-SYNC-*`               | multi-client、idempotency、race     | conflict dialog                |
| offline        | `SHR-OFF-*`                | IDB、reload、timeout、multi-tab     | sleep／PWA復帰                 |
| lifecycle      | `SHR-LIFE-*`               | state、permission、expiry           | leave／close／fallback         |
| UX／a11y       | `SHR-UX-*`                 | component、axe導入後                | keyboard、reader、zoom         |
| security       | `SHR-SEC-*`                | RLS negative、bundle scan、CSP      | devtools／network確認          |
| non-functional | `SHR-NFR-*`                | performance、migration、monitoring  | mobile回線、incident rehearsal |

この表は計画段階のroutingであり、prefix単位の`PASS`を許可しない。M0で全要件IDを1行ずつ、
自動／手動test case ID、owner、状態へ対応させるtrace matrixを追加する。release候補では要件IDごとに
少なくとも1つの期待結果と実行結果へ辿れるようにする。

## 6. unit test

### 6.1 identityとprojection

- 既存eventへ`localEventId`を一度だけ付与する。
- reload後もIDが変わらない。
- renameでIDを維持する。
- duplicateで新IDを発行する。
- version付きXLSXの同一event restore、別copy、legacy importの規則が異なる。
- 新規item IDがUUIDになる。
- 既存の非UUID item IDを破壊しない。
- 共有allowlist以外のfieldをpayloadへ含めない。
- `orderIndex`、`postponed`、`executeModeItems`の順序をMVP payloadへ含めない。
- unknown field、enum、数量、文字列上限を拒否する。

### 6.2 domain state

- room、member、session、outboxの許可遷移と拒否遷移。
- `ready`と個別operationの同期完了を混同しない。
- blocked／conflict／outcome unknownのretry判断。
- purchase statusと限数購入数のvalidation。
- stable error codeから利用者向けactionへのmapping。

### 6.3 feature gate

- flag未設定、false、URL欠落、anon key欠落。
- gate OFF時にSupabase Auth、channel、RPCが0回。
- gate OFFでも既存local保存が動く。
- server gate取得失敗時にfail closedする。
- SDK管理以外のAuth token copyを作らず、logout後にsessionを復元しない。

## 7. IndexedDB migration

version 5のfixtureを使う。

- 通常10 storeの全dataを保持する。
- 大容量のmap dataを破損しない。
- `syncQueue`を推測変換または自動送信しない。
- 新しい共有storeを作成する。
- upgrade途中のabort後に再試行できる。
- `blocked`と`versionchange`を利用者へ安全に案内する。
- quota不足ではlocal storeを初期化せず共有を無効化する。
- 共有storeをlocalStorageへfallbackしない。
- reload後にreplicaとoutboxを復元する。
- unknown schema versionを送信せず隔離する。

## 8. backend contractとsecurity

local Supabase基盤を追加後、少なくとも次を自動化する。

### 8.1 Auth／RLS

- 未認証read／writeを拒否。
- 別room read／writeを拒否。
- left／blocked memberを拒否。
- closed／expired roomのserver read、通常write、Realtimeを拒否。
- client申告actor／role改ざんを無視。
- public tableの直接mutationを拒否。
- private invite／receipt／runtime controlのSELECTを拒否。
- public member rowから生Auth user IDを取得できない。
- Realtimeで別room rowを取得できない。

### 8.2 invite

- token hash／code HMACだけを保存。
- expiry、revocation、rotation。
- code試行上限とrate limit。
- operator発行creator codeの期限、一回限り消費、失効、並行使用。
- 同じcredentialの並行joinでmember上限を超えない。
- previewが秘密や不要なmember情報を返さない。

### 8.3 idempotency

- 同じoperation ID、kind、payloadの逐次／並行再送。
- 同じIDを異なるpayloadへ再利用。
- transaction commit直後の応答喪失。
- 初回成功後にgate OFF、rate到達、room closing、member退出となっても同じreceipt結果を回収。
- manual／creator codeのplain hashがreceiptへ残らない。
- create応答喪失後に非秘密operation IDからroomを確認し、新credentialへrotate。
- invite rotation応答喪失後に再rotateして不明なcredentialを失効。
- receipt存在時の資格失効。
- receiptと業務rowの片方だけが残らない。

### 8.4 concurrency

- 同じitemへの同時purchase state変更。
- host内容変更とmember purchase変更の競合。
- room closeとitem mutationの競合。
- room control変更で全体revisionが増え、member／item rowの`change_revision`が同じtransactionの
  room revisionと一致する。
- invite rotationとjoinの競合。
- member leaveとoutbox replayの競合。
- host remove後に対象memberのread、write、Realtimeが同時に失効する。
- lock順の競合試験でdeadlockがない。

### 8.5 migration

- 空DBへのreset。
- 直前schemaからのforward upgrade。
- 生成型に未反映のtable／RPC差分を検出。
- RLS enabled漏れ、grant過多、default executeを検出。
- server gate OFFを初期値にする。

## 9. client integration

2つ以上の独立browser contextで試験する。

- hostがroomを作成し、memberがURLで参加する。
- QRの内容とcopy URLが一致する。
- manual codeで参加する。
- 同名eventを自動mergeしない。
- 初期snapshotの件数とfield mappingが一致する。
- hostの商品編集がmemberへ反映される。
- memberのpurchase stateがhostへ反映される。
- edit、execute、focus、map popup、bulkの全purchase mutationが共通commandを通る。
- 一般memberは退出できるが、active hostの直接退出は`host_must_close_room`で拒否され終了導線へ移る。
- Realtime eventの欠落、重複、順序逆転後に収束する。
- stale versionでconflict dialogを表示する。
- optimistic update拒否後にcanonical stateへ戻る。
- reload後にroom linkとserver replicaを復元する。
- 招待秘密を永続化していない。

## 10. offlineと回復matrix

各caseで、local表示、outbox状態、server副作用、復旧後の収束、利用者表示を確認する。

| case                         | 必須確認                       |
| ---------------------------- | ------------------------------ |
| 操作前offline                | allowlist以外をqueueしない     |
| RPC送信前切断                | operationをqueuedで保持        |
| RPC処理中切断                | outcome unknownと冪等再送      |
| RPC成功、Realtime断          | RPC結果とrevisionで確定        |
| Realtimeだけ切断             | polling／再取得で収束          |
| tab reload                   | operation IDとpayloadを維持    |
| device sleep／PWA background | 復帰後に重複送信しない         |
| Auth token expiry            | refresh後に同じoperationを再送 |
| room close中                 | 通常outboxを送信しない         |
| member退出後                 | outboxをblockedにする          |
| protocol mismatch            | update／local利用を案内        |
| server write gate OFF        | 自動retryを停止                |
| storage quota                | local dataを削除しない         |

## 11. 複数tab

- 2 tabが同じroomとoutboxを開く。
- application writerが1つだけである。
- owner tab終了後に別tabが安全に引き継ぐ。
- stale lockを回収する。
- 同じentryの並行送信がない。
- 非owner tabはread-onlyで、別event編集によるstaleな`eventLists`全体保存も行わない。
- 安全なexclusive lockを利用できない場合は共有sessionを開始しない。

## 12. browser／PWA

仮の正式matrix:

- desktop Chrome current
- desktop Edge current
- Android Chrome current
- Android installed PWA

各対象で確認:

- create／join／URL fragment／QR／manual code
- normal tabとinstalled PWA
- touchとkeyboard
- 縦画面／横画面
- narrow viewport
- background／resume
- offline／online
- Service Worker更新
- Supabase HTTP／WebSocketがcacheされない
- deep linkを開いた後にfragmentが不要な場所へ残らない
- fragment読取直後の`history.replaceState`とback／forward履歴
- cache clear後もserver資格とlocal dataの説明が正しい

Firefox、Safari、iPhone、iPadは実測なしに正式対応と記載しない。

## 13. accessibility

WCAG 2.2 AAを目標に、少なくとも次を手動確認する。

- 共有入口からcreate／join／leave／closeまでkeyboardだけで操作できる。
- dialogの初期focus、trap、Esc、close後のfocus復帰。
- accessible name、heading、dialog title、form error関連付け。
- syncing、offline、conflict、成功、失敗を適切なlive regionで通知する。
- 状態を色だけで表現しない。
- QRと同値のURL／codeをtextで利用できる。
- 200% zoomとreflow。
- contrast、touch target、reduced motion。
- timeoutや自動更新で操作中のfocusを奪わない。
- screen readerでmember、未送信件数、error actionを理解できる。

自動toolを追加してもkeyboardとscreen readerの実確認を省略しない。

## 14. privacy／secret検査

- production bundleにservice role keyやserver secretがない。
- source mapとenvironment injectionを確認する。
- console、network error、analyticsへtoken、code、QR payloadが出ない。
- URL query、Referer、browser historyに招待秘密が出ない。
- IndexedDB、localStorage、Cache Storageに招待秘密がない。
- Auth sessionはSupabase SDK管理keyだけに存在し、application独自copyがなく、logoutで削除される。
- XLSXと診断exportに秘密、Auth ID、商品payloadが不必要に含まれない。
- CSPが必要なSupabase originだけを許可する。
- WorkboxがSupabase responseをNetworkOnlyで扱う。

## 15. performanceと上限

仮上限をそのままrelease値にせず、次を実測する。

- 300商品の初期upload時間、payload size、失敗時再開。
- 300商品のsnapshot時間、memory、IDB書込時間。
- low-end Androidと低速回線での初回join。
- 同時4 memberの通常mutationとRealtime。
- outbox滞留時のUI responsiveness。
- room終了、cleanup、retentionのDB負荷。
- SupabaseのAuth、DB、Realtime、egress利用量。

結果に基づき最大member、商品、期限、rate、chunk size、snapshot page sizeを固定する。

## 16. rollback／incident rehearsal

- server通常write gate OFF。
- join／create gate OFF。
- client gate OFF版deploy。
- 直前の互換clientへrollback。
- forward fix migration。
- Realtime断からpolling収束。
- invite漏えいとrotation。
- RLS逸脱時の封じ込め。
- outboxを残したまま共有を停止。
- explicit fallbackとXLSX退避。
- retention cleanupの停止／再開。

## 17. release不可条件

次が1件でもあればreleaseしない。

- local data lossまたは誤merge
- cross-room access
- 未認証／失効memberのaccess
- 重複副作用またはoutbox消失
- purchase状態のserver不整合
- secret漏えい
- rollbackまたはkill switch未検証
- 対象browserの再現性あるcrash
- keyboard／screen readerの主要導線blocker
- migration／RLS／RPC試験が`NOT AVAILABLE`
- 仮上限の実測がない

## 18. 証跡の扱い

release証跡には次を含める。

- Gate ID
- date／time
- commit SHA
- build ID
- environmentとschema version
- feature gate状態
- browser／device／OS
- commandまたは再現手順
- expected／actual
- `PASS | FAIL | NOT RUN`
- artifact link
- reviewer

商品内容、nickname、token、code、session、secretを証跡へ貼らない。canonical文書へ日々の長大な
進捗を追記せず、issue、CI artifact、release recordへ分離する。
