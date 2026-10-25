/** Serialises vault mutations: every `run` waits for the previous one, FIFO; a failure never blocks the next. */
export class VaultLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
