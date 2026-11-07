import { Card, ui } from './Card';
import { useQuery } from 'react-query';
import { fmt } from '../b';

export function Page({ items, flag }: { items: string[]; flag: boolean }) {
  const save = () => fmt(1);
  const q = useQuery({ queryKey: ['x'], queryFn: () => fmt(2), onSuccess() { save(); } });
  setTimeout(
    save,
    10);
  if (flag) {
    const fmt = pick();
    fmt();
  }
  return (
    <section>
      <p>Call notAFunction(1) and twice(2) here, (unbalanced</p>
      {items.map((i) => <Card key={i} title={fmt(3)} />)}
      <ui.Button label="Go" onClick={save} />
    </section>
  );
}
