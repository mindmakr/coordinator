import { helper } from '../b';

export function Card({ title }: { title: string }) {
  return <div className="card">{title} {helper(1)}</div>;
}

export const ui = {
  Button: (p: { label: string; onClick: () => void }) => <button onClick={p.onClick}>{p.label}</button>,
};
