import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChangelogError,
  DEFAULT_PATHS,
  checkProject,
  deriveLiveEndpoints,
  extractApiVersions,
  extractDeprecations,
  extractSpecEndpoints,
  formatResult,
  main,
  parseChangelog,
  runChecks,
} from './check-api-changelog.mjs';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryFile(prefix, name, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function apiVersionFixture(supported = ['v1']) {
  return [
    `export const SUPPORTED_VERSIONS: readonly string[] = ${JSON.stringify(supported)};`,
    `export const DEFAULT_API_VERSION = '${supported[0] ?? 'v1'}';`,
    '',
  ].join('\n');
}

function deprecationsFixture(deprecations = []) {
  const items = deprecations.map(
    ({ route, sunsetDate }) => `  {
    route: '${route}',
    sunsetDate: '${sunsetDate}',
    link: '/docs/api/deprecation-policy.md',
  },`,
  );
  return [
    "import { DeprecatedRoute } from '../middleware/deprecation.ts';",
    'export const routeDeprecations: readonly DeprecatedRoute[] = [',
    items.join('\n'),
    '];',
    '',
  ].join('\n');
}

function specFixture(endpoints) {
  const lines = ['openapi: 3.1.0', 'info:', '  title: test', '  version: test', 'paths:'];
  for (const [entryPath, methods] of Object.entries(endpoints)) {
    lines.push(`  ${entryPath}:`);
    for (const method of methods) lines.push(`    ${method.toLowerCase()}:`);
  }
  lines.push('components:');
  lines.push('  securitySchemes:');
  lines.push('    bearer:');
  lines.push('      type: http');
  return `${lines.join('\n')}\n`;
}

const defaultSpec = {
  '/api/hello': ['GET', 'POST'],
};

const happyChangelog = `# Test

Some prose about the changelog.

## v1

### Added

- \`*\` — Version negotiation via the \`Accept-Version\` header.
- \`GET /api/hello\` — A test endpoint.
- \`POST /api/hello\` — Another test endpoint.

### Deprecated

- \`ALL /api/rate-limits/config\` — Planned removal on 2026-09-30.

### Removed

- \`GET /api/gone\` [breaking] — Removed from v1.
`;

const happyDeprecations = [{ route: '/api/rate-limits/config', sunsetDate: '2026-09-30T00:00:00.000Z' }];

function happyChecks(overrides = {}) {
  return runChecks({
    changelogText: overrides.changelogText ?? happyChangelog,
    specText: specFixture(overrides.spec ?? defaultSpec),
    apiVersionText: overrides.apiVersionText ?? apiVersionFixture(),
    deprecationsText: overrides.deprecationsText ?? deprecationsFixture(happyDeprecations),
  });
}

describe('parseChangelog', () => {
  it('parses sections and entries', () => {
    const { sections } = parseChangelog(happyChangelog);
    expect(sections.map((section) => section.version)).toEqual(['v1']);
    expect(sections[0].entries.map((entry) => entry.kind)).toEqual(['Added', 'Added', 'Added', 'Deprecated', 'Removed']);
    expect(sections[0].entries.find((entry) => entry.path === '/api/gone')).toMatchObject({
      method: 'GET',
      breaking: true,
    });
    expect(sections[0].entries.find((entry) => entry.scope === '*')).toMatchObject({
      method: '*',
      path: '*',
      breaking: false,
    });
  });

  it('requires newest sections first', () => {
    const doc = '## v1\n\n## v2\n\n### Added\n\n- `GET /api/hello` — second.\n';
    expect(() => parseChangelog(doc)).toThrowError(/newest first/);
  });

  it('rejects duplicate version sections', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello` — one.\n\n## v1\n\n### Added\n\n- `GET /api/hello` — two.\n';
    expect(() => parseChangelog(doc)).toThrowError(/duplicate section/);
  });

  it('rejects unknown change groups', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello` — one.\n\n### Improved\n\n- `GET /api/hello` — two.\n';
    expect(() => parseChangelog(doc)).toThrowError(/unknown change group/);
  });

  it('rejects entry bullets inside a section but outside a change group', () => {
    const doc = '## v1\n\n- `GET /api/hello` — misplaced entry.\n';
    expect(() => parseChangelog(doc)).toThrowError(/outside of a version section and change group/);
  });

  it('ignores preamble documentation before the first version section', () => {
    const doc = '# API Changelog\n\n## Scope\n\n- `GET /api/streams` — an example scope.\n\n## v1\n\n### Added\n\n- `GET /api/hello` — real entry.\n';
    const { sections } = parseChangelog(doc);
    expect(sections.map((section) => section.version)).toEqual(['v1']);
    expect(sections[0].entries).toHaveLength(1);
  });

  it('rejects invalid scope tokens', () => {
    const doc = '## v1\n\n### Added\n\n- `GET` — no path.\n';
    expect(() => parseChangelog(doc)).toThrowError(/invalid scope token/);
  });

  it('rejects missing descriptions', () => {
    const doc = '## v1\n\n### Added\n\n- `GET /api/hello`\n';
    expect(() => parseChangelog(doc)).toThrowError(/description/);
  });

  it('rejects headings deeper than ###', () => {
    const doc = '## v1\n\n### Added\n\n#### In depth\n';
    expect(() => parseChangelog(doc)).toThrowError(/only/);
  });
});

describe('extractApiVersions', () => {
  it('parses supported versions and default', () => {
    const { supported, defaultVersion } = extractApiVersions(apiVersionFixture(['v1', 'v2']));
    expect(supported).toEqual(['v1', 'v2']);
    expect(defaultVersion).toBe('v1');
  });

  it('fails closed when the declaration changes shape', () => {
    expect(() => extractApiVersions('export const SUPPORTED_VERSIONS = ["v1"];')).toThrowError(/unable to locate/);
  });

  it('rejects non-version values', () => {
    expect(() => extractApiVersions(apiVersionFixture(['v1', 'unstable']))).toThrowError(/not an API version/);
  });
});

describe('extractDeprecations', () => {
  it('parses route and sunset date pairs in order', () => {
    const deprecations = [
      { route: '/api/a', sunsetDate: '2026-09-30T00:00:00.000Z' },
      { route: '/api/b', sunsetDate: '2027-01-01T00:00:00.000Z' },
    ];
    expect(extractDeprecations(deprecationsFixture(deprecations))).toEqual(deprecations);
  });

  it('fails closed when the registry cannot be found', () => {
    expect(() => extractDeprecations('export const others = [];')).toThrowError(/unable to locate/);
  });

  it('rejects an unparseable sunset date', () => {
    const text = deprecationsFixture([{ route: '/api/a', sunsetDate: 'not-a-date' }]);
    expect(() => extractDeprecations(text)).toThrowError(/invalid sunset date/);
  });
});

describe('extractSpecEndpoints', () => {
  it('extracts methods and paths', () => {
    const endpoints = extractSpecEndpoints(specFixture({ '/api/hello': ['GET', 'POST'], '/api/bye/{id}': ['DELETE'] }));
    expect([...endpoints].sort()).toEqual(['DELETE /api/bye/{id}', 'GET /api/hello', 'POST /api/hello']);
  });

  it('ignores non-path sections and comments', () => {
    const text = [
      'openapi: 3.1.0',
      '# leading comment',
      'info:',
      '  title: test',
      'paths:',
      '  # a commented-out path',
      '  /api/hello:',
      '    # a commented-out method',
      '    hum:',
      'components:',
      '  schemas:',
      '    Thing:',
      '      type: object',
    ].join('\n');
    expect([...extractSpecEndpoints(text)]).toEqual([]);
  });
});

describe('deriveLiveEndpoints', () => {
  it('resolves state newest first, removal wins', () => {
    const { sections } = parseChangelog([
      '## v2',
      '',
      '### Removed',
      '',
      '- `GET /api/hello` [breaking] — retired.',
      '',
      '### Added',
      '',
      '- `GET /api/world` — new.',
      '',
      '## v1',
      '',
      '### Added',
      '',
      '- `GET /api/hello` — added.',
    ].join('\n'));
    expect([...deriveLiveEndpoints(sections)].sort()).toEqual(['GET /api/world']);
  });
});

describe('runChecks', () => {
  it('passes for a consistent changelog', () => {
    const result = happyChecks();
    expect(result.errors).toEqual([]);
  });

  it('requires a changelog entry when an endpoint is added to the spec', () => {
    const result = happyChecks({ spec: { ...defaultSpec, '/api/hello': ['GET'], '/api/other': ['POST'] } });
    expect(result.errors.join('\n')).toMatch(/POST \/api\/other.*no live changelog entry/);
  });

  it('rejects Added entries for endpoints absent from the spec', () => {
    const changelogText = `${happyChangelog}\n### Changed\n\n- \`GET /api/missing\` — mystery endpoint.\n\n`;
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/GET \/api\/missing/);
  });

  it('rejects removal records without an explicit breaking marker', () => {
    const changelogText = happyChangelog.replace('- `GET /api/gone` [breaking]', '- `GET /api/gone`');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/must be marked \[breaking\]/);
  });

  it('rejects a removal while the endpoint still exists in the spec', () => {
    const result = happyChecks({ spec: { ...defaultSpec, '/api/gone': ['GET'] } });
    expect(result.errors.join('\n')).toMatch(/recorded as Removed but still exists/);
  });

  it('forbids the breaking marker on Added and Deprecated entries', () => {
    const changelogText = happyChangelog.replace('- `*` — Version', '- `*` [breaking] — Version');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/must not carry the \[breaking\] marker/);
  });

  it('requires served versions to have a section', () => {
    const result = happyChecks({ apiVersionText: apiVersionFixture(['v1', 'v2']) });
    expect(result.errors.join('\n')).toMatch(/v2 is served.*no changelog section/);
  });

  it('requires the head section to be a served version', () => {
    const changelogText = happyChangelog.replace('## v1', '## v2');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/first changelog section is v2/);
  });

  it('requires registered deprecations to be announced with their sunset date', () => {
    const changelogText = happyChangelog.replace('— Planned removal on 2026-09-30.', '— Planned removal soon.');
    const result = happyChecks({ changelogText });
    expect(result.errors.join('\n')).toMatch(/2026-09-30/);
  });

  it('requires announced deprecations to be registered', () => {
    const dp = happyDeprecations.slice(0, 0);
    const result = happyChecks({ deprecationsText: deprecationsFixture(dp) });
    expect(result.errors.join('\n')).toMatch(/is not registered in src\/config\/deprecations.ts/);
  });
});

describe('checkProject and CLI', () => {
  it('passes for the committed repository', () => {
    const root = process.cwd();
    const result = checkProject({
      changelogPath: path.resolve(root, DEFAULT_PATHS.changelog),
      specPath: path.resolve(root, DEFAULT_PATHS.spec),
      apiVersionPath: path.resolve(root, DEFAULT_PATHS.apiVersion),
      deprecationsPath: path.resolve(root, DEFAULT_PATHS.deprecations),
    });
    expect(result.errors).toEqual([]);
  });

  it('reports missing files', () => {
    const result = checkProject({
      changelogPath: path.join(os.tmpdir(), 'does-not-exist.md'),
      specPath: path.join(os.tmpdir(), 'does-not-exist.yaml'),
      apiVersionPath: path.join(os.tmpdir(), 'does-not-exist.ts'),
      deprecationsPath: path.join(os.tmpdir(), 'does-not-exist.ts'),
    });
    expect(result.errors.length).toBe(4);
    expect(result.errors[0]).toMatch(/missing/);
  });

  it('returns exit code 0 for a consistent project and 1 otherwise', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxora-changelog-cli-'));
    temporary.push(directory);
    fs.writeFileSync(path.join(directory, 'changelog.md'), happyChangelog);
    fs.writeFileSync(path.join(directory, 'openapi.yaml'), specFixture(defaultSpec));
    fs.writeFileSync(path.join(directory, 'api-version.ts'), apiVersionFixture());
    fs.writeFileSync(path.join(directory, 'deprecations.ts'), deprecationsFixture(happyDeprecations));

    const args = [
      '--changelog',
      'changelog.md',
      '--spec',
      'openapi.yaml',
      '--api-version',
      'api-version.ts',
      '--deprecations',
      'deprecations.ts',
    ];
    expect(main(args, directory)).toBe(0);

    fs.writeFileSync(path.join(directory, 'openapi.yaml'), specFixture({ ...defaultSpec, '/api/new': ['GET'] }));
    expect(main(args, directory)).toBe(1);
  });
});

describe('formatResult', () => {
  it('summarizes failures', () => {
    const { errors, summary } = happyChecks({ spec: { ...defaultSpec, '/api/hello': ['GET'], '/api/other': ['GET'] } });
    const lines = formatResult({ errors, summary }).split('\n');
    expect(lines[0]).toMatch(/failed/);
    expect(lines.slice(1)).toEqual(errors.map((error) => `  - ${error}`));
  });
});

describe('ChangelogError', () => {
  it('carries a machine-readable code', () => {
    const error = new ChangelogError('oops', 'SOME_CODE');
    expect(error.name).toBe('ChangelogError');
    expect(error.code).toBe('SOME_CODE');
    expect(error.message).toBe('oops');
  });
});