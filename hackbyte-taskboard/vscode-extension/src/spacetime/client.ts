import type { ExtensionConfig, SqlQueryResponse } from '../types';

export async function executeSql(
  config: ExtensionConfig,
  query: string
): Promise<SqlQueryResponse> {
  const response = await fetch(databaseUrl(config, 'sql'), {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
    },
    body: query,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = (await response.json()) as SqlQueryResponse | SqlQueryResponse[];
  return Array.isArray(payload) ? payload[0] : payload;
}

export async function callReducer(
  config: ExtensionConfig,
  reducerName: string,
  args: unknown[]
): Promise<void> {
  const response = await fetch(databaseUrl(config, `call/${reducerName}`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  await response.text();
}

export function mapSqlRows(response: SqlQueryResponse): Array<Record<string, unknown>> {
  const columns = response.schema.elements.map(
    (element, index) => element.name?.some ?? `column_${index}`
  );

  return response.rows.map(row =>
    Object.fromEntries(columns.map((column, index) => [column, row[index]]))
  );
}

export function decodeOptionString(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  return value[0] === 0 ? String(value[1]) : undefined;
}

export function decodeTimestampToIso(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'number') {
    return undefined;
  }

  return new Date(Math.trunc(value[0] / 1000)).toISOString();
}

export function decodeIdentity(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== 'string') {
    return undefined;
  }

  return value[0];
}

function databaseUrl(config: ExtensionConfig, pathSuffix: string): string {
  const base = config.spacetimeHttpUrl.replace(/\/+$/, '');
  const suffix = pathSuffix.replace(/^\/+/, '');
  return `${base}/v1/database/${config.databaseName}/${suffix}`;
}
