import { describe, it, expect } from 'vitest';
import { loadAndBundleSpec, workaroundEmptyBlockScalarBug } from '../../src/parser/refs.js';

describe('loadAndBundleSpec', () => {
  it('throws when file does not exist', async () => {
    await expect(loadAndBundleSpec('/nonexistent/spec.yml')).rejects.toThrow();
  });

  it('throws for invalid YAML content', async () => {
    // Create a temp file with invalid content
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');

    const tmpDir = join(os.tmpdir(), `oagen-refs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const specPath = join(tmpDir, 'bad.yml');
    writeFileSync(specPath, ': : : invalid yaml [[[');

    try {
      await expect(loadAndBundleSpec(specPath)).rejects.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses a spec containing the real empty-block-scalar shape that OpenAI's published spec hits (js-yaml otherwise rejects it)", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');

    // The exact shape from OpenAI's real openapi.yaml (default: <|endoftext|>,
    // example: |+ followed by a blank line then a dedented sibling key) --
    // js-yaml throws "bad indentation of a mapping entry" on this without
    // the workaround.
    const spec = [
      'openapi: 3.1.0',
      'info:',
      '  title: Test',
      '  version: "1.0"',
      'paths:',
      '  /x:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      'components:',
      '  schemas:',
      '    Thing:',
      '      type: object',
      '      properties:',
      '        stop:',
      '          oneOf:',
      '            - type: string',
      '              default: <|endoftext|>',
      '              example: |+',
      '              ',
      '              nullable: true',
      '            - type: array',
      '',
    ].join('\n');

    const tmpDir = join(os.tmpdir(), `oagen-refs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const specPath = join(tmpDir, 'openai-shaped.yaml');
    writeFileSync(specPath, spec);

    try {
      const result = await loadAndBundleSpec(specPath);
      const schema = (result.parsed as any).components.schemas.Thing.properties.stop.oneOf[0];
      expect(schema.example).toBe('');
      expect(schema.nullable).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('workaroundEmptyBlockScalarBug', () => {
  it('rewrites a block scalar with no body (dedent on the very next line) to an empty string', () => {
    const input = ['key:', '  example: |+', 'nextkey: true'].join('\n');
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(['key:', '  example: ""', 'nextkey: true'].join('\n'));
  });

  it('rewrites a block scalar whose only body is a single blank line', () => {
    const input = ['key:', '  example: |+', '', '  nullable: true'].join('\n');
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(['key:', '  example: ""', '  nullable: true'].join('\n'));
  });

  it('rewrites a block scalar whose body is multiple blank/whitespace-only lines', () => {
    const input = ['key:', '  example: |', '', '   ', '', '  nullable: true'].join('\n');
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(['key:', '  example: ""', '  nullable: true'].join('\n'));
  });

  it('rewrites a block scalar with empty body at end of file (no following key at all)', () => {
    const input = ['key:', '  example: |+', ''].join('\n');
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(['key:', '  example: ""'].join('\n'));
  });

  it('handles ">" (folded) and all chomping/indentation-indicator variants identically to "|"', () => {
    for (const indicator of ['|', '|+', '|-', '|2', '>', '>+', '>-']) {
      const input = ['key:', `  example: ${indicator}`, '  nullable: true'].join('\n');
      const output = workaroundEmptyBlockScalarBug(input);
      expect(output, indicator).toBe(['key:', '  example: ""', '  nullable: true'].join('\n'));
    }
  });

  it('does NOT touch a block scalar that has real content', () => {
    const input = ['key:', '  example: |', '    Some real content here.', '  nullable: true'].join('\n');
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(input);
  });

  it('does NOT touch a block scalar whose content is indented deeper than the dedent point, even after blank lines', () => {
    const input = ['key:', '  example: |+', '', '    Real content, deeper than the opener.', '  nullable: true'].join(
      '\n',
    );
    const output = workaroundEmptyBlockScalarBug(input);
    expect(output).toBe(input);
  });

  it('does not misfire on an ordinary "key: value" line containing a pipe character in the value', () => {
    const input = 'description: "Use the | character to separate values"';
    expect(workaroundEmptyBlockScalarBug(input)).toBe(input);
  });

  it('is a no-op on a document with no block scalars at all', () => {
    const input = ['openapi: 3.1.0', 'info:', '  title: Test', '  version: "1.0"'].join('\n');
    expect(workaroundEmptyBlockScalarBug(input)).toBe(input);
  });

  it('handles a block scalar as the very last line of the document with no trailing content', () => {
    const input = 'example: |+';
    expect(workaroundEmptyBlockScalarBug(input)).toBe('example: ""');
  });
});
