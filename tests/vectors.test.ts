import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import vectors from './vectors/textbundle-files.json';
import { assetName, bundleFromFiles, inflateEntry, checkEntryPath, checkLimits, exportInfo, exportLinks, exportedByPlugin, groupBundleFiles, hasInfoProperty, noteName, parseInfo, readPack, rewriteImportLinks, takeInfoProperty, uniqueAmong, type Bundle } from '../src/bundle';
import { lyingZip, overlapZip, zip64LocatorZip } from './zipcraft';

type Files = Record<string, string>;
const bytes = (files: Files) => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)]));
const summary = (b: Bundle) => ({ name: b.name, textName: b.textName, text: b.text, type: b.info.type, markdown: b.markdown, assets: b.assets.map((a) => a.path), warnings: b.warnings });
const guard = (fn: () => unknown) => {
	try {
		return fn();
	} catch (error) {
		return { error: (error as Error).message };
	}
};

const fns: Record<string, (...args: never[]) => unknown> = {
	bundle: (name: string, files: Files) => guard(() => summary(bundleFromFiles(name, bytes(files)))),
	pack: (name: string, files: Files) => guard(() => summary(readPack(name, zipSync(bytes(files))))),
	notZip: (name: string, text: string) => guard(() => readPack(name, strToU8(text))),
	checkEntryPath: (path: string) => guard(() => checkEntryPath(path)),
	parseInfo,
	noteName,
	uniqueAmong,
	checkLimits,
	rewriteImportLinks,
	exportLinks: (text: string, map: Record<string, string>) => exportLinks(text, (target) => map[target] ?? null),
	exportInfo,
	roundTrip: (text: string, map: Record<string, string>) => {
		const imported = rewriteImportLinks(text, map).text;
		const reverse = new Map(Object.values(map).map((path) => [path, path]));
		return exportLinks(imported, (target) => reverse.get(target) ?? null).text;
	},
	takeInfoProperty,
	hasInfoProperty,
	assetName,
	exportedByPlugin: (json: string, text: string) => exportedByPlugin(parseInfo(json).info, text),
	inflateEntry: (name: string, compressed: number, size: number) => guard(() => inflateEntry({ name, compressed, size }, new Uint8Array(compressed))),
	zip64Pack: (length: number, n: number) => guard(() => readPack('z.textpack', zip64LocatorZip(length, n))),
	bombPack: (length: number, n: number, honest: boolean) => guard(() => readPack('bomb.textpack', overlapZip(length, n, honest))),
	lyingPack: (declared?: number) => guard(() => readPack('lie.textpack', lyingZip(declared))),
	groupBundleFiles,
};

describe('golden vectors (packages/spec/vectors/textbundle-files.json)', () => {
	it('covers the acceptance cases of the spec', () => {
		for (const n of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A13']) expect(vectors.cases.some((c) => c.name.startsWith(`${n} `))).toBe(true);
		expect(vectors.cases.length).toBeGreaterThanOrEqual(40);
	});
	for (const c of vectors.cases) {
		it(c.name, () => {
			const fn = fns[c.fn];
			expect(fn).toBeTypeOf('function');
			expect(fn!(...(c.args as never[]))).toEqual(c.expected);
		});
	}
});
