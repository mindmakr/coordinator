export const addVat = (cents: number, rate = 0.15) => Math.round(cents * (1 + rate));
