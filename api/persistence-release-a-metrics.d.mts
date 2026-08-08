declare const handler: (request: object, response: object) => Promise<void>;

export const validatePersistenceReleaseAMetricsRequest: (
  value: unknown,
) => boolean;

export const toDatabaseRow: (request: unknown) => Record<string, unknown>;

export default handler;
