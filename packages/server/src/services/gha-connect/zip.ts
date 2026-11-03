import { crc32, inflateRawSync } from "node:zlib";

/**
 * Reads ONE named entry out of a small zip (a GitHub Actions artifact holding
 * the release manifest). No dependency: the artifact is untrusted bytes, so
 * the reader is deliberately narrow.
 *
 * Refused: encrypted entries, zip64, entries larger than `maxBytes` (checked
 * against the declared size AND while inflating), a CRC that does not match,
 * a directory that points outside the buffer. Only an exact name match is read.
 */

export type ZipRead =
	| { ok: true; bytes: Buffer }
	| { ok: false; reason: string };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const fail = (reason: string): ZipRead => ({ ok: false, reason });

export const readZipEntry = (
	zip: Uint8Array,
	name: string,
	maxBytes: number,
): ZipRead => {
	const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
	if (buf.length < 22) return fail("The archive is too small to be a zip");

	let eocd = -1;
	const lowest = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= lowest; i -= 1) {
		if (buf.readUInt32LE(i) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return fail("The archive has no end-of-directory record");

	const entries = buf.readUInt16LE(eocd + 10);
	const directorySize = buf.readUInt32LE(eocd + 12);
	let pos = buf.readUInt32LE(eocd + 16);
	if (
		entries === 0xffff ||
		directorySize === 0xffffffff ||
		pos === 0xffffffff
	) {
		return fail("zip64 archives are not accepted");
	}
	if (pos + directorySize > eocd) return fail("The directory is out of range");

	for (let n = 0; n < entries; n += 1) {
		if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL) {
			return fail("The directory is damaged");
		}
		const flags = buf.readUInt16LE(pos + 8);
		const method = buf.readUInt16LE(pos + 10);
		const crc = buf.readUInt32LE(pos + 16);
		const compressed = buf.readUInt32LE(pos + 20);
		const size = buf.readUInt32LE(pos + 24);
		const nameLength = buf.readUInt16LE(pos + 28);
		const extraLength = buf.readUInt16LE(pos + 30);
		const commentLength = buf.readUInt16LE(pos + 32);
		const localOffset = buf.readUInt32LE(pos + 42);
		const entryName = buf.toString("utf8", pos + 46, pos + 46 + nameLength);
		pos += 46 + nameLength + extraLength + commentLength;
		if (entryName !== name) continue;

		if (flags & 0x1) return fail("Encrypted entries are not accepted");
		if (compressed === 0xffffffff || size === 0xffffffff) {
			return fail("zip64 entries are not accepted");
		}
		if (size > maxBytes) return fail("The entry is larger than allowed");
		if (
			localOffset + 30 > buf.length ||
			buf.readUInt32LE(localOffset) !== LOCAL
		) {
			return fail("The entry header is damaged");
		}
		const dataStart =
			localOffset +
			30 +
			buf.readUInt16LE(localOffset + 26) +
			buf.readUInt16LE(localOffset + 28);
		if (dataStart + compressed > buf.length) {
			return fail("The entry data is out of range");
		}
		const raw = buf.subarray(dataStart, dataStart + compressed);
		let bytes: Buffer;
		if (method === 0) {
			bytes = Buffer.from(raw);
		} else if (method === 8) {
			try {
				bytes = inflateRawSync(raw, { maxOutputLength: maxBytes });
			} catch {
				return fail("The entry could not be inflated within the size limit");
			}
		} else {
			return fail("The entry uses an unsupported compression method");
		}
		if (bytes.length !== size) return fail("The entry size does not match");
		if (crc32(bytes) !== crc) return fail("The entry checksum does not match");
		return { ok: true, bytes };
	}
	return fail(`The archive has no entry named ${name}`);
};
