export type ReleaseRole = "standard" | "containment";
export type ReleaseBuildPurpose =
  | "production"
  | "qa-xlsx-main"
  | "qa-list-force-full";
export type ReleaseDimensions = Readonly<Record<string, string>>;
export type ReleaseBuildInput = Readonly<{
  schemaVersion: 1;
  sourceSha: string;
  sourceState: "clean" | "dirty" | "provider-immutable";
  releaseRole: ReleaseRole;
  variantId: string;
  dimensions: ReleaseDimensions;
  dbFingerprint: string;
  buildPurpose: ReleaseBuildPurpose;
  nonPromotable: boolean;
}>;

export const RELEASE_BUILD_INPUT_ENV: string;
export const RELEASE_BUILD_PURPOSES: readonly ReleaseBuildPurpose[];

export function resolveReleaseBuildInput(options: {
  policy: {
    targetStandard: ReleaseDimensions;
    containmentProjection: Readonly<Record<string, Partial<ReleaseDimensions>>>;
    dimensions: Readonly<Record<string, readonly string[]>>;
  };
  environment?: NodeJS.ProcessEnv;
  gitSourceSha: string;
  gitSourceState: string;
  providerCommitSha?: string | null;
  cliRole?: ReleaseRole | null;
  cliDimensions?: ReleaseDimensions | null;
  cliBuildPurpose?: ReleaseBuildPurpose | null;
  defaultDbFingerprint?: string;
  requireClean?: boolean;
  requireCliForNonProduction?: boolean;
}): ReleaseBuildInput;

export function bindReleaseBuildLauncher(
  input: ReleaseBuildInput,
  policy: {
    targetStandard: ReleaseDimensions;
    containmentProjection: Readonly<Record<string, Partial<ReleaseDimensions>>>;
    dimensions: Readonly<Record<string, readonly string[]>>;
  },
): NodeJS.ProcessEnv;

export function assertReleaseBuildLauncherBinding(
  input: ReleaseBuildInput,
  policy: {
    targetStandard: ReleaseDimensions;
    containmentProjection: Readonly<Record<string, Partial<ReleaseDimensions>>>;
    dimensions: Readonly<Record<string, readonly string[]>>;
  },
  cliBuildPurpose?: ReleaseBuildPurpose | null,
): ReleaseBuildInput;
