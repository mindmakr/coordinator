import { helper } from '../b';

export interface Runner {
  run(input: string): Promise<void>;
  stop(): { ok: boolean };
}

export type Callback = (err: Error | null) => void;

export class Service implements Runner {
  private count: number = 0;

  async run(input: string): Promise<void> {
    this.inner(input.length);
  }

  stop(): { ok: boolean } {
    return { ok: this.inner(0) > 0 };
  }

  private inner(n: number): number {
    this.count += helper(n);
    return this.count;
  }
}
