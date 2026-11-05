import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SkillLibrary } from '../src/server/skills.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function library() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-skills-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'weekly-review'));
  writeFileSync(
    join(dir, 'weekly-review', 'SKILL.md'),
    `---\nname: weekly-review\ndescription: How to prepare a weekly review page.\n---\n\n1. Read last week's page.\n2. Write a short summary.\n`,
  );
  writeFileSync(join(dir, 'weekly-review', 'template.md'), '# Template');
  mkdirSync(join(dir, 'broken'));
  return new SkillLibrary(dir);
}

it('lists skills from SKILL.md frontmatter with their files', () => {
  const skills = library();
  expect(skills.list()).toEqual([
    {
      name: 'weekly-review',
      description: 'How to prepare a weekly review page.',
      files: ['template.md'],
    },
  ]);
  expect(skills.catalog()).toContain('weekly-review');
  expect(skills.catalog()).toContain('load_skill');
});

it('loads a skill and its supporting files', () => {
  const skills = library();
  const load = skills.tools()[0];
  expect(load.execute).toBeDefined();
  const result = load.execute!({ name: 'weekly-review' }) as {
    instructions: string;
    files: string[];
  };
  expect(result.instructions).toContain('weekly');
  expect(result.files).toEqual(['template.md']);
  const read = skills.tools()[1].execute!({
    name: 'weekly-review',
    path: 'template.md',
  }) as { content: string };
  expect(read.content).toBe('# Template');
});

it('refuses path traversal and unknown skills', () => {
  const skills = library();
  const read = skills.tools()[1].execute!;
  expect(read({ name: 'weekly-review', path: '../../SKILL.md' })).toEqual({
    error: 'That skill file is not available.',
  });
  expect(
    read({ name: 'weekly-review', path: '../weekly-review/template.md' }),
  ).toEqual({
    error: 'That skill file is not available.',
  });
  expect(skills.tools()[0].execute!({ name: 'missing' })).toEqual({
    error: 'Unknown skill: missing',
  });
});

it('returns an empty catalogue when the directory does not exist', () => {
  const skills = new SkillLibrary(
    join(tmpdir(), 'opendots-missing-skills-dir'),
  );
  expect(skills.list()).toEqual([]);
  expect(skills.catalog()).toBe('');
});
