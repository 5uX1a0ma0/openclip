export async function runOrderedChunkPipeline<T, R>(
  count: number,
  prepareConcurrency: number,
  prepare: (index: number) => Promise<T>,
  consume: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (count <= 0) {
    return [];
  }

  const capacity = Math.max(1, Math.floor(prepareConcurrency) || 1);
  const ready = new Map<number, T>();
  const results = new Array<R>(count);
  let nextToPrepare = 0;
  let nextToConsume = 0;
  let preparing = 0;
  let consuming = false;
  let failure: { error: unknown } | null = null;
  let settled = false;

  return new Promise<R[]>((resolve, reject) => {
    const fail = (error: unknown) => {
      if (settled || failure) {
        return;
      }
      failure = { error };
      if (!consuming) {
        settled = true;
        reject(error);
      }
    };

    const pump = () => {
      if (settled || failure) {
        return;
      }
      while (nextToPrepare < count && preparing + ready.size + (consuming ? 1 : 0) < capacity) {
        const index = nextToPrepare;
        nextToPrepare += 1;
        preparing += 1;
        void Promise.resolve()
          .then(() => prepare(index))
          .then(
            (value) => {
              preparing -= 1;
              if (settled) {
                return;
              }
              ready.set(index, value);
              pump();
            },
            (error) => {
              preparing -= 1;
              fail(error);
            }
          );
      }

      if (!consuming && ready.has(nextToConsume)) {
        const index = nextToConsume;
        const value = ready.get(index) as T;
        ready.delete(index);
        consuming = true;
        void Promise.resolve()
          .then(() => consume(value, index))
          .then(
            (result) => {
              consuming = false;
              if (settled) {
                return;
              }
              results[index] = result;
              nextToConsume += 1;
              if (failure) {
                settled = true;
                reject(failure.error);
                return;
              }
              if (nextToConsume === count) {
                settled = true;
                resolve(results);
                return;
              }
              pump();
            },
            (error) => {
              consuming = false;
              if (failure) {
                settled = true;
                reject(error);
                return;
              }
              fail(error);
            }
          );
      }
    };

    pump();
  });
}
