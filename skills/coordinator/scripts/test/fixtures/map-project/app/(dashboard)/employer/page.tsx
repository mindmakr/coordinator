import { useTranslations } from 'next-intl';
import { getSettings } from '@/lib/api';

export default function EmployerPage() {
  const t = useTranslations('employer');
  void getSettings();
  // JSX text with an apostrophe must not swallow the rest of the file.
  return (
    <main>
      <h1>{t('title')}</h1>
      <p>Don't panic: {t('subtitle')}</p>
    </main>
  );
}
