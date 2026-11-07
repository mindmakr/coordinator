// Helpers. A comment with a fake call: notACall(1)
export function helper(x: number): number {
  return twice(x) + 1;
}

function twice(n: number) {
  return n * 2;
}

export const fmt = (x: number): string => String(twice(x));

export default function greet(name: string) {
  return `hi ${name} ${fmt(1)}`; // the template's expression is code
}
