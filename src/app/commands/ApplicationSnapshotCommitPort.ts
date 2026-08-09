import type { PersistenceSnapshot } from "../ports/PersistenceCommandPort";
import type { BlockDetectionSettings } from "../../types/map";

export type ApplicationSnapshotPatch = Partial<PersistenceSnapshot>;

export interface ApplicationSnapshotCommitPort {
  commitApplicationSnapshotPatch(
    patch: ApplicationSnapshotPatch,
    blockDetectionSettings?: {
      eventName: string;
      settings: BlockDetectionSettings | null;
    },
  ): Promise<void>;
}
