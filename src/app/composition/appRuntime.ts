import { createIndexedDbPersistenceCommandAdapter } from "../../persistence/adapters/indexedDbPersistenceCommandAdapter";
import { registerUpdateBlocker } from "../../pwa/updateBlockerRegistry";
import { productionXlsxExecutionPort } from "../../xlsx/adapters/productionXlsxExecutionPort";
import { downloadBytes } from "../../xlsx/download/downloadBytes";
import type { ItemFallbackWarning } from "../../xlsx/domain/eventWorkbook";
import type { XlsxExecutionPort } from "../../xlsx/port/XlsxExecutionPort";
import type { PersistenceCommandPort } from "../ports/PersistenceCommandPort";

export type AppItemFallbackWarning = ItemFallbackWarning;

export interface AppUpdateBlocker {
  readonly id: string;
  readonly label: string;
  readonly isBlocking: () => boolean;
  readonly flush?: () => void | Promise<void>;
}

export type RegisterAppUpdateBlocker = (
  blocker: AppUpdateBlocker,
) => () => void;

export interface AppRuntime {
  readonly persistenceCommands: PersistenceCommandPort;
  readonly xlsxCommands: XlsxExecutionPort;
  readonly downloadXlsx: typeof downloadBytes;
  readonly registerUpdateBlocker: RegisterAppUpdateBlocker;
}

export const appRuntime: AppRuntime = {
  persistenceCommands: createIndexedDbPersistenceCommandAdapter(),
  xlsxCommands: productionXlsxExecutionPort,
  downloadXlsx: downloadBytes,
  registerUpdateBlocker,
};
