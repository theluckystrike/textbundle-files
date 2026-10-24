// Vault side of import and export. Only vault and file manager APIs, so it also works on mobile.
import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { MAX_UNPACKED_BYTES, PackError, buildPack, checkLimits, bundleFromFiles, exportInfo, exportLinks, INFO_KEY, assetName, hasInfoProperty, readPack, rewriteImportLinks, takeInfoProperty, uniquePath, type Bundle } from './bundle';

export interface ImportResult {
	source: string;
	notePath: string;
	assets: number;
	rewritten: number;
	missing: number;
	warnings: string[];
}

export interface ExportResult {
	notePath: string;
	packPath: string;
	assets: number;
}

const join = (folder: string, name: string) => normalizePath(folder && folder !== '/' ? `${folder}/${name}` : name);
/** The buffer of the bytes. A copy only when the bytes are a view on a larger buffer (no double memory for unpacked files). */
const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer;

/** Taken check for new paths: the vault, without case, plus the paths this run wrote. */
function takenCheck(app: App): { taken: (path: string) => boolean; add: (path: string) => void } {
	const lower = new Set(app.vault.getAllLoadedFiles().map((file) => file.path.toLowerCase()));
	return {
		taken: (path) => lower.has(path.toLowerCase()) || app.vault.getAbstractFileByPath(path) !== null,
		add: (path) => lower.add(path.toLowerCase()),
	};
}

async function ensureFolder(app: App, path: string): Promise<void> {
	if (!path || path === '/' || app.vault.getFolderByPath(path)) return;
	await app.vault.createFolder(path);
}

/**
 * Writes the note and its assets. Never overwrites: a name clash gets a suffix.
 * reserve gets each path before the write, so auto import skips the files of an import (a pack inside a pack).
 * On a failure the files of this import go to the trash, so no half import stays.
 */
export async function writeBundle(app: App, bundle: Bundle, source: string, folder: string, keepInfo: boolean, reserve?: (path: string) => void): Promise<ImportResult> {
	const check = takenCheck(app);
	await ensureFolder(app, folder);
	const notePath = uniquePath(join(folder, `${bundle.name}.md`), check.taken);
	check.add(notePath);
	const written: TFile[] = [];
	const warnings = [...bundle.warnings];
	try {
		// The note exists before its assets, so the attachment folder setting can use its folder.
		const note = await app.vault.create(notePath, bundle.text);
		written.push(note);
		const vaultPaths: Record<string, string> = {};
		for (const asset of bundle.assets) {
			const offered = normalizePath(await app.fileManager.getAvailablePathForAttachment(assetName(asset.path), notePath));
			const path = uniquePath(offered, check.taken);
			const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
			await ensureFolder(app, parent);
			check.add(path);
			reserve?.(path);
			written.push(await app.vault.createBinary(path, bufferOf(asset.bytes)));
			vaultPaths[asset.path] = path;
		}
		let text = bundle.text;
		let rewritten = 0;
		let missing = 0;
		if (bundle.markdown) ({ text, rewritten, missing } = rewriteImportLinks(text, vaultPaths));
		if (text !== bundle.text) await app.vault.modify(note, text);
		if (keepInfo) {
			if (hasInfoProperty(text)) warnings.push(`The text has a ${INFO_KEY} property already. Kept it and did not add info.json.`);
			else {
				const info = bundle.info.raw ?? { version: bundle.info.version, type: bundle.info.type };
				try {
					await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
						fm[INFO_KEY] = info;
					});
				} catch {
					// Front matter that is not valid YAML: keep the import, without the property.
					warnings.push(`The front matter is not valid YAML. Imported the note without the ${INFO_KEY} property.`);
				}
			}
		}
		return { source, notePath, assets: bundle.assets.length, rewritten, missing, warnings };
	} catch (error) {
		for (const file of written.reverse()) {
			try {
				await app.fileManager.trashFile(file);
			} catch {
				// The file stays. The message below names the import.
			}
		}
		throw new PackError('write-failed', `${source} was not imported, and its new files went to the trash. ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Reads a .textbundle folder of the vault into a bundle. */
export async function readVaultBundle(app: App, folder: TFolder): Promise<Bundle> {
	const files: Record<string, Uint8Array> = {};
	let total = 0;
	const walk = async (dir: TFolder, prefix: string): Promise<void> => {
		for (const child of dir.children) {
			if (child instanceof TFolder) await walk(child, `${prefix}${child.name}/`);
			else if (child instanceof TFile) {
				total += child.stat.size;
				if (total > MAX_UNPACKED_BYTES) throw new PackError('limit', `${folder.name} is larger than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB.`);
				files[`${prefix}${child.name}`] = new Uint8Array(await app.vault.readBinary(child));
			}
		}
	};
	await walk(folder, '');
	return bundleFromFiles(folder.name, files);
}

/** Reads a .textpack file of the vault. */
export async function readVaultPack(app: App, file: TFile): Promise<Bundle> {
	// Check the size before the file is read into memory.
	const limit = checkLimits(file.stat.size, 0, 0);
	if (limit) throw new PackError('limit', limit);
	return readPack(file.name, new Uint8Array(await app.vault.readBinary(file)));
}

/** Exports one note as Name.textpack in the folder (default: next to the note). */
export async function exportNote(app: App, file: TFile, keepInfo: boolean, folder?: string, reserve?: (path: string) => void): Promise<ExportResult> {
	let text = await app.vault.read(file);
	let stored: Record<string, unknown> | null = null;
	if (keepInfo) ({ text, info: stored } = takeInfoProperty(text));
	const resolve = (target: string): string | null => {
		const dest = app.metadataCache.getFirstLinkpathDest(target, file.path);
		return dest && dest.extension !== 'md' ? dest.path : null;
	};
	const links = exportLinks(text, resolve);
	const assets: Array<{ name: string; bytes: Uint8Array }> = [];
	let total = 0;
	for (const asset of links.assets) {
		const target = app.vault.getFileByPath(asset.vaultPath);
		if (!target) continue;
		total += target.stat.size;
		if (total > MAX_UNPACKED_BYTES) throw new PackError('limit', `The attachments of ${file.basename} are larger than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB.`);
		assets.push({ name: asset.name, bytes: new Uint8Array(await app.vault.readBinary(target)) });
	}
	const pack = buildPack(file.basename, links.text, exportInfo(stored, links.text), assets);
	const check = takenCheck(app);
	const out = folder ?? file.parent?.path ?? '';
	await ensureFolder(app, out);
	const packPath = uniquePath(join(out, `${file.basename}.textpack`), check.taken);
	reserve?.(packPath);
	await app.vault.createBinary(packPath, bufferOf(pack));
	return { notePath: file.path, packPath, assets: assets.length };
}

/** Packs and bundles directly inside a folder. */
export function packsIn(folder: TFolder): Array<TFile | TFolder> {
	const out: Array<TFile | TFolder> = [];
	for (const child of folder.children) {
		if ((child instanceof TFile && /^(textpack|zip)$/i.test(child.extension)) || (child instanceof TFolder && /\.textbundle$/i.test(child.name))) out.push(child);
	}
	return out;
}

/** All Markdown notes in a folder and its subfolders. */
export function notesIn(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	const walk = (dir: TFolder) => {
		for (const child of dir.children) {
			if (child instanceof TFolder) walk(child);
			else if (child instanceof TFile && child.extension === 'md') out.push(child);
		}
	};
	walk(folder);
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** "1 attachment", "2 attachments". */
export function count(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** One line about an import: attachments, changed links, links to missing assets. */
export function importSummary(r: ImportResult): string {
	return `${count(r.assets, 'attachment')}, ${count(r.rewritten, 'link')} changed${r.missing ? `, ${count(r.missing, 'link')} to missing assets` : ''}`;
}

export function reportText(lines: string[]): string {
	// The file name is the title, so the note has no heading.
	return `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}
