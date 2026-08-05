# Web アプリ基盤 実装計画

- 対象リポジトリ: `event-shopping-planner-routeplanning`
- 実装照合日: 2026-08-05
- 実装照合基準: `2c8cc6602e0a4b8bb301524fd7306d7bc87840ca`
- 対象: Web 配信基盤、PWA 更新、CSS/CSP、XLSX 実行、買い物リスト描画、`App.tsx`、IndexedDB、品質ゲート

## 1. 目的

この計画は、現在の機能、保存データ、復旧手順を維持したまま、Web アプリ基盤を段階的に安全化・高速化・分割するための実装順と合格条件を定める。

達成する状態は次のとおり。

1. 配布したソース、静的ファイル、Service Worker、Serverless Function、provider 設定を一つの immutable release package として識別・再配布できる。
2. PWA 更新は、未保存データ、復旧中データ、別タブ、互換性不明の Worker がある状態で自動適用されない。
3. Tailwind CDN と実行時生成 CSS を廃止し、固定したローカル CSS と実効性のある CSP を配信する。
4. ExcelJS を page client の初期 module/request/evaluation graph から外し、XLSX の CPU 処理を単一 Worker port に集約する。
5. 大規模な買い物リストでも操作性とアクセシビリティを保ち、必要時には恒久 full renderer へ戻せる。
6. `App.tsx` と IndexedDB 実装を責務単位に分離し、既存の保存・復旧・移行契約を維持する。
7. lint、unit、integration、E2E、a11y、CSP、PWA、性能、artifact、provider の各検査を再現可能な required gate にする。

## 2. 対象外

次は本計画では実施しない。

- persistence Release B の有効化、legacy source の本番削除、Release A の安全条件緩和
- React 19 への更新、router 導入、認証 UI、製品機能やデータモデルの変更
- `src/lib/supabase.ts` のクライアント利用開始
- 利用者行動を収集する新規本番テレメトリ
- WebKit を Tier 1 の blocking browser にすること
- virtual list の full renderer 自体を削除すること
- IndexedDB の schema version、database 名、store 名、key、意味、復旧対象の変更

対象外の作業が必要になった場合は、本計画の受入条件へ混在させず、独立した ADR と計画で扱う。

## 3. 照合済みの実装現状

### 3.1 アプリケーションと配信

- React Router は使っておらず、`src/index.tsx` から一つの React root を起動する SPA である。
- 非 `api/` path は `vercel.json` により `/index.html` へ rewrite される。
- active な認証/session UI はない。
- active な外部処理は同一 origin の `POST /api/persistence-release-a-metrics` である。
- `api/persistence-release-a-metrics.mjs` は Supabase へ送信し、migration は `supabase/migrations/20260803000000_persistence_release_a_metrics.sql` である。
- metrics API は POST-only、request body 上限 1 KiB、exact schema、成功時 202 の契約を持つ。
- `src/lib/supabase.ts` と生成済み database types は entry graph から未参照で、現在の client bundle には Supabase SDK が含まれない。
- `src/index.tsx` に root Error Boundary はない。

### 3.2 PWA

- `vite.config.ts` は `vite-plugin-pwa` の `generateSW` を使用する。
- `registerType: "autoUpdate"`、`skipWaiting: true`、`clientsClaim: true` であり、利用者の許可なしに更新世代が切り替わり得る。
- runtime caching は Tailwind CDN の `CacheFirst` と `https://*.supabase.co` の `NetworkOnly` を持つ。
- `release-capabilities.json` と `release-capabilities.<buildId>.json` の `buildId` は source SHA である。
- `build:release-a` は cleanup capability を強制的に OFF にする。
- 現在の `build` は常に `vite build --mode release-a` を実行する。
- 現行 browser verifier は固定した Playwright browser ではなく、環境内の Chrome/Edge を探索する。
- 現行 rollback rehearsal は旧 commit を現在の `node_modules` で再 build するため、immutable rollback ではない。

### 3.3 HTML、CSS、CSP

- `index.html` は version 未固定の Tailwind CDN script、inline Tailwind 設定、inline style、theme 初期化 script、loading/viewport script を含む。
- `vercel.json` に CSP はない。
- JSX の `style={...}` は 105 箇所ある。
- `X-XSS-Protection: 1; mode=block` を含む一部 security header はあるが、header 全体の正本と provider 照合はない。

### 3.4 XLSX

- ExcelJS は `src/utils/xlsxMapParser.ts` と `src/utils/exportImport.ts` から静的 import される。
- map import、event import、event export の三経路が別々の call site を持つ。
- 純粋な数値解析 helper や download helper が ExcelJS を持つ module と同居し、初期 graph からの分離を妨げている。
- `ExportData` は `src/types/export.ts` と `src/utils/exportImport.ts` に異なる shape があり、実使用の source of truth が一つではない。
- XLSX file size、ZIP 展開量、sheet/cell/text 数に明示上限がない。

### 3.5 買い物リストと navigation

- `ShoppingList.tsx` は window scroll、`elementFromPoint`、`getBoundingClientRect`、`querySelectorAll`、touch/native DnD に依存する。
- mode/search 遷移、編集保存後の移動、execution-space navigation が DOM 要素の存在を前提とする。
- virtual list を単純導入すると、非 mount row への scroll/focus、drag、履歴、アクセシビリティが破綻する。

### 3.6 `App.tsx` と IndexedDB

- `App.tsx` は 5,844 行、`src/utils/indexedDB.ts` は 9,176 行である。
- `ShoppingList.tsx` は 4,414 行、`useIndexedDbPersistence.ts` は 1,050 行である。
- `AppMainContent` は `ImportScreen` と `FocusModeContainer` を lazy import している。
- 一部 integration test は source string や handler の存在を検査している。
- `ActiveTab` 型が複数箇所にあり、shell へ raw setter が多く渡される。
- IndexedDB の `syncQueue` store は未接続 queue payload だけでなく、全 payload の metadata/checkpoint、migration journal/archive/control record を持つ。
- database 名は `EventShoppingPlannerDB`、現行 version は 5、forward-compatible 上限は 7 である。
- app data restore は 10 個の app store を対象とし、`syncQueue` 本体は復元対象外である。
- persistence status は `saved | unsaved | saving | failed` で、`beforeunload` guard と recovery state を持つが、root 向け reload safety port はない。
- `persistenceCleanupCoordinator.ts` は安全判断と lock 調停の抽象契約を持つ。既存 executor は exact legacy `localStorage` key を削除できるが、通常起動経路から呼ばれない。IndexedDB database や `syncQueue` は削除対象ではない。
- production proof provider、kill switch、operator UI がないため Release B は禁止状態である。

### 3.7 再現済み品質基準

| 項目                   |                                                                                       現状 |
| ---------------------- | -----------------------------------------------------------------------------------------: |
| Node                   |                                                                                  `20.20.0` |
| npm                    |                                                                                   `10.8.2` |
| Vite                   |                                                                                   `5.4.21` |
| Vitest                 |                                                                                    `2.1.9` |
| vite-plugin-pwa        |                                                                                   `0.20.5` |
| React                  |                                                                                   `18.3.1` |
| TypeScript             |                                                                                    `5.9.3` |
| ESLint                 |                                                                                   `8.57.1` |
| typecheck              |                                                                                       成功 |
| unit/integration       |                                                               120 files / 1,198 tests 成功 |
| lint                   |                                                                      error 0 / warning 130 |
| lint warning 内訳      | exhaustive-deps 83、unused-vars 38、no-useless-escape 6、prefer-const 2、no-explicit-any 1 |
| inline ESLint disable  |                                                                                          4 |
| `@ts-expect-error`     |                                                                                          1 |
| encoding 検査          |                                                                                       成功 |
| release-a build        |                                                                                       成功 |
| main chunk             |                                                                                  911.96 kB |
| xlsx-parser chunk      |                                                                                  972.45 kB |
| precache               |                                                                  19 entries / 3,085.67 KiB |
| `npm audit` 全体       |                                                  critical 1 / high 19 / moderate 8 / low 1 |
| `npm audit --omit=dev` |                                                                        high 4 / moderate 2 |

上表は回帰判定の identity baseline であり、将来の合格値ではない。

## 4. 用語

### 4.1 Identity

- `sourceSha`: build 対象 commit の完全 SHA。既存 Release A の `buildId` はこれを維持する。
- `buildInputId`: canonical build input descriptor の SHA-256。HTML、app bootstrap、Service Worker の世代照合へ埋め込める build 前 identity。
- `artifactContentHash`: public identity manifest を含む `dist` payload の相対 path、size、file SHA-256 を canonical 順序で並べた tree hash。detached manifest と signature は対象外。
- `artifactArchiveHash`: canonical static artifact archive bytes の SHA-256。
- `releasePackageId`: self field を除いた release package descriptor の SHA-256。
- `outerPackageHash`: release package archive 自体の SHA-256。archive 外の detached index/evidence にだけ保存する。
- `deploymentId`: provider が返す immutable deployment identity。

`buildInputId` は content hash ではない。同じ入力から異なる bytes が生成された場合は `artifactContentHash` が異なるため、再現性検査を失敗させる。

### 4.2 Release A と Web 基盤 package

- persistence Release A は cleanup capability を hard OFF にした既存の安全リリースである。
- `release-a-evidence/v1` schema、`buildId=sourceSha`、24 時間 canary、installed PWA、reviewer 承認の意味は変更しない。
- Web 基盤の正本 build command は `build:artifact` とする。
- `build:release-a` は Release A hard-OFF variant を生成する互換 wrapper として維持する。
- 本計画で生成する全 production candidate は Release A hard-OFF であり、Release B を有効化する flag を受理しない。

### 4.3 Rollback package

用語を次の三つに限定する。

- `previous-production package`: 現在 production で配信中の完全 package。
- `phase-floor package`: 後続 phase が依存できる、受入済みの最小互換世代。
- `paired-fallback package`: Worker/full renderer など、同じ source とデータ契約で機能 flag だけを OFF にした受入済み package。

rollback は source を checkout して再 build する操作ではなく、保存済み package を byte-for-byte 再 deploy する操作である。

### 4.4 PWA の安全用語

- `pageBuildInputId`: 現在読み込んだ HTML/app bootstrap の `buildInputId`。
- `activeWorkerBuildInputId`: controller が返す `buildInputId`。
- `waitingWorkerBuildInputId`: waiting Worker が返す `buildInputId`。
- `protocolVersion`: page と Worker の message protocol version。
- `point of no return`: validation 成功後、同じ synchronous handler が nonce を消費して `activation-committed` にし、`skipWaiting()` を呼ぶ直前。ここから先は activation request を取り消せると仮定しない。
- `blocker`: reload/update を行うと利用者の未確定状態を失う可能性がある状態。
- `fail-closed`: 安全性を証明できない限り更新、cleanup、reload を実行しない状態。

PONR 後の下位状態は `COMMITTED_NO_ACTIVATION | ACTIVATING | ACTIVATED | ACTIVATION_FAILED` とし、いずれも mutable App への復帰や legacy-auto rollback を許可しない。

### 4.5 Browser tier

- Tier 1: lock 済み Playwright Chromium。全 required E2E、PWA、CSP、a11y、性能 gate を blocking とする。
- Tier 2: 現行 Safari/iOS Safari と Android Chrome の手動/実機 smoke。データ損失、reload loop、操作不能、重大な a11y 退行は release blocker とする。
- Web Locks 不足時は定義済みの close-all-clients 手順へ移る。rollout 中の Worker module 不足時は paired-fallback を使い、M2 後に browser tier 外と判定した場合は XLSX 操作を明示的に利用不可にする。機能を黙って main thread 実行へ戻さない。

## 5. 全体不変条件

1. IndexedDB の schema、store、key、保存値、migration、recovery の意味を変えない。
2. Release A の cleanup hard-OFF と evidence schema v1 を変えない。
3. PWA 更新は blocker が一つでもある場合に適用しない。
4. recovery-required、restore 実行中、restore 結果未確認を「安全な復旧画面」とみなさない。
5. page、active Worker、waiting Worker の identity/protocol が不明な状態で app を自動 reload しない。
6. source merge と production promotion を別操作にする。
7. phase の途中 artifact を production へ配布しない。
8. provider が検証済み package を再 build しない。再 build が避けられない場合は全 static/function hash の一致を必須とする。
9. public build input に secret 値を含めない。env は key 名、version reference、presence のみを記録する。
10. 既存 lint disable の増加、適用範囲拡大、新規 `@ts-ignore` を禁止する。
11. full renderer は恒久 fallback として維持する。
12. PWA、Tailwind、XLSX、virtual list の rollout flag は build-time flag とし、利用者データへ保存しない。
13. 破壊的 cleanup は exact allowlist の resource だけを対象とする。

## 6. Artifact、provider、evidence の設計

### 6.1 Canonical build input descriptor

`scripts/build/createBuildInputDescriptor.mjs` を正本とし、少なくとも次を canonical JSON へ含める。

- schema version
- `sourceSha`
- `package-lock.json` SHA-256
- Node、npm、Vite、plugin、TypeScript の exact version
- canonical build OS、architecture、container image digest
- provider CLI の exact version と required managed function runtime family
- build mode と全 rollout flag
- reachable な public `import.meta.env` の key/value。ただし descriptor から生成する `buildInputId` 自身は除外する
- `vite.config.ts`、`vitest.config.ts`、`vercel.json`、CSP/header catalog の hash
- static asset generator の version と入力 hash
- required migration file path/hash と適用前提

未参照の `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY` は、entry graph へ接続されるまで byte-affecting input に含めない。

descriptor を canonical UTF-8、BOM なし、LF、key sort で serialize し、その SHA-256 を `buildInputId` とする。descriptor 確定後に Vite `define` 相当で ID を注入し、`import.meta.env` を介して descriptor 自身へ戻さない。

canonical build は clean detached checkout だけを受理し、tracked/untracked/ignored build input の不足を拒否する。`TZ=UTC`、locale、`SOURCE_DATE_EPOCH` を source commit time に固定し、生成物への wall-clock timestamp、random ID、absolute path を禁止する。

### 6.2 App と Worker の identity

同じ `buildInputId` を次へ生成時注入する。

- `index.html` の immutable meta
- app bootstrap の compile-time constant
- custom Service Worker の response payload
- `dist/build-identity.json` と `dist/build-identity.<buildInputId>.json`

startup は前三者、provider gate は四者すべてが一致することを検査する。public identity manifest は `schemaVersion`、`sourceSha`、`buildInputId`、`protocolVersion` だけを持ち、content/archive/package hash を持たない。既存 `sourceSha` は別 field として残し、`buildInputId` へ名称変更しない。

### 6.3 Artifact manifest

build 後に `dist` 外へ detached `artifact-manifest.json` を一つ生成する。

- public identity/capability manifest を含む全 `dist` payload file の path、media type、size、SHA-256
- payload tree から算出した `artifactContentHash`
- precache entry と size
- entry chunk、lazy chunk、Worker chunk の logical graph
- expected response header/cache policy
- canonical static archive の path、size、`artifactArchiveHash`

static archive は `dist` payload だけを含み、detached artifact manifest、signature、evidence は含めない。archive の path separator、entry 順、mode、uid/gid、mtime、compression algorithm/level を固定する。

既存 `release-capabilities.json` と `release-capabilities.<sourceSha>.json` は、Release A consumer と保存済み package のサポート期間中は維持する。既存 consumer を先に dual-read 対応し、Release A verifier/runbook が generic manifest 非依存で動くことを保つ。既存 verifier 内で source SHA を指す変数は `sourceBuildId` へ改名し、generic `buildInputId` と混同しない。

### 6.4 完全 release package

release package は次を含む。

1. canonical static artifact archive
2. Vercel Build Output API 互換の static/function bundle、または同等の immutable provider bundle
3. `api/persistence-release-a-metrics.mjs` と dependency/runtime hash
4. `vercel.json` と期待する provider build/install/output 設定
5. required managed function runtime family、provider CLI、project 設定 version
6. required env key 名と validation rule
7. 期待する WAF、rate-limit、CORS、origin policy
8. required migration path/hash
9. build input descriptor
10. detached artifact manifest
11. compatibility capabilities manifest

required env key は `PERSISTENCE_METRICS_ALLOWED_ORIGIN`、`PERSISTENCE_METRICS_SUPABASE_URL` または `SUPABASE_URL`、`PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY` または `SUPABASE_SERVICE_ROLE_KEY` である。さらに、package 確定後に non-secret `WEB_FOUNDATION_RELEASE_PACKAGE_ID` と provider 由来 deployment ID binding を設定する。secret 値、service role key、利用者データ、実環境の presence/status は package と log に含めない。

package descriptor は全 payload member の path、size、SHA-256 を列挙し、descriptor 自身を member hash 一覧から除外する。その canonical descriptor から `releasePackageId` を算出して descriptor へ格納する。`outerPackageHash` は descriptor を含む package archive 全体から算出し、archive 内へ書き戻さず detached release index にだけ保存する。

実環境の env presence/version reference、migration status、provider/WAF resolved state、deployment ID、generic evidence、Release A evidence 参照は package ID 確定後の detached evidence hash-chain に置く。

package archive も path separator、entry 順、mode、uid/gid、mtime、compression algorithm/level を固定する。観測時刻、承認時刻、upload URI は detached evidence にだけ持たせる。

### 6.5 Canonical build 環境

- canonical artifact は x64 Linux の digest 固定 container、Node `24.18.0`、npm `11.16.0` で一度だけ build する。
- Windows job は PowerShell、encoding、browser、path 固有の検査を担当し、production artifact を再 build しない。
- provider の Node 24 build/function 対応を Phase 0 の hard gate とする。managed function は `nodejs24.x` family を要求し、provider が管理する patch version を package identity へ固定しない。
- `verify:runtime` は local/canonical build の Node/npm を exact 検証し、provider は runtime family を検証する。deploy 時の resolved `process.version` と runtime ID は detached evidence に保存し、release policy の許容 Node 24 patch かを判定する。
- `packageManager` と `engines` だけを version enforcement とみなさない。

### 6.6 Provider 同一性

保存済み package を prebuilt deploy し、provider が app bundle を再構築しない経路を正本とする。

deployment 後に `deploymentId` と package を結び、次を外部 URL から取得して manifest と照合する。

- artifact manifest にある全 public static file の bytes/hash
- 全 public route/resource の security/cache header
- Service Worker 経由と network bypass の response
- provider deployment API の function bundle/runtime/config provenance
- metrics response の `X-Release-Package-Id` と `X-Deployment-Id`

この二 response header は package build 後に設定する non-secret deployment metadata から返し、function bundle へ自己参照 ID を埋め込まない。response body、POST-only、1 KiB、exact schema、202 の Release A contract は変更しない。

QA は専用 backend/migration へ exact schema の synthetic POST を送り、CORS、202、DB 到達を検証する。production では test row を実データ表へ書かず、provider/Supabase 管理 API から env presence/version reference と migration hash/status を read-only 取得し、body なし GET/invalid schema など副作用のない route contract を検査する。production の実 DB ingestion は既存 Release A の 24 時間 evidence で証明する。

一つでも static bytes/hash/header、function provenance、package/deployment identity、prerequisite が異なる場合は release を失敗させる。

### 6.7 Cache-Control 正本

`config/response-policy.json` を header/cache policy の正本とする。

| Resource                            | Cache-Control                         |
| ----------------------------------- | ------------------------------------- |
| `index.html` と SPA navigation      | `no-cache, no-store, must-revalidate` |
| `sw.js`                             | `no-cache, no-store, must-revalidate` |
| stable identity/capability manifest | `no-cache, no-store, must-revalidate` |
| content-hashed JS/CSS/Worker/assets | `public, max-age=31536000, immutable` |
| metrics API                         | `no-store`                            |

local preview、provider URL、Service Worker cache 経由の三経路で同じ期待値を検証する。

### 6.8 Evidence の段階

generic schema は `web-foundation-evidence/v1` とする。

1. `artifact evidence fragment`: build、test、hash、budget、variant。同期生成できる。
2. `deployment preflight evidence`: deployment ID、package 一致、header、API、migration prerequisite。
3. `observation evidence`: canary 期間、browser matrix、test 回数、incident、owner sign-off。
4. `release final evidence`: 上記三つへの参照と承認。

各 fragment は前段 fragment の immutable URI と SHA-256 を参照する新規 object として生成し、既存 object へ追記しない。artifact gate で 24 時間観測や Release A final evidence を生成しない。既存 Release A evidence v1 は別 validator で検証し、generic final evidence から参照する。

### 6.9 保管

- package、detached hash、evidence は write-once または retention lock を持つ object storage に保存する。
- production、phase-floor、paired-fallback package は、対応機能のサポート終了後 180 日か 18 か月の長い方まで保持する。
- upload/download 権限を release operator と read-only reviewer に分離する。
- 四半期ごとに download、outer hash、manifest、prebuilt deploy の restore drill を行う。
- CI の一時 artifact だけを rollback source にしない。
- release 採用時の raw test log、audit JSON、performance trace、provider response は package と同じ期間、immutable URI と SHA-256 付きで保持する。PR-only の raw artifact は 90 日保持する。

## 7. PWA と cleanup の共通排他

### 7.1 Lock 名と順序

lock 名を次で固定する。

1. update のみ: `event-shopping-planner:pwa-update-election:<waitingBuildInputId>`
2. 共通: `event-shopping-planner:lifecycle-transition`
3. update のみ: `event-shopping-planner:pwa-client-presence`
4. cleanup のみ: 既存 `event-shopping-planner:persistence-legacy-cleanup`

Web Locks 対応 browser の互換 floor client は mutable App を mount する前に、世代にかかわらず 3 の同じ shared lock を取得・保持する。exclusive lock 保持中に開いた新 tab は compatibility hold に留まり、App を mount しない。世代別の lock 名にすると異なる controller 世代の tab を排他できないため禁止する。Web Locks 非対応 browser は capability を `close-all-only` として mount できるが、in-app APPLY/CLEANUP を一切許可せず、Worker の client 列挙には含める。

election と lifecycle は exclusive、presence は通常 shared/update 時 exclusive で取得する。update は次の state machine だけを許可する。

1. ambient shared presence を保持したまま election を `ifAvailable: true` で一度だけ取得する。この non-waiting lease だけを順序例外とする。
2. blocker を検査し、失敗時は shared presence を保持したまま election を解放する。
3. UI を freeze し、自身の shared presence を解放する。
4. shared presence を保持していない状態で lifecycle を AbortSignal 付き最大 5 秒で取得する。
5. lifecycle 保持中に exclusive presence を AbortSignal 付き最大 5 秒で取得する。
6. blocker と client set を再検査して permit protocol へ進む。

待機する election/lifecycle acquisition を shared presence 保持中に行うことを禁止する。persistence cleanup を開始する client も freeze 後に shared presence を解放し、lifecycle → legacy-cleanup の順で取得する。これにより lifecycle と presence の循環待ちを作らない。Web Locks に atomic downgrade はない。

point of no return 前に失敗した場合は次の順で復帰する。

1. election lock と UI freeze を維持する。
2. exclusive presence lock を解放する。
3. lifecycle lock を解放する。
4. shared presence lock を再取得する。
5. 再取得後にだけ UI freeze を解除する。
6. election lock を解放する。

cleanup 完了/失敗時も legacy-cleanup → lifecycle の順で解放してから shared presence を再取得する。shared 再取得に失敗した場合は fail-closed を維持し、自動 reload しない。non-waiting election 例外、hidden tab が残る timeout、lock abort、crashed tab 解放後の再試行を architecture/state-machine test に含める。

### 7.2 Cleanup 境界

- `persistenceCleanupCoordinator.ts`: proof、kill switch、lock、安全判断、fail-closed の調停
- `migration/legacyCleanupService.ts`: journal/archive/committed target 検証、entry claim、control record の CAS write/readback、crash resume、各削除直前の safety revalidation を所有
- `migration/legacyLocalStorageAdapter.ts`: service が指定した既存 exact legacy key の read/remove だけを実行
- Service Worker cache cleanup: activation authorization に束縛された exact cache allowlist の idempotent executor

cleanup service は `controlRepository`、`transactionCoordinator`、coordinator revalidation を使用し、現 `executePhysicalLegacyCleanup` の順序と crash-safety contract を維持する。IndexedDB は journal/archive/proof/control の保持に使うが、database、store、record、generic `syncQueue` を削除対象にしない。prefix/glob に一致した `localStorage` key も削除しない。本計画は共通 lifecycle lock と proof transport の契約を実装するが、persistence Release B の provider、kill switch、実削除呼出しは production entry point へ接続しない。

Service Worker の activation authorization は、次のどちらか一つで成立する。

1. running client が lock と blocker を検証し、permit を消費した。
2. browser が同 registration scope の旧世代 window client 0 件を確認して waiting Worker を自然 activate した。

両経路で同じ idempotent exact-cache cleanup を実行する。permit 経路では client が lifecycle/presence lock を保持し、自然 activation 経路では旧 client が存在しないことを Worker が `clients.matchAll({ type: "window", includeUncontrolled: true })` と registration scope filter で再確認する。どちらも証明できない activate では destructive cleanup をせず、次回の承認済み cleanup message まで保留する。

deferred cleanup は active Worker に対する `PREPARE_CLEANUP` / `APPLY_CLEANUP` とし、PWA permit と同じ source ID、nonce、expiry、client-set fingerprint、lifecycle/exclusive presence、blocker 再検査を使う。`skipWaiting()` は呼ばず、client は cleanup success ack と exact cache 残存 0 を確認するまで lock を保持する。

## 8. 品質 command と CI

### 8.1 段階導入する command

| Command                                         | 導入時点 | 責務                                                        |
| ----------------------------------------------- | -------- | ----------------------------------------------------------- |
| `verify:runtime`                                | 0A       | exact toolchain/build environment                           |
| `capture:baseline-v0`                           | 0A-0     | 現行 artifact、lint、audit、CDN 表示を保存                  |
| `quality:local`                                 | 0A       | typecheck、lint delta、format、encoding、unit               |
| `quality:pr`                                    | 0B       | required static/unit/E2E/a11y/audit gate                    |
| `build:artifact -- --variant <name>`            | 0C       | descriptor を固定し一度だけ build                           |
| `package:release -- --artifact <path>`          | 0C       | 完全 package と detached index を生成                       |
| `quality:artifact -- --package <path>`          | 0C       | hash、graph、budget、offline、package 検証                  |
| `deploy:qa -- --package <path>`                 | 0C       | isolated QA へ保存済み package を prebuilt deploy           |
| `verify:provider -- --deployment <id>`          | 0C       | QA の全 bytes/header/function/prerequisite を照合           |
| `quality:transition -- --scenario <path>`       | 1A       | old → candidate transition                                  |
| `release:preflight -- --package <path>`         | 1D       | production project の prerequisite と承認前検査             |
| `release:create-candidate -- --package <path>`  | 1D       | domain 未切替の immutable production-target deployment 作成 |
| `release:verify-candidate -- --deployment <id>` | 1D       | candidate の全 bytes/header/function/prerequisite を照合    |
| `release:promote -- --deployment <id>`          | 1D       | 同じ deployment ID を二者承認で production alias へ昇格     |
| `release:observe -- --deployment <id>`          | 1D       | 新規 immutable observation fragment を生成                  |
| `release:finalize -- --evidence-in <path>`      | 1D       | 長時間観測後の final evidence                               |

PowerShell の実行例では `<...>` を literal に使わない。

```powershell
$scenarioPath = (Resolve-Path -LiteralPath '.\test-artifacts\transition-plan.json').Path
npm run quality:transition -- --scenario $scenarioPath
```

### 8.2 Browser command の ownership

| Wrapper             | Inner project               |
| ------------------- | --------------------------- |
| `test:e2e`          | `test:e2e:project`          |
| `test:e2e:a11y`     | `test:e2e:a11y:project`     |
| `test:e2e:pwa`      | `test:e2e:pwa:project`      |
| `test:e2e:csp`      | `test:e2e:csp:project`      |
| `test:e2e:provider` | `test:e2e:provider:project` |

単独 wrapper は build、preview server、port、cleanup を所有する。`quality:pr` と `quality:artifact` は一つの既存 build/server を共有し、inner project だけを呼ぶ。inner project は source を変更せず、再 build せず、server を起動しない。

browser は `@playwright/test 1.62.1` と lockfile に対応する Chromium を `npm exec -- playwright install chromium` で用意する。既存 Release A CDP verifier を維持する間は `CHROME_PATH` を Playwright Chromium executable に固定し、ambient Chrome/Edge 探索を release gate で禁止する。

canonical Linux build job は package を一度生成して immutable CI input として browser/provider job へ渡す。Windows browser job と QA/provider job はその package を read-only で使い、再 build しない。

### 8.3 Lint baseline

toolchain を変更する前に、現行 130 warnings、4 disables、1 `@ts-expect-error` を rule、path、line fingerprint 付きで固定する。

- baseline 外の warning は 0
- 新規 file の warning は 0
- disable の新規追加と範囲拡大は禁止
- 既存 disable を残す場合だけ、理由、owner、回帰 test を baseline に持つ
- rule rename は旧 fingerprint と新 fingerprint の review 済み mapping を要求する
- baseline 更新 command と通常比較 command を分離し、通常 CI に更新権限を与えない

### 8.4 Audit gate

- 全 PR で `npm audit --json` と `npm audit --omit=dev --json` を取得し、lockfile 変更有無に依存させない。
- advisory がある場合の exit code 1 は JSON として解析する。JSON parse failure、registry failure、tool failure は別の hard failure とする。
- reachable な critical/high、または production critical/high は Phase 1 着手前に 0 にする。
- fix が存在しない advisory は machine-readable waiver schema に advisory ID、package、affected range、resolved version、reachability、影響、緩和策、owner、reviewer、承認時刻、30 日以内の期限を持つ場合だけ許す。
- ExcelJS は untrusted XLSX を扱うため、moderate を含め個別 reachability review を必須とする。
- registry 不達時は release を fail-closed とし、cache 済み結果だけで昇格しない。
- production candidate 作成前 24 時間以内に live audit を再実行し、観測中は日次 scan する。新規 reachable critical/high または waiver 期限切れで alias 昇格を停止する。

### 8.5 Coverage と architecture gate

- changed lines 85% 以上、changed branches 80% 以上
- PWA protocol、persistence、XLSX contracts、release package は lines 90% 以上、branches 85% 以上
- global coverage は Phase 0 baseline から低下させない
- generated file、type-only file、fixture は明示 allowlist のみ除外
- source string test は coverage と behavior test の代用にしない

`verify:architecture` は少なくとも次を検査する。

- lock の逆順取得
- forbidden deep import
- facade からの DB/business 実装
- React component から ExcelJS 直接 import
- `App.tsx` から repository 実装への直接依存
- list navigation から DOM query の直接追加
- inline script/style の再追加
- lint disable の増加

### 8.6 A11y baseline

- `a11y:baseline:capture`: rule set、axe version、browser、route、viewport、fingerprint を保存
- `a11y:baseline:compare`: baseline 外の violation を失敗
- `a11y:baseline:approve`: reviewer と owner 付きで更新
- critical/serious は baseline 登録不可
- moderate/minor の例外は 30 日で期限切れし、期限切れを CI failure にする

### 8.7 性能予算

Phase 0 で `performance-budgets.json` を固定し、次の式を blocking 値にする。

- phase 未変更 entry/chunk: baseline gzip/brotli + `max(2%, 10 KiB)` 以下
- initial module graph: phase 別に承認した bootstrap delta を除き baseline より増加させない
- Phase 4 後: ExcelJS module を page client initial graph に 0 件
- precache: baseline から 10% を超えて増加させない。Worker precache は別行で計上する
- PWA bootstrap: fixed runner の p95 が baseline + 10% 以下
- XLSX 操作中 main-thread long task: 50 ms 超を 0 件
- virtual list interaction latency: 1,000 行 fixture の p95 100 ms 以下、かつ full renderer baseline から悪化しない。Phase 5 採用にはさらに 30% 以上の改善を要求する
- scroll/focus target miss: 0

`verify:bundle-budget` は artifact gate、`verify:xlsx-budget` と `verify:list-budget` は固定 self-hosted runner の promotion gate に接続する。`windows-latest` の timing を blocking 基準にしない。

timing gate は runner CPU/OS/browser/container digest を fingerprint 化し、warmup 5 回後に 20 sample を測定する。infra failure 以外の retry と best-of 選択は禁止する。logical entry 名と chunk graph の対応を manifest に保存し、hash filename の変化で予算対象が入れ替わらないようにする。phase 別 approved delta は owner/reviewer/期限を持つ budget file の独立差分としてだけ追加できる。

variant 別の blocking 条件を次で固定する。

| Variant            | Blocking performance/quality gate                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 全 variant         | semantic golden、resource limit、redaction、a11y、bundle/graph contract                                       |
| XLSX Worker        | main-thread long task 50 ms 超 0、timeout/cancel/backpressure                                                 |
| XLSX main fallback | semantic/resource limit、現行同 fixture の duration +10% 以下、低性能 fallback 表示。long-task 0 は要求しない |
| virtual renderer   | p95 100 ms 以下、full baseline 非回帰、30% 以上改善、target miss 0                                            |
| full-only renderer | full baseline p95 +10% 以下、keyboard/screen reader path                                                      |

candidate 専用の改善値を paired fallback へ適用せず、fallback の安全・正確性条件を緩めない。

### 8.8 CI hardening

- GitHub Actions は必要最小 `permissions`、job timeout、concurrency cancellation を持つ。
- third-party action は full commit SHA で pin する。
- fork PR へ secret を渡さない。
- log と artifact から env/secret を redact する。
- artifact retention を明示し、rollback package は WORM storage へ別送する。
- workflow を先に merge して green を確認し、その後に branch protection の required check を有効化する。
- repository setting、auto-deploy guard、required check の変更は evidence を残す独立した operator 作業にする。

## 9. 全体実施順と production 昇格

実施順は固定する。

0. Phase 0 guard: 最初の source merge より前に main auto-production promotion を停止
1. Phase 0A-0: 現行の immutable baseline
2. Phase 0A: toolchain、audit、lint identity
3. Phase 0B: E2E、a11y、coverage、architecture
4. Phase 0C: artifact/package/provider 基盤
5. Phase 1A: QA-only custom Worker parity
6. Phase 1B: prompt UI、blocker、startup、root boundary
7. Phase 1C: multi-client permit、cleanup coordination
8. Phase 1D: transition、provider、production floor
9. Phase 2A: local Tailwind CSS
10. Phase 2B: legacy Tailwind cache cleanup
11. Phase 3: CSP
12. Phase 4: XLSX Worker
13. Phase 5: ShoppingList virtualization
14. Phase 6: `App.tsx` 分割
15. Phase 7: IndexedDB 分割
16. M2: lint 0、観測、rollout 専用分岐削除

operator は Phase 0 guard の provider/repository 設定と証跡を source PR より先に完了する。Phase 0A-0 から 1D までの source PR は merge できるが、production artifact は 1A～1D を一括で通過した互換 floor だけを昇格できる。

現在の persistence Release A production acceptance が repository 内 evidence で完了していない場合、Phase 0 の source/QA 作業は進めてよいが、Phase 1D の production 昇格は行わない。

各 PR は一つの主リスクだけを扱う。計測、coverage、repository setting、provider setting を一つの PR にまとめない。

## 10. Phase 0A-0: 現行 baseline の固定

### 10.1 変更

auto-promotion guard 後、照合基準 commit を clean detached worktree へ checkout する。別の固定済み tooling checkout から `capture:baseline-v0 --source-dir <clean-checkout>` を実行し、現行 Node 20.20.0/npm 10.8.2 のまま次を保存する。capture tooling の追加 commit 自体を baseline source として build しない。

- source SHA、lockfile、tool version
- `build:release-a` の complete log と `dist` file hash tree
- `index.html`、`sw.js`、capabilities manifest、precache
- `vercel.json`、API function、migration hash、active env key 名
- lint/audit/disable/expect-error identity
- current autoUpdate Worker の transition fixture
- Tailwind CDN response bytes、URL、取得時刻、SHA-256
- 主要画面の screenshot と computed-style fingerprint
- unit/build/encoding の実行結果
- 既存 Release A evidence への参照

baseline capture script は `npm audit` exit code 1 を advisory 結果として受理し、解析不能と混同しない。

baseline 採取後に恒久 capture script/schema を merge する。source SHA が変われば capabilities、HTML、Service Worker bytes も変わるため、「script-only なので同じ build」と扱わず、production へ昇格しない。

`.gitattributes` は全 text LF を要求する一方、Prettier は `AGENTS.md` と `docs/Resilient Persistence & Safe Migration Plan.md` を CRLF 指定し、tracked bytes も CRLF である。0A-0 で bytes/BOM/EOL を固定した後、独立 PR で `.gitattributes` にこの二 file の `eol=crlf` override を追加し、それ以外を LF のままにする。意図した属性差分だけを隔離し、`test:encoding` の scan 対象へ二 file を含め、Prettier、Git attributes、実 bytes が同じ期待 EOL を検査する。

### 10.2 合格条件 `P0-BASELINE`

- toolchain 変更前の artifact と CDN 表示を再検証できる。
- baseline file は source と別の immutable storage にも保存される。
- current previous-production package を再 deploy できるか、できない場合は production promotion を停止したまま原因を解消する。
- main auto-production promotion が無効または承認制である証跡がある。
- canonical build/capture が dirty または untracked input を拒否する。
- BOM/EOL catalog と実 bytes が一致する。

## 11. Phase 0A: Toolchain と依存関係

### 11.1 Version 方針

次の組合せを一つの compatibility PR に混在させず、順に更新する。

1. Node `24.18.0`、npm `11.16.0`、`@types/node` `24.13.3`
2. Vite `8.2.0`、`@vitejs/plugin-react` `6.0.5`
3. Vitest `4.1.10`、`@vitest/coverage-v8` `4.1.10`、jsdom `30.0.1`
4. vite-plugin-pwa `1.3.0`、`@vite-pwa/assets-generator` `1.0.2`、Workbox `7.4.1`
5. ESLint `9.39.5`、typescript-eslint parser/plugin `8.66.0`、react-hooks `7.1.1`
6. Playwright `1.62.1`、axe-core Playwright `4.12.1`
7. Tailwind `3.4.19`、PostCSS `8.5.25`、Autoprefixer `10.5.4`
8. `@supabase/supabase-js` `2.112.0`、`ws` `8.21.2`
9. Vercel CLI `58.5.1`

React 18.3、TypeScript 5.9、Tailwind 3 の major は維持する。選択 version は exact pin し、lockfile を正本とする。

custom `src/sw.ts` が import する `workbox-core`、`workbox-precaching`、`workbox-routing`、`workbox-strategies`、必要な場合の `workbox-expiration` と、page 側の `workbox-window` はすべて `7.4.1` の direct devDependency にする。transitive dependency を実装 API として使わない。

### 11.2 必須 migration

- Vitest の `environmentMatchGlobs` を projects へ移す。
- unit、DOM、Worker、tooling/API の tsconfig/project を分ける。
- ESLint 9 flat config へ移し、旧 baseline fingerprint を明示 mapping する。
- Vite 8 の暗黙 browser target を受け入れず、app と Worker の `build.target` を `es2020` に固定する。
- manual chunk、lazy import、PWA manifest、precache、asset path の golden test を更新する。
- provider build と function runtime が Node 24 で動くことを QA deployment で証明する。

### 11.3 Security

Phase 1 前に reachable critical/high と production critical/high を 0 にする。Vite、Vitest、vite-plugin-pwa、`ws` の advisory を新 PWA 実装より先に解消する。ExcelJS は更新だけで解消しない advisory を input limit、Worker isolation、reachability review と waiver の組で扱う。

### 11.4 合格条件 `P0-TOOLCHAIN`

- `verify:runtime` が local/CI の exact versionと provider の runtime family/resolved patch allowlist を検証する。
- typecheck、unit 1,198 件以上、build、encoding が成功する。
- lint baseline 外 warning が 0 である。
- Vite 5 baseline と比較し、意図しない browser target、chunk、PWA output 差分がない。
- production promotion は停止中である。

## 12. Phase 0B: Browser、a11y、coverage

### 12.1 Browser fixture

決定的な fixture と test-only API を用意する。

- fresh install
- controlled page
- waiting Worker
- saved/unsaved/saving/failed/recovery-required persistence
- map import preview、event import、event export
- backup restore の draft と実行中
- multi-tab
- chunk load failure
- offline/online
- 1,000 行 shopping list

production code に test bypass を埋めず、build-time test endpoint と fixture DB を production package から除外する。

### 12.2 A11y

keyboard、focus order、dialog、live region、color contrast、zoom、screen reader label を主要 route で検査する。viewport の zoom 禁止を除去し、200% zoom と narrow viewport を required case にする。

### 12.3 合格条件 `P0-BROWSER`

- wrapper/inner command の所有権が test で保証される。
- fixed Chromium で通常 E2E、a11y、offline smoke が成功する。
- changed coverage と high-risk coverage の閾値を満たす。
- source string assertion を新規追加しない。
- branch protection は workflow green 後にだけ required 化される。

## 13. Phase 0C: Artifact と provider 基盤

Phase 0C は次の独立 PR に分ける。

1. build input descriptor と generic artifact manifest
2. bundle/graph/performance budget
3. complete release package
4. provider prebuilt deploy と byte/header verification
5. generic evidence fragment
6. repository/provider setting の operator evidence

`release-capabilities*` は dual-write のまま維持する。

既存 Release A tooling は次の順で variant-aware にする。

- `verify-release-a-build.mjs`: `registerSW.js` を hard-code せず、legacy generateSW と prompt injectManifest の各 contract を capabilities から選ぶ
- `verify-release-a-browser.mjs`: fixed Playwright Chromium、package ID、startup 四分岐、旧/新 Worker transition を検査する
- `rehearse-release-a-rollback.ps1`: 旧 source の再 build をやめ、保存済み package の prebuilt deploy と hash 再照合を行う
- `verify-release-a-evidence.mjs`: schema v1 と `buildId=sourceSha` を変更しない

旧再 build rollback は diagnostic 用にも release gate から除外する。generic verifier を先に追加し、Release A consumer の互換 test が green のまま各 consumer を移行する。

### 13.1 合格条件 `P0-ARTIFACT`

- 同じ input を canonical runner で二回 build し、static と function/provider bundle の content tree が一致する。
- package を clean environment へ展開し、static app と metrics function を起動できる。
- env secret 値を含まない。
- `deploy:qa` した package の全 bytes、headers、API、migration prerequisite が `verify:provider` で一致する。
- artifact evidence fragment は生成できるが、長時間観測を必要とする final evidence は生成しない。
- previous-production package と新 package の transition scenario を記述できる。

## 14. Phase 1: Prompt 型 PWA 更新

### 14.1 最終構成

- `vite-plugin-pwa` は `injectManifest` を使う。
- custom Worker は `src/sw.ts` を正本とする。
- `injectRegister: false`、`registerType: "prompt"`、`skipWaiting: false`、`clientsClaim: false` を明示する。
- app bootstrap が registration state を snapshot する前に virtual register module や component を mount しない。
- `index.html` の唯一の entry を小さい `src/bootstrap.ts` とし、React、App、feature/persistence module を静的 import させない。
- `src/bootstrap.ts` が page/Worker identity と reload safety を照合し、安全分岐だけで `src/index.tsx` を dynamic import する。
- app root/provider の外側に root Error Boundary と update coordinator を置く。

`injectManifest` では activation が custom Worker 自身の責務である。`src/sw.ts` は generic `"SKIP_WAITING"` message を拒否し、permit handler 以外から `self.skipWaiting()` を呼ばず、activate 時に `clientsClaim()` を呼ばない。source scan と built `sw.js` scan の両方で無条件 activation/takeover がないことを固定する。

### 14.2 `src/sw.ts` の parity

Phase 1 の custom Worker は現 generateSW の次を再現する。

- precache と revision
- SPA navigation fallback
- offline asset response
- Workbox precache namespace に限定した outdated app cache cleanup
- Tailwind CDN `CacheFirst`
- Supabase origin `NetworkOnly`

Supabase runtime route は client bundle が未接続でも、Phase 1 parity では維持する。削除は usage graph を証明する独立 PR、または Phase 2 の route owner 変更として行う。

Workbox の cleanup helper が無条件 `activate` listener を登録する構成は使わない。旧 precache の判定規則を exact app-cache namespace に限定した executor へ移し、§7.2 の activation authorization 後にだけ呼ぶ。runtime cache の削除は phase ごとの明示 allowlist に限定する。

### 14.3 Startup の四分岐

mutable App を mount する分岐は、先に共通 `acquirePresenceOrHold()` barrier を通る。Web Locks 対応時は shared presence を最大 5 秒で取得できた場合だけ mount し、exclusive transition 中の timeout は hold にする。非対応時だけ capability を `close-all-only` に固定して mount する。

1. `controller == null`: barrier 成功後、初回 load として app を mount し、snapshot 後に Worker を登録する。
2. controller が応答し `pageBuildInputId == activeWorkerBuildInputId`、protocol 互換: barrier 成功後に app を mount する。
3. controller が応答し protocol 互換だが identity 不一致、かつ waiting Worker が page と一致: compatibility hold 画面を出し、独立 persistence safety snapshot が idle を証明した場合だけ prompt protocol を開始する。
4. controller があるが pre-floor、timeout、unknown protocol、identity 欠落: app chunk を追加 load せず fail-closed hold 画面を出す。「今すぐ更新」は無効にし、全 tab を閉じて再起動する手順だけを示す。bootstrap は candidate の registration/update check までは行ってよいが、`skipWaiting()` を要求せず、自動 reload loop を作らない。

hold 画面は `src/bootstrap.ts` と小さい external bootstrap CSS だけで描画し、React/App chunk に依存しない。keyboard、screen reader label、200% zoom、offline を E2E 対象にする。

controller 応答 timeout は固定値 3 秒、retry は利用者操作ごとに 1 回とする。

### 14.4 Root Error Boundary

React mount 前に root coordinator が `ReloadSafetyStore` を初期化する。bootstrap 用 validator は現行 recovery 判定から副作用なしの `inspectPersistenceRecoveryState()` を抽出し、10 app store payload/checkpoint、`syncQueue` control metadata、migration journal/archive、exact legacy `localStorage` runtime-fallback candidate の parse/digest/reconcile を read-only で検査する。control metadata だけで `idle` にしない。

probe は migration、cleanup、write を開始しない。`indexedDB.databases()` などで DB 存在を確認できない場合は `unknown` とし、probe のために空 database を新規作成しない。最初は `unknown`、全 recovery source の整合を証明した後だけ `idle` にする。running App の persistence hook と blocker registry は同じ store へ同期 publish する。

snapshot は `status`、`mutationEpoch`、`durableSaveEpoch`、`recoveryEpoch`、`blockerCount`、`observedAt` を持つ。`status == saved`、mutation/save epoch 一致、recovery 完了、blocker 0、snapshot freshness 1 秒以内を同時に満たす場合だけ reload-safe とする。mutation boundary は React effect を待たず同期的に epoch/token を更新し、App crash 直前の変更を古い `saved` snapshot で safe 判定しない。

running App は `refreshReloadSafety()` で同期 ref、registry、read-only recovery probe を再検証し、prompt の有効化直前、PREPARE 前、APPLY 前に新しい `observedAt` を発行する。App crash/unexpected unmount 後は refresh を不可にして `unknown` を返すため、1 秒 freshness を heartbeat で見せかけない。

root Error Boundary は lazy chunk/Worker chunk load error と通常 render error を分類する。

- root coordinator が保持する `ReloadSafetyStore` が上記 reload-safe を証明した場合だけ update/retry 操作を提示する。
- `unsaved`、`saving`、`failed`、`recovery-required`、snapshot 不明では reload/update を提示しない。
- App crash を blocker 解放として扱わない。
- raw stack、XLSX 内容、利用者データを evidence へ書かない。

### 14.5 Blocker registry

blocker は token 方式の単一 registry で管理し、登録元、開始時刻、理由、解除理由を持つ。

| 状態                     | blocker 開始                      | blocker 解除                                             |
| ------------------------ | --------------------------------- | -------------------------------------------------------- |
| persistence unsaved      | mutation boundary                 | durable save 成功                                        |
| persistence saving       | write 開始                        | success/failure token へ原子的に遷移                     |
| persistence failed       | write failure                     | retry save 成功                                          |
| recovery-required        | recovery 検出                     | recovery 完了・検証・保存成功                            |
| map import               | file 選択/preview 作成            | apply 完了または cancel                                  |
| event import             | file 選択                         | import transaction 完了または cancel                     |
| event export draft       | options を変更                    | confirm 時に execution token へ原子的置換、または cancel |
| event export execution   | confirm                           | download 成功または cancel                               |
| backup restore draft     | restore source/mode/target を変更 | restore 完了または cancel                                |
| backup restore execution | restore 開始                      | durable save と結果確認                                  |
| XLSX Worker              | request accepted                  | result/cancel/error cleanup                              |
| drag/edit                | operation 開始                    | commit または cancel                                     |

status/token の置換は一つの registry transaction とし、`saving` 解除と `failed` 登録の間に blocker 0 を観測させない。failed 状態の破棄は本計画へ追加せず、既存 recovery/save で durable 化するまで保持する。

全 operation/draft token の commit は、後続の execution、persistence-unsaved、persistence-saving token の登録と同じ registry transaction で置換する。map import apply、event import、export、backup restore、drag/edit の各 handoff で blocker 0 を観測しない race test を持つ。unexpected unmount/App crash では component cleanup が token を解放せず crash-seal し、通常 unmount は明示 commit/cancel transaction の完了時だけ解放する。

dialog を pristine なまま開いただけでは blocker にしない。`BackupRestoreDialog` の `sourceEventName`、`restoreMode`、`targetEventName` と `ExportOptionsDialog` の local options を明示的に対象にする。Phase 1B で Item edit/add、event rename、URL/map edit、各 dialog draft、async operation の全 local state owner を inventory 化し、各開始/commit/cancel/unmount test が揃わない限り blocker registry を完了扱いにしない。

### 14.6 Permit protocol

#### PREPARE

1. client は shared presence 保持中に `refreshReloadSafety()` を実行し、election を `ifAvailable` で取得して blocker を検査する。
2. client は UI を freeze し、自身の shared presence を解放してから、lifecycle → exclusive presence を bounded acquisition する。
3. client は reload safety と blocker を再検査する。
4. client から waiting Worker へ MessageChannel で `PREPARE_UPDATE` を送る。
5. waiting Worker は `MessageEvent.source.id` を要求元として取得する。
6. Worker は `clients.matchAll({ type: "window", includeUncontrolled: true })` を実行し、registration scope で filter した client が要求元一件だけであることを確認する。
7. Worker は nonce、15 秒 expiry、source client ID、protocol、page/active/waiting build ID、client-set fingerprint を memory に束縛して返す。

#### APPLY

1. client は lock 所有中に `refreshReloadSafety()`、blocker、identity をもう一度確認する。
2. client は `APPLY_UPDATE` と nonce を同じ waiting Worker へ送る。
3. Worker は source、protocol、identity、expiry、unused、client-set fingerprint を再検査する。
4. Worker は await を挟まない同じ handler で permit を consumed、state を `activation-committed` にし、PONR を越えて `skipWaiting()` を呼ぶ。
5. `skipWaiting()` の throw/reject/timeout も post-PONR failure として扱い、mutable App を再開しない。nonce は再利用しない。
6. client は registration が candidate を `activating` または `activated` として観測する。
7. activated Worker は authorized/idempotent cache cleanup を完了し、exact cache の残存を再検査して `ACTIVATION_COMPLETE` または `ACTIVATION_FAILED` を返す。Worker restart 後も status query は cache の実状態から同じ結果を再構成する。
8. `clientsClaim: false` のため `controllerchange` は待たない。client は lifecycle/exclusive presence lock を保持したまま、`registration.active` へ MessageChannel で identity と activation status を問い合わせる。
9. activated/expected identity、cleanup success の ack が一致した場合だけ、client は明示 reload を一度行う。reload 後の bootstrap が新 controller と page の一致を再検査する。

waiting Worker が PREPARE 後に terminate/restart すると memory permit は失われる。APPLY は `PERMIT_NOT_FOUND` で失敗し、client は update を適用しない。再試行は全 lock/blocker 検査からやり直す。

PONR 後に activation/cleanup ack が 10 秒で得られない場合は mutable App を再開せず hold 画面を維持する。election と freeze を維持したまま exclusive presence → lifecycle の順で解放し、shared presence を再取得してから election を解放する。自動 reload と legacy package rollback を行わず、runbook に従い現在の floor と互換な close-all/fix-forward package を配布し、idempotent cleanup/status query を再実行する。

必須 reject test は次のとおり。

- expired nonce
- replay/reuse
- requester 消失
- source client ID 不一致
- client set 追加/削除
- page/active/waiting identity 不一致
- protocol mismatch
- Worker restart
- blocker 再発
- lock loss
- `skipWaiting` failure
- activation/cleanup ack timeout
- natural activation と新 tab open の race

### 14.7 Web Locks 非対応

Web Locks がない browser では running app からの「今すぐ更新」を無効にする。全 client を閉じた後の browser 標準 activation と再起動だけを許可し、手動 reload を繰り返さない。

## 15. Phase 1 の分割

### 15.1 Phase 1A: QA-only parity

- production `generateSW/autoUpdate` は変更しない。
- QA variant だけで `injectManifest` custom Worker を build する。
- navigation、offline、precache、Tailwind、Supabase route の parity を証明する。
- current autoUpdate → `prompt-close-all` bridge → `prompt` candidate の transition harness を先に作る。
- 長期休眠 client 用に `legacy-auto` → `prompt` の bridge skip、最古の保持対象 prompt-compatible floor → current candidate、複数 phase skip、unknown protocol を transition fixture に含める。

合格条件 `P1A-PARITY`:

- current previous-production package から QA bridge/candidate への全 transition test が実行可能である。
- custom Worker の scope、navigation response、offline asset、precache集合、cache name/owner が baseline と exact または review 済み allowlist 差分である。
- production promotion は禁止されたままである。

### 15.2 Phase 1B: Prompt UI と startup

- build-time `VITE_PWA_UPDATE_MODE=legacy-auto|prompt-close-all|prompt` を catalog 化する。
- default production variant は 1D まで `legacy-auto` のままにする。
- `prompt-close-all` と `prompt` の custom Worker は同じ protocol/permit を実装する。前者の page UI は future update の in-app APPLY を提示せず、close-all 手順だけを提示する。
- prompt variant に startup 四分岐、root Error Boundary、blocker registry、single-client protocol を追加する。
- persistence hook は root の `ReloadSafetyStore` へ mutation/save/recovery epoch と状態を publish する。状態不明を safe にしない。

合格条件 `P1B-PROMPT`:

- blocker 表の正負 E2E がすべて通る。
- chunk failure 中に unsafe reload が起きない。
- pre-floor controller で reload loop が起きない。
- prompt source merge 後も production は legacy artifact のままである。

### 15.3 Phase 1C: Multi-client と cleanup coordination

- permit protocol の nonce/source/fingerprint/restart 処理を完成する。
- lifecycle lock を persistence cleanup contract へ接続する。
- exact cache cleanup allowlist と lock order architecture test を追加する。
- persistence legacy `localStorage` key executor は production entry point へ接続しない。

合格条件 `P1C-MULTICLIENT`:

- 2～5 tab と hidden tab が残る間は 5 秒以内に update を拒否して shared state へ復帰し、crashed/closed tab の lock 解放後だけ再試行できる。
- tab open/close race で mutable App と exclusive transition が並行しない。
- permit reject test がすべて通る。
- lock downgrade failure が fail-closed になる。
- Release B capability は hard OFF のままである。

### 15.4 Phase 1D: Production floor

- `prompt-close-all` bridge と `prompt` の二つを完全 package 化する。
- production project に domain 未切替 candidate deployment を作り、全 bytes/header/API を検証してから、二者承認で同じ deployment ID を alias 昇格する。
- current autoUpdate → bridge、bridge → prompt、legacy-auto → prompt direct skip は close-all/natural activation、prompt → newer prompt と prompt → same-floor close-all fallback は permit/natural activation の transition matrix を通す。
- 全 retained compatibility floor から candidate への複数 phase skip と、retention 外/unknown protocol の fail-closed hold を通す。
- prompt → legacy-auto の transition と legacy-auto の再 deploy を拒否する。
- Tier 2 smoke を行う。
- Release/Data Safety/Operations reviewer が sign-off する。

合格条件 `P1D-FLOOR`:

- `P0-BASELINE`、`P0-TOOLCHAIN`、`P0-BROWSER`、`P0-ARTIFACT`、`P1A-PARITY`、`P1B-PROMPT`、`P1C-MULTICLIENT` が green。
- persistence Release A の production gate が別途完了している。
- preview/localhost transition rehearsal と、本番同一 origin の installed PWA transition を分けて実施する。Service Worker を割合 traffic で canary 済みとみなさない。
- bridge を origin-wide 昇格して 24 時間以上監視し、その後 prompt を origin-wide 昇格してさらに 24 時間以上監視する。
- prompt package と prompt-close-all bridge/fallback package の immutable copy がある。legacy-auto package は forensic/pre-floor fixture として保持するが通常 rollback に使わない。
- provider auto-promotion を再開せず、承認済み package だけを production へ昇格する。

`P1D-FLOOR` 完了後の prompt package を PWA phase-floor package とする。

bridge が一台でも activation した後は roll-forward-only とし、legacy-auto を再配布しない。PONR 後の障害は現在の compatibility floor と同じ asset/security 契約を持つ `prompt-close-all` fallback、または新しい prompt-compatible fix-forward package で対処する。

## 16. Phase 2A: Tailwind local CSS

### 16.1 変更

- `tailwind.config.ts`、`postcss.config.js`、`src/styles/tailwind.css` を追加する。
- Tailwind 3.4.19 を exact pin する。
- `index.html` の CDN script と inline Tailwind config を削除する。
- content scan に `index.html` と全 TS/TSX source を含める。
- 動的 class 名は明示 safelist または静的 mapping へ移す。
- `src/sw.ts` から Tailwind CDN runtime route を削除する。
- 未接続 Supabase client route は graph 検証後、別 commit で削除する。
- local CSS を含む `prompt` と `prompt-close-all` を同じ source から package 化し、後者を P2B 後も使える新しい PWA safety fallback にする。

比較対象は Phase 0A-0 で固定した screenshot/computed-style/CDN bytes であり、実装時点の live CDN ではない。

### 16.2 合格条件 `P2A-LOCAL`

- HTML、source、network、Service Worker route に Tailwind CDN request がない。
- deterministic screenshot の unmasked pixel diff が各画面 0.1% 以下で、layout/visibility/font-size/color の選択済み computed-style field が exact 一致する。antialias mask と意図差分は owner/reviewer 付き allowlist に限定する。
- offline cold start で同じ CSS が適用される。
- CSS size budget を満たす。
- 旧 `tailwind-cache` が残っていても参照されない。
- PWA phase-floor への rollback が可能である。

`P2A-LOCAL` package を Tailwind phase-floor とする。

## 17. Phase 2B: Legacy Tailwind cache cleanup

`P2A-LOCAL` を production で受け入れた後の別 artifact で実施する。

- `src/sw.ts` の exact allowlist に旧 `tailwind-cache` 名を一つだけ追加する。
- §7.2 の permit または client 0 natural activation authorization の中で idempotent cleanup を行い、次の page の status query でも残存 0 を確認する。
- prefix/glob による cache 全削除を禁止する。
- cleanup 前後に offline navigation と rollback compatibility を検査する。

合格条件 `P2B-CACHE`:

- current、waiting、rollback transition 後に旧 cache が残らない。
- app cache、runtime cache、利用者データを削除しない。
- offline 再起動が成功する。
- cleanup artifact 自体を immutable package として保存する。

旧 cache 削除後の rollback floor は `P2A-LOCAL` 以降に限定する。
P1D の CDN bridge/fallback は transition fixture として保持してもよいが、P2B 後の通常 deploy/rollback を拒否する。

## 18. Phase 3: CSP と inline code の撤去

### 18.1 Inline code

- theme 初期化を external hashed module へ移す。
- loading/viewport 処理を bootstrap module へ移す。
- inline `<style>` を local CSS へ移す。
- inline event handler、`javascript:` URL、`eval`、`new Function` が 0 であることを source/build scan する。

### 18.2 CSP 正本

provider と local preview が同じ `config/response-policy.json` を使用する。

初期 policy:

```text
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
form-action 'self';
script-src 'self';
style-src 'self';
style-src-attr 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' https://docs.google.com;
worker-src 'self';
manifest-src 'self';
```

Google Sheets 導線で redirect origin が追加で必要な場合は、provider capture で実在を証明した exact origin だけを追加する。未接続の Supabase client origin は許可しない。

`style-src-attr 'unsafe-inline'` は全 style attribute を許可する例外であり、React 由来だけを CSP が識別するものではない。既存 105 箇所は source inventory と architecture gate で管理する。新規追加は原則 failure とするが、Phase 5 の virtual row owner に限り、`position/top/left/width/height/transform` と finite layout number/static enum 由来の値を review 済み allowlist へ追加できる。URL、content、任意文字列を style 値へ流さない。

### 18.3 Security header

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 0`

obsolete な filter を有効化せず、CSP を正本にする。

### 18.4 合格条件 `P3-CSP`

- local/provider の enforced CSP で violation 0。
- report-only と enforced を同じ release で混在させない。
- unsafe inline script、`unsafe-eval`、wildcard source がない。
- style attribute が既存 inventory または virtual renderer 専用の property/value/owner/a11y test 付き allowlist に一致する。
- HTML、manifest、Worker、API、hashed asset の header/cache matrix が一致する。
- 同じ local CSS/CSP 契約の `prompt-close-all` package を保存し、PWA safety fallback をこの世代へ更新する。
- P2A phase-floor へ rollback できる。

## 19. Phase 4: XLSX Worker

### 19.1 先行分離

Worker 導入前に次を ExcelJS 非依存 module へ移す。

- number/date/text parsing helper
- XLSX request/result contract
- download helper
- export options と実使用 `ExportData` の source of truth
- map/event import preview の純粋 domain type

`src/types/export.ts` と `src/utils/exportImport.ts` の重複 `ExportData` を解消し、互換 type test を追加する。`persistenceRecoveryExport.ts` は ExcelJS module ではなく download helper へ依存させる。

### 19.2 Contract

`src/workers/xlsxContracts.ts` は疎な共通 object ではなく discriminated union とする。

```ts
type XlsxRequest =
  | {
      kind: "map-import";
      requestId: string;
      schemaVersion: 1;
      fileName: string;
      buffer: ArrayBuffer;
      options: MapImportOptions;
    }
  | {
      kind: "event-import";
      requestId: string;
      schemaVersion: 1;
      fileName: string;
      buffer: ArrayBuffer;
      options: EventImportOptions;
    }
  | {
      kind: "event-export";
      requestId: string;
      schemaVersion: 1;
      data: EventExportData;
      options: ExportOptions;
    };

type XlsxResult =
  | { kind: "map-import-success"; requestId: string; payload: MapImportSummary }
  | {
      kind: "event-import-success";
      requestId: string;
      payload: EventImportSummary;
    }
  | {
      kind: "event-export-success";
      requestId: string;
      payload: EventExportResult;
    }
  | {
      kind: "cancelled";
      requestId: string;
      operation: XlsxRequest["kind"];
      code: "USER_CANCELLED" | "SUPERSEDED" | "TIMEOUT";
    }
  | {
      kind: "error";
      requestId: string;
      operation: XlsxRequest["kind"];
      code: XlsxErrorCode;
      stage: XlsxStage;
      retryable: boolean;
    };

type XlsxTransportMessage =
  | { kind: "START"; request: XlsxRequest }
  | {
      kind: "CANCEL";
      requestId: string;
      reason: "USER_CANCELLED" | "SUPERSEDED" | "TIMEOUT";
    }
  | { kind: "CHUNK_ACK"; requestId: string; sequence: number }
  | {
      kind: "RESULT_CHUNK";
      requestId: string;
      operation: "map-import" | "event-import";
      sequence: number;
      rows: ArrayBuffer;
    }
  | { kind: "RESULT_END"; result: XlsxResult };
```

`XlsxErrorCode` は `FILE_TOO_LARGE | ZIP_ENTRY_LIMIT | ZIP_EXPANDED_TOO_LARGE | ZIP_RATIO_EXCEEDED | SHEET_LIMIT | CELL_LIMIT | TEXT_LIMIT | SCHEMA_MISMATCH | UNSUPPORTED_FORMAT | PARSE_FAILED | SERIALIZE_FAILED | WORKER_CRASHED | TIMEOUT | BUSY`、`XlsxStage` は `preflight | unzip | parse | validate | serialize | transfer` の固定集合とする。

error/cancel/log/evidence に raw Error、stack、file cell content を含めない。success は operation 別に検証・正規化した payload だけを返す。

`RESULT_CHUNK.rows` は schema version 1 の正規化済み row 配列を canonical UTF-8 JSON にした Transferable `ArrayBuffer` とする。receiver は sequence/schema/size を検証してから decode する。
import success payload は row 本体を重複して持たず、chunk count、row count、digest、warning summary だけを持つ。port adapter が検証済み chunk から最終 domain result を組み立てる。

### 19.3 Port と owner

- `XlsxExecutionPort` の owner は app root の単一 provider とする。
- `App.tsx` event import、`features/events/exportFlow.ts`、`components/map/MapImportDialog.tsx` へ同じ port を inject する。
- 同時 CPU operation は一件だけとする。map preview は latest-wins で前 request を `SUPERSEDED` にし、event import/export は実行中 request を置換せず新 request を `BUSY` で拒否する。暗黙 FIFO は作らない。
- provider が Worker の create、terminate、crash recovery、request ID、blocker token を所有する。
- `AbortSignal` 自体は Worker へ送らない。main owner が abort を明示 `CANCEL(requestId)` へ変換し、250 ms 以内に cancel ack/settlement がなければ Worker を terminate/recreate する。
- `RESULT_CHUNK` は sequence ごとの `CHUNK_ACK` を受けるまで次を送らず、backpressure と cancel の順序を protocol test で固定する。
- cancel/timeout/crash/terminate 時は全 pending Promise を一度だけ settle し、port、timer、blocker、chunk buffer、transferred buffer reference を必ず cleanup する。
- component は Worker instance と ExcelJS を直接 import しない。
- paired fallback は同じ port を main-thread adapter で実装し、contract を変えない。

### 19.4 Resource limit

UI preflight と Worker の両方で検査する。

- compressed file: 50 MiB 以下
- ZIP entry: 10,000 以下
- declared uncompressed total: 250 MiB 以下
- actual streamed uncompressed total: 250 MiB 以下
- actual single ZIP entry: 64 MiB 以下
- compression ratio: 100 以下
- sheet: 100 以下
- cell: workbook 全体で 1,000,000 以下
- single text value: 1 MiB 以下
- aggregate text: 50 MiB 以下
- import timeout: 60 秒
- export timeout: 120 秒

central/local header、entry path、declared size、CRC の欠落・矛盾・overflow を検査するだけでなく、各 entry を bounded streaming inflater へ通して実展開 byte を逐次計数し、single/aggregate 上限で直ちに停止する。続いて `workbook.xml`、worksheet XML、`sharedStrings.xml` を bounded SAX/streaming parser で走査し、sheet/cell/text 数を ExcelJS materialize 前に検査する。preflight 自体が entry 全体を一括保持しない。

上限超過は固定 error code で返し、Worker を terminate して blocker を確実に解除する。偽装 declared size、local/central 不一致、CRC 不一致、巨大 sheet、高圧縮、cancel race を fixture 化する。

event export は入力 domain row/cell/text 数を workbook 作成前に同じ上限で検査する。ZIP header + streaming inflate/XML preflight の実装または依存 package は Phase 0 audit gate を通した exact pin とし、ExcelJS を呼ぶ前に完了させる。

### 19.5 Semantics

- map import preview は最新 request ID だけを採用する。
- event import は既存 backup、validation、selected-event restore semantics を維持する。
- event export は既存 filename、sheet、cell 表現を golden workbook で検査する。
- `ArrayBuffer` は Transferable とし、不要な clone をしない。
- export workbook は Transferable `ArrayBuffer` で返す。import の正規化済み row は 250 行か 256 KiB の小さい方を上限とする `RESULT_CHUNK`、ack/backpressure、明示 CANCEL で渡し、巨大な一括 structured clone を禁止する。
- offline XLSX 契約を維持するため Worker/ExcelJS chunk は Service Worker precache に残し、page 初期 request graph と precache install transfer を別 budget で測る。
- Worker crash、chunk load failure、timeout は root Error Boundary と port error で扱い、自動 reload しない。

### 19.6 合格条件 `P4-XLSX`

- ExcelJS が page client 初期 module/request/evaluation graph に 0 件。
- Worker precache/network transfer は別予算で計上され、初期 page graph と混同しない。
- map import、event import、event export の golden output が一致する。
- untrusted input limit と error redaction test が通る。
- Worker ON candidate で main-thread long task 50 ms 超が 0。main fallback は §8.7 の fallback 基準を使う。
- Tier 1 required、Tier 2 重大障害なし。
- Worker ON と paired-fallback OFF package を同じ source から保存する。

production 既定 ON は paired transition と canary 後にだけ行う。

## 20. Phase 5: ShoppingList virtualization

### 20.1 分離する port

DOM 操作を business navigation から切り離す。

```ts
interface ListViewportPort {
  ensureMounted(
    target: ItemAddress,
    signal: AbortSignal,
  ): Promise<ViewportHandle>;
  scroll(handle: ViewportHandle, options: ScrollOptions): Promise<void>;
  focus(handle: ViewportHandle, options: FocusOptions): Promise<void>;
  getEpoch(): number;
  cancel(reason: ViewportCancelReason): void;
}
```

`useExecutionSpaceNavigator` は history/business guard を所有し、viewport port を inject される。直接 DOM caller である `App.tsx` の mode/search 遷移、`AppOverlayLayer.tsx` の edit-save、`useExecutionSpaceNavigator.ts` を先に移行する。

### 20.2 Row model

- stable item ID を key にする。
- filter/sort/group の domain result と render window を別 memo にする。
- variable height は measured cache と epoch で無効化する。
- focus target は `ensureMounted` 完了後にだけ scroll/focus する。
- search/mode/event change は古い operation を AbortController で cancel する。
- drag 中は overscan と target pinning を使い、DOM 非存在を business deletion と誤認しない。

### 20.3 Accessibility fallback

full renderer は恒久実装として残す。

- 利用者が a11y setting から full renderer を選べる。
- screen reader の自動検出は行わない。focus recovery failure を検出した場合は、操作 idle 後に full renderer へ切替を提案する。
- drag、edit、save、restore 中には renderer を切り替えない。
- fallback preference は versioned UI preference とし、event data へ混ぜない。

### 20.4 合格条件 `P5-LIST`

- 100、1,000、5,000 行 fixture で表示、scroll、search、edit、drag、mode change が正しい。
- scroll/focus target miss 0。
- keyboard と screen reader path が full/virtual 両方で通る。
- virtual/full-only がそれぞれ §8.7 の variant 別 latency budget を満たす。
- virtual ON と full paired-fallback package を保存する。
- rollout flag を OFF にすると同じ domain state で full renderer が動く。

M2 で削除できるのは rollout default-selection 分岐だけであり、full renderer と利用者向け a11y fallback は削除しない。

## 21. Phase 6: `App.tsx` 分割

### 21.1 目標責務

`App.tsx` に残してよいのは次だけとする。

- root composition
- provider wiring
- route 相当の top-level screen selection
- error/update boundary 接続

次を module へ抽出する。

- bootstrap/session-like initialization
- active event/date/tab state machine
- shopping operation commands
- import/export orchestration
- focus mode orchestration
- overlay/dialog orchestration
- persistence command adapter
- update blocker adapter

raw setter の束を渡さず、intent command と read model を interface にする。重複 `ActiveTab` は一つの public type に統一する。

### 21.2 Operation semantics

抽出前に現行の commit timing、optimistic update、rollback、operation 排他、stale completion を characterization test で固定する。次の target contract と現行挙動が異なる場合は、抽出 PR に混ぜず、Data Safety review を持つ独立 behavior-change PR と exit evidence で先に解消する。

- operation ID と abort signal を持つ。
- stale completion は state を上書きしない。
- persistence commit 成功後にだけ UI success を確定する。
- optimistic update の rollback を domain command が所有する。
- backup restore、event switch、import の排他を state machine で表す。

### 21.3 Test

- source string/handler 存在 test を behavior contract test へ置換する。
- extracted hook/module は isolated test を持つ。
- app-shell integration は user intent → state → persistence call → UI result を検査する。
- chunk/load boundary は root Error Boundary test を再利用する。

### 21.4 合格条件 `P6-APP`

blocking 条件:

- 上記の非許可責務が `App.tsx` にない。
- raw setter prop が shell boundary を越えない。
- source string assertion が 0。
- forbidden deep import が 0。
- operation race test が通る。
- extraction PR に未承認の behavior change が含まれない。
- behavior、a11y、bundle、PWA gate が回帰しない。

行数 2,000 以下は目標値とするが、責務 gate を満たしていれば単独の release blocker にはしない。行数、import fan-out、prop count は Phase 0 baseline より減少し、増加は許可しない。

## 22. Phase 7: IndexedDB 分割

### 22.1 依存方向

```text
facade
  -> repositories
      -> transaction coordinator
          -> stores
              -> raw database
  -> migration/recovery services
      -> transaction coordinator
  -> pure resilience helpers
```

逆依存と repository 間の direct store import を禁止する。

service/repository は clock、entropy、crypto、metrics の port interface にだけ依存し、root assembly が browser/Release A adapter を注入する。低層 store から metrics backend を直接 import しない。

### 22.2 目標構成

```text
src/persistence/
  index.ts
  database.ts
  schema.ts
  transactions/
    transactionCoordinator.ts
    transactionCapabilities.ts
  stores/
    appDataStores.ts
    mapDataStores.ts
    syncControlStore.ts
  repositories/
    appDataRepository.ts
    mapDataRepository.ts
    backupRepository.ts
    controlRepository.ts
  migration/
    migrator.ts
    legacyCleanupService.ts
    legacyLocalStorageAdapter.ts
  recovery/
    recoveryService.ts
    recoveryExport.ts
  resilience/
    validators.ts
    serializers.ts
    reconcile.ts
    identityFactory.ts
  ports/
    clockPort.ts
    entropyPort.ts
    cryptoPort.ts
    persistenceMetricsPort.ts
```

### 22.3 `syncQueue` と transaction

- queue payload と control record は既存 stored field を読む in-memory type guard で論理分離する。persisted record へ discriminant field を追加せず、物理 `syncQueue` store の名前、key、record shape を変えない。
- metadata/checkpoint、migration journal/archive、control record の access source of truth は `syncControlStore.ts` にする。
- 10 個の app payload store と物理 `syncQueue` store にまたがる atomic write は `transactionCoordinator` だけが開始する。
- repository が別 transaction を暗黙開始しない。
- app data restore は現行 10 app stores を対象とし、`syncQueue` 本体を復元しない。
- migration/recovery の crash point ごとに reopen test を持つ。

### 22.4 Cleanup と resilience

- `persistenceCleanupCoordinator.ts` は判断と lock 調停を維持する。
- `migration/legacyCleanupService.ts` は現 `executePhysicalLegacyCleanup` の journal/archive、target validation、entry claim、CAS、readback、crash resume、直前 revalidation を維持する。
- `migration/legacyLocalStorageAdapter.ts` は exact legacy key の read/remove だけを持つ。service は IndexedDB control data を使うが IndexedDB 自体を削除しない。
- 既存 `db.cleanupLegacyPersistenceSources` public method は service への compatibility delegate として維持する。
- 既存 `src/utils/persistenceResilience.ts` の deterministic validator/serializer/reconcile を複製せず対応する pure module へ move し、compatibility re-export を残す。
- `Date.now`/`new Date`、`Math.random`、`crypto.getRandomValues`/`randomUUID` を使う writer ID/revision/candidate factory は `identityFactory.ts` へ分離し、`ClockPort`、`EntropyPort`、`CryptoPort` を inject する。既存 ID/revision format と ordering を golden test で維持する。
- pure resilience module は DB、React、clock、entropy、crypto へ依存しない。
- recovery service は pure helper と repository を組み立てる。
- 現 `indexedDB.ts` が emit する Release A metrics は `PersistenceMetricsPort` へ移し、event name、順序、count、`buildId=sourceSha` payload を golden sequence test で維持する。
- Release B entry point、production proof provider、kill switch は追加しない。

### 22.5 Facade

`src/persistence/index.ts` を canonical facade、既存 `src/utils/indexedDB.ts` を compatibility shim とする。compatibility shim は既存 default/named export と型を re-export するだけとし、新しい実装 entry point にしない。

facade の内容を次に限定する。

- public type/constant の re-export
- compatibility alias
- dependency assembly
- public repository/service factory

SQL/IDB request、transaction logic、migration、business rule を facade に置かない。

### 22.6 合格条件 `P7-IDB`

- database/schema/store/key/version の byte/semantic compatibility test が通る。
- `DB_NAME="EventShoppingPlannerDB"`、version 5、forward max 7、既存 store/key catalog が exact 一致する。
- 既存 fixture を新実装で open、save、restore、reopen できる。
- 全 cross-store atomicity と crash recovery test が通る。
- `syncQueue` control record を失わない。
- cleanup journal/CAS/crash-resume と Release A metrics event sequence が一致する。
- public import の compatibility を維持する。
- `indexedDB.ts` compatibility shim に非許可実装がない。
- Release B は hard OFF。

行数は参考値とし、依存方向、transaction owner、facade 内容、互換 test を blocking 条件にする。

## 23. 継続 lint 削減

lint cleanup は各 phase の主リスクと混ぜず、小さな独立 PR で行う。

優先順:

1. unused vars と dead import
2. no-useless-escape、prefer-const
3. no-explicit-any
4. exhaustive-deps
5. 既存 disable と `@ts-expect-error`

exhaustive-deps は dependency を機械追加せず、effect の責務、stable callback、event callback、state machine へ分解する。既存 suppression を残す場合は理由と behavior test を追加するが、新規 suppression は追加しない。

合格条件 `LINT-ZERO`:

- error 0、warning 0
- inline disable 0、または削除不能な generated/vendor allowlist だけ
- `@ts-ignore` 0
- `@ts-expect-error` は実際に error が消えると test failure になる
- baseline file は空、または allowlist だけ

## 24. Rollout、観測、停止

### 24.1 Variant

build input catalog は実装が存在する期間だけ次の値を受理する。

| Dimension            | 値                     | Production/build policy                                                                                   |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `pwaUpdateMode`      | `legacy-auto`          | P1D 前の baseline/transition fixture 専用。bridge activation 後は production build/deploy を拒否          |
|                      | `prompt-close-all`     | P1D bridge と各 asset/security floor で更新する PWA fallback。page の APPLY UI だけ無効                   |
|                      | `prompt`               | P1D 後の canonical production                                                                             |
| `tailwindDelivery`   | `cdn`                  | P2A まで。P2A source merge 後は新規 build を拒否し、P2B までは保存済み fallback だけ保持                  |
|                      | `local`                | P2A 後の canonical production                                                                             |
| `xlsxExecution`      | `main`                 | Phase 4 rollout 中の paired fallback。M2 後は新規 build を拒否し、保存済み package だけ保持               |
|                      | `worker`               | Phase 4 後の canonical production                                                                         |
| `listRendererMode`   | `full-only`            | Phase 5 rollout 中の paired fallback。保存済み package は virtual preference を強制無効                   |
|                      | `dual-default-full`    | Phase 5 QA/canary 専用                                                                                    |
|                      | `dual-default-virtual` | Phase 5 後の canonical。M2 後は build-time default flag を削除し、同じ default と runtime a11y preference |
| `persistenceCleanup` | `release-a-off`        | 唯一の許可値                                                                                              |

`verify:variant-policy` は phase、release channel、source capability に対する valid combination を descriptor 生成前に検査し、retired implementation を source から復活させる build を拒否する。

同じ source SHA でも variant ごとに `buildInputId` と package ID が異なる。

既存 persistence metrics は `buildId=sourceSha` 集約のまま維持し、variant 比較や M2 の採否には使わない。本計画の variant 観測は deployment ID、package ID、browser test evidence、incident 記録で行う。metrics schema を将来拡張する場合は Release A evidence v1 と別の versioned migration/contract とする。

### 24.2 Rollout 単位

- PWA prompt: Phase 1D で bridge → prompt の二段階 floor
- Tailwind: 2A local floor、2B cleanup の二 release
- XLSX: Worker OFF/ON paired package
- list: full-only/dual paired package
- App/IDB 分割: feature flag ではなく characterization contract を維持する package

Phase 5 から M2 removal PR の直前まで、shared App/persistence を変更する PR と production candidate は次の四 package を同じ source から検査・保存する。

1. Worker + dual-default-virtual
2. main-thread XLSX + dual-default-virtual
3. Worker + full-only
4. main-thread XLSX + full-only

Phase 4 までは変更領域に応じた ON/OFF pair、Phase 1 は legacy transition fixture + bridge + prompt、Phase 2 は保存済み CDN floor → local の transition を required matrix とする。`quality:pr` は変更領域から required variant を機械選択し、`quality:artifact` は production candidate と全 paired fallback を検査する。

M2 removal 後、Phase 7 source から保存した最終四 package は `phase-floor package` として扱う。M2 source の main-thread adapter/default-selection は既に存在しないため、M2 candidate と同一 source の paired fallback を build 要求しない。M2 gate は canonical Worker + dual-default-virtual candidate と、保存済み Phase 7 floor 間の transition/restore/hash を検証する。

### 24.3 共通 production promotion gate

`P1D-FLOOR`、`P2A-LOCAL`、`P2B-CACHE`、`P3-CSP`、`P4-XLSX` rollout、`P5-LIST` rollout、`P6-APP`、`P7-IDB`、M2 package はすべて次を順に通す。

1. candidate と phase 時点で有効な paired fallback の `quality:artifact`、live audit、waiver freshness を確認する。M2 は保存済み Phase 7 floor の hash/restore evidence を代わりに使う。
2. `release:preflight` で env/migration/provider prerequisite と rollback floor を確認する。
3. production project に domain 未切替の immutable candidate deployment を一度だけ作る。
4. 全 static bytes/header、function provenance、API、package/deployment identity を照合する。
5. Release/Data Safety/Operations のうち変更リスクに必要な二者が同じ deployment ID を承認する。
6. 再 deploy せず、その deployment ID を production alias へ昇格する。
7. production URL から全 identity/header と installed-PWA transition を再照合する。
8. 最低 24 時間観測し、新しい immutable evidence fragment を生成して final evidence を確定する。

観測中に停止条件へ達した場合は alias を承認済み prompt-compatible floor/paired package へ切り替える。PONR 後に legacy-auto へ戻さない。phase exit はこの共通 gate の final evidence なしに完了しない。

### 24.4 M2 観測 ADR

Phase 4/5 の rollout flag 削除前に ADR を作成し、次を具体値で埋める。

- 暦日 14 日以上
- 連続 production candidate 2 件以上
- Tier 1 全 required run 各 5 回以上
- Tier 2 対象 device/browser 各 2 回以上
- 再現可能な data loss、reload loop、chunk skew、操作不能 incident 0
- stop condition と rollback package
- evidence 保存先
- Release/Data Safety/Operations owner
- 日次確認頻度、alert 経路、go/stop 権限
- incident evidence の保存先

存在しない Worker/virtual 利用率や本番 failure rate を条件にしない。

### 24.5 即時停止条件

次のいずれかで promotion を停止し、承認済み package を再 deploy する。

- data loss、restore failure、schema mismatch
- PWA reload loop、multi-tab update、blocker 無視
- package と provider bytes/header の不一致
- CSP による主要操作不能
- XLSX output semantic mismatch、resource limit bypass
- scroll/focus target miss、keyboard 操作不能
- audit の新規 reachable critical/high
- evidence、package、migration prerequisite の欠落

rollback 後も DB schema を戻さない。前方互換 floor を満たす package だけを選ぶ。

## 25. Milestone

### M0: 配布安全基盤

- `P0-BASELINE`
- `P0-TOOLCHAIN`
- `P0-BROWSER`
- `P0-ARTIFACT`
- `P1D-FLOOR`
- `P2A-LOCAL`
- `P2B-CACHE`
- `P3-CSP`

### M1: 性能基盤

- `P4-XLSX` を既定 ON、paired-fallback 保存済み
- `P5-LIST` を既定 ON、full renderer 恒久 fallback
- 14 日観測を開始できる

### M2: 計画全体完了

- Phase 0～7 の全 exit 条件
- `LINT-ZERO`
- M2 観測 ADR の条件達成
- Phase 7 完了 source から四 variant の最終 paired package を保存・復元検証
- XLSX rollout 専用 main-thread adapter を削除
- virtual list の rollout default-selection 分岐を削除
- M2 candidate と保存済み Phase 7 package の transition を検証し、後者を phase-floor package へ分類
- full renderer と a11y fallback を維持
- rollback package、evidence、runbook、restore drill が有効

## 26. PR 順序

| 順序 | 主リスク                             | Production promotion   |
| ---: | ------------------------------------ | ---------------------- |
|    0 | auto-deploy/approval guard           | 最初の source merge 前 |
|    1 | clean baseline capture               | 現行配布を維持         |
|    2 | capture script/schema と EOL policy  | 禁止                   |
|    3 | Node/npm/types                       | 禁止                   |
|    4 | Vite/plugin                          | 禁止                   |
|    5 | Vitest/projects                      | 禁止                   |
|    6 | PWA/Workbox dependencies             | 禁止                   |
|    7 | ESLint flat config/baseline mapping  | 禁止                   |
|    8 | Playwright/a11y                      | 禁止                   |
|    9 | coverage/architecture                | 禁止                   |
|   10 | build identity/manifest              | 禁止                   |
|   11 | budget/graph verifier                | 禁止                   |
|   12 | complete package/provider verifier   | 禁止                   |
|   13 | QA custom Worker parity              | 禁止                   |
|   14 | startup/root boundary/blocker        | 禁止                   |
|   15 | single-client permit                 | 禁止                   |
|   16 | multi-client/lifecycle lock          | 禁止                   |
|   17 | transition matrix/evidence           | canary のみ            |
|   18 | prompt production floor              | 承認後のみ             |
|   19 | local Tailwind CSS                   | 承認後のみ             |
|   20 | old Tailwind cache cleanup           | 承認後のみ             |
|   21 | CSP                                  | 承認後のみ             |
|   22 | XLSX contracts/helper split          | behavior-equivalent    |
|   23 | XLSX Worker adapter                  | default OFF            |
|   24 | XLSX Worker rollout                  | canary → ON            |
|   25 | viewport port/row model              | behavior-equivalent    |
|   26 | virtual renderer                     | default full           |
|   27 | virtual rollout                      | canary → virtual       |
|   28 | `App.tsx` responsibility extraction  | contract-preserving    |
|   29 | IndexedDB stores/transactions        | contract-preserving    |
|   30 | IndexedDB repository/recovery/facade | contract-preserving    |
|  31+ | lint category cleanup                | behavior-equivalent    |
| 最終 | M2 rollout branch cleanup            | 観測条件後             |

## 27. Phase exit matrix

| Exit ID           | 必須 gate                                                       | Rollback                                                    |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `P0-BASELINE`     | baseline hash、auto-promotion guard                             | current production                                          |
| `P0-TOOLCHAIN`    | runtime、typecheck、unit、audit、build                          | N/A: source PR を revert、current production package を維持 |
| `P0-BROWSER`      | E2E、a11y、coverage、architecture                               | N/A: source PR を revert、current production package を維持 |
| `P0-ARTIFACT`     | deterministic build、complete package、QA provider parity       | N/A: source PR を revert、current production package を維持 |
| `P1A-PARITY`      | QA transition/offline/navigation                                | N/A: source PR を revert、current production package を維持 |
| `P1B-PROMPT`      | startup、root boundary、blocker                                 | N/A: source PR を revert、current production package を維持 |
| `P1C-MULTICLIENT` | permit、locks、cleanup contract                                 | N/A: source PR を revert、current production package を維持 |
| `P1D-FLOOR`       | transition、provider、二段階 24h、promotion gate                | P2B 前は bridge、以後は同じ floor の close-all/fix-forward  |
| `P2A-LOCAL`       | visual、offline、network、CSS budget、promotion gate            | P1D floor。P2B 後は P2A local floor                         |
| `P2B-CACHE`       | exact cleanup、offline、transition、promotion gate              | P2A local floor                                             |
| `P3-CSP`          | enforced CSP/header/provider、promotion gate                    | 最新の prompt-compatible local-CSS floor                    |
| `P4-XLSX`         | semantic、resource、performance、paired package、promotion gate | Worker OFF pair                                             |
| `P5-LIST`         | behavior、a11y、performance、paired package、promotion gate     | full-only pair                                              |
| `P6-APP`          | responsibility、race、integration、promotion gate               | prior accepted four-variant package                         |
| `P7-IDB`          | schema、transaction、recovery、facade、promotion gate           | prior forward-compatible four-variant package               |
| `LINT-ZERO`       | lint/disable baseline empty、promotion gate                     | prior accepted package                                      |

上位 milestone はこの表の exit ID を参照し、同じ受入条件を別の意味で再定義しない。

## 28. 全体完了条件

次のすべてを満たした時だけ本計画を完了とする。

1. M2 の条件を満たす。
2. production は保存済み release package からのみ配布され、source merge が自動 production promotion を起こさない。
3. page、active Worker、waiting Worker、provider package の identity を追跡できる。
4. PWA update は blocker、multi-tab、pre-floor、Worker restart の全失敗系で fail-closed になる。
5. Tailwind CDN、旧 Tailwind runtime route/cache、inline script がない。
6. enforced CSP と header/cache policy が local/provider で一致する。
7. ExcelJS は page client 初期 graph に含まれず、XLSX resource limit が二重適用される。
8. virtual/full renderer の両方で操作・a11y が成立する。
9. `App.tsx` と persistence が定義した責務・依存方向を満たす。
10. IndexedDB と Release A の data safety contract が維持される。
11. lint warning 0、required quality gate が green である。
12. package、detached hash、evidence、runbook、rollback drill が保管期限内である。

## 29. 実装時に参照する正本

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `vitest.config.ts`
- `tsconfig*.json`
- `index.html`
- `vercel.json`
- `src/index.tsx`
- `src/App.tsx`
- `src/features/app-shell/components/AppMainContent.tsx`
- `src/components/ShoppingList.tsx`
- `src/hooks/useIndexedDbPersistence.ts`
- `src/utils/indexedDB.ts`
- `src/utils/persistenceCleanupCoordinator.ts`
- `src/utils/persistenceResilience.ts`
- `src/utils/persistenceRecoveryExport.ts`
- `src/utils/xlsxMapParser.ts`
- `src/utils/exportImport.ts`
- `src/features/events/exportFlow.ts`
- `src/components/map/MapImportDialog.tsx`
- `src/components/BackupRestoreDialog.tsx`
- `src/components/ExportOptionsDialog.tsx`
- `api/persistence-release-a-metrics.mjs`
- `supabase/migrations/20260803000000_persistence_release_a_metrics.sql`
- `scripts/verify-release-a-build.mjs`
- `scripts/verify-release-a-browser.mjs`
- `scripts/verify-release-a-evidence.mjs`
- `scripts/rehearse-release-a-rollback.ps1`
- `.gitattributes`
- `.prettierrc.json`
- `docs/persistence-recovery-runbook.md`
- `docs/Resilient Persistence & Safe Migration Plan.md`
