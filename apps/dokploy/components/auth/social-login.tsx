"use client";

// Clean-room social login buttons for the community fork (Apache-2.0).
// The Better Auth backend already registers GitHub/Google `socialProviders`
// unconditionally, so these buttons simply expose that existing capability on
// self-hosted instances. They are only rendered when the corresponding OAuth
// credentials are actually configured (see the pages' getServerSideProps), so
// an instance without OAuth set up sees no change.

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export type SocialProvider = "github" | "google";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
	github: "GitHub",
	google: "Google",
};

function GithubIcon() {
	return (
		<svg viewBox="0 0 24 24" className="mr-2 size-4" aria-hidden="true">
			<path
				fill="currentColor"
				d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.75.81 1.2 1.84 1.2 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"
			/>
		</svg>
	);
}

function GoogleIcon() {
	return (
		<svg viewBox="0 0 48 48" className="mr-2 size-4" aria-hidden="true">
			<path
				fill="#EA4335"
				d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
			/>
			<path
				fill="#4285F4"
				d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"
			/>
			<path
				fill="#FBBC05"
				d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24 24 0 0 0 0 21.56l7.98-6.19Z"
			/>
			<path
				fill="#34A853"
				d="M24 48c6.48 0 11.93-2.13 15.9-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.17 2.3-6.26 0-11.57-4.22-13.46-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"
			/>
		</svg>
	);
}

export function SocialLoginButton({
	provider,
	callbackURL = "/dashboard/home",
}: {
	provider: SocialProvider;
	callbackURL?: string;
}) {
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = async () => {
		setIsLoading(true);
		try {
			const { error } = await authClient.signIn.social({
				provider,
				callbackURL,
			});
			if (error) {
				toast.error(
					error.message ??
						`Could not sign in with ${PROVIDER_LABEL[provider]}`,
				);
			}
		} catch (err) {
			toast.error(`Could not sign in with ${PROVIDER_LABEL[provider]}`, {
				description: err instanceof Error ? err.message : "Unknown error",
			});
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Button
			variant="outline"
			type="button"
			className="w-full mb-4"
			onClick={handleClick}
			isLoading={isLoading}
		>
			{provider === "github" ? <GithubIcon /> : <GoogleIcon />}
			Continue with {PROVIDER_LABEL[provider]}
		</Button>
	);
}

export interface EnabledSocialProviders {
	github?: boolean;
	google?: boolean;
}

export function SocialLoginButtons({
	providers,
	callbackURL,
}: {
	providers: EnabledSocialProviders;
	callbackURL?: string;
}) {
	if (!providers.github && !providers.google) {
		return null;
	}
	return (
		<div className="flex flex-col">
			{providers.github && (
				<SocialLoginButton provider="github" callbackURL={callbackURL} />
			)}
			{providers.google && (
				<SocialLoginButton provider="google" callbackURL={callbackURL} />
			)}
		</div>
	);
}
