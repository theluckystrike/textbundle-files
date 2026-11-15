// Review round 3, probe R3-10: a deflate stream of 1 GB or 4 GB of zeros in a 1 MB or 4 MB pack must be refused at once.
import { beforeAll, describe, expect, it } from 'vitest';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { readPack } from '../src/bundle';
import { deflatedZip } from './zipcraft';
import { ROUNDS, pairedRatio } from './growth';
import { budget } from './time-scale';

/**
 * One MiB of zeros as raw deflate (level 9), cut with a full flush: the segment ends on a byte boundary and no later
 * block refers back into it. So the segment repeated k times, then an empty final block, is one valid raw deflate
 * stream of exactly k MiB of zeros.
 */
const SEGMENT = deflateRawSync(Buffer.alloc(1024 * 1024), { level: 9, finishFlush: constants.Z_FULL_FLUSH });
/** Final block: BFINAL 1, fixed Huffman codes, end of block at once. */
const FINAL = Buffer.from([0x03, 0x00]);
const MIB = 1024 * 1024;

/**
 * Raw deflate of `gb` gigabytes of zeros: the full-flush segment 1,024 times per GB, 1.06 MB for each GB (a streamed
 * level 9 deflate gives 1.04 MB). It takes about 3 ms. The streamed deflate of the zeros took 9 s on this Mac and
 * about 108 s on a CI runner (run 40988743467: 21.0 s for 1 GB, 86.7 s for 4 GB; this Mac 1.7 s and 7.1 s, s1104
 * CIFIX-B). The 1 GB and 4 GB of zeros are never in memory.
 */
function zeros(gb: number): Uint8Array {
	return new Uint8Array(Buffer.concat([...Array.from({ length: gb * 1024 }, () => SEGMENT), FINAL]));
}

function timed(fn: () => unknown): { ms: number; error: string } {
	const start = performance.now();
	try {
		fn();
		return { ms: performance.now() - start, error: 'accepted' };
	} catch (error) {
		return { ms: performance.now() - start, error: (error as Error).message };
	}
}

// Timing guards that hold on a slow shared CI runner (s1101 FIX round 2). A wall-clock limit (5,000 ms) failed on a
// GitHub runner at 5,108 ms (run 40988743467). Each guard divides two times that the same test measures, so a slow
// runner slows both times and the ratio stays. Each side is the lowest time over ROUNDS rounds, then the guard divides
// (s1103b ASSERT-B, Procedure AC: never the lowest ratio, never one draw).
const STOP_MESSAGE = 'Refused the pack: "assets/a.png" unpacks to more than its declared size.';
const REFUSE_MESSAGE = 'Refused the pack: "assets/a.png" has more packed data than its declared size allows.';
const packs: Record<number, Uint8Array> = {};
/** Time to read a pack that declares `mb` MB (200 MB by default): the reader unpacks `mb` MB and stops there. */
const stopRun = (gb: number, mb = 200) => timed(() => readPack('bomb.textpack', deflatedZip(packs[gb]!, mb * 1024 * 1024)));
/** Reads a pack and keeps the error, so pairedRatio can time a read that throws. */
const quiet = (bytes: Uint8Array) => () => timed(() => readPack('bomb.textpack', bytes));

describe('CPU bombs (R3-10)', () => {
	beforeAll(() => {
		packs[1] = zeros(1);
		packs[4] = zeros(4);
	});

	it('builds a valid deflate stream of zeros: 1 segment is 1 MiB of zeros, 3 segments are 3 MiB', () => {
		const one = inflateRawSync(Buffer.concat([SEGMENT, FINAL]));
		const three = inflateRawSync(Buffer.concat([SEGMENT, SEGMENT, SEGMENT, FINAL]));
		expect(one.length).toBe(MIB);
		expect(three.length).toBe(3 * MIB);
		expect(three.every((b) => b === 0)).toBe(true);
		expect(packs[1]!.length).toBe(SEGMENT.length * 1024 + FINAL.length);
		expect(packs[4]!.length).toBe(SEGMENT.length * 4096 + FINAL.length);
	});

	for (const gb of [1, 4]) {
		it(`refuses ${gb} GB of zeros declared as 10 bytes in less than a tenth of the time to unpack 200 MB`, () => {
			const packed = packs[gb]!;
			expect(packed.length).toBeLessThan(5 * 1024 * 1024);
			const refuse = deflatedZip(packed, 10);
			const stop = deflatedZip(packs[1]!, 200 * 1024 * 1024);
			expect(timed(() => readPack('bomb.textpack', refuse)).error).toBe(REFUSE_MESSAGE);
			expect(stopRun(1).error).toBe(STOP_MESSAGE);
			// Baseline: a 200 MB unpack in this test. A refusal that unpacks the bomb takes 5 to 20 times the baseline,
			// so the baseline over the refusal falls below 1. The guard asks for more than 10.
			const r = pairedRatio(quiet(refuse), quiet(stop));
			expect(r.ratio, `${r.text}: 200 MB unpack against refusal`).toBeGreaterThan(10);
		}, budget(120_000));
	}

	it('stops the stream at the declared size when the size fits the ratio: 4 GB and 1 GB of zeros declared as 50 MB take about the same time', () => {
		// The packs declare 50 MB, not 200 MB: one 200 MB unpack took 5,108 ms on a CI runner (run 40988743467) and
		// 220-243 ms here, so 10 unpacks of 200 MB took about 51 s of the 120 s timeout there (s1104 R-CI-B). 10 unpacks
		// of 50 MB take about 13 s there. A reader that unpacks the whole stream still reads 1 GB and 4 GB.
		// Each round reads both packs back to back. The guard takes the lowest time of each pack over ROUNDS rounds and
		// then divides. A reader that stops at the declared size does the same work for both packs (ratio about 1); a
		// reader that unpacks the whole stream does 4 times the work for the 4 GB pack.
		let one = Infinity;
		let four = Infinity;
		for (let round = 0; round < ROUNDS; round++) {
			const a = stopRun(1, 50);
			const b = stopRun(4, 50);
			expect(a.error).toBe(STOP_MESSAGE);
			expect(b.error).toBe(STOP_MESSAGE);
			one = Math.min(one, a.ms);
			four = Math.min(four, b.ms);
		}
		expect(four / one, `${four.toFixed(1)} ms for 4 GB, ${one.toFixed(1)} ms for 1 GB`).toBeLessThan(2);
	}, budget(120_000));
});
