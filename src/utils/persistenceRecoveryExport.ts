import { downloadBlob } from "./downloadBlob";
import {
  serializeStartupRecoveryBundle,
  type StartupRecoveryBundle,
} from "./persistenceResilience";

export type PersistenceRecoveryExportResult =
  | {
      status: "completed";
      fileName: string;
      byteSize: number;
    }
  | {
      status: "failed";
    };

interface PersistenceRecoveryExportDependencies {
  serialize(bundle: StartupRecoveryBundle): string;
  createBlob(parts: BlobPart[], options: BlobPropertyBag): Blob;
  download(blob: Blob, fileName: string): void;
  now(): Date;
}

const defaultDependencies: PersistenceRecoveryExportDependencies = {
  serialize: serializeStartupRecoveryBundle,
  createBlob: (parts, options) => new Blob(parts, options),
  download: downloadBlob,
  now: () => new Date(),
};

export function exportStartupRecoveryBundle(
  bundle: StartupRecoveryBundle,
  dependencyOverrides: Partial<PersistenceRecoveryExportDependencies> = {},
): PersistenceRecoveryExportResult {
  const dependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  try {
    const serialized = dependencies.serialize(bundle);
    if (typeof serialized !== "string" || serialized.length === 0) {
      return { status: "failed" };
    }
    const blob = dependencies.createBlob([serialized], {
      type: "application/json;charset=utf-8",
    });
    if (!Number.isSafeInteger(blob.size) || blob.size <= 0) {
      return { status: "failed" };
    }
    const exportedAt = dependencies.now().toISOString();
    const fileName = `event-shopping-planner-recovery-${exportedAt.replace(
      /[:.]/g,
      "-",
    )}.json`;
    dependencies.download(blob, fileName);
    return {
      status: "completed",
      fileName,
      byteSize: blob.size,
    };
  } catch {
    return { status: "failed" };
  }
}
