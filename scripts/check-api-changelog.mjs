#!/usr/bin/env node

/**
 * API changelog validation for `docs/api/changelog.md`.
 *
 * The changelog is the single consumer-facing record of externally visible API
 * changes. It is grouped by API version, and breaking changes are marked with
 * an explicit `[breaking]` token. This script verifies that the changelog stays
 * truthful and complete with respect to the programmatic sources of truth:
 *
 *   - `openapi.yaml`               — the published API surface (paths + methods).
 *   - `src/middleware/apiVersion.ts` — `SUPPORTED_VERSIONS` naming every served
 *     API version that must have a changelog section.
 *   - `src/config/deprecations.ts` — every registered route retirement that must
 *     be announced in the changelog (and vice versa).
 *
 * The check is fail-closed: an unrecognized declaration format, an unparseable
 * changelog, or any of the invariants below failing blocks the build. It never
 * "fixes" the changelog automatically.
 *
 * Invariants enforced:
 *
 *   1. The changelog parses into version sections and `Added` / `Changed` /
 *      `Fixed` / `Deprecated` / `Removed` groups, newest section first.
 *   2. Every served API version has a changelog section, and the head
 *      (first) section is one of the served versions.
 *   3. The set of endpoints the changelog declares live (added and never
 *      removed) exactly equals the endpoint set in `openapi.yaml`. Adding an
 *      endpoint without an entry, or deleting one without a `### Removed`
 *      entry, therefore fails.
 *   4. Every deprecated route in `src/config/deprecations.ts` has one matching
 *      `### Deprecated` entry carrying its `YYYY-MM-DD` sunset date, and every
 *      `### Deprecated` entry is registered.
 *   5. `### Removed` entries always carry `[breaking]`, and `[breaking]` never
 *      appears on `Added`, `Fixed`, or `Deprecated` entries.
 *
 * Usage:
 *   node scripts/check-api-changelog.mjs
 *   node scripts/check-api-changelog.mjs --changelog <path> --spec <path> \
 *     --api-version <path> --deprecations <path>
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const KINDS = ['Added', 'Changed', 'Fixed', 'Deprecated', 'Removed'];
export const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
export const DEPRECATED_METHOD = 'ALL';
export const GLOBAL_SCOPE = '*';
export const BREAKING_MARKER = '[breaking]';

export const DEFAULT_PATHS = {
  changelog: 'docs/api/changelog.md',
  spec: 'openapi.yaml',
  apiVersion: 'src/middleware/apiVersion.ts',
  deprecations: 'src/config/deprecations.ts',
};

const ARG_KEY_TO_PATH_KEY = {
  changelog: 'changelogPath',
  spec: 'specPath',
  apiVersion: 'apiVersionPath',
  deprecations: 'deprecationsPath',
};

export class ChangelogError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ChangelogError';
    this.code = code;
    Object.assign(this, details);
  }
}

function versionSectionRegex() {
  return /^##\s+(v\d+(?:\.\d+)*)\s*$/;
}

function kindRegex() {
  return /^###\s+(Added|Changed|Fixed|Deprecated|Removed)\s*$/;
}

function scopeRegex() {
  return /^(\*|([A-Za-z]+)\s+(\/[^\s]*))$/;
}

function entry(body, lineNumber) {
  const match = /^`([^`]+)`(.*)$/.exec(body);
  if (!match) {
    throw new ChangelogError(
      `line ${lineNumber}: entry must start with a backticked \`SCOPE\``,
      'ENTRY_SCOPE_MISSING',
      { line: lineNumber },
    );
  }

  const scope = match[1].trim();
  let tail = match[2];
  let breaking = false;

  if (/^\s*\[breaking\]/.test(tail)) {
    breaking = true;
  }
  tail = tail.replace(/^\s*\[breaking\]/, '').trim();

  const separator = /^([—-])\s+(\S[\s\S]*)$/.exec(tail);
  if (!separator) {
    throw new ChangelogError(
      `line ${lineNumber}: entry must be of the form "- \`SCOPE\` — description"`,
      'ENTRY_DESCRIPTION_MISSING',
      { line: lineNumber },
    );
  }
  const description = separator[2].trim();

  const scopeMatch = scopeRegex().exec(scope);
  if (!scopeMatch) {
    throw new ChangelogError(
      `line ${lineNumber}: invalid scope token \`${scope}\` (expected \`METHOD /path\` or \`*\`)`,
      'SCOPE_INVALID',
      { scope, line: lineNumber },
    );
  }

  if (scope === GLOBAL_SCOPE) {
    return { scope, method: GLOBAL_SCOPE, path: GLOBAL_SCOPE, breaking, description };
  }

  return {
    scope,
    method: scopeMatch[2].toUpperCase(),
    path: scopeMatch[3],
    breaking,
    description,
  };
}

function compareVersions(a, b) {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse a changelog document into sections and entries. Throws
 * `ChangelogError` on any structural violation so malformed files fail closed.
 */
export function parseChangelog(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const seen = new Set();
  let current = null;
  let currentKind = null;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;

    const depth = /^(#{2,})\s/.exec(trimmed)?.[1].length ?? 0;
    if (depth > 3) {
      throw new ChangelogError(
        `line ${index + 1}: headings must be \`##\` (version) or \`###\` (kind) only`,
        'HEADING_DEPTH_INVALID',
        { line: index + 1 },
      );
    }
    if (depth === 0) {
      const bullet = /^-\s+/.exec(trimmed);
      if (!bullet) {
        // Plain prose is documentation, not a changelog record.
        continue;
      }
      if (!current) {
        // Entry-shaped bullets before the first version section are changelog
        // documentation examples, not changelog records.
        continue;
      }
      if (!/^-\s+`/.test(trimmed)) {
        // A prose bullet is documentation, not a changelog record.
        continue;
      }
      if (!currentKind) {
        throw new ChangelogError(
          `line ${index + 1}: entry outside of a version section and change group`,
          'ENTRY_OUTSIDE_SECTION',
          { line: index + 1 },
        );
      }
      const parsed = entry(trimmed.replace(bullet[0], ''), index + 1);
      current.entries.push({ ...parsed, kind: currentKind });
      continue;
    }

    if (depth === 2) {
      const versionMatch = versionSectionRegex().exec(trimmed);
      if (versionMatch) {
        const version = versionMatch[1];
        if (seen.has(version)) {
          throw new ChangelogError(
            `line ${index + 1}: duplicate section for API version ${version}`,
            'VERSION_DUPLICATE',
            { version, line: index + 1 },
          );
        }
        seen.add(version);
        current = { version, entries: [] };
        currentKind = null;
        sections.push(current);
        continue;
      }
      if (!current) {
        // Headings before the first version section are changelog documentation,
        // not version sections.
        continue;
      }
      throw new ChangelogError(
        `line ${index + 1}: invalid version heading \`${trimmed}\``,
        'VERSION_HEADING_INVALID',
        { line: index + 1 },
      );
    }

    if (depth === 3) {
      if (!current) continue;
      const kindMatch = kindRegex().exec(trimmed);
      if (!kindMatch) {
        throw new ChangelogError(
          `line ${index + 1}: unknown change group \`${trimmed}\` (expected one of ${KINDS.join(', ')})`,
          'KIND_HEADING_INVALID',
          { line: index + 1 },
        );
      }
      if (!current) {
        throw new ChangelogError(
          `line ${index + 1}: change group outside of a version section`,
          'KIND_OUTSIDE_SECTION',
          { line: index + 1 },
        );
      }
      currentKind = kindMatch[1];
      continue;
    }

  }

  if (sections.length === 0) {
    throw new ChangelogError('no API version sections found', 'NO_SECTIONS');
  }

  for (let index = 1; index < sections.length; index += 1) {
    const prev = sections[index - 1].version;
    const next = sections[index].version;
    if (compareVersions(prev, next) !== 1) {
      throw new ChangelogError(
        `version sections must be ordered newest first (${prev} before ${next})`,
        'SECTIONS_OUT_OF_ORDER',
        { prev, next },
      );
    }
  }

  return { sections };
}

/**
 * Extract `SUPPORTED_VERSIONS` and `DEFAULT_API_VERSION` from the source of
 * `src/middleware/apiVersion.ts`. Fails closed if the declaration shape
 * changes so the check can never silently stop covering a served version.
 */
export function extractApiVersions(text) {
  const supportedMatch = /SUPPORTED_VERSIONS\s*:\s*readonly\s+string\[\s*\]\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!supportedMatch) {
    throw new ChangelogError(
      'unable to locate the SUPPORTED_VERSIONS declaration in src/middleware/apiVersion.ts',
      'VERSIONS_UNPARSEABLE',
    );
  }

  const supported = supportedMatch[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);

  if (supported.some((version) => !/^v\d+(?:\.\d+)*$/.test(version))) {
    throw new ChangelogError(
      `SUPPORTED_VERSIONS contains a value that is not an API version: ${supported.join(', ')}`,
      'VERSIONS_INVALID',
      { supported },
    );
  }

  const defaultMatch = /DEFAULT_API_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text);
  return { supported, defaultVersion: defaultMatch ? defaultMatch[1] : null };
}

/**
 * Extract `{ route, sunsetDate }` pairs from the `routeDeprecations` array of
 * `src/config/deprecations.ts`. The registry is the source of truth for which
 * routes are deprecated and when they retire.
 */
export function extractDeprecations(text) {
  if (!text.includes('routeDeprecations')) {
    throw new ChangelogError(
      'unable to locate the routeDeprecations declaration in src/config/deprecations.ts',
      'DEPRECATIONS_UNPARSEABLE',
    );
  }

  const deprecations = [];
  const pattern = /\broute\s*:\s*['"]([^'"]+)['"]\s*,\s*sunsetDate\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(text))) {
    deprecations.push({ route: match[1], sunsetDate: match[2] });
  }

  for (const entry of deprecations) {
    if (!entry.route.startsWith('/')) {
      throw new ChangelogError(
        `registered deprecated route must start with "/": ${entry.route}`,
        'DEPRECATED_ROUTE_INVALID',
        { route: entry.route },
      );
    }
    const sunset = new Date(entry.sunsetDate);
    if (Number.isNaN(sunset.getTime())) {
      throw new ChangelogError(
        `invalid sunset date for deprecated route ${entry.route}: ${entry.sunsetDate}`,
        'DEPRECATED_SUNSET_INVALID',
        { route: entry.route },
      );
    }
  }

  return deprecations;
}

/**
 * Extract the set of `METHOD path` endpoints from an OpenAPI document. Only the
 * paths block is inspected; everything else (schemas, examples) is ignored.
 * The result set is the authoritative published API surface used by the parity
 * checks below.
 */
export function extractSpecEndpoints(text) {
  const endpoints = new Set();
  let inPaths = false;
  let path = null;

  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)(\S.*)$/.exec(line);
    if (!match) continue;

    const indent = match[1].length;
    const content = match[2].trim();

    if (!inPaths) {
      if (content === 'paths:') inPaths = true;
      continue;
    }
    if (indent === 0) {
      if (content.startsWith('#')) continue;
      break;
    }

    if (indent === 2) {
      path = content.endsWith(':') ? content.slice(0, -1).trim() : null;
      if (path && !path.startsWith('/')) path = null;
      continue;
    }

    if (indent === 4 && path) {
      const method = content.endsWith(':') ? content.slice(0, -1).trim().toUpperCase() : '';
      if (HTTP_METHODS.has(method)) endpoints.add(`${method} ${path}`);
    }
  }

  return endpoints;
}

/**
 * Derive the set of endpoints the changelog declares as currently live.
 * Sections are parsed in file order (newest first), so the first `Added` /
 * `Removed` entry seen for a scope decides its current state.
 */
export function deriveLiveEndpoints(sections) {
  const state = new Map();
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.scope === GLOBAL_SCOPE) continue;
      if (entry.kind !== 'Added' && entry.kind !== 'Removed') continue;
      const key = `${entry.method} ${entry.path}`;
      if (!state.has(key)) state.set(key, entry.kind === 'Removed' ? 'removed' : 'live');
    }
  }
  return new Set(
    [...state.entries()]
      .filter(([, status]) => status === 'live')
      .map(([key]) => key),
  );
}

function sunsetDatePart(iso) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1] : null;
}

/**
 * Run every changelog invariant. Returns `{ errors, summary }`; an empty
 * `errors` array means the changelog is consistent with the API surface.
 */
export function runChecks({ changelogText, specText, apiVersionText, deprecationsText }) {
  const errors = [];

  let sections;
  try {
    ({ sections } = parseChangelog(changelogText));
  } catch (error) {
    return { errors: [error.message], summary: 'changelog could not be parsed' };
  }

  let supported = [];
  let versionsParsed = true;
  try {
    ({ supported } = extractApiVersions(apiVersionText));
  } catch (error) {
    versionsParsed = false;
    errors.push(error.message);
  }

  let registeredDeprecations = [];
  try {
    registeredDeprecations = extractDeprecations(deprecationsText);
  } catch (error) {
    errors.push(error.message);
  }

  const specEndpoints = extractSpecEndpoints(specText);
  const liveEndpoints = deriveLiveEndpoints(sections);
  const sectionVersions = new Set(sections.map((section) => section.version));

  if (versionsParsed) {
    for (const version of supported) {
      if (!sectionVersions.has(version)) {
        errors.push(`API version ${version} is served (SUPPORTED_VERSIONS) but has no changelog section`);
      }
    }
    const head = sections[0].version;
    if (!supported.includes(head)) {
      errors.push(`first changelog section is ${head}, but SUPPORTED_VERSIONS = [${supported.join(', ')}]`);
    }
  }

  for (const entry of sections.flatMap((section) => section.entries)) {
    if (entry.kind === 'Deprecated' && entry.scope === GLOBAL_SCOPE) {
      errors.push('deprecations must name a route (`ALL /path`), not the global `*` scope');
    }

    if (entry.scope !== GLOBAL_SCOPE && entry.kind !== 'Deprecated' && !HTTP_METHODS.has(entry.method)) {
      errors.push(`entry \`${entry.scope}\` must use a concrete HTTP method (${[...HTTP_METHODS].join(', ')}), not \`${entry.method}\``);
    }

    if (entry.kind === 'Deprecated' && entry.method !== DEPRECATED_METHOD) {
      errors.push(`deprecation entry \`${entry.scope}\` must use method ${DEPRECATED_METHOD} (a deprecation covers every method of the route)`);
    }

    const key = entry.scope === GLOBAL_SCOPE ? null : `${entry.method} ${entry.path}`;

    if (entry.kind === 'Added' && key && !specEndpoints.has(key)) {
      errors.push(`scope \`${entry.scope}\` is recorded as Added but does not exist in openapi.yaml — add the endpoint to the spec or mark the change correctly`);
    }
    if ((entry.kind === 'Changed' || entry.kind === 'Fixed') && key && !specEndpoints.has(key)) {
      errors.push(`scope \`${entry.scope}\` is recorded as ${entry.kind} but does not exist in openapi.yaml`);
    }
    if (entry.kind === 'Removed' && key && specEndpoints.has(key)) {
      errors.push(`scope \`${entry.scope}\` is recorded as Removed but still exists in openapi.yaml — remove it from the spec or keep the record live`);
    }

    if (entry.kind === 'Removed' && !entry.breaking) {
      errors.push(`removal \`${entry.scope}\` must be marked ${BREAKING_MARKER}`);
    }
    if (entry.breaking && (entry.kind === 'Added' || entry.kind === 'Fixed' || entry.kind === 'Deprecated')) {
      errors.push(`entry \`${entry.scope}\` (${entry.kind}) must not carry the ${BREAKING_MARKER} marker`);
    }
  }

  for (const key of [...liveEndpoints].sort()) {
    if (!specEndpoints.has(key)) {
      errors.push(`endpoint ${key} is recorded as live in the changelog but is not present in openapi.yaml`);
    }
  }
  for (const key of [...specEndpoints].sort()) {
    if (!liveEndpoints.has(key)) {
      errors.push(`endpoint ${key} exists in openapi.yaml but has no live changelog entry — record its addition`);
    }
  }

  const deprecatedEntries = sections.flatMap((section) => section.entries.filter((entry) => entry.kind === 'Deprecated'));

  for (const deprecation of registeredDeprecations) {
    const matches = deprecatedEntries.filter((entry) => entry.path === deprecation.route);
    if (matches.length === 0) {
      errors.push(`deprecated route ${deprecation.route} is registered in src/config/deprecations.ts but has no changelog entry`);
    }
    if (matches.length > 1) {
      errors.push(`deprecated route ${deprecation.route} has more than one changelog entry`);
    }
    const date = sunsetDatePart(deprecation.sunsetDate);
    if (matches.length === 1 && date && !matches[0].description.includes(date)) {
      errors.push(`the changelog entry for ${deprecation.route} must mention its sunset date ${date}`);
    }
  }

  for (const entry of deprecatedEntries) {
    if (!registeredDeprecations.some((deprecation) => deprecation.route === entry.path)) {
      errors.push(`changelog marks ${entry.scope} deprecated but it is not registered in src/config/deprecations.ts`);
    }
  }

  const served = supported.length > 0 ? supported.join(', ') : '(none parsed)';
  const summary =
    errors.length === 0
      ? `${sections.length} version section(s), ${liveEndpoints.size} live endpoint(s), ${registeredDeprecations.length} deprecation(s).`
      : `${sections.length} version section(s) for served versions [${served}]; ${errors.length} problem(s) found.`;

  return { errors, summary };
}

/**
 * Run the check against real files. Any missing or unreadable file is a
 * failure — the check must never silently skip a source of truth.
 */
export function checkProject({ changelogPath, specPath, apiVersionPath, deprecationsPath }) {
  const errors = [];
  const files = { changelogPath, specPath, apiVersionPath, deprecationsPath };

  for (const [name, filePath] of Object.entries(files)) {
    if (!fs.existsSync(filePath)) {
      errors.push(`required file is missing: ${filePath} (${name})`);
    }
  }
  if (errors.length > 0) {
    return { errors, summary: `${errors.length} problem(s) found.` };
  }

  const result = runChecks({
    changelogText: fs.readFileSync(changelogPath, 'utf8'),
    specText: fs.readFileSync(specPath, 'utf8'),
    apiVersionText: fs.readFileSync(apiVersionPath, 'utf8'),
    deprecationsText: fs.readFileSync(deprecationsPath, 'utf8'),
  });
  return { errors: result.errors, summary: result.summary };
}

export function formatResult(result) {
  if (result.errors.length === 0) {
    return `API changelog check passed: ${result.summary}`;
  }
  return [`API changelog check failed: ${result.summary}`, ...result.errors.map((error) => `  - ${error}`)].join('\n');
}

export function parseCliArgs(argv, cwd) {
  const options = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_PATHS)) {
    options[ARG_KEY_TO_PATH_KEY[key]] = path.resolve(cwd, defaultValue);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const pathKey = ARG_KEY_TO_PATH_KEY[key];
    if (!pathKey) {
      throw new ChangelogError(`unrecognized flag ${flag}`, 'CLI_FLAG_UNKNOWN');
    }
    if (!value) {
      throw new ChangelogError(`${flag} requires a value`, 'CLI_FLAG_MISSING_VALUE');
    }
    options[pathKey] = path.resolve(cwd, value);
    index += 1;
  }

  return options;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  try {
    const options = parseCliArgs(argv, cwd);
    const result = checkProject(options);
    const output = formatResult(result);
    if (result.errors.length > 0) {
      process.stderr.write(`${output}\n`);
      return 1;
    }
    process.stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`API changelog check failed: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}