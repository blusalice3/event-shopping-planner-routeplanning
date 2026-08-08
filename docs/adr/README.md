# Architecture Decision Records

この directory は Web Foundation 実装の安全性、互換性、運用上の決定を記録する。
実装と policy が ADR と異なる場合、暗黙に実装を優先せず、同じ change で ADR を更新する。

| ADR                                             | 状態                                                    | 決定                                                                             |
| ----------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Release State store](release-state-store.md)   | Accepted for implementation; production binding blocked | PostgreSQL append-only event/evidence store、CAS、protected approvals、reconcile |
| [XLSX resource limits](xlsx-resource-limits.md) | Accepted                                                | Worker 境界と import/export resource ceiling                                     |

## 状態の意味

- `Proposed`: decision review 中で production gate に使わない
- `Accepted for implementation`: code/policy の正本だが、外部 binding が揃うまで activation を
  許可しない場合がある
- `Accepted`: production evidence を含む gate が完了
- `Superseded`: 後継 ADR への link を残す

ADR に secret、credential value、raw user data、production free-form payload を記録しない。
