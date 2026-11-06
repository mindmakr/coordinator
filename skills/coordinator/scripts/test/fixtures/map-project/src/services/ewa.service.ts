import { changeEmployerSettings, loadEmployer, markEwaDisbursed } from './employer.service';

export function disburse(employerId: string, amount: number) {
  const employer = loadEmployer(employerId);
  if (!employer.settings.autoDisburse) changeEmployerSettings(employer, { autoDisburse: true });
  return markEwaDisbursed(amount);
}

export function totalOf(items: { cents: number; refunded: boolean }[]) {
  let sum = 0;
  let dropped = 0;
  for (const item of items) {
    if (item.refunded) { dropped += 1; continue; }
    if (item.cents > 0) sum += item.cents;
  }
  return { sum, dropped, label: fmt(sum) };
}

const fmt = (n: number) => `${n}`;
