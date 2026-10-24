import { FuzzySuggestModal, Notice, Plugin, TFile, TFolder, normalizePath, type App, type TAbstractFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, TextbundleFilesSettingTab, keepInfoActive, normalizeSettings, type TextbundleFilesSettings } from './settings';
import { PackError, exportedByPlugin, readPack, uniquePath, type Bundle } from './bundle';
import { count, exportNote, importSummary, notesIn, packsIn, readVaultBundle, readVaultPack, reportText, writeBundle, type ExportResult, type ImportResult } from './writer';
import { ImportModal } from './modal';

/** Auto import: wait this long between size checks, and retry a failed read once after RETRY_MS. */
const STABLE_MS = 500;
const STABLE_TRIES = 20;
const RETRY_MS = 2000;
/** A refused auto import waits this long for a 'modify' event (a sync still writes the pack) before it shows its Notice. */
const REFUSED_WAIT_MS = 60_000;
/** How many written pack paths the settings keep. */
const WRITTEN_KEEP = 500;
/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
// The format names TextBundle and TextPack and the tier name Pro keep their case in these UI labels.
const UI = {
	importCommand: 'Import TextBundle or TextPack files',
	exportCommand: 'Export current note as TextPack',
	exportFolderCommand: 'Export every note in a folder as TextPacks',
	importPack: 'Import TextPack as note',
	importBundle: 'Import TextBundle as note',
	exportNote: 'Export as TextPack',
	importFolder: 'Import packs in this folder (Pro)',
	exportFolder: 'Export notes as TextPacks (Pro)',
};
export const PRO_NEEDED = 'Folder import and folder export need Pro. Sign in with GitHub in the plugin settings.';

export interface FolderReport {
	reportPath: string;
	done: number;
	failed: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/**
 * True for a pack refused with the kind 'not-zip' (no zip end record, or a bad zip directory).
 * A writer adds the end record last, so the pack may still be incomplete. The check uses the kind, not the message text.
 */
export const incomplete = (error: unknown) => error instanceof PackError && error.kind === 'not-zip';

export default class TextbundleFilesPlugin extends Plugin {
	settings: TextbundleFilesSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	modal: ImportModal | null = null;
	/** Packs that this plugin writes on this device (exports, and .textpack assets of an import). Auto import skips them. */
	private own = new Set<string>();
	/** Auto imports that wait for a stable file size. */
	private waiting = new Set<string>();
	/** Auto imports refused with a PackError: the file size at the refusal and the 60 s Notice timer. */
	private refused = new Map<string, { size: number; timer: number }>();
	/** Set in onunload, so an auto import that ends after unload sets no timer. */
	private unloaded = false;
	/** One write at a time, so two imports never pick the same free name. */
	private queue: Promise<unknown> = Promise.resolve();

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		const tab = new TextbundleFilesSettingTab(this.app, this);
		this.addSettingTab(tab);
		this.register(pro.onChange(() => tab.update()));

		this.addCommand({ id: 'import', name: UI.importCommand, callback: () => this.openImport() });
		this.addCommand({
			id: 'export-note',
			name: UI.exportCommand,
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) void this.exportWithNotice(file);
				return true;
			},
		});
		this.addCommand({ id: 'import-folder', name: 'Import every pack in a folder', callback: () => this.pickFolder((folder) => void this.folderWithNotice(() => this.importFolder(folder))) });
		this.addCommand({ id: 'export-folder', name: UI.exportFolderCommand, callback: () => this.pickFolder((folder) => void this.folderWithNotice(() => this.exportFolder(folder))) });

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && /^(textpack|zip)$/i.test(file.extension)) {
					menu.addItem((item) => item.setTitle(UI.importPack).setIcon('package-open').onClick(() => void this.importWithNotice(file)));
				} else if (file instanceof TFolder && /\.textbundle$/i.test(file.name)) {
					menu.addItem((item) => item.setTitle(UI.importBundle).setIcon('package-open').onClick(() => void this.importWithNotice(file)));
				} else if (file instanceof TFile && file.extension === 'md') {
					menu.addItem((item) => item.setTitle(UI.exportNote).setIcon('package').onClick(() => void this.exportWithNotice(file)));
				} else if (file instanceof TFolder) {
					menu.addItem((item) => item.setTitle(UI.importFolder).setIcon('package-open').onClick(() => void this.folderWithNotice(() => this.importFolder(file))));
					menu.addItem((item) => item.setTitle(UI.exportFolder).setIcon('package').onClick(() => void this.folderWithNotice(() => this.exportFolder(file))));
				}
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			// After layout ready, so the files that exist at start do not import.
			this.registerEvent(this.app.vault.on('create', (file) => this.onCreate(file)));
			this.registerEvent(this.app.vault.on('modify', (file) => this.onModify(file)));
			this.registerEvent(this.app.vault.on('delete', (file) => this.forgetRefused(file.path)));
			this.registerEvent(this.app.vault.on('rename', (_file, oldPath) => this.forgetRefused(oldPath)));
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
		});
	}

	onunload(): void {
		this.unloaded = true;
		for (const path of [...this.refused.keys()]) this.forgetRefused(path);
		this.modal?.close();
		resetPro();
	}

	openImport(): ImportModal {
		this.modal?.close();
		this.modal = new ImportModal(this);
		this.modal.open();
		return this.modal;
	}

	private serial<T>(job: () => Promise<T>): Promise<T> {
		const run = this.queue.then(job, job);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Folder for new notes: "Default location for new notes" of the vault. */
	defaultFolder(): string {
		return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '', 'note.md').path;
	}

	/** Imports a bundle as a note with its assets. Free. */
	importBundle(bundle: Bundle, source: string, folder?: string): Promise<ImportResult> {
		return this.serial(() => writeBundle(this.app, bundle, source, folder ?? this.defaultFolder(), keepInfoActive(this.settings, isPro()), (path) => this.remember(path)));
	}

	/** Imports .textpack bytes. Free. */
	importPack(name: string, bytes: Uint8Array, folder?: string): Promise<ImportResult> {
		return this.importBundle(readPack(name, bytes), name, folder);
	}

	/** Imports a .textpack file or .textbundle folder of the vault next to it. Free. */
	async importVaultItem(item: TFile | TFolder): Promise<ImportResult> {
		const bundle = item instanceof TFile ? await readVaultPack(this.app, item) : await readVaultBundle(this.app, item);
		return this.importBundle(bundle, item.path, item.parent?.path ?? '');
	}

	/** Exports a note as a .textpack next to it. Free. */
	exportFile(file: TFile, folder?: string): Promise<ExportResult> {
		return this.serial(() => exportNote(this.app, file, keepInfoActive(this.settings, isPro()), folder, (path) => this.remember(path)));
	}

	/** Pro: imports each pack and bundle in the folder and writes a report note. */
	async importFolder(folder: TFolder): Promise<FolderReport> {
		// Check the cached Sponsors state at the write boundary.
		if (!isPro()) throw new Error(PRO_NEEDED);
		const lines: string[] = [];
		let done = 0;
		let failed = 0;
		for (const item of packsIn(folder)) {
			try {
				const result = await this.importVaultItem(item);
				done++;
				lines.push(`${item.name}: [[${result.notePath}]], ${importSummary(result)}.${result.warnings.length ? ` ${result.warnings.join(' ')}` : ''}`);
			} catch (error) {
				failed++;
				lines.push(`${item.name}: not imported. ${message(error)}`);
			}
		}
		if (!lines.length) lines.push('No .textpack files or .textbundle folders in this folder.');
		const reportPath = await this.writeReport(folder, 'TextBundle import report', `Imported ${done}, failed ${failed}.`, lines);
		return { reportPath, done, failed };
	}

	/** Pro: exports each note of the folder and its subfolders into a new TextPacks folder. */
	async exportFolder(folder: TFolder): Promise<FolderReport> {
		if (!isPro()) throw new Error(PRO_NEEDED);
		const notes = notesIn(folder);
		const taken = (path: string) => this.app.vault.getAbstractFileByPath(path) !== null;
		const out = uniquePath(normalizePath(folder.isRoot() ? 'TextPacks' : `${folder.path}/TextPacks`), taken);
		await this.app.vault.createFolder(out);
		const lines: string[] = [];
		let done = 0;
		let failed = 0;
		for (const note of notes) {
			try {
				const result = await this.exportFile(note, out);
				done++;
				lines.push(`${note.path}: ${result.packPath}, ${count(result.assets, 'attachment')}.`);
			} catch (error) {
				failed++;
				lines.push(`${note.path}: not exported. ${message(error)}`);
			}
		}
		if (!lines.length) lines.push('No notes in this folder.');
		const target = this.app.vault.getFolderByPath(out) ?? folder;
		const reportPath = await this.writeReport(target, 'TextPack export report', `Exported ${done}, failed ${failed}.`, lines);
		return { reportPath, done, failed };
	}

	private async writeReport(folder: TFolder, title: string, summary: string, lines: string[]): Promise<string> {
		const taken = (path: string) => this.app.vault.getAbstractFileByPath(path) !== null;
		const path = uniquePath(normalizePath(folder.isRoot() ? `${title}.md` : `${folder.path}/${title}.md`), taken);
		await this.app.vault.create(path, `${reportText(lines)}\n${summary}\n`);
		return path;
	}

	/**
	 * Marks a path that the plugin writes. A .textpack path also goes into the saved settings,
	 * so a device that syncs the plugin settings skips it too.
	 */
	private remember(path: string): void {
		this.own.add(path);
		if (!/\.textpack$/i.test(path)) return;
		this.settings.written = [...this.settings.written.filter((p) => p !== path), path].slice(-WRITTEN_KEEP);
		void this.saveSettings();
	}

	private onCreate(file: TAbstractFile): void {
		if (!this.settings.autoImport || !(file instanceof TFile) || file.extension.toLowerCase() !== 'textpack') return;
		if (this.own.delete(file.path) || this.waiting.has(file.path)) return;
		if (this.settings.written.includes(file.path)) {
			new Notice(`Skipped ${file.path}: TextBundle Files wrote a pack at this path. To import it, use "${UI.importPack}" in its file menu.`);
			return;
		}
		void this.autoImport(file.path);
	}

	/** A refused pack that changes size (a sync still writes it) gets one more auto import. */
	onModify(file: TAbstractFile): void {
		if (!this.settings.autoImport) return;
		const entry = this.refused.get(file.path);
		if (!entry || !(file instanceof TFile) || file.stat.size === entry.size) return;
		this.forgetRefused(file.path);
		void this.autoImport(file.path, true);
	}

	/** Drops a refused pack and its Notice timer (on success, delete, rename and unload). */
	forgetRefused(path: string): void {
		const entry = this.refused.get(path);
		if (!entry) return;
		window.clearTimeout(entry.timer);
		this.refused.delete(path);
	}

	/**
	 * Waits until a copy or a sync client has written the whole pack, then imports it. One retry after a read error.
	 * A pack refused on the first try waits for one 'modify' event with a new size; its Notice shows after the second try fails or after 60 s.
	 */
	async autoImport(path: string, again = false): Promise<ImportResult | null> {
		this.waiting.add(path);
		const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
		try {
			let size = -1;
			for (let i = 0; i < STABLE_TRIES; i++) {
				await wait(STABLE_MS);
				const file = this.app.vault.getFileByPath(path);
				if (!file) return null;
				if (file.stat.size === size && size > 0) break;
				size = file.stat.size;
			}
			const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			// One auto import at a time: the read, the unpack and the write run in the queue,
			// so a sync that adds many large packs never holds their bundles in memory together.
			const result = await this.serial(async (): Promise<ImportResult | null> => {
				const read = async () => {
					const file = this.app.vault.getFileByPath(path);
					if (!file) throw new Error('The pack is gone.');
					return readVaultPack(this.app, file);
				};
				let bundle: Bundle;
				try {
					bundle = await read();
				} catch (error) {
					// A refused pack (bad zip, bomb, unsafe path) gives the same result in 2 s. Only a read error is retried.
					if (error instanceof PackError) throw error;
					await wait(RETRY_MS);
					bundle = await read();
				}
				// A pack that this plugin exported (on any device) does not come back as a note.
				if (exportedByPlugin(bundle.info, bundle.text)) {
					new Notice(`Skipped ${path}: TextBundle Files exported this pack, and its text did not change. To import it, use "${UI.importPack}" in its file menu.`);
					return null;
				}
				return writeBundle(this.app, bundle, path, folder, keepInfoActive(this.settings, isPro()), (written) => this.remember(written));
			});
			this.forgetRefused(path);
			if (!result) return null;
			new Notice(`Imported ${result.notePath} with ${count(result.assets, 'attachment')}.`);
			return result;
		} catch (error) {
			const file = this.app.vault.getFileByPath(path);
			if (this.unloaded) return null;
			// Only the kind 'not-zip' (no zip end record) can mean a pack that a writer has not finished.
			// Every other refusal (bomb, unsafe path, limit, no text file) shows its Notice at once.
			if (incomplete(error) && !again && file) {
				// The pack may still be syncing. Wait for its next 'modify' event, and show the Notice only if none comes in 60 s.
				this.forgetRefused(path);
				const timer = window.setTimeout(() => {
					this.refused.delete(path);
					new Notice(`${path} was not imported. ${message(error)}`);
				}, REFUSED_WAIT_MS);
				this.refused.set(path, { size: file.stat.size, timer });
				return null;
			}
			new Notice(`${path} was not imported. ${message(error)}`);
			return null;
		} finally {
			this.waiting.delete(path);
		}
	}

	async importWithNotice(item: TFile | TFolder): Promise<void> {
		try {
			const result = await this.importVaultItem(item);
			new Notice(`Imported ${result.notePath} with ${count(result.assets, 'attachment')}.`);
		} catch (error) {
			new Notice(`${item.name} was not imported. ${message(error)}`);
		}
	}

	async exportWithNotice(file: TFile): Promise<void> {
		try {
			const result = await this.exportFile(file);
			new Notice(`Exported ${result.packPath} with ${count(result.assets, 'attachment')}.`);
		} catch (error) {
			new Notice(`${file.name} was not exported. ${message(error)}`);
		}
	}

	async folderWithNotice(job: () => Promise<FolderReport>): Promise<void> {
		try {
			const report = await job();
			new Notice(`Done: ${report.done}, failed: ${report.failed}. See ${report.reportPath}.`);
			const file = this.app.vault.getFileByPath(report.reportPath);
			if (file) await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(message(error));
		}
	}

	private pickFolder(onPick: (folder: TFolder) => void): void {
		if (!isPro()) {
			new Notice(PRO_NEEDED);
			return;
		}
		new FolderPicker(this.app, onPick).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<TextbundleFilesSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onPick: (folder: TFolder) => void) {
		super(app);
		this.setPlaceholder('Select a folder');
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllFolders(true);
	}
	getItemText(folder: TFolder): string {
		return folder.isRoot() ? '/' : folder.path;
	}
	onChooseItem(folder: TFolder): void {
		this.onPick(folder);
	}
}
