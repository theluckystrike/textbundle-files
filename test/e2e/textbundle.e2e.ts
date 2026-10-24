import { browser, expect } from '@wdio/globals';
import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

interface Row { source: string; result?: { notePath: string; assets: number; rewritten: number; missing: number; warnings: string[] }; error?: string }
interface TestModal { selectFiles(files: File[]): Promise<Row[]>; selectPicked(picked: Array<{ path: string; file: Blob }>): Promise<Row[]>; close(): void }
interface TestPlugin {
	settings: { autoImport: boolean; keepInfo: boolean };
	openImport(): TestModal;
	importPack(name: string, bytes: Uint8Array, folder?: string): Promise<NonNullable<Row['result']>>;
	exportFile(file: unknown, folder?: string): Promise<{ packPath: string; assets: number }>;
	importFolder(folder: unknown): Promise<{ reportPath: string; done: number; failed: number }>;
	exportFolder(folder: unknown): Promise<{ reportPath: string; done: number; failed: number }>;
	pro: { signOut(): void; refreshNow(): Promise<unknown>; opts: { http: (req: unknown) => Promise<unknown> } };
}

const PACKS = 'docs/sample-notes/Packs';
const lisbon = readFileSync(`${PACKS}/Lisbon trip.textpack`).toString('base64');
const escape = readFileSync(`${PACKS}/Escape.textpack`).toString('base64');
const screenplay = readFileSync(`${PACKS}/Screenplay.textpack`).toString('base64');
const draftText = readFileSync(`${PACKS}/Draft.textbundle/text.md`, 'utf8');
const sketch = readFileSync(`${PACKS}/Draft.textbundle/assets/img/sketch.png`).toString('base64');
const garden = readFileSync('docs/sample-notes/Attachments/garden.png').toString('base64');
const lisbonFiles = unzipSync(readFileSync(`${PACKS}/Lisbon trip.textpack`));
const lisbonText = strFromU8(lisbonFiles['Lisbon trip.textbundle/text.markdown']!);
// Packs with asset names that no other test uses, so no suffix changes the round trip.
const roundText = '# Round\n\n![](assets/r%C3%B6und%20a.png)\n![](<assets/round b.jpg>)\n[pdf](assets/round.pdf "t")\n<img src="assets/round c.png">\n';
const round = Buffer.from(zipSync({ 'Round.textbundle/info.json': strToU8('{"version":2}'), 'Round.textbundle/text.markdown': strToU8(roundText), 'Round.textbundle/assets/röund a.png': strToU8('A'), 'Round.textbundle/assets/round b.jpg': strToU8('B'), 'Round.textbundle/assets/round.pdf': strToU8('P'), 'Round.textbundle/assets/round c.png': strToU8('C') })).toString('base64');
const portoText = '# Porto\n\n![Tile](assets/porto%20tile.png)\n';
const portoInfo = { version: 2, type: 'net.daringfireball.markdown', creatorIdentifier: 'com.ulyssesapp.mac', 'com.ulyssesapp.mac': { version: 3, sheet: 'S1' } };
const porto = Buffer.from(zipSync({ 'info.json': strToU8(JSON.stringify(portoInfo)), 'text.md': strToU8(portoText), 'assets/porto tile.png': strToU8('T') })).toString('base64');
const keyed = Buffer.from(zipSync({ 'text.md': strToU8('---\ntextbundle: old\n---\nBody\n'), 'info.json': strToU8('{"version":2}') })).toString('base64');
const outer = Buffer.from(zipSync({ 'text.md': strToU8('Outer ![](assets/inner.textpack)\n'), 'assets/inner.textpack': zipSync({ 'text.md': strToU8('Inner\n') }) })).toString('base64');
const badYaml = Buffer.from(zipSync({ 'text.md': strToU8('---\nkey: [unclosed\n---\nBody\n'), 'info.json': strToU8('{"version":2}') })).toString('base64');
// A pack that this plugin exported (mark in info.json), then another app changed its text.
const edited = Buffer.from(zipSync({ 'Edited.textbundle/text.markdown': strToU8('Changed in Bear\n'), 'Edited.textbundle/info.json': strToU8(JSON.stringify({ version: 2, 'md.obsidian.textbundle-files': { version: 1, text: '00000000' } })) })).toString('base64');
/** info.json without the export mark, after a check that the mark is there. */
function unmarked(info: Record<string, unknown>): Record<string, unknown> {
	const { 'md.obsidian.textbundle-files': mark, ...rest } = info;
	expect(mark).toMatchObject({ version: 1, text: expect.stringMatching(/^[0-9a-f]{8}$/) });
	return rest;
}
const many: Record<string, Uint8Array> = { 'text.markdown': strToU8('x') };
for (let i = 0; i < 5001; i++) many[`assets/${i}.txt`] = new Uint8Array(0);
const tooMany = Buffer.from(zipSync(many, { level: 0 })).toString('base64');

/** Reads a vault file as base64 in the app. */
async function vaultBase64(path: string): Promise<string> {
	return browser.executeObsidian(async ({ app }, p) => {
		const bytes = new Uint8Array(await app.vault.adapter.readBinary(p));
		let s = '';
		for (const b of bytes) s += String.fromCharCode(b);
		return btoa(s);
	}, path);
}

describe('TextBundle Files in a vault', () => {
	it('imports a TextPack from the file picker with its assets and rewritten links', async () => {
		await browser.executeObsidianCommand('textbundle-files:import');
		await browser.waitUntil(async () => (await browser.$('.textbundle-files-drop').isExisting()));
		const state = await browser.executeObsidian(async ({ app, obsidian }, base64) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			plugin.pro.signOut();
			const modal = plugin.openImport();
			const rows = await modal.selectFiles([new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'Lisbon trip.textpack')]);
			const list = document.querySelector('.textbundle-files-results')?.textContent;
			modal.close();
			const note = app.vault.getAbstractFileByPath('Lisbon trip.md');
			if (!(note instanceof obsidian.TFile)) throw new Error('note missing');
			const text = await app.vault.read(note);
			const targets = [...text.matchAll(/\]\((<[^>]+>|[^)\s]+)/g)].map((m) => decodeURIComponent(m[1]!.replace(/^<|>$/g, '')));
			const resolved = targets.map((t) => app.metadataCache.getFirstLinkpathDest(t, note.path)?.path ?? null);
			return { rows, list, text, resolved };
		}, lisbon);
		expect(state.rows[0]!.result).toMatchObject({ notePath: 'Lisbon trip.md', assets: 3, rewritten: 3, missing: 0, warnings: [] });
		expect(state.list).toContain('Lisbon trip.md, 3 attachments, 3 links changed');
		expect(state.text).toBe(lisbonText.replace('assets/tram%2028.png', 'tram%2028.png').replace('<assets/café menu.png>', '<café menu.png>').replace('assets/tickets.pdf', 'tickets.pdf'));
		expect(state.text).toContain('![Tram 28](tram%2028.png)');
		expect(state.text).toContain('![](<café menu.png>)');
		expect(state.text).toContain('[the PDF](tickets.pdf)');
		expect(state.resolved).toEqual(['tram 28.png', 'café menu.png', 'tickets.pdf']);
	});

	it('never overwrites: a second import of the same pack gets suffixes and the first files keep their bytes', async () => {
		const before = await vaultBase64('tram 28.png');
		const state = await browser.executeObsidian(async ({ app }, base64) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			// Two imports at the same time must not pick the same free name.
			const [a, b] = await Promise.all([plugin.importPack('Lisbon trip.textpack', bytes), plugin.importPack('Lisbon trip.textpack', bytes)]);
			const text = await app.vault.adapter.read(a.notePath);
			return { a: a.notePath, b: b.notePath, text, exists: ['tram 28 1.png', 'tram 28 2.png', 'café menu 1.png', 'tickets 2.pdf'].map((p) => app.vault.getAbstractFileByPath(p) !== null) };
		}, lisbon);
		expect([state.a, state.b].sort()).toEqual(['Lisbon trip 1.md', 'Lisbon trip 2.md']);
		expect(state.exists).toEqual([true, true, true, true]);
		expect(state.text).toMatch(/!\[Tram 28\]\(tram%2028%20[12]\.png\)/);
		expect(await vaultBase64('tram 28.png')).toBe(before);
	});

	it('refuses a pack with a ../ path and writes nothing for it', async () => {
		const state = await browser.executeObsidian(async ({ app }, base64) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			const count = app.vault.getAllLoadedFiles().length;
			const modal = plugin.openImport();
			const rows = await modal.selectFiles([new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'Escape.textpack')]);
			const alert = document.querySelector('.textbundle-files-error')?.textContent;
			modal.close();
			return { rows, alert, same: app.vault.getAllLoadedFiles().length === count, note: app.vault.getAbstractFileByPath('Escape.md') !== null };
		}, escape);
		expect(state.rows[0]!.error).toBe('Refused the pack: the path "../escape.md" points outside the bundle.');
		expect(state.alert).toContain('points outside the bundle');
		expect(state).toMatchObject({ same: true, note: false });
	});

	it('refuses a pack over the file limit with a clear message', async () => {
		const error = await browser.executeObsidian(async ({ app }, base64) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			try {
				await plugin.importPack('Big.textpack', Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
				return 'imported';
			} catch (e) {
				return (e as Error).message;
			}
		}, tooMany);
		expect(error).toBe('The pack has 5002 entries. The limit is 5000 entries.');
	});

	it('imports a Fountain pack without link changes and a .textbundle folder without info.json', async () => {
		const state = await browser.executeObsidian(async ({ app }, base64, draft, png) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			const modal = plugin.openImport();
			const rows = await modal.selectPicked([
				{ path: 'Screenplay.textpack', file: new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))]) },
				{ path: 'Export/Draft.textbundle/text.md', file: new Blob([draft]) },
				{ path: 'Export/Draft.textbundle/assets/img/sketch.png', file: new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))]) },
			]);
			modal.close();
			return { rows, draft: await app.vault.adapter.read('Draft.md'), play: await app.vault.adapter.read('Screenplay.md') };
		}, screenplay, draftText, sketch);
		expect(state.rows[0]!.result!.warnings).toEqual(['The text type is com.quote-unquote.fountain. Imported the text without link changes.']);
		expect(state.play).toBe('INT. TRAM - DAY\n\nA conductor rings the bell.\n');
		expect(state.rows[1]!.result).toMatchObject({ notePath: 'Draft.md', assets: 1, rewritten: 1, warnings: ['No info.json. Used the Markdown type.'] });
		expect(state.draft).toContain('![sketch](sketch.png)');
	});

	it('exports the current note as a TextPack with a valid info.json and its attachments', async () => {
		const packPath = await browser.executeObsidian(async ({ app, obsidian }, png) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			await app.vault.createFolder('Garden');
			await app.vault.createBinary('Garden/garden.png', Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
			await app.vault.create('Garden/seed list.pdf', '%PDF-1.4\n');
			const note = await app.vault.create('Garden/Garden plan.md', '# Garden plan\n\n![[garden.png]]\n\nOrder: [[seed list.pdf|seed order]]. See [[Lisbon trip]].\n');
			await app.workspace.getLeaf(false).openFile(note);
			(app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById('textbundle-files:export-note');
			for (let i = 0; i < 50 && !app.vault.getAbstractFileByPath('Garden/Garden plan.textpack'); i++) await new Promise((r) => setTimeout(r, 100));
			const pack = app.vault.getAbstractFileByPath('Garden/Garden plan.textpack');
			if (!(pack instanceof obsidian.TFile)) throw new Error('pack missing');
			return pack.path;
		}, garden);
		const files = unzipSync(Buffer.from(await vaultBase64(packPath), 'base64'));
		const info = JSON.parse(strFromU8(files['Garden plan.textbundle/info.json']!)) as Record<string, unknown>;
		expect(unmarked(info)).toEqual({ version: 2, type: 'net.daringfireball.markdown', transient: false, creatorIdentifier: 'md.obsidian' });
		expect(strFromU8(files['Garden plan.textbundle/text.markdown']!)).toBe('# Garden plan\n\n![](assets/garden.png)\n\nOrder: [seed order](assets/seed%20list.pdf). See [[Lisbon trip]].\n');
		expect(Buffer.from(files['Garden plan.textbundle/assets/garden.png']!).toString('base64')).toBe(garden);
		expect(Object.keys(files).sort()).toEqual(['Garden plan.textbundle/assets/garden.png', 'Garden plan.textbundle/assets/seed list.pdf', 'Garden plan.textbundle/info.json', 'Garden plan.textbundle/text.markdown']);
	});

	it('round trip: import then export gives the same text bytes and asset names', async () => {
		const packPath = await browser.executeObsidian(async ({ app, obsidian }, base64) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			await app.vault.createFolder('Round');
			const result = await plugin.importPack('Round.textpack', Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), 'Round');
			const note = app.vault.getAbstractFileByPath(result.notePath);
			if (!(note instanceof obsidian.TFile)) throw new Error('note missing');
			// The links must resolve through the metadata cache before the export reads them.
			for (let i = 0; i < 50 && !app.metadataCache.getFileCache(note); i++) await new Promise((r) => setTimeout(r, 100));
			return (await plugin.exportFile(note, 'Round out')).packPath;
		}, round);
		const files = unzipSync(Buffer.from(await vaultBase64(packPath), 'base64'));
		expect(strFromU8(files['Round.textbundle/text.markdown']!)).toBe(roundText);
		expect(Object.keys(files).filter((k) => k.includes('/assets/')).sort()).toEqual(['Round.textbundle/assets/round b.jpg', 'Round.textbundle/assets/round c.png', 'Round.textbundle/assets/round.pdf', 'Round.textbundle/assets/röund a.png']);
		expect(strFromU8(files['Round.textbundle/assets/round b.jpg']!)).toBe('B');
	});

	it('guards folder import and folder export at the writer with Pro off', async () => {
		const state = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			plugin.pro.signOut();
			const errors: string[] = [];
			for (const job of [() => plugin.importFolder(app.vault.getRoot()), () => plugin.exportFolder(app.vault.getRoot())]) {
				try {
					await job();
				} catch (e) {
					errors.push((e as Error).message);
				}
			}
			return { errors, report: app.vault.getAbstractFileByPath('TextBundle import report.md') !== null };
		});
		expect(state.errors).toEqual(['Folder import and folder export need Pro. Sign in with GitHub in the plugin settings.', 'Folder import and folder export need Pro. Sign in with GitHub in the plugin settings.']);
		expect(state.report).toBe(false);
	});

	it('Pro imports a folder of packs with a report and keeps info.json for the round trip', async () => {
		const state = await browser.executeObsidian(async ({ app, obsidian }, packs, draft, png) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			const previousHttp = plugin.pro.opts.http;
			try {
				plugin.pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
				app.secretStorage.setSecret('textbundle-files-github-token', 'gho_' + '0'.repeat(36));
				await plugin.pro.refreshNow();
				plugin.settings.keepInfo = true;
				await app.vault.createFolder('Packs');
				for (const [name, base64] of Object.entries(packs)) await app.vault.createBinary(`Packs/${name}`, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer);
				await app.vault.createFolder('Packs/Draft.textbundle/assets/img');
				await app.vault.create('Packs/Draft.textbundle/text.md', draft);
				await app.vault.createBinary('Packs/Draft.textbundle/assets/img/sketch.png', Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer);
				const folder = app.vault.getFolderByPath('Packs');
				const report = await plugin.importFolder(folder);
				const reportText = await app.vault.adapter.read(report.reportPath);
				const note = app.vault.getAbstractFileByPath('Packs/Porto.md');
				if (!(note instanceof obsidian.TFile)) throw new Error('note missing');
				const noteText = await app.vault.read(note);
				for (let i = 0; i < 50 && !app.metadataCache.getFileCache(note); i++) await new Promise((r) => setTimeout(r, 100));
				const out = await plugin.exportFile(note, 'Pro out');
				// A property edit makes Obsidian write the front matter again as block YAML.
				await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
					fm.status = 'done';
				});
				const edited = await app.vault.read(note);
				const out2 = await plugin.exportFile(note, 'Pro out');
				const keyedText = await app.vault.adapter.read('Packs/Keyed.md');
				if ((await app.vault.adapter.read('Packs/BadYaml.md')) !== '---\nkey: [unclosed\n---\nBody\n') throw new Error('BadYaml note changed');
				return { report, reportText, noteText, edited, keyedText, packPath: out.packPath, packPath2: out2.packPath };
			} finally {
				plugin.pro.signOut();
				plugin.pro.opts.http = previousHttp;
			}
		}, { 'Lisbon trip.textpack': lisbon, 'Escape.textpack': escape, 'Screenplay.textpack': screenplay, 'Porto.textpack': porto, 'Keyed.textpack': keyed, 'BadYaml.textpack': badYaml }, draftText, sketch);
		expect(state.report).toMatchObject({ reportPath: 'Packs/TextBundle import report.md', done: 6, failed: 1 });
		expect(state.reportText).toContain('BadYaml.textpack: [[Packs/BadYaml.md]]');
		expect(state.reportText).toContain('The front matter is not valid YAML. Imported the note without the textbundle property.');
		expect(state.reportText).toContain('Keyed.textpack: [[Packs/Keyed.md]]');
		expect(state.reportText).toContain('The text has a textbundle property already. Kept it and did not add info.json.');
		expect(state.keyedText).toBe('---\ntextbundle: old\n---\nBody\n');
		expect(state.reportText).toContain('Lisbon trip.textpack: [[Packs/Lisbon trip.md]], 3 attachments, 3 links changed');
		expect(state.reportText).toContain('Escape.textpack: not imported. Refused the pack');
		expect(state.reportText).toContain('Draft.textbundle: [[Packs/Draft.md]]');
		expect(state.noteText.startsWith('---\ntextbundle:')).toBe(true);
		expect(state.noteText.endsWith('---\n# Porto\n\n![Tile](porto%20tile.png)\n')).toBe(true);
		expect(state.noteText.match(/^textbundle:/gm)).toHaveLength(1);
		expect(state.edited).toContain('status: done');
		const files = unzipSync(Buffer.from(await vaultBase64(state.packPath), 'base64'));
		expect(strFromU8(files['Porto.textbundle/text.markdown']!)).toBe(portoText);
		const info = JSON.parse(strFromU8(files['Porto.textbundle/info.json']!)) as Record<string, unknown>;
		expect(unmarked(info)).toEqual({ ...portoInfo, transient: false });
		const files2 = unzipSync(Buffer.from(await vaultBase64(state.packPath2), 'base64'));
		const text2 = strFromU8(files2['Porto.textbundle/text.markdown']!);
		expect(text2).not.toContain('textbundle');
		expect(text2).toContain('status: done');
		expect(text2.endsWith(`---\n${portoText}`)).toBe(true);
		expect(unmarked(JSON.parse(strFromU8(files2['Porto.textbundle/info.json']!)) as Record<string, unknown>)).toEqual({ ...portoInfo, transient: false });
	});

	it('auto imports a pack added to the vault, and skips its own exports, marked packs and packs inside packs', async () => {
		const state = await browser.executeObsidian(async ({ app }, base64, nested, changed) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, TestPlugin> } }).plugins.plugins['textbundle-files']!;
			const bytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).buffer;
			const until = async (check: () => boolean) => {
				for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
			};
			plugin.settings.autoImport = true;
			try {
				await app.vault.createFolder('Dropped');
				await app.vault.createBinary('Dropped/Lisbon trip.textpack', bytes(base64));
				await until(() => app.vault.getAbstractFileByPath('Dropped/Lisbon trip.md') !== null);
				const imported = app.vault.getAbstractFileByPath('Dropped/Lisbon trip.md') !== null;
				const note = app.vault.getFileByPath('Dropped/Lisbon trip.md')!;
				const out = await plugin.exportFile(note);
				// The same exported pack arrives at another path, as from sync on another device.
				const copy = await app.vault.adapter.readBinary(out.packPath);
				await app.vault.createFolder('Synced');
				await app.vault.createBinary('Synced/Lisbon trip.textpack', copy);
				await app.vault.createBinary('Synced/Edited.textpack', bytes(changed));
				await until(() => app.vault.getAbstractFileByPath('Synced/Edited.md') !== null);
				const skipText = 'Skipped Synced/Lisbon trip.textpack: TextBundle Files exported this pack';
				await until(() => [...document.querySelectorAll('.notice')].some((n) => n.textContent?.includes(skipText)));
				const skippedNotice = [...document.querySelectorAll('.notice')].some((n) => n.textContent?.includes(skipText));
				await app.vault.createFolder('Nested');
				await app.vault.createBinary('Nested/Outer.textpack', bytes(nested));
				await until(() => app.vault.getAbstractFileByPath('Nested/Outer.md') !== null);
				await new Promise((r) => setTimeout(r, 4000));
				const notes = app.vault.getMarkdownFiles().map((f) => f.path);
				return {
					imported,
					exported: out.packPath,
					loop: app.vault.getAbstractFileByPath('Dropped/Lisbon trip 1.md') !== null,
					synced: app.vault.getAbstractFileByPath('Synced/Lisbon trip.md') !== null,
					skippedNotice,
					edited: app.vault.getAbstractFileByPath('Synced/Edited.md') !== null,
					outer: app.vault.getAbstractFileByPath('Nested/Outer.md') !== null,
					innerAsset: app.vault.getAbstractFileByPath('inner.textpack') !== null,
					innerNotes: notes.filter((p) => /(^|\/)inner( \d+)?\.md$/.test(p)),
				};
			} finally {
				plugin.settings.autoImport = false;
			}
		}, lisbon, outer, edited);
		expect(state).toEqual({ imported: true, exported: 'Dropped/Lisbon trip 1.textpack', loop: false, synced: false, skippedNotice: true, edited: true, outer: true, innerAsset: true, innerNotes: [] });
	});
});
