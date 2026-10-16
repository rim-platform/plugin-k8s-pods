import { defineConfig } from "vitest/config";

// The plugin is a Node program; the panel tests pick jsdom for themselves.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
