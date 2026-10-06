export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    method: method || (body !== undefined ? 'POST' : 'GET'),
    ...(body instanceof FormData
      ? { body }
      : body !== undefined
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
  });
  const text = await r.text();
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`The server returned an invalid response (HTTP ${r.status}). Try again.`);
  }
  if (!r.ok) {
    const error = data?.error;
    const message = typeof error === 'string' ? error : error?.message;
    const requestId = typeof error === 'object' ? error?.requestId : undefined;
    throw new Error(
      (message ||
        (r.status >= 500
          ? `Relay's API server is unavailable (HTTP ${r.status}). Try again.`
          : `Request failed (HTTP ${r.status}). Try again.`)) +
        (requestId ? ` Reference: ${requestId}` : ''),
    );
  }
  if (data === undefined && r.status !== 204)
    throw new Error('The server returned an empty response. Try again.');
  return data;
}
export const pretty = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const duration = (start: string, end?: string) => {
  if (!end) return '—';
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`;
};
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export type Notify = (message: string, error?: boolean) => void;
export type Navigate = (page: string, id?: string) => void;
export type PageProps = { base: string; notify: Notify; go: Navigate; role: string };
