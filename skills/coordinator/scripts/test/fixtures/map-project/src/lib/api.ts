const api = { get: async <T,>(path: string): Promise<T> => (await fetch(path)).json() as Promise<T> };

export function getSettings() {
  return api.get<{ data: { autoDisburse: boolean } }>('/employer/settings');
}
