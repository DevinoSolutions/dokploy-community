// A stand-in for the handle `fs/promises.open` returns for a `.env` (T-7160).
export const dotenvHandle = (
	text: string,
	{ kind = "file", size }: { kind?: "file" | "fifo"; size?: number } = {},
) => ({
	stat: async () => ({
		isFile: () => kind === "file",
		size: size ?? Buffer.byteLength(text),
	}),
	read: async (buffer: Buffer, offset: number, length: number) => {
		const data = Buffer.from(text);
		const bytesRead = Math.min(length, data.length);
		data.copy(buffer, offset, 0, bytesRead);
		return { bytesRead, buffer };
	},
	close: async () => undefined,
});
