// Hand-made zip files for the zip bomb vectors (review round 1, probes P1 and P2).
import { strToU8, zipSync } from 'fflate';
import { crc32 } from '../src/bundle';

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/**
 * One stored text file and one stored payload, plus n central directory entries that all point at the payload.
 * honest: the entries declare the real size. Not honest: they declare 0 bytes.
 */
export function overlapZip(payloadLength: number, n: number, honest: boolean): Uint8Array {
	const text = strToU8('# t\n');
	const payload = new Uint8Array(payloadLength).fill(65);
	const local = (name: string, data: Uint8Array) => [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(crc32(data)), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...strToU8(name)];
	const l1 = local('text.md', text);
	const l2 = local('assets/a.png', payload);
	const central = (name: string, offset: number, compressed: number, size: number, crc: number) => [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(crc), ...u32(compressed), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...strToU8(name)];
	const cd: number[] = [...central('text.md', 0, text.length, text.length, crc32(text))];
	const dataStart = l1.length + text.length;
	for (let i = 0; i < n; i++) cd.push(...central(`assets/a${i}.png`, dataStart, payload.length, honest ? payload.length : 0, crc32(payload)));
	const cdOffset = dataStart + l2.length + payload.length;
	const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(n + 1), ...u16(n + 1), ...u32(cd.length), ...u32(cdOffset), ...u16(0)];
	const out = new Uint8Array(cdOffset + cd.length + eocd.length);
	out.set([...l1, ...text], 0);
	out.set(l2, dataStart);
	out.set(payload, dataStart + l2.length);
	out.set(cd, cdOffset);
	out.set(eocd, cdOffset + cd.length);
	return out;
}

/** A deflate entry whose central directory declares `declared` bytes for 100,000 bytes of data. */
export function lyingZip(declared = 10): Uint8Array {
	const zip = zipSync({ 'text.md': strToU8('# t\n![](assets/a.png)\n'), 'assets/a.png': new Uint8Array(100000).fill(7) }, { level: 6 });
	const name = strToU8('assets/a.png');
	for (let at = zip.length - name.length; at >= 46; at--) {
		if (zip[at - 46] === 0x50 && zip[at - 45] === 0x4b && zip[at - 44] === 0x01 && zip[at - 43] === 0x02 && name.every((b, i) => zip[at + i] === b)) {
			zip.set(u32(declared), at - 46 + 24);
			return zip;
		}
	}
	throw new Error('no central entry');
}

const u64 = (n: number) => [...u32(n % 0x100000000), ...u32(Math.floor(n / 0x100000000))];

/**
 * Review round 2, probe P11: a classic end record points at a harmless directory (one text file),
 * and a ZIP64 locator before it points at a second directory with n overlapping stored entries.
 */
export function zip64LocatorZip(payloadLength: number, n: number): Uint8Array {
	const text = strToU8('# t\n');
	const payload = new Uint8Array(payloadLength).fill(65);
	const local = (name: string, data: Uint8Array) => [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(crc32(data)), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...strToU8(name)];
	const central = (name: string, offset: number, length: number, crc: number) => [...u32(0x02014b50), ...u16(45), ...u16(20), ...u16(0), ...u16(0), ...u32(0), ...u32(crc), ...u32(length), ...u32(length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...strToU8(name)];
	const l1 = [...local('text.md', text), ...text];
	const l2Offset = l1.length;
	const head = [...l1, ...local('assets/a.png', payload)];
	const dataEnd = head.length + payload.length;
	const cdA = central('text.md', 0, text.length, crc32(text));
	const cdB: number[] = [...central('text.md', 0, text.length, crc32(text))];
	for (let i = 0; i < n; i++) cdB.push(...central(`assets/a${i}.png`, l2Offset, payload.length, crc32(payload)));
	const cdAOffset = dataEnd;
	const cdBOffset = cdAOffset + cdA.length;
	const z64Offset = cdBOffset + cdB.length;
	const tail = [
		...u32(0x06064b50), ...u64(44), ...u16(45), ...u16(45), ...u32(0), ...u32(0), ...u64(n + 1), ...u64(n + 1), ...u64(cdB.length), ...u64(cdBOffset),
		...u32(0x07064b50), ...u32(0), ...u64(z64Offset), ...u32(1),
		...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(cdA.length), ...u32(cdAOffset), ...u16(0),
	];
	const out = new Uint8Array(z64Offset + tail.length);
	out.set(head, 0);
	out.set(payload, head.length);
	out.set(cdA, cdAOffset);
	out.set(cdB, cdBOffset);
	out.set(tail, z64Offset);
	return out;
}

/** A pack with text.md and one deflate entry assets/a.png with the given packed data and declared size (review round 3, probe R3-10). */
export function deflatedZip(packed: Uint8Array, declared: number): Uint8Array {
	const text = strToU8('# t\n![](assets/a.png)\n');
	const local = (name: string, method: number, data: Uint8Array, size: number, crc: number) => [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(crc), ...u32(data.length), ...u32(size), ...u16(name.length), ...u16(0), ...strToU8(name)];
	const central = (name: string, method: number, offset: number, compressed: number, size: number, crc: number) => [...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(crc), ...u32(compressed), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...strToU8(name)];
	const h1 = local('text.md', 0, text, text.length, crc32(text));
	const h2Offset = h1.length + text.length;
	const h2 = local('assets/a.png', 8, packed, declared, 0);
	const cdOffset = h2Offset + h2.length + packed.length;
	const cd = [...central('text.md', 0, 0, text.length, text.length, crc32(text)), ...central('assets/a.png', 8, h2Offset, packed.length, declared, 0)];
	const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(2), ...u16(2), ...u32(cd.length), ...u32(cdOffset), ...u16(0)];
	const out = new Uint8Array(cdOffset + cd.length + eocd.length);
	out.set([...h1, ...text], 0);
	out.set(h2, h2Offset);
	out.set(packed, h2Offset + h2.length);
	out.set(cd, cdOffset);
	out.set(eocd, cdOffset + cd.length);
	return out;
}
