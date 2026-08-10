import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "unit",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [
      "src/**/*.integration.test.{ts,tsx}",
      "src/**/*.worker.test.{ts,tsx}",
    ],
    setupFiles: ["src/test/setup.ts"],
  },
});
