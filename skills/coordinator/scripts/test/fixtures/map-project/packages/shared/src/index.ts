export * from './money';

export function formatCents(cents: number): string {
  return `SAR ${(cents / 100).toFixed(2)}`;
}
