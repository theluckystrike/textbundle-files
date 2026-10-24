import { Modal, Platform, Setting } from 'obsidian';
import { bundleFromFiles, checkLimits, groupBundleFiles } from './bundle';
import type TextbundleFilesPlugin from './main';
import { importSummary, type ImportResult } from './writer';

/** A picked or dropped file with its path inside the picked or dropped folder. */
export interface PickedFile {
	path: string;
	file: Blob;
}

interface Row {
	source: string;
	result?: ImportResult;
	error?: string;
}

// The format names keep their case in the title.
const TITLE = 'Import TextBundle or TextPack';
const isPack = (name: string) => /\.(textpack|zip)$/i.test(name);

/** Reads all files below a dropped folder entry (Chromium and WebKit file system entries). */
async function readEntry(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ path: entry.fullPath.replace(/^\//, ''), file });
		return;
	}
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (!batch.length) break;
		for (const child of batch) await readEntry(child, out);
	}
}

export class ImportModal extends Modal {
	rows: Row[] = [];
	busy = false;
	private closed = false;

	constructor(private plugin: TextbundleFilesPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		this.closed = false;
		this.setTitle(TITLE);
		this.draw();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	/** Imports picked files: .textpack and .zip files, and files of a picked .textbundle folder. */
	async selectFiles(files: File[]): Promise<Row[]> {
		return this.selectPicked(files.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
	}

	/** Imports each pack, then each .textbundle folder in the list. One failure does not stop the others. */
	async selectPicked(picked: PickedFile[]): Promise<Row[]> {
		if (this.busy) return [];
		this.busy = true;
		const rows: Row[] = [];
		this.rows = rows;
		this.draw();
		try {
			for (const item of picked.filter((p) => !p.path.includes('/') && isPack(p.path))) {
				try {
					// Check the size before the file is read into memory.
					const limit = checkLimits(item.file.size, 0, 0);
					if (limit) throw new Error(limit);
					rows.push({ source: item.path, result: await this.plugin.importPack(item.path, new Uint8Array(await item.file.arrayBuffer())) });
				} catch (error) {
					rows.push({ source: item.path, error: error instanceof Error ? error.message : String(error) });
				}
			}
			for (const group of groupBundleFiles(picked.filter((p) => p.path.includes('/')).map((p) => p.path))) {
				const source = group.root.split('/').pop() ?? group.root;
				try {
					const byPath = new Map(picked.map((p) => [p.path, p.file]));
					const files: Record<string, Uint8Array> = {};
					const size = group.files.reduce((sum, f) => sum + (byPath.get(f.path)?.size ?? 0), 0);
					const limit = checkLimits(0, group.files.length, size);
					if (limit) throw new Error(limit);
					for (const f of group.files) files[f.rel] = new Uint8Array(await byPath.get(f.path)!.arrayBuffer());
					rows.push({ source, result: await this.plugin.importBundle(bundleFromFiles(source, files), source) });
				} catch (error) {
					rows.push({ source, error: error instanceof Error ? error.message : String(error) });
				}
			}
			if (!rows.length) rows.push({ source: 'Selection', error: 'Select .textpack files or a .textbundle folder.' });
		} finally {
			this.busy = false;
			if (!this.closed) this.draw();
		}
		return rows;
	}

	async drop(items: DataTransferItemList): Promise<Row[]> {
		const entries = Array.from(items)
			.map((item) => item.webkitGetAsEntry())
			.filter((entry): entry is FileSystemEntry => entry !== null);
		const picked: PickedFile[] = [];
		for (const entry of entries) await readEntry(entry, picked);
		return this.selectPicked(picked);
	}

	private fileInput(label: string, folder: boolean): HTMLInputElement {
		const input = this.contentEl.createEl('input', { cls: 'textbundle-files-hidden', attr: { type: 'file', 'aria-label': label } });
		if (folder) input.setAttr('webkitdirectory', '');
		else {
			input.multiple = true;
			// iOS and Android grey out unknown extensions, so the filter is for the desktop app only.
			if (Platform.isDesktopApp) input.accept = '.textpack,.zip';
		}
		input.addEventListener('change', () => {
			void this.selectFiles(Array.from(input.files ?? []));
		});
		return input;
	}

	private draw(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass('textbundle-files');
		el.createEl('p', { text: 'Each pack becomes a note in your folder for new notes. Its assets go to your attachment folder, and the links in the note point to them. Nothing is overwritten.' });
		const packs = this.fileInput('Select .textpack files', false);
		const folder = Platform.isDesktopApp ? this.fileInput('Select a .textbundle folder', true) : null;
		const zone = el.createDiv({ cls: 'textbundle-files-drop', text: Platform.isDesktopApp ? 'Drop .textpack files or .textbundle folders here' : 'Select .textpack files below', attr: { tabindex: '0' } });
		zone.addEventListener('dragover', (event) => {
			event.preventDefault();
			zone.addClass('is-over');
		});
		zone.addEventListener('dragleave', () => zone.removeClass('is-over'));
		zone.addEventListener('drop', (event) => {
			event.preventDefault();
			event.stopPropagation();
			zone.removeClass('is-over');
			if (event.dataTransfer) void this.drop(event.dataTransfer.items);
		});
		const buttons = new Setting(el).addButton((b) =>
			b
				.setButtonText('Select .textpack files')
				.setCta()
				.setDisabled(this.busy)
				.onClick(() => packs.click()),
		);
		if (folder) buttons.addButton((b) => b.setButtonText('Select a .textbundle folder').setDisabled(this.busy).onClick(() => folder.click()));
		if (this.busy) el.createEl('p', { text: 'Import in progress…', attr: { role: 'status' } });
		if (!this.rows.length) return;
		const list = el.createEl('ul', { cls: 'textbundle-files-results' });
		for (const row of this.rows) {
			const li = list.createEl('li');
			if (row.result) {
				const r = row.result;
				li.createSpan({ text: `${row.source}: ${r.notePath}, ${importSummary(r)}. ` });
				for (const warning of r.warnings) li.createSpan({ cls: 'textbundle-files-warning', text: `${warning} ` });
				const open = li.createEl('a', { text: 'Open note', href: '#' });
				open.addEventListener('click', (event) => {
					event.preventDefault();
					void this.app.workspace.openLinkText(r.notePath, '', false);
					this.close();
				});
			} else li.createSpan({ cls: 'textbundle-files-error', text: `${row.source}: ${row.error ?? ''}`, attr: { role: 'alert' } });
		}
	}
}
