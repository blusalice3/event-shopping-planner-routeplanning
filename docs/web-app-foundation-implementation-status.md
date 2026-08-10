# Web App Foundation 実装状況

更新日: 2026-08-10 (Asia/Tokyo)

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
- Formal approvalは三つのdistinct role/teamとrole-bound approval IDを維持しつつ、同一GitHub
  provider reviewerが三役を兼任できる。authoritative environment reviewを各team membershipへ展開する。
- `humanOperatorModel=single-human-single-github-account/v1`をpolicy/verifierへ固定し、baseline選定/review、
  installed PWA実施/review、historical audit/reviewを含む全human roleで同じaccountを受理する。
- production request graph、CSP report-only observation、deployed CSP 7-flowを live bindingから再集計する。
- Phase 1のwaiting Worker検出は初回`flush=false`で全client snapshotを表示し、明示的な
  「保存して更新準備」操作後だけ`flush=true`を送る。空応答、blocker残存、保存失敗、未応答client、
  waiting Worker差替えはfail-closedにし、全clientの保存完了後だけ全tab/PWA windowを閉じる案内を出す。
- outer agentとrole entryの独立bundle間はsame-window/same-originのstrict bridgeで接続し、role側の
  `event-autosave`だけが保存状態とflushを所有する。timeout、重複応答、malformed envelope、foreign/stale
  Workerはfail-closedにし、outer/role双方へ別Mapを生成しない。
- 更新noticeはReact管理下の`#root`外に専用hostを持ち、waiting Workerの世代・所有権tokenで管理する。
  古い非同期flush結果は新Workerのnoticeを削除できない。
- controlled navigationはactive Workerが所有するsource-addressed precacheの`/index.html`を優先し、
  shell欠損時だけnetworkへfallbackする。旧controllerと新HTML meta/outer agentを混在させない。
- Release A browser transitionは同一origin/profileの3 client、freeze/thawした未応答client、2回の実click、
  production bridge上の実`event-autosave` blocker/flushとIndexedDB保存、close前controller不変、全client
  解放後のnatural activationを検証する。prompt-close証跡はclosed verifierでunknown/missing fieldと
  改ざんを拒否する。prompt UIを持たないhistorical rollbackは旧natural activation経路へ分離する。
- P1の正式authorityは、fresh 24時間観測と三役分のapproval（同一reviewerによる兼任可）を経た二つのdistinct-source prompt standardを同じ
  `P1-PWA` floorで順に受理し、先行runのprotected `collect-pwa-multiclient-drill`でstrict signed receiptを採取する。
  続いて`collect-managed-device-live-stage`をdistinctな3 runでcurrent → rollback → currentと実行し、stage間の
  二つの`rollback-activated`がinventoryを原子的に入れ替える。composite readerはsource/device、current/rollback
  deployment、controller、時刻・run順序を再検証する。
- source-only same-floor replacementは非終端gate、exact floor、distinct source/build/binding/provider deploymentに
  限定し、`candidate_gate`をbuild/acceptance chain全体へ閉じて伝播する。`P8-CLEAN`ではreplacementを拒否する。
- P7はmanaged Windows deviceのbrowser tab / installed PWAをdistinct profileで A → B → A の3 stageに分け、
  Ed25519 attestation、Service Worker、capability、IndexedDB raw authorityへ束縛する既存契約を維持する。
- 14 external authorityごとの closed verifierと reviewed artifact readerを実装し、generic evidence置換を拒否する。
- formal 16-gate sequence、pre-initialization seed、supporting event、predecessor attestation、P8 floor activationを
  immutable Release State replayへ統合した。
- `workflow_dispatch` を `source_sha` / `operation` / `request_json` に限定し、現行50 operationを
  operation別 closed schemaで検証する。operation coverageは registryから機械的に導出する。

## Phase 別状況

| Phase / gate        | Repository mechanism | Formal Exit | 未実行の外部条件                                                             |
| ------------------- | -------------------- | ----------: | ---------------------------------------------------------------------------- |
| 0A / `P0-BASELINE`  | 実装済み             |        未達 | provider/DB/control store/approval binding、bootstrap recovery observation   |
| 0B / `P0-TOOLCHAIN` | 実装済み             |        未達 | reviewed protected quality run                                               |
| 0C / `P0-ARTIFACT`  | 実装済み             |        未達 | configured disposable provider/PostgreSQL drill                              |
| 0D / `P0-DATA`      | 実装済み             |        未達 | production migration/fingerprint、retention、backup/restore、WAF、state init |
| 0E / `P0-PROMOTE`   | 実装済み             |        未達 | normal production promotion/assignment chain                                 |
| 0E / `P0-RELEASE`   | 実装済み             |        未達 | 30 samples、24時間観測、三役承認（兼任可）、acceptance                       |
| 1 / `P1-PWA`        | 実装済み             |        未達 | prompt 2-source acceptance、strict receipt、live往復3-stage、attestation     |
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

固定 toolchainで記録した統合結果は Foundation 790/790、Release State 281/281、Unit 1127/1127、
Integration 393/393、Worker 67/67、API 17/17、Coverage lines 90.03% / branches 81.72%である。
Release A build/verifierとChromium 22/22もclean commitから成功している。
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
