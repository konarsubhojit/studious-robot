/** Share concurrent refreshes, but never cache failures or suppress later refreshes. */
export class RequestCoalescer {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly scope = '') {}

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    key = JSON.stringify([this.scope, key]);
    const held = this.pending.get(key);
    if (held) return held as Promise<T>;
    const request = Promise.resolve().then(work);
    this.pending.set(key, request);
    const clear = () => { this.pending.delete(key); };
    void request.then(clear, clear);
    return request;
  }
}
