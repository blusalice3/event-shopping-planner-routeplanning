import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "integration",
    environment: "jsdom",
    include: ["src/**/*.integration.test.{ts,tsx}"],
    exclude: ["src/**/*.worker.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
