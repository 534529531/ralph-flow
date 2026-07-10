import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { setup } from "../setup.js";

let projectDir: string;
let globalHome: string;
let savedXdg: string | undefined;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-proj-"));
  globalHome = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-home-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = globalHome;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(globalHome, { recursive: true, force: true });
});

describe("setup — skills go to the global dir, not the project", () => {
  it("writes the bundled skills into ~/.config/opencode/skills and NOT the project", () => {
    setup(projectDir);
    const globalSkills = path.join(globalHome, "opencode", "skills");
    // A representative bundled skill lands globally with the managed marker
    expect(fs.existsSync(path.join(globalSkills, "c-to-rust-plan", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalSkills, "c-to-rust-plan", ".ralph-flow-managed"))).toBe(true);
    // The project tree stays clean
    expect(fs.existsSync(path.join(projectDir, ".opencode", "skills"))).toBe(false);
  });

  it("writes the read-only ralph-check agent into the project", () => {
    setup(projectDir);
    const agent = path.join(projectDir, ".opencode", "agents", "ralph-check.md");
    expect(fs.existsSync(agent)).toBe(true);
    expect(fs.readFileSync(agent, "utf-8")).toContain("edit: deny");
  });

  it("does not clobber a user-authored global skill of the same name", () => {
    const globalSkills = path.join(globalHome, "opencode", "skills", "c-to-rust-plan");
    fs.mkdirSync(globalSkills, { recursive: true });
    fs.writeFileSync(path.join(globalSkills, "SKILL.md"), "MY OWN SKILL");
    setup(projectDir); // no managed marker present → hands off
    expect(fs.readFileSync(path.join(globalSkills, "SKILL.md"), "utf-8")).toBe("MY OWN SKILL");
  });

  it("cleans up a managed project skill copy left by an older version", () => {
    const projSkill = path.join(projectDir, ".opencode", "skills", "c-to-rust-plan");
    fs.mkdirSync(projSkill, { recursive: true });
    fs.writeFileSync(path.join(projSkill, "SKILL.md"), "old managed copy");
    fs.writeFileSync(path.join(projSkill, ".ralph-flow-managed"), "managed");
    setup(projectDir);
    expect(fs.existsSync(projSkill)).toBe(false); // removed
  });

  it("leaves a user's own project skill untouched during cleanup", () => {
    const projSkill = path.join(projectDir, ".opencode", "skills", "my-skill");
    fs.mkdirSync(projSkill, { recursive: true });
    fs.writeFileSync(path.join(projSkill, "SKILL.md"), "user skill"); // no managed marker
    setup(projectDir);
    expect(fs.readFileSync(path.join(projSkill, "SKILL.md"), "utf-8")).toBe("user skill");
  });
});
