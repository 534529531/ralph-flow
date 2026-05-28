import { describe, it, expect } from "vitest";
import {
  parseCheckResult,
  extractResponseText,
  getAdversarialFailureReason,
} from "../executor.js";

describe("parseCheckResult", () => {
  it("should return true for <promise-check>true</promise-check>", () => {
    const text = "检查通过\n<promise-check>true</promise-check>";
    expect(parseCheckResult(text)).toBe(true);
  });

  it("should return false for <promise-check>false</promise-check>", () => {
    const text = "检查失败\n<promise-check>false</promise-check>";
    expect(parseCheckResult(text)).toBe(false);
  });

  it("should return false when tag is not on last line", () => {
    const text = "<promise-check>true</promise-check>\n这是最后一行";
    expect(parseCheckResult(text)).toBe(false);
  });

  it("should return false when no tag is present", () => {
    const text = "检查通过，所有测试都成功了";
    expect(parseCheckResult(text)).toBe(false);
  });

  it("should handle case insensitive tags", () => {
    const text = "检查\n<PROMISE-CHECK>TRUE</PROMISE-CHECK>";
    expect(parseCheckResult(text)).toBe(true);
  });

  it("should handle tag with whitespace", () => {
    const text = "检查\n<promise-check>  true  </promise-check>";
    expect(parseCheckResult(text)).toBe(true);
  });

  it("should return false for empty response", () => {
    expect(parseCheckResult("")).toBe(false);
  });

  it("should handle single line response with tag", () => {
    const text = "<promise-check>false</promise-check>";
    expect(parseCheckResult(text)).toBe(false);
  });

  it("should return true when tag is on last line with other content before", () => {
    const text = "分析过程...\n详细检查...\n<promise-check>true</promise-check>";
    expect(parseCheckResult(text)).toBe(true);
  });
});

describe("extractResponseText", () => {
  it("should extract text parts only", () => {
    const response = {
      data: {
        parts: [
          { type: "text", text: "Hello " },
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "World" },
        ],
      },
    };
    expect(extractResponseText(response)).toBe("Hello \nWorld");
  });

  it("should return empty string for no parts", () => {
    const response = { data: {} };
    expect(extractResponseText(response)).toBe("");
  });

  it("should return empty string for null data", () => {
    const response = { data: null };
    expect(extractResponseText(response)).toBe("");
  });

  it("should handle missing text field in text part", () => {
    const response = {
      data: {
        parts: [
          { type: "text" },
          { type: "text", text: "valid" },
        ],
      },
    };
    expect(extractResponseText(response)).toBe("\nvalid");
  });

  it("should handle empty parts array", () => {
    const response = { data: { parts: [] } };
    expect(extractResponseText(response)).toBe("");
  });
});

describe("getAdversarialFailureReason", () => {
  it("should extract content before last line", () => {
    const text = "失败原因1\n失败原因2\n<promise-check>false</promise-check>";
    expect(getAdversarialFailureReason(text)).toBe("失败原因1\n失败原因2");
  });

  it("should truncate to 1000 characters", () => {
    const longReason = "a".repeat(1500);
    const text = longReason + "\n<promise-check>false</promise-check>";
    const result = getAdversarialFailureReason(text);
    expect(result.length).toBe(1003); // 1000 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("should not truncate if under 1000 characters", () => {
    const shortReason = "a".repeat(500);
    const text = shortReason + "\n<promise-check>false</promise-check>";
    expect(getAdversarialFailureReason(text)).toBe(shortReason);
  });

  it("should handle empty content before last line", () => {
    const text = "\n<promise-check>false</promise-check>";
    expect(getAdversarialFailureReason(text)).toBe("");
  });

  it("should trim whitespace", () => {
    const text = "  原因  \n<promise-check>false</promise-check>";
    expect(getAdversarialFailureReason(text)).toBe("原因");
  });

  it("should handle multi-line reason", () => {
    const text = "原因1\n原因2\n原因3\n<promise-check>false</promise-check>";
    expect(getAdversarialFailureReason(text)).toBe("原因1\n原因2\n原因3");
  });
});
