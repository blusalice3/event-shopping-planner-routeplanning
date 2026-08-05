# Web アプリ基盤 実装計画

- 対象リポジトリ: `event-shopping-planner-routeplanning`
- 実装照合日: 2026-08-05
- 実装 tree 照合基準: `806794df6222053235139e7ef6684f4aa6538b3d`
- 注記: 上記以後の commit は本計画文書だけを変更している。package の `sourceSha` は静的な計画値ではなく、各 build の clean checkout から取得する
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
- browser から Supabase へ直接接続する client の導入
- 利用者行動を収集する新規本番テレメトリ
- WebKit を Tier 1 の blocking browser にすること
- virtual list の full renderer 自体を削除すること
- IndexedDB の schema version、database 名、store 名、key、意味、復旧対象の変更

既存 Release A metrics の API/schema 契約固定、service credential の hardening、live schema 検証、raw event retention は運用基盤の保全であり対象内とする。製品データモデルの変更とは扱わない。

対象外の作業が必要になった場合は、本計画の受入条件へ混在させず、独立した ADR と計画で扱う。

## 3. 照合済みの実装現状

### 3.1 アプリケーションと配信

- React Router は使っておらず、`src/index.tsx` から一つの React root を起動する SPA である。
- 非 `api/` path は `vercel.json` により `/index.html` へ rewrite される。
- active な認証/session UI はない。
- active な外部処理は同一 origin の `POST /api/persistence-release-a-metrics` である。
- `api/persistence-release-a-metrics.mjs` は Supabase へ送信し、migration は `supabase/migrations/20260803000000_persistence_release_a_metrics.sql` である。
- metrics API は POST-only、request body 上限 1 KiB、exact schema、成功時 202 の契約を持つ。
- `src/lib/supabase.ts` と `src/lib/database.types.ts` は entry graph から未参照である。後者は metrics migration を表さない stale な sharing prototype であり、現在の repository DB schema の正本ではない。
- `@supabase/supabase-js` は上記 dormant file からだけ参照され、現在の page bundle には入らない。
- `src/index.tsx` に root Error Boundary はない。
- raw metrics table には retention/purge がなく、24 時間 view だけでは保持期間を制限できない。

### 3.2 PWA

- `vite.config.ts` は `vite-plugin-pwa` の `generateSW` を使用する。
- `registerType: "autoUpdate"`、`skipWaiting: true`、`clientsClaim: true` であり、利用者の許可なしに更新世代が切り替わり得る。
- runtime caching は Tailwind CDN の `CacheFirst` と `https://*.supabase.co` の `NetworkOnly` を持つ。
- `release-capabilities.json` と `release-capabilities.<buildId>.json` の `buildId` は source SHA である。
- 現行 capability manifest に `pwaUpdateMode` はなく、旧 consumer と新 verifier の判定規則がまだ存在しない。
- `build:release-a` は cleanup capability を強制的に OFF にする。
- 現在の `build` は常に `vite build --mode release-a` を実行する。
- 現行 browser verifier は固定した Playwright browser ではなく、環境内の Chrome/Edge を探索する。
- 現行 rollback rehearsal は旧 commit を現在の `node_modules` で再 build するため、immutable rollback ではない。

### 3.3 HTML、CSS、CSP

- `index.html` は version 未固定の Tailwind CDN script、inline Tailwind 設定、inline style、theme 初期化 script、loading/viewport script を含む。
- `vercel.json` に CSP はない。
- production entry graph の JSX `style={...}` は 101 箇所、test 内は 2 箇所、build 除外の `FocusMode_backup.tsx` は 2 箇所である。加えて production code には `.style.*` による CSSOM mutation があり、JSX 件数だけでは CSP sink を表せない。
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
- `ActiveTab` 型が複数箇所にあり、どちらも `string` を含むため実質的に非制限である。event 名由来の tab と予約画面名が衝突でき、shell へ raw setter が多く渡される。
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

`.github/workflows`、Playwright config、`@playwright/test`、`@axe-core/playwright`、`@vitest/coverage-v8` はまだ存在しない。現 `vitest.config.ts` は既定 `node` environment を使い、`*.integration.tsx` だけを jsdom に割り当て、他の DOM test は file annotation に依存する。

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
- Web 基盤 capability manifest v2 は `pwaUpdateMode` を必須 field とする。既存 v1 または field 欠落は verifier が `legacy-auto` とだけ解釈し、`prompt` と推測しない。
- `release-capabilities.json` と既存 `release-capabilities.<sourceSha>.json` は Release A consumer 互換用、`release-capabilities.<buildInputId>.json` は variant 固有の immutable manifest とする。

### 4.3 Rollback package

用語を次の三つに限定する。

- `previous-production package`: 現在 production で配信中の完全 package。
- `phase-floor package`: 後続 phase が依存できる、受入済みの最小互換世代。
- `paired-fallback package`: Worker/full renderer など、同じ source とデータ契約で機能 flag だけを OFF にした受入済み package。

rollback は source を checkout して再 build する操作ではない。保持中の immutable deployment へ production alias を戻すことを第一選択とし、provider 側 deployment が失効した場合だけ、保存済み prebuilt package を byte-for-byte 再 deploy して全 hash と identity を再照合する。

### 4.4 PWA の安全用語

- `pageBuildInputId`: 現在読み込んだ HTML/app bootstrap の `buildInputId`。
- `controllerWorkerBuildInputId`: `navigator.serviceWorker.controller` が message 応答で返す `buildInputId`。
- `registrationActiveWorkerBuildInputId`: `registration.active` へ直接送った message 応答の `buildInputId`。
- `installingWorkerBuildInputId`: `registration.installing` が存在する場合の message 応答 `buildInputId`。
- `waitingWorkerBuildInputId`: waiting Worker が返す `buildInputId`。
- `protocolVersion`: page と Worker の message protocol version。
- `point of no return`: `skipWaiting()` 要求後、registration が candidate を `activating` として観測した時点。同期 throw/reject 後に candidate が waiting のまま、旧 active が不変と再検証できた場合は pre-PONR failure とする。timeout や観測矛盾は `COMMIT_STATE_UNKNOWN` として PONR 後と同じ hold を適用する。
- `blocker`: reload/update を行うと利用者の未確定状態を失う可能性がある状態。
- `fail-closed`: 安全性を証明できない限り更新、cleanup、reload を実行しない状態。

PONR 後の下位状態は `ACTIVATING | ACTIVATED | ACTIVATION_FAILED`、判定不能は `COMMIT_STATE_UNKNOWN` とする。これらでは mutable App への復帰や legacy-auto rollback を許可しない。明示的に再検証できた pre-PONR failure だけが shared presence を再取得して旧 App へ戻れる。

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
12. PWA、Tailwind、XLSX、virtual list の rollout flag は build-time flag とし、利用者データへ保存しない。full/virtual の利用者選択だけは versioned UI preference として `localStorage` に保存し、event/IndexedDB data へ混ぜない。
13. 破壊的 cleanup は exact allowlist の resource だけを対象とする。
14. build process が読む env key は allowlist に限定し、metrics URL/key を含む server-only secret を Vite process へ渡さない。
15. 既に適用された DB migration は変更しない。差異修復と retention は常に新しい forward migration で行い、rollback で DB schema を戻さない。

## 6. Artifact、provider、evidence の設計

### 6.1 Canonical build input descriptor

`scripts/build/createBuildInputDescriptor.mjs` を正本とし、少なくとも次を canonical JSON へ含める。

- schema version
- `sourceSha`
- `package-lock.json` SHA-256
- Node、npm、Vite、plugin、TypeScript の exact version
- canonical build OS、architecture、container image digest
- provider CLI の exact version と required managed function runtime family
- variant catalog ID と、その phase で有効な全 rollout flag
- allowlist 済み public build env の key/value。ただし descriptor から生成する `buildInputId` 自身は除外する
- `vite.config.ts`、`vitest.config.ts`、`vercel.json`、route/response/provider policy の hash
- static asset generator の version と入力 hash
- metrics v1 contract、version 順の required migration set、期待する live schema fingerprint の path/hash
- Build Output API generator と package schema の hash

`vite.config.ts` の `loadEnv(..., "")` は廃止し、catalog に列挙した public key だけを読む。`VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、metrics service URL/key、provider token、DB credential は public build input にせず、canonical build job に渡さない。

descriptor を canonical UTF-8、BOM なし、LF、key sort で serialize し、その SHA-256 を `buildInputId` とする。descriptor 確定後に Vite `define` 相当で ID を注入し、`import.meta.env` を介して descriptor 自身へ戻さない。

canonical build は clean detached checkout だけを受理し、tracked/untracked/ignored build input の不足を拒否する。`TZ=UTC`、locale、`SOURCE_DATE_EPOCH` を source commit time に固定し、生成物への wall-clock timestamp、random ID、absolute path を禁止する。variant ごとに空の `out/artifacts/<buildInputId>/` を作り、既存 path、同一 `buildInputId` の再利用、共有 `dist` 上書きを拒否する。

### 6.2 App と Worker の identity

同じ `buildInputId` を次へ生成時注入する。

- `index.html` の immutable meta
- app bootstrap の compile-time constant
- custom Service Worker の response payload
- `dist/build-identity.json` と `dist/build-identity.<buildInputId>.json`
- `dist/release-capabilities.<buildInputId>.json`

startup は HTML、bootstrap、variant capability と、存在する controller/registration.active/installing/waiting Worker の public identity を `buildInputId`/protocol まで別 field で照合する。public identity manifest は `schemaVersion`、`sourceSha`、`buildInputId`、`protocolVersion` だけを持ち、content/archive/package hash を持たない。capability manifest v2 はこれらに `pwaUpdateMode` と phase で必要な capability だけを加える。`releasePackageId` と `deploymentId` は immutable `dist` 生成時には未確定であり、package/deploy 後に public manifest へ後付けしない。package/deployment binding と provider gate は外部 verifier と detached evidence だけが検証する。既存 `sourceSha` は別 field として残し、`buildInputId` へ名称変更しない。

### 6.3 Artifact manifest

build 後に `dist` 外へ detached `artifact-manifest.json` を一つ生成する。

- public identity/capability manifest を含む全 `dist` payload file の path、media type、size、SHA-256
- payload tree から算出した `artifactContentHash`
- precache entry と size
- entry chunk、lazy chunk、Worker chunk の logical graph
- expected response header/cache policy
- canonical static archive の path、size、`artifactArchiveHash`
- `.vercel/output` の全 member と `providerBundleHash`

static archive は `dist` payload だけを含み、detached artifact manifest、signature、evidence は含めない。archive の path separator、entry 順、mode、uid/gid、mtime、compression algorithm/level を固定する。

既存 `release-capabilities.json` と `release-capabilities.<sourceSha>.json` は、Release A consumer と保存済み package のサポート期間中は維持する。後者は同じ source の variant 間で bytes が変わり得るため immutable URL とみなさない。既存 consumer を先に dual-read 対応し、Release A verifier/runbook が generic manifest 非依存で動くことを保つ。既存 verifier 内で source SHA を指す変数は `sourceBuildId` へ改名し、generic `buildInputId` と混同しない。

### 6.4 完全 release package

`scripts/build/createVercelOutput.mjs` が Vercel Build Output API v3 を生成する唯一の owner となる。入力は検証済み `dist`、bundled function、`config/route-policy.json`、`config/response-policy.json`、`config/provider-policy.json` であり、出力は少なくとも次とする。

```text
.vercel/output/
  config.json
  static/
  functions/
    api/persistence-release-a-metrics.func/
      .vc-config.json
      index.mjs
      <bundled dependencies>
```

`.vc-config.json` は `runtime: "nodejs24.x"`、`handler: "index.mjs"`、`launcherType: "Nodejs"` を持つ。`config.json` の route/header と `vercel.json` は同じ policy file から生成するか、生成結果との exact 差分検査を必須とする。`vercel deploy --prebuilt` は保存済み `.vercel/output` 以外を受理せず、provider build を起動しない。

release package は次を含む。

1. canonical static artifact archive
2. 上記 `.vercel/output` 全体と `providerBundleHash`
3. bundled metrics function、source provenance、dependency/runtime hash
4. `vercel.json` と route/response/provider policy
5. required managed function runtime family、provider CLI、project 設定 version
6. required env key 名と validation rule
7. 期待する WAF、rate-limit、same-origin/cross-origin rejection policy
8. required migration set の各 path/version/hash、metrics v1 contract、期待する live schema fingerprint
9. build input descriptor
10. detached artifact manifest
11. compatibility capabilities manifest
12. build 時点の variant catalog/schema snapshot と、その versioned read-only decoder の識別子

production の required env は `PERSISTENCE_METRICS_ALLOWED_ORIGIN`、non-secret の `PERSISTENCE_METRICS_SUPABASE_PROJECT_REF`、専用 pair の `PERSISTENCE_METRICS_SUPABASE_URL` と `PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY`、non-secret の `WEB_FOUNDATION_RELEASE_PACKAGE_ID` である。legacy generic pair は Phase 0C の previous-production/QA characterization だけで、専用 pair が両方不在の時に限り受理する。`P1D-BRIDGE` preflight は production project で専用 pair の存在と generic pair の不在を要求し、partial、mixed、conflicting configuration は 503/promotion failure とする。generic fallback branch は保存済み legacy fixture の verifier には残すが、新 production package の runtime branch から P1D で削除する。deployment ID は user env へ後付けせず、provider system env の `VERCEL_DEPLOYMENT_ID` を runtime で読む。secret 値、service role key、利用者データ、実環境の presence/status は package と log に含めない。

package descriptor は全 payload member の path、size、SHA-256 を列挙し、descriptor 自身を member hash 一覧から除外する。その canonical descriptor から `releasePackageId` を算出して descriptor へ格納する。`outerPackageHash` は descriptor を含む package archive 全体から算出し、archive 内へ書き戻さず detached release index にだけ保存する。

実環境の env presence/version reference、migration status、provider/WAF resolved rule/job ID・version・state、deployment ID、generic evidence、Release A evidence 参照は package ID 確定後の環境別 detached evidence hash-chain に置く。これら環境固有 ID を build input、logical policy、release package へ入れない。

package archive も path separator、entry 順、mode、uid/gid、mtime、compression algorithm/level を固定する。観測時刻、承認時刻、upload URI は detached evidence にだけ持たせる。

### 6.5 Canonical build 環境

- production candidate は x64 Linux の digest 固定 container、Node `24.19.0`、npm `11.19.0` で一度だけ build し、その一つだけを package/deploy する。
- reproducibility qualification は toolchain/packager 変更時に固定 fixture または同一 clean commit を別 output path へ二回 buildして比較する独立 job とする。比較用 output は production package として配布しない。
- Windows job は PowerShell、encoding、browser、path 固有の検査を担当し、production artifact を再 build しない。
- provider の Node 24 build/function 対応を Phase 0 の hard gate とする。managed function は `nodejs24.x` family を要求し、provider が管理する patch version を package identity へ固定しない。
- `verify:runtime` は local/canonical build の Node/npm を exact 検証し、provider は runtime family を検証する。managed function は cold start ごとに request/body/env secret を含まない structured runtime attestation として deployment ID、function logical name、provider region、`process.version`、runtime family を provider log へ一度だけ出す。`verify:provider` は既知の 405 request ID で invocation を発生させ、provider API/log から deployment/region に対応する attestation を取得・hash 化し、許容 Node 24 patch を判定する。log 取得不能や対応不明は promotion failure とする。
- `package.json` は `packageManager: "npm@11.19.0"` と `engines.node: "24.x"`、provider project setting は Node 24.x を要求する。canonical exact version、managed major、実行時 resolved patch を別々に検証し、いずれかの不一致を fail とする。
- scheduled provider observation は新しい cold-start attestation の patch を前回 evidence と比較する。provider による patch 更新時は同じ deployment/全 region の API contract を再監査し、allowlist 外または未監査 patch では次の promotion と finalization を停止する。

### 6.6 Provider 同一性

保存済み package を prebuilt deploy し、provider が app bundle を再構築しない経路を正本とする。

package ID は deployment 作成時に runtime env `WEB_FOUNDATION_RELEASE_PACKAGE_ID` として渡す。provider project の System Environment Variables 公開を prerequisite とし、function は runtime の `VERCEL_DEPLOYMENT_ID` を読む。deployment 作成後に deployment ID を user env へ書き戻さない。

deployment 後に provider API の `deploymentId` と package を結び、次を外部 URL から取得して manifest と照合する。

- artifact manifest にある全 public static file の bytes/hash
- 全 public route/resource の security/cache header
- Service Worker 経由と network bypass の response
- provider deployment API の function bundle/runtime/config provenance
- metrics response の `X-Release-Package-Id` と `X-Deployment-Id`
- resolved route/WAF/rate-limit rule ID、version、state

function が生成する 202/400/403/405/413/415/502/503 の全 response に二つの identity header を付ける。package ID は lowercase SHA-256 64 hex、deployment ID は provider API が返した `dpl_` prefix の opaque ID と exact 一致を要求する。値が欠落または format 不正なら header 値を `unavailable` とし、既存 status/body contract は変えないが provider verification と promotion は必ず失敗させる。provider WAF が function より前に返す 403/429/413 は provider-owned response とし、identity header を要求しない。function bundle へ deployment ID を埋め込まない。

API の single-origin 契約上、domain 未切替 candidate URL と昇格後 production origin の正当 POST を同じ immutable deployment で同時に成功させることはできない。検証を次の三段階に分ける。

1. 専用 QA origin/backend: QA origin を `PERSISTENCE_METRICS_ALLOWED_ORIGIN` に設定し、exact-schema POST 202、DB row 到達、foreign-origin 403、limit 未満/超過、Origin spoof、巨大 body を検証する。
2. domain 未切替 production candidate: GET 405、foreign-origin POST 403、function hash/provenance、identity header、final production origin env の設定値を read-only 検証する。candidate URL から正当 POST 202 を要求しない。
3. alias 昇格直後: production origin から invalid-schema POST 400 と DB row 非生成を確認する。続いて controlled installed-PWA startup が通常の valid v1 event を一件送信し、202、current package/deployment identity header、verified function の upstream success path、bounded ingestion observation function の candidate `sourceSha`/tuple/count 増分を同じ時間窓で照合する。raw row は evidence へ保存しない。

repository には Release A evidence template しかないため、検証済み external immutable baseline evidence URI/hash が提示されるまで `P1D-BRIDGE`、`P1D-PROMPT`、その集約である `P1D-FLOOR` は blocked とする。この baseline prerequisite は各 alias 昇格後に current package/deployment へ束縛して取得する上記 valid-ingestion evidence の代用にしない。

一つでも static bytes/hash/header、function provenance、package/deployment identity、prerequisite が異なる場合は release を失敗させる。

#### 6.6.1 Metrics API contract と credential 境界

`contracts/persistence-release-a-metrics-v1.json` を request exact keys、event union、enum/reason、client→API→DB mapping の canonical contract とする。v1 は凍結し、将来の互換でない変更は v2 endpoint/schema/migration/evidence とする。client type、API validator、SQL constraint を canonical contract と exhaustive drift test で照合する。

function response contract は次に固定する。

| 条件                     | Status/body                                      | 追加 header   |
| ------------------------ | ------------------------------------------------ | ------------- |
| method 不正              | 405 `{ "error": "method-not-allowed" }`          | `Allow: POST` |
| backend/env 不正         | 503 `{ "error": "metrics-backend-unavailable" }` | なし          |
| same-origin 検査不合格   | 403 `{ "error": "forbidden" }`                   | なし          |
| content type 不正        | 415 `{ "error": "unsupported-media-type" }`      | なし          |
| body 上限超過            | 413 `{ "error": "request-too-large" }`           | なし          |
| JSON 不正                | 400 `{ "error": "invalid-json" }`                | なし          |
| schema 不正              | 400 `{ "error": "invalid-schema" }`              | なし          |
| upstream timeout/non-2xx | 502 `{ "error": "metrics-insert-failed" }`       | なし          |
| accepted                 | 202 `{ "accepted": true }`                       | なし          |

全 function response は JSON、`Cache-Control: no-store`、上記 identity header を持ち、raw Error、stack、request content、upstream body を返却・記録しない。`Origin` と `Sec-Fetch-Site: same-origin` は browser の cross-site/誤送信防止であり認証ではない。ACAO を返す cross-origin 成功や OPTIONS success を契約にしない。

`sendJson` と HTTP-level contract test は method、content type、oversize、malformed JSON、全 schema 値、upstream non-2xx/redirect/timeout、credential partial/mix、identity env 欠落/不正、WAF-owned response を網羅する。

project ref は `^[a-z0-9]{20}$`、Supabase URL は `https://${PERSISTENCE_METRICS_SUPABASE_PROJECT_REF}.supabase.co` の exact origin、userinfo/path/query/hash なしを要求し、localhost は local test だけで許可する。provider preflight は non-secret ref と対象 Supabase project ID を照合する。function `maxDuration` は 10 秒、upstream は `redirect: "error"`、`AbortSignal.timeout(5_000)`、retry なしとする。`vercel.json` と `.vc-config.json` の期待値を package test で一致させる。専用 service-role credential の project binding、secret version reference、rotation evidence を保持し、secret scanner で `.vercel/output`、release archive、log、evidence を検査する。

`config/provider-policy.json` は環境非依存の logical policy とし、metrics route の matcher、許可 method、body ceiling、per-IP burst/window、global cost ceiling、action、provider log field/retention、retention schedule specification を持つ。数値は Phase 0 baseline で最大の正当 event burst を測定して確定し、placeholder または未確定値では `P0-ARTIFACT` を通さない。QA/production の resolved rule/job ID、version、state はこの logical policy との対応を detached evidence で証明する。

#### 6.6.2 Route policy

`config/route-policy.json` を provider と Service Worker navigation fallback の正本とする。router は導入せず canonical UI navigation は `/` と baseline で確認した明示 path だけに限定する。HTML navigation request だけを `index.html` へ fallback し、`/api/**`、`/sw.js`、web manifest、identity/capability manifest、hashed asset、stable public asset を除外する。unknown JS/CSS/image/API/resource は HTML 200 ではなく正しい 404/405 と MIME を返す。

### 6.7 Cache-Control 正本

`config/response-policy.json` を header/cache policy の正本とする。

| Resource                                                                                                              | Cache-Control                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `index.html` と許可済み SPA navigation                                                                                | `no-cache, no-store, must-revalidate`                         |
| `sw.js` と legacy `registerSW.js`                                                                                     | `no-cache, no-store, must-revalidate`                         |
| `build-identity.json`、`release-capabilities.json`、`release-capabilities.<sourceSha>.json`                           | `no-cache, no-store, must-revalidate`                         |
| `manifest.webmanifest`、stable icon、日本語名 PNG、stable public asset                                                | `public, max-age=0, must-revalidate`                          |
| content-hashed JS/CSS/Worker/assets、`build-identity.<buildInputId>.json`、`release-capabilities.<buildInputId>.json` | `public, max-age=31536000, immutable`                         |
| metrics API の function response                                                                                      | `no-store`                                                    |
| provider-owned error/404                                                                                              | provider policy の明示値。成功 resource より長く cache しない |

local package server、provider URL、Service Worker cache、network bypass の各経路で status、MIME、bytes、header を検証する。

### 6.8 DB migration、schema、retention

`supabase` CLI `2.111.0` を exact devDependency とし、`supabase/config.toml` と local DB contract test を追加する。command を次に固定する。

| Command               | 権限と責務                                                                            |
| --------------------- | ------------------------------------------------------------------------------------- |
| `db:test:local`       | clean local DB へ全 migration を適用し、schema/RLS/grant/view/contract/retention test |
| `db:status:remote`    | 専用 read-only DB role による migration history                                       |
| `db:verify:remote`    | 専用 read-only DB role による catalog fingerprint と期待値比較                        |
| `db:apply:qa`         | isolated QA、protected credential                                                     |
| `db:apply:production` | protected environment、手動承認、単一 concurrency、DB migration operator 限定         |

remote verifier は apply/service-role credential と分離した `web_foundation_schema_verifier` 用 secret を protected environment に保持する。この role は login 時 default transaction read-only、短い statement timeout、`supabase_migrations.schema_migrations` と必要な catalog/view definition/grant metadata の SELECT だけを許可し、raw metrics row の SELECT/DML、retention health/ingestion observation 実行、DDL、migration repair、role change を許可しない。command は明示 `BEGIN READ ONLY`、current role/transaction mode の自己検査後に query し、credential version/rotation evidence を残す。retention/ingestion observer は別の `web_foundation_metrics_monitor` role/secret を使い、default transaction read-only、短い statement timeout、他 role membership なしで、後述の bounded health/observation function だけを実行できる。両 secret は独立 version/rotation evidence を持つ。

remote prerequisite は次の三証跡を別々に持つ。

1. package evidence: version 順の required migration set と各 relative path/version/SQL file SHA-256。
2. remote history evidence: set の全 version が同じ順序で applied であること。
3. live catalog fingerprint: columns/type/null/default、named constraints、indexes、identity sequence、RLS/policy、table/sequence/view/function grants、現行 3 view と retention/ingestion-observation function の正規化 definition hash、function owner/security/search_path、retention/monitor role attributes/membership、`pg_cron` logical job/schedule/command target/username/database/active。

management API が package 内 SQL file hash を返すとは仮定しない。`create ... if not exists` が drift を隠せるため、history だけで合格にしない。既存 `20260803000000_persistence_release_a_metrics.sql` は immutable とし、retention と差異修復は新 timestamp の forward migration にする。repair を作った場合は required set へ追加し、drift した production だけに適用せず、clean local → QA → production の全環境へ同じ順序で適用して history を分岐させない。apply failure は promotion を停止し、down migration や history repair だけで合格にしない。

raw event の retention cutoff は `received_at < now() - interval '30 days'` とする。scheduler owner は Supabase 内 `pg_cron` 一つに固定し、logical job 名 `persistence-release-a-metrics-retention-v1` を毎時 UTC 17 分に実行する。healthy state の保持上限は 30 日 + 1 時間未満とし、purge 後も cutoff 対象 row が残ること、job failure、前回成功から 2 時間超を blocking alert とする。

新しい forward migration は idempotent purge function、read-only health function、bounded ingestion observation function、cutoff/index/grant、`pg_cron` job specification を追加する。purge/observation function owner は NOLOGIN・NOBYPASSRLS・非 member の `metrics_retention_owner` とし、`public` schema の USAGE と対象 table の SELECT/DELETE だけを grant する。既存 RLS を迂回せず、同 role 限定の named SELECT/DELETE policy を新 migration で追加する。table ownership、service_role membership、BYPASSRLS、他 DML/DDL、`cron.*` access は与えない。

`cron.job` は作成 user 以外を RLS で隠すため、固定引数なしの health function だけは job 作成者である provider 管理 `postgres` が owner の `SECURITY DEFINER` とする。function body は logical job 名を literal で固定し、schema-qualified read-only SELECT だけ、dynamic SQL/引数/任意 job access なし、`SET search_path = pg_catalog`、短い statement timeout とする。definition/owner/ACL を live fingerprint へ含める。purge/observation function も `metrics_retention_owner` の `SECURITY DEFINER SET search_path = pg_catalog` と schema-qualified object を使う。purge executor は `postgres` cron role とし、PUBLIC/anon/authenticated/service_role から purge EXECUTE を revoke して `postgres` だけに許可する。一回 5,000 row、最大 20 batch/100,000 row または 20 秒まで反復し、残件数と最古 `received_at` を返す。

health function は logical job 一件の最終成功/失敗/時刻、job username/database/active、cutoff 対象件数、最古 `received_at` だけを返し、row content、任意 job、SQL command text を返さない。ingestion observation function は strict build ID/event tuple と最大 10 分の UTC window を typed parameter で受け、該当 count と min/max `received_at` だけを返す。dynamic SQL、row content、window 外 query を禁止する。両 function の PUBLIC/anon/authenticated/service_role EXECUTE を revoke し、default transaction read-only の `web_foundation_metrics_monitor` だけへ許可する。monitor role は raw table、view、`cron.*`、purge function へ直接アクセスできない。公開 HTTP endpoint は追加しない。`release:observe` は protected monitor secret で observation functionを poll し、protected hourly monitor は health function を検査する。backlog 時は DB migration operator が `postgres` として同じ bounded purge function を catch-up 実行して evidence を残す。

retention migration は current app/API と前方・後方互換にし、clean local → QA → production の順で適用する。production apply は直前 aggregate snapshot、remote fingerprint、`pg_cron` 利用可否、protected approval を要求し、app alias は変更しない。logical schedule は package、環境別 resolved job ID/state は detached evidence とし、監視 query が green になるまで完了扱いにしない。QA は `SET ROLE metrics_retention_owner` 相当で RLS policy を実通過させ、cutoff 対象だけの SELECT/DELETE、対象外 row 非削除、health の実 count、他 DML/DDL denial を検証する。monitor role では valid tuple/window の aggregate count、invalid build ID、10 分超 window、raw table/view/cron/purge denial を検査する。さらに cutoff 境界、再実行、partial batch/backlog/catch-up、schedule failure、3 view の継続性を検査する。

### 6.9 Evidence の段階

generic schema は `web-foundation-evidence/v1` とする。

1. `artifact evidence fragment`: build、test、hash、budget、variant。同期生成できる。
2. `deployment preflight evidence`: deployment ID、package 一致、header、API、WAF、migration history/live fingerprint prerequisite。
3. `observation evidence`: canary 期間、browser matrix、test 回数、incident、owner sign-off。
4. `release final evidence`: 上記三つへの参照と承認。

各 fragment は前段 fragment の immutable URI と SHA-256 を参照する新規 object として生成し、既存 object へ追記しない。artifact gate で 24 時間観測や Release A final evidence を生成しない。既存 Release A evidence v1 は別 validator で検証し、generic final evidence から参照する。

### 6.10 保管

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
3. update/cleanup 共通: `event-shopping-planner:pwa-client-presence`
4. cleanup のみ: 既存 `event-shopping-planner:persistence-legacy-cleanup`

Web Locks 対応 browser の互換 floor client は mutable App を mount する前に、世代にかかわらず 3 の同じ shared lock を取得・保持する。exclusive lock 保持中に開いた新 tab は compatibility hold に留まり、App を mount しない。世代別の lock 名にすると異なる controller 世代の tab を排他できないため禁止する。Web Locks 非対応 browser は capability を `close-all-only` として mount できるが、in-app APPLY/CLEANUP を一切許可せず、Worker の client 列挙には含める。

election と lifecycle は exclusive、presence は通常 shared/update 時 exclusive で取得する。update は次の state machine だけを許可する。

1. ambient shared presence を保持したまま election を `ifAvailable: true` で一度だけ取得する。この non-waiting lease だけを順序例外とする。
2. blocker を検査し、失敗時は shared presence を保持したまま election を解放する。
3. UI を freeze し、自身の shared presence を解放する。
4. shared presence を保持していない状態で lifecycle を AbortSignal 付き最大 5 秒で取得する。
5. lifecycle 保持中に exclusive presence を AbortSignal 付き最大 5 秒で取得する。
6. blocker と client set を再検査して permit protocol へ進む。

待機する election/lifecycle acquisition を shared presence 保持中に行うことを禁止する。persistence cleanup と active Worker cache cleanup を開始する client も freeze 後に shared presence を解放し、lifecycle → exclusive presence → 必要な場合だけ legacy-cleanup の順で取得する。これにより cleanup 中に新 tab が shared presence を取得して mutable App を mountする race と、lifecycle/presence の循環待ちを防ぐ。Web Locks に atomic downgrade はない。

point of no return 前に失敗した場合は次の順で復帰する。

1. election lock と UI freeze を維持する。
2. exclusive presence lock を解放する。
3. lifecycle lock を解放する。
4. shared presence lock を再取得する。
5. 再取得後にだけ UI freeze を解除する。
6. election lock を解放する。

cleanup 完了/失敗時は legacy-cleanup → exclusive presence → lifecycle の順で解放してから shared presence を再取得する。shared 再取得に失敗した場合は fail-closed を維持し、自動 reload しない。non-waiting election 例外、hidden tab が残る timeout、lock abort、crashed tab 解放後の再試行を architecture/state-machine test に含める。

### 7.2 Cleanup 境界

- `persistenceCleanupCoordinator.ts`: proof、kill switch、lock、安全判断、fail-closed の調停
- `migration/legacyCleanupService.ts`: journal/archive/committed target 検証、entry claim、control record の CAS write/readback、crash resume、各削除直前の safety revalidation を所有
- `migration/legacyLocalStorageAdapter.ts`: service が指定した既存 exact legacy key の read/remove だけを実行
- Service Worker cache cleanup: active Worker に対する独立 cleanup permit に束縛された exact cache allowlist の idempotent executor

cleanup service は `CleanupControlPort`、`CleanupTransactionPort`、coordinator revalidation を使用する。Phase 1P は現 `indexedDB.ts` への compatibility adapter、Phase 7 は `controlRepository`/`transactionCoordinator` adapter を提供し、service 自体を移動・複製しない。現 `executePhysicalLegacyCleanup` の順序と crash-safety contract を維持する。IndexedDB は journal/archive/proof/control の保持に使うが、database、store、record、generic `syncQueue` を削除対象にしない。prefix/glob に一致した `localStorage` key も削除しない。本計画は共通 lifecycle lock と proof transport の契約を実装するが、persistence Release B の provider、kill switch、実削除呼出しは production entry point へ接続しない。

Service Worker の activation と destructive cache cleanup は別 transaction とする。waiting Worker の in-memory permit は termination/restart で失われ、active Worker へ安全に持ち越せないため、activation permit を cleanup authorization として再利用しない。

1. running client の `PREPARE_UPDATE` / `APPLY_UPDATE` は `skipWaiting()` の要求と registration.active の candidate identity 確認までを行い、旧 page から cache cleanup を実行しない。
2. expected active identity を確認した旧 client は一度だけ明示 reload する。reload 後の bootstrap は HTML、bootstrap、controller、registration.active が同じ candidate generation/protocol であることを再確認し、不一致なら mutable App を mount しない。
3. identity が一致した新 client は mutable App の mount/shared presence 取得前に post-bootstrap cleanup を一度試行する。client 側で `navigator.serviceWorker.controller === registration.active`、page/controller/registration.active identity 一致を確認し、message は `navigator.serviceWorker.controller.postMessage()` へ送る。lifecycle → exclusive presence の取得後、受信 Worker が自身の compile-time identity、`MessageEvent.source.id`、`clients.matchAll({ type: "window", includeUncontrolled: true })` で scope 内 client が要求元一件だけであることを再確認した場合だけ、fresh `PREPARE_CLEANUP` / `APPLY_CLEANUP` を実行する。
4. 他 client、uncontrolled/pre-floor client、lock timeout、Worker restart がある場合は cleanup を保留し、lock を解放して shared presence barrier へ進む。active/page identity が一致する限り App は mount でき、後続の安全な post-bootstrap retry で同じ手順を最初から行う。

Worker の `activate` event は destructive cleanup を一切行わない。client 0 の瞬間的観測は新 tab open と atomic ではなく、旧 client が cache を参照しない証明にならないためである。cleanup permit は source client ID、page/controller/registration.active build ID、protocol、nonce、expiry、client-set fingerprint に束縛し、Worker restart で失われた場合は最初から取り直す。

deferred cleanup は `skipWaiting()` を呼ばない。`PREPARE_CLEANUP` reject/timeout は削除未開始の `CLEANUP_NOT_APPLIED`、Worker が APPLY permit を consume した後は `CLEANUP_APPLYING`、ack 消失・Worker crash・部分削除は `CLEANUP_STATE_UNKNOWN` と区別する。`CLEANUP_NOT_APPLIED` だけを「旧 cache は未変更」とみなす。

client は APPLY 後、cleanup 用 lock を保持したまま fresh active Worker の identity と exact allowlist inventory を再照合する。残存 0 は `CLEANUP_APPLIED`、残存が確定した場合は同じ lock lease の中で blocker/client set を再検査し、fresh permit による idempotent retryとする。page/controller/registration.active identity が不一致または照合不能なら compatibility hold を維持し、mutable App を mount しない。identity は fresh 一致するが inventory だけが照合不能の場合は `CLEANUP_PENDING` とする。bounded retry 後の pending では lock を解放し、candidate が旧 cache 名を一切参照しないことを artifact/route graph で証明できる場合だけ mutable App を mountできる。部分削除済みでも旧 cache を必要とする page を再開しない。cleanup phase の exit は、旧 client が存在しない post-bootstrap retryで exact 残存 0 を要求する。

custom Worker は activate 時に暗黙 cleanup/takeover を登録する `precacheAndRoute()`、`cleanupOutdatedCaches()`、同等 helper を使わない。低水準の `PrecacheController.install()` と所有する route handlerを使い、activation、routing、cleanup の listener と `waitUntil()` を `src/sw.ts` が明示的に所有する。

install、activate、非同期 message protocol の Promise は対応する extendable event の `waitUntil()` へ必ず渡し、handler return 後に browser が処理を打ち切っても成功 ack を返さない。PREPARE reject、APPLY 前 crash、cache 一件削除後 crash、全削除後 ack loss、restart 後 inventory、idempotent retry を state-machine/transition fixture に含める。

## 8. 品質 command と CI

### 8.1 段階導入する command

| Command                                         | 導入時点 | 責務                                                        |
| ----------------------------------------------- | -------- | ----------------------------------------------------------- |
| `verify:runtime`                                | 0A       | exact toolchain/build environment                           |
| `capture:baseline-v0`                           | 0A-0     | 現行 artifact、lint、audit、CDN 表示を保存                  |
| `quality:local`                                 | 0A       | typecheck、lint delta、format、encoding、unit               |
| `quality:pr`                                    | 0B       | required static/unit/E2E/a11y/audit gate                    |
| `build:artifact -- --variant <catalog-id>`      | 0C       | catalog/descriptor を固定し、固有 output へ一度だけ build   |
| `package:release -- --artifact <path>`          | 0C       | 完全 package と detached index を生成                       |
| `quality:artifact -- --package <path>`          | 0C       | hash、graph、budget、offline、package 検証                  |
| `serve:package -- --package <path>`             | 0C       | `.vercel/output` の static と bundled function を HTTP 起動 |
| `test:api:http -- --package <path>`             | 0C       | package 内 function の HTTP contract                        |
| `deploy:qa -- --package <path>`                 | 0C       | isolated QA へ保存済み package を prebuilt deploy           |
| `verify:provider -- --deployment <id>`          | 0C       | QA の全 bytes/header/function/prerequisite を照合           |
| `quality:transition -- --scenario <path>`       | 1A       | old → candidate transition                                  |
| `release:preflight -- --package <path>`         | 1D       | production project の prerequisite と承認前検査             |
| `release:create-candidate -- --package <path>`  | 1D       | domain 未切替の immutable production-target deployment 作成 |
| `release:verify-candidate -- --deployment <id>` | 1D       | candidate の全 bytes/header/function/prerequisite を照合    |
| `release:promote -- --deployment <id>`          | 1D       | 同じ deployment ID を二者承認で production alias へ昇格     |
| `release:observe -- --deployment <id>`          | 1D       | 新規 immutable observation fragment を生成                  |
| `release:finalize -- --evidence-in <path>`      | 1D       | 長時間観測後の final evidence                               |

build DAG は `build` → `build:release-a` → `build:artifact` → private `build:_vite` の一方向とし、逆呼出しと暗黙 env default を禁止する。`build:release-a` は `config/variant-catalog.json` の `releaseACompatibilityVariant` 一件へ解決する。`build:_vite` は検証済み descriptor、空 output path、allowlist env を必須にし、直接の release 利用を拒否する。`preview` は static-only の開発 command と明記し、API/provider parity の証拠に使わない。

`quality:local` と `quality:pr` は、既存の `test:release-a-evidence`、`verify:release-a-evidence`、browser verifier 後継、rollback/transition、encoding、format、API contract、DB local contract を phase に応じて必ず集約し、個別 command の存在だけで required gate から脱落させない。

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

単独 wrapper は build/package、server、port、cleanup の ownership を明示する。Phase 0B の `quality:pr` は wrapper 自身が一度だけ作る deploy 不可の ephemeral test build と static server を全 inner project で共有する。Phase 0C 以後の `quality:pr` は `build:artifact`/`package:release` が一度だけ作った canonical package と package serverを共有し、`quality:artifact` は常に指定済み package を使う。ordinary E2E は static/package server、PWA transition は複数の immutable package を同一 origin で atomic switch できる専用 artifact server、provider test は remote deployment を使う。inner project は source を変更せず、再 build せず、server を起動しない。

browser は `@playwright/test 1.62.1` と lockfile に対応する Chromium を `npm exec -- playwright install chromium` で用意する。既存 Release A CDP verifier を維持する間は `CHROME_PATH` を Playwright Chromium executable に固定し、ambient Chrome/Edge 探索を release gate で禁止する。

canonical Linux build job は package を一度生成して immutable CI input として browser/provider job へ渡す。Windows browser job と QA/provider job はその package を read-only で使い、再 build しない。

PWA project は browser profile 単位で serial 実行し、独立 user-data/storage、2～5 tab、hidden tab を使う。localhost rehearsal は installed PWA の production evidence とせず、production origin の installed app は別 evidence とする。

Vitest は次の project に分類し、各 test file を exactly one project に割り当てる。

| Project              | Environment/setup                                            |
| -------------------- | ------------------------------------------------------------ |
| `unit-node`          | pure domain/helper、Node、DOM setup なし                     |
| `dom-react`          | jsdom、Testing Library setup                                 |
| `indexeddb-recovery` | jsdom または Node + `fake-indexeddb` 専用 setup              |
| `worker-protocol`    | Worker state machine の pure test、Worker global mock を限定 |
| `tooling-api`        | Node、scripts/function/contract test                         |

include/exclude を相互排他的にし、file-level environment annotation の移行 mapping、総 test 1,198 件以上、重複 0、skip 増加 0 を検査する。

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
- waiver のない reachable critical/high と production critical/high は Phase 1 着手前に 0 にする。
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

`verify:architecture` は現存 debt を Phase 0 から一律 zero とせず、baseline fingerprint と zero 化 phase を次で固定する。

| Rule                                            | 導入直後                           | Zero/最終条件            |
| ----------------------------------------------- | ---------------------------------- | ------------------------ |
| PWA lock/protocol/registration owner            | Phase 1 から違反 0                 | `P1C-MULTICLIENT`        |
| inline HTML script/style element                | baseline 外追加 0                  | `P3-CSP` で 0            |
| production style sink                           | AST + entry graph catalog 外追加 0 | catalog/allowlist を継続 |
| React component の ExcelJS import/initial graph | baseline 外追加 0                  | `P4-XLSX` で 0           |
| list business navigation の DOM query/hit test  | baseline 外追加 0                  | `P5-LIST` で port 外 0   |
| `App.tsx` の raw setter/DB deep import          | baseline 外追加 0                  | `P6-APP` で 0            |
| facade/repository/store 逆依存                  | module 導入時から 0                | `P7-IDB`                 |
| lint disable/warning                            | baseline 外追加 0                  | `LINT-ZERO`              |

coverage threshold も対象 module が存在する phase から適用する。Phase 0B で既存 source-string/handler-presence test を behavior contract test へ置換し、後続 phase で source text の位置を互換契約にしない。新しい draft/async operation、style sink、build env、deep import を catalog 未登録で追加した場合は architecture failure とする。

### 8.6 A11y baseline

- `a11y:baseline:capture`: rule set、axe version、browser、UI scenario、viewport、fingerprint を保存
- `a11y:baseline:compare`: baseline 外の violation を失敗
- `a11y:baseline:approve`: reviewer と owner 付きで更新
- critical/serious は baseline 登録不可
- moderate/minor の例外は 30 日で期限切れし、期限切れを CI failure にする

router はないため「主要 route」は使わず、`config/ui-scenarios.json` の canonical ID を visual/E2E/a11y/coverage fixture で共有する。最低限 `bootstrap-loading`、`bootstrap-root-missing`、`pwa-registration-invalid`、`bootstrap-import-failed`、`react-render-failed`、`react-lazy-failed`、`async-operation-failed`、`persistence-recovery`、`event-list`、`import-empty`、`import-dirty`、`import-executing`、`google-sheets-online`、`event-day-edit`、`event-day-execute`、`focus`、`map-list`、`persistence-failed`、`dialogs-drafts`、`pwa-compatibility-hold`、`pwa-update`、`post-ponr-hold`、`list-full`、`list-virtual` を持ち、light/dark、desktop/narrow、200% zoom を matrix 化する。

visual baseline と比較は同じ Playwright/Chromium revision、OS/container、font、locale、timezone、DPR、viewport、color scheme、animation disable を使う。ambient Chrome/Edge で採った screenshot と固定 Chromium の pixel diff を比較しない。

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

- workflow を `pr-static-unit`、`browser-pwa`、`canonical-artifact`、`release-protected`、`daily-audit`、`observation-synthetic` に分ける。
- branch protection は安定名の aggregate check `quality-required` 一件を required とし、依存 job の failure と意図しない skip を aggregate が失敗させる。
- PR concurrency は `cancel-in-progress: true`、production release は単一 concurrency かつ `cancel-in-progress: false` とする。
- release は `workflow_dispatch` と protected environment の手動承認を要求する。DB apply は release job 内でも別 operator approval とする。
- GitHub Actions は必要最小 `permissions`、job timeout、concurrency policy を持つ。
- third-party action は full commit SHA で pin する。
- fork PR では secret job、DB remote command、provider deploy を起動しない。
- log と artifact から env/secret を redact する。
- artifact retention を明示し、rollback package は WORM storage へ別送する。
- workflow を先に merge して green を確認し、その後に branch protection の required check を有効化する。
- repository setting、auto-deploy guard、required check の変更は evidence を残す独立した operator 作業にする。
- scheduled workflow failure は owner/alert route へ通知し、run URI、result hash、確認時刻を observation evidence に保存する。

## 9. 全体実施順と production 昇格

実施順は固定する。

0. Phase 0 guard: 最初の source merge より前に main auto-production promotion を停止
1. Phase 0A-0: 現行の immutable baseline
2. Phase 0A: toolchain、audit、lint identity
3. Phase 0B: E2E、a11y、coverage、architecture
4. Phase 0C: artifact/package/provider 基盤
5. Phase 1P: persistence/reload-safety/mutation の prerequisite seam
6. Phase 1A: QA-only custom Worker parity
7. Phase 1B: prompt UI、blocker、startup、error handling
8. Phase 1C: multi-client permit、cleanup coordination
9. Phase 1D: transition、provider、bridge floor、prompt floor
10. Phase 2A: local Tailwind CSS
11. Phase 2B: legacy Tailwind cache cleanup
12. Phase 3: CSP
13. Phase 4: XLSX Worker
14. Phase 5: ShoppingList virtualization
15. Phase 6: `App.tsx` 分割
16. Phase 7: IndexedDB 分割
17. M2: lint 0、観測、rollout 専用分岐削除

operator は Phase 0 guard の provider/repository 設定と証跡を source PR より先に完了する。Phase 0A-0 から 1C までの source PR は merge できるが production promotion は禁止する。Phase 1D だけは `P1D-BRIDGE` と `P1D-PROMPT` を正式な独立 exit とし、前者を完了・24 時間観測してから後者へ進む。正式 exit の candidate は §24.3 の pre-promotion gate 後にだけ観測目的で alias 昇格でき、24 時間観測と final evidence の確定までは exit 未完了とする。共通 gate 外の途中 artifact は production へ昇格しない。

現在の persistence Release A baseline production acceptance は repository 内 template だけでは完了を証明できない。Phase 0 の source/QA 作業は進めてよいが、external immutable baseline evidence URI/hash が検証されるまで Phase 1D の production 昇格は blocked とする。

各 PR は一つの主リスクだけを扱う。計測、coverage、repository setting、provider setting を一つの PR にまとめない。

## 10. Phase 0A-0: 現行 baseline の固定

### 10.1 変更

auto-promotion guard 後、実装 tree 照合基準 commit を clean detached worktree へ checkout する。別の固定済み tooling checkout から `capture:baseline-v0 --source-dir <clean-checkout>` を実行し、現行 Node 20.20.0/npm 10.8.2 のまま次を保存する。capture tooling の追加 commit 自体を baseline source として build しない。これは implementation characterization であり、previous production の source/package/deployment identity は live provider と保存済み package から別に取得する。

- source SHA、lockfile、tool version
- `build:release-a` の complete log と `dist` file hash tree
- `index.html`、`sw.js`、capabilities manifest、precache
- `vercel.json`、API function、package 内 required migration set/hash、remote history/live catalog fingerprint、active env key 名
- lint/audit/disable/expect-error identity
- current autoUpdate Worker の transition fixture
- Tailwind CDN response bytes、URL、取得時刻、SHA-256
- fixed Playwright Chromium/OS/font/locale/timezone/DPR/viewport/color-scheme の UI scenario screenshot と computed-style fingerprint
- unit/build/encoding の実行結果
- 既存 Release A evidence への参照

baseline capture script は `npm audit` exit code 1 を advisory 結果として受理し、解析不能と混同しない。

baseline 採取後に恒久 capture script/schema を merge する。source SHA が変われば capabilities、HTML、Service Worker bytes も変わるため、「script-only なので同じ build」と扱わず、production へ昇格しない。

`.gitattributes` は全 text LF を要求する一方、Prettier は `AGENTS.md` と `docs/Resilient Persistence & Safe Migration Plan.md` を CRLF 指定している。現状は Git blob が LF、working-tree bytes が CRLF である。0A-0 で index/worktree 別の BOM/EOL catalog を固定した後、独立 PR で `.gitattributes` にこの二 file の `eol=crlf` override を追加し、それ以外を LF のままにする。意図した属性差分だけを隔離し、`test:encoding` の scan 対象へ二 file を含め、Prettier、Git attributes、Git blob、working-tree bytes の期待を検査する。

### 10.2 合格条件 `P0-BASELINE`

- toolchain 変更前の artifact と CDN 表示を再検証できる。
- baseline file は source と別の immutable storage にも保存される。
- current previous-production deployment へ alias を戻せる。失効時は保存済み prebuilt package を再 deploy して全 hash を照合でき、どちらもできない場合は production promotion を停止したまま解消する。
- main auto-production promotion が無効または承認制である証跡がある。
- canonical build/capture が dirty または untracked input を拒否する。
- BOM/EOL catalog と実 bytes が一致する。

## 11. Phase 0A: Toolchain と依存関係

### 11.1 Version 方針

peer dependency を満たす次の順で更新する。各番号は独立 PR を原則とするが、番号 3 は peer-compatible な一つの compatibility cluster として同時に更新する。

1. Node `24.19.0`、npm `11.19.0`、`@types/node` `24.13.3`
2. Vite 5 のまま vite-plugin-pwa `1.3.0`、`@vite-pwa/assets-generator` `1.0.2`、Workbox `7.4.1`
3. Vite `8.2.0`、`@vitejs/plugin-react` `6.0.5`、Vitest `4.1.10`、`@vitest/coverage-v8` `4.1.10`、jsdom `30.0.1`
4. ESLint `9.39.5`、typescript-eslint parser/plugin `8.66.0`、react-hooks `7.1.1`
5. `@playwright/test` `1.62.1`、`@axe-core/playwright` `4.12.1`
6. Tailwind `3.4.19`、PostCSS `8.5.25`、Autoprefixer `10.5.4`
7. `ws` `8.21.2`。Playwright への verifier 移行完了後、direct `ws` 利用 0 を確認して削除
8. Vercel CLI `58.5.1`、Supabase CLI `2.111.0`
9. Phase 4 で `@zip.js/zip.js` `2.8.34`、`saxes` `6.0.0`
10. Phase 5 で `@tanstack/react-virtual` `3.14.9`

React/ReactDOM `18.3.1`、TypeScript `5.9.3`、ExcelJS `4.4.0` を維持し、React 19、Tailwind 4 へは上げない。全 direct dependency は exact pin し、lockfile を正本とする。

custom `src/sw.ts` が import する `workbox-core`、`workbox-precaching`、`workbox-routing`、`workbox-strategies`、Phase 2A までの Tailwind parity に必要な `workbox-expiration` はすべて `7.4.1` の direct devDependency にする。page は native registration adapter を使うため `workbox-window` と virtual PWA register module を実装 API にしない。transitive dependency を直接 import しない。

独立 dependency-hygiene PR で entry graph 非参照を機械確認後、stale な `src/lib/supabase.ts`、`src/lib/database.types.ts`、`@supabase/supabase-js` と Supabase browser runtime-cache route を削除する。metrics function の REST 呼出しと migration は影響を受けない。

### 11.2 Toolchain API 移行

- Vitest の `environmentMatchGlobs` を projects へ移す。
- unit、DOM、Worker、tooling/API の tsconfig/project を分ける。
- ESLint 9 flat config へ移し、旧 baseline fingerprint を明示 mapping する。
- Vite 8 の暗黙 browser target を受け入れず、app と Worker の `build.target` を `es2020` に固定する。
- manual chunk、lazy import、PWA manifest、precache、asset path の golden test を更新する。
- provider build と function runtime が Node 24 で動くことを QA deployment で証明する。
- `npm ls` と package manager install を strict peer mode で実行し、各 merge point の peer dependency error を 0 にする。

### 11.3 Security

Phase 1 前に waiver のない reachable critical/high と production critical/high を 0 にする。Vite、Vitest、vite-plugin-pwa、`ws` の advisory を新 PWA 実装より先に解消する。ExcelJS と Phase 4 ZIP/XML dependency は moderate を含む reachability review、input limit、Worker isolation、期限付き waiver の組で扱う。

### 11.4 合格条件 `P0-TOOLCHAIN`

- `verify:runtime` が local/CI の exact versionと provider の runtime family/resolved patch allowlist を検証する。
- typecheck、unit 1,198 件以上、build、encoding が成功する。
- lint baseline 外 warning が 0 である。
- peer dependency error が 0 である。
- Vite 5 baseline と比較し、意図しない browser target、chunk、PWA output 差分がない。
- production promotion は停止中である。

## 12. Phase 0B: Browser、a11y、coverage

### 12.1 Browser fixture

決定的な fixture と test-only API を用意する。

- fresh-online-install
- installed-controlled-offline-relaunch
- controlled-online → offline → online
- update-check-offline
- remote Google Sheets import の明示的 offline failure
- local IndexedDB CRUD/reopen
- waiting Worker
- saved/unsaved/saving/failed/recovery-required persistence
- map import preview、event import、event export
- backup restore の draft と実行中
- multi-tab
- chunk load failure
- Phase 4 後の local XLSX Worker offline
- 1,000 行 shopping list

production code に test bypass を埋めず、build-time test endpoint と fixture DB を production package から除外する。

### 12.2 A11y

keyboard、focus order、dialog、live region、color contrast、zoom、screen reader label を canonical UI scenario で検査する。viewport の zoom 禁止を除去し、200% zoom と narrow viewport を required case にする。

### 12.3 合格条件 `P0-BROWSER`

- wrapper/inner command の所有権が test で保証される。
- fixed Chromium で通常 E2E、a11y、offline smoke が成功する。
- changed coverage と high-risk coverage の閾値を満たす。
- 既存 source string/handler presence assertion が behavior contract test へ置換され、source string assertion が 0 である。
- Vitest 1,198 件以上、project 間重複 0、skip 増加 0 である。
- branch protection は workflow green 後にだけ required 化される。

## 13. Phase 0C: Artifact と provider 基盤

Phase 0C は次の独立 PR に分ける。

1. build input descriptor と generic artifact manifest
2. bundle/graph/performance budget
3. complete release package
4. Build Output API v3 generator、package HTTP harness、provider prebuilt deploy と byte/header/function verification
5. generic evidence fragment
6. metrics v1 contract、DB CLI/local/live fingerprint
7. repository/provider setting の operator evidence

`release-capabilities*` は dual-write のまま維持する。

既存 Release A tooling は次の順で variant-aware にする。

- `verify-release-a-build.mjs`: `registerSW.js` を hard-codeせず capability v2 の `pwaUpdateMode` で contract を選び、v1/field 欠落だけを `legacy-auto` と解釈する
- `verify-release-a-browser.mjs`: Phase 0C では fixed Playwright Chromium、package ID、v1/v2 capability、`legacy-auto` package の runtime smoke までを検査する。custom Worker の transition branch は Phase 1A、startup state/single-client branch は Phase 1B、multi-client/cleanup branch は Phase 1C で同じ verifier へ段階追加する
- `rehearse-release-a-rollback.ps1`: 旧 source の再 build をやめ、既存 immutable deployment への alias 復帰、失効時だけ保存済み prebuilt package deploy と hash 再照合を行う
- `verify-release-a-evidence.mjs`: schema v1 と `buildId=sourceSha` を変更しない

旧再 build rollback は diagnostic 用にも release gate から除外する。generic verifier を先に追加し、Release A consumer の互換 test が green のまま各 consumer を移行する。

### 13.1 合格条件 `P0-ARTIFACT`

- comparison-only reproducibility qualification が同じ input の二 build の static/function/provider tree 一致を証明し、production candidate は別の一回の canonical build だけから作られる。
- package を clean environment へ展開し、`serve:package` で static app と bundled metrics function を起動して HTTP contract を検査できる。
- env secret 値を含まない。
- `deploy:qa` した package の全 bytes、headers、route/MIME、API/WAF、migration history/live schema prerequisite が `verify:provider` で一致する。
- artifact evidence fragment は生成できるが、長時間観測を必要とする final evidence は生成しない。
- previous-production package と新 package の transition scenario を記述できる。

## 14. Phase 1: Prompt 型 PWA 更新

### 14.1 Phase 1P: prerequisite seam

PWA protocol より先に、現 `indexedDB.ts` と `App.tsx` から次の最小 seam を最終 path へ抽出する。Phase 7 で再移動・複製しない。

```text
src/persistence/
  recovery/inspectRecoveryState.ts
  repositories/controlRepository.ts
  migration/legacyCleanupService.ts
  migration/legacyLocalStorageAdapter.ts
  reload-safety/reloadSafetyStore.ts
  ports/cleanupControlPort.ts
  ports/cleanupTransactionPort.ts
  ports/recoveryInspectionPort.ts
src/features/app-shell/commands/persistedMutationCommands.ts
src/pwa/update-blockers.catalog.ts
```

- `inspectRecoveryState` は read-only で、空 DB 作成、migration、cleanup、write を行わない。
- legacy cleanup service/adapter は既存 journal/CAS/revalidation/exact-key contract を保つが、Release B hard-OFF のため production call site へ接続しない。
- 10 個の persisted setter を `origin: "user" | "hydrate" | "restore" | "migration"` 付き command で包み、`user` mutation は React setter より前に同期的に mutation epoch と blocker を更新する。
- hydrate と検証済み restore/migration は user mutation とせず、対応する durable epoch を同期する。
- save cycle は開始時 epoch と dirty store 集合を捕捉し、全対象 store 成功かつ途中 mutation なしの場合だけ global durable epoch を進める。部分成功では最新 UI state を戻さず `failed` を維持する。
- root coordinator が App mount 前から `beforeunload` を一度だけ所有し、persistence status と blocker catalog の両方を見る。
- 既存 import path には薄い compatibility re-export/delegate を残し、新旧実装の二重 owner を作らない。

合格条件 `P1P-SEAMS`:

- 全 10 persisted setter に origin/epoch test があり、adapter 外の対象 setter/DB write 追加を architecture gate が拒否する。
- read-only probe が DB 不在、破損、recovery-required、legacy candidate、control metadata 矛盾を fail-closed に分類する。
- root unload guard が effect 実行前の user mutation と全 catalog blocker を検出する。
- Phase 7 の目標 tree/facade が同じ module を再利用する。

### 14.2 最終構成

- `vite-plugin-pwa` は `strategies: "injectManifest"`、`srcDir: "src"`、`filename: "sw.ts"`、`injectRegister: false`、`injectManifest.rollupFormat: "iife"`、`devOptions.enabled: false` を使う。
- custom Worker は `src/sw.ts` を正本とする。
- `src/pwa/registration.ts` が native `navigator.serviceWorker.register("/sw.js", { scope: "/", type: "classic", updateViaCache: "none" })`、registration snapshot、MessageChannel protocol を所有する唯一の adapter となる。
- dev server では登録せず、production package と専用 transition server だけで PWA を検査する。
- app bootstrap が `getRegistration()` と controller/installing/waiting/active を snapshot する前に新規登録、virtual register module、React component を開始しない。
- `index.html` の唯一の application entry を小さい `src/bootstrap.ts` とし、React、App、feature/persistence module を静的 import させない。Phase 3 の pre-paint theme initializer は app entry ではなく限定された classic asset とする。
- `src/bootstrap.ts` が page/Worker identity と reload safety を照合し、安全分岐だけで `src/index.tsx` を dynamic import する。
- loading/viewport の ownership と旧 300 ms hide 処理を Phase 1 で bootstrap/external CSS へ移し、state 判定が完了するまで loading/hold shell を隠さない。
- bootstrap fatal shell、React root Error Boundary、async failure coordinator、update coordinator を責務別に置く。

`skipWaiting: false` と `clientsClaim: false` を plugin option として記述しない。`src/sw.ts` が generic `"SKIP_WAITING"` message を拒否し、permit handler 以外から `self.skipWaiting()` を呼ばず、activate 時に `clientsClaim()` を呼ばないことを source/built scan で固定する。`virtual:pwa-register`、`updateServiceWorker()`、`workbox-window`、generic skip-waiting helper を page source/import graph と direct app dependency から禁止する。vite-plugin-pwa が build-tool dependency として持つ transitive `workbox-window` は lockfile/audit 対象として許可するが、page bundle/request/evaluation graph 0 を artifact gate で確認する。

### 14.3 `src/sw.ts` の parity

Phase 1 の custom Worker は現 generateSW の次を再現する。

- precache と revision
- `config/route-policy.json` と一致する SPA navigation fallback
- offline asset response
- Workbox precache namespace に限定した、独立 permit 後の outdated app cache cleanup
- Tailwind CDN `CacheFirst`

未接続 Supabase browser client と `NetworkOnly` route は Phase 0A の dependency-hygiene PR で削除済みを前提とし、parity allowlist にその削除を記録する。

Workbox の暗黙 cleanup/activate helper は使わない。`PrecacheController.install()`、owned navigation handler、exact app-cache executor を組み合わせ、§7.2 の独立 cleanup authorization 後にだけ削除する。runtime cache の削除は phase ごとの明示 allowlist に限定する。

### 14.4 Startup state table

mutable App を mount する分岐は、identity を分類し、必要なら §7.2 の post-bootstrap cleanup を試行した後、共通 `acquirePresenceOrHold()` barrier を通る。cleanup 試行中は shared presence を保持しない。Web Locks 対応時は shared presence を最大 5 秒で取得できた場合だけ mount し、exclusive transition 中の timeout は hold にする。非対応時だけ capability を `close-all-only` に固定して mount し、destructive cleanup は実行しない。

| Snapshot                                                                               | 動作                                                                                      |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Service Worker 非対応                                                                  | shared presence barrier 後に no-PWA mode で App を mount。offline/update は利用不可と表示 |
| controller なし、registration なし                                                     | pure fresh install。barrier 後に App を mountし、その後 native registration を開始        |
| controller なし、active が page/protocol と一致、他 state に矛盾なし                   | cleanup は実行せず barrier 後に mount。自動 reloadせず waiting/installing を別途分類      |
| controller なし、installing/waiting/active が unknown、pre-floor、または page と不一致 | App chunk を load せず compatibility hold                                                 |
| controller、registration.active、page/protocol がすべて一致                            | pending cleanup を一度試行後、barrier を経て mount。waiting は update availability と分類 |
| controller/page は一致するが registration.active が新世代または不一致                  | post-PONR hold。旧 cache を削除せず、reload-safe 証明後の一回の reload だけを提示         |
| controller が不一致、waiting が page/protocol と一致                                   | hold し、reload safety が成立した場合だけ prompt protocol                                 |
| controller が不一致で matching waiting なし、または応答 timeout/identity 欠落          | fail-closed hold。close-all 手順だけを提示                                                |

hard reload の `controller == null` を fresh install とみなさない。Service Worker 登録失敗は、既存 registration がない pure fresh 経路なら no-PWA mode へ落とし、既存 registration/identity が不明な経路では hold を維持する。

hold 画面は `src/bootstrap.ts` と小さい external bootstrap CSS だけで描画し、React/App chunk に依存しない。keyboard、screen reader label、200% zoom、offline を E2E 対象にする。

controller 応答 timeout は固定値 3 秒、retry は利用者操作ごとに 1 回とする。

### 14.5 Reload safety と error ownership

React mount 前に root coordinator が `ReloadSafetyStore` を初期化する。bootstrap 用 validator は現行 recovery 判定から副作用なしの `inspectPersistenceRecoveryState()` を抽出し、10 app store payload/checkpoint、`syncQueue` control metadata、migration journal/archive、exact legacy `localStorage` runtime-fallback candidate の parse/digest/reconcile を read-only で検査する。control metadata だけで `idle` にしない。

probe は migration、cleanup、write を開始しない。`indexedDB.databases()` などで DB 存在を確認できない場合は `unknown` とし、probe のために空 database を新規作成しない。最初は `unknown`、全 recovery source の整合を証明した後だけ `idle` にする。running App の persistence hook と blocker registry は同じ store へ同期 publish する。

snapshot は `status`、`mutationEpoch`、`durableSaveEpoch`、`recoveryEpoch`、`blockerCount`、`observedAt` を持つ。`status == saved`、mutation/save epoch 一致、recovery 完了、blocker 0、snapshot freshness 1 秒以内を同時に満たす場合だけ reload-safe とする。Phase 1P の mutation command が React effect を待たず epoch/token を同期更新し、部分保存成功では global durable epoch を進めない。

running App は `refreshReloadSafety()` で同期 ref、registry、read-only recovery probe を再検証し、prompt の有効化直前、PREPARE 前、APPLY 前に新しい `observedAt` を発行する。App crash/unexpected unmount 後は refresh を不可にして `unknown` を返すため、1 秒 freshness を heartbeat で見せかけない。

error owner を次の三層に分ける。

- bootstrap fatal shell: root element 不在、registration snapshot/identity error、`import("./index")` rejection。
- React root Error Boundary: provider/App render、React lifecycle、React lazy chunk failure。
- async failure coordinator: event-handler/operation Promise。XLSX Worker load/crash/timeout は Phase 4 の port owner が分類して coordinator へ publish。

全層で page lifecycle を破棄する reload、PWA update、bootstrap/chunk reload retry は、root coordinator が保持する `ReloadSafetyStore` が reload-safe を証明した場合だけ提示する。in-place の retry-save、完全に settle/cleanup 済み XLSX operation の再実行、validation 修正後の再試行は各 operation state machine が許可し、failed/unsaved を解消する経路として reload gate から分離する。

- `unsaved`、`saving`、`failed`、`recovery-required`、snapshot 不明では reload/update/bootstrap retry を提示しない。`failed` では同一 page 内の retry-save を維持する。
- App crash は snapshot を同期 invalidation し、blocker 解放として扱わない。
- raw stack、XLSX 内容、利用者データを evidence へ書かない。

### 14.6 Blocker registry

blocker は token 方式の単一 registry で管理し、登録元、開始時刻、理由、解除理由を持つ。

| 状態                     | blocker 開始                      | blocker 解除                                                                                                         |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| persistence unsaved      | mutation boundary                 | durable save 成功                                                                                                    |
| persistence saving       | write 開始                        | success/failure token へ原子的に遷移                                                                                 |
| persistence failed       | write failure                     | retry save 成功                                                                                                      |
| recovery-required        | recovery 検出                     | recovery 完了・検証・保存成功                                                                                        |
| map import               | file 選択/preview 作成            | apply 完了または cancel                                                                                              |
| event import             | file 選択                         | import transaction 完了または cancel                                                                                 |
| event export draft       | options を変更                    | confirm 時に execution token へ原子的置換、または cancel                                                             |
| event export execution   | confirm                           | validated bytes から Blob/object URL を作り click dispatch と URL cleanup 登録を完了、または cancel/error settlement |
| backup restore draft     | restore source/mode/target を変更 | confirm/restore 開始時に execution token へ原子的置換、または cancel                                                 |
| backup restore execution | restore 開始                      | durable save と結果確認                                                                                              |
| XLSX Worker              | request accepted                  | result/cancel/error cleanup                                                                                          |
| drag/edit                | operation 開始                    | commit または cancel                                                                                                 |

status/token の置換は一つの registry transaction とし、`saving` 解除と `failed` 登録の間に blocker 0 を観測させない。failed 状態の破棄は本計画へ追加せず、既存 recovery/save で durable 化するまで保持する。

全 operation/draft token の commit は、後続の execution、persistence-unsaved、persistence-saving token の登録と同じ registry transaction で置換する。map import apply、event import、export、backup restore、drag/edit の各 handoff で blocker 0 を観測しない race test を持つ。unexpected unmount/App crash では component cleanup が token を解放せず crash-seal し、通常 unmount は明示 commit/cancel transaction の完了時だけ解放する。

`src/pwa/update-blockers.catalog.ts` を machine-readable な正本とし、owner、開始条件、commit/cancel、unexpected unmount、後続 token を持つ。最低限 `ImportScreen` の全入力、Item add/edit form、URL update、event rename/update/duplicate pending state、map import preview/settings/reimport、backup pending file、hall/block definition、visit-list staged order、UI visibility draft、drag/range operation、export options、async execution を列挙する。

dialog を pristine なまま開いただけでは blocker にしない。file 選択、first dirty edit、execution acceptance の正確な開始点を owner ごとに固定する。新しい draft/async owner は catalog/test がなければ architecture failure とし、root `beforeunload` と PWA guard は同じ registry snapshot を使う。全 owner の開始/commit/cancel/unmount と、後続 persistence token への置換 test が揃わない限り完了扱いにしない。

### 14.7 Permit protocol

#### PREPARE

1. client は shared presence 保持中に `refreshReloadSafety()` を実行し、election を `ifAvailable` で取得して blocker を検査する。
2. client は UI を freeze し、自身の shared presence を解放してから、lifecycle → exclusive presence を bounded acquisition する。
3. client は reload safety と blocker を再検査する。
4. client から waiting Worker へ MessageChannel で `PREPARE_UPDATE` を送る。
5. waiting Worker は `MessageEvent.source.id` を要求元として取得する。
6. Worker は `clients.matchAll({ type: "window", includeUncontrolled: true })` を実行し、registration scope で filter した client が要求元一件だけであることを確認する。
7. Worker は nonce、15 秒 expiry、source client ID、protocol、page/controller/registration.active/installing/waiting build ID、client-set fingerprint を memory に束縛して返す。

#### APPLY

1. client は lock 所有中に `refreshReloadSafety()`、blocker、identity をもう一度確認する。
2. client は `APPLY_UPDATE` と nonce を同じ waiting Worker へ送る。
3. Worker は source、protocol、identity、expiry、unused、client-set fingerprint を再検査する。
4. Worker は await を挟まない同じ handler で permit を consumed にし、`skipWaiting()` を一度だけ呼ぶ。nonce は再利用しない。
5. client は registration を観測する。candidate が `activating` になった時点を PONR とする。
6. 同期 throw/reject 後に candidate が waiting、旧 active が不変と再検証できた場合だけ pre-PONR failure とし、§7.1 の順で shared presence を再取得して UI へ戻る。
7. timeout/矛盾は `COMMIT_STATE_UNKNOWN` とし、exclusive transition と hold を維持して close-all/fix-forward 手順を示す。
8. Worker が `clientsClaim()` を呼ばないため `controllerchange` は待たない。registration.active が candidate になったら active Worker へ MessageChannel で expected identity/protocol を問い合わせる。
9. expected active identity を確認した旧 client は cache cleanup を行わず、明示 reload を一度だけ行う。
10. reload 後の bootstrap が HTML/bootstrap/controller/registration.active の同一 generation を再検査し、一致した新 client だけが §7.2 の post-bootstrap cleanup を試行する。cleanup pending/failure は記録して再試行可能にする。

waiting Worker が PREPARE 後に terminate/restart すると memory permit は失われる。APPLY は `PERMIT_NOT_FOUND` で失敗し、client は update を適用しない。再試行は全 lock/blocker 検査からやり直す。

PONR または `COMMIT_STATE_UNKNOWN` 後に active identity が 10 秒で得られない場合は mutable App を再開せず、lifecycle/exclusive presence と hold を維持する。tab を閉じれば browser が lock を解放する。自動 reload と legacy package rollback を行わず、全 client を閉じるか、現在の floor と互換な fix-forward package を配布する。cleanup timeout は activation timeout と分け、active identity が一致する限り後続の cleanup retryへ送る。

必須 reject test は次のとおり。

- expired nonce
- replay/reuse
- requester 消失
- source client ID 不一致
- client set 追加/削除
- page/controller/registration.active/installing/waiting identity 不一致
- protocol mismatch
- Worker restart
- blocker 再発
- lock loss
- `skipWaiting` failure
- activation ack timeout と commit-state ambiguity
- active Worker restart、cleanup permit loss、cleanup retry
- natural activation では削除せず、新 tab race 後も post-bootstrap の exclusive/client-set proof まで旧 cache を保持すること

### 14.8 Web Locks 非対応

Web Locks がない browser では running app からの「今すぐ更新」を無効にする。全 client を閉じた後の browser 標準 activation と再起動だけを許可し、手動 reload を繰り返さない。

## 15. Phase 1 の分割

`P1P-SEAMS` を Phase 1A の着手条件とし、PWA 実装と巨大な persistence/App 分割を同じ PR に混ぜない。

### 15.1 Phase 1A: QA-only parity

- production `generateSW/autoUpdate` は変更しない。
- QA variant だけで `injectManifest` custom Worker を build する。
- route policy、navigation、offline、precache、Tailwind route の parity と、削除済み Supabase browser route の allowlist 差分を証明する。
- current autoUpdate → `prompt-close-all` bridge → `prompt` candidate の transition harness を先に作る。
- 長期休眠 client 用に `legacy-auto` → `prompt` の bridge skip、最古の保持対象 prompt-compatible floor → current candidate、複数 phase skip、unknown protocol を transition fixture に含める。
- browser verifier へ custom Worker の install/activate/route/offline と旧 package → candidate の transition branch を追加する。startup state table と multi-client permit はまだ要求しない。

合格条件 `P1A-PARITY`:

- live provider/保存済み package から特定した current previous-production package から、QA bridge/candidate への全 transition test が実行可能である。
- custom Worker の scope、navigation response、offline asset、precache集合、cache name/owner が baseline と exact または review 済み allowlist 差分である。
- production promotion は禁止されたままである。

### 15.2 Phase 1B: Prompt UI と startup

- build-time `VITE_PWA_UPDATE_MODE=legacy-auto|prompt-close-all|prompt` を catalog 化する。
- default production variant は 1D まで `legacy-auto` のままにする。
- `prompt-close-all` と `prompt` の custom Worker は同じ protocol/permit を実装する。前者の page UI は future update の in-app APPLY を提示せず、close-all 手順だけを提示する。
- prompt variant に startup state table、三層 error ownership、blocker catalog、single-client protocol を追加する。
- persistence hook は root の `ReloadSafetyStore` へ mutation/save/recovery epoch と状態を publish する。状態不明を safe にしない。
- browser verifier へ startup state table、三層 error owner、blocker、single-client permit branch を追加する。

合格条件 `P1B-PROMPT`:

- blocker 表の正負 E2E がすべて通る。
- blocker catalog の owner coverage が 100% で、root unload guard と PWA guard が同じ snapshot を使う。
- root 欠落、registration/identity 不正、bootstrap import rejection、React render/lazy rejection、async operation rejection を個別に注入し、各 failure が定義した一層だけに所有され、raw error を露出しない。
- 上記各 failure を reload-safe/unsafe snapshot の双方で検査し、unsafe 時は reload/update/bootstrap retry がなく、safe 時だけ定義済み操作が一度だけ提示される。in-place retry-save/operation retry は page reload gate と混同しない。
- chunk failure 中に unsafe reload が起きない。
- pre-floor controller で reload loop が起きない。
- prompt source merge 後も production は legacy artifact のままである。

### 15.3 Phase 1C: Multi-client と cleanup coordination

- permit protocol の nonce/source/fingerprint/restart 処理を完成する。
- lifecycle lock を persistence cleanup contract へ接続する。
- reload 後の新 generation による post-bootstrap fresh cache-cleanup permit、natural activation では削除しない契約、exact allowlist、lock/client-set proof の architecture/state-machine test を追加する。
- browser verifier へ multi-client、Worker restart、post-bootstrap cleanup/race branch を追加する。
- persistence legacy `localStorage` key executor は production entry point へ接続しない。

合格条件 `P1C-MULTICLIENT`:

- 2～5 tab と hidden tab が残る間は 5 秒以内に update を拒否して shared state へ復帰し、crashed/closed tab の lock 解放後だけ再試行できる。
- tab open/close race で mutable App と exclusive transition が並行しない。
- permit reject test がすべて通る。
- lock downgrade failure が fail-closed になる。
- Release B capability は hard OFF のままである。

### 15.4 Phase 1D: Production floor

- `prompt-close-all` bridge と `prompt` の二つを完全 package 化する。
- production project に domain 未切替 candidate deployment を作り、全 bytes/header/function provenance、candidate で実行可能な副作用なし API contract を検証してから、二者承認で同じ deployment ID を alias 昇格する。
- current autoUpdate → bridge、bridge → prompt、legacy-auto → prompt direct skip は close-all/restart、prompt → newer prompt と prompt → same-floor close-all fallback は permit/reload/post-bootstrap cleanup の transition matrix を通す。
- 全 retained compatibility floor から candidate への複数 phase skip と、retention 外/unknown protocol の fail-closed hold を通す。
- prompt → legacy-auto の transition と legacy-auto の再 deploy を拒否する。

`P1D-BRIDGE` の合格条件:

- `P0-BASELINE`、`P0-TOOLCHAIN`、`P0-BROWSER`、`P0-ARTIFACT`、`P1P-SEAMS`、`P1A-PARITY`、`P1B-PROMPT`、`P1C-MULTICLIENT` が green。
- persistence Release A の external immutable baseline production evidence URI/hash が検証済みである。
- 専用 transition server の rehearsal と、本番同一 origin の installed PWA transition を分けて実施する。Service Worker を割合 traffic で canary 済みとみなさない。
- bridge package が §24.3 の初回 bridge 専用分岐を含む promotion gate、Tier 2 smoke、二者承認を通り、origin-wide 昇格後 24 時間以上の final evidence が確定している。
- provider auto-promotion は停止したままで、bridge package と legacy forensic fixture の immutable copy がある。

bridge を production alias へ昇格した時点を配布上の PONR とし、未観測 client の不在を仮定しない。以後は legacy-auto へ alias を戻さず、bridge を保持して prompt 昇格を停止し、必要なら同じか新しい protocol の `prompt-close-all` fix-forward package を共通 gate で昇格する。

`P1D-PROMPT` の合格条件:

- `P1D-BRIDGE` の final evidence が確定している。
- prompt package が §24.3 の通常 promotion gate、Tier 2 smoke、二者承認を通り、origin-wide 昇格後さらに 24 時間以上の final evidence が確定している。
- prompt と prompt-close-all fallback package の immutable copy があり、prompt → bridge/fix-forward の rehearsal が通る。

`P1D-BRIDGE` と `P1D-PROMPT` の双方が完了した時だけ集約 exit `P1D-FLOOR` を green とし、prompt package を PWA phase-floor package とする。

## 16. Phase 2A: Tailwind local CSS

### 16.1 変更

- `tailwind.config.ts`、CommonJS を明示する `postcss.config.cjs`、`src/styles/tailwind.css` を追加する。
- Tailwind 3.4.19 を exact pin する。
- `index.html` の CDN script と inline Tailwind config を削除する。
- `src/index.tsx` が app 用 `tailwind.css`、`src/bootstrap.ts` が小さい `src/styles/bootstrap.css` を importする。
- `scripts/build/createProductionSourceCatalog.mjs` が static/dynamic entry graph と明示 production allowlist から deterministic file list を生成し、Tailwind content と style architecture scan が共有する。`index.html` と到達する component/hook source だけを対象とし、`*.test.*`、`*.fixtures.*`、`src/test/**`、`*_backup.*`、`*.backup.*` を除外する。
- 動的 class 名は明示 safelist または静的 mapping へ移す。
- `src/sw.ts` から Tailwind CDN runtime route を削除する。
- import graph 0 を確認して `workbox-expiration` を direct dependency から削除する。
- local CSS を含む `prompt` と `prompt-close-all` を同じ source から package 化し、後者を P2B 後も使える新しい PWA safety fallback にする。

比較対象は Phase 0A-0 で固定した screenshot/computed-style/CDN bytes であり、実装時点の live CDN ではない。

### 16.2 合格条件 `P2A-LOCAL`

- HTML、source、network、Service Worker route に Tailwind CDN request がない。
- production scenario の class 欠落と、test/fixture/backup だけからの class 混入が 0 である。
- deterministic screenshot の unmasked pixel diff が各画面 0.1% 以下で、layout/visibility/font-size/color の選択済み computed-style field が exact 一致する。antialias mask と意図差分は owner/reviewer 付き allowlist に限定する。
- online install/control 済み profile を完全終了した後の offline relaunch で同じ CSS が適用される。
- CSS size budget を満たす。
- 旧 `tailwind-cache` が残っていても参照されない。
- PWA phase-floor への rollback が可能である。

`P2A-LOCAL` package を Tailwind phase-floor とする。

## 17. Phase 2B: Legacy Tailwind cache cleanup

`P2A-LOCAL` を production で受け入れた後の別 artifact で実施する。

- `src/sw.ts` の exact allowlist に旧 `tailwind-cache` 名を一つだけ追加する。
- §7.2 の reload 後 post-bootstrap fresh cleanup permit だけで idempotent cleanup を行い、同じ page の ack/status query と次の page の status query の双方で残存 0 を確認する。
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

- theme anti-flash は `src/themePrepaint.ts` を入力とする same-origin content-hashed classic script へ移し、初回 paint 前に head で `defer`/module にせず読み込む。storage access failure を固定 fallback theme へ閉じる。
- loading/viewport 処理は Phase 1 で bootstrap へ移動済みとし、Phase 3 では再移動しない。
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
frame-src 'none';
```

Google Sheets 導線で redirect origin が追加で必要な場合は、`google-sheets-online` の固定 public fixture を production 同等 provider origin から実行し、request/redirect/final response の実 origin chain を capture する。実在を証明した exact origin だけを追加し、未接続の Supabase client origin は許可しない。

`style-src-attr 'unsafe-inline'` は全 style attribute を許可する例外であり、React 由来だけを CSP が識別するものではない。source 正本を `config/style-sink-allowlist.json`、production entry graph + AST scan の deterministic 出力を `out/analysis/style-sink-catalog.json` とし、JSX style、style object、CSSOM mutation を owner、property、value provenance、許可理由付きで照合する。generated catalog は evidence へ含めるが source allowlist を自動更新しない。test/fixture/backup の削除で production sink の追加を相殺できない fingerprint を使う。新規追加は原則 failure とし、drag clone と Phase 5 virtual row など承認済み layout owner だけ、`position/top/left/width/height/transform` と finite layout number/static enum 由来の値を allowlist 化する。URL、content、任意文字列を style 値へ流さない。

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
- production の JSX/style-object/CSSOM sink が property/value/owner/a11y test 付き catalog/allowlist に一致する。
- HTML、manifest、Worker、API、hashed asset の header/cache matrix が一致する。
- provider enforced-CSP 上の `google-sheets-online` が実データを読み込み、capture した全 response origin が exact allowlist と一致し、CSP violation 0 である。offline failure fixture とは別に実行する。
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

`src/types/export.ts` を `ExportOptions` と実使用 shape の `EventExportData` の正本とし、`src/utils/exportImport.ts` 内の重複 `ExportData` を削除する。既存 import が必要な間だけ `ExportData = EventExportData` compatibility alias と type test を残す。`persistenceRecoveryExport.ts` は ExcelJS module ではなく download helper へ依存させる。

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
      options: ExportOptions;
      sourceEpoch: number;
      sourceSelectionRevision: number;
      requestedAtIso: string;
      suggestedFileName: string;
    };

type XlsxTransportMessage =
  | { kind: "START"; request: XlsxRequest }
  | {
      kind: "CANCEL";
      requestId: string;
      reason: "USER_CANCELLED" | "SUPERSEDED" | "SOURCE_CHANGED" | "TIMEOUT";
    }
  | {
      kind: "CHUNK_ACK";
      requestId: string;
      streamId: string;
      sequence: number;
    }
  | {
      kind: "MAP_SECTION_CHUNK";
      requestId: string;
      schemaVersion: 1;
      mapName: string;
      section: "header" | "cells" | "merged-cells" | "blocks";
      streamId: string;
      sequence: number;
      recordCount: number;
      byteLength: number;
      sha256: string;
      payload: ArrayBuffer;
    }
  | {
      kind: "MAP_DAY_END";
      requestId: string;
      mapName: string;
      sections: Partial<
        Record<"header" | "cells" | "merged-cells" | "blocks", SectionDigest>
      >;
      daySha256: string;
    }
  | {
      kind: "EVENT_RESULT_SECTION_CHUNK";
      requestId: string;
      schemaVersion: 1;
      section: EventResultSection;
      streamId: string;
      sequence: number;
      recordCount: number;
      byteLength: number;
      sha256: string;
      payload: ArrayBuffer;
    }
  | {
      kind: "EVENT_EXPORT_SECTION_CHUNK";
      requestId: string;
      schemaVersion: 1;
      section: EventExportSection;
      streamId: string;
      sequence: number;
      recordCount: number;
      byteLength: number;
      sha256: string;
      payload: ArrayBuffer;
    }
  | {
      kind: "EVENT_EXPORT_INPUT_END";
      requestId: string;
      sections: Partial<Record<EventExportSection, SectionDigest>>;
      inputSha256: string;
    }
  | {
      kind: "MAP_IMPORT_END";
      requestId: string;
      skippedSheets: string[];
      uiError: string | null;
      chunkCount: number;
      resultSha256: string;
    }
  | {
      kind: "EVENT_IMPORT_END";
      requestId: string;
      success: boolean;
      sections: Partial<Record<EventResultSection, SectionDigest>>;
      resultSha256: string;
    }
  | {
      kind: "EVENT_EXPORT_END";
      requestId: string;
      buffer: ArrayBuffer;
      mimeType: XlsxMimeType;
      suggestedFileName: string;
      sha256: string;
    }
  | {
      kind: "CANCELLED";
      requestId: string;
      operation: XlsxRequest["kind"];
      code: "USER_CANCELLED" | "SUPERSEDED" | "SOURCE_CHANGED" | "TIMEOUT";
    }
  | {
      kind: "ERROR";
      requestId: string;
      operation: XlsxRequest["kind"];
      code: XlsxErrorCode;
      stage: XlsxStage;
      retryable: boolean;
    };
```

`XlsxMimeType` は `"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"` のみとする。

`SectionDigest` は `streamId`、`chunkCount`、`recordCount`、`byteLength`、`sha256` を持つ。map import result は `header | cells | merged-cells | blocks` の全 field を `MAP_SECTION_CHUNK` で渡す。event import result の `EventResultSection` は `event-name | metadata | items | layout-info | map-data | map-rotation-settings | map-viewport-settings | route-settings | hall-definitions | hall-route-settings | block-detection-settings | errors | item-fallback-warnings | legacy-sheet-field-fallbacks` の固定集合とし、大きくなり得る field を `EVENT_IMPORT_END` へ直書きしない。event export input の `EventExportSection` も実 `EventExportData` の同等 field を固定 section に分け、`START` へ domain object 全体を渡さない。

`contracts/xlsx-stream-v1.json` を section codec の正本とする。scalar/singleton object は一 record、`items`/errors/warnings は array element を一 record、layout は `dayModes`/`executeModeItems` の key-sort entry、map-data は day header と `cells`/`mergedCells`/`blocks`、rotation/viewport/route/hall 系は top-level key-sort entry と nested array elementを record 境界にする。object key、section、mapName、record の順序を schema で固定する。

同 contract は operation/options ごとの presence matrix も持つ。map day は `header/cells/merged-cells/blocks` が必須、event import は `event-name/items/errors` が必須、event export は `version/event-name` と options が要求する `items/layout-info/map-data/route-settings` 系 section が必須である。必須だが値が空の section は zero-record `SectionDigest` を送り、optional source が存在しない場合だけ field を省略する。unknown、forbidden、duplicate、missing section と option/presence 不一致は `SCHEMA_MISMATCH` にする。

chunk payload は上記 schema に従う canonical UTF-8 JSON token stream の Transferable `ArrayBuffer` とし、単独 chunk が完全な JSON document であることを要求しない。一 chunk は completed logical record 250 件以下かつ 2 MiB 以下とする。一 logical record が 2 MiB を超える場合は UTF-8 code point/JSON token 境界で連続 chunk に分け、中間 chunk の `recordCount=0`、record が完了する chunk だけ `recordCount=1` とする。single text/aggregate text 上限は別途適用する。main 側の export encoder と import result decoder は 8 ms 以下の scheduler slice ごとに yield し、domain object の一括 `structuredClone`/`JSON.stringify`、section 全体の一括 `JSON.parse` を禁止する。decoder は非公開の組立 state へ追加し、全 digest 検証後に完成 result reference を一度だけ publish する。

`streamId` は request/方向/section/mapName から決定的に作る。chunk SHA-256 は payload bytes、section SHA-256 は sequence 順 payload bytes の連結とする。day SHA-256 は mapName と section sort 済み `SectionDigest`、operation SHA-256 は START metadata、day digest、streamId sort 済み section digest、terminal metadata の canonical JSON から算出する。terminal metadata は `MAP_DAY_END` の全 field、`MAP_IMPORT_END` の skipped sheets/uiError/chunk count、`EVENT_IMPORT_END.success` を含み、digest 自身だけを除外する。presence matrix、zero-record digest、canonical empty value も contract fixture で固定する。

ACK、sequence、size、digest、count を stream ごとに検証し、欠落・重複・順序逆転・digest 不一致を `SCHEMA_MISMATCH` とする。Worker は `EVENT_EXPORT_INPUT_END` の全 section digest/presence を検証してから workbook を作る。main adapter は import の全 section/end digest を検証してから、map を現 `ParseMapFileResult`、event を現 `ImportResult` と byte/semantic compatible な domain result へ一度だけ公開する。map parse が sheet error を返す場合は受信済み chunk を破棄し、`data: null` と既存 `skippedSheets/error` を再構成する。

`XlsxErrorCode` は `FILE_TOO_LARGE | ZIP_ENTRY_LIMIT | ZIP_EXPANDED_TOO_LARGE | ZIP_RATIO_EXCEEDED | ZIP_STRUCTURE_INVALID | ENCRYPTED_ARCHIVE | UNSUPPORTED_COMPRESSION | SHEET_LIMIT | CELL_LIMIT | TEXT_LIMIT | SCHEMA_MISMATCH | SOURCE_CHANGED | UNSUPPORTED_FORMAT | PARSE_FAILED | SERIALIZE_FAILED | WORKER_CRASHED | TIMEOUT | BUSY`、`XlsxStage` は `preflight | unzip | parse | validate | serialize | transfer` の固定集合とする。

UI に必要な既存の sheet 名/row 番号/固定日本語診断は bounded `uiError`/warning として保持するが、log/evidence には redacted code/stage/count だけを出す。raw Error、stack、cell content、利用者ファイル名を記録しない。import の `START` は file name/options と Transferable file `ArrayBuffer`、export の `START` は options/sourceEpoch/sourceSelectionRevision/requestedAt/suggested name だけを持ち、domain data は section chunk で渡す。いずれも `File`/`Blob`/DOM object を Worker へ渡さない。

### 19.3 Port と owner

- `XlsxExecutionPort` の owner は app root の単一 provider とする。
- `App.tsx` event import、`features/events/exportFlow.ts`、`components/map/MapImportDialog.tsx` へ同じ port を inject する。
- 同時 CPU operation は一件だけとする。map preview は latest-wins で前 request を `SUPERSEDED` にし、event import/export は実行中 request を置換せず新 request を `BUSY` で拒否する。暗黙 FIFO は作らない。
- provider が Worker の create、terminate、crash recovery、request ID、blocker token を所有する。
- `XlsxSourceSnapshotPort` は export `START` で persisted mutation epoch と event/date selection revision、root data reference を一度だけ捕捉する。全 export source mutation、event/date switch、import/restore は command 開始前に対応 epoch/revision を同期更新する。
- incremental encoder は各 scheduler slice の前後と `EVENT_EXPORT_INPUT_END` 直前に snapshot を再照合する。変化時は `SOURCE_CHANGED` で CANCEL し、Worker は受信済み section を破棄して workbook/download を生成しない。React state の immutable reference contract を characterization/architecture test で固定し、in-place mutation を禁止する。
- `AbortSignal` 自体は Worker へ送らない。main owner が abort を明示 `CANCEL(requestId)` へ変換し、250 ms 以内に cancel ack/settlement がなければ Worker を terminate/recreate する。
- operation-specific chunk は sequence ごとの `CHUNK_ACK` を受けるまで次を送らず、backpressure と cancel の順序を protocol test で固定する。
- cancel/timeout/crash/terminate 時は全 pending Promise を一度だけ settle し、port、timer、blocker、chunk buffer、transferred buffer reference を必ず cleanup する。
- component は Worker instance と ExcelJS を直接 import しない。
- rollout 中の paired fallback は同じ port と同じ ZIP/XML preflight/resource policy を main-thread adapter で実装し、contract を変えない。M2 後は adapter を削除し、Worker 非対応 browser では XLSX を明示的に利用不可とする。

owner path は次に固定する。

```text
src/features/xlsx/
  XlsxExecutionPort.ts
  XlsxExecutionProvider.tsx
  workerXlsxAdapter.ts
  mainThreadXlsxAdapter.ts
  incrementalSectionCodec.ts
src/workers/
  xlsxContracts.ts
  xlsx.worker.ts
```

`mainThreadXlsxAdapter.ts` だけは M2 で削除する。contract、provider、incremental section encoder/decoder は Worker 専用になった後も残す。

### 19.4 Resource limit

`config/xlsx-resource-policy.json` を UI、Worker、rollout 中 main adapter の正本とする。UI の同期 preflight は file byte size、拡張子、operation concurrency だけを検査し、ZIP inflate/XML scan は Worker 内、main fallback package だけ main adapter 内で実行する。次は絶対上限であり、固定 Tier 2 memory test が要求する場合は package 前に同じ config で引き下げる。未確定値では `P4-XLSX` を通さない。

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

`@zip.js/zip.js 2.8.34` と `saxes 6.0.0` を exact pin する。encrypted entry、未対応 compression、normalized path の重複/曖昧性、entry overlap、central/local header 不一致、signature/CRC 不一致、size/offset/ZIP64 overflow を拒否する。各 entry を bounded streaming inflater で逐次計数し、single/aggregate 上限で直ちに停止する。続いて `workbook.xml`、worksheet XML、`sharedStrings.xml` を bounded SAX parser で走査し、sheet/cell/text 数を ExcelJS materialize 前に検査する。preflight 自体が entry 全体を一括保持しない。

上限超過は固定 error code で返し、Worker を terminate して blocker を確実に解除する。偽装 declared size、local/central 不一致、CRC 不一致、巨大 sheet、高圧縮、cancel race を fixture 化する。

event export は入力 domain row/cell/text 数を workbook 作成前に同じ上限で検査する。timeout は runaway CPU の停止策であって OOM 防止とはみなさず、ExcelJS materialize 後の peak memory/RSS と Worker crash を desktop/Tier 2 fixture で測り、memory budget 超過なら上限を引き下げる。

### 19.5 Semantics

- map import preview は最新 request ID だけを採用する。
- event import は既存 backup、validation、selected-event restore semantics を維持する。
- event export coordinator は `requestedAtIso` を一度だけ生成し、既存 ISO 変換規則の filename と Worker 内 `workbook.created`/`exportDate` に同じ値を使う。既存 filename、sheet、cell 表現を deterministic golden workbook で検査する。
- `ArrayBuffer` は Transferable とし、不要な clone をしない。
- export workbook は Transferable `ArrayBuffer` で返し、main adapter だけが Blob/download を作る。map/event import result と event export input は 250 record または 2 MiB の小さい方の section chunk、ACK/backpressure、明示 CANCEL で渡し、両方向の巨大な一括 structured clone を禁止する。
- offline XLSX 契約を維持するため Worker/ExcelJS chunk は Service Worker precache に残し、page 初期 request graph と precache install transfer を別 budget で測る。
- Worker crash、chunk load failure、timeout は port owner と async failure coordinator が扱い、React Error Boundary の責務にせず、自動 reload しない。

### 19.6 合格条件 `P4-XLSX`

- ExcelJS が page client 初期 module/request/evaluation graph に 0 件。
- Worker precache/network transfer は別予算で計上され、初期 page graph と混同しない。
- map import、event import、event export の golden output が一致する。
- operation-specific section chunk/end の sequence/size/digest と legacy result shape が一致する。
- export encode 中の item/map edit、event/date switch、import、restore interleave が `SOURCE_CHANGED` で全 section を破棄し、異なる source 世代を一 workbook に混在させない。
- ZIP ambiguity/overlap/encryption/CRC/ZIP64、resource/memory limit、error redaction test が通る。
- Worker ON candidate で main-thread long task 50 ms 超が 0。main fallback は §8.7 の fallback 基準を使う。
- Tier 1 required、Tier 2 重大障害なし。
- Worker ON、同一 preflight を使う paired main fallback、prompt-close-all+main safety fallback を同じ source から保存する。

production 既定 ON は paired transition と canary 後にだけ行う。

## 20. Phase 5: ShoppingList virtualization

### 20.1 Virtualizer と port

`@tanstack/react-virtual 3.14.9` の `useWindowVirtualizer` を exact pin し、audit/bundle budget を通す。DOM 操作を business navigation、drag/drop の domain 判断から切り離す。

既存 owner の `src/features/lists/` を拡張し、`rangeSelection.ts`、`movePlan.ts`、`useListInteractionState.ts` と同じ domain 境界へ追加する。別の `shopping-list` feature tree は作らず、`src/components/ShoppingList.tsx` は assembly/facade にする。

```text
src/features/lists/
  domain/rangeSelection.ts
  domain/movePlan.ts
  hooks/useListInteractionState.ts
  model/listRows.ts
  ports/listViewportPort.ts
  ports/listInteractionPort.ts
  renderers/FullShoppingListRenderer.tsx
  renderers/VirtualShoppingListRenderer.tsx
  hooks/useListRendererPreference.ts
```

```ts
interface ListViewportPort {
  ensureMounted(
    target: RowAddress,
    signal: AbortSignal,
  ): Promise<ViewportHandle>;
  scroll(handle: ViewportHandle, options: ScrollOptions): Promise<void>;
  focus(handle: ViewportHandle, options: FocusOptions): Promise<void>;
  getEpoch(): number;
  cancel(reason: ViewportCancelReason): void;
}

interface ListInteractionPort {
  hitTest(clientY: number, epoch: number): RowAddress | null;
  pin(target: RowAddress, reason: "focus" | "drag" | "drop"): PinToken;
  unpin(token: PinToken): void;
  getAutoScrollTarget(clientY: number): AutoScrollTarget | null;
}
```

`useExecutionSpaceNavigator` は history/business guard を所有し、viewport port を inject される。直接 DOM caller である `App.tsx` の mode/search 遷移、`AppOverlayLayer.tsx` の edit-save、`useExecutionSpaceNavigator.ts` を先に移行する。`elementFromPoint`、`querySelectorAll`、DOM 非存在を item/space の business identity、削除、drop 可否の正本にしない。

### 20.2 Row model と window

full/virtual renderer は同じ operation-specific `ListRow` discriminated union を入力にする。

```ts
type ListRow =
  | { kind: "hall-header"; key: string; hallId: string; sticky: true }
  | {
      kind: "space-header";
      key: string;
      address: SpaceAddress;
      collapsed: boolean;
    }
  | { kind: "item"; key: string; address: ItemAddress; itemId: string }
  | { kind: "auxiliary"; key: string; role: AuxiliaryRowRole };
```

- key は row kind + stable domain ID/address から作り、array index を使わない。collapsed header は先頭 item の navigation anchor として明示的な `RowAddress` を持つ。
- filter/sort/group の domain result と render window を別 memo にする。
- variable height は `ResizeObserver` の measured cache、row-model epoch、window-scroll anchor compensation で管理する。
- focus target は `ensureMounted` 完了後にだけ scroll/focus する。
- search/mode/event change は古い operation を AbortController で cancel する。
- `rangeExtractor` は active sticky header、focused row、drag source、drop target を pin し、drag 中は bounded overscan と auto-scroll target を使う。DOM 非 mount/消失を business deletion と誤認しない。
- full renderer も同じ row model/interaction semantics を使い、virtual 専用の別 sort/group rule を作らない。

### 20.3 Accessibility fallback

full renderer は恒久実装として残す。

- list の前に keyboard/focus 可能な表示設定を置き、利用者が full/virtual を選べる。control は常に表示し、drag/edit/save/restore 中だけ理由付き `aria-disabled` とする。
- screen reader の自動検出は行わない。focus recovery failure を検出した場合は、操作 idle 後に full renderer へ切替を提案する。
- drag、edit、save、restore 中には renderer を切り替えない。
- preference key は `event-shopping-planner:list-renderer:v1`、value は `full | virtual` とする。missing は rollout 中だけ variant default、M2 後は固定 product default `virtual` を使う。invalid/storage read error は `full`、full-only package は強制 full だが保存済み preference を上書きしない。event/IndexedDB data へ混ぜない。
- virtual mode は visible row に `aria-setsize`/`aria-posinset`、row/group label、roving focus、unmounted target の focus recovery、live announcement を持つ。すべての row を同時 mount した screen-reader sequential browse は要求せず、その完全経路は常設 full renderer が保証する。

### 20.4 合格条件 `P5-LIST`

- 100、1,000、5,000 行 fixture で表示、scroll、search、edit、drag、mode change が正しい。
- scroll/focus target miss 0。
- virtual で keyboard/search/focus/drag の mounted-target semantics、full で完全 sequential screen-reader browse が通る。切替 control は常に discoverable/focusable で、操作中は理由付き disabled、idle 復帰後は直ちに利用できる。
- sticky hall/space、collapsed anchor、range、touch/native DnD、ResizeObserver/anchor compensation の fixture が通る。
- virtual/full-only がそれぞれ §8.7 の variant 別 latency budget を満たす。
- virtual ON と full paired-fallback package を保存する。
- rollout flag を OFF にすると同じ domain state で full renderer が動く。

M2 で削除できるのは build-time rollout default-selection 分岐だけである。runtime preference、full renderer、利用者向け accessibility fallback は削除しない。

## 21. Phase 6: `App.tsx` 分割

### 21.1 目標責務

`App.tsx` に残してよいのは次だけとする。

- root composition
- provider wiring
- internal top-level screen selection
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

raw setter の束を渡さず、intent command と read model を interface にする。Phase 1P の persisted mutation adapter をこの command layer へ接続し、別経路を作らない。

実質 `string` である重複 `ActiveTab` は単純統一せず、router 非依存の discriminated union に置換する。

```ts
type ScreenState =
  | { kind: "event-list" }
  | { kind: "import" }
  | {
      kind: "event-day";
      eventName: string;
      eventDate: string;
      viewMode: DayViewMode;
      mapView: MapViewState;
    };
```

event rename/delete/duplicate、restore、date change、edit/execute/focus、map/list toggle の transition table を正本にし、利用者 event/date 文字列と `"event-list"`/`"import"` tag を同じ namespace で比較しない。予約語と同名の event/date fixture を必須にする。

### 21.2 Operation semantics

抽出前に現行の commit timing、state 適用後の通知、10 store の部分保存、rollback、operation 排他、stale completion を characterization test で固定する。domain/apply outcome と persistence durability を別状態にする。

- operation ID と abort signal を持つ。
- stale completion は state を上書きしない。
- domain validation/apply success は現行 timing で通知できるが、persistence indicator と update blocker は全 dirty store の durable 完了まで残す。
- domain command が persistence 開始前に失敗した場合だけ domain rollback を行う。
- persistence の部分成功/失敗後は UI state を rollback せず、`failed`、retry、backup/export/recovery 導線を維持する。既に保存済み store と UI を逆方向へ不整合にしない。
- atomic restore など既存 transaction owner がある操作だけは transaction 結果に durability 表示を結び付ける。
- backup restore、event switch、import の排他を state machine で表す。

### 21.3 Test

- Phase 0B で置換済みの behavior contract test を module 境界へ移し、source string assertion を再導入しない。
- extracted hook/module は isolated test を持つ。
- app-shell integration は user intent → state → persistence call → UI result を検査する。
- React lazy chunk/load boundary は root Error Boundary test を再利用する。

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
  assembly/
    browserPersistenceAssembly.ts
  transactions/
    transactionCoordinator.ts
    transactionCapabilities.ts
  stores/
    appDataStores.ts
    mapDataStores.ts
    syncControlStore.ts
  codecs/
    mapDataCodec.ts
    persistenceRecordCodecs.ts
  repositories/
    appDataRepository.ts
    mapDataRepository.ts
    backupRepository.ts
    controlRepository.ts
  migration/
    migrator.ts
    persistenceCleanupCoordinator.ts
    legacyCleanupService.ts
    legacyLocalStorageAdapter.ts
  recovery/
    inspectRecoveryState.ts
    recoveryService.ts
    recoveryExport.ts
  reload-safety/
    reloadSafetyStore.ts
  resilience/
    validators.ts
    serializers.ts
    reconcile.ts
    identityFactory.ts
  ports/
    clockPort.ts
    cleanupControlPort.ts
    cleanupTransactionPort.ts
    entropyPort.ts
    cryptoPort.ts
    recoveryInspectionPort.ts
    persistenceMetricsPort.ts
  adapters/
    browserClockCryptoAdapters.ts
    releaseAMetricsAdapter.ts
```

### 22.3 `syncQueue` と transaction

- queue payload と control record は既存 stored field を読む in-memory type guard で論理分離する。persisted record へ discriminant field を追加せず、物理 `syncQueue` store の名前、key、record shape を変えない。
- metadata/checkpoint、migration journal/archive、control record の access source of truth は `syncControlStore.ts` にする。
- 10 個の app payload store と物理 `syncQueue` store にまたがる atomic write は `transactionCoordinator` だけが開始する。
- repository が別 transaction を暗黙開始しない。
- app data restore は現行 10 app stores を対象とし、`syncQueue` 本体を復元しない。
- migration/recovery の crash point ごとに reopen test を持つ。

### 22.4 Cleanup と resilience

- `persistenceCleanupCoordinator.ts` は判断と lock 調停を維持し、現 utils path は compatibility re-export にする。
- Phase 1P で抽出済みの `migration/legacyCleanupService.ts` は現 `executePhysicalLegacyCleanup` の journal/archive、target validation、entry claim、CAS、readback、crash resume、直前 revalidation を維持し、Phase 7 で再実装しない。
- `migration/legacyLocalStorageAdapter.ts` は exact legacy key の read/remove だけを持つ。service は IndexedDB control data を使うが IndexedDB 自体を削除しない。
- 既存 `db.cleanupLegacyPersistenceSources` public method は service への compatibility delegate として維持する。
- 既存 `src/utils/persistenceResilience.ts` の deterministic validator/serializer/reconcile を複製せず対応する pure module へ move し、compatibility re-export を残す。
- `Date.now`/`new Date`、`Math.random`、`crypto.getRandomValues`/`randomUUID` を使う writer ID/revision/candidate factory は `identityFactory.ts` へ分離し、`ClockPort`、`EntropyPort`、`CryptoPort` を inject する。既存 ID/revision format と ordering を golden test で維持する。
- pure resilience module は DB、React、clock、entropy、crypto へ依存しない。
- recovery service は pure helper と repository を組み立てる。
- `inspectRecoveryState.ts` は Phase 1P の read-only semantics を維持し、facade の inspection factory と bootstrap は `RecoveryInspectionPort` だけで接続する。
- 現 `mapDataPersistence.ts` の serialization/normalization は codec + map repository adapter へ一つずつ移し、互換 re-export を残す。
- 現 `indexedDB.ts` が emit する Release A metrics は `PersistenceMetricsPort`/`releaseAMetricsAdapter.ts` へ移し、root browser assembly が既存 backend を installする。event name、順序、count、`buildId=sourceSha` payload と metrics v1 client/API/SQL contract を golden/exhaustive test で維持する。
- Release B entry point、production proof provider、kill switch は追加しない。

### 22.5 Facade

`src/persistence/index.ts` を canonical facade、既存 `src/utils/indexedDB.ts` を compatibility shim とする。compatibility shim は既存 default/named export と型を re-export するだけとし、新しい実装 entry point にしない。

facade の内容を次に限定する。

- public type/constant の re-export
- compatibility alias
- dependency assembly
- public repository/service factory
- read-only recovery inspection factory

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

| Dimension            | 値                     | Production/build policy                                                                          |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `pwaUpdateMode`      | `legacy-auto`          | P1D 前の baseline/transition fixture 専用。bridge activation 後は production build/deploy を拒否 |
|                      | `prompt-close-all`     | P1D bridge と各 asset/security floor で更新する PWA fallback。page の APPLY UI だけ無効          |
|                      | `prompt`               | P1D 後の canonical production                                                                    |
| `tailwindDelivery`   | `cdn`                  | P2A まで。P2A source merge 後は新規 build を拒否し、P2B までは保存済み fallback だけ保持         |
|                      | `local`                | P2A 後の canonical production                                                                    |
| `xlsxExecution`      | `main`                 | Phase 4 rollout 中の paired fallback。M2 後は新規 build を拒否し、保存済み package だけ保持      |
|                      | `worker`               | Phase 4 後の canonical production                                                                |
| `listRendererMode`   | `full-only`            | Phase 5 rollout 中の paired fallback。保存済み package は virtual preference を強制無効          |
|                      | `dual-default-full`    | Phase 5 QA/canary 専用                                                                           |
|                      | `dual-default-virtual` | Phase 5 後から M2 前までの canonical。runtime preference と full renderer を含む                 |
| `persistenceCleanup` | `release-a-off`        | 唯一の許可値                                                                                     |

`verify:variant-policy` は phase、release channel、source capability に対する valid combination を descriptor 生成前に検査し、retired implementation を source から復活させる build を拒否する。

同じ source SHA でも variant ごとに `buildInputId` と package ID が異なる。

M2 source では `xlsxExecution` と `listRendererMode` を現行 producer catalog の受理値、生成する descriptor schema、実装分岐から削除する。post-M2 canonical は名称付き旧 variant ではなく「Worker adapter + runtime renderer preference + 固定 product default virtual」とし、main-thread XLSX adapter と build-time list default selector を新規 build input として受理しない。一方、保存済み package の保持期間中は同梱された variant catalog/schema snapshot を読む versioned archive decoder と schema fixture を read-only verifier 内に残し、旧値から build/runtime 分岐を復活させない。`pwaUpdateMode` と `persistenceCleanup` は安全 fallback/Release A contract のため producer に残す。

既存 persistence metrics は `buildId=sourceSha` 集約のまま維持し、variant 比較や M2 の採否には使わない。本計画の variant 観測は deployment ID、package ID、browser test evidence、incident 記録で行う。metrics schema を将来拡張する場合は Release A evidence v1 と別の versioned migration/contract とする。

### 24.2 Rollout 単位

- PWA prompt: Phase 1D で bridge → prompt の二段階 floor
- Tailwind: 2A local floor、2B cleanup の二 release
- XLSX: Worker OFF/ON paired package
- list: full-only/dual paired package
- App/IDB 分割: feature flag ではなく characterization contract を維持する package

Phase 5 から M2 removal PR の直前まで、shared App/persistence を変更する PR と production candidate は次の五 package を同じ source から固有 output path へ buildし、検査・保存する。

1. prompt + Worker + dual-default-virtual
2. prompt + main-thread XLSX + dual-default-virtual
3. prompt + Worker + full-only
4. prompt + main-thread XLSX + full-only
5. prompt-close-all + main-thread XLSX + full-only（lifecycle/性能機能の最小 safety fallback）

Phase 4 rollout は prompt+Worker、prompt+main、prompt-close-all+main safety fallback の三 package、Phase 1 は legacy transition fixture + bridge + prompt、Phase 2/3 は prompt と prompt-close-all および保存済み CDN floor → local の transition を required matrix とする。`quality:pr` は変更領域から required variant を機械選択し、`quality:artifact` は production candidate と全 paired/safety fallback を検査する。

M2 removal 後、Phase 7 source から保存した最終五 package は `phase-floor package` として扱う。M2 source は次の二 packageだけを buildする。

1. prompt + Worker + runtime renderer preference（canonical candidate）
2. prompt-close-all + Worker + runtime renderer preference（PWA safety fallback）

M2 gate はこの二 package と、各 package に同梱した catalog/schema snapshot を versioned archive decoder で読む保存済み Phase 7 floor の transition/restore/hash を検証する。retired `main`/`full-only`/`dual-default-*` を M2 producer/descriptor が新規 build 値として受理してはならない。

### 24.3 共通 production promotion gate

`P1D-BRIDGE`、`P1D-PROMPT`、`P2A-LOCAL`、`P2B-CACHE`、`P3-CSP`、`P4-XLSX` rollout、`P5-LIST` rollout、`P6-APP`、`P7-IDB`、`LINT-ZERO`、M2 package はすべて次を順に通す。

1. candidate と phase 時点で有効な paired fallback の `quality:artifact`、live audit、waiver freshness を確認する。初回 `P1D-BRIDGE` は prompt-compatible paired fallback がまだ存在しないため、bridge candidate、legacy transition fixture、step 2 の fix-forward drill を要求し、legacy package を fallback とみなさない。M2 は保存済み Phase 7 floor の hash/restore evidence を代わりに使う。
2. `release:preflight` で env、DB history/live fingerprint、WAF/route/provider prerequisite、rollback floor を確認する。初回 `P1D-BRIDGE` だけは prompt-compatible rollback floor が存在しないため、legacy へ戻さない alias freeze、prompt 昇格中止、同一以上 protocol の `prompt-close-all` fix-forward 作成・検証・緊急承認 runbook/drill を代替 prerequisite とする。
3. production project に domain 未切替の immutable candidate deployment を一度だけ作る。
4. 全 static bytes/header/MIME、function provenance、candidate で実行可能な API contract、package/deployment identity を照合する。
5. Release/Data Safety/Operations のうち変更リスクに必要な二者が同じ deployment ID を承認する。
6. 再 deploy せず、その deployment ID を production alias へ昇格する。
7. production URL から全 identity/header、invalid-schema 400 の副作用なし API、current package/deployment に束縛した valid 202→bounded observation count 増分、installed-PWA transition を再照合する。valid event は一回だけ送り、最大 5 分を 15 秒間隔で read-only poll し、追加 POST で再試行しない。
8. 最低 24 時間観測し、新しい immutable evidence fragment を生成して final evidence を確定する。

観測中に停止条件へ達した場合は、既存の承認済み prompt-compatible deployment へ alias を戻す。deployment が失効している場合だけ保存済み prebuilt package を deployし、全 hash/provider parity を再検証する。初回 `P1D-BRIDGE` は alias 昇格前なら promotion を中止し、昇格後は bridge alias を維持して prompt を停止し、同じか新しい protocol の `prompt-close-all` fix-forward だけを許可する。いずれも legacy-auto へ戻さない。各正式 exit はこの共通 gate の final evidence なしに完了しない。

### 24.4 M2 観測 ADR

Phase 4/5 の rollout flag 削除前に ADR を作成し、次を具体値で埋める。

- 暦日 14 日以上
- 連続 production candidate 2 件以上
- Tier 1 全 required run 各 5 回以上
- Tier 2 対象 device/browser 各 2 回以上
- 定義済み観測源で確認された再現可能な data loss、reload loop、chunk skew、操作不能 incident 0
- stop condition と rollback package
- evidence 保存先
- Release/Data Safety/Operations owner
- 日次確認頻度、alert 経路、go/stop 権限
- incident evidence の保存先

観測源は scheduled synthetic PWA、provider availability/error/WAF log、daily audit、既存 Release A evidence、Tier 2 manual run、incident register に限定する。存在しない Worker/virtual 利用率、population failure rate、利用者行動を推定しない。新しい利用者 telemetry が必要なら本計画外の ADR とする。

### 24.5 即時停止条件

次のいずれかで promotion を停止し、承認済み immutable prompt-compatible deployment へ alias を戻す。失効時だけ保存済み package を prebuilt deploy して全 hash を再照合する。初回 bridge の alias 昇格後だけは legacy deployment へ戻さず、bridge を維持して prompt を停止し、`prompt-close-all` fix-forward 手順へ移る。

- data loss、restore failure、schema mismatch
- PWA reload loop、multi-tab update、blocker 無視
- package と provider bytes/header の不一致
- CSP による主要操作不能
- XLSX output semantic mismatch、resource limit bypass
- scroll/focus target miss、keyboard 操作不能
- audit の新規 reachable critical/high
- evidence、package、required migration set/live fingerprint prerequisite の欠落

rollback 後も DB schema を戻さない。前方互換 floor を満たす package だけを選ぶ。

## 25. Milestone

### M0: 配布安全基盤

- `P0-BASELINE`
- `P0-TOOLCHAIN`
- `P0-BROWSER`
- `P0-ARTIFACT`
- `P1P-SEAMS`
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
- Phase 7 完了 source から五 variant の最終 paired package を保存・復元検証
- XLSX rollout 専用 main-thread adapter を削除
- virtual list の rollout default-selection 分岐を削除
- M2 source から canonical prompt と prompt-close-all の二 package を作成
- M2 candidate と保存済み Phase 7 package の transition を検証し、後者を phase-floor package へ分類
- full renderer と a11y fallback を維持
- rollback package、evidence、runbook、restore drill が有効
- `M2-COMPLETE` final evidence が確定

## 26. PR 順序

| 順序 | 主リスク                             | Production promotion    |
| ---: | ------------------------------------ | ----------------------- |
|    0 | auto-deploy/approval guard           | 最初の source merge 前  |
|    1 | clean baseline capture               | 現行配布を維持          |
|    2 | capture script/schema と EOL policy  | 禁止                    |
|    3 | Node/npm/types                       | 禁止                    |
|    4 | PWA/Workbox dependencies on Vite 5   | 禁止                    |
|    5 | Vite/plugin/Vitest compatibility     | 禁止                    |
|    6 | ESLint flat config/baseline mapping  | 禁止                    |
|    7 | Playwright/a11y/Vitest projects      | 禁止                    |
|    8 | dormant Supabase/ws hygiene          | 禁止                    |
|    9 | coverage/phase-aware architecture    | 禁止                    |
|   10 | metrics v1/API/DB contract           | 禁止                    |
|   11 | DB CLI/fingerprint/retention         | 禁止                    |
|   12 | build identity/policy/manifest       | 禁止                    |
|   13 | budget/graph/Build Output verifier   | 禁止                    |
|   14 | complete package/provider verifier   | 禁止                    |
|   15 | recovery/mutation/reload-safety seam | 禁止                    |
|   16 | QA custom Worker parity              | 禁止                    |
|   17 | startup/error owners/blocker catalog | 禁止                    |
|   18 | single-client permit                 | 禁止                    |
|   19 | multi-client/lifecycle/cache cleanup | 禁止                    |
|   20 | transition matrix/bridge evidence    | `P1D-BRIDGE` 承認後のみ |
|   21 | prompt production floor              | `P1D-PROMPT` 承認後のみ |
|   22 | local Tailwind CSS                   | 承認後のみ              |
|   23 | old Tailwind cache cleanup           | 承認後のみ              |
|   24 | CSP                                  | 承認後のみ              |
|   25 | XLSX contracts/helper split          | behavior-equivalent     |
|   26 | XLSX preflight/Worker adapter        | default OFF             |
|   27 | XLSX Worker rollout                  | canary → ON             |
|   28 | viewport port/row model              | behavior-equivalent     |
|   29 | virtual renderer                     | default full            |
|   30 | virtual rollout                      | canary → virtual        |
|   31 | `App.tsx` responsibility extraction  | contract-preserving     |
|   32 | IndexedDB stores/transactions        | contract-preserving     |
|   33 | IndexedDB repository/recovery/facade | contract-preserving     |
|  34+ | lint category cleanup                | behavior-equivalent     |
| 最終 | M2 rollout branch cleanup            | 観測条件後              |

## 27. Phase exit matrix

| Exit ID           | 必須 gate                                                                                  | Rollback                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `P0-BASELINE`     | baseline hash、auto-promotion guard                                                        | current production                                          |
| `P0-TOOLCHAIN`    | runtime、typecheck、unit、audit、build                                                     | N/A: source PR を revert、current production package を維持 |
| `P0-BROWSER`      | E2E、a11y、coverage、architecture                                                          | N/A: source PR を revert、current production package を維持 |
| `P0-ARTIFACT`     | reproducibility qualification、complete package、QA provider parity                        | N/A: source PR を revert、current production package を維持 |
| `P1P-SEAMS`       | recovery probe、mutation epoch、unload/blocker owner                                       | N/A: source PR を revert、current production package を維持 |
| `P1A-PARITY`      | QA transition/offline/navigation                                                           | N/A: source PR を revert、current production package を維持 |
| `P1B-PROMPT`      | startup state、三層 error owner、blocker catalog                                           | N/A: source PR を revert、current production package を維持 |
| `P1C-MULTICLIENT` | permit、locks、cleanup contract                                                            | N/A: source PR を revert、current production package を維持 |
| `P1D-BRIDGE`      | legacy transition、provider、初回専用 promotion gate、24h final evidence                   | bridge 維持 + prompt-close-all fix-forward                  |
| `P1D-PROMPT`      | bridge transition、provider、通常 promotion gate、24h final evidence                       | 承認済み bridge/fix-forward                                 |
| `P1D-FLOOR`       | `P1D-BRIDGE` と `P1D-PROMPT` の final evidence を集約                                      | 承認済み bridge/fix-forward                                 |
| `P2A-LOCAL`       | visual、offline、network、CSS budget、promotion gate                                       | P1D floor。P2B 後は P2A local floor                         |
| `P2B-CACHE`       | exact cleanup、offline、transition、promotion gate                                         | P2A local floor                                             |
| `P3-CSP`          | enforced CSP/header/provider、promotion gate                                               | 最新の prompt-compatible local-CSS floor                    |
| `P4-XLSX`         | semantic、resource、performance、paired package、promotion gate                            | Worker OFF pair                                             |
| `P5-LIST`         | behavior、a11y、performance、paired package、promotion gate                                | full-only pair                                              |
| `P6-APP`          | responsibility、ScreenState、race、integration、promotion gate                             | prior accepted five-package floor                           |
| `P7-IDB`          | schema、transaction、recovery、facade、promotion gate                                      | prior forward-compatible five-package floor                 |
| `LINT-ZERO`       | lint/disable baseline empty、promotion gate                                                | prior accepted package                                      |
| `M2-COMPLETE`     | 全 exit、14日/2 candidate 観測、五 floor restore、branch removal、canonical final evidence | Phase 7 の承認済み prompt-compatible floor                  |

上位 milestone はこの表の exit ID を参照し、同じ受入条件を別の意味で再定義しない。

## 28. 全体完了条件

次のすべてを満たした時だけ本計画を完了とする。

1. `M2-COMPLETE` の final evidence が確定している。
2. production は保存済み release package からのみ配布され、source merge が自動 production promotion を起こさない。
3. page、active/waiting Worker、release package、provider deployment の identity を追跡できる。
4. provider と Worker の route policy が一致し、unknown asset/API が HTML fallback しない。
5. PWA update は blocker、multi-tab、pre-floor、Worker restart、commit ambiguity の全失敗系で fail-closed になる。
6. bootstrap/React/async failure の三層 owner があり、unsafe reload を提示しない。
7. 全 persisted mutation が同期 epoch を通り、root unload guard と blocker owner catalog coverage が 100% である。
8. Tailwind CDN、旧 Tailwind runtime route/cache、inline script がない。
9. production reachable style sink が catalog 化され、enforced CSP と header/cache policy が local/provider で一致する。
10. ExcelJS は page client 初期 graph に含まれず、XLSX streaming preflight/resource limit が Worker と rollout fallback で同一である。
11. virtual/full renderer の操作・accessibility pathが成立し、full renderer/runtime preference が残る。
12. `ScreenState` が利用者文字列と予約 tag を混在させず、`App.tsx` と persistence が定義した責務・依存方向を満たす。
13. IndexedDB と Release A の data safety/API/DB contract、live schema fingerprint、30日 retention が維持される。
14. installed-controlled offline relaunch と local data CRUD/reopen が成功する。
15. lint warning 0、stable required aggregate CI、daily audit、scheduled observation が green である。
16. package、detached hash、evidence、runbook、alias rollback/prebuilt restore drill が保管期限内である。

## 29. 実装時に参照する正本

既存 path は characterization/compatibility、追加予定 path は最終 contract の正本として参照する。

- `package.json`
- `package-lock.json`
- `vite.config.ts`
- `vitest.config.ts`
- `playwright.config.ts`
- `tailwind.config.ts`
- `postcss.config.cjs`
- `eslint.config.*`
- `tsconfig*.json`
- `index.html`
- `vercel.json`
- `pwa-assets.config.ts`
- `config/variant-catalog.json`
- `config/route-policy.json`
- `config/response-policy.json`
- `config/provider-policy.json`
- `config/ui-scenarios.json`
- `config/style-sink-allowlist.json`
- `config/xlsx-resource-policy.json`
- `contracts/xlsx-stream-v1.json`
- `performance-budgets.json`
- `contracts/persistence-release-a-metrics-v1.json`
- `.github/workflows/**`
- `public/**` の PWA/icon/static assets
- `src/bootstrap.ts`
- `src/themePrepaint.ts`
- `src/sw.ts`
- `src/index.tsx`
- `src/styles/tailwind.css`
- `src/styles/bootstrap.css`
- `src/App.tsx`
- `src/pwa/**`
- `src/persistence/**`
- `src/features/app-shell/types.ts`
- `src/features/app-shell/components/AppMainContent.tsx`
- `src/features/app-shell/components/AppOverlayLayer.tsx`
- `src/features/app-shell/commands/persistedMutationCommands.ts`
- `src/features/space-navigation/hooks/useExecutionSpaceNavigator.ts`
- `src/features/xlsx/**`
- `src/features/lists/**`
- `src/workers/xlsxContracts.ts`
- `src/workers/xlsx.worker.ts`
- `src/components/ShoppingList.tsx`
- `src/hooks/useIndexedDbPersistence.ts`
- `src/utils/indexedDB.ts`
- `src/utils/persistenceCleanupCoordinator.ts`
- `src/utils/persistenceResilience.ts`
- `src/utils/persistenceRecoveryExport.ts`
- `src/utils/mapDataPersistence.ts`
- `src/utils/persistenceReleaseAMetrics*.ts`
- `src/utils/xlsxMapParser.ts`
- `src/utils/exportImport.ts`
- `src/types/item.ts`
- `src/types/map.ts`
- `src/types/export.ts`
- `src/features/events/fileImport.ts`
- `src/features/events/exportFlow.ts`
- `src/features/map/domain/mapImportFlow.ts`
- `src/components/map/MapImportDialog.tsx`
- `src/components/BackupRestoreDialog.tsx`
- `src/components/ExportOptionsDialog.tsx`
- `api/persistence-release-a-metrics.mjs`
- `supabase/config.toml`
- `supabase/tests/**`
- `supabase/migrations/20260803000000_persistence_release_a_metrics.sql`
- `supabase/migrations/YYYYMMDDHHMMSS_persistence_release_a_metrics_retention.sql`
- `supabase/migrations/YYYYMMDDHHMMSS_persistence_release_a_metrics_repair.sql`（live drift がある場合だけ）
- `scripts/build/**`
- `out/analysis/style-sink-catalog.json`（generated evidence、source allowlist ではない）
- `scripts/verify-release-a-build.mjs`
- `scripts/verify-release-a-browser.mjs`
- `scripts/verify-release-a-evidence.mjs`
- `scripts/rehearse-release-a-rollback.ps1`
- `.gitattributes`
- `.prettierrc.json`
- `docs/release-a-evidence.template.json`
- `docs/persistence-recovery-runbook.md`
- `docs/Resilient Persistence & Safe Migration Plan.md`
