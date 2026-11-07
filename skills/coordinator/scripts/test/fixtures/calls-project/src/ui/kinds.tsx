// A child on its parent's line, type-like arrow bodies, get/set/as keys, forwardRef and memo, nested objects.
import { forwardRef, memo } from 'react';
import React from 'react';
import { Card as Child } from './Card';
const load = () => 1; const save = (v: number) => v; const cast = () => 0; const fmt = (p: unknown) => String(p); const go = () => 1;
const fetchUsers = () => []; const fetchOne = (id: string) => id;
const Config = { value: 1 };
export function Same() { return <div><Child x={1} /></div>; }
export const hasAny = (anyOf: string[]) => anyOf.length > 0;
export const typed = (): number => Config.value;
export const store = { get: () => load(), set: (v: number) => save(v), as: () => cast() };
export const Fancy = forwardRef((props: P, ref) => <b ref={ref}>{fmt(props)}</b>);
export const Row = React.memo(function Row() { return go(); });
export const Light = memo((p: P) => <i>{p.x}</i>);
export const api = { users: { list() { return fetchUsers(); }, one: (id: string) => fetchOne(id) } };
export function useIt() { return api.users.list(); }
export function Ratio(p: { a: number; b: number }) {
  return <p>{p.a} / {p.b} ({p.a}/{p.b})</p>;
}
export function AfterRatio() { return go(); }
