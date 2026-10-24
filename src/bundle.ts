// Pure TextBundle and TextPack logic (http://textbundle.org/spec/). Only parseYaml from the Obsidian API, so the golden vectors run in Node.
import { parseYaml } from 'obsidian';
import { Inflate, strToU8, zipSync } from 'fflate';

export const MARKDOWN_TYPE = 'net.daringfireball.markdown';
/** Limits that keep a pack in memory on a phone. The pack is refused before unpack when it is larger. */
export const MAX_PACK_BYTES = 100 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 250 * 1024 * 1024;
export const MAX_ENTRIES = 5000;
/** The info.json key of this plugin (an app-specific dictionary, as the spec allows). It marks packs that the plugin exported. */
export const OWN_KEY = 'md.obsidian.textbundle-files';
/** The property that holds info.json in a note (Pro round trip). */
export const INFO_KEY = 'textbundle';

export interface BundleInfo {
	version: number;
	type: string;
	/** The parsed info.json, or null when it is missing or bad. */
	raw: Record<string, unknown> | null;
}

export interface Bundle {
	/** Note name without extension. */
	name: string;
	/** File name of the text file in the bundle, for example text.markdown. */
	textName: string;
	text: string;
	info: BundleInfo;
	markdown: boolean;
	/** Asset path below assets/ (for example "sub/a b.png") and its bytes, in path order. */
	assets: Array<{ path: string; bytes: Uint8Array }>;
	warnings: string[];
}

export class PackError extends Error {}

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;

/** Gives the limit message, or null when the pack is inside the limits. */
export function checkLimits(packBytes: number, entries: number, unpackedBytes: number): string | null {
	if (packBytes > MAX_PACK_BYTES) return `The pack is ${mb(packBytes)}. The limit is ${mb(MAX_PACK_BYTES)}.`;
	if (entries > MAX_ENTRIES) return `The pack has ${entries} entries. The limit is ${MAX_ENTRIES} entries.`;
	if (unpackedBytes > MAX_UNPACKED_BYTES) return `The pack is ${mb(unpackedBytes)} when unpacked. The limit is ${mb(MAX_UNPACKED_BYTES)}.`;
	return null;
}

/**
 * Cleans an entry path and refuses a path that can leave the bundle (zip slip):
 * a ".." segment, a leading slash, a drive letter or a NUL character.
 */
export function checkEntryPath(path: string): string {
	const slashed = path.replace(/\\/g, '/');
	if (slashed.includes('\0') || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed) || slashed.split('/').includes('..')) {
		throw new PackError(`Refused the pack: the path "${path}" points outside the bundle.`);
	}
	return slashed.split('/').filter((part) => part !== '' && part !== '.').join('/');
}

/** Reads info.json. A missing or bad file gives version 2 and the Markdown type. */
export function parseInfo(json: string | null): { info: BundleInfo; warning: string | null } {
	if (json === null) return { info: { version: 2, type: MARKDOWN_TYPE, raw: null }, warning: 'No info.json. Used the Markdown type.' };
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return { info: { version: 2, type: MARKDOWN_TYPE, raw: null }, warning: 'info.json is not valid JSON. Used the Markdown type.' };
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { info: { version: 2, type: MARKDOWN_TYPE, raw: null }, warning: 'info.json is not an object. Used the Markdown type.' };
	const obj = raw as Record<string, unknown>;
	const version = typeof obj.version === 'number' && Number.isInteger(obj.version) ? obj.version : 2;
	const type = typeof obj.type === 'string' && obj.type.trim() ? obj.type.trim() : MARKDOWN_TYPE;
	return { info: { version, type, raw: obj }, warning: null };
}

/** True when this plugin exported the pack (auto import skips it on every device). */
/** The mark of an export: a CRC-32 of the text bytes, as 8 hex digits. */
export function textMark(text: string): string {
	return crc32(strToU8(text)).toString(16).padStart(8, '0');
}

/**
 * True when this plugin exported the pack and its text did not change since (auto import skips it on every device).
 * A pack that another app saved again with a changed text imports again.
 */
export function exportedByPlugin(info: BundleInfo, text: string): boolean {
	const own = info.raw?.[OWN_KEY];
	return !!own && typeof own === 'object' && (own as Record<string, unknown>).text === textMark(text);
}

/** True for the Markdown UTIs that editors write (Markdown, MultiMarkdown, CommonMark). */
export function isMarkdownType(type: string, textName: string): boolean {
	if (/markdown|commonmark/i.test(type)) return true;
	return type === '' && /\.(md|markdown)$/i.test(textName);
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * A file name that every platform accepts: no characters that Windows, Android or a vault link refuses,
 * no leading or trailing dots and spaces, and no Windows device name (CON, NUL, COM1).
 */
export function safeFileName(name: string, fallback: string): string {
	const visible = Array.from(name, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('');
	let clean = visible.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
	// Windows reads the device name before the FIRST dot: "nul.tar.gz" is NUL.
	const dot = clean.indexOf('.');
	const base = dot >= 0 ? clean.slice(0, dot) : clean;
	if (RESERVED.test(base.trim())) clean = `${base.trim()}_${dot >= 0 ? clean.slice(dot) : ''}`;
	return clean || fallback;
}

/** Note name from a pack or bundle file name: no extension, no characters that a vault file name refuses. */
export function noteName(fileName: string): string {
	const base = fileName.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
	return safeFileName(base.replace(/\.(textpack|textbundle|zip)$/i, ''), 'Untitled');
}

/** Asset file name in the vault: the last part of its path in assets/, made safe. */
export function assetName(path: string): string {
	return safeFileName(path.slice(path.lastIndexOf('/') + 1), 'asset');
}

/** Splits "dir/base.ext" into its parts. A leading dot is part of the base. */
function splitPath(path: string): { dir: string; base: string; ext: string } {
	const slash = path.lastIndexOf('/');
	const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	return dot > 0 ? { dir, base: file.slice(0, dot), ext: file.slice(dot) } : { dir, base: file, ext: '' };
}

/** Never overwrite: adds " 1", " 2" to the base name until the path is free. The compare ignores case. */
export function uniquePath(desired: string, taken: (path: string) => boolean): string {
	if (!taken(desired)) return desired;
	const { dir, base, ext } = splitPath(desired);
	for (let i = 1; ; i++) {
		const next = `${dir}${base} ${i}${ext}`;
		if (!taken(next)) return next;
	}
}

/** uniquePath for a list of taken paths (golden vectors). */
export function uniqueAmong(desired: string, taken: string[]): string {
	const set = new Set(taken.map((path) => path.toLowerCase()));
	return uniquePath(desired, (path) => set.has(path.toLowerCase()));
}

const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$)/;

/**
 * Makes a bundle from its files (paths relative to the pack or the picked folder).
 * Accepts one top folder (Name.textbundle/). Refuses the whole bundle for an unsafe path.
 */
export function bundleFromFiles(fileName: string, input: Record<string, Uint8Array>): Bundle {
	const files = new Map<string, Uint8Array>();
	const seen = new Set<string>();
	for (const [path, bytes] of Object.entries(input)) {
		const clean = checkEntryPath(path);
		if (!clean || path.endsWith('/') || IGNORED.test(clean)) continue;
		// "assets/a.png", "./assets/a.png" and "assets/A.png" are one file on most disks: refuse, do not pick one.
		if (seen.has(clean.toLowerCase())) throw new PackError(`Refused the pack: two entries have the path "${clean}".`);
		seen.add(clean.toLowerCase());
		files.set(clean, bytes);
	}
	const isText = (rel: string) => /^text\.[^/]+$/i.test(rel);
	let prefix = '';
	if (![...files.keys()].some(isText)) {
		const tops = new Set([...files.keys()].filter((path) => path.includes('/')).map((path) => path.slice(0, path.indexOf('/') + 1)));
		const candidates = [...tops].filter((top) => [...files.keys()].some((path) => path.startsWith(top) && isText(path.slice(top.length))));
		if (candidates.length !== 1) throw new PackError('No text file (text.markdown or text.md) in the bundle.');
		prefix = candidates[0]!;
	}
	const inner = new Map<string, Uint8Array>();
	for (const [path, bytes] of files) if (path.startsWith(prefix)) inner.set(path.slice(prefix.length), bytes);
	const texts = [...inner.keys()].filter(isText).sort();
	const rank = (name: string) => (name.toLowerCase() === 'text.markdown' ? 0 : name.toLowerCase() === 'text.md' ? 1 : 2);
	const textName = texts.sort((a, b) => rank(a) - rank(b))[0]!;
	const warnings: string[] = [];
	const infoKey = [...inner.keys()].find((path) => path.toLowerCase() === 'info.json');
	// Keep a byte order mark in the text, so an export gives the same bytes. info.json drops it.
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	const { info, warning } = parseInfo(infoKey ? decoder.decode(inner.get(infoKey)).replace(/^\uFEFF/, '') : null);
	if (warning) warnings.push(warning);
	const markdown = isMarkdownType(info.type, textName);
	if (!markdown) warnings.push(`The text type is ${info.type}. Imported the text without link changes.`);
	const assets: Bundle['assets'] = [];
	let other = 0;
	for (const [path, bytes] of inner) {
		if (/^assets\//i.test(path)) assets.push({ path: path.slice('assets/'.length), bytes });
		else if (path !== infoKey && !isText(path)) other++;
	}
	if (texts.length > 1) warnings.push(`The bundle has ${texts.length} text files. Imported ${textName}.`);
	if (other) warnings.push(`Skipped ${other} files outside assets/.`);
	assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { name: noteName(fileName), textName, text: decoder.decode(inner.get(textName)), info, markdown, assets, warnings };
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	name: string;
	method: number;
	crc: number;
	compressed: number;
	size: number;
	/** Where the packed data starts, from the local header that this entry points at. */
	data: number;
}

/**
 * Reads the central directory before any unpack and refuses a zip bomb:
 * more than MAX_ENTRIES entries, ZIP64, a stored entry whose two sizes differ,
 * entries whose data overlap (many entries that point at one file), two entries with one name,
 * and more than MAX_UNPACKED_BYTES, counted as the larger of the compressed and the declared size.
 */
export function scanZip(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (at: number) => view.getUint16(at, true);
	const u32 = (at: number) => view.getUint32(at, true);
	const bad = () => new PackError('not a zip');
	let end = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
		if (u32(at) === 0x06054b50) {
			end = at;
			break;
		}
	}
	if (end < 0) throw bad();
	const count = u16(end + 10);
	const cdSize = u32(end + 12);
	const cdOffset = u32(end + 16);
	const zip64 = new PackError('Refused the pack: ZIP64 packs are not supported.');
	if (count === 0xffff || cdOffset === 0xffffffff) throw zip64;
	// A ZIP64 locator before the end record, or a ZIP64 end record after the directory, would make other readers use a second directory.
	if (end >= 20 && u32(end - 20) === 0x07064b50) throw zip64;
	for (let at = cdOffset + cdSize; at + 4 <= end; at++) if (u32(at) === 0x06064b50 || u32(at) === 0x07064b50) throw zip64;
	if (cdOffset + cdSize > end) throw bad();
	const limit = checkLimits(bytes.length, count, 0);
	if (limit) throw new PackError(limit);
	const entries: Array<ZipEntry & { start: number; stop: number }> = [];
	const names = new Set<string>();
	let unpacked = 0;
	let at = cdOffset;
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.length || u32(at) !== 0x02014b50) throw bad();
		const flags = u16(at + 8);
		const nameLength = u16(at + 28);
		const raw = bytes.subarray(at + 46, at + 46 + nameLength);
		const name = flags & 2048 ? new TextDecoder().decode(raw) : Array.from(raw, (b) => String.fromCharCode(b)).join('');
		if (flags & 1) throw new PackError(`Refused the pack: the entry "${name}" is encrypted.`);
		const entry = { name, method: u16(at + 10), crc: u32(at + 16), compressed: u32(at + 20), size: u32(at + 24), data: 0, start: 0, stop: 0 };
		const offset = u32(at + 42);
		at += 46 + nameLength + u16(at + 30) + u16(at + 32);
		if (entry.compressed === 0xffffffff || entry.size === 0xffffffff || offset === 0xffffffff) throw new PackError('Refused the pack: ZIP64 packs are not supported.');
		if (offset + 30 > bytes.length || u32(offset) !== 0x04034b50) throw bad();
		if (entry.method !== 0 && entry.method !== 8) throw new PackError(`Refused the pack: the entry "${name}" uses compression method ${entry.method}.`);
		entry.start = offset;
		entry.data = offset + 30 + u16(offset + 26) + u16(offset + 28);
		entry.stop = entry.data + entry.compressed;
		if (entry.stop > cdOffset) throw new PackError(`Refused the pack: the entry "${name}" is larger than the pack.`);
		if (entry.method === 0 && entry.compressed !== entry.size) throw new PackError(`Refused the pack: the stored entry "${name}" declares two different sizes.`);
		if (names.has(name)) throw new PackError(`Refused the pack: two entries have the name "${name}".`);
		names.add(name);
		unpacked += Math.max(entry.compressed, entry.size);
		const over = checkLimits(bytes.length, count, unpacked);
		if (over) throw new PackError(over);
		entries.push(entry);
	}
	const sorted = [...entries].sort((a, b) => a.start - b.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i]!.start < sorted[i - 1]!.stop) throw new PackError(`Refused the pack: the entries "${sorted[i - 1]!.name}" and "${sorted[i]!.name}" share data.`);
	}
	return entries.map(({ name, method, crc, compressed, size, data }) => ({ name, method, crc, compressed, size, data }));
}

/** Deflate cannot expand data more than 1,032 times. */
export const MAX_RATIO = 1032;
const CHUNK = 16 * 1024;

/**
 * Inflates one entry in 16 KB steps and stops as soon as the output passes the declared size,
 * so a stream of many gigabytes of zeros costs at most one step (CPU bomb).
 * Before that, the declared size must fit the packed size: not more than MAX_RATIO times larger,
 * and not much smaller than stored deflate blocks allow.
 */
export function inflateEntry(entry: Pick<ZipEntry, 'name' | 'compressed' | 'size'>, packed: Uint8Array): Uint8Array {
	if (entry.size > entry.compressed * MAX_RATIO + 1024) throw new PackError(`Refused the pack: "${entry.name}" declares ${entry.size} bytes for ${entry.compressed} packed bytes.`);
	if (entry.compressed > entry.size + Math.ceil(entry.size / 16383) * 5 + 64) throw new PackError(`Refused the pack: "${entry.name}" has more packed data than its declared size allows.`);
	const out = new Uint8Array(entry.size);
	let at = 0;
	let over = false;
	try {
		const inflater = new Inflate((chunk) => {
			if (over) return;
			if (at + chunk.length > entry.size) {
				over = true;
				return;
			}
			out.set(chunk, at);
			at += chunk.length;
		});
		if (packed.length === 0) inflater.push(packed, true);
		for (let i = 0; i < packed.length && !over; i += CHUNK) inflater.push(packed.subarray(i, i + CHUNK), i + CHUNK >= packed.length);
	} catch {
		throw new PackError(`Refused the pack: "${entry.name}" does not unpack.`);
	}
	if (over) throw new PackError(`Refused the pack: "${entry.name}" unpacks to more than its declared size.`);
	return at === entry.size ? out : out.subarray(0, at);
}

/**
 * Unpacks a .textpack (zip). The central directory scan refuses a zip bomb before any unpack.
 * Only the scanned entries are unpacked, each from its own checked data range, so no second directory is read.
 * After the unpack, each file must have its declared size and checksum.
 */
export function readPack(fileName: string, bytes: Uint8Array): Bundle {
	const early = checkLimits(bytes.length, 0, 0);
	if (early) throw new PackError(early);
	let entries: ZipEntry[];
	try {
		entries = scanZip(bytes);
	} catch (error) {
		if (error instanceof PackError && error.message !== 'not a zip') throw error;
		throw new PackError(`${fileName} is not a TextPack (zip) file.`);
	}
	const files: Record<string, Uint8Array> = {};
	for (const entry of entries) {
		checkEntryPath(entry.name);
		if (entry.name.endsWith('/')) continue;
		const packed = bytes.subarray(entry.data, entry.data + entry.compressed);
		const out = entry.method === 0 ? packed.slice() : inflateEntry(entry, packed);
		if (out.length !== entry.size || crc32(out) !== entry.crc) throw new PackError(`Refused the pack: "${entry.name}" does not match its declared size or checksum.`);
		files[entry.name] = out;
	}
	return bundleFromFiles(fileName, files);
}

/** Percent-encodes the characters that end or break a Markdown link destination. */
export function encodeLinkPath(path: string): string {
	return path.replace(/[ %()<>[\]#^]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function decodeLink(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

type Dest = { raw: string; angle: boolean };
/** Calls fn for each link target outside code and puts its answer in place. Null keeps the target. */
function mapTargets(text: string, fn: (dest: Dest) => string | null, wiki?: (embed: boolean, target: string, alias: string | null) => string | null): string {
	const lines = text.split('\n');
	let fence: string | null = null;
	let list = false;
	let blank = true;
	let indented = false;
	return lines
		.map((line) => {
			// Fences inside a blockquote count too: look at the text after the ">" markers.
			const inner = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(inner);
			if (fence) {
				if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(inner)) fence = null;
				return line;
			}
			if (marker) {
				fence = marker[1]!;
				blank = false;
				return line;
			}
			const isBlank = /^\s*$/.test(line);
			// An indented code block: 4 spaces or a tab after a blank line, outside a list.
			if (!isBlank && /^( {4}|\t)/.test(inner) && !list && (blank || indented)) {
				indented = true;
				blank = false;
				return line;
			}
			if (!isBlank) {
				indented = false;
				if (/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(inner)) list = true;
				else if (!/^\s/.test(inner)) list = false;
			}
			blank = isBlank;
			// Inline code spans keep their text.
			return line
				.split(/(`+[^`]*?`+)/)
				.map((part, i) => {
					if (i % 2 === 1) return part;
					let out = part.replace(/(\]\(\s*)(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)/g, (all, lead: string, dest: string) => {
						const angle = dest.startsWith('<');
						const next = fn({ raw: angle ? dest.slice(1, -1) : dest, angle });
						return next === null ? all : lead + next;
					});
					out = out.replace(/^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/, (all, lead: string, dest: string) => {
						const angle = dest.startsWith('<');
						const next = fn({ raw: angle ? dest.slice(1, -1) : dest, angle });
						return next === null ? all : lead + next;
					});
					out = out.replace(/(<(?:img|a|source|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])([^"'\n]*)\2/gi, (all, lead: string, quote: string, dest: string) => {
						const next = fn({ raw: dest, angle: false });
						return next === null ? all : `${lead}${quote}${next.replace(/^<|>$/g, '')}${quote}`;
					});
					if (wiki) {
						out = out.replace(/(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (all, bang: string, target: string, _sub: string | undefined, alias: string | undefined) => {
							const next = wiki(bang === '!', target.trim(), alias ?? null);
							return next === null ? all : next;
						});
					}
					return out;
				})
				.join('');
		})
		.join('\n');
}

/** The text after the last slash of a raw link target, as written. */
const rawTail = (raw: string) => raw.slice(raw.lastIndexOf('/') + 1);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Import: points each link to assets/<path> at its vault file. Keeps the link form:
 * the file name stays as written when the vault file has the same name, so an export gives the same bytes.
 * @param vaultPaths asset path below assets/ (decoded) to vault path.
 */
export function rewriteImportLinks(text: string, vaultPaths: Record<string, string>): { text: string; rewritten: number; missing: number } {
	let rewritten = 0;
	let missing = 0;
	const out = mapTargets(text, ({ raw, angle }) => {
		const decoded = angle ? raw : decodeLink(raw);
		const match = /^(?:\.\/)?assets\/(.+)$/i.exec(decoded);
		if (!match) return null;
		const vault = vaultPaths[match[1]!];
		if (vault === undefined) {
			missing++;
			return null;
		}
		rewritten++;
		const slash = vault.lastIndexOf('/');
		const dir = slash >= 0 ? vault.slice(0, slash + 1) : '';
		const sameName = baseName(vault) === baseName(match[1]!);
		if (angle) return `<${vault}>`;
		return encodeLinkPath(dir) + (sameName ? rawTail(raw) : encodeLinkPath(baseName(vault)));
	});
	return { text: out, rewritten, missing };
}

/**
 * Export: changes each link to an attachment (a resolved non-Markdown file) to assets/<name>.
 * @param resolve link target (decoded, no subpath) to the vault path of an attachment, or null for notes, URLs and missing files.
 */
export function exportLinks(text: string, resolve: (target: string) => string | null): { text: string; assets: Array<{ vaultPath: string; name: string }> } {
	const names = new Map<string, string>();
	const taken = new Set<string>();
	const assign = (vaultPath: string): string => {
		let name = names.get(vaultPath);
		if (name === undefined) {
			name = uniquePath(baseName(vaultPath), (n) => taken.has(n.toLowerCase()));
			taken.add(name.toLowerCase());
			names.set(vaultPath, name);
		}
		return name;
	};
	const out = mapTargets(
		text,
		({ raw, angle }) => {
			if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) return null;
			const decoded = (angle ? raw : decodeLink(raw)).replace(/#.*$/, '');
			if (!decoded) return null;
			const vaultPath = resolve(decoded);
			if (vaultPath === null) return null;
			const name = assign(vaultPath);
			if (angle) return `<assets/${name}>`;
			return `assets/${name === baseName(decoded) ? rawTail(raw) : encodeLinkPath(name)}`;
		},
		(embed, target, alias) => {
			const vaultPath = resolve(target);
			if (vaultPath === null) return null;
			const name = assign(vaultPath);
			const dest = `assets/${encodeLinkPath(name)}`;
			if (embed) return `![${alias && !/^\d+(x\d+)?$/.test(alias) ? alias : ''}](${dest})`;
			return `[${alias ?? baseName(target)}](${dest})`;
		},
	);
	return { text: out, assets: [...names].map(([vaultPath, name]) => ({ vaultPath, name })) };
}

/** The front matter block of a note: its lines and where the body starts. */
function frontMatter(text: string): { lines: string[]; open: string; close: string; body: string } | null {
	const open = /^---\r?\n/.exec(text);
	if (!open) return null;
	const rest = text.slice(open[0].length);
	const close = /(^|\r?\n)(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(rest);
	if (!close) return null;
	const block = rest.slice(0, close.index);
	return { lines: block === '' ? [] : block.split('\n'), open: open[0], close: close[0].replace(/^\r?\n/, ''), body: rest.slice(close.index + close[0].length) };
}

/** The lines of the top-level info key in the front matter, in flow or block form, at any position. */
function infoLines(lines: string[]): { from: number; to: number } | null {
	const key = new RegExp(`^(["']?)${INFO_KEY}\\1\\s*:`);
	const from = lines.findIndex((line) => key.test(line));
	if (from < 0) return null;
	let to = from + 1;
	// The value goes on while lines are indented, empty, or (block sequence) start with "- ".
	while (to < lines.length && (/^[ \t]/.test(lines[to]!) || /^\s*\r?$/.test(lines[to]!) || /^- /.test(lines[to]!))) to++;
	while (to > from + 1 && /^\s*\r?$/.test(lines[to - 1]!)) to--;
	return { from, to };
}

/** True when the text has the info property already (the importer then does not add a second key). */
export function hasInfoProperty(text: string): boolean {
	const fm = frontMatter(text);
	return !!fm && infoLines(fm.lines) !== null;
}

/**
 * Pro round trip: takes the info property out of the front matter, in any YAML form and at any position.
 * The other lines keep their bytes. A block that then is empty goes away, as the importer made it.
 */
export function takeInfoProperty(text: string): { text: string; info: Record<string, unknown> | null } {
	const fm = frontMatter(text);
	if (!fm) return { text, info: null };
	const at = infoLines(fm.lines);
	if (!at) return { text, info: null };
	let info: Record<string, unknown> | null = null;
	try {
		const parsed = (parseYaml(fm.lines.slice(at.from, at.to).join('\n')) as Record<string, unknown> | null)?.[INFO_KEY];
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
		else if (typeof parsed === 'string') {
			const json: unknown = JSON.parse(parsed);
			if (json && typeof json === 'object' && !Array.isArray(json)) info = json as Record<string, unknown>;
		}
	} catch {
		info = null;
	}
	const kept = [...fm.lines.slice(0, at.from), ...fm.lines.slice(at.to)];
	if (kept.every((line) => /^\s*\r?$/.test(line))) return { text: fm.body, info };
	return { text: `${fm.open}${kept.join('\n')}\n${fm.close}${fm.body}`, info };
}

/** info.json for an export. Keeps the keys of other apps from a stored info (spec, Cooperating With Other Applications). */
export function exportInfo(stored: Record<string, unknown> | null, text: string): Record<string, unknown> {
	const base: Record<string, unknown> = { version: 2, type: MARKDOWN_TYPE, transient: false, creatorIdentifier: 'md.obsidian' };
	const own = { [OWN_KEY]: { version: 1, text: textMark(text) } };
	if (!stored) return { ...base, ...own };
	return { ...base, ...stored, ...own, version: 2, type: typeof stored.type === 'string' && stored.type ? stored.type : MARKDOWN_TYPE };
}

/** Builds a .textpack: Name.textbundle/info.json, text.markdown and assets/. */
export function buildPack(name: string, text: string, info: Record<string, unknown>, assets: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
	const root = `${name}.textbundle/`;
	const files: Record<string, Uint8Array> = {
		[`${root}info.json`]: strToU8(`${JSON.stringify(info, null, 2)}\n`),
		[`${root}text.markdown`]: strToU8(text),
	};
	for (const asset of assets) files[`${root}assets/${asset.name}`] = asset.bytes;
	return zipSync(files, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') });
}

/**
 * Groups picked or dropped files into bundles. A bundle is each folder that ends in .textbundle,
 * or the picked top folder when it holds a text.* file.
 */
export function groupBundleFiles(paths: string[]): Array<{ root: string; files: Array<{ path: string; rel: string }> }> {
	const groups = new Map<string, Array<{ path: string; rel: string }>>();
	for (const path of paths) {
		const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
		let at = parts.findIndex((part) => /\.textbundle$/i.test(part));
		if (at < 0 && parts.length >= 2 && paths.some((p) => p.replace(/\\/g, '/').split('/').filter(Boolean).join('/').toLowerCase().startsWith(`${parts[0]!.toLowerCase()}/text.`))) at = 0;
		if (at < 0 || at === parts.length - 1) continue;
		const root = parts.slice(0, at + 1).join('/');
		const list = groups.get(root) ?? [];
		list.push({ path, rel: parts.slice(at + 1).join('/') });
		groups.set(root, list);
	}
	return [...groups].map(([root, files]) => ({ root, files }));
}
