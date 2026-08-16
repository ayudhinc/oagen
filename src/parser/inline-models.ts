import type { Model, Field } from '../ir/types.js';
import { toPascalCase, stripListItemMarkers, singularize } from '../utils/naming.js';
import type { SchemaObject } from './schemas.js';
import { buildFieldFromSchema, resolveSchemaName } from './schemas.js';

/**
 * Qualify an inline model name with the parent schema name.
 * If `parentName` is provided and the field name doesn't already start with
 * the parent, the result is `${parentName}${PascalField}` with the trailing
 * word singularized (e.g., Connection + Domains → ConnectionDomain).
 */
export function qualifyInlineModelName(baseName: string, parentName?: string): string {
  if (!parentName) return baseName;
  // Strip ListItem/ByExternalId markers from parent name so inline model names
  // are clean and match the names produced by qualifyNestedName() in responses.ts.
  // e.g., ConnectionListItem + Domains → Connection + Domain = ConnectionDomain
  const cleanParent = stripListItemMarkers(parentName);
  if (baseName.startsWith(cleanParent)) return baseName;
  // Singularize the trailing PascalCase word of the combined name.
  // Split baseName into leading words + trailing word, singularize trailing.
  const trailingMatch = baseName.match(/^(.*?)([A-Z][a-z]*)$/);
  if (trailingMatch) {
    const [, prefix, trailingWord] = trailingMatch;
    const singular = singularize(trailingWord);
    return `${cleanParent}${prefix}${singular}`;
  }
  return `${cleanParent}${baseName}`;
}

/**
 * Walk all component schemas and extract inline Model definitions for fields
 * that are objects with properties (or arrays of such objects).
 * These correspond to the ModelRef entries created by schemaToTypeRef.
 */
export function extractInlineModelsFromSchemas(schemas: Record<string, SchemaObject> | undefined): Model[] {
  if (!schemas) return [];

  const inlineModels: Model[] = [];

  for (const [schemaName, schema] of Object.entries(schemas)) {
    const parentName = resolveSchemaName(schemaName);
    extractInlineModelsFromProperties(schema, inlineModels, parentName);
  }

  return inlineModels;
}

export function extractInlineModelsFromProperties(schema: SchemaObject, results: Model[], parentName?: string): void {
  const properties = schema.properties ?? {};
  const allOfSchemas = schema.allOf ?? [];

  for (const sub of allOfSchemas) {
    if (sub.properties) {
      extractInlineModelsFromProperties(sub, results, parentName);
    }
  }

  for (const [fieldName, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema) continue;
    // Direct inline object with properties (with or without explicit type: 'object')
    if (fieldSchema.properties && (fieldSchema.type === 'object' || !fieldSchema.type)) {
      const baseName = toPascalCase(fieldName);
      const modelName = qualifyInlineModelName(baseName, parentName);
      results.push(buildInlineModel(modelName, fieldSchema));
      extractInlineModelsFromProperties(fieldSchema, results, modelName);
    }

    // Array of inline objects
    if (fieldSchema.type === 'array' && fieldSchema.items) {
      const items = fieldSchema.items;
      if (items.properties && (items.type === 'object' || !items.type)) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        results.push(buildInlineModel(modelName, items));
        extractInlineModelsFromProperties(items, results, modelName);
      }
    }

    // Inline object VALUE type for a dictionary/map field
    // (`additionalProperties: { properties: ... }`, e.g. Stripe's
    // `currency_options: { additionalProperties: { properties: { amount_off... } } }`
    // -- a `Record<CurrencyCode, CurrencyOption>`-shaped field). schemaToTypeRef's
    // own map-handling branch resolves the value type via
    // `schemaToTypeRef(schema.additionalProperties, contextName)` --
    // deliberately called WITHOUT a parentModelName, so the promised model
    // name is unqualified (field-derived only, e.g. "CurrencyOptions", not
    // prefixed by the enclosing request/model name the way every other case
    // in this function is) -- matched here exactly rather than qualified,
    // or the materialized model wouldn't have the name the reference
    // actually points at.
    if (
      fieldSchema.type === 'object' &&
      !fieldSchema.properties &&
      typeof fieldSchema.additionalProperties === 'object'
    ) {
      const valueSchema = fieldSchema.additionalProperties as SchemaObject;
      if (valueSchema.properties && (valueSchema.type === 'object' || !valueSchema.type)) {
        const modelName = toPascalCase(fieldName);
        if (!results.some((r) => r.name === modelName)) {
          results.push(buildInlineModel(modelName, valueSchema));
          extractInlineModelsFromProperties(valueSchema, results, modelName);
        }
      }
    }

    // Inline object expressed via `allOf` (no $ref / oneOf / anyOf members).
    // schemaToTypeRef collapses such a field into a single merged model ref, so
    // materialize that model — otherwise the ref dangles exactly like a direct
    // inline object would. An `allOf` containing a `$ref` is the augmentation
    // case resolved through the ref path and is intentionally left alone here.
    if (fieldSchema.allOf && fieldSchema.allOf.every((s) => !s.$ref && !s.oneOf && !s.anyOf)) {
      const merged = mergeAllOfObjectSchema(fieldSchema);
      if (Object.keys(merged.properties ?? {}).length > 0) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        results.push(buildInlineModel(modelName, merged));
        extractInlineModelsFromProperties(merged, results, modelName);
      }
    }

    // oneOf/anyOf containing objects — extract every inline object variant as
    // a model so each gets its own typed class. Variant 0 keeps the bare
    // qualified inline name (e.g. `ApiKeyCreatedDataOwner`); subsequent
    // variants are prefixed by their const-discriminator value via
    // `nameOneOfVariant` (e.g. `UserApiKeyCreatedDataOwner`). When the
    // union doesn't have a const-discriminator (single object variant + null
    // for nullable, or single object variant only), only variant 0 is
    // extracted and the bare name pattern preserves backward compat.
    //
    // anyOf is handled identically to oneOf here (same variant-naming
    // helpers, unaware of which composition keyword produced them) --
    // schemaToTypeRef's own union-building code (schemas.ts) treats the two
    // structurally the same way for variant TypeRef construction, so a field
    // whose schema is `anyOf: [{properties:...}, {type:'string'}]` (a real,
    // common Stripe request-body pattern: "either a structured object or a
    // plain token") gets the exact same promised model name either way.
    // Before this handled anyOf, that promise was never materialized here --
    // ONLY the oneOf case was -- so any anyOf-with-inline-object-variant
    // field left a dangling model reference. Confirmed as the dominant real
    // cause of oagen's own "Unresolved model reference" warning on a real
    // large spec (554 of 554 occurrences on Stripe's published spec traced
    // to this exact anyOf shape, none to the oneOf case this already handled).
    const unionVariants = fieldSchema.oneOf ?? fieldSchema.anyOf;
    if (unionVariants) {
      // A variant can itself be `{ type: 'array', items: { properties... } }`
      // -- "either a list of structured objects, or a plain string/enum" is
      // a real, common Stripe pattern (e.g. a `products` field: array of
      // product-selector objects, or the literal empty-string sentinel).
      // schemaToTypeRef's array branch resolves such a variant by recursing
      // into `items` with the SAME contextName/parentModelName as the field
      // itself, so the promised model name comes from the field name exactly
      // as the direct-object case does (qualifyInlineModelName's own
      // singularization then turns "Products" into "...Product"); the
      // object shape to extract fields/nested models from is `items`, not
      // the array wrapper.
      const objectShapeOf = (v: SchemaObject): SchemaObject | null =>
        v.properties && (v.type === 'object' || !v.type)
          ? v
          : v.type === 'array' && v.items?.properties
            ? v.items
            : null;

      const inlineObjectVariants = unionVariants
        .filter((v) => !v.$ref)
        .map((v) => ({ variant: v, shape: objectShapeOf(v) }))
        .filter((entry): entry is { variant: SchemaObject; shape: SchemaObject } => entry.shape !== null);

      if (inlineObjectVariants.length > 0) {
        const baseName = toPascalCase(fieldName);
        const modelName = qualifyInlineModelName(baseName, parentName);
        const existingNames = new Set(results.map((r) => r.name));
        const namingDiscProp = deriveOneOfNamingDiscriminator(inlineObjectVariants.map((e) => e.shape));
        const emittedNames: string[] = [];
        for (const { shape } of inlineObjectVariants) {
          const variantName = nameOneOfVariant(shape, modelName, emittedNames, namingDiscProp);
          emittedNames.push(variantName);
          if (!existingNames.has(variantName)) {
            existingNames.add(variantName);
            results.push(buildInlineModel(variantName, shape));
            extractInlineModelsFromProperties(shape, results, variantName);
          }
        }
      }
    }
  }
}

/** Find a single string-const-valued property shared by every variant whose
 *  values are all distinct — the implicit discriminator. Returns null when no
 *  such property exists. Mirrors `deriveConstNamingDiscriminator` in schemas.ts. */
function deriveOneOfNamingDiscriminator(variants: SchemaObject[]): string | null {
  if (variants.length < 2) return null;
  const candidates = Object.keys(variants[0]?.properties ?? {});
  for (const propName of candidates) {
    const values = variants.map((v) => readConstString(v.properties?.[propName]));
    if (values.some((v) => v === null)) continue;
    if (new Set(values).size !== values.length) continue;
    return propName;
  }
  return null;
}

function readConstString(prop: SchemaObject | undefined): string | null {
  if (!prop) return null;
  if (typeof prop.const === 'string') return prop.const;
  if (Array.isArray(prop.enum) && prop.enum.length === 1 && typeof prop.enum[0] === 'string') {
    return prop.enum[0];
  }
  return null;
}

/** Produce a per-variant model name. Variant 0 keeps the bare parent name;
 *  later variants are prefixed by the const-derived label. Mirrors
 *  `nameVariantModel` in schemas.ts. Falls back to a numeric suffix when no
 *  discriminator is available, the const value PascalCases to nothing, or
 *  the derived candidate collides with the parent or an already-emitted name. */
function nameOneOfVariant(
  variant: SchemaObject,
  parentName: string,
  alreadyEmitted: string[],
  discriminatorProperty: string | null,
): string {
  if (alreadyEmitted.length === 0) return parentName;
  if (discriminatorProperty) {
    const constValue = readConstString(variant.properties?.[discriminatorProperty]);
    if (constValue) {
      const prefix = toPascalCase(constValue);
      if (prefix) {
        const candidate = parentName.startsWith(prefix) ? parentName : `${prefix}${parentName}`;
        const collision = candidate === parentName || alreadyEmitted.includes(candidate);
        if (!collision) return candidate;
      }
    }
  }
  return `${parentName}${alreadyEmitted.length + 1}`;
}

/**
 * Merge the object members of an `allOf` (recursively) into a single
 * object-shaped schema, so an inline object expressed via `allOf` can be
 * materialized as one model — mirroring how schemaToTypeRef collapses such a
 * field into a single merged model ref. Earlier members win on key conflicts,
 * matching the merge order used elsewhere in the parser.
 */
function mergeAllOfObjectSchema(schema: SchemaObject): SchemaObject {
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  const visit = (s: SchemaObject): void => {
    if (s.properties) {
      for (const [key, value] of Object.entries(s.properties)) {
        if (value && !(key in properties)) properties[key] = value;
      }
    }
    if (s.required) required.push(...s.required);
    if (s.allOf) for (const sub of s.allOf) visit(sub);
  };
  visit(schema);
  return { type: 'object', properties, required, description: schema.description };
}

function buildInlineModel(name: string, schema: SchemaObject): Model {
  const requiredSet = new Set(schema.required ?? []);
  const fields: Field[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!fieldSchema) continue;
    fields.push(buildFieldFromSchema(fieldName, fieldSchema, name, requiredSet));
  }

  return { name, description: schema.description, fields };
}
