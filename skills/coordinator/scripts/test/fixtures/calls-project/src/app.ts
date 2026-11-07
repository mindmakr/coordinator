import greet, { fmt } from './b';
import * as all from './index';
import { Svc } from '@/index';
import { Service } from './svc/service';

/* A block comment: fakeBlock() */
const label = "a string with fake() inside";
const tpl = `also notReal() in a template`;

export class App {
  private svc: Service;
  private other = new Svc();

  constructor() {
    this.svc = new Service();
  }

  start<T>(arg: T): void {
    this.svc.run(String(arg));
    this.other.stop();
    this.log(fmt(2));
  }

  log(msg: string) {
    console.log(msg, label, tpl);
  }
}

export function main(): void {
  const app = new App();
  app.start<number>(1);
  greet('x');
  all.helper(3);
  [1, 2].map((n) => all.fmt(n));
  setTimeout(main2, 10);
}

function main2() {
  new Service().run('again');
}

function overloaded(a: string): string;
function overloaded(a: number): number;
function overloaded(a: any): any {
  return main2();
}
