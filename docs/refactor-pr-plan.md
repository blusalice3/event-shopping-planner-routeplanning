# Refactor PR Plan

## PR-1: App persistence/settings split (completed)

- Move theme mode logic from `src/App.tsx` to `src/hooks/useThemeMode.ts`.
- Move UI visibility settings state/persistence from `src/App.tsx` to `src/hooks/useUIVisibilitySettings.ts`.
- Move IndexedDB load/save flow from `src/App.tsx` to `src/hooks/useIndexedDbPersistence.ts`.

## PR-2: Dead code cleanup (completed)

- Remove unused backup file `src/components/FocusMode_backup.tsx`.

## PR-3: Pure utility extraction (completed)

- Move event date extraction logic from `src/App.tsx` to `src/utils/eventDates.ts`.

## PR-4: App domain split (completed)

- Extract event CRUD/update/import logic from `src/App.tsx` into `src/features/events/`.
- Keep `App.tsx` as composition + routing/state wiring.
- Done: event update diff and URL normalization logic extracted to `src/features/events/updateDiff.ts`.
- Done: spreadsheet CSV fetch/parse logic extracted to `src/features/events/sheetImport.ts`.
- Done: update confirmation apply/delete logic extracted to `src/features/events/updateApply.ts`.
- Done: spreadsheet source resolution + update diff build flow extracted to `src/features/events/updateFlow.ts`.
- Done: event delete/rename record operations extracted to `src/features/events/recordOps.ts`.
- Done: xlsx import result normalization extracted to `src/features/events/fileImport.ts`.
- Done: xlsx export file build flow extracted to `src/features/events/exportFlow.ts`.
- Done: export precondition check extracted to `src/features/events/exportFlow.ts`.
- Done: event bulk-add create/init domain logic extracted to `src/features/events/bulkAdd.ts`.
- Done: post bulk-add UI orchestration extracted to `src/features/events/bulkAdd.ts`.
- Done: event tab/notification UI orchestration extracted to `src/features/events/uiOrchestration.ts`.

## PR-5: Map/focus split (completed)

- Extract map tab and hall-related selectors into dedicated hooks in `src/features/map/hooks/`.
- Split `FocusMode` and `MapCanvas` into container/presentation components.
- Done: map tab/hall-related selectors extracted to `src/features/map/hooks/useMapSelectors.ts`.
- Done: `MapCanvas` rendering extracted to `src/components/map/MapCanvasPresentation.tsx` (container/presentation split).
- Done: `FocusMode` input composition extracted to `src/features/map/components/FocusModeContainer.tsx`.
- Done: map-visible `FocusMode` panels (`Header` / `ItemList` / `MapControls`) extracted to `src/components/focus/FocusModePanels.tsx`.
- Done: non-map `FocusMode` header/item list also switched to `FocusModePanels`, removing duplicated panel JSX.

## PR-6: Safety net (completed)

- Add tests for `src/utils/itemComparison.ts`, `src/utils/pathfinding.ts`, and `src/utils/eventDates.ts`.
- Introduce lint/format rules and incremental cleanup.
- Done: added Vitest test runner setup (`vitest.config.ts`, `npm run test`, `npm run test:run`).
- Done: added utility tests for `src/utils/itemComparison.ts`, `src/utils/pathfinding.ts`, and `src/utils/eventDates.ts`.
- Done: audited dependencies and applied non-breaking fixes (`npm audit fix`) plus removed unused vulnerable `xlsx` dependency.
- Decision: keep remaining 6 dev-only vulnerabilities for now because fixes require SemVer major upgrades (`vite@7`, `vitest@4`, `vite-plugin-pwa@1`) and should be handled in a dedicated upgrade PR.
- Done: introduced ESLint/Prettier tooling (`.eslintrc.cjs`, `.prettierrc.json`, ignore files, lint/format scripts in `package.json`).
- Done: fixed remaining `react-hooks/exhaustive-deps` warnings in `src/App.tsx`, `src/components/EventListScreen.tsx`, and `src/hooks/useIndexedDbPersistence.ts`.
- Done: `npm run lint` is now clean (0 errors / 0 warnings).
- Done: applied staged Prettier cleanup (batch 1/2) and `npm run format:check` is now clean.
