# Web App Foundation 実装状況

更新日: 2026-08-09 (Asia/Tokyo)

## 判定の境界

repository 内の application、policy、producer、verifier、workflow、fixture、負例 test は実装済みである。
formal external authority mechanism は `14/14` 実装済みで、formal sequence は16 gateである。

外部 authority は未観測であり、production 配布・承認も実行していない。したがって現在は
formal phase exit `0/16`、`productionActivationReady=false` である。「repository 実装完了」と
「production Exit 完了」を同じ意味で使わない。

checked-in `config/db-compatibility-contract.json` の正しい現在値は
`contractStatus=local-specification`、`remote.observationStatus=unobserved` である。
`remote-verified` / `observed` は external collector成立後の terminal stateであり、現状説明ではない。

## Repository completion

- Windows exact-file identityを `bigint` と descriptor bytesへ束縛し、Phase 0C の flakyな別file誤認を修正した。
- Node 24.19.0 / npm 11.19.0、dependency、architecture、coverage、audit、build/browser gateを固定した。
- P0A external binding/bootstrap recovery、P0C non-promotable artifact/control-store drill、remote DB、
  retention、backup/restore、startup WAF、physical performanceを protected authority producerへ接続した。
- production request graph、CSP report-only observation、deployed CSP 7-flowを live bindingから再集計する。
- managed Windows deviceのbrowser tab / installed PWAを distinct profileで A → B → A の3 stageに分け、
  Ed25519 attestation、Service Worker、capability、IndexedDB raw authorityへ束縛する。
- 14 external authorityごとの closed verifierと reviewed artifact readerを実装し、generic evidence置換を拒否する。
- formal 16-gate sequence、pre-initialization seed、supporting event、predecessor attestation、P8 floor activationを
  immutable Release State replayへ統合した。
- `workflow_dispatch` を `source_sha` / `operation` / `request_json` に限定し、現行49 operationを
  operation別 closed schemaで検証する。operation coverageは registryから機械的に導出する。

## Phase 別状況

| Phase / gate        | Repository mechanism | Formal Exit | 未実行の外部条件                                                             |
| ------------------- | -------------------- | ----------: | ---------------------------------------------------------------------------- |
| 0A / `P0-BASELINE`  | 実装済み             |        未達 | provider/DB/control store/approval binding、bootstrap recovery observation   |
| 0B / `P0-TOOLCHAIN` | 実装済み             |        未達 | reviewed protected quality run                                               |
| 0C / `P0-ARTIFACT`  | 実装済み             |        未達 | configured disposable provider/PostgreSQL drill                              |
| 0D / `P0-DATA`      | 実装済み             |        未達 | production migration/fingerprint、retention、backup/restore、WAF、state init |
| 0E / `P0-PROMOTE`   | 実装済み             |        未達 | normal production promotion/assignment chain                                 |
| 0E / `P0-RELEASE`   | 実装済み             |        未達 | 30 samples、24時間観測、三者承認、acceptance                                 |
| 1 / `P1-PWA`        | 実装済み             |        未達 | managed-device 3-stage multi-client drill                                    |
| 2A / `P2A-LOCAL`    | 実装済み             |        未達 | production request graph observation                                         |
| 2B / `P2B-REPORT`   | 実装済み             |        未達 | deployed report-only header/sink/DB/WAF observation                          |
| 3 / `P3-XLSX`       | 実装済み             |        未達 | canonical physical 30 samples、acceptance                                    |
| 4 / `P4-CSP`        | 実装済み             |        未達 | deployed header/sink/7-flow observation                                      |
| 5D / `P5-DUAL`      | 実装済み             |        未達 | full/virtual 30 samples、acceptance                                          |
| 5E / `P5-LIST`      | 実装済み             |        未達 | renderer-selection 30 samples、acceptance                                    |
| 6 / `P6-APP`        | 実装済み             |        未達 | production配布、acceptance                                                   |
| 7 / `P7-IDB`        | 実装済み             |        未達 | managed-device 3-stage compatibility drill                                   |
| 8 / `P8-CLEAN`      | 実装済み             |        未達 | inherited performance closure、floor activation、最終 acceptance             |

## Local regression

固定 toolchainで記録した統合結果は Foundation 761/761、Release State 267/267、Unit 1107/1107、
Integration 393/393、Worker 64/64、API 17/17、Coverage 1564/1564、formal exit focused
132/132、P8 formal/floor focused 143/143 である。変更を一時commitしたclean overlayではRelease A
build/verifierとChromium 22/22も成功した。
これは external observationやproduction acceptanceの代替ではない。最終合流では再実行 logを優先する。

## Blocker と readiness の正本

blocker 件数や codeを文書に固定しない。設定追加のたびに手書き件数が陳腐化するため、次の出力を正本とする。

```powershell
node scripts/verify-foundation-policy.mjs --json
node scripts/verify-phase-exit-external-prerequisites.mjs --json
node scripts/verify-artifact-control-store-drill-policy.mjs --json
node scripts/verify-phase-exit-readiness.mjs --json
```

主な checked-in fail-closed正本は `config/provider-policy.json`、`config/approval-policy.json`、
`config/release-state-store.json`、`config/db-compatibility-contract.json`、
`config/foundation-p0a-authorities.json`、`config/artifact-control-store-drill.json`、
`config/backup-restore-provider-contract.json`、`config/phase-exit-external-prerequisites.json`、
`config/performance-budgets.json` である。

正式運用は [Web Foundation Release Runbook](web-foundation-release-runbook.md)、実装・検証の詳細は
[Web App Foundation 完全性・Exit 証跡](web-app-foundation-completion-evidence.md) を参照する。
