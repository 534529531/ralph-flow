import { describe, it, expect } from "vitest";
import { createStepRecord } from "../report.js";

describe("createStepRecord", () => {
  it("should create a passed do record", () => {
    const record = createStepRecord("step1", "do", "passed", 0);
    expect(record.stepId).toBe("step1");
    expect(record.phase).toBe("do");
    expect(record.status).toBe("passed");
    expect(record.failCount).toBe(0);
    expect(record.startTime).toBeDefined();
    expect(record.endTime).toBeDefined();
  });

  it("should create a failed check record with fail count", () => {
    const record = createStepRecord("step2", "check", "failed", 3);
    expect(record.stepId).toBe("step2");
    expect(record.phase).toBe("check");
    expect(record.status).toBe("failed");
    expect(record.failCount).toBe(3);
  });

  it("should include error when provided", () => {
    const record = createStepRecord("step3", "check", "failed", 1, "Missing tests");
    expect(record.error).toBe("Missing tests");
  });

  it("should use provided start time", () => {
    const startTime = "2024-01-01T00:00:00.000Z";
    const record = createStepRecord("step4", "do", "passed", 0, undefined, startTime);
    expect(record.startTime).toBe(startTime);
  });

  it("should have endTime set to now", () => {
    const before = new Date().toISOString();
    const record = createStepRecord("step5", "do", "passed", 0);
    const after = new Date().toISOString();
    // endTime should be between before and after (approximately)
    expect(record.endTime! >= before).toBe(true);
    expect(record.endTime! <= after).toBe(true);
  });

  it("should handle undefined error", () => {
    const record = createStepRecord("step6", "do", "passed", 0, undefined);
    expect(record.error).toBeUndefined();
  });
});
