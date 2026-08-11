# Web アプリ基盤 実装計画

照合基準日は 2026-08-05 とする。§3 の実装現状を照合した
`implementationTreeBaselineSha` は
`806794df6222053235139e7ef6684f4aa6538b3d` である。この値は現状説明の基準であり、
配布 artifact の identity には使用しない。

本書で `sourceSha` と呼ぶ値は、常に実際に build する clean checkout の完全 commit SHA
である。文書 revision、branch 名、`implementationTreeBaselineSha` を `sourceSha` の
代用にしない。本書のパスはすべて repository root からの相対パスである。

本書は Web アプリ基盤の実装順、責務境界、機械契約、合格条件を定める正本とする。
未実装の構成は「planned」と明記する。実装上の判断が本書の契約を変える場合は、
実装より先に machine-readable policy、該当 ADR、本書を同じ変更単位で更新する。

## 1. 目的

既存の保存データ、Release A、主要 UI の observable behavior を維持しながら、次を
段階的に実現する。

- build、QA、provider deployment、promotion、observation、rollback を同一の immutable
  package と identity chain に結び付ける。
- PWA を即時自動更新から、保存後に全 client を閉じてブラウザの自然 activation に
  委ねる方式へ移行する。
- Tailwind CDN と first-party inline script/style element を撤去し、CSP を report-only
  から enforcement へ進める。
- XLSX の重い処理を UI thread から分離し、入力上限、cancel、atomic commit を実装する。
- 買い物リストの read model と操作を renderer から分離し、eligible state だけに
  virtualization を導入する。
- `App.tsx` と `src/utils/indexedDB.ts` を既存 facade の内側で分割する。
- lint、typecheck、unit/integration、browser、accessibility、coverage、architecture、
  encoding、artifact、release evidence を CI の継続 gate にする。

## 2. 対象外

- React 19、Tailwind 4、別の state management library への移行
- IndexedDB schema の全面再設計、既存 DB の削除、強制 client-side migration
- 同期、共有、認証などの新規 product feature
- 開いている client から `skipWaiting()` を呼び、Service Worker を強制適用する protocol
- undocumented な provider Build Output API file の手書き
- XLSX streaming protocol。whole-buffer Workerが実測上成立しない場合はPhase 3を停止し、
  別のversioned planで扱う
- 全 zoom、複数列、drag 中の行を一つで扱う universal virtual renderer
- Release A evidence v1 schema または既存 verifier の破壊的変更
- Release B の有効化、旧 localStorage 原本の物理 cleanup、cleanup operator UI の導入
- `src/utils/persistenceCleanupCoordinator.ts` の destructive-cleanup safety contract の再設計

## 3. 照合済みの実装現状

### 3.1 Application、build、provider

| 項目                      | 現在の実装                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------ |
| runtime                   | Node `20.20.0`、npm `10.8.2`                                                         |
| application               | React `18.3.1`、TypeScript `5.9.3`                                                   |
| build                     | Vite `5.4.21`                                                                        |
| entry                     | `index.html` → `src/index.tsx` → `src/App.tsx`                                       |
| `npm run build`           | `tsc && vite build --mode release-a`                                                 |
| `npm run build:release-a` | `npm run build` 後に `scripts/verify-release-a-build.mjs`                            |
| provider                  | `vercel.json` の SPA rewrite と headers                                              |
| artifact                  | `dist/` は生成するが、provider prebuilt output と evidence を束ねる package は未実装 |

`build:release-a` から `build` を呼ぶ現在の向きを逆転すると再帰し得る。command graph の
変更は `package.json`、workflow、runbook、command test を同じ commit で更新する。

`vite.config.ts` は `loadEnv` に空 prefix を渡している。現状は secret を client 定数へ
展開していないが、canonical build では public build environment の allowlist が必要で
ある。`vercel.json` の SPA rewrite は exact `/api` の扱いが不完全で、CSP はなく、
`X-XSS-Protection` が残る。

現在の参考値は main JavaScript 941,325 bytes、`xlsx-parser` 974,780 bytes、precache
19 entries、3,085.67 KiB である。これらは budget ではない。Phase 0A で clean checkout、
生成 capability、toolchain、lockfile hash と一組で再採取する。

### 3.2 PWA

- `vite-plugin-pwa` の `generateSW` を使用する。
- `registerType: "autoUpdate"`、`skipWaiting: true`、`clientsClaim: true` である。
- `dist/registerSW.js` が native registration を行う。
- `cleanupOutdatedCaches`、navigation fallback、Tailwind CDN の runtime cache がある。
- source、waiting Worker、active controller、role variant を相互検証する outer agent はない。

### 3.3 HTML、CSS、CSP

- `index.html` は Tailwind CDN、inline Tailwind config、inline theme prepaint を持つ。
- application entry graph には production JSX の inline `style` が 101 箇所ある。
  未使用の `FocusMode_backup.tsx` はこの数から除外する。
- `src/lib/supabase.ts` の importer は 0 で、browser entry graph から到達しない。
- security header は `X-Content-Type-Options` と `X-Frame-Options` を含むが、CSP と
  Permissions Policy はない。

### 3.4 XLSX

- `xlsx` と `exceljs` は application graph に静的 import される。
- import/export、map import、recovery export、item-number 解釈が複数の UI/util に分散する。
- Worker execution port、cancel、ZIP/resource preflight、単一 atomic result protocol はない。
- 現在の main-thread fallback は rollback 用 behavior baseline として保存する必要がある。

### 3.5 Shopping list、App、IndexedDB

- `src/components/ShoppingList.tsx` は model、command、rendering、navigation を併せ持つ。
- `App.tsx` は domain state、overlay、navigation、persistence orchestration を併せ持つ。
- `src/utils/indexedDB.ts` は DB open、repository、migration、repair、recovery adoption、
  transaction coordination を併せ持つ。
- DB 名は `EventShoppingPlannerDB`、version は 5、forward compatibility ceiling は 7 である。
- `syncQueue`、migration journal/archive、checkpoint、map repair、unknown record の
  fail-closed behavior は既存 integration fixture で保護される。
- Release A capability は `releaseChannel: "release-a"` と
  `legacyLocalStorageCleanup: "forced-off"` を固定する。
- `persistenceCleanupCoordinator.ts` は Release B 向けの kill switch、Web Locks、
  Service Worker/client version、quiescence proof を持つが、Release A の production path
  から destructive cleanup task を呼ばない。

### 3.6 Release A metrics、API、DB

- browser は privacy-safe な schema v1 event を same-origin API へ送る。
- `api/persistence-release-a-metrics.mjs` は 1,024 bytes、origin、content type、exact schema
  を検証する。
- dedicated credential がなければ generic Supabase environment へ fallback できる。
- upstream timeout は未実装で、network/non-2xx は `502` へ正規化する。
- unknown `/api` path を JSON 404 にする dedicated handler はない。
- migration は raw table と aggregate view の `service_role` 読取権限を残す。
- v1 evidence verifier は 24 時間の observation、minimum sample、source-bound evidence、
  三つの必須approval roleを要求する。baselineの`selectedBy/reviewedBy`、実機試験の
  `executedBy/reviewedBy`、auditの`auditedBy/reviewedBy`、三つのapproval roleは、すべて同一人物・
  同一GitHub accountでよい。role/action別の記録、時刻順序、evidence reference、role-bound
  approval IDは省略せず、distinct run/hashの条件を維持する。

### 3.7 再現済み品質基準

照合時点の結果は次のとおりである。数値は Phase 0A で再採取し、増加防止 baseline とする。

| command                   | 結果                                      |
| ------------------------- | ----------------------------------------- |
| `npm run typecheck`       | PASS                                      |
| `npm run test:encoding`   | 328 files、UTF-8/BOM/EOL/代表文字列 PASS  |
| `npm run lint`            | 0 errors、130 warnings                    |
| `npm run test:run`        | 120 files、1,198 tests PASS               |
| `npm run build:release-a` | PASS                                      |
| `npm audit`               | critical 1 / high 19 / moderate 8 / low 1 |
| `npm audit --omit=dev`    | high 4 / moderate 2                       |

## 4. 凍結する契約と machine identity

### 4.1 用語

| 用語                            | 定義                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `implementationTreeBaselineSha` | §3 の application/config tree を照合した commit。配布 identity には使わない |
| `sourceSha`                     | 実際に build する clean checkout の完全 commit SHA                          |
| `measurementSourceSha`          | baseline 数値を採取した `sourceSha`                                         |
| `bootstrapSourceSha`            | P0A policyがseed run後に固定する一時 containment専用の監査済みbuild source  |
| `buildId`                       | Release A v1 では `sourceSha` と exact 一致する既存 field                   |
| `variantId`                     | canonical dimension object の JCS bytes に対する完全 SHA-256                |
| `releaseRole`                   | `standard` または `containment`                                             |
| `artifactManifestHash`          | canonical manifest bytes の SHA-256                                         |
| `packageIndexHash`              | canonical package index bytes の SHA-256                                    |
| `providerDeploymentId`          | provider が発行した immutable deployment identifier                         |
| `releasePolicyHash`             | active static policy の canonical bytes の SHA-256                          |
| `requiredDbCompatibility`       | package が要求する versioned DB contract URI と fingerprint                 |
| `acceptedStandardFloors`        | 最後に受理した standard の dimension baseline                               |
| `minimumSafetyFloors`           | standard/containment のどちらも下回れない safety contract                   |

時刻は source identity に使用しない。release event、approval、evidence の時刻は protected
Release State store の commit clock を正本にする。

### 4.2 Release A hard-off

既存の capability schema v1 と `scripts/verify-release-a-build.mjs` を凍結し、すべての
standard、containment、QA、production package で次を満たす。

```text
buildId === sourceSha
sourceState === "clean"
releaseChannel === "release-a"
legacyLocalStorageCleanup === "forced-off"
```

- `VITE_PERSISTENCE_RELEASE_CHANNEL=release-b` と
  `VITE_PERSISTENCE_LEGACY_CLEANUP=true` を foundation variant として受理しない。
- Release A に `cleanupLegacyPersistenceSources` を呼ぶ production edge を追加しない。
  legacy physical deletion metric は 0 を維持する。
- `persistenceCleanupCoordinator` の destructive-cleanup proof は dormant compatibility
  contract として維持し、PWA update、cache cleanup、update blocker へ転用しない。
- Release B は別の versioned plan、runtime kill switch、operator UI、実 client/SW の
  compatibility evidence、rollback restriction、承認なしに開始しない。

### 4.3 Capability と public release identity

既存 capability v1 は variant-independent のまま維持する。新しい fieldを加えず、同じ
`sourceSha` の standard/containment で byte-for-byte 同一にする。

| public path                                      | 内容                                    | cache                                 |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------- |
| `/release-capabilities.json`                     | 現在配信中 source の既存 capability v1  | `public, max-age=0, must-revalidate`  |
| `/release-capabilities.<sourceSha>.json`         | 同じ v1 bytes の source-addressed copy  | `public, max-age=31536000, immutable` |
| `/release-identity.json`                         | 現在配信中 variant の `ReleaseIdentity` | `public, max-age=0, must-revalidate`  |
| `/release-identity.<sourceSha>.<variantId>.json` | variant-addressed identity              | `public, max-age=31536000, immutable` |
| `/theme-prepaint.js`                             | stable classic prepaint script          | `public, max-age=0, must-revalidate`  |

`ReleaseIdentity` schema v1 は planned
`contracts/release-identity-v1.schema.json` を正本とし、lifecycle ごとの tagged union にする。

```ts
type ReleaseIdentityBase = {
  schemaVersion: 1;
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  requiredDbCompatibilityFingerprint: string;
};

type ReleaseIdentity =
  | (ReleaseIdentityBase & {
      pwaLifecycle: "legacy-auto-update-v1";
      appEntryUrl: string;
      appEntrySha256: string;
      serviceWorkerUrl: string;
      serviceWorkerSha256: string;
    })
  | (ReleaseIdentityBase & {
      pwaLifecycle: "prompt-close-all-v1";
      roleEntryUrl: string;
      roleEntrySha256: string;
      serviceWorkerUrl: string;
      serviceWorkerSha256: string;
      outerAgentUrl: string;
      outerAgentSha256: string;
    });
```

stable identity、versioned identity、HTML の build meta、provider evidence は exact 一致させる。
variant 固有情報を capability v1 へ書かないため、source-addressed capability URL は variant
間で衝突しない。P0 の source-hardened package は legacy lifecycle branch、Phase 1 以降は
prompt-close-all branch を使う。

identityとService Worker hashの循環を避けるbuild順を固定する。
`scripts/build-release-vite.mjs`が全体をorchestrateし、
`scripts/build-pwa-recovery-agent.mjs`がouter agentをsingle-entryで再現生成する。

1. app/role entry/outer agent assetsをbuildし、hashを確定する。
2. source/variantからversioned identity URLを確定するが、まだidentity bytesは生成しない。
3. versioned identity URLだけをWorkbox manifestへ`revision: null`で明示追加し、stable
   `/release-identity.json`はprecache対象から除外してService Workerを生成する。
4. Service Worker hashを確定した後にReleaseIdentity bytesを一度だけ生成し、stable/
   versioned pathへ同じbytesを置く。
5. identity生成後にService Worker bytesが変わっていないこと、versioned identityが
   install時に取得できること、provider response hashがmanifestと一致することを検証する。

immutableなsource/variant URLと`revision: null`の組合せによりidentity content hashを
Service Workerへ埋め込まない。Workerは自分のbinary SHAをruntimeで自己申告せず、そのhashは
artifact/provider verifierだけが所有する。

P0 bootstrap は既存 `dist/**` の `index.html`、capability、`sw.js`、Workbox revision を
一切変更しない。その public observation は `LegacyBootstrapPublicIdentity` として外部
provider evidence に束縛し、存在しない `release-identity` を後付けしない。

### 4.4 Release dimension

`config/release-variants.json` は schema version、dimension、floor、containment projection、
approval、temporary dwell、predecessor compatibility を持つ static release policy である。
その JCS bytes の SHA-256 を `releasePolicyHash` とする。policy 内の `dimensions` object は
次の exact key/value だけを持ち、初期 P0 standard の値もこの表で固定する。

| key                       | allowed value                                   | P0 standard             |
| ------------------------- | ----------------------------------------------- | ----------------------- |
| `releaseRole`             | `standard` / `containment`                      | `standard`              |
| `pwaLifecycle`            | `legacy-auto-update-v1` / `prompt-close-all-v1` | `legacy-auto-update-v1` |
| `cssDelivery`             | `cdn` / `local`                                 | `cdn`                   |
| `cspMode`                 | `none` / `report-only` / `enforced`             | `none`                  |
| `xlsxExecution`           | `main` / `worker` / `disabled`                  | `main`                  |
| `listEngine`              | `full` / `dual` / `disabled`                    | `full`                  |
| `listDefault`             | `full` / `auto` / `disabled`                    | `full`                  |
| `persistenceArchitecture` | `monolith` / `split-facade`                     | `monolith`              |

一つの production phase のstandard candidateは、直前に受理したstandardから高々一つの
behavior dimensionだけを変える。containment projectionはこの数に含めない。source-onlyの
refactor、test、document、toolingはdimensionを変えない。

containment は accepted standard の複製ではなく、static policy が生成する exact safe
projection である。P0 の legacy lifecycle containment/bootstrap は既存applicationを
保つため`xlsxExecution=main`、`listEngine=full`、`listDefault=full`とする。Phase 1以降の
prompt-close-all containmentはrecovery-only graphなので`xlsxExecution=disabled`、
`listEngine=disabled`、`listDefault=disabled`とする。どちらも
`releaseRole=containment`で、PWA/CSS/CSP/DB/persistence safetyを現在のfloorより下げない。
`disabled`はprompt-close-all containment以外のrole/lifecycleでは拒否する。

### 4.5 Safety floor

- `minimumSafetyFloors` は Release A hard-off、DB compatibility、provider/env isolation、
  CSP floor、PWA recovery floor、data preservation、artifact/resource limit を含む。
- CSP enforcement後は`minimumSafetyFloors.styleSrcAttr`を機械fieldとして持ち、Phase 4〜7は
  `unsafe-inline`、P8 acceptance後は`none`にする。
- standard candidate は `minimumSafetyFloors` と `acceptedStandardFloors` の両方を満たす。
- containment は `minimumSafetyFloors` と active policy の exact projection を満たす。
- rollback は package が作成された当時の自己申告ではなく、現在の active policy で
  eligibility を再計算する。
- PWA floor が `prompt-close-all-v1` へ進んだ後は、`legacy-auto-update-v1` package を
  rollback/containment に選ばない。

### 4.6 DB compatibility contract

planned `config/db-compatibility-contract.json` を JCS canonicalize し、その SHA-256 を
fingerprint とする。contract は少なくとも次を含む。

- IndexedDB 名、version、forward ceiling、store/index/keyPath、known internal key
- Release A journal/archive/checkpoint/map/syncQueue の compatibility version
- remote metrics table/function/view の必要 schema と privilege floor
- dormantなCSP sanitized report table/aggregate/retention functionのschemaとprivilege floor
- Release A hard-off capability

次の全 object は同じ field を持ち、manifest → index → provider evidence → binding →
Release State で URI/fingerprint を exact に伝播させる。

```ts
type DbCompatibilityBinding = {
  contractUri: string;
  fingerprint: string;
};

requiredDbCompatibility: DbCompatibilityBinding;
```

本計画の Phase 1〜8 は remote/IndexedDB compatibility contract を変更しないため、schema
v1 の eligibility predicate は exact equality とする。将来の互換範囲や migration は別
schema/plan で導入する。

### 4.7 Static policy compatibility

新規 candidate は必ず active `releasePolicyHash` を使用する。既存 binding は current
policy の `compatiblePredecessorPolicies` に旧 policy URI/hash が明示されている場合だけ
rollback inventory に残せる。

各 compatibility entry は次を固定する。

- predecessor policy URI/hash
- eligible source/package/deployment または dimension predicate
- 許可 action (`rollback` / `containment`)
- `minimumSafetyFloors` と DB fingerprint
- expiry と owner

暗黙の推移律を使わず、current policy が許可する predecessor をすべて直接列挙する。
compatibility は旧 package の許可 action と identity set を維持または縮小できるが、
拡大や safety floor の低下はできない。event chain から predecessor policy bytes を
解決し、hash と monotonicity を検証できない binding は ineligible とする。

## 5. 全体不変条件

本planのhuman operator modelは`single-human-single-github-account/v1`とする。collector実施者、
baseline選定者、audit実施者、実機実施者、reviewer、publisher、三つのapprover roleは一つの実在する
GitHub accountが担当でき、人物identityのdistinct性をFormal Exit条件にしない。reviewは対象evidenceを
immutable化した後の別actionとして記録し、producer/reviewer/executorに必要な別workflow run、時刻順序、
exact hashは維持する。Vercel/PAT/device key、DB owner/executor/observer/backupなどのservice identityと
credentialはhuman accountではなく、同じ一人が管理しても権限・secretを統合しない。

1. tracked file を変更する前後で clean/dirty state と差分 owner を確認する。
2. build は clean `sourceSha`、lockfile、exact toolchain、allowlist 済み public env だけを
   入力にする。
3. test した prebuilt bytes と deploy/promote する prebuilt bytes を同一にする。
4. branch 名、Git tag、provider alias、ローカル `dist/` 単独を release evidence にしない。
5. standard と同じ source から containment companion を作り、両者を一つの package index
   で束縛する。
6. capability v1 は source-only、release identity は variant-aware とし、immutable URL が
   異なる bytes を返す設計を禁止する。
7. secret、credential value、raw user data、free-form event title/item text を artifact、
   log、evidence、metrics に含めない。
8. exact `/api` と unknown `/api/**` は SPA fallback へ流さず JSON/no-store を返す。
9. provider/project/environment binding が一つでも不明なら production promotion を止める。
10. Release State は protected transaction clock と append-only event を唯一の操作状態にする。
11. promotion、rollback、containment、policy activation は CAS event なしに実行しない。
12. provider alias 変更と Release State append の間で失敗し得るため、検証済み reconcile
    手順を必須にし、「分散 atomic」とは表現しない。
13. production standard の `release-accepted` は source-hardened identity、fresh v1
    evidence、24 時間以上の observation、三役分の承認なしに append しない。同一provider
    reviewerによる三役兼任は許可する。containment は
    frozen v1でrole帰属を証明できないためacceptedにしない。
14. P0 の metrics-disabled bootstrap containment は一時 active にできるが、accepted に
    できない。
15. PWA runtime identity 検査は UI、role entry import、App/data mutation の gate であり、
    browser の natural Service Worker activation を阻止するものではない。
16. runtime identity failure で cache deletion、`skipWaiting()`、強制 reload、data mutation
    を行わない。
17. current open client の controller は自然に変えない。全 client close 後に waiting
    Worker が activate し得ることを前提に、次回起動を recovery-first にする。
18. Release A hard-off と legacy physical deletion 0 を全 phase で維持する。
19. IndexedDB upgrade、repair、checkpoint、payload commit は既存 atomicity を弱めない。
20. unknown/future/invalid persistence record と raw legacy source を推測変換・自動削除しない。
21. UI component から `indexedDB`、`localStorage`、XLSX library、Service Worker lifecycle
    detail への新規直接 edge を増やさない。
22. error path、cancel、offline、timeout、multi-client、crash recovery を happy path と同じ
    gate に含める。
23. quality baseline は増加禁止、最終的に warning/waiver/temporary bridge 0 を目指す。
24. 日本語を含む tracked text は UTF-8 BOM なしと既存 EOL を維持する。

## 6. 目標 architecture

### 6.1 Toolchain、dependency、command graph

target dependency は次の exact version と導入 gate に固定する。各行の compatibility cluster
は atomic に更新し、peer/engine が一つでも不整合ならその cluster を production graphへ
入れない。後続 gate の package を Phase 0B で先行追加しない。

| cluster                      | exact version       | 導入 gate |
| ---------------------------- | ------------------- | --------- |
| Node                         | `24.19.0`           | 0B        |
| npm                          | `11.19.0`           | 0B        |
| `@types/node`                | `24.13.3`           | 0B        |
| Vite                         | `8.2.0`             | 0B        |
| `@vitejs/plugin-react`       | `6.0.5`             | 0B        |
| `vite-plugin-pwa`            | `1.3.0`             | 0B        |
| Workbox packages             | `7.4.1`             | 0B        |
| `@vite-pwa/assets-generator` | `1.0.2`             | 0B        |
| Vitest / coverage provider   | `4.1.10`            | 0B        |
| jsdom                        | `30.0.1`            | 0B        |
| ESLint                       | `9.39.5`            | 0B        |
| `typescript-eslint`          | `8.66.0`            | 0B        |
| `eslint-plugin-react-hooks`  | `7.1.1`             | 0B        |
| Playwright                   | `1.62.1`            | 0B        |
| axe-core                     | `4.12.1`            | 0C        |
| `canonicalize`               | `3.0.0`             | 0C        |
| `yazl` / `yauzl`             | `3.3.1` / `3.4.0`   | 0C        |
| `pg` / `@types/pg`           | `8.22.0` / `8.20.4` | 0C        |
| Vercel CLI                   | `58.5.1`            | 0C        |
| Supabase CLI                 | `2.111.0`           | 0D        |
| Tailwind CSS                 | `3.4.19`            | 2A        |
| PostCSS                      | `8.5.25`            | 2A        |
| Autoprefixer                 | `10.5.4`            | 2A        |
| `@zip.js/zip.js`             | `2.8.34`            | 3         |
| `@tanstack/react-virtual`    | `3.14.9`            | 5C        |

React は `18.3.1`、TypeScript は `5.9.3` を維持する。表にない既存 direct
dependency/devDependency は baseline lockfile の resolved version へ exact pin し、別 cluster
PR なしに upgrade しない。`package.json` の top-level range から `^` と `~` を除き、
全 top-level package を `config/toolchain-versions.json` に列挙する。

CI は Node/npm を exact に固定する。provider runtime は provider が提供する `24.x` family
として別 field に固定し、minor/patch が provider により更新され得ることを evidence に
記録する。

canonical command graph は一方向にする。

```text
quality
  ├─ encoding
  ├─ typecheck
  ├─ lint
  ├─ test:unit / test:integration / test:worker
  ├─ architecture / test-project-membership
  ├─ coverage
  └─ browser / a11y / visual

build:release-a
  ├─ build:app
  └─ verify-release-a-build（build:app 完了後）

artifact:build
  └─ pinned vercel build --prod
       └─ build:release-a

artifact:verify
  └─ package, route, identity, DB, policy, deterministic archive
```

### 6.2 Canonical artifact と deterministic package

`scripts/build-release-artifact.mjs` は clean checkout から pinned Vercel CLI の
`vercel build --prod` を呼ぶ。`.vercel/output/**` は CLI に生成させ、Build Output API file
を自作・後処理しない。`scripts/verify-release-artifact.mjs` が output を検証してから
package 化する。

planned `contracts/artifact-manifest-v1.schema.json` の `ArtifactManifest` は少なくとも次を
持つ。

```ts
type ArtifactManifest = {
  schemaVersion: 1;
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  dimensions: Record<string, string>;
  buildInputClosureHash: string;
  lockfileSha256: string;
  toolchainPolicyHash: string;
  publicBuildEnvHash: string;
  providerConfigurationHash: string;
  providerPolicyHash: string;
  releasePolicyHash: string;
  requiredDbCompatibility: DbCompatibilityBinding;
  publicIdentityKind: "release-identity-v1" | "legacy-bootstrap-v1";
  bootstrap: null | {
    inputUri: string;
    inputSha256: string;
    rawDistManifestUri: string;
    rawDistManifestSha256: string;
  };
  publicResponseHashes: Record<string, string>;
  roleEntryGraphHash: string;
  outputFiles: Array<{ path: string; sha256: string; size: number }>;
};

type PackageArtifactRef = {
  releaseRole: "standard" | "containment";
  variantId: string;
  manifestUri: string;
  manifestSha256: string;
  archiveUri: string;
  archiveSha256: string;
};

type ReleasePackageIndex =
  | {
      schemaVersion: 1;
      packageKind: "source-hardened-pair";
      sourceSha: string;
      buildId: string;
      toolchainPolicyHash: string;
      providerConfigurationHash: string;
      providerPolicyHash: string;
      releasePolicyHash: string;
      requiredDbCompatibility: DbCompatibilityBinding;
      artifacts: [PackageArtifactRef, PackageArtifactRef];
    }
  | {
      schemaVersion: 1;
      packageKind: "legacy-bootstrap-single";
      sourceSha: string;
      buildId: string;
      toolchainPolicyHash: string;
      providerConfigurationHash: string;
      providerPolicyHash: string;
      releasePolicyHash: string;
      requiredDbCompatibility: DbCompatibilityBinding;
      bootstrapInputUri: string;
      bootstrapInputSha256: string;
      rawDistManifestUri: string;
      rawDistManifestSha256: string;
      artifact: PackageArtifactRef & { releaseRole: "containment" };
    };
```

source-hardened pairの`artifacts`はstandard一件、containment一件をrole順に持つ。
`ReleasePackageIndex`はarchive再取得用のimmutable URI/hashを必ず持つ。indexはarchiveの
外に置き、自己参照を作らない。
standard と companion の source/toolchain/release policy/provider policy/provider configuration/
DB contract は exact 一致し、dimension は static policy が許可する projection だけ異なる。
manifestの`outputFiles`はPOSIX path順とし、manifest自身を含めない。

`config/artifact-archive-policy.json` と `scripts/deterministic-zip.mjs` は
`yazl@3.3.1` で archive を作り、`yauzl@3.4.0` で独立検証する。次を固定する。

- POSIX relative path、UTF-8 byte order、directory entry なし
- mtime `1980-01-01T00:00:00Z`
- fixed compression level、file mode、UTF-8 flag
- comment/unknown extra field/symlink/hardlink/device file なし
- traversal、absolute path、duplicate、case collision、extra file を拒否

異なる temp path、timezone で二回作成した archive の SHA-256 が一致し、展開後の path/hash
set が manifest と exact 一致することを gate にする。

legacy bootstrapはbaseline sourceをそのsourceに固定したrecorded Node/npm/lockfileで
`dist/**`までbuildし、古いcheckoutでVercel buildを実行しない。
`contracts/bootstrap-input-v1.schema.json`はsource/toolchain/lockfile、raw-dist
manifest URI/hash、二つのfixed API template hash、staging verifier hash、generated
package/lock/vercel config hash、provider project/configuration hashを束縛する。

`scripts/build-release-artifact.mjs --bootstrap`は一時staging rootを次のallowlistだけで作る。

- `public/**`: raw `dist/**`のbyte-for-byte copy
- `api/persistence-release-a-metrics.mjs`:
  `scripts/templates/bootstrap-metrics-disabled.mjs`のfixed bytes
- `api/not-found.mjs`: `scripts/templates/bootstrap-api-not-found.mjs`のfixed bytes
- dependency 0のgenerated `package.json`/lockfile、generated `vercel.json`
- `scripts/verify-bootstrap-staging.mjs`のfixed copy
- pinned CLIが必要とするproject binding

generated install/build commandはdependency 0のinstallと
`verify-bootstrap-staging`だけを実行し、application build script、old source、
post-processingを呼ばない。pinned `vercel build --prod`の前後で
`public/**`と`.vercel/output/static/**`のpath/hash setがraw-dist manifestとexact一致することを
検証する。API function outputはtemplate/input hashとdeployed route probeで束縛する。

### 6.3 Provider deployment と public observation

`ProviderDeploymentEvidence` は protected workflow が provider API と deployed HTTP response
から作り、planned schema で検証する。

```ts
type PublicIdentityEvidence =
  | {
      identityKind: "release-identity-v1";
      identity: ReleaseIdentity;
      identitySha256: string;
    }
  | {
      identityKind: "legacy-bootstrap-v1";
      sourceSha: string;
      buildId: string;
      sourceState: "clean";
      capabilitySha256: string;
      htmlMetaSha256: string;
      serviceWorkerSha256: string;
      rawDistTreeSha256: string;
      rawDistManifestUri: string;
      rawDistManifestSha256: string;
      bootstrapInputUri: string;
      bootstrapInputSha256: string;
    };

type ProviderDeploymentEvidence = {
  schemaVersion: 1;
  providerProjectId: string;
  providerDeploymentId: string;
  deploymentUrl: string;
  sourceSha: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  artifactManifestHash: string;
  packageIndexHash: string;
  providerConfigurationHash: string;
  providerPolicyHash: string;
  releasePolicyHash: string;
  requiredDbCompatibility: DbCompatibilityBinding;
  publicIdentity: PublicIdentityEvidence;
  routeProbeEvidenceHash: string;
  environmentPresenceEvidenceHash: string;
};

type ProviderDomainAssignment = {
  productionDomain: string;
  previousDeploymentId: string | null;
  assignedDeploymentId: string;
};

type ProviderAssignmentEvidence =
  | {
      schemaVersion: 1;
      evidenceKind: "assignment-receipt";
      providerProjectId: string;
      assignments: ProviderDomainAssignment[];
      assignmentApiReceiptSetHash: string;
    }
  | {
      schemaVersion: 1;
      evidenceKind: "assignment-validation";
      providerProjectId: string;
      assignmentReceiptUri: string;
      assignmentReceiptSha256: string;
      assignments: ProviderDomainAssignment[];
      productionProbeEvidenceHash: string;
    };
```

`config/provider-policy.json` は secret value を持たず、expected project/team/domain、production
environment 名、provider Node family、environment required/forbidden names、raw request
platform ceiling、WAF/rate-limit logical rule、log field/retention、HSTS ownershipを固定する。
staged productionでは`autoAssignCustomProductionDomains: false`、
`gitProductionAutoDeploy: false`を固定する。Vercel Git integrationを残す場合は
`git.deploymentEnabled`でexact production branchを`false`、許可したpreview branchだけを
`true`にし、provider APIのproject settingとpush probeで強制を検証する。providerがこの
branch制御を提供しない場合はGit integrationを切断し、CLI prebuilt deployだけを許可する。
数値と project binding が未確定、null、placeholder の状態で `P0-ARTIFACT` を通さない。
この file の canonical hash を `providerPolicyHash` とする。provider APIから読んだproject
ID、framework/build/output設定、Node family、function region/limit、owned domain set、
protection、environment name/presenceをsecret valueなしでcanonicalizeしたhashを
`providerConfigurationHash` とし、build前とpromotion直前/直後に再採取する。現在の
domain→deployment assignmentはこのhashから除外し、変更前後を
`ProviderAssignmentEvidence`として別に保存して`deployment-assigned`/
`assignment-validated` eventへ束縛する。
両evidenceの`assignments`はproduction domainのUTF-8 byte順、重複なしとし、policyのowned
production domain setとexact一致させる。receipt setは全domainの変更前後を含み、
validationは全domainを同じassigned deployment IDへprobeする。一部domainだけの成功を
assignment成功として扱わない。

deploy は package を展開して manifest を再検証し、次を使用する。

```text
vercel deploy --prebuilt --prod --skip-domain
vercel promote <verified-deployment>
vercel rollback <verified-deployment>
```

provider alias を変える前に immutable deployment URL で全 probe を通す。production alias の
変更後に同じ body hash、deployment ID、header、route を再検証する。

route ownership は次の順に固定する。

| request                              | owner                                     | response               |
| ------------------------------------ | ----------------------------------------- | ---------------------- |
| `/api/persistence-release-a-metrics` | exact metrics function                    | §6.4                   |
| `/api/csp-report`（Phase 2B以降）    | exact CSP report function                 | §6.7                   |
| exact `/api`                         | `api/not-found.mjs` への provider rewrite | JSON 404/no-store      |
| unknown `/api/**`                    | `api/not-found.mjs` への provider rewrite | JSON 404/no-store      |
| existing static/PWA/identity path    | filesystem output                         | declared content/cache |
| その他の navigation                  | `/index.html`                             | SPA                    |

filesystem function precedenceと rewrite 順序は pinned `vercel build` output の route table test
および preview/immutable deployment probe の両方で検証する。`api/not-found.mjs` は
environment/body/network を読まず、全 method へ
`404 {"error":"api-not-found"}` を返す。
Phase 2Bより前の`/api/csp-report`もunknown APIとしてこのJSON 404を返し、CSP DBへの
credential/route edgeを持たない。

### 6.4 Release A metrics API と DB

既存client contractは`src/utils/persistenceReleaseAMetrics.ts`、
`src/utils/persistenceReleaseAMetricsBackend.ts`とplanned
`contracts/persistence-release-a-metrics-v1.json`で凍結する。checkpoint-adoption、
fallback-repair、load、save、startup、cleanupのclosed union、outcome/mode/reason、
startup duration bucket、requestのexact six keys、client→API→SQL mappingを一つの
characterization contractからexhaustiveに照合する。free-form title/item/path/raw payloadを
追加しない。

recorderはversioned sessionStorage aggregateと同一windowのCustomEventを維持し、backend
subscriptionはstandard application rootで一度だけinstallする。requestの
`buildId===sourceSha`、same-origin endpoint、`credentials:"omit"`、`cache:"no-store"`、
`keepalive:true`を固定する。storage、event dispatch、subscriber、environment read、
serialize、fetch、uninstallの全failureはnon-throwing/fire-and-forgetとし、load/save/
migration/recovery transactionやUI readinessを変更しない。containment recovery-only rootは
persistence event producerをimportせず、metricsを生成したとみなさない。

source-hardened handler は dedicated environment pair のみを使用する。

- required:
  `PERSISTENCE_METRICS_SUPABASE_URL`、
  `PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY`、
  `PERSISTENCE_METRICS_EXPECTED_PROJECT_REF`、
  `PERSISTENCE_METRICS_EXPECTED_PROVIDER_PROJECT_ID`、
  `PERSISTENCE_METRICS_ALLOWED_ORIGIN`、
  `VERCEL_DEPLOYMENT_ID`、`VERCEL_PROJECT_ID`、
  `VERCEL_PROJECT_PRODUCTION_URL`、`VERCEL_URL`
- forbidden:
  `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、
  `PERSISTENCE_METRICS_ALLOW_GENERIC_FALLBACK`
- Supabase URL/project ref、`VERCEL_PROJECT_ID`、production/current deployment origin、request
  host、`Sec-Fetch-Site: same-origin` を exact 検証する。
- upstream は bounded timeout、`redirect: "error"`、`Prefer: return=minimal` を使用する。
- application の 1,024-byte limit は declared length、raw stream、normalized JSON に適用する。
  provider が preparse した body の raw byte ceiling は provider policy と deployed probe が
  所有する。

response contract は次で固定する。すべて
`Content-Type: application/json; charset=utf-8` と `Cache-Control: no-store` を持つ。

| condition                                 | status/body                                           |
| ----------------------------------------- | ----------------------------------------------------- |
| valid POST                                | `202 {"accepted":true}`                               |
| method mismatch                           | `405 {"error":"method-not-allowed"}` と `Allow: POST` |
| origin mismatch                           | `403 {"error":"forbidden"}`                           |
| unsupported type                          | `415 {"error":"unsupported-media-type"}`              |
| invalid JSON                              | `400 {"error":"invalid-json"}`                        |
| invalid schema                            | `400 {"error":"invalid-schema"}`                      |
| oversized body                            | `413 {"error":"request-too-large"}`                   |
| config/project mismatch                   | `503 {"error":"metrics-backend-unavailable"}`         |
| timeout/network/redirect/upstream non-2xx | `502 {"error":"metrics-insert-failed"}`               |

P0 bootstrap の fixed disabled adapter は credential/environment/network を読まない。POST は
`503 {"error":"metrics-temporarily-unavailable"}`、他 method は上記 `405` を返す。これは
一時 containment 専用で、v1 observation を満たしたことにはならない。

`contracts/persistence-release-a-startup-bursts-v1.json` は `fresh`、
`populated-no-recovery`、`recovery-candidate` の三 profileについて、初期storage fixture
hash、startup完了条件、quiet period、期待するsanitized tuple multisetを固定する。WAF/
rate-limit値やproduction probeの期待event数は、このcontract reviewなしに変更しない。

forward-only hardening migration は次を行う。

- raw table と aggregate view の `service_role SELECT` を revoke する。
- API に必要な raw insert と sequence privilege だけを残す。
- CSP用のinsert-only sanitized report table、bounded aggregate/retention functionをPhase 0Dで
  dormant provisionし、application/API credentialからはPhase 2Bまで到達不能にする。
- operator read は固定 `search_path`、bounded time range/row count の
  `SECURITY DEFINER` function の `EXECUTE` だけにする。
- retention delete は bounded batch、lock/statement timeout、dry-run、audit を持つ。
- local disposable Postgres/Supabase 環境で migration checksum、schema/privilege diff、
  function abuse、timeout、concurrency を試験する。

`config/metrics-retention-policy.json` は primary raw retention 30 日、UTC 毎時 17 分、
batch 5,000 rows、1 run 最大 12 batches、lock timeout 1,000 ms、statement timeout
15,000 ms、CSP sanitized report retention 7日、last-success 2 時間超の blocking alertを
固定する。DB `pg_cron`を削除主体、scheduled protected workflowをlast-success/driftの
検証主体にする。backup/PITR retentionは別ownerとし、primary purgeとbackup expiryを
同一completionにしない。

`scripts/provider/verify-provider-policy.mjs`はprovider APIからproject/configuration、
domain auto-assignment、Git auto-deploy、WAF/rate rule、log retentionをread-only取得して
policyとの差分をblocking evidenceにする。provider controlの変更は一人のoperatorがprotected
runbookで実行・再確認できるが、変更actionとreview actionを分け、before/after API receiptを保存する。
`scripts/verify-metrics-retention.mjs`はcron definition、last-success、deleted row count、
timeout、dry-run、CSP retention、backup ownerを検証する。
`.github/workflows/metrics-retention.yml`は毎時42分にこのread-only verifierを実行し、
2時間超またはdriftをrelease blockerとして通知する。

### 6.5 Protected Release State と evidence store

Release State は application/metrics DB と分離した protected PostgreSQL control DB に実装
する。browser、application function、preview deployment は接続 credential を持たない。
GitHub protected environment `foundation-release-state` のsecret
`RELEASE_STATE_DATABASE_URL`だけをrelease workflowへ渡し、TLS `verify-full`、allowlist済み
host/database/roleを`config/release-state-store.json`で検証する。credentialは90日ごと、
reviewer/incident変更時は即時rotateし、DB owner、release executor、backup operatorを
別のservice role/credentialにする。同じhuman operatorが管理できるがcredentialを共用しない。同configはPostgreSQL major 17、UTC、migration checksum、connect/statement
timeout、production CA fingerprint、local container image digestを固定する。

planned source:

- `config/release-state-store.json`
- `ops/release-state/migrations/0001_release_state_store.sql`
- `scripts/release-state/postgresStore.mjs`
- `scripts/release-state/evidenceStore.mjs`
- `scripts/release-state/approvalResolver.mjs`
- `scripts/verify-release-state.mjs`

SQL は次の table/function を持つ。

```text
release_state_heads(namespace primary key, sequence, event_hash)
release_state_namespace_roles(namespace primary key, executor_role)
release_state_events(namespace, sequence, event_hash, previous_hash,
                     append_id, event_bytes, committed_at,
                     primary key(namespace, sequence),
                     unique(namespace, append_id),
                     unique(namespace, event_hash))
release_evidence_objects(namespace, sha256, media_type, byte_length,
                         object_bytes, committed_at,
                         primary key(namespace, sha256))
compare_and_append(namespace, expected_sequence, expected_hash,
                   append_id, canonical_event_bytes)
put_evidence_if_absent(namespace, expected_sha256, media_type, object_bytes)
```

最初のappendは`expected_sequence=0`、`expected_hash=null`だけを許可し、head rowの
`INSERT ... ON CONFLICT DO NOTHING`とrow lockを同じtransactionで行う。
`compare_and_append`はexpected sequence/hash、unique append ID、canonical event hashを
検証し、event insertとhead updateを一transactionで行う。戻りreceiptはnamespace、
sequence、event hash、`clock_timestamp()`のcommittedAt、`replayed`を持つ。同じappend ID/
同じbytesのretryだけをidempotent successにし、異なるbytesを拒否する。
両functionは`current_user`がowner設定のnamespace→executor roleと一致しないnamespaceを
拒否する。
events/evidenceへのdirect insert/update/delete/truncateをrevokeし、security-definer
functionの最小executeだけをrelease executorへgrantする。immutable trigger、
credential denial、concurrent first append/CAS、retry、backup restoreをdisposable
Postgresで試験する。

URI は次だけを許可し、adapter が exact namespace/project binding で解決する。

```text
release-state://<namespace>/events/<sequence>/<sha256>
release-state://<namespace>/evidence/<sha256>
```

evidence object は content-addressed、write-once、最大 256 MiB とし、同じ hash に異なる
bytes を書けない。schema v1ではstate eventとevidence objectをproject lifetime中無期限保持
し、purge API/maintenance credentialを実装しない。容量alertは70%/85%で発火し、retentionを
導入する場合はreference tableと別schema/planを先に追加する。event chain、approval、
provider evidence、QA bundleのauthoritative timestampはstoreのcommit receiptを使用する。

`config/approval-policy.json`はhuman operator model
`single-human-single-github-account/v1`、trusted issuer
`https://token.actions.githubusercontent.com`、repository、workflow ref、protected
environment、role→reviewer team mappingを固定する。`ApprovalReference`は
`config/release-state.schema.json#/$defs/approvalReference`を正本とし、次を持つ。

```ts
type ApprovalReference = {
  uri: string;
  sha256: string;
  approvalId: string;
  operationId: string;
  subjectSha256: string;
  trustedIssuer: "https://token.actions.githubusercontent.com";
  issuerReceiptUri: string;
  issuerReceiptSha256: string;
  workflowRunId: string;
  protectedEnvironment: string;
  providerReviewerId: string;
  role: "releaseOwner" | "dataSafetyReviewer" | "operationsReviewer";
  decision: "APPROVED";
  approvedAt: string;
};
```

resolverはGitHub protected environment review APIのauthoritative receiptとworkflow OIDC
claimsを取得してimmutable storeへ保存し、issuer/repository/workflow/environment/reviewer
team、target operation/package/event hash、decisionを検証する。roleとreviewer identityは
receiptから導出し、入力JSONの自己申告を信用しない。三つのrole teamとrole-bound approval
IDはdistinctに保つ一方、`providerReviewerId`はrequired role間で重複可とする。同じGitHub
ユーザーが複数のconfigured teamでactive memberなら、一つのenvironment reviewからteam/role別の
receiptを生成する。pre-promotionは`releaseOwner`と`dataSafetyReviewer`、standard acceptanceは
三roleを要求する。

`config/release-state.schema.json`は次の具体型とclosed enumを正本にする。

```ts
type ImmutableObjectRef = { uri: string; sha256: string };

type DeploymentBinding = {
  bindingId: string;
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  publicIdentityKind: "release-identity-v1" | "legacy-bootstrap-v1";
  providerProjectId: string;
  providerDeploymentId: string;
  deploymentUrl: string;
  packageIndex: ImmutableObjectRef;
  artifactManifest: ImmutableObjectRef;
  providerEvidence: ImmutableObjectRef;
  releasePolicy: ImmutableObjectRef;
  providerPolicy: ImmutableObjectRef;
  providerConfigurationHash: string;
  requiredDbCompatibility: DbCompatibilityBinding;
};

type RollbackInventoryEntry = {
  binding: DeploymentBinding;
  acceptedEvent: ImmutableObjectRef;
  evaluatedPolicy: ImmutableObjectRef;
  eligibleActions: Array<"rollback" | "package-redeploy">;
  eligibility: "eligible" | "ineligible";
  reasonCodes: string[];
};

type PendingOperation = {
  operationId: string;
  kind:
    | "promote-standard"
    | "rollback-standard"
    | "activate-containment"
    | "redeploy-standard"
    | "redeploy-containment";
  expectedState: { sequence: number; eventHash: string };
  targetBinding: DeploymentBinding;
  originBinding: DeploymentBinding | null;
  originCompanionBinding: DeploymentBinding | null;
  companionBinding: DeploymentBinding | null;
  previousBinding: DeploymentBinding | null;
  emergencyRecoveryBinding: DeploymentBinding;
  approvalRefs: ApprovalReference[];
  preparedAt: string;
};

type PendingAcceptance = {
  operationId: string;
  standardBinding: DeploymentBinding;
  companionBinding: DeploymentBinding;
  assignmentValidationEvidence: ImmutableObjectRef;
  observationStartedEvent: ImmutableObjectRef;
  observationNotBefore: string;
  minimumObservationEndsAt: string;
};

type ReleaseStateSnapshot = {
  sequence: number;
  legacyObservedProduction: {
    observationUri: string;
    observationSha256: string;
  } | null;
  activeProduction: DeploymentBinding | null;
  acceptedStandard: DeploymentBinding | null;
  bootstrapRecovery: DeploymentBinding | null;
  containmentCompanion: DeploymentBinding | null;
  pendingOperation: PendingOperation | null;
  pendingAcceptance: PendingAcceptance | null;
  containmentIncident: {
    kind: "source-hardened" | "legacy-bootstrap";
    binding: DeploymentBinding;
    activatedAt: string;
    recoveryDeadline: string;
  } | null;
  standardRecovery: {
    containmentBinding: DeploymentBinding;
    targetStandard: DeploymentBinding | null;
    recoveryDeadline: string;
  } | null;
  rollbackInventory: RollbackInventoryEntry[];
  minimumSafetyFloors: Record<string, string>;
  acceptedStandardFloors: Record<string, string>;
  currentDbCompatibility: DbCompatibilityBinding;
  activeReleasePolicy: { uri: string; sha256: string };
};

type ReleaseEventEnvelope = {
  schemaVersion: 1;
  namespace: string;
  sequence: number;
  eventType:
    | "state-initialized"
    | "policy-activated"
    | "db-contract-activated"
    | "promotion-prepared"
    | "deployment-assigned"
    | "assignment-validated"
    | "observation-started"
    | "release-accepted"
    | "operation-aborted"
    | "temporary-containment-activated"
    | "containment-activated"
    | "rollback-activated"
    | "package-redeploy-activated"
    | "state-reconciled";
  operationId: string;
  appendId: string;
  previousEventHash: string | null;
  payload: Record<string, unknown>;
  payloadSha256: string;
  evidenceRefs: ImmutableObjectRef[];
  approvalRefs: ApprovalReference[];
};
```

event typeごとのpayload schemaは`unevaluatedProperties:false`とし、`payloadSha256`はpayloadの
JCS bytes、event hashはenvelope全体のJCS bytesから計算する。

production namespace の `state-initialized` は Phase 0D の DB hardeningとmandatory
bootstrapのbuild/deploy/probeが完了した後に一度だけ行う。payloadはfinal DB contract、
unmanaged productionのimmutable HTTP/provider observation、verified
`bootstrapRecovery` bindingを同時に持つ。unmanaged productionは
`legacyObservedProduction`に記録するが、package binding、accepted release、rollback
inventoryとはみなさない。最初のsource-hardened acceptanceでこのfieldをnullにし、
`bootstrapRecovery`はPhase 1のindependent prompt-close-all companion受理まで保持する。
event chain上の元observation/package evidenceはその後も保持する。

`DeploymentBinding` は provider evidence hash、manifest/index hash、source、variant/role、
public identity kind、provider project/deployment、release/provider policy hash、
provider configuration hash、`requiredDbCompatibility` を exact 参照する。重複 field は resolver
が全 chain の一致を検証するために持ち、片方だけを更新できない。

`rollbackInventory`は`release-accepted`と、そのbindingを付け替えた後続
`package-redeploy-activated`/`state-reconciled` event chainから再計算できるcacheである。
新しい`release-accepted`でentryを追加し、redeploy/reconcileでbinding lineageを進め、
`policy-activated`/`db-contract-activated`で全entryのeligibilityとreason codeを再評価する。
ineligible entry、旧binding、artifactは削除しない。各terminal stateは、eligibleな旧
standardのprovider rollback/package redeploy、またはcurrent accepted standardに束縛された
verified containment companionの少なくとも一方をrecovery optionとして持つ。
`eligibleActions`は現在実行可能なactionだけをUTF-8 byte順、重複なしで持つ。
`eligibility="eligible"`は配列がnon-emptyの場合に限り、`reasonCodes`は各除外actionの
closed reason codeを持つ。deploymentが利用不能でもarchiveがcurrent policyを満たす場合は
`rollback`を除外して`package-redeploy`だけを残せる。

event は `state-initialized`、`policy-activated`、`db-contract-activated`、
`promotion-prepared`、`deployment-assigned`、`assignment-validated`、`observation-started`、
`release-accepted`、`operation-aborted`、`temporary-containment-activated`、
`containment-activated`、`rollback-activated`、`package-redeploy-activated`、
`state-reconciled` に限定する。
各 transition の expected predecessor、required approval、provider observation、timeout、
failure state を `config/release-state.schema.json` で固定する。
`release-accepted` payloadは`releaseRole: "standard"`をconstにする。
`temporary-containment-activated`と`containment-activated`はaccepted
standard/floor/inventoryを変更できない。`rollback-activated`のtargetはcurrent policyで
`rollback` actionがeligibleなaccepted standard bindingだけを許可する。

`PendingOperation.originBinding`は二つのredeploy kindだけnon-nullとし、他kindではnullを
constにする。`redeploy-standard`ではorigin accepted eventからmatching companionを解決し、
`originCompanionBinding`と`companionBinding`をnon-nullにする。前者はaccepted event当時の
binding、後者はcurrent policyでverifiedな再利用または再配備後bindingである。
`redeploy-containment`と非redeploy kindでは`originCompanionBinding`をnullにする。

`package-redeploy-activated` payloadはorigin accepted eventまたはrecovery pointer、standard/
containment memberごとのorigin/target binding、package index、archive URI/hashまたは
verified reuse evidence、全domainのassignment validationをexactに持つ。standard branchは
current policyで`package-redeploy` eligibleなaccepted packageと、そのaccepted eventに
束縛されたmatching companionだけを許可する。companion deploymentが利用不能ならその
archiveもbuildなしで再配備し、利用可能なら再probe evidenceで同じbindingを再利用する。
activationは`activeProduction`、`acceptedStandard`、`containmentCompanion`、inventory
bindingを原子的に付け替える。元のaccepted eventとfloorは保持し、新しいacceptanceを
捏造しない。containment branchはcurrent companionまたは`bootstrapRecovery`のexact
packageだけを許可し、新bindingへ対応するrecovery pointerと`activeProduction`を
付け替えるが、accepted standard/floor/inventoryを変更せず、通常のcontainment種別と
deadlineを設定する。

`db-contract-activated` は初期化後の将来の forward-only migration だけに使用し、remote
fingerprint、二役分の承認（同一provider reviewerによる兼任可）、直前/直後 contract を束縛して
`currentDbCompatibility` を更新する。
新 contract と exact 一致しない active package を残す transition は拒否する。

provider alias 変更後に append が失敗した場合は pending operation を保持し、provider の
実状態と immutable deploymentを再観測して、prepared operationに対応するactivation、
`state-reconciled`、またはverified rollbackのいずれかをappendする。手動でsnapshotを
編集しない。

既存 `release-a-evidence/v1` のfield shape、hash chain、観測・sample条件は凍結する。2026-08-10の
single-account amendmentでは、approver identityに加えてbaseline selector/reviewer、実機
executor/reviewer、historical auditor/reviewerの人物identity一意性を解除する。各role/action field、
三roleの欠落、時刻と順序、source、evidence referenceの検証は維持する。追加
`release-evidence-bundle/v1` は v1 JSON、artifact/provider/DB/policy/approval/state event の
hash chain を包むだけで、v1 条件を弱めない。production standardのすべての
`release-accepted`はexact sourceのfresh v1、24時間以上、minimum sample、三役分の承認
（同一provider reviewerによる兼任可）を
要求する。既存metrics rowはvariant ID/provider deployment IDを持たず、same-sourceの
old standard clientとcontainmentを確実に区別できない。したがってcontainmentは
source-hardened/legacy bootstrapのどちらも`release-accepted`にせず、time-bounded incident
stateからstandardへ復旧する。

standardのobservation windowは
`assignment-validated`のstore commit時刻より後に開始し、window全体でproduction aliasが
同じprovider deploymentを指したcontinuous probeをbundleへ含める。同じsourceのstandard/
containmentを切り替えた前後のsampleを一つのwindowへ混在させない。

evidence stage は次の意味で統一する。

| stage                        | 用途                                            | production acceptance |
| ---------------------------- | ----------------------------------------------- | --------------------- |
| `pre-promotion`              | package、QA、DB、policy、二役分の承認（兼任可） | 不可                  |
| `post-assignment-validation` | production alias 後の body/route/env 再検証     | 不可                  |
| `incident-activation`        | rollback/containment の即時安全証跡             | 不可                  |
| `acceptance-final`           | fresh v1、24h、三役分の承認（兼任可）、terminal | standardのみ可        |

### 6.6 PWA recovery と natural activation

Phase 1 以降の `index.html` は classic `/theme-prepaint.js` の後に、一つの module entry
`outerRecoveryAgent` だけを読み込む。outer agent は App、IndexedDB、XLSX、domain module を
静的 import しない。

outer agent の resolved local import は
`src/pwa/recovery/**` と exact `src/pwa/releaseIdentityProtocol.ts` だけを許可する。同じ
closure verifier を standard/containment/build test で共有し、dynamic non-literal import、
barrel 経由の逸脱、Node built-in、network import を拒否する。

`src/pwa/releaseIdentityProtocol.ts` は`MessageChannel` protocol v1の唯一の正本とする。
requestは`type: "GET_RELEASE_IDENTITY"`、UUID request ID、protocol versionを持つ。responseは
同じrequest ID、worker state、script URL、versioned identity URL、canonical identity
bytes、またはclosed error codeを持つ。active controllerと`registration.waiting`の両方へ
directに送信でき、2,000 msでtimeoutする。Workerはprecacheしたversioned identity bytesを
返すだけで、自身のbinary hashを主張しない。duplicate/late/wrong-ID responseを拒否する。

起動手順:

1. HTML build meta と `import.meta.url` を読み、outer agent 自身の expected path を固定する。
2. controller がある場合は active Worker identity と、その Worker が precache した
   versioned identity を取得する。controller identity、HTML meta、current outer agentが
   exact一致すれば、offlineでもcurrent roleを起動できる。
3. controller がない初回 install は same-origin stable/versioned identity を network から
   取得し、schema、HTML meta、source/build、variant/role が一致する場合だけ進める。
4. role entry URL は identity に宣言された content-hashed same-origin path だけを許可する。
   pre-promotion verifier がその response hash と manifest membership を保証する。
5. controllerがある場合のnetwork stable identityはcurrent起動の一致条件にせず、同じ
   identityならno-update、新しいeligible identityならupdate discoveryとして扱う。malformed/
   ineligible responseはcurrent verified roleを維持して更新案内だけをfail-closedにする。
6. required identity、controller response が timeout/mismatch、または controller のない初回
   install が offline なら App を import せず recovery root を表示する。
7. verified standard は App を、verified containment は read-only recovery/更新 discovery
   entry を import する。

Service Worker は `injectManifest` へ移行し、`skipWaiting()` と `clientsClaim` を使わない。
waiting Worker が見つかったら identity を取得し、現在開いている全 client の blocker
snapshot を表示する。user action は save/flush 後に「全 tab/PWA window を閉じる」案内を
出すだけで、Worker を強制 activate しない。

waiting identity failure は更新案内と role import を止めるが、全 controlled client が
閉じた後の browser natural activation を止められない。次回起動時に active Worker が
identity と一致しなければ recovery root から `registration.update()` と eligible
containment discovery を続ける。cache deletion、hard reload、data mutation は行わない。

standard/containment は同じ outer agent bytes を使うが、role entry と Service Worker graph
は独立させる。containment graph は App、persistence write、XLSX、list renderer を import
せず、diagnostic export、update discovery、operator instruction だけを提供する。

PWA update path から `navigator.locks`、`persistenceCleanupCoordinator`、legacy cleanup task
への edge を禁止する。destructive cleanup 用 Web Locks contract は Release A hard-off と
production call path 0 のまま保持する。

### 6.7 Local CSS と CSP

Phase 2A で Tailwind 3/PostCSS pipeline を導入し、CDN、inline config、inline prepaintを
削除する。theme prepaint は external classic `/theme-prepaint.js` にし、localStorage の
theme key以外を読まず、DOM write は `documentElement` の theme attribute/class に限定する。

`config/csp-policy.json` を report-only/enforced header の唯一の正本にし、nonce/hashを
build 後に手編集しない。Phase 4 の最低 header は次とする。

`api/csp-report.mjs`はPOSTだけを受け、`application/csp-report`または
`application/reports+json`、raw/normalized 16,384 bytes、batch最大20件を検証する。raw
document/source/blocked URL、line/column、sample、user agentを保存せず、effective directive、
disposition、blocked targetを`self`/scheme/same-site/cross-site/unknownへ分類したclosed
record、server-side sourceSha/providerDeploymentIdだけをdedicated DBへinsertする。validは
`204`、method/type/invalid/oversize/config/upstream failureはそれぞれ
`405`/`415`/`400`/`413`/`503`/`502`、全responseは`Cache-Control: no-store`とする。WAFは
route/method/rateを制限する。

Phase 0D hardening migrationはinsert-only `csp_violation_reports`、bounded aggregate
function、7日retentionをdormant provisionし、そのschema/privilegeを
`requiredDbCompatibility`へ含める。operator/evidenceはsanitized aggregateだけを読む。
Phase 2BはDB contractを変更せず、API credential/route、WAF、Report-Only headerだけを
有効化する。Phase 2B/4のbrowser testはDOMの`securitypolicyviolation` captureとdeployed
report sink aggregateを同じscenario IDで照合する。

```text
Content-Security-Policy:
  default-src 'self';
  base-uri 'self';
  object-src 'none';
  frame-ancestors 'none';
  script-src 'self';
  worker-src 'self';
  style-src-elem 'self';
  style-src-attr 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self';
  manifest-src 'self';
  form-action 'self';
  report-uri /api/csp-report
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy:
  accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(),
  microphone=(), payment=(), usb=()
```

`style-src-attr 'unsafe-inline'` は React inline style migration の temporary exception とし、
owner を UI、removal gate を P8、expiry を P8 production acceptance に固定する。Phase 8
で reachable production JSX の inline style 0 を確認し、`style-src-attr 'none'` へ変更する。
`unsafe-inline` を `script-src` または `style-src-elem` に許可しない。

HSTS は provider/domain policy の owner とし、application header と重複設定しない。
subdomain ownership を証明せず `includeSubDomains` を追加しない。obsolete
`X-XSS-Protection` は削除する。

### 6.8 XLSX execution port

UI/domain は `XlsxExecutionPort` だけに依存する。

```ts
type XlsxImportRequest =
  | { kind: "event-import"; input: ArrayBuffer }
  | { kind: "map-preview"; input: ArrayBuffer }
  | { kind: "map-import"; input: ArrayBuffer };

type XlsxImportResult =
  | { kind: "event-import"; value: EventImportResult }
  | { kind: "map-preview"; value: MapPreviewResult }
  | { kind: "map-import"; value: MapImportResult };

interface XlsxExecutionPort {
  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
  ): Promise<XlsxImportResult>;
  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
```

worker protocol は request ID、schema version、request/resultのclosed `kind`、transferable
input、progress、cancel、single terminal result を持つ。responseのrequest IDと`kind`が
requestにexact一致しない場合はcommit前に拒否する。cancel/error 時に partial domain state、
partial file、download side effect を commit しない。main-thread adapterはsemantic parity用の
nonproduction QA standard/test harnessだけで使う。production standardはWorker非対応時に
unsupported-browser errorでfail closedし、runtime exceptionでsilent fallbackしない。
recovery-only containmentはport、Worker、main-thread adapterのいずれもimportしない。

Phase 3 の移行対象には少なくとも次を含む。

- `src/App.tsx`
- `src/features/events/exportFlow.ts`
- `src/features/events/fileImport.ts`
- `src/xlsx/engine/eventWorkbookEngine.ts`
- `src/xlsx/engine/mapWorkbookEngine.ts`
- `src/utils/persistenceRecoveryExport.ts`のdownload side effectだけ
- `src/components/map/MapImportDialog.tsx`
- `src/components/FocusMode.tsx`
- `src/components/FocusModeMapCanvas.tsx`
- `src/components/map/MapCanvas.tsx`
- `src/components/map/MapView.tsx`
- `src/components/map/MapVisitListPanel.tsx`
- `src/components/map/VisitListPanel.tsx`
- `src/utils/hallGrouping.ts`

pure item-number、sheet name、file name、export snapshot、download helper を先に domain module
へ移し、UI graph から `xlsx`/`exceljs` direct import を 0 にしてから Worker を有効化する。
`persistenceRecoveryExport.ts`はstrict JSON recovery bundleのserializer/schema/file name/
failure semanticsを維持し、XLSX/Worker protocolへ移さない。Blob download dependencyだけを
pure download helperへ差し替える。

`config/xlsx-limits.json` は compressed bytes、entry count、per-entry bytes、total inflated
bytes、XML nodes/text、worksheet/row/cell/shared-string/style 数、ratio、wall/CPU time、
progress interval を exact に固定する。ZIP path traversal、encrypted entry、external
relationship、DTD/entity、duplicate/case collision、oversize を parse 前に拒否する。
preflight/digest algorithm は `docs/adr/xlsx-resource-limits.md` で固定する。

本計画の完成形はwhole-buffer Workerとする。実測budgetを満たせない場合は`P3-XLSX`を
不合格にしてproductionへ進めず、streaming parser、追加dependency、別dimension、
rollback/acceptanceを定義する別のversioned planを先に作る。

### 6.9 Typed navigation、shopping list、App

`ScreenState` を discriminated union にし、navigation command が唯一の遷移入口になる。
legacy string/boolean state は adapter の内側に閉じ、invalid combination を型と reducer
test で排除する。

shopping list は次へ分割する。

- controller: command、selection、focus、scroll request
- `buildListRows`: canonical read model
- full renderer: 現行 DOM/keyboard/drag behavior
- virtual renderer: eligible state のみ
- renderer selector: policy、preference、runtime eligibility

virtual eligibility は一列、supported zoom、drag なし、recovery/modal なし、stable row
height、a11y focus restoration が成立する場合だけ true にする。不明状態は full に倒す。
full/virtual は同じ row model、command、accessible name、test fixture を使う。

Phase 5D は dual engine を導入するが default は full である。この package は Phase 5E で
初めて追加される preference key を知らず、未知 key を無視して full を使う。Phase 5E は
`ListRendererPreferencePort` と versioned local preference を追加し、eligible state の
default を `auto` にする。full固定variantはnonproduction QA standard/test harnessだけに
限定する。recovery-only containmentはlist model/controller/renderer/preference portを
importせず、full/virtualのどちらも選択しない。

Phase 6 は `App.tsx` を shell、state/reducer、commands、overlay、composition root へ分ける。
App command は `PersistenceCommandPort` に依存し、IndexedDB detail は legacy adapter の
内側に留める。source-text assertion を architecture test の代用にしない。

### 6.10 IndexedDB facade と recovery semantics

`src/utils/indexedDB.ts` の public export と observable result を compatibility facade として
維持し、内側を次へ分割する。

- `db/constants.ts`、`db/openDatabase.ts`、`db/transactionCoordinator.ts`
- event/map/settings/syncQueue/control repository
- `migration/legacyMigration.ts`
- `recovery/checkpoint.ts`、`recovery/recoveryAdoption.ts`
- `adapters/indexedDbPersistenceCommandAdapter.ts`
- `facade/indexedDbPersistence.ts`

Phase 7 は配置と依存方向の変更であり、次を再設計しない。

1. migration journal の version、raw source digest、archive、phase、key 単位 cleanup state
   を保持し、推測した normalized value で historical digest を置換しない。
2. v1 map normalization repair は map payload、metadata、repair checkpoint を同じ
   transaction で commit する。
3. invalid、prototype-bearing、unknown-key、欠損 field の legacy map は fail-closed とし、
   raw physical record と recovery export evidence を保持する。
4. missing/malformed/replaced archive を自動削除しない。
5. conflict resolution は expected raw digest、selected root、committed root、adoption archive
   を束縛し、複数 candidate、unknown parent、branch、同 revision 不一致を自動選択しない。
6. exact `syncQueue/data` だけを queue payload とする。generic legacy `syncQueue` を推測 merge、
   送信、明示採用しない。standalone legacy `syncQueue`はraw archive/recovery export専用で、
   migration、cleanup、deleteの対象にしない。
7. unknown internal/future record は key-first schema guard を通し opaque に保持する。
8. metrics、notification、recovery export failure は payload/checkpoint transaction の成否を
   変更しない。
9. Release A hard-off、cleanup production call path 0 を分割前後で一致させる。
10. 一つでもapplication storeがrecovery-requiredなら、全storeのhydrateとautosaveを停止し、
    candidate bundleとraw evidenceを保持する。安全なstoreだけを部分起動しない。
11. explicit recovery adoptionはlive stateを再読込してCASを再検証し、archive、selected
    payload、metadata、checkpoint、必要なconflict resolutionを同一transactionでcommitする。
    legacy原本と未選択candidateを保持する。
12. atomic restoreは既存10 application storeだけを対象にし、物理`syncQueue` storeとlegacy
    sourceを変更しない。途中の`DataCloneError`を含む任意のfailureで全writeをrollbackする。
13. IDB `syncQueue`ではexact `data`だけをqueue payload、その他のknown keyをcontrol recordと
    する。restoreはstore全体を不変更にし、syncQueue-only journalのrollback-compatible v2
    wire shapeを維持する。

`mapRepository` は `src/utils/mapDataPersistence.ts` の strict validator を再利用し、
validator を複製しない。legacy migration、checkpoint、recovery adoption、queue/control の
owner を別 module にし、cross-repository write は transaction coordinator だけが行う。

## 7. 品質、security、performance

### 7.1 CI command

protected quality workflow は少なくとも次を独立 step で実行する。

```text
npm ci
npm run test:encoding
npm run typecheck
npm run lint
npm run test:run
npm run test:coverage
npm run test:worker
npm run test:browser
npm run test:a11y
npm run test:release-a-browser
npm run test:release-a-rollback
npm run test:release-a-evidence
npm run verify:architecture
npm run verify:test-project-membership
npm run verify:artifact
npm audit
npm audit --omit=dev
```

`test:release-a-rollback`はPowerShell 7と同一browser profileを使うdedicated Windows runnerで
実行し、他jobからartifact/profileを再利用しない。

test project membership は一つの test file がちょうど一 project に属することを
`config/test-project-membership.json` で検証する。worker/node/browser/jsdom の environment
を暗黙の filename convention だけに任せない。

### 7.2 Lint、coverage、architecture

- ESLint flat config へ移行し、generated/vendor/archive を explicit ignore にする。
- Phase 0A の 130 warnings を file/rule/hash 付き baseline にし、新規 warning を拒否する。
- waiver は owner、reason、expiry、reachability、mitigation を持つ。
- coverage は global だけでなく PWA recovery、artifact/reducer、XLSX protocol、list model、
  persistence transaction の changed-line/branch floor を持つ。
- `config/architecture-policy.json` は layer、allowed edge、forbidden runtime、entry graph、
  public facade、current exception/expiry を正本にする。
- `src/lib/supabase.ts` は importer 0 を graph test で固定する。削除する場合は同じ phase で
  `@supabase/supabase-js` と file を atomic に削除する。
- App source text を読む四つの contract test は、同じ behavior/architecture assertionへ
  置換してから Phase 8 で削除する。

### 7.3 Security

- reachability-aware audit を production/worker/build/release-tool graph に分ける。
- mitigation のない reachable production critical/high は release を止める。
- release tool dependency も protected credential を扱うため production 同等に審査する。
- public build env allowlist 外の名前、secret pattern、absolute path、username、workspace path
  が artifact bytes にないことを scan する。
- provider policy、route table、CSP、WAF、environment presence、DB privilege を deployment
  evidence に含める。

### 7.4 Performance scenario

`config/ui-scenarios.json` が browser/visual/a11y/performance の canonical scenario ID、
fixture hash、`introducedAtGate`、`requiredFromExit` を持つ。
`config/performance-budgets.json` は machine profile、browser version、sample count、
measurement source、median/p95、absolute ceiling、regression ceiling を持つ。

- Phase 0: cold/warm startup、現行 full list、benign main-thread XLSX、現行 IndexedDB
- Phase 3: Worker import/export、corrupt/oversize/ZIP bomb rejection、cancel
- Phase 5: full/virtual renderer、scroll/focus/drag eligibility

未実装 scenario を Phase 0 baseline gate に含めない。各導入 phase で 30 samples を採取し、
non-null absolute ceiling と regression ceiling を policy に commit してから production
candidate を作る。

### 7.5 Runbook、policy、ADR

- `docs/web-foundation-release-runbook.md` は environment binding、prebuilt deploy、promotion、
  rollback、package redeploy、Release State reconciliation、credential rotation、DB
  forward-only repair、retention、PWA recovery を扱う。
- `docs/persistence-recovery-runbook.md` と
  `docs/Resilient Persistence & Safe Migration Plan.md` は Release A/cleanup/persistence
  contract の正本として、Phase 1/7 の変更と同時に更新する。
- `docs/adr/README.md` は ADR format/index を定める。ADR は current accepted decision、
  owner、scope、failure mode、review trigger、supersedes relation を持ち、進捗記録にしない。
- command、policy field、rollback floor、provider/DB operation が変わる PR は README、
  runbook、machine policy、verifier を同じ PR で更新する。

## 8. 実装 phase

共通 production 手順は §9.2 を一度だけ正本とする。phase 本文のstandard「受理」はすべて、
source change の production 配布、fresh v1、24 時間 observation、三役分の承認（兼任可）、
`release-accepted` を含む。tool/document/test-only change を配布しない場合は observation を
要求しない。

### Phase 0A: Baseline と外部 binding

実装:

- worktree、encoding/BOM/EOL、Node/npm、lockfile、command、test/lint/audit、artifact size、
  module graph、provider/DB 現状を再採取する。
- `config/foundation-baseline.json` に `implementationTreeBaselineSha`、
  `measurementSourceSha`、build input closure hash、lockfile/tool hash、command evidence hash
  を別 field で保存する。
- provider production deployment/source/project/domain/environment を read-only で観測する。
  Git branch 名だけから production/rollback binding を推測しない。
- 初回promotionのmandatory recovery package用にP0A policyの`bootstrapSourceSha`を一件固定する。
  actual provider sourceまたはclean main-line commitからRelease A build、capability、
  smoke、raw dist hashを再現できることを必須にする。証跡がなければ`P0-BASELINE`/
  `P0-PROMOTE`を停止し、managed recovery先なしにaliasを変えない。
- protected PostgreSQL control DB、namespace、credential、backup/restore owner を provision
  する。
- provider、release state、DB、scenario、architecture、encoding policy の skeleton を作る。
  gate 時点で unresolved placeholder を許可しない。

exit `P0-BASELINE`:

- baseline file と evidence object の hash が clean checkout から再現する。
- target file の UTF-8 BOMなし、LF、U+FFFDなし、代表日本語が確認される。
- external project/deployment/DB binding の unknown が列挙され、promotion blocker になる。
- verified P0A `bootstrapSourceSha`、raw-dist manifest、recovery rehearsal evidenceが
  固定される。

### Phase 0B: Toolchain、dependency、quality graph

実装:

- §6.1で導入gateが0Bのclusterだけをatomicに導入し、lockfileを再生成する。
- `build`/`build:release-a` の recursion を除く一方向 graph にする。
- Vite env allowlist、ESLint flat config、Vitest project、coverage、architecture、
  test-membership verifier を導入する。
- Playwrightへ統一し、到達不能になった `ws` を削除する。
- all top-level exact pin、engine/peer、dual package、Node/provider family を検証する。

exit `P0-TOOLCHAIN`:

- current 1,198 test behavior と Release A build verifier が通る。
- lint error 0、warning は baseline を超えない。
- direct dependency、test membership、architecture exception の unknown が 0。
- audit waiver のない reachable critical/high が 0。

### Phase 0C: Artifact、provider、Release State

実装:

- §6.2/6.3/6.5 の schema、builder、deterministic archive、provider evidence、Postgres store、
  reducer、reconcile、approval resolver を実装する。
- protected environment/OIDC receiptのvalid、wrong repo/workflow/environment、unmapped reviewer、
  duplicate role/role-bound approval ID、receipt tamper fixtureを検証する。同一provider reviewerが
  distinct teamの各roleを兼任するfixtureはvalidとして検証する。
- `release-a-evidence/v1`は同じ実在loginをbaseline selector/reviewer、全installed PWA
  executor/reviewer、historical auditor/reviewer、三つのapproverへ設定したfixtureをvalidとして検証する。
- `api/not-found.mjs` と exact `/api`/unknown `/api/**` route を導入する。
- `config/provider-policy.json`、
  `contracts/persistence-release-a-startup-bursts-v1.json`、
  `config/ui-scenarios.json`、release runbook、ADR indexを確定する。
- provider policy drift verifierを実装し、domain auto-assignment、production branchのGit
  auto-deploy、owned production domain set、WAF、log retentionのbefore/after receiptを
  fixtureで検証する。
- archiveからbuildなしで新deployment/bindingを作るpackage redeploy、全domain assignment、
  matching companionのreuse/redeploy、standard pairのatomic acceptance transfer、
  containment非acceptance、previous/emergency recovery分岐のstate transitionをdisposable
  namespace/provider fixtureで検証する。
- standard/containment を同一 source/toolchain から二回 build し、reproducibility と
  projection を検証する。
- P0 bootstrap path は raw `dist/**` を byte-for-byte 維持し、fixed metrics-disabled
  adapter と API 404 を static tree 外の staging inputとして加え、pinned Vercel CLI に
  prebuilt output を生成させる。release identity/meta/capability/sw.js を後処理しない。
- Phase 0C では bootstrap builder と fixture package までを検証し、production activation
  は行わない。Phase 0D の final DB contract activation 後に、その fingerprint を明示した
  package を再生成して初めて temporary activation を許可する。

bootstrap state:

- `temporary-containment-activated` は`containmentIncident.kind=legacy-bootstrap`、
  active binding、`standardRecovery`、6時間のrecovery deadlineを記録するが、
  `acceptedStandard`、`acceptedStandardFloors`を更新しない。
- bootstrap は `release-accepted` の対象外で、v1 metrics を満たしたと表現しない。
- expiryでaliasを自動変更せずblocking incidentを継続する。source-hardened standard
  recoveryが完了するまでfeature phaseを進めない。

exit `P0-ARTIFACT`:

- archive 二回生成、extract、manifest/index/schema、capability/identity、DB/policy hash が
  exact 一致する。
- standard/containment の capability v1 bytes が同じで、variant identity URL/hash は異なる。
- raw bootstrap static path/hash set が元 `dist/**` と一致し、新 identity file がない。
- provider prebuilt route table と immutable preview probe が expected response を返す。
- disposable Release State namespace で CAS、idempotency、credential denial、immutable
  evidence、multi-domain assignment、package-redeploy/reconcile drill が通る。production
  namespace はまだ初期化しない。

### Phase 0D: Metrics/DB hardening と evidence bundle

実装:

- generic credential fallback を削除し、§6.4 の handler contract と timeout を実装する。
- Release A client event/request/mapping characterization contractを追加し、recorder/backend/
  API/SQLのexhaustive drift testを通す。
- forward-only hardening/retention migration を disposable DB で検証して productionへ適用する。
- CSP sanitized report table、bounded aggregate/retention functionを同じmigrationでdormant
  provisionし、Phase 2Bまではroute/credential edgeが0であることを検証する。
- `config/db-compatibility-contract.json` と fingerprint を remote observation から確定する。
- tracked migrationでpasswordlessな固定LOGIN observer/source-reader/restore-readerを作り、membershipと
  object ownershipを与えない。observerはbounded application-data authorityとして、migration historyの
  exact `SELECT`と定義hashを固定した3 read functionだけを許可する。stock Supabaseのmanaged platform schemaが
  `PUBLIC`へ与えるrelation/column/sequence/routine権限は、application data proofの外側にあるexact
  object/privilege matrixをconfigへ固定し、observerへのdirect ACL 0件、grant option 0件、unknown object 0件、
  baseline drift 0件を検証する。Supabase管理ACLをmigrationで一括変更しない。backup readerはcore PostgreSQL
  SHA-256 integrity functionだけを実行でき、各passwordは外部で別々に設定する。
- backup rehearsalはDashboardの**Restore to a New Project**で作った別nonproduction projectを使う。
  documented APIにclone provenanceがない限界を明示し、sourceへのin-place PITRを禁止する。exact ref、同一
  `organization_slug`/region、name prefix、recovery point以後のfresh creation、Management API
  `database.host`とdirect DB URL（port `5432` / database `postgres`）の一致、source/restoreのdistinct endpoint・
  credential・cryptographic DB equalityを検証した後、明示cleanup承認に基づきrestore projectをDELETEして
  immutable identityを再確認しながら404まで待つ。
- final DB contractを明示したmandatory bootstrap packageを再生成し、immutable deploymentへ
  deploy/probeして`bootstrapRecovery` bindingを確定する。
- migration後のremote fingerprintとunmanaged production observationを再検証し、final
  contractを`currentDbCompatibility`、現行deploymentをeligibilityのない
  `legacyObservedProduction`、直前に確定したbindingを`bootstrapRecovery`として、一つの
  `state-initialized` payloadへ含める。
- existing v1 verifier を変更せず、bundle wrapper/resolver/fault fixture を追加する。
- startup burst contractから WAF/rate-limit 数値を確定し、false positive/negativeを試験する。
- DB cronとscheduled retention verifier/alertを実装し、2時間超のstale last-successを
  blocking failureにする。

exit `P0-DATA`:

- generic environment/credential/read privilege が production から除去される。
- `currentDbCompatibility`、final contract、使用可能な`bootstrapRecovery` bindingの
  DB URI/fingerprintがexact一致する。
- retention dry-run、bounded delete、alert、backup/PITR owner、別project restore integrity、exact cleanup が
  証跡化される。
- existing v1 valid/invalid fixture と追加 bundle tamper fixture が通る。
- production namespace が final DB contract と unmanaged production observation に結び付いて
  初期化され、accepted/active managed bindingはまだnull、`bootstrapRecovery`はnon-nullで
  immutable deployment probe済みである。
- CSP DB objectはfinal fingerprintに含まれるが、`/api/csp-report`はJSON 404でcredential
  edgeが0である。

### Phase 0E: Source-hardened initial release

実装:

- current active policy/DB contractから standard と source-hardened containment companion を
  buildし、それぞれ別のimmutable deployment URLで全gateを通す。
- `bootstrapRecovery`をemergency recoveryとして束縛した二役分の承認（兼任可）後にstandardだけを
  production aliasへpromoteし、post-assignment validationを行う。
- fresh exact-source v1 observationを開始する。
- 24時間以上、minimum sample、三役分の承認（同一provider reviewerによる兼任可）、terminal bundle 後に standardを受理する。
- bootstrapがactiveならsource-hardened standardへrecoveryし、`containmentIncident`/
  `standardRecovery`をclearする。

exit `P0-PROMOTE`:

- assigned production body/deployment/package/policy/DB bindingが prepared operationと一致する。
- prepared operationにverified source-hardened companionとmandatory
  `bootstrapRecovery`が束縛され、alias変更後の合法な復旧先が存在する。

exit `P0-RELEASE`:

- accepted standard、active production、companion、floor、inventoryがexact一致し、pending/
  containment/recovery state、`legacyObservedProduction`がnullである。
- `bootstrapRecovery`はverified/non-nullのままP1まで保持される。
- source-hardened containment companionがdeploy/recovery drill済みである。

rollback:

- pre-promotionはaliasを変えずabortする。
- post-promotion/pre-acceptanceの初回releaseはprepared
  `bootstrapRecovery`を`temporary-containment-activated`でactiveにする。
- bootstrapをaccepted扱いにせずsource-hardened standard recoveryを継続する。

### Phase 1: Prompt-close-all PWA

dimension delta:

```text
pwaLifecycle: legacy-auto-update-v1 -> prompt-close-all-v1
```

実装は二段階にする。

1. dormant preparation commitで outer agent、protocol、role graph、custom SW、builder、
   contract/fault testを追加する。active P0 policyとlegacy build behaviorは変えない。
2. clean preparation commitからagentを二回buildしhashを確定する。QA/fault drill済みの
   proposed policyと非production QA packageを作る。outer agentはpolicy bytesをimport/
   embedせず、activation commitのpolicy/index変更でagent bytesが変わらないことを検証する。
3. P0 bindingを明示的なcompatible predecessorとして残すactivation commitで
   policy/index/Vite/HTML/SWをatomicに切り替え、承認後に外部`policy-activated` eventを
   appendする。
4. policy activation後のclean checkoutから初めてcanonical production candidateをbuildし、
   active policy hashとの一致を確認して共通production手順へ進む。

test:

- first install、updatefound、waiting、offline、timeout、identity mismatch
- two/many clients、installed PWA、save blocker、closed/unresponsive client
- all clients close後のnatural activation、次回起動のactive Worker mismatch/recovery root
- standard/containment独立graph、outer import closure、no `skipWaiting`/Web Locks cleanup edge
- stable identityのprecache除外、versioned identity `revision:null`、asset→SW→identity build順、
  MessageChannel ID/timeout/late response、provider-owned SW hash
- Release A hard-off、legacy physical delete 0、cleanup coordinator production call 0
- 同一origin/browser profileのforward→rollback→forwardを全client close/reopenで行い、実
  controller/source、offline versioned capability、checkpoint/journal/archive読取、
  rollback版autosave+reload、legacy raw hash不変/delete 0を確認する。

exit `P1-PWA`:

- accepted standardとverified companionの`pwaLifecycle`が`prompt-close-all-v1`で、
  pending stateがnull。
- companionのXLSX/list三dimensionが`disabled`で、App/persistence write/XLSX/list graph edgeが
  0である。
- independent companionのrecovery drill後に`bootstrapRecovery`をnullへ遷移し、legacy
  auto-update bootstrapをeligibilityから除去する。
- legacy PWA predecessorをcurrent rollback eligibilityから除去するpolicy eventが確定する。

rollback:

- Phase 1受理前はP0 packageへ戻せる。
- Phase 1受理後はlegacy-auto-update packageへ戻さず、prompt-close-all containmentを使う。

### Phase 2A: Local Tailwind

dimension delta:

```text
cssDelivery: cdn -> local
```

実装:

- Tailwind 3/PostCSS、local CSS entry、external theme prepaintを追加する。
- CDN、inline config、inline script、runtime Tailwind cacheを削除する。
- offline、visual、theme flash、print、responsive、PWA installを比較する。

exit `P2A-LOCAL`:

- production request graphのTailwind CDN/remote font/runtime CSS writeが0。
- accepted standardとverified companionの`cssDelivery=local`、pending stateがnull。

受理前は直前のeligible CDN standardへ戻せる。受理後のfloor activation後はlocal CSS/PWA
floorを満たすPhase 2A companionまたはeligible standardだけを使う。

### Phase 2B: CSP report-only

dimension delta:

```text
cspMode: none -> report-only
```

実装:

- CSP source inventoryとreport sinkをprivacy-safeに実装する。
- Phase 0Dでdormant provision済みのsanitized DB mapping/7日retentionは変更せず、
  `api/csp-report.mjs`のcredential/route、WAF/probeを有効化する。
- `config/csp-policy.json`からReport-Only headerを生成する。
- expected browser extension noiseとfirst-party violationを分離する。

exit `P2B-REPORT`:

- canonical scenarioでunexpected first-party script/style/worker/connect violationが0。
- accepted standardとverified companionの`cspMode=report-only`、pending stateがnull。
- Phase 0DのDB fingerprintが不変で、Phase 2Bより前は404だったreport routeだけが
  expected contractへ遷移する。

受理前は直前のeligible CSP-none standardへ戻せる。受理後のfloor activation後はreport-only
floorを満たすcompanionまたはeligible standardだけを使う。

### Phase 3: XLSX port と Worker

dimension delta:

```text
xlsxExecution: main -> worker
```

実装順:

1. pure domain type/helperを移動し、semantic goldenを固定する。
2. portとmain-thread adapterを導入し、全consumerのdirect importを除去する。
3. whole-buffer Worker、transfer、progress、cancel、atomic resultを実装する。
4. ZIP/XML/resource preflightとdigestを実装する。
5. whole-buffer Workerがabsolute/regression budgetを満たすことを確認する。満たさなければ
   phaseを停止し、streamingをこの計画へ暗黙追加しない。

test:

- current valid/corrupt workbook、round trip、formula/external relation、ZIP bomb
- oversize/timeout/cancel/crash/retry、no partial commit/download
- UI heartbeat、memory/latency budget、Worker CSP
- pre-Phase 3 rollback parity用のcompile-time `xlsx-main` QA variant

exit `P3-XLSX`:

- reachable UI graphの`xlsx`/`exceljs` direct importが0。
- accepted standardの`xlsxExecution=worker`、recovery-only companionは`disabled`。
- resource policyとperformance evidenceがsource-boundでpending stateがnull。

受理前は直前のeligible `xlsx-main` accepted standardへ戻せる。受理後のfloor activation後は
XLSX edge 0のrecovery-only companionまたはcurrent policyでeligibleなstandardだけを使い、
runtime silent fallbackを使わない。

### Phase 4: CSP enforcement

dimension delta:

```text
cspMode: report-only -> enforced
```

実装:

- §6.7のenforced headerへ切り替える。
- obsolete headerを削除し、provider-owned HSTSとの重複を検査する。
- normal、offline、PWA update、Worker、blob download、recovery、API errorを試験する。

exit `P4-CSP`:

- `script-src`/`style-src-elem`にbroad inline/eval exceptionがない。
- accepted standardとverified companionの`cspMode=enforced`、route/header evidence、
  pending stateが一致する。

受理前は直前のeligible report-only standardへ戻せる。受理後のfloor activation後は
enforced CSPを維持するcompanionまたはeligible standardだけを使う。

### Phase 5: Typed navigation と dual list

Phase 5A〜5Cは5D candidate内のpreparationで、単独production dimensionを作らない。

- 5A: `ScreenState`とnavigation command
- 5B: shared row model/controller/full renderer
- 5C: eligible virtual prototype、a11y/focus/scroll/performance

Phase 5D dimension delta:

```text
listEngine: full -> dual
listDefault: full のまま
```

5Dはfull defaultで受理する。未知の将来preference keyを無視する。

Phase 5E dimension delta:

```text
listDefault: full -> auto
```

5Eで初めてversioned preference port/keyを追加する。eligible=false、unknown、error、
またはnonproduction QAのforce-fullではfullを選ぶ。recovery-only containmentはselectorへ
到達せず、list graph自体を持たない。

test:

- full/virtual semantic parity、keyboard、screen reader、focus restore、scroll anchor
- zoom、one/multi-column、drag、modal、recovery、large list、preference corruption
- force-full nonproduction QA standard、5Eから5Dへのrollback時のunknown key無視

exit `P5-DUAL`:

- accepted standardは`listEngine=dual`,`listDefault=full`、recovery-only companionは
  `listEngine=disabled`,`listDefault=disabled`。

exit `P5-LIST`:

- accepted standardは`listEngine=dual`,`listDefault=auto`、recovery-only companionは
  `listEngine=disabled`,`listDefault=disabled`。
- eligible stateだけがvirtualを使い、pending stateがnull。

5D受理前は直前のeligible full standard、5E受理前はaccepted 5D standardへ戻せる。各
acceptance後のfloor activation後は、そのfloorを満たすeligible standardまたはlist edge 0の
recovery-only companionだけを使う。

### Phase 6: App state と command 分割

dimension delta: なし。

実装:

- shell、typed state/reducer、domain command、overlay、composition rootを分割する。
- persistence writeを`PersistenceCommandPort`へ集約する。
- source-text contract testをbehavior/architecture testへ置換する。

exit `P6-APP`:

- `App.tsx`からIndexedDB/Service Worker/XLSX implementation detailへのdirect edgeが0。
- existing behavior、recovery、autosave、map/list flowが一致する。
- productionへ配布する場合は共通24時間 acceptanceを完了し、pending stateを残さない。

### Phase 7: IndexedDB 分割

dimension delta:

```text
persistenceArchitecture: monolith -> split-facade
```

実装:

- §6.10の順にpure constants/schema guard、open、repository、migration/recovery、
  coordinator、adapter/facadeを抽出する。
- public facade、DB name/version/store/index/keyPath、transaction boundaryを維持する。
- compatibility fixtureを移動・再生成せずそのまま使用する。

必須suite/fixture:

- `src/utils/indexedDB.resilience.integration.test.ts`
- `src/utils/indexedDB.recoveryAdoption.integration.test.ts`
- `src/utils/indexedDB.legacyCleanup.integration.test.tsx`
- `src/utils/indexedDB.atomicRestore.integration.test.tsx`
- `src/utils/indexedDB.mapData.integration.test.tsx`
- `src/utils/indexedDB.versionCompatibility.integration.test.ts`
- `src/hooks/useIndexedDbPersistence.integration.test.tsx`
- `src/utils/persistenceResilience.test.ts`
- `src/utils/persistenceCleanupCoordinator.test.ts`
- `src/utils/persistenceReleaseAMetrics.test.ts`
- `src/utils/persistenceReleaseAMetricsApi.test.ts`
- `src/utils/persistenceReleaseAMetricsBackend.test.ts`
- `src/test/fixtures/d2389a0-orphan-runtime-fallback.json`
- `src/test/fixtures/legacy-journal-v1-no-checkpoint-d2389a0.json`
- `src/test/fixtures/legacy-map-journal-v1-empty-event-d2389a0.json`
- `src/test/fixtures/legacy-map-journal-v1-proto-day-d2389a0.json`

fault injectionはmap payload、metadata、checkpoint、adoption resolutionの各write、
mid-restore `DataCloneError`、transaction abort、再起動repair、remount/reinit、
archive/export failureを含む。

exit `P7-IDB`:

- accepted standardとverified companionの
  `persistenceArchitecture=split-facade`、DB fingerprint exact一致、pending state null。
- raw invalid/conflict evidence、syncQueue semantics、Release A hard-off、cleanup call 0が一致する。

受理前は直前のeligible monolith standardへ戻せる。受理後のfloor activation後は同じ
DB fingerprintとsplit-facade floorを満たすcompanionまたはeligible standardに限定する。

### Phase 8: Debt、temporary bridge、package closure

dimension delta: なし。

safety floor delta:

```text
minimumSafetyFloors.styleSrcAttr: unsafe-inline -> none
```

実装:

- lint warningをowner単位で0にし、baseline/waiverを削除する。
- source-text test、temporary re-export、legacy adapter、unused backup sourceを、importer 0と
  behavior replacementを確認して削除する。
- production JSX inline styleを0にし、`style-src-attr 'none'`へ進める。
- final reachability graphからunused dependency、compatibility package、test-only runtimeを
  削除する。
- architecture/coverage/performance baselineの一時exceptionを削除する。
- Release A capability/verifier、cleanup coordinator/public cleanup delegate、journal/archive/
  version decoder、recovery compatibility fixtureはproduction importer 0やunusedだけを理由に
  削除しない。これらの削除はRelease Bを含む別versioned plan/gateだけで行う。
- candidate前policyは直前accepted packageをcompatible predecessorとして残す。P8 standard
  受理後に`styleSrcAttr=none`をminimum floorへactivateし、unsafe-inline packageを
  rollback/containment eligibilityから除去する。

exit `P8-CLEAN`:

- lint 0 errors/0 warnings、architecture violation 0、expired waiver 0。
- reachable production/package graphにunused direct dependencyとtemporary bridgeがない。
- CSP、Release A、DB、PWA、artifact/evidence gateが再受理され、pending stateがnull。

rollbackは受理前なら直前eligible standard、受理後のfloor activation後は
`style-src-attr 'none'`を満たすP8 companionまたはeligible standardだけを使う。

## 9. Rollout、promotion、containment

### 9.1 Phase dimension matrix

| gate | changed key               | from                    | to                               |
| ---- | ------------------------- | ----------------------- | -------------------------------- |
| P0   | initial object            | なし                    | §4.4 の P0 standard exact values |
| P1   | `pwaLifecycle`            | `legacy-auto-update-v1` | `prompt-close-all-v1`            |
| P2A  | `cssDelivery`             | `cdn`                   | `local`                          |
| P2B  | `cspMode`                 | `none`                  | `report-only`                    |
| P3   | `xlsxExecution`           | `main`                  | `worker`                         |
| P4   | `cspMode`                 | `report-only`           | `enforced`                       |
| P5D  | `listEngine`              | `full`                  | `dual`                           |
| P5E  | `listDefault`             | `full`                  | `auto`                           |
| P6   | なし                      | 直前 object             | 同じ object                      |
| P7   | `persistenceArchitecture` | `monolith`              | `split-facade`                   |
| P8   | なし                      | 直前 object             | 同じ object                      |

P8はbehavior dimensionを変えないが、§8の
`minimumSafetyFloors.styleSrcAttr=none`を別のsafety-floor deltaとして適用する。

P0 legacy containmentはmain/full/full、Phase 1以降のrecovery-only containmentは
`releaseRole=containment`、XLSX/listの三fieldを`disabled`とし、受理済み
PWA/CSS/CSP/DB/persistence safetyを下げない。

### 9.2 Common production procedure

phase が static policy を変える場合は、先に proposed policy と非production QA packageで
schema、monotonicity、predecessor compatibility、rollback/containment drillを完了する。
三役分のapproval（同一provider reviewerによる兼任可）付き`policy-activated` eventの後にだけ、そのhashを持つcanonical production
candidateを作る。受理後にsafety floorを引き上げる別policy activationは、直前packageの
eligibilityを縮小できるが、active/accepted bindingをineligibleのまま残してはならない。

1. clean source、exact tool/lock、active policy、DB contractを取得する。
2. standard/containmentをbuildし、二回再現性、QA、security、resource、routeを検証する。
3. manifest/archive/package indexとpre-deploy QA evidenceをimmutable storeへ保存する。
4. standardとcontainmentを別々に
   `vercel deploy --prebuilt --prod --skip-domain`でimmutable deployment化する。
5. 両immutable URLをprobeし、role別ProviderDeploymentEvidence/DeploymentBindingを生成して
   immutable storeへ保存する。
6. current Release StateをCAS再読取し、eligibility、predecessor policy、emergency
   recovery bindingを再計算する。
7. standard target、companion、emergency recovery、package/provider evidenceをsubjectにした
   二役分のapproval（同一provider reviewerによる兼任可）を解決する。
8. exact deployment IDを持つ`promotion-prepared`をappendする。
9. standardだけを`vercel promote`し、owned production domain set全体のimmutable
   assignment-receipt evidenceを保存して
   `deployment-assigned`をappendする。
10. 全production domainを再probeし、receiptを参照する別のassignment-validation
    evidenceを保存して`assignment-validated`をappendする。
11. fresh exact-source v1 observationを開始し、24時間以上とminimum sampleを満たす。
12. 三役分のapproval（同一provider reviewerによる兼任可）、acceptance-final bundle、current state CASを検証する。
13. standardの`release-accepted`をappendし、accepted/companion/inventory/pendingを
    再検証する。

各 numbered step は idempotency key と immutable input hash を持つ。途中失敗は次 stepへ
進まず、verified abort/rollback/reconcile eventをappendする。

### 9.3 Observation rule

- productionへ配布して受理するstandard source changeは、behavior/zero-dimension refactorを
  問わずfresh v1と24時間以上を要求する。
- static policyはphase固有に24時間より長いwindowを要求できるが、短くできない。
- document/test/toolだけの変更でproduction bytes/provider stateを変えない場合は新規
  observationを要求しない。
- post-assignment validationはacceptanceではない。
- source-hardened/legacy bootstrap containmentはrole帰属不能またはdisabled metricsのため
  acceptance対象外である。

### 9.4 Emergency containment と rollback

通常 containment:

- current accepted standard sourceのsource-hardened companionを第一候補にする。
- P1受理前はP0 companionがapplication/PWA graphを共有するため、shared-source incidentでは
  `bootstrapRecovery`を第一候補にする。P0 companionはincident scopeがshared graphを
  含まないと証明できる場合だけ使う。
- current minimum safety、DB fingerprint、policy projection、provider bindingを再検証する。
- 即時activationはincident evidenceと三roleのうちpolicy指定の緊急approvalを要求する。
- alias変更はstandard promotionと同じassignment-receipt/validation evidenceを保存し、
  append失敗時は`state-reconciled`手順を使う。
- `containment-activated`はprovider aliasと`activeProduction`を更新するが、
  `acceptedStandard`、floor、inventoryは更新しない。
- `containmentIncident.kind=source-hardened`と`standardRecovery`を同時に設定し、最大dwellを
  24時間に固定する。deadline超過でaliasを自動変更せず、blocking incidentを継続する。
- containmentを`release-accepted`にしない。accepted standardへ`rollback-activated`するか、
  新しいstandardを共通手順で受理してincident/recovery stateをclearする。

P0 temporary bootstrap:

- P0A policyで明示した一回限りの`bootstrapSourceSha`とraw dist hashだけを使う。
- alias変更、assignment evidence、reconcileは通常containmentと同じ手順を使う。
- metrics-disabled、legacy public identity、Release A hard-offを持つ既存applicationとして
  activeにできる。raw distを変更しないため、read-only roleや独立containment entryを
  実装済みとはみなさない。
- accepted floor/inventoryを更新せず、最大dwellを6時間に固定する。
- source-hardened standardへ復旧できなければfeature phaseを停止する。

rollback:

- current policyでeligibleなimmutable deployment/packageだけを使う。
- rebuild、branch checkout、backup branch名からの推測rollbackを禁止する。
- DB migrationはforward-onlyとし、旧application packageがcurrent fingerprintを満たさない
  場合はprovider rollbackせずcompatible containmentとDB repairを使う。

package redeploy:

- eligible packageのprovider deploymentが失われた場合だけ、`package-redeploy` actionを使う。
  archive URI/hash、package index、manifestをimmutable storeから取得して再検証し、
  source checkout、dependency install、Vite build、`vercel build`を一切実行しない。
- 検証済みprebuilt outputを
  `vercel deploy --prebuilt --prod --skip-domain`で新しいimmutable deploymentへ送り、全route、
  body、header、environment、DB/policy bindingをprobeして新しい
  ProviderDeploymentEvidence/DeploymentBindingを作る。
- standard redeployはorigin accepted eventに束縛されたmatching companionを必ず解決する。
  companion deploymentを再probeできればそのbindingを再利用し、できなければcompanion
  archiveも同じ手順で再配備する。pairのsource/toolchain/policy/DB/projectionがexact一致
  しない限りaliasを変えない。
- standardはeligible rollback inventory bindingとそのmatching companion、containmentは
  current companionまたは`bootstrapRecovery`をoriginにし、target standard/containmentと
  verified companionを持つ`redeploy-standard`/`redeploy-containment` pending operationを
  二役分のapproval（同一provider reviewerによる兼任可）付き`promotion-prepared` eventでappendする。
- 新deploymentだけをpromoteし、owned production domain set全体のassignment receiptと
  post-assignment validationを別evidence/eventとして保存する。一部domainの成功では進まない。
- final CASで`package-redeploy-activated`をappendする。standardは元accepted event/floorを
  保持したままactive/accepted/companion/inventory bindingをverified pairへ原子的に
  付け替える。containmentはaccepted stateを変えず、通常のincident種別/deadlineを設定する。
- alias変更後の失敗はpending operationを残してread-only再観測し、
  `previousBinding`を再probeできる場合だけそこへのrollbackを許可する。利用不能または
  `originBinding`と同一なら`emergencyRecoveryBinding`をactivateする。観測結果に応じて
  `package-redeploy-activated`、`state-reconciled`、または対応するrollback/containment
  eventをappendし、snapshotを手編集しない。

### 9.5 即時停止条件

- source/build/variant/package/provider/DB/policy hashの不一致
- active policyまたはpredecessor policy bytesを解決できない
- Release A hard-off違反またはlegacy physical deletion
- invalid/unknown persistence recordの上書き・削除
- provider project/domain/environmentの不一致
- unknown `/api`がHTMLを返す、metrics response contract違反
- waiting/active Worker mismatch後のApp/data mutation
- archive非再現、manifest外file、path collision
- v1 evidence、必須approval roleまたはrole-bound approval ID、24時間windowの不足
- Release State CAS/immutable store/reconcileの失敗
- reachable production critical/highにwaiver/mitigationがない
- U+FFFD、意図しないBOM/EOL、代表日本語の破損

## 10. Phase exit matrix

| gate           | 必須入力                                         | exit                           |
| -------------- | ------------------------------------------------ | ------------------------------ |
| `P0-BASELINE`  | clean source、baseline、external binding         | 再現可能な現状とblocker        |
| `P0-TOOLCHAIN` | exact runtime/lock/peer/audit                    | command/quality graph安定      |
| `P0-ARTIFACT`  | package/policy/provider/state drills             | immutable prebuilt release可能 |
| `P0-DATA`      | DB/API/retention/v1 bundle                       | privilegeとevidence安全        |
| `P0-PROMOTE`   | pair candidate、recovery、二役approval（兼任可） | alias後のbinding exact         |
| `P0-RELEASE`   | fresh v1、24h、三役approval（兼任可）            | initial standard受理           |
| `P1-PWA`       | outer agent、multi-client、reopen drill          | prompt-close-all受理           |
| `P2A-LOCAL`    | local CSS、offline/visual                        | CDN/runtime CSS 0              |
| `P2B-REPORT`   | CSP inventory/report                             | first-party violation 0        |
| `P3-XLSX`      | semantic golden、Worker、limits                  | worker standard受理            |
| `P4-CSP`       | enforced header、full flow                       | enforced CSP受理               |
| `P5-DUAL`      | dual/full-default、companion                     | dual engine受理                |
| `P5-LIST`      | preference/eligibility/nonproduction force-full  | auto default受理               |
| `P6-APP`       | typed state/command/port                         | App dependency分離             |
| `P7-IDB`       | facade/repository/recovery suite                 | split-facade受理               |
| `P8-CLEAN`     | warning/style/package closure                    | temporary debt 0               |

## 11. 実装時の正本

### 11.1 Existing source

| path                                                                    | owner / phase                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `package.json`, `package-lock.json`                                     | Build / 0B〜8                                           |
| `vite.config.ts`, `vercel.json`, `index.html`, `src/index.tsx`          | Build/PWA/Release / 0〜4                                |
| `src/App.tsx`, `src/components/ShoppingList.tsx`                        | App/List / 1、3、5、6                                   |
| `src/features/app-shell/**`, `src/features/map/domain/mapImportFlow.ts` | App/Map / 5、6                                          |
| `src/xlsx/engine/**`, `src/xlsx/domain/**`, `src/types/export.ts`       | XLSX / 3                                                |
| §6.8 に列挙した consumer                                                | XLSX/UI / 3                                             |
| `src/utils/indexedDB.ts`, `src/hooks/useIndexedDbPersistence.ts`        | Persistence / 6、7                                      |
| `src/utils/persistenceResilience.ts`                                    | persistence compatibility / 7                           |
| `src/utils/mapDataPersistence.ts`                                       | strict map validation / 7                               |
| `src/utils/persistenceRecoveryExport.ts`                                | recovery JSON evidence / 6、7（3はdownload helperだけ） |
| `src/utils/persistenceReleaseAMetrics.ts`                               | Release A metrics / 0D、7                               |
| `src/utils/persistenceReleaseAMetricsBackend.ts`                        | Release A client transport / 0D、1、7                   |
| `src/utils/persistenceReleaseAMetrics*.test.ts`                         | Release A client contract gate / 0D、1、7               |
| `src/utils/persistenceCleanupCoordinator.ts`                            | dormant cleanup safety / 1、7                           |
| `src/test/fixtures/*.json`, `src/utils/indexedDB.*.integration.test.*`  | compatibility gate / 7                                  |
| `api/persistence-release-a-metrics.mjs`                                 | API/Data Safety / 0D                                    |
| `supabase/migrations/20260803000000_persistence_release_a_metrics.sql`  | immutable DB baseline / 0D                              |
| `scripts/verify-release-a-build.mjs`                                    | Release A hard-off / 0〜1                               |
| `scripts/verify-release-a-browser.mjs`                                  | browser compatibility / 0C                              |
| `scripts/rehearse-release-a-rollback.ps1`                               | same-profile rollback contract / 0C〜8                  |
| `scripts/verify-release-a-evidence.mjs`                                 | v1 shape + single-account verifier / 0D〜8              |
| `docs/release-a-evidence.template.json`                                 | v1 shape template / 0D〜8                               |
| `README.md`                                                             | developer/product contract / 0〜8                       |
| `docs/persistence-recovery-runbook.md`                                  | Release A/cleanup operation / 1、7                      |
| `docs/Resilient Persistence & Safe Migration Plan.md`                   | persistence contract / 1、7                             |

### 11.2 Planned policy、schema、release tool

| path                                                                     | owner / phase                  |
| ------------------------------------------------------------------------ | ------------------------------ |
| `config/foundation-baseline.json`, `config/encoding-policy.json`         | Build/Quality / 0A             |
| `config/toolchain-versions.json`, `config/lint-warning-baseline.json`    | Build/Quality / 0A、0B         |
| `config/architecture-policy.json`, `config/architecture-baseline.json`   | Architecture / 0B〜8           |
| `config/test-project-membership.json`, `config/coverage-policy.json`     | Quality / 0B、0C               |
| `config/ui-scenarios.json`, `config/performance-budgets.json`            | Quality / 0A〜8                |
| `config/audit-waivers.json`                                              | Security / 0B〜8               |
| `config/release-variants.json`, `config/release-state.schema.json`       | Release / 0C〜8                |
| `config/provider-policy.json`, `config/release-state-store.json`         | Release/Operations / 0A〜8     |
| `config/approval-policy.json`                                            | Release/Operations / 0C〜8     |
| `config/db-compatibility-contract.json`                                  | Data Safety / 0D〜8            |
| `config/metrics-retention-policy.json`                                   | Data Safety/Operations / 0D    |
| `config/artifact-archive-policy.json`                                    | Build/Release / 0C             |
| `config/csp-policy.json`, `config/xlsx-limits.json`                      | Security / 2〜4、3             |
| `contracts/artifact-manifest-v1.schema.json`                             | Build/Release / 0C             |
| `contracts/release-package-index-v1.schema.json`                         | Build/Release / 0C             |
| `contracts/provider-deployment-evidence-v1.schema.json`                  | Release / 0C                   |
| `contracts/provider-assignment-evidence-v1.schema.json`                  | Release / 0C                   |
| `contracts/release-identity-v1.schema.json`                              | PWA/Release / 0C〜8            |
| `contracts/release-evidence-bundle-v1.schema.json`                       | Release/Data Safety / 0D       |
| `contracts/bootstrap-input-v1.schema.json`                               | Build/Release / 0C             |
| `contracts/persistence-release-a-metrics-v1.json`                        | Data Safety / 0D、1、7         |
| `contracts/persistence-release-a-startup-bursts-v1.json`                 | Data Safety / 0C               |
| `ops/release-state/migrations/0001_release_state_store.sql`              | Release/Operations / 0C        |
| `scripts/build-release-artifact.mjs`                                     | Build/Release / 0C             |
| `scripts/verify-release-artifact.mjs`                                    | Build/Release / 0C             |
| `scripts/deterministic-zip.mjs`                                          | Build/Release / 0C             |
| `scripts/deterministic-zip.test.mjs`                                     | Build/Release / 0C             |
| `scripts/verify-bootstrap-staging.mjs`                                   | Build/Release / 0C             |
| `scripts/templates/bootstrap-metrics-disabled.mjs`                       | Data Safety / 0C               |
| `scripts/templates/bootstrap-api-not-found.mjs`                          | Release/API / 0C               |
| `scripts/release-state/postgresStore.mjs`                                | Release/Operations / 0C        |
| `scripts/release-state/evidenceStore.mjs`                                | Release/Operations / 0C        |
| `scripts/release-state/approvalResolver.mjs`                             | Release/Operations / 0C〜8     |
| `scripts/verify-release-state.mjs`                                       | Release / 0C                   |
| `scripts/verify-release-a-evidence-bundle.mjs`                           | Release/Data Safety / 0D〜8    |
| `scripts/verify-db-compatibility-contract.mjs`                           | Data Safety / 0D〜8            |
| `scripts/verify-architecture.mjs`                                        | Architecture / 0B〜8           |
| `scripts/verify-test-project-membership.mjs`                             | Quality / 0B〜8                |
| `scripts/provider/verify-provider-policy.mjs`                            | Release/Security / 0C〜8       |
| `scripts/verify-metrics-retention.mjs`                                   | Data Safety/Operations / 0D〜8 |
| `scripts/build-release-vite.mjs`                                         | Build/PWA / 0C〜8              |
| `scripts/build-pwa-recovery-agent.mjs`                                   | Build/PWA / 1〜8               |
| `eslint.config.js`, `playwright.config.ts`                               | Quality / 0B、0C               |
| `api/not-found.mjs`                                                      | Release/API / 0C               |
| `api/csp-report.mjs`                                                     | Security/API / 2B〜8           |
| `supabase/migrations/20260805000000_persistence_release_a_hardening.sql` | Data Safety / 0D               |
| `.github/workflows/quality.yml`, `.github/workflows/release.yml`         | Quality/Release / 0C〜8        |
| `.github/workflows/metrics-retention.yml`                                | Data Safety/Operations / 0D〜8 |

### 11.3 Planned application source

| path group                                                                      | owner / phase      |
| ------------------------------------------------------------------------------- | ------------------ |
| `src/bootstrap.ts`, `src/pwa/recovery/**`, `src/pwa/releaseIdentityProtocol.ts` | PWA/Release / 1    |
| `src/pwa/releaseIdentityProtocol.contract.test.ts`                              | PWA/Quality / 1〜8 |
| `src/pwa/serviceWorkerBootstrap.ts`, `src/pwa/containment/**`, `src/sw.ts`      | PWA/Release / 1    |
| `src/pwa/updateBlockerRegistry.ts`, `tsconfig.worker.json`                      | PWA/Quality / 1    |
| `tailwind.config.cjs`, `postcss.config.cjs`, `public/theme-prepaint.js`         | UI / 2             |
| `src/styles/tailwind.css`, `src/styles/global.css`                              | UI / 2〜8          |
| `src/xlsx/domain/**`, `src/xlsx/port/**`, `src/xlsx/adapters/**`                | XLSX / 3           |
| `src/xlsx/worker/**`, `src/xlsx/security/**`, `src/xlsx/download/**`            | XLSX/Security / 3  |
| `src/features/shopping-list/**`                                                 | List / 5           |
| `src/app/navigation/**`, `src/app/ports/**`, `src/app/composition/**`           | App / 5、6         |
| `src/persistence/db/**`, `src/persistence/repositories/**`                      | Persistence / 7    |
| `src/persistence/migration/**`, `src/persistence/recovery/**`                   | Persistence / 7    |
| `src/persistence/adapters/**`, `src/persistence/facade/**`                      | Persistence / 7    |

### 11.4 Planned documentation

| path                                     | owner / phase              |
| ---------------------------------------- | -------------------------- |
| `docs/web-foundation-release-runbook.md` | Release/Operations / 0C〜8 |
| `docs/adr/README.md`                     | Architecture / 0A          |
| `docs/adr/release-state-store.md`        | Release/Architecture / 0C  |
| `docs/adr/xlsx-resource-limits.md`       | XLSX/Security / 3          |

machine-readable policy/schemaが実装とverifierの入力であり、Markdownへ同じ値を手入力して
別正本を作らない。runbookはoperator commandとfailure recoveryの正本とする。

## 12. 全体完了条件

- `activeProduction===acceptedStandard`で、verified containment companion、
  package/provider assignment/DB/policy chainがexact一致し、pending operation/acceptance、
  `containmentIncident`、`standardRecovery`、`bootstrapRecovery`、
  `legacyObservedProduction`がnullである。
- productionはprompt-close-all PWA、local Tailwind、enforced CSP、Worker XLSX、eligible
  virtual list、typed App command、split IndexedDB facadeを使用する。
- containment companionは同一source/toolchainのindependent role graph、current
  PWA/CSS/CSP/DB/persistence safetyを満たし、App/persistence write/XLSX/listへのedgeが0、
  対応dimensionが`disabled`である。
- capability v1とRelease A hard-offが全variantで維持され、legacy physical deletionが0。
- provider deploy/promotion/rollback/package redeploy/reconcileはimmutable prebuilt
  packageとRelease State eventだけから再実行でき、owned production domain set全体の
  assignment/validation evidenceを持つ。
- every accepted standard sourceはfresh exact-source v1、24時間以上、三役分のapproval
  （同一provider reviewerによる兼任可）、
  acceptance-final bundleを持つ。
- current policyでprovider rollback/package redeployがeligibleな旧accepted standard、
  またはcurrent accepted standardに束縛したverified companionの少なくとも一方があり、
  source rebuildせずrollback/redeploy/containment activationできる。
- IndexedDB schemaと既存data/recovery semanticsが実機を含むcompatibility suiteで一致する。
- lint 0 errors/0 warnings、architecture violation 0、expired waiver 0、test membershipの
  重複/漏れ0、reachable unmitigated critical/high 0である。
- production JSX inline style 0、`style-src-attr 'none'`、unexpected first-party CSP violation
  0である。
- 日本語、UTF-8 BOM、EOLに意図しない変化がない。
