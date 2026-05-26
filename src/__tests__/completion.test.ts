import { describe, it, expect } from "vitest";
import { detectDoneTag, detectCheckTag, DONE_TAG, CHECK_TAG } from "../completion.js";

describe("DONE_TAG regex", () => {
  it("should match standard done tag", () => {
    expect("<promise>done</promise>").toMatch(DONE_TAG);
  });

  it("should match done tag with spaces", () => {
    expect("<promise> done </promise>").toMatch(DONE_TAG);
  });

  it("should match case-insensitive", () => {
    expect("<PROMISE>DONE</PROMISE>").toMatch(DONE_TAG);
    expect("<Promise>Done</Promise>").toMatch(DONE_TAG);
  });

  it("should not match false positives", () => {
    expect("<promise>pending</promise>").not.toMatch(DONE_TAG);
    expect("<promise>d one</promise>").not.toMatch(DONE_TAG);
    expect("<div>done</div>").not.toMatch(DONE_TAG);
  });
});

describe("CHECK_TAG regex", () => {
  it("should match true check tag", () => {
    const match = "<promise-check>true</promise-check>".match(CHECK_TAG);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("true");
  });

  it("should match false check tag", () => {
    const match = "<promise-check>false</promise-check>".match(CHECK_TAG);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("false");
  });

  it("should match with spaces around value", () => {
    const match = "<promise-check> true </promise-check>".match(CHECK_TAG);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("true");
  });

  it("should match case-insensitive", () => {
    expect(detectDoneTag("<PROMISE>done</PROMISE>")).toBe(true);
    const match = "<PROMISE-CHECK>TRUE</PROMISE-CHECK>".match(CHECK_TAG);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("TRUE");
  });

  it("should not match random xml", () => {
    expect("<promise-check>yes</promise-check>").not.toMatch(CHECK_TAG);
    expect("<check>true</check>").not.toMatch(CHECK_TAG);
  });
});

describe("detectDoneTag", () => {
  it("should return true for done tag", () => {
    expect(detectDoneTag("<promise>done</promise>")).toBe(true);
  });

  it("should return true for done tag within longer text", () => {
    expect(detectDoneTag("Task complete. <promise>done</promise>")).toBe(true);
  });

  it("should return false when no done tag", () => {
    expect(detectDoneTag("Task in progress...")).toBe(false);
  });

  it("should return false for empty string", () => {
    expect(detectDoneTag("")).toBe(false);
  });
});

describe("detectCheckTag", () => {
  it("should return true for pass result", () => {
    expect(detectCheckTag("<promise-check>true</promise-check>")).toBe(true);
  });

  it("should return false for fail result", () => {
    expect(detectCheckTag("<promise-check>false</promise-check>")).toBe(false);
  });

  it("should return null when no check tag", () => {
    expect(detectCheckTag("No check result here.")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(detectCheckTag("")).toBeNull();
  });

  it("should handle multiline text with check tag embedded", () => {
    const text = `Review complete.
All tests pass.
<promise-check>true</promise-check>`;
    expect(detectCheckTag(text)).toBe(true);
  });

  it("should handle multiline text with false check tag", () => {
    const text = `Review complete.
Issues found:
- Missing tests
<promise-check>false</promise-check>`;
    expect(detectCheckTag(text)).toBe(false);
  });

  it("should detect check tag even when done tag is also present", () => {
    const text = `The task is done.
<promise>done</promise>
<promise-check>true</promise-check>`;
    expect(detectCheckTag(text)).toBe(true);
  });
});
