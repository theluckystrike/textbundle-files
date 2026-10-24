// Patch 1.0.2: auto import retries a read error once after 2 s, but a refused pack leaves the queue at once.
// A refused pack (bad zip, bomb, unsafe path) gives the same result after 2 s, so a retry only holds the queue.
// A refused pack may still be syncing: it gets one more auto import on a 'modify' event with a new size.
// Its Notice shows only after that second try fails, or after 60 s with no such event.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { App } from 'obsidian-test-mocks/obsidian';

const state = vi.hoisted(() => ({ scans: 0, writes: 0, mode: 'refused' as 'refused' | 'transient' | 'syncing' | 'unsafe' | 'kind', kind: 'not-zip' as import('../src/bundle').PackErrorKind, message: '', notices: [] as string[] }));

vi.mock('obsidian', async (original) => {
	const real = await original<typeof import('obsidian')>();
	class Notice extends real.Notice {
		constructor(message: string | DocumentFragment, duration?: number) {
			super(message, duration);
			state.notices.push(String(message));
		}
	}
	return { ...real, Notice };
});

vi.mock('../src/writer', async (original) => {
	const real = await original<typeof import('../src/writer')>();
	const { PackError, readPack } = await import('../src/bundle');
	return {
		...real,
		readVaultPack: vi.fn(async (_app: unknown, file: { name: string; stat: { size: number } }) => {
			state.scans++;
			// Real scans: bytes that are not a zip give a PackError from readPack.
			if (state.mode === 'refused') return readPack(file.name, strToU8('this is not a zip file'));
			// A complete zip with an entry path outside the bundle: refused for a reason that a sync cannot change.
			if (state.mode === 'unsafe') return readPack(file.name, zipSync({ 'text.md': strToU8('Note\n'), '../evil.md': strToU8('x') }));
			// A pack that a sync still writes: only the first stat.size bytes of the full zip are there.
			if (state.mode === 'syncing') return readPack(file.name, FULL.subarray(0, file.stat.size));
			// 1.0.3: a PackError with a set kind and a set message text.
			if (state.mode === 'kind') throw new PackError(state.kind, state.message);
			if (state.scans === 1) throw new Error('EBUSY: the file is still open');
			return readPack(file.name, zipSync({ 'text.md': strToU8(`Note ${file.name}\n`) }));
		}),
		writeBundle: vi.fn(async (_app: unknown, _bundle: unknown, source: string) => {
			state.writes++;
			return { source, notePath: `${source}.md`, assets: 0, rewritten: 0, missing: 0, warnings: [] };
		}),
	};
});

const FULL = zipSync({ 'text.md': strToU8('Synced note\n') });
const { default: TextbundleFilesPlugin } = await import('../src/main');
const { PackError } = await import('../src/bundle');
const manifest = (await import('../manifest.json')).default;

/** Two stable size checks of 500 ms each come before the queue reads the pack. */
const STABLE_WAIT = 1000;
const RETRY_MS = 2000;
const REFUSED_WAIT_MS = 60_000;
const STABLE_MS_HALF = 250;

async function start(path: string, content = 'pack bytes') {
	const app = App.createConfigured__({ files: { [path]: content } });
	const plugin = new TextbundleFilesPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	plugin.settings.autoImport = true;
	const run = { done: false, result: undefined as unknown, plugin, file: app.vault.getFileByPath(path)! };
	void plugin.autoImport(path).then((result) => {
		run.done = true;
		run.result = result;
	});
	return run;
}

describe('auto import retry (1.0.2)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		state.scans = 0;
		state.writes = 0;
		state.notices = [];
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('scans a refused pack once and does not wait 2 s', async () => {
		state.mode = 'refused';
		const run = await start('Synced/broken.textpack');
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(run.done).toBe(true);
		expect(run.result).toBeNull();
		expect(state.scans).toBe(1);
		// No 2 s retry timer: only the 60 s Notice timer is left, and no second scan comes later.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
		expect(state.scans).toBe(1);
		expect(state.notices).toEqual([]);
	});

	it('shows 1 Notice after 60 s for a bad pack that never changes, with 1 scan', async () => {
		state.mode = 'refused';
		const run = await start('Synced/broken.textpack');
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(run.done).toBe(true);
		// A 'modify' event with the same size does not start a second try.
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS - 1000);
		expect(state.notices).toEqual([]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(state.notices).toHaveLength(1);
		expect(state.notices[0]).toMatch(/^Synced\/broken\.textpack was not imported\. .*not a TextPack/);
		expect(state.scans).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.notices).toHaveLength(1);
	});

	it('imports a truncated pack once on the modify event that completes it, with no failure Notice', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/syncing.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(run.done).toBe(true);
		expect(run.result).toBeNull();
		expect(state.scans).toBe(1);
		expect(state.notices).toEqual([]);
		// The sync writes the rest of the pack, and the vault sends 'modify'.
		run.file.stat.size = FULL.length;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.scans).toBe(2);
		expect(state.writes).toBe(1);
		expect(state.notices).toEqual(['Imported Synced/syncing.textpack.md with 0 attachments.']);
		// The 60 s timer is gone: no failure Notice comes later, and a later 'modify' does not import again.
		expect(vi.getTimerCount()).toBe(0);
		run.file.stat.size = FULL.length + 1;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.writes).toBe(1);
		expect(state.notices.filter((n) => n.includes('was not imported'))).toEqual([]);
	});

	it('shows the Notice at once when the second try after a modify event also fails', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/stalled.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		run.file.stat.size = 80;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.scans).toBe(2);
		expect(state.writes).toBe(0);
		expect(state.notices).toHaveLength(1);
		expect(state.notices[0]).toMatch(/was not imported/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears a refused pack on unload, so no Notice and no import come later', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/unload.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(vi.getTimerCount()).toBe(1);
		run.plugin.onunload();
		expect(vi.getTimerCount()).toBe(0);
		run.file.stat.size = FULL.length;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.scans).toBe(1);
		expect(state.writes).toBe(0);
		expect(state.notices).toEqual([]);
	});

	it('shows the Notice at once for a refused pack that is a complete zip (unsafe path), with no 60 s wait', async () => {
		state.mode = 'unsafe';
		const run = await start('Synced/evil.textpack');
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(run.done).toBe(true);
		expect(state.scans).toBe(1);
		expect(state.notices).toHaveLength(1);
		expect(state.notices[0]).toMatch(/^Synced\/evil\.textpack was not imported\. Refused the pack: .*outside the bundle/);
		expect(vi.getTimerCount()).toBe(0);
		// No pending entry: a later 'modify' with a new size does not scan again.
		run.file.stat.size += 100;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.scans).toBe(1);
		expect(state.notices).toHaveLength(1);
	});

	it('does not import a refused pack on modify after the user turns auto import off', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/off.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		run.plugin.settings.autoImport = false;
		run.file.stat.size = FULL.length;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.scans).toBe(1);
		expect(state.writes).toBe(0);
	});

	it('sets no timer and shows no Notice when an auto import in flight ends after unload', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/late.textpack', 'x'.repeat(40));
		// Unload during the stable-size wait, before the refusal.
		await vi.advanceTimersByTimeAsync(STABLE_MS_HALF);
		run.plugin.onunload();
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(run.done).toBe(true);
		expect(state.scans).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.notices).toEqual([]);
	});

	it('clears a refused pack on delete or rename', async () => {
		state.mode = 'syncing';
		const run = await start('Synced/moved.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		run.plugin.forgetRefused('Synced/moved.textpack');
		expect(vi.getTimerCount()).toBe(0);
		run.file.stat.size = FULL.length;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(REFUSED_WAIT_MS * 2);
		expect(state.scans).toBe(1);
		expect(state.notices).toEqual([]);
	});

	it('the refused pack error is a PackError', async () => {
		const { readPack } = await import('../src/bundle');
		expect(() => readPack('x.textpack', strToU8('this is not a zip file'))).toThrow(PackError);
	});

	it('retries a read error once after 2 s', async () => {
		state.mode = 'transient';
		const run = await start('Synced/syncing.textpack');
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.scans).toBe(1);
		expect(run.done).toBe(false);
		await vi.advanceTimersByTimeAsync(RETRY_MS - 200);
		expect(state.scans).toBe(1);
		expect(run.done).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		expect(state.scans).toBe(2);
		expect(run.done).toBe(true);
		expect(run.result).toMatchObject({ notePath: 'Synced/syncing.textpack.md' });
	});
	// 1.0.3: the retry decision uses the PackError kind, not the message text.
	const KINDS = ['not-zip', 'limit', 'unsafe-path', 'duplicate', 'unsupported', 'bomb', 'corrupt', 'no-text', 'write-failed'] as const;

	it('arms the 60 s wait only for the not-zip kind', async () => {
		state.mode = 'kind';
		for (const kind of KINDS) {
			state.kind = kind;
			state.message = `Synced/${kind}.textpack is not a TextPack (zip) file.`;
			state.notices = [];
			const run = await start(`Synced/${kind}.textpack`);
			await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
			expect(run.done).toBe(true);
			if (kind === 'not-zip') {
				// Armed: no Notice yet, one 60 s timer, and a modify with a new size gives one more scan.
				expect(state.notices).toEqual([]);
				expect(vi.getTimerCount()).toBe(1);
				run.plugin.onunload();
			} else {
				expect(state.notices).toEqual([`Synced/${kind}.textpack was not imported. Synced/${kind}.textpack is not a TextPack (zip) file.`]);
				expect(vi.getTimerCount()).toBe(0);
			}
		}
	});

	it('the retry decision does not depend on the message text', async () => {
		state.mode = 'kind';
		// A not-zip refusal with a changed message text still waits 60 s and retries on modify.
		state.kind = 'not-zip';
		state.message = 'A new text for a pack with no zip end record.';
		const run = await start('Synced/new-text.textpack', 'x'.repeat(40));
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.notices).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);
		state.mode = 'syncing';
		run.file.stat.size = FULL.length;
		run.plugin.onModify(run.file);
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.scans).toBe(2);
		expect(state.writes).toBe(1);
		expect(state.notices).toEqual(['Imported Synced/new-text.textpack.md with 0 attachments.']);
		// The old not-zip text on another kind does not arm the wait.
		state.mode = 'kind';
		state.kind = 'corrupt';
		state.message = 'Synced/old-text.textpack is not a TextPack (zip) file.';
		state.notices = [];
		await start('Synced/old-text.textpack');
		await vi.advanceTimersByTimeAsync(STABLE_WAIT + 100);
		expect(state.notices).toEqual(['Synced/old-text.textpack was not imported. Synced/old-text.textpack is not a TextPack (zip) file.']);
		expect(vi.getTimerCount()).toBe(0);
	});
});
