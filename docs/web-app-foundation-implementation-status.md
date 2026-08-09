# Web App Foundation 実装状況

## 判定の境界

この文書の「repository 完了」は、source、machine-readable policy、gate、fixture、
自動 test、production 操作用 fail-closed CLI が repository 内に実装されていることを示す。
commit、merge、外部環境への適用、production 配布または release acceptance の完了を意味しない。

現時点では次の外部作業を実行していない。

- provider、production database、Release State control store、protected approval の実 binding
- canonical physical machine と固定 Chromium による、該当 scenario ごとの 30 samples
- production origin の実 installed PWA、実 multi-client、deployed CSP sink/header の観測
- production migration、immutable deployment、promotion、assignment validation
- fresh Release A observation、24 時間以上の観測、必要承認、`release-accepted`

したがって、すべての Phase について repository 実装/gate/test は完了している一方、
正式な phase gate は `0/16`、production acceptance は不可である。fixture、local build、
QA variant、local gate の成功を production eligible または accepted と読み替えてはならない。

2026-08-08 の実装監査で検出した repository 内の残件は、次のとおり閉じた。

- outer recovery agent は、起動時の waiting Worker に加え、現在の installing Worker と将来の
  `updatefound` / `statechange` を監視し、waiting identity と blocker snapshot の検証後だけ
  更新案内を表示する。
- CSP report API と SQL は、effective directive の closed set と、列名 `blocked_target` / 値
  `self/scheme/same-site/cross-site/unknown` を共有する。構文上 valid な未知 directive は
  `unknown` へ正規化し、既存 table の旧 constraint/row も forward-only に更新する。verifier と
  disposable DB upgrade test は API/SQL drift、未検証 constraint、閉集合外 insert を拒否する。
- autosave、legacy migration、recovery adoption、atomic restore の全 mutation は
  `PersistenceCommandPort` と IndexedDB adapter を経由し、hook からの直接 DB mutation を
  architecture policy が拒否する。
- 旧 `src/utils/exportImport.ts` / `src/utils/xlsxMapParser.ts` facade は削除し、consumer と test は
  `src/xlsx/` の正本へ直接接続する。architecture policy は旧 facade の再導入を拒否する。
- Windows rollback rehearsal は、現行 outer recovery agent と過去の hashed entry の双方を検出し、
  過去 source 自身の lockfile で依存を復元する。exact Node executable、deadline、診断 log、process
  cleanup を固定し、同一 profile の forward → rollback → forward を再現する。
- local CSS browser contract は dark/light/system の first-paint、computed visual signature、
  smartphone/desktop geometry、print PDF、manifest/CDP installability を runtime で比較する。
- enforced CSP browser contract は normal/control/update、offline、emitted XLSX Worker、Blob download、
  identity mismatch recovery、same-origin API error の各 document で violation 0 を要求する。

2026-08-09 の再監査で検出した repository 内の残件は、次のとおり閉じた。

- `index.html` の唯一の module entry を実際の outer recovery agent entry にし、architecture
  closure も同じ entry を検査する。application CSS は HTML の exact 1本の local stylesheet entry へ
  分離し、build後のlink、asset bytes/hash、`#loading-screen` / `.hidden` の静的ruleをmanifestと
  artifact verifierへ束縛する。Service Worker registration、identity 検証、role entry importより先に
  App graphを読み込まず、stylesheet欠落・重複・source参照残存・hidden rule欠落を拒否する。
- runtime の `CSSStyleSheet.insertRule` / `CSSStyleRule.style` 更新を全廃する。測定値は typed
  `data-*` attribute と静的 stylesheet で解決し、verifier は CSSOM mutation の再導入も拒否する。
- `cspMode` を preview、prebuilt artifact、Vercel output、provider environment/probe の共通契約へ
  接続する。`none` は CSP header/sink/credential edge を閉じ、`report-only` と `enforced` は対応する
  header、function、credential をそれぞれ fail closed で要求する。
- XLSX Worker は固定 semantic golden の export/preflight/import を exact 比較する。canonical
  sample collector は17 scenarioを明示dispatchし、fresh context、warm-up除外、deterministic rotation、
  30 samples、machine/Chromium/source/artifact/fixture bindingとfunctional assertionをfail closedで
  採取する。closed builderは29/31 samples、未知 field、dirty/wrong sourceを拒否する。
- production `ShoppingList` の全 full 分岐を `FullListRenderer` 本体へ接続し、full/virtual が同じ
  controller の selection/focus/scroll command を使う。full側はcanonical row列のgroup/item ownership、
  row key、accessibilityを自ら適用し、欠落・重複renderとorphan itemをfail closedにする。折りたたみ
  groupもcanonical membershipを保持し、renderer parityとaccessibilityを回帰testで固定する。
- `collect-prepromotion-evidence-source` は`qa`、`reproducibility`、`resource`、`route`、`security`のexact
  5 categoryを同一source/requirements/standard・containment bindingへ束縛する。requirements、standard
  binding、containment bindingは相互にdistinctなreview済みprior workflow runからだけ取得し、GitHub API
  receiptをimmutable storeへ保存・再読込する。`completed/success`、run ID/attempt、head SHA、workflow path、
  artifact名/hashのいずれかが不一致ならpre-promotion setを生成しない。
- `accept-standard` は acceptance-final bundle と exact object set を二段階で生成・review・再読込し、
  fresh exact-source v1、24時間、minimum sample、三者 approval、assignment/event/CAS hash chain の
  missing/tamper/extra/drift を拒否する。workflow は pre-promotion/acceptance raw evidence の producer と
  upload/download を明示する。
- acceptance evidenceは`initialize-acceptance-collector`でpersistent chainを初期化し、別runの
  `collect-continuous-sample`ごとに実provider lookupとpublic HTTP response/bodyのraw receiptをimmutable
  storeへ保存してから、sample/commit/headをPostgreSQLの同一transactionでCAS appendする。
  `finalize-acceptance-evidence`はcurrent chainだけを閉じ、`publish-acceptance-evidence`はreview済みprior runの
  exact bytesだけを再公開する。stale/fork/replay、途中rollback、caller supplied observationを拒否する。
- active release policy の `phaseSequence` から次の `acceptedGate` と performance evidence kind を導出する
  `produce-acceptance-requirements` を別 run に分離する。後続 run は reviewed artifact SHA と current state
  再導出結果の双方を照合し、same-run/caller gate を拒否する。P0/P3/P5D/P5E の own-gate evidence、P8 の
  inherited closure、その他 gate の `null` を exact に分岐し、full verifier を保存前/commit 前に実行する。
- artifact archive と availability receipt を content-addressed Release State object として
  `DeploymentBinding` に必須化する。live availability 検証なしの rollback/package-redeploy eligibility を
  禁止する。dry-run planner に加え、no-build/no-install materialize、separate reviewed subject、pending CAS、
  provider mutation、assignment validation、terminal CAS までの rollback/redeploy/containment workflow を
  接続し、alias 後の CAS failure は pending と reconcile material を保持する。
- reconcile は binding の immutable provider policy を authority にし、fresh exact target、re-probe 済み
  previous、verified emergency の三分岐だけを terminal lifecycle へ接続する。partial/unknown/ambiguous/
  caller policy は blocked のまま fail closed にする。rollback/redeploy は origin accepted event/gate/floors を
  immutable readback から原子的に復元する。
- Release State schema は全 event payload、snapshot、incident/recovery/inventory を closed shape とし、
  eventごとのschema検証とreplay後snapshot検証を必須にする。continuous/companionのsource v2とfinal v1も
  executable schema validatorへ接続し、`maxLength`、tuple `prefixItems` / `items: false`を含む使用keywordを
  testで固定するため、宣言だけ存在してruntimeで無視されるschema keywordを残さない。
- source-hardened build は caller supplied dimension を廃止し、current Release State から導出した
  `artifact-build-requirements` の別 run artifact/hash を reviewしてから実行する。production package は
  active policy、exact target gate、source/provider/DB/toolchain/CSP authority を再導出できる場合だけ
  promotableにし、proposed policyからの通常package生成を拒否する。
- 通常のpolicy activation gateは専用のnonpromotable QA pairを非production buildで生成し、reviewed
  execution subjectからpreview deploy、全route probe、standard→rollback→containment→standard restoreを
  実行する。closureはreview済みexecution bundle一件から全authorityを導出し、production domain接触、
  incomplete cleanup、extra evidenceを拒否する。floor-onlyの`P8-CLEAN`はQA build/drillへ入れない。
- outer recovery agentはrole graphから独立したsingle-entry buildにし、standard/containmentでbyteとclosed
  graph hashの完全一致を検証する。role別shared chunkやstatic/dynamic output importを許可しない。
- own-gate raw performanceは専用のprotected Windows runner/workflowだけで採取する。collector自身のOIDC
  issuer/subject/run/source/environment receiptをimmutable storeへ保存し、producerはGitHub Run APIのraw/
  canonical authority、`completed/success`、review済みprior run ID/hashを再検証する。正式入力は4-key
  envelopeだけで、P8は四つのhistorical accepted eventから同じreceiptを再検証したclosureだけを許可する。
- Release State control-store migrationを実PostgreSQLへ適用するdisposable DB suiteをLinux CIの既定gateへ
  接続する。CAS/stale CAS/idempotent replay、実login roleとdirect table accessの拒否、evidenceの
  replay/tamper検出とUPDATE/DELETE immutabilityを検証する。
- `verify-foundation-policy` はbaseline、provider、DB、control store、approvalに加えてretention、backup、
  remote cron/last-success、startup WAF authorityも集約する。現在の28 blockerが一件でも残れば
  `productionActivationReady=false` を維持する。
- production `App` はevent lifecycle/transfer/update、shopping mutation/selection、map
  import/route/visit-list/editorの9 typed command hookをcomposition rootで接続する。overlayはclosed
  reducer/controllerを唯一の正本とし、旧UI/workspace scalar allocationを削除する。list/map selectorと
  hall-state normalizerをpure moduleへ移し、Header/Main/Overlayはdomain別`model`/`actions`だけを受ける。
  App内の旧domain transaction本体、IndexedDB/localStorage/Service Worker/XLSX implementation detailへの
  direct edgeは0である。
- navigation/overlayのlegacy projection APIと未到達のbridge/component/hook/icon sourceを削除する。
  architecture policyはlegacy navigation/overlay symbol、projection bridge、temporary persistence bridge、
  旧XLSX facadeのproduction pathを0件契約として検査し、dead sourceの再導入を拒否する。
- application snapshot mutationは`commitApplicationSnapshotAtomically`を正本にする。
  `eventLists`、`eventMetadata`、`executeModeItems`、`dayModes`、`mapData`、`mapRotationSettings`、
  `routeSettings`、`hallDefinitions`、`hallRouteSettings`、`mapViewportSettings`のexact 10 storesと、物理
  `syncQueue`内のmetadata/checkpointを単一readwrite transaction/CASでcommitする。旧restore APIは同じ
  境界へのaliasだけを維持する。delete/renameはpure snapshot operationとtyped port/adapter commandへ
  統一し、auxiliary block-detection settingsは失敗時に補償rollbackする。UI stateは永続commit成功後にだけ
  反映する。

## Phase 別状況

| Phase / gate                    | Repository 実装・gate・test | 主な実装ファイル                                                                                                                                                                                                                                                                                                                                                                                                               | 主な検証コマンド                                                                                                                                                                                                                   | 外部実行・production acceptance                                                                                                                                       |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0A / `P0-BASELINE`              | 完了                        | `config/foundation-baseline.json`、`config/encoding-policy.json`、`scripts/verify-foundation-baseline.mjs`、`scripts/verify-encoding.mjs`、`docs/web-foundation-release-runbook.md`                                                                                                                                                                                                                                            | `npm run test:encoding`、`npm run verify:baseline`、`npm run verify:foundation`                                                                                                                                                    | provider/DB/control store の authoritative binding と bootstrap baseline evidence は未確定。受理不可                                                                  |
| 0B / `P0-TOOLCHAIN`             | 完了                        | `package.json`、`package-lock.json`、`config/toolchain-versions.json`、`eslint.config.js`、`vitest.config.ts`、`scripts/verify-direct-dependency-usage.mjs`、`scripts/verify-architecture.mjs`                                                                                                                                                                                                                                 | `npm run verify:toolchain:policy`、`npm run verify:dependency-usage`、`npm run verify:test-project-membership`、`npm run verify:architecture`、`npm run quality:local`                                                             | canonical physical machine/browser binding と baseline 30 samples は未実行。受理不可                                                                                  |
| 0C / `P0-ARTIFACT`              | 完了                        | `contracts/artifact-manifest-v1.schema.json`、`contracts/release-package-index-v1.schema.json`、`scripts/lib/artifact-builder-core.mjs`、`scripts/provider/prebuiltDeployment.mjs`、`scripts/provider/archiveRecovery.mjs`、`scripts/provider/archiveRecoveryExecution.mjs`、`scripts/release-state/`、`config/release-state.schema.json`、`api/not-found.mjs`                                                                 | `npm run test:artifact`、`npm run test:provider`、`npm run test:release-state`、`npm run test:api`、`npm run verify:foundation`、`npm run release:plan-archive-recovery -- ...`、`npm run release:execute-archive-recovery -- ...` | configured provider と production control-store namespace による deploy/CAS/reconcile drill は未実行。受理不可                                                        |
| 0D / `P0-DATA`                  | 完了                        | `api/persistence-release-a-metrics.mjs`、`supabase/migrations/20260805000000_persistence_release_a_hardening.sql`、`supabase/migrations/20260808000000_csp_report_contract.sql`、`config/db-compatibility-contract.json`、`config/metrics-retention-policy.json`、`contracts/release-evidence-bundle-v1.schema.json`、`.github/workflows/metrics-retention.yml`                                                                | `npm run verify:db-compatibility`、`npm run verify:metrics-contract`、`npm run verify:metrics-retention`、`npm run test:release-a-evidence`、`npm run test:api`                                                                    | production migration、remote fingerprint/privilege/retention/backup observation、control-state initialization は未実行。受理不可                                      |
| 0E / `P0-PROMOTE`, `P0-RELEASE` | 完了                        | `scripts/provider/promote-prepared.mjs`、`scripts/provider/productionAssignmentValidation.mjs`、`scripts/release-state/prePromotionEvidence.mjs`、`scripts/release-state/acceptanceEvidenceAuthority.mjs`、`scripts/release-state/acceptanceTerminalBundle.mjs`、`scripts/release-state/reviewedWorkflowRunAuthority.mjs`、`ops/release-state/migrations/0002_acceptance_evidence_chains.sql`、`.github/workflows/release.yml` | `npm run test:provider`、`npm run test:release-state`、`npm run test:foundation`、`npm run verify:performance-policy`、`npm run verify:foundation`                                                                                 | standard/companion の production deploy、二者承認、promotion、24 時間観測、三者承認、acceptance は未実行。受理不可                                                    |
| 1 / `P1-PWA`                    | 完了                        | `src/pwa/recovery/outerAgentEntry.ts`、`src/pwa/recovery/outerRecoveryAgent.ts`、`src/pwa/recovery/serviceWorkerBootstrap.ts`、`src/sw.ts`、`scripts/build-pwa-recovery-agent.mjs`、`scripts/lib/outer-agent-contract.mjs`、`scripts/rehearse-release-a-rollback.ps1`、`vite.config.ts`                                                                                                                                        | `npm run test:unit`、`npm run test:integration`、`npm run test:browser`、`npm run build:release-a`、`npm run test:release-a-browser`、`npm run test:release-a-rollback`                                                            | policy activation、production candidate 配布、multi-client production drill、24 時間観測/承認/acceptance は未実行。受理不可                                           |
| 2A / `P2A-LOCAL`                | 完了                        | `tailwind.config.cjs`、`postcss.config.cjs`、`src/styles/application.css`、`src/styles/runtime-layout.css`、`src/styles/runtimeLayoutAttributes.ts`、`scripts/lib/application-stylesheet-contract.mjs`、`public/theme-prepaint.js`、`tests/browser/local-css-presentation.spec.ts`、`index.html`                                                                                                                               | `npm run build:release-a`、`npm run test:browser`、`npm run test:a11y`、`npm run verify:csp-policy`                                                                                                                                | production request graph、実 installed PWA の provider/physical observation、配布、24 時間観測/承認/acceptance は未実行。受理不可                                     |
| 2B / `P2B-REPORT`               | 完了                        | `api/csp-report.mjs`、`scripts/lib/csp-delivery.mjs`、`scripts/csp-delivery.test.mjs`、`scripts/lib/artifact-builder-core.mjs`、`scripts/provider/deploymentBindingProducer.mjs`、`scripts/verify-csp-policy.mjs`、`config/csp-policy.json`、`vercel.json`                                                                                                                                                                     | `npm run verify:csp-policy`、`npm run verify:db-compatibility`、`npm run test:foundation`、`npm run test:api`、`npm run test:db:disposable`                                                                                        | production CSP credential/route/WAF の activation、violation observation、24 時間観測/承認/acceptance は未実行。受理不可                                              |
| 3 / `P3-XLSX`                   | 完了                        | `src/xlsx/`、`src/xlsx/fixtures/event-workbook-semantic-golden.v1.json`、`config/xlsx-limits.json`、`scripts/fixtures/performance/xlsx-worker-*.json`、`scripts/lib/performance-sample-collector.mjs`、`scripts/collect-own-gate-performance-samples.mjs`、`scripts/release-state/ownGatePerformanceEvidence.mjs`、`.github/workflows/performance-evidence.yml`                                                                | `npm run test:worker`、`npm run test:qa-builds`、`npm run verify:performance-policy`、`npm run performance:own-gate-samples:collect`、`npm run performance:own-gate-evidence:produce -- ...`                                       | canonical physical profile のWorker scenario 30 samplesとreviewed ceiling、production配布、24時間観測/承認/acceptanceは未実行。物理測定値を生成していないため受理不可 |
| 4 / `P4-CSP`                    | 完了                        | `config/csp-policy.json`、`vercel.json`、`src/pwa/cspPolicy.test.ts`、`tests/browser/csp-full-flows.spec.ts`、`scripts/verify-csp-policy.mjs`、`scripts/verify-release-a-browser.mjs`                                                                                                                                                                                                                                          | `npm run verify:csp-policy`、`npm run test:api`、`npm run test:browser`、`npm run test:foundation`                                                                                                                                 | deployed provider header/sink の production full-flow observation、24 時間観測/承認/acceptance は未実行。受理不可                                                     |
| 5D / `P5-DUAL`                  | 完了                        | `src/components/ShoppingList.tsx`、`src/features/shopping-list/model/`、`src/features/shopping-list/controller/`、`src/features/shopping-list/renderers/FullListRenderer.tsx`、`src/features/shopping-list/renderers/VirtualListRenderer.tsx`、`src/features/shopping-list/ShoppingList.renderer.integration.test.tsx`、`scripts/fixtures/performance/list-*.json`                                                             | `npm run test:unit`、`npm run test:integration`、`npm run test:a11y`、`npm run verify:performance-policy`                                                                                                                          | canonical physical profile の full/virtual scenario 30 samples、production 配布、24 時間観測/承認/acceptance は未実行。受理不可                                       |
| 5E / `P5-LIST`                  | 完了                        | `src/features/shopping-list/preference/`、`src/features/shopping-list/renderers/rendererSelector.ts`、`src/features/shopping-list/ShoppingList.renderer.integration.test.tsx`、`scripts/fixtures/performance/list-renderer-selection.json`                                                                                                                                                                                     | `npm run build:qa:list-force-full`、`npm run test:qa-builds`、`npm run test:integration`、`npm run verify:performance-policy`                                                                                                      | canonical physical profile の selection/fallback scenario 30 samples、production 配布、24 時間観測/承認/acceptance は未実行。受理不可                                 |
| 6 / `P6-APP`                    | 完了                        | `src/app/commands/use*Commands.ts`、`src/app/state/appOverlayState.ts`、`src/app/state/useAppOverlayController.ts`、`src/app/selectors/`、`src/features/app-shell/components/App*Shell.tsx`、`src/app/ports/PersistenceCommandPort.ts`、`src/persistence/db/atomicRestoreTransaction.ts`、`src/persistence/adapters/indexedDbPersistenceCommandAdapter.ts`、`src/App.tsx`                                                      | `npm run typecheck`、`npm run test:unit`、`npm run test:integration`、`npm run lint`、`npm run verify:architecture`、`npm run verify:test-project-membership`                                                                      | source change の production 配布、24 時間観測/承認/acceptance は未実行。受理不可                                                                                      |
| 7 / `P7-IDB`                    | 完了                        | `src/persistence/`、`src/utils/indexedDB.ts`、`src/utils/indexedDB.*.integration.test.*`、`src/test/fixtures/legacy-*.json`                                                                                                                                                                                                                                                                                                    | `npm run test:unit`、`npm run test:integration`、`npm run verify:db-compatibility`、`npm run test:release-a-evidence`                                                                                                              | production DB fingerprint の authoritative 一致、production 配布、24 時間観測/承認/acceptance は未実行。受理不可                                                      |
| 8 / `P8-CLEAN`                  | 完了                        | `eslint.config.js`、`config/direct-dependency-usage.json`、`config/architecture-policy.json`、`config/coverage-policy.json`、`config/performance-inherited-closure.schema.json`、`scripts/build-performance-inherited-closure.mjs`、`scripts/lib/performance-inherited-closure.mjs`、`src/styles/`、`src/xlsx/`、`package.json`                                                                                                | `npm run lint`、`npm run verify:dependency-usage`、`npm run verify:architecture`、`npm run verify:coverage-policy`、`npm run performance:inherited-closure:build -- ...`、`npm run quality:local`                                  | inherited canonical performance evidence、production CSP/floor activation、配布、24 時間観測/承認/acceptance は未実行。受理不可                                       |

## Blocker の正本

現行の production activation blocker は 28 件である。コード値の正本は
`config/release-variants.json`、`config/provider-policy.json`、
`config/release-state-store.json`、`config/approval-policy.json`、
`config/db-compatibility-contract.json`、`config/foundation-baseline.json`、
`config/metrics-retention-policy.json`、
`contracts/persistence-release-a-startup-bursts-v1.json` であり、
`scripts/verify-foundation-policy.mjs` が集合を導出する。この文書には値を重複転記しない。
現在値の確認には `node scripts/verify-foundation-policy.mjs --json` を使用する。

canonical physical performance の profile、30-sample 要件、pending state、blocker の正本は
`config/performance-budgets.json` と `config/performance-evidence.schema.json` である。
production DB retention の外部状態は `config/metrics-retention-policy.json` を正本とする。
いずれも repository 内 fixture で置換せず、外部 evidence が保存されるまで fail closed を維持する。
