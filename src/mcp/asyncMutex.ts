interface Waiter {
  grant: (release: () => void) => void;
}

/**
 * FIFO async mutex. Waiters whose AbortSignal fires before they acquire the
 * lock are removed from the queue and rejected with the signal's reason.
 */
export class AsyncMutex {
  private locked = false;
  private readonly waiters: Waiter[] = [];

  get isLocked(): boolean {
    return this.locked;
  }

  get pending(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.releaser());
    }
    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortReason(signal!));
      };
      const waiter: Waiter = {
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async runExclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.grant(this.releaser());
      } else {
        this.locked = false;
      }
    };
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("The operation was aborted");
}
