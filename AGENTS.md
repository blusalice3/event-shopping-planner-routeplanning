# AGENTS.md

## 文字コード方針（最優先）

この作業では文字コード事故を最優先で避けてください。

### 読み込み時

- 日本語を含む既存ファイルは、読む前に encoding 候補、BOM 有無、改行コードを確認すること
- ソースコードは原則として **UTF-8 (BOM なし)** として読み込むこと
- 文字化けが疑われるファイルは、推測のまま保存しないこと
- 既存ファイルは元の encoding / BOM / 改行コードを維持すること

### 書き込み時（PowerShell）

- ファイル書き込みは encoding を明示する方法のみ使用すること
  - `Out-File -Encoding utf8`
  - `Set-Content -Encoding utf8`
  - `Add-Content -Encoding utf8`
- リダイレクト（`>` / `>>`）でのファイル保存は禁止
- PowerShell 5.1 のデフォルト UTF-16LE 書き出しを避けるため、必ず `-Encoding utf8` を付けること

### コマンド実行時の UTF-8 ラッパ

PowerShell コマンドを実行する際は、先頭に以下を付けてコンソールを UTF-8 にすること:

\`\`\`powershell
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 > $null
\`\`\`

### 検証（保存後の必須チェック）

- 保存後は再読込し、日本語の代表行が壊れていないことを確認すること
- 以下のいずれかが検出されたら **異常として停止し報告すること**:
  - U+FFFD（` `）の出現または増加
  - `?` の不自然な増加
  - BOM の意図しない変化
  - 改行コードだけの大量差分

### 監視対象（日本語が壊れてはいけない代表箇所）

- ファイル: `src/**/*.ts`, `README.md`, `docs/**/*.md`
- 代表文字列: "ユーザー登録", "エラーが発生しました"

## 作業前後のルール

- ファイル修正の前に必ず `git status` を確認し、変更が無いクリーンな状態にすること
- 修正前に「これから何を変えるか」を1〜3行で宣言してから着手すること
- 修正後は差分を要約し、文字コード関連の変化があれば明示すること

## シェルとプラットフォーム

- OS: Windows 11
- Shell: PowerShell 7（無ければ 5.1）
- すべてのファイル操作は **PowerShell で実行**すること（bash 系コマンドは使わない）
