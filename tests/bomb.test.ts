// Review round 3, probe R3-10: a deflate stream of 1 GB or 4 GB of zeros in a 1 MB or 4 MB pack must be refused at once.
import { describe, expect, it } from 'vitest';
import { createDeflateRaw } from 'node:zlib';
import { readPack } from '../src/bundle';
import { deflatedZip } from './zipcraft';

/** Raw deflate of `gb` gigabytes of zeros, made in 1 MB steps (the zeros are never in memory at once). */
async function zeros(gb: number): Promise<Uint8Array> {
	const parts: Buffer[] = [];
	const z = createDeflateRaw({ level: 9 });
	z.on('data', (c: Buffer) => parts.push(c));
	const done = new Promise((resolve) => z.on('end', resolve));
	const chunk = Buffer.alloc(1024 * 1024);
	for (let i = 0; i < gb * 1024; i++) if (!z.write(chunk)) await new Promise((resolve) => z.once('drain', resolve));
	z.end();
	await done;
	return new Uint8Array(Buffer.concat(parts));
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

describe('CPU bombs (R3-10)', () => {
	for (const gb of [1, 4]) {
		it(`refuses ${gb} GB of zeros declared as 10 bytes in under 200 ms`, async () => {
			const packed = await zeros(gb);
			expect(packed.length).toBeLessThan(5 * 1024 * 1024);
			const r = timed(() => readPack('bomb.textpack', deflatedZip(packed, 10)));
			expect(r.error).toBe('Refused the pack: "assets/a.png" has more packed data than its declared size allows.');
			expect(r.ms).toBeLessThan(200);
		}, 120_000);
	}
	it('stops the stream at the declared size when the size fits the ratio (1 GB of zeros declared as 200 MB)', async () => {
		const packed = await zeros(1);
		const r = timed(() => readPack('bomb.textpack', deflatedZip(packed, 200 * 1024 * 1024)));
		expect(r.error).toBe('Refused the pack: "assets/a.png" unpacks to more than its declared size.');
		expect(r.ms).toBeLessThan(5000);
	}, 120_000);
});
