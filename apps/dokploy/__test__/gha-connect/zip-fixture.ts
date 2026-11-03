import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFile {
	name: string;
	data: string | Buffer;
	/** 0 = stored, 8 = deflated (default). */
	method?: 0 | 8;
	/** Overrides for building damaged archives. */
	crc?: number;
	declaredSize?: number;
	flags?: number;
}

/** Builds a real zip in memory (what actions/upload-artifact produces, in miniature). */
export const buildZip = (files: ZipFile[]): Buffer => {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const data = Buffer.isBuffer(file.data)
			? file.data
			: Buffer.from(file.data);
		const method = file.method ?? 8;
		const body = method === 8 ? deflateRawSync(data) : data;
		const name = Buffer.from(file.name);
		const crc = file.crc ?? crc32(data);
		const size = file.declaredSize ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(file.flags ?? 0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(file.flags ?? 0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(size, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + body.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
};
