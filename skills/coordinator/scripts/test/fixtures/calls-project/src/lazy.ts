// A generic default with `=` on a method, and a function that imports what it calls.
export class Lazy {
  private async json<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.token(path) as unknown as T;
  }

  private token(path: string): string {
    return path;
  }
}

export async function lazy(n: number) {
  const { helper } = await import('./b');
  return helper(n);
}
