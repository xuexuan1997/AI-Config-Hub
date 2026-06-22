import type { AbsolutePath } from "@ai-config-hub/shared";

interface LockReservation {
  readonly tail: Promise<void>;
  readonly release: () => void;
}

export class PathLockManager {
  readonly #tails = new Map<AbsolutePath, Promise<void>>();

  async withPaths<T>(paths: readonly AbsolutePath[], operation: () => Promise<T>): Promise<T> {
    const orderedPaths = [...new Set(paths)].sort();
    const reservations: LockReservation[] = [];

    try {
      for (const path of orderedPaths) {
        const previous = this.#tails.get(path) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => held);
        this.#tails.set(path, tail);
        await previous;
        reservations.push({ tail, release });
      }

      return await operation();
    } finally {
      for (const reservation of reservations.reverse()) {
        reservation.release();
      }
      for (const [path, tail] of this.#tails) {
        if (reservations.some((reservation) => reservation.tail === tail)) {
          void tail.then(() => {
            if (this.#tails.get(path) === tail) this.#tails.delete(path);
          });
        }
      }
    }
  }
}
