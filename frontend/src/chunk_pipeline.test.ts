import { describe, expect, it } from 'vitest';
import { runOrderedChunkPipeline } from './chunk_pipeline';

describe('ordered chunk pipeline', () => {
  it('limits preparation and consumes chunks in order', async () => {
    let active = 0;
    let peak = 0;
    const consumed: number[] = [];

    const results = await runOrderedChunkPipeline(
      6,
      2,
      async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        await delay(index % 2 === 0 ? 10 : 1);
        active -= 1;
        return index;
      },
      async (value, index) => {
        consumed.push(index);
        return value * 2;
      }
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(consumed).toEqual([0, 1, 2, 3, 4, 5]);
    expect(results).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('stops consuming after a preparation failure', async () => {
    const consumed: number[] = [];

    await expect(
      runOrderedChunkPipeline(
        4,
        2,
        async (index) => {
          if (index === 1) {
            throw new Error('prepare failed');
          }
          return index;
        },
        async (value) => {
          consumed.push(value);
          return value;
        }
      )
    ).rejects.toThrow('prepare failed');

    expect(consumed).not.toContain(1);
  });

  it('waits for an in-flight consumer before reporting a later preparation failure', async () => {
    let consumeFinished = false;

    await expect(
      runOrderedChunkPipeline(
        3,
        2,
        async (index) => {
          if (index === 1) {
            await delay(5);
            throw new Error('later prepare failed');
          }
          return index;
        },
        async (value) => {
          await delay(15);
          consumeFinished = value === 0;
          return value;
        }
      )
    ).rejects.toThrow('later prepare failed');

    expect(consumeFinished).toBe(true);
  });
});

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
