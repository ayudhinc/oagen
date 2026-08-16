import { describe, it, expect } from 'vitest';
import { extractInlineModelsFromSchemas } from '../../src/parser/inline-models.js';
import { schemaToTypeRef } from '../../src/parser/schemas.js';

/**
 * Regression coverage for the "Unresolved model reference" root causes
 * traced against Stripe's real published spec: schemaToTypeRef() promises a
 * model name for several field shapes that extractInlineModelsFromProperties
 * (the function backing extractInlineModelsFromSchemas, and reused by
 * operations.ts for request bodies) never actually materialized. Each case
 * here confirms both halves agree: the promised name via schemaToTypeRef,
 * and a real Model with that exact name in the materialized results.
 */
describe('extractInlineModelsFromSchemas — anyOf/oneOf inline object variants', () => {
  it('materializes an anyOf inline-object variant (Stripe: bank_account-style flexible input)', () => {
    // Real Stripe pattern (POST /v1/accounts, bank_account field): "either a
    // structured object, or a plain token string" -- 554 of 554 "Unresolved
    // model reference" warnings on Stripe's real spec traced to exactly this
    // shape before this fix (anyOf was never handled at all; only oneOf was).
    const schema = {
      Container: {
        type: 'object',
        properties: {
          bank_account: {
            anyOf: [
              {
                type: 'object',
                properties: { account_number: { type: 'string' } },
                required: ['account_number'],
              },
              { type: 'string' },
            ],
          },
        },
      },
    };

    const promised = schemaToTypeRef(schema.Container.properties.bank_account as never, 'bank_account', 'Container');
    const models = extractInlineModelsFromSchemas(schema as never);

    expect(promised.kind).toBe('union');
    if (promised.kind !== 'union') return;
    const modelVariant = promised.variants.find((v) => v.kind === 'model');
    expect(modelVariant).toBeDefined();

    const materialized = models.find((m) => m.name === (modelVariant as { name: string }).name);
    expect(
      materialized,
      `expected a materialized model named "${(modelVariant as { name: string }).name}" in: ${models.map((m) => m.name).join(', ')}`,
    ).toBeDefined();
    expect(materialized!.fields.map((f) => f.name)).toEqual(['account_number']);
  });

  it('materializes a oneOf inline-object variant identically (confirms anyOf and oneOf are treated the same)', () => {
    const schema = {
      Container: {
        type: 'object',
        properties: {
          payment_method: {
            oneOf: [
              { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
              { type: 'string' },
            ],
          },
        },
      },
    };

    const models = extractInlineModelsFromSchemas(schema as never);
    const materialized = models.find((m) => m.name === 'ContainerPaymentMethod');
    expect(materialized, `have: ${models.map((m) => m.name).join(', ')}`).toBeDefined();
    expect(materialized!.fields.map((f) => f.name)).toEqual(['token']);
  });

  it('materializes an anyOf variant that is itself an array of inline objects (Stripe: products-style list-or-sentinel)', () => {
    // Real Stripe pattern (POST /v1/billing_portal/configurations,
    // features.subscription_update.products): "either an array of
    // structured product-selector objects, or the empty-string sentinel".
    const schema = {
      Container: {
        type: 'object',
        properties: {
          products: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { product: { type: 'string' } },
                  required: ['product'],
                },
              },
              { type: 'string', enum: [''] },
            ],
          },
        },
      },
    };

    const promised = schemaToTypeRef(schema.Container.properties.products as never, 'products', 'Container');
    const models = extractInlineModelsFromSchemas(schema as never);

    expect(promised.kind).toBe('union');
    if (promised.kind !== 'union') return;
    const arrayVariant = promised.variants.find((v) => v.kind === 'array');
    expect(arrayVariant).toBeDefined();
    const itemRef = (arrayVariant as { items: { kind: string; name?: string } }).items;
    expect(itemRef.kind).toBe('model');

    // qualifyInlineModelName singularizes the trailing word: "Products" -> "Product".
    expect(itemRef.name).toBe('ContainerProduct');
    const materialized = models.find((m) => m.name === itemRef.name);
    expect(materialized, `have: ${models.map((m) => m.name).join(', ')}`).toBeDefined();
    expect(materialized!.fields.map((f) => f.name)).toEqual(['product']);
  });
});

describe('extractInlineModelsFromSchemas — additionalProperties inline object value (map/dictionary fields)', () => {
  it('materializes the inline object value type of a dictionary field (Stripe: currency_options-style map)', () => {
    // Real Stripe pattern (POST /v1/coupons, currency_options field): a
    // Record<CurrencyCode, CurrencyOption>-shaped field.
    const schema = {
      Container: {
        type: 'object',
        properties: {
          currency_options: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: { amount_off: { type: 'integer' } },
              required: ['amount_off'],
            },
          },
        },
      },
    };

    const promised = schemaToTypeRef(schema.Container.properties.currency_options as never, 'currency_options');
    const models = extractInlineModelsFromSchemas(schema as never);

    expect(promised.kind).toBe('map');
    if (promised.kind !== 'map') return;
    expect(promised.valueType).toEqual({ kind: 'model', name: 'CurrencyOptions' });

    // Deliberately unqualified (no "Container" prefix) -- schemaToTypeRef's
    // own map-value resolution calls itself WITHOUT a parentModelName, so
    // the promised name is field-derived only; matched here exactly.
    const materialized = models.find((m) => m.name === 'CurrencyOptions');
    expect(materialized, `have: ${models.map((m) => m.name).join(', ')}`).toBeDefined();
    expect(materialized!.fields.map((f) => f.name)).toEqual(['amount_off']);
  });

  it('does not treat a freeform additionalProperties (no properties, e.g. additionalProperties: true) as a model', () => {
    const schema = {
      Container: {
        type: 'object',
        properties: {
          metadata: { type: 'object', additionalProperties: true },
        },
      },
    };

    const models = extractInlineModelsFromSchemas(schema as never);
    expect(models.some((m) => m.name.includes('Metadata'))).toBe(false);
  });
});
