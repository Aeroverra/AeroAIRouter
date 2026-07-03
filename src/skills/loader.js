// Skills: reusable, on-demand instruction packs. Each skill is a folder
//   AIROUTER_HOME/skills/<slug>/SKILL.md
// whose markdown starts with a YAML-ish frontmatter block:
//   ---
//   name: My Skill
//   description: One line the model reads to decide whether to load this skill.
//   ---
//   <the full instructions / knowledge>
//
// Progressive disclosure: only each enabled skill's name + description go into
// the stable system prompt (cheap, cache-friendly). The bot loads a skill's full
// body on demand with the `use_skill` tool. Extra reference files can live beside
// SKILL.md and be read with read_file.
//
// Imports ONLY paths.js — never config/index.js — so the config UI can use it.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { SKILLS_DIR } from "../config/paths.js";

export { SKILLS_DIR };

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function slugify(name) {
  const s = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 64);
}
export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && slug.length <= 64;
}

// Parse a leading `--- ... ---` frontmatter block. Only name/description are
// meaningful; everything after the closing fence is the body. Tolerant: a file
// with no frontmatter still works (name = slug, description empty).
export function parseSkill(md) {
  const text = String(md || "");
  const m = text.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const meta = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      meta[kv[1].toLowerCase()] = val;
    }
  }
  return { name: meta.name || "", description: meta.description || "", body: body.replace(/^\s+/, "") };
}

// Reassemble a SKILL.md from parts.
export function composeSkill({ name, description, body }) {
  const fm = "---\nname: " + (name || "") + "\ndescription: " + String(description || "").replace(/\r?\n/g, " ").trim() + "\n---\n\n";
  return fm + String(body || "").replace(/^\s+/, "");
}

function skillPath(slug) {
  return join(SKILLS_DIR, slug, "SKILL.md");
}

// Every skill folder that contains a SKILL.md, with parsed metadata + size. Does
// not read the full body (kept cheap for listing).
export function discoverSkills() {
  if (!existsSync(SKILLS_DIR)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() || !isValidSlug(e.name)) continue;
    const p = skillPath(e.name);
    if (!existsSync(p)) continue;
    try {
      const md = readFileSync(p, "utf8");
      const parsed = parseSkill(md);
      out.push({
        slug: e.name,
        name: parsed.name || e.name,
        description: parsed.description || "",
        bytes: statSync(p).size,
        error: null,
      });
    } catch (err) {
      out.push({ slug: e.name, name: e.name, description: "", bytes: 0, error: err.message });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Enabled unless explicitly listed in config.skills.disabled. (User-authored
// skills default to on.)
export function isSkillEnabled(slug, config) {
  const dis = config && config.skills && Array.isArray(config.skills.disabled) ? config.skills.disabled : [];
  return !dis.includes(slug);
}

export function readSkill(slug) {
  if (!isValidSlug(slug)) throw new Error("invalid skill name");
  const p = skillPath(slug);
  if (!existsSync(p)) throw new Error("skill not found");
  return parseSkill(readFileSync(p, "utf8"));
}

export function readSkillRaw(slug) {
  if (!isValidSlug(slug)) throw new Error("invalid skill name");
  const p = skillPath(slug);
  if (!existsSync(p)) throw new Error("skill not found");
  return readFileSync(p, "utf8");
}

// Create or overwrite a skill. Returns the slug used.
export function writeSkill(slug, { name, description, body }) {
  if (!isValidSlug(slug)) throw new Error("invalid skill name");
  const dir = join(SKILLS_DIR, slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(skillPath(slug), composeSkill({ name, description, body }), "utf8");
  return slug;
}

export function deleteSkill(slug) {
  if (!isValidSlug(slug)) throw new Error("invalid skill name");
  const dir = join(SKILLS_DIR, slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// The system-prompt section listing enabled skills (name + description + slug).
// Empty string when there are no enabled skills.
export function buildSkillsPromptSection(config) {
  const skills = discoverSkills().filter((s) => !s.error && isSkillEnabled(s.slug, config));
  if (!skills.length) return "";
  const lines = skills.map((s) => "- " + s.name + " — " + (s.description || "(no description)") + '  [use_skill "' + s.slug + '"]');
  return (
    "\n\n# SKILLS\n\n" +
    "You have these skills available — each is a set of instructions/knowledge you can load ON DEMAND. " +
    "When a task matches a skill's description, call the `use_skill` tool with its slug to load the full instructions, then follow them. " +
    "Do not load a skill unless it is relevant.\n" +
    lines.join("\n")
  );
}
