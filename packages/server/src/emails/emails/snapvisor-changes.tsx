import {
	Body,
	Button,
	Container,
	Head,
	Heading,
	Html,
	Img,
	Link,
	Preview,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import { emailTailwindConfig } from "../tailwind-config";

export type TemplateProps = {
	projectName: string;
	serviceName: string;
	environmentName: string;
	branch: string;
	commit: string;
	snapshotSummary: string | null;
	reviewUrl: string;
	date: string;
};

export const SnapvisorChangesEmail = ({
	projectName = "dokploy",
	serviceName = "frontend",
	environmentName = "production",
	branch = "main",
	commit = "a1b2c3d",
	snapshotSummary = "3 changed",
	reviewUrl = "https://app.snapvisor.io/acme/web/builds/42",
	date = "2023-05-01T00:00:00.000Z",
}: TemplateProps) => {
	const previewText = `Visual changes to review for ${serviceName}`;
	return (
		<Html>
			<Head />
			<Preview>{previewText}</Preview>
			<Tailwind config={emailTailwindConfig}>
				<Body className="bg-white my-auto mx-auto font-sans px-2">
					<Container className="border border-solid border-[#eaeaea] rounded-lg my-[40px] mx-auto p-[20px] max-w-[465px]">
						<Section className="mt-[32px]">
							<Img
								src={
									"https://raw.githubusercontent.com/Dokploy/dokploy/refs/heads/canary/apps/dokploy/logo.png"
								}
								width="100"
								height="50"
								alt="Dokploy"
								className="my-0 mx-auto"
							/>
						</Section>
						<Heading className="text-black text-[24px] font-normal text-center p-0 my-[30px] mx-0">
							Visual changes to review for <strong>{serviceName}</strong>
						</Heading>
						<Text className="text-black text-[14px] leading-[24px]">
							Hello,
						</Text>
						<Text className="text-black text-[14px] leading-[24px]">
							Snapvisor found visual changes in the build for the commit
							deployed to <strong>{serviceName}</strong>. They need to be
							approved or rejected.
						</Text>
						<Section className="flex text-black text-[14px]  leading-[24px] bg-[#F4F4F5] rounded-lg p-2">
							<Text className="!leading-3 font-bold">Details: </Text>
							<Text className="!leading-3">
								Project Name: <strong>{projectName}</strong>
							</Text>
							<Text className="!leading-3">
								Service: <strong>{serviceName}</strong>
							</Text>
							<Text className="!leading-3">
								Environment: <strong>{environmentName}</strong>
							</Text>
							<Text className="!leading-3">
								Branch: <strong>{branch}</strong>
							</Text>
							<Text className="!leading-3">
								Commit: <strong>{commit}</strong>
							</Text>
							{snapshotSummary && (
								<Text className="!leading-3">
									Snapshots: <strong>{snapshotSummary}</strong>
								</Text>
							)}
							<Text className="!leading-3">
								Date: <strong>{date}</strong>
							</Text>
						</Section>
						<Section className="text-center mt-[32px] mb-[32px]">
							<Button
								href={reviewUrl}
								className="bg-[#000000] rounded text-white text-[12px] font-semibold no-underline text-center px-5 py-3"
							>
								Review in Snapvisor
							</Button>
						</Section>
						<Text className="text-black text-[14px] leading-[24px]">
							or copy and paste this URL into your browser:{" "}
							<Link href={reviewUrl} className="text-blue-600 no-underline">
								{reviewUrl}
							</Link>
						</Text>
					</Container>
				</Body>
			</Tailwind>
		</Html>
	);
};

export default SnapvisorChangesEmail;
