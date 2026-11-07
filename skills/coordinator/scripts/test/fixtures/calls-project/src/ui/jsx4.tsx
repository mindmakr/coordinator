// The critic's fixture: one-line JSX in an attribute and in a condition must not end a function early.
import { helper } from '../b';
const other = () => 2; const third = () => 3; const fourth = () => 4;
import { Card as Child } from './Card';
export function Attr() {
  return <Wrap icon={(s: number) => <Child x={s} />} />;
}
export function After1() { return helper(1); }
export function Cond(p: { ok: boolean }) {
  return <div>{p.ok && (<Child x={1} />)}</div>;
}
export function After2() { return other(); }
export const typed = (): number => Config.value;
export const anyish = (q: string) => anyOf(q);
export function Wrap(p: any) { return null; }
export function Gen() { const v = useState<number>(0); return v; }
export function Cmp(a: number, b: number) { return a < b ? third() : fourth(); }
function Config() {}
function anyOf(q: string) { return q; }
