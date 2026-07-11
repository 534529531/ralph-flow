import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import { setup } from "../setup.js";

let projectDir: string;
let globalHome: string;
let savedXdg: string | undefined;

// The plugin ships no skills by default. To keep the skill-sync behavior under
// test regardless of what (if anything) is bundled, each test seeds a throwaway
// fixture skill into the plugin's own skills/ dir and removes it afterwards.
const PLUGIN_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const FIXTURE_SKILL = "__rf_test_skill__";
const fixtureSkillDir = path.join(PLUGIN_ROOT, "skills", FIXTURE_SKILL);

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-proj-"));
  globalHome = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-flow-home-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = globalHome;
  fs.mkdirSync(fixtureSkillDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureSkillDir, "SKILL.md"), "---\nname: fixture\n---\nfixture skill\n");
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(globalHome, { recursive: true, force: true });
  fs.rmSync(fixtureSkillDir, { recursive: true, force: true });
});

describe("setup — skills go to the global dir, not the project", () => {
  it("writes the bundled skills into ~/.config/opencode/skills and NOT the project", () => {
    setup(projectDir);
    const globalSkills = path.join(globalHome, "opencode", "skills");
    // A bundled skill lands globally with the managed marker
    expect(fs.existsSync(path.join(globalSkills, FIXTURE_SKILL, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(globalSkills, FIXTURE_SKILL, ".ralph-flow-managed"))).toBe(true);
    // The project tree stays clean
    expect(fs.existsSync(path.join(projectDir, ".opencode", "skills"))).toBe(false);
  });

  it("writes the read-only ralph-check agent into the GLOBAL dir, not the project", () => {
    setup(projectDir);
    const globalAgent = path.join(globalHome, "opencode", "agent", "ralph-check.md");
    expect(fs.existsSync(globalAgent)).toBe(true);
    expect(fs.readFileSync(globalAgent, "utf-8")).toContain("edit: deny");
    // project stays clean
    expect(fs.existsSync(path.join(projectDir, ".opencode", "agents"))).toBe(false);
  });

  it("the generated agent frontmatter is valid YAML and encodes a read-only bash allow-list", () => {
    setup(projectDir);
    const raw = fs.readFileSync(path.join(globalHome, "opencode", "agent", "ralph-check.md"), "utf-8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(fm).not.toBeNull();
    const meta = yaml.load(fm![1]) as any;
    expect(meta.permission.edit).toBe("deny");
    expect(meta.permission.external_directory).toBe("allow"); // extra_dirs must stay readable
    expect(meta.permission.bash["*"]).toBe("deny");           // deny by default
    expect(meta.permission.bash["cat *"]).toBe("allow");
    expect(meta.permission.bash["cargo test *"]).toBe("allow");
    expect(meta.permission.bash["rm *"]).toBeUndefined();      // mutating → not allow-listed
  });

  it("does not clobber a user's own global ralph-check agent", () => {
    const globalAgent = path.join(globalHome, "opencode", "agent", "ralph-check.md");
    fs.mkdirSync(path.dirname(globalAgent), { recursive: true });
    fs.writeFileSync(globalAgent, "MY OWN AGENT"); // no managed marker
    setup(projectDir);
    expect(fs.readFileSync(globalAgent, "utf-8")).toBe("MY OWN AGENT");
  });

  it("cleans up a project agent copy left by an older version", () => {
    const projAgent = path.join(projectDir, ".opencode", "agents", "ralph-check.md");
    fs.mkdirSync(path.dirname(projAgent), { recursive: true });
    fs.writeFileSync(projAgent, "old copy");
    setup(projectDir);
    expect(fs.existsSync(projAgent)).toBe(false);
  });

  it("does not clobber a user-authored global skill of the same name", () => {
    // A user owns a skill named exactly like the bundled fixture, without a marker.
    const globalSkills = path.join(globalHome, "opencode", "skills", FIXTURE_SKILL);
    fs.mkdirSync(globalSkills, { recursive: true });
    fs.writeFileSync(path.join(globalSkills, "SKILL.md"), "MY OWN SKILL");
    setup(projectDir); // no managed marker present → hands off
    expect(fs.readFileSync(path.join(globalSkills, "SKILL.md"), "utf-8")).toBe("MY OWN SKILL");
  });

  it("cleans up a managed project skill copy left by an older version", () => {
    const projSkill = path.join(projectDir, ".opencode", "skills", "sample-skill");
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
