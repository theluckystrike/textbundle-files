// Patch 1.0.1: auto import runs the read, the unpack and the write of one pack inside the serial queue.
// Ten packs that a sync adds at once must never be unpacked at the same time.
import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { App } from 'obsidian-test-mocks/obsidian';

const state = vi.hoisted(() => ({ active: 0, max: 0, unpacks: 0, writes: 0 }));

vi.mock('../src/writer', async (original) => {
	const real = await original<typeof import('../src/writer')>();
	const { readPack } = await import('../src/bundle');
	return {
		...real,
		// A real unpack of a real pack. The bundle counts as alive from the unpack until its write ends.
		readVaultPack: vi.fn(async (_app: unknown, file: { name: string }) => {
			state.active++;
			state.max = Math.max(state.max, state.active);
			state.unpacks++;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return readPack(file.name, zipSync({ 'text.md': strToU8(`Note ${file.name}\n`), 'assets/a.png': new Uint8Array(1000) }));
		}),
		writeBundle: vi.fn(async (_app: unknown, _bundle: unknown, source: string) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			state.writes++;
			state.active--;
			return { source, notePath: `${source}.md`, assets: 1, rewritten: 0, missing: 0, warnings: [] };
		}),
	};
});

const { default: TextbundleFilesPlugin } = await import('../src/main');
const manifest = (await import('../manifest.json')).default;

describe('auto import queue (1.0.1)', () => {
	it('unpacks at most 1 bundle at a time when 10 auto imports start at once', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) files[`Synced/pack${i}.textpack`] = 'pack bytes';
		const app = App.createConfigured__({ files });
		const plugin = new TextbundleFilesPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		const results = await Promise.all(Object.keys(files).map((path) => plugin.autoImport(path)));
		expect(results.filter((r) => r !== null)).toHaveLength(10);
		expect(state.unpacks).toBe(10);
		expect(state.writes).toBe(10);
		expect(state.max).toBe(1);
	}, 30_000);
});
