import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// No YAML parser exists and none may be added, so the file is read as text by job section.
const workflow = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');

const [head, jobs = ''] = workflow.split(/^jobs:$/m);
const [build, publish = ''] = jobs.split(/^ {2}publish:$/m);

const stepWith = (text) => publish.split(/^ {6}- /m).filter((step) => step.includes(text));

describe('release workflow, workflow level', () => {
  it('grants nothing by default', () => {
    const line = head.match(/^permissions:.*$/m);
    if (line) expect(line[0]).toBe('permissions: {}');
  });

  it('has both jobs', () => {
    expect(jobs).toMatch(/^ {2}build:$/m);
    expect(workflow).toMatch(/^ {2}publish:$/m);
  });

  it('pins every action to a commit with the version as a comment', () => {
    const uses = workflow.split('\n').filter((line) => /^\s*(- )?uses:/.test(line));
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40} #/);
  });

  it('never interpolates the tag into a shell line', () => {
    expect(workflow).not.toContain('${{ github.ref');
  });
});

describe('release workflow, build job', () => {
  it('reads the repository without keeping a credential', () => {
    expect(build).toContain('contents: read');
    expect(build).toContain('persist-credentials: false');
  });

  it('runs the repository code', () => {
    expect(build).toContain('run: npm ci');
  });

  it('holds no token and cannot write', () => {
    expect(build).not.toContain('GH_TOKEN');
    expect(build).not.toContain('contents: write');
    expect(build).not.toContain('gh release');
  });

  it('uploads the zip and the notes, last, and fails when they are missing', () => {
    const upload = build.slice(build.indexOf('actions/upload-artifact@'));
    expect(build).toContain('actions/upload-artifact@');
    expect(upload).toContain('voicetype-*.zip');
    expect(upload).toContain('notes.md');
    expect(upload).toContain('if-no-files-found: error');
    expect(upload).not.toContain('run:');
    expect(build.indexOf('notes.md')).toBeLessThan(build.indexOf('actions/upload-artifact@'));
  });
});

describe('release workflow, publish job', () => {
  it('waits for the build and alone may write', () => {
    expect(publish).toContain('needs: build');
    expect(publish).toContain('contents: write');
  });

  it('downloads the artifact the build uploaded', () => {
    const name = build.match(/^ {10}name: (\S+)$/m)?.[1];
    expect(name).toBeTruthy();
    expect(publish).toContain('actions/download-artifact@');
    expect(publish).toMatch(new RegExp(`^ {10}name: ${name}$`, 'm'));
  });

  it('runs no repository code', () => {
    expect(publish).not.toContain('npm');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('node ');
  });

  it('creates the release from the tag in the environment, quoted', () => {
    expect(publish).toContain(
      'run: gh release create "$GITHUB_REF_NAME" voicetype-*.zip --verify-tag --notes-file notes.md',
    );
  });

  it('holds the token and the repository in that one step', () => {
    expect(stepWith('GH_TOKEN')).toHaveLength(1);
    const [step] = stepWith('gh release create');
    expect(step).toContain('GH_TOKEN: ${{ github.token }}');
    expect(step).toContain('GH_REPO: ${{ github.repository }}');
  });
});
