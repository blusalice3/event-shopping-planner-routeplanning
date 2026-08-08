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

## Phase 別状況

| Phase / gate                    | Repository 実装・gate・test | 主な実装ファイル                                                                                                                                                                                                                                                                                                                                                | 主な検証コマンド                                                                                                                                                        | 外部実行・production acceptance                                                                                                       |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 0A / `P0-BASELINE`              | 完了                        | `config/foundation-baseline.json`、`config/encoding-policy.json`、`scripts/verify-foundation-baseline.mjs`、`scripts/verify-encoding.mjs`、`docs/web-foundation-release-runbook.md`                                                                                                                                                                             | `npm run test:encoding`、`npm run verify:baseline`、`npm run verify:foundation`                                                                                         | provider/DB/control store の authoritative binding と bootstrap baseline evidence は未確定。受理不可                                  |
| 0B / `P0-TOOLCHAIN`             | 完了                        | `package.json`、`package-lock.json`、`config/toolchain-versions.json`、`eslint.config.js`、`vitest.config.ts`、`scripts/verify-direct-dependency-usage.mjs`、`scripts/verify-architecture.mjs`                                                                                                                                                                  | `npm run verify:toolchain:policy`、`npm run verify:dependency-usage`、`npm run verify:test-project-membership`、`npm run verify:architecture`、`npm run quality:local`  | canonical physical machine/browser binding と baseline 30 samples は未実行。受理不可                                                  |
| 0C / `P0-ARTIFACT`              | 完了                        | `contracts/artifact-manifest-v1.schema.json`、`contracts/release-package-index-v1.schema.json`、`scripts/lib/artifact-builder-core.mjs`、`scripts/provider/prebuiltDeployment.mjs`、`scripts/provider/preparedPromotion.mjs`、`scripts/release-state/`、`api/not-found.mjs`                                                                                     | `npm run test:artifact`、`npm run test:provider`、`npm run test:release-state`、`npm run test:api`、`npm run verify:foundation`                                         | configured provider と production control-store namespace による deploy/CAS/reconcile drill は未実行。受理不可                        |
| 0D / `P0-DATA`                  | 完了                        | `api/persistence-release-a-metrics.mjs`、`supabase/migrations/20260805000000_persistence_release_a_hardening.sql`、`supabase/migrations/20260808000000_csp_report_contract.sql`、`config/db-compatibility-contract.json`、`config/metrics-retention-policy.json`、`contracts/release-evidence-bundle-v1.schema.json`、`.github/workflows/metrics-retention.yml` | `npm run verify:db-compatibility`、`npm run verify:metrics-contract`、`npm run verify:metrics-retention`、`npm run test:release-a-evidence`、`npm run test:api`         | production migration、remote fingerprint/privilege/retention/backup observation、control-state initialization は未実行。受理不可      |
| 0E / `P0-PROMOTE`, `P0-RELEASE` | 完了                        | `scripts/provider/promote-prepared.mjs`、`scripts/provider/productionAssignmentValidation.mjs`、`scripts/release-state/lifecycleExecution.mjs`、`scripts/release-state/acceptanceEvidenceInputs.mjs`、`.github/workflows/release.yml`                                                                                                                           | `npm run test:provider`、`npm run test:release-state`、`npm run test:foundation`、`npm run verify:foundation`                                                           | standard/companion の production deploy、二者承認、promotion、24 時間観測、三者承認、acceptance は未実行。受理不可                    |
| 1 / `P1-PWA`                    | 完了                        | `src/pwa/`、`src/sw.ts`、`src/bootstrap.ts`、`scripts/build-pwa-recovery-agent.mjs`、`scripts/rehearse-release-a-rollback.ps1`、`vite.config.ts`（起動時 waiting/current installing/future `updatefound` を監視）                                                                                                                                               | `npm run test:unit`、`npm run test:integration`、`npm run test:browser`、`npm run build:release-a`、`npm run test:release-a-browser`、`npm run test:release-a-rollback` | policy activation、production candidate 配布、multi-client production drill、24 時間観測/承認/acceptance は未実行。受理不可           |
| 2A / `P2A-LOCAL`                | 完了                        | `tailwind.config.cjs`、`postcss.config.cjs`、`src/styles/tailwind.css`、`src/styles/global.css`、`public/theme-prepaint.js`、`tests/browser/local-css-presentation.spec.ts`、`index.html`                                                                                                                                                                       | `npm run build:release-a`、`npm run test:browser`、`npm run test:a11y`、`npm run verify:csp-policy`                                                                     | production request graph、実 installed PWA の provider/physical observation、配布、24 時間観測/承認/acceptance は未実行。受理不可     |
| 2B / `P2B-REPORT`               | 完了                        | `api/csp-report.mjs`、`api/csp-report.test.mjs`、`supabase/migrations/20260808000000_csp_report_contract.sql`、`scripts/verify-csp-policy.mjs`、`scripts/verify-db-compatibility-contract.mjs`、`config/csp-policy.json`、`vercel.json`                                                                                                                         | `npm run verify:csp-policy`、`npm run verify:db-compatibility`、`npm run test:api`、`npm run test:db:disposable`                                                        | production CSP credential/route/WAF の activation、violation observation、24 時間観測/承認/acceptance は未実行。受理不可              |
| 3 / `P3-XLSX`                   | 完了                        | `src/xlsx/`、`config/xlsx-limits.json`、`scripts/fixtures/performance/xlsx-worker-*.json`、`scripts/build-release-vite.mjs`                                                                                                                                                                                                                                     | `npm run test:worker`、`npm run test:qa-builds`、`npm run verify:performance-policy`、`npm run test:integration`                                                        | canonical physical profile の Worker scenario 30 samples、production 配布、24 時間観測/承認/acceptance は未実行。受理不可             |
| 4 / `P4-CSP`                    | 完了                        | `config/csp-policy.json`、`vercel.json`、`src/pwa/cspPolicy.test.ts`、`tests/browser/csp-full-flows.spec.ts`、`scripts/verify-csp-policy.mjs`、`scripts/verify-release-a-browser.mjs`                                                                                                                                                                           | `npm run verify:csp-policy`、`npm run test:api`、`npm run test:browser`、`npm run test:foundation`                                                                      | deployed provider header/sink の production full-flow observation、24 時間観測/承認/acceptance は未実行。受理不可                     |
| 5D / `P5-DUAL`                  | 完了                        | `src/features/shopping-list/model/`、`src/features/shopping-list/controller/`、`src/features/shopping-list/renderers/FullListRenderer.tsx`、`src/features/shopping-list/renderers/VirtualListRenderer.tsx`、`scripts/fixtures/performance/list-*.json`                                                                                                          | `npm run test:unit`、`npm run test:integration`、`npm run test:a11y`、`npm run verify:performance-policy`                                                               | canonical physical profile の full/virtual scenario 30 samples、production 配布、24 時間観測/承認/acceptance は未実行。受理不可       |
| 5E / `P5-LIST`                  | 完了                        | `src/features/shopping-list/preference/`、`src/features/shopping-list/renderers/rendererSelector.ts`、`src/features/shopping-list/ShoppingList.renderer.integration.test.tsx`、`scripts/fixtures/performance/list-renderer-selection.json`                                                                                                                      | `npm run build:qa:list-force-full`、`npm run test:qa-builds`、`npm run test:integration`、`npm run verify:performance-policy`                                           | canonical physical profile の selection/fallback scenario 30 samples、production 配布、24 時間観測/承認/acceptance は未実行。受理不可 |
| 6 / `P6-APP`                    | 完了                        | `src/app/ports/PersistenceCommandPort.ts`、`src/persistence/adapters/indexedDbPersistenceCommandAdapter.ts`、`src/hooks/useIndexedDbPersistence.ts`、`src/App.tsx`、`config/architecture-policy.json`                                                                                                                                                           | `npm run typecheck`、`npm run test:unit`、`npm run test:integration`、`npm run verify:architecture`                                                                     | source change の production 配布、24 時間観測/承認/acceptance は未実行。受理不可                                                      |
| 7 / `P7-IDB`                    | 完了                        | `src/persistence/`、`src/utils/indexedDB.ts`、`src/utils/indexedDB.*.integration.test.*`、`src/test/fixtures/legacy-*.json`                                                                                                                                                                                                                                     | `npm run test:unit`、`npm run test:integration`、`npm run verify:db-compatibility`、`npm run test:release-a-evidence`                                                   | production DB fingerprint の authoritative 一致、production 配布、24 時間観測/承認/acceptance は未実行。受理不可                      |
| 8 / `P8-CLEAN`                  | 完了                        | `eslint.config.js`、`config/direct-dependency-usage.json`、`config/architecture-policy.json`、`config/coverage-policy.json`、`src/styles/`、`src/xlsx/`、`package.json`                                                                                                                                                                                         | `npm run lint`、`npm run verify:dependency-usage`、`npm run verify:architecture`、`npm run verify:coverage-policy`、`npm run quality:local`                             | inherited canonical performance evidence、production CSP/floor activation、配布、24 時間観測/承認/acceptance は未実行。受理不可       |

## Blocker の正本

現行の production activation blocker は 20 件である。コード値の正本は
`config/release-variants.json`、`config/provider-policy.json`、
`config/release-state-store.json`、`config/approval-policy.json`、
`config/db-compatibility-contract.json` であり、
`scripts/verify-foundation-policy.mjs` が集合を導出する。この文書には値を重複転記しない。
現在値の確認には `node scripts/verify-foundation-policy.mjs --json` を使用する。

canonical physical performance の profile、30-sample 要件、pending state、blocker の正本は
`config/performance-budgets.json` と `config/performance-evidence.schema.json` である。
production DB retention の外部状態は `config/metrics-retention-policy.json` を正本とする。
いずれも repository 内 fixture で置換せず、外部 evidence が保存されるまで fail closed を維持する。
