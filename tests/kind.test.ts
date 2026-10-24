// Patch 1.0.3: each PackError has a typed kind. Auto import decides on the kind, not on the message text.
// One test for each place that throws a PackError. Each test also checks the exact user-visible message.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { App } from 'obsidian-test-mocks/obsidian';
import { MAX_ENTRIES, MAX_PACK_BYTES, MAX_UNPACKED_BYTES, PackError, bundleFromFiles, checkEntryPath, crc32, inflateEntry, readPack, scanZip, type Bundle, type PackErrorKind } from '../src/bundle';
import { exportNote, readVaultBundle, readVaultPack, writeBundle } from '../src/writer';
import { incomplete } from '../src/main';
import { deflatedZip, lyingZip, overlapZip, zip64LocatorZip } from './zipcraft';

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** Gives the kind and the message of the PackError that fn throws. */
async function refusal(fn: () => unknown): Promise<{ kind: PackErrorKind; message: string }> {
	try {
		await fn();
	} catch (error) {
		expect(error).toBeInstanceOf(PackError);
		return { kind: (error as PackError).kind, message: (error as PackError).message };
	}
	throw new Error('no PackError');
}

/** A stored zip with text.md and b.md (fflate level 0). */
const stored = () => zipSync({ 'text.md': strToU8('# t\n'), 'b.md': strToU8('bb\n') }, { level: 0 });
const endAt = (zip: Uint8Array) => {
	for (let at = zip.length - 22; at >= 0; at--) if (zip[at] === 0x50 && zip[at + 1] === 0x4b && zip[at + 2] === 5 && zip[at + 3] === 6) return at;
	throw new Error('no end record');
};
/** Offset of the central directory entry with this name. */
const centralAt = (zip: Uint8Array, name: string) => {
	const raw = strToU8(name);
	for (let at = 0; at + 46 + raw.length <= zip.length; at++) {
		if (zip[at] === 0x50 && zip[at + 1] === 0x4b && zip[at + 2] === 1 && zip[at + 3] === 2 && zip[at + 28] === raw.length && raw.every((b, i) => zip[at + 46 + i] === b)) return at;
	}
	throw new Error(`no central entry ${name}`);
};
const patched = (edit: (zip: Uint8Array) => void) => {
	const zip = stored();
	edit(zip);
	return zip;
};
const localOf = (zip: Uint8Array, name: string) => new DataView(zip.buffer).getUint32(centralAt(zip, name) + 42, true);

describe('PackError kind for each throw site (1.0.3)', () => {
	it('not-zip: readPack wraps bytes with no zip end record', async () => {
		expect(await refusal(() => readPack('x.textpack', strToU8('this is not a zip file')))).toEqual({ kind: 'not-zip', message: 'x.textpack is not a TextPack (zip) file.' });
	});
	it('not-zip: scanZip bad() for no end record', async () => {
		expect(await refusal(() => scanZip(strToU8('this is not a zip file')))).toEqual({ kind: 'not-zip', message: 'not a zip' });
	});
	it('not-zip: a pack cut before its end record (a sync still writes it)', async () => {
		const zip = stored();
		expect(await refusal(() => readPack('cut.textpack', zip.subarray(0, zip.length - 10)))).toEqual({ kind: 'not-zip', message: 'cut.textpack is not a TextPack (zip) file.' });
	});
	it('not-zip: a directory that ends after the end record', async () => {
		const zip = patched((z) => z.set(u32(endAt(z)), endAt(z) + 16));
		expect(await refusal(() => readPack('d.textpack', zip))).toEqual({ kind: 'not-zip', message: 'd.textpack is not a TextPack (zip) file.' });
	});
	it('not-zip: a bad central directory header', async () => {
		const zip = patched((z) => z.set([0, 0, 0, 0], centralAt(z, 'text.md')));
		expect(await refusal(() => readPack('h.textpack', zip))).toEqual({ kind: 'not-zip', message: 'h.textpack is not a TextPack (zip) file.' });
	});
	it('not-zip: a bad local header', async () => {
		const zip = patched((z) => z.set([0, 0, 0, 0], localOf(z, 'b.md')));
		expect(await refusal(() => readPack('l.textpack', zip))).toEqual({ kind: 'not-zip', message: 'l.textpack is not a TextPack (zip) file.' });
	});
	it('limit: readPack refuses a pack over the size limit before the scan', async () => {
		const big = { length: MAX_PACK_BYTES + 1 } as Uint8Array;
		expect(await refusal(() => readPack('big.textpack', big))).toEqual({ kind: 'limit', message: 'The pack is 101 MB. The limit is 100 MB.' });
	});
	it('limit: scanZip refuses more entries than the limit', async () => {
		const zip = patched((z) => {
			z.set(u16(MAX_ENTRIES + 1), endAt(z) + 8);
			z.set(u16(MAX_ENTRIES + 1), endAt(z) + 10);
		});
		expect(await refusal(() => readPack('n.textpack', zip))).toEqual({ kind: 'limit', message: `The pack has ${MAX_ENTRIES + 1} entries. The limit is ${MAX_ENTRIES} entries.` });
	});
	it('limit: scanZip refuses more unpacked bytes than the limit', async () => {
		const zip = deflatedZip(new Uint8Array(10), MAX_UNPACKED_BYTES + 1);
		expect(await refusal(() => readPack('u.textpack', zip))).toEqual({ kind: 'limit', message: 'The pack is 251 MB when unpacked. The limit is 250 MB.' });
	});
	it('unsupported: a ZIP64 locator', async () => {
		expect(await refusal(() => readPack('z.textpack', zip64LocatorZip(10, 2)))).toEqual({ kind: 'unsupported', message: 'Refused the pack: ZIP64 packs are not supported.' });
	});
	it('unsupported: a ZIP64 entry count in the end record', async () => {
		const zip = patched((z) => z.set(u16(0xffff), endAt(z) + 10));
		expect(await refusal(() => readPack('z.textpack', zip))).toEqual({ kind: 'unsupported', message: 'Refused the pack: ZIP64 packs are not supported.' });
	});
	it('unsupported: a ZIP64 entry size', async () => {
		const zip = patched((z) => z.set(u32(0xffffffff), centralAt(z, 'b.md') + 20));
		expect(await refusal(() => readPack('z.textpack', zip))).toEqual({ kind: 'unsupported', message: 'Refused the pack: ZIP64 packs are not supported.' });
	});
	it('unsupported: an encrypted entry', async () => {
		const zip = patched((z) => z.set(u16(1), centralAt(z, 'b.md') + 8));
		expect(await refusal(() => readPack('e.textpack', zip))).toEqual({ kind: 'unsupported', message: 'Refused the pack: the entry "b.md" is encrypted.' });
	});
	it('unsupported: an unknown compression method', async () => {
		const zip = patched((z) => z.set(u16(12), centralAt(z, 'b.md') + 10));
		expect(await refusal(() => readPack('m.textpack', zip))).toEqual({ kind: 'unsupported', message: 'Refused the pack: the entry "b.md" uses compression method 12.' });
	});
	it('bomb: an entry larger than the pack', async () => {
		const zip = patched((z) => {
			const at = centralAt(z, 'b.md');
			z.set(u32(1000), at + 20);
			z.set(u32(1000), at + 24);
		});
		expect(await refusal(() => readPack('b.textpack', zip))).toEqual({ kind: 'bomb', message: 'Refused the pack: the entry "b.md" is larger than the pack.' });
	});
	it('bomb: a stored entry with two different sizes', async () => {
		const zip = patched((z) => z.set(u32(2), centralAt(z, 'b.md') + 24));
		expect(await refusal(() => readPack('s.textpack', zip))).toEqual({ kind: 'bomb', message: 'Refused the pack: the stored entry "b.md" declares two different sizes.' });
	});
	it('bomb: entries that share data', async () => {
		expect(await refusal(() => readPack('bomb.textpack', overlapZip(10, 2, true)))).toEqual({ kind: 'bomb', message: 'Refused the pack: the entries "assets/a0.png" and "assets/a1.png" share data.' });
	});
	it('bomb: a declared size that does not fit the packed size', async () => {
		expect(await refusal(() => inflateEntry({ name: 'a.png', compressed: 1, size: 10_000_000 }, new Uint8Array(1)))).toEqual({ kind: 'bomb', message: 'Refused the pack: "a.png" declares 10000000 bytes for 1 packed bytes.' });
	});
	it('bomb: more packed data than the declared size allows', async () => {
		expect(await refusal(() => inflateEntry({ name: 'a.png', compressed: 1000, size: 1 }, new Uint8Array(1000)))).toEqual({ kind: 'bomb', message: 'Refused the pack: "a.png" has more packed data than its declared size allows.' });
	});
	it('bomb: output larger than the declared size', async () => {
		expect(await refusal(() => readPack('lie.textpack', lyingZip(97)))).toEqual({ kind: 'bomb', message: 'Refused the pack: "assets/a.png" unpacks to more than its declared size.' });
	});
	it('corrupt: an entry that does not unpack', async () => {
		expect(await refusal(() => readPack('c.textpack', deflatedZip(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 4)))).toEqual({ kind: 'corrupt', message: 'Refused the pack: "assets/a.png" does not unpack.' });
	});
	it('corrupt: a checksum mismatch', async () => {
		const zip = patched((z) => z.set(u32(crc32(strToU8('other'))), centralAt(z, 'b.md') + 16));
		expect(await refusal(() => readPack('k.textpack', zip))).toEqual({ kind: 'corrupt', message: 'Refused the pack: "b.md" does not match its declared size or checksum.' });
	});
	it('duplicate: two central entries with one name', async () => {
		// Rename "b.md" to "a.md" in the central directory: two names of one length.
		const two = zipSync({ 'text.md': strToU8('# t\n'), 'a.md': strToU8('a\n'), 'b.md': strToU8('b\n') }, { level: 0 });
		two.set(strToU8('a.md'), centralAt(two, 'b.md') + 46);
		expect(await refusal(() => readPack('dup.textpack', two))).toEqual({ kind: 'duplicate', message: 'Refused the pack: two entries have the name "a.md".' });
	});
	it('duplicate: two paths that are one file on most disks', async () => {
		const files = { 'text.md': strToU8('# t\n'), 'assets/a.png': strToU8('1'), 'assets/A.png': strToU8('2') };
		expect(await refusal(() => bundleFromFiles('d.textbundle', files))).toEqual({ kind: 'duplicate', message: 'Refused the pack: two entries have the path "assets/A.png".' });
	});
	it('unsafe-path: an entry path outside the bundle', async () => {
		expect(await refusal(() => checkEntryPath('../evil.md'))).toEqual({ kind: 'unsafe-path', message: 'Refused the pack: the path "../evil.md" points outside the bundle.' });
		expect(await refusal(() => readPack('p.textpack', zipSync({ 'text.md': strToU8('# t\n'), '../evil.md': strToU8('x') })))).toEqual({ kind: 'unsafe-path', message: 'Refused the pack: the path "../evil.md" points outside the bundle.' });
	});
	it('no-text: a bundle with no text file', async () => {
		expect(await refusal(() => bundleFromFiles('n.textbundle', { 'info.json': strToU8('{}') }))).toEqual({ kind: 'no-text', message: 'No text file (text.markdown or text.md) in the bundle.' });
	});
	it('limit: readVaultPack refuses a vault pack over the size limit before the read', async () => {
		const app = App.createConfigured__({ files: {} });
		const file = { name: 'big.textpack', stat: { size: MAX_PACK_BYTES + 1 } };
		expect(await refusal(() => readVaultPack(app as never, file as never))).toEqual({ kind: 'limit', message: 'The pack is 101 MB. The limit is 100 MB.' });
	});
	it('limit: readVaultBundle refuses a vault folder over the unpacked limit', async () => {
		const app = App.createConfigured__({ files: { 'Big.textbundle/text.md': '# t\n', 'Big.textbundle/assets/a.png': 'x' } });
		app.vault.getFileByPath('Big.textbundle/assets/a.png')!.stat.size = MAX_UNPACKED_BYTES + 1;
		const folder = app.vault.getFolderByPath('Big.textbundle')!;
		expect(await refusal(() => readVaultBundle(app as never, folder as never))).toEqual({ kind: 'limit', message: 'Big.textbundle is larger than 250 MB.' });
	});
	it('limit: exportNote refuses attachments over the unpacked limit', async () => {
		const app = App.createConfigured__({ files: { 'Note.md': '# t\n![[a.png]]\n', 'a.png': 'x' } });
		const image = app.vault.getFileByPath('a.png')!;
		image.stat.size = MAX_UNPACKED_BYTES + 1;
		app.metadataCache.getFirstLinkpathDest = () => image;
		const note = app.vault.getFileByPath('Note.md')!;
		expect(await refusal(() => exportNote(app as never, note as never, false))).toEqual({ kind: 'limit', message: 'The attachments of Note are larger than 250 MB.' });
	});
	it('write-failed: an import that fails during the write', async () => {
		const app = App.createConfigured__({ files: {} });
		app.vault.create = async () => {
			throw new Error('disk full');
		};
		const bundle = bundleFromFiles('w.textbundle', { 'text.md': strToU8('# t\n') }) as Bundle;
		expect(await refusal(() => writeBundle(app as never, bundle, 'w.textpack', '', false))).toEqual({ kind: 'write-failed', message: 'w.textpack was not imported, and its new files went to the trash. disk full' });
	});
});

describe('incomplete() decides on the kind (1.0.3)', () => {
	const kinds: PackErrorKind[] = ['not-zip', 'limit', 'unsafe-path', 'duplicate', 'unsupported', 'bomb', 'corrupt', 'no-text', 'write-failed'];
	it('is true only for the kind not-zip', () => {
		for (const kind of kinds) expect(incomplete(new PackError(kind, 'x is not a TextPack (zip) file.'))).toBe(kind === 'not-zip');
	});
	it('does not read the message text', () => {
		expect(incomplete(new PackError('not-zip', 'A new text for a pack with no end record.'))).toBe(true);
		expect(incomplete(new PackError('corrupt', 'x.textpack is not a TextPack (zip) file.'))).toBe(false);
		expect(incomplete(new Error('x.textpack is not a TextPack (zip) file.'))).toBe(false);
	});
});
