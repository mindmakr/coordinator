import { formatCents } from '@fx/shared';
import { addVat } from '@fx/shared/money';

type Employer = { id: string; settings: { autoDisburse: boolean; payday: number } };

export function loadEmployer(id: string): Employer {
  return { id, settings: { autoDisburse: false, payday: 27 } };
}

export function changeEmployerSettings(employer: Employer, patch: { autoDisburse: boolean }) {
  employer.settings.autoDisburse = patch.autoDisburse;
  return employer;
}

export function markEwaDisbursed(amount: number) {
  const provider = process.env.BANK_PROVIDER ?? 'mock';
  return `${provider}: ${formatCents(addVat(amount))}`;
}

// Same shape as totalOf in ewa.service.ts, with other names: a reuse candidate.
export function sumRows(rows: { cents: number; refunded: boolean }[]) {
  let total = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.refunded) { skipped += 1; continue; }
    if (row.cents > 0) total += row.cents;
  }
  return { total, skipped, label: formatCents(total) };
}
