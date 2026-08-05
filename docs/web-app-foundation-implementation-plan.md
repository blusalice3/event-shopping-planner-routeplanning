# Web アプリ基盤 実装計画

照合基準日は 2026-08-05、照合対象の source SHA は
`8178b53a56fcaec8dbe640bad9c721b6ded650e2` とする。本書のパスはすべて repository
root からの相対パスである。

本書は Web アプリ基盤の実装順、責務境界、合格条件を定める正本とする。未実装の
構成は「予定」と明記し、現在の実装と混同しない。各 phase の詳細設計で本書と異なる
判断が必要になった場合は、先に本書と architecture decision record を更新してから
実装する。

## 1. 目的

次の改善を、既存の保存データ、Release A の契約、主要 UI の挙動を維持したまま
段階的に行う。

- build、検証、配布、昇格、rollback を同一 artifact に結び付ける。
- PWA 更新を即時自動適用から、保存後に全 client を閉じて自然に切り替える方式へ
  移行する。
- Tailwind CDN と first-party inline code を撤去し、実効性のある CSP を適用する。
- XLSX 処理を UI thread から分離し、入力上限と cancel を実装する。
- 買い物リストの read model と操作を renderer から分離し、安全な条件から
  virtualization を導入する。
- `App.tsx` と `src/utils/indexedDB.ts` を、既存契約を保持する facade の内側で
  分割する。
- lint、browser test、accessibility、coverage、architecture rule を CI で継続的に
  検査する。

## 2. 対象外

- React 19、Tailwind 4、別の state management library への移行
- 保存 schema の全面再設計、既存 IndexedDB の削除、強制的な client-side migration
- 同期、共有、認証などの新規 product feature
- 任意の tab を開いたまま Service Worker を強制適用する仕組み
- 計測で必要性が確認される前の XLSX streaming protocol
- すべての zoom、複数列、drag 状態を一度に扱う単一 virtual renderer
- Release A evidence v1 の schema または既存 verifier の破壊的変更
- provider の undocumented な Build Output API file を手書きする実装

## 3. 照合済みの実装現状

### 3.1 アプリケーション、build、配信

| 項目                      | 現在の実装                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| runtime                   | Node `20.20.0`、npm `10.8.2`                                                                      |
| app                       | React `18.3.1`、TypeScript `5.9.3`                                                                |
| build                     | Vite `5.4.21`                                                                                     |
| `npm run build`           | `tsc && vite build --mode release-a`                                                              |
| `npm run build:release-a` | `npm run build` の後に `scripts/verify-release-a-build.mjs`                                       |
| provider                  | `vercel.json` に SPA rewrite と security header を定義                                            |
| artifact                  | `dist/` は生成されるが、source、provider deployment、evidence を束ねた immutable package は未実装 |

現在の command graph は `build:release-a` から `build` を呼ぶ。これを逆向きに変更する
場合は、両 script を同一 commit で変更しなければ再帰する。

`vite.config.ts` は `loadEnv` に空 prefix を渡して全 environment 名を読み込む。現時点で
secret を client 定数へ展開してはいないが、canonical build では public build
environment を allowlist し、protected runtime environment を Vite config の入力から
外す必要がある。

`vercel.json` の rewrite は `/api/` 配下を除外するが、正確な `/api` は除外しない。
CSP は未設定であり、obsolete な `X-XSS-Protection: 1; mode=block` が残っている。

現在の workspace で同一 source SHA から生成された主な artifact は次のとおりである。
この値は恒久的な budget ではなく、Phase 0 で toolchain、環境、file hash と一緒に
再採取する。

| 出力                     |                   現在値 |
| ------------------------ | -----------------------: |
| main JavaScript          |            941,325 bytes |
| `xlsx-parser` JavaScript |            974,780 bytes |
| precache                 | 19 entries、3,101.67 KiB |

### 3.2 PWA

- `vite.config.ts` は `vite-plugin-pwa` の `generateSW` を使用する。
- `registerType: "autoUpdate"`、`skipWaiting: true`、`clientsClaim: true` である。
- 生成された `dist/registerSW.js` が native registration を行う。
- `cleanupOutdatedCaches`、navigation fallback、Tailwind CDN の `CacheFirst`、
  Supabase URL の `NetworkOnly` route がある。
- 更新前に未保存状態を確認する共通 blocker registry はない。
- Release A の capability manifest と build ID は source SHA を前提にしている。

### 3.3 HTML、CSS、CSP

- `index.html` は unversioned な `https://cdn.tailwindcss.com` を読み込む。
- Tailwind config、theme prepaint、viewport/load 処理、大きな style block が inline
  である。
- viewport meta は user zoom を制限する。
- production source には JSX `style` prop が 101 箇所あり、CSSOM mutation もある。
  初回 CSP で `style-src-attr` を即座に禁止できる状態ではない。
- `FocusModePanels.tsx` の data URL background と
  `BlockDefinitionPanel.tsx` の persisted color は CSP 導入前に検証または class 化が
  必要である。
- Google Sheets import は browser から `docs.google.com` の CSV endpoint を直接
  `fetch` し、redirect 先を含む実通信 origin の CSP 許可が必要である。
- browser から Supabase を呼ぶ current production path は確認されておらず、
  `src/lib/supabase.ts` は entry graph の参照有無を Phase 0 で確定する必要がある。
- ExcelJS bundle には依存 package 由来の `new Function` と `javascript:` 文字列が
  含まれる。文字列の存在だけで CSP 合否を決めず、到達可能性と browser violation を
  検証する必要がある。

### 3.4 XLSX

- `src/utils/exportImport.ts` と `src/utils/xlsxMapParser.ts` が ExcelJS を static import
  する。
- `App.tsx` は `exportImport.ts` を static import する。
- UI が使う pure helper も `xlsxMapParser.ts` にあり、ExcelJS graph を UI 側へ
  引き込む。
- `src/types/export.ts` と utility 内に重複した export data shape がある。
- map preview には file signature cache と latest-wins の race protection がある。
- `vite.config.ts` は `build.minify: "esbuild"` と object 形式の
  `build.rollupOptions.output.manualChunks` を使用し、後者は現在の XLSX utility path を
  直接参照する。
- export の workbook timestamp、metadata timestamp、filename timestamp は別々に
  取得される。

### 3.5 買い物リスト、App、IndexedDB

| 対象                                   | 現在値と特徴                                                     |
| -------------------------------------- | ---------------------------------------------------------------- |
| `src/App.tsx`                          | 5,844 行。Header、Main、Overlay の shell component は分離済み    |
| `src/components/ShoppingList.tsx`      | 4,414 行。dialog、selection、drag、DOM geometry、renderer が同居 |
| `src/hooks/useIndexedDbPersistence.ts` | 1,050 行                                                         |
| `src/utils/indexedDB.ts`               | 9,176 行                                                         |

- list は window scroll、`getBoundingClientRect`、`elementFromPoint`、native/touch drag に
  依存する。
- app zoom は `transform: scale(...)` で 15% から 150% を扱い、複数 list column も
  ある。
- navigation hook と list navigator が DOM query と scroll を直接行う。
- `ActiveTab` 相当の型が `App.tsx` と `src/features/app-shell/types.ts` に重複し、
  open-ended な `string` を許す。
- map import は event、date、map tab 名を選択するが、map surface の表示状態を同じ
  command で確定しない。
- 一部 integration test は source text を検索して handler の存在を確認している。
- IndexedDB 名は `EventShoppingPlannerDB`、current version は `5`、受理する forward
  version の上限は `7` である。
- `syncQueue` store は queue payload と `__esp_internal__:` control record を物理的に
  併用する。
- atomic restore、map data、resilience、recovery adoption、legacy cleanup、
  version compatibility の integration test が存在する。

### 3.6 Release A metrics、API、DB

- client metrics は best-effort であり、保存成功の条件ではない。
- `api/persistence-release-a-metrics.mjs` は same-origin、JSON content type、request
  schema、declared/normalized 1,024 bytes の上限を検査する。
- raw stream では受信 byte を数えるが、provider が `request.body` を object として
  渡した場合は再 serialize 後の byte 数しか検査できない。
- Supabase の dedicated 環境変数と generic 環境変数を component 単位の nullish
  fallback で混在できる。
- Supabase fetch に timeout、redirect rejection、project ref binding はない。
- 現行 migration は raw table と aggregate view の `SELECT` を `service_role` に
  grant している。
- evidence v1 verifier は exact-key の単一 JSON を検証し、最終 evidence は Release、
  Data Safety、Operations の異なる 3 名の承認を要求する。

### 3.7 再現済み品質基準

| command                   | 結果                                            |
| ------------------------- | ----------------------------------------------- |
| `npm run typecheck`       | 成功                                            |
| `npm run test:encoding`   | 328 files 成功。UTF-8、BOM なし。LF 327、CRLF 1 |
| `npm run lint`            | 0 errors、130 warnings                          |
| `npm run test:run`        | 120 files、1,198 tests 成功                     |
| `npm run build:release-a` | 成功                                            |
| `npm audit`               | critical 1、high 19、moderate 8、low 1          |
| `npm audit --omit=dev`    | high 4、moderate 2                              |

warning の主な内訳は `react-hooks/exhaustive-deps` 83、
`@typescript-eslint/no-unused-vars` 38 である。Phase 0 の baseline はこの source SHA と
紐付け、件数だけではなく stable content ID と location で識別する。

## 4. 用語と identity

| 用語                         | 定義                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sourceSha`                  | app build 対象の Git commit SHA。既存 Release A metrics の `buildId` と同値。別 component は manifest で出所を分離  |
| `variantDimensions`          | static policy schema に適合する sort 済み canonical dimension key/value object                                      |
| `variantId`                  | `variantDimensions` exact object の JCS bytes に対する lowercase SHA-256                                            |
| `artifactManifestHash`       | hash field を持たない `ArtifactManifest` object 全体の canonical JSON に対する SHA-256                              |
| `packageIndexHash`           | hash field を持たない `ReleasePackageIndex` object 全体の canonical JSON に対する SHA-256                           |
| `releaseStateHash`           | 外部 append-only `ReleaseStateEvent` object 全体の canonical JSON に対する SHA-256                                  |
| `releasePolicyHash`          | build 時に使用した `config/release-variants.json` exact object の JCS bytes に対する SHA-256                        |
| `dbCompatibilityFingerprint` | rollback package が満たすべき最小 remote DB contract の canonical hash。physical schema fingerprint とは分ける      |
| `deploymentId`               | provider が同じ prebuilt output に割り当てた immutable deployment identity                                          |
| candidate                    | production project/environment 用に build し、`--skip-domain` で作成した production 昇格対象の deployment           |
| containment companion        | standard と同じ source/safety/accepted floor から作る incident 用 variant。P0 の監査済み baseline だけ cross-source |
| QA deployment                | disposable QA project/alias 上の検証専用 deployment。実 production project/domain へ昇格させず inventory に入れない |
| promotion                    | candidate と同じ `deploymentId` を rebuild せず production domain へ割り当てる操作                                  |
| rollback package             | 検証済み `prebuilt.zip`、`artifact-manifest.json`、`package-index.json` の固定組。incident 中に再 build しない      |
| controlled standalone        | browser automation で standalone 相当の viewport と lifecycle を検証する環境。installed PWA 実機証跡とは区別する    |

本書の canonical JSON は RFC 8785 JCS の UTF-8 bytes とし、独自の key sort/stringify を
実装ごとに作らない。

既存の `event-shopping-planner-build-id` meta と Release A capability の build ID は
`sourceSha` のまま維持する。`variantId` と `pwaLifecycle` は別の meta/capability field に
追加し、既存 field の意味を変更しない。`artifactManifestHash`、`packageIndexHash`、
`deploymentId` は build 後に確定するため HTML へ自己注入せず、外部の
artifact/deployment evidence で束縛する。

## 5. 全体不変条件

1. production に昇格する bytes は、candidate で検証した同一 `deploymentId` の bytes
   である。
2. canonical build は clean checkout、lockfile、exact runtime、明示された public
   build environment だけを入力にする。
3. secret の値、絶対 workspace path、build timestamp を app bundle と
   `artifactManifestHash` の入力にしない。
4. `ArtifactManifest.files` は `prebuilt.zip` の展開内容だけを列挙し、control sidecar を
   含めない。manifest と archive は `ReleasePackageIndex` が両 hash を参照し、その
   `packageIndexHash` を evidence が束縛する。
5. Release A metrics の送信または DB 障害は、local persistence の成功判定、startup、
   cleanup を失敗させない。
6. evidence v1 schema と既存 `verify:release-a-evidence` は凍結する。追加 evidence は
   bundle verifier が横断検証する。
7. IndexedDB の DB 名、store 名、key、version、payload semantics は、明示的な
   migration phase 以外で変更しない。
8. unknown な `syncQueue` internal record は queue として公開せず、削除せず、
   fail-closed で保持する。
9. Phase 1 の `safety-floor-advanced` 以降、PWA 更新は開いている client に
   `SKIP_WAITING` を送らず、全 client が閉じた後の Service Worker natural activation を
   安全境界とする。minimum floor が `legacy-auto-update-v1` の P0 だけは監査済み既存
   lifecycle を許可し、floor 前進後は新規配備、rollback、recovery source として拒否する。
10. PWA 更新の都合で利用者の保存データ、IndexedDB、runtime cache を破壊的に cleanup
    しない。例外は、natural activation 後に Workbox が自身の registration/scope で管理する
    非現行 precache entry/cache だけであり、waiting/active 中や page code から削除しない。
11. full list renderer は permanent fallback として維持する。virtual renderer の
    unsupported state を推測で描画しない。
12. Worker の error、timeout、cancel は app state を部分適用しない。
13. source-contract test は移動前に observable behavior test へ置換する。
14. 既存 warning baseline 外の warning、type error、test failure、encoding error を
    新たに導入しない。
15. 日本語を含む既存 file の UTF-8 BOM、EOL、代表文字列を保存後に検査する。
16. permanent safe adapter は incident 中に再 build しない。P0 は監査済み pre-change
    source から bootstrap baseline を先に build、検証、保存する。Phase 1 以降は各
    production source から standard candidate と同時に same-source containment companion
    を build、検証、保存する。
17. accepted hard floor と rollback eligibility は build artifact または tracked config を
    書き換えて表現しない。外部 append-only release state を進め、以前の state を更新しない。
18. Phase 1 以降の `index.html` は、static policy に hash を固定した同一
    `OuterRecoveryAgent v1` を最初かつ唯一の module script として実行する。agent は
    standard/containment role graph の外で registration、update discovery、identity
    challenge、recovery UI を所有し、role entry の故障中も停止しない。

## 6. 目標 architecture

### 6.1 Build、artifact、provider

予定する package command graph は次に固定する。移行は一つの atomic commit で行う。

```text
pwa:agent:build -- --out <external-empty-directory>
  └─ node scripts/build-pwa-recovery-agent.mjs
       ├─ content-hashed agent asset
       └─ outer-recovery-agent.json

build:_vite
  ├─ tsc
  └─ node scripts/build-release-vite.mjs
       ├─ P0 policy: outerRecoveryAgent=null を検証して vite build
       └─ Phase 1+: agent builder を external temp で実行し、
          descriptor を検証して vite build へ byte input として渡す

build:release-a
  ├─ build:_vite
  └─ verify-release-a-build

build
  └─ build:release-a

artifact:create
  ├─ provider CLI による production-target prebuild
  ├─ artifact manifest 生成
  ├─ deterministic prebuilt archive 生成
  └─ package index と外部 evidence hash 生成

artifact:create --bootstrap-baseline
  ├─ audited checkout の app build
  ├─ bootstrap staging の生成と入力 hash 検証
  ├─ provider CLI による Node 24 production-target prebuild
  └─ 通常経路と同じ manifest/archive/index 生成
```

`scripts/build-pwa-recovery-agent.mjs` は CLI と side-effect-free builder export を同じ実装に
し、`configFile: false`、`envFile: false` の固定 single-entry build を行う。input closure は
builder script、`src/pwa/recovery/outerRecoveryAgent.ts` から recovery directory 内で再帰到達
する local module と exact `src/pwa/releaseIdentityProtocol.ts` の sort 済み path/hash、
Node/Vite/Rolldown の exact version/lock integrity、`target: "es2020"`、minify/output naming
option とする。後者は schema/constants だけを export し、build identity 値を持たない。
`vite.config.ts`、release identity の値、role、variant、`config/release-variants.json`、
ambient environment は closure/input に含めず、他の local module 参照を検出したら停止する。
output directory は source checkout 外の既存 file がない
directory に限り、agent asset と `outer-recovery-agent.json` 以外を拒否する。descriptor は exact
`{ schemaVersion: 1, assetPath, sha256 }` とし、descriptor 自身の `selfSha256` field は
持たない。

`scripts/build-release-vite.mjs` は tracked policy が non-null の場合だけ同じ builder export を
source checkout 外の一時 directory で呼び、descriptor/path/hash を検証して programmatic Vite
build plugin へ in-memory bytes として渡す。plugin はその bytes を exact asset path へ
一度だけ emit し、HTML reference と両 precache manifest に結合する。temporary absolute path、
descriptor file、自動取得した environment は bundle/manifest の入力にしない。standalone
CLI と full build が同じ builder function/options を使うことを contract test で固定する。

`artifact:create` は source checkout 外の一時 directory へ出力する。repository 内で
provider CLI を実行する場合に備えて `.vercel/` と `out/` は `.gitignore` へ追加する
が、canonical archive はこの ignored directory を保管場所にしない。

provider output は exact version を pin した Vercel CLI の `vercel build --prod` で
生成する。custom `.vc-config.json` は手書きしない。protected workflow は
`VERCEL_ORG_ID` と `VERCEL_PROJECT_ID` を使用し、local link file に依存しない。

provider bootstrap は source checkout 外の ephemeral staging directory で行う。

1. exact CLI で `vercel pull --yes --environment=production` 相当を実行し、project
   settings を取得する。
2. 生成された project link/settings から secret を含まない設定だけを sanitized
   `.vercel` input へコピーし、その canonical SHA-256 を `providerSettingsHash` とする。
   hash 対象 field は schema で allowlist し、取得時刻、absolute path、operator identity
   などの非決定値を含めない。
3. pulled environment file から exact allowlist の public build variable だけを別の
   build environment へ渡す。service role key などの runtime secret 値は build process
   へ渡さず、source checkout、artifact、cache、log、evidence にコピーしない。
4. staging 内の pulled secret file は build input から除外し、ephemeral job の終了時に
   job workspace ごと破棄する。
5. build 後 scanner は protected secret の exact value、service-role pattern、
   unexpected environment name を静的 asset と function bundle の両方で検査する。

runtime secret は provider project の production environment が deployment 実行時に
注入する。prebuilt function が secret 値を build-time constant として必要とする構成は
禁止する。

`scripts/build-release-artifact.mjs --bootstrap-baseline` は P0 の一回限りの wrapper
entry とする。wrapper dependency closure はこの entry から再帰到達する全 local module、
`scripts/verify-release-artifact.mjs`、`scripts/verify-bootstrap-staging.mjs`、
`scripts/templates/bootstrap-metrics-disabled.mjs`、
`config/release-state.schema.json` の sort 済み path/hash、Node `24.19.0`、
`canonicalize@3.0.0` の lockfile integrity、Vercel CLI `58.5.1` の executable hash とする。
その closure JSON、source archive、immutable URI、SHA-256 を pre-promotion evidence に
保存する。static policy の `bootstrapWrapperClosureHash` はこの exact closure JSON の JCS
hash と一致させる。`config/release-variants.json` 自身は closure に含めず、自己参照を
作らない。

baseline app build 後、wrapper は source checkout 外の空 directory に次の path だけを作る。
他の file、symlink、dependency directory、ambient config があれば停止する。
`api/persistence-release-a-metrics.mjs` は baseline checkout から copy せず、wrapper closure
に束縛された fixed template を byte-for-byte copy して作る。

```text
dist/**
api/persistence-release-a-metrics.mjs
package.json
package-lock.json
vercel.json
bootstrap-input.json
tools/verify-bootstrap-staging.mjs
.vercel/project.json
```

generated `package.json` は `private: true`、`type: "module"`、
`engines.node: "24.x"`、dependency 0 とし、lockfile も dependency 0 の exact npm 11
lockfile とする。generated `vercel.json` は Phase 0 target の SPA/API rewrite と全 header を
copy し、`framework: null`、`outputDirectory: "dist"`、
`installCommand: "node tools/verify-bootstrap-staging.mjs install"`、
`buildCommand: "node tools/verify-bootstrap-staging.mjs build"` を固定する。
`bootstrap-input.json` は `schemaVersion`、baseline source、`releasePolicyUri`/
`releasePolicyHash`、`bootstrapWrapperClosureHash`、`metricsApiMode:
"bootstrap-disabled-safe-adapter-v1"`、`bootstrapMetricsApiAdapterSha256`、provider project
ID、sort 済み `stagedPayloadFiles` を別 field で束縛する。payload list の対象は
`dist/**`、`api/**`、
`package.json`、`package-lock.json`、`vercel.json`、`tools/**` だけとし、
`bootstrap-input.json` 自身と `.vercel/project.json` を含めない。後者は
`{ orgId, projectId }` だけの canonical projection hash を別 field に記録する。verify script
はこの exact payload set と project projection を再計算するだけで、file を生成、変更しない。
完成した `bootstrap-input.json` 自身の SHA-256 は object 外の pre-promotion evidence に
記録し、self-hash field を持たせない。`.vercel/project.json` は protected `VERCEL_ORG_ID`/
`VERCEL_PROJECT_ID` と pull 結果の allowlisted project ID だけから毎回生成し、token、
environment value、absolute path を含めない。

staging には TypeScript、Vite、application dependency と build script が存在しないため、
Node 24 の `vercel build --prod` は app を再 build せず、検証済み `dist` と fixed metrics
adapter を package する。workflow は CLI child-process trace と build log を保存し、
`tsc`/`vite`/package install が実行されていないこと、build 前後の `dist/**` と `sw.js`
hash が不変であることを検証する。生成後は通常 artifact verifier に加え、SPA
rewrite/header table、API Function runtime 24、mode 別 API semantic fixture、公開 identity
を検証する。

final package layout は次に固定する。

```text
release-package/
  prebuilt.zip
  artifact-manifest.json
  package-index.json
```

`prebuilt.zip` は deploy 用 `.vercel/output` tree だけを含む。残る二つは archive 外の
control sidecar であり、outer directory の file はこの三つ以外を拒否する。initial deploy
と package redeploy は package を source checkout 外の一時 directory に展開し、全検証後に
`.vercel/output` を `vercel deploy --prebuilt` へ渡す。既存 deployment への instant
rollback は archive を upload しない。

artifact manifest と package index は少なくとも次を持つ。

```ts
type MetricsApiMode = "source-hardened" | "bootstrap-disabled-safe-adapter-v1";

type ArtifactManifest = {
  schemaVersion: 1;
  sourceSha: string;
  variantDimensions: Record<string, string>;
  variantId: string;
  releasePolicyHash: string;
  applicationBuildNodeVersion: string;
  applicationBuildNpmVersion: string;
  providerBuildNodeVersion: string;
  providerCliVersion: string;
  providerProjectId: string;
  providerSettingsHash: string;
  providerRuntimeFamily: "24.x";
  publicBuildEnvironment: Record<string, string>;
  runtimeEnvironmentPresencePolicy: {
    requiredNames: string[];
    forbiddenNames: string[];
  };
  metricsApiComponent: {
    mode: MetricsApiMode;
    sourceSha: string | null;
    sourceFileSha256: string;
  };
  files: Array<{ path: string; size: number; sha256: string }>;
};

type ReleasePackageIndex = {
  schemaVersion: 1;
  sourceSha: string;
  variantDimensions: Record<string, string>;
  variantId: string;
  releasePolicyHash: string;
  metricsApiMode: MetricsApiMode;
  artifactManifestHash: string;
  prebuiltArchiveSha256: string;
};
```

通常 package は `metricsApiComponent.mode: "source-hardened"`、
`metricsApiComponent.sourceSha === ArtifactManifest.sourceSha` とし、source file bytes の
SHA-256 を `sourceFileSha256` に記録する。P0 cross-source bootstrap baseline だけは
`mode: "bootstrap-disabled-safe-adapter-v1"`、`sourceSha: null` とし、
`scripts/templates/bootstrap-metrics-disabled.mjs` の exact bytes を API path へ配置する。
adapter は import、`process.env`、request body read、network call を一切持たず、`POST` には
JSON `503 {"error":"metrics-temporarily-unavailable"}`、それ以外には `Allow: POST` 付きの
JSON `405 {"error":"method-not-allowed"}` を返す。全 response は
`Cache-Control: no-store` と `Content-Type: application/json; charset=utf-8` を持つ。
metrics は best-effort なので、この明示的な無効化は local persistence、startup、recovery
の成功条件を変えない。

manifest component、package index、provider evidence、binding の `metricsApiMode` は exact
一致させる。static policy の `bootstrapMetricsApiAdapterSha256` は template、staged API、
`bootstrap-input.json`、manifest の source file hash と一致しなければならない。この mode
は exact P0 bootstrap exception の containment companion にだけ許可し、standard package、
Phase 1 以降の same-source companion、通常 rollback packageでは拒否する。

`ArtifactManifest.files` の path は展開した `.vercel/output` root からの normalized
relative path とし、byte 順で sort する。archive 内の symlink、path traversal、duplicate
path、case collision、manifest 未列挙 file、manifest 記載済み file の欠落を拒否する。
archive entry の timestamp、order、permission field は固定 policy で normalize する。

hash field を持たない manifest object 全体を canonicalize して
`artifactManifestHash` を求める。archive 完成後に archive bytes の SHA-256 を求め、両値と
source/variant/policy を hash field のない `ReleasePackageIndex` に束縛する。index 全体の
canonical SHA-256 である `packageIndexHash` は package 外の immutable evidence record に
保存する。verifier は index、manifest、archive、展開 file の順に再計算し、どの不一致も
deploy 前に拒否する。各 object の `variantDimensions` は exact 一致し、その JCS hash が
`variantId` と一致しなければならない。public build environment は値を含めて再現入力にし、
runtime secret は名前と presence policy だけを記録して値を evidence に出さない。

candidate 作成は production environment を対象にした
`vercel deploy --prebuilt --prod --skip-domain` 相当へ固定する。smoke test と承認後、
同じ candidate を `vercel promote` で昇格する。

package、provider deployment、公開 response の結合は次の canonical evidence に固定する。

```ts
type PublicResponseRecord = {
  path: string;
  status: number;
  cacheControl: string;
  contentType: string;
  bodySha256: string;
};

type ProviderDeploymentEvidence = {
  schemaVersion: 1;
  providerProjectId: string;
  deploymentId: string;
  deploymentRole: "qa" | "candidate" | "production" | "companion-candidate";
  immutableDeploymentUrl: string;
  sourceSha: string;
  variantDimensions: Record<string, string>;
  variantId: string;
  releasePolicyHash: string;
  metricsApiMode: MetricsApiMode;
  packageIndexHash: string;
  providerObservation: {
    cliVersion: string;
    target: "production";
    runtimeFamily: "24.x";
    readyState: "READY";
    productionDomains: string[];
    runtimeEnvironmentPresence: {
      requiredNamesPresent: string[];
      forbiddenNamesPresent: string[];
    };
    genericMetricsFallbackEnabled: false;
    capturedAt: string;
  };
  publicIdentity: ReleaseIdentity;
  publicResponses: PublicResponseRecord[];
};
```

`publicResponses` は normalized path の UTF-8 byte 順とし、少なくとも HTML、stable/versioned
capability、stable/versioned release identity、`sw.js`、manifest、および HTML から到達する
全 first-party static asset を含める。redirect、非 2xx、duplicate/case collision、取得 URL
の origin 逸脱を拒否し、body hash を `ArtifactManifest.files` と照合する。HTML と
capability から parse した identity、stable/versioned identity body、
`ProviderDeploymentEvidence.publicIdentity` は exact 一致を要求する。

`publicIdentitySha256` は `ReleaseIdentity` exact object の JCS bytes に対する SHA-256、
`providerEvidenceSha256` は hash field を持たない `ProviderDeploymentEvidence` 全体の JCS
bytes に対する SHA-256 とする。evidence の immutable URI と hash を
`DeploymentBinding` に記録し、binding と evidence の project/deployment/source/variant/
dimensions/policy/package/role/metrics API mode/public identity field をすべて exact
equality で検証する。
この定義は完全な `DeploymentBinding` 用であり、variant identity を持たない既存 production
の sequence-1 observation は §6.4 の discriminated legacy identity schema を使用する。
artifact manifest の `providerRuntimeFamily` は provider observation と exact 一致させる。
manifest の runtime environment presence policy は UTF-8 byte 順の unique name 配列とし、
provider observation の required names が完全一致し、forbidden names が 0 件で、
`genericMetricsFallbackEnabled` が false でなければ candidate を拒否する。
candidate/companion-candidate の `productionDomains` は空、production role は canonical
production domain を一つ以上含むことを要求する。`qa` role は disposable project
allowlist の domain だけを許可し、`DeploymentBinding` と Release State verifier は `qa`
evidence を拒否する。
CLI の deploy 結果と inspect 結果は secret と非決定 field を除いた
`providerObservation` へ正規化する。
通常 package は application build、provider build/runtime のすべてに `24.x` を要求する。
P0 bootstrap baseline だけは application build を監査済み Node `20.20.0`/npm `10.8.2` と
し、provider packaging と Function runtime は `24.x` に固定する。verifier は二つの build
runtime を混同せず、provider observation の `24.x` と artifact manifest を照合する。

candidate を production domain へ割り当てた後は、同じ
`{ providerProjectId, deploymentId, packageIndexHash, sourceSha, variantDimensions,
variantId, releasePolicyHash, metricsApiMode, publicIdentitySha256 }` と production domain の
inspect 結果を持つ
`deploymentRole: "production"` の新しい evidence/binding を作る。candidate binding を
書き換えず、assignment 前後の evidence を Release State chain に残す。

incident rollback は次の二経路を混在させない。

1. instant rollback: rollback inventory の package 三 file と外部
   `packageIndexHash` を再検証し、immutable deployment evidence の
   `{ providerProjectId, deploymentId, packageIndexHash }`、provider inspect、公開
   release identity が一致し、binding が `deploymentRole: "production"` と
   `eligibility["instant-rollback"].eligible: true` を持つ場合だけ
   `vercel rollback <previous-production-deployment>` を実行する。archive は upload
   しない。
2. package redeploy: instant rollback が利用できない、または対象 deployment が
   eligibility を失った場合でも
   `eligibility["package-redeploy"].eligible: true` である package に限り、保存 package を
   展開して全 file hash を検証し、
   `vercel deploy --prebuilt --prod --skip-domain` で新しい `deploymentId` を得る。
   package/project/public identity を candidate evidence に再束縛し、smoke と
   production change intent の記録後に promote する。assignment 後は production role の
   evidence/binding を別に作る。

どちらも旧 commit を現在の `node_modules` で再 build しない。

### 6.2 Provider route と identity

- `/api` と `/api/**` は SPA fallback から除外する。
- `/api/persistence-release-a-metrics` は `POST` 以外を `405`、未定義 API path を
  JSON `404` とし、HTML を返さない。
- `/sw.js`、`index.html`、manifest、hashed asset、API の `Cache-Control` を
  `vercel.json` の table test で固定する。
- candidate の HTML meta と capability manifest から `sourceSha` と `variantId` を
  取得する。`deploymentId` は protected workflow が deploy CLI/API の結果から取得する。
- `vite.config.ts` は一つの validated `ReleaseIdentity` object を作り、HTML transform、
  capability manifest plugin、App/Worker 用 `define` constant の三箇所へ渡す。別々に
  environment を読み直して identity を組み立てない。
- `ReleaseIdentity` は `schemaVersion`、`sourceSha`、`variantId` に加えて
  `pwaLifecycle: "legacy-auto-update-v1" | "prompt-close-all-v1"` を持つ。HTML meta、
  capability、stable/versioned identity、Service Worker は同じ値を使用する。
- 既存 Release A の `release-capabilities.json` と
  `release-capabilities.<sourceSha>.json` は互換性のため維持する。PWA candidate 照合用には
  同じ `ReleaseIdentity` から `release-identity.json` と
  `release-identity.<sourceSha>.<variantId>.json` を生成し、両方を precache 対象外にする。
  後者の file 名は strict lowercase hex の identity からだけ組み立てる。
- verifier は HTML meta、capability manifest の source/variant、artifact manifest の
  identity file hash、provider deployment evidence の deployment ID を cross-check する。
  build 後に確定する `artifactManifestHash` を app response に埋め込むことは要求しない。

target cache policy:

| path                                                         | `Cache-Control`                       |
| ------------------------------------------------------------ | ------------------------------------- |
| `/sw.js`                                                     | `public, max-age=0, must-revalidate`  |
| `/index.html` と SPA fallback                                | `public, max-age=0, must-revalidate`  |
| `/manifest.webmanifest`、unversioned icon、stable capability | `public, max-age=0, must-revalidate`  |
| `/release-identity.json`                                     | `no-store`                            |
| versioned outer recovery agent asset                         | `public, max-age=31536000, immutable` |
| content-hashed asset、versioned capability/identity          | `public, max-age=31536000, immutable` |
| `/api/**`                                                    | `no-store`                            |

provider default と競合する header は一つの `vercel.json` rule set に正規化し、同じ
response に矛盾する複数の `Cache-Control` を付けない。

### 6.3 Release A metrics API と DB

`source-hardened` API は次の contract にする。

- credential は `PERSISTENCE_METRICS_SUPABASE_URL` と
  `PERSISTENCE_METRICS_SUPABASE_SERVICE_ROLE_KEY` の dedicated pair が両方存在するときだけ
  使う。partial pair は `503` とする。
- `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、
  `PERSISTENCE_METRICS_ALLOW_GENERIC_FALLBACK` は production environment と handler の
  credential resolver の両方から除去し、component mix と generic fallback を構造的に
  不可能にする。
- `PERSISTENCE_METRICS_EXPECTED_PROJECT_REF` と
  `PERSISTENCE_METRICS_EXPECTED_PROVIDER_PROJECT_ID` を必須にする。Supabase URL は HTTPS と
  expected project ref、`VERCEL_PROJECT_ID` は expected provider project ID と exact
  一致させ、不一致は `503` とする。
- `PERSISTENCE_METRICS_ALLOWED_ORIGIN` は canonical production origin と
  `https://${VERCEL_PROJECT_PRODUCTION_URL}` の一致を要求する。request origin はこれ、
  または `https://${VERCEL_URL}` の exact current deployment origin のどちらかに限り、
  request host、`Sec-Fetch-Site: same-origin`、provider deployment/project identity も
  同時に検証する。これにより production-target candidate URL と promoted domain を同じ
  source contract で検証できる。
- upstream fetch は bounded timeout、`redirect: "error"`、`return=minimal` を使用する。
- response は `Cache-Control: no-store` を持つ。request の existing `buildId` は
  `sourceSha` として保存し、response header を別の identity 正本にしない。
- application contract の 1,024 bytes は declared `Content-Length` と normalized JSON
  payload に適用する。raw stream が渡される runtime では raw received bytes にも同じ
  上限を適用する。
- pre-parsed object の再 serialize は normalized payload 上限であり、元の raw byte
  上限を証明しない。handler 前の raw body 上限は provider platform の documented
  request limit が所有し、deployed oversized/chunked fixture で response を記録する。
- WAF は path、method、rate limit を補助できるが、application が全 runtime で raw
  1,024 bytes を保証するとは記載しない。

`source-hardened` package の runtime presence policy は
`PERSISTENCE_METRICS_ALLOWED_ORIGIN`、dedicated pair、expected project ref/provider project
ID、`VERCEL_DEPLOYMENT_ID`、`VERCEL_PROJECT_ID`、`VERCEL_PROJECT_PRODUCTION_URL`、
`VERCEL_URL` を required、上記 generic 3 names を forbidden とする。P0 の production
environment 変更前に protected inventory で generic pair の利用箇所が現行 metrics API
だけであることを確認し、generic 3 names を削除して dedicated names を設定する。provider
の environment 変更は既存 deployment に遡及しないため、変更後に standard と bootstrap
candidate を新規 deploy し、その runtime observation を binding に固定する。

P0 bootstrap containment の `bootstrap-disabled-safe-adapter-v1` はこの source-hardened
handler contract の例外であり、credential/environment を一切読まず前節の 405/503 contract
だけを返す。adapter package の runtime presence policy は required names を空、
forbidden names を generic 3 names とする。standard candidate は dedicated insert fixture、
bootstrap candidate は no-network 503 fixture を通す。どちらも local persistence の
startup/save/recovery 成功を metrics response から独立して検証する。

forward-only migration は次を行う。

- raw metrics table と既存 aggregate view に対する `service_role` の `SELECT` を
  revoke する。
- API に必要な raw table の `INSERT` と sequence privilege だけを残す。
- aggregate 読取が必要な operator には、固定 `search_path`、bounded time range、
  bounded row count を持つ `SECURITY DEFINER` function の `EXECUTE` だけを grant する。
- retention delete function は一回の削除件数と時間範囲を制限し、lock timeout と
  statement timeout を持つ。
- cron 実行、dry-run、削除件数、失敗を audit 可能にする。

local DB test は Docker、対象 Supabase CLI、対象 Postgres、`pg_cron`、`pgcrypto` を
明示した disposable environment で実行する。production 適用は remote fingerprint、
schema diff、privilege diff、dry-run、rollback rehearsal、二者承認を要求する。

legacy metrics の decommission 最短時刻は次の式で計算する。

```text
greatest(coalesce(last_received_at, legacyCutoverAt), legacyCutoverAt)
  + 30 days
  + 1 hour
```

pre-cutover、cutover、retention、decommission の evidence は既存 record を更新せず、
前 fragment の SHA-256 を参照する append-only fragment とする。

### 6.4 Evidence と外部 Release State

既存 v1 JSON、template、`scripts/verify-release-a-evidence.mjs` は変更しない。予定する
`verify:release-a-evidence-bundle` は stage を明示して検証する。

version-controlled `config/release-variants.json` は `schemaVersion`、単調な
`policyVersion`、必須 `releaseRole: "standard" | "containment"` を含む dimension schema、
許可 transition、hard-floor compatibility predicate、
transition ごとの gate ID/minimum observation hours、`observationClockSkewSeconds`、
standard から containment companion と staged standard recovery への変換規則、minimum
safety floor までの一意な lift 規則を持つ。初期 P0 policy は
`outerRecoveryAgent: null` とし legacy/current P0 binding だけを許す。Phase 1 の次 policy
version はこれを `{ schemaVersion: 1, assetPath, sha256 }` へ一回だけ進め、
`prompt-close-all-v1` target/companion に non-null exact 一致を要求する。agent path/hash は
この Phase 1 policy activation から Phase 8 完了まで不変とし、変更が必要な場合は旧/new
agent を両方保持する専用 policy transition と installed-profile migration gate を本計画とは
別に定義する。
さらに初回だけの `bootstrapBaselineSourceSha`、`bootstrapWrapperClosureHash`、
`bootstrapMetricsApiMode: "bootstrap-disabled-safe-adapter-v1"`、
`bootstrapMetricsApiAdapterSha256`、`applicationBuildNodeVersion: "20.20.0"`、
`providerRuntimeFamily: "24.x"`、bootstrap standard target dimensions と、この exception
の新規作成失効 gate `P0-RELEASE` を exact value で持つ。
現在 accepted な floor や deployment は持たない。exact object の
`releasePolicyHash` を artifact/package/provider evidence/binding に記録し、immutable policy
URI と hash の組を pre-promotion evidence と Release State に束縛する。

mutable な rollout の現在値は、外部 immutable storage の append-only event chain とする。
tracked `config/release-state.schema.json` と `scripts/verify-release-state.mjs` が少なくとも
次を検証する。

```ts
type EvidenceStage =
  | "state-bootstrap"
  | "policy-activation"
  | "pre-promotion"
  | "incident-prechange"
  | "provider-assignment"
  | "provider-inspect"
  | "safety-floor"
  | "post-promotion-smoke"
  | "post-promotion-smoke-failed"
  | "final-core"
  | "incident-smoke"
  | "incident-smoke-failed"
  | "eligibility-revoke";

type EvidenceReference = {
  stage: EvidenceStage;
  uri: string;
  sha256: string;
};

type DeploymentBinding = {
  providerProjectId: string;
  deploymentId: string;
  deploymentRole: "candidate" | "production" | "companion-candidate";
  sourceSha: string;
  variantDimensions: Record<string, string>;
  variantId: string;
  releasePolicyHash: string;
  metricsApiMode: MetricsApiMode;
  packageUri: string;
  packageIndexHash: string;
  providerEvidenceUri: string;
  providerEvidenceSha256: string;
  publicIdentitySha256: string;
};

type LegacyBootstrapPublicIdentity = {
  schemaVersion: 1;
  identityKind: "legacy-release-a";
  sourceSha: string | null;
  releaseABuildId: string | null;
  pwaLifecycle: "legacy-auto-update-v1";
  htmlBodySha256: string;
  capabilityBodySha256: string;
  serviceWorkerBodySha256: string;
};

type BootstrapObservation = {
  providerProjectId: string;
  deploymentId: string;
  sourceSha: string | null;
  variantId: null;
  identitySchema: "legacy-bootstrap-v1";
  publicIdentity: LegacyBootstrapPublicIdentity;
  publicIdentitySha256: string;
  evidence: EvidenceReference;
};

type ProductionReference =
  | { kind: "bootstrap-observation"; observation: BootstrapObservation }
  | { kind: "deployment-binding"; binding: DeploymentBinding };

type RecoverySource =
  | {
      kind: "inventory";
      inventoryKey: string;
      action: "instant-rollback" | "package-redeploy";
    }
  | {
      kind: "active-companion";
      bindingHash: string;
      action: "package-redeploy";
    };

type ProductionChange = {
  operationId: string;
  mode: "normal-promotion" | "instant-rollback" | "package-redeploy";
  transitionKind:
    | "standard-rollout"
    | "standard-recovery-step"
    | "emergency-recovery";
  from: ProductionReference;
  target: DeploymentBinding;
  proposedCompanion: DeploymentBinding | null;
  recoverySource: RecoverySource | null;
  supersedesAssignmentHash: string | null;
  intentEvidence: EvidenceReference;
};

type ProductionAssignment = {
  operationId: string;
  mode: ProductionChange["mode"];
  transitionKind: ProductionChange["transitionKind"];
  intentStateHash: string;
  from: ProductionReference;
  production: DeploymentBinding;
  companion: DeploymentBinding | null;
  assignmentEvidence: EvidenceReference;
};

type PendingAcceptance = {
  assignmentHash: string;
  operationId: string;
  mode: ProductionChange["mode"];
  transitionKind: ProductionChange["transitionKind"];
  intentStateHash: string;
  production: DeploymentBinding;
  companion: DeploymentBinding | null;
  observationMode: "normal" | "containment";
  observationRequirement: { gateId: string; minimumHours: number };
  observationAnchor: {
    sequence: number;
    eventType:
      | "production-assigned"
      | "production-change-reconciled"
      | "safety-floor-advanced"
      | "production-validation-passed"
      | "containment-activated";
  } | null;
  nextRequiredEvent:
    | "safety-floor-advanced"
    | "production-validation-passed"
    | "containment-activated"
    | null;
  blockedByFailure: { reason: string; evidence: EvidenceReference } | null;
};

type ActionEligibility = {
  eligible: boolean;
  reason: string | null;
};

type RollbackAction = "instant-rollback" | "package-redeploy";

type RollbackInventoryEntry = {
  inventoryKey: string;
  binding: DeploymentBinding;
  pairedCompanionKey: string | null;
  eligibility: Record<RollbackAction, ActionEligibility>;
};

type CompanionSourceBlock = {
  bindingHash: string;
  reason: string;
  evidence: EvidenceReference;
};

type StandardRecoveryContext = {
  startedByAssignmentHash: string;
  releasePolicyHash: string;
  originAcceptedStandard: ProductionReference;
  goalVariantDimensions: Record<string, string>;
  deferredHardFloorAdvances: FloorAdvance[];
};

type FloorAdvance = {
  dimension: string;
  from: string;
  to: string;
};

type ReleaseStateSnapshot = {
  staticPolicy: { policyVersion: number; uri: string; sha256: string };
  activeProduction: ProductionReference;
  acceptedProduction: ProductionReference;
  activeCompanion: DeploymentBinding | null;
  acceptedCompanion: DeploymentBinding | null;
  pendingOperation: ProductionChange | null;
  pendingAcceptance: PendingAcceptance | null;
  minimumSafetyFloors: Record<string, string>;
  acceptedHardFloors: Record<string, string>;
  dbCompatibilityFingerprint: string;
  rollbackInventory: RollbackInventoryEntry[];
  blockedCompanionSources: CompanionSourceBlock[];
  standardRecoveryContext: StandardRecoveryContext | null;
};

type ReleaseStateEventPayload =
  | {
      kind: "state-bootstrap";
      observation: BootstrapObservation;
      staticPolicy: ReleaseStateSnapshot["staticPolicy"];
      minimumSafetyFloors: Record<string, string>;
      acceptedHardFloors: Record<string, string>;
      dbCompatibilityFingerprint: string;
    }
  | {
      kind: "static-policy-activated";
      previous: ReleaseStateSnapshot["staticPolicy"];
      next: ReleaseStateSnapshot["staticPolicy"];
      activationEvidence: EvidenceReference;
    }
  | { kind: "production-change-intent"; operation: ProductionChange }
  | {
      kind: "production-change-aborted";
      operationId: string;
      intentStateHash: string;
      reason: string;
      providerObservation: EvidenceReference;
    }
  | {
      kind: "production-assigned" | "production-change-reconciled";
      assignment: ProductionAssignment;
    }
  | {
      kind: "safety-floor-advanced";
      dimension: "pwaLifecycle";
      from: "legacy-auto-update-v1";
      to: "prompt-close-all-v1";
      assignmentHash: string;
      safetyEvidence: EvidenceReference;
    }
  | {
      kind: "production-validation-passed";
      assignmentHash: string;
      validationEvidence: EvidenceReference;
    }
  | {
      kind: "production-validation-failed";
      assignmentHash: string;
      reason: string;
      failureEvidence: EvidenceReference;
    }
  | {
      kind: "release-accepted";
      operationId: string;
      assignmentHash: string;
      transitionKind: ProductionChange["transitionKind"];
      production: ProductionReference;
      companion: DeploymentBinding | null;
      finalCore: EvidenceReference;
      acceptedHardFloorAdvances: FloorAdvance[];
      inventoryAdditions: RollbackInventoryEntry[];
    }
  | {
      kind: "containment-activated";
      assignment: ProductionAssignment;
      assignmentHash: string;
      incidentEvidence: EvidenceReference;
    }
  | {
      kind: "containment-attempt-failed";
      assignmentHash: string;
      reason: string;
      failureEvidence: EvidenceReference;
    }
  | {
      kind: "rollback-eligibility-revoked";
      inventoryKey: string;
      action: RollbackAction;
      reason: string;
      revocationEvidence: EvidenceReference;
    }
  | {
      kind: "active-companion-eligibility-revoked";
      bindingHash: string;
      reason: string;
      revocationEvidence: EvidenceReference;
    };

type ReleaseStateEvent = {
  schemaVersion: 1;
  sequence: number;
  previousStateHash: string | null;
  eventType: ReleaseStateEventPayload["kind"];
  payload: ReleaseStateEventPayload;
  state: ReleaseStateSnapshot;
  supportingEvidence: EvidenceReference;
  approvalRefs: string[];
  recordedAt: string;
};
```

`BootstrapObservation.publicIdentitySha256` は `LegacyBootstrapPublicIdentity` exact object の
JCS bytes に対する SHA-256 とする。state-bootstrap evidence は current production の
HTML、Release A capability、`sw.js` の response hash と既存 build ID を採取し、artifact/
browser trace から legacy auto-update lifecycle を分類する。`sourceSha` は observation と
legacy identity で exact 一致させる。これは新 `ReleaseIdentity` の代用ではなく sequence 1
専用 schema であり、`DeploymentBinding`、candidate、rollback inventory には使用しない。
P0 standard acceptance 後の production reference は完全な variant identity を持つ
`deployment-binding` だけとする。

`payload.kind` は `eventType` と exact 一致させ、自由な追加 key は拒否する。

event object は自身の hash を持たない。canonical object の `releaseStateHash`、immutable
URI、schema version を外部 current record が参照する。各 event の `state` は直前 snapshot
と payload から deterministic reducer で再計算し、event 内の任意 snapshot を信用しない。
transition は次に固定する。

- `state-bootstrap` は sequence 1 だけに許可し、監査済み current production を
  `bootstrap-observation` reference として active/accepted の両方へ入れる。payload の
  policy/floor/DB fingerprint から初期 snapshot を作り、companion/pendingOperation/
  pendingAcceptance/inventory/companion block は空、`standardRecoveryContext` は null
  にする。完全な package/deployment binding がない deployment は rollback inventory に
  入れない。
- `static-policy-activated` は pending operation/acceptance がなく、
  `standardRecoveryContext` も null のときだけ二者承認で行う。新 policy は immutable
  URI/hash と単調な `policyVersion` を持ち、old/new policy を全既知 dimension、current
  floor、active/accepted/companion、全 inventory binding で差分評価する。floor の順序や
  意味、gate ID/minimum observation hours を弱めず、clock skew 上限を増やさず、effective
  eligible action 集合を拡大しない場合だけ active にできる。
  active/accepted/companion/floor/inventory/block/recovery context は変えない。
- `production-change-intent` は unresolved operation がないときだけ append し、`from` を
  current active と exact 一致させる。`standard-rollout` は mode が
  `normal-promotion`、pending acceptance と recovery context がともに null の場合だけ
  許可し、target の `releaseRole` を `standard`、proposed companion を `containment`、
  `recoverySource` と `supersedesAssignmentHash` を null にする。
  `standard-recovery-step` は mode が `normal-promotion`、pending acceptance が null、
  recovery context が non-null の場合だけ許可する。target は policy が context の current
  accepted dimensions と goal から算出する exact next standard variant、proposed companion
  は target の exact containment projection とし、recovery source と supersede は null
  にする。`emergency-recovery` は mode を `instant-rollback` または
  `package-redeploy` とし、対応する non-null recovery source を必須にする。observation
  中にも許可するが、既存 pending acceptance があればその exact `assignmentHash` を
  supersede field に入れる。intent 自体は
  active/accepted/companion/floor/inventory/pendingAcceptance/recovery context を変えず、
  `pendingOperation` だけを設定する。
- instant rollback の `recoverySource` は action-valid inventory entry とし、intent target
  はその production binding と exact 一致させる。package redeploy の source は
  action-valid inventory entry または active companion とし、新 target は source と同じ
  package URI/hash、source、variant dimensions/ID、policy を持ち、新しい deployment ID/
  provider evidence を持つ `candidate` binding とする。source variant が containment でも、
  production assignment 対象として再配備した新 deployment の role は candidate とする。
  active companion source は、承認済み pre-promotion evidence から active になり、current
  policy/floor/DB contract を再検証し、exact binding の inventory entry と block がまだ
  存在しない observation 中だけ暗黙に `package-redeploy` eligible とする。inventory entry
  が存在すれば stored action eligibility を許可上限とし、`false` を上書きしない。実効
  eligibility は stored `true` に current policy/floor/DB/recovery-context compatibility を
  AND して毎回再導出する。
- `proposedCompanion` は全 mode の post-change companion であり Phase 0E 以降は non-null
  とする。通常は target と同じ source/policy/floor を満たす exact same-source containment
  projection と pre-promotion evidence を検証し、standard target とは別
  `variantId`/artifact/binding にする。唯一の例外は state bootstrap から最初の P0 standard
  rollout へ進むときであり、current policy の exact `bootstrapBaselineSourceSha` と
  `bootstrapWrapperClosureHash`、同じ provider project/policy/DB contract/floor を持つ
  監査済み cross-source
  companion だけを許可する。`P0-RELEASE` acceptance 後は新たな cross-source pair を
  作れず、Phase 1 以降と standard recovery step は必ず same-source とする。受理済み
  bootstrap baseline は次の same-source companion acceptance または floor incompatibility
  まで既存 recovery source としてだけ維持する。inventory production entry の
  `pairedCompanionKey` は対応する companion entry を指し、recovery intent は target とその
  pair を同時に復元する。companion entry/active companion 自身を package redeploy source
  にする場合は、その source binding を proposed companion として保持する。
- pending 中に許可する次 event は、同じ operation ID/binding の
  `production-assigned`、`production-change-reconciled`、`production-change-aborted` の
  いずれか一つだけとする。二重 intent と別 candidate の assignment を拒否する。
- provider mutation 前に失敗し、inspect で `from` の assignment が維持されている場合だけ
  `production-change-aborted` で pending を閉じる。mutation 成功後に state append が
  失敗または応答不明になった場合は abort せず、intent hash と provider inspect を使って
  idempotent な `production-change-reconciled` を append する。
- `production-assigned` と `production-change-reconciled` は、intent target と同じ
  project/deployment/package/source/variant dimensions/ID/policy/public identity を持つ
  production-role binding だけを active にする。全 mode で
  `activeCompanion = assignment.companion` とし、intent の proposed companion と
  assignment の mode/transition kind、assignment 前後の role/evidence invariant を検証する。
  accepted production/companion と両 floor、inventory/recovery context は変えず、pending
  operation を閉じる。
- assignment object の JCS hash を `assignmentHash` とする。assignment/reconciliation は
  active production/companion と operation/transition kind/intent hash を束縛した
  `pendingAcceptance` を作る。standard rollout/recovery step は normal observation、
  emergency recovery は containment observation とし、policy が即時 PWA safety transition
  を要求する場合は
  `nextRequiredEvent: "safety-floor-advanced"`、それ以外の recovery は
  `"containment-activated"`、通常 release は `"production-validation-passed"` にし、
  `blockedByFailure` は null で
  初期化する。`observationRequirement` は hash-bound current policy の exact transition
  record から再計算し、payload 任意値を受理しない。observation anchor は null にする。
  以前の pending acceptance は recovery intent が exact hash で supersede した場合だけ
  置換できる。
- pending acceptance が safety floor を要求する間は、その exact assignment/operation の
  `safety-floor-advanced` 以外を append しない。normal validation を要求する間は
  `production-validation-passed` または `production-validation-failed` だけを許可する。
  containment activation を要求する間は `containment-activated` または
  `containment-attempt-failed` だけを許可する。observation 中も normal intent と policy
  activation を禁止する。blocked failure がなければ release acceptance、action revoke、
  supersede hash 付き emergency intent、blocked failure があれば action revoke と
  superseding emergency intent だけを許可する。
- `safety-floor-advanced` は pending acceptance の exact `assignmentHash` に対して一度だけ
  PWA minimum safety floor を `prompt-close-all-v1` へ進める。normal observation なら
  next required event を `"production-validation-passed"` にする。containment observation
  なら anchor は null のまま
  `"containment-activated"` に進める。active/accepted、accepted hard floor、inventory は
  変えない。
- `production-validation-passed` は normal pending acceptance の exact assignment に対する
  post-promotion smoke、公開 identity、API/offline validation evidence が成功した場合だけ
  append し、next required event を null にしてこの event の sequence を observation anchor
  にする。
- normal validation が失敗した場合は成功 event を作らず、
  `production-validation-failed` に exact assignment hash、失敗 evidence、理由を記録する。
  `nextRequiredEvent` と anchor は null にして pending acceptance を blocked にし、
  superseding emergency intent だけで active production を切り替える。
- `release-accepted` は pending operation がなく、pending acceptance の
  operation/assignment/transition kind/production/companion と payload が exact 一致し、
  next required event と blocked failure が null、final core の assignment identity、gate
  ID、開始/終了時刻が non-null observation anchor と requirement を満たし、capture start
  が anchor event の authoritative store `committedAt` 以降、duration が `minimumHours`
  以上で、三者承認が有効な場合だけ許可する。accepted production/companion を active と
  一致させ、対象 phase の accepted hard floor と inventory を進めて pending acceptance を
  clear する。
  `standard-rollout` の accepted hard floor advance は 0 または 1 件、dimension 重複なし
  とし、candidate が実際に変更した唯一の behavior dimension に対する current static
  policy の一段 transition だけを許可する。intermediate `standard-recovery-step` と
  containment target の `emergency-recovery` は floor advance を 0 件に固定する。goal と
  exact 一致する最終 standard recovery step、または context の goal へ戻る standard-role
  emergency recovery だけは、context に固定した deferred hard-floor advances と payload
  の advances を exact 一致させて同時適用する。context の exact current/next standard
  intermediate を emergency target として受理する場合は floor advance を 0 件とし、
  context をそのまま保持する。inventory addition は payload の exact
  binding/pair/action eligibility から再計算し、sort 後の snapshot と一致させる。同じ
  assignment の二重 acceptance は拒否する。
- containment target を受理するとき、recovery context が null なら受理直前の accepted
  standard reference の dimensions を current minimum safety floors まで policy の最小
  transition で持ち上げた standard variant を goal とする。accepted hard floor が current
  minimum safety floor に未追随の dimension は exact advance を
  `deferredHardFloorAdvances` に sort して固定する。本計画では Phase 1 の
  `legacy-auto-update-v1 -> prompt-close-all-v1` の 0 または 1 件だけである。bootstrap
  observation しかない初回は current policy の bootstrap standard target dimensions を
  同じ方法で持ち上げる。`startedByAssignmentHash` は今受理する containment の assignment
  hash、`releasePolicyHash` は current static policy hash、`originAcceptedStandard` は
  受理前の accepted reference とする。すでに context があれば context object 全体を
  byte-for-byte 保持し、どの field も上書きしない。context が null で受理前 reference が
  standard binding でも bootstrap observation でもない状態は不正として拒否する。
  `standard-recovery-step` の受理では exact next standard target へ進み、goal dimensions
  と exact 一致し、payload が deferred advances をすべて適用したときだけ context を clear
  する。それ以外の step では floor と context を保持する。standard role の
  `emergency-recovery` は context がある場合に policy が算出する exact current/next
  standard variant と一致する target だけを許可する。goal 未到達の acceptance は context
  を保持し、goal へ到達する acceptance だけが deferred advances を適用して context を
  clear する。
- `containment-activated` は pending acceptance が指定する recovery assignment と
  `nextRequiredEvent` に exact 一致する場合だけ incident smoke と recovery mode/from/to
  binding を記録し、next required event と blocked failure を null にして containment
  event の sequence を observation anchor にする。active は assignment 済みの
  binding、accepted と floor は不変とし、通常 observation 後の `release-accepted` まで
  accepted deployment と区別する。
- containment smoke が失敗した場合は成功 event を作らず、
  `containment-attempt-failed` に exact assignment hash、失敗 evidence、理由を記録する。
  active/accepted/floor を変えず、`nextRequiredEvent` と observation anchor は null にして
  pending acceptance を blocked にし、次の superseding emergency intent を許可する。
- `rollback-eligibility-revoked` は active/accepted/companion/floor を変えず、指定した
  inventory action の `true -> false` だけを許可する。inventory 未登録の active companion
  は `active-companion-eligibility-revoked` で binding hash を append-only block list に
  追加し、以後 implicit recovery source にできない。

`inventoryKey` と active companion の `bindingHash` は exact `DeploymentBinding` の JCS
bytes に対する SHA-256 とし、entry は key 順、action key は schema 順に canonicalize する。
後続 snapshot で既存 entry の欠落、binding/role/pair の書換え、`false -> true`、reason の
消去を拒否する。eligibility の `true -> false` は revoke event、証拠、承認がある場合だけ
許可する。再び利用可能にする package は新しい deployment/evidence/binding として追加する。
rollback 実行時は記録済み eligibility だけを信用せず、binding の exact
`variantDimensions`、current static policy、minimum safety floor、accepted hard floor、DB
fingerprint、provider inspect、公開 identity から対象 action と companion pair の適格性を
再導出する。companion block は key 順、追記だけとし、欠落と同一 binding hash の再許可を
拒否する。blocked companion を acceptance 時に inventory へ加える場合は
`package-redeploy: false` を引き継ぐ。

`minimumSafetyFloors` は observation 前でも下回れない一方向の安全境界、
`acceptedHardFloors` は observation と `release-accepted` を完了した rollout baseline
である。rollback target は minimum safety と DB forward contract を満たし、standard なら
accepted baseline、containment/recovery なら static policy がその baseline から生成する
exact safe projection に一致しなければならない。唯一の standard below-floor 例外は
non-null recovery context と current policy が一意に算出する exact current/next recovery
step であり、minimum safety floor は常に満たす。context clear 後は intermediate binding の
実効 eligibility を false として再導出し、inventory に true が残っていても recovery source
に選ばない。任意の下位 standard variant は許可しない。
Phase 1 以外の floor は `release-accepted` でのみ進める。

`dbCompatibilityFingerprint` は physical schema の現在値ではなく、rollback package に必要な
最小 API/table/privilege contract の hash とする。Phase 0D の remote migration は state
bootstrap 前に適用して初期 contract を確定し、physical schema fingerprint は別 evidence
として保持する。本計画の Phase 1〜8 はこの minimum remote contract を変更しない。将来、
旧 package を非互換にする remote migration が必要な場合は、migration 前 intent、適用後の
即時 safety-contract advance/reconciliation、inventory action revoke を持つ独立 plan と
Release State schema version を先に導入し、`release-accepted` まで変更を遅延させない。

`supportingEvidence` は event ごとの payload reference と exact URI/hash/stage 一致を
要求する。bootstrap は observation evidence、policy activation は activation evidence、
intent は pre-promotion/incident-prechange evidence、abort/reconciliation は provider
inspect、normal assignment は provider assignment、safety floor は safety evidence、
normal validation は post-promotion smoke、acceptance は final core、containment は incident
smoke、revoke は eligibility revoke を参照する。normal/containment failure はそれぞれ
`post-promotion-smoke-failed`/`incident-smoke-failed` を参照する。protected verifier は
allowlist 済み resolver で immutable URI の bytes を取得し、SHA-256 と stage schema を
再検証する。hash binding は一方向とし、先に完成した evidence を event が参照し、その後の
terminal evidence fragment が `releaseStateHash` を参照する。event 自身や evidence core を
再生成しない。

build は external state を ambient input として読まない。workflow が明示する
`variantDimensions` と static policy URI/hash を検証し、artifact に exact dimension
object、`variantId`、`releasePolicyHash` を記録する。promotion/rollback workflow だけが
current external state を読み、current policy による transition と action eligibility を
検証する。

`scripts/release-state-store.mjs` は protected workflow 専用 port とし、
`readCurrent()`、`listCommitted()`、
`compareAndAppend(expectedHash, expectedSequence, appendId, eventBytes)` だけを公開する。
compare-and-append は immutable event 保存と current record 更新を一つの transaction として
commit する。同じ `appendId` と同じ event bytes の再試行は同じ committed hash を返し、
同じ ID と異なる bytes は拒否する。`appendId` は event append ごとに一意とし、
production change の相関用 `operationId` をそのまま再利用しない。committed record は
event URI/hash/sequence に backend transaction clock の `committedAt` を付け、
`listCommitted()` はこの envelope を返す。event の `recordedAt` は audit field であり
observation clock に使わない。
event blob 作成と pointer CAS を分ける backend は使わない。store URI と credential は
runtime secret とし artifact に含めない。Phase 0C は production と別 namespace で
concurrent append、二重 intent、stale pointer、replay、response loss、crash window、
reconciliation、retention、credential denial を検証し、この capability を満たす store
binding なしでは `P0-ARTIFACT` を通さない。

observation verifier は anchor sequence の authoritative `committedAt` を取得し、protected
capture/metrics service の authenticated timestamp と比較する。runner/browser が自己申告した
時計だけで開始・終了を決めず、許容 clock skew を static policy に固定する。

`pre-promotion` stage:

- candidate の controlled standalone trace
- candidate の actual installed PWA 実機または self-hosted runner trace
- DB fingerprint、privilege、retention snapshot
- package index、artifact manifest、archive、各 hash、evidence URI と
  `packageIndexHash`
- source、variant、static policy URI/hash、candidate の
  `ProviderDeploymentEvidence`/binding の一致
- Phase 0E は exact policy exception に一致する cross-source bootstrap baseline、Phase 1
  以降は same-source containment companion の package index、immutable URI、companion
  candidate URL trace
- Phase 1 以降は outer agent の policy/path/hash、両 artifact/precache の byte equality、
  agent-only reproducibility、`static-policy-activated` event/chain hash、同一 stable QA
  origin の installed/controlled fault-to-containment activation trace
- current `releaseStateHash`、active/accepted production、pending operation/acceptance、
  standard recovery context、proposed operation、action 別 rollback inventory snapshot
- append-only fragment chain
- Release と Data Safety の異なる 2 名の承認

`final` stage:

- 完成済み v1 JSON と既存 verifier の成功結果
- promoted production の controlled standalone trace
- promoted production の actual installed PWA trace
- 24 時間 observation と DB snapshot
- pre-promotion bundle hash とその後の append-only fragment
- production change intent、production assignment/reconciliation の Release State
  event/chain hash
- final evidence core hash、それを参照する accepted-floor event、その
  `releaseStateHash` を参照する terminal fragment
- Release、Data Safety、Operations の異なる 3 名の承認

repository の `docs/release-a-evidence.template.json` と `PENDING` 値は evidence 完了を
表さない。actual installed trace と完成済み v1 JSON は Phase 0E で取得し、外部保管する
場合も immutable URI、SHA-256、capture tool identity を bundle に含める。

### 6.5 PWA update lifecycle

目標は最小の custom `injectManifest` と native registration を使う prompt-close-all
方式である。Web Locks permit、`PREPARE/APPLY` protocol、開いている client からの強制
activation は導入しない。

- `strategies: "injectManifest"`
- `registerType: "prompt"`
- `injectRegister: false`
- generateSW 用の `skipWaiting` と `clientsClaim` option は削除する。
- `src/sw.ts` は `self.skipWaiting()` と `clientsClaim()` を呼ばず、`SKIP_WAITING`
  message handler を持たない。
- `src/sw.ts` は `precacheAndRoute(self.__WB_MANIFEST)`、Workbox 管理下の outdated
  precache cleanup、`/api(?:/|$)` を denylist にした navigation fallback、明示した
  runtime route だけを登録する。
- precache manifest は stable/versioned `release-identity` を除外する。identity path は
  `NetworkOnly` とし、precache または runtime cache から応答しない。
- precache cleanup は natural activation 時に Workbox が current registration/scope の
  非現行 precache entry/cache へ行う処理だけを許可する。runtime cache、利用者データ、
  IndexedDB、別 scope の cache を対象にする manual `caches.delete()` は実装しない。
- Phase 2 までは両 PWA graph で Tailwind parity に必要な CacheFirst/expiration route と
  current Supabase NetworkOnly route を維持する。Phase 2 で resolved entry graph と
  browser trace が Supabase request 0 を証明した後にだけ後者を両 graph から削除する。
- `src/pwa/recovery/outerRecoveryAgent.ts` が
  `navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })`、
  `registration.update()`、installing/waiting/active state の監視を所有する。
- standard/containment の `serviceWorkerBootstrap.ts` は agent の read-only snapshot を UI
  へ接続する role-local adapter とし、`register()`、`update()`、Worker challenge、activation、
  reload、cache delete を呼ばない。
- UI は更新の存在、未保存 blocker、全 tab を閉じる必要を表示する。
- update button は保存操作と閉じ方の案内だけを行い、`SKIP_WAITING`、programmatic
  reload、cache delete を実行しない。
- `BroadcastChannel` は tab 間の表示同期だけに使用し、安全性の正本にしない。
- blocker registry は draft、実行中 import/export、未完了 persistence、open dialog
  など、実在する非同期処理を token で登録、解除する。
- best-effort metrics の送信待ちは blocker に登録しない。
- `beforeunload` は未保存状態がある client だけで使用する。
- agent は active controller の `sourceSha` と page capability を role entry import 前に
  検証する。incompatible、timeout、role entry load/evaluation failure では data mutation と
  App mount を開始せず、role graph と別の `recovery-root` に最小 recovery UI を維持したまま
  update discovery を継続する。

Worker identity は `ServiceWorker.scriptURL` や worker 自身の申告だけから推測しない。
`src/sw.ts` は exact `GET_RELEASE_IDENTITY` message にだけ MessageChannel で
`schemaVersion`、`sourceSha`、`variantId`、`pwaLifecycle` を返す。outer agent は active
controller と `registration.waiting` のそれぞれへ直接 challenge nonce を送り、response
nonce、schema、identity、timeout を検証する。unknown message と `SKIP_WAITING` message は
state を変えず無視する。

active controller の応答は HTML meta と page capability に一致しなければ fail-closed と
するが、agent の registration/update check は停止しない。waiting Worker は、その応答だけ
では更新候補として扱わない。agent は同じ nonce を query に付け、`cache: "no-store"`、
same-origin、redirect error、timeout 付きで precache
対象外の `/release-identity.json` を取得する。次に strict 検証済み identity からだけ
`/release-identity.<sourceSha>.<variantId>.json` を組み立て、同じ
`cache: "no-store"`、same-origin、redirect error、timeout 条件で network-only に取得する。
protected artifact verifier は stable/versioned identity の exact object と artifact
manifest 上の両 file hash を deploy 前に照合する。runtime agent は waiting 応答と
network-only の stable/versioned identity が exact 一致し、かつ active identity と異なる
場合だけ更新案内を表示する。
offline、timeout、不一致、未知 schema では旧 version を継続し、online/visibility/update
event で再検証する。active Worker の precache や HTTP cache を候補 identity の正本に
しない。controller がない初回 install は HTML meta と network identity の一致を確認し、
Worker identity とは記録しない。

`index.html` の最初かつ唯一の module script は
`src/pwa/recovery/outerRecoveryAgent.ts` から生成する content-hashed agent asset とする。
HTML は `recovery-root` と `app-root` を分け、validated meta に build が選んだ role、
content-hashed role entry path、ReleaseIdentity を持つ。agent は React、App、XLSX、
persistence、standard/containment module を静的 import せず、same-origin の
`/assets/(standard|containment)-entry.<hash>.js` 形式と manifest membership を検証してから
`import(/* @vite-ignore */ roleEntryUrl)` する。role entry の URL は build plugin が
`releaseRole` から一つだけ emit/inject し、runtime flag や `import.meta.glob` で両 role を
到達可能にしない。

`pwa:agent:build` は `scripts/build-pwa-recovery-agent.mjs` から Vite の固定 single-entry
config を呼び、source checkout 外の一時 directory に agent asset と
`{ schemaVersion, assetPath, sha256 }` だけを出力する。public environment、release identity、
role、variant、policy を読まず、recovery directory 外への resolved importを拒否する。full
standard/containment build は同じ builder を再実行して tracked policy object の path/hash と
照合し、一致した asset を byte-for-byte `dist` へ組み込み、別 bundler graph で再生成しない。
protected artifact verifier が tracked `releasePolicyHash` と external active policy を別に
照合する。

agent asset は standard/containment artifact に同じ path、bytes、SHA-256 で含め、両 Worker
が同じ revision を precache する。HTML reference は一つだけにし、inline copy/fallback を
持たせない。cached standard shell からも agent が precache hit で起動でき、その agent が
`updateViaCache: "none"` の registration/update check を開始できることを browser test で
固定する。agent、HTML reference、precache revision、static policy、artifact manifest、
package index の path/hash 不一致は production artifact を拒否する。後続 phase でも agent
を role/app bundle に再統合しない。

Phase 1 以降の `releaseRole: "containment"` は、同じ checkout から standard と独立した
compile-time role/PWA graph を build する。`src/pwa/containment/bootstrap.ts`、
`appEntry.tsx`、read-only `serviceWorkerBootstrap.ts`、`sw.ts` を固定 safe adapter とし、
standard の `src/bootstrap.ts`、`src/pwa/serviceWorkerBootstrap.ts`、`src/sw.ts` を import
しない。共有を許可するのは outer agent とその read-only snapshot type、validated
ReleaseIdentity schema/constants、Workbox package、Phase 1 で変更しない App/domain module
だけとする。React mount、role-local UI bridge、Worker message response、offline route は
containment graph 自身が実装するが、registration/update/identity challenge/recovery root は
outer agent だけが所有する。Vite config は `releaseRole` から role entry と injectManifest
source を build 前に一つだけ選び、両 graph の混在、runtime flag 切替、standard PWA module
の containment chunk 混入を artifact/architecture test で拒否する。

containment graph の observable contract も `prompt-close-all-v1` であり、
`skipWaiting`/`clientsClaim`/`SKIP_WAITING` handler を持たず、全 client close 後の natural
activation、identity response、API denylist、offline startup、既存 App/data contract を
満たす。この safe graph と outer agent は後続 phase のリファクタ対象にせず、contract 変更時
だけ独立 gate 付きで更新する。

standard-only fault fixture は outer agent、HTML agent reference、agent precache entry を
変更せず、role bootstrap load、role-local registration/UI adapter、Worker evaluation、
Worker identity response を一つずつ失敗させる。disposable QA の同一 stable origin へ最初に
unfaulted agent-bearing standard を割り当て、actual installed/controlled profile を作った後、
fault standard、保存済み containment の順に同じ originへ割り当てる。各 case で agent
実行を確認する。bootstrap/UI bridge/identity fault は faulted standard を natural activation
させてその Worker に control された状態、Worker evaluation fault は install rejection により
直前の unfaulted Worker が control を維持する状態を開始点にする。そこから containment
Worker の install/waiting、開いた client の controller 不変、全 client close、次の reopen で
一度だけ natural activation、full App/API/offline/persistence と release identity の回復まで
証明する。unique deployment URL の fresh profile 成功だけでは合格にしない。drill 中の
unregister、cache delete、programmatic reload、deployment URL への退避を禁止する。
fault fixture は disposable QA role 専用の test transform とし、fault ID/tool hash を QA
evidence に記録する。canonical artifact builder は fault input/environment の存在を拒否し、
fault package を `DeploymentBinding`、pre-promotion pair、rollback inventory に入れない。

`src/sw.ts` は DOM 用 TypeScript project に混在させない。Phase 1 で
`tsconfig.worker.json` を追加し、`lib: ["ES2020", "WebWorker"]` で Service Worker entry を
型検査する。containment `sw.ts` も同じ worker project の別 entry として型検査する。app
config は worker entry を除外し、root typecheck は app、node、worker の全 project を
明示的に実行する。Phase 3 では同じ worker project に XLSX dedicated Worker entry を
追加し、共有 module は DOM global に依存させない。

Phase 1 の PWA 切替は `vite.config.ts`、`index.html`、outer agent、両 role bootstrap、
Service Worker、`scripts/verify-release-a-build.mjs` を同一 atomic commit で変更する。
target verifier は
`pwaLifecycle: "prompt-close-all-v1"`、`sw.js`、manifest、stable/versioned capability と
identity、outer agent meta/entry/hash、exact 一つの role entry を必須にし、
`registerSW.js` の存在、role graph 内の Navigator registration/update call、
`SKIP_WAITING` handler、`self.skipWaiting()`、`clientsClaim()` を拒否する。native
registration と cached shell からの update discovery は artifact text だけで代用せず
browser test で確認する。

Phase 0 の legacy artifact fixture は `legacy-auto-update-v1` schema と
`registerSW.js` 必須条件で別に検証できるよう保持するが、Phase 1 production floor 後の
canonical build/deploy workflow は legacy schema を受理しない。

旧 auto-update package から最初の prompt-close-all package へ移った後は、旧
auto-update package を production rollback 先にしない。旧 Service Worker は再び
`skipWaiting` できるためである。PWA incident は事前検証済みの prompt-close-all
containment package へ fix-forward し、その後に通常の観測をやり直す。

### 6.6 Local CSS と CSP

Tailwind は compatibility major 3 を exact pin し、Tailwind 4 migration は行わない。

- `tailwind.config.*`、`postcss.config.*`、`src/styles/tailwind.css` を build input に
  する。
- inline Tailwind config と CDN script を削除する。
- inline global style を `src/styles/global.css` へ移す。
- theme prepaint は external same-origin script とし、外部 importや global export を
  持たず、検証済み theme class と `color-scheme` だけを変更する。
- viewport/load 処理も module または external script へ移し、user zoom 制限を
  削除する。
- persisted color は parser で許可形式へ normalize し、無効値を style へ渡さない。
- data URL background は local asset または CSS class へ置換する。

初回 CSP は `Content-Security-Policy-Report-Only` で開始する。最低 policy は次を
含む。

```text
default-src 'self';
base-uri 'none';
object-src 'none';
frame-ancestors 'none';
script-src 'self';
worker-src 'self';
style-src-elem 'self';
style-src-attr 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
manifest-src 'self';
connect-src 'self';
```

`config/csp-policy.json` を directive/value の正本にし、header serializer が semicolon
区切りの一行へ変換する。`connect-src` の初期値は `'self'` とし、Google Sheets の
production-like fixture で観測した `docs.google.com` と実 redirect origin だけを追加する。
browser-side Supabase request が entry graph と production trace の両方で確認されない
限り Supabase origin は追加しない。

`style-src-attr 'unsafe-inline'` は 101 箇所の current sink を inventory した期限付き
例外であり、新規 sink は禁止する。first-party の inline script、inline event
handler、eval 相当 sink は 0 にする。

vendor bundle の単なる文字列 scan は informational とする。ExcelJS flow を strict
CSP 下で実行して violation が発生する場合は、dependency patch、置換、または該当
code path の除去を行う。`'unsafe-eval'` を production policy に追加して通過させない。

Tailwind runtime route を削除した後、既存 `tailwind-cache` と
`workbox-expiration` metadata は新規 write 0 の inert residue として記録し、
browser eviction に任せる。PWA update と結び付けた破壊的 cleanup は行わない。

### 6.7 XLSX execution port

公開 port と Worker wire protocol を分離する。

```ts
type XlsxExecutionPort = {
  previewMap(file: File, signal: AbortSignal): Promise<MapPreview>;
  importMap(file: File, signal: AbortSignal): Promise<MapImportResult>;
  importEvent(file: File, signal: AbortSignal): Promise<EventImportResult>;
  exportEvent(
    snapshot: ExportSnapshot,
    requestedAtIso: string,
    signal: AbortSignal,
  ): Promise<{ blob: Blob; suggestedFileName: string }>;
};
```

caller は domain input だけを渡す。provider が internal `requestId`、wire
`schemaVersion`、length、operation を付与する。UI と domain code は Worker message
shape を参照しない。

最初の Worker は whole `ArrayBuffer` を Transferable として受け、import result DTO
または export `ArrayBuffer` を返す。cancel と timeout は provider が Worker を
terminate し、次回用 Worker を再生成する方法で実装する。error は
`code`、`operation`、安全な message に normalize し、stack と file content を UI
へ返さない。

次を先に分離して ExcelJS の static edge を切る。

- `src/xlsx/domain/types.ts`
- `src/xlsx/domain/itemNumber.ts`
- `src/xlsx/domain/exportSnapshot.ts`
- `src/xlsx/domain/exportFileName.ts`
- `src/xlsx/download/downloadBlob.ts`
- `src/xlsx/port/XlsxExecutionPort.ts`
- `src/xlsx/provider/createXlsxExecutionPort.ts`
- `src/xlsx/adapters/mainThreadXlsxAdapter.ts`
- `src/xlsx/adapters/workerXlsxAdapter.ts`
- `src/xlsx/worker/protocol.ts`

adapter 選択は compile-time flag と dynamic import で行い、未選択 adapter を initial
graph から dead-code eliminate できる形にする。main-thread fallback も初回 XLSX
操作まで lazy load する。Phase 0B の Rolldown chunk policy は旧 utility path を参照せず、
新しい dynamic entry の natural split で十分なら明示 rule を削除し、不十分な場合だけ
`build.rolldownOptions.output.codeSplitting` で固定する。どちらも chunk golden で検証する。
`xlsx-main` containment は runtime error 後の自動再実行ではなく、同じ source から別
`variantId` で事前生成した package とする。

map preview の signature cache と latest-wins semantics は維持する。export は一回の
`requestedAtIso` を workbook `created`、`modified`、export metadata、filename の日付に
使用する。caller は export command 開始時に一度だけ timestamp を作り、adapter は pure
filename builder で `suggestedFileName` を返す。download helper は新しい時刻を取得せず
その名前を使用する。これは非決定的な複数 timestamp を一つにする意図的な contract
修正であり、golden test で固定する。

file size と ZIP/XML resource limit は public port invariant とし、両 adapter で同じ
error code を返す。page/provider は `File.arrayBuffer()` の前に `file.size` 上限を
検査する。Worker adapter は XLSX Worker 内、main-thread adapter は lazy load した
shared `preflightXlsx` を main thread 上で cooperative に実行し、ExcelJS の前に完了する。
preflight は ZIP central directory を読み、compressed size、declared uncompressed
size、entry count、ratio を検査する。その後、bounded streaming inflate と SAX scan で
worksheet、row、cell、shared string を数え、上限到達時点で停止する。この preflight は
Worker IPC streaming とは別責務である。

export は snapshot 作成時に event、day、item、cell、estimated string byte の上限を
検査し、上限外 snapshot を clone または Worker へ送らない。import/export の両上限を
同じ config schema の別 operation として管理する。

preflight には `@zip.js/zip.js` `2.8.34` と `saxes` `6.0.0` を exact direct runtime
dependency として使用し、transitive dependency を直接 import しない。上限値は
production sample と attack fixture の計測後に `config/xlsx-limits.json` へ固定する。
encrypted entry、duplicate/case-colliding path、path traversal、DTD/entity declaration、
limit 外の ZIP64 size を ExcelJS 前に拒否する。inflate は entry ごとと request 全体の
残り budget と operation deadline を共有する。page の `AbortSignal` が abort した場合、
Worker adapter は Worker を terminate する。main-thread adapter の scan は同じ signal
を各 chunk で確認し、event loop へ定期的に yield する。

streaming は whole-buffer 実装の clone time、peak memory、cancel latency が budget を
超えた場合だけ別 phase で導入する。その場合も arbitrary JSON fragment は使用せず、
各 frame が独立 decode 可能な NDJSON または CBOR とし、ACK/backpressure と end-to-end
digest は個別 ADR で定義する。

### 6.8 Navigation、list、App

`ActiveTab | string` を renderer 間で共有せず、current data identity である event name
と event date を使い、実在する surface を列挙した discriminated `ScreenState` と
command に置き換える。この phase で event ID や list ID を新設しない。

```ts
type NavigationCommand =
  | { type: "show-event-list" }
  | { type: "show-import" }
  | { type: "show-event-date"; eventName: string; eventDate: string }
  | {
      type: "show-map";
      eventName: string;
      eventDate: string;
      mapTabName: string;
    };
```

`ScreenState` は `event-list`、`import`、`event-date`、`map` の同じ discriminant と
current identity を持つ。command boundary は event name の存在、event date の存在、
date と map tab の対応を検証し、open-ended な surface `string` は許可しない。map
import 完了時は `show-map` command 一つで event、date、map tab、map visibility を
同時に確定する。

この screen state は browser history と、SpaceNavigator の session-only LIFO return
history を所有しない。Phase 5 は既存 browser navigation semantics を変更せず、
SpaceNavigator は現在の独立 history contract を維持する。

list は次の ownership にする。

```text
ShoppingList facade
  ├─ useShoppingListController
  ├─ buildListRows
  └─ renderer
       ├─ FullShoppingListRenderer
       └─ VirtualShoppingListRenderer
```

facade が controller を一つだけ所有し、両 renderer は同じ immutable rows、commands、
selection、focus descriptor を受ける。dialog、bulk operation、grouping、drag mutation、
highlight の business rule を renderer に複製しない。

`ListViewportPort` は App、Overlay、navigator、search からの reveal、focus、scroll
request を受ける。最初は full renderer の adapter だけを実装し、DOM query を port
の内側へ閉じ込める。

virtual renderer の初回 eligible 条件は 100% zoom、単一 column、非 drag、非 edit と
する。variable height は `ResizeObserver` で測定し、focus row と操作中 row は pin
する。15% から 150% の CSS scale、二列、touch drag、autoscroll は prototype の実測と
behavior test が揃うまで full renderer を使う。unsupported state への切替は
selection、focus、scroll anchor を維持する。

renderer は active pointer/keyboard gesture 中に切り替えない。virtual renderer の
drag handle は最初の pointerdown を drag 開始に使わず、full renderer への切替、
viewport ready、同じ item の handle への focus 復元までを行う。drag は次の gesture
から開始する。edit command は stable item identity を保持し、full renderer ready 後に
dialog を開く。active drag target を renderer 間で移送する contract は作らない。

`App.tsx` は既存 `AppHeaderShell`、`AppMainContent`、`AppOverlayLayer` を作り直さず、
state transition、command、read model を順に抽出する。component から
`src/utils/indexedDB.ts` への deep import は `PersistenceCommandPort` へ集約する。
Phase 6 は `legacyIndexedDbPersistenceCommandAdapter.ts` が current implementation を
wrap し、`createAppServices.ts` だけが port binding を所有する。Phase 7 は同じ composition
で binding を `indexedDbPersistenceCommandAdapter.ts` と new persistence facade へ
交換する。

### 6.9 IndexedDB

初回分割は schema migration を伴わない。public export と semantics は
`src/utils/indexedDB.ts` の compatibility facade で維持し、内部を次へ分ける。

```text
src/persistence/
  db/
    constants.ts
    openDatabase.ts
    transactionCoordinator.ts
  repositories/
    eventRepository.ts
    mapRepository.ts
    settingsRepository.ts
    syncQueueRepository.ts
    controlRepository.ts
  migration/
    legacyMigration.ts
    legacyCleanupAdapter.ts
  recovery/
    checkpoint.ts
    recoveryAdoption.ts
  adapters/
    indexedDbPersistenceCommandAdapter.ts
  facade/
    indexedDbPersistence.ts
```

`syncQueue` の分類は key-first で行う。

1. exact key `data` は queue payload として既存 value validation を行う。
2. 既知の `__esp_internal__:` key は key ごとの schema guard を通った場合だけ
   `controlRepository` が読む。
3. unknown または future internal key は value を解釈せず opaque に保持し、queue API
   に公開せず、通常 cleanup の削除対象にしない。存在は non-blocking evidence にできる。
4. 既知 internal key がその既知 schema guard に失敗した場合だけ fail-closed error と
   evidence の対象にする。

`transactionCoordinator` は payload と metadata/checkpoint の compare-and-swap、map
split、migration journal、recovery adoption、atomic restore を含む全 cross-store
transaction を所有する。

- transaction open 時に store set を固定する。
- digest、serialization、crypto などの非 IDB 非同期処理は transaction 前に完了する。
- active transaction 内で unrelated Promise を await しない。
- abort、quota、blocked、`versionchange` を typed result へ normalize する。

current v5、forward v6/v7、missing store、incompatible store、blocked open、
`versionchange` close、reopen を integration test する。分割完了まで DB version と
store set を変更しない。

## 7. 品質 command と CI ownership

### 7.1 Command

| command            | 内容                                                            | 外部状態               |
| ------------------ | --------------------------------------------------------------- | ---------------------- |
| `quality:local`    | typecheck、lint delta、format check、encoding、unit/integration | 変更しない             |
| `quality:browser`  | production-like server、Playwright、a11y、CSP report            | local fixture のみ     |
| `quality:artifact` | clean build、manifest、archive、package verification            | local output のみ      |
| `quality:db-local` | disposable DB migration、privilege、retention test              | disposable local DB    |
| `pwa:agent:build`  | policy 非依存 single-entry build、path/hash 出力                | local temp output のみ |
| `quality:pr`       | local、browser、artifact、audit、architecture、coverage         | CI artifact のみ       |
| protected deploy   | remote DB、Release State、candidate deploy、promotion、rollback | 承認済み workflow のみ |

`quality:local` に remote DB、Release State、deployment、alias、promotion、rollback を
含めない。

### 7.2 Test project

Vitest project は file extension だけで分類しない。

- unit node
- web-platform node
- DOM/jsdom
- Worker
- tooling/API node

各 project は排他的な include/exclude と専用 setup を持つ。既存 `.test.ts` の jsdom
annotation は `config/test-project-membership.json` の transitional entry に列挙し、
test enumerator が全 test file を正確に一つの project へ割り当てることを検査する。
DOM 用 jest-dom、RTL、`ResizeObserver` setup を node test へ漏らさない。

Playwright は Chromium、Firefox、WebKit の主要 UI flow を扱う。Service Worker と
controlled standalone の gate は Chromium を正本にし、actual installed PWA は
実機または self-hosted runner の別 evidence にする。

### 7.3 Lint、coverage、architecture

lint baseline は warning の identity と location を分ける。stable content ID は
`ruleId`、normalized message、AST node kind、AST subtree/context hash から作る。
location は normalized path と同一 content ID の occurrence index を持ち、line number は
表示情報だけにする。

- 新規 file は warning 0。
- 既存 file は baseline 外 warning 0。
- 大規模な抽出前に対象 file の warning を behavior test 付き lint-prep PR で 0 に
  する。
- baseline warning を別 path へ移す場合は old/new location mapping を必須にし、stable
  content ID の一致を検証する。mapping のない path 変更を自動的に既存 debt とみなさず、
  新しい suppression comment を許可しない。

coverage gate は merge base の base SHA を記録し、rename を追跡する。changed line と
changed branch の intersection を検査し、generated file、type-only file、fixture の
除外を `config/coverage-policy.json` へ列挙する。changed executable lines/functions は
90% 以上、changed branches は 85% 以上を最低値とし、phase ごとの critical path は
policy でより高い値を設定できる。phase ごとの path scope を持ち、repository 全体の率で
変更箇所の未検証を隠さない。

`scripts/verify-test-contracts.mjs` は test AST と file access を検査する。
`App.mapImportFlow.integration.test.tsx` は Phase 5A、残る
`App.eventUpdateSourceCommit.integration.test.tsx`、
`App.executeModeItemsCommit.integration.test.tsx`、`App.movePlan.integration.test.ts` は
Phase 6 で observable behavior test へ置換する。Release tooling が artifact text を
検証する test は別 allowlist とし、app handler の source 文字列検査と混同しない。

architecture gate は TypeScript compiler API の resolved import graph と AST を使う。
source text 検索だけで import alias、re-export、dynamic import を判定しない。最低限、
次を検査する。

- UI から XLSX Worker wire への import 0
- UI から `src/utils/indexedDB.ts` への新規 deep import 0
- renderer から persistence repository への import 0
- full/virtual renderer 内の domain mutation 0
- initial app graph から未選択 XLSX adapter と ExcelJS への edge 0
- browser bundle から service role key と protected environment name の値 0

既存 violation は rule、resolved importer/importee、AST context hash を
`config/architecture-baseline.json` に記録し、新規 violation を拒否する。各 phase の
exit で対象 entry を削除し、`P8-CLEAN` では baseline 自体を削除する。

### 7.4 Security と performance

audit は total count だけで失敗させず、advisory ID、production reachability、owner、
mitigation、expiry を持つ `config/audit-waivers.json` と比較する。新規 critical/high、
期限切れ waiver、到達可能で mitigation のない production critical/high を拒否する。

performance baseline は Phase 0 の同一 machine profile で 5 回以上測り、中央値、
p95、peak heap、long task、bundle byte を `config/performance-budgets.json` へ保存する。
絶対 budget は baseline capture PR で確定し、以後の plan 文面に測定前の値を
書き込まない。

対象 scenario は次とする。

- cold/warm startup
- 10,000 item の full list scroll、search、selection
- eligible 条件の virtual list scroll
- representative XLSX preview、import、export
- 破損、oversize、ZIP bomb fixture の拒否
- IndexedDB restore、cleanup、recovery adoption

## 8. 実装 phase

phase は順番どおりに行う。後続 phase の prototype は feature branch で作成できるが、
production promotion は直前 phase の gate を飛ばさない。

各「合格条件」は機能・品質条件に加えて、§9.2 の production assignment、observation、
`release-accepted`、terminal fragment、pending operation/acceptance と standard recovery
context がすべてないことの確認まで含む。recovery ladder の各 step は policy 固有 gate で
受理し、context を clear するまで次の named phase gate を完了しない。
pre-production gate の `P0-BASELINE`、`P0-TOOLCHAIN`、`P0-ARTIFACT`、`P0-DATA`、
`P0-PROMOTE` と、provider state を変えないと明記した change だけは release acceptance を
要求しない。

### Phase 0A: Baseline 固定

実装:

1. clean source checkout で source SHA、Git status、Node/npm、lockfile hash、top-level
   package、encoding/EOL、test、lint、audit、build output を採取する。
2. capture tool が別 checkout にある場合は tool source SHA、schema hash、runtime、
   artifact URI/hash も evidence に入れる。
3. `config/foundation-baseline.json`、
   `config/lint-warning-baseline.json`、
   `config/encoding-policy.json` を作成する。
4. `main` の auto production promotion を無効または承認制にする。

合格条件 `P0-BASELINE`:

- baseline の source directory が clean である。
- 1,198 tests、0 errors/130 warnings、encoding、Release A build の再現結果が source
  SHA と結び付いている。
- artifact byte 数は environment と file hash を伴い、単独の手入力値ではない。
- production promotion が protected workflow 以外から実行できない。

### Phase 0B: Toolchain、依存関係、command graph

互換 cluster ごとに独立 PR で更新する。初期 target は次とし、merge 時点で registry と
provider の存在、peer dependency を再確認して `config/toolchain-versions.json` に exact
version を固定する。

| cluster   | target                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------- |
| runtime   | Node `24.19.0`、npm `11.19.0`、`@types/node` `24.13.3`                                                    |
| PWA       | `vite-plugin-pwa` `1.3.0`、`@vite-pwa/assets-generator` `1.0.2`、Workbox modules `7.4.1`                  |
| Vite/test | `vite` `8.2.0`、`@vitejs/plugin-react` `6.0.5`、`vitest`/`@vitest/coverage-v8` `4.1.10`、`jsdom` `30.0.1` |
| lint      | `eslint` `9.39.5`、`typescript-eslint` `8.66.0`、`eslint-plugin-react-hooks` `7.1.1`                      |
| browser   | `@playwright/test` `1.62.1`、`@axe-core/playwright` `4.12.1`                                              |
| CSS       | `tailwindcss` `3.4.19`、`postcss` `8.5.25`、`autoprefixer` `10.5.4`                                       |
| XLSX scan | `@zip.js/zip.js` `2.8.34`、`saxes` `6.0.0`                                                                |
| list      | `@tanstack/react-virtual` `3.14.9`                                                                        |
| artifact  | `canonicalize` `3.0.0`                                                                                    |
| provider  | `vercel` `58.5.1`、`supabase` `2.111.0`                                                                   |

runtime、PWA、Vite/test、lint は Phase 0B、browser は Phase 0C、CSS は Phase 2 で
導入する。XLSX scan は Phase 3C、list は Phase 5C で初めて導入する。provider CLI は
application dependency にせず、Phase 0C の protected tooling environment で exact
version を使用する。artifact tooling の `canonicalize` は Phase 0C の exact direct
devDependency とし、browser entry graph に含めず RFC 8785 test vector で固定する。

Node `24.19.0` と npm `11.19.0` は canonical build/test tool の exact version である。
`package.json` engine と provider project は Vercel が保証する `24.x` family に固定し、
patch 一致を provider contract として要求しない。protected deployment smoke は実際の
function `process.version` を secret を含まない log/evidence に記録し、major 24 と
`providerSettingsHash` を照合する。

Phase 1 の custom Worker が直接 import する `workbox-precaching`、
`workbox-routing`、`workbox-strategies`、`workbox-expiration` はすべて `7.4.1` の exact
direct devDependency にする。transitive Workbox module を直接 import しない。

React/ReactDOM `18.3.1`、TypeScript `5.9.3`、ExcelJS `4.4.0` はこの phase で
変更しない。top-level dependency は exact pin、lockfile は install graph の正本とする。

実装順:

1. 現在の `tsc && vite build` をそのまま `build:_vite` へ移す。この phase ではまだ
   release policy を build input にしない。
2. 同じ commit で `build:release-a` から `npm run build` 呼出しを除去する。
3. `build:release-a -> build:_vite -> verifier` を作る。
4. 最後に `build -> build:release-a` の互換 alias を作る。
5. Vitest project、ESLint flat config、explicit `build.target: "es2020"` を移行する。
6. Vite 8 PR では object 形式 `build.rollupOptions.output.manualChunks` を削除し、natural
   dynamic split または `build.rolldownOptions.output.codeSplitting` へ移す。
   `build.minify: "esbuild"` も削除して Oxc/Lightning CSS を正本とし、chunk、CJS interop、
   minified behavior、JS/CSS bytes の golden/delta を検証する。
7. `loadEnv` の空 prefix を廃止し、public build environment の allowlist と protected
   runtime environment の bundle 非混入 test を追加する。
8. strict peer install と `npm ls` を各 cluster で実行する。

合格条件 `P0-TOOLCHAIN`:

- command graph に cycle がない。
- canonical standard path の exact runtime と provider runtime family が一致する。P0
  bootstrap baseline の application-build Node 20/provider runtime 24 分離は
  `P0-PROMOTE` で別に検証する。
- typecheck、全 test、build、encoding、peer check が成功する。
- lint baseline 外 warning が 0。
- Vite 5 baseline と比較して意図しない browser target、chunk、CJS semantics、minified
  behavior、PWA route、capability 差分がない。
- audit に未管理の reachable critical/high がない。

### Phase 0C: Browser、artifact、provider、API

実装:

1. deterministic browser fixture と Playwright project を追加する。
2. `artifact:create`、manifest/archive verifier、`ProviderDeploymentEvidence` generator/
   verifier を追加する。
3. `config/release-variants.json` に static dimension schema、allowed transition、
   compatibility predicate、variant ID canonicalization、companion 変換規則、
   recovery ladder、P0 bootstrap exception、gate/minimum observation/clock-skew、policy
   version/hash rule を定義する。初期 policy の `outerRecoveryAgent` は null とし、
   Phase 1 でだけ non-null v1 へ進められる compatibility rule も schema に含める。
4. 初期 policy 作成後に `build:_vite` を
   `tsc && node scripts/build-release-vite.mjs` へ切り替える。orchestrator は P0 の
   `outerRecoveryAgent: null` を検証して agent input なしの Vite build を呼び、Phase 1 の
   non-null branch はまだ実行しない。
5. `config/release-state.schema.json`、state verifier、protected store adapter、
   deterministic reducer、legacy bootstrap identity、transition kind/recovery context を
   含む event-specific fixture を追加する。
6. Vercel prebuilt candidate、smoke、promote、instant rollback、saved package redeploy
   を別々の protected workflow command にする。
7. QA alias drill と production incident command を別 script にする。
8. `/api` rewrite、cache header、HTML/capability/stable-versioned release identity、
   metrics API の dedicated-only credential resolver、provider/project ref binding、
   timeout、redirect、body limit を実装する。generic credential resolver は削除する。
9. current release browser verifier から ambient browser 探索を外し、Playwright
   executable と version を固定する。
10. disposable QA project の production alias で prebuilt deploy、assignment、
    rollback/redeploy の drill を行い、実 production project/domain は変更しない。
11. bootstrap staging generator/verifier と fixed disabled metrics adapter template を
    追加し、exact allowlist、dependency 0、no-op install/build、target route/header、
    Node 24 Function、dist hash 不変、`tsc`/Vite 非実行を fixture と child-process trace で
    固定する。template の import/environment/body-read/network 0、405/503/no-store、
    mode/hash の全層一致も検証する。policy の closure 混入、bootstrap-input の
    self-hash/self-list、旧 baseline API copy を rejection fixture にする。

合格条件 `P0-ARTIFACT`:

- canonical build は dirty/untracked input と source checkout 内 output を拒否する。
- 同じ input から manifest file list と `artifactManifestHash` が再現する。
- outer package が固定三 file だけを持ち、index が manifest/archive を束縛し、archive の
  全展開 file が manifest と双方向一致する。
- deploy command は検証済み archive から展開した `.vercel/output` だけを入力にする。
- QA deployment の全 `PublicResponseRecord`、source、variant、policy、provider project と、
  provider が返した deployment ID が `ProviderDeploymentEvidence` に一致する。
- QA evidence は `deploymentRole: "qa"` で、Release State binding/inventory に入らない。
- QA deployment の `/api`、SPA deep link、offline startup、Release A API が期待どおり。
- QA assignment drill は同一 deployment を rebuild せず disposable alias へ切り替える。
- rollback rehearsal は保存済み deployment/package を使い、source rebuild を
  行わない。
- bootstrap staging は allowlist 外 file と dependency/build script を拒否し、app-build
  Node 20 の raw dist から identity/meta/new identity file 以外を変えず、`sw.js` と既存
  asset hash を維持する。旧 metrics API source は staging に入れず、policy hash に固定した
  disabled adapter だけを配置する。canonical staged dist を再変更せず
  provider-build/runtime Node 24 の prebuilt output、SPA/API/header、mode 別 semantic
  fixture を再現する。
- static variant policy は accepted floor を含まず、Release State fixture は policy hash
  mismatch、variant dimension/hash mismatch、metrics mode/component hash mismatch、
  runtime environment presence mismatch、policy relaxation、broken previous hash、
  deployment/package/companion-pair mismatch、transition kind mismatch、未許可
  cross-source pair、legacy bootstrap identity/hash mismatch、recovery context
  初期値不一致/上書き/step skip、deferred floor の欠落/重複/早期適用、downward floor、
  inventory entry の欠落/再有効化を拒否する。
- disposable Release State store の atomic compare-and-append、concurrency、二重 intent、
  異 binding assignment、observation 中の二重 normal promotion、required safety event の
  飛越し、abort、provider 成功後 reconciliation、normal/containment smoke failure と
  recovery、append ID/bytes conflict、response loss、retention、stale-pointer/replay
  rejection が成功する。
- authoritative `committedAt` より前の observation、minimum hours 未満、clock-skew policy
  超過の final core を拒否する。
- `quality:local` は外部状態を変更しない。

### Phase 0D: DB hardening と evidence verifier

実装:

1. disposable local DB で forward migration、privilege、retention、concurrency を
   検証する。
2. production fingerprint と backup/restore rehearsal を取得する。
3. forward migration を二者承認で適用する。
4. API-only insert、bounded aggregate、raw select rejection、retention dry-run を
   protected integration fixture で確認する。
5. provider production environment の name inventory と metrics API 以外からの参照 0 を
   確認し、generic 3 names を削除する。dedicated pair、allowed origin、expected Supabase
   project ref/provider project ID と system environment exposure を設定し、secret value を
   evidence に残さず name/presence と provider audit event だけを保存する。
6. evidence bundle verifier の `pre-promotion` と `final` mode、fragment chain verifier、
   approval fixture を追加する。

合格条件 `P0-DATA`:

- migration checksum と remote schema/privilege が一致する。
- `service_role` の raw table/view `SELECT` が拒否され、metrics insert は成功する。
- production environment は dedicated/system required names を持ち、generic 3 names を
  持たない。新規 source-hardened deployment は expected Supabase/provider project identity
  と runtime presence policy を満たす。
- local persistence は metrics endpoint の timeout、403、413、429、5xx、offline の
  影響を受けない。
- v1 verifier は未変更で既存 valid fixture に成功し、`PENDING` template を final
  evidence として受理しない。
- bundle verifier の pre-promotion 二者承認と final 三者承認が test fixture で別 gate
  として検証される。

### Phase 0E: Release A candidate、promotion、final evidence

実装:

1. external Release State が未初期化の場合だけ、current production/provider/DB
   evidence、`LegacyBootstrapPublicIdentity` hash、二者承認から `state-bootstrap` event を
   一度作る。完全 binding のない existing deployment は rollback inventory に入れない。
2. foundation 変更前の監査済み
   `bootstrapBaselineSourceSha: 8178b53a56fcaec8dbe640bad9c721b6ded650e2` を clean
   checkout し、baseline の Node `20.20.0`、npm `10.8.2`、Vite `5.4.21` と lockfile で
   app build する。`scripts/build-release-artifact.mjs --bootstrap-baseline` は検証済み
   `dist` を §6.1 の exact allowlist だけを持つ隔離 staging project へ copy し、
   variant release identity、control sidecar、provider packaging 専用
   `engines.node: "24.x"` と fixed disabled metrics adapter だけを決定的に付与する。
   app/Service Worker source は変更せず、旧 API source は含めない。Node `24.19.0` と
   Vercel CLI `58.5.1` に Build Output API を生成させ、手書きしない。
   application-build Node 20 と provider-build/runtime Node 24、wrapper closure hash、
   adapter mode/source hash、許可 file list、全 output diff、mode 別 API semantic fixture を
   evidence に残し、
   `releaseRole: "containment"` の一回限りの bootstrap baseline package として保存する。
3. `P0-ARTIFACT` と `P0-DATA` を満たす Phase 0 clean source から
   `releaseRole: "standard"` の production-target package を生成する。standard と
   bootstrap baseline は current static policy の exact bootstrap exception、同じ provider
   project、minimum safety floor、DB contract を満たすが、source/variant/artifact/package/
   deployment は意図的に別 identity とする。
4. standard を `candidate`、bootstrap baseline を `companion-candidate` として
   `--skip-domain` deploy し、両方の public asset identity、route、SPA、offline、
   controlled standalone を検証する。standard metrics は dedicated insert、bootstrap
   metrics は no-network 405/503/no-store を期待値にする。
5. standard candidate URL で actual installed PWA trace を取得し、companion URL は
   controlled recovery trace を取得する。
6. disposable QA project で standard の startup または source-hardened metrics fixture を
   意図的に失敗させ、保存済み bootstrap baseline の package redeploy、identity 検証、
   local startup/persistence/offline recovery と明示的な metrics 503 が成功することを drill
   する。production domain/state は変更しない。
7. 両 artifact/provider evidence/trace、exact bootstrap exception、static policy、DB
   snapshot、failure/recovery drill、fragment chain、current Release State、二者承認を
   `pre-promotion` bundle verifier で検証する。

合格条件 `P0-PROMOTE`:

- 各 standard/bootstrap binding の内部で source、variant dimensions/ID、policy、artifact、
  package、deployment、metrics API mode、public identity が exact 一致する。
- pair は provider project、policy、minimum safety floor、DB contract が一致する一方、
  policy に固定した P0 exception に従って source/variant/artifact/package/deployment が
  distinct である。
- standard と bootstrap baseline はともに provider build/runtime `24.x` で
  deploy/inspect/smoke が成功し、baseline だけ application build が監査済み Node
  `20.20.0`/npm `10.8.2` である。
- standard candidate の installed/controlled trace と dedicated metrics insert が成功する。
  bootstrap candidate は template hash が policy と一致し、405/503/no-store、credential/
  environment read 0、network call 0 を証明する。
- disposable QA の独立 failure/recovery drill が bootstrap baseline による local
  startup/persistence/offline 回復と metrics の安全な明示的無効化を証明する。
- current Release State chain が有効で、artifact の `releasePolicyHash` が current static
  policy と一致し、その policy が proposed transition を許可する。
- pre-promotion bundle が Release と Data Safety の異なる 2 名で承認される。
- production promotion command の入力が、この candidate deployment ID に固定される。
- bootstrap baseline は current minimum safety/DB contract を満たし、assignment 直後から
  `package-redeploy` recovery source として使える。

`P0-PROMOTE` 後:

1. pre-promotion bundle を参照する `production-change-intent` event を
   `mode: "normal-promotion"`、`transitionKind: "standard-rollout"`、proposed bootstrap
   companion 付きで append する。
2. candidate と同じ deployment を production domain へ promote する。
3. provider assignment を再取得し、production role の evidence/binding を作って同じ
   operation ID の `production-assigned` event を append する。append 結果が不明なら
   provider inspect 後に `production-change-reconciled` を idempotent に append する。
4. post-promotion smoke と installed PWA trace を取得し、
   `production-validation-passed` event を append して observation anchor を確定する。
5. 24 時間 observation を行い、metrics、persistence、startup、cleanup、offline、
   rollback readiness を確認する。
6. v1 template から完成済み evidence JSON を作り、既存 v1 verifier を実行する。
7. production trace、observation、v1、pre-promotion hash、三者承認から final evidence
   core を完成、検証する。
8. core hash を参照する `release-accepted` event を append し、その
   `releaseStateHash` を terminal fragment に記録して bundle verifier を完了する。この
   acceptance で cross-source pair の新規作成を閉じ、bootstrap baseline は次の same-source
   companion acceptance または floor incompatibility まで既存 recovery source としてだけ
   維持する。

合格条件 `P0-RELEASE`:

- promoted deployment ID は candidate と同一で、post-promotion identity が一致する。
- completed v1 JSON と final bundle が成功する。
- final evidence は Release、Data Safety、Operations の異なる 3 名が承認する。
- promoted standard の metrics API は `source-hardened` mode で dedicated credential pair
  だけを使用し、generic 3 names が存在しない。accepted bootstrap companion は exact
  `bootstrap-disabled-safe-adapter-v1` であり、credential/environment/network access 0 の
  503 contract を維持する。
- 24 時間 observation に即時停止条件がない。
- external Release State の active/accepted production、accepted hard floor、static
  policy、rollback inventory が promoted deployment/package binding と一致し、pending
  operation/acceptance がない。
- accepted standard と bootstrap baseline の inventory pair があり、action eligibility を
  再導出できる。
- この gate 完了まで Phase 1 production promotion を行わない。

### Phase 1: Prompt-close-all PWA

#### Phase 1A: QA parity

1. `vite.config.ts`、`index.html` entry、outer recovery agent、両 role bootstrap、
   Service Worker、`package.json` の `pwa:agent:build` command、agent builder、
   Release A build verifier、次 policy version を一つの atomic source change として実装する。
   outer agent の source/isolated build は release identity、role、variant、policy hash を
   一切入力にしない。
2. clean checkout の exact toolchain で `pwa:agent:build` を独立 temporary directoryへ
   二回実行し、同じ
   content-hashed path/bytes/SHA-256 を得る。その値を
   `config/release-variants.json` の `outerRecoveryAgent` に固定して clean commit とし、
   protected job が再 build して一致を確認する。agent-only output は deploy/package/
   `DeploymentBinding` に使わない verification intermediate とする。
3. current external Release State に pending operation/acceptance と recovery context がない
   ことを確認し、P0 active/accepted/companion/inventory と既存 floor/DB contract を変えず、
   legacy binding の既存 eligibility を拡大も失効もしない old/new policy compatibility diff
   を検証する。Release と PWA owner の二者承認後、agent hash を持つ new immutable policy
   URI/hash の `static-policy-activated` event を append する。
4. 以後の standard/containment QA/candidate artifact は active になった exact policy hash
   からだけ build し、activation event/hash を evidence に含める。source policy と external
   active policy が異なる build は拒否する。
5. `injectManifest` の最小 `src/sw.ts`、identity protocol、Workbox route を実装する。
6. outer agent を両 variant で同一 bytes/path にし、registration、update、identity
   challenge、separate recovery root、validated runtime role import を実装する。agent から
   React/App/IDB/metrics/role module への静的 edge を禁止する。
7. containment 専用の bootstrap/app entry/read-only UI bridge/Service Worker graph を別
   module として実装し、standard PWA module への import を architecture rule で禁止する。
8. `registerType: "prompt"`、`injectRegister: false` とし、generateSW 用の
   `skipWaiting`/`clientsClaim` option を削除する。
9. outer agent が update check を開始して active identity gate を通した後にだけ、選択済み
   `src/bootstrap.ts` または containment bootstrap を runtime import する。
10. `tsconfig.worker.json` と app/worker の排他的 include/exclude を追加し、root
    typecheck で app、node、standard/containment Service Worker を検査する。
11. prompt を表示しない状態で standard/containment 両方の install、precache、navigation、
    offline、capability parity を QA で確認する。
12. target build verifier が `registerSW.js` の欠落を正常とし、exact 一つの agent/role
    entry、agent policy hash、stable/versioned identity、manifest、`sw.js` を検証する fixture
    を追加する。
13. 両 Service Worker route から `/api` を明示的に除外する test を追加する。
14. 両 variant の generated `sw.js` に `self.skipWaiting()`、`clientsClaim()`、
    `SKIP_WAITING` handler がないことを AST/artifact test で固定する。
15. stable/versioned identity が precache manifest に入らず、identity request が
    NetworkOnly、outer agent が両 precache に同じ revision で入る artifact/browser test を
    追加する。
16. active と waiting Worker の両方に nonce challenge を行い、waiting/stable/versioned
    identity の改ざん、stale response、redirect、offline、timeout を fail-closed にする。
17. waiting Worker へ adversarial `SKIP_WAITING` message を送っても waiting state と
    active controller が変わらない browser test を追加する。
18. role bootstrap/App chunk の load/evaluation を失敗させても outer agent が
    registration/update check と recovery message を維持する test を追加する。
19. 同一 stable QA origin に unfaulted standard の actual controlled profile を作り、
    role bootstrap、role-local UI bridge、Worker evaluation、identity response の fault を
    一つずつ割り当てた後、同じ source の containment package を同じ originへ promote する。
    containment install/waiting、open-client controller 不変、全 client close、次回 reopen の
    natural activation、full startup/API/offline/persistence を各 case で検証する。
20. fault artifact が agent bytes/reference/precache を変更できず、production
    binding/inventory に入らない rejection fixture も実行する。

#### Phase 1B: UI と blocker

1. waiting state、更新案内、blocker registry、beforeunload を実装する。
2. map import、event import、export、persistence、dialog draft を実在する lifecycle に
   結び付ける。
3. two-tab、three-tab、offline、background/foreground、crash/reopen を検証する。
4. role UI bridge が `register()`、`update()`、Worker challenge、`SKIP_WAITING`、reload、
   cache delete を呼ばず、outer agent の read-only snapshot だけを参照する architecture
   test を追加する。

#### Phase 1C: Production floor

1. current auto-update production から一回だけ prompt-close-all candidate へ移行する。
2. candidate が既に waiting の profile では、old tab が操作中でも controller が
   変わらず、全 tab を閉じて再起動した後だけ新 version になることを確認する。
3. dormant profile で candidate が未検出の場合は、最初の reopen が旧 version のまま
   candidate を install/waiting にする。legacy shell は新 prompt UI を持たないため prompt
   表示を要件にせず、その client が通常操作を終えて閉じた後の次の reopen でだけ activation
   し、そこで初めて outer agent と prompt UI を持つ shellになる二段 lifecycle を確認する。
4. agent をまだ持たない P0 legacy-controlled dormant profile では、faulted Phase 1
   standard Worker evaluation が install を拒否された後に同じ stable QA originを保存済み
   containment へ切り替える cutover drill も行う。旧 legacy registration が次の reopen で
   containment を発見して waiting にし、全 client close と次回 reopen だけで natural
   activation し、agent-bearing containment shell に到達することを確認する。unregister、
   cache delete、programmatic reload は使わない。
5. actual installed PWA と controlled standalone の両 evidence を取得する。
6. 独立 compile-time PWA graph の prompt-close-all containment package を同時に保存し、
   same-origin controlled-profile fault drill、legacy cutover drill、agent/graph import report
   と Phase 1 `static-policy-activated` event/chain hash を pre-promotion evidence に含める。
7. promotion 前に `production-change-intent` event を append し、provider が production
   domain assignment を確認した同じ protected workflow 内で PWA minimum safety floor を
   `prompt-close-all-v1` へ進める `safety-floor-advanced` event を直ちに append する。
   target standard/companion の agent path/hash が static policy と exact 一致することを
   reducer input で確認し、24 時間 observation の完了を待って legacy または agent 欠落
   package へ戻せる状態にはしない。
8. state compare-and-append/current record 更新が失敗した場合は workflow を停止し、intent と
   provider inspect から reconciliation する。auto-update package への自動 rollback は
   行わない。
9. post-promotion smoke の結果に応じて `production-validation-passed` または
   `production-validation-failed` を append する。どちらの結果でも P0 bootstrap baseline
   と他の legacy-auto-update inventory action は新 minimum floor との不適合を再導出し、
   続けて `rollback-eligibility-revoked` を append する。
10. validation が成功した場合は 24 時間 observation と final core を完了し、
    `release-accepted` event で accepted PWA hard floor と accepted
    production/companion を進める。

step 9 の validation が失敗した場合は prompt-close-all companion を emergency recovery
として昇格し、containment observation/acceptance を完了する。作成される recovery context
の goal は旧 legacy standard ではなく、minimum safety floor まで持ち上げた
prompt-close-all standard とする。その standard への最終 recovery acceptance で deferred
PWA hard-floor advance を適用して context を clear するまで `P1-PWA` は完了しない。

合格条件 `P1-PWA`:

- install、update、offline、deep link、Release A persistence test が成功する。
- `build:release-a` は native prompt artifact で成功し、`registerSW.js` を生成も要求も
  せず、legacy lifecycle を canonical deployment として受理しない。
- outer agent の path/bytes/hash、HTML の唯一の module reference、両 precache revision、
  static policy、standard/containment artifact が exact 一致し、role graph から
  registration/update/identity challenge への edge が 0 である。
- current external Release State の active policy は agent hash を導入した exact versionで、
  その activation event/二者承認/compatibility diff と両 package の
  `releasePolicyHash` が一致する。
- outer agent が取得した active Worker MessageChannel identity と HTML/capability identity
  が一致し、不一致時は data mutation 前に停止する一方、update discovery は継続する。
  waiting Worker は MessageChannel、network-only の
  stable/versioned identity が exact 一致した候補だけを runtime で案内する。protected
  promotion gate は両 identity file の artifact manifest hash 照合を別途成功させる。
- unsaved blocker がある tab で自動 reload と controller change が起きない。
- agent-bearing prompt package では waiting 済みなら全 client close 後の最初の reopen、
  reopen 時初検出なら prompt 後の次の close/reopen で、一度だけ新 version が active に
  なる。P0 legacy shell からの初回 cutover は前記の prompt 非依存二段 lifecycle とする。
- prompt 表示中に import/export/persistence の partial commit がない。
- update UI 非対応環境でも旧 version を安全に継続できる。
- agent-bearing standard の role bootstrap/UI bridge/Worker evaluation/identity が壊れた
  package からも、同一 stable origin、同じ installed/controlled profileで事前保存済み
  containment Worker を発見、install、waiting にできる。開いた client を奪わず、全 client
  close と次回 reopen だけで full App/API/offline/persistence を回復する。
- agent を持たない P0 legacy-controlled profileの初回 cutoverも、faulted standard Worker
  evaluation から containment へ強制 reload/cache delete/unregister なしで到達できる。
- external Release State の minimum/accepted PWA floor がどちらも
  `prompt-close-all-v1` で、pending operation/acceptance と standard recovery context が
  ない。
- accepted companion は Phase 1 standard と同じ source の exact containment projection
  であり、cross-source bootstrap baseline の package-redeploy eligibility は false である。
- containment artifact に standard PWA module が混入せず、standard-only fault drill の全
  case で同一 stable origin の containment install/waiting/natural activationと別
  deployment identity の startup/Worker/identity が成功する。fresh deployment URL だけの
  trace はこの条件を満たさない。

rollback:

- Phase 1A/1B の QA は以前の package へ戻せる。
- Phase 1C production 後は auto-update package へ戻さず、保存済み
  prompt-close-all containment package に fix-forward する。

### Phase 2: Local Tailwind と CSP report-only

#### Phase 2A: Local CSS

1. Tailwind/PostCSS/Autoprefixer を exact pin する。
2. current CDN config、global style、theme/viewport script を local build input へ移す。
3. user zoom 制限を削除する。
4. Tailwind runtime route を standard/containment 両 Service Worker から削除する。
5. resolved entry graph と browser trace で Supabase request 0 を確認し、Supabase
   NetworkOnly route を両 Service Worker から削除する。request が存在する場合は削除せず、
   CSP の exact origin inventory へ移す。
6. CDN offline warm/cold と local CSS の screenshot、computed style、print を比較する。
7. observation 条件成功後、external Release State に `release-accepted` event と terminal
   fragment を append して CSS delivery hard floor を local へ進める。accepted floor と
   pending なしを再検証してから `P2A-LOCAL` を完了する。tracked config の変更や package
   rebuild で floor を表現しない。

合格条件 `P2A-LOCAL`:

- CDN request と Tailwind runtime cache の新規 write が 0。
- cold offline でも必要 CSS が precache から読み込まれる。
- theme prepaint に flash regression がない。
- browser zoom、keyboard zoom、mobile viewport が利用できる。
- candidate 観測中は `css-cdn-prompt` へ戻せる。
- accepted CSS delivery floor が `css-local-no-report` で、pending operation/acceptance が
  ない。

#### Phase 2B: CSP preparation

1. CSP を Report-Only で配信する。
2. first-party inline code、event handler、eval sink scanner を追加する。
3. style sink inventory と persisted style value validation を追加する。
4. Playwright が収集する `securitypolicyviolation` event と network trace から app、
   Worker、API、Google Sheets redirect、PWA の必要 origin だけを allowlist に固定する。
5. old Tailwind cache は inert residue として検知するが削除しない。
6. observation 条件成功後に `release-accepted` と terminal fragment を append し、
   `css-local-report-only` の accepted floor と pending なしを確認してから
   `P2B-REPORT` を完了する。

合格条件 `P2B-REPORT`:

- `P2A-LOCAL` の条件を維持する。
- first-party inline script/style block が 0。
- Report-Only policy の unexpected first-party violation が 0。
- `css-local-no-report` へ rollback できる。
- accepted CSP report floor が `css-local-report-only` で、Tailwind CDN route を
  復活させず、pending operation/acceptance がない。

### Phase 3: XLSX port と Worker

#### Phase 3A: Pure seam

1. 重複 type、pure item-number helper、snapshot、download helper を分離する。
2. `XlsxExecutionPort` と main-thread adapter を導入する PR では behavior を変えず、
   UI import を port へ置換する。
3. current preview signature cache、latest-wins、error text、date formula を golden
   test にする。
4. 別の behavior PR で `requestedAtIso` の一回取得 contract を実装し、timestamp
   golden だけを意図的に更新する。

#### Phase 3B: Whole-buffer Worker

1. provider-owned wire protocol と Worker adapter を実装する。
2. ArrayBuffer input/output を Transferable にする。
3. cancel、timeout、Worker crash、stale response、rapid file replacement を検証する。
4. compile-time flag で `xlsx-main` と `xlsx-worker` variant を作る。
5. 両 variant で initial graph に未選択 adapter がないことを検証する。

#### Phase 3C: Preflight と resource limit

1. `@zip.js/zip.js` と `saxes` を exact direct dependency として追加する。
2. `File.arrayBuffer()` 前の file size gate、ZIP central directory validation、
   bounded inflate/XML scan を追加する。
3. benign large file、corrupt ZIP、pathological compression、excessive row/cell/string
   fixture を追加する。
4. `config/xlsx-limits.json` の threshold と根拠を保存する。
5. sensitive cell content を log、metric、error に含めない。
6. main/Worker adapter で全 resource fixture の accept/reject と error code が一致する
   contract test を追加する。

#### Phase 3D: Conditional streaming

次のいずれかが production profile の budget を超えた場合だけ開始する。

- peak memory
- structured clone または transfer preparation time
- first preview latency
- cancel latency

開始条件を満たさなければ whole-buffer Worker を完成形とし、streaming package を
追加しない。

合格条件 `P3-XLSX`:

- semantic golden が main/Worker adapter で一致する。
- UI thread の long task と input latency が budget 内。
- cancel/timeout 後に data と file download が部分適用されない。
- initial app graph に ExcelJS static edge がない。
- CSP Report-Only 下の preview/import/export violation が 0、または Phase 4 前に
  解消する blocker として記録されている。
- standard `xlsx-worker` と同じ source/minimum safety/accepted floor の `xlsx-main`
  containment companion が package index、companion-candidate URL trace、immutable URI を
  持つ。

rollback:

- 同じ public port、preflight、resource limit と current minimum safety/accepted floor を
  持つ compile-time
  `xlsx-main` containment companion を保存する。Phase 4 以降の各 production promotion
  でも同じ source から再生成、再検証する。rollback で緩和するのは responsiveness
  だけで、入力安全性は緩和しない。
- runtime exception で自動的に main-thread へ再実行して二重 mutation する fallback は
  作らない。

### Phase 4: CSP enforcement

実装:

1. ExcelJS と ZIP dependency の reachable CSP violation を全 XLSX flow で検証する。
2. violation があれば dependency patch、置換、または code path 除去を行う。
3. `script-src 'self'`、`worker-src 'self'` を `'unsafe-inline'` と `'unsafe-eval'` なしで
   enforcement する。
4. `style-src-elem 'self'` を enforcement し、`style-src-attr` の期限付き inventory を
   evidence に含める。
5. `X-XSS-Protection` を削除し、CSP、nosniff、frame-ancestors、referrer、
   permissions policy の header table test を追加する。
6. Report-Only は次の stricter candidate policy の観測用に残し、enforced policy と
   field を混同しない。
7. standard と `xlsx-main` containment の両方を enforced policy で検証する。observation
   条件成功後、external Release State に `release-accepted` と terminal fragment を
   append して CSP hard floor を enforcement へ進め、accepted floor と pending なしを
   確認してから `P4-CSP` を完了する。

合格条件 `P4-CSP`:

- production-like server と candidate で header が一致する。
- startup、PWA、XLSX、map、export、print、Supabase metrics の browser test が成功する。
- enforced policy に unexpected violation が 0。
- first-party executable inline sink が 0。
- vendor waiver は static token、到達可能性、owner、expiry を持ち、実 violation を
  allowlist で隠していない。
- accepted CSP enforcement floor が `css-local-csp-enforced` と exact 一致し、
  pending operation/acceptance がない。

rollback:

- Phase 4 candidate/observation 中だけ Report-Only の直前 package を floor として保存する。
- `P4-CSP` 完了後は enforcement を持たない Report-Only package を期限切れとし、
  enforced standard と
  enforced containment companion を current floor にする。
- incident rollback で broad `script-src *`、`'unsafe-eval'`、`default-src *` を
  一時追加しない。

### Phase 5: Typed navigation と ShoppingList

#### Phase 5A: Navigation seam

1. `App.mapImportFlow.integration.test.tsx` の source-contract assertion を observable
   integration test に置換する。
2. `ScreenState`、`NavigationCommand`、single owner を実装し、legacy `ActiveTab` setter
   を compatibility adapter の内側へ閉じ込める。
3. map import、event-list、import、event-date、map、restore を command test にする。
   browser history と SpaceNavigator の LIFO return history は別 fixture で現行
   semantics を維持する。
4. `ListViewportPort` を full renderer に接続し、App、Overlay、navigator、search の
   DOM query を adapter 内へ移す。

#### Phase 5B: Controller と full renderer

1. 対象 file の warning を lint-prep PR で 0 にする。
2. `useShoppingListController` と `buildListRows` を抽出する。
3. current JSX を `FullShoppingListRenderer` へ移し、DOM snapshot と behavior を維持する。
4. dialog、drag、selection、bulk、grouping、highlight command が一系統だけであることを
   architecture test で固定する。

#### Phase 5C: Eligible virtual prototype

1. `@tanstack/react-virtual` `3.14.9` を exact direct dependency として追加する。
2. 100% zoom、単一 column、非 drag、非 edit だけを eligible にする。
3. variable row measurement、overscan、focus pin、scroll anchor を実装する。
4. full/virtual の read model、selection、keyboard、search result を property test で
   比較する。
5. 10,000 item profile で full renderer と比較する。

#### Phase 5D: Dual renderer、default full

1. compile-time `list-full` と `list-dual-default-full` variant を作り、disposable QA
   deployment で比較する。
2. production は `list-dual-default-full` candidate だけを昇格し、未定義の per-user
   cohort assignment を作らない。
3. zoom または二列への変更は idle boundary で full renderer へ切り替える。drag/edit は
   gesture gate を経て full renderer ready 後に開始する。
4. 24 時間 observation と `release-accepted` を完了し、list engine floor を
   `list-dual-default-full` へ進める。

合格条件 `P5-DUAL`:

- full renderer の既存 behavior test と dual package の full-default browser test が
  すべて成功する。
- virtual renderer は eligible state の明示操作でだけ検証でき、production default と
  implicit cohort から選ばれない。
- unsupported state、active gesture、renderer 切替の safety test が成功する。
- accepted list engine floor が `list-dual-default-full` で、次の default transition は
  `P5-DUAL` 完了後にだけ許可される。
- pending operation/acceptance がない。

#### Phase 5E: Eligible default

1. `list-dual-default-auto` variant と compile-time `list-full` companion を同じ source から
   作り、standard candidate/companion-candidate URL で検証する。
2. `ListRendererPreferencePort` を追加し、`auto | full` の versioned local UI preference
   を `localStorage` key `event-shopping-planner:list-renderer-mode:v1` に保存する。
   read/write failure は `full` に fail-safe し、event data へ混在させない。
3. `P5-DUAL` accepted production から `list-dual-default-auto` candidate だけを昇格し、
   24 時間 observation 後に `release-accepted` と terminal fragment を append して list
   default floor を進める。
4. compile-time `list-full` containment は local preference より優先し、保存済み `auto`
   があっても virtual renderer の code path を有効にしない。artifact graph は virtual
   adapter と `@tanstack/react-virtual` への reachable edge 0 を検証する。

合格条件 `P5-LIST`:

- full renderer の既存 behavior test がすべて成功する。
- eligible virtual renderer の keyboard、screen reader、focus、selection、search、
  navigator が成功する。
- renderer 切替で scroll anchor、selection、draft が破損しない。
- active gesture 中に renderer が切り替わらず、drag は full renderer ready 後の新しい
  gesture だけで始まる。
- unsupported state は必ず full renderer を使う。
- performance budget を満たし、full fallback の bundle と test が残る。
- same-source containment companion は `list-full` と `xlsx-main` を強制し、保存済み
  preference にかかわらず virtual renderer/XLSX Worker path へ入らない。
- accepted list default floor が `list-dual-default-auto` で、pending
  operation/acceptance がない。

rollback:

- 3 variant は IndexedDB/data contract を共有する。`list-dual-default-full` は保存済み
  `auto` preference を尊重するため incident containment とみなさない。
- containment companion は compile-time `list-full` を強制し、同じ source の
  `xlsx-main` と current minimum safety/accepted floor を組み合わせて事前検証、保存する。

### Phase 6: App state と command の分割

実装順:

1. 残る 3 本の App source-contract test を observable integration test に置換し、
   `App.tsx` と既存 app-shell file の対象 warning を behavior test 付きで解消する。
2. Phase 5 の canonical `ScreenState` へ全 consumer を移し、legacy `ActiveTab` type、
   compatibility callback、raw setter を削除する。
3. import/export、event、map、list、dialog の state transition を pure command/reducer
   へ抽出する。
4. component 向け read model と callback adapter を抽出する。
5. `PersistenceCommandPort`、legacy IndexedDB adapter、root `createAppServices` composition
   を導入し、App/app-shell から `src/utils/indexedDB.ts` の deep import を 0 にする。
6. `itemToEdit` など到達しない state は移動と同じ PR で消さず、独立 behavior PR で
   dead path を証明して削除する。
7. 既存 Header/Main/Overlay component を command/read model consumer へ縮小する。

合格条件 `P6-APP`:

- source-string handler test が 0。
- navigation と operation の state machine test が success/failure/cancel/retry を扱う。
- App/app-shell から IndexedDB implementation deep import が 0。
- JSX shell に domain mutation、XLSX wire、IDB transaction がない。
- current visible behavior、route、focus、dialog、persistence integration test が成功する。

rollback:

- data/persistence contract は変更しない。incident 時は保存済み Phase 5 deployment へ
  rollback し、削除済み legacy callback を新 package 内で二重維持しない。

### Phase 7: IndexedDB 分割

実装順:

1. constants、open/upgrade、request/transaction helper を移す。
2. read-only repository を event、map、settings、queue/control の domain/storage
   responsibility ごとに抽出する。一つの physical store に一つの repository を
   機械的に作る必要はない。
3. `syncQueueRepository` と key-first `controlRepository` を分離する。
4. cross-store write を `transactionCoordinator` へ一件ずつ移す。
5. migration journal、legacy cleanup、checkpoint、recovery adoption、atomic restore を
   移す。
6. `useIndexedDbPersistence` を new facade に接続し、root composition の
   `PersistenceCommandPort` binding を legacy adapter から
   `indexedDbPersistenceCommandAdapter` へ交換する。
7. repository 全体から旧 `src/utils/indexedDB.ts` implementation への deep import を
   0 にし、compatibility re-export だけを残す。
8. 一つの full release observation 後に legacy App adapter と compatibility re-export の
   削除可否を判断する。

合格条件 `P7-IDB`:

- DB name、version 5、forward max 7、store/key/value semantics が変わらない。
- existing atomic restore、map、resilience、recovery adoption、legacy cleanup、
  version test が成功する。
- v5/v6/v7、missing/incompatible store、blocked、versionchange、quota、abort fixture が
  成功する。
- unknown internal record が保持され、queue API と cleanup に現れない。
- cross-store transaction が coordinator 以外にない。
- active transaction 内に unrelated async await がない。
- metrics failure が persistence result を変えない。

rollback:

- schema version を上げていないため、直前 app package へ戻せる。
- version migration が将来必要になった場合は、この phase と分離した forward-only
  migration plan を作る。

### Phase 8: Lint debt と package closure

1. warning を rule cluster と ownership ごとの小 PR で減らす。
2. hook dependency の変更は source suppression ではなく behavior test と state machine
   ownership の修正で行う。
3. unused import/variable は dead path を integration test で確認してから削除する。
4. warning 0 の clean source SHA を固定する。
5. entry graph 非参照を確認した package だけを一つずつ削除する。
6. package 削除後に artifact、browser、audit、PWA、XLSX、Release A を再検証する。

合格条件 `P8-CLEAN`:

- lint 0 errors、0 warnings。
- baseline file と temporary fingerprint mapping を削除できる。
- dependency graph に unused direct package、undeclared direct import、peer error がない。
- final package set の clean SHA から全 evidence を再生成している。

## 9. Rollout と観測

### 9.1 Variant

accepted standard baseline の通常 transition は同時に一つの dimension だけを変更する。
containment companion は rollout candidate ではなく、static policy が生成する exact safe
projection なのでこの数に含めない。

| dimension      | rollback floor           | candidate                  |
| -------------- | ------------------------ | -------------------------- |
| `pwaLifecycle` | `prompt-close-all-v1`    | 同 lifecycle の改善版      |
| CSS delivery   | `css-cdn-prompt`         | `css-local-no-report`      |
| CSP report     | `css-local-no-report`    | `css-local-report-only`    |
| CSP enforce    | `css-local-report-only`  | `css-local-csp-enforced`   |
| XLSX           | `xlsx-main`              | `xlsx-worker`              |
| list engine    | `list-full`              | `list-dual-default-full`   |
| list default   | `list-dual-default-full` | `list-dual-default-auto`   |
| persistence    | `persistence-monolith`   | `persistence-split-facade` |

legacy `legacy-auto-update-v1` は Phase 1 minimum safety floor 前進後の rollback variant に
含めない。
各 row の rollout floor は candidate の gate と observation が完了するまで有効であり、
accepted candidate が次の標準 baseline になる。`legacy-auto-update-v1`、Phase 2A 後の
`css-cdn-prompt`、Phase 4 後の enforcement を持たない Report-Only package など、
明示的な hard floor を
下回る policy variant は期限切れとし、後続 phase で復活させない。この失効規則は
permanent safe adapter、または current minimum safety/accepted floor と DB forward
contract を満たす以前の
immutable production deployment/package の保管まで禁止しない。external Release State の
rollback inventory は exact binding と inventory key に加え、action 別 eligibility/reason
を記録する。`instant-rollback` は以前 production に割り当てられた binding だけに許可し、
companion candidate は `package-redeploy` だけを true にできる。

P0 だけは §8 の audited pre-change source から作る cross-source bootstrap baseline を
使う。`P0-RELEASE` acceptance 後の Phase 1 以降は、各 production source の同じ clean
checkout から次の二つを作る。

- standard candidate: `releaseRole: "standard"` と rollout で選択した全 dimension
- containment companion: source と current minimum safety/accepted floor は同一で、
  `releaseRole: "containment"` を持つ variant。Phase 1〜2 は standard と同じ observable
  prompt-close-all/App/data contract を独立 PWA graph で満たす。Phase 3 以降は
  `xlsx-main`、Phase 5 以降は `list-full` も compile-time 強制する

companion は experiment または cohort ではなく、保存済み `auto` preference より強い
incident 用 package である。standard と companion は別 `variantId`、artifact、package
index を持ち、promotion 前に両方を build、production-target candidate/companion-candidate
URL で critical browser/CSP/data contract test を実行して保存する。新しい companion が
検証済みになるまで直前の eligible companion を破棄しない。standard の feature flag の
任意 cross-product は作らない。

containment production を observation 後に accepted にした場合、通常 feature rollout へ
一度に戻さない。reducer は受理前の standard reference と goal dimensions を
`standardRecoveryContext` に固定し、static policy が次の deterministic recovery ladder
だけを生成する。

1. current accepted が containment role なら、他の behavior dimension を一切変えず
   `releaseRole` だけを `standard` にした exact variant を最初の target にする。
2. 以後は standard role のまま、goal と異なる behavior dimension を policy 順に一つずつ
   goal value へ戻す。minimum safety floor は全 step で維持する。
3. 各 standard target と同じ source から exact containment projection を別
   `variantId`/artifact/binding として作り、proposed companion にする。
4. 各 step は `transitionKind: "standard-recovery-step"` の通常 promotion、
   post-promotion validation、指定時間の observation、`release-accepted` を完了してから
   次へ進む。goal と exact 一致した acceptance は deferred hard-floor advances を exact
   適用してから context を clear する。

これらの standard intermediate は incident recovery に必要な有限集合であり、context と
policy が一意に示す current/next binding だけを accepted hard floor の例外にする。任意
cross-product や per-user cohort として公開せず、context 中は feature rollout と policy
activation を禁止する。accepted hard floor と context の goal は下げず、再度 containment
を受理しても元の goal を上書きしない。

`variantId` は `variantDimensions` exact object の JCS bytes に対する lowercase SHA-256
とする。artifact manifest、package index、provider evidence、binding は exact object と
hash の両方、HTML meta、capability、public identity は hash を記録する。dimension schema、
allowed transition、compatibility predicate、standard/companion rule は hash で束縛した
`config/release-variants.json`、現在の minimum safety/accepted floor と rollback inventory
は external Release State を正本にする。

### 9.2 Promotion gate

通常 promotion:

1. clean canonical prebuild。P0 は §8 の audited bootstrap exception、Phase 1 以降は同じ
   checkout から standard と containment companion を別 artifact として作る。
2. standard と companion の artifact/package index/policy/provider identity verification
3. unit、integration、browser、a11y、architecture、audit。companion は current CSP、
   outer agent identity、PWA graph independence、同一 stable origin の controlled-profile
   fault recovery、XLSX preflight、list force-full、persistence contract の critical suite
   も通す。
4. standard candidate と companion-candidate URL の smoke、offline test
5. physical DB evidence に差分がある場合は Data Safety gate。本計画の Phase 1〜8 では
   `dbCompatibilityFingerprint` の変更を拒否する。
6. evidence に両 package の immutable URI と `packageIndexHash` を記録する。
7. Release と対象 owner の承認
8. current Release State と pre-promotion evidence を再検証し、standard target と
   proposed companion を持つ `production-change-intent` event を
   `mode: "normal-promotion"` で append する。recovery context が null なら
   `standard-rollout`、non-null なら policy が算出した exact
   `standard-recovery-step` だけを許可する。
9. standard と同一 deployment の promotion
10. provider assignment を再取得し、post-assignment production binding を持つ
    `production-assigned` event を append する。append の成否が不明なら同じ operation ID と
    intent hash で `production-change-reconciled` を実行し、assignment hash 付き
    pending acceptance を確認する。
11. post-promotion smoke を検証し、`production-validation-passed` event を append して
    observation anchor を確定する。
12. phase に応じた observation と evidence core finalization
13. observation gate 成功後に `release-accepted` event と terminal evidence fragment を
    exact operation/assignment hash へ append し、accepted production/companion、accepted
    hard floor、rollback inventory を進める。pending operation/acceptance がないことを
    確認する。standard rollout は recovery context が null の場合だけ named phase gate を
    完了する。recovery step は policy 固有 gate を完了し、context が clear されるまで次の
    named phase gate を開始しない。

step 11 が失敗した場合は `production-validation-failed` を append し、named gate と
observation を開始せず、blocked assignment hash を supersede する emergency containment へ
進む。

Phase 1 の `prompt-close-all-v1` は一回限りの minimum safety floor であるため、step 10 の
production assignment 確認直後に `safety-floor-advanced` event を append し、step 12 を
待たず `legacy-auto-update-v1` を失効させ、pending acceptance の required event を進める。
これは release acceptance ではなく、
accepted PWA hard floor と accepted production/companion は 24 時間 observation 後の
step 13 でのみ進める。他の floor は step 13 まで進めない。provider mutation 後に state
append が失敗した場合は intent と provider inspect から fail-closed に reconcile し、旧
minimum safety floor への自動 rollback を行わない。

PWA accepted floor、DB migration を含む release、CSP enforcement、XLSX default、virtual
list default、IndexedDB split は 24 時間以上の observation を要求する。doc-only、
test-only、provider state を変えない tooling PR は production observation を要求しない。

### 9.3 Emergency containment

data loss、起動不能、保存不能、更新 loop、API credential exposure が疑われる場合は、
通常 24 時間 gate の完了を待たず、事前検証済み containment package を二者承認で
昇格できる。

- current deployment と evidence を保全する。
- 新しい build を incident 中に作らない。
- current active companion または rollback inventory から current static policy、
  minimum safety/accepted floor、DB contract を満たす binding を選び、package 三 file、
  外部 `packageIndexHash`、provider evidence、公開 identity、対象 action eligibility を
  再検証する。inventory source は exact key/action、active companion source は binding
  hash と pre-promotion approval を recovery source に記録し、対応 companion pair も選ぶ。
- instant rollback は `eligibility["instant-rollback"].eligible` な既存 production binding を
  target にした `production-change-intent` を `mode: "instant-rollback"` で先に append
  する。`transitionKind` は `emergency-recovery` とし、observation 中なら supersede する
  assignment hash も記録し、archive を upload せず provider rollback を実行する。
- package redeploy は `eligibility["package-redeploy"].eligible` な package を展開、検証して
  source package と同じ dimensions/policy/package hash、新 deployment ID の candidate
  binding と smoke を得た後、recovery source と必要な supersede hash を持つ
  `mode: "package-redeploy"`、`transitionKind: "emergency-recovery"` の intent を append
  して promote する。
- provider mutation 後は production role の新 evidence/binding を作り、
  `production-assigned` または inspect に基づく `production-change-reconciled` を append
  する。incident smoke 後に recovery mode/from/to と unchanged floor を
  `containment-activated` event に記録する。
- incident smoke が失敗した場合は `containment-attempt-failed` を append し、blocked
  pending acceptance を exact hash で supersede する次の事前検証済み recovery を選ぶ。
- prompt-close-all floor、DB compatibility、Release A contract を維持する。
- containment 後に通常 24 時間 observation を最初からやり直し、三者承認済み
  `release-accepted` まで active と accepted production を区別する。
- observation 完了まで次の feature promotion を禁止する。

### 9.4 即時停止条件

- source、artifact、deployment identity の不一致
- candidate と promoted deployment の公開 asset hash または release identity の不一致
- local persistence の失敗率または recovery flow の悪化
- PWA controller loop、意図しない reload、複数 client の version split
- CSP による startup、XLSX、Worker、metrics の block
- XLSX partial import、二重 export、cancel 後の mutation
- virtual/full 切替時の selection、focus、draft、scroll anchor loss
- IndexedDB unknown record の削除、forward version の破損、transaction atomicity failure
- raw metrics の privilege 拡大、retention runaway、credential/project ref 不一致
- 日本語の U+FFFD、BOM/EOL の意図しない変化、代表文字列の破損

## 10. Phase exit matrix

| Gate           | 必須入力                                     | production へ進める条件                     |
| -------------- | -------------------------------------------- | ------------------------------------------- |
| `P0-BASELINE`  | clean source、baseline evidence              | source-bound baseline が再現する            |
| `P0-TOOLCHAIN` | exact runtime、lock、peer、audit             | command graph と browser target が安定      |
| `P0-ARTIFACT`  | package/policy hash、QA/state/rollback drill | production workflow が実行可能              |
| `P0-DATA`      | DB migration、API、verifier fixtures         | privilege/retention と evidence mode が安全 |
| `P0-PROMOTE`   | production candidate、二者承認 bundle        | 同一 deployment を promotion 可能           |
| `P0-RELEASE`   | 24h observation、v1、三者承認 bundle         | Release A final evidence が完成             |
| `P1-PWA`       | outer agent、multi-client、same-origin drill | update 発見と natural activation が安全     |
| `P2A-LOCAL`    | local CSS、offline/visual comparison         | CDN request と runtime write が 0           |
| `P2B-REPORT`   | Report-Only、sink/origin inventory           | unexpected first-party violation が 0       |
| `P3-XLSX`      | semantic golden、Worker、limits、companion   | responsiveness と atomicity が budget 内    |
| `P4-CSP`       | enforcement candidate、violation evidence    | broad script exception なしで全 flow 成功   |
| `P5-DUAL`      | full-default dual candidate、companion       | dual engine を default-full で受理          |
| `P5-LIST`      | shared model、full/virtual、force-full       | eligible state だけを安全に virtualize      |
| `P6-APP`       | typed state/command、persistence port        | shell から domain/IDB detail が分離         |
| `P7-IDB`       | repository/coordinator、compatibility suite  | schema 不変で transaction semantics 一致    |
| `P8-CLEAN`     | warning 0、final package graph               | baseline debt と temporary bridge を除去    |

## 11. 実装時に参照する正本

| path                                                                     | status                                                   | 主な参照・変更 phase  | owner               |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------- | ------------------- |
| `package.json`                                                           | existing                                                 | 0B、0C、1、2、3、5、8 | Build               |
| `package-lock.json`                                                      | existing                                                 | 0B、0C、1、2、3、5、8 | Build               |
| `.gitignore`                                                             | existing                                                 | 0C                    | Build               |
| `tsconfig.json`                                                          | existing                                                 | 0B、1、3              | Build/Quality       |
| `tsconfig.node.json`                                                     | existing                                                 | 0B                    | Build/Quality       |
| `vite.config.ts`                                                         | existing                                                 | 0B、0C、1、2、3       | Build/PWA           |
| `vitest.config.ts`                                                       | existing                                                 | 0B                    | Quality             |
| `.eslintrc.cjs`                                                          | existing compatibility path                              | 0B                    | Quality             |
| `vercel.json`                                                            | existing                                                 | 0C、2、4              | Release/Security    |
| `index.html`                                                             | existing                                                 | 1、2                  | UI/PWA/Security     |
| `src/index.tsx`                                                          | existing                                                 | 1、6                  | App/PWA             |
| `src/App.tsx`                                                            | existing                                                 | 1、3、5、6            | App/PWA/XLSX        |
| `src/features/app-shell/types.ts`                                        | existing                                                 | 1、5、6               | App/PWA             |
| `src/features/app-shell/components/AppHeaderShell.tsx`                   | existing                                                 | 1、6                  | App/PWA             |
| `src/features/app-shell/components/AppMainContent.tsx`                   | existing                                                 | 1、5、6               | App/PWA             |
| `src/features/app-shell/components/AppOverlayLayer.tsx`                  | existing                                                 | 1、5、6               | App/PWA             |
| `src/features/map/domain/mapImportFlow.ts`                               | existing                                                 | 5                     | Map/App             |
| `src/components/ShoppingList.tsx`                                        | existing monolith、Phase 5 後 facade                     | 1、5                  | List/PWA            |
| `src/utils/exportImport.ts`                                              | existing implementation、Phase 3 後 compatibility path   | 3                     | XLSX                |
| `src/utils/xlsxMapParser.ts`                                             | existing implementation、Phase 3 後 compatibility path   | 3                     | XLSX                |
| `src/components/map/MapImportDialog.tsx`                                 | existing                                                 | 1、3                  | XLSX/Map/PWA        |
| `src/lib/supabase.ts`                                                    | existing                                                 | 0C、2                 | Release/Security    |
| `src/types/export.ts`                                                    | existing                                                 | 3                     | XLSX                |
| `src/utils/indexedDB.ts`                                                 | existing implementation、Phase 7 後 compatibility facade | 6、7                  | Persistence         |
| `src/hooks/useIndexedDbPersistence.ts`                                   | existing                                                 | 1、6、7               | Persistence/PWA     |
| `src/utils/persistenceCleanupCoordinator.ts`                             | existing                                                 | 7                     | Persistence         |
| `api/persistence-release-a-metrics.mjs`                                  | existing                                                 | 0C                    | Release/Data Safety |
| `supabase/migrations/20260803000000_persistence_release_a_metrics.sql`   | existing immutable migration                             | 0D                    | Data Safety         |
| `scripts/verify-release-a-build.mjs`                                     | existing                                                 | 0B、0C、1             | Release/PWA         |
| `scripts/verify-release-a-browser.mjs`                                   | existing compatibility path                              | 0C                    | Release             |
| `scripts/verify-release-a-evidence.mjs`                                  | existing immutable v1 verifier                           | 0E                    | Release/Data Safety |
| `docs/release-a-evidence.template.json`                                  | existing template                                        | 0E                    | Release/Data Safety |
| `config/foundation-baseline.json`                                        | planned                                                  | 0A                    | Build               |
| `config/encoding-policy.json`                                            | planned                                                  | 0A                    | Quality             |
| `config/toolchain-versions.json`                                         | planned                                                  | 0B                    | Build               |
| `config/lint-warning-baseline.json`                                      | planned                                                  | 0A                    | Quality             |
| `config/architecture-policy.json`                                        | planned                                                  | 0B                    | Quality             |
| `config/architecture-baseline.json`                                      | planned                                                  | 0B                    | Quality             |
| `config/test-project-membership.json`                                    | planned                                                  | 0B                    | Quality             |
| `config/audit-waivers.json`                                              | planned                                                  | 0B                    | Security            |
| `config/coverage-policy.json`                                            | planned                                                  | 0C                    | Quality             |
| `config/performance-budgets.json`                                        | planned                                                  | 0C                    | Quality             |
| `config/release-variants.json`                                           | planned versioned static policy                          | 0C、1                 | Release             |
| `config/release-state.schema.json`                                       | planned static schema                                    | 0C                    | Release             |
| `config/csp-policy.json`                                                 | planned                                                  | 2、4                  | Security            |
| `config/xlsx-limits.json`                                                | planned                                                  | 3                     | XLSX/Security       |
| `scripts/build-release-artifact.mjs`                                     | planned canonical/bootstrap wrapper entry                | 0C、0E                | Build/Release       |
| `scripts/verify-release-artifact.mjs`                                    | planned                                                  | 0C                    | Build/Release       |
| `scripts/verify-bootstrap-staging.mjs`                                   | planned no-op staging verifier                           | 0C、0E                | Build/Release       |
| `scripts/templates/bootstrap-metrics-disabled.mjs`                       | planned fixed no-network adapter                         | 0C、0E                | Release/Data Safety |
| `scripts/verify-release-a-evidence-bundle.mjs`                           | planned                                                  | 0D、0E、1〜8          | Release/Data Safety |
| `scripts/verify-release-state.mjs`                                       | planned                                                  | 0C、0E、1〜8          | Release             |
| `scripts/release-state-store.mjs`                                        | planned protected adapter                                | 0C、0E、1〜8          | Release             |
| `scripts/build-release-vite.mjs`                                         | planned canonical Vite orchestrator                      | 0C、1                 | Build/PWA           |
| `scripts/build-pwa-recovery-agent.mjs`                                   | planned deterministic single-entry builder               | 1                     | PWA/Build           |
| `scripts/verify-architecture.mjs`                                        | planned                                                  | 0B                    | Quality             |
| `scripts/verify-test-project-membership.mjs`                             | planned                                                  | 0B                    | Quality             |
| `scripts/verify-test-contracts.mjs`                                      | planned                                                  | 0B                    | Quality             |
| `eslint.config.js`                                                       | planned                                                  | 0B                    | Quality             |
| `playwright.config.ts`                                                   | planned                                                  | 0C                    | Quality             |
| `.github/workflows/quality.yml`                                          | planned                                                  | 0C                    | Quality             |
| `.github/workflows/release.yml`                                          | planned                                                  | 0C                    | Release             |
| `supabase/migrations/20260805000000_persistence_release_a_hardening.sql` | planned                                                  | 0D                    | Data Safety         |
| `src/bootstrap.ts`                                                       | planned                                                  | 1                     | PWA/App             |
| `src/sw.ts`                                                              | planned                                                  | 1、2                  | PWA                 |
| `tsconfig.worker.json`                                                   | planned                                                  | 1、3                  | PWA/XLSX/Quality    |
| `src/pwa/recovery/outerRecoveryAgent.ts`                                 | planned immutable shared entry                           | 1〜8                  | PWA/Release         |
| `src/pwa/recovery/protocol.ts`                                           | planned read-only snapshot contract                      | 1〜8                  | PWA/Release         |
| `src/pwa/serviceWorkerBootstrap.ts`                                      | planned standard read-only UI bridge                     | 1                     | PWA/App             |
| `src/pwa/containment/bootstrap.ts`                                       | planned permanent safe adapter                           | 1〜8                  | PWA/Release         |
| `src/pwa/containment/appEntry.tsx`                                       | planned permanent safe adapter                           | 1〜8                  | PWA/App             |
| `src/pwa/containment/serviceWorkerBootstrap.ts`                          | planned permanent read-only UI bridge                    | 1〜8                  | PWA/App             |
| `src/pwa/containment/sw.ts`                                              | planned permanent safe adapter                           | 1〜8                  | PWA/Release         |
| `src/pwa/releaseIdentityProtocol.ts`                                     | planned                                                  | 1                     | PWA/Release         |
| `src/pwa/updateBlockerRegistry.ts`                                       | planned                                                  | 1                     | PWA/App             |
| `tailwind.config.cjs`                                                    | planned                                                  | 2                     | UI                  |
| `postcss.config.cjs`                                                     | planned                                                  | 2                     | UI                  |
| `public/theme-prepaint.js`                                               | planned                                                  | 2                     | UI                  |
| `src/styles/tailwind.css`                                                | planned                                                  | 2                     | UI                  |
| `src/styles/global.css`                                                  | planned                                                  | 2                     | UI                  |
| `src/xlsx/domain/types.ts`                                               | planned                                                  | 3                     | XLSX                |
| `src/xlsx/domain/itemNumber.ts`                                          | planned                                                  | 3                     | XLSX                |
| `src/xlsx/domain/exportSnapshot.ts`                                      | planned                                                  | 3                     | XLSX                |
| `src/xlsx/domain/exportFileName.ts`                                      | planned                                                  | 3                     | XLSX                |
| `src/xlsx/port/XlsxExecutionPort.ts`                                     | planned                                                  | 3                     | XLSX                |
| `src/xlsx/provider/createXlsxExecutionPort.ts`                           | planned                                                  | 3                     | XLSX                |
| `src/xlsx/adapters/mainThreadXlsxAdapter.ts`                             | planned                                                  | 3                     | XLSX                |
| `src/xlsx/adapters/workerXlsxAdapter.ts`                                 | planned                                                  | 3                     | XLSX                |
| `src/xlsx/worker/protocol.ts`                                            | planned                                                  | 3                     | XLSX                |
| `src/xlsx/worker/xlsx.worker.ts`                                         | planned                                                  | 3                     | XLSX                |
| `src/xlsx/security/preflightXlsx.ts`                                     | planned                                                  | 3                     | XLSX/Security       |
| `src/xlsx/download/downloadBlob.ts`                                      | planned                                                  | 3                     | XLSX                |
| `src/features/shopping-list/hooks/useShoppingListController.ts`          | planned                                                  | 5                     | List                |
| `src/features/shopping-list/model/buildListRows.ts`                      | planned                                                  | 5                     | List                |
| `src/features/shopping-list/ports/ListViewportPort.ts`                   | planned                                                  | 5                     | List                |
| `src/features/shopping-list/ports/ListRendererPreferencePort.ts`         | planned                                                  | 5                     | List                |
| `src/features/shopping-list/adapters/localListRendererPreference.ts`     | planned                                                  | 5                     | List                |
| `src/features/shopping-list/renderers/FullShoppingListRenderer.tsx`      | planned                                                  | 5                     | List                |
| `src/features/shopping-list/renderers/VirtualShoppingListRenderer.tsx`   | planned                                                  | 5                     | List                |
| `src/app/navigation/ScreenState.ts`                                      | planned                                                  | 5                     | App                 |
| `src/app/navigation/navigationCommands.ts`                               | planned                                                  | 5                     | App                 |
| `src/app/ports/PersistenceCommandPort.ts`                                | planned                                                  | 6                     | App/Persistence     |
| `src/app/adapters/legacyIndexedDbPersistenceCommandAdapter.ts`           | planned                                                  | 6                     | App/Persistence     |
| `src/app/composition/createAppServices.ts`                               | planned                                                  | 6                     | App                 |
| `src/persistence/db/constants.ts`                                        | planned                                                  | 7                     | Persistence         |
| `src/persistence/db/openDatabase.ts`                                     | planned                                                  | 7                     | Persistence         |
| `src/persistence/db/transactionCoordinator.ts`                           | planned                                                  | 7                     | Persistence         |
| `src/persistence/repositories/eventRepository.ts`                        | planned                                                  | 7                     | Persistence         |
| `src/persistence/repositories/mapRepository.ts`                          | planned                                                  | 7                     | Persistence         |
| `src/persistence/repositories/settingsRepository.ts`                     | planned                                                  | 7                     | Persistence         |
| `src/persistence/repositories/syncQueueRepository.ts`                    | planned                                                  | 7                     | Persistence         |
| `src/persistence/repositories/controlRepository.ts`                      | planned                                                  | 7                     | Persistence         |
| `src/persistence/migration/legacyMigration.ts`                           | planned                                                  | 7                     | Persistence         |
| `src/persistence/migration/legacyCleanupAdapter.ts`                      | planned                                                  | 7                     | Persistence         |
| `src/persistence/recovery/checkpoint.ts`                                 | planned                                                  | 7                     | Persistence         |
| `src/persistence/recovery/recoveryAdoption.ts`                           | planned                                                  | 7                     | Persistence         |
| `src/persistence/adapters/indexedDbPersistenceCommandAdapter.ts`         | planned                                                  | 7                     | Persistence         |
| `src/persistence/facade/indexedDbPersistence.ts`                         | planned                                                  | 7                     | Persistence         |

architecture policy の human-readable report は CI artifact
`architecture-report.json` として出力し、baseline と policy は上表の versioned config を
正本にする。

## 12. 全体完了条件

- `P0-BASELINE`/`P0-TOOLCHAIN` は source と input/tool hash、`P0-ARTIFACT` 以降の build
  gate は variant/policy/package、`P0-DATA` は DB fingerprint、`P0-PROMOTE` 以降の release
  gate は provider deployment binding と結び付いて成功している。
- production は prompt-close-all PWA、local Tailwind、enforced CSP、XLSX port、
  eligible virtual list、typed App command、分割 persistence facade を使用する。
- current production source の containment companion が prompt-close-all floor、
  independent PWA graph、compile-time `xlsx-main`/`list-full`、current CSP/data contract を
  満たし、standard とともに package index、immutable URI、browser/fault-recovery test を
  持つ。
- standard/containment は static policy と一致する同一 outer agent bytes/path/precache
  revision を持ち、同一 stable origin の installed/controlled fault drill で containment
  install、waiting、全 client close 後の natural activation を証明している。
- Release State の pending operation/acceptance と standard recovery context がすべて null
  で、active/accepted production と companion が exact 一致する。
- current minimum safety/accepted floor と DB contract を満たす直前 production
  deployment/package が
  rollback inventory に保存され、再 build せず検証できる。
- Release A v1 verifier と data safety contract が維持され、追加 evidence bundle が
  identity と fragment chain を検証する。
- lint は 0 errors/0 warnings、test project の重複/漏れは 0、architecture violation は
  0 である。
- audit waiver はすべて owner と期限を持ち、到達可能で mitigation のない production
  critical/high がない。
- IndexedDB schema と既存 data の互換性が実機を含む recovery suite で確認されている。
- 日本語、UTF-8 BOM、EOL に意図しない変化がない。
