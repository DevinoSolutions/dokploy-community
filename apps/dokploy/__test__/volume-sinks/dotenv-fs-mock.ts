// A stand-in for the handle `fs/promises.open` returns for a `.env` (T-7160).
// `chunk` caps how much one read returns, as a real read may return less.
export const dotenvHandle = (
	text: string,
	{
		kind = "file",
		size,
		chunk = Number.POSITIVE_INFINITY,
	}: { kind?: "file" | "fifo"; size?: number; chunk?: number } = {},
) => ({
	stat: async () => ({
		isFile: () => kind === "file",
		size: size ?? Buffer.byteLength(text),
	}),
	read: async (
		buffer: Buffer,
		offset: number,
		length: number,
		position = 0,
	) => {
		const data = Buffer.from(text);
		const bytesRead = Math.max(
			0,
			Math.min(length, chunk, data.length - position),
		);
		data.copy(buffer, offset, position, position + bytesRead);
		return { bytesRead, buffer };
	},
	close: async () => undefined,
});
