import { isDeepStrictEqual } from "node:util";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const joinPath = (base, key) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(key))
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(String(key))}]`;

const resolveLocalReference = (rootSchema, reference) => {
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    throw new Error(`Unsupported JSON Schema reference: ${reference}`);
  }
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], rootSchema);
};

const matchesType = (value, type) => {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
};

const isValidFormat = (value, format) => {
  if (format === "date-time") {
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) && Number.isFinite(Date.parse(value))
    );
  }
  if (format === "uuid") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
  if (format === "uri") {
    try {
      const parsed = new URL(value);
      return parsed.protocol.length > 1 && !/\s/.test(value);
    } catch {
      return false;
    }
  }
  throw new Error(`Unsupported JSON Schema format: ${format}`);
};

export const collectJsonSchemaErrors = (
  value,
  schema,
  rootSchema = schema,
  valuePath = "$",
) => {
  if (schema === true) return [];
  if (schema === false) return [`${valuePath} is forbidden by the schema`];
  if (!isRecord(schema)) {
    throw new Error(`Invalid JSON Schema node at ${valuePath}`);
  }
  if (schema.$ref !== undefined) {
    const resolved = resolveLocalReference(rootSchema, schema.$ref);
    if (resolved !== true && resolved !== false && !isRecord(resolved)) {
      throw new Error(`Unresolved JSON Schema reference: ${schema.$ref}`);
    }
    return collectJsonSchemaErrors(value, resolved, rootSchema, valuePath);
  }

  const errors = [];
  if (Array.isArray(schema.allOf)) {
    for (const childSchema of schema.allOf) {
      errors.push(
        ...collectJsonSchemaErrors(value, childSchema, rootSchema, valuePath),
      );
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((childSchema) =>
      collectJsonSchemaErrors(value, childSchema, rootSchema, valuePath),
    );
    const matchingBranches = branchErrors.filter(
      (candidateErrors) => candidateErrors.length === 0,
    ).length;
    if (matchingBranches !== 1) {
      errors.push(
        `${valuePath} must match exactly one schema branch; matched ${matchingBranches}`,
      );
    }
  }

  if (schema.const !== undefined && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${valuePath} must equal ${JSON.stringify(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))
  ) {
    errors.push(`${valuePath} is not an allowed enum value`);
  }

  if (schema.type !== undefined) {
    const expectedTypes = Array.isArray(schema.type)
      ? schema.type
      : [schema.type];
    if (!expectedTypes.some((type) => matchesType(value, type))) {
      errors.push(`${valuePath} must have type ${expectedTypes.join(" or ")}`);
      return errors;
    }
  }

  if (typeof value === "string") {
    const codePointLength = [...value].length;
    if (
      Number.isSafeInteger(schema.minLength) &&
      codePointLength < schema.minLength
    ) {
      errors.push(
        `${valuePath} must contain at least ${schema.minLength} characters`,
      );
    }
    if (
      Number.isSafeInteger(schema.maxLength) &&
      codePointLength > schema.maxLength
    ) {
      errors.push(
        `${valuePath} must contain at most ${schema.maxLength} characters`,
      );
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      errors.push(`${valuePath} does not match its required pattern`);
    }
    if (
      typeof schema.format === "string" &&
      !isValidFormat(value, schema.format)
    ) {
      errors.push(`${valuePath} is not a valid ${schema.format}`);
    }
  }

  if (
    typeof value === "number" &&
    Number.isFinite(schema.minimum) &&
    value < schema.minimum
  ) {
    errors.push(`${valuePath} must be at least ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (
      Number.isSafeInteger(schema.minItems) &&
      value.length < schema.minItems
    ) {
      errors.push(
        `${valuePath} must contain at least ${schema.minItems} items`,
      );
    }
    if (
      Number.isSafeInteger(schema.maxItems) &&
      value.length > schema.maxItems
    ) {
      errors.push(`${valuePath} must contain at most ${schema.maxItems} items`);
    }
    if (
      schema.uniqueItems === true &&
      value.some((item, index) =>
        value.slice(index + 1).some((other) => isDeepStrictEqual(item, other)),
      )
    ) {
      errors.push(`${valuePath} must contain unique items`);
    }
    const prefixItems = Array.isArray(schema.prefixItems)
      ? schema.prefixItems
      : [];
    prefixItems.slice(0, value.length).forEach((itemSchema, index) => {
      errors.push(
        ...collectJsonSchemaErrors(
          value[index],
          itemSchema,
          rootSchema,
          `${valuePath}[${index}]`,
        ),
      );
    });
    if (schema.items !== undefined) {
      value.slice(prefixItems.length).forEach((item, offset) => {
        const index = prefixItems.length + offset;
        errors.push(
          ...collectJsonSchemaErrors(
            item,
            schema.items,
            rootSchema,
            `${valuePath}[${index}]`,
          ),
        );
      });
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const property of schema.required) {
        if (!Object.hasOwn(value, property)) {
          errors.push(`${joinPath(valuePath, property)} is required`);
        }
      }
    }
    if (isRecord(schema.dependentRequired)) {
      for (const [property, dependencies] of Object.entries(
        schema.dependentRequired,
      )) {
        if (!Object.hasOwn(value, property) || !Array.isArray(dependencies)) {
          continue;
        }
        for (const dependency of dependencies) {
          if (!Object.hasOwn(value, dependency)) {
            errors.push(
              `${joinPath(valuePath, dependency)} is required with ${property}`,
            );
          }
        }
      }
    }
    if (isRecord(schema.propertyNames)) {
      for (const property of Object.keys(value)) {
        errors.push(
          ...collectJsonSchemaErrors(
            property,
            schema.propertyNames,
            rootSchema,
            `${valuePath} property name`,
          ),
        );
      }
    }
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, property)) {
        errors.push(
          ...collectJsonSchemaErrors(
            value[property],
            propertySchema,
            rootSchema,
            joinPath(valuePath, property),
          ),
        );
      }
    }
    const unknownProperties = Object.keys(value).filter(
      (property) => !Object.hasOwn(properties, property),
    );
    if (schema.additionalProperties === false) {
      for (const property of unknownProperties) {
        errors.push(`${joinPath(valuePath, property)} is not allowed`);
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const property of unknownProperties) {
        errors.push(
          ...collectJsonSchemaErrors(
            value[property],
            schema.additionalProperties,
            rootSchema,
            joinPath(valuePath, property),
          ),
        );
      }
    }
  }

  return errors;
};

const assertSchemaMatch = (value, schema, definition, label) => {
  const targetSchema = schema.$defs?.[definition];
  if (!isRecord(targetSchema)) {
    throw new Error(`Release State schema lacks definition: ${definition}`);
  }
  const errors = collectJsonSchemaErrors(value, targetSchema, schema);
  if (errors.length > 0) {
    throw new Error(
      `${label} schema mismatch: ${errors.slice(0, 8).join("; ")}`,
    );
  }
};

export const assertReleaseEventMatchesSchema = (event, schema, label) => {
  assertSchemaMatch(
    event,
    schema,
    "releaseEventEnvelope",
    label ?? "Release State event",
  );
};

export const assertReleaseStateSnapshotMatchesSchema = (
  snapshot,
  schema,
  label,
) => {
  assertSchemaMatch(
    snapshot,
    schema,
    "releaseStateSnapshot",
    label ?? "Release State snapshot",
  );
};
