import { installXlsxWorkerServer, type WorkerEndpoint } from "./workerServer";
import { xlsxWorkerExecutor } from "./workerExecutor";

installXlsxWorkerServer(
  globalThis as unknown as WorkerEndpoint,
  xlsxWorkerExecutor,
);
