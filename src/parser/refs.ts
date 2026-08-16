import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDocumentFromString, bundleDocument, createConfig, BaseResolver, Oas3_1Types } from '@redocly/openapi-core';
import { SpecParseError } from '../errors.js';

export interface BundledSpec {
  parsed: Record<string, unknown>;
  specPath: string;
}

const BLOCK_SCALAR_OPENER = /^(\s*)([^\s:#][^:\n]*):\s*([|>][+-]?\d*)\s*$/;

/**
 * Works around a real js-yaml parsing bug (confirmed present through the
 * latest @redocly/openapi-core/js-yaml as of this writing -- a version bump
 * alone does not fix it): a block scalar (`|`, `|+`, `>-`, etc.) whose body
 * is EMPTY -- nothing but whitespace-only lines before the next line dedents
 * back to the block scalar key's own indentation or shallower -- is
 * incorrectly rejected as "bad indentation of a mapping entry" instead of
 * being parsed as an empty string, which is what every other empty-body
 * case (`key: |` immediately followed by a dedented line, no blank line at
 * all) already parses to correctly. Confirmed against OpenAI's real
 * published spec (openapi.yaml), which hits exactly this shape:
 *
 *   default: <|endoftext|>
 *   example: |+
 *
 *   nullable: true
 *
 * `example`'s block scalar has a single blank line for a body, then
 * dedents straight back to a sibling key -- valid YAML (an empty string),
 * but js-yaml throws on it. This is a plain-text pre-pass, not a real YAML
 * parse: it only touches an EXACT, narrowly-matched shape (a block-scalar
 * opener line, followed by zero or more whitespace-only lines, followed by
 * a line that dedents to the opener's own indentation or shallower, or
 * end-of-file) and rewrites it to the equivalent `key: ""`, which is what a
 * spec-compliant parser would have produced for that empty body anyway. A
 * block scalar with any REAL content line (indented deeper than the
 * opener, with actual non-whitespace text) never matches this and is left
 * completely untouched -- the risky part of "rewrite YAML with regex"
 * (silently mangling real content) can't happen here because the whole
 * point of the pattern is "there is no content to mangle."
 */
export function workaroundEmptyBlockScalarBug(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const opener = BLOCK_SCALAR_OPENER.exec(line);
    if (!opener) {
      out.push(line);
      i++;
      continue;
    }
    const [, indent, key] = opener;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const bodyIsEmpty = j >= lines.length || indentOf(lines[j]) <= indent.length;
    if (bodyIsEmpty) {
      out.push(`${indent}${key}: ""`);
      i = j; // drop the opener line and every blank line that was its "body"
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

function indentOf(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

export async function loadAndBundleSpec(specPath: string): Promise<BundledSpec> {
  const absolutePath = resolve(specPath);
  const rawContent = await readFile(absolutePath, 'utf-8');
  const content = workaroundEmptyBlockScalarBug(rawContent);
  const document = makeDocumentFromString(content, pathToFileURL(absolutePath).href);

  const config = await createConfig({});
  const resolver = new BaseResolver();

  const result = await bundleDocument({
    document,
    config,
    types: Oas3_1Types,
    externalRefResolver: resolver,
    dereference: false,
  });

  if (result.problems.some((p) => p.severity === 'error')) {
    const errors = result.problems
      .filter((p) => p.severity === 'error')
      .map((p) => p.message)
      .join('\n');
    throw new SpecParseError(
      `Failed to parse spec: ${errors}`,
      `Check the OpenAPI spec at "${absolutePath}" for syntax errors. Run a linter such as \`npx @redocly/cli lint ${specPath}\` to identify issues.`,
    );
  }

  return {
    parsed: result.bundle.parsed as Record<string, unknown>,
    specPath: absolutePath,
  };
}
