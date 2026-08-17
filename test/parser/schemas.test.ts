import { describe, it, expect, vi } from 'vitest';
import { extractSchemas, schemaToTypeRef } from '../../src/parser/schemas.js';

describe('extractSchemas – backend suffix handling', () => {
  it('preserves Dto suffix in schema names', () => {
    const { models } = extractSchemas({
      CreateOrganizationDto: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    expect(models[0].name).toBe('CreateOrganizationDto');
  });

  it('strips Controller suffix and singularizes schema names', () => {
    const { models } = extractSchemas({
      OrganizationsController: {
        type: 'object',
        properties: { id: { type: 'string' } },
      },
    });
    expect(models[0].name).toBe('Organization');
  });

  it('does not strip suffix from the middle of a name', () => {
    const { models } = extractSchemas({
      DtoValidator: {
        type: 'object',
        properties: { valid: { type: 'boolean' } },
      },
    });
    expect(models[0].name).toBe('DtoValidator');
  });
});

describe('extractSchemas – no Dto collision since Dto is preserved', () => {
  it('keeps both models when Dto suffix is preserved (no name collision)', () => {
    const { models } = extractSchemas({
      RedirectUriDto: {
        type: 'object',
        properties: {
          uri: { type: 'string' },
          default: { type: 'boolean' },
        },
      },
      RedirectUri: {
        type: 'object',
        properties: {
          object: { type: 'string' },
          id: { type: 'string' },
          uri: { type: 'string' },
          default: { type: 'boolean' },
          created_at: { type: 'string' },
          updated_at: { type: 'string' },
        },
      },
    });
    const redirectUriDto = models.filter((m) => m.name === 'RedirectUriDto');
    expect(redirectUriDto).toHaveLength(1);
    expect(redirectUriDto[0].fields).toHaveLength(2);
    const redirectUri = models.filter((m) => m.name === 'RedirectUri');
    expect(redirectUri).toHaveLength(1);
    expect(redirectUri[0].fields).toHaveLength(6);
  });
});

describe('extractSchemas', () => {
  it('extracts a simple model', () => {
    const schemas = {
      User: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          age: { type: 'integer' },
        },
      },
    };

    const { models, enums } = extractSchemas(schemas);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('User');
    expect(models[0].fields).toHaveLength(3);
    expect(models[0].fields[0]).toEqual({
      name: 'id',
      type: { kind: 'primitive', type: 'string', format: 'uuid' },
      required: true,
      description: undefined,
    });
    expect(models[0].fields[2].type).toEqual({
      kind: 'primitive',
      type: 'integer',
    });
    expect(enums).toHaveLength(0);
  });

  it('extracts an enum', () => {
    const schemas = {
      Status: {
        type: 'string',
        enum: ['active', 'inactive', 'pending'],
      },
    };

    const { models, enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].name).toBe('Status');
    expect(enums[0].values).toEqual([
      { name: 'ACTIVE', value: 'active', description: undefined },
      { name: 'INACTIVE', value: 'inactive', description: undefined },
      { name: 'PENDING', value: 'pending', description: undefined },
    ]);
    expect(enums[0].default).toBeUndefined();
    expect(models).toHaveLength(0);
  });

  it('captures default on enum when present and a member', () => {
    const schemas = {
      PaginationOrder: {
        type: 'string',
        enum: ['normal', 'desc', 'asc'],
        default: 'desc',
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBe('desc');
  });

  it('drops default that is not a member of the enum values', () => {
    const schemas = {
      Status: {
        type: 'string',
        enum: ['active', 'inactive'],
        default: 'archived',
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBeUndefined();
  });

  it('captures numeric enum default', () => {
    const schemas = {
      Priority: {
        type: 'integer',
        enum: [0, 1, 2],
        default: 1,
      },
    };

    const { enums } = extractSchemas(schemas);
    expect(enums).toHaveLength(1);
    expect(enums[0].default).toBe(1);
  });

  it('extracts allOf model by merging fields', () => {
    const schemas = {
      Member: {
        allOf: [
          {
            type: 'object' as const,
            required: ['id'],
            properties: {
              id: { type: 'string' },
            },
          },
          {
            type: 'object' as const,
            required: ['name'],
            properties: {
              name: { type: 'string' },
            },
          },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    expect(models).toHaveLength(1);
    expect(models[0].fields).toHaveLength(2);
    expect(models[0].fields[0].name).toBe('id');
    expect(models[0].fields[0].required).toBe(true);
    expect(models[0].fields[1].name).toBe('name');
    expect(models[0].fields[1].required).toBe(true);
  });

  it('a later allOf member redeclaring a property overrides the earlier one, in place -- not a duplicate field', () => {
    // Real OpenAI pattern (CreateChatCompletionRequest = allOf[
    // CreateModelResponseProperties (top_logprobs, integer, min 0 max 100),
    // an inline override (top_logprobs, integer, min 0 max 20, nullable)]):
    // allOf-as-base-plus-narrowing-override, where the LATER, more specific
    // declaration is the one actually meant to apply. Before this fix both
    // landed as separate same-named Field entries in `fields`.
    const schemas = {
      Member: {
        allOf: [
          {
            type: 'object' as const,
            properties: {
              id: { type: 'string' },
              limit: { type: 'integer', description: 'base: unbounded' },
            },
          },
          {
            type: 'object' as const,
            properties: {
              limit: { type: 'integer', nullable: true, description: 'override: 0-20' },
            },
          },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    expect(models).toHaveLength(1);
    // Exactly one "limit" field -- not two -- and it kept its ORIGINAL
    // position (right after "id"), with the override's description/shape.
    expect(models[0].fields.map((f) => f.name)).toEqual(['id', 'limit']);
    const limit = models[0].fields.find((f) => f.name === 'limit')!;
    expect(limit.description).toBe('override: 0-20');
    expect(limit.type).toEqual({ kind: 'nullable', inner: { kind: 'primitive', type: 'integer' } });
  });

  it('extracts discriminated allOf oneOf variants as additional models', () => {
    const schemas = {
      EventSchema: {
        allOf: [
          {
            type: 'object' as const,
            required: ['id', 'event', 'data'],
            properties: {
              id: { type: 'string' },
              event: { type: 'string' },
              data: { type: 'object', additionalProperties: {} },
            },
          },
          {
            oneOf: [
              {
                type: 'object' as const,
                required: ['id', 'event', 'data'],
                properties: {
                  id: { type: 'string' },
                  event: { type: 'string', const: 'session.created' },
                  data: {
                    type: 'object' as const,
                    required: ['object', 'id'],
                    properties: {
                      object: { type: 'string', const: 'session' },
                      id: { type: 'string' },
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    expect(models.map((m) => m.name)).toContain('EventSchema');
    expect(models.map((m) => m.name)).toContain('SessionCreated');
    expect(models.map((m) => m.name)).toContain('SessionCreatedData');

    const variant = models.find((m) => m.name === 'SessionCreated');
    expect(variant).toBeDefined();
    expect(variant!.fields.find((f) => f.name === 'data')?.type).toEqual({
      kind: 'model',
      name: 'SessionCreatedData',
    });
  });

  it('extracts a standalone oneOf+discriminator as a discriminated union, not an empty model', () => {
    const schemas = {
      CardPaymentMethod: {
        type: 'object' as const,
        required: ['type', 'last4'],
        properties: {
          type: { type: 'string', enum: ['card'] },
          last4: { type: 'string' },
        },
      },
      BankTransferPaymentMethod: {
        type: 'object' as const,
        required: ['type', 'account_last4'],
        properties: {
          type: { type: 'string', enum: ['bank_transfer'] },
          account_last4: { type: 'string' },
        },
      },
      PaymentMethod: {
        oneOf: [
          { $ref: '#/components/schemas/CardPaymentMethod' },
          { $ref: '#/components/schemas/BankTransferPaymentMethod' },
        ],
        discriminator: {
          propertyName: 'type',
          mapping: {
            card: '#/components/schemas/CardPaymentMethod',
            bank_transfer: '#/components/schemas/BankTransferPaymentMethod',
          },
        },
      },
    };

    const { models } = extractSchemas(schemas);

    const paymentMethod = models.find((m) => m.name === 'PaymentMethod');
    expect(paymentMethod).toBeDefined();
    expect(paymentMethod!.fields).toEqual([]);
    expect(paymentMethod!.discriminator).toEqual({
      property: 'type',
      mapping: {
        card: 'CardPaymentMethod',
        bank_transfer: 'BankTransferPaymentMethod',
      },
    });

    // The $ref'd variants remain their own fully-fielded models — the
    // discriminator only references them, it doesn't need to (re)construct them.
    const card = models.find((m) => m.name === 'CardPaymentMethod');
    expect(card?.fields.map((f) => f.name)).toEqual(['type', 'last4']);
  });

  it('falls back to merging variant fields when a standalone oneOf has no discriminator mapping', () => {
    const schemas = {
      UpdateThing: {
        oneOf: [
          { type: 'object' as const, properties: { role_slug: { type: 'string' } } },
          { type: 'object' as const, properties: { role_slugs: { type: 'array', items: { type: 'string' } } } },
        ],
      },
    };

    const { models } = extractSchemas(schemas);
    const model = models.find((m) => m.name === 'UpdateThing');
    expect(model?.discriminator).toBeUndefined();
    expect(model?.fields.map((f) => f.name).sort()).toEqual(['role_slug', 'role_slugs']);
  });

  it('returns empty for undefined schemas', () => {
    const { models, enums } = extractSchemas(undefined);
    expect(models).toHaveLength(0);
    expect(enums).toHaveLength(0);
  });

  it('extracts readOnly and writeOnly field annotations', () => {
    const result = extractSchemas({
      MyModel: {
        type: 'object',
        properties: {
          id: { type: 'string', readOnly: true },
          password: { type: 'string', writeOnly: true },
          name: { type: 'string' },
        },
      },
    });

    expect(result.models).toHaveLength(1);
    const fields = result.models[0].fields;

    const idField = fields.find((f) => f.name === 'id');
    expect(idField).toBeDefined();
    expect(idField!.readOnly).toBe(true);
    expect(idField!.writeOnly).toBeUndefined();

    const passwordField = fields.find((f) => f.name === 'password');
    expect(passwordField).toBeDefined();
    expect(passwordField!.readOnly).toBeUndefined();
    expect(passwordField!.writeOnly).toBe(true);

    const nameField = fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.readOnly).toBeUndefined();
    expect(nameField!.writeOnly).toBeUndefined();
  });
});

describe('schemaToTypeRef', () => {
  it('maps string to PrimitiveType', () => {
    expect(schemaToTypeRef({ type: 'string' })).toEqual({
      kind: 'primitive',
      type: 'string',
    });
  });

  it('maps string with format', () => {
    expect(schemaToTypeRef({ type: 'string', format: 'date-time' })).toEqual({
      kind: 'primitive',
      type: 'string',
      format: 'date-time',
    });
  });

  it('maps integer', () => {
    expect(schemaToTypeRef({ type: 'integer' })).toEqual({
      kind: 'primitive',
      type: 'integer',
    });
  });

  it('maps boolean', () => {
    expect(schemaToTypeRef({ type: 'boolean' })).toEqual({
      kind: 'primitive',
      type: 'boolean',
    });
  });

  it('maps array type', () => {
    const ref = schemaToTypeRef({
      type: 'array',
      items: { type: 'string' },
    });
    expect(ref).toEqual({
      kind: 'array',
      items: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps OAS 3.1 nullable type array', () => {
    const ref = schemaToTypeRef({ type: ['string', 'null'] });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps OAS 3.0 nullable flag', () => {
    const ref = schemaToTypeRef({ type: 'string', nullable: true });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
  });

  it('maps oneOf to UnionType', () => {
    const ref = schemaToTypeRef({
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.variants).toHaveLength(2);
    }
  });

  it('maps oneOf with discriminator', () => {
    const ref = schemaToTypeRef({
      oneOf: [
        { type: 'object', properties: { type: { type: 'string' } } },
        { type: 'object', properties: { type: { type: 'string' } } },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: { a: 'SchemaA', b: 'SchemaB' },
      },
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.discriminator).toEqual({
        property: 'type',
        mapping: { a: 'SchemaA', b: 'SchemaB' },
      });
    }
  });

  it('maps enum schema to EnumRef', () => {
    const ref = schemaToTypeRef({ type: 'string', enum: ['a', 'b'] }, 'status');
    expect(ref).toEqual({ kind: 'enum', name: 'Status', values: ['a', 'b'] });
  });

  it('resolves $ref to named ModelRef preserving Dto', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDto' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKeyDto' });
  });

  it('resolves $ref with PascalCase name preserved', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ListMetadata' });
    expect(ref).toEqual({ kind: 'model', name: 'ListMetadata' });
  });

  it('resolves $ref with kebab-case name to PascalCase', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/api-key-response' });
    expect(ref).toEqual({ kind: 'model', name: 'ApiKeyResponse' });
  });

  it('$ref takes priority over other schema properties', () => {
    const ref = schemaToTypeRef({
      $ref: '#/components/schemas/UserDto',
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(ref).toEqual({ kind: 'model', name: 'UserDto' });
  });

  it('preserves DTO suffix in $ref targets (normalized to Dto by PascalCase)', () => {
    const ref = schemaToTypeRef({ $ref: '#/components/schemas/ValidateApiKeyDTO' });
    expect(ref).toEqual({ kind: 'model', name: 'ValidateApiKeyDto' });
  });

  it('falls through on malformed $ref with no segments', () => {
    const ref = schemaToTypeRef({ $ref: '', type: 'string' });
    expect(ref).toEqual({ kind: 'primitive', type: 'string' });
  });

  it('treats empty schema as unknown primitive', () => {
    const ref = schemaToTypeRef({}, 'unknownField');
    expect(ref).toEqual({ kind: 'primitive', type: 'unknown' });
  });

  it('returns model ref for object with both properties and additionalProperties', () => {
    const ref = schemaToTypeRef(
      {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: { type: 'string' },
      },
      'myField',
    );
    // Model ref is returned — extractModel surfaces additionalProperties as a map field
    expect(ref).toEqual({ kind: 'model', name: 'MyField' });
  });

  it('maps freeform object to MapType with unknown value', () => {
    const ref = schemaToTypeRef({ type: 'object' });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('maps object with additionalProperties schema to MapType', () => {
    const ref = schemaToTypeRef({
      type: 'object',
      additionalProperties: { type: 'integer' },
    });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'integer' } });
  });

  it('maps object with additionalProperties: true to MapType with unknown value', () => {
    const ref = schemaToTypeRef({
      type: 'object',
      additionalProperties: true,
    });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('allOf with $ref and augmentation returns merged model ref', () => {
    const ref = schemaToTypeRef(
      {
        allOf: [
          { $ref: '#/components/schemas/BaseModel' },
          { type: 'object', properties: { extra: { type: 'string' } } },
        ],
      },
      'myField',
    );
    expect(ref).toEqual({ kind: 'model', name: 'MyField' });
  });

  it('allOf with $ref only (no augmentation) returns the ref', () => {
    const ref = schemaToTypeRef(
      {
        allOf: [{ $ref: '#/components/schemas/BaseModel' }, { description: 'Just a description, no properties' }],
      },
      'myField',
    );
    expect(ref).toEqual({ kind: 'model', name: 'BaseModel' });
  });

  it('a field whose schema is $ref+augmentation allOf actually materializes the merged model extractSchemas() promised, not just a dangling reference', () => {
    // schemaToTypeRef's own "allOf with $ref and augmentation" case above
    // promises a model named "MyField" exists -- this confirms extractSchemas()
    // actually adds it to `models`, with BOTH the $ref'd base schema's fields
    // AND the augmentation's own field merged in. Before this fix, nothing
    // materialized this model at all: the field's type pointed at a model
    // name extractSchemas() never added to `models`, which
    // normalize-model-refs.ts's validateModelRefs flags as "Unresolved
    // model reference" -- confirmed as the root cause of exactly that
    // warning on a real large spec (554 occurrences on Stripe's published
    // spec).
    const { models } = extractSchemas({
      BaseModel: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      Container: {
        type: 'object',
        properties: {
          myField: {
            allOf: [
              { $ref: '#/components/schemas/BaseModel' },
              { type: 'object', properties: { extra: { type: 'string' } } },
            ],
          },
        },
      },
    });

    const container = models.find((m) => m.name === 'Container')!;
    // qualifyInlineModelName prefixes the parent model name when extracting
    // via the full extractSchemas() path (contextName = field name,
    // parentModelName = "Container") -- "ContainerMyField", not the bare
    // "MyField" the narrower schemaToTypeRef-only test above gets (it never
    // passes a parentModelName).
    expect(container.fields[0].type).toEqual({ kind: 'model', name: 'ContainerMyField' });

    const merged = models.find((m) => m.name === 'ContainerMyField');
    expect(
      merged,
      `expected a materialized "ContainerMyField" model in: ${models.map((m) => m.name).join(', ')}`,
    ).toBeDefined();
    expect(merged!.fields.map((f) => f.name).sort()).toEqual(['extra', 'id']);
  });

  it('discriminator mapping strips #/components/schemas/ prefix', () => {
    const ref = schemaToTypeRef({
      oneOf: [
        { type: 'object', properties: { type: { type: 'string' } } },
        { type: 'object', properties: { type: { type: 'string' } } },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: {
          a: '#/components/schemas/SchemaA',
          b: 'SchemaB',
        },
      },
    });
    expect(ref.kind).toBe('union');
    if (ref.kind === 'union') {
      expect(ref.discriminator!.mapping).toEqual({ a: 'SchemaA', b: 'SchemaB' });
    }
  });

  it('inline enum preserves numeric values', () => {
    const ref = schemaToTypeRef({ type: 'integer', enum: [1, 2, 3] }, 'status');
    expect(ref.kind).toBe('enum');
    if (ref.kind === 'enum') {
      expect(ref.values).toEqual([1, 2, 3]);
    }
  });

  it('const object returns map type', () => {
    const ref = schemaToTypeRef({ const: { key: 'value' } });
    expect(ref).toEqual({ kind: 'map', valueType: { kind: 'primitive', type: 'unknown' } });
  });

  it('const array returns array type', () => {
    const ref = schemaToTypeRef({ const: [1, 2, 3] });
    expect(ref).toEqual({ kind: 'array', items: { kind: 'primitive', type: 'unknown' } });
  });

  it('unknown schema fallback returns unknown, not string', () => {
    // Schema with an unrecognized type (not string/integer/number/boolean/array/object)
    const ref = schemaToTypeRef({ type: 'file' }, 'testField');
    expect(ref).toEqual({ kind: 'primitive', type: 'unknown' });
  });

  it('handles combined OAS 3.1 type array and 3.0 nullable without double-wrapping', () => {
    const ref = schemaToTypeRef({ type: ['string', 'null'], nullable: true });
    expect(ref).toEqual({
      kind: 'nullable',
      inner: { kind: 'primitive', type: 'string' },
    });
    // Should NOT be double-wrapped as nullable(nullable(string))
    if (ref.kind === 'nullable') {
      expect(ref.inner.kind).not.toBe('nullable');
    }
  });
});

describe('extractSchemas – name-collision handling (never drop, always suffix + warn)', () => {
  it('disambiguates two raw schema keys that clean to the identical name, keeping both models', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models } = extractSchemas({
      'my-widget': { type: 'object', properties: { a: { type: 'string' } } },
      MyWidget: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
    });
    warnSpy.mockRestore();

    expect(models).toHaveLength(2);
    const names = models.map((m) => m.name).sort();
    expect(names).toEqual(['MyWidget', 'MyWidget_2']);
    // Declaration order (Object.keys order) decides which raw key keeps the
    // plain name -- "my-widget" is declared first, so it keeps "MyWidget";
    // "MyWidget" (declared second) is the one suffixed.
    const first = models.find((m) => m.name === 'MyWidget')!;
    const second = models.find((m) => m.name === 'MyWidget_2')!;
    expect(first.fields.map((f) => f.name)).toEqual(['a']);
    expect(second.fields.map((f) => f.name)).toEqual(['b']);
  });

  it('warns naming both colliding schemas and the emitted suffix', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    extractSchemas({
      'my-widget': { type: 'object', properties: { a: { type: 'string' } } },
      MyWidget: { type: 'object', properties: { b: { type: 'string' } } },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('schema "MyWidget" cleans to the same name ("MyWidget") as schema "my-widget"'),
    );
    warnSpy.mockRestore();
  });

  it('keeps a $ref to the disambiguated schema pointing at the correct (suffixed) model, not the wrong one', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models } = extractSchemas({
      'my-widget': { type: 'object', properties: { a: { type: 'string' } } },
      MyWidget: { type: 'object', properties: { b: { type: 'string' } } },
      Holder: {
        type: 'object',
        properties: { second: { $ref: '#/components/schemas/MyWidget' } },
      },
    });
    warnSpy.mockRestore();

    const holder = models.find((m) => m.name === 'Holder')!;
    const ref = holder.fields.find((f) => f.name === 'second')!.type;
    // The $ref's raw target key is "MyWidget" (the SECOND declared key,
    // which got suffixed to "MyWidget_2") -- the reference must follow it
    // there, not resolve to the plain "MyWidget" that a different raw key
    // ("my-widget") actually owns.
    expect(ref).toEqual({ kind: 'model', name: 'MyWidget_2' });
  });

  it('resolves three-way collisions to distinct, deterministic names', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models } = extractSchemas({
      Widget: { type: 'object', properties: { a: { type: 'string' } } },
      widget: { type: 'object', properties: { b: { type: 'string' } } },
      WIDGET: { type: 'object', properties: { c: { type: 'string' } } },
    });
    warnSpy.mockRestore();

    expect(models.map((m) => m.name).sort()).toEqual(['Widget', 'Widget_2', 'Widget_3']);
  });

  it('does not touch schemas whose names do not collide', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models } = extractSchemas({
      Widget: { type: 'object', properties: { a: { type: 'string' } } },
      Gadget: { type: 'object', properties: { b: { type: 'string' } } },
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    expect(models.map((m) => m.name).sort()).toEqual(['Gadget', 'Widget']);
  });

  it('gives a model/enum collision the conventional "Enum" suffix, not a numeric one -- and keeps the model plain regardless of declaration order', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models, enums } = extractSchemas({
      Network: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      network: { type: 'string', enum: ['visa', 'mastercard'] },
    });
    warnSpy.mockRestore();

    expect(models.map((m) => m.name)).toEqual(['Network']);
    expect(enums.map((e) => e.name)).toEqual(['NetworkEnum']);
  });

  it('gives the enum the "Enum" suffix even when the enum is declared BEFORE the colliding model', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { models, enums } = extractSchemas({
      network: { type: 'string', enum: ['visa', 'mastercard'] },
      Network: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    warnSpy.mockRestore();

    expect(models.map((m) => m.name)).toEqual(['Network']);
    expect(enums.map((e) => e.name)).toEqual(['NetworkEnum']);
  });
});
