export function removeRecordKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

export function upsertRecordKey<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): Record<string, T> {
  return {
    ...record,
    [key]: value,
  };
}

export function renameRecordKey<T>(
  record: Record<string, T>,
  oldKey: string,
  newKey: string,
): Record<string, T> {
  const nextRecord = { ...record };
  if (Object.prototype.hasOwnProperty.call(nextRecord, oldKey)) {
    nextRecord[newKey] = nextRecord[oldKey];
    delete nextRecord[oldKey];
  }
  return nextRecord;
}
