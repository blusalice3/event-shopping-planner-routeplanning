# Sharing Public Guard Release Review

Review date: 2026-06-17

This file is the release evidence required by `scripts/verify-sharing-public-guard.ps1`.
The public release check must fail if any marker below is removed.

## Required Markers

- [PUBLIC-GUARD-REVIEW-COMPLETE]
- CSP_REVIEW=pass
- XSS_REVIEW=pass
- LOCAL_STORAGE_CREDENTIAL_RISK=acknowledged
- LOG_REDACTION_REVIEW=pass
- FALLBACK_PROHIBITION_TEST=pass
- DB_DIRECT_RPC_REJECTION_TEST=pass
- EDGE_GUARD_INTEGRATION_TEST=pass
- CSP_DEPLOYMENT_CONFIG=vercel.json
- EDGE_GUARD_MUTATING_CHECK=acknowledged

## Evidence

- CSP/external script/inline script policy: `vercel.json` sets `Content-Security-Policy` with `default-src 'self'`, `script-src 'self'`, Supabase-only remote `connect-src`, `object-src 'none'`, and `frame-ancestors 'none'`. Inline style remains allowed because the current React/Tailwind UI uses runtime style attributes and generated style application paths.
- XSS review: sharing UI renders strings through React text nodes. No sharing credential is inserted with `dangerouslySetInnerHTML`.
- localStorage credential risk: `sharing.memberKey.v1:<roomId>` is a bearer restore credential. Possession allows restore for that room. It must not be logged, copied to analytics, or sent to error reporting.
- Log redaction: sharing code logs generic operation errors only. `member_key`, `member_restore_token`, digest values, and canonical create payload bodies are not intentionally written to console, notification payloads, analytics, or Edge logs.
- Fallback prohibition: `createSharingRoom`, `prepareJoinRoom`, and `prepareRestoreRoom` return `GUARD_UNAVAILABLE` when public Guard is required but unconfigured. They do not call DB bootstrap RPCs in that state.
- DB direct RPC rejection: database tests cover `app.sharing_public_mode = 'public'` rejecting direct browser bootstrap with `GUARD_REQUIRED`, and Guard internal RPCs requiring service role JWT claims.
- Edge Guard canonicalization: `src/features/sharing/publicGuardEdgeCanonical.test.ts` compares Guard-side JCS/NFC bytes and fingerprint against the client canonicalizer and verifies mismatched client fingerprint input returns `CHALLENGE_INVALID` before challenge creation.
- Edge Guard integration: deploy check posts to `guard-create-room`, `guard-prepare-join`, and `guard-prepare-restore` and requires the stable unauthenticated envelope `{ ok: false, error: { code: "AUTH_REQUIRED", contract_version: 2 } }`. It then creates an anonymous Supabase session, creates one disposable sharing room through Guard, verifies Guard create/join/restore challenge success, verifies direct DB bootstrap RPC rejection with `GUARD_REQUIRED`, and verifies fingerprint mismatch, missing challenge, reused create challenge, wrong-purpose challenge, and public Guard rate limit rejection.
- Mutating release check: the public Guard release check intentionally creates one short-lived disposable room in the target Supabase project. This is the release equivalent of a real door test: the check is not considered complete if it only confirms the sign on the door.

## Commands

```powershell
npm run typecheck
npm run sharing:public-guard:unit
npm run db:test
$env:VITE_SHARING_PUBLIC_GATE_ENABLED='true'
$env:VITE_SHARING_EDGE_GUARD_URL='<deployed-or-local-functions-base-url>'
$env:VITE_SHARING_CONTRACT_VERSION='2'
$env:SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK='true'
$env:SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK='true'
npm run sharing:public-guard:check
```
