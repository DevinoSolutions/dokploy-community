import DOMPurify from "dompurify";

const ALLOWED_TYPES = [
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/svg+xml",
	"image/webp",
];
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "svg", "webp"];
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const DEFAULT_MAX_DIMENSION = 256;

export const sanitizeSvg = (svgContent: string): string | null => {
	const clean = DOMPurify.sanitize(svgContent, {
		USE_PROFILES: { svg: true, svgFilters: true },
		ADD_TAGS: ["use"],
	});
	if (!clean) return null;
	return `data:image/svg+xml;base64,${btoa(clean)}`;
};

export const resizeImage = (file: File, maxSize: number): Promise<string> => {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (event) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;

				if (width > maxSize || height > maxSize) {
					if (width > height) {
						height = Math.round((height * maxSize) / width);
						width = maxSize;
					} else {
						width = Math.round((width * maxSize) / height);
						height = maxSize;
					}
				}

				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					resolve(event.target?.result as string);
					return;
				}

				ctx.drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL("image/webp", 0.8));
			};
			img.onerror = reject;
			img.src = event.target?.result as string;
		};
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
};

export type ImageUploadResult =
	| { ok: true; dataUrl: string }
	| { ok: false; error: string };

/**
 * Validate a user-selected image file and convert it to a self-contained
 * data-URL: SVGs are sanitized and base64'd, raster images are resized to
 * maxSize and re-encoded as WebP. Returns an error message instead of
 * throwing so callers can surface it (e.g. via a toast).
 */
export const processImageUpload = async (
	file: File,
	maxSize: number = DEFAULT_MAX_DIMENSION,
): Promise<ImageUploadResult> => {
	const fileExtension = file.name.split(".").pop()?.toLowerCase();

	if (
		!ALLOWED_TYPES.includes(file.type) &&
		!ALLOWED_EXTENSIONS.includes(fileExtension || "")
	) {
		return {
			ok: false,
			error: "Only JPG, JPEG, PNG, WEBP, and SVG files are allowed",
		};
	}

	if (file.size > MAX_FILE_SIZE) {
		return { ok: false, error: "Image size must be less than 2MB" };
	}

	const isSvg = file.type === "image/svg+xml" || fileExtension === "svg";

	if (isSvg) {
		const text = await file.text();
		const sanitizedDataUrl = sanitizeSvg(text);
		if (!sanitizedDataUrl) {
			return { ok: false, error: "Invalid SVG file" };
		}
		return { ok: true, dataUrl: sanitizedDataUrl };
	}

	// Resize raster images and convert to WebP to save space
	try {
		const resizedDataUrl = await resizeImage(file, maxSize);
		return { ok: true, dataUrl: resizedDataUrl };
	} catch {
		return { ok: false, error: "Error processing image" };
	}
};
