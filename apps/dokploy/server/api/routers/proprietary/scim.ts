import { randomUUID } from "node:crypto";
import { auth } from "@dokploy/server/lib/auth";
import {
	canManageScimConnections,
	SCIM_ALL_SCOPES,
} from "@dokploy/server/services/proprietary/scim";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, enterpriseProcedure } from "@/server/api/trpc";

/** Managed SCIM connection ids are opaque and namespaced by the plugin. */
const connectionIdSchema = z
	.string()
	.min(1)
	.max(255)
	.regex(/^ba_scim_connection_[A-Za-z0-9_-]+$/, "Invalid SCIM connection id");

const DEFAULT_TOKEN_DAYS = 365;
const tokenDaysSchema = z.number().int().min(1).max(3650);

const expiryFromDays = (days: number) =>
	new Date(Date.now() + days * 86_400_000);

/**
 * Every SCIM call is scoped to the caller's active organization, which is the
 * plugin's provisioning domain: a connection id from another organization is
 * indistinguishable from an unknown one.
 */
const assertCanManage = async (userId: string, organizationId: string) => {
	if (!(await canManageScimConnections(userId, organizationId))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Only organization owners and admins with enterprise features enabled can manage SCIM connections",
		});
	}
};

const toPublicConnection = (connection: {
	connectionId: string;
	status: string;
	createdAt: Date;
}) => ({
	connectionId: connection.connectionId,
	status: connection.status,
	createdAt: connection.createdAt,
});

export const scimRouter = createTRPCRouter({
	listProviders: enterpriseProcedure.query(async ({ ctx }) => {
		const organizationId = ctx.session.activeOrganizationId;
		const { connections } = await auth.listSCIMManagedConnections({
			body: { provisioningDomainId: organizationId },
		});
		return connections
			.filter((connection) => connection.status !== "decommissioned")
			.map(toPublicConnection);
	}),
	/** Creates a connection and returns its bearer token once. */
	generateToken: enterpriseProcedure
		.input(
			z
				.object({ expiresInDays: tokenDaysSchema.optional() })
				.optional()
				.default({}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await assertCanManage(ctx.user.id, organizationId);
			const result = await auth.createSCIMManagedConnection({
				body: {
					creationRequestId: randomUUID(),
					provisioningDomainId: organizationId,
					actorId: ctx.user.id,
					scopes: [...SCIM_ALL_SCOPES],
					expiresAt: expiryFromDays(input.expiresInDays ?? DEFAULT_TOKEN_DAYS),
				},
			});
			return {
				scimToken: result.token,
				connectionId: result.connection.connectionId,
				expiresAt: result.credential.expiresAt,
			};
		}),
	/** Issues an overlapping replacement token for an existing connection. */
	rotateToken: enterpriseProcedure
		.input(
			z.object({
				connectionId: connectionIdSchema,
				expiresInDays: tokenDaysSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await assertCanManage(ctx.user.id, organizationId);
			const result = await auth.rotateSCIMManagedCredential({
				body: {
					connectionId: input.connectionId,
					provisioningDomainId: organizationId,
					actorId: ctx.user.id,
					scopes: [...SCIM_ALL_SCOPES],
					expiresAt: expiryFromDays(input.expiresInDays ?? DEFAULT_TOKEN_DAYS),
				},
			});
			return {
				scimToken: result.token,
				connectionId: result.connection.connectionId,
				expiresAt: result.credential.expiresAt,
			};
		}),
	/**
	 * Decommissions a connection: its tokens stop working at once and its
	 * users lose their SCIM-managed state. Irreversible.
	 */
	deleteProvider: enterpriseProcedure
		.input(z.object({ connectionId: connectionIdSchema }))
		.mutation(async ({ ctx, input }) => {
			const organizationId = ctx.session.activeOrganizationId;
			await assertCanManage(ctx.user.id, organizationId);
			try {
				const result = await auth.decommissionSCIMManagedConnection({
					body: {
						connectionId: input.connectionId,
						provisioningDomainId: organizationId,
						actorId: ctx.user.id,
					},
				});
				return {
					success: true,
					status: result.decommission.status,
				};
			} catch (error) {
				const status = (error as { statusCode?: number }).statusCode;
				if (status === 404) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message:
							"SCIM connection not found or you do not have permission to delete it",
					});
				}
				throw error;
			}
		}),
});
