import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "worker",
    environment: "node",
    include: ["src/**/*.worker.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    pool: "threads",
  },
});
